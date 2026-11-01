// 自动起名（讨论 #60）：新会话第一轮答完，网关在后台单独问一次模型，给第 1 章（也就是会话）起题名，
// 不用等第二条消息时对话里的模型去建档 —— 只聊一两句的人以前永远只看到第一句话当标题。
// 素材：用户的提问 + 第一轮回答的头尾；提示词、题名规范、校验与补档（backfill.mjs）同一套。
// 型号：设置里的「自动起名」（titleModel）：空 = 跟这个对话同一家同一型号；"off" = 不自动起，回到第二轮由对话里的模型建档；
//      指定的型号是全局那家清单里的，只对用全局那家的会话生效（不在这家现在的清单里也不用），钉在别家的会话仍用它自己的型号。
// 记 by:"auto"：AI 建档、用户改名都能盖过它；问回来时已经有人起了名就不写。失败了这次网关运行内不再试，第二轮的建档提醒照旧兜底。
import { LAST_LANG, log } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER } from "./providers.mjs";
import { cachedModels, isLoginMode } from "./models.mjs";
import { ensureBridge } from "./claude.mjs";
import { NAMES, findSessionFile } from "./sessions.mjs";
import { lineageRecord } from "./lineage.mjs";
import { archiveDb } from "./archive-store.mjs";
import { fileChapter } from "./archive.mjs";
import { validateTitle } from "./archive-core.mjs";
import { _promptsFrom, ask, parseTitles, userPrompt } from "./backfill.mjs";
import fs from "node:fs";
import { isInjected } from "./integrity.mjs";

const REPLY_HEAD = 700, REPLY_TAIL = 500, SCAN = 4 << 20, LINE_CAP = 1 << 20, CHUNK = 256 << 10;
const TRIED = new Set();   // 每个会话只试一次（网关重启后清空无妨：有题名的会被下面的判断挡住）
const titled = (sid) => !!(NAMES[sid] || archiveDb().sessions[sid]?.title);
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "");

/** 文件开头 SCAN 字节逐行回调（异步按块读、块间让出事件循环；超过 LINE_CAP 的行不拼出来，直接跳过——
 *  第一轮里几 MB 的工具输出很常见，起名用不着它）。fn 返回 false 停 */
async function scanLines(file, fn) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = 0, rest = [], restLen = 0, skip = false;
    while (pos < SCAN) {
      const { bytesRead: n } = await fh.read(buf, 0, CHUNK, pos);
      if (!n) break;
      pos += n;
      let s = 0;
      for (let k = buf.indexOf(10, 0); k >= 0 && k < n; k = buf.indexOf(10, k + 1)) {
        if (!skip) {
          const line = Buffer.concat([...rest, buf.subarray(s, k)]).toString("utf8");
          if (fn(line) === false) return;
        }
        rest = []; restLen = 0; skip = false; s = k + 1;
      }
      if (!skip && s < n) { rest.push(Buffer.from(buf.subarray(s, n))); restLen += n - s; if (restLen > LINE_CAP) { rest = []; restLen = 0; skip = true; } }
      await new Promise((r) => setImmediate(r));
    }
  } finally { await fh.close(); }
}

/** 第一轮回答的正文（只要文字，工具调用不要）：从第一条用户提问起，到下一条用户提问为止 */
async function firstReply(file) {
  const parts = [];
  let seenQ = false;
  await scanLines(file, (s) => {
    let e; try { e = JSON.parse(s); } catch { return; }
    if (e.isSidechain || e.isMeta || e.isCompactSummary) return;
    if (e.type === "user") {
      const c = e.message && e.message.content;
      if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) return;
      const t = textOf(c).trim();
      if (!t || isInjected(t) || t.startsWith("Caveat:")) return;
      if (seenQ) return false;
      seenQ = true;
      return;
    }
    if (seenQ && e.type === "assistant") { const t = textOf(e.message && e.message.content).trim(); if (t) parts.push(t); }
  });
  const s = parts.join("\n").replace(/\n{3,}/g, "\n\n");
  return s.length <= REPLY_HEAD + REPLY_TAIL ? s : s.slice(0, REPLY_HEAD) + "\n…\n" + s.slice(-REPLY_TAIL);
}

/** 一轮正常答完时调（run.mjs）。P / model：这一轮用的那家和型号。不等结果 */
export function autoTitle(sid, P, model) {
  if (!sid || !P || P.local || TRIED.has(sid) || SETTINGS.titleModel === "off" || titled(sid) || archiveDb().sessions[sid]?.misc) return;
  TRIED.add(sid);
  run(sid, P, model).catch((e) => log("自动起名出错：" + e.message));
}

async function run(sid, P, model) {
  const rec = await lineageRecord(sid);
  if (!rec || rec.compacts.length || rec.turns > 2) return;   // 只管刚开头的会话；压缩过的由对话里的模型按章建档
  const found = findSessionFile(sid);
  if (!found) return;
  const q = await _promptsFrom(found.file, 0);
  if (!q) return;
  const reply = await firstReply(found.file).catch(() => "");
  // 指定的型号得在这家现在的清单里：换了全局接口后，旧值别带给新那家（撞名就会用一个没给它选过的型号计费 —— v0515 复核低-3）
  const tm = SETTINGS.titleModel;
  const m = tm && P.id === PROVIDER.id && cachedModels(P).some((x) => x.id === tm) ? tm : model || "";
  if (P.id === PROVIDER.id && !isLoginMode() && !(await ensureBridge())) return;
  const item = { n: 1, open: true, src: q, reply, prev: null };
  let fix = null;
  for (let round = 0; round < 2; round++) {
    const r = await ask(userPrompt("", [item], fix), { provider: P, model: m });
    if (r.error) { log("自动起名调用失败：" + r.error); return; }
    if (titled(sid)) return;   // 问的时候 AI 建了档或用户改了名
    const got = parseTitles(r.text)[1];
    const v = validateTitle(got, LAST_LANG);
    if (v.ok) {
      const w = await fileChapter(sid, { title: v.title, chapter: 1, by: "auto" });
      log(`自动起名${w.ok ? "" : "没存上"}「${v.title}」（${m || "默认型号"}，${r.tin}/${r.tout} token）`);
      return;
    }
    fix = { 1: { title: got || "", errors: v.errors } };
  }
}
export { firstReply as _firstReply };   // 测试用

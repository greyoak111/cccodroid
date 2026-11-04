import fs from "node:fs";
import path from "node:path";
import { LAST_LANG, tr, tz } from "./config.mjs";
import { promptTokens } from "./stream.mjs";
import { isInjected } from "./integrity.mjs";

// ── 读会话记录：分页翻 transcript、子代理 ─────────────────────────────
/** 工具参数里的长字符串截短 —— 历史里一个 Write 工具能带几百 KB 的文件内容，
 *  原样回传只会把界面拖死；摘要（command / file_path …）用不到那么长。 */
function clipInput(v, depth = 0) {
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + `…（共 ${v.length} 字）` : v;
  if (!v || typeof v !== "object" || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipInput(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = clipInput(v[k], depth + 1);
  return o;
}

/** 会话的子代理记录：<会话>/subagents/agent-*.meta.json 里的 toolUseId → 对应 agent-*.jsonl */
export function agentFilesOf(sessionFile) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents"), m = new Map();
  let names; try { names = fs.readdirSync(dir); } catch { return m; }
  for (const n of names) {
    if (!n.endsWith(".meta.json")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      const f = path.join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
      if (j.toolUseId && fs.existsSync(f)) m.set(String(j.toolUseId), f);
    } catch {}
  }
  return m;
}

/** transcript 的一行 → 0..n 条可渲染的消息 */
export function transcriptItems(ev) {
  const out = [];
  if (!ev || ev.isSidechain || ev.isMeta) return out;
  // 钩子往上下文里塞的话（SessionStart / UserPromptSubmit…）：界面折叠显示原文（实时那边见 stream.mjs 的 hookContext）
  if (ev.type === "attachment" && ev.attachment?.type === "hook_additional_context") {
    const c = ev.attachment.content, text = (Array.isArray(c) ? c.join("\n") : String(c ?? "")).slice(0, 20000);
    if (text.trim()) out.push({ role: "hookctx", event: String(ev.attachment.hookEvent || ev.attachment.hookName || "").slice(0, 60), text });
    return out;
  }
  if (ev.type === "user") {
    // 压缩处：带上 uuid，界面画成章节分隔（第几章、题名由路由按脉络索引补上），脉络页跳转也靠它落地
    if (ev.isCompactSummary) { out.push({ role: "note", text: tr(LAST_LANG, tz("（此前的对话已被压缩成摘要）")), compact: true, uuid: ev.uuid || null }); return out; }
    const c = ev.message?.content;
    if (typeof c === "string") {
      if (c && !isInjected(c)) out.push({ role: "user", text: c, uuid: ev.uuid || null });
    } else if (Array.isArray(c)) {
      const texts = c.filter((x) => x.type === "text" && x.text && !isInjected(x.text)).map((x) => x.text);
      // 「图片随消息发」时原话里已有 @图片路径，不再补一行 [图片]
      if (c.some((x) => x.type === "image") && !texts.some((x) => /@\/\S+\.(png|jpe?g|gif|webp)\b/i.test(x))) texts.push("[图片]");
      if (texts.length) out.push({ role: "user", text: texts.join("\n"), uuid: ev.uuid || null });
      for (const r of c) {
        if (r.type !== "tool_result") continue;
        let t = "";
        if (typeof r.content === "string") t = r.content;
        else if (Array.isArray(r.content)) t = r.content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
        out.push({ role: "tool_result", id: r.tool_use_id, ok: !r.is_error, text: String(t).slice(0, 4000) });
      }
    }
  } else if (ev.type === "assistant") {
    for (const c of ev.message?.content || []) {
      if (c.type === "text" && c.text) out.push({ role: "assistant", text: c.text, uuid: ev.uuid || null });   // uuid：书签落点
      else if (c.type === "thinking" && c.thinking) out.push({ role: "thinking", text: c.thinking.slice(0, 60000) });
      else if (c.type === "tool_use") out.push({ role: "tool_use", id: c.id, name: c.name, input: clipInput(c.input) });
    }
  }
  return out;
}

/** 倒着读时这一行能不能定下「当前上下文用量」：压缩边界（取压缩后的数，没有就是未知，不越过边界拿旧的）
 *  或带用量的主会话回复。定得下返回 { n }（n 可能是 null），定不下返回 null */
function contextOf(ev) {
  if (ev.isSidechain || ev.isMeta) return null;
  if (ev.type === "system" && ev.subtype === "compact_boundary") {
    const m = ev.compactMetadata || ev.compact_metadata || {};
    const post = m.postTokens ?? m.post_tokens;
    return { n: Number.isFinite(post) && post >= 0 ? post : null };
  }
  if (ev.type === "assistant" && !ev.isApiErrorMessage && ev.message?.model !== "<synthetic>") {
    const n = promptTokens(ev.message?.usage);
    if (Number.isFinite(n) && n > 0) return { n };
  }
  return null;
}

/** 会话最新的上下文用量：从尾部倒着找第一行定得下的（正向读一页时页里没有，书签 / 上次读到打开要用，#89）。
 *  最多扫 MAX_SCAN，找不到返回 null */
export async function latestContextTokens(file) {
  const CH = 256 * 1024, MAX_SCAN = 12 * 1024 * 1024;
  const fh = await fs.promises.open(file, "r");
  try {
    let pos = (await fh.stat()).size, tail = Buffer.alloc(0), scanned = 0;
    while (pos > 0 && scanned < MAX_SCAN) {
      const start = Math.max(0, pos - CH);
      const chunk = Buffer.alloc(pos - start);
      await fh.read(chunk, 0, chunk.length, start);
      const data = tail.length ? Buffer.concat([chunk, tail]) : chunk;
      pos = start; scanned += chunk.length;
      let end = data.length;
      for (;;) {
        const nl = end - 2 >= 0 ? data.lastIndexOf(10, end - 2) : -1;
        if (nl < 0 && start > 0) { tail = data.subarray(0, end); break; }
        const line = data.toString("utf8", nl < 0 ? 0 : nl + 1, end).trim();
        end = nl < 0 ? 0 : nl + 1;
        if (line) {
          let ev = null; try { ev = JSON.parse(line); } catch {}
          const c = ev && contextOf(ev);
          if (c) return c.n;
        }
        if (nl < 0) break;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** 从 transcript **尾部倒着**读一页消息。
 *
 *  老办法是 readFileSync 整个文件再全量解析 —— 十几 MB 的会话会把网关的事件循环
 *  同步卡住好几秒，期间所有请求（包括正在推流的 SSE）一起排队，这就是"一恢复会话就卡半天"。
 *  现在：异步、按 256KB 块往回读，凑够 limit 条且停在一轮对话的开头（用户消息）就收手。
 *  cursor = 这一页最早那行的字节偏移，下次带 before=cursor 接着往前翻；0 表示到头了。
 *
 *  excludeFrom：正在生成的那一轮由事件总线实时推，这里按时间戳把它剔掉，免得画两遍。
 *  pick(ev)：一行转成哪些条目，默认 transcriptItems（子代理记录全是侧链，要自己转，#71） */
export async function readSessionPage(file, { before = null, limit = 40, excludeFrom = 0, pick = transcriptItems } = {}) {
  const CH = 256 * 1024, MAX_SCAN = 12 * 1024 * 1024;
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let cursor = before == null ? size : Math.max(0, Math.min(Number(before) || 0, size));
    let pos = cursor, tail = Buffer.alloc(0), scanned = 0;
    const items = [];
    let contextTokens = null, contextDone = false;

    while (pos > 0) {
      const start = Math.max(0, pos - CH);
      const chunk = Buffer.alloc(pos - start);
      await fh.read(chunk, 0, chunk.length, start);
      const data = tail.length ? Buffer.concat([chunk, tail]) : chunk;   // 覆盖 [start, cursor)
      pos = start;
      scanned += chunk.length;
      let lineEnd = data.length;

      for (;;) {
        const from = lineEnd - 2;
        const nl = from >= 0 ? data.lastIndexOf(10, from) : -1;
        if (nl < 0 && start > 0) { tail = data.subarray(0, lineEnd); break; }   // 行头还在更前面
        const lineStart = nl < 0 ? 0 : nl + 1;
        const line = data.toString("utf8", lineStart, lineEnd).trim();
        lineEnd = lineStart;
        cursor = start + lineStart;

        let turnStart = false;
        if (line) {
          let ev = null; try { ev = JSON.parse(line); } catch {}
          // exclude 只防止正文重复渲染，用量仍要从最新的主会话消息取。
          if (ev && !contextDone) {
            const c = contextOf(ev);
            if (c) { contextDone = true; contextTokens = c.n; }
          }
          if (ev && !(excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom)) {
            const its = pick(ev);
            if (its.length) {
              items.unshift(...its);
              turnStart = its[0].role === "user";
            }
          }
        }
        if (cursor === 0) break;
        if ((items.length >= limit && turnStart) || items.length >= limit * 4) {
          return { items, cursor, size, contextTokens };
        }
        if (nl < 0) break;
      }
      if (scanned >= MAX_SCAN && items.length) break;   // 极端大行：先交这一页，别无限往前扫
    }
    return { items, cursor: pos === 0 && !tail.length ? 0 : cursor, size, contextTokens };
  } finally {
    await fh.close();
  }
}

/** 从字节位置 after **往后**读一页（脉络跳到某一章用）。
 *  after 不在行首时先跳到下一行开头；凑够 limit 条后停在下一轮对话开头（用户消息）之前 —— 和往前翻一样，
 *  页的边界都落在一轮的开头。一轮里工具调用太多时到 limit*4 就在行边界收页，这时一次调用和它的结果可能分在两页（结果由前端待贴表补上）。
 *  返回 { items, from, next, size }：from 是这一页第一行的偏移（往前翻用 before=from），next 是下一页的起点；next === size 表示到底了。
 *  excludeFrom：时间戳不早于它的行不给（界面里正实时显示的那几轮）。 */
export async function readSessionForward(file, { after = 0, limit = 40, excludeFrom = 0 } = {}) {
  const CH = 256 * 1024, MAX_SCAN = 12 * 1024 * 1024;
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = Math.max(0, Math.min(Number(after) || 0, size));
    // 对齐到行首：前一个字节不是换行就往后找下一行
    if (pos > 0) {
      const b = Buffer.alloc(1); await fh.read(b, 0, 1, pos - 1);
      if (b[0] !== 10) {
        for (let p = pos; p < size;) {
          const chunk = Buffer.alloc(Math.min(CH, size - p)); await fh.read(chunk, 0, chunk.length, p);
          const i = chunk.indexOf(10);
          if (i >= 0) { pos = p + i + 1; break; }
          p += chunk.length; if (p >= size) pos = size;
        }
      }
    }
    const from = pos, items = [];
    let rest = Buffer.alloc(0), scanned = 0, base = pos;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(CH, size - pos)); await fh.read(chunk, 0, chunk.length, pos);
      pos += chunk.length; scanned += chunk.length;
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
        const lineAt = base + start, line = data.toString("utf8", start, nl).trim();
        start = nl + 1;
        if (!line) continue;
        let ev = null; try { ev = JSON.parse(line); } catch {}
        if (!ev || (excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom)) continue;
        const its = transcriptItems(ev);
        if (!its.length) continue;
        // 够数了、又碰到下一轮的开头：这一行留给下一页
        if (items.length >= limit && its[0].role === "user" && lineAt > from) return { items, from, next: lineAt, size };
        // 一轮里工具调用成百上千、中间没有下一条用户正文：和往前翻一样封顶 limit*4，不然一页能吞下整轮（#70）
        if (items.length >= limit * 4 && lineAt > from) return { items, from, next: lineAt, size };
        items.push(...its);
      }
      base += start; rest = Buffer.from(data.subarray(start));
      if (rest.length > 64 << 20) { base += rest.length; rest = Buffer.alloc(0); }   // 单行超长：跳过
      if (scanned >= MAX_SCAN && items.length) return { items, from, next: base, size };
    }
    // 最后一行没换行：是完整的 JSON 就照样算（导入的、被打断的记录末行常不带换行，#98 03-009）；
    // 解析不了就是还在写，当作到底了 —— 再往后的内容走事件总线实时来，不然界面会反复来要一页空的。
    // 正在跑的那一轮的行由 excludeFrom 挡掉，不会和实时来的重复
    const tail = rest.toString("utf8").trim();
    if (tail && items.length < limit * 4) {
      let ev = null; try { ev = JSON.parse(tail); } catch {}
      if (ev && !(excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom)) items.push(...transcriptItems(ev));
    }
    return { items, from, next: size, size };
  } finally {
    await fh.close();
  }
}

/** 找含某个 uuid 的那一行的起点（脉络跳转的兜底：索引里的偏移对不上时，比如文件被删消息改写过）。找不到返回 -1
 *  start：从这个行首往后找（书签带着它所在那一页的起点，大会话不用从头扫） */
export async function findLineOffset(file, uuid, start = 0) {
  const needle = Buffer.from(`"uuid":"${uuid}"`), CH = 4 << 20;
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = Math.max(0, Math.min(Number(start) || 0, size)), carry = Buffer.alloc(0), base = pos;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(CH, size - pos)); await fh.read(chunk, 0, chunk.length, pos);
      pos += chunk.length;
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const i = data.indexOf(needle);
      // data 总是从某一行的开头起（carry 留的是最后一个换行之后），所以找到时往回找换行就是行首
      if (i >= 0) return base + data.lastIndexOf(10, i) + 1;
      let keep = data.lastIndexOf(10) + 1;
      if (data.length - keep > 64 << 20) keep = data.length - needle.length;   // 单行超长：只留够跨块匹配的一截
      base += keep; carry = Buffer.from(data.subarray(keep));
    }
    return await findLineLoose(fh, size, uuid, Math.max(0, Math.min(Number(start) || 0, size)));
  } finally { await fh.close(); }
}
/** 慢路：旧的 / 外部写的 jsonl 冒号后面带空格（"uuid": "…"），紧凑写法的字面量找不到（#98 03-008）。
 *  逐行看：含这个 uuid 的行再按 "uuid" 键核一遍（parentUuid、leafUuid 也含它，不算） */
async function findLineLoose(fh, size, uuid, pos) {
  if (!/^[\w-]{1,100}$/.test(uuid)) return -1;
  const CH = 4 << 20, val = Buffer.from(uuid), key = new RegExp(`"uuid"\\s*:\\s*"${uuid}"`);
  let carry = Buffer.alloc(0), base = pos;
  while (pos < size) {
    const chunk = Buffer.alloc(Math.min(CH, size - pos)); await fh.read(chunk, 0, chunk.length, pos);
    pos += chunk.length;
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let st = 0, hit = data.indexOf(val);
    while (hit >= 0) {                              // 只看含 uuid 的那几行；一块里没有就整块跳过
      st = data.lastIndexOf(10, hit) + 1;
      let nl = data.indexOf(10, hit);
      if (nl === -1) { if (pos >= size) nl = data.length; else break; }   // 文件最后一行可能没有换行；否则等下一块凑齐
      if (key.test(data.toString("utf8", st, nl))) return base + st;
      st = nl + 1; hit = data.indexOf(val, st);
    }
    if (hit < 0) st = Math.max(st, data.lastIndexOf(10) + 1);
    st = Math.min(st, data.length);
    if (data.length - st > 64 << 20) return -1;    // 单行超长还没完：这条路不管了
    base += st; carry = Buffer.from(data.subarray(st));
  }
  return -1;
}
/** 偏移 off 是不是某行的行首、且那一行含这个 uuid（核对索引给的偏移还准不准）。
 *  uuid 在行里排在 message 后面，压缩摘要那行常有十几 KB，所以要读完整行再看 */
export async function lineHas(file, off, uuid) {
  const fh = await fs.promises.open(file, "r");
  try {
    if (off > 0) { const p = Buffer.alloc(1); await fh.read(p, 0, 1, off - 1); if (p[0] !== 10) return false; }
    const needle = `"uuid":"${uuid}"`, CH = 256 << 10;
    let pos = off, line = Buffer.alloc(0);
    while (line.length < 64 << 20) {
      const b = Buffer.alloc(CH); const { bytesRead } = await fh.read(b, 0, CH, pos);
      if (!bytesRead) break;
      const nl = b.subarray(0, bytesRead).indexOf(10);
      line = Buffer.concat([line, b.subarray(0, nl >= 0 ? nl : bytesRead)]);
      if (nl >= 0) break;
      pos += bytesRead;
    }
    return line.includes(needle) || (/^[\w-]{1,100}$/.test(uuid) && new RegExp(`"uuid"\\s*:\\s*"${uuid}"`).test(line.toString("utf8")));   // 冒号后带空格的旧格式（#98 03-008）
  } catch { return false; } finally { await fh.close(); }
}

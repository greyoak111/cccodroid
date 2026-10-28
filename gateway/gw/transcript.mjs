import fs from "node:fs";
import path from "node:path";
import { LAST_LANG, tr, tz } from "./config.mjs";
import { promptTokens } from "./stream.mjs";

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
  if (ev.type === "user") {
    // 压缩处：带上 uuid，界面画成章节分隔（第几章、题名由路由按脉络索引补上），脉络页跳转也靠它落地
    if (ev.isCompactSummary) { out.push({ role: "note", text: tr(LAST_LANG, tz("（此前的对话已被压缩成摘要）")), compact: true, uuid: ev.uuid || null }); return out; }
    const c = ev.message?.content;
    if (typeof c === "string") {
      if (c && !c.startsWith("<")) out.push({ role: "user", text: c, uuid: ev.uuid || null });
    } else if (Array.isArray(c)) {
      const texts = c.filter((x) => x.type === "text" && x.text && !x.text.startsWith("<")).map((x) => x.text);
      if (c.some((x) => x.type === "image")) texts.push("[图片]");
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

/** 从 transcript **尾部倒着**读一页消息。
 *
 *  老办法是 readFileSync 整个文件再全量解析 —— 十几 MB 的会话会把网关的事件循环
 *  同步卡住好几秒，期间所有请求（包括正在推流的 SSE）一起排队，这就是"一恢复会话就卡半天"。
 *  现在：异步、按 256KB 块往回读，凑够 limit 条且停在一轮对话的开头（用户消息）就收手。
 *  cursor = 这一页最早那行的字节偏移，下次带 before=cursor 接着往前翻；0 表示到头了。
 *
 *  excludeFrom：正在生成的那一轮由事件总线实时推，这里按时间戳把它剔掉，免得画两遍。 */
export async function readSessionPage(file, { before = null, limit = 40, excludeFrom = 0 } = {}) {
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
          if (ev && !contextDone && !ev.isSidechain && !ev.isMeta) {
            if (ev.type === "system" && ev.subtype === "compact_boundary") {
              const m = ev.compactMetadata || ev.compact_metadata || {};
              const post = m.postTokens ?? m.post_tokens;
              if (Number.isFinite(post) && post >= 0) contextTokens = post;
              contextDone = true;   // 不越过压缩边界去拿旧上下文
            } else if (ev.type === "assistant" && !ev.isApiErrorMessage && ev.message?.model !== "<synthetic>") {
              const n = promptTokens(ev.message?.usage);
              if (Number.isFinite(n) && n > 0) { contextTokens = n; contextDone = true; }
            }
          }
          if (ev && !(excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom)) {
            const its = transcriptItems(ev);
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
 *  页的边界都落在一轮的开头，工具调用和它的结果不会被切到两页。
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
        items.push(...its);
      }
      base += start; rest = Buffer.from(data.subarray(start));
      if (rest.length > 64 << 20) { base += rest.length; rest = Buffer.alloc(0); }   // 单行超长：跳过
      if (scanned >= MAX_SCAN && items.length) return { items, from, next: base, size };
    }
    // 最后一行没换行（还在写）：当作到底了 —— 再往后的内容走事件总线实时来，不然界面会反复来要一页空的
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
    return -1;
  } finally { await fh.close(); }
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
    return line.includes(needle);
  } catch { return false; } finally { await fh.close(); }
}

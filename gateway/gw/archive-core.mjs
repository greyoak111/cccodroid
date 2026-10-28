// 建档 · 纯逻辑（不碰网关配置，方便单测）：题名校验、章节划分、交档落在哪一章。
// 规划见 claude-workspace/session-lineage-plan.md §9；规范原文在 gateway/archive/spec.<语言>.md。
//
// 章节：会话从头到第 1 次压缩是第 1 章，第 k 次压缩到第 k+1 次压缩是第 k+1 章；最后一章还在进行。
// 压缩的位置来自脉络索引（lineage-core 的 compacts：压缩摘要那条消息的 uuid / 时间 / 字节位置）。
// 档号：会话号前 4 位 · 章序，例如 0ab2·61。

export const SPEC_VERSION = 1;

const CJK = /[㐀-鿿豈-﫿]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const TRAIL = /[。．.!！?？,，;；:：、…~～]$/;
const QUOTES = [["「", "」"], ["『", "』"], ["“", "”"], ['"', '"'], ["'", "'"], ["《", "》"], ["【", "】"]];
const GREET = /^(你好|您好|嗨|哈喽|hi\b|hello\b|hey\b)/i;
// 日期：年-月、几月几日、月-日（只认真实的月日，「28/36 双包」这种不算；devkit-2026.10.22 这类版本标签不算）
const DATE = /(?<![\w-])\d{4}[-/.年]\d{1,2}|\d{1,2}月\d{1,2}日|(?<![\d.v])(1[0-2]|0?[1-9])[-/](3[01]|[12]\d|0?[1-9])(?![\d/])/;
const VAGUE = /^(对话|会话|聊天|讨论|问题|无标题|新会话|新对话|测试|chat|session|conversation|discussion|untitled|new chat|test)$/i;

const MSG = {
  zh: {
    empty: "题名是空的",
    newline: "题名不能换行",
    long: (n, max) => `太长了：${n} 个字，最多 ${max} 个`,
    short: "太短了，说清这一章干了什么事",
    emoji: "不要用 emoji",
    trail: "结尾不要加标点",
    greet: "不要用问候语开头，写这一章干了什么事",
    date: "不要写日期（日期另外著录）",
    vague: "太空泛了，写具体干了什么事",
    lang: "界面是中文：题名用中文写（专有名词、版本号可以照原样）",
  },
  en: {
    empty: "The title is empty",
    newline: "The title must be on one line",
    long: (n, max) => `Too long: ${n} characters, at most ${max}`,
    short: "Too short: say what the chapter did",
    emoji: "No emoji",
    trail: "No trailing punctuation",
    greet: "Don't start with a greeting; say what the chapter did",
    date: "Don't include a date (it is recorded separately)",
    vague: "Too vague: say what was actually done",
    lang: "The interface is English: write the title in English",
  },
};
const isZh = (lang) => /^zh/i.test(String(lang || ""));

/** 校验题名：{ ok, title（去掉外层引号、首尾空白后）, errors[] }；lang 是界面语言 */
export function validateTitle(raw, lang) {
  const m = isZh(lang) ? MSG.zh : MSG.en;
  let t = String(raw ?? "").trim();
  for (const [a, b] of QUOTES) if (t.length > 2 && t.startsWith(a) && t.endsWith(b)) t = t.slice(a.length, -b.length).trim();
  const errors = [];
  if (!t) return { ok: false, title: t, errors: [m.empty] };
  if (/[\r\n]/.test(t)) errors.push(m.newline);
  const zhTitle = CJK.test(t);
  // 中文界面按「字」计：汉字、全角符号算 1，英文字母、数字、空格这类半角字符算半个（和排出来的宽度一致）
  const n = isZh(lang) ? Math.ceil([...t].reduce((w, c) => w + (c.charCodeAt(0) < 0x2e80 ? 0.5 : 1), 0)) : [...t].length;
  const max = isZh(lang) ? 20 : 60;
  if (n > max) errors.push(m.long(n, max));
  if (n < (zhTitle ? 2 : 3)) errors.push(m.short);
  if (EMOJI.test(t)) errors.push(m.emoji);
  if (TRAIL.test(t)) errors.push(m.trail);
  if (GREET.test(t)) errors.push(m.greet);
  if (DATE.test(t)) errors.push(m.date);
  if (VAGUE.test(t)) errors.push(m.vague);
  if (isZh(lang) && !zhTitle) errors.push(m.lang);
  if (/^en/i.test(String(lang || "")) && zhTitle) errors.push(m.lang);   // 日文 / 韩文等界面不查语言（汉字也是它们的字）
  return { ok: !errors.length, title: t, errors };
}

const STATUS = { 进行中: "ongoing", 已完成: "done", 完成: "done", 搁置: "paused", 暂停: "paused", ongoing: "ongoing", done: "done", paused: "paused" };
export const normStatus = (s) => (s == null || s === "" ? null : STATUS[String(s).trim().toLowerCase()] || STATUS[String(s).trim()] || undefined);

export const archiveNo = (sid, n) => `${String(sid).slice(0, 4)}·${n}`;

/**
 * 交档落在哪一章：
 *   显式给了章号 → 就是它（不能超过当前进行中的那章）；
 *   否则最近结束的那章（第 C 章，C = 压缩次数）还没题名 → 它（刚压缩完，AI 手上有它的摘要）；
 *   否则 → 正在进行的那章（第 C+1 章；没压缩过的会话就是第 1 章）。
 */
export function pickChapter(rec, entry, want) {
  const C = rec.compacts.length;
  if (want != null) {
    const n = Number(want);
    if (!Number.isInteger(n) || n < 1 || n > C + 1) return { error: `chapter out of range (1–${C + 1})` };
    return { n };
  }
  const has = (k) => !!entry?.chapters?.[k]?.title;
  if (C >= 1 && !has(C)) return { n: C };
  return { n: C + 1 };
}

/**
 * 章节一览（给界面和档号解析用）：每章的起止时间、锚点、字节位置、题名；连续标了「同一件事」的并成一卷。
 * sessionTitle：最新一章（卷）的题名 —— 会话列表显示它；没有任何题名时是 null
 */
export function chapterView(rec, entry) {
  const C = rec.compacts.length, out = [];
  for (let n = 1; n <= C + 1; n++) {
    const startC = n >= 2 ? rec.compacts[n - 2] : null, endC = n <= C ? rec.compacts[n - 1] : null;
    const e = entry?.chapters?.[n] || {};
    out.push({
      n, no: archiveNo(rec.id, n),
      from: startC ? startC.ts : rec.firstTs, to: endC ? endC.ts : rec.lastTs,
      anchor: startC ? startC.uuid : rec.uu[0] || null, off: startC ? startC.off : 0,
      open: n === C + 1,
      title: e.title || null, status: e.status || null, same: !!e.same, by: e.by || null, locked: !!e.locked,
    });
  }
  // 卷：「同一件事」的章接在前一章后面；卷的题名取卷里最后一个有题名的章
  const vols = [];
  for (const ch of out) {
    if (ch.same && vols.length) vols.at(-1).chapters.push(ch.n);
    else vols.push({ chapters: [ch.n] });
  }
  for (const v of vols) {
    const chs = v.chapters.map((k) => out[k - 1]);
    v.from = chs[0].from; v.to = chs.at(-1).to;
    v.title = [...chs].reverse().find((c) => c.title)?.title || null;
    v.status = [...chs].reverse().find((c) => c.status)?.status || null;
  }
  const titled = [...vols].reverse().find((v) => v.title);
  return { chapters: out, volumes: vols, sessionTitle: titled ? titled.title : null };
}

/** 压缩后会话重新开始时的钩子（挂在网关给 claude 的 --settings 里）：只陈述事实，规则在系统提示里（见 archive.mjs） */
export function archiveHooks() {
  return { SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: "echo 'cccodroid: the context was just compacted.'" }] }] };
}

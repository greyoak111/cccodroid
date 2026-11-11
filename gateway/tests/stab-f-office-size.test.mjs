// 稳定性报告 FIND-024：docx / xlsx 以前先整份读进内存再判 32MB，
// 超大文件在手机上可能直接卡死或内存不够。现在先按已知大小拦，没带大小就补一次 stat。
// 逻辑只依赖 fetch / api / VW，直接把 vwFetchBuf 抽出来在 vm 里跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src17 = fs.readFileSync(new URL("../web/app/17-office.js", import.meta.url), "utf8");

function loadFetchBuf() {
  const a = src17.indexOf("  async function vwFetchBuf(max) {");
  assert.ok(a > 0, "17-office.js 里找不到 vwFetchBuf");
  const b = src17.indexOf("\n  }\n", a) + 4;
  assert.ok(b > a, "vwFetchBuf 函数体取不完整");
  const fn = src17.slice(a, b);
  const code = `
let VW = { path: "/x/a.docx", size: 0 };
let fetchN = 0, stats = [], statFails = false, bufBytes = 0, statSize = 0;
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
const fmtSize = (n) => n + "B";
const fileUrl = (p) => "/api/file?path=" + encodeURIComponent(p);
const api = async (p) => { stats.push(p); if (statFails) throw new Error("HTTP 404"); return { size: statSize }; };
const fetch = async () => { fetchN++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(bufBytes) }; };
${fn}
globalThis.__h = {
  f: vwFetchBuf,
  set(o) { Object.assign(VW, o); },
  get fetchN() { return fetchN; },
  get stats() { return stats; },
  set statFails(v) { statFails = v; },
  set statSize(v) { statSize = v; },
  set bufBytes(v) { bufBytes = v; },
};
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

const MAX = 32 * 1024 * 1024;

test("FIND-024 打开时已带大小：超过 32MB 直接报错，不发请求、不读文件", async () => {
  const h = loadFetchBuf();
  h.set({ size: MAX + 1 });
  await assert.rejects(h.f(MAX), /文件太大/);
  assert.equal(h.fetchN, 0, "不该去取文件内容");
  assert.equal(h.stats.length, 0, "大小已知，不用再 stat");
});

test("FIND-024 没带大小：先 stat，超限就不取文件", async () => {
  const h = loadFetchBuf();
  h.set({ size: 0 });
  h.statSize = MAX + 1;
  await assert.rejects(h.f(MAX), /文件太大/);
  assert.equal(h.fetchN, 0, "stat 已判超限，不该再取文件");
  assert.equal(h.stats.length, 1);
  assert.match(h.stats[0], /^\/api\/file\/stat\?path=/);
});

test("FIND-024 stat 失败：照老路取文件，读回来再兜底", async () => {
  const h = loadFetchBuf();
  h.set({ size: 0 });
  h.statFails = true;
  h.bufBytes = MAX + 1;
  await assert.rejects(h.f(MAX), /文件太大/);
  assert.equal(h.fetchN, 1, "stat 失败不能拦死，还得按原路读");
});

test("FIND-024 大小正常：正常取回内容", async () => {
  const h = loadFetchBuf();
  h.set({ size: 1024 });
  h.bufBytes = 1024;
  const b = await h.f(MAX);
  assert.equal(b.byteLength, 1024);
  assert.equal(h.fetchN, 1);
});

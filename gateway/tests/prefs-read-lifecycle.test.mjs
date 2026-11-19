import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = name => readFileSync(new URL(`../web/app/${name}.js`, import.meta.url), "utf8");
function between(src, start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return src.slice(a, b);
}

const page = read("14-projects-sched");
const readers = between(page, "  const pageReads =", "  const sameGet =");

function gate() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release };
}

test("on-demand reads share a visit, but re-entering takes a fresh snapshot after the old read", async () => {
  const viewRead = runInNewContext(readers + "\nviewRead", {});
  const old = gate();
  let visit = 1, calls = 0;
  const seen = [];
  const readFor = n => async () => {
    if (++calls === 1) await old.pending;
    if (visit === n) seen.push(n);
  };
  const open = n => viewRead("fixture", n, () => visit === n, readFor(n));
  const first = open(1);
  assert.equal(open(1), first);
  visit = 2;
  const second = open(2);
  visit = 3;
  const third = open(3);
  assert.equal(calls, 1);
  old.release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2, "the already abandoned second visit should not start a read");
  assert.deepEqual(seen, [3]);
});

test("an existing storage cleanup shows its result on return without poll or DOM writes while away", async () => {
  const src = read("10b-storage"), result = gate();
  const receipt = { textContent: "", className: "" }, polls = [];
  const box = { setVisit: 1, visible: true, t: (s, data = {}) => s.replace(/\{(\w+)\}/g, (_, k) => data[k]),
    fmtSize: String, $: () => receipt, post: () => result.pending, stLoad() {}, clearTimeout() {},
    setTimeout: (_fn, delay) => polls.push(delay),
    setVisible: (cat, visit = box.setVisit) => cat === "storage" && box.visible && visit === box.setVisit };
  const api = runInNewContext(
    between(src, "  const ST =", "  function stLoad(") +
    between(src, "  function stOnOpen(", "  function stPaint(") +
    between(src, "  async function stClean(", '  $("st-scan").addEventListener') +
    "\n({ stOnOpen, stClean })", box);
  const clean = api.stClean("cache");
  assert.equal(receipt.textContent, "正在清理…");
  box.visible = false; box.setVisit++;
  result.release({ ok: true, n: 2, freed: 64 });
  await clean;
  assert.equal(receipt.textContent, "正在清理…");
  assert.deepEqual(polls, []);
  box.visible = true;
  api.stOnOpen();
  assert.equal(receipt.className, "prov-state ok");
  assert.equal(receipt.textContent, "✓ 删了 2 项，腾出 64");
});

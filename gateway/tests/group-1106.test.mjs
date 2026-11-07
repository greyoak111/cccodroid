// 群反馈 11-06：Bash 卡片标题用模型写的说明；重试时出错原因直接写在小字里
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

test("Bash 带说明：标题是说明；没说明照旧是命令；别的工具不受影响", () => {
  const box = {};
  vm.runInNewContext(take(read("02-chat-view.js"), "  function summarizeTool(", "  /** 收着的子代理") + "\nglobalThis.f = summarizeTool;", box);
  assert.equal(box.f("Bash", { command: "cd $TMPDIR/pcap; for p in …", description: "停止抓包并统计目的地址" }), "停止抓包并统计目的地址");
  assert.equal(box.f("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(box.f("Bash", { command: "ls", description: "  " }), "ls");
  assert.equal(box.f("Agent", { prompt: "p", description: "d" }), "p");
});

test("重试小字：第一次重试就带上状态码和出错原因", () => {
  const src = read("03-perm-status.js");
  const a = src.indexOf('case "retry": {'), b = src.indexOf("        }", a);
  const body = src.slice(a, b + 9);
  const box = { t: (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o[n]) };
  vm.runInNewContext(`globalThis.f = (phEv) => { switch (phEv.phase) { ${body} } };`, box);
  assert.equal(box.f({ phase: "retry", attempt: 1, max: 10, status: 429, error: "rate limited" }), "连接出错，第 1/10 次重试：429 · rate limited");
  assert.equal(box.f({ phase: "retry", attempt: 2, max: 10 }), "连接出错，第 2/10 次重试");
});

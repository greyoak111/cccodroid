// 稳定性报告 FIND-009：端侧模型只用一个全局 LL.run 记「当前那一轮」，并行会话时后开始的会盖掉前面的。
// 结果是另一轮收不到预填进度、服务崩了收不到提示；换模型时指针还可能指着已经结束的一轮，
// 误判成没人用，把别人正在答题的服务停掉。改成记所有没结束的端侧轮次，提示发给每一轮。
import "../gw/config.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PREFIX } from "../gw/config.mjs";
import { LL, ensureLlama, localRunAttach, localRunNote } from "../gw/local.mjs";

const MODELS = path.join(CFG.home, "models");
const BIN = path.join(PREFIX, "bin", "llama-server");
const mkModel = (id) => {
  fs.mkdirSync(MODELS, { recursive: true });
  const f = path.join(MODELS, id + ".gguf");
  fs.writeFileSync(f, "");
  fs.truncateSync(f, 10 * 1024 * 1024); // localModels 只认 10MB 以上的模型文件
  return f;
};

after(() => {
  fs.rmSync(MODELS, { recursive: true, force: true });
  fs.rmSync(BIN, { force: true });
  LL.child = null;
  LL.state = "off";
});

test("FIND-009 预填/崩溃提示发给每一轮活着的端侧对话，结束的那轮不再收到", () => {
  const a = { id: "stab-f-run-a", ended: false };
  const b = { id: "stab-f-run-b", ended: false };
  localRunAttach(a);
  localRunAttach(b);
  const got = [];
  const n = localRunNote("crash", "llama-server 意外退出", (r, ev) => got.push(`${r.id}|${ev.type}|${ev.key}|${ev.text}`));
  assert.equal(n, 2, "两轮都在用时，崩溃提示要发给两轮");
  assert.deepEqual(got.sort(), [
    "stab-f-run-a|note|crash|llama-server 意外退出",
    "stab-f-run-b|note|crash|llama-server 意外退出",
  ]);
  // A 结束了：只剩 B 收；A 也要被清出去，不能再收到任何提示
  a.ended = true;
  const got2 = [];
  assert.equal(localRunNote("prefill", "端侧模型正在读提示：37%", (r) => got2.push(r.id)), 1);
  assert.deepEqual(got2, ["stab-f-run-b"]);
  b.ended = true;
  assert.equal(localRunNote("prefill", "端侧模型正在读提示：37%", () => { throw new Error("没有活着的轮次，不该发"); }), 0);
});

test("FIND-009 还有端侧轮次在用时不许换模型；最后开始的那轮已结束也不能放行", async () => {
  mkModel("stab-f-model-a");
  mkModel("stab-f-model-b");
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  fs.writeFileSync(BIN, "");
  // 假装服务载着别的模型，两轮对话都还在用
  LL.child = { pid: process.pid };
  LL.sig = "stab-f-other";
  LL.id = "stab-f-other";
  LL.state = "ready";
  const a = { id: "stab-f-run-1", ended: false };
  const b = { id: "stab-f-run-2", ended: false };
  localRunAttach(a);
  localRunAttach(b);
  await assert.rejects(ensureLlama("stab-f-model-a", () => {}), /正在另一个会话里用，等它答完再换模型/);
  // 后开始的那轮结束了、先开始的还在跑：老的单指针会被后者覆盖而放行，这里照样要拦
  b.ended = true;
  await assert.rejects(ensureLlama("stab-f-model-b", () => {}), /正在另一个会话里用，等它答完再换模型/);
  // 都结束了才放行。往下走会真去起 llama-server（测试里是个空文件，起来就失败），
  // 这里只确认报的不是「别的会话正在用」
  LL.child = null;
  a.ended = true;
  await assert.rejects(ensureLlama("stab-f-model-a", () => {}), (e) => !/正在另一个会话里用/.test(String(e.message)));
});

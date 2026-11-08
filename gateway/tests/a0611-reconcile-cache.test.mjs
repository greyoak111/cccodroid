// 「修补」动作随核对结果存进 home 下的缓存，网关启动时读回来：读回时就要核动作的形状。
// 第一版把核形状的函数写在读缓存之后（暂时性死区），有缓存的机器上网关一启动就抛错（0.6.11 全量测出）
import { CFG, PREFIX } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const STATE = path.join(CFG.home, ".cache", "cccodroid", "reconcile.json");
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify({ at: 1, ms: 1, findings: [
  { key: "comp-files:a", level: "error", k: "坏了", v: null, fix: "", act: { t: "comp", id: "a" } },
  { key: "comp-files:b", level: "error", k: "坏了", v: null, fix: "", act: { t: "comp", id: "../../x" } },
  { key: "z", level: "error", k: "坏了", v: null, fix: "", act: { t: "sh", id: "a" } },
] }));
const { fixPlan } = await import("../gw/reconcile.mjs");

test("带动作的缓存能读回；形状不对的动作丢掉、条目留着", { skip: !PREFIX && "没有工具包前缀：对账不跑" }, async () => {
  const { routeReconcile } = await import("../gw/reconcile.mjs");
  const body = await new Promise((done) => {
    const req = { method: "GET", headers: {} };
    const res = { req, writeHead() {}, end(b) { done(JSON.parse(String(b))); } };
    routeReconcile(req, res, new URL("http://x/api/reconcile"), "/api/reconcile");
  });
  assert.deepEqual(body.findings.map((f) => [f.key, f.act]), [["comp-files:a", "comp"], ["comp-files:b", ""], ["z", ""]]);
  assert.equal(typeof fixPlan, "function");
});

// 工作岛：am 发送串行，收尾先杀在途的再发 IDLE（0.6.9 审计 200-13-08）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { _islandForTest as T } from "../gw/work-island.mjs";

function fake() {
  const calls = [];       // { action, cb, killed }
  let live = 0, peak = 0;
  T.seam.exec = (args, timeout, cb) => {
    const action = args[args.indexOf("-a") + 1].split(".").pop();
    const c = { action, killed: false };
    live++; peak = Math.max(peak, live);
    c.done = (e = null, err = "") => { live--; cb(e, "", err); };
    c.kill = () => { c.killed = true; live--; setImmediate(() => cb(Object.assign(new Error("killed"), { killed: true }), "", "")); };
    calls.push(c);
    return c;
  };
  const sync = [];
  T.seam.execSync = (args) => { sync.push(args[args.indexOf("-a") + 1].split(".").pop()); };
  return { calls, sync, peak: () => peak };
}

test("同一时刻最多一个 am，按入队顺序发，排队里被盖过的 UPDATE 不发", () => {
  const f = fake();
  T.send("UPDATE", "a", "1");
  T.send("UPDATE", "a", "2");
  T.send("UPDATE", "a", "3");
  T.send("DONE", "d", "x");
  T.send("IDLE", "i", "y");
  assert.equal(f.calls.length, 1, "第一条没回来前不起第二个");
  for (let i = 0; i < 10 && f.calls.at(-1) && !f.calls.at(-1).finished; i++) {
    const c = f.calls.at(-1); c.finished = true; c.done();
  }
  assert.deepEqual(f.calls.map((c) => c.action), ["UPDATE", "UPDATE", "DONE", "IDLE"]);
  assert.equal(f.peak(), 1);
  assert.equal(T.state().amQ, 0);
  assert.equal(T.state().amBusy, false);
});

test("同步收尾：排队的作废，在途的杀掉，再同步发 IDLE；被杀的回调不接着发", async () => {
  const f = fake();
  T.send("UPDATE", "a", "1");
  T.send("UPDATE", "a", "2");
  T.sendSync("IDLE", "i", "y");
  assert.equal(f.calls[0].killed, true, "在途的 UPDATE 被杀");
  assert.deepEqual(f.sync, ["IDLE"]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.calls.length, 1, "排队的 UPDATE 不再发出");
  assert.equal(T.state().amBusy, false);
  // 之后再发照常
  T.send("UPDATE", "b", "1");
  assert.equal(f.calls.length, 2);
  f.calls[1].done();
  assert.equal(T.state().amBusy, false);
});

// e 组 FIND-044：取消一轮时，setsid / nohup 双 fork 出去、已经被 init 收养的后代不在进程树也不在 claude 的进程组里，
// killTree 够不着。按该轮 CCAPP_RUN_ID 扫描 /proc 清掉；比这一轮起得早的不动。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { killRunProcs } from "../gw/claude.mjs";

const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startOf = (pid) => { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; };
const waitGone = async (pid) => { for (let i = 0; i < 100; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
async function escapee(runId, { service = false } = {}) {
  const env = { ...process.env, CCAPP_RUN_ID: runId, CCAPP_RUN: "1" };
  if (service) delete env.CCAPP_RUN;                // 常驻服务的约定：去掉 CCAPP_RUN（见 terminal.mjs、openai-bridge）
  const c = spawn(SLEEP, ["60"], { env, detached: true, stdio: "ignore" });
  c.unref();
  for (let i = 0; i < 100 && !fs.existsSync(`/proc/${c.pid}`); i++) await new Promise((r) => setTimeout(r, 10));
  return c.pid;
}
const cleanup = [];
after(() => { for (const pid of cleanup) try { process.kill(pid, "SIGKILL"); } catch {} });

test("FIND-044：按 CCAPP_RUN_ID 清掉脱出进程树的后代", async () => {
  const id = "stab-e-" + crypto.randomUUID();
  const pid = await escapee(id);
  cleanup.push(pid);
  assert.equal(alive(pid), true, "测试进程没起来");
  assert.equal(killRunProcs(id), 1);
  assert.equal(await waitGone(pid), true, "脱出去的进程还在");
});

test("FIND-044：比这一轮起得早的（编号被抄）不动", async () => {
  const id = "stab-e-" + crypto.randomUUID();
  const pid = await escapee(id);
  cleanup.push(pid);
  const since = startOf(pid) + 1000;                 // 假装这一轮的 claude 比它晚起
  assert.equal(killRunProcs(id, since), 0);
  assert.equal(alive(pid), true, "早于这一轮的不该动");
  killRunProcs(id);                                  // 收尾
  await waitGone(pid);
});

test("FIND-044：去掉了 CCAPP_RUN 的常驻服务不动（与 reapOrphans、终端同一约定）", async () => {
  const id = "stab-e-" + crypto.randomUUID();
  const svc = await escapee(id, { service: true });
  const job = await escapee(id);
  cleanup.push(svc, job);
  assert.equal(killRunProcs(id), 1, "只该清带着 CCAPP_RUN=1 的那个");
  assert.equal(await waitGone(job), true, "带标记的脱出进程还在");
  assert.equal(alive(svc), true, "声明为常驻服务的被杀了");
  process.kill(svc, "SIGKILL");
  await waitGone(svc);
});

// 网关启动时收孤儿（reapOrphans）：起它的网关还活着的不收（11-07：测试里另起的 LIVE 网关一启动，
// 把真网关名下用 setsid 脱出去的后台测试整组 SIGKILL 了；B 轮 q054 那次静默死亡同因）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { reapOrphans } from "../gw/claude.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ppid = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +s.slice(s.lastIndexOf(")") + 2).split(" ")[1]; } catch { return null; } };
const left = [];
after(() => { for (const p of left) try { process.kill(p, "SIGKILL"); } catch {} });

// 起一个被 init 收养的 sleep（sh 放它到后台就退出），返回 sleep 的 pid
async function orphan(extra) {
  const env = { ...process.env, CCAPP_RUN: "1", ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const sh = spawn("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = ""; sh.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => sh.on("exit", r));
  const pid = +out.trim();
  left.push(pid);
  for (let i = 0; i < 50 && ppid(pid) !== 1; i++) await new Promise((r) => setTimeout(r, 20));
  return pid;
}

test("活网关名下脱出去的不收；上一任已退出、没带网关号的照收", async (t) => {
  if (!process.env.CCAPP_PREFIX) return t.skip("只在 cccodroid 收孤儿");
  const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();   // 已经退出的网关
  const live = await orphan({ CCAPP_GW_PID: String(process.ppid) });                    // 起它的「网关」还活着
  const dead = await orphan({ CCAPP_GW_PID: gone });
  const old = await orphan({ CCAPP_GW_PID: undefined });                                 // 旧版网关起的：没有网关号
  const bogus = await orphan({ CCAPP_GW_PID: "0" });                                      // 网关号无效：照收
  for (const p of [live, dead, old, bogus]) assert.equal(ppid(p), 1, `pid ${p} 没被 init 收养，测试前提不成立`);
  reapOrphans();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(alive(live), "起它的网关还活着，却被收了");
  assert.ok(!alive(dead), "上一任已退出，留下的没收");
  assert.ok(!alive(old), "没带网关号的没收");
  assert.ok(!alive(bogus), "网关号无效的没收");
});


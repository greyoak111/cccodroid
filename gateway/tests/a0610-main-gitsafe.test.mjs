// P1-10 后续：全局 safe.directory=* 撤掉后，「属主可疑」的仓库（共享存储上的都是）面板照样能开，风险检查也不漏报。
// 用 git 自带的 GIT_TEST_ASSUME_DIFFERENT_OWNER 模拟属主不同
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeGit } from "../gw/git.mjs";

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeGit(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => { srv.close(); delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; });
const call = async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
{ const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), bin = path.join(process.env.CCAPP_PREFIX, "bin", "git");
  if (!fs.existsSync(bin)) fs.symlinkSync(real, bin); }

test("属主可疑的仓库：status 能开；仓库自带的过滤器照样被认出来、提交前要确认", async () => {
  const d = path.join(CFG.workspace, "gitsafe");
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q"); fs.writeFileSync(path.join(d, "f.txt"), "a\n"); g("add", "f.txt"); g("commit", "-qm", "i");
  g("config", "filter.px.clean", "cat");
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  try {
    const st = await call("/api/git/status?dir=" + encodeURIComponent(d));
    assert.equal(st.status, 200, JSON.stringify(st.body));
    fs.writeFileSync(path.join(d, "f.txt"), "b\n");
    const c = await call("/api/git/commit", { dir: d, message: "m" });
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.ok(c.body.risks.some((x) => x.startsWith("filter.px.clean")), "本地配置要读得到：" + JSON.stringify(c.body.risks));
  } finally { delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; fs.rmSync(d, { recursive: true, force: true }); }
});

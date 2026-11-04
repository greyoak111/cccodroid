// 11-03 独立审查的回归测试：编号对应私密台账里的 C/H/M/L 条目
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeGit } from "../gw/git.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const call = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return call;
}
const gitGo = await serve(routeGit);
{ const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), bin = path.join(process.env.CCAPP_PREFIX, "bin", "git");
  if (!fs.existsSync(bin)) fs.symlinkSync(real, bin); }

function repo(name) {
  const d = path.join(CFG.workspace, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q");
  fs.writeFileSync(path.join(d, "f.txt"), "a\n");
  g("add", "f.txt"); g("commit", "-qm", "i");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  return { d, g };
}
/** 仓库配置里挂一个会留下记号的过滤器，用 .git/info/attributes 选中（--attr-source 管不到这一层） */
function plant(r) {
  const mark = path.join(r.d, "..", path.basename(r.d) + ".mark");
  fs.rmSync(mark, { force: true });
  r.g("config", "filter.px.clean", `sh -c 'echo x >> ${mark}; cat'`);
  r.g("config", "filter.px.smudge", `sh -c 'echo x >> ${mark}; cat'`);
  fs.writeFileSync(path.join(r.d, ".git", "info", "attributes"), "* filter=px\n");
  // stat 变脏、内容不变：git 要过一遍 clean 才知道有没有改
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(r.d, "f.txt"), t, t);
  return mark;
}

test("H-1 只读的 status/diff 不执行 .git/info/attributes 选中的过滤器", async () => {
  const r = repo("h1"); const mark = plant(r);
  const st = await gitGo("/api/git/status?dir=" + encodeURIComponent(r.d));
  assert.equal(st.status, 200);
  const df = await gitGo("/api/git/diff?dir=" + encodeURIComponent(r.d));
  assert.equal(df.status, 200);
  assert.equal(fs.existsSync(mark), false, "过滤器被执行了");
  // 反证：原样跑 git status 会执行
  execFileSync("git", ["--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "status", "--short"], { cwd: r.d });
  assert.equal(fs.existsSync(mark), true);
});

test("M-1 提交/撤销遇到仓库自带的过滤器先要确认，确认后放行", async () => {
  const r = repo("m1"); const mark = plant(r);
  fs.writeFileSync(path.join(r.d, "f.txt"), "b\n");
  const a = await gitGo("/api/git/commit", { dir: r.d, message: "m" });
  assert.equal(a.status, 409);
  assert.equal(a.body.error, "untrusted");
  assert.ok(a.body.risks.some((x) => x.startsWith("filter.px.clean")));
  const d = await gitGo("/api/git/discard", { dir: r.d, file: "f.txt" });
  assert.equal(d.status, 409);
  assert.equal(fs.existsSync(mark), false);
  const ok = await gitGo("/api/git/commit", { dir: r.d, message: "m", trust: a.body.fp });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // 记住了：同一份配置不再问
  fs.writeFileSync(path.join(r.d, "f.txt"), "c\n");
  assert.equal((await gitGo("/api/git/commit", { dir: r.d, message: "m2" })).status, 200);
  // 配置一变重新问
  r.g("config", "core.sshCommand", "sh -c id");
  assert.equal((await gitGo("/api/git/fetch", { dir: r.d })).status, 409);
});

test("复核 11-03：过滤器名大小写不同也盖得住；看不懂的配置只读不跑、写要确认", async () => {
  const r = repo("h1c"), mark = path.join(r.d, "..", "h1c.mark");
  fs.rmSync(mark, { force: true });
  r.g("config", "filter.Evil.clean", `sh -c 'echo x >> ${mark}; cat'`);
  r.g("config", "filter.Evil.smudge", `sh -c 'echo x >> ${mark}; cat'`);
  fs.writeFileSync(path.join(r.d, ".git", "info", "attributes"), "* filter=Evil\n");
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(r.d, "f.txt"), t, t);
  assert.equal((await gitGo("/api/git/status?dir=" + encodeURIComponent(r.d))).status, 200);
  assert.equal(fs.existsSync(mark), false, "大写名字的过滤器被执行了");
  const c = await gitGo("/api/git/commit", { dir: r.d, message: "m" });
  assert.equal(c.status, 409);
  assert.ok(c.body.risks.some((x) => x.startsWith("filter.Evil.clean")), JSON.stringify(c.body.risks));
  // 名字里带引号（值里带换行同理）：解析不可靠，只读命令拒跑，写操作要确认
  const r2 = repo("h1d");
  fs.appendFileSync(path.join(r2.d, ".git", "config"), '[filter "q\\"x"]\n\tclean = cat\n');
  const st = await gitGo("/api/git/status?dir=" + encodeURIComponent(r2.d));
  assert.ok(st.status !== 200 || st.body.error, JSON.stringify(st));
  fs.writeFileSync(path.join(r2.d, "f.txt"), "b\n");
  const c2 = await gitGo("/api/git/commit", { dir: r2.d, message: "m" });
  // 认仓库根的 rev-parse 也被拒了，走不到确认那一步：不执行、不提交就行
  assert.notEqual(c2.status, 200, JSON.stringify(c2.body));
  assert.equal(r2.g("log", "--oneline").trim().split("\n").length, 1);
});

test("M-1 钩子要确认；git-lfs 的标准写法与没有风险的仓库不打扰", async () => {
  const r = repo("m1b");
  r.g("config", "filter.lfs.clean", "git-lfs clean -- %f");
  r.g("config", "filter.lfs.process", "git-lfs filter-process");
  fs.writeFileSync(path.join(r.d, "f.txt"), "b\n");
  assert.equal((await gitGo("/api/git/commit", { dir: r.d, message: "m" })).status, 200);
  fs.writeFileSync(path.join(r.d, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(r.d, "f.txt"), "c\n");
  const a = await gitGo("/api/git/commit", { dir: r.d, message: "m" });
  assert.equal(a.status, 409);
  assert.deepEqual(a.body.risks, ["hook: pre-commit"]);
});

test("M-1 ext:: 远端在抓取时不执行", async () => {
  const r = repo("m1c"); const mark = path.join(r.d, "..", "m1c.ext");
  fs.rmSync(mark, { force: true });
  r.g("remote", "add", "origin", `ext::sh -c touch% ${mark}`);
  const a = await gitGo("/api/git/fetch", { dir: r.d });
  assert.notEqual(a.status, 409);   // 本地没设 protocol.ext.allow：不用确认，直接失败
  assert.equal(fs.existsSync(mark), false);
  r.g("config", "protocol.ext.allow", "always");
  const b = await gitGo("/api/git/fetch", { dir: r.d });
  assert.equal(b.status, 409);
  const c = await gitGo("/api/git/fetch", { dir: r.d, trust: b.body.fp });
  assert.notEqual(c.status, 200);
  assert.equal(fs.existsSync(mark), false, "确认了也不放行 ext::");
});

test("M-8：组件运行数据清理只删索引里的组件，保留名一律不删", async () => {
  const { routeComponents } = await import("../gw/components.mjs");
  const call = await serve(routeComponents);
  for (const id of ["custom", "bin", "services", "agents", "not-in-index"]) {
    const d = path.join(CFG.home, ".cccodroid", id);
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "keep"), "1");
    const r = await call("/api/components/purge", { id });
    assert.equal(r.body.ok, false, id);
    assert.ok(fs.existsSync(path.join(d, "keep")), id + " 被删了");
  }
});

// 破甲资料（1fshi26）：-p 不弹信任框，项目里的钩子 / .mcp.json 打开就跑 —— 起一轮前要认出来
test("项目自带会自动运行的配置：认得出、指纹跟内容走、上级目录的 .mcp.json 也算", async () => {
  const { projectRisks, projectTrusted, trustProject } = await import("../gw/projtrust.mjs");
  const root = fs.mkdtempSync(path.join(CFG.home, "pt-")), proj = path.join(root, "a", "b");
  fs.mkdirSync(path.join(proj, ".claude", "agents"), { recursive: true });
  // 只有无害的键：不问
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({ model: "x", permissions: { deny: ["Bash(rm:*)"] } }));
  assert.equal(projectRisks(proj), null);
  // 钩子、环境变量、放宽权限：都报
  fs.writeFileSync(path.join(proj, ".claude", "settings.local.json"), JSON.stringify({ hooks: { SessionStart: [] }, env: { NODE_OPTIONS: "--require x" }, permissions: { allow: ["Bash"] } }));
  let r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => /hooks$/.test(x)) && r.risks.some((x) => /env$/.test(x)) && r.risks.some((x) => /permissions\.allow$/.test(x)), JSON.stringify(r));
  fs.unlinkSync(path.join(proj, ".claude", "settings.local.json"));
  // 两级以上的 .mcp.json（模拟 /sdcard/.mcp.json）
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
  r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => x.endsWith(": evil")), JSON.stringify(r));
  // 写坏的 .mcp.json 也不放过
  fs.writeFileSync(path.join(root, ".mcp.json"), "{ not json");
  assert.ok(projectRisks(proj)?.risks.some((x) => x.endsWith(": ?")));
  fs.unlinkSync(path.join(root, ".mcp.json"));
  // 子代理 frontmatter 里的 hooks
  fs.writeFileSync(path.join(proj, ".claude", "agents", "r.md"), "---\nname: r\nhooks:\n  Stop: []\n---\nbody");
  r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => x.includes("agents/r.md")), JSON.stringify(r));
  // 认过以后同一份不再问，改一个字就要再问
  assert.equal(projectTrusted(proj, r.fp), false);
  trustProject(proj, r.fp);
  assert.equal(projectTrusted(proj, r.fp), true);
  fs.writeFileSync(path.join(proj, ".claude", "agents", "r.md"), "---\nname: r\nhooks:\n  Stop: [x]\n---\nbody");
  assert.equal(projectTrusted(proj, projectRisks(proj).fp), false);
});

test("复核 11-03 C-2/C-3：disableAllHooks、超大文件、引号键、超过 300 个都算风险", async () => {
  const { projectRisks } = await import("../gw/projtrust.mjs");
  const proj = fs.mkdtempSync(path.join(CFG.home, "pt2-"));
  fs.mkdirSync(path.join(proj, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
  assert.ok(projectRisks(proj)?.risks.some((x) => x.endsWith("disableAllHooks")));
  fs.unlinkSync(path.join(proj, ".claude", "settings.json"));
  fs.writeFileSync(path.join(proj, ".claude", "agents", "q.md"), '---\nname: q\n"hooks":\n  Stop: []\n---\n');
  assert.ok(projectRisks(proj)?.risks.some((x) => x.includes("q.md")));
  fs.unlinkSync(path.join(proj, ".claude", "agents", "q.md"));
  fs.writeFileSync(path.join(proj, ".claude", "agents", "big.md"), "---\nhooks:\n---\n" + "x".repeat(9 << 20));
  assert.ok(projectRisks(proj)?.risks.some((x) => x.includes("big.md")));
  fs.unlinkSync(path.join(proj, ".claude", "agents", "big.md"));
  for (let i = 0; i < 305; i++) fs.writeFileSync(path.join(proj, ".claude", "agents", `a${i}.md`), "x");
  assert.ok(projectRisks(proj)?.risks.some((x) => x.endsWith("> 300")));
});

test("sha256 仓库：只读的属性来源换成同格式的空树，对比、历史、提交详情都能看", async () => {
  const d = path.join(CFG.workspace, "s256");
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q", "--object-format=sha256");
  fs.writeFileSync(path.join(d, "f.txt"), "a\n");
  // 还没提交：和 sha256 的空树比（暂存过的文件）
  g("add", "f.txt");
  const d0 = await gitGo("/api/git/diff?dir=" + encodeURIComponent(d));
  assert.equal(d0.status, 200, JSON.stringify(d0.body));
  assert.match(d0.body.diff, /\+a/);
  g("commit", "-qm", "i");
  fs.writeFileSync(path.join(d, "f.txt"), "a\nb\n");
  const df = await gitGo("/api/git/diff?dir=" + encodeURIComponent(d));
  assert.equal(df.status, 200, JSON.stringify(df.body));
  assert.match(df.body.diff, /\+b/);
  const lg = await gitGo("/api/git/log?dir=" + encodeURIComponent(d));
  assert.equal(lg.body.error, undefined);
  assert.equal(lg.body.commits.length, 1);
  assert.equal(lg.body.commits[0].hash.length, 64);
  const sh = await gitGo(`/api/git/show?dir=${encodeURIComponent(d)}&commit=${lg.body.commits[0].hash}`);
  assert.equal(sh.status, 200, JSON.stringify(sh.body));
  assert.equal(sh.body.files[0].path, "f.txt");
  const dc = await gitGo(`/api/git/diff?dir=${encodeURIComponent(d)}&commit=${lg.body.commits[0].hash}`);
  assert.equal(dc.status, 200, JSON.stringify(dc.body));
  assert.match(dc.body.diff, /\+a/);
  // 反证：拿 sha1 的空树当属性来源，git 自己就拒绝
  const bad = spawnSync("git", ["--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "diff"], { cwd: d, encoding: "utf8" });
  assert.match(bad.stderr, /bad --attr-source/);
  // 反过来也一样：sha1 仓库拿 sha256 的空树，同样 fatal（选错格式只会报错，不会退回仓库自己的属性）
  const s1 = path.join(CFG.workspace, "s1");
  fs.rmSync(s1, { recursive: true, force: true }); fs.mkdirSync(s1, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: s1 });
  fs.writeFileSync(path.join(s1, "f.txt"), "a\n");
  execFileSync("git", ["add", "f.txt"], { cwd: s1 });
  const bad1 = spawnSync("git", ["--attr-source=6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321", "diff", "--cached"], { cwd: s1, encoding: "utf8" });
  assert.match(bad1.stderr, /bad --attr-source/);
});

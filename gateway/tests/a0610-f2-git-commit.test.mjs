// 0.6.10 审计 195-S.1 / S.2：提交只提交勾选的文件快照，冲突没解决不许提交
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  return async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
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
const has = (r, f) => execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: r.d, encoding: "utf8" }).split("\n").includes(f);

test("S.1 全选提交只提交状态快照里列出的文件，快照之后新冒出来的不进提交", async () => {
  const r = repo("s1");
  // 前端取状态快照时只看到 f.txt 有改动；之后又冒出 c.txt（另一个应用 / 终端写的）
  fs.writeFileSync(path.join(r.d, "f.txt"), "b\n");
  const st = await gitGo("/api/git/status?dir=" + encodeURIComponent(r.d));
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.files.map((f) => f.path), ["f.txt"]);
  fs.writeFileSync(path.join(r.d, "c.txt"), "new\n");
  const c = await gitGo("/api/git/commit", { dir: r.d, message: "m", files: ["f.txt"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(has(r, "f.txt"), true);
  assert.equal(has(r, "c.txt"), false, "快照之外的 c.txt 被一起提交了");
  const after1 = await gitGo("/api/git/status?dir=" + encodeURIComponent(r.d));
  assert.equal(after1.body.files.some((f) => f.path === "c.txt" && f.kind === "new"), true);
});

test("S.1 前端「全选」也必须传勾选清单，不再发 files:null", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app", "16-viewer-git.js"), "utf8");
  assert.match(src, /gpost\("commit", \{ message: msg, files: \[\.\.\.GIT\.sel\] \}\)/);
  assert.doesNotMatch(src, /files: all \? null/);
});

test("S.2 冲突没解决时提交被拒，已解决的合并提交可以提交", async () => {
  const r = repo("s2");
  fs.writeFileSync(path.join(r.d, "a.txt"), "base\n");
  r.g("add", "a.txt"); r.g("commit", "-qm", "base");
  const main = r.g("rev-parse", "--abbrev-ref", "HEAD").trim();
  r.g("checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(r.d, "a.txt"), "side\n"); r.g("commit", "-qam", "side");
  r.g("checkout", "-q", main);
  fs.writeFileSync(path.join(r.d, "a.txt"), "main\n"); r.g("commit", "-qam", "main");
  let conflicted = false;
  try { r.g("merge", "side"); } catch { conflicted = true; }
  assert.equal(conflicted, true);
  const head0 = r.g("rev-parse", "HEAD").trim();
  const bad = await gitGo("/api/git/commit", { dir: r.d, message: "merge", files: ["a.txt"] });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "conflict");
  assert.equal(r.g("rev-parse", "HEAD").trim(), head0, "冲突状态下居然提交了");
  // 解决冲突（内容里没有冲突标记），只提交 a.txt：这次提交覆盖了全部改动，允许
  fs.writeFileSync(path.join(r.d, "a.txt"), "resolved\n");
  r.g("add", "a.txt");
  const ok = await gitGo("/api/git/commit", { dir: r.d, message: "merge", files: ["a.txt"] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(r.g("show", "HEAD:a.txt").trim(), "resolved");
  assert.equal(r.g("rev-list", "--parents", "-n1", "HEAD").trim().split(" ").length, 3, "应为两个父提交的合并提交");
});

test("S.2 合并中只选一部分改动时给出中文提示，不抛英文 fatal", async () => {
  const r = repo("s2b");
  fs.writeFileSync(path.join(r.d, "a.txt"), "base\n");
  r.g("add", "a.txt"); r.g("commit", "-qm", "base");
  const main = r.g("rev-parse", "--abbrev-ref", "HEAD").trim();
  r.g("checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(r.d, "a.txt"), "side\n"); r.g("commit", "-qam", "side");
  r.g("checkout", "-q", main);
  fs.writeFileSync(path.join(r.d, "a.txt"), "main\n"); r.g("commit", "-qam", "main");
  try { r.g("merge", "side"); } catch {}
  fs.writeFileSync(path.join(r.d, "a.txt"), "resolved\n"); r.g("add", "a.txt");
  fs.writeFileSync(path.join(r.d, "f.txt"), "other\n");
  const head0 = r.g("rev-parse", "HEAD").trim();
  const p = await gitGo("/api/git/commit", { dir: r.d, message: "merge", files: ["a.txt"] });
  assert.equal(p.status, 409);
  assert.equal(p.body.error, "merge_partial");
  assert.match(p.body.message, /合并还没提交/);
  assert.equal(r.g("rev-parse", "HEAD").trim(), head0);
});

test("S.2 冲突检查也覆盖不带 files 的旧请求", async () => {
  const r = repo("s2c");
  fs.writeFileSync(path.join(r.d, "a.txt"), "base\n");
  r.g("add", "a.txt"); r.g("commit", "-qm", "base");
  const main = r.g("rev-parse", "--abbrev-ref", "HEAD").trim();
  r.g("checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(r.d, "a.txt"), "side\n"); r.g("commit", "-qam", "side");
  r.g("checkout", "-q", main);
  fs.writeFileSync(path.join(r.d, "a.txt"), "main\n"); r.g("commit", "-qam", "main");
  try { r.g("merge", "side"); } catch {}
  const bad = await gitGo("/api/git/commit", { dir: r.d, message: "m" });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "conflict");
});

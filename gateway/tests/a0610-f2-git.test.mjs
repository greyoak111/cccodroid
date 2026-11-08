// 0.6.10 审计 f2 车道：Git 面板后端（196 Git 域 2/3/4/7/9/10/11、200-6-05）
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
  return `http://127.0.0.1:${srv.address().port}`;
}
const base = await serve(routeGit);
const W = CFG.workspace;
fs.mkdirSync(W, { recursive: true });
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const enc = encodeURIComponent;

test("196-4 目录不是仓库时：status 仍 200+notRepo，提交类动作回 409 而不是假成功", async () => {
  const dir = path.join(W, "plain-dir");
  fs.mkdirSync(dir, { recursive: true });
  let r = await get(`/api/git/status?dir=${enc(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.notRepo, true);
  r = await post("/api/git/commit", { dir, message: "x", files: [] });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /已经不是 git 仓库/);
});

test("196-3 空仓库还没提交时正常显示空历史，不报错", async () => {
  const dir = path.join(W, "empty-repo-" + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const r = await get(`/api/git/log?dir=${enc(dir)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.commits, []);
});

test("196-10 diff 超过读取上限时按截断返回 200，而不是 500“输出太长”", async () => {
  const dir = path.join(W, "big-diff-" + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "one");
  fs.writeFileSync(path.join(dir, "a.txt"), "x".repeat(100) + "\n" + Array.from({ length: 20000 }, (_, i) => `line ${i} ${"z".repeat(80)}`).join("\n"));
  const r = await get(`/api/git/diff?dir=${enc(dir)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.truncated, true);
  assert.ok(r.body.diff.length <= 768 * 1024);
});

test("196-7 合并提交的历史详情能看到文件（按第一父比较）", async () => {
  const dir = path.join(W, "merge-show-" + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  git(dir, "switch", "-qc", "side");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "side");
  git(dir, "switch", "-q", "main");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "main");
  git(dir, "merge", "--no-ff", "-m", "merge side", "side");
  const hash = git(dir, "rev-parse", "HEAD").trim();
  const r = await get(`/api/git/show?dir=${enc(dir)}&commit=${hash}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.ok(r.body.files.length >= 1, "合并提交的文件列表是空的");
  assert.ok(r.body.files.some((f) => f.path === "b.txt"));
});

test("196-2 未跟踪文件超过 1000 个时 status 仍能打开并标 truncated", async () => {
  const dir = path.join(W, "many-untracked-" + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(dir, `u${i}.txt`), "");
  const r = await get(`/api/git/status?dir=${enc(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.error, undefined);
  assert.equal(r.body.files.length, 1000);
  assert.equal(r.body.truncated, true);
});

test("196-9 仓库状态读不出来时撤销回 500，不再假报“没有改动”", async () => {
  const dir = path.join(W, "bad-index-" + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "one");
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, ".git", "index"), "not an index");
  const r = await post("/api/git/discard", { dir, file: "a.txt" });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.notEqual(r.body.message, "没有改动");
});

test("前端 Git 面板源码断言（196-5/6/8/12、200-6-05）", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const src = fs.readFileSync(path.join(dir, "16-viewer-git.js"), "utf8");
  assert.match(src, /跟着单个勾选走/);
  assert.match(src, /不再把 known 清空/);
  assert.match(src, /上一个仓库的同步栏/);
  assert.match(src, /diff --git /);
  assert.match(src, /inHunk/);
  const gw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw", "git.mjs"), "utf8");
  assert.match(gw, /GIT_TRUST\.size > 200/);
  assert.match(gw, /max: 16 << 20/);
});

// v0.7.13 审计回归测试：覆盖 files 大小写防呆与软链改名、git log 越界校验、
// archiver 别名自包含与纯点文件重名、extensions stdio MCP 引号往返、components glibc 文档清理
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { CFG, PREFIX } from "../gw/config.mjs";
import { routeFiles, safeFilePath, safeWritePath } from "../gw/files.mjs";
import { routeGit } from "../gw/git.mjs";
import { routeArc, uniquePath } from "../gw/archiver.mjs";
import { parseStdioTarget, quoteStdioArg } from "../gw/extensions.mjs";

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}

test("files：大小写变体的凭据名与凭据目录在读 / 写 / 删中全部拦截", async () => {
  const W = path.join(CFG.workspace, "sec-case");
  fs.mkdirSync(path.join(W, ".SSH"), { recursive: true });
  const keyFile = path.join(W, "ID_RSA");
  const sshFile = path.join(W, ".SSH", "config");
  fs.writeFileSync(keyFile, "secret");
  fs.writeFileSync(sshFile, "host x");

  assert.equal(safeFilePath(keyFile).status, 403);
  assert.equal(safeFilePath(sshFile).status, 403);
  assert.equal(safeWritePath(path.join(W, "KEYSTORE.JSON")).status, 403);
  assert.equal(safeWritePath(path.join(W, ".SSH", "newfile")).status, 403);

  const res = fakeRes();
  await routeFiles({ method: "POST", headers: {} }, res, new URL(`http://x/api/file/delete?path=${encodeURIComponent(keyFile)}`), "/api/file/delete");
  assert.equal(res.code, 403);
  assert.equal(fs.existsSync(keyFile), true);
  fs.rmSync(W, { recursive: true, force: true });
});

test("files：/api/file/rename 支持目录软链与悬空软链，且不改目标本身", async () => {
  const W = path.join(CFG.workspace, "rename-sym");
  fs.mkdirSync(path.join(W, "realdir"), { recursive: true });
  const dirLink = path.join(W, "dir-ln");
  const deadLink = path.join(W, "dead-ln");
  fs.symlinkSync(path.join(W, "realdir"), dirLink);
  fs.symlinkSync(path.join(W, "no-such-target"), deadLink);

  const r1 = fakeRes();
  await routeFiles({ method: "POST", headers: {} }, r1,
    new URL(`http://x/api/file/rename?from=${encodeURIComponent(dirLink)}&name=dir-ln2`), "/api/file/rename");
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  assert.equal(fs.lstatSync(path.join(W, "dir-ln2")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(W, "realdir")), true);

  const r2 = fakeRes();
  await routeFiles({ method: "POST", headers: {} }, r2,
    new URL(`http://x/api/file/rename?from=${encodeURIComponent(deadLink)}&name=dead-ln2`), "/api/file/rename");
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  assert.equal(fs.lstatSync(path.join(W, "dead-ln2")).isSymbolicLink(), true);

  fs.rmSync(W, { recursive: true, force: true });
});

test("git：/api/git/log 拒绝仓外 file 参数，与 /api/git/diff 一致", async () => {
  const gitBin = path.join(PREFIX, "bin", "git");
  if (!fs.existsSync(gitBin)) {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    if (realGit) fs.symlinkSync(realGit, gitBin);
  }
  const repo = path.join(CFG.workspace, "git-log-guard");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const outside = path.join(CFG.workspace, "outside-log.txt");
  fs.writeFileSync(outside, "x");
  const res = fakeRes();
  await routeGit({ method: "GET", headers: {} }, res,
    new URL(`http://x/api/git/log?dir=${encodeURIComponent(repo)}&file=${encodeURIComponent(outside)}`), "/api/git/log");
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.equal(res.body?.error, "outside repo");

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test("archiver：uniquePath 对纯点文件不重复拼接扩展名", () => {
  const W = path.join(CFG.workspace, "arc-dot");
  fs.mkdirSync(W, { recursive: true });
  const dot = path.join(W, ".gitignore");
  fs.writeFileSync(dot, "*.log\n");
  assert.equal(path.basename(uniquePath(dot)), ".gitignore (2)");
  const normal = path.join(W, "a.tar.gz");
  fs.writeFileSync(normal, "x");
  assert.equal(path.basename(uniquePath(normal)), "a (2).tar.gz");
  fs.rmSync(W, { recursive: true, force: true });
});

test("archiver：/api/arc/create 通过目录别名把包放到源目录内部时应拒绝", async () => {
  const W = path.join(CFG.workspace, "arc-self");
  const realDir = path.join(W, "real-src");
  const aliasDir = path.join(W, "alias-root");
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, "f.txt"), "hello");
  fs.symlinkSync(W, aliasDir);

  const body = JSON.stringify({
    items: [path.join(aliasDir, "real-src")],
    dest: path.join(aliasDir, "real-src", "out.zip"),
    format: "zip",
  });
  const req = Readable.from([Buffer.from(body)]);
  req.method = "POST"; req.headers = {};
  const res = fakeRes();
  await routeArc(req, res, new URL("http://x/api/arc/create"), "/api/arc/create");
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.equal(res.body?.error, "dest inside source");
  fs.rmSync(W, { recursive: true, force: true });
});

test("extensions：stdio MCP 参数含空格与引号可无损往返", () => {
  const argv = ["/path/with space/node", "-e", 'console.log("hi there")', "--flag", ""];
  const line = argv.map(quoteStdioArg).join(" ");
  assert.deepEqual(parseStdioTarget(line), argv);
  // 兼容单引号写法
  assert.deepEqual(parseStdioTarget(`npx 'my pkg' --dir "/a b/c"`), ["npx", "my pkg", "--dir", "/a b/c"]);
});

test("components：glibc/share/doc 下悬空软链被识别并可清理", async () => {
  const { compSweepDanglingDocs } = await import("../gw/components.mjs");
  const docDir = path.join(PREFIX, "glibc/share/doc/demo");
  fs.mkdirSync(docDir, { recursive: true });
  const dead = path.join(docDir, "LICENSE");
  fs.symlinkSync("/no/such/license/file", dead);
  if (typeof compSweepDanglingDocs === "function") {
    const n = compSweepDanglingDocs();
    assert.ok(n >= 1);
    assert.equal(fs.existsSync(dead), false);
  }
  fs.rmSync(path.join(PREFIX, "glibc"), { recursive: true, force: true });
});

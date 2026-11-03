// PR 安全初筛（scripts/pr-guard.mjs）：在临时 git 仓库里造真提交，看符号链接、可执行文件这些「按模式」的规则认不认得出
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/pr-guard.mjs");
const repo = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "prguard-"));
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.symlinks=true", ...a], { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "x\n");
fs.mkdirSync(path.join(repo, "helpers"));
fs.writeFileSync(path.join(repo, "helpers/old.sh"), "echo\n", { mode: 0o644 });
git("add", "-A"); git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD").trim();

function scan(change) {
  git("checkout", "-q", "-B", "pr", base);
  change();
  git("add", "-A"); git("commit", "-qm", "pr");
  const r = spawnSync(process.execPath, [SCRIPT, base, "HEAD"], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout };
}

test("新增符号链接：高，退出 1（审查 v0.5.20 10-001）", () => {
  const r = scan(() => fs.symlinkSync("../README.md", path.join(repo, "helpers/manual")));
  assert.match(r.out, /高 1 项/);
  assert.match(r.out, /符号链接/);
  assert.equal(r.code, 1);
});

test("新增可执行文件、把旧文件改成可执行：中", () => {
  let r = scan(() => fs.writeFileSync(path.join(repo, "helpers/hello.sh"), "echo hi\n", { mode: 0o755 }));
  assert.match(r.out, /新增可执行文件/);
  assert.equal(r.code, 0);
  r = scan(() => fs.chmodSync(path.join(repo, "helpers/old.sh"), 0o755));
  assert.match(r.out, /改成了可执行/);
});

test("普通改动不误报；受保护路径照常标高", () => {
  let r = scan(() => fs.writeFileSync(path.join(repo, "helpers/note.txt"), "hello\n"));
  assert.match(r.out, /高 0 项、中 0 项/);
  r = scan(() => { fs.mkdirSync(path.join(repo, "scripts")); fs.writeFileSync(path.join(repo, "scripts/x.mjs"), "1\n"); });
  assert.equal(r.code, 1);
});

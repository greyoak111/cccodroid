// 发版脚本续跑（scripts/ship.mjs）：上次 verify 之后换了包 / 提交，--publish 续跑必须在 push 之前停下（审查 v0.5.20 10-002）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/ship.mjs");
const VER = "9.9.9";

// 合成的仓库：只有脚本、两个假包和上次跑到 verify 的状态；没有 origin，真走到 push 也推不出去
function setup() {
  const root = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "ship-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8" }).trim();
  fs.mkdirSync(path.join(root, "scripts")); fs.mkdirSync(path.join(root, "dist"));
  fs.copyFileSync(SRC, path.join(root, "scripts/ship.mjs"));
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "base");
  const apk = path.join(root, "dist/cccodroid.apk"), apk36 = path.join(root, "dist/cccodroid-36.apk");
  fs.writeFileSync(apk, "A"); fs.writeFileSync(apk36, "B");
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "ship-home-")), w = path.join(home, ".work/ship", VER);
  fs.mkdirSync(w, { recursive: true });
  const at = new Date().toISOString(), done = {};
  for (const s of ["preflight", "bump", "changelog", "commit", "build", "verify"]) done[s] = at;
  fs.writeFileSync(path.join(w, "state.json"), JSON.stringify({ ver: VER, done, head: git("rev-parse", "HEAD"), sha: sha(apk), size: 1, sha36: sha(apk36), size36: 1 }));
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts/ship.mjs"), VER, "--publish"], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } });
  const state = () => JSON.parse(fs.readFileSync(path.join(w, "state.json"), "utf8"));
  return { root, git, apk, apk36, run, state };
}

test("包换了：push 之前停下，verify 作废", () => {
  const t = setup();
  fs.writeFileSync(t.apk, "X");
  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /push 之前核对：cccodroid\.apk 变了/);
  assert.equal(t.state().done.verify, undefined);
});

test("36 包换了、提交变了：同样停下", () => {
  let t = setup();
  fs.writeFileSync(t.apk36, "Y");
  assert.match(t.run().stderr, /cccodroid-36\.apk 变了/);
  t = setup();
  fs.writeFileSync(path.join(t.root, "x.txt"), "1"); t.git("add", "-A"); t.git("commit", "-qm", "later");
  assert.match(t.run().stderr, /提交变了/);
});

test("对照：包和提交都没变，照常走到 push", () => {
  const t = setup();
  const r = t.run();
  assert.doesNotMatch(r.stderr, /之前核对/);
  assert.match(r.stdout + r.stderr, /▸ push/);
});

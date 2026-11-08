// git safe.directory 只信任登记过的项目目录（gw/gitsafe.mjs，0.6.9 审计 P1-10）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG, PREFIX } from "../gw/config.mjs";
import { syncGitSafe } from "../gw/gitsafe.mjs";

const gc = path.join(CFG.home, ".gitconfig");
const safeDirs = () => { try { return execFileSync("git", ["config", "--file", gc, "--get-all", "safe.directory"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };
const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();

test("旧版写的 directory = * 去掉，用户自己的配置原样留着；登记的项目目录（含子目录）列进去", { skip: (!PREFIX || !hasGit) && "要前缀布局和 git" }, () => {
  const saved = fs.existsSync(gc) ? fs.readFileSync(gc, "utf8") : null;
  try {
    fs.writeFileSync(gc, '[user]\n\tname = me\n[safe]\n\tdirectory = *\n[credential "https://github.com"]\n\thelper = x\n');
    syncGitSafe(["/storage/emulated/0/proj", "/sdcard/a/", "/bad\npath", 'q"x']);
    assert.deepEqual(safeDirs(), ["/storage/emulated/0/proj", "/storage/emulated/0/proj/*", "/sdcard/a", "/sdcard/a/*"]);
    const txt = fs.readFileSync(gc, "utf8");
    assert.match(txt, /name = me/);
    assert.match(txt, /helper = x/);
    // 再同步一次：托管块整个换掉，不重复堆
    syncGitSafe(["/sdcard/b"]);
    assert.deepEqual(safeDirs(), ["/sdcard/b", "/sdcard/b/*"]);
    syncGitSafe([]);
    assert.deepEqual(safeDirs(), []);
    assert.match(fs.readFileSync(gc, "utf8"), /name = me/);
  } finally { if (saved == null) fs.rmSync(gc, { force: true }); else fs.writeFileSync(gc, saved); }
});

// 网关在跑时核对 files/app（gw/appfiles.mjs）：小目录被改写回、多出来的删掉、界面文件对不上就不发并要求重启
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { appGuard } from "../gw/appfiles.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
function mkRoot(name, files) {
  const root = path.join(CFG.workspace, name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, { mode: rel.startsWith("bin/") ? 0o700 : 0o600 });
  }
  fs.writeFileSync(path.join(root, "FILES"), Object.entries(files).map(([r, b]) => sha(Buffer.from(b)) + " " + r).join("\n") + "\n");
  return root;
}
const FILES = {
  "TOOLS.md": "# tools\n", "archive/spec.zh.md": "规范\n", "bin/claude": "#!/bin/sh\nexec real \"$@\"\n",
  "pre/pkg": "#!/bin/sh\n", "web/index.html": "<html></html>\n", "web/app/01-a.js": "let a=1;\n", "gw/x.mjs": "export {};\n",
};

test("没有 FILES（开发时直接跑仓库）：不启用", () => {
  const root = mkRoot("apf-dev", { "TOOLS.md": "x" });
  fs.rmSync(path.join(root, "FILES"));
  assert.equal(appGuard(root), null);
});

test("小目录被改：check 写回原样，多出来的删掉，可执行位保留", () => {
  const root = mkRoot("apf-snap", FILES), why = [];
  const g = appGuard(root, { onRestart: (w) => why.push(w) });
  assert.equal(g.text("TOOLS.md"), "# tools\n");
  assert.deepEqual(g.check(), []);
  fs.appendFileSync(path.join(root, "TOOLS.md"), "执行核 · 常驻层\n");
  fs.appendFileSync(path.join(root, "archive/spec.zh.md"), "执行核\n");
  fs.rmSync(path.join(root, "bin/claude"));
  fs.symlinkSync("/system/bin/sh", path.join(root, "bin/claude"));
  fs.writeFileSync(path.join(root, "pre/git"), "#!/bin/sh\n");
  assert.equal(g.text("TOOLS.md"), "# tools\n", "系统提示用内存里的那份");
  const fixed = g.check();
  assert.ok(fixed.includes("TOOLS.md") && fixed.includes("archive/spec.zh.md") && fixed.includes("bin/claude"), fixed.join());
  assert.ok(fixed.some((f) => f.startsWith("pre/git")));
  assert.equal(fs.readFileSync(path.join(root, "TOOLS.md"), "utf8"), "# tools\n");
  assert.equal(fs.readFileSync(path.join(root, "archive/spec.zh.md"), "utf8"), "规范\n");
  const st = fs.lstatSync(path.join(root, "bin/claude"));
  assert.ok(st.isFile() && (st.mode & 0o100), "写回成普通文件且可执行");
  assert.ok(!fs.existsSync(path.join(root, "pre/git")));
  // 同样大小、内容不同、mtime 也改回去（touch -r）也认得出来：ctime 改不回去
  const f = path.join(root, "pre/pkg"), old = fs.statSync(f);
  fs.writeFileSync(f + ".ref", ""); execFileSync("touch", ["-r", f, f + ".ref"]); fs.writeFileSync(f, "#!/bin/xx\n"); execFileSync("touch", ["-r", f + ".ref", f]); fs.rmSync(f + ".ref");
  assert.equal(fs.statSync(f).mtimeMs, old.mtimeMs);
  assert.deepEqual(g.check(), ["pre/pkg"]);
  assert.deepEqual(why, [], "小目录写回了，不用重启");
});

test("界面文件：对得上才发，对不上要求重启", () => {
  const root = mkRoot("apf-web", FILES), why = [];
  const g = appGuard(root, { onRestart: (w) => why.push(w) });
  const f = path.join(root, "web/app/01-a.js");
  assert.equal(g.served("web/app/01-a.js", fs.readFileSync(f), fs.statSync(f)), true);
  fs.writeFileSync(f, "autoAllow();\n");
  assert.equal(g.served("web/app/01-a.js", fs.readFileSync(f), fs.statSync(f)), false);
  assert.equal(g.served("web/evil.html", Buffer.from("x"), null), false, "安装包里没有的不发");
  assert.ok(why.length >= 2 && g.restartWanted);
});

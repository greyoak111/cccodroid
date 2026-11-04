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
  // 网关源码也纳入快照：运行中被改的 gw/ 写回，多出来的删掉
  fs.writeFileSync(path.join(root, "gw/x.mjs"), "export const patched = 1;\n");
  assert.deepEqual(g.check(), ["gw/x.mjs"]);
  assert.equal(fs.readFileSync(path.join(root, "gw/x.mjs"), "utf8"), "export {};\n");
  fs.writeFileSync(path.join(root, "gw/evil.mjs"), "x");
  assert.deepEqual(g.check(), ["gw/evil.mjs（多出来的）"]);
  assert.deepEqual(why, [], "网关源码写回了，不用重启");
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

test("复核补：lib 也写回；清单里的子目录不当多余删；分段清单", () => {
  const root = mkRoot("apf-lib", { ...FILES, "lib/seccomp-enosys.so": "ELF\n", "archive/sub/x.md": "x\n", "web/app/02-b.js": "let b=2;\n" });
  const g = appGuard(root);
  fs.writeFileSync(path.join(root, "lib/seccomp-enosys.so"), "EVIL\n");
  fs.writeFileSync(path.join(root, "lib/evil.so"), "x");
  const fixed = g.check();
  assert.ok(fixed.includes("lib/seccomp-enosys.so") && fixed.some((f) => f.startsWith("lib/evil.so")), fixed.join());
  assert.equal(fs.readFileSync(path.join(root, "lib/seccomp-enosys.so"), "utf8"), "ELF\n");
  assert.ok(fs.existsSync(path.join(root, "archive/sub/x.md")), "清单里的子目录留着");
  assert.deepEqual(g.check(), [], "不来回折腾");
  assert.deepEqual(g.list("web/app/"), ["01-a.js", "02-b.js"]);
  assert.ok(g.has("web/index.html") && !g.has("web/x.html"));
});

test("加载钩子用的 code()：快照里的给内存那份，清单里的现读现核，对不上、清单外的给 null", () => {
  const root = mkRoot("apf-code", FILES);
  const g = appGuard(root);
  fs.writeFileSync(path.join(root, "gw/x.mjs"), "export const evil = 1;\n");
  assert.equal(g.code("gw/x.mjs").toString(), "export {};\n", "gw/ 在快照里：盘上被改也给核过的那份");
  assert.equal(g.code("web/index.html").toString(), "<html></html>\n");
  fs.writeFileSync(path.join(root, "web/index.html"), "<script>evil()</script>");
  assert.equal(g.code("web/index.html"), null);
  fs.writeFileSync(path.join(root, "gw/new.mjs"), "x");
  assert.equal(g.code("gw/new.mjs"), null, "安装包里没有的");
});

test("应用交来了清单哈希：FILES 读不到、或者被换了，不退回「不核」，报给 onBadList；对得上照常启用", () => {
  const root = mkRoot("apf-expect", FILES);
  const good = sha(fs.readFileSync(path.join(root, "FILES")));
  const bad = [];
  assert.ok(appGuard(root, { expect: good, onBadList: (w) => bad.push(w) }));
  assert.deepEqual(bad, []);
  fs.appendFileSync(path.join(root, "FILES"), sha(Buffer.from("x")) + " gw/evil.mjs\n");
  assert.equal(appGuard(root, { expect: good, onBadList: (w) => bad.push(w) }), null);
  fs.rmSync(path.join(root, "FILES"));
  assert.equal(appGuard(root, { expect: good, onBadList: (w) => bad.push(w) }), null);
  assert.deepEqual(bad, ["FILES（和安装包对不上）", "FILES（读不到）"]);
});

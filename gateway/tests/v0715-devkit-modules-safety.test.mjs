// v0.7.15 发版前修补回归：
// 1. 大模块安装/卸载写看门狗心跳、分批让出事件循环，完成后清心跳
// 2. 在线安装含 lib/guile 的模块后刷新 .go mtime（严格新于 .scm）
// 3. 卸载模块时，若共享运行库仍被已装组件或 pkg 包依赖，保留该共享层
// 4. 共享运行库名称消歧（08-extensions.js / devkit.mjs）
// 5. devkit.mjs unxzToFile 退出码竞态修复 + devkit.mjs / pkg.mjs GBMB phar 保护（CLI 绝对路径包装、库原样保留）
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";
import { _modForTest } from "../gw/modules.mjs";

const FILES = path.dirname(PREFIX);
const DK = path.join(PREFIX, "libexec/devkit");
const STAGE = path.join(FILES, "devkit-stage");
const COMP_DIR = path.join(FILES, "components");
const RUNS = path.join(COMP_DIR, ".runs");
const PKG_DIR = path.join(FILES, "pkg");
const OK = path.join(PREFIX, ".devkit-ok");
const savedOk = fs.existsSync(OK) ? fs.readFileSync(OK, "utf8") : null;
const TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "v0715-mod-"));

function linkBin(name, target) {
  if (!target) return;
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  const p = path.join(PREFIX, "bin", name);
  if (!fs.existsSync(p)) fs.symlinkSync(target, p);
}
if (TAR) linkBin("tar", TAR);

after(() => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(path.join(DK, "modules"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "share", "v0715-bulk"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "lib", "guile"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "share", "guile"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "bin", "v0715-and"), { force: true });
  fs.rmSync(path.join(PREFIX, "bin", "v0715-jdk"), { force: true });
  fs.rmSync(path.join(COMP_DIR, "comp-jdk-test.json"), { force: true });
  fs.rmSync(path.join(PKG_DIR, "installed.json"), { force: true });
  fs.rmSync(path.join(STAGE, "modhb"), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, "lib-guile"), { recursive: true, force: true });
  fs.rmSync(path.join(RUNS, "mod-modhb.installing"), { force: true });
  fs.rmSync(path.join(RUNS, "mod-lib-guile.installing"), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  if (savedOk == null) fs.rmSync(OK, { force: true });
  else fs.writeFileSync(OK, savedOk);
});

function buildModTar(id, dirRel, entries) {
  const root = path.join(TMP, id);
  fs.rmSync(root, { recursive: true, force: true });
  const manLines = [];
  const fileLines = [];
  for (const [rel, content, mtimeSec] of entries) {
    const abs = path.join(root, "usr", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fs.writeFileSync(abs, buf);
    if (mtimeSec) fs.utimesSync(abs, mtimeSec, mtimeSec);
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    manLines.push(`${h} ${buf.length} ${rel}`);
    fileLines.push(rel);
  }
  const modDir = path.join(root, "usr", dirRel);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "MANIFEST"), manLines.join("\n") + "\n");
  fs.writeFileSync(path.join(modDir, "FILES"), fileLines.join("\n") + "\n");
  const gzPath = path.join(TMP, `${id}.tar.gz`);
  const r = spawnSync(TAR, ["-czf", gzPath, "-C", root, "usr"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const gz = fs.readFileSync(gzPath);
  const sha = crypto.createHash("sha256").update(gz).digest("hex");
  return { gz, sha };
}

test("大模块安装与卸载：写入看门狗心跳并分批让出，结束后清理心跳", { skip: TAR ? false : "无 tar" }, async () => {
  const id = "modhb", dirRel = `libexec/devkit/modules/${id}`;
  const entries = [];
  for (let i = 0; i < 320; i++) entries.push([`share/v0715-bulk/f-${i}.txt`, `payload-${i}`]);
  const { gz, sha } = buildModTar(id, dirRel, entries);
  fs.mkdirSync(DK, { recursive: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk-v0715", base: "https://example.invalid/download/v1/" }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({
    snapshot: "s-v0715",
    modules: [
      { id: "base", kind: "base", dir: "libexec/devkit" },
      { id, kind: "module", dir: dirRel, deps: ["base"], installed: 65536, gz: { file: `${id}.tar.gz`, bytes: gz.length, sha256: sha } },
    ],
  }));
  const stageGz = path.join(STAGE, `${id}-${sha.slice(0, 12)}.tar.gz`);
  fs.writeFileSync(stageGz, gz);

  const mark = path.join(RUNS, `mod-${id}.installing`);
  let sawInstallMove = false;
  const r = await _modForTest.modInstall(id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = _modForTest.MOD_JOBS.get(id);
  const deadline = Date.now() + 15000;
  while (!(job && job.finished) && Date.now() < deadline) {
    if (fs.existsSync(mark)) {
      try {
        const j = JSON.parse(fs.readFileSync(mark, "utf8"));
        if (j.phase === "move" && j.moved >= 256 && j.at > 0 && j.gw === process.pid) sawInstallMove = true;
      } catch {}
    }
    await new Promise((ok) => setImmediate(ok));
  }
  await job.done;
  assert.ok(job && job.finished && !job.error, `安装失败: ${job && job.error}`);
  assert.equal(sawInstallMove, true, "安装 >256 文件期间应写出 move 心跳");
  assert.equal(fs.existsSync(mark), false, "安装完成后心跳必须删掉");
  assert.ok(fs.existsSync(path.join(PREFIX, dirRel, ".ok")), "安装完成后应写 .ok");

  // 卸载同样产生心跳并在结束后清理
  let sawRemoveMove = false;
  let rmDone = false;
  const rmPromise = _modForTest.modRemove(id).finally(() => { rmDone = true; });
  const rmDeadline = Date.now() + 15000;
  while (!rmDone && Date.now() < rmDeadline) {
    if (fs.existsSync(mark)) {
      try {
        const j = JSON.parse(fs.readFileSync(mark, "utf8"));
        if (j.phase === "move" && j.moved >= 256) sawRemoveMove = true;
      } catch {}
    }
    await new Promise((ok) => setImmediate(ok));
  }
  const rm = await rmPromise;
  assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.equal(sawRemoveMove, true, "卸载 >256 文件期间应写出 move 心跳");
  assert.equal(fs.existsSync(mark), false, "卸载完成后心跳必须删掉");
  assert.equal(fs.existsSync(path.join(PREFIX, "share/v0715-bulk/f-0.txt")), false);
});

test("在线安装 lib-guile 后刷新 .go 缓存时间戳，严格晚于 .scm 源码", { skip: TAR ? false : "无 tar" }, async () => {
  const id = "lib-guile", dirRel = `libexec/devkit/modules/${id}`;
  // 故意让 .go 比 .scm 旧 10 秒，模拟 tar 包时间戳顺序问题
  const scmTime = Math.floor(Date.now() / 1000) - 5;
  const goTime = scmTime - 10;
  const { gz, sha } = buildModTar(id, dirRel, [
    ["share/guile/3.0/ice-9/boot-9.scm", "(define x 1)\n", scmTime],
    ["lib/guile/3.0/ccache/ice-9/boot-9.go", "ELF-go-cache", goTime],
  ]);
  fs.mkdirSync(DK, { recursive: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk-v0715", base: "https://example.invalid/download/v1/" }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({
    snapshot: "s-v0715",
    modules: [
      { id: "base", kind: "base", dir: "libexec/devkit" },
      { id, kind: "shared", dir: dirRel, deps: ["base"], installed: 4096, gz: { file: `${id}.tar.gz`, bytes: gz.length, sha256: sha } },
    ],
  }));
  fs.writeFileSync(path.join(STAGE, `${id}-${sha.slice(0, 12)}.tar.gz`), gz);

  const r = await _modForTest.modInstall(id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = _modForTest.MOD_JOBS.get(id);
  if (job) await job.done;
  assert.ok(job && job.finished && !job.error, `安装失败: ${job && job.error}`);

  const scmSt = fs.statSync(path.join(PREFIX, "share/guile/3.0/ice-9/boot-9.scm"));
  const goSt = fs.statSync(path.join(PREFIX, "lib/guile/3.0/ccache/ice-9/boot-9.go"));
  assert.ok(goSt.mtimeMs > scmSt.mtimeMs, `.go (${goSt.mtimeMs}) 必须严格晚于 .scm (${scmSt.mtimeMs})`);
});

test("modRemove 卸载模块时：共享运行库仍被已装组件或 pkg 依赖则保留，无依赖时一起卸载", async () => {
  fs.mkdirSync(DK, { recursive: true });
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.mkdirSync(PKG_DIR, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk-v0715" }));
  const setup = () => {
    fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({
      snapshot: "s-v0715",
      modules: [
        { id: "base", kind: "base", dir: "libexec/devkit" },
        { id: "lib-openjdk-21", kind: "shared", dir: "libexec/devkit/modules/lib-openjdk-21", deps: ["base"],
          packages: [{ name: "openjdk-21", version: "21" }] },
        { id: "android", kind: "module", dir: "libexec/devkit/modules/android", deps: ["base", "lib-openjdk-21"],
          packages: [{ name: "apksigner", version: "1" }] },
      ],
    }));
    for (const [id, bin] of [["lib-openjdk-21", "bin/v0715-jdk"], ["android", "bin/v0715-and"]]) {
      const d = path.join(DK, "modules", id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "MANIFEST"), `h 1 ${bin}\n`);
      fs.writeFileSync(path.join(d, "FILES"), `${bin}\n`);
      fs.writeFileSync(path.join(d, ".ok"), "{}\n");
      fs.mkdirSync(path.dirname(path.join(PREFIX, bin)), { recursive: true });
      fs.writeFileSync(path.join(PREFIX, bin), "x");
    }
  };

  // 场景 A：组件依赖 openjdk-21 → 卸 android 时必须保留 lib-openjdk-21
  setup();
  fs.writeFileSync(path.join(COMP_DIR, "comp-jdk-test.json"), JSON.stringify({
    id: "comp-jdk-test", state: "ok", base: "dk-v0715", files: [], shared: [], baseDeps: ["openjdk-21"],
  }));
  const r1 = await _modForTest.modRemove("android");
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(r1.removed, ["android"]);
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/v0715-jdk")), "被组件依赖的共享库文件不能删");
  assert.ok(fs.existsSync(path.join(DK, "modules/lib-openjdk-21/.ok")), "共享库 .ok 应保留");
  fs.rmSync(path.join(COMP_DIR, "comp-jdk-test.json"), { force: true });

  // 场景 B：pkg 依赖 openjdk-21 → 卸 android 时同样保留 lib-openjdk-21
  setup();
  fs.writeFileSync(path.join(PKG_DIR, "installed.json"), JSON.stringify({
    pkgs: { gradle: { deps: "openjdk-21 (>= 21)", files: [] } },
  }));
  const r2 = await _modForTest.modRemove("android");
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(r2.removed, ["android"]);
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/v0715-jdk")), "被 pkg 依赖的共享库文件不能删");
  fs.rmSync(path.join(PKG_DIR, "installed.json"), { force: true });

  // 场景 C：无任何组件或 pkg 依赖 → 卸 android 时一并卸掉 lib-openjdk-21
  setup();
  const r3 = await _modForTest.modRemove("android");
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.deepEqual(r3.removed, ["android", "lib-openjdk-21"]);
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/v0715-jdk")), false, "无依赖的共享库应一并卸载");
});

test("源码回归：共享运行库消歧 + devkit unxzToFile 竞态修复 + devkit/pkg GBMB phar 保护", () => {
  const extSrc = fs.readFileSync(new URL("../web/app/08-extensions.js", import.meta.url), "utf8");
  assert.match(extSrc, /const modLabel = \(m\) =>/, "08-extensions.js 应通过 modLabel 消歧共享运行库");
  assert.match(extSrc, /m\.kind === "shared" && \/\^lib-\/\.test\(m\.id\)/);

  const dkSrc = fs.readFileSync(new URL("../../devkit/devkit.mjs", import.meta.url), "utf8");
  assert.match(dkSrc, /let done = false, outDone = false, exited = false/, "unxzToFile 必须同时等待 out finish 与 child exit");
  assert.match(dkSrc, /if \(done \|\| !outDone \|\| !exited\) return;/);
  assert.match(dkSrc, /exec \\"" \+ R\.to \+ "files\/usr\/bin\/php\\"/, "devkit phar 包装脚本必须使用绝对路径 php");
  assert.match(dkSrc, /!clean\.endsWith\("\.phar"\)/, "devkit phar 保护必须区分库 .phar 与 CLI phar");
  assert.match(dkSrc, /共享运行库（\$\{sharedTag\}）/, "devkit modules.json 默认共享层名应带后缀");

  const pkgSrc = fs.readFileSync(new URL("../../android/assets/bin/pkg.mjs", import.meta.url), "utf8");
  assert.match(pkgSrc, /subarray\(-4\)\.toString\("latin1"\) === "GBMB"/, "pkg.mjs 必须保护 GBMB 签名 phar");
  assert.match(pkgSrc, /exec "\$\{TARGET\}files\/usr\/bin\/php"/, "pkg.mjs phar 包装脚本必须使用绝对路径 php");
  assert.match(pkgSrc, /!r\.endsWith\("\.phar"\)/, "pkg.mjs 必须保留库 .phar 原样");
});

// 第 2 波运行时安全与 SDK36 回归测试（A-01 / A-02 / A-03 / A-04 / A-05）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { _setSealed } from "../gw/edition.mjs";
import { sealPrepare, sealCleanup } from "../gw/seal.mjs";
import { projectRisks } from "../gw/projtrust.mjs";
import { safeFilePath } from "../gw/files.mjs";
import { archiveList, collectSecretExcludes, mergeInto, startExtract, uniquePath } from "../gw/archiver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";

function makeZip(items) {
  const locals = [], central = [];
  let off = 0;
  for (const it of items) {
    const name = Buffer.from(it.name);
    const data = Buffer.from(it.data ?? "");
    const comp = it.deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(it.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(it.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(items.length, 8); e.writeUInt16LE(items.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

async function waitJob(job) {
  for (let i = 0; i < 400 && job.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return job;
}

// ── A-01: exec-shim.c ───────────────────────────────────────────────────
test("A-01: exec-shim.c 用 newfstatat(79) 核普通文件+执行位，绕开 SDK36 W^X faccessat(X_OK) 误杀", () => {
  const src = fs.readFileSync(path.join(REPO, "android/native/exec-shim.c"), "utf8");
  assert.match(src, /#define\s+NR_newfstatat\s+79\b/);
  const fn = src.slice(src.indexOf("static int executable("), src.indexOf("static int executable(") + 400);
  assert.match(fn, /sc\(NR_newfstatat,\s*AT_FDCWD/);
  assert.match(fn, /\(mode\s*&\s*0170000u\)\s*==\s*0100000u/);
  assert.match(fn, /\(mode\s*&\s*0111u\)\s*!=\s*0/);
  assert.doesNotMatch(fn, /NR_faccessat/);
});

// ── A-02: pre/adb (& bin/rg if present) ─────────────────────────────────
test("A-02: pre/adb 改用 [ -f \"$REAL\" ] 不再受 [ -x ] SDK36 W^X 拦截", () => {
  const adbPath = path.join(REPO, "android/assets/pre/adb");
  const src = fs.readFileSync(adbPath, "utf8");
  assert.match(src, /\[\s*-f\s+"\$REAL"\s*\]/);
  assert.doesNotMatch(src, /\[\s*-x\s+"\$REAL"\s*\]/);

  // 缺失真实 adb 时报 127
  const tmpPrefix = path.join(CFG.workspace, "w2-adb-prefix");
  fs.rmSync(tmpPrefix, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpPrefix, "bin"), { recursive: true });
  try {
    const miss = spawnSync(SH, [adbPath, "version"], {
      env: { ...process.env, PREFIX: tmpPrefix },
      encoding: "utf8",
    });
    assert.equal(miss.status, 127);

    // 真实 adb 存在时（即使文件自身未带 +x 位，[ -f ] 仍命中并交 exec 尝试拉起）
    const fakeAdb = path.join(tmpPrefix, "bin/adb");
    fs.writeFileSync(fakeAdb, `#!${SH}\necho FAKE_ADB_OK "$@"\n`, { mode: 0o755 });
    const hit = spawnSync(SH, [adbPath, "devices"], {
      env: { ...process.env, PREFIX: tmpPrefix },
      encoding: "utf8",
    });
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /FAKE_ADB_OK\b.*\bdevices/);
  } finally {
    fs.rmSync(tmpPrefix, { recursive: true, force: true });
  }

  // hachimia 的 bin/rg 若存在，也必须使用 [ -f ]
  const rgPath = path.join(REPO, "android/assets/bin/rg");
  if (fs.existsSync(rgPath)) {
    const rgSrc = fs.readFileSync(rgPath, "utf8");
    assert.doesNotMatch(rgSrc, /\[\s*-x\s+/);
  }
});

// ── A-03: archiver.mjs ──────────────────────────────────────────────────
test("A-03.1: 解压到父目录不可写的已有目标目录（模拟 /storage/emulated/0）在目标内暂存并清理", async () => {
  const root = path.join(CFG.workspace, "w2-arc-ro-parent");
  const roParent = path.join(root, "emulated");
  const dest = path.join(roParent, "0");
  const zfile = path.join(root, "sample.zip");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(zfile, makeZip([{ name: "hello.txt", data: "world", deflate: true }]));
  fs.chmodSync(roParent, 0o555);
  try {
    const j = await waitJob(startExtract(zfile, { dest }));
    assert.equal(j.state, "done", JSON.stringify(j));
    assert.equal(fs.readFileSync(path.join(dest, "hello.txt"), "utf8"), "world");
    const leftovers = fs.readdirSync(dest).filter((n) => n.startsWith(".cc-unpack-"));
    assert.deepEqual(leftovers, [], "暂存目录应清理干净");
  } finally {
    try { fs.chmodSync(roParent, 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-03.2: mergeInto 拒绝软链目标目录，uniquePath 避开悬空软链", () => {
  const root = path.join(CFG.workspace, "w2-arc-merge");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "stage"), { recursive: true });
  fs.mkdirSync(path.join(root, "real-dest"), { recursive: true });
  fs.writeFileSync(path.join(root, "stage/a.txt"), "1");
  fs.symlinkSync(path.join(root, "real-dest"), path.join(root, "sym-dest"));
  try {
    assert.throws(() => mergeInto(path.join(root, "stage"), path.join(root, "sym-dest")), /not a folder/);

    // 悬空软链占位：uniquePath 必须改名，不覆盖悬空软链
    const dangling = path.join(root, "real-dest", "dangling.txt");
    fs.symlinkSync(path.join(root, "does-not-exist"), dangling);
    const u = uniquePath(dangling);
    assert.notEqual(u, dangling);
    assert.match(path.basename(u), /^dangling \(2\)\.txt$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-03.3: collectSecretExcludes 递归排查源树内目录软链与环，超 maxFiles 抛 413 TOO_MANY_FILES", async () => {
  const root = path.join(CFG.workspace, "w2-arc-secrets");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "pack/inner"), { recursive: true });
  fs.writeFileSync(path.join(root, "pack/inner/id_rsa"), "PRIVATE KEY");
  fs.writeFileSync(path.join(root, "pack/inner/ok.txt"), "ok");
  fs.symlinkSync(path.join(root, "pack/inner"), path.join(root, "pack/link-dir"));
  fs.symlinkSync(path.join(root, "pack"), path.join(root, "pack/inner/cycle"));
  try {
    const ex = await collectSecretExcludes([path.join(root, "pack")]);
    assert.ok(ex.includes("pack/inner/id_rsa"), `应排除真实凭据: ${JSON.stringify(ex)}`);
    assert.ok(ex.includes("pack/link-dir/id_rsa"), `应排除源树内目录软链里的凭据: ${JSON.stringify(ex)}`);
    assert.ok(ex.some((x) => x.endsWith("/cycle")), `应排除环状软链: ${JSON.stringify(ex)}`);

    await assert.rejects(
      () => collectSecretExcludes([path.join(root, "pack")], { maxFiles: 2 }),
      (e) => e && e.status === 413 && e.code === "TOO_MANY_FILES",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-03.4: archiveList 强制 timeoutMs 与 maxOut 上限（超时 ETIMEDOUT / 爆内存 OVERFLOW）", async () => {
  const root = path.join(CFG.workspace, "w2-arc-limits");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const fakeArc = path.join(root, "dummy.7z");
  fs.writeFileSync(fakeArc, "not-a-zip-magic");

  const slowBin = path.join(root, "slow7z");
  const floodBin = path.join(root, "flood7z");
  fs.writeFileSync(slowBin, `#!${SH}\nexec sleep 5\n`, { mode: 0o755 });
  fs.writeFileSync(floodBin, `#!${SH}\nhead -c 65536 /dev/zero | tr '\\0' 'A'\n`, { mode: 0o755 });

  const old7z = process.env.CCAPP_7ZZ;
  try {
    // 若当前平台禁止执行工作区脚本则跳过进程探针
    const probe = spawnSync(floodBin, [], { timeout: 1000 });
    if (probe.error && probe.error.code === "EACCES") return;

    process.env.CCAPP_7ZZ = slowBin;
    await assert.rejects(
      () => archiveList(fakeArc, { timeoutMs: 120 }),
      (e) => e && e.code === "ETIMEDOUT" && e.status === 504,
    );

    // 换文件名避免命中 LISTS 缓存
    const fakeArc2 = path.join(root, "dummy2.7z");
    fs.writeFileSync(fakeArc2, "not-a-zip-magic-2");
    process.env.CCAPP_7ZZ = floodBin;
    await assert.rejects(
      () => archiveList(fakeArc2, { maxOut: 1024 }),
      (e) => e && e.code === "OVERFLOW" && e.status === 413,
    );
  } finally {
    if (old7z === undefined) delete process.env.CCAPP_7ZZ;
    else process.env.CCAPP_7ZZ = old7z;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── A-04: seal.mjs / projtrust.mjs / files.mjs ──────────────────────────
test("A-04.1: seal.mjs 排除插件 .mcp.json/.lsp.json 并清理 plugin.json 的 mcpServers/lspServers", () => {
  const H = (rel) => path.join(CFG.home, rel);
  const proj = H("w2-seal-proj");
  const plugDir = H(".claude/plugins/cache/mkt/evilplug/1.0.0");
  for (const r of [".claude", ".cache/ccapp-seal", "w2-seal-proj"]) fs.rmSync(H(r), { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(plugDir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(plugDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(plugDir, ".mcp.json"), '{"mcpServers":{"x":{"command":"sh"}}}');
  fs.writeFileSync(path.join(plugDir, "sub/.lsp.json"), '{"lspServers":{"y":{"command":"sh"}}}');
  fs.writeFileSync(path.join(plugDir, ".claude-plugin/plugin.json"), JSON.stringify({
    name: "evilplug",
    version: "1.0.0",
    hooks: { SessionStart: [] },
    settings: { a: 1 },
    mcpServers: { bad: { command: "id" } },
    lspServers: { badLsp: { command: "id" } },
  }));
  fs.writeFileSync(path.join(plugDir, "README.md"), "# ok\n");
  fs.mkdirSync(H(".claude/plugins"), { recursive: true });
  fs.writeFileSync(H(".claude/settings.json"), JSON.stringify({ enabledPlugins: { "evilplug@mkt": true } }));
  fs.writeFileSync(H(".claude/plugins/installed_plugins.json"), JSON.stringify({
    plugins: { "evilplug@mkt": [{ scope: "user", installPath: plugDir }] },
  }));

  _setSealed(true);
  try {
    const p = sealPrepare({ cwd: proj, runId: 902 });
    assert.equal(p.block, null);
    const dirs = [];
    for (let i = 0; i < p.args.length; i++) if (p.args[i] === "--plugin-dir") dirs.push(p.args[i + 1]);
    const copied = dirs.find((d) => fs.existsSync(path.join(d, "README.md")));
    assert.ok(copied, "应生成已启用插件的封口副本");
    assert.equal(fs.existsSync(path.join(copied, ".mcp.json")), false, "根目录 .mcp.json 不应拷入");
    assert.equal(fs.existsSync(path.join(copied, "sub/.lsp.json")), false, "深层 .lsp.json 不应拷入");
    const man = JSON.parse(fs.readFileSync(path.join(copied, ".claude-plugin/plugin.json"), "utf8"));
    assert.equal(man.name, "evilplug");
    assert.equal(man.hooks, undefined);
    assert.equal(man.settings, undefined);
    assert.equal(man.mcpServers, undefined);
    assert.equal(man.lspServers, undefined);
  } finally {
    sealCleanup(902);
    for (const r of [".claude", ".cache/ccapp-seal", "w2-seal-proj"]) fs.rmSync(H(r), { recursive: true, force: true });
  }
});

test("A-04.2: projtrust.mjs 覆盖 .claude/commands 钩子扫描且用 O_NOFOLLOW 拒绝软链", () => {
  const dir = path.join(CFG.workspace, "w2-projtrust");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".claude/commands"), { recursive: true });
  const ext = path.join(CFG.workspace, "w2-projtrust-ext.json");
  fs.writeFileSync(ext, JSON.stringify({ env: { EVIL: "1" } }));
  try {
    // 软链 settings.json 应被 O_NOFOLLOW 拒绝（不被当作普通设置文件读入）
    fs.symlinkSync(ext, path.join(dir, ".claude/settings.json"));
    assert.equal(projectRisks(dir), null, "仅存在软链 settings.json 时不应跟随读取");

    // .claude/commands/*.md 带 hooks frontmatter 必须报风险
    fs.writeFileSync(path.join(dir, ".claude/commands/run.md"), "---\nname: run\nhooks:\n  PreToolUse: []\n---\nhello\n");
    const r = projectRisks(dir);
    assert.ok(r && r.risks.some((x) => x.includes(".claude/commands/run.md") && x.includes("hooks")), JSON.stringify(r));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ext, { force: true });
  }
});

test("A-04.3: files.mjs safeFilePath 返回 dev/ino 且 /api/file 复核 inode 一致性", () => {
  const f = path.join(CFG.workspace, "w2-files-ino.txt");
  fs.writeFileSync(f, "hello");
  try {
    const st = fs.statSync(f);
    const r = safeFilePath(f);
    assert.equal(r.error, undefined);
    assert.equal(r.dev, st.dev);
    assert.equal(r.ino, st.ino);
    const src = fs.readFileSync(path.join(REPO, "gateway/gw/files.mjs"), "utf8");
    assert.match(src, /fst\.dev\s*!==\s*r\.dev\s*\|\|\s*fst\.ino\s*!==\s*r\.ino/);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

// ── A-05: Setup Guide & 503 跳转契约 ────────────────────────────────────
test("A-05: openDrawer 透传子页参数，503 与 #wl-setup 直达 provider 页并等待 loadProviders", () => {
  const navSrc = fs.readFileSync(path.join(REPO, "gateway/web/app/13-nav-menus.js"), "utf8");
  const compSrc = fs.readFileSync(path.join(REPO, "gateway/web/app/05-composer.js"), "utf8");
  const flowSrc = fs.readFileSync(path.join(REPO, "gateway/web/app/04-session-flow.js"), "utf8");

  // 13-nav-menus.js: openDrawer(tab, sub) -> openPage(tab, sub)
  const m = /function openDrawer\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/.exec(navSrc);
  assert.ok(m, "应找到 openDrawer 定义");
  const calls = [];
  const box = {
    openPage: (tab, sub) => calls.push([tab, sub]),
  };
  vm.runInNewContext(m[0] + "\nopenDrawer('settings', 'provider');", box);
  assert.deepEqual(calls, [["settings", "provider"]]);

  // 05-composer.js: 503 直达 settings -> provider
  assert.match(compSrc, /e\.status\s*===\s*503[\s\S]{0,80}openDrawer\(\s*["']settings["']\s*,\s*["']provider["']\s*\)/);

  // 04-session-flow.js: Setup Guide 点击直达 provider 且等待 loadProviders 后再操作 set-provider
  const idx = flowSrc.indexOf('openDrawer("settings", "provider")');
  assert.ok(idx >= 0, "04-session-flow.js 应调用 openDrawer('settings', 'provider')");
  const seg = flowSrc.slice(idx, idx + 600);
  assert.match(seg, /loadProviders\s*\(/);
  assert.match(seg, /set-provider/);
});

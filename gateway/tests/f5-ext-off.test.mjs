// F5（11-09）：扩展「停用 / 启用」——技能走 skillOverrides（发行版打包时跳过关掉的）、
// 用户级 MCP 停用 = 定义存进名单再 claude mcp remove，启用 = add-json 加回；组件 / 模块只记名单
import { PATHS, CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _setSealed } from "../gw/edition.mjs";

const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "f5-"));
const cli = path.join(root, "fake-cli.sh"), argLog = path.join(root, "argv.log");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
let exitCode = 0;
const writeCli = () => fs.writeFileSync(cli, `#!${sh}\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argLog}'\nprintf '\\n' >> '${argLog}'\nexit ${exitCode}\n`, { mode: 0o700 });
const prev = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath; PATHS.loader = PATHS.claudeLoader = cli;
const { _extForTest, SKILLS_DIR } = await import("../gw/extensions.mjs");
const { sealPrepare, sealCleanup } = await import("../gw/seal.mjs");
const { extOff, EXT_OFF_FILE } = await import("../gw/extoff.mjs");
const X = _extForTest;
const H = (r) => path.join(CFG.home, r);
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const settings = () => JSON.parse(fs.readFileSync(H(".claude/settings.json"), "utf8"));
const lastArgv = () => { const a = fs.readFileSync(argLog, "utf8").split("\n"); const i = a.indexOf("mcp"); return a.slice(i).filter(Boolean); };
after(() => {
  Object.assign(PATHS, prev); _setSealed(true);
  for (const r of [".claude/skills/f5a", ".claude/skills/f5b", ".claude.json", "sealproj-f5"]) fs.rmSync(H(r), { recursive: true, force: true });
  fs.rmSync(EXT_OFF_FILE, { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("技能模式：开发版四档写进 skillOverrides（键是目录名）、列表读回；开 = 删键；乱填拒绝", async () => {
  _setSealed(false);
  put(path.join(SKILLS_DIR, "f5a/SKILL.md"), "---\nname: 显示名\ndescription: d\n---\nx\n");
  put(H(".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  assert.equal((await X.setSkillMode("f5a", "name-only")).ok, true);
  assert.deepEqual(settings().skillOverrides, { f5a: "name-only" });
  assert.deepEqual(settings().permissions, { allow: ["Read"] }, "别的键原样留着");
  assert.equal(X.listSkills().find((s) => s.dir === "f5a").mode, "name-only");
  assert.equal((await X.setSkillMode("f5a", "on")).ok, true);
  assert.equal(settings().skillOverrides, undefined, "全开了就不留空对象");
  assert.equal((await X.setSkillMode("f5a", "weird")).ok, false);
  assert.equal((await X.setSkillMode("../etc", "off")).ok, false);
});

test("发行版：只认开 / 关；关掉的技能不打进 user 插件", async () => {
  _setSealed(true);
  put(path.join(SKILLS_DIR, "f5b/SKILL.md"), "---\nname: f5b\ndescription: d\n---\ny\n");
  assert.equal((await X.setSkillMode("f5a", "name-only")).ok, false);
  assert.equal((await X.setSkillMode("f5a", "off")).ok, true);
  fs.mkdirSync(H("sealproj-f5"), { recursive: true });
  const p = sealPrepare({ cwd: H("sealproj-f5"), runId: 551 });
  assert.equal(p.block, null);
  const i = p.args.indexOf("--plugin-dir"), plug = p.args[i + 1];
  assert.ok(fs.existsSync(path.join(plug, "skills/f5b/SKILL.md")), "开着的在");
  assert.ok(!fs.existsSync(path.join(plug, "skills/f5a")), "关掉的不打进去");
  sealCleanup(551);
  await X.setSkillMode("f5a", "on");
});

test("MCP 停用：定义先进名单（0600）再 mcp remove -s user；启用用 add-json 加回、出名单；remove 失败名单退回", async () => {
  _setSealed(false);
  const def = { command: "node", args: ["srv.mjs"], env: { K: "v" } };
  put(H(".claude.json"), JSON.stringify({ mcpServers: { f5m: def } }));
  exitCode = 0; writeCli();
  assert.equal((await X.disableMcp("f5m")).ok, true);
  assert.deepEqual(lastArgv(), ["mcp", "remove", "-s", "user", "f5m"]);
  assert.deepEqual(extOff().mcp.f5m, def);
  assert.equal(fs.statSync(EXT_OFF_FILE).mode & 0o777, 0o600);
  // 名单里的条目在列表里出现成「已停用」（假 CLI 的 mcp list 什么也不输出）
  const li = (await X.listMcp()).find((m) => m.name === "f5m");
  assert.equal(li.disabled, true); assert.equal(li.target, "node srv.mjs [env: K]", "环境变量只亮名字，不亮值");
  assert.equal((await X.enableMcp("f5m")).ok, true);
  const a = lastArgv();
  assert.deepEqual(a.slice(0, 5), ["mcp", "add-json", "-s", "user", "f5m"]);
  assert.deepEqual(JSON.parse(a[5]), def);
  assert.equal(extOff().mcp.f5m, undefined);
  // remove 失败：名单退回，不留「停了却没停」的条目
  exitCode = 1; writeCli();
  assert.equal((await X.disableMcp("f5m")).ok, false);
  assert.equal(extOff().mcp.f5m, undefined);
  // 不是用户级的（.claude.json 里没有）不给停；名字乱填拒绝
  assert.equal((await X.disableMcp("nope")).ok, false);
  assert.equal((await X.disableMcp("-rf")).ok, false);
  assert.equal((await X.enableMcp("nope")).ok, false);
  exitCode = 0; writeCli();
});

test("组件 / 模块：没装的组件、不认识的模块、乱填的 kind 都拒绝，名单不动", async () => {
  assert.equal((await X.setOff("comp", "not-installed", false)).ok, false);
  assert.equal((await X.setOff("mod", "nope", false)).ok, false);
  assert.equal((await X.setOff("evil", "x", false)).ok, false);
  assert.equal((await X.setOff("comp", "../x", false)).ok, false);
  assert.deepEqual(extOff().comp, []); assert.deepEqual(extOff().mod, []);
});

test("系统提示：停用的组件不列进「已装组件」，停用的模块单独说一句", () => {
  const src = fs.readFileSync(new URL("../gw/envfacts.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("!compOff.has(r.id)"));
  assert.ok(src.includes("用户停用了这些模块"));
});

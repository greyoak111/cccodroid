// F6（11-15）：MCP 编辑 = remove + add-json（claude 同名 add / add-json 都直接报错，没有 update）。
// 合并语义：留空 = 保留原值（值只存 ~/.claude.json，不回前端）、提交的同名键覆盖、点掉的键删除；
// 写回用 add-json：定义整体一个 JSON 参数，值里的逗号/等号/引号/换行不会被切坏；
// add 失败把旧定义原样加回。停用中的条目只改停用名单，不碰 claude。假 claude 记录 argv。
import { PATHS, CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _setSealed } from "../gw/edition.mjs";

const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "f6-"));
const cli = path.join(root, "fake-cli.sh"), argLog = path.join(root, "argv.log");
const failOnce = path.join(root, "fail-once"), failAll = path.join(root, "fail-all");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.writeFileSync(cli, `#!${sh}\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${argLog}'\nprintf '\\n' >> '${argLog}'\nsub=""; prev=""\nfor a in "$@"; do if [ "$prev" = "mcp" ]; then sub="$a"; break; fi; prev="$a"; done\ncase "$sub" in\n  remove) exit 0 ;;\n  add-json) if [ -f '${failAll}' ]; then exit 1; elif [ -f '${failOnce}' ]; then rm -f '${failOnce}'; exit 1; fi ;;\nesac\nexit 0\n`, { mode: 0o700 });
const prev = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath; PATHS.loader = PATHS.claudeLoader = cli;
const { editMcp, getMcp, _extForTest } = await import("../gw/extensions.mjs");
const { mcpAddArgs } = _extForTest;
const { extOff, saveExtOff, EXT_OFF_FILE } = await import("../gw/extoff.mjs");
const H = (r) => path.join(CFG.home, r);
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const putDef = (name, d) => {   // 合并不覆盖：一个测试里可以放几条
  const f = H(".claude.json");
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  cur.mcpServers = { ...(cur.mcpServers || {}), [name]: d };
  fs.writeFileSync(f, JSON.stringify(cur));
};
const resetLog = () => fs.rmSync(argLog, { force: true });
/** 假 claude 的历次调用：每组一次调用；loader 会加 --library-path / node 前缀，从 "mcp" 处切 */
const calls = () => fs.existsSync(argLog) ? fs.readFileSync(argLog, "utf8").split("\n\n").filter((b) => b.trim()).map((b) => { const a = b.split("\n"); const i = a.indexOf("mcp"); return i >= 0 ? a.slice(i) : a; }) : [];
/** 最近一次 add-json 的 JSON 参数 */
const lastJson = () => JSON.parse(calls().at(-1)[5]);
after(() => {
  Object.assign(PATHS, prev); _setSealed(true);
  fs.rmSync(H(".claude.json"), { force: true }); fs.rmSync(EXT_OFF_FILE, { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("mcpAddArgs：stdio 选项顺序与 -- 收尾，parts 直传不重切", () => {
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx -y pkg x", ["FOO=1", "bad"], ["X-Test: v"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "-e", "FOO=1", "--header", "X-Test: v", "--", "npx", "-y", "pkg", "x"]);
  // 带空格的参数：走 parts 时原样保留，重切会把 "a b" 拆成两个
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx pkg", [], [], ["npx", "pkg", "a b"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "--", "npx", "pkg", "a b"]);
});

test("mcpAddArgs：远程 transport 地址是位置参数，-e 不进命令行", () => {
  assert.deepEqual(mcpAddArgs("http", "b", "http://x/mcp", [], ["Authorization: Bearer t"]),
    ["mcp", "add", "-s", "user", "--transport", "http", "b", "http://x/mcp", "--header", "Authorization: Bearer t"]);
});

test("getMcp：预填命令/地址与键名，不带值；停用名单里的也能读；找不到报错", async () => {
  putDef("rmc", { type: "http", url: "http://h/mcp", headers: { Authorization: "x", "X-A": "1" } });
  const g = await getMcp({ name: "rmc" });
  assert.deepEqual({ name: g.name, transport: g.transport, target: g.target, envNames: g.envNames, headerNames: g.headerNames },
    { name: "rmc", transport: "http", target: "http://h/mcp", envNames: [], headerNames: ["Authorization", "X-A"] });
  assert.equal(g.ok, true);
  putDef("smc", { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1" } });
  const s = await getMcp({ name: "smc" });
  assert.equal(s.transport, "stdio");
  assert.equal(s.target, "npx -y x");
  assert.deepEqual(s.envNames, ["A"]);
  saveExtOff({ mcp: { dx: { type: "http", url: "http://off/mcp", headers: { Authorization: "x" } } } });
  const d = await getMcp({ name: "dx" });
  assert.equal(d.ok, true);
  assert.equal(d.transport, "http");
  assert.deepEqual(d.headerNames, ["Authorization"]);
  assert.match((await getMcp({ name: "nope" })).message, /找不到这条/);
});

test("editMcp：改 URL 留空 = 保留原请求头值，点掉的键删掉", async () => {
  resetLog();
  putDef("e1", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok", "X-A": "1" } });
  const r = await editMcp({ name: "e1", transport: "http", target: "http://new/mcp", env: [], headers: [], dropHeaders: ["X-A"] });
  assert.ok(r.ok, r.message);
  const cs = calls();
  assert.deepEqual(cs[0], ["mcp", "remove", "-s", "user", "e1"], "先 remove 旧的（显式指定用户级作用域，别误删同名项目级条目）");
  assert.deepEqual(cs[1].slice(0, 5), ["mcp", "add-json", "-s", "user", "e1"]);
  assert.deepEqual(lastJson(), { type: "http", url: "http://new/mcp", headers: { Authorization: "Bearer tok" } }, "留空的请求头带着原值，点掉的键不在");
});

test("editMcp：同名键覆盖、改名、删环境变量；空 env 不写进定义", async () => {
  resetLog();
  putDef("e2", { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1", B: "2" } });
  const r = await editMcp({ name: "e2", newName: "e2x", transport: "stdio", target: "npx -y y", env: ["A=9"], headers: [], dropEnv: ["B"] });
  assert.ok(r.ok, r.message);
  const cs = calls();
  assert.deepEqual(cs[0], ["mcp", "remove", "-s", "user", "e2"]);
  assert.deepEqual(cs[1].slice(0, 5), ["mcp", "add-json", "-s", "user", "e2x"]);
  const j = lastJson();
  assert.deepEqual(j, { type: "stdio", command: "npx", args: ["-y", "y"], env: { A: "9" } }, "同名覆盖、点掉的删掉、旧值不残留");
});

test("editMcp：远程改本地清掉远程字段，本地改远程清掉本地字段", async () => {
  resetLog();
  putDef("e7", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok" } });
  const r = await editMcp({ name: "e7", transport: "stdio", target: "npx -y x", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r.ok, r.message);
  const j = lastJson();
  assert.equal(j.command, "npx");
  assert.deepEqual(j.args, ["-y", "x"]);
  assert.ok(!("url" in j), "url 清掉");
  assert.ok(!("headers" in j), "claude 不存 stdio 请求头：这里显式删掉，别静默丢令牌");
  resetLog();
  putDef("e8", { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1" } });
  const r2 = await editMcp({ name: "e8", transport: "http", target: "http://h2/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r2.ok, r2.message);
  const j2 = lastJson();
  assert.equal(j2.url, "http://h2/mcp");
  assert.ok(!("command" in j2) && !("env" in j2), "本地字段清掉");
});

test("editMcp：add 失败把旧定义原样加回；回滚也失败就明说", async () => {
  resetLog();
  putDef("e3", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok" } });
  fs.writeFileSync(failOnce, "");
  const r = await editMcp({ name: "e3", transport: "http", target: "http://new/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.equal(r.ok, false);
  assert.match(r.message, /旧配置已原样恢复/);
  const cs = calls();
  assert.equal(cs.length, 3, "remove → add-json 失败 → 回滚 add-json");
  assert.deepEqual(cs[2].slice(0, 5), ["mcp", "add-json", "-s", "user", "e3"]);
  assert.deepEqual(JSON.parse(cs[2][5]), { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok" } }, "回滚的是旧名 + 旧定义");
  fs.writeFileSync(failAll, "");
  const r2 = await editMcp({ name: "e3", transport: "http", target: "http://new2/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /没能恢复/);
  fs.rmSync(failAll, { force: true });
});

test("editMcp：停用中的条目只改停用名单，不碰 claude，可改名", async () => {
  saveExtOff({ mcp: { dx: { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok" } } } });
  resetLog();
  const r = await editMcp({ name: "dx", newName: "dx2", transport: "http", target: "http://new/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.ok(r.ok, r.message);
  assert.equal(calls().length, 0, "停用条目不碰 claude");
  const off = extOff();
  assert.deepEqual(off.mcp.dx2, { type: "http", url: "http://new/mcp", headers: { Authorization: "Bearer tok" } });
  assert.equal(off.mcp.dx, undefined);
});

test("editMcp：改名撞已有名字直接拒（两边名单都查）；远程传环境变量照拒", async () => {
  putDef("e5", { type: "http", url: "http://a/mcp" });
  putDef("e6", { type: "http", url: "http://b/mcp" });
  assert.match((await editMcp({ name: "e5", newName: "e6", transport: "http", target: "http://a2/mcp" })).message, /已经有叫这个名字/);
  assert.match((await editMcp({ name: "e5", transport: "http", target: "http://a2/mcp", env: ["A=1"] })).message, /远程 MCP 不支持环境变量/);
});

test("editMcp：跨名单改名互撞也拒（停用→活跃、活跃→停用）", async () => {
  putDef("act1", { type: "http", url: "http://a/mcp" });
  saveExtOff({ mcp: { off1: { type: "http", url: "http://o/mcp" } } });
  // 停用条目改名成活跃条目名字：以前会放行，留下同名幽灵
  assert.match((await editMcp({ name: "off1", newName: "act1", transport: "http", target: "http://o2/mcp" })).message, /已经有叫这个名字/);
  // 活跃条目改名成停用名单里的名字
  assert.match((await editMcp({ name: "act1", newName: "off1", transport: "http", target: "http://a2/mcp" })).message, /已经有叫这个名字/);
});

test("editMcp：校验（找不到、坏名字、坏地址）", async () => {
  assert.match((await editMcp({ name: "ghost", transport: "http", target: "http://x/mcp" })).message, /找不到这条/);
  putDef("e4", { type: "http", url: "http://x/mcp", headers: {} });
  assert.match((await editMcp({ name: "e4", newName: "-bad", transport: "http", target: "http://x/mcp" })).message, /名字只能/);
  assert.match((await editMcp({ name: "e4", transport: "http", target: "notaurl" })).message, /http/);
});

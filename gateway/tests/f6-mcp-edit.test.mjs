// F6（11-15）：MCP 编辑 = remove + add（claude 同名 add 直接报错，没有 update）。
// 合并语义：留空 = 保留原值（值只存 ~/.claude.json，不回前端）、提交的同名键覆盖、点掉的键删除；
// add 失败把旧定义原样加回。假 claude 记录 argv，可让 add 失败一次 / 一直失败。
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
fs.writeFileSync(cli, `#!${sh}\nprintf 'POS:%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" "$5" >> '${argLog}'\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${argLog}'\nprintf '\\n' >> '${argLog}'\ncase "$5" in\n  remove) exit 0 ;;\n  add) if [ -f '${failAll}' ]; then exit 1; elif [ -f '${failOnce}' ]; then rm -f '${failOnce}'; exit 1; fi ;;\nesac\nexit 0\n`, { mode: 0o700 });
const prev = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath; PATHS.loader = PATHS.claudeLoader = cli;
const { editMcp, getMcp, _extForTest } = await import("../gw/extensions.mjs");
const { mcpAddArgs, argsOfDef } = _extForTest;
const H = (r) => path.join(CFG.home, r);
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const putDef = (name, d) => put(H(".claude.json"), JSON.stringify({ mcpServers: { [name]: d } }));
const resetLog = () => fs.rmSync(argLog, { force: true });
/** 假 claude 的历次调用：每组一次调用；loader 会加 --library-path / node 前缀，从 "mcp" 处切 */
const calls = () => fs.readFileSync(argLog, "utf8").split("\n\n").filter((b) => b.trim()).map((b) => { const a = b.split("\n"); const i = a.indexOf("mcp"); return i >= 0 ? a.slice(i) : a; });
after(() => {
  Object.assign(PATHS, prev); _setSealed(true);
  fs.rmSync(H(".claude.json"), { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("mcpAddArgs：stdio 选项顺序与 -- 收尾，parts 直传不重切", () => {
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx -y pkg x", ["FOO=1", "bad"], ["X-Test: v"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "-e", "FOO=1", "--header", "X-Test: v", "--", "npx", "-y", "pkg", "x"]);
  // 带空格的参数：走 parts 时原样保留（argsOfDef 还原存量定义靠它，重切会把 "a b" 拆成两个）
  assert.deepEqual(mcpAddArgs("stdio", "a", "npx pkg", [], [], ["npx", "pkg", "a b"]),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "a", "--", "npx", "pkg", "a b"]);
});

test("mcpAddArgs：远程 transport 地址是位置参数，-e 不进命令行", () => {
  assert.deepEqual(mcpAddArgs("http", "b", "http://x/mcp", [], ["Authorization: Bearer t"]),
    ["mcp", "add", "-s", "user", "--transport", "http", "b", "http://x/mcp", "--header", "Authorization: Bearer t"]);
});

test("argsOfDef：http / stdio 存量定义还原成 add 参数（值完整，args 不重切）", () => {
  assert.deepEqual(argsOfDef("b", { type: "http", url: "http://1.2.3.4/mcp", headers: { Authorization: "Bearer tok" } }),
    ["mcp", "add", "-s", "user", "--transport", "http", "b", "http://1.2.3.4/mcp", "--header", "Authorization: Bearer tok"]);
  assert.deepEqual(argsOfDef("c", { type: "stdio", command: "npx", args: ["-y", "pkg a"], env: { FOO: "1" } }),
    ["mcp", "add", "-s", "user", "--transport", "stdio", "c", "-e", "FOO=1", "--", "npx", "-y", "pkg a"]);
});

test("getMcp：预填命令/地址与键名，不带值；非用户级不给", async () => {
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
  assert.equal((await getMcp({ name: "nope" })).ok, false);
  assert.match((await getMcp({ name: "nope" })).message, /只能编辑/);
});

test("editMcp：改 URL 留空 = 保留原请求头值，点掉的键删掉", async () => {
  resetLog();
  putDef("e1", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok", "X-A": "1" } });
  const r = await editMcp({ name: "e1", transport: "http", target: "http://new/mcp", env: [], headers: [], dropHeaders: ["X-A"] });
  assert.ok(r.ok, r.message);
  const cs = calls();
  assert.deepEqual(cs[0], ["mcp", "remove", "e1"], "先 remove 旧的");
  assert.equal(cs[1][6], "e1", "名字照旧");
  assert.equal(cs[1][7], "http://new/mcp", "新地址是位置参数");
  assert.ok(cs[1].includes("Authorization: Bearer tok"), "留空的请求头带着原值进 add");
  assert.ok(!cs[1].join(" ").includes("X-A"), "点掉的键不进 add");
});

test("editMcp：同名键覆盖、改名、删环境变量", async () => {
  resetLog();
  putDef("e2", { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1", B: "2" } });
  const r = await editMcp({ name: "e2", newName: "e2x", transport: "stdio", target: "npx -y y", env: ["A=9"], headers: [], dropEnv: ["B"] });
  assert.ok(r.ok, r.message);
  const cs = calls();
  assert.equal(cs[0][2], "e2");
  assert.equal(cs[1][6], "e2x");
  assert.ok(cs[1].includes("A=9"), "提交的同名键覆盖原值");
  assert.ok(!cs[1].join(" ").includes("B=2"), "点掉的环境变量不进 add");
  assert.ok(!cs[1].join(" ").includes("A=1"), "旧值不残留");
});

test("editMcp：add 失败把旧定义原样加回；回滚也失败就明说", async () => {
  resetLog();
  putDef("e3", { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer tok" } });
  fs.writeFileSync(failOnce, "");
  const r = await editMcp({ name: "e3", transport: "http", target: "http://new/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.equal(r.ok, false);
  assert.match(r.message, /旧配置已原样恢复/);
  const cs = calls();
  assert.equal(cs.length, 3, "remove → add 失败 → 回滚 add");
  assert.deepEqual(cs[2], ["mcp", "add", "-s", "user", "--transport", "http", "e3", "http://old/mcp", "--header", "Authorization: Bearer tok"], "回滚的是旧名 + 旧配置");
  fs.writeFileSync(failAll, "");
  const r2 = await editMcp({ name: "e3", transport: "http", target: "http://new2/mcp", env: [], headers: [], dropEnv: [], dropHeaders: [] });
  assert.equal(r2.ok, false, JSON.stringify(calls()));
  assert.match(r2.message, /没能恢复/);
  fs.rmSync(failAll, { force: true });
});

test("editMcp：校验（非用户级、坏名字、远程传环境变量）", async () => {
  assert.match((await editMcp({ name: "ghost", transport: "http", target: "http://x/mcp" })).message, /只能编辑/);
  putDef("e4", { type: "http", url: "http://x/mcp", headers: {} });
  assert.match((await editMcp({ name: "e4", newName: "-bad", transport: "http", target: "http://x/mcp" })).message, /名字只能/);
  assert.match((await editMcp({ name: "e4", transport: "http", target: "http://x/mcp", env: ["A=1"] })).message, /远程 MCP 不支持环境变量/);
  assert.match((await editMcp({ name: "e4", transport: "http", target: "notaurl" })).message, /http/);
});

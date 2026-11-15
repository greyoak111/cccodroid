// v0.7.5 之后：MCP 表单防坑提示（群里实际踩过——配置走局域网 IP，IP 一跳就断连）。
// mcpLanHost 判定用 vm 跑真源码；DOM 的显示/隐藏行为在真机界面验，这里只钉源码锚点。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src08 = read("app/08-extensions.js");
const indexHtml = read("index.html");

function loadLanHost() {
  const a = src08.indexOf("  // 本机服务器走回环最稳");
  const b = src08.indexOf("  const syncMcpIpTip", a);
  assert.ok(a > 0 && b > a, "08-extensions.js 提示块找不到");
  const code = `${src08.slice(a, b)}\nglobalThis.__f = { mcpLanHost };`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__f.mcpLanHost;
}
const lan = loadLanHost();

test("f7 私网 IP 命中：192.168 / 10 / 172.16-31，带协议、端口、路径都能抠出主机", () => {
  assert.equal(lan("192.168.1.5"), true);
  assert.equal(lan(" 192.168.1.5 "), true);
  assert.equal(lan("http://192.168.1.5:8788/mcp"), true);
  assert.equal(lan("10.0.0.2:8080"), true);
  assert.equal(lan("172.16.0.1"), true);
  assert.equal(lan("172.31.255.254"), true);
  assert.equal(lan("https://10.1.2.3/sse"), true);
});

test("f7 非私网不提醒：回环、公网、域名、172 段外、空值", () => {
  assert.equal(lan("127.0.0.1"), false);
  assert.equal(lan("http://127.0.0.1:8788/mcp"), false);
  assert.equal(lan("172.32.0.1"), false);
  assert.equal(lan("8.8.8.8"), false);
  assert.equal(lan("https://example.com"), false);
  assert.equal(lan("localhost:8788"), false);
  assert.equal(lan(""), false);
  assert.equal(lan("mcp"), false);
});

test("f7 表单锚点：提示元素在网址框下，切类型 / 输网址都会刷新提示", () => {
  assert.match(indexHtml, /id="ext-mcp-target"[^>]*>\s*\n\s*<div id="ext-mcp-ip-tip"/);
  assert.match(src08, /ext-mcp-tr"\)\.addEventListener\("change", \(\) => \{ syncMcpHint\(\); syncMcpIpTip\(\); \}\)/);
  assert.match(src08, /ext-mcp-target"\)\.addEventListener\("input", syncMcpIpTip\)/);
});

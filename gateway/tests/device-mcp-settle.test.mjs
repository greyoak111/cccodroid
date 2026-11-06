// 屏幕动作做完带回新屏幕（A11y.withScreen）：device-mcp 要把新屏幕原样交给模型，没做成时也附着新屏幕。
// 起真的 device-mcp.mjs，应用那头用一个假套接字顶替
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const MCP = new URL("../../android/assets/bin/device-mcp.mjs", import.meta.url).pathname;

async function withMcp(reply, fn) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "devmcp-"));
  const sock = path.join(dir, "p.sock");
  const seen = [];
  const srv = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf);
      seen.push(req);
      c.end(JSON.stringify(reply(req)));
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, CCAPP_PRIV_SOCK: sock }, stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: p.stdout });
  const waiting = new Map();
  rl.on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  try { await fn(rpc, seen); } finally { p.kill(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const STATUS = { ok: true, on: true, a11y: { mode: "auto", screenshot: true },
  tools: ["screen_read", "screen_tap", "screen_swipe", "screen_type", "screen_key"].map((name) => ({ name, enabled: true, screen: true })) };

test("动作工具都有 read 参数，描述里说清会带回新屏幕", async () => {
  await withMcp(() => STATUS, async (rpc) => {
    const { result } = await rpc("tools/list");
    const by = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    for (const n of ["screen_tap", "screen_swipe", "screen_type", "screen_key"]) {
      assert.equal(by[n].inputSchema.properties.read.type, "boolean", n);
      assert.match(by[n].description, /returns the new screen/, n);
    }
    assert.equal(by.screen_read.inputSchema.properties.read, undefined);
  });
});

test("点成了：结果头 + 新屏幕树，格式和 screen_read 一样", async () => {
  const tree = "[0] TextView \"设置\" @100,200 click\n";
  await withMcp((req) => req.op === "dev_status" ? STATUS
    : { ok: true, via: "action", settle_ms: 310, package: "com.android.settings", screen: "1080x2400", count: 1, tree }, async (rpc, seen) => {
    const { result } = await rpc("tools/call", { name: "screen_tap", arguments: { node: 3 } });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    const [head, ...rest] = text.split("\n");
    const h = JSON.parse(head);
    assert.equal(h.via, "action");
    assert.equal(h.settle_ms, 310);
    assert.equal(h.tree, undefined, "树不重复塞进 JSON");
    assert.equal(rest.join("\n"), tree);
    assert.deepEqual(seen.at(-1).args, { node: 3 }, "参数原样交给应用");
  });
});

test("编号过期没点成：报错，但附着新屏幕", async () => {
  await withMcp((req) => req.op === "dev_status" ? STATUS
    : { ok: false, message: "找不到这个编号的元素", package: "p", count: 1, tree: "[0] Button \"确定\" @1,1 click\n" }, async (rpc) => {
    const { result } = await rpc("tools/call", { name: "screen_tap", arguments: { node: 9 } });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /^找不到这个编号的元素\nCurrent screen/);
    assert.match(text, /\[0\] Button "确定"/);
  });
});

test("没带树的失败、不带屏幕的结果照旧", async () => {
  await withMcp((req) => req.op === "dev_status" ? STATUS
    : req.args.read === false ? { ok: true, via: "back" } : { ok: false, message: "系统没执行" }, async (rpc) => {
    const a = (await rpc("tools/call", { name: "screen_key", arguments: { key: "back" } })).result;
    assert.deepEqual(a, { isError: true, content: [{ type: "text", text: "系统没执行" }] });
    const b = (await rpc("tools/call", { name: "screen_key", arguments: { key: "back", read: false } })).result;
    assert.equal(b.isError, undefined);
    assert.deepEqual(JSON.parse(b.content[0].text), { via: "back" });
  });
});

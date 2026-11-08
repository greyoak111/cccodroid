// 流式响应的背压：事件流补发（gw/bus.mjs，#187 #192）、streamfix 代理（gw/streamfix.mjs，#193）
// 真实 node:http 回环；客户端用裸 socket，好控制「先不读、过一会再读」
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

const { routeBus, publish } = await import("../gw/bus.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { startStreamFix, fixedBaseUrl, STREAMFIX } = await import("../gw/streamfix.mjs");

const servers = [];
after(() => { RUNS.delete("a0610-sse"); for (const s of servers) { s.closeAllConnections?.(); s.close(); } STREAMFIX.server?.close(); });
async function listen(handler) {
  const s = http.createServer(handler); servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s.address().port;
}
const busPort = await listen((req, res) => routeBus(req, res, new URL(req.url, "http://x"), "/api/events"));
/** 连上事件流；pauseMs 内不读。返回 { got(): 已收到的文本, wait(pred, ms), sock } */
function connect(port, path, pauseMs = 0) {
  const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`));
  let buf = "", closed = false;
  sock.setEncoding("utf8");
  sock.on("data", (d) => { buf += d; });
  sock.on("close", () => { closed = true; });
  if (pauseMs) { sock.pause(); setTimeout(() => sock.resume(), pauseMs); }
  return {
    sock, got: () => buf, closed: () => closed,
    async wait(pred, ms = 15000) { const t = Date.now(); while (!pred(buf)) { if (Date.now() - t > ms || closed) return false; await new Promise((r) => setTimeout(r, 20)); } return true; },
  };
}

test("#187：整轮重放全是中文增量 → 补发一路发到 sync，不卡在等 drain", async () => {
  const log = [];
  for (let i = 0; i < 1500; i++) log.push({ type: "delta", runId: "a0610-sse", text: "中".repeat(2000) });
  RUNS.set("a0610-sse", { id: "a0610-sse", text: "", log, startedAt: Date.now(), perms: null });
  const c = connect(busPort, "/api/events");
  const ok = await c.wait((b) => b.includes('"type":"sync"'), 20000);
  c.sock.destroy();
  RUNS.delete("a0610-sse");
  assert.ok(ok, `没等到 sync，只收到 ${c.got().length} 字符`);
});

test("#192：补发期间排了二十几 MB → 按对端速度写完，正常在读的连接不被当成慢读者断掉", async () => {
  RUNS.set("a0610-sse", { id: "a0610-sse", text: "", log: Array.from({ length: 6 }, () => ({ type: "delta", runId: "a0610-sse", text: "x".repeat(6 << 20) })), startedAt: Date.now(), perms: null });
  const c = connect(busPort, "/api/events", 600);
  await new Promise((r) => setTimeout(r, 100));          // 补发在等对端收
  const pad = "y".repeat(64 << 10);
  for (let i = 0; i < 400; i++) publish({ type: "a0610q", i, pad });
  // 一看到 sync 就再发一条：修之前此刻排着的二十几 MB 刚被一口气塞进响应缓冲，这一条会撞上 8MB 线把连接断掉
  await c.wait((b) => b.includes('"type":"sync"'), 30000);
  publish({ type: "a0610tail" });
  const all = await c.wait((b) => b.includes('"i":399,'), 30000);
  const tail = await c.wait((b) => b.includes('"type":"a0610tail"'), 10000);
  const n = (c.got().match(/"type":"a0610q"/g) || []).length;
  const closed = c.closed();
  c.sock.destroy();
  RUNS.delete("a0610-sse");
  assert.ok(all && tail && !closed, `连接断了或没收全：排队项 ${n}/400，closed=${closed}`);
  assert.equal(n, 400);
});

test("#193：streamfix 下游不读 → 停读上游，不把整条流吸进响应缓冲", async () => {
  startStreamFix();
  for (let i = 0; i < 100 && !STREAMFIX.port; i++) await new Promise((r) => setTimeout(r, 20));
  const total = { sent: 0 };
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const upPort = await listen(async (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const w = (s) => { total.sent += Buffer.byteLength(s); return res.write(Buffer.from(s)); };
    w(ev({ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } }));
    w(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    const piece = ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中".repeat(2700) } });
    for (let i = 0; i < 6000; i++) {
      if (res.destroyed) return;
      if (!w(piece)) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
    }
    w(ev({ type: "content_block_stop", index: 0 })); w(ev({ type: "message_stop" })); res.end();
  });
  const base = fixedBaseUrl(`http://127.0.0.1:${upPort}`);
  const u = new URL(base);
  const sock = net.connect(+u.port, "127.0.0.1", () => sock.write(`POST ${u.pathname}/v1/messages HTTP/1.1\r\nHost: x\r\ncontent-length: 2\r\n\r\n{}`));
  sock.pause();                                          // 一直不读
  await new Promise((r) => setTimeout(r, 1500));
  const sent = total.sent;
  sock.destroy();
  // 一条流约 49MB；修之前下游不读也整条吸完（本机 49MB 全推出去），修之后只有两段回环的内核缓冲那么多（本机约 11MB）
  assert.ok(sent < 24 << 20, `下游不读，上游却推出去了 ${sent} 字节`);
});

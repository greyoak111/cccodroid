import { LIVE } from "./config.mjs";
import { RUNS, runList } from "./runs.mjs";
import { NEXT, sendJson, uiTag } from "./http.mjs";
import { flushPend, snapshot } from "./queue.mjs";
import { onTamper, tamperAck, tamperPending } from "./tamper.mjs";

// ── 事件总线 ──────────────────────────────────────────────────────────
// Claude Desktop 的做法：一次生成（run）属于网关，不属于哪个 HTTP 请求。
// 前端只是订阅者 —— 断线、切后台、热替换界面、甚至开两个窗口，都不影响生成本身；
// 连回来时按 Last-Event-ID 从环形缓冲续上，续不上就把当前这一轮从头重放。
//
// 旧版的暗病都出在"生成绑在 /api/chat 那条 SSE 上"：
//   - WebView 一 reload（uiTag 变了、切后台被回收）请求一断，req.on('close') 就把 claude 杀了；
//   - 回来看不到正在跑的那一轮，只能等它（已经被杀的）结束；
//   - 排队在前端内存里，一刷新就丢。
export const BOOT = Date.now().toString(36);
const REPLAY_MAX = 64 << 20;      // 补发期间排队的上限
const CLIENTS_MAX = 32;
const BUS = { seq: 0, ring: [], bytes: 0, clients: new Set() };
const RING_MAX = 4000;
// 条数之外再按字节封顶：一条 Write / Edit 的入参可能几 MB，4000 条全是这种就是几个 GB（审查 10-29 L1）。
// 挤掉的那段续不上时 hello 会改从各轮的 log 重放，不丢东西
const RING_BYTES = 32 * 1024 * 1024;
// 进程内订阅者：可选集成（如工作岛）不用再开一条 HTTP SSE，也不占令牌。
const SUBSCRIBERS = new Set();

/** 订阅每个事件；返回取消订阅的函数。订阅者出错不影响主流程。 */
export function onPublish(fn) {
  SUBSCRIBERS.add(fn);
  return () => SUBSCRIBERS.delete(fn);
}

export function publish(ev) {
  const seq = ++BUS.seq;
  const line = `id: ${BOOT}.${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
  BUS.ring.push({ seq, line }); BUS.bytes += line.length;
  let drop = 0;
  while (drop < BUS.ring.length - 1 && (BUS.ring.length - drop > RING_MAX || BUS.bytes > RING_BYTES)) BUS.bytes -= BUS.ring[drop++].line.length;
  if (drop) BUS.ring.splice(0, drop);
  for (const fn of SUBSCRIBERS) { try { fn(ev); } catch {} }
  for (const c of BUS.clients) busWrite(c, line);
}
function busWrite(res, line) {
  try {
    if (res.__q) {                    // 还在补发：先排队；排太多说明对端根本不收，断掉让它重连
      res.__q.push(line); res.__qb = (res.__qb || 0) + line.length;
      if (res.__qb > REPLAY_MAX) { BUS.clients.delete(res); res.destroy(); }
      return;
    }
    // 订阅者读得太慢（WebView 在后台被冻住）：别让它把网关内存撑爆，断掉让它重连续传
    if (res.writableLength > 8 * 1024 * 1024) { BUS.clients.delete(res); res.destroy(); return; }
    res.write(line);
  } catch { BUS.clients.delete(res); }
}
if (LIVE) setInterval(() => { for (const c of BUS.clients) busWrite(c, ": hb\n\n"); }, 15000).unref();
// 篡改留痕（tamper.mjs）：有新的就推给界面，界面提示一次，点「知道了」回 /api/tamper/ack
onTamper((list) => publish({ type: "tamper", tamper: list }));

// ── 路由：/api/events /api/state ──
export async function routeBus(req, res, u, p) {
  // ── 事件流：所有生成进度都从这里推，前端只订阅 ──
  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    const lastId = String(req.headers["last-event-id"] || u.searchParams.get("since") || "");
    const m = lastId.match(/^([0-9a-z]+)\.(\d+)$/);
    const since = m && m[1] === BOOT ? Number(m[2]) : -1;
    // 先把攒着的增量发出去再判断续不续得上：反过来的话 flush 可能正好把 since 的下一条挤出环，hello 却说续得上（审查 #50 S2-06）
    for (const r of RUNS.values()) flushPend(r);
    const first = BUS.ring[0];
    const resume = since >= 0 && since <= BUS.seq && (since === BUS.seq || (first && first.seq <= since + 1));
    // 要补发的先按条取成快照（这一刻的样子；之后的增量走下面的队列），再按对端的接收速度逐条写：
    // 以前拼成一整个字符串一次写出，整轮重放几十 MB 时就是双份内存，对端不收还全堆在缓冲里（审查 v0513b 低-4）
    const lines = ["retry: 1500\n\n" + `data: ${JSON.stringify({ type: "hello", boot: BOOT, resume, uiTag: uiTag(), ...snapshot() })}\n\n`];
    if (resume) {
      for (const r of BUS.ring) if (r.seq > since) lines.push(r.line);
    } else {
      // 续不上（网关重启过 / 断得太久）：把正在跑的每一轮从头重放（前端按会话自己认领）
      for (const r of runList().sort((a, b) => a.startedAt - b.startedAt)) for (const ev of r.log) lines.push(`data: ${JSON.stringify(ev)}\n\n`);
    }
    lines.push(`id: ${BOOT}.${BUS.seq}\ndata: {"type":"sync"}\n\n`);
    // 同时连着的事件流有上限：一直开新连接不关的，最早那条让位
    if (BUS.clients.size >= CLIENTS_MAX) { const old = BUS.clients.values().next().value; BUS.clients.delete(old); try { old.destroy(); } catch {} }
    res.__q = [];                     // 补发期间新来的事件先排在这里，补完接着发，顺序不乱
    BUS.clients.add(res);
    (async () => {
      for (let i = 0; i < lines.length; i++) {
        if (res.destroyed) return;
        const ok = res.write(lines[i]); lines[i] = null;
        // 两个监听谁先到都要把另一个摘掉：以前 drain 先到时 close 监听留在 res 上，整轮重放一卡一顿就攒出几十个（MaxListenersExceededWarning）
        if (!ok) await new Promise((r) => { const go = () => { res.off("drain", go); res.off("close", go); r(); }; res.once("drain", go); res.once("close", go); });
      }
      const q = res.__q; res.__q = null;
      if (!res.destroyed && q) for (const l of q) res.write(l);
    })().catch(() => { BUS.clients.delete(res); try { res.destroy(); } catch {} });
    req.on("close", () => BUS.clients.delete(res));
    return;
  }
  if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, snapshot());
  if (req.method === "POST" && p === "/api/tamper/ack") {
    tamperAck(u.searchParams.get("id"));
    return sendJson(res, 200, { ok: true, tamper: tamperPending() });
  }
  return NEXT;
}

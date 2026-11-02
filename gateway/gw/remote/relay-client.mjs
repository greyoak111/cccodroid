import { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });
const id = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export function relayUrl(value, { allowLoopback = false } = {}) {
  let u;
  try { u = new URL(value); } catch { throw fail("INVALID_SERVER"); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" && u.pathname !== "") throw fail("INVALID_SERVER");
  if (u.protocol !== "https:" && !(allowLoopback && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw fail("INVALID_SERVER");
  return u;
}

/** Only opaque TLS records enter these streams. Never persist or replay them. */
export function createRelayClient({ serverUrl, deviceId, token, WebSocketClass = globalThis.WebSocket,
  allowLoopback = false, timeoutMs = 15000 } = {}) {
  const endpoint = relayUrl(serverUrl, { allowLoopback });
  if (!id(deviceId) || typeof token !== "string" || token.length < 32 || token.length > 4096) throw fail("INVALID_CREDENTIAL");
  const events = new EventEmitter();
  let active = null, closed = false, connecting = null;
  const current = (s) => active === s && !s.ended && !closed;
  function settle(s, frame) {
    // The relay does not correlate errors with requests. tunnel_missing is an
    // asynchronous close/data rejection, never a rejection of open/auth/ping.
    if (s.online && frame.op === "error" && frame.code === "tunnel_missing") return false;
    let matched = false;
    for (const w of [...s.waiters]) {
      if (frame.op === "error") { s.waiters.delete(w); clearTimeout(w.timer); w.reject(fail("RELAY_REJECTED")); }
      else if (w.match(frame)) { matched = true; s.waiters.delete(w); clearTimeout(w.timer); w.resolve(frame); }
    }
    return matched;
  }
  function wait(s, match) {
    if (!s || !current(s)) throw fail("OFFLINE");
    if (s.waiters.size >= 32) throw fail("LIMIT_EXCEEDED");
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { match, resolve, reject, timer: setTimeout(() => { s.waiters.delete(entry); reject(fail("OFFLINE")); }, timeoutMs) };
      s.waiters.add(entry);
    });
    promise.catch(() => {});
    return { promise, cancel(e) { if (s.waiters.delete(entry)) { clearTimeout(entry.timer); entry.reject(e); } } };
  }
  function send(s, frame) {
    if (!s || !current(s) || !s.online || s.socket?.readyState !== 1) throw fail("OFFLINE");
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > 65536 || s.socket.bufferedAmount + Buffer.byteLength(text) > 128 * 1024) throw fail("BACKPRESSURE");
    s.socket.send(text);
  }
  function disconnected(s) {
    if (!s || s.ended) return;
    const wasCurrent = active === s, wasOnline = s.online;
    s.ended = true; s.online = false; clearInterval(s.heartbeat);
    if (wasCurrent) active = null;
    if (connecting?.session === s) connecting = null;
    for (const w of s.waiters) { clearTimeout(w.timer); w.reject(fail("OFFLINE")); } s.waiters.clear();
    for (const t of s.tunnels.values()) { t.remoteClosed = true; t.destroy(); } s.tunnels.clear(); s.retired.clear();
    try { s.socket?.close(); } catch {}
    if (wasCurrent && wasOnline) events.emit("connection", { state: "offline" });
  }
  function rememberClosed(s, tunnelId) {
    const now = Date.now();
    for (const [key, expiry] of s.retired) if (expiry <= now) s.retired.delete(key);
    s.retired.set(tunnelId, now + timeoutMs);
    if (s.retired.size > 64) s.retired.delete(s.retired.keys().next().value);
  }
  function stream(s, frame) {
    if (s.tunnels.size >= 8 || s.tunnels.has(frame.tunnelId) || !id(frame.tunnelId) || !id(frame.fromDeviceId) || !id(frame.toDeviceId)
        || ![frame.fromDeviceId, frame.toDeviceId].includes(deviceId) || !["peer", "pairing"].includes(frame.purpose)) throw fail("INVALID_SCHEMA");
    const t = new Duplex({ highWaterMark: 65536,
      read() {},
      write(bytes, _encoding, callback) {
        let offset = 0, timer = null, finished = false;
        const onClose = () => done(fail("OFFLINE"));
        const done = (err) => { if (finished) return; finished = true; clearTimeout(timer); t.off("close", onClose); callback(err); };
        const deadline = Date.now() + timeoutMs;
        const next = () => {
          if (!current(s) || !s.online || t.destroyed) return done(fail("OFFLINE"));
          if (Date.now() > deadline) return done(fail("BACKPRESSURE"));
          if (s.socket.bufferedAmount > 48 * 1024) { timer = setTimeout(next, 10); return; }
          try {
            while (offset < bytes.length && s.socket.bufferedAmount < 48 * 1024) {
              const end = Math.min(offset + 16 * 1024, bytes.length);
              send(s, { v: 1, op: "tunnel.data", tunnelId: t.tunnelId, data: bytes.subarray(offset, end).toString("base64") }); offset = end;
            }
            if (offset === bytes.length) done(); else timer = setTimeout(next, 10);
          } catch (e) { done(e); }
        };
        t.once("close", onClose); next();
      },
      destroy(_error, callback) {
        if (s.tunnels.get(frame.tunnelId) === t) {
          s.tunnels.delete(frame.tunnelId); if (!s.ended) rememberClosed(s, frame.tunnelId);
          if (!t.remoteClosed) try { send(s, { v: 1, op: "tunnel.close", tunnelId: frame.tunnelId }); } catch {}
        }
        callback();
      },
    });
    Object.assign(t, frame, { peerDeviceId: frame.fromDeviceId === deviceId ? frame.toDeviceId : frame.fromDeviceId,
      initiator: frame.fromDeviceId === deviceId, remoteClosed: false });
    t.on("error", () => {}); s.tunnels.set(frame.tunnelId, t); return t;
  }
  function incoming(s, text) {
    if (!current(s)) return;
    if (typeof text !== "string" || Buffer.byteLength(text) > 65536) throw fail("LIMIT_EXCEEDED");
    const frame = JSON.parse(text);
    if (!frame || frame.v !== 1 || typeof frame.op !== "string") throw fail("INVALID_SCHEMA");
    if (frame.op === "auth.ok") {
      if (s.online || frame.deviceId !== deviceId || typeof frame.relayInstanceId !== "string") throw fail("DEVICE_MISMATCH");
      s.online = true; settle(s, frame); events.emit("connection", { state: "online", relayInstanceId: frame.relayInstanceId }); return;
    }
    if (!s.online) { settle(s, { op: "error" }); disconnected(s); return; }
    if (frame.op === "tunnel.opened") {
      const t = stream(s, frame), claimed = settle(s, { ...frame, stream: t });
      // A timeout/rejection can race with the opened notification. Leaving its
      // unclaimed TLS stream alive pins the receiver to an orphan handshake.
      if (t.initiator) { if (!claimed) t.destroy(); }
      else if (!events.emit("tunnel", t)) t.destroy();
      return;
    }
    if (frame.op === "tunnel.data") {
      if (!id(frame.tunnelId) || typeof frame.data !== "string" || frame.data.length > 43692) throw fail("INVALID_SCHEMA");
      const bytes = Buffer.from(frame.data, "base64");
      if (!bytes.length || bytes.length > 32768 || bytes.toString("base64") !== frame.data) throw fail("INVALID_SCHEMA");
      const t = s.tunnels.get(frame.tunnelId);
      if (!t) {
        // Already-committed ciphertext may arrive after a local close. Only
        // known, bounded tombstones are ignored; unknown routing fails closed.
        if (s.retired.get(frame.tunnelId) > Date.now()) return;
        throw fail("INVALID_SCHEMA");
      }
      if (t.readableLength + bytes.length > 512 * 1024) { t.destroy(fail("BACKPRESSURE")); return; }
      t.push(bytes); return;
    }
    if (frame.op === "tunnel.closed") { const t = s.tunnels.get(frame.tunnelId); if (t) { t.remoteClosed = true; t.destroy(); } }
    settle(s, frame); events.emit("metadata", frame);
  }
  function request(frame, match) {
    const s = active, pending = wait(s, match);
    try { send(s, frame); } catch (e) { pending.cancel(e); }
    return pending.promise;
  }
  return Object.freeze({
    get online() { return active?.online === true; },
    on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn); },
    async connect() {
      if (closed) throw fail("OFFLINE");
      if (active?.online) return;
      if (connecting && !connecting.session.ended) return connecting.promise;
      const s = { socket: null, online: false, ended: false, heartbeat: null, waiters: new Set(), tunnels: new Map(), retired: new Map() };
      active = s;
      const attempt = { session: s, promise: null };
      connecting = attempt;
      attempt.promise = (async () => {
        const u = new URL("/v1/relay", endpoint); u.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const ready = wait(s, (f) => f.op === "auth.ok");
        try {
          const socket = s.socket = new WebSocketClass(u.href);
          socket.addEventListener("open", () => {
            if (!current(s)) return;
            try { socket.send(JSON.stringify({ v: 1, op: "auth", deviceId, token })); } catch { disconnected(s); }
          });
          socket.addEventListener("message", (e) => { if (!current(s)) return; try { incoming(s, e.data); } catch { disconnected(s); } });
          socket.addEventListener("close", () => disconnected(s));
          socket.addEventListener("error", () => disconnected(s));
          await ready.promise;
          if (!current(s) || !s.online) throw fail("OFFLINE");
          s.heartbeat = setInterval(() => { try { send(s, { v: 1, op: "ping" }); } catch {} }, 20000); s.heartbeat.unref?.();
        } catch (e) { disconnected(s); throw e; }
      })();
      try { return await attempt.promise; } finally { if (connecting === attempt) connecting = null; }
    },
    async openTunnel(toDeviceId, { purpose = "peer", offerId } = {}) {
      if (!id(toDeviceId)) throw fail("INVALID_SCHEMA");
      const tunnelId = randomUUID();
      const result = await request({ v: 1, op: "tunnel.open", tunnelId, toDeviceId, purpose, ...(offerId ? { offerId } : {}) },
        (f) => f.op === "tunnel.opened" && f.tunnelId === tunnelId);
      return result.stream;
    },
    async ping() { await request({ v: 1, op: "ping" }, (f) => f.op === "pong"); return true; },
    async registerOffer(offer) { return request({ v: 1, op: "pair.offer", offerId: offer.offerId, expiresAt: offer.expiresAt }, (f) => f.op === "pair.offered" && f.offerId === offer.offerId); },
    async confirmPair(peerDeviceId) { return request({ v: 1, op: "pair.confirm", peerDeviceId }, (f) => f.op === "pair.confirmed" && f.peerDeviceId === peerDeviceId); },
    async revokePair(peerDeviceId) { return request({ v: 1, op: "pair.revoke", peerDeviceId }, (f) => f.op === "pair.revoked" && f.peerDeviceId === peerDeviceId); },
    cancelOffer(offerId) { send(active, { v: 1, op: "pair.cancel", offerId }); },
    hint(toDeviceId, kind) { send(active, { v: 1, op: "wake.hint", hintId: randomUUID(), toDeviceId, kind, expiresAt: Date.now() + 300000 }); },
    ackHint(fromDeviceId, hintId) { send(active, { v: 1, op: "wake.ack", fromDeviceId, hintId }); },
    disconnect() { disconnected(active); },
    dispose() { closed = true; disconnected(active); events.removeAllListeners(); token = ""; },
  });
}

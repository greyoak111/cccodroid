import { NEXT, readBodyBuf, sendJson } from "./http.mjs";

const BASE = "/api/remote";
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).some((k) => !keys.includes(k))) throw fail("INVALID_SCHEMA");
  return value;
}
async function body(req, keys) {
  let value;
  try { value = JSON.parse((await readBodyBuf(req, 65536)).toString("utf8")); }
  catch (e) { throw fail(e.message === "body does not match signature" ? "FORBIDDEN" : "INVALID_SCHEMA"); }
  return exact(value, keys);
}

/** Local authenticated UI API only; never mounted on the public relay. */
export function createRemoteRoute(runtime, { resolveRuntime = () => runtime } = {}) {
  let clients = 0;
  return async function routeRemote(req, res, u, p) {
    if (p !== BASE && !p.startsWith(BASE + "/")) return NEXT;
    res.setHeader("cache-control", "no-store");
    if (!req.ccAuthed) { req.resume(); return sendJson(res, 403, { error: "FORBIDDEN", code: "FORBIDDEN" }); }
    try {
      const runtime = resolveRuntime(req);
      const get = req.method === "GET", post = req.method === "POST", action = p.slice(BASE.length) || "/status";
      let value;
      if (get && action === "/events") {
        if (clients >= 8) throw fail("LIMIT_EXCEEDED", 429);
        let pending = null, closed = false, started = false, oversized = false, beat = null;
        const write = (snapshot) => {
          if (closed || res.writableEnded || res.destroyed) return;
          const wire = "event: snapshot\ndata: " + JSON.stringify(snapshot) + "\n\n";
          if (Buffer.byteLength(wire) > 1024 * 1024) { oversized = true; if (started) res.destroy(); return; }
          if (!started || res.writableLength > 65536) { pending = wire; return; }
          res.write(wire);
        };
        // Acquire before sending headers or consuming a client slot. A stale
        // activation/failed subscription must remain an ordinary JSON error.
        const off = runtime.subscribe(write);
        clients++;
        const drain = () => { if (pending && !closed) { const wire = pending; pending = null; res.write(wire); } };
        const cleanup = () => { if (closed) return; closed = true; clients--; pending = null; clearInterval(beat); off(); res.off("drain", drain); req.off("close", cleanup); res.off("close", cleanup); };
        req.on("close", cleanup); res.on("close", cleanup);
        try {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" });
          started = true;
          if (closed || res.writableEnded || res.destroyed) { cleanup(); return; }
          if (oversized) { cleanup(); res.destroy(); return; }
          res.on("drain", drain); drain();
          beat = setInterval(() => { if (!closed && res.writableLength < 65536) res.write(": heartbeat\n\n"); }, 20000); beat.unref?.();
        } catch (e) { cleanup(); throw e; }
        return;
      }
      if (get && action === "/status") value = await runtime.status();
      else if (get && action === "/settings") value = await runtime.settings();
      else if (post && action === "/settings") {
        const b = await body(req, ["action", "serverUrl", "deviceName", "credential", "enabled"]);
        if (b.action === "configure") { exact(b, ["action", "serverUrl", "deviceName", "credential"]); value = await runtime.configure(b); }
        else if (b.action === "diagnose") { exact(b, ["action", "serverUrl", "deviceName", "credential"]); value = await runtime.diagnose(b); }
        else if (b.action === "reminders") { exact(b, ["action", "enabled"]); value = await runtime.reminders(b.enabled); }
        else throw fail("INVALID_SCHEMA");
      }
      else if (get && action === "/pairing") value = await runtime.pairing();
      else if (post && action === "/pairing") {
        const b = await body(req, ["action", "code", "pairingId", "verificationCode", "expectedFingerprint", "deviceId"]);
        if (b.action === "create") { exact(b, ["action"]); value = await runtime.pairOffer(); }
        else if (b.action === "join") { exact(b, ["action", "code"]); value = await runtime.pairJoin(b); }
        else if (b.action === "confirm") { exact(b, ["action", "pairingId", "verificationCode", "expectedFingerprint"]); value = await runtime.pairConfirm(b); }
        else if (b.action === "cancel") { exact(b, ["action", "pairingId"]); value = await runtime.pairCancel(b); }
        else if (b.action === "unpair") { exact(b, ["action", "deviceId"]); value = await runtime.unpair(b); }
        else throw fail("INVALID_SCHEMA");
      }
      else if (get && action === "/hosting") value = await runtime.hosting(u.searchParams.get("localSessionId"));
      else if (post && action === "/hosting") {
        const b = await body(req, ["action", "localSessionId", "deviceId", "remoteSessionId", "grantVersion"]);
        if (b.action === "invite") { exact(b, ["action", "localSessionId", "deviceId"]); value = await runtime.invite(b); }
        else if (b.action === "revoke") { exact(b, ["action", "localSessionId", "remoteSessionId", "grantVersion"]); value = await runtime.revoke(b); }
        else throw fail("INVALID_SCHEMA");
      }
      else if (post && action === "/connect") { await body(req, []); value = await runtime.connect(); }
      else if (post && action === "/disconnect") { await body(req, []); value = await runtime.disconnect(); }
      else if (get && action === "/sessions") value = await runtime.list();
      else if (post && action === "/open") value = await runtime.open(await body(req, ["remoteSessionId"]));
      else if (post && action === "/close") { await body(req, []); value = await runtime.close(); }
      else if (post && action === "/accept") value = await runtime.accept(await body(req, ["remoteSessionId"]));
      else if (post && action === "/decline") value = await runtime.decline(await body(req, ["remoteSessionId"]));
      else if (post && action === "/command") value = await runtime.command(await body(req, ["generation", "binding", "type", "commandId", "payload"]));
      else if (post && action === "/history") value = await runtime.history(await body(req, ["generation", "binding", "cursor"]));
      else if (post && action === "/query") value = await runtime.query(await body(req, ["generation", "binding", "commandId"]));
      else throw fail("NOT_FOUND", 404);
      return sendJson(res, 200, value ?? { ok: true });
    } catch (e) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code || "") ? e.code : "INTERNAL_ERROR";
      const status = e.status || (["OFFLINE", "RESYNC_REQUIRED", "GRANT_REVOKED", "COMPONENT_VERSION_MISMATCH"].includes(code) ? 409 : code === "FORBIDDEN" ? 403 : 400);
      return sendJson(res, status, { ok: false, error: code, code });
    }
  };
}

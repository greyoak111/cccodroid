import { NEXT, readBodyBuf, sendJson, STATIC_SAFE, macHdr } from "./http.mjs";
import { createRemoteRoute } from "./remote.mjs";

const BASE = "/api/components/remote-session/";
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
export function createRemoteComponentRoute(manager, { busy = () => false } = {}) {
  const events = new Map();
  manager.watch((status) => {
    for (const [res, activation] of events) if (!status.enabled || status.activationId !== activation) {
      events.delete(res); res.end();
    }
  });
  const remote = createRemoteRoute({}, { resolveRuntime: (req) => {
    const activation = req.ccRemoteActivation;
    return new Proxy({}, { get: (_target, name) => name === "subscribe"
      ? (fn) => manager.subscribeAt(activation, fn) : (...args) => manager.invokeAt(activation, name, ...args) });
  } });
  return async function routeRemoteComponent(req, res, u, p) {
    const feature = p === "/api/remote" || p.startsWith("/api/remote/");
    if (!feature && !p.startsWith(BASE)) return NEXT;
    if (!req.ccAuthed) { req.resume(); return sendJson(res, 403, { ok: false, code: "FORBIDDEN" }); }
    res.setHeader("cache-control", "no-store");
    try {
      if (feature) {
        const status = await manager.status();
        if (!status.enabled) { req.resume(); fail("REMOTE_UNAVAILABLE", 503); }
        const activation = req.headers?.["x-cc-remote-activation"] || u.searchParams.get("activation");
        if (!/^[a-f0-9-]{36}$/.test(activation || "") || activation !== status.activationId) { req.resume(); fail("COMPONENT_VERSION_MISMATCH"); }
        req.ccRemoteActivation = activation;
        if (p === "/api/remote/events" && req.method === "GET") {
          events.set(res, activation); res.once("close", () => events.delete(res));
        }
        return await remote(req, res, u, p);
      }
      const action = p.slice(BASE.length);
      if (action === "status" && req.method === "GET") return sendJson(res, 200, await manager.status());
      if (["enable", "disable"].includes(action) && req.method === "POST") {
        if (busy()) { req.resume(); fail("BUSY"); }
        let body;
        try { body = JSON.parse((await readBodyBuf(req, 1024)).toString("utf8")); }
        catch (e) { fail(e.message === "body does not match signature" ? "FORBIDDEN" : "INVALID_SCHEMA", e.message === "body does not match signature" ? 403 : 400); }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) fail("INVALID_SCHEMA", 400);
        const component = await manager[action]();
        return sendJson(res, 200, { ok: true, component });
      }
      if (["ui.js", "ui.css"].includes(action) && req.method === "GET") {
        if ([...u.searchParams.keys()].some((k) => k !== "version") || u.searchParams.getAll("version").length !== 1) fail("INVALID_SCHEMA", 400);
        const data = await manager.asset(action === "ui.js" ? "js" : "css", u.searchParams.get("version"));
        res.writeHead(200, { "content-type": action === "ui.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
          "content-length": data.length, "cache-control": "no-store", ...STATIC_SAFE, ...macHdr(req, data) });
        return res.end(data);
      }
      req.resume(); fail("NOT_FOUND", 404);
    } catch (e) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code || "") ? e.code : "REMOTE_UNAVAILABLE";
      return sendJson(res, e.status || 409, { ok: false, code, error: code });
    }
  };
}

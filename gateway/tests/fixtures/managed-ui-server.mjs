// Synthetic-only browser fixture. No gateway imports, credentials, child processes, or model calls.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };
export const REMOVAL_ERROR = "Synthetic managed bridge shutdown failed <fixture>";
export const CONFIG_ERROR = "Synthetic local bridge startup failed <fixture>";
export const FAKE_OLD_KEY = "fixture-old-key-never-returned";
export const FAKE_NEW_KEY = "fixture-new-key-not-a-real-credential";
export const SESSION_A = "synthetic-ui-a";
export const SESSION_B = "synthetic-ui-b";

/** Serve the checkout's real frontend with in-memory APIs on a new loopback-only port. */
export async function startManagedUiServer() {
  const clients = new Set(), held = new Set();
  let eventId = 0, removal = null;
  const now = Date.now();
  const state = {
    requests: [], unexpected: [], removeCount: 0, sseConnections: 0, sourceHashes: {},
    removalMode: "success", historyDelay: {}, ui: {},
    configRequests: [], configResponses: [], configMode: "success", configDelay: 0,
    modelsRequests: [], modelsResponses: [], modelsMode: "success", modelsDelay: 0,
    models: [{ id: "synthetic-listed-a" }, { id: "synthetic-listed-b" }],
    config: { installed: true, configured: true, hasKey: true, apiKey: FAKE_OLD_KEY, endpoint: "https://old.synthetic.invalid/v1", model: "synthetic-old-model", providerId: "synthetic-bridge", local: { state: "ready" } },
    providerActive: "synthetic", sessionModelWrites: [],
    component: {
      id: "openai-bridge", name: { zh: "合成 OpenAI 桥", en: "Synthetic OpenAI bridge" },
      desc: { zh: "仅用于隔离 UI 验收，无真实服务。", en: "In-memory UI fixture; no real service." },
      state: "ok", available: true, installedVersion: "fixture.1", version: "fixture.1",
      installed: 1048576, bytes: 524288, bin: ["synthetic-bridge"], requires: [], usedBy: [],
      verified: true, category: "ai", source: "community", license: "MIT", progress: null,
    },
  };
  const sessions = [SESSION_A, SESSION_B].map((id, i) => ({ id, title: `Synthetic session ${i ? "B" : "A"}`, mtime: now - i * 1000, created: now - 2000, sizeKb: 1, cwd: "/synthetic/workspace" }));
  const json = (res, data, code = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const send = (res, ev) => { if (!res.destroyed) res.write(`id: ${++eventId}\ndata: ${JSON.stringify(ev)}\n\n`); };
  const bodyOf = async (req) => {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error("Fixture request too large"); }
    return body ? JSON.parse(body) : {};
  };
  const finishRemoval = (outcome = state.removalMode) => {
    if (!removal) return false;
    const res = removal; removal = null; held.delete(res);
    if (outcome === "failure" || outcome === "http-error") {
      // HTTP failures need not persist an error into the next list response: the POST's message must survive.
      Object.assign(state.component, { state: "ok", error: outcome === "failure" ? REMOVAL_ERROR : "" });
      json(res, { ok: false, message: REMOVAL_ERROR }, outcome === "http-error" ? 409 : 200);
    } else {
      Object.assign(state.component, { state: "absent", installedVersion: "", error: "", progress: null });
      json(res, { ok: true, data: null });
    }
    return true;
  };
  const configReply = () => {
    const { apiKey, ...publicConfig } = state.config;
    const reply = { ok: true, ...publicConfig };
    state.configResponses.push(JSON.stringify(reply));
    return reply;
  };
  const normalizedEndpoint = (raw) => {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error("endpoint");
    const p = u.pathname.replace(/\/+$/, "");
    if (!p || p === "/v1") u.pathname = "/v1/chat/completions";
    else if (!p.endsWith("/chat/completions")) throw new Error("endpoint");
    else u.pathname = p;
    return u.href;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture.invalid"), p = url.pathname;
      // CSP plus CDP interception keep the browser on this fixture, including images and connect APIs.
      res.setHeader("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (p.startsWith("/api/")) state.requests.push({ method: req.method, path: p, query: url.search });
      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" });
        clients.add(res); state.sseConnections++;
        req.on("close", () => clients.delete(res));
        send(res, { type: "hello", uiTag: "synthetic-ui", runs: [], run: null, queue: [], maxParallel: 3, resume: false });
        send(res, { type: "sync" });
        return;
      }
      if (p === "/api/components/remove" && req.method === "POST") {
        const body = await bodyOf(req);
        if (body.id !== state.component.id) return json(res, { ok: false, message: "Unknown synthetic component" }, 404);
        state.removeCount++;
        if (removal) return json(res, { ok: false, message: "Synthetic removal already pending" }, 409);
        removal = res; held.add(res);
        if (state.removalMode !== "held") finishRemoval();
        return;
      }
      if (p === "/api/components/openai-bridge/models") {
        if (req.method !== "POST") return json(res, { ok: false }, 405);
        const body = await bodyOf(req);
        state.modelsRequests.push(body);
        if (state.modelsDelay) await new Promise((r) => setTimeout(r, state.modelsDelay));
        if (body.consent !== true) return json(res, { ok: false, code: "consent_required" }, 400);
        let endpoint;
        try { endpoint = normalizedEndpoint(body.endpoint); } catch { return json(res, { ok: false, code: "invalid_endpoint" }, 400); }
        const changed = state.config.hasKey && new URL(state.config.endpoint).origin !== new URL(endpoint).origin;
        if (!body.apiKey && (!state.config.hasKey || changed)) return json(res, { ok: false, field: "apiKey", code: changed ? "KEY_HOST_CHANGED" : "KEY_REQUIRED" }, 400);
        if (state.modelsMode !== "success" && state.modelsMode !== "empty") return json(res, { ok: false, code: state.modelsMode, message: CONFIG_ERROR }, 400);
        const reply = { ok: true, models: state.modelsMode === "empty" ? [] : state.models, truncated: false };
        state.modelsResponses.push(JSON.stringify(reply));
        return json(res, reply);
      }
      if (p === "/api/components/openai-bridge/config") {
        if (req.method === "GET") {
          if (state.configMode === "get-error") return json(res, { ok: false, code: "fixture-read-error", message: CONFIG_ERROR }, 503);
          return json(res, configReply());
        }
        if (req.method !== "POST") return json(res, { ok: false }, 405);
        const body = await bodyOf(req);
        state.configRequests.push(body);
        if (state.configDelay) await new Promise((r) => setTimeout(r, state.configDelay));
        if (state.configMode === "http-error" || state.configMode === "busy") return json(res, { ok: false, code: "fixture-local-error", message: CONFIG_ERROR }, state.configMode === "busy" ? 409 : 503);
        if (state.configMode === "field-error") return json(res, { ok: false, field: "model", code: "invalid-model", message: "Synthetic model validation rejected" }, 400);
        let endpoint;
        try { endpoint = normalizedEndpoint(body.endpoint); } catch { return json(res, { ok: false, field: "endpoint", code: "invalid-endpoint" }, 400); }
        const changed = state.config.hasKey && new URL(state.config.endpoint).origin !== new URL(endpoint).origin;
        if (!body.apiKey && (!state.config.hasKey || changed)) return json(res, { ok: false, field: "apiKey", code: "key-required" }, 400);
        if (!body.model || /[,\u0000-\u001f\u007f]/.test(body.model)) return json(res, { ok: false, field: "model", code: "invalid-model" }, 400);
        const models = body.models || [{ id: body.model, contextWindow: body.contextWindow || 200000 }];
        Object.assign(state.config, { endpoint, model: body.model, models, contextWindow: models.find((m) => m.id === body.model)?.contextWindow || 200000,
          apiKey: body.apiKey || state.config.apiKey, configured: true, hasKey: true, local: { state: state.configMode === "not-ready" ? "error" : "ready" } });
        return json(res, configReply());
      }
      if (p === "/api/session-model" && req.method === "POST") {
        const body = await bodyOf(req);
        state.sessionModelWrites.push(body);
        // A per-new-session selection is allowed; changing the global default is not.
        if (body.id || body.sessionId) return json(res, { ok: false, message: "Existing synthetic session must not be changed" }, 409);
        return json(res, { ok: true, ...body, own: true });
      }
      if (p === "/api/ui") {
        if (req.method === "POST") Object.assign(state.ui, await bodyOf(req));
        else if (req.method !== "GET") return json(res, { message: "Unsupported fixture method" }, 405);
        return json(res, state.ui);
      }
      if (req.method !== "GET") {
        state.unexpected.push(`${req.method} ${p}`);
        return json(res, { ok: false, message: "Synthetic fixture blocks this operation" }, 403);
      }
      if (p === "/api/status") return json(res, {
        product: "Synthetic UI acceptance", uiTag: "synthetic-ui", version: "fixture", pid: 0,
        ready: true, provider: "synthetic", providerLabel: "Synthetic (no model)", upstream: "synthetic.invalid",
        keyMode: "key", hasKey: true, bridge: false, model: "synthetic-model", workspace: "/synthetic/workspace", busy: false,
      });
      if (p === "/api/components") return json(res, { supported: true, items: [{ ...state.component }], free: 1073741824 });
      if (p === "/api/sessions") return json(res, { sessions });
      if (p.startsWith("/api/session/")) {
        const id = p.slice("/api/session/".length).split("/")[0];
        if (![SESSION_A, SESSION_B].includes(id)) return json(res, { message: "Unknown synthetic session" }, 404);
        if (p.endsWith("/marks")) return json(res, { items: [] });
        const delay = state.historyDelay[id] || 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return json(res, { items: [{ role: "assistant", text: `Synthetic history ${id === SESSION_A ? "A" : "B"}`, uuid: id + "-history" }], title: sessions.find((s) => s.id === id).title, cursor: 0, next: 1, size: 1 });
      }
      const routes = {
        "/api/settings": { permissionMode: "default", outputStyles: [], addDirs: [], model: "synthetic-model", maxParallel: 3 },
        "/api/capabilities": { version: "synthetic", slashCommands: [{ name: "context", desc: "Synthetic only" }], tools: ["Read"], skills: [], agents: [], plugins: [], mcpServers: [], rules: { allow: [], ask: [], deny: [] } },
        "/api/providers": { active: state.providerActive, providers: [{ id: "synthetic", label: "Synthetic (no model)", labelEn: "Synthetic (no model)", group: "custom", active: true, hasKey: true, baseUrl: "https://synthetic.invalid", custom: true }, { id: "synthetic-bridge", label: "Synthetic local bridge", labelEn: "Synthetic local bridge", group: "custom", active: false, hasKey: true, baseUrl: "http://127.0.0.1:1", custom: true, bridge: "openai-bridge" }] },
        "/api/models": { models: [{ id: "synthetic-model", name: "Synthetic model", context_window: 200000, input_modalities: ["text"] }, { id: state.config.model, name: "Synthetic bridge model", context_window: 200000, input_modalities: ["text"] }], current: url.searchParams.get("model") || "synthetic-model", contextWindow: 200000, effortLevels: ["low", "medium", "high"], effort: "medium", providers: [{ id: "synthetic", label: "Synthetic", usable: true }, { id: state.config.providerId, label: "Synthetic local bridge", usable: true }] },
        "/api/session-model": { model: url.searchParams.get("model") || "synthetic-model", provider: url.searchParams.get("provider") || "synthetic", own: url.searchParams.has("provider") },
        "/api/exec-mode": { pref: "auto", active: "direct", pid: 0 },
        "/api/fonts": { items: [] }, "/api/notices": { items: [] },
        "/api/devkit/modules": { supported: false }, "/api/custom": { supported: false },
        "/api/gh/auth": { installed: false }, "/api/ext/plugins": { installed: [], available: [], items: [], total: 0 },
        "/api/ext/skills": { items: [] }, "/api/ext/mcp": { items: [] }, "/api/ext/marketplaces": { items: [] },
        "/api/ext/hooks": { hooks: {}, scopes: [], user: {}, project: {}, workspace: "/synthetic/workspace" },
        "/api/commands": { scopes: [{ scope: "user", items: [] }, { scope: "project", items: [] }], workspace: "/synthetic/workspace" },
        "/api/projects": { projects: [], items: [] }, "/api/sched": { tasks: [], items: [], budget: {}, missed: [] },
        "/api/priv/status": { supported: false }, "/api/app/upd_status": { supported: false },
        "/api/app/notify_status": { supported: false }, "/api/app/dev_status": { supported: false },
        "/api/reconcile": { supported: false }, "/api/usage": { hours: [], items: [], providers: {}, sessions: {}, days: [] },
        "/api/energy": { supported: false, items: [] }, "/api/billing": { supported: false },
        "/api/bookmarks": { items: [] }, "/api/orphans": { items: [] }, "/api/login/status": { loggedIn: false },
      };
      if (p === "/api/models") {
        const selected = url.searchParams.get("provider"), browse = url.searchParams.get("browse") || selected;
        const configured = state.config.models || [{ id: state.config.model, contextWindow: 200000 }];
        const current = url.searchParams.get("model") || "synthetic-model";
        Object.assign(routes[p], { provider: selected || "synthetic", listProvider: browse || "synthetic", defaultModel: state.config.model,
          ...(browse === state.config.providerId ? { models: configured.map((m) => ({ id: m.id, context_window: m.contextWindow, input_modalities: ["text"] })) } : {}),
          contextWindow: selected === state.config.providerId ? configured.find((m) => m.id === current)?.contextWindow || 200000 : 200000 });
      }
      if (Object.hasOwn(routes, p)) return json(res, routes[p]);
      if (p.startsWith("/api/")) {
        state.unexpected.push(`GET ${p}`);
        return json(res, { ok: false, message: "Unimplemented synthetic endpoint" }, 404);
      }
      if (p === "/app.js") {
        const dir = path.join(WEB, "app"), parts = (await fs.readdir(dir)).filter((f) => f.endsWith(".js")).sort();
        const text = (await Promise.all(parts.map((f) => fs.readFile(path.join(dir, f), "utf8")))).join("");
        state.sourceHashes["app.js"] = createHash("sha256").update(text).digest("hex");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(text);
      }
      const name = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
      const file = path.resolve(WEB, name);
      if (!file.startsWith(WEB)) return json(res, { message: "Not found" }, 404);
      const actual = await fs.realpath(file);
      if (!actual.startsWith(WEB) || !(await fs.stat(actual)).isFile()) return json(res, { message: "Not found" }, 404);
      const data = await fs.readFile(actual);
      if (["index.html", "style.css", "layout.js"].includes(name)) state.sourceHashes[name] = createHash("sha256").update(data).digest("hex");
      res.writeHead(200, { "content-type": (TYPES[path.extname(file)] || "application/octet-stream") + (/[.](html|js|css|md|json)$/.test(file) ? "; charset=utf-8" : ""), "cache-control": "no-store" });
      res.end(data);
    } catch (err) {
      json(res, { message: err.code === "ENOENT" ? "Not found" : err.message }, err.code === "ENOENT" ? 404 : 500);
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, state,
    emit(ev) { for (const res of clients) send(res, ev); },
    finishRemoval,
    resetComponent(patch = {}) { Object.assign(state.component, { state: "ok", installedVersion: "fixture.1", error: "", progress: null }, patch); },
    async close() {
      for (const res of clients) res.end();
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

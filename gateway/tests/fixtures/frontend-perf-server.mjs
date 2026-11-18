// Synthetic-only frontend acceptance. No gateway imports, user files, credentials or model traffic.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const CSP = "frame-ancestors 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'; object-src 'none'; base-uri 'none'";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };

function mapSetup() {
  window.__counts = { buildAxis: 0, layout: 0, scene: 0, paintTree: 0 };
  window.__raf = new Set(); window.__timers = new Set();
  const raf = requestAnimationFrame.bind(window), caf = cancelAnimationFrame.bind(window), timer = setTimeout.bind(window), clear = clearTimeout.bind(window);
  window.requestAnimationFrame = fn => { const id = raf(at => { __raf.delete(id); fn(at); }); __raf.add(id); return id; };
  window.cancelAnimationFrame = id => { __raf.delete(id); caf(id); };
  window.setTimeout = (fn, ms, ...args) => { const id = timer(() => { __timers.delete(id); fn(...args); }, ms); __timers.add(id); return id; };
  window.clearTimeout = id => { __timers.delete(id); clear(id); };
  // 页面内轮询等待：不靠固定 sleep，等可观测信号（__raf/__timers/__counts）后再断言。
  window.__waitFor = async (fn, label, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (fn()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error("Page wait timeout: " + label);
  };
  window.__make = n => {
    const now = 1800000000000, H = 3600000;
    return { now, bands: [{ key: "a", name: "Synthetic project" }], sessions: Array.from({ length: n }, (_, i) => ({
      id: "s" + i, short: "s" + i, band: "a", title: "Synthetic session " + i,
      from: now - 120 * H, to: now - H, parent: i && i % 3 ? "s" + (i - 1) : null, at: now - 100 * H,
      extra: [], reads: [], ch: i % 10 ? [] : [{ at: now - 60 * H, t: "Synthetic chapter" }], open: { t: "Current" }, meta: { size: "1 KB" },
    })) };
  };
  window.__boot = n => {
    window.__model = __make(n);
    window.__map = CCLineageMap.create(document.getElementById("map"), { misc: true });
    __map.set(__model);
  };
}

export async function startFrontendPerfServer() {
  const data = { console, ArrayBuffer, Uint8Array, DataView, TextDecoder, TextEncoder };
  vm.createContext(data);
  vm.runInContext(await fs.readFile(path.join(WEB, "office/xlsx.full.min.js"), "utf8"), data);
  const X = data.XLSX, workbook = X.utils.book_new();
  const sheet = X.utils.aoa_to_sheet(Array.from({ length: 1000 }, (_, r) => Array.from({ length: 100 }, (_, c) => `Cell ${r}:${c}`)));
  X.utils.book_append_sheet(workbook, sheet, "Synthetic");
  X.utils.book_append_sheet(workbook, X.utils.aoa_to_sheet([["SECOND SHEET"]]), "Second");
  const bytes = Buffer.from(new Uint8Array(X.write(workbook, { type: "array", bookType: "xlsx", compression: true })));
  const small = X.utils.book_new();
  X.utils.book_append_sheet(small, X.utils.aoa_to_sheet([["Replacement workbook"]]), "Replacement");
  const smallBytes = Buffer.from(new Uint8Array(X.write(small, { type: "array", bookType: "xlsx", compression: true })));
  const histories = new Map();
  const tools = [{ role: "user", text: "Synthetic tool history" }];
  for (let i = 0; i < 760; i++) tools.push({ role: "tool_use", id: "history-" + i, name: "Read", input: { file_path: "/synthetic/" + i } }, { role: "tool_result", id: "history-" + i, ok: true, text: "Result " + i });
  tools.push({ role: "assistant", text: "Complete" }); histories.set("synthetic-tools", tools);
  for (const suffix of ["success", "failure", "dispose"]) {
    const items = [{ role: "user", text: "Synthetic delayed agent history" }];
    for (let i = 0; i < 100; i++) items.push({ role: "tool_use", id: "agent-" + i, name: "Agent", input: { prompt: "Synthetic " + i }, sub: true }, { role: "tool_result", id: "agent-" + i, ok: true, text: "Done" });
    items.push({ role: "assistant", text: "Complete" }); histories.set("synthetic-loader-" + suffix, items);
  }
  const clients = new Set(), heldAgents = new Set(), delayed = new Map();
  // held: 测试可以把 /api/file 下载挂在服务端不放行（releaseFiles 放行）；aborted 记录客户端真的中断了请求。
  const state = { requests: [], writes: [], hashes: {}, agentHold: false, agentFailure: false, agentCalls: 0, agentReplies: 0,
    fileDelay: 0, fileHold: false, held: [], filePending: 0, fileAborts: 0, officeScripts: 0 };
  const sessions = Array.from({ length: 600 }, (_, i) => ({ id: i ? "synthetic-session-" + i : "synthetic-tools", title: "Synthetic session " + i, mtime: Date.now() - i * 1000, created: Date.now() - i * 1000, sizeKb: 1, cwd: "" }));
  const reply = (res, body, type = "application/json", status = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const agentReply = res => {
    res.once("finish", () => { state.agentReplies++; });   // 测试等「响应真的发完」，不靠固定 sleep
    reply(res, state.agentFailure ? { error: "Synthetic delayed failure" } : { items: [{ role: "tool_use", id: "loaded-child", name: "Read", input: { file_path: "/synthetic/loaded" } }, { role: "tool_result", id: "loaded-child", ok: true, text: "Loaded child result" }] }, "application/json", state.agentFailure ? 500 : 200);
  };
  // 只有这些合成只读端点是合法的；任何白名单外的 /api/*（尤其是 /api/chat）都会让验收失败。
  const defaults = {
    "/api/status": { uiTag: "frontend-perf", version: "fixture", busy: false, running: 0, runs: [], sessions: [], ready: true, provider: "synthetic", model: "synthetic-model", cli: { installed: true } },
    "/api/settings": { model: "synthetic-model", permissionMode: "default", maxParallel: 3 },
    "/api/capabilities": { tools: [], agents: [], plugins: [], skills: [], slashCommands: [], mcpServers: [], rules: { allow: [], ask: [], deny: [] } },
    "/api/models": { current: "synthetic-model", models: [{ id: "synthetic-model" }], effortLevels: ["low", "high"], providers: [] },
    "/api/session-model": { model: "synthetic-model", provider: "synthetic" },
    "/api/providers": { active: "synthetic", providers: [] }, "/api/fonts": { items: [] }, "/api/notices": { items: [] }, "/api/ui": {},
    "/api/projects": { projects: [], items: [] }, "/api/sched": { tasks: [], running: [], missed: [], budget: {} },
    "/api/components": { supported: false, items: [] }, "/api/devkit/modules": { supported: false, items: [] },
    "/api/ext/plugins": { installed: [], available: [], items: [] }, "/api/ext/skills": { items: [] }, "/api/ext/mcp": { items: [] },
    "/api/bookmarks": { items: [] }, "/api/orphans": { items: [] }, "/api/usage": { items: [], hours: [], days: [], providers: {}, sessions: {} },
    // 启动 2.5s 的后台只读探测也合法；/api/chat 仍然禁止
    "/api/state": { runs: [], queue: [], interrupted: [], maxParallel: 3 },
    "/api/work-island": { supported: false }, "/api/exec-mode": { active: "direct", pref: "direct" },
    "/api/billing": { plan: [], balance: null }, "/api/login/status": { loggedIn: false },
    "/api/priv/status": { state: "unsupported" }, "/api/app/upd_status": { ok: false },
    "/api/app/notify_status": { ok: false }, "/api/app/dev_status": { ok: false },
  };
  const ALLOWED_EXTRA = new Set(["/api/events", "/api/file", "/api/file/stat", "/api/sessions"]);
  const ALLOWED_DYNAMIC = [/^\/api\/session\/[^/]+$/, /^\/api\/session\/[^/]+\/(agent|agents|marks)$/];
  const allowed = p => ALLOWED_EXTRA.has(p) || Object.hasOwn(defaults, p) || ALLOWED_DYNAMIC.some(re => re.test(p));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", CSP); res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, "http://fixture.invalid"), p = url.pathname;
      if (p.startsWith("/api/")) state.requests.push({ method: req.method, path: p, query: url.search });
      if (req.method !== "GET") { state.writes.push(p); return reply(res, { error: "Synthetic fixture forbids writes" }, "application/json", 409); }
      if (p === "/favicon.ico") return reply(res, "", "image/png", 204);
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" }); clients.add(res);
        res.write('data: {"type":"hello","uiTag":"frontend-perf","runs":[],"queue":[],"maxParallel":3,"resume":false}\n\ndata: {"type":"sync"}\n\n');
        req.on("close", () => clients.delete(res)); return;
      }
      if (/^\/api\/session\/[^/]+\/agent$/.test(p)) {
        state.agentCalls++;
        if (state.agentHold) { heldAgents.add(res); res.on("close", () => heldAgents.delete(res)); }
        else agentReply(res);
        return;
      }
      if (p === "/api/file/stat") return reply(res, { size: url.searchParams.get("path")?.includes("replacement") ? smallBytes.length : bytes.length });
      if (p === "/api/file") {
        const file = url.searchParams.get("path") || "";
        const entry = { res, path: file, pending: true, released: false, aborted: false };
        const settle = () => { if (entry.pending) { entry.pending = false; state.filePending--; } };
        const send = () => {
          if (entry.released) return;
          entry.released = true; settle(); delayed.delete(res);
          reply(res, file.includes("replacement") ? smallBytes : bytes, "application/octet-stream");
        };
        entry.send = send;
        res.on("close", () => {
          if (!entry.released) { entry.aborted = true; state.fileAborts++; }
          settle();
          const timer = delayed.get(res); if (timer) { clearTimeout(timer); delayed.delete(res); }
        });
        state.filePending++;
        if (state.fileHold) { state.held.push(entry); return; }
        if (state.fileDelay) delayed.set(res, setTimeout(send, state.fileDelay)); else send();
        return;
      }
      if (p.startsWith("/api/session/")) {
        if (/\/(agents|marks)$/.test(p)) return reply(res, p.endsWith("/agents") ? { records: [] } : { items: [] });
        const sid = decodeURIComponent(p.split("/")[3]); return reply(res, { items: histories.get(sid) || [], cursor: 0, size: 1000, title: "Synthetic history" });
      }
      if (p === "/api/sessions") return reply(res, { sessions: sessions.slice(0, Number(url.searchParams.get("limit")) || 150), total: 600 });
      if (Object.hasOwn(defaults, p)) return reply(res, defaults[p]);
      if (p.startsWith("/api/")) return reply(res, {});
      if (p === "/__fixture/map.html") return reply(res, '<!doctype html><html lang="zh" data-theme="light" data-motion="off"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/__fixture/map.css"><div id="map"></div><script src="/__fixture/map-setup.js"></script><script src="/__fixture/map.js"></script></html>', "text/html");
      if (p === "/__fixture/map.css") return reply(res, ':root{--font-ui:sans-serif;--mono:monospace;--bg:#fff;--fg:#222;--fg2:#666;--fg3:#999;--line:#ddd;--accent:#4f46e5}body{margin:0;background:#fff}#map{position:absolute;left:10px;top:10px;width:1200px;height:650px}', "text/css");
      if (p === "/__fixture/map-setup.js") return reply(res, "(" + mapSetup.toString() + ")();", "text/javascript");
      if (p === "/__fixture/map.js") {
        let script = await fs.readFile(path.join(WEB, "lineage/map.js"), "utf8");
        for (const name of ["buildAxis", "layout", "scene", "paintTree"]) {
          const marker = new RegExp("(function " + name + "\\([^\\n]*\\) \\{)");
          if (!marker.test(script)) throw new Error("Missing map instrumentation anchor: " + name);
          script = script.replace(marker, "$1 window.__counts." + name + "++;");
        }
        const marker = "      snapshot,\n      state:";
        if (!script.includes(marker)) throw new Error("Missing map debug anchor");
        script = script.replace(marker, "      snapshot,\n      __geometry: () => ({ AX: st.AX, L: st.L, geo: st.geo }),\n      state:");
        return reply(res, script, "text/javascript");
      }
      let asset;
      const name = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
      if (name === "app.js") asset = (await Promise.all((await fs.readdir(path.join(WEB, "app"))).filter(n => n.endsWith(".js")).sort().map(n => fs.readFile(path.join(WEB, "app", n), "utf8")))).join("");
      else {
        const file = path.resolve(WEB, name), actual = await fs.realpath(file);
        if (!actual.startsWith(WEB) || !(await fs.stat(actual)).isFile()) return reply(res, "Not found", "text/plain", 404);
        asset = await fs.readFile(actual);
      }
      state.hashes[name] = createHash("sha256").update(asset).digest("hex");
      // Worker 脚本 no-store：每次 Worker 创建都重新加载，测试才能按「三个脚本全部送达」判定 Worker 就绪，
      // 而不是被 HTTP 缓存命中掩盖（缓存命中不产生可观察请求，terminate 在途加载会报 NetworkError）。
      if (name.startsWith("office/")) { res.setHeader("cache-control", "no-store"); res.once("finish", () => { state.officeScripts++; }); }
      return reply(res, asset, TYPES[path.extname(name)] || "application/octet-stream");
    } catch (e) { reply(res, { message: e.code === "ENOENT" ? "Not found" : e.message }, "application/json", e.code === "ENOENT" ? 404 : 500); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: "http://127.0.0.1:" + server.address().port, state,
    isAllowed: allowed,
    releaseAgents() { for (const res of heldAgents) agentReply(res); heldAgents.clear(); },
    releaseFiles() { for (const entry of state.held) entry.send(); },
    async close() {
      for (const timer of delayed.values()) clearTimeout(timer); delayed.clear();
      for (const res of heldAgents) res.destroy(); heldAgents.clear();
      for (const entry of state.held) entry.res?.destroy();
      for (const res of clients) res.end(); clients.clear();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}

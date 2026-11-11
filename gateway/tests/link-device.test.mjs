import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "a".repeat(64);
// 这些测试也要能在 Windows 开发机上跑；网关生产环境仍然运行在 Android 的 POSIX uid 上。
if (typeof process.getuid !== "function") process.getuid = () => 0;

function tempDir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "cccodroid-link-"));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitJson(url, headers = {}, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(1200) });
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw last || new Error("timeout");
}

async function postJson(url, body, headers = {}, timeoutMs = 8000) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function waitExit(child, timeoutMs = 5000) {
  if (child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("process did not exit")), timeoutMs)),
  ]);
}

function spawnNode(script, args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

test("linkd starts, exposes the local API, and shuts down", async () => {
  const tmp = tempDir(), home = path.join(tmp, "home"), workspace = path.join(tmp, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(home, ".gateway-token"), TOKEN + "\n");
  const local = await freePort(), lan = await freePort(), udp = await freePort();
  fs.writeFileSync(path.join(home, "ccapp-link.json"), JSON.stringify({
    deviceId: "11111111-1111-4111-8111-111111111111",
    deviceName: "test-device",
    lan: { enabled: false },
    peers: [{
      id: "22222222-2222-4222-8222-222222222222",
      name: "Phone",
      addr: "127.0.0.1",
      port: lan,
      secret: "b".repeat(64),
      platform: "win32",
      kind: "phone",
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      autoSync: true,
    }],
  }));
  const child = spawnNode("link/linkd.mjs", [
    "--home", home, "--workspace", workspace, "--gateway-port", "18999",
    "--local-port", String(local), "--lan-port", String(lan), "--udp-port", String(udp),
    "--name", "test-device",
  ]);
  const base = `http://127.0.0.1:${local}`;
  try {
    const health = await waitJson(base + "/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.name, "test-device");
    const status = await waitJson(base + "/api/status", { "x-link-token": TOKEN });
    assert.equal(status.device.name, "test-device");
    assert.equal(status.device.kind, "pc");
    assert.equal(status.peers[0].kind, "phone");
    assert.equal(status.remote.targets[0].kind, "phone");
    const r = await fetch(base + "/api/shutdown", {
      method: "POST",
      headers: { "x-link-token": TOKEN, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.ok, true);
    await waitExit(child);
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("relay preserves same-session fields and top-level control messages", async () => {
  const tmp = tempDir();
  fs.writeFileSync(path.join(tmp, "token"), TOKEN + "\n");
  const port = await freePort();
  const child = spawnNode("relay/relay.mjs", ["--data", tmp, "--port", String(port), "--bind", "127.0.0.1"]);
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const to = "22222222-2222-4222-8222-222222222222";
  const from = { id: "11111111-1111-4111-8111-111111111111", name: "sender", kind: "pc", platform: "win32" };
  try {
    await waitJson(base + "/api/health");
    const taskId = crypto.randomUUID();
    const created = await fetch(base + "/api/relay/task", {
      method: "POST", headers,
      body: JSON.stringify({
        to, from,
        task: { id: taskId, prompt: "do work", sessionId: "session-123", text: "user words", context: "older context" },
      }),
    });
    assert.equal(created.status, 200);
    const inbox = await waitJson(`${base}/api/relay/tasks?to=${encodeURIComponent(to)}&status=queued`, headers);
    const task = inbox.tasks.find((x) => x.id === taskId);
    assert.ok(task);
    assert.equal(task.sessionId, "session-123");
    assert.equal(task.text, "user words");
    assert.equal(task.context, "older context");

    const controlId = crypto.randomUUID();
    const control = await fetch(base + "/api/relay/task", {
      method: "POST", headers,
      body: JSON.stringify({
        id: controlId, to, from, kind: "control", action: "inject",
        targetTaskId: taskId, text: "interjection", prompt: "control", timeout: 120,
      }),
    });
    assert.equal(control.status, 200);
    const inbox2 = await waitJson(`${base}/api/relay/tasks?to=${encodeURIComponent(to)}&status=queued`, headers);
    const ctl = inbox2.tasks.find((x) => x.id === controlId);
    assert.ok(ctl);
    assert.equal(ctl.kind, "control");
    assert.equal(ctl.action, "inject");
    assert.equal(ctl.targetTaskId, taskId);
    assert.equal(ctl.text, "interjection");
  } finally {
    if (child.exitCode == null) child.kill("SIGTERM");
    await waitExit(child).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("link admin page is rewritten for the gateway same-origin proxy", async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, "gw/link.mjs")).href + "?link-ui-test");
  const html = mod.linkUiHtml();
  assert.match(html, /"\/api\/link\/proxy\/status"/);
  assert.match(html, /"\/api\/link\/proxy\/pair\/code"/);
  assert.doesNotMatch(html, /fetch\("\/api\/status"/);
});

test("gateway routes the link page with the real URL/path arguments", async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, "gw/link.mjs")).href + "?link-route-test");
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    Promise.resolve(mod.routeLink(req, res, u, u.pathname)).catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/link/ui`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /\/api\/link\/proxy\/status/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("gateway publishes a link_sync bus event for immediate session refresh", async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, "gw/bus.mjs")).href + "?link-sync-test");
  let seen = null;
  const off = mod.onPublish((ev) => { if (ev && ev.type === "link_sync") seen = ev; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    Promise.resolve(mod.routeBus(req, res, u, u.pathname)).catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/link/synced`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        at: 123, peer: { id: "peer-1", name: "Phone", via: "relay", secret: "must-not-leak" },
        pulled: 2, pushed: 1, meta: true,
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(seen);
    assert.deepEqual(seen.peer, { id: "peer-1", name: "Phone", via: "relay" });
    assert.equal(seen.pulled, 2);
    assert.equal(seen.pushed, 1);
    assert.equal(seen.meta, true);
    assert.equal(seen.secret, undefined);
  } finally {
    off();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("frontend reloads the session list when link_sync arrives", () => {
  const src = fs.readFileSync(path.join(ROOT, "web/app/04-session-flow.js"), "utf8");
  assert.match(src, /case "link_sync": loadLinkDev\(\)\.finally\(\(\) => loadSessions\(\)\)/);
  assert.match(src, /事件流重连期间漏掉的 link_sync/);
  const core = fs.readFileSync(path.join(ROOT, "web/app/01-core.js"), "utf8");
  assert.match(core, /Number\(j\.rev\)/);
  const boot = fs.readFileSync(path.join(ROOT, "web/app/19-boot.js"), "utf8");
  assert.match(boot, /后台期间 WebView 可能暂停事件流/);
});

test("a real linkd pull notifies the local gateway", async () => {
  const tmp = tempDir(), homeA = path.join(tmp, "a"), homeB = path.join(tmp, "b");
  const wsA = path.join(homeA, "workspace"), wsB = path.join(homeB, "workspace");
  for (const d of [homeA, homeB, wsA, wsB]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(homeA, ".gateway-token"), TOKEN + "\n");
  fs.writeFileSync(path.join(homeB, ".gateway-token"), TOKEN + "\n");
  const localA = await freePort(), lanA = await freePort(), udpA = await freePort();
  const localB = await freePort(), lanB = await freePort(), udpB = await freePort();
  const gwA = await freePort(), gwB = await freePort();
  let notified = null;
  let resolveNotify;
  const gotNotify = new Promise((resolve) => { resolveNotify = resolve; });
  const gateway = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/link/synced") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { notified = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        resolveNotify();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => gateway.listen(gwA, "127.0.0.1", resolve));
  const a = spawnNode("link/linkd.mjs", [
    "--home", homeA, "--workspace", wsA, "--gateway-port", String(gwA),
    "--local-port", String(localA), "--lan-port", String(lanA), "--udp-port", String(udpA), "--name", "device-a",
  ]);
  const b = spawnNode("link/linkd.mjs", [
    "--home", homeB, "--workspace", wsB, "--gateway-port", String(gwB),
    "--local-port", String(localB), "--lan-port", String(lanB), "--udp-port", String(udpB), "--name", "device-b",
  ]);
  const baseA = `http://127.0.0.1:${localA}`, baseB = `http://127.0.0.1:${localB}`;
  const hA = { "x-link-token": TOKEN }, hB = { "x-link-token": TOKEN };
  try {
    await Promise.all([waitJson(baseA + "/api/health"), waitJson(baseB + "/api/health")]);
    await Promise.all([postJson(baseA + "/api/lan", { enabled: true }, hA), postJson(baseB + "/api/lan", { enabled: true }, hB)]);
    const code = (await postJson(baseA + "/api/pair/code", {}, hA)).pairing.code;
    const paired = await postJson(baseB + "/api/pair/connect", { addr: "127.0.0.1", port: lanA, code }, hB);
    const bId = paired.status.device.id;

    const sid = crypto.randomUUID();
    const project = path.join(homeB, ".claude", "projects", "sync-test");
    fs.mkdirSync(project, { recursive: true });
    const session = path.join(project, sid + ".jsonl");
    fs.writeFileSync(session, JSON.stringify({
      type: "user", sessionId: sid, cwd: wsB, timestamp: new Date().toISOString(),
      message: { role: "user", content: "synced immediately" },
    }) + "\n");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(session, old, old);

    const synced = await postJson(baseA + "/api/sync", { id: bId }, hA, 20000);
    assert.equal(synced.result.pulled.length, 1);
    await Promise.race([
      gotNotify,
      new Promise((_, reject) => setTimeout(() => reject(new Error("link_sync notification timeout")), 5000)),
    ]);
    assert.equal(notified.type, undefined, "linkd only posts the payload; gateway adds type");
    assert.equal(notified.pulled, 1);
    assert.equal(notified.peer.id, bId);
    const origins = await waitJson(baseA + "/api/origins", hA);
    assert.ok(origins.rev >= 1);
    assert.ok(origins.revAt >= 1);
  } finally {
    for (const p of [a, b]) if (p.exitCode == null) p.kill("SIGKILL");
    await new Promise((resolve) => gateway.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

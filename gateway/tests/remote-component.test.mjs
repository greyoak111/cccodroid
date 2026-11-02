import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import { buildRemoteComponent } from "../../scripts/build-remote-component.mjs";
import { readRemotePayload } from "../gw/remote-component-layout.mjs";
import { createRemoteComponentManager } from "../gw/remote-component.mjs";
import { createRemoteComponentRoute } from "../gw/remote-component-route.mjs";
import { appJs } from "../gw/http.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-component-test-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const base = "b".repeat(64);
const bundle = buildRemoteComponent({ out: path.join(dir, "build"), base });
const rec = () => ({ id: "remote-session", state: "ok", version: bundle.build.version, base });
function setup(name, extra = {}) {
  const prefix = path.join(dir, name, "usr"), home = path.join(dir, name, "home");
  fs.mkdirSync(home, { recursive: true }); fs.cpSync(bundle.usr, prefix, { recursive: true });
  let record = rec(), created = 0, retires = 0, disposes = 0, blocked = false;
  const runtime = { status: async () => ({ snapshot: { safe: true } }), subscribe: () => () => {},
    async retire() { blocked = true; retires++; }, async dispose() { disposes++; } };
  const manager = createRemoteComponentManager({ prefix, home, readRecord: () => record, readDevkit: () => ({ sha256: base }),
    createRuntime: async () => { created++; blocked = false; return runtime; }, ...extra });
  return { manager, prefix, home, runtime, get created() { return created; }, get retires() { return retires; }, get disposes() { return disposes; }, get blocked() { return blocked; }, record: (value) => { record = value; } };
}

test("component package has only feature-owned paths, manifest, no install/host override or private key", () => {
  assert.equal(bundle.build.bin.length, 0);
  assert.equal(bundle.entry.hostApi.remoteSession, 1);
  assert.equal(bundle.build.verified, false);
  const owned = fs.readFileSync(path.join(bundle.usr, "libexec/devkit/components/remote-session/FILES"), "utf8").trim().split("\n");
  assert.ok(owned.length > 15);
  for (const rel of owned) assert.match(rel, /^(share\/cccodroid\/components\/remote-session|libexec\/devkit\/components\/remote-session)\//);
  assert.ok(owned.every((rel) => !/first-run|app\/gw|app\/web|\.pem$|\.key$|keystore|\.claude|SKILL\.md/.test(rel)));
  const payload = readRemotePayload(bundle.usr, { record: rec(), devkit: { sha256: base } });
  assert.equal(payload.assetVersion, bundle.manifest.assetVersion);
  assert.ok(payload.js.length > 10000);
  new vm.Script(payload.js.toString("utf8"));
});

test("trusted Android PREFIX alias is canonicalized but component descendant symlinks stay forbidden", () => {
  const alias = path.join(dir, "prefix-alias"); fs.symlinkSync(bundle.usr, alias);
  const payload = readRemotePayload(alias, { record: rec(), devkit: { sha256: base } });
  assert.equal(payload.assetVersion, bundle.manifest.assetVersion);
});

test("component archive is byte-reproducible for identical inputs", () => {
  const repeat = buildRemoteComponent({ out: path.join(dir, "repeat"), base });
  assert.equal(repeat.build.sha256, bundle.build.sha256);
});

test("host app.js excludes remote implementation and parses without the optional component", () => {
  const js = appJs().toString("utf8");
  assert.doesNotMatch(js, /const createRemoteTransport =/);
  assert.doesNotMatch(js, /Restricted phone transport/);
  new vm.Script(js);
});

test("absent component does not import, instantiate or read source adapters", async () => {
  const s = setup("absent"); s.record(null);
  assert.equal((await s.manager.status()).state, "absent");
  assert.equal(s.created, 0);
  await assert.rejects(s.manager.invoke("status"), { code: "REMOTE_UNAVAILABLE" });
  await assert.rejects(s.manager.enable(), { code: "COMPONENT_NOT_INSTALLED" });
  assert.equal(s.created, 0); await s.manager.close();
});

test("install activates, disable immediately blocks and persists before async cleanup", async () => {
  const s = setup("disable");
  assert.equal((await s.manager.status()).enabled, true);
  assert.equal(s.created, 1);
  const disabled = s.manager.disable();
  assert.equal(s.manager.ready, false);
  assert.equal(s.blocked, true);
  const preference = JSON.parse(fs.readFileSync(path.join(s.home, ".cccodroid/remote-session/component-state.json"), "utf8"));
  assert.equal(preference.enabled, false);
  assert.equal((await disabled).state, "disabled");
  await assert.rejects(s.manager.invoke("status"), { code: "REMOTE_UNAVAILABLE" });
  assert.equal((await s.manager.enable()).state, "active");
  assert.equal(s.created, 2); await s.manager.close();
});

test("runtime activation identity is stable while live and changes across same-content re-enable and manager restart", async () => {
  const s = setup("activation");
  const first = await s.manager.status();
  assert.match(first.activationId, /^[a-f0-9-]{36}$/);
  assert.equal((await s.manager.status()).activationId, first.activationId);
  assert.equal((await s.manager.enable()).activationId, first.activationId, "no-op enable keeps the live instance");
  const disabled = await s.manager.disable(); assert.equal(disabled.activationId, null);
  const second = await s.manager.enable();
  assert.equal(second.assetVersion, first.assetVersion); assert.notEqual(second.activationId, first.activationId);
  await s.manager.close();
  const reopened = createRemoteComponentManager({ prefix: s.prefix, home: s.home, readRecord: rec, readDevkit: () => ({ sha256: base }),
    createRuntime: async () => s.runtime });
  const third = await reopened.status();
  assert.equal(third.assetVersion, second.assetVersion); assert.notEqual(third.activationId, second.activationId);
  await reopened.close();
});

test("disable during an in-flight component factory cannot install a late runtime", async () => {
  let resolve, started;
  const beginning = new Promise((r) => { started = r; });
  const creating = new Promise((r) => { resolve = r; });
  let retired = false, disposed = false;
  const s = setup("factory-race", { createRuntime: async () => { started(); return creating; } });
  const status = s.manager.status(); await beginning;
  const off = s.manager.disable();
  resolve({ async retire() { retired = true; }, async dispose() { disposed = true; } });
  await status; await off;
  assert.equal(retired, true); assert.equal(disposed, true);
  assert.equal((await s.manager.status()).state, "disabled"); assert.equal(s.manager.ready, false);
  await s.manager.close();
});

test("a factory resolving after disable is disposed even when its own retirement rejects", async () => {
  let release, started, disposed = false;
  const beginning = new Promise((resolve) => { started = resolve; }), creating = new Promise((resolve) => { release = resolve; });
  const s = setup("late-factory-retire-error", { createRuntime: async () => { started(); return creating; } });
  const status = s.manager.status(); await beginning;
  const disabled = s.manager.disable();
  release({ async retire() { throw new Error("synthetic late retirement failure"); }, async dispose() { disposed = true; } });
  await status; await disabled;
  assert.equal(disposed, true); assert.equal(s.manager.ready, false);
  assert.equal((await s.manager.status()).state, "disabled"); await s.manager.close();
});

test("uninstall clears live runtime, old assets and does not resurrect on reinstall without enable", async () => {
  const s = setup("uninstall"); await s.manager.status();
  await s.manager.disable(); s.record(null);
  assert.equal((await s.manager.status()).state, "absent");
  await assert.rejects(s.manager.asset("js", bundle.manifest.assetVersion), { code: "COMPONENT_VERSION_MISMATCH" });
  s.record(rec());
  assert.equal((await s.manager.status()).state, "disabled");
  assert.equal(s.created, 1); assert.ok(s.retires >= 1); await s.manager.close();
});

test("damaged, outdated, symlinked or incompatible component is not executed", async () => {
  const s = setup("damaged"); s.record({ ...rec(), base: "c".repeat(64) });
  assert.equal((await s.manager.status()).state, "incompatible");
  assert.equal(s.created, 0); s.record(rec());
  const manifestFile = path.join(s.prefix, "share/cccodroid/components/remote-session/component.json");
  const bytes = fs.readFileSync(manifestFile), manifest = JSON.parse(bytes);
  manifest.hostApi.remoteSession = 2; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal((await s.manager.status()).state, "incompatible");
  fs.writeFileSync(manifestFile, bytes);
  const entry = path.join(s.prefix, "share/cccodroid/components/remote-session/releases", manifest.assetVersion, "gateway/component.mjs");
  fs.appendFileSync(entry, "\n// changed\n");
  assert.equal((await s.manager.status()).state, "error");
  const body = fs.readFileSync(entry); fs.unlinkSync(entry); fs.writeFileSync(entry + ".copy", body); fs.symlinkSync(entry + ".copy", entry);
  assert.equal((await s.manager.status()).state, "error");
  assert.equal(s.created, 0); await s.manager.close();
});

test("corrupt preference fails closed rather than silently resetting to enabled", async () => {
  const s = setup("bad-state"); await s.manager.disable(); await s.manager.close();
  fs.writeFileSync(path.join(s.home, ".cccodroid/remote-session/component-state.json"), "{bad");
  const reopened = createRemoteComponentManager({ prefix: s.prefix, home: s.home, readRecord: rec, readDevkit: () => ({ sha256: base }), createRuntime: () => assert.fail("must not instantiate") });
  assert.equal((await reopened.status()).error, "COMPONENT_STATE_INVALID"); await reopened.close();
});

test("initialization failure disables only remote and is not retried by every state poll", async () => {
  let starts = 0;
  const s = setup("init-failure", { createRuntime: async () => { starts++; throw new Error("corrupt optional metadata"); } });
  assert.equal((await s.manager.status()).error, "REMOTE_UNAVAILABLE");
  for (let n = 0; n < 8; n++) assert.equal((await s.manager.status()).state, "error");
  assert.equal(starts, 1);
  await assert.rejects(s.manager.enable(), { code: "REMOTE_UNAVAILABLE" });
  assert.equal(starts, 2); await s.manager.close();
});

test("failed retirement drops the old instance and a later enable creates a non-null new activation", async () => {
  const instances = [];
  const s = setup("retire-failure", { createRuntime: async () => {
    const instance = { disposed: false, async status() { return { old: instances.indexOf(instance) === 0 }; }, subscribe: () => () => {},
      async retire() { if (instances.indexOf(instance) === 0) throw Object.assign(new Error("synthetic fsync failure"), { code: "EIO" }); },
      async dispose() { instance.disposed = true; } };
    instances.push(instance); return instance;
  } });
  const first = await s.manager.status();
  await assert.rejects(s.manager.disable(), { code: "EIO" });
  assert.equal(s.manager.ready, false); assert.equal(instances[0].disposed, true);
  const second = await s.manager.enable();
  assert.equal(second.state, "active"); assert.match(second.activationId, /^[a-f0-9-]{36}$/);
  assert.notEqual(second.activationId, first.activationId); assert.equal(instances.length, 2);
  assert.equal((await s.manager.invoke("status")).old, false); await s.manager.close();
});

test("a delayed request body and an old page activation cannot dispatch into a replacement component", async () => {
  const calls = [], s = setup("request-generation", { createRuntime: async () => ({
    async invite(value) { calls.push(value); return { ok: true }; }, subscribe: () => () => {}, async retire() {}, async dispose() {},
  }) });
  const first = await s.manager.status(), route = createRemoteComponentRoute(s.manager);
  const req = new PassThrough(); req.method = "POST"; req.ccAuthed = true;
  req.headers = { "x-cc-remote-activation": first.activationId };
  const response = () => ({ setHeader() {}, writeHead(code) { this.status = code; }, end(value) { this.value = JSON.parse(String(value)); } });
  const res = response(), target = new URL("http://127.0.0.1/api/remote/hosting");
  const work = route(req, res, target, target.pathname);
  await new Promise((resolve) => setImmediate(resolve));
  await s.manager.disable(); const second = await s.manager.enable(); assert.notEqual(first.activationId, second.activationId);
  req.end(JSON.stringify({ action: "invite", localSessionId: "synthetic-session", deviceId: "synthetic-phone" }));
  await work; assert.equal(res.status, 409); assert.equal(res.value.code, "COMPONENT_VERSION_MISMATCH");
  for (const headers of [req.headers, {}]) {
    const stale = new PassThrough(); stale.method = "POST"; stale.ccAuthed = true; stale.headers = headers;
    const rejected = response(), old = route(stale, rejected, target, target.pathname); stale.end("{}"); await old;
    assert.equal(rejected.status, 409); assert.equal(rejected.value.code, "COMPONENT_VERSION_MISMATCH");
  }
  assert.deepEqual(calls, []);
  await s.manager.close();
});

test("the event stream cannot subscribe to a replacement activation after the route status await", async () => {
  let generation = "11111111-1111-4111-8111-111111111111", subscriptions = 0;
  const original = generation;
  const manager = {
    watch() {}, async status() {
      generation = "22222222-2222-4222-8222-222222222222";
      return { enabled: true, activationId: original };
    },
    subscribeAt(activation) {
      if (activation !== generation) throw Object.assign(new Error("stale"), { code: "COMPONENT_VERSION_MISMATCH" });
      subscriptions++; return () => {};
    },
  };
  const route = createRemoteComponentRoute(manager), target = new URL("http://127.0.0.1/api/remote/events?activation=" + original);
  for (let i = 0; i < 10; i++) {
    const req = new PassThrough(); req.method = "GET"; req.ccAuthed = true; req.headers = {};
    const res = new PassThrough(); res.setHeader = () => {}; const statuses = [];
    res.writeHead = (status) => statuses.push(status);
    const chunks = []; res.on("data", (value) => chunks.push(value));
    await route(req, res, target, target.pathname); req.end();
    assert.deepEqual(statuses, [409]);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).code, "COMPONENT_VERSION_MISMATCH");
  }
  assert.equal(subscriptions, 0);
});

test("an enabled-to-enabled activation change closes only event streams from the old instance", async () => {
  let current = '11111111-1111-4111-8111-111111111111', watch, releases = 0;
  const manager = { watch(fn) { watch = fn; }, async status() { return { enabled: true, activationId: current }; },
    subscribeAt(activation) { assert.equal(activation, current); return () => { releases++; }; } };
  const route = createRemoteComponentRoute(manager), streams = [];
  const subscribe = async () => {
    const req = new PassThrough(); req.method = 'GET'; req.ccAuthed = true; req.headers = {};
    const res = new PassThrough(); res.setHeader = () => {}; res.writeHead = () => {}; res.resume();
    const target = new URL('http://127.0.0.1/api/remote/events?activation=' + current);
    await route(req, res, target, target.pathname); streams.push({ req, res }); return res;
  };
  try {
    const old = await subscribe(); current = '22222222-2222-4222-8222-222222222222';
    watch({ enabled: true, activationId: current }); assert.equal(old.writableEnded, true);
    const next = await subscribe(); watch({ enabled: true, activationId: current }); assert.equal(next.writableEnded, false);
    watch({ enabled: false, activationId: null }); assert.equal(next.writableEnded, true);
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(releases, 2);
  } finally { for (const { req, res } of streams) { req.destroy(); res.destroy(); } }
});

test("closing the manager synchronously retires its public status and closes an open event stream", async () => {
  const s = setup('close-event-stream'), route = createRemoteComponentRoute(s.manager), current = await s.manager.status();
  const req = new PassThrough(); req.method = 'GET'; req.ccAuthed = true; req.headers = {};
  const res = new PassThrough(); res.setHeader = () => {}; res.writeHead = () => {}; res.resume();
  const url = new URL('http://127.0.0.1/api/remote/events?activation=' + current.activationId);
  try {
    await route(req, res, url, url.pathname);
    const closing = s.manager.close(); assert.equal(res.writableEnded, true);
    assert.equal(s.manager.peek().activationId, null); assert.equal(s.manager.ready, false); await closing;
  } finally { req.destroy(); res.destroy(); await s.manager.close(); }
});

test("HTTP lifecycle stays authenticated, exact-schema, version-pinned and no-store", async () => {
  const s = setup("route"), route = createRemoteComponentRoute(s.manager);
  const server = http.createServer(async (req, res) => {
    req.ccAuthed = req.headers.authorization === "fixture";
    const url = new URL(req.url, "http://127.0.0.1"); await route(req, res, url, url.pathname);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(origin + "/api/components/remote-session/status")).status, 403);
    const options = { headers: { authorization: "fixture" } };
    const active = await fetch(origin + "/api/components/remote-session/status", options).then((r) => r.json());
    assert.equal(active.enabled, true);
    const asset = await fetch(origin + "/api/components/remote-session/ui.js?version=" + active.assetVersion, options);
    assert.equal(asset.status, 200); assert.equal(asset.headers.get("cache-control"), "no-store");
    assert.match(asset.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.equal((await fetch(origin + "/api/components/remote-session/ui.js?version=" + "0".repeat(64), options)).status, 409);
    assert.equal((await fetch(origin + "/api/components/remote-session/disable", { ...options, method: "POST", body: '{"command":"stop"}' })).status, 400);
    const result = await fetch(origin + "/api/components/remote-session/disable", { ...options, method: "POST", body: "{}" }).then((r) => r.json());
    assert.equal(result.component.state, "disabled");
    assert.equal((await fetch(origin + "/api/remote/status", options)).status, 503);
  } finally { await s.manager.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

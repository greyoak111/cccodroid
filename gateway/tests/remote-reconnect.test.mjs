import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRelayClient } from "../gw/remote/relay-client.mjs";
import { createRemoteRuntime } from "../gw/remote/runtime.mjs";
import { createRemoteStore } from "../gw/remote/store.mjs";
import { createSourceAdapter } from "../gw/remote/tablet-data.mjs";
import { createTunnelRelayServer } from "../../remote-relay/src/tunnel-server.mjs";
import { disposableCredentials } from "./fixtures/remote-app/tls-channel.mjs";
import { createOriginalRunFixture, LOCAL_SESSION, until, sleep } from "./fixtures/remote-app/original-run.mjs";

if (process.env.CCAPP_TEST !== "1" || process.env.HOME !== process.env.CCAPP_HOME) throw new Error("Use scripts/test.mjs with disposable HOME/PREFIX");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function manualRelay(t) {
  const sockets = [], connections = [];
  class Socket {
    constructor() { this.listeners = new Map(); this.sent = []; this.readyState = 0; this.bufferedAmount = 0; this.closes = 0; sockets.push(this); }
    addEventListener(event, fn) { const listeners = this.listeners.get(event) || []; listeners.push(fn); this.listeners.set(event, listeners); }
    emit(event, value = {}) { for (const fn of this.listeners.get(event) || []) fn(value); }
    frame(value) { this.emit("message", { data: JSON.stringify({ v: 1, ...value }) }); }
    open() { this.readyState = 1; this.emit("open"); }
    send(text) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text)); }
    close() { this.closes++; this.readyState = 3; } // Deliberately retain queued browser callbacks.
  }
  const client = createRelayClient({ serverUrl: "http://127.0.0.1", allowLoopback: true, deviceId: "synthetic-local", token: "s".repeat(43), WebSocketClass: Socket, timeoutMs: 1000 });
  client.on("connection", (event) => connections.push(event.state));
  t.after(() => client.dispose());
  const auth = (socket) => { socket.open(); socket.frame({ op: "auth.ok", deviceId: "synthetic-local", relayInstanceId: "synthetic-relay" }); };
  const opened = (socket, tunnelId) => socket.frame({ op: "tunnel.opened", tunnelId, fromDeviceId: "synthetic-local", toDeviceId: "synthetic-peer", purpose: "peer" });
  return { client, sockets, connections, auth, opened };
}

test("retired WebSocket open/message/error/close callbacks cannot touch its replacement", async (t) => {
  const f = manualRelay(t), first = f.client.connect(); f.auth(f.sockets[0]); await first;
  const retired = f.sockets[0]; f.client.disconnect();
  const second = f.client.connect(); f.auth(f.sockets[1]); await second;
  const current = f.sockets[1], opening = f.client.openTunnel("synthetic-peer");
  const tunnelId = current.sent.find((frame) => frame.op === "tunnel.open").tunnelId;
  f.opened(current, tunnelId); const stream = await opening;
  const sent = current.sent.length;
  retired.emit("open");
  retired.emit("message", { data: "not-json-from-retired-socket" });
  retired.emit("error"); retired.emit("close");
  await tick();
  assert.equal(f.client.online, true, "old callbacks must not disconnect a newly authenticated socket");
  assert.equal(stream.destroyed, false, "old callbacks must not destroy a new TLS transport");
  assert.equal(current.closes, 0); assert.equal(current.sent.length, sent, "old open must not authenticate on the new socket");
  assert.deepEqual(f.connections, ["online", "offline", "online"]);
  const ping = f.client.ping(); current.frame({ op: "pong" }); assert.equal(await ping, true);
});

test("failed authentication cleanup cannot strand or clear a newer connect attempt", async (t) => {
  const f = manualRelay(t), first = f.client.connect();
  const failure = assert.rejects(first, { code: "OFFLINE" });
  f.sockets[0].emit("error");
  const second = f.client.connect(); second.catch(() => {});
  assert.equal(f.sockets.length, 2, "a failed socket is no longer the in-flight connection");
  await failure;
  const third = f.client.connect(); third.catch(() => {});
  assert.equal(f.sockets.length, 2, "the retired attempt's finally must not clear the newer single-flight promise");
  f.auth(f.sockets[1]); await Promise.all([second, third]);
  f.sockets[0].emit("close"); assert.equal(f.client.online, true);
});

test("late tunnel_missing from a retired close cannot reject a new open or ping", async (t) => {
  const f = manualRelay(t), ready = f.client.connect(); f.auth(f.sockets[0]); await ready;
  const socket = f.sockets[0], opening = f.client.openTunnel("synthetic-peer"), ping = f.client.ping();
  const tunnelId = socket.sent.find((frame) => frame.op === "tunnel.open").tunnelId;
  socket.frame({ op: "error", code: "tunnel_missing" });
  f.opened(socket, tunnelId); socket.frame({ op: "pong" });
  const results = await Promise.allSettled([opening, ping]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"], "uncorrelated close/data errors cannot cancel unrelated requests");
  assert.equal(results[0].value.destroyed, false);
});

test("a late initiator tunnel with no waiter is closed rather than becoming an orphan", async (t) => {
  const f = manualRelay(t), ready = f.client.connect(); f.auth(f.sockets[0]); await ready;
  const socket = f.sockets[0], opening = f.client.openTunnel("synthetic-peer");
  const tunnelId = socket.sent.find((frame) => frame.op === "tunnel.open").tunnelId;
  const failure = assert.rejects(opening, { code: "RELAY_REJECTED" });
  socket.frame({ op: "error", code: "peer_offline" }); await failure;
  f.opened(socket, tunnelId); await tick();
  assert.equal(socket.sent.filter((frame) => frame.op === "tunnel.close" && frame.tunnelId === tunnelId).length, 1, "unclaimed opened streams otherwise pin the receiver to a TLS orphan");
  assert.equal(f.client.online, true);
});

test("in-flight ciphertext for a locally closed tunnel cannot disconnect another tunnel", async (t) => {
  const f = manualRelay(t), ready = f.client.connect(); f.auth(f.sockets[0]); await ready;
  const socket = f.sockets[0];
  const first = f.client.openTunnel("synthetic-peer");
  const retiredId = socket.sent.at(-1).tunnelId; f.opened(socket, retiredId); const retired = await first;
  retired.destroy();
  const second = f.client.openTunnel("synthetic-peer");
  const currentId = socket.sent.at(-1).tunnelId; f.opened(socket, currentId); const current = await second;
  socket.frame({ op: "tunnel.data", tunnelId: retiredId, data: Buffer.from("synthetic-old-ciphertext").toString("base64") });
  await tick();
  assert.equal(f.client.online, true); assert.equal(current.destroyed, false);
});

test("retired tunnel handling still rejects unknown routing and actual open authorization errors", async (t) => {
  const f = manualRelay(t), ready = f.client.connect(); f.auth(f.sockets[0]); await ready;
  const socket = f.sockets[0], opening = f.client.openTunnel("synthetic-peer");
  const denied = assert.rejects(opening, { code: "RELAY_REJECTED" });
  socket.frame({ op: "error", code: "unpaired" }); await denied;
  assert.equal(f.client.online, true);
  socket.frame({ op: "tunnel.data", tunnelId: "never-opened", data: Buffer.from("unknown-ciphertext").toString("base64") });
  assert.equal(f.client.online, false, "only known retired IDs may discard already-committed ciphertext");
});

const dummySource = { describe: () => null, readHistory: async () => ({ entries: [], cursor: null }), current: () => null };
const dummyExecutor = { capabilities: {}, getRun: () => null, getRunOfSession: () => null, submitText: () => false, answerPerm: () => false, abortRun: () => false, onEvent: () => () => {} };
const hostAdapter = { available: false, async status() { return { shouldConnect: true, foreground: true }; }, async syncNotifications() {}, async clearNotifications() {}, async reportConnectionState() {}, async setBackgroundEnabled() {}, watchPolicy() { return () => {}; } };
function memoryStore(identity, serverUrl, token) {
  const vault = new Map();
  const store = createRemoteStore(null, { async seal(value) { const key = "synthetic-vault-" + vault.size; vault.set(key, value); return key; }, async unseal(key) { assert.ok(vault.has(key)); return vault.get(key); } });
  store.setIdentity(identity);
  return store.configure({ serverUrl, deviceName: identity.name || "Synthetic device" }, JSON.stringify({ deviceId: identity.deviceId, token })).then(() => store);
}

async function connectFixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.CCAPP_WORKSPACE, "reconnect-flight-"));
  const identity = { deviceId: "dev_" + Buffer.alloc(32, 17).toString("base64url"), spkiSha256: Buffer.alloc(32, 17).toString("base64url"), name: "Synthetic device" };
  const store = await memoryStore(identity, "https://relay.example.invalid", "s".repeat(43)), relays = [];
  const relayFactory = () => {
    const listeners = new Map(), relay = { online: false, disposed: false, on(name, fn) { listeners.set(name, fn); }, async connect() { await tick(); if (relay.disposed) throw Object.assign(new Error("OFFLINE"), { code: "OFFLINE" }); relay.online = true; listeners.get("connection")?.({ state: "online" }); }, dispose() { relay.disposed = true; relay.online = false; } };
    relays.push(relay); return relay;
  };
  const runtime = await createRemoteRuntime({ home: root, sourceAdapter: dummySource, executor: dummyExecutor, identityBundle: { identity, credentials: {} }, store, hostAdapter, relayFactory });
  t.after(async () => { await runtime.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { runtime, store, relays };
}

test("concurrent runtime connect callers share one relay authentication", async (t) => {
  const f = await connectFixture(t);
  const results = await Promise.allSettled([f.runtime.connect(), f.runtime.connect(), f.runtime.connect()]);
  assert.equal(f.relays.length, 1, "parallel API/policy calls must not replace each other's authenticated route");
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled"]);
});

test("a credential read begun before disconnect cannot replace the new runtime relay", async (t) => {
  const f = await connectFixture(t), credential = f.store.credential.bind(f.store), held = deferred(), entered = deferred();
  let first = true;
  f.store.credential = async () => { if (first) { first = false; entered.resolve(); await held.promise; } return credential(); };
  const old = f.runtime.connect(), outcome = assert.rejects(old, { code: "OFFLINE" });
  await entered.promise; await f.runtime.disconnect();
  await f.runtime.connect(); const current = f.relays.at(-1);
  held.resolve(); await outcome;
  assert.equal(f.relays.length, 1); assert.equal(current.disposed, false);
  assert.equal((await f.runtime.settings()).connection.state, "online");
});

test("runtime configure rejects a concurrent writer before registering or replacing its relay", async (t) => {
  const f = await connectFixture(t), seal = f.store.configure.bind(f.store), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.store.configure = async (...args) => { entered.resolve(); await release.promise; return seal(...args); };
  const config = f.store.config(), saving = f.runtime.configure({ serverUrl: config.serverUrl, deviceName: "Changed synthetic name" });
  saving.catch(() => {}); await entered.promise;
  await assert.rejects(f.runtime.configure({ serverUrl: config.serverUrl, deviceName: "Must not win" }), { code: "LIMIT_EXCEEDED" });
  release.resolve(); await saving;
  assert.equal(f.store.config().deviceName, "Changed synthetic name"); assert.equal(f.relays.length, 1);
});

test("runtime retirement invalidates a real pending store seal before a replacement store writes", async (t) => {
  const f = await connectFixture(t), entered = deferred(), release = deferred();
  const root = await fs.mkdtemp(path.join(process.env.CCAPP_WORKSPACE, 'remote-retire-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'metadata.json'), store = createRemoteStore(file, {
    async seal(value) { entered.resolve(); await release.promise; return 'sealed-synthetic:' + value; },
    async unseal() { return ''; },
  });
  store.setIdentity(f.store.identity()); await store.configure(f.store.config());
  const runtime = await createRemoteRuntime({ home: path.join(root, 'runtime'), sourceAdapter: dummySource, executor: dummyExecutor,
    identityBundle: { identity: f.store.identity(), credentials: {} }, store, hostAdapter, relayFactory: () => assert.fail('configure must not connect a retired runtime') });
  t.after(() => runtime.dispose()); t.after(() => release.resolve());
  const pending = runtime.configure({ serverUrl: store.config().serverUrl, deviceName: 'Retired name', credential: JSON.stringify({ deviceId: f.store.identity().deviceId, token: 'r'.repeat(43) }) });
  const rejected = assert.rejects(pending, { code: 'REMOTE_STORE_STALE_CONFIG' });
  await entered.promise; await runtime.retire();
  const replacement = createRemoteStore(file); await replacement.configure({ ...f.store.config(), deviceName: 'Current instance' });
  const current = await fs.readFile(file); release.resolve(); await rejected;
  assert.deepEqual(await fs.readFile(file), current); assert.notEqual(store.config().deviceName, 'Retired name');
});

test("unpair invalidates a pairJoin awaiting tunnel open before any TLS attempt or store commit", async (t) => {
  const f = await connectFixture(t); await f.runtime.connect();
  const pending = deferred(), entered = deferred(), connection = f.relays.at(-1);
  t.after(() => pending.resolve(new PassThrough()));
  connection.openTunnel = async () => { entered.resolve(); return pending.promise; };
  const pin = Buffer.alloc(32, 21).toString("base64url"), peerId = "dev_" + pin;
  const code = JSON.stringify({ v: 1, type: "cc-remote-pairing", offerId: "synthetic-pair-offer", tablet: { deviceId: peerId, spkiSha256: pin, name: "Synthetic other device" }, secret: Buffer.alloc(32, 22).toString("base64url"), issuedAt: Date.now(), expiresAt: Date.now() + 30000 });
  const joining = f.runtime.pairJoin({ code }), rejected = assert.rejects(joining, { code: "OFFLINE" });
  await entered.promise;
  await f.runtime.unpair({ deviceId: peerId }, false);
  const stream = new PassThrough(); pending.resolve(stream); await rejected;
  assert.equal(stream.destroyed, true); assert.deepEqual(f.store.peers(), []);
  assert.deepEqual((await f.runtime.pairing()).pending, []);
});

test("changing a relay while paired fails before registration or any network replacement", async (t) => {
  const f = await connectFixture(t), previous = f.store.config();
  f.store.putPeer({ deviceId: "synthetic-existing-peer", spkiSha256: Buffer.alloc(32, 23).toString("base64url"), name: "Fixture peer" });
  await assert.rejects(f.runtime.configure({ serverUrl: "https://must-not-contact.invalid", deviceName: "Synthetic change", credential: "synthetic-enrollment-token" }), { code: "PAIRED_RELAY_CHANGE" });
  assert.deepEqual(f.store.config(), previous); assert.equal(f.relays.length, 0);
});

/** Real local relay/TLS/original child; only event delivery and source capture can be held. */
async function reconnectChain(t, { hostFirst = true } = {}) {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const root = await fs.mkdtemp(path.join(original.workspace, "reconnect-chain-"));
  const identities = await Promise.all([disposableCredentials(root, "first"), disposableCredentials(root, "second")]);
  identities.sort((a, b) => a.identity.deviceId < b.identity.deviceId ? -1 : 1);
  const hostIdentity = identities[hostFirst ? 0 : 1], phoneIdentity = identities[hostFirst ? 1 : 0];
  hostIdentity.identity = { ...hostIdentity.identity, name: "Synthetic tablet" }; phoneIdentity.identity = { ...phoneIdentity.identity, name: "Synthetic phone" };
  const logs = [], sockets = [], streams = [], race = { tunnelId: null, close: null, armed: false, injected: false, withheld: [] };
  const relay = await createTunnelRelayServer({ devices: [{ deviceId: hostIdentity.identity.deviceId, token: "h".repeat(43) }, { deviceId: phoneIdentity.identity.deviceId, token: "p".repeat(43) }], pairs: [[hostIdentity.identity.deviceId, phoneIdentity.identity.deviceId]], logger: (event) => logs.push(event), limits: { messagesPerSecond: 200, messageBurst: 200 } });
  await relay.listen(); const serverUrl = "http://127.0.0.1:" + relay.address().port;
  const hostStore = await memoryStore(hostIdentity.identity, serverUrl, "h".repeat(43)), phoneStore = await memoryStore(phoneIdentity.identity, serverUrl, "p".repeat(43));
  hostStore.putPeer(phoneIdentity.identity); phoneStore.putPeer(hostIdentity.identity);
  const relayFactory = (options) => {
    class Socket {
      constructor(url) {
        this.side = options.deviceId === hostIdentity.identity.deviceId ? "host" : "phone"; this.listeners = new Map(); this.sent = [];
        this.socket = new WebSocket(url); sockets.push(this);
        for (const event of ["open", "message", "error", "close"]) this.socket.addEventListener(event, (value) => {
          const frame = event === "message" ? JSON.parse(value.data) : null;
          if (this.side === "host" && race.armed && frame?.op === "tunnel.closed" && frame.tunnelId === race.tunnelId) { race.withheld.push({ socket: this, value }); return; }
          if (this.holdIncoming?.(event, frame)) { this.heldIncoming.push({ event, value }); return; }
          if (frame?.op === "tunnel.data" && this.holdData) { this.holdData.push(value); return; }
          this.emit(event, value);
        });
      }
      get readyState() { return this.socket.readyState; }
      get bufferedAmount() { return this.socket.bufferedAmount; }
      addEventListener(name, fn) { const listeners = this.listeners.get(name) || []; listeners.push(fn); this.listeners.set(name, listeners); }
      emit(name, value) { for (const fn of this.listeners.get(name) || []) fn(value); }
      send(text) {
        const frame = JSON.parse(text); this.sent.push(frame);
        if (this.side === "host" && race.armed && frame.op === "tunnel.close" && frame.tunnelId === race.tunnelId) { race.close = text; return; }
        if (this.side === "host" && race.armed && frame.op === "tunnel.open" && race.close) {
          this.socket.send(race.close); race.close = null; race.injected = true;
        }
        this.socket.send(text);
      }
      close() { this.socket.close(); }
    }
    const client = createRelayClient({ ...options, WebSocketClass: Socket });
    return { get online() { return client.online; }, on: client.on, connect: client.connect, dispose: client.dispose,
      async openTunnel(...args) { const stream = await client.openTunnel(...args); streams.push({ side: options.deviceId === hostIdentity.identity.deviceId ? "host" : "phone", stream }); return stream; },
      hint: client.hint, ackHint: client.ackHint, ping: client.ping, registerOffer: client.registerOffer, confirmPair: client.confirmPair, revokePair: client.revokePair };
  };
  const { findSessionFile, peekSession } = await import("../gw/sessions.mjs"), { transcriptItems } = await import("../gw/transcript.mjs");
  const rawSource = createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession: original.runOfSession, onPublish: original.onPublish });
  let captureGate = null;
  const captureGates = new Set();
  const sourceAdapter = { ...rawSource, async readHistory(...args) { if (captureGate) { const gate = captureGate; if (gate.once) captureGate = null; gate.entered.resolve(); await gate.promise; } return rawSource.readHistory(...args); } };
  const executor = { ...dummyExecutor, capabilities: { literalText: true, messageReplay: true, remoteOnce: true, planDefault: true }, getRun: (id) => original.RUNS.get(id), getRunOfSession: original.runOfSession, submitText: original.enqueueRemoteText, answerPerm: (run, id, answer, options) => run.answerPerm(id, answer, options), abortRun: original.abortRun, onEvent: original.onPublish };
  const host = await createRemoteRuntime({ home: path.join(root, "host"), sourceAdapter, executor, identityBundle: hostIdentity, store: hostStore, hostAdapter, relayFactory, allowLoopback: true });
  const phone = await createRemoteRuntime({ home: path.join(root, "phone"), sourceAdapter: dummySource, executor: dummyExecutor, identityBundle: phoneIdentity, store: phoneStore, hostAdapter, relayFactory, allowLoopback: true });
  t.after(async () => { for (const gate of captureGates) gate.resolve(); await Promise.allSettled([host.dispose(), phone.dispose()]); await relay.close(); await fs.rm(root, { recursive: true, force: true }); });
  await Promise.all([host.connect(), phone.connect()]);
  const result = await host.invite({ localSessionId: LOCAL_SESSION, deviceId: phoneIdentity.identity.deviceId });
  const handle = result.hosting.remoteSessionId;
  await until(async () => (await phone.list()).snapshot.sessions.some((entry) => entry.remoteSessionId === handle), "real reconnect fixture invitation");
  await phone.accept({ remoteSessionId: handle });
  return { original, host, phone, relay, logs, streams, sockets, race, handle,
    holdSnapshots({ once = false } = {}) {
      const gate = { ...deferred(), entered: deferred(), once }; captureGate = gate; captureGates.add(gate);
      return { entered: gate.entered.promise, release() { if (captureGate === gate) captureGate = null; captureGates.delete(gate); gate.resolve(); } };
    },
    diagnostics: async () => ({ hostFirst, host: await host.settings(), phone: await phone.settings(), snapshot: (await phone.status()).snapshot, relay: relay.stats(), logs, race: { armed: race.armed, injected: race.injected, withheld: race.withheld.length } }) };
}

test("real reconnect survives retired tunnel.close → tunnel_missing → new tunnel.opened without TLS orphans", async (t) => {
  const f = await reconnectChain(t);
  const run = await f.original.start();
  const before = await until(async () => { const s = (await f.phone.status()).snapshot; return s.pending.length ? s : false; }, "original pending before race");
  await sleep(220); // The transport-error isolate excludes already-scheduled source snapshots.
  const old = f.streams.find((entry) => entry.side === "host").stream;
  f.race.armed = true; f.race.tunnelId = old.tunnelId;
  await f.phone.disconnect();
  await until(() => f.relay.stats().tunnels === 0 && f.race.withheld.length === 1, "server retires tunnel while host close notification is queued");
  old.destroy(); await until(() => !!f.race.close, "locally closed TLS emits late old tunnel.close");
  assert.equal((await f.phone.status()).snapshot.canControl, false);
  await f.phone.connect();
  try {
    await until(async () => (await f.phone.status()).snapshot.canControl, "new TLS survives unrelated old close rejection");
    assert.equal(f.race.injected, true); assert.equal(f.relay.stats().rejected, 1);
    assert.equal(f.logs.filter((entry) => entry.event === "tunnel_opened").length, 2, "only the original and one replacement tunnel are needed");
    assert.equal(f.relay.stats().tunnels, 1);
    // Deliver the stale close notification after new TLS is already in use.
    for (const item of f.race.withheld) item.socket.emit("message", item.value);
    await tick(); assert.equal((await f.phone.status()).snapshot.canControl, true);
    assert.equal(run.perms.has(before.pending[0].requestId), true, "reconnect never automatically approves cached pending requests");
    assert.equal((await f.original.childEvents()).filter((event) => event.kind === "control_response").length, 0);
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
});

test("subscription snapshot and explicit resync share one source read without closing TLS", async (t) => {
  const f = await reconnectChain(t), run = await f.original.start();
  await until(async () => (await f.phone.status()).snapshot.pending.length, "initial request snapshot");
  await sleep(220);
  const hostSocket = f.sockets.find((socket) => socket.side === "host"), gate = f.holdSnapshots({ once: true });
  hostSocket.holdData = [];
  const reopening = f.phone.open({ remoteSessionId: f.handle }); reopening.catch(() => {});
  await until(() => hostSocket.holdData.length > 0, "explicit subscribe ciphertext held before runtime dispatch");
  f.original.publish({ type: "delta", runId: run.id, sessionId: LOCAL_SESSION, text: "Synthetic coalesced update during subscribe" });
  await gate.entered;
  const paused = hostSocket.holdData; hostSocket.holdData = null;
  for (const value of paused) hostSocket.emit("message", value);
  await sleep(60); // Allow subscribe to contend while the source read is deliberately held.
  try {
    assert.equal((await f.host.settings()).connection.errorCode, null, "source contention is not a corrupt TLS frame");
    assert.equal(f.relay.stats().closedTunnels, 0);
    gate.release(); await reopening;
    assert.equal((await f.phone.status()).snapshot.canControl, true);
    assert.equal(f.logs.filter((entry) => entry.event === "tunnel_opened").length, 1);
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
  finally { gate.release(); }
});

for (const hostFirst of [true, false]) test(`reconnect verifies current grant/run/pending and keeps received busy-queue text unique (hostFirst=${hostFirst})`, async (t) => {
  const f = await reconnectChain(t, { hostFirst });
  const run = await f.original.start();
  const state = await until(async () => { const s = (await f.phone.status()).snapshot; return s.pending.length ? s : false; }, "original request before reconnect");
  const command = { generation: state.generation, binding: state.binding, type: "message.submit", commandId: "reconnect-text-once", payload: { text: "Synthetic reconnect text delivered only once" } };
  const received = await f.phone.command(command);
  assert.equal(received.receipt.status, "received", "this case intentionally covers received, not a lost receipt");
  assert.equal(f.original.QUEUE.filter((entry) => entry.remoteCommandId === command.commandId).length, 1);
  await f.phone.disconnect();
  run.answerPerm(state.pending[0].requestId, { behavior: "deny" });
  const currentRequest = await f.original.request(run, "Bash", { command: "printf synthetic-reconnect-current" }, "reconnect-current");
  await sleep(220); // Drain the host's coalesced offline update before holding the new resync read.
  const gate = f.holdSnapshots();
  try {
    await f.phone.connect(); await gate.entered;
    const syncing = (await f.phone.status()).snapshot;
    assert.equal(syncing.canControl, false); assert.equal(syncing.verified, false);
    await assert.rejects(f.phone.command({ ...command, commandId: "never-send-before-resync" }), (error) => ["OFFLINE", "RESYNC_REQUIRED"].includes(error.code));
    assert.equal(f.original.QUEUE.some((entry) => entry.remoteCommandId === "never-send-before-resync"), false);
    gate.release();
    const recovered = await until(async () => { const s = (await f.phone.status()).snapshot; return s.canControl && s.pending.some((request) => request.requestId === currentRequest.id) ? s : false; }, "fresh snapshot restores controls");
    assert.equal(recovered.pending.some((request) => request.requestId === state.pending[0].requestId), false);
    assert.equal(f.original.QUEUE.filter((entry) => entry.remoteCommandId === command.commandId).length, 1);
    await f.phone.command({ ...command, generation: recovered.generation, binding: recovered.binding });
    assert.equal(f.original.QUEUE.filter((entry) => entry.remoteCommandId === command.commandId).length, 1, "same-ID retry remains a local receipt lookup");
    assert.equal(run.perms.has(currentRequest.id), true);
    await sleep(60); assert.deepEqual(f.original.attemptedExternal, []);
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
  finally { gate.release(); }
});


for (const hostFirst of [true, false]) test(`a receipt lost after enqueue stays unknown and delivers to the original child only once (hostFirst=${hostFirst})`, async (t) => {
  const f = await reconnectChain(t, { hostFirst }), run = await f.original.start();
  const before = await until(async () => { const s = (await f.phone.status()).snapshot; return s.canControl && s.pending.length ? s : false; }, "original permission before lost receipt");
  const socket = f.sockets.find((entry) => entry.side === "phone");
  socket.heldIncoming = [];
  socket.holdIncoming = (event, frame) => event === "message" && frame?.op === "tunnel.data";
  const command = { generation: before.generation, binding: before.binding, type: "message.submit", commandId: "lost-receipt-once", payload: { text: "Synthetic lost-receipt text reaches child once" } };
  const pending = f.phone.command(command); pending.catch(() => {});
  try {
    await until(() => f.original.QUEUE.some((entry) => entry.remoteCommandId === command.commandId), "original queue commits before phone learns outcome");
    await until(() => socket.heldIncoming.length > 0, "phone inbound ciphertext containing receipt is actually withheld");
    assert.equal((await f.phone.status()).snapshot.receipts.find((r) => r.commandId === command.commandId)?.status, "sending");
    await f.phone.disconnect();
    const uncertain = await pending;
    assert.equal(uncertain.receipt.status, "unknown"); assert.equal(uncertain.snapshot.canControl, false);
  } finally { socket.holdIncoming = null; socket.heldIncoming = []; }
  await f.phone.connect();
  const recovered = await until(async () => { const s = (await f.phone.status()).snapshot; return s.canControl ? s : false; }, "current authenticated snapshot after lost receipt");
  assert.equal(recovered.receipts.find((r) => r.commandId === command.commandId)?.status, "unknown");
  await f.phone.command({ ...command, generation: recovered.generation, binding: recovered.binding });
  assert.equal(f.original.QUEUE.filter((entry) => entry.remoteCommandId === command.commandId).length, 1);
  const queried = await f.phone.query({ generation: recovered.generation, binding: recovered.binding, commandId: command.commandId });
  assert.equal(queried.receipt.status, "unknown", "received cannot downgrade an unknown to retryable");
  assert.equal(run.answerPerm(before.pending[0].requestId, { behavior: "deny" }), true);
  await f.original.signal(run.id, { kind: "finish" });
  await until(async () => (await f.original.childEvents()).filter((event) => event.kind === "user" && JSON.stringify(event.message).includes(command.payload.text)).length === 1, "one actual child text delivery");
  await until(async () => (await f.phone.status()).snapshot.receipts.some((r) => r.commandId === command.commandId && r.status === "applied"), "tablet delivery receipt resolves the old unknown");
  await sleep(100);
  assert.equal((await f.original.childEvents()).filter((event) => event.kind === "user" && JSON.stringify(event.message).includes(command.payload.text)).length, 1);
  assert.equal(f.original.QUEUE.some((entry) => entry.remoteCommandId === command.commandId), false);
  assert.deepEqual(f.original.attemptedExternal, []);
});

test("a read from a retired TLS holder cannot close or publish online over its replacement", async (t) => {
  const f = await reconnectChain(t), before = (await f.phone.status()).snapshot;
  const hostSocket = f.sockets.find((socket) => socket.side === "host"), sent = hostSocket.sent.length;
  const gate = f.holdSnapshots({ once: true });
  const oldRead = f.phone.open({ remoteSessionId: f.handle });
  const canceled = assert.rejects(oldRead, (error) => ["OFFLINE", "RESYNC_REQUIRED"].includes(error.code));
  await gate.entered;
  await f.phone.disconnect();
  const offline = (await f.phone.status()).snapshot;
  assert.equal(offline.canControl, false); assert.equal(offline.verified, false);
  const fresh = f.holdSnapshots();
  try {
    await f.phone.connect();
    await until(() => f.logs.filter((entry) => entry.event === "tunnel_opened").length === 2, "replacement tunnel opened while old read awaits");
    await until(() => hostSocket.sent.slice(sent).some((frame) => frame.op === "tunnel.data"), "replacement TLS handshake before old read completion");
    gate.release(); await canceled;
    await fresh.entered;
    assert.equal((await f.phone.status()).snapshot.canControl, false, "old read completion cannot verify the new channel");
    fresh.release();
    await until(async () => (await f.phone.status()).snapshot.canControl, "current TLS snapshot restores control");
    assert.equal(f.logs.filter((entry) => entry.event === "tunnel_opened").length, 2, "old async failure cannot tear down replacement TLS");
    assert.equal(f.relay.stats().tunnels, 1);
    assert.equal((await f.host.settings()).connection.errorCode, null, "old job failure cannot overwrite current runtime error state");
    assert.equal(before.binding.hostInstanceId, (await f.phone.status()).snapshot.binding.hostInstanceId);
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
  finally { gate.release(); fresh.release(); }
});


test("a relay outage reconnects both real runtimes once and restores only verified controls", async (t) => {
  const f = await reconnectChain(t), run = await f.original.start();
  const before = await until(async () => { const s = (await f.phone.status()).snapshot; return s.pending.length ? s : false; }, "pending request before relay outage");
  for (const socket of f.sockets) socket.socket.close();
  await until(async () => !(await f.phone.status()).snapshot.canControl && (await f.phone.settings()).connection.state === "disconnected", "relay loss immediately gates controls");
  await assert.rejects(f.phone.command({ generation: before.generation, binding: before.binding, type: "run.stop", commandId: "never-replay-outage-stop", payload: {} }), (error) => ["OFFLINE", "RESYNC_REQUIRED"].includes(error.code));
  try {
    await until(async () => (await f.phone.status()).snapshot.canControl, "policy retry reauthenticates both devices and resyncs");
    const recovered = (await f.phone.status()).snapshot;
    assert.equal(recovered.binding.runId, run.id); assert.equal(run.perms.has(before.pending[0].requestId), true);
    assert.equal(f.relay.stats().authenticated, 4, "one authentication per device per relay generation");
    assert.equal(f.relay.stats().tunnels, 1);
    assert.equal(f.logs.filter((entry) => entry.event === "tunnel_opened").length, 2);
    assert.equal(run.aborted, false); assert.deepEqual(f.original.attemptedExternal, []);
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
});

test("reconnect never restores a grant revoked while the phone was offline", async (t) => {
  const f = await reconnectChain(t), run = await f.original.start();
  const before = await until(async () => { const s = (await f.phone.status()).snapshot; return s.pending.length ? s : false; }, "pending request before offline revoke");
  await f.phone.disconnect();
  await f.host.revoke({ localSessionId: LOCAL_SESSION, remoteSessionId: f.handle, grantVersion: before.binding.grantVersion });
  assert.ok(before.items.length > 0 && before.pending.length > 0, "the test must first hold real cached content and a request");
  await f.phone.connect();
  try {
    const after = await until(async () => { const s = (await f.phone.status()).snapshot; return s.phase === "revoked" && s.error === "GRANT_REVOKED" ? s : false; }, "authenticated resync explicitly reports the offline revocation");
    assert.equal(after.canControl, false); assert.equal(after.verified, false);
    assert.deepEqual(after.items, []); assert.deepEqual(after.pending, []); assert.deepEqual(after.receipts, []);
    assert.equal(after.cache.bytes, 2); assert.equal(after.binding, null);
    assert.equal(after.sessions.some((entry) => entry.remoteSessionId === f.handle), false);
    await assert.rejects(f.phone.open({ remoteSessionId: f.handle }), { code: "GRANT_NOT_ACTIVE" });
    await assert.rejects(f.phone.command({ generation: before.generation, binding: before.binding, type: "request.respond", commandId: "revoked-never-replay", payload: { requestId: before.pending[0].requestId, requestVersion: before.pending[0].requestVersion, response: { kind: "permission", decision: "allow" } } }), (error) => ["GRANT_REVOKED", "RESYNC_REQUIRED"].includes(error.code));
    assert.equal(run.perms.has(before.pending[0].requestId), true); assert.equal(run.aborted, false);
    assert.equal((await f.original.childEvents()).some((event) => event.kind === "control_response"), false);
    assert.equal((await f.phone.settings()).connection.state, "online", "one retired grant cannot close the whole authenticated route");
  } catch (error) { t.diagnostic(JSON.stringify(await f.diagnostics())); throw error; }
});


test("a control racing transport loss is not queued behind a replacement TLS handshake", async (t) => {
  const f = await reconnectChain(t, { hostFirst: false }), before = (await f.phone.status()).snapshot;
  const socket = f.sockets.find((entry) => entry.side === "phone"), retiredId = f.streams.find((entry) => entry.side === "phone").stream.tunnelId;
  socket.heldIncoming = [];
  socket.holdIncoming = (event, frame) => event === "message" && ["tunnel.closed", "tunnel.opened", "tunnel.data"].includes(frame?.op);
  const oldStream = f.streams.find((entry) => entry.side === "phone").stream;
  oldStream.destroy(); // TLS close is asynchronous, so the cached phone snapshot still looks ready for this turn.
  const command = { generation: before.generation, binding: before.binding, type: "message.submit", commandId: "loss-must-not-queue", payload: { text: "Synthetic control must never cross a reconnect" } };
  try {
    const outcome = await Promise.race([f.phone.command(command), sleep(600).then(() => "pending-handshake")]);
    assert.notEqual(outcome, "pending-handshake", "a control must fail before opening/awaiting another TLS stream");
    assert.equal(outcome.receipt.status, "unknown");
    assert.equal(f.original.QUEUE.some((entry) => entry.remoteCommandId === command.commandId), false);
    await until(() => socket.heldIncoming.some((entry) => { const frame = JSON.parse(entry.value.data); return frame.op === "tunnel.closed" && frame.tunnelId === retiredId; }), "old tunnel close is queued");
  } finally {
    socket.holdIncoming = null;
    for (const item of socket.heldIncoming) socket.emit(item.event, item.value);
  }
  await until(async () => (await f.phone.status()).snapshot.canControl, "fresh authenticated snapshot after raced control rejection");
  assert.equal(f.original.QUEUE.some((entry) => entry.remoteCommandId === command.commandId), false, "recovery must not retransmit the failed control");
  assert.equal((await f.original.childEvents()).some((event) => event.kind === "user" && JSON.stringify(event.message).includes(command.payload.text)), false);
});

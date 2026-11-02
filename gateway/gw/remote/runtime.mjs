import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, sign } from "node:crypto";
import { createFrame, validateFrame, assertCorrelation, LIMITS } from "./protocol.mjs";
import { createSecureChannel, createPairingChannel, createReplayGuard } from "./crypto.mjs";
import { createPairingManager, validatePairingOffer } from "./pairing.mjs";
import { loadOrCreateIdentity } from "./identity.mjs";
import { createPhoneManager } from "./phone.mjs";
import { createTabletData } from "./tablet-data.mjs";
import { createTabletControl } from "./tablet-control.mjs";
import { createRemoteStore } from "./store.mjs";
import { createRelayClient, relayUrl } from "./relay-client.mjs";
import { createUnavailableHostAdapter } from "./host-adapter.mjs";
import { normaliseSnapshot, normaliseHistory } from "./presentation.mjs";

const error = (code) => Object.assign(new Error(code), { code });
const checkId = (v) => { if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) throw error("INVALID_SCHEMA"); return v; };
const reverse = (b) => ({ ...b, fromDeviceId: b.toDeviceId, toDeviceId: b.fromDeviceId });
const bindingKeys = ["fromDeviceId", "toDeviceId", "hostInstanceId", "remoteSessionId", "grantVersion", "runId"];
const subsetBinding = (frame) => Object.fromEntries(bindingKeys.map((k) => [k, frame[k]]));
const publicDevice = (p) => ({ deviceId: p.deviceId, name: p.name, fingerprint: p.spkiSha256 });
const MAX_SESSIONS = 64, MAX_REMOTE_TOMBSTONES = 4096;

/** The only integration coordinator. All I/O dependencies are injectable and no
 * real session is read until the local user explicitly grants its remote handle. */
export async function createRemoteRuntime({ home, sourceAdapter, executor, hostAdapter = createUnavailableHostAdapter(),
  identityBundle = null, store: suppliedStore, relayFactory = createRelayClient, now = Date.now, allowLoopback = false,
  fetchImpl = globalThis.fetch, autoConnect = false } = {}) {
  if (typeof home !== "string" || !path.isAbsolute(home) || !sourceAdapter || !executor) throw error("INVALID_SCHEMA");
  const dir = path.join(home, "remote-v1"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const protector = hostAdapter.secretProtector;
  const store = suppliedStore || createRemoteStore(path.join(dir, "metadata.json"), {
    async seal(value, recordId) { return protector.seal("connection-v1", recordId, Buffer.from(value)); },
    async unseal(value, recordId) { const bytes = await protector.open("connection-v1", recordId, value); try { return bytes.toString("utf8"); } finally { bytes.fill(0); } },
  });
  const hostInstanceId = randomUUID(), local = new Map(), remote = new Map(), listeners = new Set(), transports = new Set();
  const channels = new Map(), peerOpening = new Map(), peerRetries = new Map(), dataReads = new Map(), channelWaiters = new Set(), rpc = new Map(), subscriptions = new Map(), notices = new Map(), remoteNotices = new Map(), offers = new Map();
  const replayGuard = createReplayGuard({ now });
  const pairingWork = new Set(), inviting = new Set();
  let pairingEpoch = 0;
  function beginPairing(deviceId) {
    if (pairingWork.size >= 8) throw error("LIMIT_EXCEEDED");
    const job = { deviceId, relay, manager: pairManager, generation: relayGeneration, cancelled: false, stream: null, channel: null };
    pairingWork.add(job); return job;
  }
  function cancelPairing(deviceId, advanceEpoch = true) {
    if (advanceEpoch) pairingEpoch++;
    for (const job of pairingWork) if (!deviceId || job.deviceId === deviceId) {
      job.cancelled = true; job.channel?.close(); job.stream?.destroy();
    }
  }
  function checkPairing(job) {
    if (job.cancelled || stopped || job.relay !== relay || job.manager !== pairManager || job.generation !== relayGeneration || !relay?.online) throw error("OFFLINE");
  }
  let bundle = identityBundle, relay = null, pairManager = null, phone = null, control = null;
  let connection = "disconnected", checkedAt = 0, stopped = false, retry = null, policyOff = null, policyBusy = false, relayGeneration = 0;
  let backgroundEnabled = false, lastError = null, initializing = null, connecting = null, configuring = false, disposed = false;
  const data = createTabletData({ adapter: sourceAdapter, hostInstanceId, now });
  // Process restarts never silently reactivate old grants or dispatch old commands.
  for (const g of store.grants()) if (g.hostDeviceId && g.localSessionId) {
    const revoked = { ...g, state: "revoked", retiredUntil: now() + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS };
    local.set(g.remoteSessionId, revoked);
  }
  // A new hostInstanceId already makes every persisted local lease obsolete.
  // Remove them atomically, not one fsync per historical grant.
  store.pruneGrants(now(), { retireLocal: true });
  function pruneLocalGrants() {
    // Local terminal grants grant no authority. Keep only a bounded, short
    // resync notice cache; old/missing handles still fail closed at dispatch.
    store.pruneGrants(now());
    for (const [rid, g] of local) if (g.expiresAt <= now() || g.retiredUntil <= now()) {
      data.revoke(rid); subscriptions.get(rid)?.(); subscriptions.delete(rid);
      const notice = notices.get(rid); if (notice) clearTimeout(notice.timer); notices.delete(rid);
      local.delete(rid);
    }
    const terminal = [...local.values()].filter((g) => g.state === "revoked");
    while (terminal.length >= MAX_SESSIONS) {
      const g = terminal.shift(); local.delete(g.remoteSessionId);
      const notice = notices.get(g.remoteSessionId); if (notice) clearTimeout(notice.timer); notices.delete(g.remoteSessionId);
    }
  }
  function revokeLocal(g) {
    g.state = "revoked"; g.retiredUntil = now() + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS;
    data.revoke(g.remoteSessionId); subscriptions.get(g.remoteSessionId)?.(); subscriptions.delete(g.remoteSessionId);
    const notice = notices.get(g.remoteSessionId); if (notice) clearTimeout(notice.timer); notices.delete(g.remoteSessionId);
    store.putGrant(g);
  }
  function pruneRemoteGrants() {
    for (const [rid, g] of remote) if (g.expiresAt <= now() || g.retiredUntil <= now()) {
      remote.delete(rid); remoteNotices.delete(rid);
    }
  }
  const emitTransport = (value) => { for (const fn of transports) { try { fn(value); } catch {} } };
  function ownId() { return bundle?.identity.deviceId || store.identity()?.deviceId || "remote-unconfigured"; }
  function peer(deviceId) { return store.peers().find((p) => p.deviceId === deviceId); }
  function binding(g, toHost = false) {
    return { fromDeviceId: toHost ? g.phoneDeviceId : g.hostDeviceId, toDeviceId: toHost ? g.hostDeviceId : g.phoneDeviceId,
      hostInstanceId: g.hostInstanceId, remoteSessionId: g.remoteSessionId, grantVersion: g.grantVersion,
      runId: g.localSessionId ? executor.getRunOfSession(g.localSessionId)?.id || null : g.runId ?? null };
  }
  const context = (g) => ({ hostInstanceId, remoteSessionId: g.remoteSessionId, deviceId: g.phoneDeviceId, grantVersion: g.grantVersion });
  async function hostStatus() { try { return await hostAdapter.status(); } catch { return { hostAvailable: false, shouldConnect: false, foreground: false }; } }
  function fallbackSnapshot() {
    return { revision: 0, generation: 0, deviceId: ownId(), connection: "offline", phase: "idle", verified: false, canControl: false,
      cached: false, sessions: [], active: null, binding: null, grant: null, run: null, pending: [], items: [], receipts: [],
      streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false, lastSyncedAt: null, error: lastError };
  }
  async function envelope() { return phone && !stopped ? phone.status() : { snapshot: fallbackSnapshot() }; }
  async function publishState() { const value = await envelope(); for (const fn of listeners) { try { fn(value.snapshot); } catch {} } }
  let notificationBusy = false, nextNotifications = null, metadataTail = Promise.resolve();
  const completedRuns = new Map();
  function rememberNotice(g, value, issuedAt) {
    let doneExpiresAt = 0;
    if (["ended", "stopped"].includes(value.run.state) && value.run.runId) {
      const key = JSON.stringify([g.hostDeviceId, g.hostInstanceId, g.remoteSessionId, g.grantVersion, value.run.runId]);
      // Keep completion identity separate from the latest run/pending state.
      // At capacity, omit new done hints rather than evicting a dedup tombstone.
      if (!completedRuns.has(key) && completedRuns.size < 4096) completedRuns.set(key, { remoteSessionId: g.remoteSessionId,
        grantExpiresAt: g.expiresAt, expiresAt: Math.min(g.expiresAt, issuedAt + 300000) });
      doneExpiresAt = completedRuns.get(key)?.expiresAt || 0;
    }
    remoteNotices.set(g.remoteSessionId, { ...value, doneExpiresAt, current: true });
  }
  function refreshRemoteMetadata() {
    const work = metadataTail.catch(() => {}).then(async () => {
      try { if (phone) await phone.list(); }
      catch (e) { if (e.code !== "RESYNC_REQUIRED") throw e; } // A newer local list is not a broken TLS frame.
      await publishState();
    });
    metadataTail = work; return work;
  }
  async function notificationSync(snapshot) {
    if (stopped) return;
    for (const [key, value] of completedRuns) if (value.grantExpiresAt <= now() || !remote.has(value.remoteSessionId)) completedRuns.delete(key);
    const entries = [];
    for (const g of remote.values()) if (g.state === "invited" && g.expiresAt > now()) entries.push({ kind: "invite",
      binding: { fromDeviceId: g.hostDeviceId, remoteSessionId: g.remoteSessionId, hostInstanceId: g.hostInstanceId, grantVersion: g.grantVersion },
      runId: null, requestId: null, eventId: "invite-" + g.grantVersion, expiresAt: Math.min(g.expiresAt, now() + 86400000) });
    for (const r of snapshot.pending || []) if (r.state === "pending" && snapshot.binding && snapshot.verified && snapshot.connection === "online"
        && !remoteNotices.has(snapshot.binding.remoteSessionId)) entries.push({ kind: "request",
      binding: { fromDeviceId: snapshot.binding.toDeviceId, remoteSessionId: snapshot.binding.remoteSessionId, hostInstanceId: snapshot.binding.hostInstanceId, grantVersion: snapshot.binding.grantVersion },
      runId: r.runId, requestId: r.requestId, eventId: r.requestId + ":" + r.requestVersion, expiresAt: r.expiresAt });
    for (const [rid, notice] of remoteNotices) {
      const g = remote.get(rid);
      if (!g || g.state !== "active" || g.expiresAt <= now()) { remoteNotices.delete(rid); continue; }
      if (!notice.current) continue;
      const b = { fromDeviceId: g.hostDeviceId, remoteSessionId: rid, hostInstanceId: g.hostInstanceId, grantVersion: g.grantVersion };
      for (const r of notice.pending) if (r.expiresAt > now()) entries.push({ kind: "request", binding: b, runId: notice.run.runId,
        requestId: r.requestId, eventId: r.requestId + ":" + r.requestVersion, expiresAt: r.expiresAt });
      if (["ended", "stopped"].includes(notice.run.state) && notice.run.runId && notice.doneExpiresAt > now()) entries.push({ kind: "done", binding: b,
        runId: notice.run.runId, requestId: null, eventId: notice.eventId, expiresAt: notice.doneExpiresAt });
    }
    const unique = new Map(entries.map((e) => [JSON.stringify([e.kind, e.binding, e.runId, e.requestId, e.eventId]), e]));
    nextNotifications = [...unique.values()].slice(0, 128);
    if (notificationBusy) return;
    notificationBusy = true;
    try { while (nextNotifications) { const value = nextNotifications; nextNotifications = null; await hostAdapter.syncNotifications(value); } }
    catch {} finally { notificationBusy = false; }
  }
  async function ensureIdentity() {
    if (bundle) return;
    if (initializing) return initializing;
    initializing = (async () => {
      const loaded = await loadOrCreateIdentity({ file: path.join(dir, "identity.json"), secretProtector: protector,
        name: store.config()?.deviceName || "CC device" });
      if (stopped) { loaded.dispose?.(); throw error("OFFLINE"); }
      bundle = loaded; store.setIdentity(bundle.identity);
    })();
    try { await initializing; } finally { initializing = null; }
  }
  function settleFrame(frame) {
    for (const [key, pending] of rpc) {
      if ((frame.correlationId && key === frame.correlationId) || frame.type === "control.receipt" && key === frame.commandId) {
        if (frame.fromDeviceId !== pending.request.toDeviceId || frame.toDeviceId !== ownId()
            || frame.remoteSessionId !== pending.request.remoteSessionId || frame.grantVersion !== pending.request.grantVersion
            || frame.hostInstanceId !== pending.request.hostInstanceId) throw error("SESSION_MISMATCH");
        if (frame.correlationId) assertCorrelation(frame, pending.request, { now });
        rpc.delete(key); clearTimeout(pending.timer); pending.resolve(frame); return true;
      }
    }
    return false;
  }
  function rejectRpc(code, deviceId, remoteSessionId) {
    for (const [key, p] of rpc) if ((!deviceId || p.request.toDeviceId === deviceId)
        && (!remoteSessionId || p.request.remoteSessionId === remoteSessionId)) { rpc.delete(key); clearTimeout(p.timer); p.reject(error(code)); }
  }
  function currentHolder(holder) {
    return channels.get(holder.deviceId) === holder && holder.relay === relay && holder.relayGeneration === relayGeneration
      && !holder.channel.closed && !holder.stream.destroyed;
  }
  function clearChannels() {
    cancelPairing(undefined, false);
    const retired = [...channels.values()]; channels.clear(); peerOpening.clear();
    for (const g of remote.values()) if (g.state === "active") g.resumeRequired = true;
    for (const notice of remoteNotices.values()) notice.current = false;
    for (const timer of peerRetries.values()) clearTimeout(timer); peerRetries.clear();
    for (const holder of retired) holder.channel.close();
    for (const w of channelWaiters) { clearTimeout(w.timer); w.reject(error("OFFLINE")); } channelWaiters.clear();
    rejectRpc("OFFLINE");
  }
  function schedulePeerReconnect(deviceId) {
    if (stopped || !relay?.online || !peer(deviceId) || ownId() >= deviceId || peerRetries.has(deviceId)) return;
    const connection = relay, epoch = relayGeneration;
    const timer = setTimeout(() => {
      if (peerRetries.get(deviceId) !== timer) return;
      peerRetries.delete(deviceId);
      if (!stopped && relay === connection && relayGeneration === epoch && connection.online) void ensurePeer(deviceId).catch(() => {});
    }, 3000);
    timer.unref?.(); peerRetries.set(deviceId, timer);
  }
  function queueSend(channel, frame, priority = 0) {
    const holder = channels.get(frame.toDeviceId);
    if (!holder || holder.channel !== channel || !currentHolder(holder) || holder.queue.length >= 128) return Promise.reject(error("OFFLINE"));
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (holder.bytes + bytes > LIMITS.LOW_QUEUE_BYTES) return Promise.reject(error("LIMIT_EXCEEDED"));
    return new Promise((resolve, reject) => {
      holder.queue.push({ frame, priority, bytes, resolve, reject }); holder.bytes += bytes;
      if (!holder.sending) void flush(holder);
    });
  }
  async function flush(holder) {
    holder.sending = true;
    try {
      while (holder.queue.length && currentHolder(holder)) {
        holder.queue.sort((a, b) => a.priority - b.priority);
        const job = holder.queue.shift(); holder.bytes -= job.bytes;
        try { await holder.channel.send(job.frame); job.resolve(); } catch (e) { job.reject(e); holder.channel.close(); }
      }
    } finally {
      holder.sending = false;
      if (!currentHolder(holder)) for (const job of holder.queue.splice(0)) job.reject(error("OFFLINE"));
    }
  }
  async function send(frame, priority = 0) {
    const epoch = relayGeneration, channel = await ensurePeer(frame.toDeviceId);
    if (epoch !== relayGeneration) throw error("OFFLINE");
    return queueSend(channel, frame, priority);
  }
  async function requestFrame(frame, priority = 0) {
    if (rpc.size >= 32) throw error("LIMIT_EXCEEDED");
    const key = frame.correlationId || frame.commandId;
    if (!key || rpc.has(key)) throw error("COMMAND_CONFLICT");
    const isControl = ["message.submit", "request.respond", "run.stop", "control.query"].includes(frame.type);
    const holder = channels.get(frame.toDeviceId);
    // A previously verified phone snapshot cannot authorize queuing a control
    // behind a new handshake. Only resync/invitation requests may open a peer.
    if (isControl && (!holder || !currentHolder(holder))) throw error("OFFLINE");
    let pending;
    const result = new Promise((resolve, reject) => { pending = { request: frame, resolve, reject,
      timer: setTimeout(() => { if (rpc.get(key) === pending) rpc.delete(key); reject(error("OFFLINE")); }, 15000) }; rpc.set(key, pending); });
    result.catch(() => {});
    try { await (isControl ? queueSend(holder.channel, frame, priority) : send(frame, priority)); }
    catch (e) { if (rpc.get(key) === pending) rpc.delete(key); clearTimeout(pending.timer); pending.reject(e); }
    return result;
  }
  function checkHost(frame, peerId, allowInvited = false) {
    const g = local.get(frame.remoteSessionId);
    if (!g || !peer(peerId) || g.phoneDeviceId !== peerId || g.hostDeviceId !== ownId() || g.hostInstanceId !== hostInstanceId
      || g.expiresAt <= now() || !["active", ...(allowInvited ? ["invited"] : [])].includes(g.state)) throw error("GRANT_REVOKED");
    const b = binding(g, true);
    for (const k of bindingKeys.filter((k) => k !== "runId")) if (frame[k] !== b[k]) throw error("GRANT_MISMATCH");
    return g;
  }
  const diagnostics = { dataBatches: 0, snapshotsSent: 0, snapshotsReceived: 0, snapshotsApplied: 0, snapshotsIgnored: 0 };
  async function readData(g, work) {
    let entry = dataReads.get(g.localSessionId);
    if (!entry) { entry = { pending: 0, tail: Promise.resolve() }; dataReads.set(g.localSessionId, entry); }
    // The source permits one read per original session. Coalesced push updates,
    // history and reconnect resync must share that slot instead of killing TLS
    // with READ_BUSY. The existing per-channel input bound caps this short queue.
    if (entry.pending >= 16) throw error("LIMIT_EXCEEDED");
    entry.pending++;
    const result = entry.tail.catch(() => {}).then(() => { if (stopped) throw error("OFFLINE"); return work(); });
    entry.tail = result;
    try { return await result; } finally { if (--entry.pending === 0 && dataReads.get(g.localSessionId) === entry) dataReads.delete(g.localSessionId); }
  }
  async function makeSnapshot(g, holder = null) {
    const reserved = Buffer.byteLength(JSON.stringify(control.describeRequests(g.localSessionId, { maxBytes: 48000 })));
    let maxBytes = Math.max(2048, 60000 - reserved - 4096);
    // Only the source layer can withhold an item while retaining its private
    // continuation. Retry with a smaller bounded read budget, never shift Records.
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await readData(g, () => { if (holder && !currentHolder(holder)) throw error("OFFLINE"); return data.snapshot(context(g), { maxBytes }); });
      let base;
      try { base = normaliseSnapshot(raw, { scope: g.remoteSessionId }); }
      catch (e) {
        if (e.code !== "LIMIT_EXCEEDED" || attempt === 3) throw e;
        maxBytes = Math.max(2048, Math.floor(maxBytes * .75)); continue;
      }
      const pending = control.describeRequests(g.localSessionId, { maxBytes: 48000 });
      if (pending.some((r) => r.runId !== base.run.runId)) throw error("RESYNC_REQUIRED");
      const payload = { ...base, grant: { state: g.state, expiresAt: g.expiresAt }, pending };
      if (pending.length && base.run.runId) payload.run.state = pending.some((r) => r.kind === "local") ? "needs-local" : "waiting";
      const size = Buffer.byteLength(JSON.stringify(payload));
      if (size <= 60000) return createFrame("session.snapshot", { ...binding(g), runId: base.run.runId }, payload, { now });
      maxBytes = Math.max(2048, maxBytes - Math.max(2048, size - 60000 + 1024));
    }
    throw error("PAYLOAD_TOO_LARGE");
  }
  function acknowledgeSnapshot(g, snapshot) {
    data.ackSnapshot(context(g), { streamId: snapshot.payload.streamId, seq: snapshot.payload.seq });
  }
  async function startSubscription(g) {
    if (subscriptions.has(g.remoteSessionId)) return;
    let scheduled = null, busy = false, dirty = false;
    const update = () => {
      dirty = true;
      if (scheduled || busy || stopped) return;
      scheduled = setTimeout(async () => {
        scheduled = null; busy = true; dirty = false;
        try { if (g.state === "active" && peer(g.phoneDeviceId)) {
          const snapshot = await makeSnapshot(g); await send(snapshot, 2);
          acknowledgeSnapshot(g, snapshot); diagnostics.snapshotsSent++;
        } }
        catch (e) { lastError = e.code || "INTERNAL_ERROR"; } finally { busy = false; if (dirty) update(); }
      }, 150); scheduled.unref?.();
    };
    const off = data.subscribe(context(g), () => { diagnostics.dataBatches++; update(); return true; });
    subscriptions.set(g.remoteSessionId, () => { off(); clearTimeout(scheduled); });
  }
  async function incoming(frame, peerId, holder) {
    if (!currentHolder(holder)) throw error("OFFLINE");
    // Replies belong to the channel that authenticated the request. Never
    // reconnect here and let an old asynchronous job act on a new TLS stream.
    const reply = (value, priority = 0) => queueSend(holder.channel, value, priority);
    frame = validateFrame(frame, { now });
    if (stopped) {
      // Retirement may await only its empty release acknowledgement; no late
      // snapshot or control is allowed to revive the disposed feature.
      if (["host.released", "host.revoked"].includes(frame.type) && frame.fromDeviceId === peerId && peer(peerId) && frame.toDeviceId === ownId()) { settleFrame(frame); return; }
      throw error("OFFLINE");
    }
    if (frame.fromDeviceId !== peerId || frame.toDeviceId !== ownId() || !peer(peerId)) throw error("DEVICE_MISMATCH");
    if (["message.submit", "request.respond", "run.stop", "control.query"].includes(frame.type)) {
      const receipt = await control[frame.type === "control.query" ? "query" : "submit"](frame, peerId);
      await reply(receipt); return;
    }
    if (["host.accept", "session.subscribe", "history.get"].includes(frame.type)) {
      const retired = local.get(frame.remoteSessionId);
      const matches = retired && retired.phoneDeviceId === peerId && retired.hostDeviceId === ownId()
        && retired.hostInstanceId === frame.hostInstanceId && retired.grantVersion === frame.grantVersion;
      if (!retired || matches && (retired.state === "revoked" || retired.expiresAt <= now())) {
        // An authenticated resync after an offline revoke needs a terminal
        // notice, not an endless reconnect with stale content still cached.
        await reply(createFrame("host.revoke", reverse(subsetBinding(frame)), { reason: retired && retired.expiresAt <= now() ? "expired" : "revoked" }, { now })); return;
      }
    }
    if (frame.type === "host.accept") {
      const g = checkHost(frame, peerId, true);
      await control.serialize(g.remoteSessionId, () => { if (!currentHolder(holder)) throw error("OFFLINE"); if (g.state !== "invited" && g.state !== "active") throw error("GRANT_REVOKED"); g.state = "active"; store.putGrant(g); });
      await startSubscription(g);
      const snapshot = await makeSnapshot(g, holder);
      await reply(createFrame("session.snapshot", subsetBinding(snapshot), snapshot.payload, { now, correlationId: frame.correlationId }));
      acknowledgeSnapshot(g, snapshot); return;
    }
    if (frame.type === "host.release") {
      // A retirement release is idempotent: duplicate cleanup requests may
      // acknowledge an already revoked lease, but can never reactivate it.
      const g = local.get(frame.remoteSessionId);
      if (!g) {
        // A collected/missing handle has no authority to release. An empty,
        // authenticated cleanup ACK lets the peer retire its durable tombstone.
        await reply(createFrame("host.released", reverse(subsetBinding(frame)), {}, { now, correlationId: frame.correlationId })); return;
      }
      if (g.phoneDeviceId !== peerId || g.hostDeviceId !== ownId() || g.hostInstanceId !== frame.hostInstanceId
          || g.grantVersion !== frame.grantVersion || !["invited", "active", "revoked"].includes(g.state)) throw error("GRANT_REVOKED");
      const response = createFrame("host.released", { ...binding(g), runId: frame.runId }, {}, { now, correlationId: frame.correlationId });
      await control.revoke(g.remoteSessionId, () => revokeLocal(g));
      await reply(response); return;
    }
    if (frame.type === "host.decline") {
      const g = checkHost(frame, peerId, true);
      if (g.state !== "invited") throw error("GRANT_NOT_ACTIVE");
      const reply = createFrame("host.declined", binding(g), {}, { now, correlationId: frame.correlationId });
      await control.revoke(g.remoteSessionId, () => revokeLocal(g));
      await queueSend(holder.channel, reply); return;
    }
    if (frame.type === "session.subscribe" || frame.type === "history.get") {
      const g = checkHost(frame, peerId);
      if (frame.type === "session.subscribe") {
        await startSubscription(g); const snapshot = await makeSnapshot(g, holder);
        await reply(createFrame("session.snapshot", subsetBinding(snapshot), snapshot.payload, { now, correlationId: frame.correlationId }), 1);
        acknowledgeSnapshot(g, snapshot);
      } else {
        const { raw, streamId, seq } = await readData(g, async () => {
          if (!currentHolder(holder)) throw error("OFFLINE");
          const raw = await data.history(context(g), { cursor: frame.payload.cursor, limit: frame.payload.limit });
          if (!currentHolder(holder)) throw error("OFFLINE");
          const current = data.events(context(g));
          return { raw, streamId: current.streamId, seq: current.to };
        });
        const page = normaliseHistory(raw, { scope: g.remoteSessionId });
        const payload = { streamId, seq, items: page.items, cursor: frame.payload.cursor, nextCursor: page.cursor, hasMore: page.hasMore };
        // History belongs to the read request's run, even if execution changed
        // while the original transcript was being read. New run state uses snapshots.
        await reply(createFrame("history.page", reverse(subsetBinding(frame)), payload, { now, correlationId: frame.correlationId }), 2);
      }
      return;
    }
    if (frame.type === "session.unsubscribe") { const g = checkHost(frame, peerId); subscriptions.get(g.remoteSessionId)?.(); subscriptions.delete(g.remoteSessionId); return; }
    if (frame.type === "host.invite") {
      if (store.grants().some((g) => g.state === "release-pending" && g.remoteSessionId === frame.remoteSessionId && g.hostDeviceId === peerId && g.hostInstanceId === frame.hostInstanceId)) return;
      pruneRemoteGrants();
      const old = remote.get(frame.remoteSessionId);
      store.pruneGrants(now());
      const persisted = store.grants();
      // Reserve durable release slots across both roles; retirement must not
      // have to evict an unacknowledged cleanup record from another lease.
      if (!old && [...remote.values()].filter((g) => g.state !== "revoked").length + persisted.length >= MAX_SESSIONS) throw error("LIMIT_EXCEEDED");
      if (!old && remote.size >= MAX_SESSIONS + MAX_REMOTE_TOMBSTONES) throw error("LIMIT_EXCEEDED");
      if (old && (old.hostDeviceId !== peerId || old.hostInstanceId !== frame.hostInstanceId || old.grantVersion !== frame.grantVersion)) throw error("GRANT_MISMATCH");
      if (old?.state === "revoked") return; // A delayed invite cannot revive this exact retired lease.
      const grant = { hostDeviceId: peerId, phoneDeviceId: ownId(), hostInstanceId: frame.hostInstanceId,
        remoteSessionId: frame.remoteSessionId, grantVersion: frame.grantVersion, runId: frame.runId,
        title: frame.payload.title, deviceName: frame.payload.deviceName, expiresAt: frame.payload.expiresAt, state: old?.state || "invited" };
      if (old) Object.assign(old, grant); else remote.set(frame.remoteSessionId, grant);
      await refreshRemoteMetadata(); return;
    }
    if (["host.released", "host.revoked"].includes(frame.type) && settleFrame(frame)) return;
    const g = remote.get(frame.remoteSessionId);
    if (!g && frame.type === "host.revoke") {
      // Revoke may overtake the original invite. Retain a non-authorizing
      // tombstone for every still-valid delayed frame; never revive that lease.
      pruneRemoteGrants();
      if (remote.size >= MAX_SESSIONS + MAX_REMOTE_TOMBSTONES) throw error("LIMIT_EXCEEDED");
      const retiredUntil = now() + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS;
      remote.set(frame.remoteSessionId, { hostDeviceId: peerId, phoneDeviceId: ownId(), hostInstanceId: frame.hostInstanceId,
        remoteSessionId: frame.remoteSessionId, grantVersion: frame.grantVersion, runId: frame.runId,
        state: "revoked", title: "", deviceName: "", expiresAt: retiredUntil, retiredUntil });
      if (frame.correlationId) await reply(createFrame("host.revoked", reverse(subsetBinding(frame)), {}, { now, correlationId: frame.correlationId }));
      return;
    }
    if (!g || g.hostDeviceId !== peerId || g.hostInstanceId !== frame.hostInstanceId || g.grantVersion !== frame.grantVersion
        || g.expiresAt <= now() && frame.type !== "host.revoke") throw error("GRANT_REVOKED");
    if (frame.type === "host.revoke") {
      g.state = "revoked"; g.retiredUntil ??= Math.min(g.expiresAt, now() + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS);
      remoteNotices.delete(g.remoteSessionId);
      emitTransport({ type: "host.revoke", binding: reverse(subsetBinding(frame)) });
      rejectRpc("GRANT_REVOKED", peerId, frame.remoteSessionId);
      await refreshRemoteMetadata();
      if (frame.correlationId) await reply(createFrame("host.revoked", reverse(subsetBinding(frame)), {}, { now, correlationId: frame.correlationId }));
      return;
    }
    if (frame.type === "session.snapshot") {
      diagnostics.snapshotsReceived++;
      if (frame.correlationId && settleFrame(frame)) return;
      if (frame.correlationId) return;
      if (g.state !== "active" || g.resumeRequired) { diagnostics.snapshotsIgnored++; return; } // Acceptance/reconnect requires its correlated current-authority response.
      g.runId = frame.runId;
      diagnostics.snapshotsApplied++;
      emitTransport({ type: "session.snapshot", binding: reverse(subsetBinding(frame)), snapshot: { ...frame.payload, binding: reverse(subsetBinding(frame)) } }); return;
    }
    if (frame.type === "session.notice") {
      if (g.state !== "active") return;
      rememberNotice(g, frame.payload, frame.issuedAt); g.runId = frame.runId;
      await refreshRemoteMetadata(); const s = await envelope(); await notificationSync(s.snapshot); return;
    }
    if (frame.type === "history.page" || frame.type === "host.declined") { settleFrame(frame); return; }
    if (frame.type === "control.receipt") { if (!settleFrame(frame)) emitTransport({ type: "control.receipt", frame }); return; }
    if (frame.type === "event.batch") { await phone.resync(); return; }
    throw error("UNSUPPORTED_TYPE");
  }
  async function attachPeer(stream) {
    const p = peer(stream.peerDeviceId); if (!p) { stream.destroy(); throw error("FORBIDDEN"); }
    if (stopped || !relay?.online || stream.destroyed) { stream.destroy(); throw error("OFFLINE"); }
    const old = channels.get(p.deviceId);
    if (old && currentHolder(old)) { stream.destroy(); await old.channel.ready; if (!currentHolder(old)) throw error("OFFLINE"); return old.channel; }
    if (old) { channels.delete(p.deviceId); old.channel.close(); }
    const channel = createSecureChannel({ role: stream.initiator ? "client" : "server", transport: stream, credentials: bundle.credentials,
      peerPin: p.spkiSha256, replayGuard, now, authorizeFrame: (f) => !!peer(p.deviceId)
        && [f.fromDeviceId, f.toDeviceId].includes(ownId()) && [f.fromDeviceId, f.toDeviceId].includes(p.deviceId) });
    const holder = { channel, stream, deviceId: p.deviceId, relay, queue: [], bytes: 0, sending: false,
      inbox: [], inboxBytes: 0, jobs: 0, relayGeneration };
    channels.set(p.deviceId, holder);
    const drainIncoming = () => {
      while (holder.inbox.length && holder.jobs < 8 && currentHolder(holder)) {
        const { frame, bytes } = holder.inbox.shift(); holder.inboxBytes -= bytes; holder.jobs++;
        void incoming(frame, p.deviceId, holder).catch((e) => {
          if (currentHolder(holder)) lastError = e.code || "INTERNAL_ERROR";
          channel.close();
        }).finally(() => { holder.jobs--; drainIncoming(); });
      }
    };
    channel.onMessage((frame) => {
      if (!currentHolder(holder)) return;
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      // A legal reconnect can coalesce invite+notice for several grants in one
      // TLS chunk. Bound waiting bytes/items separately from active source jobs.
      if (holder.inbox.length >= 128 || holder.inboxBytes + bytes > LIMITS.LOW_QUEUE_BYTES) { channel.close(); return; }
      holder.inbox.push({ frame, bytes }); holder.inboxBytes += bytes; drainIncoming();
    });
    channel.onClose(() => {
      holder.inbox.length = 0; holder.inboxBytes = 0;
      const current = channels.get(p.deviceId) === holder && holder.relayGeneration === relayGeneration && holder.relay === relay;
      if (channels.get(p.deviceId) === holder) channels.delete(p.deviceId);
      for (const job of holder.queue.splice(0)) job.reject(error("OFFLINE"));
      if (!current) return;
      rejectRpc("OFFLINE", p.deviceId);
      for (const g of remote.values()) if (g.hostDeviceId === p.deviceId && g.state === "active") g.resumeRequired = true;
      for (const [rid, notice] of remoteNotices) if (remote.get(rid)?.hostDeviceId === p.deviceId) notice.current = false;
      emitTransport({ type: "connection", state: "offline" });
      schedulePeerReconnect(p.deviceId);
    });
    try {
      await channel.ready;
      if (stopped || !currentHolder(holder)) throw error("OFFLINE");
      for (const g of store.grants().filter((g) => g.state === "release-pending" && g.hostDeviceId === p.deviceId && !g.localSessionId)) {
        if (g.expiresAt <= now()) { store.removeGrant(g.remoteSessionId); continue; }
        const frame = createFrame("host.release", binding(g, true), {}, { now, correlationId: randomUUID() });
        let timer;
        const response = new Promise((resolve, reject) => {
          timer = setTimeout(() => { rpc.delete(frame.correlationId); reject(error("OFFLINE")); }, 1500);
          rpc.set(frame.correlationId, { request: frame, resolve, reject, timer });
        });
        response.catch(() => {});
        try { await queueSend(channel, frame); await response; store.removeGrant(g.remoteSessionId); }
        catch {} finally { clearTimeout(timer); rpc.delete(frame.correlationId); }
        if (!currentHolder(holder)) throw error("OFFLINE");
      }
      for (const w of [...channelWaiters]) if (w.deviceId === p.deviceId) { channelWaiters.delete(w); clearTimeout(w.timer); w.resolve(channel); }
      for (const g of local.values()) if (g.phoneDeviceId === p.deviceId && ["active", "invited"].includes(g.state) && g.expiresAt > now()) {
        await queueSend(channel, createFrame("host.invite", binding(g), { title: g.title, deviceName: store.config()?.deviceName || "CC device", expiresAt: g.expiresAt }, { now }));
        if (g.state === "active") await sendNotice(g, holder);
      }
      if (!currentHolder(holder)) throw error("OFFLINE");
      for (const g of remote.values()) if (g.hostDeviceId === p.deviceId && g.state === "active") g.resumeRequired = true;
      clearTimeout(peerRetries.get(p.deviceId)); peerRetries.delete(p.deviceId);
      emitTransport({ type: "connection", state: "online" }); return channel;
    } catch (e) { channel.close(); throw e; }
  }
  async function ensurePeer(deviceId) {
    if (stopped) throw error("OFFLINE");
    checkId(deviceId);
    if (!relay?.online || !peer(deviceId)) throw error("OFFLINE");
    const found = channels.get(deviceId);
    if (found && currentHolder(found)) { await found.channel.ready; if (!currentHolder(found)) throw error("OFFLINE"); return found.channel; }
    if (found) { channels.delete(deviceId); found.channel.close(); }
    if (peerOpening.has(deviceId)) return peerOpening.get(deviceId);
    if (ownId() < deviceId) {
      const connection = relay, epoch = relayGeneration;
      const opening = (async () => {
        const stream = await connection.openTunnel(deviceId);
        if (stopped || epoch !== relayGeneration || connection !== relay || !connection.online) { stream.destroy(); throw error("OFFLINE"); }
        return attachPeer(stream);
      })();
      peerOpening.set(deviceId, opening);
      try { return await opening; }
      catch (e) { if (epoch === relayGeneration && connection === relay) schedulePeerReconnect(deviceId); throw e; }
      finally { if (peerOpening.get(deviceId) === opening) peerOpening.delete(deviceId); }
    }
    if (channelWaiters.size >= 8) throw error("LIMIT_EXCEEDED");
    return new Promise((resolve, reject) => { const w = { deviceId, resolve, reject, timer: setTimeout(() => { channelWaiters.delete(w); reject(error("OFFLINE")); }, 15000) }; channelWaiters.add(w); });
  }
  async function attachPair(stream, offer = null, pending = null) {
    const job = pending || beginPairing(stream.peerDeviceId); job.stream = stream;
    try {
      checkPairing(job);
      const channel = job.channel = createPairingChannel({ role: stream.initiator ? "client" : "server", transport: stream,
        credentials: bundle.credentials, ...(offer ? { peerPin: offer.tablet.spkiSha256 } : {}), now });
      await channel.ready; checkPairing(job);
      if (stream.peerDeviceId !== channel.peerIdentity.deviceId) throw error("DEVICE_MISMATCH");
      return offer ? job.manager.acceptOffer(offer, channel) : job.manager.attachIncoming(channel);
    } catch (e) { job.channel?.close(); stream.destroy(); throw e; }
    finally { if (!pending) pairingWork.delete(job); }
  }
  function resetPairManager() {
    pairManager?.close();
    const manager = createPairingManager({ identity: { ...bundle.identity, name: store.config()?.deviceName || bundle.identity.name }, now,
      async persistPairing(record, guard) {
        // No await separates the attempt guard from synchronous atomic store publish.
        if (stopped || pairManager !== manager || !guard || guard.signal.aborted || guard.isCurrent() !== true
            || record.localDevice.deviceId !== ownId()) throw error("PAIRING_REJECTED");
        store.putPeer(record.peerDevice);
        const epoch = relayGeneration;
        setTimeout(() => { if (!stopped && pairManager === manager && epoch === relayGeneration && guard.isCurrent() && peer(record.peerDevice.deviceId) && ownId() < record.peerDevice.deviceId) void ensurePeer(record.peerDevice.deviceId).catch(() => {}); }, 250);
      } });
    pairManager = manager;
  }
  async function setup() {
    if (stopped) throw error("OFFLINE");
    await ensureIdentity();
    if (stopped) throw error("OFFLINE");
    if (phone) return;
    resetPairManager();
    control = createTabletControl({ deviceId: ownId(), hostInstanceId, ledgerPath: path.join(dir, "commands.json"),
      readGrant: (rid) => local.get(rid), executor, now });
    control.onReceipt((f) => { void send(f).catch(() => {}); });
    phone = createPhoneManager({ deviceId: ownId(), now, transport: {
      async list() { pruneRemoteGrants(); return [...remote.values()].filter((g) => ["invited", "active"].includes(g.state) && g.expiresAt > now()).map((g) => ({ remoteSessionId: g.remoteSessionId, deviceId: g.hostDeviceId, title: g.title, deviceName: g.deviceName, grantVersion: g.grantVersion, state: g.state, expiresAt: g.expiresAt, pendingCount: remoteNotices.get(g.remoteSessionId)?.pending.filter((r) => r.expiresAt > now()).length || 0 })); },
      async open({ remoteSessionId }) { const g = remote.get(remoteSessionId); if (!g || g.state !== "active") throw error("GRANT_NOT_ACTIVE"); const f = await requestFrame(createFrame("session.subscribe", binding(g, true), {}, { now, correlationId: randomUUID() })); g.resumeRequired = false; return { ...f.payload, binding: reverse(subsetBinding(f)) }; },
      async history({ binding: b, cursor, limit }) { const f = await requestFrame(createFrame("history.get", b, { cursor, limit }, { now, correlationId: randomUUID() }), 2); return { streamId: f.payload.streamId, items: f.payload.items, cursor: f.payload.nextCursor, hasMore: f.payload.hasMore, binding: reverse(subsetBinding(f)) }; },
      async close({ binding: b }) { await send(createFrame("session.unsubscribe", b, {}, { now })); },
      send: (f) => requestFrame(f), query: (f) => requestFrame(f),
      async accept({ remoteSessionId }) {
        const g = remote.get(remoteSessionId); if (!g || g.state !== "invited") throw error("GRANT_NOT_ACTIVE");
        const f = await requestFrame(createFrame("host.accept", binding(g, true), {}, { now, correlationId: randomUUID() }));
        g.state = "active"; g.runId = f.runId; g.resumeRequired = false;
        return { ...f.payload, binding: reverse(subsetBinding(f)) };
      },
      async decline({ remoteSessionId }) {
        const g = remote.get(remoteSessionId); if (!g || g.state !== "invited") throw error("GRANT_NOT_ACTIVE");
        await requestFrame(createFrame("host.decline", binding(g, true), {}, { now, correlationId: randomUUID() }));
        g.state = "revoked"; g.retiredUntil ??= Math.min(g.expiresAt, now() + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS);
        remoteNotices.delete(remoteSessionId);
        return { remoteSessionId, deviceId: g.hostDeviceId, grantVersion: g.grantVersion, state: "declined" };
      },
      subscribe(fn) { transports.add(fn); return () => transports.delete(fn); },
    } });
    phone.subscribe((s) => { for (const fn of listeners) { try { fn(s); } catch {} } void notificationSync(s); });
    setupNotices();
  }
  let sourceOff = null;
  async function sendNotice(g, holder = null) {
    if (stopped || g.state !== "active" || g.expiresAt <= now()) return;
    if (!holder) {
      const epoch = relayGeneration, channel = await ensurePeer(g.phoneDeviceId);
      holder = channels.get(g.phoneDeviceId);
      if (epoch !== relayGeneration || !holder || holder.channel !== channel || !currentHolder(holder)) throw error("OFFLINE");
    }
    // Resolve any handshake before sampling metadata. A pre-handshake request
    // must never be sent after attachPeer has refreshed a newer pending state.
    if (stopped || !currentHolder(holder) || g.state !== "active" || g.expiresAt <= now()) return;
    const item = notices.get(g.remoteSessionId), current = executor.getRunOfSession(g.localSessionId);
    const pending = control.describeRequests(g.localSessionId), runId = current?.id || item?.event.runId || g.runId || null;
    g.runId = runId;
    const state = current ? pending.length ? "waiting" : current.idle ? "ended" : "running" : runId ? item?.event.aborted ? "stopped" : "ended" : "idle";
    const payload = { run: { runId, state }, pending: pending.slice(0, 32).map((r) => ({ requestId: r.requestId, requestVersion: r.requestVersion, expiresAt: r.expiresAt })),
      eventId: (runId || "idle") + ":" + state };
    const frame = createFrame("session.notice", { ...binding(g), runId }, payload, { now });
    await queueSend(holder.channel, frame);
    if (notices.get(g.remoteSessionId) === item && item) item.dirty = false;
  }
  function setupNotices() {
    if (sourceOff) return;
    sourceOff = executor.onEvent((event) => {
      if (!["perm_request", "perm_resolved", "run_start", "run_end", "run_idle", "init"].includes(event?.type)) return;
      for (const g of local.values()) {
        if (g.state !== "active" || g.expiresAt <= now()) continue;
        const run = executor.getRunOfSession(g.localSessionId);
        if (event.sessionId !== g.localSessionId && (!run || event.runId !== run.id) && event.runId !== g.runId) continue;
        const old = notices.get(g.remoteSessionId);
        if (old?.timer) clearTimeout(old.timer);
        const item = { event: { type: event.type, runId: event.runId, aborted: event.aborted === true }, timer: null, dirty: true };
        notices.set(g.remoteSessionId, item);
        item.timer = setTimeout(async () => {
          item.timer = null;
          try { await sendNotice(g); }
          catch (e) { lastError = e.code || "INTERNAL_ERROR"; }
        }, 80); item.timer.unref?.();
      }
    });
  }
  async function connect() {
    if (stopped) throw error("OFFLINE");
    if (connecting?.epoch === relayGeneration) return connecting.promise;
    if (relay?.online) return envelope();
    // Reserve the generation before identity/vault awaits. Disconnect invalidates
    // this attempt even when it has not created a WebSocket yet.
    const attempt = { epoch: ++relayGeneration, promise: null };
    connecting = attempt;
    attempt.promise = (async () => {
      const epoch = attempt.epoch;
      const valid = () => !stopped && epoch === relayGeneration && connecting === attempt;
      await setup();
      if (!valid()) throw error("OFFLINE");
      const config = store.config(); if (!config?.serverUrl) throw error("INVALID_SERVER");
      const raw = await store.credential(); let credential;
      if (!valid()) throw error("OFFLINE");
      try { credential = JSON.parse(raw); } catch { throw error("INVALID_CREDENTIAL"); }
      if (credential.deviceId !== ownId()) throw error("DEVICE_MISMATCH");
      connection = "connecting";
      const oldRelay = relay; relay = null; clearChannels(); oldRelay?.dispose();
      const currentRelay = relayFactory({ serverUrl: config.serverUrl, deviceId: ownId(), token: credential.token, allowLoopback });
      relay = currentRelay;
      currentRelay.on("tunnel", (s) => { if (epoch !== relayGeneration || currentRelay !== relay || stopped) { s.destroy(); return; } void (s.purpose === "pairing" ? attachPair(s) : attachPeer(s)).catch(() => { s.destroy(); }); });
      currentRelay.on("connection", (s) => {
        if (epoch !== relayGeneration || currentRelay !== relay) return;
        connection = s.state === "online" ? "online" : "disconnected"; checkedAt = now();
        void hostAdapter.reportConnectionState?.(s.state, checkedAt).catch(() => {});
        if (s.state === "offline") { cancelPairing(); clearChannels(); emitTransport({ type: "connection", state: "offline" }); scheduleReconnect(); }
      });
      currentRelay.on("metadata", (f) => {
        if (epoch !== relayGeneration || currentRelay !== relay) return;
        if (f.op === "peer.status" && f.status === "online" && peer(f.deviceId) && ownId() < f.deviceId) void ensurePeer(f.deviceId).catch(() => {});
        if (f.op === "pair.confirmed" && peer(f.peerDeviceId) && ownId() < f.peerDeviceId) void ensurePeer(f.peerDeviceId).catch(() => {});
        if (f.op === "pair.revoked") void unpair({ deviceId: f.peerDeviceId }, false).catch(() => {});
        if (f.op === "wake.hint" && peer(f.fromDeviceId)) { if (ownId() < f.fromDeviceId) void ensurePeer(f.fromDeviceId).catch(() => {}); try { currentRelay.ackHint(f.fromDeviceId, f.hintId); } catch {} }
      });
      try {
        await currentRelay.connect();
        if (!valid() || currentRelay !== relay || !currentRelay.online) throw error("OFFLINE");
        lastError = null; checkedAt = now(); clearTimeout(retry); retry = null;
      } catch (e) {
        if (valid() && currentRelay === relay) { relay = null; clearChannels(); currentRelay.dispose(); connection = "error"; lastError = e.code || "OFFLINE"; }
        throw e;
      }
      for (const p of store.peers()) if (ownId() < p.deviceId) void ensurePeer(p.deviceId).catch(() => {});
      return envelope();
    })();
    try { return await attempt.promise; } finally { if (connecting === attempt) connecting = null; }
  }
  function scheduleReconnect() {
    if (stopped || retry) return;
    retry = setTimeout(async () => { retry = null; const s = await hostStatus(); if (!s.shouldConnect) return;
      try { await connect(); } catch { scheduleReconnect(); } }, 3000); retry.unref?.();
  }
  async function configure(b) {
    if (configuring) throw error("LIMIT_EXCEEDED");
    configuring = true;
    try { return await configureNow(b); } finally { configuring = false; }
  }
  async function configureNow(b) {
    if (stopped) throw error("OFFLINE");
    const u = relayUrl(b.serverUrl, { allowLoopback });
    if (typeof b.deviceName !== "string" || !b.deviceName.trim() || b.deviceName.length > 40 || /[\x00-\x1f\x7f]/.test(b.deviceName)) throw error("INVALID_SCHEMA");
    const checkEndpoint = () => {
      // Pairing is scoped to the configured relay, not portable to an arbitrary
      // new endpoint. Check before registration and again after asynchronous I/O.
      if (store.config()?.serverUrl !== u.origin && (store.peers().length || pairingWork.size
          || pairManager?.listPending().some((p) => !["complete", "rejected"].includes(p.state)))) throw error("PAIRED_RELAY_CHANGE");
    };
    checkEndpoint();
    await ensureIdentity();
    let credential = b.credential;
    if (credential) {
      if (typeof credential !== "string" || credential.length > 4096) throw error("INVALID_CREDENTIAL");
      let parsed;
      try { parsed = JSON.parse(credential); } catch {}
      if (parsed && parsed.deviceId === ownId() && typeof parsed.token === "string" && parsed.token.length >= 32) credential = JSON.stringify({ deviceId: parsed.deviceId, token: parsed.token });
      else {
        const publicKey = createPublicKey(bundle.credentials.key).export({ type: "spki", format: "pem" });
        const signature = sign("sha256", Buffer.from("cc-remote-register-v1:" + ownId()), bundle.credentials.key).toString("base64");
        const r = await fetchImpl(new URL("/v1/devices/register", u), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: "Bearer " + credential, "content-type": "application/json" }, body: JSON.stringify({ publicKey, signature }) });
        if (!r.ok || Number(r.headers.get("content-length")) > 8192) throw error("AUTH_FAILED");
        const value = await r.json();
        if (value.deviceId !== ownId() || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 256) throw error("AUTH_FAILED");
        credential = JSON.stringify({ deviceId: ownId(), token: value.token });
      }
    } else if (store.config()?.serverUrl !== u.origin) throw error("INVALID_CREDENTIAL");
    if (stopped) throw error("OFFLINE");
    checkEndpoint();
    await disconnect();
    if (stopped) throw error("OFFLINE");
    pairManager?.close(); offers.clear();
    try { await store.configure({ serverUrl: u.origin, deviceName: b.deviceName.trim() }, credential); }
    finally { if (pairManager && !stopped) resetPairManager(); }
    await connect(); return settings();
  }
  async function settings() {
    const c = store.config(), s = await hostStatus(); backgroundEnabled = s.backgroundEnabled === true;
    return { ok: true, serverUrl: c?.serverUrl || "", deviceName: c?.deviceName || "", hasCredential: !!c?.sealedCredential,
      deviceId: ownId(), connection: { state: c ? connection : "unconfigured", checkedAt, errorCode: lastError, diagnostics: { ...diagnostics, subscriptions: subscriptions.size } },
      reminders: { enabled: backgroundEnabled, permission: s.systemNotifications === true && s.eventChannel === true ? "granted" : hostAdapter.available ? "denied" : "unsupported",
        background: !hostAdapter.available ? "unsupported" : s.backgroundEffective ? "active" : s.backgroundEnabled ? "restricted" : "foreground" } };
  }
  async function pairing() {
    const attempts = pairManager?.listPending() || [];
    const pending = attempts.map((p) => ({ pairingId: p.role === "tablet" ? p.offerId : p.attemptId, state: p.state === "complete" ? "paired" : p.state === "rejected" ? "rejected" : "awaiting-confirmation",
      peer: publicDevice(p.peer), verificationCode: verification(p), expiresAt: p.expiresAt, localConfirmed: p.localConfirmed, peerConfirmed: p.peerConfirmed,
      localPersisted: p.persisted, peerPersisted: p.peerPersisted })) || [];
    for (const o of offers.values()) if (o.expiresAt > now() && !attempts.some((p) => p.offerId === o.offerId)) pending.push({ pairingId: o.offerId, state: "offered", expiresAt: o.expiresAt, peer: null, verificationCode: "", localConfirmed: false, peerConfirmed: false });
    return { ok: true, devices: store.peers().map(publicDevice), pending };
  }
  function verification(p) { return createHash("sha256").update([bundle.identity.spkiSha256, p.peer.spkiSha256].sort().join(":") + ":" + p.offerId).digest("hex").slice(0, 24).match(/.{1,4}/g).join("-"); }
  async function pairOffer() {
    await connect(); const offer = pairManager.createOffer(); await relay.registerOffer(offer); offers.set(offer.offerId, offer);
    const pairing = { pairingId: offer.offerId, state: "offered", expiresAt: offer.expiresAt, peer: null, verificationCode: "", localConfirmed: false, peerConfirmed: false };
    return { ok: true, ...pairing, code: JSON.stringify(offer), offer: { pairingId: offer.offerId, code: JSON.stringify(offer), expiresAt: offer.expiresAt }, pairing };
  }
  async function pairJoin({ code }) {
    const epoch = pairingEpoch;
    if (typeof code !== "string" || code.length > 8192) throw error("INVALID_SCHEMA");
    let offer; try { offer = validatePairingOffer(JSON.parse(code), { now }); } catch { throw error("INVALID_PAIRING"); }
    await connect(); if (epoch !== pairingEpoch) throw error("OFFLINE");
    const job = beginPairing(offer.tablet.deviceId);
    let attemptId;
    try {
      job.stream = await job.relay.openTunnel(offer.tablet.deviceId, { purpose: "pairing", offerId: offer.offerId });
      checkPairing(job); attemptId = await attachPair(job.stream, offer, job);
      const until = Date.now() + 10000;
      let p;
      do {
        checkPairing(job); p = job.manager.listPending().find((p) => p.attemptId === attemptId);
        if (p?.state === "pending-confirmation") break;
        if (p?.state === "rejected") throw error("PAIRING_REJECTED");
        await new Promise((r) => setTimeout(r, 20));
      } while (Date.now() < until);
      checkPairing(job); if (p?.state !== "pending-confirmation") throw error("OFFLINE");
      const result = (await pairing()).pending.find((p) => p.pairingId === attemptId);
      checkPairing(job); return { ok: true, ...result, pairing: result };
    } catch (e) {
      if (attemptId) { try { job.manager.reject(attemptId); } catch {} }
      job.channel?.close(); job.stream?.destroy(); throw e;
    } finally { pairingWork.delete(job); }
  }
  async function pairConfirm(b) {
    const p = pairManager?.listPending().find((p) => p.attemptId === b.pairingId || p.role === "tablet" && p.offerId === b.pairingId);
    if (!p || p.peer.spkiSha256 !== b.expectedFingerprint || verification(p) !== b.verificationCode) throw error("FINGERPRINT_MISMATCH");
    const currentRelay = relay;
    if (p.state !== "pending-confirmation" || p.localConfirmed || p.expiresAt <= now() || !currentRelay?.online) throw error("PAIRING_REJECTED");
    // confirm() performs its local/channel checks synchronously before its first
    // await. Vote only after observing that acceptance, but before a fast peer
    // can close the completed bootstrap tunnel and retire the relay attempt.
    const confirming = pairManager.confirm(p.attemptId, p.peer.spkiSha256);
    confirming.catch(() => {});
    const current = pairManager.listPending().find((item) => item.attemptId === p.attemptId);
    if (!current?.localConfirmed || current.state === "rejected") { await confirming; throw error("PAIRING_REJECTED"); }
    void currentRelay.confirmPair(p.peer.deviceId).catch(() => {});
    try { await confirming; }
    catch (e) { void currentRelay.revokePair(p.peer.deviceId).catch(() => {}); throw e; }
    const result = (await pairing()).pending.find((q) => q.pairingId === b.pairingId);
    return { ok: true, ...result, pairing: result };
  }
  async function pairCancel({ pairingId }) { cancelPairing(); if (offers.has(pairingId)) { pairManager.cancelOffer(pairingId); offers.delete(pairingId); relay?.cancelOffer(pairingId); } else pairManager?.reject(pairingId); return { ok: true, pairingId, state: "cancelled", expiresAt: now(), peer: null, verificationCode: "", localConfirmed: false, peerConfirmed: false }; }
  async function unpair({ deviceId }, notify = true) {
    checkId(deviceId);
    cancelPairing(deviceId); pairManager?.cancelPeer(deviceId);
    const grants = [...local.values()].filter((g) => g.phoneDeviceId === deviceId && ["invited", "active"].includes(g.state));
    // Every revoke erects its synchronous dispatch barrier before the first await.
    // Neither a slow peer notification nor another session can extend this lease.
    const revocations = grants.map((g) => control.revoke(g.remoteSessionId, () => revokeLocal(g)));
    channels.get(deviceId)?.channel.close(); store.removePeer(deviceId);
    for (const g of remote.values()) if (g.hostDeviceId === deviceId) { remote.delete(g.remoteSessionId); remoteNotices.delete(g.remoteSessionId); }
    await Promise.all(revocations);
    if (notify && relay?.online) await relay.revokePair(deviceId);
    emitTransport({ type: "reset" }); await hostAdapter.clearNotifications().catch(() => {}); return { ok: true };
  }
  async function hosting(localSessionId) {
    if (typeof localSessionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(localSessionId)) throw error("SESSION_MISMATCH");
    const meta = await sourceAdapter.describe(localSessionId); if (!meta) throw error("SESSION_MISMATCH");
    const g = [...local.values()].reverse().find((g) => g.localSessionId === localSessionId);
    return { ok: true, session: { localSessionId, title: meta.title || "" }, devices: store.peers().map(publicDevice), connection: { state: connection, checkedAt }, hosting: g ? { remoteSessionId: g.remoteSessionId, deviceId: g.phoneDeviceId, deviceName: peer(g.phoneDeviceId)?.name || "", grantVersion: g.grantVersion, status: g.expiresAt <= now() ? "expired" : g.state, expiresAt: g.expiresAt } : null };
  }
  async function invite({ localSessionId, deviceId }) {
    if (stopped) throw error("OFFLINE");
    if (typeof localSessionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(localSessionId)) throw error("SESSION_MISMATCH");
    checkId(deviceId);
    if (inviting.has(localSessionId)) throw error("HOSTING_CONFLICT");
    if (inviting.size >= 32) throw error("LIMIT_EXCEEDED");
    inviting.add(localSessionId);
    try {
      await connect(); if (!peer(deviceId)) throw error("FORBIDDEN");
      const epoch = pairingEpoch, h = await hosting(localSessionId);
      if (stopped || epoch !== pairingEpoch || !peer(deviceId)) throw error("OFFLINE");
      if (h.hosting && ["invited", "active"].includes(h.hosting.status)) throw error("HOSTING_CONFLICT");
      pruneLocalGrants();
      const grant = { hostDeviceId: ownId(), phoneDeviceId: deviceId, hostInstanceId, remoteSessionId: randomUUID(), grantVersion: 1,
        localSessionId, title: h.session.title, state: "invited", expiresAt: now() + 24 * 3600000, runId: executor.getRunOfSession(localSessionId)?.id || null };
      await data.authorize({ ...grant, deviceId });
      try {
        if (stopped || epoch !== pairingEpoch || !peer(deviceId)) throw error("OFFLINE");
        // Publish only after durable metadata succeeds. A full/failed store
        // cannot leave an invited in-memory grant or an authorized source.
        const remoteLeases = [...remote.values()].filter((g) => ["invited", "active"].includes(g.state) && g.expiresAt > now()).length;
        if (store.grants().length + remoteLeases >= MAX_SESSIONS) throw error("LIMIT_EXCEEDED");
        store.putGrant(grant); local.set(grant.remoteSessionId, grant);
      } catch (e) { try { data.revoke(grant.remoteSessionId); } catch {} throw e; }
      const f = createFrame("host.invite", binding(grant), { title: grant.title, deviceName: store.config()?.deviceName || "CC device", expiresAt: grant.expiresAt }, { now });
      try { await send(f); } catch { relay?.hint(deviceId, "invite"); }
      return hosting(localSessionId);
    } finally { inviting.delete(localSessionId); }
  }
  async function revoke({ localSessionId, remoteSessionId, grantVersion }) {
    const g = local.get(remoteSessionId);
    if (!g || g.localSessionId !== localSessionId || g.grantVersion !== grantVersion) throw error("GRANT_MISMATCH");
    await control.revoke(g.remoteSessionId, () => revokeLocal(g));
    try { await send(createFrame("host.revoke", binding(g), { reason: "revoked" }, { now })); } catch {}
    return hosting(localSessionId);
  }
  async function diagnose(b) {
    let ok = false, probe;
    try {
      const u = relayUrl(b.serverUrl, { allowLoopback });
      await ensureIdentity();
      let credential;
      try { credential = JSON.parse(b.credential || await store.credential()); } catch { throw error("INVALID_CREDENTIAL"); }
      if (credential.deviceId !== ownId() || typeof credential.token !== "string") throw error("INVALID_CREDENTIAL");
      if (u.origin === store.config()?.serverUrl && relay?.online && b.credential === undefined) {
        // A second auth using the same device ID would replace the live route.
        // Probe the established authenticated WSS with a fresh ping instead.
        if (typeof relay.ping === "function") await relay.ping();
        else await relay.connect();
        ok = relay.online === true;
      } else {
        // Test the submitted endpoint, not an older endpoint's readiness bit.
        probe = relayFactory({ serverUrl: u.origin, deviceId: ownId(), token: credential.token, allowLoopback });
        await probe.connect(); ok = probe.online === true;
      }
    } catch {} finally { probe?.dispose(); }
    return { ok: true, diagnostic: { state: ok ? "online" : "failed", checkedAt: now(), checks: ["dns", "tls", "auth", "relay"].map((stage) => ({ stage, status: ok ? "pass" : "fail" })) } };
  }
  async function disconnect() {
    const old = relay; relay = null; relayGeneration++; connecting = null; cancelPairing(); clearChannels(); old?.dispose(); connection = "disconnected";
    emitTransport({ type: "connection", state: "offline" });
    clearTimeout(retry); retry = null;
    for (const off of subscriptions.values()) off(); subscriptions.clear();
    return envelope();
  }
  const api = {
    hostInstanceId, settings, configure, diagnose, connect, disconnect, pairing, pairOffer, pairJoin, pairConfirm, pairCancel, unpair, hosting, invite, revoke,
    async reminders(enabled) { if (typeof enabled !== "boolean") throw error("INVALID_SCHEMA"); await hostAdapter.setBackgroundEnabled(enabled, { userInitiated: true }); return settings(); },
    status: envelope,
    async list() { if (!phone && store.config()) await setup(); return phone ? phone.list() : envelope(); },
    async open({ remoteSessionId }) { await connect(); return phone.open(checkId(remoteSessionId)); },
    async close() { return phone ? phone.close() : envelope(); },
    async accept({ remoteSessionId }) { await connect(); return phone.accept(checkId(remoteSessionId)); },
    async decline({ remoteSessionId }) { return phone ? phone.decline(checkId(remoteSessionId)) : envelope(); },
    async command({ generation, binding: b, type, commandId, payload }) {
      if (!phone) throw error("OFFLINE");
      return phone.command({ generation, binding: b, type, commandId, payload });
    },
    async history({ generation, binding: b, cursor }) { if (!phone) throw error("OFFLINE"); return phone.history(cursor, { generation, binding: b }); },
    async query({ generation, binding: b, commandId }) { if (!phone) throw error("OFFLINE"); return phone.query(commandId, { generation, binding: b }); },
    subscribe(fn) { if (listeners.size >= 64) throw error("LIMIT_EXCEEDED"); listeners.add(fn); void envelope().then((e) => { if (listeners.has(fn)) fn(e.snapshot); }); return () => listeners.delete(fn); },
    async retire() {
      // Gate before the first await: queued controls cannot win a race with a
      // component disable/upgrade. Original runs are never aborted here.
      if (disposed) return;
      stopped = true; store.invalidateConfiguration?.(); cancelPairing(); pairManager?.close(); clearTimeout(retry); policyOff?.(); sourceOff?.(); control?.close();
      const changes = [...local.values()].filter((g) => ["invited", "active"].includes(g.state)).map(async (g) => {
        const change = () => revokeLocal(g);
        if (control) await control.revoke(g.remoteSessionId, change); else change();
        const holder = channels.get(g.phoneDeviceId);
        if (holder && !holder.channel.closed) {
          const frame = createFrame("host.revoke", binding(g), { reason: "revoked" }, { now, correlationId: randomUUID() });
          let timer;
          const response = new Promise((resolve, reject) => {
            timer = setTimeout(() => { rpc.delete(frame.correlationId); reject(error("OFFLINE")); }, 1000);
            rpc.set(frame.correlationId, { request: frame, resolve, reject, timer });
          });
          response.catch(() => {});
          try { await Promise.race([queueSend(holder.channel, frame), response.then(() => {})]); await response; }
          catch {} finally { clearTimeout(timer); rpc.delete(frame.correlationId); }
        }
      });
      const releases = [...remote.values()].filter((g) => ["invited", "active"].includes(g.state) && g.expiresAt > now()).map(async (g) => {
        const frame = createFrame("host.release", binding(g, true), {}, { now, correlationId: randomUUID() });
        // Persist a tombstone even when offline. On the next authenticated
        // channel it is flushed before any invite; old grants cannot resume.
        store.putGrant({ ...g, state: "release-pending" });
        const holder = channels.get(g.hostDeviceId);
        if (!holder || holder.channel.closed) return;
        let timer;
        const response = new Promise((resolve, reject) => {
          timer = setTimeout(() => { rpc.delete(frame.correlationId); reject(error("OFFLINE")); }, 1000);
          rpc.set(frame.correlationId, { request: frame, resolve, reject, timer });
        });
        response.catch(() => {});
        try {
          await Promise.race([queueSend(holder.channel, frame), response.then(() => {})]);
          await response; store.removeGrant(g.remoteSessionId);
        } catch {} finally { clearTimeout(timer); rpc.delete(frame.correlationId); }
      });
      try { await Promise.all([...changes, ...releases]); }
      finally {
        remote.clear(); remoteNotices.clear(); completedRuns.clear(); nextNotifications = null;
        emitTransport({ type: "reset" });
        await api.dispose();
        await hostAdapter.clearNotifications().catch(() => {});
        await hostAdapter.setBackgroundEnabled(false, { userInitiated: true }).catch(() => {});
        await hostAdapter.reportConnectionState("offline").catch(() => {});
      }
    },
    async dispose() { if (disposed) return; disposed = true; stopped = true; store.invalidateConfiguration?.(); cancelPairing(); clearTimeout(retry); sourceOff?.(); for (const n of notices.values()) clearTimeout(n.timer); notices.clear(); remoteNotices.clear(); completedRuns.clear(); nextNotifications = null; policyOff?.(); pairManager?.close(); phone?.dispose(); control?.close(); data.dispose(); subscriptions.forEach((off) => off()); channels.forEach((h) => h.channel.close()); listeners.clear(); rejectRpc("OFFLINE"); await disconnect(); bundle?.dispose?.(); },
  };
  if (autoConnect) policyOff = hostAdapter.watchPolicy(async (s) => {
    if (stopped || policyBusy || !store.config()) return;
    policyBusy = true;
    try { if (s.shouldConnect && !relay?.online) await connect(); else if (!s.shouldConnect && relay?.online) await disconnect(); }
    catch { scheduleReconnect(); } finally { policyBusy = false; }
  });
  return Object.freeze(api);
}

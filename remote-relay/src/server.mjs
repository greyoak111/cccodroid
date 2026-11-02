import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MetadataStore } from './store.mjs';
import { TokenBucket, PriorityOutbox } from './flow.mjs';
import { RELAY_VERSION, RelayError, fail, exact, id, integer, tokenHash, hash,
  pairKey, routeKey, routeBinding, sameRoute, validateLimits, validateMetadata } from './validation.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const KINDS = Object.freeze({ control: 0, receipt: 0, revoke: 0, reminder: 0, invite: 0, event: 1, history: 2 });
const DURABLE = new Set(['invite', 'reminder']);
const SAFE_CODES = new Set(['invalid_frame', 'invalid_id', 'invalid_envelope', 'unsupported_version', 'unsupported_op',
  'frame_too_large', 'unauthorized', 'forbidden', 'unpaired', 'device_revoked', 'peer_offline', 'route_inactive',
  'route_mismatch', 'route_expired', 'stale_grant', 'expired', 'not_yet_valid', 'ttl_exceeded', 'rate_limited',
  'backpressure', 'pending_full', 'duplicate_conflict', 'state_capacity', 'internal_error']);
const safeCode = error => SAFE_CODES.has(error?.code) ? error.code : 'internal_error';
const statusWire = (messageId, status, code) => ({ v: 1, op: 'relay.status', messageId, status, ...(code ? { code } : {}) });

/**
 * Standalone service. The injected inspector MUST validate 02's authenticated
 * outer header/ciphertext format without decrypting it. No fallback accepts
 * arbitrary JSON as "encrypted". The CLI loads the shared 02 inspector.
 */
export async function createRelayServer({ devices = [], pairs = [], stateFile = null,
  inspectEnvelope, limits: limitOverrides, now = Date.now, logger = () => {}, tls = null,
  allowedOrigins = [], outboxFactory = options => new PriorityOutbox(options) } = {}) {
  if (typeof inspectEnvelope !== 'function') throw new TypeError('inspectEnvelope_required');
  const limits = validateLimits(limitOverrides);
  if (!Array.isArray(devices) || !Array.isArray(pairs) || devices.length > limits.maxDevices || pairs.length > limits.maxPairs) {
    fail('invalid_configuration');
  }
  const bootId = randomUUID();
  const connections = new Map();
  const activeRoutes = new Map();
  const blockedDevices = new Set();
  const blockedPairs = new Set();
  const metrics = { accepted: 0, rejected: 0, forwarded: 0, stored: 0, expired: 0, authRejected: 0 };
  const upgradeBucket = new TokenBucket({ rate: limits.upgradesPerSecond, burst: limits.upgradeBurst, now });
  const origins = new Set(allowedOrigins);
  let stopped = false;
  let mutation = Promise.resolve();
  let state;
  let deviceMap;
  let paired;
  let routeMap;
  const pendingDelivery = new Set();
  const pendingDeliveredToConnection = new Set();
  const store = new MetadataStore({ stateFile, now, maxStateBytes: limits.maxStateBytes,
    validateState: value => validateMetadata(value, limits) });

  // Only fixed codes and counters enter logs; peer-controlled IDs and exception
  // messages are deliberately omitted. Deployment limits the sink's total size.
  function log(event, code) {
    try { logger(Object.freeze({ event, ...(code ? { code } : {}) })); } catch {}
  }
  function reindex() {
    state = store.snapshot();
    deviceMap = new Map(state.devices.map(device => [device.deviceId, device]));
    paired = new Set(state.pairs.map(pair => pairKey(pair.deviceA, pair.deviceB)));
    routeMap = new Map(state.routes.map(route => [routeKey(route.hostDeviceId, route.remoteSessionId), route]));
  }
  function transact(update) {
    const operation = mutation.then(async () => {
      const result = await store.transaction(update);
      reindex();
      return result;
    });
    mutation = operation.catch(() => {});
    return operation;
  }
  await store.load();
  reindex();
  // Configuration seeds an empty store only. Reopening cannot silently restore a
  // device or pair that the owner revoked in durable metadata.
  if (!state.devices.length && devices.length) {
    await transact(next => {
      const ids = new Set();
      const tokenHashes = new Set();
      next.devices = devices.map(device => {
        exact(device, ['deviceId', 'token'], ['publicKey']);
        id(device.deviceId);
        const digest = tokenHash(device.token);
        if (ids.has(device.deviceId) || tokenHashes.has(digest)) fail('invalid_configuration');
        ids.add(device.deviceId); tokenHashes.add(digest);
        return { deviceId: device.deviceId, tokenHash: digest, revoked: false,
          ...(device.publicKey !== undefined ? { publicKey: device.publicKey } : {}) };
      });
      next.pairs = pairs.map(pair => {
        const [deviceA, deviceB] = Array.isArray(pair) ? pair : [pair.deviceA, pair.deviceB];
        return { deviceA, deviceB };
      });
    });
  }

  function inspect(envelope) {
    let header;
    try { header = inspectEnvelope(envelope, { now: now(), maxBytes: limits.maxFrameBytes }); }
    catch { fail('invalid_envelope'); }
    if (!header || typeof header.then === 'function') fail('invalid_envelope');
    for (const key of ['messageId', 'fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId']) id(header[key]);
    integer(header.grantVersion, 1); integer(header.issuedAt); integer(header.expiresAt, 1);
    if (!Object.hasOwn(KINDS, header.kind)) fail('invalid_envelope');
    if (header.fromDeviceId === header.toDeviceId || header.expiresAt <= header.issuedAt) fail('invalid_envelope');
    if (header.expiresAt <= now()) fail('expired');
    if (header.issuedAt > now() + 5000) fail('not_yet_valid');
    const ttl = header.kind === 'invite' ? limits.maxInviteTtlMs
      : header.kind === 'reminder' ? limits.maxReminderTtlMs : limits.maxControlTtlMs;
    if (header.expiresAt - header.issuedAt > ttl) fail('ttl_exceeded');
    return header;
  }
  // Loaded ciphertext is checked with the exact same shared parser. Expired items
  // are discarded rather than causing a legitimate restart to fail closed.
  await transact(next => {
    next.pending = next.pending.filter(pending => {
      if (pending.expiresAt <= now()) return false;
      let frame;
      try { frame = JSON.parse(pending.wire); }
      catch { fail('invalid_state'); }
      exact(frame, ['v', 'op', 'envelope']);
      if (frame.v !== 1 || frame.op !== 'envelope') fail('invalid_state');
      const header = inspect(frame.envelope);
      if (header.fromDeviceId !== pending.fromDeviceId || header.toDeviceId !== pending.toDeviceId ||
          header.messageId !== pending.messageId || header.kind !== pending.kind || header.expiresAt !== pending.expiresAt) {
        fail('invalid_state');
      }
      return true;
    });
    next.routes = next.routes.filter(route => route.expiresAt > now());
  });

  function sendSystem(connection, frame) {
    if (!connection || connection.ws.readyState !== 1 || connection.closed) return false;
    const result = connection.outbox.enqueue({ data: JSON.stringify(frame), priority: 0,
      expiresAt: now() + limits.maxControlTtlMs, metadata: null });
    if (!result.ok) {
      connection.ws.close(1013, 'backpressure');
      return false;
    }
    return true;
  }
  function notifyStatus(connection, messageId, status, code) {
    sendSystem(connection, statusWire(messageId, status, code));
  }
  function activeDevice(deviceId) {
    return deviceMap.has(deviceId) && !deviceMap.get(deviceId).revoked && !blockedDevices.has(deviceId);
  }
  function checkPair(from, to) {
    if (!activeDevice(from) || !activeDevice(to)) fail('device_revoked');
    if (!paired.has(pairKey(from, to)) || blockedPairs.has(pairKey(from, to))) fail('unpaired');
  }
  function findRoute(header) {
    return [...routeMap.values()].find(route => route.remoteSessionId === header.remoteSessionId &&
      [route.hostDeviceId, route.phoneDeviceId].includes(header.fromDeviceId) &&
      [route.hostDeviceId, route.phoneDeviceId].includes(header.toDeviceId));
  }
  function assertRoute(header) {
    const route = findRoute(header);
    if (!route) fail('route_inactive');
    if (route.expiresAt <= now()) fail('route_expired');
    if (route.hostInstanceId !== header.hostInstanceId || route.grantVersion !== header.grantVersion) fail('route_mismatch');
    const key = routeKey(route.hostDeviceId, route.remoteSessionId);
    const host = connections.get(route.hostDeviceId);
    if (!host || activeRoutes.get(key) !== host.nonce) fail('route_inactive');
    return route;
  }
  function suspendRoutes(deviceId) {
    const affected = new Set();
    for (const [key, route] of routeMap) {
      if (route.hostDeviceId === deviceId || route.phoneDeviceId === deviceId) {
        activeRoutes.delete(key);
        affected.add(key);
      }
    }
    for (const connection of connections.values()) connection.outbox.cancel(meta => meta && affected.has(meta.routeKey), 'route_inactive');
  }
  function onForwardResult(connection, metadata, code) {
    if (!metadata) return;
    if (metadata.pendingKey) {
      pendingDelivery.delete(metadata.pendingKey);
      if (code === 'forwarded') pendingDeliveredToConnection.add(`${connection.nonce}|${metadata.pendingKey}`);
    }
    if (code === 'forwarded') {
      metrics.forwarded++;
      notifyStatus(metadata.sender, metadata.messageId, 'forwarded');
    } else {
      metrics.rejected++;
      notifyStatus(metadata.sender, metadata.messageId, 'rejected', SAFE_CODES.has(code) ? code : 'internal_error');
    }
    log(code === 'forwarded' ? 'frame_forwarded' : 'frame_rejected', code === 'forwarded' ? undefined : code);
  }
  function enqueue(connection, wire, header, sender, pendingKey) {
    let binding;
    if (!DURABLE.has(header.kind)) {
      const route = assertRoute(header);
      binding = routeKey(route.hostDeviceId, route.remoteSessionId);
    }
    return connection.outbox.enqueue({ data: wire, priority: KINDS[header.kind], expiresAt: header.expiresAt,
      metadata: { sender, messageId: header.messageId, routeKey: binding, pendingKey,
        fromDeviceId: header.fromDeviceId, toDeviceId: header.toDeviceId } });
  }

  async function replayPending(connection) {
    for (const pending of state.pending) {
      if (pending.toDeviceId !== connection.deviceId || pending.expiresAt <= now()) continue;
      const key = `${pending.fromDeviceId}|${pending.messageId}`;
      if (pendingDelivery.has(key) || pendingDeliveredToConnection.has(`${connection.nonce}|${key}`)) continue;
      try {
        checkPair(pending.fromDeviceId, pending.toDeviceId);
        const { envelope } = JSON.parse(pending.wire);
        const header = inspect(envelope);
        const result = enqueue(connection, pending.wire, header, null, key);
        if (!result.ok) break;
        pendingDelivery.add(key);
      } catch { /* A revoked pairing is purged below, never forwarded. */ }
    }
  }
  async function storePending(wire, header) {
    const key = `${header.fromDeviceId}|${header.messageId}`;
    return transact(next => {
      next.pending = next.pending.filter(item => item.expiresAt > now());
      const previous = next.pending.find(item => item.fromDeviceId === header.fromDeviceId && item.messageId === header.messageId);
      if (previous) {
        if (previous.wire !== wire) fail('duplicate_conflict');
        return key;
      }
      const bytes = Buffer.byteLength(wire);
      const forDevice = next.pending.filter(item => item.toDeviceId === header.toDeviceId);
      if (next.pending.length >= limits.maxPendingItems || forDevice.length >= limits.maxPendingPerDevice ||
          next.pending.reduce((sum, item) => sum + Buffer.byteLength(item.wire), bytes) > limits.maxPendingBytes ||
          forDevice.reduce((sum, item) => sum + Buffer.byteLength(item.wire), bytes) > limits.maxPendingPerDeviceBytes) {
        fail('pending_full');
      }
      next.pending.push({ fromDeviceId: header.fromDeviceId, toDeviceId: header.toDeviceId,
        messageId: header.messageId, kind: header.kind, expiresAt: header.expiresAt, wire });
      return key;
    });
  }
  async function forward(connection, frame) {
    exact(frame, ['v', 'op', 'envelope']);
    const header = inspect(frame.envelope);
    if (header.fromDeviceId !== connection.deviceId) fail('forbidden');
    connection.currentMessageId = header.messageId;
    checkPair(header.fromDeviceId, header.toDeviceId);
    const wire = JSON.stringify({ v: 1, op: 'envelope', envelope: frame.envelope });
    if (Buffer.byteLength(wire) > limits.maxFrameBytes) fail('frame_too_large');
    const recipient = connections.get(header.toDeviceId);
    if (DURABLE.has(header.kind)) {
      // The receiver removes ciphertext with relay.ack; a TCP write is not an
      // application receipt, and neither is a durable "stored" status.
      const key = await storePending(wire, header);
      metrics.stored++;
      notifyStatus(connection, header.messageId, 'stored');
      if (recipient && !pendingDelivery.has(key) && !pendingDeliveredToConnection.has(`${recipient.nonce}|${key}`)) {
        checkPair(header.fromDeviceId, header.toDeviceId);
        const result = enqueue(recipient, wire, header, connection, key);
        if (result.ok) pendingDelivery.add(key);
      }
    } else {
      assertRoute(header);
      if (!recipient || recipient.closed || recipient.ws.readyState !== 1) fail('peer_offline');
      const result = enqueue(recipient, wire, header, connection);
      if (!result.ok) fail(result.code);
    }
    metrics.accepted++;
  }
  async function activate(connection, frame) {
    exact(frame, ['v', 'op', 'route']);
    const route = routeBinding(frame.route);
    if (connection.deviceId !== route.hostDeviceId) fail('forbidden');
    checkPair(route.hostDeviceId, route.phoneDeviceId);
    if (route.expiresAt <= now() || route.expiresAt - now() > limits.maxRouteTtlMs) fail('route_expired');
    const key = routeKey(route.hostDeviceId, route.remoteSessionId);
    const previous = routeMap.get(key);
    if (previous && (previous.grantVersion > route.grantVersion || previous.grantVersion === route.grantVersion && !sameRoute(previous, route))) {
      fail('stale_grant');
    }
    await transact(next => {
      const old = next.routes.findIndex(item => routeKey(item.hostDeviceId, item.remoteSessionId) === key);
      if (old >= 0) next.routes.splice(old, 1);
      if (next.routes.length >= limits.maxRoutes) fail('backpressure');
      next.routes.push(structuredClone(route));
    });
    // Host connection may have disappeared while fsync was in progress.
    if (connections.get(connection.deviceId) !== connection || connection.closed) fail('peer_offline');
    checkPair(route.hostDeviceId, route.phoneDeviceId);
    activeRoutes.set(key, connection.nonce);
    sendSystem(connection, { v: 1, op: 'route.status', remoteSessionId: route.remoteSessionId, status: 'active' });
    sendSystem(connections.get(route.phoneDeviceId), { v: 1, op: 'route.status', remoteSessionId: route.remoteSessionId,
      status: 'resync_required' });
  }
  async function revokeRoute(connection, frame) {
    exact(frame, ['v', 'op', 'remoteSessionId', 'grantVersion']);
    id(frame.remoteSessionId); integer(frame.grantVersion, 1);
    const key = routeKey(connection.deviceId, frame.remoteSessionId);
    const route = routeMap.get(key);
    if (!route || route.hostDeviceId !== connection.deviceId || route.grantVersion !== frame.grantVersion) fail('route_mismatch');
    activeRoutes.delete(key);
    for (const peer of connections.values()) peer.outbox.cancel(meta => meta?.routeKey === key, 'route_inactive');
    await transact(next => {
      next.routes = next.routes.filter(item => routeKey(item.hostDeviceId, item.remoteSessionId) !== key);
      next.pending = next.pending.filter(item => {
        if (item.expiresAt <= now()) return false;
        const header = inspect(JSON.parse(item.wire).envelope);
        return !(header.remoteSessionId === route.remoteSessionId && header.hostInstanceId === route.hostInstanceId);
      });
    });
    sendSystem(connection, { v: 1, op: 'route.status', remoteSessionId: route.remoteSessionId, status: 'inactive' });
    sendSystem(connections.get(route.phoneDeviceId), { v: 1, op: 'route.status', remoteSessionId: route.remoteSessionId, status: 'inactive' });
  }
  async function acknowledge(connection, frame) {
    exact(frame, ['v', 'op', 'fromDeviceId', 'messageId']);
    id(frame.fromDeviceId); id(frame.messageId);
    checkPair(connection.deviceId, frame.fromDeviceId);
    await transact(next => {
      next.pending = next.pending.filter(item => !(item.toDeviceId === connection.deviceId &&
        item.fromDeviceId === frame.fromDeviceId && item.messageId === frame.messageId));
    });
    sendSystem(connection, { v: 1, op: 'relay.acked', fromDeviceId: frame.fromDeviceId, messageId: frame.messageId });
  }
  async function process(connection, data, binary) {
    connection.currentMessageId = null;
    if (binary) fail('invalid_frame');
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); }
    catch { fail('invalid_frame'); }
    if (frame?.v !== RELAY_VERSION) fail('unsupported_version');
    if (frame.op === 'send') return forward(connection, frame);
    if (frame.op === 'route.activate') return activate(connection, frame);
    if (frame.op === 'route.revoke') return revokeRoute(connection, frame);
    if (frame.op === 'relay.ack') return acknowledge(connection, frame);
    if (frame.op === 'ping') {
      exact(frame, ['v', 'op']);
      return sendSystem(connection, { v: 1, op: 'pong' });
    }
    fail('unsupported_op');
  }
  function disconnect(connection) {
    if (connection.closed) return;
    connection.closed = true;
    for (const key of pendingDeliveredToConnection) if (key.startsWith(`${connection.nonce}|`)) pendingDeliveredToConnection.delete(key);
    connection.outbox.close();
    if (connections.get(connection.deviceId) === connection) {
      connections.delete(connection.deviceId);
      suspendRoutes(connection.deviceId);
      for (const peer of connections.values()) {
        if (paired.has(pairKey(connection.deviceId, peer.deviceId))) {
          sendSystem(peer, { v: 1, op: 'peer.status', deviceId: connection.deviceId, status: 'offline' });
        }
      }
    }
    log('device_disconnected');
  }

  const httpHandler = (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(stopped ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: !stopped, version: 1 }));
    } else { response.writeHead(404); response.end(); }
  };
  const server = tls ? createHttpsServer(tls, httpHandler) : createHttpServer(httpHandler);
  server.headersTimeout = limits.authTimeoutMs;
  server.requestTimeout = limits.authTimeoutMs;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 5000;
  server.maxConnections = limits.maxDevices * 4;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes,
    perMessageDeflate: false, clientTracking: true, allowSynchronousEvents: false });
  function rejectUpgrade(socket, code, httpStatus = 401) {
    metrics.authRejected++;
    log('upgrade_rejected', code);
    socket.end(`HTTP/1.1 ${httpStatus} ${httpStatus === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    if (stopped || !upgradeBucket.take()) return rejectUpgrade(socket, 'rate_limited', 429);
    if (request.method !== 'GET' || request.url !== '/v1/relay' ||
        request.headers.origin && !origins.has(request.headers.origin)) return rejectUpgrade(socket, 'forbidden');
    let deviceId;
    let digest;
    try {
      deviceId = id(request.headers['x-relay-device-id']);
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) fail('unauthorized');
      digest = tokenHash(authorization.slice(7));
    } catch { return rejectUpgrade(socket, 'unauthorized'); }
    const device = deviceMap.get(deviceId);
    const expected = device?.tokenHash || '0'.repeat(64);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest, 'hex')) || !device || !activeDevice(deviceId)) {
      return rejectUpgrade(socket, 'unauthorized');
    }
    // No request headers (including Authorization) are retained or logged.
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, deviceId));
  });
  wss.on('connection', (ws, deviceId) => {
    const previous = connections.get(deviceId);
    if (previous) { disconnect(previous); previous.ws.close(4001, 'replaced'); }
    const connection = { deviceId, ws, nonce: randomUUID(), alive: true, closed: false, bufferedInputBytes: 0,
      bufferedInputItems: 0, inputChain: Promise.resolve(), currentMessageId: null, slowSince: null,
      bytes: new TokenBucket({ rate: limits.inboundBytesPerSecond, burst: limits.inboundBurstBytes, now }),
      messages: new TokenBucket({ rate: limits.messagesPerSecond, burst: limits.messageBurst, now }) };
    connection.outbox = outboxFactory({ socket: ws, maxBytes: limits.maxQueuedBytes, maxItems: limits.maxQueuedItems,
      highReserveBytes: limits.highReserveBytes, highReserveItems: limits.highReserveItems,
      maxSocketBytes: limits.maxSocketBytes, sendBytesPerSecond: limits.outboundBytesPerSecond,
      burstBytes: limits.outboundBurstBytes, now,
      onResult: (metadata, code) => onForwardResult(connection, metadata, code) });
    connections.set(deviceId, connection);
    ws.on('pong', () => { connection.alive = true; });
    ws.on('error', () => { log('socket_error'); disconnect(connection); });
    ws.on('close', () => disconnect(connection));
    ws.on('message', (data, binary) => {
      const bytes = data.length;
      if (bytes > limits.maxFrameBytes || !connection.bytes.take(bytes) || !connection.messages.take()) {
        metrics.rejected++;
        log('frame_rejected', 'rate_limited');
        ws.close(1008, 'rate_limited');
        return;
      }
      // Also bound the receive-side async fsync backlog, not just outgoing TCP.
      if (connection.bufferedInputBytes + bytes > limits.maxQueuedBytes || connection.bufferedInputItems >= limits.maxQueuedItems) {
        ws.close(1013, 'backpressure');
        return;
      }
      connection.bufferedInputBytes += bytes; connection.bufferedInputItems++;
      connection.inputChain = connection.inputChain.then(async () => {
        if (connection.closed || stopped) return;
        try { await process(connection, data, binary); }
        catch (error) {
          metrics.rejected++;
          const code = safeCode(error);
          if (connection.currentMessageId) notifyStatus(connection, connection.currentMessageId, 'rejected', code);
          else sendSystem(connection, { v: 1, op: 'error', code });
          log('frame_rejected', code);
        }
      }).finally(() => { connection.bufferedInputBytes -= bytes; connection.bufferedInputItems--; });
    });
    sendSystem(connection, { v: 1, op: 'relay.ready', deviceId, relayInstanceId: bootId,
      maxFrameBytes: limits.maxFrameBytes, resyncRequired: true });
    for (const peer of connections.values()) {
      if (peer !== connection && paired.has(pairKey(peer.deviceId, deviceId))) {
        sendSystem(peer, { v: 1, op: 'peer.status', deviceId, status: 'online' });
        sendSystem(connection, { v: 1, op: 'peer.status', deviceId: peer.deviceId, status: 'online' });
      }
    }
    replayPending(connection).catch(() => log('pending_replay_failed', 'internal_error'));
    log('device_connected');
  });

  async function sweep() {
    if (stopped) return;
    for (const [key, route] of routeMap) if (route.expiresAt <= now()) {
      activeRoutes.delete(key);
      for (const connection of connections.values()) connection.outbox.cancel(meta => meta?.routeKey === key, 'route_expired');
    }
    for (const connection of connections.values()) {
      if (connection.ws.bufferedAmount > limits.maxSocketBytes || connection.outbox.stats().queuedItems > 0) {
        connection.slowSince ??= now();
        if (now() - connection.slowSince > limits.slowPeerMs) connection.ws.close(1013, 'slow_peer');
      } else connection.slowSince = null;
    }
    const pendingKeys = new Set(state.pending.filter(item => item.expiresAt > now()).map(item => `${item.fromDeviceId}|${item.messageId}`));
    for (const connection of connections.values()) {
      for (const delivered of pendingDeliveredToConnection) {
        if (delivered.startsWith(`${connection.nonce}|`) && !pendingKeys.has(delivered.slice(connection.nonce.length + 1))) {
          pendingDeliveredToConnection.delete(delivered);
        }
      }
    }
    if (state.pending.some(item => item.expiresAt <= now()) || state.routes.some(route => route.expiresAt <= now())) {
      await transact(next => {
        const before = next.pending.length;
        next.pending = next.pending.filter(item => item.expiresAt > now());
        next.routes = next.routes.filter(route => route.expiresAt > now());
        metrics.expired += before - next.pending.length;
      });
    }
  }
  let sweeping = false;
  const sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep().catch(() => log('sweep_failed', 'internal_error')).finally(() => { sweeping = false; });
  }, limits.sweepMs);
  sweepTimer.unref();
  const heartbeatTimer = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      connection.ws.ping();
    }
  }, limits.heartbeatMs);
  heartbeatTimer.unref();
  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return Object.freeze({
    httpServer: server,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (!tls && !LOOPBACK.has(host)) fail('tls_required');
      if (stopped || server.listening) fail('invalid_state');
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off('error', onError); resolve(); };
        const onError = error => { server.off('listening', onListening); reject(error); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port, host });
      });
      return server.address();
    },
    address() { return server.address(); },
    stats() {
      return { ...metrics, connectedDevices: connections.size, activeRoutes: activeRoutes.size,
        pendingItems: state.pending.length, pendingBytes: state.pending.reduce((sum, item) => sum + Buffer.byteLength(item.wire), 0),
        queuedBytes: [...connections.values()].reduce((sum, item) => sum + item.outbox.stats().queuedBytes, 0),
        queuedItems: [...connections.values()].reduce((sum, item) => sum + item.outbox.stats().queuedItems, 0) };
    },
    // Trusted in-process configuration boundary, never HTTP administration APIs.
    async registerDevice({ deviceId, token, publicKey }) {
      id(deviceId); const digest = tokenHash(token);
      await transact(next => {
        if (next.devices.some(device => device.deviceId === deviceId || device.tokenHash === digest)) fail('duplicate_conflict');
        if (next.devices.length >= limits.maxDevices) fail('backpressure');
        next.devices.push({ deviceId, tokenHash: digest, revoked: false, ...(publicKey !== undefined ? { publicKey } : {}) });
      });
    },
    async pairDevices(deviceA, deviceB) {
      id(deviceA); id(deviceB);
      if (!activeDevice(deviceA) || !activeDevice(deviceB) || deviceA === deviceB) fail('forbidden');
      await transact(next => {
        if (next.pairs.some(pair => pairKey(pair.deviceA, pair.deviceB) === pairKey(deviceA, deviceB))) return;
        if (next.pairs.length >= limits.maxPairs) fail('backpressure');
        next.pairs.push({ deviceA, deviceB });
      });
      blockedPairs.delete(pairKey(deviceA, deviceB));
    },
    async revokePair(deviceA, deviceB) {
      const key = pairKey(id(deviceA), id(deviceB));
      blockedPairs.add(key);
      paired.delete(key);
      suspendRoutes(deviceA);
      for (const peer of connections.values()) peer.outbox.cancel(meta => meta && pairKey(meta.fromDeviceId, meta.toDeviceId) === key, 'unpaired');
      await transact(next => {
        next.pairs = next.pairs.filter(pair => pairKey(pair.deviceA, pair.deviceB) !== key);
        next.routes = next.routes.filter(route => pairKey(route.hostDeviceId, route.phoneDeviceId) !== key);
        next.pending = next.pending.filter(item => pairKey(item.fromDeviceId, item.toDeviceId) !== key);
      });
    },
    async revokeDevice(deviceId) {
      id(deviceId);
      const device = deviceMap.get(deviceId);
      if (!device) fail('forbidden');
      blockedDevices.add(deviceId);
      device.revoked = true;
      const peer = connections.get(deviceId);
      if (peer) { disconnect(peer); peer.ws.close(4003, 'device_revoked'); }
      suspendRoutes(deviceId);
      await transact(next => {
        next.devices.find(item => item.deviceId === deviceId).revoked = true;
        next.pairs = next.pairs.filter(pair => pair.deviceA !== deviceId && pair.deviceB !== deviceId);
        next.routes = next.routes.filter(route => route.hostDeviceId !== deviceId && route.phoneDeviceId !== deviceId);
        next.pending = next.pending.filter(item => item.fromDeviceId !== deviceId && item.toDeviceId !== deviceId);
      });
    },
    sweep,
    async flush() { await mutation; await store.flush(); },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(sweepTimer); clearInterval(heartbeatTimer);
      const closing = [...connections.values()];
      for (const connection of closing) { disconnect(connection); connection.ws.terminate(); }
      await Promise.all(closing.map(connection => connection.inputChain));
      await mutation;
      await store.close();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      activeRoutes.clear();
      log('relay_stopped');
    },
  });
}

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID, randomBytes, timingSafeEqual, createHash, createPublicKey, verify } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MetadataStore } from './store.mjs';
import { TokenBucket, PriorityOutbox } from './flow.mjs';
import { fail, exact, id, integer, tokenHash, pairKey } from './validation.mjs';

export const TUNNEL_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxChunkBytes: 32 * 1024,
  maxDevices: 8,
  maxPairs: 16,
  maxPairingAttempts: 16,
  maxTunnels: 16,
  maxTunnelsPerDevice: 8,
  maxOffers: 8,
  maxHints: 128,
  maxHintsPerDevice: 64,
  maxMetadataBytes: 1024 * 1024,
  authTimeoutMs: 5000,
  maxUnauthenticated: 8,
  maxOfferTtlMs: 300000,
  maxHintTtlMs: 300000,
  maxQueuedBytes: 512 * 1024,
  maxQueuedItems: 128,
  highReserveBytes: 128 * 1024,
  highReserveItems: 16,
  maxSocketBytes: 64 * 1024,
  bytesPerSecond: 256 * 1024,
  burstBytes: 128 * 1024,
  messagesPerSecond: 60,
  messageBurst: 120,
  outboundBytesPerSecond: 256 * 1024,
  outboundBurstBytes: 64 * 1024,
  upgradesPerSecond: 2,
  upgradeBurst: 12,
  handshakeTimeoutMs: 10000,
  maxTunnelAgeMs: 3600000,
  slowPeerMs: 15000,
  heartbeatMs: 30000,
  sweepMs: 1000,
});
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const ERROR_CODES = new Set(['invalid_frame', 'invalid_id', 'unsupported_version', 'unsupported_op', 'unauthorized',
  'auth_required', 'auth_timeout', 'forbidden', 'unpaired', 'peer_offline', 'offer_missing', 'offer_expired',
  'tunnel_missing', 'tunnel_conflict', 'tunnel_limit', 'frame_too_large', 'expired', 'rate_limited',
  'backpressure', 'hint_limit', 'duplicate_conflict', 'internal_error']);
const safeCode = error => ERROR_CODES.has(error?.code) ? error.code : 'internal_error';
function checkedLimits(overrides = {}) {
  const limits = { ...TUNNEL_LIMITS, ...overrides };
  if (Object.keys(overrides).some(key => !Object.hasOwn(TUNNEL_LIMITS, key)) ||
      Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1) ||
      limits.maxFrameBytes > 64 * 1024 || limits.maxChunkBytes > 32 * 1024 ||
      limits.maxSocketBytes < limits.maxFrameBytes || limits.outboundBurstBytes < limits.maxFrameBytes ||
      limits.highReserveBytes >= limits.maxQueuedBytes || limits.highReserveItems >= limits.maxQueuedItems) fail('invalid_limits');
  return Object.freeze(limits);
}
function validateState(state, limits) {
  exact(state, ['version', 'devices', 'pairs', 'hints']);
  if (state.version !== 2 || !Array.isArray(state.devices) || state.devices.length > limits.maxDevices ||
      !Array.isArray(state.pairs) || state.pairs.length > limits.maxPairs ||
      !Array.isArray(state.hints) || state.hints.length > limits.maxHints) fail('invalid_state');
  const devices = new Set();
  const tokenHashes = new Set();
  for (const device of state.devices) {
    exact(device, ['deviceId', 'tokenHash', 'revoked'], ['publicKey']);
    id(device.deviceId);
    if (devices.has(device.deviceId) || !/^[0-9a-f]{64}$/.test(device.tokenHash) || tokenHashes.has(device.tokenHash) ||
        typeof device.revoked !== 'boolean' || device.publicKey !== undefined && (typeof device.publicKey !== 'string' || device.publicKey.length > 4096)) {
      fail('invalid_state');
    }
    devices.add(device.deviceId); tokenHashes.add(device.tokenHash);
  }
  const pairs = new Set();
  for (const pair of state.pairs) {
    exact(pair, ['deviceA', 'deviceB']);
    if (!devices.has(pair.deviceA) || !devices.has(pair.deviceB) || pair.deviceA === pair.deviceB ||
        pairs.has(pairKey(pair.deviceA, pair.deviceB))) fail('invalid_state');
    pairs.add(pairKey(pair.deviceA, pair.deviceB));
  }
  const hints = new Set();
  const counts = new Map();
  for (const hint of state.hints) {
    exact(hint, ['hintId', 'fromDeviceId', 'toDeviceId', 'kind', 'expiresAt']);
    id(hint.hintId); id(hint.fromDeviceId); id(hint.toDeviceId); integer(hint.expiresAt, 1);
    if (!devices.has(hint.fromDeviceId) || !devices.has(hint.toDeviceId) || hint.fromDeviceId === hint.toDeviceId ||
        !['invite', 'reminder'].includes(hint.kind) || hints.has(`${hint.fromDeviceId}|${hint.hintId}`) ||
        !pairs.has(pairKey(hint.fromDeviceId, hint.toDeviceId))) fail('invalid_state');
    hints.add(`${hint.fromDeviceId}|${hint.hintId}`);
    counts.set(hint.toDeviceId, (counts.get(hint.toDeviceId) || 0) + 1);
    if (counts.get(hint.toDeviceId) > limits.maxHintsPerDevice) fail('invalid_state');
  }
}

/** Authenticated single-user router for opaque TLS1.3 byte streams.
 * It never terminates the inner TLS connection or stores a TLS record. */
export async function createTunnelRelayServer({ devices = [], pairs = [], stateFile = null,
  bootstrapToken, limits: overrides, now = Date.now, logger = () => {}, tls = null,
  allowedOrigins = [], outboxFactory = options => new PriorityOutbox(options) } = {}) {
  const limits = checkedLimits(overrides);
  if (!Array.isArray(devices) || !Array.isArray(pairs) || devices.length > limits.maxDevices || pairs.length > limits.maxPairs) {
    fail('invalid_configuration');
  }
  const bootstrapHash = bootstrapToken === undefined ? null : tokenHash(bootstrapToken);
  const store = new MetadataStore({ stateFile, now, maxStateBytes: limits.maxMetadataBytes,
    initialState: { version: 2, devices: [], pairs: [], hints: [] },
    validateState: value => validateState(value, limits) });
  const bootId = randomUUID();
  const connections = new Map();
  const unauthenticated = new Set();
  const offers = new Map();
  const tunnels = new Map();
  const pairingAttempts = new Map();
  const blockedDevices = new Set();
  const blockedPairs = new Set();
  const origins = new Set(allowedOrigins);
  const upgradeBucket = new TokenBucket({ rate: limits.upgradesPerSecond, burst: limits.upgradeBurst, now });
  const metrics = { authenticated: 0, authRejected: 0, forwardedChunks: 0, forwardedBytes: 0,
    rejected: 0, storedHints: 0, expiredHints: 0, closedTunnels: 0 };
  let stopped = false;
  let stopping;
  let mutation = Promise.resolve();
  let state, deviceMap, paired;
  function log(event, code) { try { logger(Object.freeze({ event, ...(code ? { code } : {}) })); } catch {} }
  function reindex() {
    state = store.snapshot();
    deviceMap = new Map(state.devices.map(device => [device.deviceId, device]));
    paired = new Set(state.pairs.map(pair => pairKey(pair.deviceA, pair.deviceB)));
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
  await store.load(); reindex();
  if (!state.devices.length && devices.length) {
    await transact(next => {
      next.devices = devices.map(device => {
        exact(device, ['deviceId', 'token'], ['publicKey']);
        id(device.deviceId);
        return { deviceId: device.deviceId, tokenHash: tokenHash(device.token), revoked: false,
          ...(device.publicKey !== undefined ? { publicKey: device.publicKey } : {}) };
      });
      next.pairs = pairs.map(pair => Array.isArray(pair) ? { deviceA: pair[0], deviceB: pair[1] } : pair);
    });
  }
  if (state.hints.some(hint => hint.expiresAt <= now())) {
    await transact(next => { next.hints = next.hints.filter(hint => hint.expiresAt > now()); });
  }
  const activeDevice = deviceId => deviceMap.has(deviceId) && !deviceMap.get(deviceId).revoked && !blockedDevices.has(deviceId);
  const isPaired = (a, b) => activeDevice(a) && activeDevice(b) && paired.has(pairKey(a, b)) && !blockedPairs.has(pairKey(a, b));
  function send(connection, frame, { priority = 0, tunnelId, expiresAt = now() + limits.maxOfferTtlMs } = {}) {
    if (!connection || connection.closed || connection.ws.readyState !== 1) return false;
    const wire = JSON.stringify(frame);
    if (Buffer.byteLength(wire) > limits.maxFrameBytes) return false;
    const result = connection.outbox.enqueue({ data: wire, priority, expiresAt,
      metadata: tunnelId ? { tunnelId } : null });
    if (!result.ok) return false;
    return true;
  }
  function error(connection, code) {
    metrics.rejected++;
    log('frame_rejected', code);
    if (!send(connection, { v: 1, op: 'error', code })) connection.ws.close(1013, 'backpressure');
  }
  function closeTunnel(tunnelId, code = 'tunnel_closed') {
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return;
    tunnels.delete(tunnelId);
    metrics.closedTunnels++;
    for (const deviceId of [tunnel.fromDeviceId, tunnel.toDeviceId]) {
      const connection = connections.get(deviceId);
      connection?.outbox.cancel(metadata => metadata?.tunnelId === tunnelId, code);
      if (connection && !send(connection, { v: 1, op: 'tunnel.closed', tunnelId, code })) connection.ws.close(1013, 'backpressure');
    }
    if (tunnel.purpose === 'pairing') {
      const key = pairKey(tunnel.fromDeviceId, tunnel.toDeviceId);
      const attempt = pairingAttempts.get(key);
      // Double-confirm can finish over the still-live tunnel. If it drops before
      // both confirms, discard the attempt; a reconnect must run new inner TLS.
      if (attempt?.tunnelId === tunnelId && !isPaired(tunnel.fromDeviceId, tunnel.toDeviceId)) pairingAttempts.delete(key);
    }
    log('tunnel_closed');
  }
  function closeRelated(predicate, code) {
    for (const [tunnelId, tunnel] of [...tunnels]) if (predicate(tunnel)) closeTunnel(tunnelId, code);
  }
  function disconnect(connection) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.authTimer);
    unauthenticated.delete(connection);
    if (connections.get(connection.deviceId) === connection) {
      connections.delete(connection.deviceId);
      for (const [offerId, offer] of offers) if (offer.deviceId === connection.deviceId) offers.delete(offerId);
      closeRelated(tunnel => tunnel.fromDeviceId === connection.deviceId || tunnel.toDeviceId === connection.deviceId, 'peer_offline');
      for (const [key, attempt] of pairingAttempts) if (attempt.deviceA === connection.deviceId || attempt.deviceB === connection.deviceId) pairingAttempts.delete(key);
      for (const peer of connections.values()) if (isPaired(peer.deviceId, connection.deviceId)) {
        send(peer, { v: 1, op: 'peer.status', deviceId: connection.deviceId, status: 'offline' });
      }
    }
    connection.outbox.close();
    log('device_disconnected');
  }

  async function authenticate(connection, frame) {
    exact(frame, ['v', 'op', 'deviceId', 'token']);
    if (frame.op !== 'auth') fail('auth_required');
    const deviceId = id(frame.deviceId);
    let digest;
    try { digest = tokenHash(frame.token); } catch { fail('unauthorized'); }
    const device = deviceMap.get(deviceId);
    if (!timingSafeEqual(Buffer.from(device?.tokenHash || '0'.repeat(64), 'hex'), Buffer.from(digest, 'hex')) || !activeDevice(deviceId)) {
      metrics.authRejected++;
      fail('unauthorized');
    }
    if (connection.closed || stopped) return;
    // Consumed token only exists in the inbound buffer; no request/body logging.
    connection.deviceId = deviceId;
    clearTimeout(connection.authTimer);
    unauthenticated.delete(connection);
    const previous = connections.get(deviceId);
    if (previous) { disconnect(previous); previous.ws.close(4001, 'replaced'); }
    connections.set(deviceId, connection);
    metrics.authenticated++;
    send(connection, { v: 1, op: 'auth.ok', deviceId, relayInstanceId: bootId, resyncRequired: true,
      maxFrameBytes: limits.maxFrameBytes, maxChunkBytes: limits.maxChunkBytes });
    for (const peer of connections.values()) if (peer !== connection && isPaired(peer.deviceId, deviceId)) {
      send(peer, { v: 1, op: 'peer.status', deviceId, status: 'online' });
      send(connection, { v: 1, op: 'peer.status', deviceId: peer.deviceId, status: 'online' });
    }
    for (const hint of state.hints) if (hint.toDeviceId === deviceId && hint.expiresAt > now() && isPaired(hint.fromDeviceId, hint.toDeviceId)) {
      if (!send(connection, { v: 1, op: 'wake.hint', ...hint })) break;
    }
    log('device_authenticated');
  }
  function openTunnel(connection, frame) {
    exact(frame, ['v', 'op', 'tunnelId', 'toDeviceId', 'purpose'], ['offerId']);
    id(frame.tunnelId); id(frame.toDeviceId);
    if (!['pairing', 'peer'].includes(frame.purpose) || frame.toDeviceId === connection.deviceId) fail('invalid_frame');
    if (tunnels.has(frame.tunnelId)) fail('tunnel_conflict');
    const peer = connections.get(frame.toDeviceId);
    if (!peer || peer.closed || !activeDevice(frame.toDeviceId)) fail('peer_offline');
    let expiry = now() + limits.maxTunnelAgeMs;
    if (frame.purpose === 'peer') {
      if (frame.offerId !== undefined) fail('invalid_frame');
      if (!isPaired(connection.deviceId, frame.toDeviceId)) fail('unpaired');
    } else {
      id(frame.offerId);
      const offer = offers.get(frame.offerId);
      if (!offer || offer.deviceId !== frame.toDeviceId || offer.connectionNonce !== peer.nonce) fail('offer_missing');
      if (offer.expiresAt <= now()) fail('offer_expired');
      const key = pairKey(connection.deviceId, frame.toDeviceId);
      if (pairingAttempts.has(key)) fail('tunnel_conflict');
      if (pairingAttempts.size >= limits.maxPairingAttempts) fail('backpressure');
      expiry = offer.expiresAt;
    }
    const count = deviceId => [...tunnels.values()].filter(tunnel => tunnel.fromDeviceId === deviceId || tunnel.toDeviceId === deviceId).length;
    if (tunnels.size >= limits.maxTunnels || count(connection.deviceId) >= limits.maxTunnelsPerDevice || count(frame.toDeviceId) >= limits.maxTunnelsPerDevice) {
      fail('tunnel_limit');
    }
    const tunnel = { tunnelId: frame.tunnelId, fromDeviceId: connection.deviceId, toDeviceId: frame.toDeviceId,
      purpose: frame.purpose, ...(frame.offerId ? { offerId: frame.offerId } : {}), expiresAt: expiry,
      fromNonce: connection.nonce, toNonce: peer.nonce };
    tunnels.set(tunnel.tunnelId, tunnel);
    const opened = { v: 1, op: 'tunnel.opened', tunnelId: tunnel.tunnelId, fromDeviceId: tunnel.fromDeviceId,
      toDeviceId: tunnel.toDeviceId, purpose: tunnel.purpose, ...(tunnel.offerId ? { offerId: tunnel.offerId } : {}) };
    if (!send(connection, opened) || !send(peer, opened)) {
      closeTunnel(tunnel.tunnelId, 'backpressure');
      fail('backpressure');
    }
    if (tunnel.purpose === 'pairing') {
      const key = pairKey(tunnel.fromDeviceId, tunnel.toDeviceId);
      pairingAttempts.set(key, { deviceA: tunnel.fromDeviceId, deviceB: tunnel.toDeviceId, tunnelId: tunnel.tunnelId,
        offerId: tunnel.offerId, expiresAt: tunnel.expiresAt, confirmations: new Set() });
    }
    log('tunnel_opened');
  }
  function tunnelFor(connection, tunnelId) {
    id(tunnelId);
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) fail('tunnel_missing');
    if (![tunnel.fromDeviceId, tunnel.toDeviceId].includes(connection.deviceId)) fail('forbidden');
    if (tunnel.expiresAt <= now()) { closeTunnel(tunnelId, 'expired'); fail('expired'); }
    const from = connections.get(tunnel.fromDeviceId), to = connections.get(tunnel.toDeviceId);
    if (!from || !to || from.nonce !== tunnel.fromNonce || to.nonce !== tunnel.toNonce) {
      closeTunnel(tunnelId, 'peer_offline'); fail('peer_offline');
    }
    if (tunnel.purpose === 'peer' && !isPaired(tunnel.fromDeviceId, tunnel.toDeviceId)) {
      closeTunnel(tunnelId, 'unpaired'); fail('unpaired');
    }
    if (tunnel.purpose === 'pairing' && !isPaired(tunnel.fromDeviceId, tunnel.toDeviceId) && !offers.has(tunnel.offerId)) {
      closeTunnel(tunnelId, 'offer_missing'); fail('offer_missing');
    }
    return tunnel;
  }
  function forwardData(connection, frame) {
    exact(frame, ['v', 'op', 'tunnelId', 'data']);
    const tunnel = tunnelFor(connection, frame.tunnelId);
    if (typeof frame.data !== 'string' || !frame.data || frame.data.length > 4 * Math.ceil(limits.maxChunkBytes / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) fail('invalid_frame');
    const bytes = Buffer.from(frame.data, 'base64');
    if (!bytes.length || bytes.length > limits.maxChunkBytes || bytes.toString('base64') !== frame.data) fail('frame_too_large');
    const recipientId = connection.deviceId === tunnel.fromDeviceId ? tunnel.toDeviceId : tunnel.fromDeviceId;
    const peer = connections.get(recipientId);
    // Do not reorder one TLS stream. Priority is assigned to the entire tunnel;
    // endpoints must schedule semantic controls before encrypting the stream.
    if (!send(peer, { v: 1, op: 'tunnel.data', tunnelId: frame.tunnelId, data: frame.data },
      { priority: tunnel.purpose === 'pairing' ? 0 : 1, tunnelId: tunnel.tunnelId, expiresAt: tunnel.expiresAt })) {
      closeTunnel(tunnel.tunnelId, 'backpressure'); fail('backpressure');
    }
    metrics.forwardedChunks++; metrics.forwardedBytes += bytes.length;
  }
  function registerOffer(connection, frame) {
    exact(frame, ['v', 'op', 'offerId', 'expiresAt']);
    id(frame.offerId); integer(frame.expiresAt, 1);
    if (frame.expiresAt <= now() || frame.expiresAt - now() > limits.maxOfferTtlMs) fail('offer_expired');
    const previous = offers.get(frame.offerId);
    if (previous && previous.deviceId !== connection.deviceId) fail('forbidden');
    if (!previous && offers.size >= limits.maxOffers) fail('backpressure');
    offers.set(frame.offerId, { deviceId: connection.deviceId, connectionNonce: connection.nonce, expiresAt: frame.expiresAt });
    send(connection, { v: 1, op: 'pair.offered', offerId: frame.offerId, expiresAt: frame.expiresAt });
  }
  function cancelOffer(connection, frame) {
    exact(frame, ['v', 'op', 'offerId']); id(frame.offerId);
    const offer = offers.get(frame.offerId);
    if (!offer || offer.deviceId !== connection.deviceId) fail('forbidden');
    offers.delete(frame.offerId);
    closeRelated(tunnel => tunnel.offerId === frame.offerId, 'offer_cancelled');
    send(connection, { v: 1, op: 'pair.cancelled', offerId: frame.offerId });
  }
  async function confirmPair(connection, frame) {
    exact(frame, ['v', 'op', 'peerDeviceId']); id(frame.peerDeviceId);
    const key = pairKey(connection.deviceId, frame.peerDeviceId);
    const attempt = pairingAttempts.get(key);
    if (!attempt || attempt.expiresAt <= now() || !tunnels.has(attempt.tunnelId) || !offers.has(attempt.offerId)) fail('offer_missing');
    tunnelFor(connection, attempt.tunnelId);
    attempt.confirmations.add(connection.deviceId);
    if (attempt.confirmations.size !== 2) {
      send(connection, { v: 1, op: 'pair.pending', peerDeviceId: frame.peerDeviceId });
      return;
    }
    await transact(next => {
      const offer = offers.get(attempt.offerId);
      if (!offer || offer.expiresAt <= now() || pairingAttempts.get(key) !== attempt || !tunnels.has(attempt.tunnelId) ||
          !activeDevice(attempt.deviceA) || !activeDevice(attempt.deviceB)) fail('offer_missing');
      if (next.pairs.some(pair => pairKey(pair.deviceA, pair.deviceB) === key)) return;
      if (next.pairs.length >= limits.maxPairs) fail('backpressure');
      next.pairs.push({ deviceA: attempt.deviceA, deviceB: attempt.deviceB });
    });
    // A cancel/unpair/disconnect may happen during fsync. Never remove its
    // immediate deny flag or announce success for a replaced pairing attempt.
    if (pairingAttempts.get(key) !== attempt || !tunnels.has(attempt.tunnelId) || !offers.has(attempt.offerId)) fail('offer_missing');
    blockedPairs.delete(key);
    offers.delete(attempt.offerId); pairingAttempts.delete(key);
    closeRelated(tunnel => tunnel.purpose === 'pairing' && tunnel.offerId === attempt.offerId &&
      tunnel.tunnelId !== attempt.tunnelId, 'offer_consumed');
    for (const [otherKey, other] of pairingAttempts) if (other.offerId === attempt.offerId) pairingAttempts.delete(otherKey);
    for (const [deviceId, peerDeviceId] of [[attempt.deviceA, attempt.deviceB], [attempt.deviceB, attempt.deviceA]]) {
      send(connections.get(deviceId), { v: 1, op: 'pair.confirmed', peerDeviceId });
    }
    log('pair_confirmed');
  }
  async function revokePair(deviceA, deviceB) {
    const key = pairKey(id(deviceA), id(deviceB));
    blockedPairs.add(key); paired.delete(key); pairingAttempts.delete(key);
    closeRelated(tunnel => pairKey(tunnel.fromDeviceId, tunnel.toDeviceId) === key, 'unpaired');
    await transact(next => {
      next.pairs = next.pairs.filter(pair => pairKey(pair.deviceA, pair.deviceB) !== key);
      next.hints = next.hints.filter(hint => pairKey(hint.fromDeviceId, hint.toDeviceId) !== key);
    });
    for (const [deviceId, peerDeviceId] of [[deviceA, deviceB], [deviceB, deviceA]]) send(connections.get(deviceId), { v: 1, op: 'pair.revoked', peerDeviceId });
    log('pair_revoked');
  }
  async function wakeHint(connection, frame) {
    exact(frame, ['v', 'op', 'hintId', 'toDeviceId', 'kind', 'expiresAt']);
    id(frame.hintId); id(frame.toDeviceId); integer(frame.expiresAt, 1);
    if (!['invite', 'reminder'].includes(frame.kind) || frame.expiresAt <= now() || frame.expiresAt - now() > limits.maxHintTtlMs) fail('invalid_frame');
    if (!isPaired(connection.deviceId, frame.toDeviceId)) fail('unpaired');
    const hint = { hintId: frame.hintId, fromDeviceId: connection.deviceId, toDeviceId: frame.toDeviceId,
      kind: frame.kind, expiresAt: frame.expiresAt };
    await transact(next => {
      if (!isPaired(connection.deviceId, frame.toDeviceId)) fail('unpaired');
      next.hints = next.hints.filter(item => item.expiresAt > now());
      const previous = next.hints.find(item => item.fromDeviceId === hint.fromDeviceId && item.hintId === hint.hintId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(hint)) fail('duplicate_conflict');
        return;
      }
      if (next.hints.length >= limits.maxHints || next.hints.filter(item => item.toDeviceId === hint.toDeviceId).length >= limits.maxHintsPerDevice) fail('hint_limit');
      next.hints.push(hint);
    });
    metrics.storedHints++;
    send(connection, { v: 1, op: 'wake.stored', hintId: hint.hintId });
    send(connections.get(hint.toDeviceId), { v: 1, op: 'wake.hint', ...hint });
  }
  async function ackHint(connection, frame) {
    exact(frame, ['v', 'op', 'fromDeviceId', 'hintId']); id(frame.fromDeviceId); id(frame.hintId);
    await transact(next => {
      next.hints = next.hints.filter(hint => !(hint.toDeviceId === connection.deviceId && hint.fromDeviceId === frame.fromDeviceId && hint.hintId === frame.hintId));
    });
    send(connection, { v: 1, op: 'wake.acked', fromDeviceId: frame.fromDeviceId, hintId: frame.hintId });
  }
  async function processFrame(connection, data, binary) {
    if (binary) fail('invalid_frame');
    let frame;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { fail('invalid_frame'); }
    if (frame?.v !== 1) fail('unsupported_version');
    if (!connection.deviceId) return authenticate(connection, frame);
    if (!activeDevice(connection.deviceId)) fail('unauthorized');
    switch (frame.op) {
      case 'tunnel.open': return openTunnel(connection, frame);
      case 'tunnel.data': return forwardData(connection, frame);
      case 'tunnel.close':
        exact(frame, ['v', 'op', 'tunnelId']); tunnelFor(connection, frame.tunnelId);
        return closeTunnel(frame.tunnelId);
      case 'pair.offer': return registerOffer(connection, frame);
      case 'pair.cancel': return cancelOffer(connection, frame);
      case 'pair.confirm': return confirmPair(connection, frame);
      case 'pair.revoke':
        exact(frame, ['v', 'op', 'peerDeviceId']); id(frame.peerDeviceId);
        if (!isPaired(connection.deviceId, frame.peerDeviceId) && !pairingAttempts.has(pairKey(connection.deviceId, frame.peerDeviceId))) fail('unpaired');
        return revokePair(connection.deviceId, frame.peerDeviceId);
      case 'wake.hint': return wakeHint(connection, frame);
      case 'wake.ack': return ackHint(connection, frame);
      case 'ping': exact(frame, ['v', 'op']); return send(connection, { v: 1, op: 'pong' });
      default: fail('unsupported_op');
    }
  }
  function respond(response, status, value, { close = false } = {}) {
    const body = value === undefined ? '' : JSON.stringify(value);
    response.writeHead(status, { 'Content-Length': Buffer.byteLength(body),
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(close ? { Connection: 'close' } : {}) });
    response.end(body);
  }
  async function registrationProof(request) {
    const length = request.headers['content-length'];
    if (request.headers['transfer-encoding'] || typeof length !== 'string' || !/^[1-9][0-9]{0,3}$/.test(length) ||
        Number(length) > 8192 || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail('invalid_frame');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192 || size > Number(length)) fail('frame_too_large');
      chunks.push(chunk);
    }
    if (size !== Number(length)) fail('invalid_frame');
    let proof;
    try { proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail('invalid_frame'); }
    exact(proof, ['publicKey', 'signature']);
    if (typeof proof.publicKey !== 'string' || proof.publicKey.length > 4096 ||
        !proof.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || typeof proof.signature !== 'string' ||
        proof.signature.length < 80 || proof.signature.length > 128 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(proof.signature)) fail('invalid_frame');
    try {
      const publicKey = createPublicKey(proof.publicKey);
      if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('forbidden');
      const spki = publicKey.export({ type: 'spki', format: 'der' });
      const deviceId = 'dev_' + createHash('sha256').update(spki).digest('base64url');
      const signature = Buffer.from(proof.signature, 'base64');
      if (signature.toString('base64') !== proof.signature ||
          !verify('sha256', Buffer.from('cc-remote-register-v1:' + deviceId), publicKey, signature)) fail('forbidden');
      return { deviceId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
    } catch { fail('forbidden'); }
  }
  const httpHandler = async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (stopped) { respond(response, 503); return; }
    if (request.method === 'GET' && request.url === '/healthz') {
      respond(response, 200, { ok: true, version: 1, transport: 'opaque-tls-tunnel' });
      return;
    }
    // Bootstrap authorizes enrollment, while P-256 proof binds the derived ID to
    // the registering key. Existing IDs are never overwritten or re-issued.
    if (request.method === 'POST' && request.url === '/v1/devices/register' && bootstrapHash) {
      try {
        if (!upgradeBucket.take()) fail('rate_limited');
        if (request.headers.origin && !origins.has(request.headers.origin)) fail('forbidden');
        const authorization = request.headers.authorization;
        const digest = tokenHash(typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
        if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(bootstrapHash, 'hex'))) fail('unauthorized');
        const proof = await registrationProof(request);
        const device = { deviceId: proof.deviceId, token: randomBytes(32).toString('base64url') };
        await transact(next => {
          if (next.devices.some(existing => existing.deviceId === device.deviceId)) fail('duplicate_conflict');
          if (next.devices.length >= limits.maxDevices) fail('backpressure');
          next.devices.push({ deviceId: device.deviceId, tokenHash: tokenHash(device.token), revoked: false, publicKey: proof.publicKey });
        });
        respond(response, 201, { v: 1, ...device });
      } catch (cause) {
        log('registration_rejected', safeCode(cause));
        respond(response, cause.code === 'rate_limited' ? 429 : 403, undefined, { close: true });
      }
      return;
    }
    respond(response, 404);
  };
  const server = tls ? createHttpsServer(tls, httpHandler) : createHttpServer(httpHandler);
  server.headersTimeout = limits.authTimeoutMs;
  server.requestTimeout = limits.authTimeoutMs;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 5000;
  server.maxConnections = limits.maxDevices + limits.maxUnauthenticated + 8;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes,
    perMessageDeflate: false, clientTracking: true, allowSynchronousEvents: false });
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    if (stopped || request.url !== '/v1/relay' || request.method !== 'GET' ||
        request.headers.origin && !origins.has(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    if (!upgradeBucket.take() || unauthenticated.size >= limits.maxUnauthenticated) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const connection = { ws, deviceId: null, nonce: randomUUID(), closed: false, alive: true,
      inputChain: Promise.resolve(), inputBytes: 0, inputItems: 0, slowSince: null,
      bytes: new TokenBucket({ rate: limits.bytesPerSecond, burst: limits.burstBytes, now }),
      messages: new TokenBucket({ rate: limits.messagesPerSecond, burst: limits.messageBurst, now }) };
    connection.outbox = outboxFactory({ socket: ws, maxBytes: limits.maxQueuedBytes, maxItems: limits.maxQueuedItems,
      highReserveBytes: limits.highReserveBytes, highReserveItems: limits.highReserveItems, maxSocketBytes: limits.maxSocketBytes,
      sendBytesPerSecond: limits.outboundBytesPerSecond, burstBytes: limits.outboundBurstBytes, now,
      onResult(metadata, code) { if (metadata?.tunnelId && code !== 'forwarded') closeTunnel(metadata.tunnelId, code); } });
    unauthenticated.add(connection);
    connection.authTimer = setTimeout(() => {
      if (!connection.deviceId) { log('auth_rejected', 'auth_timeout'); ws.close(4003, 'auth_timeout'); disconnect(connection); }
    }, limits.authTimeoutMs);
    connection.authTimer.unref();
    ws.on('message', (data, binary) => {
      if (connection.closed) return;
      if (!connection.bytes.take(data.length) || !connection.messages.take()) { ws.close(1008, 'rate_limited'); disconnect(connection); return; }
      const inputCap = connection.deviceId ? limits.maxQueuedBytes : 4096;
      const itemCap = connection.deviceId ? limits.maxQueuedItems : 2;
      if (connection.inputBytes + data.length > inputCap || connection.inputItems >= itemCap) {
        ws.close(1013, 'backpressure'); disconnect(connection); return;
      }
      connection.inputBytes += data.length; connection.inputItems++;
      connection.inputChain = connection.inputChain.then(async () => {
        if (connection.closed || stopped) return;
        try { await processFrame(connection, data, binary); }
        catch (cause) {
          const code = safeCode(cause); error(connection, code);
          if (!connection.deviceId) { ws.close(4003, code); disconnect(connection); }
        }
      }).finally(() => { connection.inputBytes -= data.length; connection.inputItems--; });
    });
    ws.on('pong', () => { connection.alive = true; });
    ws.on('close', () => disconnect(connection));
    ws.on('error', () => { log('socket_error'); disconnect(connection); });
  });
  async function sweep() {
    if (stopped) return;
    for (const [offerId, offer] of offers) if (offer.expiresAt <= now()) {
      offers.delete(offerId); closeRelated(tunnel => tunnel.offerId === offerId, 'offer_expired');
    }
    for (const [tunnelId, tunnel] of [...tunnels]) if (tunnel.expiresAt <= now()) closeTunnel(tunnelId, 'expired');
    for (const [key, attempt] of pairingAttempts) if (attempt.expiresAt <= now() || !tunnels.has(attempt.tunnelId)) pairingAttempts.delete(key);
    for (const connection of connections.values()) {
      if (connection.outbox.stats().queuedItems || connection.ws.bufferedAmount > limits.maxSocketBytes) {
        connection.slowSince ??= now();
        if (now() - connection.slowSince >= limits.slowPeerMs) { disconnect(connection); connection.ws.close(1013, 'slow_peer'); }
      } else connection.slowSince = null;
    }
    if (state.hints.some(hint => hint.expiresAt <= now())) await transact(next => {
      const before = next.hints.length;
      next.hints = next.hints.filter(hint => hint.expiresAt > now());
      metrics.expiredHints += before - next.hints.length;
    });
  }
  let sweeping = false;
  const sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep().catch(() => log('sweep_failed', 'internal_error')).finally(() => { sweeping = false; });
  }, limits.sweepMs);
  sweepTimer.unref();
  const heartbeatTimer = setInterval(() => {
    for (const connection of [...connections.values(), ...unauthenticated]) {
      if (!connection.alive) { connection.ws.terminate(); disconnect(connection); continue; }
      connection.alive = false; connection.ws.ping();
    }
  }, limits.heartbeatMs);
  heartbeatTimer.unref();
  server.on('clientError', (cause, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));

  return Object.freeze({
    httpServer: server,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (!tls && !LOOPBACK.has(host)) fail('tls_required');
      if (stopped || server.listening) fail('invalid_state');
      await new Promise((resolve, reject) => {
        const listening = () => { server.off('error', error); resolve(); };
        const error = cause => { server.off('listening', listening); reject(cause); };
        server.once('listening', listening); server.once('error', error); server.listen({ port, host });
      });
      return server.address();
    },
    address() { return server.address(); },
    stats() { return { ...metrics, connectedDevices: connections.size, unauthenticated: unauthenticated.size,
      pairedDevices: paired.size, tunnels: tunnels.size, offers: offers.size, pendingHints: state.hints.length,
      queuedBytes: [...connections.values(), ...unauthenticated].reduce((sum, c) => sum + c.outbox.stats().queuedBytes, 0),
      queuedItems: [...connections.values(), ...unauthenticated].reduce((sum, c) => sum + c.outbox.stats().queuedItems, 0) }; },
    async registerDevice({ deviceId, token, publicKey }) {
      if (stopped) fail('forbidden');
      id(deviceId); const digest = tokenHash(token);
      await transact(next => {
        if (next.devices.some(device => device.deviceId === deviceId || device.tokenHash === digest)) fail('duplicate_conflict');
        if (next.devices.length >= limits.maxDevices) fail('backpressure');
        next.devices.push({ deviceId, tokenHash: digest, revoked: false, ...(publicKey !== undefined ? { publicKey } : {}) });
      });
    },
    revokePair,
    async revokeDevice(deviceId) {
      id(deviceId);
      if (!deviceMap.has(deviceId)) fail('forbidden');
      blockedDevices.add(deviceId);
      const connection = connections.get(deviceId);
      if (connection) { disconnect(connection); connection.ws.close(4003, 'device_revoked'); }
      closeRelated(tunnel => tunnel.fromDeviceId === deviceId || tunnel.toDeviceId === deviceId, 'device_revoked');
      await transact(next => {
        next.devices.find(device => device.deviceId === deviceId).revoked = true;
        next.pairs = next.pairs.filter(pair => pair.deviceA !== deviceId && pair.deviceB !== deviceId);
        next.hints = next.hints.filter(hint => hint.fromDeviceId !== deviceId && hint.toDeviceId !== deviceId);
      });
    },
    sweep,
    async flush() { await mutation; await store.flush(); },
    close() {
      if (stopping) return stopping;
      stopping = (async () => {
        stopped = true; clearInterval(sweepTimer); clearInterval(heartbeatTimer);
        const closing = [...connections.values(), ...unauthenticated];
        for (const connection of closing) { disconnect(connection); connection.ws.terminate(); }
        await Promise.all(closing.map(connection => connection.inputChain));
        await mutation; await store.close();
        await new Promise(resolve => wss.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        server.closeAllConnections(); tunnels.clear(); offers.clear(); pairingAttempts.clear();
        log('relay_stopped');
      })();
      return stopping;
    },
  });
}

import { createHash } from 'node:crypto';

export const RELAY_VERSION = 1;
export const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxCiphertextBytes: 60 * 1024,
  maxDevices: 8,
  maxPairs: 16,
  maxRoutes: 128,
  maxStateBytes: 4 * 1024 * 1024,
  maxPendingBytes: 1024 * 1024,
  maxPendingPerDeviceBytes: 512 * 1024,
  maxPendingItems: 128,
  maxPendingPerDevice: 64,
  maxInviteTtlMs: 5 * 60 * 1000,
  maxReminderTtlMs: 5 * 60 * 1000,
  maxControlTtlMs: 60 * 1000,
  maxRouteTtlMs: 24 * 60 * 60 * 1000,
  maxQueuedBytes: 512 * 1024,
  maxQueuedItems: 128,
  highReserveBytes: 128 * 1024,
  highReserveItems: 16,
  maxSocketBytes: 64 * 1024,
  inboundBytesPerSecond: 256 * 1024,
  inboundBurstBytes: 128 * 1024,
  messagesPerSecond: 30,
  messageBurst: 60,
  outboundBytesPerSecond: 256 * 1024,
  outboundBurstBytes: 64 * 1024,
  upgradesPerSecond: 2,
  upgradeBurst: 10,
  authTimeoutMs: 5000,
  heartbeatMs: 30000,
  sweepMs: 1000,
  slowPeerMs: 15000,
});

export class RelayError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new RelayError(code); };
export const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function exact(value, required, optional = []) {
  if (!plainObject(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid_frame');
  return value;
}
export function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('invalid_id');
  return value;
}
export function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('invalid_frame');
  return value;
}
export function tokenHash(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) fail('invalid_token');
  return createHash('sha256').update(token).digest('hex');
}
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function pairKey(a, b) { return [a, b].sort().join('|'); }
export function routeKey(host, session) { return `${host}|${session}`; }
export function routeBinding(value) {
  exact(value, ['hostDeviceId', 'phoneDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'expiresAt']);
  for (const field of ['hostDeviceId', 'phoneDeviceId', 'hostInstanceId', 'remoteSessionId']) id(value[field]);
  if (value.hostDeviceId === value.phoneDeviceId) fail('invalid_route');
  integer(value.grantVersion, 1);
  integer(value.expiresAt, 1);
  return value;
}
export function sameRoute(a, b) {
  return ['hostDeviceId', 'phoneDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'expiresAt']
    .every(key => a[key] === b[key]);
}
export function validateLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.keys(overrides).some(key => !Object.hasOwn(DEFAULT_LIMITS, key)) ||
      Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0) ||
      limits.maxFrameBytes > 64 * 1024 || limits.maxCiphertextBytes >= limits.maxFrameBytes ||
      limits.maxSocketBytes < limits.maxFrameBytes || limits.outboundBurstBytes < limits.maxFrameBytes ||
      limits.highReserveBytes >= limits.maxQueuedBytes || limits.highReserveItems >= limits.maxQueuedItems) {
    fail('invalid_limits');
  }
  return Object.freeze(limits);
}

export function validateMetadata(state, limits) {
  exact(state, ['version', 'devices', 'pairs', 'routes', 'pending']);
  if (state.version !== 1 || !Array.isArray(state.devices) || state.devices.length > limits.maxDevices ||
      !Array.isArray(state.pairs) || state.pairs.length > limits.maxPairs ||
      !Array.isArray(state.routes) || state.routes.length > limits.maxRoutes ||
      !Array.isArray(state.pending) || state.pending.length > limits.maxPendingItems) fail('invalid_state');
  const devices = new Set();
  for (const device of state.devices) {
    exact(device, ['deviceId', 'tokenHash', 'revoked'], ['publicKey']);
    id(device.deviceId);
    if (devices.has(device.deviceId) || !/^[0-9a-f]{64}$/.test(device.tokenHash) || typeof device.revoked !== 'boolean' ||
        device.publicKey !== undefined && (typeof device.publicKey !== 'string' || device.publicKey.length > 4096)) fail('invalid_state');
    devices.add(device.deviceId);
  }
  const pairs = new Set();
  for (const pair of state.pairs) {
    exact(pair, ['deviceA', 'deviceB']);
    if (!devices.has(pair.deviceA) || !devices.has(pair.deviceB) || pair.deviceA === pair.deviceB ||
        pairs.has(pairKey(pair.deviceA, pair.deviceB))) fail('invalid_state');
    pairs.add(pairKey(pair.deviceA, pair.deviceB));
  }
  const routes = new Set();
  for (const route of state.routes) {
    routeBinding(route);
    if (!pairs.has(pairKey(route.hostDeviceId, route.phoneDeviceId)) || routes.has(routeKey(route.hostDeviceId, route.remoteSessionId))) {
      fail('invalid_state');
    }
    routes.add(routeKey(route.hostDeviceId, route.remoteSessionId));
  }
  let pendingBytes = 0;
  const pendingIds = new Set();
  const recipients = new Map();
  for (const pending of state.pending) {
    exact(pending, ['fromDeviceId', 'toDeviceId', 'messageId', 'kind', 'expiresAt', 'wire']);
    id(pending.fromDeviceId); id(pending.toDeviceId); id(pending.messageId); integer(pending.expiresAt, 1);
    if (!['invite', 'reminder'].includes(pending.kind) || !pairs.has(pairKey(pending.fromDeviceId, pending.toDeviceId)) ||
        typeof pending.wire !== 'string' || Buffer.byteLength(pending.wire) > limits.maxFrameBytes) fail('invalid_state');
    const key = `${pending.fromDeviceId}|${pending.messageId}`;
    if (pendingIds.has(key)) fail('invalid_state');
    pendingIds.add(key);
    const recipient = recipients.get(pending.toDeviceId) || { items: 0, bytes: 0 };
    recipient.items++; recipient.bytes += Buffer.byteLength(pending.wire);
    if (recipient.items > limits.maxPendingPerDevice || recipient.bytes > limits.maxPendingPerDeviceBytes) fail('invalid_state');
    recipients.set(pending.toDeviceId, recipient);
    pendingBytes += Buffer.byteLength(pending.wire);
  }
  if (pendingBytes > limits.maxPendingBytes) fail('invalid_state');
}

// Private Android host client. Imports have no I/O, timers or ambient credential reads.
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const HOST_VERSION = 1;
export const HOST_BOOTSTRAP_ENV = 'CCAPP_REMOTE_HOST_BOOTSTRAP';
export const HOST_LIMITS = Object.freeze({ lineBytes: 64 * 1024, secretBytes: 24 * 1024, notifications: 128, pending: 8 });
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const purposes = new Set(['identity-v1', 'pairing-v1', 'connection-v1']);
const states = new Set(['offline', 'connecting', 'online', 'resyncing', 'error']);
export class RemoteHostError extends Error {
  constructor(code = 'HOST_OPERATION_FAILED') { super(code); this.name = 'RemoteHostError'; this.code = code; }
}
const fail = (code = 'INVALID_HOST_REQUEST') => { throw new RemoteHostError(code); };
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail();
  }
  return value;
}
function id(value) { if (typeof value !== 'string' || !idPattern.test(value)) fail(); return value; }
function integer(value, min = 0, max = MAX_SAFE) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); return value; }
function bool(value) { if (typeof value !== 'boolean') fail(); return value; }
function binding(value) {
  exact(value, ['fromDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion']);
  return { fromDeviceId: id(value.fromDeviceId), hostInstanceId: id(value.hostInstanceId), remoteSessionId: id(value.remoteSessionId), grantVersion: integer(value.grantVersion, 1) };
}
function notification(value, now) {
  exact(value, ['kind', 'binding', 'runId', 'requestId', 'eventId', 'expiresAt']);
  if (!['invite', 'request', 'done'].includes(value.kind)) fail();
  const runId = value.runId === null ? null : id(value.runId);
  const requestId = value.requestId === null ? null : id(value.requestId);
  if (value.kind !== 'invite' && runId === null || value.kind === 'request' && requestId === null
      || value.kind !== 'request' && requestId !== null) fail();
  return { kind: value.kind, binding: binding(value.binding), runId, requestId, eventId: id(value.eventId),
    expiresAt: integer(value.expiresAt, 1, now + 86_400_000) };
}
function envelope(value) {
  exact(value, ['v', 'nonce', 'ciphertext']);
  integer(value.v, 1, 1);
  const nonce = base64(value.nonce, 12), ciphertext = base64(value.ciphertext, HOST_LIMITS.secretBytes + 16);
  if (nonce.length !== 12 || ciphertext.length < 16) fail();
  return { v: 1, nonce: value.nonce, ciphertext: value.ciphertext };
}
function base64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail();
  return bytes;
}
function vaultLabels(purpose, recordId) { if (!purposes.has(purpose)) fail(); id(recordId); }

/** Narrow methods only. Do not mount this object or its protector on HTTP/frontend routes. */
export function createHostAdapter({ request, now = Date.now } = {}) {
  if (typeof request !== 'function') fail();
  const call = async (op, args) => {
    try { return await request(op, args); }
    catch (e) { throw e instanceof RemoteHostError ? e : new RemoteHostError('HOST_UNAVAILABLE'); }
  };
  const adapter = {
    available: true,
    status: () => call('status', {}),
    setBackgroundEnabled(enabled, { userInitiated = false } = {}) {
      bool(enabled); if (userInitiated !== true) fail('USER_ACTION_REQUIRED');
      return call('background.set', { enabled, userInitiated: true });
    },
    reportConnectionState(state, lastEventAt = 0) {
      if (!states.has(state)) fail();
      return call('connection.state', { state, lastEventAt: integer(lastEventAt, 0, now() + 5000) });
    },
    syncNotifications(entries) {
      if (!Array.isArray(entries) || entries.length > HOST_LIMITS.notifications) fail('NOTIFICATION_LIMIT');
      return call('notifications.sync', { entries: entries.map((e) => notification(e, now())) });
    },
    revokeNotifications(value) { return call('notifications.revoke', binding(value)); },
    clearNotifications() { return call('notifications.clear', {}); },
    // Only the trusted backend identity/pairing store receives this protector.
    secretProtector: Object.freeze({
      async seal(purpose, recordId, plaintext) {
        vaultLabels(purpose, recordId);
        if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > HOST_LIMITS.secretBytes) fail();
        const raw = Buffer.from(plaintext);
        try { return envelope(await call('vault.seal', { purpose, recordId, plaintext: raw.toString('base64') })); }
        finally { raw.fill(0); }
      },
      async open(purpose, recordId, value) {
        vaultLabels(purpose, recordId);
        const result = await call('vault.open', { purpose, recordId, envelope: envelope(value) });
        exact(result, ['plaintext']);
        return base64(result.plaintext, HOST_LIMITS.secretBytes);
      },
    }),
    watchPolicy(listener, { intervalMs = 2000 } = {}) {
      if (typeof listener !== 'function') fail();
      integer(intervalMs, 250, 60_000);
      let stopped = false, timer = null;
      const poll = async () => {
        let status;
        try { status = await adapter.status(); }
        catch { status = unavailableStatus(); }
        if (stopped) return;
        try { await listener(status); } catch { /* Client errors cannot leak host request/response bodies. */ }
        if (!stopped) { timer = setTimeout(poll, intervalMs); timer.unref?.(); }
      };
      void poll();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    },
  };
  return Object.freeze(adapter);
}

function unavailableStatus() {
  return { v: 1, hostAvailable: false, serviceRunning: false, foreground: false, backgroundEnabled: false,
    backgroundEffective: false, shouldConnect: false, deliveryMode: 'foreground-only', connectionState: 'offline',
    error: 'HOST_UNAVAILABLE', realDeviceBackgroundVerified: false, keystoreMasterExportable: false,
    softwareKeyInTrustedNode: false };
}
export function createUnavailableHostAdapter() {
  const no = async () => fail('HOST_UNAVAILABLE');
  return Object.freeze({ available: false, status: async () => unavailableStatus(), setBackgroundEnabled: no,
    reportConnectionState: no, syncNotifications: no, revokeNotifications: no, clearNotifications: no,
    secretProtector: Object.freeze({ seal: no, open: no }),
    watchPolicy(listener) { let stopped = false; queueMicrotask(() => { if (!stopped) Promise.resolve(listener(unavailableStatus())).catch(() => {}); }); return () => { stopped = true; }; },
  });
}

/** One bounded request/response per filesystem Unix socket. No TCP or arbitrary path proxy. */
export function createSocketHostAdapter({ socketPath, capability, connect = createConnection, timeoutMs = 3000, now } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0')
    || path.basename(socketPath) !== '.remote-host-v1.sock' || Buffer.byteLength(socketPath) > 103
    || typeof capability !== 'string' || !/^[0-9a-f]{64}$/.test(capability) || typeof connect !== 'function') fail('INVALID_HOST_BOOTSTRAP');
  integer(timeoutMs, 50, 30_000);
  let pending = 0;
  const request = (op, args) => {
    if (pending >= HOST_LIMITS.pending) return Promise.reject(new RemoteHostError('HOST_BUSY'));
    const requestId = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ v: 1, id: requestId, capability, op, args }) + '\n');
    if (bytes.length > HOST_LIMITS.lineBytes) return Promise.reject(new RemoteHostError('HOST_FRAME_LIMIT'));
    pending++;
    return new Promise((resolve, reject) => {
      let socket, settled = false, total = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true; pending--; clearTimeout(timer);
        bytes.fill(0);
        for (const b of chunks) b.fill(0);
        socket?.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(new RemoteHostError('HOST_TIMEOUT')), timeoutMs);
      try {
        socket = connect({ path: socketPath });
        socket.once('error', () => finish(new RemoteHostError('HOST_UNAVAILABLE')));
        socket.once('connect', () => socket.write(bytes));
        socket.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > HOST_LIMITS.lineBytes) { finish(new RemoteHostError('HOST_FRAME_LIMIT')); return; }
          chunks.push(Buffer.from(chunk));
          if (!chunk.includes(10)) return;
          const joined = Buffer.concat(chunks);
          try {
            const end = joined.indexOf(10);
            if (end !== joined.length - 1) fail('INVALID_HOST_RESPONSE');
            const response = JSON.parse(joined.subarray(0, end).toString('utf8'));
            if (response.ok === true) exact(response, ['v', 'id', 'ok', 'result']);
            else exact(response, ['v', 'id', 'ok', 'error']);
            if (response.v !== 1 || response.id !== requestId || typeof response.ok !== 'boolean') fail('INVALID_HOST_RESPONSE');
            if (!response.ok) {
              const code = ['INVALID_HOST_REQUEST', 'VAULT_UNAVAILABLE', 'HOST_OPERATION_FAILED'].includes(response.error) ? response.error : 'HOST_OPERATION_FAILED';
              fail(code);
            }
            finish(null, response.result);
          } catch (e) {
            const safe = e instanceof RemoteHostError && ['HOST_OPERATION_FAILED', 'VAULT_UNAVAILABLE'].includes(e.code);
            finish(safe ? e : new RemoteHostError('INVALID_HOST_RESPONSE'));
          }
          finally { joined.fill(0); }
        });
        socket.once('end', () => { if (!settled) finish(new RemoteHostError('HOST_RESPONSE_INCOMPLETE')); });
        socket.once('close', () => { if (!settled) finish(new RemoteHostError('HOST_UNAVAILABLE')); });
      } catch { finish(new RemoteHostError('HOST_UNAVAILABLE')); }
    });
  };
  return createHostAdapter({ request, now });
}

/** Consume only the direct-child stdin bootstrap, once at gateway startup, before spawning children. */
export async function createHostAdapterFromGatewayStdin({ input = process.stdin, env = process.env, timeoutMs = 5000, connect, now } = {}) {
  const mode = env[HOST_BOOTSTRAP_ENV];
  delete env[HOST_BOOTSTRAP_ENV]; // Not inherited by model/tool subprocesses.
  if (mode === undefined) return createUnavailableHostAdapter();
  if (mode !== 'stdin-v1' || !input || typeof input.on !== 'function') return createUnavailableHostAdapter();
  integer(timeoutMs, 50, 30_000);
  try {
    const bootstrap = await new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      const cleanup = () => { clearTimeout(timer); input.pause?.(); input.removeListener('data', data); input.removeListener('error', error); input.removeListener('end', end); for (const b of chunks) b.fill(0); };
      const error = () => { cleanup(); reject(new RemoteHostError('HOST_BOOTSTRAP_UNAVAILABLE')); };
      const end = () => error();
      const data = (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 2048) { error(); return; }
        chunks.push(Buffer.from(chunk));
        if (!Buffer.from(chunk).includes(10)) return;
        const bytes = Buffer.concat(chunks);
        try {
          const pos = bytes.indexOf(10);
          if (pos !== bytes.length - 1) fail('INVALID_HOST_BOOTSTRAP');
          const value = JSON.parse(bytes.subarray(0, pos).toString('utf8'));
          exact(value, ['v', 'type', 'socketPath', 'capability']);
          if (value.v !== 1 || value.type !== 'cc.remote.host.bootstrap') fail('INVALID_HOST_BOOTSTRAP');
          cleanup(); resolve(value);
        } catch { error(); }
        finally { bytes.fill(0); }
      };
      const timer = setTimeout(error, timeoutMs);
      input.on('data', data); input.once('error', error); input.once('end', end); input.resume?.();
    });
    return createSocketHostAdapter({ socketPath: bootstrap.socketPath, capability: bootstrap.capability, connect, now });
  } catch { return createUnavailableHostAdapter(); }
}

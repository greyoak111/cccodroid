// End-to-end TLS over a relay's *opaque byte stream*. The relay must not
// terminate this TLS connection. No home-directory reads or startup side effects.
import tls from 'node:tls';
import { createHash, createPrivateKey, createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { validateFrame, LIMITS } from './protocol.mjs';

export const REMOTE_TLS = Object.freeze({
  version: 'TLSv1.3',
  cipher: 'TLS_AES_128_GCM_SHA256',
  curve: 'prime256v1',
  alpn: 'cc-remote/1',
  frameBytes: 64 * 1024,
  queueBytes: 512 * 1024,
  pairingTtlMs: 300_000,
});

export class RemoteCryptoError extends Error {
  constructor(code) {
    // Do not propagate OpenSSL errors: their details can contain credentials.
    super(code);
    this.name = 'RemoteCryptoError';
    this.code = code;
  }
}
const fail = (code) => { throw new RemoteCryptoError(code); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_CHANNEL_FRAME');
};
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const time = (now) => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK');
  return value;
};
const pinBytes = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('INVALID_IDENTITY');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) fail('INVALID_IDENTITY');
  return bytes;
};
export function samePublicPin(a, b) {
  return timingSafeEqual(pinBytes(a), pinBytes(b));
}
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** A device ID is bound to its public key, not its editable display name.
 * cert is an X.509 PEM/DER certificate, never an identity supplied by a page. */
export function identityFromCertificate(cert, { now = Date.now } = {}) {
  try {
    const x509 = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
    const key = x509.publicKey;
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== REMOTE_TLS.curve) fail('UNSUPPORTED_IDENTITY');
    const current = time(now);
    const validFrom = Date.parse(x509.validFrom), validTo = Date.parse(x509.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || current < validFrom || current >= validTo) fail('CERTIFICATE_EXPIRED');
    const spkiSha256 = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url');
    return Object.freeze({ deviceId: 'dev_' + spkiSha256, spkiSha256 });
  } catch (error) {
    if (error instanceof RemoteCryptoError) throw error;
    fail('INVALID_CERTIFICATE');
  }
}

/** Share one guard across reconnects for a host process lifecycle. Full means
 * reject, not evict an unexpired replay entry. A new hostInstanceId is mandatory
 * after a process restart; this in-memory guard is not a durable command ledger. */
export function createReplayGuard({ now = Date.now, maxEntries = 8192 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65_536) fail('INVALID_REPLAY_LIMIT');
  const entries = new Map();
  const prune = () => {
    const current = time(now);
    for (const [key, expiry] of entries) if (expiry <= current) entries.delete(key);
    return current;
  };
  return Object.freeze({
    accept(frame) {
      const current = prune();
      if (!id(frame.fromDeviceId) || !id(frame.messageId) || !Number.isSafeInteger(frame.expiresAt)
        || frame.expiresAt <= current || frame.expiresAt > current + LIMITS.FRAME_TTL_MS + LIMITS.CLOCK_SKEW_MS) fail('INVALID_REPLAY_FRAME');
      // JSON encoding prevents delimiter ambiguities in user-selected IDs.
      const key = JSON.stringify([frame.fromDeviceId, frame.messageId]);
      if (entries.has(key)) fail('REPLAY_DETECTED');
      if (entries.size >= maxEntries) fail('REPLAY_GUARD_FULL');
      entries.set(key, frame.expiresAt);
    },
    get size() { prune(); return entries.size; },
  });
}

const pairCommon = ['v', 'type', 'messageId', 'fromDeviceId', 'toDeviceId', 'issuedAt', 'expiresAt', 'payload'];
const pairPayloads = Object.freeze({
  'pair.claim': ['offerId', 'attemptId', 'secret', 'name'],
  'pair.challenge': ['offerId', 'attemptId', 'name'],
  'pair.confirm': ['offerId', 'attemptId'],
  'pair.complete': ['offerId', 'attemptId'],
  'pair.abort': ['offerId', 'attemptId'],
});
function checkedPairFrame(value, now, localIdentity, peerIdentity, incoming) {
  exact(value, pairCommon);
  if (value.v !== 1 || !Object.hasOwn(pairPayloads, value.type)) fail('PAIRING_ONLY');
  if (!id(value.messageId) || value.fromDeviceId !== (incoming ? peerIdentity : localIdentity).deviceId
    || value.toDeviceId !== (incoming ? localIdentity : peerIdentity).deviceId) fail('DEVICE_MISMATCH');
  const current = time(now);
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > REMOTE_TLS.pairingTtlMs
    || value.issuedAt > current + LIMITS.CLOCK_SKEW_MS || value.expiresAt <= current) fail('PAIRING_EXPIRED');
  exact(value.payload, pairPayloads[value.type]);
  for (const key of ['offerId', 'attemptId']) if (!id(value.payload[key])) fail('INVALID_CHANNEL_FRAME');
  if (Object.hasOwn(value.payload, 'secret')) pinBytes(value.payload.secret);
  if (Object.hasOwn(value.payload, 'name') && (typeof value.payload.name !== 'string'
    || !value.payload.name.trim() || Buffer.byteLength(value.payload.name) > 256 || /[\u0000-\u001f\u007f]/.test(value.payload.name))) fail('INVALID_CHANNEL_FRAME');
  // All values have been checked; detach the caller's object before retaining it.
  return freeze(JSON.parse(JSON.stringify(value)));
}

// Only channels created here carry this brand; a JS object with purpose='pairing'
// must not be accepted as evidence of a TLS-authenticated peer by pairing.mjs.
const channelInfo = new WeakMap();
export function secureChannelInfo(channel) {
  const info = channelInfo.get(channel);
  if (!info || !info.authenticated || info.closed) fail('UNAUTHENTICATED_CHANNEL');
  return Object.freeze({ role: info.role, purpose: info.purpose, localIdentity: info.localIdentity,
    peerIdentity: info.peerIdentity, channelId: info.channelId });
}

/** Production entry point. A caller must obtain peerPin from its confirmed
 * pairing store, not from an incoming frame, relay or browser. */
export function createSecureChannel(options) { return createChannel({ ...options, purpose: 'session' }); }

/** Bootstrap entry point. The phone MUST pin the tablet from its out-of-band
 * QR. An unpinned tablet accepts only pair.* until both users confirm. */
export function createPairingChannel(options) { return createChannel({ ...options, purpose: 'pairing' }); }

function createChannel({ role, transport, credentials, peerPin, purpose, context, replayGuard,
  now = Date.now, authorizeFrame, handshakeTimeoutMs = 10_000, maxAgeMs = 3_600_000 } = {}) {
  if (!['client', 'server'].includes(role) || !transport || typeof transport.write !== 'function'
    || typeof transport.on !== 'function' || typeof transport.destroy !== 'function') fail('INVALID_TRANSPORT');
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30_000
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 3_600_000) fail('INVALID_CHANNEL_LIMIT');
  if (purpose === 'session' || role === 'client') pinBytes(peerPin);
  else if (peerPin !== undefined) pinBytes(peerPin);
  let fixedContext;
  if (purpose === 'session') {
    if (context !== undefined) {
      exact(context, ['hostInstanceId', 'remoteSessionId', 'grantVersion']);
      if (!id(context.hostInstanceId) || !id(context.remoteSessionId) || !Number.isSafeInteger(context.grantVersion)
        || context.grantVersion < 1) fail('INVALID_CHANNEL_CONTEXT');
      fixedContext = Object.freeze({ ...context });
    } else if (typeof authorizeFrame !== 'function') fail('AUTHORIZER_REQUIRED');
    if (!replayGuard || typeof replayGuard.accept !== 'function') fail('REPLAY_GUARD_REQUIRED');
    if (authorizeFrame !== undefined && typeof authorizeFrame !== 'function') fail('INVALID_AUTHORIZER');
  }
  let ownIdentity, secureContext;
  try {
    ownIdentity = identityFromCertificate(credentials.cert, { now });
    const key = credentials.key?.type === 'private' ? credentials.key : createPrivateKey(credentials.key);
    const actual = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64url');
    if (!samePublicPin(actual, ownIdentity.spkiSha256)) fail('CREDENTIAL_MISMATCH');
    const ephemeralPem = Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }));
    try {
      secureContext = tls.createSecureContext({ key: ephemeralPem, cert: credentials.cert, minVersion: REMOTE_TLS.version,
        maxVersion: REMOTE_TLS.version, ciphers: REMOTE_TLS.cipher, ecdhCurve: REMOTE_TLS.curve,
        sigalgs: 'ecdsa_secp256r1_sha256' });
    } finally { ephemeralPem.fill(0); }
  } catch (error) {
    if (error instanceof RemoteCryptoError) throw error;
    fail('TLS_CREDENTIALS_UNAVAILABLE');
  }
  const info = { role, purpose, localIdentity: ownIdentity, peerIdentity: null, channelId: null,
    authenticated: false, closed: false };
  const messages = new Set(), closes = new Set();
  let resolveReady, rejectReady, socket, handshakeTimer, ageTimer;
  let sendSeq = 0, receiveSeq = 0, pendingWrites = 0, headerUsed = 0, bodyUsed = 0, body = null;
  const header = Buffer.alloc(4);
  const pairingReplay = purpose === 'pairing' ? createReplayGuard({ now, maxEntries: 64 }) : null;
  const startedAt = time(now);
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A peer can disconnect before an owner starts awaiting ready.
  ready.catch(() => {});
  function close(code = 'CHANNEL_CLOSED') {
    if (info.closed) return;
    info.closed = true;
    clearTimeout(handshakeTimer); clearTimeout(ageTimer);
    body?.fill(0); body = null;
    rejectReady(new RemoteCryptoError(code));
    socket?.destroy();
    for (const listener of closes) { try { listener(Object.freeze({ code })); } catch {} }
    messages.clear(); closes.clear();
  }
  function live() {
    if (info.closed || !info.authenticated) fail('CHANNEL_NOT_READY');
    if (time(now) - startedAt >= maxAgeMs) { close('CHANNEL_EXPIRED'); fail('CHANNEL_EXPIRED'); }
  }
  function checkedFrame(frame, incoming) {
    if (purpose === 'pairing') return checkedPairFrame(frame, now, ownIdentity, info.peerIdentity, incoming);
    const from = incoming ? info.peerIdentity : ownIdentity, to = incoming ? ownIdentity : info.peerIdentity;
    const checked = validateFrame(frame, { now });
    if (checked.fromDeviceId !== from.deviceId || checked.toDeviceId !== to.deviceId) fail('DEVICE_MISMATCH');
    if (fixedContext) for (const [key, code] of [['hostInstanceId', 'HOST_INSTANCE_MISMATCH'], ['remoteSessionId', 'SESSION_MISMATCH'], ['grantVersion', 'GRANT_MISMATCH']]) {
      if (checked[key] !== fixedContext[key]) fail(code);
    }
    // Business policy must still check live grants/runs/request state. An async
    // or truthy non-boolean result is not an authorization decision.
    if (authorizeFrame) {
      const decision = authorizeFrame(checked, Object.freeze({ incoming }));
      if (decision && typeof decision.then === 'function') {
        Promise.resolve(decision).catch(() => {});
        fail('ASYNC_AUTHORIZER');
      }
      if (decision !== true) fail('CONTEXT_REVOKED');
    }
    return checked;
  }
  function receive(bytes) {
    try {
      live();
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      exact(envelope, ['v', 'channelId', 'seq', 'frame']);
      if (envelope.v !== 1 || envelope.channelId !== info.channelId) fail('CHANNEL_BINDING_MISMATCH');
      if (!Number.isSafeInteger(envelope.seq) || envelope.seq !== receiveSeq + 1) fail('REPLAY_DETECTED');
      const frame = checkedFrame(envelope.frame, true);
      (pairingReplay ?? replayGuard).accept(frame);
      receiveSeq = envelope.seq;
      if (!messages.size) fail('NO_CHANNEL_CONSUMER');
      for (const listener of [...messages]) {
        // Consumers must synchronously accept/reject or enqueue to their own
        // bounded coordinator, not accumulate unbounded promises in the channel.
        const result = listener(frame);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          fail('ASYNC_CHANNEL_CONSUMER');
        }
      }
    } catch (error) {
      close(error instanceof RemoteCryptoError ? error.code : (typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INVALID_CHANNEL_FRAME'));
    }
  }
  function data(chunk) {
    if (info.closed) return;
    let offset = 0;
    while (offset < chunk.length && !info.closed) {
      if (body === null) {
        const count = Math.min(4 - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + count);
        offset += count; headerUsed += count;
        if (headerUsed < 4) return;
        const size = header.readUInt32BE(0); headerUsed = 0;
        if (size < 1 || size > REMOTE_TLS.frameBytes) { close('FRAME_TOO_LARGE'); return; }
        body = Buffer.alloc(size); bodyUsed = 0;
      }
      const count = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + count);
      bodyUsed += count; offset += count;
      if (bodyUsed === body.length) {
        const complete = body; body = null; bodyUsed = 0;
        receive(complete); complete.fill(0);
      }
    }
  }
  const channel = Object.freeze({
    ready,
    get purpose() { return purpose; },
    get peerIdentity() { return info.peerIdentity; },
    get closed() { return info.closed; },
    onMessage(listener) {
      if (typeof listener !== 'function' || messages.size >= 8 || info.closed) fail('INVALID_CHANNEL_CONSUMER');
      messages.add(listener); return () => messages.delete(listener);
    },
    onClose(listener) {
      if (typeof listener !== 'function' || closes.size >= 8) fail('INVALID_CHANNEL_CONSUMER');
      if (info.closed) { listener(Object.freeze({ code: 'CHANNEL_CLOSED' })); return () => {}; }
      closes.add(listener); return () => closes.delete(listener);
    },
    async send(frame) {
      live();
      const checked = checkedFrame(frame, false);
      if (sendSeq >= Number.MAX_SAFE_INTEGER) fail('CHANNEL_EXHAUSTED');
      const bytes = Buffer.from(JSON.stringify({ v: 1, channelId: info.channelId, seq: sendSeq + 1, frame: checked }));
      if (bytes.length > REMOTE_TLS.frameBytes) { bytes.fill(0); fail('FRAME_TOO_LARGE'); }
      if (pendingWrites >= 128 || socket.writableLength + bytes.length + 4 > REMOTE_TLS.queueBytes) {
        bytes.fill(0); fail('CHANNEL_BACKPRESSURE');
      }
      const packet = Buffer.allocUnsafe(bytes.length + 4);
      packet.writeUInt32BE(bytes.length, 0); bytes.copy(packet, 4); bytes.fill(0);
      sendSeq++; pendingWrites++;
      await new Promise((resolve, reject) => {
        let settled = false;
        const complete = (error) => {
          if (settled) return;
          settled = true;
          pendingWrites--; packet.fill(0);
          if (error) reject(new RemoteCryptoError('CHANNEL_CLOSED'));
          else resolve(); // Transport flush, NOT a tablet execution receipt.
        };
        try { socket.write(packet, complete); }
        catch { complete(true); close('TLS_TRANSPORT_ERROR'); }
      });
    },
    // Orderly TLS close_notify after all queued writes. An abort uses close().
    finish() { if (!info.closed) socket.end(); },
    close() { close(); },
  });
  channelInfo.set(channel, info);
  const options = { secureContext, minVersion: REMOTE_TLS.version, maxVersion: REMOTE_TLS.version,
    // Self-signed device certificates use explicit SPKI trust instead of Web PKI.
    // OpenSSL still verifies CertificateVerify/key possession. No application
    // data is accepted before the pin and protocol checks below succeed.
    rejectUnauthorized: false, ALPNProtocols: [REMOTE_TLS.alpn] };
  function authenticated() {
    try {
      if (info.closed) return;
      if (socket.getProtocol() !== REMOTE_TLS.version || socket.getCipher()?.standardName !== REMOTE_TLS.cipher
        || socket.alpnProtocol !== REMOTE_TLS.alpn || socket.isSessionReused()) fail('UNSUPPORTED_TLS');
      const certificate = socket.getPeerCertificate();
      if (!certificate?.raw) fail('PEER_CERTIFICATE_REQUIRED');
      const peer = identityFromCertificate(certificate.raw, { now });
      if (samePublicPin(peer.spkiSha256, ownIdentity.spkiSha256)) fail('REFLECTED_IDENTITY');
      if (peerPin !== undefined && !samePublicPin(peer.spkiSha256, peerPin)) fail('PEER_PIN_MISMATCH');
      info.peerIdentity = peer;
      // RFC 8446 section 7.5 exporter: a binding identifier, never a new key
      // exchange or hand-built encryption key. It changes on every handshake.
      info.channelId = socket.exportKeyingMaterial(32, 'EXPORTER-CC-REMOTE-TLS-V1', Buffer.from(purpose)).toString('base64url');
      info.authenticated = true;
      socket.disableRenegotiation();
      clearTimeout(handshakeTimer);
      resolveReady(secureChannelInfo(channel));
    } catch (error) { close(error instanceof RemoteCryptoError ? error.code : 'TLS_AUTHENTICATION_FAILED'); }
  }
  try {
    if (role === 'client') {
      socket = tls.connect({ ...options, socket: transport, checkServerIdentity: () => undefined });
      socket.once('secureConnect', authenticated);
    } else {
      socket = new tls.TLSSocket(transport, { ...options, isServer: true, requestCert: true });
      socket.once('secure', authenticated);
    }
    socket.on('error', () => close('TLS_TRANSPORT_ERROR'));
    socket.once('close', () => close());
    socket.on('data', data);
    handshakeTimer = setTimeout(() => close('TLS_HANDSHAKE_TIMEOUT'), handshakeTimeoutMs); handshakeTimer.unref?.();
    ageTimer = setTimeout(() => close('CHANNEL_EXPIRED'), maxAgeMs); ageTimer.unref?.();
  } catch { close('TLS_TRANSPORT_ERROR'); }
  return channel;
}

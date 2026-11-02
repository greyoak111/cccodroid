// High-entropy out-of-band bootstrap of pinned TLS identities, NOT a new key
// exchange. TLS 1.3 performs all key exchange, authentication and encryption.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RemoteCryptoError, REMOTE_TLS, samePublicPin, secureChannelInfo } from './crypto.mjs';

const fail = (code) => { throw new RemoteCryptoError(code); };
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const textName = (value) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PAIRING');
};
const readSecret = (secret) => {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail('INVALID_PAIRING');
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) fail('INVALID_PAIRING');
  return bytes;
};
function publicIdentity(value) {
  exact(value, ['deviceId', 'spkiSha256', 'name']);
  readSecret(value.spkiSha256).fill(0);
  if (value.deviceId !== 'dev_' + value.spkiSha256 || !textName(value.name)) fail('INVALID_IDENTITY');
  return Object.freeze({ deviceId: value.deviceId, spkiSha256: value.spkiSha256, name: value.name });
}
const randomId = (prefix) => prefix + randomUUID();

/** Exported QR format deliberately has no relay URL: scan data must never
 * override the configured HTTPS/WSS endpoint or local gateway origin. The
 * secret is a short-lived bearer credential; do not log it or put it in a URL. */
export function validatePairingOffer(value, { now = Date.now } = {}) {
  exact(value, ['v', 'type', 'offerId', 'tablet', 'secret', 'issuedAt', 'expiresAt']);
  const current = now();
  if (!Number.isSafeInteger(current) || current < 0 || value.v !== 1 || value.type !== 'cc-remote-pairing'
    || !id(value.offerId) || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > REMOTE_TLS.pairingTtlMs
    || value.issuedAt > current + 5_000 || value.expiresAt <= current) fail('PAIRING_EXPIRED');
  readSecret(value.secret).fill(0);
  return Object.freeze({ v: 1, type: 'cc-remote-pairing', offerId: value.offerId,
    tablet: publicIdentity(value.tablet), secret: value.secret, issuedAt: value.issuedAt, expiresAt: value.expiresAt });
}

/** In-memory only. persistPairing receives *public* metadata after BOTH local
 * UI confirmations and a live pinned TLS exchange. This is not session consent.
 * Application code must call cancelPeer() before unpair and persist atomically
 * with the supplied guard. A successful local commit/send is not proof of an
 * atomic cross-device commit; peerPersisted is null unless observed on the wire.
 * A relay, browser, or model tool must never invoke confirm() on the user's
 * behalf; expose it only through the existing authenticated local UI boundary. */
export function createPairingManager({ identity, persistPairing, now = Date.now,
  maxOffers = 4, maxAttempts = 8, maxPending = 16, rateWindowMs = 60_000 } = {}) {
  const own = publicIdentity(identity);
  if (typeof persistPairing !== 'function' || [maxOffers, maxAttempts, maxPending].some((n) => !Number.isSafeInteger(n) || n < 1 || n > 64)
    || !Number.isSafeInteger(rateWindowMs) || rateWindowMs < 1 || rateWindowMs > REMOTE_TLS.pairingTtlMs) fail('INVALID_PAIRING_OPTIONS');
  const offers = new Map(), attempts = new Map(), attached = new Map();
  let closed = false, attemptsInWindow = 0, windowStarted = now();
  const current = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK');
    return value;
  };
  const snapshot = (attempt) => Object.freeze({ attemptId: attempt.attemptId, offerId: attempt.offerId,
    role: attempt.role, peer: attempt.peer, expiresAt: attempt.expiresAt, state: attempt.state,
    localConfirmed: attempt.localConfirmed, peerConfirmed: attempt.peerConfirmed,
    persisted: attempt.persisted, peerPersisted: attempt.peerPersisted, errorCode: attempt.errorCode });
  function destroySecret(offer) { offer.secret.fill(0); }
  function detach(channel) {
    const subscriptions = attached.get(channel);
    if (subscriptions) { subscriptions.forEach((unsubscribe) => unsubscribe()); attached.delete(channel); }
  }
  function abort(attempt, code = 'PAIRING_ABORTED', closeChannel = true, invalidateComplete = false) {
    if ((attempt.state === 'complete' && !invalidateComplete) || attempt.state === 'rejected') return;
    attempt.state = 'rejected'; attempt.errorCode = code;
    attempt.cancellation.abort();
    if (closeChannel) attempt.channel.close();
    detach(attempt.channel);
  }
  function cleanup() {
    const value = current();
    for (const [key, offer] of offers) if (offer.expiresAt <= value) {
      destroySecret(offer); offers.delete(key);
    }
    for (const attempt of attempts.values()) if (attempt.expiresAt <= value && !['complete', 'rejected'].includes(attempt.state)) abort(attempt, 'PAIRING_EXPIRED');
    if (value - windowStarted >= rateWindowMs) { attemptsInWindow = 0; windowStarted = value; }
  }
  function live() { if (closed) fail('PAIRING_MANAGER_CLOSED'); cleanup(); }
  function rateLimit() {
    if (++attemptsInWindow > maxAttempts) fail('PAIRING_RATE_LIMIT');
  }
  function ensureRoom() {
    // A cancelled callback may still hold an unresolved vault/file operation.
    // Keep it within maxPending until settled; never hide pending work by merely
    // discarding its rejected metadata and accepting unlimited replacements.
    for (const [key, attempt] of attempts) if (['complete', 'rejected'].includes(attempt.state) && !attempt.commitPending) attempts.delete(key);
    if (attempts.size >= maxPending) fail('PAIRING_LIMIT');
  }
  function channelIdentity(channel, role) {
    const info = secureChannelInfo(channel);
    if (info.purpose !== 'pairing' || info.role !== role || !samePublicPin(info.localIdentity.spkiSha256, own.spkiSha256)) fail('INVALID_PAIRING_CHANNEL');
    return info;
  }
  function frame(attempt, type, extra = {}) {
    const issuedAt = current();
    return Object.freeze({ v: 1, type, messageId: randomId('msg_'), fromDeviceId: own.deviceId,
      toDeviceId: attempt.peer.deviceId, issuedAt, expiresAt: attempt.expiresAt,
      payload: Object.freeze({ offerId: attempt.offerId, attemptId: attempt.attemptId, ...extra }) });
  }
  function send(attempt, type, extra) {
    return attempt.channel.send(frame(attempt, type, extra)).catch((error) => {
      abort(attempt, 'PAIRING_TRANSPORT_FAILED'); throw error;
    });
  }
  async function persist(attempt) {
    if (attempt.persisted || attempt.committing) return attempt.committing;
    if (!attempt.localConfirmed || !attempt.peerConfirmed) fail('BOTH_CONFIRMATIONS_REQUIRED');
    if (attempt.state === 'rejected' || attempt.cancellation.signal.aborted) fail('PAIRING_ABORTED');
    const info = secureChannelInfo(attempt.channel);
    if (info.channelId !== attempt.channelId || current() >= attempt.expiresAt || closed) fail('PAIRING_EXPIRED');
    const publicRecord = Object.freeze({ v: 1, pairingId: attempt.offerId, localDevice: own, peerDevice: attempt.peer,
      confirmedAt: current(), expiresAt: attempt.expiresAt });
    attempt.state = 'committing';
    const isCurrent = () => !closed && attempt.state !== 'rejected' && !attempt.cancellation.signal.aborted
      && current() < attempt.expiresAt;
    attempt.commitPending = true;
    attempt.committing = (async () => {
      try {
        // The store must check isCurrent() while holding the SAME local lock/epoch
        // as unpair/revoke, immediately before publishing its atomic record. A
        // cancellation signal is advisory; it cannot undo a completed fs write.
        await persistPairing(publicRecord, Object.freeze({ signal: attempt.cancellation.signal, isCurrent }));
        if (!isCurrent()) fail('PAIRING_PERSISTENCE_RACE');
        attempt.persisted = true;
      } finally { attempt.commitPending = false; }
    })();
    return attempt.committing;
  }
  function finishTablet(attempt) {
    if (closed || attempt.state === 'rejected' || attempt.cancellation.signal.aborted
      || !attempt.localConfirmed || !attempt.peerConfirmed || attempt.committing) return;
    // This promise is deliberately supervised, never returned from a TLS data
    // callback (which must remain synchronous and bounded). complete means this
    // endpoint finished; sending pair.complete cannot prove the phone persisted.
    persist(attempt).then(() => {
      if (attempt.state === 'rejected' || attempt.cancellation.signal.aborted) fail('PAIRING_ABORTED');
      return send(attempt, 'pair.complete');
    }).then(() => {
      if (attempt.state !== 'rejected') { attempt.state = 'complete'; detach(attempt.channel); attempt.channel.finish(); }
    }).catch(() => abort(attempt, 'PAIRING_PERSISTENCE_FAILED'));
  }
  function existing(attempt, incoming) {
    if (incoming.payload.offerId !== attempt.offerId || incoming.payload.attemptId !== attempt.attemptId
      || incoming.fromDeviceId !== attempt.peer.deviceId || incoming.expiresAt > attempt.expiresAt) fail('PAIRING_CONTEXT_MISMATCH');
    if (['complete', 'rejected'].includes(attempt.state) || current() >= attempt.expiresAt) fail('PAIRING_EXPIRED');
  }
  function receive(attempt, incoming) {
    try {
      live(); existing(attempt, incoming);
      if (incoming.type === 'pair.abort') { abort(attempt); return; }
      if (attempt.role === 'phone') {
        if (incoming.type === 'pair.challenge' && attempt.state === 'claiming') {
          if (incoming.payload.name !== attempt.peer.name) fail('PAIRING_CONTEXT_MISMATCH');
          attempt.state = 'pending-confirmation';
        } else if (incoming.type === 'pair.confirm' && attempt.state !== 'claiming' && !attempt.peerConfirmed) {
          attempt.peerConfirmed = true;
        } else if (incoming.type === 'pair.complete' && attempt.localConfirmed && attempt.peerConfirmed && !attempt.committing) {
          // Tablet sends this only after its own durable callback. It is evidence
          // of that commit, not an acknowledgement of the phone's future commit.
          attempt.peerPersisted = true;
          persist(attempt).then(() => {
            if (attempt.state !== 'rejected') { attempt.state = 'complete'; detach(attempt.channel); attempt.channel.finish(); }
          }).catch(() => abort(attempt, 'PAIRING_PERSISTENCE_FAILED'));
        } else fail('INVALID_PAIRING_TRANSITION');
      } else if (incoming.type === 'pair.confirm' && !attempt.peerConfirmed) {
        attempt.peerConfirmed = true; finishTablet(attempt);
      } else fail('INVALID_PAIRING_TRANSITION');
    } catch (error) { abort(attempt, error instanceof RemoteCryptoError ? error.code : 'INVALID_PAIRING'); }
  }
  function attach(attempt) {
    const unMessage = attempt.channel.onMessage((incoming) => receive(attempt, incoming));
    const unClose = attempt.channel.onClose(() => {
      // A phone that already received authenticated pair.complete may finish
      // its local commit after bootstrap close. A tablet may finish an already
      // committed send, but a pending tablet write loses its commit guard.
      if (!['complete', 'rejected'].includes(attempt.state)
        && !(attempt.state === 'committing' && (attempt.persisted
          || attempt.role === 'phone' && attempt.peerPersisted === true))) {
        abort(attempt, 'PAIRING_DISCONNECTED', false);
      }
      detach(attempt.channel);
    });
    attached.set(attempt.channel, [unMessage, unClose]);
  }
  return Object.freeze({
    createOffer({ ttlMs = REMOTE_TLS.pairingTtlMs } = {}) {
      live();
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > REMOTE_TLS.pairingTtlMs) fail('INVALID_PAIRING_TTL');
      if (offers.size >= maxOffers) fail('PAIRING_LIMIT');
      const issuedAt = current(), offerId = randomId('pair_'), secret = randomBytes(32);
      offers.set(offerId, { offerId, secret, expiresAt: issuedAt + ttlMs });
      return Object.freeze({ v: 1, type: 'cc-remote-pairing', offerId, tablet: own,
        secret: secret.toString('base64url'), issuedAt, expiresAt: issuedAt + ttlMs });
    },
    cancelOffer(offerId) {
      live(); const offer = offers.get(offerId);
      if (offer) { destroySecret(offer); offers.delete(offerId); }
      for (const attempt of attempts.values()) if (attempt.offerId === offerId) abort(attempt);
    },
    cancelPeer(deviceId) {
      // Synchronous unpair barrier, including an attempt that has not called
      // persistPairing yet. No persistent/unbounded per-device tombstones.
      if (!id(deviceId)) fail('INVALID_IDENTITY');
      for (const attempt of attempts.values()) if (attempt.peer.deviceId === deviceId) {
        abort(attempt, 'PAIRING_UNPAIRED', true, true);
      }
      // Incoming channels have not consumed an offer yet but already have a TLS
      // peer identity. Close those too so an old tunnel cannot claim afterwards.
      for (const channel of attached.keys()) {
        let matches = true;
        try { matches = secureChannelInfo(channel).peerIdentity.deviceId === deviceId; } catch {}
        if (matches) { detach(channel); channel.close(); }
      }
    },
    attachIncoming(channel) {
      live(); rateLimit();
      const info = channelIdentity(channel, 'server');
      if (attached.size >= maxPending || attached.has(channel)) fail('PAIRING_LIMIT');
      const unMessage = channel.onMessage((incoming) => {
        let attempt;
        try {
          live();
          if (incoming.type !== 'pair.claim') fail('INVALID_PAIRING_TRANSITION');
          const offer = offers.get(incoming.payload.offerId);
          const supplied = readSecret(incoming.payload.secret);
          let matches;
          try { matches = timingSafeEqual(supplied, offer?.secret ?? Buffer.alloc(32)); }
          finally { supplied.fill(0); }
          if (!offer || !matches || offer.expiresAt <= current() || incoming.expiresAt > offer.expiresAt) fail('PAIRING_INVALID_CLAIM');
          // Consume BEFORE any async send/persist or user prompt. A second phone
          // can never win the same offer, even while the first prompt is open.
          destroySecret(offer); offers.delete(offer.offerId);
          ensureRoom();
          if (attempts.has(incoming.payload.attemptId)) fail('PAIRING_CONTEXT_MISMATCH');
          attempt = { role: 'tablet', attemptId: incoming.payload.attemptId, offerId: offer.offerId,
            peer: publicIdentity({ ...info.peerIdentity, name: incoming.payload.name }),
            channel, channelId: info.channelId, expiresAt: Math.min(incoming.expiresAt, offer.expiresAt),
            state: 'pending-confirmation', localConfirmed: false, peerConfirmed: false, persisted: false,
            peerPersisted: null, committing: null, commitPending: false, errorCode: null, cancellation: new AbortController() };
          attempts.set(attempt.attemptId, attempt);
          detach(channel); attach(attempt);
          send(attempt, 'pair.challenge', { name: own.name }).catch(() => {});
        } catch (error) {
          if (attempt) abort(attempt, 'PAIRING_INVALID_CLAIM');
          else { detach(channel); channel.close(); }
        }
      });
      const unClose = channel.onClose(() => detach(channel));
      attached.set(channel, [unMessage, unClose]);
      return info.peerIdentity;
    },
    acceptOffer(offerValue, channel) {
      live(); rateLimit(); ensureRoom();
      const offer = validatePairingOffer(offerValue, { now });
      const info = channelIdentity(channel, 'client');
      if (!samePublicPin(info.peerIdentity.spkiSha256, offer.tablet.spkiSha256) || attached.has(channel)) fail('PAIRING_CONTEXT_MISMATCH');
      const attempt = { role: 'phone', attemptId: randomId('attempt_'), offerId: offer.offerId,
        peer: offer.tablet, channel, channelId: info.channelId, expiresAt: offer.expiresAt,
        state: 'claiming', localConfirmed: false, peerConfirmed: false, persisted: false, peerPersisted: null,
        committing: null, commitPending: false, errorCode: null, cancellation: new AbortController() };
      attempts.set(attempt.attemptId, attempt); attach(attempt);
      send(attempt, 'pair.claim', { secret: offer.secret, name: own.name }).catch(() => {});
      return attempt.attemptId;
    },
    listPending() { live(); return Object.freeze([...attempts.values()].map(snapshot)); },
    async confirm(attemptId, expectedPeerPin) {
      live();
      const attempt = attempts.get(attemptId);
      if (!attempt || !['pending-confirmation'].includes(attempt.state)
        || attempt.localConfirmed || !samePublicPin(attempt.peer.spkiSha256, expectedPeerPin)) fail('INVALID_PAIRING_CONFIRMATION');
      const info = secureChannelInfo(attempt.channel);
      if (info.channelId !== attempt.channelId) fail('PAIRING_CONTEXT_MISMATCH');
      attempt.localConfirmed = true;
      await send(attempt, 'pair.confirm');
      // A local flush may settle after unpair/cancel/close. It must not restart
      // persistence or be reported as a successful local confirmation then.
      live();
      if (attempt.state === 'rejected' || attempt.cancellation.signal.aborted) fail('PAIRING_ABORTED');
      if (attempt.role === 'tablet') finishTablet(attempt);
      return snapshot(attempt);
    },
    reject(attemptId) {
      live(); const attempt = attempts.get(attemptId);
      if (!attempt) fail('INVALID_PAIRING');
      // No need to await or leak a local rejection reason to the relay.
      if (!['complete', 'rejected'].includes(attempt.state)) send(attempt, 'pair.abort').catch(() => {});
      abort(attempt);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const offer of offers.values()) destroySecret(offer);
      offers.clear();
      for (const attempt of attempts.values()) abort(attempt, 'PAIRING_MANAGER_CLOSED');
      for (const channel of attached.keys()) { detach(channel); channel.close(); }
    },
  });
}

# Remote identity, pairing and end-to-end TLS

This describes source in the independent development clone, not a deployed service. Tests use newly generated fake keys, an isolated HOME, and synthetic devices. No installed app, production key, session, project or model was accessed.

## Mature construction and provenance

The authenticated key exchange and encrypted record protocol is **TLS 1.3 (RFC 8446), implemented by Node's built-in `node:tls` / OpenSSL**, not a newly composed ECDH/HKDF/AEAD protocol. `crypto.mjs` restricts it to:

- TLS 1.3 only; no TLS 1.2 fallback, externally supplied sessions, session resumption or 0-RTT.
- ECDHE P-256 (`prime256v1`), ECDSA P-256/SHA-256 certificate proof, `TLS_AES_128_GCM_SHA256`.
- Mutual certificate possession, explicit SHA-256 SPKI pins, and mandatory ALPN `cc-remote/1`.
- TLS exporter binding per RFC 8446 §7.5, label `EXPORTER-CC-REMOTE-TLS-V1`, with separate `session` / `pairing` contexts. This is a connection identifier, **not a hand-built encryption key**.

No third-party cryptographic source, npm package, global dependency or private fork was added. The implementation uses platform Node/OpenSSL, not vendored code. The environment actually tested was Node `v26.12.1`, embedded OpenSSL `3.6.5`, and the existing OpenSSL command-line binary. The CLI is used only for standard self-signed X.509 certificate creation, not for application encryption. RFC 8446: <https://www.rfc-editor.org/rfc/rfc8446>; Node TLS documentation: <https://nodejs.org/api/tls.html>.

This is verification of that existing maintained implementation and its local behavior, **not an independent cryptographic audit of the new integration**. No unchecked third-party library is claimed as an audited security gate.

## Two TLS layers, not relay encryption

Both devices establish the normal externally authenticated HTTPS/WSS relay connection. Within a relay's ordered, opaque, bounded `Duplex` byte tunnel, they establish this second TLS connection **directly to each other**. The relay must forward bytes without terminating the inner TLS, parsing TLS application records, rewriting records or storing/replaying records while a device is offline.

The relay sees connection IDs, peer routing, timing and sizes. It does not see application plaintext. It can drop, throttle or disconnect traffic; encryption cannot prevent denial of service. Optional offline notifications are metadata-only wake hints. They are not cached TLS records, approval requests or execution receipts. After reconnect, perform a fresh TLS handshake and resynchronize live tablet authority.

`rejectUnauthorized: false` inside the **inner** TLS is intentional: device certificates are self-signed and trust comes from the explicitly confirmed SPKI pin, not a public CA. The code requires a peer certificate and verifies its pin, validity, P-256 key, TLS version/cipher, ALPN and non-reflection before resolving `ready` or accepting application data. TLS CertificateVerify proves possession of the private key. This is **not** permission to ignore certificate failures on outer HTTPS/WSS.

## Public identity and wrapped private credentials

`identityFromCertificate(cert, { now? })` returns a frozen public object:

```js
{ deviceId: 'dev_' + base64url(sha256(SPKI_DER)), spkiSha256 }
```

The display name is not identity. Pairing pins must come from the confirmed local pairing store, never from an incoming application's `fromDeviceId`, the relay's metadata, a page's proposed pin or a session title. Changing the key changes the device ID and requires pairing again.

`identity.mjs` exports `IDENTITY_LIMITS` and:

```js
await loadOrCreateIdentity({
  file,                    // explicit absolute path; parent already private 0700
  secretProtector,         // hostAdapter.secretProtector, not a frontend object
  recordId: 'device-identity',
  name: 'CC device',
  opensslPath: 'openssl',   // prefer the app's trusted absolute executable path
  now: Date.now,
  processTimeoutMs: 10000,
  // spawnProcess: spawn   // injectable only by trusted backend/test code
})
// => { identity: { deviceId, spkiSha256, name },
//      credentials: { key: KeyObject, cert: Buffer }, dispose() }
```

The private TLS identity is a **software P-256 key**, generated using `node:crypto` CSPRNG. It is exported transiently as PKCS8 DER in trusted Node memory and transferred over process stdin for certificate generation; Node TLS also temporarily exports PKCS8 PEM while initializing its OpenSSL context. **It is not true that this identity key was never exported.** Only the Android Keystore AES wrapping master is non-exportable; hardware backing is device-dependent and unverified. KeyObject/OpenSSL/JS GC cannot guarantee deterministic erasure of every memory copy.

The host interface is the exact 09 contract:

```js
await secretProtector.seal('identity-v1', recordId, Uint8Array)
// => { v: 1, nonce: canonicalBase64, ciphertext: canonicalBase64 }
await secretProtector.open('identity-v1', recordId, envelope)
// => Buffer
```

The host AES-GCM AAD binds `cc.codroid/remote/vault/v1\n${purpose}\n${recordId}`; the plaintext limit is 24 KiB. `identity.mjs` uses a compact length-delimited binary record to avoid an immutable base64 private-key JSON string. Only the host-sealed envelope is written to disk. It validates certificate/key agreement, validity and self-signature before accepting a record.

The file must be a regular owner-only 0600 file, not a symlink or FIFO; its parent must be an owned 0700 directory. Reads use nonblocking/no-follow open and a fixed 40 KiB plus one-byte buffer, so FIFO substitution cannot hang before fstat and growth after stat cannot turn read-to-EOF into unbounded allocation. Read size, decrypted size and subprocess output are bounded. New ciphertext is fsynced in a 0600 temporary file, then published using exclusive reservation and rename. Existing damaged, expired, inaccessible, wrong-AAD or undecryptable identities **never silently regenerate**. Missing/unavailable host vault means fail closed; no plaintext fallback. Call `dispose()` after synchronously constructing a TLS channel; it drops the caller's key reference and clears its cert buffer. The TLS context keeps the software key for the connection lifetime.

Two actual Android compatibility problems were reproduced with fake keys and resolved without plaintext temporary keys:

1. Node subprocess stdin is a socketpair; `openssl req -key /dev/stdin` tries to reopen it and fails `ENXIO`. The fixed certificate pipeline is `"$1" pkey -inform DER -outform DER | exec "$1" req ... -key /dev/stdin ...`. `pkey` reads fd 0 directly and the second process reads a real anonymous pipe. Only the trusted executable path is passed as quoted positional parameter, never shell source; the script is constant, contains no user input and has no model/tool capability.
2. Android app SELinux rejected hard links (`EACCES`). Exclusive 0600 reservation plus sealed-file rename replaces hard-link publication. A crash between reservation and rename leaves an empty record which fails closed and requires explicit local recovery, not a new unannounced identity. A second concurrent process may get a temporary load failure and retry after initialization.

The OpenSSL process group has a 10-second default timeout, combined stdout/stderr cap 12 KiB and certificate cap 8 KiB. It inherits only PATH, private HOME, LANG and `OPENSSL_CONF=/dev/null`; it receives no model tokens, loader flags, command-line private key or plaintext filename. Diagnostics are not logged or returned. Returned credentials/protector/host capability must never be exposed by HTTP, WebView, localStorage, model tools or logs. The protected record file is an implementation detail, not a downloadable resource. Protect against generic gateway file APIs and ordinary model read access during integration; same-UID code compromise cannot be solved by JavaScript alone.

## Channel API

Exports in `crypto.mjs` are `REMOTE_TLS`, `RemoteCryptoError`, `identityFromCertificate`, `samePublicPin`, `createReplayGuard`, `createSecureChannel`, `createPairingChannel`, `secureChannelInfo`.

```js
const channel = createSecureChannel({
  role: 'client',           // tablet normally server, phone normally client
  transport,               // ordered opaque Duplex, not a decrypted relay API
  credentials,             // trusted loadOrCreateIdentity result
  peerPin,                 // confirmed local store's SHA-256 SPKI pin
  replayGuard,             // shared across reconnects in this host lifecycle
  context: { hostInstanceId, remoteSessionId, grantVersion },
  now: Date.now,
  authorizeFrame(frame, { incoming }) { return true; }, // optional in fixed mode
  handshakeTimeoutMs: 10000,
  maxAgeMs: 3600000
});
const unsubscribe = channel.onMessage(frame => { /* synchronously enqueue */ });
channel.onClose(({ code }) => { /* disable controls, resync on reconnect */ });
await channel.ready;
await channel.send(frame); // transport write ONLY, never an execution receipt
channel.finish();          // orderly TLS close_notify after queued writes
// or channel.close()       // abort immediately
```

In fixed-session mode all frames must match the authenticated certificate's from/to identities and fixed host/session/grant. In **peer mode**, omit `context` and supply mandatory `authorizeFrame`. This permits a paired connection to carry invitations and multiple separately authorized session handles. Every frame still passes strict v1 `validateFrame` and authenticated from/to checks. `authorizeFrame` must synchronously return the Boolean `true` for each sent/received frame. Truthy values, promises and absence of the authorizer fail closed. Receiving an unauthorized frame closes the connection. It is the coordinator's responsibility to whitelist invitation pre-grant state and atomically check live grant/run/request/revocation policy; knowing a device pin does not grant any session.

The TLS-protected application envelope is `{v, channelId, seq, frame}` with a 4-byte big-endian byte length. The framing limit including this wrapper is 64 KiB, so a protocol frame exactly at the protocol-only limit may be too large for the secure wrapper. Sequence numbers are strictly consecutive per direction, exporter binding changes every handshake, and the checked frame is deeply immutable. All routing context, run/command/message IDs, payload and lifetime are encrypted/authenticated by TLS, not unauthenticated relay routing. The relay must not use clear metadata as approval authority.

TLS rejects wire modification, duplicated/reordered records, or old-handshake records. `createReplayGuard({now?,maxEntries?})` additionally rejects repeated `(fromDeviceId,messageId)` after reconnect; its map never evicts unexpired entries to accept more traffic. Keep one guard per host lifecycle; default 8192, maximum 65536. A full guard stops traffic until entries expire; it does not claim persistence. A restart must rotate `hostInstanceId` and resynchronize grants. Stable commandId deduplication and crash/unknown execution handling belong to the tablet command ledger, not TLS. A retry must use a fresh transport messageId while preserving commandId.

Data readers allocate at most one bounded frame. Pending sends have both a 512 KiB limit and 128-write limit; excess is rejected, not silently queued. The relay transport must independently apply bounded buffering/backpressure. Consumers must synchronously validate/enqueue into their own bounded coordinator; returning async work from `onMessage` is rejected. Register consumers before application traffic, and never block them doing history or disk work. TLS control-priority scheduling, chunking oversized protocol histories and UI resync are separate coordinator/relay concerns.

`secureChannelInfo(channel)` only accepts authenticated, live channels made by this module (WeakMap brand), returning public role/purpose/identities/channelId. A fake object declaring `purpose:'pairing'` is not TLS authentication.

## One-time pairing

`pairing.mjs` exports `validatePairingOffer` and `createPairingManager`.

```js
const manager = createPairingManager({
  identity: { deviceId, spkiSha256, name },
  async persistPairing(publicRecord, { signal, isCurrent }) {
    // serialize with local unpair/revoke; recheck isCurrent() immediately
    // before atomic commit while holding that same local epoch/lock
  },
  now: Date.now, maxOffers: 4, maxAttempts: 8, maxPending: 16,
  rateWindowMs: 60000
});
const qr = manager.createOffer({ ttlMs: 300000 });
// tablet: await pairingChannel.ready; manager.attachIncoming(pairingChannel)
// phone: validate QR locally; createPairingChannel({role:'client',peerPin:qr.tablet.spkiSha256,...})
const attemptId = manager.acceptOffer(qr, pairingChannel);
manager.listPending(); // public metadata only, never QR secret
await manager.confirm(attemptId, displayedPeerPin); // explicit local UI action
manager.reject(attemptId);
manager.cancelOffer(qr.offerId);
manager.close();
```

Offer format is exact v1 `{v,type:'cc-remote-pairing',offerId,tablet,secret,issuedAt,expiresAt}`. The secret is 32 random bytes / 256 bits in canonical base64url, TTL at most five minutes, with no relay URL or local path. The authenticated local UI may display it as QR or high-entropy manual code for direct transfer to the other device. Never use URL query strings, analytics, logs, localStorage or a six-digit long-term secret. The QR is a sensitive, short-lived bearer invitation; an observer who steals it can attempt a claim. Rate limits are not a substitute for entropy or user confirmation.

The phone pins the tablet key from the out-of-band QR before sending its secret. The tablet presents its certificate and requests a client certificate but initially permits an unknown client key **only in a purpose-separated pairing channel**. That channel accepts strictly shaped `pair.claim`, `pair.challenge`, `pair.confirm`, `pair.complete`, `pair.abort`; session/control frames are rejected. A valid claim compares the secret in constant time and consumes the offer *synchronously before* sending a challenge or prompting the user. The first valid claimant burns it, even if subsequently rejected. Another device, repeated offer, wrong secret, expired invitation or invalid state cannot pair. Pending offers/attempts/channels are bounded and new attempts are rate-limited (default eight per minute, global per manager).

The phone must explicitly confirm the tablet and the tablet must explicitly confirm the phone. `acceptOffer()` immediately returns an attempt in `claiming`; **it is not yet confirmable** until the authenticated `pair.challenge` changes it to `pending-confirmation`. A local TLS/relay write callback does not mean the other endpoint has processed the challenge. Runtime/UI must preserve this readiness distinction (or wait for the challenge before returning a confirmable card), and must not submit relay pairing votes if the local confirmation failed. A delayed-network regression covers this boundary. Confirmations are tied to the attempt, authenticated identities, pinned TLS channel and original expiry. Only after both confirmations can `persistPairing` run. Stores receive only public identities, confirmation time and pairing ID, never the QR secret or private key. Pairing is not a hosted-session grant or tool approval. The accepted bootstrap stream closes; later sessions require a fresh mutually pinned channel with live session authorization.

Unpair/revoke and asynchronous persistence must share the coordinator's local epoch/lock; `signal` and `isCurrent()` support that boundary but cannot undo a completed write. Pairing is **not a distributed atomic commit**. A network/storage failure may leave one device with a confirmed public pair while the other does not; display incomplete pairing and allow explicit repair/unpair rather than pretending both stores committed. No session permission is created by this state. The implementation does not prove that a UI action came from a human; the existing local access/user-action boundary must enforce that.

## Verification and remaining gates

Run from the independent clone (the runner strips live CCAPP variables and sets a synthetic HOME):

```sh
node scripts/test.mjs remote-identity remote-crypto remote-host remote-protocol
```

The following list describes test scenarios, not a passing result for this
branch. Current assertions, whole-feature regression and native acceptance have
not run on the public integration branch; earlier development counts and logs do
not verify the subsequent review fixes. See
[the current acceptance record](REMOTE-REVIEW-ACCEPTANCE.zh-CN.md). The scenarios
include:

- Actual TLS 1.3 handshake over a fake byte relay, KeyObject-loaded credentials disposed by the caller before handshake completion, ciphertext opacity, SPKI pins and reflected/substituted identities.
- AEAD bit changes, record replay/ordering, cross-handshake records, source/destination/session/grant/host binding, live run/revocation, on-arrival expiry, bounded writes and cross-connection messageId guard.
- Peer-mode multi-session authorization, strict synchronous Boolean policy, and current invitation/accept/decline/correlation/background-notice schema transport.
- 256-bit one-use invitations, positive and reversed local-confirmation order, wrong pin/secret, cancellation/expiry, one claimant, fake-channel rejection, bounded attempts, persistence failure and no premature trust.
- Real `host-adapter.mjs` seal/open interface with an isolated fake AES backend: generated/reloaded P-256 identity, encrypted-only 0600 storage, AAD/master/ciphertext mismatch, corrupt/expired records, permissions/symlinks/limits, subprocess errors/output cap/timeout, no plaintext key files/argv/env, no unavailable-vault fallback.

Not yet established by these tests: independent review of the integration; actual Android Keystore availability/hardware backing/invalidation; all supported Android/Node/OpenSSL versions; real 03 WSS tunnel plus lifecycle/reconnect on two devices; model/tool access isolation for protected records; true lock-screen/network-change notification acceptance; durable runtime grant/command journals; distributed pairing recovery UX; certificate renewal (currently expiry fails closed after one year); or production deployment security. No installation, service restart, cloud deployment, real-model call or commit/push was performed. These are real remaining gates, not silently waived by choosing mature TLS.

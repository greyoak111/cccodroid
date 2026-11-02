import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSecureChannel, createPairingChannel, identityFromCertificate, createReplayGuard,
  secureChannelInfo, samePublicPin, REMOTE_TLS } from '../gw/remote/crypto.mjs';
import { createPairingManager, validatePairingOffer } from '../gw/remote/pairing.mjs';
import { createRemoteStore } from '../gw/remote/store.mjs';
import { createFrame } from '../gw/remote/protocol.mjs';

// The repository runner supplies a fake HOME, and every key in this test is
// freshly generated here. Never discover installed certificates or identities.
assert.equal(process.env.CCAPP_TEST, '1', 'Use node scripts/test.mjs remote-crypto');
const tmp = fs.mkdtempSync(path.join(os.homedir(), 'fake-remote-crypto-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function credentials(label) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const keyPath = path.join(tmp, label + '.key');
  const certPath = path.join(tmp, label + '.crt');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  const result = spawnSync('openssl', ['req', '-new', '-x509', '-sha256', '-key', keyPath,
    '-out', certPath, '-days', '2', '-subj', '/CN=FAKE-TEST-' + label, '-config', '/dev/null'],
  { encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: '/dev/null' }, timeout: 10_000 });
  assert.equal(result.status, 0, 'OpenSSL test certificate fixture failed (no real certificate read)');
  return { key, cert: fs.readFileSync(certPath) };
}
const tabletCredentials = credentials('tablet');
const phoneCredentials = credentials('phone');
const attackerCredentials = credentials('attacker');
const tablet = Object.freeze({ ...identityFromCertificate(tabletCredentials.cert), name: 'Fake Tablet' });
const phone = Object.freeze({ ...identityFromCertificate(phoneCredentials.cert), name: 'Fake Phone' });
const attacker = Object.freeze({ ...identityFromCertificate(attackerCredentials.cert), name: 'Fake Attacker' });
const context = Object.freeze({ hostInstanceId: 'host-test-lifecycle', remoteSessionId: 'remote-test-session', grantVersion: 1 });
const delay = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, message = 'condition', timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
function relay() {
  const wire = [], endpoints = [];
  let transform = null, fragment = 0, destroyed = false;
  for (let side = 0; side < 2; side++) endpoints.push(new Duplex({
    read() {},
    write(bytes, encoding, callback) {
      if (destroyed) { callback(new Error('fake relay closed')); return; }
      let copied = Buffer.from(bytes);
      wire.push(Buffer.from(copied));
      try { if (transform) copied = transform(side, copied); }
      catch (error) { callback(error); return; }
      const peer = endpoints[1 - side];
      if (copied && copied.length) {
        if (fragment) for (let start = 0; start < copied.length; start += fragment) peer.push(Buffer.from(copied.subarray(start, start + fragment)));
        else peer.push(copied);
      }
      callback();
    },
    destroy(error, callback) {
      if (!destroyed) { destroyed = true; setImmediate(() => endpoints[1 - side].destroy()); }
      callback(error);
    },
  }));
  return { client: endpoints[0], server: endpoints[1], wire,
    set transform(fn) { transform = fn; }, set fragment(size) { fragment = size; },
    close() { endpoints.forEach((endpoint) => endpoint.destroy()); } };
}
async function channels({ pairing = false, clientPin = tablet.spkiSha256, serverPin = pairing ? undefined : phone.spkiSha256,
  clientCreds = phoneCredentials, now = Date.now, replayGuard = createReplayGuard({ now }),
  authorizeFrame, contextValue = context } = {}) {
  const tunnel = relay();
  const create = pairing ? createPairingChannel : createSecureChannel;
  const server = create({ role: 'server', transport: tunnel.server, credentials: tabletCredentials,
    peerPin: serverPin, context: contextValue, replayGuard, now, authorizeFrame });
  const client = create({ role: 'client', transport: tunnel.client, credentials: clientCreds,
    peerPin: clientPin, context: contextValue, replayGuard: createReplayGuard({ now }), now });
  try { await Promise.all([server.ready, client.ready]); }
  catch (error) { server.close(); client.close(); throw error; }
  return { tunnel, server, client, close() { server.close(); client.close(); } };
}
function message({ text = 'FAKE SECRET TEXT', now = Date.now, ...overrides } = {}) {
  return createFrame('message.submit', { fromDeviceId: phone.deviceId, toDeviceId: tablet.deviceId,
    ...context, runId: 'run-fake' }, { text }, { now, commandId: 'command-fake', ...overrides });
}
function pairClaim(offer, info, { secret = offer.secret, attemptId = 'attempt-manual', type = 'pair.claim' } = {}) {
  return { v: 1, type, messageId: 'msg-' + randomBytes(16).toString('hex'),
    fromDeviceId: info.localIdentity.deviceId, toDeviceId: info.peerIdentity.deviceId,
    issuedAt: Date.now(), expiresAt: offer.expiresAt,
    payload: { offerId: offer.offerId, attemptId, secret, name: 'Fake Phone' } };
}
function managers({ now = Date.now, persistTablet, persistPhone, ...options } = {}) {
  const tabletRecords = [], phoneRecords = [];
  const tabletManager = createPairingManager({ identity: tablet, now,
    persistPairing: persistTablet ?? (async (record) => tabletRecords.push(record)), ...options });
  const phoneManager = createPairingManager({ identity: phone, now,
    persistPairing: persistPhone ?? (async (record) => phoneRecords.push(record)), ...options });
  return { tabletManager, phoneManager, tabletRecords, phoneRecords,
    close() { tabletManager.close(); phoneManager.close(); } };
}
async function pairingSetup(options) {
  const pair = managers(options);
  const offer = pair.tabletManager.createOffer();
  const ch = await channels({ pairing: true, serverPin: undefined });
  pair.tabletManager.attachIncoming(ch.server);
  const attemptId = pair.phoneManager.acceptOffer(offer, ch.client);
  await until(() => pair.phoneManager.listPending().some((entry) => entry.state === 'pending-confirmation'), 'pair challenge');
  return { ...pair, ...ch, offer, attemptId, close() { ch.close(); pair.close(); } };
}

test('mature TLS 1.3 pinned mTLS works over opaque Duplex and relay sees no plaintext', async () => {
  const ch = await channels();
  try {
    const got = [];
    ch.server.onMessage((frame) => { got.push(frame); });
    const expected = message();
    await ch.client.send(expected);
    await until(() => got.length === 1);
    assert.deepEqual(got[0], expected);
    const serverInfo = secureChannelInfo(ch.server), clientInfo = secureChannelInfo(ch.client);
    assert.equal(serverInfo.channelId, clientInfo.channelId);
    assert.equal(serverInfo.peerIdentity.spkiSha256, phone.spkiSha256);
    assert.equal(serverInfo.purpose, 'session');
    assert.equal(REMOTE_TLS.version, 'TLSv1.3');
    const bytes = Buffer.concat(ch.tunnel.wire);
    assert.equal(bytes.includes(Buffer.from('FAKE SECRET TEXT')), false);
    assert.equal(bytes.includes(Buffer.from('message.submit')), false);
    assert.equal(bytes.includes(Buffer.from('command-fake')), false);
    assert.equal(Object.isFrozen(got[0]), true);
    assert.equal(Object.isFrozen(got[0].payload), true);
  } finally { ch.close(); }
});

test('SPKI identity is SHA-256, stable across loads, names are not identity', () => {
  const fromBuffer = identityFromCertificate(tabletCredentials.cert);
  assert.deepEqual(fromBuffer, identityFromCertificate(tabletCredentials.cert.toString()));
  assert.equal(fromBuffer.deviceId, 'dev_' + fromBuffer.spkiSha256);
  assert.equal(samePublicPin(tablet.spkiSha256, phone.spkiSha256), false);
  assert.throws(() => samePublicPin(tablet.spkiSha256 + '=', phone.spkiSha256), { code: 'INVALID_IDENTITY' });
  assert.throws(() => identityFromCertificate('not-a-cert'), { code: 'INVALID_CERTIFICATE' });
  assert.throws(() => identityFromCertificate(tabletCredentials.cert, { now: () => Date.now() + 3 * 86400_000 }), { code: 'CERTIFICATE_EXPIRED' });
});

test('session channels fail closed without pin, replay guard, context, or matching key', () => {
  const tunnel = relay();
  const options = { role: 'server', transport: tunnel.server, credentials: tabletCredentials, peerPin: phone.spkiSha256,
    context, replayGuard: createReplayGuard() };
  try {
    assert.throws(() => createSecureChannel({ ...options, peerPin: undefined }), { code: 'INVALID_IDENTITY' });
    assert.throws(() => createSecureChannel({ ...options, replayGuard: undefined }), { code: 'REPLAY_GUARD_REQUIRED' });
    assert.throws(() => createSecureChannel({ ...options, context: { ...context, sessionId: 'local-secret' } }), { code: 'INVALID_CHANNEL_FRAME' });
    assert.throws(() => createSecureChannel({ ...options, credentials: { cert: tabletCredentials.cert, key: phoneCredentials.key } }), { code: 'CREDENTIAL_MISMATCH' });
    assert.throws(() => createSecureChannel({ ...options, credentials: undefined }), { code: 'TLS_CREDENTIALS_UNAVAILABLE' });
    assert.throws(() => createPairingChannel({ ...options, role: 'client', peerPin: undefined }), { code: 'INVALID_IDENTITY' });
  } finally { tunnel.close(); }
});

test('both directions reject unpaired key, substituted tablet pin, reflected identity', async () => {
  await assert.rejects(channels({ clientPin: attacker.spkiSha256 }), { code: 'PEER_PIN_MISMATCH' });
  await assert.rejects(channels({ serverPin: attacker.spkiSha256 }), { code: 'PEER_PIN_MISMATCH' });
  await assert.rejects(channels({ clientCreds: tabletCredentials }), { code: 'REFLECTED_IDENTITY' });
});

test('fragmented relay bytes do not change frame boundaries or routing', async () => {
  const ch = await channels();
  try {
    ch.tunnel.fragment = 1;
    const got = [];
    ch.server.onMessage((value) => { got.push(value); });
    for (let index = 0; index < 3; index++) await ch.client.send(message({ messageId: 'fragment-' + index }));
    await until(() => got.length === 3);
    assert.deepEqual(got.map((frame) => frame.messageId), ['fragment-0', 'fragment-1', 'fragment-2']);
  } finally { ch.close(); }
});

test('TLS AEAD rejects record bit tampering, no application callback', async () => {
  const ch = await channels();
  try {
    let delivered = false;
    ch.server.onMessage(() => { delivered = true; });
    ch.tunnel.transform = (side, bytes) => {
      if (side === 0) { bytes[bytes.length - 1] ^= 1; ch.tunnel.transform = null; }
      return bytes;
    };
    await ch.client.send(message()).catch(() => {});
    await until(() => ch.server.closed, 'tamper rejection');
    assert.equal(delivered, false);
  } finally { ch.close(); }
});

test('TLS record replay and reordering fail authentication before duplicate dispatch', async () => {
  const ch = await channels();
  try {
    const got = [];
    ch.server.onMessage((value) => { got.push(value); });
    ch.tunnel.transform = (side, bytes) => side === 0 ? Buffer.concat([bytes, bytes]) : bytes;
    await ch.client.send(message()).catch(() => {});
    await until(() => ch.server.closed, 'record replay rejection');
    assert.ok(got.length <= 1);
  } finally { ch.close(); }
  const reordered = await channels();
  try {
    const got = [];
    let first;
    reordered.server.onMessage((value) => { got.push(value); });
    reordered.tunnel.transform = (side, bytes) => {
      if (side !== 0) return bytes;
      if (!first) { first = bytes; return null; }
      return Buffer.concat([bytes, first]);
    };
    await reordered.client.send(message({ messageId: 'reorder-1' })).catch(() => {});
    await reordered.client.send(message({ messageId: 'reorder-2' })).catch(() => {});
    await until(() => reordered.server.closed, 'record reorder rejection');
    assert.equal(got.length, 0);
  } finally { reordered.close(); }
});

test('cross-handshake ciphertext is invalid and TLS exporter bindings are unique', async () => {
  const first = await channels();
  let captured;
  first.server.onMessage(() => {});
  first.tunnel.transform = (side, bytes) => { if (side === 0) captured = Buffer.from(bytes); return bytes; };
  await first.client.send(message());
  await delay();
  const oldId = secureChannelInfo(first.client).channelId;
  first.close();
  const second = await channels();
  try {
    assert.notEqual(secureChannelInfo(second.client).channelId, oldId);
    let called = false;
    second.server.onMessage(() => { called = true; });
    second.tunnel.server.push(captured);
    await until(() => second.server.closed, 'old handshake replay rejection');
    assert.equal(called, false);
  } finally { second.close(); }
});

test('authenticated devices cannot substitute source/destination/session/grant/host', async () => {
  const ch = await channels();
  try {
    ch.server.onMessage(() => assert.fail('must not receive invalid route'));
    const original = message();
    const mutations = [
      ['fromDeviceId', attacker.deviceId, 'DEVICE_MISMATCH'],
      ['toDeviceId', attacker.deviceId, 'DEVICE_MISMATCH'],
      ['remoteSessionId', 'other-session', 'SESSION_MISMATCH'],
      ['hostInstanceId', 'old-host', 'HOST_INSTANCE_MISMATCH'],
      ['grantVersion', 2, 'GRANT_MISMATCH'],
    ];
    for (const [field, value, code] of mutations) await assert.rejects(ch.client.send({ ...original, [field]: value }), { code });
    await assert.rejects(ch.client.send({ ...original, sessionId: '/private-project' }), { code: 'UNKNOWN_FIELD' });
    await assert.rejects(ch.client.send({ ...original, expiresAt: original.issuedAt - 1 }), { code: 'INVALID_SCHEMA' });
  } finally { ch.close(); }
});

test('runId commandId messageId expiry and payload changes fail TLS authentication', async () => {
  // Altering any byte of the encrypted application record must fail, regardless
  // of which cleartext field those bytes would otherwise represent.
  for (let position = 6; position < 11; position++) {
    const ch = await channels();
    try {
      let count = 0;
      ch.server.onMessage(() => { count++; });
      ch.tunnel.transform = (side, bytes) => { if (side === 0) bytes[position] ^= 0x80; return bytes; };
      await ch.client.send(message()).catch(() => {});
      await until(() => ch.server.closed, 'authenticated header rejection');
      assert.equal(count, 0);
    } finally { ch.close(); }
  }
});

test('live authorization checks old run and revoked grant on receive', async () => {
  let active = true;
  const ch = await channels({ authorizeFrame: (frame) => active && frame.runId === 'run-current' });
  try {
    let count = 0;
    ch.server.onMessage(() => { count++; });
    await ch.client.send(message()).catch(() => {});
    await until(() => ch.server.closed, 'stale run rejection');
    assert.equal(count, 0);
  } finally { ch.close(); }
  const revoked = await channels({ authorizeFrame: () => active });
  try {
    let count = 0;
    revoked.server.onMessage(() => { count++; });
    active = false;
    await revoked.client.send(message()).catch(() => {});
    await until(() => revoked.server.closed, 'grant revocation rejection');
    assert.equal(count, 0);
  } finally { revoked.close(); }
});

test('application replay guard persists across connections and fails closed when full', async () => {
  const replayGuard = createReplayGuard({ maxEntries: 1 });
  const frame = message({ messageId: 'stable-message-id' });
  const first = await channels({ replayGuard });
  let count = 0;
  first.server.onMessage(() => { count++; });
  await first.client.send(frame);
  await until(() => count === 1);
  first.close();
  const second = await channels({ replayGuard });
  second.server.onMessage(() => { count++; });
  await second.client.send(frame).catch(() => {});
  await until(() => second.server.closed, 'application replay rejection');
  second.close();
  const third = await channels({ replayGuard });
  try {
    third.server.onMessage(() => { count++; });
    await third.client.send(message({ messageId: 'other-message-id' })).catch(() => {});
    await until(() => third.server.closed, 'bounded replay guard rejection');
    assert.equal(count, 1);
    assert.equal(replayGuard.size, 1);
  } finally { third.close(); }
});

test('expired frames and expiry-bounded replay entries are handled without eviction', () => {
  let now = Date.now();
  const guard = createReplayGuard({ now: () => now, maxEntries: 1 });
  const first = message({ now: () => now, ttlMs: 10, messageId: 'expire-first' });
  guard.accept(first);
  assert.equal(guard.size, 1);
  assert.throws(() => guard.accept(first), { code: 'REPLAY_DETECTED' });
  now += 11;
  assert.equal(guard.size, 0);
  assert.throws(() => guard.accept(first), { code: 'INVALID_REPLAY_FRAME' });
  guard.accept(message({ now: () => now, ttlMs: 10, messageId: 'expire-second' }));
  assert.equal(guard.size, 1);
});

test('purpose-separated pairing stream cannot carry session/control frames', async () => {
  const ch = await channels({ pairing: true, serverPin: undefined });
  try {
    ch.server.onMessage(() => assert.fail('pairing is not authorization'));
    await assert.rejects(ch.client.send(message()), { code: 'INVALID_CHANNEL_FRAME' });
    assert.equal(secureChannelInfo(ch.server).purpose, 'pairing');
  } finally { ch.close(); }
});

test('pair offer has 256 random bits, bounded TTL, no routing URL or private key', () => {
  const pair = managers();
  try {
    const first = pair.tabletManager.createOffer(), second = pair.tabletManager.createOffer();
    assert.equal(Buffer.from(first.secret, 'base64url').length, 32);
    assert.notEqual(first.secret, second.secret);
    assert.equal(first.expiresAt - first.issuedAt, 300_000);
    assert.deepEqual(validatePairingOffer(first), first);
    assert.throws(() => validatePairingOffer({ ...first, relayUrl: 'https://evil.example' }), { code: 'INVALID_PAIRING' });
    assert.throws(() => pair.tabletManager.createOffer({ ttlMs: 300_001 }), { code: 'INVALID_PAIRING_TTL' });
    assert.equal(JSON.stringify(pair.tabletManager.listPending()).includes(first.secret), false);
  } finally { pair.close(); }
});

test('double local confirmation binds both pins; only public records persist', async () => {
  const setup = await pairingSetup();
  try {
    assert.equal(setup.tabletRecords.length, 0);
    assert.equal(setup.phoneRecords.length, 0);
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    assert.equal(setup.tabletRecords.length, 0, 'phone confirmation is not tablet consent');
    assert.equal(setup.phoneRecords.length, 0);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => setup.tabletRecords.length === 1 && setup.phoneRecords.length === 1, 'pair persistence');
    assert.equal(setup.tabletRecords[0].peerDevice.spkiSha256, phone.spkiSha256);
    assert.equal(setup.phoneRecords[0].peerDevice.spkiSha256, tablet.spkiSha256);
    assert.equal(setup.tabletManager.listPending()[0].peerPersisted, null, 'local completion cannot attest to the phone store');
    assert.equal(setup.phoneManager.listPending()[0].peerPersisted, true, 'authenticated pair.complete attests only to tablet persistence');
    const saved = JSON.stringify([setup.tabletRecords, setup.phoneRecords]);
    assert.equal(saved.includes(setup.offer.secret), false);
    assert.equal(saved.includes('PRIVATE KEY'), false);
    assert.equal(saved.includes('localSessionId'), false);
    await until(() => setup.client.closed && setup.server.closed);
  } finally { setup.close(); }
});

test('delayed pair.challenge stays claiming: a transport write is not remote delivery or confirm-readiness', async () => {
  const pair = managers();
  const offer = pair.tabletManager.createOffer();
  const ch = await channels({ pairing: true });
  const held = [];
  try {
    pair.tabletManager.attachIncoming(ch.server);
    ch.tunnel.transform = (side, bytes) => {
      if (side === 1) { held.push(Buffer.from(bytes)); return null; }
      return bytes;
    };
    const attemptId = pair.phoneManager.acceptOffer(offer, ch.client);
    await until(() => pair.tabletManager.listPending().some((attempt) => attempt.attemptId === attemptId));
    assert.equal(pair.phoneManager.listPending()[0].state, 'claiming');
    // A real WSS relay flushes locally before the receiving endpoint processes
    // the challenge. The runtime must not map this state to a confirmable card.
    await pair.tabletManager.confirm(attemptId, phone.spkiSha256);
    assert.equal(pair.phoneManager.listPending()[0].state, 'claiming');
    await assert.rejects(pair.phoneManager.confirm(attemptId, tablet.spkiSha256), { code: 'INVALID_PAIRING_CONFIRMATION' });
    assert.equal(pair.tabletRecords.length + pair.phoneRecords.length, 0);
    ch.tunnel.transform = null;
    ch.tunnel.client.push(Buffer.concat(held));
    await until(() => pair.phoneManager.listPending()[0].state === 'pending-confirmation'
      && pair.phoneManager.listPending()[0].peerConfirmed);
    await pair.phoneManager.confirm(attemptId, tablet.spkiSha256);
    await until(() => pair.tabletRecords.length === 1 && pair.phoneRecords.length === 1);
  } finally { ch.close(); pair.close(); }
});

test('reverse confirmation order is accepted without automatic trust', async () => {
  const setup = await pairingSetup();
  try {
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => setup.phoneManager.listPending()[0].peerConfirmed);
    assert.equal(setup.tabletRecords.length, 0);
    assert.equal(setup.phoneRecords.length, 0);
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.phoneRecords.length === 1 && setup.tabletRecords.length === 1);
  } finally { setup.close(); }
});

test('incorrect expected pin, rejection and expiry never silently pair', async () => {
  const setup = await pairingSetup();
  try {
    await assert.rejects(setup.phoneManager.confirm(setup.attemptId, attacker.spkiSha256), { code: 'INVALID_PAIRING_CONFIRMATION' });
    setup.phoneManager.reject(setup.attemptId);
    await until(() => setup.server.closed);
    assert.equal(setup.tabletRecords.length + setup.phoneRecords.length, 0);
  } finally { setup.close(); }
  let now = Date.now();
  const pair = managers({ now: () => now });
  try {
    const offer = pair.tabletManager.createOffer({ ttlMs: 10 });
    now += 11;
    assert.throws(() => validatePairingOffer(offer, { now: () => now }), { code: 'PAIRING_EXPIRED' });
    assert.equal(pair.tabletRecords.length + pair.phoneRecords.length, 0);
  } finally { pair.close(); }
});

test('one valid claim burns offer before confirmation; second device cannot reuse it', async () => {
  const setup = await pairingSetup();
  const second = await channels({ pairing: true, clientCreds: attackerCredentials, serverPin: undefined });
  try {
    setup.tabletManager.attachIncoming(second.server);
    second.client.onMessage(() => {});
    await second.client.send(pairClaim(setup.offer, secureChannelInfo(second.client), { attemptId: 'second-attempt' })).catch(() => {});
    await until(() => second.server.closed, 'one-time offer refusal');
    assert.equal(setup.tabletManager.listPending().filter((entry) => entry.state === 'pending-confirmation').length, 1);
    assert.equal(setup.tabletRecords.length + setup.phoneRecords.length, 0);
  } finally { second.close(); setup.close(); }
});

test('wrong high-entropy secret and bounded claim rate fail closed', async () => {
  const pair = managers({ maxAttempts: 1 });
  const offer = pair.tabletManager.createOffer();
  const ch = await channels({ pairing: true, serverPin: undefined });
  try {
    pair.tabletManager.attachIncoming(ch.server);
    ch.client.onMessage(() => {});
    await ch.client.send(pairClaim(offer, secureChannelInfo(ch.client), { secret: randomBytes(32).toString('base64url') })).catch(() => {});
    await until(() => ch.server.closed);
    assert.equal(pair.tabletManager.listPending().length, 0);
    assert.equal(pair.tabletRecords.length, 0);
    assert.throws(() => pair.tabletManager.attachIncoming(ch.server), { code: 'PAIRING_RATE_LIMIT' });
  } finally { ch.close(); pair.close(); }
});

test('fake channel objects cannot masquerade as TLS authentication', () => {
  const pair = managers();
  const fake = { purpose: 'pairing', peerIdentity: phone, ready: Promise.resolve(), send() {} };
  try {
    assert.throws(() => secureChannelInfo(fake), { code: 'UNAUTHENTICATED_CHANNEL' });
    assert.throws(() => pair.tabletManager.attachIncoming(fake), { code: 'UNAUTHENTICATED_CHANNEL' });
    assert.throws(() => pair.phoneManager.acceptOffer(pair.tabletManager.createOffer(), fake), { code: 'UNAUTHENTICATED_CHANNEL' });
  } finally { pair.close(); }
});

test('pair persistence failure does not claim a secure channel is trusted', async () => {
  const setup = await pairingSetup({ persistTablet: async () => { throw new Error('fake storage outage'); } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => setup.server.closed);
    assert.equal(setup.phoneRecords.length, 0);
    assert.equal(setup.tabletManager.listPending()[0].persisted, false);
  } finally { setup.close(); }
});

test('cancelled pending persistence exposes an aborted local commit guard', async () => {
  let controls, unblock, commits = 0;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ persistTablet: async (record, guard) => {
    controls = guard;
    await gate;
    if (guard.isCurrent()) commits++;
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    assert.equal(controls.isCurrent(), true);
    assert.equal(controls.signal.aborted, false);
    setup.tabletManager.reject(setup.attemptId);
    assert.equal(controls.isCurrent(), false);
    assert.equal(controls.signal.aborted, true);
    unblock();
    await delay();
    assert.equal(commits, 0);
    assert.equal(setup.phoneRecords.length, 0);
  } finally { unblock(); setup.close(); }
});

test('cancelPeer before persistence rejects every existing confirmation for that peer', async () => {
  const setup = await pairingSetup();
  const second = await channels({ pairing: true });
  try {
    const offer = setup.tabletManager.createOffer();
    setup.tabletManager.attachIncoming(second.server);
    const secondId = setup.phoneManager.acceptOffer(offer, second.client);
    await until(() => setup.phoneManager.listPending().some((p) => p.attemptId === secondId && p.state === 'pending-confirmation'));
    setup.tabletManager.cancelPeer(phone.deviceId);
    assert.equal(setup.tabletManager.listPending().length, 2);
    for (const attempt of setup.tabletManager.listPending()) {
      assert.equal(attempt.state, 'rejected');
      assert.equal(attempt.errorCode, 'PAIRING_UNPAIRED');
      assert.equal(attempt.persisted, false);
      await assert.rejects(setup.tabletManager.confirm(attempt.attemptId, phone.spkiSha256), { code: 'INVALID_PAIRING_CONFIRMATION' });
    }
    await until(() => setup.client.closed && second.client.closed);
    assert.equal(setup.tabletRecords.length + setup.phoneRecords.length, 0);
    assert.throws(() => setup.tabletManager.cancelPeer('../invalid'), { code: 'INVALID_IDENTITY' });
  } finally { second.close(); setup.close(); }
});

test('unpair during a confirmation flush cannot restart tablet persistence', async () => {
  const setup = await pairingSetup();
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    const confirming = setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    const rejected = assert.rejects(confirming, (error) => ['PAIRING_ABORTED', 'CHANNEL_CLOSED'].includes(error.code));
    // Same turn: confirm has sent but has not resumed after its awaited flush.
    setup.tabletManager.cancelPeer(phone.deviceId);
    await rejected;
    assert.equal(setup.tabletManager.listPending()[0].state, 'rejected');
    assert.equal(setup.tabletRecords.length + setup.phoneRecords.length, 0);
  } finally { setup.close(); }
});

test('cancelPeer also closes an authenticated incoming channel before its claim', async () => {
  const pair = managers(), offer = pair.tabletManager.createOffer();
  const ch = await channels({ pairing: true });
  try {
    pair.tabletManager.attachIncoming(ch.server);
    ch.client.onMessage(() => {});
    const claim = pairClaim(offer, secureChannelInfo(ch.client));
    pair.tabletManager.cancelPeer(phone.deviceId);
    assert.equal(ch.server.closed, true);
    await ch.client.send(claim).catch(() => {});
    await until(() => ch.client.closed);
    assert.equal(pair.tabletManager.listPending().length, 0);
    assert.equal(pair.tabletRecords.length, 0);
  } finally { ch.close(); pair.close(); }
});

test('unpair cancels a delayed tablet commit before synchronous store publication', async () => {
  const store = createRemoteStore(null);
  store.putPeer(phone);
  let controls, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ persistTablet: async (record, guard) => {
    controls = guard;
    await gate;
    // Runtime must keep this guard and synchronous putPeer in the same turn.
    if (!guard.isCurrent() || guard.signal.aborted) throw new Error('cancelled fake commit');
    store.putPeer(record.peerDevice);
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    setup.tabletManager.cancelPeer(phone.deviceId);
    store.removePeer(phone.deviceId);
    assert.equal(controls.isCurrent(), false);
    assert.equal(controls.signal.aborted, true);
    unblock();
    await delay();
    assert.deepEqual(store.peers(), []);
    assert.equal(setup.tabletManager.listPending()[0].persisted, false);
    assert.equal(setup.phoneRecords.length, 0);
  } finally { unblock(); setup.close(); }
});

test('cancelPeer invalidates a completed attempt without resurrecting its deleted store record', async () => {
  const store = createRemoteStore(null);
  let controls;
  const setup = await pairingSetup({ persistTablet: async (record, guard) => {
    controls = guard;
    assert.equal(guard.isCurrent(), true);
    store.putPeer(record.peerDevice);
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].state === 'complete');
    setup.tabletManager.cancelPeer(phone.deviceId);
    store.removePeer(phone.deviceId);
    assert.equal(controls.isCurrent(), false);
    assert.equal(controls.signal.aborted, true);
    assert.equal(setup.tabletManager.listPending()[0].state, 'rejected');
    assert.deepEqual(store.peers(), []);
    // persisted is historical evidence of the callback, not proof the peer is
    // still in the store. Unpair, not a protocol rollback, removed that record.
    assert.equal(setup.tabletManager.listPending()[0].persisted, true);
  } finally { setup.close(); }
});

test('cancelled unresolved persistence still consumes the bounded attempt slot', async () => {
  let controls, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ maxPending: 1, persistTablet: async (record, guard) => {
    controls = guard;
    await gate;
  } });
  const second = await channels({ pairing: true });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    setup.tabletManager.cancelPeer(phone.deviceId);
    const nextOffer = setup.tabletManager.createOffer();
    setup.tabletManager.attachIncoming(second.server);
    second.client.onMessage(() => {});
    await second.client.send(pairClaim(nextOffer, secureChannelInfo(second.client), { attemptId: 'attempt-bounded' })).catch(() => {});
    await until(() => second.server.closed);
    assert.equal(setup.tabletManager.listPending().length, 1, 'unsettled callback cannot be evicted to accept another writer');
    assert.equal(setup.tabletManager.listPending()[0].attemptId, setup.attemptId);
    unblock();
    await delay();
    const offer = setup.tabletManager.createOffer();
    const ready = await channels({ pairing: true });
    try {
      setup.tabletManager.attachIncoming(ready.server);
      ready.client.onMessage(() => {});
      await ready.client.send(pairClaim(offer, secureChannelInfo(ready.client), { attemptId: 'attempt-after-settle' }));
      await until(() => setup.tabletManager.listPending().some((p) => p.attemptId === 'attempt-after-settle'));
      assert.equal(setup.tabletManager.listPending().length, 1, 'settled cancelled metadata is disposable');
    } finally { ready.close(); }
  } finally { unblock(); second.close(); setup.close(); }
});

test('tablet disconnect during a pending write aborts its commit guard', async () => {
  let controls, unblock, commits = 0;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ persistTablet: async (record, guard) => {
    controls = guard;
    await gate;
    if (guard.isCurrent()) commits++;
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    setup.client.close();
    await until(() => setup.tabletManager.listPending()[0].state === 'rejected');
    assert.equal(controls.signal.aborted, true);
    assert.equal(controls.isCurrent(), false);
    unblock();
    await delay();
    assert.equal(commits, 0);
    assert.equal(setup.tabletManager.listPending()[0].persisted, false);
    assert.equal(setup.phoneRecords.length, 0);
  } finally { unblock(); setup.close(); }
});

test('phone may finish an authenticated pair.complete commit after bootstrap close', async () => {
  let controls, unblock, commits = 0;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ persistPhone: async (record, guard) => {
    controls = guard;
    await gate;
    if (!guard.isCurrent() || guard.signal.aborted) throw new Error('cancelled fake commit');
    commits++;
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    setup.client.close();
    assert.equal(controls.signal.aborted, false, 'authenticated completion is distinct from a pending tablet write');
    assert.equal(controls.isCurrent(), true);
    assert.equal(setup.phoneManager.listPending()[0].peerPersisted, true);
    unblock();
    await until(() => setup.phoneManager.listPending()[0].state === 'complete');
    assert.equal(commits, 1);
    assert.equal(setup.phoneManager.listPending()[0].persisted, true);
  } finally { unblock(); setup.close(); }
});

test('unpair still cancels a phone commit after authenticated completion and close', async () => {
  const store = createRemoteStore(null);
  let controls, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const setup = await pairingSetup({ persistPhone: async (record, guard) => {
    controls = guard;
    await gate;
    if (!guard.isCurrent() || guard.signal.aborted) throw new Error('cancelled fake commit');
    store.putPeer(record.peerDevice);
  } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => controls !== undefined);
    setup.client.close();
    setup.phoneManager.cancelPeer(tablet.deviceId);
    store.removePeer(tablet.deviceId);
    assert.equal(controls.signal.aborted, true);
    assert.equal(controls.isCurrent(), false);
    unblock();
    await delay();
    assert.deepEqual(store.peers(), []);
    assert.equal(setup.phoneManager.listPending()[0].persisted, false);
    assert.equal(setup.phoneManager.listPending()[0].peerPersisted, true, 'remote commit is not rolled back by local cancellation');
    assert.equal(setup.tabletRecords.length, 1);
  } finally { unblock(); setup.close(); }
});

test('offer cancellation, manager close and expiry invalidate delayed writes', async () => {
  for (const boundary of ['offer', 'manager', 'expiry']) {
    let now = Date.now(), controls, unblock, commits = 0;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const setup = await pairingSetup({ now: () => now, persistTablet: async (record, guard) => {
      controls = guard;
      await gate;
      if (guard.isCurrent()) commits++;
    } });
    try {
      await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
      await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
      await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
      await until(() => controls !== undefined);
      if (boundary === 'offer') setup.tabletManager.cancelOffer(setup.offer.offerId);
      else if (boundary === 'manager') setup.tabletManager.close();
      else now = setup.offer.expiresAt;
      assert.equal(controls.isCurrent(), false, boundary);
      unblock();
      await delay();
      assert.equal(commits, 0, boundary);
      assert.equal(setup.phoneRecords.length, 0, boundary);
    } finally { unblock(); setup.close(); }
  }
});

test('lost pair.complete leaves a local-only tablet record, never a phone commit', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const localRecords = [];
  const held = await pairingSetup({ persistTablet: async (record, guard) => {
    await gate;
    assert.equal(guard.isCurrent(), true);
    localRecords.push(record);
  } });
  try {
    await held.phoneManager.confirm(held.attemptId, tablet.spkiSha256);
    await until(() => held.tabletManager.listPending()[0].peerConfirmed);
    await held.tabletManager.confirm(held.attemptId, phone.spkiSha256);
    await until(() => held.phoneManager.listPending()[0].peerConfirmed);
    // Both confirmations arrived; hold only the tablet's final encrypted
    // completion/close records after its gated local persistence succeeds.
    held.tunnel.transform = (side, bytes) => side === 1 ? null : bytes;
    unblock();
    await until(() => held.tabletManager.listPending()[0].state === 'complete');
    held.client.close();
    assert.equal(held.phoneManager.listPending()[0].state, 'rejected');
    assert.equal(held.phoneManager.listPending()[0].persisted, false);
    assert.equal(held.phoneRecords.length, 0);
    assert.equal(localRecords.length, 1);
    assert.equal(held.tabletManager.listPending()[0].persisted, true);
    assert.equal(held.tabletManager.listPending()[0].peerPersisted, null);
  } finally { unblock(); held.close(); }
});

test('phone storage failure cannot retract a confirmed tablet record or attest a phone commit', async () => {
  const setup = await pairingSetup({ persistPhone: async () => { throw new Error('fake phone storage outage'); } });
  try {
    await setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256);
    await until(() => setup.tabletManager.listPending()[0].peerConfirmed);
    await setup.tabletManager.confirm(setup.attemptId, phone.spkiSha256);
    await until(() => setup.phoneManager.listPending()[0].state === 'rejected');
    assert.equal(setup.tabletRecords.length, 1);
    assert.equal(setup.tabletManager.listPending()[0].persisted, true);
    assert.equal(setup.tabletManager.listPending()[0].peerPersisted, null);
    assert.equal(setup.phoneManager.listPending()[0].persisted, false);
    assert.equal(setup.phoneManager.listPending()[0].peerPersisted, true);
  } finally { setup.close(); }
});

test('peer mode authorizes multiple sessions per authenticated connection', async () => {
  const tunnel = relay(), allowed = new Set(['remote-test-session', 'remote-other-session']);
  const authorizeFrame = (frame) => allowed.has(frame.remoteSessionId) && frame.hostInstanceId === context.hostInstanceId
    && frame.grantVersion === 1 && frame.runId === 'run-fake';
  const server = createSecureChannel({ role: 'server', transport: tunnel.server, credentials: tabletCredentials,
    peerPin: phone.spkiSha256, replayGuard: createReplayGuard(), authorizeFrame });
  const client = createSecureChannel({ role: 'client', transport: tunnel.client, credentials: phoneCredentials,
    peerPin: tablet.spkiSha256, replayGuard: createReplayGuard(), authorizeFrame });
  try {
    await Promise.all([server.ready, client.ready]);
    const received = [];
    server.onMessage((frame) => { received.push(frame); });
    await client.send(message({ messageId: 'peer-mode-first' }));
    await client.send({ ...message({ messageId: 'peer-mode-second' }), remoteSessionId: 'remote-other-session' });
    await until(() => received.length === 2);
    assert.deepEqual(received.map((frame) => frame.remoteSessionId), ['remote-test-session', 'remote-other-session']);
    await assert.rejects(client.send({ ...message(), fromDeviceId: attacker.deviceId }), { code: 'DEVICE_MISMATCH' });
    await assert.rejects(client.send({ ...message(), remoteSessionId: 'not-authorized' }), { code: 'CONTEXT_REVOKED' });
    await assert.rejects(client.send({ ...message(), payload: { text: 'fake', url: 'https://forbidden.invalid' } }), { code: 'UNKNOWN_FIELD' });
    allowed.delete('remote-other-session');
    await assert.rejects(client.send({ ...message(), remoteSessionId: 'remote-other-session' }), { code: 'CONTEXT_REVOKED' });
  } finally { server.close(); client.close(); }
});

test('current invitation/correlation/background notice schemas cross peer TLS unchanged', async () => {
  const tunnel = relay(), policy = () => true;
  const server = createSecureChannel({ role: 'server', transport: tunnel.server, credentials: tabletCredentials,
    peerPin: phone.spkiSha256, replayGuard: createReplayGuard(), authorizeFrame: policy });
  const client = createSecureChannel({ role: 'client', transport: tunnel.client, credentials: phoneCredentials,
    peerPin: tablet.spkiSha256, replayGuard: createReplayGuard(), authorizeFrame: policy });
  try {
    const fromHost = { fromDeviceId: tablet.deviceId, toDeviceId: phone.deviceId, ...context, runId: 'run-fake' };
    const fromPhone = { fromDeviceId: phone.deviceId, toDeviceId: tablet.deviceId, ...context, runId: 'run-fake' };
    const phoneFrames = [], hostFrames = [];
    client.onMessage((frame) => { phoneFrames.push(frame); });
    server.onMessage((frame) => { hostFrames.push(frame); });
    await Promise.all([server.ready, client.ready]);
    const invite = createFrame('host.invite', fromHost, { title: 'Synthetic session', deviceName: 'Synthetic tablet', expiresAt: Date.now() + 60_000 });
    await server.send(invite);
    const accept = createFrame('host.accept', fromPhone, {}, { correlationId: 'correlation-accept' });
    await client.send(accept);
    const decline = createFrame('host.decline', fromPhone, {}, { correlationId: 'correlation-decline' });
    await client.send(decline);
    const declined = createFrame('host.declined', fromHost, {}, { correlationId: 'correlation-decline' });
    await server.send(declined);
    const notice = createFrame('session.notice', fromHost, { run: { runId: 'run-fake', state: 'waiting' },
      pending: [{ requestId: 'request-fake', requestVersion: 1, expiresAt: Date.now() + 30_000 }], eventId: 'event-notice' });
    await server.send(notice);
    await until(() => phoneFrames.length === 3 && hostFrames.length === 2);
    assert.deepEqual(phoneFrames, [invite, declined, notice]);
    assert.deepEqual(hostFrames, [accept, decline]);
    assert.equal(hostFrames[0].correlationId, 'correlation-accept');
  } finally { server.close(); client.close(); }
});

test('peer mode requires synchronous strict-Boolean authorization, no truthy/Promise bypass', async () => {
  const tunnel = relay();
  try {
    assert.throws(() => createSecureChannel({ role: 'server', transport: tunnel.server, credentials: tabletCredentials,
      peerPin: phone.spkiSha256, replayGuard: createReplayGuard() }), { code: 'AUTHORIZER_REQUIRED' });
  } finally { tunnel.close(); }
  for (const decision of [() => 'true', () => 1, () => undefined, () => Promise.resolve(true), () => Promise.reject(new Error('fake'))]) {
    const ch = await channels({ authorizeFrame: decision });
    try {
      ch.server.onMessage(() => assert.fail('non-Boolean must never authorize'));
      await ch.client.send(message()).catch(() => {});
      await until(() => ch.server.closed);
    } finally { ch.close(); }
  }
});

test('expired on-arrival frames fail before dispatch and consumer absence is closed', async () => {
  let now = Date.now();
  const ch = await channels({ now: () => now });
  try {
    let count = 0;
    ch.server.onMessage(() => { count++; });
    const sendTime = now;
    ch.tunnel.transform = (side, bytes) => { if (side === 0) now = sendTime + 11; return bytes; };
    await ch.client.send(message({ now: () => sendTime, ttlMs: 10 })).catch(() => {});
    await until(() => ch.server.closed);
    assert.equal(count, 0);
  } finally { ch.close(); }
  const noConsumer = await channels();
  try {
    await noConsumer.client.send(message()).catch(() => {});
    await until(() => noConsumer.server.closed);
  } finally { noConsumer.close(); }
});

test('write pressure is bounded and oversize text rejected before encryption', async () => {
  const ch = await channels();
  try {
    ch.server.onMessage(() => {});
    await assert.rejects(ch.client.send({ ...message(), payload: { text: 'x'.repeat(16 * 1024 + 1) } }), { code: 'LIMIT_EXCEEDED' });
    const sends = [];
    for (let index = 0; index < 140; index++) sends.push(ch.client.send(message({ messageId: 'pressure-' + index, text: 'x'.repeat(16 * 1024) })));
    const outcomes = await Promise.allSettled(sends);
    assert.ok(outcomes.some((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'CHANNEL_BACKPRESSURE'));
    assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  } finally { ch.close(); }
});

test('confirmation after pairing expiry is rejected, offer cancellation is final', async () => {
  let now = Date.now();
  const setup = await pairingSetup({ now: () => now });
  try {
    now += 300_001;
    await assert.rejects(setup.phoneManager.confirm(setup.attemptId, tablet.spkiSha256), { code: 'INVALID_PAIRING_CONFIRMATION' });
    assert.equal(setup.phoneRecords.length + setup.tabletRecords.length, 0);
  } finally { setup.close(); }
  const pair = managers();
  const offer = pair.tabletManager.createOffer();
  pair.tabletManager.cancelOffer(offer.offerId);
  const ch = await channels({ pairing: true });
  try {
    pair.tabletManager.attachIncoming(ch.server);
    ch.client.onMessage(() => {});
    await ch.client.send(pairClaim(offer, secureChannelInfo(ch.client))).catch(() => {});
    await until(() => ch.server.closed);
    assert.equal(pair.tabletManager.listPending().length, 0);
    assert.equal(pair.tabletRecords.length, 0);
  } finally { ch.close(); pair.close(); }
});

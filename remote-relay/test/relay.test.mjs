import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRelayServer } from '../src/server.mjs';
import { fixture, fixtureEnvelope, rejectedUpgrade, activate, route } from './helpers.mjs';

async function rejectFrame(client, envelope) {
  client.send({ v: 1, op: 'send', envelope });
  return client.next(value => value.op === 'error' || value.op === 'relay.status' && value.status === 'rejected');
}

test('factory requires shared E2EE inspector and refuses non-loopback plaintext', async () => {
  await assert.rejects(createRelayServer(), /inspectEnvelope_required/);
  const relay = await createRelayServer({ inspectEnvelope: () => { throw new Error('deny'); } });
  await assert.rejects(relay.listen({ host: '0.0.0.0' }), /tls_required/);
  await relay.close();
});

test('health route has no device metadata; unknown HTTP APIs cannot proxy local gateway', async t => {
  const { relay } = await fixture(t);
  const base = `http://127.0.0.1:${relay.address().port}`;
  const health = await fetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, version: 1 });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  for (const path of ['/api/chat', '/api/files?path=/', '/v1/devices', '/v1/relay?token=secret']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('device bearer and ID are bound; query tokens and browser origins are refused', async t => {
  const { relay, devices } = await fixture(t);
  const tablet = devices.find(device => device.deviceId === 'tablet');
  const phone = devices.find(device => device.deviceId === 'phone');
  assert.equal(await rejectedUpgrade(relay, { ...phone, token: tablet.token }), 401);
  assert.equal(await rejectedUpgrade(relay, { ...phone, token: randomBytes(32).toString('base64url') }), 401);
  assert.equal(await rejectedUpgrade(relay, phone, { path: `/v1/relay?token=${phone.token}` }), 401);
  assert.equal(await rejectedUpgrade(relay, phone, { headers: { Origin: 'https://evil.invalid' } }), 401);
});

test('paired authorized opaque envelope forwards unchanged; relay does not claim applied', async t => {
  const fx = await fixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  await activate(tablet);
  const envelope = fixtureEnvelope();
  phone.send({ v: 1, op: 'send', envelope });
  const received = await tablet.next('envelope');
  assert.deepEqual(received.envelope, envelope);
  const status = await phone.next(value => value.op === 'relay.status' && value.messageId === envelope.header.messageId);
  assert.equal(status.status, 'forwarded');
  assert.equal('applied' in status, false);
  const persisted = await readFile(fx.stateFile, 'utf8');
  assert.equal(persisted.includes(envelope.ciphertext), false);
  assert.equal(fx.relay.stats().pendingItems, 0);
});

test('rejects unpaired, forged sender, stale grant, missing active route and unknown transport fields', async t => {
  const fx = await fixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  const stranger = await fx.connect('stranger');
  assert.equal((await rejectFrame(phone, fixtureEnvelope())).code, 'route_inactive');
  await activate(tablet);
  assert.equal((await rejectFrame(stranger, fixtureEnvelope({ fromDeviceId: 'stranger' }))).code, 'unpaired');
  assert.equal((await rejectFrame(phone, fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone' }))).code, 'forbidden');
  assert.equal((await rejectFrame(phone, fixtureEnvelope({ grantVersion: 2 }))).code, 'route_mismatch');
  assert.equal((await rejectFrame(phone, fixtureEnvelope({ remoteSessionId: 'other-session' }))).code, 'route_inactive');
  phone.send({ v: 1, op: 'send', envelope: fixtureEnvelope(), url: '/api/chat' });
  assert.equal((await phone.next('error')).code, 'invalid_frame');
  assert.equal(tablet.messages.some(value => value.op === 'envelope'), false);
});

test('offline controls, history and events are never stored or replayed', async t => {
  const fx = await fixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  const binding = await activate(tablet);
  const closed = once(tablet.ws, 'close');
  tablet.close();
  await closed;
  await phone.next(value => value.op === 'peer.status' && value.status === 'offline');
  for (const kind of ['control', 'history', 'event']) {
    const rejected = await rejectFrame(phone, fixtureEnvelope({ kind }));
    assert.ok(['route_inactive', 'peer_offline'].includes(rejected.code));
  }
  assert.equal(fx.relay.stats().pendingItems, 0);
  const tablet2 = await fx.connect('tablet');
  assert.equal(tablet2.messages.some(value => value.op === 'envelope'), false);
  assert.equal((await rejectFrame(phone, fixtureEnvelope())).code, 'route_inactive');
  await activate(tablet2, binding);
  const next = fixtureEnvelope();
  phone.send({ v: 1, op: 'send', envelope: next });
  assert.deepEqual((await tablet2.next('envelope')).envelope, next);
});

test('invites/reminders are bounded, TTL encrypted-only durable items and recipient ack removes them', async t => {
  const fx = await fixture(t, { limits: { maxPendingItems: 2, maxPendingPerDevice: 2 } });
  const tablet = await fx.connect('tablet');
  const envelope = fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'invite' });
  tablet.send({ v: 1, op: 'send', envelope });
  assert.equal((await tablet.next('relay.status')).status, 'stored');
  tablet.send({ v: 1, op: 'send', envelope: fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'reminder' }) });
  assert.equal((await tablet.next('relay.status')).status, 'stored');
  const full = await rejectFrame(tablet, fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'invite' }));
  assert.equal(full.code, 'pending_full');
  assert.equal(fx.relay.stats().pendingItems, 2);
  const phone = await fx.connect('phone');
  assert.deepEqual((await phone.next(value => value.op === 'envelope' && value.envelope.header.messageId === envelope.header.messageId)).envelope, envelope);
  phone.send({ v: 1, op: 'relay.ack', fromDeviceId: 'tablet', messageId: envelope.header.messageId });
  await phone.next('relay.acked');
  assert.equal(fx.relay.stats().pendingItems, 1);
  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.devices.every(device => /^[0-9a-f]{64}$/.test(device.tokenHash)), true);
  for (const device of fx.devices) assert.equal(JSON.stringify(state).includes(device.token), false);
});

test('TTL expiry is enforced both at acceptance and periodic cleanup', async t => {
  let now = Date.now();
  const fx = await fixture(t, { now: () => now });
  const tablet = await fx.connect('tablet');
  assert.equal((await rejectFrame(tablet, fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'invite', now: now - 1000, ttl: 100 }))).code, 'expired');
  const envelope = fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'invite', now, ttl: 100 });
  tablet.send({ v: 1, op: 'send', envelope });
  await tablet.next('relay.status');
  assert.equal(fx.relay.stats().pendingItems, 1);
  now += 101;
  await fx.relay.sweep();
  assert.equal(fx.relay.stats().pendingItems, 0);
});

test('host-only activation/revocation and durable unpair immediately block subsequent traffic', async t => {
  const fx = await fixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  phone.send({ v: 1, op: 'route.activate', route: route() });
  assert.equal((await phone.next('error')).code, 'forbidden');
  await activate(tablet);
  tablet.send({ v: 1, op: 'route.revoke', remoteSessionId: 'session-test', grantVersion: 1 });
  await tablet.next(value => value.op === 'route.status' && value.status === 'inactive');
  assert.equal((await rejectFrame(phone, fixtureEnvelope())).code, 'route_inactive');
  await activate(tablet, { ...route(), grantVersion: 2 });
  await fx.relay.revokePair('tablet', 'phone');
  assert.equal((await rejectFrame(phone, fixtureEnvelope({ grantVersion: 2 }))).code, 'unpaired');
  assert.equal(fx.relay.stats().activeRoutes, 0);
});

test('logs contain only fixed event codes, not bodies, tokens or attacker identifiers', async t => {
  const logs = [];
  const fx = await fixture(t, { logger: value => logs.push(value) });
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  await activate(tablet);
  const envelope = fixtureEnvelope({ messageId: 'secret-id-MARKER' });
  phone.send({ v: 1, op: 'send', envelope });
  await tablet.next('envelope');
  await phone.next(value => value.op === 'relay.status' && value.messageId === envelope.header.messageId);
  phone.send({ v: 1, op: 'arbitrary-secret-body' });
  await phone.next('error');
  const text = JSON.stringify(logs);
  for (const secret of [envelope.ciphertext, envelope.header.messageId, 'arbitrary-secret-body', ...fx.devices.map(device => device.token)]) {
    assert.equal(text.includes(secret), false);
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every(value => Object.keys(value).every(key => ['event', 'code'].includes(key))));
});

test('message burst is limited without unbounded receive backlog', async t => {
  const fx = await fixture(t, { limits: { messagesPerSecond: 1, messageBurst: 2 } });
  const phone = await fx.connect('phone');
  const closed = once(phone.ws, 'close');
  for (let index = 0; index < 8; index++) phone.send({ v: 1, op: 'ping' });
  const [code, reason] = await closed;
  assert.equal(code, 1008);
  assert.equal(reason.toString(), 'rate_limited');
  assert.equal(fx.relay.stats().pendingItems, 0);
});

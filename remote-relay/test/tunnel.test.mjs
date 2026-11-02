import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tunnelFixture, connectTunnel, pairingTunnel, confirmPair, peerTunnel } from './tunnel-helpers.mjs';

const errorFor = async (client, frame) => { client.send(frame); return (await client.next('error')).code; };

test('standard Node WebSocket first-frame auth works; wrong token and preauth actions fail', async t => {
  const fx = await tunnelFixture(t);
  const client = await fx.connect('tablet');
  client.send({ v: 1, op: 'ping' });
  assert.equal((await client.next('pong')).v, 1);
  const wrong = await fx.connect('phone', { authenticate: false });
  wrong.send({ v: 1, op: 'auth', deviceId: 'phone', token: fx.devices[0].token });
  const closed = await wrong.closed;
  assert.equal(closed.code, 4003);
  assert.equal(fx.relay.stats().connectedDevices, 1);
  const preauth = await fx.connect('stranger', { authenticate: false });
  preauth.send({ v: 1, op: 'tunnel.open', tunnelId: 'hack', toDeviceId: 'tablet', purpose: 'peer' });
  assert.equal((await preauth.closed).code, 4003);
});

test('unauthenticated connection cap and timeout are bounded', async t => {
  const fx = await tunnelFixture(t, { limits: { authTimeoutMs: 100, maxUnauthenticated: 1 } });
  const first = await fx.connect('tablet', { authenticate: false });
  assert.equal(fx.relay.stats().unauthenticated, 1);
  await assert.rejects(connectTunnel(fx.relay, fx.devices[1], { authenticate: false }), /websocket_failed/);
  assert.equal((await first.closed).reason, 'auth_timeout');
  assert.equal(fx.relay.stats().unauthenticated, 0);
});

test('peer tunnels require two distinct confirmations on an active pairing offer/tunnel', async t => {
  const fx = await tunnelFixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.open', tunnelId: 'denied', toDeviceId: 'tablet', purpose: 'peer' }), 'unpaired');
  assert.equal(await errorFor(phone, { v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' }), 'offer_missing');
  await pairingTunnel(tablet, phone);
  phone.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' });
  await phone.next('pair.pending');
  phone.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' });
  await phone.next('pair.pending');
  assert.equal(fx.relay.stats().pairedDevices, 0);
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.open', tunnelId: 'still-denied', toDeviceId: 'tablet', purpose: 'peer' }), 'unpaired');
  tablet.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'phone' });
  await Promise.all([tablet.next('pair.confirmed'), phone.next('pair.confirmed')]);
  const stranger = await fx.connect('stranger');
  assert.equal(await errorFor(stranger, { v: 1, op: 'tunnel.open', tunnelId: 'offer-reuse', toDeviceId: 'tablet',
    purpose: 'pairing', offerId: 'offer-test' }), 'offer_missing');
  await peerTunnel(tablet, phone);
  assert.equal(fx.relay.stats().pairedDevices, 1);
});

test('relay injects source identity and forwards only participant opaque bytes, never persistence', async t => {
  const logs = [];
  const fx = await tunnelFixture(t, { pairs: [['tablet', 'phone']], logger: record => logs.push(record) });
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  const stranger = await fx.connect('stranger');
  phone.send({ v: 1, op: 'tunnel.open', tunnelId: 'secret-tunnel', toDeviceId: 'tablet', purpose: 'peer' });
  const opened = await tablet.next('tunnel.opened');
  await phone.next('tunnel.opened');
  assert.equal(opened.fromDeviceId, 'phone');
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.open', tunnelId: 'forged', fromDeviceId: 'tablet', toDeviceId: 'tablet', purpose: 'peer' }), 'invalid_frame');
  const payload = randomBytes(1024).toString('base64');
  assert.equal(await errorFor(stranger, { v: 1, op: 'tunnel.data', tunnelId: 'secret-tunnel', data: payload }), 'forbidden');
  phone.send({ v: 1, op: 'tunnel.data', tunnelId: 'secret-tunnel', data: payload });
  assert.deepEqual(await tablet.next('tunnel.data'), { v: 1, op: 'tunnel.data', tunnelId: 'secret-tunnel', data: payload });
  const disk = await readFile(fx.stateFile, 'utf8');
  assert.equal(disk.includes(payload), false);
  assert.equal(disk.includes('secret-tunnel'), false);
  const text = JSON.stringify(logs);
  for (const secret of [payload, 'secret-tunnel', ...fx.devices.map(device => device.token)]) assert.equal(text.includes(secret), false);
});

test('chunk size/base64/unknown fields and per-device tunnel capacity are enforced', async t => {
  const fx = await tunnelFixture(t, { pairs: [['tablet', 'phone']], limits: { maxTunnelsPerDevice: 1 } });
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  await peerTunnel(tablet, phone);
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.open', tunnelId: 'second', toDeviceId: 'tablet', purpose: 'peer' }), 'tunnel_limit');
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: '_not-standard-base64' }), 'invalid_frame');
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: randomBytes(32769).toString('base64') }), 'frame_too_large');
  assert.equal(await errorFor(phone, { v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: 'YWJj', url: '/api/files' }), 'invalid_frame');
});

test('offer cancel, revoke and disconnect immediately close tunnels; no offline byte queue', async t => {
  const fx = await tunnelFixture(t);
  const tablet = await fx.connect('tablet');
  const phone = await fx.connect('phone');
  await pairingTunnel(tablet, phone);
  tablet.send({ v: 1, op: 'pair.cancel', offerId: 'offer-test' });
  assert.equal((await phone.next('tunnel.closed')).code, 'offer_cancelled');
  await tablet.next('pair.cancelled');
  assert.equal(await errorFor(phone, { v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' }), 'offer_missing');
  await pairingTunnel(tablet, phone, { offerId: 'second-offer', tunnelId: 'second-pairing' });
  await confirmPair(tablet, phone);
  await peerTunnel(tablet, phone);
  phone.send({ v: 1, op: 'pair.revoke', peerDeviceId: 'tablet' });
  assert.equal((await tablet.next(value => value.op === 'tunnel.closed' && value.tunnelId === 'peer-test')).code, 'unpaired');
  await phone.next('pair.revoked');
  assert.equal(fx.relay.stats().tunnels, 0);
  tablet.close(); await tablet.closed;
  assert.ok(['peer_offline', 'unpaired'].includes(await errorFor(phone,
    { v: 1, op: 'tunnel.open', tunnelId: 'offline', toDeviceId: 'tablet', purpose: 'peer' })));
  assert.equal(fx.relay.stats().pendingHints, 0);
  assert.ok(fx.relay.stats().queuedBytes <= 512 * 1024);
});

test('offline hints persist metadata only, enforce TTL/cap, and require paired recipient', async t => {
  let now = Date.now();
  const fx = await tunnelFixture(t, { pairs: [['tablet', 'phone']], now: () => now, limits: { maxHints: 1, maxHintsPerDevice: 1 } });
  const tablet = await fx.connect('tablet');
  const frame = { v: 1, op: 'wake.hint', hintId: 'wake-one', toDeviceId: 'phone', kind: 'invite', expiresAt: now + 1000 };
  tablet.send(frame); await tablet.next('wake.stored');
  assert.equal(await errorFor(tablet, { ...frame, hintId: 'wake-two' }), 'hint_limit');
  assert.equal(await errorFor(tablet, { ...frame, hintId: 'secret-body', body: 'not-allowed' }), 'invalid_frame');
  assert.equal(await errorFor(tablet, { ...frame, toDeviceId: 'stranger' }), 'unpaired');
  const disk = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(disk.hints[0]).sort(), ['expiresAt', 'fromDeviceId', 'hintId', 'kind', 'toDeviceId']);
  const phone = await fx.connect('phone');
  const hint = await phone.next('wake.hint');
  assert.equal(hint.hintId, frame.hintId);
  phone.send({ v: 1, op: 'wake.ack', fromDeviceId: 'tablet', hintId: frame.hintId });
  await phone.next('wake.acked'); assert.equal(fx.relay.stats().pendingHints, 0);
  tablet.send(frame); await tablet.next('wake.stored');
  now += 1001; await fx.relay.sweep();
  assert.equal(fx.relay.stats().pendingHints, 0);
});

test('bootstrap registration requires P-256 SPKI proof and cannot replay/overwrite another device identity', async t => {
  const bootstrapToken = randomBytes(32).toString('base64url');
  const fx = await tunnelFixture(t, { bootstrapToken, limits: { upgradeBurst: 30 } });
  const url = `http://127.0.0.1:${fx.relay.address().port}/v1/devices/register`;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const expectedId = 'dev_' + createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
  const proof = { publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    signature: sign('sha256', Buffer.from('cc-remote-register-v1:' + expectedId), privateKey).toString('base64') };
  const headers = { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' };
  const post = value => fetch(url, { method: 'POST', headers, body: JSON.stringify(value) });
  const unauthorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proof) });
  assert.equal(unauthorized.status, 403);
  assert.equal(unauthorized.headers.get('content-length'), '0');
  assert.equal((await post({ ...proof, deviceId: 'tablet' })).status, 403);
  assert.equal((await post({ ...proof, signature: sign('sha256', Buffer.from('wrong-binding'), privateKey).toString('base64') })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 403);
  const response = await post(proof);
  assert.equal(response.status, 201);
  const body = await response.text();
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const device = JSON.parse(body);
  assert.equal(device.deviceId, expectedId);
  assert.match(device.token, /^[A-Za-z0-9_-]{43}$/);
  const replay = await post(proof);
  assert.equal(replay.status, 403); // Never re-issue/rotate a token for an existing ID.
  const registered = await connectTunnel(fx.relay, device);
  registered.close();
  const persisted = await readFile(fx.stateFile, 'utf8');
  assert.equal(persisted.includes(bootstrapToken), false);
  assert.equal(persisted.includes(device.token), false);
  assert.equal(JSON.parse(persisted).devices.find(item => item.deviceId === expectedId).publicKey, proof.publicKey);
});

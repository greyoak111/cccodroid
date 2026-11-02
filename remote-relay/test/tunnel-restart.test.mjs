import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createTunnelRelayServer } from '../src/tunnel-server.mjs';
import { testDevices } from './helpers.mjs';
import { connectTunnel, pairingTunnel, confirmPair, peerTunnel } from './tunnel-helpers.mjs';

test('tunnel restart keeps confirmed pair/hints, drops every stream/offer/partial confirmation and never replays TLS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-restart-'));
  const stateFile = join(directory, 'metadata.json');
  const devices = testDevices();
  const relays = [], clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const relay of relays) await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await createTunnelRelayServer({ stateFile, devices }); relays.push(first);
  await first.listen();
  const tablet = await connectTunnel(first, devices[0]); clients.push(tablet);
  const phone = await connectTunnel(first, devices[1]); clients.push(phone);
  await pairingTunnel(tablet, phone); await confirmPair(tablet, phone); await peerTunnel(tablet, phone);
  tablet.send({ v: 1, op: 'pair.offer', offerId: 'unconsumed-old-offer', expiresAt: Date.now() + 60000 });
  await tablet.next('pair.offered');
  tablet.send({ v: 1, op: 'wake.hint', hintId: 'offline-wake', toDeviceId: 'phone', kind: 'reminder', expiresAt: Date.now() + 60000 });
  await tablet.next('wake.stored');
  const tlsLookingBytes = randomBytes(128).toString('base64');
  phone.send({ v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: tlsLookingBytes });
  await tablet.next('tunnel.data');
  await first.close();
  const disk = await readFile(stateFile, 'utf8');
  assert.equal(disk.includes(tlsLookingBytes), false);
  assert.equal(disk.includes('unconsumed-old-offer'), false);
  assert.equal(disk.includes('peer-test'), false);
  assert.equal((await stat(stateFile)).mode & 0o077, 0);
  const second = await createTunnelRelayServer({ stateFile }); relays.push(second);
  await second.listen();
  assert.equal(second.stats().pairedDevices, 1);
  assert.equal(second.stats().tunnels, 0);
  assert.equal(second.stats().offers, 0);
  const tablet2 = await connectTunnel(second, devices[0]); clients.push(tablet2);
  const phone2 = await connectTunnel(second, devices[1]); clients.push(phone2);
  assert.equal((await phone2.next('wake.hint')).hintId, 'offline-wake');
  phone2.send({ v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: tlsLookingBytes });
  assert.equal((await phone2.next('error')).code, 'tunnel_missing');
  phone2.send({ v: 1, op: 'tunnel.open', tunnelId: 'pairing-old', toDeviceId: 'tablet', purpose: 'pairing', offerId: 'unconsumed-old-offer' });
  assert.equal((await phone2.next('error')).code, 'offer_missing');
  await peerTunnel(tablet2, phone2, 'brand-new-peer');
  assert.equal(second.stats().forwardedChunks, 0);
  assert.equal(tablet2.messages.some(frame => frame.op === 'tunnel.data'), false);
  // Device trust permits a NEW TLS handshake. It does not carry any inner grant,
  // host lifecycle, run, receipt ledger or session authority across this restart.
});

test('one-sided pairing confirmation is lost on restart and cannot create trust by itself', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'partial-pair-restart-'));
  const stateFile = join(directory, 'metadata.json');
  const devices = testDevices();
  const relays = [], clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const relay of relays) await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await createTunnelRelayServer({ stateFile, devices }); relays.push(first); await first.listen();
  const tablet = await connectTunnel(first, devices[0]); clients.push(tablet);
  const phone = await connectTunnel(first, devices[1]); clients.push(phone);
  await pairingTunnel(tablet, phone);
  phone.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' }); await phone.next('pair.pending');
  await first.close();
  const second = await createTunnelRelayServer({ stateFile }); relays.push(second); await second.listen();
  const tablet2 = await connectTunnel(second, devices[0]); clients.push(tablet2);
  await connectTunnel(second, devices[1]).then(client => clients.push(client));
  tablet2.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'phone' });
  assert.equal((await tablet2.next('error')).code, 'offer_missing');
  assert.equal(second.stats().pairedDevices, 0);
});

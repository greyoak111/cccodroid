import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTunnelRelayServer } from '../src/tunnel-server.mjs';
import { testDevices } from './helpers.mjs';

export async function tunnelFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-tunnel-'));
  const devices = testDevices();
  const stateFile = join(directory, 'state.json');
  const relay = await createTunnelRelayServer({ devices, stateFile, ...options });
  await relay.listen();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { relay, devices, stateFile, directory,
    async connect(deviceId, options) {
      const client = await connectTunnel(relay, devices.find(device => device.deviceId === deviceId), options);
      clients.push(client); return client;
    } };
}
export async function connectTunnel(relay, device, { authenticate = true } = {}) {
  // Exercise the platform's standards-based WebSocket: no custom headers, no ws
  // client extensions are needed for production gateway integration.
  const ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}/v1/relay`);
  const messages = [];
  const waiters = [];
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event), { once: true }));
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    const index = waiters.findIndex(waiter => waiter.match(value));
    if (index < 0) messages.push(value);
    else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket_failed')), { once: true });
  });
  const client = { ws, messages, closed,
    send(frame) { ws.send(JSON.stringify(frame)); },
    next(match, timeout = 2500) {
      const predicate = typeof match === 'function' ? match : value => value.op === match;
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match: predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`tunnel_message_timeout:${typeof match === 'string' ? match : 'predicate'}`)); }, timeout);
        waiters.push(waiter);
      });
    },
    close() { if (ws.readyState < 2) ws.close(); for (const waiter of waiters) clearTimeout(waiter.timer); },
  };
  if (authenticate) {
    client.send({ v: 1, op: 'auth', deviceId: device.deviceId, token: device.token });
    const result = await client.next(value => value.op === 'auth.ok' || value.op === 'error');
    if (result.op !== 'auth.ok') throw new Error(`auth_failed:${result.code}`);
  }
  return client;
}
export async function pairingTunnel(tablet, phone, { offerId = 'offer-test', tunnelId = 'pairing-test', now = Date.now() } = {}) {
  tablet.send({ v: 1, op: 'pair.offer', offerId, expiresAt: now + 60000 });
  await tablet.next('pair.offered');
  phone.send({ v: 1, op: 'tunnel.open', tunnelId, toDeviceId: 'tablet', purpose: 'pairing', offerId });
  await Promise.all([tablet.next(value => value.op === 'tunnel.opened' && value.tunnelId === tunnelId),
    phone.next(value => value.op === 'tunnel.opened' && value.tunnelId === tunnelId)]);
  return tunnelId;
}
export async function confirmPair(tablet, phone) {
  phone.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'tablet' });
  await phone.next('pair.pending');
  tablet.send({ v: 1, op: 'pair.confirm', peerDeviceId: 'phone' });
  await Promise.all([tablet.next('pair.confirmed'), phone.next('pair.confirmed')]);
}
export async function peerTunnel(tablet, phone, tunnelId = 'peer-test') {
  phone.send({ v: 1, op: 'tunnel.open', tunnelId, toDeviceId: 'tablet', purpose: 'peer' });
  await Promise.all([tablet.next(value => value.op === 'tunnel.opened' && value.tunnelId === tunnelId),
    phone.next(value => value.op === 'tunnel.opened' && value.tunnelId === tunnelId)]);
  return tunnelId;
}

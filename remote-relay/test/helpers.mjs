import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createRelayServer } from '../src/server.mjs';

// A deliberately labelled outer-shape fixture, not an E2EE implementation or a
// cryptographic claim. Shared 02-envelope integration has a separate test.
export function inspectFixtureEnvelope(envelope) {
  if (!envelope || Object.keys(envelope).sort().join() !== 'ciphertext,header,suite' ||
      envelope.suite !== 'TEST-OPAQUE-NOT-E2EE' || typeof envelope.ciphertext !== 'string' ||
      !/^[A-Za-z0-9_-]{16,}$/.test(envelope.ciphertext)) throw new Error('invalid_fixture_envelope');
  return envelope.header;
}
export function fixtureEnvelope({ fromDeviceId = 'phone', toDeviceId = 'tablet', kind = 'control',
  now = Date.now(), ttl = 30000, messageId = randomUUID(), ...extra } = {}) {
  return { suite: 'TEST-OPAQUE-NOT-E2EE', header: { messageId, fromDeviceId, toDeviceId,
    hostInstanceId: 'host-test', remoteSessionId: 'session-test', grantVersion: 1,
    issuedAt: now, expiresAt: now + ttl, kind, ...extra }, ciphertext: randomBytes(32).toString('base64url') };
}
export function testDevices() {
  return ['tablet', 'phone', 'stranger'].map(deviceId => ({ deviceId, token: randomBytes(32).toString('base64url') }));
}
export const route = (now = Date.now()) => ({ hostDeviceId: 'tablet', phoneDeviceId: 'phone',
  hostInstanceId: 'host-test', remoteSessionId: 'session-test', grantVersion: 1, expiresAt: now + 60000 });

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-relay-test-'));
  const devices = testDevices();
  const stateFile = join(directory, 'metadata.json');
  const relay = await createRelayServer({ devices, pairs: [['tablet', 'phone']], stateFile,
    inspectEnvelope: inspectFixtureEnvelope, ...options });
  await relay.listen();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { relay, devices, directory, stateFile,
    async connect(deviceId, other = {}) {
      const client = await connect(relay, devices.find(device => device.deviceId === deviceId), other);
      clients.push(client);
      return client;
    } };
}

export async function connect(relay, device, { headers = {}, path = '/v1/relay' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}${path}`, {
    headers: { Authorization: `Bearer ${device.token}`, 'X-Relay-Device-Id': device.deviceId, ...headers } });
  const messages = [];
  const waiters = [];
  ws.on('message', data => {
    const value = JSON.parse(data.toString());
    const index = waiters.findIndex(waiter => waiter.match(value));
    if (index < 0) messages.push(value);
    else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  ws.on('error', () => {});
  await once(ws, 'open');
  return { ws, messages,
    send(frame) { ws.send(JSON.stringify(frame)); },
    next(match, timeout = 2000) {
      const predicate = typeof match === 'function' ? match : value => value.op === match;
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match: predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`message_timeout:${typeof match === 'string' ? match : 'predicate'}`)); }, timeout);
        waiters.push(waiter);
      });
    },
    close() { ws.terminate(); for (const waiter of waiters) clearTimeout(waiter.timer); },
  };
}
export async function activate(tablet, binding = route()) {
  tablet.send({ v: 1, op: 'route.activate', route: binding });
  const status = await tablet.next(value => value.op === 'route.status' || value.op === 'error');
  if (status.status !== 'active') throw new Error(`activation_failed:${status.code}`);
  return binding;
}
export async function rejectedUpgrade(relay, device, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}${options.path || '/v1/relay'}`, {
      headers: { Authorization: `Bearer ${device.token}`, 'X-Relay-Device-Id': device.deviceId, ...options.headers } });
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('upgrade_timeout')); }, 2000);
    ws.on('error', () => {});
    ws.on('unexpected-response', (request, response) => { response.resume(); clearTimeout(timeout); ws.terminate(); resolve(response.statusCode); });
    ws.on('open', () => { clearTimeout(timeout); ws.terminate(); reject(new Error('unexpected_upgrade')); });
  });
}

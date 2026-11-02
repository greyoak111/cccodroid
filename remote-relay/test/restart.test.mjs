import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelayServer } from '../src/server.mjs';
import { MetadataStore } from '../src/store.mjs';
import { testDevices, inspectFixtureEnvelope, fixtureEnvelope, connect, activate, route, rejectedUpgrade } from './helpers.mjs';

test('restart restores device hashes/pair and unexpired ciphertext, never active routes or controls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-restart-'));
  const stateFile = join(directory, 'state.json');
  const devices = testDevices();
  const instances = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const relay of instances) await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await createRelayServer({ stateFile, devices, pairs: [['tablet', 'phone']], inspectEnvelope: inspectFixtureEnvelope });
  instances.push(first);
  await first.listen();
  const tablet = await connect(first, devices[0]); clients.push(tablet);
  const binding = route();
  await activate(tablet, binding);
  const invitation = fixtureEnvelope({ fromDeviceId: 'tablet', toDeviceId: 'phone', kind: 'invite' });
  tablet.send({ v: 1, op: 'send', envelope: invitation });
  await tablet.next('relay.status');
  await first.close();
  const disk = await readFile(stateFile, 'utf8');
  assert.equal((await stat(stateFile)).mode & 0o077, 0);
  assert.equal(disk.includes(devices[0].token), false);
  const second = await createRelayServer({ stateFile, inspectEnvelope: inspectFixtureEnvelope });
  instances.push(second);
  await second.listen();
  assert.equal(second.stats().activeRoutes, 0);
  const tablet2 = await connect(second, devices[0]); clients.push(tablet2);
  const phone = await connect(second, devices[1]); clients.push(phone);
  assert.deepEqual((await phone.next('envelope')).envelope, invitation);
  const control = fixtureEnvelope();
  phone.send({ v: 1, op: 'send', envelope: control });
  assert.equal((await phone.next(value => value.op === 'relay.status' && value.messageId === control.header.messageId)).code, 'route_inactive');
  await activate(tablet2, binding);
  const later = fixtureEnvelope();
  phone.send({ v: 1, op: 'send', envelope: later });
  assert.deepEqual((await tablet2.next('envelope')).envelope, later);
  assert.equal(tablet2.messages.some(value => value.op === 'envelope' && value.envelope.header.messageId === control.header.messageId), false);
  assert.equal(second.stats().pendingItems, 1);
});

test('revocation survives reopening even when original bootstrap device/pair config is supplied', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-revoked-'));
  const stateFile = join(directory, 'state.json');
  const devices = testDevices();
  const options = { stateFile, devices, pairs: [['tablet', 'phone']], inspectEnvelope: inspectFixtureEnvelope };
  const first = await createRelayServer(options);
  await first.revokeDevice('phone');
  await first.close();
  const second = await createRelayServer(options);
  t.after(async () => { await second.close(); await rm(directory, { recursive: true, force: true }); });
  await second.listen();
  assert.equal(await rejectedUpgrade(second, devices[1]), 401);
});

test('malformed, oversized and unsafe-mode persisted files fail closed without overwriting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-invalid-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json');
  await writeFile(stateFile, '{not-json', { mode: 0o600 });
  await assert.rejects(createRelayServer({ stateFile, inspectEnvelope: inspectFixtureEnvelope }), /invalid_state/);
  assert.equal(await readFile(stateFile, 'utf8'), '{not-json');
  await chmod(stateFile, 0o644);
  await assert.rejects(createRelayServer({ stateFile, inspectEnvelope: inspectFixtureEnvelope }), /unsafe_state_file/);
  await chmod(stateFile, 0o600);
  await writeFile(stateFile, 'x'.repeat(2000));
  await assert.rejects(createRelayServer({ stateFile, inspectEnvelope: inspectFixtureEnvelope, limits: { maxStateBytes: 1000 } }), /unsafe_state_file/);
});

test('metadata transactions serialize, atomic file is owner-only, and failed update preserves old state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json');
  const store = new MetadataStore({ stateFile });
  await store.load();
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.transaction(next => next.routes.push(index))));
  assert.deepEqual(store.snapshot().routes, Array.from({ length: 10 }, (_, index) => index));
  await assert.rejects(store.transaction(next => { next.routes.push('never'); throw new Error('failed'); }), /failed/);
  assert.equal(store.snapshot().routes.includes('never'), false);
  const reopened = new MetadataStore({ stateFile });
  await reopened.load();
  assert.deepEqual(reopened.snapshot(), store.snapshot());
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  await reopened.close();
  await store.close();
});

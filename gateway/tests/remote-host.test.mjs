import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadOrCreateIdentity } from '../gw/remote/identity.mjs';
import { createHostAdapter, createHostAdapterFromGatewayStdin, createSocketHostAdapter,
  createUnavailableHostAdapter, HOST_BOOTSTRAP_ENV, HOST_LIMITS } from '../gw/remote/host-adapter.mjs';

const now = 1000;
const binding = { fromDeviceId: 'fixture-tablet', hostInstanceId: 'fixture-host', remoteSessionId: 'remote-fixture', grantVersion: 1 };
const entry = { kind: 'request', binding, runId: 'fixture-run', requestId: 'fixture-request', eventId: 'fixture-event', expiresAt: 50000 };
const cap = 'f'.repeat(64);
const sealed = { v: 1, nonce: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(24, 2).toString('base64') };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const code = (expected) => (error) => error?.code === expected;

test('private adapter is a fixed operation allowlist, not a generic request proxy', async () => {
  const calls = [];
  const host = createHostAdapter({ request: async (op, args) => { calls.push({ op, args }); return { ok: true }; }, now: () => now });
  assert.equal(host.request, undefined);
  assert.equal(host.exportPrivateKey, undefined);
  assert.equal(host.sign, undefined);
  await host.status();
  await host.setBackgroundEnabled(true, { userInitiated: true });
  await host.reportConnectionState('resyncing', 900);
  await host.syncNotifications([entry]);
  await host.revokeNotifications(binding);
  await host.clearNotifications();
  assert.deepEqual(calls.map((c) => c.op), ['status', 'background.set', 'connection.state', 'notifications.sync', 'notifications.revoke', 'notifications.clear']);
  assert.deepEqual(calls[3].args.entries[0], entry);
});

test('background needs explicit local user action; no permission mutation operation', () => {
  const host = createHostAdapter({ request: async () => ({}) });
  assert.throws(() => host.setBackgroundEnabled(true), code('USER_ACTION_REQUIRED'));
  assert.throws(() => host.setBackgroundEnabled(true, { userInitiated: false }), code('USER_ACTION_REQUIRED'));
  assert.throws(() => host.setBackgroundEnabled('true', { userInitiated: true }), code('INVALID_HOST_REQUEST'));
  assert.equal(host.grantNotificationPermission, undefined);
  assert.equal(host.ignoreBatteryOptimizations, undefined);
});

test('notifications accept metadata only; local IDs, commands, titles, actions and URLs rejected before host I/O', () => {
  let calls = 0;
  const host = createHostAdapter({ request: async () => { calls++; return {}; }, now: () => now });
  for (const extra of ['localSessionId', 'sessionId', 'command', 'title', 'body', 'token', 'url', 'actions', 'approve'])
    assert.throws(() => host.syncNotifications([{ ...entry, [extra]: 'PRIVATE_FIXTURE' }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, binding: { ...binding, localSessionId: 'tablet-local' } }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, binding: { ...binding, remoteSessionId: '../../local-session' } }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, runId: null }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, requestId: null }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, kind: 'approve' }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications([{ ...entry, expiresAt: now + 86_400_001 }]), code('INVALID_HOST_REQUEST'));
  assert.throws(() => host.syncNotifications(Array(HOST_LIMITS.notifications + 1).fill(entry)), code('NOTIFICATION_LIMIT'));
  assert.equal(calls, 0);
});

test('vault wrapping binds purpose and record; plaintext exposed only to backend protector caller', async () => {
  const calls = [];
  const host = createHostAdapter({ request: async (op, args) => {
    calls.push({ op, args }); return op === 'vault.seal' ? sealed : { plaintext: Buffer.from('fixture-secret').toString('base64') };
  } });
  const bytes = Buffer.from('fixture-secret');
  assert.deepEqual(await host.secretProtector.seal('identity-v1', 'fixture-device', bytes), sealed);
  assert.equal(bytes.toString(), 'fixture-secret', 'caller owns original private-key buffer');
  assert.equal((await host.secretProtector.open('identity-v1', 'fixture-device', sealed)).toString(), 'fixture-secret');
  assert.deepEqual(calls.map((c) => c.op), ['vault.seal', 'vault.open']);
  assert.equal(calls[0].args.purpose, 'identity-v1');
  assert.equal(calls[0].args.recordId, 'fixture-device');
  await assert.rejects(host.secretProtector.seal('anything-else', 'fixture', bytes), code('INVALID_HOST_REQUEST'));
  await assert.rejects(host.secretProtector.seal('identity-v1', 'fixture', Buffer.alloc(HOST_LIMITS.secretBytes + 1)), code('INVALID_HOST_REQUEST'));
  await assert.rejects(host.secretProtector.open('identity-v1', '../file', sealed), code('INVALID_HOST_REQUEST'));
  await assert.rejects(host.secretProtector.open('identity-v1', 'fixture', { ...sealed, v: 2 }), code('INVALID_HOST_REQUEST'));
  await assert.rejects(host.secretProtector.open('identity-v1', 'fixture', { ...sealed, nonce: 'not base64' }), code('INVALID_HOST_REQUEST'));
});

test('02 identity store uses the exact host purpose/record/envelope API and only persists ciphertext', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.CCAPP_TMP || os.tmpdir(), 'identity-host-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  t.after(() => key.fill(0));
  const calls = [];
  // This is a fixture AES implementation behind the real host adapter API, NOT Android Keystore acceptance.
  const host = createHostAdapter({ request: async (op, args) => {
    calls.push({ op, purpose: args.purpose, recordId: args.recordId });
    const aad = Buffer.from(`cc.codroid/remote/vault/v1\n${args.purpose}\n${args.recordId}`);
    if (op === 'vault.seal') {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const raw = Buffer.from(args.plaintext, 'base64');
      try {
        const ciphertext = Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
        return { v: 1, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
      } finally { raw.fill(0); }
    }
    const raw = Buffer.from(args.envelope.ciphertext, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(args.envelope.nonce, 'base64'));
    cipher.setAAD(aad); cipher.setAuthTag(raw.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(raw.subarray(0, -16)), cipher.final()]);
    try { return { plaintext: plaintext.toString('base64') }; }
    finally { plaintext.fill(0); }
  } });
  const file = path.join(dir, 'fixture-identity.json');
  const first = await loadOrCreateIdentity({ file, secretProtector: host.secretProtector, recordId: 'device-identity', name: 'Fake Tablet' });
  const pin = first.identity.spkiSha256;
  assert.equal(first.credentials.key.asymmetricKeyType, 'ec');
  first.dispose();
  const text = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(text, /PRIVATE KEY|BEGIN CERTIFICATE|CCRID001/);
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  const second = await loadOrCreateIdentity({ file, secretProtector: host.secretProtector, recordId: 'device-identity', name: 'Fake Tablet' });
  assert.equal(second.identity.spkiSha256, pin);
  second.dispose();
  assert.equal(calls.every((c) => c.purpose === 'identity-v1' && c.recordId === 'device-identity'), true);
  assert.deepEqual(calls.map((c) => c.op), ['vault.seal', 'vault.open', 'vault.seal', 'vault.open']);
  const persisted = JSON.parse(text);
  await assert.rejects(host.secretProtector.open('pairing-v1', 'device-identity', persisted.sealed), code('HOST_UNAVAILABLE'));
  await assert.rejects(host.secretProtector.open('identity-v1', 'different-record', persisted.sealed), code('HOST_UNAVAILABLE'));
});

test('unavailable host never falls back to exporting or storing plaintext identity', async () => {
  const host = createUnavailableHostAdapter();
  assert.equal(host.available, false);
  const status = await host.status();
  assert.equal(status.shouldConnect, false);
  assert.equal(status.backgroundEffective, false);
  assert.equal(status.realDeviceBackgroundVerified, false);
  await assert.rejects(host.secretProtector.seal('identity-v1', 'fixture', Buffer.from('x')), code('HOST_UNAVAILABLE'));
  await assert.rejects(host.setBackgroundEnabled(true, { userInitiated: true }), code('HOST_UNAVAILABLE'));
});

async function fakeHost(t, reply) {
  // Unix-domain paths have a 108-byte platform limit; stay inside the runner's isolated TMPDIR.
  const base = process.env.CCAPP_TMP || os.tmpdir();
  const dir = await fs.mkdtemp(path.join(base, 'rh-'));
  const socketPath = path.join(dir, '.remote-host-v1.sock');
  const peers = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      const req = JSON.parse(bytes.toString('utf8').trim()); requests.push(req);
      reply(socket, req);
    });
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return { socketPath, requests };
}

test('filesystem socket transport authenticates capability and verifies version/request correlation', async (t) => {
  const fixture = await fakeHost(t, (socket, req) => {
    assert.equal(req.capability, cap);
    assert.deepEqual(req.args, {});
    const response = JSON.stringify({ v: 1, id: req.id, ok: true, result: { shouldConnect: true } }) + '\n';
    socket.write(response.slice(0, 7)); socket.end(response.slice(7));
  });
  const host = createSocketHostAdapter({ ...fixture, capability: cap });
  assert.deepEqual(await host.status(), { shouldConnect: true });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].op, 'status');
  assert.throws(() => createSocketHostAdapter({ socketPath: 'tcp://127.0.0.1:123', capability: cap }), code('INVALID_HOST_BOOTSTRAP'));
  assert.throws(() => createSocketHostAdapter({ socketPath: fixture.socketPath, capability: 'short' }), code('INVALID_HOST_BOOTSTRAP'));
});

test('untrusted/malformed/oversized socket replies cannot leak server error details', async (t) => {
  const fixtures = [
    (s, r) => s.end(JSON.stringify({ v: 1, id: 'other-request', ok: true, result: {} }) + '\n'),
    (s, r) => s.end('{broken json}\n'),
    (s, r) => s.end(JSON.stringify({ v: 1, id: r.id, ok: true, result: {}, extra: 'secret' }) + '\n'),
    (s) => s.end('x'.repeat(HOST_LIMITS.lineBytes + 1)),
    (s, r) => s.end(JSON.stringify({ v: 1, id: r.id, ok: false, error: 'SECRET_TOKEN_do_not_echo' }) + '\n'),
  ];
  for (const reply of fixtures) {
    const f = await fakeHost(t, reply);
    const host = createSocketHostAdapter({ ...f, capability: cap });
    await assert.rejects(host.status(), (e) => !e.message.includes('SECRET_TOKEN') && ['INVALID_HOST_RESPONSE', 'HOST_FRAME_LIMIT', 'HOST_OPERATION_FAILED'].includes(e.code));
  }
});

test('host sockets have bounded pending work and a real timeout', async (t) => {
  const f = await fakeHost(t, () => {});
  const host = createSocketHostAdapter({ ...f, capability: cap, timeoutMs: 50 });
  const pending = Array.from({ length: HOST_LIMITS.pending }, () => host.status().catch((e) => e));
  await assert.rejects(host.status(), code('HOST_BUSY'));
  const results = await Promise.all(pending);
  assert.equal(results.every((e) => e.code === 'HOST_TIMEOUT'), true);
});

test('stdin bootstrap is consumed once and removed from child environment', async () => {
  const input = new PassThrough();
  const env = { [HOST_BOOTSTRAP_ENV]: 'stdin-v1', KEEP: 'fixture' };
  const pending = createHostAdapterFromGatewayStdin({ input, env });
  input.write(JSON.stringify({ v: 1, type: 'cc.remote.host.bootstrap', socketPath: '/private/.remote-host-v1.sock', capability: cap }) + '\n');
  const host = await pending;
  assert.equal(host.available, true);
  assert.equal(env[HOST_BOOTSTRAP_ENV], undefined);
  assert.equal(env.KEEP, 'fixture');
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.isPaused(), true);
});

test('missing, invalid, oversized or timed-out bootstrap is fail closed', async () => {
  assert.equal((await createHostAdapterFromGatewayStdin({ env: {} })).available, false);
  assert.equal((await createHostAdapterFromGatewayStdin({ env: { [HOST_BOOTSTRAP_ENV]: 'guess' } })).available, false);
  for (const value of ['invalid\n', 'x'.repeat(2049) + '\n', JSON.stringify({ v: 1, type: 'cc.remote.host.bootstrap', socketPath: '/private/.remote-host-v1.sock', capability: cap, extra: 'x' }) + '\n']) {
    const input = new PassThrough();
    const pending = createHostAdapterFromGatewayStdin({ input, env: { [HOST_BOOTSTRAP_ENV]: 'stdin-v1' } });
    input.write(value);
    assert.equal((await pending).available, false);
    assert.equal(input.listenerCount('data'), 0);
  }
  const input = new PassThrough();
  assert.equal((await createHostAdapterFromGatewayStdin({ input, env: { [HOST_BOOTSTRAP_ENV]: 'stdin-v1' }, timeoutMs: 50 })).available, false);
});

test('backend policy observer survives UI absence and stops without extra polling', async () => {
  let calls = 0;
  const host = createHostAdapter({ request: async () => ({ shouldConnect: ++calls > 1 }) });
  const values = [];
  let stop;
  await new Promise((resolve) => {
    stop = host.watchPolicy((status) => { values.push(status.shouldConnect); if (values.length === 2) { stop(); resolve(); } }, { intervalMs: 250 });
  });
  assert.deepEqual(values, [false, true]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 2);
});

test('Android source boundary keeps private socket, private Keystore key and remote-only deep route', async () => {
  const java = async (name) => fs.readFile(path.join(root, 'android/java/cc/codroid', `${name}.java`), 'utf8');
  const host = await java('RemoteHost');
  const store = await java('RemoteKeyStore');
  const notes = await java('RemoteNotifications');
  const routes = await java('RemoteRoutes');
  assert.match(host, /getPeerCredentials\(\)\.getUid\(\)/);
  assert.match(host, /directGatewayChild\(peerPid\)/);
  assert.match(host, /Namespace\.FILESYSTEM/);
  assert.match(host, /Os\.chmod\(socketFile\.getPath\(\), 0600\)/);
  assert.match(host, /process\.getOutputStream\(\)/);
  assert.doesNotMatch(host, /@(?:android\.webkit\.)?JavascriptInterface|startForegroundService|pm grant|settings put/);
  assert.match(store, /"AndroidKeyStore"/);
  assert.match(store, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(store, /if \(!create\) throw new java\.security\.KeyStoreException/);
  assert.match(store, /Cipher\.DECRYPT_MODE, key\(false\)/);
  assert.match(store, /cipher\.updateAAD\(aad\(purpose, recordId\)\)/);
  assert.doesNotMatch(store, /getEncoded\(|exportPrivateKey|Log\./);
  assert.doesNotMatch(notes, /\.addAction\(/);
  assert.match(notes, /VISIBILITY_PRIVATE/);
  assert.match(notes, /setPublicVersion/);
  assert.doesNotMatch(notes, /optString\("(?:command|title|body|text|localSessionId)"/);
  assert.match(routes, /OPEN_REMOTE_SESSION/);
  assert.match(routes, /cccodroid-remote/);
  assert.doesNotMatch(routes, /\.openSession\(|putExtra\("session"/);
});

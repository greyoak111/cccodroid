import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createPublicKey, randomBytes } from 'node:crypto';
import { loadOrCreateIdentity, IDENTITY_LIMITS } from '../gw/remote/identity.mjs';
import { identityFromCertificate, createPairingChannel, secureChannelInfo } from '../gw/remote/crypto.mjs';
import { Duplex } from 'node:stream';
import { createHostAdapter, createUnavailableHostAdapter } from '../gw/remote/host-adapter.mjs';
import { createRemoteStore } from '../gw/remote/store.mjs';

assert.equal(process.env.CCAPP_TEST, '1', 'Use node scripts/test.mjs remote-identity');
const root = await fs.mkdtemp(path.join(os.homedir(), 'fake-remote-identity-'));
await fs.chmod(root, 0o700);
after(() => fs.rm(root, { recursive: true, force: true }));
let directoryIndex = 0;
async function directory() {
  const value = path.join(root, String(directoryIndex++));
  await fs.mkdir(value, { mode: 0o700 });
  return value;
}

// This is only an isolated fake Android host. Production crypto is implemented
// by Android Keystore; the test fake deliberately uses a generated local key.
function fakeHost() {
  const master = randomBytes(32), calls = [], observedPlaintexts = [];
  const request = async (op, args) => {
    calls.push({ op, purpose: args.purpose, recordId: args.recordId });
    const aad = Buffer.from('cc.codroid/remote/vault/v1\n' + args.purpose + '\n' + args.recordId);
    if (op === 'vault.seal') {
      const plaintext = Buffer.from(args.plaintext, 'base64');
      observedPlaintexts.push(plaintext);
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      return { v: 1, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
    }
    if (op === 'vault.open') {
      const nonce = Buffer.from(args.envelope.nonce, 'base64'), ciphertext = Buffer.from(args.envelope.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', master, nonce);
      decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
      return { plaintext: plaintext.toString('base64') };
    }
    throw new Error('test host only provides vault');
  };
  const adapter = createHostAdapter({ request });
  return { secretProtector: adapter.secretProtector, calls, observedPlaintexts,
    close() { master.fill(0); observedPlaintexts.forEach((bytes) => bytes.fill(0)); } };
}

async function makeIdentity(options = {}) {
  const dir = await directory(), host = fakeHost(), file = path.join(dir, 'identity.json');
  const value = await loadOrCreateIdentity({ file, secretProtector: host.secretProtector, name: 'Fake Tablet', ...options });
  return { ...value, host, dir, file, close() { value.dispose(); host.close(); } };
}

test('P-256 identity generates and reloads via actual host-adapter vault interface', async () => {
  const created = await makeIdentity();
  let loaded;
  try {
    assert.equal(created.credentials.key.type, 'private');
    assert.equal(created.credentials.key.asymmetricKeyType, 'ec');
    assert.equal(created.credentials.key.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.equal(created.identity.name, 'Fake Tablet');
    assert.equal(created.identity.deviceId, identityFromCertificate(created.credentials.cert).deviceId);
    const initialSpki = createPublicKey(created.credentials.key).export({ type: 'spki', format: 'der' });
    loaded = await loadOrCreateIdentity({ file: created.file, secretProtector: created.host.secretProtector, name: 'Renamed Device',
      spawnProcess: () => assert.fail('must not invoke OpenSSL when loading') });
    assert.equal(loaded.identity.deviceId, created.identity.deviceId);
    assert.equal(loaded.identity.spkiSha256, created.identity.spkiSha256);
    assert.equal(loaded.identity.name, 'Renamed Device');
    assert.deepEqual(createPublicKey(loaded.credentials.key).export({ type: 'spki', format: 'der' }), initialSpki);
    assert.equal(created.host.calls.every((call) => call.purpose === 'identity-v1' && call.recordId === 'device-identity'), true);
    assert.ok(created.host.calls.some((call) => call.op === 'vault.seal'));
    assert.ok(created.host.calls.some((call) => call.op === 'vault.open'));
  } finally { loaded?.dispose(); created.close(); }
});

test('only ciphertext lands on disk, private PKCS8 never temporary files/argv/env', async () => {
  const dir = await directory(), host = fakeHost(), file = path.join(dir, 'identity.json');
  let processCalls = 0;
  const spawnProcess = (command, args, options) => {
    processCalls++;
    assert.equal(command, 'sh');
    assert.equal(args[0], '-c');
    assert.equal(args[2], 'cc-remote-certificate');
    assert.equal(args[3], 'openssl');
    assert.equal(args[1].includes('"$1" pkey -inform DER -outform DER | exec "$1" req'), true);
    assert.equal(args[1].includes('-key /dev/stdin'), true);
    assert.equal(args[1].includes('-config /dev/null'), true);
    assert.equal(args[1].includes('-keyout'), false);
    assert.equal(args[1].includes(' -out '), false);
    assert.equal(args.some((arg) => arg.includes('PRIVATE KEY')), false);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'OPENSSL_CONF', 'PATH']);
    assert.equal(options.env.HOME, dir);
    assert.equal(options.shell, false);
    return spawn(command, args, options);
  };
  const result = await loadOrCreateIdentity({ file, secretProtector: host.secretProtector, spawnProcess });
  try {
    assert.equal(processCalls, 1);
    assert.deepEqual(await fs.readdir(dir), ['identity.json']);
    const bytes = await fs.readFile(file), record = JSON.parse(bytes.toString());
    assert.deepEqual(Object.keys(record).sort(), ['purpose', 'recordId', 'sealed', 'v']);
    assert.equal(record.purpose, 'identity-v1');
    assert.equal(record.sealed.v, 1);
    assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
    assert.equal(bytes.includes(Buffer.from('CERTIFICATE')), false);
    assert.equal(bytes.includes(result.credentials.cert), false);
    const der = result.credentials.key.export({ type: 'pkcs8', format: 'der' });
    try { assert.equal(bytes.includes(der), false); }
    finally { der.fill(0); }
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { result.dispose(); host.close(); }
});

test('Android loader identity pipeline uses system shell/linker without ambient secrets', async () => {
  const dir = await directory(), host = fakeHost();
  const previous = { exec: process.env.CCAPP_EXEC, prefix: process.env.CCAPP_PREFIX };
  const executable = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(path.isAbsolute(executable));
  process.env.CCAPP_EXEC = 'loader';
  process.env.CCAPP_PREFIX = path.dirname(path.dirname(executable));
  let called = false, result;
  try {
    result = await loadOrCreateIdentity({ file: path.join(dir, 'identity.json'), secretProtector: host.secretProtector,
      spawnProcess(command, args, options) {
        called = true;
        assert.equal(command, '/system/bin/sh');
        assert.equal(args[3], '/system/bin/linker64'); assert.equal(args[4], executable);
        assert.ok(args[1].includes('"$1" "$2" pkey'));
        assert.ok(args[1].includes('| exec "$1" "$2" req'));
        assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'OPENSSL_CONF', 'PATH']);
        assert.equal(options.env.LD_PRELOAD, undefined); assert.equal(options.env.CCAPP_REMOTE_HOST_BOOTSTRAP, undefined);
        // Exercise the actual system linker on Android; other hosts inspect the
        // exact plan and run the equivalent direct pipeline, not pretend Android.
        if (process.platform === 'android') return spawn(command, args, options);
        return spawn('sh', ['-c', args[1].replaceAll('"$1" "$2"', '"$1"'), 'cc-remote-certificate', executable], options);
      } });
    assert.equal(called, true); assert.equal(result.credentials.key.asymmetricKeyType, 'ec');
    assert.deepEqual(await fs.readdir(dir), ['identity.json']);
  } finally {
    result?.dispose(); host.close();
    if (previous.exec === undefined) delete process.env.CCAPP_EXEC; else process.env.CCAPP_EXEC = previous.exec;
    if (previous.prefix === undefined) delete process.env.CCAPP_PREFIX; else process.env.CCAPP_PREFIX = previous.prefix;
  }
});

test('dispose clears returned credentials; no private key in public identity', async () => {
  const result = await makeIdentity();
  try {
    assert.deepEqual(Object.keys(result.identity).sort(), ['deviceId', 'name', 'spkiSha256']);
    const cert = result.credentials.cert;
    result.dispose();
    assert.equal(result.credentials.key, null);
    assert.equal(cert.every((byte) => byte === 0), true);
    result.dispose();
  } finally { result.close(); }
});

test('unavailable or absent host vault never falls back to plaintext identity', async () => {
  const dir = await directory(), file = path.join(dir, 'identity.json');
  await assert.rejects(loadOrCreateIdentity({ file }), { code: 'IDENTITY_VAULT_REQUIRED' });
  await assert.rejects(loadOrCreateIdentity({ file, secretProtector: createUnavailableHostAdapter().secretProtector }),
    { code: 'IDENTITY_VAULT_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('sealed record corruption, wrong AAD label and different master do not regenerate keys', async () => {
  const result = await makeIdentity();
  const other = fakeHost();
  try {
    const original = await fs.readFile(result.file);
    const base = { file: result.file, secretProtector: result.host.secretProtector,
      spawnProcess: () => assert.fail('must not replace existing identity') };
    await assert.rejects(loadOrCreateIdentity({ ...base, recordId: 'other-record' }), { code: 'IDENTITY_RECORD_MISMATCH' });
    await assert.rejects(loadOrCreateIdentity({ ...base, secretProtector: other.secretProtector }), { code: 'IDENTITY_VAULT_UNAVAILABLE' });
    const record = JSON.parse(original.toString());
    const ciphertext = Buffer.from(record.sealed.ciphertext, 'base64'); ciphertext[0] ^= 1;
    record.sealed.ciphertext = ciphertext.toString('base64');
    await fs.writeFile(result.file, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(loadOrCreateIdentity(base), { code: 'IDENTITY_VAULT_UNAVAILABLE' });
    assert.deepEqual(await fs.readdir(result.dir), ['identity.json']);
    await fs.writeFile(result.file, 'bad-json', { mode: 0o600 });
    await assert.rejects(loadOrCreateIdentity(base), { code: 'IDENTITY_LOAD_FAILED' });
  } finally { other.close(); result.close(); }
});

test('private directory, file permissions, symlinks and size are validated', async () => {
  const result = await makeIdentity();
  const options = { file: result.file, secretProtector: result.host.secretProtector };
  try {
    await fs.chmod(result.file, 0o644);
    await assert.rejects(loadOrCreateIdentity(options), { code: 'UNSAFE_IDENTITY_FILE' });
    await fs.chmod(result.file, 0o600);
    await fs.chmod(result.dir, 0o755);
    await assert.rejects(loadOrCreateIdentity(options), { code: 'UNSAFE_IDENTITY_DIRECTORY' });
    await fs.chmod(result.dir, 0o700);
    const linked = path.join(result.dir, 'linked.json');
    await fs.symlink(result.file, linked);
    await assert.rejects(loadOrCreateIdentity({ ...options, file: linked }), { code: 'IDENTITY_LOAD_FAILED' });
    await fs.unlink(linked);
    await fs.writeFile(result.file, Buffer.alloc(IDENTITY_LIMITS.sealedBytes + 1), { mode: 0o600 });
    await assert.rejects(loadOrCreateIdentity(options), { code: 'UNSAFE_IDENTITY_FILE' });
    await fs.unlink(result.file);
    await fs.mkdir(result.file, { mode: 0o700 });
    await assert.rejects(loadOrCreateIdentity(options), { code: 'UNSAFE_IDENTITY_FILE' });
  } finally { result.close(); }
});

test('FIFO identity replacement is rejected without waiting for a writer', async () => {
  const dir = await directory(), host = fakeHost(), file = path.join(dir, 'identity.json');
  const fifo = spawnSync('mkfifo', ['-m', '600', file], { timeout: 2000, encoding: 'utf8' });
  assert.equal(fifo.status, 0, 'mkfifo is required for this synthetic regular-file boundary test');
  const started = Date.now();
  try {
    await assert.rejects(loadOrCreateIdentity({ file, secretProtector: host.secretProtector }), { code: 'UNSAFE_IDENTITY_FILE' });
    assert.ok(Date.now() - started < 1000, 'FIFO open must be nonblocking');
    assert.equal(host.calls.length, 0);
  } finally { host.close(); }
});

test('expired certificates and invalid decrypted data fail instead of rotating identity', async () => {
  const result = await makeIdentity();
  try {
    const bytes = await fs.readFile(result.file);
    await assert.rejects(loadOrCreateIdentity({ file: result.file, secretProtector: result.host.secretProtector,
      now: () => Date.now() + 366 * 86400_000, spawnProcess: () => assert.fail('no key rotation') }),
    { code: 'CERTIFICATE_EXPIRED' });
    assert.deepEqual(await fs.readFile(result.file), bytes);
    await assert.rejects(loadOrCreateIdentity({ file: result.file, secretProtector: {
      seal: result.host.secretProtector.seal, open: async () => Buffer.alloc(1),
    } }), { code: 'INVALID_IDENTITY_RECORD' });
  } finally { result.close(); }
});

test('OpenSSL failures and excessive subprocess output stay bounded and sanitized', async () => {
  const dir = await directory(), host = fakeHost();
  try {
    for (const [opensslPath, spawnProcess, code] of [
      [path.join(dir, 'does-not-exist'), spawn, 'IDENTITY_CERTIFICATE_FAILED'],
      ['ignored', (command, args, options) => spawn(process.execPath,
        ['-e', 'process.stdout.write("FAKE_SECRET_".repeat(4000))'], options), 'IDENTITY_CERTIFICATE_LIMIT'],
      ['ignored', (command, args, options) => spawn(process.execPath,
        ['-e', 'process.stderr.write("FAKE_SECRET_".repeat(4000))'], options), 'IDENTITY_CERTIFICATE_LIMIT'],
      ['ignored', (command, args, options) => spawn(process.execPath,
        ['-e', 'process.stderr.write("FAKE_PRIVATE_SECRET");process.exit(2)'], options), 'IDENTITY_CERTIFICATE_FAILED'],
    ]) {
      let error;
      try { await loadOrCreateIdentity({ file: path.join(dir, 'identity.json'), secretProtector: host.secretProtector, opensslPath, spawnProcess }); }
      catch (caught) { error = caught; }
      assert.equal(error?.code, code);
      assert.equal(error.message.includes('FAKE_'), false);
      assert.deepEqual(await fs.readdir(dir), []);
    }
  } finally { host.close(); }
});

test('subprocess timeout does not create a key file or leave a failed identity', async () => {
  const dir = await directory(), host = fakeHost();
  try {
    await assert.rejects(loadOrCreateIdentity({ file: path.join(dir, 'identity.json'), secretProtector: host.secretProtector,
      processTimeoutMs: 20, spawnProcess: (command, args, options) => spawn(process.execPath,
        ['-e', 'process.stdin.resume();setTimeout(()=>{},10000)'], options) }), { code: 'IDENTITY_CERTIFICATE_TIMEOUT' });
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { host.close(); }
});

test('loaded software KeyObject feeds Node TLS and caller may dispose immediately', async () => {
  const tablet = await makeIdentity(), phone = await makeIdentity();
  const endpoints = [];
  for (let side = 0; side < 2; side++) endpoints.push(new Duplex({ read() {},
    write(bytes, encoding, done) { endpoints[1 - side].push(Buffer.from(bytes)); done(); } }));
  const server = createPairingChannel({ role: 'server', transport: endpoints[1], credentials: tablet.credentials });
  const client = createPairingChannel({ role: 'client', transport: endpoints[0], credentials: phone.credentials,
    peerPin: tablet.identity.spkiSha256 });
  tablet.dispose(); phone.dispose();
  try {
    await Promise.all([server.ready, client.ready]);
    assert.equal(secureChannelInfo(server).peerIdentity.spkiSha256, phone.identity.spkiSha256);
    assert.equal(secureChannelInfo(client).peerIdentity.spkiSha256, tablet.identity.spkiSha256);
    assert.equal(tablet.credentials.key, null);
    assert.equal(phone.credentials.key, null);
  } finally { server.close(); client.close(); tablet.close(); phone.close(); }
});

test('remote store clear invalidates a pending credential seal without restoring config or identity', async () => {
  const dir = await directory(), file = path.join(dir, 'metadata.json');
  let started = false, unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const store = createRemoteStore(file, { async seal() { started = true; await gate; return 'fake-sealed-delayed'; } });
  store.setIdentity({ deviceId: 'fake-old-identity' });
  store.putPeer({ deviceId: 'fake-old-peer' });
  store.putGrant({ remoteSessionId: 'fake-old-grant', phoneDeviceId: 'fake-old-peer' });
  const pending = store.configure({ serverUrl: 'https://old.example.invalid', deviceName: 'Old' }, 'fake-old-credential');
  const rejected = assert.rejects(pending, { code: 'REMOTE_STORE_STALE_CONFIG' });
  try {
    assert.equal(started, true);
    store.clear();
    const empty = { version: 1, config: null, identity: null, peers: [], grants: [] };
    assert.deepEqual(store.snapshot(), empty);
    // Keeping the invalidated vault call as the one in-flight call also bounds
    // repeated clear/configure attempts; no unbounded queue retains secrets.
    await assert.rejects(store.configure({ serverUrl: 'https://new.example.invalid' }, 'fake-new-credential'), { code: 'REMOTE_STORE_BUSY' });
    unblock();
    await rejected;
    assert.deepEqual(store.snapshot(), empty);
    assert.deepEqual(createRemoteStore(file).snapshot(), empty, 'late seal must not rewrite the cleared disk record');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await store.configure({ serverUrl: 'https://fresh.example.invalid', deviceName: 'Fresh' }, 'fake-fresh-credential');
    assert.equal(store.config().deviceName, 'Fresh', 'settled stale call releases the bounded writer slot');
  } finally { unblock(); await rejected; }
});

test('remote store rejects a second configure before any vault call or out-of-order write', async () => {
  const calls = [];
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const store = createRemoteStore(null, { async seal(credential) {
    calls.push(credential);
    if (credential === 'fake-first') await gate;
    return 'sealed-' + credential;
  } });
  const pending = store.configure({ serverUrl: 'https://first.example.invalid', deviceName: 'First' }, 'fake-first');
  try {
    await assert.rejects(store.configure({ serverUrl: 'https://second.example.invalid', deviceName: 'Second' }, 'fake-second'), { code: 'REMOTE_STORE_BUSY' });
    await assert.rejects(store.configure({ serverUrl: 'https://third.example.invalid', deviceName: 'Third' }), { code: 'REMOTE_STORE_BUSY' });
    assert.deepEqual(calls, ['fake-first']);
    assert.equal(store.config(), null);
    unblock();
    await pending;
    assert.equal(store.config().deviceName, 'First');
    assert.equal(store.config().sealedCredential, 'sealed-fake-first');
    await store.configure({ serverUrl: 'https://second.example.invalid', deviceName: 'Second' }, 'fake-second');
    assert.equal(store.config().deviceName, 'Second', 'a later explicit retry succeeds after the earlier call settles');
    assert.deepEqual(calls, ['fake-first', 'fake-second']);
  } finally { unblock(); await pending; }
});

test('remote store vault failure preserves previous config and releases configure slot', async () => {
  const store = createRemoteStore(null, {
    async seal(credential) { if (credential === 'fake-failing') throw new Error('fake vault outage'); return 'sealed-' + credential; },
    async unseal(sealed) { return sealed.replace(/^sealed-/, ''); },
  });
  await store.configure({ serverUrl: 'https://relay.example.invalid', deviceName: 'Original' }, 'fake-original');
  const before = store.snapshot();
  await assert.rejects(store.configure({ serverUrl: 'https://replacement.example.invalid', deviceName: 'Rejected' }, 'fake-failing'));
  assert.deepEqual(store.snapshot(), before);
  await store.configure({ serverUrl: 'https://relay.example.invalid', deviceName: 'Renamed' });
  assert.equal(store.config().deviceName, 'Renamed');
  assert.equal(store.config().sealedCredential, 'sealed-fake-original');
  assert.equal(await store.credential(), 'fake-original');
});

for (const stage of ['write', 'fsync', 'close', 'rename']) test(`remote store ${stage} failure removes only its temporary file and preserves committed grants across retries`, async () => {
  const dir = await directory(), file = path.join(dir, 'metadata.json'), store = createRemoteStore(file);
  store.setIdentity({ deviceId: 'fake-committed-identity' });
  store.putGrant({ remoteSessionId: 'pending-release', hostDeviceId: 'fake-peer', state: 'release-pending', expiresAt: Date.now() + 60_000 });
  const unrelated = path.join(dir, 'unrelated.new'), unrelatedBytes = Buffer.from('unrelated synthetic file');
  await fs.writeFile(unrelated, unrelatedBytes, { mode: 0o600 });
  const before = store.snapshot(), diskBefore = await fs.readFile(file), namesBefore = (await fs.readdir(dir)).sort();
  const original = Object.fromEntries(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'].map((name) => [name, fsSync[name]]));
  const temporaryFds = new Set(), temporaryPaths = new Set();
  let failures = 0;
  const fail = () => { failures++; throw Object.assign(new Error('synthetic remote store I/O failure'), { code: 'EIO' }); };
  try {
    // Never fail unrelated I/O: associate only this store's freshly opened
    // temporary paths with their actual fds. No await while hooks are installed.
    fsSync.openSync = (candidate, ...args) => {
      const fd = original.openSync(candidate, ...args);
      if (typeof candidate === 'string' && candidate.startsWith(file + '.') && candidate.endsWith('.new')) {
        temporaryFds.add(fd); temporaryPaths.add(candidate);
        assert.equal(fsSync.fstatSync(fd).mode & 0o777, 0o600);
      }
      return fd;
    };
    fsSync.writeFileSync = (fd, ...args) => {
      if (temporaryFds.has(fd) && stage === 'write') {
        original.writeFileSync(fd, '{"syntheticPartial":');
        fail();
      }
      return original.writeFileSync(fd, ...args);
    };
    fsSync.fsyncSync = (fd) => {
      if (temporaryFds.has(fd) && stage === 'fsync') fail();
      return original.fsyncSync(fd);
    };
    fsSync.closeSync = (fd) => {
      const own = temporaryFds.has(fd), result = original.closeSync(fd);
      if (own) temporaryFds.delete(fd);
      // The real fd is closed before injecting the close error; the regression
      // must not itself leak descriptors or affect a subsequently reused fd.
      if (own && stage === 'close') fail();
      return result;
    };
    fsSync.renameSync = (from, to) => {
      if (temporaryPaths.has(from) && to === file && stage === 'rename') fail();
      return original.renameSync(from, to);
    };
    for (let i = 0; i < 4; i++) {
      assert.throws(() => store.putGrant({ remoteSessionId: 'failed-invite-' + i, localSessionId: 'fake-session', state: 'invited', expiresAt: Date.now() + 60_000 }), { code: 'EIO' });
      assert.deepEqual(store.snapshot(), before, 'failed save rolls back in-memory grants');
      assert.deepEqual(fsSync.readFileSync(file), diskBefore, 'failed save does not replace the last committed file');
      assert.deepEqual(createRemoteStore(file).snapshot(), before, 'reload keeps the committed release tombstone');
      assert.deepEqual(fsSync.readdirSync(dir).sort(), namesBefore, 'retries cannot accumulate temporary files');
      assert.deepEqual(fsSync.readFileSync(unrelated), unrelatedBytes, 'cleanup must not touch unrelated files');
      assert.equal(temporaryFds.size, 0);
    }
  } finally {
    for (const [name, value] of Object.entries(original)) fsSync[name] = value;
    for (const fd of temporaryFds) try { original.closeSync(fd); } catch {}
  }
  assert.equal(failures, 4); assert.equal(temporaryPaths.size, 4);
  const recovered = { remoteSessionId: 'successful-retry', localSessionId: 'fake-session', state: 'invited', expiresAt: Date.now() + 60_000 };
  store.putGrant(recovered);
  assert.deepEqual(store.grants(), [...before.grants, recovered]);
  assert.deepEqual(createRemoteStore(file).snapshot(), store.snapshot());
  assert.deepEqual((await fs.readdir(dir)).sort(), namesBefore);
  assert.deepEqual(await fs.readFile(unrelated), unrelatedBytes);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('remote store failed clear still invalidates the already pending configure', async () => {
  const dir = await directory(), file = path.join(dir, 'metadata.json');
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const store = createRemoteStore(file, { async seal(value) { if (value === 'fake-delayed') await gate; return 'sealed-' + value; } });
  await store.configure({ serverUrl: 'https://before.example.invalid', deviceName: 'Before' }, 'fake-initial');
  const before = store.snapshot();
  const pending = store.configure({ serverUrl: 'https://after.example.invalid', deviceName: 'After' }, 'fake-delayed');
  const rejected = assert.rejects(pending, { code: 'REMOTE_STORE_STALE_CONFIG' });
  try {
    // A synthetic directory at the target makes atomic rename fail; never make
    // a real app file unwritable or depend on platform-specific chmod behavior.
    await fs.unlink(file);
    await fs.mkdir(file, { mode: 0o700 });
    assert.throws(() => store.clear());
    assert.deepEqual(store.snapshot(), before);
    unblock();
    await rejected;
    assert.deepEqual(store.snapshot(), before, 'rollback of clear must not revive the cancelled writer');
    await fs.rmdir(file);
    await store.configure({ serverUrl: 'https://before.example.invalid', deviceName: 'Recovered' });
    assert.equal(store.config().deviceName, 'Recovered');
    assert.equal(store.config().sealedCredential, before.config.sealedCredential);
    assert.equal(createRemoteStore(file).config().deviceName, 'Recovered');
  } finally { unblock(); await rejected; }
});

test('remote store reclaims terminal local grants and expired records without dropping unacknowledged releases', async () => {
  const dir = await directory(), file = path.join(dir, 'grant-pruning.json'), store = createRemoteStore(file), now = 1_700_000_000_000;
  store.putGrant({ remoteSessionId: 'active-local', localSessionId: 'session', state: 'active', expiresAt: now + 1000 });
  store.putGrant({ remoteSessionId: 'revoked-local', localSessionId: 'session', state: 'revoked', expiresAt: now + 1000 });
  store.putGrant({ remoteSessionId: 'expired-active', localSessionId: 'session', state: 'active', expiresAt: now });
  store.putGrant({ remoteSessionId: 'pending-release', hostDeviceId: 'peer', state: 'release-pending', expiresAt: now + 1000 });
  store.putGrant({ remoteSessionId: 'expired-release', hostDeviceId: 'peer', state: 'release-pending', expiresAt: now });
  store.pruneGrants(now);
  assert.deepEqual(store.grants().map((g) => g.remoteSessionId), ['active-local', 'pending-release']);
  assert.deepEqual(createRemoteStore(file).grants(), store.grants());
  for (let i = 0; i < 100; i++) {
    store.pruneGrants(now);
    store.putGrant({ remoteSessionId: 'retired-' + i, localSessionId: 'session', state: 'revoked', expiresAt: now + 1000 });
  }
  store.pruneGrants(now);
  assert.equal(store.grants().length, 2);
  assert.equal(store.grants().find((g) => g.remoteSessionId === 'pending-release').state, 'release-pending');
  store.pruneGrants(now, { retireLocal: true });
  assert.deepEqual(store.grants().map((g) => g.remoteSessionId), ['pending-release']);
});

test('remote store peer changes during seal are preserved while configure publishes only config', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const store = createRemoteStore(null, { async seal() { await gate; return 'fake-sealed'; } });
  const pending = store.configure({ serverUrl: 'https://relay.example.invalid', deviceName: 'Name' }, 'fake-credential');
  try {
    store.putPeer({ deviceId: 'fake-peer', name: 'Fake peer' });
    store.putGrant({ remoteSessionId: 'fake-grant', hostDeviceId: 'fake-peer' });
    unblock();
    await pending;
    assert.equal(store.peers()[0].deviceId, 'fake-peer');
    assert.equal(store.grants()[0].remoteSessionId, 'fake-grant');
  } finally { unblock(); await pending; }
});

test('remote store lifecycle invalidation cancels a pending writer without clearing committed metadata', async () => {
  const dir = await directory(), file = path.join(dir, 'metadata.json');
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const store = createRemoteStore(file, { async seal(value) {
    if (value === 'fake-pending') await gate;
    return 'sealed-' + value;
  } });
  await store.configure({ serverUrl: 'https://committed.example.invalid', deviceName: 'Committed' }, 'fake-committed');
  store.setIdentity({ deviceId: 'fake-identity' });
  store.putPeer({ deviceId: 'fake-peer' });
  store.putGrant({ remoteSessionId: 'fake-grant', hostDeviceId: 'fake-peer' });
  const before = store.snapshot(), diskBefore = await fs.readFile(file);
  const pending = store.configure({ serverUrl: 'https://pending.example.invalid', deviceName: 'Pending' }, 'fake-pending');
  const rejected = assert.rejects(pending, { code: 'REMOTE_STORE_STALE_CONFIG' });
  try {
    store.invalidateConfiguration();
    store.invalidateConfiguration();
    assert.deepEqual(store.snapshot(), before, 'invalidation is idempotent and does not clear committed state');
    assert.deepEqual(await fs.readFile(file), diskBefore, 'invalidation itself must not save');
    await assert.rejects(store.configure({ serverUrl: 'https://other.example.invalid' }, 'fake-other'), { code: 'REMOTE_STORE_BUSY' });
    unblock();
    await rejected;
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(await fs.readFile(file), diskBefore, 'late seal cannot publish after lifecycle invalidation');
    store.invalidateConfiguration(); // No writer: harmless, not a permanent close.
    await store.configure({ serverUrl: 'https://committed.example.invalid', deviceName: 'Explicit retry' });
    assert.equal(store.config().deviceName, 'Explicit retry');
    assert.equal(store.config().sealedCredential, before.config.sealedCredential);
  } finally { unblock(); await rejected; }
});

test('invalidated old store cannot overwrite a replacement instance when its seal finishes late', async () => {
  const dir = await directory(), file = path.join(dir, 'metadata.json');
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const retiredStore = createRemoteStore(file, { async seal(value) {
    if (value === 'fake-old-pending') await gate;
    return 'sealed-' + value;
  } });
  await retiredStore.configure({ serverUrl: 'https://initial.example.invalid', deviceName: 'Initial' }, 'fake-initial');
  const pending = retiredStore.configure({ serverUrl: 'https://old.example.invalid', deviceName: 'Old late write' }, 'fake-old-pending');
  const rejected = assert.rejects(pending, { code: 'REMOTE_STORE_STALE_CONFIG' });
  try {
    // Runtime retire/dispose must erect this barrier before its first await.
    retiredStore.invalidateConfiguration();
    const replacement = createRemoteStore(file, { async seal(value) { return 'sealed-' + value; } });
    await replacement.configure({ serverUrl: 'https://replacement.example.invalid', deviceName: 'Replacement' }, 'fake-replacement');
    replacement.putPeer({ deviceId: 'fake-new-peer' });
    const current = replacement.snapshot(), diskCurrent = await fs.readFile(file);
    unblock();
    await rejected;
    assert.deepEqual(await fs.readFile(file), diskCurrent, 'retired writer must not replace the new instance disk record');
    assert.deepEqual(createRemoteStore(file).snapshot(), current);
    assert.equal(retiredStore.config().deviceName, 'Initial', 'old instance never publishes its invalidated config even in memory');
  } finally { unblock(); await rejected; }
});

test('same-path concurrent initialization fails closed, not two device identities', async () => {
  const dir = await directory(), host = fakeHost(), file = path.join(dir, 'identity.json');
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const protector = {
    seal: async (...args) => { await gate; return host.secretProtector.seal(...args); },
    open: host.secretProtector.open,
  };
  const first = loadOrCreateIdentity({ file, secretProtector: protector });
  try {
    await assert.rejects(loadOrCreateIdentity({ file, secretProtector: host.secretProtector }), { code: 'IDENTITY_BUSY' });
    unblock();
    const result = await first;
    result.dispose();
    assert.deepEqual(await fs.readdir(dir), ['identity.json']);
  } finally { unblock(); host.close(); }
});

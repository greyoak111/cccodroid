// Actual packaged entry + production component route + real local TLS relay.
// All identities, vault keys, transcript files and CLI events are disposable.
import '../gw/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { buildRemoteComponent } from '../../scripts/build-remote-component.mjs';
import { createRemoteComponentManager, importRemoteComponent } from '../gw/remote-component.mjs';
import { createRemoteComponentRoute } from '../gw/remote-component-route.mjs';
import { createRemoteRuntime } from '../gw/remote/runtime.mjs';
import { createRemoteStore } from '../gw/remote/store.mjs';
import { loadOrCreateIdentity } from '../gw/remote/identity.mjs';
import { createTunnelRelayServer } from '../../remote-relay/src/tunnel-server.mjs';
import { findSessionFile, peekSession } from '../gw/sessions.mjs';
import { transcriptItems } from '../gw/transcript.mjs';
import { disposableCredentials } from './fixtures/remote-app/tls-channel.mjs';
import { createOriginalRunFixture, LOCAL_SESSION, until } from './fixtures/remote-app/original-run.mjs';

function disposableVault() {
  const master = randomBytes(32);
  const aad = (purpose, id) => Buffer.from(`synthetic-only\n${purpose}\n${id}`);
  return {
    async seal(purpose, id, bytes) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, nonce);
      cipher.setAAD(aad(purpose, id));
      return { v: 1, nonce: nonce.toString('base64'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64') };
    },
    async open(purpose, id, envelope) {
      const value = Buffer.from(envelope.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(aad(purpose, id)); decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(0, -16)), decipher.final()]);
    },
    dispose() { master.fill(0); },
  };
}
async function request(route, target, data) {
  const req = new PassThrough(); req.method = data === undefined ? 'GET' : 'POST'; req.ccAuthed = true;
  const res = { setHeader() {}, writeHead(code) { this.status = code; }, end(bytes) { this.value = JSON.parse(String(bytes)); } };
  const url = new URL(target, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/remote/')) {
    const current = await request(route, '/api/components/remote-session/status');
    req.headers = { 'x-cc-remote-activation': current.value.activationId };
  }
  const result = route(req, res, url, url.pathname);
  req.end(data === undefined ? '' : JSON.stringify(data)); await result;
  return res;
}

test('disabling the actually loaded component retires its TLS grant through the production route without stopping the original child', async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const root = await fs.mkdtemp(path.join(original.workspace, 'packaged-component-chain-'));
  const hostHome = path.join(root, 'host-data'), remoteDir = path.join(hostHome, 'remote-v1');
  await fs.mkdir(remoteDir, { recursive: true, mode: 0o700 }); await fs.chmod(remoteDir, 0o700);
  const vault = disposableVault(); t.after(() => vault.dispose());
  const identity = await loadOrCreateIdentity({ file: path.join(remoteDir, 'identity.json'), secretProtector: vault, name: 'Synthetic packaged tablet' });
  t.after(() => identity.dispose());
  const phoneIdentity = await disposableCredentials(root, 'packaged-phone');
  const relay = await createTunnelRelayServer({
    devices: [{ deviceId: identity.identity.deviceId, token: 'h'.repeat(43) }, { deviceId: phoneIdentity.identity.deviceId, token: 'p'.repeat(43) }],
    pairs: [[identity.identity.deviceId, phoneIdentity.identity.deviceId]], limits: { messagesPerSecond: 200, messageBurst: 200 },
  });
  await relay.listen(); t.after(() => relay.close());
  // The production packaged runtime requires HTTPS. Only this test adapter maps
  // its persisted endpoint to the local relay; the packaged code is unchanged.
  const localUrl = 'http://127.0.0.1:' + relay.address().port;
  const serverUrl = 'https://synthetic-relay.invalid';
  const hostStore = createRemoteStore(path.join(remoteDir, 'metadata.json'), {
    seal: (value, id) => vault.seal('connection-v1', id, Buffer.from(value)),
    async unseal(value, id) { const bytes = await vault.open('connection-v1', id, value); try { return bytes.toString(); } finally { bytes.fill(0); } },
  });
  hostStore.setIdentity(identity.identity); hostStore.putPeer(phoneIdentity.identity);
  await hostStore.configure({ serverUrl, deviceName: 'Synthetic packaged tablet' }, JSON.stringify({ deviceId: identity.identity.deviceId, token: 'h'.repeat(43) }));
  const phoneStore = createRemoteStore(null, { seal: async (value) => value, unseal: async (value) => value });
  phoneStore.setIdentity(phoneIdentity.identity); phoneStore.putPeer(identity.identity);
  await phoneStore.configure({ serverUrl: localUrl, deviceName: 'Synthetic phone' }, JSON.stringify({ deviceId: phoneIdentity.identity.deviceId, token: 'p'.repeat(43) }));
  const phone = await createRemoteRuntime({ home: path.join(root, 'phone-data'), store: phoneStore, identityBundle: phoneIdentity, allowLoopback: true,
    sourceAdapter: { describe: () => null, readHistory: async () => ({ entries: [], cursor: null }), current: () => null },
    executor: { capabilities: {}, getRun: () => null, getRunOfSession: () => null, onEvent: () => () => {}, submitText: () => false, answerPerm: () => false, abortRun: () => false },
  });
  t.after(() => phone.dispose());
  const hostAdapter = { available: false, secretProtector: vault,
    async status() { return { shouldConnect: true, foreground: true }; }, watchPolicy() { return () => {}; },
    async syncNotifications() {}, async clearNotifications() {}, async reportConnectionState() {}, async setBackgroundEnabled() {},
  };
  const host = { home: hostHome, hostAdapter,
    source: { findSessionFile, peekSession, transcriptItems, runOfSession: original.runOfSession, onPublish: original.onPublish },
    executor: { capabilities: { literalText: true, messageReplay: true, remoteOnce: true, planDefault: true },
      getRun: (id) => original.RUNS.get(id), getRunOfSession: original.runOfSession, submitText: original.enqueueRemoteText,
      answerPerm: (run, id, answer, options) => run.answerPerm(id, answer, options), abortRun: original.abortRun, onEvent: original.onPublish },
  };
  const base = 'd'.repeat(64), built = buildRemoteComponent({ out: path.join(root, 'payload'), base });
  // No injected runtime substitute: create() is imported from the built entry.
  // Its only environmental test seam is the global WebSocket constructor,
  // mapping this exact synthetic HTTPS endpoint to the loopback relay.
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(url, ...args) {
      const value = new URL(url);
      const loopback = localUrl.replace('http:', 'ws:');
      assert.ok(['wss://synthetic-relay.invalid', loopback].includes(value.origin));
      super(value.origin === 'wss://synthetic-relay.invalid' ? loopback + value.pathname : value.href, ...args);
    }
  };
  t.after(() => { globalThis.WebSocket = NativeSocket; });
  const manager = createRemoteComponentManager({ prefix: built.usr, home: path.join(root, 'manager-state'),
    readRecord: () => ({ id: 'remote-session', state: 'ok', version: built.build.version, base }), readDevkit: () => ({ sha256: base }),
    createRuntime: (descriptor) => importRemoteComponent(descriptor, host),
  });
  t.after(async () => { await manager.close(); globalThis.WebSocket = NativeSocket; });
  const route = createRemoteComponentRoute(manager);
  await phone.connect();
  assert.equal((await request(route, '/api/remote/connect', {})).status, 200);
  const invited = await request(route, '/api/remote/hosting', { action: 'invite', localSessionId: LOCAL_SESSION, deviceId: phoneIdentity.identity.deviceId });
  assert.equal(invited.status, 200); const handle = invited.value.hosting.remoteSessionId;
  await until(async () => (await phone.list()).snapshot.sessions.some((s) => s.remoteSessionId === handle), 'packaged runtime invitation crosses actual TLS');
  await phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  const before = await until(async () => { const s = (await phone.status()).snapshot; return s.pending.length ? s : false; }, 'packaged runtime observes original pending request');
  const oldActivation = (await manager.status()).activationId;
  assert.ok(oldActivation); assert.ok(before.items.length > 0);
  const disabled = await request(route, '/api/components/remote-session/disable', {});
  assert.equal(disabled.status, 200); assert.equal(disabled.value.component.state, 'disabled');
  const retired = await until(async () => { const s = (await phone.status()).snapshot; return s.phase === 'revoked' ? s : false; }, 'actual manager disable revokes the actual business runtime');
  assert.deepEqual(retired.items, []); assert.deepEqual(retired.pending, []); assert.equal(retired.canControl, false);
  assert.equal((await request(route, '/api/remote/status')).status, 503);
  assert.equal(original.RUNS.get(run.id), run); assert.equal(run.aborted, false); assert.equal(run.perms.has(before.pending[0].requestId), true);
  assert.equal((await original.childEvents()).some((e) => e.kind === 'control_response'), false);
  const enabled = await request(route, '/api/components/remote-session/enable', {});
  assert.equal(enabled.status, 200); assert.notEqual(enabled.value.component.activationId, oldActivation);
  const hosting = await request(route, '/api/remote/hosting?localSessionId=' + LOCAL_SESSION);
  assert.equal(hosting.status, 200); assert.equal(hosting.value.hosting.status, 'revoked', 'same assets re-enabled must not restore old access');
  assert.deepEqual(original.attemptedExternal, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSecureChannel, createReplayGuard, identityFromCertificate } from '../../gateway/gw/remote/crypto.mjs';
import { createFrame } from '../../gateway/gw/remote/protocol.mjs';
import { tunnelFixture, peerTunnel } from './tunnel-helpers.mjs';

// Test-only platform WebSocket <-> Duplex adapter. Production integration belongs
// to the coordinator's gateway transport; the relay itself imports no crypto.
class TunnelDuplex extends Duplex {
  constructor(client, tunnelId, captured) {
    super({ highWaterMark: 64 * 1024 });
    this.client = client;
    this.tunnelId = tunnelId;
    this.captured = captured;
    this.on('error', () => {});
    this.message = event => {
      const frame = JSON.parse(event.data);
      if (frame.tunnelId !== tunnelId) return;
      if (frame.op === 'tunnel.data') {
        if (!this.push(Buffer.from(frame.data, 'base64')) && this.readableLength > 512 * 1024) this.destroy(new Error('bounded_read'));
      }
      if (frame.op === 'tunnel.closed') this.destroy();
    };
    client.ws.addEventListener('message', this.message);
  }
  _read() {}
  _write(chunk, encoding, callback) {
    if (this.client.ws.readyState !== 1 || this.client.ws.bufferedAmount + chunk.length > 512 * 1024) {
      callback(new Error('bounded_write')); return;
    }
    for (let offset = 0; offset < chunk.length; offset += 32 * 1024) {
      const data = chunk.subarray(offset, offset + 32 * 1024);
      this.captured.push(Buffer.from(data));
      this.client.send({ v: 1, op: 'tunnel.data', tunnelId: this.tunnelId, data: data.toString('base64') });
    }
    callback();
  }
  _destroy(error, callback) { this.client.ws.removeEventListener('message', this.message); callback(error); }
}

async function credentials(directory, name) {
  const keyPath = join(directory, name + '.key');
  const certPath = join(directory, name + '.crt');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${name}`], { env: { PATH: process.env.PATH } });
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}
const timeout = (promise, name) => Promise.race([promise, new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(name)), 5000); timer.unref();
})]);

test('02 pinned TLS1.3 channels carry actual 01 frames through opaque relay; wire/disk/log have no plaintext', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-inner-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let tabletCredentials, phoneCredentials;
  try { [tabletCredentials, phoneCredentials] = await Promise.all([credentials(directory, 'tablet-test'), credentials(directory, 'phone-test')]); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('openssl unavailable for synthetic credentials'); return; } throw error; }
  const logs = [];
  const fx = await tunnelFixture(t, { pairs: [['tablet', 'phone']], logger: record => logs.push(record) });
  const tablet = await fx.connect('tablet'), phone = await fx.connect('phone');
  await peerTunnel(tablet, phone);
  const captured = [];
  const tabletStream = new TunnelDuplex(tablet, 'peer-test', captured);
  const phoneStream = new TunnelDuplex(phone, 'peer-test', captured);
  const tabletIdentity = identityFromCertificate(tabletCredentials.cert);
  const phoneIdentity = identityFromCertificate(phoneCredentials.cert);
  const context = { hostInstanceId: 'tls-host-test', remoteSessionId: 'tls-session-test', grantVersion: 1 };
  const server = createSecureChannel({ role: 'server', transport: tabletStream, credentials: tabletCredentials,
    peerPin: phoneIdentity.spkiSha256, context, replayGuard: createReplayGuard() });
  const client = createSecureChannel({ role: 'client', transport: phoneStream, credentials: phoneCredentials,
    peerPin: tabletIdentity.spkiSha256, context, replayGuard: createReplayGuard() });
  t.after(() => { client.close(); server.close(); });
  const infos = await timeout(Promise.all([server.ready, client.ready]), 'inner_tls_handshake_timeout');
  assert.equal(infos[0].peerIdentity.deviceId, phoneIdentity.deviceId);
  assert.equal(infos[1].peerIdentity.deviceId, tabletIdentity.deviceId);
  const secret = 'SYNTHETIC-APPROVAL-COMMAND-TEXT-' + randomUUID();
  const binding = { fromDeviceId: phoneIdentity.deviceId, toDeviceId: tabletIdentity.deviceId, ...context, runId: 'tls-run-test' };
  const message = createFrame('message.submit', binding, { text: secret }, { now: Date.now(), messageId: randomUUID(), commandId: randomUUID() });
  const incoming = new Promise(resolve => server.onMessage(frame => { resolve(frame); }));
  await client.send(message);
  assert.deepEqual(await timeout(incoming, 'tls_frame_timeout'), message);
  const wire = Buffer.concat(captured);
  assert.equal(wire.includes(Buffer.from(secret)), false);
  assert.equal(wire.includes(Buffer.from(message.commandId)), false);
  assert.equal(wire.includes(Buffer.from(message.remoteSessionId)), false);
  const persisted = await readFile(fx.stateFile, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(message.commandId), false);
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.ok(fx.relay.stats().forwardedBytes > 0);
  assert.equal(fx.relay.stats().pendingHints, 0);
});

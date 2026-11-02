import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createTunnelRelayServer } from '../src/tunnel-server.mjs';
import { testDevices } from './helpers.mjs';

// Local-only test CA material is generated into an isolated temporary directory.
// Clients trust that test certificate explicitly, never rejectUnauthorized:false.
test('WSS authenticates over a verified test certificate on a random local port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-wss-'));
  let relay;
  let client;
  t.after(async () => {
    client?.terminate();
    await relay?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const keyFile = join(directory, 'test-only.key');
  const certFile = join(directory, 'test-only.crt');
  const execute = promisify(execFile);
  try {
    await execute('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=relay-local-test',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { env: { PATH: process.env.PATH } });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('openssl unavailable for local test certificate'); return; }
    throw error;
  }
  const devices = testDevices();
  const cert = await readFile(certFile);
  relay = await createTunnelRelayServer({ devices,
    tls: { key: await readFile(keyFile), cert, minVersion: 'TLSv1.3' } });
  await relay.listen();
  client = new WebSocket(`wss://127.0.0.1:${relay.address().port}/v1/relay`, {
    ca: cert,
    rejectUnauthorized: true,
    headers: { Authorization: `Bearer ${devices[0].token}`, 'X-Relay-Device-Id': devices[0].deviceId },
  });
  const ready = new Promise(resolve => client.once('message', value => resolve(JSON.parse(value.toString()))));
  await once(client, 'open');
  client.send(JSON.stringify({ v: 1, op: 'auth', deviceId: devices[0].deviceId, token: devices[0].token }));
  assert.equal(client._socket.authorized, true);
  assert.equal(client._socket.getProtocol(), 'TLSv1.3');
  assert.equal((await ready).op, 'auth.ok');
});

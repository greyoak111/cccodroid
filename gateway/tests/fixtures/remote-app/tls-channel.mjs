// Fresh, disposable P-256 credentials; never uses installed device identity.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { identityFromCertificate, createSecureChannel, createReplayGuard } from '../../../gw/remote/crypto.mjs';

export async function disposableCredentials(root, name) {
  const key = path.join(root, name + '.key.pem'), cert = path.join(root, name + '.cert.pem');
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=remote-synthetic-' + name, '-keyout', key, '-out', cert], { encoding: 'utf8', env: { ...process.env, HOME: root, OPENSSL_CONF: '/dev/null' } });
  if (result.status !== 0) throw new Error('Disposable certificate generation failed: ' + (result.error?.message || result.stderr.slice(-500)));
  const credentials = { key: await fs.readFile(key), cert: await fs.readFile(cert) };
  await fs.chmod(key, 0o600);
  return { credentials, identity: identityFromCertificate(credentials.cert) };
}

/** A ciphertext-only relay pipe. No shared secret, decoder or fake authentication. */
export async function createTlsFixture(root, context = { hostInstanceId: 'tls-fixture-boot', remoteSessionId: 'tls-fixture-handle', grantVersion: 1 }) {
  const host = await disposableCredentials(root, 'host'), phone = await disposableCredentials(root, 'phone');
  const wire = [], endpoints = [];
  for (let side = 0; side < 2; side++) {
    const stream = new Duplex({ read() {}, write(chunk, encoding, callback) {
      const bytes = Buffer.from(chunk); wire.push({ side, bytes: Buffer.from(bytes) });
      queueMicrotask(() => { if (!endpoints[1 - side].destroyed) endpoints[1 - side].push(bytes); callback(); });
    }, destroy(error, callback) { callback(error); } });
    endpoints.push(stream);
  }
  const receivedHost = [], receivedPhone = [], closed = [];
  const server = createSecureChannel({ role: 'server', transport: endpoints[0], credentials: host.credentials, peerPin: phone.identity.spkiSha256, context, replayGuard: createReplayGuard() });
  const client = createSecureChannel({ role: 'client', transport: endpoints[1], credentials: phone.credentials, peerPin: host.identity.spkiSha256, context, replayGuard: createReplayGuard() });
  server.onMessage((frame) => { receivedHost.push(frame); }); client.onMessage((frame) => { receivedPhone.push(frame); });
  server.onClose((event) => closed.push({ side: 'host', ...event })); client.onClose((event) => closed.push({ side: 'phone', ...event }));
  await Promise.all([server.ready, client.ready]);
  return { host, phone, server, client, context, wire, receivedHost, receivedPhone, closed,
    close() { server.close(); client.close(); for (const endpoint of endpoints) endpoint.destroy(); } };
}

// The TLS identity is a software P-256 key. Only the Android Keystore wrapping
// master is non-exportable. No implicit HOME lookup and no plaintext key files.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import { identityFromCertificate, RemoteCryptoError, samePublicPin } from './crypto.mjs';

export const IDENTITY_LIMITS = Object.freeze({
  sealedBytes: 40 * 1024,
  plaintextBytes: 24 * 1024,
  certificateBytes: 8 * 1024,
  privateKeyBytes: 4 * 1024,
  processOutputBytes: 12 * 1024,
  processTimeoutMs: 10_000,
  certificateDays: 365,
});
const MAGIC = Buffer.from('CCRID001');
const PURPOSE = 'identity-v1';
const fail = (code) => { throw new RemoteCryptoError(code); };
const inflight = new Map();
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const validName = (name) => typeof name === 'string' && !!name.trim() && Buffer.byteLength(name) <= 256
  && !/[\u0000-\u001f\u007f]/.test(name);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_IDENTITY_RECORD');
}
function base64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_IDENTITY_RECORD');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) fail('INVALID_IDENTITY_RECORD');
  return bytes;
}
function envelope(value) {
  exact(value, ['v', 'nonce', 'ciphertext']);
  const nonce = base64(value.nonce, 12), ciphertext = base64(value.ciphertext, IDENTITY_LIMITS.plaintextBytes + 16);
  if (value.v !== 1 || nonce.length !== 12 || ciphertext.length < 16) fail('INVALID_IDENTITY_RECORD');
  return Object.freeze({ v: 1, nonce: value.nonce, ciphertext: value.ciphertext });
}

// Binary serialization avoids retaining a base64 private key in immutable JS
// strings. It is an at-rest record format, not a cryptographic protocol.
function encodeRecord(key, cert) {
  if (key.length > IDENTITY_LIMITS.privateKeyBytes || cert.length > IDENTITY_LIMITS.certificateBytes) fail('IDENTITY_LIMIT');
  const bytes = Buffer.alloc(MAGIC.length + 8 + key.length + cert.length);
  MAGIC.copy(bytes); bytes.writeUInt32BE(key.length, 8); bytes.writeUInt32BE(cert.length, 12);
  key.copy(bytes, 16); cert.copy(bytes, 16 + key.length);
  return bytes;
}
function decodeRecord(bytes, now, name) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('INVALID_IDENTITY_RECORD');
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (value.length > IDENTITY_LIMITS.plaintextBytes || value.length < 16 || !value.subarray(0, 8).equals(MAGIC)) fail('INVALID_IDENTITY_RECORD');
  const keyLength = value.readUInt32BE(8), certLength = value.readUInt32BE(12);
  if (keyLength < 1 || certLength < 1 || keyLength > IDENTITY_LIMITS.privateKeyBytes
    || certLength > IDENTITY_LIMITS.certificateBytes || value.length !== 16 + keyLength + certLength) fail('INVALID_IDENTITY_RECORD');
  const cert = Buffer.from(value.subarray(16 + keyLength));
  try {
    const privateKey = createPrivateKey({ key: value.subarray(16, 16 + keyLength), type: 'pkcs8', format: 'der' });
    const publicIdentity = identityFromCertificate(cert, { now });
    const keyPin = createHash('sha256').update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).digest('base64url');
    if (!samePublicPin(keyPin, publicIdentity.spkiSha256)) fail('CREDENTIAL_MISMATCH');
    const x509 = new X509Certificate(cert);
    if (!x509.checkIssued(x509) || !x509.verify(x509.publicKey)) fail('INVALID_CERTIFICATE');
    const credentials = { key: privateKey, cert };
    let disposed = false;
    return Object.freeze({ identity: Object.freeze({ ...publicIdentity, name }), credentials,
      dispose() { if (!disposed) { disposed = true; credentials.key = null; cert.fill(0); } } });
  } catch (error) {
    cert.fill(0);
    if (error instanceof RemoteCryptoError) throw error;
    fail('INVALID_IDENTITY_RECORD');
  }
}

/** OpenSSL req is used ONLY to create a standard self-signed X.509 certificate.
 * The private DER arrives on stdin, never argv/env/a temporary file. Neither
 * subprocess diagnostics nor stdout are logged or included in errors. */
function certificateFromKey(key, { opensslPath, spawnProcess, timeoutMs, env, loader }) {
  return new Promise((resolve, reject) => {
    let child, settled = false, outputBytes = 0, errorBytes = 0;
    const output = [];
    const finish = (code, cert) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const bytes of output) bytes.fill(0);
      if (code) {
        // The fixed pipeline has its own process group. Timeout/output failure
        // must stop both OpenSSL children, not leave a blocked key reader.
        try { if (Number.isInteger(child?.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL'); }
        catch { child?.kill('SIGKILL'); }
        reject(new RemoteCryptoError(code));
      } else resolve(cert);
    };
    const timer = setTimeout(() => finish('IDENTITY_CERTIFICATE_TIMEOUT'), timeoutMs);
    try {
      // Node uses a socketpair for a child's stdin on Android. OpenSSL req
      // reopens /dev/stdin, which cannot reopen that socket (ENXIO). pkey reads
      // fd 0 directly and writes to a real anonymous pipe for req. The script is
      // constant; the trusted executable path is a quoted positional argument,
      // never shell source. No temporary plaintext private-key file is needed.
      // targetSdk >= 29 cannot exec toolpack ELFs directly. Use the system
      // shell/linker explicitly instead of inheriting loader preloads or tokens.
      const openssl = loader ? '"$1" "$2"' : '"$1"';
      const pipeline = openssl + ' pkey -inform DER -outform DER | exec ' + openssl + ' req -new -x509 -sha256 -keyform DER -key /dev/stdin'
        + ' -days ' + IDENTITY_LIMITS.certificateDays + ' -subj /CN=cc-remote-device -config /dev/null';
      const command = loader ? '/system/bin/sh' : 'sh';
      const args = ['-c', pipeline, 'cc-remote-certificate', ...(loader ? ['/system/bin/linker64'] : []), opensslPath];
      child = spawnProcess(command, args,
      { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true, shell: false, detached: true });
      child.once('error', () => finish('IDENTITY_CERTIFICATE_UNAVAILABLE'));
      child.stdin.on('error', () => finish('IDENTITY_CERTIFICATE_FAILED'));
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes + errorBytes > IDENTITY_LIMITS.processOutputBytes) { finish('IDENTITY_CERTIFICATE_LIMIT'); return; }
        output.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk) => {
        errorBytes += chunk.length;
        if (outputBytes + errorBytes > IDENTITY_LIMITS.processOutputBytes) finish('IDENTITY_CERTIFICATE_LIMIT');
      });
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0 || outputBytes < 1 || outputBytes > IDENTITY_LIMITS.certificateBytes) { finish('IDENTITY_CERTIFICATE_FAILED'); return; }
        const cert = Buffer.concat(output);
        if (!cert.toString('ascii').startsWith('-----BEGIN CERTIFICATE-----\n')) { cert.fill(0); finish('INVALID_CERTIFICATE'); return; }
        finish(null, cert);
      });
      child.stdin.end(key);
    } catch { finish('IDENTITY_CERTIFICATE_UNAVAILABLE'); }
  });
}

async function readStored(file) {
  let handle;
  try {
    // Opening a replaced FIFO must not hang before fstat can reject it.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > IDENTITY_LIMITS.sealedBytes || (stat.mode & 0o077)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('UNSAFE_IDENTITY_FILE');
    // Do not trust a pre-read stat as an allocation cap: another same-UID
    // writer can grow the file between stat and readFile(). Read at most the
    // fixed limit plus one byte, then reject rather than allocate to EOF.
    const bounded = Buffer.alloc(IDENTITY_LIMITS.sealedBytes + 1);
    let total = 0;
    while (total < bounded.length) {
      const { bytesRead } = await handle.read(bounded, total, bounded.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > IDENTITY_LIMITS.sealedBytes) fail('IDENTITY_LIMIT');
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded.subarray(0, total)));
    exact(record, ['v', 'purpose', 'recordId', 'sealed']);
    if (record.v !== 1 || record.purpose !== PURPOSE || !validId(record.recordId)) fail('INVALID_IDENTITY_RECORD');
    return { recordId: record.recordId, sealed: envelope(record.sealed) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof RemoteCryptoError) throw error;
    fail('IDENTITY_LOAD_FAILED');
  } finally { await handle?.close(); }
}

async function writeExclusive(file, record) {
  const temporary = path.join(path.dirname(file), '.remote-identity-' + randomUUID() + '.tmp');
  const bytes = Buffer.from(JSON.stringify(record));
  let handle;
  try {
    if (bytes.length > IDENTITY_LIMITS.sealedBytes) fail('IDENTITY_LIMIT');
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    // Android app SELinux can forbid hard links even in private storage. A
    // create-exclusive reservation prevents replacing a competing identity;
    // rename then publishes the complete ciphertext atomically. A crash between
    // reservation and rename leaves an empty, fail-closed file (manual recovery,
    // never automatic key rotation). Concurrent gateway processes may briefly
    // get IDENTITY_LOAD_FAILED and retry after initialization has finished.
    let reservation;
    try { reservation = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
    await reservation.close();
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch (error) {
    if (error instanceof RemoteCryptoError) throw error;
    fail('IDENTITY_SAVE_FAILED');
  } finally {
    bytes.fill(0); await handle?.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

/** file must be an explicit path under a gateway-owned private directory.
 * secretProtector is normally hostAdapter.secretProtector; tests can inject a
 * bounded fake vault. No protector, unavailable vault, corrupt envelope, unsafe
 * permissions or expired cert => fail closed, NEVER silently mint a new key.
 * Returned credentials stay in the trusted backend; call dispose() after
 * createSecureChannel has synchronously loaded them into its TLS context. */
export async function loadOrCreateIdentity({ file, secretProtector, recordId = 'device-identity', name = 'CC device',
  opensslPath = 'openssl', now = Date.now, processTimeoutMs = IDENTITY_LIMITS.processTimeoutMs,
  spawnProcess = spawn } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || !validId(recordId) || !validName(name)
    || !secretProtector || typeof secretProtector.seal !== 'function' || typeof secretProtector.open !== 'function'
    || typeof opensslPath !== 'string' || !opensslPath || opensslPath.includes('\0') || typeof spawnProcess !== 'function'
    || !Number.isSafeInteger(processTimeoutMs) || processTimeoutMs < 1 || processTimeoutMs > 30_000) fail('IDENTITY_VAULT_REQUIRED');
  file = path.resolve(file);
  if (inflight.has(file)) fail('IDENTITY_BUSY');
  const token = {};
  inflight.set(file, token);
  let plaintext = null, privateDer = null;
  try {
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) fail('UNSAFE_IDENTITY_DIRECTORY');
    async function openStored(stored) {
      if (stored.recordId !== recordId) fail('IDENTITY_RECORD_MISMATCH');
      try {
        plaintext = await secretProtector.open(PURPOSE, recordId, stored.sealed);
        if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > IDENTITY_LIMITS.plaintextBytes) fail('INVALID_IDENTITY_RECORD');
        return decodeRecord(plaintext, now, name);
      } catch (error) {
        if (error instanceof RemoteCryptoError) throw error;
        fail('IDENTITY_VAULT_UNAVAILABLE');
      } finally { plaintext?.fill?.(0); plaintext = null; }
    }
    const stored = await readStored(file);
    if (stored) return await openStored(stored);
    // Verify that a functioning production vault exists BEFORE creating a
    // software identity. An unavailable host must not fall back to plaintext.
    let probe;
    try {
      probe = await secretProtector.seal(PURPOSE, recordId, Buffer.alloc(0));
      const opened = await secretProtector.open(PURPOSE, recordId, envelope(probe));
      try { if (!(opened instanceof Uint8Array) || opened.byteLength !== 0) fail('INVALID_IDENTITY_RECORD'); }
      finally { opened?.fill?.(0); }
    } catch (error) {
      if (error instanceof RemoteCryptoError) throw error;
      fail('IDENTITY_VAULT_UNAVAILABLE');
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateDer = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }));
    // Do not inherit bridge/model tokens or loader flags into OpenSSL. PATH is
    // only for locating the app's trusted binary; callers can pass an absolute
    // opensslPath. /dev/null prevents ambient openssl.cnf loading.
    const processEnv = { PATH: process.env.PATH ?? '', HOME: path.dirname(file), OPENSSL_CONF: '/dev/null', LANG: 'C' };
    const loader = process.env.CCAPP_EXEC === 'loader';
    if (loader && opensslPath === 'openssl') {
      const prefix = process.env.CCAPP_PREFIX;
      if (!prefix || !path.isAbsolute(prefix)) fail('IDENTITY_CERTIFICATE_UNAVAILABLE');
      opensslPath = path.join(prefix, 'bin', 'openssl');
    }
    const cert = await certificateFromKey(privateDer, { opensslPath, spawnProcess, loader,
      timeoutMs: processTimeoutMs, env: processEnv });
    try { plaintext = encodeRecord(privateDer, cert); }
    finally { cert.fill(0); privateDer.fill(0); privateDer = null; }
    let sealed;
    try { sealed = envelope(await secretProtector.seal(PURPOSE, recordId, plaintext)); }
    catch (error) {
      if (error instanceof RemoteCryptoError) throw error;
      fail('IDENTITY_VAULT_UNAVAILABLE');
    }
    const record = { v: 1, purpose: PURPOSE, recordId, sealed };
    // Decode and validate BEFORE committing a freshly generated record.
    const result = decodeRecord(plaintext, now, name);
    try {
      if (!await writeExclusive(file, record)) {
        result.dispose();
        plaintext.fill(0); plaintext = null;
        const winner = await readStored(file);
        if (!winner) fail('IDENTITY_SAVE_FAILED');
        return await openStored(winner);
      }
      return result;
    } catch (error) { result.dispose(); throw error; }
  } catch (error) {
    if (error instanceof RemoteCryptoError) throw error;
    fail('IDENTITY_OPERATION_FAILED');
  } finally {
    plaintext?.fill(0); privateDer?.fill(0);
    if (inflight.get(file) === token) inflight.delete(file);
  }
}

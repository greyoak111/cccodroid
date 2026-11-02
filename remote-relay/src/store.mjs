import { open, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const EMPTY = () => ({ version: 1, devices: [], pairs: [], routes: [], pending: [] });
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Single-process, small, bounded metadata file. It is not a conversation database.
// Only invitation/reminder ciphertext may be durable; controls never enter it.
export class MetadataStore {
  constructor({ stateFile = null, maxStateBytes = 4 * 1024 * 1024,
    validateState = () => {}, now = Date.now, initialState = EMPTY() } = {}) {
    this.stateFile = stateFile;
    this.maxStateBytes = maxStateBytes;
    this.validateState = validateState;
    this.now = now;
    this.state = structuredClone(initialState);
    this.chain = Promise.resolve();
    this.temporary = null;
    this.closed = false;
  }

  async load() {
    if (!this.stateFile) return this.snapshot();
    try {
      const stat = await lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxStateBytes || (stat.mode & 0o077)) {
        fail('unsafe_state_file');
      }
      const handle = await open(this.stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let contents;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > this.maxStateBytes || (current.mode & 0o077)) fail('unsafe_state_file');
        contents = await handle.readFile('utf8');
      } finally { await handle.close(); }
      let state;
      try { state = JSON.parse(contents); }
      catch { fail('invalid_state'); }
      try { this.validateState(state); }
      catch { fail('invalid_state'); }
      this.state = state;
      return this.snapshot();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist(this.state);
      return this.snapshot();
    }
  }

  snapshot() { return structuredClone(this.state); }

  transaction(update) {
    const operation = this.chain.then(async () => {
      if (this.closed) fail('store_closed');
      const next = this.snapshot();
      const result = await update(next);
      this.validateState(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    // A failed fsync/write must fail that operation, not poison every later one.
    this.chain = operation.catch(() => {});
    return operation;
  }

  async persist(state) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > this.maxStateBytes) fail('state_capacity');
    if (!this.stateFile) return;
    const directory = dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${directory}/.${basename(this.stateFile)}.${randomBytes(8).toString('hex')}.tmp`;
    this.temporary = temporary;
    let file;
    let renamed = false;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(serialized, 'utf8');
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, this.stateFile);
      renamed = true;
      const dir = await open(directory, 'r');
      try { await dir.sync(); }
      finally { await dir.close(); }
    } finally {
      await file?.close().catch(() => {});
      if (!renamed) await unlink(temporary).catch(() => {});
      this.temporary = null;
    }
  }

  async flush() { await this.chain; }
  async close() { await this.chain; this.closed = true; }
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEVICES = 16;
const MAX_GRANTS = 64;

/** Remote metadata stays in the private home; conversation bodies never enter this store. */
export function createRemoteStore(file, { seal, unseal } = {}) {
  let state = { version: 1, config: null, identity: null, peers: [], grants: [] };
  if (file && fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw new Error("REMOTE_STORE_INVALID");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version !== 1 || !Array.isArray(value.peers) || !Array.isArray(value.grants)
        || value.peers.length > MAX_DEVICES || value.grants.length > MAX_GRANTS) throw new Error("REMOTE_STORE_INVALID");
    state = value;
  }
  const copy = (value) => structuredClone(value);
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  // A single pending vault operation is retained, even after invalidation.
  // Reject concurrent writers rather than queueing secrets without a bound.
  let configuring = null;
  function invalidateConfiguration() {
    if (configuring) configuring.cancelled = true;
  }
  function save() {
    if (!file) return;
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("REMOTE_STORE_FULL");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID() + ".new";
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } catch (e) {
      // Every pre-publish failure owns this temporary path, not the last commit.
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  return {
    snapshot: () => copy(state),
    config: () => copy(state.config),
    // Lifecycle cancellation does not erase the last committed configuration.
    invalidateConfiguration,
    async configure(config, credential) {
      if (configuring) fail("REMOTE_STORE_BUSY");
      const attempt = { cancelled: false }; configuring = attempt;
      try {
        const next = { ...config };
        if (credential) {
          if (!seal) throw new Error("KEYSTORE_UNAVAILABLE");
          next.sealedCredential = await seal(credential, "relay-credential");
        } else if (state.config?.sealedCredential) next.sealedCredential = state.config.sealedCredential;
        // clear()/lifecycle invalidation cancel a pending operation without
        // awaiting the vault. No await may separate this check and publish.
        if (attempt.cancelled) fail("REMOTE_STORE_STALE_CONFIG");
        const previous = state.config;
        state.config = next;
        try { save(); } catch (e) { state.config = previous; throw e; }
        return copy(next);
      } finally { if (configuring === attempt) configuring = null; }
    },
    async credential() {
      if (!state.config?.sealedCredential) return "";
      if (!unseal) throw new Error("KEYSTORE_UNAVAILABLE");
      return unseal(state.config.sealedCredential, "relay-credential");
    },
    identity: () => copy(state.identity),
    setIdentity(identity) { const old = state.identity; state.identity = copy(identity); try { save(); } catch (e) { state.identity = old; throw e; } },
    peers: () => copy(state.peers),
    putPeer(peer) {
      const peers = state.peers.filter((p) => p.deviceId !== peer.deviceId);
      if (peers.length >= MAX_DEVICES) throw new Error("REMOTE_STORE_FULL");
      const old = state.peers;
      state.peers = [...peers, copy(peer)];
      try { save(); } catch (e) { state.peers = old; throw e; }
    },
    removePeer(deviceId) {
      const old = copy(state);
      state.peers = state.peers.filter((p) => p.deviceId !== deviceId);
      state.grants = state.grants.filter((g) => g.phoneDeviceId !== deviceId && g.hostDeviceId !== deviceId);
      try { save(); } catch (e) { state = old; throw e; }
    },
    grants: () => copy(state.grants),
    pruneGrants(now, { retireLocal = false } = {}) {
      if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_CLOCK");
      const old = state.grants;
      const next = old.filter((g) => !(Number.isSafeInteger(g.expiresAt) && g.expiresAt <= now)
        && !(g.localSessionId && (retireLocal || ["revoked", "expired"].includes(g.state))));
      if (next.length === old.length) return;
      state.grants = next;
      try { save(); } catch (e) { state.grants = old; throw e; }
    },
    putGrant(grant) {
      const grants = state.grants.filter((g) => g.remoteSessionId !== grant.remoteSessionId);
      if (grants.length >= MAX_GRANTS) throw new Error("REMOTE_STORE_FULL");
      const old = state.grants;
      state.grants = [...grants, copy(grant)];
      try { save(); } catch (e) { state.grants = old; throw e; }
    },
    removeGrant(remoteSessionId) {
      const old = state.grants;
      state.grants = old.filter((g) => g.remoteSessionId !== remoteSessionId);
      try { save(); } catch (e) { state.grants = old; throw e; }
    },
    clear() {
      invalidateConfiguration();
      const old = state; state = { version: 1, config: null, identity: null, peers: [], grants: [] };
      try { save(); } catch (e) { state = old; throw e; }
    },
  };
}

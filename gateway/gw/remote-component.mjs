import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { REMOTE_COMPONENT_ID as ID, REMOTE_HOST_API, readRemotePayload } from "./remote-component-layout.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Optional feature lifecycle. It owns no local run and never stops one. */
export function createRemoteComponentManager({ prefix, home, readRecord, readDevkit, createRuntime } = {}) {
  const stateDir = path.join(home, ".cccodroid", ID), stateFile = path.join(stateDir, "component-state.json");
  let preference = true, stateError = false;
  try {
    const st = fs.lstatSync(stateFile);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) throw new Error();
    const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (value.v !== 1 || typeof value.enabled !== "boolean" || Object.keys(value).some((k) => !["v", "enabled"].includes(k))) throw new Error();
    preference = value.enabled;
  } catch (e) { if (e.code !== "ENOENT") { preference = false; stateError = true; } }
  let runtime = null, payload = null, activationId = null, gate = false, retiring = false, serial = Promise.resolve(), closed = false;
  let probed = 0, signature = null, disabledDescriptor = null, failedAsset = null;
  function signatureOf(rec) {
    try {
      const tree = path.join(prefix, "share/cccodroid/components", ID), entry = path.join(tree, "component.json");
      const st = fs.lstatSync(entry), dir = fs.lstatSync(tree), dk = readDevkit();
      return JSON.stringify([rec?.state, rec?.base, rec?.sha256, rec?.version, dk?.sha256, st.ino, st.size, st.mtimeMs, st.ctimeMs, dir.ino, dir.mtimeMs]);
    } catch { return null; }
  }
  let current = snapshot(false, "absent");
  const watchers = new Set();
  function snapshot(installed, state, error = null, descriptor = payload) {
    return { ok: true, id: ID, hostApi: REMOTE_HOST_API, installed, enabled: state === "active", state,
      version: descriptor?.version || null, assetVersion: state === "active" ? descriptor?.assetVersion || null : null,
      activationId: state === "active" ? activationId : null, error };
  }
  function notify() { for (const fn of watchers) { try { fn({ ...current }); } catch {} } }
  function setStatus(value) { if (JSON.stringify(current) !== JSON.stringify(value)) { current = value; notify(); } return { ...current }; }
  function save(enabled) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const tmp = stateFile + "." + randomUUID() + ".tmp";
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ v: 1, enabled }) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, stateFile);
      const dir = fs.openSync(stateDir, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      preference = enabled; stateError = false;
    } finally { if (fd != null) fs.closeSync(fd); fs.rmSync(tmp, { force: true }); }
  }
  function queue(action) {
    const work = serial.catch(() => {}).then(action);
    serial = work.catch(() => {});
    return work;
  }
  let retiringRuntime = null;
  function retire() {
    gate = false; activationId = null;
    if (retiringRuntime) return retiringRuntime;
    if (!runtime) { payload = null; return Promise.resolve(); }
    const old = runtime; runtime = null;
    let work;
    try { work = old.retire(); } catch (e) { work = Promise.reject(e); }
    const finishing = Promise.resolve(work).finally(async () => {
      try { await old.dispose?.(); } finally { payload = null; }
    });
    retiringRuntime = finishing;
    finishing.finally(() => { if (retiringRuntime === finishing) retiringRuntime = null; }).catch(() => {});
    return finishing;
  }
  async function refreshNow() {
    if (closed) return setStatus(snapshot(false, "absent"));
    if (retiring) return { ...current };
    const rec = readRecord();
    if (!rec) { signature = null; disabledDescriptor = null; await retire(); return setStatus(snapshot(false, "absent")); }
    const stamp = signatureOf(rec);
    if (stamp && stamp === signature && Date.now() - probed < 5000) {
      if (runtime && preference) { gate = true; return setStatus(snapshot(true, "active")); }
      if (!preference && !stateError && disabledDescriptor) return setStatus(snapshot(true, "disabled", null, disabledDescriptor));
    }
    let next;
    try { next = readRemotePayload(prefix, { record: rec, devkit: readDevkit() }); signature = stamp; probed = Date.now(); disabledDescriptor = next; }
    catch (e) {
      await retire();
      return setStatus(snapshot(true, e.code === "HOST_API_REQUIRED" || e.code === "COMPONENT_OUTDATED" ? "incompatible" : "error", e.code || "COMPONENT_DAMAGED", { version: rec.version }));
    }
    if (stateError) { await retire(); return setStatus(snapshot(true, "error", "COMPONENT_STATE_INVALID", next)); }
    if (!preference) { await retire(); return setStatus(snapshot(true, "disabled", null, next)); }
    if (runtime && payload?.assetVersion === next.assetVersion) { gate = true; return setStatus(snapshot(true, "active")); }
    if (failedAsset === next.assetVersion) return setStatus(snapshot(true, "error", "REMOTE_UNAVAILABLE", next));
    await retire();
    try {
      payload = next;
      const created = await createRuntime(next);
      if (!created || typeof created.retire !== "function" || typeof created.dispose !== "function") { await created?.dispose?.(); fail("HOST_API_REQUIRED"); }
      if (closed || retiring || !preference) {
        try { await created.retire(); } finally { await created.dispose(); if (payload === next) payload = null; }
        return setStatus(snapshot(true, retiring ? "retiring" : "disabled", null, next));
      }
      runtime = created; activationId = randomUUID(); gate = true; failedAsset = null;
      return setStatus(snapshot(true, "active"));
    } catch {
      gate = false; runtime = null; failedAsset = next.assetVersion;
      return setStatus(snapshot(true, "error", "REMOTE_UNAVAILABLE", next));
    }
  }
  const api = {
    get ready() { return gate && !retiring && !closed; },
    get enabledPreference() { return preference && !stateError; },
    peek() { return { ...current }; },
    status() { return queue(refreshNow); },
    async enable() {
      return queue(async () => {
        if (retiring || closed) fail("BUSY");
        const rec = readRecord(); if (!rec) fail("COMPONENT_NOT_INSTALLED");
        readRemotePayload(prefix, { record: rec, devkit: readDevkit() });
        save(true); failedAsset = null;
        const result = await refreshNow();
        if (!result.enabled) fail(result.error || "REMOTE_UNAVAILABLE");
        return result;
      });
    },
    disable() {
      if (retiring) return queue(() => ({ ...current }));
      // Persist the off state before touching files. A crash or failed upgrade
      // cannot silently reactivate a retained component on gateway restart.
      gate = false; activationId = null; retiring = true;
      setStatus(snapshot(!!readRecord(), "retiring"));
      preference = false;
      let savedError; try { save(false); } catch (e) { savedError = e; stateError = true; }
      const immediate = retire();
      immediate.catch(() => {});
      return queue(async () => {
        try {
          await immediate;
          if (savedError) throw savedError;
          return setStatus(snapshot(!!readRecord(), readRecord() ? "disabled" : "absent"));
        } catch (e) {
          setStatus(snapshot(!!readRecord(), "error", "REMOTE_UNAVAILABLE", disabledDescriptor)); throw e;
        } finally { retiring = false; }
      });
    },
    async invokeAt(expectedActivation, method, ...args) {
      if (typeof expectedActivation !== "string" || expectedActivation !== activationId || !api.ready) fail("COMPONENT_VERSION_MISMATCH");
      const own = runtime, result = await api.status();
      if (!api.ready || result.state !== "active" || expectedActivation !== activationId || runtime !== own
          || typeof own?.[method] !== "function") fail("COMPONENT_VERSION_MISMATCH");
      const value = await own[method](...args);
      if (!api.ready || runtime !== own || expectedActivation !== activationId) fail("COMPONENT_VERSION_MISMATCH");
      return value;
    },
    async invoke(method, ...args) {
      const result = await api.status();
      if (!api.ready || result.state !== "active" || typeof runtime?.[method] !== "function") fail("REMOTE_UNAVAILABLE");
      const own = runtime;
      const value = await own[method](...args);
      // A late read/control response never recreates a disabled frontend view.
      if (!api.ready || runtime !== own) fail("REMOTE_UNAVAILABLE");
      return value;
    },
    subscribeAt(expectedActivation, listener) {
      if (!api.ready || expectedActivation !== activationId) fail("COMPONENT_VERSION_MISMATCH");
      return runtime.subscribe(listener);
    },
    subscribe(listener) {
      if (!api.ready) fail("REMOTE_UNAVAILABLE");
      return runtime.subscribe(listener);
    },
    async asset(kind, version) {
      await api.status();
      if (!api.ready || version !== payload?.assetVersion) fail("COMPONENT_VERSION_MISMATCH");
      return kind === "js" ? payload.js : kind === "css" ? payload.css : null;
    },
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener); },
    async close() {
      closed = true; gate = false; activationId = null;
      setStatus(snapshot(!!readRecord(), "retiring"));
      const immediate = retire(); immediate.catch(() => {});
      try { await queue(() => immediate); } finally { watchers.clear(); }
    },
  };
  return Object.freeze(api);
}

export async function importRemoteComponent(descriptor, host) {
  const entry = await import(pathToFileURL(descriptor.entry).href);
  if (entry.hostApi !== REMOTE_HOST_API || typeof entry.create !== "function") fail("HOST_API_REQUIRED");
  return entry.create(host);
}

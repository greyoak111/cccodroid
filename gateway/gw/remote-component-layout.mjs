import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const REMOTE_COMPONENT_ID = "remote-session";
export const REMOTE_HOST_API = 1;
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 4 * 1024 * 1024;
const fail = (code = "COMPONENT_DAMAGED") => { throw Object.assign(new Error(code), { code }); };
const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && Object.keys(v).every((k) => keys.includes(k));
const FEATURE = `share/cccodroid/components/${REMOTE_COMPONENT_ID}`, INDEX = `libexec/devkit/components/${REMOTE_COMPONENT_ID}`;
const RELEASE_FILES = ["component", "runtime", "protocol", "crypto", "pairing", "identity", "phone", "tablet-data", "tablet-control", "presentation", "store", "relay-client", "host-adapter"].map((name) => `gateway/${name}.mjs`).concat(["web/ui.js", "web/ui.css"]);
const packageFiles = (version) => [`${FEATURE}/component.json`, `${FEATURE}/README.zh-CN.md`, `${FEATURE}/LICENSE`, `${FEATURE}/NOTICE`,
  ...RELEASE_FILES.map((rel) => `${FEATURE}/releases/${version}/${rel}`), `${INDEX}/MANIFEST`, `${INDEX}/FILES`];
function packageDirs(files) {
  const dirs = new Set([""]);
  for (const file of files) for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) dirs.add(dir);
  return dirs;
}
export const payloadHash = (files) => createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en")))).digest("hex");

// Only this feature's fixed tree is ever executable. No URL, arbitrary module
// path, environment override or untrusted frontend parameter selects an entry.
export function readRemotePayload(prefix, { record, devkit } = {}) {
  if (!prefix || !record) return null;
  if (record.id !== REMOTE_COMPONENT_ID || record.state !== "ok") fail();
  if (!devkit?.sha256 || record.base !== devkit.sha256) fail("COMPONENT_OUTDATED");
  // Android's /data/data/<package> is an alias of /data/user/0/<package>.
  // Canonicalize only the supplied trusted PREFIX, never feature descendants.
  let actualPrefix; try { actualPrefix = fs.realpathSync(prefix); } catch { fail(); }
  const root = path.join(actualPrefix, "share/cccodroid/components", REMOTE_COMPONENT_ID);
  const plainFile = (rel, cap = MAX_FILE) => {
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p))) fail();
    let dir = actualPrefix;
    for (const p of ["share", "cccodroid", "components", REMOTE_COMPONENT_ID, ...parts]) {
      if (p) dir = path.join(dir, p);
      let st; try { st = fs.lstatSync(dir); } catch { fail(); }
      if (st.isSymbolicLink() || !(dir === path.join(root, rel) ? st.isFile() : st.isDirectory())) fail();
      if (st.isFile() && st.size > cap) fail();
    }
    // Ancestors outside the feature tree must not redirect into another tree.
    if (fs.realpathSync(dir) !== path.resolve(dir)) fail();
    return fs.readFileSync(dir);
  };
  let manifest;
  try { manifest = JSON.parse(plainFile("component.json", 16384).toString("utf8")); } catch { fail(); }
  if (!exact(manifest, ["format", "id", "version", "hostApi", "assetVersion", "files"]) || manifest.format !== 1
      || manifest.id !== REMOTE_COMPONENT_ID || typeof manifest.version !== "string" || manifest.version !== record.version
      || !/^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version)) fail();
  if (!exact(manifest.hostApi, ["remoteSession"]) || manifest.hostApi.remoteSession !== REMOTE_HOST_API) fail("HOST_API_REQUIRED");
  const files = manifest.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 32 || !hex(manifest.assetVersion) || payloadHash(files) !== manifest.assetVersion) fail();
  const required = RELEASE_FILES;
  if (Object.keys(files).length !== required.length || !required.every((f) => Object.hasOwn(files, f))) fail();
  const allowed = /^(gateway\/(component|runtime|protocol|crypto|pairing|identity|phone|tablet-data|tablet-control|presentation|store|relay-client|host-adapter)\.mjs|web\/ui\.(js|css))$/;
  const buffers = new Map(); let total = 0;
  for (const [rel, hash] of Object.entries(files)) {
    if (!allowed.test(rel) || !hex(hash)) fail();
    const bytes = plainFile(`releases/${manifest.assetVersion}/${rel}`);
    total += bytes.length;
    if (total > MAX_TOTAL || createHash("sha256").update(bytes).digest("hex") !== hash) fail();
    buffers.set(rel, bytes);
  }
  return Object.freeze({ version: manifest.version, assetVersion: manifest.assetVersion,
    entry: path.join(root, "releases", manifest.assetVersion, "gateway/component.mjs"),
    js: buffers.get("web/ui.js"), css: buffers.get("web/ui.css") });
}

/** The remote archive is not a general devkit package: reject extra paths and
 * non-regular entries before tar can materialize them, including hard links. */
export function assertRemoteArchiveEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 80) fail();
  const nodes = new Map(), versions = new Set();
  for (const entry of entries) {
    if (!entry || !["file", "dir"].includes(entry.type) || typeof entry.name !== "string" || entry.name.length > 512 || /[\\\0]/.test(entry.name)) fail();
    const name = entry.type === "dir" && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (name !== "usr" && !name.startsWith("usr/") || name.split("/").some((part) => !part || part === "." || part === "..")) fail();
    const rel = name === "usr" ? "" : name.slice(4);
    if (nodes.has(rel)) fail();
    nodes.set(rel, entry.type);
    if (rel.startsWith(`${FEATURE}/releases/`)) {
      const version = rel.slice(`${FEATURE}/releases/`.length).split("/")[0];
      if (!hex(version)) fail();
      versions.add(version);
    }
  }
  if (versions.size !== 1) fail();
  const files = new Set(packageFiles([...versions][0])), dirs = packageDirs(files);
  for (const [rel, type] of nodes) if (!(type === "file" ? files.has(rel) : dirs.has(rel))) fail();
  for (const file of files) if (nodes.get(file) !== "file") fail();
}

/** Validate the complete staged usr tree and its two inventories before the
 * generic installer reads MANIFEST, retires a runtime or moves any host file. */
export function readRemotePackage(prefix, options) {
  const descriptor = readRemotePayload(prefix, options);
  if (!descriptor) fail();
  const root = fs.realpathSync(prefix), expected = new Set(packageFiles(descriptor.assetVersion)), dirs = packageDirs(expected);
  const buffers = new Map(); let total = 0;
  function walk(rel) {
    const file = path.join(root, rel), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) {
      if (!dirs.has(rel)) fail();
      for (const name of fs.readdirSync(file)) walk(rel ? `${rel}/${name}` : name);
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || !expected.has(rel) || stat.size > (rel === `${INDEX}/MANIFEST` || rel === `${INDEX}/FILES` ? 16384 : MAX_FILE)) fail();
      total += stat.size; if (total > MAX_TOTAL) fail();
      buffers.set(rel, fs.readFileSync(file));
    }
  }
  walk("");
  if (buffers.size !== expected.size || [...expected].some((rel) => !buffers.has(rel))) fail();
  const lines = (rel) => {
    const text = buffers.get(rel).toString("utf8"), list = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    if (!list.length || list.some((line) => !line) || new Set(list).size !== list.length) fail();
    return list;
  };
  const inventory = lines(`${INDEX}/FILES`);
  if (inventory.length !== expected.size || inventory.some((rel) => !expected.has(rel))) fail();
  const hashed = new Set([...expected].filter((rel) => rel !== `${INDEX}/MANIFEST` && rel !== `${INDEX}/FILES`));
  const manifest = lines(`${INDEX}/MANIFEST`);
  if (manifest.length !== hashed.size) fail();
  for (const line of manifest) {
    const match = /^([0-9a-f]{64}) (0|[1-9][0-9]*) (.+)$/.exec(line);
    if (!match || !hashed.delete(match[3])) fail();
    const bytes = buffers.get(match[3]);
    if (String(bytes.length) !== match[2] || createHash("sha256").update(bytes).digest("hex") !== match[1]) fail();
  }
  if (hashed.size) fail();
  return descriptor;
}

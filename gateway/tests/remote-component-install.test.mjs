import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { buildRemoteComponent } from "../../scripts/build-remote-component.mjs";
import { createRemoteComponentManager } from "../gw/remote-component.mjs";

const prefix = process.env.CCAPP_PREFIX, home = process.env.CCAPP_HOME;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-component-install-"));
const base = "f".repeat(64);
const first = buildRemoteComponent({ out: path.join(dir, "first"), base });
const second = buildRemoteComponent({ out: path.join(dir, "second"), base, version: "0.1.0-test-update" });
let current = first, indexHostApi = 1, entryHostApi = 1;
// Exercise the existing manager's explicit unsigned test switch ONLY inside
// scripts/test.mjs's throwaway HOME/PREFIX. Production verifier is unchanged.
process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED = "1";
const server = http.createServer((req, res) => {
  if (req.url === "/index.json") {
    const entry = structuredClone(current.entry); entry.hostApi = { remoteSession: entryHostApi };
    if (indexHostApi === undefined) delete entry.builds[0].hostApi;
    else entry.builds[0].hostApi = typeof indexHostApi === "number" ? { remoteSession: indexHostApi } : indexHostApi;
    entry.builds[0].url = `http://127.0.0.1:${server.address().port}/payload.tar.gz`;
    res.end(JSON.stringify({ components: { "remote-session": entry } }));
  } else if (req.url === "/payload.tar.gz") { res.end(fs.readFileSync(current.archive)); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, { CCAPP_COMPONENTS_INDEX: origin + "/index.json", CCAPP_COMPONENTS_COMMUNITY_INDEX: origin + "/index.json", CCAPP_COMPONENTS_INDEX_MIRROR: origin + "/index.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: origin + "/index.json" });
fs.writeFileSync(path.join(prefix, ".devkit-ok"), JSON.stringify({ sha256: base }));
const tar = (await import("node:child_process")).spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
fs.symlinkSync(tar, path.join(prefix, "bin/tar"));
const comp = await import("../gw/components.mjs");
let live = 0, retired = 0;
const manager = createRemoteComponentManager({ prefix, home, readRecord: () => comp.compRecord("remote-session"), readDevkit: comp.devkitIdentity,
  createRuntime: async () => { live++; return { async retire() { retired++; }, async dispose() {}, subscribe() { return () => {}; } }; } });
comp.registerRemoteComponentProvider(() => manager);
after(async () => { await manager.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
function response() {
  const r = new EventEmitter(); r.req = {}; r.setHeader = () => {}; r.writeHead = (code) => { r.status = code; };
  r.end = (body) => { r.body = JSON.parse(String(body)); }; return r;
}
async function call(action, body) {
  const url = new URL("/api/components" + (action ? "/" + action : ""), origin);
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = body ? "POST" : "GET";
  const res = response(); await comp.routeComponents(req, res, url, url.pathname); return res.body;
}
async function installed(version) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const list = await call("", null), item = list.items.find((c) => c.id === "remote-session");
    if (item.state === "error") throw new Error(item.error);
    if (comp.compRecord("remote-session")?.version === version && !item.progress) return item;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("component installation did not finish");
}

test("existing component manager installs optional payload and activates without host-file writes", async () => {
  assert.equal((await call("install", { id: "remote-session" })).ok, true);
  const item = await installed(first.build.version);
  assert.equal(item.hostCompatible, true); assert.equal(item.hostApi.remoteSession, 1);
  assert.equal(item.feature.state, "active"); assert.equal(live, 1);
  const record = comp.compRecord("remote-session");
  assert.ok(record.files.every((f) => /^(share\/cccodroid\/components\/remote-session|libexec\/devkit\/components\/remote-session)\//.test(f)));
});

test("installed update retires old runtime first, uses new version and never revives old grants", async () => {
  current = second;
  assert.equal((await call("install", { id: "remote-session" })).ok, true);
  const item = await installed(second.build.version);
  assert.equal(item.feature.state, "active"); assert.equal(live, 2); assert.ok(retired >= 1);
});

test("disabled component remains disabled through reinstall and unknown host API is rejected", async () => {
  await manager.disable(); const was = live;
  assert.equal((await call("install", { id: "remote-session" })).ok, true);
  await installed(second.build.version);
  assert.equal((await manager.status()).state, "disabled"); assert.equal(live, was);
  indexHostApi = 2;
  const blocked = await call("install", { id: "remote-session" }); assert.equal(blocked.ok, false);
  assert.match(blocked.message, /宿主接口/); indexHostApi = 1;
});

test("selected artifact requirements never inherit the newest recipe or prior installed record", async () => {
  entryHostApi = 2; indexHostApi = undefined;
  try {
    assert.equal((await call("install", { id: "remote-session" })).ok, true);
    await installed(second.build.version);
    const item = (await call("", null)).items.find((c) => c.id === "remote-session");
    assert.equal(item.hostApi, null); assert.equal(item.hostCompatible, true);
    assert.equal(Object.hasOwn(comp.compRecord("remote-session"), "hostApi"), false);
    indexHostApi = 1;
    assert.equal((await call("install", { id: "remote-session" })).ok, true);
    await installed(second.build.version);
    assert.deepEqual(comp.compRecord("remote-session").hostApi, { remoteSession: 1 });
  } finally { entryHostApi = 1; indexHostApi = 1; }
});

test("malformed, empty or unknown artifact host capabilities fail closed before installation", async () => {
  try {
    for (const api of [null, false, [], {}, { remoteSession: "1" }, { remoteSession: 0 }, { remoteSession: 2 }, { remoteSession: 1, other: 1 }]) {
      indexHostApi = api;
      assert.equal((await call("install", { id: "remote-session" })).ok, false);
      const item = (await call("", null)).items.find((c) => c.id === "remote-session");
      assert.equal(item.hostCompatible, false);
      assert.deepEqual(comp.compRecord("remote-session").hostApi, { remoteSession: 1 });
    }
  } finally { indexHostApi = 1; }
});

test("uninstall retires feature, removes only payload and retains original user files", async () => {
  await manager.enable();
  const keep = path.join(home, "unrelated-original-task.txt"); fs.writeFileSync(keep, "keep original");
  const result = await call("remove", { id: "remote-session" });
  assert.equal(result.ok, true); assert.equal(comp.compRecord("remote-session"), null);
  assert.equal(fs.existsSync(path.join(prefix, "share/cccodroid/components/remote-session/component.json")), false);
  assert.equal(fs.readFileSync(keep, "utf8"), "keep original");
  assert.equal((await manager.status()).state, "absent");
});

test("actual uninstall then reinstall preserves retained disabled preference until explicit enable", async () => {
  const stateFile = path.join(home, ".cccodroid/remote-session/component-state.json");
  const before = live;
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).enabled, false);
  assert.equal((await call("install", { id: "remote-session" })).ok, true);
  const item = await installed(second.build.version);
  assert.equal(item.feature.state, "disabled"); assert.equal(item.feature.enabled, false);
  assert.equal(live, before, "reinstall must not create a runtime behind the user's off choice");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).enabled, false);
  assert.equal((await manager.enable()).state, "active"); assert.equal(live, before + 1);
  assert.equal((await call("remove", { id: "remote-session" })).ok, true);
});

import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOriginalRunFixture, LOCAL_SESSION, until } from "./fixtures/remote-app/original-run.mjs";
import { createRuntimeChain } from "./fixtures/remote-app/runtime-chain.mjs";
import { buildRemoteComponent } from "../../scripts/build-remote-component.mjs";
import { createRemoteComponentManager } from "../gw/remote-component.mjs";
import { createRemoteRuntime } from "../gw/remote/runtime.mjs";

test("retiring tablet component revokes real TLS grant, clears phone contents and keeps original child waiting", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  await chain.phone.open({ remoteSessionId: handle });
  const run = await original.start();
  const perm = await original.request(run, "Bash", { command: "printf must-remain-local" }, "component-retire");
  await until(async () => (await chain.phone.status()).snapshot.pending.some((p) => p.requestId === perm.id), "real request on phone");
  await chain.host.retire();
  assert.equal(chain.hostStore.grants().find((g) => g.remoteSessionId === handle).state, "revoked");
  assert.equal(original.RUNS.get(run.id), run); assert.equal(run.ended, false);
  assert.ok(run.perms.has(perm.id)); assert.equal(original.events.filter((e) => e.type === 'run_end' && e.aborted).length, 0);
  await until(async () => { const s = (await chain.phone.status()).snapshot; return !s.canControl && s.items.length === 0; }, "retirement clears phone view");
});

test("retiring phone releases active host grant over TLS and never stops or answers original task", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start(); const perm = await original.request(run, "Bash", { command: "printf no-approval" }, "phone-retire");
  await chain.phone.retire();
  await until(async () => (await chain.host.hosting(LOCAL_SESSION)).hosting.status === "revoked", "phone release on original host");
  assert.equal(original.RUNS.get(run.id), run); assert.ok(run.perms.has(perm.id));
  assert.equal(run.ended, false); assert.equal(original.events.filter((e) => e.type === 'run_end' && e.aborted).length, 0);
});

test("offline phone retirement persists a release tombstone without queuing execution", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  await chain.phone.disconnect(); await chain.phone.retire();
  const tombstone = chain.phoneStore.grants().find((g) => g.remoteSessionId === handle);
  assert.equal(tombstone.state, "release-pending");
  assert.equal(tombstone.hostDeviceId, chain.hostDeviceId);
  assert.equal(original.RUNS.get(run.id), run); assert.equal(run.ended, false);
  assert.equal(chain.phoneStore.snapshot().grants.filter((g) => g.state === "active").length, 0);
  const reopened = await createRemoteRuntime({ home: path.join(chain.root, "phone-reopened"), store: chain.phoneStore,
    identityBundle: chain.phoneIdentity, allowLoopback: true,
    sourceAdapter: { describe: () => null, readHistory: async () => ({ entries: [], cursor: null }), current: () => null },
    executor: { capabilities: {}, getRun: () => null, getRunOfSession: () => null, onEvent: () => () => {}, submitText: () => false, answerPerm: () => false, abortRun: () => false },
  });
  t.after(() => reopened.dispose());
  await reopened.connect();
  await until(async () => (await chain.host.hosting(LOCAL_SESSION)).hosting.status === "revoked", "persisted release flushed on new TLS channel");
  try { await until(() => !chain.phoneStore.grants().some((g) => g.remoteSessionId === handle), "release tombstone cleared only after host ack"); }
  catch (e) { console.error(JSON.stringify({ reopened: await reopened.settings(), host: await chain.host.settings(), grants: chain.phoneStore.grants(), relay: chain.relay.stats() })); throw e; }
  assert.equal((await reopened.list()).snapshot.sessions.some((g) => g.remoteSessionId === handle), false);
});

test("real built component entry loads through manager; disable before configure creates no identity or source access", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const base = "d".repeat(64), out = path.join(original.workspace, "component-payload");
  const built = buildRemoteComponent({ out, base });
  let touches = 0;
  const home = path.join(original.workspace, "component-home"); await fs.mkdir(home);
  const host = { home, source: { findSessionFile: () => { touches++; }, peekSession: () => { touches++; }, transcriptItems: () => { touches++; }, runOfSession: () => null, onPublish: () => { touches++; return () => {}; } }, executor: { onEvent: () => () => {}, getRunOfSession: () => null } };
  const manager = createRemoteComponentManager({ prefix: built.usr, home,
    readRecord: () => ({ id: "remote-session", state: "ok", version: built.build.version, base }), readDevkit: () => ({ sha256: base }),
    createRuntime: async (descriptor) => (await import(pathToFileURL(descriptor.entry).href)).create(host) });
  t.after(() => manager.close());
  assert.equal((await manager.status()).state, "active");
  assert.equal((await manager.invoke("status")).snapshot.deviceId, "remote-unconfigured");
  await manager.disable(); assert.equal(touches, 0);
  await assert.rejects(fs.access(path.join(home, "remote-v1/identity.json")));
  await assert.rejects(manager.invoke("hosting", LOCAL_SESSION), { code: "REMOTE_UNAVAILABLE" });
});

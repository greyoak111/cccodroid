import test from "node:test";
import assert from "node:assert/strict";
import { createOriginalRunFixture, LOCAL_SESSION, until, sleep } from "./fixtures/remote-app/original-run.mjs";
import { createRuntimeChain } from "./fixtures/remote-app/runtime-chain.mjs";

test("runtime updates an already-open idle session when its original run asks permission", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite();
  await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  try {
    const state = await until(async () => { const { snapshot } = await chain.phone.status(); return snapshot.pending.length ? snapshot : false; }, "live permission snapshot");
    assert.equal(state.binding.runId, run.id);
    assert.equal(state.pending[0].runId, run.id);
  } catch (e) {
    t.diagnostic(JSON.stringify({ host: await chain.host.settings(), phone: await chain.phone.status(), relay: chain.relay.stats() }));
    throw e;
  }
});

test("the original stream adapter records a text commit after the final assistant event", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const run = await original.start(), first = [...run.perms.values()][0];
  assert.equal(run.answerPerm(first.id, { behavior: "deny" }), true);
  await until(() => run.log.some((event) => event.type === "text_commit"), "actual original text commit boundary");
  const committed = run.log.findIndex((event) => event.type === "text_commit");
  assert.ok(run.log.slice(0, committed).some((event) => event.type === "delta" && event.text.includes("continued after denial")));
  assert.equal(run.log.filter((event) => event.type === "text_commit").length, 1);
  assert.deepEqual(original.attemptedExternal, []);
});

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

test("65 invite/revoke cycles reclaim terminal grants on both devices and keep old handles terminal", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  let first;
  for (let i = 0; i < 65; i++) {
    const handle = await chain.invite(); first ??= handle;
    if (i === 0) await chain.phone.accept({ remoteSessionId: handle });
    await chain.revoke();
    await until(async () => !(await chain.phone.list()).snapshot.sessions.some((s) => s.remoteSessionId === handle), 'cycle explicitly revoked on phone');
    assert.ok(chain.hostStore.grants().length <= 1);
    await sleep(20); // Stay inside the fixture relay's explicit message budget.
  }
  const next = await chain.invite(); assert.notEqual(next, first);
  await assert.rejects(chain.phone.open({ remoteSessionId: first }), { code: 'GRANT_NOT_ACTIVE' });
  await chain.phone.accept({ remoteSessionId: next });
  assert.equal((await chain.phone.status()).snapshot.canControl, true);
  assert.deepEqual(original.attemptedExternal, []);
});

test("a failed grant save leaves no hosted authority or data-plane allocation and explicit retry succeeds", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const putGrant = chain.hostStore.putGrant; let fail = true;
  chain.hostStore.putGrant = (grant) => { if (fail && grant.state === 'invited') throw Object.assign(new Error('synthetic durable save failure'), { code: 'EIO' }); return putGrant(grant); };
  const describe = chain.sourceAdapter.describe;
  chain.sourceAdapter.describe = (id) => describe(id.startsWith('failed-session-') ? LOCAL_SESSION : id);
  for (let i = 0; i < 35; i++) {
    const localSessionId = 'failed-session-' + i;
    await assert.rejects(chain.host.invite({ localSessionId, deviceId: chain.phoneDeviceId }), { code: 'EIO' });
    assert.equal((await chain.host.hosting(localSessionId)).hosting, null);
  }
  assert.deepEqual(chain.hostStore.grants(), []); assert.deepEqual((await chain.phone.list()).snapshot.sessions, []);
  fail = false; const handle = await chain.invite();
  await chain.phone.accept({ remoteSessionId: handle });
  assert.equal((await chain.phone.status()).snapshot.canControl, true);
  assert.deepEqual(original.attemptedExternal, []);
});

test("concurrent invitation clicks publish only one grant and explicit revoke permits a fresh lease", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const value = { localSessionId: LOCAL_SESSION, deviceId: chain.phoneDeviceId };
  const [first, second] = await Promise.allSettled([chain.host.invite(value), chain.host.invite(value)]);
  assert.equal(first.status, 'fulfilled'); assert.equal(second.status, 'rejected'); assert.equal(second.reason.code, 'HOSTING_CONFLICT');
  const handle = first.value.hosting.remoteSessionId;
  assert.equal(chain.hostStore.grants().filter((g) => g.state === 'invited').length, 1);
  await chain.host.revoke({ localSessionId: LOCAL_SESSION, remoteSessionId: handle, grantVersion: 1 });
  // Expiry and unacknowledged release retention are also covered directly by
  // the store regression; do not simulate clock travel across a live TLS peer.
  const next = await chain.invite(); assert.notEqual(next, handle);
});

test("phone invitation capacity reclaims physical terminal slots before reserving durable offline releases", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const expiresAt = Date.now() + 600000, offline = 'synthetic-offline-host';
  // Seed the exact mixed-role metadata state: one revoked local record and
  // 32 unacknowledged releases. None may be hidden by admission-only filtering.
  chain.phoneStore.putGrant({ localSessionId: 'prior-local', remoteSessionId: 'prior-revoked', state: 'revoked', expiresAt });
  for (let i = 0; i < 32; i++) chain.phoneStore.putGrant({ hostDeviceId: offline, phoneDeviceId: chain.phoneDeviceId,
    hostInstanceId: 'offline-instance', remoteSessionId: 'offline-release-' + i, grantVersion: 1, runId: null, state: 'release-pending', expiresAt });
  const describe = chain.sourceAdapter.describe;
  chain.sourceAdapter.describe = (id) => describe(id.startsWith('capacity-') ? LOCAL_SESSION : id);
  for (let i = 0; i < 32; i++) {
    await chain.host.invite({ localSessionId: 'capacity-' + i, deviceId: chain.phoneDeviceId });
    await sleep(20);
  }
  await until(async () => (await chain.phone.list()).snapshot.sessions.length === 32, 'all legal remote invitations received');
  assert.equal(chain.phoneStore.grants().some((g) => g.remoteSessionId === 'prior-revoked'), false);
  assert.equal(chain.phoneStore.grants().filter((g) => g.state === 'release-pending').length, 32);
  await chain.phone.disconnect(); await chain.phone.retire();
  const releases = chain.phoneStore.grants(); assert.equal(releases.length, 64);
  assert.ok(releases.every((g) => g.state === 'release-pending'));
  for (let i = 0; i < 32; i++) assert.ok(releases.some((g) => g.remoteSessionId === 'offline-release-' + i));
  assert.deepEqual(original.attemptedExternal, []);
});

test("ring overflow recovery continues delivering later permissions and messages", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  await until(async () => (await chain.phone.status()).snapshot.pending.length, "initial request");
  for (let i = 0; i < 257; i++) original.publish({ type: "note", text: "synthetic burst " + i, runId: run.id, sessionId: LOCAL_SESSION });
  await until(async () => (await chain.phone.status()).snapshot.seq >= 257, "gap recovery snapshot");
  const next = await original.request(run, "Bash", { command: "printf after-ring-gap" });
  await until(async () => (await chain.phone.status()).snapshot.pending.some((r) => r.requestId === next.id), "permission after recovered gap");
  const event = { type: "delta", text: "synthetic output after ring gap", runId: run.id, sessionId: LOCAL_SESSION };
  run.log.push(event); original.publish(event);
  await until(async () => (await chain.phone.status()).snapshot.items.some((r) => r.text?.includes(event.text)), "message after recovered gap");
  assert.equal(chain.relay.stats().closedTunnels, 0);
});

test("history racing an original run change cannot close the authenticated channel", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  await until(async () => (await chain.phone.status()).snapshot.pending.length, "original pending before history");
  await sleep(350);
  const read = chain.sourceAdapter.readHistory, entered = deferred(), release = deferred(); let hold = true;
  chain.sourceAdapter.readHistory = async (...args) => { if (hold) { hold = false; entered.resolve(); await release.promise; } return read(...args); };
  t.after(() => release.resolve());
  const snapshot = (await chain.phone.status()).snapshot;
  const result = chain.phone.history({ generation: snapshot.generation, binding: snapshot.binding, cursor: snapshot.historyCursor })
    .then((value) => ({ value }), (cause) => ({ cause }));
  await entered.promise;
  const previousId = run.id, nextId = previousId + "-new";
  original.RUNS.delete(previousId);
  original.RUNS.set(nextId, { ...run, id: nextId, perms: new Map(), log: [] }); release.resolve();
  const outcome = await result;
  assert.ok(outcome.value || outcome.cause?.code === "RESYNC_REQUIRED");
  const current = await chain.phone.open({ remoteSessionId: handle });
  assert.equal(current.snapshot.binding.runId, nextId);
  assert.equal(current.snapshot.canControl, true); assert.equal(chain.relay.stats().closedTunnels, 0);
  original.RUNS.delete(nextId); original.RUNS.set(previousId, run);
});

test("reconnect refreshes metadata-only pending notices without extra source events", async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start(), first = [...run.perms.values()][0];
  await until(() => chain.notifications.phone.at(-1)?.some((e) => e.requestId === first.id), "initial request notice");
  await chain.phone.close(); await chain.phone.disconnect();
  assert.equal(run.answerPerm(first.id, { behavior: "deny" }), true);
  const next = await original.request(run, "Bash", { command: "printf next-notice-fixture" });
  await sleep(250); await chain.phone.connect();
  await until(() => chain.notifications.phone.at(-1)?.some((e) => e.requestId === next.id), "current pending notice after reconnect");
  assert.equal(chain.notifications.phone.at(-1).some((e) => e.requestId === first.id), false);
  assert.equal((await chain.phone.status()).snapshot.active, null, "background metadata does not open conversation content");
});

test("completion synchronization cannot renew the same run's notification lifetime", async (t) => {
  let time; const original = await createOriginalRunFixture(); t.after(() => original.close());
  const chain = await createRuntimeChain({ original, now: () => time ?? Date.now() }); t.after(() => chain.close());
  // Do not freeze the verification clock before disposable certificates exist:
  // crossing an OpenSSL notBefore second would reject every handshake.
  time = Date.now();
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  await until(() => chain.notifications.phone.at(-1)?.some((e) => e.kind === "request"), "request metadata");
  original.RUNS.delete(run.id);
  original.publish({ type: "run_end", runId: run.id, sessionId: LOCAL_SESSION, aborted: false });
  const done = await until(() => chain.notifications.phone.at(-1)?.find((e) => e.kind === "done"), "completion metadata");
  assert.equal(done.expiresAt, time + 300000);
  time += 300001; await chain.phone.list();
  await until(() => !chain.notifications.phone.at(-1)?.some((e) => e.kind === "done"), "expired completion is not renewed");
  original.RUNS.set(run.id, run);
  original.publish({ type: "run_start", runId: run.id, sessionId: LOCAL_SESSION }); await sleep(150);
  original.RUNS.delete(run.id);
  original.publish({ type: "run_end", runId: run.id, sessionId: LOCAL_SESSION, aborted: true }); await sleep(150);
  assert.equal(chain.notifications.phone.at(-1).some((e) => e.kind === "done"), false, "same run cannot gain a new done lifetime through stopped/running transitions");
  original.RUNS.set(run.id, run);
});

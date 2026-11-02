import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { PassThrough } from 'node:stream';
import { createOriginalRunFixture, LOCAL_SESSION, PRIVATE_SENTINEL, until, sleep } from './fixtures/remote-app/original-run.mjs';

// Specification-derived integration cases. Do not replace an absent runtime with a synthetic route.
const gateway = new URL('../', import.meta.url);
const has = async (name) => fs.access(new URL(name, gateway)).then(() => true, () => false);

if (process.env.CCAPP_TEST !== '1') throw new Error('Run node scripts/test.mjs remote-e2e; real HOME is forbidden');

test('upstream original-run scope and continuation via actual stream-json adapter', async (t) => {
  const fixture = await createOriginalRunFixture();
  t.after(() => fixture.close());
  const run = await fixture.start();
  const request = [...run.perms.values()][0];
  assert.equal(request.tool, 'Bash');
  assert.equal(request.sessionId, LOCAL_SESSION);
  assert.equal(request.runId, run.id);
  assert.equal(run.answerPerm(request.id, { behavior: 'allow', input: { command: 'ATTACKER-REPLACEMENT' } }), true);
  await until(() => fixture.events.some((e) => e.runId === run.id && e.type === 'delta' && e.text.includes('Original execution continued')), 'original child continued after approval');
  const controls = (await fixture.childEvents()).filter((e) => e.kind === 'control_response');
  assert.equal(controls.length, 1);
  assert.deepEqual(controls[0].response.response.updatedInput, request.input, 'real run must use exact original tool scope');
  assert.equal(run.answerPerm(request.id, { behavior: 'allow' }), false, 'processed original permission cannot be reused');
  assert.equal(fixture.events.filter((e) => e.type === 'perm_resolved' && e.id === request.id).length, 1);
  assert.deepEqual(fixture.attemptedExternal, [], 'no model, metadata or external request attempted');
});

test('original AskUserQuestion, plan, deny, cancellation and local race remain real adapter contracts', async (t) => {
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  const run = await fixture.start();
  const first = [...run.perms.values()][0];
  assert.equal(run.answerPerm(first.id, { behavior: 'deny', message: 'Synthetic denial only' }), true);
  const questionInput = { questions: [{ question: 'Choose a synthetic option', header: 'Fixture', multiSelect: false, options: [{ label: 'First', description: 'Synthetic' }, { label: 'Second', description: 'Synthetic' }] }] };
  const question = await fixture.request(run, 'AskUserQuestion', questionInput);
  assert.equal(run.answerPerm(question.id, { behavior: 'allow', answers: { 'Choose a synthetic option': 'Second' } }), true);
  const planInput = { plan: '1. Inspect the synthetic fixture.\n2. Ask before each write.', allowedPrompts: [] };
  const plan = await fixture.request(run, 'ExitPlanMode', planInput);
  const winners = await Promise.all([Promise.resolve().then(() => run.answerPerm(plan.id, { behavior: 'allow' })), Promise.resolve().then(() => run.answerPerm(plan.id, { behavior: 'deny' }))]);
  assert.deepEqual(winners.sort(), [false, true], 'two original responders share one pending map');
  const canceled = await fixture.request(run, 'Edit', { file_path: '/synthetic/not-on-disk.txt', old_string: 'before', new_string: 'after' });
  await fixture.signal(run.id, { kind: 'cancel' });
  await until(() => !run.perms.has(canceled.id), 'real control_cancel_request invalidation');
  assert.equal(run.answerPerm(canceled.id, { behavior: 'allow' }), false);
  await until(async () => (await fixture.childEvents()).filter((e) => e.kind === 'control_response').length === 3, 'three original control replies');
  const replies = (await fixture.childEvents()).filter((e) => e.kind === 'control_response');
  assert.deepEqual(replies.find((e) => e.response.request_id === question.id).response.response.updatedInput, { ...questionInput, answers: { 'Choose a synthetic option': 'Second' } });
  const planReply = replies.find((e) => e.response.request_id === plan.id).response.response;
  assert.deepEqual(planReply.updatedInput, planInput);
  assert.equal(Object.hasOwn(planReply, 'updatedPermissions'), false, 'single plan approval adds no permission rules');
  assert.deepEqual(fixture.attemptedExternal, []);
});

test('actual history pagination is bounded and abort request is not run completion', async (t) => {
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  const page = await fixture.history({ limit: 50 });
  assert.ok(page.items.length <= 50);
  assert.ok(page.items.length > 0);
  assert.ok(page.cursor > 0, 'older original history remains paginatable');
  assert.doesNotMatch(JSON.stringify(page), new RegExp(PRIVATE_SENTINEL));
  const run = await fixture.start();
  assert.equal(fixture.abortRun(run), true);
  assert.equal(fixture.RUNS.has(run.id), true, 'abort dispatch alone cannot become stopped receipt');
  await until(() => !fixture.RUNS.has(run.id), 'actual original run end');
  assert.equal(fixture.events.filter((e) => e.type === 'run_end' && e.runId === run.id).length, 1);
  assert.equal(fixture.events.find((e) => e.type === 'run_end' && e.runId === run.id).aborted, true);
  assert.deepEqual(fixture.attemptedExternal, []);
});

test('independent protocol authority mutations reject before any adapter dispatch', async (t) => {
  if (!await has('gw/remote/protocol.mjs')) return t.skip('Protocol module not present');
  const { createFrame, validateFrame, assertBinding } = await import('../gw/remote/protocol.mjs');
  const now = 1_800_000_000_000;
  const binding = { fromDeviceId: 'fixture-phone', toDeviceId: 'fixture-tablet', hostInstanceId: 'fixture-boot', remoteSessionId: 'fixture-handle', grantVersion: 4, runId: 'fixture-run' };
  const grant = { hostDeviceId: binding.toDeviceId, phoneDeviceId: binding.fromDeviceId, hostInstanceId: binding.hostInstanceId, remoteSessionId: binding.remoteSessionId, grantVersion: binding.grantVersion, runId: binding.runId, state: 'active', expiresAt: now + 120000 };
  const request = { requestId: 'original-permission', requestVersion: 2, runId: binding.runId, state: 'pending', kind: 'permission', expiresAt: now + 10000, detailsComplete: true };
  const frame = createFrame('request.respond', binding, { requestId: request.requestId, requestVersion: request.requestVersion, response: { kind: 'permission', decision: 'allow' } }, { now, commandId: 'stable-permission-command' });
  assert.equal(assertBinding(frame, grant, { now, request }), true);
  for (const [key, value, expected] of [
    ['fromDeviceId', 'other-phone', 'DEVICE_MISMATCH'], ['toDeviceId', 'other-tablet', 'DEVICE_MISMATCH'],
    ['hostInstanceId', 'old-boot', 'HOST_INSTANCE_MISMATCH'], ['remoteSessionId', 'other-handle', 'SESSION_MISMATCH'],
    ['grantVersion', 3, 'GRANT_MISMATCH'], ['runId', 'old-run', 'RUN_MISMATCH'],
  ]) assert.throws(() => assertBinding({ ...frame, [key]: value }, grant, { now, request }), { code: expected }, key);
  for (const [mutation, code] of [
    [{ requestId: 'forged-request' }, 'REQUEST_MISMATCH'], [{ requestVersion: 1 }, 'REQUEST_MISMATCH'], [{ runId: 'old-run' }, 'REQUEST_MISMATCH'],
    [{ state: 'canceled' }, 'REQUEST_CLOSED'], [{ state: 'resolved' }, 'REQUEST_CLOSED'], [{ expiresAt: now }, 'REQUEST_EXPIRED'], [{ detailsComplete: false }, 'DETAILS_INCOMPLETE'],
  ]) assert.throws(() => assertBinding(frame, grant, { now, request: { ...request, ...mutation } }), { code });
  assert.throws(() => assertBinding(frame, { ...grant, state: 'revoked' }, { now, request }), { code: 'GRANT_REVOKED' });
  assert.throws(() => assertBinding(frame, { ...grant, state: 'invited' }, { now, request }), { code: 'GRANT_NOT_ACTIVE' });
  assert.throws(() => assertBinding(frame, grant, { now: frame.expiresAt, request }), { code: 'EXPIRED' });
  for (const [key, value] of [['input', { command: 'replacement' }], ['always', true], ['mode', 'bypassPermissions'], ['url', '/api/files'], ['model', 'other-model']]) {
    assert.throws(() => validateFrame({ ...frame, payload: { ...frame.payload, response: { ...frame.payload.response, [key]: value } } }, { now }), { code: 'UNKNOWN_FIELD' }, key);
  }
  const text = createFrame('message.submit', binding, { text: 'Synthetic text' }, { now, commandId: 'text-command' });
  for (const key of ['cwd', 'environment', 'attachments', 'shell', 'model', 'sessionId', 'permissionMode', 'url']) assert.throws(() => validateFrame({ ...text, payload: { ...text.payload, [key]: 'forbidden' } }, { now }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateFrame({ ...text, payload: { text: '字'.repeat(5462) } }, { now }), { code: 'LIMIT_EXCEEDED' }, 'UTF-8 byte limit, not string length');
});

test('unknown command outcome and saturated ledger never authorize redispatch', async (t) => {
  if (!await has('gw/remote/protocol.mjs')) return t.skip('Protocol module not present');
  const { createFrame, createCommandLedger } = await import('../gw/remote/protocol.mjs');
  const now = 1_800_000_000_000;
  const binding = { fromDeviceId: 'phone', toDeviceId: 'tablet', hostInstanceId: 'boot', remoteSessionId: 'handle', grantVersion: 1, runId: 'run' };
  const frame = createFrame('message.submit', binding, { text: 'Only once' }, { now, commandId: 'stable-text-id' });
  const ledger = createCommandLedger({ now: () => now, maxEntries: 1 });
  assert.equal(ledger.record(frame).duplicate, false);
  ledger.markUnknown(frame.commandId, binding);
  const retry = { ...frame, messageId: 'new-transport-message', issuedAt: now + 1, expiresAt: now + 1000 };
  const record = ledger.record(retry);
  assert.equal(record.duplicate, true); assert.equal(record.receipt.status, 'unknown');
  assert.equal(ledger.get(frame.commandId, binding).status, 'unknown');
  assert.throws(() => ledger.record({ ...retry, payload: { text: 'Different text' } }), { code: 'COMMAND_CONFLICT' });
  assert.throws(() => ledger.record({ ...retry, commandId: 'new-id' }), { code: 'LEDGER_FULL' });
  assert.equal(ledger.record(frame).receipt.status, 'unknown', 'full cache cannot evict old side-effect ID');
});

test('production outbox stays bounded and stop overtakes history at JS-only 3 Mbps', async (t) => {
  const file = new URL('../../remote-relay/src/flow.mjs', import.meta.url);
  if (!await fs.access(file).then(() => true, () => false)) return t.skip('Production relay outbox unavailable');
  const { PriorityOutbox } = await import(file);
  const rate = 3_000_000 / 8, sent = [], completed = [], callbacks = new Set();
  let peakSocketBytes = 0;
  const socket = { readyState: 1, bufferedAmount: 0, send(data, options, callback) {
    const bytes = Buffer.byteLength(data);
    socket.bufferedAmount += bytes; peakSocketBytes = Math.max(peakSocketBytes, socket.bufferedAmount);
    sent.push({ prefix: data.slice(0, 8), bytes, at: Date.now() });
    const timer = setTimeout(() => { callbacks.delete(timer); socket.bufferedAmount -= bytes; callback(); }, Math.ceil(bytes / rate * 1000)); callbacks.add(timer);
  } };
  const box = new PriorityOutbox({ socket, maxBytes: 512 * 1024, maxItems: 128, highReserveBytes: 128 * 1024, highReserveItems: 16, maxSocketBytes: 64 * 1024, sendBytesPerSecond: rate, burstBytes: 64 * 1024, pollIntervalMs: 1, onResult: (id, status) => completed.push({ id, status, at: Date.now() }) });
  t.after(() => { box.close(); for (const timer of callbacks) clearTimeout(timer); });
  const expiresAt = Date.now() + 30000;
  let accepted = 0, refused = 0, peakQueuedBytes = 0;
  for (let i = 0; i < 160; i++) {
    const r = box.enqueue({ data: 'HISTORY:' + 'x'.repeat(32 * 1024 - 8), priority: 2, expiresAt, metadata: 'history-' + i });
    r.ok ? accepted++ : refused++;
    peakQueuedBytes = Math.max(peakQueuedBytes, box.stats().queuedBytes);
  }
  assert.ok(accepted > 0 && refused > 0, 'saturation must produce explicit backpressure');
  assert.ok(peakQueuedBytes <= 384 * 1024, 'low priority cannot consume control reserve');
  await until(() => sent.length === 1, 'first synthetic slow-reader frame');
  assert.equal(box.stats().inFlight, true);
  const stopAt = Date.now();
  assert.equal(box.enqueue({ data: 'STOP:original-run', priority: 0, expiresAt, metadata: 'stop' }).ok, true);
  await until(() => completed.some((r) => r.id === 'stop'), 'priority stop drain', 3000);
  assert.equal(sent[1].prefix, 'STOP:ori', 'stop must be next after the one already committed frame');
  const stopLatencyMs = completed.find((r) => r.id === 'stop').at - stopAt;
  assert.ok(stopLatencyMs < 1500, `stop cannot wait behind full history queue (${stopLatencyMs}ms)`);
  assert.ok(peakSocketBytes <= 64 * 1024, 'bounded lower-layer writes');
  assert.ok(box.stats().queuedBytes <= 512 * 1024);
  t.diagnostic(JSON.stringify({ mode: 'production scheduler plus local JS drain, not WAN benchmark', rateBitsPerSecond: 3_000_000, accepted, refused, peakQueuedBytes, peakSocketBytes, stopLatencyMs, rssBytes: process.memoryUsage().rss }));
});

test('real tablet data source isolates original history, live stream, cursors and revoked reads', async (t) => {
  if (!await has('gw/remote/tablet-data.mjs')) return t.skip('Tablet data adapter not present');
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  const { createTabletData, createSourceAdapter } = await import('../gw/remote/tablet-data.mjs');
  const { findSessionFile, peekSession } = await import('../gw/sessions.mjs');
  const { transcriptItems } = await import('../gw/transcript.mjs');
  const adapter = createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession: fixture.runOfSession, onPublish: fixture.onPublish });
  const data = createTabletData({ adapter, hostInstanceId: 'isolated_data_boot' }); t.after(() => data.dispose());
  const grant = await data.authorize({ localSessionId: LOCAL_SESSION, remoteSessionId: 'isolated_data_handle', deviceId: 'isolated_phone', grantVersion: 1, expiresAt: Date.now() + 60000 });
  const context = { hostInstanceId: grant.hostInstanceId, remoteSessionId: grant.remoteSessionId, deviceId: grant.deviceId, grantVersion: grant.grantVersion };
  const page = await data.history(context);
  assert.ok(page.items.length > 0 && page.items.length <= 50);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(PRIVATE_SENTINEL));
  assert.equal(JSON.stringify(page).includes(LOCAL_SESSION), false, 'remote history cannot disclose local session ID');
  if (page.cursor) {
    const older = await data.history(context, { cursor: page.cursor });
    assert.ok(older.items.length <= 50);
    await assert.rejects(data.history({ ...context, deviceId: 'other_phone' }, { cursor: page.cursor }), (e) => !!e.code);
  }
  for (const mutation of [{ deviceId: 'wrong_phone' }, { hostInstanceId: 'old_boot' }, { remoteSessionId: 'unhosted_handle' }, { grantVersion: 0 }]) await assert.rejects(data.snapshot({ ...context, ...mutation }), (e) => !!e.code);
  const batches = [], unsubscribe = data.subscribe(context, (batch) => { batches.push(batch); return true; }); t.after(unsubscribe);
  const run = await fixture.start();
  fixture.publish({ type: 'delta', runId: 'other-run', sessionId: fixture.otherSessionId, text: PRIVATE_SENTINEL });
  const request = [...run.perms.values()][0];
  run.answerPerm(request.id, { behavior: 'allow' });
  await until(() => batches.some((batch) => JSON.stringify(batch).includes('Original execution continued')), 'selected-session live event crosses real data adapter');
  assert.equal(JSON.stringify(batches).includes(PRIVATE_SENTINEL), false);
  assert.equal(JSON.stringify(batches).includes(LOCAL_SESSION), false);
  const snap = await data.snapshot(context);
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 64 * 1024);
  assert.equal(data.revoke(grant.remoteSessionId), true);
  await assert.rejects(data.history(context), (e) => !!e.code);
  await assert.rejects(data.snapshot(context), (e) => !!e.code);
  assert.equal(fixture.RUNS.has(run.id), true, 'data revocation never stops original execution');
});

test('real authenticated encrypted channel accepts complete protocol binding and hides plaintext', async (t) => {
  if (!await has('gw/remote/crypto.mjs')) return t.skip('Authenticated channel module unavailable');
  const { createFrame } = await import('../gw/remote/protocol.mjs');
  const { createTlsFixture } = await import('./fixtures/remote-app/tls-channel.mjs');
  const root = await fs.mkdtemp(new URL('file://' + process.env.CCAPP_WORKSPACE + '/tls-acceptance-'));
  let channel;
  t.after(async () => { channel?.close(); await fs.rm(root, { recursive: true, force: true }); });
  channel = await createTlsFixture(root);
  const secret = 'SYNTHETIC-PLAINTEXT-NEVER-VISIBLE-TO-RELAY';
  const binding = { fromDeviceId: channel.phone.identity.deviceId, toDeviceId: channel.host.identity.deviceId, ...channel.context, runId: 'original-run' };
  const frame = createFrame('message.submit', binding, { text: secret }, { commandId: 'encrypted-original-message' });
  await channel.client.send(frame);
  await until(() => channel.receivedHost.length === 1, 'authenticated complete protocol control');
  assert.deepEqual(channel.receivedHost[0], frame);
  assert.equal(Buffer.concat(channel.wire.map((packet) => packet.bytes)).includes(Buffer.from(secret)), false, 'ciphertext relay cannot see original text');
});

test('real tablet control resolves original request exactly once across remote/local race and stop', async (t) => {
  if (!await has('gw/remote/tablet-control.mjs')) return t.skip('Tablet controller not present');
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  const run = await fixture.start();
  const { createOriginalControl } = await import('./fixtures/remote-app/original-control.mjs');
  const chain = createOriginalControl({ original: fixture, run }); t.after(() => chain.control.close());
  const request = chain.control.describeRequests(LOCAL_SESSION)[0];
  const payload = { requestId: request.requestId, requestVersion: request.requestVersion, response: { kind: 'permission', decision: 'allow' } };
  const command = chain.frame('request.respond', payload, 'original-remote-allow');
  for (const [mutation, code] of [[{ fromDeviceId: 'other_phone' }, 'DEVICE_MISMATCH'], [{ runId: 'old_run' }, 'RUN_MISMATCH'], [{ grantVersion: 9 }, 'GRANT_MISMATCH'], [{ hostInstanceId: 'old_boot' }, 'HOST_INSTANCE_MISMATCH']]) {
    await assert.rejects(chain.control.submit({ ...command, ...mutation }, chain.grant.phoneDeviceId), { code });
    assert.equal(run.perms.size, 1);
  }
  const receipt = await chain.control.submit(command, chain.grant.phoneDeviceId);
  assert.equal(receipt.payload.status, 'applied');
  assert.equal((await chain.control.submit(command, chain.grant.phoneDeviceId)).payload.status, 'applied');
  await until(async () => (await fixture.childEvents()).filter((e) => e.kind === 'control_response').length === 1, 'one child response from duplicate remote controls');
  const next = await fixture.request(run, 'Edit', { file_path: '/synthetic/f.txt', old_string: 'before', new_string: 'after' });
  const remoteRef = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === next.id);
  const race = chain.frame('request.respond', { requestId: remoteRef.requestId, requestVersion: remoteRef.requestVersion, response: { kind: 'permission', decision: 'allow' } }, 'local-phone-race');
  const pending = chain.control.submit(race, chain.grant.phoneDeviceId);
  assert.equal(run.answerPerm(next.id, { behavior: 'deny', message: 'Local won race' }), true);
  await assert.rejects(pending, { code: 'REQUEST_CLOSED' });
  assert.equal((await fixture.childEvents()).filter((e) => e.kind === 'control_response' && e.response.request_id === next.id).length <= 1, true);
  const canceled = await fixture.request(run, 'Bash', { command: 'printf cancel-only' }, 'cancel-test');
  const oldRef = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === canceled.id);
  await fixture.signal(run.id, { kind: 'cancel' }); await until(() => !run.perms.has(canceled.id), 'real original cancel');
  await assert.rejects(chain.control.submit(chain.frame('request.respond', { requestId: oldRef.requestId, requestVersion: oldRef.requestVersion, response: { kind: 'permission', decision: 'allow' } }, 'canceled-remote'), chain.grant.phoneDeviceId), { code: 'REQUEST_CLOSED' });
  const stop = chain.frame('run.stop', {}, 'original-remote-stop');
  const requested = await chain.control.submit(stop, chain.grant.phoneDeviceId);
  assert.equal(requested.payload.status, 'received', 'abort return must not be stopped');
  await until(() => chain.receipts.some((r) => r.commandId === stop.commandId && r.payload.status === 'applied'), 'real child close stop receipt');
  assert.equal(chain.receipts.find((r) => r.commandId === stop.commandId && r.payload.status === 'applied').payload.result.runState, 'stopped');
  assert.equal(fixture.RUNS.has(run.id), false);
});

test('real remote questions/plans and guard approval preserve original scope and one-time safety', async (t) => {
  if (!await has('gw/remote/tablet-control.mjs')) return t.skip('Tablet controller unavailable');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const run = await original.start(); run.answerPerm([...run.perms.keys()][0], { behavior: 'deny' });
  const { createOriginalControl } = await import('./fixtures/remote-app/original-control.mjs');
  const chain = createOriginalControl({ original, run, executorOverrides: { capabilities: { remoteOnce: true, planDefault: true } } }); t.after(() => chain.control.close());
  const respond = async (ref, response, id) => chain.control.submit(chain.frame('request.respond', { requestId: ref.requestId, requestVersion: ref.requestVersion, response }, id), chain.grant.phoneDeviceId);
  const raw = await original.request(run, 'AskUserQuestion', { questions: [{ question: 'Synthetic decision', multiSelect: false, options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] });
  const question = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === raw.id);
  assert.equal(question.kind, 'question');
  const q = question.questions[0];
  await assert.rejects(respond(question, { kind: 'question', answers: [{ questionId: q.questionId, optionIds: ['forged-option'] }] }, 'forged-question-answer'), { code: 'REQUEST_MISMATCH' });
  const response = await respond(question, { kind: 'question', answers: [{ questionId: q.questionId, optionIds: [], text: 'A synthetic free response' }] }, 'original-question-free-answer');
  assert.equal(response.payload.status, 'applied');
  await until(async () => (await original.childEvents()).some((event) => event.kind === 'control_response' && event.response.request_id === raw.id), 'original question child response');
  const received = (await original.childEvents()).find((event) => event.kind === 'control_response' && event.response.request_id === raw.id).response.response;
  assert.equal(received.updatedInput.answers['Synthetic decision'], 'A synthetic free response');
  const plan = await original.request(run, 'ExitPlanMode', { plan: '1. Synthetic inspect\n2. Explicit per-tool approval' });
  const planRef = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === plan.id);
  const approved = await respond(planRef, { kind: 'plan', decision: 'approve' }, 'original-plan-once');
  assert.equal(approved.payload.status, 'applied');
  await until(async () => (await original.childEvents()).some((event) => event.kind === 'host_control_request' && event.request?.subtype === 'set_permission_mode'), 'real plan resets default mode');
  assert.equal((await original.childEvents()).find((event) => event.kind === 'host_control_request' && event.request?.subtype === 'set_permission_mode').request.mode, 'default');
  const guarded = await original.request(run, 'Bash', { command: 'printf synthetic-guard' }, 'guarded');
  guarded.guard = { cat: 'fixture-sensitive', what: 'Synthetic guarded operation' };
  const guardRef = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === guarded.id);
  assert.equal((await respond(guardRef, { kind: 'permission', decision: 'allow' }, 'original-guard-once')).payload.status, 'applied');
  assert.equal(run.guardOk?.has('fixture-sensitive') || false, false, 'remote one-time approval cannot enable future same-category guard bypass');
  const system = await original.request(run, 'Bash', { command: 'printf system-only' }, 'system');
  system.guard = { cat: 'prompt:android-authorization', what: 'Synthetic system prompt' };
  const systemRef = chain.control.describeRequests(LOCAL_SESSION).find((r) => r.requestId === system.id);
  assert.equal(systemRef.kind, 'local'); assert.equal(systemRef.detailsComplete, false);
  await assert.rejects(respond(systemRef, { kind: 'permission', decision: 'allow' }, 'system-cannot-remote'), (error) => ['FORBIDDEN', 'DETAILS_INCOMPLETE', 'REQUEST_MISMATCH'].includes(error.code));
  assert.equal(run.perms.has(system.id), true);
});

test('uncertain real adapter dispatch survives journal reopen without redispatch; revoke leaves task running', async (t) => {
  if (!await has('gw/remote/tablet-control.mjs')) return t.skip('Tablet controller not present');
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  const run = await fixture.start();
  const { createOriginalControl } = await import('./fixtures/remote-app/original-control.mjs');
  let calls = 0;
  const chain = createOriginalControl({ original: fixture, run, executorOverrides: { answerPerm: (target, id, answer) => { calls++; target.answerPerm(id, answer); throw new Error('Synthetic post-write receipt loss'); } } });
  const ref = chain.control.describeRequests(LOCAL_SESSION)[0];
  const command = chain.frame('request.respond', { requestId: ref.requestId, requestVersion: ref.requestVersion, response: { kind: 'permission', decision: 'allow' } }, 'uncertain-write');
  assert.equal((await chain.control.submit(command, chain.grant.phoneDeviceId)).payload.status, 'unknown');
  chain.control.close();
  const reopened = chain.make(); t.after(() => reopened.close());
  assert.equal((await reopened.submit(command, chain.grant.phoneDeviceId)).payload.status, 'unknown');
  assert.equal(calls, 1, 'persisted unknown may never become safe replay');
  assert.equal((await reopened.query(chain.frame('control.query', {}, command.commandId), chain.grant.phoneDeviceId)).payload.status, 'unknown');
  const newBoot = chain.make('restarted_host_boot'); t.after(() => newBoot.close());
  await assert.rejects(newBoot.submit(command, chain.grant.phoneDeviceId), { code: 'HOST_INSTANCE_MISMATCH' });
  const p = await fixture.request(run, 'Bash', { command: 'printf no-revoke-execute' }, 'revoke');
  const pending = reopened.describeRequests(LOCAL_SESSION).find((r) => r.requestId === p.id);
  const race = reopened.submit(chain.frame('request.respond', { requestId: p.id, requestVersion: pending.requestVersion, response: { kind: 'permission', decision: 'allow' } }, 'revoke-wins'), chain.grant.phoneDeviceId);
  await reopened.revoke(chain.grant.remoteSessionId, () => { chain.grant.state = 'revoked'; });
  await assert.rejects(race, { code: 'GRANT_REVOKED' });
  assert.equal(run.perms.has(p.id), true); assert.equal(fixture.RUNS.has(run.id), true);
});

test('real remote text hook queues busy original session exactly once and neutralizes slash controls', async (t) => {
  const fixture = await createOriginalRunFixture(); t.after(() => fixture.close());
  if (typeof fixture.enqueueRemoteText !== 'function') return t.skip('Production literal remote text hook unavailable');
  const run = await fixture.start();
  const { createOriginalControl } = await import('./fixtures/remote-app/original-control.mjs');
  const chain = createOriginalControl({ original: fixture, run, executorOverrides: {
    capabilities: { literalText: true, messageReplay: true }, submitText: fixture.enqueueRemoteText,
  } }); t.after(() => chain.control.close());
  const text = '/model synthetic-do-not-change-model';
  const command = chain.frame('message.submit', { text }, 'literal-original-text-once');
  assert.equal((await chain.control.submit(command, chain.grant.phoneDeviceId)).payload.status, 'received');
  assert.equal((await chain.control.submit(command, chain.grant.phoneDeviceId)).payload.status, 'received');
  assert.equal(fixture.QUEUE.length, 1, 'same command ID creates one real queue item');
  const queued = fixture.QUEUE[0];
  assert.equal(queued.sessionId, LOCAL_SESSION); assert.equal(queued.literalText, true);
  assert.equal(queued.sourceDeviceId, chain.grant.phoneDeviceId);
  assert.equal(queued.remoteCommandId, command.commandId);
  assert.equal(run.aborted, false, 'normal remote submit cannot implicitly interrupt busy run');
  const pending = [...run.perms.values()][0]; run.answerPerm(pending.id, { behavior: 'deny' });
  await until(() => !run.perms.size, 'original permissions settle before finish');
  await fixture.signal(run.id, { kind: 'finish' });
  await until(() => fixture.RUNS.has(queued.id) && fixture.RUNS.get(queued.id).perms?.size, 'queued remote text starts in original session');
  await until(() => chain.receipts.some((r) => r.commandId === command.commandId && r.payload.status === 'applied'), 'real message replay receipt');
  const deliveries = (await fixture.childEvents()).filter((e) => e.kind === 'user' && JSON.stringify(e.message).includes('synthetic-do-not-change-model'));
  assert.equal(deliveries.length, 1);
  const content = deliveries[0].message.content;
  const deliveredText = typeof content === 'string' ? content : content[0].text;
  assert.equal(deliveredText.trim().startsWith('/'), false, 'slash must not be CLI/local command syntax');
  assert.ok(deliveredText.endsWith(text), 'neutralized text still contains exact user wording');
  assert.equal(fixture.events.filter((e) => e.type === 'message_delivered' && e.remoteCommandId === command.commandId).length, 1);
  assert.equal(fixture.events.some((e) => e.localCommand === 'model'), false);
  await assert.rejects(chain.control.submit({ ...command, payload: { text: 'changed same ID' } }, chain.grant.phoneDeviceId), { code: 'COMMAND_CONFLICT' });
});

test('phone provenance survives real original run → data projection → presentation', async (t) => {
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const { createTabletData, createSourceAdapter } = await import('../gw/remote/tablet-data.mjs');
  const { normaliseSnapshot } = await import('../gw/remote/presentation.mjs');
  const { findSessionFile, peekSession } = await import('../gw/sessions.mjs');
  const { transcriptItems } = await import('../gw/transcript.mjs');
  const data = createTabletData({ adapter: createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession: original.runOfSession, onPublish: original.onPublish }), hostInstanceId: 'source_boot' }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: LOCAL_SESSION, remoteSessionId: 'source_handle', deviceId: 'source_phone', grantVersion: 1, expiresAt: Date.now() + 60000 });
  const text = 'Synthetic remote provenance is not inferred from wording';
  const item = original.enqueueRemoteText({ sessionId: LOCAL_SESSION, text, commandId: 'source_text_once', sourceDeviceId: 'source_phone' });
  assert.ok(item);
  await until(() => original.RUNS.get(item.id)?.perms?.size, 'real remote original run starts');
  const snapshot = normaliseSnapshot(await data.snapshot(context), { scope: context.remoteSessionId });
  const records = snapshot.items.filter((entry) => entry.role === 'user' && entry.text === text);
  assert.ok(records.length > 0, 'original remote message is visible');
  assert.ok(records.some((record) => record.source === 'phone'), 'trusted original source marker must survive projection for both-end source labels');
});

test('actual phone frontend and actual local remote dispatcher share the same routes', async (t) => {
  if (!await has('gw/remote.mjs') || !await has('web/app/13r-remote-transport.js')) return t.skip('Remote frontend/dispatcher not present');
  const { createRemoteRoute } = await import('../gw/remote.mjs');
  const now = Date.now();
  const binding = { fromDeviceId: 'contract-phone', toDeviceId: 'contract-host', hostInstanceId: 'contract-boot', remoteSessionId: 'contract-handle', grantVersion: 1, runId: 'contract-run' };
  let revision = 0, active = false;
  const snapshot = () => ({ revision: ++revision, generation: 1, deviceId: binding.fromDeviceId, connection: active ? 'online' : 'offline', phase: active ? 'ready' : 'idle', verified: active, canControl: active, cached: false,
    sessions: [{ remoteSessionId: binding.remoteSessionId, deviceId: binding.toDeviceId, grantVersion: 1, state: 'active', expiresAt: now + 60000 }],
    active: active ? { remoteSessionId: binding.remoteSessionId, deviceId: binding.toDeviceId } : null, binding: active ? binding : null, grant: active ? { state: 'active', expiresAt: now + 60000 } : null,
    run: active ? { runId: binding.runId, state: 'running' } : null, pending: [], items: [], receipts: [], historyCursor: null, historyHasMore: false, error: null });
  const route = createRemoteRoute({
    status: async () => ({ snapshot: snapshot() }), list: async () => ({ snapshot: snapshot() }),
    open: async () => { active = true; return { snapshot: snapshot() }; },
    close: async () => { active = false; return { snapshot: snapshot() }; },
  });
  const requests = [];
  const invoke = async (url, options = {}) => {
    const req = new PassThrough(); req.method = options.method || 'GET'; req.ccAuthed = true;
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(data) { this.data = JSON.parse(String(data)); } };
    const u = new URL(url, 'http://127.0.0.1'); requests.push(req.method + ' ' + u.pathname);
    const work = route(req, res, u, u.pathname); req.end(options.body || ''); await work;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, headers: { get: () => null }, json: async () => res.data };
  };
  const context = vm.createContext({ window: {}, fetch: invoke, TextEncoder, AbortController, setTimeout, clearTimeout, Date, crypto: globalThis.crypto });
  const source = await fs.readFile(new URL('../web/app/13r-remote-transport.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  const transport = context.window.createRemoteTransport({ fetch: invoke, eventSource: () => null }); t.after(() => transport.destroy());
  await transport.status(); await transport.list();
  const opened = await transport.open(binding.remoteSessionId);
  assert.equal(opened.active.remoteSessionId, binding.remoteSessionId);
  assert.equal(opened.canControl, true);
  await transport.close();
  assert.ok(requests.includes('POST /api/remote/open') && requests.includes('POST /api/remote/close'));
  const bad = await invoke('/api/remote/command', { method: 'POST', body: JSON.stringify({ generation: 1, binding, type: 'message.submit', commandId: 'no-tunnel', payload: { text: 'test' }, url: '/api/files', cwd: '/private' }) });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'INVALID_SCHEMA');
  const unknown = await invoke('/api/remote/proxy', { method: 'POST', body: JSON.stringify({ url: '/api/files' }) });
  assert.equal(unknown.status, 404);
  const req = new PassThrough(); req.method = 'GET'; req.ccAuthed = false;
  const denied = { setHeader() {}, writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(String(data)); } };
  const url = new URL('http://127.0.0.1/api/remote/status');
  await route(req, denied, url, url.pathname); req.end();
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'FORBIDDEN');
});

test('actual relay WebSocket authenticates, forwards opaque TLS and refuses wrong paired-device routing', async (t) => {
  const file = new URL('../../remote-relay/src/tunnel-server.mjs', import.meta.url);
  if (!await fs.access(file).then(() => true, () => false)) return t.skip('Production opaque TLS relay not present');
  const { createTunnelTlsFixture, websocketPeer } = await import('./fixtures/remote-app/tunnel-channel.mjs');
  const { createFrame } = await import('../gw/remote/protocol.mjs');
  const root = await fs.mkdtemp(process.env.CCAPP_WORKSPACE + '/relay-e2e-');
  let chain, wrong, restarted;
  const reconnected = [];
  t.after(async () => { for (const peer of reconnected) peer.close(); await restarted?.close(); wrong?.close(); await chain?.close(); await fs.rm(root, { recursive: true, force: true }); });
  chain = await createTunnelTlsFixture(root);
  const text = 'REAL-RELAY-CIPHERTEXT-ONLY-SYNTHETIC-TEXT';
  const frame = createFrame('message.submit', { fromDeviceId: chain.phone.identity.deviceId, toDeviceId: chain.host.identity.deviceId, ...chain.context, runId: 'original_run' }, { text }, { commandId: 'relay_once' });
  await chain.client.send(frame); await until(() => chain.frames.length === 1, 'TLS control across real WebSocket relay');
  assert.equal(chain.frames[0].payload.text, text);
  assert.equal(chain.relay.stats().forwardedChunks > 0, true);
  const wire = chain.hostPeer.messages.filter((m) => m.op === 'tunnel.data').map((m) => Buffer.from(m.data, 'base64'));
  assert.equal(Buffer.concat(wire).includes(Buffer.from(text)), false);
  assert.equal(JSON.stringify(chain.logs).includes(text), false);
  const persisted = await fs.readFile(root + '/relay-state.json', 'utf8');
  assert.equal(persisted.includes(text), false);
  assert.equal(persisted.includes(chain.hostToken) || persisted.includes(chain.phoneToken), false, 'relay persists token digests, not credentials');
  wrong = await websocketPeer(chain.origin, 'fixture_wrong_device', chain.wrongToken);
  wrong.send({ op: 'tunnel.open', tunnelId: 'wrong-device-tunnel', toDeviceId: chain.host.identity.deviceId, purpose: 'peer' });
  await until(() => wrong.messages.some((m) => m.op === 'error'), 'unpaired device refusal');
  assert.equal(wrong.messages.find((m) => m.op === 'error').code, 'unpaired');
  assert.equal(chain.relay.stats().tunnels, 1, 'wrong connection identity cannot create an authorized session tunnel');
  t.diagnostic(JSON.stringify({ actualWebSocketRelay: true, stats: chain.relay.stats(), syntheticIdentities: true, innerTLS: 'TLSv1.3' }));
  wrong.close(); await chain.close();
  const { createTunnelRelayServer } = await import('../../remote-relay/src/tunnel-server.mjs');
  restarted = await createTunnelRelayServer({ stateFile: root + '/relay-state.json' });
  await restarted.listen(); const freshOrigin = 'ws://127.0.0.1:' + restarted.address().port;
  reconnected.push(await websocketPeer(freshOrigin, chain.host.identity.deviceId, chain.hostToken));
  reconnected.push(await websocketPeer(freshOrigin, chain.phone.identity.deviceId, chain.phoneToken));
  assert.equal(restarted.stats().tunnels, 0, 'restart never resurrects old TLS stream');
  assert.equal(reconnected.flatMap((peer) => peer.messages).some((message) => message.op === 'tunnel.data'), false, 'no encrypted control replay from persistent metadata');
  reconnected[1].send({ op: 'tunnel.data', tunnelId: 'independent_tls_tunnel', data: Buffer.from('old-control').toString('base64') });
  await until(() => reconnected[1].messages.some((m) => m.op === 'error'), 'old relay tunnel rejected after restart');
  assert.equal(reconnected[1].messages.find((m) => m.op === 'error').code, 'tunnel_missing');
});

test('full recent-history page plus live original work stays bounded without losing updates', async (t) => {
  if (!await has('gw/remote/presentation.mjs')) return t.skip('Production presentation adapter unavailable');
  const { normaliseSnapshot } = await import('../gw/remote/presentation.mjs');
  const { createTabletData, createSourceAdapter } = await import('../gw/remote/tablet-data.mjs');
  const { findSessionFile, peekSession } = await import('../gw/sessions.mjs');
  const { transcriptItems } = await import('../gw/transcript.mjs');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const run = await original.start(); run.answerPerm([...run.perms.keys()][0], { behavior: 'allow' });
  await until(() => original.events.some((e) => e.type === 'delta'), 'real live output alongside full source history');
  const adapter = createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession: original.runOfSession, onPublish: original.onPublish });
  const data = createTabletData({ adapter, hostInstanceId: 'full_page_boot' }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: LOCAL_SESSION, remoteSessionId: 'full_page_handle', deviceId: 'full_page_phone', grantVersion: 1, expiresAt: Date.now() + 60000 });
  const raw = await data.snapshot(context);
  const result = normaliseSnapshot(raw, { scope: 'full_page_handle' });
  assert.ok(result.items.length <= 50);
  assert.ok(result.items.some((item) => item.text?.includes('Original execution continued')), 'must preserve latest live output instead of staying on stale idle snapshot');
  assert.ok(result.historyHasMore && result.historyCursor, 'producer must retain cursor for history withheld to reserve live capacity');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 60 * 1024);
});

test('real runtime first pairing requires both authenticated device confirmations and code is one-time', async (t) => {
  if (!await has('gw/remote/runtime.mjs')) return t.skip('Runtime factory not present');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const { createRuntimeChain } = await import('./fixtures/remote-app/runtime-chain.mjs');
  const chain = await createRuntimeChain({ original, prepaired: false }); t.after(() => chain.close());
  assert.equal((await chain.host.pairing()).devices.length, 0);
  const offer = await chain.host.pairOffer();
  assert.ok(offer.code.length > 32, 'high-entropy out-of-band offer, not a short PIN authorization');
  const joined = await chain.phone.pairJoin({ code: offer.code });
  const hostAttempt = await until(async () => (await chain.host.pairing()).pending.find((p) => p.peer?.deviceId === chain.phoneDeviceId), 'host sees actual pinned incoming pairing');
  await assert.rejects(chain.host.pairConfirm({ pairingId: hostAttempt.pairingId, expectedFingerprint: 'wrong-fingerprint', verificationCode: hostAttempt.verificationCode }), { code: 'FINGERPRINT_MISMATCH' });
  await chain.host.pairConfirm({ pairingId: hostAttempt.pairingId, expectedFingerprint: hostAttempt.peer.fingerprint, verificationCode: hostAttempt.verificationCode });
  assert.equal((await chain.host.pairing()).devices.length, 0, 'one device click is not mutual pairing');
  const phoneAttempt = (await chain.phone.pairing()).pending.find((p) => p.pairingId === joined.pairingId);
  assert.ok(phoneAttempt);
  assert.equal(phoneAttempt.verificationCode, hostAttempt.verificationCode);
  await chain.phone.pairConfirm({ pairingId: phoneAttempt.pairingId, expectedFingerprint: phoneAttempt.peer.fingerprint, verificationCode: phoneAttempt.verificationCode });
  await until(async () => (await chain.host.pairing()).devices.length === 1 && (await chain.phone.pairing()).devices.length === 1, 'both runtimes commit pairing');
  await assert.rejects(chain.phone.pairJoin({ code: offer.code }), 'one-time consumed pairing offer cannot be reused');
  assert.equal((await chain.phone.list()).snapshot.sessions.length, 0, 'pairing itself cannot grant original session access');
});

test('independent real runtime rejects a stale request version instead of approving current original scope', async (t) => {
  if (!await has('gw/remote/runtime.mjs')) return t.skip('Runtime factory not present');
  // Small-history isolate is additional to, NOT a replacement for, retained
  // 120-record full-page failure cases. It exposes the next security boundary.
  const original = await createOriginalRunFixture({ historyItems: 4 }); t.after(() => original.close());
  const { createRuntimeChain } = await import('./fixtures/remote-app/runtime-chain.mjs');
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  const snapshot = await until(async () => { const value = (await chain.phone.status()).snapshot; return value.pending.length ? value : false; }, 'small-history actual request snapshot');
  const request = snapshot.pending[0];
  await assert.rejects(chain.phone.command({ generation: snapshot.generation, binding: snapshot.binding, type: 'request.respond', commandId: 'isolated-stale-version', payload: { requestId: request.requestId, requestVersion: request.requestVersion + 1, response: { kind: 'permission', decision: 'allow' } } }), { code: 'REQUEST_MISMATCH' });
  assert.equal(run.perms.has(request.requestId), true);
  assert.equal((await original.childEvents()).some((event) => event.kind === 'control_response' && event.response.request_id === request.requestId), false);
});

test('actual tablet runtime restart revokes old grant without executing or stopping original work', async (t) => {
  if (!await has('gw/remote/runtime.mjs')) return t.skip('Runtime factory not present');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const { createRuntimeChain } = await import('./fixtures/remote-app/runtime-chain.mjs');
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  const snapshot = await until(async () => { const value = (await chain.phone.status()).snapshot; return value.pending.length ? value : false; }, 'actual original request before host restart');
  const previousHostInstance = snapshot.binding.hostInstanceId;
  const rebooted = await chain.restartHost();
  assert.notEqual(rebooted.hostInstanceId, previousHostInstance);
  assert.equal((await rebooted.hosting(LOCAL_SESSION)).hosting.status, 'revoked');
  assert.equal(original.RUNS.has(run.id), true, 'runtime lifecycle cannot stop the task as a side effect of revocation');
  // Dispatch may reject before send, or truthfully resolve unknown if loss won
  // after the ready check. Neither outcome may be reported as applied.
  const command = { generation: snapshot.generation, binding: snapshot.binding, type: 'request.respond', commandId: 'pre-reboot-permission', payload: { requestId: snapshot.pending[0].requestId, requestVersion: snapshot.pending[0].requestVersion, response: { kind: 'permission', decision: 'allow' } } };
  const outcome = await chain.phone.command(command).then((value) => ({ value }), (cause) => ({ cause }));
  if (outcome.value) assert.equal(outcome.value.receipt.status, 'unknown');
  else assert.ok(['OFFLINE', 'RESYNC_REQUIRED', 'GRANT_REVOKED', 'HOST_INSTANCE_MISMATCH'].includes(outcome.cause.code));
  const retired = await until(async () => { const s = (await chain.phone.status()).snapshot; return ['revoked', 'expired'].includes(s.phase) ? s : false; }, 'restart explicitly retires the cached old grant');
  assert.deepEqual(retired.items, []); assert.deepEqual(retired.pending, []); assert.equal(retired.canControl, false);
  await assert.rejects(chain.phone.command(command), (cause) => ['RESYNC_REQUIRED', 'GRANT_REVOKED'].includes(cause.code));
  assert.equal(run.perms.has(snapshot.pending[0].requestId), true);
  assert.equal((await original.childEvents()).some((event) => event.kind === 'control_response'), false, 'old host-bound approval cannot reach original child');
});

test('runtime bounds a coalesced long source log and keeps controls reachable at JS-only 3 Mbps', async (t) => {
  if (!await has('gw/remote/runtime.mjs')) return t.skip('Runtime factory not present');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const { createRuntimeChain } = await import('./fixtures/remote-app/runtime-chain.mjs');
  const chain = await createRuntimeChain({ original, rateBitsPerSecond: 3_000_000 }); t.after(() => chain.close());
  const handle = await chain.invite(); await chain.phone.accept({ remoteSessionId: handle });
  const run = await original.start();
  for (let index = 0; index < 160; index++) {
    const event = { type: 'delta', runId: run.id, sessionId: LOCAL_SESSION, text: 'Synthetic flood ' + index + ': ' + 'x'.repeat(8192) };
    run.log.push(event); original.publish(event);
  }
  const started = Date.now();
  const state = await until(async () => { const snapshot = (await chain.phone.status()).snapshot; return snapshot.pending.length ? snapshot : false; }, 'bounded projection of a >1 MiB source log exposes pending request at 3Mbps', 10000);
  const request = state.pending[0];
  await chain.phone.command({ generation: state.generation, binding: state.binding, type: 'request.respond', commandId: 'flood-approval', payload: { requestId: request.requestId, requestVersion: request.requestVersion, response: { kind: 'permission', decision: 'deny' } } });
  await until(async () => (await chain.phone.status()).snapshot.receipts.some((r) => r.commandId === 'flood-approval' && r.status === 'applied'), 'flood approval true tablet receipt', 10000);
  const snapshot = (await chain.phone.status()).snapshot;
  const stopAt = Date.now();
  await chain.phone.command({ generation: snapshot.generation, binding: snapshot.binding, type: 'run.stop', commandId: 'flood-stop', payload: {} });
  await until(() => !original.RUNS.has(run.id), 'flooded exact original run stops', 10000);
  await until(async () => (await chain.phone.status()).snapshot.receipts.some((r) => r.commandId === 'flood-stop' && r.status === 'applied'), 'flood true stop receipt', 10000);
  const stats = chain.relay.stats(), final = (await chain.phone.status()).snapshot;
  assert.ok(stats.queuedBytes <= 2 * 512 * 1024 && final.cache.bytes <= 512 * 1024);
  t.diagnostic(JSON.stringify({ mode: 'coalesced source log; local JS token buckets; no proven relay backlog or priority benchmark', rateBitsPerSecond: 3_000_000, approvalLatencyMs: stopAt - started, stopLatencyMs: Date.now() - stopAt, queuedBytes: stats.queuedBytes, cacheBytes: final.cache.bytes, rssBytes: process.memoryUsage().rss }));
});

test('integrated real runtime invite → view → original approval → text once → stop → revoke', async (t) => {
  if (!await has('gw/remote/runtime.mjs')) return t.skip('Runtime factory/route integration not yet present; original adapter tests are not remote E2E');
  const original = await createOriginalRunFixture(); t.after(() => original.close());
  const { createRuntimeChain } = await import('./fixtures/remote-app/runtime-chain.mjs');
  const chain = await createRuntimeChain({ original }); t.after(() => chain.close());
  const handle = await chain.invite();
  await assert.rejects(chain.phone.open({ remoteSessionId: handle }), { code: 'GRANT_NOT_ACTIVE' }, 'opening invited session cannot accept it');
  const accepted = await chain.phone.accept({ remoteSessionId: handle });
  assert.equal(accepted.snapshot.canControl, true);
  assert.ok(accepted.snapshot.items.some((record) => record.text?.includes('Synthetic original history')));
  assert.equal(JSON.stringify(accepted).includes(PRIVATE_SENTINEL), false);
  const run = await original.start();
  let state;
  try { state = await until(async () => { const value = await chain.phone.status(); return value.snapshot.pending.length ? value.snapshot : false; }, 'runtime original request snapshot'); }
  catch (error) { t.diagnostic(JSON.stringify({ phone: (await chain.phone.status()).snapshot, hosting: await chain.hosted(), originalEvents: original.events.map((event) => ({ type: event.type, runId: event.runId })), runtime: await chain.diagnostic() })); throw error; }
  const request = state.pending[0];
  // The standalone stale-version negative test remains independent so a
  // security failure there cannot prevent observing the rest of this chain.
  const response = await chain.phone.command({ generation: state.generation, binding: state.binding, type: 'request.respond', commandId: 'runtime-approve-once', payload: { requestId: request.requestId, requestVersion: request.requestVersion, response: { kind: 'permission', decision: 'allow' } } });
  assert.ok(['received', 'applied'].includes(response.receipt.status), 'initial receipt may truthfully be received while adapter completion is in flight');
  await until(async () => (await chain.phone.status()).snapshot.receipts.some((receipt) => receipt.commandId === 'runtime-approve-once' && receipt.status === 'applied'), 'runtime tablet-issued approval applied receipt');
  await until(() => original.childEvents().then((events) => events.some((event) => event.runId === run.id && event.kind === 'control_response')), 'real runtime reaches original child');
  const ready = (await chain.phone.status()).snapshot;
  assert.ok(ready.historyHasMore && ready.historyCursor);
  const historyPage = await chain.phone.history({ generation: ready.generation, binding: ready.binding, cursor: ready.historyCursor });
  assert.ok(historyPage.page.items.length > 0 && historyPage.page.items.length <= 50);
  assert.equal(JSON.stringify(historyPage).includes(PRIVATE_SENTINEL), false);
  await chain.phone.disconnect();
  await until(async () => !(await chain.phone.status()).snapshot.canControl, 'disconnect disables original remote control');
  await assert.rejects(chain.phone.command({ generation: ready.generation, binding: ready.binding, type: 'message.submit', commandId: 'never-queue-offline', payload: { text: 'must not queue offline' } }), (error) => ['OFFLINE', 'RESYNC_REQUIRED'].includes(error.code));
  assert.equal(original.QUEUE.some((item) => item.remoteCommandId === 'never-queue-offline'), false);
  await chain.phone.connect();
  try { await until(async () => (await chain.phone.status()).snapshot.canControl, 'reconnect revalidates current grant/run/pending before controls'); }
  catch (error) { t.diagnostic(JSON.stringify({ recovery: await chain.diagnostic(), phoneSettings: await chain.phone.settings(), hostSettings: await chain.host.settings() })); throw error; }
  const current = (await chain.phone.status()).snapshot;
  const textCommand = { generation: current.generation, binding: current.binding, type: 'message.submit', commandId: 'runtime-text-once', payload: { text: 'Runtime phone original text once' } };
  const sent = await chain.phone.command(textCommand);
  assert.ok(['received', 'unknown'].includes(sent.receipt.status), 'busy queue is not yet delivery');
  await chain.phone.command(textCommand);
  assert.equal(original.QUEUE.filter((item) => item.remoteCommandId === textCommand.commandId).length, 1);
  await original.signal(run.id, { kind: 'finish' });
  await until(() => original.childEvents().then((events) => events.filter((event) => event.kind === 'user' && JSON.stringify(event.message).includes(textCommand.payload.text)).length === 1), 'actual original receives runtime message once');
  await until(async () => (await chain.phone.status()).snapshot.receipts.some((r) => r.commandId === textCommand.commandId && r.status === 'applied'), 'runtime real text delivery receipt');
  const stopping = await until(async () => { const snapshot = (await chain.phone.status()).snapshot; const target = original.runOfSession(LOCAL_SESSION); return target && snapshot.binding?.runId === target.id && snapshot.canControl ? snapshot : false; }, 'current next-run snapshot before targeted stop');
  const stop = await chain.phone.command({ generation: stopping.generation, binding: stopping.binding, type: 'run.stop', commandId: 'runtime-stop', payload: {} });
  assert.ok(['received', 'applied'].includes(stop.receipt.status));
  await until(() => !original.runOfSession(LOCAL_SESSION), 'runtime stops exact original child');
  await until(async () => (await chain.phone.status()).snapshot.receipts.some((r) => r.commandId === 'runtime-stop' && r.status === 'applied'), 'runtime end-to-end stopped receipt');
  const next = await original.start();
  await chain.revoke();
  await until(async () => (await chain.phone.status()).snapshot.phase === 'revoked', 'runtime clears revoked phone view');
  assert.equal(original.RUNS.has(next.id), true);
  assert.equal((await chain.phone.status()).snapshot.items.length, 0);
  await assert.rejects(chain.phone.open({ remoteSessionId: handle }));
  t.diagnostic(JSON.stringify(chain.evidence()));
});

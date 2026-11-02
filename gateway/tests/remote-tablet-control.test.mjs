import { CFG, PATHS } from '../gw/config.mjs'; // Refuse direct test invocation with a real HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTabletControl } from '../gw/remote/tablet-control.mjs';
import { createFrame, validateFrame, ERROR_CODES as C } from '../gw/remote/protocol.mjs';

const ROOT = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, 'remote-control-'));
const fixtures = [];
after(() => { for (const f of fixtures) f.control.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });
const code = (wanted) => (error) => error.code === wanted;
let serial = 0;
function fixture({ capabilities, maxRecords, receiptTimeoutMs = 1000, requestTtlMs = 60_000 } = {}) {
  const clock = { at: 1_700_000_000_000 };
  const directory = path.join(ROOT, String(++serial)); fs.mkdirSync(directory);
  const grant = { remoteSessionId: 'opaque-remote', localSessionId: 'local-session', hostDeviceId: 'tablet', phoneDeviceId: 'phone',
    hostInstanceId: 'host-instance', grantVersion: 1, state: 'active', expiresAt: clock.at + 1_000_000, runId: 'original-run' };
  const run = { id: 'original-run', sessionId: grant.localSessionId, ended: false, aborted: false, child: null, permMode: 'default', perms: new Map() };
  const runs = new Map([[run.id, run]]), calls = [], listeners = new Set();
  const executor = {
    capabilities: capabilities ?? { literalText: true, remoteOnce: true, planDefault: true, messageReplay: true },
    getRun: (id) => runs.get(id), getRunOfSession: (sid) => [...runs.values()].find((r) => r.sessionId === sid && !r.ended) || null,
    submitText(value) { calls.push({ op: 'message', value }); return { id: 'queued-item', sessionId: value.sessionId, message: value.text,
      literalText: true, remoteCommandId: value.commandId, sourceDeviceId: value.sourceDeviceId }; },
    answerPerm(r, id, answer, options) {
      if (!r.perms.has(id) || r.ended || r.aborted) return false;
      calls.push({ op: 'answer', id, answer, options }); r.perms.delete(id); return true;
    },
    abortRun(r) { calls.push({ op: 'stop', run: r.id }); r.aborted = true; return true; },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const f = { grant, run, runs, calls, executor, clock, ledgerPath: path.join(directory, 'commands.json'),
    emit(event) { for (const fn of listeners) fn(event); },
    command(type = 'message.submit', payload = { text: 'ordinary message' }, commandId = 'stable-command', patch = {}) {
      return createFrame(type, { fromDeviceId: 'phone', toDeviceId: 'tablet', hostInstanceId: 'host-instance',
        remoteSessionId: 'opaque-remote', grantVersion: 1, runId: 'original-run', ...patch }, payload, { now: clock.at, commandId });
    },
    request(tool = 'Bash', input = { command: 'printf fixture-only' }, id = 'permission-request') {
      const p = { id, tool, input, toolUseId: 'tool-use', suggestions: [], reason: null, blockedPath: null,
        description: 'Fixture operation', interactive: false, agentId: null, at: clock.at,
        runId: run.id, sessionId: run.sessionId };
      run.perms.set(id, p); return p;
    },
    respond(response = { kind: 'permission', decision: 'allow' }, commandId = 'stable-response', descriptor) {
      const request = descriptor || f.control.describeRequests(grant.localSessionId)[0];
      return f.command('request.respond', { requestId: request.requestId, requestVersion: request.requestVersion, response }, commandId);
    },
  };
  f.make = () => createTabletControl({ deviceId: 'tablet', hostInstanceId: 'host-instance', ledgerPath: f.ledgerPath,
    readGrant: (id) => id === grant.remoteSessionId ? grant : null, executor, now: () => clock.at,
    ...(maxRecords ? { maxRecords } : {}), receiptTimeoutMs, requestTtlMs });
  f.control = f.make(); fixtures.push(f); return f;
}
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };
const query = (f, commandId = 'stable-command', patch = {}) => f.control.query(f.command('control.query', {}, commandId, patch), 'phone');

test('durable received precedes dispatch; initial run_start is not delivery; exact replay applies once', async () => {
  const f = fixture(), receipts = [];
  f.control.onReceipt((r) => receipts.push(r));
  const original = f.executor.submitText;
  f.executor.submitText = (value) => {
    const disk = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'));
    assert.equal(disk.entries[0].receipt.status, 'received');
    assert.equal(JSON.stringify(disk).includes('ordinary message'), false);
    assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, 0o600);
    return original(value);
  };
  const frame = f.command();
  assert.equal((await f.control.submit(frame, 'phone')).payload.status, 'received');
  assert.deepEqual(f.calls[0].value, { sessionId: 'local-session', text: 'ordinary message', commandId: 'stable-command', literalText: true, sourceDeviceId: 'phone' });
  await f.control.observe({ type: 'run_start', sessionId: f.run.sessionId, runId: f.run.id, itemId: 'queued-item' });
  assert.equal((await query(f)).payload.status, 'received');
  for (const event of [
    { sessionId: 'other-local' }, { itemId: 'another-item' }, { runId: 'different-run' }, { remoteCommandId: 'other-command' }, { sourceDeviceId: 'different-phone' },
  ]) {
    await f.control.observe({ type: 'message_delivered', sessionId: f.run.sessionId, runId: 'queued-item', itemId: 'queued-item',
      remoteCommandId: 'stable-command', sourceDeviceId: 'phone', ...event });
    assert.equal((await query(f)).payload.status, 'received');
  }
  await f.control.observe({ type: 'message_delivered', sessionId: f.run.sessionId, runId: 'queued-item', itemId: 'queued-item', remoteCommandId: 'stable-command', sourceDeviceId: 'phone' });
  assert.deepEqual((await query(f)).payload, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } });
  f.run.ended = true; f.runs.delete(f.run.id);
  const retried = f.command();
  assert.equal((await f.control.submit(retried, 'phone')).payload.status, 'applied');
  assert.equal(f.calls.length, 1);
  assert.equal((await query(f)).payload.status, 'applied', 'query keeps original run after completion');
  await settle();
  assert.deepEqual(receipts.map((r) => r.payload.status), ['received', 'applied']);
  for (const receipt of receipts) assert.equal(validateFrame(receipt, { now: f.clock.at }).type, 'control.receipt');
});

test('commandId cannot change text, type, grant, device, target or original run', async () => {
  const f = fixture(); await f.control.submit(f.command(), 'phone');
  await assert.rejects(f.control.submit(f.command('message.submit', { text: 'changed' }), 'phone'), code(C.COMMAND_CONFLICT));
  await assert.rejects(f.control.submit(f.command('run.stop', {}), 'phone'), code(C.COMMAND_CONFLICT));
  for (const [patch, expected] of [
    [{ fromDeviceId: 'intruder' }, C.DEVICE_MISMATCH], [{ toDeviceId: 'wrong-tablet' }, C.DEVICE_MISMATCH],
    [{ remoteSessionId: 'not-hosted' }, C.GRANT_REVOKED], [{ hostInstanceId: 'old-process' }, C.HOST_INSTANCE_MISMATCH],
    [{ grantVersion: 2 }, C.GRANT_MISMATCH], [{ runId: 'replacement-run' }, C.RUN_MISMATCH],
  ]) await assert.rejects(f.control.submit(f.command('message.submit', { text: 'ordinary message' }, 'stable-command', patch), patch.fromDeviceId || 'phone'), code(expected));
  await assert.rejects(f.control.submit(f.command('message.submit', { text: 'ordinary message' }, 'new-command'), 'not-the-authenticated-phone'), code(C.DEVICE_MISMATCH));
  assert.equal(f.calls.length, 1);
});

test('current live run, grant expiry and frame expiry are rechecked, not trusted from phone', async () => {
  const f = fixture();
  await assert.rejects(f.control.submit(f.command('message.submit', { text: 'x' }, 'a', { runId: null }), 'phone'), code(C.RUN_MISMATCH));
  f.grant.state = 'invited';
  await assert.rejects(f.control.submit(f.command(), 'phone'), code(C.GRANT_NOT_ACTIVE));
  f.grant.state = 'active'; f.grant.expiresAt = f.clock.at;
  await assert.rejects(f.control.submit(f.command(), 'phone'), code(C.EXPIRED));
  f.grant.expiresAt += 100_000;
  const old = f.command(); f.clock.at = old.expiresAt;
  await assert.rejects(f.control.submit(old, 'phone'), code(C.EXPIRED));
  assert.equal(f.calls.length, 0);
});

test('slash is submitted unchanged as ordinary literal text and unavailable source hooks fail closed', async () => {
  const f = fixture();
  await f.control.submit(f.command('message.submit', { text: '/model bypassPermissions' }), 'phone');
  assert.equal(f.calls[0].value.text, '/model bypassPermissions'); assert.equal(f.calls[0].value.literalText, true);
  const unavailable = fixture({ capabilities: {} });
  await assert.rejects(unavailable.control.submit(unavailable.command(), 'phone'), code(C.FORBIDDEN));
  assert.equal(unavailable.calls.length, 0);
  await assert.rejects(f.control.submit({ ...f.command(), payload: { text: 'x', permissionMode: 'bypassPermissions' } }, 'phone'), code(C.UNKNOWN_FIELD));
});

test('original permission Map identity, full input digest and requestVersion are mandatory', async () => {
  const f = fixture(), p = f.request();
  const d = f.control.describeRequests(f.grant.localSessionId)[0];
  assert.equal(d.kind, 'permission'); assert.equal(d.detailsComplete, true); assert.match(d.detailText, /printf fixture-only/);
  const frame = f.respond(undefined, 'approval', d);
  p.input.command = 'different command';
  await assert.rejects(f.control.submit(frame, 'phone'), code(C.REQUEST_MISMATCH));
  const updated = f.control.describeRequests(f.grant.localSessionId)[0];
  assert.ok(updated.requestVersion > d.requestVersion);
  await assert.rejects(f.control.submit(frame, 'phone'), code(C.REQUEST_MISMATCH));
  const replaced = { ...p, input: { ...p.input } }; f.run.perms.set(p.id, replaced);
  await assert.rejects(f.control.submit(f.respond(undefined, 'replacement', updated), 'phone'), code(C.REQUEST_MISMATCH));
  assert.equal(f.calls.length, 0);
});

test('one original permission resolves once in competing remote/local and remote/remote answers', async () => {
  const f = fixture(), p = f.request();
  const descriptor = f.control.describeRequests(f.grant.localSessionId)[0];
  const [a, b] = await Promise.allSettled([
    f.control.submit(f.respond(undefined, 'approve-one', descriptor), 'phone'),
    f.control.submit(f.respond(undefined, 'approve-two', descriptor), 'phone'),
  ]);
  assert.equal(a.value.payload.status, 'applied'); assert.equal(b.reason.code, C.REQUEST_CLOSED);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].answer, { behavior: 'allow' });
  assert.deepEqual(f.calls[0].options, { remoteOnce: true, planDefault: false });
  const local = fixture(); local.request(); const d = local.control.describeRequests(local.grant.localSessionId)[0];
  local.executor.answerPerm(local.run, d.requestId, { behavior: 'deny' }, {});
  await assert.rejects(local.control.submit(local.respond(undefined, 'remote-after-local', d), 'phone'), code(C.REQUEST_CLOSED));
  assert.equal(local.calls.length, 1);
  assert.equal(p.input.command, 'printf fixture-only');
});

test('revoke shares serialization and immediately bars not-yet-dispatched controls without stopping original run', async () => {
  const f = fixture(); f.request(); const frame = f.respond();
  let release; const held = new Promise((r) => { release = r; });
  const lock = f.control.serialize(f.grant.remoteSessionId, () => held);
  const submitting = f.control.submit(frame, 'phone');
  const revoked = f.control.revoke(f.grant.remoteSessionId, () => { f.grant.state = 'revoked'; });
  release(); await lock;
  await assert.rejects(submitting, code(C.GRANT_REVOKED)); await revoked;
  assert.equal(f.calls.length, 0); assert.equal(f.run.ended, false); assert.equal(f.run.aborted, false);
});

test('successful revokes reclaim dispatch barriers without clearing command deduplication', async () => {
  const f = fixture();
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'received');
  f.clock.at += 1000;
  assert.equal((await query(f)).payload.status, 'unknown');
  await f.control.revoke(f.grant.remoteSessionId, () => { f.grant.state = 'revoked'; });
  assert.equal(f.control.blocked.size, 0);
  await assert.rejects(f.control.submit(f.command(), 'phone'), code(C.GRANT_REVOKED));
  // A new lease cannot reuse a command ID from a collected old lease.
  f.grant.remoteSessionId = 'replacement-grant'; f.grant.state = 'active';
  await assert.rejects(f.control.submit(f.command('message.submit', { text: 'ordinary message' }, 'stable-command', { remoteSessionId: f.grant.remoteSessionId }), 'phone'), code(C.COMMAND_CONFLICT));
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 100; i++) {
    f.grant.remoteSessionId = 'retired-grant-' + i; f.grant.state = 'active';
    await f.control.revoke(f.grant.remoteSessionId, () => { f.grant.state = 'revoked'; });
  }
  assert.equal(f.control.blocked.size, 0);
  await assert.rejects(f.control.revoke('failed-retire', () => { throw new Error('synthetic save failure'); }));
  assert.equal(f.control.blocked.has('failed-retire'), true, 'failed mutation keeps its immediate barrier');
});

test('cancellation, request TTL, old run and duplicate ID generation cannot approve', async () => {
  const f = fixture({ requestTtlMs: 10 }); f.request(); const d = f.control.describeRequests(f.grant.localSessionId)[0];
  f.clock.at += 10;
  await assert.rejects(f.control.submit(f.respond(undefined, 'expired', d), 'phone'), code(C.REQUEST_EXPIRED));
  f.clock.at -= 10; f.run.perms.clear();
  await assert.rejects(f.control.submit(f.respond(undefined, 'cancelled', d), 'phone'), code(C.REQUEST_CLOSED));
  f.request(); const current = f.control.describeRequests(f.grant.localSessionId)[0]; f.run.aborted = true;
  await assert.rejects(f.control.submit(f.respond(undefined, 'old-run', current), 'phone'), code(C.RUN_MISMATCH));
  assert.equal(f.calls.length, 0);
});

test('AskUserQuestion maps only original questions/options to exact App answers including free text', async () => {
  const f = fixture();
  f.request('AskUserQuestion', { questions: [
    { question: 'Which fixture?', header: 'Choice', multiSelect: false, options: [{ label: 'One', description: 'First' }, { label: 'Two' }] },
    { question: 'Any note?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ] });
  const descriptor = f.control.describeRequests(f.grant.localSessionId)[0];
  assert.equal(descriptor.kind, 'question'); assert.equal(descriptor.questions[0].options[0].optionId, 'q0:o0');
  const response = { kind: 'question', answers: [{ questionId: 'q0', optionIds: ['q0:o1'] }, { questionId: 'q1', optionIds: [], text: 'a free answer' }] };
  const receipt = await f.control.submit(f.respond(response, 'question', descriptor), 'phone');
  assert.equal(receipt.payload.status, 'applied');
  assert.deepEqual(f.calls[0].answer, { behavior: 'allow', answers: { 'Which fixture?': 'Two', 'Any note?': 'a free answer' } });
});

test('question forged options, cross-question options, missing answers and single-choice multiselect are rejected', async () => {
  const f = fixture(); f.request('AskUserQuestion', { questions: [
    { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Second?', multiSelect: false, options: [{ label: 'X' }] },
  ] });
  const d = f.control.describeRequests(f.grant.localSessionId)[0];
  const cases = [
    [{ questionId: 'q0', optionIds: ['q0:o99'] }, { questionId: 'q1', optionIds: ['q1:o0'] }],
    [{ questionId: 'q0', optionIds: ['q1:o0'] }, { questionId: 'q1', optionIds: ['q1:o0'] }],
    [{ questionId: 'q0', optionIds: ['q0:o0'] }],
    [{ questionId: 'q0', optionIds: ['q0:o0', 'q0:o1'] }, { questionId: 'q1', optionIds: ['q1:o0'] }],
    [{ questionId: 'q0', optionIds: ['q0:o0'], text: 'conflicting' }, { questionId: 'q1', optionIds: ['q1:o0'] }],
  ];
  for (let i = 0; i < cases.length; i++) await assert.rejects(f.control.submit(f.respond({ kind: 'question', answers: cases[i] }, `bad-question-${i}`, d), 'phone'), code(C.REQUEST_MISMATCH));
  assert.equal(f.calls.length, 0);
});

test('plan approval is original-only and requires run-local default-mode capability; no permanent fields', async () => {
  const f = fixture(); f.request('ExitPlanMode', { plan: '1. Change fixture\n2. Verify fixture', allowedPrompts: [{ tool: 'Bash', prompt: 'fixture-only' }] });
  const d = f.control.describeRequests(f.grant.localSessionId)[0]; assert.match(d.detailText, /allowedPrompts/);
  const frame = f.respond({ kind: 'plan', decision: 'approve' }, 'plan', d);
  assert.equal((await f.control.submit(frame, 'phone')).payload.status, 'applied');
  assert.deepEqual(f.calls[0].answer, { behavior: 'allow' }); assert.deepEqual(f.calls[0].options, { remoteOnce: true, planDefault: true });
  const blocked = fixture({ capabilities: { literalText: true, messageReplay: true } }); blocked.request('ExitPlanMode', { plan: 'fixture' });
  await assert.rejects(blocked.control.submit(blocked.respond({ kind: 'plan', decision: 'approve' }), 'phone'), code(C.FORBIDDEN));
  for (const forbidden of ['always', 'mode', 'updatedInput', 'updatedPermissions', 'interrupt']) {
    await assert.rejects(f.control.submit({ ...frame, payload: { ...frame.payload, response: { ...frame.payload.response, [forbidden]: true } } }, 'phone'), code(C.UNKNOWN_FIELD));
  }
});

test('plan mode changes and already-permissive or unknown SDK modes require local handling', async () => {
  for (const mode of ['acceptEdits', 'bypassPermissions', 'auto', 'dontAsk', undefined]) {
    const f = fixture(); f.run.permMode = mode; f.request('ExitPlanMode', { plan: 'fixture plan' });
    const descriptor = f.control.describeRequests(f.grant.localSessionId)[0];
    assert.equal(descriptor.kind, 'local');
    await assert.rejects(f.control.submit(f.respond({ kind: 'plan', decision: 'approve' }, `unsafe-${mode}`, descriptor), 'phone'), code(C.FORBIDDEN));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.request('ExitPlanMode', { plan: 'fixture plan' });
  const old = f.control.describeRequests(f.grant.localSessionId)[0]; f.run.permMode = 'bypassPermissions';
  await assert.rejects(f.control.submit(f.respond({ kind: 'plan', decision: 'approve' }, 'changed-mode', old), 'phone'), code(C.FORBIDDEN));
  const current = f.control.describeRequests(f.grant.localSessionId)[0]; assert.ok(current.requestVersion > old.requestVersion);
  assert.equal(current.kind, 'local');
});

test('partial oversized details and security-rule modification guards are local-only and never remotely approved', async () => {
  const f = fixture(), p = f.request('Write', { file_path: '/fixture/only', content: 'x'.repeat(30_000) });
  const d = f.control.describeRequests(f.grant.localSessionId)[0];
  assert.equal(d.kind, 'local'); assert.equal(d.detailsComplete, false); assert.ok(Buffer.byteLength(JSON.stringify(d)) < 24 * 1024);
  await assert.rejects(f.control.submit(f.respond(undefined, 'incomplete-allow', d), 'phone'), code(C.FORBIDDEN));
  await assert.rejects(f.control.submit(f.respond({ kind: 'permission', decision: 'deny', reason: 'Need local review' }, 'incomplete-deny', d), 'phone'), code(C.FORBIDDEN));
  assert.equal(f.calls.length, 0); assert.equal(p.input.content.length, 30_000);
  const guarded = fixture(); const guard = guarded.request(); guard.guard = { cat: 'prompt:rule', what: 'fixture safety rule' };
  const gd = guarded.control.describeRequests(guarded.grant.localSessionId)[0];
  assert.equal(gd.kind, 'local'); await assert.rejects(guarded.control.submit(guarded.respond(undefined, 'guarded', gd), 'phone'), code(C.FORBIDDEN));
  const category = fixture({ capabilities: { literalText: true, messageReplay: true } }); category.request().guard = { cat: 'device:clipboard' };
  await assert.rejects(category.control.submit(category.respond(), 'phone'), code(C.FORBIDDEN));
});

test('aggregate detail budget disables the original approval gate and versions recovery', async () => {
  const f = fixture(), sid = f.grant.localSessionId;
  f.request('Write', { file_path: '/fixture/one', content: 'x'.repeat(18_000) }, 'budget-one');
  const full = f.control.describeRequests(sid, { maxBytes: 48_000 })[0];
  assert.equal(full.kind, 'permission'); assert.equal(full.detailsComplete, true);
  for (const id of ['budget-two', 'budget-three']) f.request('Write', { file_path: '/fixture/' + id, content: 'y'.repeat(18_000) }, id);
  const local = f.control.describeRequests(sid, { maxBytes: 48_000 });
  assert.equal(local.length, 3); assert.ok(Buffer.byteLength(JSON.stringify(local)) <= 48_000);
  assert.ok(local.every((r) => r.kind === 'local' && r.detailsComplete === false));
  assert.ok(local[0].requestVersion > full.requestVersion);
  assert.deepEqual(f.control.describeRequests(sid, { maxBytes: 48_000 }), local, 'unchanged budget downgrade keeps stable versions');
  assert.deepEqual(f.control.describeRequests(sid), local, 'notice/default reads must not re-enable unseen full details');
  await assert.rejects(f.control.submit(f.respond(undefined, 'old-full-budget', full), 'phone'), code(C.REQUEST_MISMATCH));
  for (const descriptor of local) {
    await assert.rejects(f.control.submit(f.respond(undefined, 'budget-allow-' + descriptor.requestId, descriptor), 'phone'), code(C.FORBIDDEN));
  }
  assert.equal(f.calls.length, 0);
  f.run.perms.delete('budget-two'); f.run.perms.delete('budget-three');
  const recovered = f.control.describeRequests(sid, { maxBytes: 48_000 })[0];
  assert.equal(recovered.kind, 'permission'); assert.equal(recovered.detailsComplete, true);
  assert.ok(recovered.requestVersion > local[0].requestVersion);
  assert.deepEqual(f.control.describeRequests(sid)[0], recovered);
  await assert.rejects(f.control.submit(f.respond(undefined, 'stale-budget-local', local[0]), 'phone'), code(C.REQUEST_MISMATCH));
  assert.equal((await f.control.submit(f.respond(undefined, 'budget-recovered', recovered), 'phone')).payload.status, 'applied');
  assert.equal(f.calls.length, 1);
});

test('pending byte/count limits also disable omitted originals and reject invalid budgets', async () => {
  const f = fixture(), sid = f.grant.localSessionId;
  f.request('Write', { content: '字'.repeat(1000) }, 'utf8-budget');
  const full = f.control.describeRequests(sid)[0];
  const local = f.control.describeRequests(sid, { maxBytes: 2048 });
  assert.equal(local[0].kind, 'local'); assert.ok(Buffer.byteLength(JSON.stringify(local)) <= 2048);
  assert.deepEqual(f.control.describeRequests(sid, { maxBytes: 2 }), []);
  await assert.rejects(f.control.submit(f.respond(undefined, 'omitted-byte-budget', full), 'phone'), code(C.REQUEST_MISMATCH));
  for (const maxBytes of [0, 1, -1, 48_001, NaN, Infinity, '48000']) assert.throws(() => f.control.describeRequests(sid, { maxBytes }), TypeError);
  const many = fixture(), manySid = many.grant.localSessionId;
  for (let i = 0; i < 32; i++) many.request('Bash', { command: 'printf fixture-only' }, 'count-' + i);
  const previous = many.control.describeRequests(manySid);
  assert.equal(previous.length, 32); assert.ok(previous.every((r) => r.detailsComplete));
  const hidden = previous[0], original = many.run.perms.get(hidden.requestId);
  many.request('Bash', { command: 'printf fixture-only' }, 'count-32');
  many.run.perms.delete(hidden.requestId); many.run.perms.set(hidden.requestId, original);
  const bounded = many.control.describeRequests(manySid);
  assert.equal(bounded.length, 32); assert.ok(bounded.every((r) => r.kind === 'local'));
  assert.equal(bounded.some((r) => r.requestId === hidden.requestId), false);
  await assert.rejects(many.control.submit(many.respond(undefined, 'omitted-count-budget', hidden), 'phone'), code(C.REQUEST_MISMATCH));
  assert.equal(f.calls.length, 0); assert.equal(many.calls.length, 0);
});

test('stop needs original child close and ended state; forced run_end and idle are not stopped', async () => {
  const f = fixture(); f.run.child = new EventEmitter();
  assert.equal((await f.control.submit(f.command('run.stop', {}, 'stop'), 'phone')).payload.status, 'received');
  assert.equal(f.run.aborted, true);
  f.run.ended = true; f.runs.delete(f.run.id);
  await f.control.observe({ type: 'run_end', runId: f.run.id, sessionId: f.run.sessionId, aborted: true });
  assert.equal((await query(f, 'stop')).payload.status, 'received');
  f.run.child.emit('close', null, 'SIGKILL'); await settle();
  assert.deepEqual((await query(f, 'stop')).payload, { status: 'applied', result: { kind: 'stop', runState: 'stopped' } });
  assert.equal(f.calls.filter((c) => c.op === 'stop').length, 1);
  assert.equal((await f.control.submit(f.command('run.stop', {}, 'stop'), 'phone')).payload.status, 'applied');
});

test('stop timeout unknown never re-kills and can be reconciled by original late close', async () => {
  const f = fixture({ receiptTimeoutMs: 10 }); f.run.child = new EventEmitter();
  await f.control.submit(f.command('run.stop', {}, 'stop-unknown'), 'phone');
  f.clock.at += 10;
  assert.equal((await query(f, 'stop-unknown')).payload.status, 'unknown');
  await f.control.submit(f.command('run.stop', {}, 'stop-unknown'), 'phone'); assert.equal(f.calls.length, 1);
  f.run.ended = true; f.runs.delete(f.run.id); f.run.child.emit('close'); await settle();
  assert.equal((await query(f, 'stop-unknown')).payload.status, 'applied');
});

test('crash-window received reloads unknown, no payload is persisted and no dispatch replays', async () => {
  const f = fixture(); await f.control.submit(f.command(), 'phone'); f.control.close();
  f.control = f.make();
  assert.equal((await query(f)).payload.status, 'unknown');
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'unknown');
  assert.equal(f.calls.length, 1);
  const content = fs.readFileSync(f.ledgerPath, 'utf8');
  assert.equal(content.includes('ordinary message'), false); assert.match(content, /unknown/);
});

test('bounded journal retains tombstones and corrupt storage fails closed', async () => {
  const f = fixture({ maxRecords: 1 }); await f.control.submit(f.command(), 'phone');
  await assert.rejects(f.control.submit(f.command('message.submit', { text: 'second' }, 'second'), 'phone'), code(C.LEDGER_FULL));
  assert.equal(f.calls.length, 1);
  f.control.close(); fs.writeFileSync(f.ledgerPath, '{not-json');
  assert.throws(() => f.make(), code(C.INTERNAL_ERROR));
});

test('wrong original queue item metadata cannot produce an applied remote message receipt', async () => {
  const f = fixture(); f.executor.submitText = () => ({ id: 'wrong-item', sessionId: 'other-session', message: 'wrong-text', literalText: false });
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'unknown');
  await f.control.observe({ type: 'message_delivered', sessionId: f.run.sessionId, runId: 'wrong-item', itemId: 'wrong-item', remoteCommandId: 'stable-command', sourceDeviceId: 'phone' });
  assert.equal((await query(f)).payload.status, 'unknown');
});

test('original run end without the expected replay becomes unknown, never an accepted message', async () => {
  const f = fixture(); await f.control.submit(f.command(), 'phone');
  await f.control.observe({ type: 'run_end', runId: 'unrelated-run', sessionId: f.run.sessionId });
  assert.equal((await query(f)).payload.status, 'received');
  await f.control.observe({ type: 'run_end', runId: 'queued-item', sessionId: f.run.sessionId });
  assert.equal((await query(f)).payload.status, 'unknown');
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('journal fsync failure refuses dispatch and poisons future use instead of reporting durable received', async () => {
  const f = fixture(); const fsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('fixture durability failure'); };
  try { await assert.rejects(f.control.submit(f.command(), 'phone'), code(C.INTERNAL_ERROR)); }
  finally { fs.fsyncSync = fsync; }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.control.submit(f.command(), 'phone'), code(C.INTERNAL_ERROR));
  await assert.rejects(query(f), code(C.INTERNAL_ERROR));
});

test('executor throw after dispatch is unknown; negative no-dispatch result is rejected', async () => {
  const f = fixture(); f.executor.submitText = () => { f.calls.push({ op: 'message-write' }); throw new Error('possibly already wrote to stdin'); };
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'unknown');
  assert.equal((await f.control.submit(f.command(), 'phone')).payload.status, 'unknown'); assert.equal(f.calls.length, 1);
  const rejected = fixture(); rejected.executor.submitText = () => false;
  assert.deepEqual((await rejected.control.submit(rejected.command(), 'phone')).payload, { status: 'rejected', code: C.OFFLINE });
});

test('receipt listeners cannot reenter validation/dispatch to win a second local permission answer', async () => {
  const f = fixture(), p = f.request();
  f.control.onReceipt((receipt) => { if (receipt.payload.status === 'received') f.executor.answerPerm(f.run, p.id, { behavior: 'deny' }, {}); });
  assert.equal((await f.control.submit(f.respond(), 'phone')).payload.status, 'applied');
  await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].answer.behavior, 'allow');
});

test('real App queue/startRun/answerPerm/replay/abort contract with a disposable stream-json CLI, no model or service', { timeout: 15_000 }, async () => {
  const root = path.join(ROOT, 'app-contract'); fs.mkdirSync(root);
  const loader = path.join(root, 'fake-loader.sh');
  const cli = fileURLToPath(new URL('./fixtures/remote-control-cli.mjs', import.meta.url));
  const sh = fs.existsSync('/system/bin/sh') ? '/system/bin/sh' : '/bin/sh';
  fs.writeFileSync(loader, `#!${sh}\nwhile [ "$1" != ${JSON.stringify(cli)} ]; do\n  [ "$#" -gt 0 ] || exit 96\n  shift\ndone\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
  const providerFile = path.join(CFG.home, 'ccapp-providers.json');
  fs.writeFileSync(providerFile, JSON.stringify({ active: 'custom-remote-fixture', providers: {
    'custom-remote-fixture': { label: 'Disposable remote control fixture', baseUrl: 'https://remote-control.invalid/anthropic',
      apiKey: 'fixture-only-not-a-real-key', authStyle: 'bearer', defaultModel: 'fixture-model',
      modelsUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 200_000 }] })),
      fallbackModels: [{ id: 'fixture-model', context_window: 200_000 }] },
  } }));
  // Set these before importing any original run/queue module. The config import
  // above is pure, and the runner has already replaced every CCAPP_* value.
  process.env.CCAPP_PRIV_SOCK = path.join(root, 'nonexistent-fixture.sock');
  process.env.CCAPP_ENOSYS_RUN = path.join(root, 'no-supervisor');
  process.env.REMOTE_CONTROL_FIXTURE = root;
  process.env.ANTHROPIC_API_KEY = 'fixture-only'; process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-only';
  const previousPaths = { claude: PATHS.claude, loader: PATHS.loader }, originalFetch = globalThis.fetch;
  PATHS.claude = cli; PATHS.loader = loader;
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error('No network or model calls allowed in remote control fixture'); };
  const { SETTINGS } = await import('../gw/settings-store.mjs');
  const oldSettings = { titleModel: SETTINGS.titleModel, idleCompaction: SETTINGS.idleCompaction, staticCompat: SETTINGS.staticCompat, permissionMode: SETTINGS.permissionMode };
  SETTINGS.titleModel = 'off'; SETTINGS.idleCompaction = false; SETTINGS.staticCompat = false; SETTINGS.permissionMode = 'default';
  const { enqueueRemoteText, abortRun, QUEUE, routeQueue } = await import('../gw/queue.mjs');
  const { RUNS, runOfSession } = await import('../gw/runs.mjs');
  const { onPublish } = await import('../gw/bus.mjs');
  const { SUBAGENT_HINT } = await import('../gw/agents.mjs');
  const { integrityHint } = await import('../gw/integrity.mjs');
  const grant = { remoteSessionId: 'app-opaque', localSessionId: 'app-fixture-session', hostDeviceId: 'app-tablet', phoneDeviceId: 'app-phone',
    hostInstanceId: 'app-host', grantVersion: 1, state: 'active', expiresAt: Date.now() + 120_000, runId: null };
  const executor = { capabilities: { literalText: true, remoteOnce: true, planDefault: true, messageReplay: true },
    getRun: (id) => RUNS.get(id), getRunOfSession: runOfSession, submitText: enqueueRemoteText,
    answerPerm: (r, id, answer, options) => r.answerPerm(id, answer, options), abortRun, onEvent: onPublish };
  const control = createTabletControl({ deviceId: 'app-tablet', hostInstanceId: 'app-host', ledgerPath: path.join(root, 'ledger.json'),
    readGrant: (id) => id === grant.remoteSessionId ? grant : null, executor, receiptTimeoutMs: 3000 });
  const events = [], off = onPublish((ev) => events.push(ev));
  const command = (type, payload, commandId, runId) => createFrame(type, { fromDeviceId: grant.phoneDeviceId,
    toDeviceId: grant.hostDeviceId, hostInstanceId: grant.hostInstanceId, remoteSessionId: grant.remoteSessionId,
    grantVersion: grant.grantVersion, runId }, payload, { commandId });
  async function until(check, description) {
    const limit = Date.now() + 4000;
    while (!check()) { assert.ok(Date.now() < limit, description); await new Promise((r) => setTimeout(r, 5)); }
  }
  const ledger = (id) => JSON.parse(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8')).entries.find((e) => e.commandId === id);
  const requestFrame = (descriptor, response, id) => command('request.respond', { requestId: descriptor.requestId, requestVersion: descriptor.requestVersion, response }, id, descriptor.runId);
  async function queueAction(action, body) {
    const req = new EventEmitter(); req.method = 'POST';
    const res = { writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data.toString()); } };
    const pending = routeQueue(req, res, null, '/api/queue/' + action);
    req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
    await pending; return res;
  }
  let run;
  try {
    assert.equal((await control.submit(command('message.submit', { text: '/model should-be-ordinary-text' }, 'app-message', null), 'app-phone')).payload.status, 'received');
    await until(() => events.some((e) => e.type === 'message_delivered' && e.remoteCommandId === 'app-message'), 'original user replay must be received');
    run = runOfSession(grant.localSessionId); assert.ok(run?.child && run.perms instanceof Map);
    await until(() => run.perms.has('fixture-bash'), 'original can_use_tool Bash request must be pending');
    await until(() => ledger('app-message').receipt.status === 'applied', 'control must reconcile original user replay');
    const marker = path.join(root, `${run.id}.jsonl`);
    const messages = () => fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const initial = messages().find((m) => m.type === 'user');
    const firstText = typeof initial.message.content === 'string' ? initial.message.content : initial.message.content[0].text;
    assert.match(firstText, /\/model should-be-ordinary-text/); assert.equal(firstText.trim().startsWith('/'), false, 'slash cannot reach SDK command parser');
    assert.equal(events.some((e) => e.type === 'run_end' && e.localCommand), false);
    const bootArgs = messages()[0].argv;
    const subagentAt = bootArgs.indexOf('--append-subagent-system-prompt');
    assert.ok(subagentAt >= 0, 'phone slash text must retain the normal subagent instructions');
    assert.equal(bootArgs[subagentAt + 1], SUBAGENT_HINT + '\n\n' + integrityHint());
    // A received remote queue item cannot change text or move to a different
    // run through local queue actions while retaining its command identity.
    await control.submit(command('message.submit', { text: 'immutable remote queued text' }, 'app-queued-text', run.id), 'app-phone');
    const queued = QUEUE.find((it) => it.remoteCommandId === 'app-queued-text'); assert.ok(queued);
    const queuedBefore = { ...queued }, orderBefore = QUEUE.map((it) => it.id), writesBefore = messages().filter((m) => m.type === 'user').length;
    for (const [action, extra] of [['edit', { text: 'locally changed text' }], ['edit', { text: '' }], ['promote', {}]]) {
      const res = await queueAction(action, { id: queued.id, ...extra });
      assert.equal(res.status, 409); assert.equal(res.body.error, 'remote_command_immutable');
      assert.ok(res.body.message); assert.deepEqual(queued, queuedBefore); assert.deepEqual(QUEUE.map((it) => it.id), orderBefore);
      assert.equal(messages().filter((m) => m.type === 'user').length, writesBefore);
    }
    assert.equal(ledger('app-queued-text').receipt.status, 'received');
    assert.equal((await queueAction('remove', { id: queued.id })).status, 200, 'explicit local cancellation remains available');
    assert.equal(QUEUE.includes(queued), false);
    // Local-only queue edits keep their original behavior.
    const localQueued = { ...queuedBefore, id: 'local-queue-fixture', message: 'local before' };
    delete localQueued.remoteCommandId; delete localQueued.sourceDeviceId; delete localQueued.literalText;
    QUEUE.push(localQueued);
    assert.equal((await queueAction('edit', { id: localQueued.id, text: 'local after' })).status, 200);
    assert.equal(localQueued.message, 'local after');
    assert.equal((await queueAction('remove', { id: localQueued.id })).status, 200);
    const bash = control.describeRequests(grant.localSessionId).find((p) => p.requestId === 'fixture-bash');
    assert.equal((await control.submit(requestFrame(bash, { kind: 'permission', decision: 'allow' }, 'app-bash'), 'app-phone')).payload.status, 'applied');
    await until(() => run.perms.has('fixture-question'), 'question must return to the same original run');
    const question = control.describeRequests(grant.localSessionId).find((p) => p.requestId === 'fixture-question');
    assert.equal((await control.submit(requestFrame(question, { kind: 'question', answers: [
      { questionId: 'q0', optionIds: ['q0:o0'] }, { questionId: 'q1', optionIds: [], text: 'original free answer' },
    ] }, 'app-question'), 'app-phone')).payload.status, 'applied');
    await until(() => run.perms.has('fixture-plan'), 'plan confirmation must remain human-owned');
    SETTINGS.permissionMode = 'acceptEdits'; run.permMode = 'plan'; // Synthetic local state only; never saveSettings.
    const plan = control.describeRequests(grant.localSessionId).find((p) => p.requestId === 'fixture-plan');
    assert.equal((await control.submit(requestFrame(plan, { kind: 'plan', decision: 'approve' }, 'app-plan'), 'app-phone')).payload.status, 'applied');
    assert.equal(SETTINGS.permissionMode, 'acceptEdits', 'remote plan cannot mutate global policy'); assert.equal(run.permMode, 'default');
    await until(() => run.perms.has('fixture-guard'), 'original guard must still ask');
    const guard = control.describeRequests(grant.localSessionId).find((p) => p.requestId === 'fixture-guard');
    assert.equal((await control.submit(requestFrame(guard, { kind: 'permission', decision: 'allow' }, 'app-guard'), 'app-phone')).payload.status, 'applied');
    await until(() => run.perms.has('fixture-guard-again'), 'remote approval must not cache guardOk for the next same-category operation');
    assert.equal(run.guardOk?.has('device:clipboard') || false, false);
    // Exercise the App's existing idle-injection path; not a new interruption policy.
    run.idle = true;
    assert.equal((await control.submit(command('message.submit', { text: '/effort ordinary-idle-text' }, 'app-injected', run.id), 'app-phone')).payload.status, 'received');
    await until(() => events.some((e) => e.type === 'inject' && e.remoteCommandId === 'app-injected'), 'original injected user replay must be emitted');
    await until(() => ledger('app-injected').receipt.status === 'applied', 'injected replay must bind original local session');
    const stop = command('run.stop', {}, 'app-stop', run.id);
    assert.equal((await control.submit(stop, 'app-phone')).payload.status, 'received');
    await until(() => run.ended && run.processClosed, 'original abort must close original child before success');
    await until(() => ledger('app-stop').receipt.status === 'applied', 'stop receipt requires real close plus run end');
    assert.equal((await control.query(command('control.query', {}, 'app-stop', run.id), 'app-phone')).payload.result.runState, 'stopped');
    const outputs = messages().filter((m) => m.type === 'control_response');
    assert.equal(outputs.find((m) => m.response.request_id === 'fixture-bash').response.response.updatedInput.command, 'printf fixture-only');
    assert.deepEqual(outputs.find((m) => m.response.request_id === 'fixture-question').response.response.updatedInput.answers,
      { 'Which original option?': 'Keep', 'Any original note?': 'original free answer' });
    assert.equal(outputs.some((m) => m.response.response.updatedPermissions), false);
    const modes = messages().filter((m) => m.type === 'control_request' && m.request.subtype === 'set_permission_mode');
    assert.equal(modes.length, 1); assert.equal(modes[0].request.mode, 'default');
    assert.ok(bootArgs.includes('--permission-prompt-tool')); assert.ok(bootArgs.includes('--settings'), 'original safety hook configuration remains attached');
    assert.equal(requests.length, 0); assert.equal(RUNS.size, 0); assert.equal(QUEUE.length, 0);
    // The App must not turn a remote stdin write with no replay into another
    // automatic execution when finish() returns pendingInject to the lane.
    await control.submit(command('message.submit', { text: 'second fixture run' }, 'app-second-message', null), 'app-phone');
    await until(() => runOfSession(grant.localSessionId)?.perms?.has('fixture-bash'), 'second disposable run must be ready');
    const second = runOfSession(grant.localSessionId); second.idle = true;
    await control.submit(command('message.submit', { text: '__fixture_close_without_replay__' }, 'app-uncertain-injection', second.id), 'app-phone');
    await until(() => second.ended, 'fixture must close before acknowledging its injected message');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(RUNS.size, 0, 'uncertain remote pendingInject must never automatically become a new run');
    const returned = QUEUE.find((it) => it.remoteCommandId === 'app-uncertain-injection');
    if (returned) assert.equal(returned.held, true, 'retained uncertain remote message is local-manual-only');
    assert.equal(ledger('app-uncertain-injection').receipt.status, 'unknown');
    if (returned) {
      const before = { ...returned };
      for (const action of ['edit', 'promote']) {
        const res = await queueAction(action, { id: returned.id, text: 'must not replay unknown text' });
        assert.equal(res.status, 409); assert.equal(res.body.error, 'remote_command_immutable'); assert.deepEqual(returned, before);
      }
      assert.equal(RUNS.size, 0, 'a local queue action must not replay an uncertain remote command');
    }
    for (let i = QUEUE.length - 1; i >= 0; i--) if (QUEUE[i].remoteCommandId === 'app-uncertain-injection') QUEUE.splice(i, 1);
    assert.equal(requests.length, 0);
  } finally {
    control.close(); off();
    for (const unfinished of [...RUNS.values()].filter((r) => r.sessionId === grant.localSessionId)) {
      abortRun(unfinished); await until(() => unfinished.ended, 'fixture cleanup must reap original fake child');
    }
    for (let i = QUEUE.length - 1; i >= 0; i--) if (QUEUE[i].sessionId === grant.localSessionId) QUEUE.splice(i, 1);
    globalThis.fetch = originalFetch; Object.assign(PATHS, previousPaths); Object.assign(SETTINGS, oldSettings);
    fs.rmSync(providerFile, { force: true }); delete process.env.REMOTE_CONTROL_FIXTURE;
  }
});

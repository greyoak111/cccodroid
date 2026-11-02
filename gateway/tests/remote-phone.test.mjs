// Run only via scripts/test.mjs: synthetic devices/JSON, no sessions, keys,
// network sockets, model calls, deployed relay, or production HOME access.
import '../gw/config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPhoneManager, PHONE_LIMITS } from '../gw/remote/phone.mjs';
import { createFrame } from '../gw/remote/protocol.mjs';

const NOW = 1_900_000_000_000;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const binding = (session = 'remote-a', extra = {}) => ({ fromDeviceId: 'phone', toDeviceId: 'tablet', hostInstanceId: 'host-1', remoteSessionId: session, grantVersion: 1, runId: 'run-1', ...extra });
const reversed = (value) => ({ ...value, fromDeviceId: value.toDeviceId, toDeviceId: value.fromDeviceId });
const summary = (remoteSessionId = 'remote-a', extra = {}) => ({ remoteSessionId, deviceId: 'tablet', title: 'Synthetic session', deviceName: 'Fixture tablet', grantVersion: 1, state: 'active', expiresAt: NOW + 600_000, pendingCount: 1, ...extra });
const pending = (extra = {}) => ({ requestId: 'request-1', requestVersion: 1, runId: 'run-1', expiresAt: NOW + 30_000, kind: 'permission', state: 'pending', detailsComplete: true, toolName: 'Bash', detailText: 'printf fixture', ...extra });
const hostSnapshot = (remoteSessionId = 'remote-a', extra = {}) => ({ binding: binding(remoteSessionId), grant: { state: 'active', expiresAt: NOW + 600_000 }, run: { runId: 'run-1', state: 'waiting' }, pending: [pending()], items: [{ id: 'message-1', kind: 'message', role: 'assistant', text: 'Fixture only' }], streamId: 'stream-1', seq: 1, historyCursor: 'older-1', historyHasMore: true, ...extra });
const record = (id, text = 'Fixture') => ({ id, kind: 'message', text });
const receipt = (frame, status = 'applied', extra = {}) => {
  const kinds = { 'message.submit': { kind: 'message', delivery: 'accepted' }, 'request.respond': { kind: 'request', requestId: frame.payload.requestId, requestVersion: frame.payload.requestVersion }, 'run.stop': { kind: 'stop', runState: 'stopped' } };
  const payload = status === 'applied' ? { status, result: kinds[frame.type] || { kind: 'message', delivery: 'accepted' } } : status === 'rejected' ? { status, code: 'REQUEST_CLOSED' } : { status };
  return createFrame('control.receipt', reversed(Object.fromEntries(Object.keys(binding()).map((key) => [key, frame[key]]))), { ...payload, ...extra }, { now: NOW, commandId: frame.commandId });
};
function backend(options = {}) {
  const calls = { open: [], accept: [], decline: [], send: [], query: [], history: [], close: [] };
  let eventListener, time = NOW, openHandler = ({ remoteSessionId }) => hostSnapshot(remoteSessionId);
  let acceptHandler = ({ remoteSessionId }) => hostSnapshot(remoteSessionId);
  let declineHandler = ({ remoteSessionId, hostDeviceId, grantVersion }) => ({ remoteSessionId, deviceId: hostDeviceId, grantVersion, state: 'declined' });
  let sendHandler = (frame) => receipt(frame), queryHandler = (frame) => receipt(frame, 'unknown');
  let historyHandler = ({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [{ id: 'older-1', kind: 'message', text: 'Earlier fixture' }], cursor: null, hasMore: false });
  let listHandler = () => [summary(), summary('remote-b')];
  const manager = createPhoneManager({
    deviceId: 'phone', now: () => time, timeoutMs: 200, ...options,
    transport: {
      list: (request) => listHandler(request),
      open: (request) => { calls.open.push(request); return openHandler(request); },
      accept: (request) => { calls.accept.push(request); return acceptHandler(request); },
      decline: (request) => { calls.decline.push(request); return declineHandler(request); },
      close: (request) => { calls.close.push(request); },
      send: (frame, request) => { calls.send.push({ frame, ...request }); return sendHandler(frame, request); },
      query: (frame, request) => { calls.query.push({ frame, ...request }); return queryHandler(frame, request); },
      history: (request) => { calls.history.push(request); return historyHandler(request); },
      subscribe(fn) { eventListener = fn; return () => { eventListener = null; }; },
    },
  });
  return { manager, calls, emit: (value) => eventListener?.(value), setTime(value) { time = value; },
    openWith(fn) { openHandler = fn; }, acceptWith(fn) { acceptHandler = fn; }, declineWith(fn) { declineHandler = fn; },
    sendWith(fn) { sendHandler = fn; }, queryWith(fn) { queryHandler = fn; }, historyWith(fn) { historyHandler = fn; }, listWith(fn) { listHandler = fn; } };
}
const scope = (state) => ({ generation: state.generation, binding: state.binding });
const hasCode = (expected) => (cause) => cause?.code === expected;

test('phone imports are inert and open enables controls only after a bound grant/run/pending snapshot', async () => {
  const b = backend();
  try {
    assert.equal((await b.manager.status()).snapshot.canControl, false);
    const wait = deferred(); b.openWith(() => wait.promise);
    const opening = b.manager.open('remote-a');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal((await b.manager.status()).snapshot.verified, false);
    await assert.rejects(b.manager.sendText('No offline queue'), (cause) => ['OFFLINE', 'RESYNC_REQUIRED'].includes(cause.code));
    assert.equal(b.calls.send.length, 0);
    wait.resolve(hostSnapshot());
    const { snapshot } = await opening;
    assert.equal(snapshot.phase, 'ready'); assert.equal(snapshot.canControl, true);
    assert.equal(snapshot.binding.fromDeviceId, 'phone'); assert.equal(snapshot.binding.toDeviceId, 'tablet');
    assert.equal(snapshot.pending.length, 1);
    assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.pending[0]));
    assert.throws(() => { snapshot.binding.toDeviceId = 'other'; }, TypeError);
  } finally { b.manager.dispose(); }
});

test('phone invitation acceptance is explicit, bound, and cannot approve a tool; decline needs a tablet acknowledgement', async () => {
  const b = backend();
  b.listWith(() => [summary('remote-a', { state: 'invited' }), summary('remote-b', { state: 'invited' })]);
  try {
    await assert.rejects(b.manager.open('remote-a'), hasCode('GRANT_NOT_ACTIVE'));
    assert.equal(b.calls.open.length, 0); assert.equal(b.calls.send.length, 0);
    const accepted = await b.manager.accept('remote-a');
    assert.equal(accepted.snapshot.canControl, true); assert.equal(accepted.snapshot.sessions.find((item) => item.remoteSessionId === 'remote-a').state, 'active');
    assert.equal(b.calls.accept.length, 1); assert.equal(b.calls.accept[0].grantVersion, 1); assert.equal(b.calls.accept[0].hostDeviceId, 'tablet');
    b.declineWith(() => ({ remoteSessionId: 'remote-b', deviceId: 'wrong-device', grantVersion: 1, state: 'declined' }));
    await assert.rejects(b.manager.decline('remote-b'), hasCode('GRANT_MISMATCH'));
    assert.ok((await b.manager.status()).snapshot.sessions.some((item) => item.remoteSessionId === 'remote-b'));
    b.declineWith(({ remoteSessionId, hostDeviceId, grantVersion }) => ({ remoteSessionId, deviceId: hostDeviceId, grantVersion, state: 'declined' }));
    const declined = await b.manager.decline('remote-b');
    assert.ok(!declined.snapshot.sessions.some((item) => item.remoteSessionId === 'remote-b'));
    assert.equal(declined.snapshot.active.remoteSessionId, 'remote-a'); assert.equal(b.calls.send.length, 0);
  } finally { b.manager.dispose(); }
});

test('phone reconnection gates sends and approvals until all current authority/run/pending state is verified', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    await b.manager.receive({ type: 'connection', state: 'offline' });
    const cached = (await b.manager.status()).snapshot;
    assert.equal(cached.cached, true); assert.equal(cached.canControl, false); assert.equal(cached.items.length, 1);
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow' }), hasCode('OFFLINE'));
    const wait = deferred(); b.openWith(() => wait.promise);
    const resume = b.manager.receive({ type: 'connection', state: 'online' });
    assert.equal((await b.manager.status()).snapshot.phase, 'syncing');
    await assert.rejects(b.manager.stop(), hasCode('RESYNC_REQUIRED'));
    wait.resolve(hostSnapshot('remote-a', { binding: binding('remote-a', { runId: 'run-2' }), run: { runId: 'run-2', state: 'running' }, pending: [], seq: 2 }));
    const resumed = await resume;
    assert.equal(resumed.snapshot.binding.runId, 'run-2'); assert.equal(resumed.snapshot.canControl, true); assert.deepEqual(resumed.snapshot.pending, []);
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow' }), hasCode('REQUEST_CLOSED'));
    assert.equal(b.calls.send.length, 0);
  } finally { b.manager.dispose(); }
});

test('phone rejects incomplete snapshots, wrong devices/handles, grants, and prior host lifecycles', async () => {
  for (const [change, code] of [
    [{ binding: binding('remote-a', { toDeviceId: 'other' }) }, 'DEVICE_MISMATCH'],
    [{ binding: binding('remote-b') }, 'SESSION_MISMATCH'],
    [{ binding: binding('remote-a', { grantVersion: 2 }) }, 'GRANT_MISMATCH'],
    [{ run: { runId: 'old-run', state: 'running' } }, 'RUN_MISMATCH'],
    [{ pending: undefined }, 'INVALID_SCHEMA'],
    [{ grant: { state: 'revoked', expiresAt: NOW + 10_000 } }, 'GRANT_REVOKED'],
  ]) {
    const b = backend(); b.openWith(() => hostSnapshot('remote-a', change));
    try { await assert.rejects(b.manager.open('remote-a'), hasCode(code)); assert.equal((await b.manager.status()).snapshot.canControl, false); }
    finally { b.manager.dispose(); }
  }
  const b = backend();
  try {
    await b.manager.open('remote-a');
    b.openWith(() => hostSnapshot('remote-a', { binding: binding('remote-a', { hostInstanceId: 'host-2' }) }));
    await assert.rejects(b.manager.receive({ type: 'connection', state: 'online' }), hasCode('HOST_INSTANCE_MISMATCH'));
    const state = (await b.manager.status()).snapshot;
    assert.equal(state.items.length, 0); assert.equal(state.phase, 'revoked'); assert.equal(state.binding, null);
  } finally { b.manager.dispose(); }
});

test('phone generations, device/session scopes and subscriptions prevent stale cross-page updates', async () => {
  const b = backend(), wait = deferred(); let latest;
  const unsubscribe = b.manager.subscribe((state) => { latest = state; });
  try {
    b.openWith(({ remoteSessionId }) => remoteSessionId === 'remote-a' ? wait.promise : hostSnapshot(remoteSessionId));
    const oldOpen = b.manager.open('remote-a'); const oldResult = oldOpen.catch((cause) => cause);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await b.manager.open('remote-b'); wait.resolve(hostSnapshot());
    assert.ok(['OFFLINE', 'RESYNC_REQUIRED'].includes((await oldResult).code));
    assert.equal(latest.active.remoteSessionId, 'remote-b');
    await assert.rejects(b.manager.sendText('Wrong page', 'stale-page', { generation: latest.generation - 1, binding: binding() }), hasCode('RESYNC_REQUIRED'));
    await assert.rejects(b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 2, items: [{ id: 'wrong', text: 'Never render' }] }), hasCode('SESSION_MISMATCH'));
    assert.equal((await b.manager.status()).snapshot.items[0].id, 'message-1');
    await b.manager.close(); assert.equal(latest.active, null); assert.deepEqual(latest.items, []);
  } finally { unsubscribe(); b.manager.dispose(); }
});

test('phone receipt requires an authenticated tablet frame, unknown is query-only, stable IDs never resend', async () => {
  const b = backend();
  try {
    const opened = await b.manager.open('remote-a');
    b.sendWith(() => ({ status: 'received', by: 'relay' }));
    const first = await b.manager.sendText('Fixture message', 'stable-1', scope(opened.snapshot));
    assert.equal(first.receipt.status, 'unknown'); assert.equal(first.receipt.commandId, 'stable-1');
    const duplicate = await b.manager.sendText('Fixture message', 'stable-1');
    assert.equal(duplicate.receipt.status, 'unknown'); assert.equal(b.calls.send.length, 1);
    await assert.rejects(b.manager.sendText('Different message', 'stable-1'), hasCode('COMMAND_CONFLICT'));
    b.queryWith((frame) => receipt(frame, 'applied', { result: { kind: 'message', delivery: 'queued' } }));
    const checked = await b.manager.query('stable-1');
    assert.equal(checked.receipt.status, 'applied'); assert.equal(b.calls.query[0].frame.commandId, 'stable-1');
    assert.equal(b.calls.query[0].frame.type, 'control.query'); assert.deepEqual(b.calls.query[0].frame.payload, {});
    assert.equal((await b.manager.sendText('Fixture message', 'stable-1')).receipt.status, 'applied');
    assert.equal(b.calls.send.length, 1);
    const postReload = await b.manager.query('from-before-reload');
    assert.equal(postReload.receipt.status, 'applied');
    await assert.rejects(b.manager.sendText('Do not turn query into resend', 'from-before-reload'), hasCode('COMMAND_UNKNOWN'));
  } finally { b.manager.dispose(); }
});

test('phone close cancels a just-created command before dispatch and ignores offline/stale authority snapshots', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    const sending = b.manager.sendText('Must not dispatch after close', 'abort-before-dispatch').catch((cause) => cause);
    await b.manager.close();
    assert.equal((await sending).code, 'RESYNC_REQUIRED'); assert.equal(b.calls.send.length, 0);
    await b.manager.open('remote-a');
    await b.manager.receive({ type: 'connection', state: 'offline' });
    await assert.rejects(b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot() }), hasCode('RESYNC_REQUIRED'));
    assert.equal((await b.manager.status()).snapshot.canControl, false);
    await b.manager.receive({ type: 'connection', state: 'online' });
    b.sendWith((frame) => receipt(frame, 'unknown'));
    const unknown = await b.manager.sendText('Unknown', 'old-run-command');
    assert.ok(Object.isFrozen(unknown.receipt));
    await b.manager.receive({ type: 'session.snapshot', binding: binding('remote-a', { runId: 'run-2' }), snapshot: hostSnapshot('remote-a', { binding: binding('remote-a', { runId: 'run-2' }), run: { runId: 'run-2', state: 'running' }, pending: [], seq: 2 }) });
    const checked = await b.manager.query('old-run-command'); assert.equal(checked.receipt.status, 'unknown'); assert.equal(b.calls.query.length, 1);
    assert.equal(b.calls.query[0].frame.runId, 'run-1'); assert.equal((await b.manager.status()).snapshot.binding.runId, 'run-2');
    await assert.rejects(b.manager.sendText('Unknown', 'old-run-command'), hasCode('COMMAND_CONFLICT'));
  } finally { b.manager.dispose(); }
});

test('phone controls keep exact canonical text/response fields and incomplete details cannot approve', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    await b.manager.sendText('/not-a-local-command', 'text-1');
    const command = b.calls.send[0].frame;
    assert.equal(command.type, 'message.submit'); assert.deepEqual(command.payload, { text: '/not-a-local-command' });
    assert.equal(b.calls.send[0].priority, 'control');
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow', always: true }, 'unsafe'), hasCode('UNKNOWN_FIELD'));
    await assert.rejects(b.manager.sendText('大'.repeat(6000), 'too-long'), hasCode('LIMIT_EXCEEDED'));
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { pending: [pending({ detailsComplete: false })], seq: 2 }) });
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow' }, 'incomplete'), hasCode('DETAILS_INCOMPLETE'));
    const denied = await b.manager.respond('request-1', { kind: 'permission', decision: 'deny', reason: 'Fixture reason' }, 'deny-1');
    assert.equal(denied.receipt.status, 'applied');
    assert.deepEqual(b.calls.send.at(-1).frame.payload, { requestId: 'request-1', requestVersion: 1, response: { kind: 'permission', decision: 'deny', reason: 'Fixture reason' } });
  } finally { b.manager.dispose(); }
});

test('phone pending question IDs/options remain tablet-owned and complete before response', async () => {
  const b = backend();
  const question = pending({ kind: 'question', toolName: 'AskUserQuestion', questions: [{ questionId: 'question-from-tablet', question: 'Choose fixture', multiSelect: false, options: [{ optionId: 'option-from-tablet', label: 'Fixture option' }] }] });
  b.openWith(() => hostSnapshot('remote-a', { pending: [question] }));
  try {
    await b.manager.open('remote-a');
    await assert.rejects(b.manager.respond('request-1', { kind: 'question', answers: [{ questionId: 'invented-ui-id', optionIds: ['option-from-tablet'] }] }, 'question-wrong'), hasCode('REQUEST_MISMATCH'));
    await assert.rejects(b.manager.respond('request-1', { kind: 'question', answers: [{ questionId: 'question-from-tablet', optionIds: ['invented-option'] }] }, 'option-wrong'), hasCode('REQUEST_MISMATCH'));
    const answer = await b.manager.respond('request-1', { kind: 'question', answers: [{ questionId: 'question-from-tablet', optionIds: [], text: 'Free text fixture' }] }, 'answer-right');
    assert.equal(answer.receipt.status, 'applied'); assert.equal(b.calls.send.length, 1);
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { pending: [{ ...question, detailsComplete: false }], seq: 2 }) });
    await assert.rejects(b.manager.respond('request-1', { kind: 'question', answers: [{ questionId: 'question-from-tablet', optionIds: ['option-from-tablet'] }] }, 'incomplete-answer'), hasCode('DETAILS_INCOMPLETE'));
  } finally { b.manager.dispose(); }
});

test('phone command route preserves exact requestVersion/scope instead of rebinding stale approvals', async () => {
  const b = backend();
  try {
    const { snapshot } = await b.manager.open('remote-a');
    const command = { ...scope(snapshot), type: 'request.respond', commandId: 'route-approval', payload: { requestId: 'request-1', requestVersion: 1, response: { kind: 'permission', decision: 'allow' } } };
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { pending: [pending({ requestVersion: 2 })], seq: 2 }) });
    await assert.rejects(b.manager.command(command), hasCode('REQUEST_MISMATCH'));
    assert.equal(b.calls.send.length, 0);
    command.payload.requestVersion = 2;
    const result = await b.manager.command(command); assert.equal(result.receipt.status, 'applied');
    assert.equal(b.calls.send[0].frame.payload.requestVersion, 2);
    await assert.rejects(b.manager.command({ ...command, generation: snapshot.generation - 1 }), hasCode('RESYNC_REQUIRED'));
    await assert.rejects(b.manager.command({ ...command, type: 'arbitrary.shell' }), hasCode('UNSUPPORTED_TYPE'));
    await assert.rejects(b.manager.command({ ...command, payload: { ...command.payload, toolInput: { command: 'never' } } }), hasCode('UNKNOWN_FIELD'));
  } finally { b.manager.dispose(); }
});

test('phone stop remains received until tablet proves the original run actually ended', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a'); b.sendWith((frame) => receipt(frame, 'received'));
    const sent = await b.manager.stop('stop-1'); assert.equal(sent.receipt.status, 'received'); assert.equal(sent.snapshot.run.state, 'waiting');
    b.queryWith((frame) => receipt(frame, 'applied', { result: { kind: 'stop', runState: 'stopped' } }));
    const done = await b.manager.query('stop-1'); assert.equal(done.receipt.result.runState, 'stopped');
    assert.equal(b.calls.send.length, 1);
  } finally { b.manager.dispose(); }
});

test('phone histories serialize, caches are byte/count bounded, stream gaps resync rather than append', async () => {
  const b = backend({ maxCacheBytes: 450, maxItems: 3 });
  try {
    await b.manager.open('remote-a');
    for (let seq = 2; seq <= 10; seq++) await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq, items: [{ id: 'item-' + seq, kind: 'message', text: 'x'.repeat(140) }] });
    const cached = (await b.manager.status()).snapshot;
    assert.ok(cached.cache.bytes <= 450); assert.ok(cached.items.length <= 3); assert.equal(cached.cache.truncated, true);
    const wait = deferred(); b.historyWith(() => wait.promise);
    const first = b.manager.history('older-1');
    await assert.rejects(b.manager.history('older-1'), hasCode('INVALID_TRANSITION'));
    wait.resolve({ binding: binding(), streamId: 'stream-1', items: [{ id: 'older-item', kind: 'message', text: 'Old' }], cursor: null, hasMore: false });
    await first; assert.equal(b.calls.history.length, 1); assert.equal(b.calls.history[0].limit, 50); assert.equal(b.calls.history[0].maxBytes, 256 * 1024);
    b.openWith(() => hostSnapshot('remote-a', { seq: 15, pending: [] }));
    await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 12, items: [{ id: 'gap', text: 'not appended' }] });
    const synced = (await b.manager.status()).snapshot;
    assert.equal(synced.seq, 15); assert.ok(!synced.items.some((item) => item.id === 'gap')); assert.equal(b.calls.open.length, 2);
  } finally { b.manager.dispose(); }
});

test('phone keeps only explicit read-only history across pushes, never rolled-back live or old pending', async () => {
  const b = backend();
  try {
    b.openWith(() => hostSnapshot('remote-a', { items: [record('live-old')] }));
    await b.manager.open('remote-a');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('older-a')], cursor: 'older-2', hasMore: true }));
    await b.manager.history('older-1');
    const latest = hostSnapshot('remote-a', { seq: 4, items: [record('live-new')], pending: [], historyCursor: 'push-cursor' });
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: latest });
    let state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['older-a', 'live-new']);
    assert.deepEqual(state.pending, []); assert.equal(state.historyCursor, 'older-2'); assert.equal(state.historyHasMore, true);
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow' }), hasCode('REQUEST_CLOSED'));
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq: 2 }) });
    state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['older-a', 'live-new']); assert.deepEqual(state.pending, []);
    await assert.rejects(b.manager.history('unrelated-cursor'), hasCode('RESYNC_REQUIRED'));
    assert.equal(b.calls.history.length, 1, 'an unrelated frontier is not dispatched');
    b.openWith(() => latest);
    await b.manager.receive({ type: 'connection', state: 'offline' });
    await b.manager.receive({ type: 'connection', state: 'online' });
    assert.equal((await b.manager.status()).snapshot.historyCursor, 'older-2');
    b.historyWith(({ binding: current, cursor }) => {
      assert.equal(cursor, 'older-2');
      return { binding: current, streamId: 'stream-1', items: [record('older-b')], cursor: null, hasMore: false };
    });
    await b.manager.history('older-2');
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: { ...latest, seq: 5 } });
    state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['older-b', 'older-a', 'live-new']);
    assert.equal(state.historyCursor, null); assert.equal(state.historyHasMore, false);
  } finally { b.manager.dispose(); }
});

test('phone count/UTF-8 cache accounting handles brackets, commas and same-ID replacement exactly', async () => {
  const boundary = [record('edge-a', '大'), record('edge-b', String.fromCharCode(34, 92, 10))];
  const maximum = Buffer.byteLength(JSON.stringify(boundary), 'utf8');
  for (const maxCacheBytes of [maximum, maximum - 1]) {
    const b = backend({ maxCacheBytes, maxItems: 2 });
    b.openWith(() => hostSnapshot('remote-a', { items: boundary }));
    try {
      let state = (await b.manager.open('remote-a')).snapshot;
      assert.equal(state.items.length, maxCacheBytes === maximum ? 2 : 1);
      assert.equal(state.items.at(-1).id, 'edge-b');
      assert.equal(state.cache.bytes, Buffer.byteLength(JSON.stringify(state.items), 'utf8'));
      await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 2, items: [record('edge-b', '短')] });
      state = (await b.manager.status()).snapshot;
      assert.equal(state.items.filter((item) => item.id === 'edge-b').length, 1);
      assert.equal(state.items.at(-1).text, '短'); assert.ok(state.cache.bytes <= maxCacheBytes);
      assert.equal(state.cache.bytes, Buffer.byteLength(JSON.stringify(state.items), 'utf8'));
    } finally { b.manager.dispose(); }
  }
  assert.throws(() => backend({ maxCacheBytes: 1 }), hasCode('INVALID_SCHEMA'), 'an empty JSON array itself needs two bytes');
  const tiny = backend({ maxCacheBytes: 2 });
  try {
    const state = (await tiny.manager.open('remote-a')).snapshot;
    assert.deepEqual(state.items, []); assert.equal(state.cache.bytes, 2); assert.equal(state.cache.truncated, true);
  } finally { tiny.manager.dispose(); }
});

test('phone history pressure preserves the live tail and rejects a partial page without advancing its cursor', async () => {
  const b = backend({ maxItems: 3 });
  b.openWith(() => hostSnapshot('remote-a', { items: [record('tail-1')] }));
  try {
    await b.manager.open('remote-a');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-1'), record('read-2')], cursor: 'older-2', hasMore: true }));
    await b.manager.history('older-1');
    for (let seq = 2; seq <= 3; seq++) {
      await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq, items: [record('tail-' + seq)] }) });
      const state = (await b.manager.status()).snapshot;
      assert.deepEqual(state.items.map((item) => item.id), ['read-1', 'read-2', 'tail-' + seq]);
      assert.equal(state.historyCursor, 'older-2');
    }
    await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 4, items: [record('tail-4')] });
    let state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['read-1', 'tail-3', 'tail-4']);
    const before = clone(state.items);
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-older-1'), record('read-older-2')], cursor: 'older-3', hasMore: true }));
    await assert.rejects(b.manager.history('older-2'), hasCode('LIMIT_EXCEEDED'));
    state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items, before); assert.equal(state.historyCursor, 'older-2'); assert.equal(state.historyBusy, false);
  } finally { b.manager.dispose(); }
});

test('phone combined history/live cache keeps default 500-item and 512-KiB bounds with the live tail intact', async () => {
  for (const textSize of [40, 3500]) {
    const b = backend(), liveItems = Array.from({ length: 50 }, (_, index) => record('live-' + index, 'l'.repeat(textSize)));
    b.openWith(() => hostSnapshot('remote-a', { items: liveItems }));
    try {
      await b.manager.open('remote-a');
      for (let page = 1; page <= 10; page++) {
        b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1',
          items: Array.from({ length: 50 }, (_, index) => record('history-' + page + '-' + index, 'h'.repeat(textSize))), cursor: 'older-' + (page + 1), hasMore: true }));
        const state = (await b.manager.history('older-' + page)).snapshot;
        assert.ok(state.items.length <= 500); assert.ok(state.cache.bytes <= 512 * 1024);
        assert.equal(state.cache.bytes, Buffer.byteLength(JSON.stringify(state.items), 'utf8'));
        assert.equal(state.historyCursor, 'older-' + (page + 1));
        assert.deepEqual(state.items.slice(-50), liveItems, 'history budget never pops real-time records');
        assert.ok(state.items.some((item) => item.id === 'history-' + page + '-0'), 'newly requested reading window is preferred');
        if (page === 10 && textSize === 40) assert.equal(state.items.length, 500);
      }
    } finally { b.manager.dispose(); }
  }
});

test('phone history wins a same-ID history update, but live overlap is authoritative and cannot reappear as history', async () => {
  const b = backend();
  b.openWith(() => hostSnapshot('remote-a', { items: [record('overlap', 'live')] }));
  try {
    await b.manager.open('remote-a');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-id', 'v1'), record('overlap', 'stale page')], cursor: 'older-2', hasMore: true }));
    await b.manager.history('older-1');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-id', 'v2')], cursor: null, hasMore: false }));
    await b.manager.history('older-2');
    let state = (await b.manager.status()).snapshot;
    assert.equal(state.items.find((item) => item.id === 'read-id').text, 'v2');
    assert.equal(state.items.find((item) => item.id === 'overlap').text, 'live');
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq: 2, pending: [], items: [record('new-live')] }) });
    state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['read-id', 'new-live']);
    assert.equal(state.cache.bytes, Buffer.byteLength(JSON.stringify(state.items), 'utf8'));
  } finally { b.manager.dispose(); }
});

test('phone explicit history resets immediately for run, stream, selection, revoke, expiry and local reset', async () => {
  for (const change of ['run', 'stream', 'selection', 'revoke', 'expiry', 'reset']) {
    const b = backend();
    try {
      await b.manager.open('remote-a'); await b.manager.history('older-1');
      assert.ok((await b.manager.status()).snapshot.items.some((item) => item.id === 'older-1'));
      if (change === 'run' || change === 'stream') {
        const nextBinding = change === 'run' ? binding('remote-a', { runId: 'run-2' }) : binding();
        await b.manager.receive({ type: 'session.snapshot', binding: nextBinding, snapshot: hostSnapshot('remote-a', {
          binding: nextBinding, run: { runId: nextBinding.runId, state: 'running' }, pending: [], seq: 2,
          streamId: change === 'stream' ? 'stream-2' : 'stream-1', historyCursor: 'new-frontier',
        }) });
      } else if (change === 'selection') await b.manager.open('remote-b');
      else if (change === 'revoke') await b.manager.receive({ type: 'host.revoke', binding: binding() });
      else if (change === 'expiry') b.setTime(NOW + 600_001);
      else await b.manager.receive({ type: 'reset' });
      const state = (await b.manager.status()).snapshot;
      assert.ok(!state.items.some((item) => item.id === 'older-1'), change);
      assert.equal(state.cache.bytes, Buffer.byteLength(JSON.stringify(state.items), 'utf8'));
      if (change === 'run' || change === 'stream') assert.equal(state.historyCursor, 'new-frontier');
      if (['revoke', 'expiry', 'reset'].includes(change)) { assert.equal(state.historyCursor, null); assert.equal(state.historyHasMore, false); }
    } finally { b.manager.dispose(); }
  }
});

test('phone history full displacement resets its frontier and a snapshot never preserves rolled-back batch records', async () => {
  const b = backend({ maxItems: 2 });
  b.openWith(() => hostSnapshot('remote-a', { items: [record('live-1')] }));
  try {
    await b.manager.open('remote-a');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-old')], cursor: 'older-2', hasMore: true }));
    await b.manager.history('older-1');
    await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 2, items: [record('live-2')] });
    let state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['live-1', 'live-2']);
    assert.equal(state.historyCursor, 'older-1'); assert.equal(state.historyHasMore, true);
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq: 3, items: [record('live-3')], pending: [], historyCursor: 'fresh-frontier' }) });
    state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['live-3']); assert.deepEqual(state.pending, []);
    assert.equal(state.historyCursor, 'fresh-frontier');
  } finally { b.manager.dispose(); }
});

test('phone an in-flight older page cannot restore a displaced history frontier', async () => {
  const b = backend({ maxItems: 2 }), gate = deferred();
  b.openWith(() => hostSnapshot('remote-a', { items: [record('live-1')] }));
  try {
    await b.manager.open('remote-a');
    b.historyWith(({ binding: current }) => ({ binding: current, streamId: 'stream-1', items: [record('read-old')], cursor: 'older-2', hasMore: true }));
    await b.manager.history('older-1'); b.historyWith(() => gate.promise);
    const loading = b.manager.history('older-2'); const result = loading.catch((cause) => cause);
    await Promise.resolve();
    await b.manager.receive({ type: 'event.batch', binding: binding(), streamId: 'stream-1', seq: 2, items: [record('live-2')] });
    gate.resolve({ binding: binding(), streamId: 'stream-1', items: [record('orphan-history')], cursor: 'older-3', hasMore: true });
    assert.equal((await result).code, 'RESYNC_REQUIRED');
    const state = (await b.manager.status()).snapshot;
    assert.deepEqual(state.items.map((item) => item.id), ['live-1', 'live-2']); assert.equal(state.historyCursor, 'older-1'); assert.equal(state.historyBusy, false);
  } finally { gate.resolve({}); b.manager.dispose(); }
});

test('phone late history cannot cross a stream reset or clear a newer history busy flag', async () => {
  const b = backend(), oldPage = deferred(), newPage = deferred();
  try {
    await b.manager.open('remote-a'); b.historyWith(() => oldPage.promise);
    const first = b.manager.history('older-1'); const firstResult = first.catch((cause) => cause);
    await Promise.resolve();
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { streamId: 'stream-2', seq: 2 }) });
    b.historyWith(() => newPage.promise);
    const second = b.manager.history('older-1'); second.catch(() => {});
    oldPage.resolve({ binding: binding(), streamId: 'stream-1', items: [record('wrong-stream')], cursor: null, hasMore: false });
    assert.equal((await firstResult).code, 'RESYNC_REQUIRED');
    let state = (await b.manager.status()).snapshot;
    assert.equal(state.historyBusy, true); assert.ok(!state.items.some((item) => item.id === 'wrong-stream'));
    newPage.resolve({ binding: binding(), streamId: 'stream-2', items: [record('right-stream')], cursor: null, hasMore: false });
    await second; state = (await b.manager.status()).snapshot;
    assert.equal(state.historyBusy, false); assert.ok(state.items.some((item) => item.id === 'right-stream'));
  } finally { oldPage.resolve({}); newPage.resolve({}); b.manager.dispose(); }
});

test('phone invalid/revoked authority snapshots immediately disable old approval controls', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    await assert.rejects(b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { pending: [pending({ detailsComplete: true, detailText: '' })], seq: 2 }) }), hasCode('DETAILS_INCOMPLETE'));
    assert.equal((await b.manager.status()).snapshot.canControl, false);
    await assert.rejects(b.manager.sendText('Blocked', 'invalid-snapshot'), hasCode('RESYNC_REQUIRED'));
    await b.manager.resync();
    await assert.rejects(b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { grant: { state: 'revoked', expiresAt: NOW + 600_000 }, seq: 3 }) }), hasCode('GRANT_REVOKED'));
    const state = (await b.manager.status()).snapshot; assert.equal(state.phase, 'revoked'); assert.deepEqual(state.items, []); assert.deepEqual(state.pending, []);
    assert.equal(b.calls.send.length, 0);
  } finally { b.manager.dispose(); }
});

test('a validated delayed push cannot invalidate a newer verified resync or restore its old pending request', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', {
      seq: 9, pending: [pending({ requestId: 'request-new', requestVersion: 2 })],
    }) });
    b.sendWith((frame) => receipt(frame, 'unknown'));
    await b.manager.sendText('Unknown stays unknown', 'unknown-before-old-push');
    const before = (await b.manager.status()).snapshot;
    const old = hostSnapshot('remote-a', { seq: 2 });
    await b.emit({ type: 'session.snapshot', binding: binding(), snapshot: old });
    await Promise.resolve(); await Promise.resolve();
    const current = (await b.manager.status()).snapshot;
    assert.equal(current.seq, 9); assert.equal(current.canControl, true);
    assert.equal(current.revision, before.revision); assert.equal(current.pending[0].requestId, 'request-new');
    assert.equal(current.receipts[0].status, 'unknown'); assert.equal(b.calls.send.length, 1);
    await assert.rejects(b.manager.respond('request-1', { kind: 'permission', decision: 'allow' }), hasCode('REQUEST_CLOSED'));
    assert.equal(b.calls.send.length, 1);
    b.openWith(() => old);
    await assert.rejects(b.manager.resync(), hasCode('RESYNC_REQUIRED'), 'an old correlated resync cannot re-enable controls');
    assert.equal((await b.manager.status()).snapshot.canControl, false);
  } finally { b.manager.dispose(); }
});

test('an unsolicited snapshot cannot verify a reconnect while the current correlated resync is held', async () => {
  const b = backend(), gate = deferred();
  try {
    await b.manager.open('remote-a'); await b.manager.receive({ type: 'connection', state: 'offline' });
    b.openWith(() => gate.promise);
    const resume = b.manager.receive({ type: 'connection', state: 'online' }); resume.catch(() => {});
    const push = hostSnapshot('remote-a', { seq: 20 });
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: push });
    assert.equal((await b.manager.status()).snapshot.canControl, false);
    assert.equal((await b.manager.status()).snapshot.phase, 'syncing');
    gate.resolve(hostSnapshot('remote-a', { seq: 21 })); await resume;
    assert.equal((await b.manager.status()).snapshot.canControl, true);
    assert.equal((await b.manager.status()).snapshot.seq, 21);
  } finally { gate.resolve(hostSnapshot('remote-a', { seq: 21 })); b.manager.dispose(); }
});

test('stale pushes still validate pending details and revocation before they may be ignored', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    await b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq: 8 }) });
    await assert.rejects(b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', {
      seq: 2, pending: [pending({ detailText: '' })],
    }) }), hasCode('DETAILS_INCOMPLETE'));
    assert.equal((await b.manager.status()).snapshot.canControl, false);
    b.openWith(() => hostSnapshot('remote-a', { seq: 9 })); await b.manager.resync();
    await assert.rejects(b.manager.receive({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', {
      seq: 1, grant: { state: 'revoked', expiresAt: NOW + 600_000 },
    }) }), hasCode('GRANT_REVOKED'));
    const current = (await b.manager.status()).snapshot;
    assert.equal(current.phase, 'revoked'); assert.deepEqual(current.items, []); assert.deepEqual(current.pending, []);
  } finally { b.manager.dispose(); }
});

test('a rejected subscribed snapshot cannot overwrite terminal revocation or expiry in its later catch', async () => {
  for (const terminal of ['revoked', 'expired']) {
    const b = backend();
    try {
      await b.manager.open('remote-a'); await b.manager.history('older-1');
      b.emit({ type: 'session.snapshot', binding: binding(), snapshot: hostSnapshot('remote-a', { seq: 2, pending: [pending({ detailText: '' })] }) });
      if (terminal === 'revoked') b.emit({ type: 'host.revoke', binding: binding() });
      else { b.setTime(NOW + 600_001); await b.manager.status(); }
      await Promise.resolve(); await Promise.resolve();
      const current = (await b.manager.status()).snapshot;
      assert.equal(current.phase, terminal); assert.equal(current.error, terminal === 'revoked' ? 'GRANT_REVOKED' : 'EXPIRED');
      assert.deepEqual(current.items, []); assert.deepEqual(current.pending, []); assert.equal(current.canControl, false);
      assert.equal(current.historyCursor, null); assert.equal(current.cache.bytes, 2);
    } finally { b.manager.dispose(); }
  }
});

test('phone never reflects transport exception text or credential-shaped codes into local JSON', async () => {
  const b = backend();
  try {
    await b.manager.open('remote-a');
    b.sendWith(() => { throw Object.assign(new Error('synthetic-secret-do-not-log'), { code: 'synthetic-secret-do-not-log' }); });
    const value = await b.manager.sendText('Fixture', 'private-failure');
    assert.equal(value.receipt.status, 'unknown'); assert.equal(value.snapshot.error, 'OFFLINE');
    assert.ok(!JSON.stringify(value).includes('synthetic-secret-do-not-log'));
    b.historyWith(() => { throw Object.assign(new Error('synthetic-secret-do-not-log'), { code: 'synthetic-secret-do-not-log' }); });
    await assert.rejects(b.manager.history(), (cause) => cause.code === 'OFFLINE' && !cause.message.includes('synthetic-secret'));
  } finally { b.manager.dispose(); }
});

test('phone command journal fails closed at cap and revoke/expiry/reset clears temporary content without stopping', async () => {
  const b = backend({ maxCommands: 1 });
  try {
    await b.manager.open('remote-a'); await b.manager.sendText('one', 'one');
    await assert.rejects(b.manager.sendText('two', 'two'), hasCode('LEDGER_FULL'));
    await b.manager.receive({ type: 'host.revoke', binding: binding() });
    const revoked = (await b.manager.status()).snapshot;
    assert.deepEqual(revoked.items, []); assert.deepEqual(revoked.pending, []); assert.deepEqual(revoked.receipts, []); assert.equal(revoked.binding, null);
    await assert.rejects(b.manager.history(), hasCode('GRANT_REVOKED'));
    assert.equal(b.calls.send.length, 1); assert.equal(b.calls.send[0].frame.type, 'message.submit');
    await b.manager.receive({ type: 'reset' }); assert.deepEqual((await b.manager.status()).snapshot.sessions, []);
  } finally { b.manager.dispose(); }
  const expired = backend();
  try {
    await expired.manager.open('remote-a'); expired.setTime(NOW + 600_001);
    const state = (await expired.manager.status()).snapshot;
    assert.equal(state.phase, 'expired'); assert.deepEqual(state.items, []); assert.equal(state.canControl, false);
  } finally { expired.manager.dispose(); }
});

const browserSource = fs.readFileSync(new URL('../web/app/13r-remote-transport.js', import.meta.url), 'utf8');
function browser() {
  const calls = [], streams = [], timers = new Map(); let nextTimer = 0, time = NOW, nextId = 0, revision = 0, generation = 0, active = null;
  let openHandler, commandHandler, queryHandler, current;
  const snapshot = (extra = {}) => {
    const session = active;
    return {
      revision: ++revision, generation, deviceId: 'phone', connection: 'online', phase: session ? 'ready' : 'idle', verified: !!session, canControl: !!session,
      cached: false, sessions: [summary(), summary('remote-b')], active: session ? { remoteSessionId: session, deviceId: 'tablet', title: 'Synthetic', deviceName: 'Fixture tablet' } : null,
      binding: session ? binding(session) : null, grant: session ? { state: 'active', expiresAt: NOW + 600_000 } : null,
      run: session ? { runId: 'run-1', state: 'waiting' } : null, pending: session ? [pending()] : [], items: session ? [{ id: 'fixture', text: 'Only a fixture' }] : [], receipts: [],
      streamId: session ? 'stream-1' : null, seq: session ? 1 : 0, historyCursor: null, historyHasMore: false, historyBusy: false, lastSyncedAt: session ? NOW : null, error: null,
      ...extra,
    };
  };
  current = snapshot();
  const reply = (value, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => clone(value) });
  const sandbox = {
    TextEncoder, Uint8Array, AbortController, console, crypto: { randomUUID: () => 'auto-' + ++nextId },
    setTimeout(fn, delay) { const handle = ++nextTimer; timers.set(handle, { fn, delay }); return handle; }, clearTimeout(handle) { timers.delete(handle); },
    fetch: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      const call = { url, ...request, body }; calls.push(call);
      assert.ok(url.startsWith('/api/remote/')); assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
      if (url.endsWith('/open') || url.endsWith('/accept')) {
        generation++; active = body.remoteSessionId;
        if (openHandler) return openHandler(call);
        current = snapshot(); return reply({ snapshot: current });
      }
      if (url.endsWith('/decline')) { if (active === body.remoteSessionId) { generation++; active = null; } current = snapshot(); return reply({ snapshot: current }); }
      if (url.endsWith('/close')) { generation++; active = null; current = snapshot(); return reply({ snapshot: current }); }
      if (url.endsWith('/command')) {
        if (commandHandler) return commandHandler(call);
        current = snapshot();
        return reply({ snapshot: current, receipt: { commandId: body.commandId, type: body.type, status: 'received', updatedAt: time } });
      }
      if (url.endsWith('/query')) {
        if (queryHandler) return queryHandler(call);
        current = snapshot(); return reply({ snapshot: current, receipt: { commandId: body.commandId, type: null, status: 'unknown', code: 'COMMAND_UNKNOWN', updatedAt: time } });
      }
      if (url.endsWith('/history')) { current = snapshot(); return reply({ snapshot: current, page: { items: [], cursor: null, hasMore: false } }); }
      return reply({ snapshot: current });
    },
    localStorage: { getItem() { assert.fail('No credential/content persistence'); }, setItem() { assert.fail('No credential/content persistence'); } },
    sessionStorage: { getItem() { assert.fail('No credential/content persistence'); }, setItem() { assert.fail('No credential/content persistence'); } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(browserSource, sandbox, { filename: '13r-remote-transport.js' });
  const transport = sandbox.createRemoteTransport({ fetch: sandbox.fetch, now: () => time, eventSource(url) {
    assert.equal(url, '/api/remote/events');
    const stream = { closed: false, addEventListener(name, fn) { this[name] = fn; }, close() { this.closed = true; } };
    streams.push(stream); return stream;
  } });
  return {
    transport, calls, streams, timers, reply, sandbox,
    get current() { return current; }, get time() { return time; }, setTime(value) { time = value; },
    update(extra) { current = snapshot(extra); return current; }, makeSnapshot: snapshot,
    openWith(fn) { openHandler = fn; }, commandWith(fn) { commandHandler = fn; }, queryWith(fn) { queryHandler = fn; },
    deliver(value = current, stream = streams.at(-1)) { stream.snapshot({ data: JSON.stringify(value) }); },
    async flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); },
    async runTimer() { const [id, timer] = [...timers].sort((a, b) => a[1].delay - b[1].delay)[0] || []; if (timer) { timers.delete(id); await timer.fn(); } },
  };
}

test('browser transport uses only restricted same-origin APIs, has no storage or global API-base mutation', async () => {
  const b = browser(), seen = []; const unsubscribe = b.transport.subscribe((value) => seen.push(value));
  try {
    assert.equal((await b.transport.status()).active, null);
    assert.equal((await b.transport.list()).length, 2);
    const state = await b.transport.open('remote-a'); assert.equal(state.canControl, true);
    await b.transport.history();
    const sent = await b.transport.sendText('/plain-text', 'browser-text'); assert.equal(sent.status, 'received');
    const call = b.calls.find((entry) => entry.url.endsWith('/command'));
    assert.deepEqual(call.body.payload, { text: '/plain-text' }); assert.equal(call.body.binding.toDeviceId, 'tablet'); assert.equal(call.body.generation, state.generation);
    assert.ok(!('api' in b.sandbox)); assert.ok(!('API_BASE' in b.sandbox));
    assert.ok(Object.isFrozen(seen.at(-1)));
    await b.transport.close(); assert.equal(seen.at(-1).active, null);
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser feature requests and SSE keep the activation captured at transport creation', async () => {
  const b = browser(), activationId = '11111111-1111-4111-8111-111111111111', requests = [], streams = [];
  const transport = b.sandbox.createRemoteTransport({ activationId, now: () => b.time,
    fetch: async (url, options) => { requests.push({ url, options }); return b.reply({ snapshot: b.current }); },
    eventSource: (url) => { streams.push(url); return { addEventListener() {}, close() {} }; },
  });
  const off = transport.subscribe(() => {});
  try {
    await transport.status(); await transport.list(); await transport.close();
    assert.deepEqual(requests.map((call) => call.url), ['status', 'sessions', 'close'].map((name) => '/api/remote/' + name + '?activation=' + activationId));
    assert.ok(streams.length >= 1); assert.ok(streams.every((url) => url === '/api/remote/events?activation=' + activationId));
    assert.ok(requests.every(({ options }) => options.credentials === 'same-origin' && options.redirect === 'error'));
  } finally { off(); transport.destroy(); b.transport.destroy(); }
});

test('browser reuses detached frozen snapshots for status and new subscribers, exact duplicates do not emit', async () => {
  const b = browser(), seen = [];
  const off = b.transport.subscribe((value) => seen.push(value)); let extraOff;
  try {
    const opened = await b.transport.open('remote-a'), notifications = seen.length;
    assert.strictEqual(opened, seen.at(-1));
    assert.strictEqual(await b.transport.status(), opened); assert.equal(seen.length, notifications);
    let extra;
    extraOff = b.transport.subscribe((value) => { extra = value; });
    assert.strictEqual(extra, opened, 'new listeners share the cached immutable value');
    const reordered = Object.fromEntries(Object.entries(b.current).reverse());
    b.deliver(reordered); assert.equal(seen.length, notifications); assert.strictEqual(extra, opened);
    assert.ok(Object.isFrozen(opened)); assert.ok(Object.isFrozen(opened.items[0])); assert.ok(Object.isFrozen(opened.pending));
    assert.throws(() => { opened.items[0].text = 'mutate'; }, TypeError);
    b.current.items[0].text = 'detached fixture mutation';
    assert.notEqual(opened.items[0].text, b.current.items[0].text);
    b.deliver();
    const changed = seen.at(-1); assert.notStrictEqual(changed, opened); assert.equal(changed.items[0].text, 'detached fixture mutation');
    assert.equal(seen.length, notifications + 1, 'same revision with a real content change must still emit');
    b.transport.setDraft('Local draft');
    const drafted = seen.at(-1), afterDraft = seen.length;
    assert.notStrictEqual(drafted, changed); assert.equal(drafted.draft, 'Local draft'); assert.equal(changed.draft, '');
    assert.strictEqual(await b.transport.status(), drafted);
    b.transport.setDraft('Local draft'); b.deliver(); assert.equal(seen.length, afterDraft);
    const sent = await b.transport.sendText('Receipt invalidates snapshot', 'cache-receipt');
    assert.equal(sent.status, 'received'); assert.notStrictEqual(seen.at(-1), drafted);
    assert.equal(seen.at(-1).receipts.find((entry) => entry.commandId === 'cache-receipt').status, 'received');
  } finally { extraOff?.(); off(); b.transport.destroy(); }
});

test('browser snapshot cache invalidates without listeners and never returns a pre-draft value', async () => {
  const b = browser(); let latest;
  try {
    const first = await b.transport.open('remote-a');
    b.transport.setDraft('No listener yet');
    const next = await b.transport.status();
    assert.notStrictEqual(next, first); assert.equal(next.draft, 'No listener yet'); assert.equal(first.draft, '');
    const off = b.transport.subscribe((value) => { latest = value; });
    assert.strictEqual(latest, next); off();
    await b.transport.close();
    const closed = await b.transport.status(); assert.equal(closed.active, null); assert.equal(closed.draft, '');
    assert.notStrictEqual(closed, next);
  } finally { b.transport.destroy(); }
});

test('browser cached duplicate comparison preserves same-revision offline recovery checks and validation', async () => {
  const b = browser(), seen = []; const off = b.transport.subscribe((value) => seen.push(value));
  try {
    await b.transport.open('remote-a');
    const online = clone(b.current), count = seen.length;
    b.deliver(online); assert.equal(seen.length, count);
    b.streams.at(-1).onerror();
    const offline = seen.at(-1), offlineCount = seen.length;
    assert.equal(offline.canControl, false); assert.notStrictEqual(offline, seen.at(-2));
    const blocked = await b.transport.status();
    assert.strictEqual(blocked, offline); assert.equal(seen.length, offlineCount, 'ordinary same-revision status cannot recover local offline');
    await b.runTimer();
    assert.equal(seen.at(-1).canControl, true); assert.equal(seen.at(-1).revision, online.revision);
    assert.notStrictEqual(seen.at(-1), offline, 'verified retry emits even at the same backend revision');
    const recoveredCount = seen.length;
    b.deliver(online); assert.equal(seen.length, recoveredCount);
    b.deliver({ ...online, pending: [{ ...online.pending[0], runId: 'wrong-run' }] });
    assert.equal(seen.at(-1).canControl, false); assert.equal(seen.at(-1).error, 'RESYNC_REQUIRED');
  } finally { off(); b.transport.destroy(); }
});

test('browser repeated snapshot does not disarm a clamped grant expiry and late errors cannot erase terminal state', async () => {
  const b = browser(); let latest; const off = b.transport.subscribe((value) => { latest = value; });
  try {
    const expiresAt = NOW + 2_147_483_647 + 5000;
    b.openWith(() => b.reply({ snapshot: b.update({ grant: { state: 'active', expiresAt } }) }));
    await b.transport.open('remote-a'); const first = latest;
    b.deliver(); assert.strictEqual(latest, first);
    b.setTime(NOW + 2_147_483_647); await b.runTimer();
    assert.equal(latest.phase, 'ready'); assert.strictEqual(latest, first);
    assert.ok([...b.timers.values()].some((timer) => timer.delay === 5000), 'a clamped expiry re-arms independently of duplicate suppression');
    b.transport.setDraft('Temporary'); b.setTime(expiresAt + 1); await b.runTimer();
    assert.equal(latest.phase, 'expired'); assert.equal(latest.cached, false); assert.equal(latest.draft, '');
    assert.equal(latest.streamId, null); assert.equal(latest.seq, 0); assert.equal(latest.historyCursor, null); assert.equal(latest.historyHasMore, false);
    const expired = latest;
    b.streams.at(-1).onerror(); assert.strictEqual(latest, expired); assert.equal(latest.phase, 'expired');
  } finally { off(); b.transport.destroy(); }
});

test('browser boot subscription permits only the empty unconfigured sentinel to acquire a local device identity', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    b.deliver(b.update({ deviceId: 'remote-unconfigured', connection: 'offline', sessions: [] }));
    assert.equal(latest.deviceId, 'remote-unconfigured');
    b.deliver(b.update()); assert.equal(latest.deviceId, 'phone'); assert.equal(latest.sessions.length, 2);
    b.deliver(b.update({ deviceId: 'other-phone' }));
    assert.equal(latest.deviceId, 'phone'); assert.equal(latest.error, 'RESYNC_REQUIRED');
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser explicit accept/decline use only their restricted routes and clear selected invitation state', async () => {
  const b = browser();
  try {
    const accepted = await b.transport.accept('remote-a'); assert.equal(accepted.active.remoteSessionId, 'remote-a');
    assert.equal(b.calls.at(-1).url, '/api/remote/accept'); assert.deepEqual(b.calls.at(-1).body, { remoteSessionId: 'remote-a' });
    b.transport.setDraft('Clear on invitation exit');
    const declined = await b.transport.decline('remote-a'); assert.equal(declined.active, null); assert.equal(b.transport.getDraft(), '');
    assert.equal(b.calls.at(-1).url, '/api/remote/decline'); assert.deepEqual(b.calls.at(-1).body, { remoteSessionId: 'remote-a' });
    assert.equal(b.calls.some((call) => call.url.endsWith('/command')), false);
  } finally { b.transport.destroy(); }
});

test('browser disconnect preserves memory draft but does not queue sends/respond/stop, onopen cannot unlock', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    await b.transport.open('remote-a'); b.transport.setDraft('Offline text');
    b.streams.at(-1).onerror();
    assert.equal(latest.canControl, false); assert.equal(latest.cached, true); assert.equal(b.transport.getDraft(), 'Offline text');
    const count = b.calls.length;
    await assert.rejects(b.transport.sendText('Offline text', 'offline'), hasCode('OFFLINE'));
    await assert.rejects(b.transport.respond('request-1', { kind: 'permission', decision: 'allow' }), hasCode('OFFLINE'));
    await assert.rejects(b.transport.stop(), hasCode('OFFLINE'));
    assert.equal(b.calls.length, count);
    b.update({ phase: 'syncing', verified: false, canControl: false });
    await b.runTimer(); assert.equal(latest.canControl, false);
    assert.equal(b.streams.at(-1).onopen, undefined);
    b.deliver(b.update({ pending: [] })); assert.equal(latest.canControl, true); assert.equal(latest.pending.length, 0);
    assert.equal(b.transport.getDraft(), 'Offline text');
    await b.transport.close(); assert.equal(b.transport.getDraft(), '');
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser stable command IDs deduplicate concurrent clicks and timeout outcomes are queried without resend', async () => {
  const b = browser();
  try {
    await b.transport.open('remote-a');
    const wait = deferred(); b.commandWith(() => wait.promise);
    const first = b.transport.sendText('One message', 'browser-stable'), duplicate = b.transport.sendText('One message', 'browser-stable');
    assert.equal(b.calls.filter((entry) => entry.url.endsWith('/command')).length, 1);
    wait.reject(new Error('Synthetic timeout'));
    assert.equal((await first).status, 'unknown'); assert.equal((await duplicate).status, 'unknown');
    assert.equal((await b.transport.sendText('One message', 'browser-stable')).status, 'unknown');
    await assert.rejects(b.transport.sendText('Changed', 'browser-stable'), hasCode('COMMAND_CONFLICT'));
    assert.equal((await b.transport.query('browser-stable')).status, 'unknown');
    b.queryWith((call) => b.reply({ snapshot: b.update(), receipt: { commandId: call.body.commandId, type: 'message.submit', status: 'applied', result: { kind: 'message', delivery: 'accepted' }, updatedAt: NOW } }));
    assert.equal((await b.transport.query('browser-stable')).status, 'applied');
    assert.equal((await b.transport.sendText('One message', 'browser-stable')).status, 'applied');
    assert.equal(b.calls.filter((entry) => entry.url.endsWith('/command')).length, 1);
    const query = b.calls.find((entry) => entry.url.endsWith('/query'));
    assert.equal(query.body.commandId, 'browser-stable');
    await b.transport.query('prior-app-command');
    await assert.rejects(b.transport.sendText('Do not replay after reload', 'prior-app-command'), hasCode('COMMAND_UNKNOWN'));
  } finally { b.transport.destroy(); }
});

test('browser stale open/HTTP/event replies cannot cross the selected device/session generation', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    const wait = deferred(); let oldState;
    b.openWith((call) => {
      const value = b.makeSnapshot();
      if (call.body.remoteSessionId === 'remote-a') { oldState = value; return wait.promise; }
      return b.reply({ snapshot: value });
    });
    const old = b.transport.open('remote-a').catch((cause) => cause);
    await b.transport.open('remote-b'); wait.resolve(b.reply({ snapshot: oldState }));
    assert.equal((await old).code, 'RESYNC_REQUIRED'); assert.equal(latest.active.remoteSessionId, 'remote-b');
    const stream = b.streams.at(-1);
    b.deliver(oldState, stream); assert.equal(latest.active.remoteSessionId, 'remote-b'); assert.equal(latest.canControl, true);
    const current = b.makeSnapshot({ active: { remoteSessionId: 'remote-b', deviceId: 'other-tablet' }, binding: binding('remote-b', { toDeviceId: 'other-tablet' }) });
    b.deliver(current, stream); assert.equal(latest.canControl, false); assert.equal(latest.active.deviceId, 'tablet');
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser close/revoke/expiry clears transient content and cannot display stopped for only a receipt ACK', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    await b.transport.open('remote-a');
    const stopped = await b.transport.stop('browser-stop'); assert.equal(stopped.status, 'received'); assert.equal(latest.run.state, 'waiting');
    b.transport.setDraft('Temporary');
    const revokedSnapshot = b.update({ phase: 'revoked', grant: { state: 'revoked', expiresAt: NOW }, binding: null, run: null, items: [], pending: [], receipts: [], verified: false, canControl: false });
    b.deliver(revokedSnapshot);
    assert.equal(b.transport.getDraft(), ''); assert.equal(latest.items.length, 0); assert.equal(latest.canControl, false);
    const revoked = latest;
    b.deliver(revokedSnapshot); assert.strictEqual(latest, revoked, 'normalized terminal duplicates do not emit');
    b.streams.at(-1).onerror(); assert.strictEqual(latest, revoked, 'a late transport error cannot replace revocation');
    await b.transport.open('remote-a'); b.transport.setDraft('Expires'); b.setTime(NOW + 600_001);
    await b.runTimer(); assert.equal(latest.phase, 'expired'); assert.equal(latest.items.length, 0); assert.equal(b.transport.getDraft(), '');
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser backend unpair reset removes stale view content/draft and never selects another session', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    await b.transport.open('remote-a'); b.transport.setDraft('Temporary remote content');
    b.deliver(b.update({ generation: b.current.generation + 1, active: null, binding: null, grant: null, run: null, phase: 'idle', verified: false, canControl: false, sessions: [], pending: [], items: [], receipts: [] }));
    assert.equal(latest.active, null); assert.equal(latest.items.length, 0); assert.equal(latest.pending.length, 0); assert.equal(b.transport.getDraft(), '');
    await assert.rejects(b.transport.sendText('Must remain offline'), hasCode('RESYNC_REQUIRED'));
  } finally { unsubscribe(); b.transport.destroy(); }
});

test('browser cache/schema and large text boundaries fail closed without calling other local routes', async () => {
  const b = browser(); let latest; const unsubscribe = b.transport.subscribe((value) => { latest = value; });
  try {
    await b.transport.open('remote-a');
    await assert.rejects(b.transport.sendText('x'.repeat(16 * 1024 + 1)), hasCode('INVALID_SCHEMA'));
    await assert.rejects(b.transport.respond('request-1', { kind: 'permission', decision: 'allow', always: true }), hasCode('INVALID_SCHEMA'));
    assert.throws(() => b.transport.setDraft('x'.repeat(16 * 1024 + 1)), hasCode('LIMIT_EXCEEDED'));
    const count = b.calls.length;
    b.deliver(b.update({ items: Array.from({ length: 501 }, (_, i) => ({ id: 'item-' + i, text: 'Fixture' })) }));
    assert.equal(latest.canControl, false); assert.ok(latest.items.length <= 500); assert.equal(b.calls.length, count);
    assert.ok(b.calls.every((call) => call.url.startsWith('/api/remote/')));
    assert.equal(PHONE_LIMITS.CACHE_BYTES, 512 * 1024);
  } finally { unsubscribe(); b.transport.destroy(); }
});

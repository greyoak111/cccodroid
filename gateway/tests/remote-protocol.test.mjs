// Pure fixtures only; the normal runner supplies an isolated HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, LIMITS, ERROR_CODES, ProtocolError,
  createFrame, validateFrame, parseFrame, assertBinding, assertCorrelation,
  receiptTransition, grantTransition, commandFingerprint, createCommandLedger,
} from '../gw/remote/protocol.mjs';

const NOW = 1_800_000_000_000;
const binding = Object.freeze({ fromDeviceId: 'phone-fixture', toDeviceId: 'tablet-fixture', hostInstanceId: 'host-fixture', remoteSessionId: 'remote-fixture', grantVersion: 1, runId: 'run-fixture' });
const grant = Object.freeze({ hostDeviceId: binding.toDeviceId, phoneDeviceId: binding.fromDeviceId, hostInstanceId: binding.hostInstanceId, remoteSessionId: binding.remoteSessionId, grantVersion: binding.grantVersion, runId: binding.runId, state: 'active', expiresAt: NOW + 3_600_000 });
const request = Object.freeze({ requestId: 'request-fixture', requestVersion: 1, runId: binding.runId, state: 'pending', kind: 'permission', detailsComplete: true, expiresAt: NOW + 30_000 });
const options = (commandId = 'command-fixture') => ({ now: NOW, commandId, messageId: 'frame-fixture' });
const message = (text = 'fixture text', commandId) => createFrame('message.submit', binding, { text }, options(commandId));
const respond = (response = { kind: 'permission', decision: 'allow' }) => createFrame('request.respond', binding, { requestId: request.requestId, requestVersion: request.requestVersion, response }, options());
const clone = (value) => JSON.parse(JSON.stringify(value));
const code = (fn, expected) => assert.throws(fn, (error) => error instanceof ProtocolError && error.code === expected, expected);
const reverseBinding = Object.freeze({ ...binding, fromDeviceId: binding.toDeviceId, toDeviceId: binding.fromDeviceId });
const dataOptions = (correlationId) => ({ now: NOW, messageId: 'data-frame-fixture', ...(correlationId ? { correlationId } : {}) });
const requestRecord = (changes = {}) => ({ ...request, kind: 'permission', toolName: 'Bash', summary: 'fixture action', detailText: 'fixture complete command scope', ...changes });
const item = (id = 'record-fixture') => ({ id, kind: 'message', role: 'assistant', text: 'fixture reply', source: 'host', timestamp: NOW });
const question = () => ({ questionId: 'question-fixture', question: 'Choose a fixture option', header: 'Fixture', multiSelect: false, options: [{ optionId: 'option-fixture', label: 'One', description: 'Fixture description' }] });
const snapshotPayload = () => ({ streamId: 'stream-fixture', seq: 0, title: 'Fixture session', grant: { state: 'active', expiresAt: grant.expiresAt }, run: { runId: binding.runId, state: 'waiting' }, pending: [requestRecord()], items: [item()], historyCursor: null, historyHasMore: false });
const snapshotFrame = (payload = snapshotPayload(), correlationId) => createFrame('session.snapshot', reverseBinding, payload, dataOptions(correlationId));
const historyPage = (changes = {}) => ({ streamId: 'stream-fixture', seq: 0, items: [item()], cursor: null, nextCursor: null, hasMore: false, ...changes });

test('component release and revoke acknowledgement bind exact authority and cannot carry controls', () => {
  const release = createFrame('host.release', binding, {}, dataOptions('release-rpc'));
  const released = createFrame('host.released', reverseBinding, {}, dataOptions('release-rpc'));
  assert.equal(assertBinding(release, grant, { now: NOW }), true);
  assert.equal(assertCorrelation(released, release, { now: NOW }), true);
  code(() => createFrame('host.release', binding, { stop: true }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
  code(() => assertBinding(release, { ...grant, state: 'revoked' }, { now: NOW }), ERROR_CODES.GRANT_REVOKED);
  code(() => assertBinding(createFrame('host.release', reverseBinding, {}, dataOptions()), grant, { now: NOW }), ERROR_CODES.DEVICE_MISMATCH);
  const revoke = createFrame('host.revoke', reverseBinding, { reason: 'revoked' }, dataOptions('revoke-rpc'));
  const ack = createFrame('host.revoked', binding, {}, dataOptions('revoke-rpc'));
  assert.equal(assertCorrelation(ack, revoke, { now: NOW }), true);
  code(() => assertCorrelation(createFrame('host.revoked', { ...binding, runId: 'wrong-run' }, {}, dataOptions('revoke-rpc')), revoke, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
  code(() => createFrame('host.revoked', binding, { success: true }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
});

test('v1 factory produces detached deeply immutable JSON and explicit binding', () => {
  const source = { text: '/fixture slash remains literal text' };
  const frame = createFrame('message.submit', binding, source, options());
  source.text = 'changed after validation';
  assert.equal(frame.v, PROTOCOL_VERSION);
  assert.equal(frame.payload.text, '/fixture slash remains literal text');
  assert.equal(frame.issuedAt, NOW);
  assert.equal(frame.expiresAt, NOW + LIMITS.CONTROL_TTL_MS);
  assert.ok(Object.isFrozen(frame));
  assert.ok(Object.isFrozen(frame.payload));
  assert.throws(() => { frame.payload.text = 'mutate'; }, TypeError);
  assert.equal(parseFrame(Buffer.from(JSON.stringify(frame)), { now: NOW }).commandId, frame.commandId);
});

test('strict schema rejects missing and unsupported version/type', () => {
  const frame = clone(message());
  delete frame.payload;
  code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  code(() => validateFrame({ ...message(), v: 2 }, { now: NOW }), ERROR_CODES.UNSUPPORTED_VERSION);
  code(() => validateFrame({ ...message(), type: 'shell.exec' }, { now: NOW }), ERROR_CODES.UNSUPPORTED_TYPE);
});

for (const [name, change] of [
  ['top-level URL proxy', (f) => { f.url = 'https://fixture.invalid'; }],
  ['top-level local session ID', (f) => { f.sessionId = 'local-secret'; }],
  ['model configuration', (f) => { f.payload.model = 'fixture'; }],
  ['working directory', (f) => { f.payload.cwd = '/fixture'; }],
  ['tool input', (f) => { f.payload.input = { command: 'fixture' }; }],
  ['environment', (f) => { f.payload.env = {}; }],
  ['attachment', (f) => { f.payload.attachments = []; }],
]) {
  test(`unknown capability rejected: ${name}`, () => {
    const frame = clone(message());
    change(frame);
    code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  });
}

test('text uses UTF-8 byte limits, not JS string count', () => {
  assert.equal(message('a'.repeat(LIMITS.TEXT_BYTES)).payload.text.length, LIMITS.TEXT_BYTES);
  code(() => message('a'.repeat(LIMITS.TEXT_BYTES + 1)), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => message('界'.repeat(5_462)), ERROR_CODES.LIMIT_EXCEEDED);
  for (const text of ['', '   ', '\u0000']) code(() => message(text), ERROR_CODES.INVALID_SCHEMA);
});

test('raw frame is bounded before JSON decode and requires valid UTF-8', () => {
  code(() => parseFrame(' '.repeat(LIMITS.FRAME_BYTES + 1)), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => parseFrame(new Uint8Array(LIMITS.FRAME_BYTES + 1)), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => parseFrame(Buffer.from([0xc3, 0x28])), ERROR_CODES.INVALID_SCHEMA);
  code(() => parseFrame('{broken'), ERROR_CODES.INVALID_SCHEMA);
  code(() => parseFrame(1), ERROR_CODES.INVALID_SCHEMA);
});

test('in-memory boundary refuses accessors, prototypes, cycles, undefined and sparse arrays', () => {
  let getterCalled = false;
  const accessor = { ...message() };
  Object.defineProperty(accessor, 'payload', { enumerable: true, get() { getterCalled = true; return {}; } });
  code(() => validateFrame(accessor, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  assert.equal(getterCalled, false);
  const circular = clone(message()); circular.payload.extra = circular;
  code(() => validateFrame(circular, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  code(() => validateFrame({ ...message(), payload: new Date() }, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  code(() => validateFrame({ ...message(), payload: { text: undefined } }, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  const polluted = JSON.parse(JSON.stringify(message()).replace('"payload":', '"__proto__":{},"payload":'));
  code(() => validateFrame(polluted, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  const holes = respond({ kind: 'question', answers: [{ questionId: 'q1', optionIds: ['a'] }] });
  const sparse = clone(holes); sparse.payload.response.answers[0].optionIds = Array(1);
  code(() => validateFrame(sparse, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  const extraIndex = clone(holes); const arrayWithProperty = [];
  arrayWithProperty['4294967295'] = 'not-an-array-index';
  extraIndex.payload.response.answers[0].optionIds = arrayWithProperty;
  code(() => validateFrame(extraIndex, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
});

test('schema budgets bound deeply nested or huge object inputs', () => {
  const frame = clone(message());
  let p = frame.payload;
  for (let i = 0; i < LIMITS.MAX_DEPTH + 1; i++) p = p.extra = {};
  code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.LIMIT_EXCEEDED);
});

test('expiration is strict at deadline; future issue time has a small bounded tolerance', () => {
  const frame = message();
  code(() => validateFrame(frame, { now: frame.expiresAt }), ERROR_CODES.EXPIRED);
  assert.ok(validateFrame(frame, { now: frame.expiresAt - 1 }));
  code(() => validateFrame(frame, { now: NOW - LIMITS.CLOCK_SKEW_MS - 1 }), ERROR_CODES.NOT_YET_VALID);
  assert.ok(validateFrame(frame, { now: NOW - LIMITS.CLOCK_SKEW_MS }));
  code(() => validateFrame({ ...frame, expiresAt: NOW }, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  code(() => validateFrame({ ...frame, expiresAt: NOW + LIMITS.CONTROL_TTL_MS + 1 }, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
  code(() => createFrame('message.submit', binding, { text: 'fixture' }, { ...options(), ttlMs: LIMITS.CONTROL_TTL_MS + 1 }), ERROR_CODES.LIMIT_EXCEEDED);
});

for (const [field, value, expected] of [
  ['fromDeviceId', 'different-phone', ERROR_CODES.DEVICE_MISMATCH],
  ['toDeviceId', 'different-tablet', ERROR_CODES.DEVICE_MISMATCH],
  ['hostInstanceId', 'restarted-host', ERROR_CODES.HOST_INSTANCE_MISMATCH],
  ['remoteSessionId', 'other-session', ERROR_CODES.SESSION_MISMATCH],
  ['grantVersion', 2, ERROR_CODES.GRANT_MISMATCH],
  ['runId', 'old-run', ERROR_CODES.RUN_MISMATCH],
]) {
  test(`binding rejects ${field} mismatch`, () => {
    const frame = { ...message(), [field]: value };
    code(() => validateFrame(frame, { now: NOW, expected: binding }), expected);
    code(() => assertBinding(frame, grant, { now: NOW }), expected);
  });
}

test('binding checks active authority, expiry and routing direction', () => {
  assert.equal(assertBinding(message(), grant, { now: NOW }), true);
  code(() => assertBinding(message(), { ...grant, state: 'revoked' }, { now: NOW }), ERROR_CODES.GRANT_REVOKED);
  code(() => assertBinding(message(), { ...grant, state: 'invited' }, { now: NOW }), ERROR_CODES.GRANT_NOT_ACTIVE);
  code(() => assertBinding(message(), { ...grant, expiresAt: NOW }, { now: NOW }), ERROR_CODES.EXPIRED);
  code(() => assertBinding(message(), grant, { now: NOW, direction: 'toPhone' }), ERROR_CODES.DEVICE_MISMATCH);
});

test('stop and request cannot target null run, while idle text can', () => {
  const idle = { ...binding, runId: null };
  assert.equal(createFrame('message.submit', idle, { text: 'next turn' }, options()).runId, null);
  code(() => createFrame('run.stop', idle, {}, options()), ERROR_CODES.RUN_MISMATCH);
  code(() => createFrame('request.respond', idle, respond().payload, options()), ERROR_CODES.RUN_MISMATCH);
});

test('request binding rejects stale version, different request/run, expiry, processed request and partial details', () => {
  const frame = respond();
  assert.equal(assertBinding(frame, grant, { now: NOW, request }), true);
  code(() => assertBinding(frame, grant, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  for (const current of [{ ...request, requestId: 'other-request' }, { ...request, requestVersion: 2 }, { ...request, runId: 'other-run' }]) {
    code(() => assertBinding(frame, grant, { now: NOW, request: current }), ERROR_CODES.REQUEST_MISMATCH);
  }
  code(() => assertBinding(frame, grant, { now: NOW, request: { ...request, expiresAt: NOW } }), ERROR_CODES.REQUEST_EXPIRED);
  code(() => assertBinding(frame, grant, { now: NOW, request: { ...request, state: 'closed' } }), ERROR_CODES.REQUEST_CLOSED);
  code(() => assertBinding(frame, grant, { now: NOW, request: { ...request, detailsComplete: false } }), ERROR_CODES.DETAILS_INCOMPLETE);
  assert.equal(assertBinding(respond({ kind: 'permission', decision: 'deny', reason: 'fixture denial' }), grant, { now: NOW, request: { ...request, detailsComplete: false } }), true);
});

test('remote response cannot alter original tool input, permanent rules or permission mode', () => {
  for (const forbidden of ['always', 'mode', 'updatedInput', 'updatedPermissions', 'interrupt', 'input']) {
    const frame = clone(respond()); frame.payload.response[forbidden] = true;
    code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  }
  code(() => respond({ kind: 'permission', decision: 'allowAll' }), ERROR_CODES.INVALID_SCHEMA);
});

test('questions support scoped option IDs and free text, not arbitrary answer objects', () => {
  assert.ok(respond({ kind: 'question', answers: [{ questionId: 'q1', optionIds: ['option1'], text: 'extra fixture' }] }));
  code(() => respond({ kind: 'question', answers: [{ questionId: 'q1', optionIds: [] }] }), ERROR_CODES.INVALID_SCHEMA);
  code(() => respond({ kind: 'question', answers: [{ questionId: 'q1', optionIds: ['a', 'a'] }] }), ERROR_CODES.INVALID_SCHEMA);
  code(() => respond({ kind: 'question', answers: [{ questionId: 'q1', optionIds: ['a'] }, { questionId: 'q1', optionIds: ['b'] }] }), ERROR_CODES.INVALID_SCHEMA);
  code(() => respond({ kind: 'question', answers: { 'original question': 'injected' } }), ERROR_CODES.INVALID_SCHEMA);
});

test('plan approval is one response, never changes ongoing execution policy', () => {
  assert.ok(respond({ kind: 'plan', decision: 'approve' }));
  assert.ok(respond({ kind: 'plan', decision: 'reject', reason: 'revise fixture plan' }));
  code(() => respond({ kind: 'plan', decision: 'approve', mode: 'bypassPermissions' }), ERROR_CODES.UNKNOWN_FIELD);
  code(() => assertBinding(respond({ kind: 'plan', decision: 'approve' }), grant, { now: NOW, request: { ...request, kind: 'plan', detailsComplete: false } }), ERROR_CODES.DETAILS_INCOMPLETE);
});

test('receipts distinguish received from applied and constrain verifiable results', () => {
  const receipt = (payload) => createFrame('control.receipt', { ...binding, fromDeviceId: binding.toDeviceId, toDeviceId: binding.fromDeviceId }, payload, options());
  assert.ok(receipt({ status: 'received' }));
  assert.ok(receipt({ status: 'applied', result: { kind: 'message', delivery: 'queued' } }));
  assert.ok(receipt({ status: 'applied', result: { kind: 'stop', runState: 'stopped' } }));
  assert.ok(receipt({ status: 'rejected', code: ERROR_CODES.GRANT_REVOKED }));
  assert.ok(receipt({ status: 'unknown' }));
  code(() => receipt({ status: 'applied' }), ERROR_CODES.INVALID_SCHEMA);
  code(() => receipt({ status: 'received', result: { kind: 'stop', runState: 'stopped' } }), ERROR_CODES.INVALID_SCHEMA);
  code(() => receipt({ status: 'applied', result: { kind: 'stop', runState: 'stopping' } }), ERROR_CODES.INVALID_SCHEMA);
  code(() => receipt({ status: 'rejected', code: 'arbitrary-error-secret' }), ERROR_CODES.INVALID_SCHEMA);
  code(() => receipt({ status: 'applied', result: { kind: 'message', delivery: 'accepted', output: 'arbitrary data' } }), ERROR_CODES.UNKNOWN_FIELD);
});

test('grant state machine never revives revoked or expired authority', () => {
  assert.equal(grantTransition('none', 'invite'), 'invited');
  assert.equal(grantTransition('invited', 'accept'), 'active');
  assert.equal(grantTransition('active', 'revoke'), 'revoked');
  assert.equal(grantTransition('active', 'expire'), 'expired');
  code(() => grantTransition('revoked', 'accept'), ERROR_CODES.INVALID_TRANSITION);
  code(() => grantTransition('expired', 'invite'), ERROR_CODES.INVALID_TRANSITION);
  code(() => grantTransition('__proto__', 'accept'), ERROR_CODES.INVALID_TRANSITION);
});

test('receipt state machine only permits truthful forward progress and explicit unknown reconciliation', () => {
  assert.equal(receiptTransition(null, 'received'), 'received');
  assert.equal(receiptTransition('received', 'unknown'), 'unknown');
  assert.equal(receiptTransition('unknown', 'applied'), 'applied');
  assert.equal(receiptTransition('received', 'rejected'), 'rejected');
  code(() => receiptTransition(null, 'applied'), ERROR_CODES.INVALID_TRANSITION);
  code(() => receiptTransition('applied', 'received'), ERROR_CODES.INVALID_TRANSITION);
  code(() => receiptTransition('rejected', 'applied'), ERROR_CODES.INVALID_TRANSITION);
  code(() => receiptTransition('unknown', 'received'), ERROR_CODES.INVALID_TRANSITION);
});

test('stable command fingerprint ignores transport ID/time but not operation or authority', () => {
  const first = message();
  const retry = createFrame('message.submit', binding, { text: first.payload.text }, { ...options(), now: NOW + 1_000, messageId: 'retry-fixture' });
  assert.equal(commandFingerprint(first), commandFingerprint(retry));
  assert.notEqual(commandFingerprint(first), commandFingerprint(message('different text')));
  assert.notEqual(commandFingerprint(first), commandFingerprint({ ...first, runId: 'other-run' }));
  code(() => commandFingerprint({ ...first, payload: { text: 'fixture', model: 'injected' } }), ERROR_CODES.UNKNOWN_FIELD);
});

test('ledger deduplicates applied command and rejects reused ID with changed body/binding', () => {
  const ledger = createCommandLedger({ now: () => NOW });
  const frame = message();
  assert.equal(ledger.record(frame).duplicate, false);
  const receipt = ledger.settle(frame.commandId, binding, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } });
  assert.equal(ledger.record(frame).duplicate, true);
  assert.equal(ledger.record(frame).receipt, receipt);
  code(() => ledger.record(message('different operation')), ERROR_CODES.COMMAND_CONFLICT);
  code(() => ledger.record({ ...frame, grantVersion: 2 }), ERROR_CODES.COMMAND_CONFLICT);
  code(() => ledger.get(frame.commandId, { ...binding, remoteSessionId: 'different-session' }), ERROR_CODES.SESSION_MISMATCH);
  assert.equal(ledger.size, 1);
});

test('ledger unknown prevents redispatch and may be reconciled without changing commandId', () => {
  const ledger = createCommandLedger({ now: NOW });
  const frame = message(); ledger.record(frame);
  ledger.markUnknown(frame.commandId, binding);
  assert.equal(ledger.record(frame).duplicate, true);
  assert.equal(ledger.record(frame).receipt.status, 'unknown');
  assert.equal(ledger.get(frame.commandId, binding).status, 'unknown');
  assert.equal(ledger.settle(frame.commandId, binding, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } }).status, 'applied');
  code(() => ledger.markUnknown(frame.commandId, binding), ERROR_CODES.INVALID_TRANSITION);
});

test('ledger never evicts dedup records to fit an unbounded remote command stream', () => {
  const ledger = createCommandLedger({ now: NOW, maxEntries: 1 });
  ledger.record(message());
  code(() => ledger.record(message('second', 'command-two')), ERROR_CODES.LEDGER_FULL);
  assert.equal(ledger.record(message()).duplicate, true);
  code(() => ledger.get('command-fixture'), ERROR_CODES.INVALID_SCHEMA);
  assert.equal(ledger.get('command-unknown', binding), null);
  code(() => ledger.settle('command-unknown', binding, { status: 'unknown' }), ERROR_CODES.COMMAND_UNKNOWN);
});

test('ledger rejects altered terminal details even when status is unchanged', () => {
  const ledger = createCommandLedger({ now: NOW }); ledger.record(message());
  ledger.settle('command-fixture', binding, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } });
  code(() => ledger.settle('command-fixture', binding, { status: 'applied', result: { kind: 'message', delivery: 'queued' } }), ERROR_CODES.COMMAND_CONFLICT);
});

test('ledger terminal receipt cannot change details or claim result for another operation', () => {
  const ledger = createCommandLedger({ now: NOW });
  const frame = respond(); ledger.record(frame);
  code(() => ledger.settle(frame.commandId, binding, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } }), ERROR_CODES.INVALID_SCHEMA);
  code(() => ledger.settle(frame.commandId, binding, { status: 'applied', result: { kind: 'request', requestId: 'other', requestVersion: 1 } }), ERROR_CODES.REQUEST_MISMATCH);
  const payload = { status: 'applied', result: { kind: 'request', requestId: request.requestId, requestVersion: 1 } };
  const applied = ledger.settle(frame.commandId, binding, payload);
  assert.equal(ledger.settle(frame.commandId, binding, payload), applied);
  code(() => ledger.settle(frame.commandId, binding, { status: 'rejected', code: ERROR_CODES.REQUEST_CLOSED }), ERROR_CODES.INVALID_TRANSITION);
});

test('binding validation cannot be used alone to admit unknown capabilities', () => {
  const frame = clone(message()); frame.payload.url = 'https://fixture.invalid';
  code(() => assertBinding(frame, grant, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  const reverse = { ...binding, fromDeviceId: binding.toDeviceId, toDeviceId: binding.fromDeviceId };
  const control = createFrame('message.submit', reverse, { text: 'wrong direction' }, options());
  code(() => assertBinding(control, grant, { now: NOW, direction: 'toPhone' }), ERROR_CODES.FORBIDDEN);
  const receipt = createFrame('control.receipt', binding, { status: 'received' }, options());
  code(() => assertBinding(receipt, grant, { now: NOW }), ERROR_CODES.FORBIDDEN);
});

test('full serialized frame limit includes escaping and envelope fields, not just text bytes', () => {
  code(() => message('\u0001'.repeat(LIMITS.TEXT_BYTES)), ERROR_CODES.LIMIT_EXCEEDED);
});

test('all identity fields reject ambiguous paths and local URLs', () => {
  for (const value of ['', '../fixture', '/api/chat', 'https://fixture.invalid', 'id with space', '界', 'a'.repeat(129)]) {
    code(() => createFrame('message.submit', { ...binding, remoteSessionId: value }, { text: 'fixture' }, options()), ERROR_CODES.INVALID_SCHEMA);
  }
  code(() => createFrame('message.submit', { ...binding, toDeviceId: binding.fromDeviceId }, { text: 'fixture' }, options()), ERROR_CODES.INVALID_SCHEMA);
  code(() => createFrame('message.submit', { ...binding, grantVersion: 0 }, { text: 'fixture' }, options()), ERROR_CODES.INVALID_SCHEMA);
  code(() => createFrame('message.submit', binding, { text: 'fixture' }, { now: NOW }), ERROR_CODES.INVALID_SCHEMA);
});

test('in-memory byte budget stops many medium strings before unbounded clone allocation', () => {
  const frame = clone(message());
  frame.payload.extra = Array(100).fill('x'.repeat(4_096));
  code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.LIMIT_EXCEEDED);
});

test('hosting lifecycle payloads expose only invitation and explicit withdrawal', () => {
  const invite = createFrame('host.invite', reverseBinding, { title: 'Fixture', deviceName: 'Fixture tablet', expiresAt: grant.expiresAt }, dataOptions());
  assert.equal(assertBinding(invite, { ...grant, state: 'invited' }, { now: NOW, direction: 'toPhone' }), true);
  assert.ok(createFrame('host.accept', binding, {}, dataOptions()));
  const revoke = createFrame('host.revoke', reverseBinding, { reason: 'unpaired' }, dataOptions());
  assert.equal(assertBinding(revoke, { ...grant, state: 'revoked' }, { now: NOW, direction: 'toPhone' }), true);
  assert.equal(assertBinding(revoke, { ...grant, state: 'expired', expiresAt: NOW }, { now: NOW, direction: 'toPhone' }), true);
  code(() => assertBinding({ ...revoke, remoteSessionId: 'another-session' }, { ...grant, state: 'revoked' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.SESSION_MISMATCH);
  code(() => assertBinding(invite, { ...grant, expiresAt: grant.expiresAt + 1, state: 'invited' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.GRANT_MISMATCH);
  code(() => assertBinding(snapshotFrame(), { ...grant, state: 'revoked' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.GRANT_REVOKED);
  code(() => createFrame('host.invite', reverseBinding, { title: 'Fixture', deviceName: 'Tablet', expiresAt: NOW }, dataOptions()), ERROR_CODES.INVALID_SCHEMA);
  code(() => createFrame('host.accept', binding, { allowTools: true }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
  code(() => createFrame('host.revoke', reverseBinding, { reason: 'stop-task' }, dataOptions()), ERROR_CODES.INVALID_SCHEMA);
});

test('view capabilities are allowlisted and history request has bounded cursor and count', () => {
  assert.ok(createFrame('session.subscribe', binding, {}, dataOptions('rpc-fixture')));
  assert.ok(createFrame('session.unsubscribe', binding, {}, dataOptions()));
  assert.ok(createFrame('history.get', binding, { cursor: null, limit: 50 }, dataOptions('rpc-fixture')));
  code(() => createFrame('history.get', binding, { cursor: null, limit: 51 }, dataOptions()), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => createFrame('history.get', binding, { cursor: 'x'.repeat(1025), limit: 1 }, dataOptions()), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => createFrame('history.get', binding, { cursor: '', limit: 1 }, dataOptions()), ERROR_CODES.INVALID_SCHEMA);
  code(() => createFrame('session.subscribe', binding, { sessionId: 'unhosted-local' }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
  code(() => createFrame('history.content', binding, { path: '/fixture' }, dataOptions()), ERROR_CODES.UNSUPPORTED_TYPE);
});

test('snapshot validates complete bound grant/run/request/display records', () => {
  const frame = snapshotFrame();
  assert.equal(assertBinding(frame, grant, { now: NOW, direction: 'toPhone' }), true);
  assert.ok(Object.isFrozen(frame.payload.pending[0]));
  assert.ok(Object.isFrozen(frame.payload.items[0]));
  const wrongRun = snapshotPayload(); wrongRun.run.runId = 'another-run';
  code(() => snapshotFrame(wrongRun), ERROR_CODES.RUN_MISMATCH);
  const wrongRequest = snapshotPayload(); wrongRequest.pending[0].runId = 'another-run';
  code(() => snapshotFrame(wrongRequest), ERROR_CODES.RUN_MISMATCH);
  const idle = snapshotPayload(); idle.run = { runId: null, state: 'idle' }; idle.pending = [];
  assert.ok(createFrame('session.snapshot', { ...reverseBinding, runId: null }, idle, dataOptions()));
  const badState = snapshotPayload(); badState.run.state = 'idle';
  code(() => snapshotFrame(badState), ERROR_CODES.INVALID_SCHEMA);
  const duplicate = snapshotPayload(); duplicate.items.push(item());
  code(() => snapshotFrame(duplicate), ERROR_CODES.INVALID_SCHEMA);
});

for (const [name, change] of [
  ['grant safety settings', (p) => { p.grant.permissionMode = 'bypassPermissions'; }],
  ['run local session', (p) => { p.run.sessionId = 'local'; }],
  ['record file proxy', (p) => { p.items[0].filePath = '/fixture'; }],
  ['request original tool input', (p) => { p.pending[0].input = { command: 'fixture' }; }],
  ['question command injection', (p) => { p.pending[0] = requestRecord({ kind: 'question', questions: [{ ...question(), command: 'fixture' }] }); }],
]) {
  test(`strict nested data schema rejects ${name}`, () => {
    const payload = snapshotPayload(); change(payload);
    code(() => snapshotFrame(payload), ERROR_CODES.UNKNOWN_FIELD);
  });
}

test('display tool records carry only text projections, not executable argument objects', () => {
  const payload = snapshotPayload();
  payload.items = [{ id: 'tool-fixture', kind: 'tool', toolName: 'Bash', toolStatus: 'done', toolInputText: 'fixture command preview', toolResultText: 'fixture output', truncated: true }];
  assert.ok(snapshotFrame(payload));
  const withInput = clone(payload); withInput.items[0].input = { command: 'fixture' };
  code(() => snapshotFrame(withInput), ERROR_CODES.UNKNOWN_FIELD);
  const wrongKind = clone(payload); wrongKind.items[0].role = 'assistant';
  code(() => snapshotFrame(wrongKind), ERROR_CODES.INVALID_SCHEMA);
  const messageWithTool = snapshotPayload(); messageWithTool.items[0].toolInputText = 'injected';
  code(() => snapshotFrame(messageWithTool), ERROR_CODES.INVALID_SCHEMA);
});

test('request details are capped at 24KiB and completeness cannot be claimed without scope', () => {
  const exactLimit = snapshotPayload(); exactLimit.pending[0].detailText = 'x'.repeat(LIMITS.REQUEST_DETAIL_BYTES);
  assert.ok(snapshotFrame(exactLimit));
  const tooLarge = snapshotPayload(); tooLarge.pending[0].detailText = 'x'.repeat(LIMITS.REQUEST_DETAIL_BYTES + 1);
  code(() => snapshotFrame(tooLarge), ERROR_CODES.LIMIT_EXCEEDED);
  const missing = snapshotPayload(); delete missing.pending[0].detailText;
  code(() => snapshotFrame(missing), ERROR_CODES.INVALID_SCHEMA);
  const incomplete = snapshotPayload(); incomplete.pending = [requestRecord({ kind: 'local', detailsComplete: false })];
  assert.ok(snapshotFrame(incomplete));
  incomplete.pending[0].detailsComplete = true;
  code(() => snapshotFrame(incomplete), ERROR_CODES.INVALID_SCHEMA);
});

test('question presentation has exact IDs/options and no arbitrary answer capability', () => {
  const payload = snapshotPayload(); payload.pending = [requestRecord({ kind: 'question', questions: [question()] })];
  assert.ok(snapshotFrame(payload));
  const duplicateQuestion = clone(payload); duplicateQuestion.pending[0].questions.push(question());
  code(() => snapshotFrame(duplicateQuestion), ERROR_CODES.INVALID_SCHEMA);
  const duplicateOption = clone(payload); duplicateOption.pending[0].questions[0].options.push(question().options[0]);
  code(() => snapshotFrame(duplicateOption), ERROR_CODES.INVALID_SCHEMA);
  const noQuestions = clone(payload); noQuestions.pending[0].questions = [];
  code(() => snapshotFrame(noQuestions), ERROR_CODES.INVALID_SCHEMA);
  const unrelated = snapshotPayload(); unrelated.pending[0].questions = [question()];
  code(() => snapshotFrame(unrelated), ERROR_CODES.INVALID_SCHEMA);
});

test('trusted request response enforces original kind, question options and multi-select', () => {
  const original = requestRecord({ kind: 'question', questions: [question()] });
  const answer = (changes = {}) => respond({ kind: 'question', answers: [{ questionId: 'question-fixture', optionIds: ['option-fixture'], ...changes }] });
  assert.equal(assertBinding(answer(), grant, { now: NOW, request: original }), true);
  assert.equal(assertBinding(answer({ optionIds: [], text: 'Fixture free text' }), grant, { now: NOW, request: original }), true);
  code(() => assertBinding(answer({ questionId: 'different-question' }), grant, { now: NOW, request: original }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => assertBinding(answer({ optionIds: ['foreign-option'] }), grant, { now: NOW, request: original }), ERROR_CODES.REQUEST_MISMATCH);
  const twoOptions = clone(original); twoOptions.questions[0].options.push({ optionId: 'second', label: 'Second' });
  code(() => assertBinding(answer({ optionIds: ['option-fixture', 'second'] }), grant, { now: NOW, request: twoOptions }), ERROR_CODES.REQUEST_MISMATCH);
  const moreQuestions = clone(original); moreQuestions.questions.push({ ...question(), questionId: 'second-question' });
  code(() => assertBinding(answer(), grant, { now: NOW, request: moreQuestions }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => assertBinding(answer(), grant, { now: NOW, request: { ...original, detailsComplete: false } }), ERROR_CODES.DETAILS_INCOMPLETE);
  code(() => assertBinding(respond(), grant, { now: NOW, request: original }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => assertBinding(respond(), grant, { now: NOW, request: { ...request, kind: 'local' } }), ERROR_CODES.FORBIDDEN);
});

test('history pages are bounded and have exact cursor terminal semantics', () => {
  const make = (payload) => createFrame('history.page', reverseBinding, payload, dataOptions());
  assert.ok(make(historyPage({ nextCursor: 'opaque-next', hasMore: true })));
  assert.ok(make(historyPage({ items: Array.from({ length: 50 }, (_, n) => item('record-' + n)) })));
  code(() => make(historyPage({ items: Array.from({ length: 51 }, (_, n) => item('record-' + n)) })), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => make(historyPage({ hasMore: true })), ERROR_CODES.INVALID_SCHEMA);
  code(() => make(historyPage({ cursor: 'same', nextCursor: 'same', hasMore: true })), ERROR_CODES.INVALID_SCHEMA);
  code(() => make(historyPage({ nextCursor: 'unexpected-next' })), ERROR_CODES.INVALID_SCHEMA);
  code(() => make(historyPage({ items: [{ id: 'large-record', kind: 'message', text: 'x'.repeat(LIMITS.RECORD_TEXT_BYTES + 1) }] })), ERROR_CODES.LIMIT_EXCEEDED);
});

test('event batch permits only contiguous snapshot-required invalidations', () => {
  const make = (payload) => createFrame('event.batch', reverseBinding, payload, dataOptions());
  const payload = { streamId: 'stream-fixture', fromSeq: 1, toSeq: 2, events: [{ seq: 1, type: 'snapshot.required', payload: {} }, { seq: 2, type: 'snapshot.required', payload: {} }] };
  assert.ok(make(payload));
  const gap = clone(payload); gap.events[1].seq = 3;
  code(() => make(gap), ERROR_CODES.RESYNC_REQUIRED);
  code(() => make({ ...payload, toSeq: 3 }), ERROR_CODES.RESYNC_REQUIRED);
  const arbitrary = clone(payload); arbitrary.events[0].type = 'shell.exec';
  code(() => make(arbitrary), ERROR_CODES.INVALID_SCHEMA);
  const injected = clone(payload); injected.events[0].payload.command = 'fixture';
  code(() => make(injected), ERROR_CODES.UNKNOWN_FIELD);
  code(() => make({ ...payload, events: [] }), ERROR_CODES.INVALID_SCHEMA);
});

test('view RPC correlation requires exact echo and reverse authority binding', () => {
  const subscribe = createFrame('session.subscribe', binding, {}, dataOptions('rpc-fixture'));
  assert.equal(assertCorrelation(snapshotFrame(snapshotPayload(), 'rpc-fixture'), subscribe, { now: NOW }), true);
  code(() => assertCorrelation(snapshotFrame(), subscribe, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => assertCorrelation(snapshotFrame(snapshotPayload(), 'other-rpc'), subscribe, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  const otherSession = createFrame('session.snapshot', { ...reverseBinding, remoteSessionId: 'different-session' }, snapshotPayload(), dataOptions('rpc-fixture'));
  code(() => assertCorrelation(otherSession, subscribe, { now: NOW }), ERROR_CODES.SESSION_MISMATCH);
  const query = createFrame('history.get', binding, { cursor: 'cursor-fixture', limit: 1 }, dataOptions('history-rpc'));
  const page = createFrame('history.page', reverseBinding, historyPage({ cursor: 'cursor-fixture' }), dataOptions('history-rpc'));
  assert.equal(assertCorrelation(page, query, { now: NOW }), true);
  const wrongCursor = createFrame('history.page', reverseBinding, historyPage(), dataOptions('history-rpc'));
  code(() => assertCorrelation(wrongCursor, query, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  const tooMany = createFrame('history.page', reverseBinding, historyPage({ cursor: 'cursor-fixture', items: [item('one'), item('two')] }), dataOptions('history-rpc'));
  code(() => assertCorrelation(tooMany, query, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
});

test('explicit hosting accept requires correlated tablet snapshot acknowledgement', () => {
  const accept = createFrame('host.accept', binding, {}, dataOptions('accept-rpc'));
  assert.equal(assertBinding(accept, { ...grant, state: 'invited' }, { now: NOW }), true);
  assert.equal(assertCorrelation(snapshotFrame(snapshotPayload(), 'accept-rpc'), accept, { now: NOW }), true);
  code(() => assertCorrelation(snapshotFrame(snapshotPayload(), 'wrong-rpc'), accept, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  const declined = createFrame('host.declined', reverseBinding, {}, dataOptions('accept-rpc'));
  code(() => assertCorrelation(declined, accept, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => assertCorrelation(snapshotFrame(), accept, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  const withoutCorrelation = createFrame('host.accept', binding, {}, dataOptions());
  code(() => assertCorrelation(snapshotFrame(snapshotPayload(), 'accept-rpc'), withoutCorrelation, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
});

test('hosting decline has exact empty request/ack, explicit direction and terminal authority handling', () => {
  const decline = createFrame('host.decline', binding, {}, dataOptions('decline-rpc'));
  const declined = createFrame('host.declined', reverseBinding, {}, dataOptions('decline-rpc'));
  assert.equal(assertBinding(decline, { ...grant, state: 'invited' }, { now: NOW }), true);
  assert.equal(assertBinding(declined, { ...grant, state: 'invited' }, { now: NOW, direction: 'toPhone' }), true);
  assert.equal(assertBinding(declined, { ...grant, state: 'revoked' }, { now: NOW, direction: 'toPhone' }), true);
  assert.equal(assertCorrelation(declined, decline, { now: NOW }), true);
  assert.equal(grantTransition('invited', 'decline'), 'revoked');
  code(() => grantTransition('active', 'decline'), ERROR_CODES.INVALID_TRANSITION);
  code(() => grantTransition('revoked', 'accept'), ERROR_CODES.INVALID_TRANSITION);
  code(() => assertBinding(decline, { ...grant, state: 'revoked' }, { now: NOW }), ERROR_CODES.GRANT_REVOKED);
  code(() => createFrame('host.decline', binding, { stop: true }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
  code(() => createFrame('host.declined', reverseBinding, { success: true }, dataOptions()), ERROR_CODES.UNKNOWN_FIELD);
  code(() => assertCorrelation(snapshotFrame(snapshotPayload(), 'decline-rpc'), decline, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  const wrongDirection = createFrame('host.declined', binding, {}, dataOptions('decline-rpc'));
  code(() => assertBinding(wrongDirection, grant, { now: NOW }), ERROR_CODES.FORBIDDEN);
  const wrongDeclineDirection = createFrame('host.decline', reverseBinding, {}, dataOptions('decline-rpc'));
  code(() => assertBinding(wrongDeclineDirection, grant, { now: NOW, direction: 'toPhone' }), ERROR_CODES.FORBIDDEN);
});

test('only correlated snapshots may announce a changed current run on subscribe or accept', () => {
  const subscribe = createFrame('session.subscribe', binding, {}, dataOptions('current-rpc'));
  const accept = createFrame('host.accept', binding, {}, dataOptions('current-rpc'));
  const payload = snapshotPayload();
  payload.run = { runId: 'new-run', state: 'running' };
  payload.pending = [requestRecord({ runId: 'new-run' })];
  const current = createFrame('session.snapshot', { ...reverseBinding, runId: 'new-run' }, payload, dataOptions('current-rpc'));
  assert.equal(assertCorrelation(current, subscribe, { now: NOW }), true);
  assert.equal(assertCorrelation(current, accept, { now: NOW }), true);
  const idlePayload = snapshotPayload(); idlePayload.run = { runId: null, state: 'idle' }; idlePayload.pending = [];
  const idle = createFrame('session.snapshot', { ...reverseBinding, runId: null }, idlePayload, dataOptions('current-rpc'));
  assert.equal(assertCorrelation(idle, subscribe, { now: NOW }), true);
  const idleSubscribe = createFrame('session.subscribe', { ...binding, runId: null }, {}, dataOptions('current-rpc'));
  assert.equal(assertCorrelation(current, idleSubscribe, { now: NOW }), true);
  code(() => validateFrame(current, { now: NOW, expected: reverseBinding }), ERROR_CODES.RUN_MISMATCH);
  code(() => assertBinding(current, grant, { now: NOW, direction: 'toPhone' }), ERROR_CODES.RUN_MISMATCH);
  assert.equal(assertBinding(current, { ...grant, runId: 'new-run' }, { now: NOW, direction: 'toPhone' }), true);
  const inconsistent = clone(current); inconsistent.payload.pending[0].runId = binding.runId;
  code(() => assertCorrelation(inconsistent, subscribe, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
});

for (const [field, value, expected] of [
  ['fromDeviceId', 'foreign-tablet', ERROR_CODES.DEVICE_MISMATCH],
  ['toDeviceId', 'foreign-phone', ERROR_CODES.DEVICE_MISMATCH],
  ['hostInstanceId', 'new-host-instance', ERROR_CODES.HOST_INSTANCE_MISMATCH],
  ['remoteSessionId', 'foreign-session', ERROR_CODES.SESSION_MISMATCH],
  ['grantVersion', 2, ERROR_CODES.GRANT_MISMATCH],
]) {
  test(`snapshot run recovery still rejects changed ${field}`, () => {
    const subscribe = createFrame('session.subscribe', binding, {}, dataOptions('recover-rpc'));
    const payload = snapshotPayload(); payload.run = { runId: 'new-run', state: 'running' }; payload.pending = [];
    const frame = createFrame('session.snapshot', { ...reverseBinding, runId: 'new-run', [field]: value }, payload, dataOptions('recover-rpc'));
    code(() => assertCorrelation(frame, subscribe, { now: NOW }), expected);
  });
}

test('run changes remain forbidden for history, decline acknowledgements and controls', () => {
  const query = createFrame('history.get', binding, { cursor: null, limit: 1 }, dataOptions('history-rpc'));
  const page = createFrame('history.page', { ...reverseBinding, runId: 'new-run' }, historyPage(), dataOptions('history-rpc'));
  code(() => assertCorrelation(page, query, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
  const decline = createFrame('host.decline', binding, {}, dataOptions('decline-rpc'));
  const declined = createFrame('host.declined', { ...reverseBinding, runId: 'new-run' }, {}, dataOptions('decline-rpc'));
  code(() => assertCorrelation(declined, decline, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
  code(() => assertBinding(message(), { ...grant, runId: 'new-run' }, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
  const stop = createFrame('run.stop', binding, {}, options());
  code(() => assertBinding(stop, { ...grant, runId: 'new-run' }, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
  const controlQuery = createFrame('control.query', binding, {}, options());
  code(() => assertBinding(controlQuery, { ...grant, runId: 'new-run' }, { now: NOW }), ERROR_CODES.RUN_MISMATCH);
});

test('correlation is distinct from command and approval IDs and not an arbitrary extension field', () => {
  const frame = clone(message()); frame.correlationId = 'rpc-fixture';
  code(() => validateFrame(frame, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  code(() => createFrame('session.unsubscribe', binding, {}, dataOptions('rpc-fixture')), ERROR_CODES.UNKNOWN_FIELD);
  const query = createFrame('history.get', binding, { cursor: null, limit: 1 }, dataOptions('rpc-fixture'));
  assert.ok(!Object.hasOwn(query, 'commandId'));
  const missing = createFrame('history.get', binding, { cursor: null, limit: 1 }, dataOptions());
  const page = createFrame('history.page', reverseBinding, historyPage(), dataOptions('rpc-fixture'));
  code(() => assertCorrelation(page, missing, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
});

const noticePayload = (changes = {}) => ({ run: { runId: binding.runId, state: 'waiting' }, pending: [{ requestId: request.requestId, requestVersion: request.requestVersion, expiresAt: request.expiresAt }], eventId: 'notice-fixture', ...changes });
const notice = (payload = noticePayload(), target = reverseBinding) => createFrame('session.notice', target, payload, dataOptions());

test('background notice is immutable opaque metadata bound to an active host grant and run', () => {
  const frame = notice();
  assert.deepEqual(Object.keys(frame.payload).sort(), ['eventId', 'pending', 'run']);
  assert.deepEqual(Object.keys(frame.payload.pending[0]).sort(), ['expiresAt', 'requestId', 'requestVersion']);
  assert.ok(Object.isFrozen(frame.payload.pending[0]));
  assert.equal(assertBinding(frame, grant, { now: NOW, direction: 'toPhone' }), true);
  assert.equal(parseFrame(JSON.stringify(frame), { now: NOW }).payload.eventId, 'notice-fixture');
  const retry = createFrame('session.notice', reverseBinding, frame.payload, { now: NOW + 1, messageId: 'notice-retry' });
  assert.equal(retry.payload.eventId, frame.payload.eventId);
  assert.notEqual(retry.messageId, frame.messageId);
});

test('notice grants never bypass active authority or capability direction', () => {
  const frame = notice();
  code(() => assertBinding(frame, { ...grant, state: 'invited' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.GRANT_NOT_ACTIVE);
  code(() => assertBinding(frame, { ...grant, state: 'revoked' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.GRANT_REVOKED);
  code(() => assertBinding(frame, { ...grant, state: 'expired' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.EXPIRED);
  code(() => assertBinding(frame, { ...grant, expiresAt: NOW }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.EXPIRED);
  code(() => assertBinding(notice(noticePayload(), binding), grant, { now: NOW }), ERROR_CODES.FORBIDDEN);
  code(() => assertBinding(frame, { ...grant, runId: 'current-other-run' }, { now: NOW, direction: 'toPhone' }), ERROR_CODES.RUN_MISMATCH);
});

for (const [name, change] of [
  ['title', (p) => { p.title = 'private session title'; }],
  ['body', (p) => { p.body = 'private body'; }],
  ['tool', (p) => { p.toolName = 'Bash'; }],
  ['history', (p) => { p.items = [item()]; }],
  ['approval details', (p) => { p.pending[0].detailText = 'private command'; }],
  ['request kind', (p) => { p.pending[0].kind = 'permission'; }],
  ['run parameters', (p) => { p.run.input = { command: 'fixture' }; }],
]) {
  test(`background notice rejects content-bearing ${name}`, () => {
    const payload = noticePayload(); change(payload);
    code(() => notice(payload), ERROR_CODES.UNKNOWN_FIELD);
  });
}

test('notice allows only declared run states and idle null run cannot carry pending requests', () => {
  for (const state of ['running', 'waiting', 'idle', 'ended', 'stopped']) {
    assert.ok(notice(noticePayload({ run: { runId: binding.runId, state }, pending: [] })));
  }
  assert.ok(notice(noticePayload({ run: { runId: null, state: 'idle' }, pending: [] }), { ...reverseBinding, runId: null }));
  code(() => notice(noticePayload({ run: { runId: null, state: 'idle' } }), { ...reverseBinding, runId: null }), ERROR_CODES.RUN_MISMATCH);
  code(() => notice(noticePayload({ run: { runId: null, state: 'ended' }, pending: [] }), { ...reverseBinding, runId: null }), ERROR_CODES.INVALID_SCHEMA);
  code(() => notice(noticePayload({ run: { runId: 'other-run', state: 'running' } })), ERROR_CODES.RUN_MISMATCH);
  for (const state of ['stopping', 'needs-local', 'unknown']) {
    code(() => notice(noticePayload({ run: { runId: binding.runId, state } })), ERROR_CODES.INVALID_SCHEMA);
  }
});

test('notice has a 32-request cap with unique IDs, versions and bounded event identity', () => {
  const pending = Array.from({ length: LIMITS.NOTICE_PENDING }, (_, i) => ({ requestId: 'request-' + i, requestVersion: 1, expiresAt: NOW + 30_000 }));
  assert.ok(notice(noticePayload({ pending })));
  code(() => notice(noticePayload({ pending: [...pending, { requestId: 'overflow', requestVersion: 1, expiresAt: NOW + 30_000 }] })), ERROR_CODES.LIMIT_EXCEEDED);
  code(() => notice(noticePayload({ pending: [pending[0], pending[0]] })), ERROR_CODES.INVALID_SCHEMA);
  code(() => notice(noticePayload({ pending: [{ ...pending[0], requestVersion: 0 }] })), ERROR_CODES.INVALID_SCHEMA);
  code(() => notice(noticePayload({ pending: [{ ...pending[0], expiresAt: -1 }] })), ERROR_CODES.INVALID_SCHEMA);
  code(() => notice(noticePayload({ eventId: '' })), ERROR_CODES.INVALID_SCHEMA);
  code(() => notice(noticePayload({ eventId: 'x'.repeat(129) })), ERROR_CODES.INVALID_SCHEMA);
});

test('notice is not a view RPC response, execution receipt or side-effecting command', () => {
  const frame = notice();
  const subscribe = createFrame('session.subscribe', binding, {}, dataOptions('notice-rpc'));
  code(() => assertCorrelation(frame, subscribe, { now: NOW }), ERROR_CODES.REQUEST_MISMATCH);
  code(() => validateFrame({ ...frame, correlationId: 'notice-rpc' }, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  code(() => validateFrame({ ...frame, commandId: 'fake-command' }, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  code(() => validateFrame({ ...frame, payload: { ...frame.payload, status: 'applied' } }, { now: NOW }), ERROR_CODES.UNKNOWN_FIELD);
  const ledger = createCommandLedger({ now: NOW });
  code(() => ledger.record(frame), ERROR_CODES.UNSUPPORTED_TYPE);
  assert.equal(ledger.size, 0);
});

test('error text never echoes supplied unknown field or command contents', () => {
  try { validateFrame({ ...message('fixture-secret'), 'fixture-secret-key': true }, { now: NOW }); assert.fail(); }
  catch (error) { assert.equal(error.code, ERROR_CODES.UNKNOWN_FIELD); assert.ok(!error.message.includes('fixture-secret')); }
});

// Remote session v1 is a capability allowlist, never a proxy for local APIs.
// This module is deliberately pure: no gateway imports, I/O, timers or credentials.
import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  FRAME_BYTES: 64 * 1024,
  TEXT_BYTES: 16 * 1024,
  HISTORY_ITEMS: 50,
  HISTORY_PAGE_BYTES: 256 * 1024,
  LOW_QUEUE_BYTES: 512 * 1024,
  CONTROL_TTL_MS: 60_000,
  FRAME_TTL_MS: 300_000,
  CLOCK_SKEW_MS: 5_000,
  ID_BYTES: 128,
  TITLE_BYTES: 512,
  REASON_BYTES: 4 * 1024,
  RECORD_TEXT_BYTES: 48 * 1024,
  REQUEST_DETAIL_BYTES: 24 * 1024,
  PENDING_REQUESTS: 128,
  NOTICE_PENDING: 32,
  QUESTIONS: 16,
  QUESTION_OPTIONS: 32,
  CURSOR_BYTES: 1024,
  MAX_DEPTH: 16,
  MAX_NODES: 16_384,
  MAX_COMMANDS: 2_048,
});

const codes = [
  'INVALID_SCHEMA', 'UNKNOWN_FIELD', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_TYPE',
  'LIMIT_EXCEEDED', 'EXPIRED', 'NOT_YET_VALID', 'DEVICE_MISMATCH',
  'HOST_INSTANCE_MISMATCH', 'SESSION_MISMATCH', 'GRANT_MISMATCH',
  'GRANT_REVOKED', 'GRANT_NOT_ACTIVE', 'RUN_MISMATCH', 'REQUEST_MISMATCH',
  'REQUEST_EXPIRED', 'REQUEST_CLOSED', 'DETAILS_INCOMPLETE', 'COMMAND_CONFLICT',
  'COMMAND_UNKNOWN', 'INVALID_TRANSITION', 'LEDGER_FULL', 'OFFLINE',
  'RESYNC_REQUIRED', 'FORBIDDEN', 'INTERNAL_ERROR',
];
export const ERROR_CODES = Object.freeze(Object.fromEntries(codes.map((code) => [code, code])));
export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProtocolError';
    this.code = Object.hasOwn(ERROR_CODES, code) ? code : ERROR_CODES.INTERNAL_ERROR;
  }
}
const fail = (code, message) => { throw new ProtocolError(code, message); };
const invalid = () => fail(ERROR_CODES.INVALID_SCHEMA, 'Invalid remote protocol value');
const limit = () => fail(ERROR_CODES.LIMIT_EXCEEDED, 'Remote protocol limit exceeded');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const utf8 = (value) => Buffer.byteLength(value, 'utf8');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

// Refuse getters, prototypes, non-JSON values and cycles before any stringify.
// In-memory callers get the same boundary as parsed network JSON.
function jsonClone(value, depth = 0, seen = new Set(), budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > LIMITS.MAX_NODES || depth > LIMITS.MAX_DEPTH) limit();
  budget.bytes += typeof value === 'string' ? utf8(value) : 8;
  if (budget.bytes > LIMITS.HISTORY_PAGE_BYTES) limit();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
  if (typeof value !== 'object' || seen.has(value)) invalid();
  const array = Array.isArray(value);
  if (!array && !isObject(value)) invalid();
  seen.add(value);
  const result = array ? [] : {};
  if (array && value.length > LIMITS.MAX_NODES) limit();
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || forbiddenKeys.has(key)) invalid();
    budget.bytes += utf8(key);
    if (budget.bytes > LIMITS.HISTORY_PAGE_BYTES) limit();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.length)) invalid();
    Object.defineProperty(result, key, { value: jsonClone(descriptor.value, depth + 1, seen, budget), enumerable: true, writable: true, configurable: true });
  }
  if (array && (result.length !== value.length || Object.keys(result).length !== value.length)) invalid();
  seen.delete(value);
  return result;
}
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(value, required, optional = []) {
  if (!isObject(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail(ERROR_CODES.UNKNOWN_FIELD, 'Unknown remote protocol field');
  }
  if (required.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}
function text(value, max, { empty = true } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\u0000')) invalid();
  if (utf8(value) > max) limit();
  return value;
}
function id(value) { if (typeof value !== 'string' || !idPattern.test(value)) invalid(); return value; }
function nullableId(value) { return value === null ? null : id(value); }
function integer(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
function bool(value) { if (typeof value !== 'boolean') invalid(); return value; }
function oneOf(value, values) { if (!values.includes(value)) invalid(); return value; }
function array(value, max, each) {
  if (!Array.isArray(value)) invalid();
  if (value.length > max) limit();
  value.forEach(each);
  return value;
}
function optional(value, key, validate) { if (Object.hasOwn(value, key)) validate(value[key]); }
const nowValue = (now) => integer(typeof now === 'function' ? now() : now ?? Date.now());
const controlTypes = new Set(['message.submit', 'request.respond', 'run.stop']);
const commandTypes = new Set([...controlTypes, 'control.query', 'control.receipt']);
export const CONTROL_TYPES = Object.freeze([...controlTypes]);
export const RECEIPT_STATUSES = Object.freeze(['received', 'applied', 'rejected', 'unknown']);
const commonFields = ['v', 'type', 'messageId', 'fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'runId', 'issuedAt', 'expiresAt', 'payload'];
const bindingFields = ['fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'runId'];
const correlationTypes = new Set(['host.accept', 'host.decline', 'host.declined', 'host.release', 'host.released', 'host.revoke', 'host.revoked', 'session.subscribe', 'history.get', 'session.snapshot', 'history.page']);
const hostBoundTypes = new Set([...controlTypes, 'control.query', 'host.accept', 'host.decline', 'host.release', 'host.revoked', 'session.subscribe', 'session.unsubscribe', 'history.get']);
const phoneBoundTypes = new Set(['control.receipt', 'host.invite', 'host.revoke', 'host.declined', 'host.released', 'session.snapshot', 'session.notice', 'history.page', 'event.batch']);

function validateLifetime(frame, now) {
  integer(frame.issuedAt);
  integer(frame.expiresAt);
  const ttl = controlTypes.has(frame.type) || frame.type === 'control.query' ? LIMITS.CONTROL_TTL_MS : LIMITS.FRAME_TTL_MS;
  if (frame.expiresAt <= frame.issuedAt || frame.expiresAt - frame.issuedAt > ttl) invalid();
  if (frame.issuedAt > now + LIMITS.CLOCK_SKEW_MS) fail(ERROR_CODES.NOT_YET_VALID, 'Remote frame is not yet valid');
  if (frame.expiresAt <= now) fail(ERROR_CODES.EXPIRED, 'Remote frame expired');
}

export function receiptTransition(state, next) {
  if (state !== null && !RECEIPT_STATUSES.includes(state)) invalid();
  oneOf(next, RECEIPT_STATUSES);
  if (state === next || state === null && next === 'received'
    || state === 'received' && ['applied', 'rejected', 'unknown'].includes(next)
    || state === 'unknown' && ['applied', 'rejected'].includes(next)) return next;
  fail(ERROR_CODES.INVALID_TRANSITION, 'Invalid receipt transition');
}

export function grantTransition(state, event) {
  const transitions = {
    none: { invite: 'invited' },
    invited: { accept: 'active', decline: 'revoked', revoke: 'revoked', expire: 'expired' },
    active: { revoke: 'revoked', expire: 'expired' },
    revoked: {},
    expired: {},
  };
  if (!Object.hasOwn(transitions, state) || !Object.hasOwn(transitions[state], event)) {
    fail(ERROR_CODES.INVALID_TRANSITION, 'Invalid grant transition');
  }
  return transitions[state][event];
}

function validateBindingFields(binding) {
  for (const key of ['fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId']) id(binding[key]);
  integer(binding.grantVersion, 1);
  nullableId(binding.runId);
  if (binding.fromDeviceId === binding.toDeviceId) invalid();
}
function compareBinding(actual, expected) {
  exact(expected, bindingFields);
  validateBindingFields(expected);
  const checks = [
    ['fromDeviceId', ERROR_CODES.DEVICE_MISMATCH],
    ['toDeviceId', ERROR_CODES.DEVICE_MISMATCH],
    ['hostInstanceId', ERROR_CODES.HOST_INSTANCE_MISMATCH],
    ['remoteSessionId', ERROR_CODES.SESSION_MISMATCH],
    ['grantVersion', ERROR_CODES.GRANT_MISMATCH],
    ['runId', ERROR_CODES.RUN_MISMATCH],
  ];
  for (const [key, code] of checks) {
    if (actual[key] !== expected[key]) fail(code, 'Remote binding does not match');
  }
}

/** Validate authority against a trusted, current host-owned grant. Never use
 * a grant supplied by the remote peer as the authority. Authorization and
 * dispatch must still share the adapter's serial boundary. */
export function assertBinding(frame, grant, { now, direction = 'toHost', request } = {}) {
  if (!isObject(frame) || !isObject(grant)) invalid();
  const currentTime = nowValue(now);
  frame = validateFrame(frame, { now: currentTime });
  grant = jsonClone(grant);
  if (request !== undefined) request = jsonClone(request);
  oneOf(direction, ['toHost', 'toPhone']);
  for (const key of ['hostDeviceId', 'phoneDeviceId', 'hostInstanceId', 'remoteSessionId']) id(grant[key]);
  integer(grant.grantVersion, 1);
  integer(grant.expiresAt);
  nullableId(grant.runId);
  oneOf(grant.state, ['invited', 'active', 'revoked', 'expired']);
  const revocationNotice = direction === 'toPhone' && ['host.revoke', 'host.declined', 'host.released'].includes(frame.type);
  if (!revocationNotice && grant.state === 'revoked') fail(ERROR_CODES.GRANT_REVOKED, 'Remote grant revoked');
  if (!revocationNotice && (grant.state === 'expired' || grant.expiresAt <= currentTime)) fail(ERROR_CODES.EXPIRED, 'Remote grant expired');
  if (grant.state !== 'active' && !['host.invite', 'host.accept', 'host.decline', 'host.declined', 'host.release', 'host.released', 'host.revoke'].includes(frame.type)) {
    fail(ERROR_CODES.GRANT_NOT_ACTIVE, 'Remote grant is not active');
  }
  compareBinding(frame, {
    fromDeviceId: direction === 'toHost' ? grant.phoneDeviceId : grant.hostDeviceId,
    toDeviceId: direction === 'toHost' ? grant.hostDeviceId : grant.phoneDeviceId,
    hostInstanceId: grant.hostInstanceId,
    remoteSessionId: grant.remoteSessionId,
    grantVersion: grant.grantVersion,
    runId: grant.runId,
  });
  validateLifetime(frame, currentTime);
  if (frame.type === 'host.invite' && frame.payload.expiresAt !== grant.expiresAt) {
    fail(ERROR_CODES.GRANT_MISMATCH, 'Invitation expiry does not match its grant');
  }
  if (direction === 'toPhone' && hostBoundTypes.has(frame.type)
    || direction === 'toHost' && phoneBoundTypes.has(frame.type)) {
    fail(ERROR_CODES.FORBIDDEN, 'Remote frame has the wrong capability direction');
  }
  if (frame.type === 'request.respond') {
    if (!isObject(request)) fail(ERROR_CODES.REQUEST_MISMATCH, 'Current request is required');
    id(request.requestId);
    integer(request.requestVersion, 1);
    id(request.runId);
    integer(request.expiresAt);
    if (request.requestId !== frame.payload.requestId || request.requestVersion !== frame.payload.requestVersion
      || request.runId !== frame.runId) fail(ERROR_CODES.REQUEST_MISMATCH, 'Remote request binding does not match');
    if (request.expiresAt <= currentTime) fail(ERROR_CODES.REQUEST_EXPIRED, 'Remote request expired');
    if (request.state !== 'pending') fail(ERROR_CODES.REQUEST_CLOSED, 'Remote request is no longer pending');
    oneOf(request.kind, ['permission', 'question', 'plan', 'local']);
    if (request.kind === 'local') fail(ERROR_CODES.FORBIDDEN, 'This request must be handled locally');
    if (request.kind !== frame.payload.response.kind) fail(ERROR_CODES.REQUEST_MISMATCH, 'Response kind does not match original request');
    if ((['allow', 'approve'].includes(frame.payload.response.decision) || frame.payload.response.kind === 'question') && request.detailsComplete !== true) {
      fail(ERROR_CODES.DETAILS_INCOMPLETE, 'Complete request details are required to approve');
    }
    if (request.kind === 'question') {
      questions(request.questions);
      if (frame.payload.response.answers.length !== request.questions.length) fail(ERROR_CODES.REQUEST_MISMATCH, 'Every original question must be answered');
      const originals = new Map(request.questions.map((question) => [question.questionId, question]));
      for (const answer of frame.payload.response.answers) {
        const original = originals.get(answer.questionId);
        if (!original || !original.multiSelect && answer.optionIds.length > 1
          || answer.optionIds.some((optionId) => !original.options.some((option) => option.optionId === optionId))) {
          fail(ERROR_CODES.REQUEST_MISMATCH, 'Answer is outside the original question scope');
        }
      }
    }
  }
  return true;
}

function response(value) {
  if (!isObject(value)) invalid();
  if (value.kind === 'permission') {
    exact(value, ['kind', 'decision'], ['reason']);
    oneOf(value.decision, ['allow', 'deny']);
    optional(value, 'reason', (reason) => text(reason, LIMITS.REASON_BYTES));
  } else if (value.kind === 'question') {
    exact(value, ['kind', 'answers']);
    if (!Array.isArray(value.answers) || !value.answers.length) invalid();
    const questionIds = new Set();
    array(value.answers, 16, (answer) => {
      exact(answer, ['questionId', 'optionIds'], ['text']);
      id(answer.questionId);
      if (questionIds.has(answer.questionId)) invalid();
      questionIds.add(answer.questionId);
      const optionIds = new Set();
      array(answer.optionIds, 32, (optionId) => {
        id(optionId);
        if (optionIds.has(optionId)) invalid();
        optionIds.add(optionId);
      });
      optional(answer, 'text', (answerText) => text(answerText, LIMITS.TEXT_BYTES, { empty: false }));
      if (!answer.optionIds.length && !answer.text) invalid();
    });
  } else if (value.kind === 'plan') {
    exact(value, ['kind', 'decision'], ['reason']);
    oneOf(value.decision, ['approve', 'reject']);
    optional(value, 'reason', (reason) => text(reason, LIMITS.REASON_BYTES));
  } else invalid();
}
function receiptResult(value) {
  if (!isObject(value)) invalid();
  if (value.kind === 'message') {
    exact(value, ['kind', 'delivery']);
    oneOf(value.delivery, ['accepted', 'queued']);
  } else if (value.kind === 'request') {
    exact(value, ['kind', 'requestId', 'requestVersion']);
    id(value.requestId);
    integer(value.requestVersion, 1);
  } else if (value.kind === 'stop') {
    exact(value, ['kind', 'runState']);
    oneOf(value.runState, ['stopped', 'ended']);
  } else invalid();
}
function receiptPayload(value) {
  exact(value, ['status'], ['code', 'result']);
  oneOf(value.status, RECEIPT_STATUSES);
  optional(value, 'code', (code) => oneOf(code, codes));
  optional(value, 'result', receiptResult);
  if (value.status === 'applied' && (!Object.hasOwn(value, 'result') || Object.hasOwn(value, 'code'))) invalid();
  if (value.status === 'rejected' && (!Object.hasOwn(value, 'code') || Object.hasOwn(value, 'result'))) invalid();
  if (value.status === 'received' && (Object.hasOwn(value, 'code') || Object.hasOwn(value, 'result'))) invalid();
  if (value.status === 'unknown' && Object.hasOwn(value, 'result')) invalid();
}
function cursor(value) { return value === null ? null : text(value, LIMITS.CURSOR_BYTES, { empty: false }); }
function record(value) {
  exact(value, ['id', 'kind'], ['role', 'text', 'toolName', 'toolStatus', 'toolInputText', 'toolResultText', 'source', 'timestamp', 'truncated']);
  id(value.id);
  oneOf(value.kind, ['message', 'tool']);
  optional(value, 'role', (role) => oneOf(role, ['user', 'assistant', 'system']));
  for (const key of ['text', 'toolInputText', 'toolResultText']) optional(value, key, (body) => text(body, LIMITS.RECORD_TEXT_BYTES));
  optional(value, 'toolName', (name) => text(name, LIMITS.TITLE_BYTES, { empty: false }));
  optional(value, 'toolStatus', (state) => oneOf(state, ['running', 'done', 'error']));
  optional(value, 'source', (source) => oneOf(source, ['phone', 'host']));
  optional(value, 'timestamp', integer);
  optional(value, 'truncated', bool);
  if (value.kind === 'message' && ['toolName', 'toolStatus', 'toolInputText', 'toolResultText'].some((key) => Object.hasOwn(value, key))) invalid();
  if (value.kind === 'tool' && Object.hasOwn(value, 'role')) invalid();
}
function records(value) {
  const seen = new Set();
  array(value, LIMITS.HISTORY_ITEMS, (item) => {
    record(item);
    if (seen.has(item.id)) invalid();
    seen.add(item.id);
  });
}
function questions(value) {
  if (!Array.isArray(value) || !value.length) invalid();
  const questionIds = new Set();
  array(value, LIMITS.QUESTIONS, (question) => {
    exact(question, ['questionId', 'question', 'multiSelect', 'options'], ['header']);
    id(question.questionId);
    if (questionIds.has(question.questionId)) invalid();
    questionIds.add(question.questionId);
    text(question.question, LIMITS.REASON_BYTES, { empty: false });
    optional(question, 'header', (header) => text(header, LIMITS.TITLE_BYTES));
    bool(question.multiSelect);
    const optionIds = new Set();
    array(question.options, LIMITS.QUESTION_OPTIONS, (option) => {
      exact(option, ['optionId', 'label'], ['description']);
      id(option.optionId);
      if (optionIds.has(option.optionId)) invalid();
      optionIds.add(option.optionId);
      text(option.label, LIMITS.REASON_BYTES, { empty: false });
      optional(option, 'description', (description) => text(description, LIMITS.REASON_BYTES));
    });
  });
}
function requestRecord(value) {
  exact(value, ['requestId', 'requestVersion', 'runId', 'state', 'kind', 'expiresAt', 'detailsComplete'], ['toolName', 'summary', 'detailText', 'questions']);
  id(value.requestId);
  integer(value.requestVersion, 1);
  id(value.runId);
  oneOf(value.state, ['pending']);
  oneOf(value.kind, ['permission', 'question', 'plan', 'local']);
  integer(value.expiresAt);
  bool(value.detailsComplete);
  optional(value, 'toolName', (name) => text(name, LIMITS.TITLE_BYTES, { empty: false }));
  optional(value, 'summary', (summary) => text(summary, LIMITS.REASON_BYTES));
  optional(value, 'detailText', (details) => text(details, LIMITS.REQUEST_DETAIL_BYTES));
  if (value.kind === 'question') questions(value.questions);
  else if (Object.hasOwn(value, 'questions')) invalid();
  if (value.kind === 'local' && value.detailsComplete) invalid();
  if (value.detailsComplete && value.kind !== 'question' && (typeof value.detailText !== 'string' || !value.detailText.trim())) invalid();
}
function requests(value, runId) {
  const seen = new Set();
  array(value, LIMITS.PENDING_REQUESTS, (request) => {
    requestRecord(request);
    if (seen.has(request.requestId)) invalid();
    seen.add(request.requestId);
    if (request.runId !== runId) fail(ERROR_CODES.RUN_MISMATCH, 'Request belongs to a different run');
  });
}
function snapshotPayload(value, frame) {
  exact(value, ['streamId', 'seq', 'title', 'grant', 'run', 'pending', 'items', 'historyCursor', 'historyHasMore']);
  id(value.streamId);
  integer(value.seq);
  text(value.title, LIMITS.TITLE_BYTES);
  exact(value.grant, ['state', 'expiresAt']);
  oneOf(value.grant.state, ['active', 'revoked', 'expired']);
  integer(value.grant.expiresAt);
  exact(value.run, ['runId', 'state']);
  nullableId(value.run.runId);
  oneOf(value.run.state, ['idle', 'running', 'waiting', 'ended', 'stopping', 'stopped', 'needs-local']);
  if (value.run.runId !== frame.runId) fail(ERROR_CODES.RUN_MISMATCH, 'Snapshot belongs to a different run');
  if (value.run.runId === null && value.run.state !== 'idle') invalid();
  if (value.run.runId !== null && value.run.state === 'idle') invalid();
  requests(value.pending, frame.runId);
  records(value.items);
  cursor(value.historyCursor);
  bool(value.historyHasMore);
}
const payloadValidators = Object.create(null);
payloadValidators['message.submit'] = (value) => {
  exact(value, ['text']);
  text(value.text, LIMITS.TEXT_BYTES, { empty: false });
};
payloadValidators['request.respond'] = (value) => {
  exact(value, ['requestId', 'requestVersion', 'response']);
  id(value.requestId);
  integer(value.requestVersion, 1);
  response(value.response);
};
payloadValidators['run.stop'] = (value) => { exact(value, []); };
payloadValidators['control.query'] = (value) => { exact(value, []); };
payloadValidators['control.receipt'] = receiptPayload;
payloadValidators['host.invite'] = (value, frame) => {
  exact(value, ['title', 'deviceName', 'expiresAt']);
  text(value.title, LIMITS.TITLE_BYTES);
  text(value.deviceName, LIMITS.TITLE_BYTES, { empty: false });
  integer(value.expiresAt);
  if (value.expiresAt <= frame.issuedAt) invalid();
};
payloadValidators['host.accept'] = (value) => { exact(value, []); };
payloadValidators['host.decline'] = (value) => { exact(value, []); };
payloadValidators['host.declined'] = (value) => { exact(value, []); };
payloadValidators['host.release'] = (value) => { exact(value, []); };
payloadValidators['host.released'] = (value) => { exact(value, []); };
payloadValidators['host.revoked'] = (value) => { exact(value, []); };
payloadValidators['host.revoke'] = (value) => {
  exact(value, ['reason']);
  oneOf(value.reason, ['revoked', 'expired', 'unpaired']);
};
payloadValidators['session.subscribe'] = (value) => { exact(value, []); };
payloadValidators['session.unsubscribe'] = (value) => { exact(value, []); };
payloadValidators['history.get'] = (value) => {
  exact(value, ['cursor', 'limit']);
  cursor(value.cursor);
  integer(value.limit, 1);
  if (value.limit > LIMITS.HISTORY_ITEMS) limit();
};
payloadValidators['session.snapshot'] = snapshotPayload;
// Idle/background peers receive only opaque notification metadata. A notice
// is not a snapshot, an approval detail, a receipt or authority to control.
payloadValidators['session.notice'] = (value, frame) => {
  exact(value, ['run', 'pending', 'eventId']);
  id(value.eventId);
  exact(value.run, ['runId', 'state']);
  nullableId(value.run.runId);
  oneOf(value.run.state, ['running', 'waiting', 'idle', 'ended', 'stopped']);
  if (value.run.runId !== frame.runId) fail(ERROR_CODES.RUN_MISMATCH, 'Notice belongs to a different run');
  if (value.run.runId === null && value.run.state !== 'idle') invalid();
  const seen = new Set();
  array(value.pending, LIMITS.NOTICE_PENDING, (request) => {
    exact(request, ['requestId', 'requestVersion', 'expiresAt']);
    id(request.requestId);
    integer(request.requestVersion, 1);
    integer(request.expiresAt);
    if (seen.has(request.requestId)) invalid();
    seen.add(request.requestId);
  });
  if (value.run.runId === null && value.pending.length) fail(ERROR_CODES.RUN_MISMATCH, 'Pending notice requires a concrete run');
};
payloadValidators['history.page'] = (value) => {
  exact(value, ['streamId', 'seq', 'items', 'cursor', 'nextCursor', 'hasMore']);
  id(value.streamId);
  integer(value.seq);
  records(value.items);
  cursor(value.cursor);
  cursor(value.nextCursor);
  bool(value.hasMore);
  if (value.hasMore && (value.nextCursor === null || value.nextCursor === value.cursor)) invalid();
  if (!value.hasMore && value.nextCursor !== null) invalid();
};
payloadValidators['event.batch'] = (value) => {
  exact(value, ['streamId', 'fromSeq', 'toSeq', 'events']);
  id(value.streamId);
  integer(value.fromSeq, 1);
  integer(value.toSeq, 1);
  if (!Array.isArray(value.events) || !value.events.length) invalid();
  array(value.events, LIMITS.HISTORY_ITEMS, (event, index) => {
    exact(event, ['seq', 'type', 'payload']);
    integer(event.seq, 1);
    oneOf(event.type, ['snapshot.required']);
    exact(event.payload, []);
    if (event.seq !== value.fromSeq + index) fail(ERROR_CODES.RESYNC_REQUIRED, 'Noncontiguous remote event sequence');
  });
  if (value.toSeq !== value.fromSeq + value.events.length - 1) fail(ERROR_CODES.RESYNC_REQUIRED, 'Remote batch range does not match its events');
};

/** Reject unknown fields at every level; return a detached, deeply frozen
 * JSON value so callers cannot alter a checked control before dispatch. */
export function validateFrame(value, { now, expected } = {}) {
  const frame = jsonClone(value);
  if (!isObject(frame)) invalid();
  if (frame.v !== PROTOCOL_VERSION) fail(ERROR_CODES.UNSUPPORTED_VERSION, 'Unsupported remote protocol version');
  if (typeof frame.type !== 'string' || !Object.hasOwn(payloadValidators, frame.type)) {
    fail(ERROR_CODES.UNSUPPORTED_TYPE, 'Unsupported remote protocol type');
  }
  exact(frame, commandTypes.has(frame.type) ? [...commonFields, 'commandId'] : commonFields, correlationTypes.has(frame.type) ? ['correlationId'] : []);
  if (utf8(JSON.stringify(frame)) > LIMITS.FRAME_BYTES) limit();
  id(frame.messageId);
  validateBindingFields(frame);
  if (commandTypes.has(frame.type)) id(frame.commandId);
  optional(frame, 'correlationId', id);
  if ((frame.type === 'request.respond' || frame.type === 'run.stop') && frame.runId === null) {
    fail(ERROR_CODES.RUN_MISMATCH, 'A concrete run is required');
  }
  validateLifetime(frame, nowValue(now));
  payloadValidators[frame.type](frame.payload, frame);
  if (expected !== undefined) compareBinding(frame, jsonClone(expected));
  return freeze(frame);
}

export function parseFrame(raw, options) {
  let source;
  if (typeof raw === 'string') source = raw;
  else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    if (raw.byteLength > LIMITS.FRAME_BYTES) limit();
    // Reject replacement-decoded invalid UTF-8 rather than changing authenticated data.
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { invalid(); }
  } else invalid();
  if (utf8(source) > LIMITS.FRAME_BYTES) limit();
  let value;
  try { value = JSON.parse(source); }
  catch { invalid(); }
  return validateFrame(value, options);
}

/** Binding is explicit, not inferred from a current page or global run. */
export function createFrame(type, binding, payload, { now, ttlMs, messageId = randomUUID(), commandId, correlationId } = {}) {
  const checkedBinding = jsonClone(binding);
  exact(checkedBinding, bindingFields);
  validateBindingFields(checkedBinding);
  const issuedAt = nowValue(now);
  const maximumTtl = controlTypes.has(type) || type === 'control.query' ? LIMITS.CONTROL_TTL_MS : LIMITS.FRAME_TTL_MS;
  const ttl = ttlMs ?? maximumTtl;
  integer(ttl, 1);
  if (ttl > maximumTtl) limit();
  const frame = { v: PROTOCOL_VERSION, type, messageId, ...checkedBinding, issuedAt, expiresAt: issuedAt + ttl, payload };
  if (commandId !== undefined) frame.commandId = commandId;
  if (correlationId !== undefined) frame.correlationId = correlationId;
  return validateFrame(frame, { now: issuedAt });
}

/** Every view/hosting RPC reply must echo a correlation ID and reverse lease.
 * Only a validated snapshot may announce the current run instead of echoing
 * the old run; this never relaxes control, history or grant authority checks. */
export function assertCorrelation(responseFrame, requestFrame, { now } = {}) {
  const currentTime = nowValue(now);
  const responseValue = validateFrame(responseFrame, { now: currentTime });
  const requestValue = validateFrame(requestFrame, { now: currentTime });
  const responseType = {
    'session.subscribe': 'session.snapshot',
    'host.accept': 'session.snapshot',
    'host.decline': 'host.declined',
    'host.release': 'host.released',
    'host.revoke': 'host.revoked',
    'history.get': 'history.page',
  }[requestValue.type];
  if (!responseType || responseValue.type !== responseType || !requestValue.correlationId
    || !responseValue.correlationId || requestValue.correlationId !== responseValue.correlationId) {
    fail(ERROR_CODES.REQUEST_MISMATCH, 'Remote view response does not match its request');
  }
  compareBinding(responseValue, {
    fromDeviceId: requestValue.toDeviceId,
    toDeviceId: requestValue.fromDeviceId,
    hostInstanceId: requestValue.hostInstanceId,
    remoteSessionId: requestValue.remoteSessionId,
    grantVersion: requestValue.grantVersion,
    // A read-only/accept snapshot is the authority's current run snapshot, not
    // a control result for the old run. Its payload/run/pending are validated
    // above. All other response types must retain the exact original run.
    runId: responseValue.type === 'session.snapshot' ? responseValue.runId : requestValue.runId,
  });
  if (requestValue.type === 'history.get' && (responseValue.payload.cursor !== requestValue.payload.cursor
    || responseValue.payload.items.length > requestValue.payload.limit)) {
    fail(ERROR_CODES.REQUEST_MISMATCH, 'Remote history response does not match its request');
  }
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function commandIdentity(frame) {
  if (!controlTypes.has(frame.type)) invalid();
  const value = { type: frame.type, commandId: frame.commandId, payload: frame.payload };
  for (const key of bindingFields) value[key] = frame[key];
  return value;
}
/** Fingerprinting does not authorize dispatch or check time; it also works
 * for a retained original control after expiry. Transport IDs/times may change
 * while stable commandId + authority + operation must not. */
export function commandFingerprint(frame) {
  const checked = jsonClone(frame);
  if (!isObject(checked) || checked.v !== PROTOCOL_VERSION) invalid();
  exact(checked, [...commonFields, 'commandId']);
  validateBindingFields(checked);
  id(checked.commandId);
  if (!controlTypes.has(checked.type)) fail(ERROR_CODES.UNSUPPORTED_TYPE, 'Not a side-effecting control');
  payloadValidators[checked.type](checked.payload);
  return createHash('sha256').update(canonical(commandIdentity(checked))).digest('hex');
}

/** Pure, bounded in-memory state machine, not a crash-safe execution store.
 * Adapters must durably journal received before side effects and serialize it
 * with grant revocation. Full means fail closed; never evict deduplication. */
export function createCommandLedger({ now, maxEntries = LIMITS.MAX_COMMANDS } = {}) {
  integer(maxEntries, 1);
  if (maxEntries > LIMITS.MAX_COMMANDS) limit();
  const entries = new Map();
  const clock = () => nowValue(now);
  const find = (commandId, binding) => {
    id(commandId);
    const checkedBinding = jsonClone(binding);
    exact(checkedBinding, bindingFields);
    validateBindingFields(checkedBinding);
    const entry = entries.get(commandId);
    if (entry) compareBinding(entry.binding, checkedBinding);
    return entry;
  };
  const result = {
    record(value) {
      const frame = validateFrame(value, { now: clock() });
      if (!controlTypes.has(frame.type)) fail(ERROR_CODES.UNSUPPORTED_TYPE, 'Not a side-effecting control');
      const fingerprint = commandFingerprint(frame);
      const old = entries.get(frame.commandId);
      if (old) {
        if (old.fingerprint !== fingerprint) fail(ERROR_CODES.COMMAND_CONFLICT, 'commandId cannot change its operation or binding');
        return freeze({ duplicate: true, receipt: old.receipt });
      }
      if (entries.size >= maxEntries) fail(ERROR_CODES.LEDGER_FULL, 'Remote command ledger is full');
      const binding = Object.fromEntries(bindingFields.map((key) => [key, frame[key]]));
      const receipt = freeze({ commandId: frame.commandId, status: 'received', updatedAt: clock() });
      const requestRef = frame.type === 'request.respond' ? { requestId: frame.payload.requestId, requestVersion: frame.payload.requestVersion } : null;
      entries.set(frame.commandId, { fingerprint, binding, type: frame.type, requestRef, receipt });
      return freeze({ duplicate: false, receipt });
    },
    get(commandId, binding) { return find(commandId, binding)?.receipt ?? null; },
    settle(commandId, binding, value) {
      const entry = find(commandId, binding);
      if (!entry) fail(ERROR_CODES.COMMAND_UNKNOWN, 'Remote command is not recorded');
      const payload = jsonClone(value);
      receiptPayload(payload);
      receiptTransition(entry.receipt.status, payload.status);
      if (payload.status === 'applied') {
        const kind = { 'message.submit': 'message', 'request.respond': 'request', 'run.stop': 'stop' }[entry.type];
        if (payload.result.kind !== kind) invalid();
        if (kind === 'request' && (payload.result.requestId !== entry.requestRef.requestId || payload.result.requestVersion !== entry.requestRef.requestVersion)) {
          fail(ERROR_CODES.REQUEST_MISMATCH, 'Receipt does not match original request');
        }
      }
      const previous = { status: entry.receipt.status };
      for (const key of ['code', 'result']) if (Object.hasOwn(entry.receipt, key)) previous[key] = entry.receipt[key];
      if (entry.receipt.status === payload.status) {
        if (canonical(previous) !== canonical(payload)) fail(ERROR_CODES.COMMAND_CONFLICT, 'A receipt cannot change without a state transition');
        return entry.receipt;
      }
      entry.receipt = freeze({ commandId, ...payload, updatedAt: clock() });
      return entry.receipt;
    },
    markUnknown(commandId, binding) { return result.settle(commandId, binding, { status: 'unknown' }); },
    get size() { return entries.size; },
  };
  return Object.freeze(result);
}

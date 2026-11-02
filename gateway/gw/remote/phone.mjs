// Phone-side state only. The injected transport owns authenticated/E2EE I/O;
// importing this module never starts a socket, reads HOME, or loads a local run.
import { randomUUID } from 'node:crypto';
import { LIMITS, ERROR_CODES, createFrame, validateFrame, assertBinding, commandFingerprint, receiptTransition } from './protocol.mjs';

export const PHONE_LIMITS = Object.freeze({
  CACHE_BYTES: 512 * 1024, CACHE_ITEMS: 500, SESSIONS: 64, PENDING: 128,
  COMMANDS: 256, SUBSCRIBERS: 64, IN_FLIGHT: 8, TIMEOUT_MS: 15_000,
});
export class PhoneError extends Error {
  constructor(code, message = code, extra = {}) {
    super(message);
    this.name = 'PhoneError'; this.code = code;
    Object.assign(this, extra);
  }
}
const fail = (code) => { throw new PhoneError(code); };
const safeCode = (cause, fallback = 'OFFLINE') => Object.hasOwn(ERROR_CODES, cause?.code) ? cause.code : fallback;
const safeError = (cause, fallback = 'OFFLINE') => new PhoneError(safeCode(cause, fallback));
const fields = ['fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'runId'];
const leaseFields = fields.filter((key) => key !== 'runId');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const same = (a, b, keys = fields) => !!a && !!b && keys.every((key) => a[key] === b[key]);
const reverse = (binding) => ({ ...binding, fromDeviceId: binding.toDeviceId, toDeviceId: binding.fromDeviceId });
const id = (value) => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('INVALID_SCHEMA'); return value; };
const integer = (value, min = 0) => { if (!Number.isSafeInteger(value) || value < min) fail('INVALID_SCHEMA'); return value; };
const text = (value, max) => { if (typeof value !== 'string' || value.includes('\0')) fail('INVALID_SCHEMA'); if (bytes(value) > max) fail('LIMIT_EXCEEDED'); return value; };
const cursorValue = (value) => { if (value === null) return null; text(value, 1024); if (!value.trim()) fail('INVALID_SCHEMA'); return value; };
function exact(value, required, optional = []) {
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key))) fail('INVALID_SCHEMA');
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail('UNKNOWN_FIELD');
}

// In-memory adapters have the same JSON/size boundary as decoded network data.
function json(value, maximum = LIMITS.HISTORY_PAGE_BYTES) {
  let nodes = 0, budget = 0;
  const spend = (size) => { budget += size; if (budget > maximum) fail('LIMIT_EXCEEDED'); };
  function copy(v, depth = 0) {
    if (++nodes > 16_384 || depth > 16) fail('LIMIT_EXCEEDED');
    if (v === null || typeof v === 'boolean') { spend(5); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('INVALID_SCHEMA'); spend(String(v).length); return v; }
    if (typeof v === 'string') { text(v, maximum); spend(bytes(JSON.stringify(v))); return v; }
    if (!object(v) && !Array.isArray(v)) fail('INVALID_SCHEMA');
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('INVALID_SCHEMA');
    const result = Array.isArray(v) ? [] : {};
    if (Array.isArray(v) && v.length > 16_384) fail('LIMIT_EXCEEDED');
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_SCHEMA');
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID_SCHEMA');
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) fail('INVALID_SCHEMA');
      spend(bytes(key) + 4); result[key] = copy(d.value, depth + 1);
    }
    if (Array.isArray(v) && Object.keys(result).length !== v.length) fail('INVALID_SCHEMA');
    return result;
  }
  const result = copy(value);
  if (bytes(result) > maximum) fail('LIMIT_EXCEEDED');
  return result;
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function checkedBinding(value, now) {
  // createFrame applies the canonical exact-field/ID/run binding validator.
  const frame = createFrame('control.query', value, {}, { now, messageId: 'binding-check', commandId: 'binding-check' });
  return Object.fromEntries(fields.map((key) => [key, frame[key]]));
}
function records(value) {
  if (!Array.isArray(value) || value.length > LIMITS.HISTORY_ITEMS) fail('LIMIT_EXCEEDED');
  const result = json(value), seen = new Set();
  for (const item of result) {
    exact(item, ['id', 'kind'], ['role', 'text', 'toolName', 'toolStatus', 'toolInputText', 'toolResultText', 'source', 'timestamp', 'truncated']);
    id(item.id); if (seen.has(item.id) || !['message', 'tool'].includes(item.kind)) fail('INVALID_SCHEMA'); seen.add(item.id);
    for (const key of ['text', 'toolInputText', 'toolResultText']) if (Object.hasOwn(item, key)) text(item[key], LIMITS.RECORD_TEXT_BYTES);
    if (Object.hasOwn(item, 'role') && !['user', 'assistant', 'system'].includes(item.role)) fail('INVALID_SCHEMA');
    if (Object.hasOwn(item, 'toolName') && !text(item.toolName, LIMITS.TITLE_BYTES).trim()) fail('INVALID_SCHEMA');
    if (Object.hasOwn(item, 'toolStatus') && !['running', 'done', 'error'].includes(item.toolStatus)) fail('INVALID_SCHEMA');
    if (Object.hasOwn(item, 'source') && !['phone', 'host'].includes(item.source)) fail('INVALID_SCHEMA');
    if (Object.hasOwn(item, 'timestamp')) integer(item.timestamp);
    if (Object.hasOwn(item, 'truncated') && typeof item.truncated !== 'boolean') fail('INVALID_SCHEMA');
    if (item.kind === 'message' && ['toolName', 'toolStatus', 'toolInputText', 'toolResultText'].some((key) => Object.hasOwn(item, key))
      || item.kind === 'tool' && Object.hasOwn(item, 'role')) fail('INVALID_SCHEMA');
  }
  return result;
}
function checkedRequests(value, runId) {
  if (!Array.isArray(value) || value.length > PHONE_LIMITS.PENDING) fail('INVALID_SCHEMA');
  const seen = new Set();
  for (const request of value) {
    exact(request, ['requestId', 'requestVersion', 'runId', 'expiresAt', 'kind', 'state', 'detailsComplete'], ['toolName', 'summary', 'detailText', 'questions']);
    id(request.requestId); integer(request.requestVersion, 1); integer(request.expiresAt);
    if (seen.has(request.requestId) || request.runId !== runId || runId === null || request.state !== 'pending'
      || !['permission', 'question', 'plan', 'local'].includes(request.kind) || typeof request.detailsComplete !== 'boolean') fail('REQUEST_MISMATCH');
    seen.add(request.requestId);
    if (Object.hasOwn(request, 'toolName') && !text(request.toolName, LIMITS.TITLE_BYTES).trim()) fail('INVALID_SCHEMA');
    if (Object.hasOwn(request, 'summary')) text(request.summary, LIMITS.REASON_BYTES);
    if (Object.hasOwn(request, 'detailText')) text(request.detailText, LIMITS.REQUEST_DETAIL_BYTES);
    if (request.kind === 'local' && request.detailsComplete) fail('DETAILS_INCOMPLETE');
    if (request.detailsComplete && request.kind !== 'question' && !request.detailText?.trim()) fail('DETAILS_INCOMPLETE');
    if (request.kind !== 'question') { if (Object.hasOwn(request, 'questions')) fail('INVALID_SCHEMA'); continue; }
    if (!Array.isArray(request.questions) || !request.questions.length || request.questions.length > LIMITS.QUESTIONS) fail('INVALID_SCHEMA');
    const questionIds = new Set();
    for (const question of request.questions) {
      exact(question, ['questionId', 'question', 'multiSelect', 'options'], ['header']);
      id(question.questionId); if (questionIds.has(question.questionId)) fail('INVALID_SCHEMA'); questionIds.add(question.questionId);
      if (!text(question.question, LIMITS.REASON_BYTES).trim() || typeof question.multiSelect !== 'boolean') fail('INVALID_SCHEMA');
      if (Object.hasOwn(question, 'header')) text(question.header, LIMITS.TITLE_BYTES);
      if (!Array.isArray(question.options) || question.options.length > LIMITS.QUESTION_OPTIONS) fail('INVALID_SCHEMA');
      const optionIds = new Set();
      for (const option of question.options) {
        exact(option, ['optionId', 'label'], ['description']); id(option.optionId);
        if (optionIds.has(option.optionId) || !text(option.label, LIMITS.REASON_BYTES).trim()) fail('INVALID_SCHEMA'); optionIds.add(option.optionId);
        if (Object.hasOwn(option, 'description')) text(option.description, LIMITS.REASON_BYTES);
      }
    }
  }
  return value;
}

/**
 * Trusted transport contract (see docs/REMOTE-PHONE.md): list/open/history,
 * send/query canonical frames, optional close/subscribe. Its output MUST have
 * already passed pairing/authentication/AEAD and the wire protocol validator.
 * This manager deliberately cannot turn a relay ACK into a tablet receipt.
 */
export function createPhoneManager({
  deviceId, transport, now = Date.now, newCommandId = randomUUID,
  maxCacheBytes = PHONE_LIMITS.CACHE_BYTES, maxItems = PHONE_LIMITS.CACHE_ITEMS,
  maxCommands = PHONE_LIMITS.COMMANDS, timeoutMs = PHONE_LIMITS.TIMEOUT_MS,
} = {}) {
  id(deviceId);
  if (!object(transport)) fail('INVALID_SCHEMA');
  for (const method of ['list', 'open', 'history', 'send', 'query']) if (typeof transport[method] !== 'function') fail('INVALID_SCHEMA');
  integer(maxCacheBytes, 2); integer(maxItems, 1); integer(maxCommands, 1); integer(timeoutMs, 1);
  if (maxCacheBytes > PHONE_LIMITS.CACHE_BYTES || maxItems > PHONE_LIMITS.CACHE_ITEMS || maxCommands > LIMITS.MAX_COMMANDS || timeoutMs > 60_000) fail('LIMIT_EXCEEDED');
  let generation = 0, revision = 0, syncSerial = 0, listSerial = 0, disposed = false;
  let connection = 'offline', phase = 'idle', verified = false, sessions = [], active = null, binding = null;
  let grant = null, run = null, pending = [], items = [], streamId = null, seq = 0;
  let historyCursor = null, historyHasMore = false, cacheTruncated = false, lastSyncedAt = null, error = null;
  let historyBusy = false, syncController = null, transportUnsubscribe = null, grantTimer = null;
  // Only explicit history pages survive a same-binding/stream live replacement.
  // Never promote the previous live window (or its pending/authority) to history.
  let liveRecords = [], historyRecords = [], cacheBytes = 2, historyLoaded = false, historySerial = 0;
  let liveHistoryCursor = null, liveHistoryHasMore = false;
  const commands = new Map(), subscribers = new Set(), operations = new Set();
  const clock = () => integer(now());
  const isReady = () => !disposed && !!active && verified && connection === 'online' && phase === 'ready'
    && grant?.state === 'active' && grant.expiresAt > clock();
  const live = () => { if (disposed) fail('OFFLINE'); };
  function snapshot() {
    return frozen(json({
      revision, generation, deviceId, connection, phase, verified, canControl: isReady(),
      cached: !!active && !verified, sessions, active, binding, grant, run, pending, items,
      streamId, seq, historyCursor, historyHasMore, historyBusy, lastSyncedAt, error,
      receipts: [...commands.values()].map((entry) => entry.receipt),
      cache: { bytes: cacheBytes, items: items.length, maxBytes: maxCacheBytes, maxItems, truncated: cacheTruncated },
    }, PHONE_LIMITS.CACHE_BYTES + 2 * LIMITS.HISTORY_PAGE_BYTES));
  }
  const envelope = (extra = {}) => Object.freeze({ snapshot: snapshot(), ...frozen(json(extra, LIMITS.HISTORY_PAGE_BYTES + LIMITS.FRAME_BYTES)) });
  function emit() {
    revision++;
    const state = snapshot();
    for (const fn of subscribers) { try { fn(state); } catch {} }
  }
  function checkGeneration(expected) { live(); if (generation !== expected) fail('RESYNC_REQUIRED'); }
  function checkScope(scope) {
    live();
    if (scope !== undefined) {
      if (!object(scope) || scope.generation !== generation || !same(scope.binding, binding)) fail('RESYNC_REQUIRED');
      checkedBinding(scope.binding, clock());
    }
  }
  function abortAll() { for (const controller of operations) controller.abort(); }
  function clearContent() {
    clearTimeout(grantTimer); grantTimer = null;
    verified = false; binding = null; run = null; pending = []; commands.clear();
    resetCache(); streamId = null; seq = 0; lastSyncedAt = null;
  }
  function invalidate(code, state = 'revoked') {
    syncSerial++; syncController?.abort(); abortAll(); clearContent();
    grant = { state, expiresAt: clock() }; phase = state; error = code;
    if (active) {
      sessions = sessions.filter((session) => session.remoteSessionId !== active.remoteSessionId);
      active = { remoteSessionId: active.remoteSessionId, deviceId: active.deviceId };
    }
    emit();
  }
  function expire() { if (grant?.state === 'active' && grant.expiresAt <= clock()) invalidate('EXPIRED', 'expired'); }
  function armExpiry() {
    clearTimeout(grantTimer); grantTimer = null;
    if (disposed || grant?.state !== 'active') return;
    const page = generation, expiresAt = grant.expiresAt;
    grantTimer = setTimeout(() => {
      grantTimer = null;
      if (disposed || generation !== page || grant?.expiresAt !== expiresAt) return;
      expire(); if (grant?.state === 'active') armExpiry();
    }, Math.min(Math.max(0, expiresAt - clock()), 2_147_483_647));
    grantTimer.unref?.();
  }
  function requireReady(scope) {
    checkScope(scope); expire();
    if (!isReady()) fail(connection !== 'online' ? 'OFFLINE' : grant?.state === 'revoked' ? 'GRANT_REVOKED' : 'RESYNC_REQUIRED');
  }
  async function operation(fn, controller = new AbortController()) {
    live();
    if (operations.size >= PHONE_LIMITS.IN_FLIGHT) fail('LIMIT_EXCEEDED');
    operations.add(controller);
    let timer, onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new PhoneError('OFFLINE'));
      if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) fail('OFFLINE'); return fn(controller.signal); }), aborted]); }
    catch (cause) { throw safeError(cause); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); operations.delete(controller); }
  }
  function resetCache() {
    liveRecords = []; historyRecords = []; items = []; cacheBytes = 2; cacheTruncated = false;
    historyLoaded = false; historySerial++; historyBusy = false;
    historyCursor = liveHistoryCursor = null; historyHasMore = liveHistoryHasMore = false;
  }
  // Charge each admitted record once, including its comma. A nonempty JSON
  // array costs 1 + sum(cost); the empty array costs exactly two brackets.
  const measured = (value) => value.map((item) => ({ item, cost: bytes(item) + 1 }));
  function cache(nextLive, nextHistory = historyRecords, requiredHistoryIds = null) {
    const liveById = new Map();
    for (const entry of nextLive) liveById.set(entry.item.id, entry);
    const current = [...liveById.values()], seen = new Set(), history = [];
    for (const entry of nextHistory) {
      if (liveById.has(entry.item.id) || seen.has(entry.item.id)) continue;
      seen.add(entry.item.id); history.push(entry);
    }
    let start = 0, end = history.length, liveCost = current.reduce((total, entry) => total + entry.cost, 0);
    let count = current.length + end, cost = liveCost + history.reduce((total, entry) => total + entry.cost, 0);
    const over = () => count > maxItems || Math.max(2, cost + 1) > maxCacheBytes;
    const dropLiveHead = () => { const size = current[start++].cost; liveCost -= size; cost -= size; count--; };
    // Under pressure prefer loaded history over accumulated older batch data,
    // but reserve the current snapshot-sized live tail (at most 50 records).
    while (start < current.length - LIMITS.HISTORY_ITEMS && over()) dropLiveHead();
    while (start < current.length && (current.length - start > maxItems || Math.max(2, liveCost + 1) > maxCacheBytes)) dropLiveHead();
    while (end > 0 && over()) { cost -= history[--end].cost; count--; }
    for (let i = 0; requiredHistoryIds && i < start; i++) {
      if (requiredHistoryIds.has(current[i].item.id)) fail('LIMIT_EXCEEDED');
    }
    // A partially admitted page would advance its opaque cursor past withheld
    // records. Fail without changing the cache/frontier instead of skipping it.
    for (let i = end; requiredHistoryIds && i < history.length; i++) {
      if (requiredHistoryIds.has(history[i].item.id)) fail('LIMIT_EXCEEDED');
    }
    const retainedHistory = history.slice(0, end);
    if (!requiredHistoryIds && historyLoaded && !retainedHistory.length) {
      historyLoaded = false; historySerial++; historyBusy = false;
      historyCursor = liveHistoryCursor; historyHasMore = liveHistoryHasMore;
    }
    if (start || end < history.length) cacheTruncated = true;
    historyRecords = retainedHistory; liveRecords = []; items = [];
    for (const entry of historyRecords) items.push(entry.item);
    for (let i = start; i < current.length; i++) { liveRecords.push(current[i]); items.push(current[i].item); }
    cacheBytes = Math.max(2, cost + 1);
  }
  function checkedSessions(value) {
    const list = Array.isArray(value) ? value : value?.sessions;
    if (!Array.isArray(list) || list.length > PHONE_LIMITS.SESSIONS) fail('LIMIT_EXCEEDED');
    const seen = new Set();
    return list.map((item) => {
      if (!object(item)) fail('INVALID_SCHEMA');
      const result = {
        remoteSessionId: id(item.remoteSessionId), deviceId: id(item.deviceId),
        title: text(item.title ?? '', LIMITS.TITLE_BYTES), deviceName: text(item.deviceName ?? '', LIMITS.TITLE_BYTES),
        grantVersion: integer(item.grantVersion, 1), state: item.state, expiresAt: integer(item.expiresAt),
        pendingCount: integer(item.pendingCount ?? 0),
      };
      if (result.deviceId === deviceId || !['invited', 'active'].includes(result.state) || seen.has(result.remoteSessionId)) fail('INVALID_SCHEMA');
      seen.add(result.remoteSessionId);
      return result;
    }).filter((item) => item.expiresAt > clock());
  }
  function checkedSnapshot(value, expected, previous) {
    const data = json(value);
    exact(data, ['binding', 'grant', 'run', 'pending', 'items', 'streamId', 'seq', 'historyCursor', 'historyHasMore'], ['title']);
    if (Object.hasOwn(data, 'title')) text(data.title, LIMITS.TITLE_BYTES);
    if (typeof data.historyHasMore !== 'boolean') fail('INVALID_SCHEMA');
    const nextBinding = checkedBinding(data.binding, clock());
    if (nextBinding.fromDeviceId !== deviceId || nextBinding.toDeviceId !== expected.deviceId) fail('DEVICE_MISMATCH');
    if (nextBinding.remoteSessionId !== expected.remoteSessionId) fail('SESSION_MISMATCH');
    if (nextBinding.grantVersion !== expected.grantVersion) fail('GRANT_MISMATCH');
    if (previous && !same(previous, nextBinding, leaseFields)) fail(previous.hostInstanceId !== nextBinding.hostInstanceId ? 'HOST_INSTANCE_MISMATCH' : 'GRANT_MISMATCH');
    if (!object(data.grant) || !['active', 'revoked', 'expired'].includes(data.grant.state)) fail('INVALID_SCHEMA');
    exact(data.grant, ['state', 'expiresAt']);
    const nextGrant = { state: data.grant.state, expiresAt: integer(data.grant.expiresAt) };
    if (nextGrant.state === 'revoked') fail('GRANT_REVOKED');
    if (nextGrant.state === 'expired' || nextGrant.expiresAt <= clock()) fail('EXPIRED');
    exact(data.run, ['runId', 'state']);
    if (!object(data.run) || data.run.runId !== nextBinding.runId || !['idle', 'running', 'waiting', 'ended', 'stopping', 'stopped', 'needs-local'].includes(data.run.state)
      || data.run.runId === null && data.run.state !== 'idle' || data.run.runId !== null && data.run.state === 'idle') fail('RUN_MISMATCH');
    checkedRequests(data.pending, nextBinding.runId);
    id(data.streamId); integer(data.seq);
    return { ...data, binding: nextBinding, grant: nextGrant, items: records(data.items), historyCursor: cursorValue(data.historyCursor ?? null) };
  }
  function applySnapshot(value, expected, previous, { allowStale = false } = {}) {
    const data = checkedSnapshot(value, expected, previous);
    // Unsolicited display pushes cannot complete a reconnect or recover a
    // failed authority check. Only the current correlated resync may do that.
    if (allowStale && !isReady()) return;
    if (previous && streamId === data.streamId && data.seq < seq) {
      // A lower-priority push can arrive after a newer correlated resync. Ignore
      // only a fully validated stale push while current authority is still ready.
      if (allowStale && isReady()) return;
      fail('RESYNC_REQUIRED');
    }
    if (!same(binding, data.binding) || streamId !== data.streamId) resetCache();
    binding = data.binding; grant = data.grant; run = data.run; pending = data.pending;
    if (active && Object.hasOwn(data, 'title')) active = { ...active, title: data.title };
    liveHistoryCursor = data.historyCursor; liveHistoryHasMore = data.historyHasMore;
    if (!historyLoaded) { historyCursor = liveHistoryCursor; historyHasMore = liveHistoryHasMore; }
    cache(measured(data.items)); streamId = data.streamId; seq = data.seq;
    lastSyncedAt = clock(); verified = true; connection = 'online'; phase = 'ready'; error = null;
    armExpiry(); emit();
  }
  async function list() {
    live(); const page = generation, serial = ++listSerial;
    const value = await operation((signal) => transport.list({ deviceId, signal }));
    checkGeneration(page);
    if (serial !== listSerial) fail('RESYNC_REQUIRED');
    sessions = checkedSessions(value); emit(); return envelope();
  }
  async function resync({ acceptInvitation = false } = {}) {
    live(); if (!active) return envelope();
    const page = generation, serial = ++syncSerial, previous = binding;
    const expected = sessions.find((entry) => entry.remoteSessionId === active.remoteSessionId);
    if (!expected) { invalidate('GRANT_NOT_ACTIVE'); fail('GRANT_NOT_ACTIVE'); }
    syncController?.abort(); syncController = new AbortController();
    verified = false; phase = 'syncing'; error = null; emit();
    try {
      const value = await operation((signal) => acceptInvitation
        ? transport.accept({ deviceId, hostDeviceId: expected.deviceId, remoteSessionId: expected.remoteSessionId, grantVersion: expected.grantVersion, signal })
        : transport.open({ deviceId, remoteSessionId: expected.remoteSessionId, resume: !!previous, binding: previous, signal }), syncController);
      checkGeneration(page);
      if (serial !== syncSerial) fail('RESYNC_REQUIRED');
      applySnapshot(value, expected, previous);
      if (acceptInvitation) { sessions = sessions.map((entry) => entry.remoteSessionId === expected.remoteSessionId ? { ...entry, state: 'active' } : entry); emit(); }
      return envelope();
    } catch (cause) {
      if (generation === page && serial === syncSerial && !disposed) {
        if (['GRANT_REVOKED', 'EXPIRED', 'HOST_INSTANCE_MISMATCH', 'GRANT_MISMATCH'].includes(cause.code)) invalidate(cause.code, cause.code === 'EXPIRED' ? 'expired' : 'revoked');
        else { verified = false; phase = connection === 'offline' ? 'offline' : 'syncing'; error = safeCode(cause); emit(); }
      }
      throw safeError(cause);
    }
  }
  async function select(remoteSessionId, acceptInvitation = false) {
    live(); id(remoteSessionId);
    if (acceptInvitation && typeof transport.accept !== 'function') fail('FORBIDDEN');
    generation++; syncSerial++; abortAll(); clearContent(); grant = null;
    const page = generation;
    active = { remoteSessionId, deviceId: null }; phase = 'opening'; error = null; emit();
    try {
      // Resolve the host through the authenticated, restricted list, not a peer-
      // supplied title or a guessed local sessionId (also supports deep links).
      await list(); checkGeneration(page);
      const selected = sessions.find((entry) => entry.remoteSessionId === remoteSessionId);
      if (!selected) { invalidate('GRANT_NOT_ACTIVE'); fail('GRANT_NOT_ACTIVE'); }
      if (!acceptInvitation && selected.state !== 'active') { phase = 'invited'; grant = { state: 'invited', expiresAt: selected.expiresAt }; error = 'GRANT_NOT_ACTIVE'; emit(); fail('GRANT_NOT_ACTIVE'); }
      active = { remoteSessionId, deviceId: selected.deviceId, title: selected.title, deviceName: selected.deviceName };
      connection = 'connecting'; return await resync({ acceptInvitation: acceptInvitation && selected.state === 'invited' });
    } catch (cause) {
      if (generation === page && !disposed && phase === 'opening') { phase = 'offline'; error = safeCode(cause); emit(); }
      throw safeError(cause);
    }
  }
  const open = (remoteSessionId) => select(remoteSessionId, false);
  const accept = (remoteSessionId) => select(remoteSessionId, true);
  async function decline(remoteSessionId) {
    live(); id(remoteSessionId);
    if (typeof transport.decline !== 'function') fail('FORBIDDEN');
    const page = generation;
    await list(); checkGeneration(page);
    const invitation = sessions.find((entry) => entry.remoteSessionId === remoteSessionId);
    if (!invitation || invitation.state !== 'invited') fail('GRANT_NOT_ACTIVE');
    const value = await operation((signal) => transport.decline({ deviceId, hostDeviceId: invitation.deviceId, remoteSessionId, grantVersion: invitation.grantVersion, signal }));
    checkGeneration(page);
    const acknowledgement = json(value);
    exact(acknowledgement, ['remoteSessionId', 'deviceId', 'grantVersion', 'state']);
    if (acknowledgement.remoteSessionId !== remoteSessionId || acknowledgement.deviceId !== invitation.deviceId
      || acknowledgement.grantVersion !== invitation.grantVersion || acknowledgement.state !== 'declined') fail('GRANT_MISMATCH');
    sessions = sessions.filter((entry) => entry.remoteSessionId !== remoteSessionId);
    if (active?.remoteSessionId === remoteSessionId) { clearContent(); active = null; grant = null; phase = 'idle'; error = null; }
    emit(); return envelope();
  }
  async function close() {
    live(); const previous = binding;
    generation++; syncSerial++; listSerial++; abortAll(); clearContent();
    active = null; grant = null; phase = 'idle'; error = null; emit();
    const page = generation;
    if (previous && typeof transport.close === 'function') {
      try { await operation((signal) => transport.close({ binding: previous, signal })); } catch {}
    }
    checkGeneration(page); return envelope();
  }
  async function history(cursor = null, scope) {
    requireReady(scope); cursorValue(cursor);
    if (historyBusy) fail('INVALID_TRANSITION');
    // A supplied cursor must extend the visible frontier, not jump to an
    // unrelated old page. Null retains the API's explicit latest-page meaning.
    if (cursor !== null && cursor !== historyCursor) fail('RESYNC_REQUIRED');
    const page = generation, expected = binding, expectedStream = streamId, serial = ++historySerial;
    historyBusy = true; emit();
    try {
      const value = await operation((signal) => transport.history({ binding: expected, cursor, limit: LIMITS.HISTORY_ITEMS, maxBytes: LIMITS.HISTORY_PAGE_BYTES, signal }));
      checkGeneration(page);
      if (serial !== historySerial || !same(expected, binding) || expectedStream !== streamId || !isReady()) fail('RESYNC_REQUIRED');
      const data = json(value);
      exact(data, ['binding', 'streamId', 'items', 'cursor', 'hasMore']);
      if (!same(checkedBinding(data.binding, clock()), expected) || data.streamId !== expectedStream) fail('RESYNC_REQUIRED');
      const pageItems = records(data.items), nextCursor = cursorValue(data.cursor);
      if (typeof data.hasMore !== 'boolean' || data.hasMore && (nextCursor === null || nextCursor === cursor) || !data.hasMore && nextCursor !== null) fail('INVALID_SCHEMA');
      const nextHistory = measured(pageItems), pageIds = new Set(pageItems.map((item) => item.id));
      // A newer explicit page replaces the same ID, but the current live value
      // always wins an overlap. No previous live-only record is retained here.
      const retained = cursor === null ? [] : historyRecords.filter((entry) => !pageIds.has(entry.item.id));
      cache(liveRecords, [...nextHistory, ...retained], pageIds);
      historyLoaded = true; historyCursor = nextCursor; historyHasMore = data.hasMore;
      emit(); return envelope({ page: { items: pageItems, cursor: nextCursor, hasMore: data.hasMore } });
    } finally { if (generation === page && serial === historySerial && !disposed) { historyBusy = false; emit(); } }
  }
  function remember(commandId, type, fingerprint, commandBinding) {
    if (commands.size >= maxCommands) fail('LEDGER_FULL');
    const entry = { type, fingerprint, binding: commandBinding, receipt: frozen({ commandId, type, status: 'sending', updatedAt: clock() }) };
    commands.set(commandId, entry); return entry;
  }
  function acceptReceipt(value, entry) {
    const frame = validateFrame(value, { now: clock(), expected: reverse(entry.binding) });
    if (frame.type !== 'control.receipt' || frame.commandId !== entry.receipt.commandId) fail('COMMAND_CONFLICT');
    const payload = frame.payload;
    if (payload.status === 'applied' && entry.type) {
      const kind = { 'message.submit': 'message', 'request.respond': 'request', 'run.stop': 'stop' }[entry.type];
      if (payload.result.kind !== kind) fail('COMMAND_CONFLICT');
      if (entry.request && (payload.result.requestId !== entry.request.requestId || payload.result.requestVersion !== entry.request.requestVersion)) fail('REQUEST_MISMATCH');
    }
    const old = entry.receipt.status;
    if (old === 'applied' || old === 'rejected') {
      if (JSON.stringify({ status: old, code: entry.receipt.code, result: entry.receipt.result }) !== JSON.stringify({ status: payload.status, code: payload.code, result: payload.result })) fail('COMMAND_CONFLICT');
      return;
    }
    // A delayed received cannot turn an unknown outcome back into a safe retry.
    if (old === 'unknown' && payload.status === 'received') return;
    if (old !== 'sending') receiptTransition(old, payload.status);
    entry.receipt = frozen({ commandId: frame.commandId, type: entry.type, ...payload, updatedAt: clock() });
  }
  function uncertain(entry, cause) {
    if (['applied', 'rejected'].includes(entry.receipt.status)) return;
    entry.receipt = frozen({ commandId: entry.receipt.commandId, type: entry.type, status: 'unknown', code: 'COMMAND_UNKNOWN', updatedAt: clock() });
    error = safeCode(cause);
  }
  async function dispatch(type, payload, commandId, scope) {
    requireReady(scope);
    commandId = commandId === undefined ? newCommandId() : id(commandId);
    const frame = createFrame(type, binding, payload, { now: clock(), commandId });
    const fingerprint = commandFingerprint(frame), old = commands.get(commandId);
    if (old) {
      if (old.fingerprint !== fingerprint || !same(old.binding, binding)) fail(old.fingerprint === null ? 'COMMAND_UNKNOWN' : 'COMMAND_CONFLICT');
      return envelope({ receipt: old.receipt }); // Never retransmit, including unknown.
    }
    const page = generation, entry = remember(commandId, type, fingerprint, binding);
    if (type === 'request.respond') entry.request = { requestId: payload.requestId, requestVersion: payload.requestVersion };
    emit();
    try {
      const value = await operation((signal) => transport.send(frame, { signal, priority: 'control' }));
      checkGeneration(page); if (!same(entry.binding, binding, leaseFields) || commands.get(commandId) !== entry) fail('RESYNC_REQUIRED');
      acceptReceipt(value, entry);
    } catch (cause) {
      checkGeneration(page); if (!same(entry.binding, binding, leaseFields) || commands.get(commandId) !== entry) fail('RESYNC_REQUIRED');
      uncertain(entry, cause);
    }
    emit(); return envelope({ receipt: entry.receipt });
  }
  async function sendText(value, commandId, scope) { return dispatch('message.submit', { text: value }, commandId, scope); }
  async function respond(requestId, response, commandId, scope) {
    requireReady(scope); id(requestId);
    const request = pending.find((entry) => entry.requestId === requestId);
    if (!request || request.state !== 'pending' || request.runId !== binding.runId) fail('REQUEST_CLOSED');
    if (request.expiresAt <= clock()) fail('REQUEST_EXPIRED');
    if (request.kind === 'local') fail('FORBIDDEN');
    if (!object(response) || response.kind !== request.kind) fail('REQUEST_MISMATCH');
    if (['allow', 'approve'].includes(response.decision) && request.detailsComplete !== true) fail('DETAILS_INCOMPLETE');
    const payload = { requestId, requestVersion: request.requestVersion, response };
    const frame = createFrame('request.respond', binding, payload, { now: clock(), commandId: commandId ?? 'response-validation' });
    assertBinding(frame, { ...grant, hostDeviceId: binding.toDeviceId, phoneDeviceId: deviceId, hostInstanceId: binding.hostInstanceId,
      remoteSessionId: binding.remoteSessionId, grantVersion: binding.grantVersion, runId: binding.runId }, { now: clock(), request });
    return dispatch('request.respond', payload, commandId, scope);
  }
  async function command({ generation: page, binding: commandBinding, type, commandId, payload } = {}) {
    const scope = { generation: page, binding: commandBinding };
    requireReady(scope);
    // Local route entry point validates the exact payload/version before any
    // convenience method can fill fields from a newer pending snapshot.
    const frame = createFrame(type, commandBinding, payload, { now: clock(), commandId });
    if (type === 'message.submit') return sendText(frame.payload.text, commandId, scope);
    if (type === 'run.stop') return stop(commandId, scope);
    if (type === 'request.respond') {
      const request = pending.find((entry) => entry.requestId === payload.requestId);
      if (!request || request.requestVersion !== payload.requestVersion) fail('REQUEST_MISMATCH');
      return respond(payload.requestId, payload.response, commandId, scope);
    }
    fail('UNSUPPORTED_TYPE');
  }
  async function stop(commandId, scope) {
    requireReady(scope);
    if (binding.runId === null || ['idle', 'ended', 'stopped'].includes(run.state)) fail('RUN_MISMATCH');
    return dispatch('run.stop', {}, commandId, scope);
  }
  async function query(commandId, scope) {
    requireReady(scope); id(commandId);
    const page = generation;
    const entry = commands.get(commandId) || remember(commandId, null, null, binding);
    if (!same(entry.binding, binding, leaseFields)) fail('RESYNC_REQUIRED');
    // The current lease must still be active, but query the recorded original
    // run even if the latest snapshot shows a newer run. Never retarget control.
    const frame = createFrame('control.query', entry.binding, {}, { now: clock(), commandId });
    try {
      const value = await operation((signal) => transport.query(frame, { signal, priority: 'control' }));
      checkGeneration(page); if (!same(entry.binding, binding, leaseFields) || commands.get(commandId) !== entry) fail('RESYNC_REQUIRED');
      acceptReceipt(value, entry);
    } catch (cause) { checkGeneration(page); if (!same(entry.binding, binding, leaseFields) || commands.get(commandId) !== entry) fail('RESYNC_REQUIRED'); uncertain(entry, cause); }
    emit(); return envelope({ receipt: entry.receipt });
  }
  async function receive(event) {
    live(); if (!object(event)) fail('INVALID_SCHEMA');
    if (event.type === 'connection') {
      if (!['online', 'offline', 'connecting'].includes(event.state)) fail('INVALID_SCHEMA');
      connection = event.state; verified = false; syncSerial++; syncController?.abort();
      if (connection !== 'online') { abortAll(); if (active) phase = connection === 'offline' ? 'offline' : 'syncing'; emit(); return envelope(); }
      if (active && !['revoked', 'expired'].includes(phase)) return resync();
      emit(); return envelope();
    }
    if (event.type === 'reset') { generation++; abortAll(); clearContent(); sessions = []; active = null; grant = null; phase = 'idle'; error = null; emit(); return envelope(); }
    expire();
    if (!active || !binding) return envelope();
    if (event.type === 'control.receipt') {
      const commandId = event.frame?.commandId, entry = commands.get(commandId);
      if (entry) { acceptReceipt(event.frame, entry); emit(); }
      return envelope();
    }
    const incoming = checkedBinding(event.binding, clock());
    if (!same(incoming, binding, leaseFields)) fail('SESSION_MISMATCH');
    if (event.type === 'host.revoke') { invalidate('GRANT_REVOKED'); return envelope(); }
    if (event.type === 'session.snapshot') {
      if (connection !== 'online') fail('RESYNC_REQUIRED');
      if (!same(incoming, event.snapshot?.binding)) fail('SESSION_MISMATCH');
      const expected = sessions.find((entry) => entry.remoteSessionId === active.remoteSessionId);
      if (!expected) fail('GRANT_NOT_ACTIVE');
      try { applySnapshot(event.snapshot, expected, binding, { allowStale: true }); return envelope(); }
      catch (cause) {
        if (['GRANT_REVOKED', 'EXPIRED', 'HOST_INSTANCE_MISMATCH', 'GRANT_MISMATCH'].includes(cause.code)) invalidate(cause.code, cause.code === 'EXPIRED' ? 'expired' : 'revoked');
        else { verified = false; phase = 'syncing'; error = safeCode(cause, 'INVALID_SCHEMA'); emit(); }
        throw safeError(cause, 'INVALID_SCHEMA');
      }
    }
    if (event.type !== 'event.batch') fail('UNSUPPORTED_TYPE');
    if (!same(incoming, binding)) fail('RUN_MISMATCH');
    if (!isReady()) fail('RESYNC_REQUIRED');
    integer(event.seq); id(event.streamId);
    if (event.streamId === streamId && event.seq <= seq) return envelope();
    if (event.streamId !== streamId || event.seq !== seq + 1) { verified = false; phase = 'syncing'; error = 'RESYNC_REQUIRED'; emit(); return resync(); }
    cache([...liveRecords, ...measured(records(event.items))]); seq = event.seq; lastSyncedAt = clock(); emit(); return envelope();
  }
  const api = Object.freeze({
    status: async () => { live(); expire(); return envelope(); }, list, open, accept, decline, close, history, command, sendText, respond, stop, query, resync, receive,
    subscribe(fn) {
      live(); if (typeof fn !== 'function') fail('INVALID_SCHEMA');
      if (subscribers.size >= PHONE_LIMITS.SUBSCRIBERS) fail('LIMIT_EXCEEDED');
      subscribers.add(fn); try { fn(snapshot()); } catch {}
      return () => subscribers.delete(fn);
    },
    dispose() { if (disposed) return; disposed = true; generation++; abortAll(); clearContent(); sessions = []; active = null; grant = null; subscribers.clear(); transportUnsubscribe?.(); },
  });
  if (typeof transport.subscribe === 'function') transportUnsubscribe = transport.subscribe((event) => {
    const page = generation;
    void receive(event).catch((cause) => { if (!disposed && generation === page && !['revoked', 'expired'].includes(phase)) {
      error = safeCode(cause, 'INVALID_SCHEMA');
      if (active && ['session.snapshot', 'event.batch'].includes(event?.type)) { verified = false; phase = 'syncing'; }
      emit();
    } });
  });
  return api;
}

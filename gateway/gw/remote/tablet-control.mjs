// The remote controller owns no model, HTTP route or global gateway state.
// Inject the original App operations; never translate a remote frame into a URL.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as protocol from './protocol.mjs';

const { ProtocolError, ERROR_CODES: C, LIMITS, validateFrame, assertBinding, createFrame,
  commandFingerprint, receiptTransition } = protocol;
const BINDING = ['fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'runId'];
const JOURNAL_BYTES = 4 * 1024 * 1024;
const isPromise = (value) => value && typeof value.then === 'function';
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (code) => { throw new ProtocolError(code); };
const bindingOf = (frame) => Object.fromEntries(BINDING.map((key) => [key, frame[key]]));
const sync = (value) => { if (isPromise(value)) { value.catch?.(() => {}); fail(C.INTERNAL_ERROR); } return value; };
const isId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
const REQUEST_BYTES = 24 * 1024;
const PENDING_BYTES = 48_000;
const PENDING_COUNT = 32;
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const originalDigest = (request) => createHash('sha256').update(canonical(request)).digest('hex');
const requestKind = (tool) => tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
const approval = (response) => response.kind === 'question' ? response.decision !== 'deny' : ['allow', 'approve'].includes(response.decision);

/** One bounded, atomic, fsynced journal. No HOME fallback and no silent reset on
 * corruption: losing a dedup record can repeat an already-dispatched action. */
class Journal {
  constructor(file, maximum) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('An absolute ledgerPath is required');
    this.file = file;
    this.maximum = maximum;
    this.entries = new Map();
    this.poisoned = false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let document;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > JOURNAL_BYTES) fail(C.INTERNAL_ERROR);
      document = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      fail(C.INTERNAL_ERROR);
    }
    if (document?.schema !== 1 || !Array.isArray(document.entries) || document.entries.length > maximum) fail(C.INTERNAL_ERROR);
    for (const entry of document.entries) {
      if (!entry || !isId(entry.commandId) || this.entries.has(entry.commandId)
        || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !protocol.CONTROL_TYPES.includes(entry.type)
        || !entry.binding || !entry.receipt || !protocol.RECEIPT_STATUSES.includes(entry.receipt.status)
        || entry.receipt.commandId !== entry.commandId || !Number.isSafeInteger(entry.receipt.updatedAt)) fail(C.INTERNAL_ERROR);
      // Reuse the protocol validator even for local disk data; do not trust a
      // malformed terminal receipt merely because the journal is private.
      try { this.frame(entry, entry.receipt.updatedAt); } catch { fail(C.INTERNAL_ERROR); }
      if (entry.type === 'request.respond' && (!entry.requestRef || !isId(entry.requestRef.requestId)
        || !Number.isSafeInteger(entry.requestRef.requestVersion) || entry.requestRef.requestVersion < 1)) fail(C.INTERNAL_ERROR);
      if (entry.receipt.status === 'applied') {
        const kind = { 'message.submit': 'message', 'request.respond': 'request', 'run.stop': 'stop' }[entry.type];
        if (entry.receipt.result.kind !== kind || kind === 'request'
          && (entry.receipt.result.requestId !== entry.requestRef.requestId
            || entry.receipt.result.requestVersion !== entry.requestRef.requestVersion)) fail(C.INTERNAL_ERROR);
      }
      this.entries.set(entry.commandId, entry);
    }
    let recovered = false;
    for (const entry of this.entries.values()) if (entry.receipt.status === 'received') {
      entry.receipt = { commandId: entry.commandId, status: 'unknown', code: C.RESYNC_REQUIRED, updatedAt: entry.receipt.updatedAt };
      recovered = true;
    }
    if (recovered) this.save();
  }

  frame(entry, now) {
    const b = entry.binding, { commandId, updatedAt, ...payload } = entry.receipt;
    return createFrame('control.receipt', { ...b, fromDeviceId: b.toDeviceId, toDeviceId: b.fromDeviceId }, payload,
      { now, commandId });
  }

  save() {
    if (this.poisoned) fail(C.INTERNAL_ERROR);
    const data = JSON.stringify({ schema: 1, entries: [...this.entries.values()] });
    if (Buffer.byteLength(data) > JOURNAL_BYTES) fail(C.LEDGER_FULL);
    const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      this.poisoned = true;
      fail(C.INTERNAL_ERROR);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
  }

  record(frame, now) {
    if (this.poisoned) fail(C.INTERNAL_ERROR);
    const fingerprint = commandFingerprint(frame), old = this.entries.get(frame.commandId);
    if (old) {
      if (old.fingerprint !== fingerprint) fail(C.COMMAND_CONFLICT);
      return { entry: old, duplicate: true };
    }
    if (this.entries.size >= this.maximum) fail(C.LEDGER_FULL);
    const entry = { commandId: frame.commandId, fingerprint, binding: bindingOf(frame), type: frame.type,
      receipt: { commandId: frame.commandId, status: 'received', updatedAt: now } };
    if (frame.type === 'request.respond') entry.requestRef = { requestId: frame.payload.requestId, requestVersion: frame.payload.requestVersion };
    this.entries.set(entry.commandId, entry);
    try { this.save(); } catch (error) {
      // A capacity rejection happened before writing. No unpersisted in-memory
      // received receipt may masquerade as a durable deduplication record.
      if (error.code === C.LEDGER_FULL) this.entries.delete(entry.commandId);
      throw error;
    } // This must finish successfully before any original operation.
    return { entry, duplicate: false };
  }

  settle(entry, payload, now) {
    if (this.poisoned) fail(C.INTERNAL_ERROR);
    receiptTransition(entry.receipt.status, payload.status);
    const next = { commandId: entry.commandId, ...payload, updatedAt: now };
    this.frame({ ...entry, receipt: next }, now);
    entry.receipt = next;
    this.save();
    return entry;
  }
}

export function createTabletControl(options) { return new TabletControl(options); }

export class TabletControl {
  constructor({ deviceId, hostInstanceId, ledgerPath, readGrant, executor, now = Date.now,
    requestTtlMs = 5 * 60_000, receiptTimeoutMs = 60_000, maxRecords = LIMITS.MAX_COMMANDS } = {}) {
    if (!isId(deviceId) || !isId(hostInstanceId) || typeof readGrant !== 'function' || typeof now !== 'function') throw new TypeError('Invalid host control dependencies');
    for (const key of ['getRun', 'getRunOfSession', 'submitText', 'answerPerm', 'abortRun', 'onEvent']) {
      if (typeof executor?.[key] !== 'function') throw new TypeError(`Missing executor.${key}`);
    }
    for (const [value, maximum] of [[maxRecords, LIMITS.MAX_COMMANDS], [requestTtlMs, 24 * 60 * 60_000], [receiptTimeoutMs, 24 * 60 * 60_000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid control limit');
    }
    this.deviceId = deviceId;
    this.hostInstanceId = hostInstanceId;
    this.readGrant = readGrant;
    this.executor = executor;
    this.now = now;
    this.requestTtlMs = requestTtlMs;
    this.receiptTimeoutMs = receiptTimeoutMs;
    this.journal = new Journal(ledgerPath, maxRecords);
    this.locks = new Map();
    this.blocked = new Set();
    this.pending = new Map();
    this.requestRefs = new WeakMap();
    this.requestVersion = 0;
    this.receivers = new Set();
    this.closedChildren = new WeakSet();
    this.closed = false;
    this.unsubscribe = executor.onEvent((event) => {
      // Original App events may fire synchronously inside dispatch; defer their
      // handling until the original queue item identity has been returned.
      queueMicrotask(() => { this.observe(event).catch(() => {}); });
    });
  }

  /** Grant updates and dispatch use this same boundary. revoke additionally
   * erects an immediate barrier, so a queued-but-not-dispatched approval loses. */
  serialize(remoteSessionId, action) {
    const previous = this.locks.get(remoteSessionId) || Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    this.locks.set(remoteSessionId, work);
    work.finally(() => { if (this.locks.get(remoteSessionId) === work) this.locks.delete(remoteSessionId); }).catch(() => {});
    return work;
  }

  revoke(remoteSessionId, mutateGrant = () => {}) {
    this.blocked.add(remoteSessionId);
    return this.serialize(remoteSessionId, () => {
      const result = sync(mutateGrant());
      const grant = sync(this.readGrant(remoteSessionId));
      // Missing/terminal grants are themselves the permanent authority check.
      // Retain a barrier if mutation failed or left a live grant, not forever
      // for every successfully retired handle. The durable journal is untouched.
      if (!grant || ['revoked', 'expired'].includes(grant.state) || grant.expiresAt <= this.now()) this.blocked.delete(remoteSessionId);
      return result;
    });
  }

  onReceipt(receiver) {
    this.receivers.add(receiver);
    return () => this.receivers.delete(receiver);
  }

  _authority(frame, peer, originalBinding = null) {
    if (this.closed) fail(C.OFFLINE);
    if (this.journal.poisoned) fail(C.INTERNAL_ERROR);
    if (frame.fromDeviceId !== peer || frame.toDeviceId !== this.deviceId) fail(C.DEVICE_MISMATCH);
    if (frame.hostInstanceId !== this.hostInstanceId) fail(C.HOST_INSTANCE_MISMATCH);
    if (this.blocked.has(frame.remoteSessionId)) fail(C.GRANT_REVOKED);
    const grant = sync(this.readGrant(frame.remoteSessionId));
    if (!grant) fail(C.GRANT_REVOKED);
    if (typeof grant.localSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(grant.localSessionId)) fail(C.SESSION_MISMATCH);
    const run = sync(this.executor.getRunOfSession(grant.localSessionId));
    const runId = run && !run.ended ? run.id : null;
    if (run && (run.sessionId !== grant.localSessionId || sync(this.executor.getRun(run.id)) !== run)) fail(C.RUN_MISMATCH);
    const binding = { ...grant, runId: originalBinding ? originalBinding.runId : runId };
    // Requests are checked against the original Map entry separately, below.
    assertBinding({ ...frame, type: 'control.query', payload: {} }, binding, { now: this.now() });
    if (originalBinding && BINDING.some((key) => originalBinding[key] !== frame[key])) fail(C.COMMAND_CONFLICT);
    return { grant: binding, run, localSessionId: grant.localSessionId };
  }

  _output(entry) {
    const b = entry.binding, grant = sync(this.readGrant(b.remoteSessionId));
    if (this.closed || this.blocked.has(b.remoteSessionId) || !grant || grant.state !== 'active'
      || grant.expiresAt <= this.now() || grant.grantVersion !== b.grantVersion
      || grant.hostInstanceId !== b.hostInstanceId || grant.phoneDeviceId !== b.fromDeviceId || grant.hostDeviceId !== b.toDeviceId) return;
    const frame = this.journal.frame(entry, this.now());
    // User callbacks are not part of the validate/dispatch critical section.
    // In particular a receipt listener cannot perform a local competing answer
    // between our final original-request check and answerPerm.
    queueMicrotask(() => {
      let current;
      try { current = sync(this.readGrant(b.remoteSessionId)); } catch { return; }
      if (this.closed || this.journal.poisoned || this.blocked.has(b.remoteSessionId) || !current || current.state !== 'active'
        || current.hostInstanceId !== b.hostInstanceId || current.grantVersion !== b.grantVersion
        || current.phoneDeviceId !== b.fromDeviceId || current.hostDeviceId !== b.toDeviceId || current.expiresAt <= this.now()) return;
      for (const receiver of this.receivers) try { receiver(frame); } catch {}
    });
  }

  _settle(entry, payload) {
    if (entry.receipt.status !== 'received' && entry.receipt.status !== 'unknown') return;
    this.journal.settle(entry, payload, this.now());
    this._output(entry);
  }

  _unknown(entry, code = C.RESYNC_REQUIRED) { this._settle(entry, { status: 'unknown', code }); }

  submit(value, authenticatedPeerId) {
    let frame;
    try {
      frame = validateFrame(value, { now: this.now() });
      if (!protocol.CONTROL_TYPES.includes(frame.type)) fail(C.UNSUPPORTED_TYPE);
    } catch (error) { return Promise.reject(error); }
    return this.serialize(frame.remoteSessionId, () => this._submit(frame, authenticatedPeerId));
  }

  _submit(frame, peer) {
    const old = this.journal.entries.get(frame.commandId);
    this._authority(frame, peer, old?.binding);
    if (old) {
      if (old.fingerprint !== commandFingerprint(frame)) fail(C.COMMAND_CONFLICT);
      return this.journal.frame(old, this.now());
    }
    const prepared = this._prepare(frame, peer);
    const { entry } = this.journal.record(frame, this.now());
    this._output(entry);
    let current;
    try {
      current = this._prepare(frame, peer);
      if (current.localSessionId !== prepared.localSessionId || current.run !== prepared.run
        || current.original !== prepared.original) fail(C.REQUEST_MISMATCH);
    } catch (error) {
      this._settle(entry, { status: 'rejected', code: error instanceof ProtocolError ? error.code : C.INTERNAL_ERROR });
      return this.journal.frame(entry, this.now());
    }
    try {
      if (frame.type === 'message.submit') this._message(frame, entry, current);
      else if (frame.type === 'request.respond') this._respond(frame, entry, current);
      else this._stop(frame, entry, current);
    } catch {
      // A thrown write may already have reached stdin. It is not a safe reason
      // to turn an uncertain operation into a retryable failure.
      if (!this.journal.poisoned) this._unknown(entry);
      else fail(C.INTERNAL_ERROR);
    }
    return this.journal.frame(entry, this.now());
  }

  query(value, authenticatedPeerId) {
    let frame;
    try {
      frame = validateFrame(value, { now: this.now() });
      if (frame.type !== 'control.query') fail(C.UNSUPPORTED_TYPE);
    } catch (error) { return Promise.reject(error); }
    return this.serialize(frame.remoteSessionId, () => {
      const entry = this.journal.entries.get(frame.commandId);
      this._authority(frame, authenticatedPeerId, entry?.binding);
      if (!entry) fail(C.COMMAND_UNKNOWN);
      const pending = this.pending.get(entry.commandId);
      if (pending) this._checkPending(entry, pending);
      return this.journal.frame(entry, this.now());
    });
  }

  /** Called only by the tablet data adapter with a trusted local session ID.
   * Budget downgrades affect both the wire descriptor and the approval gate.
   * Changing that state invalidates older versions; unchanged reads are stable. */
  describeRequests(localSessionId, { maxBytes = PENDING_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > PENDING_BYTES) throw new TypeError('Invalid pending budget');
    if (this.closed) return [];
    const run = sync(this.executor.getRunOfSession(localSessionId));
    if (!run || run.ended || run.aborted || run.sessionId !== localSessionId || sync(this.executor.getRun(run.id)) !== run) return [];
    if (!(run.perms instanceof Map)) return [];
    const references = [...run.perms.values()].map((original) => this._describe(run, original));
    // Reserve version growth so a full/local transition cannot cross the byte
    // limit or oscillate solely because its new version gained another digit.
    const fullBytes = Buffer.byteLength(JSON.stringify(references.map((r) => ({ ...r.fullDescriptor, requestVersion: Number.MAX_SAFE_INTEGER }))));
    const overBudget = references.length > PENDING_COUNT || fullBytes > maxBytes;
    for (const reference of references) {
      const budgetLocal = overBudget && reference.fullDescriptor.kind !== 'local';
      if (reference.budgetLocal === budgetLocal) continue;
      const descriptor = { ...reference.fullDescriptor, requestVersion: ++this.requestVersion };
      if (budgetLocal) this._localOnly(descriptor);
      reference.descriptor = descriptor;
      reference.budgetLocal = budgetLocal;
    }
    const descriptors = references.slice(0, PENDING_COUNT).map((r) => copy(r.descriptor));
    // Tiny caller budgets may not even fit all local-only placeholders. Omitted
    // originals are still downgraded above, never left remotely approvable.
    while (Buffer.byteLength(JSON.stringify(descriptors)) > maxBytes) descriptors.pop();
    return descriptors;
  }

  _describe(run, original) {
    const digest = originalDigest(original);
    const old = this.requestRefs.get(original);
    if (old && old.run === run && old.digest === digest
      && (original.tool !== 'ExitPlanMode' || old.planMode === run.permMode)) return old;
    const born = Number.isSafeInteger(original.at) && original.at >= 0 ? original.at : this.now();
    const expiresAt = Math.min(born + this.requestTtlMs,
      Number.isSafeInteger(original.expiresAt) ? original.expiresAt : Number.MAX_SAFE_INTEGER);
    const descriptor = { requestId: original.id, requestVersion: ++this.requestVersion, runId: run.id,
      state: 'pending', kind: requestKind(original.tool), expiresAt, detailsComplete: true,
      toolName: String(original.tool || ''), summary: String(original.description || original.tool || '').slice(0, 180) };
    const input = original.input || {};
    // The full digest includes the original input, tool-use ID, timestamps,
    // suggestions, guard and explanations, even fields not in the UI summary.
    descriptor.detailText = JSON.stringify({ toolName: original.tool, toolUseId: original.toolUseId || null,
      input, reason: original.reason || null, description: original.description || null,
      blockedPath: original.blockedPath || null, guard: original.guard || null,
      suggestions: original.suggestions || [], agentId: original.agentId || null }, null, 2);
    const questionRefs = new Map();
    // Original setMode currently proves only a stdin write, not SDK acceptance.
    // Never approve a plan remotely while an already-more-permissive SDK mode
    // might survive a rejected default-mode switch.
    let localOnly = !!original.guard?.cat?.startsWith('prompt:')
      || descriptor.kind === 'plan' && !['default', 'plan'].includes(run.permMode);
    if (descriptor.kind === 'question') {
      const questions = input.questions;
      const names = new Set();
      if (!Array.isArray(questions) || !questions.length || questions.length > 16) localOnly = true;
      else descriptor.questions = questions.map((question, qi) => {
        const questionId = `q${qi}`;
        const label = String(question.question || '');
        const options = Array.isArray(question.options) ? question.options : [];
        if (!label || names.has(label) || options.length > 32 || typeof question.multiSelect !== 'boolean') localOnly = true;
        names.add(label);
        const optionRefs = new Map();
        const wire = { questionId, question: label, multiSelect: question.multiSelect === true,
          options: options.map((option, oi) => {
            const optionId = `q${qi}:o${oi}`;
            if (typeof option.label !== 'string' || !option.label) localOnly = true;
            optionRefs.set(optionId, String(option.label || ''));
            return { optionId, label: String(option.label || ''),
              ...(option.description ? { description: String(option.description) } : {}) };
          }) };
        if (question.header) wire.header = String(question.header);
        questionRefs.set(questionId, { name: label, multiSelect: question.multiSelect === true, options: optionRefs });
        return wire;
      });
    }
    // Validate against the actual v1 Request schema, not a second shape in this
    // adapter. This synthetic snapshot is never emitted or sent to a socket.
    try { this._validateDescriptor(descriptor); } catch { localOnly = true; }
    if (Buffer.byteLength(JSON.stringify(descriptor)) >= REQUEST_BYTES) localOnly = true;
    if (localOnly) this._localOnly(descriptor);
    const reference = { run, original, digest, descriptor, fullDescriptor: copy(descriptor), budgetLocal: false,
      questionRefs, planMode: run.permMode };
    this.requestRefs.set(original, reference);
    return reference;
  }

  _localOnly(descriptor) {
    descriptor.kind = 'local';
    descriptor.detailsComplete = false;
    delete descriptor.questions;
    descriptor.detailText = 'Complete details or this sensitive operation must be handled on the tablet. Remote approval is disabled.';
    descriptor.toolName = 'Local';
    descriptor.summary = 'Needs local confirmation on the tablet';
    this._validateDescriptor(descriptor);
  }

  _validateDescriptor(descriptor) {
    const now = this.now();
    const phone = this.deviceId === 'descriptor-phone' ? 'descriptor-peer' : 'descriptor-phone';
    createFrame('session.snapshot', { fromDeviceId: this.deviceId, toDeviceId: phone,
      hostInstanceId: this.hostInstanceId, remoteSessionId: 'descriptor-validation', grantVersion: 1,
      runId: descriptor.runId }, { streamId: 'descriptor-stream', seq: 0, title: '',
      grant: { state: 'active', expiresAt: now + 1 }, run: { runId: descriptor.runId, state: 'waiting' },
      pending: [descriptor], items: [], historyCursor: null, historyHasMore: false }, { now });
  }

  _request(frame, current) {
    const { run } = current;
    const original = run.perms?.get(frame.payload.requestId);
    if (!original || original.id !== frame.payload.requestId || original.runId !== run.id
      || original.sessionId !== current.localSessionId) fail(C.REQUEST_CLOSED);
    // Never manufacture a fresh version at response time. The phone must have
    // received the descriptor of this exact original request first.
    const reference = this.requestRefs.get(original);
    if (!reference || reference.run !== run || reference.digest !== originalDigest(original)
      || reference.descriptor.requestVersion !== frame.payload.requestVersion) fail(C.REQUEST_MISMATCH);
    const request = reference.descriptor;
    assertBinding(frame, current.grant, { now: this.now(), request });
    const response = frame.payload.response;
    const kind = requestKind(original.tool);
    if (response.kind !== kind) fail(C.REQUEST_MISMATCH);
    const allowing = approval(response);
    if (allowing && !request.detailsComplete) fail(C.DETAILS_INCOMPLETE);
    if (allowing && original.guard?.cat?.startsWith('prompt:')) fail(C.FORBIDDEN);
    if (allowing && original.guard && this.executor.capabilities?.remoteOnce !== true) fail(C.FORBIDDEN);
    if (allowing && kind === 'plan' && (this.executor.capabilities?.planDefault !== true
      || !['default', 'plan'].includes(run.permMode) || reference.planMode !== run.permMode)) fail(C.FORBIDDEN);
    let answer;
    if (kind === 'question' && allowing) {
      const answers = {};
      if (!Array.isArray(response.answers) || response.answers.length !== reference.questionRefs.size) fail(C.REQUEST_MISMATCH);
      for (const supplied of response.answers) {
        const question = reference.questionRefs.get(supplied.questionId);
        if (!question || !question.multiSelect && supplied.optionIds.length > 1
          || supplied.text && supplied.optionIds.length) fail(C.REQUEST_MISMATCH);
        const choices = supplied.optionIds.map((id) => {
          if (!question.options.has(id)) fail(C.REQUEST_MISMATCH);
          return question.options.get(id);
        });
        Object.defineProperty(answers, question.name, { value: supplied.text || choices.join(', '), enumerable: true });
      }
      answer = { behavior: 'allow', answers };
    } else answer = allowing ? { behavior: 'allow' } : { behavior: 'deny', message: String(response.reason || '').slice(0, 2000) };
    return { ...current, original, reference, answer };
  }

  _prepare(frame, peer) {
    const current = this._authority(frame, peer);
    if (frame.type === 'message.submit') {
      if (this.executor.capabilities?.literalText !== true || this.executor.capabilities?.messageReplay !== true) fail(C.FORBIDDEN);
    } else {
      if (!current.run || current.run.id !== frame.runId || current.run.ended || current.run.aborted) fail(C.RUN_MISMATCH);
      if (frame.type === 'request.respond') return this._request(frame, current);
    }
    return current;
  }

  _message(frame, entry, { localSessionId, run }) {
    const item = sync(this.executor.submitText({ sessionId: localSessionId, text: frame.payload.text,
      commandId: frame.commandId, literalText: true, sourceDeviceId: frame.fromDeviceId }));
    if (item === false) return this._settle(entry, { status: 'rejected', code: C.OFFLINE });
    if (!item || !isId(item.id) || item.sessionId !== localSessionId || item.message !== frame.payload.text
      || item.literalText !== true || item.remoteCommandId !== frame.commandId || item.sourceDeviceId !== frame.fromDeviceId) return this._unknown(entry);
    this._watch(entry, { kind: 'message', itemId: item.id, runId: item.injected && run ? run.id : item.id, sessionId: localSessionId });
  }

  _respond(frame, entry, { run, original, answer }) {
    // Never route remote one-shot decisions through the local all-tools bypass
    // responder. Only the one original request is delegated to answerPerm.
    const accepted = sync(this.executor.answerPerm(run, original.id, answer,
      { remoteOnce: true, planDefault: original.tool === 'ExitPlanMode' && answer.behavior === 'allow' }));
    if (accepted === false) return this._settle(entry, { status: 'rejected', code: C.REQUEST_CLOSED });
    if (accepted !== true || run.perms?.get(original.id) === original) return this._unknown(entry);
    this._settle(entry, { status: 'applied', result: { kind: 'request', requestId: frame.payload.requestId,
      requestVersion: frame.payload.requestVersion } });
  }

  _stop(frame, entry, { run, localSessionId }) {
    const pending = { kind: 'stop', run, sessionId: localSessionId };
    this._watch(entry, pending);
    if (run.child?.once) {
      const child = run.child;
      pending.child = child;
      pending.onClose = () => {
        this.closedChildren.add(child);
        queueMicrotask(() => { this.serialize(frame.remoteSessionId, () => this._checkPending(entry, pending)).catch(() => {}); });
      };
      child.once('close', pending.onClose);
    }
    const accepted = sync(this.executor.abortRun(run));
    if (accepted === false && !run.ended) {
      this._unwatch(entry.commandId);
      return this._settle(entry, { status: 'rejected', code: C.RUN_MISMATCH });
    }
    this._checkPending(entry, pending);
  }

  _watch(entry, pending) {
    pending.until = this.now() + this.receiptTimeoutMs;
    pending.timer = setTimeout(() => { this.serialize(entry.binding.remoteSessionId, () => {
      if (entry.receipt.status === 'received') this._unknown(entry);
    }).catch(() => {}); }, this.receiptTimeoutMs);
    pending.timer.unref?.();
    this.pending.set(entry.commandId, pending);
  }

  _unwatch(commandId) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.child && pending.onClose) pending.child.removeListener('close', pending.onClose);
    this.pending.delete(commandId);
  }

  _checkPending(entry, pending) {
    if (this.closed) return;
    if (pending.kind === 'stop') {
      const run = pending.run;
      // If cancellation raced with readiness, watch a subsequently created
      // original child too; a different/new run is never substituted here.
      if (run.child?.once && pending.child !== run.child && !this.closedChildren.has(run.child)) {
        if (pending.child && pending.onClose) pending.child.removeListener('close', pending.onClose);
        const child = run.child;
        pending.child = child;
        pending.onClose = () => {
          this.closedChildren.add(child);
          queueMicrotask(() => { this.serialize(entry.binding.remoteSessionId, () => this._checkPending(entry, pending)).catch(() => {}); });
        };
        run.child.once('close', pending.onClose);
      }
      // run_end can be a seven-second forced bookkeeping cleanup. Only a real
      // child close (or an ended run that never spawned) confirms termination.
      if (run.ended && (!run.child || run.processClosed === true || this.closedChildren.has(run.child))) {
        this._unwatch(entry.commandId);
        return this._settle(entry, { status: 'applied', result: { kind: 'stop', runState: run.aborted ? 'stopped' : 'ended' } });
      }
    }
    if (entry.receipt.status === 'received' && pending.until <= this.now()) this._unknown(entry);
  }

  observe(event) {
    if (this.closed || !event || !['message_delivered', 'inject', 'run_end', 'message_unknown'].includes(event.type)) return Promise.resolve();
    const jobs = [];
    for (const [commandId, pending] of this.pending) {
      const entry = this.journal.entries.get(commandId);
      // The original inject event historically omits sessionId. Resolve only
      // through the actual current original RUNS map, never the current page or
      // peer-supplied run/session. Source hooks may also include it explicitly.
      const eventSession = event.sessionId ?? sync(this.executor.getRun(event.runId))?.sessionId;
      if (!entry || pending.sessionId !== eventSession) continue;
      jobs.push(this.serialize(entry.binding.remoteSessionId, () => {
        if (pending.kind === 'stop') {
          if (pending.run.id === event.runId) this._checkPending(entry, pending);
          return;
        }
        if (['run_end', 'message_unknown'].includes(event.type) && event.runId === pending.runId) {
          if (event.type === 'message_unknown' && (event.itemId !== pending.itemId
            || event.remoteCommandId !== commandId || event.sourceDeviceId !== entry.binding.fromDeviceId)) return;
          this._unwatch(commandId);
          if (entry.receipt.status === 'received') this._unknown(entry);
          return;
        }
        if (!['message_delivered', 'inject'].includes(event.type) || pending.itemId !== event.itemId
          || event.runId !== pending.runId || event.remoteCommandId !== commandId
          || event.sourceDeviceId !== entry.binding.fromDeviceId) return;
        this._unwatch(commandId);
        this._settle(entry, { status: 'applied', result: { kind: 'message', delivery: 'accepted' } });
      }));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  close() {
    this.closed = true;
    this.unsubscribe?.();
    for (const commandId of [...this.pending.keys()]) this._unwatch(commandId);
    this.receivers.clear();
    // Received entries intentionally remain in the durable journal. A new
    // process makes them unknown, never executable, even if shutdown was clean.
  }
}

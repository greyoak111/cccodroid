  // Restricted phone transport. Never change api()/a global base or persist a
  // relay token/private key in the WebView; the local gateway owns that channel.
  const createRemoteTransport = (options = {}) => {
    // Native WebView functions require their Window receiver even when stored
    // on another object; VM timer/fetch doubles do not expose that constraint.
    const requestFetch = (...args) => (options.fetch || fetch).call(globalThis, ...args);
    const makeEvents = options.eventSource || ((url) => typeof EventSource === 'function' ? new EventSource(url) : null);
    const now = options.now || Date.now;
    const activationId = options.activationId || (typeof remoteActivationId === 'string' ? remoteActivationId : null);
    const endpoint = (name) => '/api/remote/' + name + (activationId ? '?activation=' + encodeURIComponent(activationId) : '');
    const timers = {
      set: (...args) => (options.setTimeout || setTimeout).call(globalThis, ...args),
      clear: (...args) => (options.clearTimeout || clearTimeout).call(globalThis, ...args),
    };
    const byteSize = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const canonical = (value) => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
    const equal = (a, b) => a === b || !!a && !!b && typeof a === 'object' && typeof b === 'object'
      && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
    const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    const codes = new Set(['INVALID_SCHEMA', 'UNKNOWN_FIELD', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_TYPE', 'LIMIT_EXCEEDED', 'EXPIRED', 'NOT_YET_VALID', 'DEVICE_MISMATCH', 'HOST_INSTANCE_MISMATCH', 'SESSION_MISMATCH', 'GRANT_MISMATCH', 'GRANT_REVOKED', 'GRANT_NOT_ACTIVE', 'RUN_MISMATCH', 'REQUEST_MISMATCH', 'REQUEST_EXPIRED', 'REQUEST_CLOSED', 'DETAILS_INCOMPLETE', 'COMMAND_CONFLICT', 'COMMAND_UNKNOWN', 'INVALID_TRANSITION', 'LEDGER_FULL', 'OFFLINE', 'RESYNC_REQUIRED', 'FORBIDDEN', 'INTERNAL_ERROR', 'NOT_CONFIGURED', 'NOT_PAIRED']);
    const error = (code, extra = {}) => Object.assign(new Error(codes.has(code) ? code : 'OFFLINE'), { code: codes.has(code) ? code : 'OFFLINE', ...extra });
    const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    const validText = (value) => typeof value === 'string' && !value.includes('\0') && byteSize(value) <= 16 * 1024;
    const keys = ['fromDeviceId', 'toDeviceId', 'hostInstanceId', 'remoteSessionId', 'grantVersion', 'runId'];
    const leaseKeys = keys.filter((key) => key !== 'runId');
    const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
      && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
    function validResponse(value) {
      if (value?.kind === 'permission' || value?.kind === 'plan') {
        return exact(value, ['kind', 'decision'], ['reason'])
          && (value.kind === 'permission' ? ['allow', 'deny'] : ['approve', 'reject']).includes(value.decision)
          && (value.reason === undefined || typeof value.reason === 'string' && !value.reason.includes('\0') && byteSize(value.reason) <= 4096);
      }
      if (value?.kind !== 'question' || !exact(value, ['kind', 'answers']) || !Array.isArray(value.answers) || !value.answers.length || value.answers.length > 16) return false;
      const questionIds = new Set();
      return value.answers.every((answer) => {
        if (!exact(answer, ['questionId', 'optionIds'], ['text']) || !isId(answer.questionId) || questionIds.has(answer.questionId)
          || !Array.isArray(answer.optionIds) || answer.optionIds.length > 32 || answer.optionIds.some((id) => !isId(id)) || new Set(answer.optionIds).size !== answer.optionIds.length
          || answer.text !== undefined && (!validText(answer.text) || !answer.text.trim()) || !answer.optionIds.length && !answer.text) return false;
        questionIds.add(answer.questionId); return true;
      });
    }
    const same = (a, b, which = keys) => !!a && !!b && which.every((key) => a[key] === b[key]);
    const validBinding = (binding) => binding && keys.slice(0, 4).every((key) => isId(binding[key]))
      && Number.isSafeInteger(binding.grantVersion) && binding.grantVersion > 0 && (binding.runId === null || isId(binding.runId))
      && binding.fromDeviceId !== binding.toDeviceId;
    const fresh = () => ({
      revision: -1, generation: 0, deviceId: null, connection: 'offline', phase: 'idle', verified: false, canControl: false,
      cached: false, sessions: [], active: null, binding: null, grant: null, run: null, pending: [], items: [], receipts: [],
      streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false, lastSyncedAt: null, error: null,
    });
    let state = fresh(), epoch = 0, target = null, opening = false, draft = '', destroyed = false;
    let eventSource = null, retryTimer = null, expiryTimer = null, retryAttempt = 0;
    const listeners = new Set(), controllers = new Set(), commands = new Map(), terminal = new Set();
    let snapshotState = null, snapshotDraft = null, cachedSnapshot = null;
    const snapshot = () => {
      if (snapshotState !== state || snapshotDraft !== draft || cachedSnapshot === null) {
        cachedSnapshot = freeze(copy({ ...state, draft })); snapshotState = state; snapshotDraft = draft;
      }
      return cachedSnapshot;
    };
    const emit = () => {
      if (snapshotState !== state || snapshotDraft !== draft) { snapshotState = null; snapshotDraft = null; cachedSnapshot = null; }
      if (!listeners.size) return;
      const current = snapshot(); for (const fn of listeners) { try { fn(current); } catch {} }
    };
    const clearTimer = (name) => { if (name === 'retry' && retryTimer !== null) { timers.clear(retryTimer); retryTimer = null; } if (name === 'expiry' && expiryTimer !== null) { timers.clear(expiryTimer); expiryTimer = null; } };
    const live = () => { if (destroyed) throw error('OFFLINE'); };
    const checkEpoch = (value) => { live(); if (epoch !== value) throw error('RESYNC_REQUIRED'); };
    function stopEvents() { clearTimer('retry'); if (eventSource) { eventSource.close(); eventSource = null; } }
    function clearLocal() { draft = ''; commands.clear(); terminal.clear(); clearTimer('expiry'); }
    function abandon() { for (const controller of controllers) controller.abort(); stopEvents(); clearLocal(); }
    function ready() {
      if (!state.active || !state.verified || !state.canControl || state.connection !== 'online' || state.phase !== 'ready'
        || state.grant?.state !== 'active' || state.grant.expiresAt <= now() || !validBinding(state.binding)) throw error(state.connection !== 'online' ? 'OFFLINE' : state.grant?.state === 'revoked' ? 'GRANT_REVOKED' : 'RESYNC_REQUIRED');
      return { binding: copy(state.binding), generation: state.generation };
    }
    function localOffline(code = 'OFFLINE') {
      if (['revoked', 'expired'].includes(state.phase) || ['revoked', 'expired'].includes(state.grant?.state)) return;
      state = { ...state, connection: 'offline', phase: state.active ? 'offline' : 'idle', verified: false, canControl: false, cached: !!state.active, error: code };
      emit();
    }
    function validate(value) {
      if (!value || typeof value !== 'object' || byteSize(value) > 1024 * 1024
        || !['online', 'offline', 'connecting'].includes(value.connection) || !['idle', 'opening', 'invited', 'syncing', 'ready', 'offline', 'revoked', 'expired'].includes(value.phase)
        || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.generation) || value.generation < 0
        || !isId(value.deviceId) || typeof value.verified !== 'boolean' || typeof value.canControl !== 'boolean'
        || !Array.isArray(value.sessions) || value.sessions.length > 64 || !Array.isArray(value.items) || value.items.length > 500
        || byteSize(value.items) > 512 * 1024 || !Array.isArray(value.pending) || value.pending.length > 128
        || !Array.isArray(value.receipts) || value.receipts.length > 2048) throw error('INVALID_SCHEMA');
      if (value.error !== null && (typeof value.error !== 'string' || !codes.has(value.error))) throw error('INVALID_SCHEMA');
      for (const session of value.sessions) if (!isId(session.remoteSessionId) || !isId(session.deviceId)) throw error('INVALID_SCHEMA');
      if (value.active && (!isId(value.active.remoteSessionId) || value.active.deviceId !== null && !isId(value.active.deviceId))) throw error('INVALID_SCHEMA');
      if (value.binding && (!validBinding(value.binding) || value.binding.fromDeviceId !== value.deviceId
        || value.active?.remoteSessionId !== value.binding.remoteSessionId || value.active?.deviceId !== value.binding.toDeviceId)) throw error('DEVICE_MISMATCH');
      if (value.verified || value.canControl) {
        if (!value.verified || !validBinding(value.binding) || value.connection !== 'online' || value.phase !== 'ready' || value.grant?.state !== 'active'
          || !Number.isSafeInteger(value.grant.expiresAt) || value.grant.expiresAt <= now() || value.run?.runId !== value.binding.runId) throw error('RESYNC_REQUIRED');
        const seen = new Set();
        for (const request of value.pending) {
          if (!isId(request.requestId) || seen.has(request.requestId) || !Number.isSafeInteger(request.requestVersion) || request.requestVersion < 1
            || request.runId !== value.binding.runId || request.runId === null || request.state !== 'pending'
            || !Number.isSafeInteger(request.expiresAt) || !['permission', 'question', 'plan', 'local'].includes(request.kind) || typeof request.detailsComplete !== 'boolean') throw error('REQUEST_MISMATCH');
          seen.add(request.requestId);
        }
      }
      return copy(value);
    }
    function armExpiry(page) {
      clearTimer('expiry');
      if (state.grant?.state !== 'active') return;
      const delay = Math.max(0, state.grant.expiresAt - now());
      expiryTimer = timers.set(() => {
        expiryTimer = null;
        if (page !== epoch || destroyed) return;
        if (state.grant?.state === 'active' && state.grant.expiresAt <= now()) {
          state = { ...state, phase: 'expired', grant: { state: 'expired', expiresAt: now() }, verified: false, canControl: false, cached: false,
            items: [], pending: [], receipts: [], binding: null, run: null, streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false };
          clearLocal(); emit();
        } else if (state.grant?.state === 'active') armExpiry(page);
      }, Math.min(delay, 2_147_483_647));
    }
    function accept(value, page, { allowOpen = false } = {}) {
      checkEpoch(page);
      let next = validate(value);
      const receivedTarget = next.active?.remoteSessionId ?? null;
      // The boot subscription can see the empty pre-configuration sentinel
      // before a real local identity exists. This is not a device rebinding of
      // an established remote view or authority.
      const initializingIdentity = state.deviceId === 'remote-unconfigured' && target === null && state.phase === 'idle'
        && !state.active && !state.binding && !state.grant && !state.run && !state.verified && !state.canControl
        && !state.sessions.length && !state.items.length && !state.pending.length && !state.receipts.length;
      if (state.deviceId && next.deviceId !== state.deviceId && !initializingIdentity) throw error('DEVICE_MISMATCH');
      if (next.revision < state.revision || next.generation < state.generation) return false;
      // An explicit backend unpair/reset clears the current view as well. A
      // different session can never become selected through an unsolicited event.
      const reset = !opening && target !== null && receivedTarget === null && next.phase === 'idle'
        && next.binding === null && next.generation > state.generation;
      if (reset) { epoch++; abandon(); target = null; opening = false; state = next; emit(); startEvents(epoch); return true; }
      // Replies and the event source belong to the page/target that created them.
      if (receivedTarget !== target || opening && !allowOpen) return false;
      if (!opening && state.binding && next.binding && next.generation === state.generation && !same(state.binding, next.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
      if (next.revision === state.revision && state.verified === false && next.verified && !allowOpen) return false;
      const previousDraft = draft;
      if (['revoked', 'expired'].includes(next.phase) || ['revoked', 'expired'].includes(next.grant?.state)) {
        clearLocal(); next = { ...next, verified: false, canControl: false, cached: false, items: [], pending: [], receipts: [], binding: null, run: null, streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false };
      }
      // Compare all validated fields, not revision alone: the same backend
      // revision may legitimately restore a locally-offline state via allowOpen.
      if (equal(state, next) && previousDraft === draft) return true;
      state = next;
      for (const receipt of state.receipts) {
        const command = commands.get(receipt.commandId);
        if (command) command.latest = receipt;
      }
      armExpiry(page);
      emit(); return true;
    }
    async function request(path, method, body, page, { timeout = 20_000 } = {}) {
      live(); if (controllers.size >= 8) throw error('LIMIT_EXCEEDED');
      const controller = new AbortController(); controllers.add(controller);
      const timer = timers.set(() => controller.abort(), timeout);
      try {
        const response = await requestFetch(endpoint(path), {
          method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        checkEpoch(page);
        const length = Number(response.headers?.get?.('content-length'));
        if (length > 1024 * 1024) throw error('LIMIT_EXCEEDED');
        const value = await response.json(); checkEpoch(page);
        if (byteSize(value) > 1024 * 1024) throw error('LIMIT_EXCEEDED');
        if (!response.ok) throw error(value?.error?.code || value?.code || 'OFFLINE', { status: response.status });
        if (!value || typeof value !== 'object' || !value.snapshot) throw error('INVALID_SCHEMA');
        return value;
      } catch (cause) { checkEpoch(page); throw error(cause?.code || 'OFFLINE', Number.isInteger(cause?.status) ? { status: cause.status } : {}); }
      finally { timers.clear(timer); controllers.delete(controller); }
    }
    async function readStatus(page = epoch, allowOpen = false) {
      const value = await request('status', 'GET', undefined, page); accept(value.snapshot, page, { allowOpen }); return snapshot();
    }
    function retry(page) {
      if (retryTimer !== null || destroyed || page !== epoch || !listeners.size) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt++, 5));
      retryTimer = timers.set(async () => {
        retryTimer = null; if (page !== epoch || destroyed || !listeners.size) return;
        try {
          // The backend only returns ready after its own authenticated resume.
          // EventSource.onopen by itself is never evidence of authorization.
          await readStatus(page, true); checkEpoch(page); startEvents(page);
        } catch { if (page === epoch && !destroyed) { localOffline(); retry(page); } }
      }, delay);
    }
    function startEvents(page = epoch) {
      if (destroyed || eventSource || !listeners.size || opening || page !== epoch) return;
      clearTimer('retry');
      try {
        const stream = makeEvents(endpoint('events'));
        if (!stream) { retry(page); return; }
        eventSource = stream;
        const onSnapshot = (event) => {
          if (page !== epoch || destroyed || eventSource !== stream) return;
          try {
            if (typeof event.data !== 'string' || byteSize(event.data) > 1024 * 1024) throw error('LIMIT_EXCEEDED');
            const accepted = accept(JSON.parse(event.data), page, { allowOpen: true });
            if (accepted) retryAttempt = 0;
          } catch { if (page === epoch) { localOffline('RESYNC_REQUIRED'); stream.close(); eventSource = null; retry(page); } }
        };
        if (typeof stream.addEventListener === 'function') stream.addEventListener('snapshot', onSnapshot);
        stream.onmessage = onSnapshot;
        stream.onerror = () => {
          if (page !== epoch || destroyed || eventSource !== stream) return;
          stream.close(); eventSource = null; localOffline(); retry(page);
        };
        // Deliberately no onopen => ready transition.
      } catch { localOffline(); retry(page); }
    }
    function newId() {
      if (options.newCommandId) return options.newCommandId();
      const crypto = globalThis.crypto;
      if (crypto?.randomUUID) return crypto.randomUUID();
      if (!crypto?.getRandomValues) throw error('INTERNAL_ERROR');
      return 'phone-' + [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    function putReceipt(receipt) {
      if (!receipt || !isId(receipt.commandId) || !['sending', 'received', 'applied', 'rejected', 'unknown'].includes(receipt.status)) throw error('INVALID_SCHEMA');
      const command = commands.get(receipt.commandId), type = command?.type || receipt.type;
      if (receipt.status === 'applied') {
        const expected = { 'message.submit': 'message', 'request.respond': 'request', 'run.stop': 'stop' }[type];
        if (!receipt.result || expected && receipt.result.kind !== expected
          || receipt.result.kind === 'stop' && !['stopped', 'ended'].includes(receipt.result.runState)
          || receipt.result.kind === 'message' && !['accepted', 'queued'].includes(receipt.result.delivery)
          || receipt.result.kind === 'request' && command?.request && (receipt.result.requestId !== command.request.requestId || receipt.result.requestVersion !== command.request.requestVersion)) throw error('INVALID_SCHEMA');
      }
      const previous = command?.latest;
      if (previous && ['applied', 'rejected'].includes(previous.status)) return freeze(copy(previous));
      if (previous?.status === 'unknown' && ['sending', 'received'].includes(receipt.status)) return freeze(copy(previous));
      if (command) command.latest = copy(receipt);
      const list = state.receipts.filter((entry) => entry.commandId !== receipt.commandId);
      state = { ...state, receipts: [...list, receipt].slice(-256) }; emit(); return freeze(copy(receipt));
    }
    function uncertain(commandId, type) { return putReceipt({ commandId, type, status: 'unknown', code: 'COMMAND_UNKNOWN', updatedAt: now() }); }
    async function command(type, payload, commandId) {
      const scope = ready(), page = epoch;
      commandId = commandId === undefined ? newId() : commandId;
      if (!isId(commandId)) throw error('INVALID_SCHEMA');
      const fingerprint = canonical({ type, payload, binding: scope.binding });
      if (terminal.has(commandId)) throw error('COMMAND_UNKNOWN', { commandId });
      const old = commands.get(commandId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw error('COMMAND_CONFLICT', { commandId });
        if (old.settled) return freeze(copy(old.latest));
        return old.promise; // Same click/timeout cannot queue a second send.
      }
      if (commands.size + terminal.size >= 256) throw error('LEDGER_FULL');
      const entry = { fingerprint, type, promise: null, latest: null, settled: false, ...(type === 'request.respond' ? { request: { requestId: payload.requestId, requestVersion: payload.requestVersion } } : {}) };
      commands.set(commandId, entry);
      putReceipt({ commandId, type, status: 'sending', updatedAt: now() });
      entry.promise = (async () => {
        let receipt;
        try {
          const value = await request('command', 'POST', { ...scope, type, commandId, payload }, page);
          checkEpoch(page);
          if (!same(state.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
          if (!value.snapshot.binding || !same(value.snapshot.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
          accept(value.snapshot, page);
          if (!value.receipt || value.receipt.commandId !== commandId) throw error('INVALID_SCHEMA');
          receipt = putReceipt(value.receipt);
        } catch (cause) {
          checkEpoch(page);
          if (!same(state.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
          receipt = uncertain(commandId, type);
        }
        entry.settled = true;
        if (receipt.status === 'applied' && type === 'message.submit' && draft === payload.text) { draft = ''; emit(); }
        return receipt;
      })();
      return entry.promise;
    }
    async function select(remoteSessionId, path) {
      live(); if (!isId(remoteSessionId)) throw error('INVALID_SCHEMA');
      epoch++; abandon(); target = remoteSessionId; opening = true;
      const page = epoch;
      state = { ...fresh(), active: { remoteSessionId, deviceId: null }, phase: 'opening', connection: 'connecting' }; emit();
      try {
        const value = await request(path, 'POST', { remoteSessionId }, page);
        checkEpoch(page);
        if (!accept(value.snapshot, page, { allowOpen: true })) throw error('RESYNC_REQUIRED');
        return snapshot();
      } catch (cause) { if (page === epoch && !destroyed) localOffline(cause.code); throw cause; }
      finally { if (page === epoch && !destroyed) { opening = false; startEvents(page); } }
    }
    const api = {
      async status() { live(); return readStatus(); },
      async list() { live(); const page = epoch; const value = await request('sessions', 'GET', undefined, page); accept(value.snapshot, page); return snapshot().sessions; },
      async open(remoteSessionId) { return select(remoteSessionId, 'open'); },
      async accept(remoteSessionId) { return select(remoteSessionId, 'accept'); },
      async decline(remoteSessionId) {
        live(); if (!isId(remoteSessionId)) throw error('INVALID_SCHEMA');
        const page = epoch, wasTarget = target === remoteSessionId;
        const value = await request('decline', 'POST', { remoteSessionId }, page); checkEpoch(page);
        if (wasTarget && value.snapshot.active === null) { epoch++; abandon(); target = null; opening = false; accept(value.snapshot, epoch, { allowOpen: true }); startEvents(epoch); }
        else accept(value.snapshot, page);
        return snapshot();
      },
      async close() {
        live(); epoch++; abandon(); target = null; opening = false;
        const page = epoch; state = fresh(); emit();
        try { const value = await request('close', 'POST', {}, page); accept(value.snapshot, page, { allowOpen: true }); return snapshot(); }
        finally { if (page === epoch && !destroyed) startEvents(page); }
      },
      async history(cursor = null) {
        const scope = ready(), page = epoch;
        if (cursor !== null && (typeof cursor !== 'string' || byteSize(cursor) > 1024)) throw error('INVALID_SCHEMA');
        const value = await request('history', 'POST', { ...scope, cursor }, page); checkEpoch(page);
        if (!same(state.binding, scope.binding)) throw error('RESYNC_REQUIRED');
        accept(value.snapshot, page);
        if (!value.page || !Array.isArray(value.page.items) || value.page.items.length > 50 || byteSize(value.page) > 256 * 1024) throw error('INVALID_SCHEMA');
        return freeze(copy(value.page));
      },
      async sendText(text, commandId) { if (!validText(text) || !text.trim()) throw error('INVALID_SCHEMA'); return command('message.submit', { text }, commandId); },
      async respond(requestId, response, commandId) {
        ready(); if (!isId(requestId)) throw error('INVALID_SCHEMA');
        const request = state.pending.find((entry) => entry.requestId === requestId);
        if (!request || request.state !== 'pending' || request.runId !== state.binding.runId) throw error('REQUEST_CLOSED');
        if (request.expiresAt <= now()) throw error('REQUEST_EXPIRED');
        if (request.kind === 'local') throw error('FORBIDDEN');
        if (!response || response.kind !== request.kind) throw error('REQUEST_MISMATCH');
        if (!validResponse(response)) throw error('INVALID_SCHEMA');
        if ((response.kind === 'question' || ['allow', 'approve'].includes(response.decision)) && !request.detailsComplete) throw error('DETAILS_INCOMPLETE');
        if (response.kind === 'question') {
          if (!Array.isArray(request.questions) || response.answers.length !== request.questions.length) throw error('REQUEST_MISMATCH');
          for (const question of request.questions) {
            const answer = response.answers.find((entry) => entry.questionId === question.questionId);
            if (!answer || !question.multiSelect && answer.optionIds.length > 1 || answer.optionIds.some((id) => !question.options.some((option) => option.optionId === id))) throw error('REQUEST_MISMATCH');
          }
        }
        return command('request.respond', { requestId, requestVersion: request.requestVersion, response }, commandId);
      },
      async stop(commandId) { ready(); if (!state.binding.runId || ['idle', 'ended', 'stopped'].includes(state.run.state)) throw error('RUN_MISMATCH'); return command('run.stop', {}, commandId); },
      async query(commandId) {
        const scope = ready(), page = epoch; if (!isId(commandId)) throw error('INVALID_SCHEMA');
        if (!commands.has(commandId) && !terminal.has(commandId) && terminal.size + commands.size >= 256) throw error('LEDGER_FULL');
        if (!commands.has(commandId)) terminal.add(commandId);
        let receipt;
        try {
          const value = await request('query', 'POST', { ...scope, commandId }, page); checkEpoch(page);
          if (!same(state.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
          if (!value.snapshot.binding || !same(value.snapshot.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED');
          accept(value.snapshot, page);
          if (!value.receipt || value.receipt.commandId !== commandId) throw error('INVALID_SCHEMA');
          receipt = putReceipt(value.receipt);
        } catch { checkEpoch(page); if (!same(state.binding, scope.binding, leaseKeys)) throw error('RESYNC_REQUIRED'); receipt = uncertain(commandId, commands.get(commandId)?.type ?? null); }
        return receipt;
      },
      subscribe(fn) {
        live(); if (typeof fn !== 'function') throw error('INVALID_SCHEMA'); if (listeners.size >= 64) throw error('LIMIT_EXCEEDED');
        listeners.add(fn); try { fn(snapshot()); } catch {} startEvents();
        return () => { listeners.delete(fn); if (!listeners.size) stopEvents(); };
      },
      setDraft(text) { live(); if (!validText(text)) throw error('LIMIT_EXCEEDED'); if (draft !== text) { draft = text; emit(); } return draft; },
      getDraft() { return draft; },
      destroy() { if (destroyed) return; epoch++; abandon(); destroyed = true; state = fresh(); snapshotState = null; snapshotDraft = null; cachedSnapshot = null; listeners.clear(); },
    };
    return Object.freeze(api);
  };
  const remoteTransport = createRemoteTransport();
  // These explicit names are also useful to isolated VM/browser contract tests.
  if (typeof window !== 'undefined') { window.remoteTransport = remoteTransport; window.createRemoteTransport = createRemoteTransport; }

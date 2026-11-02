  // Small, fixed-role host for the optional remote-session component. Business
  // UI/transport is loaded only from the version-pinned same-origin component API.
  const { remoteComponent, remoteView, remoteSettings, remoteHosting, remoteTransport } = (() => {
    const BASE = "/api/components/remote-session", HOST_API = 1, POLL_MS = 4000;
    const states = new Set(["absent", "disabled", "active", "incompatible", "error", "retiring"]);
    const inactive = () => Object.assign(new Error(t("远程托管组件未启用或尚未就绪")), { code: "NOT_CONFIGURED" });
    const initial = () => ({ ok: true, id: "remote-session", hostApi: HOST_API, installed: false, enabled: false, state: "absent", version: null, assetVersion: null, activationId: null, error: null });
    let feature = Object.freeze(initial()), runtime = null, generation = 0, requestSeq = 0, poll = null;
    let booted = false, watched = false, lastPublished = "", ready = Promise.resolve(false), statusAbort = null;
    const subscribers = new Set();
    const enabled = () => !!(feature.state === "active" && feature.enabled && runtime?.ready && !runtime.dead);
    const status = () => Object.freeze({ ...feature });
    const emptySnapshot = () => Object.freeze({ revision: -1, generation, deviceId: null, connection: "offline", phase: "idle", verified: false, canControl: false, cached: false, sessions: [], active: null, binding: null, grant: null, run: null, pending: [], items: [], receipts: [], streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false, lastSyncedAt: null, error: "NOT_CONFIGURED", draft: "" });
    const ignore = (value) => { if (value && typeof value.catch === "function") value.catch(() => {}); };
    const current = (r) => runtime === r && r.generation === generation && !r.dead && feature.state === "active" && feature.assetVersion === r.version && feature.activationId === r.activationId;

    // The unmodified component registers DOM/global listeners and a body
    // observer. Capture only while its synchronous code runs, never over await
    // or while a script is downloading; restore the browser APIs immediately.
    let capture = null;
    function pruneDetached(r) {
      if (r.dead) return; // Retirement removes every listener, including globals.
      for (let i = r.listeners.length - 1; i >= 0; i--) {
        const entry = r.listeners[i], target = entry.target;
        if (target === window || target === document || !target?.nodeType) continue;
        if (target.isConnected) { entry.connected = true; continue; }
        // Components register listeners before appending a new modal. A node
        // must have been seen connected before detachment permits disposal;
        // removal records alone can also include never-mounted descendants.
        if (!entry.connected) continue;
        entry.remove.call(target, entry.type, entry.wrapped, entry.capture);
        r.listeners.splice(i, 1);
      }
      for (const element of r.overlays) {
        if (element.isConnected) r.connectedOverlays.add(element);
        else if (r.connectedOverlays.has(element)) { r.overlays.delete(element); r.connectedOverlays.delete(element); }
      }
    }
    function beginCapture(r) {
      if (capture) { if (capture.owner === r) { capture.depth++; return () => endCapture(capture); } return () => {}; }
      const c = { owner: r, depth: 1, restore: [] }; capture = c;
      const patch = (object, key, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
        c.restore.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
      };
      const ownsTarget = (receiver) => receiver === window || receiver === document || [document.getElementById("remotePage"), document.getElementById("remoteSettingsPage"), ...r.overlays].some((element) => element && (receiver === element || receiver?.nodeType && element.contains(receiver))) || receiver?.classList?.contains("rv-modal") || receiver?.classList?.contains("rs-overlay");
      const targets = window.EventTarget?.prototype ? [window.EventTarget.prototype] : [window, document, document.getElementById("remotePage"), document.getElementById("remoteSettingsPage"), ...r.overlays].filter(Boolean);
      for (const target of targets) {
        const add = target.addEventListener, remove = target.removeEventListener;
        if (typeof add !== "function" || typeof remove !== "function") continue;
        patch(target, "addEventListener", function (type, listener, options) {
          if (!listener) return;
          const receiver = this || window, useCapture = typeof options === "boolean" ? options : !!options?.capture;
          if (!ownsTarget(receiver)) return add.call(receiver, type, listener, options);
          let entry = r.listeners.find((x) => x.target === receiver && x.type === type && x.listener === listener && x.capture === useCapture);
          if (!entry) {
            const wrapped = function (event) {
              if (!current(r)) return;
              return inComponent(r, () => typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event));
            };
            entry = { target: receiver, type, listener, wrapped, capture: useCapture, remove, connected: !!receiver.isConnected }; r.listeners.push(entry);
          }
          return add.call(receiver, type, entry.wrapped, options);
        });
        patch(target, "removeEventListener", function (type, listener, options) {
          const receiver = this || window, useCapture = typeof options === "boolean" ? options : !!options?.capture;
          const entry = r.listeners.find((x) => x.target === receiver && x.type === type && x.listener === listener && x.capture === useCapture);
          if (entry) { r.listeners.splice(r.listeners.indexOf(entry), 1); return remove.call(receiver, type, entry.wrapped, options); }
          return remove.call(receiver, type, listener, options);
        });
      }
      const NativeObserver = window.MutationObserver;
      if (typeof NativeObserver === "function") patch(window, "MutationObserver", class extends NativeObserver {
        constructor(fn) { super((records, observer) => { if (current(r)) inComponent(r, () => fn(records, observer)); }); r.observers.add(this); }
      });
      return () => endCapture(c);
    }
    function endCapture(c) {
      if (!c || capture !== c || --c.depth > 0) return;
      for (const restore of c.restore.reverse()) restore();
      capture = null;
      // Synchronous innerHTML/replaceChildren renders have finished. Reclaim
      // removed controls now, without interrupting same-turn DOM reparenting.
      pruneDetached(c.owner);
    }
    function inComponent(r, fn) { const finish = beginCapture(r); try { return fn(); } finally { finish(); } }
    function finishBundle(r) {
      if (r.finishCapture) { const finish = r.finishCapture; r.finishCapture = null; finish(); }
    }

    function publish() {
      const on = enabled(), button = document.querySelector('#set-cats [data-cat="remote"]');
      if (button) { button.hidden = !on; button.classList.toggle("hidden", !on); }
      const category = document.querySelector('.set-cat[data-cat="remote"]:not(.mo-ghost)');
      if (category && !on) category.classList.add("hidden");
      if (typeof renderSideNav === "function") renderSideNav();
      if (typeof setOpen !== "undefined" && setOpen && typeof paintSetCats === "function") paintSetCats();
      const key = JSON.stringify([status(), on]);
      if (key !== lastPublished) {
        lastPublished = key;
        document.dispatchEvent(new CustomEvent("cc:remote-component", { detail: { component: status(), ready: on } }));
      }
    }
    function resetRoot(id) {
      const old = document.getElementById(id); if (!old) return;
      // Replacing, not just emptying, drops listeners/rsReady belonging to the
      // retired bundle. No private draft, form or old closure survives a reload.
      const next = document.createElement("div"); next.id = id; next.hidden = true;
      next.className = id === "remoteSettingsPage" ? "sblock hidden" : "hidden";
      old.replaceWith(next);
    }
    function retire() {
      const r = runtime; runtime = null; generation++;
      if (r) {
        r.dead = true; r.ready = false; r.disposing = true; finishBundle(r);
        clearTimeout(r.timeout);
        for (const entry of subscribers) { entry.off?.(); entry.off = null; }
        r.unreadOff?.(); r.unreadOff = null;
        const overlays = [...r.overlays], roles = { ...r.exported, ...r.roles };
        // destroy first: view.close() also calls transport.close(), which must
        // not start another remote request while a generation is being retired.
        try { roles.transport?.destroy?.(); } catch {}
        for (const role of ["view", "settings", "hosting"]) {
          try { if (roles[role]?.close) ignore(inComponent(r, () => roles[role].close())); } catch {}
        }
        for (const controller of r.controllers) controller.abort();
        r.controllers.clear();
        for (const observer of r.observers) observer.disconnect();
        r.observers.clear();
        for (const x of r.listeners) x.remove.call(x.target, x.type, x.wrapped, x.capture);
        r.listeners.length = 0;
        for (const element of overlays) { try { OV.close(element); } catch {} element.replaceChildren(); element.remove(); }
        r.overlays.clear(); r.connectedOverlays.clear(); r.disposing = false;
        r.script?.remove(); r.css?.remove();
        r.settle(false);
        r.roles = null; r.exported = {};
      }
      // Animation clones retain text too; remove only remote-owned clones.
      document.querySelectorAll('.mo-ghost#tab-remote, .mo-ghost[data-cat="remote"], .mo-ghost #remotePage, .mo-ghost #remoteSettingsPage').forEach((element) => element.remove());
      resetRoot("remotePage"); resetRoot("remoteSettingsPage");
      document.getElementById("tab-remote")?.classList.add("hidden");
      document.documentElement.classList.remove("pg-remote");
      if (typeof remotePendingCount !== "undefined") remotePendingCount = 0;
      if (typeof curPage !== "undefined" && curPage === "remote") closePage();
      if (typeof setCatOpen !== "undefined" && setCatOpen === "remote") {
        if (typeof closeSettings === "function") closeSettings();
        setCatOpen = null;
      }
      // A session menu opened before disable must not retain its hosting item.
      if (r) OV.closeAll("menu");
      for (const entry of subscribers) { try { entry.fn(emptySnapshot()); } catch {} }
    }
    function fail(r, message) {
      if (!current(r)) return;
      const error = String(message || t("远程组件界面加载失败，请刷新组件状态后重试")).slice(0, 1024);
      retire();
      feature = Object.freeze({ ...feature, state: "error", error }); publish();
    }
    function parseStatus(value) {
      if (!value || value.ok !== true || value.id !== "remote-session" || typeof value.installed !== "boolean" || typeof value.enabled !== "boolean" || !states.has(value.state)) throw new Error(t("远程组件状态不完整，请刷新后重试"));
      const result = { ok: true, id: "remote-session", hostApi: value.hostApi, installed: value.installed, enabled: value.enabled, state: value.state,
        version: typeof value.version === "string" ? value.version.slice(0, 128) : null,
        assetVersion: typeof value.assetVersion === "string" ? value.assetVersion : null,
        activationId: typeof value.activationId === "string" && /^[a-f0-9-]{36}$/.test(value.activationId) ? value.activationId : null,
        error: typeof value.error === "string" ? value.error.slice(0, 1024) : null };
      if (value.hostApi !== HOST_API) { result.state = "incompatible"; result.error = t("远程组件需要 remoteSession hostApi 1 宿主支持，请更新应用。"); }
      else if (result.state === "active" && (!result.installed || !result.enabled || !result.version || !result.activationId || !/^[a-f0-9]{64}$/.test(result.assetVersion || ""))) throw new Error(t("远程组件版本信息不完整，未加载界面"));
      return Object.freeze(result);
    }
    function showSettings(r) {
      if (!current(r) || !r.ready) return;
      const page = document.getElementById("remoteSettingsPage");
      if (page) { page.hidden = false; page.classList.remove("hidden"); }
      if (typeof setOpen !== "undefined" && setOpen && setCatOpen === "remote") return;
      // The business view can call its own lexical settings.open(). Show the
      // core category without asking it to open a second time in paintSetCats.
      r.settingsOpening = true;
      try { openPage("settings", "remote"); } finally { r.settingsOpening = false; }
    }
    function componentContext(r) {
      const contextApi = async (path, options = {}) => {
        if (!current(r) || !r.ready) throw inactive();
        if (typeof path !== "string" || !/^\/api\/remote\/(?:settings|pairing|hosting)(?:\?[^#]*)?$/.test(path) || !["GET", "POST"].includes(options.method || "GET")) throw inactive();
        if (path === "/api/remote/settings" && (options.method || "GET") === "GET") showSettings(r);
        const controller = new AbortController(), abort = () => controller.abort();
        r.controllers.add(controller);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) controller.abort();
        try {
          const result = await api(path, { ...options, headers: { ...options.headers, "x-cc-remote-activation": r.activationId }, signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
          if (!current(r) || !r.ready || controller.signal.aborted) throw inactive();
          return result;
        } finally { r.controllers.delete(controller); options.signal?.removeEventListener("abort", abort); }
      };
      const overlay = Object.freeze({
        open(element, options = {}) {
          if (!current(r) || !r.ready || !element?.classList || !(element.classList.contains("rv-modal") || element.classList.contains("rs-overlay"))) throw inactive();
          // OV calls onClose before its exit animation removes the DOM. Keep
          // closing overlays/listeners owned until detached; one shared watcher
          // reclaims them rather than retaining a watcher for every closed sheet.
          r.overlays.add(element);
          return inComponent(r, () => {
            const opened = OV.open(element, { ...options, onClose: () => {
              if (!r.dead || r.disposing) inComponent(r, () => options.onClose?.());
            } });
            // Witness this mount even if an outer synchronous handler closes
            // the newly opened modal before its capture finishes.
            if (element.isConnected) r.connectedOverlays.add(element);
            for (const entry of r.listeners) if (entry.target?.isConnected) entry.connected = true;
            return opened;
          });
        },
        close(element) { if (r.overlays.has(element)) OV.close(element); },
      });
      return Object.freeze({ t, api: contextApi, OV: overlay, activationId: r.activationId });
    }
    function validRoles(value) {
      const methods = { view: ["open", "close", "refresh"], transport: ["status", "list", "open", "accept", "decline", "close", "history", "sendText", "respond", "stop", "query", "subscribe", "setDraft", "getDraft", "destroy"], settings: ["open", "close"], hosting: ["open", "refresh", "close"] };
      return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => Object.hasOwn(methods, key) || key === "assetVersion")
        && Object.entries(methods).every(([role, names]) => value[role] && names.every((name) => typeof value[role][name] === "function"));
    }
    function loadingScript() {
      const r = runtime, script = document.currentScript;
      if (!r || !current(r) || r.roles || script !== r.script || !script?.isConnected || script.dataset.remoteGeneration !== String(r.generation) || script.dataset.remoteVersion !== r.version) return null;
      return r;
    }
    const host = Object.freeze({
      get context() {
        const r = loadingScript(); if (!r || r.contextRead) throw inactive();
        r.contextRead = true; r.finishCapture = beginCapture(r);
        // Also restore after an exception or a bundle that forgets to mount.
        Promise.resolve().then(() => finishBundle(r));
        return componentContext(r);
      },
      mount(value) {
        const r = loadingScript();
        if (!r || !r.contextRead || !validRoles(value) || value.assetVersion !== undefined && value.assetVersion !== r.version) { if (r) finishBundle(r); return false; }
        r.roles = { view: value.view, transport: value.transport, settings: value.settings, hosting: value.hosting };
        finishBundle(r); return true;
      },
    });
    Object.defineProperty(window, "CCRemoteComponentHost", { value: host, configurable: false, writable: false });

    function attachSubscriber(r, entry) {
      if (!enabled() || !current(r)) return;
      entry.off = inComponent(r, () => r.roles.transport.subscribe((snapshot) => { if (current(r) && r.ready) entry.fn(snapshot); }));
    }
    function activate(r) {
      if (!current(r) || !r.cssLoaded || !r.scriptLoaded) return;
      if (!r.roles) return fail(r, t("远程组件未按宿主接口装载"));
      clearTimeout(r.timeout); r.ready = true;
      try {
        r.unreadOff = inComponent(r, () => r.roles.transport.subscribe((snapshot) => {
          if (!current(r) || !r.ready) return;
          const count = Math.min(999, (snapshot.sessions || []).reduce((sum, s) => sum + (s.state === "invited" ? 1 : Math.max(0, Number(s.pendingCount) || 0)), 0));
          if (typeof remotePendingCount !== "undefined" && count !== remotePendingCount) { remotePendingCount = count; renderSideNav(); }
        }));
        for (const entry of subscribers) attachSubscriber(r, entry);
      } catch { return fail(r, t("远程组件订阅失败，请刷新后重试")); }
      r.settle(true); publish();
    }
    function load() {
      const r = { generation, version: feature.assetVersion, activationId: feature.activationId, dead: false, ready: false, roles: null, exported: {}, listeners: [], observers: new Set(), overlays: new Set(), connectedOverlays: new Set(), controllers: new Set(), contextRead: false, settingsOpening: false };
      r.done = new Promise((resolve) => { r.settle = resolve; }); runtime = r;
      // Native, generation-owned observer: async renders/removals do not run in
      // a capture. Batch their detached-control cleanup without layout reads.
      const Observer = window.MutationObserver;
      if (typeof Observer === "function" && document.body) {
        const observer = new Observer(() => { if (current(r)) pruneDetached(r); });
        r.observers.add(observer);
        observer.observe(document.body, { childList: true, subtree: true });
      }
      const query = "?version=" + encodeURIComponent(r.version);
      r.css = document.createElement("link"); r.css.rel = "stylesheet"; r.css.href = BASE + "/ui.css" + query;
      r.css.dataset.remoteVersion = r.version;
      r.css.onload = () => { if (current(r)) { r.cssLoaded = true; activate(r); } };
      r.css.onerror = () => fail(r, t("远程组件样式加载失败，请刷新组件状态后重试"));
      r.script = document.createElement("script"); r.script.src = BASE + "/ui.js" + query; r.script.async = true;
      r.script.dataset.remoteVersion = r.version; r.script.dataset.remoteGeneration = String(r.generation);
      r.script.onload = () => { finishBundle(r); if (current(r)) { r.scriptLoaded = true; activate(r); } };
      r.script.onerror = () => { finishBundle(r); fail(r, t("远程组件界面加载失败或版本已变化，请刷新组件状态后重试")); };
      r.timeout = setTimeout(() => fail(r, t("远程组件界面加载超时，请刷新后重试")), 20000);
      document.head.appendChild(r.css); document.head.appendChild(r.script);
      return r.done;
    }
    function schedulePoll() {
      clearTimeout(poll); poll = null;
      if (!booted || !watched && feature.state !== "active") return;
      poll = setTimeout(() => { poll = null; if (!document.hidden) ignore(refreshReady({ watch: false })); else schedulePoll(); }, POLL_MS);
    }
    async function refresh({ watch = true } = {}) {
      if (watch) watched = true;
      clearTimeout(poll); poll = null;
      const seq = ++requestSeq;
      statusAbort?.abort(); const controller = new AbortController(); statusAbort = controller;
      try {
        const next = parseStatus(await api(BASE + "/status", { cache: "no-store", credentials: "same-origin", signal: controller.signal }));
        if (seq !== requestSeq) return enabled();
        if (next.state !== "active" || !runtime || runtime.version !== next.assetVersion || runtime.activationId !== next.activationId || !current(runtime)) {
          retire(); feature = next; publish();
          if (next.state === "active") { watched = true; const loaded = load(); schedulePoll(); return await loaded; }
          return false;
        }
        feature = next; publish(); schedulePoll(); return await runtime.done;
      } catch (error) {
        if (seq !== requestSeq) return enabled();
        retire(); feature = Object.freeze({ ...feature, state: "error", error: String(error.message || error).slice(0, 1024) }); publish(); return false;
      } finally { if (seq === requestSeq) { statusAbort = null; schedulePoll(); } }
    }
    function refreshReady(options) { ready = refresh(options); return ready; }
    async function setEnabled(on) {
      watched = true;
      if (!on) { requestSeq++; statusAbort?.abort(); retire(); feature = Object.freeze({ ...feature, state: "retiring" }); publish(); }
      try {
        const response = await api(BASE + (on ? "/enable" : "/disable"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin", cache: "no-store" });
        if (!response?.ok) throw new Error(response?.message || response?.error || t("远程组件状态切换失败"));
        const available = await refreshReady(), actual = status();
        if (on ? actual.state !== "active" || !available : actual.enabled || !["disabled", "absent"].includes(actual.state)) throw new Error(actual.error || t("组件状态尚未确认，请刷新后核对"));
        return available;
      } catch (error) { await refreshReady(); throw error; }
    }
    function unavailable() {
      watched = true; ignore(refreshReady());
      if (typeof openPage === "function") openPage("ext");
      if (typeof toast === "function") toast(t("请在扩展中安装并启用远程托管组件"), true);
      return Promise.resolve(false);
    }
    function invoke(role, method, args, quiet = false) {
      const r = runtime;
      if (!enabled()) return quiet ? Promise.resolve(false) : role === "transport" ? Promise.reject(inactive()) : unavailable();
      if (role === "settings" && method === "open") showSettings(r);
      let result;
      try { result = inComponent(r, () => r.roles[role][method](...args)); } catch (error) { return Promise.reject(error); }
      return Promise.resolve(result).then((value) => { if (!current(r) || !r.ready) throw inactive(); return value; });
    }
    const view = Object.freeze({ open: (...args) => invoke("view", "open", args), close: () => invoke("view", "close", [], true), refresh: () => invoke("view", "refresh", [], true) });
    const settings = Object.freeze({ open: () => invoke("settings", "open", []), close: () => invoke("settings", "close", [], true) });
    const hosting = Object.freeze({ open: (...args) => invoke("hosting", "open", args), refresh: () => invoke("hosting", "refresh", [], true), close: () => invoke("hosting", "close", [], true) });
    const transport = {};
    for (const method of ["status", "list", "open", "accept", "decline", "close", "history", "sendText", "respond", "stop", "query"]) transport[method] = (...args) => invoke("transport", method, args);
    transport.subscribe = (fn) => {
      if (typeof fn !== "function" || subscribers.size >= 64) throw inactive();
      const entry = { fn, off: null }; subscribers.add(entry);
      if (enabled()) attachSubscriber(runtime, entry); else { try { fn(emptySnapshot()); } catch {} }
      return () => { entry.off?.(); entry.off = null; subscribers.delete(entry); };
    };
    transport.getDraft = () => enabled() ? runtime.roles.transport.getDraft() : "";
    transport.setDraft = (text) => { if (!enabled()) throw inactive(); return inComponent(runtime, () => runtime.roles.transport.setDraft(text)); };
    transport.destroy = () => { retire(); publish(); };
    Object.freeze(transport);
    const component = Object.freeze({ hostApi: HOST_API, enabled, status, refresh: refreshReady,
      boot() { if (!booted) { booted = true; ready = refresh({ watch: false }); schedulePoll(); } return ready; },
      retiring() { watched = true; requestSeq++; statusAbort?.abort(); retire(); feature = Object.freeze({ ...feature, state: "retiring" }); publish(); schedulePoll(); },
      get ready() { return ready; },
      settingsOpening: () => !!runtime?.settingsOpening,
      enable: () => setEnabled(true), disable: () => setEnabled(false),
    });
    // Keep legacy window and __cc.remote references stable. Assignments made
    // by the approved wrapper are retained only for partial-load cleanup; late
    // scripts cannot replace the proxies or register a new implementation.
    for (const [name, value] of Object.entries({ remoteView: view, remoteSettings: settings, remoteHosting: hosting, remoteTransport: transport })) {
      Object.defineProperty(window, name, { configurable: false, get: () => value, set(implementation) {
        const r = loadingScript();
        if (r && r.contextRead && implementation && typeof implementation === "object") r.exported[{ remoteView: "view", remoteSettings: "settings", remoteHosting: "hosting", remoteTransport: "transport" }[name]] = implementation;
      } });
    }
    Object.defineProperty(window, "createRemoteTransport", { configurable: false, get: () => undefined, set() {} });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && booted && watched) ignore(refreshReady({ watch: false })); });
    window.addEventListener("pagehide", () => { requestSeq++; statusAbort?.abort(); clearTimeout(poll); retire(); });
    return { remoteComponent: component, remoteView: view, remoteSettings: settings, remoteHosting: hosting, remoteTransport: transport };
  })();

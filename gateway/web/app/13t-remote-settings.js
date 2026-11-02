  // ── 远程连接、双向设备配对与本机指定会话托管 ─────────────────────────
  // 只调用本机 /api/remote/{settings,pairing,hosting}；中转凭据与设备私钥由宿主保管。
  // 保存不是联网测试；配对不是会话授权；收回不是停止；本模块不处理工具审批。
  const { remoteSettings, remoteHosting } = (() => {
    const BASE = "/api/remote/", POLL_MS = 3000, REQUEST_MS = 20000;
    const E = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const text = (value, max = 256) => typeof value === "string" ? value.slice(0, max) : "";
    const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
    const error = (code) => Object.assign(new Error(code), { code });
    const button = (act, label, kind = "", extra = "") => `<button type="button" class="rs-button ${kind}" data-rs="${act}" ${extra}>${E(label)}</button>`;
    const hint = (label, kind = "") => `<p class="rs-hint ${kind}">${E(label)}</p>`;
    const status = (label, kind = "") => `<p class="rs-status ${kind}" role="status" aria-live="polite">${E(label)}</p>`;
    const device = (value) => {
      if (!value || !validId(value.deviceId)) return null;
      if (typeof value.fingerprint !== "string" || value.fingerprint.length > 4096) throw error("REMOTE_RESPONSE_INVALID");
      // 公钥指纹必须完整显示；异常超长值拒绝，不截断后让用户确认。
      return { deviceId: value.deviceId, name: text(value.name, 80), fingerprint: value.fingerprint };
    };
    const when = (value) => Number.isFinite(value) && value > 0 ? value : 0;
    const connection = (value) => ({ state: ["unconfigured", "disconnected", "connecting", "online", "error"].includes(value?.state) ? value.state : "disconnected", checkedAt: when(value?.checkedAt) });
    let page = null, pageActive = false, pageSeq = 0, pageBusy = false, pageAbort = null, settings = null;
    let devices = [], pending = [], settingsError = "", pairingError = "", diagnostic = null, modal = null, modalSeq = 0, modalBusy = false, modalAbort = null, poll = null;

    function failure(err) {
      const code = err?.code || err?.body?.code || err?.body?.error;
      if (["IDENTITY_VAULT_UNAVAILABLE", "IDENTITY_VAULT_REQUIRED", "IDENTITY_CERTIFICATE_UNAVAILABLE", "IDENTITY_CERTIFICATE_FAILED", "IDENTITY_CERTIFICATE_TIMEOUT", "IDENTITY_CERTIFICATE_LIMIT", "IDENTITY_OPERATION_FAILED", "IDENTITY_LOAD_FAILED", "IDENTITY_SAVE_FAILED", "UNSAFE_IDENTITY_DIRECTORY", "HOST_OPERATION_FAILED", "VAULT_UNAVAILABLE"].includes(code)) return t("本机安全身份初始化未完成，尚不能确认登记。请保留应用数据并反馈错误代码：{code}", { code });
      if (code === "PAIRED_RELAY_CHANGE") return t("请先解除已有配对并结束待完成配对，再更换中转地址；不会自动迁移托管授权。");
      if (err?.status === 404 || err?.status === 501 || ["REMOTE_UNAVAILABLE", "HOST_UNAVAILABLE", "NOT_IMPLEMENTED"].includes(code)) return t("远程功能后端尚未就绪；未执行的操作不会显示为成功。");
      if (["PAIRING_EXPIRED", "PAIR_EXPIRED", "EXPIRED"].includes(code)) return t("配对信息已过期，请重新生成一次性配对码。");
      if (["PAIRING_USED", "PAIR_USED", "REPLAY"].includes(code)) return t("此配对码已使用，不能再次配对。");
      if (["PAIRING_MISMATCH", "FINGERPRINT_MISMATCH", "PAIR_MISMATCH", "INVALID_PAIRING_CONFIRMATION"].includes(code)) return t("设备核对信息不一致，未确认配对。");
      if (err?.status === 429 || ["RATE_LIMITED", "PAIRING_RATE_LIMIT"].includes(code)) return t("操作过于频繁，请稍后重试。");
      if (["REMOTE_TIMEOUT", "HOST_TIMEOUT", "OFFLINE", "PAIRING_DISCONNECTED", "PAIRING_TRANSPORT_FAILED"].includes(code) || err?.name === "AbortError") return t("请求超时或连接中断，结果待核实；请刷新状态，不要重复提交。");
      if (err?.status === 401 || err?.status === 403 || ["AUTH_FAILED", "UNAUTHORIZED", "FORBIDDEN"].includes(code)) return t("连接身份校验失败，请检查凭据与本机访问权限。");
      if (["STALE_GRANT", "GRANT_REVOKED", "GRANT_MISMATCH", "HOSTING_CONFLICT", "RESYNC_REQUIRED"].includes(code) || err?.status === 409) return t("授权或设备状态已变化，请刷新后重新核对。");
      if (code === "REMOTE_RESPONSE_INVALID") return t("返回状态不完整，结果待核实；请刷新，不能据此确认成功。");
      return t("远程操作未能确认完成，请检查连接后刷新状态。");
    }
    async function request(route, body, signal) {
      const ctl = new AbortController(), abort = () => ctl.abort();
      if (signal?.aborted) throw error("REMOTE_TIMEOUT");
      signal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, REQUEST_MS);
      try {
        const opts = { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal: ctl.signal };
        if (body !== undefined) { opts.headers = { "content-type": "application/json" }; opts.body = JSON.stringify(body); }
        const result = await api(BASE + route, opts);
        if (ctl.signal.aborted || timedOut) throw error("REMOTE_TIMEOUT");
        if (!result || result.ok !== true) throw Object.assign(error(result?.code || "REMOTE_RESPONSE_INVALID"), { body: { code: result?.code } });
        return result;
      } catch (err) { if (timedOut || ctl.signal.aborted) throw error("REMOTE_TIMEOUT"); throw err; }
      finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    }
    function parseSettings(value) {
      if (!value || typeof value.serverUrl !== "string" || typeof value.deviceName !== "string" || typeof value.hasCredential !== "boolean" || typeof value.reminders?.enabled !== "boolean") throw error("REMOTE_RESPONSE_INVALID");
      let serverUrl = "";
      if (value.serverUrl) serverUrl = parseServer(value.serverUrl);
      return { serverUrl, deviceName: text(value.deviceName, 40), hasCredential: value.hasCredential, connection: connection(value.connection), reminders: {
        enabled: value.reminders.enabled,
        permission: ["granted", "denied", "prompt", "unsupported"].includes(value.reminders.permission) ? value.reminders.permission : "unsupported",
        background: ["active", "foreground", "restricted", "unsupported"].includes(value.reminders.background) ? value.reminders.background : "unsupported",
      } };
    }
    function parseServer(value) {
      let url;
      try { url = new URL(value.trim()); } catch { throw error("INVALID_SERVER"); }
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/" || value.length > 2048) throw error("INVALID_SERVER");
      return url.href.replace(/\/$/, "");
    }
    function connectionLabel(value) {
      switch (value?.state) {
        case "online": return t("中转连接在线");
        case "connecting": return t("正在连接中转站");
        case "error": return t("中转连接失败");
        case "unconfigured": return t("尚未配置连接");
        default: return t("中转连接已断开");
      }
    }
    function parsePair(value) {
      if (!value || !validId(value.pairingId) || !["offered", "awaiting-confirmation", "paired", "rejected", "expired", "cancelled"].includes(value.state)) throw error("REMOTE_RESPONSE_INVALID");
      return { pairingId: value.pairingId, state: value.state, peer: device(value.peer), verificationCode: text(value.verificationCode, 256), expiresAt: when(value.expiresAt), localConfirmed: value.localConfirmed === true, peerConfirmed: value.peerConfirmed === true,
        localPersisted: value.localPersisted === true, peerPersisted: value.peerPersisted === true };
    }
    function parsePairList(value) {
      if (!Array.isArray(value.devices) || !Array.isArray(value.pending) || value.devices.length > 100 || value.pending.length > 100) throw error("REMOTE_RESPONSE_INVALID");
      return { devices: value.devices.map(device).filter(Boolean), pending: value.pending.map(parsePair) };
    }
    const input = (id) => page?.querySelector("#" + id);
    function clearSecrets() {
      const credential = input("rs-credential"); if (credential) credential.value = "";
      const code = modal?.el?.querySelector("#rs-pair-input"); if (code) code.value = "";
      if (modal?.kind === "pair" && modal.offerCode) { modal.offerCode = ""; modal.copyMessage = ""; renderPair(); }
    }
    function visiblePage() { return !!(pageActive && page?.isConnected && page.getClientRects().length); }
    function leavePage() {
      clearSecrets(); pageActive = false; pageSeq++; pageAbort?.abort(); pageAbort = null; pageBusy = false;
    }
    function initPage() {
      page = document.getElementById("remoteSettingsPage");
      if (!page) { if (typeof toast === "function") toast(t("远程设置页面尚未接入"), true); return false; }
      if (!page.dataset.rsReady) {
        page.dataset.rsReady = "1"; page.classList.add("rs-page");
        page.addEventListener("click", pageClick);
        page.addEventListener("submit", (event) => { if (event.target.id === "rs-connection-form") { event.preventDefault(); configure(false); } });
        page.addEventListener("input", (event) => {
          if (["rs-server", "rs-name", "rs-credential"].includes(event.target.id)) {
            diagnostic = null;
            const el = input("rs-diagnostic"); if (el) el.replaceChildren();
          }
        });
        if (typeof MutationObserver === "function") new MutationObserver(() => { if (pageActive && !visiblePage()) leavePage(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
      }
      return true;
    }
    function pageMarkup() {
      const s = settings, reminders = s?.reminders;
      page.innerHTML = `<div class="rs-content"><header class="rs-heading"><h2>${E(t("远程托管设置"))}</h2>${button("reload", t("刷新"))}</header>
        ${hint(t("连接中转站、配对设备，然后在平板会话菜单中单独发送托管邀请。"))}
        <section class="rs-section" aria-labelledby="rs-connection-title"><h3 id="rs-connection-title">${E(t("连接与设备"))}</h3>
        <div id="rs-settings-feedback">${settingsError ? status(settingsError, "rs-error") : status(s ? connectionLabel(s.connection) : t("正在读取连接设置…"), s?.connection.state === "online" ? "rs-ok" : "")}</div>
        <form id="rs-connection-form" autocomplete="off"><label class="rs-field"><span>${E(t("服务器 HTTPS 地址"))}</span><input id="rs-server" type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="2048" placeholder="https://relay.example.com" value="${E(s?.serverUrl || "")}" required></label>
        <label class="rs-field"><span>${E(t("本机名称"))}</span><input id="rs-name" autocomplete="off" maxlength="40" value="${E(s?.deviceName || "")}" required></label>
        <label class="rs-field"><span>${E(s?.hasCredential ? t("更换连接凭据（留空保留现有凭据）") : t("首次连接凭据"))}</span><input id="rs-credential" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="4096" aria-describedby="rs-credential-hint"></label>
        <p id="rs-credential-hint" class="rs-hint">${E(t("凭据仅提交给本机受控后端，不回显，不保存在浏览器；设备私钥不进入此页面。"))}</p>
        <div class="rs-actions"><button type="submit" class="rs-button rs-primary" data-rs="save">${E(t("保存配置"))}</button>${button("diagnose", t("测试真实连接"))}</div></form>
        ${hint(t("保存只保存配置；测试会实际访问中转站并检查 TLS、身份认证与连接，不会调用模型。"))}
        ${hint(t("中转连接在线不代表端到端安全通道已就绪；会话内容仅能在端到端安全通道验证后传输。"))}
        <div id="rs-diagnostic" aria-live="polite"></div></section>
        <section class="rs-section" aria-labelledby="rs-devices-title"><h3 id="rs-devices-title">${E(t("已配对设备"))}</h3><div id="rs-devices"></div>${button("pair", t("配对新设备"))}
        ${hint(t("设备配对不开放任何会话，也不批准工具操作。会话须由平板另行选择并邀请。"))}</section>
        <section class="rs-section" aria-labelledby="rs-reminders-title"><h3 id="rs-reminders-title">${E(t("接收远程提醒"))}</h3>
        <div class="rs-switch-row"><p>${E(t("托管邀请、需要确认的操作、任务本轮结束"))}</p><button type="button" id="rs-reminders" class="rs-switch" role="switch" data-rs="reminders" aria-label="${E(t("接收远程提醒"))}" aria-checked="${reminders?.enabled === true}"><span></span></button></div>
        <div id="rs-reminders-status">${reminderMarkup(reminders)}</div>
        ${hint(t("锁屏仅显示摘要，不显示命令、源码、令牌或审批按钮；审批始终要进入应用逐项确认。"))}</section>
        <section class="rs-section"><h3>${E(t("平板执行与隐私"))}</h3>${hint(t("平板请插电并保持 CC 开着。断线不会自动批准请求；收回托管或解除配对不会停止平板任务。"))}${hint(t("仅传输授权会话的必要消息，不同步整个项目；会话已有代码、日志和敏感内容仍可能随消息传输。"))}</section></div>`;
      renderDevices(); paintBusy();
    }
    function reminderMarkup(value) {
      if (!value) return hint(t("提醒能力尚未读取，不能确认后台或锁屏送达。"));
      let result = value.enabled ? hint(t("已请求接收远程提醒。后台、锁屏与切网送达仍需在实际设备验收。")) : hint(t("已关闭后台远程提醒，仅打开 CC 时可实时接收。"));
      if (value.permission === "denied") result += hint(t("系统通知权限未开启，请在设备系统设置中手动开启。"), "rs-warning");
      if (value.permission === "prompt") result += hint(t("系统通知权限尚待用户确认。"), "rs-warning");
      if (value.permission === "unsupported" || value.background === "unsupported") result += hint(t("宿主尚不支持后台远程提醒；设置不能保证锁屏送达。"), "rs-warning");
      else if (value.background === "restricted") result += hint(t("后台连接受系统限制；强行停止应用或被系统清理后不保证送达，重新打开请检查待办。"), "rs-warning");
      else if (value.enabled && value.background !== "active") result += hint(t("后台连接未运行，目前仅前台接收；请检查通知权限与宿主支持。"), "rs-warning");
      return result;
    }
    function renderDevices() {
      const el = input("rs-devices"); if (!el) return;
      let html = pairingError ? status(pairingError, "rs-error") : "";
      html += devices.length ? devices.map((d) => `<div class="rs-device"><div class="rs-grow"><strong>${E(d.name || t("未命名设备"))}</strong><p class="rs-fingerprint">${E(d.fingerprint)}</p></div>${button("unpair", t("解除配对"), "rs-danger", `data-device="${E(d.deviceId)}"`)}</div>`).join("") : hint(t("暂无已配对设备。请在另一台 CC 中输入一次性配对码，并在两端核对确认。"));
      html += pending.filter((p) => ["offered", "awaiting-confirmation"].includes(p.state) && p.expiresAt > Date.now()).map((p) => `<div class="rs-device"><div class="rs-grow"><strong>${E(p.peer?.name || t("等待另一台设备"))}</strong>${hint(p.localConfirmed ? t("本机已确认，等待另一端确认") : t("配对待核对，尚未开放任何会话"))}</div>${button("review-pair", t("核对配对"), "", `data-pair="${E(p.pairingId)}"`)}</div>`).join("");
      if (el._rsMarkup !== html) { el.innerHTML = html; el._rsMarkup = html; }
      const pair = page.querySelector('[data-rs="pair"]'); if (pair) pair.disabled = pageBusy || !settings;
    }
    async function refreshDevices() {
      if (!pageActive) return;
      const seq = pageSeq;
      try {
        const list = parsePairList(await request("pairing", undefined, pageAbort?.signal));
        if (seq !== pageSeq || !pageActive) return;
        devices = list.devices; pending = list.pending; pairingError = "";
      } catch (err) { if (seq === pageSeq && pageActive) pairingError = failure(err); }
      finally { if (seq === pageSeq && pageActive) { renderDevices(); paintBusy(); } }
    }
    function paintBusy() {
      if (!page) return;
      page.setAttribute("aria-busy", String(pageBusy));
      page.querySelectorAll("#rs-connection-form input, #rs-connection-form button").forEach((el) => { el.disabled = pageBusy; });
      const reminders = input("rs-reminders"); if (reminders) reminders.disabled = pageBusy || !settings;
      page.querySelectorAll('[data-rs="pair"], [data-rs="unpair"], [data-rs="review-pair"], [data-rs="reload"]').forEach((el) => { el.disabled = pageBusy || (!settings && el.dataset.rs !== "reload"); });
    }
    async function openSettings() {
      if (!initPage()) return false;
      pageAbort?.abort(); pageAbort = new AbortController(); const seq = ++pageSeq;
      clearSecrets(); pageActive = true; pageBusy = true; settingsError = ""; pairingError = ""; diagnostic = null;
      pageMarkup();
      const results = await Promise.allSettled([request("settings", undefined, pageAbort.signal), request("pairing", undefined, pageAbort.signal)]);
      if (seq !== pageSeq || !pageActive) return false;
      try { if (results[0].status === "rejected") throw results[0].reason; settings = parseSettings(results[0].value); }
      catch (err) { settings = null; settingsError = failure(err); }
      try { if (results[1].status === "rejected") throw results[1].reason; const list = parsePairList(results[1].value); devices = list.devices; pending = list.pending; }
      catch (err) { devices = []; pending = []; pairingError = failure(err); }
      pageBusy = false; pageMarkup(); return !!settings;
    }
    function connectionFields() {
      let serverUrl;
      try { serverUrl = parseServer(input("rs-server").value); }
      catch { throw Object.assign(error("INVALID_SERVER"), { uiMessage: t("请填写不含账号密码、查询参数或片段的 HTTPS 服务器地址。") }); }
      const deviceName = input("rs-name").value.trim();
      if (!deviceName || deviceName.length > 40 || /[\x00-\x1f\x7f]/.test(deviceName)) throw Object.assign(error("INVALID_NAME"), { uiMessage: t("请填写 1–40 字的本机名称，不使用控制字符。") });
      const credential = input("rs-credential").value;
      if (!credential && !settings?.hasCredential) throw Object.assign(error("MISSING_CREDENTIAL"), { uiMessage: t("请填写首次连接凭据。") });
      if (credential.length > 4096 || /[\x00-\x1f\x7f]/.test(credential)) throw Object.assign(error("INVALID_CREDENTIAL"), { uiMessage: t("连接凭据格式不正确，请重新输入。") });
      return { serverUrl, deviceName, ...(credential ? { credential } : {}) };
    }
    async function configure(testConnection) {
      if (pageBusy || !pageActive) return;
      let fields;
      try { fields = connectionFields(); }
      catch (err) { input("rs-settings-feedback").innerHTML = status(err.uiMessage || failure(err), "rs-error"); return; }
      const seq = pageSeq, feedback = input("rs-settings-feedback");
      input("rs-credential").value = ""; diagnostic = null; input("rs-diagnostic").replaceChildren(); pageBusy = true; paintBusy();
      feedback.innerHTML = status(testConnection ? t("正在实际检查中转连接…") : t("正在保存配置，尚未确认连接…"));
      try {
        const result = await request("settings", { action: testConnection ? "diagnose" : "configure", ...fields }, pageAbort?.signal);
        fields = null;
        if (seq !== pageSeq || !pageActive) return;
        if (testConnection) {
          paintDiagnostic(result.diagnostic);
          feedback.innerHTML = status(t("连接测试已返回；配置保存与设备配对仍需分别操作。"));
        } else {
          settings = parseSettings(result); pageMarkup();
          input("rs-settings-feedback").innerHTML = status(t("配置已保存；保存不代表服务器可达，请测试真实连接。"));
        }
      } catch (err) { if (seq === pageSeq && pageActive) feedback.innerHTML = status(failure(err), "rs-error"); }
      finally { fields = null; if (seq === pageSeq) { pageBusy = false; paintBusy(); } }
    }
    function paintDiagnostic(value) {
      const stages = { dns: t("域名解析"), tls: t("有效 TLS 证书"), auth: t("连接身份认证"), relay: t("中转协议连接") };
      if (!value || !["online", "failed"].includes(value.state) || !when(value.checkedAt) || !Array.isArray(value.checks)) throw error("REMOTE_RESPONSE_INVALID");
      const checks = Object.keys(stages).map((stage) => {
        const matches = value.checks.filter((c) => c.stage === stage);
        return { stage, pass: matches.length === 1 && matches[0].status === "pass", failed: matches.length === 1 && matches[0].status === "fail" };
      });
      const verified = value.state === "online" && checks.every((c) => c.pass);
      diagnostic = { verified, checkedAt: value.checkedAt, checks };
      input("rs-diagnostic").innerHTML = status(verified ? t("真实连接检查通过（仅代表本次测试）") : t("连接尚未验证通过；不能仅凭地址格式或保存结果判断在线。"), verified ? "rs-ok" : "rs-warning") + `<ul class="rs-checks">${checks.map((c) => `<li><span>${E(stages[c.stage])}</span><strong class="${c.pass ? "rs-ok" : "rs-warning"}">${E(c.pass ? t("通过") : c.failed ? t("失败") : t("未验证"))}</strong></li>`).join("")}</ul>` + hint(t("检查时间：{time}", { time: new Date(value.checkedAt).toLocaleString() }));
    }
    async function toggleReminders() {
      if (pageBusy || !settings) return;
      const seq = pageSeq, enabled = !settings.reminders.enabled; pageBusy = true; paintBusy();
      try {
        const result = parseSettings(await request("settings", { action: "reminders", enabled }, pageAbort?.signal));
        if (seq !== pageSeq || !pageActive) return;
        if (result.reminders.enabled !== enabled) throw error("REMOTE_RESPONSE_INVALID");
        settings = result; input("rs-reminders").setAttribute("aria-checked", String(result.reminders.enabled)); input("rs-reminders-status").innerHTML = reminderMarkup(result.reminders);
      } catch (err) { if (seq === pageSeq && pageActive) input("rs-reminders-status").innerHTML = status(failure(err), "rs-error") + reminderMarkup(settings?.reminders); }
      finally { if (seq === pageSeq) { pageBusy = false; paintBusy(); } }
    }
    function pageClick(event) {
      const b = event.target.closest("button[data-rs]"); if (!b || b.disabled || !page.contains(b)) return;
      switch (b.dataset.rs) {
        case "reload": openSettings(); break;
        case "diagnose": configure(true); break;
        case "reminders": toggleReminders(); break;
        case "pair": openPair(); break;
        case "review-pair": { const p = pending.find((x) => x.pairingId === b.dataset.pair); if (p) { openPair(); modal.pair = p; renderPair(); schedulePair(); } break; }
        case "unpair": { const d = devices.find((x) => x.deviceId === b.dataset.device); if (d) openUnpair(d); break; }
      }
    }

    function closeModal() { if (modal?.el) OV.close(modal.el); }
    function openModal(kind, heading) {
      closeModal(); modalAbort = new AbortController(); modalBusy = false;
      const el = document.createElement("div"); el.className = "rs-overlay";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "rs-modal-title");
      modal = { kind, heading, el, seq: ++modalSeq, message: "", offerCode: "", copyBusy: false, copyMessage: "", confirmChecked: false };
      el.addEventListener("click", modalClick);
      el.addEventListener("change", (event) => {
        if (event.target.id === "rs-verify") { modal.confirmChecked = event.target.checked; const b = el.querySelector('[data-rs="confirm-pair"]'); if (b) b.disabled = !canConfirmPair(); }
      });
      el.addEventListener("submit", (event) => { if (event.target.id === "rs-pair-form") { event.preventDefault(); joinPair(); } });
      el.addEventListener("click", (event) => { if (event.target === el) closeModal(); });
      OV.open(el, { kind: "modal", keep: true, cover: true, onClose: () => {
        if (modal?.el !== el) return;
        clearTimeout(poll); poll = null; modalAbort?.abort(); modalAbort = null; clearSecrets(); modal = null; modalBusy = false; modalSeq++;
      } });
      renderModal(hint(t("正在读取…"))); return modal;
    }
    function renderModal(body, foot = "") {
      if (!modal?.el) return;
      const active = document.activeElement, inside = modal.el.contains(active), focusId = inside ? active.id : "", focusAction = inside ? active.dataset?.rs : "";
      modal.el.setAttribute("aria-busy", String(modalBusy));
      modal.el.innerHTML = `<section class="rs-dialog" tabindex="-1"><header class="rs-dialog-header"><h2 id="rs-modal-title">${E(modal.heading)}</h2>${button("close", t("关闭"), "rs-close")}</header><div class="rs-dialog-body">${body}<div id="rs-modal-message">${modal.message ? status(modal.message, "rs-warning") : ""}</div></div>${foot ? `<footer class="rs-dialog-footer">${foot}</footer>` : ""}</section>`;
      const preferred = focusId ? modal.el.querySelector("#" + focusId) : focusAction ? modal.el.querySelector(`[data-rs="${focusAction}"]`) : null;
      if (preferred && !preferred.disabled) preferred.focus({ preventScroll: true });
      else if (inside && !modal.el.contains(document.activeElement)) modal.el.focus({ preventScroll: true });
    }
    function paintModalMessage() {
      const el = modal?.el.querySelector("#rs-modal-message");
      if (el && el.textContent !== modal.message) el.innerHTML = modal.message ? status(modal.message, "rs-warning") : "";
    }
    function openPair() {
      openModal("pair", t("安全配对设备")); renderPair();
    }
    // Compare only displayed pairing state. An unchanged poll must leave the
    // code's text nodes, browser selection and the scroll container intact.
    function pairViewKey() { return JSON.stringify([modal.pair, modal.offerCode, pairExpired(modal.pair)]); }
    function pairExpired(p) { return !!p && ["offered", "awaiting-confirmation"].includes(p.state) && (!p.expiresAt || p.expiresAt <= Date.now()); }
    function canConfirmPair() {
      const p = modal?.pair;
      return !modalBusy && p?.state === "awaiting-confirmation" && !pairExpired(p) && !!p.peer?.fingerprint && !!p.peer?.name && !!p.verificationCode && !p.localConfirmed && modal.confirmChecked;
    }
    function pairIdentity(p) {
      return `<div class="rs-identity"><strong>${E(p.peer?.name || t("尚未收到对端身份"))}</strong>${hint(t("设备指纹"))}<code class="rs-fingerprint">${E(p.peer?.fingerprint || t("尚未提供，不能确认配对"))}</code>${hint(t("两端校验码"))}<code class="rs-verification">${E(p.verificationCode || t("尚未提供，不能确认配对"))}</code></div>`;
    }
    function renderPair() {
      if (modal?.kind !== "pair") return;
      const p = modal.pair, expired = pairExpired(p), terminal = p && (["rejected", "expired", "cancelled"].includes(p.state) || expired);
      if (!p) {
        renderModal(hint(t("只在本人两台设备之间配对。一次性配对码限时使用；两端核对身份并分别确认后才建立信任。")) + button("create-pair", t("生成一次性配对码"), "rs-primary", modalBusy ? "disabled" : "") + `<form id="rs-pair-form" autocomplete="off"><label class="rs-field"><span>${E(t("或输入另一台设备的配对码"))}</span><textarea id="rs-pair-input" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="4096" ${modalBusy ? "disabled" : ""}></textarea></label><button type="submit" class="rs-button" ${modalBusy ? "disabled" : ""}>${E(t("连接并核对设备"))}</button></form>` + hint(t("配对码是临时凭据，请勿发送给陌生人。设备私钥不会在此页面显示。")));
        return;
      }
      if (terminal) {
        modal.offerCode = "";
        renderModal(status(expired || p.state === "expired" ? t("配对信息已过期，未开放任何会话。") : t("本次配对已结束，未开放任何会话。")) + hint(t("请重新生成一次性配对码，不要重复使用旧码。")), button("reset-pair", t("重新配对")) + button("close", t("关闭")));
        return;
      }
      if (p.state === "paired" && p.localConfirmed && p.peerConfirmed && p.peer?.fingerprint) {
        modal.offerCode = "";
        const recorded = p.localPersisted && p.peerPersisted;
        renderModal(status(recorded ? t("本机配对记录已保存，并已收到对端保存回执。") : t("两端已确认身份；对端是否已保存尚未核实，请在另一端确认。"), recorded ? "rs-ok" : "rs-warning") + pairIdentity(p) + hint(t("现在仍未开放任何会话。请在平板指定会话菜单中发送托管邀请；接受邀请也不会批准工具。")), button("finish-pair", t("完成"), "rs-primary"));
        return;
      }
      let body = hint(t("核对下方对端设备的名称和完整公钥指纹，并比较两端校验码一致；不是本人设备或校验不符，请取消配对。"));
      if (modal.offerCode && p.state === "offered") body += hint(t("在另一台 CC 的远程设置里输入此一次性配对码")) + `<code class="rs-pair-code">${E(modal.offerCode)}</code>` + button("copy-pair", t("复制完整配对码"), "", modal.copyBusy ? "disabled" : "") + `<p id="rs-pair-copy-result" class="rs-hint" role="status" aria-live="polite">${E(modal.copyMessage)}</p>`;
      else if (p.state === "offered") body += hint(t("配对码已隐藏；仍可等待对端，或取消后重新生成。"));
      body += pairIdentity(p) + hint(t("有效期至：{time}", { time: p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString() : t("未提供") }));
      body += p.localConfirmed ? status(t("本机已确认，等待另一端确认；尚不能据此显示配对完成。")) : `<label class="rs-confirm"><input id="rs-verify" type="checkbox" ${modal.confirmChecked ? "checked" : ""} ${!p.peer?.fingerprint || !p.verificationCode || modalBusy ? "disabled" : ""}><span>${E(t("我已核对这是本人对端设备及其完整指纹，两端校验码一致"))}</span></label>`;
      body += hint(t("配对不等于会话授权，不会自动批准任何请求。"));
      renderModal(body, button("cancel-pair", t("取消配对"), "", modalBusy ? "disabled" : "") + button("refresh-pair", t("刷新状态"), "", modalBusy ? "disabled" : "") + (!p.localConfirmed ? button("confirm-pair", t("确认此设备"), "rs-primary", canConfirmPair() ? "" : "disabled") : ""));
    }
    function canCopyPair() {
      return modal?.kind === "pair" && modal.pair?.state === "offered" && !!modal.offerCode && !pairExpired(modal.pair) && !document.hidden;
    }
    function paintPairCopy() {
      const b = modal?.el.querySelector('[data-rs="copy-pair"]');
      if (b) b.disabled = !canCopyPair() || modal.copyBusy;
      const result = modal?.el.querySelector("#rs-pair-copy-result");
      if (result) result.textContent = modal.copyMessage;
    }
    async function copyPairCode() {
      if (!canCopyPair() || modal.copyBusy) return;
      const owner = modal, code = owner.offerCode, pairingId = owner.pair.pairingId;
      const current = () => modal === owner && owner.offerCode === code && owner.pair?.pairingId === pairingId && canCopyPair();
      owner.copyBusy = true; owner.copyMessage = ""; paintPairCopy();
      let copied = false;
      // The component has no access to the host closure's copyText helper.
      // Each fallback is user-triggered and must actually acknowledge success.
      try { if (window.CCApp?.copyText) copied = window.CCApp.copyText(code) === true; } catch {}
      if (!copied && current()) {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(code); copied = true;
          }
        } catch {}
      }
      if (!copied && current()) {
        const previous = document.activeElement, ta = document.createElement("textarea");
        ta.value = code; ta.setAttribute("readonly", ""); ta.setAttribute("aria-hidden", "true");
        ta.setAttribute("style", "position:fixed;top:-1000px;opacity:0");
        try { document.body.appendChild(ta); ta.select(); copied = document.execCommand("copy") === true; }
        catch {} finally { ta.value = ""; ta.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }
      }
      owner.copyBusy = false;
      if (modal !== owner) return;
      if (current()) owner.copyMessage = copied ? t("完整配对码已复制。请仅用于本人设备配对，使用后清理剪贴板。") : t("未能复制配对码，请手动选择完整配对码复制。");
      paintPairCopy();
    }
    function schedulePair() {
      clearTimeout(poll); poll = null;
      const p = modal?.kind === "pair" && modal.pair;
      if (!p || !["offered", "awaiting-confirmation"].includes(p.state) || pairExpired(p)) return;
      poll = setTimeout(() => {
        poll = null;
        if (modal?.kind !== "pair") return;
        if (pairExpired(modal.pair)) { modal.offerCode = ""; renderPair(); return; }
        if (!document.hidden) refreshPair(); else schedulePair();
      }, Math.max(1, Math.min(POLL_MS, p.expiresAt - Date.now())));
    }
    async function createPair() {
      if (modal?.kind !== "pair" || modalBusy) return;
      const seq = modal.seq; modalBusy = true; modal.message = ""; renderPair();
      try {
        const result = await request("pairing", { action: "create" }, modalAbort.signal);
        if (!modal || modal.seq !== seq) return;
        const offer = result.offer;
        if (!offer || !validId(offer.pairingId) || typeof offer.code !== "string" || offer.code.length < 32 || offer.code.length > 4096 || !when(offer.expiresAt) || offer.expiresAt <= Date.now() || offer.expiresAt > Date.now() + 10 * 60000) throw error("REMOTE_RESPONSE_INVALID");
        modal.pair = result.pairing ? parsePair(result.pairing) : parsePair({ pairingId: offer.pairingId, state: "offered", expiresAt: offer.expiresAt });
        if (modal.pair.pairingId !== offer.pairingId || modal.pair.state !== "offered" || modal.pair.localConfirmed || modal.pair.peerConfirmed) { modal.pair = null; throw error("REMOTE_RESPONSE_INVALID"); }
        modal.offerCode = offer.code; modal.copyMessage = "";
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); }
      finally { if (modal?.seq === seq) { modalBusy = false; renderPair(); schedulePair(); } }
    }
    async function joinPair() {
      if (modal?.kind !== "pair" || modalBusy) return;
      const el = modal.el.querySelector("#rs-pair-input"); let code = el?.value.trim() || "";
      if (code.length < 32 || code.length > 4096) { modal.message = t("请输入完整的高熵一次性配对码，不能使用短数字码。"); if (el) el.value = ""; renderPair(); return; }
      const seq = modal.seq; el.value = ""; modalBusy = true; modal.message = ""; renderPair();
      try {
        const result = await request("pairing", { action: "join", code }, modalAbort.signal); code = "";
        if (!modal || modal.seq !== seq) return;
        const next = parsePair(result.pairing);
        if (next.state !== "awaiting-confirmation" || next.localConfirmed || pairExpired(next) || !next.peer?.name || !next.peer.fingerprint || !next.verificationCode) throw error("REMOTE_RESPONSE_INVALID");
        modal.pair = next; modal.confirmChecked = false;
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); }
      finally { code = ""; if (modal?.seq === seq) { modalBusy = false; renderPair(); schedulePair(); } }
    }
    async function refreshPair() {
      if (modal?.kind !== "pair" || !modal.pair || modalBusy) return;
      const seq = modal.seq, id = modal.pair.pairingId, before = pairViewKey(); modalBusy = true;
      try {
        const list = parsePairList(await request("pairing", undefined, modalAbort.signal));
        if (!modal || modal.seq !== seq) return;
        devices = list.devices; pending = list.pending; renderDevices();
        const next = pending.find((p) => p.pairingId === id);
        if (!next) { modal.offerCode = ""; modal.message = t("该配对已不在待办中，请查看设备列表核实；不会自动重新配对。"); modal.pair = { ...modal.pair, state: "cancelled" }; }
        else {
          const changed = modal.pair.peer && (next.peer?.deviceId !== modal.pair.peer.deviceId || next.peer?.name !== modal.pair.peer.name || next.peer?.fingerprint !== modal.pair.peer.fingerprint || next.verificationCode !== modal.pair.verificationCode);
          if (changed) modal.confirmChecked = false;
          // 已经向宿主确认的身份不得在后续轮询中被换成另一台设备。
          if (changed && modal.pair.localConfirmed) { modal.offerCode = ""; modal.pair = { ...modal.pair, state: "cancelled" }; throw error("PAIRING_MISMATCH"); }
          modal.pair = next; modal.message = "";
          if (next.state !== "offered") modal.offerCode = "";
        }
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); }
      finally {
        if (modal?.seq === seq) {
          modalBusy = false;
          if (before !== pairViewKey()) renderPair();
          else {
            paintModalMessage();
            const confirmButton = modal.el.querySelector('[data-rs="confirm-pair"]');
            if (confirmButton) confirmButton.disabled = !canConfirmPair();
          }
          schedulePair();
        }
      }
    }
    async function pairAction(action) {
      if (modal?.kind !== "pair" || !modal.pair || modalBusy || (action === "confirm" && !canConfirmPair())) return;
      const seq = modal.seq, p = modal.pair; modalBusy = true; modal.confirmChecked = false; modal.message = ""; renderPair();
      try {
        const result = await request("pairing", { action, pairingId: p.pairingId, ...(action === "confirm" ? { verificationCode: p.verificationCode, expectedFingerprint: p.peer.fingerprint } : {}) }, modalAbort.signal);
        if (!modal || modal.seq !== seq) return;
        if (action === "cancel") { modal.offerCode = ""; modal.pair = { ...p, state: "cancelled" }; }
        else { const next = parsePair(result.pairing); if (next.pairingId !== p.pairingId || next.peer?.deviceId !== p.peer.deviceId || next.peer?.fingerprint !== p.peer.fingerprint || next.verificationCode !== p.verificationCode || !next.localConfirmed) throw error("REMOTE_RESPONSE_INVALID"); modal.pair = next; modal.offerCode = ""; }
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); }
      finally { if (modal?.seq === seq) { modalBusy = false; renderPair(); schedulePair(); } }
    }
    function openUnpair(d) {
      openModal("unpair", t("解除设备配对？")); modal.device = d;
      renderUnpair();
    }
    function renderUnpair() {
      renderModal(`<strong>${E(modal.device.name || t("未命名设备"))}</strong><code class="rs-fingerprint">${E(modal.device.fingerprint)}</code>` + hint(t("解除后将撤销此设备相关的全部托管授权并清理本机临时远程内容，不停止平板任务。已被查看或截图的内容无法远程擦除。")), button("close", t("保留配对")) + button("confirm-unpair", t("解除并撤销相关授权"), "rs-danger", modalBusy ? "disabled" : ""));
    }
    async function unpair() {
      if (modal?.kind !== "unpair" || modalBusy) return;
      const seq = modal.seq, d = modal.device; modalBusy = true; modal.message = ""; renderUnpair();
      try {
        await request("pairing", { action: "unpair", deviceId: d.deviceId }, modalAbort.signal);
        if (!modal || modal.seq !== seq) return;
        const list = parsePairList(await request("pairing", undefined, modalAbort.signal));
        if (!modal || modal.seq !== seq) return;
        if (list.devices.some((x) => x.deviceId === d.deviceId)) throw error("REMOTE_RESPONSE_INVALID");
        devices = list.devices; pending = list.pending; renderDevices();
        document.dispatchEvent(new CustomEvent("cc:remote-access-changed", { detail: { reason: "unpaired", deviceId: d.deviceId } }));
        closeModal();
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); }
      finally { if (modal?.seq === seq) { modalBusy = false; renderUnpair(); } }
    }

    function parseHosting(value, localSessionId) {
      if (value.session?.localSessionId !== localSessionId || !Array.isArray(value.devices) || value.devices.length > 100 || !(value.hosting === null || (value.hosting && typeof value.hosting === "object"))) throw error("REMOTE_RESPONSE_INVALID");
      let hosting = null;
      if (value.hosting) {
        const h = value.hosting;
        if (!validId(h.remoteSessionId) || !validId(h.deviceId) || !Number.isSafeInteger(h.grantVersion) || h.grantVersion < 1 || !["invited", "active", "revoked", "expired"].includes(h.status)) throw error("REMOTE_RESPONSE_INVALID");
        hosting = { remoteSessionId: h.remoteSessionId, deviceId: h.deviceId, deviceName: text(h.deviceName, 80), grantVersion: h.grantVersion, status: h.status, expiresAt: when(h.expiresAt) };
      }
      return { localSessionId, title: text(value.session.title, 512), devices: value.devices.map(device).filter(Boolean), hosting, connection: connection(value.connection) };
    }
    async function openHosting(localSessionId) {
      if (!validId(localSessionId)) { if (typeof toast === "function") toast(t("请先选择一个有效的本机会话"), true); return false; }
      openModal("hosting", t("托管当前会话")); modal.localSessionId = localSessionId; modal.selectedDevice = ""; return refreshHosting();
    }
    async function refreshHosting() {
      if (modal?.kind !== "hosting" || modalBusy) return null;
      const seq = modal.seq, id = modal.localSessionId; modalBusy = true; modal.message = "";
      if (modal.snapshot) renderHosting();
      try {
        const snapshot = parseHosting(await request("hosting?localSessionId=" + encodeURIComponent(id), undefined, modalAbort.signal), id);
        if (!modal || modal.seq !== seq) return null;
        modal.snapshot = snapshot; modal.confirmRevoke = false; modal.needsRefresh = false;
        if (!snapshot.devices.some((d) => d.deviceId === modal.selectedDevice)) modal.selectedDevice = "";
        return snapshot;
      } catch (err) { if (modal?.seq === seq) modal.message = failure(err); return null; }
      finally { if (modal?.seq === seq) { modalBusy = false; renderHosting(); } }
    }
    function renderHosting() {
      if (modal?.kind !== "hosting") return;
      const s = modal.snapshot;
      if (!s) { renderModal(hint(t("无法读取此会话托管状态；不会开放其他会话。")), button("refresh-hosting", t("重试")) + button("close", t("关闭"))); return; }
      const h = s.hosting, authorized = h && ["invited", "active"].includes(h.status);
      modal.heading = authorized ? t("管理此会话的托管") : t("托管当前会话");
      let body = `<h3 class="rs-session-title">${E(s.title || t("未命名会话"))}</h3>` + status(connectionLabel(s.connection), s.connection.state === "online" ? "rs-ok" : "rs-warning");
      let foot = button("close", t("关闭")) + button("refresh-hosting", t("刷新状态"), "", modalBusy ? "disabled" : "");
      if (authorized) {
        body += status(h.status === "active" ? t("已托管给：{name}", { name: h.deviceName || t("已授权设备") }) : t("邀请已发出，等待手机接受：{name}", { name: h.deviceName || t("已授权设备") }), h.status === "active" ? "rs-ok" : "rs-warning");
        body += hint(t("仅此会话：可查看、处理本次审批和必要问答、发送文字指令与请求停止。审批不会自动放行。"));
        if (h.expiresAt) body += hint(t("授权有效期至：{time}", { time: new Date(h.expiresAt).toLocaleString() }));
        body += hint(t("手机断线不代表平板任务已停止。收回仅关闭远程访问，不停止、不删除原会话。"));
        if (modal.confirmRevoke) { body += `<div class="rs-warning-box">${hint(t("确认收回此会话的远程访问？平板原任务仍继续，已执行的操作不会自动撤销。"))}</div>`; foot = button("cancel-revoke", t("保留托管"), "", modalBusy ? "disabled" : "") + button("confirm-revoke", t("确认收回，不停止任务"), "rs-danger", modalBusy ? "disabled" : ""); }
        else foot += button("revoke", t("收回托管…"), "rs-danger", modalBusy || modal.needsRefresh ? "disabled" : "");
      } else if (!s.devices.length) {
        if (h) body += status(h.status === "revoked" ? t("此会话已收回托管，平板任务不受影响。") : t("此会话授权已到期。"));
        body += hint(t("先连接手机：还没有可接收邀请的已配对设备。请先在两端 CC 的图形设置里完成设备配对，再返回此会话。"));
        foot += button("settings", t("去连接设置"), "rs-primary");
      } else {
        if (h) body += status(h.status === "revoked" ? t("此会话已收回托管，平板任务不受影响。") : t("此会话授权已到期。"));
        body += `<label class="rs-field"><span>${E(t("发送到已配对设备"))}</span><select id="rs-host-device" data-remote-keyboard="1" ${modalBusy ? "disabled" : ""}><option value="">${E(t("请选择手机，并核对设备身份"))}</option>${s.devices.map((d) => `<option value="${E(d.deviceId)}" ${modal.selectedDevice === d.deviceId ? "selected" : ""}>${E(d.name || t("未命名设备"))}</option>`).join("")}</select></label>`;
        const d = s.devices.find((x) => x.deviceId === modal.selectedDevice);
        body += `<code id="rs-host-fingerprint" class="rs-fingerprint">${E(d?.fingerprint || "")}</code>`;
        body += hint(t("手机可以看此会话、处理本次审批和必要问答、发文字指令与请求停止。首版同一会话只授权一台手机。"));
        body += hint(t("不开放其他会话，不同步整个项目。此会话已有的代码、日志或敏感信息会随消息传输。"));
        body += hint(t("邀请须由手机接受；接受不等于批准任何工具，仍逐项确认。平板始终保留本地审批、停止与收回入口。"));
        if (s.connection.state !== "online") { body += hint(t("中转未连接，不能发送托管邀请；请先检查真实连接。"), "rs-warning"); foot += button("settings", t("去连接设置")); }
        foot += button("invite", t("发送托管邀请"), "rs-primary", modalBusy || modal.needsRefresh || !d || s.connection.state !== "online" ? "disabled" : "");
      }
      body += hint(t("中转连接在线不代表端到端安全通道已就绪；会话内容仅能在端到端安全通道验证后传输。"));
      body += hint(t("平板请插电并保持 CC 开着；系统弹窗需在平板本地处理，不绕过应用安全检查。"));
      renderModal(body, foot);
      modal.el.querySelector("#rs-host-device")?.addEventListener("change", (event) => {
        modal.selectedDevice = event.target.value;
        const d = s.devices.find((x) => x.deviceId === modal.selectedDevice), fp = modal.el.querySelector("#rs-host-fingerprint");
        if (fp) fp.textContent = d?.fingerprint || "";
        const b = modal.el.querySelector('[data-rs="invite"]'); if (b) b.disabled = modalBusy || modal.needsRefresh || !d || s.connection.state !== "online";
      });
    }
    async function hostingAction(action) {
      if (modal?.kind !== "hosting" || !modal.snapshot || modalBusy || modal.needsRefresh) return;
      const seq = modal.seq, s = modal.snapshot, h = s.hosting;
      if (action === "invite" && (!s.devices.some((d) => d.deviceId === modal.selectedDevice) || s.connection.state !== "online" || (h && ["active", "invited"].includes(h.status)))) return;
      if (action === "revoke" && (!modal.confirmRevoke || !h || !["invited", "active"].includes(h.status))) return;
      const body = { action, localSessionId: s.localSessionId, ...(action === "invite" ? { deviceId: modal.selectedDevice } : { remoteSessionId: h.remoteSessionId, grantVersion: h.grantVersion }) };
      modalBusy = true; modal.message = ""; renderHosting();
      try {
        const result = parseHosting(await request("hosting", body, modalAbort.signal), s.localSessionId);
        if (!modal || modal.seq !== seq) return;
        if (action === "invite" && (!result.hosting || !["invited", "active"].includes(result.hosting.status) || result.hosting.deviceId !== body.deviceId)) throw error("REMOTE_RESPONSE_INVALID");
        if (action === "revoke" && (result.hosting?.remoteSessionId !== h.remoteSessionId || !["revoked", "expired"].includes(result.hosting.status))) throw error("REMOTE_RESPONSE_INVALID");
        modal.snapshot = result; modal.confirmRevoke = false;
        document.dispatchEvent(new CustomEvent("cc:remote-access-changed", { detail: { reason: action === "revoke" ? "revoked" : "invited", localSessionId: s.localSessionId } }));
      } catch (err) { if (modal?.seq === seq) { modal.message = failure(err); modal.confirmRevoke = false; modal.needsRefresh = true; } }
      finally { if (modal?.seq === seq) { modalBusy = false; renderHosting(); } }
    }
    function modalClick(event) {
      const b = event.target.closest("button[data-rs]"); if (!b || b.disabled || !modal?.el.contains(b)) return;
      switch (b.dataset.rs) {
        case "close": closeModal(); break;
        case "create-pair": createPair(); break;
        case "copy-pair": copyPairCode(); break;
        case "refresh-pair": refreshPair(); break;
        case "confirm-pair": pairAction("confirm"); break;
        case "cancel-pair": pairAction("cancel"); break;
        case "reset-pair": modal.pair = null; modal.offerCode = ""; modal.confirmChecked = false; modal.message = ""; renderPair(); break;
        case "finish-pair": closeModal(); if (pageActive) refreshDevices(); break;
        case "confirm-unpair": unpair(); break;
        case "refresh-hosting": refreshHosting(); break;
        case "invite": hostingAction("invite"); break;
        case "revoke": if (!modalBusy && !modal.needsRefresh) { modal.confirmRevoke = true; modal.message = ""; renderHosting(); } break;
        case "cancel-revoke": if (!modalBusy) { modal.confirmRevoke = false; renderHosting(); } break;
        case "confirm-revoke": hostingAction("revoke"); break;
        case "settings": closeModal(); document.dispatchEvent(new CustomEvent("cc:remote-settings-open")); break;
      }
    }
    addEventListener("pagehide", () => { leavePage(); closeModal(); });
    addEventListener("blur", clearSecrets);
    document.addEventListener("visibilitychange", () => { if (document.hidden) clearSecrets(); });
    const remoteSettings = Object.freeze({ open: openSettings, close: leavePage });
    const remoteHosting = Object.freeze({ open: openHosting, refresh: refreshHosting, close: closeModal });
    // 同闭包供导航调用；window 入口供宿主与独立页面集成，不暴露内部状态或凭据。
    window.remoteSettings = remoteSettings; window.remoteHosting = remoteHosting;
    return { remoteSettings, remoteHosting };
  })();

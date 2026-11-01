// OpenAI bridge configuration stays in Extensions; saving never sends a model request.
// Adapted from openai-bridge-ui-design/{DESIGN.zh-CN.md,BRIEF.zh-CN.md,preview.html}.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const t = (s, vars) => window.I18N ? window.I18N.t(s, vars) : s.replace(/\{(\w+)\}/g, (m, k) => vars && k in vars ? String(vars[k]) : m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const API = "/api/components/openai-bridge/config", MODELS_API = "/api/components/openai-bridge/models";
  const MODEL_DELAY = 650, MODEL_LIMIT = 500, MODEL_TIMEOUT = 15000, SUGGEST_MAX = 100;
  let panel = null, options = {}, snapshot = null, busy = false, seq = 0, returnTop = 0;
  // Discovery state contains only IDs/origins and cancellation handles, never a key or key fingerprint.
  let modelsTimer = null, modelsDeadline = null, modelsAbort = null, modelsSeq = 0;
  let modelItems = [], modelsConnected = false, currentOrigin = "", consentOrigin = "", suggestAt = -1;
  const readError = (status, code) => {
    if (code === "BUSY") return t("本地桥正在使用或卸载中，请稍后重试；当前会话保持不变。");
    if (code === "RUNTIME_CONFLICT") return t("已有桥安装不能自动迁移，请先备份并由你处理原安装；未覆盖或卸载。");
    return status === 404 || code === "not_installed" ? t("请先安装或更新 OpenAI API 本地协议桥组件。") : t("读取桥配置失败，请返回扩展后重试。");
  };
  const visible = () => !!panel && $("tab-ext").classList.contains("bridge-config-open") && !$("tab-ext").classList.contains("hidden") && !$("pages").classList.contains("hidden") && !$("pages")._moLeave;

  // Only unambiguous Chat Completions paths are completed; the server validates again.
  function endpointOf(raw) {
    let u;
    raw = String(raw).trim();
    if (!raw || raw.length > 2048 || /[\u0000- \u007f\\]/.test(raw)) return { error: t("请输入完整的 HTTPS API 地址，例如 https://api.example.com/v1。") };
    try { u = new URL(raw); } catch { return { error: t("请输入完整的 HTTPS API 地址，例如 https://api.example.com/v1。") }; }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
      return { error: t("请使用不带账号、密码、参数和片段的 HTTPS API 地址。") };
    const path = u.pathname.replace(/\/+$/, "");
    if (/\/responses$/i.test(path)) return { error: t("这里需要 Chat Completions 地址，暂不支持 Responses API。"), origin: u.origin };
    if (!path || path === "/v1") u.pathname = "/v1/chat/completions";
    else if (path.endsWith("/chat/completions")) u.pathname = path;
    else return { error: t("该路径无法自动补全，请填写服务商提供的完整 /chat/completions 地址。"), origin: u.origin };
    return { url: u.href, origin: u.origin };
  }
  // 上下文窗口：空 = 0（不知道）；k / m 按千 / 百万；不合法回 null
  function ctxOf(raw) {
    const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(raw).trim().replace(/[,_]/g, ""));
    if (!String(raw).trim() || /^0+(?:\.0+)?$/.test(String(raw).trim())) return 0;
    if (!m) return null;
    const n = Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
    return n >= 1024 && n <= 16777216 ? n : null;
  }
  function safeSnapshot(data) {
    const local = data.local || {};
    const endpoint = endpointOf(typeof data.endpoint === "string" ? data.endpoint : "");
    const model = typeof data.model === "string" ? data.model : "";
    return {
      installed: data.installed === true, configured: data.configured === true && !endpoint.error && !!model && model.length <= 200 && !/[,\u0000-\u001f\u007f]/.test(model), hasKey: data.hasKey === true,
      endpoint: endpoint.error ? "" : data.endpoint, model,
      providerId: typeof data.providerId === "string" ? data.providerId : "",
      contextWindow: Number.isInteger(data.contextWindow) && data.contextWindow > 0 ? data.contextWindow : 0,
      local: { state: ["ready", "error", "stopped", "starting"].includes(local.state) ? local.state : "stopped" },
    };
  }
  async function request(body) {
    const init = {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      headers: { "X-CC-Lang": window.I18N ? window.I18N.lang : "zh", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    try {
      const r = await fetch(API, init);
      let data;
      try { data = await r.json(); } catch { throw { status: r.status }; }
      if (!r.ok || data.ok === false) throw { status: r.status, field: data.field, code: data.code, saved: data.saved === true };
      return data;
    } finally { if (body) init.body = ""; }
  }
  function createPanel() {
    panel = document.createElement("section");
    panel.id = "bridge-config-panel";
    panel.setAttribute("aria-labelledby", "bridge-config-title");
    panel.innerHTML = `
      <button type="button" class="bc-back" data-bc="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>${esc(t("返回扩展"))}</button>
      <header class="bc-heading"><h2 id="bridge-config-title" tabindex="-1">${esc(t("OpenAI API 本地协议桥"))} <span class="badge">${esc(t("预览"))}</span></h2><p>${esc(t("填好地址、密钥和模型就能用；上下文窗口选填。"))}</p></header>
      <p class="bc-notice hidden" id="bc-notice" role="alert"></p>
      <div id="bc-loading" role="status">${esc(t("读取中…"))}</div>
      <form id="bc-form" class="bc-card hidden" novalidate autocomplete="off">
        <h3>${esc(t("连接你的 API"))}</h3>
        <div class="field"><label for="bc-endpoint">${esc(t("API 地址"))}</label><input id="bc-endpoint" type="url" dir="ltr" inputmode="url" enterkeyhint="next" placeholder="https://api.example.com/v1" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="2048" aria-describedby="bc-endpoint-hint bc-endpoint-error bc-endpoint-preview" required><p class="bc-hint" id="bc-endpoint-hint">${esc(t("填写服务商的 API 地址，不是官网登录页。"))}</p><p class="bc-error hidden" id="bc-endpoint-error"></p><p class="bc-hint mono hidden" id="bc-endpoint-preview" dir="ltr"></p></div>
        <div class="field"><label for="bc-key">${esc(t("API Key"))}</label><div class="bc-key-wrap"><input id="bc-key" type="password" dir="ltr" enterkeyhint="next" spellcheck="false" autocapitalize="none" autocorrect="off" autocomplete="off" maxlength="1024" aria-describedby="bc-key-hint bc-key-error"><button type="button" class="bc-eye" data-bc="eye" aria-label="${esc(t("显示密钥"))}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><p class="bc-hint" id="bc-key-hint"></p><p class="bc-error hidden" id="bc-key-error"></p></div>
        <div class="bc-discovery"><label class="bc-model-consent" for="bc-model-consent"><input id="bc-model-consent" type="checkbox" aria-describedby="bc-model-origin bc-model-status"><span>${esc(t("允许自动读取模型清单（会将 API Key 发往所填服务，不发送对话、不调用模型）"))}</span></label><p class="bc-hint mono" id="bc-model-origin" dir="ltr"></p><div class="bc-model-feedback"><p class="bc-hint" id="bc-model-status" role="status" aria-live="polite" aria-atomic="true"></p><button class="btn ghost sm bc-model-retry" type="button" id="bc-model-retry" data-bc="models-retry">${esc(t("重试读取清单"))}</button></div></div>
        <div class="field"><label for="bc-model">${esc(t("模型名称"))}</label><input id="bc-model" type="text" dir="ltr" enterkeyhint="done" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="200" placeholder="${esc(t("输入搜索或手填模型名称"))}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bc-model-list" aria-describedby="bc-model-hint bc-model-error bc-model-status" required><ul class="bc-suggest hidden" id="bc-model-list" role="listbox" aria-label="${esc(t("模型清单"))}"></ul><p class="bc-hint" id="bc-model-hint">${esc(t("可输入搜索清单，也可按服务商提供的名称手填。"))}</p><p class="bc-error hidden" id="bc-model-error"></p></div>
        <div class="field"><label for="bc-ctx">${esc(t("上下文窗口（可选）"))}</label><input id="bc-ctx" type="text" dir="ltr" inputmode="numeric" enterkeyhint="done" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="12" placeholder="1048576 / 256k / 1m" aria-describedby="bc-ctx-hint bc-ctx-error"><p class="bc-hint" id="bc-ctx-hint">${esc(t("模型能读多少 token。不填按 200k 算，自动压缩线也到不了更高。"))}</p><p class="bc-error hidden" id="bc-ctx-error"></p></div>
        <p class="bc-hint bc-privacy">${esc(t("对话、工具结果和图片将发往你填写的服务。"))}</p>
        <button class="btn" id="bc-save" type="submit">${esc(t("保存配置"))}</button><p class="bc-hint bc-center" id="bc-save-note" role="status">${esc(t("保存不调用远端模型，也不切换当前会话"))}</p>
      </form>
      <section id="bc-saved" class="bc-card hidden" aria-labelledby="bc-saved-title"><h3 id="bc-saved-title" tabindex="-1">${esc(t("配置已保存"))}</h3><dl class="bc-summary"><div><dt>${esc(t("API 地址"))}</dt><dd class="mono" id="bc-saved-endpoint" dir="ltr"></dd></div><div><dt>${esc(t("API Key"))}</dt><dd>${esc(t("已设置 · 不回显"))}</dd></div><div><dt>${esc(t("模型名称"))}</dt><dd class="mono" id="bc-saved-model" dir="ltr"></dd></div><div><dt>${esc(t("上下文窗口"))}</dt><dd class="mono" id="bc-saved-ctx" dir="ltr"></dd></div></dl><div class="bc-status" role="status"><b id="bc-local-state"></b><span id="bc-remote-state">${esc(t("模型推理尚未验证"))}</span></div><p class="bc-hint">${esc(t("已添加到「接口与型号」。当前会话保持不变。"))}</p><div class="bc-actions"><button class="btn" type="button" id="bc-use" data-bc="use">${esc(t("新建会话使用"))}</button><button class="btn ghost" type="button" data-bc="edit">${esc(t("修改配置"))}</button></div><p class="bc-hint">${esc(t("别的会话也能用：点输入栏下的模型标签，在接口一行选它。"))}</p></section>
      <p class="bc-hint bc-footnote">${esc(t("仅支持 OpenAI Chat Completions API，暂不支持 Responses API。"))}</p>`;
    $("tab-ext").appendChild(panel);
    $("bc-form").addEventListener("submit", save);
    panel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-bc]"); if (!b || busy) return;
      const action = b.dataset.bc;
      if (action === "back") close();
      else if (action === "eye") {
        const show = $("bc-key").type === "password";
        $("bc-key").type = show ? "text" : "password";
        b.setAttribute("aria-label", show ? t("隐藏密钥") : t("显示密钥")); b.setAttribute("aria-pressed", String(show));
      } else if (action === "edit") showForm();
      else if (action === "use") useNew();
      else if (action === "models-retry") scheduleModels(0);
    });
    for (const name of ["endpoint", "key", "model"]) $("bc-" + name).addEventListener("input", () => {
      $("bc-" + name).removeAttribute("aria-invalid"); $("bc-" + name + "-error").classList.add("hidden");
      // 模型清单在本地过滤；改模型名不看密钥、不重新读取
      if (name === "model") { suggestAt = -1; renderSuggest(true); return; }
      cancelModels(true);
      if (name === "endpoint") {
        const endpoint = endpointOf($("bc-endpoint").value);
        if (endpoint.origin) {
          if (currentOrigin && currentOrigin !== endpoint.origin) {
            hideKey(true); $("bc-model-consent").checked = false; consentOrigin = "";
          }
          currentOrigin = endpoint.origin;
        }
        previewEndpoint();
      }
      scheduleModels();
    });
    // 原生 datalist 的弹层在安卓 WebView 上不贴输入框、半透明叠在页面上，改成排在输入框下面的列表
    const model = $("bc-model"), list = $("bc-model-list");
    model.addEventListener("focus", () => { suggestAt = -1; renderSuggest(true); });
    model.addEventListener("blur", () => renderSuggest(false));
    model.addEventListener("keydown", (e) => {
      const n = list.children.length;
      if (e.key === "Escape" && n) { e.preventDefault(); renderSuggest(false); }
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.isComposing) {
        e.preventDefault();
        if (!n) { renderSuggest(true); return; }
        suggestAt = e.key === "ArrowDown" ? (suggestAt + 1) % n : (suggestAt <= 0 ? n - 1 : suggestAt - 1);
        renderSuggest(true);
        // 只滚列表自己，scrollIntoView 会连外层页面一起滚
        const li = list.children[suggestAt];
        if (li) list.scrollTop = Math.min(Math.max(list.scrollTop, li.offsetTop + li.offsetHeight - list.clientHeight), li.offsetTop);
      } else if (e.key === "Enter" && !e.isComposing && suggestAt >= 0 && n) { e.preventDefault(); pickSuggest(list.children[suggestAt].dataset.value); }
    });
    // 按住列表项时别让输入框失焦（失焦就收起了）；滑动、拖滚动条照常
    for (const ev of ["pointerdown", "mousedown"]) list.addEventListener(ev, (e) => { if (e.target.closest("li[data-value]")) e.preventDefault(); });
    list.addEventListener("click", (e) => { const li = e.target.closest("li[data-value]"); if (li) pickSuggest(li.dataset.value); });
    $("bc-model-consent").addEventListener("change", () => {
      const endpoint = endpointOf($("bc-endpoint").value);
      consentOrigin = $("bc-model-consent").checked && !endpoint.error ? endpoint.origin : "";
      if (!consentOrigin) $("bc-model-consent").checked = false;
      scheduleModels();
    });
  }
  function hideKey(clear = false) {
    if (!panel) return;
    $("bc-key").type = "password";
    if (clear) $("bc-key").value = "";
    const eye = panel.querySelector('[data-bc="eye"]');
    eye.setAttribute("aria-label", t("显示密钥")); eye.setAttribute("aria-pressed", "false");
  }
  function notice(text) { $("bc-notice").textContent = text; $("bc-notice").classList.toggle("hidden", !text); }
  function errorsClear() {
    notice("");
    for (const name of ["endpoint", "key", "model", "ctx"]) { $("bc-" + name).removeAttribute("aria-invalid"); $("bc-" + name + "-error").classList.add("hidden"); }
  }
  function error(name, text) {
    const input = $("bc-" + name), hint = $("bc-" + name + "-error");
    input.setAttribute("aria-invalid", "true"); hint.textContent = text; hint.classList.remove("hidden"); return input;
  }
  function previewEndpoint() {
    const raw = $("bc-endpoint").value.trim(), result = endpointOf(raw);
    $("bc-endpoint-preview").classList.toggle("hidden", !raw || !!result.error);
    $("bc-endpoint-preview").textContent = raw && !result.error ? t("请求地址：{url}", { url: result.url }) : "";
    $("bc-model-origin").textContent = result.error ? t("目标服务：请先填写有效的 HTTPS API 地址。") : t("目标服务：{origin}", { origin: result.origin });
    const old = snapshot && endpointOf(snapshot.endpoint);
    const changed = snapshot && snapshot.hasKey && old && old.origin && result.origin && old.origin !== result.origin;
    $("bc-key-hint").textContent = changed ? t("服务地址已改变，请重新填写 API Key，旧密钥不会发往新地址。") : snapshot && snapshot.hasKey ? t("不回显已保存的密钥；留空保持不变，填写新密钥可替换。") : t("密钥保存后不回显。");
    $("bc-key").required = !(snapshot && snapshot.hasKey && old.origin === result.origin);
  }
  function discoveryKeyReady(endpoint) {
    if ($("bc-key").value.trim()) return $("bc-key").value.trim().length <= 1024 && !/[\u0000- \u007f]/.test($("bc-key").value.trim());
    // The server is the final authority; the client never receives the saved secret.
    return !!snapshot && snapshot.hasKey && endpointOf(snapshot.endpoint).origin === endpoint.origin;
  }
  function discoveryAllowed(endpoint) {
    return !!snapshot && snapshot.installed && !busy && visible() && !document.hidden && !$("bc-form").classList.contains("hidden") && !endpoint.error && $("bc-model-consent").checked && consentOrigin === endpoint.origin && discoveryKeyReady(endpoint);
  }
  function updateModelsControls() {
    if (!panel) return;
    const endpoint = endpointOf($("bc-endpoint").value);
    $("bc-model-consent").disabled = busy || !!endpoint.error;
    $("bc-model-retry").disabled = busy || modelsTimer !== null || !!modelsAbort || !discoveryAllowed(endpoint);
  }
  function updateSaveNote(saving = false) {
    $("bc-save-note").textContent = saving ? t("正在保存并检查本地桥，不调用远端模型…") : modelsConnected ? t("读取清单已连接服务，尚未验证模型推理；保存不调用远端模型，也不切换当前会话。") : t("保存不调用远端模型，也不切换当前会话");
  }
  // 输入为空或正好是清单里某一项时列全部，否则按包含过滤；太长只列前 SUGGEST_MAX 个，继续输入缩小
  function renderSuggest(open) {
    if (!panel) return;
    const list = $("bc-model-list"), input = $("bc-model");
    if (open === undefined) open = !list.classList.contains("hidden");
    const q = input.value.trim().toLowerCase();
    const items = !open || document.activeElement !== input ? []
      : (q && !modelItems.some((id) => id.toLowerCase() === q) ? modelItems.filter((id) => id.toLowerCase().includes(q)) : modelItems).slice(0, SUGGEST_MAX);
    if (suggestAt >= items.length) suggestAt = -1;
    list.textContent = "";
    items.forEach((id, i) => {
      const li = document.createElement("li");
      li.id = "bc-model-opt-" + i; li.setAttribute("role", "option"); li.dataset.value = id; li.textContent = id;
      li.setAttribute("aria-selected", String(i === suggestAt));
      list.appendChild(li);
    });
    list.classList.toggle("hidden", !items.length);
    input.setAttribute("aria-expanded", String(!!items.length));
    if (suggestAt >= 0) input.setAttribute("aria-activedescendant", "bc-model-opt-" + suggestAt);
    else input.removeAttribute("aria-activedescendant");
  }
  function pickSuggest(id) {
    const input = $("bc-model");
    input.value = id; input.removeAttribute("aria-invalid"); $("bc-model-error").classList.add("hidden");
    suggestAt = -1; renderSuggest(false);
  }
  function renderModels() { renderSuggest(); }
  function cancelModels(clear = false) {
    const pending = modelsTimer !== null || !!modelsAbort;
    ++modelsSeq;
    if (modelsTimer !== null) clearTimeout(modelsTimer);
    if (modelsDeadline !== null) clearTimeout(modelsDeadline);
    modelsTimer = modelsDeadline = null;
    if (modelsAbort) { modelsAbort.abort(); modelsAbort = null; }
    if (clear) { modelItems = []; modelsConnected = false; renderModels(); }
    return pending;
  }
  function modelPrompt(endpoint) {
    if (!$("bc-model-consent").checked) return t("勾选后自动读取清单，也可直接手填模型。");
    if (endpoint.error) return t("请先填写有效的 HTTPS API 地址。");
    if (!discoveryKeyReady(endpoint)) return t("请填写有效的 API Key 后自动读取清单。");
    return t("读取已取消，可重试或手填模型。");
  }
  function scheduleModels(delay = MODEL_DELAY) {
    cancelModels();
    const endpoint = endpointOf($("bc-endpoint").value);
    if (!discoveryAllowed(endpoint)) {
      $("bc-model-status").textContent = modelPrompt(endpoint); updateSaveNote(); updateModelsControls(); return;
    }
    const generation = modelsSeq, page = seq;
    $("bc-model-status").textContent = t("准备读取模型清单…");
    modelsTimer = setTimeout(() => {
      if (generation !== modelsSeq || page !== seq) return;
      modelsTimer = null;
      if (!modelsCurrent(generation, page, endpoint)) { updateModelsControls(); return; }
      fetchModels(generation, page, endpoint);
    }, delay);
    updateSaveNote(); updateModelsControls();
  }
  function modelsCurrent(generation, page, endpoint) {
    return generation === modelsSeq && page === seq && discoveryAllowed(endpoint) && endpointOf($("bc-endpoint").value).url === endpoint.url;
  }
  function modelsError(status, code) {
    // Gateway codes are allowlisted; never render upstream messages or diagnostics.
    if (status === 401 || code === "MODELS_AUTH") return t("API Key 未获授权，请检查后重试。");
    if (status === 403 || code === "MODELS_FORBIDDEN") return t("服务拒绝读取模型清单，请检查权限或手填模型。");
    if (status === 404 || status === 405 || status === 501 || code === "MODELS_NOT_FOUND" || code === "MODELS_UNSUPPORTED" || code === "models_unsupported") return t("服务不支持读取模型清单，请手填模型名称。");
    if (status === 429 || code === "MODELS_RATE_LIMIT") return t("读取模型清单过于频繁，请稍后重试。");
    if (status === 408 || status === 504 || code === "MODELS_TIMEOUT") return t("读取模型清单超时，可重试或手填模型。");
    if (code === "KEY_REQUIRED" || code === "KEY_HOST_CHANGED" || code === "invalid_key") return t("请重新填写 API Key 后重试读取清单。");
    return t("暂时无法读取模型清单，可重试或手填模型。");
  }
  async function fetchModels(generation, page, endpoint) {
    if (!modelsCurrent(generation, page, endpoint)) return;
    const controller = new AbortController();
    modelsAbort = controller;
    // Read a replacement key only when sending this same-origin POST, not when scheduling/filtering.
    const body = { endpoint: $("bc-endpoint").value.trim(), consent: true };
    if ($("bc-key").value.trim()) body.apiKey = $("bc-key").value.trim();
    const init = {
      method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-CC-Lang": window.I18N ? window.I18N.lang : "zh" },
      body: JSON.stringify(body),
    };
    let timedOut = false;
    modelsDeadline = setTimeout(() => { timedOut = true; controller.abort(); }, MODEL_TIMEOUT);
    $("bc-model-status").textContent = t("正在读取模型清单…"); updateModelsControls();
    try {
      const r = await fetch(MODELS_API, init);
      let data;
      try { data = await r.json(); } catch { throw { status: r.status }; }
      if (!modelsCurrent(generation, page, endpoint) || modelsAbort !== controller) return;
      if (timedOut) throw { status: 504 };
      if (!r.ok || !data || data.ok !== true) throw { status: r.status, code: data && data.code };
      if (!Array.isArray(data.models)) throw { code: "models_unsupported" };
      modelsConnected = true;
      const ids = new Set();
      for (const item of data.models.slice(0, MODEL_LIMIT)) {
        if (item && typeof item.id === "string" && item.id.trim() && item.id.length <= 200 && !/[,\u0000-\u001f\u007f]/.test(item.id)) ids.add(item.id);
      }
      modelItems = [...ids]; renderModels();
      $("bc-model-status").textContent = !modelItems.length ? t("模型清单为空，请手填模型名称或重试。") : data.truncated === true || data.models.length > MODEL_LIMIT ? t("已读取 {count} 个模型（最多 500 个），可搜索或手填其他名称。", { count: modelItems.length }) : t("已读取 {count} 个模型，可输入搜索或手填。", { count: modelItems.length });
      updateSaveNote();
    } catch (e) {
      if (!modelsCurrent(generation, page, endpoint) || modelsAbort !== controller) return;
      if (controller.signal.aborted && !timedOut) return;
      $("bc-model-status").textContent = modelsError(timedOut ? 504 : e.status, e.code);
    } finally {
      body.apiKey = ""; init.body = "";
      if (modelsAbort === controller) {
        if (modelsDeadline !== null) clearTimeout(modelsDeadline);
        modelsDeadline = null; modelsAbort = null; updateModelsControls();
      }
    }
  }
  function suspendModels() {
    if (!panel) return;
    if (cancelModels()) $("bc-model-status").textContent = t("读取已取消，可重试或手填模型。");
    updateModelsControls();
  }
  function setBusy(value, saving = false) {
    busy = value;
    panel.setAttribute("aria-busy", String(value));
    panel.querySelectorAll("input, button").forEach((el) => { el.disabled = value; });
    $("bc-save").textContent = value && saving ? t("正在准备本地桥…") : t("保存配置");
    updateSaveNote(value && saving); updateModelsControls();
    if (!value && !$("bc-saved").classList.contains("hidden")) $("bc-use").disabled = !snapshot || snapshot.local.state !== "ready" || !snapshot.providerId || typeof options.useNew !== "function";
  }
  function showForm() {
    cancelModels(true); consentOrigin = ""; $("bc-model-consent").checked = false;
    errorsClear(); hideKey(true);
    $("bc-form").classList.remove("hidden"); $("bc-saved").classList.add("hidden"); $("bc-loading").classList.add("hidden");
    $("bc-endpoint").value = snapshot ? snapshot.endpoint : ""; $("bc-model").value = snapshot ? snapshot.model : "";
    $("bc-ctx").value = snapshot && snapshot.contextWindow ? String(snapshot.contextWindow) : "";
    $("bc-key").placeholder = snapshot && snapshot.hasKey ? t("已保存，留空保持不变") : t("粘贴服务商提供的密钥");
    currentOrigin = endpointOf($("bc-endpoint").value).origin || "";
    previewEndpoint(); $("bc-model-status").textContent = t("勾选后自动读取清单，也可直接手填模型。");
    updateSaveNote(); updateModelsControls();
  }
  function showSaved() {
    cancelModels(); modelItems = []; renderModels(); consentOrigin = ""; $("bc-model-consent").checked = false;
    errorsClear(); hideKey(true);
    $("bc-form").classList.add("hidden"); $("bc-loading").classList.add("hidden"); $("bc-saved").classList.remove("hidden");
    $("bc-saved-endpoint").textContent = snapshot.endpoint; $("bc-saved-model").textContent = snapshot.model;
    $("bc-saved-ctx").textContent = snapshot.contextWindow ? snapshot.contextWindow.toLocaleString() : t("未填（按 200k 算）");
    $("bc-remote-state").textContent = modelsConnected ? t("读取清单已连接服务，尚未验证模型推理。") : t("模型推理尚未验证");
    const ready = snapshot.local.state === "ready";
    $("bc-local-state").textContent = ready ? t("本地已准备好") : t("配置已保存，但本地桥尚未就绪");
    $("bc-local-state").className = ready ? "bc-ready" : "bc-pending";
    $("bc-use").disabled = !ready || !snapshot.providerId || typeof options.useNew !== "function";
    updateModelsControls();
  }
  async function open(opts = {}) {
    if (busy) return;
    if (!panel) createPanel();
    cancelModels(true); currentOrigin = consentOrigin = ""; $("bc-model-consent").checked = false;
    options = opts; snapshot = null; errorsClear(); hideKey(true);
    const body = $("page-body"); returnTop = body.scrollTop;
    $("tab-ext").classList.add("bridge-config-open"); body.scrollTop = 0;
    $("bc-form").classList.add("hidden"); $("bc-saved").classList.add("hidden"); $("bc-loading").classList.remove("hidden");
    $("bridge-config-title").focus({ preventScroll: true });
    setBusy(true); const id = ++seq;
    try {
      const data = await request(); if (id !== seq || !visible()) return;
      snapshot = safeSnapshot(data);
      if (!snapshot.installed) { $("bc-loading").classList.add("hidden"); notice(t("请先安装或更新 OpenAI API 本地协议桥组件。")); }
      else if (snapshot.configured && snapshot.hasKey) showSaved();
      else showForm();
    } catch (e) {
      if (id !== seq || !visible()) return;
      $("bc-loading").classList.add("hidden");
      notice(readError(e.status, e.code));
    } finally { if (id === seq) setBusy(false); }
  }
  function close(force = false) {
    if (!panel || !$("tab-ext").classList.contains("bridge-config-open") || busy && !force) return false;
    ++seq; cancelModels(true); currentOrigin = consentOrigin = ""; $("bc-model-consent").checked = false;
    busy = false; hideKey(true); snapshot = null;
    $("tab-ext").classList.remove("bridge-config-open");
    $("bc-form").reset(); $("bc-saved-endpoint").textContent = $("bc-saved-model").textContent = $("bc-saved-ctx").textContent = "";
    $("page-body").scrollTop = returnTop;
    const anchor = options.anchor;
    options = {}; setBusy(false);
    if (!force && anchor && anchor.isConnected && anchor.getClientRects().length) anchor.focus({ preventScroll: true });
    return true;
  }
  async function save(e) {
    e.preventDefault(); if (busy || !snapshot) return;
    if (cancelModels()) $("bc-model-status").textContent = t("读取已取消，可重试或手填模型。");
    updateModelsControls(); errorsClear(); hideKey();
    const endpoint = endpointOf($("bc-endpoint").value), model = $("bc-model").value.trim();
    let first = null;
    if (endpoint.error) first = error("endpoint", endpoint.error);
    const old = endpointOf(snapshot.endpoint), changed = snapshot.hasKey && old.origin !== endpoint.origin;
    if (!$("bc-key").value.trim() && (!snapshot.hasKey || changed)) { const el = error("key", changed ? t("服务地址已改变，请重新填写 API Key，旧密钥不会发往新地址。") : t("请填写服务商提供的 API Key。")); first ||= el; }
    if ($("bc-key").value.trim().length > 1024 || /[\u0000- \u007f]/.test($("bc-key").value.trim())) { const el = error("key", t("API Key 不能包含空格或换行。")); first ||= el; }
    if (!model || model.length > 200 || /[,\u0000-\u001f\u007f]/.test(model)) { const el = error("model", t("请输入准确的模型名称，不要包含逗号或换行。")); first ||= el; }
    const ctx = ctxOf($("bc-ctx").value);
    if (ctx === null) { const el = error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。")); first ||= el; }
    if (first) { first.focus(); return; }
    if (!confirm(t("保存此 API 配置？\n\n后续使用时，对话、工具结果和图片将发往 {origin}。\n{verification}\n保存本身不调用远端模型，也不切换当前会话。", { origin: endpoint.origin, verification: modelsConnected ? t("读取清单已连接服务，尚未验证模型推理。") : t("模型推理尚未验证") }))) return;
    // Keep a replacement secret only in this input and the same-origin POST, never in UI state/storage.
    const body = { endpoint: $("bc-endpoint").value.trim(), model, consent: true };
    if (ctx) body.contextWindow = ctx;   // 留空不发：服务端按 0 处理（清掉旧值）
    if ($("bc-key").value.trim()) body.apiKey = $("bc-key").value.trim();
    const id = ++seq; setBusy(true, true);
    try {
      const data = await request(body); if (id !== seq || !visible()) return;
      snapshot = safeSnapshot(data);
      if (!snapshot.configured || !snapshot.hasKey) { notice(t("配置未完成，请检查字段后重试。")); return; }
      showSaved(); $("bc-saved-title").focus({ preventScroll: true });
      if (snapshot.local.state !== "ready") notice(t("配置已保存，但本地桥尚未就绪；不会切换接口，可修改配置后重试。"));
    } catch (err) {
      if (id !== seq || !visible()) return;
      if (err.field === "endpoint") error("endpoint", t("API 地址未通过检查，请确认服务商提供的地址。"));
      else if (err.field === "apiKey") error("key", t("请重新填写 API Key；更换服务地址时不能沿用旧密钥。"));
      else if (err.field === "contextWindow") error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。"));
      else if (err.field === "model") error("model", t("请输入准确的模型名称，不要包含逗号或换行。"));
      if (err.saved) notice(t("配置已保存，但本地桥尚未就绪；不会切换接口，可修改配置后重试。"));
      else notice(err.status === 409 ? t("本地桥正在使用或卸载中，请稍后重试；当前会话保持不变。") : t("保存配置未完成；请检查本地状态后重试，当前会话保持不变。"));
    } finally { body.apiKey = ""; if (id === seq) setBusy(false); }
  }
  async function useNew() {
    if (busy || !snapshot || snapshot.local.state !== "ready" || !snapshot.providerId || typeof options.useNew !== "function") return;
    const use = options.useNew, choice = { provider: snapshot.providerId, model: snapshot.model };
    setBusy(true);
    try { await use(choice); close(true); }
    catch { notice(t("未能为新会话选择此接口，请重试；没有发送任何消息。")); }
    finally { if (panel) setBusy(false); }
  }
  function covered() {
    return ["lightbox", "set-ov", "term-textview", "browser", "term", "git", "viewer", "files", "popup", "sheet", "drawer"].some((id) => {
      const el = $(id);
      return el && !el.classList.contains("hidden") && !el._moLeave && !(id === "drawer" && window.CCLayout && window.CCLayout.docked());
    }) || [...document.querySelectorAll(".pop-menu, [aria-modal='true']")].some((el) => el.getClientRects().length && !el.closest(".hidden"));
  }
  const back = window.__ccBack;
  if (typeof back === "function") window.__ccBack = function () {
    if (visible() && !covered()) { if (!busy) close(); return true; }
    return back.apply(this, arguments);
  };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && visible() && !covered() && !e.defaultPrevented) { e.preventDefault(); e.stopImmediatePropagation(); if (!busy) close(); } }, true);
  addEventListener("blur", () => { hideKey(); suspendModels(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { hideKey(); suspendModels(); } else updateModelsControls(); });
  addEventListener("pagehide", () => { if (panel) close(true); });
  new MutationObserver(() => { if (panel && $("tab-ext").classList.contains("bridge-config-open") && !visible()) close(true); })
    .observe($("pages"), { attributes: true, subtree: true, attributeFilter: ["class"] });
  window.CCBridgeConfig = { open, close };
})();

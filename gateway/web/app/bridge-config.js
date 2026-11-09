// OpenAI bridge configuration stays in Extensions; saving never sends a model request.
// Adapted from openai-bridge-ui-design/{DESIGN.zh-CN.md,BRIEF.zh-CN.md,preview.html}.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const t = (s, vars) => window.I18N ? window.I18N.t(s, vars) : s.replace(/\{(\w+)\}/g, (m, k) => vars && k in vars ? String(vars[k]) : m);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const API = "/api/components/openai-bridge/config", MODELS_API = "/api/components/openai-bridge/models", REPAIR_API = "/api/components/openai-bridge/repair";
  const MODEL_DELAY = 650, MODEL_LIMIT = 500, MODEL_TIMEOUT = 15000, SUGGEST_MAX = 100, CONFIG_MODEL_LIMIT = 100, DEFAULT_CTX = 200000;
  const LOCAL_ERRORS = ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "LOCAL_START_FAILED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED"];
  const localCode = (code) => LOCAL_ERRORS.includes(code) ? code : code ? "LOCAL_START_FAILED" : "";
  const CONFIG_CHECKS = ["COMPONENT", "OWNERSHIP", "CONNECTION", "APP_MAPPING", "APP_PROVIDER", "MODEL_LIST"];
  const checkCode = (code) => CONFIG_CHECKS.includes(code) ? code : "UNKNOWN";
  function localMessage(code) {
    if (code === "RECOVERY_EXHAUSTED") return t("自动恢复已停止，修改配置不会解除；请先诊断，再明确重置恢复次数。");
    if (code === "PATCH_VERIFICATION_FAILED") return t("桥补丁校验失败，自动恢复已停止；请先诊断并修复，保存配置不会解除故障。");
    if (code === "COMPONENT_DISABLED") return t("本地桥已停用，不能供新会话使用；请先确认组件状态，保存配置不会解除停用。");
    if (code === "COMPONENT_UNAVAILABLE") return t("本地桥组件暂不可用，可能正在更新或安装不完整；请先检查组件，不会自动重置恢复次数。");
    if (code === "UPDATE_REQUIRED") return t("桥运行副本需要更新；请先检查组件版本，当前不能供新会话使用。");
    return t("本地桥尚未就绪，请先检查本地诊断；当前会话保持不变，保存配置不会重置恢复次数。");
  }
  const validWindow = (n) => Number.isInteger(n) && n >= 1024 && n <= 16777216;
  const validModel = (id) => typeof id === "string" && !!id && id === id.trim() && id.length <= 200 && !/[,\u0000-\u001f\u007f-\u009f]/.test(id);
  let panel = null, options = {}, snapshot = null, busy = false, seq = 0, returnTop = 0;
  let repairPlan = null, repairUntil = 0, repairTimer = null;
  // Discovery state contains only model metadata/origins and cancellation handles, never a key or key fingerprint.
  let modelsTimer = null, modelsDeadline = null, modelsAbort = null, modelsSeq = 0;
  let modelItems = [], modelsConnected = false, currentOrigin = "", consentOrigin = "", suggestAt = -1;
  let modelWindows = new Map(), selectedModels = [], defaultModel = "", editingModel = "", ctxManual = false;
  const UPSTREAM_LIMIT = 16, validName = (name) => typeof name === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(name);
  let apiDrafts = [], activeApi = "", defaultSource = "", usedNames = new Set(), connectedApis = new Set();
  const hasDiscovered = () => modelsConnected || (multi() && connectedApis.size > 0);
  // Only user-entered replacement keys live here, scoped to this editor session and API name.
  // Saved secrets never arrive in the browser; drafts/topology contain no key properties.
  const draftKeys = new Map();
  const multi = () => snapshot?.capabilities?.multiUpstream === true;
  const activeDraft = () => apiDrafts.find((item) => item.name === activeApi);
  const savedSource = () => multi() ? snapshot.upstreams?.find((item) => item.name === activeApi) : snapshot;
  function clearDraftKeys() { draftKeys.clear(); }
  const readError = (status, code) => {
    if (code === "BUSY") return t("本地桥正在使用或卸载中，请稍后重试；当前会话保持不变。");
    if (code === "RUNTIME_CONFLICT") return t("桥配置一致性检查未通过，暂不能安全读取或保存；请查看检查说明，不要先删目录或卸载。");
    if (LOCAL_ERRORS.includes(code)) return localMessage(code);
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
    const local = data.local || {}, code = localCode(data.localError || local.code);
    const endpoint = endpointOf(typeof data.endpoint === "string" ? data.endpoint : "");
    const model = typeof data.model === "string" ? data.model : "";
    const contextWindow = validWindow(data.contextWindow) ? data.contextWindow : DEFAULT_CTX;
    const models = Array.isArray(data.models) ? data.models.slice(0, CONFIG_MODEL_LIMIT).filter((m) => m && validModel(m.id))
      .map((m) => ({ id: m.id, contextWindow: validWindow(m.contextWindow) ? m.contextWindow : DEFAULT_CTX })) : [];
    if (validModel(model) && !models.some((m) => m.id === model)) models.unshift({ id: model, contextWindow });
    const supportsMulti = data.capabilities?.multiUpstream === true;
    let upstreams;
    const incomplete = supportsMulti && data.configured === true && data.upstreams === undefined && code === "COMPONENT_DISABLED";
    if (supportsMulti && data.configured === true && !incomplete) {
      const names = new Set(), ids = [];
      if (!Array.isArray(data.upstreams) || !data.upstreams.length || data.upstreams.length > UPSTREAM_LIMIT) throw { code: "component_response" };
      upstreams = data.upstreams.map((source) => {
        const parsed = endpointOf(source?.endpoint), raw = new Set();
        if (!source || !validName(source.name) || names.has(source.name) || parsed.error || parsed.url !== source.endpoint ||
            source.hasKey !== true || !Array.isArray(source.models) || source.models.length > CONFIG_MODEL_LIMIT) throw { code: "component_response" };
        names.add(source.name);
        return { name: source.name, endpoint: parsed.url, hasKey: true, models: source.models.map((pair) => {
          const model = pair?.model === undefined ? pair?.id : pair.model;
          if (!pair || !validModel(pair.id) || !validModel(model) || raw.has(model)) throw { code: "component_response" };
          ids.push(pair.id); raw.add(model); return { id: pair.id, model };
        }) };
      });
      if (ids.length > CONFIG_MODEL_LIMIT || new Set(ids).size !== ids.length || !ids.includes(model) ||
          JSON.stringify(ids) !== JSON.stringify(models.map((item) => item.id)) || upstreams[0].endpoint !== endpoint.url) throw { code: "component_response" };
    }
    return {
      installed: data.installed === true, configured: data.configured === true && !endpoint.error && !!model && model.length <= 200 && !/[,\u0000-\u001f\u007f]/.test(model), hasKey: data.hasKey === true,
      endpoint: endpoint.error ? "" : data.endpoint, model, models,
      ...(supportsMulti && !incomplete ? { capabilities: { multiUpstream: true } } : {}), ...(upstreams ? { upstreams } : {}),
      providerId: typeof data.providerId === "string" ? data.providerId : "",
      contextWindow: models.find((m) => m.id === model)?.contextWindow || contextWindow,
      localError: code, check: checkCode(data.check),
      local: { state: code ? "error" : ["ready", "error", "stopped", "starting"].includes(local.state) ? local.state : "stopped", code },
    };
  }
  async function request(body, endpoint = API) {
    const init = {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      headers: { "X-CC-Lang": window.I18N ? window.I18N.lang : "zh", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    try {
      const r = await fetch(endpoint, init);
      let data;
      try { data = await r.json(); } catch { throw { status: r.status }; }
      if (!r.ok || data.ok === false) throw { status: r.status, field: data.field, code: data.code, check: checkCode(data.check), saved: data.saved === true };
      return data;
    } finally { if (body) init.body = ""; }
  }
  function createPanel() {
    panel = document.createElement("section");
    panel.id = "bridge-config-panel";
    panel.setAttribute("aria-labelledby", "bridge-config-title");
    panel.innerHTML = `
      <button type="button" class="bc-back" data-bc="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>${esc(t("返回扩展"))}</button>
      <header class="bc-heading"><h2 id="bridge-config-title" tabindex="-1">${esc(t("OpenAI API 本地协议桥"))} <span class="badge">${esc(t("预览"))}</span></h2><p>${esc(t("多个 API 分别配置模型，共用一个本地桥；保存后统一生效。"))}</p></header>
      <section id="bc-overview" class="bc-overview" aria-label="${esc(t("桥状态"))}" aria-live="polite"><div><span>${esc(t("组件入口"))}</span><b id="bc-package-state"></b></div><div><span>${esc(t("配置检查"))}</span><b id="bc-config-state"></b></div><div><span>${esc(t("本地服务"))}</span><b id="bc-service-state"></b></div></section>
      <p class="bc-notice hidden" id="bc-notice" role="alert"></p>
      <section id="bc-issue" class="bc-card bc-issue hidden" aria-labelledby="bc-issue-title"><span class="bc-issue-label">${esc(t("需要检查"))}</span><h3 id="bc-issue-title" tabindex="-1"></h3><p id="bc-issue-detail"></p><p class="bc-hint" id="bc-issue-hint"></p><p class="bc-hint mono" id="bc-issue-code" dir="ltr"></p><div class="bc-actions"><button class="btn ghost" id="bc-check-again" type="button" data-bc="check-again">${esc(t("重新检查"))}</button></div><p class="bc-hint">${esc(t("只读取本地状态，不保存、不启动、不重置，也不连接上游。"))}</p><details id="bc-backup-help"><summary>${esc(t("什么时候需要备份？"))}</summary><p class="bc-hint">${esc(t("只有后续明确处理旧安装或迁移时才需要备份桥配置：API 地址、密钥、模型和 App 接口记录；不是聊天记录或整个手机。"))}</p><p class="bc-hint">${esc(t("本页不会创建或上传备份；含密钥的配置文件不要直接发群或公开。"))}</p></details></section>
      <div id="bc-loading" role="status">${esc(t("读取中…"))}</div>
      <form id="bc-form" class="bc-card hidden" novalidate autocomplete="off">
        <h3>${esc(t("连接你的 API"))}</h3>
        <section class="bc-apis" aria-label="${esc(t("API 列表"))}"><div id="bc-api-list" class="bc-selected"></div><div class="bc-actions"><button type="button" class="btn ghost" id="bc-api-add" data-bc="api-add" aria-describedby="bc-api-hint">${esc(t("添加 API"))}</button></div><p class="bc-hint" id="bc-api-hint"></p><p class="bc-error hidden" id="bc-api-error" role="alert"></p></section>
        <h4 id="bc-api-title" class="mono" dir="ltr"></h4>
        <div class="field"><label for="bc-endpoint">${esc(t("API 地址"))}</label><input id="bc-endpoint" type="url" dir="ltr" inputmode="url" enterkeyhint="next" placeholder="https://api.example.com/v1" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="2048" aria-describedby="bc-endpoint-hint bc-endpoint-error bc-endpoint-preview" required><p class="bc-hint" id="bc-endpoint-hint">${esc(t("填写服务商的 API 地址，不是官网登录页。"))}</p><p class="bc-error hidden" id="bc-endpoint-error"></p><p class="bc-hint mono hidden" id="bc-endpoint-preview" dir="ltr"></p></div>
        <div class="field"><label for="bc-key">${esc(t("API Key"))}</label><div class="bc-key-wrap"><input id="bc-key" type="password" dir="ltr" enterkeyhint="next" spellcheck="false" autocapitalize="none" autocorrect="off" autocomplete="off" maxlength="1024" aria-describedby="bc-key-hint bc-key-error"><button type="button" class="bc-eye" data-bc="eye" aria-label="${esc(t("显示密钥"))}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><p class="bc-hint" id="bc-key-hint"></p><p class="bc-error hidden" id="bc-key-error"></p></div>
        <div class="bc-discovery"><label class="bc-model-consent" for="bc-model-consent"><input id="bc-model-consent" type="checkbox" aria-describedby="bc-model-origin bc-model-status"><span>${esc(t("允许自动读取模型清单（会将 API Key 发往所填服务，不发送对话、不调用模型）"))}</span></label><p class="bc-hint mono" id="bc-model-origin" dir="ltr"></p><div class="bc-model-feedback"><p class="bc-hint" id="bc-model-status" role="status" aria-live="polite" aria-atomic="true"></p><button class="btn ghost sm bc-model-retry" type="button" id="bc-model-retry" data-bc="models-retry">${esc(t("重试读取清单"))}</button></div></div>
        <div class="field"><label for="bc-model">${esc(t("模型名称"))}</label><input id="bc-model" type="text" dir="ltr" enterkeyhint="done" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="200" placeholder="${esc(t("输入搜索或手填模型名称"))}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bc-model-list" aria-describedby="bc-model-hint bc-model-error bc-model-status" required><ul class="bc-suggest hidden" id="bc-model-list" role="listbox" aria-label="${esc(t("模型清单"))}"></ul><p class="bc-hint" id="bc-model-hint">${esc(t("搜索或手填后添加模型；已添加的模型可分别设置窗口和默认项。"))}</p><p class="bc-error hidden" id="bc-model-error"></p></div>
        <div class="field"><label for="bc-ctx">${esc(t("上下文窗口（可选）"))}</label><input id="bc-ctx" type="text" dir="ltr" inputmode="numeric" enterkeyhint="done" spellcheck="false" autocapitalize="none" autocorrect="off" maxlength="12" placeholder="1048576 / 256k / 1m" aria-describedby="bc-ctx-hint bc-ctx-error"><p class="bc-hint" id="bc-ctx-hint">${esc(t("优先采用接口返回的窗口，未提供时默认 200,000 token；可手动修改。"))}</p><p class="bc-error hidden" id="bc-ctx-error"></p></div>
        <div class="bc-actions"><button type="button" class="btn ghost" id="bc-model-add" data-bc="model-add">${esc(t("添加模型"))}</button></div>
        <div id="bc-selected" class="bc-selected" aria-label="${esc(t("已添加的模型"))}"></div>
        <p class="bc-hint bc-privacy">${esc(t("对话、工具结果和图片将发往你填写的服务。"))}</p>
        <button class="btn" id="bc-save" type="submit">${esc(t("保存配置"))}</button><p class="bc-hint bc-center" id="bc-save-note" role="status">${esc(t("保存不调用远端模型，也不切换当前会话"))}</p>
      </form>
      <section id="bc-saved" class="bc-card hidden" aria-labelledby="bc-saved-title"><h3 id="bc-saved-title" tabindex="-1">${esc(t("配置已保存"))}</h3><dl class="bc-summary"><div><dt>${esc(t("API 地址"))}</dt><dd class="mono" id="bc-saved-endpoint" dir="ltr"></dd></div><div><dt>${esc(t("API Key"))}</dt><dd>${esc(t("已设置 · 不回显"))}</dd></div><div><dt>${esc(t("模型名称"))}</dt><dd class="mono" id="bc-saved-model" dir="ltr"></dd></div><div><dt>${esc(t("上下文窗口"))}</dt><dd class="mono" id="bc-saved-ctx" dir="ltr"></dd></div></dl><div id="bc-saved-apis" class="bc-selected" aria-label="${esc(t("API 列表"))}"></div><div id="bc-saved-models" class="bc-selected"></div><div class="bc-status" role="status"><b id="bc-local-state"></b><span id="bc-remote-state">${esc(t("模型推理尚未验证"))}</span></div><p class="bc-hint">${esc(t("已添加到「接口与型号」。当前会话保持不变。"))}</p><div class="bc-actions"><button class="btn" type="button" id="bc-use" data-bc="use">${esc(t("新建会话使用"))}</button><button class="btn ghost" type="button" data-bc="edit">${esc(t("修改配置"))}</button></div><p class="bc-hint">${esc(t("别的会话也能用：点输入栏下的模型标签，在接口一行选它。"))}</p></section>
      <section id="bc-repair" class="bc-card bc-repair hidden" aria-labelledby="bc-repair-title"><h3 id="bc-repair-title">${esc(t("诊断与修复"))}</h3><p class="bc-hint" id="bc-repair-intro">${esc(t("先核对本机状态，再提供可确认的方案；检查本身不改配置、不启动或重置桥。"))}</p><div class="bc-actions"><button class="btn ghost" id="bc-repair-inspect" type="button" data-bc="repair-inspect">${esc(t("检查修复方案"))}</button></div><p class="bc-hint" id="bc-repair-status" role="status" aria-live="polite"></p><div id="bc-repair-plan" class="hidden"><p class="bc-hint" id="bc-repair-changes"></p><p class="bc-hint">${esc(t("仅同步已核对桥接口的模型清单、默认模型和认证样式；保留可验证窗口，缺失项使用 200,000。地址与密钥不变。"))}</p><p class="bc-hint">${esc(t("不停止或启动服务，不改上游 Key、运行文件、恢复锁或当前会话。方案仅在本页短期有效，状态改变须重新检查。"))}</p><div class="bc-actions"><button class="btn" id="bc-repair-apply" type="button" data-bc="repair-apply">${esc(t("确认同步 App 记录"))}</button><button class="btn ghost" id="bc-repair-cancel" type="button" data-bc="repair-cancel">${esc(t("取消修复方案"))}</button></div></div><details id="bc-repair-steps"><summary>${esc(t("不能自动修复时怎么做？"))}</summary><ol class="bc-hint"><li>${esc(t("先核对 App 和组件均为配套正式版本；有会话在运行时，等待结束后再检查。"))}</li><li>${esc(t("地址、密钥、归属或运行文件检查不明确时，请让设备上的 AI 按固定诊断编号做本地只读核对，不要盲删或覆盖。"))}</li><li>${esc(t("恢复预算耗尽或补丁校验失败属于另一类故障；先查诊断，不用同步 App 记录解除恢复锁。"))}</li><li>${esc(t("反馈时提供版本、诊断编号和是否更新或重装；不要上传密钥、完整配置或对话。"))}</li></ol></details></section>
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
      else if (action === "check-again") {
        if (!$("bc-form").classList.contains("hidden") && !confirm(t("重新检查将清除本页尚未保存的输入，但不会修改已保存的配置。继续？"))) return;
        checkStatus();
      }
      else if (action === "repair-inspect") inspectRepair();
      else if (action === "repair-apply") applyRepair();
      else if (action === "repair-cancel") clearRepair();
      else if (action === "models-retry") scheduleModels(0);
      else if (action === "api-add") addApi();
      else if (action === "api-select") switchApi(b.dataset.api);
      else if (action === "api-remove") removeApi(b.dataset.api);
      else if (action === "model-add") addModel(true);
      else if (action === "model-edit") { if (stashEditor()) { const item = selectedModels.find((m) => m.id === b.dataset.model); if (item) editModel(item); } }
      else if (action === "model-default") { defaultModel = b.dataset.model; defaultSource = activeApi; renderSelected(); renderApis(); }
      else if (action === "model-remove") {
        selectedModels = selectedModels.filter((m) => m.id !== b.dataset.model);
        if (multi()) activeDraft().models = selectedModels;
        if (defaultModel === b.dataset.model && (!multi() || defaultSource === activeApi)) chooseRemainingDefault();
        if (editingModel === b.dataset.model) { editingModel = ""; $("bc-model").value = ""; ctxManual = false; syncContext(); }
        renderSelected(); renderApis();
      }
    });
    for (const name of ["endpoint", "key", "model"]) $("bc-" + name).addEventListener("input", () => {
      $("bc-" + name).removeAttribute("aria-invalid"); $("bc-" + name + "-error").classList.add("hidden");
      // 模型清单在本地过滤；改模型名不看密钥、不重新读取
      if (name === "model") {
        if (editingModel && $("bc-model").value.trim() !== editingModel) { stashEditor(); editingModel = ""; }
        syncContext(true); suggestAt = -1; renderSuggest(true); return;
      }
      cancelModels(true);
      if (name === "endpoint") {
        const endpoint = endpointOf($("bc-endpoint").value);
        // In multi-API mode even a same-origin path edit changes the source being consented to.
        if (multi() || (currentOrigin && currentOrigin !== (endpoint.origin || ""))) {
          $("bc-model-consent").checked = false; consentOrigin = "";
          if (currentOrigin && currentOrigin !== (endpoint.origin || "")) { hideKey(true); draftKeys.delete(activeApi); }
        }
        currentOrigin = endpoint.origin || "";
        if (multi()) { connectedApis.delete(activeApi); activeDraft().endpoint = $("bc-endpoint").value; renderApis(); }
        previewEndpoint();
      }
      if (multi() && name === "key") connectedApis.delete(activeApi);
      scheduleModels();
    });
    // 流内列表失焦收起会移动下方按钮，导致这次 click 落空；操作按钮时保持焦点，先完成点击。
    panel.addEventListener("mousedown", (e) => {
      const button = e.target.closest("button");
      if (button && document.activeElement === $("bc-model") &&
          (button.id === "bc-model-add" || !$("bc-model-list").classList.contains("hidden"))) e.preventDefault();
    });
    $("bc-ctx").addEventListener("input", () => {
      ctxManual = true;
      $("bc-ctx").removeAttribute("aria-invalid"); $("bc-ctx-error").classList.add("hidden");
    });
    // 原生 datalist 的弹层在安卓 WebView 上不贴输入框、半透明叠在页面上，改成排在输入框下面的列表
    const model = $("bc-model"), list = $("bc-model-list");
    model.addEventListener("focus", () => { suggestAt = -1; renderSuggest(true); });
    // 添加按钮保留输入框焦点，列表收起后再点输入框不会重发 focus，也要能展开。
    model.addEventListener("click", () => { suggestAt = -1; renderSuggest(true); });
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
  function chooseRemainingDefault() {
    if (!multi()) { defaultModel = selectedModels[0]?.id || ""; return; }
    const source = apiDrafts.find((item) => item.models.length);
    defaultSource = source?.name || ""; defaultModel = source?.models[0]?.id || "";
  }
  function renderApis(saved = false) {
    if (!panel) return;
    const list = $(saved ? "bc-saved-apis" : "bc-api-list"); list.textContent = "";
    if (!multi()) {
      if (!saved) {
        $("bc-api-title").textContent = "";
        $("bc-api-hint").textContent = t("添加多个 API 需要更新桥组件；现有单 API 配置仍可使用。");
        $("bc-api-add").disabled = busy;
      }
      return;
    }
    const sources = saved ? (snapshot.upstreams || []) : apiDrafts;
    for (const source of sources) {
      const row = document.createElement("div"); row.className = "bc-model-row bc-api-row";
      if (!saved && source.name === activeApi) row.classList.add("bc-api-active");
      const label = document.createElement("span"); label.className = "mono"; label.dir = "ltr";
      label.textContent = source.name + " · " + (source.endpoint || "—") + " · " +
        t("{n} 个模型", { n: source.models.length }) + (!saved && source.name === defaultSource ? " · " + t("默认模型") : "");
      row.appendChild(label);
      if (!saved) for (const [action, text] of [["api-select", t("编辑")], ["api-remove", t("移除")]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn ghost sm";
        button.dataset.bc = action; button.dataset.api = source.name; button.textContent = text;
        button.setAttribute("aria-label", text + " " + source.name);
        if (action === "api-select") button.setAttribute("aria-pressed", String(source.name === activeApi));
        button.disabled = busy || (action === "api-remove" && sources.length === 1);
        row.appendChild(button);
      }
      list.appendChild(row);
    }
    if (!saved) {
      $("bc-api-title").textContent = activeApi;
      $("bc-api-hint").textContent = t("每次只编辑一个 API；添加、移除和默认模型变更均在点击保存配置后生效。");
      $("bc-api-add").disabled = busy || apiDrafts.length >= UPSTREAM_LIMIT;
    }
  }
  function stashApi() {
    if (!multi()) return true;
    // Switching sources commits the current model editor to its draft, never to saved topology.
    if ($("bc-model").value.trim()) { if (!addModel(false)) return false; }
    else if (!stashEditor()) return false;
    const source = activeDraft();
    source.endpoint = $("bc-endpoint").value; source.models = selectedModels;
    source.typedModel = $("bc-model").value; source.typedContext = $("bc-ctx").value; source.ctxManual = ctxManual;
    if ($("bc-key").value) draftKeys.set(source.name, $("bc-key").value); else draftKeys.delete(source.name);
    return true;
  }
  function loadApi(name) {
    cancelModels(); modelItems = []; modelWindows = new Map(); modelsConnected = false;
    consentOrigin = ""; $("bc-model-consent").checked = false; hideKey(true);
    activeApi = name;
    const source = activeDraft(); selectedModels = source.models;
    ctxManual = source.ctxManual === true;
    $("bc-endpoint").value = source.endpoint;
    $("bc-model").value = source.typedModel ?? (source.models[0]?.id || "");
    editingModel = source.models.some((item) => item.id === $("bc-model").value) ? $("bc-model").value : "";
    if (source.typedContext !== undefined) $("bc-ctx").value = source.typedContext;
    else syncContext(true);
    $("bc-key").value = draftKeys.get(name) || "";
    $("bc-key").placeholder = savedSource()?.hasKey ? t("已保存，留空保持不变") : t("粘贴服务商提供的密钥");
    currentOrigin = endpointOf(source.endpoint).origin || "";
    for (const field of ["endpoint", "key", "model", "ctx"]) {
      $("bc-" + field).removeAttribute("aria-invalid"); $("bc-" + field + "-error").classList.add("hidden");
    }
    renderModels(); renderSelected(); renderApis(); previewEndpoint();
    $("bc-model-status").textContent = t("勾选后自动读取清单，也可直接手填模型。");
    updateSaveNote(); updateModelsControls();
  }
  function switchApi(name) {
    if (!multi() || name === activeApi || !apiDrafts.some((item) => item.name === name) || !stashApi()) return;
    loadApi(name);
  }
  function addApi() {
    if (!multi()) { notice(t("添加多个 API 需要更新桥组件；现有单 API 配置仍可使用。")); return; }
    if (apiDrafts.length >= UPSTREAM_LIMIT || !stashApi()) return;
    let n = 1, name = "relay";
    while (usedNames.has(name)) name = "relay-" + (++n);
    usedNames.add(name); apiDrafts.push({ name, endpoint: "", models: [] });
    loadApi(name); $("bc-endpoint").focus();
  }
  function removeApi(name) {
    if (!multi() || apiDrafts.length <= 1 || !apiDrafts.some((item) => item.name === name)) return;
    if (!confirm(t("移除 API「{name}」及其模型？仅在点击保存配置后生效，当前会话保持不变。", { name }))) return;
    if (name !== activeApi && !stashApi()) return;
    cancelModels(); draftKeys.delete(name); connectedApis.delete(name);
    apiDrafts = apiDrafts.filter((item) => item.name !== name);
    if (defaultSource === name) chooseRemainingDefault();
    // Removing the primary promotes the first remaining API without renaming it or any saved model ID.
    loadApi(name === activeApi ? apiDrafts[0].name : activeApi);
  }
  function aggregateApis() {
    const counts = new Map(), reserved = new Set();
    for (const source of apiDrafts) for (const item of source.models) {
      counts.set(item.id, (counts.get(item.id) || 0) + 1);
      if (item.visibleId) {
        if (!validModel(item.visibleId) || reserved.has(item.visibleId)) return null;
        reserved.add(item.visibleId);
      }
    }
    const models = [], upstreams = []; let model = "";
    for (const source of apiDrafts) {
      const pairs = [];
      for (const item of source.models) {
        let id = item.visibleId;
        if (!id) {
          id = counts.get(item.id) > 1 || reserved.has(item.id) ? source.name + "/" + item.id : item.id;
          if (!validModel(id) || reserved.has(id)) return null;
          reserved.add(id);
        }
        pairs.push({ id, model: item.id }); models.push({ id, contextWindow: item.contextWindow });
        if (source.name === defaultSource && item.id === defaultModel) model = id;
      }
      upstreams.push({ name: source.name, endpoint: endpointOf(source.endpoint).url, models: pairs });
    }
    return model && models.length <= CONFIG_MODEL_LIMIT ? { endpoint: upstreams[0].endpoint, apiKey: "", model, models, upstreams, consent: true } : null;
  }
  function hideKey(clear = false) {
    if (!panel) return;
    $("bc-key").type = "password";
    if (clear) $("bc-key").value = "";
    const eye = panel.querySelector('[data-bc="eye"]');
    eye.setAttribute("aria-label", t("显示密钥")); eye.setAttribute("aria-pressed", "false");
  }
  function notice(text) { $("bc-notice").textContent = text; $("bc-notice").classList.toggle("hidden", !text); }
  function clearRepair() {
    repairPlan = null; repairUntil = 0;
    if (repairTimer !== null) clearTimeout(repairTimer);
    repairTimer = null;
    if (!panel) return;
    $("bc-repair-plan").classList.add("hidden"); $("bc-repair-changes").textContent = "";
    $("bc-repair-status").textContent = "";
  }
  function repairMessage(code) {
    if (code === "BUSY") return t("本地桥正在使用或组件操作中，未执行修复；请等待结束后重新检查。");
    if (code === "REPAIR_STALE") return t("修复方案已失效或相关状态已改变，未执行本次修复；请重新检查方案。");
    if (code === "REPAIR_NOT_NEEDED") return t("未发现可同步的 App 记录差异；若仍不可用，请按检查说明处理。");
    return t("当前状态不适合自动同步，未执行修复。请展开下方步骤；不要通过删除或重置绕过检查。");
  }
  async function inspectRepair() {
    if (busy) return;
    clearRepair(); cancelModels(); hideKey();
    const id = ++seq; setBusy(true);
    $("bc-repair-status").textContent = t("正在核对修复范围，不修改配置…");
    try {
      const data = await request({ action: "inspect", consent: true }, REPAIR_API);
      if (id !== seq || !visible()) return;
      const plan = data.repair;
      if (!plan || plan.available !== true || plan.action !== "SYNC_APP_METADATA" || typeof plan.ticket !== "string" ||
          !/^[0-9a-f]{48}$/.test(plan.ticket) || !Array.isArray(plan.changes) || !plan.changes.length ||
          plan.changes.some(c => !["MODELS", "AUTH_STYLE"].includes(c)) || !Array.isArray(plan.models) || !plan.models.length ||
          plan.models.length > CONFIG_MODEL_LIMIT || plan.models.some(m => !m || !validModel(m.id) || !validWindow(m.contextWindow))) throw { code: "REPAIR_UNAVAILABLE" };
      repairPlan = { ticket: plan.ticket, changes: [...plan.changes], count: plan.models.length };
      repairUntil = Date.now() + 60000;
      repairTimer = setTimeout(() => { clearRepair(); if (visible()) $("bc-repair-status").textContent = repairMessage("REPAIR_STALE"); }, 60000);
      $("bc-repair-plan").classList.remove("hidden");
      $("bc-repair-changes").textContent = t("可同步 {n} 个模型；认证样式与模型记录将按桥的当前配置核对。", { n: repairPlan.count });
      $("bc-repair-status").textContent = t("方案已就绪，尚未修改任何配置。请阅读范围后再确认。");
    } catch (error) {
      if (id !== seq || !visible()) return;
      clearRepair(); $("bc-repair-status").textContent = repairMessage(error.code);
      $("bc-repair-steps").open = true;
    } finally { if (id === seq) setBusy(false); }
  }
  async function applyRepair() {
    if (busy || !repairPlan) return;
    if (Date.now() >= repairUntil) { clearRepair(); $("bc-repair-status").textContent = repairMessage("REPAIR_STALE"); return; }
    if (!confirm(t("确认同步已核对桥接口的 App 记录？\n\n仅修复模型清单、默认模型和认证样式；本地地址与密钥不变。不启动、不停止服务，不清恢复锁，也不切换当前会话。"))) return;
    const body = { action: "apply", consent: true, ticket: repairPlan.ticket };
    clearRepair(); invalidateReadiness();
    const id = ++seq; setBusy(true);
    $("bc-repair-status").textContent = t("正在同步 App 记录…");
    let refresh = false, partial = false;
    try {
      const data = await request(body, REPAIR_API);
      if (id !== seq || !visible()) return;
      if (data.repaired !== true || data.scope !== "APP_METADATA") throw { code: "REPAIR_UNAVAILABLE" };
      refresh = true;
    } catch (error) {
      if (id !== seq || !visible()) return;
      partial = error.code === "REPAIR_PARTIAL"; refresh = partial;
      $("bc-repair-status").textContent = ["BUSY", "REPAIR_STALE", "REPAIR_NOT_NEEDED", "invalid_input"].includes(error.code) ? repairMessage(error.code)
        : t("无法确认本次修复是否已写入，请重新检查本地状态；不会自动重试，请勿反复覆盖。");
      $("bc-repair-steps").open = true;
    } finally { body.ticket = ""; if (id === seq) setBusy(false); }
    if (refresh && id === seq && visible()) {
      if (typeof options.saved === "function") options.saved();
      const page = seq + 1;
      await checkStatus();
      if (!visible() || seq !== page) return;
      if (partial) {
        $("bc-repair").classList.remove("hidden"); $("bc-repair-steps").open = true;
        $("bc-repair-status").textContent = t("App 接口已写入，但映射收尾未完成；已尝试只读重查，请核对当前状态。不要反复执行修复，当前会话未切换。");
      } else if (snapshot?.installed && snapshot.configured) {
        const message = t("App 记录已同步；已重新读取本地状态，当前会话未切换。");
        if (snapshot.local.state === "ready") notice(message);
        else $("bc-repair-status").textContent = message;
      }
    }
  }
  function overview(pack, config, service, ready = false) {
    $("bc-package-state").textContent = pack; $("bc-config-state").textContent = config; $("bc-service-state").textContent = service;
    $("bc-service-state").className = ready ? "bc-ready" : "";
  }
  function overviewSnapshot() {
    const ready = snapshot.local.state === "ready";
    overview(t("可用"), snapshot.check !== "UNKNOWN" ? t("未通过") : snapshot.configured ? snapshot.providerId ? t("已核对") : t("待同步接口") : t("尚未配置"),
      ready ? t("已就绪") : snapshot.configured ? t("不可用于新会话") : t("尚未检查"), ready);
  }
  function invalidateReadiness(code = "") {
    const fault = LOCAL_ERRORS.includes(code) ? code : snapshot?.localError || "";
    if (snapshot) snapshot = { ...snapshot, localError: fault, local: { state: "error", code: fault } };
    overview(snapshot?.installed ? t("可用") : t("未确认"), t("未确认"), fault ? t("不可用于新会话") : t("未确认"));
    $("bc-use").disabled = true;
  }
  function issueDetail(check) {
    if (check === "APP_PROVIDER") return t("App 接口的地址、认证设置或本地连接记录与桥的映射不一致；尚不能确定是哪一项被更改。");
    if (check === "MODEL_LIST") return t("App 保存的模型清单未通过格式或一致性检查；这不表示存在另一套桥。");
    if (check === "APP_MAPPING") return t("App 的桥接口映射记录未通过格式或读取检查；这不表示运行目录需要删除。");
    if (check === "CONNECTION") return t("服务注册与本地连接记录未通过一致性检查；当前不能确认可用接口。");
    if (check === "OWNERSHIP") return t("未能确认默认运行目录属于图形界面管理的桥；可能是旧记录、目录或归属标记需要核对。");
    if (check === "COMPONENT") return t("组件拒绝了运行副本的安全检查，但未返回具体失败项；不能据此认定有第二套桥。");
    return t("当前版本只返回统一冲突码，无法确定失败项；可能涉及运行文件、安装归属或 App 接口记录。");
  }
  function showIssue(error, fromSave = false) {
    const conflict = error.code === "RUNTIME_CONFLICT", check = conflict ? checkCode(error.check) : "UNKNOWN";
    const absent = !conflict && (error.status === 404 || error.code === "not_installed");
    const title = conflict ? t("配置检查未通过") : absent ? t("组件入口暂不可用") : error.code === "BUSY" ? t("本地桥正在忙碌") : t("暂时无法读取桥状态");
    const detail = conflict ? issueDetail(check) : readError(error.status, error.code);
    $("bc-issue").classList.remove("hidden"); $("bc-backup-help").classList.toggle("hidden", !conflict);
    clearRepair(); $("bc-repair").classList.remove("hidden");
    $("bc-backup-help").open = false;
    $("bc-issue-title").textContent = title; $("bc-issue-detail").textContent = detail;
    $("bc-issue-hint").textContent = fromSave ? error.saved
      ? t("桥配置已写入，但后续步骤未完成；当前会话保持不变，请先核对，不要反复覆盖。")
      : t("本次保存未报告成功；当前会话保持不变，请先核对检查说明。")
      : t("本次只读检查未修改配置；先核对 App 和组件版本，不要盲删、卸载或重置恢复次数。");
    // 诊断只接受本页白名单；不渲染服务端 message、私有路径、指纹或未知错误文本。
    $("bc-issue-code").textContent = conflict ? "RUNTIME_CONFLICT · " + check : "";
    const installed = !absent && (fromSave && snapshot?.installed || check !== "UNKNOWN");
    overview(installed ? t("可用") : absent ? t("暂不可用") : t("未确认"), conflict ? t("未通过") : t("尚未检查"), t("未确认"));
    notice(""); $("bc-issue-title").focus({ preventScroll: true });
  }
  function errorsClear() {
    notice(""); $("bc-issue").classList.add("hidden");
    clearRepair(); $("bc-repair").classList.add("hidden");
    $("bc-api-error").textContent = ""; $("bc-api-error").classList.add("hidden");
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
    const saved = savedSource(), old = saved && endpointOf(saved.endpoint);
    const changed = saved?.hasKey && old?.origin && result.origin && old.origin !== result.origin;
    $("bc-key-hint").textContent = changed ? t("服务地址已改变，请重新填写 API Key，旧密钥不会发往新地址。") : saved?.hasKey ? t("不回显已保存的密钥；留空保持不变，填写新密钥可替换。") : t("密钥保存后不回显。");
    $("bc-key").required = !(saved?.hasKey && old?.origin === result.origin);
  }
  function discoveryKeyReady(endpoint) {
    if ($("bc-key").value.trim()) return $("bc-key").value.trim().length <= 1024 && !/[\s\u0000-\u001f\u007f-\u009f]/.test($("bc-key").value.trim());
    // The server is the final authority; the client never receives the saved secret.
    const saved = savedSource();
    return !!saved?.hasKey && endpointOf(saved.endpoint).origin === endpoint.origin;
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
    $("bc-save-note").textContent = saving ? t("正在保存并检查本地桥，不调用远端模型…") : hasDiscovered() ? t("读取清单已连接服务，尚未验证模型推理；保存不调用远端模型，也不切换当前会话。") : t("保存不调用远端模型，也不切换当前会话");
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
  function syncContext(selecting = false) {
    if (ctxManual && !selecting) return;
    const id = $("bc-model").value.trim(), selected = selectedModels.find((m) => m.id === id);
    // A new selection must load its own value, even when that model was manually configured.
    if (selecting) ctxManual = selected?.manual === true;
    $("bc-ctx").value = String(selected?.contextWindow || modelWindows.get(id) || DEFAULT_CTX);
  }
  function stashEditor() {
    if (!editingModel) return true;
    const item = selectedModels.find((m) => m.id === editingModel), ctx = ctxOf($("bc-ctx").value);
    if (ctx === null) { error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。")).focus(); return false; }
    if (item) { item.contextWindow = ctx || modelWindows.get(item.id) || DEFAULT_CTX; item.manual = ctxManual; }
    return true;
  }
  function editModel(item) {
    editingModel = item.id; $("bc-model").value = item.id; ctxManual = item.manual === true;
    $("bc-ctx").value = String(item.contextWindow); renderSelected(); renderSuggest(false);
  }
  function addModel(clear) {
    const id = $("bc-model").value.trim(), ctx = ctxOf($("bc-ctx").value);
    if (!validModel(id)) { error("model", t("请输入准确的模型名称，不要包含逗号或换行。")).focus(); return false; }
    if (ctx === null) { error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。")).focus(); return false; }
    let item = selectedModels.find((m) => m.id === id);
    const total = multi() ? apiDrafts.reduce((n, source) => n + source.models.length, 0) : selectedModels.length;
    if (!item && total >= CONFIG_MODEL_LIMIT) { error("model", t("最多可添加 100 个模型。")).focus(); return false; }
    if (!item) { item = { id }; selectedModels.push(item); }
    item.contextWindow = ctx || modelWindows.get(id) || DEFAULT_CTX; item.manual = ctxManual;
    if (!defaultModel) { defaultModel = id; defaultSource = activeApi; }
    if (clear) { editingModel = ""; $("bc-model").value = ""; ctxManual = false; syncContext(); }
    suggestAt = -1;
    renderSuggest(clear); renderSelected(); renderApis(); return true;
  }
  function renderSelected(saved = false) {
    const list = $(saved ? "bc-saved-models" : "bc-selected"); list.textContent = "";
    const items = saved ? snapshot.models : selectedModels, def = saved ? snapshot.model : (!multi() || defaultSource === activeApi ? defaultModel : "");
    for (const item of items) {
      const row = document.createElement("div"); row.className = "bc-model-row";
      const label = document.createElement("span"); label.className = "mono"; label.dir = "ltr";
      label.textContent = item.id + (!saved && item.visibleId && item.visibleId !== item.id ? " → " + item.visibleId : "") + " · " + item.contextWindow.toLocaleString() + (item.id === def ? " · " + t("默认模型") : "");
      row.appendChild(label);
      if (!saved) for (const [action, text] of [["model-edit", t("编辑")], ["model-default", t("设为默认")], ["model-remove", t("移除")]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn ghost sm";
        button.dataset.bc = action; button.dataset.model = item.id; button.textContent = text;
        button.disabled = busy || action === "model-default" && item.id === def;
        button.setAttribute("aria-label", text + " " + item.id); row.appendChild(button);
      }
      list.appendChild(row);
    }
  }
  function pickSuggest(id) {
    if (!stashEditor()) return;
    const input = $("bc-model");
    editingModel = selectedModels.some((m) => m.id === id) ? id : "";
    input.value = id; input.removeAttribute("aria-invalid"); $("bc-model-error").classList.add("hidden");
    syncContext(true);
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
    if (clear) {
      modelItems = []; modelWindows = new Map(); modelsConnected = false;
      if (!multi()) for (const item of selectedModels) if (!item.manual) item.contextWindow = DEFAULT_CTX;
      renderModels(); renderSelected(); syncContext();
    }
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
    const body = { endpoint: $("bc-endpoint").value.trim(), consent: true, ...(multi() ? { provider: activeApi } : {}) };
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
      if (multi()) connectedApis.add(activeApi);
      const ids = new Set(); modelWindows = new Map();
      for (const item of data.models.slice(0, MODEL_LIMIT)) {
        if (item && validModel(item.id)) {
          ids.add(item.id);
          if (validWindow(item.context_window)) modelWindows.set(item.id, item.context_window);
        }
      }
      for (const item of selectedModels) if (!item.manual && modelWindows.has(item.id)) item.contextWindow = modelWindows.get(item.id);
      modelItems = [...ids]; syncContext(); renderSelected(); renderModels();
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
    if (!value) {
      $("bc-use").disabled = $("bc-saved").classList.contains("hidden") || !snapshot || snapshot.local.state !== "ready" || !snapshot.providerId || typeof options.useNew !== "function";
      renderApis();
    }
  }
  function showForm() {
    cancelModels(true); consentOrigin = ""; $("bc-model-consent").checked = false;
    errorsClear(); hideKey(true); clearDraftKeys(); connectedApis.clear(); overviewSnapshot();
    $("bc-form").classList.remove("hidden"); $("bc-saved").classList.add("hidden"); $("bc-loading").classList.add("hidden");
    if (multi()) {
      apiDrafts = snapshot.upstreams?.map((source) => ({ name: source.name, endpoint: source.endpoint,
        models: source.models.map((pair) => ({ id: pair.model, visibleId: pair.id, manual: true,
          contextWindow: snapshot.models.find((item) => item.id === pair.id)?.contextWindow || DEFAULT_CTX })) })) ||
        [{ name: "relay", endpoint: "", models: [] }];
      usedNames = new Set(apiDrafts.map((source) => source.name));
      const source = snapshot.upstreams?.find((source) => source.models.some((pair) => pair.id === snapshot.model));
      defaultSource = source?.name || ""; defaultModel = source?.models.find((pair) => pair.id === snapshot.model)?.model || "";
      loadApi(apiDrafts[0].name); return;
    }
    apiDrafts = []; activeApi = defaultSource = ""; usedNames.clear(); renderApis();
    // Persisted windows are explicit configuration, not disposable discovery metadata.
    selectedModels = snapshot ? snapshot.models.map((m) => ({ ...m, manual: true })) : [];
    defaultModel = snapshot?.model || ""; editingModel = defaultModel;
    $("bc-endpoint").value = snapshot ? snapshot.endpoint : ""; $("bc-model").value = defaultModel;
    syncContext(true); renderSelected();
    $("bc-key").placeholder = snapshot && snapshot.hasKey ? t("已保存，留空保持不变") : t("粘贴服务商提供的密钥");
    currentOrigin = endpointOf($("bc-endpoint").value).origin || "";
    previewEndpoint(); $("bc-model-status").textContent = t("勾选后自动读取清单，也可直接手填模型。");
    updateSaveNote(); updateModelsControls();
  }
  function showSaved() {
    cancelModels(); modelItems = []; renderModels(); consentOrigin = ""; $("bc-model-consent").checked = false;
    errorsClear(); hideKey(true); clearDraftKeys(); renderApis(true); overviewSnapshot();
    $("bc-form").classList.add("hidden"); $("bc-loading").classList.add("hidden"); $("bc-saved").classList.remove("hidden");
    $("bc-saved-endpoint").textContent = snapshot.endpoint; $("bc-saved-model").textContent = snapshot.model;
    $("bc-saved-ctx").textContent = snapshot.contextWindow.toLocaleString(); renderSelected(true);
    $("bc-remote-state").textContent = hasDiscovered() ? t("读取清单已连接服务，尚未验证模型推理。") : t("模型推理尚未验证");
    const ready = snapshot.local.state === "ready";
    $("bc-local-state").textContent = ready ? t("本地已准备好") : snapshot.localError === "RECOVERY_EXHAUSTED" ? t("自动恢复次数已耗尽")
      : snapshot.localError === "PATCH_VERIFICATION_FAILED" ? t("桥补丁校验失败")
      : snapshot.localError === "COMPONENT_DISABLED" ? t("本地桥已停用") : t("配置已保存，但本地桥尚未就绪");
    $("bc-local-state").className = ready ? "bc-ready" : "bc-pending";
    $("bc-use").disabled = !ready || !snapshot.providerId || typeof options.useNew !== "function";
    if (!ready) {
      notice(snapshot.check !== "UNKNOWN" && ["", "LOCAL_START_FAILED"].includes(snapshot.localError)
        ? issueDetail(snapshot.check) : localMessage(snapshot.localError));
      $("bc-repair").classList.remove("hidden");
    }
    updateModelsControls();
  }
  async function checkStatus() {
    if (busy) return;
    cancelModels(true); currentOrigin = consentOrigin = ""; $("bc-model-consent").checked = false;
    snapshot = null; selectedModels = []; defaultModel = editingModel = ""; ctxManual = false;
    clearDraftKeys(); connectedApis.clear(); apiDrafts = []; activeApi = defaultSource = ""; usedNames.clear();
    $("bc-api-list").textContent = $("bc-saved-apis").textContent = "";
    errorsClear(); hideKey(true); $("bc-form").reset();
    $("bc-saved-endpoint").textContent = $("bc-saved-model").textContent = $("bc-saved-ctx").textContent = "";
    $("bc-selected").textContent = $("bc-saved-models").textContent = "";
    $("bc-form").classList.add("hidden"); $("bc-saved").classList.add("hidden"); $("bc-loading").classList.remove("hidden");
    overview(t("检查中…"), t("检查中…"), t("尚未检查"));
    setBusy(true); const id = ++seq;
    try {
      const data = await request(); if (id !== seq || !visible()) return;
      snapshot = safeSnapshot(data);
      if (!snapshot.installed) { $("bc-loading").classList.add("hidden"); showIssue({ code: "not_installed" }); }
      else if (snapshot.configured && snapshot.hasKey) showSaved();
      else showForm();
    } catch (e) {
      if (id !== seq || !visible()) return;
      $("bc-loading").classList.add("hidden"); showIssue(e);
    } finally { if (id === seq) setBusy(false); }
  }
  async function open(opts = {}) {
    if (busy) return;
    if (!panel) createPanel();
    options = opts;
    const body = $("page-body"); returnTop = body.scrollTop;
    $("tab-ext").classList.add("bridge-config-open"); body.scrollTop = 0;
    $("bridge-config-title").focus({ preventScroll: true });
    await checkStatus();
  }
  function close(force = false) {
    if (!panel || !$("tab-ext").classList.contains("bridge-config-open") || busy && !force) return false;
    ++seq; clearRepair(); cancelModels(true); currentOrigin = consentOrigin = ""; $("bc-model-consent").checked = false;
    busy = false; hideKey(true); snapshot = null; selectedModels = []; defaultModel = editingModel = ""; ctxManual = false;
    clearDraftKeys(); connectedApis.clear(); apiDrafts = []; activeApi = defaultSource = ""; usedNames.clear();
    $("bc-api-list").textContent = $("bc-saved-apis").textContent = "";
    $("bc-selected").textContent = $("bc-saved-models").textContent = "";
    $("tab-ext").classList.remove("bridge-config-open");
    $("bc-form").reset(); $("bc-saved-endpoint").textContent = $("bc-saved-model").textContent = $("bc-saved-ctx").textContent = "";
    $("page-body").scrollTop = returnTop;
    const anchor = options.anchor;
    options = {}; setBusy(false);
    if (!force && anchor && anchor.isConnected && anchor.getClientRects().length) anchor.focus({ preventScroll: true });
    return true;
  }
  async function saveApis() {
    if (!stashApi()) return;
    for (const source of apiDrafts) {
      const endpoint = endpointOf(source.endpoint), previous = snapshot.upstreams?.find((item) => item.name === source.name);
      const key = (draftKeys.get(source.name) || "").trim();
      const changed = previous?.hasKey && endpointOf(previous.endpoint).origin !== endpoint.origin;
      let field = "", message = "";
      if (endpoint.error) { field = "endpoint"; message = endpoint.error; }
      else if (!key && (!previous?.hasKey || changed)) { field = "key"; message = changed ? t("服务地址已改变，请重新填写 API Key，旧密钥不会发往新地址。") : t("请填写服务商提供的 API Key。"); }
      else if (key.length > 1024 || /[\s\u0000-\u001f\u007f-\u009f]/.test(key)) { field = "key"; message = t("API Key 不能包含空格或换行。"); }
      else if (!source.models.length) { field = "model"; message = t("请输入准确的模型名称，不要包含逗号或换行。"); }
      if (field) {
        loadApi(source.name); error(field, message).focus(); return;
      }
    }
    if (!apiDrafts.some((source) => source.name === defaultSource && source.models.some((item) => item.id === defaultModel))) chooseRemainingDefault();
    const body = aggregateApis();
    if (!body) {
      $("bc-api-error").textContent = t("模型可见 ID 冲突、超过 200 字符或总数超过 100；请调整模型后保存。");
      $("bc-api-error").classList.remove("hidden"); return;
    }
    const origins = [...new Set(apiDrafts.map((source) => endpointOf(source.endpoint).origin))].join("\n");
    if (!confirm(t("保存全部 API 配置？\n\n后续使用时，对话、工具结果和图片将按模型发往以下服务：\n{origins}\n保存本身不调用远端模型，也不切换当前会话。", { origins }))) return;
    // Aggregate once, only at global Save. Credentials are copied into the outgoing stdin contract, not topology.
    for (const source of body.upstreams) source.apiKey = (draftKeys.get(source.name) || "").trim();
    await postConfig(body);
  }
  async function save(e) {
    e.preventDefault(); if (busy || !snapshot) return;
    if (cancelModels()) $("bc-model-status").textContent = t("读取已取消，可重试或手填模型。");
    updateModelsControls(); errorsClear(); hideKey();
    if (multi()) { await saveApis(); return; }
    const endpoint = endpointOf($("bc-endpoint").value), model = $("bc-model").value.trim();
    let first = null;
    if (endpoint.error) first = error("endpoint", endpoint.error);
    const old = endpointOf(snapshot.endpoint), changed = snapshot.hasKey && old.origin !== endpoint.origin;
    if (!$("bc-key").value.trim() && (!snapshot.hasKey || changed)) { const el = error("key", changed ? t("服务地址已改变，请重新填写 API Key，旧密钥不会发往新地址。") : t("请填写服务商提供的 API Key。")); first ||= el; }
    if ($("bc-key").value.trim().length > 1024 || /[\u0000- \u007f]/.test($("bc-key").value.trim())) { const el = error("key", t("API Key 不能包含空格或换行。")); first ||= el; }
    if ((!model && !selectedModels.length) || (model && !validModel(model))) { const el = error("model", t("请输入准确的模型名称，不要包含逗号或换行。")); first ||= el; }
    const ctx = ctxOf($("bc-ctx").value);
    if (ctx === null) { const el = error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。")); first ||= el; }
    if (first) { first.focus(); return; }
    if (model && !addModel(false)) return;
    if (!defaultModel || !selectedModels.some((item) => item.id === defaultModel)) defaultModel = selectedModels[0].id;
    if (!confirm(t("保存此 API 配置？\n\n后续使用时，对话、工具结果和图片将发往 {origin}。\n{verification}\n保存本身不调用远端模型，也不切换当前会话。", { origin: endpoint.origin, verification: modelsConnected ? t("读取清单已连接服务，尚未验证模型推理。") : t("模型推理尚未验证") }))) return;
    // The legacy form keeps its replacement secret only in this input and the same-origin POST, never storage.
    const body = { endpoint: $("bc-endpoint").value.trim(), model: defaultModel, consent: true,
      models: selectedModels.map(({ id, contextWindow }) => ({ id, contextWindow })) };
    if ($("bc-key").value.trim()) body.apiKey = $("bc-key").value.trim();
    await postConfig(body);
  }
  async function postConfig(body) {
    const id = ++seq; invalidateReadiness(); setBusy(true, true);
    try {
      const data = await request(body); if (id !== seq || !visible()) return;
      snapshot = safeSnapshot(data);
      if (typeof options.saved === "function") options.saved();   // 窗口 / 模型可能变了：设置页滑块、顶栏刻度跟着重取（#76）
      if (!snapshot.configured || !snapshot.hasKey) { invalidateReadiness(); notice(t("配置未完成，请检查字段后重试。")); return; }
      showSaved(); $("bc-saved-title").focus({ preventScroll: true });
      if (snapshot.local.state !== "ready") notice(localMessage(snapshot.localError));
    } catch (err) {
      if (id !== seq || !visible()) return;
      invalidateReadiness(err.code);
      if (err.field === "endpoint") error("endpoint", t("API 地址未通过检查，请确认服务商提供的地址。"));
      else if (err.field === "apiKey") error("key", t("请重新填写 API Key；更换服务地址时不能沿用旧密钥。"));
      else if (err.field === "contextWindow") error("ctx", t("填 1024 到 16777216 之间的整数，也可以写 256k、1m；不知道就留空。"));
      else if (err.field === "model") error("model", t("请输入准确的模型名称，不要包含逗号或换行。"));
      else if (err.field === "upstreams") {
        $("bc-api-error").textContent = t("模型可见 ID 冲突、超过 200 字符或总数超过 100；请调整模型后保存。");
        $("bc-api-error").classList.remove("hidden");
      }
      if (err.saved && typeof options.saved === "function") options.saved();
      if (["BUSY", "RUNTIME_CONFLICT", "not_installed"].includes(err.code)) showIssue(err, true);
      else if (err.saved || LOCAL_ERRORS.includes(err.code)) { notice(localMessage(localCode(err.code))); $("bc-repair").classList.remove("hidden"); }
      else notice(t("保存配置未完成；请检查本地状态后重试，当前会话保持不变。"));
    } finally {
      body.apiKey = "";
      if (body.upstreams) for (const source of body.upstreams) source.apiKey = "";
      if (id === seq) setBusy(false);
    }
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

  // Remote UI never calls local chat, file, model or permission-mode handlers.
  const remoteView = (() => {
    "use strict";
    const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const array = (value) => Array.isArray(value) ? value : [];
    const TEXT_LIMIT = 16 * 1024, REASON_LIMIT = 4 * 1024, MAX_COMMANDS = 32;
    const bytes = (value) => new TextEncoder().encode(String(value)).byteLength;
    function boundedInput(value, maximum) {
      let result = "", size = 0;
      for (const ch of String(value).slice(0, maximum)) {
        const point = ch.codePointAt(0), cost = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (size + cost > maximum || point >= 0xd800 && point <= 0xdfff) break;
        result += ch; size += cost;
      }
      return result;
    }
    const icon = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${({ back: '<path d="m14 5-7 7 7 7"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a7 7 0 0 1 11.6-2L20 8M4 16l2.9 3A7 7 0 0 0 18.5 17"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>' })[kind] || ""}</svg>`;
    const button = (label, action, options = {}) => `<button type="button" class="${escape(options.className || "rv-button")}" data-rv="${escape(action)}" data-rv-key="button:${escape(action)}:${escape(options.id || "")}"${options.id ? ` data-id="${escape(options.id)}"` : ""}${options.disabled ? " disabled" : ""}${options.label ? ` aria-label="${escape(options.label)}"` : ""}>${escape(label)}</button>`;
    let root = null, active = false, sessionId = null, epoch = 0, unsubscribe = null, bound = null;
    let summary = {}, snapshot = null, sessions = [], loading = false, historyBusy = false, errorCode = "", notice = "";
    let draft = "", draftClipped = false, modal = null, modalContext = null, lastMarkup = "";
    const composing = new WeakSet(), clippedInputs = new WeakSet();
    const commands = new Map(), forms = new Map(), denyOpen = new Set(), detailsSeen = new Set();
    const transport = () => {
      const value = typeof remoteTransport !== "undefined" ? remoteTransport : window.remoteTransport;
      if (!value) throw Object.assign(new Error("Remote transport unavailable"), { code: "NOT_CONFIGURED" });
      return value;
    };
    const isCurrent = (token, id = sessionId) => active && token === epoch && id === sessionId;
    const codeOf = (error) => typeof error?.code === "string" ? error.code : "UNKNOWN";
    function errorText(code) {
      switch (code) {
        case "OFFLINE": return t("连接中断；没有离线排队，请恢复连接后核对结果。");
        case "RESYNC_REQUIRED": return t("正在核对平板授权和待办，核对完成前不能操作。");
        case "GRANT_REVOKED": return t("平板已收回托管，原任务仍在平板继续。");
        case "EXPIRED": case "GRANT_EXPIRED": return t("托管授权已到期，请在平板重新开启。");
        case "REQUEST_CLOSED": case "REQUEST_EXPIRED": case "REQUEST_MISMATCH": return t("请求已处理或失效，请刷新后查看平板当前状态。");
        case "RUN_MISMATCH": case "HOST_INSTANCE_MISMATCH": case "GRANT_MISMATCH": return t("平板运行或授权已变化，请重新核对当前会话。");
        case "DETAILS_INCOMPLETE": return t("完整审批范围不可用，不能批准；请回平板查看。");
        case "NOT_CONFIGURED": case "NOT_PAIRED": return t("请先在连接设置中连接并配对设备。");
        case "GRANT_NOT_ACTIVE": return t("请先接受平板发给这台手机的托管邀请。");
        case "LIMIT_EXCEEDED": return t("内容超过远程传输限制，请缩短文字或回平板查看。");
        default: return t("操作未能确认，请刷新状态；不要重复发送同一指令。");
      }
    }
    const connection = () => summary.connection || "offline";
    const authorization = () => snapshot?.authorization || summary.authorization || "none";
    const canControl = () => active && !!sessionId && !loading && snapshot?.remoteSessionId === sessionId
      && connection() === "online" && authorization() === "active" && snapshot?.canControl === true
      && summary.verified === true && summary.phase === "ready" && summary.grant?.expiresAt > Date.now();
    const requests = () => array(snapshot?.requests);
    const pending = () => requests().filter((item) => item.state === "pending");
    const runState = () => snapshot?.run?.state || "unknown";
    const runId = () => snapshot?.run?.runId || null;
    const hasUnsettled = (kind, id) => [...commands.values()].some((item) => item.kind === kind && (!id || item.requestId === id) && !["applied", "rejected"].includes(item.status));
    const canStop = () => canControl() && !!runId() && ["running", "waiting"].includes(runState())
      && ![...commands.values()].some((item) => item.kind === "stop" && item.runId === runId() && item.status !== "rejected");
    const requestKey = (item) => JSON.stringify([item.requestId, item.requestVersion, item.runId, item.kind, item.detailsComplete, item.detailText, item.questions]);
    const requestCurrent = (item) => item && item.state === "pending" && item.runId === runId()
      && Number.isSafeInteger(item.requestVersion) && item.requestVersion > 0 && Number.isSafeInteger(item.expiresAt) && item.expiresAt > Date.now();
    const complete = (item) => item.detailsComplete === true && item.truncated !== true
      && (item.kind === "question" ? Array.isArray(item.questions) && item.questions.length > 0 && item.questions.length <= 16
        && item.questions.every((question) => typeof question.questionId === "string" && !!question.questionId && typeof question.question === "string"
          && !!question.question.trim() && typeof question.multiSelect === "boolean" && Array.isArray(question.options) && question.options.length <= 32
          && question.options.every((option) => typeof option.optionId === "string" && !!option.optionId && typeof option.label === "string" && !!option.label.trim()))
        : typeof item.detailText === "string" && !!item.detailText.trim())
      && bytes(item.detailText || "") <= 24 * 1024;
    const requestEnabled = (item) => canControl() && requestCurrent(item) && ![...commands.values()].some((command) => command.kind === "request" && command.requestId === item.requestId && command.requestVersion === item.requestVersion) && item.localOnly !== true;
    const canApprove = (item) => requestEnabled(item) && complete(item) && detailsSeen.has(requestKey(item)) && !formFor(item).clipped.size;
    function runLabel(value) {
      switch (value) {
        case "running": return t("正在执行");
        case "waiting": return t("等你确认");
        case "ended": case "finished": case "idle": return t("本轮已结束");
        case "stopped": return t("已停止");
        case "stopping": return t("正在请求停止…");
        case "needs-local": return t("需在平板本地处理");
        default: return t("状态待同步");
      }
    }
    function connectionLabel() {
      switch (connection()) {
        case "online": return t("平板在线");
        case "connecting": return t("连接中…");
        case "syncing": case "resyncing": return t("正在核对平板状态…");
        default: return t("连接中断");
      }
    }
    function timeLabel(value) {
      const time = Number(value);
      if (!time || !Number.isFinite(time)) return t("尚未同步");
      try { return new Date(time).toLocaleString(); } catch { return t("尚未同步"); }
    }
    function clearSession() {
      snapshot = null; draft = ""; draftClipped = false; historyBusy = false; lastMarkup = "";
      commands.clear(); forms.clear(); denyOpen.clear(); detailsSeen.clear();
      closeModal();
    }
    function receive(value) {
      if (!active || !value || typeof value !== "object" || Array.isArray(value)) return;
      // 06 publishes a flat, immutable PhoneSnapshot. Only this adapter knows its
      // transport field names; renderers never look at the local CC view/state.
      const next = record(value.snapshot || value);
      if (!Object.hasOwn(next, "active") || !Array.isArray(next.items) || !Array.isArray(next.pending)) return;
      const target = next.active?.remoteSessionId || null;
      if (sessionId && !target) {
        // Unpair/reset clears active on 06. Do not leave cached private text or
        // formerly enabled controls behind when the transport has discarded it.
        if (snapshot) {
          const metadata = { remoteSessionId: sessionId, authorization: "none", title: snapshot.title, deviceName: snapshot.deviceName };
          clearSession(); snapshot = metadata; summary = next; render();
        }
        return;
      }
      if (sessionId && target !== sessionId) {
        summary = { ...summary, verified: false, phase: "syncing" };
        if (snapshot) snapshot = { ...snapshot, canControl: false };
        errorCode = "RESYNC_REQUIRED"; render(); return;
      }
      if (!sessionId && target) return;
      summary = next;
      if (!sessionId) { sessions = array(next.sessions); render(); return; }
      const incoming = {
        remoteSessionId: target, hostInstanceId: next.binding?.hostInstanceId,
        grantVersion: next.binding?.grantVersion, authorization: next.grant?.state || next.phase,
        canControl: next.canControl, title: next.active?.title, deviceName: next.active?.deviceName,
        run: next.run, requests: next.pending.map((item) => ({ ...item, tool: item.toolName || item.tool, localOnly: item.kind === "local" || item.localOnly === true })),
        messages: next.items, receipts: next.receipts, historyCursor: next.historyCursor,
        historyHasMore: next.historyHasMore, lastSyncedAt: next.lastSyncedAt, cacheTruncated: next.cache?.truncated,
      };
      const prior = snapshot;
      snapshot = incoming;
      if (prior && (prior.grantVersion !== incoming.grantVersion || prior.hostInstanceId !== incoming.hostInstanceId || prior.run?.runId !== incoming.run?.runId)) {
        detailsSeen.clear(); forms.clear(); denyOpen.clear(); closeModal();
      }
      const requestKeys = new Set(requests().map(requestKey));
      for (const key of forms.keys()) if (!requestKeys.has(key)) forms.delete(key);
      for (const key of denyOpen) if (!requestKeys.has(key)) denyOpen.delete(key);
      for (const key of detailsSeen) if (!requestKeys.has(key)) detailsSeen.delete(key);
      if (["revoked", "expired"].includes(authorization())) {
        const metadata = { remoteSessionId: sessionId, authorization: authorization(), title: incoming.title, deviceName: incoming.deviceName };
        clearSession(); snapshot = metadata;
      } else {
        for (const receipt of array(incoming.receipts)) updateReceipt(receipt);
        if (modalContext?.requestKey && !requests().some((item) => requestKey(item) === modalContext.requestKey && requestCurrent(item))) closeModal();
      }
      // A verified same-target recovery supersedes only transient page connection errors.
      // Unknown command outcomes and their original query IDs remain in the receipt ledger.
      if (["OFFLINE", "RESYNC_REQUIRED"].includes(errorCode) && next.connection === "online" && next.verified === true
        && next.phase === "ready" && next.error == null && next.binding?.remoteSessionId === sessionId
        && incoming.canControl === true && incoming.authorization === "active" && next.grant?.expiresAt > Date.now()) errorCode = "";
      render();
    }
    function updateReceipt(value) {
      const receipt = record(value), item = commands.get(receipt.commandId);
      if (!item || receipt.remoteSessionId && receipt.remoteSessionId !== sessionId) return;
      if (!["received", "applied", "rejected", "unknown"].includes(receipt.status)) return;
      if (["applied", "rejected"].includes(item.status) || item.status === "unknown" && receipt.status === "received") return;
      // An applied receipt has a typed tablet result; a successful HTTP request alone is not a receipt.
      const result = record(receipt.result);
      if (receipt.status === "applied" && (result.kind !== item.kind || item.kind === "stop" && !["stopped", "ended"].includes(result.runState)
        || item.kind === "request" && (result.requestId !== item.requestId || result.requestVersion !== item.requestVersion)
        || item.kind === "message" && !["accepted", "queued"].includes(result.delivery))) return;
      item.status = receipt.status; item.result = result; item.code = receipt.code || "";
    }
    function receiptLabel(item) {
      if (item.status === "sending") return t("发送中…");
      if (item.status === "received") return item.kind === "message" ? t("平板已接收，等待进入原会话回执") : t("平板已接收，等待处理回执");
      if (item.status === "rejected") return t("平板已拒绝");
      if (item.status !== "applied") return t("结果待核实；不会自动重发");
      if (item.kind === "stop") return item.result?.runState === "stopped" ? t("平板已确认：当前执行已停止") : t("平板已确认：原运行已结束");
      if (item.kind === "request") return item.decision === "deny" || item.decision === "reject" ? t("平板已确认：已拒绝 / 退回") : item.responseKind === "question" ? t("平板已确认：回答已返回原会话") : item.responseKind === "plan" ? t("平板已确认：计划获批，仍逐项确认执行") : t("平板已确认：仅本次允许");
      return item.result?.delivery === "queued" ? t("平板已确认：已进入原会话队列") : t("平板已确认：已进入原会话");
    }
    function commandHtml(item) {
      return `<section class="rv-receipt" data-command="${escape(item.commandId)}" data-rv-key="command:${escape(item.commandId)}" aria-label="${escape(t("平板处理回执"))}">${item.text ? `<div class="rv-text">${escape(item.text)}</div>` : ""}<div class="${item.status === "applied" ? "rv-ok" : item.status === "rejected" ? "rv-error" : "rv-muted"}" role="status">${escape(receiptLabel(item))}</div>${item.code ? `<p class="rv-note">${escape(errorText(item.code))}</p>` : ""}${!["applied", "rejected", "sending"].includes(item.status) ? `<div class="rv-actions">${button(t("查询原指令结果"), "query", { id: item.commandId, disabled: !canControl() || item.querying })}</div>` : ""}</section>`;
    }
    function messageHtml(item) {
      if (item.kind === "tool") return toolHtml({ ...item, tool: item.toolName, state: item.toolStatus, input: item.toolInputText, output: item.toolResultText, summary: item.text });
      if (["tool_use", "tool_result"].includes(item.role)) return toolHtml({ ...item, ...(item.role === "tool_result" ? { output: item.text, state: item.ok === false ? "error" : "done" } : {}) });
      if (item.type === "tool_use" || item.type === "tool_result") return toolHtml(item);
      const role = item.role === "user" ? "user" : item.role === "assistant" ? "bot" : "sys";
      const blocks = array(item.content);
      const content = typeof item.text === "string" ? item.text : blocks.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
      const display = role === "bot" && content.startsWith("[子代理输出]\n") ? t("子代理输出") + "\n" + content.slice("[子代理输出]\n".length) : content;
      const tools = array(item.tools).concat(blocks.filter((part) => part.type === "tool_use" || part.type === "tool_result"));
      return `${content ? `<article class="msg ${role}"><div class="who">${escape((role === "user" ? t("你") : role === "bot" ? t("CC · 在平板执行") : t("会话状态")))}</div><div class="bubble rv-text">${escape(display)}</div>${item.truncated ? `<p class="rv-note">${escape(t("输出已限量；此处仅查看已传输内容，不读取平板或手机文件。"))}</p>` : ""}${item.source === "phone" ? `<div class="rv-source">${escape(t("来自手机"))}</div>` : ""}</article>` : ""}${tools.map(toolHtml).join("")}`;
    }
    function toolHtml(item) {
      const input = item.input === undefined ? item.summary || "" : typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2);
      const output = item.output ?? item.result ?? (item.type === "tool_result" ? item.content : "");
      const outputText = typeof output === "string" ? output : JSON.stringify(output, null, 2);
      return `<details class="rv-tool tool" data-tool="${escape(item.id || item.toolUseId || "")}"><summary class="tool-head"><span class="tool-name">${escape(item.tool || item.name || t("工具"))}</span><span class="tool-arg">${escape(item.summary || "")}</span><span class="tool-state">${escape(item.state === "error" || item.is_error ? t("失败") : item.state === "running" ? t("执行中") : t("查看结果"))}</span></summary><div class="tool-body">${input ? `<pre>${escape(input)}</pre>` : ""}${outputText ? `<pre>${escape(outputText)}</pre>` : ""}${item.truncated ? `<p class="rv-note">${escape(t("输出已限量；此处仅查看已传输内容，不读取平板或手机文件。"))}</p>` : ""}</div></details>`;
    }
    function requestKind(item) {
      return item.kind === "question" || item.tool === "AskUserQuestion" ? "question" : item.kind === "plan" || item.tool === "ExitPlanMode" ? "plan" : "permission";
    }
    function formFor(item) {
      const key = requestKey(item);
      if (!forms.has(key)) forms.set(key, { reason: "", answers: {}, clipped: new Set() });
      return forms.get(key);
    }
    function questionHtml(item) {
      const form = formFor(item);
      return array(item.questions).map((question, qi) => {
        const answer = form.answers[question.questionId] || { optionIds: [], text: "" };
        const options = array(question.options).map((option) => `<label class="perm-opt" data-rv-key="option:${escape(option.optionId)}"><input type="${question.multiSelect ? "checkbox" : "radio"}" name="rv-q-${qi}-${escape(item.requestId)}" data-rv-field="option" data-question="${escape(question.questionId)}" value="${escape(option.optionId)}"${answer.optionIds.includes(option.optionId) ? " checked" : ""}${!requestEnabled(item) ? " disabled" : ""}><span><b>${escape(option.label || "")}</b>${option.description ? `<small>${escape(option.description)}</small>` : ""}</span></label>`).join("");
        return `<fieldset data-question="${escape(question.questionId)}" data-rv-key="question:${escape(question.questionId)}"><legend>${question.header ? `<span class="rv-note rv-muted">${escape(question.header)}</span><br>` : ""}${escape(question.question || "")}</legend>${question.multiSelect ? `<p class="rv-note rv-muted">${escape(t("可以多选；填写自由回答时，以自由回答为准。"))}</p>` : ""}<div class="perm-opts">${options}</div><label class="rv-field"><span>${escape(t("自由回答"))}</span><textarea rows="2" data-rv-field="answer" data-question="${escape(question.questionId)}"${!requestEnabled(item) ? " disabled" : ""}></textarea></label></fieldset>`;
      }).join("");
    }
    function transmittedDetail(item) {
      try { return record(JSON.parse(item.detailText)); } catch { return {}; }
    }
    function requestHtml(item, index) {
      const kind = requestKind(item), enabled = requestEnabled(item), approved = canApprove(item), key = requestKey(item);
      const title = kind === "question" ? t("CC 想问你") : kind === "plan" ? t("计划待批准") : t("需要确认");
      const settled = item.state !== "pending";
      const control = [...commands.values()].find((command) => command.kind === "request" && command.requestId === item.requestId);
      const detail = transmittedDetail(item), input = record(detail.input), preview = item.summary || input.description || detail.description || item.tool || "";
      let body = `<p>${escape(preview)}</p>`;
      if (detail.guard) body += `<p class="rv-error rv-note">${escape(t("此请求触及敏感操作，请仔细核对完整详情；不会新增长期许可。"))}</p>`;
      if (kind === "question") body += questionHtml(item);
      else if (kind === "plan") body += `<div class="rv-plan">${escape(input.plan || item.detailText || "")}</div><p class="rv-note">${escape(t("批准计划后仍逐项确认需要审批的操作，不开启自动或永久放行。"))}</p>`;
      else if (input.command) body += `<pre>${escape(input.command)}</pre>`;
      else if (input.file_path || item.path) body += `<div class="perm-path">${escape(input.file_path || item.path)}</div>`;
      body += `<p class="rv-note rv-muted">${escape(t("仅在平板原会话执行 · 仅本次"))}</p>`;
      if (item.localOnly === true) body += `<p class="rv-error rv-note">${escape(t("此操作需要在平板本地处理，手机不能批准系统权限。"))}</p>`;
      if (!complete(item)) body += `<p class="rv-error rv-note">${escape(t("完整审批范围不可用，不能批准；请回平板查看。"))}</p>`;
      else if (!detailsSeen.has(key)) body += `<p class="rv-note rv-muted">${escape(t("先查看完整详情，再决定是否批准。"))}</p>`;
      body += button((kind === "plan" ? t("查看完整计划") : t("查看完整详情")), "details", { id: item.requestId, className: "rv-link" });
      const label = kind === "question" ? t("提交回答") : kind === "plan" ? t("批准，逐项确认执行") : t("本次允许");
      const deny = kind === "plan" ? t("退回修改") : kind === "question" ? t("在平板处理") : t("拒绝");
      const warning = control ? `<p class="rv-note" role="status">${escape(receiptLabel(control))}</p>` : settled ? `<p class="rv-note" role="status">${escape(t("该请求已处理或失效"))}</p>` : "";
      const actions = settled || item.localOnly ? "" : `<div class="perm-acts">${button(deny, "deny-toggle", { id: item.requestId, disabled: !enabled })}${button(label, "approve", { id: item.requestId, className: "rv-button primary", disabled: !approved })}</div>${denyOpen.has(key) ? `<div class="rv-deny"><label class="rv-field"><span>${escape(t("拒绝原因（可选）"))}</span><textarea rows="2" data-rv-field="reason"${!enabled ? " disabled" : ""}></textarea></label>${button(t("确认拒绝 / 退回"), "deny", { id: item.requestId, disabled: !enabled })}</div>` : ""}`;
      return `<section class="perm rv-request${settled ? " done" : ""}" id="rv-request-${index}" data-request="${escape(item.requestId)}" data-rv-key="request:${escape(item.requestId)}:${item.requestVersion}" tabindex="-1" aria-label="${escape(title)}"><div class="perm-head"><span class="perm-kind">${escape(title)}</span><span class="perm-tool">${escape(item.tool || kind)}</span></div><div class="perm-body">${body}${warning}</div>${actions}</section>`;
    }
    function renderHeader() {
      const title = sessionId ? snapshot?.title || t("远程会话") : t("远程会话");
      const subtitle = sessionId ? t("远程 · {device}", { device: snapshot?.deviceName || t("平板") }) : t("只显示授权给这台手机的会话");
      return `<header class="rv-head" data-rv-key="header">${button(icon("back"), "back", { className: "rv-icon", label: (sessionId ? t("返回远程会话列表") : t("返回对话")) }).replace(escape(icon("back")), icon("back"))}<div class="rv-head-text"><h2>${escape(title)}</h2><p>${escape(subtitle)}</p></div>${button(icon("refresh"), "refresh", { className: "rv-icon", label: t("刷新远程状态"), disabled: loading }).replace(escape(icon("refresh")), icon("refresh"))}${button(icon("more"), sessionId ? "menu" : "settings", { className: "rv-icon", label: (sessionId ? t("远程会话操作") : t("连接设置")) }).replace(escape(icon("more")), icon("more"))}</header>`;
    }
    function renderList() {
      const invited = sessions.filter((item) => item.state === "invited"), hosted = sessions.filter((item) => item.state === "active");
      const invite = (item) => `<section class="rv-session" data-rv-key="session:${escape(item.remoteSessionId)}"><div class="rv-session-meta"><span>${escape(item.deviceName || t("平板"))}</span><span class="rv-warn">${escape(t("托管邀请"))}</span></div><h3>${escape(item.title || t("远程会话"))}</h3><p>${escape(t("仅此会话 · 可查看、审批、发送文字。接受不会批准任何工具操作。"))}</p><div class="rv-actions">${button(t("拒绝邀请"), "decline", { id: item.remoteSessionId, disabled: loading })}${button(t("接受并打开"), "accept", { id: item.remoteSessionId, className: "rv-button primary", disabled: loading })}</div></section>`;
      const hostedCard = (item) => `<button type="button" class="rv-session" data-rv="open" data-rv-key="session:${escape(item.remoteSessionId)}" data-id="${escape(item.remoteSessionId)}"><div class="rv-session-meta"><span>${escape(item.deviceName || t("平板"))}</span><span class="${item.connection === "online" ? "rv-ok" : "rv-muted"}">${escape(item.connection === "online" ? t("在线") : t("等待连接"))}</span></div><h3>${escape(item.title || t("远程会话"))}</h3><p>${item.pendingCount ? escape(t("{n} 项等你确认", { n: item.pendingCount })) : escape(runLabel(item.runState))}</p></button>`;
      return `<main class="rv-list" data-rv-key="list" aria-label="${escape(t("远程会话列表"))}">${loading ? `<p class="rv-muted" role="status">${escape(t("正在加载远程会话…"))}</p>` : ""}${invited.length ? `<h3 class="rv-section-title">${escape(t("待接受邀请"))}</h3>${invited.map(invite).join("")}` : ""}${hosted.length ? `<h3 class="rv-section-title">${escape(t("已托管给我的会话"))}</h3>${hosted.map(hostedCard).join("")}` : ""}${!loading && !invited.length && !hosted.length ? `<div class="rv-empty"><h3>${escape(t("还没有远程会话"))}</h3><p>${escape(t("在平板会话的操作菜单里选择“托管到手机”，邀请这台手机。"))}</p>${button(t("连接设置"), "settings")}</div>` : ""}</main>`;
    }
    function renderComposer() {
      const count = pending().length, enabled = canControl() && !hasUnsettled("message") && !draftClipped;
      return `<footer class="rv-composer" data-rv-key="composer">${count ? `<div class="rv-pending" data-rv-key="pending"><span>${escape(t("{n} 项等你确认", { n: count }))}</span>${button(t("查看待办"), "jump", { className: "rv-link" })}</div>` : ""}<form data-rv-form="message"><div class="rv-input-wrap"><textarea rows="2" data-rv-field="draft" aria-label="${escape(t("向平板原会话发送文字指令"))}" placeholder="${escape((connection() === "online" ? t("向平板原会话发送指令…") : t("连接中断，可以先写草稿…")))}"></textarea><button type="submit" class="rv-button primary rv-send" data-rv="send"${!enabled || !draft.trim() || bytes(draft) > TEXT_LIMIT ? " disabled" : ""}>${escape(t("发送"))}</button></div></form><div class="rv-composer-foot"><span>${escape((connection() === "online" ? t("只发文字 · 原任务仍在平板执行") : t("草稿仅留本次查看；离线不会自动发送、批准或停止")))}</span><button type="button" class="rv-stop" data-rv="stop"${canStop() ? "" : " disabled"}>${escape((hasUnsettled("stop") ? t("正在核实停止结果…") : t("停止当前执行")))}</button></div></footer>`;
    }
    function renderChat() {
      if (["revoked", "expired"].includes(authorization())) return `<main class="rv-empty"><h3>${escape((authorization() === "revoked" ? t("平板已收回托管") : t("托管授权已到期")))}</h3><p>${escape(t("后续消息和操作已关闭，临时内容已清理。平板原任务不会因此停止。"))}</p>${button(t("返回远程会话列表"), "back")}</main>`;
      if (authorization() === "invited") return `<main class="rv-empty"><h3>${escape(t("请先接受托管邀请"))}</h3><p>${escape(t("接受只开放此会话，不会批准任何工具操作。"))}</p><div class="rv-actions">${button(t("返回远程会话列表"), "back")}${button(t("接受并打开"), "accept", { id: sessionId, disabled: loading, className: "rv-button primary" })}</div></main>`;
      if (snapshot && authorization() === "none") return `<main class="rv-empty"><h3>${escape(t("远程访问已关闭"))}</h3><p>${escape(t("临时会话内容已清理，请核对配对与托管授权。平板任务不会因此停止。"))}</p>${button(t("返回远程会话列表"), "back")}</main>`;
      const online = connection() === "online", rows = array(snapshot?.messages);
      const messages = rows.map((item, index) => `<div class="rv-record" data-rv-key="record:${escape(item.id || index)}">${messageHtml(item)}</div>`).join("");
      const requestCards = requests().map(requestHtml).join("");
      return `<div class="rv-status" data-rv-key="status" role="status"><span class="${online ? "rv-ok" : "rv-error"}"><i class="rv-dot" aria-hidden="true"></i>${escape(connectionLabel())}</span><span>${escape(canControl() ? runLabel(runState()) : t("状态待同步"))}</span>${!online ? `<span>${escape(t("缓存 · 最后同步 {time}", { time: timeLabel(snapshot?.lastSyncedAt || summary.lastSyncedAt) }))}</span>` : ""}</div><main class="rv-thread" data-rv-key="thread" aria-label="${escape(t("远程会话消息"))}">${snapshot?.historyHasMore ? button(t("按需加载更早的消息"), "history", { className: "rv-link rv-history", disabled: !canControl() || historyBusy }) : ""}${loading ? `<p class="rv-muted" role="status">${escape(t("正在核对平板授权和最近消息…"))}</p>` : ""}${messages}${array(snapshot?.tools).map(toolHtml).join("")}<div class="rv-requests" data-rv-key="requests">${requestCards}</div>${[...commands.values()].map(commandHtml).join("")}${snapshot && !rows.length && !requests().length ? `<p class="rv-note rv-muted">${escape(t("尚无最近消息；可刷新平板当前状态。"))}</p>` : ""}</main>${renderComposer()}`;
    }
    function focusIdentity(element, index) {
      const requestId = element.closest("[data-request]")?.dataset.request || "";
      return JSON.stringify([requestId, element.dataset.rv || "", element.dataset.id || "", element.dataset.rvField || "", element.dataset.question || "", element.tagName === "INPUT" ? element.value || "" : "", element.tagName, element.tagName === "SUMMARY" ? element.closest("[data-tool]")?.dataset.tool || index : ""]);
    }
    const nodeKey = (node) => node?.nodeType === 1 ? node.getAttribute("data-rv-key") || "" : "";
    function fieldValue(element) {
      const field = element.dataset.rvField;
      if (field === "draft") return draft;
      const item = findRequest(element.closest("[data-request]")?.dataset.request);
      if (!item) return "";
      const form = formFor(item);
      return field === "reason" ? form.reason : form.answers[element.dataset.question]?.text || "";
    }
    function syncTextarea(element) {
      if (composing.has(element)) return;
      // Values come from the model, never from HTML's textarea/LF parsing.
      const value = fieldValue(element);
      if (element.value !== value) element.value = value;
    }
    function patchText(current, value) {
      const before = current.nodeValue;
      if (before === value) return;
      let start = 0, oldEnd = before.length, newEnd = value.length;
      while (start < oldEnd && start < newEnd && before[start] === value[start]) start++;
      while (oldEnd > start && newEnd > start && before[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
      // In particular, appending a delta must not replace the selected prefix.
      current.replaceData(start, oldEnd - start, value.slice(start, newEnd));
    }
    function patchNode(current, next) {
      if (current.nodeType === 3) { patchText(current, next.nodeValue); return; }
      if (current.isEqualNode(next) && !["TEXTAREA", "INPUT"].includes(current.tagName) && !current.querySelector("input,textarea")) return;
      for (const attr of [...current.attributes]) if (attr.name !== "data-rv-focus" && !(current.tagName === "DETAILS" && attr.name === "open")
        && !(current.tagName === "TEXTAREA" && attr.name === "style") && !next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      for (const attr of [...next.attributes]) if (!(current.tagName === "DETAILS" && attr.name === "open")
        && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      if (current.tagName === "TEXTAREA") {
        // Preserve the editing node, selection, scroll and IME buffer. A
        // composition is committed/bounded by compositionend, never by a push.
        syncTextarea(current);
        return;
      }
      if (current.tagName === "INPUT") {
        if (current.value !== next.value) current.value = next.value;
        if (current.checked !== next.checked) current.checked = next.checked;
      }
      patchChildren(current, next);
    }
    function patchChildren(parent, nextParent) {
      const old = [...parent.childNodes], keyed = new Map(old.filter(nodeKey).map((node) => [nodeKey(node), node]));
      const plain = new Map();
      for (const node of old) if (!nodeKey(node)) {
        const kind = node.nodeType + ":" + node.nodeName, list = plain.get(kind) || [];
        list.push(node); plain.set(kind, list);
      }
      const used = new Set(), positions = new Map();
      const plan = [...nextParent.childNodes].map((next) => {
        const key = nodeKey(next), kind = next.nodeType + ":" + next.nodeName;
        const position = positions.get(kind) || 0;
        let current = key ? keyed.get(key) : plain.get(kind)?.[position];
        if (!key) positions.set(kind, position + 1);
        if (current && (used.has(current) || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName)) current = null;
        if (current) used.add(current);
        return { current, next };
      });
      // Remove dead siblings first: survivors must not be detached just to step
      // past a node that is about to disappear (focus, composition and Range).
      for (const node of old) if (!used.has(node)) node.remove();
      let cursor = parent.firstChild;
      for (const { current, next } of plan) {
        if (current) {
          if (current !== cursor) parent.insertBefore(current, cursor);
          patchNode(current, next); cursor = current.nextSibling;
        } else { parent.insertBefore(next, cursor); cursor = next.nextSibling; }
      }
    }
    function render() {
      if (!active || !root) return;
      const focus = document.activeElement, focusKey = focus && root.contains(focus) && focus.dataset?.rvFocus != null ? focus.dataset.rvFocus : null;
      const selection = focus && typeof focus.selectionStart === "number" ? [focus.selectionStart, focus.selectionEnd, focus.selectionDirection || "none"] : null;
      const thread = root.querySelector(".rv-thread"), scroll = thread ? { top: thread.scrollTop, height: thread.scrollHeight, bottom: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80 } : null;
      const anchor = thread && typeof thread.getBoundingClientRect === "function"
        && [...thread.querySelectorAll(".rv-record")].find((node) => node.getBoundingClientRect().bottom > thread.getBoundingClientRect().top);
      const offset = anchor ? anchor.getBoundingClientRect().top - thread.getBoundingClientRect().top : 0;
      const expanded = new Map([...root.querySelectorAll(".rv-tool")].map((item, index) => [item.dataset.tool || `index-${index}`, !!item.open]));
      root.dataset.remoteSessionId = sessionId || "";
      const html = `<div class="rv-view" data-rv-key="view:${escape(sessionId || "list")}:${epoch}">${renderHeader()}${errorCode ? `<div class="rv-banner rv-error" data-rv-key="error" role="alert">${escape(errorText(errorCode))}</div>` : ""}${notice ? `<div class="rv-banner" data-rv-key="notice" role="status">${escape(notice)}</div>` : ""}${sessionId ? renderChat() : renderList()}</div>`;
      const fieldChanges = [...root.querySelectorAll("textarea")].some((element) => !composing.has(element) && element.value !== fieldValue(element));
      if (html === lastMarkup && !fieldChanges) return;
      if (root.childNodes && typeof root.isEqualNode === "function") {
        const next = document.createElement("div"); next.innerHTML = html;
        patchChildren(root, next);
      } else root.innerHTML = html; // Minimal non-browser DOM contract fixtures.
      // Also initialise newly inserted fields; empty HTML text avoids parser
      // normalisation, and no maxlength may silently pre-clip a user paste.
      [...root.querySelectorAll("textarea")].forEach(syncTextarea);
      lastMarkup = html;
      [...root.querySelectorAll("input,textarea,button,summary")].forEach((element, index) => { element.dataset.rvFocus = focusIdentity(element, index); });
      [...root.querySelectorAll(".rv-tool")].forEach((item, index) => { item.open = !!expanded.get(item.dataset.tool || `index-${index}`); });
      const nextThread = root.querySelector(".rv-thread");
      if (nextThread && scroll) {
        if (!historyBusy && scroll.bottom) nextThread.scrollTop = nextThread.scrollHeight;
        else if (anchor && root.contains(anchor) && nextThread.contains(anchor)) nextThread.scrollTop += anchor.getBoundingClientRect().top - nextThread.getBoundingClientRect().top - offset;
        else nextThread.scrollTop = scroll.top + (historyBusy ? nextThread.scrollHeight - scroll.height : 0);
      }
      if (focusKey != null) {
        const next = [...root.querySelectorAll("input,textarea,button,summary")].find((item) => item.dataset.rvFocus === focusKey);
        if (next && next !== document.activeElement && !next.disabled) {
          try { next.focus({ preventScroll: true }); if (selection && next.setSelectionRange) next.setSelectionRange(...selection); } catch {}
        }
      }
    }
    function closeModal() {
      if (!modal) return;
      const element = modal; modal = null; modalContext = null;
      if (typeof OV !== "undefined") OV.close(element); else { element.remove(); element._rvOnClose?.(); }
    }
    function showModal(title, body, footer = "", context = {}) {
      closeModal();
      const element = document.createElement("div");
      element.className = "rv-modal";
      // OV focuses this outer element on pointer input, not the inner card.
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
      element.setAttribute("aria-labelledby", "rv-dialog-title");
      element.setAttribute("tabindex", "-1");
      element.innerHTML = `<section class="rv-dialog"><header class="rv-dialog-head"><h2 id="rv-dialog-title">${escape(title)}</h2>${button(t("关闭"), "modal-close")}</header><div class="rv-dialog-body">${body}</div>${footer ? `<footer class="rv-dialog-foot rv-actions">${footer}</footer>` : ""}</section>`;
      const previous = document.activeElement;
      const openerKey = previous && root?.contains(previous) ? previous.dataset?.rvFocus : null;
      const openerRequestId = previous?.closest("[data-request]")?.dataset.request;
      const openerEpoch = epoch, openerSessionId = sessionId;
      modal = element; modalContext = context;
      element.addEventListener("click", (event) => {
        const target = event.target.closest("button[data-rv]");
        if (target && !target.disabled) handleAction(target.dataset.rv, target.dataset.id || "", context);
      });
      element.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeModal(); }
        else if (event.key === "Tab" && typeof trapTab !== "undefined") trapTab(element, event);
      });
      const restoreOpener = () => {
        if (!isCurrent(openerEpoch, openerSessionId) || modal || !root?.isConnected || root.hidden) return;
        // Request removal/version changes may replace the opener while the dialog is open.
        const next = openerKey != null ? [...root.querySelectorAll("input,textarea,button,summary")].find((item) => item.dataset.rvFocus === openerKey && !item.disabled) : null;
        const request = openerRequestId ? [...root.querySelectorAll("[data-request]")].find((item) => item.dataset.request === openerRequestId) : null;
        const target = next || (previous?.isConnected && root.contains(previous) && !previous.disabled ? previous : null) || request || root.querySelector('[data-rv="back"]');
        target?.focus({ preventScroll: true });
      };
      const onClose = () => {
        if (modal === element) { modal = null; modalContext = null; }
        restoreOpener();
        // Closing may synchronously redraw/remove the request. Do not steal a valid new focus.
        Promise.resolve().then(() => {
          const focus = document.activeElement;
          if (!focus || focus === document.body || !focus.isConnected) restoreOpener();
        });
      };
      if (typeof OV !== "undefined") OV.open(element, { kind: "modal", cover: true, keep: true, onClose });
      else { document.body.appendChild(element); element._rvOnClose = onClose; element.querySelector("button")?.focus(); }
      return element;
    }
    function showDetails(item) {
      const kind = requestKind(item), detail = transmittedDetail(item);
      const payload = item.detailText || (kind === "question" ? JSON.stringify(item.questions || [], null, 2) : "");
      const body = `<dl><dt>${escape(t("执行设备"))}</dt><dd>${escape(snapshot?.deviceName || t("平板"))}</dd><dt>${escape(t("工具"))}</dt><dd>${escape(item.tool || kind)}</dd><dt>${escape(t("操作说明"))}</dt><dd>${escape(detail.description || item.summary || "")}</dd></dl>${detail.guard ? `<p class="rv-error">${escape(t("此请求触及敏感操作；不会改变平板原有的安全检查。"))}</p><pre>${escape(typeof detail.guard === "string" ? detail.guard : JSON.stringify(detail.guard, null, 2))}</pre>` : ""}<pre>${escape(payload)}</pre>${item.details ? `<pre>${escape(typeof item.details === "string" ? item.details : JSON.stringify(item.details, null, 2))}</pre>` : ""}<p class="rv-note${complete(item) ? " rv-muted" : " rv-error"}">${escape((complete(item) ? t("以上是平板提供的完整本次范围；路径仅供查看，不会打开手机文件。") : t("完整审批范围不可用，不能批准；请回平板查看。")))}</p>`;
      const footer = complete(item) ? button(t("已查看，返回会话"), "details-read", { id: item.requestId, className: "rv-button primary" }) : button(t("返回会话"), "modal-close");
      showModal((kind === "plan" ? t("完整计划") : t("完整审批详情")), body, footer, { requestKey: requestKey(item), epoch });
    }
    function newCommand(kind, extra = {}) {
      if (commands.size >= MAX_COMMANDS) {
        const settled = [...commands.values()].find((item) => ["applied", "rejected"].includes(item.status));
        if (settled) commands.delete(settled.commandId);
        else { errorCode = "LIMIT_EXCEEDED"; render(); return null; }
      }
      let id;
      try {
        if (crypto.randomUUID) id = crypto.randomUUID();
        else id = "rv-" + [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
      } catch { errorCode = "UNKNOWN"; render(); return null; }
      const command = { commandId: id, kind, runId: runId(), status: "sending", ...extra };
      commands.set(id, command); return command;
    }
    async function execute(command, operation) {
      const token = epoch, id = sessionId;
      errorCode = ""; notice = ""; render();
      try {
        const receipt = await operation();
        if (!isCurrent(token, id)) return;
        updateReceipt(receipt);
        if (command.status === "sending") command.status = "unknown";
      } catch (error) {
        if (!isCurrent(token, id)) return;
        // A pushed tablet result can win the race with this operation's error.
        if (!["applied", "rejected"].includes(command.status)) { command.status = "unknown"; command.code = codeOf(error); }
      }
      if (isCurrent(token, id)) render();
    }
    async function sendText() {
      if (!canControl() || hasUnsettled("message") || draftClipped || !draft.trim()) return;
      if (bytes(draft) > TEXT_LIMIT) { errorCode = "LIMIT_EXCEEDED"; render(); return; }
      const text = draft, command = newCommand("message", { text });
      if (!command) return;
      draft = "";
      await execute(command, () => transport().sendText(text, command.commandId));
    }
    async function respond(item, deny) {
      if (!requestEnabled(item) || formFor(item).clipped.size || !deny && !canApprove(item)) return;
      const kind = requestKind(item), form = formFor(item), reason = form.reason.trim();
      if (bytes(reason) > REASON_LIMIT) { errorCode = "LIMIT_EXCEEDED"; render(); return; }
      let response;
      if (kind === "question") {
        if (deny) { notice = t("此问答不能远程跳过，请在平板本地处理。"); render(); return; }
        const answers = array(item.questions).map((question) => {
          const answer = form.answers[question.questionId] || { optionIds: [], text: "" };
          const text = answer.text.trim();
          // Original CC treats a free answer as an alternative to selected
          // labels; never send an ambiguous combination that the tablet rejects.
          return { questionId: question.questionId, optionIds: text ? [] : answer.optionIds.slice(), ...(text ? { text } : {}) };
        });
        if (!answers.length || answers.some((answer) => !answer.optionIds.length && !answer.text)) { notice = t("请为每个问题选择选项或填写回答。"); render(); return; }
        if (answers.some((answer) => bytes(answer.text || "") > TEXT_LIMIT)) { errorCode = "LIMIT_EXCEEDED"; render(); return; }
        response = { kind: "question", answers };
      } else response = { kind, decision: kind === "plan" ? deny ? "reject" : "approve" : deny ? "deny" : "allow", ...(reason && deny ? { reason } : {}) };
      const command = newCommand("request", { requestId: item.requestId, requestVersion: item.requestVersion, decision: response.decision, responseKind: kind });
      if (command) await execute(command, () => transport().respond(item.requestId, response, command.commandId));
    }
    async function query(command) {
      if (!command || command.querying || !canControl()) return;
      command.querying = true;
      const token = epoch, id = sessionId;
      render();
      try {
        const receipt = await transport().query(command.commandId);
        if (isCurrent(token, id)) updateReceipt(receipt);
      } catch (error) { if (isCurrent(token, id)) errorCode = codeOf(error); }
      finally { if (isCurrent(token, id)) { command.querying = false; render(); } }
    }
    async function loadHistory() {
      if (!canControl() || historyBusy || !snapshot?.historyHasMore) return;
      const token = epoch, id = sessionId, cursor = snapshot.historyCursor || null;
      historyBusy = true; render();
      try {
        const value = await transport().history(cursor);
        if (isCurrent(token, id)) receive(value);
      } catch (error) { if (isCurrent(token, id)) errorCode = codeOf(error); }
      finally { if (isCurrent(token, id)) { historyBusy = false; render(); } }
    }
    function findRequest(id) { return requests().find((item) => item.requestId === id); }
    async function handleAction(action, id, context = {}) {
      if (!active) return;
      if (action === "modal-close") { closeModal(); return; }
      if (action === "details-read") {
        const item = findRequest(id);
        if (item && complete(item) && context.epoch === epoch && context.requestKey === requestKey(item)) detailsSeen.add(requestKey(item));
        closeModal(); render(); return;
      }
      if (action === "accept") { await select(id, true); return; }
      if (action === "decline") { await declineInvitation(id); return; }
      if (action === "open") { await open(id); return; }
      if (action === "refresh") { await refresh(); return; }
      if (action === "back") {
        closeModal();
        if (sessionId) await open();
        else { await close(); root?.dispatchEvent(new CustomEvent("cc:remote-back", { bubbles: true })); }
        return;
      }
      if (action === "settings") { closeModal(); if (typeof remoteSettings !== "undefined") remoteSettings.open(); else if (window.remoteSettings) window.remoteSettings.open(); return; }
      if (action === "send") { await sendText(); return; }
      if (action === "query") { await query(commands.get(id)); return; }
      if (action === "history") { await loadHistory(); return; }
      if (action === "jump") {
        const item = root.querySelector(".rv-request:not(.done)");
        item?.scrollIntoView({ block: "center", behavior: "auto" }); item?.focus({ preventScroll: true }); return;
      }
      if (action === "menu") {
        showModal(t("远程会话"), `<p class="rv-note">${escape(t("停止查看不会停止平板任务，也不会收回平板授权。"))}</p>`, button(t("返回远程会话列表"), "back") + button(t("连接设置"), "settings") + button(t("停止查看并清理临时内容"), "leave", { className: "rv-button danger" })); return;
      }
      if (action === "leave") { await close(); root?.dispatchEvent(new CustomEvent("cc:remote-back", { bubbles: true })); return; }
      if (action === "stop" && canStop()) {
        showModal(t("停止平板当前执行？"), `<p>${escape(t("这会请求中断平板当前运行。已经完成的修改和外部副作用不会自动撤销。"))}</p><p class="rv-note">${escape(t("停止不会收回托管；仅在收到平板运行结束回执后显示已停止。"))}</p>`, button(t("取消"), "modal-close") + button(t("请求停止"), "stop-confirm", { className: "rv-button danger" }), { epoch, runId: runId() }); return;
      }
      if (action === "stop-confirm") {
        if (context.epoch !== epoch || context.runId !== runId() || !canStop()) { closeModal(); return; }
        closeModal();
        const command = newCommand("stop");
        if (command) await execute(command, () => transport().stop(command.commandId));
        return;
      }
      const item = findRequest(id);
      if (!item) return;
      if (action === "details") { showDetails(item); return; }
      if (action === "deny-toggle" && requestEnabled(item)) {
        if (requestKind(item) === "question") { notice = t("此问答不能远程跳过，请在平板本地处理。"); render(); return; }
        const key = requestKey(item); denyOpen.has(key) ? denyOpen.delete(key) : denyOpen.add(key); render(); return;
      }
      if (action === "approve") { await respond(item, false); return; }
      if (action === "deny") await respond(item, true);
    }
    function input(event) {
      const element = event.target, field = element.dataset?.rvField;
      if (!field) return;
      const maximum = field === "reason" ? REASON_LIMIT : TEXT_LIMIT;
      const previousNotice = notice, editing = event.type === "input" && !event.isComposing && !composing.has(element);
      const formItem = field === "draft" ? null : findRequest(element.closest("[data-request]")?.dataset.request);
      const formKey = field + ":" + (element.dataset.question || "");
      if (field === "draft" && draftClipped || formItem && formFor(formItem).clipped.has(formKey)) clippedInputs.add(element);
      if (["draft", "reason", "answer"].includes(field)) {
        const value = boundedInput(element.value, maximum);
        if (value !== element.value) {
          clippedInputs.add(element); notice = t("内容超过远程传输限制，请缩短文字或回平板查看。");
          if (!event.isComposing && !composing.has(element)) element.value = value;
        } else if (editing && clippedInputs.has(element)) {
          clippedInputs.delete(element); notice = "";
        }
      }
      if (field === "draft") {
        draftClipped = clippedInputs.has(element);
        if (!draftClipped && notice === t("内容超过远程传输限制，请缩短文字或回平板查看。")) notice = "";
        draft = boundedInput(element.value, TEXT_LIMIT);
        const send = root.querySelector('[data-rv="send"]');
        if (send) send.disabled = !canControl() || hasUnsettled("message") || draftClipped || !draft.trim() || bytes(draft) > TEXT_LIMIT;
        if (previousNotice !== notice && !composing.has(element) && !event.isComposing) render();
        return;
      }
      const request = element.closest("[data-request]"), item = request && findRequest(request.dataset.request);
      if (!item) return;
      const form = formFor(item), wasClipped = form.clipped.size > 0;
      if (["reason", "answer"].includes(field)) {
        const key = field + ":" + (element.dataset.question || "");
        if (clippedInputs.has(element)) form.clipped.add(key); else form.clipped.delete(key);
        if (!form.clipped.size && notice === t("内容超过远程传输限制，请缩短文字或回平板查看。")) notice = "";
      }
      if (field === "reason") form.reason = boundedInput(element.value, REASON_LIMIT);
      else {
        const questionId = element.dataset.question, question = array(item.questions).find((candidate) => candidate.questionId === questionId);
        if (!question) return;
        const answer = form.answers[questionId] ||= { optionIds: [], text: "" };
        if (field === "answer") answer.text = boundedInput(element.value, TEXT_LIMIT);
        else if (field === "option") {
          if (question.multiSelect) answer.optionIds = element.checked ? [...new Set([...answer.optionIds, element.value])] : answer.optionIds.filter((value) => value !== element.value);
          else answer.optionIds = element.checked ? [element.value] : [];
        }
      }
      if ((previousNotice !== notice || wasClipped !== (form.clipped.size > 0)) && !composing.has(element) && !event.isComposing) render();
    }
    function ensureRoot() {
      root = document.getElementById("remotePage");
      if (!root) throw new Error("Missing #remotePage");
      if (bound !== root) {
        bound = root;
        root.addEventListener("click", (event) => {
          const target = event.target.closest("button[data-rv]");
          if (!target || target.disabled || !root.contains(target)) return;
          event.preventDefault();
          handleAction(target.dataset.rv, target.dataset.id || "").catch(() => { if (active) { errorCode = "UNKNOWN"; render(); } });
        });
        root.addEventListener("input", input); root.addEventListener("change", input);
        root.addEventListener("compositionstart", (event) => { composing.add(event.target); });
        root.addEventListener("compositionend", (event) => { composing.delete(event.target); input(event); render(); });
        root.addEventListener("submit", (event) => {
          if (event.target.dataset?.rvForm !== "message") return;
          event.preventDefault(); sendText().catch(() => { if (active) { errorCode = "UNKNOWN"; render(); } });
        });
        root.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && !event.defaultPrevented && !modal) {
            event.preventDefault(); event.stopPropagation(); handleAction("back").catch(() => {});
          }
        });
      }
      root.hidden = false;
      root.classList.remove("hidden");
    }
    async function declineInvitation(id) {
      if (loading || !sessions.some((item) => item.remoteSessionId === id && item.state === "invited")) return;
      const token = epoch;
      loading = true; errorCode = ""; render();
      try {
        const result = await transport().decline(id);
        if (isCurrent(token)) receive(result);
        if (isCurrent(token) && sessions.some((item) => item.remoteSessionId === id && item.state === "invited")) {
          errorCode = "UNKNOWN";
        }
      } catch (error) { if (isCurrent(token)) errorCode = codeOf(error); }
      finally { if (isCurrent(token)) { loading = false; render(); } }
    }
    async function select(id, acceptInvitation = false) {
      ensureRoot();
      active = true;
      const token = ++epoch;
      sessionId = typeof id === "string" && id ? id : null;
      clearSession(); errorCode = ""; notice = ""; loading = true; sessions = [];
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      render();
      try {
        const remote = transport();
        let listening = false;
        const off = remote.subscribe((value) => { if (listening && isCurrent(token)) receive(value); });
        if (isCurrent(token)) unsubscribe = off; else { off?.(); return; }
        // Ignore subscribe's immediate old-page snapshot. open/accept first
        // establishes a fresh target; only its events/results may populate it.
        listening = true;
        if (sessionId) {
          const opened = await (acceptInvitation ? remote.accept(sessionId) : remote.open(sessionId));
          if (isCurrent(token)) receive(opened);
        } else { await remote.close(); if (!isCurrent(token)) return; const list = await remote.list(); if (isCurrent(token)) { sessions = array(list?.sessions || list); receive(list); } }
      } catch (error) { if (isCurrent(token)) errorCode = codeOf(error); }
      finally { if (isCurrent(token)) { loading = false; render(); } }
    }
    async function open(id) { return select(id, false); }
    async function refresh() {
      if (!active) return;
      const token = epoch, id = sessionId;
      errorCode = ""; loading = true; render();
      try {
        const remote = transport();
        const status = await remote.status();
        if (!isCurrent(token, id)) return;
        receive(status);
        if (!id) { const list = await remote.list(); if (isCurrent(token, id)) { sessions = array(list?.sessions || list); receive(list); } }
      } catch (error) { if (isCurrent(token, id)) errorCode = codeOf(error); }
      finally { if (isCurrent(token, id)) { loading = false; render(); } }
    }
    async function close() {
      ++epoch; active = false; sessionId = null;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      clearSession(); sessions = []; summary = {}; errorCode = ""; notice = ""; loading = false;
      if (root) { root.innerHTML = ""; root.dataset.remoteSessionId = ""; root.hidden = true; }
      try { await transport().close(); } catch { /* Closing a view is not a stop or a success receipt. */ }
    }
    return Object.freeze({ open, close, refresh });
  })();
  window.remoteView = remoteView;

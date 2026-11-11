  // ── 权限确认 ─────────────────────────────────────────────────────
  //  claude 要跑需确认的工具时，网关把 can_use_tool 转成 perm_request 事件。
  //  卡片挂在对应工具卡下面；输入框上方另有一条常驻提示（翻到上面去了、分屏切回来也看得见）。
  //  参数一律以 claude 发来的为准，前端只回「允许 / 拒绝 / 始终允许 / 选项答案」。
  const PERMS = new Map();          // id → { p, runId, el, done }
  const permBar = $("perm-bar");
  let permWaiting = false;          // 状态栏此刻显示的是「等你确认」
  const MODE_KEYS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
  const modeLabel = (m) => ({
    default: t("逐项确认"), acceptEdits: t("自动接受编辑"), plan: t("只做计划"),
    auto: t("自动判断"), dontAsk: t("不询问"), bypassPermissions: t("全部放行"),
  }[m] || m || "");
  function setPermChip(m) {
    if (!m) return;
    state.permissionMode = m;
    permEl.innerHTML = (m === "bypassPermissions" ? '<svg class="ei" viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/></svg>' : "") + esc(modeLabel(m));
    permEl.classList.toggle("danger", m === "bypassPermissions");
  }

  function permRules(p) {
    const out = [];
    for (const s of p.suggestions || []) {
      if (s.type === "addRules") for (const r of s.rules || []) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    }
    return out;
  }
  const permSuggestsEdits = (p) => (p.suggestions || []).some((s) => s.type === "setMode" && s.mode === "acceptEdits");

  // 别叫 diffHtml：各段拼在同一个作用域里，16 段版本面板的 diffHtml(text) 会把它盖掉，
  // 权限卡上 Edit 的新内容就不显示了，人可能在看不到要写什么的情况下点了允许（审查 #49 P1-1）
  function permDiffHtml(oldS, newS) {
    const lines = (s, c) => String(s || "").split("\n").slice(0, 60).map((l) => `<span class="${c}">${c === "del" ? "-" : "+"} ${esc(l)}</span>`).join("\n");
    return `<pre class="perm-diff">${lines(oldS, "del")}\n${lines(newS, "add")}</pre>`;
  }
  function permPreview(p) {
    const i = p.input || {};
    let h = "";
    switch (p.tool) {
      case "Bash":
        h = `<pre class="perm-cmd">${esc(i.command || "")}</pre>` + (i.description ? `<div class="perm-sub">${esc(i.description)}</div>` : "");
        break;
      case "Edit":
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + permDiffHtml(i.old_string, i.new_string);
        break;
      case "MultiEdit":
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + (i.edits || []).slice(0, 8).map((e) => permDiffHtml(e.old_string, e.new_string)).join("");
        break;
      case "Write": {
        // 内容很大时网关只发了前一段（inputCut 里是原来的行数，195-B.4）
        const c = String(i.content || ""), ls = c.split("\n"), n = p.inputCut?.content?.lines || ls.length;
        h = `<div class="perm-path">${esc(i.file_path || "")}</div><pre class="perm-diff">${ls.slice(0, 30).map((l) => `<span class="add">+ ${esc(l)}</span>`).join("\n")}${n > 30 ? "\n" + esc(t("…（共 {n} 行）", { n })) : ""}</pre>`;
        break;
      }
      case "Read": case "Glob": case "Grep":
        h = `<div class="perm-path">${esc(i.file_path || i.path || "")}</div>` + (i.pattern ? `<pre class="perm-cmd">${esc(i.pattern)}</pre>` : "");
        break;
      case "NotebookEdit":
        h = `<div class="perm-path">${esc(i.notebook_path || "")}</div><pre class="perm-cmd">${esc(String(i.new_source || "").slice(0, 3000))}</pre>`;
        break;
      case "WebFetch": h = `<pre class="perm-cmd">${esc(i.url || "")}</pre>` + (i.prompt ? `<div class="perm-sub">${esc(i.prompt)}</div>` : ""); break;
      case "UserConfig": {
        // 用户级配置的改动 + 之前的对话留下的后台进程（网关 userconf.mjs / leftover.mjs）
        const kindL = (k) => ({ added: t("新增"), changed: t("改动"), removed: t("删除"), transient: t("改过又改回") }[k] || "");
        h = (i.first ? `<div class="perm-sub">${t("第一次检查：下面这些配置每次对话都会交给 Claude，确认一下是不是你自己放的。")} ${t("撤销会把它挪进 ~/.ccapp-userconf/quarantine，找得回来。")}</div>` : "")
          + (i.changes || []).map((c) => c.kind === "more" ? `<div class="perm-path">${esc(c.rel)}</div>${c.preview ? `<pre class="perm-cmd">${esc(c.preview)}</pre>` : ""}` : `<div class="perm-path">${esc(kindL(c.kind))} ~/${esc(c.rel)}${c.during ? " · " + t("在一轮对话运行期间改的") : ""}${c.again ? " · " + t("撤销后又被改回来（第 {n} 次）", { n: c.again + 1 }) : ""}</div>${c.preview ? `<pre class="perm-cmd">${esc(c.preview)}</pre>` : ""}`).join("")
          + ((i.procs || []).length ? `<div class="perm-sub">${t("之前的对话留下、还在后台运行的程序：")}</div><pre class="perm-cmd">${esc(i.procs.map((x) => `${x.pid}  ${x.kind === "unknown" ? "[" + t("来源不明") + "] " : ""}${x.cmd}`).join("\n"))}</pre>` : "");
        break;
      }
      case "ProjectConfig": h = `<div class="perm-path">${esc(i.dir || "")}</div><pre class="perm-cmd">${esc((i.risks || []).join("\n"))}</pre>`; break;
      case "WebSearch": h = `<pre class="perm-cmd">${esc(i.query || "")}</pre>`; break;
      case "ExitPlanMode": h = `<div class="perm-plan">${renderMd(String(i.plan || ""))}</div>`; break;
      case "AskUserQuestion":
        h = (i.questions || []).map((q, qi) => `
          <div class="perm-q" data-q="${qi}">
            <div class="perm-qt">${esc(q.question || "")}</div>
            <div class="perm-opts">${(q.options || []).map((o) => `
              <label class="perm-opt"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="pq-${esc(p.id)}-${qi}" value="${esc(o.label)}">
                <span><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ""}</span></label>`).join("")}
            </div>
            <input class="perm-other" placeholder="${t("或者直接写你的回答…")}">
          </div>`).join("");
        break;
      default:
        h = `<pre class="perm-cmd">${esc(JSON.stringify(i, null, 2).slice(0, 4000))}</pre>`;
    }
    if (p.blockedPath && !["Edit", "Write", "MultiEdit"].includes(p.tool) && !String(i.command || "").includes(p.blockedPath)) h += `<div class="perm-sub">${t("涉及路径：{p}", { p: esc(p.blockedPath) })}</div>`;
    if (p.reason && typeof p.reason === "string") h += `<div class="perm-sub">${t("原因：{r}", { r: esc(p.reason) })}</div>`;
    // 敏感操作再确认（网关的 guard 钩子）：说清楚碰到了什么、为什么要多问一句
    if (p.guard) h = `<div class="perm-guard"><b>${esc(permGuardWhat(p.guard, p.input))}</b><p>${p.guard.cat === "userconf"
      ? t("这些改动如果不是你自己做的、或者认不出来，选「撤销」：配置恢复到上次确认时的样子（新多出来的文件挪进隔离目录，不删），留下的程序会被结束。是你自己改的就选「保留」，以后不再问。")
      : p.guard.cat === "error"
      ? t("正常情况下不会出现。拿不准这一步是做什么的，就拒绝。")
      : p.guard.cat === "project"
      ? t("这些配置会以本应用的身份直接运行程序。不是你自己写的、或者来路不明的项目，选「不加载」：这一轮照常进行，只是不用它们。允许后记住，配置变了会再问。")
      : t("如果不是你让它这么做的，多半是它读到的网页或文件里藏了指令，建议拒绝。允许后，这一轮里同一类操作不再问。")}</p></div>` + h;
    return h;
  }

  function permGuardWhat(g, i) {
    const c = String(g.cat || "");
    if (c === "userconf") return (i?.changes || []).length ? t("会交给 Claude 的用户级配置有变化，没经过你确认") : t("之前的对话留下了还在运行的后台程序");
    if (c === "error") return t("安全检查自己出错了，判断不了这一步");
    if (c === "device:screen") return t("要读屏幕或替你操作别的应用（{w}）", { w: g.what });
    if (c === "device:clipboard") return t("要读剪贴板");
    if (c === "device:share") return t("要把文件分享到别的应用");
    if (c === "project") return t("这个项目带了打开就会自动运行的配置（钩子、MCP 服务器等）");
    // what 是「英文类别: 命中的那段路径」，界面只显示路径那段
    const w = String(g.what || ""), k = w.indexOf(": ");
    if (c.startsWith("prompt:")) return t("要改管着提示词或安全检查的文件：{w}", { w: k > 0 ? w.slice(k + 2) : w });
    return t("碰到了密钥或登录凭据：{w}", { w: k > 0 ? w.slice(k + 2) : w });
  }

  // 这张卡所属那一轮实际在用的模式：并行时各轮可能不同（项目默认、会话单独选），别拿全局的芯片值猜（DeepSeek 复核 11-02）
  const runMode = (runId) => (srv.runs.find((r) => r.id === runId) || {}).permMode || state.permissionMode;
  // 和 gw/config.mjs 的 WIDE_PERM_MODES 是同一张表，改一处要同步另一处
  const WIDE_MODES = ["bypassPermissions", "auto", "dontAsk"];
  function permActions(p, runId) {
    if (p.guard) return `
      <button class="pa-allow">${p.guard.cat === "userconf" ? t("是我做的，保留") : p.guard.cat === "project" ? t("允许并记住") : t("允许")}</button>
      <button class="pa-more primary">${p.guard.cat === "userconf" ? t("撤销 ▾") : p.guard.cat === "project" ? t("不加载 ▾") : t("拒绝 ▾")}</button>`;
    if (p.tool === "ExitPlanMode") {
      // 用户本来就放得比「自动接受编辑」宽（全部放行等）时，批准计划不该顺手把全局模式降下来（群友反馈）
      const cur = runMode(runId), keep = WIDE_MODES.includes(cur);
      return `
      ${keep ? `<button class="pa-allow primary" data-mode="${esc(cur)}" data-keep="1">${t("批准，按当前模式执行（{m}）", { m: esc(modeLabel(cur)) })}</button>` : ""}
      <button class="pa-allow${keep ? "" : " primary"}" data-mode="default">${t("批准，逐项确认执行")}</button>
      <button class="pa-allow" data-mode="acceptEdits">${t("批准，自动接受编辑")}</button>
      <button class="pa-more">${t("再改改 ▾")}</button>`;
    }
    if (p.tool === "AskUserQuestion") return `
      <button class="pa-answer primary">${t("提交回答")}</button>
      <button class="pa-more">${t("不回答 ▾")}</button>`;
    const rules = permRules(p);
    return `
      <button class="pa-allow primary">${t("允许")}</button>
      ${rules.length ? `<button class="pa-always" title="${esc(rules.join("\n"))}">${t("始终允许")} <code>${esc(rules[0].length > 40 ? rules[0].slice(0, 40) + "…" : rules[0])}</code></button>` : ""}
      ${permSuggestsEdits(p) ? `<button class="pa-allow" data-mode="acceptEdits">${t("允许，之后的编辑都不再问")}</button>` : ""}
      <button class="pa-more">${t("拒绝 ▾")}</button>`;
  }

  function PermCard(p, runId) {
    const el = document.createElement("div");
    el.className = p.guard ? "perm guard" : "perm";
    el.dataset.id = p.id;
    const kind = p.tool === "ExitPlanMode" ? t("计划待批准") : p.tool === "AskUserQuestion" ? t("Claude 想问你") : p.guard ? t("敏感操作") : t("需要确认");
    el.innerHTML = `
      <div class="perm-head"><span class="perm-kind">${uiI("pause")}${kind}</span><span class="perm-tool">${esc(p.tool)}</span>${p.agentId ? `<span class="perm-sub">${t("子代理")}</span>` : ""}</div>
      <div class="perm-body">${permPreview(p)}</div>
      <div class="perm-acts">${permActions(p, runId)}</div>
      <div class="perm-deny hidden">
        <textarea rows="2" placeholder="${p.tool === "ExitPlanMode" ? t("说说要怎么改（会发回给 Claude）") : t("可选：告诉 Claude 为什么 / 该怎么做")}"></textarea>
        <div class="perm-acts">
          <button class="pa-deny">${p.tool === "ExitPlanMode" ? t("发回意见") : p.tool === "UserConfig" ? t("撤销改动") : t("拒绝")}</button>
          <button class="pa-stop">${p.tool === "UserConfig" ? t("撤销并停止") : t("拒绝并停止")}</button>
        </div>
      </div>`;
    const tc = p.toolUseId && TOOL_CARDS.get(p.toolUseId);
    if (tc && tc.el && tc.el.isConnected) tc.el.after(el);
    else {
      const rv = runViews.get(runId);
      (rv ? rv.av.bubble : liveEl).appendChild(el);
    }
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || el.classList.contains("done")) return;
      if (b.classList.contains("pa-more")) {
        el.querySelector(".perm-deny").classList.toggle("hidden");
        el.querySelector(".perm-deny textarea").focus();
        return;
      }
      const msg = el.querySelector(".perm-deny textarea").value.trim();
      if (b.classList.contains("pa-allow")) return permAnswer(p.id, { behavior: "allow", mode: b.dataset.mode && (b.dataset.keep || b.dataset.mode !== runMode(runId)) ? b.dataset.mode : undefined });
      if (b.classList.contains("pa-always")) return permAnswer(p.id, { behavior: "allow", always: true });
      if (b.classList.contains("pa-deny")) return permAnswer(p.id, { behavior: "deny", message: msg });
      if (b.classList.contains("pa-stop")) return permAnswer(p.id, { behavior: "deny", message: msg, interrupt: true });
      if (b.classList.contains("pa-answer")) {
        const answers = {};
        el.querySelectorAll(".perm-q").forEach((qe) => {
          const q = (p.input.questions || [])[+qe.dataset.q];
          const other = qe.querySelector(".perm-other").value.trim();
          const picked = [...qe.querySelectorAll("input:checked")].map((x) => x.value);
          const v = other || picked.join(", ");
          if (q && v) answers[q.question] = v;
        });
        if (!Object.keys(answers).length) return toast(t("先选一个选项，或者写下你的回答"), true);
        return permAnswer(p.id, { behavior: "allow", answers });
      }
    });
    return el;
  }

  // 模式在卡片等着的时候变了（设置里切、别的会话切）：还没答的计划卡按新模式重排按钮，别留着过期的「按当前模式」
  function refreshPlanActs() {
    for (const it of PERMS.values()) {
      if (it.done || !it.el || it.p.tool !== "ExitPlanMode") continue;
      const acts = it.el.querySelector(".perm-acts"), html = permActions(it.p, it.runId);
      if (acts && acts.dataset.html !== html) { acts.innerHTML = html; acts.dataset.html = html; }
    }
  }

  async function permAnswer(id, body) {
    const it = PERMS.get(id);
    if (!it || it.done) return;
    it.el?.classList.add("busy");
    try {
      await api("/api/perm/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: it.runId, id, ...body }) });
      permDone(id, body.behavior, { always: body.always, interrupt: body.interrupt });
    } catch (e) {
      it.el?.classList.remove("busy");
      if (e.status === 409) permDone(id, "gone");
      else toast(e.message, true);
    }
  }

  function permDone(id, behavior, o = {}) {
    const it = PERMS.get(id);
    if (!it || it.done) return;
    it.done = true;
    const p = it.p;
    const what = p.tool === "Bash" ? (p.input.command || "") : (p.input.file_path || p.input.url || p.input.query || "");
    const label = p.tool === "UserConfig" && behavior === "allow" ? t("✓ 已保留")
      : p.tool === "UserConfig" && behavior === "deny" ? (o.interrupt ? t("↩ 已撤销并停止") : t("↩ 已撤销"))
      : behavior === "allow"
      ? (p.tool === "ExitPlanMode" ? t("✓ 已批准计划") : p.tool === "AskUserQuestion" ? t("✓ 已回答") : o.always ? t("✓ 已允许（始终）") : t("✓ 已允许"))
      : behavior === "deny" ? (o.expired ? t("超时") : o.interrupt ? t("✗ 已拒绝并停止") : p.tool === "ExitPlanMode" ? t("↩ 已退回修改") : t("✗ 已拒绝"))
      : behavior === "cancel" ? t("已撤回") : behavior === "stopped" ? t("已停止（这一轮结束了）") : t("已失效");
    const tc = p.toolUseId && TOOL_CARDS.get(p.toolUseId);
    if (it.el && tc && tc.el && tc.el.isConnected && p.tool !== "ExitPlanMode" && p.tool !== "AskUserQuestion") {
      const tag = document.createElement("span");
      tag.className = "perm-tag " + (behavior === "allow" ? "ok" : "no");
      tag.textContent = label;
      tc.el.querySelector(".tool-state")?.before(tag);
      it.el.remove();
      it.el = null;
      PERMS.delete(id);          // 卡已经并进工具卡的小标签，这条记录没用了（#95 01-007）
    } else if (it.el && !it.el.isConnected) {
      // 切走时卡片随旧视图一起拿掉了，这一轮又在后台结束：记录本身也放掉，游离 DOM / 工具入参 / 表单值不再留到页面重载（FIND-007）
      PERMS.delete(id);
    } else if (it.el) {
      it.el.classList.remove("busy");
      it.el.classList.add("done", behavior === "allow" ? "ok" : "no");
      // 收起成一行，留在记录里；计划和问答的正文还有用，留着
      if (p.tool !== "ExitPlanMode" && p.tool !== "AskUserQuestion") it.el.querySelector(".perm-body").remove();
      it.el.querySelectorAll(".perm-acts, .perm-deny").forEach((x) => x.remove());
      it.el.querySelectorAll("input").forEach((x) => { x.disabled = true; });
      it.el.querySelector(".perm-head").innerHTML = `<span class="perm-res">${label}</span><span class="perm-tool">${esc(p.tool)}</span><span class="tool-arg">${esc(String(what).slice(0, 90))}</span>`;
    }
    renderPermBar();
  }

  // 卡片里已经勾的、写的（选择题的选项和补充回答、拒绝理由）：随请求记在 PERMS 里，切会话 / 重连后重建卡片时填回去（#175-3）
  function permFormRead(el) {
    const deny = el.querySelector(".perm-deny");
    return { ck: [...el.querySelectorAll(".perm-body input[type=checkbox], .perm-body input[type=radio]")].map((x) => x.checked),
      ot: [...el.querySelectorAll(".perm-other")].map((x) => x.value), deny: deny.querySelector("textarea").value, open: !deny.classList.contains("hidden") };
  }
  function permFormRestore(el, f) {
    el.querySelectorAll(".perm-body input[type=checkbox], .perm-body input[type=radio]").forEach((x, i) => { if (f.ck[i] != null) x.checked = f.ck[i]; });
    el.querySelectorAll(".perm-other").forEach((x, i) => { if (f.ot[i] != null) x.value = f.ot[i]; });
    el.querySelector(".perm-deny textarea").value = f.deny || "";
    el.querySelector(".perm-deny").classList.toggle("hidden", !f.open);
  }
  function onPermRequest(ev) {
    const old = PERMS.get(ev.id);
    if (old && old.el && old.el.isConnected) return;      // 重放来的重复事件
    // 缺 input 的事件：preview、权限条、提问卡都会读 p.input.*，以前一处抛错就整张卡 busy 卡死（0.6.9 审计 196-前端注入.1）
    if (!ev.input || typeof ev.input !== "object" || Array.isArray(ev.input)) ev = Object.assign({}, ev, { input: {} });
    const it = { p: ev, runId: ev.runId, el: null, done: false, form: old && old.form };
    PERMS.set(ev.id, it);
    it.el = PermCard(ev, ev.runId);
    if (it.form) permFormRestore(it.el, it.form);
    const keep = () => { it.form = permFormRead(it.el); };
    it.el.addEventListener("input", keep); it.el.addEventListener("change", keep);
    it.el.addEventListener("click", (e) => { if (e.target.closest(".pa-more")) keep(); });
    renderPermBar();
    scrollDown();
    askNotice([{ id: ev.id, runId: ev.runId }]);
  }

  /** 整页盖着对话时有新的确认请求：权限条和状态栏都被盖住了，弹一条带「查看」的提示，别让这一轮无声等着（#175-1）。
   *  每个请求只提醒一次；点「查看」收起整页，是别的会话的就打开那个会话 */
  const ASK_SEEN = new Set();
  // 聊天区此刻是否被设置 / 查看器 / 文件 / 终端 / 整页盖着（0.6.9 审计 195-B.2）：
  // 盖着时权限条和状态栏都看不见，必须弹提示；只认 curPage 的话设置层盖着就不弹了
  const COVER_IDS = ["set-ov", "viewer", "files", "term", "git", "lightbox", "term-textview", "pages"];
  // typeof 守卫：perm-visible-175 的测试单独切这一段出来跑，那里没有 $ / DOM
  const chatCovered = () => typeof $ === "function" && COVER_IDS.some((id) => { const el = $(id); return el && !el.classList.contains("hidden"); });
  function revealChat() {
    // 逐层收（返回键同一套顺序）：查看器有未保存修改时会先问，那是用户该回答的
    for (let n = 0; n < 8 && chatCovered(); n++) if (!window.__ccBack || !window.__ccBack()) break;
  }
  function askNotice(list) {
    let first = null;
    for (const x of list) { if (ASK_SEEN.has(x.id)) continue; first = first || x; }
    if (ASK_SEEN.size > 500) for (const id of [...ASK_SEEN].slice(0, 250)) ASK_SEEN.delete(id);
    if (!first || !(curPage || chatCovered())) return;
    // 一次只登记这一条：以前把同批全部记成「已提醒」，后面的卡再也不弹（0.6.9 审计 195-B.8）
    ASK_SEEN.add(first.id);
    const r = srv.runs.find((y) => y.id === first.runId);
    toastAct(t("Claude 在等你确认"), t("查看"), () => {
      if (r && r.sessionId && r.sessionId !== view.sessionId) { revealChat(); return openSession(r.sessionId); }
      revealChat();
    });
  }

  function pendingPerms() {
    return [...PERMS.values()].filter((it) => !it.done && runViews.has(it.runId));
  }
  // ── 输入框上方的状态带：/goal 目标进度 + 后台任务 ──
  const runStrip = $("run-strip");
  let goalTick = null;
  const BG_KIND = (k) => /agent/i.test(k) ? t("子代理") : /workflow/i.test(k) ? t("工作流") : /monitor/i.test(k) ? t("监视") : /bash|shell/i.test(k) ? t("命令") : k || "?";
  // 任务清单：折叠时一行（进度 + 正在做的那项），点开看全部；全部完成可 ✕ 收起
  let tasksOpen = localStorage.getItem("cc.tasksOpen") === "1";
  let bgOpen = localStorage.getItem("cc.bgOpen") === "1";
  // 收起记的是这份清单有哪些项（编号集合），不含进度：同一份清单接着做不再冒出来，换了一份（增删了项）才重新露出来。
  // 旧版记的是「编号:状态」，照样认
  const tasksSig = (l) => "ids:" + l.map((x) => x.id).join(",");
  const tasksSigOld = (l) => l.map((x) => x.id + ":" + x.status).join(",");
  const taskLabel = (x) => esc(x.status === "in_progress" && x.active ? x.active : x.subject);
  // more：清单收起时被一并收起的目标 / 后台任务条数，标在清单那一行末尾
  function tasksHtml(more) {
    const l = view.tasks;
    if (!l || !l.length) return "";
    const done = l.filter((x) => x.status === "completed").length, all = done === l.length;
    // 什么时候都能 ✕ 收起：没做完的、会话又跑起来的也一样（群友 11-05；以前在跑时不给 ✕，继续会话后清单冒出来就叉不掉了）
    if (view.tasksHide && (view.tasksHide === tasksSig(l) || view.tasksHide === tasksSigOld(l))) return "";
    const cur = l.find((x) => x.status === "in_progress") || l.find((x) => x.status !== "completed");
    const pct = Math.round(done / l.length * 100);
    const head = `<div class="rs-row rs-thead" role="button" tabindex="0" aria-expanded="${tasksOpen}">
      <span class="rs-ico">${uiI(all ? "check" : "list")}</span>
      <span class="rs-tcount">${all ? t("清单完成") : t("清单")} ${done}/${l.length}</span>
      <span class="rs-tbar"><i style="width:${pct}%"></i></span>
      <span class="rs-txt">${!tasksOpen && cur ? taskLabel(cur) : ""}</span>
      ${more ? `<span class="rs-meta">${t("另有 {n} 项", { n: more })}</span>` : ""}
      ${all ? "" : `<span class="rs-chev${tasksOpen ? " up" : ""}">${uiI("chevDown")}</span>`}<button class="rs-tx" aria-label="${t("关闭")}">${uiI("x")}</button></div>`;
    const rows = !tasksOpen ? "" : `<div class="rs-tlist">${l.map((x) => `<div class="rs-trow ${esc(x.status)}">
      <span class="rs-tico">${uiI(x.status === "completed" ? "check" : x.status === "in_progress" ? "half" : "ring")}</span>
      <span class="rs-ttxt">${taskLabel(x)}</span>
      ${x.blocked && x.status !== "completed" ? `<span class="rs-meta">${t("等 {ids}", { ids: x.blocked.map((b) => "#" + esc(b)).join(" ") })}</span>` : ""}</div>`).join("")}</div>`;
    return `<div class="rs-tasks${all ? " ok" : ""}">${head}${rows}</div>`;
  }
  function renderRunStrip() {
    const g = view.goal && !(view.goal.done && view.goal.at <= view.goalHide) ? view.goal : null;
    const bg = (srv.run && srv.run.bgList) || [];
    // 清单的折叠管整条：收起时目标、后台任务（包括不能单独折叠的单个任务）一起收起，展开再全露出来
    let html = "";
    if (g && g.active) {
      const el = g.setAt ? fmtDur(Date.now() - g.setAt) : "";
      html += `<div class="rs-goal"><div class="rs-row"><span class="rs-ico">${uiI("target")}</span>
        <span class="rs-txt">${t("目标")} · ${esc(g.condition)}</span>
        <span class="rs-meta">${g.checks ? t("已检查 {n} 次", { n: +g.checks || 0 }) : ""}${g.checks && el ? " · " : ""}${el ? `<span class="rs-el" aria-hidden="true">${t("已用 {d}", { d: el })}</span>` : ""}</span>
        <button class="rs-goal-stop">${t("放弃")}</button></div>
        ${g.reason ? `<div class="rs-sub">${t("还差：")}${esc(g.reason)}</div>` : ""}</div>`;
    } else if (g && g.done) {
      const bits = [g.iterations != null ? t("{n} 轮", { n: +g.iterations || 0 }) : "", g.durationMs != null ? fmtDur(+g.durationMs || 0) : "", g.tokens != null ? (+g.tokens || 0).toLocaleString() + " tokens" : ""].filter(Boolean).join(" · ");
      html += `<div class="rs-goal ${g.met ? "ok" : "bad"}"><div class="rs-row"><span class="rs-ico">${uiI(g.met ? "check" : "x")}</span>
        <span class="rs-txt">${g.met ? t("目标达成") : t("目标无法达成")} · ${esc(g.condition)}</span>
        <span class="rs-meta">${g.met ? bits : ""}</span><button class="rs-x" aria-label="${t("关闭")}">${uiI("x")}</button></div>
        ${!g.met && g.reason ? `<div class="rs-sub">${esc(g.reason)}</div>` : ""}</div>`;
    }
    if (bg.length) {
      // 后台任务：只有一个时直接一行带「停止」；多个时默认折成一行（数量 + 最新那个），点开看全部，列表过长自己滚
      const row = (x) => `<div class="rs-row rs-bg"><span class="rs-kind">${esc(BG_KIND(x.type))}</span>
        <span class="rs-txt">${esc(x.desc || x.id)}</span><button class="rs-stop" data-task="${esc(x.id)}">${t("停止")}</button></div>`;
      if (bg.length === 1) html += `<div class="rs-bgs">${row(bg[0])}</div>`;
      else {
        const last = bg[bg.length - 1];
        html += `<div class="rs-bgs"><div class="rs-row rs-bhead" role="button" tabindex="0" aria-expanded="${bgOpen}">
          <span class="rs-ico">${uiI("hourglass")}</span><span class="rs-tcount">${t("后台在跑 {n} 个", { n: bg.length })}</span>
          <span class="rs-txt">${bgOpen ? "" : esc(last.desc || last.id)}</span>
          <span class="rs-chev${bgOpen ? " up" : ""}">${uiI("chevDown")}</span></div>
          ${bgOpen ? `<div class="rs-blist">${bg.map(row).join("")}</div>` : ""}</div>`;
      }
    }
    const tasksShown = !!tasksHtml(0), fold = tasksShown && !tasksOpen;
    const more = fold ? (g ? 1 : 0) + bg.length : 0;
    html = tasksHtml(more) + (fold ? "" : html);
    // 目标计时每秒重画整条：展开的清单、后台任务列表滚到哪儿要接着留在哪儿（审查 #48 UI07-04）
    // 只有计时变了：只改那一格的字（它不进读屏），别整条重写 —— 整条在 role=status 里，读屏会每秒念一遍（审查 #49 待确认-5）
    const key = html.replace(/<span class="rs-el"[^>]*>[^<]*<\/span>/, "");
    const elx = runStrip.querySelector(".rs-el"), elm = html.match(/<span class="rs-el"[^>]*>([^<]*)<\/span>/);
    if (key === runStrip._key && elx && elm) {
      // 那一格是转义过的字：用惰性 template 还原成纯文本再写 textContent，不经 innerHTML（审查 v0.5.4 F-L3）
      const tp = document.createElement("template"); tp.innerHTML = elm[1];
      const txt = tp.content.textContent;
      if (elx.textContent !== txt) elx.textContent = txt;
    }
    else if (html !== runStrip._html) {
      runStrip._key = key;
      const tl = runStrip.querySelector(".rs-tlist"), bl = runStrip.querySelector(".rs-blist"), ty = tl ? tl.scrollTop : 0, by = bl ? bl.scrollTop : 0;
      runStrip.innerHTML = html; runStrip._html = html;
      if (ty) { const x = runStrip.querySelector(".rs-tlist"); if (x) x.scrollTop = ty; }
      if (by) { const x = runStrip.querySelector(".rs-blist"); if (x) x.scrollTop = by; }
    }
    runStrip.classList.toggle("hidden", !html);
    // 目标进行中：每秒刷新「已用」；别的情况停掉
    if (g && g.active && g.setAt) { if (!goalTick) goalTick = setInterval(renderRunStrip, 1000); }
    else if (goalTick) { clearInterval(goalTick); goalTick = null; }
  }
  // 点 ✕ 收起的清单 / 目标记录按会话记在 localStorage，重开 App 不再冒出来（只留最近 50 个会话）
  function stripHidden() { try { return JSON.parse(localStorage.getItem("cc.stripHide") || "{}"); } catch { return {}; } }
  function saveStripHidden() {
    if (!view.sessionId) return;
    const m = stripHidden();
    delete m[view.sessionId];
    m[view.sessionId] = { t: view.tasksHide, g: view.goalHide };
    const ks = Object.keys(m);
    for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete m[k];
    try { localStorage.setItem("cc.stripHide", JSON.stringify(m)); } catch {}
  }
  runStrip.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && b.classList.contains("rs-tx")) { view.tasksHide = tasksSig(view.tasks || []); saveStripHidden(); renderRunStrip(); return; }
    if (!b && e.target.closest(".rs-bhead")) { bgOpen = !bgOpen; localStorage.setItem("cc.bgOpen", bgOpen ? "1" : "0"); renderRunStrip(); return; }
    if (!b && e.target.closest(".rs-thead")) { tasksOpen = !tasksOpen; localStorage.setItem("cc.tasksOpen", tasksOpen ? "1" : "0"); renderRunStrip(); return; }
    if (!b) return;
    if (b.classList.contains("rs-x")) { view.goalHide = view.goal?.at || Date.now(); saveStripHidden(); renderRunStrip(); return; }
    if (b.classList.contains("rs-goal-stop")) {
      // 目标进行中那一轮会一直跑下去，排队的 /goal clear 轮不到：先停这一轮，收尾后再发（见 onRunEnd）
      if (srv.run && !srv.run.idle && isBusy()) {
        view.goalClearAfter = { runId: srv.run.id, sid: view.sessionId };   // 点的时候就记下是哪个会话（审查 #52 P2-15）
        b.disabled = true;
        api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: srv.run.id }) }).catch(() => {});
      } else send("/goal clear");
      return;
    }
    if (b.classList.contains("rs-stop") && srv.run) {
      // 输入已关时停不了单个任务，只能整轮结束：不止一个就先说清楚
      if (srv.run.sealed && srv.run.bg > 1 && !confirm(t("这一轮已经收不进指令，只能把 {n} 个后台任务一起停掉。继续？", { n: srv.run.bg }))) return;
      b.disabled = true;
      api("/api/task/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: srv.run.id, taskId: b.dataset.task }) })
        .catch((err) => { b.disabled = false; toast(err.message, true); });
    }
  });

  function renderPermBar() {
    const list = pendingPerms();
    permBar.classList.toggle("hidden", !list.length && !state.settings.permNotice);
    if (!list.length) {
      permBar.innerHTML = state.settings.permNotice ? `
        <div class="pb-note"><span>${t("权限模式已改为「逐项确认」，与官方一致：改文件、跑命令前会先问你。想恢复全部放行，点下方的权限标签。")}</span>
        <button class="pb-x" aria-label="${t("关闭")}">${uiI("x")}</button></div>` : "";
      if (permWaiting && isBusy()) setStatus(t("生成中…"), "live");
      permWaiting = false;
      return;
    }
    // 敏感卡（guard）不能当成 simple、不进「全部允许」（0.6.9 审计 195-B.3）。但全部放行模式下弹出来的只剩敏感卡，
    // 底部条一个「允许」都没有（用户 11-09）：单个敏感卡带上卡片同一句风险说明再给「允许」；
    // 用户级配置 / 项目配置两种的选项不是允许拒绝（保留撤销、记住），仍只给「查看」
    const f = list[0].p, simple = (it) => !it.p.guard && it.p.tool !== "ExitPlanMode" && it.p.tool !== "AskUserQuestion";
    const quick = (it) => simple(it) || (!!it.p.guard && it.p.tool !== "ExitPlanMode" && it.p.tool !== "AskUserQuestion" && it.p.guard.cat !== "userconf" && it.p.guard.cat !== "project");
    const what = f.tool === "Bash" ? f.input.command : (f.input.file_path || f.input.url || f.input.query || "");
    permBar.innerHTML = `
      <div class="pb-main">
        ${list.length > 1 ? `<span class="pb-n">${t("第 {i}/{n} 个", { i: 1, n: list.length })}</span>` : ""}
        <span class="pb-txt${f.guard ? " wrap" : ""}">${uiI("pause")}${f.tool === "ExitPlanMode" ? t("计划待批准") : f.tool === "AskUserQuestion" ? t("Claude 想问你") : t("Claude 在等你确认") + " · "}${simple(list[0]) ? `<b>${esc(f.tool)}</b> <span class="mono">${esc(String(what || "").slice(0, 80))}</span>`
          : quick(list[0]) ? `<b>${t("敏感操作")}</b> ${esc(permGuardWhat(f.guard, f.input))}` : ""}</span>
        ${quick(list[0]) ? `<button class="pb-allow primary" data-id="${esc(String(f.id))}">${t("允许")}</button>` : ""}
        <button class="pb-view">${t("查看")}</button>
      </div>
      ${list.length > 1 ? `<div class="pb-more">${t("还有 {n} 项", { n: list.length - 1 })}
        ${list.every(simple) ? `<button class="pb-all">${t("全部允许")}</button>` : ""}</div>` : ""}`;
    setStatus(t("等你确认…"), "warn");
    permWaiting = true;
  }
  permBar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("pb-x")) {
      state.settings.permNotice = false;
      renderPermBar();
      api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permNotice: false }) }).catch(() => {});
      return;
    }
    const list = pendingPerms();
    if (!list.length) return;
    if (b.classList.contains("pb-view")) {
      const show = (el) => el?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (!backToLatest()) return show(list[0].el);
      // 正看着旧章节 / 书签那一段时 #live 整个藏着，卡在里面滚不过去：先回到最新，等重放把卡重新画出来再滚过去（#142-2）
      const id = list[0].p.id, t0 = Date.now();
      const wait = () => {
        const all = pendingPerms(), it = all.find((x) => x.p.id === id) || all[0];
        if (it?.el?.isConnected && it.el.offsetParent) return show(it.el);
        if (Date.now() - t0 < 6000) setTimeout(wait, 150);
      };
      setTimeout(wait, 150);
      return;
    }
    // 只放条上显示的那一张：渲染后列表变了（新来一张排到前面）也不会顺手放掉没看到的卡
    if (b.classList.contains("pb-allow")) { const it = list.find((x) => String(x.p.id) === b.dataset.id); return it ? permAnswer(it.p.id, { behavior: "allow" }) : renderPermBar(); }
    if (b.classList.contains("pb-all")) list.forEach((it) => permAnswer(it.p.id, { behavior: "allow" }));
  });

  // 顶栏（输入框下）的权限标签：点开切模式，对应官方 TUI 的 Shift+Tab
  // 能 Tab 到就要能用 Enter / 空格打开（审查 #48 03-F06）
  permEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); permEl.click(); } });
  permEl.addEventListener("click", () => {
    if (OV.at(permEl)) return OV.close(OV.at(permEl));
    const m = document.createElement("div");
    m.id = "perm-menu";
    const desc = {
      default: t("读文件不问；改文件、跑命令、联网前先问你"),
      acceptEdits: t("改文件不问，跑命令还要问"),
      plan: t("只读和出计划，等你批准再动手"),
      auto: t("由 Claude 的分类器判断哪些要问（实验）"),
      bypassPermissions: t("什么都不问。Claude 可以不经你同意删文件、跑任意命令"),
    };
    m.innerHTML = MODE_KEYS.map((k) => `
      <button data-mode="${k}" class="${k === state.permissionMode ? "cur" : ""}${k === "bypassPermissions" ? " danger" : ""}">
        <b>${modeLabel(k)}</b><small>${desc[k]}</small></button>`).join("");
    OV.open(m, { anchor: permEl });
    const r = permEl.getBoundingClientRect(), col = colRect(), mw = Math.min(m.offsetWidth, col.width - 16);
    m.style.maxWidth = (col.width - 16) + "px";
    m.style.bottom = (fixedH() - r.top + 6) + "px";
    m.style.maxHeight = Math.max(120, r.top - 14) + "px";   // 矮屏：上面放不下就限高自己滚
    // 标签在右半边就右对齐；不出对话这一栏（右边可能是浏览器窗格）
    const x0 = r.left + r.width / 2 > col.left + col.width / 2 ? r.right - mw : r.left;
    m.style.left = Math.max(col.left + 8, Math.min(x0, col.right - mw - 8)) + "px";
    m.addEventListener("click", async (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      OV.close(m);
      changePermMode(b.dataset.mode);
    });
  });

  async function changePermMode(mode) {
    // 不能只看标签一样就不发：标签可能是旧的（重放过旧事件），用户要收紧时必须真送到网关（安全通告 GHSA-2w6p）
    if (!mode || (mode === state.permissionMode && mode === "bypassPermissions")) return;
    if (mode === "bypassPermissions" && !confirm(t("切到「全部放行」？\n\nClaude 将不再询问，可以直接改写、删除文件，运行任意命令，访问网络。只在你信任当前任务、且出了事能承受的时候用。"))) {
      // 取消：下拉框回到全局设置，不能被 chip 的运行模式带跑（0.6.9 审计 195-B.9）
      $("set-perm").value = state.settings.permissionMode || state.permissionMode;
      return;
    }
    try {
      const r = await api("/api/perm/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      // 网关回的是实际生效的 mode（安全模式下会自动退回 default）和用户选的 wanted（0.6.9 审计 195-A.6 / P1-12）
      const eff = r.mode || r.wanted || mode;
      state.settings.permissionMode = r.wanted || r.mode || mode;   // 全局设置记用户选的；chip / 下拉显示实际生效的
      setPermChip(eff);
      $("set-perm").value = eff;
      for (const x of srv.runs) if (x.permMode) x.permMode = eff;   // 同 perm_mode 事件：等着的计划卡跟着重排（#175-2）
      refreshPlanActs();
      if (eff !== mode) toast(t("安全模式下不问人的几档不生效，现在是「逐项确认」"));
      else if (r.saved === false) toast(t("设置没保存上，重启后会回到原来的权限模式"), true);
      else toast(r.live ? t("已切到「{m}」，这一轮当场生效", { m: modeLabel(eff) }) : t("已切到「{m}」", { m: modeLabel(eff) }));
    } catch (err) {
      // 保存失败：下拉框回到全局设置，别停在新值让人以为切了（0.6.9 审计 196-显示.1）
      $("set-perm").value = state.settings.permissionMode || state.permissionMode;
      toast(err.message, true);
    }
  }

  // 回复底下的「复制 / 转发」：只取正文（Markdown 原文，多段之间空一行），思考和工具调用不算。
  // 转发走外壳的系统分享面板（CCApp.shareText）；外壳没有这个接口时退回 Web Share，都没有就复制并说明。
  // 提问和回复底下一律四个键（提问：复制 / 重发 / 回退 / 删除；回复：复制 / 转发 / 分叉 / 删除），别因为环境不同少一个
  function replyActs(msgEl, getText) {
    if (msgEl.querySelector(":scope > .msg-acts")) return;
    // 没有正文（只跑了工具就被中断）也要能删，以前整排按钮不出、这条回复删不掉；复制 / 转发 / 分叉 / 书签只给有正文的
    const hasText = !!getText(), sys = msgEl.classList.contains("sys");
    if (!hasText && sys) return;
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = (hasText ? actBtn("copy", t("复制")) + actBtn("share", t("转发")) : "") +
      (sys ? "" : (hasText ? actBtn("fork", t("从这里分叉")) + actBtn("mark", t("书签")) : "") + actBtn("del", t("删除")));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a, text = getText();
      if (a === "copy") copyText(text).then((ok) => toast(ok ? t("已复制") : t("复制失败"), !ok));
      if (a === "share") {
        if (window.CCApp && CCApp.shareText) CCApp.shareText(text);
        else if (navigator.share) navigator.share({ text }).catch(() => {});
        else copyText(text).then((ok) => toast(ok ? t("这里没有系统分享，已复制到剪贴板") : t("复制失败"), !ok));
      }
      if (a === "fork") forkFrom(msgEl);
      if (a === "mark") toggleMark(msgEl);
      if (a === "del") deleteMsg(msgEl, "bot");
    });
    msgEl.appendChild(acts);
  }

  // 删一条消息：提问只删这一条；回复删整条（连同它的工具调用和结果）。改的是会话记录本身，Claude 下一轮就看不到了。
  // 删完直接从界面上拿掉（不重载，滚动位置不跳）；提示条上能撤销最近一次
  async function deleteMsg(msgEl, which) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再删"), true);
    if (isBusy()) return toast(t("正在生成，等它答完再删"), true);
    // 提问已经删掉的回复：它在记录里和上一轮的回复连在一起，分不开了，不能再按「前面最近的提问」反推（那会把上一轮的回复一起删掉，审查 B04）
    if (which !== "user" && msgEl.dataset.orphan) return toast(t("这条回复的提问已经删掉了，没法再单独删它。撤销刚才的删除，或者先删回复再删提问。"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    let turn = which === "user" ? msgEl : null;
    if (!turn) for (const u of users) if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) turn = u;
    const after = users.length - 1 - users.indexOf(turn);
    if (!turn) return toast(t("这条回复前面没有你的消息，没法单独删"), true);
    // 记录是原地重写的，删点之后的字节偏移都会挪：把手里的游标交给网关一起换算（#153-1）
    const pages = [...histPages()], gen = view.gen;
    const offs = [view.next, view.cursor, ...pages.flatMap((p) => [p.dataset.from, p.dataset.to])].filter((x) => x != null && x !== "").map(Number);
    if (!confirm(which === "user" ? t("删掉这条提问？Claude 之后就看不到它了（它的回复保留）。") : t("删掉这条回复？连同它的工具调用和结果一起删，Claude 之后就看不到了。"))) return;
    try {
      const r = await api("/api/session/" + encodeURIComponent(sid) + "/delmsg", {
        method: "POST", headers: { "content-type": "application/json" },
        // 回复自己的 uuid 一起带上：网关核对它确实在要删的那一轮里，对不上就拒绝，绝不删错
        body: JSON.stringify({ userText: userTextOf.get(turn), after, which, uuid: turn.dataset.uuid || "",
          replyUuid: which === "user" ? "" : (msgEl.querySelector("[data-uuid]")?.dataset.uuid || ""), offs }),
      });
      // 回执到时已经切走（或重连重画过）：眼前的节点不是那个会话的，什么都别改，只说删好了（#174-3）
      const here = gen === view.gen;
      if (here && r.moved) {
        const mv = (x) => (x == null || x === "" ? x : r.moved[Number(x)] ?? Number(x));
        view.next = view.next == null ? null : mv(view.next) < r.size ? mv(view.next) : null;
        if (view.cursor != null) view.cursor = mv(view.cursor);
        for (const p of pages) { if (p.dataset.from !== undefined) p.dataset.from = mv(p.dataset.from); if (p.dataset.to !== undefined) p.dataset.to = mv(p.dataset.to); }
      }
      if (here && which === "user") {
        // 它后面那几条回复（到下一条提问为止）成了没有提问的回复：标上，之后不许单独删
        const all = [...chatEl.querySelectorAll(".msg")];
        for (const m of all.slice(all.indexOf(msgEl) + 1)) { if (m.classList.contains("user")) break; if (m.classList.contains("bot")) m.dataset.orphan = "1"; }
        userTextOf.delete(msgEl); msgEl.remove();
      } else if (here) msgEl.remove();
      toastAct(here ? t("已删除") : t("已在原来那个会话里删除"), t("撤销"), async () => {
        try {
          await api("/api/session/" + encodeURIComponent(sid) + "/undodel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ undo: r.undo }) });
          if (view.sessionId === sid) openSession(sid);
          toast(t("已恢复"));
        } catch (e) { toast(e.message, true); }
      });
    } catch (e) { toast(e.message, true); }
  }

  // 分叉：保留到这条回复为止的对话，另起一个会话接着聊；原会话不动。
  // 告诉网关这一轮的用户消息原文、以及它后面还有几条用户消息，网关据此在 transcript 里定位（见 server.mjs forkSession）
  async function forkFrom(msgEl) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再分叉"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    let prev = null, after = 0;
    for (const u of users) {
      if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) prev = u; else after++;
    }
    if (!prev) return toast(t("这条回复前面没有你的消息，没法从这里分叉"), true);
    try {
      const r = await api("/api/session/" + encodeURIComponent(sid) + "/fork", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: userTextOf.get(prev), after, uuid: prev.dataset.uuid || "" }),
      });
      loadSessions();
      // 等回执的工夫切到了别的会话：别把人从那边拉走，给个入口（#174-4）。按会话号认：重连也会让 gen 变
      if (view.sessionId !== sid) return toastAct(t("已分叉：保留了前 {n} 轮，接着聊就行", { n: r.kept }), t("打开"), () => openSession(r.id));
      openSession(r.id);
      toast(t("已分叉：保留了前 {n} 轮，接着聊就行", { n: r.kept }));
    } catch (e) { toast(e.message, true); }
  }

  // 回退到某条用户消息之前：先试算会撤销哪些文件，再选「只撤代码」或「代码 + 对话」。
  // 对话那半边和分叉一样另起一个会话（截到这条之前，原文放回输入框），原会话不动
  async function rewindTo(msgEl) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再回退"), true);
    if (isBusy()) return toast(t("正在生成，等它答完再回退"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    const idx = users.indexOf(msgEl);
    if (idx < 0) return;
    const userText = userTextOf.get(msgEl), after = users.length - 1 - idx;
    const post = (extra) => api("/api/session/" + encodeURIComponent(sid) + "/rewind", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText, after, uuid: msgEl.dataset.uuid || "", ...extra }),
    });
    toast(t("正在查这之后改过哪些文件…"));
    let d;
    try { d = await post({ dryRun: true }); } catch (e) { return toast(e.message, true); }
    // 试算回来时已经切到别的会话：确认框列的是原来那个会话的文件，不弹在这边（#174-4）
    if (view.sessionId !== sid) return toast(t("已切换会话，这次回退没有执行"));
    const choice = await rewindDialog(d);
    if (!choice) return;
    try {
      const r = await post({ conversation: choice === "both" });
      const n = r.files && r.files.canRewind && r.files.files ? r.files.files.length : 0;
      if (choice === "both" && view.sessionId !== sid) {
        // 回执到之前切走了：不把人拉过去，也不往别的输入框里填原文
        loadSessions();
        if (r.fork && !r.fork.fresh) return toastAct(t("对话回到了这条消息之前，原会话还在"), t("打开"), () => openSession(r.fork.id));
        return toast(t("对话回到了这条消息之前，原会话还在"));
      }
      if (choice === "both") {
        if (r.fork && r.fork.fresh) newConversation(); else { openSession(r.fork.id); loadSessions(); }
        // 原文只回填到这次打开的目标：300ms 里用户已经切到别的会话，就记进目标会话的草稿，不覆盖眼前那个会话的输入框（#153-2）。
        // 按会话号认，不按 view.gen：打开后 hello 一到 resetView 就会把 gen 加一，正常路径也会被当成「切走了」（审查 11-05 #40）
        const key = view.sessionId || "";
        setTimeout(() => {
          if ((view.sessionId || "") === key) { inputEl.value = userText; autoGrow(); inputEl.focus(); return; }
          const all = draftsRead();
          if (all[key] && all[key].text && all[key].text.trim()) return;
          all[key] = { text: userText, att: (all[key] && all[key].att) || [], at: Date.now() };
          try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
        }, 300);
        toast(n ? t("已撤销 {n} 个文件的修改，对话回到了这条消息之前", { n }) : t("对话回到了这条消息之前，原会话还在"));
      } else toast(t("已撤销 {n} 个文件的修改", { n }));
    } catch (e) { toast(e.message, true); }
  }
  function rewindDialog(d) {
    return new Promise((resolve) => {
      const files = d.canRewind && d.files ? d.files : [];
      const ov = document.createElement("div");
      ov.className = "rw-ov";
      const list = files.slice(0, 8).map((f) => `<li title="${esc(f)}"><span class="mono">${esc(f.split("/").pop())}</span> <span class="rw-dir">${esc(f.replace(/\/[^/]*$/, ""))}</span></li>`).join("") +
        (files.length > 8 ? `<li>${esc(t("还有 {n} 个", { n: files.length - 8 }))}</li>` : "");
      const what = files.length
        ? `<p>${esc(t("会撤销 Claude 在这之后对 {n} 个文件的修改", { n: files.length }))} <span class="rw-stat">+${+d.insertions || 0} −${+d.deletions || 0}</span></p><ul class="rw-files">${list}</ul>`
        : `<p>${esc(d.canRewind ? t("这之后 Claude 没有用编辑工具改过文件。") : t("这之后的文件改动没有留底（这个版本之前的消息不支持），只能回退对话。"))}</p>`;
      ov.innerHTML = `<div class="rw-dlg" role="dialog" aria-modal="true" aria-labelledby="rw-title">
        <h3 id="rw-title">${esc(t("回退到这条消息之前"))}</h3>${what}
        <p class="rw-note">${esc(t("只撤销编辑工具（Edit / Write）做的修改；用命令改的文件、装的包不会还原。"))}</p>
        <div class="rw-acts">
          <button data-c="both" class="primary">${esc(files.length ? t("撤销代码，并回到这里重新提问") : t("回到这里重新提问"))}</button>
          ${files.length ? `<button data-c="code">${esc(t("只撤销代码"))}</button>` : ""}
          <button data-c="">${esc(t("取消"))}</button>
        </div>
        <p class="rw-note">${esc(t("回到这里会另开一个会话，原会话保留。"))}</p></div>`;
      const close = (c) => { resolve(c || null); OV.close(ov); };
      ov.addEventListener("click", (e) => {
        if (e.target === ov) return close(null);
        const b = e.target.closest("button[data-c]");
        if (b) close(b.dataset.c);
      });
      OV.open(ov, { kind: "modal", keep: true, cover: true, onClose: () => resolve(null) });   // 返回键 = 取消
    });
  }

  /** 一条 Claude 回复：思考 / 正文 / 工具按真实顺序交错排列 */
  function AssistantView(parent, live) {
    const bubble = mkMsg("bot", null, parent);
    const msgEl = bubble.parentElement;
    let dots = null;
    if (live) { bubble.innerHTML = DOTS; dots = bubble.firstChild; }
    const blocks = [];
    let last = null, any = false, ended = false;
    const undot = () => { if (dots) { dots.remove(); dots = null; } };
    // 生成中只在最末尾留一个光标 + 用时：每加一块就把它挪回气泡最后（工具卡跑着时也在）
    let liveTail = null, tailTime = null;
    if (live) {
      liveTail = document.createElement("div");
      liveTail.className = "live-tail";
      liveTail.innerHTML = '<span class="cursor"></span><span class="tail-time"></span>';
      tailTime = liveTail.lastChild;
    }
    // 进行到哪一步：三个点后面（还没出任何内容时）或末尾光标旁边的一行小字。
    // 连接中 / 已连上等待输出 / 重试 / 思考中 / 正在写工具参数；正文开始、工具开跑、答完就收起
    let ph = null, phEv = null, phT0 = 0, phIv = 0;
    const pendTools = new Set(), cardTools = new Set();
    const phText = () => {
      const ms = Date.now() - phT0, sec = ms >= 3000 ? " · " + fmtDur(ms) : "";
      switch (phEv.phase) {
        case "prep":    return t("准备中") + sec;
        case "boot":    return t("启动中，连接工具") + sec;
        case "connect": return t("连接中") + sec;
        case "wait":    return t("已连上，等待输出") + sec;
        // 出错原因第一次重试就写出来（手机上看不到悬停提示），不用等十次都失败（群反馈 11-06）
        case "retry": {
          const why = [phEv.status, phEv.error].filter(Boolean).join(" · ");
          return t("连接出错，第 {a}/{m} 次重试", { a: phEv.attempt || 1, m: phEv.max || "?" }) + (why ? "：" + (why.length > 120 ? why.slice(0, 120) + "…" : why) : "");
        }
        case "think":   return t("思考中") + sec;
        // 官方接口默认把工具参数攒成大块才下发（不像 DeepSeek 逐字流），字数常常一下跳到底就不动了；
        // 后面跟上这一步的用时，不动的时候也看得出没卡住
        case "tool":    return t("正在写 {name} 的参数", { name: phEv.name || "?" }) + (phEv.chars ? " · " + fmtChars(phEv.chars) : "") + sec;
      }
      return "";
    };
    const phPaint = () => {
      if (!ph || !phEv) return;
      ph.textContent = phText();
      const slow = ["prep", "boot", "connect", "wait"].includes(phEv.phase) && Date.now() - phT0 > 30000;
      ph.classList.toggle("slow", slow);
      ph.classList.toggle("bad", phEv.phase === "retry");
    };
    const phPlace = () => {
      if (!ph) return;
      if (dots) { if (ph.previousSibling !== dots) dots.after(ph); }
      else if (liveTail && ph.parentNode !== liveTail) liveTail.insertBefore(ph, tailTime);
    };
    const phClear = () => { if (phIv) { clearInterval(phIv); phIv = 0; } ph?.remove(); ph = null; phEv = null; };
    const setPhase = (ev) => {
      if (!live || ended) return;
      const k = ev && ev.phase;
      if (!k || k === "text") return phClear();
      if (k === "tool" && ev.id && cardTools.has(ev.id)) return;   // 这个工具的卡已经出来了（在跑）：迟到的「正在写参数」不认
      // 启动阶段（F6）只往前走：「启动中」只接「准备中」，init 带来的「连接中」只接前两段，迟到 / 重放的不把已经出字的拉回去
      if (k === "boot" && phEv && phEv.phase !== "prep") return;
      if (ev.from === "init" && phEv && phEv.phase !== "prep" && phEv.phase !== "boot") return;
      const changed = !phEv || phEv.phase !== k || k === "retry" || (k === "tool" && phEv.name !== ev.name);
      if (changed) phT0 = Date.now();
      phEv = ev;
      if (!ph) { ph = document.createElement("span"); ph.className = "run-phase"; }
      ph.title = k === "retry" ? [ev.status, ev.error].filter(Boolean).join(" · ") : "";
      phPlace(); phPaint();
      if (changed) MO.spring(ph, "pop", (p) => ({ opacity: Math.min(1, p * 1.6), transform: `translateY(${(1 - p) * 8}px)` }));
      if (!phIv) phIv = setInterval(phPaint, 1000);
    };
    // 挪动节点会让 CSS 动画从头播：已经在末尾就不动；要挪时按全局时钟续上相位，闪烁节奏不乱跳
    const keepTail = () => {
      if (!liveTail || ended) return;
      if (bubble.lastChild !== liveTail) {
        bubble.appendChild(liveTail);
        liveTail.firstChild.style.animationDelay = -(performance.now() % 2000) + "ms";
      }
      phPlace();
    };
    const push = (b) => { undot(); blocks.push(b); last = b; any = true; keepTail(); return b; };
    const textB = () => (last && last.kind === "text" ? last : push(TextBlock(bubble, live)));
    // 正在攒的步骤组（工具 + 中间的思考）；一出正文就收口
    const inGroup = () => last && last.kind === "tgroup";
    const groupThink = () => { const b = ThinkBlock(last.body); last.addThink(b); return b; };
    const thinkB = () => {
      if (inGroup()) { const li = last.lastInner; return li && li.kind === "think" ? li : groupThink(); }
      return last && last.kind === "think" ? last : push(ThinkBlock(bubble));
    };
    return {
      msgEl, bubble, tailTime,
      phase: setPhase,
      /** 工具结果回来：这一批工具都有结果了，下一步就是再请求模型 */
      toolDone(id) { if (pendTools.delete(id) && !pendTools.size) setPhase({ phase: "connect" }); },
      delta(t) { textB().append(t); },
      text(t, uuid) { const b = push(TextBlock(bubble, live)); b.set(t); if (uuid) b.el.dataset.uuid = uuid; },
      thinkDelta(t) { thinkB().append(t); },
      thinking(t) { (inGroup() ? groupThink() : push(ThinkBlock(bubble))).set(t); },
      /** 流断了重来：删掉上一次请求逐字推出、却没进对话的半截（正文在最后一块，思考在它前面或步骤组里） */
      discard(nText, nThink) {
        const dropTop = (b, n) => { if (b.drop(n) > 0) return; b.remove(); blocks.splice(blocks.indexOf(b), 1); last = blocks[blocks.length - 1] || null; };
        if (nText > 0 && last && last.kind === "text") dropTop(last, nText);
        if (nThink > 0) {
          if (last && last.kind === "think") dropTop(last, nThink);
          else if (inGroup() && last.lastInner && last.lastInner.kind === "think") last.lastInner.drop(nThink);
        }
        if (!blocks.length && live) { any = false; if (!dots) { bubble.insertAdjacentHTML("afterbegin", DOTS); dots = bubble.firstChild; } phPlace(); }
      },
      tool(id, name, input) {
        noteWrote(name, input);            // 回复里只写文件名也能点（见 01-core.js 的 WROTE）
        if (live) { pendTools.add(id); cardTools.add(id); phClear(); }     // 工具卡出来了，参数写完，接下来是工具在跑
        let g = last;
        if (!inGroup()) {
          const prev = last && last.kind === "think" ? last : null;      // 紧挨着的那段思考也收进来
          g = ToolGroup(bubble);
          if (prev) { blocks.splice(blocks.indexOf(prev), 1); g.addThink(prev); }
          push(g);
        }
        g.add(ToolBlock(g.body, id, name, input, live));
        keepTail();
        scrollDown();
      },
      error(msg) {
        undot(); any = true; last = null;
        bubble.insertAdjacentHTML("beforeend", `<div class="err-box">${esc(msg)}</div>`);
        keepTail();
        scrollDown();
      },
      // 主会话被子代理叫起来的那一轮：开头一行「← 谁：为什么事」，连着来的并成一行
      mark(text) {
        undot(); any = true;
        const tailEl = liveTail && liveTail.parentNode === bubble ? liveTail : null;
        const prev = tailEl ? tailEl.previousElementSibling : bubble.lastElementChild;
        if (last === null && prev && prev.classList.contains("ag-mark")) { prev.textContent += " · " + text; return; }
        last = null;
        const p = document.createElement("p");
        p.className = "ag-mark"; p.textContent = text;
        bubble.insertBefore(p, tailEl);
        keepTail();
      },
      hookCtx(e, text) { undot(); last = null; bubble.appendChild(hookCtxEl(e, text)); keepTail(); },
      note(t, solid) { undot(); last = null; if (solid) any = true; bubble.insertAdjacentHTML("beforeend", `<p class="run-note">${esc(t)}</p>`); keepTail(); },
      // 同一个 key 的提示原地更新（加载模型、读提示的进度），不一条条往下堆
      noteK(k, t, solid) {
        if (solid) any = true;
        const ex = [...bubble.querySelectorAll(".run-note[data-k]")].find((n) => n.dataset.k === k);
        if (ex) { ex.textContent = t; return; }
        undot(); last = null;
        bubble.insertAdjacentHTML("beforeend", `<p class="run-note" data-k="${esc(k)}">${esc(t)}</p>`); keepTail();
      },
      finish(aborted, failed) {
        if (ended) return;
        phClear();
        ended = true;
        liveTail?.remove();
        // 失败的一轮也要把还在跑的卡收口：优先「失败」，没有 fail 的（老块）退回 stop（0.6.9 审计 195-BB.1）
        for (const b of blocks) { b.finish && b.finish(); if (failed && b.fail) b.fail(); else if ((aborted || failed) && b.stop) b.stop(); }
        undot();
        if (!any && live && !aborted) bubble.innerHTML = '<p class="muted">' + t("（无输出）") + '</p>';
        replyActs(msgEl, () => blocks.filter((b) => b.kind === "text").map((b) => b.text.trim()).filter(Boolean).join("\n\n"));
      },
      get empty() { return !any; },
      get ended() { return ended; },
      remove() { phClear(); msgEl.remove(); },   // 阶段提示的每秒定时器一起停（审查 中14）
    };
  }

  // ── 生成计时：从网关记下的开始时刻算（同一台机器的时钟），断线重连接上的那一轮也对得上 ──
  function fmtDur(ms, fine) {
    const s = Math.max(0, ms / 1000);
    if (s < 60) return (fine ? s.toFixed(1) : Math.floor(s)) + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(Math.floor(s % 60)).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function RunTimer(startedAt) {
    const el = document.createElement("span");
    el.className = "tag run-timer live";
    const t0 = startedAt || Date.now();
    let tail = null;     // 回复末尾光标旁的那一份。生成中顶部那份一律藏着，结束后才显示「用时」—— 两处同时跳秒太吵
    // 藏用行内 display：.tag 的样式写了 display，盖过 hidden 属性，以前顶部那份一直露着、停在 0s
    const show = (on) => { el.style.display = on ? "" : "none"; };
    const tick = () => { const d = fmtDur(Date.now() - t0); if (tail) tail.textContent = d; else el.textContent = d; };
    tick();
    let iv = setInterval(tick, 1000);
    return {
      attach(av) { av.msgEl.querySelector(".who")?.appendChild(el); tail = av.tailTime; show(false); tick(); },
      stop(at) {          // at：真正结束的时刻（重放时事件比现在早）
        if (!iv) return;
        clearInterval(iv); iv = 0;
        el.classList.remove("live"); show(true);
        el.textContent = t("用时 {d}", { d: fmtDur((at || Date.now()) - t0, true) });
      },
    };
  }

  /** 压缩处的章节分隔：第 n 章 · 题名（没建档的拿章首提问灰字顶上）· 档号 */
  function chapterSep(m, parent) {
    const el = document.createElement("div");
    el.className = "ch-sep";
    el.dataset.uuid = m.uuid || "";
    el.innerHTML = `<span class="ch-n">${esc(t("第 {n} 章", { n: m.chapter }))}</span>`
      + (m.chTitle ? `<span class="ch-t${m.chGhost ? " ghost" : ""}">${esc(m.chTitle)}</span>` : "")
      + `<span class="ch-no">${esc(m.chNo || "")}</span>`;
    el.title = m.text;
    parent.appendChild(el);
    return el;
  }
  /** 历史页：一段 transcript 条目 → 一个 .page 容器 */
  function renderItems(items) {
    const page = document.createElement("div");
    page.className = "page";
    let av = null;
    const avs = [], agTools = [];
    for (const m of items) {
      if (m.role === "user") { renderUser(m.text, page, m.uuid); av = null; continue; }
      if (m.role === "note") { (m.chapter ? chapterSep : addNote)(m.chapter ? m : m.text, page); av = null; continue; }
      if (m.role === "hookctx") { addHookCtx(m.event, m.text, page); av = null; continue; }
      if (m.role === "tool_result") { toolResult(m.id, m.ok, m.text); continue; }
      if (!av) { av = AssistantView(page, false); avs.push(av); }
      if (m.role === "assistant") av.text(m.text, m.uuid);
      else if (m.role === "thinking") av.thinking(m.text);
      else if (m.role === "tool_use") {
        av.tool(m.id, m.name, m.input);
        agTools.push(m.id);
        const c = m.sub && view.sessionId && TOOL_CARDS.get(m.id), sid = view.sessionId;
        const mk = (tid) => async () => { const r = await api(`/api/session/${encodeURIComponent(sid)}/agent?tool=${encodeURIComponent(tid)}`), it = r.items || []; it.more = !!r.more; return it; };
        if (c && c.isAgent) c.subLazy(mk(m.id), mk);
      }
    }
    for (const a of avs) a.finish();
    paintMarks(page);
    // 联络簿先到、卡片所在的这页后到：子代理卡要挂在已经接进文档的工具卡后面（agCardFor 认 isConnected），
    // 这时 page 还没接上 —— 调用方拿到 page 都是当场同步接上的，等到微任务再补建（#95 01-004）
    if (agTools.length) queueMicrotask(() => { for (const id of agTools) if (AG.byTool.has(id)) agTouch(agCardFor(id)); });
    if (view.sessionId && items.some((m) => m.sub)) agLoad(view.sessionId);
    return page;
  }


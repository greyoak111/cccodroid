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

  function diffHtml(oldS, newS) {
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
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + diffHtml(i.old_string, i.new_string);
        break;
      case "MultiEdit":
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + (i.edits || []).slice(0, 8).map((e) => diffHtml(e.old_string, e.new_string)).join("");
        break;
      case "Write": {
        const c = String(i.content || ""), ls = c.split("\n");
        h = `<div class="perm-path">${esc(i.file_path || "")}</div><pre class="perm-diff">${ls.slice(0, 30).map((l) => `<span class="add">+ ${esc(l)}</span>`).join("\n")}${ls.length > 30 ? "\n" + esc(t("…（共 {n} 行）", { n: ls.length })) : ""}</pre>`;
        break;
      }
      case "NotebookEdit":
        h = `<div class="perm-path">${esc(i.notebook_path || "")}</div><pre class="perm-cmd">${esc(String(i.new_source || "").slice(0, 3000))}</pre>`;
        break;
      case "WebFetch": h = `<pre class="perm-cmd">${esc(i.url || "")}</pre>` + (i.prompt ? `<div class="perm-sub">${esc(i.prompt)}</div>` : ""); break;
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
    return h;
  }

  function permActions(p) {
    if (p.tool === "ExitPlanMode") return `
      <button class="pa-allow primary" data-mode="default">${t("批准，逐项确认执行")}</button>
      <button class="pa-allow" data-mode="acceptEdits">${t("批准，自动接受编辑")}</button>
      <button class="pa-more">${t("再改改 ▾")}</button>`;
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
    el.className = "perm";
    el.dataset.id = p.id;
    const kind = p.tool === "ExitPlanMode" ? t("计划待批准") : p.tool === "AskUserQuestion" ? t("Claude 想问你") : t("需要确认");
    el.innerHTML = `
      <div class="perm-head"><span class="perm-kind">${uiI("pause")}${kind}</span><span class="perm-tool">${esc(p.tool)}</span>${p.agentId ? `<span class="perm-sub">${t("子代理")}</span>` : ""}</div>
      <div class="perm-body">${permPreview(p)}</div>
      <div class="perm-acts">${permActions(p)}</div>
      <div class="perm-deny hidden">
        <textarea rows="2" placeholder="${p.tool === "ExitPlanMode" ? t("说说要怎么改（会发回给 Claude）") : t("可选：告诉 Claude 为什么 / 该怎么做")}"></textarea>
        <div class="perm-acts">
          <button class="pa-deny">${p.tool === "ExitPlanMode" ? t("发回意见") : t("拒绝")}</button>
          <button class="pa-stop">${t("拒绝并停止")}</button>
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
      if (b.classList.contains("pa-allow")) return permAnswer(p.id, { behavior: "allow", mode: b.dataset.mode && b.dataset.mode !== state.permissionMode ? b.dataset.mode : undefined });
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
    const label = behavior === "allow"
      ? (p.tool === "ExitPlanMode" ? t("✓ 已批准计划") : p.tool === "AskUserQuestion" ? t("✓ 已回答") : o.always ? t("✓ 已允许（始终）") : t("✓ 已允许"))
      : behavior === "deny" ? (o.interrupt ? t("✗ 已拒绝并停止") : p.tool === "ExitPlanMode" ? t("↩ 已退回修改") : t("✗ 已拒绝"))
      : behavior === "cancel" ? t("已撤回") : behavior === "stopped" ? t("已停止（这一轮结束了）") : t("已失效");
    const tc = p.toolUseId && TOOL_CARDS.get(p.toolUseId);
    if (it.el && tc && tc.el && tc.el.isConnected && p.tool !== "ExitPlanMode" && p.tool !== "AskUserQuestion") {
      const tag = document.createElement("span");
      tag.className = "perm-tag " + (behavior === "allow" ? "ok" : "no");
      tag.textContent = label;
      tc.el.querySelector(".tool-state")?.before(tag);
      it.el.remove();
      it.el = null;
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

  function onPermRequest(ev) {
    const old = PERMS.get(ev.id);
    if (old && old.el && old.el.isConnected) return;      // 重放来的重复事件
    const it = { p: ev, runId: ev.runId, el: null, done: false };
    PERMS.set(ev.id, it);
    it.el = PermCard(ev, ev.runId);
    renderPermBar();
    scrollDown();
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
  const tasksSig = (l) => l.map((x) => x.id + ":" + x.status).join(",");
  const taskLabel = (x) => esc(x.status === "in_progress" && x.active ? x.active : x.subject);
  // more：清单收起时被一并收起的目标 / 后台任务条数，标在清单那一行末尾
  function tasksHtml(more) {
    const l = view.tasks;
    if (!l || !l.length) return "";
    const done = l.filter((x) => x.status === "completed").length, all = done === l.length;
    if (all && view.tasksHide === tasksSig(l)) return "";
    const cur = l.find((x) => x.status === "in_progress") || l.find((x) => x.status !== "completed");
    const pct = Math.round(done / l.length * 100);
    const head = `<div class="rs-row rs-thead" role="button" tabindex="0" aria-expanded="${tasksOpen}">
      <span class="rs-ico">${uiI(all ? "check" : "list")}</span>
      <span class="rs-tcount">${all ? t("清单完成") : t("清单")} ${done}/${l.length}</span>
      <span class="rs-tbar"><i style="width:${pct}%"></i></span>
      <span class="rs-txt">${!tasksOpen && cur ? taskLabel(cur) : ""}</span>
      ${more ? `<span class="rs-meta">${t("另有 {n} 项", { n: more })}</span>` : ""}
      ${all ? `<button class="rs-tx" aria-label="${t("关闭")}">${uiI("x")}</button>` : `<span class="rs-chev${tasksOpen ? " up" : ""}">${uiI("chevDown")}</span>`}</div>`;
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
        <span class="rs-meta">${[g.checks ? t("已检查 {n} 次", { n: g.checks }) : "", el ? t("已用 {d}", { d: el }) : ""].filter(Boolean).join(" · ")}</span>
        <button class="rs-goal-stop">${t("放弃")}</button></div>
        ${g.reason ? `<div class="rs-sub">${t("还差：")}${esc(g.reason)}</div>` : ""}</div>`;
    } else if (g && g.done) {
      const bits = [g.iterations != null ? t("{n} 轮", { n: g.iterations }) : "", g.durationMs != null ? fmtDur(g.durationMs) : "", g.tokens != null ? g.tokens.toLocaleString() + " tokens" : ""].filter(Boolean).join(" · ");
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
    runStrip.innerHTML = html;
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
        view.goalClearAfter = srv.run.id;
        b.disabled = true;
        api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: srv.run.id }) }).catch(() => {});
      } else send("/goal clear");
      return;
    }
    if (b.classList.contains("rs-stop") && srv.run) {
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
    const f = list[0].p, simple = (it) => it.p.tool !== "ExitPlanMode" && it.p.tool !== "AskUserQuestion";
    const what = f.tool === "Bash" ? f.input.command : (f.input.file_path || f.input.url || f.input.query || "");
    permBar.innerHTML = `
      <div class="pb-main">
        ${list.length > 1 ? `<span class="pb-n">${t("第 {i}/{n} 个", { i: 1, n: list.length })}</span>` : ""}
        <span class="pb-txt">${uiI("pause")}${f.tool === "ExitPlanMode" ? t("计划待批准") : f.tool === "AskUserQuestion" ? t("Claude 想问你") : t("Claude 在等你确认") + " · "}${simple(list[0]) ? `<b>${esc(f.tool)}</b> <span class="mono">${esc(String(what || "").slice(0, 80))}</span>` : ""}</span>
        ${simple(list[0]) ? `<button class="pb-allow primary">${t("允许")}</button>` : ""}
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
    if (b.classList.contains("pb-view")) { list[0].el?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (b.classList.contains("pb-allow")) return permAnswer(list[0].p.id, { behavior: "allow" });
    if (b.classList.contains("pb-all")) list.forEach((it) => permAnswer(it.p.id, { behavior: "allow" }));
  });

  // 顶栏（输入框下）的权限标签：点开切模式，对应官方 TUI 的 Shift+Tab
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
    if (!mode || mode === state.permissionMode) return;
    if (mode === "bypassPermissions" && !confirm(t("切到「全部放行」？\n\nClaude 将不再询问，可以直接改写、删除文件，运行任意命令，访问网络。只在你信任当前任务、且出了事能承受的时候用。"))) {
      $("set-perm").value = state.permissionMode;
      return;
    }
    try {
      const r = await api("/api/perm/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      state.settings.permissionMode = r.mode;
      setPermChip(r.mode);
      $("set-perm").value = r.mode;
      toast(r.live ? t("已切到「{m}」，这一轮当场生效", { m: modeLabel(r.mode) }) : t("已切到「{m}」", { m: modeLabel(r.mode) }));
    } catch (err) { toast(err.message, true); }
  }

  // 回复底下的「复制 / 转发」：只取正文（Markdown 原文，多段之间空一行），思考和工具调用不算。
  // 转发走外壳的系统分享面板（CCApp.shareText）；外壳没有这个接口时退回 Web Share，都没有就复制并说明。
  // 提问和回复底下一律四个键（提问：复制 / 重发 / 回退 / 删除；回复：复制 / 转发 / 分叉 / 删除），别因为环境不同少一个
  function replyActs(msgEl, getText) {
    if (!getText() || msgEl.querySelector(":scope > .msg-acts")) return;
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + actBtn("share", t("转发")) +
      (msgEl.classList.contains("sys") ? "" : actBtn("fork", t("从这里分叉")) + actBtn("mark", t("书签")) + actBtn("del", t("删除")));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a, text = getText();
      if (a === "copy") { copyText(text); toast(t("已复制")); }
      if (a === "share") {
        if (window.CCApp && CCApp.shareText) CCApp.shareText(text);
        else if (navigator.share) navigator.share({ text }).catch(() => {});
        else { copyText(text); toast(t("这里没有系统分享，已复制到剪贴板")); }
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
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    let turn = which === "user" ? msgEl : null;
    if (!turn) for (const u of users) if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) turn = u;
    const after = users.length - 1 - users.indexOf(turn);
    if (!turn) return toast(t("这条回复前面没有你的消息，没法单独删"), true);
    if (!confirm(which === "user" ? t("删掉这条提问？Claude 之后就看不到它了（它的回复保留）。") : t("删掉这条回复？连同它的工具调用和结果一起删，Claude 之后就看不到了。"))) return;
    try {
      const r = await api("/api/session/" + encodeURIComponent(sid) + "/delmsg", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: userTextOf.get(turn), after, which }),
      });
      if (which === "user") { userTextOf.delete(msgEl); msgEl.remove(); } else msgEl.remove();
      toastAct(t("已删除"), t("撤销"), async () => {
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
        body: JSON.stringify({ userText: userTextOf.get(prev), after }),
      });
      openSession(r.id);
      loadSessions();
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
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText, after, ...extra }),
    });
    toast(t("正在查这之后改过哪些文件…"));
    let d;
    try { d = await post({ dryRun: true }); } catch (e) { return toast(e.message, true); }
    const choice = await rewindDialog(d);
    if (!choice) return;
    try {
      const r = await post({ conversation: choice === "both" });
      const n = r.files && r.files.canRewind && r.files.files ? r.files.files.length : 0;
      if (choice === "both") {
        if (r.fork && r.fork.fresh) newConversation(); else { openSession(r.fork.id); loadSessions(); }
        setTimeout(() => { inputEl.value = userText; autoGrow(); inputEl.focus(); }, 300);
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
        ? `<p>${esc(t("会撤销 Claude 在这之后对 {n} 个文件的修改", { n: files.length }))} <span class="rw-stat">+${d.insertions || 0} −${d.deletions || 0}</span></p><ul class="rw-files">${list}</ul>`
        : `<p>${esc(d.canRewind ? t("这之后 Claude 没有用编辑工具改过文件。") : t("这之后的文件改动没有留底（这个版本之前的消息不支持），只能回退对话。"))}</p>`;
      ov.innerHTML = `<div class="rw-dlg" role="dialog" aria-modal="true">
        <h3>${esc(t("回退到这条消息之前"))}</h3>${what}
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
    const pendTools = new Set();
    const phText = () => {
      const ms = Date.now() - phT0, sec = ms >= 3000 ? " · " + fmtDur(ms) : "";
      switch (phEv.phase) {
        case "connect": return t("连接中") + sec;
        case "wait":    return t("已连上，等待输出") + sec;
        case "retry":   return t("连接出错，第 {a}/{m} 次重试", { a: phEv.attempt || 1, m: phEv.max || "?" });
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
      const slow = (phEv.phase === "connect" || phEv.phase === "wait") && Date.now() - phT0 > 30000;
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
      const changed = !phEv || phEv.phase !== k || k === "retry" || (k === "tool" && phEv.name !== ev.name);
      if (changed) phT0 = Date.now();
      phEv = ev;
      if (!ph) { ph = document.createElement("span"); ph.className = "run-phase"; }
      ph.title = k === "retry" ? [ev.status, ev.error].filter(Boolean).join(" · ") : "";
      phPlace(); phPaint();
      if (changed) MO.spring(ph, "pop", (p) => ({ opacity: Math.min(1, p * 1.6), transform: `translateY(${(1 - p) * 8}px)` }));
      if (!phIv) phIv = setInterval(phPaint, 1000);
    };
    const keepTail = () => { if (liveTail && !ended) { bubble.appendChild(liveTail); phPlace(); } };
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
        if (live) { pendTools.add(id); phClear(); }     // 工具卡出来了，参数写完，接下来是工具在跑
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
      note(t, solid) { undot(); last = null; if (solid) any = true; bubble.insertAdjacentHTML("beforeend", `<p class="run-note">${esc(t)}</p>`); keepTail(); },
      // 同一个 key 的提示原地更新（加载模型、读提示的进度），不一条条往下堆
      noteK(k, t) {
        const ex = [...bubble.querySelectorAll(".run-note[data-k]")].find((n) => n.dataset.k === k);
        if (ex) { ex.textContent = t; return; }
        undot(); last = null;
        bubble.insertAdjacentHTML("beforeend", `<p class="run-note" data-k="${esc(k)}">${esc(t)}</p>`); keepTail();
      },
      finish(aborted) {
        if (ended) return;
        phClear();
        ended = true;
        liveTail?.remove();
        for (const b of blocks) { b.finish && b.finish(); if (aborted && b.stop) b.stop(); }
        undot();
        if (!any && live && !aborted) bubble.innerHTML = '<p class="muted">' + t("（无输出）") + '</p>';
        replyActs(msgEl, () => blocks.filter((b) => b.kind === "text").map((b) => b.text.trim()).filter(Boolean).join("\n\n"));
      },
      get empty() { return !any; },
      get ended() { return ended; },
      remove() { msgEl.remove(); },
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
    let tail = null;     // 回复末尾光标旁的那一份。有它时顶部那份先藏着，结束后才显示「用时」—— 两处同时跳秒太吵
    const tick = () => { const d = fmtDur(Date.now() - t0); if (tail) tail.textContent = d; else el.textContent = d; };
    tick();
    let iv = setInterval(tick, 1000);
    return {
      attach(av) { av.msgEl.querySelector(".who")?.appendChild(el); tail = av.tailTime; el.hidden = !!tail; tick(); },
      stop(at) {          // at：真正结束的时刻（重放时事件比现在早）
        if (!iv) return;
        clearInterval(iv); iv = 0;
        el.classList.remove("live"); el.hidden = false;
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
    const avs = [];
    for (const m of items) {
      if (m.role === "user") { renderUser(m.text, page, m.uuid); av = null; continue; }
      if (m.role === "note") { (m.chapter ? chapterSep : addNote)(m.chapter ? m : m.text, page); av = null; continue; }
      if (m.role === "tool_result") { toolResult(m.id, m.ok, m.text); continue; }
      if (!av) { av = AssistantView(page, false); avs.push(av); }
      if (m.role === "assistant") av.text(m.text, m.uuid);
      else if (m.role === "thinking") av.thinking(m.text);
      else if (m.role === "tool_use") {
        av.tool(m.id, m.name, m.input);
        const c = m.sub && view.sessionId && TOOL_CARDS.get(m.id), sid = view.sessionId;
        if (c && c.isAgent) c.subLazy(async () => (await api(`/api/session/${encodeURIComponent(sid)}/agent?tool=${encodeURIComponent(m.id)}`)).items || []);
      }
    }
    for (const a of avs) a.finish();
    paintMarks(page);
    return page;
  }


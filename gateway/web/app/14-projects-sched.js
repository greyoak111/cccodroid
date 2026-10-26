  // 0.3.16：项目 / 定时任务也能指定接口；别家的模型清单按需拉一次，缓存在 PJ.pm
  PJ.pm = {};
  function provModelsOf(id) {
    if (!id || id === globalProv()) return Promise.resolve(MODELS);
    if (PJ.pm[id]) return Promise.resolve(PJ.pm[id]);
    return api("/api/models?browse=" + encodeURIComponent(id)).then((r) => { if (r.providers) state.provList = r.providers; return (PJ.pm[id] = r.models || []); }).catch(() => []);
  }
  const usableProvs = () => (state.provList || []).filter((p) => p.usable);
  const provChoices = (follow, cur) => [["", follow], ...usableProvs().map((p) => [p.id, provLabel(p.id)]),
    ...(cur && !usableProvs().some((p) => p.id === cur) ? [[cur, provLabel(cur)]] : [])];

  // ── 项目页 ──
  // 列表 ↔ 详情的动效：上次画的是哪个详情，变了才放（数据刷新重画不放）；整页刚滑进来时不叠加
  const pgNav = {};
  function navMo(name, cur) {
    const k = cur || "", was = pgNav[name];
    pgNav[name] = k;
    if (was === undefined || was === k || curPage !== name) return;
    const pg = $("pages"); if (pg.classList.contains("mo-in-push") || pg.classList.contains("mo-in-rise")) return;
    const narrow = innerWidth < 680, into = !!k;
    // 回程：内容马上要被重画，先给旧的留个替身 —— 进详情时列表往左退暗（垫在下面），返回时详情往右滑走（盖在上面）
    MO.ghost($("tab-" + name), narrow ? (into ? "back" : "push") : "fade", !(narrow && into));
    MO.play($("tab-" + name), narrow ? (into ? "mo-in-push" : "mo-in-back") : (into ? "mo-in-pane" : "mo-in-pane-back"), 1400);
  }
  async function renderProjects() {
    navMo("projects", PJ.cur);
    const box = $("tab-projects");
    if (PJ.cur) return renderProject(box);
    setOv("");
    setPageSub("projects", t("{n} 个", { n: PJ.list.length }));
    const card = (p) => `<button class="pj-card" data-pj="${esc(p.id)}">
        <span class="pj-ct"><span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span><b>${esc(p.name)}</b></span>
        <span class="mono muted pj-path">\u200e${esc(p.path)}\u200e</span>
        <span class="muted pj-meta">${esc(t("{n} 个对话", { n: p.sessions || 0 }))} · ${esc(relTime(p.lastAt || p.created))}${p.exists === false ? ` · <span class="pj-gone">${esc(t("目录不在了"))}</span>` : ""}</span></button>`;
    box.innerHTML = pageHead(esc(t("项目")), `<button class="btn sm pj-primary" data-a="new">${pi("plus")}${esc(t("新建项目"))}</button>`) +
      `<p class="pj-lead muted">${esc(t("一个项目 = 一个工作目录，带自己的指令（CLAUDE.md）、默认型号与权限。项目里开的对话都在这个目录里跑。"))}</p>` +
      (PJ.list.length ? `<div class="pj-grid">${PJ.list.map(card).join("")}</div>`
        : `<div class="panel">${emptyRow(t("还没有项目。新建一个，或者把已有的目录收进来。"))}</div>`);
  }
  async function renderProject(box) {
    const id = PJ.cur;
    let d = PJ.detail && PJ.detail.project && PJ.detail.project.id === id ? PJ.detail : null;
    if (!d) {
      box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(t("加载中…"))}</div>`;
      try { d = PJ.detail = await api("/api/projects/" + encodeURIComponent(id)); } catch (e) { box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(e.message)}</div>`; return; }
      if (PJ.cur !== id) return;
      try { const r = await api("/api/projects/" + encodeURIComponent(id) + "/instr"); d.instr = r.text || ""; } catch { d.instr = ""; }
    }
    const p = d.project;
    setOv(p.name); setPageSub("projects", p.path);
    if (!MODELS.length) api("/api/models").then((r) => { MODELS = r.models || []; PJ.effLevels = r.effortLevels || []; if (PJ.cur === id) renderProject(box); }).catch(() => {});
    const opt = (v, l, cur) => `<option value="${esc(v)}"${v === (cur || "") ? " selected" : ""}>${esc(l)}</option>`;
    const follow = t("跟随全局");
    // 项目指定了别家：型号清单换成那家的（没拉过先拉，拉回来重画）
    const pms = p.provider && p.provider !== globalProv() ? PJ.pm[p.provider] : MODELS;
    if (!pms) provModelsOf(p.provider).then(() => { if (PJ.cur === id) renderProject(box); });
    const PMS = pms || [];
    const provSel = `<select data-def="provider">${provChoices(follow, p.provider).map(([v, l]) => opt(v, l, p.provider)).join("")}</select>`;
    const modelSel = `<select data-def="model">${opt("", follow, p.model)}${PMS.map((m) => opt(m.id, prettyModel(m.id), p.model)).join("")}${p.model && !PMS.some((m) => m.id === p.model) ? opt(p.model, prettyModel(p.model), p.model) : ""}</select>`;
    const effs = PJ.effLevels && PJ.effLevels.length ? PJ.effLevels : ["low", "medium", "high", "xhigh", "max"];
    const effSel = `<select data-def="effort">${opt("", follow, p.effort)}${effs.map((e) => opt(e, e, p.effort)).join("")}</select>`;
    const permSel = `<select data-def="perm">${opt("", follow, p.perm)}${["default", "acceptEdits", "plan", "auto", "dontAsk"].map((k) => opt(k, t(PERM_SHORT[k]), p.perm)).join("")}</select>`;
    const tasks = ((SC.data && SC.data.tasks) || []).filter((x) => x.projectId === id);
    const files = d.files || [];
    box.innerHTML = pageHead(`<span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span>${esc(p.name)}`,
        `<button class="btn sm pj-primary" data-a="chat">${pi("plus")}${esc(t("新对话"))}</button>${kebabBtn("pmenu")}`, true) +
      `<div class="mono muted pj-dpath">${esc(p.path)}${p.exists === false ? ` · <span class="pj-gone">${esc(t("目录不在了"))}</span>` : ""}</div>` +
      `<div class="pj-sec"><span class="grow">${esc(t("对话"))}（${d.sessions.length}）</span></div>
      <div class="panel">${d.sessions.length ? d.sessions.slice(0, 30).map((s) => `<div class="row pj-row" data-sid="${esc(s.id)}"><div class="grow"><div class="t1">${schedSids().has(s.id) ? pi("clock", "pj-ic") : ""}${esc(s.title)}</div><div class="muted pj-sub">${esc(relTime(s.mtime))}</div></div></div>`).join("") : emptyRow(t("还没有对话"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("指令 · CLAUDE.md"))}</span><span class="muted pj-note">${esc(t("每次对话自动带上"))}</span></div>
      <textarea class="pj-field pj-instr" placeholder="${esc(t("这个项目是什么、怎么构建、有什么规矩…"))}">${esc(d.instr || "")}</textarea>
      <div class="pj-save hidden"><button class="btn sm ghost" data-a="instr-undo">${esc(t("还原"))}</button><button class="btn sm" data-a="instr-save">${esc(t("保存"))}</button></div>
      <div class="pj-sec"><span class="grow">${esc(t("默认设置"))} <span class="muted pj-note">${esc(t("（只管这个项目里新开的对话）"))}</span></span></div>
      <div class="panel">
        ${usableProvs().length > 1 || p.provider ? `<div class="row"><div class="grow"><b>${esc(t("接口"))}</b></div>${provSel}</div>` : ""}
        <div class="row"><div class="grow"><b>${esc(t("型号"))}</b></div>${modelSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("思考强度"))}</b></div>${effSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("权限模式"))}</b></div>${permSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("MCP 服务器"))}</b><div class="muted pj-sub">${d.mcp && d.mcp.length ? esc(t("项目自己的 .mcp.json：{list}", { list: d.mcp.join("、") })) : esc(t("没有 .mcp.json；用的是全局的"))}</div></div></div>
      </div>
      <div class="pj-sec"><span class="grow">${esc(t("文件"))}</span><button class="btn sm ghost" data-a="files">${esc(t("在文件浏览器打开"))}</button></div>
      <div class="panel pj-files">${files.length ? files.slice(0, 12).map((f) => `<div class="row pj-row" data-file="${esc(f.name)}" data-dir="${f.dir ? 1 : ""}"><span class="mono grow">${esc(f.name)}${f.dir ? "/" : ""}</span></div>`).join("") + (files.length > 12 ? `<div class="row"><span class="muted">${esc(t("还有 {n} 项", { n: files.length - 12 }))}</span></div>` : "") : emptyRow(t("（空目录）"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("记忆"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("{n} 条", { n: (d.memory || []).length }))}</b><div class="muted pj-sub">${esc(t("Claude 在这个项目里记下的事"))}</div></div>${(d.memory || []).length ? `<button class="btn sm ghost" data-a="memory">${esc(t("查看"))}</button>` : ""}</div></div>
      <div class="pj-sec"><span class="grow">${esc(t("定时任务"))}</span><button class="btn sm ghost" data-a="newtask">${pi("plus")}${esc(t("新建"))}</button></div>
      <div class="panel">${tasks.length ? tasks.map((x) => `<div class="row pj-row" data-task="${esc(x.id)}"><div class="grow"><div class="t1">${pi("clock", "pj-ic")}${esc(x.name)}</div><div class="muted pj-sub">${esc(freqText(x.freq))}</div></div><span class="pill ${x.on ? "acc" : ""}">${esc(x.on ? t("开") : t("关"))}</span></div>`).join("") : emptyRow(t("没有"))}</div>`;
    const ta = box.querySelector(".pj-instr");
    ta.addEventListener("input", () => box.querySelector(".pj-save").classList.toggle("hidden", ta.value === (d.instr || "")));
  }
  $("tab-projects").addEventListener("click", async (e) => {
    const box = $("tab-projects");
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "back") { PJ.cur = null; PJ.detail = null; return renderProjects(); }
    if (a === "new") return newProjectDlg();
    const card = e.target.closest("[data-pj]"); if (card) return openProject(card.dataset.pj);
    const sid = e.target.closest("[data-sid]"); if (sid) return openSession(sid.dataset.sid);
    const tk = e.target.closest("[data-task]"); if (tk) { SC.cur = tk.dataset.task; SC.detail = null; return openPage("sched"); }
    const p = PJ.detail && PJ.detail.project; if (!p) return;
    if (a === "chat") return newChatIn(p.id);
    if (a === "pmenu") return projMenu(p, e.target.closest("[data-a]"));
    if (a === "files") return openFiles(p.path);
    if (a === "memory") { const m = PJ.detail.memory[0]; return openFiles(m.path.replace(/\/[^/]+$/, "")); }
    if (a === "newtask") return taskDlg(null, { projectId: p.id });
    const f = e.target.closest("[data-file]");
    if (f) { const full = p.path.replace(/\/$/, "") + "/" + f.dataset.file; return f.dataset.dir ? openFiles(full) : openViewer(full); }
    if (a === "instr-undo") { box.querySelector(".pj-instr").value = PJ.detail.instr || ""; box.querySelector(".pj-save").classList.add("hidden"); return; }
    if (a === "instr-save") {
      const text = box.querySelector(".pj-instr").value;
      try { await jsend(`/api/projects/${encodeURIComponent(p.id)}/instr`, { text }, "PUT"); PJ.detail.instr = text; box.querySelector(".pj-save").classList.add("hidden"); toast(t("已保存")); }
      catch (err) { toast(err.message, true); }
    }
  });
  // 长按项目卡片（安卓长按 = contextmenu）：重命名、换颜色、打开目录、删除，和详情页的 ⋯ 是同一份菜单
  $("tab-projects").addEventListener("contextmenu", (e) => {
    const c = e.target.closest(".pj-card[data-pj]"); if (!c) return;
    const p = PJ.list.find((x) => x.id === c.dataset.pj); if (!p) return;
    e.preventDefault(); projMenu(p, c);
  });
  $("tab-projects").addEventListener("change", async (e) => {
    const k = e.target.dataset.def; const p = PJ.detail && PJ.detail.project; if (!k || !p) return;
    // 换接口时型号一起清掉：旧型号名是给原来那家的
    const patch = k === "provider" ? { provider: e.target.value, model: "" } : { [k]: e.target.value };
    try { const r = await jsend("/api/projects/" + encodeURIComponent(p.id), patch, "PATCH"); Object.assign(p, r.project); toast(t("已保存")); loadProjects(); if (k === "provider") renderProject($("tab-projects")); }
    catch (err) { toast(err.message, true); }
  });
  function openProject(id) { PJ.cur = id; PJ.detail = null; if (curPage !== "projects") openPage("projects"); else { renderProjects(); $("page-body").scrollTop = 0; } }
  /** 在项目里开新对话：换到空白会话，记下项目，发第一条时网关在项目目录里跑 */
  function newChatIn(id) {
    closePage(); closeDrawer();
    newConversation();
    view.projectId = id || null;
    paintProjChip();
  }
  function projMenu(p, anchor) {
    popMenu(anchor, [
      { label: t("重命名"), icon: PI.edit, fn: async () => { const n = prompt(t("项目名称"), p.name); if (!n || !n.trim()) return; try { await jsend("/api/projects/" + encodeURIComponent(p.id), { name: n.trim() }, "PATCH"); PJ.detail = null; await loadProjects(); renderProjects(); } catch (e) { toast(e.message, true); } } },
      { label: t("换颜色"), icon: PI.palette, fn: () => popMenu(anchor, PJ.colors.map((c) => ({ label: c, icon: `<circle cx="12" cy="12" r="7" fill="${esc(c)}" stroke="none"/>`, fn: async () => { try { await jsend("/api/projects/" + encodeURIComponent(p.id), { color: c }, "PATCH"); PJ.detail = null; await loadProjects(); renderProjects(); } catch (e) { toast(e.message, true); } } }))) },
      { label: t("在文件浏览器打开目录"), icon: PI.folder, fn: () => openFiles(p.path) },
      { label: t("在终端打开这个目录"), icon: PI.term, fn: () => openTermAt(p.path) },
      "hr",
      { label: t("删除项目…"), icon: PI.trash, danger: true, fn: () => deleteProjectDlg(p) },
    ]);
  }
  async function openTermAt(dir) {
    await openTerm();
    if (TERM.list.some((x) => x.alive)) await newTerm({ cwd: dir });
  }

  // ── 弹层：宽屏居中（宽 560、高不过宽×φ），窄屏整页推入；返回键先关它 ──
  function dlg(title, body, foot, opts) {
    const narrow = innerWidth < 680;
    const o = document.createElement("div");
    o.className = "pj-ov" + (narrow ? " narrow" : "");
    const xb = `<button class="icon-btn" data-close aria-label="${esc(t(narrow ? "返回" : "关闭"))}"><svg viewBox="0 0 24 24">${narrow ? PI.back : PI.x}</svg></button>`;
    o.innerHTML = `<div class="pj-sheet" role="dialog" aria-modal="true"><div class="pj-shead">${narrow ? xb : ""}<h3>${esc(title)}</h3>${narrow ? "" : xb}</div>
      <div class="pj-smain">${body}</div><div class="pj-sfoot">${foot}</div></div>`;
    OV.open(o, { kind: "modal", keep: true, cover: true, ...(opts || {}) });   // 填了一半的表单，转屏也别丢
    o.addEventListener("click", (e) => {
      if ((e.target === o && !narrow) || e.target.closest("[data-close]")) return OV.close(o);
      const rc = e.target.closest(".pj-rc");
      if (rc && !rc.classList.contains("on")) { rc.parentNode.querySelectorAll(":scope > .pj-rc").forEach((x) => x.classList.toggle("on", x === rc)); rc.parentNode.dispatchEvent(new Event("pick", { bubbles: true })); }
      const sb = e.target.closest(".pj-seg button");
      if (sb) { [...sb.parentNode.children].forEach((b) => b.classList.toggle("on", b === sb)); sb.parentNode.dispatchEvent(new Event("pick", { bubbles: true })); }
    });
    return o;
  }
  const rcards = (name, opts, on) => `<div class="pj-rcs" data-name="${name}">${opts.map(([k, l, d]) => `<div class="pj-rc${k === on ? " on" : ""}" data-v="${k}" role="radio" tabindex="0"><span class="pj-dot"></span><div>${esc(l)}${d ? `<small>${d}</small>` : ""}</div></div>`).join("")}</div>`;
  const segOf = (name, opts, on) => `<span class="seg pj-seg" data-name="${name}">${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="${k === on ? "on" : ""}">${esc(l)}</button>`).join("")}</span>`;
  const picked = (o, name) => { const el = o.querySelector(`[data-name="${name}"] > .on`); return el ? el.dataset.v : ""; };
  const frow = (label, inner, hint) => `<div class="pj-frow"><label>${esc(label)}</label>${inner}${hint ? `<div class="pj-hint">${hint}</div>` : ""}</div>`;

  function newProjectDlg() {
    const ws = PJ.ws || "";
    const o = dlg(t("新建项目"), frow(t("名称"), `<input class="pj-field" id="np-name" value="${esc(t("新项目"))}" autocomplete="off">`) +
      frow(t("目录"), rcards("mode", [
        ["new", t("在工作区新建"), `<span class="mono" id="np-where">${esc(ws + "/" + t("新项目"))}</span>`],
        ["dir", t("用已有的目录"), esc(t("以前在这个目录里开的对话自动归进来"))],
        ["git", t("从 git 克隆"), esc(t("填仓库地址，克隆到工作区"))],
      ], "new") + `<input class="pj-field mono hidden" id="np-dir" placeholder="${esc(ws + "/…")}" value="${esc(ws + "/")}" autocomplete="off" spellcheck="false">
        <input class="pj-field mono hidden" id="np-url" placeholder="https://github.com/…" autocomplete="off" spellcheck="false">`) +
      frow(t("指令（写进 CLAUDE.md，可留空）"), `<textarea class="pj-field" id="np-instr" placeholder="${esc(t("这个项目是什么、怎么构建、有什么规矩…"))}"></textarea>`),
      `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm" id="np-ok">${esc(t("创建"))}</button>`);
    const name = o.querySelector("#np-name");
    const sync = () => {
      const m = picked(o, "mode");
      o.querySelector("#np-dir").classList.toggle("hidden", m !== "dir");
      o.querySelector("#np-url").classList.toggle("hidden", m !== "git");
      o.querySelector("#np-where").textContent = ws + "/" + (name.value.trim() || "…");
    };
    o.addEventListener("pick", sync); name.addEventListener("input", sync);
    name.select();
    o.querySelector("#np-ok").addEventListener("click", async (e) => {
      const b = e.currentTarget, mode = picked(o, "mode");
      const body = { name: name.value.trim(), mode, path: o.querySelector("#np-dir").value.trim(), url: o.querySelector("#np-url").value.trim(), instr: o.querySelector("#np-instr").value };
      if (!body.name) return toast(t("项目名不能为空"), true);
      b.disabled = true; b.textContent = mode === "git" ? t("正在克隆…") : t("创建中…");
      try { const r = await jsend("/api/projects", body); OV.close(o); await loadProjects(); toast(t("已创建项目")); openProject(r.project.id); }
      catch (err) { b.disabled = false; b.textContent = t("创建"); toast(err.message, true); }
    });
  }
  function deleteProjectDlg(p) {
    const o = dlg(t("删除项目「{n}」", { n: p.name }), rcards("how", [
      ["keep", t("只删项目，目录和对话都留着"), esc(t("对话回到「不在项目里」，目录还在 {p}", { p: p.path }))],
      ["dir", t("连目录一起删"), esc(t("对话进回收站（可恢复），目录直接删掉，不可恢复"))],
    ], "keep"), `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm danger-fill" id="dp-ok">${esc(t("删除"))}</button>`);
    o.querySelector("#dp-ok").addEventListener("click", async () => {
      const withDir = picked(o, "how") === "dir";
      if (withDir && !confirm(t("目录 {p} 会被直接删掉，不能恢复。确定？", { p: p.path }))) return;
      try { await api(`/api/projects/${encodeURIComponent(p.id)}${withDir ? "?withDir=1" : ""}`, { method: "DELETE" }); }
      catch (err) { return toast(err.message, true); }
      OV.close(o); PJ.cur = null; PJ.detail = null; await loadProjects(); loadSessions(); renderProjects(); toast(t("已删除项目"));
    });
  }

  // ── 输入栏下的项目标签 + 新会话的项目选择 ──
  function curProject() { return view.sessionId ? pjOfSession(view.sessionId) : pjById(view.projectId); }
  let projForModel;
  function paintProjChip() {
    // 新会话换了项目：项目可能指定了自己的接口 / 型号，模型标签跟着换
    if (!view.sessionId && projForModel !== (view.projectId || null)) { projForModel = view.projectId || null; refreshSessModel(); }
    const el = $("proj-chip"); if (!el) return;
    const p = curProject(), wel = document.documentElement.classList.contains("wel") && !view.sessionId && PJ.list.length > 0;
    el.classList.toggle("hidden", !p && !wel);
    el.classList.toggle("empty", !p);
    const CHEV = '<svg class="pj-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
    if (p) el.innerHTML = `<span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span>${esc(p.name)}${wel ? CHEV : ""}`;
    else if (wel) el.innerHTML = `<span class="pj-fold">${pi("folder")}</span>${esc(t("项目"))}${CHEV}`;
  }
  $("proj-chip")?.addEventListener("click", (e) => {
    const p = curProject();
    if (view.sessionId) return p && openProject(p.id);
    popMenu(e.currentTarget, [{ label: t("不放进项目"), icon: view.projectId ? "" : PI.check, fn: () => { view.projectId = null; paintProjChip(); } },
      ...PJ.list.map((x) => ({ label: x.name, icon: x.id === view.projectId ? PI.check : PI.folder, fn: () => { view.projectId = x.id; paintProjChip(); } }))], "up");
  });
  // ── 会话：移到项目 ──
  function moveToProject(id, anchor) {
    const cur = pjOfSession(id);
    const run = (srv.runs || []).some((r) => r.sessionId === id);
    if (run) return toast(t("这个会话还在跑，等它停下再挪"), true);
    popMenu(anchor, [{ head: t("移到项目（会话记录跟着挪到项目目录）") }, { label: t("不放进项目"), icon: cur ? "" : PI.check, fn: () => mv(null) },
      ...PJ.list.map((p) => ({ label: p.name, icon: cur && cur.id === p.id ? PI.check : PI.folder, fn: () => mv(p.id) }))]);
    async function mv(pid) {
      try { await jsend(`/api/sessions/${encodeURIComponent(id)}/move`, { projectId: pid }); toast(pid ? t("已移到「{n}」", { n: pjById(pid).name }) : t("已移出项目")); loadSessions(); loadProjects(); }
      catch (err) { toast(err.message, true); }
    }
  }

  // ── 定时任务页 ──
  async function renderSched() {
    navMo("sched", SC.cur);
    const box = $("tab-sched");
    if (SC.cur) return renderTask(box);
    setOv("");
    if (!SC.data) { box.innerHTML = pageHead(esc(t("定时任务"))) + `<div class="muted">${esc(t("加载中…"))}</div>`; return loadSched(); }
    const D = SC.data, tasks = D.tasks || [];
    const on = tasks.filter((x) => x.on), nx = on.map((x) => x.nextAt).filter(Boolean).sort((a, b) => a - b)[0];
    setPageSub("sched", t("{n} 个开着", { n: on.length }) + (nx ? " · " + t("下次 {w}", { w: whenText(nx) }) : ""));
    const byId = (id) => tasks.find((x) => x.id === id);
    const missed = (D.missed || []).map((m) => { const x = byId(m.taskId); return x ? `<div class="sc-missed">${pi("clock")}<div class="grow"><b>${esc(t("错过 1 次："))}</b>${esc(t("「{n}」{w}", { n: x.name, w: whenText(m.at) }))}</div>
        <button class="btn sm" data-missed="run" data-id="${esc(m.taskId)}" data-at="${m.at}">${esc(t("现在补跑"))}</button><button class="btn sm ghost" data-missed="skip" data-id="${esc(m.taskId)}" data-at="${m.at}">${esc(t("算了"))}</button></div>` : ""; }).join("");
    const list = tasks.filter((x) => SC.flt === "all" || (SC.flt === "on" ? x.on : !x.on));
    const running = new Set(D.running || []);
    const blocked = new Set(D.allowLogin ? [] : D.loginTasks || []);    // 要用订阅账户、开关又没开：到点会跳过
    const row = (x) => {
      const p = x.projectId && pjById(x.projectId);
      const last = running.has(x.id) ? `<span class="pill acc">${esc(t("在跑"))}</span>` : x.last ? `<span class="pill ${x.last.st === "ok" ? "ok" : x.last.st === "err" ? "err" : ""}">${x.last.st === "ok" ? pi("check") : x.last.st === "err" ? pi("x") : ""}${esc(whenText(x.last.at))}</span>` : `<span class="pill">${esc(t("没跑过"))}</span>`;
      const lk = blocked.has(x.id) ? `<span class="pill err">${esc(t("订阅账户 · 不会跑"))}</span>` : "";
      return `<div class="row pj-row" data-task="${esc(x.id)}"><div class="grow"><div class="t1">${esc(x.name)}</div>
        <div class="muted pj-sub">${esc(freqText(x.freq))}${p ? " · " + pjMark(p) : ""} · ${esc(x.on ? (x.nextAt ? t("下次 {w}", { w: whenText(x.nextAt) }) : t("不会再跑")) : t("已关"))}</div></div>${lk}${last}${swHtml(x.on, `data-sw="${esc(x.id)}" aria-label="${esc(t("开关"))}"`)}</div>`;
    };
    const b = D.budget || {}, daily = b.daily || 0, today = b.today || 0, m = b.month || {};
    const pct = daily ? Math.min(100, today / daily * 100) : 0;
    box.innerHTML = pageHead(esc(t("定时任务")), `<button class="btn sm pj-primary" data-a="new">${pi("plus")}${esc(t("新建"))}</button>`) + missed +
      `<div class="sc-note">${esc(t("到点在本机跑一次 Claude，在指定目录里；跑完按设置通知你，结果存成一个对话。没人在旁边：要问你的操作一律当拒绝。错过的不会偷偷补跑，按每个任务的设置来。"))}</div>` +
      (tasks.length ? `<div class="seg-scroll">${segOf("flt", [["all", t("全部")], ["on", t("开着的")], ["off", t("关着的")]], SC.flt)}</div>` : "") +
      `<div class="panel">${list.length ? list.map(row).join("") : emptyRow(tasks.length ? t("没有") : t("还没有定时任务。比如每天早上让它看一眼 CI。"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("花费与额度"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(daily ? t("今天 {a} / 每日上限 {b}", { a: costText(today), b: costText(daily) }) : t("今天 {a} · 不设每日上限", { a: costText(today) }))}</b>
          ${daily ? `<div class="bar-mini"><i style="width:${pct.toFixed(1)}%"></i></div>` : ""}<div class="muted pj-sub">${esc(t("到上限后当天其余任务跳过，并通知你。第三方接口多数不回报花费，按 0 记。"))}</div></div><button class="btn sm ghost" data-a="budget">${esc(t("改上限"))}</button></div>
        <div class="row"><div class="grow"><b>${esc(t("本月 {c} · 跑了 {n} 次", { c: costText(m.cost || 0), n: m.runs || 0 }))}</b><div class="muted pj-sub">${esc(t("成功 {a} · 失败 {b} · 跳过 {c}", { a: m.ok || 0, b: m.err || 0, c: m.skip || 0 }))}</div></div></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("订阅账户"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("允许用订阅账户跑"))}</b><div class="muted pj-sub">${esc(t("官方登录的订阅账户默认不跑定时任务。打开前请自己确认：无人值守使用以 Anthropic 条款为准。用 API Key 的接口不受影响。"))}</div>
          ${blocked.size ? `<div class="muted pj-sub warn">${esc(t("{n} 个任务会用订阅账户，现在不会跑", { n: blocked.size }))}</div>` : ""}</div>${swHtml(!!D.allowLogin, `data-swlogin="1" aria-label="${esc(t("允许用订阅账户跑"))}"`)}</div></div>
      <div class="pj-sec"><span class="grow">${esc(t("叫醒"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("App 活着就准点跑"))}</b><div class="muted pj-sub">${esc(t("计时在网关里：App 开着或在后台运行时到点就跑；被系统清掉、关机时会错过，下次打开按任务的「错过了」设置处理。"))}</div></div></div>
        <div class="row"><div class="grow"><b>${esc(t("后台运行"))}</b><div class="muted pj-sub">${esc(t("锁屏后要能接着跑完，得允许后台运行、不被省电策略冻结"))}</div></div><button class="btn sm ghost" data-a="bgset">${esc(t("去设置"))}</button></div></div>`;
  }
  async function renderTask(box) {
    const id = SC.cur;
    let d = SC.detail && SC.detail.task.id === id ? SC.detail : null;
    if (!d) {
      box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(t("加载中…"))}</div>`;
      try { d = SC.detail = await api("/api/sched/" + encodeURIComponent(id)); } catch (e) { SC.cur = null; return renderSched(); }
      if (SC.cur !== id) return;
    }
    const x = d.task, p = x.projectId && pjById(x.projectId);
    setOv(x.name); setPageSub("sched", freqText(x.freq));
    const pauseNow = x.skipNext ? "skip" : x.pausedUntil > Date.now() ? "until" : "none";
    const yes = (b) => b ? t("是") : t("否");
    const kv = [
      [t("在哪"), p ? pjMark(p) : esc(t("工作区"))],
      [t("会话"), esc(x.session === "same" ? t("接着同一个对话（带着上次的上下文）") : t("每次新开一个对话"))],
      [t("型号"), esc([x.model ? prettyModel(x.model) : t("跟随项目 / 全局"), x.effort].filter(Boolean).join(" · "))],
      [t("权限"), esc((x.perm === "proj" ? t("可以改项目目录里的文件") : x.perm === "custom" ? t("只允许：{l}", { l: x.tools || "—" }) : t("只读")) + t("；要问你的操作一律当作拒绝"))],
      [t("条件"), esc([x.cond && x.cond.wifi ? t("只在 Wi-Fi 下") : "", x.cond && x.cond.charging ? t("只在充电时") : "", x.cond && x.cond.battery ? t("电量低于 {p}% 跳过", { p: x.cond.battery }) : ""].filter(Boolean).join(" · ") || t("连着网就跑"))],
      [t("撞上别的对话"), esc({ queue: t("排队等它跑完"), skip: t("跳过这次"), run: t("照跑（占一个并行名额）") }[x.busy] || "")],
      [t("上限"), esc([x.limitCost ? costText(x.limitCost) : t("花费不限"), t("{n} 分钟", { n: x.limitMin || 15 })].join(" · "))],
      [t("失败"), esc(x.retry ? t("重试 {n} 次", { n: x.retry }) : t("不重试"))],
      [t("错过"), esc({ ask: t("下次打开问我"), run: t("开机后立刻补跑一次"), skip: t("跳过") }[x.missed] || "")],
      [t("通知"), esc({ all: t("每次都通知"), fail: t("只在失败时"), found: t("只在有发现时（回复不是「{q}」）", { q: x.quiet || "—" }), none: t("不通知") }[x.notify] || "")],
      [t("结果存成对话"), esc(yes(x.saveSession !== false))],
      [t("有效期"), esc(x.freq && x.freq.kind === "once" ? t("跑完自动关") : x.until && x.until.kind === "date" ? t("到 {d} 为止", { d: x.until.date }) : x.until && x.until.kind === "count" ? t("跑满 {n} 次就关（已跑 {m} 次）", { n: x.until.count, m: x.runsDone || 0 }) : t("一直有效"))],
    ];
    const runs = (d.runs || []).filter((r) => SC.rflt === "all" || r.st !== "ok");
    box.innerHTML = pageHead(esc(x.name), `<button class="btn sm ghost" data-a="edit">${pi("edit")}${esc(t("编辑"))}</button>${kebabBtn("tmenu")}`, true) +
      `<div class="panel"><div class="row"><div class="grow"><b>${esc(x.on ? t("开着") : t("关着"))}</b><div class="muted pj-sub">${esc(freqText(x.freq))} · ${esc(x.on ? (x.nextAt ? t("下次 {w}", { w: whenText(x.nextAt) }) : t("不会再跑")) : t("不会自己跑"))}</div></div>${swHtml(x.on, `data-sw="${esc(x.id)}"`)}</div>
        <div class="row"><div class="grow"><b>${esc(t("暂停一阵"))}</b><div class="muted pj-sub">${esc(pauseNow === "until" ? t("暂停到 {w}，到时间自动恢复", { w: whenText(x.pausedUntil) }) : t("到时间自动恢复"))}</div></div>
          <select data-pause>${[["none", t("不暂停")], ["skip", t("跳过下一次")], ["1d", t("暂停 1 天")], ["1w", t("暂停 1 周")], ...(pauseNow === "until" ? [["until", t("暂停中")]] : [])].map(([k, l]) => `<option value="${k}"${k === pauseNow ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("要做的事"))}</span></div><div class="panel sc-prompt">${esc(x.prompt)}</div>
      <div class="pj-sec"><span class="grow">${esc(t("怎么跑"))}</span></div>
      <div class="panel sc-kvp"><dl class="sc-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>
      <div class="pj-sec"><span class="grow">${esc(t("运行记录"))}</span>${segOf("rflt", [["all", t("全部")], ["bad", t("没成的")]], SC.rflt)}<button class="btn sm" data-a="run"${d.running ? " disabled" : ""}>${pi("play")}${esc(d.running ? t("在跑…") : t("立刻跑一次"))}</button></div>
      <div class="panel">${runs.length ? runs.map((r) => `<div class="row pj-row"${r.sid && !r.trial ? ` data-sid="${esc(r.sid)}"` : ""}>${stIcon(r.st)}<div class="grow"><div class="t1">${esc(r.msg || "—")}</div><div class="muted pj-sub">${esc([whenText(r.at), r.dur ? durText(r.dur) : "", r.st !== "skip" ? costText(r.cost || 0) : "", r.trial ? t("试跑") : "", r.attempt ? t("第 {n} 次重试", { n: r.attempt }) : ""].filter(Boolean).join(" · "))}</div></div>${r.sid ? pi("chev", "pj-go") : ""}</div>`).join("") : emptyRow(t("还没跑过"))}</div>`;
  }
  $("tab-sched").addEventListener("click", async (e) => {
    if (e.target.closest("input.sw")) return;       // 开关走 change
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "back") { SC.cur = null; SC.detail = null; renderSched(); $("page-body").scrollTop = 0; return; }
    if (a === "new") return taskDlg(null);
    if (a === "bgset") return openPage("settings", "run");
    if (a === "budget") {
      const D = SC.data || {}, cur = (D.budget && D.budget.daily) || 0;
      const v = prompt(t("每日上限（美元，0 = 不设）。定时任务当天累计花费到这里就跳过其余任务。"), String(cur));
      if (v == null) return;
      try { await jsend("/api/sched/budget", { daily: +v || 0 }, "PUT"); loadSched(); } catch (err) { toast(err.message, true); }
      return;
    }
    const ms = e.target.closest("[data-missed]");
    if (ms) { try { await jsend("/api/sched/missed", { taskId: ms.dataset.id, at: +ms.dataset.at, act: ms.dataset.missed }); toast(ms.dataset.missed === "run" ? t("已开始补跑") : t("这次就算了")); } catch (err) { toast(err.message, true); } return loadSched(); }
    const sid = e.target.closest("[data-sid]"); if (sid) return openSession(sid.dataset.sid);
    const tk = e.target.closest("[data-task]"); if (tk && !SC.cur) { SC.cur = tk.dataset.task; SC.detail = null; renderSched(); $("page-body").scrollTop = 0; return; }
    const d = SC.detail; if (!d) return;
    if (a === "edit") return taskDlg(d.task);
    if (a === "run") return runTaskNow(d.task);
    if (a === "tmenu") return taskMenu(d.task, e.target.closest("[data-a]"));
  });
  // 页面上的分段（筛选）不在弹层里：自己处理
  $("tab-sched").addEventListener("click", (e) => {
    const sb = e.target.closest(".pj-seg button"); if (!sb) return;
    const name = sb.parentNode.dataset.name;
    if (name === "flt") { SC.flt = sb.dataset.v; renderSched(); }
    if (name === "rflt") { SC.rflt = sb.dataset.v; renderSched(); }
  });
  $("tab-sched").addEventListener("change", async (e) => {
    const sl = e.target.closest("[data-swlogin]");
    if (sl) {
      if (sl.checked && !confirm(t("用订阅账户跑定时任务？\n\n定时任务会在没人看着的时候自动跑。无人值守使用以 Anthropic 条款为准，请自己确认你的用法符合条款；条款以后收紧，这一项可能要关掉。"))) { sl.checked = false; return; }
      try { await jsend("/api/sched/allow-login", { on: sl.checked }, "PUT"); toast(sl.checked ? t("已允许用订阅账户跑定时任务") : t("已关闭：订阅账户不跑定时任务")); }
      catch (err) { sl.checked = !sl.checked; toast(err.message, true); }
      return loadSched();
    }
    const sw = e.target.closest("[data-sw]");
    if (sw) {
      try { const r = await jsend("/api/sched/" + encodeURIComponent(sw.dataset.sw), { on: sw.checked }, "PATCH"); toast(sw.checked ? t("已打开：{f}", { f: freqText(r.task.freq) }) : t("已关掉")); if (SC.detail) SC.detail.task = { ...SC.detail.task, ...r.task }; }
      catch (err) { sw.checked = !sw.checked; toast(err.message, true); }
      return loadSched();
    }
    const ps = e.target.closest("[data-pause]");
    if (ps && SC.detail && ps.value !== "until") {
      try { const r = await jsend(`/api/sched/${encodeURIComponent(SC.detail.task.id)}/pause`, { mode: ps.value }); SC.detail.task = { ...SC.detail.task, ...r.task }; renderSched(); loadSched(); }
      catch (err) { toast(err.message, true); }
    }
  });
  async function runTaskNow(x, trial) {
    try { const r = await jsend(`/api/sched/${encodeURIComponent(x.id)}/run`, { trial: !!trial }); if (!r.ok) throw new Error(t("没能开始（条件不满足或今天的额度用完了，看运行记录）")); toast(trial ? t("试跑开始：不计入记录，结果在新对话里") : t("已开始：会话出现在「最近」里，跑完按设置通知")); }
    catch (err) { toast(err.message, true); }
    SC.detail = null; setTimeout(loadSched, 800); if (SC.cur) setTimeout(renderSched, 900);
  }
  function taskMenu(x, anchor) {
    popMenu(anchor, [
      { label: t("立刻跑一次"), icon: PI.play, fn: () => runTaskNow(x) },
      { label: t("编辑"), icon: PI.edit, fn: () => taskDlg(x) },
      { label: t("复制一份"), icon: PI.copy, fn: () => taskDlg({ ...x, id: null, name: x.name + " " + t("（副本）") }) },
      { label: t("导出 JSON（复制到剪贴板）"), icon: SM.export, fn: () => { const { id, last, runs, nextAt, lastFiredAt, runsDone, created, lastSid, ...rest } = x; copyText(JSON.stringify(rest, null, 2)); toast(t("已复制")); } },
      "hr",
      { label: t("删除"), icon: PI.trash, danger: true, fn: async () => {
        if (!confirm(t("删除定时任务「{n}」？运行记录留着，存下的对话不受影响。", { n: x.name }))) return;
        try { await api("/api/sched/" + encodeURIComponent(x.id), { method: "DELETE" }); SC.cur = null; SC.detail = null; await loadSched(); renderSched(); toast(t("已删除")); } catch (err) { toast(err.message, true); }
      } },
    ]);
  }

  // ── 新建 / 编辑定时任务 ──
  function taskDlg(x, preset) {
    const edit = !!(x && x.id);
    const v = Object.assign({ name: "", prompt: "", projectId: null, freq: { kind: "daily", time: "09:00" }, session: "new", perm: "ro", tools: "", model: "", effort: "",
      cond: { wifi: false, charging: false, battery: 0 }, busy: "queue", limitCost: 0, limitMin: 15, retry: 0, missed: "ask", notify: "all", quiet: "", saveSession: true, carryLast: false, until: { kind: "ever" } }, x || {}, preset || {});
    const f = Object.assign({ time: "09:00", days: [1], day: 1, hours: 2, from: "08:00", to: "23:00", date: new Date(Date.now() + 864e5).toISOString().slice(0, 10), cron: "30 8 * * 1-5" }, v.freq);
    const opt = (val, l, cur) => `<option value="${esc(val)}"${String(val) === String(cur) ? " selected" : ""}>${esc(l)}</option>`;
    const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([a, b]) => opt(a, b, cur)).join("")}</select>`;
    const line = (label, ctl, sub) => `<div class="row"><div class="grow"><b>${esc(label)}</b>${sub ? `<div class="muted pj-sub">${esc(sub)}</div>` : ""}</div>${ctl}</div>`;
    const tm = (id, val) => `<input class="pj-field pj-time" type="time" id="${id}" value="${esc(val)}">`;
    // 整句交给翻译，控件按占位符嵌进去（各语言语序不同）
    const tpl = (str, ctl) => str.split(/(\{\w+\})/).map((x) => /^\{\w+\}$/.test(x) && ctl[x.slice(1, -1)] != null ? ctl[x.slice(1, -1)] : esc(x)).join("");
    const FREQ = {
      daily: () => `<div class="pj-inline">${tpl(t("每天 {time}"), { time: tm("f-time", f.time) })}</div>`,
      weekly: () => `<div class="pj-days">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button type="button" data-day="${d}" class="${(f.days || []).includes(d) ? "on" : ""}">${esc(dayShort(d))}</button>`).join("")}</div><div class="pj-inline">${tpl(t("这几天的 {time}"), { time: tm("f-time", f.time) })}</div>`,
      monthly: () => `<div class="pj-inline">${tpl(t("每月 {day} 的 {time}"), { day: sel("f-day", [...Array.from({ length: 28 }, (_, i) => [i + 1, t("{n} 号", { n: i + 1 })]), ["last", t("最后一天")]], f.day), time: tm("f-time", f.time) })}</div>`,
      every: () => `<div class="pj-inline">${tpl(t("每隔 {h} 小时，只在 {a} 到 {b} 之间"), { h: sel("f-hours", [1, 2, 3, 4, 6, 8, 12].map((h) => [h, String(h)]), f.hours), a: tm("f-from", f.from), b: tm("f-to", f.to) })}</div>`,
      once: () => `<div class="pj-inline"><input class="pj-field pj-date" type="date" id="f-date" value="${esc(f.date)}"> ${tm("f-time", f.time)}</div><div class="pj-hint">${esc(t("跑完自动关掉。"))}</div>`,
      cron: () => `<div class="pj-inline"><input class="pj-field mono" id="f-cron" value="${esc(f.cron)}" spellcheck="false" style="width:13em"></div><div class="pj-hint">${esc(t("标准五段式 cron：分 时 日 月 周。"))}</div>`,
    };
    const models = MODELS.length ? MODELS : [];
    const effs = PJ.effLevels && PJ.effLevels.length ? PJ.effLevels : ["low", "medium", "high", "xhigh", "max"];
    const cost = [0, 0.1, 0.3, 0.5, 1, 2, 5];
    const body = frow(t("名称"), `<input class="pj-field" id="t-name" value="${esc(v.name)}" placeholder="${esc(t("比如：每天早上看 CI"))}" autocomplete="off">`) +
      frow(t("要 Claude 做什么"), `<textarea class="pj-field" id="t-prompt" placeholder="${esc(t("写清楚做什么、做完怎么交代。没人在旁边：它不能问你问题。"))}">${esc(v.prompt)}</textarea>`,
        esc(t("想「没事就别吵我」：让它没发现时只回一句固定的话（比如「全绿」），下面的通知选「只在有发现时」。"))) +
      frow(t("在哪跑"), sel("t-proj", [["", t("工作区")], ...PJ.list.map((p) => [p.id, t("项目：{n}", { n: p.name })])], v.projectId || "")) +
      frow(t("什么时候"), `<div class="seg-scroll">${segOf("kind", [["daily", t("每天")], ["weekly", t("每周")], ["monthly", t("每月")], ["every", t("每隔几小时")], ["once", t("仅一次")], ["cron", t("自定义")]], f.kind)}</div><div class="pj-sub-form" id="t-freq">${FREQ[f.kind]()}</div><div class="pj-hint" id="t-next"></div>`) +
      frow(t("会话"), rcards("session", [["new", t("每次新开一个对话"), esc(t("互不干扰；结果一次一个，好翻"))], ["same", t("接着同一个对话"), esc(t("带着上次的上下文（适合「和上次比有什么变化」）；越跑越长，会自动压缩"))]], v.session)) +
      frow(t("权限"), rcards("perm", [["ro", t("只读"), esc(t("能看文件、跑查询类命令，不改任何东西（先这样试几天）"))], ["proj", t("可以改项目目录里的文件"), esc(t("目录外的写入、安装软件、删除等一律当作拒绝"))], ["custom", t("自己挑允许的工具"), esc(t("比如只允许 Bash(git *) 和 WebFetch；其余一律拒绝"))]], v.perm) +
        `<input class="pj-field mono${v.perm === "custom" ? "" : " hidden"}" id="t-tools" value="${esc(v.tools || "")}" placeholder="Bash(git *),WebFetch,Read" spellcheck="false">`) +
      `<button type="button" class="pj-col" data-col aria-expanded="false">${pi("chev")}${esc(t("更多设置"))}</button><div class="pj-colbody hidden">` +
      frow(t("型号"), `<div class="panel">${usableProvs().length > 1 || v.provider ? line(t("接口"), sel("t-prov", provChoices(t("跟随项目 / 全局"), v.provider), v.provider || "")) : ""}${line(t("型号"), sel("t-model", [["", t("跟随项目 / 全局")], ...models.map((m) => [m.id, prettyModel(m.id)]), ...(v.model && !models.some((m) => m.id === v.model) ? [[v.model, prettyModel(v.model)]] : [])], v.model || ""))}${line(t("思考强度"), sel("t-effort", [["", t("跟随项目 / 全局")], ...effs.map((e) => [e, e])], v.effort || ""))}</div>`) +
      frow(t("条件（不满足就跳过这次，记一笔）"), `<div class="panel">${line(t("只在 Wi-Fi 下"), swHtml(v.cond.wifi, 'id="t-wifi"'))}${line(t("只在充电时"), swHtml(v.cond.charging, 'id="t-chg"'))}${line(t("电量低于多少就跳过"), sel("t-bat", [[0, t("不管")], [15, "15%"], [30, "30%"], [50, "50%"]], v.cond.battery || 0))}</div>`) +
      frow(t("到点时有别的对话在跑"), segOf("busy", [["queue", t("排队等它跑完")], ["skip", t("跳过这次")], ["run", t("照跑")]], v.busy), esc(t("「照跑」占一个并行名额（设置 → 后台与并行）；排队最多等 30 分钟，等不到算跳过。"))) +
      frow(t("限制"), `<div class="panel">${line(t("单次花费上限"), sel("t-cost", cost.map((c) => [c, c ? costText(c) : t("不限")]).concat(cost.includes(+v.limitCost) ? [] : [[v.limitCost, costText(v.limitCost)]]), v.limitCost || 0), t("超了就停，记成失败；第三方接口多数不回报花费"))}${line(t("单次时长上限"), sel("t-min", [5, 15, 30, 60, 90, 180].map((n) => [n, n < 60 ? t("{n} 分钟", { n }) : t("{n} 小时", { n: n / 60 })]), v.limitMin || 15))}${line(t("失败了"), sel("t-retry", [[0, t("不重试")], [1, t("重试 1 次")], [2, t("重试 2 次")]], v.retry || 0), t("网络断、接口报错、超上限"))}${line(t("错过了"), sel("t-missed", [["ask", t("下次打开问我")], ["run", t("开机后立刻补跑一次")], ["skip", t("跳过")]], v.missed), t("关机、被系统冻结、没网"))}</div>`) +
      frow(t("跑完"), `<div class="panel">${line(t("通知"), sel("t-notify", [["all", t("每次都通知")], ["fail", t("只在失败时")], ["found", t("只在有发现时")], ["none", t("不通知")]], v.notify))}
        <div class="row${v.notify === "found" ? "" : " hidden"}" id="t-quiet-row"><div class="grow"><b>${esc(t("没发现时它回的那句话"))}</b><div class="muted pj-sub">${esc(t("回复正好是这句就不通知"))}</div></div><input class="pj-field pj-quiet" id="t-quiet" value="${esc(v.quiet || "")}" placeholder="${esc(t("全绿"))}"></div>
        ${line(t("结果存成对话"), swHtml(v.saveSession !== false, 'id="t-save"'), t("列表里带时钟标记；关掉就只记在运行记录里"))}${line(t("把上一次的结果带上"), swHtml(v.carryLast, 'id="t-carry"'), t("让它知道上次说了什么（只对「每次新开」有用）"))}</div>`) +
      frow(t("有效期"), segOf("until", [["ever", t("一直有效")], ["date", t("到某天为止")], ["count", t("跑满几次就关")]], v.until.kind) +
        `<div class="pj-inline" id="t-until"><input class="pj-field pj-date${v.until.kind === "date" ? "" : " hidden"}" type="date" id="t-udate" value="${esc(v.until.date || "")}"><input class="pj-field pj-num${v.until.kind === "count" ? "" : " hidden"}" type="number" min="1" id="t-ucount" value="${esc(v.until.count || 10)}"></div>`) +
      `</div>`;
    const o = dlg(edit ? t("编辑定时任务") : t("新建定时任务"), body,
      `${edit ? `<button class="btn sm ghost pj-try" id="t-try">${esc(t("试跑一次"))}</button>` : ""}<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm" id="t-ok">${esc(t("保存"))}</button>`);
    const q = (s) => o.querySelector(s);
    const readFreq = () => {
      const kind = picked(o, "kind"), r = { kind };
      if (q("#f-time")) r.time = q("#f-time").value;
      if (kind === "weekly") r.days = [...o.querySelectorAll(".pj-days .on")].map((b) => +b.dataset.day);
      if (kind === "monthly") r.day = q("#f-day").value === "last" ? "last" : +q("#f-day").value;
      if (kind === "every") { r.hours = +q("#f-hours").value; r.from = q("#f-from").value; r.to = q("#f-to").value; }
      if (kind === "once") r.date = q("#f-date").value;
      if (kind === "cron") r.cron = q("#f-cron").value.trim();
      return r;
    };
    const keepFreq = () => { const r = readFreq(); Object.assign(f, r); };
    let pvT = 0, pvN = 0;
    const preview = () => { clearTimeout(pvT); pvT = setTimeout(async () => {
      const n = ++pvN;
      let r; try { r = await jsend("/api/sched/preview", { freq: readFreq() }); } catch { return; }
      if (n !== pvN || !o.isConnected) return;
      q("#t-next").textContent = r.error ? t("看不懂：{e}", { e: r.error }) : r.next.length ? t("下次 {a}", { a: whenText(r.next[0]) }) + (r.next[1] ? t("，再下次 {b}", { b: whenText(r.next[1]) }) : "") : t("算不出下一次（时间已经过了？）");
    }, 250); };
    preview();
    o.addEventListener("pick", (e) => {
      const name = e.target.dataset.name;
      if (name === "kind") { const k = picked(o, "kind"); q("#t-freq").innerHTML = FREQ[k](); preview(); }
      if (name === "perm") q("#t-tools").classList.toggle("hidden", picked(o, "perm") !== "custom");
      if (name === "until") { const k = picked(o, "until"); q("#t-udate").classList.toggle("hidden", k !== "date"); q("#t-ucount").classList.toggle("hidden", k !== "count"); }
    });
    o.addEventListener("click", (e) => {
      const d = e.target.closest("[data-day]"); if (d) { d.classList.toggle("on"); keepFreq(); preview(); }
      const c = e.target.closest("[data-col]"); if (c) { const open = c.getAttribute("aria-expanded") !== "true"; c.setAttribute("aria-expanded", String(open)); q(".pj-colbody").classList.toggle("hidden", !open); }
    });
    o.addEventListener("input", (e) => { if (e.target.closest("#t-freq")) { keepFreq(); preview(); } });
    o.addEventListener("change", (e) => {
      if (e.target.closest("#t-freq")) { keepFreq(); preview(); }
      if (e.target.id === "t-notify") q("#t-quiet-row").classList.toggle("hidden", e.target.value !== "found");
    });
    const collect = () => ({
      name: q("#t-name").value.trim(), prompt: q("#t-prompt").value.trim(), projectId: q("#t-proj").value || null, freq: readFreq(),
      session: picked(o, "session"), perm: picked(o, "perm"), tools: q("#t-tools").value.trim(), model: q("#t-model").value, effort: q("#t-effort").value, provider: q("#t-prov") ? q("#t-prov").value : "",
      cond: { wifi: q("#t-wifi").checked, charging: q("#t-chg").checked, battery: +q("#t-bat").value }, busy: picked(o, "busy"),
      limitCost: +q("#t-cost").value, limitMin: +q("#t-min").value, retry: +q("#t-retry").value, missed: q("#t-missed").value,
      notify: q("#t-notify").value, quiet: q("#t-quiet").value.trim(), saveSession: q("#t-save").checked, carryLast: q("#t-carry").checked,
      until: { kind: picked(o, "until"), date: q("#t-udate").value, count: +q("#t-ucount").value },
    });
    q("#t-ok").addEventListener("click", async (e) => {
      const b = collect();
      if (!b.name || !b.prompt) return toast(t("名称和要做的事都要填"), true);
      if (b.freq.kind === "weekly" && !b.freq.days.length) return toast(t("每周至少挑一天"), true);
      if (b.notify === "found" && !b.quiet) return toast(t("「只在有发现时」要填没发现时它回的那句话"), true);
      e.currentTarget.disabled = true;
      try {
        const r = edit ? await jsend("/api/sched/" + encodeURIComponent(x.id), b, "PATCH") : await jsend("/api/sched", b);
        OV.close(o); toast(edit ? t("已保存") : t("已创建：{f}", { f: freqText(r.task.freq) }));
        SC.cur = r.task.id; SC.detail = null; await loadSched();
        if (curPage !== "sched") openPage("sched"); else renderSched();
      } catch (err) { e.currentTarget.disabled = false; toast(err.message, true); }
    });
    q("#t-try")?.addEventListener("click", () => runTaskNow(x, true));
    // 换接口：型号下拉换成那家的清单（旧型号名是给原来那家的，清掉）
    const fillModels = async (keep) => {
      const pid = q("#t-prov") ? q("#t-prov").value : "", ms = await provModelsOf(pid), msel = q("#t-model");
      if (!msel) return;
      const cur = keep ? msel.value : "";
      msel.innerHTML = [["", t("跟随项目 / 全局")], ...ms.map((m) => [m.id, prettyModel(m.id)]), ...(cur && !ms.some((m) => m.id === cur) ? [[cur, prettyModel(cur)]] : [])]
        .map(([a, b]) => `<option value="${esc(a)}"${a === cur ? " selected" : ""}>${esc(b)}</option>`).join("");
    };
    q("#t-prov")?.addEventListener("change", () => fillModels(false));
    if (v.provider && v.provider !== globalProv()) fillModels(true);
    if (!MODELS.length) api("/api/models").then((r) => { MODELS = r.models || []; PJ.effLevels = r.effortLevels || []; }).catch(() => {});
    setTimeout(() => (edit ? null : q("#t-name").focus()), 50);
  }

  // 网关推来的：任务变了 / 跑完了的提醒（App 在前台时只弹一句，后台由外壳发系统通知）
  let schedT = 0;
  function onSchedEvent(ev) {
    clearTimeout(schedT); schedT = setTimeout(() => { if (SC.detail && SC.cur) SC.detail = null; loadSched(); }, 400);
    if (ev.type === "sched_note" && !document.hidden) {
      const msg = ev.title + (ev.text ? "：" + ev.text.slice(0, 60) : "");
      if (ev.sessionId) toastAct(msg, t("打开"), () => openSession(ev.sessionId)); else toast(msg, !ev.ok);
      loadSessions();
    }
  }

  /** 打开整页：窄屏收起侧栏、盖住对话；宽屏侧栏照旧常驻，高亮当前项 */
  function openPage(name, cat) {
    if (!PAGES[name] || name === "settings") return openSettings(cat);
    OV.closeAll();
    const prev = curPage;
    curPage = name;
    document.documentElement.classList.toggle("pg-lineage", name === "lineage");   // 脉络页整页不滚（地图自己接手势）
    if (name !== "lineage") closeTour();   // 离开脉络页：导览一起收掉
    // 从对话进整页：窄屏从右边推进来（盖住对话），宽屏只在对话那一块浮上来；整页之间切换：新的那一页浮上来
    const pg = $("pages"), fromChat = pg.classList.contains("hidden") || !!pg._moLeave;
    MO.cancel(pg);
    pg.classList.remove("hidden");
    if (fromChat) MO.play(pg, innerWidth < 680 ? "mo-in-push" : "mo-in-rise", 1400);
    else if (prev !== name) { if (prev && $("tab-" + prev)) MO.ghost($("tab-" + prev), "fade"); MO.play($("tab-" + name), "mo-in-fade", 1400); }   // 整页之间换：新旧交叉淡变，不上下走
    pageSub = "";
    paintTitle();
    document.querySelectorAll("#page-body > .tab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
    if (prev !== name) $("page-body").scrollTop = 0;    // 换页从顶上看起
    closeDrawer();
    renderSideNav();
    refreshStatus();
    if (name === "sessions") loadSessions();
    if (name === "caps") loadCaps();
    if (name === "ext") loadExt();
    if (SUBNAVS[name]) paintSubnav(name);
    if (name === "help") loadHelp();
    if (name === "changelog") loadChangelog();
    if (name === "usage") { loadQuota(); loadUsage(); loadEnergy(); loadAcctCard(false); }
    if (name !== "projects" && name !== "sched" && name !== "channels") pageTitleOv = "";
    if (name === "projects") { if (prev !== name && !PJ.cur) PJ.detail = null; renderProjects(); loadProjects(); loadSched(); }
    if (name === "sched") { renderSched(); loadSched(); loadProjects(); }
    if (name === "channels") { CH.cur = null; CH.detail = null; renderChannels(); loadChannels(); loadProjects(); }
    if (name === "lineage") { if (LIN.g) linPaint(prev !== name); loadLineage(); }
  }
  function closePage() {
    if (!curPage) return;
    curPage = null;
    pageTitleOv = "";
    document.documentElement.classList.remove("pg-lineage");
    closeTour();
    // 回到对话：窄屏整页滑出去、底下的对话从左边一点点回来；宽屏淡掉
    const pg = $("pages");
    MO.leave(pg, innerWidth < 680 ? "mo-out-push" : "mo-out-fade", 170, () => pg.classList.add("hidden"));
    if (innerWidth < 680) MO.play(chatEl, "mo-in-back", 1400);
    renderSideNav();
    paintTitle();
  }
  // 顶栏标题：对话里是会话名 + 状态；整页时是页名 + 这一页的一句概况（照设计稿，整页自己不再有标题条）
  var chatStatus = chatStatus || ["", ""], pageSub = pageSub || "";   // setStatus 可能在这行之前就调过
  function paintTitle() {
    const el = $("app-title");
    if (curPage) { el.textContent = pageTitleOv || t(PAGES[curPage].name); subEl.textContent = pageSub; subEl.className = ""; }
    else { el.textContent = view.title || t("新对话"); subEl.textContent = chatStatus[0] + (chatStatus[1] === "ok" ? archSub() : ""); subEl.className = chatStatus[1]; }
  }
  // 空闲时状态行后面接上档号和起止日期（建过档的会话才有）
  function archSub() {
    try {
      const s = view.sessionId && (state.sessions || []).find((x) => x.id === view.sessionId);
      return s && s.no ? " · " + s.no + " · " + fmtRange(s.created, s.mtime) : "";
    } catch { return ""; }
  }
  function setPageSub(name, text) { if (curPage !== name) return; pageSub = text || ""; subEl.textContent = pageSub; }


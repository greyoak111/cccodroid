  // ── 会话管理 ──────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      const r = await api("/api/sessions");
      state.sessions = r.sessions || [];
      if (sess.q.trim()) resessSearch(); else renderSessions();
      lineageDirty();
    } catch {}
  }

  // 会话页三种视图：普通列表 / 多选（导出、批量删除）/ 回收站
  // q：搜索词；hits：网关返回的内容命中（null = 还没回来）；fold：各分组折叠状态（pin / today / week / month / m:年-月）
  const sess = { mode: "list", sel: new Set(), trash: [], keepDays: 30, q: "", hits: null, fold: loadSessFold(), flt: "all" };
  function loadSessFold() {
    let f = {};
    try { f = JSON.parse(localStorage.getItem("cc.sessFold") || "{}") || {}; } catch {}
    if (!("pin" in f) && localStorage.getItem("cc.pinFold") === "1") f.pin = true;   // 旧版只记了置顶组
    return f;
  }
  // 没手动动过的：一个月以前的按月分组默认收起，其余展开
  const sessFolded = (k) => k in sess.fold ? !!sess.fold[k] : k.startsWith("m:");

  // 精确到分钟；今年的省掉年份
  function fmtStamp(ms) {
    if (!ms) return "—";
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    const md = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + "-" + md;
  }
  // 起止日期（建过档的会话在小字里用）：同一天只写一个日期加时间，跨年带年份
  function fmtRange(a, b) {
    if (!a) a = b;
    const p = (n) => String(n).padStart(2, "0"), y0 = new Date().getFullYear();
    const day = (ms) => { const d = new Date(ms); return (d.getFullYear() === y0 ? "" : d.getFullYear() + "-") + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
    return day(a) === day(b) ? fmtStamp(b) : day(a) + " – " + day(b);
  }
  // 按最后变动分组：今天 / 7 天内（不含今天）/ 30 天内 / 某年某月。key 不随界面语言变，用来记折叠状态
  function sessGroup(ms) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const day = 86400000, t0 = d0.getTime();
    if (ms >= t0) return { key: "today", label: t("今天") };
    if (ms >= t0 - 7 * day) return { key: "week", label: t("7 天内") };
    if (ms >= t0 - 30 * day) return { key: "month", label: t("30 天内") };
    const d = new Date(ms), key = "m:" + d.getFullYear() + "-" + (d.getMonth() + 1);
    try { return { key, label: d.toLocaleDateString(document.documentElement.lang || undefined, { year: "numeric", month: "long" }) }; }
    catch { return { key, label: key.slice(2) }; }
  }
  // 先转义再标出命中（不区分大小写）
  function markHit(text, q) {
    if (!q) return esc(text);
    const lo = text.toLowerCase(), n = q.toLowerCase();
    let out = "", i = 0;
    for (let j = lo.indexOf(n); j >= 0; j = lo.indexOf(n, i)) { out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + n.length)) + "</mark>"; i = j + n.length; }
    return out + esc(text.slice(i));
  }

  function renderSessions() {
    renderSideRecent();
    renderSideNav();
    const box = $("session-list");
    renderSessBar();
    $("sess-qbox").classList.toggle("hidden", sess.mode === "trash");
    $("sess-h").textContent = sess.mode === "trash" ? t("回收站") : t("对话");
    if (sess.mode === "trash") $("sess-flt-wrap").classList.add("hidden");
    if (sess.mode === "trash") return renderTrash(box);
    const q = sess.q.trim();
    if (!q && !state.sessions.length) {
      box.innerHTML = '<div class="tiny">' + t("还没有历史会话。") + '</div>';
      return;
    }
    // 空闲（答完了、只剩后台任务在跑）的不算「生成中」，单独标出来
    const liveSids = new Set(srv.runs.filter((r) => !r.idle).map((r) => r.sessionId).filter(Boolean));
    const idleSids = new Set(srv.runs.filter((r) => r.idle).map((r) => r.sessionId).filter(Boolean));
    const askSids = new Set(srv.runs.filter((r) => r.perms && r.perms.length).map((r) => r.sessionId).filter(Boolean));
    const picking = sess.mode === "select";
    // 筛选条（照设计稿）：全部 / 在跑 / 置顶 / 当前项目；项目功能上线后换成按项目分
    const isLive = (s) => liveSids.has(s.id) || idleSids.has(s.id) || askSids.has(s.id);
    const sids = schedSids();
    const FLT = { all: [t("全部"), () => true], live: [t("在跑"), isLive], pin: [t("置顶"), (s) => s.pinned] };
    if (PJ.list.length) { FLT.none = [t("不在项目里"), (s) => !pjOfCwd(s.cwd)]; for (const p of PJ.list) FLT["p:" + p.id] = [p.name, (s) => { const q = pjOfCwd(s.cwd); return !!q && q.id === p.id; }]; }
    FLT.sched = [t("定时任务"), (s) => sids.has(s.id)];
    if (!FLT[sess.flt]) sess.flt = "all";
    if (sess.flt !== "all" && !state.sessions.some(FLT[sess.flt][1])) sess.flt = "all";
    $("sess-flt").innerHTML = Object.entries(FLT).filter(([k, f]) => k === "all" || state.sessions.some(f[1]))
      .map(([k, f]) => `<button data-f="${k}" class="${sess.flt === k ? "on" : ""}">${esc(f[0])}</button>`).join("");
    $("sess-flt-wrap").classList.toggle("hidden", $("sess-flt").children.length < 2);
    const keep = FLT[sess.flt][1];
    const nLive = state.sessions.filter(isLive).length;
    setPageSub("sessions", t("{n} 个", { n: state.sessions.length }) + (nLive ? " · " + t("{n} 个在跑", { n: nLive }) : ""));
    // 一行一个：标题 + 等宽的时间/大小；点整行打开，「⋯」里是置顶、改名、导出、删除（和侧栏长按同一份菜单）
    const item = (s) => {
      const st = askSids.has(s.id) ? `<span class="badge warn">${t("等你确认")}</span>` : liveSids.has(s.id) ? `<span class="badge cur">${t("生成中")}</span>` : idleSids.has(s.id) ? `<span class="badge">${t("后台任务在跑")}</span>` : "";
      return `
      <div class="item srow-sess ${s.id === view.sessionId ? "active" : ""} ${picking && sess.sel.has(s.id) ? "picked" : ""}" data-id="${esc(s.id)}">
        ${picking ? `<input type="checkbox" class="sess-ck" ${sess.sel.has(s.id) ? "checked" : ""}>` : ""}
        <div class="ss-main">
          <div class="it-title">${s.pinned ? `<svg class="pin-ic" viewBox="0 0 24 24">${SM.pin}</svg>` : ""}${sids.has(s.id) ? pi("clock", "pj-ic") : ""}${markHit(s.title, q)}</div>
          ${s.snippet ? `<div class="it-snip">${markHit(s.snippet, q)}${s.count > 1 ? ` <span class="badge">${t("{n} 处", { n: s.count >= 99 ? "99+" : s.count })}</span>` : ""}</div>` : ""}
          <div class="it-meta">
            ${s.no ? `<span class="no">${esc(s.no)}</span>` : ""}<span title="${esc(t("更新 {time}", { time: new Date(s.mtime).toLocaleString() }) + (s.created ? " · " + t("创建 {time}", { time: new Date(s.created).toLocaleString() }) : ""))}">${s.no ? fmtRange(s.created, s.mtime) : fmtStamp(s.mtime)}</span>
            <button class="ss-size" data-a="size">${fmtSize(s.sizeKb * 1024)}</button>
            ${st}
            ${pjOfCwd(s.cwd) ? pjMark(pjOfCwd(s.cwd)) : ""}
          </div>
        </div>
        ${picking ? "" : `<button class="ss-more" data-a="more" aria-label="${esc(t("更多"))}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></button>`}
      </div>`;
    };
    if (q) {
      // 标题先在本地筛，内容命中等网关回来再补上
      const list = (sess.hits || state.sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()))).filter((h) => { const s = state.sessions.find((x) => x.id === h.id); return !s || keep(s); });
      box.innerHTML = (sess.hits ? "" : `<div class="tiny">${t("正在搜索对话内容…")}</div>`)
        + (list.length ? list.map(item).join("") : sess.hits ? `<div class="tiny">${t("没有找到包含「{q}」的会话。", { q: esc(q) })}</div>` : "");
      return;
    }
    // 分组：置顶在最前，其余按时间；每组标题可点击折叠，收起时仍露出当前会话
    const groups = [];
    const shown = state.sessions.filter(keep);
    const pins = shown.filter((s) => s.pinned);
    if (pins.length) groups.push({ key: "pin", label: t("置顶"), list: pins });
    // 杂项（测试、试模型这类用完即弃的）收在最后一组，组名右边可一键全移进回收站
    const misc = shown.filter((s) => s.misc && !s.pinned);
    for (const s of shown) {
      if (s.pinned || s.misc) continue;
      const g = sessGroup(s.mtime), top = groups[groups.length - 1];
      if (top && top.key === g.key) top.list.push(s); else groups.push({ ...g, list: [s] });
    }
    if (misc.length) groups.push({ key: "misc", label: t("杂项"), list: misc });
    let html = "";
    for (const g of groups) {
      const folded = sessFolded(g.key);
      html += `<div class="sess-grp ${g.key === "pin" ? "pin" : ""} ${folded ? "folded" : ""}" data-g="${esc(g.key)}"><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>${esc(g.label)} · ${g.list.length}${g.key === "misc" && !picking ? `<button class="grp-act" data-misc-clear>${esc(t("全部移到回收站"))}</button>` : ""}</div>`;
      html += (folded ? g.list.filter((s) => s.id === view.sessionId) : g.list).map(item).join("");
    }
    box.innerHTML = html;
  }

  // 杂项一键进回收站：在跑的跳过；回收站里照常保留几天，可恢复
  async function clearMisc() {
    const busy = new Set(srv.runs.map((r) => r.sessionId).filter(Boolean));
    const list = state.sessions.filter((s) => s.misc && !s.pinned && !busy.has(s.id));
    if (!list.length || !confirm(t("把杂项里的 {n} 个会话移进回收站？", { n: list.length }))) return;
    let n = 0;
    for (const s of list) { try { await api(`/api/session/${encodeURIComponent(s.id)}`, { method: "DELETE" }); n++; } catch {} }
    if (list.some((s) => s.id === view.sessionId)) newConversation();
    loadSessions();
    toast(t("已移进回收站 {n} 个（{d} 天内可恢复）", { n, d: sess.keepDays }));
  }

  // 搜索：输完停 300ms 再问网关；过时的回复丢掉
  let sessQT = 0, sessQN = 0;
  $("sess-q").addEventListener("input", (e) => {
    sess.q = e.target.value; sess.hits = null;
    clearTimeout(sessQT);
    renderSessions();
    const q = sess.q.trim();
    if (!q) return;
    const n = ++sessQN;
    sessQT = setTimeout(async () => {
      try {
        const r = await api("/api/sessions/search?q=" + encodeURIComponent(q));
        if (n === sessQN && sess.q.trim() === q) { sess.hits = r.results || []; renderSessions(); }
      } catch (err) { if (n === sessQN) { sess.hits = []; renderSessions(); toast(err.message, true); } }
    }, 300);
  });
  // 刷新列表时搜索结果也跟着重查
  function resessSearch() { if (sess.q.trim()) $("sess-q").dispatchEvent(new Event("input")); }

  function renderSessBar() {
    const bar = $("sess-bar");
    $("btn-sess-select").textContent = sess.mode === "select" ? t("取消选择") : t("选择");
    $("btn-sess-trash").textContent = sess.mode === "trash" ? t("返回会话") : t("回收站");
    $("btn-sess-select").classList.toggle("hidden", sess.mode === "trash");
    if (sess.mode === "select") {
      const n = sess.sel.size, all = state.sessions.length && n === state.sessions.length;
      bar.innerHTML = `<button class="btn ghost sm" data-b="all">${all ? t("全不选") : t("全选")}</button>
        <span class="tiny">${t("已选 {n} 个", { n })}</span>
        <button class="btn sm" data-b="export" ${n ? "" : "disabled"}>${t("导出所选")}</button>
        <button class="btn ghost sm danger" data-b="trash" ${n ? "" : "disabled"}>${t("删除所选")}</button>
        <button class="btn ghost sm" data-b="cancel">${t("取消选择")}</button>`;
    } else if (sess.mode === "exported") {
      const r = sess.exported;
      bar.innerHTML = `<span class="tiny">${t("已导出 {n} 个会话", { n: r.count })}</span>
        ${canSaveAs() ? `<button class="btn sm" data-b="save">${t("保存到…")}</button>` : ""}
        ${canShare() ? `<button class="btn sm" data-b="share">${t("分享…")}</button>` : ""}
        <button class="btn ghost sm" data-b="done">${t("完成")}</button>
        ${canSaveAs() || canShare() ? "" : `<div class="tiny">${esc(r.file)}</div>`}`;
    } else if (sess.mode === "trash") {
      bar.innerHTML = `<span class="tiny">${t("删除的会话在这里保留 {n} 天，之后自动清除。", { n: sess.keepDays })}</span>
        ${sess.trash.length ? `<button class="btn ghost sm danger" data-b="empty">${t("清空回收站")}</button>` : ""}
        <button class="btn ghost sm" data-b="back">${t("返回会话")}</button>`;
    }
    bar.classList.toggle("hidden", sess.mode === "list");
  }

  function renderTrash(box) {
    if (!sess.trash.length) { box.innerHTML = '<div class="tiny">' + t("回收站是空的。") + '</div>'; return; }
    box.innerHTML = sess.trash.map((m) => `
      <div class="item" data-id="${esc(m.id)}">
        <div class="it-title">${esc(m.title || m.id)}</div>
        <div class="it-meta">
          <span>${t("删除于 {time}", { time: relTime(m.deletedAt) })}</span>
          <span>${Math.round((m.size || 0) / 1024)} KB</span>
        </div>
        <div class="it-acts">
          <button data-a="restore">${t("恢复")}</button>
          <button data-a="purge">${t("彻底删除")}</button>
        </div>
      </div>`).join("");
  }

  async function loadTrash() {
    try {
      const r = await api("/api/trash");
      sess.trash = r.items || []; sess.keepDays = r.keepDays || 30;
    } catch (e) { toast(e.message, true); }
    renderSessions();
  }

  $("btn-sess-select").addEventListener("click", () => {
    sess.mode = sess.mode === "select" ? "list" : "select";
    sess.sel.clear();
    renderSessions();
  });
  $("btn-sess-trash").addEventListener("click", () => {
    if (sess.mode === "trash") { sess.mode = "list"; loadSessions(); return; }
    sess.mode = "trash"; loadTrash();
  });
  $("btn-sess-import").addEventListener("click", () => $("sess-import-file").click());
  $("sess-flt").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; sess.flt = b.dataset.f; renderSessions(); });
  // 页面标题旁的 ⋯：原来那排按钮的活
  $("sess-kebab").addEventListener("click", (e) => {
    const cl = (id) => () => $(id).click();
    popMenu(e.currentTarget, [
      { label: sess.mode === "select" ? t("取消选择") : t("选择多个"), icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>', fn: cl("btn-sess-select") },
      { label: t("导入对话（.zip）"), icon: '<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>', fn: cl("btn-sess-import") },
      { label: sess.mode === "trash" ? t("返回会话") : t("回收站"), icon: SM.trash, fn: cl("btn-sess-trash") },
      { label: t("刷新列表"), icon: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', fn: cl("btn-refresh-sessions") },
      "hr",
      { label: t("断开当前会话"), icon: '<path d="M9 7 4 12l5 5M4 12h11M15 4h4v16h-4"/>', fn: cl("btn-close-session") },
    ]);
  });
  $("sess-import-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    toast(t("正在导入…"));
    try {
      const r = await api("/api/sessions/import", {
        method: "POST", headers: { "content-type": "application/zip" }, body: await f.arrayBuffer(),
      });
      toast(r.skipped.length
        ? t("已导入 {n} 个会话，跳过 {m} 个已存在的", { n: r.imported.length, m: r.skipped.length })
        : t("已导入 {n} 个会话", { n: r.imported.length }));
    } catch (err) { toast(t("导入失败：{msg}", { msg: err.message }), true); }
    if (sess.mode === "trash") sess.mode = "list";
    loadSessions();
  });

  $("sess-bar").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const act = b.dataset.b;
    if (act === "cancel") return $("btn-sess-select").click();
    if (act === "back") return $("btn-sess-trash").click();
    if (act === "all") {
      if (sess.sel.size === state.sessions.length) sess.sel.clear();
      else state.sessions.forEach((s) => sess.sel.add(s.id));
      return renderSessions();
    }
    if (act === "export") {
      if (!confirm(t("会话记录可能含有你贴过的密钥、令牌或文件内容。导出的压缩包请只发给你信任的地方。继续？"))) return;
      let r;
      try { r = await post("/api/sessions/export", { ids: [...sess.sel] }); }
      catch (err) { return toast(t("导出失败：{msg}", { msg: err.message }), true); }
      if (!r.ok) return toast(t("导出失败：{msg}", { msg: r.message || "" }), true);
      // 导出包在网关这边；交给用户选：「保存到」（系统文件面板，挑哪都行）或「分享」（网盘、聊天、另一台设备）
      sess.exported = r; sess.mode = "exported"; sess.sel.clear(); renderSessions();
      if (canSaveAs()) saveAs(r.file, "application/zip");
      else if (!canShare()) toast(t("已导出 {n} 个会话：{file}", { n: r.count, file: r.file }));
      return;
    }
    if (act === "save") return saveAs(sess.exported.file, "application/zip");
    if (act === "share") return post("/api/app/share_file", { path: sess.exported.file, mime: "application/zip" })
      .then((j) => { if (!j.ok) toast(j.message || t("分享失败"), true); }).catch((err) => toast(err.message, true));
    if (act === "done") { sess.mode = "list"; sess.exported = null; return renderSessions(); }
    if (act === "trash") {
      if (!confirm(t("把选中的 {n} 个会话移进回收站？{d} 天内可以恢复。", { n: sess.sel.size, d: sess.keepDays }))) return;
      const r = await post("/api/sessions/trash", { ids: [...sess.sel] }).catch((err) => ({ done: [], failed: [], err }));
      if (r.done.includes(view.sessionId)) newConversation();
      toast(r.failed.length ? t("{n} 个已删除，{m} 个正在生成没删", { n: r.done.length, m: r.failed.length }) : t("已移进回收站"), !!r.failed.length);
      sess.mode = "list"; sess.sel.clear(); loadSessions();
      return;
    }
    if (act === "empty") {
      if (!confirm(t("彻底删除回收站里全部 {n} 个会话？不可恢复。", { n: sess.trash.length }))) return;
      await post("/api/trash/purge", { all: true }).catch((err) => toast(err.message, true));
      loadTrash();
    }
  });

  $("session-list").addEventListener("click", async (e) => {
    if (e.target.closest("[data-misc-clear]")) return clearMisc();
    const grp = e.target.closest(".sess-grp[data-g]");
    if (grp) {
      const k = grp.dataset.g;
      sess.fold[k] = !sessFolded(k);
      localStorage.setItem("cc.sessFold", JSON.stringify(sess.fold));
      return renderSessions();
    }
    const el = e.target.closest(".item");
    if (!el) return;
    const id = el.dataset.id;
    if (sess.mode === "select") {
      if (sess.sel.has(id)) sess.sel.delete(id); else sess.sel.add(id);
      return renderSessions();
    }
    const b = e.target.closest("button");
    if (!b && sess.mode !== "trash") {
      const h = sess.q.trim() && (sess.hits || []).find((s) => s.id === id);
      goSession(id, h && h.count ? sess.q.trim() : ""); return;
    }
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.a;
    if (a === "more") return sessMenu(id, b);
    // 大小是本地 .jsonl 的体积，常被当成上下文用量（#35）：点一下说清楚
    if (a === "size") return popMenu(b, [{ head: t("本地记录大小") }, { head: t("这条会话存在设备上的记录文件有多大，含聊天内容和工具调用。不是模型当前的上下文长度，也不是 token 用量或费用；压缩上下文后原始记录仍会保留，所以它会一直变大。") }], null, "ss-size-tip");
    if (a === "restore") {
      const r = await post("/api/trash/restore", { ids: [id] }).catch((err) => ({ failed: [{ error: err.message }] }));
      if (r.failed && r.failed.length) toast(t("恢复失败：{msg}", { msg: r.failed[0].error === "exists" ? t("同名会话已存在") : r.failed[0].error }), true);
      else toast(t("已恢复"));
      return loadTrash();
    }
    if (a === "purge") {
      if (!confirm(t("彻底删除这个会话？不可恢复。"))) return;
      await post("/api/trash/purge", { ids: [id] }).catch((err) => toast(err.message, true));
      return loadTrash();
    }
    if (a === "open") {
      const h = sess.q.trim() && (sess.hits || []).find((s) => s.id === id);
      goSession(id, h && h.count ? sess.q.trim() : ""); return;
    }
    if (a === "pin") {
      const cur = state.sessions.find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id);
      try { await post(`/api/session/${encodeURIComponent(id)}/pin`, { pin: !(cur && cur.pinned) }); }
      catch (err) { return toast(err.message, true); }
      loadSessions();
      return;
    }
    if (a === "rename") {
      const cur = state.sessions.find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id);
      const name = prompt(t("新的会话名称"), cur?.title || "");
      if (!name) return;
      try {
        await api(`/api/session/${encodeURIComponent(id)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: name }),
        });
      } catch (err) { toast(err.message, true); }
      loadSessions();
      return;
    }
    if (a === "del") {
      try { await api(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }); }
      catch (err) { return toast(err.message, true); }
      if (view.sessionId === id) newConversation();
      loadSessions();
      toast(t("已移进回收站（{d} 天内可恢复）", { d: sess.keepDays }));
    }
  });


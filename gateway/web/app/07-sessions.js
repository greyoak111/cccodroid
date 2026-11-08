  // ── 会话管理 ──────────────────────────────────────────────────────
  /** 拉会话列表；成功返回 true。删完紧接着刷新时，删之前发出的那次慢请求迟到也不许把删掉的又画回来（审查 #48 S08-03） */
  async function loadSessions() {
    const ok = latest("sessions");
    try {
      const lim = state.sessLimit || 150;   // 点过「再显示」就一直按加大后的数拉，刷新不缩回去
      const r = await api(lim > 150 ? "/api/sessions?limit=" + lim : "/api/sessions");
      if (!ok()) return true;
      state.sessions = r.sessions || [];
      state.sessTotal = r.total || state.sessions.length;
      state.sessErr = "";
      if (sess.q.trim()) resessSearch(); else renderSessions();
      lineageDirty();
      return true;
    } catch (e) {
      // 读失败和「真的没有」分开：空着的说没读到、给重试；有旧列表的标出没刷新上（#178-4）
      if (ok()) { state.sessErr = e.message || String(e); renderSessions(); }
      return e;
    }
  }

  // 会话页三种视图：普通列表 / 多选（导出、批量删除）/ 回收站
  // q：搜索词；hits：网关返回的内容命中（null = 还没回来）；fold：各分组折叠状态（pin / today / week / month / m:年-月）
  const sess = { mode: "list", sel: new Set(), trash: [], keepDays: 30, q: "", hits: null, fold: loadSessFold(), flt: "all" };
  function loadSessFold() {
    let f = {};
    try { const v = JSON.parse(localStorage.getItem("cc.sessFold") || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) f = v; } catch {}
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
    // 7 / 30 天按本地日历往前推：夏令时那天少或多一小时，86400000 的倍数会把边界算偏（0.6.10 审计 197-5.12）
    const d7 = new Date(d0); d7.setDate(d7.getDate() - 7);
    const d30 = new Date(d0); d30.setDate(d30.getDate() - 30);
    const t0 = d0.getTime();
    if (ms >= t0) return { key: "today", label: t("今天") };
    if (ms >= d7.getTime()) return { key: "week", label: t("7 天内") };
    if (ms >= d30.getTime()) return { key: "month", label: t("30 天内") };
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

  /** 「在跑」的会话数：侧栏角标和会话页同一口径——有会话号的轮次，生成中、只剩后台任务、等确认都算。
   *  还没建会话的不算（会话列表里也没有它，算上就对不上，#171） */
  /** 没建会话的草稿里、当前页看不到的（#171/#172）：在跑的（含停在确认卡上的）、跟不上任何在跑轮次的排队消息、
   *  待重发的中断记录。会话列表里没有它们，侧栏顶上给一个入口，点了全部认回新对话页 */
  function draftsElsewhere() {
    const runs = srv.runs.filter((r) => !r.sessionId && !runInView(r));
    const queue = (srv.queueAll || []).filter((q) => !q.sessionId && !queuedInView(q) && !(q.follow && srv.runs.some((r) => r.id === q.follow)));   // 跟着还在跑的轮次的：随那一轮出现，不单算
    const intr = view.sessionId ? (srv.intr || []).filter((e) => !e.sessionId) : [];
    return { n: runs.length + queue.length + intr.length, ask: runs.some((r) => r.perms && r.perms.length), live: runs.length > 0, intr: intr.length > 0 };
  }
  function liveSessCount() { return new Set(srv.runs.map((r) => r.sessionId).filter(Boolean)).size; }
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
      sess.visible = [];
      box.innerHTML = state.sessErr ? sessErrRow() : '<div class="tiny">' + t("还没有历史会话。") + '</div>';
      return;
    }
    // 空闲（答完了、只剩后台任务在跑）的不算「生成中」，单独标出来
    const liveSids = new Set(srv.runs.filter((r) => !r.idle).map((r) => r.sessionId).filter(Boolean));
    const idleSids = new Set(srv.runs.filter((r) => r.idle).map((r) => r.sessionId).filter(Boolean));
    const askSids = new Set(srv.runs.filter((r) => r.perms && r.perms.length).map((r) => r.sessionId).filter(Boolean));
    const intrSids = new Set((srv.intr || []).map((e) => e.sessionId).filter(Boolean));
    const picking = sess.mode === "select";
    // 筛选条（照设计稿）：全部 / 在跑 / 置顶 / 当前项目；项目功能上线后换成按项目分
    const isLive = (s) => liveSids.has(s.id) || idleSids.has(s.id) || askSids.has(s.id);   // 侧栏的「N 个在跑」也按这个数（liveSessCount）
    const sids = schedSids();
    const FLT = { all: [t("全部"), () => true], live: [t("在跑"), isLive], pin: [t("置顶"), (s) => s.pinned] };
    if (PJ.list.length) { FLT.none = [t("不在项目里"), (s) => !pjOfCwd(s.cwd)]; for (const p of PJ.list) FLT["p:" + p.id] = [p.name, (s) => { const q = pjOfCwd(s.cwd); return !!q && q.id === p.id; }]; }
    FLT.sched = [t("定时任务"), (s) => sids.has(s.id)];
    if (!FLT[sess.flt]) sess.flt = "all";
    if (sess.flt !== "all" && !state.sessions.some(FLT[sess.flt][1])) sess.flt = "all";
    $("sess-flt").innerHTML = Object.entries(FLT).filter(([k, f]) => k === "all" || state.sessions.some(f[1]))
      .map(([k, f]) => `<button data-f="${esc(k)}" class="${sess.flt === k ? "on" : ""}">${esc(f[0])}</button>`).join("");
    $("sess-flt-wrap").classList.toggle("hidden", $("sess-flt").children.length < 2);
    const keep = FLT[sess.flt][1];
    const nLive = state.sessions.filter(isLive).length;
    // 网关只给最近 150 个（加置顶）：数字和列表范围对得上，说清还有更早的（#178-3）
    const more = Math.max(0, (state.sessTotal || 0) - state.sessions.length);
    setPageSub("sessions", (more ? t("最近 {n} 个，共 {m} 个", { n: state.sessions.length, m: state.sessTotal }) : t("{n} 个", { n: state.sessions.length })) + (nLive ? " · " + t("{n} 个在跑", { n: nLive }) : ""));
    // 一行一个：标题 + 等宽的时间/大小；点整行打开，「⋯」里是置顶、改名、导出、删除（和侧栏长按同一份菜单）
    const item = (s) => {
      const st = askSids.has(s.id) ? `<span class="badge warn">${t("等你确认")}</span>` : liveSids.has(s.id) ? `<span class="badge cur">${t("生成中")}</span>` : idleSids.has(s.id) ? `<span class="badge">${t("后台任务在跑")}</span>` : intrSids.has(s.id) ? `<span class="badge warn">${t("已中断")}</span>` : "";
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
      // 命中的会话不在本地这 150 条里时，拿命中结果自带的字段去筛，别绕过当前的置顶 / 项目筛选（审查 B-05）
      const list = (sess.hits || state.sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()))).filter((h) => keep(state.sessions.find((x) => x.id === h.id) || h));
      sess.visible = list.map((x) => x.id); pruneSel(); renderSessBar();
      box.innerHTML = (sess.hitsErr
          ? `<div class="tiny err">${esc(t("搜索失败：{msg}", { msg: sess.hitsErr }))} <button class="btn ghost sm" data-sess-search-retry>${esc(t("重试"))}</button></div>`
          : sess.hits ? "" : `<div class="tiny">${t("正在搜索对话内容…")}</div>`)
        + (list.length ? list.map(item).join("") : sess.hits ? `<div class="tiny">${t("没有找到包含「{q}」的会话。", { q: esc(q) })}</div>` : "")
        + (sess.hits && sess.hitsTotal > sess.hits.length ? `<div class="tiny">${t("只显示前 {n} 个，一共命中 {m} 个，换个更具体的词试试", { n: sess.hits.length, m: sess.hitsTotal })}</div>` : "");
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
    // 「全选」只选真正画出来的条目：折叠分组里看不见的不算（审查 11-05）
    const rendered = groups.flatMap((g) => sessFolded(g.key) ? g.list.filter((s) => s.id === view.sessionId) : g.list);
    sess.visible = rendered.map((x) => x.id);
    sess.misc = misc.map((s) => s.id);   // 「全部移到回收站」只动这一组看得见的（筛到某个项目时不连带别的项目，#176-1）
    pruneSel();
    renderSessBar();
    let html = "";
    for (const g of groups) {
      const folded = sessFolded(g.key);
      html += `<div class="sess-grp ${g.key === "pin" ? "pin" : ""} ${folded ? "folded" : ""}" data-g="${esc(g.key)}"><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>${esc(g.label)} · ${g.list.length}${g.key === "misc" && !picking ? `<button class="grp-act" data-misc-clear>${esc(t("全部移到回收站"))}</button>` : ""}</div>`;
      html += (folded ? g.list.filter((s) => s.id === view.sessionId) : g.list).map(item).join("");
    }
    if (more) html += `<div class="tiny">${t("更早的 {n} 个没列出来，搜索标题或内容能找到", { n: more })}
      <button class="btn ghost sm" data-sess-more>${esc(t("再显示 {n} 个", { n: Math.min(150, more) }))}</button></div>`;
    box.innerHTML = (state.sessErr ? sessErrRow(true) : "") + html;
  }

  /** 选中的会话必须仍在当前可见集合里：筛选/折叠/刷新后把看不见的剪掉 */
  function pruneSel() {
    const vis = new Set(sess.visible || []);
    for (const id of [...sess.sel]) if (!vis.has(id)) sess.sel.delete(id);
  }

  // 杂项一键进回收站：在跑的跳过；回收站里照常保留几天，可恢复
  async function clearMisc() {
    const busy = new Set(srv.runs.map((r) => r.sessionId).filter(Boolean));
    // 只动当前筛选下、这一组里列出来的杂项，不要波及别的项目/搜索词之外的会话
    const list = state.sessions.filter((s) => s.misc && !s.pinned && !busy.has(s.id) && (sess.misc || []).includes(s.id));
    if (!list.length || !confirm(t("把杂项里的 {n} 个会话移进回收站？", { n: list.length }))) return;
    const done = new Set();
    let n = 0, failed = 0, lastErr = "";
    for (const s of list) {
      try { await api(`/api/session/${encodeURIComponent(s.id)}`, { method: "DELETE" }); n++; done.add(s.id); }
      catch (e) { failed++; lastErr = e.message || String(e); }   // 以前逐条吞错，只说「已移进回收站」（0.6.9 审计 195-N.5）
    }
    if (done.has(view.sessionId)) newConversation();
    loadSessions();
    if (failed) toast(n ? t("已移进回收站 {n} 个，{m} 个失败：{msg}", { n, m: failed, msg: lastErr })
      : t("没有删成：{msg}", { msg: lastErr }), true);
    else toast(t("已移进回收站 {n} 个（{d} 天内可恢复）", { n, d: sess.keepDays }));
  }

  // 搜索：输完停 300ms 再问网关；过时的回复丢掉
  let sessQT = 0, sessQN = 0;
  $("sess-q").addEventListener("input", (e) => {
    sess.q = e.target.value; sess.hits = null; sess.hitsErr = ""; sess.hitsTotal = 0;
    clearTimeout(sessQT);
    renderSessions();
    const q = sess.q.trim();
    if (!q) return;
    const n = ++sessQN;
    sessQT = setTimeout(async () => {
      try {
        const r = await api("/api/sessions/search?q=" + encodeURIComponent(q));
        if (n === sessQN && sess.q.trim() === q) { sess.hits = r.results || []; sess.hitsTotal = r.total || sess.hits.length; sess.hitsErr = ""; renderSessions(); }
      } catch (err) {
        // 失败和「没有匹配」分开：以前失败也画成「没有找到」，还沿用上一次的命中数（0.6.9 审计 196-会话.2）
        if (n === sessQN) { sess.hits = null; sess.hitsErr = err.message || String(err); renderSessions(); }
      }
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
      const vis = sess.visible || state.sessions.map((x) => x.id);
      const n = selShown().length, all = vis.length && vis.every((id) => sess.sel.has(id));
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

  /** 会话列表没读到：说原因、给重试；stale = 下面还留着上次的列表 */
  function sessErrRow(stale) {
    return `<div class="tiny err">${esc(stale ? t("列表没刷新上（下面是上次的）：{msg}", { msg: state.sessErr }) : t("会话列表没读到：{msg}", { msg: state.sessErr }))}
      <button class="btn ghost sm" data-sess-retry>${esc(t("重试"))}</button></div>`;
  }

  /** 批量导出 / 删除只作用于眼前看得见的已选项：换了筛选、搜索词，或刷新后会话已不在了，之前勾的不跟着算（#176-2） */
  function selShown() {
    const vis = new Set(sess.visible || state.sessions.map((x) => x.id));
    return [...sess.sel].filter((id) => vis.has(id));
  }

  function renderTrash(box) {
    // 没读到和真的空分开说（#178-5）
    const err = sess.trashErr ? `<div class="tiny err">${esc(t("回收站没读到：{msg}", { msg: sess.trashErr }))} <button class="btn ghost sm" data-sess-retry>${esc(t("重试"))}</button></div>` : "";
    if (!sess.trash.length) { box.innerHTML = err || '<div class="tiny">' + t("回收站是空的。") + '</div>'; return; }
    box.innerHTML = err + sess.trash.map((m) => `
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

  /** 成功返回 true，失败返回错误（同 loadSessions，「刷新列表」在回收站里刷的是回收站） */
  async function loadTrash() {
    let ret = true;
    try {
      const r = await api("/api/trash");
      sess.trash = r.items || []; sess.keepDays = r.keepDays || 30; sess.trashErr = "";
    } catch (e) { sess.trashErr = e.message || String(e); ret = e; }
    renderSessions();
    return ret;
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
        method: "POST", headers: { "content-type": "application/zip" }, body: f,   // 直接交文件：大包不先整个读进页面内存
      });
      const n = (r.imported || []).length, skip = (r.skipped || []).length;
      toast(skip
        ? t("已导入 {n} 个会话，跳过 {m} 个已存在的", { n, m: skip })
        : t("已导入 {n} 个会话", { n }));
    } catch (err) {
      // 中途失败：网关在错误回执里带了已经放好的那几个，别把已导入的说没了（196-会话.6）
      const n = err.body && Array.isArray(err.body.imported) ? err.body.imported.length : 0;
      toast(n ? t("已导入 {n} 个，后面的失败：{msg}", { n, msg: err.message })
        : t("导入失败：{msg}", { msg: err.message }), true);
    }
    if (sess.mode === "trash") sess.mode = "list";
    loadSessions();
  });

  $("sess-bar").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const act = b.dataset.b;
    if (act === "cancel") return $("btn-sess-select").click();
    if (act === "back") return $("btn-sess-trash").click();
    if (act === "all") {
      const vis = sess.visible || state.sessions.map((x) => x.id);
      if (vis.length && vis.every((id) => sess.sel.has(id))) sess.sel.clear();
      else { sess.sel.clear(); vis.forEach((id) => sess.sel.add(id)); }
      return renderSessions();
    }
    if (act === "export") {
      if (!confirm(t("会话记录可能含有你贴过的密钥、令牌或文件内容。导出的压缩包请只发给你信任的地方。继续？"))) return;
      let r;
      try { r = await post("/api/sessions/export", { ids: selShown() }); }
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
      const ids = selShown();
      if (!confirm(t("把选中的 {n} 个会话移进回收站？{d} 天内可以恢复。", { n: ids.length, d: sess.keepDays }))) return;
      const r = await post("/api/sessions/trash", { ids }).catch((err) => ({ done: [], failed: [], err }));
      // 请求本身失败：什么都没删，别说「已移进回收站」，也别清掉选择（审查 B-02）
      if (r.err) return toast(t("删除失败：{msg}", { msg: r.err.message }), true);
      if (r.done.includes(view.sessionId)) newConversation();
      // 正在生成的和已经不在了的分开说（旧网关没有 busy，按原来的说法）
      const nBusy = r.busy ? r.busy.length : r.failed.length, nGone = r.failed.length - nBusy;
      toast(!r.failed.length ? t("已移进回收站")
        : !nGone ? t("{n} 个已删除，{m} 个正在生成没删", { n: r.done.length, m: nBusy })
        : !nBusy ? t("{n} 个已删除，{m} 个已经不在了（别处删了或已在回收站）", { n: r.done.length, m: nGone })
        : t("{n} 个已删除，{m} 个正在生成没删，{k} 个已经不在了", { n: r.done.length, m: nBusy, k: nGone }), true);
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
    if (e.target.closest("[data-sess-search-retry]")) return resessSearch();
    if (e.target.closest("[data-sess-retry]")) return sess.mode === "trash" ? loadTrash() : loadSessions();
    if (e.target.closest("[data-sess-more]")) { state.sessLimit = (state.sessLimit || 150) + 150; return loadSessions(); }
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
      if (b.disabled) return;
      b.disabled = true;   // 连点两次的第二次会撞「同名会话已存在」（0.6.9 审计 196-会话.4）
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
        // 会话不在最近 150 条里时，列表刷新也不会带回它，顶栏自己改过来（0.6.9 审计 196-会话.3）
        if (id === view.sessionId) { view.title = name; paintTitle(); }
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


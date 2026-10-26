  // ── 上下文用量 ────────────────────────────────────────────────────
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
    return (n / 1048576).toFixed(2) + "M";
  }
  /** 刻度以【自动压缩窗口】为准；没设才退回模型窗口 */
  function updateCtx(used, total) {
    if (used != null) state.ctxUsed = used;
    if (total) state.ctxTotal = total;
    const line = state.compactAt || 0;
    const scale = line > 0 ? line : (state.ctxTotal || 0);
    if (!scale) return;
    const pct = Math.min(100, Math.round((state.ctxUsed / scale) * 100));
    ctxBar.classList.remove("hidden", "warn", "danger");
    if (pct >= 100) ctxBar.classList.add("danger");
    else if (pct >= 85) ctxBar.classList.add("warn");
    ctxFill.style.width = pct + "%";
    $("ctxctx").textContent = line > 0
      ? t("上下文 {used} / 压缩线 {line} · {pct}%", { used: fmtTok(state.ctxUsed), line: fmtTok(line), pct })
      : t("上下文 {used} / {total} · {pct}%", { used: fmtTok(state.ctxUsed), total: fmtTok(state.ctxTotal), pct });
    saveUiState();
  }
  /** 从 /context 的输出里抠出真实占用（形如 "**Tokens:** 17.9k / 200k (9%)"） */
  function parseContextText(t) {
    const num = (v, u) => {
      let n = parseFloat(v);
      const s = (u || "").toLowerCase();
      if (s === "k") n *= 1000;
      if (s === "m") n *= 1e6;
      return Math.round(n);
    };
    let m = t.match(/\*{0,2}Tokens:?\*{0,2}\s*([\d.]+)\s*([km])?\s*\/\s*([\d.]+)\s*([km])?/i);
    if (m) return updateCtx(num(m[1], m[2]), num(m[3], m[4]));
    m = t.match(/\|\s*(?:Used|已用)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
    if (m) {
      const used = num(m[1], m[2]);
      const tot = t.match(/\|\s*(?:Total|总计)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
      return updateCtx(used, tot ? num(tot[1], tot[2]) : state.ctxTotal);
    }
  }

  // ── 会话切换 / 历史翻页 ────────────────────────────────────────────
  function resetView(sessionId) {
    view.sessionId = sessionId || null;
    state.pendingModel = null;               // 新会话面板里暂存的选择只属于那个新会话
    refreshSessModel();                      // 模型标签换成这个会话自己的（打开、启动、重连都经过这里）
    view.gen++;
    view.cursor = null;
    view.next = null;
    view.loading = false;
    view.runIds = new Set();
    view.cids = new Set();
    view.lastRunId = null;
    view.projectId = null;
    view.title = "";
    paintTitle();
    view.goal = null;
    const hid = stripHidden()[view.sessionId] || {};
    view.goalHide = hid.g || 0;
    view.tasks = null;
    view.tasksHide = hid.t || "";
    renderRunStrip();
    histEl.innerHTML = "";
    liveEl.innerHTML = "";
    for (const rv of runViews.values()) rv.timer?.stop();
    runViews.clear();
    TOOL_CARDS.clear();
    PENDING_RESULTS.clear();
    olderEl.classList.add("hidden");
    syncWindow();
    statEl.textContent = "";
    pickViewRun();                     // 换了会话：「本会话在不在跑」要重新算
    paintProjChip();
    syncInterject();
    saveUiState();
  }

  /** 打开某个会话（null = 新会话）。重连事件流：网关会把正在跑的那一轮从头重放过来。
   *  anchor：落在某一章开头（脉络里点站 / 章标题；压缩消息的 uuid，第一章是 "start"） */
  function openSession(id, jumpQ, anchor) {
    closePage();
    resetView(id);
    view.jumpQ = id && jumpQ ? jumpQ : "";   // 从搜索结果点进来：历史加载完后跳到命中的那条
    view.jumpPages = 0;
    view.anchor = id && anchor ? anchor : "";
    view.resume = null;
    renderSessions();
    connectBus(false);
  }

  function newConversation(note) {
    openSession(null);
    updateCtx(0, state.ctxTotal);
    setStatus(note || t("新会话"), "ok");
    inputEl.focus();
  }

  function liveExclude() {
    const r = srv.run;
    return r && view.sessionId && r.sessionId === view.sessionId ? r.startedAt : 0;
  }

  // ── 窗口式历史（跳到某一章时）：#hist 只是会话里连续的一段，view.cursor 是上沿、view.next 是下沿（null = 一直到最新）。
  //    没到最新时 #live 藏起来，往下滚按页续读；每页记着自己的字节范围（data-from / data-to），
  //    超过 MAX_PAGES 页就从另一头整页摘掉，滚回去再按范围原样重读——长会话来回翻，DOM 始终只有这么几页
  const MAX_PAGES = 8;
  function syncWindow() {
    const w = view.next != null;
    liveEl.classList.toggle("hidden", w);
    chatEl.classList.toggle("windowed", w);
  }
  // 往后读时不重复给的部分：正在跑的那一轮，加上本次打开后在 #live 里已经画出来的各轮
  function windowExclude() {
    let ex = liveExclude();
    for (const rv of runViews.values()) if (rv.startedAt && (!ex || rv.startedAt < ex)) ex = rv.startedAt;
    return ex;
  }
  const histPages = () => histEl.querySelectorAll(":scope > .page");
  function trimPages(side) {
    let ps = histPages();
    while (ps.length > MAX_PAGES) {
      if (side === "top") {
        const p = ps[0], h0 = chatEl.scrollHeight;
        p.remove();
        chatEl.scrollTop -= h0 - chatEl.scrollHeight;
        view.cursor = Number(p.dataset.to);
        olderEl.classList.remove("hidden");
      } else {
        const p = ps[ps.length - 1];
        p.remove();
        view.next = Number(p.dataset.from);
        syncWindow();
      }
      ps = histPages();
    }
  }

  async function loadNewer() {
    const id = view.sessionId, after = view.next;
    if (!id || view.loading || after == null) return;
    view.loading = true;
    const gen = view.gen;
    const q = new URLSearchParams({ limit: "60", after: String(after) });
    const ex = windowExclude();
    if (ex) q.set("exclude", String(ex));
    let r;
    try { r = await api(`/api/session/${encodeURIComponent(id)}?${q}`); }
    catch (e) { if (gen === view.gen) { view.loading = false; toast(t("读取历史失败：{msg}", { msg: e.message }), true); } return; }
    if (gen !== view.gen) return;
    view.loading = false;
    const page = renderItems(r.items || []);
    page.dataset.from = after; page.dataset.to = r.next;
    histEl.appendChild(page);
    view.next = r.next < r.size ? r.next : null;
    trimPages("top");
    syncWindow();
  }

  async function loadOlder(initial) {
    const id = view.sessionId;
    if (!id || view.loading) return;
    if (!initial && !view.cursor) return;
    view.loading = true;
    const gen = view.gen;
    olderEl.textContent = t("加载中…");
    const q = new URLSearchParams({ limit: initial ? "40" : "60" });
    const anchor = initial ? view.anchor : "", resume = initial ? view.resume : null, before = view.cursor;
    if (initial) { view.anchor = ""; view.resume = null; }
    const fwd = !!anchor || resume != null;
    if (anchor) q.set("anchor", anchor);
    else if (resume != null) q.set("after", String(resume));
    else if (!initial) q.set("before", String(before));
    const ex = fwd ? windowExclude() : liveExclude();
    if (ex) q.set("exclude", String(ex));
    let r;
    try {
      r = await api(`/api/session/${encodeURIComponent(id)}?${q}`);
    } catch (e) {
      if (gen !== view.gen) return;
      view.loading = false;
      olderEl.textContent = t("加载更早的消息");
      if (anchor && e.status === 404) {
        // 那一章的位置找不到了（记录被改写过）：退回最新
        toast(t("没找到这一章的位置，已打开到最新"), true);
        return loadOlder(true);
      }
      if (e.status === 404 && initial) {
        // 记着的会话已经不在了（删掉了 / 清过数据）：当新会话处理，回到欢迎页，别挂一条让人摸不着头脑的提示
        view.sessionId = null;
        saveUiState();
        if (!liveEl.childElementCount) showWelcome();
      } else toast(t("读取历史失败：{msg}", { msg: e.message }), true);
      return;
    }
    if (gen !== view.gen) return;
    view.loading = false;
    view.cursor = r.cursor;
    if (initial) view.next = fwd && r.next < r.size ? r.next : null;
    view.title = r.title || "";
    if (initial && "goal" in r) { view.goal = r.goal || null; renderRunStrip(); }
    if (initial && "tasks" in r) { view.tasks = r.tasks || null; renderRunStrip(); }
    const page = renderItems(r.items || []);
    page.dataset.from = r.cursor;
    page.dataset.to = fwd ? r.next : initial ? r.size : before;
    olderEl.textContent = t("加载更早的消息");
    olderEl.classList.toggle("hidden", !r.cursor);
    if (initial) {
      histEl.innerHTML = "";
      histEl.appendChild(page);
      syncWindow();
      if (r.contextTokens != null) updateCtx(r.contextTokens, state.ctxTotal);
      paintTitle();
      setStatus(t("就绪"), "ok");
      if (anchor) return landOnChapter(page, gen);
      if (fwd) { stick = false; chatEl.scrollTop = 0; }   // 重连时接着原来那一段
      else { scrollDown(true); MO.play(histEl, "mo-in-rise", 1400); }
    } else {
      const h0 = chatEl.scrollHeight, t0 = chatEl.scrollTop;
      histEl.insertBefore(page, histEl.firstChild);
      chatEl.scrollTop = t0 + (chatEl.scrollHeight - h0);   // 往上补内容，视线别跳
      trimPages("bottom");
    }
    if (view.jumpQ) jumpToHit();
  }
  // 落在某一章：先往上补一页（分隔线上面要有东西可看），再把分隔线放到视口上三分之一处、闪一下
  async function landOnChapter(page, gen) {
    stick = false;
    if (view.cursor) await loadOlder(false);
    if (gen !== view.gen) return;
    const sep = page.querySelector(".ch-sep");
    const y = sep ? sep.getBoundingClientRect().top - chatEl.getBoundingClientRect().top + chatEl.scrollTop : 0;
    chatEl.scrollTop = Math.max(0, y - chatEl.clientHeight / 3);
    progTop = chatEl.scrollTop;
    if (!sep) return;
    // 动效开着：章名轻轻一顶、蓝线从左扫到右；关着照旧底色闪一下
    if (MO.on()) { if (!sep.querySelector(".mo-sweep")) sep.insertAdjacentHTML("beforeend", '<i class="mo-sweep"></i>'); MO.play(sep, "mo-hit", 2200); }
    else { sep.classList.add("hit-flash"); setTimeout(() => sep.classList.remove("hit-flash"), 2400); }
  }
  /** 回到最新：窗口没到最新时整个重开（#live 本来就在，重开会按正常方式从尾巴取） */
  function backToLatest() {
    if (view.next == null) return false;
    openSession(view.sessionId);
    return true;
  }

  // 在已渲染的消息里从新往旧找搜索词；没找到就继续往前翻，最多翻 30 页
  function jumpToHit() {
    const q = view.jumpQ.toLowerCase(), norm = (x) => x.replace(/\s+/g, " ").toLowerCase();
    const bubbles = [...histEl.querySelectorAll(".msg .bubble")].reverse();
    const hit = bubbles.find((b) => norm(b.textContent).includes(q));
    if (!hit) {
      if (view.cursor && view.jumpPages++ < 30) { setTimeout(() => loadOlder(false)); return; }
      view.jumpQ = "";
      toast(t("没在加载的消息里找到「{q}」", { q }), true);
      return;
    }
    view.jumpQ = "";
    const tw = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n; (n = tw.nextNode());) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
    for (const n of nodes) {
      const i = n.nodeValue.toLowerCase().indexOf(q);
      const m = document.createElement("mark");
      m.className = "jump-hit";
      const r = n.splitText(i); r.splitText(q.length);
      r.parentNode.replaceChild(m, r); m.appendChild(r);
    }
    const msg = hit.closest(".msg");
    msg.classList.add("hit-flash");
    setTimeout(() => msg.classList.remove("hit-flash"), 2400);
    (hit.querySelector("mark.jump-hit") || msg).scrollIntoView({ block: "center" });
  }
  olderEl.addEventListener("click", () => loadOlder(false));
  chatScrollHooks.push(() => {
    if (chatEl.scrollTop < 240 && view.cursor && !view.loading && histEl.childElementCount) loadOlder(false);
    else if (view.next != null && !view.loading && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 240) loadNewer();
  });

  // ── 新会话首屏（照网页版的布局）：问候语居中，输入框紧跟在下面，示例和使用提示在输入框下方；
  //    输入框下面那行左边是项目、右边是型号与权限。发出第一条（或会话里出现任何别的东西）就退回平常的布局。
  //    html.wel 只看 #hist / #live 的直接子节点，流式输出不会触发
  // 标识：三道套在一起的 c 加圆心一个点 = c-c-c-o，跟原生启动动画同形（Mark.java）。外圈只画 218°、落笔停在正下方，
  // 比里面两道短一截（定稿时示意页就是这个样子，用户要的正是这点不对称）。进场从外往里写一遍，最后点亮圆心
  const WL_MARK = '<svg class="wl-mark" viewBox="0 0 48 48" aria-hidden="true"><path pathLength="1" d="M38.8 9.2A21 21 0 1 0 21.54 44.86"/><path pathLength="1" d="M33.2 14.8A13 13 0 1 0 33.2 33.2"/><path pathLength="1" d="M27.5 20.5A5 5 0 1 0 27.5 27.5"/><circle cx="24" cy="24" r="2.4"/></svg>';
  // 问候语看此刻的处境说话：几点、星期几、电量；同一时段有几句，每次随手挑一句
  let wlBat = null;
  try { navigator.getBattery && navigator.getBattery().then((b) => { wlBat = b; }).catch(() => {}); } catch {}
  function greeting() {
    const d = new Date(), h = d.getHours(), wd = d.getDay(), pool = [];
    if (wlBat && !wlBat.charging && wlBat.level <= 0.2) pool.push(t("电量见底了，挑件快的先做"));
    else if (wlBat && wlBat.charging && (h >= 22 || h < 6)) pool.push(t("插着电呢，大活可以放心跑"));
    if (h >= 0 && h < 5) pool.push(t("夜深了，屏幕还亮着"), t("这个点还在折腾，必有好点子"));
    else if (h < 8) pool.push(t("起得真早，先做点轻松的"));
    else if (h < 11) pool.push(wd === 1 ? t("周一，从一件小事开始") : t("上午好，口袋里的工作台已就绪"), t("趁脑子清楚，啃块硬骨头？"));
    else if (h < 14) pool.push(t("午休也闲不住？"), t("吃过饭了吗？顺手做点什么"));
    else if (h < 18) pool.push(t("下午好，接着上回的思路？"), t("泡杯茶，慢慢来"));
    else if (h < 21) pool.push(wd === 5 ? t("周五傍晚，做点好玩的") : t("傍晚了，收个尾还是开新坑？"));
    else pool.push(t("晚上好，适合慢慢写点东西"), t("夜里安静，想到什么就说"));
    if ((wd === 0 || wd === 6) && h >= 8 && h < 22) pool.push(t("周末，做点自己想做的"));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function showWelcome() {
    const b = mkMsg("bot", null, histEl);
    b.parentElement.classList.add("welcome");
    b.innerHTML = `<div class="wl-hero">${WL_MARK}<h1 class="wl-greet">${esc(greeting())}</h1></div><div class="setup-guide hidden"></div>`;
    fillSetupGuide(b.querySelector(".setup-guide"));
    paintWelBelow();
    MO.play(b.parentElement, "mo-in-rise", 1400);
  }
  // 输入框下方：只留「使用提示」（进帮助页）；原先还有三条示例，用户嫌不好看，去掉了
  const wlBelow = document.createElement("div");
  wlBelow.id = "wl-below";
  $("composer").after(wlBelow);
  function paintWelBelow() {
    wlBelow.innerHTML = `<div class="wl-ex"><button class="wl-chip wl-tips" data-help><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17v.01"/></svg>${esc(t("使用提示"))}</button></div>`;
  }
  wlBelow.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-help]"); if (b) openPage("help");
  });
  function welSync() {
    const w = histEl.childElementCount === 1 && !!histEl.querySelector(":scope > .msg.welcome") && !liveEl.childElementCount;
    if (document.documentElement.classList.contains("wel") === w) return;
    document.documentElement.classList.toggle("wel", w);
    syncPlaceholder(); paintProjChip(); welNarrow();
  }
  // 对话栏窄（开着右侧窗格、分屏）：首屏排得紧一点
  function welNarrow() { document.documentElement.classList.toggle("wel-narrow", colRect().width < 600); }
  addEventListener("resize", welNarrow);
  new MutationObserver(welSync).observe(histEl, { childList: true });
  new MutationObserver(welSync).observe(liveEl, { childList: true });
  // 输入框里的一行提示：首屏问「有什么可以帮你」，会话里提示斜杠命令
  function syncPlaceholder() {
    inputEl.placeholder = document.documentElement.classList.contains("wel") ? t("有什么可以帮你？") : t("输入 / 调用技能和命令");
  }

  /** 还没接上模型（没登录、没填 Key）：欢迎页里把两条路并排摆出来，不替用户选 */
  async function fillSetupGuide(box) {
    let s = null;
    try { s = await api("/api/status"); } catch { return; }
    let ready = s.keyMode === "key" || s.otherKey;
    if (s.keyMode === "login") { try { ready = !!(await api("/api/login/status")).loggedIn; } catch {} }
    if (ready || !box.isConnected) return;
    box.innerHTML = `<p><strong>${esc(t("开始之前，先接上模型（两条路选一条）："))}</strong></p>
      <div class="setup-paths">
        <div class="setup-path"><b>${esc(t("用 Claude 账户登录"))}</b>
          <div class="tiny">${esc(t("有 Claude Pro / Max 订阅，或 Anthropic Console 账户：在浏览器里授权一次就好，不用填 Key。"))}</div>
          <button class="btn sm" data-p="login">${esc(t("去登录"))}</button></div>
        <div class="setup-path"><b>${esc(t("填 API Key"))}</b>
          <div class="tiny">${esc(t("用 Anthropic 的 Key，或 DeepSeek、智谱 GLM、通义千问、Kimi 等兼容接口的 Key，按用量付费。"))}</div>
          <button class="btn sm" data-p="key">${esc(t("去选接口、填 Key"))}</button></div>
      </div>
      <div class="tiny">${esc(t("两条路都在 ☰ → 设置 → 接口，以后随时能换。"))}</div>`;
    box.classList.remove("hidden");
    box.addEventListener("click", (e) => {
      const p = e.target.dataset && e.target.dataset.p;
      if (!p) return;
      openDrawer("settings");
      const sel = $("set-provider");
      if (p === "login" && [...sel.options].some((o) => o.value === "anthropic")) {
        sel.value = "anthropic";
        sel.dispatchEvent(new Event("change"));
      }
      setTimeout(() => sel.scrollIntoView({ block: "center" }), 50);
      if (p === "key") sel.focus();
    });
  }

  // ── 事件总线 ──────────────────────────────────────────────────────
  let es = null, lastEventId = "", helloCount = 0, busWatch = 0;

  function connectBus(resume) {
    if (es) { try { es.close(); } catch {} }
    const url = "/api/events" + (resume && lastEventId ? "?since=" + encodeURIComponent(lastEventId) : "");
    es = new EventSource(url);
    es.onmessage = (m) => {
      if (m.lastEventId) lastEventId = m.lastEventId;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      try { onBus(ev); } catch (e) { console.error(e); }
    };
    es.onopen = () => setConn(true);
    es.onerror = () => {
      setConn(false);
      // 网关重启时浏览器有时会直接放弃（CLOSED）：那就自己再拨
      if (es.readyState === 2) { clearTimeout(busWatch); busWatch = setTimeout(() => connectBus(true), 2000); }
    };
  }
  function setConn(ok) {
    srv.connected = ok;
    if (!ok) setStatus(t("与网关断开，正在重连…（生成不受影响）"), "warn");
  }
  document.addEventListener("visibilitychange", () => {
    // 切回前台：WebView 在后台冻过，连接可能已经悄悄死了
    if (!document.hidden && (!es || es.readyState !== 1)) connectBus(true);
  });

  // ── 维护者通知（经 cccodroid.net，网关验过签；见 gw/notices.mjs）：和更新说明同样的居中卡片 ──
  // 什么时候弹（用户 10-22 定）：正在用的时候不弹；打开应用、或从后台切回来时才看一眼。
  // 这次打开弹了更新说明，通知就顺延到下一次打开 / 切回来，两张卡片不叠在一起。
  // 内容是纯文本；链接只认 https（网关已筛）。点「知道了」= 卡片里这几条都记为看过。
  let noticeHold = false;
  async function loadNotices() {
    if (noticeHold || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    let r;
    try { r = await api("/api/notices?lang=" + encodeURIComponent(I18N.lang || "zh")); } catch { return; }
    const list = r.items || [];
    if (!list.length || noticeHold || document.hidden || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    const el = document.createElement("div");
    el.id = "notice-pop";
    el.innerHTML = `<div class="wn-card" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <div class="wn-head" id="np-title">${esc(t("通知"))}</div>
      <div class="wn-body">${list.map((n, i) => `<section class="np-${n.level === "warn" ? "warn" : "info"}">
        <div class="wn-ver">${esc(n.date)}</div><div class="np-title">${esc(n.title)}</div>
        ${n.body ? `<div class="np-body">${esc(n.body)}</div>` : ""}
        ${n.link ? `<button class="btn sm" data-open="${i}">${esc(n.linkText || t("查看详情"))}</button>` : ""}</section>`).join("")}</div>
      <div class="wn-foot"><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    el.addEventListener("click", async (e) => {
      const o = e.target.closest("[data-open]");
      if (o) return openExternal(list[+o.dataset.open].link);
      if (!e.target.closest("[data-act=ok]")) return;
      OV.close(el);
      for (const n of list) {
        try { await api("/api/notices/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }); } catch {}
      }
    });
    OV.open(el, { kind: "modal", keep: true, cover: true });   // 返回键只是先收起，没点「知道了」下回还在
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { noticeHold = false; loadNotices(); } });

  function belongs(ev) {
    if (view.runIds.has(ev.runId)) return true;
    if (ev.cid && view.cids.has(ev.cid)) return true;
    if (view.sessionId && ev.sessionId === view.sessionId) return true;
    if (ev.follow && view.runIds.has(ev.follow)) return true;
    return false;
  }

  function onBus(ev) {
    switch (ev.type) {
      case "hello": return onHello(ev);
      case "tasks":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.tasks = ev.tasks || null; renderRunStrip(); }
        break;
      case "goal":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.goal = ev.goal || null; renderRunStrip(); }
        return;
      case "state": return applyState(ev);
      case "archive": return loadSessions();   // 建档 / 归入杂项：标题、档号、分组跟着变
      case "sched": case "sched_note": return onSchedEvent(ev);
      case "channel": return onChannelEvent(ev);
      case "sync": return;
      case "run_start": {
        if (!belongs(ev)) return;
        view.runIds.add(ev.runId);
        view.lastRunId = ev.runId;
        if (runViews.has(ev.runId)) return;
        if (ev.auto !== "idle") renderUser(ev.text, liveEl);
        const av = AssistantView(liveEl, true);
        if (ev.text.trim().startsWith("/")) av.msgEl.classList.add("sys");
        if (ev.auto === "idle") av.note(t("会话闲置快一小时，提示缓存快过期了，先自动压缩上下文，下一条消息就不用把整段历史重算一遍。不需要可以在设置里关掉。"), true);
        const timer = RunTimer(ev.startedAt);
        timer.attach(av);
        av.phase({ phase: "connect" });
        runViews.set(ev.runId, { av, startedAt: ev.startedAt, timer });
        scrollDown(true);
        return;
      }
      case "inject": {
        // 插话送达：在它被吃进去的位置画出这条消息，之后的回复另起一个气泡，时间顺序才对
        const rv = runViews.get(ev.runId);
        if (!rv) return;
        if (ev.cid) view.cids.add(ev.cid);
        rv.av.finish();
        if (rv.av.empty) rv.av.remove();
        renderUser(ev.text, liveEl);
        rv.av = AssistantView(liveEl, true);
        rv.avDone = false;
        if (rv.idle) { rv.idle = false; rv.timer = RunTimer(Date.now()); }   // 空闲时发来的消息：算新的一轮
        rv.timer?.attach(rv.av);          // 计时算整轮的，跟着最新的气泡走
        rv.av.phase({ phase: "connect" });
        scrollDown(true);
        return;
      }
      case "run_idle": {
        // 这一轮答完了，只是 Claude 起的后台任务（本地服务之类）还在跑
        const rv = runViews.get(ev.runId);
        if (rv && !rv.idle) { rv.idle = true; rv.timer?.stop(ev.at); rv.av.finish(); rv.avDone = true; }
        if (view.runIds.has(ev.runId)) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: ev.bg || 0 }), "ok");
        return;
      }
      case "run_busy": {
        // 后台任务回报了，Claude 接着干：另起一个气泡、重新计时
        const rv = runViews.get(ev.runId);
        if (!rv || !rv.idle) return;
        rv.idle = false;
        if (rv.avDone) { rv.av = AssistantView(liveEl, true); rv.avDone = false; }
        rv.timer = RunTimer(ev.startedAt);
        rv.timer.attach(rv.av);
        rv.av.phase({ phase: "connect" });
        scrollDown(true);
        return;
      }
      case "init": {
        if (!view.runIds.has(ev.runId)) return;
        if (!view.sessionId && ev.sessionId) { view.sessionId = ev.sessionId; adoptPendingModel(); saveUiState(); }
        if (ev.model) { state.model = ev.model; paintModel(ev.model); }
        if (ev.permissionMode) setPermChip(ev.permissionMode);
        return;
      }
      case "run_end": refreshQuota(); return onRunEnd(ev);
      case "quota": case "billing": return refreshQuota();
      case "perm_mode":
        state.settings.permissionMode = ev.mode;
        setPermChip(ev.mode);
        if ($("set-perm")) $("set-perm").value = ev.mode;
        return;
      case "perm_request": if (runViews.has(ev.runId)) onPermRequest(ev); return;
      case "perm_resolved": return permDone(ev.id, ev.behavior, ev);
    }
    const rv = runViews.get(ev.runId);
    if (!rv) return;
    const av = rv.av;
    switch (ev.type) {
      case "usage":          if (ev.contextTokens) updateCtx(ev.contextTokens, state.ctxTotal); break;
      case "delta":          av.delta(ev.text); break;
      case "assistant_text": av.text(ev.text); break;
      case "thinking_delta": av.thinkDelta(ev.text); break;
      case "thinking":       av.thinking(ev.text); break;
      case "discard_partial": av.discard(ev.text || 0, ev.think || 0); break;
      case "tool_use": {
        const pc = ev.parent && TOOL_CARDS.get(ev.parent);
        if (pc && pc.isAgent) { pc.sub(ev.id, ev.name, ev.input); break; }
        av.tool(ev.id, ev.name, ev.input); break;
      }
      case "sub_text":       TOOL_CARDS.get(ev.parent)?.subText?.(ev.text); break;
      case "sub_progress":   TOOL_CARDS.get(ev.parent)?.subProgress?.(ev.desc); break;
      case "sub_done":       TOOL_CARDS.get(ev.parent)?.subDone?.(ev.status); break;
      case "tool_result":    toolResult(ev.id, ev.ok, ev.text); av.toolDone(ev.id); scrollDown(); break;
      case "phase":          av.phase(ev); break;
      case "compacting":     av.phase(null); av.note(t("正在压缩上下文…")); scrollDown(); break;
      case "note":           av.noteK(ev.key, ev.text); scrollDown(); break;
      case "compacted":
        av.note(ev.pre != null && ev.post != null
          ? t("上下文已压缩：{pre} → {post} tokens", { pre: ev.pre.toLocaleString(), post: ev.post.toLocaleString() })
          : t("上下文已压缩"), true);
        if (ev.post != null) updateCtx(ev.post, state.ctxTotal);
        scrollDown(); break;
      case "error":          av.error(ev.message + (ev.detail ? "\n\n" + ev.detail : "")); break;
    }
  }

  function onHello(ev) {
    helloCount++;
    if (ev.uiTag && uiTag != null && ev.uiTag !== uiTag) {
      // 新界面已经部署了：生成在网关里不受影响，放心刷新
      setStatus(t("界面已更新，正在刷新…"), "warn");
      location.reload();
      return;
    }
    if (ev.uiTag) uiTag = ev.uiTag;
    applyState(ev);
    if (ev.resume) { setStatus(t("已连接"), "ok"); return; }

    // 续不上（首次连接 / 网关重启过 / 断太久）：本视图从头来 —— 历史重新取，
    // 正在跑的那一轮紧接着会被网关整轮重放过来
    if (helloCount === 1 && ev.run && !ev.run.ended) {
      // 刚打开界面时网关正忙：直接跟上那一轮（这才是用户最后在干的事）
      if (ev.run.sessionId) view.sessionId = ev.run.sessionId;
      else { view.sessionId = null; view.runIds.add(ev.run.id); }
      saveUiState();
    } else if (helloCount === 1 && !ev.run && ev.interrupted?.sessionId && !view.sessionId) {
      // 刚打开、上一轮是被系统杀掉的：直接回到那个会话，「继续」卡就挂在它底下
      view.sessionId = ev.interrupted.sessionId;
      saveUiState();
    }
    const keepRuns = new Set(view.runIds), keepCids = new Set(view.cids);
    const sid = view.sessionId, keepProj = view.projectId;   // 重连会重置视图：新会话已挑的项目留着
    const resume = sid && view.next != null && !view.anchor ? view.cursor : null;   // 正看着中间某一段：重连后接着那段
    resetView(sid);
    if (resume != null) view.resume = resume;
    if (!sid && keepProj) { view.projectId = keepProj; paintProjChip(); }
    view.runIds = keepRuns; view.cids = keepCids;
    pickViewRun();
    renderSessions();
    if (sid) loadOlder(true);
    else if (!(ev.run && keepRuns.has(ev.run.id))) showWelcome();
    renderInterrupted(ev.interrupted);   // resetView 清掉了 liveEl，重挂一次
    setStatus(t("已连接"), "ok");
  }

  function onRunEnd(ev) {
    if (view.goalClearAfter && view.goalClearAfter === ev.runId) { view.goalClearAfter = null; setTimeout(() => send("/goal clear"), 300); }
    const rv = runViews.get(ev.runId);
    if (!rv) { if (belongs(ev)) loadSessions(); return; }
    const av = rv.av;
    rv.timer?.stop();
    for (const [id, it] of PERMS) if (it.runId === ev.runId && !it.done) permDone(id, "stopped");
    if (ev.sessionId && !view.sessionId && view.runIds.has(ev.runId)) { view.sessionId = ev.sessionId; adoptPendingModel(); saveUiState(); }
    if (ev.usage?.context_tokens) updateCtx(ev.usage.context_tokens, ev.usage.context_window || state.ctxTotal);

    if (ev.localCommand && ev.resultText) {
      av.finish();
      if (av.empty) av.remove();
            const b = mkMsg("sys", t("命令"), liveEl);
      setHtml(b, `<div class="cmd-card"><div class="cmd-name">${esc("/" + ev.localCommand)}</div>${renderMd(ev.resultText)}</div>`);
      if (ev.localCommand === "context") parseContextText(ev.resultText);
      if (ev.localCommand === "model" || ev.localCommand === "effort") { loadSettings(); refreshSessModel(); }
      // 压缩线的刻度在 loadModels 里刷（以前只有切模型才会调它，所以设完要切一次模型才看得到）
      if (ev.localCommand === "autocompact") loadModels();
    } else {
      av.finish(ev.aborted);
      if (ev.aborted) av.note(t("已中断"));
      const bits = [];
      if (ev.durationMs) bits.push((ev.durationMs / 1000).toFixed(1) + "s");
      if (ev.usage?.output_tokens) bits.push("↓" + ev.usage.output_tokens + " tok");
      if (ev.costUsd) bits.push("$" + ev.costUsd.toFixed(4));
      statEl.textContent = bits.join(" · ");
    }
    if (ev.failed) setStatus(t("失败"), "err");
    else if (ev.aborted) setStatus(t("已中断"), "warn");
    else setStatus(t("就绪"), "ok");
    scrollDown();
    loadSessions();
    if (!state.caps?.slashCommands?.length) loadCaps();
  }

  // ── 忙闲与排队（都以网关为准）──────────────────────────────────────
  function applyState(s) {
    srv.runs = s.runs || (s.run ? [s.run] : []);
    srv.queueAll = s.queue || [];
    if (s.maxParallel) srv.max = s.maxParallel;
    pickViewRun();
    const busy = isBusy();
    sendEl.classList.toggle("busy", busy && !hasDraft());
    syncPlaceholder();
    syncInterject();
    renderQueue();
    lineageRuns();
    // 别的窗口（或网关那边）已经答掉的，这里也收起来
    const livePerms = new Set((srv.run?.perms || []).map((p) => p.id));
    for (const [id, it] of PERMS) if (!it.done && srv.run && it.runId === srv.run.id && !livePerms.has(id) && it.p.at < Date.now() - 1500) permDone(id, "gone");
    if (busy) setStatus(t("生成中…"), "live");
    else if (srv.run?.idle) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: srv.run.bg || 0 }), "ok");
    else if (srv.runs.some((r) => !r.idle)) setStatus(t("另有 {n} 个会话在生成", { n: srv.runs.filter((r) => !r.idle).length }), "ok");
    // 别的会话在等你确认：当前视图看不到它的卡片，状态栏和会话列表里提醒
    const elsewhere = srv.runs.filter((r) => r !== srv.run && r.perms && r.perms.length);
    if (elsewhere.length) setStatus(t("另一个会话在等你确认 · 打开会话列表查看"), "warn");
    const live = srv.runs.map((r) => (r.sessionId || "") + (r.perms && r.perms.length ? "!" : "") + (r.idle ? "~" : "")).join(",");
    if (live !== srv.liveKey) { srv.liveKey = live; renderSessions(); }
    renderPermBar();                 // 放最后：有待确认项时状态栏要显示「等你确认」
    renderInterrupted(s.interrupted);
    renderRunStrip();
  }

  /** 上一轮被系统结束（App 连同网关被杀）：在那个会话底部挂一张卡，给「继续」 */
  function renderInterrupted(it) {
    let el = $("intr-card");
    const here = it && !srv.run && (it.sessionId ? it.sessionId === view.sessionId : !view.sessionId);
    if (!here) { el?.remove(); return; }
    if (el && el.dataset.id === it.id && el.parentNode === liveEl) return;
    el?.remove();
    const b = mkMsg("sys", t("已中断"), liveEl);
    el = b.closest(".msg"); el.id = "intr-card"; el.dataset.id = it.id;
    const when = new Date(it.startedAt || it.at).toLocaleString();
    setHtml(b, `<p>${esc(t("这一轮没跑完：App 在后台被系统结束了（{when} 开始的）。", { when }))}</p>
      <blockquote>${esc(String(it.text || "").slice(0, 300))}</blockquote>
      <p class="perm-sub">${esc(it.sessionId
        ? t("已经做完的部分都在会话里。点「继续」让 Claude 从断开的地方接着做。")
        : t("会话还没来得及建立，Claude 没收到这条消息。点「重发」把它放回输入框。"))}</p>
      <div class="perm-acts"><button class="primary" data-a="go">${esc(it.sessionId ? t("继续") : t("重发"))}</button>
      <button data-a="no">${esc(t("忽略"))}</button></div>`);
    b.querySelector(".perm-acts").addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (!a) return;
      el.remove();
      if (a === "go" && it.sessionId) return send(t("上一轮被系统中断了，请从断开的地方接着做完。"));
      if (a === "go") { inputEl.value = it.text || ""; autoGrow(); inputEl.focus(); }
      api("/api/interrupted/dismiss", { method: "POST" }).catch(() => {});
    });
    scrollDown(true);
  }
  const isBusy = () => !!srv.run && !srv.run.idle;
  /** 并行上限真的满了（不算只剩后台任务的空闲轮次） */
  const atCap = () => srv.runs.filter((r) => !r.idle).length >= (srv.max || 3);

  /** 并行多会话：从网关的全部轮次和队列里挑出属于当前视图的 */
  function runInView(r) {
    return (view.sessionId && r.sessionId === view.sessionId) || view.runIds.has(r.id) || (!!r.follow && view.runIds.has(r.follow)) || (!!r.cid && view.cids.has(r.cid));
  }
  function queuedInView(q) {
    if (q.sessionId) return q.sessionId === view.sessionId;
    return view.runIds.has(q.id) || (!!q.follow && view.runIds.has(q.follow)) || (!!q.cid && view.cids.has(q.cid));
  }
  function pickViewRun() {
    srv.run = srv.runs.filter(runInView).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    srv.queue = srv.queueAll.filter(queuedInView);
  }

  /** 插话键只在「正在跑 + 输入框里有字」时露头 */
  function syncInterject() {
    const has = hasDraft();
    interjectEl.classList.toggle("hidden", !(isBusy() && has));
    sendEl.classList.toggle("busy", isBusy() && !has);
  }

  function renderQueue() {
    const q = srv.queue;
    queueStrip.classList.toggle("hidden", !q.length);
    const busy = isBusy();
    queueStrip.innerHTML = q.length ? `
      <div class="q-head">
        <span>${q.some((it) => it.held)
          ? q.some((it) => it.intr)
            ? t("上一轮被系统中断，{n} 条排队的消息已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
            : t("点了停止，{n} 条已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
          : busy ? t("待发 {n} 条 · 当前这一轮结束后依次发出", { n: q.length })
          // 真到并行上限才这么说；否则是这个会话上一轮还挂着（等后台任务 / 收尾），别让人以为开了好几个会话
          : atCap() ? t("同时在跑的会话已到上限（{max} 个），有空位就依次发出 · 待发 {n} 条", { max: srv.max, n: q.length })
          : t("待发 {n} 条 · 这个会话的上一轮还没完全结束（后台任务在跑或正在收尾），结束后依次发出", { n: q.length })}</span>
        <button class="q-clear">${t("全部清除")}</button>
      </div>
      ${q.map((it) => `
        <div class="msg user qitem${it.held ? " held" : ""}" data-id="${esc(it.id)}">
          <div class="who"><span class="dot"></span>${t("你")} · <span class="q-tag">${it.held ? t("已暂停") : t("排队中")}</span></div>
          <div class="bubble" dir="auto">${esc(it.text)}</div>
          <div class="q-acts">
            <button class="q-now" title="${busy ? t("插话：递进正在跑的这一轮，不打断") : t("发出这条")}">${t("立即发送")}</button>
            <button class="q-x" title="${t("撤销这条")}">${t("撤销")}</button>
          </div>
        </div>`).join("")}` : "";
    if (q.length) scrollDown();
  }
  queueStrip.addEventListener("click", async (e) => {
    const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .catch((err) => toast(err.message, true));
    if (e.target.closest(".q-clear")) return post("/api/queue/clear", { ids: srv.queue.map((it) => it.id) });
    const item = e.target.closest(".qitem");
    if (!item) return;
    if (e.target.closest(".q-x")) return post("/api/queue/remove", { id: item.dataset.id });
    if (e.target.closest(".q-now")) return post("/api/queue/promote", { id: item.dataset.id });
  });


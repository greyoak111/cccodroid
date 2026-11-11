  // ── 回到最新：往上翻得远了，右下角出一个 ↓ 圆钮；翻着的时候有新内容进来，钮上亮个点 ──
  const toBottomEl = document.createElement("button");
  toBottomEl.id = "btn-bottom";
  toBottomEl.className = "hidden";
  toBottomEl.setAttribute("aria-label", t("回到最新"));
  toBottomEl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  $("composer").appendChild(toBottomEl);
  let bottomH = 0, bottomRaf = 0;
  function syncBottomBtn() {
    bottomRaf = 0;
    const away = view.next != null || chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight > 320;
    toBottomEl.classList.toggle("hidden", !away);
    if (!away) toBottomEl.classList.remove("new");
    else if (chatEl.scrollHeight > bottomH + 4 && bottomH) toBottomEl.classList.add("new");
    bottomH = chatEl.scrollHeight;
  }
  const queueBottomSync = () => { if (!bottomRaf) bottomRaf = requestAnimationFrame(syncBottomBtn); };
  // 软键盘 / 窗口压矮时没有 scroll 事件：↓ 按钮要当场重算；原本贴底的跟着新视口继续贴底（0.6.9 审计 195-R.6）
  const onViewportResize = () => { queueBottomSync(); if (stick && !touching) scrollDown(true); };
  addEventListener("resize", onViewportResize);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportResize);
  // 整页本身永远停在顶上：根是 overflow:hidden，手指滚不动它，可长按选字拖到边缘、输入框聚焦、scrollIntoView 照样能把它滚走，
  // 而且滚走了就回不来 —— 顶栏 sticky 不动、用量条和下面整体错位（0.6.11 真机「用力按住上下拖动会漂移」）。
  // 消息区、各页面板都是自己的滚动容器，根和 body 不该有滚动位置；一有就拉回 0
  addEventListener("scroll", (e) => {
    const el = e.target === document ? document.scrollingElement : e.target;
    if ((el === document.scrollingElement || el === document.body) && (el.scrollTop || el.scrollLeft)) el.scrollTop = el.scrollLeft = 0;
  }, { capture: true, passive: true });
  chatScrollHooks.push(syncBottomBtn);
  // 内容长高才需要重算（以前盯整棵子树的每个字符变化，计时器每秒跳一下也触发）
  const bottomRO = new ResizeObserver(queueBottomSync);
  bottomRO.observe(histEl); bottomRO.observe(liveEl);
  toBottomEl.addEventListener("click", () => {
    toBottomEl.classList.remove("new");
    if (backToLatest()) return;
    chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "smooth" });
  });

  $("btn-files").addEventListener("click", () => openFiles());
  // 顶栏按钮怎么摆（0.4.20）：五个工具键各自「常驻」（挪进 #tb-pins，不折叠）/「收起」（照旧收在 ⋯ 里）/「隐藏」，外加先后顺序。
  //   存在 ccapp-ui.json 的 topbar：{ order, pin, off }；没设过就是全收起、原来的顺序。⋯ 里一个都不剩时 ⋯ 也藏掉
  const TB_BTNS = { files: "btn-files", term: "btn-term", web: "btn-web", palette: "btn-palette", new: "btn-new" };
  const TB_ORDER = Object.keys(TB_BTNS);
  function tbConf() {
    const c = uiGet("topbar") || {}, ok = (a) => (Array.isArray(a) ? a.filter((k) => TB_BTNS[k]) : []);
    const order = ok(c.order); for (const k of TB_ORDER) if (!order.includes(k)) order.push(k);
    return { order, pin: ok(c.pin), off: ok(c.off) };
  }
  function tbNumber() { [...document.querySelectorAll("#tb-tools .icon-btn:not(.hidden):not(.tb-off)")].reverse().forEach((b, i) => b.style.setProperty("--i", i)); }
  function paintTopbar() {
    const c = tbConf(), pins = $("tb-pins"), fold = document.querySelector("#tb-tools .tb-in");
    for (const k of c.order) {
      const b = $(TB_BTNS[k]); if (!b) continue;
      b.classList.toggle("tb-off", c.off.includes(k));
      const box = c.pin.includes(k) && !c.off.includes(k) ? pins : fold;
      if (b.parentNode !== box || box.lastElementChild !== b) box.appendChild(b);
    }
    const left = [...fold.querySelectorAll(".icon-btn")].some((b) => !b.classList.contains("tb-off") && !b.classList.contains("hidden"));
    $("btn-more").classList.toggle("tb-off", !left);
    tbNumber();
  }
  paintTopbar();
  document.addEventListener("cc:ui", (e) => { if (e.detail.key === "topbar") paintTopbar(); });
  // 顶栏工具键横向折叠：「⋯」点开、「›」收回，记住上次的状态。展开时按可见顺序倒着编号（--i），离「⋯」最近的先出来
  (() => {
    const more = $("btn-more"), KEY = "cc.tbOpen", root = document.documentElement;
    const set = (open) => {
      tbNumber();
      root.classList.toggle("tb-open", open);
      more.setAttribute("aria-expanded", String(open));
      more.setAttribute("aria-label", t(open ? "收起工具" : "展开工具"));
      try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
    };
    // 打开应用时按上次的样子直接摆好，不放动画
    root.classList.add("tb-still");
    set((() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })());
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("tb-still")));
    more.addEventListener("click", () => set(!root.classList.contains("tb-open")));
  })();
  // 命令面板靠输入框里的 / 文本过滤：整页盖着输入框时先退回对话，不然字打在看不见的输入框里（0.6.9 审计 195-R.7）
  $("btn-palette").addEventListener("click", () => { if (curPage) closePage(); openCmdPalette(""); inputEl.focus(); });
  $("btn-close-drawer").addEventListener("click", () => { if (window.CCLayout && CCLayout.docked()) CCLayout.collapse(); closeDrawer(true); });
  drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) closeDrawer(); });
  // 刷新失败要说失败（审查 B-OBSERVED-1）
  $("btn-refresh-sessions").addEventListener("click", async () => { const r = sess.mode === "trash" ? await loadTrash() : await loadSessions(); r === true ? toast(t("已刷新")) : toast(t("刷新失败：{msg}", { msg: r.message }), true); });
  $("btn-close-session").addEventListener("click", () => {
    closeDrawer();
    newConversation(t("已断开，下一条消息开新会话"));
  });

  $("btn-new").addEventListener("click", () => {
    if (newConversation()) toast(t("已开始新会话"));
  });

  // 截屏当附件（经 priv / Shizuku）。立刻截：分屏时连另一半一起截；延时截：先切到要截的应用，截完自动回来
  async function screenshot(delay) {
    // 截的途中切了会话：截图落回发起时那个会话的草稿（同 uploadFiles，#174-5）
    const ep0 = draftEpoch, key0 = view.sessionId || "";
    // 立刻截：不弹提示（会被截进去），等面板收起、动画走完再截
    if (delay) toast(t("{n} 秒后截屏，现在可以切到要截的应用", { n: delay }));
    else await new Promise((r) => setTimeout(r, 450));
    try {
      // 截屏要以 shell 身份跑：先经原生桥领一次性截屏码（priv 对白名单外的命令会弹确认，后台时直接拒绝）
      const shot = window.CCApp && CCApp.privShot ? String(CCApp.privShot(delay || 0) || "") : "";
      const j = await api("/api/screenshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delay, shot }) });
      if (draftEpoch !== ep0 && (view.sessionId || "") !== draftOwner(ep0, key0)) {
        draftPutAway(draftOwner(ep0, key0), "", [j]);
        return toast(t("{n} 个文件已附加到刚才那个会话的草稿", { n: 1 }));
      }
      state.attachments.push(j);
      renderAttachments();
      toast(t("已附加截屏"));
    } catch (e) { toast(e.message, true); }
  }

  // ＋ 快捷面板
  const sheetEl = $("sheet");
  // 宽屏：浮在 ＋ 上方的小卡片（宽 360，高不过 宽×φ 和上方剩余空间）；窄屏：底部弹层
  //   都只在对话这一栏里摆（右侧可能是浏览器 / 终端窗格）
  let sheetW = 0;
  function openSheet() {
    const p = sheetEl.querySelector(".sheet-panel"), col = colRect(), wide = col.width >= 560;
    sheetEl.classList.toggle("pop", wide);
    p.style.cssText = ""; sheetEl.style.left = sheetEl.style.right = "";
    MO.cancel(sheetEl); sheetEl.classList.remove("hidden");
    sheetW = innerWidth;
    if (!wide) { sheetEl.style.left = col.left + "px"; sheetEl.style.right = (innerWidth - col.right) + "px"; return; }
    const ar = $("btn-plus").getBoundingClientRect(), w = Math.min(360, col.width - 32);
    p.style.width = w + "px";
    p.style.left = Math.max(col.left + 16, Math.min(ar.left - 6, col.right - w - 16)) + "px";
    p.style.bottom = (fixedH() - ar.top + 10) + "px";
    p.style.maxHeight = Math.min(Math.round(w * 1.618), ar.top - 10 - 16) + "px";
  }
  $("btn-plus").addEventListener("click", openSheet);
  // Esc 收起加号面板（审查 #48 03-F05）
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented && !sheetEl.classList.contains("hidden") && !sheetEl._moLeave) { e.preventDefault(); MO.hide(sheetEl, "mo-out-sheet"); } });
  // 布局（layout.js）在浮层开合后会补发一次 resize，窗口其实没变 —— 只有宽度真变了才收，不然一开就闪没
  addEventListener("resize", () => { if (!sheetEl.classList.contains("hidden") && sheetEl.classList.contains("pop") && innerWidth !== sheetW) sheetEl.classList.add("hidden"); });
  // 截屏格长按 0.5 秒 = 5 秒后截屏（帮助里有写）；长按触发后吞掉随后的那次 click
  let shotHold = null, shotHeld = false;
  sheetEl.addEventListener("pointerdown", (e) => {
    if (!e.target.closest('.sheet-tile[data-act="shot"]')) return;
    shotHeld = false;
    clearTimeout(shotHold);
    shotHold = setTimeout(() => { shotHeld = true; sheetEl.classList.add("hidden"); screenshot(5); }, 500);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) sheetEl.addEventListener(ev, () => clearTimeout(shotHold));
  sheetEl.addEventListener("contextmenu", (e) => { if (e.target.closest('.sheet-tile[data-act="shot"]')) e.preventDefault(); });
  sheetEl.addEventListener("click", (e) => {
    if (e.target === sheetEl) { MO.hide(sheetEl, "mo-out-sheet"); return; }
    const it = e.target.closest(".sheet-item, .sheet-tile");
    if (!it) return;
    if (shotHeld) { shotHeld = false; return; }
    if (it.dataset.act === "shot") sheetEl.classList.add("hidden"); else MO.hide(sheetEl, "mo-out-sheet");   // 截屏别把菜单截进去
    const a = it.dataset.act;
    if (a === "new") return $("btn-new").click();
    if (a === "caps") return openPage("caps");
    if (a === "attach") return pickFiles();
    if (a === "camera") return $("cam-input").click();
    if (a === "shot" || a === "shot5") return screenshot(a === "shot5" ? 5 : 0);
    if (a === "browse") return openFiles();
    if (a === "model" || a === "effort") return openModelPicker();
    send("/" + a);
  });

  // ── 状态 ──────────────────────────────────────────────────────────
  let uiTag = null;              // 网关报的前端版本戳，变了就说明有新界面
  async function refreshStatus() {
    const ok = latest("status");   // 迟到的旧快照不许把厂商 / 安全模式 / 状态文字画回去（0.6.9 审计 195-BB.3）
    try {
      const s = await api("/api/status");
      if (!ok()) return;
      if (uiTag != null && s.uiTag && s.uiTag !== uiTag) {
        // v3 起生成不归页面管，随时刷新都安全
        setStatus(t("界面已更新，正在刷新…"), "warn");
        location.reload();
        return;
      }
      if (s.uiTag) uiTag = s.uiTag;
      if (s.product && document.title !== s.product) document.title = s.product;
      // 接口换了（或第一次拿到状态）：顶栏的额度 / 余额跟着换
      if (!QB.cur || QB.cur.id !== s.provider || QB.cur.login !== (s.keyMode === "login")) {
        if ((QB.cur ? QB.cur.id : qbLast && qbLast.id) !== s.provider) qbPaint({ text: "", lvl: 0 });   // 先画的是别家的：撤掉，等新的
        state.serverStatus = s; qbLoad(false).catch(() => {});
      }
      state.serverStatus = s;
      state.safeMode = !!s.safeMode;      // 权限下拉按它算实际生效的那档（0.6.9 审计 P1-12 前端半）
      paintAcct(s);
      paintSafeMode(s.safeMode);
      recheckSetup();
      // 日志分享靠安卓壳（cccodroid）打包、弹分享面板；旧版应用没有
      // 打包诊断、到 GitHub 反馈只有 cccodroid 有：整行藏起来
      $("btn-share-logs").closest(".srow").classList.toggle("hidden", s.product !== "cccodroid");
      $("btn-issue").closest(".srow").classList.toggle("hidden", s.product !== "cccodroid");
      $("btn-ledger").classList.toggle("hidden", !s.hasLedger);
      paintModel(curModel() || s.model || "—");
      state.model = s.model;
      // 登录态以 /api/status 的 auth 为准：配了「官方账户」不等于真的还登着；问不出（unknown）不算未登录，
      // stale 是沿用上次问到的结果，要标出来（0.6.9 审计 195-G.3）
      const auth = s.keyMode === "login" ? s.auth : null;
      const credTxt = s.keyMode !== "login" ? (s.hasKey ? t("已配置密钥") : t("未配置"))
        : !auth ? t("官方登录态")
        : auth.unknown ? t("官方登录态 · 问不出登录状态")
        : auth.stale ? (auth.loggedIn ? t("官方登录态 · 上次问到时已登录") : t("官方登录态 · 上次问到时未登录"))
        : auth.loggedIn ? t("官方登录态 · 已登录") : t("官方登录态 · 未登录");
      const needLogin = !!auth && auth.loggedIn === false && !auth.unknown;
      $("status-box").textContent =
                `${t("网关")}     ${s.version} (pid ${s.pid})\n` +
        `${t("运行时")}   ${s.ready ? t("就绪") : t("缺失")}\n` +
        `${t("厂商")}     ${provName(s)}\n` +
        `${t("上游")}     ${s.upstream}\n` +
        `${t("凭据")}     ${credTxt}\n` +
        `${t("DNS 桥")}   ${s.bridge ? t("已连接") : t("未启动")}\n` +
        `${t("模型")}     ${s.model || t("(由 claude 决定)")}\n` +
        `${t("生成")}     ${s.busy ? t("进行中") : t("空闲")}${s.queued ? t(" · 排队 {n} 条", { n: s.queued }) : ""}\n` +
        `${t("工作区")}   ${s.workspace}`;
      if (es && !srv.connected) {
        // SSE 断了但 HTTP 还通：这里以前画成「就绪」，把「正在重连」盖掉（0.6.9 审计 195-BB.2）。
        // 同时用 /api/state 补一份快照，别让徽标、权限条、工具卡冻结在断线前
        setStatus(t("与网关断开，正在重连…（生成不受影响）"), "warn");
        api("/api/state").then(applyState).catch(() => {});
      } else if (!s.busy) {
        // 官方账户实际没登录（或上次问到时没登）就别再说「就绪」：一发消息就失败（0.6.9 审计 195-G.3）
        setStatus(needLogin ? t("需要登录账户") : s.ready && s.hasKey ? t("就绪") : s.hasKey ? t("运行时缺失") : t("需要配置密钥"),
          s.ready && s.hasKey && !needLogin ? "ok" : "warn");
      }
    } catch (e) {
      if (!ok()) return;
      // 手机浏览器从 127.0.0.1 / localhost 打开：/api 因来源校验必然 403，网关其实在线（0.6.9 审计 195-G.6）
      if (e.status === 403 && location.hostname !== "127.0.0.2") {
        srv.foreign = true;
        clearTimeout(busWatch); busWatch = 0;
        if (es) { try { es.close(); } catch {} es = null; }
        $("status-box").textContent = t("请在 cccodroid 应用里打开");
        setStatus(t("请在 cccodroid 应用里打开"), "warn");
        return;
      }
      $("status-box").textContent = t("无法连接网关：{msg}", { msg: e.message });
      setStatus(t("网关离线"), "err");
    }
  }

  // 调试口：外部测试壳用它读状态，不参与任何逻辑
  // 触摸诊断（常驻、只读）：最近 100 条触摸 / 指针取消 / 滚动事件，排查"偶发上下滑不动、按钮照常能点"用。
  // 冻住时经 WebView 调试读 window.__touchLog —— 这个 bug 没法预约复现，临时埋点等不到现场。
  (() => {
    const L = (window.__touchLog = []), T0 = performance.now();
    const who = (t) => (t && (t.id || (typeof t.className === "string" && t.className.split(" ")[0]) || t.tagName)) || "?";
    const add = (s) => { L.push(Math.round(performance.now() - T0) + " " + s); if (L.length > 100) L.shift(); };
    for (const ty of ["touchstart", "touchend", "touchcancel", "pointercancel"])
      document.addEventListener(ty, (e) => add(ty + " " + who(e.target) + (e.touches ? " n=" + e.touches.length : "")), { capture: true, passive: true });
    let last = 0;
    document.addEventListener("scroll", (e) => { const n = performance.now(); if (n - last > 300) { last = n; add("scroll " + who(e.target)); } }, { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => add("visibility " + document.visibilityState));

    // 2026-10-16：以前这里有个"拖了不滚就接管"的兜底（还会把 overflow 关了再开去「踢」滚动容器），已去掉，滚动完全交给系统。
    // 去掉后触摸滚动仍会整个冻住：页面照常收到 touchmove，WebView 就是不出滚动；同站重载不好，跨站跳一次再回来才好，
    // 说明卡在 WebView 给这个文档的手势状态上，不在页面代码里。上面的 __touchLog 只被动记录，留着抓触发现场。
  })();

  // ── 滚动冻结脱困（自动 + 顶栏雪花按钮）──────────────────────────────
  //  冻住时页面救不了自己：跨站跳转会被壳当外链拦掉，只能请壳（CCApp.unfreeze）跳一次 127.0.0.2:9 再回来。
  //  会话 id 本来就在 localStorage；输入框草稿先放 sessionStorage，回来再填上。
  //  每次脱困都在 localStorage["cc.freezeLog"] 留最近 5 次现场（含触摸日志尾巴），以后找触发条件用。
  (() => {
    const FZ_LOG = "cc.freezeLog", FZ_AT = "cc.unfrozeAt", FZ_DRAFT = "cc.draft";
    try {
      const d = sessionStorage.getItem(FZ_DRAFT);
      sessionStorage.removeItem(FZ_DRAFT);
      if (d && !inputEl.value) { inputEl.value = d; inputEl.dispatchEvent(new Event("input")); }
    } catch {}
    // 普通的重新载入（切语言、换执行方式、刷新状态）也一样：页面卸掉前把没发的草稿记下（审查 #49 待确认-3）
    addEventListener("pagehide", () => { try { draftPersist(); if (inputEl.value) sessionStorage.setItem(FZ_DRAFT, inputEl.value); } catch {} });
    function unfreeze(why) {
      try {
        const log = JSON.parse(localStorage.getItem(FZ_LOG) || "[]");
        log.push({ at: new Date().toISOString(), why, touch: (window.__touchLog || []).slice(-40) });
        localStorage.setItem(FZ_LOG, JSON.stringify(log.slice(-5)));
        if (inputEl.value) sessionStorage.setItem(FZ_DRAFT, inputEl.value);
        sessionStorage.setItem(FZ_AT, String(Date.now()));
        // keepalive：紧接着就跳走了，普通请求会被掐掉
        fetch("/api/freeze", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ why, touch: log[log.length - 1].touch }) }).catch(() => {});
      } catch {}
      if (window.CCApp && window.CCApp.unfreeze) { toast(t("正在重新挂载界面…")); window.CCApp.unfreeze(); }
      else toast(t("这个版本的应用还不能脱困，请更新应用；临时办法是重启网关"), true);
    }
    // 手动脱困：长按顶栏标题 0.6 秒（按住时标题慢慢变淡，到点轻振一下）。冻住时点按照常能用，触摸事件也都收得到；
    // 手指挪开 10px 或松手就取消。不另占一个按钮
    (() => {
      const tb = $("title-block");
      let timer = 0, x0 = 0, y0 = 0;
      const stop = () => { clearTimeout(timer); timer = 0; tb.classList.remove("lp"); };
      tb.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return stop();
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
        tb.classList.add("lp");
        clearTimeout(timer);
        timer = setTimeout(() => { timer = 0; tb.classList.remove("lp"); try { navigator.vibrate && navigator.vibrate(12); } catch {} unfreeze("manual"); }, 600);
      }, { passive: true });
      tb.addEventListener("touchmove", (e) => { const p = e.touches[0]; if (timer && p && Math.hypot(p.clientX - x0, p.clientY - y0) > 10) stop(); }, { passive: true });
      tb.addEventListener("touchend", stop);
      tb.addEventListener("touchcancel", stop);
      tb.addEventListener("contextmenu", (e) => e.preventDefault());
    })();
    window.__ccUnfreeze = unfreeze;

    // 自动判定：单指竖向拖了 60px 以上、手指下的滚动容器明明还能往那个方向滚，
    // 松手 350ms 后 scrollTop 却没往那个方向动过 —— 连续两次（20 秒内）就算冻住。
    // 只看「朝手指方向的位移」：生成时贴底的程序滚动是往下的，不会把一次往上翻的失败盖掉。
    const scroller = (el) => {
      for (; el && el !== document.body; el = el.parentElement)
        if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
      return null;
    };
    let g = null, sus = 0, susAt = 0;
    document.addEventListener("touchstart", (e) => {
      g = null;
      if (e.touches.length !== 1 || e.target.closest("textarea,input,.xterm")) return;
      const el = scroller(e.target);
      if (el) g = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, top: el.scrollTop, lo: el.scrollTop, hi: el.scrollTop, t: performance.now(), prevented: false };
    }, { capture: true, passive: true });
    document.addEventListener("touchmove", (e) => { if (g && e.defaultPrevented) g.prevented = true; }, { passive: true });
    document.addEventListener("touchcancel", () => { g = null; }, { capture: true, passive: true });
    document.addEventListener("scroll", (e) => {
      if (g && e.target === g.el) { const v = g.el.scrollTop; if (v < g.lo) g.lo = v; if (v > g.hi) g.hi = v; }
    }, { capture: true, passive: true });
    document.addEventListener("touchend", (e) => {
      const s = g; g = null;
      if (!s || e.touches.length || s.prevented) return;
      const p = e.changedTouches[0], dx = p.clientX - s.x, dy = p.clientY - s.y;
      if (Math.abs(dy) < 60 || Math.abs(dy) < 2 * Math.abs(dx) || performance.now() - s.t > 2000) return;
      const max = s.el.scrollHeight - s.el.clientHeight;
      if ((dy > 0 ? s.top : max - s.top) < 40) return;           // 到头了或只剩一点能滚（内容刚好比屏幕长一丁点），滚不动不算冻住
      if (String(getSelection() || "").length) return;            // 在拖选文字
      setTimeout(() => {
        if (!s.el.isConnected) return;
        const v = s.el.scrollTop, moved = dy > 0 ? Math.min(s.lo, v) < s.top - 8 : Math.max(s.hi, v) > s.top + 8;
        if (moved) { sus = 0; return; }
        const now = Date.now();
        sus = now - susAt < 20000 ? sus + 1 : 1; susAt = now;
        (window.__touchLog || []).push("freeze? " + sus);
        if (sus < 2) return;
        sus = 0;
        const last = Number(sessionStorage.getItem(FZ_AT)) || 0;
        if (now - last < 60000) toast(t("滚动好像卡住了，可以点顶栏的雪花按钮脱困"), true);   // 刚自动救过一次，别来回跳
        else unfreeze("auto");
      }, 350);
    }, { capture: true, passive: true });
  })();

  // ── 竖屏横滑拉出侧栏 ───────────────────────────────────────────────
  //  在对话区里从左往右滑（RTL 反过来；首屏时输入框和它下面那块不在 #chat 里，一并算进来，不然那片划不动）：侧栏跟着手指出来，松手时过了五分之一或轻轻一甩就展开，否则缩回去。
  //  贴边那一条留给系统的返回手势（安卓会先吃掉），这里管的是对话区里面起手的横滑。
  //  不抢的情况：常驻左栏（宽屏）、侧栏 / 整页 / 浮层已开、多指、在输入框 / 终端里、在拖选文字、
  //  手指下有还能往右滚的横向内容（代码块、表格滚过了就先让它滚回去）。
  //  起手 8px 就判方向（赶在系统开始滚动之前）：横向不小于竖向就接管，接管后拦掉这次的竖向滚动；否则整个手势交还系统。
  (() => {
    const panel = drawerEl.querySelector(".drawer-panel");
    if (!panel) return;
    const rtl = () => document.documentElement.dir === "rtl";
    const hScrollable = (el) => {
      for (; el && el !== document.body; el = el.parentElement)
        if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)
            && (rtl() ? el.scrollLeft < 0 : el.scrollLeft > 0)) return true;
      return false;
    };
    let g = null;
    // 遮罩跟着手指由浅到深（只改 #drawer 的底色，别动 opacity —— 那会让侧栏本身也半透明）
    // 毛玻璃也跟着手指由无到有（原来拖动时关着、松手才一下打开，背景「突然一虚」—— 群友 10-27）
    const scrim = (k) => { drawerEl.style.background = `color-mix(in srgb, var(--scrim) ${Math.round(k * 100)}%, transparent)`; drawerEl.style.backdropFilter = k >= 1 ? "" : `blur(${(2 * k).toFixed(2)}px)`; };
    const reset = () => { panel.style.transition = ""; panel.style.transform = ""; drawerEl.style.transition = ""; drawerEl.style.background = ""; drawerEl.style.backdropFilter = ""; };
    // 手势开出来的侧栏把滑入动画关了（不然展开后再播一遍）；收起时还原，下次点菜单键照常有动画
    new MutationObserver(() => { if (drawerEl.classList.contains("hidden")) { panel.style.animation = ""; reset(); } })
      .observe(drawerEl, { attributes: true, attributeFilter: ["class"] });
    const zones = [chatEl, $("composer"), $("wl-below")].filter(Boolean);
    const onStart = (e) => {
      g = null;
      if (e.touches.length !== 1 || !drawerEl.classList.contains("hidden") || !$("pages").classList.contains("hidden")) return;
      if ((window.CCLayout && CCLayout.docked()) || OV.top() || document.querySelector("#sheet:not(.hidden), #popup:not(.hidden)")) return;
      // 输入区的按钮 / 附件卡起手不算抽屉手势：从发送、附加这些键上滑过去时别被抽屉抢走（0.6.9 审计 196-移动.2）
      if (e.target.closest("textarea,input,select,.xterm") || e.target.closest("#composer button,#composer .att,#composer .chip,#composer [role=button]")
        || String(getSelection() || "").length || hScrollable(e.target)) return;
      const p = e.touches[0];
      g = { x: p.clientX, y: p.clientY, t: performance.now(), on: false, w: 0, dx: 0, lastX: p.clientX, lastT: performance.now(), v: 0 };
    };
    const onMove = (e) => {
      if (!g || e.touches.length !== 1) { g = null; return; }
      const p = e.touches[0], dx = (p.clientX - g.x) * (rtl() ? -1 : 1), dy = p.clientY - g.y;
      if (!g.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (!(dx > 0 && dx >= Math.abs(dy))) { g = null; return; }
        g.on = true;
        // 三栏宽屏收起时：横滑同样回到常驻侧栏，和菜单键一致（不拉出盖在对话上的抽屉）
        if (window.CCLayout && CCLayout.expand && CCLayout.tier() >= 3) { g = null; CCLayout.expand(); return; }
        panel.style.animation = "none";
        panel.style.transition = drawerEl.style.transition = "none";
        panel.style.transform = rtl() ? "translateX(100%)" : "translateX(-100%)";   // 先藏在屏外再显示，别闪一下全开
        scrim(0);
        openDrawer();
        g.w = panel.getBoundingClientRect().width || 300;
        panel.style.transition = drawerEl.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();      // 系统已经开始滚了就拦不住，照样跟手
      const now = performance.now();
      g.v = ((p.clientX - g.lastX) * (rtl() ? -1 : 1)) / Math.max(1, now - g.lastT);
      g.lastX = p.clientX; g.lastT = now;
      g.dx = Math.max(0, Math.min(g.w, dx - 8));
      const k = g.dx / g.w;
      panel.style.transform = `translateX(${(rtl() ? 1 : -1) * (g.w - g.dx)}px)`;
      scrim(k);
    };
    const end = () => {
      const s = g; g = null;
      if (!s || !s.on) return;
      const open = s.dx > s.w / 5 || s.v > 0.3;
      if (!open && MO.on()) { closeDrawer(true, true); return; }   // 没拉够：从手指那里缩回去，走统一的收起
      drawerEl.style.transition = "background-color .18s ease";
      if (open && MO.on()) {
        // 松手展开：从手指放开的位置用弹簧落定（和点菜单键打开一个手感）；收回去仍是干脆的缓动
        const x0 = (rtl() ? 1 : -1) * (s.w - s.dx);
        panel.style.transition = "none"; panel.style.transform = "translateX(0)";
        MO.spring(panel, "snap", (p) => ({ transform: `translateX(${x0 * (1 - p)}px)` }));
      } else {
        panel.style.transition = "transform .18s ease";
        panel.style.transform = open ? "translateX(0)" : `translateX(${(rtl() ? 1 : -1) * s.w}px)`;
      }
      scrim(open ? 0.999 : 0);
      setTimeout(() => { if (open) reset(); else closeDrawer(true); }, 190);
    };
    for (const z of zones) {
      z.addEventListener("touchstart", onStart, { passive: true });
      z.addEventListener("touchmove", onMove, { passive: false });
      z.addEventListener("touchend", end, { passive: true });
      z.addEventListener("touchcancel", end, { passive: true });
    }

    // 收回：侧栏开着时，在侧栏或遮罩上从右往左推（RTL 反过来），侧栏跟手退回去；推过五分之一或轻轻一甩就收起，否则弹回。
    // 同样先判方向（横向明显大于竖向才接管，竖着滑照常滚对话列表）；拖宽度的把手、输入框、能往左滚的横向内容不接管
    let c = null;
    const hScrollableIn = (el) => {
      for (; el && el !== drawerEl; el = el.parentElement)
        if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)
            && (rtl() ? el.scrollLeft > -(el.scrollWidth - el.clientWidth) + 1 : el.scrollLeft < el.scrollWidth - el.clientWidth - 1)) return true;
      return false;
    };
    drawerEl.addEventListener("touchstart", (e) => {
      c = null;
      if (e.touches.length !== 1 || drawerEl.classList.contains("hidden") || (window.CCLayout && CCLayout.docked()) || OV.top()) return;
      if (e.target.closest("textarea,input,select,.drawer-split") || String(getSelection() || "").length || hScrollableIn(e.target)) return;
      const p = e.touches[0];
      c = { x: p.clientX, y: p.clientY, on: false, w: 0, dx: 0, lastX: p.clientX, lastT: performance.now(), v: 0 };
    }, { passive: true });
    drawerEl.addEventListener("touchmove", (e) => {
      if (!c || e.touches.length !== 1) { c = null; return; }
      const p = e.touches[0], dx = (c.x - p.clientX) * (rtl() ? -1 : 1), dy = p.clientY - c.y;   // dx > 0：往收起的方向推
      if (!c.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (!(dx > 0 && dx >= Math.abs(dy))) { c = null; return; }
        c.on = true;
        c.w = panel.getBoundingClientRect().width || 300;
        panel.style.animation = "none";               // 别让收起途中再播滑入动画
        panel.style.transition = drawerEl.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();      // 系统已经开始滚了就拦不住，照样跟手
      const now = performance.now();
      c.v = ((c.lastX - p.clientX) * (rtl() ? -1 : 1)) / Math.max(1, now - c.lastT);
      c.lastX = p.clientX; c.lastT = now;
      c.dx = Math.max(0, Math.min(c.w, dx - 8));
      panel.style.transform = `translateX(${(rtl() ? 1 : -1) * c.dx}px)`;
      scrim(1 - c.dx / c.w);
    }, { passive: false });
    const endClose = () => {
      const s = c; c = null;
      if (!s || !s.on) return;
      const shut = s.dx > s.w / 5 || s.v > 0.3;
      if (shut && MO.on()) { closeDrawer(true, true); return; }   // 从手指放开的位置接着滑出去，和点遮罩收起同一套
      panel.style.transition = "transform .18s ease";
      drawerEl.style.transition = "background-color .18s ease";
      panel.style.transform = shut ? `translateX(${(rtl() ? 1 : -1) * s.w}px)` : "translateX(0)";
      scrim(shut ? 0 : 0.999);
      setTimeout(() => { if (shut) closeDrawer(true); else reset(); }, 190);
    };
    drawerEl.addEventListener("touchend", endClose, { passive: true });
    drawerEl.addEventListener("touchcancel", endClose, { passive: true });
  })();

  // 返回键 / 侧滑返回：壳先问这里，从最上层往下关一层浮层，关了就返回 true；什么都没开才由壳把界面退到后台。
  // 顺序按 z-index 从高到低（灯箱 90 > 终端文本 73 > 终端 72 > 查看器 71 > 文件 70 > 补全弹窗 60 > 底部菜单 55 > 侧栏 50）
  window.__ccBack = guardHook("__ccBack", () => {
    const open = (id) => !$(id).classList.contains("hidden") && !$(id)._moLeave;   // 正在退场的不算开着，返回键往下一层走
    if (OV.back()) return true;     // 菜单、速览卡、弹层：关最上面那个
    const steps = [
      ["lightbox", () => MO.hide($("lightbox"), "mo-out-fade")],
      ["set-ov", setBack],             // 设置是模态（z80），盖在右侧窗格上面：先关它，别把底下看不见的窗格关了（审查 V-01）
      ["term-textview", () => $("term-textview").classList.add("hidden")],
      ["browser", closeBrowser],
      ["term", closeTerm],
      ["git", closeGit],
      ["viewer", closeViewer],          // 有未保存修改会先问；选了不丢弃也算处理过，别把界面退到后台
      ["files", closeFiles],
      ["popup", hidePopup],
      ["sheet", () => MO.hide($("sheet"), "mo-out-sheet")],
      ["drawer", closeDrawer],
      ["lin-prof", linProfBack],        // 脉络的剖面：一轮 → 一章 → 钻进来之前的会话 → 收起，再往下才关整页
      // 项目 / 定时任务的详情：先回列表，再关整页
      ["pages", () => { if (curPage === "projects" && PJ.cur) { PJ.cur = null; PJ.detail = null; renderProjects(); } else if (curPage === "sched" && SC.cur) { SC.cur = null; SC.detail = null; renderSched(); } else closePage(); }],
    ];
    // 宽屏：文件 / 查看器 / 终端并排停在右边，先关最近打开的那个，而不是按 z-index；常驻的侧栏不算浮层
    const L = window.CCLayout;
    const recent = L ? L.openPanes() : [];
    if (recent.length) {
      const order = recent.slice().reverse();
      const panes = steps.filter(([id]) => order.includes(id)).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      const at = steps.findIndex(([id]) => order.includes(id));
      steps.splice(0, steps.length, ...steps.slice(0, at).filter(([id]) => !order.includes(id)), ...panes, ...steps.slice(at).filter(([id]) => !order.includes(id)));
    }
    for (const [id, close] of steps) {
      if (id === "drawer" && L && L.docked()) continue;
      if (open(id)) { close(); return true; }
    }
    return false;
  });
  if (window.CCLayout) CCLayout.init({ openDrawer: () => openDrawer(), closeDrawer,
    // 常驻栏展开：面板从左边弹进来（右边内容已经让出位置）
    dockIn: () => MO.spring(drawerEl.querySelector(".drawer-panel"), "snap", (p) => ({ transform: `translateX(${(MO.rtl() ? 100 : -100) * (1 - p)}%)` })) });
  window.__cc = { view, srv, state, send, abort, openSession, newConversation, openPage, bus: onBus,   // bus：测试时往前端灌事件
    openGit, openViewer, openFiles, openDrawer, showWhatsNew, mdEd: () => VW.ed, provCard: (id) => { state.provView = id; renderProvCard(); },
    lin: { prof: linProfOpen, pick: linPickStart, wiz: mergeWizard, get: () => LIN } };   // 脉络：探针直接开剖面 / 多选 / 汇合向导

  // ── 启动 ──────────────────────────────────────────────────────────
  (async function boot() {
    view.sessionId = loadUiState();      // 上次的会话号与用量，先捞回来
    draftLoad(view.sessionId);           // 进程被杀前没发的草稿也捞回来（0.6.9 审计 195-D.3）
    updateCtx(state.ctxUsed, state.ctxTotal);
    setStatus(t("正在连接网关…"));

    await refreshStatus();
    // 本地不知道用哪条，就问网关「最近真正跑过哪条会话」—— 总比默默开个新会话强
    if (!view.sessionId && state.serverStatus?.lastSessionId) {
      // 走草稿交接：新对话没发的字留在新对话名下，不跟着进上一条会话（0.6.9 审计 195-R.5）
      draftSwap(view.sessionId, state.serverStatus.lastSessionId);
      view.sessionId = state.serverStatus.lastSessionId;
      saveUiState();
    }
    connectBus(false);                   // hello 到了就会去取历史 / 接上正在跑的那一轮

    await Promise.all([loadSettings(), loadCaps(), loadLinkDev()]);
    await loadSessions();
    setTimeout(() => loadLinkDev().then((changed) => { if (changed) loadSessions(); }), 3500);
    // 启动时网关没起来 / 接口闪断：loadSettings 自己把错吞了，基础设置会长期停在默认值。
    // 隔一会儿看一眼，没拿到设置就补拉，最多三次（0.6.9 审计 195-N.3）
    const ensureSettings = (left) => setTimeout(async () => {
      if (Object.keys(state.settings || {}).length) return;
      await loadSettings();
      if (left > 1) ensureSettings(left - 1);
    }, 4000);
    ensureSettings(3);
    uiSync(); loadFonts();               // 界面定制（ccapp-ui.json）、导入字体的清单，各和本地缓存对一下（换过机、清过缓存时补回来）
    updateCtx(state.ctxUsed, state.ctxTotal);   // 别把恢复回来的用量抹成 0
    // 后台时不轮询（#56），切回前台补一次
    let statusMissed = false;
    setInterval(() => {
      if (document.hidden) statusMissed = true;
      else {
        refreshStatus();
        loadLinkDev().then((changed) => { if (changed) loadSessions(); });
      }
    }, 45000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (statusMissed) { statusMissed = false; refreshStatus(); }
      // 后台期间 WebView 可能暂停事件流；回到前台补一次，不靠切页面。
      loadLinkDev().finally(() => loadSessions());
    });
    // 设置里有几类（设备与权限、更新、通知、用量……）要等接口回话才显示：开机空下来先拉一遍，
    // 打开设置时就是现成的，不再一项项往外冒（打开时照旧再刷一次）
    setTimeout(() => { if (!setOpen) { loadProviders(); loadPriv(); loadUpd(); loadNotify(); loadDev(); loadQuota().catch(() => {}); } }, 2500);
    if (showWhatsNew()) noticeHold = true;     // 刚弹了更新说明：通知等下一次打开 / 切回来
    else loadNotices();
  })();

  /** 更新说明：更新后第一次打开时，主窗口正中弹一张卡片（外壳决定显示哪几版，见 WhatsNew.java；
   *  全新安装、开发端外壳没有这个接口时什么都不做）。显示出来就记为看过 */
  function showWhatsNew() {
    const A = window.CCApp;
    if (!A || typeof A.whatsNew !== "function") return false;
    let list = [];
    try { list = JSON.parse(A.whatsNew(isZh() ? "zh" : ((window.I18N && I18N.lang) || "en")) || "[]"); } catch { return false; }
    if (!Array.isArray(list) || !list.length) return false;
    const el = document.createElement("div");
    el.id = "whatsnew";
    el.innerHTML = `<div class="wn-card" role="dialog" aria-modal="true" aria-labelledby="wn-title">
      <div class="wn-head" id="wn-title">${esc(t("更新说明"))}</div>
      <div class="wn-body">${list.map((x) => `<section><div class="wn-ver">v${esc(x.v)}</div><div class="bubble wn-md">${renderMd(x.md)}</div></section>`).join("")}
        <section class="wn-cm"><div class="wn-ver">${esc(t("交流与反馈"))}</div>${communityHtml(true)}</section></div>
      <div class="wn-foot"><button class="btn ghost" data-act="log">${esc(t("更新日志"))}</button><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    const close = () => OV.close(el);
    communityBind(el);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-act=log]")) { close(); openPage("changelog"); }
      else if (e.target === el || e.target.closest("[data-act=ok]")) close();
    });
    el.querySelectorAll(".wn-md a[href]").forEach((a) => a.addEventListener("click", (e) => {
      const u = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(u) && A.openUrl) { e.preventDefault(); A.openUrl(u); }
    }));
    OV.open(el, { kind: "modal", keep: true, cover: true });
    try { A.whatsNewSeen(); } catch {}
    return true;
  }
})();

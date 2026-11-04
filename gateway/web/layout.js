// 大屏布局（设计稿 §2 E）：按窗口宽度分档，宽屏时把浮层变成停靠的窗格。
// 分档、窗格摆放、分隔条、"避开某条竖线"都只在这一个文件里 —— 想改折叠屏适配的从这里下手。
//
//   < 840 CSS px：单栏，文件 / 查看器 / 终端照旧盖满屏幕（窄屏行为一字不改）
//   ≥ 840：两栏 —— 对话 + 右侧工作区；文件 / 查看器 / 终端开在右边，不盖对话
//   ≥ 1000：三栏 —— 再把侧栏（会话 / 设置 / 能力 / 扩展）常驻在左边，可收起
//   手机横屏（高 < 500、横着、宽 ≥ 720）：照平板来 —— 侧栏常驻，三个最小宽度各收一档（侧栏 220 / 对话 340 / 窗格 280）。
//     放得下三栏就三栏；放不下时开着右侧窗格，常驻侧栏临时让位（rotate），窗格关完再回来；让位期间菜单键开的是浮层抽屉
//
// 只按窗口宽度分档，不看横竖：手机横屏宽但矮、折叠屏展开近似方形、分屏是半个窗口。
// 宽 → 窄（分屏、折叠屏合上）时 html 上的类一撤，窗格自动退回浮层，里面的状态原样不动。
//
// 折叠屏（实验，0.4.18）：外壳（MainActivity.pushFold）经系统窗口扩展库拿到折痕，发 ccfold 事件过来，这里按折痕分栏 ——
//   一条竖折痕（书本式、阔折叠）展开：照三栏来，左页常驻侧栏、右页对话；开右侧窗格时侧栏让位，窗格左缘落在折痕上
//   两条竖折痕（三折叠）展开：左扇侧栏、中扇对话、右扇窗格，两条分界线各对一条折痕
//   竖折痕半开：小弹窗挪到对话那一页（html.fold-half-v + --fpad）；横折痕半开（立在桌上）：输入框落到下半屏（html.fold-table + --fbelow）
//   铰链有宽度（--fgap）：算进侧栏，侧栏内容往里收，不放到缝里
//   拖过分隔条就听用户的，记在另外的键里（键名加 _f），不碰平板上记的宽度；双击回到对齐折痕
//   设置 → 外观「折叠屏适配（实验）」可关（cc_lay_fold = "0"），关了就当没有折痕
// CCLayout.setAvoid(x) 仍保留：没有折痕时，外面也能指定一条要避开的竖线。
(function () {
  "use strict";
  const W2 = 840, W3 = 1000, SHORT = 500, LAND_W = 720;
  let MIN_CHAT = 380, MIN_PANE = 320;   // 手机横屏时 apply() 改小一档
  const PANES = ["files", "viewer", "git", "term", "browser"];   // 宽屏时进右侧工作区的
  const tk = (s) => s;   // 词条键：先登记（扫描器认它），显示时 tr()
  const NAMES = { files: tk("文件"), viewer: tk("查看"), git: tk("版本"), term: tk("终端"), browser: tk("浏览器") };
  // 浏览器窗格是外壳的原生视图，永远浮在页面上面 —— 这些浮层开着时得先把它藏起来，不然会被它挡住
  const COVERS = ["lightbox", "sheet", "popup", "drawer", "dropzone", "set-ov"];   // set-ov：设置卡片是模态，盖在窗格上面
  const LS_RATIO = "cc_lay_ratio", LS_DOCK = "cc_lay_dock", LS_LW = "cc_lay_lw", LS_DW = "cc_lay_dw";
  let MIN_SIDE = 240; const MAX_SIDE = 560;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const tr = (s) => (window.I18N && I18N.t ? I18N.t(s) : s);

  // 折叠屏：fold = 外壳最近报来的 { fold, list }；fv = 正在起作用的竖折痕（从左到右），fh = 立在桌上时的横折痕
  const LS_FOLD = "cc_lay_fold";
  let fold = null, fv = [], fh = null;
  const fk = (k) => (fv.length ? k + "_f" : k);
  let tier = 1, avoid = null, hooks = {}, ovCover = false, ready = false, land = false, rotate = false;   // ovCover：app.js 的浮层管理说有弹层盖着
  const recent = [];                                       // 打开顺序，最后一个在最上面
  const isOpen = (id) => { const el = $(id); return !!el && !el.classList.contains("hidden"); };
  const rtl = () => root.getAttribute("dir") === "rtl";
  const docked = () => tier >= 3 && !rotate && localStorage.getItem(LS_DOCK) !== "0";

  // 常驻侧栏宽度：拖过就用拖的（像素），没拖过按窗口宽度给个默认；总要给对话留够 MIN_CHAT
  function leftWidth() {
    if (!docked()) return 0;
    const saved = parseFloat(localStorage.getItem(fk(LS_LW)));
    if (!(saved > 0) && fv.length) {          // 侧栏右缘落在（第一条）折痕上，铰链宽度也算进侧栏
      const f = rtl() ? fv[fv.length - 1] : fv[0];
      return Math.round(rtl() ? innerWidth - f.x : f.x + f.w);
    }
    const w = saved > 0 ? saved : land ? 240 : 286;     // 默认照设计稿；手机横屏窄一点
    // 右边开着窗格时也要给它留出最窄宽度：先把侧栏拖到 560 再开终端，对话会被挤成一百来像素（审查 #48 UI05-005 / #49 P2-16）
    const rp = tier >= 2 && recent.some(isOpen) ? MIN_PANE : 0;
    return Math.round(Math.max(MIN_SIDE, Math.min(MAX_SIDE, innerWidth - MIN_CHAT - rp, w)));
  }

  // 浮层侧栏（竖屏 / 窄屏，盖在对话上面的那种）宽度：拖过就用拖的，没拖过按窗口给大一点（约 62%），右边总留一条能点着关掉
  function drawerWidth() {
    const max = Math.max(260, Math.min(MAX_SIDE, Math.round(innerWidth * 0.86), innerWidth - 56));
    const saved = parseFloat(localStorage.getItem(LS_DW));
    const w = saved > 0 ? saved : Math.max(320, innerWidth * 0.62);
    return Math.round(Math.max(Math.min(MIN_SIDE, max), Math.min(max, w)));
  }

  function rightWidth() {
    const lw = leftWidth(), avail = innerWidth - lw;
    let rw;
    const saved = parseFloat(localStorage.getItem(fk(LS_RATIO)));
    let av = avoid;
    if (fv.length) { const f = rtl() ? fv[0] : fv[fv.length - 1]; av = rtl() ? f.x : f.x + f.w; }   // 窗格左缘落在（最后一条）折痕上
    if (saved > 0 && saved < 1) rw = avail * saved;
    else if (av != null) rw = rtl() ? av : innerWidth - av;   // 分界落在要避开的线上
    else rw = avail * 0.5;                                 // 默认五五分，书本形态大体对齐铰链
    return Math.round(Math.max(MIN_PANE, Math.min(avail - MIN_CHAT, rw)));
  }

  let rz = 0;
  function apply() {
    const w = innerWidth, h = innerHeight;
    land = h < SHORT && w > h && w >= LAND_W;
    MIN_CHAT = land ? 340 : 380; MIN_PANE = land ? 280 : 320; MIN_SIDE = land ? 220 : 240;
    // 折痕：两边都得留得下东西才算（分屏、窗口没跨过折痕时系统本来也不报）
    const fl = fold && fold.fold !== "none" && localStorage.getItem(LS_FOLD) !== "0" ? fold.list || [] : [];
    fv = fl.filter((f) => f.dir === "v" && f.x >= 200 && f.x + f.w <= w - 200);
    fh = fl.find((f) => f.dir === "h" && f.state === 2 && f.y >= 160 && f.y + f.h <= h - 100) || null;
    const halfV = fv.length === 1 && fv[0].state === 2;
    root.classList.toggle("fold-split", fv.length > 0);
    root.classList.toggle("fold-half-v", halfV);
    root.classList.toggle("fold-table", !!fh);
    root.style.setProperty("--fbelow", (fh ? Math.max(0, Math.round(h - fh.y - fh.h)) : 0) + "px");
    const nt = land || fv.length || w >= W3 ? 3 : w >= W2 ? 2 : 1;
    const was = tier, wasDocked = root.classList.contains("dock-l");
    tier = nt;
    root.dataset.lay = String(tier);
    root.classList.toggle("short", h < SHORT);
    root.classList.toggle("land", land);
    // 先看右侧开着哪些窗格：手机横屏放不下三栏时，开着窗格就让常驻侧栏让位
    for (const id of PANES) { const i = recent.indexOf(id); if (!isOpen(id) && i >= 0) recent.splice(i, 1); }
    const open = recent.filter(isOpen);
    // 一条竖折痕时一页侧栏一页对话，再开窗格就没地方了：侧栏让位，窗格占侧栏那一页的对面
    rotate = open.length > 0 && (fv.length === 1 || land && !fv.length && w < MIN_SIDE + MIN_CHAT + MIN_PANE);

    // 左侧常驻侧栏：进三栏时展开（除非用户收起过），退出三栏时收回去，别留一个盖满屏幕的抽屉
    // 收常驻栏要赶在摘 dock-l 之前：摘掉后侧栏会先变回盖满屏的抽屉（整屏遮罩 + 毛玻璃）闪一帧
    const dock = docked();
    if (!dock && wasDocked && hooks.closeDrawer) hooks.closeDrawer(true);
    root.classList.toggle("dock-l", dock);
    // 抽屉正在收（退场动画里）也算没开：不然收完把侧栏藏了，常驻位却还空着一条（审查 #48 NAV-01）
    if (dock && !wasDocked && (isOpen("drawer") === false || $("drawer")._moShut) && hooks.openDrawer) hooks.openDrawer();
    if (dock && !wasDocked && ready && hooks.dockIn) hooks.dockIn();   // 启动时那次不放
    root.style.setProperty("--lw", leftWidth() + "px");
    const gf = fv.length && dock && !(parseFloat(localStorage.getItem(fk(LS_LW))) > 0) ? (rtl() ? fv[fv.length - 1] : fv[0]) : null;
    root.style.setProperty("--fgap", (gf ? Math.round(gf.w) : 0) + "px");
    root.style.setProperty("--dw", drawerWidth() + "px");

    // 右侧工作区
    const right = tier >= 2 && open.length > 0;
    root.classList.toggle("has-right", right);
    // 书本式半开：弹层只铺在对话那一页（--fpl / --fpr 是物理左右边距）。开着窗格时对话在窗格对面那页，否则在侧栏对面那页
    let fpl = 0, fpr = 0;
    if (halfV) {
      const a = Math.round(fv[0].x), b = Math.round(fv[0].x + fv[0].w);
      if (rtl() ? !right : right) fpr = w - a; else fpl = b;
    }
    root.style.setProperty("--fpl", fpl + "px");
    root.style.setProperty("--fpr", fpr + "px");
    root.classList.toggle("ws-multi", right && open.length > 1);
    root.style.setProperty("--rw", (right ? rightWidth() : 0) + "px");
    const top = open[open.length - 1];
    for (const id of PANES) { const el = $(id); if (el) el.classList.toggle("ws-top", right && id === top); }
    // 终端被盖住：它的文本视图跟着让位（审查 UI05-002），键盘焦点也交出来，不然按键打进看不见的终端（UI05-001）
    root.classList.toggle("term-under", right && top !== "term");
    if (right && top !== "term" && $("term") && $("term").contains(document.activeElement)) document.activeElement.blur();
    renderTabs(right ? open : [], top);
    placeBrowser();

    // 查看器里的 PDF 靠 window resize 重排；终端自己有 ResizeObserver
    if (was !== tier || right) { clearTimeout(rz); rz = setTimeout(() => { busy = true; dispatchEvent(new Event("resize")); busy = false; }, 120); }
  }

  // 浏览器：把占位框的位置报给外壳（CSS px，相对页面左上角）；不在最上面、或被浮层盖着就报 0 让它先藏起来
  let lastB = "";
  function placeBrowser() {
    if (!(window.CCApp && CCApp.paneBounds)) return;
    let r = null;
    const open = recent.filter(isOpen);
    const covered = ovCover || COVERS.some((id) => isOpen(id)
      && !(id === "drawer" && root.classList.contains("dock-l"))     // 常驻左栏不挡
      && !(id === "popup" && tier >= 2));                            // 宽屏时补全弹窗挪到了窗格左边
    if (isOpen("browser") && open[open.length - 1] === "browser" && !covered) {
      const b = $("browser-slot").getBoundingClientRect();
      if (b.width > 0 && b.height > 0) r = [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10);
    }
    const k = r ? r.join(",") : "0";
    if (k === lastB) return;
    lastB = k;
    if (r) CCApp.paneBounds(r[0], r[1], r[2], r[3]); else CCApp.paneBounds(0, 0, 0, 0);
  }

  function renderTabs(open, top) {
    const bar = $("ws-tabs");
    if (!bar) return;
    bar.textContent = "";
    if (open.length < 2) return;
    for (const id of open) {
      const b = document.createElement("button");
      b.className = "ws-tab" + (id === top ? " active" : "");
      b.textContent = tr(NAMES[id]);
      b.onclick = () => raise(id);
      bar.appendChild(b);
    }
  }

  function raise(id) {
    const i = recent.indexOf(id);
    if (i >= 0) recent.splice(i, 1);
    recent.push(id);
    apply();
  }

  // 面板开关全由 app.js 改 hidden 类 —— 这里只盯着类的变化，不用去改每个 open / close 函数
  function watch() {
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        const id = m.target.id;
        // 只认"由隐藏变打开"：ws-top 之类的类变化也会进来，别把它当成新打开
        if (PANES.includes(id) && isOpen(id) && /\bhidden\b/.test(m.oldValue || "")) {
          const i = recent.indexOf(id);
          if (i >= 0) recent.splice(i, 1);
          recent.push(id);
        }
      }
      apply();
    });
    for (const id of PANES.concat(COVERS.filter((c) => c !== "drawer"), "drawer")) { const el = $(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ["class"], attributeOldValue: true }); }
  }

  // 分隔条：拖动改右侧宽度，比例记在 localStorage；双击回到默认
  function splitter() {
    const s = $("ws-split");
    if (!s) return;
    let drag = false;
    s.addEventListener("pointerdown", (e) => { drag = true; try { s.setPointerCapture(e.pointerId); } catch {} root.classList.add("ws-drag"); e.preventDefault(); });
    s.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const lw = leftWidth(), avail = innerWidth - lw;
      let rw = rtl() ? e.clientX : innerWidth - e.clientX;
      rw = Math.max(MIN_PANE, Math.min(avail - MIN_CHAT, rw));
      localStorage.setItem(fk(LS_RATIO), (rw / avail).toFixed(4));
      root.style.setProperty("--rw", rw + "px");
      placeBrowser();
    });
    const end = () => { if (!drag) return; drag = false; root.classList.remove("ws-drag"); apply(); };
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("dblclick", () => { localStorage.removeItem(fk(LS_RATIO)); apply(); });
  }

  // 侧栏右边缘的拖拽条：拖动改常驻侧栏宽度，记在 localStorage；双击回到默认
  function sideSplitter() {
    const s = document.createElement("div");
    s.id = "side-split";
    s.setAttribute("role", "separator");
    s.setAttribute("aria-orientation", "vertical");
    document.body.appendChild(s);
    let drag = false;
    s.addEventListener("pointerdown", (e) => { drag = true; try { s.setPointerCapture(e.pointerId); } catch {} root.classList.add("side-drag"); e.preventDefault(); });
    s.addEventListener("pointermove", (e) => {
      if (!drag) return;
      let lw = rtl() ? innerWidth - e.clientX : e.clientX;
      const rw = root.classList.contains("has-right") ? MIN_PANE : 0;
      lw = Math.round(Math.max(MIN_SIDE, Math.min(MAX_SIDE, innerWidth - MIN_CHAT - rw, lw)));
      localStorage.setItem(fk(LS_LW), String(lw));
      root.style.setProperty("--lw", lw + "px");
      placeBrowser();
    });
    const end = () => { if (!drag) return; drag = false; root.classList.remove("side-drag"); apply(); };
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("dblclick", () => { localStorage.removeItem(fk(LS_LW)); apply(); });
  }

  // 浮层侧栏右边缘的拖拽条（和常驻侧栏同款）：拖动改宽度，记在 localStorage；双击回到默认
  function drawerSplitter() {
    const panel = document.querySelector("#drawer .drawer-panel");
    if (!panel) return;
    const s = document.createElement("div");
    s.className = "drawer-split";
    s.setAttribute("role", "separator");
    s.setAttribute("aria-orientation", "vertical");
    panel.appendChild(s);
    let drag = false;
    s.addEventListener("pointerdown", (e) => { drag = true; try { s.setPointerCapture(e.pointerId); } catch {} root.classList.add("side-drag"); e.preventDefault(); e.stopPropagation(); });
    s.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const max = Math.max(260, Math.min(MAX_SIDE, Math.round(innerWidth * 0.86), innerWidth - 56));
      let w = rtl() ? innerWidth - e.clientX : e.clientX;
      w = Math.round(Math.max(Math.min(MIN_SIDE, max), Math.min(max, w)));
      localStorage.setItem(LS_DW, String(w));
      root.style.setProperty("--dw", w + "px");
    });
    const end = () => { if (!drag) return; drag = false; root.classList.remove("side-drag"); };
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("click", (e) => e.stopPropagation());          // 别让点击漏到遮罩上把抽屉关了
    s.addEventListener("dblclick", (e) => { e.stopPropagation(); localStorage.removeItem(LS_DW); apply(); });
  }

  let busy = false, raf = 0;
  addEventListener("resize", () => { if (busy) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); });

  // 折痕：外壳在页面加载、窗口变化（合上 / 展开 / 半开）时报过来；先到的也收着，init 之后再排
  function takeFold(f) {
    fold = f && f.list ? f : null;
    if (fold && fold.list.length) try { localStorage.setItem("cc_lay_fold_seen", "1"); } catch {}
    syncFoldSetting();
    if (ready) { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); }
  }
  addEventListener("ccfold", (e) => takeFold(e.detail));
  if (window.__ccFold) takeFold(window.__ccFold);
  // 设置 → 外观「折叠屏适配（实验）」：只在报过折痕的设备上露出来
  function syncFoldSetting() {
    const row = $("row-fold");
    if (!row) return;
    row.classList.toggle("hidden", localStorage.getItem("cc_lay_fold_seen") !== "1");
    const on = localStorage.getItem(LS_FOLD) !== "0";
    row.querySelectorAll("[data-fold-on]").forEach((b) => b.classList.toggle("on", (b.dataset.foldOn === "1") === on));
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#row-fold [data-fold-on]");
    if (!b) return;
    localStorage.setItem(LS_FOLD, b.dataset.foldOn === "1" ? "1" : "0");
    syncFoldSetting();
    apply();
  });

  window.CCLayout = {
    // app.js 启动时交过来：openDrawer() 展开侧栏并加载数据，closeDrawer(force) 收起
    init(h) { hooks = h || {}; watch(); splitter(); sideSplitter(); drawerSplitter(); syncFoldSetting(); apply(); ready = true; },
    tier: () => tier,
    docked,
    // 宽屏下处于停靠状态的右侧窗格，按"最近打开在后"排；返回手势先关最后一个
    // 窄屏照旧按 z-index 关；但开着浏览器时它是原生视图、总在最上面，也得按打开顺序来
    openPanes: () => (tier >= 2 || isOpen("browser") ? recent.filter(isOpen) : []),
    raise,
    // 三栏时顶栏菜单键：常驻 ↔ 收起
    toggleDock() {
      if (tier < 3 || rotate) return false;   // 让位期间：交给菜单键原来那套（浮层抽屉）
      const on = !(docked() && isOpen("drawer"));
      localStorage.setItem(LS_DOCK, on ? "1" : "0");
      if (on) hooks.openDrawer && hooks.openDrawer(); else hooks.closeDrawer && hooks.closeDrawer(true);
      apply();
      return true;
    },
    collapse() { if (tier >= 3) localStorage.setItem(LS_DOCK, "0"); apply(); },
    // 三栏时收起过的侧栏要叫回来：一律回到常驻，不走窄屏那套盖在对话上的抽屉（遮罩 + 毛玻璃）——
    // 以前菜单键回常驻、横滑和别的入口却开出抽屉，同一块屏两种侧栏。返回 true 表示已接手
    expand() {
      if (tier < 3 || rotate || docked()) return false;
      localStorage.setItem(LS_DOCK, "1");
      apply();
      return true;
    },
    syncFoldSetting,
    fold: () => ({ fold, fv, fh }),
    setAvoid(x) { avoid = x == null ? null : +x; apply(); },
    cover(on) { ovCover = !!on; placeBrowser(); },
    // 原生浏览器窗格眼下摆在哪（[左, 上, 宽, 高]，CSS px）；没摆出来返回 null。提示条据此躲开它
    paneRect: () => (lastB && lastB !== "0" ? lastB.split(",").map(Number) : null),
    apply,
  };
})();

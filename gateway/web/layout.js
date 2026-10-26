// 大屏布局（设计稿 §2 E）：按窗口宽度分档，宽屏时把浮层变成停靠的窗格。
// 分档、窗格摆放、分隔条、"避开某条竖线"都只在这一个文件里 —— 想改折叠屏适配的从这里下手。
//
//   < 840 CSS px：单栏，文件 / 查看器 / 终端照旧盖满屏幕（窄屏行为一字不改）
//   ≥ 840：两栏 —— 对话 + 右侧工作区；文件 / 查看器 / 终端开在右边，不盖对话
//   ≥ 1000：三栏 —— 再把侧栏（会话 / 设置 / 能力 / 扩展）常驻在左边，可收起
//   高度 < 500（手机横屏）：不加栏，只压缩顶栏和输入区
//
// 只按窗口宽度分档，不看横竖：手机横屏宽但矮、折叠屏展开近似方形、分屏是半个窗口。
// 宽 → 窄（分屏、折叠屏合上）时 html 上的类一撤，窗格自动退回浮层，里面的状态原样不动。
//
// 给折叠屏留的口子：CCLayout.setAvoid(x) —— x 是一条要避开的竖线（CSS px，比如铰链）。
// 设了以后，用户没拖过分隔条时，右侧工作区的左边缘就落在这条线上。传 null 取消。
// 我们的构建链不带 Jetpack WindowManager，拿铰链位置要靠外壳（或社区的改版）调这个接口。
(function () {
  "use strict";
  const W2 = 840, W3 = 1000, SHORT = 500;
  const MIN_CHAT = 380, MIN_PANE = 320;
  const PANES = ["files", "viewer", "git", "term", "browser"];   // 宽屏时进右侧工作区的
  const tk = (s) => s;   // 词条键：先登记（扫描器认它），显示时 tr()
  const NAMES = { files: tk("文件"), viewer: tk("查看"), git: tk("版本"), term: tk("终端"), browser: tk("浏览器") };
  // 浏览器窗格是外壳的原生视图，永远浮在页面上面 —— 这些浮层开着时得先把它藏起来，不然会被它挡住
  const COVERS = ["lightbox", "sheet", "popup", "drawer", "dropzone", "set-ov"];   // set-ov：设置卡片是模态，盖在窗格上面
  const LS_RATIO = "cc_lay_ratio", LS_DOCK = "cc_lay_dock", LS_LW = "cc_lay_lw", LS_DW = "cc_lay_dw";
  const MIN_SIDE = 240, MAX_SIDE = 560;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const tr = (s) => (window.I18N && I18N.t ? I18N.t(s) : s);

  let tier = 1, avoid = null, hooks = {}, ovCover = false, ready = false;   // ovCover：app.js 的浮层管理说有弹层盖着
  const recent = [];                                       // 打开顺序，最后一个在最上面
  const isOpen = (id) => { const el = $(id); return !!el && !el.classList.contains("hidden"); };
  const rtl = () => root.getAttribute("dir") === "rtl";
  const docked = () => tier >= 3 && localStorage.getItem(LS_DOCK) !== "0";

  // 常驻侧栏宽度：拖过就用拖的（像素），没拖过按窗口宽度给个默认；总要给对话留够 MIN_CHAT
  function leftWidth() {
    if (!docked()) return 0;
    const saved = parseFloat(localStorage.getItem(LS_LW));
    const w = saved > 0 ? saved : 286;     // 默认照设计稿
    return Math.round(Math.max(MIN_SIDE, Math.min(MAX_SIDE, innerWidth - MIN_CHAT, w)));
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
    const saved = parseFloat(localStorage.getItem(LS_RATIO));
    if (saved > 0 && saved < 1) rw = avail * saved;
    else if (avoid != null) rw = rtl() ? avoid : innerWidth - avoid;   // 分界落在要避开的线上
    else rw = avail * 0.5;                                 // 默认五五分，书本形态大体对齐铰链
    return Math.round(Math.max(MIN_PANE, Math.min(avail - MIN_CHAT, rw)));
  }

  let rz = 0;
  function apply() {
    const w = innerWidth, h = innerHeight;
    const nt = w >= W3 ? 3 : w >= W2 ? 2 : 1;
    const was = tier, wasDocked = root.classList.contains("dock-l");
    tier = nt;
    root.dataset.lay = String(tier);
    root.classList.toggle("short", h < SHORT);

    // 左侧常驻侧栏：进三栏时展开（除非用户收起过），退出三栏时收回去，别留一个盖满屏幕的抽屉
    // 收常驻栏要赶在摘 dock-l 之前：摘掉后侧栏会先变回盖满屏的抽屉（整屏遮罩 + 毛玻璃）闪一帧
    const dock = docked();
    if (!dock && wasDocked && hooks.closeDrawer) hooks.closeDrawer(true);
    root.classList.toggle("dock-l", dock);
    if (dock && !wasDocked && isOpen("drawer") === false && hooks.openDrawer) hooks.openDrawer();
    if (dock && !wasDocked && ready && hooks.dockIn) hooks.dockIn();   // 启动时那次不放
    root.style.setProperty("--lw", leftWidth() + "px");
    root.style.setProperty("--dw", drawerWidth() + "px");

    // 右侧工作区
    for (const id of PANES) { const i = recent.indexOf(id); if (!isOpen(id) && i >= 0) recent.splice(i, 1); }
    const open = recent.filter(isOpen);
    const right = tier >= 2 && open.length > 0;
    root.classList.toggle("has-right", right);
    root.classList.toggle("ws-multi", right && open.length > 1);
    root.style.setProperty("--rw", (right ? rightWidth() : 0) + "px");
    const top = open[open.length - 1];
    for (const id of PANES) { const el = $(id); if (el) el.classList.toggle("ws-top", right && id === top); }
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
      localStorage.setItem(LS_RATIO, (rw / avail).toFixed(4));
      root.style.setProperty("--rw", rw + "px");
      placeBrowser();
    });
    const end = () => { if (!drag) return; drag = false; root.classList.remove("ws-drag"); apply(); };
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("dblclick", () => { localStorage.removeItem(LS_RATIO); apply(); });
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
      localStorage.setItem(LS_LW, String(lw));
      root.style.setProperty("--lw", lw + "px");
      placeBrowser();
    });
    const end = () => { if (!drag) return; drag = false; root.classList.remove("side-drag"); apply(); };
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("dblclick", () => { localStorage.removeItem(LS_LW); apply(); });
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

  window.CCLayout = {
    // app.js 启动时交过来：openDrawer() 展开侧栏并加载数据，closeDrawer(force) 收起
    init(h) { hooks = h || {}; watch(); splitter(); sideSplitter(); drawerSplitter(); apply(); ready = true; },
    tier: () => tier,
    docked,
    // 宽屏下处于停靠状态的右侧窗格，按"最近打开在后"排；返回手势先关最后一个
    // 窄屏照旧按 z-index 关；但开着浏览器时它是原生视图、总在最上面，也得按打开顺序来
    openPanes: () => (tier >= 2 || isOpen("browser") ? recent.filter(isOpen) : []),
    raise,
    // 三栏时顶栏菜单键：常驻 ↔ 收起
    toggleDock() {
      if (tier < 3) return false;
      const on = !(docked() && isOpen("drawer"));
      localStorage.setItem(LS_DOCK, on ? "1" : "0");
      if (on) hooks.openDrawer && hooks.openDrawer(); else hooks.closeDrawer && hooks.closeDrawer(true);
      apply();
      return true;
    },
    collapse() { if (tier >= 3) localStorage.setItem(LS_DOCK, "0"); apply(); },
    setAvoid(x) { avoid = x == null ? null : +x; apply(); },
    cover(on) { ovCover = !!on; placeBrowser(); },
    apply,
  };
})();

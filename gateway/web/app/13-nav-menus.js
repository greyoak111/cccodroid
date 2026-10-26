  // ── 侧栏 / 整页 ───────────────────────────────────────────────────
  // 侧栏（#drawer）只放：新对话、去哪（导航）、对话列表、账户行。设置 / 能力 / 扩展 / 用量 / 帮助是主区域的整页（#pages），
  // 宽屏时侧栏和右侧窗格都留着、整页只占对话那一块；窄屏整页盖住对话，返回键回到对话。
  function openDrawer(tab) {
    if (tab && tab !== "sessions") return openPage(tab);
    OV.closeAll();
    MO.cancel(drawerEl);
    // 收到一半又打开：从停下的位置用弹簧弹回来，别跳
    const back = drawerEl._moShut ? drawerEl._moShut() : null;
    const wasHidden = drawerEl.classList.contains("hidden");
    if (back != null) MO.spring(drawerEl.querySelector(".drawer-panel"), "snap", (p) => ({ transform: `translateX(${back * (1 - p)}px)` }));
    drawerEl.classList.remove("hidden");
    refreshStatus();
    loadSessions();
    if (!tab) loadCaps();
    renderSideNav();
    loadProjects(); loadSched();
    // 条目一个接一个跟上（点菜单键、横滑拉出都放）；点菜单键的再加遮罩淡入、面板弹出 ——
    // 横滑拉出的面板跟着手指走（手势把面板动画关了），松手由手势那边用弹簧落定。常驻左栏不放
    const panel = drawerEl.querySelector(".drawer-panel");
    if (wasHidden && MO.on() && panel && !(window.CCLayout && CCLayout.docked())) {
      MO.stagger(drawerEl.querySelectorAll(".side-new, .side-nav > .nav-item, .side-recent > :is(h4, .sr-item)"), 14);
      MO.play(drawerEl, "mo-items", 1600);
      if (panel.style.animation !== "none") MO.play(drawerEl, "mo-enter", 1400);
    }
  }
  // 三栏宽屏时侧栏常驻在左边：开会话之类顺手的关闭不收它，只有用户点收起 / 菜单键（force）才收
  // 收起：面板从它此刻所在的位置（点遮罩时在原位，横滑推到一半时在手指那里，弹簧还没落定时在半路）滑回屏外，
  // 遮罩的底色和毛玻璃一起褪 —— 不对整个 #drawer 做透明度：透明度叠毛玻璃在旧 WebView 上会留一层残影。
  // fling = 手指甩出去的，已经在动，就用减速曲线接着走；点出来的收起用先加速后减速，和滑入对称
  function closeDrawer(force, fling) {
    if (!force && window.CCLayout && CCLayout.docked()) return;
    if (drawerEl.classList.contains("hidden") || drawerEl._moShut) return;
    const panel = drawerEl.querySelector(".drawer-panel");
    MO.cancel(drawerEl);
    if (!MO.on() || !panel || !panel.animate) { drawerEl.classList.add("hidden"); return; }
    if (document.documentElement.classList.contains("dock-l")) {
      // 常驻栏收起：真身马上藏（接着会摘 dock-l，右边内容铺满），留一张替身照原样往外滑走，盖着内容让出来的那一条。
      // 替身挂在 body 下：#drawer 已经藏了；样式不靠 #drawer 祖先，dock-l 下的内边距 / 背景当场抄下来
      const r = panel.getBoundingClientRect(), cs = getComputedStyle(panel);
      const g = panel.cloneNode(true);
      g.classList.add("mo-ghost"); g.inert = true; g.setAttribute("aria-hidden", "true");
      Object.assign(g.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", inset: "auto",
        margin: "0", padding: cs.padding, background: cs.backgroundColor, borderInlineEnd: cs.borderInlineEnd, boxSizing: "border-box",
        overflow: "hidden", zIndex: "45", pointerEvents: "none", animation: "none", transform: "none" });
      const sc = drawerEl.querySelector("#side-scroll"), st = sc ? sc.scrollTop : 0;
      document.body.appendChild(g);
      if (st) { const gs = g.querySelector("#side-scroll"); if (gs) gs.scrollTop = st; }
      drawerEl.classList.add("hidden");
      const a = g.animate([{ transform: "none" }, { transform: `translateX(${MO.rtl() ? 100 : -100}%)` }], { duration: Math.round(260 / 1.1), easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
      a.finished.then(() => g.remove(), () => g.remove());
      return;
    }
    const w = panel.getBoundingClientRect().width || 300, side = MO.rtl() ? 1 : -1;
    const tf = getComputedStyle(panel).transform, x0 = tf && tf !== "none" ? new DOMMatrix(tf).m41 : 0;
    const dcs = getComputedStyle(drawerEl), bg = dcs.backgroundColor, bf = dcs.backdropFilter && dcs.backdropFilter !== "none" ? dcs.backdropFilter : "blur(0px)";
    MO.stopJs(panel); MO.stopJs(drawerEl);
    drawerEl.classList.remove("mo-enter", "mo-items");
    panel.style.animation = "none"; panel.style.transition = "none"; panel.style.transform = `translateX(${x0}px)`;
    Object.assign(drawerEl.style, { transition: "none", background: bg });
    drawerEl.classList.add("mo-shut");
    const left = Math.min(1, Math.abs(side * w - x0) / w);
    const dur = Math.max(90, Math.round((fling ? 200 : 260) / 1.1 * Math.sqrt(left)));
    const ease = fling ? "cubic-bezier(.2,.7,.3,1)" : "cubic-bezier(.4,0,.2,1)";
    const a = panel.animate([{ transform: `translateX(${x0}px)` }, { transform: `translateX(${side * w}px)` }], { duration: dur, easing: ease, fill: "forwards" });
    // 遮罩底色和毛玻璃一起褪（毛玻璃一开始就关掉的话，背景会「突然一清」）；不对整个 #drawer 做透明度 —— 那会连面板一起淡、旧 WebView 上留残影
    const b = drawerEl.animate([{ backgroundColor: bg, backdropFilter: bf }, { backgroundColor: "transparent", backdropFilter: "blur(0px)" }], { duration: dur, easing: "linear", fill: "forwards" });
    const clean = () => {
      drawerEl._moShut = null; drawerEl._moLeave = null; drawerEl.classList.remove("mo-shut");
      a.cancel(); b.cancel();
      panel.style.animation = panel.style.transition = panel.style.transform = "";
      drawerEl.style.transition = drawerEl.style.backdropFilter = drawerEl.style.background = "";
    };
    // 中途又打开：停下来，交出此刻的位置（openDrawer 从这里弹回去）
    drawerEl._moShut = () => {
      const t = getComputedStyle(panel).transform, x = t && t !== "none" ? new DOMMatrix(t).m41 : 0;
      clean(); return x;
    };
    drawerEl._moLeave = { cls: "mo-shut", t: 0 };   // 返回键当它已经关了
    a.finished.then(() => { if (drawerEl._moShut) { drawerEl.classList.add("hidden"); clean(); } }, () => {});
  }

  const PAGES = {
    sessions: { name: tk("对话"), icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>' },
    settings: { name: tk("设置"), icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
    projects: { name: tk("项目"), icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
    lineage: { name: tk("脉络"), icon: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 3v12.5M18 8.5a9 9 0 0 1-9.5 8"/>' },
    sched: { name: tk("定时任务"), icon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>' },
    channels: { name: tk("频道"), icon: '<path d="M4 11a8 8 0 0 1 8-8M4 17a12 12 0 0 1 12-12"/><circle cx="5" cy="19" r="2"/><circle cx="11" cy="19" r="2"/><path d="M17 19v-2a4 4 0 0 0-4-4"/>' },
    ext: { name: tk("扩展"), icon: '<path d="M10 3h4v4a2 2 0 1 0 4 0h3v4h-4a2 2 0 1 0 0 4h4v6H3V3z"/>' },
    caps: { name: tk("能力"), icon: '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12z"/>' },
    usage: { name: tk("用量"), icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
    help: { name: tk("帮助"), icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>' },
    changelog: { name: tk("更新日志"), icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>' },
  };
  const NAV_ITEMS = ["sessions", "projects", "lineage", "sched", "channels", "ext", "caps", "usage", "help", "changelog"];          // 侧栏「去哪」里能放的；设置走底部账户行
  var curPage = null;   // var：openSession 在启动早期就会调 closePage，别撞上 let 的暂时性死区
  // 轮询（下载进度、配对状态…）只在那一页开着时继续：整页关了、换页了就停
  function pageOn(name) { return name === "settings" ? setOpen : curPage === name && !$("pages").classList.contains("hidden"); }
  (function () { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p) && !localStorage.getItem("cc.navPinsV2")) { localStorage.setItem("cc.navPins", JSON.stringify([...new Set([...p.filter((k) => k !== "ext"), "projects", "sched"])])); } localStorage.setItem("cc.navPinsV2", "1"); } catch {} })();
  // 0.4.10 加了「脉络」：已有的固定项里补上它（只补一次，用户之后取消了不再加回来）
  (function () { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p) && !localStorage.getItem("cc.navPinsV3") && !p.includes("lineage")) localStorage.setItem("cc.navPins", JSON.stringify([...p, "lineage"])); localStorage.setItem("cc.navPinsV3", "1"); } catch {} })();
  // 「频道」同理：老用户的固定项里补上它，位置在「定时任务」后面
  (function () { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p) && !localStorage.getItem("cc.navPinsV4") && !p.includes("channels")) localStorage.setItem("cc.navPins", JSON.stringify([...p, "channels"])); localStorage.setItem("cc.navPinsV4", "1"); } catch {} })();
  const navPins = () => { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p)) return NAV_ITEMS.filter((k) => p.includes(k)); } catch {} return ["sessions", "projects", "lineage", "sched", "channels"]; };
  var navEdit = false;
  function renderSideNav() {
    const nav = $("side-nav"); if (!nav) return;
    const pins = navPins(), more = localStorage.getItem("cc.navMore") === "1";
    const ico = (k) => `<svg viewBox="0 0 24 24">${PAGES[k].icon}</svg>`;
    const live = srv.runs.filter((x) => !x.idle).length;
    const badge = (k) => k === "sessions" && live ? `<span class="nav-badge"><i></i>${esc(t("{n} 个在跑", { n: live }))}</span>` : "";
    const item = (k) => `<button class="nav-item${curPage === k || (!curPage && !setOpen && k === "sessions") ? " on" : ""}" data-page="${k}">${ico(k)}<span>${esc(t(PAGES[k].name))}</span>${badge(k)}</button>`;
    let h = pins.map(item).join("");
    const rest = NAV_ITEMS.filter((k) => !pins.includes(k));
    h += `<button class="nav-item nav-more${more ? " open" : ""}" data-nav="more"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg><span>${esc(t("更多"))}</span><svg viewBox="0 0 24 24" class="caret"><path d="M6 9l6 6 6-6"/></svg></button>`;
    if (more) {
      h += '<div class="nav-sub">';
      if (navEdit) h += NAV_ITEMS.map((k) => `<label class="nav-item">${ico(k)}<span>${esc(t(PAGES[k].name))}</span><input type="checkbox" data-pin="${k}"${pins.includes(k) ? " checked" : ""}></label>`).join("") + `<button class="nav-edit" data-nav="done">${esc(t("完成"))}</button>`;
      else h += rest.map(item).join("") + `<button class="nav-edit" data-nav="edit">${esc(t("自定常驻项…"))}</button>`;
      h += "</div>";
    }
    nav.innerHTML = h;
    $("side-acct")?.classList.toggle("on", !!setOpen);
  }
  $("side-nav").addEventListener("click", (e) => {
    const p = e.target.closest("[data-page]");
    if (p) { if (p.dataset.page === "projects") PJ.cur = null; if (p.dataset.page === "sched") SC.cur = null; return openPage(p.dataset.page); }
    const n = e.target.closest("[data-nav]")?.dataset.nav;
    if (n === "more") { localStorage.setItem("cc.navMore", localStorage.getItem("cc.navMore") === "1" ? "0" : "1"); navEdit = false; }
    if (n === "edit") navEdit = true;
    if (n === "done") navEdit = false;
    if (n) renderSideNav();
  });
  $("side-nav").addEventListener("change", (e) => {
    const k = e.target.dataset.pin; if (!k) return;
    const pins = navPins().filter((x) => x !== k);
    if (e.target.checked) pins.push(k);
    localStorage.setItem("cc.navPins", JSON.stringify(pins));
    renderSideNav();
  });
  $("side-new").addEventListener("click", () => { closePage(); closeDrawer(); newConversation(); });
  $("side-acct").addEventListener("click", () => acctMenu());
  // ── 头像与昵称：只存本机。没设昵称时用登录邮箱 @ 前面那段，再没有就叫 cccodroid ──
  const PROF_KEY = "cc.profile";
  const profile = () => { try { return JSON.parse(localStorage.getItem(PROF_KEY)) || {}; } catch { return {}; } };
  const profName = () => profile().name || (acctEmail ? acctEmail.split("@")[0] : "") || "cccodroid";
  function paintAv(el, p) {
    p = p || profile();
    el.style.backgroundImage = p.av ? `url("${p.av}")` : "";
    el.classList.toggle("img", !!p.av);
    el.textContent = p.av ? "" : (profName().trim()[0] || "C").toUpperCase();
  }
  function saveProfile(patch) {
    const p = Object.assign(profile(), patch);
    for (const k of Object.keys(p)) if (!p[k]) delete p[k];
    try { localStorage.setItem(PROF_KEY, JSON.stringify(p)); } catch (e) { toast(t("保存失败"), true); }
    paintAcct(state.serverStatus); paintProf();
  }
  function paintProf() {
    const b = $("prof-av"); if (!b) return;
    paintAv(b);
    const i = $("prof-name"); if (document.activeElement !== i) i.value = profile().name || "";
    i.placeholder = profName();
  }
  // 选的图片裁成正方形、缩到 160px 存成 JPEG（十几 KB），不存原图
  async function pickAvatar(file) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(bmp.width, bmp.height), cv = document.createElement("canvas");
      cv.width = cv.height = 160;
      cv.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 160, 160);
      saveProfile({ av: cv.toDataURL("image/jpeg", 0.86) });
    } catch { toast(t("读不了这张图片"), true); }
  }
  $("prof-av")?.addEventListener("click", () => $("prof-file").click());
  $("prof-file")?.addEventListener("change", (e) => { pickAvatar(e.target.files[0]); e.target.value = ""; });
  $("prof-name")?.addEventListener("change", (e) => saveProfile({ name: e.target.value.trim().slice(0, 24) }));
  $("prof-reset")?.addEventListener("click", () => { localStorage.removeItem(PROF_KEY); $("prof-name").value = ""; paintAcct(state.serverStatus); paintProf(); });
  paintProf();

  // 账户行：头像 + 昵称，下面一行只写当前接口（账户登录 / DeepSeek / Kimi …），别的都不放
  function paintAcct(s) {
    if (!s) return;
    paintAv($("acct-av"));
    $("acct-name").textContent = profName();
    $("acct-sub").textContent = provName(s);
    paintProf();
    if (s.product) $("side-title").textContent = s.product;
    // 官方账户：名字换成登录邮箱（问一次，之后十分钟内沿用）
    if (s.keyMode === "login" && Date.now() - acctEmailAt > 600000) {
      acctEmailAt = Date.now();
      api("/api/login/status").then((st) => {
        const wk = st && st.limits && st.limits.sevenDay ? Math.round(st.limits.sevenDay.used) : null;
        if (st && ((st.email && st.email !== acctEmail) || wk !== acctWeek)) { acctEmail = st.email || acctEmail; acctWeek = wk; paintAcct(s); }
      }).catch(() => {});
    }
  }
  var acctEmail = "", acctEmailAt = 0, acctWeek = null;

  // ── 弹出菜单（长按会话、账户行）：items 是 { label, icon, small, danger, fn } / "hr" / { head } ──
  function closeMenu() { OV.closeAll("menu"); }
  function popMenu(anchor, items, place, cls) {
    // 同一个按钮再点一次 = 收起（侧栏账户、项目标签、⋯ 这些都走这里）
    if (anchor && OV.at(anchor)) { closeMenu(); return null; }
    const m = document.createElement("div");
    m.className = "pop-menu" + (cls ? " " + cls : "");   // 额外的类要在量宽度之前挂上，不然定位按窄的算、加宽后出屏
    // head 带 fn 时可点（脉络弹层的「来源」行）；no：左边一列等宽小字（档号）代替图标；cur 加粗；没有 fn 的按钮是灰的
    m.innerHTML = items.map((it, i) => it === "hr" ? "<hr>" : it.head ? `<div class="pm-head${it.fn ? " pm-link" : ""}"${it.fn ? ` data-i="${i}"` : ""}>${esc(it.head)}</div>`
      : `<button data-i="${i}" class="${it.danger ? "danger" : ""}${it.cur ? " cur" : ""}${it.fn ? "" : " dim"}">${it.no ? `<i class="pm-no">${esc(it.no)}</i>` : it.icon ? `<svg viewBox="0 0 24 24">${it.icon}</svg>` : '<span class="pm-pad"></span>'}<span>${esc(it.label)}</span>${it.small ? `<small>${esc(it.small)}</small>` : ""}</button>`).join("");
    OV.open(m, { anchor });
    const ar = anchor.getBoundingClientRect(), W = innerWidth, H = innerHeight, mw = m.offsetWidth, mh = m.offsetHeight;
    let x, y;
    if (place === "up") {
      // 宽按钮（侧栏底部账户行）：菜单收在按钮里，不溢出侧栏；窄按钮（项目标签）：照常按内容宽，左对齐按钮
      if (ar.width >= 200) { m.classList.add("up"); x = ar.left + 8; m.style.width = (ar.width - 16) + "px"; } else x = ar.left;
      y = ar.top - m.offsetHeight - 6;
    }
    else { x = Math.min(ar.left + 24, W - mw - 8); y = ar.bottom + 2; if (y + mh > H - 8) y = Math.max(8, ar.top - mh - 2); }
    m.style.left = Math.max(8, Math.min(x, W - mw - 8)) + "px"; m.style.top = Math.max(8, y) + "px";
    moOrigin(m, ar);
    m.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (!b || !items[+b.dataset.i].fn) return; OV.close(m); items[+b.dataset.i].fn(); });
    return m;
  }
  /** 菜单的缩放原点放在锚点那一侧（在锚点下面就从上沿长出、在上面就从下沿），条目错开出场 */
  function moOrigin(m, ar) {
    if (!MO.on()) return;
    const r = m.getBoundingClientRect();
    const ox = Math.max(12, Math.min(r.width - 12, ar.left + ar.width / 2 - r.left));
    m.style.transformOrigin = `${ox}px ${r.top >= ar.top + ar.height / 2 ? "0" : "100%"}`;
    MO.stagger(m.querySelectorAll(":scope > button, :scope > .pm-head"), 10);
  }
  // 下拉框不用系统弹出的选择器（深色、和主题不搭），换成同一套菜单：当前项打勾，optgroup 成小标题，
  // 长列表可滚、自动滚到当前项，宽度至少和下拉框一样。选了照常触发 input / change，原有逻辑不用改。
  const CHECK = '<path d="M5 12l5 5 9-10"/>';
  // 「能看图」标记（多模态）：图片框 + 山 + 太阳，不用 emoji
  const MM_IMG = () => `<svg class="mm-img" viewBox="0 0 24 24" role="img" aria-label="${esc(t("能看图"))}"><title>${esc(t("能看图"))}</title><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8.5 8"/></svg>`;
  function selMenu(sel) {
    const items = [];
    for (const n of sel.children) {
      if (n.tagName === "OPTGROUP") {
        items.push({ head: n.label });
        for (const o of n.children) if (!o.hidden) items.push(o);
      } else if (n.tagName === "OPTION" && !n.hidden) items.push(n);
    }
    const m = document.createElement("div");
    m.className = "pop-menu sel-menu";
    m.innerHTML = items.map((it, i) => it.head != null ? `<div class="pm-head">${esc(it.head)}</div>`
      : `<button type="button" data-i="${i}" class="${it.selected ? "on" : ""}"${it.disabled ? " disabled" : ""}>`
        + (it.selected ? `<svg viewBox="0 0 24 24">${CHECK}</svg>` : '<span class="pm-pad"></span>')
        + `<span>${esc(it.textContent)}</span>${it.dataset && it.dataset.img ? MM_IMG() : ""}</button>`).join("");
    OV.open(m, { anchor: sel });     // 锚点记住是哪个下拉框开的：再点它本身就是收起
    const ar = sel.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    m.style.minWidth = Math.min(ar.width, W - 16) + "px";
    m.style.maxHeight = Math.max(160, Math.min(H * 0.6, Math.max(H - ar.bottom, ar.top) - 14)) + "px";
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let y = ar.bottom + 4;
    if (y + mh > H - 8) y = ar.top - mh - 4 >= 8 ? ar.top - mh - 4 : Math.max(8, H - mh - 8);
    const x = getComputedStyle(sel).direction === "rtl" ? ar.right - mw : ar.left;
    m.style.left = Math.max(8, Math.min(x, W - mw - 8)) + "px"; m.style.top = y + "px";
    moOrigin(m, ar);
    const on = m.querySelector("button.on"); if (on) m.scrollTop = on.offsetTop - (m.clientHeight - on.offsetHeight) / 2;
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]"); if (!b || b.disabled) return;
      OV.close(m);
      const o = items[+b.dataset.i];
      if (o.selected) return;
      sel.value = o.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  // 捕获阶段拦住：mousedown / 触摸的 pointerdown 不让系统选择器弹出，click 打开我们的菜单；回车 / 空格同样打开。
  // 带 data-native 的保留系统选择器
  const selOk = (s) => s && !s.disabled && !s.multiple && !s.dataset.native && s.size <= 1;
  const selOf = (e) => e.target.closest && e.target.closest("select");
  addEventListener("mousedown", (e) => { if (selOk(selOf(e))) e.preventDefault(); }, true);
  addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse" && selOk(selOf(e))) e.preventDefault(); }, true);
  addEventListener("click", (e) => {
    const s = selOf(e); if (!selOk(s)) return;
    e.preventDefault();
    if (OV.at(s)) { closeMenu(); return; }   // 点同一个：收起；点另一个：selMenu 打开时自动换掉旧的
    selMenu(s);
  }, true);
  addEventListener("keydown", (e) => {
    const s = selOf(e);
    if (selOk(s) && (e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown"))) { e.preventDefault(); selMenu(s); }
  }, true);
  // 所有搜索框（.searchbox）统一：有字时右侧出现清空键；系统自带的清空叉隐藏（各家 WebView 长得不一样）
  addEventListener("input", (e) => {
    const box = e.target.closest && e.target.closest(".searchbox"); if (!box || e.target.tagName !== "INPUT") return;
    if (!box.querySelector(".sb-x")) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "sb-x"; x.setAttribute("aria-label", t("清空"));
      x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
      e.target.after(x);
    }
    box.classList.toggle("has-v", !!e.target.value);
  }, true);
  addEventListener("click", (e) => {
    const x = e.target.closest && e.target.closest(".sb-x"); if (!x) return;
    e.preventDefault();
    const box = x.closest(".searchbox"), inp = box.querySelector("input");
    inp.value = ""; box.classList.remove("has-v");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.focus();
  }, true);
  const SM = {
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    export: '<path d="M12 15V3M7 8l5-5 5 5M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    chat: '<path d="M4 4h16v12H8l-4 4z"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    update: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
    lineage: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 3v12.5M18 8.5a9 9 0 0 1-9.5 8"/>',
    tray: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M5 5h14l1 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z"/>',
  };

  // 侧栏的最近对话：一行一个，分组 置顶 / 今天 / 昨天 / 更早；更早的只列前一段，全部在「对话」整页
  const RECENT_MAX = 40;
  // 收起了哪几组：用到时才读（renderSideRecent 可能在本段执行前就被调到，var 那时还是 undefined）
  var sideFold;
  function folds() { return sideFold ||= new Set((() => { try { return JSON.parse(localStorage.getItem("cc.sideFold") || "[]"); } catch { return []; } })()); }
  function renderSideRecent() {
    const box = $("side-recent"); if (!box) return;
    // 杂项不进侧栏（正开着的那个除外），在「对话」整页最后一组
    const list = (state.sessions || []).filter((x) => !x.misc || x.id === view.sessionId);
    const live = new Set(srv.runs.filter((x) => !x.idle).map((x) => x.sessionId).filter(Boolean));
    const ask = new Set(srv.runs.filter((x) => x.perms && x.perms.length).map((x) => x.sessionId).filter(Boolean));
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime(), y0 = t0 - 86400000;
    const groups = [[t("置顶"), list.filter((x) => x.pinned), "pin"], [t("今天"), [], "today"], [t("昨天"), [], "yday"], [t("更早"), [], "older"]];
    for (const x of list) if (!x.pinned) groups[x.mtime >= t0 ? 1 : x.mtime >= y0 ? 2 : 3][1].push(x);
    const more = groups[3][1].length > RECENT_MAX;
    groups[3][1] = groups[3][1].slice(0, RECENT_MAX);
    const cur = view.sessionId && list.find((x) => x.id === view.sessionId);
    if (cur && cur.title && cur.title !== view.title) view.title = cur.title;
    paintTitle();   // 顶栏状态行后面的档号 / 日期也跟着会话列表变
    const row = (x) => `<button class="sr-item${x.id === view.sessionId ? " on" : ""}" data-sid="${esc(x.id)}" title="${esc(x.title)}">${ask.has(x.id) ? '<i class="sr-dot ask"></i>' : live.has(x.id) ? '<i class="sr-dot"></i>' : ""}<span>${esc(x.title)}</span></button>`;
    box.innerHTML = list.length
      ? groups.filter(([, l]) => l.length).map(([g, l, k]) => {
          // 分组可以收起：点标题切换，收起时标出有几个；记在本机
          const shut = folds().has(k);
          return `<h4 class="sr-g${shut ? " shut" : ""}" data-fold="${k}" role="button" aria-expanded="${!shut}"><svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg><span>${esc(g)}</span>${shut ? `<em>${l.length}</em>` : ""}</h4>`
            + (shut ? "" : l.map(row).join("") + (k === "older" && more ? `<button class="sr-all" data-all>${esc(t("全部对话"))}</button>` : ""));
        }).join("")
        + `<div class="sr-hint">${esc(t("长按会话：置顶、重命名、导出、删除"))}</div>`
      : `<div class="sr-empty">${esc(t("还没有历史会话。"))}</div>`;
  }
  $("side-scroll").addEventListener("scroll", (e) => e.target.classList.toggle("scrolled", e.target.scrollTop > 2), { passive: true });
  $("side-recent").addEventListener("click", (e) => {
    if (e.target.closest("[data-all]")) return openPage("sessions");
    const g = e.target.closest("[data-fold]");
    if (g) {
      const k = g.dataset.fold;
      if (folds().has(k)) folds().delete(k); else folds().add(k);
      try { localStorage.setItem("cc.sideFold", JSON.stringify([...folds()])); } catch {}
      return renderSideRecent();
    }
    const it = e.target.closest("[data-sid]"); if (!it) return;
    closeDrawer(); openSession(it.dataset.sid);
  });
  $("side-recent").addEventListener("contextmenu", (e) => {
    const it = e.target.closest("[data-sid]"); if (!it) return;
    e.preventDefault(); sessMenu(it.dataset.sid, it);
  });
  // 单个会话的操作：置顶、重命名、导出、删除（进回收站）
  function sessMenu(id, anchor) {
    const x = (state.sessions || []).find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id); if (!x) return;
    const reload = () => loadSessions();
    popMenu(anchor, [
      { label: x.pinned ? t("取消置顶") : t("置顶"), icon: SM.pin, fn: () => post(`/api/session/${encodeURIComponent(id)}/pin`, { pin: !x.pinned }).then(reload, (e) => toast(e.message, true)) },
      { label: t("移到项目…"), icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', fn: () => moveToProject(id, anchor) },
      { label: t("重命名"), icon: SM.edit, fn: () => { const n = prompt(t("新的会话名称"), x.title || ""); if (n) post(`/api/session/${encodeURIComponent(id)}/rename`, { title: n }).then(reload, (e) => toast(e.message, true)); } },
      { label: t("脉络"), icon: SM.lineage, fn: () => lineageMenu(id, anchor) },
      { label: x.misc ? t("移出杂项") : t("归入杂项"), icon: SM.tray, fn: () => post("/api/archive/misc", { session: id, misc: !x.misc }).then(reload, (e) => toast(e.message, true)) },
      { label: t("导出"), icon: SM.export, fn: async () => {
        if (!confirm(t("会话记录可能含有你贴过的密钥、令牌或文件内容。导出的压缩包请只发给你信任的地方。继续？"))) return;
        const r = await post("/api/sessions/export", { ids: [id] }).catch((e) => ({ ok: false, message: e.message }));
        if (!r.ok) return toast(t("导出失败：{msg}", { msg: r.message || "" }), true);
        if (canSaveAs()) saveAs(r.file, "application/zip"); else toast(t("已导出 {n} 个会话：{file}", { n: r.count, file: r.file }));
      } },
      "hr",
      { label: t("删除（进回收站）"), icon: SM.trash, danger: true, fn: async () => {
        try { await api(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
        if (view.sessionId === id) newConversation();
        reload();
        toast(t("已移进回收站（{d} 天内可恢复）", { d: sess.keepDays }));
      } },
    ]);
  }
  // 脉络弹层：这个会话的来源（从哪个会话分叉 / 回退来）+ 各章（卷）。全局亲缘图在阶段 1 的脉络页
  async function lineageMenu(id, anchor) {
    let r;
    try { r = await api("/api/archive?session=" + encodeURIComponent(id)); } catch (e) { return toast(e.status === 404 ? t("这个会话还没有记录") : e.message, true); }
    const p2 = (n) => String(n).padStart(2, "0"), md = (ms) => { const d = new Date(ms); return p2(d.getMonth() + 1) + "-" + p2(d.getDate()); };
    const range = (a, b) => (md(a) === md(b) ? md(b) : md(a) + " – " + md(b));
    const open = id === view.sessionId ? null : () => { closeDrawer(); openSession(id); };
    const items = [];
    const P = r.parent;
    if (P) {
      const tt = (P.title || P.id.slice(0, 8)).slice(0, 24), d = P.ts ? md(P.ts) : "";
      const head = P.kind === "rewind" ? t("从「{t}」回退 · {d}", { t: tt, d }) : t("从「{t}」分叉 · {d}", { t: tt, d });
      items.push({ head: d ? head : head.replace(/ · $/, ""), fn: P.missing || P.trashed ? null : () => { closeDrawer(); openSession(P.id); } }, "hr");
    }
    const sid4 = id.slice(0, 4);
    // 点卷：跳到这一卷第一章的开头（和脉络页点站、卡片里点章同一个去处）；要看最新用最上面的「打开」
    if (open) items.push({ label: t("打开"), icon: SM.chat, fn: open }, "hr");
    for (const v of [...r.volumes].reverse()) {
      const a = v.chapters[0], b = v.chapters[v.chapters.length - 1], live = r.chapters[b - 1].open;
      const anchor = a === 1 ? "start" : r.chapters[a - 1].anchor;
      items.push({ no: sid4 + "·" + (a === b ? a : a + "–" + b), label: v.title || t("还没有题名"), small: live ? t("进行中") : range(v.from, v.to), cur: live, fn: () => { closeDrawer(); openSession(id, null, anchor); } });
    }
    items.push("hr", { label: t("改题名"), icon: SM.edit, fn: () => {
      const last = r.volumes[r.volumes.length - 1], n = last.chapters[last.chapters.length - 1];
      const title = prompt(t("新的题名"), last.title || "");
      if (!title) return;
      post("/api/archive", { session: id, title, chapter: n }).then(() => loadSessions(), (e) => toast((e.body && e.body.errors || [e.message]).join("；"), true));
    } }, { label: t("在脉络中查看"), icon: SM.lineage, fn: () => { closeDrawer(); openLineage(id); } });
    popMenu(anchor, items, null, "lineage");
  }
  // 账户菜单：常用的在上，不可逆的放最下
  function acctMenu() {
    const st = state.serverStatus || {};
    // 更新直达设置里的「更新」类目；有东西可下 / 可装就在右边标出来（状态是上次取的，顺手再取一次给下回用）
    const pend = (lastUpd.items || []).filter((it) => it.state === "available" || it.state === "ready").length;
    loadUpd();
    const items = [
      { label: t("设置"), icon: PAGES.settings.icon, fn: () => openPage("settings") },
      { label: t("头像与昵称"), icon: SM.edit, fn: () => openPage("settings", "me") },
      { label: t("切换接口 / 账户"), icon: SM.swap, fn: () => openPage("settings", "provider") },
      { label: t("用量"), icon: PAGES.usage.icon, fn: () => openPage("usage") },
      { label: t("更新"), icon: SM.update, small: pend ? t("有 {n} 项可更新", { n: pend }) : "", fn: () => openPage("settings", "update") },
      "hr",
      { label: t("帮助"), icon: PAGES.help.icon, fn: () => openPage("help") },
      { label: t("更新日志"), icon: PAGES.changelog.icon, fn: () => openPage("changelog") },
      { label: t("到 GitHub 反馈"), icon: SM.chat, fn: () => $("btn-issue").click() },
      { label: t("交流群 · 讨论区"), icon: SM.people, fn: () => { openPage("help"); setTimeout(() => $("help-body").querySelector(".cm-box")?.scrollIntoView({ block: "center", behavior: "smooth" }), 400); } },
    ];
    if (st.keyMode === "login") items.push("hr", { label: t("退出登录"), icon: SM.logout, danger: true, fn: async () => {
      if (!confirm(t("退出这台设备上的 Claude 账户登录？"))) return;
      const r = await post("/api/login/logout").catch((e) => ({ ok: false, output: e.message }));
      toast(r.ok ? t("已退出登录") : t("退出失败：{msg}", { msg: r.output || r.message || "" }), !r.ok);
      refreshStatus();
    } });
    popMenu($("side-acct"), items, "up");
  }

  // ══ 项目与定时任务（照稿）════════════════════════════════════════
  // 项目 = 一个工作目录 + 自己的 CLAUDE.md + 默认型号/思考强度/权限；会话按 cwd 归到项目里（网关 gw/projects.mjs）
  // 定时任务 = 到点在本机跑一次 Claude（网关 gw/sched.mjs，App 进程活着就准点；错过的下次打开按任务设置处理）
  // PJ / SC 在文件开头声明：启动早期 openSession → renderSessions 就会用到
  var pageTitleOv = "";
  var PI = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    kebab: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    skip: '<path d="M6 6l8 6-8 6zM17 6v12"/>',
    term: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a2 2 0 0 1 0-4h2a3 3 0 0 0 3-3"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  function pi(n, cls) { return `<svg class="ei${cls ? " " + cls : ""}" viewBox="0 0 24 24">${PI[n]}</svg>`; }
  const jsend = (p, body, method = "POST") => api(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  function normPath(p) { return String(p || "").replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0").replace(/\/+$/, ""); }
  function pjById(id) { return PJ.list.find((p) => p.id === id) || null; }
  /** 会话的 cwd 落在哪个项目里（取最深的那个） */
  function pjOfCwd(cwd) {
    const c = normPath(cwd); if (!c) return null;
    let best = null;
    for (const p of PJ.list) { const r = normPath(p.path); if ((c === r || c.startsWith(r + "/")) && (!best || r.length > normPath(best.path).length)) best = p; }
    return best;
  }
  function pjMark(p) { return `<span class="pj-mark"><i style="background:${esc(p.color || "var(--accent)")}"></i>${esc(p.name)}</span>`; }
  function pjOfSession(id) { const s = (state.sessions || []).find((x) => x.id === id); return s ? pjOfCwd(s.cwd) : null; }
  async function loadProjects() {
    try { const r = await api("/api/projects"); PJ.list = r.projects || []; PJ.colors = r.colors || []; PJ.ws = r.workspace || ""; PJ.loaded = true; }
    catch { return; }
    paintProjChip();
    if (curPage === "projects") renderProjects();
    if (curPage === "sessions") renderSessions();
  }
  async function loadSched() {
    try { SC.data = await api("/api/sched"); } catch { return; }
    if (curPage === "sched") renderSched();
    if (curPage === "projects" && PJ.cur) renderProjects();
    if (curPage === "sessions") renderSessions();
  }
  function schedSids() { return new Set((SC.data && SC.data.sids) || []); }

  // ── 时间与频率的说法 ──
  const p2 = (n) => String(n).padStart(2, "0");
  // 星期名跟界面语言走（Intl）：WD()[0] 是周日；dayShort(1..7) 给「每周一、三」和选日按钮用（中文去掉「周」字）
  const WD = () => [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(2024, 0, 7 + d).toLocaleDateString(I18N.lang, { weekday: "short" }));
  const dayShort = (d) => { const n = WD()[d % 7]; return /^zh/.test(I18N.lang) ? n.replace(/^(周|星期)/, "") : n; };
  function whenText(ms) {
    if (!ms) return "—";
    const d = new Date(ms), hm = p2(d.getHours()) + ":" + p2(d.getMinutes());
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const diff = Math.floor((ms - d0.getTime()) / 864e5);
    if (diff === 0) return t("今天 {t}", { t: hm });
    if (diff === 1) return t("明天 {t}", { t: hm });
    if (diff === -1) return t("昨天 {t}", { t: hm });
    return `${d.getMonth() + 1}-${d.getDate()} ${WD()[d.getDay()]} ${hm}`;
  }
  function freqText(f) {
    f = f || {};
    const tm = f.time || "09:00";
    if (f.kind === "daily") return t("每天 {t}", { t: tm });
    if (f.kind === "weekly") {
      const ds = (f.days || []).slice().sort();
      if (ds.length === 7) return t("每天 {t}", { t: tm });
      if (ds.join() === "1,2,3,4,5") return t("工作日 {t}", { t: tm });
      return t("每周{d} {t}", { d: ds.map(dayShort).join(/^(zh|ja)/.test(I18N.lang) ? "、" : ", "), t: tm });
    }
    if (f.kind === "monthly") return f.day === "last" ? t("每月最后一天 {t}", { t: tm }) : t("每月 {d} 号 {t}", { d: f.day || 1, t: tm });
    if (f.kind === "every") return t("每隔 {h} 小时（{a}–{b}）", { h: f.hours || 2, a: f.from || "00:00", b: f.to || "23:59" });
    if (f.kind === "once") return t("仅一次 · {d} {t}", { d: f.date || "", t: tm });
    if (f.kind === "cron") return "cron " + (f.cron || "");
    return "";
  }
  // 花费：网关记美元；中文界面按汇率换成人民币（标 ≈）
  const costText = (usd) => { const d = toDisp(+usd || 0, "USD", SC.data && SC.data.fx); return (d.approx ? "≈ " : "") + money(d.v, d.cur); };
  const durText = (ms) => !ms ? "—" : ms < 60000 ? t("{n} 秒", { n: Math.round(ms / 1000) }) : t("{m} 分 {s} 秒", { m: Math.floor(ms / 60000), s: p2(Math.round(ms % 60000 / 1000)) });
  const stIcon = (st) => st === "ok" ? `<span class="sc-st ok">${pi("check")}</span>` : st === "err" ? `<span class="sc-st err">${pi("x")}</span>` : `<span class="sc-st">${pi("skip")}</span>`;
  const swHtml = (on, attr) => `<input type="checkbox" class="sw" ${attr || ""}${on ? " checked" : ""}>`;
  const pageHead = (title, right, back) => `<div class="page-head">${back ? `<button class="icon-btn pj-back" data-a="back" aria-label="${esc(t("返回"))}">${pi("back")}</button>` : ""}<h2>${title}</h2>${right || ""}</div>`;
  const kebabBtn = (a) => `<button class="icon-btn pj-kebab" data-a="${a}" aria-label="${esc(t("更多"))}"><svg viewBox="0 0 24 24">${PI.kebab}</svg></button>`;
  const emptyRow = (txt) => `<div class="row pj-empty"><span class="muted">${esc(txt)}</span></div>`;
  function setOv(text) { pageTitleOv = text || ""; paintTitle(); }


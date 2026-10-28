// ─────────────────────────────────────────────────────────────────────
//  app.js —— Claude CLI 图形化入口
//  原生 JS，无依赖。把 CLI 的能力（会话 / 斜杠命令 / 工具 / 设置）搬进界面。
//
//  源码按功能拆在 web/app/ 下（01-core … 19-boot），网关下发 /app.js 时按文件名顺序原样拼成一个文件，
//  所以各段共用同一个闭包（这一段开头的 "(() => {" 到 19-boot 末尾的 "})();"）。
//  检查语法、把报错行号对回分段：node scripts/appjs.mjs [--line N]
//
//  「家具」三条线：
//    递进来  uploadFiles()  ← 点回形针 / 粘贴 / 拖放 / 文件面板
//    拿出去  /api/file       ← 消息里的本地图片自动内联、点开大图
//    看得见  openFiles()     ← 全屏文件浏览器，能预览能引用
// ─────────────────────────────────────────────────────────────────────
// 宿主 WebView 用 ?t=令牌&k=桥口令 首次加载（网关据 t 种 Cookie，k 见 theme.js）；两个都别留在地址里
if (/[?&](t|k)=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);

(() => {
  "use strict";
  // 界面文字一律过 t()（中文原文即键，见 i18n.js）；i18n.js 没加载时退化成原样返回
  const isZh = () => /^zh/.test((window.I18N && I18N.lang) || "zh");
  const I18N = window.I18N || { lang: "zh", t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s) };
  const t = I18N.t;
  const tk = (s) => s;   // 词条键：表格里先登记（扫描器认它），显示时再 t(变量)

  // 出错要看得见：脚本一挂界面就是死的，把原因写到顶栏副标题上，
  // 而不是让人对着一个不动的东西猜。
  const showErr = (msg) => {
    // 顶栏只放得下一行，截图常被截断：最近 5 条完整的存起来（cc.errLog），排障时能拿到文件和行号
    try { const l = JSON.parse(localStorage.getItem("cc.errLog") || "[]"); l.push({ at: Date.now(), msg: String(msg).slice(0, 600) }); localStorage.setItem("cc.errLog", JSON.stringify(l.slice(-5))); } catch {}
    const el = document.getElementById("sub-title");
    if (el) { el.textContent = t("界面脚本出错：{msg}", { msg }); el.className = "err"; }
  };
  window.addEventListener("error", (e) => {
    // 光秃秃的「Script error.」没有文件和行号：是从外壳 evaluateJavascript 注入的代码里冒出去的错，WebView 把细节抹了。
    // 写在顶栏上谁也看不懂，只进控制台；外壳注入的每段代码自己 try 住交给 __ccErr，页面这边的入口也用 guardHook 包着
    if (!e.filename && /^Script error\.?$/.test(e.message || "")) { console.warn("[cc] 外壳注入的脚本出错（细节被 WebView 隐去）"); return; }
    // 带上出错位置（app.js 是拼起来的一整份，行号用 scripts/appjs.mjs 对回分段）
    const at = e.filename ? `[${e.filename.split("/").pop().split("?")[0]}:${e.lineno}:${e.colno}] ` : "";   // 放前头：顶栏截断时位置还在
    showErr(at + (e.message || String(e.error)));
  });
  // 外壳（MainActivity）直接调用的入口：在页面自己的代码里接住错误，按原文报，不让它变成「Script error.」
  // 外壳注入的代码接住错误后交到这里（MainActivity.guarded / caught）：name 是哪个入口
  window.__ccErr = (name, err) => { console.error("[cc] " + name, err); showErr(name + "：" + (err && err.message || err)); };
  const guardHook = (name, fn) => function () {
    try { return fn.apply(this, arguments); }
    catch (err) { window.__ccErr(name, err); return false; }
  };
  window.addEventListener("unhandledrejection", (e) => {
    const el = document.getElementById("sub-title");
    if (el) { el.textContent = t("界面脚本出错：{msg}", { msg: e.reason?.message || String(e.reason) }); el.className = "err"; }
  });

  const $ = (id) => document.getElementById(id);
  // 复制到剪贴板：外壳的系统剪贴板优先（WebView 里 navigator.clipboard.writeText 常被拒，拒了还会变成顶栏的「界面脚本出错」），
  // 再试 Clipboard API，最后退回 execCommand。不抛错，结果是 true / false
  async function copyText(text) {
    text = String(text ?? "");
    try { if (window.CCApp && window.CCApp.copyText && window.CCApp.copyText(text)) return true; } catch {}
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch { return false; }
  }
  // ── 浮层统一管理：弹出菜单、下拉菜单、速览卡、权限菜单、型号 / 版本面板、项目弹层都登记在这里 ──
  // kind "menu"：轻浮层，同时只开一个；点外面就关（按在锚点上不算，留给锚点自己的 click 去切换）
  // kind "modal"：弹层，开它先关掉所有浮层；点外面不管（各自的遮罩自己处理）
  // 返回键 / Esc 关最上面那个；打开整页、设置、侧栏时全关；布局补发的假 resize 只重摆，innerWidth 真变才关（keep 的不关）
  // cover：开着时让原生浏览器窗格让位（它是原生视图，总盖在网页上面）
  const OV = (() => {
    let stack = [];   // { el, kind, anchor, onClose, place, keep, cover, w0 }
    let covered = false;
    const live = () => (stack = stack.filter((it) => it.el.isConnected));
    const find = (el) => stack.find((it) => it.el === el);
    function sync() {
      const c = live().some((it) => it.cover);
      if (c === covered) return;
      covered = c;
      if (window.CCLayout && CCLayout.cover) CCLayout.cover(c);
    }
    function drop(it) {
      stack = stack.filter((x) => x !== it);
      // 淡出再移走（MO 在下面定义，调用时早已就绪）；淡出途中又被打开（重新进栈）就不删
      MO.outRemove(it.el, () => !!find(it.el));
      try { it.onClose && it.onClose(); } catch (e) { console.error(e); }
    }
    function close(el) { const it = el && find(el); if (it) drop(it); else if (el) el.remove(); sync(); }
    function closeAll(kind) { for (const it of live().slice().reverse()) if (!kind || it.kind === kind) drop(it); sync(); }
    function open(el, o = {}) {
      const kind = o.kind || "menu";
      closeAll(kind === "modal" ? null : "menu");
      if (!el.isConnected) document.body.appendChild(el);
      const again = !!find(el);
      stack.push({ el, kind, anchor: o.anchor || null, onClose: o.onClose, place: o.place, keep: !!o.keep, cover: !!o.cover, w0: innerWidth });
      sync();
      if (!again) MO.enterOv(el, o.anchor);
      return el;
    }
    // 锚点上开着的菜单（同一个按钮再点 = 收起）
    const at = (anchor) => { const it = anchor && live().find((x) => x.anchor === anchor); return it ? it.el : null; };
    const top = () => { const s = live(); return s.length ? s[s.length - 1].el : null; };
    function back() { const el = top(); if (!el) return false; close(el); return true; }
    // 点外面：从上往下关菜单，碰到点中的那层就停（菜单开在弹层里时，点弹层只关菜单）
    addEventListener("pointerdown", (e) => {
      for (const it of live().slice().reverse()) {
        if (it.el.contains(e.target) || (it.anchor && it.anchor.contains && it.anchor.contains(e.target))) return;
        if (it.kind !== "menu") return;
        drop(it);
      }
      sync();
    }, true);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && top()) { e.stopPropagation(); back(); } }, true);
    addEventListener("resize", () => {
      for (const it of live().slice()) {
        if (innerWidth !== it.w0 && !it.keep) drop(it);
        else if (it.place) try { it.place(); } catch (e) { console.error(e); }
      }
      sync();
    });
    // 别处直接 remove() 掉的也要跟上（窗格让位状态别卡住）
    new MutationObserver(() => { if (stack.length) sync(); }).observe(document.body, { childList: true });
    return { open, close, closeAll, at, top, back, isOpen: (el) => !!(el && el.isConnected && find(el)) };
  })();

  // ── 动效：弹簧曲线 ────────────────────────────────────────────────
  // 只做「交代东西从哪来、去哪了」的动效，只动 transform / opacity；流式正文、对话区滚动、长列表一律不加。
  // 弹簧按物理积分出 0→1 的进度：一份写成 CSS @keyframes（多段 linear —— Chrome 104 没有 linear() 缓动也能播），
  // 一份给 Web Animations 现算帧。时间轴：对照稿「适中」档（×1.6）再提速 1.1 倍（10-26 真机看完定的）；
  // 固定时长的淡入淡出、退场、错开间隔也乘同一个系数 K（样式里是 var(--mo-x)），快慢一起变。三档：
  //   snap 面板 / 整页（过冲约 2%）· pop 小件 / 菜单（约 9%）· soft 不过冲（逐项错开、大块位移）
  // 进场弹、退场干脆（150ms 左右缓入，不弹）。设置「界面动效」：跟随系统（默认；系统开了减少动态效果就不放）/ 开 / 关
  //   → html[data-motion=on|off]；样式里的动效都挂在 html[data-motion="on"] 下面
  const MO = (() => {
    // BOUNCE：回弹力度（冲过头的那一截乘它，节奏和时长不变）；10-27 用户定 0.4（试过 0.85、0.6）
    const SPR = { snap: [420, 30], pop: [520, 26], soft: [320, 36] }, SPEED = 1.1, BOUNCE = 0.4, TEMPO = 1.6 / SPEED, K = 1 / SPEED, OUT = "cubic-bezier(.4,0,1,1)";
    const k = (ms) => Math.round(ms * K);
    const root = document.documentElement, cache = {};
    const reduce = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    const pref = () => { try { return localStorage.getItem("cc.motion") || "auto"; } catch { return "auto"; } };
    const on = () => root.dataset.motion === "on";
    const rtl = () => root.dir === "rtl";
    function curve(name) {
      if (cache[name]) return cache[name];
      const [k, c] = SPR[name], dt = 1 / 240, pts = [0];
      let x = 0, v = 0, t = 0, next = 1 / 60, still = 0;
      while (t < 2) {
        v += (k * (1 - x) - c * v) * dt; x += v * dt; t += dt;
        if (t >= next) { pts.push(x); next += 1 / 60; }
        still = Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02 ? still + 1 : 0;
        if (still > 8) break;
      }
      pts.push(1);
      for (let i = 0; i < pts.length; i++) if (pts[i] > 1) pts[i] = 1 + (pts[i] - 1) * BOUNCE;
      return (cache[name] = { pts, ms: Math.round((pts.length - 1) * 1000 / 60 * TEMPO) });
    }
    const ms = (name) => curve(name).ms;
    // 关键帧（写进 <style id="mo-kf">）：名字 → [弹簧档, 每一帧的声明]
    const lin = (a, b, p) => +(a + (b - a) * p).toFixed(3);
    const KF = {
      "mo-drawer": ["snap", (p) => `transform:translateX(${lin(-100, 0, p)}%)`],
      "mo-drawer-r": ["snap", (p) => `transform:translateX(${lin(100, 0, p)}%)`],
      "mo-page": ["snap", (p) => `transform:translateX(${lin(100, 0, p)}%)`],
      "mo-page-r": ["snap", (p) => `transform:translateX(${lin(-100, 0, p)}%)`],
      "mo-pop": ["pop", (p) => `opacity:${Math.min(1, lin(0, 2, p))};transform:scale(${lin(.86, 1, p)})`],
      "mo-rise": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.4, p))};transform:translateY(${lin(10, 0, p)}px)`],
      "mo-item": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.4, p))};transform:translateX(${lin(-12, 0, p)}px)`],
      "mo-item-r": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.4, p))};transform:translateX(${lin(12, 0, p)}px)`],
      "mo-drop": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.5, p))};transform:translateY(${lin(-5, 0, p)}px)`],
      "mo-card": ["snap", (p) => `opacity:${Math.min(1, lin(0, 2, p))};transform:translateY(${lin(24, 0, p)}px)`],
      "mo-tick": ["pop", (p) => `transform:scale(${lin(.6, 1, p)})`],
      "mo-bump": ["pop", (p) => `transform:scale(${lin(1.1, 1, p)})`],
      "mo-phase": ["pop", (p) => `opacity:${Math.min(1, lin(0, 1.6, p))};transform:translateY(${lin(8, 0, p)}px)`],
      "mo-back": ["snap", (p) => `opacity:${lin(.6, 1, p)};transform:translateX(${lin(-6, 0, p)}%)`],
      "mo-back-r": ["snap", (p) => `opacity:${lin(.6, 1, p)};transform:translateX(${lin(6, 0, p)}%)`],
      "mo-sheet": ["snap", (p) => `transform:translateY(${lin(100, 0, p)}%)`],
      "mo-pane": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.4, p))};transform:translateX(${lin(28, 0, p)}px)`],
      "mo-pane-r": ["soft", (p) => `opacity:${Math.min(1, lin(0, 1.4, p))};transform:translateX(${lin(-28, 0, p)}px)`],
      "mo-toast": ["pop", (p) => `opacity:${Math.min(1, lin(0, 2, p))};transform:translate(-50%,${lin(14, 0, p)}px) scale(${lin(.94, 1, p)})`],
      "mo-zoom": ["pop", (p) => `opacity:${Math.min(1, lin(0, 2, p))};transform:scale(${lin(.92, 1, p)})`],
    };
    function inject() {
      let css = ":root{" + ["snap", "pop", "soft"].map((n) => `--mo-${n}:${ms(n)}ms`).join(";") + `;--mo-x:${K.toFixed(4)}}`;
      for (const [name, [pre, fn]] of Object.entries(KF)) {
        const { pts } = curve(pre), n = pts.length - 1;
        css += `@keyframes ${name}{` + pts.map((p, i) => `${(i / n * 100).toFixed(2)}%{${fn(p)}}`).join("") + "}";
      }
      const st = document.createElement("style"); st.id = "mo-kf"; st.textContent = css;
      document.head.appendChild(st);
    }
    function apply() {
      const p = pref(), v = p === "on" || (p === "auto" && !reduce.matches) ? "on" : "off";
      if (root.dataset.motion !== v) root.dataset.motion = v;
      document.querySelectorAll("#seg-motion [data-mo]").forEach((b) => b.classList.toggle("on", b.dataset.mo === p));
    }
    function set(v) { try { localStorage.setItem("cc.motion", v); } catch {} apply(); }
    /** 现算帧播一次弹簧（给不挂 CSS 类的零散小件）：fn(p) → 样式对象；播完清掉，样式回到原样 */
    function spring(el, name, fn, delay = 0) {
      if (!on() || !el || !el.animate) return null;
      const { pts } = curve(name);
      const a = el.animate(pts.map(fn), { duration: ms(name), delay, easing: "linear", fill: "backwards" });
      a.finished.then(() => a.cancel(), () => {});
      return a;
    }
    /** 播一个 CSS 关键帧：时长按档位；用 Web Animations 的话会和元素自己的 CSS 动画打架，这里走 class 切换 */
    function play(el, cls, ttl) {
      if (!on() || !el) return;
      el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
      clearTimeout(el["_mo_" + cls]);
      // 摘类名时元素自己原本的动画（比如 .msg 的淡入）会被浏览器当成新动画重播一遍 —— 看着就是「又渲染了一次」。
      // 摘掉后把刚起头的那几个直接拨到结尾
      el["_mo_" + cls] = setTimeout(() => {
        el.classList.remove(cls);
        if (el.getAnimations && window.CSSAnimation)
          for (const a of el.getAnimations()) if (a instanceof CSSAnimation && a.effect && a.effect.target === el && (a.currentTime || 0) < 50) a.finish();
      }, ttl || 1200);
    }
    /** 退场：给 el 挂 cls（样式里是干脆的缓入），ms 后执行 done；期间又打开了就 cancel 掉 */
    function leave(el, cls, dur, done) {
      cancel(el); stopJs(el);
      if (!on()) return done();
      el.classList.add(cls);
      el._moLeave = { cls, t: setTimeout(() => { el._moLeave = null; el.classList.remove(cls); done(); }, k(dur)) };
    }
    /** 停掉元素上还在播的脚本动画（弹簧尾巴约 0.6 秒，期间它压着 transform —— 不停掉的话，
     *  紧接着的退场 / 手指拖动都看不出效果，松手才「啪」地跳过去）。CSS 动画不动，由类名管 */
    function stopJs(el) {
      if (!el || !el.getAnimations) return;
      for (const a of el.getAnimations()) if (!(window.CSSAnimation && a instanceof CSSAnimation) && !(window.CSSTransition && a instanceof CSSTransition)) a.cancel();
    }
    /** 回程：内容马上要被换掉 / 藏掉时，留一张它的替身播退场（push 往右滑走、back 往左退一点变暗、fade 淡掉、drop 往下沉）。
     *  替身插在原元素旁边（above = 盖在新内容上面，否则垫在下面），吃得到同样的样式；播完删掉 */
    function ghost(el, kind, above = true) {
      if (!on() || !el || !el.isConnected || !el.animate) return;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const g = el.cloneNode(true);
      g.querySelectorAll("canvas, video, iframe").forEach((x) => x.remove());
      g.classList.remove("hidden", "mo-in-push", "mo-in-back", "mo-in-rise", "mo-in-pane", "mo-in-pane-back");
      // id 照留（按 id 写的样式才吃得到）：替身插在真身后面，getElementById / querySelector 拿到的总是真身
      g.classList.add("mo-ghost");   // 按类名批量切 hidden 的地方要跳过它（:not(.mo-ghost)）
      g.setAttribute("aria-hidden", "true"); g.inert = true;
      Object.assign(g.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px",
        margin: "0", pointerEvents: "none", zIndex: above ? "5" : "0", animation: "none", overflow: "hidden", boxSizing: "border-box" });
      const st = el.scrollTop; el.after(g); if (st) g.scrollTop = st;
      // 祖先带 transform 时 fixed 是相对它定位的：量一下偏了多少，拨回来
      const q = g.getBoundingClientRect();
      if (Math.abs(q.left - r.left) > .5 || Math.abs(q.top - r.top) > .5) { g.style.left = 2 * r.left - q.left + "px"; g.style.top = 2 * r.top - q.top + "px"; }
      // 原来是被滚动容器裁着的（整页里的长列表）：替身也只露容器里那一块，别盖到标题栏上
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (!/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) continue;
        const c = p.getBoundingClientRect();
        const t = Math.max(0, c.top - r.top), b = Math.max(0, r.bottom - c.bottom);
        if (t || b) g.style.clipPath = `inset(${t}px 0 ${b}px 0)`;
        break;
      }
      if (!above) el.style.zIndex = el.style.zIndex || "1";
      const s = rtl() ? -1 : 1;
      const fr = { push: [{ transform: "none" }, { transform: `translateX(${100 * s}%)` }],
        back: [{ transform: "none", opacity: 1 }, { transform: `translateX(${-18 * s}%)`, opacity: .4 }],
        fade: [{ opacity: 1 }, { opacity: 0 }],
        drop: [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(16px)" }] }[kind];
      const dur = kind === "back" ? ms("snap") * .5 : k(170);
      const a = g.animate(fr, { duration: dur, easing: kind === "back" ? "cubic-bezier(.2,.8,.2,1)" : OUT, fill: "forwards" });
      const fin = () => { g.remove(); if (!above && el.style.zIndex === "1") el.style.zIndex = ""; };
      a.finished.then(fin, fin);
    }
    function cancel(el) { const l = el && el._moLeave; if (!l) return; clearTimeout(l.t); el.classList.remove(l.cls); el._moLeave = null; }
    /** 浮层收起：先淡出（小浮层再缩一点），再移走；还在 OV 栈里的说明又被打开了，不删 */
    function outRemove(el, still) {
      if (!on() || !el.animate || !el.isConnected) return el.remove();
      el.style.pointerEvents = "none";
      const big = el._moFull;
      const a = el.animate(big ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }], { duration: k(big ? 150 : 120), easing: OUT, fill: "forwards" });
      const fin = () => { a.cancel(); el.style.pointerEvents = ""; if (!still()) el.remove(); };
      a.finished.then(fin, fin);
    }
    /** OV 登记的浮层统一入场：铺满屏的（带遮罩的弹层）遮罩淡入、里面的卡片浮上来；
     *  贴着锚点的小浮层（速览卡、型号面板、权限菜单）从锚点那一侧弹出来。.pop-menu 由样式自己管。
     *  放在微任务里量：调用方 OV.open 之后才摆位置，绘制之前还来得及 */
    function enterOv(el, anchor) {
      if (!on() || !el.animate || el.classList.contains("pop-menu")) return;
      const hold = el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1000, fill: "both" });   // 量好之前先别露出来
      Promise.resolve().then(() => {
        hold.cancel();
        if (!el.isConnected) return;
        const r = el.getBoundingClientRect();
        const full = el._moFull = r.width >= innerWidth - 2 && r.height >= innerHeight - 2;
        if (full) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: k(180), easing: "ease-out" });
          const card = [...el.children].find((c) => { const q = c.getBoundingClientRect(); return q.width && q.height && (q.width < innerWidth - 2 || q.height < innerHeight - 2); });
          const ar = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
          const q = card && card.getBoundingClientRect();
          if (q && q.width >= innerWidth - 2 && q.bottom >= innerHeight - 2) {
            // 窄屏贴底铺满宽度的面板（型号面板在手机上）：像底部菜单一样从下面弹上来
            spring(card, "snap", (p) => ({ transform: `translateY(${lin(100, 0, p)}%)` }));
          }
          else if (card && ar && ar.width) {
            // 透明铺满、贴着按钮出现的面板（型号面板在宽屏）：卡片从按钮那一侧弹出来
            card.style.transformOrigin = `${Math.max(12, Math.min(q.width - 12, ar.left + ar.width / 2 - q.left))}px ${q.top >= ar.top + ar.height / 2 ? "0" : "100%"}`;
            spring(card, "pop", (p) => ({ opacity: Math.min(1, p * 2), transform: `scale(${lin(.9, 1, p)})` }));
          }
          else if (card) spring(card, "soft", (p) => ({ opacity: Math.min(1, p * 1.4), transform: `translateY(${lin(14, 0, p)}px) scale(${lin(.97, 1, p)})` }));
          else spring(el, "snap", (p) => ({ transform: `translateX(${lin(rtl() ? -100 : 100, 0, p)}%)` }));   // 窄屏铺满的弹层：像整页一样推进来
          return;
        }
        const ar = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        el.style.transformOrigin = ar ? `${Math.max(12, Math.min(r.width - 12, ar.left + ar.width / 2 - r.left))}px ${r.top >= ar.top + ar.height / 2 ? "0" : "100%"}` : "50% 50%";
        spring(el, "pop", (p) => ({ opacity: Math.min(1, p * 2), transform: `scale(${lin(.9, 1, p)})` }));
      });
    }
    /** 面板收起：挂退场类，dur 后真正藏起来（加 hidden）；then 在藏起来之后做（清内容之类）。中途又打开要先 cancel */
    function hide(el, cls, dur = 170, then) {
      if (!el || el.classList.contains("hidden")) { if (then) then(); return; }
      leave(el, cls, dur, () => { el.classList.add("hidden"); if (then) then(); });
    }
    /** 窗格（文件 / 查看器 / git / 终端）的退场类：宽屏停靠在右边就淡出，窄屏铺满就往右滑出去 */
    const paneOut = () => (root.classList.contains("has-right") ? "mo-out-fade" : "mo-out-push");
    /** 一组元素逐项错开：前 max 个挂 .mo-st 并设 --i（样式里 animation-delay 按它算）；之后重新渲染出来的没有这个类，不会再播 */
    function stagger(els, max = 12) { let i = 0; for (const el of els) { if (i >= max) break; el.classList.add("mo-st"); el.style.setProperty("--i", i++); } }

    inject(); apply();
    if (reduce.addEventListener) reduce.addEventListener("change", apply);
    document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("#seg-motion [data-mo]"); if (b) set(b.dataset.mo); });
    document.addEventListener("DOMContentLoaded", apply);
    return { paneOut, stopJs, ghost, on, ms, rtl, spring, play, leave, cancel, hide, outRemove, enterOv, stagger, apply, set };
  })();
  // 项目 / 定时任务的状态（模块在 openPage 前；这两个要在启动早期就可用）
  var PJ = { list: [], colors: [], ws: "", cur: null, detail: null, loaded: false, effLevels: [] };
  var SC = { data: null, cur: null, detail: null, flt: "all", rflt: "all" };
  const chatEl = $("chat"), inputEl = $("input"), sendEl = $("btn-send");
  const interjectEl = $("btn-interject");
  const subEl = $("sub-title"), statEl = $("stat-chip"), modelEl = $("model-chip");
  const permEl = $("perm-chip"), drawerEl = $("drawer"), toastEl = $("toast");
  const popupEl = $("popup"), popupList = $("popup-list"), popupHead = $("popup-head");
  const ctxBar = $("ctxbar"), ctxFill = $("ctxfill"), ctxTxt = $("ctxtxt");
  const fileInput = $("file-input"), filesEl = $("files"), lightboxEl = $("lightbox");

  /// 待发队列条：忙碌时排队的消息显示在这里（在附件条上方，composer 内）
  // 待发队列照 Claude Desktop 的样子：排队的消息直接出现在对话末尾（标「排队中」），
  // 底下有「立即发送」—— 递进正在跑的这一轮；停止键只管停止，挂起的不会自动发
  const queueStrip = document.createElement("div");
  queueStrip.id = "queued";
  queueStrip.className = "hidden";

  const state = {
    model: "—",
    permissionMode: "",
    caps: null,
    sessions: [],
    serverStatus: null,
    settings: {},
    providers: [],
    ctxUsed: 0,
    ctxTotal: 0,        // 真实值从 /api/models 拿，不写死
    compactAt: 0,       // 自动压缩窗口；设了就把它当上下文条的满刻度
    popup: { mode: null, items: [], sel: 0, range: null },
    lastUserText: "",
    fileDir: null,
    // 文件浏览器
    fs: { path: null, entries: [], sel: null, roots: [], q: "", hidden: false, parent: null },
    attachments: [],
  };

  // ── 基础工具 ──────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer = null;
  function toast(msg, isErr) {
    MO.cancel(toastEl);
    toastEl.textContent = msg;
    toastEl.className = isErr ? "err" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => MO.hide(toastEl, "mo-out-fade", 150), isErr ? 4200 : 3200);
  }
  // 带一个按钮的提示条（撤销之类），多停几秒
  function toastAct(msg, label, fn) {
    MO.cancel(toastEl);
    toastEl.textContent = msg + " ";
    const b = document.createElement("button");
    b.className = "toast-act"; b.textContent = label;
    b.onclick = () => { MO.hide(toastEl, "mo-out-fade", 150); fn(); };
    toastEl.appendChild(b);
    toastEl.className = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => MO.hide(toastEl, "mo-out-fade", 150), 7000);
  }
  // ── 保存到（A4）：外壳有 CCApp.saveAs 时，下载 / 导出一律走系统「保存到」面板 ──
  //  不要存储权限，也不会把文件落进用户打不开的私有目录。结果由外壳回调 __ccSaved
  const canSaveAs = () => !!(window.CCApp && window.CCApp.saveAs);
  const canShare = () => !!(state.serverStatus && state.serverStatus.product === "cccodroid");
  function saveAs(path, mime) { window.CCApp.saveAs(path, path.split("/").pop(), mime || ""); }
  window.__ccSaved = guardHook("__ccSaved", (ok, msg) => {
    if (ok) return toast(t("已保存：{name}", { name: msg }));
    if (msg === "cancel") return;
    toast(t("保存失败：{msg}", { msg: msg === "missing" ? t("文件不存在") : msg === "nopicker" ? t("系统里没有可用的文件面板") : msg }), true);
  });
  // 页面里所有指向 /api/file 的下载链接（文件浏览器的 ⤓、查看器的「下载」）：WebView 自己不会处理下载
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[download]");
    if (!a || !canSaveAs()) return;
    const u = new URL(a.href, location.href);
    const p = u.pathname === "/api/file" && u.searchParams.get("path");
    if (!p) return;
    e.preventDefault();
    saveAs(p);
  }, true);

  // 查看器 / 图片灯箱里的「分享」：文件本来就在本机，再存一份没意义，交给系统分享面板发到别的应用。
  // 不在 cccodroid 里（开发端、浏览器）时退回下载
  async function shareFile(p) {
    if (!canShare()) { location.href = fileUrl(p, true); return; }
    try {
      const j = await post("/api/app/share_file", { path: p });
      if (!j.ok) toast(j.message || t("分享失败"), true);
    } catch (e) { toast(t("分享失败") + "：" + e.message, true); }
  }
  const shareIco = () => `<svg class="ico-share" viewBox="0 0 24 24">${ICONS.share}</svg>`;

  function setStatus(text, cls) { chatStatus = [text, cls || ""]; if (!curPage) { subEl.textContent = text + (cls === "ok" ? archSub() : ""); subEl.className = cls || ""; } }

  // ── 跨刷新要记住的东西 ────────────────────────────────────────────
  //  界面代码一变网关就会让前端自动 reload（uiTag 机制）。要是会话号只存在内存里，
  //  一刷新就悄悄开新会话了 —— 上下文全丢，而且毫无提示。必须落盘。
  const LS_SID = "ccapp.sessionId", LS_CTX = "ccapp.ctxUsed";
  function saveUiState() {
    try {
      // 有会话号就记；没有就删掉，让它回到「未定」——
      // 这样下次开机还能问网关要"最近跑过的那条"，而不是默默开新会话。
      if (view.sessionId) localStorage.setItem(LS_SID, view.sessionId);
      else localStorage.removeItem(LS_SID);
      localStorage.setItem(LS_CTX, String(state.ctxUsed || 0));
    } catch {}
  }
  function loadUiState() {
    try {
      state.ctxUsed = Number(localStorage.getItem(LS_CTX)) || 0;
      return localStorage.getItem(LS_SID) || null;
    } catch { return null; }
  }
  // 自动跟到底：用户一往上滑就停，回到底部附近再恢复。
  // 以前只看"离底部 <160px"，生成中每来一条事件就把正在惯性滑动的画面拽回去，表现为"滑不动、只能一点点拖"
  // 生成中往上翻会抖（#34）：跟底判断原本攒到 rAF 里做，而吐字每帧都 scrollDown，手指刚往上拖的那一帧还按「贴底」拽回去。
  // 现在：手指按着就不跟；scroll 事件里当场比 scrollTop（不读排版），比我们上次滚到的位置靠上 = 用户往上翻了，立刻停跟
  // 只认手指（按着或刚松手的惯性里）：内容变矮时浏览器会把 scrollTop 夹小，那不是用户往上翻
  let stick = true, progTop = -1, touching = false, touchEndAt = 0;
  // 网关整轮重放（切会话 / 重连续不上）期间为真，到 sync 为止：那些是已经说过的话，正文直接整段显示，不再匀速吐一遍（#36）
  let busReplay = false;
  // 这次打开应用后进过的会话：再切回来不重播入场动画
  const seenSessions = new Set();
  chatEl.addEventListener("touchstart", () => { touching = true; }, { passive: true });
  const touchOff = () => { touching = false; touchEndAt = Date.now(); };
  chatEl.addEventListener("touchend", touchOff, { passive: true });
  chatEl.addEventListener("touchcancel", touchOff, { passive: true });
  chatEl.addEventListener("wheel", (e) => { if (e.deltaY < 0) stick = false; }, { passive: true });
  // 对话区只挂一个 scroll 监听，事件里不读排版，攒到下一帧统一处理：跟底判断、翻到顶加载更早的、↓ 圆钮
  const chatScrollHooks = [];
  let chatScrollRaf = 0;
  chatEl.addEventListener("scroll", () => {
    const byHand = touching || Date.now() - touchEndAt < 2000;
    if (byHand && progTop >= 0 && chatEl.scrollTop < progTop - 1) stick = false;
    if (chatScrollRaf) return;
    chatScrollRaf = requestAnimationFrame(() => {
      chatScrollRaf = 0;
      // 不是我们自己滚的；手指操作期间要真到底（4px）才恢复跟随，否则往上拖的前 40px 会被判回「贴底」又拽下去
      if (chatEl.scrollTop !== progTop) stick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < (byHand ? 4 : 40);
      for (const f of chatScrollHooks) f();
    });
  }, { passive: true });
  function scrollDown(force) {
    if (force) stick = true;
    else if (!stick || touching) return;
    chatEl.scrollTop = chatEl.scrollHeight;
    progTop = chatEl.scrollTop;
  }
  function relTime(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return t("刚刚");
    if (d < 3600000) return t("{n} 分钟前", { n: Math.floor(d / 60000) });
    if (d < 86400000) return t("{n} 小时前", { n: Math.floor(d / 3600000) });
    if (d < 2592000000) return t("{n} 天前", { n: Math.floor(d / 86400000) });
    return new Date(ms).toLocaleDateString();
  }
  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  async function api(path, opts) {
    // X-CC-Lang：网关据此选提示语的语言（网关侧本地化见 claude-apk/i18n/HANDOFF.md）
    opts = Object.assign({}, opts);
    opts.headers = Object.assign({ "X-CC-Lang": I18N.lang }, opts.headers);
    const r = await fetch(path, opts);
    if (!r.ok) {
      // 服务端带出来的 message 比光秃秃的 "HTTP 409" 有用得多
      // （比如切厂商时那句"这一轮还在生成中，等它跑完再切"）
      let msg = "HTTP " + r.status;
      let j = null;
      try { j = await r.json(); msg = j.message || j.error || msg; } catch {}
      const e = new Error(msg); e.status = r.status; e.body = j; throw e;
    }
    return r.json();
  }
  const fileUrl = (p, dl) =>
    "/api/file?path=" + encodeURIComponent(p) + (dl ? "&download=1" : "");

  // ── Markdown 渲染 ─────────────────────────────────────────────────
  // 本机绝对路径：回复里出现就变成可点的链接，点了在应用内查看器打开（目录则开文件面板）。
  // 只认这几个根，免得把 "/api/file" 这类接口名、"1/2" 这类分数当成路径。可带 ":行号" 尾巴（file.js:12）。
  const PATH_RE = /(^|[\s(（:：,，、;'"`“])((?:\/storage|\/sdcard|\/data|\/mnt)(?:\/[\w.\-+@%~=\u4e00-\u9fff]+)+\/?)(:\d+(?::\d+)?)?/g;
  const pathLink = (p, line, label) =>
    `<a class="fpath" data-path="${p}" href="#" title="${t("在查看器中打开")}">${label || p + (line || "")}</a>`;
  // 行内公式：$…$、\(…\)、行内的 $$…$$。先于转义从原文里抠出来（换成 \u0001N\u0001），代码片段里的不认。
  // $ 的规矩照 pandoc：开头 $ 后面不能是空格；收尾 $ 前面不能是空格、后面不能紧跟数字或字母，
  // 中间不许再有 $。这样 $5 到 $10、$PATH:$HOME、$HOME 这类都不会被当成公式。
  function holdMath(s, keep) {
    const put = (tex, raw) => "\u0001" + (keep.push(`<span class="math" data-tex="${esc(tex)}">${esc(raw)}</span>`) - 1) + "\u0001";
    return s.split(/(`[^`\n]+`)/).map((seg, i) => {
      if (i % 2) return seg;
      seg = seg.replace(/\$\$([^$\n]+?)\$\$/g, (raw, tex) => put(tex, raw))
        .replace(/\\\((.+?)\\\)/g, (raw, tex) => put(tex, raw));
      let out = "", i0 = 0;
      for (let a = seg.indexOf("$"); a >= 0; ) {
        const b = seg.indexOf("$", a + 1);
        if (b < 0) break;
        const okA = seg[a - 1] !== "\\" && !/\s/.test(seg[a + 1] || " ");
        const okB = !/\s/.test(seg[b - 1]) && !/[\w$]/.test(seg[b + 1] || "");
        if (okA && okB && b > a + 1) {
          out += seg.slice(i0, a) + put(seg.slice(a + 1, b), seg.slice(a, b + 1));
          i0 = b + 1; a = seg.indexOf("$", i0);
        } else a = b;                                   // 这个 $ 不成对，从下一个 $ 重新当开头
      }
      return (out + seg.slice(i0)).replace(/\\\$/g, "$");   // \$ 是转义，显示成 $
    }).join("");
  }
  function inlineMd(s) {
    const maths = [];
    s = holdMath(s, maths);
    // 代码片段先换成占位符（片段里整段是路径的照样能点），再统一处理链接、加粗：
    // 这样 **`代码`** 这种跨着片段的加粗也能配上对，片段里的 * 也不会被当成强调
    const keep = [];
    const hold = (h) => "\u0000" + (keep.push(h) - 1) + "\u0000";
    return esc(s)
      // 图片：只有调用方给了解析函数（查看器预览按文件所在目录解析相对路径）才渲染；聊天里不认
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, u) =>
        mdImg ? hold(`<img class="md-img" src="${esc(mdImg(u.replace(/&amp;/g, "&")))}" alt="${alt}" loading="lazy">`) : all)
      .replace(/`([^`\n]+)`/g, (_, c) => {
        const m = c.match(/^((?:\/storage|\/sdcard|\/data|\/mnt)(?:\/[^\s:]+)+\/?)(:\d+(?::\d+)?)?$/);
        return hold(m ? `<code>${pathLink(m[1], m[2], c)}</code>` : `<code>${c}</code>`);
      })
      .replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_, l, p) => hold(pathLink(p.replace(/:\d+(?::\d+)?$/, ""), "", l)))
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, l, u) => hold(`<a class="weblink" href="${u}" target="_blank" rel="noopener">${l}</a>`))
      // 裸网址也能点（本机开发服务 http://127.0.0.1:端口 最常见）；句末标点不算
      .replace(/https?:\/\/[^\s<>"'`）)】」，。；、\u0000]+/g, (u) => {
        // 结尾的 * 也不算：**http://…** 这种加粗包着的网址，不然 ** 会进链接、点开 404
        const tail = (u.match(/[.,;:!?*]+$/) || [""])[0];
        const h = u.slice(0, u.length - tail.length);
        return hold(`<a class="weblink" href="${h}" target="_blank" rel="noopener">${h}</a>`) + tail;
      })
      .replace(PATH_RE, (_, pre, p, line) => {
        const tail = line ? "" : (p.match(/[.]+$/) || [""])[0];     // 句末的点不算路径
        return pre + hold(pathLink(p.slice(0, p.length - tail.length), line)) + tail;
      })
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n])
      .replace(/\u0001(\d+)\u0001/g, (_, n) => maths[n]);
  }

  /** 支持标题/列表/表格/代码块/引用/分隔线；img(url) → 图片地址，给了才渲染 ![](…) */
  let mdImg = null;
  function renderMd(text, img) {
    const prev = mdImg; mdImg = img || null;
    try { return renderMdLines(text); } finally { mdImg = prev; }
  }
  // 代码块：```后面写了语言就在顶上标出来，并留 data-lang 给 enhanceMd 上高亮。没写完的块（流式中）也同样排版，免得收尾时跳一下
  const codeBlock = (lang, buf) =>
    `<div class="code-wrap${lang ? " has-lang" : ""}">${lang ? `<div class="code-lang">${esc(lang)}</div>` : ""}`
    + `<pre><code${lang ? ` data-lang="${esc(lang.toLowerCase())}"` : ""}>${esc(buf.join("\n"))}</code></pre><button class="copy-btn">${t("复制")}</button></div>`;
  const mathBlock = (tex, raw) => `<div class="math math-d" data-tex="${esc(tex)}">${esc(raw)}</div>`;
  function renderMdLines(text) {
    const lines = String(text).split("\n");
    let out = "", inCode = false, codeBuf = [], codeLang = "", listType = null, inTable = false, tblRows = [];
    let inMath = false, mathBuf = [];

    const closeList = () => { if (listType) { out += `</${listType}>`; listType = null; } };
    const flushTable = () => {
      if (!inTable) return;
      inTable = false;
      if (!tblRows.length) return;
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let html = '<div class="tbl-wrap"><table>';
      tblRows.forEach((row, i) => {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(row) && i === 1) return;   // 分隔行
        const tag = i === 0 ? "th" : "td";
        html += "<tr>" + cells(row).map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("") + "</tr>";
      });
      out += html + "</table></div>";
      tblRows = [];
    };

    for (const raw of lines) {
      const fence = raw.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence && !inMath) {
        if (inCode) {
          out += codeBlock(codeLang, codeBuf);
          codeBuf = []; inCode = false;
        } else { closeList(); flushTable(); inCode = true; codeLang = fence[1]; }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      // 公式块：独占一行的 $$…$$ / \[…\]，或者 $$ / \[ 开头、$$ / \] 收尾的多行
      if (inMath) {
        if (/^\s*(\$\$|\\\])\s*$/.test(raw)) { out += mathBlock(mathBuf.join("\n"), "$$" + mathBuf.join("\n") + "$$"); mathBuf = []; inMath = false; }
        else mathBuf.push(raw);
        continue;
      }
      const m1 = raw.match(/^\s*\$\$(.+?)\$\$\s*$/) || raw.match(/^\s*\\\[(.+?)\\\]\s*$/);
      if (m1) { closeList(); flushTable(); out += mathBlock(m1[1], raw.trim()); continue; }
      if (/^\s*(\$\$|\\\[)\s*$/.test(raw)) { closeList(); flushTable(); inMath = true; continue; }

      if (/^\s*\|.*\|\s*$/.test(raw)) { closeList(); inTable = true; tblRows.push(raw.trim()); continue; }
      flushTable();

      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lv = Math.min(h[1].length + 1, 4); out += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; continue; }

      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(raw)) { closeList(); out += "<hr>"; continue; }

      const bq = raw.match(/^>\s?(.*)$/);
      if (bq) { closeList(); out += `<blockquote>${inlineMd(bq[1])}</blockquote>`; continue; }

      const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
        const task = ul[1].match(/^\[([ xX])\]\s+(.*)$/);      // 任务清单 - [ ] / - [x]
        out += task
          ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}>${inlineMd(task[2])}</li>`
          : `<li>${inlineMd(ul[1])}</li>`;
        continue;
      }
      const ol = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ol) {
        // 带上起始编号：增量渲染会把一个列表切成几段，不带的话每段都从 1 数起
        if (listType !== "ol") { closeList(); out += Number(ol[1]) > 1 ? `<ol start="${Number(ol[1])}">` : "<ol>"; listType = "ol"; }
        out += `<li>${inlineMd(ol[2])}</li>`; continue;
      }

      if (!raw.trim()) { closeList(); continue; }
      closeList();
      out += `<p>${inlineMd(raw)}</p>`;
    }
    if (inCode && codeBuf.length) out += codeBlock(codeLang, codeBuf);
    if (inMath && mathBuf.length) out += `<p>${esc("$$ " + mathBuf.join(" "))}</p>`;   // 流式中还没收尾的公式块，先按原文显示
    flushTable(); closeList();
    return out;
  }

  // ── 本地图片内联（「拿出去」那条线）───────────────────────────────
  //  文本里出现的本机图片路径自动变成可点开的大图。
  //  前缀守卫：前面不能是 \w : / . - ，这样 URL 里的 /photo.png 不会被误认。
  const IMG_PATH_RE =
    /(^|[^\w:/.\-])((?:\/[\w.\-\u4e00-\u9fa5]+)+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))/gi;
  const SKIP_TAGS = new Set(["CODE", "PRE", "A", "BUTTON", "IMG", "SUMMARY", "TEXTAREA"]);

  function makeInlineImg(path) {
    const wrap = document.createElement("span");
    wrap.className = "inline-img";
    const img = document.createElement("img");
    img.src = fileUrl(path);
    img.alt = path;
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(path));
    img.addEventListener("error", () => {
      const a = document.createElement("a");
      a.href = "#"; a.className = "missing-img"; a.textContent = path;
      a.addEventListener("click", (e) => { e.preventDefault(); toast(t("读不到：{path}", { path }), true); });
      wrap.replaceWith(a);
    });
    wrap.appendChild(img);
    return wrap;
  }

  function embedLocalImages(root) {
    if (!root || !root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf("/") < 0) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentNode; p && p !== root; p = p.parentNode) {
          if (SKIP_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);

    for (const node of targets) {
      const text = node.nodeValue;
      IMG_PATH_RE.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = IMG_PATH_RE.exec(text))) {
        const path = m[2];
        const pathAt = m.index + m[1].length;
        // URL 查询串里的路径（…?path=/x.png）不是本机文件，跳过
        const before = text.slice(Math.max(0, pathAt - 60), pathAt);
        const tok = before.slice(Math.max(
          before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1);
        if (tok.includes("://")) continue;
        hits.push({ pathAt, path });
      }
      if (!hits.length) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      for (const h of hits) {
        if (h.pathAt > last) frag.appendChild(document.createTextNode(text.slice(last, h.pathAt)));
        frag.appendChild(makeInlineImg(h.path));
        last = h.pathAt + h.path.length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 渲染 + 内联图片，一步到位 */
  function setHtml(el, html) {
    el.innerHTML = html;
    embedLocalImages(el);
    enhanceMd(el);
    return el;
  }

  // ── 代码高亮 / 公式：库按需加载，页面里真出现了才去拉 ─────────────────
  const loadOnce = {};
  function loadScript(src, css) {
    return loadOnce[src] || (loadOnce[src] = new Promise((ok, bad) => {
      if (css) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = css; document.head.appendChild(l); }
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => { delete loadOnce[src]; bad(new Error("load " + src)); };
      document.head.appendChild(s);
    }));
  }
  function enhanceMd(el) {
    if (!el || !el.querySelector) return;
    if (el.querySelector("code[data-lang]:not(.hl)")) {
      loadScript("/vendor/hljs/highlight.min.js").then(() => {
        for (const c of el.querySelectorAll("code[data-lang]:not(.hl)")) {
          c.classList.add("hl");
          const lang = window.hljs.getLanguage(c.dataset.lang) ? c.dataset.lang : null;
          if (!lang || c.textContent.length > 200000) continue;      // 不认识的语言、超长的块不高亮
          try { c.innerHTML = window.hljs.highlight(c.textContent, { language: lang, ignoreIllegals: true }).value; } catch {}
        }
      }).catch(() => {});
    }
    if (el.querySelector(".math:not(.k)")) {
      loadScript("/vendor/katex/katex.min.js", "/vendor/katex/katex.min.css").then(() => {
        for (const m of el.querySelectorAll(".math:not(.k)")) {
          m.classList.add("k");
          try { window.katex.render(m.dataset.tex, m, { displayMode: m.classList.contains("math-d"), throwOnError: false, output: "html" }); } catch {}
        }
      }).catch(() => {});
    }
  }

  // ── 图片查看器 ────────────────────────────────────────────────────
  function openLightbox(path) {
    $("lightbox-img").src = fileUrl(path);
    $("lightbox-cap").textContent = path.split("/").pop();
    lightboxEl.dataset.path = path;
    $("lightbox-dl").innerHTML = shareIco() + esc(t("分享"));
    MO.cancel(lightboxEl); lightboxEl.classList.remove("hidden");
  }
  lightboxEl.addEventListener("click", (e) => {
    if (e.target === lightboxEl || e.target.id === "lightbox-close") MO.hide(lightboxEl, "mo-out-fade");
    if (e.target.closest("#lightbox-dl")) shareFile(lightboxEl.dataset.path);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") MO.hide(lightboxEl, "mo-out-fade");
  });

  // 代码复制 + 图片点击（事件委托）
  const onCopyBtn = (e) => {
    const b = e.target.closest(".copy-btn");
    if (!b) return;
    const code = b.parentElement.querySelector("code");
    if (code) copyText(code.textContent).then((ok) => {
      b.textContent = ok ? t("已复制") : t("复制失败"); setTimeout(() => (b.textContent = t("复制")), 1400);
    });
  };
  chatEl.addEventListener("click", onCopyBtn);
  $("vw-body").addEventListener("click", onCopyBtn);   // 文件查看器里渲染的 Markdown 也有代码块

  // 回复 / 查看器里的本机路径：点了直接在应用内打开
  async function openPath(p) {
    let r;
    try { r = await api("/api/file/stat?path=" + encodeURIComponent(p)); }
    catch (e) {
      return toast(e.status === 403 ? t("这个位置受保护，不能在界面里打开：{p}", { p }) :
        e.status === 404 ? t("文件不存在：{p}", { p }) : t("打不开：{msg}", { msg: e.message }));
    }
    if (r.dir) return openFiles(r.path);
    openViewer(r.path, r.kind, r.size);
  }
  const onPathLink = (e) => {
    const a = e.target.closest(".fpath");
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    openPath(a.dataset.path);
  };
  chatEl.addEventListener("click", onPathLink);
  $("vw-body").addEventListener("click", onPathLink);

  // 网页链接：有应用内浏览器就在里面开（cccodroid / 开发端外壳提供），否则照常新窗口
  const hasBrowser = () => !!(window.CCApp && window.CCApp.openBrowser);
  // 宽屏（两栏起）且外壳支持嵌入：浏览器开在右侧工作区，和文件 / 终端并列；窄屏照旧全屏窗口。
  // 已经开着窗格时，窄屏下的新链接也送进窗格，别再叠一个全屏窗口
  const browserEl = $("browser");
  const hasPane = () => !!(window.CCApp && window.CCApp.hasPane && window.CCLayout);
  function openWeb(url) {
    if (hasPane() && (CCLayout.tier() >= 2 || !browserEl.classList.contains("hidden"))) {
      browserEl.classList.remove("hidden");
      CCLayout.raise("browser");
      window.CCApp.paneOpen(url || "");
      return;
    }
    if (hasBrowser()) return window.CCApp.openBrowser(url || "");
    if (url) window.open(url, "_blank", "noopener");
  }
  function closeBrowser() {
    if (window.CCApp && CCApp.paneCanBack && CCApp.paneCanBack()) return CCApp.paneGoBack();   // 返回手势先在网页里后退
    browserEl.classList.add("hidden");
    if (window.CCApp && CCApp.paneClose) CCApp.paneClose();
  }
  window.__ccBrowserClosed = guardHook("__ccBrowserClosed", () => browserEl.classList.add("hidden"));    // 窗格自己的 ✕
  const onWebLink = (e) => {
    const a = e.target.closest("a.weblink");
    if (!a || !hasBrowser()) return;
    e.preventDefault();
    openWeb(a.getAttribute("href"));
  };
  chatEl.addEventListener("click", onWebLink);
  $("vw-body").addEventListener("click", onWebLink);
  if (hasBrowser()) {
    $("btn-web").classList.remove("hidden");
    $("btn-web").addEventListener("click", () => openWeb(""));
  }


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

  // 出错要看得见，但不该塞进顶栏副标题：那是状态显示，下一次状态刷新就把它盖掉，
  // 而且「顶栏里突然冒出一行报错」看着莫名其妙。改成从顶部滑下来的浮动条：
  // 红边、可关、可复制；同一条错误只留一条，20 秒后自己收。
  // WebView 的 console 不进 logcat，所以顺手上报给网关日志（/api/freeze），出问题的人不用截图也能查。
  let errBar = null, errBarT = 0, errSent = "", errSentAt = 0;
  const hideErr = () => { if (errBar) errBar.classList.add("hidden"); };
  const showErr = (msg, loc) => {
    msg = String(msg == null ? "" : msg).trim() || t("未知错误");
    console.warn("[cc] " + msg);
    try {
      const now = Date.now();
      if (msg !== errSent || now - errSentAt > 60000) {
        errSent = msg; errSentAt = now;
        fetch("/api/freeze", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ why: "ui", touch: ["[界面错误] " + msg.slice(0, 300) + (loc ? "  @" + loc : "")] }) }).catch(() => {});
      }
    } catch {}
    try {
      if (!document.body) return;
      if (!errBar) {
        errBar = document.createElement("div");
        errBar.id = "errbar";
        errBar.innerHTML = `<div class="eb-txt"></div><button type="button" class="eb-btn" data-eb="copy"></button>` +
          `<button type="button" class="eb-btn eb-x" data-eb="close" aria-hidden="true">×</button>`;
        errBar.querySelector('[data-eb="copy"]').textContent = t("复制");
        errBar.addEventListener("click", (e) => {
          const b = e.target.closest("[data-eb]");
          if (!b) return;
          if (b.dataset.eb === "close") return hideErr();
          copyText(errBar.dataset.msg || "").then((ok) => toast(ok ? t("已复制") : t("复制失败"), !ok));
        });
        document.body.appendChild(errBar);
      }
      errBar.dataset.msg = msg;
      errBar.querySelector(".eb-txt").textContent = t("界面脚本出错：{msg}", { msg });
      errBar.classList.remove("hidden");
      clearTimeout(errBarT);
      errBarT = setTimeout(hideErr, 20000);
    } catch {}
  };
  window.addEventListener("error", (e) => {
    // 光秃秃的「Script error.」没有文件和行号：是从外壳 evaluateJavascript 注入的代码里冒出去的错，WebView 把细节抹了。
    // 报出来谁也看不懂，只进控制台；外壳注入的每段代码自己 try 住交给 __ccErr，页面这边的入口也用 guardHook 包着
    if (!e.filename && /^Script error\.?$/.test(e.message || "")) { console.warn("[cc] 外壳注入的脚本出错（细节被 WebView 隐去）"); return; }
    // 带上出错位置（app.js:行号）：日志里只看得到消息时，根本没法定位是哪一段
    const st = (e.error && e.error.stack ? String(e.error.stack) : "").split("\n").find((l) => /app\.js:\d+/.test(l)) || "";
    showErr(e.message || String(e.error), (st.match(/app\.js:\d+:\d+/) || [""])[0]);
  });
  // 外壳（MainActivity）直接调用的入口：在页面自己的代码里接住错误，按原文报，不让它变成「Script error.」
  // 外壳注入的代码接住错误后交到这里（MainActivity.guarded / caught）：name 是哪个入口
  window.__ccErr = (name, err) => { console.error("[cc] " + name, err); showErr(name + "：" + (err && err.message || err)); };
  const guardHook = (name, fn) => function () {
    try { return fn.apply(this, arguments); }
    catch (err) { window.__ccErr(name, err); return false; }
  };
  window.addEventListener("unhandledrejection", (e) => {
    showErr(e.reason?.message || String(e.reason));
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
      it.el.remove();
      try { it.onClose && it.onClose(); } catch (e) { console.error(e); }
    }
    function close(el) { const it = el && find(el); if (it) drop(it); else if (el) el.remove(); sync(); }
    function closeAll(kind) { for (const it of live().slice().reverse()) if (!kind || it.kind === kind) drop(it); sync(); }
    function open(el, o = {}) {
      const kind = o.kind || "menu";
      // layer：叠在别的弹层上面开（比如频道弹窗里再开扫码），不把下面那层关掉
      if (!o.layer) closeAll(kind === "modal" ? null : "menu");
      if (!el.isConnected) document.body.appendChild(el);
      stack.push({ el, kind, anchor: o.anchor || null, onClose: o.onClose, place: o.place, keep: !!o.keep, cover: !!o.cover, w0: innerWidth });
      sync();
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
    toastEl.textContent = msg;
    toastEl.className = isErr ? "err" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), isErr ? 4200 : 3200);
  }
  // 带一个按钮的提示条（撤销之类），多停几秒
  function toastAct(msg, label, fn) {
    toastEl.textContent = msg + " ";
    const b = document.createElement("button");
    b.className = "toast-act"; b.textContent = label;
    b.onclick = () => { toastEl.classList.add("hidden"); fn(); };
    toastEl.appendChild(b);
    toastEl.className = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 7000);
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
  let stick = true, progTop = -1;
  // 对话区只挂一个 scroll 监听，事件里不读排版，攒到下一帧统一处理：跟底判断、翻到顶加载更早的、↓ 圆钮
  const chatScrollHooks = [];
  let chatScrollRaf = 0;
  chatEl.addEventListener("scroll", () => {
    if (chatScrollRaf) return;
    chatScrollRaf = requestAnimationFrame(() => {
      chatScrollRaf = 0;
      if (chatEl.scrollTop !== progTop) stick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;  // 不是我们自己滚的
      for (const f of chatScrollHooks) f();
    });
  }, { passive: true });
  function scrollDown(force) {
    if (force) stick = true;
    else if (!stick) return;
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
    lightboxEl.classList.remove("hidden");
  }
  lightboxEl.addEventListener("click", (e) => {
    if (e.target === lightboxEl || e.target.id === "lightbox-close") lightboxEl.classList.add("hidden");
    if (e.target.closest("#lightbox-dl")) shareFile(lightboxEl.dataset.path);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") lightboxEl.classList.add("hidden");
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


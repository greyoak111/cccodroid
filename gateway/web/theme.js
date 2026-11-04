// ─────────────────────────────────────────────────────────────────────
//  theme.js —— 外观：五套风格（原生 / 求索 / 逐月 / 构成 / 拾色）× 浅色 / 深色 / 跟随系统（无依赖；放在 <head> 里同步加载，避免先闪一下深色）
//
//  设置存在 localStorage["ccapp.theme"]："auto"（默认）| "light" | "dark"，求索风格加前缀 "qs-"，逐月加 "zy-"，构成加 "gc-"，拾色加 "ss-"。
//  结果写到 <html data-theme="light|dark" data-skin="native|qiusuo|zhuyue|goucheng|shise">，样式只认这两个属性（style.css 里的变量表）。
//
//  「跟随系统」靠什么判断：
//    · 壳里有 CCApp.nightMode() 就以它为准 —— 应用主题固定是深色时，WebView 的
//      prefers-color-scheme 不跟系统走，只有原生层知道系统现在是不是夜间模式；
//      系统切换时壳调用 Theme.system(true|false) 通知这里。
//    · 没有壳（浏览器里打开）就用 matchMedia。
//  定下来以后再告诉壳 CCApp.setBars(dark)，让状态栏 / 导航栏跟着换色。
// ─────────────────────────────────────────────────────────────────────

// ── 原生桥口令（cccodroid 0.4.6 起）：壳的 CCApp 里有副作用的方法第一个参数要带口令，
//    口令只经首页地址的 #k= 交给主框架（不进请求行，11-03 审查 M-3）（存 sessionStorage，刷新还在）。HTML 预览的 iframe 同样被注入了 CCApp，
//    但和界面不同源，拿不到口令，调了也没用。这里把 CCApp 换成自动带口令的一层，其余代码照旧写 CCApp.xxx(…)。
//    放在 theme.js 开头，因为它是第一个碰 CCApp 的脚本。开发端 / 测试壳没有 keyed()，原样不动
(function () {
  const raw = window.CCApp;
  if (!raw || typeof raw.keyed !== "function") return;
  let k = (/[#&]k=([0-9a-f]{32})/.exec(location.hash) || [])[1] || "";
  try { if (k) sessionStorage.setItem("cc.bk", k); else k = sessionStorage.getItem("cc.bk") || ""; } catch {}
  const PLAIN = ["hasPane", "paneCanBack", "whatsNew", "nightMode", "keyed", "wallColor"];
  const KEYED = ["privShot", "openUrl", "paneOpen", "paneBounds", "paneGoBack", "paneClose", "openBrowser", "shareText", "copyText",
    "pickDevkit", "uninstall", "unfreeze", "ensureGateway", "whatsNewSeen", "setBars", "skinPref", "accentPref", "langPref", "themePref", "saveAs", "previewNet", "skinPal", "gcPal"];
  const w = {};
  for (const m of PLAIN) if (typeof raw[m] === "function") w[m] = (...a) => raw[m](...a);
  for (const m of KEYED) if (typeof raw[m] === "function") w[m] = (...a) => raw[m](k, ...a);
  window.CCApp = w;
})();

(function () {
  const LS = "ccapp.theme";
  const MODES = ["auto", "light", "dark", "qs-auto", "qs-light", "qs-dark", "zy-auto", "zy-light", "zy-dark", "gc-auto", "gc-light", "gc-dark", "ss-auto", "ss-light", "ss-dark"];
  const PREFIX = { native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-", shise: "ss-" };
  const skinOf = (p) => (p.startsWith("qs-") ? "qiusuo" : p.startsWith("zy-") ? "zhuyue" : p.startsWith("gc-") ? "goucheng" : p.startsWith("ss-") ? "shise" : "native");
  const modeOf = (p) => p.replace(/^(qs|zy|gc|ss)-/, "");
  // 状态栏 / 导航栏底色要和页面底色一致（壳那边也有一份同样的表：BrowserPane.bg）
  const BAR = { native: { dark: "#1f1e1d", light: "#faf9f5" }, qiusuo: { dark: "#151517", light: "#ffffff" }, zhuyue: { dark: "#111111", light: "#ffffff" }, goucheng: { dark: "#151412", light: "#f3eee3" }, shise: { dark: "#141218", light: "#fdf7ff" } };   // 拾色的两格由 shisePaint 按种子色改写
  const mq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  const app = () => (window.CCApp && typeof window.CCApp.nightMode === "function" ? window.CCApp : null);

  let pref = "auto";
  try { pref = localStorage.getItem(LS) || "auto"; } catch {}
  if (!MODES.includes(pref)) pref = "auto";

  let sysDark = null;   // 壳推过来的系统状态；null = 没推过
  function systemDark() {
    if (sysDark != null) return sysDark;
    const a = app();
    if (a) { try { return !!a.nightMode(); } catch {} }
    return mq ? mq.matches : true;
  }

  function apply() {
    const skin = skinOf(pref);
    const mode = modeOf(pref);
    const dark = mode === "dark" || (mode === "auto" && systemDark());
    const name = dark ? "dark" : "light";
    const root = document.documentElement;
    if (root.dataset.theme !== name) root.dataset.theme = name;
    if (root.dataset.skin !== skin) root.dataset.skin = skin;
    shisePaint(skin);
    gcPaint(skin);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BAR[skin][name];
    applyAccent(skin, name);
    const a = app();
    // 先告诉壳风格，再让它换栏色 —— 栏色按风格取
    if (a && typeof a.skinPref === "function") { try { a.skinPref(skin); } catch {} }
    if (a && typeof a.setBars === "function") { try { a.setBars(dark); } catch {} }
    // 外壳记下这个选择，下次启动的安装页 / 空白页照着上色（cccodroid 0.1.20 起有）；壳只认 auto/light/dark
    if (a && typeof a.themePref === "function") { try { a.themePref(mode); } catch {} }
    const s = document.getElementById("set-theme");
    if (s && s.value !== pref) s.value = pref;
    // 设置里的两组分段（外观 / 深浅）是 pref 的两半
    document.querySelectorAll("#seg-skin [data-sk]").forEach((b) => b.classList.toggle("on", b.dataset.sk === skin));
    document.querySelectorAll("#seg-mode [data-md]").forEach((b) => b.classList.toggle("on", b.dataset.md === mode));
    return name;
  }

  // ── 强调色（0.4.20）：用户在设置 → 通用里挑的颜色，存在 ccapp-ui.json 的 accent（本地镜像 localStorage cc.ui，这里同步读，启动不闪）。
  //   同一个颜色在浅底、深底上看得清的深浅不一样：按当前外观的底色把亮度往对比度够的方向推，直到正文对比 ≥ 4.5:1；
  //   按钮上的字（--on-accent）在白和近黑里挑对比高的；选中项的浅底（--active-bg）也由它派生。三套外观都盖：构成的红、逐月的蓝点缀也换成它
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (h) => { const c = hex2rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function rgb2hsl([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hsl2hex(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return "#" + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
  }
  /** 把 hex 的亮度往离开 bg 的方向推，直到对比 ≥ min；推到头还不够就返回推到头的那个 */
  function readable(hex, bg, min) {
    let [h, s, l] = rgb2hsl(hex2rgb(hex)), out = hex;
    const dir = lum(bg) > 0.4 ? -1 : 1;
    for (let i = 0; i < 60 && contrast(out, bg) < min; i++) { l = Math.max(0, Math.min(1, l + dir * 0.015)); out = hsl2hex(h, s, l); }
    return out;
  }
  const mix = (a, b, p) => "#" + hex2rgb(a).map((v, i) => Math.round((v * p + hex2rgb(b)[i] * (1 - p)) * 255).toString(16).padStart(2, "0")).join("");
  function accentPref() { try { const v = (JSON.parse(localStorage.getItem("cc.ui")) || {}).accent; return /^#[0-9a-f]{6}$/i.test(v || "") ? v.toLowerCase() : ""; } catch { return ""; } }
  /** 给定外观和深浅，算出实际用的三种颜色（设置页的色块预览也用它） */
  function accentFor(hex, skin, name) {
    // 拾色：种子色推出来的主色就是强调色（设置页色块预览按这个画）
    if (skin === "shise" && hex) { const T = shiseScheme(hex, name === "dark"); return { acc: T.accent, dim: T.dim, on: T.onAccent, soft: T.sc }; }
    const bg = BAR[skin][name], acc = readable(hex, bg, 4.5);
    const on = contrast("#ffffff", acc) >= contrast("#141414", acc) ? "#ffffff" : "#141414";
    return { acc, dim: mix(acc, bg, 0.45), on, soft: mix(acc, bg, lum(bg) > 0.4 ? 0.12 : 0.2) };
  }
  function applyAccent(skin, name) {
    let el = document.getElementById("user-accent");
    const hex = accentPref();
    let css = "";
    if (skin === "shise") {
      // 拾色的强调色就是种子色推出来的主色，变量表里已经有了；外壳那边照样交一份（加载动画、对话框用）
      const a = app();
      if (a && typeof a.accentPref === "function") { try { a.accentPref(SS.light.accent, SS.dark.accent); } catch {} }
      if (el && el.textContent) el.textContent = "";
      return;
    }
    if (hex) {
      const { acc, dim, on, soft } = accentFor(hex, skin, name);
      // 构成首屏右侧那块斜切色块（--gc-wedge）原来写死成半透明红，自定颜色时漏了没跟着换；照原版的透明度从强调色派生
      const wedge = `rgba(${hex2rgb(acc).map((v) => Math.round(v * 255)).join(",")},${lum(BAR[skin][name]) > 0.4 ? .13 : .1})`;
      // 选择器带两个属性：压过各外观自己那段（同样两个属性），这段 style 插在 style.css 后面，同分时后者赢
      css = `html[data-theme][data-skin]{--accent:${acc};--accent-btn:${acc};--accent-dim:${dim};--on-accent:${on};--active-bg:${soft};--gc-red:${acc};--gc-wedge:${wedge};--zy-blue:${acc}}`;
    }
    // 外壳自己画的东西（加载动画、安装页、对话框）也跟着换：把浅色、深色底上实际用的颜色交过去，空串 = 用外观原色
    const a = app();
    if (a && typeof a.accentPref === "function") {
      try { a.accentPref(hex ? accentFor(hex, skin, "light").acc : "", hex ? accentFor(hex, skin, "dark").acc : ""); } catch {}
    }
    if (!el) { if (!css) return; el = document.createElement("style"); el.id = "user-accent"; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }

  // ── 拾色（0.5.15，Material You）：整套颜色从一个种子色推出来 ──
  //   种子：设置里自定的强调色 > 壁纸主色（安卓 12+，外壳 CCApp.wallColor 读系统 system_accent1_500）> 默认紫 #6750a4。
  //   推法：在 OKLCH 里固定种子的色相，按 Material 3 的「色调」（tone，0 黑 – 100 白）取不同明度：
  //     主色 primary 用种子彩度（不足就补到 0.09），次要色 secondary 彩度 0.035，中性色 neutral 0.008、neutral-variant 0.018。
  //   这是 Material 官方 HCT 色彩空间的近似（HCT 的 tone 就是 L*，这里用 OKLCH 明度线性映射代替），省掉一整个色彩库。
  //   M3 的「色彩角色」→ 我们的变量见 SS_ROLES；外壳要的 8 种颜色经 CCApp.skinPal 交过去
  const WALL = "cc.wall";
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function oklch(hex) {
    const [r, g, b] = hex2rgb(hex).map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
      s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), Math.atan2(B, A)];
  }
  function fromOklch(L, C, H) {
    for (let c = C; ; c = Math.max(0, c - 0.004)) {     // 超出 sRGB 就一点点降彩度（色相、明度不动）
      const A = c * Math.cos(H), B = c * Math.sin(H);
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
      const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
      if (!c || rgb.every((v) => v >= -0.001 && v <= 1.001)) return "#" + rgb.map((v) => Math.round(gam(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, "0")).join("");
    }
  }
  const tones = (H, C) => (t) => fromOklch(0.12 + 0.88 * (t / 100), C, H);
  // 状态色固定色相（成功绿、警告黄、工具蓝、紫），只随深浅换明度；错误按 M3 的 error 红
  const fixed = (deg, C) => tones(deg * Math.PI / 180, C);
  const OK = fixed(145, 0.11), WARN = fixed(80, 0.11), TOOL = fixed(250, 0.1), PURP = fixed(300, 0.11), ERR = fixed(28, 0.17);
  function shiseScheme(seed, dark) {
    const [, C, H] = oklch(seed);
    // 容器色（气泡、选中块）彩度封顶：高彩度的种子（青、绿）在 90 色调上会艳得刺眼，M3 的容器本来就偏柔
    // 灰种子（黑白壁纸、灰色强调色）色相没有意义，补彩会落到红相整套发粉：彩度很低时就做成近乎无彩的一套
    const gray = C < 0.02;
    const p = tones(H, gray ? 0.012 : Math.max(C, 0.09)), pc = tones(H, gray ? 0.01 : Math.min(Math.max(C, 0.04), 0.07)), s = tones(H, gray ? 0.008 : 0.035), n = tones(H, 0.008), nv = tones(H, 0.018);
    const T = dark
      ? { bg: n(6), bg2: n(10), bg3: n(12), bg4: n(17), c5: n(22), fg: n(90), fg2: nv(80), fg3: nv(62), strong: n(98), line: nv(30), ov: nv(30), outline: nv(60),
          accent: p(80), onAccent: p(20), pc: pc(30), onPc: p(90), sc: s(30), onSc: s(90), dim: p(40),
          ok: OK(80), warn: WARN(80), tool: TOOL(80), purple: PURP(80), err: ERR(80), errBg: ERR(25), errLine: ERR(35), errFg: ERR(90) }
      : { bg: n(98), bg2: n(96), bg3: n(94), bg4: n(92), c5: n(90), fg: n(10), fg2: nv(30), fg3: nv(50), strong: n(4), line: nv(88), ov: nv(80), outline: nv(50),
          accent: p(40), onAccent: "#ffffff", pc: pc(90), onPc: p(10), sc: s(90), onSc: s(10), dim: p(80),
          ok: OK(40), warn: WARN(45), tool: TOOL(40), purple: PURP(40), err: ERR(40), errBg: ERR(92), errLine: ERR(80), errFg: ERR(25) };
    T.tool2 = dark ? s(25) : s(95);   // 斜杠命令卡、系统消息：次要色的浅容器
    return T;
  }
  function shiseCss(T) {
    const rgba = (hex, a) => `rgba(${hex2rgb(hex).map((v) => Math.round(v * 255)).join(",")},${a})`;
    return [
      `--bg:${T.bg};--bg2:${T.bg2};--bg3:${T.bg3};--bg4:${T.bg4};--line:${T.line}`,
      `--fg:${T.fg};--fg2:${T.fg2};--fg3:${T.fg3};--strong:${T.strong}`,
      `--accent:${T.accent};--accent-btn:${T.accent};--accent-dim:${T.dim};--on-accent:${T.onAccent};--active-bg:${T.sc}`,
      `--ok:${T.ok};--err:${T.err};--warn:${T.warn};--tool:${T.tool};--purple:${T.purple};--ctx-warn:${T.warn};--ctx-err:${T.err}`,
      `--bar-bg:${T.bg};--bar-bg2:${T.bg};--veil:${rgba(T.bg, 0.88)}`,
      `--code-bg:${T.bg3};--think-bg:${T.bg2};--more-bg:${T.bg3};--more-line:${T.ov}`,
      `--user-bg:${T.pc};--user-line:${T.pc};--sys-bg:${T.tool2};--sys-line:${T.tool2}`,
      `--tool-bg:${T.bg2};--tool-line:${T.bg2};--tool-sep:${T.bg4};--cmd-bg:${T.tool2}`,
      `--err-bg:${T.errBg};--err-line:${T.errLine};--err-fg:${T.errFg}`,
      `--panel:${T.bg2};--input-bg:${T.bg4};--radius:16px`,
      // M3 角色原名，结构覆盖里直接用
      `--ss-pc:${T.pc};--ss-on-pc:${T.onPc};--ss-sc:${T.sc};--ss-on-sc:${T.onSc};--ss-c5:${T.c5};--ss-outline:${T.outline};--ss-ov:${T.ov}`,
    ].join(";");
  }
  function wallSeed() {
    const a = app();
    let w = "";
    if (a && typeof a.wallColor === "function") { try { w = String(a.wallColor() || "").toLowerCase(); } catch {} }
    if (/^#[0-9a-f]{6}$/.test(w)) { try { localStorage.setItem(WALL, w); } catch {} return w; }
    try { w = localStorage.getItem(WALL) || ""; } catch {}
    return /^#[0-9a-f]{6}$/.test(w) ? w : "";
  }
  // ── 构成浅色的纸色（群友反馈「看着偏黄，能不能调」）：ccapp-ui.json 的 gcPaper，0 偏白 … 50 现在的样子 … 100 原版牛皮纸 ──
  //   每个底色 / 线色 / 浅字色两头各有一个端点：白端 = 同亮度的中性灰（越亮的往白提得越多），黄端 = 现在的颜色离白端再走同样一段；
  //   中间按 RGB 线性插。只动浅色，深色不变；状态栏和外壳的颜色经 CCApp.gcPal 跟着换
  const GC_BASE = { "--bg": "#f3eee3", "--bg2": "#faf7ef", "--bg3": "#e9e2d2", "--bg4": "#ddd4c0", "--line": "#cdc2aa", "--fg2": "#4f483d", "--fg3": "#6b6255",
    "--code-bg": "#e9e2d2", "--think-bg": "#eee8db", "--more-bg": "#e9e2d2", "--more-line": "#cdc2aa", "--user-bg": "#faf7ef", "--tool-bg": "#faf7ef",
    "--tool-sep": "#e9e2d2", "--cmd-bg": "#eeeadf", "--panel": "#faf7ef", "--input-bg": "#faf7ef", "--on-accent": "#faf7ef" };
  let gcPrev = null;   // 设置里拖滑块时的临时值（松手才存）
  function gcPaperPref() {
    if (gcPrev != null) return gcPrev;
    try { const v = (JSON.parse(localStorage.getItem("cc.ui")) || {}).gcPaper; return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50; } catch { return 50; }
  }
  function gcTone(hex, v) {
    const c = hex2rgb(hex), y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const w = c.map(() => y + (1 - y) * 0.6 * Math.max(0, Math.min(1, (y - 0.6) / 0.3)));   // 越亮往白提得越多，深色字不提
    const k = c.map((x, i) => Math.max(0, Math.min(1, 2 * x - w[i])));
    const t = v / 50, out = c.map((x, i) => (t <= 1 ? w[i] + (x - w[i]) * t : x + (k[i] - x) * (t - 1)));
    return "#" + out.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  }
  function gcPaint(skin) {
    let el = document.getElementById("gc-paper");
    const v = skin === "goucheng" ? gcPaperPref() : 50;
    const col = (h) => (v === 50 ? h : gcTone(h, v));
    BAR.goucheng.light = col(GC_BASE["--bg"]);
    let css = "";
    if (v !== 50) {
      const bg = hex2rgb(BAR.goucheng.light).map((x) => Math.round(x * 255)).join(",");
      css = `html[data-skin="goucheng"][data-theme="light"]{${Object.entries(GC_BASE).map(([k, h]) => `${k}:${col(h)}`).join(";")};--bar-bg:${BAR.goucheng.light};--bar-bg2:${BAR.goucheng.light};--veil:rgba(${bg},.9)}`;
    }
    const a = app();
    // 外壳的 8 键：bg card field line fg dim hint accent（见 BrowserPane.pal）；空串 = 用原色
    if (skin === "goucheng" && a && typeof a.gcPal === "function") {
      try { a.gcPal(v === 50 ? "" : [col("#f3eee3"), col("#faf7ef"), col("#e9e2d2"), col("#cdc2aa"), "#1a1a1a", col("#4f483d"), col("#6b6255"), "#c8211b"].join(",")); } catch {}
    }
    if (!el) { if (!css) return; el = document.createElement("style"); el.id = "gc-paper"; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }
  /** 设置里拖动时预览（null = 回到存着的值） */
  function gcPreview(v) { gcPrev = v == null ? null : Math.max(0, Math.min(100, Math.round(v))); apply(); }
  const SS = { seed: "", light: null, dark: null };
  /** 拾色：按种子色写变量表、改状态栏底色、把 8 种颜色交给外壳；别的外观清掉那段 style */
  function shisePaint(skin) {
    let el = document.getElementById("shise-vars");
    if (skin !== "shise") { if (el && el.textContent) el.textContent = ""; return; }
    const seed = accentPref() || wallSeed() || "#6750a4";
    if (seed !== SS.seed || !SS.light) {
      SS.seed = seed; SS.light = shiseScheme(seed, false); SS.dark = shiseScheme(seed, true);
      BAR.shise = { light: SS.light.bg, dark: SS.dark.bg };
      const a = app(), pal = (T) => [T.bg, T.bg2, T.bg4, T.ov, T.fg, T.fg2, T.fg3, T.accent].join(",");
      // 外壳的 8 键：bg card field line fg dim hint accent（见 BrowserPane.pal）
      if (a && typeof a.skinPal === "function") { try { a.skinPal(pal(SS.light), pal(SS.dark)); } catch {} }
    }
    const css = `html[data-skin="shise"][data-theme="light"]{${shiseCss(SS.light)}}html[data-skin="shise"][data-theme="dark"]{${shiseCss(SS.dark)}}`;
    if (!el) { el = document.createElement("style"); el.id = "shise-vars"; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }
  /** 外壳回到前台时发现壁纸主色变了就调这里（不是安卓 12+ 不会调） */
  function wall(hex) {
    try {
      if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return;
      try { localStorage.setItem(WALL, hex.toLowerCase()); } catch {}
      if (skinOf(pref) === "shise") apply();
    } catch (e) { console.error("[cc] Theme.wall", e); }
  }

  function set(v) {
    if (!MODES.includes(v)) v = "auto";
    pref = v;
    try { localStorage.setItem(LS, v); } catch {}
    window.Theme.pref = v;
    apply();
  }

  /** 壳在系统切换夜间模式时调用 */
  // 外壳 evaluateJavascript 直接调它：自己接住错误，免得变成看不懂的「Script error.」
  function system(dark) { try { sysDark = !!dark; if (pref.endsWith("auto")) apply(); } catch (e) { console.error("[cc] Theme.system", e); } }

  if (mq) {
    const on = () => { if (sysDark == null && !app() && pref.endsWith("auto")) apply(); };
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
  }

  // 设置页的下拉框（index.html 的 #set-theme），事件委托：设置页重新渲染也不失效
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "set-theme") set(e.target.value); }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#seg-skin [data-sk], #seg-mode [data-md]"); if (!b) return;
    const skin = b.dataset.sk || skinOf(pref), mode = b.dataset.md || modeOf(pref);
    set((PREFIX[skin] || "") + mode);
  });
  document.addEventListener("DOMContentLoaded", apply);

  // ── 字体与正文字号：和配色一样同步生效，避免先闪一下系统字体 ──
  //   界面字体  ccapp.uifont   cc（默认：自带 Inter + 思源黑体）| system（跟随系统）
  //   回复字体  ccapp.readfont serif（默认：自带 Spectral + 思源宋体）| sans
  //   正文字号  ccapp.fs       s | m（默认）| l | xl（特大，给看不清的人；审查 #49 待确认-1）
  //   界面、回复两个字体槽位还能填导入的字体 "u:<id>"（0.4.20 起，见 gw/fonts.mjs；等宽不开放：终端和代码按格子排，换字体容易错位），这时属性写 "u"，具体是哪个字体由下面注入的 <style id="user-fonts"> 定。
  //   结果写到 <html data-uifont data-readfont data-fs>，样式只认这几个属性
  const TYPE = { uifont: ["cc", "system"], readfont: ["serif", "sans"], fs: ["m", "s", "l", "xl"] };
  const SLOTS = ["uifont", "readfont"];
  // 导入字体的清单在网关（/api/fonts），这里缓存一份，好在页面一开头就把 @font-face 写进去；界面启动后会再和网关对一次
  const UF = "ccapp.ufonts";
  let ufonts = [];
  try { const j = JSON.parse(localStorage.getItem(UF) || "[]"); if (Array.isArray(j)) ufonts = j.filter((f) => f && /^[0-9a-f]{12}$/.test(f.id)); } catch {}
  const okVal = (k, v) => (TYPE[k] || []).includes(v) || (SLOTS.includes(k) && typeof v === "string" && v.startsWith("u:") && ufonts.some((f) => "u:" + f.id === v));
  const typePref = {};
  for (const k in TYPE) { let v = null; try { v = localStorage.getItem("ccapp." + k); } catch {} typePref[k] = okVal(k, v) ? v : TYPE[k][0]; }
  // 格式只取表里的：本地存的值会原样进 CSS 字符串（审查 10-30 第九份 前端低3）
  const FMT = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" };
  const fam = (id) => `"CCU ${id}"`;
  function paintFonts() {
    let el = document.getElementById("user-fonts");
    if (!el) { el = document.createElement("style"); el.id = "user-fonts"; document.head.appendChild(el); }
    // 只声明不下载：@font-face 要等真有元素用到这个字体时才去取
    let css = ufonts.map((f) => `@font-face{font-family:${fam(f.id)};src:url("/api/fonts/file/${f.id}") format("${FMT[f.fmt] || "truetype"}");font-display:swap}`).join("\n");
    const id = (k) => (typePref[k].startsWith("u:") ? typePref[k].slice(2) : "");
    // 导入的字体排第一，缺字（比如英文字体里没有中文）照旧落回自带字体
    if (id("uifont")) css += `\nhtml[data-uifont="u"]{--font-ui:${fam(id("uifont"))},"CC Inter","CC Hei",sans-serif}`;
    if (id("readfont")) css += `\nhtml[data-readfont="u"]{--font-read:${fam(id("readfont"))},var(--font-serif)}`;
    if (el.textContent !== css) el.textContent = css;
  }
  function applyType() {
    const root = document.documentElement;
    paintFonts();
    for (const k in TYPE) { const v = typePref[k].startsWith("u:") ? "u" : typePref[k]; if (root.dataset[k] !== v) root.dataset[k] = v; }
    const SEG = { uifont: ["#seg-uifont", "uf"], readfont: ["#seg-readfont", "rf"], fs: ["#seg-fs", "fs"] };
    for (const k in SEG) {
      const [sel, d] = SEG[k], v = typePref[k].startsWith("u:") ? "pick" : typePref[k];
      document.querySelectorAll(`${sel} [data-${d}]`).forEach((b) => b.classList.toggle("on", b.dataset[d] === v));
    }
  }
  function setType(k, v) {
    if (!okVal(k, v)) return;
    const was = typePref[k];
    typePref[k] = v;
    try { localStorage.setItem("ccapp." + k, v); } catch {}
    applyType();
    if (was !== v) document.dispatchEvent(new CustomEvent("cc:type", { detail: { key: k, value: v } }));
  }
  /** 网关的字体清单（导入 / 删除后、界面启动时）：更新缓存；正在用的字体没了就退回默认 */
  function setFonts(list) {
    ufonts = (Array.isArray(list) ? list : []).filter((f) => f && /^[0-9a-f]{12}$/.test(f.id)).map((f) => ({ id: f.id, name: f.name, fmt: f.fmt }));
    try { localStorage.setItem(UF, JSON.stringify(ufonts)); } catch {}
    for (const k of SLOTS) if (!okVal(k, typePref[k])) setType(k, TYPE[k][0]);
    applyType();
  }
  const fontOf = (k) => (typePref[k].startsWith("u:") ? ufonts.find((f) => "u:" + f.id === typePref[k]) || null : null);
  document.addEventListener("click", (e) => {
    // 「自选…」不在这里管（要弹菜单、可能还要导入），界面那边接（09-settings.js 的字体一节）
    const b = e.target.closest && e.target.closest("#seg-uifont [data-uf], #seg-readfont [data-rf], #seg-fs [data-fs]"); if (!b) return;
    if (b.dataset.uf) setType("uifont", b.dataset.uf);
    else if (b.dataset.rf) setType("readfont", b.dataset.rf);
    else setType("fs", b.dataset.fs);
  });
  document.addEventListener("DOMContentLoaded", applyType);
  applyType();

  window.Theme = { pref, set, system, wall, wallSeed, apply, accentFor, gcPreview, gcPaperPref, get skin() { return skinOf(pref); }, setType, type: typePref, setFonts, fontOf, fam, get fonts() { return ufonts.slice(); }, get current() { return document.documentElement.dataset.theme; } };
  apply();
})();

// 老内核（Chrome 104 一档）没有 :has() / @container / color-mix()：用到它们的规则整条作废，补一份改写过的（见 compat-old.js）
(() => {
  try {
    if (CSS.supports("selector(:has(a))") && CSS.supports("color", "color-mix(in srgb, red 50%, blue)") && CSS.supports("container-type", "inline-size")) return;
    const s = document.createElement("script");
    s.src = "/compat-old.js";
    document.head.appendChild(s);
  } catch {}
})();

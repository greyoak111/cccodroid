// ─────────────────────────────────────────────────────────────────────
//  i18n.js —— 界面多语言（无依赖；在 langs.js 之后、app.js 之前加载）
//
//  思路：**中文原文就是键**。代码里照旧写中文，外面套一层 t()：
//      t("刷新列表")                       → "Refresh"
//      t("{n} 分钟前", { n: 5 })           → "5 min ago"
//  词典（lang-<code>.js）是「中文原文 → 译文」的平铺表。查找顺序：当前语言 → 英文 → 中文原文。
//  所以翻译可以一点一点补，任何时候界面都不会坏，只是没译的地方退回英文 / 中文。
//
//  静态 HTML 不调 t()，打标记，由 apply() 在加载时替换：
//      <button data-i18n>刷新列表</button>                 文本（只用于没有子元素的叶子节点）
//      <div data-i18n-html>从 <code>/models</code> 拉取</div>  innerHTML 整段当键（含行内标签时用）
//      <input data-i18n-attr="placeholder,title" placeholder="…" title="…">  翻译这些属性
//      <div data-i18n-skip>…</div>                         整个子树不翻译（语言选择区块就是这样）
//  键是元素**原始**内容（首次 apply 时记下；data-i18n-html 的键会把连续空白压成一个空格）。
//
//  语言设置存在 localStorage["ccapp.lang"]（"auto" 或 langs.js 里的 code）。
//  只加载当前语言的词典（document.write 同步插入，保证在 app.js 之前就位）；切换后整页 reload ——
//  app.js 里的动态文本都是渲染时现取的，reload 最省事也最不会漏。
//  网关请求会带 X-CC-Lang 头（见 app.js 的 api()），网关侧要本地化提示语时按它来。
// ─────────────────────────────────────────────────────────────────────
(() => {
  "use strict";
  const LS = "ccapp.lang";
  const SRC = "zh", FALLBACK = "en";
  const LANGS = Array.isArray(window.I18N_LANGS) && window.I18N_LANGS.length
    ? window.I18N_LANGS
    : [{ code: "zh", name: "简体中文", match: ["zh"] }, { code: "en", name: "English", match: ["en"] }];
  const byCode = Object.fromEntries(LANGS.map((l) => [l.code, l]));

  function systemLang() {
    const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""])
      .map((s) => String(s).toLowerCase());
    // 按用户的系统语言偏好逐个试；每个偏好挑**最具体**的匹配（zh-tw 优先配 zh-tw 而不是 zh）
    for (const p of prefs) {
      let best = null, bestLen = -1;
      for (const l of LANGS) {
        for (const m of l.match || [l.code.toLowerCase()]) {
          if ((p === m || p.startsWith(m + "-")) && m.length > bestLen) { best = l.code; bestLen = m.length; }
        }
      }
      if (best) return best;
    }
    return byCode[FALLBACK] ? FALLBACK : SRC;
  }

  let pref = "auto";
  try { pref = localStorage.getItem(LS) || "auto"; } catch {}
  // ?lang=<code>|auto：写进存储再把参数抹掉（测试用，也是最后的恢复手段）
  const q = /[?&]lang=([\w-]+)/.exec(location.search);
  if (q) {
    pref = q[1];
    try { localStorage.setItem(LS, pref); } catch {}
    history.replaceState(null, "", location.pathname + location.search.replace(/([?&])lang=[\w-]+&?/, "$1").replace(/[?&]$/, "") + location.hash);
  }
  if (pref !== "auto" && !byCode[pref]) pref = "auto";   // 存了个不认识的值（比如语言被撤掉了）：别卡死在它上面
  const lang = pref === "auto" ? systemLang() : pref;
  // 告诉 cccodroid 的原生外壳（通知、安装页、更新文案）界面最终用哪种语言；开发端 / 浏览器里没有这个桥就跳过
  try { const a = window.CCApp; if (a && typeof a.langPref === "function") a.langPref(lang); } catch {}
  const missing = new Set();   // 本次运行里查过但当前语言没译的键，调试用：[...I18N.missing]

  window.I18N_DICT = window.I18N_DICT || {};
  const dictOf = (code) => window.I18N_DICT[code] || null;

  function fill(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  function lookup(d, zh, vars) {
    const v = d[zh];
    if (v === undefined) return undefined;
    if (typeof v === "function") {
      try { return String(v(vars || {})); } catch { return undefined; }   // 词典写错了就往下回退，别让界面崩
    }
    return fill(String(v), vars);
  }

  /** 翻译。zh 原文即键；词典值可以是字符串，也可以是 (vars) => 字符串（复数等语法差异用） */
  function t(zh, vars) {
    if (lang === SRC) return fill(zh, vars);
    const d = dictOf(lang);
    let r = d ? lookup(d, zh, vars) : undefined;
    if (r !== undefined) return r;
    missing.add(zh);
    const fb = lang !== FALLBACK ? dictOf(FALLBACK) : null;
    if (fb && (r = lookup(fb, zh, vars)) !== undefined) return r;
    return fill(zh, vars);
  }

  /** 把 root 下打了 data-i18n* 标记的元素换成当前语言 */
  function apply(root) {
    if (lang === SRC) return;
    root = root || document;
    const skip = (el) => !!el.closest("[data-i18n-skip]");
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      if (skip(el)) return;
      if (el.__i18nText === undefined) el.__i18nText = el.textContent.trim();
      el.textContent = t(el.__i18nText);
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      if (skip(el)) return;
      if (el.__i18nHtml === undefined) el.__i18nHtml = el.innerHTML.trim().replace(/\s+/g, " ");
      el.innerHTML = t(el.__i18nHtml);
    });
    root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      if (skip(el)) return;
      el.__i18nAttr = el.__i18nAttr || {};
      for (const a of el.getAttribute("data-i18n-attr").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!(a in el.__i18nAttr)) el.__i18nAttr[a] = el.getAttribute(a) || "";
        if (el.__i18nAttr[a]) el.setAttribute(a, t(el.__i18nAttr[a]));
      }
    });
  }

  function setLang(v) {
    if (v !== "auto" && !byCode[v]) v = "auto";
    let ok = false;
    try { localStorage.setItem(LS, v); ok = localStorage.getItem(LS) === v; } catch {}
    if (!ok) { alert("语言设置没能保存 / Could not save the language setting"); return; }
    location.reload();
  }

  window.I18N = { lang, pref, t, apply, setLang, missing, langs: LANGS };
  document.documentElement.lang = lang === SRC ? "zh-CN" : lang;
  document.documentElement.dir = (byCode[lang] && byCode[lang].dir) || "ltr";

  // 只加载要用的词典（当前语言 + 英文兜底）。document.write 出来的脚本会在 app.js 之前同步执行完；
  // 词典文件缺失（404）不要紧 —— t() 自动回退，界面照常。最后的 i18n-apply.js 在词典就位后翻译静态标记（不能写成内联脚本：CSP 不放行）。
  if (lang !== SRC) {
    const need = [lang]; if (lang !== FALLBACK && byCode[FALLBACK]) need.push(FALLBACK);
    document.write(need.map((c) => `<script src="/lang-${encodeURIComponent(c)}.js"><\/script>`).join("") +
      `<script src="/i18n-apply.js"><\/script>`);
  }

  // ── 设置页的语言下拉框（index.html 的 #set-lang）──
  // 「切过去切不回来」是这里唯一不能出的错，所以：
  //   · 选项由这里按注册表生成，各语言名字用自己的写法（谁都认得出自己的语言）；
  //   · 用 document 上的事件委托，不依赖某个具体的元素对象 —— 设置页哪天被重新渲染也不会失效；
  //   · 每次显示前把选中值对齐到真实设置（聚焦 / 指到时），不会显示一个和实际不符的值；
  function fillSel() {
    const s = document.getElementById("set-lang");
    if (!s) return;
    if (!s.__i18nFilled) {
      s.__i18nFilled = true;
      s.innerHTML = "";
      const add = (v, label) => { const o = document.createElement("option"); o.value = v; o.textContent = label; s.appendChild(o); };
      add("auto", t("跟随系统"));
      for (const l of LANGS) add(l.code, l.name);
    }
    if (s.value !== pref) s.value = pref;
  }
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "set-lang") setLang(e.target.value); }, true);
  document.addEventListener("focusin", (e) => { if (e.target && e.target.id === "set-lang") fillSel(); }, true);
  document.addEventListener("pointerdown", (e) => { if (e.target && e.target.id === "set-lang") fillSel(); }, true);
  // 「跟随系统」这一项要翻译：词典是上面 document.write 出来的脚本，本脚本执行完才轮到它们，
  // 立刻填会把中文原文写死进 option（之后 __i18nFilled 又挡住重建）。等 DOM 解析完、词典就位再填第一次。
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fillSel, { once: true });
  else fillSel();

})();

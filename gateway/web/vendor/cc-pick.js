/* cccodroid 预览里的「选取元素」：界面发 {cc:"pick"} 进入选取模式，点一下网页里的某块，
   把它的选择器、标签和一小段 HTML 递回界面（{cc:"picked"}）。只递文字，界面那边只往输入框里放，不执行任何东西。
   和开发者工具（Eruda）一起按开关注入，只改预览吐出去的那一份，磁盘上的文件不动。 */
(function () {
  if (window.__ccPick) return;
  window.__ccPick = 1;
  var on = false, box = null, cur = null;
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&"); }
  function selector(el) {
    var parts = [];
    for (var e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 5; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + cssEsc(e.id)); break; }
      var s = e.tagName.toLowerCase();
      var cls = [].slice.call(e.classList).filter(function (c) { return !/^cc-pick/.test(c); }).slice(0, 2);
      if (cls.length) s += "." + cls.map(cssEsc).join(".");
      var p = e.parentElement;
      if (p) {
        var same = [].filter.call(p.children, function (c) { return c.tagName === e.tagName; });
        if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  function inDevtools(el) { return !!(el && el.closest && el.closest("#eruda, .eruda-container, [class^='eruda-']")); }
  function mark(el) {
    if (!box) {
      box = document.createElement("div");
      box.className = "cc-pick-box";
      box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2f7cf6;background:rgba(47,124,246,.12);border-radius:3px;transition:all .08s";
      document.documentElement.appendChild(box);
    }
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
    box.style.display = "block";
  }
  function stop() {
    on = false; cur = null;
    if (box) box.style.display = "none";
    document.documentElement.style.cursor = "";
  }
  function target(e) {
    var t = e.touches && e.touches[0] ? document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY) : e.target;
    return t && t.nodeType === 1 && t !== box && !inDevtools(t) ? t : null;
  }
  function hover(e) { if (!on) return; var t = target(e); if (t) { cur = t; mark(t); } }
  function pick(e) {
    if (!on) return;
    var t = target(e) || cur;
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    var html = t.outerHTML || "";
    if (html.length > 800) html = html.slice(0, 800) + "…";
    var text = (t.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    stop();
    var out = { cc: "picked", sel: selector(t), tag: t.tagName.toLowerCase(), html: html, text: text, page: location.pathname, url: location.href };
    window.__ccPicked = out;   // 浏览器窗格（原生 WebView）没有父页面，原生侧轮询来取
    if (parent !== window) parent.postMessage(out, "*");
  }
  document.addEventListener("mousemove", hover, true);
  document.addEventListener("touchstart", hover, { capture: true, passive: true });
  document.addEventListener("touchmove", hover, { capture: true, passive: true });
  document.addEventListener("click", pick, true);
  document.addEventListener("keydown", function (e) { if (on && e.key === "Escape") { stop(); parent.postMessage({ cc: "pickoff" }, "*"); } }, true);
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.cc === "pick") { on = true; document.documentElement.style.cursor = "crosshair"; }
    else if (e.data.cc === "pickoff") stop();
  });
})();

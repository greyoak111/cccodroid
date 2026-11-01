  // ── 脉络 · 导出（规划书 §4 阶段 4）：当前这张图 → 图片（PNG）/ 矢量图（SVG）/ 能拖能点的单文件网页（HTML） ──
  // 图由 map.js 的 snapshot() 画成独立 SVG（不带选中、颜色写死在元素上）；PNG 用 canvas 把这张 SVG 画出来；
  // 网页 = map.js 原样 + 这一页用到的样式（变量换成此刻的值）+ 图的数据 + 这几句的译文，单个文件拿到哪都能打开。
  // 都落到导出目录（POST /api/lineage/export，gw/profile.mjs），再给「预览 / 保存到 / 分享」。
  const LX = { busy: false };
  const lxStamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const lxFoot = () => "cccodroid · " + t("脉络") + " · " + new Date().toLocaleString(I18N.lang);

  $("lin-export").addEventListener("click", (e) => {
    if (!LIN.map || !LIN.model) return;
    popMenu(e.currentTarget, [{ head: t("导出这张图") },
      { label: t("图片（PNG）"), icon: SM.export, fn: () => linExport("png") },
      { label: t("矢量图（SVG）"), icon: SM.export, fn: () => linExport("svg") },
      { label: t("能拖能点的网页（HTML）"), icon: SM.export, fn: () => linExport("html") }]);
  });

  async function linExport(kind) {
    if (LX.busy) return;
    const btn = $("lin-export");
    LX.busy = true; btn.classList.add("on");
    try {
      const name = `cccodroid-lineage-${lxStamp()}.${kind}`;
      let data;
      if (kind === "html") data = await lxHtml();
      else {
        const snap = LIN.map.snapshot({ foot: lxFoot() });
        if (!snap) return toast(t("图上还没有会话"), true);
        data = kind === "svg" ? snap.svg : await lxPng(snap);
      }
      const r = await post("/api/lineage/export", { name, data });
      lxDone(r.file, kind);
    } catch (err) { toast(t("导出失败：{e}", { e: err.message }), true); }
    finally { LX.busy = false; btn.classList.remove("on"); }
  }

  /** SVG → PNG：两倍清晰度，太大的图按画布上限缩（安卓 WebView 单边过 8192 / 面积过 4000 万像素会画成空白） */
  function lxPng(snap) {
    return new Promise((ok, bad) => {
      const img = new Image(), url = URL.createObjectURL(new Blob([snap.svg], { type: "image/svg+xml" }));
      img.onload = () => {
        try {
          let k = 2;
          k = Math.min(k, 8192 / snap.W, 8192 / snap.H, Math.sqrt(4e7 / (snap.W * snap.H)));
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(snap.W * k)); cv.height = Math.max(1, Math.round(snap.H * k));
          const g = cv.getContext("2d");
          g.scale(k, k); g.drawImage(img, 0, 0);
          ok(cv.toDataURL("image/png").split(",")[1]);
        } catch (e) { bad(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); bad(new Error(t("图片没画出来"))); };
      img.src = url;
    });
  }

  /** 单文件网页：样式表里跟地图有关的规则（连同用到的动画），变量全换成此刻的值；html 上的外观 / 动效标记照抄，规则才对得上 */
  async function lxHtml() {
    const src = await (await fetch("/lineage/map.js")).text();
    const want = /\.(lmap|lm-[\w-]+|t-(title|axis|now|ch))\b/;
    const css = [], anims = new Set(), kfs = new Map();
    const walk = (rules, media) => {
      for (const r of rules) {
        if (r.type === CSSRule.MEDIA_RULE) { if (matchMedia(r.media.mediaText).matches) walk(r.cssRules, r.media.mediaText); continue; }
        if (r.type === CSSRule.KEYFRAMES_RULE) { kfs.set(r.name, r.cssText); continue; }
        if (r.type !== CSSRule.STYLE_RULE || !want.test(r.selectorText)) continue;
        css.push(r.cssText);
        for (const m of r.cssText.matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)) anims.add(m[1]);
      }
    };
    for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch { continue; } walk(rs); }
    // 变量：规则里用到的，按地图根元素此刻的计算值写死（外观 / 强调色 / 深浅色都跟着导出那一刻）
    // 样式里用户能定的值（字体名、强调色）去掉尖括号；要在下面拼变量前定义（以前定义在后面，导出 HTML 必抛 TDZ，审查 B13）
    const cssv = (s) => String(s).replace(/[<>]/g, "");
    const el = $("lin-map"), cs = getComputedStyle(el), vars = new Set();
    for (const c of css) for (const m of c.matchAll(/var\(--([\w-]+)/g)) vars.add(m[1]);
    const root = [...vars].map((v) => `--${v}:${cssv(cs.getPropertyValue("--" + v).trim() || "initial")}`).join(";");
    const keys = new Set([...src.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse('"' + m[1] + '"')));
    const dict = Object.fromEntries([...keys].map((k) => [k, t(k)]));
    const html = document.documentElement, attrs = ["data-skin", "data-motion", "dir"].filter((a) => html.getAttribute(a)).map((a) => ` ${a}="${esc(html.getAttribute(a))}"`).join("");
    const safe = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");
    // 数据（会话标题、章名都在里面）塞进 <script>：< 一律写成 \u003c，标题里夹 <!--<script 之类也搅不乱解析；样式里用户能定的值（字体名、强调色）同理
    const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const model = { ...LIN.model, now: Date.now() };
    const bg = getComputedStyle(document.body).backgroundColor, fg = getComputedStyle(document.body).color;
    return `<!doctype html>
<html lang="${esc(I18N.lang)}"${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t("脉络") + " · " + new Date().toLocaleDateString(I18N.lang))}</title>
<style>:root{${root}}
html,body{margin:0;height:100%;background:${cssv(bg)};color:${cssv(fg)};font-family:${cssv(cs.fontFamily)};-webkit-text-size-adjust:100%}
#m{position:fixed;inset:0 0 28px 0}
#foot{position:fixed;inset:auto 0 0 0;height:28px;line-height:28px;padding:0 14px;font-size:12px;color:var(--fg3,#888)}
${safe(css.join("\n"))}
${safe([...anims].filter((a) => kfs.has(a)).map((a) => kfs.get(a)).join("\n"))}
</style></head><body><div id="m"></div><div id="foot">${esc(lxFoot())}</div>
<script>${safe(src)}</script>
<script>
(function(){var D=${js(dict)};
var f=function(k,v){var s=D[k]||k;return String(s).replace(/\\{(\\w+)\\}/g,function(m,x){return v&&x in v?v[x]:m;});};
var m=CCLineageMap.create(document.getElementById("m"),{t:f,locale:${js(I18N.lang)},acts:function(){return [];},onAct:function(){}});
m.set(${js(model)},{misc:${js(!!LIN.misc)},band:${js(LIN.band || "")},home:true});})();
</script></body></html>`;
  }

  function lxDone(file, kind) {
    const mime = { png: "image/png", svg: "image/svg+xml", html: "text/html" }[kind];
    // 导出目录在共享存储上才能直接预览（没有共享目录时落在应用私有目录，文件接口不给读）；
    // 共享存储里的文件，有存储权限的别的应用也读得到（里面有会话标题和章首提问），说清楚放哪了
    const shared = /^\/(sdcard|storage)\//.test(file);
    const items = [{ head: t("已导出：{name}", { name: file.split("/").pop() }) },
      { head: shared ? t("存在 {dir}，有存储权限的应用都能读到", { dir: file.slice(0, file.lastIndexOf("/")) }) : t("存在应用私有目录里，别的应用读不到") }];
    if (shared) items.push({ label: t("预览"), icon: SM.export, fn: () => openViewer(file, kind === "html" ? "text" : "image") });   // 矢量图按图片看（文件接口把 .svg 算文本，会进编辑器）；网页进网页预览
    if (canSaveAs()) items.push({ label: t("保存到…"), icon: SM.export, fn: () => saveAs(file, mime) });
    if (canShare()) items.push({ label: t("分享"), icon: SM.export, fn: async () => {
      try { const j = await post("/api/app/share_file", { path: file, mime }); if (!j.ok) toast(j.message || t("分享失败"), true); }
      catch (e) { toast(t("分享失败") + "：" + e.message, true); }
    } });
    if (items.length === 2) return toast(t("已保存：{name}", { name: file }));
    popMenu($("lin-export"), items);
  }

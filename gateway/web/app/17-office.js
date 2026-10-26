  // ── Office 文档 ──────────────────────────────────────────────────
  // docx：mammoth 转成网页（看文字、标题、表格、图片，不追求版式）；表格：SheetJS 读出来画成网格。
  // 两者都可以切到「原版式」—— 和 ppt / doc 等一样交给 LibreOffice 转成 PDF（网关缓存结果）。
  const scriptP = {};
  function loadScript(src) {
    return scriptP[src] || (scriptP[src] = new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok;
      s.onerror = () => { delete scriptP[src]; s.remove(); no(new Error(t("加载失败：{src}", { src }))); };
      document.head.appendChild(s);
    }));
  }
  async function vwFetchBuf() {
    const r = await fetch(fileUrl(VW.path));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }
  const vwStill = (p0) => VW.path === p0 && !viewerEl.classList.contains("hidden");
  const vwLoading = (msg) => { $("vw-body").innerHTML = `<div class="vw-empty">${msg || t("读取中…")}</div>`; };
  function vwFail(msg, withPdf) {
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${esc(msg)}</div>
      ${withPdf ? `<button class="btn ghost sm" data-a="aspdf">${t("用 LibreOffice 转成 PDF 看")}</button>` : ""}
      <button class="btn ghost sm" data-a="share">${shareIco()}${t("分享")}</button></div>`;
    $("vw-body").querySelector('[data-a="aspdf"]')?.addEventListener("click", () => vwOffice());
  }

  // 文档里的东西只留看得的：去掉脚本一类元素和事件属性，链接只留 http(s) / mailto / 页内，图片只留 data:
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,base,svg,math").forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll("*")) {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith("on") || n === "style" || n === "srcset" || n === "formaction") el.removeAttribute(a.name);
      }
      if (el.hasAttribute("href")) {
        const h = el.getAttribute("href").trim();
        if (/^(https?:|mailto:)/i.test(h)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
        else if (!h.startsWith("#")) el.removeAttribute("href");
      }
      if (el.hasAttribute("src") && !/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i.test(el.getAttribute("src"))) el.removeAttribute("src");
    }
    return doc.body.innerHTML;
  }

  async function vwDocx() {
    const p0 = VW.path;
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let r;
    try {
      await loadScript("/office/mammoth.browser.min.js");
      r = await window.mammoth.convertToHtml({ arrayBuffer: await vwFetchBuf() });
    } catch (e) {
      if (vwStill(p0)) vwFail(t("这个文档读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!vwStill(p0)) return;
    const html = cleanHtml(r.value || "");
    $("vw-body").innerHTML = `<div class="vw-doc"><article class="vw-docx bubble">${html || `<p class="dim">${t("（文档是空的）")}</p>`}</article></div>`;
    // 目录之类的页内链接：在查看器里滚过去，别去改页面地址
    $("vw-body").querySelector(".vw-docx").addEventListener("click", (e) => {
      const l = e.target.closest("a[href^=\"#\"]"); if (!l) return;
      e.preventDefault();
      const id = decodeURIComponent(l.getAttribute("href").slice(1));
      const to = id && [...$("vw-body").querySelectorAll("[id],a[name]")].find((n) => n.id === id || n.getAttribute("name") === id);
      if (to) to.scrollIntoView({ block: "start" });
    });
    const words = ($("vw-body").textContent || "").replace(/\s+/g, "").length;
    $("vw-info").textContent = `${fmtSize(VW.size)} · ${t("{n} 字", { n: words.toLocaleString() })}`;
  }

  const SHEET_MAX_R = 5000, SHEET_MAX_C = 200;
  async function vwSheet() {
    const p0 = VW.path;
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let wb;
    try {
      await loadScript("/office/xlsx.full.min.js");
      wb = window.XLSX.read(await vwFetchBuf(), { type: "array", cellStyles: false, cellNF: true });
    } catch (e) {
      if (vwStill(p0)) vwFail(t("这个表格读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!vwStill(p0)) return;
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
    const names = wb.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden));
    VW.wb = wb; VW.sheets = names.length ? names : wb.SheetNames;
    $("vw-body").innerHTML = `<div class="vw-sheet"><div class="vw-grid-wrap"></div>
      <div class="vw-cellbar tiny"></div>
      <div class="vw-tabs">${VW.sheets.map((n, i) => `<button class="vw-tab" data-i="${i}">${esc(n)}</button>`).join("")}</div></div>`;
    const box = $("vw-body").querySelector(".vw-sheet");
    box.querySelector(".vw-tabs").addEventListener("click", (e) => {
      const b = e.target.closest(".vw-tab"); if (b) vwSheetShow(Number(b.dataset.i));
    });
    box.querySelector(".vw-grid-wrap").addEventListener("click", (e) => {
      const td = e.target.closest("td[data-c]"); if (!td) return;
      box.querySelectorAll("td.sel").forEach((x) => x.classList.remove("sel"));
      td.classList.add("sel");
      const X = window.XLSX, ws = wb.Sheets[VW.sheets[VW.sheetI]];
      const addr = X.utils.encode_cell({ r: Number(td.parentNode.dataset.r), c: Number(td.dataset.c) });
      const cell = ws[addr];
      const val = sheetText(cell);
      box.querySelector(".vw-cellbar").textContent = `${addr}  ${val}${cell && cell.f ? `   =${cell.f}` : ""}`;
    });
    vwSheetShow(0);
  }
  // Excel 的默认日期格式（编号 14）各地显示不同，SheetJS 一律写成美式 m/d/yy —— 这种按年-月-日显示
  function sheetText(cell) {
    if (!cell) return "";
    const w = cell.w != null ? cell.w : String(cell.v ?? "");
    if (cell.t === "n" && cell.z && /^\d{1,2}\/\d{1,2}\/\d{2,4}( |$)/.test(w) && window.XLSX.SSF.is_date(cell.z)) {
      const d = window.XLSX.SSF.parse_date_code(cell.v), p = (n) => String(n).padStart(2, "0");
      if (!d) return w;
      const time = /[hs]/i.test(cell.z.replace(/"[^"]*"/g, ""));   // 格式里没有时分秒就只显示日期
      return `${d.y}-${p(d.m)}-${p(d.d)}${time ? ` ${p(d.H)}:${p(d.M)}${d.S ? ":" + p(d.S) : ""}` : ""}`;
    }
    return w;
  }
  function vwSheetShow(i) {
    const X = window.XLSX, wb = VW.wb, name = VW.sheets[i], ws = wb.Sheets[name];
    VW.sheetI = i;
    const box = $("vw-body").querySelector(".vw-sheet");
    box.querySelectorAll(".vw-tab").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
    box.querySelector(".vw-cellbar").textContent = "";
    const wrap = box.querySelector(".vw-grid-wrap");
    if (!ws || !ws["!ref"]) { wrap.innerHTML = `<div class="vw-empty">${t("（这张表是空的）")}</div>`; return; }
    const rg = X.utils.decode_range(ws["!ref"]);
    const r1 = Math.min(rg.e.r, rg.s.r + SHEET_MAX_R - 1), c1 = Math.min(rg.e.c, rg.s.c + SHEET_MAX_C - 1);
    // 合并单元格：左上角那格带 rowspan/colspan，被盖住的格子不画
    const span = new Map(), covered = new Set();
    for (const m of ws["!merges"] || []) {
      span.set(m.s.r + "," + m.s.c, [m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]);
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + "," + c);
    }
    const cols = ws["!cols"] || [], rows = ws["!rows"] || [];
    let h = `<table class="vw-grid"><colgroup><col class="rh">`;
    for (let c = rg.s.c; c <= c1; c++) {
      const w = cols[c] ? (cols[c].hidden ? 0 : cols[c].wpx || (cols[c].wch ? cols[c].wch * 7 + 5 : 0)) : 0;
      h += `<col style="width:${w ? Math.max(24, Math.min(400, Math.round(w))) : 80}px">`;
    }
    h += `</colgroup><thead><tr><th class="corner"></th>`;
    for (let c = rg.s.c; c <= c1; c++) h += `<th>${X.utils.encode_col(c)}</th>`;
    h += `</tr></thead><tbody>`;
    for (let r = rg.s.r; r <= r1; r++) {
      if (rows[r] && rows[r].hidden) continue;
      h += `<tr data-r="${r}"><th>${r + 1}</th>`;
      for (let c = rg.s.c; c <= c1; c++) {
        const k = r + "," + c;
        if (covered.has(k)) continue;
        const cell = ws[X.utils.encode_cell({ r, c })];
        const sp = span.get(k);
        const txt = sheetText(cell);
        const num = cell && (cell.t === "n" || cell.t === "d");
        h += `<td data-c="${c}"${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ""}${num ? ` class="n"` : cell && cell.t === "e" ? ` class="err"` : ""}>${esc(txt)}</td>`;
      }
      h += `</tr>`;
    }
    h += `</tbody></table>`;
    const cut = rg.e.r > r1 || rg.e.c > c1;
    if (cut) h += `<div class="vw-cut tiny">${t("表太大，只显示了前 {r} 行、{c} 列；完整内容请用「原版式」或下载后用别的应用看", { r: r1 - rg.s.r + 1, c: c1 - rg.s.c + 1 })}</div>`;
    wrap.innerHTML = h;
    wrap.scrollTop = 0; wrap.scrollLeft = 0;
    $("vw-info").textContent = `${fmtSize(VW.size)} · ${name} · ${X.utils.encode_range({ s: rg.s, e: rg.e })}`;
  }

  // ppt / doc / … 以及 docx、表格的「原版式」：网关用 LibreOffice 转成 PDF（第一次要等，之后读缓存）
  async function vwOffice() {
    const p0 = VW.path, back = VW.kind === "docx" || VW.kind === "sheet";
    closeViewerPdf();
    vwActs(back ? [[t("网页版式"), "native"]] : []);
    vwLoading(`<div>${t("正在用 LibreOffice 转成 PDF…")}</div><div class="tiny dim">${t("第一次打开会慢一些，转好的会缓存起来")}</div>`);
    let r;
    try {
      r = await api("/api/office/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: VW.path }) });
    } catch (e) { if (vwStill(p0)) vwFail(e.message, false); return; }
    if (!vwStill(p0)) return;
    if (r.missing) return vwOfficeMissing(r.can);
    if (!r.ok) return vwFail(r.message || t("转换失败"), false);
    return vwPdf(r.url, back ? [[t("网页版式"), "native"]] : []);
  }
  function vwOfficeMissing(can) {
    if (!can) return vwFail(t("这种文件要用 LibreOffice 转换后才能看，这里没有 LibreOffice。"), false);
    $("vw-body").innerHTML = `<div class="vw-empty">
      <div>${t("看这类文件要先装 LibreOffice（下载约 190 MB，装好约 830 MB）。装一次，以后 PPT、Word、Excel 都能直接看。")}</div>
      <button class="btn sm" data-a="lo-install">${t("安装 LibreOffice")}</button>
      <button class="btn ghost sm" data-a="share">${shareIco()}${t("分享")}</button></div>`;
    $("vw-body").querySelector('[data-a="lo-install"]').addEventListener("click", vwOfficeInstall);
    api("/api/office/info").then((j) => { if (j.install && j.install.running) vwOfficeInstall(); }).catch(() => {});
  }
  async function vwOfficeInstall() {
    const p0 = VW.path;
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${t("正在安装 LibreOffice…可以先去干别的，装好回来再打开。")}</div>
      <div class="tiny dim vw-lo-line"></div></div>`;
    let j;
    try { j = await api("/api/office/install", { method: "POST" }); } catch (e) { return vwFail(e.message, false); }
    while (!j.have && j.install && j.install.running) {
      if (!vwStill(p0)) return;
      const el = $("vw-body").querySelector(".vw-lo-line");
      if (el) el.textContent = j.install.line || "";
      await new Promise((ok) => setTimeout(ok, 1500));
      try { j = await api("/api/office/info"); } catch {}
    }
    if (!vwStill(p0)) return;
    if (j.have) { toast(t("LibreOffice 装好了")); return vwOffice(); }
    vwFail(t("LibreOffice 没装上：{msg}", { msg: (j.install && j.install.line) || "?" }), false);
    $("vw-body").querySelector(".vw-empty").insertAdjacentHTML("beforeend", `<button class="btn ghost sm" data-a="lo-retry">${t("重试")}</button>`);
    $("vw-body").querySelector('[data-a="lo-retry"]').addEventListener("click", vwOfficeInstall);
  }

  let pdfjsP = null;
  function loadPdfjs() {
    if (!pdfjsP) {
      // 旧 WebView（如 Chrome 104）缺 Promise.withResolvers 等，先补上；worker 走同样先补的入口
      pdfjsP = import("/pdfjs/compat.mjs").then(() => import("/pdfjs/pdf.min.mjs")).then((m) => {
        m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.compat.mjs";
        return m;
      }).catch((e) => { pdfjsP = null; throw e; });
    }
    return pdfjsP;
  }

  async function vwPdf(url, extra) {
    const p0 = VW.path;
    vwActs([["−", "zoom-"], ["+", "zoom+"]].concat(extra || []));
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let lib, doc;
    try {
      lib = await loadPdfjs();
      const task = lib.getDocument({
        url: url || fileUrl(VW.path), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/pdfjs/wasm/",
        isEvalSupported: false,
      });
      task.onPassword = (cb, reason) => {
        const pw = prompt(reason === 2 ? t("密码不对，再输一次：") : t("这个 PDF 有密码："));
        if (pw == null) task.destroy(); else cb(pw);
      };
      doc = await task.promise;
    } catch (e) {
      $("vw-body").innerHTML = `<div class="vw-empty">${t("PDF 打不开：{msg}", { msg: esc(e.message || String(e)) })}</div>`;
      return;
    }
    if (!vwStill(p0) || VW.pdf) { doc.loadingTask.destroy(); return; }
    VW.pdf = doc;
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    VW.pdfRatio = vp.height / vp.width;
    $("vw-body").innerHTML = `<div class="vw-pdf"><div class="vw-pages"></div></div><div class="vw-pageno tiny"></div>`;
    const pages = $("vw-body").querySelector(".vw-pages");
    for (let i = 1; i <= doc.numPages; i++) {
      const h = document.createElement("div");
      h.className = "vw-page";
      h.dataset.n = i;
      pages.appendChild(h);
    }
    const scroller = $("vw-body").querySelector(".vw-pdf");
    VW.pdfObs = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (en.isIntersecting) vwPdfRender(en.target);
        else vwPdfRelease(en.target);
      }
    }, { root: scroller, rootMargin: "1200px 0px" });
    vwPdfRelayout();
    scroller.addEventListener("scroll", vwPdfPageNo, { passive: true });
    vwPdfPageNo();
  }

  function vwPdfRelayout() {
    const scroller = $("vw-body").querySelector(".vw-pdf");
    if (!scroller || !VW.pdf) return;
    const w = Math.floor((scroller.clientWidth - 16) * VW.zoom);
    scroller.classList.toggle("wide", VW.zoom > 1);
    const keep = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    for (const h of scroller.querySelectorAll(".vw-page")) {
      const ratio = Number(h.dataset.ratio) || VW.pdfRatio;
      h.style.width = w + "px";
      h.style.height = Math.round(w * ratio) + "px";
      vwPdfRelease(h);
      VW.pdfObs.unobserve(h);
      VW.pdfObs.observe(h);
    }
    scroller.scrollTop = keep * scroller.scrollHeight;
  }

  async function vwPdfRender(h) {
    if (h.dataset.state) return;
    h.dataset.state = "busy";
    const doc = VW.pdf;
    try {
      const page = await doc.getPage(Number(h.dataset.n));
      const v1 = page.getViewport({ scale: 1 });
      const ratio = v1.height / v1.width;
      if (Math.abs(ratio - (Number(h.dataset.ratio) || VW.pdfRatio)) > 0.001) {
        h.dataset.ratio = ratio;
        h.style.height = Math.round(h.clientWidth * ratio) + "px";
      }
      // 画布像素封顶：放大很多倍时别分配几百 MB 的画布
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let scale = (h.clientWidth / v1.width) * dpr;
      const maxPx = 16e6;
      if (v1.width * v1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (v1.width * v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      h.replaceChildren(c);
      h._task = page.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: vp });
      await h._task.promise;
      if (VW.pdf !== doc) return;
      h.dataset.state = "done";
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") h.dataset.state = "";
    }
  }

  function vwPdfRelease(h) {
    try { h._task?.cancel(); } catch {}
    h._task = null;
    const c = h.querySelector("canvas");
    if (c) { c.width = c.height = 0; c.remove(); }
    h.dataset.state = "";
  }

  function vwPdfPageNo() {
    const sc = $("vw-body").querySelector(".vw-pdf"), el = $("vw-body").querySelector(".vw-pageno");
    if (!sc || !el || !VW.pdf) return;
    const mid = sc.scrollTop + sc.clientHeight / 3;
    let n = 1;
    for (const h of sc.querySelectorAll(".vw-page")) { if (h.offsetTop <= mid) n = Number(h.dataset.n); else break; }
    el.textContent = `${n} / ${VW.pdf.numPages}`;
  }

  function closeViewerPdf() {
    VW.pdfObs?.disconnect(); VW.pdfObs = null;
    if (VW.pdf) { try { VW.pdf.loadingTask.destroy(); } catch {} VW.pdf = null; }
  }

  function closeViewer() {
    if (VW.dirty && !confirm(t("有未保存的修改，丢弃？"))) return;
    if (VW.dirty) draftClear();
    VW.dirty = false;
    closeViewerPdf();
    vwDropEd();
    vwHtmlStop();
    MO.hide(viewerEl, MO.paneOut(), 170, () => { $("vw-body").innerHTML = ""; });   // 内容等滑出去了再清，别先白一下
    // 文件面板开着就刷新一下：大小 / 修改时间可能变了
    if (!filesEl.classList.contains("hidden") && state.fs.path) fsLoad(state.fs.path, { keepSel: true });
  }
  $("vw-close").addEventListener("click", closeViewer);
  window.addEventListener("resize", () => { if (VW.pdf) { clearTimeout(VW.rt); VW.rt = setTimeout(vwPdfRelayout, 200); } });


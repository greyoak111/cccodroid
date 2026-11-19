  // ── Office 文档 ──────────────────────────────────────────────────
  // docx：mammoth 转成网页（看文字、标题、表格、图片，不追求版式）；表格：SheetJS 读出来画成网格。
  // 两者都可以切到「原版式」—— 和 ppt / doc 等一样交给 LibreOffice 转成 PDF（网关缓存结果）。
  // 脚本加载用 01 段的 loadScript：这里以前另声明了一个同名的，把那边（带 css 参数）的盖掉了，
  // 对话里先出现公式时 KaTeX 的样式不加载（审查 #49 P1-1）
  // 文件读取仍封顶；xlsx 交给 Worker 解析，不能因移出主线程就放松内存预算。
  const VW_OFFICE_MAX = 32 * 1024 * 1024;
  async function vwFetchBuf(max, signal) {
    const path = VW.path, knownSize = VW.size;
    const tooBig = (size) => new Error(t("文件太大（{size}），不适合在应用里直接解析；可以用「原版式」转成 PDF 看，或下载后用别的应用打开。", { size: fmtSize(size) }));
    // 先按大小拦，别把 32MB 以上的文件整份读进内存再判：手机主线程可能直接卡死 / 内存不够（稳定性报告 FIND-024）。
    // 打开时一般已带 size；没有（0）就向网关补一次 stat。stat 失败按老路走，读回来那个判断还留着兜底
    if (max) {
      let size = knownSize;
      if (!size) { try { size = Number((await api("/api/file/stat?path=" + encodeURIComponent(path), { signal })).size) || 0; } catch (e) { if (signal?.aborted) throw e; } }
      if (size > max) throw tooBig(size);
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = await fetch(fileUrl(path), { signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    // 响应自己声明的大小也先看：Content-Length 超限就别读了（stat 之后文件可能刚被换过）（BUG-UIFS-006）
    if (max) {
      let cl = 0;
      try { cl = Number(r.headers && r.headers.get && r.headers.get("content-length")) || 0; } catch {}
      if (cl > max) { try { await r.body.cancel?.(); } catch {} throw tooBig(cl); }
    }
    // 流式读：累计过了上限就取消，不等 arrayBuffer 把整份拉进内存（BUG-UIFS-006）
    let b;
    if (max && r.body && typeof r.body.getReader === "function") {
      const reader = r.body.getReader(), chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.byteLength) continue;
          total += value.byteLength;
          if (total > max) { try { await reader.cancel(); } catch {} throw tooBig(total); }
          chunks.push(value);
        }
      } finally { try { reader.releaseLock(); } catch {} }
      const u = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { u.set(c, off); off += c.byteLength; }
      b = u.buffer;
    } else {
      b = await r.arrayBuffer();
    }
    if (max && b.byteLength > max) throw tooBig(b.byteLength);
    return b;
  }
  // 领一个号：同一文档里切版式（网页 ↔ 原版式）、换了文档、关了查看器，之前在途的读取 / 转换 / 安装回来都不许再写正文（审查 #48 04-F04、04-F05）
  const vwTake = () => { closeViewerSheet(); VW.mgen = (VW.mgen || 0) + 1; const g = VW.gen, m = VW.mgen; return () => VW.gen === g && VW.mgen === m && !viewerEl.classList.contains("hidden"); };
  const vwLoading = (msg) => { $("vw-body").innerHTML = `<div class="vw-empty">${msg || t("读取中…")}</div>`; };
  function vwFail(msg, withPdf) {
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${esc(msg)}</div>
      ${withPdf ? `<button class="btn ghost sm" data-a="aspdf">${t("用 LibreOffice 转成 PDF 看")}</button>` : ""}
      <button class="btn ghost sm" data-a="share">${shareIco()}${t("分享")}</button></div>`;
    $("vw-body").querySelector('[data-a="aspdf"]')?.addEventListener("click", () => vwOffice());
  }

  // 文档里的东西只留看得的。按白名单（审查 10-29 中4）：mammoth 只会产出下面这些标签和属性，别的标签拆掉外壳留文字、
  // 脚本一类连内容一起删，属性一律只认这几个。链接只留 http(s) / mailto / 页内，图片只留 data:
  const DOCX_TAGS = new Set("p h1 h2 h3 h4 h5 h6 strong b em i u s del sup sub a img ul ol li table thead tbody tfoot tr td th caption br hr blockquote pre code span div".split(" "));
  const DOCX_DROP = "script,style,iframe,frame,object,embed,link,meta,form,input,button,textarea,select,base,svg,math,template,noscript,video,audio,source,track,picture,canvas";
  const DOCX_ATTRS = new Set(["href", "src", "alt", "title", "id", "name", "colspan", "rowspan"]);
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll(DOCX_DROP).forEach((n) => n.remove());
    for (const el of [...doc.body.querySelectorAll("*")].reverse()) {   // 由里往外：拆外壳时里面的已经洗过
      if (!DOCX_TAGS.has(el.localName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (!DOCX_ATTRS.has(n)) el.removeAttribute(a.name);
        // id / name 加前缀：免得文档里的锚点名顶掉界面自己的元素或全局变量（审查 低1）；页内链接跟着改
        else if (n === "id" || n === "name") el.setAttribute(a.name, "dx-" + a.value);
      }
      if (el.hasAttribute("href")) {
        const h = el.getAttribute("href").trim();
        if (/^(https?:|mailto:)/i.test(h)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
        else if (h.startsWith("#") && h.length > 1) el.setAttribute("href", "#dx-" + h.slice(1));
        else if (!h.startsWith("#")) el.removeAttribute("href");
      }
      if (el.hasAttribute("src") && !/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i.test(el.getAttribute("src"))) el.removeAttribute("src");
    }
    return doc.body.innerHTML;
  }

  async function vwDocx() {
    const still = vwTake();
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let r;
    try {
      await loadScript("/office/mammoth.browser.min.js");
      if (!still()) return;
      const arrayBuffer = await vwFetchBuf(VW_OFFICE_MAX);
      if (!still()) return;
      r = await window.mammoth.convertToHtml({ arrayBuffer });
    } catch (e) {
      if (still()) vwFail(t("这个文档读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!still()) return;
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

  // zipExpandsTooMuch / SheetJS / 替格与合并处理均在 Worker；页面只收有界分页。
  function closeViewerSheet(expected) {
    const s = expected || VW.sheet;
    // 旧读取失效只停自己，不能把后来新文件的 Worker 和页状态一起清掉。
    if (VW.sheet === s) { VW.sheet = null; VW.sheetMore = null; VW.wb = VW.sheets = null; }
    if (s) s.stop();
  }
  function sheetSession() {
    const abort = new AbortController(), pending = new Map();
    let worker, session, observer, reason, seq = 0, initialTimer = 0, dead = false;
    const cancel = () => new DOMException("Aborted", "AbortError");
    const stop = (err = cancel()) => {
      if (dead) return;
      dead = true; reason = err; observer?.disconnect(); clearTimeout(initialTimer); initialTimer = 0; abort.abort(); worker?.terminate();
      if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
      const waiting = pending.size;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      if (!waiting && err.name !== "AbortError" && session && VW.sheet === session) vwSheetFail(session, err);
    };
    try { worker = new Worker("/office/sheet-worker.js"); }
    catch (e) { stop(e); throw e; }
    worker.onerror = (e) => { e.preventDefault?.(); stop(new Error(t("读取失败"))); };
    worker.onmessageerror = () => stop(new Error(t("读取失败")));
    worker.onmessage = ({ data }) => {
      const p = data && pending.get(data.id); if (!p || dead) return;
      clearTimeout(p.timer); pending.delete(data.id);
      if (data.error) {
        const e = new Error(data.error.code === "tooBig" ? t("这个表格文件内部展开后太大，不能安全打开。") : data.error.message || t("读取失败"));
        p.reject(e);
      } else p.resolve(data.value);
    };
    const ask = (op, args = {}, transfer = []) => new Promise((resolve, reject) => {
      if (dead) return reject(reason || cancel());
      if (op === "load") { clearTimeout(initialTimer); initialTimer = 0; }
      // 连续点表签只保留最新读请求的等待闭包；旧回执找不到序号就丢弃。
      if (op !== "load") for (const [id, p] of pending) if (p.op === op) { clearTimeout(p.timer); pending.delete(id); p.reject(cancel()); }
      const id = ++seq;
      const timer = setTimeout(() => stop(new Error(t("读取失败"))), 120000);
      pending.set(id, { op, resolve, reject, timer });
      try { worker.postMessage({ id, op, ...args }, transfer); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); stop(e); }
    });
    session = { ask, stop, signal: abort.signal, get dead() { return dead; }, pageGen: 0, cellGen: 0 };
    observer = new MutationObserver(() => { if (viewerEl.classList.contains("hidden")) closeViewerSheet(session); });
    observer.observe(viewerEl, { attributes: true, attributeFilter: ["class"] });
    initialTimer = setTimeout(() => stop(new Error(t("读取失败"))), 120000);   // stat / 下载无回包也要能退出
    return session;
  }
  async function vwSheet() {
    const still = vwTake();
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let s;
    try {
      s = sheetSession(); VW.sheet = s;
      const ab = await vwFetchBuf(VW_OFFICE_MAX, s.signal);
      if (!still() || VW.sheet !== s) return closeViewerSheet(s);
      const r = await s.ask("load", { buffer: ab }, [ab]);
      if (!still() || VW.sheet !== s) return closeViewerSheet(s);
      if (!r || !Array.isArray(r.names) || r.names.length > 1000 || r.names.some((n) => typeof n !== "string")) throw new Error(t("读取失败"));
      if (!r.names.length) { closeViewerSheet(); vwFail(t("（这张表是空的）"), true); return; }
      VW.sheets = r.names;
      $("vw-body").innerHTML = `<div class="vw-sheet"><div class="vw-grid-wrap"></div>
        <div class="vw-cellbar tiny"></div>
        <div class="vw-tabs">${VW.sheets.map((n, i) => `<button class="vw-tab" data-i="${i}">${esc(n)}</button>`).join("")}</div></div>`;
      const box = $("vw-body").querySelector(".vw-sheet");
      box.querySelector(".vw-tabs").addEventListener("click", (e) => {
        const b = e.target.closest(".vw-tab"); if (b) vwSheetShow(Number(b.dataset.i));
      });
      box.querySelector(".vw-grid-wrap").addEventListener("click", async (e) => {
        if (e.target.closest(".vw-more")) { VW.sheetMore?.(); return; }
        const td = e.target.closest("td[data-c]"); if (!td || VW.sheet !== s) return;
        box.querySelectorAll("td.sel").forEach((x) => x.classList.remove("sel")); td.classList.add("sel");
        const gen = ++s.cellGen, page = s.pageGen, i = VW.sheetI;
        try {
          const cell = await s.ask("cell", { sheet: i, addr: td.dataset.a });
          if (!still() || VW.sheet !== s) return closeViewerSheet(s);
          if (gen !== s.cellGen || page !== s.pageGen) return;
          box.querySelector(".vw-cellbar").textContent = `${cell.addr}  ${cell.text}${cell.formula ? `   =${cell.formula}` : ""}`;
        } catch (e) {
          if (!still() || VW.sheet !== s) closeViewerSheet(s);
          else if (e.name !== "AbortError" && gen === s.cellGen && page === s.pageGen) vwSheetFail(s, e);
        }
      });
      // 打开工作簿保存的活动表；Worker 给的活动索引不在范围内（隐藏/缺失已回落）就还是第一张（PR #232）
      const first = Number.isInteger(r.active) && r.active >= 0 && r.active < VW.sheets.length ? r.active : 0;
      await vwSheetShow(first);
    } catch (e) {
      if (s && (!still() || VW.sheet !== s)) closeViewerSheet(s);
      else if (still()) { closeViewerSheet(s); vwFail(t("这个表格读不出来：{msg}", { msg: e.message || String(e) }), true); }
    }
  }
  function vwSheetFail(s, e) {
    if (VW.sheet !== s) return;
    closeViewerSheet();
    vwFail(t("这个表格读不出来：{msg}", { msg: e.message || String(e) }), true);
  }
  async function vwSheetShow(i) {
    const s = VW.sheet, box = $("vw-body").querySelector(".vw-sheet");
    if (!s || !box || !VW.sheets || !Number.isInteger(i) || i < 0 || i >= VW.sheets.length) return;
    const gen = ++s.pageGen; ++s.cellGen;
    VW.sheetI = i; VW.sheetMore = null;
    const current = () => {
      if (VW.sheet !== s || viewerEl.classList.contains("hidden")) { closeViewerSheet(s); return false; }
      return s.pageGen === gen;
    };
    box.querySelectorAll(".vw-tab").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
    box.querySelector(".vw-cellbar").textContent = "";
    const wrap = box.querySelector(".vw-grid-wrap");
    wrap.innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let page, busy = false;
    const moreLabel = () => t("再显示 {n} 行（共 {total} 行）", { n: Math.min(page.step, page.remaining), total: page.total });
    const moreHtml = () => page.done ? "" : `<button type="button" class="btn ghost sm vw-more">${esc(moreLabel())}</button>`;
    const load = async (first) => {
      if (busy || !current()) return;
      busy = true;
      const more = wrap.querySelector(".vw-more"); if (more) more.disabled = true;
      try {
        const r = await s.ask("page", { sheet: i, from: first ? null : page.next });
        if (!current()) return;
        if (r.empty || r.badRange) {
          wrap.innerHTML = `<div class="vw-empty">${r.empty ? t("（这张表是空的）") : t("这张表的范围信息坏了，读不出来")}</div>`;
          return;
        }
        if (typeof r.html !== "string" || r.html.length > 256 * 1024 || typeof r.header !== "string" || r.header.length > 32768 || !Number.isInteger(r.next) || (!first && r.next <= page.next && !r.done)) throw new Error(t("读取失败"));
        page = r;
        if (first) {
          wrap.innerHTML = `<table class="vw-grid">${r.header}<tbody>${r.html}</tbody></table>${moreHtml()}${r.cut ? `<div class="vw-cut tiny">${t("表太大，只显示了前 {r} 行、{c} 列；完整内容请用「原版式」或下载后用别的应用看", { r: r.rows, c: r.cols })}</div>` : ""}`;
          wrap.scrollTop = 0; wrap.scrollLeft = 0;
          $("vw-info").textContent = `${fmtSize(VW.size)} · ${VW.sheets[i]} · ${r.range}`;
        } else {
          wrap.querySelector(".vw-grid tbody").insertAdjacentHTML("beforeend", r.html);
          if (r.done) more?.remove(); else if (more) { more.textContent = moreLabel(); more.disabled = false; }
        }
        VW.sheetMore = r.done ? null : () => load(false);
      } catch (e) { if (e.name !== "AbortError" && current()) vwSheetFail(s, e); }
      finally { busy = false; }
    };
    await load(true);
  }

  // ppt / doc / … 以及 docx、表格的「原版式」：网关用 LibreOffice 转成 PDF（第一次要等，之后读缓存）
  async function vwOffice() {
    const still = vwTake(), back = VW.kind === "docx" || VW.kind === "sheet";
    closeViewerPdf();
    vwActs(back ? [[t("网页版式"), "native"]] : []);
    vwLoading(`<div>${t("正在用 LibreOffice 转成 PDF…")}</div><div class="tiny dim">${t("第一次打开会慢一些，转好的会缓存起来")}</div>`);
    let r;
    try {
      r = await api("/api/office/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: VW.path }) });
    } catch (e) { if (still()) vwFail(e.message, false); return; }
    if (!still()) return;
    if (r.missing) return vwOfficeMissing(r.can, still);
    if (!r.ok) return vwFail(r.message || t("转换失败"), false);
    return vwPdf(r.url, back ? [[t("网页版式"), "native"]] : []);
  }
  function vwOfficeMissing(can, still) {
    if (!can) return vwFail(t("这种文件要用 LibreOffice 转换后才能看，这里没有 LibreOffice。"), false);
    $("vw-body").innerHTML = `<div class="vw-empty">
      <div>${t("看这类文件要先装 LibreOffice（下载约 190 MB，装好约 830 MB）。装一次，以后 PPT、Word、Excel 都能直接看。")}</div>
      <button class="btn sm" data-a="lo-install">${t("安装 LibreOffice")}</button>
      <button class="btn ghost sm" data-a="share">${shareIco()}${t("分享")}</button></div>`;
    $("vw-body").querySelector('[data-a="lo-install"]').addEventListener("click", vwOfficeInstall);
    api("/api/office/info").then((j) => { if (still() && j.install && j.install.running) vwOfficeInstall(); }).catch(() => {});
  }
  async function vwOfficeInstall() {
    const still = vwTake();
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${t("正在安装 LibreOffice…可以先去干别的，装好回来再打开。")}</div>
      <div class="tiny dim vw-lo-line"></div></div>`;
    let j;
    try { j = await api("/api/office/install", { method: "POST" }); } catch (e) { return still() && vwFail(e.message, false); }
    while (!j.have && j.install && j.install.running) {
      if (!still()) return;
      const el = $("vw-body").querySelector(".vw-lo-line");
      if (el) el.textContent = j.install.line || "";
      await new Promise((ok) => setTimeout(ok, 1500));
      if (!still()) return;
      try { j = await api("/api/office/info"); } catch {}
    }
    if (!still()) return;
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
    const still = vwTake(), src = url || fileUrl(VW.path);
    closeViewerPdf();
    vwActs([["−", "zoom-"], ["+", "zoom+"]].concat(extra || [], !url ? [[t("PDF 工具箱"), "pdftools"]] : []));
    vwLoading();
    let doc, p1;
    try {
      const lib = await loadPdfjs();
      if (!still()) return;
      // 在等待首个回执之前就登记 loading task：下载未完成时也能在离开后 cancel。
      const task = VW.pdfTask = lib.getDocument({
        url: src, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/pdfjs/wasm/",
        isEvalSupported: false,
        // 图片像素封顶：PDF 里写一张 12000×12000 的图就会被全尺寸解码，渲染进程一下涨上 GB（199-A-01）
        maxImageSize: 16e6,
      });
      task.onPassword = (cb, reason) => {
        if (!still() || VW.pdfTask !== task) return;
        const pw = prompt(reason === 2 ? t("密码不对，再输一次：") : t("这个 PDF 有密码："));
        if (still() && VW.pdfTask === task) cb(pw == null ? new Error(t("已取消")) : pw);
      };
      doc = await task.promise;
      if (!still()) return;
      p1 = await doc.getPage(1);   // 坏页树或空文档也走统一的失败分支
    } catch (e) {
      if (still()) {
        closeViewerPdf();
        $("vw-body").innerHTML = `<div class="vw-empty">${t("PDF 打不开：{msg}", { msg: esc(e.message || String(e)) })}</div>`;
      }
      return;
    }
    if (!still()) return;
    VW.pdf = doc;
    const vp = p1.getViewport({ scale: 1 });
    VW.pdfRatio = vp.height / vp.width;
    $("vw-body").innerHTML = `<div class="vw-pdf" style="position:relative"><div class="vw-pages"></div></div><div class="vw-pageno tiny"></div>`;
    const scroller = $("vw-body").querySelector(".vw-pdf"), pages = scroller.firstElementChild;
    const layout = VW.pdfLayout = { scroller, rows: [], label: $("vw-body").querySelector(".vw-pageno"), width: 0 };
    // 页数封顶：每页一个占位节点，几万页的 PDF（页数也能伪造）会把界面卡死（11-04 报告 三）
    const PDF_MAX_PAGES = 3000, np = Math.min(doc.numPages, PDF_MAX_PAGES);
    for (let i = 1; i <= np; i++) {
      const h = document.createElement("div");
      h.className = "vw-page";
      h.dataset.n = i;
      layout.rows.push(h);
      pages.appendChild(h);
    }
    if (doc.numPages > np) pages.insertAdjacentHTML("beforeend", `<div class="tiny muted" style="text-align:center;padding:12px">${esc(t("还有 {n} 项", { n: doc.numPages - np }))}</div>`);
    layout.observer = new IntersectionObserver((ents) => {
      if (VW.pdfLayout !== layout) return;
      for (const en of ents) {
        if (en.isIntersecting) vwPdfRender(en.target);
        else vwPdfRelease(en.target);
      }
    }, { root: scroller, rootMargin: "1200px 0px" });
    scroller.addEventListener("scroll", vwPdfPageNo, { passive: true });
    // 分隔条拖动也会改变窗格宽度，不一定有 window.resize。
    layout.resize = new ResizeObserver(() => {
      if (VW.pdfLayout !== layout) return;
      vwPdfPageNo();
      clearTimeout(layout.timer);
      if (layout.width !== vwPdfWidth(scroller)) layout.timer = setTimeout(vwPdfRelayout, 150);
    });
    layout.resize.observe(scroller);
    vwPdfRelayout();
  }

  const vwPdfWidth = (scroller) => Math.max(1, Math.floor((scroller.clientWidth - 16) * VW.zoom));
  function vwPdfRelayout() {
    const layout = VW.pdfLayout;
    if (!layout) return;
    const { scroller, rows, observer } = layout, w = vwPdfWidth(scroller);
    scroller.classList.toggle("wide", VW.zoom > 1);
    if (layout.width === w) return;
    layout.width = w;
    const keep = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    for (const h of rows) {
      const ratio = Number(h.dataset.ratio) || VW.pdfRatio;
      h.style.width = w + "px";
      h.style.height = Math.round(w * ratio) + "px";
      if (h.dataset.state) vwPdfRelease(h);
      observer.unobserve(h);
      observer.observe(h);
    }
    scroller.scrollTop = keep * scroller.scrollHeight;
    vwPdfPageNo();
  }

  async function vwPdfRender(h) {
    if (h.dataset.state) return;
    h.dataset.state = "busy";
    const doc = VW.pdf, gen = h._gen || 0;
    try {
      const page = await doc.getPage(Number(h.dataset.n));
      // 等页面解析的工夫里这页已经离屏 / 重新排版被释放了：别再建画布，不然离屏的画布一直留着（#134）
      if (VW.pdf !== doc || (h._gen || 0) !== gen) return;
      const v1 = page.getViewport({ scale: 1 });
      const ratio = v1.height / v1.width;
      if (ratio !== (Number(h.dataset.ratio) || VW.pdfRatio)) {
        h.dataset.ratio = ratio;
        const layout = VW.pdfLayout;
        h.style.height = Math.round(layout.width * ratio) + "px";
        if (!layout.frame) layout.frame = requestAnimationFrame(() => {
          layout.frame = 0;
          if (VW.pdfLayout === layout) vwPdfPageNo();
        });
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
      // 画完到这里之间这页被释放了（画布已拿走）：别记成 done，不然回到视野里也不再画，一直空白（11-04 报告 三）
      if (VW.pdf !== doc || (h._gen || 0) !== gen) return;
      h.dataset.state = "done";
    } catch (e) {
      if (e?.name === "RenderingCancelledException") return;
      // 换文档 / 这页已被释放：别往别人的页里画错误
      if (VW.pdf !== doc || (h._gen || 0) !== gen) return;
      // 以前这里把状态一清就完了：页面上是一块白，没有提示也没有重试（195-C.12）
      h.dataset.state = "error";
      h.replaceChildren();
      const box = document.createElement("div");
      box.className = "vw-empty";
      const msg = document.createElement("div");
      msg.textContent = t("这一页没画出来");
      const btn = document.createElement("button");
      btn.className = "btn ghost sm";
      btn.textContent = t("重试");
      btn.addEventListener("click", () => { h.dataset.state = ""; h.replaceChildren(); vwPdfRender(h); });
      box.append(msg, btn);
      h.appendChild(box);
    }
  }

  function vwPdfRelease(h) {
    h._gen = (h._gen || 0) + 1;   // 在途的 vwPdfRender 据此作废
    try { h._task?.cancel(); } catch {}
    h._task = null;
    const c = h.querySelector("canvas");
    if (c) { c.width = c.height = 0; c.remove(); }
    h.dataset.state = "";
  }

  function vwPdfPageNo() {
    const layout = VW.pdfLayout;
    if (!layout) return;
    const { scroller, rows, label } = layout;
    const y = scroller.scrollTop + scroller.clientHeight / 3;
    // 以相对滚动容器的真实位置二分：页高、旋转、缩放和间距都已经包含在 offsetTop 中。
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (rows[m].offsetTop <= y) lo = m + 1; else hi = m;
    }
    const n = Math.max(1, lo);
    if (layout.number !== n) { layout.number = n; label.textContent = `${n} / ${VW.pdf.numPages}`; }
  }

  function closeViewerPdf() {
    const { pdfLayout: layout, pdfTask: task } = VW;
    VW.pdf = VW.pdfLayout = VW.pdfTask = null;
    if (layout) {
      layout.observer.disconnect(); layout.resize.disconnect();
      clearTimeout(layout.timer); cancelAnimationFrame(layout.frame);
      layout.scroller.removeEventListener("scroll", vwPdfPageNo);
      for (const h of layout.rows) if (h.dataset.state) vwPdfRelease(h);
    }
    if (task) {
      task.onPassword = null;
      task.destroy().catch(() => {});
    }
  }

  function closeViewer() {
    if (VW.closing || viewerEl.classList.contains("hidden") || (VW.dirty && !confirm(t("有未保存的修改，丢弃？")))) return;
    if (VW.dirty) draftClear();
    const origin = VW.filesOrigin;
    VW.filesOrigin = null;
    VW.dirty = false; VW.closing = true;
    VW.gen = (VW.gen || 0) + 1;    // 关了：还在途的读取 / 转换回来也别再往正文里写
    closeViewerSheet();
    closeViewerPdf();
    vwMdStop();          // 长 Markdown 的分段 observer：以前要等下一次预览才断（审查 #49 P3-7）
    vwDropEd();
    gutStop();           // 行号栏的 ResizeObserver 与量过的行文本：关了查看器还挂在页面上（FIND-026）
    clearTimeout(VW.wt);
    vwHtmlStop();
    stopPaneMedia($("vw-body"));
    VW.text = ""; VW.wb = VW.sheets = null; VW.arc = null;   // 大文本、工作簿、压缩包会话别跟着查看器一直挂在内存里（#56）
    MO.hide(viewerEl, MO.paneOut(), 170, () => { $("vw-body").innerHTML = ""; });   // 内容等滑出去了再清，别先白一下
    fsViewerChanged(origin, false);
  }
  $("vw-close").addEventListener("click", closeViewer);


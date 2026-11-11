  // ── Office 文档 ──────────────────────────────────────────────────
  // docx：mammoth 转成网页（看文字、标题、表格、图片，不追求版式）；表格：SheetJS 读出来画成网格。
  // 两者都可以切到「原版式」—— 和 ppt / doc 等一样交给 LibreOffice 转成 PDF（网关缓存结果）。
  // 脚本加载用 01 段的 loadScript：这里以前另声明了一个同名的，把那边（带 css 参数）的盖掉了，
  // 对话里先出现公式时 KaTeX 的样式不加载（审查 #49 P1-1）
  // docx / xlsx 是整份读进主线程解析的：超过这个大小就别硬来，改用 LibreOffice 或下载（195-C.3）
  const VW_OFFICE_MAX = 32 * 1024 * 1024;
  async function vwFetchBuf(max) {
    // 先按大小拦，别把 32MB 以上的文件整份读进内存再判：手机主线程可能直接卡死 / 内存不够（稳定性报告 FIND-024）。
    // 打开时一般已带 size；没有（0）就向网关补一次 stat。stat 失败按老路走，读回来那个判断还留着兜底
    if (max) {
      let size = VW.size;
      if (!size) { try { size = Number((await api("/api/file/stat?path=" + encodeURIComponent(VW.path))).size) || 0; } catch {} }
      if (size > max) throw new Error(t("文件太大（{size}），不适合在应用里直接解析；可以用「原版式」转成 PDF 看，或下载后用别的应用打开。", { size: fmtSize(size) }));
    }
    const r = await fetch(fileUrl(VW.path));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.arrayBuffer();
    if (max && b.byteLength > max) {
      throw new Error(t("文件太大（{size}），不适合在应用里直接解析；可以用「原版式」转成 PDF 看，或下载后用别的应用打开。", { size: fmtSize(b.byteLength) }));
    }
    return b;
  }
  // 领一个号：同一文档里切版式（网页 ↔ 原版式）、换了文档、关了查看器，之前在途的读取 / 转换 / 安装回来都不许再写正文（审查 #48 04-F04、04-F05）
  const vwTake = () => { VW.mgen = (VW.mgen || 0) + 1; const g = VW.gen, m = VW.mgen; return () => VW.gen === g && VW.mgen === m && !viewerEl.classList.contains("hidden"); };
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
      r = await window.mammoth.convertToHtml({ arrayBuffer: await vwFetchBuf(VW_OFFICE_MAX) });
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

  const SHEET_MAX_R = 5000, SHEET_MAX_C = 200;
  // 行、列各封顶还不够：两格隔得远（A1 和 CV1000）就是十万个空格子。按总格数分段画，余下的点「再显示」续上（#73）
  const SHEET_CELLS = 20000;
  // xlsx 是 ZIP：先扫中央目录，声明解压后的大小有上限，挡住“几十 KB 解出几百 MB”的压缩炸弹（199-A-02）。
  // SheetJS 本身没有解压 / 共享字符串上限，只能在这之前拦。返回 true = 不要交给 SheetJS
  function zipExpandsTooMuch(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 22 || b[0] !== 0x50 || b[1] !== 0x4b) return false;   // 不是 ZIP（老 .xls 等）：交给 SheetJS 按原格式读
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return true;                                          // 结构都找不全：别硬解
    const dv = new DataView(buf);
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true), total = 0;
    for (let n = 0; n < count; n++) {
      if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) return true;
      const usize = dv.getUint32(off + 24, true);
      if (usize === 0xffffffff) return true;                            // ZIP64：肯定超过这里的上限
      total += usize;
      if (usize > 128 * 1024 * 1024 || total > 256 * 1024 * 1024) return true;
      off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
    }
    return false;
  }
  async function vwSheet() {
    const still = vwTake();
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let wb;
    try {
      await loadScript("/office/xlsx.full.min.js");
      const ab = await vwFetchBuf(VW_OFFICE_MAX);
      if (zipExpandsTooMuch(ab)) throw new Error(t("这个表格文件内部展开后太大，不能安全打开。"));
      wb = window.XLSX.read(ab, { type: "array", cellStyles: true, cellNF: true });   // cellStyles 才读得出隐藏行列和列宽（审查 C-006）
    } catch (e) {
      if (still()) vwFail(t("这个表格读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!still()) return;
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
      if (e.target.closest(".vw-more")) { VW.sheetMore && VW.sheetMore(); return; }
      const td = e.target.closest("td[data-c]"); if (!td) return;
      box.querySelectorAll("td.sel").forEach((x) => x.classList.remove("sel"));
      td.classList.add("sel");
      const X = window.XLSX, ws = wb.Sheets[VW.sheets[VW.sheetI]];
      const addr = td.dataset.a || X.utils.encode_cell({ r: Number(td.parentNode.dataset.r), c: Number(td.dataset.c) });
      const cell = ws[addr];
      const val = sheetText(cell, wb);
      box.querySelector(".vw-cellbar").textContent = `${addr}  ${val}${cell && cell.f ? `   =${cell.f}` : ""}`;
    });
    vwSheetShow(0);
  }
  // Excel 的默认日期格式（编号 14）各地显示不同，SheetJS 一律写成美式 m/d/yy —— 这种按年-月-日显示
  // wb：认工作簿的日期系统。1904 系统（Mac 版 Excel 的老文件）同一个数差 1462 天（#106 07-005）；
  // 注意 parse_date_code 的第三个参数是回历开关，日期系统要放在第二个参数的 date1904 里
  function sheetText(cell, wb) {
    if (!cell) return "";
    const w = cell.w != null ? cell.w : String(cell.v ?? "");
    if (cell.t === "n" && cell.z && /^\d{1,2}\/\d{1,2}\/\d{2,4}( |$)/.test(w) && window.XLSX.SSF.is_date(cell.z)) {
      const d = window.XLSX.SSF.parse_date_code(cell.v, wb?.Workbook?.WBProps?.date1904 ? { date1904: true } : undefined), p = (n) => String(n).padStart(2, "0");
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
    // 畸形文件的 !ref 可能让 decode_range 抛错：以前整个切换停在旧图 / 白屏（196 前端注入域）
    let rg;
    try { rg = X.utils.decode_range(ws["!ref"]); }
    catch { wrap.innerHTML = `<div class="vw-empty">${t("这张表的范围信息坏了，读不出来")}</div>`; return; }
    const r1 = Math.min(rg.e.r, rg.s.r + SHEET_MAX_R - 1), c1 = Math.min(rg.e.c, rg.s.c + SHEET_MAX_C - 1);
    // 合并单元格：左上角那格带 rowspan/colspan，被盖住的格子不画
    // 只处理落在显示窗口里的部分：畸形文件可以写一个盖住 A1:XFD1048576 的合并，或者成千上万个互相重叠的大合并，
    // 全量展开会把界面卡死。合并裁到窗口内，累计展开的格数不超过窗口格数的两倍，超了后面的合并按普通格子画
    const cols = ws["!cols"] || [], rows = ws["!rows"] || [];
    const hid = (c) => cols[c] && cols[c].hidden;    // 隐藏的列和行一样不画，别当普通格子露出来
    const hidR = (r) => rows[r] && rows[r].hidden;
    const W = c1 - rg.s.c + 1, cov = new Uint8Array((r1 - rg.s.r + 1) * W), span = new Map(), src = new Map();
    const covered = (r, c) => cov[(r - rg.s.r) * W + c - rg.s.c] === 1;
    let budget = 2 * cov.length, n = 0;
    for (const m of ws["!merges"] || []) {
      if (++n > 20000) break;
      if (!m || !m.s || !m.e || m.s.r > r1 || m.s.c > c1 || m.s.r < rg.s.r || m.s.c < rg.s.c || m.e.r < m.s.r || m.e.c < m.s.c) continue;
      const er = Math.min(m.e.r, r1), ec = Math.min(m.e.c, c1), k0 = m.s.r + "," + m.s.c;
      if (span.has(k0) || covered(m.s.r, m.s.c)) continue;      // 和前面的合并撞了左上角，别叠出错位的表
      const area = (er - m.s.r + 1) * (ec - m.s.c + 1);
      if ((budget -= area) < 0) break;
      for (let r = m.s.r; r <= er; r++) cov.fill(1, (r - rg.s.r) * W + m.s.c - rg.s.c, (r - rg.s.r) * W + ec - rg.s.c + 1);
      // 跨度只数没隐藏的行列；左上角那行 / 列被隐藏时，由第一个看得见的格子来画，内容仍取左上角（审查 #52 C-006）
      let ar = -1, ac = -1, nr = 0, nc = 0;
      for (let r = m.s.r; r <= er; r++) if (!hidR(r)) { if (ar < 0) ar = r; nr++; }
      for (let c = m.s.c; c <= ec; c++) if (!hid(c)) { if (ac < 0) ac = c; nc++; }
      if (!nr || !nc) continue;                         // 整块都藏起来了：盖住就行
      const ka = ar + "," + ac;
      span.set(ka, [nr, nc]);
      if (ka !== k0) src.set(ka, m.s);
      cov[(ar - rg.s.r) * W + ac - rg.s.c] = 2;          // 锚点自己要画
    }
    let h = `<table class="vw-grid"><colgroup><col class="rh">`;
    for (let c = rg.s.c; c <= c1; c++) {
      if (hid(c)) continue;
      const w = cols[c] ? cols[c].wpx || (cols[c].wch ? cols[c].wch * 7 + 5 : 0) : 0;
      h += `<col style="width:${w ? Math.max(24, Math.min(400, Math.round(w))) : 80}px">`;
    }
    h += `</colgroup><thead><tr><th class="corner"></th>`;
    for (let c = rg.s.c; c <= c1; c++) if (!hid(c)) h += `<th>${X.utils.encode_col(c)}</th>`;
    h += `</tr></thead><tbody>`;
    const rowsHtml = (from, to) => {
    let h = "";
    for (let r = from; r <= to; r++) {
      if (hidR(r)) continue;
      h += `<tr data-r="${r}"><th>${r + 1}</th>`;
      for (let c = rg.s.c; c <= c1; c++) {
        const k = r + "," + c;
        if (covered(r, c) || hid(c)) continue;
        const cell = ws[X.utils.encode_cell(src.get(k) || { r, c })];
        const sp = span.get(k);
        const txt = sheetText(cell, wb);
        const num = cell && (cell.t === "n" || cell.t === "d");
        h += `<td data-c="${c}"${src.has(k) ? ` data-a="${X.utils.encode_cell(src.get(k))}"` : ""}${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ""}${num ? ` class="n"` : cell && cell.t === "e" ? ` class="err"` : ""}>${esc(txt)}</td>`;
      }
      h += `</tr>`;
    }
    return h;
    };
    // 合并的 rowspan 跨段也没事：续上的行插进同一个 tbody，被盖住的格子本来就不画
    let visC = 0; for (let c = rg.s.c; c <= c1; c++) if (!hid(c)) visC++;
    const step = Math.max(50, Math.floor(SHEET_CELLS / Math.max(1, visC)));
    let done = Math.min(r1, rg.s.r + step - 1);
    h += rowsHtml(rg.s.r, done);
    h += `</tbody></table>`;
    const moreLabel = () => t("再显示 {n} 行（共 {total} 行）", { n: Math.min(step, r1 - done), total: r1 - rg.s.r + 1 });
    if (done < r1) h += `<button type="button" class="btn ghost sm vw-more">${esc(moreLabel())}</button>`;
    const cut = rg.e.r > r1 || rg.e.c > c1;
    if (cut) h += `<div class="vw-cut tiny">${t("表太大，只显示了前 {r} 行、{c} 列；完整内容请用「原版式」或下载后用别的应用看", { r: r1 - rg.s.r + 1, c: c1 - rg.s.c + 1 })}</div>`;
    wrap.innerHTML = h;
    wrap.scrollTop = 0; wrap.scrollLeft = 0;
    VW.sheetMore = () => {
      if (VW.sheetI !== i || done >= r1) return;
      const to = Math.min(r1, done + step);
      wrap.querySelector(".vw-grid tbody").insertAdjacentHTML("beforeend", rowsHtml(done + 1, to));
      done = to;
      const more = wrap.querySelector(".vw-more");
      if (done >= r1) more?.remove(); else if (more) more.textContent = moreLabel();
    };
    $("vw-info").textContent = `${fmtSize(VW.size)} · ${name} · ${X.utils.encode_range({ s: rg.s, e: rg.e })}`;
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
    const still = vwTake();
    vwActs([["−", "zoom-"], ["+", "zoom+"]].concat(extra || []));
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let lib, doc;
    try {
      lib = await loadPdfjs();
      const task = lib.getDocument({
        url: url || fileUrl(VW.path), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/pdfjs/wasm/",
        isEvalSupported: false,
        // 图片像素封顶：PDF 里写一张 12000×12000 的图就会被全尺寸解码，渲染进程一下涨上 GB（199-A-01）
        maxImageSize: 16e6,
      });
      task.onPassword = (cb, reason) => {
        const pw = prompt(reason === 2 ? t("密码不对，再输一次：") : t("这个 PDF 有密码："));
        if (pw == null) task.destroy(); else cb(pw);
      };
      doc = await task.promise;
    } catch (e) {
      if (still()) $("vw-body").innerHTML = `<div class="vw-empty">${t("PDF 打不开：{msg}", { msg: esc(e.message || String(e)) })}</div>`;
      return;
    }
    if (!still() || VW.pdf) { doc.loadingTask.destroy(); return; }
    VW.pdf = doc;
    let p1;
    try { p1 = await doc.getPage(1); }
    catch (e) {
      // getPage(1) 也可能被拒（页树损坏、/Count 0）；以前在 try 外，会让查看器永远停在「读取中…」
      if (still()) $("vw-body").innerHTML = `<div class="vw-empty">${t("PDF 打不开：{msg}", { msg: esc(e.message || String(e)) })}</div>`;
      return;
    }
    if (!still()) return;
    const vp = p1.getViewport({ scale: 1 });
    VW.pdfRatio = vp.height / vp.width;
    $("vw-body").innerHTML = `<div class="vw-pdf"><div class="vw-pages"></div></div><div class="vw-pageno tiny"></div>`;
    const pages = $("vw-body").querySelector(".vw-pages");
    // 页数封顶：每页一个占位节点，几万页的 PDF（页数也能伪造）会把界面卡死（11-04 报告 三）
    const PDF_MAX_PAGES = 3000, np = Math.min(doc.numPages, PDF_MAX_PAGES);
    for (let i = 1; i <= np; i++) {
      const h = document.createElement("div");
      h.className = "vw-page";
      h.dataset.n = i;
      pages.appendChild(h);
    }
    if (doc.numPages > np) pages.insertAdjacentHTML("beforeend", `<div class="tiny muted" style="text-align:center;padding:12px">${esc(t("还有 {n} 项", { n: doc.numPages - np }))}</div>`);
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
    const doc = VW.pdf, gen = h._gen || 0;
    try {
      const page = await doc.getPage(Number(h.dataset.n));
      // 等页面解析的工夫里这页已经离屏 / 重新排版被释放了：别再建画布，不然离屏的画布一直留着（#134）
      if (VW.pdf !== doc || (h._gen || 0) !== gen) return;
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
    VW.gen = (VW.gen || 0) + 1;    // 关了：还在途的读取 / 转换回来也别再往正文里写
    closeViewerPdf();
    vwMdStop();          // 长 Markdown 的分段 observer：以前要等下一次预览才断（审查 #49 P3-7）
    vwDropEd();
    vwHtmlStop();
    VW.text = ""; VW.wb = VW.sheets = null;   // 大文本、工作簿别跟着查看器一直挂在内存里（#56）
    MO.hide(viewerEl, MO.paneOut(), 170, () => { $("vw-body").innerHTML = ""; });   // 内容等滑出去了再清，别先白一下
    // 文件面板开着就刷新一下：大小 / 修改时间可能变了
    // 正在看压缩包：刷新包内这一层，别用 fsLoad（它会清掉 state.fs.arc，把人踢出压缩包）
    if (!filesEl.classList.contains("hidden")) {
      if (state.fs.arc) arcLoad(state.fs.arc.dir, { keepSel: true });
      else if (state.fs.path) fsLoad(state.fs.path, { keepSel: true, keepQ: true });
    }
  }
  $("vw-close").addEventListener("click", closeViewer);
  window.addEventListener("resize", () => { if (VW.pdf) { clearTimeout(VW.rt); VW.rt = setTimeout(vwPdfRelayout, 200); } });


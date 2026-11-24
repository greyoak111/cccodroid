  // PDF 工具箱沿用文件面板、查看器和分享，不经过聊天，也不消耗模型额度。
  const PT = { files: [], job: null, el: null, importing: false, starting: false, info: null, timer: 0, form: null, errs: 0 };
  const PT_OPS = () => [["merge", t("合并 PDF")], ["extract", t("提取页面")], ["split", t("拆成单页")], ["rotate", t("旋转页面")], ["compress", t("压缩 PDF")], ["images", t("PDF 转图片")]];
  const pdfPost = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pdfBusy = () => PT.starting || PT.importing || PT.job?.state === "running";
  function pdfError(code) {
    if (code === "pages") return t("页码不正确，请使用 1-3,5 这样的格式，并检查总页数。");
    if (code === "files") return t("一次最多合并 20 份 PDF，其他操作只选一份。");
    if (code === "input-limit") return t("请选择 PDF，最多 20 份、合计 256 MB。");
    if (code === "page-limit") return t("PDF 总页数不能超过 1000 页。");
    if (code === "image-limit") return t("每次最多转 100 页，图片长边最多 2048 像素。");
    if (code === "not-pdf" || code === "tool-failed") return t("PDF 无法处理，请确认文件未损坏且没有密码。");
    if (code === "timeout") return t("处理超时，请减少页数后重试。");
    if (code === "busy") return t("已有 PDF 任务正在处理，请稍后再试。");
    if (code === "missing-tools") return t("先安装 PDF 工具箱组件，再重新打开工具箱。");
    if (code === "destination") return t("请填写可写位置下尚不存在的输出文件夹。");
    if (code === "output-limit") return t("结果超过 512 MB，请减少页数或分辨率。");
    if (code === "file-unavailable" || code === "file-changed") return t("读取失败");
    if (code === "destination-exists") return t("已经有同名的文件或文件夹");
    if (code === "ENOSPC") return t("存储空间不够了");
    return t("PDF 处理失败：{code}", { code: String(code || "?") });
  }
  function pdfAdd(paths) {
    for (const p of paths) {
      if (!/\.pdf$/i.test(p)) { toast(t("选中文件不是 PDF"), true); continue; }
      if (!PT.files.includes(p) && PT.files.length < 20) PT.files.push(p);
    }
    pdfFileList();
  }
  function pdfFileList() {
    const box = PT.el?.querySelector(".pdf-inputs");
    if (!box) return;
    box.innerHTML = PT.files.length ? PT.files.map((p, i) => `<li>
      <div class="pdf-file-name"><b>${esc(p.split("/").pop())}</b><span class="tiny">${esc(p)}</span></div>
      <div class="pdf-file-actions"><button type="button" class="btn ghost sm" data-file="${i}" data-pdf="preview">${esc(t("预览"))}</button>
        <button type="button" class="btn ghost sm" data-file="${i}" data-pdf="up" aria-label="${esc(t("上移"))}"${i === 0 ? " disabled" : ""}>${uiI("chevDown", "pdf-up")}</button>
        <button type="button" class="btn ghost sm" data-file="${i}" data-pdf="down" aria-label="${esc(t("下移"))}"${i === PT.files.length - 1 ? " disabled" : ""}>${uiI("chevDown")}</button>
        <button type="button" class="btn ghost sm" data-file="${i}" data-pdf="remove" aria-label="${esc(t("移除"))}">${uiI("x")}</button></div></li>`).join("") : `<li class="tiny">${esc(t("先在文件面板选中 PDF，或点击「选择 PDF…」。"))}</li>`;
    pdfControls();
  }
  function pdfControls() {
    const m = PT.el;
    if (!m) return;
    const busy = pdfBusy(), op = m.querySelector('[name="operation"]').value;
    m.querySelectorAll("[data-options]").forEach((el) => { el.hidden = !el.dataset.options.split(" ").includes(op); });
    m.querySelectorAll("input, select, [data-pdf='choose'], [data-pdf='clear'], [data-pdf='remove'], [data-pdf='up'], [data-pdf='down'], [data-pdf='files']").forEach((el) => { el.disabled = busy; });
    m.querySelectorAll('[data-pdf="up"], [data-pdf="down"]').forEach((el) => { el.disabled = busy || (el.dataset.pdf === "up" ? +el.dataset.file === 0 : +el.dataset.file === PT.files.length - 1); });
    const missing = PT.info?.operations?.[op];
    m.querySelector(".pdf-requirements").textContent = !PT.info ? t("读取中…") : missing?.length ? t("缺少 PDF 工具：{tools}。请在扩展 → 可选组件安装「PDF 工具箱」。", { tools: missing.join(", ") }) : "";
    m.querySelector('[data-pdf="components"]').hidden = !missing?.length;
    const countOk = op === "merge" ? PT.files.length >= 2 : PT.files.length === 1;
    m.querySelector('[type="submit"]').disabled = busy || !countOk || !missing || !!missing.length;
    m.querySelector('[data-pdf="cancel"]').hidden = PT.job?.state !== "running";
    m.querySelector(".pdf-status").textContent = PT.importing ? t("正在导入 PDF…") : PT.starting || PT.job?.state === "running" ? t("正在处理 PDF…") : PT.job?.state === "error" ? pdfError(PT.job.code) : PT.job?.state === "cancelled" ? t("已取消") : PT.job?.state === "done" ? t("处理完成") : "";
  }
  function pdfResults() {
    if (!PT.el) return;
    const box = PT.el.querySelector(".pdf-results"), j = PT.job;
    box.innerHTML = j?.state === "done" ? `<p class="tiny">${esc(fmtSize(j.inputBytes))} → ${esc(fmtSize(j.outputBytes))}</p>
      ${j.warning ? `<p class="pdf-warning">${esc(t("压缩后没有变小，原文件仍保留。"))}</p>` : ""}
      <p class="tiny">${esc(j.dest)}</p><button type="button" class="btn ghost sm" data-pdf="results">${esc(t("前往结果文件夹"))}</button>
      <ul class="pdf-outputs">${j.outputs.map((x, i) => `<li><span>${esc(x.path.split("/").pop())} · ${esc(fmtSize(x.size))}</span>
        <button type="button" class="btn ghost sm" data-out="${i}" data-pdf="open">${esc(t("打开"))}</button><button type="button" class="btn ghost sm" data-out="${i}" data-pdf="share">${esc(t("分享"))}</button></li>`).join("")}</ul>` : "";
    pdfControls();
  }
  async function pdfPoll(id) {
    clearTimeout(PT.timer);
    if (PT.job?.id !== id) return;
    let delay = 1000;
    try {
      const j = await api("/api/pdf/job?id=" + encodeURIComponent(id), { timeout: 15000 });
      if (PT.job?.id !== id) return;
      PT.errs = 0;
      PT.job = j;
      pdfResults();
      if (j.state !== "running") { if (!PT.el) toast(j.state === "done" ? t("处理完成") : j.state === "cancelled" ? t("已取消") : pdfError(j.code), j.state === "error"); return; }
    } catch (e) {
      if (e.status === 404) { PT.errs = 0; PT.job = { id, state: "error", code: "not-found" }; pdfResults(); return; }
      PT.errs = (PT.errs || 0) + 1;
      if (PT.errs >= 10) {
        PT.job = { id, state: "error", code: "network" };
        pdfResults();
        if (!PT.el) toast(pdfError("network"), true);
        return;
      }
      if (PT.el) PT.el.querySelector(".pdf-status").textContent = t("连接中断，正在重试…");
      delay = PT.el ? Math.min(5000, 1000 * PT.errs) : Math.min(15000, 1000 * (1 << Math.min(PT.errs, 4)));
    }
    PT.timer = setTimeout(() => pdfPoll(id), delay);
  }
  async function openPdfToolbox(paths = []) {
    if (PT.el) return;
    const m = document.createElement("div"); m.id = "pdf-tools";
    m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-label", t("PDF 工具箱"));
    const options = (list) => list.map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join("");
    m.innerHTML = `<form class="sheet-panel mp-panel pdf-form" aria-label="${esc(t("PDF 工具箱"))}">
      <div class="mp-head"><b>${esc(t("PDF 工具箱"))}</b><button type="button" class="mp-x" data-pdf="close" aria-label="${esc(t("关闭"))}">${uiI("x")}</button></div>
      <p class="tiny">${esc(t("文件只在本机处理，不会覆盖原文件。"))}</p>
      <div class="field"><label for="pdf-operation">${esc(t("操作"))}</label><select id="pdf-operation" name="operation">${options(PT_OPS())}</select></div>
      <div class="pdf-requirements tiny" role="status"></div><button type="button" class="btn ghost sm" data-pdf="components" hidden>${esc(t("打开可选组件"))}</button>
      <div class="row-actions"><button type="button" class="btn ghost sm" data-pdf="files">${esc(t("从文件面板添加"))}</button><button type="button" class="btn ghost sm" data-pdf="choose">${esc(t("选择 PDF…"))}</button><button type="button" class="btn ghost sm" data-pdf="clear">${esc(t("清空"))}</button></div>
      <input type="file" accept="application/pdf,.pdf" multiple hidden id="pdf-pick"><ol class="pdf-inputs"></ol>
      <p class="tiny">${esc(t("一次最多合并 20 份 PDF，其他操作只选一份。"))}</p>
      <div class="field" data-options="extract split rotate images"><label for="pdf-pages">${esc(t("页码"))}</label><input id="pdf-pages" name="pages" type="text" inputmode="text" placeholder="1-3,5" aria-describedby="pdf-pages-help"><span id="pdf-pages-help" class="tiny">${esc(t("页码格式：1-3,5；留空选择全部。"))}</span></div>
      <div class="field" data-options="rotate"><label for="pdf-angle">${esc(t("旋转角度"))}</label><select id="pdf-angle" name="angle"><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></div>
      <div class="field" data-options="compress"><label for="pdf-quality">${esc(t("压缩质量"))}</label><select id="pdf-quality" name="quality">${options([["ebook", t("电子书（ebook）")], ["screen", t("小文件（screen）")], ["printer", t("打印（printer）")]])}</select></div>
      <div class="pdf-image-options" data-options="images"><div class="field"><label for="pdf-format">${esc(t("图片格式"))}</label><select id="pdf-format" name="format"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></div><div class="field"><label for="pdf-dpi">${esc(t("分辨率"))}</label><select id="pdf-dpi" name="dpi">${options([[72, t("低（72 DPI）")], [150, t("清晰（150 DPI）")]])}</select></div><p class="tiny">${esc(t("每次最多转 100 页，图片长边最多 2048 像素。"))}</p></div>
      <div class="field"><label for="pdf-dest">${esc(t("输出文件夹（新建）"))}</label><input id="pdf-dest" name="dest" class="mono" type="text" required spellcheck="false" autocapitalize="off"></div>
      <div class="pdf-status" role="status" aria-live="polite"></div><div class="pdf-results"></div>
      <div class="row-actions pdf-submit"><button type="button" class="btn ghost sm" data-pdf="cancel" hidden>${esc(t("取消"))}</button><button type="submit" class="btn sm">${esc(t("开始处理"))}</button></div></form>`;
    PT.el = m;
    const close = () => OV.close(m);
    OV.open(m, { kind: "modal", keep: true, cover: true, onClose: () => {
      PT.form = Object.fromEntries([...m.querySelectorAll("[name]")].map((el) => [el.name, el.value]));
      if (PT.el === m) PT.el = null;
    } });
    m.querySelector('[name="dest"]').value = (state.settings.workspace || state.fs.path || "").replace(/\/$/, "") + "/pdf-" + Date.now();
    if (paths.length && !pdfBusy()) { PT.job = null; pdfAdd(paths); }
    else pdfFileList();
    if (PT.form) for (const [name, value] of Object.entries(PT.form)) m.querySelector(`[name="${name}"]`).value = value;
    else if (PT.files.length === 1) m.querySelector('[name="operation"]').value = "extract";
    if (PT.job?.operation) m.querySelector('[name="operation"]').value = PT.job.operation;
    m.querySelector('[name="operation"]').onchange = () => { if (PT.job?.state !== "running") PT.job = null; pdfResults(); };
    m.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-pdf]"); if (!b) return;
      const a = b.dataset.pdf, i = +b.dataset.file;
      if (a === "close") return close();
      if (a === "preview") { const p = PT.files[i]; close(); return openViewer(p, "pdf", 0); }
      if (a === "components") { close(); closeFiles(); openPage("ext"); $("comp-field").open = true; $("comp-field").scrollIntoView({ block: "start" }); return; }
      if (a === "results") { const p = PT.job.dest; close(); return openFiles(p); }
      if (a === "open" || a === "share") { const x = PT.job.outputs[+b.dataset.out]; if (a === "share") return shareFile(x.path); close(); return openViewer(x.path, x.kind, x.size); }
      if (a === "cancel") { b.disabled = true; try { await pdfPost("/api/pdf/cancel", { id: PT.job.id }); } catch (err) { toast(pdfError(err.message), true); } finally { b.disabled = false; } return; }
      if (pdfBusy()) return;
      if (a === "files") { close(); return openFiles(); }
      if (a === "choose") return m.querySelector("#pdf-pick").click();
      if (a === "remove") PT.files.splice(i, 1);
      if (a === "clear") PT.files = [];
      if (a === "up" && i > 0) [PT.files[i - 1], PT.files[i]] = [PT.files[i], PT.files[i - 1]];
      if (a === "down" && i < PT.files.length - 1) [PT.files[i + 1], PT.files[i]] = [PT.files[i], PT.files[i + 1]];
      PT.job = null; pdfFileList(); pdfResults();
    });
    m.querySelector("#pdf-pick").onchange = async (e) => {
      const files = [...e.target.files]; e.target.value = "";
      if (pdfBusy() || !files.length) return;
      if (files.length + PT.files.length > 20 || files.some((f) => !/\.pdf$/i.test(f.name)) || files.reduce((n, f) => n + f.size, 0) > 256 * 1024 ** 2) return toast(t("请选择 PDF，最多 20 份、合计 256 MB。"), true);
      PT.importing = true; PT.job = null; pdfResults();
      try {
        for (const f of files) { const r = await api("/api/upload?name=" + encodeURIComponent(f.name), { method: "POST", body: f, headers: { "Content-Type": "application/pdf" } }); pdfAdd([r.path]); }
      } catch (err) { toast(pdfError(err.message), true); }
      finally { PT.importing = false; pdfFileList(); }
    };
    m.querySelector("form").onsubmit = async (e) => {
      e.preventDefault(); if (pdfBusy()) return;
      const f = new FormData(e.target), body = Object.fromEntries(f); delete body["pdf-pick"];
      body.files = [...PT.files]; body.angle = +body.angle; body.dpi = +body.dpi;
      PT.starting = true; PT.job = null; PT.errs = 0; pdfResults();
      try { PT.job = await pdfPost("/api/pdf/start", body); pdfPoll(PT.job.id); }
      catch (err) { PT.job = { state: "error", code: err.body?.error || err.message }; }
      finally { PT.starting = false; pdfResults(); }
    };
    pdfResults();
    try { const info = await api("/api/pdf/tools"); PT.info = info; if (PT.el === m) pdfControls(); }
    catch (err) { if (PT.el === m) m.querySelector(".pdf-requirements").textContent = pdfError(err.message); }
  }
  $("fs-pdf").addEventListener("click", () => {
    if (state.fs.arc) return openPdfToolbox();
    const names = state.fs.multi ? [...state.fs.multi] : state.fs.sel ? [state.fs.sel] : [];
    openPdfToolbox(names.map((name) => fullPathOf({ name })));
  });

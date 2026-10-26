  // ── 文件浏览器 ────────────────────────────────────────────────────
  const DOC = '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>';
  const KIND_SVG = {
    dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17"/>',
    video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
    audio: '<path d="M9 17V5l10-2v12"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
    pdf: DOC + '<path d="M9 13h6M9 17h4"/>',
    text: DOC + '<path d="M9 12h6M9 15h6M9 18h4"/>',
    docx: DOC + '<path d="M9 12l1 5 2-3.5 2 3.5 1-5"/>',
    sheet: DOC + '<path d="M9 12h6v6H9zM9 15h6M12 12v6"/>',
    office: DOC + '<path d="M9 13h6v4H9z"/>',
    other: '<path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16z"/><path d="M4 8l8 4.5L20 8M12 12.5V20"/>',
  };
  const kindIcon = (k) => `<svg class="ui-i k-${KIND_SVG[k] ? k : "other"}" viewBox="0 0 24 24" aria-hidden="true">${KIND_SVG[k] || KIND_SVG.other}</svg>`;

  function crumbs(p) {
    const parts = String(p).split("/").filter(Boolean);
    let acc = "";
    const html = ['<span class="crumb" data-p="/">/</span>'];
    parts.forEach((seg, i) => {
      acc += "/" + seg;
      const last = i === parts.length - 1;
      html.push(`<span class="crumb ${last ? "cur" : ""}" data-p="${esc(acc)}">${esc(seg)}</span>`);
    });
    return html.join('<span class="sep">/</span>');
  }

  async function openFiles(path) {
    MO.cancel(filesEl); filesEl.classList.remove("hidden");
    await fsLoad(path || state.fs.path || state.settings.workspace || "/sdcard");
  }

  async function fsLoad(p, { keepSel = false } = {}) {
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(p)}` +
        (state.fs.hidden ? "&hidden=1" : ""));
      Object.assign(state.fs, {
        path: r.path, parent: r.parent, entries: r.entries || [], roots: r.roots || [],
      });
      if (!keepSel) state.fs.sel = null;
      $("fs-search").value = state.fs.q = "";
      renderFs();
    } catch (e) { toast(t("打开目录失败：{msg}", { msg: e.message }), true); }
  }

  function fsVisible() {
    const q = state.fs.q.toLowerCase();
    return q ? state.fs.entries.filter((e) => e.name.toLowerCase().includes(q)) : state.fs.entries;
  }

  function renderFs() {
    $("fs-crumbs").innerHTML = crumbs(state.fs.path || "");
    $("fs-roots").innerHTML = (state.fs.roots || [])
      .map((r) => `<span class="chip" data-p="${esc(r)}">${esc(r.replace(/^\/sdcard/, "~"))}</span>`).join("");

    const list = fsVisible();
    $("fs-count").textContent = t("{n} 项 · {path}", { n: list.length, path: state.fs.path || "" });
    $("fs-list").innerHTML = list.length ? list.map((e, i) => `
      <div class="item fs-item ${state.fs.sel === e.name ? "active" : ""}" data-i="${i}">
        <div class="fs-row">
          <span class="fs-ico">${kindIcon(e.kind)}</span>
          <span class="it-title">${esc(e.name)}${e.dir ? "/" : ""}</span>
          <span class="fs-meta">${e.dir ? "" : fmtSize(e.size)}</span>
        </div>
      </div>`).join("") : '<div class="tiny">' + t("（空目录）") + '</div>';

    // 图片直接出缩略图，别的类型给一行摘要
    if (list.some((e) => e.kind === "image")) {
      $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
        const e = list[Number(el.dataset.i)];
        if (e.kind !== "image") return;
        const t = document.createElement("img");
        t.className = "fs-thumb";
        t.loading = "lazy";
        t.src = fileUrl(state.fs.path.replace(/\/$/, "") + "/" + e.name);
        el.querySelector(".fs-row").prepend(t);
        el.querySelector(".fs-ico").remove();
      });
    }

    $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
      const e = list[Number(el.dataset.i)];
      el.addEventListener("click", () => (e.dir ? fsLoad(state.fs.path.replace(/\/$/, "") + "/" + e.name) : fsSelect(e)));
      if (!e.dir) el.addEventListener("dblclick", () => { insertFile(e); });
      el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); fsRename(e); });   // 长按 = 重命名
    });

    $("fs-insert").disabled = !state.fs.sel;
    renderFsPreview();
    fsGitDots();
  }

  const fullPathOf = (e) => state.fs.path.replace(/\/$/, "") + "/" + e.name;

  function fsSelect(e) {
    state.fs.sel = e.name;
    renderFs();
  }

  async function renderFsPreview() {
    const box = $("fs-preview");
    if (!state.fs.sel) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const e = state.fs.entries.find((x) => x.name === state.fs.sel);
    if (!e) { box.classList.add("hidden"); return; }
    const full = fullPathOf(e);
    box.classList.remove("hidden");

    let body = "";
    if (e.kind === "image") {
      body = `<img src="${fileUrl(full)}" alt="">`;
    } else if (e.kind === "video") {
      body = `<video src="${fileUrl(full)}" controls preload="metadata"></video>`;
    } else if (e.kind === "audio") {
      body = `<audio src="${fileUrl(full)}" controls></audio>`;
    } else if (e.kind === "text" && e.size < 262144) {
      box.innerHTML = `<div class="fs-prev-head"><span class="mono">${esc(e.name)}</span><span class="tiny">${t("读取中…")}</span></div>`;
      try {
        const txt = await fetch(fileUrl(full)).then((r) => r.text());
        body = `<pre class="fs-pre">${esc(txt.slice(0, 12000))}${txt.length > 12000 ? "\n" + t("…（已截断）") : ""}</pre>`;
      } catch { body = '<div class="tiny">' + t("读取失败") + '</div>'; }
    } else {
      body = `<div class="tiny">${e.kind} · ${fmtSize(e.size)} · ${t("无可内嵌预览")}</div>`;
    }

    box.innerHTML =
      `<div class="fs-prev-head">
         <span class="mono">${esc(e.name)}</span>
         <span class="tiny">${fmtSize(e.size)}</span>
         <button class="btn sm" data-a="open">${e.kind === "text" ? t("打开 / 编辑") : t("打开")}</button>
         <button class="btn ghost sm" data-a="insert">${t("插入 @路径")}</button>
         <button class="btn ghost sm" data-a="rename">${t("重命名")}</button>
         <a class="btn ghost sm" href="${fileUrl(full, true)}" download>⤓</a>
       </div>
       <div class="fs-prev-body">${body}</div>`;
    box.querySelector('[data-a="insert"]')?.addEventListener("click", () => insertFile(e));
    box.querySelector('[data-a="rename"]')?.addEventListener("click", () => fsRename(e));
    box.querySelector('[data-a="open"]')?.addEventListener("click", () => openViewer(full, e.kind, e.size));
    box.querySelector("img")?.addEventListener("click", () => openViewer(full, e.kind, e.size));
  }

  function insertFile(e) {
    const full = e.dir ? fullPathOf(e) + "/" : fullPathOf(e);
    insertAtCursor("@" + full);
    toast(e.dir ? t("已插入目录路径") : t("已插入文件路径"));
    closeFiles();
    inputEl.focus();
  }

  function closeFiles() { MO.hide(filesEl, MO.paneOut()); }

  // 新建 / 重命名：都不覆盖已有的同名项。新建文件默认 .txt，建好直接进编辑器；想换类型就改后缀
  const fsErr = (e) => toast(/exists|409/.test(e.message) ? t("已经有同名的文件或文件夹") : t("操作失败：{msg}", { msg: e.message }), true);
  const badName = (n) => !n || n === "." || n === ".." || /[\/\0]/.test(n);
  async function fsCreate(dir) {
    if (!state.fs.path) return;
    const name = (prompt(dir ? t("新文件夹名称") : t("新文件名称（改后缀就是别的类型）"), dir ? t("新建文件夹") : t("新建文本") + ".txt") || "").trim();
    if (!name) return;
    if (badName(name)) return toast(t("名称里不能有 /"), true);
    const full = state.fs.path.replace(/\/$/, "") + "/" + name;
    try {
      const r = await api(`/api/file/${dir ? "mkdir" : "new"}?path=${encodeURIComponent(full)}`, { method: "POST" });
      if (dir) return fsLoad(r.path);
      await fsLoad(state.fs.path);
      state.fs.sel = name; renderFs();
      openViewer(r.path, r.kind === "other" ? "text" : r.kind, 0);   // 空文件：没有识别出类型的也当文本开
    } catch (e) { fsErr(e); }
  }
  async function fsRename(e) {
    const name = (prompt(t("重命名为"), e.name) || "").trim();
    if (!name || name === e.name) return;
    if (badName(name)) return toast(t("名称里不能有 /"), true);
    try {
      await api(`/api/file/rename?from=${encodeURIComponent(fullPathOf(e))}&name=${encodeURIComponent(name)}`, { method: "POST" });
      if (state.fs.sel === e.name) state.fs.sel = name;
      await fsLoad(state.fs.path, { keepSel: true });
      toast(t("已重命名"));
    } catch (err) { fsErr(err); }
  }
  $("fs-newfile").addEventListener("click", () => fsCreate(false));
  $("fs-mkdir").addEventListener("click", () => fsCreate(true));

  $("fs-close").addEventListener("click", closeFiles);
  $("fs-reload").addEventListener("click", () => { fsDotsAt = 0; fsLoad(state.fs.path, { keepSel: true }); });
  $("fs-git").addEventListener("click", () => openGit(state.fs.path));
  $("fs-up").addEventListener("click", () => {
    if (state.fs.parent && state.fs.parent !== state.fs.path) fsLoad(state.fs.parent);
  });
  $("fs-hidden").addEventListener("change", (e) => { state.fs.hidden = e.target.checked; fsLoad(state.fs.path); });
  $("fs-search").addEventListener("input", (e) => { state.fs.q = e.target.value.trim(); renderFs(); });
  $("fs-insert").addEventListener("click", () => {
    const e = state.fs.entries.find((x) => x.name === state.fs.sel);
    if (e) insertFile(e);
  });
  $("fs-roots").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (c) fsLoad(c.dataset.p);
  });
  $("fs-crumbs").addEventListener("click", (e) => {
    const c = e.target.closest(".crumb");
    if (c) fsLoad(c.dataset.p);
  });


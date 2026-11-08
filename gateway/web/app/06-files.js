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
    MO.cancel(filesEl); filesEl.classList.remove("hidden"); window.CCLayout && CCLayout.raise("files");   // 已开着被盖住：提上来（审查 UI05-001）
    await fsLoad(path || state.fs.path || state.settings.workspace || "/sdcard");
  }

  // 目录超过 1000 项时网关只回前 1000 项并带 truncated；搜索改成让网关先过滤再截断，
  // 不然只能搜到前 1000 项里的（195-C.5、196 输入域第 9 条）
  let fsQSeq = 0, fsQTimer = 0;
  async function fsLoad(p, { keepSel = false, keepQ = false } = {}) {
    const ok = latest("fs");    // 先点的目录响应慢、后到：别把人带回旧目录（审查 C-004 / #49 P3-1）
    fsQSeq++;                   // 换目录 / 刷新：在途的搜索作废
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(p)}` +
        (state.fs.hidden ? "&hidden=1" : ""));
      if (!ok()) return;
      // 读不了（没权限、不存在）网关回 200 带 error：不能当成空目录（审查 C-003）
      if (r.error) throw new Error(r.error);
      Object.assign(state.fs, {
        path: r.path, parent: r.parent, entries: r.entries || [], roots: r.roots || [],
        truncated: !!r.truncated, qRemote: false,
      });
      if (!keepSel) state.fs.sel = null;
      // 刷新时保留搜索词：关闭查看器、重命名之后的自动刷新不该把过滤清掉（196 查看器域第 4 条）
      if (!keepQ) { $("fs-search").value = state.fs.q = ""; }
      renderFs();
      if (state.fs.q && state.fs.truncated) fsSearchNow(state.fs.q);
    } catch (e) { if (ok()) toast(t("打开目录失败：{msg}", { msg: e.message }), true); }
  }

  // 大目录里按网关的 q 过滤（先过滤再截 1000 项），本地那一层过滤只是立刻给个反馈
  async function fsSearchNow(q) {
    const my = ++fsQSeq, p = state.fs.path;
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(p)}` +
        (state.fs.hidden ? "&hidden=1" : "") + `&q=${encodeURIComponent(q)}`);
      if (my !== fsQSeq || p !== state.fs.path || state.fs.q !== q) return;
      if (r.error) throw new Error(r.error);
      state.fs.entries = r.entries || [];
      state.fs.truncated = !!r.truncated;
      state.fs.qRemote = true;    // 这份 entries 是网关按 q 过滤过的，再改搜索词要重新问网关
      renderFs();
    } catch (e) { if (my === fsQSeq) toast(t("搜索失败：{msg}", { msg: e.message }), true); }
  }
  function fsSearchTyped(v) {
    state.fs.q = v;
    clearTimeout(fsQTimer);
    if (!v) {
      if (state.fs.qRemote) return fsLoad(state.fs.path, { keepSel: true, keepQ: true });
      return renderFs();
    }
    if (!state.fs.truncated && !state.fs.qRemote) return renderFs();   // 小目录：本地过滤就够
    fsQTimer = setTimeout(() => fsSearchNow(v), 250);   // 抖一下：别每敲一个字就打一次网关
    renderFs();
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
    $("fs-count").textContent = t("{n} 项 · {path}", { n: list.length, path: state.fs.path || "" }) +
      (state.fs.truncated ? " · " + t("只显示了前 1000 项") : "");
    $("fs-list").innerHTML = list.length ? list.map((e, i) => `
      <div class="item fs-item ${state.fs.sel === e.name ? "active" : ""}" data-i="${i}" tabindex="0" role="button">
        <div class="fs-row">
          <span class="fs-ico">${kindIcon(e.kind)}</span>
          <span class="it-title">${esc(e.name)}${e.dir ? "/" : ""}</span>
          <span class="fs-meta">${e.dir ? "" : fmtSize(e.size)}</span>
        </div>
      </div>`).join("") : '<div class="tiny">' + (state.fs.q ? t("没有匹配项") : t("（空目录）")) + '</div>';

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
      // 键盘也能用：Tab 到条目，回车 / 空格同点击（审查 #49 P2-11）
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); el.click(); } });
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
    // 只换高亮和右侧预览，不整表重画：重画会把列表滚回顶部、所有缩略图重新请求解码（195-C.6）
    const list = fsVisible();
    $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
      const x = list[Number(el.dataset.i)];
      el.classList.toggle("active", !!x && x.name === e.name);
    });
    $("fs-insert").disabled = !state.fs.sel;
    renderFsPreview();
  }

  // 每次重画领一个号：读文本是异步的，先点 A 再点 B，A 的内容晚到不能把 B 盖掉（按钮也会绑到 A 上）—— 审查 中13
  let fsPrevSeq = 0;
  async function renderFsPreview() {
    const box = $("fs-preview"), seq = ++fsPrevSeq;
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
        // 403 / 404 时回来的是一段 JSON 错误，别当正文显示（审查 C-009）
        const r0 = await fetch(fileUrl(full));
        if (!r0.ok) throw new Error("HTTP " + r0.status);
        // 按字节认编码再解：以前一律当 UTF-8，UTF-16 / GBK 的笔记预览全是乱码（195-C.13，查看器里的同一套逻辑）
        const buf = new Uint8Array(await r0.arrayBuffer());
        if (vwLooksBinary(buf)) throw new Error(t("这是二进制文件，当作文本打开会把界面卡住。"));
        const txt = vwDecode(buf).text;
        body = `<pre class="fs-pre">${esc(txt.slice(0, 12000))}${txt.length > 12000 ? "\n" + t("…（已截断）") : ""}</pre>`;
      } catch (err) { body = '<div class="tiny">' + t("读取失败") + (err && err.message ? "：" + esc(err.message) : "") + '</div>'; }
      if (seq !== fsPrevSeq) return;
    } else {
      body = `<div class="tiny">${esc(e.kind)} · ${fmtSize(e.size)} · ${t("无可内嵌预览")}</div>`;
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

  function closeFiles() { dropReq("fs"); MO.hide(filesEl, MO.paneOut()); }   // 关了就作废在途的目录请求，别让旧结果回来重画（审查 v0.5.4 F-L2）

  // 新建 / 重命名：都不覆盖已有的同名项。新建文件默认 .txt，建好直接进编辑器；想换类型就改后缀
  // 原始英文的 Node 错误（ENAMETOOLONG / EACCES / ENOSPC）对用户没意义，换成能照着做的说法（196 静默错误域）
  const fsErr = (e) => {
    const m = String((e && e.message) || e || "");
    if (/exists|409|已经有同名/.test(m)) return toast(t("已经有同名的文件或文件夹"), true);
    if (/ENAMETOOLONG|name too long/i.test(m)) return toast(t("文件名太长（最多 255 字节，中文一个字算 3 个）"), true);
    if (/EACCES|EPERM/.test(m)) return toast(t("没有权限访问这个位置（共享存储需要在系统设置里允许「所有文件访问」）"), true);
    if (/ENOSPC/.test(m)) return toast(t("存储空间不够了"), true);
    toast(t("操作失败：{msg}", { msg: m }), true);
  };
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
      await fsLoad(state.fs.path, { keepSel: true, keepQ: true });
      toast(t("已重命名"));
    } catch (err) { fsErr(err); }
  }
  $("fs-newfile").addEventListener("click", () => fsCreate(false));
  $("fs-mkdir").addEventListener("click", () => fsCreate(true));

  $("fs-close").addEventListener("click", closeFiles);
  $("fs-reload").addEventListener("click", () => { fsDotsAt = 0; fsLoad(state.fs.path, { keepSel: true, keepQ: true }); });
  $("fs-git").addEventListener("click", () => openGit(state.fs.path));
  $("fs-up").addEventListener("click", () => {
    if (state.fs.parent && state.fs.parent !== state.fs.path) fsLoad(state.fs.parent);
  });
  $("fs-hidden").addEventListener("change", (e) => { state.fs.hidden = e.target.checked; fsLoad(state.fs.path); });
  $("fs-search").addEventListener("input", (e) => { fsSearchTyped(e.target.value.trim()); });
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


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
    archive: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M12 3.5v2M12 7.5v2M12 11.5v2"/><rect x="10.3" y="14.5" width="3.4" height="3.6" rx=".6"/>',
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
      state.fs.arc = null;
      if (!keepSel) state.fs.sel = null;
      if (state.fs.multi) state.fs.multi.clear();
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
    const arc = state.fs.arc;
    $("fs-crumbs").innerHTML = arc ? arcCrumbs(arc) : crumbs(state.fs.path || "");
    renderArcBar();
    $("fs-roots").innerHTML = (state.fs.roots || [])
      .map((r) => `<span class="chip" data-p="${esc(r)}">${esc(r.replace(/^\/sdcard/, "~"))}</span>`).join("");

    const list = fsVisible();
    $("fs-count").textContent = arc
      ? t("{n} 项 · {path}", { n: list.length, path: arc.name + (arc.dir ? " / " + arc.dir : "") }) + (arc.truncated ? " · " + t("只列出前 {n} 项，用过滤找", { n: list.length }) : "")
      : t("{n} 项 · {path}", { n: list.length, path: state.fs.path || "" }) + (state.fs.truncated ? " · " + t("只显示了前 1000 项") : "");
    const multi = state.fs.multi;
    $("fs-list").innerHTML = list.length ? list.map((e, i) => `
      <div class="item fs-item ${state.fs.sel === e.name ? "active" : ""} ${multi && multi.has(e.name) ? "picked" : ""}" data-i="${i}" tabindex="0" role="button"${multi ? ` aria-pressed="${multi.has(e.name)}"` : ""}>
        <div class="fs-row">
          ${multi ? `<span class="fs-chkmark" aria-hidden="true">${multi.has(e.name) ? "✓" : ""}</span>` : ""}
          <span class="fs-ico">${kindIcon(e.kind)}</span>
          <span class="it-title">${esc(e.name)}${e.dir ? "/" : ""}</span>
          <span class="fs-meta">${e.dir ? "" : fmtSize(e.size)}</span>
        </div>
      </div>`).join("") : '<div class="tiny">' + (state.fs.q ? t("没有匹配项") : t("（空目录）")) + '</div>';

    // 图片直接出缩略图，别的类型给一行摘要
    if (!arc && list.some((e) => e.kind === "image")) {
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
      el.addEventListener("click", () => {
        if (state.fs.multi) { state.fs.multi.has(e.name) ? state.fs.multi.delete(e.name) : state.fs.multi.add(e.name); return renderFs(); }
        if (arc) return e.dir ? arcLoad(arcJoin(arc.dir, e.name)) : fsSelect(e);
        e.dir ? fsLoad(state.fs.path.replace(/\/$/, "") + "/" + e.name) : fsSelect(e);
      });
      // 键盘也能用：Tab 到条目，回车 / 空格同点击（审查 #49 P2-11）
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); el.click(); } });
      if (arc) return;
      if (!e.dir) el.addEventListener("dblclick", () => { insertFile(e); });
      // 长按：重命名 / 压缩（以前长按直接重命名，压缩只藏在「多选」里，用户找不到，11-09）
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        popMenu(el, [{ head: e.name + (e.dir ? "/" : "") }, { label: t("重命名"), fn: () => fsRename(e) }, { label: t("压缩…"), fn: () => arcCreateDlg([e.name]) }]);
      });
    });

    $("fs-insert").disabled = !state.fs.sel || !!arc;
    $("fs-insert").classList.toggle("hidden", !!multi || !!arc);
    $("fs-multi").classList.toggle("on", !!multi);
    $("fs-multi").setAttribute("aria-pressed", String(!!multi));
    const act = $("fs-act");
    act.classList.toggle("hidden", !multi);
    if (multi) {
      act.textContent = arc ? t("解压选中（{n}）", { n: multi.size }) : t("压缩（{n}）", { n: multi.size });
      act.disabled = !multi.size;
    }
    renderFsPreview();
    if (!arc) fsGitDots();
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
    if (state.fs.arc) return arcPreviewPane(box, e);
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
    } else if (e.kind === "archive") {
      body = `<div class="tiny">${t("压缩包：点「打开压缩包」浏览里面的文件，或直接解压")}</div>`;
    } else {
      body = `<div class="tiny">${esc(e.kind)} · ${fmtSize(e.size)} · ${t("无可内嵌预览")}</div>`;
    }

    box.innerHTML =
      `<div class="fs-prev-head">
         <span class="mono">${esc(e.name)}</span>
         <span class="tiny">${fmtSize(e.size)}</span>
         ${/\.apk$/i.test(e.name) && canShare() ? `<button class="btn sm" data-a="apk">${t("安装")}</button>` : ""}
         ${e.kind === "archive" ? `<button class="btn sm" data-a="arc">${t("打开压缩包")}</button><button class="btn ghost sm" data-a="unpack">${t("解压…")}</button>`
           : `<button class="btn sm" data-a="open">${e.kind === "text" ? t("打开 / 编辑") : t("打开")}</button><button class="btn ghost sm" data-a="pack">${t("压缩…")}</button>`}
         <button class="btn ghost sm" data-a="insert">${t("插入 @路径")}</button>
         <button class="btn ghost sm" data-a="rename">${t("重命名")}</button>
         <a class="btn ghost sm" href="${fileUrl(full, true)}" download>⤓</a>
       </div>
       <div class="fs-prev-body">${body}</div>`;
    box.querySelector('[data-a="insert"]')?.addEventListener("click", () => insertFile(e));
    box.querySelector('[data-a="rename"]')?.addEventListener("click", () => fsRename(e));
    box.querySelector('[data-a="open"]')?.addEventListener("click", () => openViewer(full, e.kind, e.size));
    box.querySelector('[data-a="apk"]')?.addEventListener("click", () => vwInstallApk(full));   // .apk 算压缩包，查看器那头的「安装」走不到这里（16-viewer-git.js）
    box.querySelector('[data-a="arc"]')?.addEventListener("click", () => arcOpen(full));
    box.querySelector('[data-a="unpack"]')?.addEventListener("click", () => arcExtractDlg({ path: full, entries: null }));
    box.querySelector('[data-a="pack"]')?.addEventListener("click", () => arcCreateDlg([e.name]));
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
  $("fs-reload").addEventListener("click", () => { if (state.fs.arc) return arcLoad(state.fs.arc.dir, { keepSel: true }); fsDotsAt = 0; fsLoad(state.fs.path, { keepSel: true, keepQ: true }); });
  $("fs-git").addEventListener("click", () => openGit(state.fs.path));
  $("fs-up").addEventListener("click", () => {
    if (state.fs.arc) return arcUp();
    if (state.fs.parent && state.fs.parent !== state.fs.path) fsLoad(state.fs.parent);
  });
  $("fs-hidden").addEventListener("change", (e) => { state.fs.hidden = e.target.checked; if (!state.fs.arc) fsLoad(state.fs.path); });   // 包里不分隐藏项；退出压缩包时按新设置列
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
    if (!c) return;
    if (c.dataset.ad != null) return arcLoad(c.dataset.ad);
    fsLoad(c.dataset.p);
  });

  // ── 压缩包：浏览 / 预览 / 解压 / 压缩（gw/archiver.mjs；7-Zip 随 APK 走） ──
  // 进了压缩包，文件面板就切成「包内」模式：面包屑、上级、过滤、多选照用，条目来自 /api/arc/list。
  // 密码只留在 state.fs.arc 里（这个面板开着的这一会儿），不存本地
  const arcJoin = (d, n) => (d ? d + "/" + n : n);
  const arcStem = (name) => name.replace(/\.(tar\.(gz|bz2|xz|zst|lzma)|t[gbx]z|tbz2|tzst|[^.]{1,6})$/i, "").replace(/\.part0*1$/i, "") || name;
  const dirOf = (p) => p.replace(/\/[^/]*$/, "") || "/";
  const arcPost = (p, body) => api("/api/arc/" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  function arcCrumbs(arc) {
    const parts = arc.dir ? arc.dir.split("/") : [];
    const html = [`<span class="crumb" data-p="${esc(dirOf(arc.path))}">…</span>`, `<span class="crumb ${parts.length ? "" : "cur"}" data-ad="">${kindIcon("archive")}${esc(arc.name)}</span>`];
    let acc = "";
    parts.forEach((seg, i) => { acc = arcJoin(acc, seg); html.push(`<span class="crumb ${i === parts.length - 1 ? "cur" : ""}" data-ad="${esc(acc)}">${esc(seg)}</span>`); });
    return html.join('<span class="sep">/</span>');
  }

  function renderArcBar() {
    const bar = $("fs-arcbar"), arc = state.fs.arc;
    bar.classList.toggle("hidden", !arc);
    if (!arc) { bar.innerHTML = ""; return; }
    const i = arc.info;
    const encSel = i.kind === "zip" && i.legacy
      ? `<select class="fs-arcenc" aria-label="${esc(t("文件名编码"))}" title="${esc(t("文件名乱码就换一个编码"))}">${(arc.encodings || ["auto"]).map((x) =>
          `<option value="${esc(x)}" ${x === (arc.enc === "auto" ? i.encoding : arc.enc) ? "selected" : ""}>${esc(x === "auto" ? t("自动") : x.toUpperCase())}</option>`).join("")}</select>` : "";
    bar.innerHTML = `<span class="tiny">${esc(i.type || i.kind)} · ${t("{n} 个条目", { n: i.total })} · ${fmtSize(i.bytes)}${i.encrypted ? " · " + t("已加密") : ""}</span>
      ${encSel}
      <button class="btn sm" data-a="all">${t("全部解压…")}</button>
      <button class="btn ghost sm" data-a="exit">${t("退出压缩包")}</button>`;
    bar.querySelector('[data-a="all"]').addEventListener("click", () => arcExtractDlg({ path: arc.path, entries: null }));
    bar.querySelector('[data-a="exit"]').addEventListener("click", arcExit);
    bar.querySelector(".fs-arcenc")?.addEventListener("change", (ev) => { arc.enc = ev.target.value; arcLoad(arc.dir); });
  }

  /** 打开一个压缩包（要密码就先问） */
  async function arcOpen(path) {
    state.fs.sel = null;
    state.fs.qRemote = false;   // 外面那层大目录按网关搜索过：进了包再清过滤词别回头 fsLoad（会把人踢出压缩包）
    state.fs.arc = { path, name: path.split("/").pop(), dir: "", enc: "auto", password: "", info: null };
    await arcLoad("");
  }
  async function arcLoad(dir, { keepSel = false } = {}) {
    const arc = state.fs.arc;
    if (!arc) return;
    const ok = latest("fs");
    let r;
    try {
      if (!arc.encodings) arc.encodings = (await api("/api/arc/info").catch(() => ({}))).encodings;
      r = await arcPost("list", { path: arc.path, dir, enc: arc.enc, password: arc.password || undefined });
    } catch (e) {
      if (!ok()) return;
      if (!arc.info) { state.fs.arc = null; renderFs(); }
      return toast(e.status === 501 ? t("这个版本没带 7-Zip，打不开这种压缩包") : t("打不开压缩包：{msg}", { msg: e.message }), true);
    }
    if (!ok() || state.fs.arc !== arc) return;
    if (r.needPassword) {
      const pw = await arcAskPassword(arc.name, r.wrongPassword && arc.password);
      if (pw == null) { if (!arc.info) { state.fs.arc = null; renderFs(); } return; }
      arc.password = pw;
      return arcLoad(dir, { keepSel });
    }
    Object.assign(arc, { dir: r.dir, info: r, truncated: r.truncated });
    state.fs.entries = r.entries;
    if (!keepSel) state.fs.sel = null;
    if (state.fs.multi) state.fs.multi.clear();
    $("fs-search").value = state.fs.q = "";
    renderFs();
  }
  function arcUp() {
    const arc = state.fs.arc;
    if (arc.dir) return arcLoad(arc.dir.includes("/") ? arc.dir.replace(/\/[^/]*$/, "") : "");
    arcExit();
  }
  async function arcExit() {
    const p = state.fs.arc && state.fs.arc.path;
    state.fs.arc = null;
    await fsLoad(dirOf(p || state.fs.path || "/"));
    if (p) { state.fs.sel = p.split("/").pop(); renderFs(); }
  }

  /** 包内选中一个文件：解到缓存，用查看器打开 */
  function arcPreviewPane(box, e) {
    const arc = state.fs.arc, entry = arcJoin(arc.dir, e.name);
    box.classList.remove("hidden");
    const when = e.mtime ? new Date(e.mtime).toLocaleString() : "";
    box.innerHTML = `<div class="fs-prev-head">
        <span class="mono">${esc(e.name)}</span>
        <span class="tiny">${fmtSize(e.size)}</span>
        ${e.link ? "" : `<button class="btn sm" data-a="open">${t("打开")}</button>`}
        <button class="btn ghost sm" data-a="unpack">${t("解压…")}</button>
      </div>
      <div class="fs-prev-body"><div class="tiny">${[e.packed ? t("压缩后 {size}", { size: fmtSize(e.packed) }) : "", when, e.enc ? t("已加密") : "", e.link ? t("软链接（不解出）") : ""].filter(Boolean).map(esc).join(" · ")}</div></div>`;
    box.querySelector('[data-a="unpack"]').addEventListener("click", () => arcExtractDlg({ path: arc.path, entries: [entry] }));
    box.querySelector('[data-a="open"]')?.addEventListener("click", async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = t("解出中…");
      try {
        const r = await arcPost("preview", { path: arc.path, entry, enc: arc.enc, password: arc.password || undefined });
        if (r.needPassword) {
          const pw = await arcAskPassword(arc.name, r.wrongPassword);
          if (pw != null) { arc.password = pw; renderFsPreview(); }
          return;
        }
        openViewer(r.path, r.kind === "archive" ? "other" : r.kind, r.size);
      } catch (err) {
        toast(err.status === 401 ? t("密码不对") : err.status === 413 ? t("文件太大，没法直接预览，请解压出来再看") : err.status === 507 ? t("存储空间不够") : t("解出失败：{msg}", { msg: err.message }), true);
      } finally { if (b.isConnected) { b.disabled = false; b.textContent = t("打开"); } }
    });
  }

  // ── 对话框：密码、解压到哪、压缩设置（同一个底部面板样式） ──
  function arcDialog(title, inner, okText) {
    return new Promise((resolve) => {
      const m = document.createElement("div");
      m.id = "arc-dlg";
      m.innerHTML = `<form class="sheet-panel mp-panel arc-form">
        <div class="mp-head"><b>${esc(title)}</b><button class="mp-x" type="button" aria-label="${esc(t("关闭"))}">${uiI("x")}</button></div>
        ${inner}
        <div class="row-actions arc-acts"><button type="button" class="btn ghost sm" data-a="cancel">${esc(t("取消"))}</button><button type="submit" class="btn sm">${esc(okText)}</button></div></form>`;
      let done = false;
      const close = (v) => { if (done) return; done = true; resolve(v); OV.close(m); };
      m.addEventListener("click", (e) => { if (e.target === m || e.target.closest(".mp-x") || e.target.closest('[data-a="cancel"]')) close(null); });
      const f = m.querySelector("form");
      f.addEventListener("submit", (e) => { e.preventDefault(); close(Object.fromEntries(new FormData(f))); });
      OV.open(m, { kind: "modal", keep: true, cover: true, onClose: () => { if (!done) { done = true; resolve(null); } } });
      f.querySelector('select[name="format"]')?.dispatchEvent(new Event("change", { bubbles: true }));   // 按默认格式藏掉用不上的栏
      setTimeout(() => f.querySelector("input:not([type=hidden]):not([type=checkbox])")?.focus(), 60);
    });
  }
  async function arcAskPassword(name, wrong) {
    const v = await arcDialog(t("输入密码"), `<div class="tiny mp-note">${esc(name)}${wrong ? " · " + esc(t("密码不对，再试一次")) : ""}</div>
      <div class="field"><input name="pw" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`, t("确定"));
    return v ? v.pw : null;
  }

  /** 解压：目标默认「压缩包所在目录 / 包名」，可改成别处；已有同名的不覆盖，新来的改名 */
  async function arcExtractDlg({ path, entries }) {
    const arc = state.fs.arc && state.fs.arc.path === path ? state.fs.arc : null;
    const base = dirOf(path), stem = arcStem(path.split("/").pop());
    const what = entries ? (entries.length === 1 ? entries[0].split("/").pop() : t("选中的 {n} 项", { n: entries.length })) : t("全部");
    const v = await arcDialog(t("解压 {what}", { what }), `
      <div class="field"><label>${esc(t("解压到"))}</label><input name="dest" type="text" class="mono" value="${esc(base.replace(/\/$/, "") + "/" + stem)}" autocapitalize="off" spellcheck="false"></div>
      <div class="row-actions arc-quick"><button type="button" class="btn ghost sm" data-d="${esc(base.replace(/\/$/, "") + "/" + stem)}">./${esc(stem)}/</button><button type="button" class="btn ghost sm" data-d="${esc(base)}">${esc(t("当前目录"))}</button></div>
      ${arc ? "" : `<div class="field"><label>${esc(t("密码（没加密就留空）"))}</label><input name="pw" type="password" autocomplete="off"></div>`}
      <div class="tiny mp-note">${esc(t("目标里已有同名的文件不会被覆盖，新解出来的会改名为「名字 (2)」。软链接不解出。"))}</div>`, t("解压"));
    if (!v) return;
    const dest = String(v.dest || "").trim().replace(/\/+$/, "") || "/";
    if (!dest.startsWith("/")) return toast(t("要写完整路径（以 / 开头）"), true);
    arcRunJob("extract", { path, dest, entries: entries || undefined, enc: arc ? arc.enc : "auto", password: (arc ? arc.password : v.pw) || undefined }, dest);
  }
  document.addEventListener("click", (e) => {   // 对话框里的快捷目标
    const b = e.target.closest("#arc-dlg [data-d]");
    if (b) b.closest("form").querySelector('[name="dest"]').value = b.dataset.d;
  });

  const ARC_FORMATS = [["zip", ".zip"], ["7z", ".7z"], ["tar.gz", ".tar.gz"], ["tar.xz", ".tar.xz"], ["tar.bz2", ".tar.bz2"], ["tar", ".tar"]];
  async function arcCreateDlg(names) {
    const dir = state.fs.path.replace(/\/$/, "");
    const def = names.length === 1 ? names[0].replace(/\.[^.]{1,6}$/, "") || names[0] : (dir.split("/").pop() || "archive");
    const fmt0 = localStorage.getItem("cc.arc.fmt") || "zip";
    const v = await arcDialog(names.length === 1 ? t("压缩「{name}」", { name: names[0] }) : t("压缩 {n} 项", { n: names.length }), `
      <div class="field"><label>${esc(t("压缩包名称"))}</label><input name="name" type="text" value="${esc(def)}" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label>${esc(t("格式"))}</label><select name="format">${ARC_FORMATS.map(([f, ext]) => `<option value="${f}" ${f === fmt0 ? "selected" : ""}>${ext}</option>`).join("")}</select></div>
      <div class="field"><label>${esc(t("压缩级别"))}</label><select name="level">
        <option value="0">${esc(t("仅存储"))}</option><option value="1">${esc(t("最快"))}</option><option value="5" selected>${esc(t("标准"))}</option><option value="9">${esc(t("最小体积（慢）"))}</option></select></div>
      <div class="field arc-pw"><label>${esc(t("密码（可选，zip / 7z）"))}</label><input name="password" type="password" autocomplete="new-password"></div>
      <label class="fs-chk arc-hn"><input type="checkbox" name="encryptNames" value="1"> <span>${esc(t("连文件名一起加密（7z）"))}</span></label>
      <div class="tiny mp-note">${esc(t("zip 加密用 AES-256；老的解压软件可能打不开，要通用就别设密码。.ssh 这类凭据目录不会打进去。"))}</div>`, t("压缩"));
    if (!v) return;
    const ext = (ARC_FORMATS.find(([f]) => f === v.format) || ARC_FORMATS[0])[1];
    let name = String(v.name || "").trim();
    if (!name || badName(name)) return toast(t("名称里不能有 /"), true);
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    try { localStorage.setItem("cc.arc.fmt", v.format); } catch {}
    const tar = v.format.startsWith("tar");
    arcRunJob("create", { items: names.map((n) => dir + "/" + n), dest: dir + "/" + name, format: v.format, level: +v.level,
      password: tar ? undefined : v.password || undefined, encryptNames: v.format === "7z" && !!v.encryptNames }, dir + "/" + name);
  }
  // 格式换成 tar.* 时密码那栏没用，藏起来
  document.addEventListener("change", (e) => {
    const s = e.target.closest('#arc-dlg select[name="format"]');
    if (!s) return;
    const f = s.closest("form");
    f.querySelector(".arc-pw").classList.toggle("hidden", s.value.startsWith("tar"));
    f.querySelector(".arc-hn").classList.toggle("hidden", s.value !== "7z");
  });

  /** 后台任务（解压 / 压缩）：页脚显示进度，可取消；做完刷新当前目录 */
  async function arcRunJob(kind, body, dest) {
    let j;
    try { j = await arcPost(kind, body); }
    catch (e) {
      return toast(e.status === 409 ? t("已经有同名的文件或文件夹") : e.status === 403 ? t("不能解压或压缩到这个位置") : e.status === 501 ? t("这个版本没带 7-Zip")
        : (e.body && e.body.error) === "dest inside source" ? t("压缩包不能放进要压缩的文件夹里") : t("操作失败：{msg}", { msg: e.message }), true);
    }
    const box = $("fs-job");
    const label = kind === "extract" ? t("解压中") : t("压缩中");
    box.classList.remove("hidden");
    box.innerHTML = `<span class="tiny fs-job-t">${esc(label)}…</span><button class="btn ghost sm" type="button">${esc(t("取消"))}</button>`;
    box.querySelector("button").onclick = () => arcPost("cancel", { id: j.id }).catch(() => {});
    while (j.state === "running") {
      await new Promise((r) => setTimeout(r, 600));
      try { j = await api("/api/arc/job?id=" + encodeURIComponent(j.id)); } catch { break; }
      const tx = box.querySelector(".fs-job-t");
      if (tx) tx.textContent = `${label} ${j.pct || 0}%`;
    }
    box.classList.add("hidden"); box.innerHTML = "";
    if (j.state === "done") {
      toast(kind === "extract" ? t("已解压到 {path}", { path: dest }) : t("已压缩为 {path}", { path: dest }));
      if (state.fs.multi) { state.fs.multi = null; }
      if (!state.fs.arc && !filesEl.classList.contains("hidden")) await fsLoad(state.fs.path, { keepSel: true });
      else renderFs();
    } else if (j.state === "cancelled") toast(t("已取消"));
    else if (j.wrongPassword) {
      if (kind === "extract") {
        const pw = await arcAskPassword(body.path.split("/").pop(), !!body.password);
        if (pw != null) { if (state.fs.arc && state.fs.arc.path === body.path) state.fs.arc.password = pw; arcRunJob(kind, { ...body, password: pw }, dest); }
      } else toast(t("密码不对"), true);
    } else toast(j.code === "ENOSPC" ? t("存储空间不够") : t("操作失败：{msg}", { msg: j.error || "?" }), true);
  }

  // 多选：普通目录里压缩选中的，包里解压选中的
  $("fs-multi").addEventListener("click", () => {
    state.fs.multi = state.fs.multi ? null : new Set();
    state.fs.sel = null;
    renderFs();
  });
  $("fs-act").addEventListener("click", () => {
    const m = state.fs.multi;
    if (!m || !m.size) return;
    const names = [...m];
    if (state.fs.arc) arcExtractDlg({ path: state.fs.arc.path, entries: names.map((n) => arcJoin(state.fs.arc.dir, n)) });
    else arcCreateDlg(names);
  });

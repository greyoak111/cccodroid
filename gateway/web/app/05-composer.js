  // ── 发送 ──────────────────────────────────────────────────────────
  const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  async function send(forcedText, mode) {
    const fromInput = forcedText == null;
    const typed = (fromInput ? inputEl.value : forcedText).trim();
    // 附件只在附件栏里显示，发出时才把 @路径 接到末尾（claude 靠它读文件）；手动写过的不重复
    const refs = fromInput ? state.attachments.map((a) => "@" + a.path).filter((r) => !typed.includes(r)) : [];
    const text = typed && refs.length ? typed + "\n\n" + refs.join(" ") : typed || refs.join(" ");
    if (!text) return;
    if (fromInput) draftLast = "";      // 发出去的不算「误删」：有的输入法清空后还会补一个空的 input 事件
    hidePopup();
    backToLatest();                     // 正看着中间某一章：先回到最新，新消息才看得见

    // 纯界面命令：不惊动 claude
    if (typed === "/clear" || typed === "/new") {
      if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
      newConversation(t("已清空上下文，开始新会话"));
      return;
    }
    // 官方账户登录：OAuth 全程由 claude 自己完成，网关只转递授权页地址；授权码不经手（要贴码就在终端里贴给 claude）
    if (text === "/login" || text === "/login console" || text.startsWith("/login ")) {
      if (fromInput) { inputEl.value = ""; autoGrow(); }
      const arg = text.slice(6).trim();
      const post = (p, body) => api(p, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      try {
        addNote(t("正在启动登录…"));
        const j = await post("/api/login/start", { method: arg === "console" ? "console" : "claudeai" });
        if (!j.ok) throw new Error(j.message || t("启动登录失败"));
        addSysMsg(t("在浏览器打开下面的地址完成授权，授权后浏览器跳回本机，登录自动完成：") + `\n\n[${j.url}](${j.url})\n\n` +
          t("浏览器跳不回来（比如在别的设备上授权）：打开终端运行 {cmd}，把页面给出的授权码直接贴给 claude。", { cmd: "`claude auth login`" }), "/login");
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (text.startsWith("/rename ")) {
      if (!view.sessionId) return toast(t("当前还没有会话"), true);
      try {
        await api(`/api/session/${encodeURIComponent(view.sessionId)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: text.slice(8).trim() }),
        });
        if (fromInput) { inputEl.value = ""; autoGrow(); }
        toast(t("已重命名")); loadSessions();
      } catch (e) { toast(e.message, true); }
      return;
    }

    const cid = newCid();
    view.cids.add(cid);
    const sentAtt = fromInput ? state.attachments : [];
    if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
    syncInterject();
    try {
      const r = await api("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: view.sessionId,
          // 新会话还没拿到会话号时连发：告诉网关"跟在上一条后面"，它会接到同一个会话里
          follow: view.sessionId ? null : view.lastRunId,
          projectId: view.sessionId ? null : view.projectId || null,     // 新会话：在项目目录里跑
          pin: view.sessionId ? null : state.pendingModel || null,       // 新会话在面板里单独选的模型 / 思考强度
          cid,
          mode: mode || "auto",
        }),
      });
      view.runIds.add(r.id);
      view.lastRunId = r.id;
      if (r.injected) toast(t("已插话：当前这一步做完，Claude 就会看到"));
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出")
        : srv.run && !srv.run.idle ? t("已排队，这一轮结束后发出") : atCap() ? t("同时在跑的会话已到上限，已排队，有空位就发出") : t("已排队：这个会话的上一轮还没完全结束，结束后发出"));
    } catch (e) {
      view.cids.delete(cid);
      if (fromInput && !inputEl.value) { inputEl.value = typed; autoGrow(); }   // 别把用户的话吞了
      if (fromInput && !state.attachments.length && sentAtt.length) { state.attachments = sentAtt; renderAttachments(); }
      toast(e.message || t("发送失败"), true);
      if (e.status === 503) openDrawer("settings");
    }
  }

  /** 插话：不打断，把输入框里的字递进正在跑的这一轮（claude 在当前这一步结束后就会看到） */
  function interjectNow() {
    if (!hasDraft()) return;
    send(null, "inject");
  }

  async function abort() {
    if (!srv.run) return;
    try { await api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: srv.run.id }) }); }
    catch (e) { toast(e.message, true); }
  }

  // ── 补全浮层（/ 命令 与 @ 文件）───────────────────────────────────
  function hidePopup() {
    MO.hide(popupEl, "mo-out-fade", 120);
    state.popup.mode = null;
    state.popup.items = [];
  }

  // 点浮层和输入框以外的地方就收起（手机上没有 Esc；之前只能删掉那个 / 才关得掉）
  document.addEventListener("pointerdown", (e) => {
    if (!state.popup.mode || popupEl.contains(e.target) || e.target === inputEl) return;
    hidePopup();
  }, true);

  function showPopup(mode, items, head) {
    state.popup.mode = mode;
    state.popup.items = items;
    state.popup.sel = 0;
    popupHead.innerHTML = `<span>${esc(head)}</span><span>${t("{n} 项", { n: items.length })}</span>`;
    renderPopup();
    MO.cancel(popupEl); popupEl.classList.remove("hidden");
    followPopup();
  }
  // 对话这一栏的左右边界：右侧窗格（浏览器是原生视图，永远在页面上面）和常驻侧栏都不算，浮层只能在这里面摆
  // 固定定位真正参照的高度（布局视口）；innerHeight 是可视区，键盘悬浮、缩放时两者不同
  const fixedH = () => document.documentElement.clientHeight || innerHeight;
  function colRect() {
    const r = $("chat").getBoundingClientRect();
    return r.width > 0 ? { left: r.left, right: r.right, width: r.width } : { left: 0, right: innerWidth, width: innerWidth };
  }
  // 补全浮层贴着输入框上沿、和输入框一样宽 —— 首屏输入框在屏幕中间，平常在底部，都跟着走
  // 输入框会动：首屏 ↔ 平常、多行长高、软键盘起落、附件栏、右侧窗格开合、分屏改宽……
  // 浮层开着时每帧对一次输入框和对话栏的位置，变了才重摆；收起就停
  let popKey = "", popRaf = 0;
  function followPopup() {
    cancelAnimationFrame(popRaf); popKey = "";
    const tick = () => {
      if (popupEl.classList.contains("hidden")) { popRaf = 0; return; }
      placePopup();
      popRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function placePopup() {
    const c = $("composer-inner").getBoundingClientRect(), col = colRect(), top = $("chat").getBoundingClientRect().top;
    if (!c.width) return;
    const key = [c.left, c.right, c.top, col.left, col.right, top].map(Math.round).join();
    if (key === popKey) return;
    popKey = key;
    const left = Math.max(col.left + 8, c.left), right = Math.min(col.right - 8, c.right);
    // 用 top 从输入框上沿往上量，不用 bottom：软键盘悬浮 / 可视区缩放时 innerHeight 和固定定位的参照高度对不上，会压住输入框
    const maxH = Math.max(120, Math.min(fixedH() * 0.46, c.top - top - 8));   // 不盖顶栏
    Object.assign(popupEl.style, { left: left + "px", right: "auto", width: (right - left) + "px", bottom: "auto", maxHeight: maxH + "px" });
    popupEl.style.top = Math.max(top, c.top - 8 - popupEl.offsetHeight) + "px";
  }

  function renderPopup() {
    const { items, sel } = state.popup;
    let html = "", lastCat = null;
    items.forEach((it, i) => {
      if (it.cat && it.cat !== lastCat) { html += `<div class="pgroup">${esc(it.cat)}</div>`; lastCat = it.cat; }
      html += `<div class="pitem ${i === sel ? "sel" : ""}" data-i="${i}">` +
        `<span class="pi-name ${state.popup.mode === "cmd" ? "cmd" : ""}">${esc(it.label)}</span>` +
        (it.cat && state.popup.mode === "file" ? `<span class="pi-cat">${it.dir ? t("目录") : t("文件")}</span>` : "") +
        (it.desc ? `<span class="pi-desc">${esc(it.desc)}</span>` : "") +
        `</div>`;
    });
    popupList.innerHTML = html || '<div class="pitem">' + t("没有匹配项") + '</div>';
    popKey = "";
    const selEl = popupList.querySelector(".pitem.sel");
    if (selEl) selEl.scrollIntoView({ block: "nearest" });
  }

  function openCmdPalette(filter) {
    const caps = state.caps;
    const cmds = (caps?.slashCommands || []).filter((c) => !filter || c.name.includes(filter));
    showPopup("cmd", cmds.map((c) => ({ label: "/" + c.name, desc: c.desc ? t(c.desc) : "", cat: c.cat && t(c.cat), raw: c.name })),
      t("斜杠命令") + (filter ? t(" · 匹配 “{q}”", { q: filter }) : ""));
  }

  async function openFilePalette(filter) {
    const dir = state.fileDir || state.settings.workspace || "/sdcard";
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(filter || "")}`);
      state.fileDir = r.path;
      const items = r.entries.map((e) => ({
        label: e.name + (e.dir ? "/" : ""),
        dir: e.dir,
        cat: r.path,
        raw: e.name,
      }));
      if (r.parent && r.parent !== r.path) items.unshift({ label: "..", dir: true, cat: r.path, raw: ".." });
      showPopup("file", items, t("引用文件 · {path}", { path: r.path }));
    } catch { hidePopup(); }
  }

  function applyPopupChoice(i) {
    const it = state.popup.items[i];
    if (!it) return;
    if (state.popup.mode === "cmd") {
      inputEl.value = "/" + it.raw + " ";
      hidePopup(); autoGrow(); inputEl.focus();
      return;
    }
    if (state.popup.mode === "file") {
      if (it.dir) { openFilePalette(""); return; }
      const base = state.fileDir || "";
      const full = base.replace(/\/$/, "") + "/" + it.raw;
      const v = inputEl.value;
      const at = v.lastIndexOf("@");
      inputEl.value = (at >= 0 ? v.slice(0, at) : v) + "@" + full + " ";
      hidePopup(); autoGrow(); inputEl.focus();
    }
  }

  // ── 输入框 ────────────────────────────────────────────────────────
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }

  /** 在光标处插入一段文本 */
  function insertAtCursor(s) {
    const v = inputEl.value, caret = inputEl.selectionStart ?? v.length;
    const before = v.slice(0, caret), after = v.slice(caret);
    const glue = before && !/\s$/.test(before) ? " " : "";
    inputEl.value = before + glue + s + " " + after;
    const pos = (before + glue + s + " ").length;
    try { inputEl.setSelectionRange(pos, pos); } catch {}
    autoGrow();
  }

  // ── 草稿找回（上游 2.1.288：Ctrl+C 清掉的输入，空输入框按 ↑ 找回）──
  // 手机上更常见的是误删、全选后删空：一段 8 个字以上的内容被删空（不是发出去的），输入框下面亮一个「恢复」，20 秒后消失
  const draftChip = $("draft-chip");
  let draftLast = "", draftStash = "", draftT = null;
  function draftOffer(text) {
    draftStash = text;
    draftChip.classList.remove("hidden");
    clearTimeout(draftT);
    draftT = setTimeout(() => draftChip.classList.add("hidden"), 20000);
  }
  function draftRestore() {
    if (!draftStash || inputEl.value) return false;
    inputEl.value = draftStash;
    draftStash = ""; draftLast = inputEl.value;
    draftChip.classList.add("hidden");
    autoGrow(); syncInterject(); inputEl.focus();
    return true;
  }
  draftChip.addEventListener("click", draftRestore);

  inputEl.addEventListener("input", () => {
    autoGrow();
    syncInterject();
    const v = inputEl.value;
    // 逐字退格时保留删之前最长的那版；改成别的内容才换掉
    if (v) { if (v.length >= draftLast.length || !draftLast.startsWith(v)) draftLast = v; if (v.trim()) draftChip.classList.add("hidden"); }
    else if (draftLast.trim().length >= 8) { draftOffer(draftLast); draftLast = ""; }
    const caret = inputEl.selectionStart;
    const before = v.slice(0, caret);

    const cmdM = before.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (cmdM) { openCmdPalette(cmdM[1]); return; }
    const atM = before.match(/@([^\s@]*)$/);
    if (atM) { openFilePalette(atM[1]); return; }
    hidePopup();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!popupEl.classList.contains("hidden") && state.popup.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.popup.sel = (state.popup.sel + 1) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); state.popup.sel = (state.popup.sel - 1 + state.popup.items.length) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) {
        e.preventDefault(); applyPopupChoice(state.popup.sel); return;
      }
      if (e.key === "Escape") { hidePopup(); return; }
    }
    if (e.key === "ArrowUp" && !inputEl.value && draftStash) { e.preventDefault(); draftRestore(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (enterSends() || e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  // 回车键：默认发送；手机软键盘没有 Shift，想多行输入的可以改成回车换行（Ctrl + 回车或发送键发出）
  const enterSends = () => localStorage.getItem("cc.enterKey") !== "newline";
  function applyEnterKey() { inputEl.enterKeyHint = enterSends() ? "send" : "enter"; $("set-enter").value = enterSends() ? "send" : "newline"; }
  $("set-enter").addEventListener("change", (e) => {
    localStorage.setItem("cc.enterKey", e.target.value);
    applyEnterKey();
    toast(enterSends() ? t("回车直接发送") : t("回车换行，Ctrl + 回车或点发送键发出"));
  });
  applyEnterKey();

  // 粘贴：剪贴板里是图片就直接落盘成路径
  inputEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (!files.length) return;             // 纯文本粘贴，走默认行为
    e.preventDefault();
    await uploadFiles(files);
  });

  popupList.addEventListener("click", (e) => {
    const it = e.target.closest(".pitem");
    if (it?.dataset.i != null) applyPopupChoice(Number(it.dataset.i));
  });

  // 有字就发（忙时自动排队）；没字且正在生成 = 停止
  sendEl.addEventListener("click", () => (hasDraft() || !isBusy() ? send() : abort()));
  interjectEl.addEventListener("click", interjectNow);

  // ── 递东西进来：上传 ──────────────────────────────────────────────
  /// 新建附件条（点回形针/粘贴/拖放都汇到这里）
  const attachStrip = document.createElement("div");
  attachStrip.id = "attach-strip";
  attachStrip.className = "hidden";
  $("composer").insertBefore(attachStrip, $("composer-inner"));
  setTimeout(() => { if (state.attachments.length) renderAttachments(); });

  // 附件栏记在 sessionStorage：冻结脱困 / 重新载入后照原样恢复（文件已经在设备上，只记路径）
  const ATT_KEY = "cc.att";
  try { const a = JSON.parse(sessionStorage.getItem(ATT_KEY) || "[]"); if (Array.isArray(a) && a.length) state.attachments = a.filter((x) => x && x.path); } catch {}
  function renderAttachments() {
    const list = state.attachments;
    try { list.length ? sessionStorage.setItem(ATT_KEY, JSON.stringify(list)) : sessionStorage.removeItem(ATT_KEY); } catch {}
    attachStrip.classList.toggle("hidden", !list.length);
    attachStrip.innerHTML = list.map((a, i) => `
      <div class="att" data-i="${i}">
        ${a.kind === "image"
          ? `<img src="${fileUrl(a.path)}" alt="">`
          : `<span class="att-ico">${esc((a.name.split(".").pop() || "?").slice(0, 4))}</span>`}
        <span class="att-name">${esc(a.name)}</span>
        <button class="att-x" aria-label="${t("移除")}">${uiI("x")}</button>
      </div>`).join("");
    syncInterject();
    attachStrip.querySelectorAll(".att").forEach((el) => {
      const a = list[Number(el.dataset.i)];
      el.querySelector("img")?.addEventListener("click", () => openLightbox(a.path));
      el.querySelector(".att-x").addEventListener("click", () => removeAttachment(a));
    });
  }
  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }
  function removeAttachment(a) {
    state.attachments = state.attachments.filter((x) => x.path !== a.path);
    renderAttachments();
  }
  /** 输入框有字或附件栏里有东西，就算有话要发 */
  function hasDraft() { return !!inputEl.value.trim() || state.attachments.length > 0; }

  /** 上传一批文件，成功后放进附件栏（发出时才把路径接进消息） */
  async function uploadFiles(files, { insert = true } = {}) {
    const list = [...files];
    if (!list.length) return [];
    const done = [];
    for (const f of list) {
      try {
        const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name || "upload.bin"), {
          method: "POST",
          body: f,           // 直接流式送 File，fetch 自己带 content-type
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        done.push(j);
        if (insert) {
          state.attachments.push(j);
        }
      } catch (e) {
        toast(t("「{name}」附加失败：{msg}", { name: f.name, msg: e.message }), true);
      }
    }
    if (done.length) {
      renderAttachments();
      toast(t("已附加 {n} 个文件", { n: done.length }));
    }
    return done;
  }

  // 安卓壳递进来的东西：别的应用「分享到 Claude CLI」，或系统选择器的结果
  window.addEventListener("ccapp-attach", (e) => {
    const p = e.detail?.value;
    if (!p) return;
    const name = p.split("/").pop();
    state.attachments.push({
      path: p, name, size: 0,
      kind: /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(p) ? "image" : "other",
    });
    renderAttachments();
    toast(t("已附加 {name}", { name }));
  });
  window.addEventListener("ccapp-insert", (e) => {
    const v = e.detail?.value;      // 别叫 t：会遮住翻译函数，下面那句提示就抛「t is not a function」
    if (!v) return;
    insertAtCursor(v);
    toast(t("已插入分享的内容"));
  });

  // 三扇门：点回形针 / 设置里选 / ＋ 面板
  function pickFiles() { fileInput.click(); }
  fileInput.addEventListener("change", async () => {
    await uploadFiles(fileInput.files);
    fileInput.value = "";
  });
  // 拍照：外壳已缩到长边 2048 并转正，这里照普通附件传
  $("cam-input").addEventListener("change", async (e) => {
    await uploadFiles(e.target.files);
    e.target.value = "";
  });
  $("btn-attach").addEventListener("click", pickFiles);
  $("fs-pick").addEventListener("click", pickFiles);

  // 拖放（接了鼠标键盘的平板 / 桌面浏览器）
  const dropEl = $("dropzone");
  let dragDepth = 0;
  function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes("Files"); }
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++;
    dropEl.classList.remove("hidden");
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.add("hidden"); }
  });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; dropEl.classList.add("hidden");
    await uploadFiles(e.dataTransfer.files);
  });


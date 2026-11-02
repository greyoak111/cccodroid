  // ── 发送 ──────────────────────────────────────────────────────────
  // 附件大小门限（与 App 壳 MainActivity.BIG_ATTACH 同值）：超过的不写成 @路径 —— claude 见到 @路径 会把整份读进上下文，
  // 几百 MB 的东西读不进还白占一轮；只写路径和大小，用到时让它自己按路径读（解压、抽样、跑脚本）。这句落款各语言都写中文，气泡按它认（02 splitRefs）
  const BIG_ATT = 20 << 20;
  const isBigAtt = (a) => !!a.big || a.size > BIG_ATT;
  const attRef = (a) => isBigAtt(a) ? `[附件：${a.path} · ${a.size ? fmtSize(a.size) : "?"}，文件较大没有直接读入，需要时按路径读取]` : "@" + a.path;
  const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  async function send(forcedText, mode) {
    const fromInput = forcedText == null;
    const typed = (fromInput ? inputEl.value : forcedText).trim();
    // 附件只在附件栏里显示，发出时才把 @路径 接到末尾（claude 靠它读文件）；手动写过的不重复
    // 大附件只给路径（见 attRef），Claude 用到时自己按路径读
    const refs = fromInput ? state.attachments.map(attRef).filter((r) => !typed.includes(r)) : [];
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
      const rgen = view.gen;
      try {
        await api(`/api/session/${encodeURIComponent(view.sessionId)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: text.slice(8).trim() }),
        });
        // 等回执期间又写了新草稿：别把它清掉（审查 #50 S2-01）
        // 切过会话的话，输入框里同样的字是那边新写的，也不清（审查 #52 S2-01）
        if (fromInput && rgen === view.gen && inputEl.value.trim() === typed) { inputEl.value = ""; autoGrow(); }
        toast(t("已重命名")); loadSessions();
      } catch (e) { toast(e.message, true); }
      return;
    }

    const cid = newCid();
    view.cids.add(cid);
    lastSendAt = Date.now();   // 点下就记：run_start 可能比 POST 回执先到，等回执再记的话双击那一下会被当成「停止」（审查 v0.5.4 F1 残余）
    const sentAtt = fromInput ? state.attachments : [];
    if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
    syncInterject();
    const gen = view.gen;
    // 新会话第一条的回执还没到就又发：等它回来，拿到 run 号再带着 follow 发，不然两条各起一个会话（审查 #51 第1项）
    // 最多等 15 秒：网关半死、回执一直不来时别让后面的消息无声排着（审查 v0.5.4 F-L1）
    const prior = !view.sessionId && !view.lastRunId ? view.firstSend : null;
    let done;
    if (!view.sessionId) view.firstSend = new Promise((ok) => (done = ok));
    try {
      if (prior) {
        const r0 = await Promise.race([prior, new Promise((ok) => setTimeout(() => ok("timeout"), 15000))]);
        if (gen !== view.gen) throw Object.assign(new Error(t("会话已切换，这条没发")), { moved: true });
        // 等满 15 秒前一条还没拿到 run 号：硬发出去就是另起一个会话，宁可明说没发（审查 #52 #51:1）
        if (r0 === "timeout" && !view.sessionId && !view.lastRunId) throw new Error(t("上一条还没送到网关，这条先没发，稍后再试"));
      }
      const r = await api("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: view.sessionId,
          // 新会话还没拿到会话号时连发：告诉网关"跟在上一条后面"，它会接到同一个会话里
          follow: view.sessionId ? null : view.lastRunId,
          projectId: view.sessionId ? null : view.projectId || null,     // 新会话：在项目目录里跑
          pin: view.sessionId ? null : state.pendingModel || null,       // 新会话在面板里单独选的模型 / 思考强度
          // 脉络汇合开出来的新会话：第一条带上来源，网关拿到会话号时记下（gw/merge.mjs）
          mergeFrom: !view.sessionId && !view.lastRunId ? view.pendingMerge || null : null,
          cid,
          mode: mode || "auto",
        }),
      });
      // 等回执期间切了会话：这一轮属于原来那个会话，别记进现在的视图（否则它的回复渲染到这边，
      // 下一条新会话消息还会带着 follow 接进原来那一轮 —— 审查 中11）
      if (gen !== view.gen) return;
      view.runIds.add(r.id);
      view.lastRunId = r.id;
      view.pendingMerge = null;
      lastSendAt = Date.now();
      if (r.injected) toast(t("已插话：当前这一步做完，Claude 就会看到"));
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出")
        : srv.run && !srv.run.idle ? t("已排队，这一轮结束后发出") : atCap() ? t("同时在跑的会话已到上限，已排队，有空位就发出") : t("已排队：这个会话的上一轮还没完全结束，结束后发出"));
    } catch (e) {
      view.cids.delete(cid);
      // 别把用户的话吞了。但回执迟到时可能已经切到别的对话、或者又写了新草稿：那就不往输入框里塞，给个「找回」（审查 A-CHAT-001、#50 S2-01）
      if (fromInput && gen === view.gen && !inputEl.value.trim() && !state.attachments.length) {
        inputEl.value = typed; autoGrow();
        if (sentAtt.length) { state.attachments = sentAtt; renderAttachments(); }
        syncInterject();
        toast(e.message || t("发送失败"), true);
      } else if (fromInput) {
        toastAct(t("没发出去：{msg}", { msg: e.message || t("发送失败") }), t("找回"), () => {
          inputEl.value = inputEl.value.trim() ? inputEl.value.replace(/\s*$/, "\n\n") + typed : typed;
          for (const a of sentAtt) if (!state.attachments.some((x) => x.path === a.path)) state.attachments.push(a);
          renderAttachments(); autoGrow(); inputEl.focus();
        });
      } else toast(e.message || t("发送失败"), true);
      if (e.status === 503 && gen === view.gen) openDrawer("settings");
    } finally { if (done) done(); }
  }
  let lastSendAt = 0;

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
    dropReq("filepal");
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
      html += `<div class="pitem ${i === sel ? "sel" : ""}${it.manage ? " pi-manage" : ""}" data-i="${i}">` +
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
    dropReq("filepal");   // 在途的 @ 文件请求作废：整段换成 /xx 时它迟到会把命令面板盖成文件面板（审查 #52 A-CHAT-003）
    const caps = state.caps;
    // 常用指令（自己存的 commands/*.md）排在最前；说明是用户自己写的，不过翻译。没在筛选时顶上放一个「管理常用指令…」
    const all = (caps?.slashCommands || []).filter((c) => !filter || c.name.includes(filter));
    const cmds = all.filter((c) => c.custom).concat(all.filter((c) => !c.custom));
    const items = cmds.map((c) => ({ label: "/" + c.name, desc: c.custom ? [c.desc, c.hint].filter(Boolean).join(" · ") : c.desc ? t(c.desc) : "", cat: c.cat && t(c.cat), raw: c.name }));
    if (!filter) items.unshift({ label: t("管理常用指令…"), desc: t("把常发的长提示存成 /指令"), cat: t("常用指令"), raw: "", manage: true });
    showPopup("cmd", items,
      t("斜杠命令") + (filter ? t(" · 匹配 “{q}”", { q: filter }) : ""));
  }

  async function openFilePalette(filter) {
    const dir = state.fileDir || state.settings.workspace || "/sdcard";
    const ok = latest("filepal");    // 慢的旧请求迟到不许盖掉新的、也不许把已收起的浮层重新打开（审查 A-CHAT-003）
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(filter || "")}`);
      if (!ok()) return;
      state.fileDir = r.path;
      state.fileParent = r.parent || null;
      const items = r.entries.map((e) => ({
        label: e.name + (e.dir ? "/" : ""),
        dir: e.dir,
        cat: r.path,
        raw: e.name,
      }));
      if (r.parent && r.parent !== r.path) items.unshift({ label: "..", dir: true, cat: r.path, raw: ".." });
      showPopup("file", items, t("引用文件 · {path}", { path: r.path }));
    } catch { if (ok()) hidePopup(); }
  }
  /** 把光标前正在补全的那一截（/xx 或 @xx）换成 s，前后的草稿原样留着（审查 A-CHAT-004） */
  function replaceToken(re, s) {
    const v = inputEl.value, caret = inputEl.selectionStart ?? v.length;
    const before = v.slice(0, caret), after = v.slice(caret);
    const m = before.match(re);
    const head = m ? before.slice(0, m.index + (m[1] || "").length) : before;
    inputEl.value = head + s + after;
    const pos = (head + s).length;
    try { inputEl.setSelectionRange(pos, pos); } catch {}
  }
  const CMD_TOKEN = /(^|\s)\/[a-zA-Z0-9_-]*$/, AT_TOKEN = /()@[^\s@]*$/;

  function applyPopupChoice(i) {
    const it = state.popup.items[i];
    if (!it) return;
    if (state.popup.mode === "cmd") {
      if (it.manage) {
        replaceToken(CMD_TOKEN, ""); hidePopup(); autoGrow();
        openPage("ext");
        setTimeout(() => { const sec = $("ext-cmd-sec"); if (sec) { sec.open = true; sec.scrollIntoView({ block: "start", behavior: "smooth" }); } }, 60);
        return;
      }
      replaceToken(CMD_TOKEN, "/" + it.raw + " ");
      hidePopup(); autoGrow(); inputEl.focus();
      return;
    }
    if (state.popup.mode === "file") {
      const base = state.fileDir || "";
      // 点目录 / ..：真的进去（以前一直重新请求原目录，审查 A-CHAT-002），输入框里的筛选词清掉
      if (it.dir) {
        state.fileDir = it.raw === ".." ? (state.fileParent || base) : base.replace(/\/$/, "") + "/" + it.raw;
        replaceToken(AT_TOKEN, "@"); openFilePalette(""); inputEl.focus();
        return;
      }
      const full = base.replace(/\/$/, "") + "/" + it.raw;
      replaceToken(AT_TOKEN, "@" + full + " ");
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
    autoGrow(); syncInterject();      // 不经 input 事件：按钮的发送 / 停止要自己对一下（审查 #50 S2-09）
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
    // 一项都没匹配上时也要能 Esc 关掉（审查 #48 03-F04）
    if (e.key === "Escape" && !popupEl.classList.contains("hidden")) { e.preventDefault(); hidePopup(); return; }
    if (!popupEl.classList.contains("hidden") && state.popup.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.popup.sel = (state.popup.sel + 1) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); state.popup.sel = (state.popup.sel - 1 + state.popup.items.length) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) {
        e.preventDefault(); applyPopupChoice(state.popup.sel); return;
      }
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
  // 刚发出的那一下之后紧跟的第二下（双击、手抖）不算「停止」：不然会把刚发的这一轮杀掉（审查 v0.5.3 F1）
  sendEl.addEventListener("click", () => (hasDraft() || !isBusy() ? send() : Date.now() - lastSendAt < 1500 ? null : abort()));
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
        ${a.kind === "image" && !isBigAtt(a)
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
  // ── 每个会话各有各的草稿（群友反馈：输入框里没发的字、附件，切会话会跟着带过去）──
  // 切走时把输入框和附件栏记在原会话名下（新对话记在 ""），切到哪个就换上哪个的；记在 localStorage，重开应用也在。
  // 只在用户切会话（openSession）时换；重连、新会话拿到会话号都不经过这里，正在打的字不会被换掉
  const DRAFTS_KEY = "cc.drafts";
  function draftsRead() { try { const o = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } }
  let draftEpoch = 0;   // 换过几次会话草稿：上传回执据此判断附件栏还是不是发起时那个会话的
  function draftSwap(from, to) {
    const all = draftsRead(), k0 = from || "", k1 = to || "";
    if (k0 === k1) return;
    draftEpoch++;
    const text = inputEl.value, att = state.attachments.slice();
    if (text.trim() || att.length) all[k0] = { text, att, at: Date.now() }; else delete all[k0];
    const d = all[k1];
    delete all[k1];
    const keys = Object.keys(all).sort((x, y) => (all[y].at || 0) - (all[x].at || 0));
    for (const k of keys.slice(30)) delete all[k];
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
    inputEl.value = d && typeof d.text === "string" ? d.text : "";
    state.attachments = d && Array.isArray(d.att) ? d.att.filter((x) => x && x.path) : [];
    renderAttachments(); autoGrow();
    draftLast = inputEl.value; draftStash = ""; draftChip.classList.add("hidden");   // 「恢复误删」是上一个会话的，别带过来
  }
  /** 输入框有字或附件栏里有东西，就算有话要发 */
  function hasDraft() { return !!inputEl.value.trim() || state.attachments.length > 0; }

  /** 上传一批文件，成功后放进附件栏（发出时才把路径接进消息） */
  async function uploadFiles(files, { insert = true } = {}) {
    const list = [...files];
    if (!list.length) return [];
    const done = [];
    // 上传途中切了会话：回执要落回发起的那个会话的草稿，不能塞进现在这个（审查 B08）
    const ep0 = draftEpoch, key0 = view.sessionId || "";
    const mine = () => draftEpoch === ep0 || (view.sessionId || "") === key0;
    let away = 0;
    for (const f of list) {
      // 大文件（粘贴 / 拖进来的；从选择器挑的 App 壳已经分流了）：网关流式落盘，这里只提示一下要等
      if (f.size > BIG_ATT) toast(t("「{name}」较大（{s}），正在收进工作区…", { name: f.name, s: fmtSize(f.size) }));
      try {
        const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name || "upload.bin"), {
          method: "POST",
          body: f,           // 直接流式送 File，fetch 自己带 content-type
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        done.push(j);
        if (insert && mine()) state.attachments.push(j);
        else if (insert) {
          const all = draftsRead(), d = all[key0] || { text: "", att: [] };
          d.att = [...(Array.isArray(d.att) ? d.att : []), j]; d.at = Date.now(); all[key0] = d;
          try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
          away++;
        }
      } catch (e) {
        toast(t("「{name}」附加失败：{msg}", { name: f.name, msg: e.message }), true);
      }
    }
    if (done.length) {
      renderAttachments();
      // 一部分落在这里、一部分回了原会话：两句都说（DeepSeek 复核 低-6）
      const here = done.length - away;
      toast([here ? t("已附加 {n} 个文件", { n: here }) : "", away ? t("{n} 个文件已附加到刚才那个会话的草稿", { n: away }) : ""].filter(Boolean).join("；"));
    }
    return done;
  }

  // 安卓壳递进来的东西：别的应用「分享到 Claude CLI」，或系统选择器的结果
  function attachPath(p, from) {
    if (!p) return;
    const name = p.split("/").pop();
    // 大小先不知道：按大附件算（不出缩略图、发出去只给路径），问到大小再改
    const a = { path: p, name, size: 0, big: true, kind: /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(p) ? "image" : "other" };
    // 选择器里挑的大文件要在后台拷一阵：拷完时已经切到别的会话了，落回打开选择器那个会话的草稿（#105 06-014，同 uploadFiles）
    if (from && from.ep !== draftEpoch && (view.sessionId || "") !== from.key) {
      const all = draftsRead(), d = all[from.key] || { text: "", att: [] };
      d.att = [...(Array.isArray(d.att) ? d.att : []), a]; d.at = Date.now(); all[from.key] = d;
      try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
      return toast(t("{n} 个文件已附加到刚才那个会话的草稿", { n: 1 }));
    }
    state.attachments.push(a);
    renderAttachments();
    api("/api/file/stat?path=" + encodeURIComponent(p)).then((r) => { a.size = r.size || 0; a.big = false; renderAttachments(); }, () => {});
    toast(t("已附加 {name}", { name }));
  }
  let pickFrom = null;      // 最近一次打开选择器时的草稿（会话号 + 换草稿的代次）
  window.addEventListener("ccapp-attach", (e) => attachPath(e.detail?.value, null));
  window.addEventListener("ccapp-attach-pick", (e) => attachPath(e.detail?.value, pickFrom));
  window.addEventListener("ccapp-insert", (e) => {
    const v = e.detail?.value;      // 别叫 t：会遮住翻译函数，下面那句提示就抛「t is not a function」
    if (!v) return;
    insertAtCursor(v);
    toast(t("已插入分享的内容"));
  });

  // 三扇门：点回形针 / 设置里选 / ＋ 面板
  function pickFiles() { pickFrom = { ep: draftEpoch, key: view.sessionId || "" }; fileInput.click(); }
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


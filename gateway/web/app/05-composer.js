  // ── 发送 ──────────────────────────────────────────────────────────
  // 附件大小门限（与 App 壳 MainActivity.BIG_ATTACH 同值）：超过的不写成 @路径 —— claude 见到 @路径 会把整份读进上下文，
  // 几百 MB 的东西读不进还白占一轮；只写路径和大小，用到时让它自己按路径读（解压、抽样、跑脚本）。这句落款各语言都写中文，气泡按它认（02 splitRefs）
  const BIG_ATT = 20 << 20;
  const isBigAtt = (a) => !!a.big || a.size > BIG_ATT;
  // 带空白的路径要用引号包起来：@ 提及按空白截断，不包的话 claude 只拿到前半截（0.6.9 审计 195-D.2）
  // 引号里要转义完整：反斜杠不转义会把后面的字吃掉，换行 / 回车 / 制表符留在引号里会把这一行拆开（稳定性报告 FIND-028）
  // 转义规则与 02-chat-view.js splitRefs 的反解析一一对应
  const attAt = (p) => (/[\s"\\]/.test(p) ? '@"' + p
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"' : "@" + p);
  const attRef = (a) => isBigAtt(a) ? `[附件：${a.path} · ${a.size ? fmtSize(a.size) : "?"}，文件较大没有直接读入，需要时按路径读取]` : attAt(a.path);
  const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 还在上传的文件（0.6.9 审计 195-D.1）：传完之前不发送，否则这些附件不在本条消息里、下一条又悄悄带上
  const uploading = new Set();
  let uploadSeq = 0;

  async function send(forcedText, mode) {
    const fromInput = forcedText == null;
    if (fromInput && uploading.size) return void toast(t("还有 {n} 个文件正在上传，传完再发送。", { n: uploading.size }), true);
    // 安卓壳在后台把选择器里的大文件收进工作区（不经网页，见 MainActivity.attachBig）：收完之前也不许发送，
    // 否则这些附件不在本条消息里、下一条又悄悄带上（稳定性报告 FIND-027）
    if (fromInput && pickCopy) return void toast(t("还有 {n} 个文件正在上传，传完再发送。", { n: pickCopy }), true);
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
      if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(true); }
      newConversation(t("已清空上下文，开始新会话"));
      return;
    }
    // 下面两个命令按用户打的字认（typed），不看接了附件引用的 text：带着附件时 /rename 会把 @路径 写进标题、
    // /login console 会被当成网页登录（11-04 报告 三）。附件留在附件栏里，下一条照常带上
    // 官方账户登录：OAuth 全程由 claude 自己完成，网关只转递授权页地址；授权码不经手（要贴码就在终端里贴给 claude）
    if (typed === "/login" || typed.startsWith("/login ")) {
      if (fromInput) { inputEl.value = ""; autoGrow(); }
      const arg = typed.slice(6).trim();
      const post = (p, body) => api(p, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      try {
        addNote(t("正在启动登录…"));
        const j = await post("/api/login/start", { method: arg === "console" ? "console" : "claudeai" });
        if (!j.ok) throw new Error(j.message || t("启动登录失败"));
        const bubble = addSysMsg(t("在浏览器打开下面的地址完成授权，授权后浏览器跳回本机，登录自动完成：") + `\n\n[${j.url}](${j.url})\n\n` +
          t("浏览器跳不回来（比如在别的设备上授权）：打开终端运行 {cmd}，把页面给出的授权码直接贴给 claude。", { cmd: "`claude auth login`" }), "/login");
        // OAuth 在应用内 WebView 里会被 Google 等拦：和设置页登录卡一样交给系统浏览器（0.6.9 审计 195-G.1）
        openExternal(j.url);
        bubble.querySelectorAll("a.weblink").forEach((a) => a.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation(); openExternal(a.getAttribute("href"));
        }));
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (typed.startsWith("/rename ")) {
      if (!view.sessionId) return toast(t("当前还没有会话"), true);
      // 发送键连点两下：第一次还没回来时输入框还没清，同一条重命名会再发一遍（稳定性报告 FIND-012）
      if (renameBusy === typed) return;
      renameBusy = typed;
      const rgen = view.gen;
      try {
        await api(`/api/session/${encodeURIComponent(view.sessionId)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: typed.slice(8).trim() }),
        });
        // 等回执期间又写了新草稿：别把它清掉（审查 #50 S2-01）
        // 切过会话的话，输入框里同样的字是那边新写的，也不清（审查 #52 S2-01）
        if (fromInput && rgen === view.gen && inputEl.value.trim() === typed) { inputEl.value = ""; autoGrow(); }
        toast(t("已重命名")); loadSessions();
      } catch (e) { toast(e.message, true); }
      finally { if (renameBusy === typed) renameBusy = ""; }
      return;
    }

    const cid = newCid();
    view.cids.add(cid);
    lastSendAt = Date.now();   // 点下就记：run_start 可能比 POST 回执先到，等回执再记的话双击那一下会被当成「停止」（审查 v0.5.4 F1 残余）
    const sentAtt = fromInput ? state.attachments : [];
    // 这条是从哪个会话的输入框发的：没发出去时正文和附件要回到那里，不能塞进切过去的会话（#174-1）
    const ep0 = draftEpoch, key0 = view.sessionId || "";
    const mine = () => draftEpoch === ep0 || (view.sessionId || "") === draftOwner(ep0, key0);
    if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
    const dk = draftOwner(ep0, key0);
    // 幂等键：该会话 lost 槽里还是这条、还没确认送到 = 同一条重发，沿用原键，网关只跑一轮（FIND-048/036）
    const idem = fromInput ? draftSentIdem(dk, text) || newCid() : newCid();
    // 发出去先留底：POST 悬挂 / 刷新 / 被杀之后原文都还能找回（FIND-035、FIND-010）
    if (fromInput) draftKeepSent(dk, text, sentAtt, idem);
    syncInterject();
    const gen = view.gen;
    // 新会话第一条的回执还没到就又发：等它回来，拿到 run 号再带着 follow 发，不然两条各起一个会话（审查 #51 第1项）
    // 最多等 15 秒：网关半死、回执一直不来时别让后面的消息无声排着（审查 v0.5.4 F-L1）
    const prior = !view.sessionId && !view.lastRunId ? view.firstSend : null;
    let done;
    if (!view.sessionId) view.firstSend = new Promise((ok) => (done = ok));
    let posted = false;   // 真的发出 POST 了没有：没发出去的本地错误（切会话 / 上一条没送到）不能报成「结果未知」
    try {
      if (prior) {
        const r0 = await Promise.race([prior, new Promise((ok) => setTimeout(() => ok("timeout"), 15000))]);
        if (gen !== view.gen) throw Object.assign(new Error(t("会话已切换，这条没发")), { moved: true });
        // 等满 15 秒前一条还没拿到 run 号：硬发出去就是另起一个会话，宁可明说没发（审查 #52 #51:1）
        if (r0 === "timeout" && !view.sessionId && !view.lastRunId) throw new Error(t("上一条还没送到网关，这条先没发，稍后再试"));
      }
      posted = true;
      const r = await api("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        timeout: 20000,   // 入队即回执；网关半死时别永远转圈（FIND-035）
        body: JSON.stringify({
          message: text,
          idem,     // 网关按它在窗口内去重：重发回原 run，不另起一条（FIND-048/036）
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
      // 网关收下了（重发的也算送到了）：留底可以删了
      if (fromInput) draftDropLost(draftOwner(ep0, key0), idem);
      // 等回执期间切了会话：这一轮属于原来那个会话，别记进现在的视图（否则它的回复渲染到这边，
      // 下一条新会话消息还会带着 follow 接进原来那一轮 —— 审查 中11）
      if (gen !== view.gen) return;
      view.runIds.add(r.id);
      view.lastRunId = r.id;
      view.pendingMerge = null;
      // 斜杠命令只在空闲时插进去，送进去就画出来了（gw/run.mjs 的 run.inject），不用再提示
      if (r.duplicate) { /* 网关早就收过这条（重发）：别把「已排队」再说一遍 */ }
      else if (r.injected) { if (!text.trim().startsWith("/")) toast(t("已插话：当前这一步做完，Claude 就会看到")); }
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出")
        : srv.run && !srv.run.idle ? t("已排队，这一轮结束后发出") : srv.run?.sealed ? t("已排队：后台任务还在跑，这一轮收不进新消息了。点「立即发送」会停掉后台任务再发") : atCap() ? t("同时在跑的会话已到上限，已排队，有空位就发出") : t("已排队：这个会话的上一轮还没完全结束，结束后发出"));
    } catch (e) {
      const dk1 = draftOwner(ep0, key0);
      // 回执丢了不代表没发出去：网关收下时发 run_start（带 cid），状态快照的 runs / queue 里也有 cid。
      // 手上已经能看到这枚 cid 就按发送成功收尾，别把原文退回去让人再发一遍（BUG-R04）
      const acceptedId = view.cidRuns.get(cid)
        || (srv.runs.find((r) => r && r.cid === cid) || {}).id
        || (srv.queueAll.find((q) => q && q.cid === cid) || {}).id;
      if (posted && acceptedId) {
        if (fromInput) draftDropLost(dk1, idem);   // 有受理证据，算送到了：留底槽连同幂等键一起收掉
        if (gen === view.gen) {
          view.runIds.add(acceptedId); view.cidRuns.set(cid, acceptedId); view.lastRunId = acceptedId; view.pendingMerge = null;
          toast(t("网关已经收下这条了（只是回执没回来），不用重发"));
        }
        return;
      }
      // 服务端明确回了错误（带 status）才叫没发出去；已经发出 POST 但没有明确回执（断网 / 超时）是结果未知，
      // 不能替用户下结论。没发出去 / 结果未知两种情况下这枚 cid 都还可能再出现，先留着认（BUG-R04）
      if (!posted || e.status) view.cids.delete(cid);
      const msg = e.message || t("发送失败");
      // 已经发出 POST 又没拿到明确回执 = 结果未知；其余（服务端明确拒绝、本地就没发出去）按原样说「没发出去」
      const failTitle = posted && !e.status ? t("不确定发出去没有：{msg}", { msg }) : t("没发出去：{msg}", { msg });
      // 别把用户的话吞了。但回执迟到时可能已经切到别的对话、或者又写了新草稿：那就不往输入框里塞，给个「找回」（审查 A-CHAT-001、#50 S2-01）
      // 留底槽这里不删：原文回了草稿，但它同时是这条消息的幂等键——只有拿到网关回执才算送到（FIND-048：超时后重发不能跑两轮）
      if (fromInput && gen === view.gen && !inputEl.value.trim() && !state.attachments.length) {
        inputEl.value = typed; autoGrow();
        if (sentAtt.length) { state.attachments = sentAtt; renderAttachments(); }
        syncInterject();
        draftPersist();              // 原文已经回输入框：立刻落盘，不留 400ms 空窗
        toast(failTitle, true);
      } else if (fromInput && !mine()) {
        // 已经切到别的会话：直接放回发起那个会话的草稿，回去就能看到；不给「找回」，免得点了塞进眼前这个
        draftPutAway(dk1, typed, sentAtt);
        toast(failTitle + " · " + t("已放回原来那个会话的草稿"), true);
      } else if (fromInput) {
        toastAct(failTitle, t("找回"), () => {
          // 提示条还在、人已经切走了：照样放回原会话的草稿
          if (!mine()) { draftPutAway(draftOwner(ep0, key0), typed, sentAtt); return toast(t("已放回原来那个会话的草稿")); }
          inputEl.value = inputEl.value.trim() ? inputEl.value.replace(/\s*$/, "\n\n") + typed : typed;
          for (const a of sentAtt) if (!state.attachments.some((x) => x.path === a.path)) state.attachments.push(a);
          renderAttachments(); autoGrow(); inputEl.focus();
          draftPersist();              // 原文回输入框：立刻落盘
        });
      } else toast(failTitle, true);
      if (e.status === 503 && gen === view.gen) openDrawer("settings");
    } finally { if (done) done(); }
  }
  let lastSendAt = 0;
  let renameBusy = "";   // 正在发的那条 /rename 原文：连点发送时挡掉重复请求（FIND-012）

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
    // 不再给 120px 下限：键盘上方只剩几十像素时，硬留 120px 会把浮层顶到输入框上盖住已输入的字（0.6.9 审计 196-移动.1）
    const avail = Math.max(0, c.top - top - 8);
    const maxH = Math.max(24, Math.min(fixedH() * 0.46, avail));   // 不盖顶栏、不盖输入框
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
    const prevDir = state.fileDir;   // 点「..」进不去时退回来，别把 fileDir 永久卡在打不开的目录（0.6.9 审计 195-D.6）
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
    } catch (e) {
      // 失败不能静默消失（0.6.9 审计 195-N.9）：退回上一个能打开的目录，并说清原因
      if (!ok()) return;
      if (prevDir && state.fileDir !== prevDir) state.fileDir = prevDir;
      hidePopup();
      toast(t("文件列表没读到：{msg}", { msg: e.message }), true);
    }
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
    draftPersistSoon();   // 程序性改的也要落盘：没有真的 input 事件，不排这一下就只有切会话 / pagehide 才存（UIFS-008）
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
      // 引用统一走 attAt：带空白 / 引号 / 反斜杠的路径要加引号并转义，不然 @ 提及按空白截断，
      // 发送出去只拿到前半截（BUG-UIFS-001，和文件面板 insertAtCursor 同一个规则）
      replaceToken(AT_TOKEN, attAt(full) + " ");
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
    s = String(s ?? "");
    // 文件面板 / 查看器插进来的是「@绝对路径」：统一交给 attAt 补引号并转义（空白 / 引号 / 反斜杠），
    // 和 @ 文件补全一个规则；不然 @ 提及按空白截断，带引号、反斜杠的路径也还原不回去（0.6.9 审计 195-D.2、BUG-UIFS-001）
    if (/^@\//.test(s) && !/^@"/.test(s)) s = attAt(s.slice(1));
    // 有选区就整段替换，不是只在选区起点插（0.6.9 审计 195-D.8）
    const v = inputEl.value, a = inputEl.selectionStart ?? v.length, b = inputEl.selectionEnd ?? a;
    const before = v.slice(0, a), after = v.slice(b);
    const glue = before && !/\s$/.test(before) ? " " : "";
    inputEl.value = before + glue + s + " " + after;
    const pos = (before + glue + s + " ").length;
    try { inputEl.setSelectionRange(pos, pos); } catch {}
    autoGrow(); syncInterject();      // 不经 input 事件：按钮的发送 / 停止要自己对一下（审查 #50 S2-09）
    draftPersistSoon();               // 同样要排一次落盘（UIFS-008）
  }

  // ── 草稿找回（上游 2.1.288：Ctrl+C 清掉的输入，空输入框按 ↑ 找回）──
  // 手机上更常见的是误删、全选后删空：一段 8 个字以上的内容被删空（不是发出去的），输入框下面亮一个「恢复」，20 秒后消失
  const draftChip = $("draft-chip");
  let draftLast = "", draftStash = "", draftT = null, draftStashOpt = null;
  function draftOffer(text, opt) {
    draftStash = text;
    draftStashOpt = opt || null;
    draftChip.classList.remove("hidden");
    clearTimeout(draftT);
    draftT = setTimeout(() => draftChip.classList.add("hidden"), 20000);
  }
  function draftRestore() {
    if (!draftStash || inputEl.value) return false;
    inputEl.value = draftStash;
    // 「发出去没回执 / 没发出去」的原文：附件也一起放回（FIND-035/010）
    if (draftStashOpt) {
      for (const a of normAtts(draftStashOpt.att || [])) if (!state.attachments.some((x) => x.path === a.path)) state.attachments.push(a);
      renderAttachments();
    }
    draftStash = ""; draftStashOpt = null; draftLast = inputEl.value;
    draftChip.classList.add("hidden");
    autoGrow(); syncInterject(); inputEl.focus();
    draftPersistSoon();      // 立刻安排落盘：恢复出来的字再丢了就说不清了
    return true;
  }
  draftChip.addEventListener("click", draftRestore);

  inputEl.addEventListener("input", () => {
    autoGrow();
    syncInterject();
    draftPersistSoon();
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

  // 输入法正在拼字时按的回车：安卓 WebView 有时在 keydown 里 isComposing 已经是 false，
  // 只能靠 keyCode 229 认出来；不拦住就会把拼音当消息发出去（稳定性报告 FIND-012）
  const imeBusy = (e) => !!e.isComposing || e.keyCode === 229;
  inputEl.addEventListener("keydown", (e) => {
    // 一项都没匹配上时也要能 Esc 关掉（审查 #48 03-F04）
    if (e.key === "Escape" && !popupEl.classList.contains("hidden")) { e.preventDefault(); hidePopup(); return; }
    if (!popupEl.classList.contains("hidden") && state.popup.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.popup.sel = (state.popup.sel + 1) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); state.popup.sel = (state.popup.sel - 1 + state.popup.items.length) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !imeBusy(e))) {
        e.preventDefault(); applyPopupChoice(state.popup.sel); return;
      }
    }
    if (e.key === "ArrowUp" && !inputEl.value && draftStash) { e.preventDefault(); draftRestore(); return; }
    if (e.key === "Enter" && !e.shiftKey && !imeBusy(e) && (enterSends() || e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
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
    // 图文一起复制（聊天软件里很常见）：别为了收图片把文字吞掉 —— 有文字就让浏览器照常贴，图片另外进附件栏（稳定性报告 FIND-012）
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    await uploadFiles(files);
  });

  popupList.addEventListener("click", (e) => {
    const it = e.target.closest(".pitem");
    if (it?.dataset.i != null) applyPopupChoice(Number(it.dataset.i));
  });

  // 有字就发（忙时自动排队）；没字且正在生成 = 停止
  // 刚发出的那一下之后紧跟的第二下（双击、手抖）不算「停止」：不然会把刚发的这一轮杀掉（审查 v0.5.3 F1）。
  // 窗口只从点发送那一刻算 0.6 秒，且不再从 POST 回执重算——以前回执一慢，想停的时候全被吞掉（0.6.9 审计 196-聊天.3）
  sendEl.addEventListener("click", () => (hasDraft() || !isBusy() ? send() : Date.now() - lastSendAt < 600 ? null : abort()));
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
  // 形状不对的附件记录（name 不是字符串、path 不是绝对路径）就地丢掉：以前一条坏记录会让整个附件栏渲染抛错，
  // 而且坏记录一直留着（0.6.9 审计 196-前端注入.5 / 195-D 附件形状）
  function normAtt(a) {
    if (!a || typeof a !== "object" || typeof a.path !== "string" || !a.path) return null;
    return { ...a, name: typeof a.name === "string" && a.name ? a.name : (a.path.split("/").pop() || "file"),
      kind: typeof a.kind === "string" ? a.kind : "", size: Number(a.size) || 0 };
  }
  const normAtts = (list) => (Array.isArray(list) ? list.map(normAtt).filter(Boolean) : []);
  try { const a = JSON.parse(sessionStorage.getItem(ATT_KEY) || "[]"); if (Array.isArray(a) && a.length) state.attachments = normAtts(a); } catch {}
  function renderAttachments() {
    const list = state.attachments = normAtts(state.attachments);
    try { list.length ? sessionStorage.setItem(ATT_KEY, JSON.stringify(list)) : sessionStorage.removeItem(ATT_KEY); } catch {}
    draftPersistSoon();
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
  // 别的应用分享进来、壳拷进 uploads/ 的文件：不要了就让壳删掉那份，发出去了就让壳从清单里划掉（0.6.9 审计 199-1-05）。
  // 壳只认它自己拷的那些，别的路径（上传、@ 引用、大文件原路径）传过去也什么都不做
  function shareDone(list, drop) {
    const A = window.CCApp;
    if (!A || typeof A.shareDone !== "function") return;
    for (const a of list || []) if (a && typeof a.path === "string") try { A.shareDone(a.path, !!drop); } catch {}
  }
  /** drop：不是发出去，是丢掉（/clear 之类） */
  function clearAttachments(drop) {
    shareDone(state.attachments, drop);
    state.attachments = [];
    renderAttachments();
  }
  function removeAttachment(a) {
    state.attachments = state.attachments.filter((x) => x.path !== a.path);
    shareDone([a], true);
    renderAttachments();
  }
  // ── 每个会话各有各的草稿（群友反馈：输入框里没发的字、附件，切会话会跟着带过去）──
  // 切走时把输入框和附件栏记在原会话名下（新对话记在 ""），切到哪个就换上哪个的；记在 localStorage，重开应用也在。
  // 只在用户切会话（openSession）时换；重连、新会话拿到会话号都不经过这里，正在打的字不会被换掉
  const DRAFTS_KEY = "cc.drafts";
  function draftsRead() { try { const o = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } }
  // 配额满了（草稿太长 / 本机存储被别的占满）以前被静默吞掉，重开应用草稿就没了（FIND-011）：说一声，别让人白丢
  let draftQuotaAt = 0;
  function draftsSave(all) {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); return true; }
    catch (e) {
      if (Date.now() - draftQuotaAt > 30000) {
        draftQuotaAt = Date.now();
        toast(t("草稿没能保存：本机存储空间不足。请把内容复制出去，或先发出去。"), true);
      }
      return false;
    }
  }
  // 发出去、还没拿到回执 / 没发出去的原文（lost 槽）：刷新、被杀、切会话之后都还能找回；
  // 同一条消息重发时沿用里面的幂等键，网关按它去重（FIND-048/036、FIND-035、FIND-010）。最多留 7 天。
  const LOST_KEEP = 7 * 24 * 3600 * 1000;
  function lostLive(d) {
    const L = d && d.lost;
    return L && typeof L.text === "string" && Date.now() - (L.at || 0) < LOST_KEEP ? L : null;
  }
  function draftKeepSent(k, text, att, idem) {
    const all = draftsRead(), d = all[k] || { text: "", att: [] };
    d.lost = { text, att: normAtts(att || []), at: Date.now(), idem };
    d.at = d.at || Date.now(); all[k] = d;
    return draftsSave(all);
  }
  /** 这条正文的重发：该会话 lost 槽里还是同一条、还没确认送到，就沿用原来的幂等键 */
  function draftSentIdem(k, text) {
    const L = lostLive(draftsRead()[k]);
    return L && L.idem && L.text === text ? L.idem : null;
  }
  function draftDropLost(k, idem) {
    const all = draftsRead(), d = all[k];
    if (!d || !d.lost || (idem && d.lost.idem !== idem)) return;
    delete d.lost;
    if (!String(d.text || "").trim() && !(Array.isArray(d.att) && d.att.length)) delete all[k];
    draftsSave(all);
  }
  let draftEpoch = 0;   // 换过几次会话草稿：上传回执据此判断附件栏还是不是发起时那个会话的
  /** 输入框空着时把 lost 槽里的原文亮成「恢复」；输入框有字就不打扰（槽留着，下次进来再说） */
  function draftOfferLost(k, d) {
    const L = lostLive(d);
    if (!L || inputEl.value.trim() || state.attachments.length) return;
    draftOffer(L.text, { att: L.att, idem: L.idem, key: k });
  }
  function draftSwap(from, to) {
    const all = draftsRead(), k0 = from || "", k1 = to || "";
    if (k0 === k1) return;
    draftEpoch++;
    const text = inputEl.value, att = state.attachments.slice();
    const lost0 = lostLive(all[k0]);
    if (text.trim() || att.length || lost0) all[k0] = { text, att, at: Date.now(), ...(lost0 ? { lost: lost0 } : {}) };
    else delete all[k0];
    const d = all[k1];
    delete all[k1];
    // 没回执 / 没发出去的原文留在会话名下（空正文也留着）：回来还能找回
    if (lostLive(d)) all[k1] = { text: "", att: [], at: (d && d.at) || Date.now(), lost: d.lost };
    const keys = Object.keys(all).sort((x, y) => (all[y].at || 0) - (all[x].at || 0));
    for (const k of keys.slice(30)) { shareDone(all[k].att, true); delete all[k]; }   // 挤出去的草稿就没了，它的分享文件一起删
    draftsSave(all);
    inputEl.value = d && typeof d.text === "string" ? d.text : "";
    state.attachments = d && Array.isArray(d.att) ? normAtts(d.att) : [];
    renderAttachments(); autoGrow();
    draftLast = inputEl.value; draftStash = ""; draftStashOpt = null; draftChip.classList.add("hidden");   // 「恢复误删」是上一个会话的，别带过来
    draftOfferLost(k1, d);
  }
  // 新会话（还没有会话号）的草稿在第一轮 init 时拿到会话号：同一代次里的空草稿就是那个会话的。
  // 上传 / 选择器回执按这个找回发起的会话，不然切走之后会落进空草稿、被下一个新会话带出来（#133）
  const DRAFT_ALIAS = new Map();   // 换草稿的代次 → 这一代的空草稿后来成了哪个会话
  function draftAdopt(sid) {
    if (!sid) return;
    DRAFT_ALIAS.set(draftEpoch, sid);
    // 「新对话」名下的草稿挪到这个会话：进程被杀后按会话号还能找回（0.6.9 审计 195-D.3）
    const all = draftsRead(), d = all[""];
    if (d && !all[sid]) { all[sid] = d; delete all[""]; draftsSave(all); }
  }
  const draftOwner = (ep, key) => key || DRAFT_ALIAS.get(ep) || "";
  // 当前会话的草稿及时落盘：以前只在切会话 / pagehide 时写，App 被系统杀时正在打的字和附件都会丢（0.6.9 审计 195-D.3）
  let draftSaveT = 0;
  function draftPersist() {
    clearTimeout(draftSaveT); draftSaveT = 0;
    const k = view.sessionId || "", text = inputEl.value, att = normAtts(state.attachments);
    const all = draftsRead(), old = all[k], lost = lostLive(old);
    if (text.trim() || att.length) all[k] = { text, att, at: Date.now(), ...(lost ? { lost } : {}) };
    // 正文空了也不删：发送时留的 lost 槽还要靠它保存（FIND-035：400ms 后空草稿覆盖原文）
    else if (lost) all[k] = { text: "", att: [], at: (old && old.at) || Date.now(), lost };
    else if (old) delete all[k]; else return;
    draftsSave(all);
  }
  function draftPersistSoon() { if (!draftSaveT) draftSaveT = setTimeout(draftPersist, 400); }
  /** 启动时把当前会话的草稿装回输入框（进程被杀 / 重新打开都走这里） */
  function draftLoad(key) {
    const d = draftsRead()[key || ""];
    if (!d) return;
    if (!inputEl.value && typeof d.text === "string") inputEl.value = d.text;
    if (!state.attachments.length) state.attachments = normAtts(d.att);
    renderAttachments(); autoGrow(); draftLast = inputEl.value;
    draftOfferLost(key || "", d);   // 上次发出去没回执 / 没发出去的原文：输入框空着就亮「恢复」（FIND-010）
  }
  /** 不在眼前的会话的草稿里追加正文 / 附件（发送失败找回、迟到的上传和截屏都往这里放） */
  function draftPutAway(k, text, att) {
    const all = draftsRead(), d = all[k] || { text: "", att: [] };
    if (text) d.text = typeof d.text === "string" && d.text.trim() ? d.text.replace(/\s*$/, "\n\n") + text : text;
    d.att = [...(Array.isArray(d.att) ? d.att : [])];
    for (const a of att || []) if (!d.att.some((x) => x && x.path === a.path)) d.att.push(a);
    d.at = Date.now(); all[k] = d;
    draftsSave(all);
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
    const mine = () => draftEpoch === ep0 || (view.sessionId || "") === draftOwner(ep0, key0);
    let away = 0, fails = 0, lastErr = "";
    for (const f of list) {
      // 0 字节也照传：网关现在收空文件（0.6.9 审计 195-C.18）
      // 大文件（粘贴 / 拖进来的；从选择器挑的 App 壳已经分流了）：网关流式落盘，这里只提示一下要等
      if (f.size > BIG_ATT) toast(t("「{name}」较大（{s}），正在收进工作区…", { name: f.name, s: fmtSize(f.size) }));
      const up = ++uploadSeq;
      uploading.add(up);
      try {
        const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name || "upload.bin"), {
          method: "POST",
          body: f,           // 直接流式送 File，fetch 自己带 content-type
        });
        if (!r.ok) {
          // 原因要照实给：507/413 以前只剩一个状态码，用户不知道是空间不够还是文件太大（0.6.9 审计 195-D.4）
          let j = null;
          try { j = await r.json(); } catch {}
          throw new Error((j && (j.message || j.error)) ||
            (r.status === 507 ? t("存储空间不够了") : r.status === 413 ? t("文件太大，服务器没有收") : t("服务器返回 {status}", { status: r.status })));
        }
        const j = normAtt(await r.json());
        if (!j) throw new Error(t("服务器没有认出上传的文件"));
        done.push(j);
        if (insert && mine()) state.attachments.push(j);
        else if (insert) {
          draftPutAway(draftOwner(ep0, key0), "", [j]);
          away++;
        }
      } catch (e) {
        fails++; lastErr = e.message;
        toast(t("「{name}」附加失败：{msg}", { name: f.name, msg: e.message }), true);
      } finally {
        uploading.delete(up);
      }
    }
    if (done.length || fails) {
      renderAttachments();
      // 一部分落在这里、一部分回了原会话：两句都说（DeepSeek 复核 低-6）。
      // 有失败时用一条总账，别让成功的 toast 把失败顶掉（0.6.9 审计 195-D.5）
      if (fails) toast(t("已附加 {n} 个，{m} 个失败：{msg}", { n: done.length, m: fails, msg: lastErr }), true);
      else {
        const here = done.length - away;
        toast([here ? t("已附加 {n} 个文件", { n: here }) : "", away ? t("{n} 个文件已附加到刚才那个会话的草稿", { n: away }) : ""].filter(Boolean).join("；"));
      }
    }
    return done;
  }

  /** stat 的回执要写回真正在用的那条附件：renderAttachments 会把列表换成 normAtt 的副本，
   *  改原来那个对象改不到列表里（BUG-UIFS-002）。还在眼前这个草稿就改附件栏；已经换到别的会话就改那份草稿存储 */
  function attSized(ep, key, p, size) {
    const hit = (list) => {
      const x = Array.isArray(list) ? list.find((y) => y && y.path === p) : null;
      if (!x) return false;
      x.size = size; x.big = false;
      return true;
    };
    if (draftEpoch === ep || (view.sessionId || "") === draftOwner(ep, key)) { if (hit(state.attachments)) renderAttachments(); return; }   // renderAttachments 会顺带排落盘
    const all = draftsRead(), d = all[draftOwner(ep, key)];
    if (d && hit(d.att)) draftsSave(all);
  }
  /** 问一次实际大小，回执按发起时的草稿归属写回；问不到就继续按大附件算（原来就是这样） */
  function attachStat(ep, key, p) {
    api("/api/file/stat?path=" + encodeURIComponent(p)).then((r) => attSized(ep, key, p, Number(r.size) || 0), () => {});
  }
  // 安卓壳递进来的东西：别的应用「分享到 Claude CLI」，或系统选择器的结果
  function attachPath(p, from) {
    if (!p) return;
    // 壳偶尔会为同一条路径重复发事件；重复的珠子删一个会把壳拷的那份临时文件删掉，另一个就悬空了（稳定性报告 FIND-033）。
    // 不在眼前的草稿由 draftPutAway 自己按 path 去重
    if (state.attachments.some((x) => x.path === p)) return;
    const name = p.split("/").pop();
    // 大小先不知道：按大附件算（不出缩略图、发出去只给路径），问到大小再改
    const a = { path: p, name, size: 0, big: true, kind: /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(p) ? "image" : "other" };
    // 选择器里挑的大文件要在后台拷一阵：拷完时已经切到别的会话了，落回打开选择器那个会话的草稿（#105 06-014，同 uploadFiles）
    const fk = from ? draftOwner(from.ep, from.key) : "";
    if (from && from.ep !== draftEpoch && (view.sessionId || "") !== fk) {
      draftPutAway(fk, "", [a]);
      attachStat(from.ep, from.key, p);   // 放进原会话草稿的那条也要问大小（BUG-UIFS-002）
      return toast(t("{n} 个文件已附加到刚才那个会话的草稿", { n: 1 }));
    }
    state.attachments.push(a);
    renderAttachments();
    attachStat(draftEpoch, view.sessionId || "", p);
    toast(t("已附加 {name}", { name }));
  }
  let pickFrom = null;      // 最近一次打开选择器时的草稿（会话号 + 换草稿的代次）
  // 每次打开选择器由壳分配一个批次号（BUG-A06）：后台拷大文件要一阵，拷完时可能已经又开了一次选择器，
  // 光看「当前选择器」会把上一批记到新草稿上。事件带批次号，就按当初那次选择器的草稿归位
  const pickBatch = new Map();   // 批次号 → 打开那次选择器时的草稿快照
  // 安卓壳后台收大文件的个数：收的过程中不让发送（FIND-027），收完 / 取消后清掉选择器快照（FIND-034）
  let pickCopy = 0;
  // 壳的新事件值是 JSON（{id, path} / {id, n}）；旧格式（纯路径、纯数字）继续认，按当前快照处理
  function pickObj(v) {
    try { const o = JSON.parse(v); return o && typeof o === "object" ? o : null; } catch { return null; }
  }
  window.addEventListener("ccapp-attach-pick-start", (e) => {
    const id = String(e.detail?.value || "");
    if (id) pickBatch.set(id, pickFrom);
  });
  window.addEventListener("ccapp-attach-copy-start", (e) => {
    const o = pickObj(e.detail?.value);
    pickCopy += Math.max(1, Number(o ? o.n : e.detail?.value) || 0);
  });
  window.addEventListener("ccapp-attach-pick-done", (e) => {
    const o = pickObj(e.detail?.value);
    pickCopy = Math.max(0, pickCopy - Math.max(0, Number(o ? o.n : e.detail?.value) || 0));
    if (o) pickBatch.delete(String(o.id ?? ""));
    pickFrom = null;
  });
  window.addEventListener("ccapp-attach-copy-done", (e) => {
    // 后台收完了，把 FIND-027 的计数放掉（以前只发不收，大文件收完也一直挡着发送）
    const o = pickObj(e.detail?.value);
    pickCopy = Math.max(0, pickCopy - Math.max(0, Number(o ? o.n : e.detail?.value) || 0));
    if (o) pickBatch.delete(String(o.id ?? ""));
  });
  window.addEventListener("ccapp-attach-pick-cancel", (e) => {
    const o = pickObj(e.detail?.value);
    pickFrom = null;
    if (o) pickBatch.delete(String(o.id ?? ""));
    else pickCopy = 0;   // 旧格式没有批次号：沿用「取消即全部作废」；新格式只作废这一批，别的批次还在收
  });
  window.addEventListener("ccapp-attach", (e) => attachPath(e.detail?.value, null));
  window.addEventListener("ccapp-attach-pick", (e) => {
    const o = pickObj(e.detail?.value);
    if (o) {
      if (o.path) attachPath(o.path, pickBatch.get(String(o.id ?? "")) || null);
      return;
    }
    attachPath(e.detail?.value, pickFrom);
  });
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


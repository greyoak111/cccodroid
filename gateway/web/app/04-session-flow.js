  // ── 底栏这一轮的用量：跑着时实时（用时 · 已输出 token，token 由网关每秒最多推一次），结束定格成
  // 「用时 · ↓token · 金额」；每个会话记住最后一轮，切走再回来还在（以前跑着时挂的是上一轮的数，切会话就没了）
  const STAT_KEY = "cc.turnStat";
  let statLast = {}, statIv = 0, statRun = null;
  let cmpGen = 0;   // 第几次压缩：「正在压缩」和「已压缩」共用一行的键
  try { statLast = JSON.parse(localStorage.getItem(STAT_KEY) || "{}") || {}; } catch {}
  function statPaint() {
    const rv = runViews.get(statRun);
    if (!rv) return statStop();
    statEl.textContent = [fmtDur(Date.now() - (rv.startedAt || Date.now())), rv.out ? "↓" + fmtTok(rv.out) + " tok" : ""].filter(Boolean).join(" · ");
  }
  /** 一轮结束时定格的那串；什么都没有（启动失败、起进程前就停了）返回空，别拿它顶掉上一轮的数 */
  function statBits(ev, out) {
    const bits = [];
    if (ev.durationMs) bits.push(fmtDur(ev.durationMs, true));
    out = ev.usage?.output_tokens || out;
    if (out) bits.push("↓" + fmtTok(out) + " tok");
    if (ev.costUsd) bits.push("$" + ev.costUsd.toFixed(4));
    return bits.join(" · ");
  }
  function statLive(runId) { statStop(); statRun = runId; statIv = setInterval(statPaint, 1000); statPaint(); }
  function statStop() { clearInterval(statIv); statIv = 0; statRun = null; }
  function statSave(sid, text) {
    if (!sid) return;
    delete statLast[sid];
    statLast[sid] = text;
    const ks = Object.keys(statLast);
    for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete statLast[k];   // 只留最近 50 个会话
    try { localStorage.setItem(STAT_KEY, JSON.stringify(statLast)); } catch {}
  }

  // ── 上下文用量 ────────────────────────────────────────────────────
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    // k 和 M 都按 1000 进：以前 M 按 1048576，999999 显示 1000k、1000000 反倒显示 0.95M（审查 v0.5.3 F5）
    if (n < 999500) return (n / 1000).toFixed(n < 9950 ? 1 : 0) + "k";
    return (n / 1e6).toFixed(2) + "M";
  }
  /** 刻度以【自动压缩窗口】为准；没设才退回模型窗口。设得比窗口还大时 claude 按窗口压，刻度也按窗口（#67） */
  /** 事件流送来的上下文用量（usage / 压缩 / 一轮收尾 / /context）：记下时间，在途的历史请求回来不许盖回旧值（#89）。
   *  记的是「到达时刻」不是产生时刻：重放的是连上那一刻的快照，可能比随后发出的历史请求读到的旧一点，
   *  但那之后新来的 usage 会排在 sync 后面补到，最终收敛到最新值，只差一瞬。
   *  重放期间先攒着，到 sync 只落最后一个，不把旧轮次的数一个个闪一遍（#88） */
  let replayCtx = null;
  function liveCtx(used, total) {
    if (busReplay) { replayCtx = [used, total]; return; }
    view.ctxAt = Date.now();
    updateCtx(used, total);
  }
  /** 续不上的重连：网关接着整轮重放。重放的是已经说过的过程（旧错误、已处理的确认卡、半截正文）：
   *  实时区先遮着，到 sync 一次揭开（#88）。sync 迟迟不来：2.5 秒先揭开（重放特别长时边放边看，同以前）；
   *  15 秒还没来（连接断在重放中途、再没续上）就按到头收尾，别让用量一直攒着不上屏、新回复不吐字 */
  function beginReplay() {
    busReplay = true;
    // 新一轮重放开始：上一代没等到 sync 的用量缓冲作废。留着的话下一次 sync 会把旧值当成
    // 「刚更新的实时用量」写进视图，还把随后正确的历史用量挡在外面（0.6.9 #191-3）
    replayCtx = null;
    liveEl.classList.add("replaying");
    clearTimeout(endReplay.guard); clearTimeout(endReplay.guard2);
    endReplay.guard = setTimeout(() => liveEl.classList.remove("replaying"), 2500);
    endReplay.guard2 = setTimeout(() => { if (busReplay) endReplay(); }, 15000);
  }
  /** 整轮重放到头（sync）：攒着的正文一次画完、用量落定、遮着的实时区揭开，最后统一定位一次 */
  function endReplay() {
    clearTimeout(endReplay.guard); clearTimeout(endReplay.guard2);
    // 攒着的正文还在重放状态下补画：每块 paint 里的 scrollDown 合成一次 rAF，不是每块一次同步测量（#179：
    // 先关重放再补画，80 块就是 81 次「写 DOM → 读 scrollHeight」）。flushNow 不会再往集合里加
    for (const f of REPLAY_FLUSH) f();
    REPLAY_FLUSH.clear();
    busReplay = false;
    if (replayCtx) { const [u, tot] = replayCtx; replayCtx = null; liveCtx(u, tot); }
    liveEl.classList.remove("replaying");
    // 补画排下的那次 rAF 不要了：下面这次同步定位就到底
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    scrollDown();
  }
  function updateCtx(used, total) {
    if (used != null) state.ctxUsed = used;
    if (total) state.ctxTotal = total;
    const line = state.compactAt && state.ctxTotal ? Math.min(state.compactAt, state.ctxTotal) : state.compactAt || 0;
    const scale = line > 0 ? line : (state.ctxTotal || 0);
    if (!scale) {
      // 第三方接口不报窗口、也没设压缩线：没刻度就只报已用量，不画进度（以前整条藏掉，用量也看不到）
      // 新对话清零时收起，别残留上个会话的数
      if (!state.ctxUsed) {
        $("ctxctx").textContent = ""; ctxFill.style.width = "0%";
        if (!ctxBar.classList.contains("has-q")) ctxBar.classList.add("hidden");   // 额度速览还挂在这条上就留着
        saveUiState(); return;
      }
      ctxBar.classList.remove("hidden", "warn", "danger");
      ctxFill.style.width = "0%";
      ctxBar.style.setProperty("--p", "0%");
      $("ctxctx").textContent = t("上下文 {used} · 容量未知", { used: fmtTok(state.ctxUsed) });
      saveUiState();
      return;
    }
    const pct = Math.min(100, Math.round((state.ctxUsed / scale) * 100));
    ctxBar.classList.remove("hidden", "warn", "danger");
    if (pct >= 100) ctxBar.classList.add("danger");
    else if (pct >= 85) ctxBar.classList.add("warn");
    ctxFill.style.width = pct + "%";
    ctxBar.style.setProperty("--p", pct + "%");   // 快满时字按这条分界线分两色（style.css #ctxbar.warn #ctxtxt）
    $("ctxctx").textContent = line > 0
      ? t("上下文 {used} / 压缩线 {line} · {pct}%", { used: fmtTok(state.ctxUsed), line: fmtTok(line), pct })
      : t("上下文 {used} / {total} · {pct}%", { used: fmtTok(state.ctxUsed), total: fmtTok(state.ctxTotal), pct });
    saveUiState();
  }
  /** 从 /context 的输出里抠出真实占用（形如 "**Tokens:** 17.9k / 200k (9%)"） */
  function parseContextText(t) {
    const num = (v, u) => {
      let n = parseFloat(v);
      const s = (u || "").toLowerCase();
      if (s === "k") n *= 1000;
      if (s === "m") n *= 1e6;
      return Math.round(n);
    };
    let m = t.match(/\*{0,2}Tokens:?\*{0,2}\s*([\d.]+)\s*([km])?\s*\/\s*([\d.]+)\s*([km])?/i);
    if (m) return liveCtx(num(m[1], m[2]), num(m[3], m[4]));
    m = t.match(/\|\s*(?:Used|已用)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
    if (m) {
      const used = num(m[1], m[2]);
      const tot = t.match(/\|\s*(?:Total|总计)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
      return liveCtx(used, tot ? num(tot[1], tot[2]) : state.ctxTotal);
    }
  }

  // ── 会话切换 / 历史翻页 ────────────────────────────────────────────
  /** 历史首屏加载占位：大会话慢的时候不再整块空白像「会话空了」（0.6.9 审计 195-Q.9） */
  function histLoading() {
    const el = document.createElement("div");
    el.className = "tiny hist-loading";
    el.textContent = t("正在读取会话…");
    histEl.appendChild(el);
  }
  function histLoadFailed(msg) {
    histEl.querySelector(".hist-loading")?.remove();
    const el = document.createElement("div");
    el.className = "tiny err hist-err";
    el.textContent = t("读取历史失败：{msg} ", { msg });
    const b = document.createElement("button");
    b.className = "btn ghost sm"; b.dataset.histRetry = "1"; b.textContent = t("重试");
    el.appendChild(b);
    histEl.appendChild(el);
  }
  function resetView(sessionId, keepPendingModel = false) {
    const prevSid = view.sessionId;
    view.sessionId = sessionId || null;
    // 换了会话：上一个会话的上下文用量不能挂在这个会话名下，先归零，等历史 / 事件流报这个会话自己的（#89）
    view.ctxAt = 0;
    if (view.sessionId !== prevSid) { replayCtx = null; view.cwd = null; updateCtx(0, state.ctxTotal); }
    // 同一个未发送的新会话重连：hello 不能冲掉刚选的接口；显式打开 / 新建仍清空。
    if (view.sessionId || !keepPendingModel) state.pendingModel = null;
    refreshSessModel();                      // 模型标签换成这个会话自己的（打开、启动、重连都经过这里）
    view.gen++;
    WROTE.clear();                           // 写过的文件只认本会话的
    // 已答完的确认卡随旧视图一起放掉：只有还在文档里的卡才拿来挡重放，留着只会越攒越多（#95 01-007）；没答的留着，那一轮可能还在等
    for (const [id, it] of PERMS) if (it.done) PERMS.delete(id);
    view.cursor = null;
    view.next = null;
    view.loading = false;
    view.runIds = new Set();
    view.cids = new Set();
    view.cidRuns = new Map();
    view.lastRunId = null;
    view.projectId = null;
    view.pendingMerge = null;
    view.title = "";
    paintTitle();
    view.goal = null;
    view.histOk = false;
    view.liveAt = 0;
    const hid = stripHidden()[view.sessionId] || {};
    view.goalHide = hid.g || 0;
    view.tasks = null;
    view.tasksHide = hid.t || "";
    renderRunStrip();
    // 新会话的首屏留着：点「新对话」时已经画过一次，重连回来（hello）又会走到这里——清掉重画就是空一帧再整块冒出来，
    // 关了动效时看着就是一闪。还是新会话、首屏也还在，就把那块原样接回去（showWelcome 认它）
    const wel = !view.sessionId && histEl.childElementCount === 1 ? histEl.querySelector(":scope > .msg.welcome") : null;
    welKeep = wel || null;
    histEl.innerHTML = "";
    // typeof 守卫：bridge-config-ui 的测试单独切 resetView 出来跑，那里没有 histLoading
    if (view.sessionId && typeof histLoading === "function") histLoading();
    liveEl.innerHTML = "";
    if (view.sessionId !== prevSid) view.firstSend = null;   // 换会话了：上一页的「首条已发出」不跟过来（0.6.9 审计 196-聊天.7）
    for (const rv of runViews.values()) { rv.timer?.stop(); rv.av?.remove(); }   // av.remove 连阶段提示的每秒定时器一起停（审查 #49 P3-7）
    runViews.clear();
    TOOL_CARDS.clear();
    clearToolResults();
    agReset();
    olderEl.classList.add("hidden");
    syncWindow();
    statStop();
    statEl.textContent = statLast[view.sessionId] || "";   // 正在跑的话，补发的 run_start 会接着转成实时
    pickViewRun();                     // 换了会话：「本会话在不在跑」要重新算
    renderRunStrip(); renderPermBar(); // 后台任务条、权限条也按新算出来的这一轮重画：网关不可达时 hello 迟迟不来，不能一直挂着上一个会话的（#178-2）
    renderQueue();                     // 排队条也换成这个会话的：不然看着是 A 的，点清除却删 B 的（审查 #51 第2项）
    paintProjChip();
    syncInterject();
    saveUiState();
  }

  /** 按会话号去打开、那个会话却不在了：在回收站的给「恢复」，彻底没了的说清楚——不再悄悄变成空白新对话（#173）。
   *  任务运行记录、完成提示、原生通知、用量榜、档号、书签、项目详情都走 openSession，在这里统一兜住 */
  function goneNotice(id, trashed) {
    if (!trashed) return toast(t("这个会话已经不在了（删掉了或清过数据）"), true);
    toastAct(t("这个会话在回收站里"), t("恢复"), () => restoreAndOpen(id));
  }
  async function restoreAndOpen(id) {
    const r = await post("/api/trash/restore", { ids: [id] }).catch((e) => ({ failed: [{ error: e.message }] }));
    if (r && r.failed && r.failed.length) return toast(t("恢复失败：{msg}", { msg: r.failed[0].error === "exists" ? t("同名会话已存在") : r.failed[0].error }), true);
    toast(t("已恢复")); loadSessions(); lineageDirty();
    openSession(id);
  }
  /** 打开某个会话（null = 新会话）。重连事件流：网关会把正在跑的那一轮从头重放过来。
   *  anchor：落在某一章开头（脉络里点站 / 章标题；压缩消息的 uuid，第一章是 "start"）
   *  opts.keepPage：不收起整页（网关那边删了正开着的会话，人可能正在项目页里） */
  function openSession(id, jumpQ, anchor, opts = {}) {
    view.userOpen = id || null;   // 用户点开的（不是启动时按记着的会话号接回的）：打不开要说一声
    if (id !== view.sessionId) saveLastRead();   // 切走前记下读到哪（在底部就作废）
    if ((id || null) !== view.sessionId) {
      draftSwap(view.sessionId, id);   // 输入框、附件栏换成这个会话自己的
      OV.closeAll();                   // 型号面板、回退确认这类浮层是上一个会话的：开着就会把选择写进新会话（#174-2）
    }
    if (!opts.keepPage) closePage();
    view.pendNav = null;      // 用户明确打开某一页：上一次在途的锚点 / 续读意图不再适用
    resetView(id);
    if (!id) showWelcome();   // 新会话当场画首屏，不等重连回来——中间空着那一下就是闪
    view.jumpQ = id && jumpQ ? jumpQ : "";   // 从搜索结果点进来：历史加载完后跳到命中的那条
    view.jumpPages = 0;
    view.anchor = id && anchor ? anchor : "";
    view.resume = null;
    renderSessions();
    connectBus(false);
  }

  // 用户点会话标题（侧栏 / 对话列表 / 项目）：点的就是眼前这个、又不是跳搜索命中，就只收起整页和侧栏，现场原样（#37）。
  // 正看着中间某一段（窗口式）、或者还在读，也一样留着——要回最新有右下角那个按钮；以前这两种会重开（#52 复测 #37）
  function goSession(id, jumpQ) {
    // 首屏历史没读成功（断网）、也不在读时再点同一个会话要重读，不能当「现场原样」（审查 #48 S08-01）
    if (id && id === view.sessionId && !jumpQ && (view.histOk || view.loading)) { closePage(); closeDrawer(); return; }
    // 切回别的会话：上次离开时不在底部，就落回那时视口顶部那一段
    closeDrawer(); openSession(id, jumpQ, id && !jumpQ && id !== view.sessionId ? lastReadOf(id) : null);
  }

  /** 眼前就是一张空白、还没发过东西的新对话（不在项目里、这页没起过一轮、也没有在途的发送） */
  function blankNew() {
    return !view.sessionId && !view.projectId && !view.runIds.size && !view.cids.size && !view.lastRunId
      && !histEl.querySelector(".msg:not(.welcome)") && !liveEl.querySelector(".msg");
  }
  function newConversation(note) {
    // 已经在空白新对话上又点「新对话」（侧栏 / 顶栏 ＋）：现场不动，只收起整页、聚焦输入框。
    // 以前每点一次都重置视图、重连事件流，顶栏在「新会话」「已连接」之间来回闪（#40）。带 note 的（/clear 等）照旧重开
    if (!note && blankNew()) { closePage(); inputEl.focus(); return false; }
    openSession(null);
    updateCtx(0, state.ctxTotal);
    setStatus(note || t("新会话"), "ok");
    inputEl.focus();
    return true;
  }

  function liveExclude() {
    const r = srv.run;
    return r && view.sessionId && r.sessionId === view.sessionId ? r.startedAt : 0;
  }

  // ── 窗口式历史（跳到某一章时）：#hist 只是会话里连续的一段，view.cursor 是上沿、view.next 是下沿（null = 一直到最新）。
  //    没到最新时 #live 藏起来，往下滚按页续读；每页记着自己的字节范围（data-from / data-to），
  //    超过 MAX_PAGES 页就从另一头整页摘掉，滚回去再按范围原样重读——长会话来回翻，DOM 始终只有这么几页
  const MAX_PAGES = 8;
  function syncWindow() {
    const w = view.next != null;
    liveEl.classList.toggle("hidden", w);
    chatEl.classList.toggle("windowed", w);
  }
  // 往后读时不重复给的部分：正在跑的那一轮，加上本次打开后在 #live 里已经画出来的各轮
  function windowExclude() {
    let ex = liveExclude();
    for (const rv of runViews.values()) if (rv.startedAt && (!ex || rv.startedAt < ex)) ex = rv.startedAt;
    return ex;
  }
  const histPages = () => histEl.querySelectorAll(":scope > .page");
  function trimPages(side) {
    let ps = histPages();
    while (ps.length > MAX_PAGES) {
      if (side === "top") {
        const p = ps[0], h0 = chatEl.scrollHeight;
        dropCards(p); p.remove();
        chatEl.scrollTop -= h0 - chatEl.scrollHeight;
        view.cursor = Number(p.dataset.to);
        olderEl.classList.remove("hidden");
      } else {
        const p = ps[ps.length - 1];
        dropCards(p); p.remove();
        view.next = Number(p.dataset.from);
        syncWindow();
      }
      ps = histPages();
    }
  }

  async function loadNewer() {
    const id = view.sessionId, after = view.next;
    if (!id || view.loading || after == null) return;
    view.loading = true;
    const gen = view.gen;
    const q = new URLSearchParams({ limit: "60", after: String(after) });
    const ex = windowExclude();
    if (ex) q.set("exclude", String(ex));
    let r;
    try { r = await api(`/api/session/${encodeURIComponent(id)}?${q}`); }
    catch (e) { if (gen === view.gen) { view.loading = false; toast(t("读取历史失败：{msg}", { msg: e.message }), true); } return; }
    if (gen !== view.gen) return;
    view.loading = false;
    const page = renderItems(r.items || []);
    page.dataset.from = after; page.dataset.to = r.next;
    histEl.appendChild(page);
    view.next = r.next < r.size ? r.next : null;
    trimPages("top");
    syncWindow();
  }

  async function loadOlder(initial) {
    const id = view.sessionId;
    if (!id || view.loading) return;
    if (!initial && !view.cursor) return;
    view.loading = true;
    const gen = view.gen;
    olderEl.textContent = t("加载中…");
    const q = new URLSearchParams({ limit: initial ? "40" : "60" });
    const anchor = initial ? view.anchor : "", resume = initial ? view.resume : null, before = view.cursor;
    if (initial) { view.anchor = ""; view.resume = null; }
    // 锚点 / 续读的意图记在视图外面：请求在途时整轮重连会 resetView，清掉的这些得能再发一遍，
    // 不然目标章节无声丢、退回最新页（0.6.9 #191-2）
    if (initial && (anchor || resume != null)) view.pendNav = { sid: id, anchor: anchor || "", resume };
    const fwd = !!anchor || resume != null;
    // 锚点：章节是压缩消息 uuid（字符串）；书签 / 上次读到是 { uuid, off, para, quiet }
    const aObj = anchor && typeof anchor === "object" ? anchor : null;
    if (anchor) { q.set("anchor", aObj ? aObj.uuid : anchor); if (aObj && aObj.off > 0) q.set("off", String(aObj.off)); }
    if (initial) loadMarks();
    // 重连续不上（resume=false）时接着原来那一段读：以前 initial 分支吃掉了 after，读回的是最新一页（审查 #48 S08-02 / #49 P2-5）
    // 首屏要目标进度和任务清单：resetView 刚把它们清掉，重连续读那一页不带的话进度条和清单就没了（#178-1）
    if (resume != null) { q.set("after", String(resume)); q.set("meta", "1"); }
    else if (!initial) q.set("before", String(before));
    const sent = Date.now();
    const ex = fwd ? windowExclude() : liveExclude();
    if (ex) q.set("exclude", String(ex));
    let r;
    try {
      r = await api(`/api/session/${encodeURIComponent(id)}?${q}`);
    } catch (e) {
      if (gen !== view.gen) return;
      view.loading = false;
      olderEl.textContent = t("加载更早的消息");
      // 只有「会话在、那个位置没了」才退回最新；会话本身不在了走下面（以前先误报「没找到这一章」再重试一遍，#173-6）
      if (anchor && e.status === 404 && (!e.body || e.body.error === "anchor not found")) {
        view.pendNav = null;     // 位置确实没了：别再在重连时重试
        // 那一章 / 书签的位置找不到了（记录被改写过、回退截掉了）：退回最新；「上次读到」找不到就悄悄打开到最新
        if (!aObj || !aObj.quiet) toast(aObj ? t("没找到书签的位置，已打开到最新") : t("没找到这一章的位置，已打开到最新"), true);
        return loadOlder(true);
      }
      if (e.status === 404 && initial) {
        // 记着的会话已经不在了（删掉了 / 清过数据）：当新会话处理，回到欢迎页，别挂一条让人摸不着头脑的提示
        view.pendNav = null;
        view.sessionId = null;
        view.title = ""; paintTitle(); renderSessions();   // 标题、侧栏高亮也别还挂着那个会话（审查 #48 S08-04）
        // 会话已经没了：上下文用量、钉住的型号跟着清零，别带进新对话还跨重启保存（0.6.9 审计 196-本地状态.1）
        updateCtx(0, state.ctxTotal);
        state.pendingModel = null;
        refreshSessModel();
        saveUiState();
        // 中断记录指着的会话没了：那张「继续」卡在这里点下去会在空会话里续，上下文全丢——收掉，回欢迎页（#173-5）
        $("intr-card")?.remove();
        if (!liveEl.childElementCount) showWelcome();
        if (view.userOpen === id) goneNotice(id, !!(e.body && e.body.trashed));
        view.userOpen = null;
      } else if (initial) histLoadFailed(e.message);
      else toast(t("读取历史失败：{msg}", { msg: e.message }), true);
      return;
    }
    if (gen !== view.gen) return;
    view.loading = false;
    if (initial) { view.histOk = true; view.pendNav = null; }
    view.cursor = r.cursor;
    if (initial) view.next = fwd && r.next < r.size ? r.next : null;
    view.title = r.title || "";
    if (r.cwd) view.cwd = r.cwd;   // 旧会话不在最近 150 条里时，项目 chip 靠它认（0.6.9 审计 196-显示.3）
    // 请求在途时事件流已经送来更新的目标 / 清单：历史里的是旧快照，不许盖回去（审查 #50 S2-07）
    const fresh = view.liveAt < sent;
    if (initial && fresh && "goal" in r) { view.goal = r.goal || null; renderRunStrip(); }
    if (initial && fresh && "tasks" in r) { view.tasks = r.tasks || null; renderRunStrip(); }
    const page = renderItems(r.items || []);
    page.dataset.from = r.cursor;
    page.dataset.to = fwd ? r.next : initial ? r.size : before;
    olderEl.textContent = t("加载更早的消息");
    olderEl.classList.toggle("hidden", !r.cursor);
    if (initial) {
      histEl.innerHTML = "";
      histEl.appendChild(page);
      syncWindow();
      // 请求在途时事件流已经报过更新的用量（含压缩后变小的）：历史里的是旧快照，不许盖回去（#89）
      if (r.contextTokens != null && (view.ctxAt || 0) < sent) updateCtx(r.contextTokens, state.ctxTotal);
      paintTitle();
      calmStatus(t("就绪"));
      if (anchor) return landOnChapter(page, gen, aObj);
      if (fwd) { stick = false; chatEl.scrollTop = 0; }   // 重连时接着原来那一段
      else { scrollDown(true); if (!seenSessions.has(id)) MO.play(histEl, "mo-in-rise", 1400); }
      seenSessions.add(id);
    } else {
      const h0 = chatEl.scrollHeight, t0 = chatEl.scrollTop;
      histEl.insertBefore(page, histEl.firstChild);
      chatEl.scrollTop = t0 + (chatEl.scrollHeight - h0);   // 往上补内容，视线别跳
      trimPages("bottom");
    }
    if (view.jumpQ) jumpToHit();
  }
  // 落在某一章：先往上补一页（分隔线上面要有东西可看），再把分隔线放到视口上三分之一处、闪一下
  async function landOnChapter(page, gen, aObj) {
    stick = false;
    if (view.cursor) await loadOlder(false);
    if (gen !== view.gen) return;
    if (aObj) { landOnMark(page, aObj); progTop = chatEl.scrollTop; return; }
    const sep = page.querySelector(".ch-sep");
    const y = sep ? sep.getBoundingClientRect().top - chatEl.getBoundingClientRect().top + chatEl.scrollTop : 0;
    chatEl.scrollTop = Math.max(0, y - chatEl.clientHeight / 3);
    progTop = chatEl.scrollTop;
    if (!sep) return;
    // 动效开着：章名轻轻一顶、蓝线从左扫到右；关着照旧底色闪一下
    if (MO.on()) { if (!sep.querySelector(".mo-sweep")) sep.insertAdjacentHTML("beforeend", '<i class="mo-sweep"></i>'); MO.play(sep, "mo-hit", 2200); }
    else { sep.classList.add("hit-flash"); setTimeout(() => sep.classList.remove("hit-flash"), 2400); }
  }
  /** 回到最新：窗口没到最新时整个重开（#live 本来就在，重开会按正常方式从尾巴取） */
  function backToLatest() {
    if (view.next == null) return false;
    openSession(view.sessionId);
    return true;
  }

  // 在已渲染的消息里从新往旧找搜索词；没找到就继续往前翻，最多翻 30 页
  function jumpToHit() {
    const q = view.jumpQ.toLowerCase(), norm = (x) => x.replace(/\s+/g, " ").toLowerCase();
    const bubbles = [...histEl.querySelectorAll(".msg .bubble")].reverse();
    const hit = bubbles.find((b) => norm(b.textContent).includes(q));
    if (!hit) {
      if (view.cursor && view.jumpPages++ < 30) { setTimeout(() => loadOlder(false)); return; }
      view.jumpQ = "";
      toast(t("没在加载的消息里找到「{q}」", { q }), true);
      return;
    }
    view.jumpQ = "";
    const tw = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n; (n = tw.nextNode());) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
    for (const n of nodes) {
      const i = n.nodeValue.toLowerCase().indexOf(q);
      const m = document.createElement("mark");
      m.className = "jump-hit";
      const r = n.splitText(i); r.splitText(q.length);
      r.parentNode.replaceChild(m, r); m.appendChild(r);
    }
    const msg = hit.closest(".msg");
    msg.classList.add("hit-flash");
    setTimeout(() => msg.classList.remove("hit-flash"), 2400);
    (hit.querySelector("mark.jump-hit") || msg).scrollIntoView({ block: "center" });
  }
  olderEl.addEventListener("click", () => loadOlder(false));
  histEl.addEventListener("click", (e) => {
    if (!e.target.closest("[data-hist-retry]")) return;
    histEl.querySelector(".hist-err")?.remove();
    histLoading();
    loadOlder(true);
  });
  chatScrollHooks.push(() => {
    if (chatEl.scrollTop < 240 && view.cursor && !view.loading && histEl.childElementCount) loadOlder(false);
    else if (view.next != null && !view.loading && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 240) loadNewer();
  });

  // ── 新会话首屏（照网页版的布局）：问候语居中，输入框紧跟在下面，示例和使用提示在输入框下方；
  //    输入框下面那行左边是项目、右边是型号与权限。发出第一条（或会话里出现任何别的东西）就退回平常的布局。
  //    html.wel 只看 #hist / #live 的直接子节点，流式输出不会触发
  // 标识：三道套在一起的 c 加圆心一个点 = c-c-c-o，跟原生启动动画同形（Mark.java）。外圈只画 218°、落笔停在正下方，
  // 比里面两道短一截（定稿时示意页就是这个样子，用户要的正是这点不对称）。进场从外往里写一遍，最后点亮圆心
  const WL_MARK = '<svg class="wl-mark" viewBox="0 0 48 48" aria-hidden="true"><path pathLength="1" d="M38.8 9.2A21 21 0 1 0 21.54 44.86"/><path pathLength="1" d="M33.2 14.8A13 13 0 1 0 33.2 33.2"/><path pathLength="1" d="M27.5 20.5A5 5 0 1 0 27.5 27.5"/><circle cx="24" cy="24" r="2.4"/></svg>';
  // 问候语看此刻的处境说话：几点、星期几、电量；同一时段有几句，每次随手挑一句
  let wlBat = null;
  try { navigator.getBattery && navigator.getBattery().then((b) => { wlBat = b; }).catch(() => {}); } catch {}
  function greeting() {
    const d = new Date(), h = d.getHours(), wd = d.getDay(), pool = [];
    if (wlBat && !wlBat.charging && wlBat.level <= 0.2) pool.push(t("电量见底了，挑件快的先做"));
    else if (wlBat && wlBat.charging && (h >= 22 || h < 6)) pool.push(t("插着电呢，大活可以放心跑"));
    if (h >= 0 && h < 5) pool.push(t("夜深了，屏幕还亮着"), t("这个点还在折腾，必有好点子"));
    else if (h < 8) pool.push(t("起得真早，先做点轻松的"));
    else if (h < 11) pool.push(wd === 1 ? t("周一，从一件小事开始") : t("上午好，口袋里的工作台已就绪"), t("趁脑子清楚，啃块硬骨头？"));
    else if (h < 14) pool.push(t("午休也闲不住？"), t("吃过饭了吗？顺手做点什么"));
    else if (h < 18) pool.push(t("下午好，接着上回的思路？"), t("泡杯茶，慢慢来"));
    else if (h < 21) pool.push(wd === 5 ? t("周五傍晚，做点好玩的") : t("傍晚了，收个尾还是开新坑？"));
    else pool.push(t("晚上好，适合慢慢写点东西"), t("夜里安静，想到什么就说"));
    if ((wd === 0 || wd === 6) && h >= 8 && h < 22) pool.push(t("周末，做点自己想做的"));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  var welKeep = null;   // var：resetView 在上面，别撞暂时性死区
  function showWelcome() {
    if (histEl.querySelector(":scope > .msg.welcome")) return;
    if (welKeep) {
      // 接回去的节点：重新插进文档时浏览器会把它的 CSS 动画（淡入、线稿描画）从头再播，挂 wl-kept 压住
      const w = welKeep; welKeep = null;
      w.classList.add("wl-kept");
      histEl.appendChild(w);
      fillSetupGuide(w.querySelector(".setup-guide"));
      paintWelBelow();
      return;
    }
    const b = mkMsg("bot", null, histEl);
    b.parentElement.classList.add("welcome");
    b.innerHTML = `<div class="wl-hero">${WL_MARK}<h1 class="wl-greet">${esc(greeting())}</h1></div><div class="setup-guide hidden"></div>`;
    fillSetupGuide(b.querySelector(".setup-guide"));
    paintWelBelow();
    MO.play(b.parentElement, "mo-in-rise", 1400);
  }
  // 输入框下方：只留「使用提示」（进帮助页）；原先还有三条示例，用户嫌不好看，去掉了
  const wlBelow = document.createElement("div");
  wlBelow.id = "wl-below";
  $("composer").after(wlBelow);
  function paintWelBelow() {
    wlBelow.innerHTML = `<div class="wl-ex"><button class="wl-chip wl-tips" data-help><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17v.01"/></svg>${esc(t("使用提示"))}</button></div>`;
  }
  wlBelow.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-help]"); if (b) openPage("help");
  });
  function welSync() {
    const w = histEl.childElementCount === 1 && !!histEl.querySelector(":scope > .msg.welcome") && !liveEl.childElementCount;
    // 发出第一条后问候语就退场：留着会变成一条顶着「Claude」名字的假回复（重新打开会话时本来也没有它）。
    // 首条画在 #live 不在 #hist：只看 #hist 的条数永远等不到（审查 11-05 #42）
    if (!w && (histEl.childElementCount > 1 || liveEl.childElementCount)) { const old = histEl.querySelector(":scope > .msg.welcome"); if (old) { old.remove(); return welSync(); } }
    if (document.documentElement.classList.contains("wel") === w) return;
    document.documentElement.classList.toggle("wel", w);
    syncPlaceholder(); paintProjChip(); welNarrow();
    // 首屏输入框两行高，autoGrow 量出来的高度写在行内；离开首屏要重量一次，不然发完第一条输入框还是两行高、发送键被挤偏
    autoGrow();
  }
  // 对话栏窄（开着右侧窗格、分屏）：首屏排得紧一点
  function welNarrow() { document.documentElement.classList.toggle("wel-narrow", colRect().width < 600); }
  addEventListener("resize", () => { welNarrow(); autoGrow(); });   // 转屏后宽度变了，行内高度也要重量
  new MutationObserver(welSync).observe(histEl, { childList: true });
  new MutationObserver(welSync).observe(liveEl, { childList: true });
  // 输入框里的一行提示：首屏问「有什么可以帮你」，会话里提示斜杠命令
  function syncPlaceholder() {
    inputEl.placeholder = document.documentElement.classList.contains("wel") ? t("有什么可以帮你？") : t("输入 / 调用技能和命令");
  }

  /** 接上模型没有（登录了，或填了 Key）；网关连不上返回 null */
  async function setupReady() {
    let s = null;
    try { s = await api("/api/status"); } catch { return null; }
    let ready = !!(s.keyMode === "key" || s.otherKey);
    if (s.keyMode === "login") {
      // 问不出登录状态（claude auth status 起不来 / 解析不了）时不能当成「未登录」：首屏会收起输入框，
      // 让人以为登录丢了。unknown / stale 都是「还不知道」（0.6.9 审计 195-G.2）
      try {
        const st = await api("/api/login/status");
        if (st && (st.unknown || st.stale)) return null;
        ready = !!(st && st.loggedIn);
      } catch { return null; }
    }
    return ready;
  }
  // 还没接上模型时，首屏不放输入框（什么都没配，打了也发不出去）：问候和两条路的卡片铺开（html.wel-setup）
  function setupMode(on) {
    const r = document.documentElement;
    if (r.classList.contains("wel-setup") === on) return;
    r.classList.toggle("wel-setup", on);
    if (!on && r.classList.contains("wel")) { autoGrow(); MO.play($("composer"), "mo-in-rise", 900); }
  }
  /** 设置里填了 Key、浏览器里登录完回来（refreshStatus / 回到前台时调）：接上了就收起卡片、放出输入框 */
  async function recheckSetup() {
    if (!document.documentElement.classList.contains("wel-setup")) return;
    if (!(await setupReady())) return;
    const box = histEl.querySelector(":scope > .msg.welcome .setup-guide");
    if (box) { box.classList.add("hidden"); box.textContent = ""; }
    setupMode(false);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recheckSetup(); });

  /** 还没接上模型（没登录、没填 Key）：欢迎页里把两条路并排摆出来，不替用户选 */
  async function fillSetupGuide(box) {
    const ready = await setupReady();
    if (ready === null) return;
    if (ready || !box.isConnected) { setupMode(false); return; }
    if (box.childElementCount) { box.classList.remove("hidden"); setupMode(true); return; }   // 接回去的首屏：卡片已经画过、监听也挂过
    box.innerHTML = `<p><strong>${esc(t("开始之前，先接上模型（两条路选一条）："))}</strong></p>
      <div class="setup-paths">
        <div class="setup-path"><b>${esc(t("用 Claude 账户登录"))}</b>
          <div class="tiny">${esc(t("有 Claude Pro / Max 订阅，或 Anthropic Console 账户：在浏览器里授权一次就好，不用填 Key。"))}</div>
          <button class="btn sm" data-p="login">${esc(t("去登录"))}</button></div>
        <div class="setup-path"><b>${esc(t("填 API Key"))}</b>
          <div class="tiny">${esc(t("用 Anthropic 的 Key，或 DeepSeek、智谱 GLM、通义千问、Kimi 等兼容接口的 Key，按用量付费。"))}</div>
          <button class="btn sm" data-p="key">${esc(t("去选接口、填 Key"))}</button></div>
      </div>
      <div class="tiny">${esc(t("两条路都在 ☰ → 设置 → 接口，以后随时能换。"))}</div>`;
    box.classList.remove("hidden");
    setupMode(true);
    box.addEventListener("click", (e) => {
      const p = e.target.dataset && e.target.dataset.p;
      if (!p) return;
      openDrawer("settings");
      const sel = $("set-provider");
      if (p === "login" && [...sel.options].some((o) => o.value === "anthropic")) {
        sel.value = "anthropic";
        sel.dispatchEvent(new Event("change"));
      }
      setTimeout(() => sel.scrollIntoView({ block: "center" }), 50);
      if (p === "key") sel.focus();
    });
  }

  // ── 事件总线 ──────────────────────────────────────────────────────
  let es = null, lastEventId = "", helloCount = 0, busWatch = 0;

  let busDownAt = 0, busKick = 0;
  function connectBus(resume) {
    // 新的连接已经由用户在开头：把上一轮排着的重连定时器取消，否则 2 秒后它会把刚建好的连接再断一次（0.6.9 审计 195-P.6）
    clearTimeout(busWatch); busWatch = 0;
    if (es) { try { es.close(); } catch {} }
    // 换视图要整轮重放：旧视图的游标作废，免得重拨时又带着它续传，新视图缺东西（审查 #50 S2-05）
    if (!resume) lastEventId = "";
    // 整轮重放时带上正在看的会话 / 轮次：网关先放它们，别的会话的长轮排后面（#188）
    const focus = !resume || !lastEventId ? [view.sessionId ? "focus=" + encodeURIComponent(view.sessionId) : "", view.runIds.size ? "run=" + encodeURIComponent([...view.runIds].slice(-64).join(",")) : ""].filter(Boolean).join("&") : "";
    const url = "/api/events" + (resume && lastEventId ? "?since=" + encodeURIComponent(lastEventId) : focus ? "?" + focus : "");
    es = new EventSource(url);
    es.onmessage = (m) => {
      if (m.lastEventId) lastEventId = m.lastEventId;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      try { onBus(ev); } catch (e) { console.error(e); }
    };
    es.onopen = () => { clearTimeout(busWatch); busWatch = 0; busDownAt = 0; setConn(true); };
    es.onerror = () => {
      setConn(false);
      // 一直连不上：多半是通知栏点了「停止」、网关服务没了，界面还开着就请壳把它拉起来（11-05 报告；服务在跑时壳那边什么也不做）
      const now = Date.now();
      if (!busDownAt) busDownAt = now;
      if (now - busDownAt > 4000 && now - busKick > 10000 && !document.hidden && window.CCApp && window.CCApp.ensureGateway) { busKick = now; try { window.CCApp.ensureGateway(); } catch {} }
      // 网关重启时浏览器有时会直接放弃（CLOSED）：那就自己再拨
      if (es.readyState === 2) { clearTimeout(busWatch); busWatch = setTimeout(() => connectBus(true), 2000); }
    };
  }
  function setConn(ok) {
    srv.connected = ok;
    if (!ok) setStatus(t("与网关断开，正在重连…（生成不受影响）"), "warn");
  }
  document.addEventListener("visibilitychange", () => {
    // 切回前台：WebView 在后台冻过，连接可能已经悄悄死了
    if (!document.hidden && (!es || es.readyState !== 1)) connectBus(true);
  });

  // ── 维护者通知（经 cccodroid.net，网关验过签；见 gw/notices.mjs）：和更新说明同样的居中卡片 ──
  // 什么时候弹（用户 10-22 定）：正在用的时候不弹；打开应用、或从后台切回来时才看一眼。
  // 这次打开弹了更新说明，通知就顺延到下一次打开 / 切回来，两张卡片不叠在一起。
  // 内容是纯文本；链接只认 https（网关已筛）。点「知道了」= 卡片里这几条都记为看过。
  let noticeHold = false;
  let noticeErrShown = false, noticeFetchShown = false;   // 取不到 / 还在取只提示一次：每次切回前台都弹太吵，正常取到一次就复位（195-R.8）
  async function loadNotices() {
    if (noticeHold || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    let r;
    try { r = await api("/api/notices?lang=" + encodeURIComponent(I18N.lang || "zh")); } catch { return; }
    const list = r.items || [];
    // 「取不到」不能和「没有通知」一样安静：没有可显示的内容时明说一句（0.6.9 审计 195-R.8）
    if (!list.length && r.error) { if (!noticeErrShown) { noticeErrShown = true; toast(t("暂时取不到安全通知"), true); } return; }
    if (!list.length && r.fetching) { if (!noticeFetchShown) { noticeFetchShown = true; toast(t("正在获取安全通知…")); } return; }
    noticeErrShown = noticeFetchShown = false;
    if (!list.length || noticeHold || document.hidden || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    const el = document.createElement("div");
    el.id = "notice-pop";
    el.innerHTML = `<div class="wn-card" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <div class="wn-head" id="np-title">${esc(t("通知"))}</div>
      <div class="wn-body">${list.map((n, i) => `<section class="np-${n.level === "warn" ? "warn" : "info"}">
        <div class="wn-ver">${esc(n.date)}</div><div class="np-title">${esc(n.title)}</div>
        ${n.body ? `<div class="np-body">${esc(n.body)}</div>` : ""}
        ${n.link ? `<button class="btn sm" data-open="${i}">${esc(n.linkText || t("查看详情"))}</button>` : ""}</section>`).join("")}
        ${r.fetching ? `<div class="tiny">${esc(t("正在获取安全通知…"))}</div>` : ""}</div>
      <div class="wn-foot"><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    el.addEventListener("click", async (e) => {
      const o = e.target.closest("[data-open]");
      if (o) return openExternal(list[+o.dataset.open].link);
      if (!e.target.closest("[data-act=ok]")) return;
      OV.close(el);
      for (const n of list) {
        try { await api("/api/notices/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }); } catch {}
      }
    });
    OV.open(el, { kind: "modal", keep: true, cover: true });   // 返回键只是先收起，没点「知道了」下回还在
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { noticeHold = false; loadNotices(); } });

  function belongs(ev) {
    if (view.runIds.has(ev.runId)) return true;
    if (ev.cid && view.cids.has(ev.cid)) return true;
    if (view.sessionId && ev.sessionId === view.sessionId) return true;
    if (ev.follow && view.runIds.has(ev.follow)) return true;
    return false;
  }

  function onBus(ev) {
    switch (ev.type) {
      case "hello": return onHello(ev);
      case "tasks":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.tasks = ev.tasks || null; view.liveAt = Date.now(); renderRunStrip(); }
        break;
      case "goal":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.goal = ev.goal || null; view.liveAt = Date.now(); renderRunStrip(); }
        return;
      case "state": return applyState(ev);
      case "tamper": return showTamper(ev.tamper);
      case "archive": return loadSessions();   // 建档 / 归入杂项：标题、档号、分组跟着变
      // 会话进了回收站（网关那边删的：项目连目录删、定时任务不存对话、别的窗口）：正开着它就退回新对话，
      // 别让下一条消息带着它的会话号去 --resume 失败（#173-4）。整页不收，人可能正在项目页里
      case "session_gone":
        PJ.detail = null;
        loadSessions();
        if (ev.id && ev.id === view.sessionId) {
          openSession(null, null, null, { keepPage: true });
          toastAct(t("这个会话已移进回收站"), t("恢复"), () => restoreAndOpen(ev.id));
        }
        return;
      case "sched": case "sched_note": return onSchedEvent(ev);
      case "sync": return endReplay();
      case "run_start": {
        if (!belongs(ev)) return;
        view.runIds.add(ev.runId);
        if (ev.cid) view.cidRuns.set(ev.cid, ev.runId);
        view.lastRunId = ev.runId;
        if (runViews.has(ev.runId)) return;
        if (ev.auto !== "idle") { renderUser(ev.text, liveEl); tagRun(liveEl.lastElementChild, ev.runId); }
        const av = AssistantView(liveEl, true);
        tagRun(av.msgEl, ev.runId);
        if (ev.text.trim().startsWith("/")) av.msgEl.classList.add("sys");
        if (ev.auto === "idle") av.note(t("会话闲置快一小时，提示缓存快过期了，先自动压缩上下文，下一条消息就不用把整段历史重算一遍。不需要可以在设置里关掉。"), true);
        const timer = RunTimer(ev.startedAt);
        timer.attach(av);
        av.phase({ phase: "connect" });
        runViews.set(ev.runId, { av, startedAt: ev.startedAt, timer, out: 0 });
        statLive(ev.runId);
        // 只有本窗口刚发的消息才强制回到底部；别的会话 / 别的窗口开始的轮次别把正在翻历史的人拽走（0.6.9 审计 196-聊天.4）
        scrollDown(!busReplay && !!ev.cid && view.cids.has(ev.cid));
        return;
      }
      case "inject": {
        // 插话送达：在它被吃进去的位置画出这条消息，之后的回复另起一个气泡，时间顺序才对
        const rv = runViews.get(ev.runId);
        if (!rv) return;
        if (ev.cid) { view.cids.add(ev.cid); view.cidRuns.set(ev.cid, ev.runId); }
        rv.av.finish();
        if (rv.av.empty) rv.av.remove();
        renderUser(ev.text, liveEl); tagRun(liveEl.lastElementChild, ev.runId);
        rv.av = AssistantView(liveEl, true); tagRun(rv.av.msgEl, ev.runId);
        if (ev.text.trim().startsWith("/")) rv.av.msgEl.classList.add("sys");   // 后台任务在跑时插进去的命令，样式同单跑的命令
        rv.avDone = false;
        if (rv.idle) { rv.idle = false; rv.timer = RunTimer(Date.now()); }   // 空闲时发来的消息：算新的一轮
        rv.timer?.attach(rv.av);          // 计时算整轮的，跟着最新的气泡走
        rv.av.phase({ phase: "connect" });
        scrollDown(!busReplay && !!ev.cid && view.cids.has(ev.cid));   // 同上：非本窗口发的插话不强制到底
        return;
      }
      case "run_idle": {
        // 这一轮答完了，只是 Claude 起的后台任务（本地服务之类）还在跑
        const rv = runViews.get(ev.runId);
        if (rv && !rv.idle) { rv.idle = true; rv.timer?.stop(ev.at); rv.av.finish(); rv.avDone = true; }
        if (view.runIds.has(ev.runId)) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: ev.bg || 0 }), "ok");
        return;
      }
      case "run_busy": {
        // 后台任务回报了，Claude 接着干：另起一个气泡、重新计时
        const rv = runViews.get(ev.runId);
        if (!rv || !rv.idle) return;
        rv.idle = false;
        if (rv.avDone) { rv.av = AssistantView(liveEl, true); tagRun(rv.av.msgEl, ev.runId); rv.avDone = false; }
        rv.timer = RunTimer(ev.startedAt);
        rv.timer.attach(rv.av);
        rv.av.phase({ phase: "connect" });
        scrollDown();     // 不强制：用户正往上翻着看就别拽回底部（审查 #48 06-01）
        return;
      }
      case "init": {
        if (!view.runIds.has(ev.runId)) return;
        // 本页已经属于 A，这个 run 却 init 成 B：它是聚合认回来的另一条草稿，从这里摘出去（0.6.9 #191-1）
        if (view.sessionId && ev.sessionId && ev.sessionId !== view.sessionId) return detachRun(ev.runId);
        if (!view.sessionId && ev.sessionId) { view.sessionId = ev.sessionId; draftAdopt(ev.sessionId); adoptPendingModel(); saveUiState(); }
        if (ev.model) { state.model = ev.model; paintModel(ev.model); }
        if (ev.permissionMode) setPermChip(ev.permissionMode);
        return;
      }
      case "run_end": refreshQuota(); return onRunEnd(ev);
      case "quota": case "billing": return refreshQuota();
      case "perm_mode":
        state.settings.permissionMode = ev.mode;
        setPermChip(ev.mode);
        if ($("set-perm")) $("set-perm").value = ev.mode;
        // 网关把在跑的每一轮都当场切到了这个模式（gw/queue.mjs setPermMode）：手里的快照跟着改，
        // 等着的计划卡按新模式重排按钮，别让旧按钮把刚切的模式改回去（#175-2）
        for (const r of srv.runs) if (r.permMode) r.permMode = ev.mode;
        refreshPlanActs();
        return;
      case "perm_request": if (runViews.has(ev.runId)) onPermRequest(ev); return;
      case "perm_resolved": return permDone(ev.id, ev.behavior, ev);
    }
    const rv = runViews.get(ev.runId);
    if (!rv) return;
    const av = rv.av;
    switch (ev.type) {
      case "usage":          if (ev.contextTokens) liveCtx(ev.contextTokens, state.ctxTotal); break;
      case "run_tokens":     rv.out = +ev.out || 0; if (statRun === ev.runId) statPaint(); break;
      case "delta":          av.delta(ev.text); break;
      case "assistant_text": av.text(ev.text); break;
      case "thinking_delta": av.thinkDelta(ev.text); break;
      case "thinking":       av.thinking(ev.text); break;
      case "discard_partial": av.discard(ev.text || 0, ev.think || 0); break;
      case "tool_use": {
        const pc = ev.parent && TOOL_CARDS.get(ev.parent);
        if (ev.parent) agStep(ev.parent, ev.name, ev.input);
        if (pc && pc.isAgent) { pc.sub(ev.id, ev.name, ev.input); break; }
        // 父卡在更早的历史页里没加载：子步骤别落成主流程卡（绕过懒渲染、成百上千张）；翻到父卡时过程按需从代理记录读（#69）
        if (ev.parent) break;
        av.tool(ev.id, ev.name, ev.input); break;
      }
      case "ag":             agApply(ev, av); break;
      case "sub_text":       TOOL_CARDS.get(ev.parent)?.subText?.(ev.text); break;
      case "sub_progress":   TOOL_CARDS.get(ev.parent)?.subProgress?.(ev.desc); break;
      case "sub_done":       TOOL_CARDS.get(ev.parent)?.subDone?.(ev.status); break;
      case "tool_result":
        if (ev.parent && !TOOL_CARDS.get(ev.parent)) break;   // 同上：父卡不在，结果也不攒进待贴表
        toolResult(ev.id, ev.ok, ev.text); av.toolDone(ev.id); scrollDown(); break;
      case "phase":          av.phase(ev); break;
      // 压缩中的状态会连来好几条：同一次压缩只留一行，压完原地换成结果（#67）
      case "compacting":     av.phase(null); av.noteK("cmp" + cmpGen, t("正在压缩上下文…")); scrollDown(); break;
      case "note":           av.noteK(ev.key, ev.text); scrollDown(); break;
      case "hook_ctx":       av.hookCtx(ev.event, ev.text); scrollDown(); break;
      case "compacted":
        av.noteK("cmp" + cmpGen++, ev.pre != null && ev.post != null
          ? t("上下文已压缩：{pre} → {post} tokens", { pre: ev.pre.toLocaleString(), post: ev.post.toLocaleString() })
          : t("上下文已压缩"), true);
        if (ev.post != null) liveCtx(ev.post, state.ctxTotal);
        scrollDown(); break;
      case "error":          av.error(ev.message + (ev.detail ? "\n\n" + ev.detail : "")); break;
    }
  }

  function onHello(ev) {
    helloCount++;
    // 网关重启而 WebView 没刷新时 helloCount>1：boot 变了，按「刚打开」处理被中断的会话，
    // 否则「继续」卡只在会话列表里，眼前这页什么也没有（0.6.9 审计 195 恢复链）
    const bootRestart = helloCount > 1 && !!ev.boot && !!view.gwBoot && ev.boot !== view.gwBoot;
    if (ev.boot) view.gwBoot = ev.boot;
    if (ev.uiTag && uiTag != null && ev.uiTag !== uiTag) {
      // 新界面已经部署了：生成在网关里不受影响，放心刷新
      setStatus(t("界面已更新，正在刷新…"), "warn");
      location.reload();
      return;
    }
    if (ev.uiTag) uiTag = ev.uiTag;
    // 认领没建会话的草稿（#171/#172）：只在首次连接（重载、重开 App）或点了侧栏「没建会话的新对话」时做；
    // 平常点「新对话」是一张白纸，不把别的草稿拽进来
    const adoptDrafts = helloCount === 1 || view.adoptDrafts;
    view.adoptDrafts = false;
    applyState(ev);
    if (ev.resume) { calmStatus(t("已连接")); return; }
    beginReplay();

    // 续不上（首次连接 / 网关重启过 / 断太久）：本视图从头来 —— 历史重新取，
    // 正在跑的那一轮紧接着会被网关整轮重放过来
    if (helloCount === 1 && ev.run && !ev.run.ended && !view.sessionId) {
      // 刚打开界面时网关正忙、本地又不知道看哪条（没有上次的会话号）：直接跟上那一轮。
      // 本地记着会话号时不再改道：以前会覆盖用户最后查看的会话并交换草稿（0.6.9 审计 195-P.7）
      const sid1 = ev.run.sessionId || null;
      // 自动跟到别的会话也要按每会话草稿的契约交接（#120-3）：A 没发的字和附件留在 A，输入框换成 B 自己的草稿；
      // 不然 A 的草稿会顶着 B 的会话号发出去
      if (sid1 !== (view.sessionId || null)) draftSwap(view.sessionId, sid1);
      view.sessionId = sid1;
      if (!sid1) view.runIds.add(ev.run.id);
      saveUiState();
    } else if ((helloCount === 1 || bootRestart) && !ev.run && !view.sessionId && intrList(ev.interrupted).pop()?.sessionId) {
      // 刚打开、上一轮是被系统杀掉的：直接回到最近开始的那个会话，「继续」卡就挂在它底下；其余的在会话列表里标着
      // （最近那轮还没建会话就留在新会话页，「重发」卡在这里）
      const sid1 = intrList(ev.interrupted).pop().sessionId;
      if ((sid1 || null) !== (view.sessionId || null)) draftSwap(view.sessionId, sid1);   // 同上：草稿按会话交接
      view.sessionId = sid1;
      saveUiState();
    }
    const keepRuns = new Set(view.runIds), keepCids = new Set(view.cids), keepCidRuns = new Map(view.cidRuns);
    const sid = view.sessionId, keepProj = view.projectId, keepMerge = view.pendingMerge;   // 重连会重置视图：新会话已挑的项目、汇合来源留着
    // 锚点 / 续读请求还在途（view.anchor 已被 loadOlder 取走）：整轮重连后按原目标再发一次，
    // 不能因为 view.next 还没有值就退回最新页（0.6.9 #191-2）
    const pend = view.pendNav && view.pendNav.sid === sid ? view.pendNav : null;
    // 「上次读到」：启动时（浏览器刚打开、helloCount=1）直接落回上次的位置，不用等到切会话才记；
    // 网关重启但页面没刷新时，正在上翻的位置也先记下来再恢复（0.6.9 审计 195-AA.4 / 196-本地状态.2）
    if (sid && !view.anchor && !pend && (helloCount === 1 ? !view.userOpen : !stick)) {
      if (helloCount > 1 && sid === view.sessionId && typeof saveLastRead === "function") saveLastRead();
      // typeof 守卫：hello-draft-v062 的测试单独切 onHello 出来跑，那里没有 18d 的 lastReadOf
      const lr = typeof lastReadOf === "function" ? lastReadOf(sid) : null;
      if (lr) view.anchor = lr;
    }
    const resume = sid && view.next != null && !view.anchor ? view.cursor : null;   // 正看着中间某一段：重连后接着那段
    resetView(sid, !sid);
    if (pend) { view.anchor = pend.anchor || ""; view.resume = pend.resume ?? null; }
    else if (resume != null) view.resume = resume;
    if (!sid && keepProj) { view.projectId = keepProj; paintProjChip(); }
    if (!sid) view.pendingMerge = keepMerge || null;
    view.runIds = keepRuns; view.cids = keepCids; view.cidRuns = keepCidRuns;
    // 没建会话的轮次（停在启动前确认卡上、或刚起还没拿到会话号）：发它的草稿页切走后 cid 对不上，哪页都认不出来。
    // 认领时全部接回新对话页（不只 latestRun 那一条，#172-1），卡片和过程随整轮重放画出来
    let adopted = false;
    if (!sid && adoptDrafts) for (const r of ev.runs || (ev.run ? [ev.run] : [])) if (!r.sessionId) { view.runIds.add(r.id); adopted = true; }
    pickViewRun();
    renderSessions();
    if (sid) loadOlder(true);
    else if (!adopted && !(ev.run && keepRuns.has(ev.run.id))) showWelcome();
    renderInterrupted(ev.interrupted);   // resetView 清掉了 liveEl，重挂一次
    calmStatus(t("已连接"));
  }
  /** 「已连接」「就绪」这类平静的状态：这个会话正在生成时不许盖掉「生成中」（审查 #51 第4项） */
  function calmStatus(text) {
    if (isBusy()) setStatus(t("生成中…"), "live"); else setStatus(text, "ok");
  }

  // 这一轮画出来的消息记下 run 号；收尾时标上存没存稳（加书签时数「后面同样的话」要用，审查 #52 S2-02）
  function tagRun(el, runId) { if (el && el.classList.contains("msg")) el.dataset.run = runId; }
  // #live 只增不减：连聊几十轮 DOM 一直涨（0.6.9 审计 195-Q.8）。贴底时把已收尾的旧消息裁掉，
  // 更早的内容重开会话时照样从会话记录读回来；用户正在往上翻就不动，免得脚下被抽走
  const LIVE_MAX = 80;
  function trimLive() {
    if (!stick) return;
    const done = [...liveEl.children].filter((el) => el.classList.contains("msg") && el.dataset.done);
    if (done.length <= LIVE_MAX) return;
    for (const m of done.slice(0, done.length - LIVE_MAX)) { dropCards(m); m.remove(); }
  }
  function onRunEnd(ev) {
    // retired：答完了、只剩后台任务，用户点了停止 / 立即发送把它整轮结束——回答是完整的，不算中断
    const cut = ev.aborted && !ev.retired;
    for (const m of chatEl.querySelectorAll(`.msg[data-run="${CSS.escape(ev.runId)}"]`)) m.dataset.done = ev.failed || cut ? "bad" : "ok";
    if (view.goalClearAfter && view.goalClearAfter.runId === ev.runId) {
      const sid = view.goalClearAfter.sid || ev.sessionId;
      view.goalClearAfter = null;
      // 发给放弃目标的那个会话：点放弃之后、收尾前后切到别的会话，都不能用当时的视图去发（审查 #49 / #52 P2-15）
      setTimeout(() => {
        if (sid && view.sessionId === sid) return send("/goal clear");
        if (sid) api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "/goal clear", sessionId: sid, cid: newCid(), mode: "auto" }) }).catch((e) => toast(e.message, true));
      }, 300);
    }
    const rv = runViews.get(ev.runId);
    // 不在当前视图里画的一轮（别的会话在后台跑完）：数照样按会话记下，切过去就能看到
    if (!rv) { if (!ev.localCommand && ev.sessionId) { const st = statBits(ev); if (st) statSave(ev.sessionId, st); } if (belongs(ev)) loadSessions(); return; }
    const av = rv.av;
    rv.timer?.stop(ev.at);
    // 实时那份先停；本地命令（/context 等）不算一轮，底栏回到上一轮的数，普通一轮下面再定格
    if (statRun === ev.runId) { statStop(); statEl.textContent = statLast[view.sessionId || ev.sessionId] || ""; }
    for (const [id, it] of PERMS) if (it.runId === ev.runId && !it.done) permDone(id, "stopped");
    if (ev.sessionId && !view.sessionId && view.runIds.has(ev.runId)) { view.sessionId = ev.sessionId; draftAdopt(ev.sessionId); adoptPendingModel(); saveUiState(); }
    if (ev.usage?.context_tokens) liveCtx(ev.usage.context_tokens, ev.usage.context_window || state.ctxTotal);

    if (ev.localCommand && ev.resultText) {
      av.finish();
      if (av.empty) av.remove();
            const b = mkMsg("sys", t("命令"), liveEl);
      setHtml(b, `<div class="cmd-card"><div class="cmd-name">${esc("/" + ev.localCommand)}</div>${renderMd(ev.resultText)}</div>`);
      if (ev.localCommand === "context") parseContextText(ev.resultText);
      if (ev.localCommand === "model" || ev.localCommand === "effort") { loadSettings(); refreshSessModel(); }
      // 压缩线的刻度在 loadModels 里刷（以前只有切模型才会调它，所以设完要切一次模型才看得到）
      if (ev.localCommand === "autocompact") loadModels();
    } else {
      const bad = !!(ev.failed || ev.isError);
      av.finish(cut, bad);
      if (cut) { av.note(t("已中断")); agStopAll(ev.at); }
      else if (ev.retired || bad) agStopAll(ev.at);   // 后台子代理随进程一起停了 / 这一轮失败
      const st = statBits(ev, rv.out);
      if (st) { statEl.textContent = st; statSave(view.sessionId || ev.sessionId, st); }
    }
    // 普通一轮出错网关给的是 isError（启动失败才是 failed），两个都要认（审查 #51 第3项）
    if (ev.failed || ev.isError) setStatus(t("失败"), "err");
    else if (cut) setStatus(t("已中断"), "warn");
    else setStatus(t("就绪"), "ok");
    if (rv) srSay(ev.failed || ev.isError ? t("回复出错") : cut ? t("已中断") : t("回复完成"));
    trimLive();
    scrollDown();
    loadSessions();
    if (!state.caps?.slashCommands?.length) loadCaps();
  }

  // ── 忙闲与排队（都以网关为准）──────────────────────────────────────
  // 篡改留痕（网关 gw/tamper.mjs）：应用文件被改过、已还原，提示一次；点「知道了」告诉网关，换个界面也不再提
  // 有新的才弹；弹的时候把还没点过的全列上（替换式的提示条，只列新的会把上一批顶掉，DeepSeek 复核建议 7）
  const tamperShown = new Set();
  function showTamper(list) {
    list = list || [];
    const key = (e) => e.id + ":" + (e.files || []).length;
    if (!list.some((e) => !tamperShown.has(key(e)))) return;
    for (const e of list) tamperShown.add(key(e));
    const claude = list.some((e) => e.src === "claude");
    const files = [...new Set(list.flatMap((e) => e.files || []))];
    console.warn("[tamper]", list);
    const ids = list.map((e) => e.id);
    toastAct((claude ? t("Claude Code 程序被改过，已拒绝启动；") : "") + t("应用文件被改过，已按安装包还原：") + files.slice(0, 3).join(", ") + (files.length > 3 ? " …" : ""),
      t("知道了"), () => { for (const id of ids) api("/api/tamper/ack?id=" + id, { method: "POST" }).catch(() => {}); });
  }
  function applyState(s) {
    showTamper(s.tamper);
    srv.runs = s.runs || (s.run ? [s.run] : []);
    srv.intr = intrList(s.interrupted);
    srv.queueAll = s.queue || [];
    if (s.maxParallel) srv.max = s.maxParallel;
    pickViewRun();
    if (srv.run?.permMode) setPermChip(srv.run.permMode);   // 这一轮实际在用的模式，以网关为准（安全通告 GHSA-2w6p）
    refreshPlanActs();
    const busy = isBusy();
    syncPlaceholder();
    syncInterject();
    renderQueue();
    lineageRuns();
    // 别的窗口（或网关那边）已经答掉的，这里也收起来
    const livePerms = new Set((srv.run?.perms || []).map((p) => p.id));
    for (const [id, it] of PERMS) if (!it.done && srv.run && it.runId === srv.run.id && !livePerms.has(id) && it.p.at < Date.now() - 1500) permDone(id, "gone");
    if (busy) setStatus(t("生成中…"), "live");
    else if (srv.run?.idle) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: srv.run.bg || 0 }), "ok");
    else if (srv.runs.some((r) => !r.idle)) setStatus(t("另有 {n} 个会话在生成", { n: srv.runs.filter((r) => !r.idle).length }), "ok");
    // 别的会话在等你确认：当前视图看不到它的卡片，状态栏和会话列表里提醒
    const elsewhere = srv.runs.filter((r) => r !== srv.run && r.perms && r.perms.length);
    // 还没建会话的（启动前的确认卡）不在会话列表里，指到侧栏的草稿入口——点了会把它们认回新对话页（#171/#172）
    if (elsewhere.length) setStatus(elsewhere.every((r) => !r.sessionId) ? t("有个新对话在等你确认 · 侧栏「没建会话的新对话」里查看") : t("另一个会话在等你确认 · 打开会话列表查看"), "warn");
    // 没有任何一轮在等确认时回「就绪」：权限在别的会话解决后，状态栏以前会一直挂着「等你确认」直到下一轮（0.6.9 审计 195-B.10）。
    // 网关断开时不碰，留给 setConn 的重连提示（195-BB.2）
    else if (srv.connected && !srv.runs.some((r) => r.perms && r.perms.length)
      && !isBusy() && !srv.run?.idle && !srv.runs.some((r) => !r.idle)) setStatus(t("就绪"), "ok");
    askNotice(srv.runs.flatMap((r) => (r.perms || []).map((p) => ({ id: p.id, runId: r.id }))));
    const live = srv.runs.map((r) => (r.sessionId || "") + (r.perms && r.perms.length ? "!" : "") + (r.idle ? "~" : "")).join(",") + "|" + srv.intr.map((e) => e.sessionId || "").join(",")
      + "|" + srv.queueAll.filter((q) => !q.sessionId).map((q) => q.id).join(",") + "|" + (view.sessionId || "");
    if (live !== srv.liveKey) { srv.liveKey = live; renderSessions(); }
    renderPermBar();                 // 放最后：有待确认项时状态栏要显示「等你确认」
    renderInterrupted(s.interrupted);
    renderRunStrip();
  }

  /** 网关给的中断记录：列表（旧网关是单条对象或 null） */
  function intrList(v) { return (Array.isArray(v) ? v : v ? [v] : []).filter((e) => e && e.id); }
  /** 上一轮被系统结束（App 连同网关被杀）：每个被打断的会话底部各挂一张卡，给「继续」 */
  function renderInterrupted(list) {
    let el = $("intr-card");
    const all = intrList(list);
    const it = srv.run ? null : all.filter((e) => (e.sessionId ? e.sessionId === view.sessionId : !view.sessionId)).pop();
    if (!it) { el?.remove(); return; }
    const others = new Set(all.map((e) => e.sessionId).filter((s) => s && s !== it.sessionId)).size;
    // 没建会话的一次只挂一张（最新的），处理掉再出下一张：说一声后面还有几条（#172-3）
    const drafts = it.sessionId ? 0 : all.filter((e) => !e.sessionId && e !== it).length;
    if (el && el.dataset.id === it.id && el.dataset.n === others + "/" + drafts && el.parentNode === liveEl) return;
    el?.remove();
    const b = mkMsg("sys", t("已中断"), liveEl);
    el = b.closest(".msg"); el.id = "intr-card"; el.dataset.id = it.id; el.dataset.n = others + "/" + drafts;
    const when = new Date(it.startedAt || it.at).toLocaleString();
    // why: card —— 启动前的确认卡没人答、超时停下的（#171）：claude 根本没起，有会话也只能「重发」，不能「继续」
    const card = it.why === "card", cont = !!it.sessionId && !card;
    setHtml(b, `<p>${esc(card ? t("这一轮没有开始：启动前的确认卡 {n} 分钟没人回答，已经停下了（{when} 发的）。", { n: 10, when })
        // cause：网关分得清的中断原因（195-A.11）。没有就是没打招呼就没了：系统回收、强行停止
        : it.cause === "update" ? t("这一轮没跑完：App 更新时网关重启了（{when} 开始的）。", { when })
        : it.cause === "stop" ? t("这一轮没跑完：网关被关闭或重启了（{when} 开始的）。", { when })
        : t("这一轮没跑完：App 在后台被系统结束了（{when} 开始的）。", { when }))}</p>
      <blockquote>${esc(String(it.text || "").slice(0, 300))}</blockquote>
      <p class="perm-sub">${esc(card ? t("Claude 没收到这条消息。点「重发」把它放回输入框。")
        : it.sessionId ? t("已经做完的部分都在会话里。点「继续」让 Claude 从断开的地方接着做。")
        : t("会话还没来得及建立，Claude 没收到这条消息。点「重发」把它放回输入框。"))}</p>
      ${others ? `<p class="perm-sub">${esc(t("另有 {n} 个会话同时被中断，在会话列表里标着「已中断」。", { n: others }))}</p>` : ""}
      ${drafts ? `<p class="perm-sub">${esc(t("还有 {n} 条没建会话的消息也停下了，处理完这条接着显示下一条。", { n: drafts }))}</p>` : ""}
      <div class="perm-acts"><button class="primary" data-a="go">${esc(cont ? t("继续") : t("重发"))}</button>
      <button data-a="no">${esc(t("忽略"))}</button></div>`);
    b.querySelector(".perm-acts").addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (!a) return;
      el.remove();
      if (a === "go" && cont) return send(t("上一轮被系统中断了，请从断开的地方接着做完。"));
      if (a === "go") {
        // 重发要按原样发：运行标记里记了当时的项目、钉的模型和汇合来源（0.6.9 审计 195-AA.5）。
        // 面板都在别的段里，用它们的公开设置（view.projectId + paintProjChip / state.pendingModel + refreshSessModel），别另写一套
        const req = it.req || {};
        if (!view.sessionId) {
          if (req.projectId) { view.projectId = req.projectId; paintProjChip(); }
          if (req.pin) { state.pendingModel = req.pin; refreshSessModel(); }
          if (req.mergeFrom) view.pendingMerge = req.mergeFrom;
        }
        inputEl.value = it.text || "";
        autoGrow(); inputEl.focus();
        if (it.textCut) toast(t("原消息太长，只恢复了前 6.5 万字"));
      }
      api("/api/interrupted/dismiss", { method: "POST", body: JSON.stringify({ id: it.id }) }).catch(() => {});
    });
    scrollDown(true);
  }
  const isBusy = () => !!srv.run && !srv.run.idle;
  /** 并行上限满了：和网关 pump 同一口径按进程数算，只剩后台任务的空闲轮次也占着槽（#142-3：以前不算它，
   *  满了却说成「这个会话的上一轮还没结束」，新会话哪来的上一轮） */
  const atCap = () => srv.runs.length >= (srv.max || 3);

  /** 并行多会话：从网关的全部轮次和队列里挑出属于当前视图的 */
  function runInView(r) {
    return (view.sessionId && r.sessionId === view.sessionId) || view.runIds.has(r.id) || (!!r.follow && view.runIds.has(r.follow)) || (!!r.cid && view.cids.has(r.cid));
  }
  function queuedInView(q) {
    if (q.sessionId) return q.sessionId === view.sessionId;
    // 网关重启恢复的、还没建会话的那条：界面重载后 runIds/cids 都清了，认不出是哪页的，放到新对话页（审查 B28）。
    // 跟着的那一轮已经结束（确认卡超时、被停掉）的也一样：不然它留在队列里，哪页都看不见、撤不回（#172-2）
    if (!view.sessionId && (q.intr || !(q.follow && srv.runs.some((r) => r.id === q.follow)))) return true;
    return view.runIds.has(q.id) || (!!q.follow && view.runIds.has(q.follow)) || (!!q.cid && view.cids.has(q.cid));
  }
  /** 把属于别的会话的一轮从当前视图摘掉（0.6.9 #191-1）：聚合认回的无会话号草稿在 init 后各自有了会话号，
   *  留在本页会让标题/发送指向 A、停止和正文却是 B。DOM、索引、cid 一起摘，摘完重挑当前轮 */
  function detachRun(runId) {
    view.runIds.delete(runId);
    for (const [cid, rid] of view.cidRuns) if (rid === runId) { view.cidRuns.delete(cid); view.cids.delete(cid); }
    const rv = runViews.get(runId);
    if (rv) { rv.timer?.stop(); rv.av?.remove(); runViews.delete(runId); }
    for (const m of chatEl.querySelectorAll(`.msg[data-run="${CSS.escape(runId)}"]`)) m.remove();
    for (const [id, it] of PERMS) if (it.runId === runId) { it.el?.remove(); PERMS.delete(id); }
    if (srv.run?.id === runId) { srv.run = null; pickViewRun(); }
    renderPermBar(); renderRunStrip(); renderQueue(); syncInterject();
    loadSessions();          // B 已经是独立会话了，让它出现在列表里
  }
  function pickViewRun() {
    srv.run = srv.runs.filter(runInView).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    srv.queue = srv.queueAll.filter(queuedInView);
  }

  /** 插话键只在「正在跑 + 输入框里有字」时露头 */
  function syncInterject() {
    const has = hasDraft(), stop = isBusy() && !has;
    interjectEl.classList.toggle("hidden", !(isBusy() && has));
    sendEl.classList.toggle("busy", stop);
    // 读屏要跟着变：生成中空输入框时这个键是「停止」（审查 #49 P2-14）
    const lab = stop ? t("停止") : t("发送");
    if (sendEl.getAttribute("aria-label") !== lab) { sendEl.setAttribute("aria-label", lab); sendEl.title = lab; }
  }

  function renderQueue() {
    const q = srv.queue;
    queueStrip.classList.toggle("hidden", !q.length);
    const busy = isBusy();
    queueStrip.innerHTML = q.length ? `
      <div class="q-head">
        <span>${q.some((it) => it.held)
          ? q.some((it) => it.intr)
            ? t("上一轮被系统中断，{n} 条排队的消息已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
            : t("点了停止，{n} 条已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
          : busy ? t("待发 {n} 条 · 当前这一轮结束后依次发出", { n: q.length })
          // 真到并行上限才这么说；否则是这个会话上一轮还挂着（等后台任务 / 收尾），别让人以为开了好几个会话
          : atCap() ? t("同时在跑的会话已到上限（{max} 个），有空位就依次发出 · 待发 {n} 条", { max: srv.max, n: q.length })
          // 答完了、只剩后台任务（比如一条一直开着的隧道），输入又已经关了：不点立即发送就要等到它自己结束
          : srv.run?.sealed ? t("待发 {n} 条 · 后台任务还在跑，这一轮收不进新消息了，要等它结束 · 点「立即发送」会停掉后台任务再发", { n: q.length })
          : t("待发 {n} 条 · 这个会话的上一轮还没完全结束（后台任务在跑或正在收尾），结束后依次发出", { n: q.length })}</span>
        <button class="q-clear">${t("全部清除")}</button>
      </div>
      ${q.map((it) => `
        <div class="msg user qitem${it.held ? " held" : ""}" data-id="${esc(it.id)}">
          <div class="who"><span class="dot"></span>${it.sched ? t("定时任务") : t("你")} · <span class="q-tag">${it.held ? t("已暂停") : t("排队中")}</span></div>
          <div class="bubble" dir="auto">${esc(it.text)}</div>
          <div class="q-acts">
            <button class="q-now" title="${!busy ? t("发出这条") : it.sched ? t("定时任务要单独跑一轮：挪到最前，这一轮结束后马上发出") : t("插话：递进正在跑的这一轮，不打断")}">${t("立即发送")}</button>
            <button class="q-x" title="${t("撤销这条")}">${t("撤销")}</button>
          </div>
        </div>`).join("")}` : "";
    if (q.length) scrollDown();
  }
  queueStrip.addEventListener("click", async (e) => {
    const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .catch((err) => toast(err.message, true));
    if (e.target.closest(".q-clear")) return post("/api/queue/clear", { ids: srv.queue.map((it) => it.id) });
    const item = e.target.closest(".qitem");
    if (!item) return;
    if (e.target.closest(".q-x")) return post("/api/queue/remove", { id: item.dataset.id });
    if (e.target.closest(".q-now")) {
      if (srv.run?.sealed && srv.run.bg && !confirm(t("立即发送要先停掉还在跑的 {n} 个后台任务。继续？", { n: srv.run.bg }))) return;
      if (!view.sessionId) view.runIds.add(item.dataset.id);   // 新对话页放行的：跑起来的这一轮 id 就是它，视图跟上
      return post("/api/queue/promote", { id: item.dataset.id });
    }
  });


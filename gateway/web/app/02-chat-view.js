  // ── 对话视图 ──────────────────────────────────────────────────────
  //  v3：照 Claude Desktop 的路子 —— 生成归网关管，界面只是订阅者。
  //   · 一条 EventSource（/api/events）收所有进度；断线自动续传，续不上就整轮重放
  //   · 发消息只是 POST 一下拿个号，排队也在网关那边（刷新不丢、两个窗口看到同一份）
  //   · 历史从文件尾倒着按页取，往上滚再取更早的
  //  #chat 里分三层：#older（加载更早）/ #hist（历史页）/ #live（本次打开后实时跑的）
  chatEl.innerHTML = `<button id="older" class="hidden">${t("加载更早的消息")}</button><div id="hist"></div><div id="live"></div>`;
  chatEl.appendChild(queueStrip);
  const olderEl = $("older"), histEl = $("hist"), liveEl = $("live");

  const view = {
    sessionId: null,
    gen: 0,              // 每换一次会话 +1，迟到的历史响应据此作废
    cursor: null,        // 历史翻页游标（字节偏移，0 = 到头）
    loading: false,
    runIds: new Set(),   // 属于本视图的 run（新会话在拿到会话号前靠它认亲）
    cids: new Set(),     // 本窗口发出的消息号
    cidRuns: new Map(),  // 消息号 → run 号：聚合草稿 init 后要按会话拆开时，连 cid 一起摘掉（#191-1）
    lastRunId: null,
    title: "",
    goal: null,          // 本会话的 /goal 状态（网关从会话记录里推出来的，见 goalStateOf）
    goalHide: 0,         // 点 ✕ 收起的那条达成 / 失败记录的时间戳
    tasks: null,         // 本会话的任务清单（TaskCreate / TaskUpdate，网关读 ~/.claude/tasks 推过来）
    tasksHide: "",       // 点 ✕ 收起时这份清单的编号集合；换了一份清单（增删了项）才重新露出来
  };
  // run / queue 只算当前视图的（本会话正在跑的那一轮、本会话排着的）；runs / queueAll 是网关上的全部
  const srv = { run: null, queue: [], runs: [], queueAll: [], intr: [], max: 3, connected: false };
  const runViews = new Map();     // runId → { av, startedAt }
  const TOOL_CARDS = new Map();   // tool_use id → 卡片（结果可能在另一页、另一个气泡里）
  /** 历史页被裁掉：页里的卡片（含收着的子代理步骤）从索引里放掉，不然整页 DOM 还被这里拽着（审查 #49 P3-7） */
  function dropCards(root) {
    for (const [k, c] of TOOL_CARDS) { const el = c.el || c.host; if (el && root.contains(el)) TOOL_CARDS.delete(k); }
    for (const [k, c] of AG.cards) if (c.el && root.contains(c.el)) AG.cards.delete(k);
  }
  // 工具结果按 tool_use id 单独留一份，不跟着卡片走（#120-4）：结果可能比卡片先到（在同一页里结果排在调用后面、
  // 但跨页时可能先渲染），也可能卡片所在页已经被 MAX_PAGES 窗口裁掉、等往上翻回来时才重建；
  // 只贴着卡片存的话，裁掉再补回来结果正文和失败状态就没了。条数和总字数都有上限，长会话也不会一直涨。
  const TOOL_RESULTS = new Map();     // tool_use id → { ok, text }
  const RESULT_MAX = 2000, RESULT_CHARS = 8000000;
  let resultChars = 0;
  function rememberResult(id, ok, text) {
    const old = TOOL_RESULTS.get(id);
    if (old) { resultChars -= old.text.length; TOOL_RESULTS.delete(id); }
    const v = { ok: !!ok, text: String(text || "") };
    TOOL_RESULTS.set(id, v); resultChars += v.text.length;
    while (TOOL_RESULTS.size > RESULT_MAX || (resultChars > RESULT_CHARS && TOOL_RESULTS.size > 1)) {
      const k = TOOL_RESULTS.keys().next().value;      // 先丢最早的；刚存进来的最后才轮到（只剩它就不再丢）
      resultChars -= TOOL_RESULTS.get(k).text.length;
      TOOL_RESULTS.delete(k);
    }
  }
  /** 换会话 / 重连时连同结果表一起清：历史重新加载时会再送一遍，跨会话的旧结果没必要留着 */
  function clearToolResults() { TOOL_RESULTS.clear(); resultChars = 0; }
  /** 用户亲手收起 / 展开过的步骤组、子代理卡：按会话记在内存里，切走再切回按原样还原（#87）。
   *  键是组里第一个工具的 id（"g:"）或代理卡第一个工具的 id（"a:"），值 true = 展开、false = 收起。只记这次打开应用期间 */
  const FOLDS = new Map();
  function foldGet(key) { const m = view.sessionId && FOLDS.get(view.sessionId); return m ? m.get(key) : undefined; }
  function foldSet(key, open) {
    if (!view.sessionId || !key) return;
    let m = FOLDS.get(view.sessionId);
    if (!m) { m = new Map(); FOLDS.set(view.sessionId, m); if (FOLDS.size > 40) FOLDS.delete(FOLDS.keys().next().value); }
    m.delete(key); m.set(key, open);
    if (m.size > 400) m.delete(m.keys().next().value);
  }

  function mkMsg(role, label, parent) {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    const name = label || (role === "user" ? t("你") : role === "sys" ? t("命令") : "Claude");
    el.innerHTML = `<div class="who"><span class="dot"></span>${esc(name)}</div><div class="bubble" dir="auto"></div>`;
    (parent || liveEl).appendChild(el);
    return el.querySelector(".bubble");
  }
  function addSysMsg(text, title, parent) {
    const b = mkMsg("sys", t("命令"), parent);
    setHtml(b, title
      ? `<div class="cmd-card"><div class="cmd-name">${esc(title)}</div>${renderMd(text)}</div>`
      : renderMd(text));
    scrollDown(true);
    return b;
  }
  // 钩子往上下文里塞的话：平时只露一行「钩子塞了多少字」，点开才把原文放进 DOM（长文本别常驻，同思考块的懒渲染）
  function hookCtxEl(ev, text) {
    const el = document.createElement("div");
    el.className = "hook-ctx";
    const b = document.createElement("button");
    b.type = "button"; b.className = "hook-ctx-h";
    b.textContent = t("钩子（{e}）往这一轮的上下文里加了 {n} 字", { e: ev || "?", n: String(text).length });
    b.setAttribute("aria-expanded", "false");
    b.onclick = () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      if (!open) return el.querySelector(".hook-ctx-b")?.remove();
      const pre = document.createElement("pre");
      pre.className = "hook-ctx-b"; pre.textContent = text;
      el.appendChild(pre);
    };
    el.appendChild(b);
    return el;
  }
  function addHookCtx(ev, text, parent) { const el = hookCtxEl(ev, text); (parent || liveEl).appendChild(el); return el; }
  function addNote(text, parent) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = text;
    (parent || liveEl).appendChild(el);
    return el;
  }
  const ICONS = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    share: '<path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/>',
    resend: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    fork: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-7 4-11.2 8.6"/>',
    rewind: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    mark: '<path d="M7 3.5h10a1 1 0 0 1 1 1V20l-6-4.2L6 20V4.5a1 1 0 0 1 1-1z"/>',
    del: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  };
  // 消息底下按钮行里藏哪几个（0.4.20，设置 → 通用 → 消息下面的按钮；存 ccapp-ui.json 的 msgActs = { user: [...], bot: [...] }）。
  // 只用一段样式藏起来，不改渲染：长对话里成百上千个按钮行不用重画
  const ACTS = { user: ["copy", "resend", "rewind", "mark", "del"], bot: ["copy", "share", "fork", "mark", "del"] };
  function msgActsHidden() {
    const v = uiGet("msgActs") || {}, ok = (w, a) => (Array.isArray(a) ? a.filter((k) => ACTS[w].includes(k)) : []);
    return { user: ok("user", v.user), bot: ok("bot", v.bot) };
  }
  function paintActHide() {
    const h = msgActsHidden(), sel = [];
    for (const w of ["user", "bot"]) {
      for (const k of h[w]) sel.push(`.msg.${w} > .msg-acts > [data-a="${k}"]`);
      if (h[w].length === ACTS[w].length) sel.push(`.msg.${w} > .msg-acts`);
    }
    let el = document.getElementById("acts-hide");
    if (!el) { el = document.createElement("style"); el.id = "acts-hide"; document.head.appendChild(el); }
    el.textContent = sel.length ? sel.join(",") + "{display:none !important}" : "";
  }
  paintActHide();
  document.addEventListener("cc:ui", (e) => { if (e.detail.key === "msgActs") paintActHide(); if ((e.detail.key === "accent" || e.detail.key === "gcPaper") && window.Theme) Theme.apply(); });

  const UI_I = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    list: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10l2 2 4-4M8 16h8"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    ring: '<circle cx="12" cy="12" r="6.5"/>',
    half: '<circle cx="12" cy="12" r="6.5"/><path d="M12 5.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    clip: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h4"/>',
  };
  const uiI = (n, cls) => `<svg class="ui-i${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${UI_I[n]}</svg>`;
  const userTextOf = new WeakMap();   // 用户气泡 → 原文（分叉时拿它在 transcript 里认出是哪一轮）
  const actBtn = (a, label) => `<button data-a="${a}" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24">${ICONS[a]}</svg></button>`;
  // 发送时附件以「@路径」接在末尾（claude 靠它读文件）。气泡里不露这串前缀：末尾那段纯 @路径 拆出来，
  // 图片画成缩略图、别的文件画成小卡片；复制 / 重发仍用原文
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i;
  // 大附件（超过 BIG_ATT）不写成 @路径（claude 会整份读进上下文），写成「[附件：路径 · 大小，…]」只给路径，
  // 气泡里照样画成文件卡片（不出缩略图）
  //   认准后面那段固定文字（05-composer.js attRef），路径按最短匹配取：文件名里带「 · 」「]」也不截错
  const BIG_REF = "\\[附件：(\\/[^\\n]+?) · [^\\n·，\\]]+，文件较大没有直接读入，需要时按路径读取\\]";
  // 文件名带空白时发送端写成 @"…"（05-composer.js attAt）：这里也要当成一条引用拆出来，
  // 否则气泡里会露出一串 @路径，文件卡片也没有（0.6.9 审计 195-D.2）
  const AT_REF = '@"(?:[^"\\\\]|\\\\.)*"';
  const REF1 = "(?:" + AT_REF + "|@\\/\\S+|" + BIG_REF + ")", REF_TAIL = new RegExp(REF1 + "(?:\\s+" + REF1 + ")*\\s*$");
  function splitRefs(text) {
    const m = REF_TAIL.exec(text || "");
    if (!m) return [text, []];
    const refs = [...m[0].matchAll(new RegExp(REF1, "g"))].map(([r, big]) =>
      big ? { p: big, big: true } : r.startsWith('@"') ? { p: r.slice(2, -1).replace(/\\(\\|"|n|r|t)/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c)) } : { p: r.slice(1) });
    return [text.slice(0, m.index).trimEnd(), refs];
  }
  function refsHtml(refs) {
    const FILE = '<svg class="ui-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    return `<div class="u-refs">${refs.map(({ p, big }) => !big && IMG_RE.test(p)
      ? `<button class="u-ref img" data-p="${esc(p)}"><img src="${fileUrl(p)}" alt="" loading="lazy"></button>`
      : `<button class="u-ref" data-p="${esc(p)}">${FILE}<span>${esc(p.split("/").pop())}</span></button>`).join("")}</div>`;
  }
  function renderUser(text, parent, uuid) {
    const b = mkMsg("user", null, parent);
    if (uuid) b.parentElement.dataset.uuid = uuid;   // 书签落点
    userTextOf.set(b.parentElement, text);
    const [body, refs] = splitRefs(text);
    setHtml(b, body ? renderMd(body) : "");
    linRefLinks(b);   // 档号可点（18e-lineage-merge.js）
    b.addEventListener("click", (e) => { const a = e.target.closest(".u-chref"); if (a) linGoRef(a.dataset.ref); });
    b.addEventListener("keydown", (e) => { const a = e.key === "Enter" && e.target.closest(".u-chref"); if (a) linGoRef(a.dataset.ref); });
    if (refs.length) {
      b.insertAdjacentHTML("beforebegin", refsHtml(refs));
      if (!body) b.classList.add("hidden");
      b.parentElement.querySelector(".u-refs").addEventListener("click", (e) => {
        const r = e.target.closest(".u-ref"); if (!r) return;
        r.classList.contains("img") ? openLightbox(r.dataset.p) : openPath(r.dataset.p);
      });
    }
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + actBtn("resend", t("重发")) + actBtn("rewind", t("回退到这里")) + actBtn("mark", t("书签")) + actBtn("del", t("删除"));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      // 复制只要说的话：附件那几行 @/data/user/0/…/uploads/… 是给模型读文件用的，粘到别处只是一串长路径（群友 10-31）。
      // 只发了附件没打字的，才照原样复制路径；重发照旧带上附件
      if (a === "copy") copyText(body.trim() || text).then((ok) => toast(ok ? t("已复制") : t("复制失败"), !ok));
      if (a === "resend") { inputEl.value = text; autoGrow(); inputEl.focus(); }
      if (a === "rewind") rewindTo(b.parentElement);
      if (a === "mark") toggleMark(b.parentElement);
      if (a === "del") deleteMsg(b.parentElement, "user");
    });
    b.parentElement.appendChild(acts);
    return b;
  }

  // ── 渲染规矩（沿用 2026-10-13 的教训，并更进一步）──────────────────
  //   · 正文增量渲染：空行处（且不在代码块里）把前面的部分"冻结"成定稿 DOM，
  //     之后每帧只重渲染最后那一小段 —— 再长的回答也是 O(n)，不是 O(n²)
  //   · 思考块折叠时一个字符都不进 DOM，只更新字数；展开流式只贴尾巴
  //   · 工具卡的参数/结果点开才渲染
  const THINK_TAIL = 4000;
  const THINK_CAP  = 200000;
  const THINK_TICK = 250;
  const DOTS = `<div class="dots"><span></span><span></span><span></span></div>`;
  const fmtChars = (n) => (n < 1000 ? t("{n} 字", { n }) : t("{n}k 字", { n: (n / 1000).toFixed(1) }));

  /** from 之后、不在代码块里的最后一个空行位置；没有返回 -1 */
  function safeSplit(s, from) {
    // 代码块（```）和独占一行的公式块（$$ 或 \[ … \]）里面都不切
    const re = /^[ \t]*(```|\$\$[ \t]*$|\\\[[ \t]*$|\\\][ \t]*$)/gm;
    re.lastIndex = from;
    let open = null, regionStart = from, best = -1, m;
    const consider = (a, b) => {
      const i = s.lastIndexOf("\n\n", b - 1);
      if (i >= a && i > from) best = i;
    };
    while ((m = re.exec(s))) {
      const k = m[1].startsWith("```") ? "code" : "math";
      if (!open) { if (m[1].trim() === "\\]") continue; consider(regionStart, m.index); open = k; }
      else if (open === k) { open = null; regionStart = m.index + m[0].length; }
    }
    if (!open) consider(regionStart, s.length);
    return best;
  }

  // 匀速吐字：厂商常常一口吐一大段（几十上百字），原样贴上去就是一顿一顿地跳。
  // 收到的先进缓冲，每 STREAM_TICK 吐一截；积压越多吐得越快（约 STREAM_STEPS 步追平），不会越落越远。
  // 只管显示，text 永远是收全了的；回复结束 / 切到后台时一次补齐
  const STREAM_TICK = 33, STREAM_STEPS = 8;
  function TextBlock(parent, live) {
    const el = document.createElement("div");
    el.className = "txt";
    const frozen = document.createElement("div"), tail = document.createElement("div");
    el.append(frozen, tail);
    parent.appendChild(el);
    let text = "", fz = 0, timer = 0, shown = 0, ending = false, hlAt = 0;
    el._src = () => text;   // 书签：没有 uuid 时按正文开头去文件里认领

    function paint(final) {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (final) shown = text.length;
      const vis = text.slice(0, shown);
      if (fz > vis.length) { frozen.innerHTML = ""; fz = 0; }
      if (!final) {
        // 整块重画会新建 <pre> / 表格：正横着看长行的，横向位置别每来一个字就归零（审查 #48 06-04）。
        // 先记下来再冻结：冻进 frozen 的那几块也要接着原来的位置（审查 #52 06-04）
        const sl = keepX();
        const idx = safeSplit(vis, fz);
        if (idx > fz) {
          const c = document.createElement("div");
          setHtml(c, renderMd(vis.slice(fz, idx)));
          frozen.appendChild(c);
          fz = idx;
          sl.into = c;
        }
        tail.innerHTML = renderMd(vis.slice(fz));   // 光标不跟在每段正文后面：整条回复只留一个，见 AssistantView 的 liveTail
        // 流式时每帧重高亮长代码块很贵（实测 1000 行单帧 179ms）：最多每 300ms 做一次，收尾时一定补上（0.6.9 审计 195-Q.1）
        if (Date.now() - hlAt > 300) { hlAt = Date.now(); enhanceMd(tail); }
        sl();
      } else {
        const sl = keepX();
        setHtml(tail, renderMd(vis.slice(fz)));
        sl();
      }
      scrollDown();
    }
    // 记下 tail 里各个代码块 / 表格的横向位置，重画后按顺序还回去；sl.into = 这次新冻结的那块（排在 tail 前面）
    function keepX() {
      const SEL = "pre, .tbl-wrap", xs = [...tail.querySelectorAll(SEL)].map((x) => x.scrollLeft);
      if (!xs.some(Boolean)) return () => {};
      const sl = () => [...(sl.into ? sl.into.querySelectorAll(SEL) : []), ...tail.querySelectorAll(SEL)].forEach((x, i) => { if (xs[i]) x.scrollLeft = xs[i]; });
      return sl;
    }
    function tick() {
      timer = 0;
      const left = text.length - shown;
      if (document.hidden || left <= 0) { if (ending) return paint(true); shown = text.length; return paint(false); }
      let n = Math.max(2, Math.ceil(left / (ending ? 3 : STREAM_STEPS)));
      // 别把一个代理对（emoji、生僻字）劈成两半
      const c = text.charCodeAt(shown + n - 1); if (c >= 0xd800 && c <= 0xdbff) n++;
      shown = Math.min(text.length, shown + n);
      paint(false);
      if (shown < text.length || ending) timer = setTimeout(tick, STREAM_TICK);
    }
    const kick = () => { if (busReplay) REPLAY_FLUSH.add(flushNow); if (!timer) timer = setTimeout(tick, STREAM_TICK); };
    function flushNow() { if (timer && el.isConnected) { shown = text.length; paint(ending); } }
    return {
      kind: "text",
      append(t) { text += t; if (busReplay) shown = text.length; kick(); },
      // 整段正文（没有逐字增量的厂商）重放时同样直接整段显示，不再从头吐一遍（审查 #48 06-06 / F8）
      set(t) { text = t; if (live) { shown = busReplay ? text.length : Math.min(shown, text.length); kick(); } else paint(true); },
      finish() { if (!live) return; if (shown >= text.length) paint(true); else { ending = true; kick(); } },
      /** 从末尾删掉 n 个字（流断了、那半截不算数）；冻结的段落可能也在里面，整块重画 */
      drop(n) { text = text.slice(0, Math.max(0, text.length - n)); shown = Math.min(shown, text.length); frozen.innerHTML = ""; fz = 0; paint(!live); return text.length; },
      remove() { if (timer) { clearTimeout(timer); timer = 0; } el.remove(); },
      get text() { return text; },
      el,
    };
  }

  function ThinkBlock(parent) {
    const el = document.createElement("details");
    el.className = "think";
    el.innerHTML = `<summary>${t("思考过程")} <span class="think-size"></span></summary><div class="think-body"></div>`;
    parent.appendChild(el);
    const body = el.querySelector(".think-body"), label = el.querySelector(".think-size");
    let thinking = "", timer = 0, shown = 0, moreBtn = null, done = false;

    function moreSync(left) {
      if (!moreBtn) {
        moreBtn = document.createElement("button");
        moreBtn.className = "think-more";
        moreBtn.addEventListener("click", () => { shown += THINK_CAP; render("full"); });
        el.appendChild(moreBtn);
      }
      moreBtn.textContent = t("继续渲染（还有 {left}）", { left: fmtChars(left) });
      moreBtn.style.display = left > 0 ? "block" : "none";
    }
    function render(mode) {
      if (!el.open) return;
      if (mode === "tail") {
        body.textContent = thinking.length > THINK_TAIL ? "…" + thinking.slice(-THINK_TAIL) : thinking;
        shown = 0; moreSync(0);
        return;
      }
      shown = Math.min(Math.max(shown, THINK_CAP), thinking.length);
      const left = thinking.length - shown;
      body.textContent = thinking.slice(0, shown) + (left > 0 ? "\n\n" + t("…（还有 {left}没渲染）", { left: fmtChars(left) }) : "");
      moreSync(left);
    }
    el.addEventListener("toggle", () => {
      if (el.open) render(done ? "full" : "tail");
      else { body.textContent = ""; shown = 0; }
    });
    const tick = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        label.textContent = fmtChars(thinking.length);
        if (el.open && !done) { render("tail"); scrollDown(); }
      }, THINK_TICK);
    };
    return {
      kind: "think",
      el,
      append(t) { thinking += t; if (!done) el.classList.add("live"); tick(); },
      set(t) { thinking = t; done = true; el.classList.remove("live"); label.textContent = fmtChars(thinking.length); },
      drop(n) { thinking = thinking.slice(0, Math.max(0, thinking.length - n)); label.textContent = fmtChars(thinking.length); if (el.open) render("tail"); return thinking.length; },
      remove() { if (timer) { clearTimeout(timer); timer = 0; } el.remove(); },
      finish() {
        if (timer) { clearTimeout(timer); timer = 0; }
        done = true;
        el.classList.remove("live");
        label.textContent = fmtChars(thinking.length);
        if (el.open) render("full");
      },
    };
  }

  function summarizeTool(name, input) {
    if (!input) return "";
    // Bash 带了说明（模型写的「停止抓包并统计目的地址」）：标题用说明，命令本身展开卡片在参数里看（群反馈 11-06）
    if ((name === "Bash" || name === "PowerShell") && typeof input.description === "string" && input.description.trim()) {
      const d = input.description.trim();
      return d.length > 90 ? d.slice(0, 90) + "…" : d;
    }
    const v = input.command || input.file_path || input.path || input.pattern ||
              input.url || input.prompt || input.description || input.skill || "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  }

  /** 收着的子代理过程里的一步：只记数据，不建 DOM。子代理正在跑时每一步都会来，十几个子代理各几百步，
   *  全建成卡片就是几千个节点常驻页面（展开过程时才 realize 成真卡片，见 ToolBlock 的 openSub）。
   *  孙代理的步骤挂在它下面同样记着；结果、汇报、状态都按调用顺序存，展开时原样重放 */
  function LazyCard(id, name, input, live) {
    const calls = [];
    const c = { lazy: true, id, name, input, live, calls, isAgent: name === "Agent" || name === "Task",
                state: live ? "run" : "ok", summary: summarizeTool(name, input), onChange: null };
    for (const k of ["result", "subText", "subProgress", "subDone", "stop", "fail", "finish", "subLazy"]) {
      c[k] = (...a) => { calls.push([k, a]); if (k === "result") c.state = a[0] ? "ok" : "err"; if ((k === "stop" || k === "fail") && c.state === "run") c.state = "err"; };
    }
    c.sub = (sid, sn, si) => { const n = LazyCard(sid, sn, si, live); n.host = c.host; calls.push(["sub", [sid, sn, si, n]]); if (sid) TOOL_CARDS.set(sid, n); return n; };
    return c;
  }
  const SUB_SHOW = 50;
  function realize(c, list) {
    const b = ToolBlock(list, c.id, c.name, c.input, c.live);
    for (const [k, a] of c.calls) {
      if (k !== "sub") { b[k](...a); continue; }
      const nb = b.sub(a[0], a[1], a[2]);            // b 的过程区是收着的：拿到的是新的 LazyCard，把旧的记录接过去
      if (nb.lazy) nb.calls.push(...a[3].calls), nb.state = a[3].state;
    }
    return b;
  }

  function ToolBlock(parent, id, name, input, live) {
    const card = document.createElement("div");
    card.className = "tool";
    card.innerHTML =
      `<div class="tool-head"><span class="chev">▶</span><span class="tool-name">${esc(name)}</span>` +
      `<span class="tool-arg"${input && typeof input.command === "string" ? ` title="${esc(input.command.slice(0, 500))}"` : ""}>${esc(summarizeTool(name, input))}</span>` +
      (input && /^\//.test(input.file_path || input.notebook_path || "") ? `<a class="fpath tool-open" href="#" data-path="${esc(input.file_path || input.notebook_path)}" title="${t("在查看器中打开")}">↗</a>` : "") +
      `<span class="tool-state ${live ? "run" : "ok"}">${live ? t("运行中") : "—"}</span></div>` +
      `<div class="tool-body"></div>`;
    parent.appendChild(card);
    const st = card.querySelector(".tool-state"), bodyEl = card.querySelector(".tool-body");
    let result = null, built = false;
    // 子代理（Agent / 旧名 Task）：卡片下面挂一块「子代理过程」，它的每一步是嵌套的工具卡，默认收起
    const isAgent = name === "Agent" || name === "Task";
    let sub = null;
    const subArea = () => {
      if (sub) return sub;
      const box = document.createElement("div");
      box.className = "tool-sub";
      box.innerHTML = `<button class="ts-head" type="button"><span class="chev">▶</span><span class="ts-label"></span><span class="tool-arg ts-now"></span></button><div class="ts-list"></div>`;
      card.insertBefore(box, bodyEl);
      sub = { box, list: box.lastChild, label: box.querySelector(".ts-label"), now: box.querySelector(".ts-now"), n: 0, textEl: null, text: null, lazy: null, queue: [], kids: [] };
      box.firstChild.addEventListener("click", (e) => {
        e.stopPropagation();
        if (box.classList.contains("open")) box.classList.remove("open");
        else openSub();
      });
      subLabel();
      return sub;
    };
    // 展开过程：先把收着时记下的步骤建成卡片、汇报排到最后，历史里的再去取
    const openSub = () => {
      const s = subArea();
      s.box.classList.add("open");
      // 一次只建最近 SUB_SHOW 步（200 步全建要卡半秒多，压测实测），更早的点一下再建，插在最前面
      if (s.queue.length) {
        const q = s.queue; s.queue = [];
        const cut = q.length > SUB_SHOW + 10 ? q.length - SUB_SHOW : 0;
        if (cut) {
          const box = document.createElement("div"), more = document.createElement("button");
          more.type = "button"; more.className = "ts-older"; more.textContent = t("更早的 {n} 步", { n: cut });
          box.appendChild(more);
          const skipped = s.list.querySelector(":scope > .ts-skipped");   // 「前面没加载」的说明总在最顶上
          if (skipped) skipped.after(box); else s.list.prepend(box);
          const older = q.slice(0, cut);
          (s.older = s.older || []).push(older);              // 还没建的更早步骤：停止时也要收
          older.open = () => { more.remove(); s.older = s.older.filter((x) => x !== older); for (const c of older) s.kids.push(realize(c, box)); };
          more.addEventListener("click", (e) => { e.stopPropagation(); older.open(); });
        }
        // 建出来的卡记进 kids：停止时要连它们一起收成「中断」（审查 #52 UI07-01）
        for (const c of q.slice(cut)) s.kids.push(realize(c, s.list));
      }
      if (s.text != null) paintSubText();
      if (s.lazy) { const f = s.lazy; s.lazy = null; f(); }
    };
    const paintSubText = () => {
      const s = sub;
      if (!s.textEl) { s.textEl = document.createElement("div"); s.textEl.className = "ts-text md"; }
      s.list.appendChild(s.textEl);
      setHtml(s.textEl, renderMd(s.text));
    };
    const subLabel = () => { sub.label.textContent = t("子代理过程") + (sub.n ? " · " + t("{n} 个步骤", { n: sub.n }) : ""); };
    const build = () => {           // 点开才把参数、结果铺进 DOM
      if (built) return;
      built = true;
      let html = `<div class="lbl">${t("参数")}</div><pre>${esc(JSON.stringify(input, null, 2))}</pre>`;
      if (result) html += `<div class="lbl">${t("结果")}</div><pre>${esc(result.text)}</pre>`;
      bodyEl.innerHTML = html;
      if (result) embedLocalImages(bodyEl);
    };
    card.querySelector(".tool-head").addEventListener("click", (e) => {
      if (e.target.closest(".fpath")) return;          // 点的是"打开文件"，交给对话区的委托
      card.classList.toggle("open");
      if (card.classList.contains("open")) build();
    });
    const api = {
      kind: "tool",
      id,
      el: card,
      name, summary: summarizeTool(name, input), state: live ? "run" : "ok",
      onChange: null,
      result(ok, text) {
        result = { ok, text: String(text || "") };
        api.state = ok ? "ok" : "err";
        st.className = "tool-state " + (ok ? "ok" : "err");
        st.textContent = ok ? t("完成") : t("失败");
        if (live && !busReplay) { MO.play(st, "mo-tick", 1400); if (ok) MO.play(card, "mo-ok", 1400); }
        // 后台子代理：工具结果只是「已启动」，真正跑完靠 sub_done
        // 状态也记成在跑：不然步骤组的摘要按「完成」算（审查 #48 UI07-03）
        if (isAgent && ok && /^Async agent launched/.test(result.text) && !(sub && sub.done)) {
          // 联络簿比这张卡先到、已经记着它结束了（翻历史时常见）：直接按终态收，别挂成「后台运行」（#95 01-003）
          const fin = AG.byTool.get(id)?.status;
          if (fin && fin !== "running") api.subDone(fin === "done" ? "completed" : fin);
          else { api.state = "run"; st.className = "tool-state run"; st.textContent = t("后台运行"); }
        }
        if (built) { built = false; build(); }
        if (!ok && live) { card.classList.add("open"); build(); }
        // 工具产出的图片（渲染结果、截图）直接露出来，不用点开
        if (ok && /\.(png|jpe?g|gif|webp)\b/i.test(result.text)) {
          const peek = card.querySelector(".tool-peek") || document.createElement("div");
          peek.className = "tool-peek";
          peek.textContent = result.text.slice(0, 600);
          card.appendChild(peek);
          embedLocalImages(peek);
          const imgs = peek.querySelectorAll(".inline-img");
          if (imgs.length) peek.replaceChildren(...imgs);
          else peek.remove();
          // 读不到的图（root 才能读的 /data/adb、别的应用私有目录、find 列出来但其实不在的）在这里只会剩一行打不开的路径，
          // 还把整个步骤组撑着收不起来（群友 11-02）。工具预览里读不到就直接拿掉；路径在展开的结果里照样看得到。
          // 捕获阶段先拦下，不让 makeInlineImg 换成那行「读不到」的链接
          if (!peek.dataset.quiet) {
            peek.dataset.quiet = "1";
            peek.addEventListener("error", (e) => {
              if (e.target.tagName !== "IMG") return;
              e.stopPropagation();
              e.target.closest(".inline-img")?.remove();
              if (!peek.querySelector(".inline-img")) { peek.remove(); api.onChange && api.onChange(); }
            }, true);
          }
        }
        api.onChange && api.onChange();
      },
      // 停了这一轮：后台子代理（结果只是「已启动」）和它过程里还在跑的步骤也一起收成「中断」，别一直转圈计时（审查 #48 UI07-01）
      stop() {
        if (!result || api.state === "run") { api.state = "err"; st.className = "tool-state err"; st.textContent = t("中断"); if (sub) sub.now.textContent = ""; api.onChange && api.onChange(); }
        if (sub) { for (const c of sub.queue) c.stop(); for (const c of (sub.older || []).flat()) c.stop(); for (const k of sub.kids) k.stop(); }
      },
      // 这一轮失败（不是用户中断）：还在转圈的卡收成「失败」，别一直亮着「运行中」（0.6.9 审计 195-BB.1）
      fail() {
        if (!result && api.state === "run") { api.state = "err"; st.className = "tool-state err"; st.textContent = t("失败"); if (sub) sub.now.textContent = ""; api.onChange && api.onChange(); }
        if (sub) {
          for (const c of sub.queue) c.fail ? c.fail() : c.stop();
          for (const c of (sub.older || []).flat()) c.fail ? c.fail() : c.stop();
          for (const k of sub.kids) k.fail ? k.fail() : k.stop();
        }
      },
      finish() { if (!result && !live) { st.textContent = "—"; } },
      isAgent,
      // 子代理的一步：嵌套工具卡（注册进 TOOL_CARDS，结果和权限卡照常按 id 找到它）
      sub(sid, sname, sinput) {
        const s = subArea();
        s.n++; subLabel();
        const sum = summarizeTool(sname, sinput);
        s.now.textContent = sname + (sum ? " " + sum : "");
        if (!s.box.classList.contains("open")) {          // 收着：只记数据
          const c = LazyCard(sid, sname, sinput, live);
          c.host = card;                                  // 没有 DOM：记下挂在哪张真卡下面，裁剪历史页时据此一并放掉
          s.queue.push(c);
          if (sid) TOOL_CARDS.set(sid, c);
          return c;
        }
        const b = ToolBlock(s.list, sid, sname, sinput, live);
        s.kids.push(b);
        if (s.textEl) s.list.appendChild(s.textEl);       // 汇报总在最后
        return b;
      },
      openSub,
      // 联络卡要定位的孙代理在「更早的 n 步」里：把它所在的那一批建出来（#95 01-005）。找到了返回 true
      realizeFor(tid) {
        const b = sub?.older?.find((x) => x.some((c) => c.id === tid));
        if (b) b.open();
        return !!b;
      },
      // 新版 claude 跑得久的普通命令（Bash 等）也会发 task_progress / task_notification，
      // id 是那张工具卡自己的：只有子代理卡才有「过程」可放，别的卡只更新状态，不挂空的「子代理过程」
      subText(text) {
        if (!isAgent) return;
        const s = subArea();
        s.text = String(text || "");
        if (s.box.classList.contains("open")) paintSubText();   // 收着就只记下，展开时再排版
      },
      subProgress(desc) { if (desc && isAgent) subArea().now.textContent = desc; },
      subDone(status) {
        const ok = status === "completed";
        if (!isAgent) {
          if (result && result.ok === ok) return;          // 工具结果已经说清楚了
          if (!result && ok) return;                        // 结果马上就到，交给 result()
        } else {
          const s = subArea();
          s.done = true; s.now.textContent = "";
        }
        st.className = "tool-state " + (ok ? "ok" : "err");
        st.textContent = ok ? t("完成") : status === "failed" ? t("失败") : t("已停止");
        api.state = ok ? "ok" : "err";
        api.onChange && api.onChange();      // 步骤组的摘要跟着变（审查 #48 UI07-03）
      },
      // 历史里的子代理：点开「过程」时才去取
      // mk(工具调用 id) → 取那个代理过程的函数：过程里又派了孙代理的，孙代理的卡也要能点开取它自己的（审查 #48 UI07-02）
      subLazy(load, mk) {
        const s = subArea();
        const run = async () => {
          s.now.textContent = t("加载中…");
          const gen = view.gen;
          try {
            const items = await load();
            // 取的时候切走过、或这张卡已被裁掉 / 重建：回执作废，别把旧树里的卡写回全局索引（#90）
            if (gen !== view.gen || !card.isConnected || (id && TOOL_CARDS.get(id) !== api)) return;
            // 先按「收着」只记数据，再走 openSub 那套「一次只建最近 SUB_SHOW 步」；以前展开着来就逐项全建（#71）
            const wasOpen = s.box.classList.contains("open");
            s.box.classList.remove("open");
            if (items.more) {
              const note = document.createElement("div");
              note.className = "ts-older ts-skipped"; note.textContent = t("过程太长，只显示最近的部分");
              s.list.prepend(note);
            }
            for (const m of items) {
              if (m.role === "tool_use") { const k = api.sub(m.id, m.name, m.input); if (mk && (m.name === "Agent" || m.name === "Task") && k && k.subLazy) k.subLazy(mk(m.id), mk); }
              else if (m.role === "tool_result") toolResult(m.id, m.ok, m.text);
              else if (m.role === "assistant") api.subText(m.text);
            }
            s.now.textContent = items.length ? "" : t("没有记录");
            if (wasOpen) openSub();
          } catch (e) {
            // 取失败（断网、网关重启）：把加载器放回去，收起再点开就重取；以前置空了，同一张卡再也取不到（#95 01-001）
            s.now.textContent = e.message + " · " + t("收起再点开可重试"); s.lazy = run;
          }
        };
        s.lazy = run;
      },
    };
    if (id) {
      TOOL_CARDS.set(id, api);
      // 结果已经先到过（结果排在调用前面、或者这页刚被裁掉又补回来）：当场贴上，别留一个默认成功的空卡（#120-4）
      const res = TOOL_RESULTS.get(id);
      if (res) api.result(res.ok, res.text);
    }
    return api;
  }
  /** 两段正文之间的工具调用（连同夹在中间的思考）收进一组：≥2 个工具时顶上出一行摘要
   *  （几步 · 最近一步 · 状态），默认收起。有待确认的权限卡、失败后自动展开的卡、带图片预览的卡时，
   *  样式（:has）让这一组保持展开。 */
  function ToolGroup(parent) {
    const el = document.createElement("div");
    el.className = "tgroup single";
    el.innerHTML = `<button class="tg-head" type="button"></button><div class="tg-body"></div>`;
    parent.appendChild(el);
    const head = el.firstChild, body = el.lastChild, members = [], inner = [];
    let key = "";   // 第一个工具定了才有：用来记用户收没收（#87）
    // 收起整组时，组里展开着的步骤、子代理过程、思考也一起收回去 —— 不然下次点开还是一大片摊着（群友 10-27）
    head.addEventListener("click", () => {
      // 失败、待确认时样式（:has）已经把组摊开了，组本身却没有 open：按眼前看到的来，第一下就收（审查 #48 UI07-05）
      const showing = el.classList.contains("open") || body.getClientRects().length > 0;
      el.classList.toggle("open", !showing);
      // 带图片预览的卡（.tool-peek）会被样式一直撑开，光去掉 open 收不起来：记一个「用户收了」压过它（群友 11-02）
      el.classList.toggle("shut", showing);
      foldSet(key, !showing);
      if (showing) {
        body.querySelectorAll(".tool.open, .tool-sub.open").forEach((x) => x.classList.remove("open"));
        body.querySelectorAll("details[open]").forEach((d) => { d.open = false; });
      }
    });
    function refresh() {
      const n = members.length;
      el.classList.toggle("single", n < 2);
      if (n < 2) return;
      const lastM = members[n - 1];
      const run = members.some((m) => m.state === "run"), err = members.some((m) => m.state === "err");
      const [cls, txt] = run ? ["run", t("运行中")] : err ? ["err", t("有失败")] : ["ok", t("完成")];
      head.innerHTML = `<span class="chev">▶</span><span class="tg-count">${esc(t("{n} 个步骤", { n }))}</span>` +
        `<span class="tool-arg">${esc(lastM.name + (lastM.summary ? " " + lastM.summary : ""))}</span>` +
        `<span class="tool-state ${cls}">${esc(txt)}</span>`;
    }
    return {
      kind: "tgroup",
      body,
      get lastInner() { return inner[inner.length - 1]; },
      add(m) {
        if (!members.length && m.id) {
          key = "g:" + m.id;
          const f = foldGet(key);      // 切回来重建：照用户上次的选择
          if (f !== undefined) { el.classList.toggle("open", f); el.classList.toggle("shut", !f); }
        }
        members.push(m); inner.push(m); m.onChange = refresh; refresh();
      },
      addThink(b) { inner.push(b); if (b.el.parentNode !== body) body.appendChild(b.el); },
      finish() { for (const b of inner) b.finish && b.finish(); refresh(); },
      stop() { for (const m of members) m.stop(); },
      fail() { for (const m of members) m.fail ? m.fail() : m.stop(); refresh(); },
    };
  }
  function toolResult(id, ok, text) {
    if (id) rememberResult(id, ok, text);   // 卡片现在没有、或以后被裁掉重建，结果都还在（#120-4）
    const c = TOOL_CARDS.get(id);
    if (c) c.result(ok, text);
  }


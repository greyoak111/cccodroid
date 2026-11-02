  // ── 子代理卡 + 联络线（0.4.19）────────────────────────────────────────
  // 网关把派出 / 联络 / 结束记成联络簿（gw/agents.mjs），这里只吃那些短记录：正在跑的走 ag 事件，历史走 /agents。
  // 一组子代理一张卡，放在派它们的那组步骤后面（不收在步骤组里，群友找不到的就是这个入口）：
  // 一个代理一行（孙代理缩进），底下一条联络线「谁 → 谁 · 为什么事」，只露最近 3 条。
  // 卡片只跟「代理数 + 3 条联络」有关，子代理走了多少步都不进这里；点哪一行才去展开那个代理的过程。
  const AG = {
    agents: new Map(),     // agentId → { id, tool, name, parent, by, depth, status, at, endAt, lastAt, steps, now, why, brief, report }
    byTool: new Map(),     // Agent 工具调用 id → agent
    msgs: new Map(),       // mid → { mid, from, to, why, file, ok, err, at }
    cards: new Map(),      // 顶层 Agent 工具调用 id → 卡片
    summary: null,
    loaded: null,          // 历史记录取过没有（会话号）
    dirty: new Set(),
    raf: 0,
  };
  const AG_RECENT = 3;
  const agName = (id) => id === "main" ? t("主会话") : AG.agents.get(id)?.name || String(id || "?").slice(0, 8);
  const agRoot = (a) => { let r = a, n = 0; while (r && r.parent && AG.agents.has(r.parent) && n++ < 20) r = AG.agents.get(r.parent); return r; };
  const agCardOf = (a) => { const r = agRoot(a); return r && AG.cards.get(r.tool); };

  function agReset() {
    AG.agents.clear(); AG.byTool.clear(); AG.msgs.clear(); AG.cards.clear();
    AG.summary = null; AG.loaded = null; AG.dirty.clear();
  }
  const agTouch = (card) => {
    if (!card) return;
    AG.dirty.add(card);
    if (!AG.raf) AG.raf = requestAnimationFrame(() => { AG.raf = 0; for (const c of AG.dirty) c.paint(); AG.dirty.clear(); });
  };

  /** 记录 → 状态。正在跑的事件和历史记录可能都来一遍（重连、翻历史），所以按 id / mid 去重、按时间只往前走 */
  function agApply(r, av) {
    if (!r || !r.k) return;
    const at = r.at || Date.now();
    if (r.k === "spawn") {
      const fresh = !AG.byTool.has(r.tool) && av && !busReplay;   // 正在跑时新派的（不是翻历史 / 重连补的）
      let a = AG.agents.get(r.id);
      if (!a) {
        a = { id: r.id, tool: r.tool, name: r.name || "agent", parent: r.parent || null, by: r.by || "main", depth: r.depth || 1,
              status: "running", at, endAt: 0, lastAt: at, steps: 0, now: "", why: "", brief: r.file || null, report: null };
        AG.agents.set(a.id, a);
        if (a.tool) AG.byTool.set(a.tool, a);
      }
      if (!a.parent) { const had = AG.cards.size; const c = agCardFor(a.tool); if (fresh && c && AG.cards.size > had && c.tools.size === 1) MO.play(c.el, "mo-in-rise", 1400); }   // 卡片头一回出现：浮上来
      return agTouch(agCardOf(a));
    }
    if (r.k === "msg") {
      if (!AG.msgs.has(r.mid)) AG.msgs.set(r.mid, { mid: r.mid, from: r.from, to: r.to, why: r.why || "", file: r.file || null, ok: null, err: null, at });
      return agTouchMsg(AG.msgs.get(r.mid));
    }
    if (r.k === "msg_ok") {
      const m = AG.msgs.get(r.mid);
      if (!m || m.ok != null) return;
      m.ok = !!r.ok; m.err = r.err || null;
      if (m.ok && m.to === "main" && av) av.mark("← " + agName(m.from) + (m.why ? "：" + m.why : ""));
      return agTouchMsg(m);
    }
    const a = AG.agents.get(r.id);
    if (r.k === "done" && a) {
      if (at < a.lastAt) return;
      a.lastAt = at; a.status = r.status || "done"; a.endAt = at; a.why = r.why || ""; a.report = r.file || a.report; a.now = "";
      if (r.steps > a.steps) a.steps = r.steps;
      if (a.by === "main" && av) av.mark("← " + a.name + " " + (a.status === "done" ? t("完成") : a.status === "stopped" ? t("已停止") : t("失败")));
      // 后台子代理的 Agent 卡（结果只是「已启动」）跟着收：翻历史时没有 sub_done 事件，不然一直标「后台运行」。
      // 成功结束的也要收：以前把 done 排除了，成功的后台代理翻历史时一直挂着「后台运行」（#95 01-003）；
      // 前台代理的卡本来就是「完成」，不用碰（碰了会凭空长出一块空的「子代理过程」）
      const tc = a.parent ? null : TOOL_CARDS.get(a.tool);
      if (tc?.subDone && (a.status !== "done" || tc.state === "run")) tc.subDone(a.status === "done" ? "completed" : a.status);
      return agTouch(agCardOf(a));
    }
    if (r.k === "resume" && a) {
      if (at < a.lastAt) return;
      a.lastAt = at; a.status = "running"; a.endAt = 0;
      return agTouch(agCardOf(a));
    }
    if (r.k === "summary") {
      AG.summary = r.file || null;
      for (const id of r.ids || []) { const x = AG.agents.get(id); if (x) agTouch(agCardOf(x)); }
    }
  }
  /** 这一轮被停了：还标着在跑的代理都收成「已停止」，卡片别一直转圈计时（审查 #48 UI07-01） */
  function agStopAll(at) {
    for (const a of AG.agents.values()) if (a.status === "running") { a.status = "stopped"; a.endAt = at || Date.now(); a.now = ""; agTouch(agCardOf(a)); }
  }
  const agTouchMsg = (m) => { for (const id of [m.from, m.to]) { const a = AG.agents.get(id); if (a) agTouch(agCardOf(a)); } };

  /** 子代理的一步（正在跑时的 tool_use，parent = 它那张 Agent 卡）：只记步数和最近一步，不建 DOM */
  function agStep(parentTool, name, input) {
    const a = AG.byTool.get(parentTool);
    if (!a) return;
    a.steps++;
    const s = summarizeTool(name, input);
    a.now = name + (s ? " " + s : "");
    agTouch(agCardOf(a));
  }

  /** 顶层 Agent 卡对应的子代理卡：同一组步骤里派出的共用一张（排在那组后面） */
  function agCardFor(tool) {
    if (AG.cards.has(tool)) return AG.cards.get(tool);
    const tc = TOOL_CARDS.get(tool);
    if (!tc || !tc.el || !tc.el.isConnected) return null;
    const anchor = tc.el.closest(".tgroup") || tc.el;
    const next = anchor.nextElementSibling;
    const card = next && next.classList.contains("agc") && next._agc ? next._agc : AgentsCard(anchor, tool);
    card.tools.add(tool);
    AG.cards.set(tool, card);
    return card;
  }

  function AgentsCard(anchor, tool) {
    const el = document.createElement("div");
    el.className = "agc";
    el.innerHTML = `<button class="agc-head" type="button"><span class="chev">▶</span><span class="agc-t"></span><span class="agc-st"></span></button>` +
      `<div class="agc-body"><div class="agc-rows"></div><div class="agc-feed"></div></div>`;
    anchor.after(el);
    const head = el.firstChild, rows = el.querySelector(".agc-rows"), feed = el.querySelector(".agc-feed");
    let allMsgs = false;
    const card = { el, tools: new Set(), paint };
    el._agc = card;
    const key = "a:" + tool;
    el.classList.toggle("open", foldGet(key) !== false);   // 默认展开；用户收过的切回来还收着（#87）
    head.addEventListener("click", () => {
      const open = el.classList.toggle("open");
      foldSet(key, open);
      if (open) MO.play(el.querySelector(".agc-body"), "mo-in-fade", 400);
    });
    // 这张卡管的代理：顶层的按派出顺序，孙代理跟在上级后面
    const members = () => {
      const all = [...AG.agents.values()], out = [];
      const walk = (a) => { out.push(a); for (const c of all) if (c.parent === a.id) walk(c); };
      for (const a of all) if (!a.parent && card.tools.has(a.tool)) walk(a);
      return out;
    };
    function paint() {
      const ms = members();
      if (!ms.length) { el.classList.add("hidden"); return; }
      el.classList.remove("hidden");
      // 完成只数 done：已停止的单独算，不能和成功的一起标绿（#95 01-006）
      const run = ms.filter((a) => a.status === "running").length, ok = ms.filter((a) => a.status === "done").length,
        stop = ms.filter((a) => a.status === "stopped").length, bad = ms.length - run - ok - stop;
      head.querySelector(".agc-t").textContent = t("子代理") + " · " + ms.length;
      head.querySelector(".agc-st").innerHTML = [
        run ? `<span class="tool-state run">${esc(t("{n} 在跑", { n: run }))}</span>` : "",
        ok ? `<span class="tool-state ok">${esc(t("{n} 完成", { n: ok }))}</span>` : "",
        stop ? `<span class="tool-state err">${esc(t("{n} 已停止", { n: stop }))}</span>` : "",
        bad ? `<span class="tool-state err">${esc(t("{n} 失败", { n: bad }))}</span>` : "",
      ].join("");
      const now = Date.now();
      // 有在跑的：每秒只刷一下各行的「步数 · 用时」，不重建整张卡。以前只在来了新一步时才重画，两步之间计时是停的
      clearTimeout(card.tick);
      if (run) card.tick = setTimeout(function tick() {
        if (!el.isConnected) return;
        const t1 = Date.now(); let any = false;
        for (const a of members()) if (a.status === "running") {
          any = true;
          const c = rows.querySelector(`.agr[data-id="${CSS.escape(a.id)}"] .agr-c`);
          if (c) c.textContent = [a.steps ? t("{n} 步", { n: a.steps }) : "", fmtDur(t1 - a.at)].filter(Boolean).join(" · ");
        }
        if (any) card.tick = setTimeout(tick, 1000);
      }, 1000);
      rows.innerHTML = ms.map((a) => {
        const dur = a.endAt ? fmtDur(a.endAt - a.at) : a.status === "running" ? fmtDur(now - a.at) : "";
        const meta = [a.steps ? t("{n} 步", { n: a.steps }) : "", dur].filter(Boolean).join(" · ");
        const line2 = a.status === "running" ? a.now : a.why;
        const links = [a.brief ? `<a class="fpath agr-f" href="#" data-path="${esc(a.brief)}">${esc(t("交代"))}</a>` : "",
                       a.report ? `<a class="fpath agr-f" href="#" data-path="${esc(a.report)}">${esc(t("汇报"))}</a>` : ""].join("");
        return `<div class="agr ${esc(a.status)}" data-id="${esc(a.id)}" style="--d:${Math.min(4, (a.depth || 1) - 1)}">` +
          `<div class="agr-1"><span class="agr-dot"></span><span class="agr-n">${esc(a.name)}</span><span class="agr-c">${esc(meta)}</span></div>` +
          (line2 || links ? `<div class="agr-2"><span class="agr-m">${esc(line2 || "")}</span>${links}</div>` : "") + `</div>`;
      }).join("");
      // 联络线：只算这张卡里的代理发出或收到的
      const ids = new Set(ms.map((a) => a.id));
      const list = [...AG.msgs.values()].filter((m) => ids.has(m.from) || ids.has(m.to));
      const shown = allMsgs ? list : list.slice(-AG_RECENT);
      const sumOk = AG.summary && ms.every((a) => a.status !== "running");
      feed.innerHTML = (list.length > AG_RECENT ? `<button class="agc-more" type="button">${esc(allMsgs ? t("收起") : t("联络 {n} 条", { n: list.length }))}</button>` : "") +
        shown.map((m) => `<div class="agf${m.ok === false ? " no" : ""}" data-from="${esc(m.from)}">` +
          `<span class="agf-w">${esc(agName(m.from))} → ${esc(agName(m.to))}</span><span class="agf-y">${esc(m.why)}</span>` +
          (m.ok === false ? `<span class="agf-x" title="${esc(m.err || "")}">${esc(t("未送达"))}</span>` : "") +
          (m.file ? `<a class="fpath agf-f" href="#" data-path="${esc(m.file)}" title="${esc(t("在查看器中打开"))}">${uiI("clip")}</a>` : "") + `</div>`).join("") +
        (sumOk ? `<div class="agc-sum"><a class="fpath" href="#" data-path="${esc(AG.summary)}">${esc(t("汇总"))}</a></div>` : "");
    }
    el.addEventListener("click", (e) => {
      if (e.target.closest(".fpath")) return;            // 交代 / 汇报 / 长消息：交给对话区的路径委托
      if (e.target.closest(".agc-more")) { allMsgs = !allMsgs; paint(); MO.play(feed, "mo-in-fade", 400); return; }
      const r = e.target.closest(".agr, .agf");
      const id = r && (r.dataset.id || r.dataset.from);
      if (id && id !== "main") agReveal(id);
    });
    return card;
  }

  /** 点某个代理：从顶层往下逐级展开过程（孙代理的卡要等上级的过程展开后才建出来），滚到它那张卡 */
  async function agReveal(id) {
    const chain = [];
    for (let a = AG.agents.get(id), n = 0; a && n < 20; a = a.parent ? AG.agents.get(a.parent) : null, n++) chain.unshift(a);
    let card = null, up = null;
    const gen = view.gen;
    for (const a of chain) {
      for (let i = 0; i < 30; i++) {               // 历史里上级的过程是异步取的：等它的卡建出来
        card = TOOL_CARDS.get(a.tool);
        if (card && !card.lazy && card.el?.isConnected) break;
        if (card?.lazy && up?.realizeFor?.(a.tool)) continue;   // 落在上级「更早的 n 步」里：干等不会变，直接把那批建出来（#95 01-005）
        await new Promise((r) => setTimeout(r, 100));
        if (gen !== view.gen) return;              // 等的时候切了会话
      }
      // 等满了还没连上文档的（旧视图留下的卡）也算没加载到，别往脱离的节点上滚（#90）
      if (!card || card.lazy || !card.el?.isConnected) return toast(t("这个子代理的过程还没加载到"));
      card.el.closest(".tgroup")?.classList.add("open");
      card.openSub?.();
      up = card;
    }
    card.el.scrollIntoView({ block: "center", behavior: "smooth" });
    MO.play(card.el, "mo-flash", 1200);
  }

  /** 翻历史时：这个会话的联络簿取一次（网关有落盘读落盘，没有就从记录现推） */
  async function agLoad(sid) {
    if (!sid || AG.loaded === sid) return;
    AG.loaded = sid;                               // 先占上：取的过程中再来的不重复发
    try {
      const r = await api(`/api/session/${encodeURIComponent(sid)}/agents`);
      if (view.sessionId !== sid) return;
      for (const rec of r.records || []) agApply(rec, null);
    } catch { if (AG.loaded === sid) AG.loaded = null; }   // 取失败别当取过：下次翻页再取（#95 01-002）
  }

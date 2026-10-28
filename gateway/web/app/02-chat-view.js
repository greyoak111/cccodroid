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
    lastRunId: null,
    title: "",
    goal: null,          // 本会话的 /goal 状态（网关从会话记录里推出来的，见 goalStateOf）
    goalHide: 0,         // 点 ✕ 收起的那条达成 / 失败记录的时间戳
    tasks: null,         // 本会话的任务清单（TaskCreate / TaskUpdate，网关读 ~/.claude/tasks 推过来）
    tasksHide: "",       // 全部完成后点 ✕ 收起时的清单指纹；清单一变就重新露出来
  };
  // run / queue 只算当前视图的（本会话正在跑的那一轮、本会话排着的）；runs / queueAll 是网关上的全部
  const srv = { run: null, queue: [], runs: [], queueAll: [], max: 3, connected: false };
  const runViews = new Map();     // runId → { av, startedAt }
  const TOOL_CARDS = new Map();   // tool_use id → 卡片（结果可能在另一页、另一个气泡里）
  const PENDING_RESULTS = new Map();

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
  function splitRefs(text) {
    const m = /@\/\S+(?:\s+@\/\S+)*\s*$/.exec(text || "");
    if (!m) return [text, []];
    return [text.slice(0, m.index).trimEnd(), m[0].trim().split(/\s+/).map((r) => r.slice(1))];
  }
  function refsHtml(refs) {
    const FILE = '<svg class="ui-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    return `<div class="u-refs">${refs.map((p) => IMG_RE.test(p)
      ? `<button class="u-ref img" data-p="${esc(p)}"><img src="${fileUrl(p)}" alt="" loading="lazy"></button>`
      : `<button class="u-ref" data-p="${esc(p)}">${FILE}<span>${esc(p.split("/").pop())}</span></button>`).join("")}</div>`;
  }
  function renderUser(text, parent, uuid) {
    const b = mkMsg("user", null, parent);
    if (uuid) b.parentElement.dataset.uuid = uuid;   // 书签落点
    userTextOf.set(b.parentElement, text);
    const [body, refs] = splitRefs(text);
    setHtml(b, body ? renderMd(body) : "");
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
      if (a === "copy") { copyText(text); toast(t("已复制")); }
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
    let text = "", fz = 0, timer = 0, shown = 0, ending = false;
    el._src = () => text;   // 书签：没有 uuid 时按正文开头去文件里认领

    function paint(final) {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (final) shown = text.length;
      const vis = text.slice(0, shown);
      if (fz > vis.length) { frozen.innerHTML = ""; fz = 0; }
      if (!final) {
        const idx = safeSplit(vis, fz);
        if (idx > fz) {
          const c = document.createElement("div");
          setHtml(c, renderMd(vis.slice(fz, idx)));
          frozen.appendChild(c);
          fz = idx;
        }
        tail.innerHTML = renderMd(vis.slice(fz)); enhanceMd(tail);   // 光标不跟在每段正文后面：整条回复只留一个，见 AssistantView 的 liveTail
      } else {
        setHtml(tail, renderMd(vis.slice(fz)));
      }
      scrollDown();
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
    const kick = () => { if (!timer) timer = setTimeout(tick, STREAM_TICK); };
    return {
      kind: "text",
      append(t) { text += t; if (busReplay) shown = text.length; kick(); },
      set(t) { text = t; if (live) { shown = Math.min(shown, text.length); kick(); } else paint(true); },
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
    const v = input.command || input.file_path || input.path || input.pattern ||
              input.url || input.prompt || input.description || input.skill || "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  }

  function ToolBlock(parent, id, name, input, live) {
    const card = document.createElement("div");
    card.className = "tool";
    card.innerHTML =
      `<div class="tool-head"><span class="chev">▶</span><span class="tool-name">${esc(name)}</span>` +
      `<span class="tool-arg">${esc(summarizeTool(name, input))}</span>` +
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
      sub = { box, list: box.lastChild, label: box.querySelector(".ts-label"), now: box.querySelector(".ts-now"), n: 0, textEl: null, lazy: null };
      box.firstChild.addEventListener("click", (e) => {
        e.stopPropagation();
        box.classList.toggle("open");
        if (box.classList.contains("open") && sub.lazy) { const f = sub.lazy; sub.lazy = null; f(); }
      });
      subLabel();
      return sub;
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
        if (isAgent && ok && /^Async agent launched/.test(result.text) && !(sub && sub.done)) { st.className = "tool-state run"; st.textContent = t("后台运行"); }
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
        }
        api.onChange && api.onChange();
      },
      stop() { if (!result) { api.state = "err"; st.className = "tool-state err"; st.textContent = t("中断"); api.onChange && api.onChange(); } },
      finish() { if (!result && !live) { st.textContent = "—"; } },
      isAgent,
      // 子代理的一步：嵌套工具卡（注册进 TOOL_CARDS，结果和权限卡照常按 id 找到它）
      sub(sid, sname, sinput) {
        const s = subArea();
        s.n++; subLabel();
        const b = ToolBlock(s.list, sid, sname, sinput, live);
        s.now.textContent = sname + (b.summary ? " " + b.summary : "");
        if (s.textEl) s.list.appendChild(s.textEl);       // 汇报总在最后
        return b;
      },
      // 新版 claude 跑得久的普通命令（Bash 等）也会发 task_progress / task_notification，
      // id 是那张工具卡自己的：只有子代理卡才有「过程」可放，别的卡只更新状态，不挂空的「子代理过程」
      subText(text) {
        if (!isAgent) return;
        const s = subArea();
        if (!s.textEl) { s.textEl = document.createElement("div"); s.textEl.className = "ts-text md"; }
        s.list.appendChild(s.textEl);
        setHtml(s.textEl, renderMd(String(text || "")));
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
      },
      // 历史里的子代理：点开「过程」时才去取
      subLazy(load) {
        const s = subArea();
        s.lazy = async () => {
          s.now.textContent = t("加载中…");
          try {
            const items = await load();
            for (const m of items) {
              if (m.role === "tool_use") api.sub(m.id, m.name, m.input);
              else if (m.role === "tool_result") toolResult(m.id, m.ok, m.text);
              else if (m.role === "assistant") api.subText(m.text);
            }
            s.now.textContent = items.length ? "" : t("没有记录");
          } catch (e) { s.now.textContent = e.message; s.lazy = null; }
        };
      },
    };
    if (id) {
      TOOL_CARDS.set(id, api);
      const pend = PENDING_RESULTS.get(id);
      if (pend) { PENDING_RESULTS.delete(id); api.result(pend.ok, pend.text); }
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
    // 收起整组时，组里展开着的步骤、子代理过程、思考也一起收回去 —— 不然下次点开还是一大片摊着（群友 10-27）
    head.addEventListener("click", () => {
      if (!el.classList.toggle("open")) {
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
      add(m) { members.push(m); inner.push(m); m.onChange = refresh; refresh(); },
      addThink(b) { inner.push(b); if (b.el.parentNode !== body) body.appendChild(b.el); },
      finish() { for (const b of inner) b.finish && b.finish(); refresh(); },
      stop() { for (const m of members) m.stop(); },
    };
  }
  function toolResult(id, ok, text) {
    const c = TOOL_CARDS.get(id);
    if (c) c.result(ok, text);
    else if (id) PENDING_RESULTS.set(id, { ok, text });   // 卡片在更早的一页里，翻到了再贴上
  }


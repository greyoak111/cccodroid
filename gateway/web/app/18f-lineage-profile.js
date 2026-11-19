  // ── 脉络 · 剖面（规划书 §4 阶段 3）：卡片「剖面」→ 盖在地图上的一层 ──
  // 两级：一章的每一轮（时间瀑布，空闲久的地方折起来，长出去的分叉挂在那一轮下面）→ 点一轮看它里面的工具调用和子代理。
  // 数据：/api/lineage/profile、/api/lineage/turn（gw/profile.mjs）。点分叉出去的子会话 = 钻进它的剖面，返回键一层层退回来。
  const PF = { id: null, n: 0, data: null, det: null, turn: -1, stack: [], open: {}, seq: 0 };
  const PF_GAP = 5 * 60000;   // 两轮之间空了这么久就折起来（瀑布上不按真实时长画）

  const pfNarrow = () => innerWidth < 680;
  const pfNode = (id) => LIN.g && LIN.g.nodes.find((x) => x.id === id);
  const pfDay = (ms) => { const d = new Date(ms), p = (x) => String(x).padStart(2, "0"); return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
  const pfHm = (ms) => { const d = new Date(ms), p = (x) => String(x).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()); };
  const pfIco = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;

  function pfVisible(visit = pageVisit) {
    const el = $("lin-prof");
    return pageVisible("lineage", visit) && !el.classList.contains("hidden") && !el._moLeave;
  }
  function pfResume() {
    if (!pfVisible()) return;
    if (PF.turn >= 0 && !PF.det) pfTurn(PF.turn, true);
    else if (!PF.data) pfLoad(0);
  }

  /** 打开某个会话的剖面；n 不给就看最新一章 */
  function linProfOpen(id, n, push) {
    const node = pfNode(id); if (!node || !pageVisible("lineage")) return;
    if (MG.pick) linPickEnd();
    const el = $("lin-prof"), was = !el.classList.contains("hidden") && !el._moLeave;
    if (push && was) { PF.stack.push({ id: PF.id, n: PF.n }); MO.ghost($("lp-wrap"), "back", false); $("lp-wrap").classList.remove(...PF_IN); }
    else if (!was) PF.stack = [];
    PF.id = id; PF.n = n || node.chapters.length; PF.turn = -1; PF.det = null; PF.open = {};
    MO.cancel(el);
    el.classList.remove("hidden");
    if (!was) MO.play(el, pfNarrow() ? "mo-in-push" : "mo-in-rise", 1400);
    else if (push) MO.play($("lp-wrap"), "mo-in-push", 1400);
    pfHead(); pfChips(); pfLoad(0);
  }
  /** 收起整层（instant：离开脉络页时直接藏，不播） */
  function linProfClose(instant) {
    const el = $("lin-prof");
    PF.seq++; PF.stack = []; PF.turn = -1;
    if (instant) { MO.cancel(el); el.classList.add("hidden"); return; }
    MO.hide(el, pfNarrow() ? "mo-out-push" : "mo-out-fade", 170);
  }
  /** 返回：一轮的细节 → 这一章；钻进来的子会话 → 上一个会话；最外层 → 收起 */
  function linProfBack() {
    if (PF.turn >= 0) { PF.turn = -1; PF.det = null; PF.seq++; pfSwap("back"); pfHead(); pfPaint(); $("lp-body").scrollTop = PF.scroll || 0; return; }
    const prev = PF.stack.pop();
    if (prev) {
      MO.ghost($("lp-wrap"), "push"); $("lp-wrap").classList.remove(...PF_IN);
      PF.id = prev.id; PF.n = prev.n; PF.open = {};
      MO.play($("lp-wrap"), "mo-in-back", 1400);
      pfHead(); pfChips(); pfLoad(0);
      return;
    }
    linProfClose();
  }
  /** 换内容的过场：push 往里钻、back 退回来；pane 宽屏页内换章 */
  const PF_IN = ["mo-in-push", "mo-in-back", "mo-in-pane", "mo-in-pane-back"];
  function pfSwap(kind, dir) {
    const b = $("lp-body");
    b.classList.remove(...PF_IN);   // 上一次的进场类还没摘（1.4 秒内连着换）：样式表里排后面的那条会压过这次的
    if (kind === "push") { MO.ghost(b, "back", false); MO.play(b, "mo-in-push", 1400); }
    else if (kind === "back") { MO.ghost(b, "push"); MO.play(b, "mo-in-back", 1400); }
    else { MO.ghost(b, "fade"); MO.play(b, dir < 0 ? "mo-in-pane-back" : "mo-in-pane", 1400); }
  }

  function pfHead() {
    const node = pfNode(PF.id) || {}, ch = (node.chapters || [])[PF.n - 1] || {};
    $("lp-title").textContent = node.title || PF.id.slice(0, 8);
    const sub = [PF.id.slice(0, 4) + "·" + PF.n, ch.title || ch.q || ""].filter(Boolean).join(" · ");
    $("lp-sub").textContent = PF.turn >= 0 ? t("第 {n} 轮", { n: PF.turn + 1 }) + " · " + sub : sub;
    $("lp-back").setAttribute("aria-label", PF.turn >= 0 || PF.stack.length ? t("返回") : t("收起剖面"));
    $("lin-prof").classList.toggle("deep", PF.turn >= 0);
  }
  function pfChips() {
    const node = pfNode(PF.id); if (!node) return;
    const seg = $("lp-chs"), short = PF.id.slice(0, 4);
    seg.innerHTML = node.chapters.map((c) => {
      const name = (c.title || c.q || "").slice(0, 14);
      return `<button type="button" data-n="${c.n}" class="${c.n === PF.n ? "on" : ""}${c.title ? "" : " ghost"}" title="${esc(c.title || c.q || "")}"><i>${esc(short)}·${c.n}</i>${name ? " " + esc(name) : ""}</button>`;
    }).join("");
    seg.parentElement.classList.toggle("hidden", node.chapters.length < 2);
    const visit = pageVisit;
    requestAnimationFrame(() => { if (pfVisible(visit)) seg.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }); });
  }
  $("lp-chs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-n]"); if (!b) return;
    const n = Number(b.dataset.n); if (n === PF.n && PF.turn < 0) return;
    const dir = n < PF.n ? -1 : 1;
    PF.n = n; PF.turn = -1; PF.det = null;
    $("lp-chs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    pfHead(); pfLoad(dir);
  });

  async function pfLoad(dir) {
    const my = ++PF.seq, visit = pageVisit, body = $("lp-body");
    const live = () => my === PF.seq && pfVisible(visit);
    PF.data = null;
    if (dir) pfSwap("pane", dir);
    body.innerHTML = `<div class="lp-wait">${esc(t("正在读这一章…"))}</div>`;
    let r;
    try { r = await api(`/api/lineage/profile?id=${encodeURIComponent(PF.id)}&ch=${PF.n}`); }
    catch (e) { if (live()) body.innerHTML = `<div class="lp-wait">${esc(t("读不出来：{e}", { e: e.message }))}</div>`; return; }
    if (!live()) return;
    PF.data = r;
    pfPaint(true);
  }

  // 瀑布的横轴：每一轮按真实时长；两轮之间空得久就折成一小段，免得几天的空白把一轮挤成一个点
  function pfAxis(turns) {
    const x0 = [];
    let x = 0, prev = 0;
    const busy = turns.reduce((a, u) => a + Math.max(1000, u.t1 - u.t0), 0) || 1, fold = Math.max(busy * 0.04, 2000);
    for (const u of turns) {
      if (prev && u.t0) { const g = Math.max(0, u.t0 - prev); x += g > PF_GAP ? fold : g; }
      x0.push(x);
      x += Math.max(0, u.t1 - u.t0);
      prev = Math.max(prev, u.t1);
    }
    const total = Math.max(1, x);
    return { X: (i) => x0[i] / total * 100, W: (u) => Math.max(0, u.t1 - u.t0) / total * 100 };
  }
  const pfKind = (k) => (k === "rewind" ? t("回退出") : k === "merge" ? t("汇合进") : t("分叉出"));

  function pfPaint(fresh) {
    const body = $("lp-body"), r = PF.data;
    if (PF.turn >= 0) return pfPaintTurn();
    if (!r) return;
    if (r.error) { body.innerHTML = `<div class="lp-wait">${esc(r.error === "no_chapter" ? t("没有这一章") : r.error)}</div>`; return; }
    const T = r.turns, node = pfNode(PF.id) || {}, ch = (node.chapters || [])[PF.n - 1] || {};
    if (!T.length) { body.innerHTML = `<div class="lp-wait">${esc(t("这一章里还没有完整的一轮。"))}</div>`; return; }
    const sum = (k) => T.reduce((a, u) => a + (u[k] || 0), 0);
    const busy = T.reduce((a, u) => a + Math.max(0, u.t1 - u.t0), 0);
    const A = pfAxis(T);
    const stats = [t("{n} 轮", { n: T.length }), t("实际在干活 {d}", { d: fmtDur(busy) }), t("工具 {n} 次", { n: sum("tools") })];
    if (sum("agents")) stats.push(t("子代理 {n} 个", { n: sum("agents") }));
    if (sum("errs")) stats.push(t("出错 {n} 次", { n: sum("errs") }));
    let h = `<div class="lp-sum"><h3 class="${ch.title ? "" : "ghost"}">${esc(ch.title || ch.q || t("第 {n} 章", { n: PF.n }))}</h3>
      <p>${esc(stats.join(" · "))}</p><p class="lp-note">${esc(pfDay(T[0].t0) + " – " + pfDay(T[T.length - 1].t1))}${r.open ? " · " + esc(t("进行中的一章")) : ""}</p></div><ol class="lp-rows">`;
    let prevEnd = 0;
    T.forEach((u, i) => {
      if (prevEnd && u.t0 - prevEnd > PF_GAP) h += `<li class="lp-gap"><span>${esc(t("隔了 {d}", { d: fmtDur(u.t0 - prevEnd) }))}</span></li>`;
      prevEnd = Math.max(prevEnd, u.t1);
      const bits = [u.tools ? t("工具 {n}", { n: u.tools }) : t("直接回答")];
      if (u.agents) bits.push(t("子代理 {n}", { n: u.agents }));
      if (u.errs) bits.push(t("出错 {n}", { n: u.errs }));
      const q = u.cont ? t("（接着上一章那一轮）") : pfQ(u.q);
      h += `<li class="lp-row" data-i="${i}" tabindex="0" role="button" title="${esc(u.q || q)}">
        <div class="lp-l"><i>${i + 1}</i><span class="${u.cont ? "ghost" : ""}">${esc(q)}</span><small>${esc(pfHm(u.t0))} · ${esc(fmtDur(u.t1 - u.t0))}</small></div>
        <div class="lp-track"><b class="lp-bar${u.agents ? " ag" : ""}${u.errs ? " err" : ""}" style="inset-inline-start:${A.X(i).toFixed(3)}%;width:max(3px,${A.W(u).toFixed(3)}%)"></b></div>
        <div class="lp-meta">${esc(bits.join(" · "))}${u.top.length ? `<span>${esc(u.top.map(([k, v]) => k + " " + v).join("  "))}</span>` : ""}</div>
        ${u.kids.map((k) => `<button type="button" class="lp-kid${k.trashed ? " gone" : ""}" data-kid="${esc(k.id)}">${pfIco('<path d="M6 4v8a4 4 0 0 0 4 4h8M15 13l3 3-3 3"/>')}<span>${esc(pfKind(k.kind))}「${esc((k.title || k.id.slice(0, 8)).slice(0, 30))}」</span></button>`).join("")}
      </li>`;
    });
    h += `</ol>${r.truncated ? `<p class="lp-note">${esc(t("这一章轮数太多，只列了前 {n} 轮。", { n: T.length }))}</p>` : ""}`;
    body.innerHTML = h;
    if (fresh) MO.stagger(body.querySelectorAll(".lp-row"), 14);
    if (fresh) body.scrollTop = r.open ? body.scrollHeight : 0;   // 进行中的一章从最新那几轮看起
  }

  $("lp-body").addEventListener("click", (e) => {
    const kid = e.target.closest(".lp-kid");
    if (kid) { e.stopPropagation(); if (kid.classList.contains("gone")) return toast(t("这个会话在回收站里")); return linProfOpen(kid.dataset.kid, 0, true); }
    const ag = e.target.closest(".lp-agent[data-a]");
    if (ag) return pfToggleAgent(ag);
    const row = e.target.closest(".lp-row[data-i]");
    if (row && PF.turn < 0) return pfTurn(Number(row.dataset.i));
  });
  $("lp-body").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".lp-row[data-i], .lp-agent[data-a]"); if (!row) return;
    e.preventDefault(); row.click();
  });

  async function pfTurn(i, resume = false) {
    const u = PF.data && PF.data.turns[i]; if (!u) return;
    PF.turn = i; PF.det = null; PF.open = {};
    const body = $("lp-body"), my = ++PF.seq, visit = pageVisit;
    const live = () => my === PF.seq && PF.turn === i && pfVisible(visit);
    if (!resume) { PF.scroll = body.scrollTop; pfSwap("push"); }
    pfHead();
    body.scrollTop = 0;
    body.innerHTML = `<div class="lp-wait">${esc(t("正在读这一轮…"))}</div>`;
    let d;
    try { d = await api(`/api/lineage/turn?id=${encodeURIComponent(PF.id)}&from=${u.off}&to=${u.end}`); }
    catch (e) { if (live()) body.innerHTML = `<div class="lp-wait">${esc(t("读不出来：{e}", { e: e.message }))}</div>`; return; }
    if (!live()) return;
    PF.det = d;
    pfPaintTurn(true);
  }

  // 一轮的细节：线性时间轴（这一轮的起止，后台子代理收尾晚的算进来）；主会话每次工具调用一行，子代理按派出关系缩进
  function pfPaintTurn(fresh) {
    const body = $("lp-body"), d = PF.det, u = PF.data && PF.data.turns[PF.turn];
    if (!d || !u) return;
    const t0 = d.t0 || u.t0, span = Math.max(1000, (d.t1 || u.t1) - t0);
    const pos = pfPos(t0, span);
    const ticks = [0, .25, .5, .75, 1].map((p) => `<span style="inset-inline-start:${p * 100}%">${esc(p ? "+" + fmtDur(span * p) : pfHm(t0))}</span>`).join("");
    const bits = [t("用时 {d}", { d: fmtDur(span) }), t("工具 {n} 次", { n: u.tools })];
    if (d.agents.length) bits.push(t("子代理 {n} 个", { n: d.agents.length }));
    if (u.errs) bits.push(t("出错 {n} 次", { n: u.errs }));
    const step = (s, cls) => pfStep(s, pos, cls);
    let h = `<div class="lp-sum"><h3 class="clamp">${esc(u.cont ? t("（接着上一章那一轮）") : pfQ(d.q || u.q))}</h3><p>${esc(bits.join(" · "))}</p>
      <p class="lp-key"><span><i class="pre"></i>${esc(t("发起前在想"))}</span><span><i></i>${esc(t("工具在跑"))}</span>${d.agents.length ? `<span><i class="ag"></i>${esc(t("子代理"))}</span>` : ""}</p>
      <div class="lp-sum-acts"><button type="button" class="lin-chip" id="lp-goto">${esc(t("在对话里看这一轮"))}</button></div></div>
      <div class="lp-axis"><div class="lp-l"></div><div class="lp-ticks">${ticks}</div></div>`;
    if (d.agents.length) {
      h += `<h4 class="lp-h">${esc(t("子代理"))}</h4><ol class="lp-rows dense">`;
      d.agents.forEach((a, k) => {
        const st = !a.done ? t("没有结束记录") : a.errs ? t("{n} 步出错", { n: a.errs }) : t("完成");
        h += `<li class="lp-agent" data-a="${k}" tabindex="0" role="button" aria-expanded="${PF.open[k] ? "true" : "false"}" style="--d:${a.depth - 1}" title="${esc(a.why || a.name)}">
          <div class="lp-l"><span><b>${esc(a.name)}</b>${a.bg ? " · " + esc(t("后台")) : ""}</span><small>${esc(fmtDur(a.t1 - a.t0))} · ${esc(t("工具 {n}", { n: a.tools }))} · ${esc(st)}</small></div>
          <div class="lp-track"><b class="lp-bar ag${a.done ? "" : " open"}" style="${pos(a.t0, a.t1)}"></b></div></li>
          <li class="lp-sub${PF.open[k] ? "" : " hidden"}" data-of="${k}"><ol>${PF.open[k] ? pfSteps(a, step) : ""}</ol></li>`;
      });
      h += `</ol>`;
    }
    h += `<h4 class="lp-h">${esc(t("主会话"))}</h4>`;
    h += d.main.length ? `<ol class="lp-rows dense">${d.main.map((s) => step(s)).join("")}</ol>` : `<p class="lp-note">${esc(t("这一轮没调用工具，直接回答的。"))}</p>`;
    if (d.more) h += `<p class="lp-note">${esc(t("还有 {n} 次工具调用没列出来。", { n: d.more }))}</p>`;
    body.innerHTML = h;
    if (fresh) MO.stagger(body.querySelectorAll(".lp-rows > li:not(.lp-sub)"), 16);
    $("lp-goto").addEventListener("click", () => openSession(PF.id, null, { uuid: u.uuid, off: u.off }));
  }
  const pfPos = (t0, span) => (a, b) => `inset-inline-start:${((a - t0) / span * 100).toFixed(3)}%;width:max(3px,${(Math.max(0, b - a) / span * 100).toFixed(3)}%)`;
  /** 一次工具调用一行：浅色一截是发起前模型在想（上一次调用结束到这次发起），深色是工具本身跑的时间 */
  function pfStep(s, pos, cls = "") {
    const think = Math.max(0, s.t0 - (s.p0 == null ? s.t0 : s.p0)), run = s.t1 - s.t0;
    const tip = s.name + (s.label ? " · " + s.label : "") + "\n" + t("想了 {a} · 跑了 {b}", { a: fmtDur(think, true), b: fmtDur(run, true) });
    return `<li class="lp-step ${cls}" title="${esc(tip)}">
      <div class="lp-l"><span><b>${esc(s.name)}</b>${s.label ? " " + esc(s.label) : ""}</span><small>${s.err ? esc(t("失败")) + " · " : ""}${esc(fmtDur(run, true))}</small></div>
      <div class="lp-track">${think >= 500 ? `<b class="lp-bar pre" style="${pos(s.p0, s.t0)}"></b>` : ""}<b class="lp-bar${s.agent ? " ag" : ""}${s.err ? " err" : ""}" style="${pos(s.t0, s.t1)}"></b></div></li>`;
  }
  /** 提问里的附件路径（@/… 或 [附件：…]）对看剖面没用，占地方：去掉，换成一句「附件」 */
  const pfQ = (q) => { const x = String(q || "").replace(new RegExp("(?:@\\/\\S+|" + BIG_REF + ")\\s*", "g"), "").trim(); return x === String(q || "").trim() ? x : (x ? x + " " : "") + t("（带附件）"); };
  const pfSteps = (a, step) => a.steps.length ? a.steps.map((s) => step(s, "in")).join("") + (a.tools > a.steps.length ? `<li class="lp-note">${esc(t("还有 {n} 次工具调用没列出来。", { n: a.tools - a.steps.length }))}</li>` : "")
    : `<li class="lp-note">${esc(t("没调用工具。"))}</li>`;
  function pfToggleAgent(el) {
    const k = Number(el.dataset.a), a = PF.det && PF.det.agents[k]; if (!a) return;
    const sub = $("lp-body").querySelector(`.lp-sub[data-of="${k}"]`); if (!sub) return;
    PF.open[k] = !PF.open[k];
    el.setAttribute("aria-expanded", PF.open[k] ? "true" : "false");
    if (PF.open[k]) {
      MO.cancel(sub);
      const t0 = PF.det.t0 || PF.data.turns[PF.turn].t0, span = Math.max(1000, (PF.det.t1 || PF.data.turns[PF.turn].t1) - t0);
      const pos = pfPos(t0, span);
      sub.querySelector("ol").innerHTML = pfSteps(a, (s, cls) => pfStep(s, pos, cls));
      sub.classList.remove("hidden");
      MO.play(sub, "mo-in-rise", 900);
    } else MO.hide(sub, "mo-out-fade", 140);
  }

  $("lp-back").addEventListener("click", linProfBack);
  $("lp-open").addEventListener("click", () => {
    const u = PF.turn >= 0 && PF.data ? PF.data.turns[PF.turn] : null, node = pfNode(PF.id);
    if (u) return openSession(PF.id, null, { uuid: u.uuid, off: u.off });
    const c = node && node.chapters[PF.n - 1];
    openSession(PF.id, null, PF.n === 1 ? "start" : (c && c.anchor) || "");
  });

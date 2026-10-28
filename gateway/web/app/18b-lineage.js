  // ── 脉络页（整页）：地图本体在 web/lineage/map.js（教程页共用），这里管取数、翻译、项目条和卡片按钮 ──
  // 数据：/api/lineage（gw/lineage.mjs lineageGraph）。旧会话兼容见规划书 §12：未建档的章拿章首提问灰字顶上，
  // 一问一答和杂项一起默认收起，读记录接手的画细点线。
  const LIN = { g: null, map: null, band: localStorage.getItem("cc.linBand") || "", misc: localStorage.getItem("cc.linMisc") === "1", focus: null, poll: 0, runKey: "", reload: 0 };

  function linMap() {
    if (LIN.map || !window.CCLineageMap) return LIN.map;
    LIN.map = CCLineageMap.create($("lin-map"), {
      t, locale: I18N.lang, misc: LIN.misc, band: LIN.band,
      acts: (s) => s.trashed ? [{ act: "restore", label: t("恢复"), pri: true }]
        : [{ act: "open", label: t("打开"), pri: true }, { act: "menu", label: t("章节与题名") }, { act: "merge", label: t("汇合…"), off: true, title: t("即将推出") }],
      onAct: linAct,
    });
    return LIN.map;
  }
  function linAct(act, arg, el, sel) {
    if (act === "open" && arg && arg !== sel) return openSession(arg);   // 定时任务卡片里点某一次
    if (act === "open") return openSession(sel);
    if (act === "chapter") {
      // 地图上的站 / 卡片里的章：落在那一章开头（第一章 = 会话开头）
      const n = Number(arg), c = LIN.g?.nodes.find((x) => x.id === sel)?.chapters[n - 1];
      return openSession(sel, null, n === 1 ? "start" : c?.anchor || "");
    }
    if (act === "menu" || act === "tree") return lineageMenu(arg, el);
    if (act === "restore") return post("/api/trash/restore", { ids: [sel] }).then(() => { toast(t("已恢复")); loadSessions(); loadLineage(); }, (e) => toast(e.message, true));
  }

  /** 从别处跳进脉络页并选中某个会话（会话菜单「在脉络中查看」） */
  function openLineage(id) { LIN.focus = id || null; openPage("lineage"); }

  async function loadLineage() {
    clearTimeout(LIN.poll);
    let g;
    try { g = await api("/api/lineage"); } catch (e) { return linState(t("读不到脉络：{e}", { e: e.message })); }
    if (g.building) {
      // 首次整理（大户十几秒）：显示进度，接着问
      linState(t("正在整理会话记录… {d}/{n}", { d: g.done || 0, n: g.total || "?" }));
      if (pageOn("lineage")) LIN.poll = setTimeout(loadLineage, 800);
      return;
    }
    LIN.g = g;
    linPaint(true);
    linFill();
    // 第一次来：提一句「怎么看」，不强拉进导览
    if (!localStorage.getItem("cc.linTourSeen") && !LIN.hinted) { LIN.hinted = true; toast(t("第一次来？点右上「怎么看」，两分钟学会看脉络")); }
  }

  // ── 补档（gw/backfill.mjs）：没题名的旧章，用全局默认模型按压缩摘要补起题名；先报预估，用户点头才跑 ──
  const FILL = { st: null, poll: 0, was: false };
  async function linFill() {
    clearTimeout(FILL.poll);
    let r;
    try { r = await api("/api/lineage/backfill"); } catch { return; }
    FILL.st = r;
    const j = r.job, el = $("lin-fill");
    if (j.running) {
      el.textContent = t("补档中 {d}/{n} · 停止", { d: j.done, n: j.total });
      el.classList.remove("hidden"); el.classList.add("on");
      FILL.was = true;
      if (pageOn("lineage")) FILL.poll = setTimeout(linFill, 2000);
      return;
    }
    el.classList.remove("on");
    if (FILL.was) {
      // 刚跑完：报结果、重画（新题名进图）
      FILL.was = false;
      toast(j.error && !j.ok ? t("补档没跑成：{e}", { e: j.error }) : t("补好 {n} 章题名", { n: j.ok }) + (j.failed ? t("，{n} 章没起成", { n: j.failed }) : ""), !!(j.error && !j.ok));
      loadLineage();
    }
    const n = r.estimate.chapters;
    el.textContent = t("补档 · {n} 章", { n });
    el.classList.toggle("hidden", !n);
  }
  $("lin-fill").addEventListener("click", async () => {
    const r = FILL.st; if (!r) return;
    if (r.job.running) { await post("/api/lineage/backfill", { action: "stop" }).catch(() => {}); return linFill(); }
    const e = r.estimate, num = (x) => x.toLocaleString(I18N.lang);
    const msg = t("用全局默认的 {m}（{p}）给 {s} 个会话的 {c} 章补起题名。", { m: r.modelName || r.model || "?", p: r.provider, s: e.sessions, c: e.chapters })
      + "\n\n" + t("素材是每章结束时的压缩摘要，不重读全文。预计 {k} 次调用，输入约 {i} token、输出约 {o} token（按上限估，实际通常更少）。", { k: e.calls, i: num(e.tokensIn), o: num(e.tokensOut) })
      + "\n\n" + t("补出来的题名随时能改，之后 AI 建档也会盖过它。开始吗？");
    if (!confirm(msg)) return;
    try {
      const s = await post("/api/lineage/backfill", { action: "start" });
      if (!s.ok && s.message === "nothing") toast(t("没有要补的章了"));
      else if (!s.ok && s.message === "bridge") toast(t("本地 DNS 桥启动失败，无法连接 API。"), true);
    } catch (err) { toast(err.message, true); }
    linFill();
  });
  const mdOf = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  function linState(msg) {
    const el = $("lin-state");
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
    $("lin-map").classList.toggle("hidden", !!msg);
  }

  // 网关的图 → 地图要的样子：定时任务生出的会话并成一条串点线；分叉 / 回退 / 汇合 / 接手各归各位
  function linModel(g) {
    const live = new Set(srv.runs.filter((r) => !r.idle).map((r) => r.sessionId).filter(Boolean));
    const bandOf = (b) => (b.key === "ws" ? t("工作区") : b.key === "other" ? t("其他目录") : b.name || "?");
    const bands = [], seenB = new Set();
    const nodes = [...g.nodes].sort((a, b) => b.lastTs - a.lastTs);
    for (const n of nodes) if (!seenB.has(n.band.key)) { seenB.add(n.band.key); bands.push({ key: n.band.key, name: bandOf(n.band) }); }
    // 项目在前、工作区其次、其他目录最后；项目之间按最近活动
    const rank = (k) => (k === "other" ? 2 : k === "ws" ? 1 : 0);
    bands.sort((a, b) => rank(a.key) - rank(b.key));
    const prim = {}, extra = {}, reads = {};
    for (const e of g.edges) {
      if (e.kind === "merge") (extra[e.child] = extra[e.child] || []).push({ id: e.parent, ts: e.ts });
      else if (e.kind === "read") (reads[e.child] = reads[e.child] || []).push({ id: e.parent, ts: e.ts, early: !!e.early });
      else prim[e.child] = e;
    }
    const size = (kb) => (kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB");
    const sessions = [], tasks = new Map();
    for (const n of nodes) {
      if (n.sched) {
        const key = "task:" + (n.sched.id || n.sched.name);
        let tk = tasks.get(key);
        if (!tk) { tk = { id: key, short: "", band: n.band.key, title: n.sched.name, task: { runs: [] }, misc: false }; tasks.set(key, tk); sessions.push(tk); }
        tk.task.runs.push({ id: n.id, ts: n.firstTs });
        continue;
      }
      const chs = n.chapters, p = prim[n.id];
      sessions.push({
        id: n.id, short: n.id.slice(0, 4), band: n.band.key, title: n.title || n.id.slice(0, 8), ghost: !n.titleBy,
        from: n.firstTs, to: n.lastTs, running: live.has(n.id), trashed: n.trashed, misc: n.misc || n.brief,
        parent: p && !p.missing ? p.parent : null, at: p ? p.ts || 0 : 0, kind: p ? p.kind : null, missingParent: !!(p && p.missing),
        extra: extra[n.id] || [], reads: reads[n.id] || [],
        ch: chs.slice(0, -1).map((c) => ({ at: c.to, t: c.title || c.q, ghost: !c.title })),
        open: { t: chs[chs.length - 1].title || chs[chs.length - 1].q, ghost: !chs[chs.length - 1].title },
        meta: { size: size(n.sizeKb) },
      });
    }
    for (const tk of tasks.values()) tk.task.runs.sort((a, b) => a.ts - b.ts);
    return { now: Date.now(), bands, sessions };
  }

  function linPaint(fresh) {
    const g = LIN.g; if (!g || !pageOn("lineage")) return;
    const m = linModel(g), map = linMap();
    if (!map) return linState(t("脉络组件没加载出来，重新打开 App 试试"));
    linState(m.sessions.length ? "" : t("还没有会话。聊过几次之后，这里会画出它们之间的来龙去脉。"));
    if (LIN.band && !m.bands.some((b) => b.key === LIN.band)) LIN.band = "";
    // 项目条：全部 + 各带；选中的滚进视野
    const seg = $("lin-bands");
    seg.innerHTML = [{ key: "", name: t("全部") }, ...m.bands].map((b) => `<button data-b="${esc(b.key)}" class="${b.key === LIN.band ? "on" : ""}">${esc(b.name)}</button>`).join("");
    seg.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    $("lin-misc").checked = LIN.misc;
    const shown = m.sessions.filter((s) => !s.misc), rel = g.edges.filter((e) => e.kind !== "read" || e.early).length;
    const first = Math.min(...g.nodes.map((n) => n.firstTs).filter(Boolean));
    setPageSub("lineage", t("{n} 个会话 · {m} 处亲缘", { n: shown.length, m: rel }) + (isFinite(first) ? " · " + t("{d} 起", { d: mdOf(first) }) : ""));
    LIN.runKey = m.sessions.filter((s) => s.running).map((s) => s.id).join();
    map.set(m, { misc: LIN.misc, band: LIN.band, home: fresh && !LIN.focus });
    if (LIN.focus) { const id = LIN.focus; LIN.focus = null; requestAnimationFrame(() => map.select(id, { reveal: true })); }
  }

  // 项目条和「显示杂项」
  $("lin-bands").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-b]"); if (!b) return;
    LIN.band = b.dataset.b; localStorage.setItem("cc.linBand", LIN.band);
    linPaint(true);
  });
  $("lin-misc").addEventListener("change", (e) => {
    LIN.misc = e.target.checked; localStorage.setItem("cc.linMisc", LIN.misc ? "1" : "0");
    linPaint(false);
  });
  // 会话变了（建档、跑完、改名…）：脉络页开着就顺手重取，合并成一次
  function lineageDirty() {
    if (!pageOn("lineage")) return;
    clearTimeout(LIN.reload); LIN.reload = setTimeout(loadLineage, 1200);
  }
  // 运行状态变了：蓝点跟着动，不用重取
  function lineageRuns() {
    if (!pageOn("lineage") || !LIN.g) return;
    const key = srv.runs.filter((r) => !r.idle).map((r) => r.sessionId).filter(Boolean).sort().join();
    if (key !== LIN.runKey.split(",").filter(Boolean).sort().join()) linPaint(false);
  }


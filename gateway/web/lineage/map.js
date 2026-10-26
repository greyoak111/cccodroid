// 脉络 · 地图（App 的脉络页和教程页共用这一份：教程里学会的手势，到真页面一模一样）。
// 规划见 claude-workspace/session-lineage-plan.md §11（视觉稿 lineage-draft/lineage.html）。
//
// 用法：const m = CCLineageMap.create(el, opts); m.set(model); m.select(id); m.destroy();
//   opts.t(key, vars)        翻译；默认原样返回中文
//   opts.locale              日期里的星期按这个语言写
//   opts.acts(s)             选中会话时卡片底下的按钮：[{ act, label, pri, off, title }]
//   opts.onAct(act, id, el)  按钮 / 卡片里各章 / 定时任务各次被点
//   opts.onSelect(id|null)   选中变了
//   opts.onGesture(kind)     做了一个手势：pan / zoom / home（教程据此判断这一步做对了）
//   opts.misc                显示杂项（含一问一答）；opts.band 只看某一带（key）—— 都可以 set 时改
// model：{ now, bands: [{ key, name }], sessions: [会话] }，会话：
//   { id, short, band, title, ghost, from, to, running, trashed, misc, parent, at, kind, missingParent,
//     extra: [{ id, ts }], reads: [{ id, ts, early }], ch: [{ at, t, ghost }], open: { t, ghost }, meta: { size },
//     task: { runs: [{ id, ts }] } }   ← 定时任务：一条虚线串点，每个点是它生出的一个会话
//
// 手势（规划书 §11.5，一页只有一个会自由滚的东西）：
//   单指拖自由平移 + 惯性 + 边缘阻尼弹回；日期轴只跟横移、带名只跟竖移；双指只缩放时间轴（锚两指中点）；
//   双击回「现在」；移动 < 6px 算点按（点线选中、点空白取消）；卡片自己吃手势、章节在卡片里竖滚。
//   宽度 < 600 换成缩进树（只竖滚）。
(function () {
  "use strict";
  const LEFT = 112, RIGHT = 240, LANE = 46, BANDPAD = 34, PHONE = 600;
  const p2 = (n) => String(n).padStart(2, "0");
  const md = (ms) => { const d = new Date(ms); return p2(d.getMonth() + 1) + "-" + p2(d.getDate()); };
  const hm = (ms) => { const d = new Date(ms); return p2(d.getHours()) + ":" + p2(d.getMinutes()); };
  const range = (a, b) => (md(a) === md(b) ? md(b) + " " + hm(b) : md(a) + " – " + md(b));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const textW = (s, px = 12.5) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? px : px * 0.56), 0);
  // 图上的标题限宽（未建档的旧会话拿提问顶题名，可能很长）；卡片里照旧全文
  const clip = (s, px = 280) => { s = String(s || ""); if (textW(s) <= px) return s; while (s.length > 2 && textW(s + "…") > px) s = s.slice(0, -1); return s + "…"; };
  const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function create(root, opts = {}) {
    const t = opts.t || fmt;
    const st = { model: null, vis: [], BY: {}, sel: null, k: 1, tx: 0, ty: 0, raf: 0, W: 0, H: 0, AX: null, L: null, mode: "", placed: false, misc: !!opts.misc, band: opts.band || null };
    root.classList.add("lmap");
    root.innerHTML = `<div class="lm-canvas"><div class="lm-main"></div><div class="lm-axis"></div><div class="lm-band"></div>
      <button class="lm-now" type="button"></button><div class="lm-card"></div></div><div class="lm-tree"></div>`;
    const cv = root.querySelector(".lm-canvas"), tree = root.querySelector(".lm-tree");
    const layer = { main: cv.querySelector(".lm-main"), axis: cv.querySelector(".lm-axis"), band: cv.querySelector(".lm-band"), now: cv.querySelector(".lm-now"), card: cv.querySelector(".lm-card") };
    layer.now.textContent = t("回到现在");
    const wd = (ms) => { try { return new Date(ms).toLocaleDateString(opts.locale || undefined, { weekday: "short" }); } catch { return ""; } };

    // ── 数据：按开关筛出要画的会话 ──
    function filter() {
      const m = st.model; if (!m) return;
      st.vis = m.sessions.filter((s) => (st.misc || !s.misc) && (!st.band || s.band === st.band));
      st.BY = Object.fromEntries(st.vis.map((s) => [s.id, s]));
      if (st.sel && !st.BY[st.sel]) st.sel = null;
    }
    const startOf = (s) => (s.task ? s.task.runs[0].ts : s.from);
    const endOf = (s) => (s.task ? s.task.runs[s.task.runs.length - 1].ts : s.to);

    // ── 时间轴：按事件疏密伸缩（相邻事件宽 min(76, 12+15√小时)，超 36 小时压成 44 并画 ⋯）──
    function buildAxis(K) {
      const ev = new Set([st.model.now]);
      for (const s of st.vis) {
        if (s.task) { s.task.runs.forEach((r) => ev.add(r.ts)); continue; }
        ev.add(s.from); ev.add(s.to); if (s.at) ev.add(s.at);
        s.ch.forEach((c) => ev.add(c.at));
        (s.extra || []).forEach((e) => e.ts && ev.add(e.ts));
        (s.reads || []).forEach((e) => e.ts && ev.add(e.ts));
      }
      const ts = [...ev].filter((x) => x > 0).sort((a, b) => a - b), xs = [LEFT], breaks = [];
      for (let i = 1; i < ts.length; i++) {
        const h = (ts[i] - ts[i - 1]) / 36e5;
        if (h > 36) breaks.push([ts[i - 1], ts[i]]);
        xs.push(xs[i - 1] + (h > 36 ? 44 : Math.min(76, 12 + 15 * Math.sqrt(h))) * K);
      }
      const X = (ms) => {
        if (!ts.length) return LEFT;
        if (ms <= ts[0]) return xs[0] - (ts[0] - ms) / 36e5 * 4 * K;
        if (ms >= ts[ts.length - 1]) return xs[xs.length - 1] + (ms - ts[ts.length - 1]) / 36e5 * 20 * K;
        let lo = 0, hi = ts.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= ms) lo = m; else hi = m; }
        return xs[lo] + (xs[hi] - xs[lo]) * (ms - ts[lo]) / (ts[hi] - ts[lo]);
      };
      // 日期刻度：每天 0 点；落在压掉的空档里的不标，太挤的跳过；第一天也标
      const ticks = ts.length ? [[ts[0], LEFT - 4]] : [];
      let last = LEFT;
      if (ts.length) for (let d = dayStart(ts[0]) + 864e5; d <= ts[ts.length - 1]; d = dayStart(d + 30 * 36e5)) {
        if (breaks.some(([a, b]) => d > a && d < b)) continue;
        const x = X(d); if (x - last < 84) continue; ticks.push([d, x]); last = x;
      }
      return { X, ticks, breaks: breaks.map(([a, b]) => (X(a) + X(b)) / 2), width: xs[xs.length - 1] + RIGHT };
    }

    // ── 布局：按带分；每带里按 DFS（主父）顺序给线找最高的空车道（时间段 + 标题宽度不重叠）。
    //    汇合出来的、读记录接手的，放在来源的下一层 ──
    function layout() {
      const AX = st.AX, V = st.vis, BY = st.BY;
      const keys = (st.model.bands || []).map((b) => b.key).filter((k) => V.some((s) => s.band === k));
      const kids = {}; V.forEach((s) => { if (s.parent && BY[s.parent]) (kids[s.parent] = kids[s.parent] || []).push(s.id); });
      const srcOf = (s) => [...(s.extra || []), ...(s.reads || []).filter((r) => r.early)].map((e) => e.id).filter((id) => BY[id]);
      const pos = {}, bandY = [];
      let y = 44;
      for (const key of keys) {
        const lanes = [], order = [], seen = new Set();
        const mine = V.filter((s) => s.band === key);
        const roots = mine.filter((s) => !(s.parent && BY[s.parent]) && !srcOf(s).length).sort((a, b) => startOf(a) - startOf(b));
        const dfs = (s) => { if (seen.has(s.id)) return; seen.add(s.id); order.push(s); (kids[s.id] || []).map((k) => BY[k]).sort((a, b) => a.from - b.from).forEach(dfs); };
        roots.forEach(dfs);
        mine.filter((s) => !seen.has(s.id)).sort((a, b) => startOf(a) - startOf(b)).forEach(dfs);   // 汇合 / 接手的，排在来源后面
        for (const s of order) {
          const x0 = s.task ? AX.X(startOf(s)) - 8 : s.parent && BY[s.parent] ? AX.X(s.at || s.from) - 6 : AX.X(s.from) - 6;
          const x1 = Math.max(AX.X(endOf(s)), x0 + textW(clip(s.title)) + 30) + 26;
          let min = 0;
          if (s.parent && pos[s.parent]) min = pos[s.parent].lane + 1;
          for (const id of srcOf(s)) if (pos[id] && BY[id].band === key) min = Math.max(min, pos[id].lane + 1);
          let L = min;
          while (lanes[L] && lanes[L].some(([a, b]) => !(x1 < a || x0 > b))) L++;
          (lanes[L] = lanes[L] || []).push([x0, x1]);
          pos[s.id] = { lane: L, y: 0 };
        }
        const n = Math.max(1, lanes.length);
        bandY.push({ key, y, h: BANDPAD + n * LANE + 8 });
        for (const s of order) pos[s.id].y = y + BANDPAD + pos[s.id].lane * LANE + 18;
        y += BANDPAD + n * LANE + 18;
      }
      return { pos, bandY, height: y + 10 };
    }

    // 一家子：祖先、后代、汇合来源、接手来源（以及从它汇合 / 接手出去的）
    function family(id) {
      const BY = st.BY, out = new Set([id]);
      const ups = (s) => [s.parent, ...(s.extra || []).map((e) => e.id), ...(s.reads || []).filter((r) => r.early).map((r) => r.id)].filter((x) => x && BY[x]);
      const up = (x) => ups(BY[x]).forEach((p) => { if (!out.has(p)) { out.add(p); if (p === BY[x].parent) up(p); } });
      up(id);
      const down = (x) => st.vis.forEach((k) => { if (!out.has(k.id) && ups(k).includes(x)) { out.add(k.id); down(k.id); } });
      down(id);
      return out;
    }

    function bandName(key) { const b = (st.model.bands || []).find((x) => x.key === key); return b ? b.name : key; }

    // ── 画（平板）──
    function paint() {
      const AX = st.AX = buildAxis(st.k), L = st.L = layout(), BY = st.BY, sel = st.sel, fam = sel ? family(sel) : null;
      const W = st.W = AX.width, H = st.H = L.height;
      const g = [], ax = [], lines = [], labels = [], hits = [], sts = [];
      for (const [ms, x] of AX.ticks) {
        g.push(`<line x1="${x}" y1="30" x2="${x}" y2="${H}" class="lm-grid"/>`);
        ax.push(`<text class="t-axis" x="${x + 6}" y="20">${md(ms)} <tspan opacity=".6">${esc(wd(ms))}</tspan></text>`);
      }
      for (const b of AX.breaks) {
        if (!AX.ticks.some(([, x]) => b > x - 10 && b < x + 86)) ax.push(`<text class="t-axis" x="${b}" y="20" text-anchor="middle">⋯</text>`);
        g.push(`<line x1="${b}" y1="30" x2="${b}" y2="${H}" class="lm-brk"/>`);
      }
      L.bandY.forEach((b, i) => { if (i) g.push(`<line x1="0" y1="${b.y - 6}" x2="${W}" y2="${b.y - 6}" class="lm-sep"/>`); });
      const xn = AX.X(st.model.now);
      g.push(`<line x1="${xn}" y1="28" x2="${xn}" y2="${H}" class="lm-nowline"/>`);
      ax.push(`<text class="t-now" x="${xn - 4}" y="20" text-anchor="end">${esc(t("现在"))}</text>`);
      const TR = "var(--lm-track)";
      for (const s of st.vis) {
        const P = L.pos[s.id]; if (!P) continue;
        const on = !fam || fam.has(s.id), isSel = s.id === sel, cls = on ? "" : "dim";
        const stroke = isSel ? "var(--fg)" : fam && on ? "var(--fg2)" : TR;
        const sw = isSel ? 2.6 : fam && on ? 2.2 : 2, y = P.y;
        if (s.task) {
          const a = AX.X(startOf(s)), b = AX.X(endOf(s));
          lines.push(`<g class="${cls}"><line x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="${isSel ? "var(--fg2)" : TR}" stroke-width="1.6" stroke-dasharray="3 5" stroke-linecap="round"/>${s.task.runs.map((r) => `<circle cx="${AX.X(r.ts)}" cy="${y}" r="3.2" fill="${isSel ? "var(--fg)" : "var(--fg3)"}"/>`).join("")}</g>`);
          labels.push(`<text class="t-title ${cls}" x="${a - 4}" y="${y - 10}" data-sx="${a - 4}" data-ex="${b}" data-w="${textW(s.title) + 50}">${esc(s.title)} <tspan class="t-axis" dx="4">· ${esc(t("{n} 次", { n: s.task.runs.length }))}</tspan></text>`);
          hits.push(`<line data-id="${esc(s.id)}" x1="${a - 6}" y1="${y}" x2="${b + 6}" y2="${y}" stroke="transparent" stroke-width="22"/><rect data-id="${esc(s.id)}" x="${a - 6}" y="${y - 26}" width="${Math.max(b - a, textW(s.title) + 40)}" height="22" fill="transparent"/>`);
          continue;
        }
        let x0 = AX.X(s.from);
        const x1 = Math.max(AX.X(s.to), x0 + 22);
        let conn = "";
        const P0 = s.parent && L.pos[s.parent];
        if (P0) {
          // 分叉往前弯、回退往回弯；分出去后隔了一阵才开始的，中间一段细虚线；分叉点实心小点
          const xf = AX.X(s.at || s.from), yp = P0.y;
          const pstroke = fam && on && fam.has(s.parent) ? stroke : TR;
          const pdash = BY[s.parent].trashed ? 'stroke-dasharray="4 4"' : "";
          const back = s.kind === "rewind", land = back ? xf + 6 : xf + 22;
          const curve = back ? `M${xf} ${yp} C${xf - 22} ${yp} ${xf - 16} ${y} ${land} ${y}` : `M${xf} ${yp} C${xf + 14} ${yp} ${xf + 4} ${y} ${land} ${y}`;
          x0 = Math.max(x0, land);
          conn = `<path d="${curve}" fill="none" stroke="${pstroke}" stroke-width="${sw}" ${pdash} stroke-linecap="round"/>`;
          if (x0 - land > 14) conn += `<line x1="${land}" y1="${y}" x2="${x0}" y2="${y}" stroke="${pstroke}" stroke-width="1.3" stroke-dasharray="2 4" stroke-linecap="round"/>`;
          conn += `<circle cx="${xf}" cy="${yp}" r="3" fill="${pstroke}"/>`;
        } else if (s.missingParent) {
          conn = `<line x1="${x0 - 22}" y1="${y}" x2="${x0}" y2="${y}" stroke="${TR}" stroke-width="1.6" stroke-dasharray="2 3"/>`;
        }
        // 汇合：从来源「取材料的那一点」出发，细线落到新车道再沿车道走，箭头指向新会话
        const ex = (s.extra || []).filter((e) => L.pos[e.id]);
        for (const e of ex) {
          const ye = L.pos[e.id].y, xe = AX.X(e.ts || BY[e.id].to);
          const stc = fam && on ? "var(--fg2)" : TR;
          conn += `<path d="M${xe} ${ye} C${xe + 16} ${ye} ${xe + 6} ${y} ${xe + 24} ${y} L${x0 - 7} ${y}" fill="none" stroke="${stc}" stroke-width="1.3"/><circle cx="${xe}" cy="${ye}" r="2.6" fill="${stc}"/>`;
        }
        if (ex.length) conn += `<path d="M${x0 - 9} ${y - 4.5} L${x0 - 1} ${y} L${x0 - 9} ${y + 4.5}" fill="none" stroke="${fam && on ? "var(--fg2)" : "var(--fg3)"}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        // 读记录接手（改版前的旧会话）：来源在那一刻的位置 → 读者读的那一点，细点线。接手的常显，其余的选中时才画
        for (const r of s.reads || []) {
          if (!L.pos[r.id] || !(r.early || (fam && fam.has(r.id) && on))) continue;
          const yr = L.pos[r.id].y, xr = AX.X(r.ts), stc = fam && on && fam.has(r.id) ? "var(--fg2)" : TR;
          conn += `<path d="M${xr} ${yr} C${xr + 10} ${yr} ${xr + 10} ${y} ${xr + 18} ${y}" fill="none" stroke="${stc}" stroke-width="1.3" stroke-dasharray="1.5 3" stroke-linecap="round"/><circle cx="${xr}" cy="${yr}" r="2.4" fill="none" stroke="${stc}" stroke-width="1.3"/>`;
        }
        const dead = s.trashed;
        let body = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${dead ? "var(--fg3)" : stroke}" stroke-width="${sw}" stroke-linecap="round" ${dead ? 'stroke-dasharray="4 4" opacity=".55"' : ""}/>`;
        if (!P0 && !ex.length) body += `<circle cx="${x0}" cy="${y}" r="3.2" fill="${dead ? "var(--fg3)" : stroke}"/>`;
        // 站点 = 压缩处 = 下一章的开头；外面套一圈透明的大热区，点站直接跳到会话里那个位置
        s.ch.forEach((c, i) => { body += `<circle cx="${AX.X(c.at)}" cy="${y}" r="4.6" fill="var(--bg)" stroke="${stroke}" stroke-width="${isSel ? 2.2 : 1.8}"/>`; if (!dead) sts.push(`<circle class="lm-st" data-st="${esc(s.id)}" data-n="${i + 2}" cx="${AX.X(c.at)}" cy="${y}" r="12" fill="transparent"/>`); });
        if (isSel) {
          // 选中：线上方逐章「章序 · 题名」，段太短只写序号；未建档的章灰字
          const cuts = [x0, ...s.ch.map((c) => AX.X(c.at)), x1], names = [...s.ch, s.open];
          names.forEach((c, i) => {
            const a = cuts[i] + (i ? 9 : -2), room = cuts[i + 1] - a - 10;
            if (room < 10) return;
            let txt = (i + 1) + " · " + (c.t || "");
            if (textW(txt, 12) > room) { while (txt.length > 3 && textW(txt + "…", 12) > room) txt = txt.slice(0, -1); txt += "…"; }
            if (room < 64) txt = String(i + 1);
            const last = i === names.length - 1;
            labels.push(`<text class="t-title t-ch${c.ghost ? " ghost" : ""}${last ? " cur" : ""}" x="${a}" y="${y - 11}">${esc(txt)}</text>`);
          });
        }
        if (s.running) body += `<circle cx="${x1}" cy="${y}" r="4" class="lm-run"><animate attributeName="r" values="3.4;5;3.4" dur="1.6s" repeatCount="indefinite"/></circle>`;
        lines.push(`<g class="${cls}">${conn}${body}</g>`);
        if (!isSel) labels.push(`<text class="t-title${dead || s.ghost ? " ghost" : ""} ${cls}" x="${x0 - 2}" y="${y - 11}" data-sx="${x0 - 2}" data-ex="${x1}" data-w="${textW(clip(s.title)) + (dead ? 60 : 0)}">${esc(clip(s.title))}${dead ? ` <tspan class="t-axis" dx="4">${esc(t("回收站"))}</tspan>` : ""}</text>`);
        // 点按热区：比线粗得多的透明描边 + 标题那一块
        hits.push(`<line data-id="${esc(s.id)}" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="transparent" stroke-width="22"/><rect data-id="${esc(s.id)}" x="${x0 - 4}" y="${y - 26}" width="${Math.max(x1 - x0, textW(clip(s.title)) + 8)}" height="22" fill="transparent"/>`);
      }
      layer.main.innerHTML = `<svg width="${W}" height="${H}">${g.join("")}${lines.join("")}${labels.join("")}${hits.join("")}${sts.join("")}</svg>`;
      layer.axis.innerHTML = `<svg width="${W}" height="30">${ax.join("")}</svg>`;
      layer.band.innerHTML = L.bandY.map((b) => `<div style="top:${b.y + 4}px">${esc(bandName(b.key))}</div>`).join("");
      layer.card.innerHTML = sel ? card(sel) : "";
      st.sticky = layer.main.querySelectorAll ? [...layer.main.querySelectorAll("text[data-sx]")].map((el) => ({ el, sx: +el.dataset.sx, ex: +el.dataset.ex, w: +el.dataset.w, x: +el.dataset.sx })) : [];
      place();
    }

    // ── 卡片 ──
    function card(id) {
      const s = st.BY[id]; if (!s) return "";
      if (s.task) {
        return `<div class="lm-cardbox"><h3>${esc(s.title)}</h3><div class="meta"><span>${esc(t("定时任务"))}</span><span>${esc(t("{n} 次", { n: s.task.runs.length }))}</span></div>
          <ol>${[...s.task.runs].reverse().map((r) => `<li data-act="open" data-arg="${esc(r.id)}"><i>${esc(r.id.slice(0, 4))}</i><span>${esc(md(r.ts) + " " + hm(r.ts))}</span></li>`).join("")}</ol></div>`;
      }
      const cuts = [s.from, ...s.ch.map((c) => c.at), s.to];
      const chs = [...s.ch, s.open].map((c, i) => ({ n: i + 1, t: c.t, ghost: c.ghost, from: cuts[i], to: cuts[i + 1], open: i === s.ch.length }));
      const src = [];
      const P = s.parent && st.model.sessions.find((x) => x.id === s.parent);
      if (P) src.push(fmt(s.kind === "rewind" ? t("从「{t}」回退") : t("从「{t}」分叉"), { t: `<b>${esc(P.title.slice(0, 20))}</b>` }));
      else if (s.missingParent) src.push(esc(t("源自已删除的会话")));
      const nm = (x) => { const o = st.model.sessions.find((y) => y.id === x); return o ? `<b>${esc(o.title.slice(0, 16))}</b>` : ""; };
      if ((s.extra || []).length) src.push(fmt(t("汇合自 {list}"), { list: s.extra.map((e) => nm(e.id)).filter(Boolean).join("、") }));
      const early = (s.reads || []).filter((r) => r.early);
      if (early.length) src.push(fmt(t("接手自 {list}"), { list: early.map((e) => nm(e.id)).filter(Boolean).join("、") }));
      const kids = st.model.sessions.filter((k) => k.parent === id).length;
      if (kids) src.push(fmt(t("分出 {n} 个会话"), { n: `<b>${kids}</b>` }));
      const acts = (opts.acts ? opts.acts(s) : []).map((a) => `<button type="button" data-act="${esc(a.act)}" class="${a.pri ? "pri" : ""}${a.off ? " off" : ""}" ${a.title ? `title="${esc(a.title)}"` : ""}>${esc(a.label)}</button>`).join("");
      return `<div class="lm-cardbox"><h3 class="${s.ghost ? "ghost" : ""}">${esc(s.title)}</h3>
        <div class="meta"><span class="no">${esc(s.short)}·${chs.length}</span><span>${esc(range(s.from, s.to))}</span>${chs.length > 1 ? `<span>${esc(t("{n} 章", { n: chs.length }))}</span>` : ""}${s.meta && s.meta.size ? `<span>${esc(s.meta.size)}</span>` : ""}</div>
        ${src.length ? `<div class="src">${src.join(" · ")}</div>` : ""}
        <ol>${chs.reverse().map((c) => `<li class="${c.open ? "cur" : ""}${c.ghost ? " ghost" : ""}" data-act="chapter" data-arg="${c.n}"><i>${esc(s.short)}·${c.n}</i><span>${esc(c.t || "")}</span><small>${esc(c.open && s.running ? t("进行中") : range(c.from, c.to))}</small></li>`).join("")}</ol>
        ${acts ? `<div class="acts">${acts}</div>` : ""}</div>`;
    }

    // ── 平移 ──
    function bounds() {
      const cw = cv.clientWidth, ch = cv.clientHeight;
      return { minX: Math.min(0, cw - st.W), maxX: 0, minY: Math.min(0, ch - st.H), maxY: 0 };
    }
    function place() {
      layer.main.style.transform = `translate(${st.tx}px,${st.ty}px)`;
      layer.axis.style.transform = `translateX(${st.tx}px)`;
      layer.band.style.transform = `translateY(${st.ty}px)`;
      // 标题吸附：线的起点拖出了左边，标题贴着左边（让过带名）跟着走，到线尾为止 —— 跨好几周的长会话一打开也认得出是谁
      for (const L of st.sticky || []) {
        let x = Math.max(L.sx, -st.tx + 132);
        if (x + L.w > L.ex) x = Math.max(L.sx, L.ex - L.w);
        if (x !== L.x) { L.x = x; L.el.setAttribute("x", x); }
      }
      const xn = st.AX ? st.AX.X(st.model.now) + st.tx : 0;
      layer.now.classList.toggle("show", !!st.AX && (xn < 40 || xn > cv.clientWidth - 10));
    }
    const nowX = () => Math.min(0, Math.max(cv.clientWidth - st.W, cv.clientWidth - 160 - st.AX.X(st.model.now)));
    function animateTo(tx, ty) {
      const x0 = st.tx, y0 = st.ty, t0 = performance.now();
      cancelAnimationFrame(st.raf);
      const step = (now) => { const p = Math.min(1, (now - t0) / 260), e = 1 - Math.pow(1 - p, 3); st.tx = x0 + (tx - x0) * e; st.ty = y0 + (ty - y0) * e; place(); if (p < 1) st.raf = requestAnimationFrame(step); };
      st.raf = requestAnimationFrame(step);
    }
    function settle() { const b = bounds(); animateTo(Math.min(b.maxX, Math.max(b.minX, st.tx)), Math.min(b.maxY, Math.max(b.minY, st.ty))); }
    const gesture = (k) => { if (opts.onGesture) opts.onGesture(k); };
    function home() { st.k = 1; paint(); animateTo(nowX(), 0); gesture("home"); }

    // 选中某个会话：画亮一家子，并把它挪进视野（从外面跳进来时用）
    function reveal(id) {
      const P = st.L && st.L.pos[id], s = st.BY[id]; if (!P || !s) return;
      const cw = cv.clientWidth, chh = cv.clientHeight, b = bounds();
      const x = st.AX.X(s.task ? endOf(s) : s.to), y = P.y;
      const tx = x + st.tx > cw - 360 || x + st.tx < LEFT ? cw - 380 - x : st.tx;
      const ty = y + st.ty > chh - 220 || y + st.ty < 60 ? chh / 3 - y : st.ty;
      animateTo(Math.min(b.maxX, Math.max(b.minX, tx)), Math.min(b.maxY, Math.max(b.minY, ty)));
    }

    // ── 手势 ──
    const pts = new Map();
    let drag = null, pinch = null, lastTap = 0, pinchRaf = 0;
    const rubber = (v, lo, hi) => (v > hi ? hi + (v - hi) * 0.35 : v < lo ? lo + (v - lo) * 0.35 : v);
    const stop = (e) => e.stopPropagation();
    layer.card.addEventListener("pointerdown", stop);
    layer.now.addEventListener("pointerdown", stop);
    layer.now.addEventListener("click", home);
    layer.card.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b || b.classList.contains("off")) return;
      opts.onAct && opts.onAct(b.dataset.act, b.dataset.arg || st.sel, b, st.sel);
    });
    cv.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch {}
      cancelAnimationFrame(st.raf);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: 0, vx: 0, vy: 0, lt: performance.now(), lx: e.clientX, ly: e.clientY, target: e.target };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], r = cv.getBoundingClientRect(), mid = (a.x + b.x) / 2 - r.left;
        pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), k0: st.k, base: (mid - st.tx - LEFT) / st.k, mid };
        drag = null;
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        // 双指只缩时间：重画按帧合并，免得会话多时每个 move 都整张重建
        if (pinchRaf) return;
        pinchRaf = requestAnimationFrame(() => {
          pinchRaf = 0; if (!pinch) return;
          const [a, b] = [...pts.values()];
          st.k = Math.min(3, Math.max(0.45, pinch.k0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
          paint();
          const bd = bounds();
          st.tx = Math.min(bd.maxX, Math.max(bd.minX, pinch.mid - (LEFT + st.k * pinch.base)));
          place();
        });
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, b = bounds(), now = performance.now();
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      drag.vx = (e.clientX - drag.lx) / Math.max(1, now - drag.lt); drag.vy = (e.clientY - drag.ly) / Math.max(1, now - drag.lt);
      drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
      st.tx = rubber(drag.tx + dx, b.minX, b.maxX); st.ty = rubber(drag.ty + dy, b.minY, b.maxY); place();
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) { pinch = null; gesture("zoom"); } return; }
      if (!drag) return;
      const d = drag; drag = null;
      if (e.type === "pointercancel") return settle();
      if (d.moved < 6) {
        const now = performance.now();
        if (now - lastTap < 300) { lastTap = 0; return home(); }
        lastTap = now;
        const stn = d.target.closest && d.target.closest("[data-st]");
        if (stn && opts.onAct) { lastTap = 0; return opts.onAct("chapter", stn.getAttribute("data-n"), stn, stn.getAttribute("data-st")); }
        const hit = d.target.closest && d.target.closest("[data-id]");
        select(hit ? hit.getAttribute("data-id") : null);
        return;
      }
      gesture("pan");
      // 惯性：按松手时的速度滑出去、逐帧减速；过了边就弹回
      if (performance.now() - d.lt > 80) return settle();   // 停住了再松手：不甩
      let vx = d.vx * 16, vy = d.vy * 16;
      const step = () => {
        const b = bounds();
        st.tx += vx; st.ty += vy; vx *= 0.92; vy *= 0.92;
        if (st.tx > b.maxX || st.tx < b.minX) vx *= 0.5;
        if (st.ty > b.maxY || st.ty < b.minY) vy *= 0.5;
        place();
        if (Math.abs(vx) > 0.3 || Math.abs(vy) > 0.3) st.raf = requestAnimationFrame(step); else settle();
      };
      st.raf = requestAnimationFrame(step);
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    // 鼠标 / 触控板：滚轮平移，按住 Ctrl 缩放时间
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = cv.getBoundingClientRect(), mid = e.clientX - r.left, base = (mid - st.tx - LEFT) / st.k;
        st.k = Math.min(3, Math.max(0.45, st.k * Math.exp(-e.deltaY / 300)));
        paint(); st.tx = mid - (LEFT + st.k * base);
        gesture("zoom");
      } else { st.tx -= e.shiftKey ? e.deltaY : e.deltaX; st.ty -= e.shiftKey ? 0 : e.deltaY; gesture("pan"); }
      const b = bounds(); st.tx = Math.min(b.maxX, Math.max(b.minX, st.tx)); st.ty = Math.min(b.maxY, Math.max(b.minY, st.ty)); place();
    }, { passive: false });

    // ── 手机：缩进树（行样式同会话页），只竖滚 ──
    function paintTree() {
      const V = st.vis, BY = st.BY;
      const kids = {}; V.forEach((s) => { if (s.parent && BY[s.parent]) (kids[s.parent] = kids[s.parent] || []).push(s.id); });
      const last = (s) => Math.max(endOf(s), ...(kids[s.id] || []).map((k) => last(BY[k])));
      const rows = [];
      for (const b of st.model.bands || []) {
        const roots = V.filter((s) => s.band === b.key && !(s.parent && BY[s.parent])).sort((x, y) => last(y) - last(x));
        if (!roots.length) continue;
        rows.push({ grp: b.name });
        const walk = (s, depth, isLast, rails) => {
          rows.push({ s, depth, isLast, rails });
          const ks = (kids[s.id] || []).map((k) => BY[k]).sort((x, y) => y.from - x.from);
          ks.forEach((k, i) => walk(k, depth + 1, i === ks.length - 1, [...rails, !isLast && depth > 0]));
        };
        roots.forEach((r) => walk(r, 0, true, []));
      }
      const IND = 18, G0 = 16, TR = "var(--lm-track)";
      tree.innerHTML = rows.map((r) => {
        if (r.grp) return `<div class="lm-grp">${esc(r.grp)}</div>`;
        const s = r.s, gw = G0 + r.depth * IND + 14, cx = G0 + r.depth * IND + 4;
        let svg = "";
        if (r.depth) {
          const px = cx - IND;
          svg += `<path d="M${px} 0 L${px} 18 Q${px} 29 ${px + 11} 29 L${cx - 5} 29" fill="none" stroke="${TR}" stroke-width="1.6" ${s.trashed ? 'stroke-dasharray="3 3"' : ""}/>`;
          if (!r.isLast) svg += `<line x1="${px}" y1="29" x2="${px}" y2="80" stroke="${TR}" stroke-width="1.6"/>`;
        }
        r.rails.forEach((on, i) => { if (on) svg += `<line x1="${G0 + i * IND + 4}" y1="0" x2="${G0 + i * IND + 4}" y2="80" stroke="${TR}" stroke-width="1.6"/>`; });
        if (kids[s.id]) svg += `<line x1="${cx}" y1="29" x2="${cx}" y2="80" stroke="${TR}" stroke-width="1.6"/>`;
        svg += s.task ? `<circle cx="${cx}" cy="29" r="3.4" fill="none" stroke="var(--fg3)" stroke-width="1.5" stroke-dasharray="2 2"/>`
          : s.running ? `<circle cx="${cx}" cy="29" r="4" class="lm-run"/>` : `<circle cx="${cx}" cy="29" r="${s.trashed ? 3 : 3.6}" fill="${s.trashed ? "none" : "var(--fg2)"}" stroke="var(--fg3)" stroke-width="${s.trashed ? 1.4 : 0}"/>`;
        const n = s.task ? 0 : s.ch.length + 1;
        let meta = s.task ? `<span>${esc(t("定时任务"))}</span><span>${esc(t("{n} 次", { n: s.task.runs.length }))}</span>`
          : `<span class="no">${esc(s.short)}·${n}</span><span>${esc(range(s.from, s.to))}</span>${n > 1 ? `<span>${esc(t("{n} 章", { n }))}</span>` : ""}`;
        const src = [...(s.extra || []), ...(s.reads || []).filter((x) => x.early)].map((e) => BY[e.id]).filter(Boolean);
        if (src.length) meta += `<span>← ${src.map((o) => esc(o.title.slice(0, 6))).join("、")}</span>`;
        if (s.trashed) meta = `<span>${esc(t("回收站"))}</span><span>${esc(range(s.from, s.to))}</span>`;
        return `<div class="lm-trow${s.trashed || s.ghost ? " ghost" : ""}${s.id === st.sel ? " sel" : ""}" data-id="${esc(s.id)}"><div class="gut" style="width:${gw}px"><svg width="${gw}" height="80">${svg}</svg></div>
          <div class="main"><div class="tt">${esc(s.title)}</div><div class="mm">${meta}</div></div></div>`;
      }).join("") || `<div class="lm-empty">${esc(t("还没有会话"))}</div>`;
    }
    tree.addEventListener("click", (e) => {
      const r = e.target.closest("[data-id]"); if (!r) return;
      const id = r.getAttribute("data-id");
      // 手机上没有卡片：点一行选中，并交给外面弹菜单（App 里是会话的脉络弹层）
      select(id);
      opts.onAct && opts.onAct("tree", id, r, id);
    });

    // ── 尺寸：宽度跨过 600 换形态；视口变了重新夹边界 ──
    function relayout() {
      if (!st.model) return;
      const w = root.clientWidth; if (!w) return;
      const mode = w < PHONE ? "tree" : "map";
      root.classList.toggle("tree", mode === "tree");
      if (mode !== st.mode) { st.mode = mode; st.placed = false; }
      if (mode === "tree") return paintTree();
      paint();
      if (!st.placed) { st.placed = true; st.tx = nowX(); st.ty = 0; place(); }
      else { const b = bounds(); st.tx = Math.min(b.maxX, Math.max(b.minX, st.tx)); st.ty = Math.min(b.maxY, Math.max(b.minY, st.ty)); place(); }
    }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => relayout()) : null;
    if (ro) ro.observe(root);

    function select(id, opt = {}) {
      if (id && !st.BY[id]) id = null;
      const prev = st.sel;
      st.sel = id;
      if (st.mode === "tree") paintTree(); else if (st.model) paint();
      // 动效：其余线退暗、卡片弹上来、逐章题名浮出（html[data-motion=on] 才有样式）
      if (id && id !== prev && document.documentElement.dataset.motion === "on") {
        root.classList.remove("mo-pick"); void root.offsetWidth; root.classList.add("mo-pick");
        clearTimeout(st.moT); st.moT = setTimeout(() => root.classList.remove("mo-pick"), 1200);
      }
      if (id && opt.reveal && st.mode === "map") reveal(id);
      opts.onSelect && opts.onSelect(id);
    }

    return {
      set(model, o = {}) {
        st.model = model;
        if ("misc" in o) st.misc = !!o.misc;
        if ("band" in o) st.band = o.band || null;
        if (o.home) st.placed = false;
        filter(); relayout();
      },
      select,
      home,
      state: () => ({ sel: st.sel, k: st.k, tx: st.tx, ty: st.ty, mode: st.mode, W: st.W, H: st.H, n: st.vis.length }),
      destroy() { if (ro) ro.disconnect(); cancelAnimationFrame(st.raf); root.innerHTML = ""; root.classList.remove("lmap", "tree"); },
    };
  }

  window.CCLineageMap = { create };
})();

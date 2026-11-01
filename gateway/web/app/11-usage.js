  // ── 使用统计：网关按 UTC 小时记，这里按本地时区汇总成日 / 周 / 月；月报画在 canvas 上，看到的就是导出的 ──
  const us = { raw: null, days: new Map(), month: null, busy: false };
  const usDayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const usMonthKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const usNum = (n) => Number(n || 0).toLocaleString(I18N.lang);
  const usCompact = (n) => { try { return new Intl.NumberFormat(I18N.lang, { notation: "compact", maximumFractionDigits: 1 }).format(n || 0); } catch { return usNum(n); } };
  function usEmpty() { return { m: 0, t: 0, tl: 0, i: 0, o: 0, c: 0, s: new Set(), md: {}, mt: {}, st: {}, hr: new Array(24).fill(0) }; }
  function usMerge(a, b, hour) {
    for (const k of ["m", "t", "tl", "i", "o", "c"]) a[k] += b[k] || 0;
    for (const x of b.s || []) a.s.add(x);
    for (const f of ["md", "mt", "st"]) for (const [k, v] of Object.entries(b[f] || {})) a[f][k] = (a[f][k] || 0) + v;
    if (hour != null) a.hr[hour] += b.m || 0; else if (b.hr) b.hr.forEach((v, i) => { a.hr[i] += v; });
    return a;
  }
  function usBuild() {
    us.days = new Map();
    for (const [k, b] of Object.entries(us.raw.hours || {})) {
      const d = new Date(+k * 3600e3), key = usDayKey(d);
      if (!us.days.has(key)) us.days.set(key, usEmpty());
      usMerge(us.days.get(key), b, d.getHours());
    }
  }
  /** [a, b) 两个本地日期之间的合计 */
  function usSum(a, b) {
    const out = usEmpty();
    for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) { const x = us.days.get(usDayKey(d)); if (x) usMerge(out, x); }
    return out;
  }
  const usDay0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const usAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const usWeek0 = (d) => { const x = usDay0(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // 周一起算
  const usMonth0 = (y, m) => new Date(y, m, 1);
  const usMonthName = (y, m) => new Date(y, m, 1).toLocaleDateString(I18N.lang, { year: "numeric", month: "long" });

  /** 一个月的全部数字：月报和下面的按钮都用它 */
  function usMonthStats(y, m) {
    const a = usMonth0(y, m), b = usMonth0(y, m + 1), today = usDay0(new Date());
    const tot = usSum(a, b), prev = usSum(usMonth0(y, m - 1), a);
    const cal = [];
    let streak = 0, best = 0, active = 0, top = null;
    for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) {
      const x = us.days.get(usDayKey(d)), n = x ? x.m : 0;
      cal.push({ date: new Date(d), n, future: d > today });
      if (n) { active++; streak++; best = Math.max(best, streak); if (!top || n > top.n) top = { date: new Date(d), n }; } else streak = 0;
    }
    const peak = tot.hr.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
    const models = Object.entries(tot.md).sort((p, q) => q[1] - p[1]);
    const days = Math.round((b - a) / 86400e3);
    return { y, m, tot, prev, cal, active, best, top, peak, models, days };
  }

  // 月报的配色跟着当前外观走（原生 / 求索 × 深 / 浅）：取 style.css 的变量，透明度另算
  function usPalette() {
    const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
    const probe = document.createElement("canvas").getContext("2d");
    const rgb = (col) => {
      probe.fillStyle = "#000"; probe.fillStyle = col;
      const x = probe.fillStyle;                       // 规范成 #rrggbb 或 rgba(r, g, b, a)
      return x[0] === "#" ? [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)) : x.match(/[\d.]+/g).slice(0, 3).map(Number);
    };
    const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const bg = rgb(v("--bg")), bg2 = rgb(v("--bg2")), fg = rgb(v("--fg")), acc = rgb(v("--accent"));
    const dark = lum(bg) < 0.5;
    const a = (c, al) => `rgba(${c[0]},${c[1]},${c[2]},${al})`;
    const mix = (c, d, k) => `rgb(${c.map((x, i) => Math.round(x + (d[i] - x) * k)).join(",")})`;
    return {
      dark, BG0: a(dark ? bg2 : bg, 1), BG1: a(dark ? bg : bg2, 1),
      ACC: a(acc, 1), ACC2: dark ? mix(acc, [255, 255, 255], 0.3) : mix(acc, [0, 0, 0], 0.15), acc: (al) => a(acc, al),
      FG: a(fg, 1), FG2: v("--fg2"), FG3: v("--fg3"), fg: (al) => a(fg, al),
      UP: v("--ok"), DOWN: v("--err"), ON: a(bg, 1),     // ON：铺满强调色的格子上的字（深色外观是深字、浅色外观是白字）
    };
  }

  // 画月报：宽 1080，配色随当前外观（见 usPalette）
  function usDraw(cv, st, who) {
    const K = usPalette();
    const W = 1080, P = 72, ACC = K.ACC, FG = K.FG, FG2 = K.FG2, FG3 = K.FG3, TILE = K.fg(K.dark ? 0.055 : 0.05);
    const font = (w, px) => `${w} ${px}px system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif`;
    const calRows = Math.ceil((((st.cal[0].date.getDay() + 6) % 7) + st.cal.length) / 7);
    const cell = Math.floor((W - 2 * P - 6 * 14) / 7), calH = 52 + calRows * (cell + 14);
    const mdRows = Math.min(st.models.length, 4);
    const H = 880 + calH + 70 + 300 + (mdRows ? 90 + mdRows * 64 : 0) + 110;   // 与下面逐段累加的 y 一致
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const rr = (x, y, w, h, r) => { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); };
    const text = (s, x, y, f, col, align) => { c.font = f; c.fillStyle = col; c.textAlign = align || "left"; c.fillText(s, x, y); };
    // 底色 + 右上角一团强调色的光
    const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, K.BG0); bg.addColorStop(1, K.BG1);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    const glow = c.createRadialGradient(W - 120, 60, 0, W - 120, 60, 560); glow.addColorStop(0, K.acc(K.dark ? 0.3 : 0.16)); glow.addColorStop(1, K.acc(0));
    c.fillStyle = glow; c.fillRect(0, 0, W, H);
    c.textBaseline = "alphabetic";
    let y = P + 34;
    text("cccodroid · " + t("使用月报"), P, y, font(500, 30), FG2);
    // 导出才有：右上角 头像 + 昵称（和标题同一行）
    if (who) {
      const R0 = 34, cx = W - P - R0, cy = y - 11;
      c.save(); c.beginPath(); c.arc(cx, cy, R0, 0, Math.PI * 2); c.closePath();
      if (who.img) { c.clip(); c.drawImage(who.img, cx - R0, cy - R0, R0 * 2, R0 * 2); }
      else { c.fillStyle = ACC; c.fill(); c.restore(); c.save(); text((who.name.trim()[0] || "C").toUpperCase(), cx, cy + 12, font(600, 32), K.ON, "center"); }
      c.restore();
      c.font = font(600, 30); let nm = who.name; while (c.measureText(nm).width > 360 && nm.length > 2) nm = nm.slice(0, -2) + "…";
      text(nm, cx - R0 - 18, y, font(600, 30), FG, "right");
    }
    y += 92; text(usMonthName(st.y, st.m), P, y, font(700, 76), FG);
    // 主数字
    y += 190;
    c.font = font(800, 168); const nw = c.measureText(usNum(st.tot.m)).width;
    const hero = c.createLinearGradient(P, y - 150, P + nw, y); hero.addColorStop(0, K.ACC2); hero.addColorStop(1, ACC);
    c.fillStyle = hero; c.textAlign = "left"; c.fillText(usNum(st.tot.m), P - 6, y);
    text(t("次对话"), P + nw + 20, y - 12, font(600, 44), FG);
    const dp = st.prev.m ? Math.round(((st.tot.m - st.prev.m) / st.prev.m) * 100) : null;
    y += 62;
    text(dp == null ? t("和 Claude 一起度过的这个月") : t("比上月 {p}", { p: (dp >= 0 ? "+" : "") + dp + "%" }), P, y, font(500, 32), dp == null ? FG2 : dp >= 0 ? K.UP : K.DOWN);
    // 六格数字
    y += 50;
    const tiles = [
      [t("活跃天数"), t("{n} / {d} 天", { n: st.active, d: st.days })],
      [t("会话"), t("{n} 个", { n: usNum(st.tot.s.size) })],
      [t("最长连续"), t("{n} 天", { n: st.best })],
      [st.top ? t("最忙的一天 · {n} 次", { n: usNum(st.top.n) }) : t("最忙的一天"), st.top ? st.top.date.toLocaleDateString(I18N.lang, { month: "short", day: "numeric" }) : "—"],
      [t("工具调用"), t("{n} 次", { n: usCompact(st.tot.tl) })],
      [t("Claude 写了"), usCompact(st.tot.o) + " token"],
    ];
    const tw = (W - 2 * P - 2 * 24) / 3;
    tiles.forEach(([k, v], i) => {
      const x = P + (i % 3) * (tw + 24), ty = y + Math.floor(i / 3) * 170;
      c.fillStyle = TILE; rr(x, ty, tw, 146, 26); c.fill();
      text(k, x + 28, ty + 52, font(500, 26), FG3);
      c.font = font(700, 40); let s = v; while (c.measureText(s).width > tw - 56 && s.length > 2) s = s.slice(0, -2) + "…";
      text(s, x + 28, ty + 110, font(700, 40), FG);
    });
    y += 2 * 170 + 40;
    // 日历热力图：颜色按本月最多那天分五档
    text(t("每天"), P, y + 10, font(600, 30), FG);
    const wk = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(I18N.lang, { weekday: "narrow" }));
    const max = Math.max(1, ...st.cal.map((x) => x.n));
    wk.forEach((w, i) => text(w, P + i * (cell + 14) + cell / 2, y + 58, font(500, 22), FG3, "center"));
    const lv = [K.fg(0.06), K.acc(0.28), K.acc(0.48), K.acc(0.7), K.acc(0.9), K.ACC2];
    const today = usDayKey(new Date());
    st.cal.forEach((d, i) => {
      const k = i + ((st.cal[0].date.getDay() + 6) % 7), x = P + (k % 7) * (cell + 14), cy = y + 76 + Math.floor(k / 7) * (cell + 14);
      const l = d.n ? Math.min(5, 1 + Math.floor((d.n / max) * 4.999)) : 0;
      c.fillStyle = d.future ? K.fg(0.025) : lv[l]; rr(x, cy, cell, cell, 18); c.fill();
      if (usDayKey(d.date) === today) { c.strokeStyle = FG; c.lineWidth = 3; rr(x + 1.5, cy + 1.5, cell - 3, cell - 3, 17); c.stroke(); }
      text(String(d.date.getDate()), x + 16, cy + 34, font(600, 22), l >= 4 ? K.ON : d.future ? FG3 : FG2);
      if (d.n) text(usNum(d.n), x + cell - 16, cy + cell - 18, font(700, 28), l >= 4 ? K.ON : FG, "right");
    });
    y += calH + 70;
    // 24 小时分布
    const hmax = Math.max(1, ...st.tot.hr);
    text(t("一天里什么时候聊"), P, y, font(600, 30), FG);
    if (st.tot.m) text(t("最常在 {h} 点前后", { h: st.peak }), W - P, y, font(500, 26), ACC, "right");
    const bw = (W - 2 * P) / 24, by = y + 200;
    st.tot.hr.forEach((v, i) => {
      const h = Math.max(4, (v / hmax) * 150);
      c.fillStyle = v === hmax && v ? ACC : v ? K.acc(0.45) : K.fg(0.07);
      rr(P + i * bw + 4, by - h, bw - 8, h, 6); c.fill();
      if (i % 6 === 0) text(String(i).padStart(2, "0"), P + i * bw + bw / 2, by + 40, font(500, 22), FG3, "center");
    });
    y += 300;
    // 模型
    if (mdRows) {
      text(t("用得最多的模型"), P, y, font(600, 30), FG);
      const sum = st.models.reduce((a, [, v]) => a + v, 0);
      st.models.slice(0, 4).forEach(([name, v], i) => {
        const ry = y + 50 + i * 64, pct = v / sum;
        text(name.replace(/^claude-/, "").replace(/-\d{8}$/, ""), P, ry + 30, font(500, 28), FG2);
        c.fillStyle = K.fg(0.07); rr(P + 420, ry + 8, W - 2 * P - 420 - 110, 26, 13); c.fill();
        c.fillStyle = i ? K.acc(0.55) : ACC; rr(P + 420, ry + 8, Math.max(26, (W - 2 * P - 420 - 110) * pct), 26, 13); c.fill();
        text(pct < 0.01 ? "<1%" : Math.round(pct * 100) + "%", W - P, ry + 32, font(600, 28), FG, "right");
      });
      y += 90 + mdRows * 64;
    }
    // 页脚
    c.fillStyle = K.fg(0.08); c.fillRect(P, y, W - 2 * P, 2);
    text(t("{t} 轮回复 · 读了 {i} token", { t: usNum(st.tot.t), i: usCompact(st.tot.i) }), P, y + 56, font(500, 24), FG3);
    text("cccodroid.net", W - P, y + 56, font(600, 24), FG2, "right");
  }

  // 换外观时重画月报（theme.js 只改 html 的 data-theme / data-skin，不发事件）
  new MutationObserver(() => { if (us.raw && $("us-card")) usRender(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });

  function usRender() {
    // 还没读回来：月份标签说明在等/失败了，翻月和保存分享先灰掉，别看着能点、点了没反应（审查 F-009）
    const idle = !us.raw;
    for (const b of [$("us-prev"), $("us-next"), ...$("us-actions").querySelectorAll("button")]) b.disabled = idle;
    $("us-off").disabled = idle;
    if (idle) { $("us-mlabel").textContent = us.err ? t("读取失败") : t("加载中…"); return; }
    const now = new Date(), d0 = usDay0(now), w0 = usWeek0(now), m0 = usMonth0(now.getFullYear(), now.getMonth());
    const tile = (label, cur, prev, prevLabel) => `<div class="us-tile"><div class="us-n">${usNum(cur.m)}</div><div class="us-l">${esc(label)}</div>
      <div class="us-sub">${esc(t("{p}：{n}", { p: prevLabel, n: usNum(prev.m) }))}</div></div>`;
    $("us-tiles").innerHTML = tile(t("今天"), usSum(d0, usAddDays(d0, 1)), usSum(usAddDays(d0, -1), d0), t("昨天"))
      + tile(t("本周"), usSum(w0, usAddDays(w0, 7)), usSum(usAddDays(w0, -7), w0), t("上周"))
      + tile(t("本月"), usSum(m0, usMonth0(now.getFullYear(), now.getMonth() + 1)), usSum(usMonth0(now.getFullYear(), now.getMonth() - 1), m0), t("上月"));
    // 近 12 个月的小柱子，点一下切到那个月
    const months = Array.from({ length: 12 }, (_, i) => { const d = usMonth0(now.getFullYear(), now.getMonth() - 11 + i); return { y: d.getFullYear(), m: d.getMonth(), n: usSum(d, usMonth0(d.getFullYear(), d.getMonth() + 1)).m }; });
    const mx = Math.max(1, ...months.map((x) => x.n));
    const [sy, sm] = us.month;
    $("us-year").innerHTML = months.map((x) => `<button class="us-mb ${x.y === sy && x.m === sm ? "on" : ""}" data-ym="${x.y}-${x.m}" title="${esc(usMonthName(x.y, x.m) + " · " + usNum(x.n))}">
      <i style="height:${Math.max(x.n ? 8 : 3, Math.round((x.n / mx) * 100))}%"></i><span>${x.m + 1}</span></button>`).join("");
    const st = usMonthStats(sy, sm);
    $("us-mlabel").textContent = usMonthName(sy, sm);
    $("us-next").disabled = sy > now.getFullYear() || (sy === now.getFullYear() && sm >= now.getMonth());
    usDraw($("us-card"), st);
    const r = us.raw;
    $("us-note").textContent = [
      r.off ? t("已暂停记录。") : t("从 {d} 起实时记录。", { d: new Date(r.since).toLocaleDateString(I18N.lang) }),
      r.imported ? t("更早的部分是从历史会话补算的（删掉的会话补不回来）。") : "",
      t("只记次数和用量，不记对话内容；数据只存在本机。"),
    ].filter(Boolean).join(" ");
    $("us-off").checked = !r.off;
    $("us-share").classList.toggle("hidden", !canShare() && !navigator.canShare);
  }
  // ── 用量看板（照设计稿）：数字一排 / 14 天柱状图 / 型号占比 / 最费的对话 / 今天耗电 ──
  // token 数一律 1.24M / 380k 这种写法（照稿；中文的「亿 / 万」在图上反而难对齐）
  const usTok = (n) => { try { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: n >= 1e6 ? 2 : 1 }).format(n || 0); } catch { return String(n || 0); } };
  const usDash = { view: "chart", quota: null, energy: null };
  const MODEL_COLORS = ["#c96442", "#2f6aa8", "#d6a84a"];      // 按出现顺序固定分配；第 4 个起并进「其他」
  function usPaint() {
    const now = new Date(), d0 = usDay0(now), m0 = usMonth0(now.getFullYear(), now.getMonth());
    const today = us.raw ? usSum(d0, usAddDays(d0, 1)) : usEmpty(), month = us.raw ? usSum(m0, usAddDays(d0, 1)) : usEmpty();
    // 数字一排：额度（官方账户才有）、今天、本月、缓存命中
    const q = usDash.quota, kpi = [];
    if (q) {
      const pct = Math.round(Math.max(0, Math.min(100, q.used)));
      const left = q.resetsAt ? q.resetsAt * 1000 - Date.now() : 0, gone = 1 - Math.max(0, Math.min(1, left / (7 * 86400e3)));
      const pace = !q.resetsAt ? "" : pct <= gone * 100 + 5 ? t("按现在的速度够用") : t("照这个速度会提前用完");
      const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
      const reset = at ? t("{time} 重置", { time: at.toLocaleDateString(I18N.lang, { weekday: "short" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
      kpi.push(`<div class="tile big${pct >= 90 ? " hot" : pct >= 70 ? " warm" : ""}"><span class="k">${esc(t("本周额度 · 官方账户"))}</span><span class="n num">${pct}%</span>
        <div class="bar-mini"><i style="width:${pct}%"></i></div><span class="k">${esc([reset, pace].filter(Boolean).join(" · "))}</span></div>`);
    }
    // 没读成过：说读取失败、给重试，别把 0 当成真数字（审查 F-006）
    if (!us.raw && us.err) kpi.push(`<div class="tile big"><span class="k">${esc(t("用量读取失败：{msg}", { msg: us.err }))}</span><button class="btn sm ghost" id="us-retry">${esc(t("重试"))}</button></div>`);
    else {
    // 读成过、这次刷新失败：数照旧摆着，但要说明是上次的，并给重试（审查 F-006 复测）
    if (us.err) kpi.push(`<div class="tile big"><span class="k">${esc(t("刷新失败，显示的是上次读到的数：{msg}", { msg: us.err }))}</span><button class="btn sm ghost" id="us-retry">${esc(t("重试"))}</button></div>`);
    kpi.push(`<div class="tile"><span class="k">${esc(t("今天"))}</span><span class="n num">${usTok(today.i + today.o)}</span><span class="k">${esc(t("tokens · {n} 轮对话", { n: usNum(today.t) }))}</span></div>`);
    kpi.push(`<div class="tile"><span class="k">${esc(t("本月"))}</span><span class="n num">${usTok(month.i + month.o)}</span><span class="k">${esc(t("tokens · {n} 个会话", { n: usNum(month.s.size) }))}</span></div>`);
    kpi.push(`<div class="tile"><span class="k">${esc(t("缓存命中"))}</span><span class="n num">${month.c && month.i ? Math.round((month.c / month.i) * 100) + "%" : "—"}</span><span class="k">${esc(t("本月 · 越高越省"))}</span></div>`);
    }
    $("us-kpis").innerHTML = kpi.join("");
    $("us-csv").disabled = !us.raw;
    const rt = $("us-retry"); if (rt) rt.onclick = () => { rt.disabled = true; loadUsage(); };
    setPageSub("usage", q ? t("本周额度 {p}%", { p: Math.round(q.used) }) : !us.raw && us.err ? t("读取失败") : t("今天 {n} tokens", { n: usTok(today.i + today.o) }));
    // 每天用量：最近 14 天，单序列（不要图例），今天那根用强调色
    const days = Array.from({ length: 14 }, (_, i) => { const d = usAddDays(d0, i - 13), x = us.days.get(usDayKey(d)); return { d, v: x ? x.i + x.o : 0, t: x ? x.t : 0 }; });
    const box = $("us-daily");
    if (usDash.view === "table") {
      box.innerHTML = `<table class="ctable"><tr><th>${esc(t("日期"))}</th><th>${esc(t("轮"))}</th><th>tokens</th></tr>${days.slice().reverse().map((x) =>
        `<tr><td>${x.d.toLocaleDateString(I18N.lang, { month: "2-digit", day: "2-digit" })}</td><td class="num">${x.t || "—"}</td><td class="num">${x.v ? usTok(x.v) : "—"}</td></tr>`).join("")}</table>`;
    } else {
      const W = 640, H = 180, pl = 38, pb = 22, pt = 8, bw = (W - pl) / days.length;
      const raw = Math.max(1, ...days.map((x) => x.v)), mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => raw / k <= 4) || mag * 10;
      const max = step * Math.ceil(raw / step), y = (v) => pt + (H - pt - pb) * (1 - v / max);
      let g = "";
      for (let v = 0; v <= max + 1e-9; v += step) g += `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pl - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${usTok(v)}</text>`;
      days.forEach((x, i) => {
        const bx = pl + i * bw + 3, w = bw - 6, top = y(x.v), h = Math.max(0, y(0) - top), r = Math.min(4, h, w / 2);
        if (h) g += `<path class="bar${i === days.length - 1 ? " today" : ""}" d="M${bx},${y(0)} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + w - r} Q${bx + w},${top} ${bx + w},${top + r} V${y(0)} Z"/>`;
        g += `<rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" data-tip="${esc(x.d.toLocaleDateString(I18N.lang, { month: "numeric", day: "numeric" }) + "：" + (x.v ? usTok(x.v) + " tokens · " + t("{n} 轮", { n: x.t }) : t("没用")))}"/>`;
        if (i % 2 === 1) g += `<text x="${bx + w / 2}" y="${H - 6}" class="ax" text-anchor="middle">${x.d.getDate()}</text>`;
      });
      box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg><div class="tip"></div>`;
    }
    // 按型号：本月 token 占比
    const mods = Object.entries(month.mt).sort((a, b) => b[1] - a[1]), msum = mods.reduce((a, [, v]) => a + v, 0);
    const parts = mods.slice(0, 3).map(([n, v], i) => [prettyModel(n), v, MODEL_COLORS[i]]);
    if (mods.length > 3) parts.push([t("其他"), mods.slice(3).reduce((a, [, v]) => a + v, 0), "#8b867a"]);
    $("us-models-card").classList.toggle("hidden", !msum);
    $("us-share-bar").innerHTML = parts.map(([n, v, c]) => `<i style="flex:${v};background:${c}" data-tip="${esc(n)}：${Math.round((v / msum) * 100)}%"></i>`).join("") + '<div class="tip"></div>';
    $("us-share-leg").innerHTML = parts.map(([n, v, c]) => `<span><b class="sw" style="background:${c}"></b>${esc(n)} <span class="num">${Math.max(1, Math.round((v / msum) * 100))}%</span></span>`).join("");
    // 最费的对话：本月按 token 排前 5
    const titleOf = (id) => ((state.sessions || []).find((x) => x.id === id) || {}).title;
    const top = Object.entries(month.st).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $("us-top").innerHTML = top.length ? top.map(([id, v], i) => `<div class="row" data-sid="${esc(id)}"><span class="rank num">${i + 1}</span><span class="grow t1">${esc(titleOf(id) || t("（已删除的会话）"))}</span><span class="num muted">${usTok(v)}</span></div>`).join("")
      : `<div class="row"><span class="tiny">${esc(us.raw && !us.raw.imported ? t("正在从历史会话补算…") : t("这个月还没有记录"))}</span></div>`;
    // 耗电：今天
    const e = usDash.energy, b = e && e.bars && e.bars[e.bars.length - 1];
    const k = (v, l) => `<div><span class="num">${v}</span><small>${esc(l)}</small></div>`;
    $("en-kpis").innerHTML = e ? (e.native ? k(b && b.d != null ? (Math.round(b.d * 10) / 10) + "%" : "—", t("电量")) + k(b && b.s ? fmtDur(b.s * 1000) : "—", t("亮屏")) : "")
      + k(b && b.c ? fmtDur(b.c * 1000) : "—", t("本应用 CPU")) : "";
    $("en-kpi-note").textContent = e ? (e.native ? t("电量是整机今天掉了多少；CPU 是本应用（含 Claude 和它跑的命令）实际干活的时间。") : t("这个版本没有原生层，只记 CPU 时间（电量、亮屏要 cccodroid）。")) : "";
  }
  $("us-view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    usDash.view = b.dataset.v; $("us-view").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); usPaint();
  });
  // 柱子、占比条：点或悬停出提示
  for (const id of ["us-daily", "us-share-bar"]) {
    const box = $(id);
    const show = (e) => {
      const tip = box.querySelector(".tip"), hit = e.target.closest("[data-tip]"); if (!tip) return;
      if (!hit) return tip.classList.remove("show");
      const br = box.getBoundingClientRect(), r = hit.getBoundingClientRect();
      tip.textContent = hit.dataset.tip; tip.classList.add("show");
      tip.style.left = Math.max(40, Math.min(br.width - 40, r.left + r.width / 2 - br.left)) + "px"; tip.style.top = (r.top - br.top - 6) + "px";
    };
    box.addEventListener("click", show); box.addEventListener("pointermove", show);
    box.addEventListener("pointerleave", () => box.querySelector(".tip")?.classList.remove("show"));
  }
  $("us-top").addEventListener("click", (e) => { const r = e.target.closest("[data-sid]"); if (r) openSession(r.dataset.sid); });
  $("en-more").addEventListener("click", () => { $("en-field").classList.toggle("hidden"); if (!$("en-field").classList.contains("hidden")) $("en-field").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("us-report-btn").addEventListener("click", () => { $("us-field").classList.toggle("hidden"); if (!$("us-field").classList.contains("hidden")) { usRender(); $("us-field").scrollIntoView({ behavior: "smooth", block: "start" }); } });
  $("us-csv").addEventListener("click", async () => {
    if (!us.raw) return;
    const keys = [...us.days.keys()].sort();
    const rows = [[t("日期"), t("消息"), t("回复轮数"), t("工具调用"), t("输入 tokens"), t("输出 tokens"), t("读缓存 tokens")].join(",")]
      .concat(keys.map((k) => { const x = us.days.get(k); return [k, x.m, x.t, x.tl, x.i, x.o, x.c].join(","); }));
    try {
      const r = await post("/api/usage/csv", { name: "cccodroid-usage-" + usDayKey(new Date()) + ".csv", text: rows.join("\n") });
      if (canSaveAs()) saveAs(r.file, "text/csv"); else toast(t("已保存：{name}", { name: r.file }));
    } catch (e) { toast(e.message, true); }
  });
  async function loadUsage() {
    try {
      us.raw = await api("/api/usage"); us.err = "";
      if (/^✗/.test($("us-result").textContent)) $("us-result").textContent = "";   // 恢复了：旧的失败提示别留着
      if (!us.month) { const n = new Date(); us.month = [n.getFullYear(), n.getMonth()]; }
      usBuild(); usPaint();
      if (!$("us-field").classList.contains("hidden")) usRender();
      // 第一次打开：把装这个版本之前的历史会话补算进来
      if (!us.raw.imported && !us.raw.importing && !us.busy) usImport(true);
    } catch (e) { us.err = e.message || "?"; $("us-result").textContent = "✗ " + e.message; usPaint(); if (!$("us-field").classList.contains("hidden")) usRender(); }
  }
  // 开着用量页时跟着刷新：token 现在是边跑边记的（gw/usage.mjs usageMeter），不用等这一轮结束、也不用退出重进。数没变就不重画
  setInterval(async () => {
    if (curPage !== "usage" || document.hidden || us.busy || !us.raw) return;
    let r; try { r = await api("/api/usage"); } catch { return; }
    if (curPage !== "usage" || JSON.stringify(r.hours) === JSON.stringify(us.raw.hours)) return;
    us.raw = r; usBuild(); usPaint();
    if (!$("us-field").classList.contains("hidden")) usRender();
  }, 20000);
  async function usImport(auto) {
    us.busy = true;
    $("us-result").textContent = t("正在从历史会话补算…");
    try {
      const r = await post("/api/usage/import", {});
      $("us-result").textContent = t("补算完成：{f} 个会话记录、{n} 条消息。", { f: r.files, n: usNum(r.prompts) });
      us.busy = false;
      if (!auto || r.prompts) loadUsage();
    } catch (e) { us.busy = false; $("us-result").textContent = "✗ " + e.message; }
  }
  $("us-year").addEventListener("click", (e) => {
    const b = e.target.closest(".us-mb");
    if (!b || !us.raw) return;
    us.month = b.dataset.ym.split("-").map(Number);
    usRender();
  });
  // 用量还没读回来时月份还没定：翻月先等一等，不然 null[0] 报脚本错误（审查 F-009）
  $("us-prev").addEventListener("click", () => { if (!us.month || !us.raw) return; const d = usMonth0(us.month[0], us.month[1] - 1); us.month = [d.getFullYear(), d.getMonth()]; usRender(); });
  $("us-next").addEventListener("click", () => { if (!us.month || !us.raw) return; const d = usMonth0(us.month[0], us.month[1] + 1); us.month = [d.getFullYear(), d.getMonth()]; usRender(); });
  $("us-off").addEventListener("change", async (e) => {
    try { await post("/api/usage/set", { off: !e.target.checked }); loadUsage(); } catch (err) { toast(err.message, true); }
  });
  // 月报图片：先交给网关落成文件，再走「保存到」/ 系统分享；都没有就让浏览器自己下载
  async function usCardFile() {
    const [y, m] = us.month, name = `cccodroid-usage-${y}-${String(m + 1).padStart(2, "0")}.png`;
    // 导出的图另画一张：多了右上角的头像与昵称
    const p = profile(), cv = document.createElement("canvas");
    let img = null;
    // 头像只认本地图（data:image）：外链进 canvas 一来画不出（跨源污染），二来等于替外站报到（11-01 独立审查）
    if (p.av && /^data:image\//.test(p.av)) { img = new Image(); img.src = p.av; try { await img.decode(); } catch { img = null; } }
    usDraw(cv, usMonthStats(y, m), { name: profName(), img });
    const data = cv.toDataURL("image/png");
    return { name, data, file: (await post("/api/usage/card", { name, data: data.split(",")[1] })).file };
  }
  $("us-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (!us.month || !us.raw) return;
    const [y, m] = us.month;
    try {
      if (act === "save") {
        const r = await usCardFile();
        if (canSaveAs()) return saveAs(r.file, "image/png");
        const a = document.createElement("a"); a.href = r.data; a.download = r.name; a.click();
      } else if (act === "share") {
        const r = await usCardFile();
        if (canShare()) {
          const j = await post("/api/app/share_file", { path: r.file, mime: "image/png" });
          if (!j.ok) toast(j.message || t("分享失败"), true);
        } else if (navigator.canShare) {
          const f = new File([await (await fetch(r.data)).blob()], r.name, { type: "image/png" });
          if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else toast(t("已保存：{name}", { name: r.file }));
        } else toast(t("已保存：{name}", { name: r.file }));
      } else if (act === "import") {
        if (confirm(t("按现存的会话记录重新补算 {d} 之前的统计？删掉的会话补不回来，那部分会变少。", { d: new Date(us.raw.since).toLocaleDateString(I18N.lang) }))) usImport(false);
      } else if (act === "clear-month") {
        if (!confirm(t("清除 {m} 的统计？", { m: usMonthName(y, m) }))) return;
        await post("/api/usage/clear", { from: usMonth0(y, m).getTime(), to: usMonth0(y, m + 1).getTime() });
        loadUsage();
      } else if (act === "clear-all") {
        if (!confirm(t("清空全部使用统计？之后从现在重新开始记。"))) return;
        await post("/api/usage/clear", { all: true });
        loadUsage();
      }
    } catch (err) { toast(err.message, true); }
  });

  async function loadEnergy() {
    api("/api/energy?view=day").then((d) => { usDash.energy = d; usPaint(); }).catch(() => {});
    // 快速切 小时 / 日 / 周：慢的那次迟到不许盖掉现在这一档（数据形状也不一样，会报类型错误）（审查 F-005）
    const ok = latest("energy"), v = en.view;
    try { const d = await api("/api/energy?view=" + v); if (!ok() || en.view !== v) return; d.view = v; en.data = d; en.sel = -1; enRender(); if (d.sys) enSys(d.sys); }
    catch (e) { if (ok()) $("en-cap").textContent = "✗ " + e.message; }
  }
  $("en-seg").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v || v === en.view) return;
    en.view = v;
    $("en-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
    loadEnergy();
  });
  // 点柱子看那一格的明细，再点一下（或点同一格）回到合计
  $("en-charts").addEventListener("click", (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i == null) return;
    en.sel = en.sel === +i ? -1 : +i;
    enRender();
  });
  function enSys(s) {
    const ago = fmtDur(s.sinceMs || 0), me = s.me;
    let h = `<div class="tiny" style="margin-top:6px">${esc(me
      ? t("系统估算（自上次充满，{ago}）：本应用约 {mah} mAh，占整机已用 {used} mAh 的 {pct}；其中屏幕 {scr} mAh。在 {n} 个应用里排第 {rank}。", {
        ago, mah: Math.round(me.mah), used: Math.round(s.used), pct: s.used ? Math.round((me.mah / s.used) * 100) + "%" : "—", scr: Math.round(me.screen), n: s.apps, rank: me.rank })
      : t("系统估算（自上次充满，{ago}）：整机已用 {used} mAh，本应用没有记录。", { ago, used: Math.round(s.used) }))}</div>`;
    h += `<ul class="en-sys-list">${(s.top || []).map((a) => `<li class="${a.me ? "me" : ""}"><span>${esc(a.name)}</span><span>${Math.round(a.mah * 10) / 10} mAh</span></li>`).join("")}</ul>`;
    h += `<div class="tiny">${esc(t("安卓把亮屏时的屏幕耗电记在前台应用头上，开着看得越久排名越靠前；CPU 那部分才是应用自己干活用掉的。{time} 查询。", { time: new Date(s.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }))}</div>`;
    $("en-sys").innerHTML = h;
  }
  $("en-sys-btn").addEventListener("click", async () => {
    $("en-sys").innerHTML = `<div class="tiny">${esc(t("正在向系统查询…"))}</div>`;
    const r = await post("/api/energy/system", {}).catch((e) => ({ ok: false, message: e.message }));
    if (r.ok) enSys(r.sys);
    else $("en-sys").innerHTML = `<div class="prov-state err">${esc(t("查不到：{msg}（要先在上面开好 Shizuku）", { msg: r.message || t("失败") }))}</div>`;
  });

  // ── 自定义接口卡（任何讲 Anthropic Messages 协议的端点）──
  function renderCustomCard(box, p) {
    const v = p || { label: "", baseUrl: "", authStyle: "bearer", modelsUrl: "", defaultModel: "", fastModel: "" };
    box.innerHTML = `<div class="sub">${p ? esc(pLabel(p)) : t("新增自定义接口")}</div>
      <input id="cc-label" placeholder="${t("名字（比如：公司网关）")}" value="${esc(v.label)}">
      <input id="cc-base" placeholder="${t("端点地址，如")} https://example.com/anthropic" value="${esc(v.baseUrl)}">
      <select id="cc-auth">
        <option value="bearer" ${v.authStyle !== "x-api-key" ? "selected" : ""}>${t("认证：Authorization: Bearer（多数第三方）")}</option>
        <option value="x-api-key" ${v.authStyle === "x-api-key" ? "selected" : ""}>${t("认证：x-api-key（Anthropic 风格）")}</option>
      </select>
      <input id="cc-model" placeholder="${t("默认模型名（必填，claude 不认识第三方模型）")}" value="${esc(v.defaultModel || "")}">
      <input id="cc-fast" placeholder="${t("快模型名（选填，子代理用；留空同上）")}" value="${esc(v.fastModel || "")}">
      <input id="cc-models" placeholder="${t("模型清单地址（选填，OpenAI 形状的 /models）")}" value="${esc(v.modelsUrl || "")}">
      <input id="cc-ctx" inputmode="numeric" placeholder="${t("上下文窗口（选填，token 数，如 1048576；不填按 200k 算）")}" value="${v.contextWindow ? esc(String(v.contextWindow)) : ""}">
      <input id="pc-key" type="password" autocomplete="off"
        placeholder="${p && p.hasKey ? t("已保存（…{tail}），留空则不改", { tail: esc(p.keyTail) }) : t("粘贴 API Key")}">
      <label class="tiny" style="display:flex;gap:6px;align-items:flex-start"><input id="cc-inline" type="checkbox" style="width:auto;margin:2px 0 0"${v.inlineImages ? " checked" : ""}>
        <span>${t("图片随消息一起发（兼容）：模型看不懂附图、照着乱编时再勾。有的第三方调用方式认不出 Read 读回来的图，勾上后附图会另带一份直接放进消息里。")}</span></label>
      <div class="row-actions">
        <button class="btn sm" data-act="save">${p ? t("保存") : t("添加")}</button>
        ${p ? `<button class="btn sm ghost" data-act="test">${t("测试")}</button>
               <button class="btn sm ghost danger" data-act="del">${t("删除")}</button>${useBtn(p)}` : ""}
      </div>
      <div class="prov-state" id="pc-result"></div>
            <div class="tiny">${t("要求对端讲 <b>Anthropic Messages</b> 协议（各家文档里写“Claude Code 接入”的那个地址）。")}
        ${t("地址末尾不要带 <code>/v1</code>，claude 会自己补 <code>/v1/messages</code>。")}
        <br>${t("建议到厂商控制台设个单日消费上限和余额提醒；怀疑 Key 泄漏了，就在那里作废、换个新的。")}</div>`;
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "use") return useProvider(p);
      if (act === "test") return testAndShow(p.id);
      if (act === "del") {
        if (!confirm(t("删除接口「{name}」？", { name: p.label }))) return;
        try { await post("/api/providers/delete", { id: p.id }); } catch (e2) { return toast(e2.message, true); }
        state.provView = state.providerActive === p.id ? null : state.providerActive;
        return reloadProv(t("已删除"));
      }
      const body = {
        id: p ? p.id : "", label: $("cc-label").value.trim(), baseUrl: $("cc-base").value.trim(),
        authStyle: $("cc-auth").value, defaultModel: $("cc-model").value.trim(), fastModel: $("cc-fast").value.trim(),
        modelsUrl: $("cc-models").value.trim(), apiKey: $("pc-key").value.trim(), inlineImages: $("cc-inline").checked,
      };
      if (!body.defaultModel) return toast(t("默认模型名必填"), true);
      // 上下文窗口：k / m 按千 / 百万；清单不报窗口时默认/快模型按它算（#67）
      const cw = $("cc-ctx").value.trim().replace(/[,_]/g, "").replace(/^0+(?:\.0+)?$/, ""), cm = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(cw);
      body.contextWindow = cw ? (cm ? Math.round(Number(cm[1]) * ({ k: 1e3, m: 1e6 }[cm[2].toLowerCase()] || 1)) : -1) : 0;
      if (cw && !(body.contextWindow >= 1024 && body.contextWindow <= 16777216)) return toast(t("上下文窗口填 1024 到 16777216 之间的整数，也可以写 256k、1m"), true);
      let r;
      try { r = await post("/api/providers/save", body); } catch (e2) { return toast(e2.message, true); }
      state.provView = r.id;
      await reloadProv(p ? t("已保存") : t("已添加"), true);
    };
  }


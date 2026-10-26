  // ── 脉络导览（规划书 §11.4）：盖在脉络页上的一层，用同一份 map.js 画一组假会话，一步一个动作。
  //    做对了「下一步」才变蓝（没做也能跳过）；横屏走满血地图那套步骤，竖屏（缩进树）走精简版，转屏自动换。
  //    进度按形态记在 localStorage（cc.linTour.map / cc.linTour.tree），看完一次「怎么看」上的蓝点就不再亮。
  const TOUR = { map: null, mode: "", i: 0, done: false, note: "", ro: null };
  const TOUR_SEEN = "cc.linTourSeen";

  // 假数据：一个示例项目 + 工作区，分叉 / 回退 / 汇合 / 接手 / 定时任务 / 杂项 / 回收站各来一个
  function tourModel() {
    const now = Date.now(), H = 3600e3, D = 24 * H;
    const S = (o) => ({ ghost: false, running: false, trashed: false, misc: false, parent: null, at: 0, kind: null, missingParent: false, extra: [], reads: [], ch: [], meta: { size: "2.4 MB" }, ...o });
    const A = "a1b2demo";
    return {
      now,
      bands: [{ key: "p:demo", name: t("示例项目") }, { key: "ws", name: t("工作区") }],
      sessions: [
        S({ id: A, short: "a1b2", band: "p:demo", title: t("重构网关"), from: now - 6 * D, to: now - 0.1 * D, running: true,
          ch: [{ at: now - 5.2 * D, t: t("拆分路由模块") }, { at: now - 3.8 * D, t: t("接入事件总线") }, { at: now - 2.2 * D, t: t("补齐断线续传") }], open: { t: t("压测与收尾") } }),
        S({ id: "b7c3demo", short: "b7c3", band: "p:demo", title: t("试另一种路由写法"), from: now - 4.5 * D, to: now - 1.25 * D, parent: A, at: now - 4.5 * D, kind: "fork", open: { t: t("试另一种路由写法") } }),
        S({ id: "c4d9demo", short: "c4d9", band: "p:demo", title: t("回退后换个思路"), from: now - 2.9 * D, to: now - 1.9 * D, parent: A, at: now - 2.9 * D, kind: "rewind", open: { t: t("回退后换个思路") } }),
        S({ id: "e5f1demo", short: "e5f1", band: "p:demo", title: t("接手写使用文档"), from: now - 3.2 * D, to: now - 0.6 * D, reads: [{ id: A, ts: now - 3.3 * D, early: true }], open: { t: t("接手写使用文档") } }),
        S({ id: "d2e8demo", short: "d2e8", band: "p:demo", title: t("汇合两条路线"), from: now - 1.05 * D, to: now - 0.2 * D, extra: [{ id: A, ts: now - 1.1 * D }, { id: "b7c3demo", ts: now - 1.25 * D }],
          ch: [{ at: now - 0.6 * D, t: t("合并后统一接口") }], open: { t: t("补测试") } }),
        S({ id: "9c1ddemo", short: "9c1d", band: "p:demo", title: t("废弃的实验"), from: now - 5.6 * D, to: now - 5.3 * D, trashed: true, open: { t: t("废弃的实验") } }),
        S({ id: "f0a3demo", short: "f0a3", band: "p:demo", title: t("试一下新模型"), from: now - 0.9 * D, to: now - 0.88 * D, misc: true, open: { t: t("试一下新模型") } }),
        { id: "task:demo", short: "", band: "ws", title: t("每日巡检"), misc: false, task: { runs: [5, 4, 3, 2, 1, 0].map((k, i) => ({ id: "run" + i, ts: now - k * D - 15 * H })) } },
        S({ id: "7e2ademo", short: "7e2a", band: "ws", title: t("写周记"), from: now - 5.8 * D, to: now - 3.4 * D, ch: [{ at: now - 4.6 * D, t: t("整理本周进展") }], open: { t: t("写周记") } }),
        S({ id: "3b8fdemo", short: "3b8f", band: "ws", title: t("帮我把照片按日期分文件夹"), ghost: true, from: now - 1.7 * D, to: now - 1.5 * D, open: { t: t("帮我把照片按日期分文件夹"), ghost: true } }),
      ],
    };
  }

  // 步骤：want 是这一步要做的动作（pan / zoom / home / select:<id> / select / station / scroll / row），没有就是看一眼即可
  const TOUR_STEPS = {
    map: [
      { h: "一张会话的地铁图", p: ["横轴是时间，越往右越近。每条线是一个会话，按项目分成几条带。", "线上的圆圈是「站」，后面会讲。蓝点在跳的，是正在跑的会话。"] },
      { h: "拖一下", p: ["按住地图往任意方向拖，松手会顺着惯性滑一段。", "日期只跟着左右走，项目名只跟着上下走，拖远了也不会迷路。"], want: "pan", act: "拖动地图" },
      { h: "两指缩放时间", p: ["两根手指捏合或张开，只缩放时间轴，线不会变粗。", "用电脑的话，按住 Ctrl 滚滚轮。"], want: "zoom", act: "缩放一次" },
      { h: "回到现在", p: ["在空白处双击，或者点右上角「回到现在」，地图回到最右边、缩放复原。"], want: "home", act: "回到现在" },
      { h: "点一条线", p: ["点「重构网关」那条线。它的一家子会亮起来：从它分出去的、汇进来的、接手它的；其余的变淡。", "右下角出来一张卡片，写着它的来历和每一章。"], want: "select:a1b2demo", act: "选中「重构网关」" },
      { h: "站 = 压缩 = 章", p: ["会话每压缩一次就结束一章，线上画一个站。选中的线上方写着每章的题名。", "卡片里每章前面的「a1b2·3」是档号：会话号前四位 · 第几章，说出来就能找到。", "点线上任意一个站试试。"], want: "station", act: "点一个站" },
      { h: "几种线", p: ["从别的线中途岔出来的是分叉；贴着岔口拐下去的是回退（倒回某一处重来）。", "带箭头汇进来的是汇合：新会话拿了几条线的材料。细点线是改版前「去读隔壁会话接手」的痕迹。", "点「汇合两条路线」看看它从哪来。"], want: "select:d2e8demo", act: "选中「汇合两条路线」" },
      { h: "定时任务、杂项、回收站", p: ["一条虚线串着点的是定时任务，每个点是它跑出来的一次。", "灰色虚线是回收站里的会话，选中后能在卡片里恢复。试模型、打招呼这类杂项和一问一答默认收起，打开工具栏的「显示杂项」才看得到。", "点「每日巡检」。"], want: "select:task:demo", act: "选中「每日巡检」" },
      { h: "会看了", p: ["灰字的题名表示那一章还没建档，暂时拿那一章的第一句提问顶着。工具栏的「补档」能一次补齐。", "以后新会话由 AI 自己建档，压缩一次记一章。"], end: true },
    ],
    tree: [
      { h: "竖屏是一棵缩进树", p: ["一行一个会话，最近的在上面。从别的会话分出去、汇过来的，缩进挂在来源下面。", "把平板横过来，能看到满血的地铁图。"] },
      { h: "上下滑", p: ["竖屏只上下滚，不会和别的手势打架。"], want: "scroll", act: "滑一下列表" },
      { h: "点一行", p: ["在真脉络里，点一行会弹出这个会话的章节：点哪一卷，就跳到会话里那一章的开头。", "点「重构网关」试试。"], want: "row", act: "点一行" },
      { h: "怎么读一行", p: ["「a1b2·4」是档号：会话号前四位 · 第几章。后面是起止日期和章数。", "「←」后面是它从哪接手、汇合来的。灰字的题名表示还没建档，拿第一句提问顶着。"] },
      { h: "定时任务、杂项、回收站", p: ["虚线圆圈的是定时任务，后面写着跑了几次。回收站里的会话是灰的。", "试模型、打招呼这类杂项和一问一答默认收起，打开「显示杂项」才看得到。"] },
      { h: "会看了", p: ["工具栏的「补档」能给没题名的旧章一次补齐。以后新会话由 AI 自己建档，压缩一次记一章。"], end: true },
    ],
  };

  function openTour() {
    localStorage.setItem(TOUR_SEEN, "1");
    $("lin-how").classList.remove("new");
    const box = $("lin-tour");
    MO.cancel(box);
    box.classList.remove("hidden");
    if (!TOUR.map) {
      TOUR.map = CCLineageMap.create($("lt-map"), {
        t, locale: I18N.lang, misc: false,
        acts: (s) => (s.trashed ? [{ act: "x", label: t("恢复"), pri: true }] : [{ act: "x", label: t("打开"), pri: true }, { act: "x", label: t("章节与题名") }]),
        onAct: (act, arg) => {
          if (act === "chapter") { TOUR.note = t("在真脉络里，这会跳到会话里第 {n} 章的开头。", { n: arg }); tourHit("station"); }
          else if (act === "tree") { const m = TOUR.model.sessions.find((x) => x.id === arg); TOUR.note = t("在真脉络里，这里会弹出「{t}」的章节，点一卷就跳到那一章的开头。", { t: m ? m.title : "" }); tourHit("row"); }
          else { TOUR.note = t("导览里的按钮不做事，回真脉络再点。"); tourPaint(); }
        },
        onSelect: (id) => id && tourHit("select:" + id),
        onGesture: (k) => tourHit(k),
      });
      $("lt-map").querySelector(".lm-tree").addEventListener("scroll", () => tourHit("scroll"), { passive: true });
      TOUR.ro = new ResizeObserver(() => tourSync());
      TOUR.ro.observe($("lt-map"));
    }
    TOUR.model = tourModel();
    TOUR.map.set(TOUR.model, { home: true });
    TOUR.mode = "";
    tourSync();
  }
  function closeTour() {
    // 淡出之后再拆地图；淡出途中又点开导览（openTour 先 cancel）就不拆，接着用
    MO.hide($("lin-tour"), "mo-out-fade", 150, () => {
      if (TOUR.map) { TOUR.map.destroy(); TOUR.map = null; }
      if (TOUR.ro) { TOUR.ro.disconnect(); TOUR.ro = null; }
    });
  }
  // 形态（地图 / 缩进树）跟着宽度走；换了形态就换一套步骤，接着各自的进度
  function tourSync() {
    if (!TOUR.map) return;
    const mode = TOUR.map.state().mode || "map";
    if (mode === TOUR.mode) return;
    TOUR.mode = mode;
    $("lin-tour").classList.toggle("tree", mode === "tree");
    TOUR.i = Math.min(Number(localStorage.getItem("cc.linTour." + mode)) || 0, TOUR_STEPS[mode].length - 1);
    TOUR.done = false; TOUR.note = "";
    tourPaint();
  }
  function tourHit(kind) {
    const st = TOUR_STEPS[TOUR.mode]?.[TOUR.i];
    if (!st || !st.want || TOUR.done) { if (kind === "station") tourPaint(); return; }
    if (st.want === kind || (st.want === "select" && kind.startsWith("select:"))) { TOUR.done = true; tourPaint(); }
  }
  function tourGo(i) {
    const steps = TOUR_STEPS[TOUR.mode];
    TOUR.i = Math.max(0, Math.min(steps.length - 1, i));
    TOUR.done = false; TOUR.note = "";
    localStorage.setItem("cc.linTour." + TOUR.mode, String(TOUR.i));
    if (TOUR.map && TOUR.i === 0) TOUR.map.select(null);
    tourPaint();
  }
  function tourPaint() {
    const steps = TOUR_STEPS[TOUR.mode], st = steps[TOUR.i], el = $("lt-panel");
    const dots = steps.map((_, k) => `<i class="${k <= TOUR.i ? "on" : ""}"></i>`).join("");
    const ready = !st.want || TOUR.done;
    el.innerHTML = `<div class="lt-step"><span class="lt-dots">${dots}</span><span>${esc(t("第 {n} 步，共 {m} 步", { n: TOUR.i + 1, m: steps.length }))}</span><button type="button" class="lt-x" data-a="close">${esc(t("退出导览"))}</button></div>
      <h4>${esc(t(st.h))}</h4>${st.p.map((x) => `<p>${esc(t(x))}</p>`).join("")}
      ${st.want ? `<div class="lt-do${TOUR.done ? " ok" : ""}">${esc(TOUR.done ? t("做到了") : t(st.act))}</div>` : ""}
      ${TOUR.note ? `<div class="lt-note">${esc(TOUR.note)}</div>` : ""}
      <div class="lt-btns">${TOUR.i ? `<button type="button" data-a="prev">${esc(t("上一步"))}</button>` : ""}
      ${st.end ? `<button type="button" data-a="again">${esc(t("从头再来"))}</button><button type="button" class="pri" data-a="close">${esc(t("去看我的脉络"))}</button>`
        : `<button type="button" class="${ready ? "pri" : ""}" data-a="next">${esc(ready ? t("下一步") : t("跳过"))}</button>`}</div>`;
  }
  $("lt-panel").addEventListener("pointerdown", (e) => e.stopPropagation());
  $("lt-panel").addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "next") tourGo(TOUR.i + 1);
    else if (a === "prev") tourGo(TOUR.i - 1);
    else if (a === "again") tourGo(0);
    else if (a === "close") closeTour();
  });
  $("lin-how").addEventListener("click", openTour);
  if (!localStorage.getItem(TOUR_SEEN)) $("lin-how").classList.add("new");

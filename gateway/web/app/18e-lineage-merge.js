  // ── 脉络 · 汇合与补记来源（规划书 §4 阶段 2、§11.3、§13.3）──
  // 汇合：在图上点选几个会话 → 三步向导（挑材料 → 写目标、定项目 → 预览第一条）→ 开新会话发出去，
  //   /api/chat 带 mergeFrom，网关拿到会话号时当场记来源；第一条末尾的落款「（汇合自 0ab2·5、…）」是兜底（gw/merge.mjs）。
  // 补记来源：同一个多选，选好直接 POST /api/lineage/extra，不开新会话。
  // 落款各语言界面都写这句中文：网关只认这个格式（lineage-core MERGE_SIG）。
  const MG = { pick: null };
  const MERGE_TAIL = /（汇合自 (?:[0-9a-f]{4}·\d+)(?:、[0-9a-f]{4}·\d+)*）\s*$/;

  function linPickStart(mode, ids, child) {
    const map = linMap(); if (!map) return;
    // 卡片让开（替身往下淡走）；退出多选时 map.js 把它弹回来
    // 替身挂在卡片层外面：重画会清空卡片层（.lm-card 的 innerHTML），挂在里面的替身会被一起抹掉
    const cb = $("lin-map").querySelector(".lm-card"); if (cb && cb.querySelector(".lm-cardbox")) MO.ghost(cb, "drop");
    MG.pick = { mode, child: child || null, ids: ids.slice() };
    map.pick(ids, (v) => { MG.pick.ids = v; linPickBar(); }, child ? [child] : []);
    linPickBar();
    toast(mode === "merge" ? t("点地图上的会话，把要汇合的都选上") : t("点地图上的会话，选出它的来源"));
  }
  function linPickEnd() {
    if (!MG.pick) return;
    MG.pick = null;
    if (LIN.map) LIN.map.pick(null);
    linPickBar();
  }
  function linPickBar() {
    const bar = $("lin-pick"), P = MG.pick;
    if (!P) return MO.hide(bar, "mo-out-sheet", 170);
    MO.cancel(bar);
    const n = P.ids.length, ok = $("lin-pick-ok");
    const child = P.child && LIN.g && LIN.g.nodes.find((x) => x.id === P.child);
    $("lin-pick-n").textContent = P.mode === "merge" ? t("已选 {n} 个会话", { n })
      : t("给「{t}」补记来源 · 已选 {n} 个", { t: (child && child.title || "").slice(0, 16) || P.child.slice(0, 4), n });
    ok.textContent = P.mode === "merge" ? t("下一步") : t("连上");
    ok.disabled = !n;
    bar.classList.remove("hidden");
  }
  $("lin-pick-x").addEventListener("click", linPickEnd);
  $("lin-pick-ok").addEventListener("click", async () => {
    const P = MG.pick; if (!P || !P.ids.length) return;
    if (P.mode === "merge") return mergeWizard(P.ids.slice());
    try {
      const r = await post("/api/lineage/extra", { child: P.child, add: P.ids });
      toast(t("已补记 {n} 个来源", { n: r.n || P.ids.length }));
      linPickEnd(); loadLineage();
    } catch (e) { toast(e.message === "too_many" ? t("这个会话补记的来源已经满了（最多 {n} 个）", { n: 32 }) : e.message, true); }
  });

  // 卡片「更多…」：从这里分叉、补记来源、撤掉补错的来源
  function linMore(id, el) { popMenu(el, linMoreItems(id)); }
  /** 手机缩进树没有卡片：这几项和「汇合…」接在会话的脉络弹层后面 */
  function linTreeItems(id) { return ["hr", { label: t("剖面"), icon: SM.lineage, fn: () => linProfOpen(id) }, { label: t("汇合…"), icon: SM.lineage, fn: () => linPickStart("merge", [id]) }, ...linMoreItems(id)]; }
  function linMoreItems(id) {
    const node = LIN.g && LIN.g.nodes.find((x) => x.id === id);
    const name = (x) => { const n = LIN.g.nodes.find((y) => y.id === x); return ((n && n.title) || x.slice(0, 8)).slice(0, 20); };
    const items = [
      { label: t("从这里分叉"), icon: SM.chat, fn: () => linFork(id) },
      { label: t("补记来源…"), icon: SM.lineage, fn: () => linPickStart("extra", [], id) },
    ];
    // 记在 ccapp-lineage.json 里的、按落款重建的都能撤（落款的那种撤掉后记一笔不再按落款连）
    const drops = LIN.g.edges.filter((e) => e.child === id && e.kind === "merge");
    if (drops.length) items.push("hr", ...drops.map((e) => ({ label: t("撤掉来源：{t}", { t: name(e.parent) }), icon: SM.trash, fn: async () => {
      if (!confirm(t("不再把「{a}」记成「{b}」的来源？会话本身不受影响。", { a: name(e.parent), b: (node && node.title || "").slice(0, 20) }))) return;
      try { await post("/api/lineage/extra", { child: id, drop: e.parent }); toast(t("已撤掉")); loadLineage(); } catch (err) { toast(err.message, true); }
    } })));
    return items;
  }
  async function linFork(id) {
    try {
      const r = await post("/api/session/" + encodeURIComponent(id) + "/fork", { latest: true });
      toast(t("已分叉：保留了前 {n} 轮，接着聊就行", { n: r.kept }));
      loadSessions(); openSession(r.id);
    } catch (e) { toast(e.message, true); }
  }

  // ── 向导 ──
  async function mergeWizard(ids) {
    const nodes = ids.map((id) => LIN.g.nodes.find((x) => x.id === id)).filter(Boolean);
    if (!nodes.length) return;
    const src = nodes.map((n) => ({ n, id: n.id, how: n.chapters.length > 1 ? "compact" : "excerpt", turns: null, picked: null, mat: null }));
    const W = { step: 0, goal: "", proj: undefined, text: "", ed: null };
    const o = dlg(t("汇合 {n} 个会话", { n: src.length }), "", "");
    const body = o.querySelector(".pj-smain"), foot = o.querySelector(".pj-sfoot");
    const title = (n) => (n.title || n.id.slice(0, 8));
    const no = (s) => s.n.id.slice(0, 4) + "·" + (s.mat ? s.mat.chapter : s.n.chapters.length);
    const kchars = fmtChars;   // 02-chat-view

    // 换步：和项目详情同一套（窄屏前进推入、后退回拉；宽屏淡变）。第一次画不动
    function stepMo(n) {
      const was = W.step; W.step = n;
      if (!was || was === n) return;
      const narrow = o.classList.contains("narrow"), into = n > was;
      MO.ghost(body, narrow ? (into ? "back" : "push") : "fade", !(narrow && into));
      MO.play(body, narrow ? (into ? "mo-in-push" : "mo-in-back") : (into ? "mo-in-pane" : "mo-in-pane-back"), 1400);
    }
    // 第 1 步：每个来源选材料
    function step1() {
      stepMo(1);
      body.innerHTML = `<p class="pj-hint mg-lead">${esc(t("新会话看不到原来的对话，只看得到你带过去的材料。压缩摘要不花钱；摘录是挑几轮原文，默认最后一轮。"))}</p>` + src.map((s, i) => {
        const has = s.n.chapters.length > 1;
        return `<div class="mg-src" data-i="${i}"><div class="mg-h"><i>${esc(s.n.id.slice(0, 4))}·${s.n.chapters.length}</i><span>${esc(title(s.n))}</span></div>
          <span class="seg pj-seg" data-name="how${i}"><button type="button" data-v="compact" class="${s.how === "compact" ? "on" : ""}"${has ? "" : " disabled"}>${esc(t("压缩摘要"))}</button><button type="button" data-v="excerpt" class="${s.how === "excerpt" ? "on" : ""}">${esc(t("摘录"))}</button></span>
          ${has ? "" : `<div class="pj-hint">${esc(t("这个会话还没压缩过，只能摘录"))}</div>`}
          <div class="mg-turns${s.how === "excerpt" ? "" : " hidden"}"></div></div>`;
      }).join("");
      foot.innerHTML = `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm" data-next>${esc(t("下一步"))}</button>`;
      src.forEach((s, i) => { if (s.how === "excerpt") turnsOf(i); });
    }
    async function turnsOf(i) {
      const s = src[i], box = body.querySelector(`.mg-src[data-i="${i}"] .mg-turns`); if (!box) return;
      const show = box.classList.contains("hidden") || !!box._moLeave;   // 用户刚切到「摘录」：列表展开要有进场
      MO.cancel(box); box.classList.remove("hidden");
      if (!s.turns) {
        box.innerHTML = `<div class="pj-hint">${esc(t("读取中…"))}</div>`;
        try { s.turns = (await api("/api/lineage/turns?id=" + encodeURIComponent(s.id))).turns; }
        catch (e) { box.innerHTML = `<div class="pj-hint">${esc(e.message)}</div>`; return; }
        if (!s.picked) s.picked = new Set(s.turns.length ? [s.turns[s.turns.length - 1].uuid] : []);
      }
      if (!box.isConnected) return;
      if (!s.turns.length) { box.innerHTML = `<div class="pj-hint">${esc(t("没找到能摘录的问答"))}</div>`; return; }
      box.innerHTML = `<div class="pj-hint">${esc(t("勾上要带过去的轮（最近 {n} 轮）", { n: s.turns.length }))}</div><ol>` + [...s.turns].reverse().map((x) => `<li><label><input type="checkbox" data-u="${esc(x.uuid)}"${s.picked.has(x.uuid) ? " checked" : ""}><span><b>${esc(x.q)}</b><small>${esc(x.a)}</small></span></label></li>`).join("") + "</ol>";
      if (show) MO.play(box, "mo-in-rise", 1400);
    }
    body.addEventListener("change", (e) => {
      const c = e.target.closest("input[data-u]"); if (!c) return;
      const s = src[+c.closest(".mg-src").dataset.i];
      if (c.checked) s.picked.add(c.dataset.u); else s.picked.delete(c.dataset.u);
      s.mat = null;
    });
    o.addEventListener("pick", (e) => {
      const seg = e.target.closest && e.target.closest("[data-name^=how]"); if (!seg) return;
      const i = +seg.dataset.name.slice(3), s = src[i];
      s.how = seg.querySelector(".on").dataset.v; s.mat = null;
      if (s.how === "excerpt") turnsOf(i); else MO.hide(body.querySelector(`.mg-src[data-i="${i}"] .mg-turns`), "mo-out-fade", 150);
    });

    // 材料：进第 2 步时一起取；挑的轮没变就不重取
    async function fetchAll() {
      await Promise.all(src.map(async (s) => {
        if (s.mat) return;
        const u = s.how === "excerpt" && s.picked && s.picked.size ? "&uuids=" + [...s.picked].map(encodeURIComponent).join(",") : "";
        s.mat = await api(`/api/lineage/material?id=${encodeURIComponent(s.id)}&how=${s.how}${u}`);
      }));
    }

    // 第 2 步：目标 + 放进哪个项目（养恩大于生恩：材料大半来自哪个项目就放哪，并列取最近活动的）
    function bandProj(key) { return key && key.startsWith("p:") ? key.slice(2) : ""; }
    function guessProj() {
      const w = new Map();
      for (const s of src) { const k = s.n.band.key, cur = w.get(k) || { c: 0, ts: 0 }; cur.c += s.mat.chars; cur.ts = Math.max(cur.ts, s.n.lastTs); w.set(k, cur); }
      const best = [...w].sort((a, b) => b[1].c - a[1].c || b[1].ts - a[1].ts)[0][0];
      const pid = bandProj(best);
      return PJ.list.some((p) => p.id === pid) ? pid : "";
    }
    function step2() {
      stepMo(2);
      if (W.proj === undefined) W.proj = guessProj();
      const total = src.reduce((a, s) => a + s.mat.chars, 0);
      const pname = (id) => (id ? (PJ.list.find((p) => p.id === id) || {}).name : t("工作区"));
      body.innerHTML = `<div class="mg-mats">${src.map((s) => `<div><i>${esc(no(s))}</i><span>${esc(title(s.n))}</span><small>${esc(s.how === "compact" ? t("压缩摘要") : t("摘录 {n} 轮", { n: s.mat.turns || 1 }))} · ${esc(kchars(s.mat.chars))}</small></div>`).join("")}</div>
        <div class="pj-hint">${esc(t("材料共 {c}", { c: kchars(total) }))}</div>` +
        frow(t("接下来要干什么"), `<textarea class="pj-field mg-goal" placeholder="${esc(t("一两句话，比如：把两边的结论合起来，定一个方案"))}">${esc(W.goal)}</textarea>`) +
        frow(t("放进哪里"), `<select class="pj-field mg-proj">${[["", t("工作区")], ...PJ.list.map((p) => [p.id, t("项目：{n}", { n: p.name })])].map(([v, l]) => `<option value="${esc(v)}"${v === W.proj ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`,
          esc(t("默认放进「{p}」：大部分材料来自它。", { p: pname(guessProj()) })));
      foot.innerHTML = `<button class="btn sm ghost" data-back>${esc(t("上一步"))}</button><button class="btn sm" data-next>${esc(t("预览"))}</button>`;
      body.querySelector(".mg-goal").focus();
    }

    // 第 3 步：拼出第一条消息，可以改；落款写在最后
    function compose() {
      const parts = src.map((s) => `## ${no(s)} · ${title(s.n)}\n\n${s.how === "compact" ? t("（压缩摘要）") : t("（摘录最近的对话）")}\n\n${s.mat.text}`);
      const sig = "（汇合自 " + src.map(no).join("、") + "）";
      return t("下面是从 {n} 个会话带过来的材料。先读完，再按最后的目标接着做；材料之间有矛盾的地方先指出来。", { n: src.length })
        + "\n\n" + parts.join("\n\n---\n\n") + "\n\n## " + t("目标") + "\n\n" + (W.goal.trim() || t("（没写目标：先概括这几份材料各自做到了哪一步，再问我接下来做什么）")) + "\n\n" + sig;
    }
    async function step3() {
      stepMo(3);
      if (!W.text) { W.text = compose(); W.mats = src.map((s) => s.mat); }
      body.innerHTML = `<div class="pj-hint">${esc(t("这就是新会话的第一条消息，可以直接改。末尾那句落款别删：设备之间迁移时靠它认出来源。"))}</div><div class="mg-ed"></div>`;
      foot.innerHTML = `<button class="btn sm ghost" data-back>${esc(t("上一步"))}</button><span class="mg-cnt"></span><button class="btn sm" data-send>${esc(t("开始新会话"))}</button>`;
      const box = body.querySelector(".mg-ed"), cnt = foot.querySelector(".mg-cnt");
      const count = () => { cnt.textContent = kchars(getText().length); };
      try {
        const m = await loadMdEdit();
        if (W.step !== 3 || !box.isConnected) return;
        W.ed = m.createMdEditor(box, { doc: W.text, onChange: count, placeholder: "" });
      } catch {
        box.innerHTML = `<textarea class="pj-field mg-ta"></textarea>`;
        const ta = box.querySelector("textarea"); ta.value = W.text; ta.addEventListener("input", count);
      }
      count();
    }
    const getText = () => (W.ed ? W.ed.getText() : body.querySelector(".mg-ta")?.value ?? W.text);
    // 离开第 3 步：先记下改过的字；编辑器等替身拍完（下一步重画之后）再拆，不然退场的替身是一块空白
    function leave3() { if (W.step !== 3) return; W.text = getText(); const ed = W.ed; W.ed = null; if (ed) setTimeout(() => ed.destroy()); }

    foot.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-back")) {
        if (W.step === 2) { W.goal = body.querySelector(".mg-goal").value; W.proj = body.querySelector(".mg-proj").value; return step1(); }
        if (W.step === 3) { leave3(); return step2(); }
      }
      if (b.hasAttribute("data-next")) {
        if (W.step === 1) {
          // 摘录一轮都没勾：别往下走。不传 uuids 后端会默认取最后一轮，等于把用户取消的又带回去（#98 03-015）
          if (src.some((s) => s.how === "excerpt" && s.picked && !s.picked.size)) return toast(t("摘录至少勾一轮"), true);
          b.disabled = true; b.textContent = t("取材料…");
          try { await fetchAll(); }
          catch (err) {
            b.disabled = false; b.textContent = t("下一步");
            return toast(err.body && err.body.error === "no_compact" ? t("有个会话没有压缩摘要，换成摘录") : err.message, true);
          }
          if (!o.isConnected) return;
          return step2();
        }
        if (W.step === 2) {
          const g = body.querySelector(".mg-goal").value, p = body.querySelector(".mg-proj").value;
          // 目标改了、或回第 1 步换过材料（换装法、改勾选会重取 s.mat）都重拼；只换项目不动已改过的预览。
          // 以前只看目标：材料换了正文还是旧的，来源却按新材料记（审查 B12）
          if (g !== W.goal || !W.mats || src.some((s, i) => s.mat !== W.mats[i])) W.text = "";
          W.goal = g; W.proj = p;
          return step3();
        }
      }
      if (b.hasAttribute("data-send")) {
        let text = getText().trim();
        if (!text) return toast(t("第一条消息是空的"), true);
        if (!MERGE_TAIL.test(text)) text += "\n\n（汇合自 " + src.map(no).join("、") + "）";
        const from = src.map((s) => ({ id: s.id, at: s.mat.at || null, how: s.how }));
        leave3();
        OV.close(o);
        linPickEnd();
        newChatIn(W.proj || null);
        view.pendingMerge = from;
        // 和回退一样等新会话的首屏画完再发
        // 这 300 毫秒里切去了别的会话：不往那边发，也别把写好的长消息丢了——复制下来，告诉一声
        setTimeout(() => {
          if (!view.sessionId && view.pendingMerge === from) return send(text);
          if (view.pendingMerge === from) view.pendingMerge = null;
          copyText(text); toast(t("汇合的第一条没发出去（切到了别的会话），已经复制，可以粘贴到新对话里"), true);
        }, 300);
      }
    });
    o.addEventListener("click", (e) => { if (e.target.closest("[data-close]") && W.ed) { W.ed.destroy(); W.ed = null; } }, true);
    step1();
  }

  // ── 自己气泡里的档号可点（§13.9）：「c624·3」→ 那个会话第 3 章开头；会话号前缀撞了就去脉络页让人挑 ──
  // 认法同网关（gw/merge.mjs REF_RE）；代码、链接、公式里的不动
  const CH_REF = /(?<![0-9a-f])([0-9a-f]{4})[·・](\d{1,4})(?!\d)/g;
  function linRefLinks(root) {
    if (!/[·・]/.test(root.textContent)) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest("code,pre,a,.katex") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const hits = [];
    for (let n; (n = tw.nextNode());) { CH_REF.lastIndex = 0; if (CH_REF.test(n.data)) hits.push(n); }
    for (const n of hits) {
      const f = document.createDocumentFragment();
      let i = 0;
      for (const m of n.data.matchAll(CH_REF)) {
        f.append(n.data.slice(i, m.index));
        const a = document.createElement("span");
        a.className = "u-chref"; a.setAttribute("role", "link"); a.tabIndex = 0;
        a.dataset.ref = m[1] + "·" + m[2]; a.title = t("跳到这一章"); a.textContent = m[0];
        f.append(a); i = m.index + m[0].length;
      }
      f.append(n.data.slice(i));
      n.replaceWith(f);
    }
  }
  async function linGoRef(ref) {
    const s = ref.slice(0, 4), n = Number(ref.slice(5));
    let g = LIN.g;
    if (!g) {
      try { g = await api("/api/lineage"); } catch (e) { return toast(e.message, true); }
      if (g.building) return toast(t("脉络还在整理，稍后再点"));
      LIN.g = g;
    }
    const hit = g.nodes.filter((x) => x.id.startsWith(s));
    if (!hit.length) return toast(t("没找到档号 {r} 对应的会话", { r: ref }), true);
    if (hit.length > 1) { openPage("lineage"); return toast(t("有 {n} 个会话的号都以 {s} 开头，在图上挑一个", { n: hit.length, s })); }
    const c = (hit[0].chapters || [])[n - 1];
    if (!c && n !== 1) return toast(t("{r}：没有这一章", { r: ref }), true);
    openSession(hit[0].id, null, n === 1 ? "start" : c.anchor || "");
  }

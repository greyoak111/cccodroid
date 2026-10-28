  // ══ 书签：在对话里某一处留个钩子（网关 gw/bookmarks.mjs）══════════════════
  // 入口是提问 / 回复底下那排键（不放长按，长按留给复制文段）；侧栏「书签」页统一管理。
  // 落点 = 消息 uuid + 第几段：长回复只记开头等于白记，点书签时视口顶部还在这条消息里就记那一段。
  // 另有一个不占按钮的「上次读到」：切走时不在底部就记下视口顶部那一段，切回来落回去；滑到底就作废。只存本机。
  const BMK = { sid: null, items: [] };   // 当前会话的书签，给按钮上色用
  async function loadMarks() {
    const sid = view.sessionId;
    BMK.sid = sid; BMK.items = [];
    if (!sid) return;
    try {
      const r = await api("/api/bookmarks?session=" + encodeURIComponent(sid));
      if (view.sessionId === sid) { BMK.items = r.items || []; paintMarks(); }
    } catch {}
  }
  const isUserMsg = (msg) => msg.classList.contains("user");
  // 一条消息里能落点的块：提问是气泡本身（uuid 挂在消息上），回复是各段正文（uuid 挂在 .txt 上）
  const markBoxes = (msg) => (isUserMsg(msg) ? [msg.querySelector(".bubble")] : [...msg.querySelectorAll(":scope > .bubble .txt")]);
  const boxUuid = (msg, box) => (isUserMsg(msg) ? msg.dataset.uuid : box.dataset.uuid) || "";
  const msgUuids = (msg) => markBoxes(msg).map((b) => boxUuid(msg, b)).filter(Boolean);
  // 块里的「段」：正文块分冻结区（一截截定稿）和尾巴，两边的子元素按顺序排起来
  function paraList(box) {
    if (!box.classList.contains("txt")) return [...box.children];
    const [frozen, tail] = box.children;
    return [...frozen.children].flatMap((c) => [...c.children]).concat([...tail.children]);
  }
  function paintMarks(root) {
    const set = new Set(BMK.items.map((b) => b.uuid));
    for (const btn of (root || chatEl).querySelectorAll('.msg-acts button[data-a="mark"]')) {
      const msg = btn.closest(".msg-acts").parentElement;
      btn.classList.toggle("on", msgUuids(msg).some((u) => set.has(u)));
    }
  }
  /** 视口顶部落在 msg 的哪一块第几段；msg 整条在视口顶部以下时给开头 */
  function topIn(msg) {
    const top = chatEl.getBoundingClientRect().top + 4, boxes = markBoxes(msg);
    for (const box of boxes) {
      const ps = paraList(box);
      for (let i = 0; i < ps.length; i++) if (ps[i].getBoundingClientRect().bottom > top) return { box, para: i, el: ps[i] };
    }
    return boxes.length ? { box: boxes[0], para: 0, el: paraList(boxes[0])[0] || null } : null;
  }
  /** 整个对话区视口顶部那一段（给「上次读到」）：第一条底边在视口顶部以下、有 uuid 的消息 */
  function viewTopMark() {
    const top = chatEl.getBoundingClientRect().top + 4;
    for (const msg of chatEl.querySelectorAll("#hist .msg.user, #hist .msg.bot, #live .msg.user, #live .msg.bot")) {
      if (msg.getBoundingClientRect().bottom <= top || !msgUuids(msg).length) continue;
      const tg = topIn(msg), uuid = tg && boxUuid(msg, tg.box);
      if (uuid) return { uuid, para: tg.para, off: Number(msg.closest(".page")?.dataset.from) || 0 };
    }
    return null;
  }

  async function toggleMark(msg) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再加书签"), true);
    const uu = msgUuids(msg), mine = BMK.items.filter((b) => uu.includes(b.uuid));
    if (mine.length) {   // 已经有：再点一下取消
      try { await post("/api/bookmarks/del", { ids: mine.map((b) => b.id) }); } catch (e) { return toast(e.message, true); }
      BMK.items = BMK.items.filter((b) => !mine.includes(b));
      paintMarks(msg);
      return toast(t("已取消书签"));
    }
    const tg = topIn(msg);
    if (!tg) return;
    const user = isUserMsg(msg), uuid = boxUuid(msg, tg.box);
    const src = user ? userTextOf.get(msg) || "" : tg.box._src ? tg.box._src() : "";
    try {
      const r = await post("/api/bookmarks", {
        session: sid, uuid, hint: Number(msg.closest(".page")?.dataset.from) || 0, para: tg.para,
        role: user ? "user" : "assistant", head: src.trim().slice(0, 200),
        excerpt: ((tg.el && tg.el.innerText) || src).trim().slice(0, 120),
      });
      // 刚答完的回复界面上没有 uuid：网关认领到了就补上，之后按钮状态、再点取消都靠它
      if (!uuid && r.item) (user ? msg : tg.box).dataset.uuid = r.item.uuid;
      if (sid === view.sessionId && r.item) { BMK.items.push(r.item); paintMarks(msg); }
      toast(t("已加书签"));
    } catch (e) {
      toast(e.status === 409 ? t("这个会话的书签已满 {n} 个，先删掉一些", { n: (e.body && e.body.limit) || 50 })
        : e.status === 404 ? t("没在会话记录里找到这条消息，稍后再试") : e.message, true);
    }
  }

  /** 落到书签：把那一段放到视口上三分之一（「上次读到」放在顶上、不闪） */
  function landOnMark(page, a) {
    const el = page.querySelector(`[data-uuid="${CSS.escape(a.uuid)}"]`);
    if (!el) return null;
    const box = el.classList.contains("txt") ? el : el.querySelector(".bubble") || el;
    const p = paraList(box)[a.para] || el;
    const y = p.getBoundingClientRect().top - chatEl.getBoundingClientRect().top + chatEl.scrollTop;
    chatEl.scrollTop = Math.max(0, y - (a.quiet ? 6 : chatEl.clientHeight / 3));
    if (!a.quiet) { p.classList.remove("bm-hit"); void p.offsetWidth; p.classList.add("bm-hit"); setTimeout(() => p.classList.remove("bm-hit"), 2400); }
    return p;
  }

  // ── 上次读到 ──
  const LR_KEY = "cc.lastRead";
  const lrMap = () => { try { return JSON.parse(localStorage.getItem(LR_KEY)) || {}; } catch { return {}; } };
  function saveLastRead() {
    const sid = view.sessionId;
    if (!sid || view.loading) return;
    const m = lrMap();
    if (stick && view.next == null) { if (!m[sid]) return; delete m[sid]; }
    else {
      const tg = viewTopMark();
      if (!tg) return;
      m[sid] = { ...tg, at: Date.now() };
      const ks = Object.keys(m);
      if (ks.length > 40) ks.sort((x, y) => m[x].at - m[y].at).slice(0, ks.length - 40).forEach((k) => delete m[k]);
    }
    try { localStorage.setItem(LR_KEY, JSON.stringify(m)); } catch {}
  }
  const lastReadOf = (sid) => { const r = lrMap()[sid]; return r && r.uuid ? { uuid: r.uuid, para: r.para || 0, off: r.off || 0, quiet: true } : null; };

  // ── 侧栏「书签」页 ──
  const BM_DEL = '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>';
  async function loadBookmarks() {
    const box = $("tab-bookmarks");
    let r;
    try { r = await api("/api/bookmarks"); } catch (e) { box.innerHTML = `<div class="panel">${emptyRow(e.message)}</div>`; return; }
    const items = (r.items || []).sort((a, b) => b.at - a.at);
    setPageSub("bookmarks", t("{n} 个", { n: items.length }));
    if (!items.length) { box.innerHTML = `<div class="panel">${emptyRow(t("还没有书签。在提问或回复底下点书签键，就在那一处留了个记号。"))}</div>`; return; }
    // 按会话分组，组的先后看组里最新的那个
    const groups = new Map();
    for (const b of items) { if (!groups.has(b.sid)) groups.set(b.sid, []); groups.get(b.sid).push(b); }
    const titleOf = (sid, fb) => ((state.sessions || []).find((s) => s.id === sid) || {}).title || fb || t("（无标题）");
    box.innerHTML = [...groups].map(([sid, bs]) => `<div class="pj-sec"><span class="grow">${esc(titleOf(sid, bs[0].title))}</span></div>
      <div class="panel">${bs.map((b) => `<div class="row pj-row bm-row" data-bm="${esc(b.id)}"><div class="grow"><div class="t1 bm-ex">${esc(b.excerpt || "…")}</div>
        <div class="muted pj-sub">${esc((b.role === "user" ? t("提问") : t("回复")) + " · " + relTime(b.at))}</div></div>
        <button class="bm-del" data-del="${esc(b.id)}" aria-label="${esc(t("删除"))}"><svg viewBox="0 0 24 24">${BM_DEL}</svg></button></div>`).join("")}</div>`).join("");
    box._items = items;
  }
  $("tab-bookmarks").addEventListener("click", async (e) => {
    const box = $("tab-bookmarks"), items = box._items || [];
    const d = e.target.closest("[data-del]");
    if (d) {
      try { await post("/api/bookmarks/del", { id: d.dataset.del }); } catch (err) { return toast(err.message, true); }
      BMK.items = BMK.items.filter((b) => b.id !== d.dataset.del); paintMarks();
      return loadBookmarks();
    }
    const row = e.target.closest("[data-bm]"); if (!row) return;
    const b = items.find((x) => x.id === row.dataset.bm); if (!b) return;
    closeDrawer();
    openSession(b.sid, null, { uuid: b.uuid, off: b.off, para: b.para });
  });

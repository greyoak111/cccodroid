  // ══ 频道（照 OpenClaw 的频道抽象）══════════════════════════════════
  // 频道 = 一个平台账号 + 路由 + 访问门（网关 gw/channels.mjs）。消息进来交给同一条队列跑，
  // 结果回到那个聊天里。第一个适配器是 QQ 官方机器人。
  var CH = { data: null, cur: null, detail: null };

  async function loadChannels() {
    try { CH.data = await api("/api/channels"); } catch { return; }
    if (curPage === "channels") renderChannels();
  }

  const chById = (id) => ((CH.data && CH.data.channels) || []).find((x) => x.id === id) || null;
  const chType = (id) => ((CH.data && CH.data.types) || []).find((x) => x.id === id) || { label: id, fields: [] };
  const STATE_TXT = () => ({ off: t("没开"), connecting: t("连接中"), online: t("在线"), error: t("出错") });
  const PILL = { off: "", connecting: "", online: "ok", error: "err" };
  function chStatePill(st) {
    const s = (st && st.state) || "off";
    const txt = STATE_TXT()[s] || s;
    return `<span class="pill ${PILL[s] || ""}">${esc(txt)}</span>`;
  }
  const chatName = (k) => (String(k || "").startsWith("g:") ? t("群") : t("私聊"));
  const chatCode = (k) => String(k || "").replace(/^[ug]:/, "");

  async function renderChannels() {
    const box = $("tab-channels");
    if (CH.cur) return renderChannel(box);
    setOv("");
    if (!CH.data) { box.innerHTML = pageHead(esc(t("频道"))) + `<div class="muted">${esc(t("加载中…"))}</div>`; return loadChannels(); }
    const list = CH.data.channels || [];
    const on = list.filter((x) => x.on).length;
    setPageSub("channels", list.length ? t("{n} 个开着", { n: on }) : t("还没有频道"));
    const row = (x) => {
      const pending = (x.pending || []).length;
      return `<div class="row pj-row" data-ch="${esc(x.id)}"><div class="grow"><div class="t1">${esc(x.name)}</div>
        <div class="muted pj-sub">${esc(chType(x.type).label)}${x.config && x.config.appId ? " · " + esc(x.config.appId) : ""} · ${esc(x.on ? (x.status.state === "online" ? t("连着") : t("开着，还没连上")) : t("已关"))}${pending ? " · " + esc(t("{n} 个待批准", { n: pending })) : ""}</div></div>
        ${chStatePill(x.status)}${swHtml(x.on, `data-chsw="${esc(x.id)}" aria-label="${esc(t("开关"))}"`)}</div>`;
    };
    box.innerHTML = pageHead(esc(t("频道")), `<button class="btn sm pj-primary" data-a="new">${pi("plus")}${esc(t("新建频道"))}</button>`) +
      `<div class="sc-note">${esc(t("从聊天软件直接找本机的 Claude 说话：消息进来跑一轮，结果回到那个聊天。第一个适配器是 QQ 官方机器人——在 QQ 开放平台建个机器人，把 AppID / AppSecret 填进来，私聊它或者在群里 @ 它就行。"))}</div>` +
      `<div class="panel">${list.length ? list.map(row).join("") : emptyRow(t("还没有频道。新建一个，用 QQ 私聊本机的 Claude。"))}</div>`;
  }

  async function renderChannel(box) {
    const id = CH.cur;
    let x = CH.detail && CH.detail.id === id ? CH.detail : chById(id);
    if (!x) {
      box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(t("加载中…"))}</div>`;
      try { x = (await api("/api/channels/" + encodeURIComponent(id))).channel; } catch (e) { CH.cur = null; return renderChannels(); }
      if (CH.cur !== id) return;
    }
    // 详情片的按钮（编辑、测一下、换配对码、解除…）都读 CH.detail。
    // 以前只有「列表里没这条、另去拉详情」时才赋值，正常点进来永远是 null，按钮全是死键
    CH.detail = x;
    setOv(x.name); setPageSub("channels", chType(x.type).label + " · " + (STATE_TXT()[x.status.state] || x.status.state));
    const st = x.status || {}, stats = st.stats || {};
    const mode = (x.access && x.access.mode) || "pair";
    const allow = (x.access && x.access.allow) || [];
    const pending = x.pending || [], binds = x.bindings || [];
    const projs = PJ.list || [];
    const opt = (v, l, cur) => `<option value="${esc(v)}"${v === (cur || "") ? " selected" : ""}>${esc(l)}</option>`;
    const r = x.route || {};
    const perms = [["", t("跟随全局")], ["ro", t("只是聊聊（不许改文件、跑命令要问）")], ["proj", t("可以改项目目录里的文件")]];
    const sess = [["chat", t("接着同一个会话（带着上下文）")], ["new", t("每条消息都新开会话")]];
    const mins = [5, 10, 30, 60, 120];
    const dirTxt = { in: t("收到"), out: t("发出"), sys: t("系统"), err: t("出错") };
    box.innerHTML = pageHead(esc(x.name), kebabBtn("chmenu"), true) +
      `<div class="panel"><div class="row"><div class="grow"><b>${esc(x.on ? t("开着") : t("关着"))}</b>
          <div class="muted pj-sub">${esc(st.state === "online" ? t("连着 QQ，消息会进来") : x.on ? t("在连，还没接上") : t("不会收消息"))}${st.error ? " · " + esc(st.error) : ""}</div>
          ${stats.in || stats.out ? `<div class="muted pj-sub">${esc(t("收到 {a} 条 · 回复 {b} 条 · 失败 {c} 次", { a: stats.in || 0, b: stats.out || 0, c: stats.err || 0 }))}</div>` : ""}</div>
        ${swHtml(x.on, `data-chsw="${esc(x.id)}" aria-label="${esc(t("开关"))}"`)}</div>
        <div class="row"><div class="grow"><b>${esc(t("连接"))}</b><div class="muted pj-sub">${esc(t("掉了会自己重连；改了凭据要重连才生效"))}</div></div>
          <button class="btn sm ghost" data-a="test">${esc(t("测一下"))}</button>
          <button class="btn sm" data-a="restart">${esc(t("重连"))}</button></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("谁能用"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("配对码"))}</b><div class="muted pj-sub">${esc(t("第一次私聊机器人，先发这个 6 位数；发对了这个人就进白名单。"))}</div></div>
          <code class="mono ch-code" data-a="copy-code">${esc(x.pairCode)}</code>
          <button class="btn sm ghost" data-a="regen">${esc(t("换一个"))}</button></div>
        <div class="row"><div class="grow"><b>${esc(t("谁能用"))}</b><div class="muted pj-sub">${esc(mode === "pair" ? t("陌生人要先配对") : mode === "open" ? t("谁都可以用（不建议）") : t("只有名单里的人"))}</div></div>
          ${segOf("access", [["pair", t("配对")], ["allow", t("名单")], ["open", t("都行")]], mode)}</div>
        ${allow.length ? `<div class="row"><div class="grow"><b>${esc(t("名单"))}（${allow.length}）</b><div class="muted pj-sub">${allow.map((k) => `<span class="ch-chip">${esc(chatName(k))} ${esc(chatCode(k))}<button class="ch-x" data-delallow="${esc(k)}" aria-label="${esc(t("移除"))}">${pi("x")}</button></span>`).join("")}</div></div></div>` : ""}
        ${pending.map((p) => `<div class="row"><div class="grow"><b>${esc(t("有人想用：{n}", { n: chatName(p.key) + " " + chatCode(p.key) }))}</b><div class="muted pj-sub">${esc(relTime(p.firstAt))}</div></div>
          <button class="btn sm ghost" data-reject="${esc(p.key)}">${esc(t("不给他"))}</button><button class="btn sm" data-approve="${esc(p.key)}">${esc(t("允许"))}</button></div>`).join("")}</div>
      <div class="pj-sec"><span class="grow">${esc(t("怎么跑"))}</span></div>
      <div class="panel">
        <div class="row"><div class="grow"><b>${esc(t("在哪里跑"))}</b><div class="muted pj-sub">${esc(t("聊天里来的活在这个目录里跑；不选就是工作区"))}</div></div>
          <select data-route="projectId">${opt("", t("工作区"), r.projectId)}${projs.map((p) => opt(p.id, p.name, r.projectId)).join("")}</select></div>
        <div class="row"><div class="grow"><b>${esc(t("型号"))}</b></div>
          <select data-route="model">${opt("", t("跟随项目 / 全局"), r.model)}${(typeof MODELS !== "undefined" ? MODELS : []).map((m) => opt(m.id, prettyModel(m.id), r.model)).join("")}</select></div>
        <div class="row"><div class="grow"><b>${esc(t("权限"))}</b><div class="muted pj-sub">${esc(r.perm ? t("没人看着，要问你的一律当拒绝") : t("跟随全局") + " · " + (state.settings && state.settings.permissionMode || "default"))}</div></div>
          ${segOf("perm", perms, r.perm || "")}</div>
        <div class="row"><div class="grow"><b>${esc(t("上下文"))}</b></div>${segOf("session", sess, r.session || "chat")}</div>
        <div class="row"><div class="grow"><b>${esc(t("一轮最多跑多久"))}</b></div>
          <select data-route="timeoutMin">${mins.map((n) => opt(String(n), t("{n} 分钟", { n }), String(r.timeoutMin || 30))).join("")}</select></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("会话"))}</span>${binds.length ? `<button class="btn sm ghost" data-a="unbind-all">${esc(t("全部解除"))}</button>` : ""}</div>
      <div class="panel">${binds.length ? binds.map((b) => `<div class="row pj-row" data-sid="${esc(b.sessionId)}"><div class="grow"><div class="t1">${esc(b.title || chatName(b.chatKey) + " " + chatCode(b.chatKey))}</div>
          <div class="muted pj-sub">${esc(t("会话 {id} · {w}", { id: String(b.sessionId).slice(0, 8), w: relTime(b.at) }))}</div></div>
          <button class="btn sm ghost" data-unbind="${esc(b.chatKey)}">${esc(t("解除"))}</button>${pi("chev", "pj-go")}</div>`).join("") : emptyRow(t("还没人聊过"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("最近的来往"))}</span></div>
      <div class="panel ch-log">${(x.events || []).length ? x.events.slice().reverse().map((e) => `<div class="row pj-row ch-ev"${e.sessionId ? ` data-sid="${esc(e.sessionId)}"` : ""}>
          <span class="pill ${e.dir === "err" ? "err" : e.dir === "out" ? "ok" : ""}">${esc(dirTxt[e.dir] || e.dir)}</span>
          <div class="grow"><div class="ch-txt">${esc(e.text)}</div><div class="muted pj-sub">${esc(relTime(e.at))}</div></div></div>`).join("") : emptyRow(t("还没有消息"))}</div>`;
  }

  function channelDlg(old) {
    const editing = !!old;
    const types = (CH.data && CH.data.types) || [];
    const t0 = old ? old.type : (types[0] && types[0].id);
    const ty = types.find((x) => x.id === t0) || { fields: [], hint: "" };
    const c = old ? (old.config || {}) : {};
    // appId / appSecret / sandbox / markdown 都单独排了版；剩下的字段（以后别的平台）照默认样式画
    const fields = ty.fields.filter((f) => !["appId", "appSecret", "sandbox", "markdown"].includes(f.key));
    const hasApp = ty.fields.some((f) => f.key === "appId");   // 有 AppID 的平台才给扫码绑定
    const optRow = ["sandbox", "markdown"].map((k) => {
      const f = ty.fields.find((x) => x.key === k);
      return f ? `<label class="ch-opt"><span>${esc(f.label)}</span>${swHtml(!!c[k], `data-opt="${k}"`)}</label>` : "";
    }).filter(Boolean).join("");
    const o = dlg(editing ? t("改频道") : t("新建频道"),
      frow(t("叫什么"), `<input class="pj-field" id="ch-name" value="${esc(old ? old.name : t("QQ 机器人"))}" autocomplete="off">`) +
      (editing ? "" : frow(t("平台"), rcards("type", types.map((x) => [x.id, x.label, esc(x.hint)]), t0))) +
      (hasApp ? frow(t("扫码绑定"), `<button type="button" class="btn sm" id="ch-qr">${esc(t("扫码获取 AppID / AppSecret"))}</button>`, esc(t("用手机 QQ 扫一下，选好机器人，AppID 和 AppSecret 自动填进来"))) : "") +
      frow(t("AppID"), `<input class="pj-field mono" id="ch-appid" value="${esc(c.appId || "")}" autocomplete="off" spellcheck="false">`, esc(t("QQ 开放平台 → 机器人 → 开发设置里的机器人 AppID"))) +
      frow(t("AppSecret"), `<input class="pj-field mono" id="ch-secret" type="password" value="" autocomplete="off" spellcheck="false" placeholder="${esc(editing && old.secretSet ? t("已填过，不改就留空") : "")}">`, esc(t("换取令牌用；只存在本机，不会再显示出来"))) +
      fields.map((f) => frow(f.label, `<input class="pj-field" id="ch-f-${esc(f.key)}" value="${esc(c[f.key] || "")}" autocomplete="off">`)).join("") +
      (optRow ? frow(t("选项"), optRow) : "") +
      `<div class="ch-saveerr" id="ch-err" hidden></div>`,
      `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm pj-primary" id="ch-save">${esc(editing ? t("保存") : t("建好并打开"))}</button>`);
    // 输入框一律在这个弹窗自己身上找（o.querySelector），不要用全文档的 getElementById：
    // 页面上万一还挂着同名的旧弹窗/嵌套弹层，就会读到错的那一份，表现就是「点了毫无反应」。
    // 整段包在 try 里，失败在弹窗里就地写出来，不靠底部 toast（软键盘常常正好挡住它）。
    let lastSave = 0;
    const save = async (ev) => {
      const btn = ev && ev.currentTarget, errBox = o.querySelector("#ch-err");
      const say = (m) => { if (errBox) { errBox.textContent = m; errBox.hidden = false; } toast(m, true); };
      if (btn && btn.disabled) return;
      const now = Date.now();
      if (now - lastSave < 700) return;   // touchend 兜底和真 click 都到了，只跑一次
      lastSave = now;
      try {
        if (errBox) errBox.hidden = true;
        const nameEl = o.querySelector("#ch-name"), appEl = o.querySelector("#ch-appid"), secEl = o.querySelector("#ch-secret");
        if (!nameEl || !appEl || !secEl) throw new Error(t("弹窗里少了输入框，关掉重开一次"));
        const sec = secEl.value.trim();
        const body = {
          name: nameEl.value.trim() || t("QQ 机器人"),
          config: {
            appId: appEl.value.trim(),
            sandbox: !!o.querySelector('[data-opt="sandbox"]')?.checked,
            markdown: !!o.querySelector('[data-opt="markdown"]')?.checked,
          },
        };
        if (sec) body.config.appSecret = sec;
        if (!body.config.appId) throw new Error(t("AppID 还没填：点上面的「扫码绑定」可以自动填"));
        if (!editing && !body.config.appSecret) throw new Error(t("AppSecret 还没填：点上面的「扫码绑定」可以自动填"));
        if (btn) { btn.disabled = true; btn.textContent = editing ? t("保存中…") : t("创建中…"); }
        let r;
        if (editing) r = await api("/api/channels/" + encodeURIComponent(old.id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        else r = await jsend("/api/channels", { ...body, type: picked(o, "type") || t0, on: true });
        if (!r || !r.channel || !r.channel.id) throw new Error(t("网关没返回新频道，看看日志"));
        OV.close(o);
        CH.cur = r.channel.id; CH.detail = null;
        await loadChannels();
        renderChannels();
        toast(editing ? t("已保存") : t("建好了。到 QQ 里私聊它试试"));
      } catch (err) {
        say((err && err.message) || String(err));
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = editing ? t("保存") : t("建好并打开"); }
      }
    };
    // 按钮上同时挂 click 和 touchend 兜底：安卓 WebView 手势状态卡住时，touchend 收得到、
    // click 不一定合成出来，按钮看着就是「点了毫无反应」。兜底延迟 400ms 等 click，
    // 等不到才自己补一次（save 里有 700ms 去重，不会重复提交）。
    const saveBtn = o.querySelector("#ch-save");
    let clickedAt = 0;
    saveBtn.addEventListener("click", (e) => { clickedAt = Date.now(); save(e); });
    saveBtn.addEventListener("touchend", () => {
      const t0 = Date.now();
      setTimeout(() => {
        if (clickedAt >= t0 || !o.isConnected || saveBtn.disabled) return;
        save({ currentTarget: saveBtn });
      }, 400);
    });
    const qb = o.querySelector("#ch-qr");
    if (qb) qb.addEventListener("click", () => qrBindDlg((appId, secret) => {
      if (!o.isConnected) return;   // 频道弹窗先被关掉了，就别回填了
      o.querySelector("#ch-appid").value = appId;
      o.querySelector("#ch-secret").value = secret;
      toast(t("绑定成功，AppID 和 AppSecret 已填好，保存就生效"));
    }));
    setTimeout(() => o.querySelector("#ch-name")?.focus(), 50);
    return o;
  }

  // 扫码绑定：找腾讯要一个 task_id → 画二维码 → 每 2 秒问一次结果；码过期就自动换一张
  function qrBindDlg(fill) {
    const o = dlg(t("扫码绑定 QQ 机器人"),
      `<div class="ch-qrwrap"><div class="ch-qr" id="ch-qr-img"></div></div><div class="ch-qrmsg muted" id="ch-qr-msg">${esc(t("正在取二维码…"))}</div>`,
      `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm ghost" id="ch-qr-copy">${esc(t("复制链接"))}</button>`,
      { layer: true });   // 别把下面的频道弹窗关掉，扫完还要回填
    let url = "", task = "", timer = 0, done = false;
    const msg = (s) => { const el = o.querySelector("#ch-qr-msg"); if (el) el.textContent = s; };
    const stop = () => { done = true; clearTimeout(timer); };
    const draw = (u) => {
      url = u;
      const box = o.querySelector("#ch-qr-img");
      try { const q = qrcode(0, "M"); q.addData(u); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2 }); }
      catch { box.textContent = u; }
    };
    const tick = async () => {
      if (done || !o.isConnected) return stop();          // 弹窗关了就别再问了
      try {
        const r = await jsend("/api/channels/qr/poll", { taskId: task });
        if (done || !o.isConnected) return stop();
        if (r.status === "ok") {
          stop();
          fill(r.appId || "", r.appSecret || "");
          OV.close(o);
          return;
        }
        if (r.status === "expired") return start();       // 码过期：换一张接着等
      } catch (e) { msg(e.message); }
      timer = setTimeout(tick, 2000);
    };
    const start = async () => {
      clearTimeout(timer);
      msg(t("正在取二维码…"));
      try {
        const r = await jsend("/api/channels/qr/start", {});
        if (done || !o.isConnected) return stop();
        task = r.taskId;
        draw(r.url);
        msg(t("用手机 QQ 扫这个码，选一个机器人绑定"));
        timer = setTimeout(tick, 2000);
      } catch (e) { msg(e.message); }
    };
    o.querySelector("#ch-qr-copy").addEventListener("click", async () => {
      if (!url) return;
      const ok = await copyText(url);
      toast(ok ? t("已复制") : t("复制失败"), !ok);
    });
    start();
  }

  function testSendDlg(x) {
    const o = dlg(t("发一条测试消息"),
      frow(t("发给"), rcards("kind", [["user", t("私聊"), esc(t("填对方的 openid"))], ["group", t("群"), esc(t("填群的 openid"))]], "user")) +
      frow(t("ID"), `<input class="pj-field mono" id="ts-id" autocomplete="off" spellcheck="false">`) +
      frow(t("内容"), `<input class="pj-field" id="ts-text" value="${esc(t("测试：频道通了"))}" autocomplete="off">`),
      `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm pj-primary" id="ts-go">${esc(t("发"))}</button>`);
    o.querySelector("#ts-go").addEventListener("click", async () => {
      const body = { kind: picked(o, "kind") || "user", id: (o.querySelector("#ts-id")?.value || "").trim(), text: (o.querySelector("#ts-text")?.value || "").trim() };
      if (!body.id || !body.text) return toast(t("ID 和内容都要填"), true);
      try {
        await jsend("/api/channels/" + encodeURIComponent(x.id) + "/test-send", body);
        OV.close(o);
        toast(t("发出去了"));
        CH.detail = null;
        loadChannels();
      } catch (err) { toast(err.message, true); }
    });
    setTimeout(() => o.querySelector("#ts-id")?.focus(), 50);
    return o;
  }

  // 打开编辑弹窗：先用手上的详情，没有再按 id 拉一次（手机上点了没反应多半就是手上那份是空的）
  async function openChannelEdit() {
    let x = CH.detail || chById(CH.cur);
    if (!x && CH.cur) {
      try { x = (await api("/api/channels/" + encodeURIComponent(CH.cur))).channel; } catch (err) { return toast(err.message, true); }
    }
    if (!x) return toast(t("频道还没加载出来"), true);
    return channelDlg(x);
  }

  async function chPatch(id, body) {
    const r = await api("/api/channels/" + encodeURIComponent(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    CH.detail = r.channel;
    await loadChannels();
    renderChannels();
    return r.channel;
  }

  $("tab-channels").addEventListener("click", async (e) => {
    if (e.target.closest("input.sw")) return;         // 开关走 change
    if (e.target.closest("[data-delallow]")) {
      const k = e.target.closest("[data-delallow]").dataset.delallow;
      const x = CH.detail; if (!x) return;
      try { await chPatch(x.id, { access: { ...x.access, allow: (x.access.allow || []).filter((y) => y !== k) } }); toast(t("已移除")); } catch (err) { toast(err.message, true); }
      return;
    }
    const seg = e.target.closest(".pj-seg button");
    if (seg) {
      const name = seg.parentNode.dataset.name, v = seg.dataset.v;
      [...seg.parentNode.children].forEach((b) => b.classList.toggle("on", b === seg));
      const x = CH.detail; if (!x) return;
      try {
        if (name === "access") await chPatch(x.id, { access: { ...x.access, mode: v } });
        else if (name === "perm") await chPatch(x.id, { route: { ...x.route, perm: v } });
        else if (name === "session") await chPatch(x.id, { route: { ...x.route, session: v } });
      } catch (err) { toast(err.message, true); }
      return;
    }
    const ap = e.target.closest("[data-approve]"), rj = e.target.closest("[data-reject]");
    if (ap || rj) {
      const k = (ap || rj).dataset.approve || (ap || rj).dataset.reject;
      try { await jsend("/api/channels/" + encodeURIComponent(CH.cur) + "/" + (ap ? "approve" : "reject"), { key: k }); CH.detail = null; await loadChannels(); renderChannels(); toast(ap ? t("已允许") : t("没让他进")); } catch (err) { toast(err.message, true); }
      return;
    }
    const ub = e.target.closest("[data-unbind]");
    if (ub) {
      try { await jsend("/api/channels/" + encodeURIComponent(CH.cur) + "/unbind", { chatKey: ub.dataset.unbind }); CH.detail = null; await loadChannels(); renderChannels(); toast(t("解除了，下一条消息新开会话")); } catch (err) { toast(err.message, true); }
      return;
    }
    // 列表里的频道卡片：点哪儿都进详情。必须放在「详情才有的动作」之前 ——
    // 那些动作末尾有 if (!x) return，列表页 CH.detail 是空的，卡片就会统统点不动。
    const rowCh = e.target.closest("[data-ch]");
    if (rowCh) { CH.cur = rowCh.dataset.ch; CH.detail = null; renderChannels(); $("page-body").scrollTop = 0; return; }
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "back") { CH.cur = null; CH.detail = null; renderChannels(); $("page-body").scrollTop = 0; return; }
    if (a === "new") return channelDlg(null);
    if (a === "chmenu") {
      const x = CH.detail; if (!x) return;
      return popMenu(e.target.closest("[data-a]"), [
        { label: t("编辑"), icon: PI.edit, fn: () => channelDlg(x) },
        { label: t("发一条测试消息"), icon: PI.term, fn: () => testSendDlg(x) },
        { label: t("复制配对码"), icon: PI.copy, fn: () => { copyText(x.pairCode); toast(t("已复制")); } },
        "hr",
        { label: t("删除这个频道"), icon: PI.trash, danger: true, fn: async () => {
          if (!confirm(t("删除频道「{n}」？聊天记录和会话都留着，只是不再收消息。", { n: x.name }))) return;
          try { await api("/api/channels/" + encodeURIComponent(x.id), { method: "DELETE" }); CH.cur = null; CH.detail = null; await loadChannels(); renderChannels(); toast(t("已删除")); } catch (err) { toast(err.message, true); }
        } },
      ]);
    }
    const x = CH.detail;
    if (a === "edit") return openChannelEdit();
    if (a === "copy-code" && x) { copyText(x.pairCode); return toast(t("已复制")); }
    if (!x) return;
    if (a === "test") {
      try { const r = await jsend("/api/channels/" + encodeURIComponent(x.id) + "/test"); toast(r.message || t("可以了")); } catch (err) { toast(err.message, true); }
      return;
    }
    if (a === "restart") {
      try { await jsend("/api/channels/" + encodeURIComponent(x.id) + "/restart"); CH.detail = null; await loadChannels(); renderChannels(); toast(t("重新连了")); } catch (err) { toast(err.message, true); }
      return;
    }
    if (a === "regen") {
      if (!confirm(t("换一个配对码？已经发出去的那个就不管用了。"))) return;
      try { const r = await jsend("/api/channels/" + encodeURIComponent(x.id) + "/pair-code"); CH.detail = null; await loadChannels(); renderChannels(); copyText(r.pairCode); toast(t("换了：{c}（已复制）", { c: r.pairCode })); } catch (err) { toast(err.message, true); }
      return;
    }
    if (a === "unbind-all") {
      if (!confirm(t("把这个频道的所有聊天都和新会话解绑？"))) return;
      try { for (const b of x.bindings || []) await jsend("/api/channels/" + encodeURIComponent(x.id) + "/unbind", { chatKey: b.chatKey }); CH.detail = null; await loadChannels(); renderChannels(); toast(t("都解除了")); } catch (err) { toast(err.message, true); }
      return;
    }
    const sid = e.target.closest("[data-sid]");
    if (sid) return openSession(sid.dataset.sid);
  });

  $("tab-channels").addEventListener("change", async (e) => {
    const sw = e.target.closest("[data-chsw]");
    if (sw) {
      try { const r = await chPatch(sw.dataset.chsw, { on: sw.checked }); toast(r.on ? t("开着了") : t("关了")); } catch (err) { sw.checked = !sw.checked; toast(err.message, true); }
      return;
    }
    const sel = e.target.closest("[data-route]");
    if (sel && CH.detail) {
      const k = sel.dataset.route;
      const v = k === "timeoutMin" ? +sel.value || 30 : sel.value;
      try { await chPatch(CH.detail.id, { route: { ...CH.detail.route, [k]: v } }); } catch (err) { toast(err.message, true); }
    }
  });

  // 网关推来的频道事件：状态变了 / 有条消息进出 / 绑定了会话
  let chT = 0;
  function onChannelEvent(ev) {
    if (ev && ev.op === "status" && CH.data) {
      const c = chById(ev.id); if (c) { c.status = { ...(c.status || {}), state: ev.state, error: ev.error || null }; }
    }
    clearTimeout(chT);
    chT = setTimeout(() => { if (CH.detail) CH.detail = null; loadChannels(); }, 400);
  }

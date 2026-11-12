  // ── 模型标签与快速切换（输入栏下面那一行最左边）──
  // 标签写「模型 · 思考强度」；点它从底部弹面板：上面一排思考强度，下面搜索 + 最近用过 + 全部模型。
  // 不占输入区的地方。OpenRouter 这类几十上百个模型的，靠搜索框过滤。
  const RECENT_KEY = "cc.recentModels";
  // 存坏了（手改、截断）别让整个型号弹层画不出来（审查 v0.5.5 W-L5）
  const recentIds = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; } };
  function prettyModel(name) {
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(name || "");
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + "." + m[3] : name || "";
  }
  // 0.3.16 起模型 / 思考强度 / 接口按会话记（网关 gw/sessmodel.mjs）。设置页里的是全局默认；
  // 会话在输入栏面板里单独选过才有自己的值（state.sessModel，网关原样的记录，null 的字段 = 跟随默认），没选过就跟着全局默认走。
  // 单独选了模型的会话钉在选的那家接口上，全局切接口它也不跟；只选了思考强度的，模型和接口都跟全局。
  // 还没会话号的新会话：面板里选的先暂存在 state.pendingModel，随第一条消息带给网关（/api/chat 的 pin）
  const own = () => (view.sessionId ? state.sessModel : state.pendingModel) || null;
  const pickOr = (k) => { const o = own(); return o && o[k] != null ? o[k] : state.settings && state.settings[k]; };
  // state.sessEff：网关算好的「这个会话真跑时用什么」（/api/session-model，含项目默认、按那家换过的思考强度）。
  // 标签、额度都按它；还没回来时按本地记录凑合
  const curEffort = () => (state.sessEff ? state.sessEff.effortRun || "" : pickOr("effort") || "");
  // 下面几个用函数声明：09 段的额度速览（qbLoad）也要用，声明会提升
  function globalProv() { return (state.serverStatus && state.serverStatus.provider) || ""; }
  /** 这个会话用哪家：单独选过模型就是记下的那家，否则全局生效的那家 */
  function curProv() { if (state.sessEff && state.sessEff.provider) return state.sessEff.provider; const o = own(); return (o && o.model != null && o.provider) || globalProv(); }
  function provOf(id) { return (state.provList || []).find((p) => p.id === id) || null; }
  function provLabel(id) { const p = provOf(id); return p ? (provEn() && p.labelEn) || p.label : id || ""; }
  /** 模型：钉了就是钉的（"" = 那家的默认）；跟随就是全局默认 */
  function curModel() {
    if (state.sessEff) return state.sessEff.model || state.sessEff.defaultModel || "";
    const o = own();
    if (o && o.model != null) return o.model || (curProv() !== globalProv() && provOf(curProv())?.defaultModel) || "";
    return (state.settings && state.settings.model) || "";
  }
  const chipName = () => curModel() || state.model || t("默认");
  // /api/models 的查询串：老会话给会话号，新会话把暂存的选择带上；extra 是另加的参数（如 browse=）
  const sidQ = (extra) => {
    const q = [];
    if (view.sessionId) q.push("sid=" + encodeURIComponent(view.sessionId));
    else {
      const p = state.pendingModel;
      if (view.projectId) q.push("project=" + encodeURIComponent(view.projectId));   // 项目里的新会话按项目默认
      if (p && p.provider) q.push("provider=" + encodeURIComponent(p.provider));
      if (p && p.model != null) q.push("model=" + encodeURIComponent(p.model));
      if (p && p.effort != null) q.push("effort=" + encodeURIComponent(p.effort));
    }
    if (extra) q.push(extra);
    return q.length ? "?" + q.join("&") : "";
  };
  let smSeq = 0;
  async function refreshSessModel() {
    const id = view.sessionId, my = ++smSeq;
    let r = null;
    try { r = await api("/api/session-model" + (id ? "?id=" + encodeURIComponent(id) : sidQ())); } catch {}
    if (my !== smSeq) return;               // 切得快：只认最后一次
    if (id) state.sessModel = (r && r.rec) || null;
    state.sessEff = r && r.provider ? r : null;
    paintModel(chipName());
    loadCtxModel();                          // 上下文刻度跟着这个会话的模型
    provChanged();
  }
  // 会话用的那家变了：顶栏的额度 / 余额跟着换
  function provChanged() { if (QB.cur && QB.cur.id !== curProv()) qbLoad(false).catch(() => {}); }
  // 新会话拿到会话号：暂存的选择就是它记下的（网关在 init 时已记上），不必再问一遍
  function adoptPendingModel() {
    if (!state.pendingModel) return;
    const p = state.pendingModel;
    state.sessModel = { model: p.model != null ? p.model : p.provider ? "" : null, effort: p.effort != null ? p.effort : null, provider: p.provider || globalProv() };
    state.pendingModel = null;
  }
  // 只改这个会话；patch 为 null 表示回到跟随全局默认
  let pickSeq = 0;
  async function pickSessModel(patch) {
    if (!view.sessionId) {
      state.pendingModel = patch ? { ...(state.pendingModel || {}), ...patch } : null;
      return refreshSessModel();
    }
    const sid = view.sessionId, gen = view.gen, seq = ++pickSeq;
    const r = await api("/api/session-model", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch ? { id: sid, ...patch } : { id: sid, reset: true }) });
    // 回执慢、人已经切到别的会话：A 的结果不许写进 B 的标签（审查 D-01）。抛出去让调用方别接着重画
    // 切走又切回来（A→B→A）、或者之后又选过一次：旧回执也不算（审查 #52 D-01）
    if (view.sessionId !== sid || view.gen !== gen || seq !== pickSeq) { const e = new Error(""); e.stale = true; throw e; }
    smSeq++;                               // 在途的旧查询作废，以这次回执为准
    state.sessModel = r.rec || null;
    state.sessEff = r.provider ? r : null;
    provChanged();
  }
  function paintModel(name) {
    state.chipModel = name;
    const eff = curEffort();
    // 照设计稿拆成两片：型号（claude-opus-5-5 显示成 Opus 5.5）、思考强度；会话用的不是全局那家时前面再加一片接口名
    const pretty = prettyModel(name), pv = curProv(), other = pv && globalProv() && pv !== globalProv();
    modelEl.innerHTML = (other ? `<span class="chip chip-prov">${esc(provLabel(pv))}</span>` : "") +
      `<span class="chip">${esc(pretty)}</span>${eff ? `<span class="chip">${esc(eff)}</span>` : ""}`;
    modelEl.title = (other ? provLabel(pv) + " · " : "") + name;
    // #model-chip 是 display:contents，本身没有盒子，title 落不到实际上屏的 chip 上
    modelEl.querySelectorAll(".chip").forEach((c) => { c.title = modelEl.title; });
  }
  modelEl.setAttribute("role", "button");
  modelEl.tabIndex = 0;
  modelEl.addEventListener("click", (e) => { e.stopPropagation(); openModelPicker(); });
  modelEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openModelPicker(); } });   // 审查 #52 P2-11

  async function openModelPicker() {
    if ($("model-pick")) return;
    const m = document.createElement("div");
    m.id = "model-pick";
    m.innerHTML = `<div class="sheet-panel mp-panel">
      <div class="mp-head"><b>${t("模型与思考强度")}</b><button class="mp-x" type="button" aria-label="${t("关闭")}">${uiI("x")}</button></div>
      <div class="mp-follow"></div>
      <div class="mp-lbl">${t("思考强度")}</div><div class="mp-eff"></div>
      <div class="mp-provwrap hidden"><div class="mp-lbl">${t("接口")}</div><div class="mp-prov"></div></div>
      <div class="mp-lbl">${t("模型")}</div>
      <label class="searchbox mp-sb"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input class="mp-q" type="search" autocomplete="off" placeholder="${t("搜索模型")}"></label>
      <div class="mp-list"><div class="tiny">${t("读取中…")}</div></div>
      <div class="tiny mp-note">${t("只改这个会话，从下一条消息起生效；没单独选过的会话跟着设置里的默认走。")}</div></div>`;
    OV.open(m, { kind: "modal", anchor: modelEl });   // 宽度真变了由 OV 关；布局补发的假 resize 不算
    const close = () => OV.close(m);
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest(".mp-x")) close(); });
    // 宽屏：卡片宽 420、最高 宽×φ，对齐输入栏下的型号按钮，底边落在按钮上方 8px；都只在对话这一栏里摆
    const col = colRect();
    if (col.width < 560) { m.style.left = col.left + "px"; m.style.right = (innerWidth - col.right) + "px"; }
    if (col.width >= 560) {
      m.classList.add("pop");
      // 首屏里 #model-chip 是 display:contents，自己没有盒子，量里面第一片
      const p = m.querySelector(".mp-panel"), ar = (modelEl.getBoundingClientRect().height ? modelEl : modelEl.firstElementChild || modelEl).getBoundingClientRect();
      const w = Math.min(420, col.width - 32);
      p.style.width = w + "px";
      const x0 = ar.left + ar.width / 2 > col.left + col.width / 2 ? ar.right - w : ar.left;   // 按钮在右半边就右对齐
      p.style.left = Math.max(col.left + 16, Math.min(x0, col.right - w - 16)) + "px";
      p.style.bottom = (fixedH() - ar.top + 8) + "px";
      p.style.maxHeight = Math.min(Math.round(w * 1.618), ar.top - 8 - 16) + "px";
    }
    // browse：模型清单正在看哪家（点上面的接口切换，只是看；点了模型才真换）
    let info, browse = curProv(), ML = [];
    const list = m.querySelector(".mp-list"), q = m.querySelector(".mp-q");
    async function load() {
      const want = browse;
      let r;
      try { r = await api("/api/models" + sidQ(browse && browse !== curProv() ? "browse=" + encodeURIComponent(browse) : "")); }
      catch (e) { list.textContent = t("拉取模型清单失败：{msg}", { msg: e.message }); return false; }
      if (!m.isConnected || want !== browse) return false;
      info = r; ML = r.models || [];
      if (r.providers) state.provList = r.providers;
      if (!browse) browse = r.provider;
      return true;
    }
    if (!(await load())) return;
    const cur = () => (browse === curProv() ? info.current || "" : null);   // 看别家时没有「当前」

    const effBox = m.querySelector(".mp-eff");
    const paintEff = (levels, now) => {
      const opts = [["", t("默认")], ...levels.map((l) => [l, l])];
      effBox.innerHTML = levels.length
        ? `<div class="seg mp-seg">${opts.map(([v, l]) => `<button type="button" class="${v === now ? "on" : ""}" data-eff="${esc(v)}">${esc(l)}</button>`).join("")}</div>`
        : `<span class="tiny">${t("这个模型没有可选的思考强度")}</span>`;
    };
    let effLevels = info.effortLevels || [];
    paintEff(effLevels, info.effort || "");
    // 跟随全局默认：没单独选过时只是说明一句；选过了给个按钮改回去
    const followBox = m.querySelector(".mp-follow");
    // 跟随的是「这个会话的默认」：项目可以有自己的默认接口 / 型号（#79），只看全局会把项目默认说错（195-E.5）
    const followEff = () => {
      const d = state.settings || {}, e = state.sessEff && state.sessEff.provider ? state.sessEff : null;
      return {
        prov: e ? e.provider : globalProv(),
        model: e ? (e.model || e.defaultModel || "") : (d.model || ""),
        effort: e ? (e.effortRun ?? e.effort ?? "") : (d.effort || ""),
      };
    };
    const paintFollow = () => {
      const usable = (state.provList || []).filter((p) => p.usable && !p.hidden).length;
      const f = followEff();
      const dm = (usable > 1 ? provLabel(f.prov) + " · " : "") + (prettyModel(f.model) || t("默认")) + (f.effort ? " · " + f.effort : "");
      followBox.innerHTML = own()
        ? `<button type="button" class="mp-item mp-reset"><span>${esc(t("改回跟随默认"))}</span><small>${esc(dm)}</small></button>`
        : `<div class="tiny">${esc(t("跟随默认：{model}", { model: dm }))}</div>`;
    };
    paintFollow();
    followBox.addEventListener("click", async (e) => {
      if (!e.target.closest(".mp-reset")) return;
      const to = followEff().prov;
      if (curProv() !== to && view.sessionId && !confirm(switchWarn(to))) return;
      close();
      try { await pickSessModel(null); } catch (er) { return er.stale || toast(er.message, true); }
      paintModel(chipName());
      loadCtxModel();
    });
    effBox.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-eff]");
      if (!b) return;
      try { await pickSessModel({ effort: b.dataset.eff }); } catch (er) { return er.stale || toast(er.message, true); }
      info.effort = b.dataset.eff;
      paintEff(effLevels, b.dataset.eff);
      paintFollow();
      paintModel(state.chipModel || chipName());
    });

    // 接口：能用的（有 Key、走登录、本机）才列；只有一家就不显示这一行
    const provWrap = m.querySelector(".mp-provwrap"), provBox = m.querySelector(".mp-prov");
    const paintProv = () => {
      // 正在用的、全局默认的、正在看的那家总要列出来：不然藏了自己在用的那家，用户看不到现在是谁
      const ps = (state.provList || []).filter((p) => (p.usable && !p.hidden) || [curProv(), globalProv(), browse].includes(p.id));
      provWrap.classList.toggle("hidden", ps.length < 2);
      provBox.innerHTML = `<div class="seg mp-seg mp-provseg">${ps.map((p) =>
        `<button type="button" class="${p.id === browse ? "on" : ""}${p.id === curProv() ? " cur" : ""}${p.usable ? "" : " off"}" data-prov="${esc(p.id)}">${esc(provLabel(p.id))}</button>`).join("")}</div>` +
        // 总要列出的那几家可能用不了（没登录的官方账户、没下模型的端侧）：灰掉，看它时说一句
        (ps.some((p) => p.id === browse && !p.usable) ? `<div class="tiny mp-provhint">${esc(t("这一家还没就绪（没登录或没下模型），先到设置里配好"))}</div>` : "") +
        (browse !== curProv() ? `<div class="tiny mp-provhint">${esc(t("点一个模型，这个会话就换到「{name}」", { name: provLabel(browse) }))}</div>` : "");
      provBox.querySelector("button.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });   // 横滚里选中的那家露出来
    };
    paintProv();
    provBox.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-prov]");
      if (!b || b.dataset.prov === browse) return;
      browse = b.dataset.prov;
      paintProv();
      list.innerHTML = `<div class="tiny">${t("读取中…")}</div>`;
      if (await load()) paintList();
    });

    const row = (id, sub) => (sub = typeof sub === "string" ? { text: sub } : sub, `<button type="button" class="mp-item${id === cur() ? " cur" : ""}" data-id="${esc(id)}"><span>${esc(id || t("默认"))}</span>${sub && (sub.text || sub.img) ? `<small>${esc(sub.text || "")}${sub.img ? MM_IMG() : ""}</small>` : ""}</button>`);
    const meta = (md) => {
      if (!md) return null;
      const ctx = md.context_window ? Math.round(md.context_window / 1024) + "k" : "";
      return { text: [md.name && md.name !== md.id ? md.name : "", md.configured ? t("接口设置里填的") : "", ctx].filter(Boolean).join(" · "), img: (md.input_modalities || []).includes("image") };
    };
    function paintList() {
      const kw = q.value.trim().toLowerCase();
      const all = ML.filter((md) => !kw || md.id.toLowerCase().includes(kw) || String(md.name || "").toLowerCase().includes(kw));
      let html = "";
      if (!kw) {
        if (info.nativeModels) html += row("", info.defaultModel ? t("（默认：{model}）", { model: info.defaultModel }) : t("（默认，由 claude 决定）"));
        // 当前在用的那个总排在「最近用过」头一个：不然清单一长，打开弹层根本看不到现在用的是哪个
        const rec = [...new Set([cur(), ...recentIds()])].filter((id) => id && ML.some((md) => md.id === id));
        if (rec.length) html += `<div class="mp-sec">${t("最近用过")}</div>` + rec.map((id) => row(id, meta(ML.find((md) => md.id === id)))).join("") + `<div class="mp-sec">${t("全部 {n} 个", { n: ML.length })}</div>`;
      }
      html += all.slice(0, 300).map((md) => row(md.id, meta(md))).join("");
      if (!all.length) html += `<div class="tiny">${ML.length ? t("没有匹配的模型") : t("（该厂商不提供模型清单）")}</div>`;
      list.innerHTML = html;
    }
    paintList();
    q.addEventListener("input", paintList);
    list.addEventListener("click", async (e) => {
      const b = e.target.closest(".mp-item");
      if (!b) return;
      const id = b.dataset.id, to = browse, switching = to !== curProv();
      // 会话聊到一半换家：之前的对话要整段交给新模型重读，先说清楚
      if (switching && view.sessionId && !confirm(switchWarn(to))) return;
      if (id) localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 6)));
      close();
      if (!switching && id === cur() && own() && own().model != null) return;   // 跟随默认时点同一个也算「单独选」：钉住，默认再改它也不变
      // 新会话：型号是给这家的，连同厂商一起钉住 —— 不然之后再挑个默认别家的项目，界面和真跑各认一家（审查 B18）
      try { await pickSessModel(switching || !view.sessionId ? { provider: to, model: id } : { model: id }); } catch (er) { return er.stale || toast(er.message, true); }
      paintModel(chipName());
      loadCtxModel();
      if (switching) toast(t("这个会话改用「{name}」，下一条消息起生效", { name: provLabel(to) }));
    });
  }
  const switchWarn = (to) => t("这个会话改用「{name}」接着聊？\n\n之前的对话会整段交给新接口的模型重新读：提示缓存从头算，费用按新接口计；个别工具调用记录别家模型可能读不懂。", { name: provLabel(to) });

  // 上下文用量条的满刻度按当前会话的模型；会话真跑的就是全局那个型号时直接用全局那份（loadModels 顺手传进来）。
  // 没单独选过也不一定跟全局一样：项目可以有自己的默认接口 / 型号（#79），所以按网关算好的 sessEff 比，对不上就单查
  let ctxSeq = 0;
  const sameAsGlobal = (g) => !own() && !!state.sessEff && state.sessEff.provider === g.provider
    && (state.sessEff.model || state.sessEff.defaultModel || "") === (g.current || g.defaultModel || "");
  async function loadCtxModel(g) {
    const my = ++ctxSeq;
    let r = g;
    if (!r || !sameAsGlobal(r)) try { r = await api("/api/models" + sidQ()); } catch { return; }
    if (my !== ctxSeq) return;
    state.ctxTotal = Number(r.contextWindow) || 0;   // 0 = 这个型号不知道窗口：别沿用上一个型号的分母（#68）
    state.compactAt = Number(r.compactLine ?? r.autoCompactWindow) || 0;   // 生效的那条（超过模型窗口不算数，#67）
    updateCtx(state.ctxUsed, state.ctxTotal);
  }

  /** 模型与 effort 档位都从厂商的 /models 实时拉。设置页的下拉框是全局默认 */
  let modelsSeq = 0;
  async function loadModels(refresh) {
    const my = ++modelsSeq;
    try {
      const r = await api("/api/models" + (refresh ? "?refresh=1" : ""));
      // 连着改型号时清单响应可能乱序回来：只认最后一次发出的，旧的别把下拉框和容量盖回去（#80）
      if (my !== modelsSeq) return null;          // null = 被后一次顶掉了（不是失败），调用方别拿原始设置去盖
      MODELS = r.models || [];
      PJ.mLoaded = true;
      dropProvModels();
      if (r.providers) state.provList = r.providers;
      const sel = $("set-model");
      // 原生厂商（官方账户）：不挑 = 用它自己的默认模型。
      // 这时候列表框里得有个诚实的"默认"项 —— 否则列表第一条（比如 haiku）会顶在上面，
      // 让人以为正在用的就是它，其实 claude 用的是自己挑的那个。
      const dfltOpt = r.nativeModels
        ? (r.defaultModel ? `<option value="">${t("（默认：{model}）", { model: esc(r.defaultModel) })}</option>`
                           : `<option value="">${t("（默认，由 claude 决定）")}</option>`)
        : "";
      sel.innerHTML = (dfltOpt + (MODELS.length
        ? MODELS.map((m) => {
            const img = (m.input_modalities || []).includes("image") ? ' data-img="1"' : "";
            // 官方 /v1/models 只报能力，不报窗口 —— 报不出来就别写 "0k"
            const ctx = m.context_window ? Math.round(m.context_window / 1024) + "k" : "—";
            // 厂商常把 name 填成 id，那样就成了「id · id · 窗口」
            const nm = m.name && m.name !== m.id ? " · " + esc(m.name) : "";
            return `<option value="${esc(m.id)}"${img}>${esc(m.id)}${nm} · ${ctx}</option>`;
          }).join("")
        : (dfltOpt ? "" : '<option value="">' + t("（该厂商不提供模型清单）") + '</option>')));
      // 没单独指定（current=null）的非原生厂商：实际跑的是它的默认型号，没有默认就是清单第一个（和网关同一套），
      // 下拉框和下面的说明都按它画，别停在随便哪一项上（审查 #52 D-03）
      // 默认型号不在清单里也照它画（网关照样用它跑），不能退到第一项、拿别的型号的窗口冒充（#102 04-003）
      const curId = r.current || (!r.nativeModels && (r.defaultModel || MODELS[0]?.id)) || null;
      if (r.current) {
        sel.value = r.current;
        // 当前模型不在厂商 /models 的清单里（比如 DeepSeek 的 deepseek-flash 是兼容端点认的别名）：
        // 不补一项的话下拉框会显示空白，像是没选模型
        if (sel.value !== r.current) {
          sel.insertAdjacentHTML("afterbegin", `<option value="${esc(r.current)}">${esc(r.current)} · ${t("（当前，不在厂商清单里）")}</option>`);
          sel.value = r.current;
        }
      } else if (r.nativeModels) sel.value = "";
      else if (curId) {
        sel.value = curId;
        if (sel.value !== curId) {
          sel.insertAdjacentHTML("afterbegin", `<option value="${esc(curId)}">${esc(curId)} · ${t("（当前，不在厂商清单里）")}</option>`);
          sel.value = curId;
        }
      }
      $("model-count").textContent = t("{n} 个", { n: MODELS.length });
      // 自动起名的型号：跟对话 / 关 / 全局这家清单里的某个（存的不在清单里也补一项，别显示成空白）
      const tsel = $("set-titlemodel"), tv = state.settings.titleModel || "";
      tsel.innerHTML = `<option value="">${t("跟随对话的模型")}</option><option value="off">${t("不自动起名")}</option>`
        + MODELS.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
      if (tv && tv !== "off" && !MODELS.some((m) => m.id === tv)) tsel.insertAdjacentHTML("beforeend", `<option value="${esc(tv)}">${esc(tv)}</option>`);
      tsel.value = tv;
      renderEffort(r.effortLevels || [], r.effort || "", r.effortDefault);

      // 用量条：总刻度用厂商给的真实窗口，但设了压缩窗口就改以它为满刻度。
      // 网关回 0 就是不知道：别拿下拉框落在的那一项兜底，那可能是别的型号（#82）
      loadCtxModel(r);
      // 压缩线输入框是全局设置，和当前型号在不在清单里无关：型号清单为空、或当前型号是
      // 别名不在清单里（第三方接口常见）时也要回填，否则「Claude 行为」页一直显示旧值，
      // 用户再存一次旧值就把刚改的新值盖掉
      const ac = $("set-autocompact");
      if (ac && (acForce || document.activeElement !== ac)) ac.value = r.autoCompactWindow || "";
      const cur = MODELS.find((m) => m.id === curId);
      if (cur) {
        const k = (v) => (v ? Math.round(v / 1024) + "k" : "—");
        // 纯文字：厂商 /models 返回的内容不可信（审查 v0.5.5 Web-M1），不经 innerHTML
        $("model-info").textContent =
                    t("上下文 {n} · 输出上限 {out} · 输入 {mods}", { n: k(cur.context_window), out: k(cur.max_output_tokens), mods: (cur.input_modalities || []).join(" / ") }) +
          t("｜这是默认值；单个会话在输入栏下面的模型标签里另选");
      } else if (r.nativeModels) {
        $("model-info").innerHTML =
                    t("没指定模型 → <b>由 claude 自己决定</b>（官方账户当前默认 <code>{model}</code>）。", { model: esc(r.defaultModel || t("claude 内置默认")) }) +
          t("<br>上面的清单就是账户里能用的全部型号，挑一个即锁定。");
      } else if (!MODELS.length) {
        $("model-info").innerHTML =
                    t("该厂商由 claude 自己决定模型，没有可切换的清单。要指定就改 <code>ccapp-providers.json</code> 的 <code>defaultModel</code>。");
      } else $("model-info").textContent = "";    // 上一家的能力说明别留着（审查 #52 D-03）
      // 设置页是全局默认：只按全局型号的窗口画，不借顶栏当前会话的 state.ctxTotal（#76）
      acPaint(Number(r.contextWindow) || 0, r.autoCompactWindow, r.compactDefault);
      return true;
    } catch (e) {
      if (my !== modelsSeq) return null;
      $("model-info").textContent = t("拉取模型清单失败：{msg}", { msg: e.message });
      return false;
    }
  }

  // 下拉框换成分段（照稿）：下拉框留着当真身，分段只是它的镜子 —— 选项变了、代码里改了 value 都跟着重画
  // 输入框也能挂（opts 给定选项，输入框留着填别的数）
  function segMirror(sel, label, opts) {
    const seg = document.createElement("span");
    seg.className = "seg seg-mirror";
    if (opts) sel.before(seg); else { sel.after(seg); sel.classList.add("hidden"); }
    const list = () => opts ? opts.map((v) => ({ value: v })) : [...sel.options];
    let more = false;   // 输入框模式：值不在选项里、或点了「更多」才露出输入框
    const paint = () => {
      const hit = list().some((o) => o.value === String(sel.value));
      seg.innerHTML = list().map((o) => `<button data-v="${esc(o.value)}" class="${o.value === String(sel.value) ? "on" : ""}">${esc(label(o))}</button>`).join("")
        + (opts ? `<button data-v="__more" class="${hit ? "" : "on"}">${esc(t("更多"))}</button>` : "");
      if (opts) sel.classList.toggle("hidden", hit && !more);
    };
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value");
    Object.defineProperty(sel, "value", { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); paint(); } });
    if (!opts) new MutationObserver(paint).observe(sel, { childList: true });
    sel.addEventListener("change", paint);
    seg.addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (!b || b.dataset.v === sel.value) return;
      if (b.dataset.v === "__more") { more = true; paint(); sel.focus(); return; }
      more = false; sel.value = b.dataset.v; sel.dispatchEvent(new Event("change")); });
    paint();
  }
  segMirror($("set-effort"), (o) => o.value || t("默认"));
  const PERM_SHORT = { default: "问我", acceptEdits: "接受编辑", plan: "计划", auto: "自动", dontAsk: "不问就拒", bypassPermissions: "全部放行" };
  // 权限模式用原生下拉：六项带说明，分段控件在手机上塞不下
  segMirror($("set-parallel"), (o) => o.value, ["1", "2", "3", "4"]);
  // 设置里的「打开用量页」
  $("set-ov").addEventListener("click", (e) => { const b = e.target.closest("[data-gopage]"); if (b) { closeSettings(); openPage(b.dataset.gopage); } });
  function paintSetUsage() {
    const q = usDash.quota, e = $("set-us-quota");
    $("set-us-quota-row").classList.toggle("hidden", !q);
    if (!q) return;
    e.textContent = Math.round(q.used) + "%";
    const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
    $("set-us-quota-sub").textContent = at ? t("{time} 重置", { time: at.toLocaleDateString([], { weekday: "short" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
  }

  function renderEffort(levels, current, dflt) {
    const sel = $("set-effort");
    // 留一个"不指定"：没设过档位时 claude 按模型自己的默认走。
    // 以前没这一项，下拉框会显示第一档 low，让人以为正在用 low，而且一旦选过就再也撤不回默认
    sel.innerHTML = (dflt ? `<option value="">${t("（默认：{model}）", { model: esc(dflt) })}</option>`
                            : `<option value="">${t("（默认，由 claude 按模型决定）")}</option>`) +
      levels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
    sel.value = current && levels.includes(current) ? current : "";
    $("effort-info").innerHTML =
      t("档位越高思考越久。这是默认值；单个会话在输入栏下面另选");
  }

  async function loadSettings() {
    try {
      // 读的时候有保存在排队 / 在路上，或者读的途中又点了保存：这份快照可能早于那次保存，
      // 拿它整份盖 state.settings 和控件，刚存上的值就在界面上退回去了。等保存排完再重读一次（UIFS-010 第二条）
      const busy = savePending > 0, gen = saveGen;
      const s = await api("/api/settings");
      if (busy || gen !== saveGen) return saveQ.then(() => loadSettings());
      state.settings = s;
      $("set-perm").value = state.settings.permissionMode || "default";
      // 输出风格清单由网关列（内置 + 自定义 .md），不再写死 —— 以前写死的 concise 根本不存在
      $("set-style").innerHTML = '<option value="">' + t("（默认）") + '</option>' +
        (state.settings.outputStyles || []).map((o) =>
          `<option value="${esc(o.id)}">${esc(o.id)}${o.desc ? " · " + esc(o.desc) : ""}</option>`).join("");
      $("set-style").value = state.settings.outputStyle || "";
      // 没指定模型时别把顶栏写成 "—"：init 报过的真实模型更有用
      paintModel(curModel() || state.model || t("默认"));
      setPermChip(state.settings.permissionMode || "default");
      renderPermBar();
      renderDirs();
      fillMem();
      await loadProviders();
      // 清单拉成功时下拉框已经按网关算好的「实际生效」选上了；再拿原始设置盖一遍，
      // 存的值这家不支持（比如 high，这家只有 low/medium）就成了空白（审查 D-03）。拉失败才退回原始值
      if ((await loadModels()) === false) {
        $("set-model").value = state.settings.model || "";
        $("set-effort").value = state.settings.effort || "";
      }
      const pe = $("set-parallel");
      if (pe && document.activeElement !== pe) { pe.max = state.settings.maxParallelCap || 16; pe.value = state.settings.maxParallel || 3; }
      $("set-static").checked = state.settings.staticCompat !== false;
      $("set-idlecompact").checked = state.settings.idleCompaction !== false;
      $("set-workisland").checked = state.settings.workIsland === true;
      loadWorkIsland();
      loadExecMode();
    } catch {}
  }


  // 附加目录的增删串行化：连点两次时，第二次要基于第一次存完的结果算，不能各自拿着旧数组互相覆盖（195-E.12）
  let dirQ = Promise.resolve();
  function updateDirs(fn) {
    dirQ = dirQ.then(async () => {
      // 网关对 addDirs 是整组替换：先取它当前存的那组做底，别拿前端可能还没加载到的默认值把它清空（195-E.8）
      let base = state.settings.addDirs || [];
      try { const r = await api("/api/settings"); if (r && Array.isArray(r.addDirs)) base = r.addDirs; } catch {}
      return saveSettings({ addDirs: fn(base) });
    });
    return dirQ;
  }
  function renderDirs() {
    const dirs = state.settings.addDirs || [];
    $("dir-toggle").textContent = t("{n} 个", { n: dirs.length });
    $("dir-list").innerHTML = dirs.length
      ? dirs.map((d, i) => `<div class="item"><div class="it-title wrap" title="${esc(d)}">${esc(d)}</div>
          <div class="it-acts"><button data-i="${i}">${t("移除")}</button></div></div>`).join("")
      : '<div class="tiny">' + t("（没有附加目录）") + '</div>';
    $("dir-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const gone = (state.settings.addDirs || [])[Number(b.dataset.i)];
      if (gone == null) return;
      updateDirs((ds) => ds.filter((d) => d !== gone));   // 按目录名删：连点时下标会变
    }));
  }

  // 附加目录照稿收成一个「N 个」按钮，点开才是清单和添加框
  $("dir-toggle").addEventListener("click", () => document.querySelectorAll("#dir-field .dir-more").forEach((x) => x.classList.toggle("hidden")));

  // 普通设置也串行保存（UIFS-010）：连点两次时两个请求并发，回执乱序的话，旧回执里那份整份
  // settings 快照会把后一次保存的结果在 state.settings 和控件上盖回去。排队后按点击顺序发请求、
  // 回执按序到达，合并整份快照就不会倒退。失败照旧只回滚自己这次的 patch（revertSet）。
  let saveQ = Promise.resolve(), saveGen = 0, savePending = 0;   // 后两个给 loadSettings 判断快照是否过时
  function saveSettings(patch) {
    saveGen++; savePending++;
    const run = () => saveSettingsNow(patch);
    const p = saveQ.then(run, run);
    saveQ = p.catch(() => {}).finally(() => { savePending--; });
    return p;
  }
  async function saveSettingsNow(patch) {
    try {
      const r = await api("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      state.settings = { ...state.settings, ...(r.settings || {}) };
      paintModel(curModel() || state.model || t("默认"));
      if ("model" in patch || "effort" in patch) refreshSessModel();   // 跟随默认的会话，标签跟着变
      setPermChip(state.settings.permissionMode || "default");
      renderDirs();
            toast(t("已保存"));
      return r;
    } catch (e) { toast(e.message || t("保存失败"), true); revertSet(patch); }
  }
  // 没存上：控件回到真正存着的值，别留着没保存的样子让人以为生效了（审查 D-05）
  function revertSet(patch) {
    const S = state.settings || {};
    const v = { model: ["set-model", S.model || ""], titleModel: ["set-titlemodel", S.titleModel || ""], effort: ["set-effort", S.effort || ""], outputStyle: ["set-style", S.outputStyle || ""],
      maxParallel: ["set-parallel", S.maxParallel || 3] };
    const c = { staticCompat: ["set-static", S.staticCompat !== false], idleCompaction: ["set-idlecompact", S.idleCompaction !== false],
      workIsland: ["set-workisland", S.workIsland === true] };
    for (const k of Object.keys(patch || {})) {
      if (v[k] && $(v[k][0])) $(v[k][0]).value = v[k][1];
      if (c[k] && $(c[k][0])) $(c[k][0]).checked = c[k][1];
    }
    if ("model" in patch || "effort" in patch) loadModels();
  }

  $("set-provider").addEventListener("change", (e) => {
    state.provView = e.target.value; provOpen = null;
    renderProvCard();
  });

  // 设置页的模型 / 思考强度是全局默认：新会话、没在输入栏面板里单独选过的会话都用它
  $("set-model").addEventListener("change", async (e) => {
    if (!(await saveSettings({ model: e.target.value }))) return;
    await loadModels();                                  // 换模型后 effort 档位可能不同
  });
  $("set-perm").addEventListener("change", (e) => changePermMode(e.target.value));
  $("set-style").addEventListener("change", (e) => saveSettings({ outputStyle: e.target.value }));
  $("set-effort").addEventListener("change", (e) => saveSettings({ effort: e.target.value }));
  $("set-titlemodel").addEventListener("change", (e) => saveSettings({ titleModel: e.target.value }));

  $("set-static").addEventListener("change", (e) => saveSettings({ staticCompat: e.target.checked }));
  // 执行方式：存在 files/.exec-mode，重启网关生效（36 的包选「直接执行」网关会拒）
  let execPid = 0;
  async function loadExecMode() {
    try {
      const r = await api("/api/exec-mode");
      execPid = r.pid || 0;
      $("set-exec").value = r.pref;
      $("set-exec").querySelector('option[value="direct"]').disabled = !!r.must;
      let now = t("现在是：{mode}", { mode: t(r.active === "loader" ? "经加载器" : "直接执行") });
      if (r.ldso === "differ" || r.ldso === "missing") now += " · " + t("安装包里的 glibc 加载器和工具包里的不是同一版，经加载器暂时用不了：先更新工具包");
      $("exec-now").textContent = now;
    } catch {}
  }
  $("set-exec").addEventListener("change", async (e) => {
    try {
      await api("/api/exec-mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: e.target.value }) });
      if (confirm(t("执行方式已保存。现在重启网关让它生效吗？打开的终端会断开。"))) {
        await api("/api/exec-mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ restart: true }) });
        toast(t("网关重启中…"));
        // 旧网关 300ms 后才退：等到换了 pid 的新网关答话再刷新「现在是」，不然读到的还是旧状态
        const old = execPid;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 750));
          try { const r = await api("/api/exec-mode"); if (r.pid && r.pid !== old) break; } catch {}
        }
      }
    } catch (err) { toast(err.message || String(err)); }
    loadExecMode();
  });
  $("set-idlecompact").addEventListener("change", (e) => saveSettings({ idleCompaction: e.target.checked }));
  // 敏感操作再确认没有开关：一直开着，只在设置里说明它管什么（反破甲 11-03）
  const extSync = () => { $("set-extimg").checked = uiGet("extImg") !== "auto"; };
  extSync(); document.addEventListener("cc:ui", (e) => { if (e.detail.key === "extImg" || e.detail.key == null) extSync(); });
  $("set-extimg").addEventListener("change", (e) => uiSet("extImg", e.target.checked ? null : "auto"));
  // 工作岛起没起来（195-P.4）：检测要几秒（pm 再加 am 探一次），开关 / 重试之后隔几秒再看
  async function loadWorkIsland() {
    const r = await api("/api/work-island").catch(() => null), box = $("wi-state");
    const show = !!(r && r.supported && r.wanted && !r.started && !r.detecting && r.error);
    box.classList.toggle("hidden", !show);
    if (!show) return;
    $("wi-state-txt").textContent = r.error.code === "blocked"
      ? t("系统不允许本应用启动工作岛服务，所以没有显示。") + (r.error.detail ? "（" + r.error.detail + "）" : "")
      : t("没检测到「工作岛」应用：装好后点重试。");
  }
  const wiLater = () => { for (const ms of [2000, 6000, 10000]) setTimeout(loadWorkIsland, ms); };
  $("wi-retry").addEventListener("click", async () => {
    await post("/api/work-island/retry").catch((e) => toast(e.message, true));
    $("wi-state").classList.add("hidden");
    wiLater();
  });
  $("set-workisland").addEventListener("change", (e) => saveSettings({ workIsland: e.target.checked }).then(wiLater));
  $("set-parallel").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (!(v >= 1)) { e.target.value = state.settings.maxParallel || 3; return; }
    saveSettings({ maxParallel: v }).then(() => { e.target.value = state.settings.maxParallel || v; });
  });
  // ── 压缩线滑块（接口与型号页）：0–100 映射到 [100k, 模型窗口]；没设 = 交给 claude，滑块停在最右、虚线轨道 ──
  // 100k 是 claude 认的下限（gw/models.mjs 的 defaultCompactLine 注释：只认 100k–1M），
  // 以前允许 20k，上下文条按 20k 显示满格、claude 实际按 100k 压（0.6.10 审计 195-O.2）
  const AC_MIN = 100000;
  const AC_MAX = 1000000;
  let acWin = 0, acSet = 0, acDef = 0, acForce = false;   // acDef：没设时网关给第三方型号的默认线（0 = 交给 claude）   // acForce：刚存过，焦点还在控件上也按存下的值回填（没存上就弹回去）
  function acStep() { return Math.max(1000, Math.ceil((acWin - AC_MIN) / 100 / 1000) * 1000); }
  function acTok(p) { return Math.min(acWin, Math.round((AC_MIN + (acWin - AC_MIN) * p / 100) / acStep()) * acStep()); }
  function acPos(v) { return Math.max(0, Math.min(100, (v - AC_MIN) / (acWin - AC_MIN) * 100)); }
  function acShow(v) {
    const rg = $("ac-range"), pct = v ? acPos(v) : acDef ? acPos(acDef) : 100;
    rg.style.setProperty("--p", pct + "%");
    $("ac-range").parentNode.classList.toggle("auto", !v);
    $("ac-val").textContent = v ? t("{line} · 窗口的 {pct}%", { line: fmtTok(v), pct: Math.round(v / acWin * 100) })
      : acDef ? t("没设：默认 {line} · 窗口的 {pct}%", { line: fmtTok(acDef), pct: Math.round(acDef / acWin * 100) })
      : t("没设，交给 claude 按窗口决定");
    $("ac-auto").classList.toggle("hidden", !v);
  }
  function acPaint(win, set, def) {
    const box = $("ac-slide");
    acWin = Number(win) || 0; acSet = Number(set) || 0; acDef = Number(def) || 0;
    const unknown = acWin <= AC_MIN;
    // 窗口未知（厂商清单没报）：滑块没法按窗口换算，但用户仍得能改压缩线（195-E.10）。
    // 换成数字框，设过的值照原样显示、可改；claude 对未知窗口按 200k 上限压（gw/models.mjs 的 compactLineOf）。
    box.classList.remove("hidden");
    if (unknown) {
      $("ac-range").parentNode.classList.add("hidden");
      box.querySelector(".ac-scale").classList.add("hidden");
      $("ac-manual").classList.remove("hidden");
      const num = $("ac-num");
      if (acForce || document.activeElement !== num) num.value = acSet ? String(acSet) : "";
      acForce = false;
      $("ac-val").textContent = acSet
        ? t("已设 {line}（模型窗口未知，按你设的生效）", { line: fmtTok(acSet) })
        : t("未填（按 200k 算）");
      $("ac-auto").classList.toggle("hidden", !acSet);
      return;
    }
    $("ac-range").parentNode.classList.remove("hidden");
    box.querySelector(".ac-scale").classList.remove("hidden");
    $("ac-manual").classList.add("hidden");
    const rg = $("ac-range");
    if (acForce || document.activeElement !== rg) rg.value = acSet ? acPos(acSet) : acDef ? acPos(acDef) : 100;
    acForce = false;
    $("ac-min").textContent = fmtTok(AC_MIN); $("ac-max").textContent = fmtTok(acWin);
    acShow(acSet);
  }
  /** 滑块和两个数字框共用同一套保存规则：空 / 0 / 乱填 = 交给 claude；claude 只认 100k–1M */
  function acSaveFrom(el) {
    const raw = el.value.trim();
    let n = raw ? Math.round(Number(raw)) : null;
    if (n == null || !Number.isFinite(n) || n <= 0) n = null;   // 空 / 0 / 乱填 = 交给 claude
    else if (n < AC_MIN) {
      // 更小的它按 100k 处理：界面别让人设成 20k，免得上下文条按 20k 显示满格（195-O.2）
      n = AC_MIN;
      toast(t("压缩线最小 100k，已按 100k 存"));
    } else if (n > AC_MAX) n = AC_MAX;
    el.value = n == null ? "" : String(n);
    saveSettings({ autoCompactWindow: n }).then(() => { acForce = true; return loadModels(); });
  }
  $("ac-range").addEventListener("input", (e) => acShow(acTok(+e.target.value)));
  $("ac-range").addEventListener("change", (e) => {
    const v = acTok(+e.target.value);
    saveSettings({ autoCompactWindow: v }).then(() => { acForce = true; return loadModels(); });
  });
  $("ac-auto").addEventListener("click", () => saveSettings({ autoCompactWindow: null }).then(() => { acForce = true; return loadModels(); }));
  $("set-autocompact").addEventListener("change", (e) => acSaveFrom(e.target));
  $("ac-num").addEventListener("change", (e) => acSaveFrom(e.target));
  $("btn-add-dir").addEventListener("click", async () => {
    const v = $("inp-dir").value.trim();
    if (!v) return;
    const r = await updateDirs((ds) => (ds.includes(v) ? ds : [...ds, v]));
    if (r) $("inp-dir").value = "";   // 没存上时留着输入，改一下还能重试
  });
  $("btn-cli-doctor").addEventListener("click", async () => {
    const box = $("cli-out");
    box.classList.remove("hidden");
    box.textContent = t("正在运行 claude doctor…");
    try {
      const r = await api("/api/cli?cmd=" + encodeURIComponent("doctor"));
      box.textContent = (r.out || "") + (r.err ? "\n" + r.err : "") || t("(无输出)");
    } catch (e) { box.textContent = t("失败：{msg}", { msg: e.message }); }
  });

  // ── 能力面板 ──────────────────────────────────────────────────────
  function cacheCapsFromInit(ev) {
    state.caps = state.caps || {}; state.capsErr = "";
    state.caps.tools = ev.tools || state.caps.tools || [];
    state.caps.skills = ev.skills || state.caps.skills || [];
    state.caps.agents = ev.agents || state.caps.agents || [];
    state.caps.mcpServers = ev.mcpServers || state.caps.mcpServers || [];
    state.caps.slashCommands = (ev.slashCommands || []).filter((c) => !String(c).startsWith("__"))
      .map((c) => (typeof c === "string" ? { name: c, cat: t("其他"), desc: "" } : c));
    renderCaps();
  }

  async function loadCaps() {
    try {
      state.caps = await api("/api/capabilities"); state.capsErr = "";
      renderCaps();
    } catch (e) {
      // 一次都没拿到过：说清楚读取失败、给重试，别只剩空标题（审查 F-008）
      state.capsErr = e.message || "?";
      if (!state.caps) { renderCaps(); $("cap-tiles").innerHTML = `<div class="tile big"><span class="k">${esc(t("能力清单读取失败：{msg}", { msg: state.capsErr }))}</span><button class="btn sm ghost" id="caps-retry">${esc(t("重试"))}</button></div>`; }
      // 读成过、这次刷新失败：旧清单照摆，顶上标明是上次的并给重试（审查 F-008 复测）
      else renderCaps();
    }
  }

  function chips(el, arr, hl) {
    el.innerHTML = arr?.length
      ? arr.map((x) => `<span class="chip ${hl ? "hl" : ""}">${esc(x)}</span>`).join("")
      : '<span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + '</span>';
  }

  // 工具的权限：规则优先（deny > ask > allow，Bash(git:*) 这种带括号的算「按规则」），否则看权限模式；只读的工具默认允许
  const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite", "TodoRead", "Task", "Agent", "NotebookRead", "ExitPlanMode", "BashOutput", "KillShell", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  function toolPerm(name, mode, rules) {
    // mcp__服务名 这样的规则管这个服务下的全部工具
    const hit = (list) => (list || []).some((r) => r === name || (r.endsWith("*") && name.startsWith(r.slice(0, -1))) || (r.startsWith("mcp__") && !r.slice(5).includes("__") && name.startsWith(r + "__")));
    const part = (list) => (list || []).some((r) => r.startsWith(name + "("));
    if (hit(rules.deny)) return "deny";
    if (hit(rules.ask)) return "ask";
    if (hit(rules.allow)) return "allow";
    // 带括号的拒绝 / 询问规则在任何模式下都照样生效：不能因为是免确认模式或只读工具就标「允许」
    if (part(rules.deny) || part(rules.ask)) return "rule";
    if (mode === "bypassPermissions") return "allow";
    if (mode === "plan" && (EDIT_TOOLS.has(name) || name === "Bash")) return "deny";
    if (mode === "acceptEdits" && EDIT_TOOLS.has(name)) return "allow";
    if (READ_TOOLS.has(name)) return "allow";
    if (part(rules.allow) || part(rules.deny)) return "rule";
    return "ask";
  }
  const permPill = (p) => ({ allow: `<span class="pill ok"><svg class="ei" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg> ${t("允许")}</span>`, ask: `<span class="pill">${t("询问")}</span>`,
    deny: `<span class="pill err"><svg class="ei" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg> ${t("拒绝")}</span>`, rule: `<span class="pill acc">${t("按规则")}</span>` }[p]);
  const capRows = (arr, fn) => arr?.length ? arr.map(fn).join("") : '<div class="row"><span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + "</span></div>";

  function renderCaps() {
    const c = state.caps || {};
    setPageSub("caps", c.version ? t("Claude Code {ver} · 这一轮能用的", { ver: c.version }) : t("这一轮 Claude 能用的"));
    const cmds = c.slashCommands || [];
    const mcp = (c.mcpServers || []).map((m) => typeof m === "string" ? { name: m } : m);
    const mcpOk = mcp.filter((m) => /^connected$/i.test(m.status || "")).length;
    const N = { cmd: cmds.length, tool: (c.tools || []).length, skill: (c.skills || []).length, agent: (c.agents || []).length, mcp: mcp.length && mcpOk < mcp.length ? mcpOk + "/" + mcp.length : mcp.length, plugin: (c.plugins || []).length };
    // 计数格：图标 + 大号数字 + 名字；点了跳到那一节
    const icoOf = (k) => document.querySelector(`#tab-caps [data-sec="${k}"] .icobox`)?.innerHTML || "";
    const nameOf = (k) => document.querySelector(`#tab-caps [data-sec="${k}"] .sec-h h3`)?.textContent || k;
    $("cap-tiles").innerHTML = Object.keys(N).map((k) => `<button class="tile" data-sec="${k}"><span class="icobox">${icoOf(k)}</span><span class="n num">${N[k]}</span><span class="k">${esc(nameOf(k))}</span></button>`).join("")
      + (state.capsErr ? `<div class="tile big"><span class="k">${esc(t("刷新失败，显示的是上次读到的清单：{msg}", { msg: state.capsErr }))}</span><button class="btn sm ghost" id="caps-retry">${esc(t("重试"))}</button></div>` : "");
    // 斜杠命令：卡片（命令 + 说明），点一下插进输入框
    $("caps-cmds").innerHTML = cmds.length
      ? cmds.map((x) => { const n = "/" + (x.name || x); return `<button class="cmd-card" data-cmd="${esc(n)}"><span class="mono">${esc(n)}</span><span>${esc(x.desc ? t(x.desc) : "")}</span></button>`; }).join("")
      : '<span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + '</span>';
    const mode = state.permissionMode || c.permissionMode || "default", rules = c.rules || { allow: [], ask: [], deny: [] };
    const nRules = rules.allow.length + rules.ask.length + rules.deny.length;
    $("caps-permline").textContent = t("权限模式：{m} · 规则 {n} 条", { m: modeLabel(mode), n: nRules });
    $("caps-tools").innerHTML = capRows(c.tools, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span>${permPill(toolPerm(x, mode, rules))}</div>`);
    $("caps-skills").innerHTML = capRows(c.skills, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    $("caps-agents").innerHTML = capRows(c.agents, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    $("caps-mcp").innerHTML = capRows(mcp, (m) => { const ok = /^connected$/i.test(m.status || ""), bad = /fail|error|disconn/i.test(m.status || "");
      return `<div class="row"><span class="mono grow">${esc(m.name)}</span>${sdot(ok ? "ok" : bad ? "err" : "", ok ? t("已连接") : bad ? t("没连上") : m.status || "—")}</div>`; });
    $("caps-plugins").innerHTML = capRows(c.plugins, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    filterCaps();
  }
  // 搜索：同时筛命令卡片和各节的标签；一节里一个都不剩就整节先藏起来
  function filterCaps() {
    const q = ($("caps-q").value || "").trim().toLowerCase();
    for (const sec of document.querySelectorAll("#tab-caps > .ext-sec-plain")) {
      let any = !q;
      for (const el of sec.querySelectorAll(".cmd-card, .panel > .row")) {
        const hit = !q || el.textContent.toLowerCase().includes(q);
        el.classList.toggle("hidden", !hit); any ||= hit;
      }
      sec.classList.toggle("hidden", !any);
    }
  }
  $("caps-q").addEventListener("input", filterCaps);
  $("caps-rules").addEventListener("click", () => openSettings("claude"));
  $("cap-tiles").addEventListener("click", (e) => {
    const rt = e.target.closest("#caps-retry"); if (rt) { rt.disabled = true; return loadCaps(); }
    const b = e.target.closest("[data-sec]"), x = b && document.querySelector(`#tab-caps > [data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body");
    body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - 12, behavior: "smooth" });
  });
  $("caps-cmds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]"); if (!b) return;
    closePage();
    insertAtCursor(b.dataset.cmd); inputEl.focus();   // 不覆盖未发送草稿（196 输入框域）
  });

  $("btn-refresh-mcp").addEventListener("click", async () => {
    $("caps-mcp").innerHTML = '<div class="row"><span class="tiny">' + esc(t("查询中…")) + "</span></div>";
    try {
      const r = await api("/api/cli?cmd=" + encodeURIComponent("mcp list"));
      const lines = (r.out || "").split("\n").map((s) => s.trim()).filter(Boolean);
      // claude mcp list 一行一个：「名字: 命令 - ✓ Connected」/「✗ Failed to connect」
      $("caps-mcp").innerHTML = capRows(lines.filter((l) => /:\s/.test(l) && /connect|fail|need/i.test(l)).slice(0, 40), (l) => {
        const name = l.split(":")[0], ok = /✓|connected/i.test(l) && !/fail|✗/i.test(l);
        return `<div class="row"><span class="mono grow">${esc(name)}</span>${sdot(ok ? "ok" : "err", ok ? t("已连接") : t("没连上"))}</div>`;
      }) || '<div class="row"><span class="tiny">' + esc(t("(无 MCP 服务器)")) + "</span></div>";
    } catch (e) { $("caps-mcp").innerHTML = '<div class="row"><span class="tiny">' + esc(t("查询失败：{msg}", { msg: e.message })) + "</span></div>"; }
  });


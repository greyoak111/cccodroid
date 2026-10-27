  // ── 模型标签与快速切换（输入栏下面那一行最左边）──
  // 标签写「模型 · 思考强度」；点它从底部弹面板：上面一排思考强度，下面搜索 + 最近用过 + 全部模型。
  // 不占输入区的地方。OpenRouter 这类几十上百个模型的，靠搜索框过滤。
  const RECENT_KEY = "cc.recentModels";
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
  async function pickSessModel(patch) {
    if (!view.sessionId) {
      state.pendingModel = patch ? { ...(state.pendingModel || {}), ...patch } : null;
      return refreshSessModel();
    }
    const r = await api("/api/session-model", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch ? { id: view.sessionId, ...patch } : { id: view.sessionId, reset: true }) });
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
  }
  modelEl.setAttribute("role", "button");
  modelEl.tabIndex = 0;
  modelEl.addEventListener("click", (e) => { e.stopPropagation(); openModelPicker(); });

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
    const paintFollow = () => {
      const d = state.settings || {};
      const usable = (state.provList || []).filter((p) => p.usable).length;
      const dm = (usable > 1 ? provLabel(globalProv()) + " · " : "") + (prettyModel(d.model) || t("默认")) + (d.effort ? " · " + d.effort : "");
      followBox.innerHTML = own()
        ? `<button type="button" class="mp-item mp-reset"><span>${esc(t("改回跟随默认"))}</span><small>${esc(dm)}</small></button>`
        : `<div class="tiny">${esc(t("跟随默认：{model}", { model: dm }))}</div>`;
    };
    paintFollow();
    followBox.addEventListener("click", async (e) => {
      if (!e.target.closest(".mp-reset")) return;
      if (curProv() !== globalProv() && view.sessionId && !confirm(switchWarn(globalProv()))) return;
      close();
      try { await pickSessModel(null); } catch (er) { return toast(er.message, true); }
      paintModel(chipName());
      loadCtxModel();
    });
    effBox.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-eff]");
      if (!b) return;
      try { await pickSessModel({ effort: b.dataset.eff }); } catch (er) { return toast(er.message, true); }
      info.effort = b.dataset.eff;
      paintEff(effLevels, b.dataset.eff);
      paintFollow();
      paintModel(state.chipModel || chipName());
    });

    // 接口：能用的（有 Key、走登录、本机）才列；只有一家就不显示这一行
    const provWrap = m.querySelector(".mp-provwrap"), provBox = m.querySelector(".mp-prov");
    const paintProv = () => {
      const ps = (state.provList || []).filter((p) => p.usable || p.id === curProv());
      provWrap.classList.toggle("hidden", ps.length < 2);
      provBox.innerHTML = `<div class="seg mp-seg mp-provseg">${ps.map((p) =>
        `<button type="button" class="${p.id === browse ? "on" : ""}${p.id === curProv() ? " cur" : ""}" data-prov="${esc(p.id)}">${esc(provLabel(p.id))}</button>`).join("")}</div>` +
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
      return { text: [md.name && md.name !== md.id ? md.name : "", ctx].filter(Boolean).join(" · "), img: (md.input_modalities || []).includes("image") };
    };
    function paintList() {
      const kw = q.value.trim().toLowerCase();
      const all = ML.filter((md) => !kw || md.id.toLowerCase().includes(kw) || String(md.name || "").toLowerCase().includes(kw));
      let html = "";
      if (!kw) {
        if (info.nativeModels) html += row("", info.defaultModel ? t("（默认：{model}）", { model: info.defaultModel }) : t("（默认，由 claude 决定）"));
        // 当前在用的那个总排在「最近用过」头一个：不然清单一长，打开弹层根本看不到现在用的是哪个
        const rec = [...new Set([cur(), ...JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")])].filter((id) => id && ML.some((md) => md.id === id));
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
      if (id) localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((x) => x !== id)].slice(0, 6)));
      close();
      if (!switching && id === cur() && own() && own().model != null) return;   // 跟随默认时点同一个也算「单独选」：钉住，默认再改它也不变
      try { await pickSessModel(switching ? { provider: to, model: id } : { model: id }); } catch (er) { return toast(er.message, true); }
      paintModel(chipName());
      loadCtxModel();
      if (switching) toast(t("这个会话改用「{name}」，下一条消息起生效", { name: provLabel(to) }));
    });
  }
  const switchWarn = (to) => t("这个会话改用「{name}」接着聊？\n\n之前的对话会整段交给新接口的模型重新读：提示缓存从头算，费用按新接口计；个别工具调用记录别家模型可能读不懂。", { name: provLabel(to) });

  // 上下文用量条的满刻度按当前会话的模型；跟随默认时直接用全局那份（loadModels 顺手传进来）
  let ctxSeq = 0;
  async function loadCtxModel(g) {
    const my = ++ctxSeq;
    let r = g;
    if (own() || !r) try { r = await api("/api/models" + sidQ()); } catch { return; }
    if (my !== ctxSeq) return;
    if (r.contextWindow) state.ctxTotal = r.contextWindow;
    state.compactAt = Number(r.autoCompactWindow) || 0;
    updateCtx(state.ctxUsed, state.ctxTotal);
  }

  /** 模型与 effort 档位都从厂商的 /models 实时拉。设置页的下拉框是全局默认 */
  async function loadModels(refresh) {
    try {
      const r = await api("/api/models" + (refresh ? "?refresh=1" : ""));
      MODELS = r.models || [];
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
            return `<option value="${esc(m.id)}"${img}>${esc(m.id)} · ${esc(m.name || "")} · ${ctx}</option>`;
          }).join("")
        : (dfltOpt ? "" : '<option value="">' + t("（该厂商不提供模型清单）") + '</option>')));
      if (r.current) {
        sel.value = r.current;
        // 当前模型不在厂商 /models 的清单里（比如 DeepSeek 的 deepseek-flash 是兼容端点认的别名）：
        // 不补一项的话下拉框会显示空白，像是没选模型
        if (sel.value !== r.current) {
          sel.insertAdjacentHTML("afterbegin", `<option value="${esc(r.current)}">${esc(r.current)} · ${t("（当前，不在厂商清单里）")}</option>`);
          sel.value = r.current;
        }
      } else if (r.nativeModels) sel.value = "";
      $("model-count").textContent = t("{n} 个", { n: MODELS.length });
      renderEffort(r.effortLevels || [], r.effort || "", r.effortDefault);

      // 用量条：总刻度用厂商给的真实窗口，但设了压缩窗口就改以它为满刻度
      loadCtxModel(r);
      const cur = MODELS.find((m) => m.id === r.current);
      if (cur) {
        const k = (v) => (v ? Math.round(v / 1024) + "k" : "—");
        $("model-info").innerHTML =
                    t("上下文 {n} · 输出上限 {out} · 输入 {mods}", { n: k(cur.context_window), out: k(cur.max_output_tokens), mods: (cur.input_modalities || []).join(" / ") }) +
          t("｜这是默认值；单个会话在输入栏下面的模型标签里另选");
        const ac = $("set-autocompact");
        if (ac && document.activeElement !== ac) ac.value = r.autoCompactWindow || "";
      } else if (r.nativeModels) {
        $("model-info").innerHTML =
                    t("没指定模型 → <b>由 claude 自己决定</b>（官方账户当前默认 <code>{model}</code>）。", { model: esc(r.defaultModel || t("claude 内置默认")) }) +
          t("<br>上面的清单就是账户里能用的全部型号，挑一个即锁定。");
      } else if (!MODELS.length) {
        $("model-info").innerHTML =
                    t("该厂商由 claude 自己决定模型，没有可切换的清单。要指定就改 <code>ccapp-providers.json</code> 的 <code>defaultModel</code>。");
      }
      acPaint((cur && cur.context_window) || state.ctxTotal, r.autoCompactWindow);
    } catch (e) {
      $("model-info").textContent = t("拉取模型清单失败：{msg}", { msg: e.message });
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
      state.settings = await api("/api/settings");
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
      await loadModels();
      $("set-model").value = state.settings.model || "";
      $("set-effort").value = state.settings.effort || "";
      const pe = $("set-parallel");
      if (pe && document.activeElement !== pe) { pe.max = state.settings.maxParallelCap || 16; pe.value = state.settings.maxParallel || 3; }
      $("set-static").checked = state.settings.staticCompat !== false;
      $("set-idlecompact").checked = state.settings.idleCompaction !== false;
      $("set-workisland").checked = state.settings.workIsland === true;
      loadExecMode();
    } catch {}
  }


  function renderDirs() {
    const dirs = state.settings.addDirs || [];
    $("dir-toggle").textContent = t("{n} 个", { n: dirs.length });
    $("dir-list").innerHTML = dirs.length
      ? dirs.map((d, i) => `<div class="item"><div class="it-title">${esc(d)}</div>
          <div class="it-acts"><button data-i="${i}">${t("移除")}</button></div></div>`).join("")
      : '<div class="tiny">' + t("（没有附加目录）") + '</div>';
    $("dir-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const dirs2 = (state.settings.addDirs || []).filter((_, i) => i !== Number(b.dataset.i));
      await saveSettings({ addDirs: dirs2 });
    }));
  }

  // 附加目录照稿收成一个「N 个」按钮，点开才是清单和添加框
  $("dir-toggle").addEventListener("click", () => document.querySelectorAll("#dir-field .dir-more").forEach((x) => x.classList.toggle("hidden")));

  async function saveSettings(patch) {
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
    } catch (e) { toast(e.message || t("保存失败"), true); }
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
  $("set-workisland").addEventListener("change", (e) => saveSettings({ workIsland: e.target.checked }));
  $("set-parallel").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (!(v >= 1)) { e.target.value = state.settings.maxParallel || 3; return; }
    saveSettings({ maxParallel: v }).then(() => { e.target.value = state.settings.maxParallel || v; });
  });
  // ── 压缩线滑块（接口与型号页）：0–100 映射到 [20k, 模型窗口]；没设 = 交给 claude，滑块停在最右、虚线轨道 ──
  const AC_MIN = 20000;
  let acWin = 0, acSet = 0;
  function acStep() { return Math.max(1000, Math.ceil((acWin - AC_MIN) / 100 / 1000) * 1000); }
  function acTok(p) { return Math.min(acWin, Math.round((AC_MIN + (acWin - AC_MIN) * p / 100) / acStep()) * acStep()); }
  function acPos(v) { return Math.max(0, Math.min(100, (v - AC_MIN) / (acWin - AC_MIN) * 100)); }
  function acShow(v) {
    const rg = $("ac-range"), pct = v ? acPos(v) : 100;
    rg.style.setProperty("--p", pct + "%");
    $("ac-range").parentNode.classList.toggle("auto", !v);
    $("ac-val").textContent = v ? t("{line} · 窗口的 {pct}%", { line: fmtTok(v), pct: Math.round(v / acWin * 100) }) : t("没设，交给 claude 按窗口决定");
    $("ac-auto").classList.toggle("hidden", !v);
  }
  function acPaint(win, set) {
    const box = $("ac-slide");
    acWin = Number(win) || 0; acSet = Number(set) || 0;
    box.classList.toggle("hidden", acWin <= AC_MIN);
    if (acWin <= AC_MIN) return;
    const rg = $("ac-range");
    if (document.activeElement !== rg) rg.value = acSet ? acPos(acSet) : 100;
    $("ac-min").textContent = fmtTok(AC_MIN); $("ac-max").textContent = fmtTok(acWin);
    acShow(acSet);
  }
  $("ac-range").addEventListener("input", (e) => acShow(acTok(+e.target.value)));
  $("ac-range").addEventListener("change", (e) => {
    const v = acTok(+e.target.value);
    saveSettings({ autoCompactWindow: v }).then(() => loadModels());
  });
  $("ac-auto").addEventListener("click", () => saveSettings({ autoCompactWindow: null }).then(() => loadModels()));
  $("set-autocompact").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    saveSettings({ autoCompactWindow: v ? Number(v) : null }).then(() => loadModels());
  });
  $("btn-add-dir").addEventListener("click", () => {
    const v = $("inp-dir").value.trim();
    if (!v) return;
    saveSettings({ addDirs: [...(state.settings.addDirs || []), v] });
    $("inp-dir").value = "";
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
    state.caps = state.caps || {};
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
      state.caps = await api("/api/capabilities");
      renderCaps();
    } catch {}
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
    const hit = (list) => (list || []).some((r) => r === name || (r.endsWith("*") && name.startsWith(r.slice(0, -1))));
    const part = (list) => (list || []).some((r) => r.startsWith(name + "("));
    if (hit(rules.deny)) return "deny";
    if (hit(rules.ask)) return "ask";
    if (hit(rules.allow)) return "allow";
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
    $("cap-tiles").innerHTML = Object.keys(N).map((k) => `<button class="tile" data-sec="${k}"><span class="icobox">${icoOf(k)}</span><span class="n num">${N[k]}</span><span class="k">${esc(nameOf(k))}</span></button>`).join("");
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
    const b = e.target.closest("[data-sec]"), x = b && document.querySelector(`#tab-caps > [data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body");
    body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - 12, behavior: "smooth" });
  });
  $("caps-cmds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]"); if (!b) return;
    closePage();
    inputEl.value = b.dataset.cmd + " "; autoGrow(); inputEl.focus();
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


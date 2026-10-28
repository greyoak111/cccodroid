  // ── 设置 ──────────────────────────────────────────────────────────
  let MODELS = [];

  // ── 接口（厂商）────────────────────────────────────────────────────
  // 下拉框只决定"看哪一家的配置卡"；真正切换要在卡上点「使用这个接口」——
  // 配置和切换分开，免得填密钥填到一半就把正在用的接口换掉了。
  // 选接口这张单子：界面不是中文时整张用英文（厂商名、线路名本来就是英文世界的叫法，逐语言翻反而对不上官网）
  const provEn = () => !/^zh/.test((window.I18N && I18N.lang) || "zh");
  const pLabel = (x) => (provEn() && x.labelEn) || x.label;
  // 状态里的当前接口名：同上规则（旧网关没有 providerLabelEn 就用中文名）
  const provName = (s) => (s && ((provEn() && s.providerLabelEn) || s.providerLabel || s.provider)) || "";
  const pHint = (x) => (provEn() && x.hintEn) || x.hint || "";
  const GROUP_NAME = provEn() ? { claude: "Claude", third: "Third-party (just add a key)", local: "On-device", custom: "Custom endpoints" }
    : { claude: "Claude", third: t("第三方（填 Key 即用）"), local: t("端侧（本机运行）"), custom: t("自定义接口") };
  const post = (p, body) => api(p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  });

  async function loadProviders() {
    try {
      const r = await api("/api/providers");
      state.providers = r.providers || [];
      state.providerActive = r.active;
      if (!state.provView || (state.provView !== "__new__" && !state.providers.some((p) => p.id === state.provView))) {
        state.provView = r.active;
      }
      const sel = $("set-provider");
      const groups = {};
      for (const p of state.providers) (groups[p.group] = groups[p.group] || []).push(p);
      const opt = (p) => {
        const tag = p.active ? "● " : "";
        const st = p.login ? "" : (p.hasKey ? "" : (provEn() ? " · no key yet" : t(" · 未配 Key")));
        return `<option value="${esc(p.id)}">${tag}${esc(pLabel(p))}${st}</option>`;
      };
      sel.innerHTML = ["claude", "third", "local", "custom"].filter((g) => g !== "local" || groups.local).map((g) =>
        `<optgroup label="${GROUP_NAME[g]}">` + (groups[g] || []).map(opt).join("") +
        (g === "custom" ? `<option value="__new__">${provEn() ? "+ Add a custom endpoint…" : t("＋ 新增自定义接口…")}</option>` : "") + `</optgroup>`).join("");
      sel.value = state.provView;
      $("provider-count").textContent = t("{n} 个", { n: state.providers.length });
      const cur = state.providers.find((p) => p.id === r.active) || {};
      $("provider-info").textContent = t("当前在用：{name}", { name: pLabel(cur) || r.active });
      $("provider-info").title = cur.baseUrl || "";
      renderProvCard();
    } catch (e) {
      $("provider-info").textContent = t("读取接口清单失败：{msg}", { msg: e.message });
    }
  }

  // 照稿收起接口卡：正在用、而且已经配好的那一家默认只露一行；看别家 / 没配好时自动展开
  let provOpen = null;
  function foldProvCard() {
    const id = state.provView, p = (state.providers || []).find((x) => x.id === id);
    const auto = !(p && p.active && (p.login || p.local || p.hasKey));
    const open = provOpen == null ? auto : provOpen;
    $("prov-card").classList.toggle("hidden", !open);
    $("prov-more").textContent = open ? t("收起") : t("详情");
  }
  $("prov-more").addEventListener("click", () => { provOpen = $("prov-card").classList.contains("hidden"); foldProvCard(); });
  function renderProvCard() {
    const box = $("prov-card");
    const id = state.provView;
    foldProvCard();
    // 卡片容器是复用的：密钥卡 / 自定义卡会在它上面挂 onclick（闭包里记着那一家）。
    // 换卡前必须摘掉，否则旧处理还在 —— 在登录卡上点「使用这个接口」，冒泡上来又把接口切回上一家
    // （实测：同一毫秒发出 provider=anthropic 和 provider=deepseek，后者赢）。
    box.onclick = null;
    if (id === "__new__") return renderCustomCard(box, null);
    const p = (state.providers || []).find((x) => x.id === id);
    if (!p) { box.innerHTML = ""; return; }
    if (p.login) return renderLoginCard(box, p);
    if (p.local) return renderLocalCard(box, p);
    if (p.custom) return renderCustomCard(box, p);
    return renderKeyCard(box, p);
  }

  const useBtn = (p) => p.active
    ? `<span class="pill">${t("● 正在使用")}</span>`
    : `<button class="btn sm" data-act="use">${t("使用这个接口")}</button>`;

  async function useProvider(p) {
    if (!p.login && !p.hasKey) return toast(t("先填 Key 并保存"), true);
    const r = await saveSettings({ provider: p.id });
    if (!r) return;
    await loadSettings();
    await refreshStatus();
    toast(t("已切到 {name}（下一条消息生效）", { name: p.label }));
  }

  // ── 端侧小模型卡：llama.cpp 装没装、有没有 GPU、模型目录里有哪些、聊天 / 自定义模式、服务状态 ──
  async function renderLocalCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div><div class="tiny">${t("读取中…")}</div>`;
    let j;
    try { j = await api("/api/local"); } catch (e) { box.innerHTML += `<div class="prov-state err">${esc(e.message)}</div>`; return; }
    if (state.provView !== p.id) return;
    const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
    const ok = (b) => b ? "✓" : "✗";
    const sv = j.server || {}, cu = j.custom || {};
    const cmdText = t("请阅读 {skill}，帮我给端侧小模型配置一个自定义模式。", { skill: (cu.skill || "~/.claude/skills/local-model-mode/SKILL.md") });
    const svText = sv.state === "ready" ? t("已加载 {name}（{min} 分钟不用自动卸载）", { name: sv.model, min: Math.round(sv.idleMs / 60000) })
      : sv.state === "loading" ? t("正在加载 {name}…", { name: sv.model })
      : sv.state === "error" ? t("上次没起来：{msg}", { msg: sv.err || "?" })
      : t("未运行（发消息时自动加载）");
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      <div class="tiny">${esc(pHint(p))}</div>
      <div class="local-facts tiny">
        <div>${ok(j.bin)} ${j.bin ? t("llama.cpp 已装") : t("没装 llama.cpp：到「扩展」页装 llama-cpp 组件")}</div>
        <div>${j.gpu ? "✓ " + t("GPU 推理（Vulkan）") : "· " + t("只有 CPU 推理（装 GPU 驱动组件可以快几倍）")}</div>
        <div>· ${t("内存 {total}，可用 {avail}；上下文 {ctx} token，{n} 线程", { total: gb(j.memTotal), avail: gb(j.memAvail), ctx: j.ctx.toLocaleString(), n: j.threads })}</div>
      </div>
      <div class="tiny" style="margin:8px 0 4px">${t("模型（{dir}）", { dir: esc(j.dirs[0] || "") })}</div>
      ${j.models.length ? `<div class="local-models">${j.models.map((m) => `<div class="tiny">· <code>${esc(m.id)}</code> ${gb(m.size)}</div>`).join("")}</div>`
        : `<div class="tiny dim">${t("还没有模型。到「扩展」页 llama-cpp 组件下的「下载模型」一键下载，或把 .gguf 文件放进上面的目录。")}</div>`}
      <div class="tiny" style="margin:10px 0 4px">${t("模式")}</div>
      <div class="local-mode">
        <label><input type="radio" name="lm" value="chat" ${j.mode !== "custom" ? "checked" : ""}> ${t("聊天")}<span class="tiny dim"> — ${t("不给工具，提示最短、回得最快")}</span></label>
        <label><input type="radio" name="lm" value="custom" ${j.mode === "custom" ? "checked" : ""} ${cu.ok ? "" : "disabled"}> ${cu.ok ? esc(cu.label) : t("自定义")}<span class="tiny dim"> — ${
          cu.ok ? (cu.tools ? t("工具：{tools}", { tools: esc(cu.tools) }) : t("不给工具")) : cu.have ? "" : t("还没配置")}</span></label>
        ${cu.have && !cu.ok ? `<div class="tiny err">${t("配置文件有误，已按聊天模式跑：{msg}", { msg: esc(cu.err) })}</div>` : ""}
      </div>
      <div class="local-custom tiny dim">
        ${t("手机算力有限，小模型干不了活，所以只内置聊天。想自己折腾的话，可以写 {file} 开一个自定义模式（指定工具、系统提示、llama-server 参数）。最省事的办法：切到云端模型，把下面这句发给它：", { file: "<code>" + esc(cu.path || "~/.cccodroid/local-mode.json") + "</code>" })}
        <div class="local-copy"><code>${esc(cmdText)}</code><button class="btn sm ghost" data-act="copy">${t("复制")}</button></div>
      </div>
      <div class="prov-state">${esc(svText)}${sv.loadMs ? ` · ${t("加载用了 {s} 秒", { s: (sv.loadMs / 1000).toFixed(1) })}` : ""}</div>
      <div class="row-actions">
        ${sv.state === "ready" || sv.state === "loading" ? `<button class="btn sm ghost" data-act="stop">${t("卸载模型")}</button>` : ""}
        <button class="btn sm ghost" data-act="refresh">${t("刷新")}</button>
        ${j.bin && j.models.length ? useBtn(p) : ""}
      </div>`;
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "use") return useProvider(p);
      if (act === "refresh") return renderLocalCard(box, p);
      if (act === "stop") { await post("/api/local", { stop: true }).catch((e2) => toast(e2.message, true)); return renderLocalCard(box, p); }
      if (act === "copy") { copyText(cmdText); return toast(t("已复制")); }
    };
    box.querySelectorAll('input[name="lm"]').forEach((r) => r.addEventListener("change", async () => {
      await post("/api/local", { mode: r.value }).catch((e2) => toast(e2.message, true));
      toast(t("已切换（下一条消息生效）"));
    }));
  }

  // ── 账户登录卡 ──
  async function renderLoginCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      <div class="prov-state" id="login-state">${t("查询登录状态…")}</div>
      <div class="row-actions" id="login-actions"></div>
      <div id="login-flow"></div>
      <div class="tiny">${esc(pHint(p))}</div>`;
    let st;
    try { st = await api("/api/login/status"); } catch (e) { $("login-state").textContent = t("查询失败：{msg}", { msg: e.message }); return; }
    if (state.provView !== p.id) return;      // 查询期间用户换了卡
    paintLoginState(st, p);
    if (st.pending) watchLogin(p);
  }
  function paintLoginState(st, p) {
    const el = $("login-state"); if (!el) return;
    if (st.loggedIn) {
      el.className = "prov-state ok";
            el.innerHTML = (st.email ? t("✓ 已登录：<b>{email}</b>", { email: esc(st.email) }) : t("✓ 已登录")) +
        (st.plan ? ` · ${esc(st.plan)}` : "") + (st.org ? `<br><span class="tiny">${esc(st.org)}</span>` : "") +
        quotaHtml(st.limits);
    } else {
      el.className = "prov-state warn";
      el.textContent = st.pending ? t("等待浏览器里完成授权…") : t("未登录");
    }
    $("login-actions").innerHTML = (st.pending
      ? `<button class="btn sm ghost" data-act="cancel">${t("取消登录")}</button>`
      : `<button class="btn sm" data-act="login">${st.loggedIn ? t("换个账户登录") : t("登录 Claude 账户")}</button>` +
        `<button class="btn sm ghost" data-act="login-console">${t("用 Console 账户")}</button>` +
        (st.loggedIn ? `<button class="btn sm ghost danger" data-act="logout">${t("退出登录")}</button>` : "")) +
      (st.loggedIn ? useBtn(p) : "");
    $("login-actions").onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "login") startLogin(p, "claudeai");
      else if (act === "login-console") startLogin(p, "console");
      else if (act === "cancel") post("/api/login/cancel").then(() => renderProvCard());
      else if (act === "logout") logout(p);
      else if (act === "use") useProvider(p);
    };
  }
  /** 订阅额度：claude 每轮回报一次，网关记下最近一次（不另外查接口） */
  function quotaHtml(l) {
    if (!l) return `<div class="quota tiny">${t("额度：发一条消息后显示（5 小时 / 每周）")}</div>`;
    const when = (sec) => {
      if (!sec) return "";
      const d = new Date(sec * 1000), now = new Date();
      const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + hm;
    };
    const row = (label, w) => {
      if (!w) return "";
      const pct = Math.max(0, Math.min(100, w.used));
      const cls = pct >= 90 ? " hot" : pct >= 70 ? " warm" : "";
      return `<div class="quota-row"><span class="quota-l">${label}</span>
        <span class="quota-bar"><i class="${cls.trim()}" style="width:${pct}%"></i></span>
        <span class="quota-v">${Math.round(pct)}%</span>
        <span class="tiny">${w.resetsAt ? t("{time} 重置", { time: esc(when(w.resetsAt)) }) : ""}</span></div>`;
    };
    const ago = Math.max(0, Math.round((Date.now() - l.at) / 60000));
    return `<div class="quota">${row(t("5 小时"), l.fiveHour)}${row(t("每周"), l.sevenDay)}
      <div class="tiny">${ago < 1 ? t("额度刚刚更新") : t("额度更新于 {n} 分钟前（每轮对话后刷新）", { n: ago })}</div></div>`;
  }
  /** 用量页的额度面板：只有用 Claude 账户登录时才显示，大数字 + 进度条 + 重置时间 */
  async function loadQuota() {
    let st = null;
    try { st = await api("/api/login/status"); } catch {}
    const box = $("quota-field"), l = st && st.loggedIn !== false && st.limits;
    box.classList.toggle("hidden", !(st && st.loggedIn));
    if (!l) { $("quota-tiles").innerHTML = ""; $("quota-note").textContent = t("额度：发一条消息后显示（5 小时 / 每周）"); return; }
    const tile = (label, w) => {
      if (!w) return "";
      const pct = Math.max(0, Math.min(100, w.used));
      const cls = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
      const at = w.resetsAt ? new Date(w.resetsAt * 1000) : null;
      const reset = at ? t("{time} 重置", { time: esc(at.toDateString() === new Date().toDateString()
        ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : at.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) }) : "";
      return `<div class="q-tile ${cls}"><span class="q-l">${label}</span><b>${Math.round(pct)}<small>%</small></b>
        <span class="quota-bar"><i class="${cls}" style="width:${pct}%"></i></span><span class="q-r">${reset}</span></div>`;
    };
    $("quota-tiles").innerHTML = tile(t("5 小时"), l.fiveHour) + tile(t("每周"), l.sevenDay);
    const lq = $("login-state") && $("login-state").querySelector(".quota");   // 设置里登录卡片上的那两条
    if (lq) lq.outerHTML = quotaHtml(l);
    usDash.quota = l.sevenDay || null; usPaint(); paintSetUsage();
    const ago = Math.max(0, Math.round((Date.now() - l.at) / 60000));
    $("quota-note").textContent = ago < 1 ? t("额度刚刚更新") : t("额度更新于 {n} 分钟前（每轮对话后刷新）", { n: ago });
  }
  // 额度看得见的地方（用量页、设置里的用量行 / 登录卡片、第三方的余额卡片）只在打开时拉过一次，
  // 之后要切页面才更新。现在：网关记下新额度时推 quota、每轮跑完、回到前台，都把看得见的那几处重画一遍
  let quotaT = 0;
  function refreshQuota() {
    clearTimeout(quotaT);
    quotaT = setTimeout(() => {
      if (document.hidden) return;
      const usageOpen = curPage === "usage" && !$("pages").classList.contains("hidden");
      if (setOpen || usageOpen) loadQuota().catch(() => {});
      if (usageOpen) loadAcctCard(false).catch(() => {}); else qbLoad(false).catch(() => {});   // 顶栏细条、速览卡
    }, 800);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuota(); });
  /** 交给系统浏览器：安卓壳把非本机地址都转给外部浏览器（WebView 里登录会被 Google 等拦） */
  function openExternal(url) {
    if (window.CCApp && window.CCApp.openUrl) return window.CCApp.openUrl(url);
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function startLogin(p, method) {
    $("login-state").className = "prov-state";
    $("login-state").textContent = t("正在启动登录…");
    let r;
    try { r = await post("/api/login/start", { method }); } catch (e) { return toast(e.message, true); }
    if (!r.ok) { $("login-state").textContent = "✗ " + (r.message || t("启动失败")); return; }
    openExternal(r.url);
        $("login-flow").innerHTML = `<div class="tiny">${t("已在浏览器打开授权页。授权后浏览器会跳回本机，登录自动完成。")}
        ${t("没自动打开？")}<a href="${esc(r.url)}" target="_blank" rel="noopener">${t("点这里打开")}</a></div>
      <div class="prov-manual">
        <div class="tiny">${t("浏览器没跳回来（或在别的设备上授权）？在终端里登录：授权码由你直接贴给 claude，本应用不经手。")}</div>
        <button class="btn sm" id="btn-login-term">${t("在终端里登录")}</button>
      </div>`;
    $("btn-login-term").onclick = async () => {
      await post("/api/login/cancel").catch(() => {});
      clearInterval(state.loginTimer);
      openLoginTerm(method === "console" ? "console" : "claudeai");
    };
    watchLogin(p);
  }
  function watchLogin(p) {
    clearInterval(state.loginTimer);
    state.loginTimer = setInterval(async () => {
      let st;
      try { st = await api("/api/login/status"); } catch { return; }
      if (st.pending) { if (state.provView === p.id) paintLoginState(st, p); return; }
      clearInterval(state.loginTimer);
      if (st.loggedIn) toast((st.email ? t("✓ 已登录：{email}", { email: st.email }) : t("✓ 已登录")) + (p.active ? "" : t("，点「使用这个接口」切过去")));
      else if (st.last && !st.last.ok) toast(t("登录没有完成"), true);
      if (state.provView === p.id) renderProvCard();
      refreshStatus();
    }, 2000);
  }
  async function logout(p) {
    if (!confirm(t("退出这台设备上的 Claude 账户登录？"))) return;
    const r = await post("/api/login/logout").catch((e) => ({ ok: false, output: e.message }));
    toast(r.ok ? t("已退出登录") : t("退出失败：{msg}", { msg: r.output || r.message || "" }), !r.ok);
    renderProvCard();
  }

  // ── 密钥卡（Claude API Key 与第三方厂商）──
  // ── 余额与消费（密钥卡底部）──
  // 余额问平台；消费是网关按余额变化自己记的（平台都不给账单接口）；token 每轮结束记。
  // 显示货币跟界面语言走：中文用人民币，其余用美元；账户币种不同就按汇率换算，标「≈」
  const billCur = () => (/^zh/.test(I18N.lang) ? "CNY" : "USD");
  function money(v, cur) {
    try { return new Intl.NumberFormat(I18N.lang, { style: "currency", currency: cur, maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 }).format(v); }
    catch { return cur + " " + v.toFixed(2); }
  }
  function toDisp(v, from, fx) {
    const to = billCur();
    if (!from || from === to) return { v, cur: to, approx: false };
    if (!fx || !fx.rate) return { v, cur: from, approx: false };          // 拿不到汇率就照原币种显示
    return { v: from === "CNY" ? v / fx.rate : v * fx.rate, cur: to, approx: true };
  }
  const compact = (n) => { try { return new Intl.NumberFormat(I18N.lang, { notation: "compact", maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
  /** 余额与消费的明细行（用量页、顶栏速览卡共用）。brief = 速览卡：省掉说明性的小字 */
  function billRows(b, p, brief) {
    const fx = b.fx;
    const fmt = (v, cur) => { const d = toDisp(v, cur, fx); return (d.approx ? "≈ " : "") + money(d.v, d.cur); };
    const rows = [];
    // 余额 / 套餐额度
    if (b.balanceError) rows.push(`<div class="prov-state err">${esc(t("余额查询失败：{msg}", { msg: b.balanceError }))}</div>`);
    else if (Number.isFinite(b.balance)) {
      const PART = { granted: t("赠送"), topped: t("充值"), voucher: t("代金券"), cash: t("现金") };
      const parts = (b.parts || []).filter((x) => Number.isFinite(x.v)).map((x) => `${PART[x.k] || x.k} ${fmt(x.v, x.currency || b.currency)}`).join(" · ");
      rows.push(`<div class="bill-big">${t("余额")} <b>${fmt(b.balance, b.currency)}</b>${b.available === false ? ` <span class="badge warn">${t("不可用")}</span>` : ""}</div>` +
        (parts ? `<div class="tiny">${parts}</div>` : ""));
    } else if (b.kind === "openrouter" && Number.isFinite(b.usage)) {
      rows.push(`<div class="bill-big">${t("已用")} <b>${fmt(b.usage, "USD")}</b></div><div class="tiny">${t("这把 Key 没设额度上限，查不到余额")}</div>`);
    }
    if (Array.isArray(b.plan)) {
      const W = { "5h": t("5 小时"), week: t("每周"), month: t("每月") };
      rows.push(b.plan.length
        ? `<div class="quota">${b.plan.map((x) => {
            const pct = Math.max(0, Math.min(100, x.pct)), cls = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
            const reset = x.resetsAt ? new Date(x.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
            return `<div class="quota-row"><span class="quota-l">${esc(W[x.window] || x.window)}</span>
              <span class="quota-bar"><i class="${cls}" style="width:${pct}%"></i></span><span class="quota-v">${Math.round(pct)}%</span>
              <span class="tiny">${reset ? t("{time} 重置", { time: esc(reset) }) : ""}</span></div>`;
          }).join("")}<div class="tiny">${t("Coding Plan 套餐额度（智谱没有公开的余额接口，按量计费的 Key 查不到）")}</div></div>`
        : `<div class="tiny">${t("这把 Key 没有 Coding Plan 套餐额度；智谱没有公开的按量余额接口，请到控制台查看")}</div>`);
    }
    if (b.kind === "none" && !brief) rows.push(`<div class="tiny">${esc(p.id === "qwen"
      ? t("百炼的余额挂在阿里云主账号上，API Key 查不到，请到百炼控制台查看。下面是本机记录的 token 用量。")
      : t("这个平台没有开放余额查询接口。下面是本机记录的 token 用量。"))}</div>`);
    // 消费（按余额变化记的）
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    if (b.ledgerCurrency) {
      const sp = b.spends || [];
      const today = sp.filter((x) => x[0] >= midnight.getTime()).reduce((a, x) => a + x[1], 0);
      const total = (b.spentOld || 0) + sp.reduce((a, x) => a + x[1], 0);
      rows.push(`<div class="bill-grid"><span>${t("今日消费")}</span><b>${fmt(today, b.ledgerCurrency)}</b>
        <span>${t("累计消费")}</span><b>${fmt(total, b.ledgerCurrency)}</b></div>
        ${brief ? "" : `<div class="tiny">${esc(t("按余额变化记账，{date} 起；充值不算消费。同一把 Key 在别处用掉的也算在内。", { date: new Date(b.since).toLocaleDateString() }))}</div>`}`);
    }
    // token
    const tk = b.tok || [];
    const sum = (arr) => arr.reduce((a, x) => [a[0] + x[1], a[1] + x[2], a[2] + x[3]], [0, 0, 0]);
    const td = sum(tk.filter((x) => x[0] + 3600e3 > midnight.getTime()));
    const all = sum(tk), old = b.tokOld || { in: 0, out: 0, cache: 0 };
    const tl = (a) => t("输入 {i} · 输出 {o} · 缓存 {c}", { i: compact(a[0]), o: compact(a[1]), c: compact(a[2]) });
    rows.push(`<div class="bill-grid"><span>${t("今日 token")}</span><span>${tk.length ? tl(td) : "—"}</span>
      <span>${t("累计 token")}</span><span>${tk.length || old.in ? tl([all[0] + old.in, all[1] + old.out, all[2] + old.cache]) : "—"}</span></div>
      ${tk.length ? "" : `<div class="tiny">${t("用这个接口跑完一轮后开始记录")}</div>`}`);
    if (!brief && fx && fx.rate && [b.currency, b.ledgerCurrency].some((c) => c && c !== billCur()))
      rows.push(`<div class="tiny">${esc(t("按 1 美元 ≈ {r} 人民币换算（{src}，{time}）", { r: fx.rate.toFixed(3), src: fx.src, time: new Date(fx.at).toLocaleString() }))}</div>`);
    if (b.balanceAt && b.ledgerCurrency) rows.push(`<div class="tiny">${esc(t("{time} 查询；平台扣费有几分钟延迟，跑完会自动补查", { time: new Date(b.balanceAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }))}</div>`);
    return rows.join("");
  }
  // 一句话摘要：顶栏细条、设置里的密钥卡、用量页「其他接口」那一行都用它。lvl：0 正常 / 1 偏紧 / 2 告急
  function billBrief(b) {
    if (!b) return { text: "", lvl: 0 };
    const fmt = (v, cur) => { const d = toDisp(v, cur, b.fx); return (d.approx ? "≈ " : "") + money(d.v, d.cur); };
    if (Number.isFinite(b.balance)) {
      const d = toDisp(b.balance, b.currency, b.fx), lim = qbWarnCfg().bal;
      return { text: t("余额 {v}", { v: fmt(b.balance, b.currency) }), lvl: lim > 0 && d.cur === billCur() && d.v < lim ? 2 : 0 };
    }
    if (Array.isArray(b.plan) && b.plan.length) {
      const W = { "5h": t("5 小时"), week: t("每周"), month: t("每月") };
      const top = Math.max(...b.plan.map((x) => +x.pct || 0));
      return { text: b.plan.map((x) => (W[x.window] || x.window) + " " + Math.round(x.pct) + "%").join(" · "), lvl: top >= 90 ? 2 : top >= 70 ? 1 : 0 };
    }
    if (b.kind === "openrouter" && Number.isFinite(b.usage)) return { text: t("已用 {v}", { v: fmt(b.usage, "USD") }), lvl: 0 };
    if (b.balanceError) return { text: t("余额查询失败"), lvl: 0 };
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const td = (b.tok || []).filter((x) => x[0] + 3600e3 > midnight.getTime()).reduce((a, x) => a + x[1] + x[2] + x[3], 0);
    return { text: t("今日 {n} tokens", { n: compact(td) }), lvl: 0 };
  }
  // 设置里的密钥卡底部只留一行摘要，明细在用量页（「额度与消费」）
  async function loadBill(p, force) {
    const el = $("pc-bill"); if (!el) return;
    if (!el.innerHTML) el.innerHTML = `<div class="tiny">${t("查询余额…")}</div>`;
    let b;
    try { b = await api(`/api/billing?id=${encodeURIComponent(p.id)}${force ? "&refresh=1" : ""}`); }
    catch (e) { el.innerHTML = `<div class="tiny">${esc(t("查询失败：{msg}", { msg: e.message }))}</div>`; return; }
    if (state.provView !== p.id || !$("pc-bill")) return;
    const br = billBrief(b);
    el.innerHTML = `<div class="bill-head"><span class="sub">${t("余额与消费")}</span>
      <button class="btn sm ghost" data-gopage="usage">${t("在用量页查看")}</button></div>
      <div class="bill-big${br.lvl === 2 ? " hot" : ""}">${esc(br.text || "—")}</div>`;
  }

  // ── 额度与余额速览 ──
  // 顶栏细条（上下文用量）后半段写当前接口还剩多少：账户登录 → 5 小时 / 每周已用；能查余额的厂商 → 余额；
  // 智谱套餐 → 各窗口已用；都查不了 → 今天的 token。点细条弹速览卡，卡里「查看用量」去用量页的「额度与消费」。
  // 数据：账户额度是 claude 每轮回报的（网关记着，不另查）；余额走 /api/billing（网关缓存 60 秒；
  // 跑完一轮会在 30 秒 / 3 分钟 / 10 分钟补查并推 billing 事件），所以常驻显示不会多打厂商接口。
  // 速览卡的交互（以前在弹层上翻过车，照这几条来）：
  //   - 只在对话这一栏里摆（colRect）：右侧浏览器是原生视图，摆出栏外会被它盖住
  //   - 再点细条 = 收起；点卡外收起（pointerdown 捕获，细条本身留给 click 去切换，不然先关又开）；返回键 / Esc 收起
  //   - 打开整页、设置、弹出菜单时先收起；layout.js 浮层开合后会补发假 resize，这里只重摆位置，不因 resize 关掉
  const QB = { cur: null, seq: 0 };
  function qbWarnCfg() {
    try { return { quota: true, bal: 0, ...JSON.parse(localStorage.getItem("cc.qbWarn") || "{}") }; }
    catch { return { quota: true, bal: 0 }; }
  }
  function loginBrief(l) {
    if (!l) return { text: "", lvl: 0 };
    const ws = [[t("5 小时"), l.fiveHour], [t("每周"), l.sevenDay]].filter((x) => x[1]);
    const top = Math.max(0, ...ws.map((x) => +x[1].used || 0));
    return { text: ws.map((x) => x[0] + " " + Math.round(x[1].used) + "%").join(" · "), lvl: top >= 90 ? 2 : top >= 70 ? 1 : 0 };
  }
  const qbBrief = (c) => (!c ? { text: "", lvl: 0 } : c.login ? loginBrief(c.limits) : billBrief(c.bill));
  /** 拉当前接口的额度 / 余额，画到细条上；速览卡、用量页开着就一起重画 */
  async function qbLoad(force) {
    const s = state.serverStatus;
    if (!s || !s.provider) return null;
    const seq = ++QB.seq;
    // 按当前会话用的那家（0.3.16 起会话可以钉在别家上），不是只看全局
    const pid = curProv() || s.provider, pb = pid !== s.provider ? provOf(pid) : null;
    const cur = pb ? { id: pid, name: provLabel(pid), login: pb.keyMode === "login" } : { id: s.provider, name: provName(s), login: s.keyMode === "login" };
    if (cur.login) {
      const st = await api("/api/login/status").catch(() => null);
      cur.limits = st && st.loggedIn ? st.limits || null : null;
    } else {
      cur.bill = await api(`/api/billing?id=${encodeURIComponent(cur.id)}${force ? "&refresh=1" : ""}`).catch(() => null);
      if (cur.bill && cur.bill.error) cur.bill = null;
    }
    if (seq !== QB.seq) return QB.cur;          // 期间又发了一次（切了接口、连点刷新），以后发的为准
    if (!cur.login && !cur.bill && QB.cur && QB.cur.id === cur.id && QB.cur.bill) return QB.cur;   // 一时没查到：留着上次的，别把细条上的字清掉
    QB.cur = cur;
    qbPaint();
    qbRemind(cur);
    qcRender();
    return cur;
  }
  function qbPaint(br) {
    const el = $("ctxq");
    if (!el) return;
    if (!br) {
      br = qbBrief(QB.cur);
      // 记下这次的一句话：下次打开界面先画它，不用等状态和额度接口回来（上下文数字是本地存的，一打开就有，两边一起出）
      if (QB.cur) try { localStorage.setItem("cc.qbLast", JSON.stringify({ id: QB.cur.id, text: br.text, lvl: br.lvl })); } catch {}
    }
    el.textContent = br.text;
    el.className = br.lvl === 2 ? "hot" : br.lvl === 1 ? "warm" : "";
    ctxBar.classList.toggle("has-q", !!br.text);
    if (br.text) ctxBar.classList.remove("hidden");
  }
  const qbLast = (() => { try { return JSON.parse(localStorage.getItem("cc.qbLast") || "null"); } catch { return null; } })();
  if (qbLast && qbLast.text) qbPaint(qbLast);
  // 快用完时提醒：5 小时 / 每周（或套餐窗口）过 80%、95% 各提醒一次（按重置时间区分窗口）；余额低于设定值每天一次
  function qbRemind(c) {
    const cfg = qbWarnCfg();
    let warned = {};
    try { warned = JSON.parse(localStorage.getItem("cc.qbWarned") || "{}") || {}; } catch {}
    const say = [];
    const when = (ms) => {
      if (!ms) return "";
      const d = new Date(ms), hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + hm;
    };
    const win = (key, label, pct, resetMs) => {
      const lv = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
      if (!lv || (warned[key] || 0) >= lv) return;
      warned[key] = lv;
      say.push(t("{win}额度已用 {n}%", { win: label, n: Math.round(pct) }) + (resetMs ? " · " + t("{time} 重置", { time: when(resetMs) }) : ""));
    };
    if (cfg.quota && c.login && c.limits) {
      const l = c.limits;
      if (l.fiveHour) win("5h:" + (l.fiveHour.resetsAt || 0), t("5 小时"), +l.fiveHour.used || 0, l.fiveHour.resetsAt * 1000);
      if (l.sevenDay) win("wk:" + (l.sevenDay.resetsAt || 0), t("每周"), +l.sevenDay.used || 0, l.sevenDay.resetsAt * 1000);
    }
    const b = c.bill;
    if (cfg.quota && b && Array.isArray(b.plan)) {
      const W = { "5h": t("5 小时"), week: t("每周"), month: t("每月") };
      for (const x of b.plan) win("plan:" + c.id + ":" + x.window + ":" + (x.resetsAt || 0), W[x.window] || x.window, +x.pct || 0, x.resetsAt);
    }
    if (cfg.bal > 0 && b && Number.isFinite(b.balance)) {
      const d = toDisp(b.balance, b.currency, b.fx), key = "bal:" + c.id + ":" + new Date().toDateString();
      if (d.cur === billCur() && d.v < cfg.bal && !warned[key]) {
        warned[key] = 1;
        say.push(t("{name} 余额只剩 {v}", { name: c.name, v: (d.approx ? "≈ " : "") + money(d.v, d.cur) }));
      }
    }
    if (!say.length) return;
    const keys = Object.keys(warned);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete warned[k];   // 只留最近的
    localStorage.setItem("cc.qbWarned", JSON.stringify(warned));
    toast(say.join("\n"), true);
  }

  // 速览卡
  let qcEl = null;
  const qcOpen = () => OV.isOpen(qcEl);
  function qcClose() { if (qcEl) OV.close(qcEl); }
  function qcToggle() {
    if (qcOpen()) return qcClose();
    const el = qcEl = document.createElement("div");
    el.className = "qcard";
    el.setAttribute("role", "dialog");
    OV.open(el, { anchor: ctxBar, place: qcPlace, keep: true, onClose: () => { if (qcEl === el) qcEl = null; } });
    el.addEventListener("click", (e) => {
      const a = e.target.closest("[data-qc]");
      if (!a) return;
      if (a.dataset.qc === "refresh") { a.disabled = true; qbLoad(true); return; }
      qcClose(); closeSettings(); openPage("usage");
    });
    qcRender();
    qbLoad(false);
  }
  function qcRender() {
    if (!qcOpen()) return;
    const c = QB.cur;
    const body = !c ? `<div class="tiny">${t("读取中…")}</div>`
      : c.login ? quotaHtml(c.limits)
      : c.bill ? billRows(c.bill, { id: c.id }, true)
      : `<div class="tiny">${t("查不到这个接口的额度")}</div>`;
    qcEl.innerHTML = `<div class="qc-h"><b>${esc(c ? c.name : "")}</b><span class="grow"></span>
      <button class="btn sm ghost" data-qc="refresh">${t("刷新")}</button></div>
      <div class="qc-body">${body}</div>
      <div class="qc-foot"><button class="btn sm" data-qc="usage">${t("查看用量")}</button></div>`;
    qcPlace();
  }
  function qcPlace() {
    if (!qcOpen()) return;
    const col = colRect(), b = ctxBar.getBoundingClientRect();
    const w = Math.max(220, Math.min(380, col.width - 16));
    qcEl.style.width = w + "px";
    qcEl.style.left = Math.max(8, col.left + (col.width - w) / 2) + "px";
    qcEl.style.top = (b.bottom + 6) + "px";
    qcEl.style.maxHeight = Math.max(160, fixedH() - b.bottom - 20) + "px";
  }
  ctxBar.addEventListener("click", qcToggle);

  // 用量页「额度与消费」：当前接口的明细 + 其他配过的接口各一行（点开看明细）+ 提醒设置
  const usOther = new Map();   // id → { login, limits } / { bill }
  async function loadAcctCard(force) {
    if (!$("us-acct")) return;
    const cur = await qbLoad(force);
    if (curPage !== "usage") return;
    $("us-acct-name").textContent = cur ? cur.name : "";
    $("us-acct-cur").innerHTML = !cur ? "" : cur.login ? quotaHtml(cur.limits)
      : cur.bill ? billRows(cur.bill, { id: cur.id }) : `<div class="tiny">${t("查不到这个接口的额度")}</div>`;
    let list = [];
    try { list = (await api("/api/providers")).providers || []; } catch {}
    const others = list.filter((p) => !p.active && !p.local && (p.login || p.hasKey));
    const box = $("us-acct-others");
    const keep = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    box.innerHTML = others.length ? `<div class="sub">${t("其他接口")}</div>` + others.map((p) =>
      `<details class="qb-row" data-id="${esc(p.id)}"${keep.has(p.id) ? " open" : ""}><summary><span>${esc(pLabel(p))}</span><span class="grow"></span><span class="qb-brief tiny">${t("读取中…")}</span></summary><div class="qb-detail"></div></details>`).join("") : "";
    const fill = (d) => {
      const x = usOther.get(d.dataset.id), det = d.querySelector(".qb-detail");
      if (!x) return;
      det.innerHTML = x.login ? quotaHtml(x.limits) : x.bill ? billRows(x.bill, { id: d.dataset.id }) : "";
    };
    box.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => { if (d.open) fill(d); }));
    await Promise.all(others.map(async (p) => {
      let x;
      if (p.login) {
        const st = await api("/api/login/status").catch(() => null);
        x = { login: true, limits: st && st.loggedIn ? st.limits || null : null, out: !(st && st.loggedIn) };
      } else {
        const b = await api(`/api/billing?id=${encodeURIComponent(p.id)}${force ? "&refresh=1" : ""}`).catch(() => null);
        x = { bill: b && !b.error ? b : null };
      }
      usOther.set(p.id, x);
      const d = box.querySelector(`details[data-id="${CSS.escape(p.id)}"]`);
      if (!d) return;
      if (x.out) { d.remove(); return; }          // 官方账户没登录：不列
      const br = x.login ? loginBrief(x.limits) : billBrief(x.bill);
      const el = d.querySelector(".qb-brief");
      el.textContent = br.text || (x.login ? t("发一条消息后显示") : "—");
      el.classList.toggle("hot", br.lvl === 2);
      if (d.open) fill(d);
    }));
    if (!box.querySelector("details")) box.innerHTML = "";
  }
  // 提醒设置
  (function () {
    const q = $("qb-warn-quota"), bal = $("qb-warn-bal");
    if (!q || !bal) return;
    const paint = () => {
      const c = qbWarnCfg();
      q.checked = c.quota !== false;
      bal.value = c.bal > 0 ? c.bal : "";
      $("qb-warn-cur").textContent = billCur() === "CNY" ? "¥" : "$";
    };
    const save = () => {
      const v = parseFloat(bal.value);
      localStorage.setItem("cc.qbWarn", JSON.stringify({ quota: q.checked, bal: v > 0 ? v : 0 }));
      qbPaint();
    };
    q.addEventListener("change", save);
    bal.addEventListener("change", save);
    $("us-acct-ref").addEventListener("click", () => loadAcctCard(true));
    paint();
  })();

  function renderKeyCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      ${p.endpoints.length > 1 ? `<div class="tiny" style="margin:0 0 4px">${t("线路")}</div>
        <select id="pc-endpoint">${p.endpoints.map((e) =>
          `<option value="${esc(e.id)}" ${e.id === p.endpoint ? "selected" : ""}>${esc(pLabel(e))}</option>`).join("")}</select>` : ""}
      <input id="pc-key" type="password" autocomplete="off"
        placeholder="${p.hasKey ? t("已保存（…{tail}），留空则不改", { tail: esc(p.keyTail) }) : t("粘贴 API Key")}">
      <div class="row-actions">
        <button class="btn sm" data-act="save">${t("保存")}</button>
        <button class="btn sm ghost" data-act="test">${t("测试")}</button>
        ${p.hasKey ? `<button class="btn sm ghost danger" data-act="clear">${t("清除 Key")}</button>` : ""}
        ${useBtn(p)}
      </div>
      <div class="prov-state" id="pc-result"></div>
      <div class="tiny">${t("端点")} <code>${esc(p.baseUrl)}</code>${p.defaultModel ? ` · ${t("默认模型")} <code>${esc(p.defaultModel)}</code>` : ""}
        ${p.keyUrl ? `<br><a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${t("去官网创建 Key ↗")}</a>` : ""}
        <br>${esc(pHint(p) || t("Key 只存在本机应用私有目录，由 claude 的 apiKeyHelper 按需读取（不进环境变量），直连厂商的 Anthropic 兼容端点。"))}</div>
      ${p.hasKey ? `<div id="pc-bill" class="bill"></div>` : ""}`;
    if (p.hasKey) loadBill(p);
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "use") return useProvider(p);
      if (act === "clear") {
        if (!confirm(t("清除 {name} 的 Key？", { name: p.label }))) return;
        await post("/api/providers/save", { id: p.id, clearKey: true }).catch((e2) => toast(e2.message, true));
        return reloadProv(t("已清除"));
      }
      const body = { id: p.id, apiKey: $("pc-key").value.trim() };
      if ($("pc-endpoint")) body.endpoint = $("pc-endpoint").value;
      if (act === "save" || body.apiKey || body.endpoint !== p.endpoint) {
        try { await post("/api/providers/save", body); } catch (e2) { return toast(e2.message, true); }
        $("pc-key").value = "";
        if (act === "save") return reloadProv(t("已保存"), true);
      }
      await testAndShow(p.id);
    };
  }
  async function testAndShow(id) {
    const el = $("pc-result"); if (!el) return;
    el.className = "prov-state"; el.textContent = t("测试中…");
    const r = await post("/api/providers/test", { id }).catch((e) => ({ ok: false, message: e.message }));
    el.className = "prov-state " + (r.ok ? "ok" : "err");
    el.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
  }
  async function reloadProv(msg, thenTest) {
    toast(msg);
    const id = state.provView;
    await loadProviders();
    if (id === state.providerActive) await loadModels(true);
    if (thenTest) {
      const p = state.providers.find((x) => x.id === id);
      if (p && p.hasKey) testAndShow(id);
    }
  }


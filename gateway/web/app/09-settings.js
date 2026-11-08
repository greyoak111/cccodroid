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
  // 「在模型选单里显示」：管的是下拉框里正在看的那一家；正在用的那家总会列出来，开关锁住
  function paintProvShow() {
    const id = state.provView, p = (state.providers || []).find((x) => x.id === id), sw = $("set-provshow");
    $("prov-show-row").classList.toggle("hidden", !p);
    if (!p) return;
    const hid = (state.settings?.hiddenProviders || []).includes(id);
    sw.checked = p.active || !hid;
    sw.disabled = !!p.active;
    sw.title = p.active ? t("正在用的接口总会列在选单里") : "";
  }
  $("set-provshow").addEventListener("change", async (e) => {
    const id = state.provView, cur = state.settings?.hiddenProviders || [];
    const next = e.target.checked ? cur.filter((x) => x !== id) : [...new Set([...cur, id])];
    if (await saveSettings({ hiddenProviders: next })) for (const p of state.provList || []) p.hidden = next.includes(p.id);
    paintProvShow();
  });
  function renderProvCard() {
    const box = $("prov-card");
    const id = state.provView;
    foldProvCard();
    paintProvShow();
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
    refreshSessModel();       // 跟随默认的会话：标签、模型面板跟着换到新接口（审查 D-02）
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
        <div>· ${t("内存 {total}，可用 {avail}；上下文 {ctx} token，{n} 线程", { total: gb(j.memTotal), avail: gb(j.memAvail), ctx: (Number(j.ctx) || 0).toLocaleString(), n: Number(j.threads) || 0 })}</div>
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
      // 失败只报错，单选按网关的真实状态重画；不能接着说「已切换」（#177-8）
      const j = await post("/api/local", { mode: r.value }).catch((e2) => ({ ok: false, message: e2.message }));
      if (j && j.ok === false) { toast(j.message || t("保存失败"), true); return renderLocalCard(box, p); }
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
    // 查询期间换了卡：迟到的失败别去碰已经不在的节点（审查 D-06）。换走又换回同一家时卡片是重画过的，
    // 只比接口 id 会让旧回执盖到新卡上：认这一次画出来的节点（审查 #52 D-06）
    const mine = box.querySelector("#login-state"), live = () => mine.isConnected && state.provView === p.id;
    try { st = await api("/api/login/status"); } catch (e) { if (live()) mine.textContent = t("查询失败：{msg}", { msg: e.message }); return; }
    if (!live()) return;
    paintLoginState(st, p);
    if (st.pending) watchLogin(p);
  }
  function paintLoginState(st, p) {
    const el = $("login-state"); if (!el) return;
    // 这次没问出来、沿用上次的结果：标明是旧的，带上原因（DeepSeek 复核 #3）
    const staleNote = st.stale ? `<br><span class="tiny">${esc(t("（这是上次查询的状态，这次没问出来：{msg}）", { msg: st.error || "" }))}</span>` : "";
    if (st.loggedIn) {
      el.className = "prov-state ok";
            el.innerHTML = (st.email ? t("✓ 已登录：<b>{email}</b>", { email: esc(st.email) }) : t("✓ 已登录")) +
        (st.plan ? ` · ${esc(st.plan)}` : "") + (st.org ? `<br><span class="tiny">${esc(st.org)}</span>` : "") +
        quotaHtml(st.limits) + staleNote;
    } else {
      el.className = "prov-state warn";
      el.textContent = st.pending ? t("等待浏览器里完成授权…") : st.unknown ? t("查询失败：{msg}", { msg: st.error || "" }) : t("未登录");
      if (staleNote && !st.pending) el.innerHTML += staleNote;
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
      // 网关给的已经是百分数，超额度时大于 100：数字如实显示，只把条子画满（197-5.7）
      const pct = Math.round(Math.max(0, +w.used || 0)), bar = Math.min(100, pct);
      const cls = pct >= 90 ? " hot" : pct >= 70 ? " warm" : "";
      return `<div class="quota-row"><span class="quota-l">${label}</span>
        <span class="quota-bar"><i class="${cls.trim()}" style="width:${bar}%"></i></span>
        <span class="quota-v">${pct}%</span>
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
    if (!l) {
      $("quota-tiles").innerHTML = ""; $("quota-note").textContent = t("额度：发一条消息后显示（5 小时 / 每周）");
      // 退出 / 换了个还没额度数据的账户：用量看板和设置摘要里的周额度也得撤掉，别挂着上一个账户的数（#144-2）
      if (usDash.quota) { usDash.quota = null; usPaint(); paintSetUsage(); }
      return;
    }
    const tile = (label, w) => {
      if (!w) return "";
      // 超额度时数字如实显示（可能大于 100），条子只画满（197-5.7）
      const pct = Math.round(Math.max(0, +w.used || 0)), bar = Math.min(100, pct);
      const cls = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
      const at = w.resetsAt ? new Date(w.resetsAt * 1000) : null;
      const reset = at ? t("{time} 重置", { time: esc(at.toDateString() === new Date().toDateString()
        ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : at.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) }) : "";
      return `<div class="q-tile ${cls}"><span class="q-l">${label}</span><b>${pct}<small>%</small></b>
        <span class="quota-bar"><i class="${cls}" style="width:${bar}%"></i></span><span class="q-r">${reset}</span></div>`;
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
    if (!/^https?:\/\//i.test(String(url || ""))) return;     // 只交 http(s)：别的协议（javascript: 之类）一律不开（审查 v0.5.5 W-L1）
    if (window.CCApp && window.CCApp.openUrl) return window.CCApp.openUrl(url);
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function startLogin(p, method) {
    const mine = $("login-state"), live = () => mine.isConnected && state.provView === p.id;   // 同 renderLoginCard（审查 #52 D-06）
    mine.className = "prov-state";
    mine.textContent = t("正在启动登录…");
    let r;
    try { r = await post("/api/login/start", { method }); } catch (e) { return toast(e.message, true); }
    if (!r.ok) { if (live()) mine.textContent = "✗ " + (r.message || t("启动失败")); return; }
    if (!live()) { openExternal(r.url); return watchLogin(p); }
    openExternal(r.url);
        $("login-flow").innerHTML = `<div class="tiny">${t("已在浏览器打开授权页。授权后浏览器会跳回本机，登录自动完成。")}
        ${t("没自动打开？")}<a href="${esc(webUrl(r.url))}" target="_blank" rel="noopener">${t("点这里打开")}</a></div>
      <div class="prov-manual">
        <div class="tiny">${t("浏览器没跳回来（或在别的设备上授权）？在终端里登录：授权码由你直接贴给 claude，本应用不经手。")}</div>
        <button class="btn sm" id="btn-login-term">${t("在终端里登录")}</button>
      </div>`;
    $("btn-login-term").onclick = async () => {
      await post("/api/login/cancel").catch(() => {});
      clearInterval(state.loginTimer);
      closeSettings();       // 终端窗格在设置模态下面，不关设置就点不着（审查 P2-6）
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
    // 退出成功后顶栏 / 用量页的额度要跟着撤掉，不能留着上一个账户的数（195-O.9）
    if (r.ok) { refreshStatus(); qbLoad(); loadQuota().catch(() => {}); }
  }

  // ── 密钥卡（Claude API Key 与第三方厂商）──
  // ── 余额与消费（密钥卡底部）──
  // 余额问平台；消费是网关按余额变化自己记的（平台都不给账单接口）；token 每轮结束记。
  // 显示货币跟界面语言走：中文用人民币，其余用美元；账户币种不同就按汇率换算，标「≈」
  const billCur = () => (/^zh/.test(I18N.lang) ? "CNY" : "USD");
  function money(v, cur) {
    cur = String(cur || "").replace(/[^A-Za-z]/g, "").slice(0, 8);     // 币种是平台接口给的，结果要拼进 HTML：只留字母（审查 10-29 L6）
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
      const parts = (b.parts || []).filter((x) => Number.isFinite(x.v)).map((x) => `${PART[x.k] || esc(x.k)} ${fmt(x.v, x.currency || b.currency)}`).join(" · ");
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
      let st = null, failed = false;
      try { st = await api("/api/login/status"); } catch { failed = true; }
      // 查询失败（网络/网关忙）别把已经显示的已登录额度清掉；只有接口明确回“没登录”才撤（195-O.9）
      if (failed && QB.cur && QB.cur.id === cur.id) return QB.cur;
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
    el.setAttribute("aria-label", t("额度速览"));   // 不抢焦点的浮卡，不是模态，不加 aria-modal
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
  const usBrief = (id) => { const x = usOther.get(id); if (!x) return ""; const br = x.login ? loginBrief(x.limits) : billBrief(x.bill); return br.text || (x.login ? t("发一条消息后显示") : "—"); };
  async function loadAcctCard(force) {
    if (!$("us-acct")) return;
    const cur = await qbLoad(force);
    if (curPage !== "usage") return;
    $("us-acct-name").textContent = cur ? cur.name : "";
    $("us-acct-cur").innerHTML = !cur ? "" : cur.login ? quotaHtml(cur.limits)
      : cur.bill ? billRows(cur.bill, { id: cur.id }) : `<div class="tiny">${t("查不到这个接口的额度")}</div>`;
    let list = [];
    try { list = (await api("/api/providers")).providers || []; } catch {}
    // 官方账户先问清登没登录再决定列不列：先列「读取中…」再删掉，行数一变下面的卡片就往上跳（#38）
    const lst = list.some((p) => p.login && p.id !== (cur ? cur.id : state.serverStatus?.provider)) ? await api("/api/login/status").catch(() => null) : null;
    if (curPage !== "usage") return;
    // 「其他」= 主卡那家以外的：主卡按会话那家算（可能不是全局），这里也按它排，别把会话那家列两遍、全局那家漏掉（#144-1）
    const others = list.filter((p) => p.id !== (cur ? cur.id : state.serverStatus?.provider) && !p.local && (p.login ? !!(lst && lst.loggedIn) : p.hasKey));
    const box = $("us-acct-others");
    const keep = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    box.innerHTML = others.length ? `<div class="sub">${t("其他接口")}</div>` + others.map((p) =>
      `<details class="qb-row" data-id="${esc(p.id)}"${keep.has(p.id) ? " open" : ""}><summary><span>${esc(pLabel(p))}</span><span class="grow"></span><span class="qb-brief tiny">${esc(usBrief(p.id) || t("读取中…"))}</span></summary><div class="qb-detail"></div></details>`).join("") : "";
    const fill = (d) => {
      const x = usOther.get(d.dataset.id), det = d.querySelector(".qb-detail");
      if (!x) return;
      det.innerHTML = x.login ? quotaHtml(x.limits) : x.bill ? billRows(x.bill, { id: d.dataset.id }) : "";
    };
    box.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => { if (d.open) fill(d); }));
    await Promise.all(others.map(async (p) => {
      let x;
      if (p.login) {
        x = { login: true, limits: lst.limits || null };
      } else {
        const b = await api(`/api/billing?id=${encodeURIComponent(p.id)}${force ? "&refresh=1" : ""}`).catch(() => null);
        x = { bill: b && !b.error ? b : null };
      }
      usOther.set(p.id, x);
      const d = box.querySelector(`details[data-id="${CSS.escape(p.id)}"]`);
      if (!d) return;
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
      ${p.endpoints.length > 1 ? `<div class="tiny" id="pc-endpoint-l" style="margin:0 0 4px">${t("线路")}</div>
        <select id="pc-endpoint" aria-labelledby="pc-endpoint-l">${p.endpoints.map((e) =>
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
        ${webUrl(p.keyUrl) ? `<br><a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${t("去官网创建 Key ↗")}</a>` : ""}
        <br>${esc(pHint(p) || t("Key 只存在本机应用私有目录，由 claude 的 apiKeyHelper 按需读取（不进环境变量），直连厂商的 Anthropic 兼容端点。"))}
        <br>${t("建议到厂商控制台设个单日消费上限和余额提醒；怀疑 Key 泄漏了，就在那里作废、换个新的。")}</div>
      ${p.hasKey ? `<div id="pc-bill" class="bill"></div>` : ""}`;
    if (p.hasKey) loadBill(p);
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "use") return useProvider(p);
      if (act === "clear") {
        if (!confirm(t("清除 {name} 的 Key？", { name: p.label }))) return;
        // 没清掉就别说「已清除」（审查 D-04）
        try { await post("/api/providers/save", { id: p.id, clearKey: true }); } catch (e2) { return toast(e2.message, true); }
        return reloadProv(t("已清除"));
      }
      const body = { id: p.id, apiKey: $("pc-key").value.trim() };
      if ($("pc-endpoint")) body.endpoint = $("pc-endpoint").value;
      // 还没 Key、输入框也空着：点保存不能说「已保存」，其实什么都没配上（审查 P3-3）
      if (act === "save" && !body.apiKey && !p.hasKey && !(body.endpoint && body.endpoint !== p.endpoint)) return toast(t("先把 API Key 粘进来再保存"), true);
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
    dropProvModels();   // 改的可能是别家（项目 / 定时任务菜单用的那份缓存）
    await loadProviders();
    if (id === state.providerActive) await loadModels(true);
    refreshSessModel();   // 默认型号可能改了：跟随默认（或钉在这家默认型号上）的会话标签跟着重画（#81）
    if (thenTest) {
      const p = state.providers.find((x) => x.id === id);
      if (p && p.hasKey) testAndShow(id);
    }
  }


  // ── 导入的字体（0.4.20）：清单在网关 /api/fonts（gw/fonts.mjs），槽位与 @font-face 由 theme.js 管 ──
  //   设置 → 通用里两个字体槽位（界面 / 回复）都有「自选…」：点了弹菜单列出导入的字体，末尾「导入字体…」；
  //   一个都没导入时直接打开选文件。从某个槽位进去导入的，导入完就用在那个槽位上。
  const UF_SLOT = { uf: "uifont", rf: "readfont" };
  let ufFor = "";   // 从哪个槽位点的「导入字体…」：导完就用上
  async function loadFonts() {
    const r = await api("/api/fonts").catch(() => null);
    if (r && window.Theme && Theme.setFonts) Theme.setFonts(r.items || []);
    paintFonts(r ? r.items || [] : null);
  }
  function paintFonts(items) {
    // 自选按钮上写当前用的字体名（没选导入字体时只写「自选…」）
    for (const [d, k] of Object.entries(UF_SLOT)) {
      const f = window.Theme && Theme.fontOf ? Theme.fontOf(k) : null;
      document.querySelectorAll(`[data-${d}="pick"]`).forEach((b) => {
        b.classList.toggle("named", !!f);
        const i = b.querySelector(".uf-cur"); if (i) { i.textContent = f ? f.name : ""; i.style.fontFamily = f ? Theme.fam(f.id) : ""; }
        b.title = f ? f.name : "";
      });
    }
    const box = $("uf-list"); if (!box || !items) return;
    // 清单每行用它自己的字体显示名字，一眼能看出长什么样
    box.innerHTML = items.map((f) => `<div class="uf-item" data-uf-id="${esc(f.id)}"><span class="uf-nm" style="font-family:${esc(Theme.fam(f.id))},var(--font-ui)">${esc(f.name)}</span>`
      + `<small>${esc(f.fmt)} · ${esc(fmtSize(f.size))}</small><button type="button" class="icon-btn uf-del" title="${esc(t("删除"))}"><svg viewBox="0 0 24 24">${ICONS.del}</svg></button></div>`).join("");
    box.classList.toggle("hidden", !items.length);
  }
  async function importFont(file) {
    if (!file) return;
    // 槽位在开始时取走：上传没完又从另一个槽位导入，ufFor 会被改掉，先回来的那个不能用到别的槽上（#133）
    const slot = ufFor; ufFor = "";
    if (file.size > 40 * 1024 * 1024) { toast(t("字体文件不能超过 40 MB"), true); return; }
    toast(t("正在导入 {name}…", { name: file.name }));
    let r;
    try {
      const res = await fetch("/api/fonts?name=" + encodeURIComponent(file.name), { method: "POST", body: file, headers: { "X-CC-Lang": I18N.lang } });
      r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.message || r.error || "HTTP " + res.status);
    } catch (e) { toast(t("导入失败：{msg}", { msg: e.message }), true); return; }
    await loadFonts();
    if (slot) { Theme.setType(slot, "u:" + r.font.id); paintFonts(null); }
    toast(r.dup ? t("这个字体已经导入过了：{name}", { name: r.font.name }) : t("已导入 {name}", { name: r.font.name }));
    const row = document.querySelector(`#uf-list [data-uf-id="${r.font.id}"]`); if (row) MO.play(row, "mo-in-rise", 1400);
  }
  function pickFont(b, d) {
    const k = UF_SLOT[d], fonts = (window.Theme && Theme.fonts) || [], cur = Theme.type[k];
    const add = () => { ufFor = k; $("uf-file").click(); };
    if (!fonts.length) return add();
    const items = fonts.map((f) => ({ label: f.name, small: f.fmt, cur: cur === "u:" + f.id, icon: cur === "u:" + f.id ? '<path d="M5 12l5 5 9-10"/>' : "", fn: () => { Theme.setType(k, "u:" + f.id); paintFonts(null); } }));
    items.push("hr", { label: t("导入字体…"), icon: '<path d="M12 5v14M5 12h14"/>', fn: add });
    popMenu(b, items);
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#seg-uifont [data-uf=pick], #seg-readfont [data-rf=pick]");
    if (b) { const d = Object.keys(UF_SLOT).find((x) => b.dataset[x]); pickFont(b, d); }
  });
  $("uf-add")?.addEventListener("click", () => { ufFor = ""; $("uf-file").click(); });
  $("uf-file")?.addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; importFont(f); });
  $("uf-list")?.addEventListener("click", async (e) => {
    const del = e.target.closest(".uf-del"); if (!del) return;
    const row = del.closest("[data-uf-id]"), id = row.dataset.ufId, f = (Theme.fonts || []).find((x) => x.id === id);
    const using = Object.values(UF_SLOT).filter((k) => Theme.type[k] === "u:" + id).length;
    if (!confirm(using ? t("删除字体 {name}？正在用它的地方会换回默认字体。", { name: f ? f.name : id }) : t("删除字体 {name}？", { name: f ? f.name : id }))) return;
    try { await post("/api/fonts/del", { id }); } catch (err) { toast(err.message, true); return; }
    if (MO.on() && row.animate) await row.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${MO.rtl() ? 24 : -24}px)` }], { duration: 155, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
    await loadFonts();
  });

  // ── 顶栏按钮（0.4.20）：设置 → 通用。每个按钮 常驻 / 收起 / 隐藏，按住把手拖动排序；摆法见 19-boot.js 的 paintTopbar ──
  const TB_NAME = { files: tk("文件浏览器"), term: tk("终端"), web: tk("浏览器"), palette: tk("命令面板"), new: tk("新会话") };
  const GRIP = '<svg viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>';
  // 清单照顶栏实际的样子排：先常驻、再收进 ⋯、最后隐藏，组内按 order。看到什么顺序顶栏就是什么顺序
  const tbMode = (c, k) => (c.off.includes(k) ? "off" : c.pin.includes(k) ? "pin" : "fold");
  const TB_GROUPS = ["pin", "fold", "off"];
  function tbShown(c) {
    // 浏览器键只在有内置浏览器的壳里出现；没有的不列，免得设了没反应
    const keys = c.order.filter((k) => !$(TB_BTNS[k]).classList.contains("hidden"));
    return TB_GROUPS.flatMap((g) => keys.filter((k) => tbMode(c, k) === g));
  }
  function renderTbList() {
    const box = $("tb-list"); if (!box) return;
    const c = tbConf();
    let prev = "";
    box.innerHTML = tbShown(c).map((k) => {
      const m = tbMode(c, k), first = m !== prev && prev; prev = m;
      const ico = $(TB_BTNS[k]).querySelector("svg").outerHTML;
      return `<div class="tb-item${first ? " tb-g1" : ""}" data-k="${k}" data-g="${m}"><span class="tb-grip" title="${esc(t("拖动换顺序"))}">${GRIP}</span><span class="tb-ico">${ico}</span><span class="tb-nm">${esc(t(TB_NAME[k]))}</span>`
        + `<span class="seg tb-seg">${[["pin", t("常驻")], ["fold", t("收进 ⋯")], ["off", t("隐藏")]].map(([v, l]) => `<button type="button" data-tbm="${v}"${v === m ? ' class="on"' : ""}>${esc(l)}</button>`).join("")}</span></div>`;
    }).join("");
  }
  function tbSave(c) {
    const same = JSON.stringify(c.order) === JSON.stringify(TB_ORDER) && !c.pin.length && !c.off.length;
    uiSet("topbar", same ? null : c);   // 和默认一样就删掉这一项，以后默认变了也跟着走
  }
  document.addEventListener("cc:ui", (e) => { if (e.detail.key === "topbar") renderTbList(); });
  $("tb-reset")?.addEventListener("click", () => tbSave({ order: TB_ORDER.slice(), pin: [], off: [] }));
  $("tb-list")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tbm]"); if (!b) return;
    const k = b.closest("[data-k]").dataset.k, c = tbConf(), to = b.dataset.tbm;
    if (tbMode(c, k) === to) return;
    // 换组的那个落在两组交界：改常驻排到常驻末尾（紧挨 ⋯），改收起 / 隐藏排到那组开头
    const list = tbShown(c).filter((x) => x !== k);
    c.pin = c.pin.filter((x) => x !== k); c.off = c.off.filter((x) => x !== k);
    if (to === "pin") c.pin.push(k); else if (to === "off") c.off.push(k);
    const groups = TB_GROUPS.map((g) => list.filter((x) => tbMode(c, x) === g));
    groups[TB_GROUPS.indexOf(to)][to === "pin" ? "push" : "unshift"](k);
    const shown = groups.flat();
    c.order = shown.concat(c.order.filter((x) => !shown.includes(x)));
    const row = b.closest(".tb-item"), y0 = row.getBoundingClientRect().top;
    tbSave(c);   // cc:ui → 重画；换了位置的那行从原处弹到新位置
    const nr = $("tb-list").querySelector(`[data-k="${k}"]`);
    if (nr) { const dy = y0 - nr.getBoundingClientRect().top; if (Math.abs(dy) > .5) MO.spring(nr, "snap", (p) => ({ transform: `translateY(${dy * (1 - p)}px)` })); }
  });
  // 拖动排序：被拖的那行跟手走，其余行让位（都是 transform），松手按落点重排，被拖的那行弹回它的新位置
  (() => {
    const box = $("tb-list"); if (!box) return;
    let d = null;
    box.addEventListener("pointerdown", (e) => {
      const g = e.target.closest(".tb-grip"); if (!g || e.button > 0) return;
      e.preventDefault();
      const row = g.closest(".tb-item"), rows = [...box.children], i = rows.indexOf(row);
      const step = rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : row.offsetHeight;
      // 只在本组里排：跨组靠右边的三选一，不靠拖
      const gi = rows.map((r, j) => (r.dataset.g === row.dataset.g ? j : -1)).filter((j) => j >= 0);
      d = { row, rows, i, to: i, y0: e.clientY, step, id: e.pointerId, a: gi[0], z: gi[gi.length - 1] };
      try { g.setPointerCapture(e.pointerId); } catch {}
      row.classList.add("dragging"); box.classList.add("sorting");
    });
    box.addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y0;
      const lo = (d.a - d.i) * d.step - d.step * .4, hi = (d.z - d.i) * d.step + d.step * .4;
      const y = Math.max(lo, Math.min(hi, dy));
      d.row.style.transform = `translateY(${y}px)`;
      d.to = Math.max(d.a, Math.min(d.z, d.i + Math.round(y / d.step)));
      d.rows.forEach((r, j) => {
        if (r === d.row) return;
        const s = d.i < j && j <= d.to ? -d.step : d.to <= j && j < d.i ? d.step : 0;
        r.style.transform = s ? `translateY(${s}px)` : "";
      });
    });
    const end = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const { row, rows, i, to } = d; d = null;
      const y0 = row.getBoundingClientRect().top;
      box.classList.remove("sorting"); row.classList.remove("dragging");
      rows.forEach((r) => (r.style.transform = ""));
      if (to === i) { const dy = y0 - row.getBoundingClientRect().top; if (Math.abs(dy) > .5) MO.spring(row, "snap", (p) => ({ transform: `translateY(${dy * (1 - p)}px)` })); return; }
      const c = tbConf(), shown = rows.map((r) => r.dataset.k), k = shown.splice(i, 1)[0];
      shown.splice(to, 0, k);
      c.order = shown.concat(c.order.filter((x) => !shown.includes(x)));
      tbSave(c);   // 触发 cc:ui → 重画清单；新清单里被拖的那行从松手处弹到位
      const nr = box.querySelector(`[data-k="${k}"]`);
      if (nr) { const dy = y0 - nr.getBoundingClientRect().top; if (Math.abs(dy) > .5) MO.spring(nr, "snap", (p) => ({ transform: `translateY(${dy * (1 - p)}px)` })); }
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
  })();

  // ── 强调色（0.4.20）：预设八色 + 自定取色；实际用的颜色由 theme.js 按当前外观的底色调过（色块显示的就是调过的） ──
  const AC_PRESETS = [["#2b6fd6", tk("蓝")], ["#0f8b8d", tk("青")], ["#2f8a4c", tk("绿")], ["#b7791f", tk("琥珀")], ["#d9622b", tk("橙")], ["#d23a2f", tk("红")], ["#c2408a", tk("品红")], ["#7a4fd0", tk("紫")]];
  function renderAccent() {
    const box = $("ac-sw"); if (!box || !window.Theme || !Theme.accentFor) return;
    const cur = /^#[0-9a-f]{6}$/i.test(uiGet("accent") || "") ? uiGet("accent") : "", skin = Theme.skin, mode = Theme.current || "light";
    const sw = (hex) => Theme.accentFor(hex, skin, mode).acc;
    const custom = cur && !AC_PRESETS.some(([h]) => h === cur);
    // 拾色的「默认」就是跟随壁纸：色块直接涂成壁纸推出来的主色，不画斜杠
    const wall = skin === "shise" ? Theme.accentFor(Theme.wallSeed() || "#6750a4", skin, mode).acc : "";
    box.innerHTML = (wall
      ? `<button type="button" class="ac-dot${cur ? "" : " on"}" data-ac="" title="${esc(t("跟随壁纸"))}" style="background:${wall}"></button>`
      : `<button type="button" class="ac-dot ac-def${cur ? "" : " on"}" data-ac="" title="${esc(t("默认"))}"><svg viewBox="0 0 24 24"><path d="M6 18L18 6"/></svg></button>`)
      + AC_PRESETS.map(([h, n]) => `<button type="button" class="ac-dot${cur === h ? " on" : ""}" data-ac="${h}" title="${esc(t(n))}" style="background:${sw(h)}"></button>`).join("")
      + `<label class="ac-dot ac-pick${custom ? " on" : ""}" title="${esc(t("自定颜色"))}"${custom ? ` style="background:${sw(cur)}"` : ""}><input type="color" value="${custom ? cur : "#2b6fd6"}"></label>`;
  }
  function setAccent(hex) {
    uiSet("accent", hex || null);   // cc:ui → Theme.apply()（02-chat-view.js 里接）
    renderAccent();
    const on = $("ac-sw")?.querySelector(".on"); if (on) MO.play(on, "mo-tick", 900);
  }
  $("ac-sw")?.addEventListener("click", (e) => { const b = e.target.closest("[data-ac]"); if (b) setAccent(b.dataset.ac); });
  // 取色器拖动时 input 连续触发：只改本地预览（不写网关），change（松手 / 关面板）才存
  $("ac-sw")?.addEventListener("input", (e) => {
    if (e.target.type !== "color") return;
    const lab = e.target.closest(".ac-pick"); lab.style.background = Theme.accentFor(e.target.value, Theme.skin, Theme.current).acc;
  });
  $("ac-sw")?.addEventListener("change", (e) => { if (e.target.type === "color") setAccent(e.target.value.toLowerCase()); });
  // 换外观 / 深浅时色块跟着重算（theme.js 只改 html 属性，不发事件）
  new MutationObserver(() => renderAccent()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });

  // ── 构成浅色的纸色（0.6.2）：拖动只预览，松手存进 ccapp-ui.json 的 gcPaper（50 = 默认，存成 null） ──
  function renderPaper() {
    const rg = $("gp-range"); if (!rg || !window.Theme || !Theme.gcPaperPref) return;
    const v = Theme.gcPaperPref();
    if (document.activeElement !== rg) rg.value = v;
    rg.style.setProperty("--p", rg.value + "%");
  }
  $("gp-range")?.addEventListener("input", (e) => { Theme.gcPreview(+e.target.value); e.target.style.setProperty("--p", e.target.value + "%"); });
  $("gp-range")?.addEventListener("change", (e) => { const v = +e.target.value; Theme.gcPreview(null); uiSet("gcPaper", v === 50 ? null : v); renderPaper(); });
  $("gp-reset")?.addEventListener("click", () => { Theme.gcPreview(null); uiSet("gcPaper", null); renderPaper(); });
  document.addEventListener("cc:ui", (e) => { if (e.detail.key === "gcPaper") renderPaper(); });
  renderPaper();

  // ── 消息下面的按钮（0.4.20）：每个按钮点一下切显示 / 隐藏，藏法见 02-chat-view.js 的 paintActHide ──
  const ACT_NAME = { copy: tk("复制"), resend: tk("重发"), rewind: tk("回退到这里"), mark: tk("书签"), del: tk("删除"), share: tk("转发"), fork: tk("从这里分叉") };
  function renderMsgActs() {
    const box = $("ma-list"); if (!box) return;
    const h = msgActsHidden();
    box.innerHTML = [["user", t("你的消息")], ["bot", t("Claude 的回复")]].map(([w, lab]) => `<div class="ma-line"><span class="ma-who">${esc(lab)}</span>`
      + ACTS[w].map((k) => `<button type="button" class="ma-chip${h[w].includes(k) ? "" : " on"}" data-w="${w}" data-k="${k}" aria-pressed="${!h[w].includes(k)}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg><span>${esc(t(ACT_NAME[k]))}</span></button>`).join("") + "</div>").join("");
  }
  $("ma-list")?.addEventListener("click", (e) => {
    const b = e.target.closest(".ma-chip"); if (!b) return;
    const h = msgActsHidden(), w = b.dataset.w, k = b.dataset.k;
    h[w] = h[w].includes(k) ? h[w].filter((x) => x !== k) : h[w].concat(k);
    uiSet("msgActs", h.user.length || h.bot.length ? h : null);
    renderMsgActs();
  });
  $("ma-reset")?.addEventListener("click", () => { uiSet("msgActs", null); renderMsgActs(); });
  document.addEventListener("cc:ui", (e) => { if (e.detail.key === "msgActs") renderMsgActs(); if (e.detail.key === "accent") renderAccent(); });

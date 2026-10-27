  // ── 扩展：插件 / 技能 / MCP ──────────────────────────────────────────
  const ext = { q: "", offset: 0, busy: false };
  // 设计稿的行：左名称 + 一行等宽小字，右边大小 / 状态 / 按钮；说明、依赖这些点一下行才展开（.it-more），进度条一直在
  const EI = {
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-7"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    tool: '<path d="M4 20l7-7M14 4l6 6-3 3-6-6zM10 8l6 6"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
  };
  const ei = (n) => `<svg class="ei" viewBox="0 0 24 24">${EI[n]}</svg>`;
  const sdot = (st, label) => `<span class="sdot ${st}"><i></i>${esc(label)}</span>`;
  const rowItem = (title, sub, right, o = {}) => `<div class="item xrow${o.cls ? " " + o.cls : ""}"${o.tags ? ` data-tags="${esc(o.tags.join(" "))}"` : ""}>
      <div class="xr-l"><div class="it-title">${title}</div>${sub ? `<div class="xr-sub">${sub}</div>` : ""}</div>
      <div class="xr-r">${right || ""}</div>${o.extra || ""}${o.more ? `<div class="it-more">${o.more}</div>` : ""}</div>`;
  // 点行（不是点按钮、链接、输入框）展开 / 收起说明
  $("tab-ext").addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, textarea, label, summary, details, .gh-auth, .llm-dl")) return;
    const r = e.target.closest(".xrow, .ccard"); if (r && r.querySelector(".it-more")) r.classList.toggle("open");
  });
  const extItem = (title, meta, acts, desc, tags) => `<div class="item"${tags ? ` data-tags="${esc(tags.join(" "))}"` : ""}>
      <div class="it-title">${title}</div>
      ${meta ? `<div class="it-meta">${meta}</div>` : ""}
      ${desc || ""}
      ${acts ? `<div class="it-acts">${acts}</div>` : ""}</div>`;

  // ── 工具包模块（0.3.9 起）：基础 + 随装随卸的模块；用途、命令、包、大小、依赖、谁在用都摆出来 ──
  let modTimer = 0;
  const MOD_USES = () => ({
    claude: t("Claude Code 本身"), git: t("git 面板"), terminal: t("终端"), shizuku: t("Shizuku 一键启动（无线调试）"), search: t("Claude 搜代码、看差异"),
    "native-build": t("编译原生程序"), apk: t("打 APK"), "usb-adb": t("USB 调试"), "gpu-components": t("GPU 组件（Blender、浏览器等）"),
    media: t("音视频处理"), docs: t("排版、表格分析、图片处理"),
  });
  async function loadModules() {
    clearTimeout(modTimer);
    const r = await api("/api/devkit/modules").catch(() => null);
    const on = !!(r && r.supported && r.modular);
    $("mod-field").classList.toggle("hidden", !on);
    if (!on) return;
    const items = r.items || [], byId = Object.fromEntries(items.map((m) => [m.id, m]));
    const nameOf = (id) => esc(pickLang((byId[id] || {}).name) || id);
    const inst = items.filter((m) => m.state === "ok");
    $("mod-count").textContent = inst.length + "/" + items.length;
    ext.nMod = items.length; extSub();
    ext.modBytes = inst.reduce((s, m) => s + m.installed, 0); ext.free = r.free; paintStorage();
    const btn = (c, id, label, extra = "") => `<button data-c="${c}" data-id="${esc(id)}"${extra}>${label}</button>`;
    let moving = false;
    $("mod-list").innerHTML = items.map((m) => {
      const pr = m.progress;
      moving ||= !!pr;
      const st = { absent: t("未安装"), downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"), ok: t("已安装"), error: t("安装失败") }[m.state] || m.state;
      const kind = m.required ? t("必装") : m.kind === "shared" ? t("共享运行库") : "";
      const meta = "<span>" + esc(st) + "</span>" + (kind ? "<span>" + kind + "</span>" : "") +
        "<span>" + (m.state === "ok" ? t("占用 {b}", { b: MB(m.installed) }) : t("下载约 {a}，装好后约 {b}", { a: MB(m.download), b: MB(m.installed) })) + "</span>";
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(m.desc)) + "</div>";
      const uses = (m.uses || []).map((u) => MOD_USES()[u] || u);
      if (uses.length) desc += '<div class="tiny">' + t("App 里用到它的：{list}", { list: esc(listOf(uses)) }) + "</div>";
      const deps = (m.deps || []).filter((d) => byId[d] && !byId[d].required);
      if (deps.length) desc += '<div class="tiny">' + t("依赖：{list}", { list: listOf(deps.map(nameOf)) }) + "</div>";
      if (m.kind === "shared" && (m.users || []).length) desc += '<div class="tiny">' + t("给这些模块用：{list}", { list: listOf(m.users.map(nameOf)) }) + "</div>";
      const used = [...(m.usedBy.modules || []).map(nameOf), ...(m.usedBy.components || []).map((c) => esc(c))];
      if (used.length) desc += '<div class="tiny">' + t("正在用它的：{list}", { list: listOf(used) }) + "</div>";
      if (m.error) desc += '<div class="tiny err">' + esc(m.error) + "</div>";
      // 命令与包：点开看全部
      const cmds = m.commands || [];
      if ((m.key || []).length) desc += '<div class="tiny">' + t("主要命令：") + " " + m.key.map((x) => "<code>" + esc(x) + "</code>").join(" ") + "</div>";
      desc += '<details class="tiny"><summary>' + t("{n} 个命令、{p} 个包", { n: cmds.length, p: (m.packages || []).length }) + "</summary>" +
        (cmds.length ? "<div>" + cmds.map((c) => "<code>" + esc(c) + "</code>").join(" ") + "</div>" : "") +
        '<div class="mono" style="margin-top:4px;color:var(--fg3)">' + (m.packages || []).map(esc).join("<br>") + "</div>" +
        '<div style="margin-top:4px;color:var(--fg3)">' + t("来源：Termux 官方仓库 · 快照 {s}", { s: esc(r.snapshot || "") }) + (m.sha256 ? "<br>sha256 " + esc(m.sha256) : "") + "</div></details>";
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + (pr.current && pr.current !== m.id ? nameOf(pr.current) + " · " : "") + MB(pr.done) + " / " + MB(pr.total) + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      let acts = "", size = MB(m.state === "ok" ? m.installed : m.download);
      if (m.required || m.kind === "shared") acts = m.state === "ok" ? sdot("ok", t("已装")) : sdot("", st);
      else if (m.state === "absent" || m.state === "error") {
        // 连同还没装的依赖一起算下载量
        const chain = [...deps.filter((d) => byId[d].state !== "ok"), m.id];
        size = MB(chain.reduce((s, id) => s + byId[id].download, 0));
        acts = (m.state === "error" ? sdot("err", st) : "") + btn("install", m.id, ei("download") + (m.state === "error" ? t("重试") : t("安装")), ' class="btn sm"' + (chain.length > 1 ? ` data-chain="${esc(listOf(chain.map(nameOf)))}"` : ""));
      } else if (m.state === "downloading" || m.state === "verifying" || m.state === "installing") acts = sdot("warn", st) + (m.state === "installing" ? "" : btn("cancel", m.id, t("取消"), ' class="btn sm ghost"'));
      else if (m.state === "ok") acts = btn("remove", m.id, t("卸载"), ' class="btn sm ghost"' + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
      const tag = m.required ? `<span class="tag">${ei("lock")}${t("必装")}</span>` : m.kind === "shared" ? `<span class="tag">${t("共享运行库")}</span>` : "";
      return rowItem(esc(pickLang(m.name) || m.id) + tag, '<span class="mono">' + (m.key || []).map(esc).join(" ") + "</span>",
        '<span class="num">' + size + "</span>" + acts, { more: desc, extra: bar });
    }).join("");
    if (moving && pageOn("ext")) modTimer = setTimeout(loadModules, 1500);
  }
  $("mod-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b) return;
    const c = b.dataset.c, id = b.dataset.id;
    if (c === "remove") {
      if (b.dataset.usedby) return toast(t("{names} 要用它，先卸载那些", { names: b.dataset.usedby }), true);
      if (!confirm(t("卸载这个模块？它的命令会从工具包里删掉，别的模块和组件还在用的文件会留下。以后可以随时再装。"))) return;
    }
    if (c === "install" && b.dataset.chain && !confirm(t("会一起装上：{list}。继续？", { list: b.dataset.chain }))) return;
    b.disabled = true;
    const r = await post("/api/devkit/modules/" + c, { id }).catch((e2) => ({ ok: false, message: e2.message }));
    if (!r.ok) toast(r.message || t("失败"), true);
    setTimeout(loadModules, 300);
  });

  function loadExt() { loadModules(); loadComponents(60); loadCustom(); loadExtPlugins(); loadExtSkills(); loadExtMcp(); loadExtMarkets(); loadExtHooks(); }

  // ── 分类索引条：扩展页每节一条，横向滚动。点一下只看那一类，点「全部」复原；刷新列表后选中的分类保留 ──
  // 条目带 data-tags（空格分隔的分类键）。labels 定顺序和显示名；没列出的键（如插件市场名 m:<名字>）按名字附在后面
  const tg = (s) => encodeURIComponent(String(s));
  const extPick = {}, extLabels = {};
  const CAT = () => ({ dev: t("开发工具"), office: t("文档办公"), media: t("图像影音"), science: t("科学计算"), eda: t("电子设计"),
    cad: t("3D 与建模"), ai: t("AI 推理"), gpu: t("GPU 与驱动"), net: t("网络"), other: t("其他") });
  function renderIdx(sec, labels) {
    if (labels) extLabels[sec] = labels; else labels = extLabels[sec] || [];
    const bar = $(sec + "-idx"); if (!bar) return;
    const items = [...document.querySelectorAll(`details[data-sec="${sec}"] .item[data-tags]`)];
    const count = new Map();
    for (const it of items) for (const g of it.dataset.tags.split(" ")) count.set(g, (count.get(g) || 0) + 1);
    const known = new Set(labels.map(([g]) => g));
    const chips = [...labels.filter(([g]) => count.get(g)),
      ...[...count.keys()].filter((g) => !known.has(g)).sort().map((g) => [g, decodeURIComponent(g.replace(/^[a-z]+:/, ""))])];
    if (extPick[sec] && !count.get(extPick[sec])) extPick[sec] = "";
    const cur = extPick[sec] || "";
    bar.classList.toggle("hidden", chips.length < 2 && !cur);      // 只有一类时没什么可切的
    bar.innerHTML = [["", t("全部"), items.length], ...chips.map(([g, l]) => [g, l, count.get(g)])]
      .map(([g, l, n]) => `<button class="idx-chip${g === cur ? " on" : ""}" data-sec="${sec}" data-idx="${esc(g)}">${esc(l)}${g ? `<span>${n}</span>` : ""}</button>`).join("");
    for (const it of items) it.classList.toggle("hidden", !!cur && !it.dataset.tags.split(" ").includes(cur));
  }
  $("tab-ext").addEventListener("click", (e) => {
    const c = e.target.closest(".idx-chip"); if (!c) return;
    extPick[c.dataset.sec] = c.dataset.idx; renderIdx(c.dataset.sec);
  });
  // 节头照设计稿：图标块 + 标题，下面一句说明（原来是节里第一行小字，挪进标题里）；节不再折叠，靠顶上的分区导航跳
  for (const d of document.querySelectorAll("#tab-ext details.ext-sec")) {
    d.open = true;
    const sum = d.querySelector(":scope > summary"), tip = sum.nextElementSibling;
    if (tip && tip.classList.contains("tiny")) { tip.classList.add("sec-desc"); sum.appendChild(tip); }
    sum.addEventListener("click", (e) => e.preventDefault());
  }

  // ── 可选组件（浏览器组件 = 无头 Chromium）：下载 → 校验 → 换进工具包，进度靠轮询 ──
  let compTimer = 0;
  // 只有 zh / en 两份：中文界面（简繁都算）用 zh，其它语言一律用 en
  const pickLang = (o) => (o && typeof o === "object" ? (isZh() ? o.zh || o.en : o.en || o.zh) || "" : o || "");
  // 一整块工具包动辄上 GB：999 MB 之后就用 GB，手机上那一列放得下、也一眼看得懂
  const MB = (n) => (n || 0) >= 1048576 * 1024 ? (n / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round((n || 0) / 1048576)) + " MB";
  // 「A、B 和 C」这种并列按当前语言的习惯拼
  const listOf = (a) => { try { return new Intl.ListFormat((window.I18N && I18N.lang) || "zh", { type: "conjunction" }).format(a); } catch { return a.join(", "); } };
  // 顶栏副标题：几个模块 · 几个组件
  function extSub() { setPageSub("ext", [ext.nMod ? t("{n} 个模块", { n: ext.nMod }) : "", ext.nComp ? t("{n} 个组件", { n: ext.nComp }) : ""].filter(Boolean).join(" · ")); }
  // 分类的颜色和图标（卡片左上角）
  const CAT_LOOK = { gpu: ["#c96442", "cube"], cad: ["#c96442", "cube"], media: ["#b5532f", "play"], office: ["#2f6aa8", "book"], science: ["#7650c0", "gauge"],
    eda: ["#9a6a00", "bolt"], ai: ["#3d7a2a", "spark"], dev: ["#5d594f", "tool"], net: ["#2f6aa8", "globe"], other: ["#5d594f", "puzzle"] };
  // 存储条：工具包模块 + 组件占多少，盘里还剩多少
  function paintStorage() {
    const el = $("ext-storage"); if (!el) return;
    const a = ext.modBytes || 0, b = ext.compBytes || 0, all = a + b + (ext.free || 0);
    el.classList.toggle("hidden", !a && !b);
    if (!all) return;
    const GB = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(n >= 107374182400 ? 0 : 1) + " GB" : MB(n);
    el.innerHTML = `<div class="st-bar"><i style="width:${(a / all * 100).toFixed(2)}%;background:#c96442"></i><i style="width:${(b / all * 100).toFixed(2)}%;background:#2f6aa8"></i></div>
      <div class="st-leg"><span><b class="sw" style="background:#c96442"></b>${t("工具包")} <span class="num">${GB(a)}</span></span><span><b class="sw" style="background:#2f6aa8"></b>${t("组件")} <span class="num">${GB(b)}</span></span>${ext.free != null ? `<span class="muted">${t("剩余")} <span class="num">${GB(ext.free)}</span></span>` : ""}</div>`;
  }
  // 组件节头的「检查更新」：强制重拉组件索引
  $("comp-check").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); loadComponents(true).then(() => toast(t("已检查组件更新"))); });
  async function loadComponents(refresh) {
    clearTimeout(compTimer);
    const r = await api("/api/components" + (refresh ? "?refresh=" + (refresh === true ? 1 : refresh) : "")).catch((e) => ({ supported: true, items: [], indexError: e.message }));
    $("comp-field").classList.toggle("hidden", !r.supported);
    if (!r.supported) return loadGhField();
    const box = $("comp-list");
    const btn = (c, id, label) => `<button data-c="${c}" data-id="${esc(id)}">${label}</button>`;
    const html = (r.items || []).map((c) => {
      const name = esc(pickLang(c.name) || c.id), pr = c.progress;
      const size = c.available ? t("下载约 {a}，装好后约 {b}", { a: MB(c.bytes), b: MB(c.installed) }) : "";
      const st = {
        absent: c.available ? t("未安装") : t("暂无适配当前工具包的版本"),
        downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"),
        ok: t("已安装"), update: t("有新版本"), outdated: t("工具包已更新，需要重新安装"),
        damaged: t("安装不完整，需要重新安装"), error: t("安装失败"),
      }[c.state] || c.state;
      // 依赖没装齐：安装按钮置灰，下面写明要先装哪个；只限骁龙的组件在别家 SoC 上干脆不给装
      const miss = (c.requires || []).filter((d) => !d.ok).map((d) => esc(pickLang(d.name) || d.id));
      const gpuOnly = c.needs && (c.needs.gpu === "adreno" || c.needs.gpu === "mali") ? c.needs.gpu : "";
      let acts = "";
      if (c.state === "absent" && c.available && !c.unsupported) acts = btn("install", c.id, t("下载安装"));
      else if (c.state === "downloading" || c.state === "verifying") acts = btn("cancel", c.id, t("取消"));
      else if (c.state === "ok") acts = btn("remove", c.id, t("卸载"));
      else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) acts += btn("install", c.id, c.state === "update" ? t("更新") : t("重新安装"));
        if (c.installedVersion) acts += btn("remove", c.id, t("卸载"));
      }
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + MB(pr.done) + " / " + MB(pr.total) + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      const ver = c.installedVersion || c.version;
      const meta = "<span>" + esc(st) + "</span>" + (ver ? "<span>" + esc(ver) + "</span>" : "") +
        (size && c.state !== "ok" ? "<span>" + esc(size) + "</span>" : "") +
        // 社区组件标出来；没有真机验证记录的再加一个提醒
        (c.source === "community" ? "<span>" + t("社区") + "</span>" : "") +
        (!c.verified ? '<span class="warn">' + t("未经真机验证") + "</span>" : "") +
        (c.license && c.state !== "ok" ? "<span>" + esc(c.license) + "</span>" : "") +
        (gpuOnly && c.state !== "ok" ? (c.unsupported ? '<span class="warn">' + (gpuOnly === "mali" ? t("只限 ARM Mali GPU（天玑、Exynos 等）设备，本机用不了") : t("只限高通骁龙（Adreno GPU）设备，本机用不了")) + "</span>"
          : "<span>" + (gpuOnly === "mali" ? t("Mali 专用") : t("骁龙专用")) + "</span>") : "");
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(c.desc)) + "</div>";
      if (c.error) desc += '<div class="tiny err">' + esc(c.error) + "</div>";
      if (miss.length && c.state !== "ok") desc += '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>";
      if (c.homepage && c.state !== "ok") desc += '<div class="tiny"><a class="weblink" href="' + esc(c.homepage) + '">' + esc(c.homepage) + "</a></div>";
      if (c.state === "ok" && c.bin.length) desc += '<div class="tiny">' + t("命令：") + " " + c.bin.map((b) => "<code>" + esc(b) + "</code>").join(" ") + "</div>";
      if (c.id === "gh" && c.state === "ok") desc += '<div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div>";
      if (c.id === "llama-cpp" && c.state === "ok") desc += '<details class="llm-dl" id="llm-dl"' + (llmDl.open ? " open" : "") + "><summary>" + t("下载模型") + '</summary><div id="llm-dl-body">' + llmDl.html + "</div></details>";
      const used = (c.usedBy || []).map((d) => esc(pickLang(d.name) || d.id));
      const cat = c.category && CAT()[c.category] ? c.category : "other";
      const tags = ["cat:" + cat];
      if (c.state === "ok") tags.push("inst");
      if (["update", "outdated", "damaged", "error"].includes(c.state)) tags.push("upd");
      // 设计稿的卡片：分类色图标 + 名称 + 「版本 · 大小」，验证过的带盾牌；底下一条虚线隔开状态和按钮
      const [cc, ci] = CAT_LOOK[cat] || CAT_LOOK.other;
      const dotSt = { ok: "ok", update: "warn", downloading: "warn", verifying: "warn", installing: "warn", outdated: "err", damaged: "err", error: "err" }[c.state] || "";
      const dotL = c.unsupported ? (gpuOnly === "mali" ? t("需要 Mali GPU") : t("需要骁龙")) : { ok: t("已装"), update: t("可更新"), absent: c.available ? t("未装") : t("暂无适配版本") }[c.state] || st;
      let cbtn = "";
      if (c.unsupported && c.state !== "ok") cbtn = '<span class="muted">' + t("本机用不了") + "</span>";
      else if (c.state === "absent" && c.available) cbtn = btn("install", c.id, ei("download") + MB(c.bytes)).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "downloading" || c.state === "verifying") cbtn = btn("cancel", c.id, t("取消")).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "ok") cbtn = btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
      else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) cbtn += btn("install", c.id, ei("download") + (c.state === "update" ? t("更新") : t("重新安装"))).replace("<button ", '<button class="btn sm" ');
        if (c.installedVersion) cbtn += btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
      }
      const live = (c.id === "gh" && c.state === "ok") || (c.id === "llama-cpp" && c.state === "ok") ? desc.slice(desc.indexOf(c.id === "gh" ? '<div class="gh-auth"' : '<details class="llm-dl"')) : "";
      const more = (live ? desc.slice(0, desc.length - live.length) : desc) + '<div class="it-meta">' + meta + "</div>";
      const warn = (c.error ? '<div class="tiny err">' + esc(c.error) + "</div>" : "") + (miss.length && c.state !== "ok" ? '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>" : "");
      return (`<div class="item ccard${c.unsupported && c.state !== "ok" ? " dim" : ""}" data-tags="${esc(tags.join(" "))}">
        <div class="cc-top"><span class="icobox" style="--c:${cc}">${ei(ci)}</span><div class="grow"><b>${name}</b><div class="mono muted">${esc(ver || "")}${ver ? " · " : ""}${MB(c.state === "ok" ? c.installed : c.bytes)}</div></div>${c.verified ? `<span class="vmark" title="${esc(t("真机验证过"))}">${ei("shield")}</span>` : ""}</div>
        ${warn}${bar}${live}<div class="it-more">${more}</div>
        <div class="cc-foot">${sdot(dotSt, dotL)}<span class="cc-btns">${cbtn}</span></div></div>`)
        .replace(" data-c=\"install\"", " data-c=\"install\"" + (c.verified ? "" : " data-unverified=\"1\"") + (miss.length ? " disabled" : ""))
        .replace(" data-c=\"remove\"", " data-c=\"remove\"" + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
    }).join("");
    box.innerHTML = (html || '<div class="tiny">' + (r.indexError ? t("组件清单取不到：{msg}", { msg: esc(r.indexError) }) : t("暂时没有可装的组件。")) + "</div>") +
      (html && r.indexError ? '<div class="tiny err">' + t("部分组件清单取不到：{msg}", { msg: esc(r.indexError) }) + "</div>" : "") +
      (r.indexError ? '<div class="it-acts"><button class="btn ghost sm" data-c="reindex">' + t("重试") + "</button></div>" : "");
    $("comp-count").textContent = (r.items || []).length || "";
    ext.nComp = (r.items || []).length; extSub();
    ext.compBytes = (r.items || []).filter((c) => c.installedVersion || c.state === "ok").reduce((s, c) => s + (c.installed || 0), 0); paintStorage();
    renderIdx("comp", [["inst", t("已装")], ["upd", t("要更新")], ...Object.entries(CAT()).map(([k, v]) => ["cat:" + k, v])]);
    if ($("gh-auth")) loadGhAuth(refresh);
    if ($("llm-dl")) {
      $("llm-dl").addEventListener("toggle", () => { llmDl.open = $("llm-dl").open; if (llmDl.open) loadLlmDl(); });
      if (llmDl.open) loadLlmDl();
    }
    // 有在跑的就一秒刷一次；抽屉关了 / 换了页签就停
    if ((r.items || []).some((c) => c.progress) && pageOn("ext"))
      compTimer = setTimeout(loadComponents, 1000);
    // 先显示的是上回存下的列表、网关还在后台拉新索引：两秒后再要一次，拉完自然停
    else if (r.refreshing && pageOn("ext"))
      compTimer = setTimeout(loadComponents, 2000);
  }

  // ── 自定义组件：用户自己导入 Linux arm64 程序。选文件 → 网关分析（ELF 类型、缺的库）→ 勾要用的命令 → 安装（补库、写入口和技能）──
  const cust = { rep: null, busy: false };
  const cpost = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const KIND = () => ({ glibc: t("Linux 程序（glibc）"), bionic: t("安卓原生程序"), static: t("静态程序"), script: t("脚本"),
    musl: "musl", unsupported: t("跑不了") });
  async function loadCustom() {
    const r = await api("/api/custom").catch(() => ({ supported: false }));
    $("custom-field").classList.toggle("hidden", !r.supported);
    if (!r.supported) return;
    $("custom-count").textContent = (r.items || []).length || "";
    $("custom-list").innerHTML = (r.items || []).map((c) => {
      const cmds = c.entries.map((e) => "<code>" + esc(e.cmd) + "</code>" + (e.ok ? "" : ' <span class="warn">' + t("入口丢了") + "</span>") +
        ' <button class="btn ghost sm" data-cu="try" data-id="' + esc(c.id) + '" data-cmd="' + esc(e.cmd) + '">' + t("试运行") + "</button>").join(" ");
      const meta = "<span>" + esc(c.source) + "</span><span>" + MB(c.bytes) + "</span>" +
        (c.deps ? "<span>" + t("补了 {n} 个库", { n: c.deps }) + "</span>" : "") +
        [...new Set(c.entries.map((e) => KIND()[e.kind] || e.kind))].map((k) => "<span>" + esc(k) + "</span>").join("");
      let desc = (c.desc ? '<div class="tiny ext-desc">' + esc(c.desc) + "</div>" : "") + '<div class="tiny cu-cmds">' + t("命令：") + " " + cmds + "</div>";
      if (c.unresolved.length) desc += '<div class="tiny warn">' + t("还缺这些库，可能跑不起来：{libs}", { libs: esc(c.unresolved.join(", ")) }) + "</div>";
      desc += '<pre class="cu-out hidden" id="cu-out-' + esc(c.id) + '"></pre>';
      return extItem(esc(c.name), meta, '<button data-cu="remove" data-id="' + esc(c.id) + '">' + t("卸载") + "</button>", desc);
    }).join("");
  }
  async function customAnalyze(file, pathStr) {
    if (cust.busy) return;
    cust.busy = true;
    const wiz = $("custom-wiz");
    wiz.innerHTML = '<div class="tiny">' + (file ? t("正在上传并分析 {name}…", { name: esc(file.name) }) : t("正在分析…")) + "</div>";
    try {
      const r = file
        ? await fetch("/api/custom/upload?name=" + encodeURIComponent(file.name || "program"), { method: "POST", body: file }).then((x) => x.json())
        : await cpost("/api/custom/analyze", { path: pathStr });
      if (!r.ok) { wiz.innerHTML = '<div class="tiny err">' + esc(r.message || "") + "</div>"; return; }
      cust.rep = r; renderCustomWiz();
    } catch (e) { wiz.innerHTML = '<div class="tiny err">' + esc(e.message) + "</div>"; }
    finally { cust.busy = false; }
  }
  function renderCustomWiz() {
    const r = cust.rep, wiz = $("custom-wiz");
    if (!r) { wiz.innerHTML = ""; return; }
    const ok = new Set(["glibc", "bionic", "static", "script"]);
    const rows = r.programs.map((p, i) => {
      const can = ok.has(p.kind);
      const clash = p.clash === "toolkit" ? t("工具包里已有同名命令，换个名字") : p.clash === "custom" ? t("别的自定义组件占了这个名字") : p.clash === "bad" ? t("改个名字（只能用字母、数字和 ._+-）") : "";
      return '<div class="cu-prog' + (can ? "" : " dim") + '" data-i="' + i + '">' +
        '<label class="cu-row"><input type="checkbox" class="cu-on"' + (can ? "" : " disabled") + (can && p.suggest && !p.clash ? " checked" : "") + "> <code>" + esc(p.rel) + "</code>" +
        ' <span class="tiny">' + esc(KIND()[p.kind] || p.kind) + "</span></label>" +
        (can ? '<div class="cu-row tiny">' + t("命令名") + ' <input class="cu-cmd" value="' + esc(p.cmd) + '" spellcheck="false" autocapitalize="off">' +
          (p.kind === "glibc" && r.gpu ? ' <label><input type="checkbox" class="cu-gpu"> ' + t("用 GPU") + "</label>" : "") +
          (p.kind === "glibc" ? ' <label title="' + esc(t("直接改程序的解释器，不经加载器启动。程序按自身位置找数据文件时用")) + '"><input type="checkbox" class="cu-pe"> patchelf</label>' : "") + "</div>" : "") +
        (clash && can ? '<div class="tiny warn">' + clash + "</div>" : "") +
        (p.why ? '<div class="tiny warn">' + esc(p.why) + "</div>" : "") +
        (p.missing.length ? '<div class="tiny dim">' + t("缺：{libs}", { libs: esc(p.missing.join(", ")) }) + "</div>" : "") + "</div>";
    }).join("");
    const fix = r.fixable.length ? '<div class="tiny">' + t("会从 Termux glibc 仓库补这些库（约 {size}）：{libs}", { size: MB(r.fixable.reduce((a, f) => a + f.size, 0)), libs: esc([...new Set(r.fixable.map((f) => f.soname))].join(", ")) }) + "</div>" : "";
    const unres = r.unresolved.length ? '<div class="tiny warn">' + t("这些库找不到来源，用到它们的程序可能跑不起来：{libs}", { libs: esc(r.unresolved.join(", ")) }) + "</div>" : "";
    wiz.innerHTML = '<div class="cu-wiz">' +
      '<div class="tiny">' + t("{src}：{n} 个文件，{size}", { src: esc(r.source), n: r.files, size: MB(r.bytes) }) + "</div>" +
      '<div class="cu-row"><span class="tiny">' + t("名称") + '</span> <input id="cu-name" value="' + esc(r.name) + '"></div>' +
      '<div class="cu-row"><span class="tiny">ID</span> <input id="cu-id" value="' + esc(r.id) + '" spellcheck="false" autocapitalize="off"></div>' +
      '<div class="cu-row"><span class="tiny">' + t("说明") + '</span> <input id="cu-desc" placeholder="' + esc(t("可选：它是干什么的，Claude 会看到")) + '"></div>' +
      '<div class="tiny">' + t("要用哪些命令") + "</div>" + rows + fix + unres +
      r.warnings.map((w) => '<div class="tiny warn">' + esc(w) + "</div>").join("") +
      '<div class="tiny dim">' + t("程序来源由你负责：它能读写本应用里的所有文件。") + "</div>" +
      '<div class="it-acts"><button class="btn sm" data-cu="install">' + t("安装") + '</button><button class="btn ghost sm" data-cu="discard">' + t("取消") + "</button></div></div>";
  }
  $("custom-pick").addEventListener("click", () => $("custom-file").click());
  $("custom-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) customAnalyze(f); });
  $("custom-path-go").addEventListener("click", () => { const p = $("custom-path").value.trim(); if (p) customAnalyze(null, p); });
  $("custom-field").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-cu]"); if (!b || b.disabled) return;
    const a = b.dataset.cu;
    if (a === "discard") { if (cust.rep) cpost("/api/custom/discard", { stage: cust.rep.stage }).catch(() => {}); cust.rep = null; return renderCustomWiz(); }
    if (a === "install") {
      const r = cust.rep, entries = [];
      for (const d of document.querySelectorAll("#custom-wiz .cu-prog")) {
        if (!d.querySelector(".cu-on")?.checked) continue;
        const p = r.programs[+d.dataset.i];
        entries.push({ rel: p.rel, cmd: d.querySelector(".cu-cmd").value.trim(), gpu: !!d.querySelector(".cu-gpu")?.checked, patchelf: !!d.querySelector(".cu-pe")?.checked });
      }
      if (!entries.length) return toast(t("至少选一个要用的命令"), true);
      b.disabled = true; b.textContent = r.fixable.length ? t("正在补库并安装…") : t("正在安装…");
      const x = await cpost("/api/custom/install", { stage: r.stage, id: $("cu-id").value.trim(), name: $("cu-name").value.trim(), desc: $("cu-desc").value.trim(), entries })
        .catch((err) => ({ ok: false, message: err.message }));
      if (!x.ok) { b.disabled = false; b.textContent = t("安装"); return toast(t("失败：{msg}", { msg: x.message || "" }), true); }
      cust.rep = null; renderCustomWiz();
      toast(x.unresolved && x.unresolved.length ? t("已安装，但还缺 {n} 个库", { n: x.unresolved.length }) : t("已安装，Claude 和终端里都能用了"), !!(x.unresolved && x.unresolved.length));
      return loadCustom();
    }
    if (a === "remove") {
      const nm = (b.closest(".item")?.querySelector(".it-title")?.textContent || b.dataset.id).trim();
      if (!confirm(t("卸载自定义组件 {name}？会删掉导入的程序、补进来的库和它的命令。", { name: nm }))) return;
      b.disabled = true;
      const x = await cpost("/api/custom/remove", { id: b.dataset.id }).catch((err) => ({ ok: false, message: err.message }));
      toast(x.ok ? t("已卸载") : t("失败：{msg}", { msg: x.message || "" }), !x.ok);
      return loadCustom();
    }
    if (a === "try") {
      const out = $("cu-out-" + b.dataset.id); b.disabled = true;
      out.classList.remove("hidden"); out.textContent = "$ " + b.dataset.cmd + " --version\n…";
      const x = await cpost("/api/custom/try", { id: b.dataset.id, cmd: b.dataset.cmd }).catch((err) => ({ ok: false, output: err.message }));
      out.textContent = "$ " + b.dataset.cmd + "\n" + (x.output || t("（没有输出，退出码 {c}）", { c: x.code }));
      out.classList.toggle("err", !x.ok);
      b.disabled = false;
    }
  });

  // ── llama-cpp 组件下的「下载模型」子卡：内置目录按家族折叠（网关里固定 sha256），一键下载 / 取消 / 删除；也能贴 .gguf 直链 ──
  const llmDl = { open: false, html: "", timer: 0, fam: new Set(), items: new Map(), big: 6, url: "" };
  async function loadLlmDl() {
    clearTimeout(llmDl.timer);
    const r = await api("/api/local/catalog").catch((e) => ({ items: [], err: e.message }));
    const GB = (n) => (n / 1073741824).toFixed(1) + " GB";
    const TAG = { think: t("会先思考"), code: t("偏写代码") };
    llmDl.big = r.big || 6;
    llmDl.items = new Map((r.items || []).map((m) => [m.id, m]));
    const row = (m) => {
      const j = m.job;
      let st = "", act = "";
      if (j && (j.phase === "downloading" || j.phase === "verifying")) {
        const pct = j.total ? Math.min(100, (j.done / j.total) * 100).toFixed(1) : 0;
        st = (j.total ? '<div class="comp-bar"><i style="width:' + pct + '%"></i></div>' : "") +
          '<div class="tiny">' + (j.phase === "verifying" ? t("校验中") : t("下载中")) + " " + GB(j.done) + (j.total ? " / " + GB(j.total) : "") + "</div>";
        act = '<button class="btn sm ghost" data-lm="cancel" data-id="' + esc(m.id) + '">' + t("取消") + "</button>";
      } else if (m.have) {
        st = '<span class="tiny">' + t("已下载") + (m.inUse ? " · " + t("正在使用") : "") + "</span>";
        act = '<button class="btn sm ghost" data-lm="remove" data-id="' + esc(m.id) + '">' + t("删除") + "</button>";
      } else {
        if (j && j.phase === "error") st = '<div class="tiny err">' + t("下载失败：{msg}", { msg: esc(j.err) }) + "</div>";
        act = '<button class="btn sm' + (m.params > llmDl.big ? " ghost" : "") + '" data-lm="download" data-id="' + esc(m.id) + '">' + (j ? t("重试") : t("下载")) + "</button>" +
          (m.custom ? '<button class="btn sm ghost" data-lm="cancel" data-id="' + esc(m.id) + '">' + t("移除") + "</button>" : "");
      }
      const info = m.custom ? '<span class="tiny dim">' + esc(m.repo) + "</span>"
        : '<span class="tiny">' + m.params + "B · " + GB(m.bytes) + "</span>" + (m.tag ? ' <span class="tiny dim">' + TAG[m.tag] + "</span>" : "") +
          (m.params > llmDl.big ? ' <span class="tiny warn">' + t("偏大") + "</span>" : "");
      return '<div class="llm-item"><div class="llm-row"><code>' + esc(m.id) + "</code> " + info + '<span class="llm-act">' + act + "</span></div>" + st + "</div>";
    };
    const fams = [];
    for (const m of r.items || []) if (!m.custom && !fams.includes(m.fam)) fams.push(m.fam);
    const custom = (r.items || []).filter((m) => m.custom);
    llmDl.html = '<div class="tiny dim">' + t("模型放在 /sdcard/cccodroid/models，下好后到 设置 → 模型服务 → 端侧小模型 使用。本机内存 {ram} GB。都是 Q4_K_M 量化；手机上 1–4B 比较实用，超过 6B 会很慢。", { ram: r.ram || "?" }) + "</div>" +
      (r.err ? '<div class="tiny err">' + esc(r.err) + "</div>" : "") +
      fams.map((f) => {
        const list = r.items.filter((m) => !m.custom && m.fam === f);
        const n = list.filter((m) => m.have).length, busy = list.some((m) => m.job && m.job.phase !== "error");
        return '<details class="llm-fam" data-fam="' + esc(f) + '"' + (llmDl.fam.has(f) || busy ? " open" : "") + "><summary>" + esc(f) +
          ' <span class="tiny dim">' + list.length + (n ? " · " + t("已下载 {n}", { n }) : "") + "</span></summary>" + list.map(row).join("") + "</details>";
      }).join("") +
      custom.map(row).join("") +
      '<div class="llm-url"><div class="tiny dim">' + t("目录里没有的：贴一个 .gguf 文件的下载链接（HuggingFace / 魔搭等）。不校验哈希，只核对文件头。") + "</div>" +
      '<div class="llm-url-row"><input type="url" id="llm-url" placeholder="https://huggingface.co/…/resolve/main/xxx.gguf" value="' + esc(llmDl.url) + '">' +
      '<button class="btn sm" data-lm="url">' + t("下载") + "</button></div></div>";
    // 输入框里正打着字就别整块重绘（会丢光标）：只更新上面的列表
    const body = $("llm-dl-body");
    if (body) {
      const typing = document.activeElement && document.activeElement.id === "llm-url";
      if (typing) { const box = document.createElement("div"); box.innerHTML = llmDl.html; box.querySelector(".llm-url").replaceWith(body.querySelector(".llm-url")); body.replaceChildren(...box.childNodes); }
      else body.innerHTML = llmDl.html;
      body.querySelectorAll(".llm-fam").forEach((d) => d.addEventListener("toggle", () => { d.open ? llmDl.fam.add(d.dataset.fam) : llmDl.fam.delete(d.dataset.fam); }));
      const inp = $("llm-url"); if (inp) inp.addEventListener("input", () => { llmDl.url = inp.value; });
    }
    const busy = (r.items || []).some((m) => m.job && m.job.phase !== "error");
    if (busy && llmDl.open && $("llm-dl") && pageOn("ext"))
      llmDl.timer = setTimeout(loadLlmDl, 1000);
  }
  $("tab-ext").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-lm]");
    if (!b || b.disabled) return;
    const op = b.dataset.lm, id = b.dataset.id, m = llmDl.items.get(id);
    if (op === "remove" && !confirm(t("删除模型 {name}？", { name: id }))) return;
    if (op === "download" && m && m.params > llmDl.big && !confirm(t("{name} 约 {p}B 参数、{size}。手机上会很慢，内存也可能不够。仍然下载？", { name: id, p: m.params, size: (m.bytes / 1073741824).toFixed(1) + " GB" }))) return;
    const body = { op, id };
    if (op === "url") {
      body.url = ($("llm-url") && $("llm-url").value.trim()) || "";
      if (!body.url) return toast(t("先贴链接"), true);
    }
    b.disabled = true;
    const r = await post("/api/local/model", body).catch((er) => ({ ok: false, message: er.message }));
    if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
    else if (op === "url") llmDl.url = "";
    if (op === "url" && $("llm-url")) $("llm-url").blur();
    loadLlmDl();
  });

  // ── gh 登录卡：设备码流程。令牌只在 gh 自己那儿，网关只回账号名与状态 ──
  const ghAuth = { html: "", at: 0, timer: 0, polling: false };
  // 没有组件系统的地方（开发端）：gh 在 PATH 里就单独给一张 GitHub 卡片，登录卡同一套
  async function loadGhField() {
    const st = await api("/api/gh/auth").catch(() => null);
    $("gh-field").classList.toggle("hidden", !(st && st.installed));
    if (!st || !st.installed) return;
    $("gh-field-box").innerHTML = '<div class="item"><div class="it-title">GitHub CLI（gh）</div><div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div></div>";
    loadGhAuth(true);
  }
  async function loadGhAuth(force) {
    clearTimeout(ghAuth.timer);
    // 组件列表下载时一秒刷一次，gh auth status 要联网验令牌，别跟着每秒跑
    if (!force && !ghAuth.polling && Date.now() - ghAuth.at < 30000) return;
    ghAuth.at = Date.now();
    const r = await api("/api/gh/auth").catch((e) => ({ installed: true, accounts: [], error: e.message }));
    const j = r.job, wasPolling = ghAuth.polling;
    ghAuth.polling = !!j && ["starting", "waiting"].includes(j.state);
    if (wasPolling && j && j.state === "done") toast(j.git ? t("GitHub 已登录，git 推送已配好") : t("GitHub 已登录，但 git 凭据没配上，可在终端运行 gh auth setup-git"), !j.git);
    let h = "";
    if (j && j.state === "starting") h = '<div class="tiny">' + t("正在向 GitHub 申请一次性码…") + "</div>" + '<div class="it-acts"><button data-g="cancel">' + t("取消") + "</button></div>";
    else if (j && j.state === "waiting") {
      h = '<div class="tiny">' + t("在浏览器里输入这个一次性码，授权后这里会自动完成：") + "</div>" +
        '<div class="gh-code" data-g="copy">' + esc(j.code) + "</div>" +
        '<div class="it-acts"><button data-g="open" data-code="' + esc(j.code) + '" data-url="' + esc(j.url || "https://github.com/login/device") + '">' + t("复制并打开浏览器") + "</button>" +
        '<button data-g="cancel">' + t("取消") + "</button></div>";
    } else {
      const acc = r.accounts || [];
      h = acc.length ? acc.map((a) => '<div class="gh-acc"><span>@' + esc(a.login) + "</span>" +
          (a.active && acc.length > 1 ? '<span class="badge">' + t("当前") + "</span>" : "") +
          (a.ok ? "" : '<span class="warn">' + t("登录已失效") + "</span>") +
          (a.active ? "" : '<button data-g="switch" data-user="' + esc(a.login) + '">' + t("切换到这个") + "</button>") +
          '<button data-g="logout" data-user="' + esc(a.login) + '">' + t("退出") + "</button></div>").join("")
        : '<div class="tiny">' + t("还没登录 GitHub。登录后 gh 和 git 推送都能用。") + "</div>";
      if (j && j.state === "error") h += '<div class="tiny err">' + (j.error === "timeout" ? t("一次性码过期了，重新登录吧") : t("登录失败：{msg}", { msg: esc(j.error) })) + "</div>";
      if (r.error) h += '<div class="tiny err">' + esc(r.error) + "</div>";
      h += '<div class="it-acts"><button data-g="login">' + (acc.length ? t("再登录一个账号") : t("登录 GitHub")) + "</button></div>";
    }
    ghAuth.html = h;
    const box = $("gh-auth");
    if (box) box.innerHTML = h;
    if (ghAuth.polling && box && pageOn("ext"))
      ghAuth.timer = setTimeout(loadGhAuth, 2000);
  }

  async function loadExtPlugins() {
    const box = $("ext-plugins");
    let r;
    try { r = await api("/api/ext/plugins"); } catch (e) { box.innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    if (r.ok === false) { box.innerHTML = `<div class="tiny">${esc(r.message)}</div>`; return; }
    $("ext-p-count").textContent = r.installed.length;
    box.innerHTML = r.installed.length ? r.installed.map((p) => extItem(
      esc(p.id.split("@")[0]) + (p.enabled ? "" : ` <span class="badge">${t("已停用")}</span>`),
      `<span>${esc(p.id.split("@")[1] || "")}</span><span>${esc(String(p.version || "").slice(0, 16))}</span><span>${esc(p.scope || "")}</span>`,
      `<button data-x="${p.enabled ? "disable" : "enable"}" data-id="${esc(p.id)}">${p.enabled ? t("停用") : t("启用")}</button>
       <button data-x="uninstall" data-id="${esc(p.id)}">${t("卸载")}</button>`, "", [p.enabled ? "on" : "off", "m:" + tg(p.id.split("@")[1] || "")])).join("")
      : `<div class="tiny">${t("还没装插件。在下面搜索可安装的。")}</div>`;
    renderIdx("plugin", [["on", t("已启用")], ["off", t("已停用")]]);
  }

  async function searchPlugins(more) {
    const box = $("ext-catalog");
    if (!more) { ext.offset = 0; ext.q = $("ext-p-q").value.trim(); box.innerHTML = `<div class="tiny">${t("正在拉取插件目录…")}</div>`; }
    let r;
    try { r = await api(`/api/ext/plugins?available=1&q=${encodeURIComponent(ext.q)}&offset=${ext.offset}`); }
    catch (e) { box.innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    if (r.ok === false) { box.innerHTML = `<div class="tiny">${esc(r.message)}</div>`; return; }
    const html = (r.available || []).map((p) => extItem(
      esc(p.name),
      `<span>${esc(p.marketplace)}</span>${p.version ? `<span>${esc(p.version)}</span>` : ""}`,
      `<button data-x="install" data-id="${esc(p.id)}">${t("安装")}</button>`,
      `<div class="tiny ext-desc">${esc(p.description)}</div>`, ["m:" + tg(p.marketplace)])).join("");
    const old = box.querySelector(".ext-more-btn"); if (old) old.remove();
    if (!more) box.innerHTML = `<div class="tiny">${t("找到 {n} 个", { n: r.total || 0 })}</div>` + html;
    else box.insertAdjacentHTML("beforeend", html);
    ext.offset += (r.available || []).length;
    if (ext.offset < (r.total || 0)) box.insertAdjacentHTML("beforeend", `<button class="btn ghost sm ext-more-btn">${t("再显示 40 个")}</button>`);
    renderIdx("plugin");
  }

  async function installPlugin(id, btn) {
    btn.disabled = true; btn.textContent = t("安装中…");
    let r = await post("/api/ext/plugins/install", { id }).catch((e) => ({ ok: false, message: e.message }));
    // 要执行命令才能装的插件：claude 把命令亮出来，人点头了才装
    if (r.needConfirm) {
      if (confirm(t("这个插件安装时要在本机执行下面这条命令，确认是你信任的来源再继续：\n\n{cmd}", { cmd: r.command }))) {
        r = await post("/api/ext/plugins/install", { id, accept: r.sha256 }).catch((e) => ({ ok: false, message: e.message }));
      } else r = { ok: false, message: t("已取消") };
    }
    if (r.ok) { toast(t("已安装 {name}，下一条消息生效", { name: id.split("@")[0] })); btn.closest(".item").remove(); loadExtPlugins(); }
    else { toast(t("安装失败：{msg}", { msg: r.message || "" }), true); btn.disabled = false; btn.textContent = t("安装"); }
  }

  async function loadExtMarkets() {
    const r = await api("/api/ext/marketplaces").catch(() => ({ items: [] }));
    $("ext-markets").innerHTML = (r.items || []).map((m) => extItem(esc(m.name), `<span>${esc(m.source)}</span>`,
      `<button data-x="market-rm" data-id="${esc(m.name)}">${t("移除")}</button>`)).join("")
      || `<div class="tiny">${t("只有内置的官方目录。可以添加别的插件市场（GitHub 仓库或网址）。")}</div>`;
  }

  async function loadExtSkills() {
    const r = await api("/api/ext/skills").catch(() => ({ items: [] }));
    $("ext-s-count").textContent = (r.items || []).length;
    $("ext-skills").innerHTML = (r.items || []).map((s) => extItem(esc(s.name), "",
      `<button data-x="skill-rm" data-id="${esc(s.dir)}">${t("删除")}</button>`,
      `<div class="tiny ext-desc">${esc(!isZh() && s.descEn ? s.descEn : s.description)}</div>`, [s.component ? "comp" : s.official ? "official" : "user"])).join("")
      || `<div class="tiny">${t("~/.claude/skills 里还没有技能。插件也可能自带技能。")}</div>`;
    renderIdx("skill", [["official", t("官方")], ["comp", t("组件自带")], ["user", t("自己装的")]]);
    if ($("ext-s-catbox").open) loadSkillCat();
  }

  // ── Hooks（自动规则）：到某个时刻自动跑一条命令。常用规则点一下就加，也能自己写；每条都能先试运行看效果 ──
  const HK = { data: null, scope: localStorage.getItem("cc.hookScope") || "user", edit: null, recipe: null };
  const HK_EV = {
    PreToolUse: [tk("用工具之前"), tk("Claude 每次调用工具（改文件、跑命令、联网……）之前。退出码 2 会拦下这次调用，stderr 里写的原因会转告 Claude。")],
    PostToolUse: [tk("用完工具之后"), tk("工具执行成功之后。适合格式化、记录、检查；动作已经做了，退出码 2 只会把 stderr 反馈给 Claude。")],
    UserPromptSubmit: [tk("你发出消息时"), tk("你每发一条消息。命令打印的内容会作为补充说明一起交给 Claude；退出码 2 会拦下这条消息。")],
    Stop: [tk("Claude 答完一轮时"), tk("Claude 这一轮回答结束。适合自动存档、提醒；退出码 2 会让它接着干（小心死循环）。")],
    SessionStart: [tk("会话开始时"), tk("新开、继续、清空或压缩后的会话开始时。命令打印的内容会作为背景交给 Claude。")],
    SessionEnd: [tk("会话结束时"), tk("会话结束时，适合收尾清理。")],
    Notification: [tk("Claude 发提醒时"), tk("Claude 要你确认权限、或者闲着等你回复时。")],
    PermissionRequest: [tk("要你确认权限时"), tk("弹出权限确认之前。进阶用法：输出 JSON 可以替你自动允许或拒绝。")],
    PostToolUseFailure: [tk("工具出错之后"), tk("工具执行失败之后。")],
    SubagentStart: [tk("子代理开始时"), ""],
    SubagentStop: [tk("子代理结束时"), tk("子代理干完活时；退出码 2 会让它接着干。")],
    PreCompact: [tk("压缩上下文之前"), ""],
    PostCompact: [tk("压缩上下文之后"), ""],
  };
  const hkEvName = (ev) => (HK_EV[ev] ? t(HK_EV[ev][0]) : ev);
  const HK_TOOL_EV = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
  const HK_MATCH_CHIPS = {
    tool: ["Bash", "Edit|Write|MultiEdit", "Read", "WebFetch|WebSearch", "mcp__.*"],
    SessionStart: ["startup", "resume", "clear", "compact"],
    PreCompact: ["manual", "auto"], PostCompact: ["manual", "auto"],
    Notification: ["permission_prompt", "idle_prompt"],
  };
  const hkChips = (ev) => (HK_TOOL_EV.includes(ev) ? HK_MATCH_CHIPS.tool : HK_MATCH_CHIPS[ev]);
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  /** 把命令拆成参数（认单引号、双引号、反斜杠），用来从常用规则的命令里取回参数 */
  function shArgs(cmd) {
    const out = []; let cur = null, q = "";
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (q === "'") { if (c === "'") q = ""; else cur += c; continue; }
      if (q === '"') { if (c === '"') q = ""; else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i]; else cur += c; continue; }
      if (/\s/.test(c)) { if (cur != null) out.push(cur); cur = null; continue; }
      if (cur == null) cur = "";
      if (c === "'" || c === '"') q = c; else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i]; else cur += c;
    }
    if (cur != null) out.push(cur);
    return out;
  }
  const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const hkScript = (name) => `node "$HOME/.claude/hooks/${name}"`;
  const HK_RECIPES = [
    { id: "guard-files", title: tk("保护重要文件"), desc: tk("Claude 想改 .env、密钥、签名文件时直接拦下，并告诉它原因。"),
      event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "cc-guard-files.mjs",
      label: tk("受保护的文件（一行一个；* 是通配符，带 / 就按路径比）"), param: ".env\n.env.*\n*.pem\n*.key\n*.keystore\n*.jks\nid_rsa*\nid_ed25519*",
      cmd: (p) => hkScript("cc-guard-files.mjs") + " " + lines(p).map(shq).join(" "), back: (a) => a.slice(2).join("\n") },
    { id: "guard-bash", title: tk("拦下危险命令"), desc: tk("命令里出现强推、硬重置、删根目录这类内容就不让跑，并告诉 Claude 换个做法。"),
      event: "PreToolUse", matcher: "Bash", script: "cc-guard-bash.mjs",
      label: tk("禁止的内容（一行一个；写成 /…/ 就是正则）"),
      param: "git push --force\ngit push -f\n/git\\s+reset\\s+--hard/\n/\\brm\\s+-\\w*[rR]\\w*\\s+(\\/|~\\/?|\\$HOME\\/?)(\\s|$)/\nmkfs\n/\\bdd\\s+if=/",
      cmd: (p) => hkScript("cc-guard-bash.mjs") + " " + lines(p).map(shq).join(" "), back: (a) => a.slice(2).join("\n") },
    { id: "autosave", title: tk("每轮自动存档（git）"), desc: tk("Claude 每答完一轮，项目里有改动就自动提交一次，随时能退回任意一步。只提交不推送；不是 git 仓库的项目什么也不做。"),
      event: "Stop", matcher: "", script: "cc-autosave.mjs", single: true, label: tk("提交说明的开头"), param: tk("自动存档"),
      cmd: (p) => hkScript("cc-autosave.mjs") + " " + shq(String(p).trim() || t("自动存档")), back: (a) => a[2] || "" },
    { id: "prompt-note", title: tk("每条消息附上固定要求"), desc: tk("你每发一条消息，自动把这段话一起交给 Claude，比如「回答用中文」「改之前先说思路」。"),
      event: "UserPromptSubmit", matcher: "", label: tk("要附上的话"), param: tk("回答用中文；动手改之前先简单说一下打算怎么做。"),
      cmd: (p) => "printf '%s\\n' " + shq(String(p).trim()), test: (c) => /^printf '%s\\n' /.test(c), back: (a) => a[2] || "" },
    { id: "session-file", title: tk("开会话时读入进度文件"), desc: tk("每次开新会话（或压缩上下文后），把项目里的一个文件读给 Claude，比如进度、大纲、人物表。文件不存在就跳过。"),
      event: "SessionStart", matcher: "", single: true, label: tk("文件（相对项目目录）"), param: tk("进度.md"),
      cmd: (p) => "cat " + shq(String(p).trim()) + " 2>/dev/null || true", test: (c) => /^cat '.*' 2>\/dev\/null \|\| true$/.test(c), back: (a) => a[1] || "" },
    { id: "bash-log", title: tk("记下 Claude 跑过的命令"), desc: tk("每条命令连同时间、目录追加到 ~/.claude/bash-history.log，方便事后翻看。"),
      event: "PostToolUse", matcher: "Bash", script: "cc-bash-log.mjs", cmd: () => hkScript("cc-bash-log.mjs") },
    { id: "format", title: tk("改完代码自动格式化"), desc: tk("Claude 改完代码文件，用本机已装的工具（ruff / black、prettier、gofmt、clang-format……）整理格式；没装就不动。Markdown 和纯文本不碰。"),
      event: "PostToolUse", matcher: "Edit|Write|MultiEdit", script: "cc-format.mjs", cmd: () => hkScript("cc-format.mjs") },
  ];
  const hkRecipeOf = (ev, h) => h && h.type === "command" && HK_RECIPES.find((r) => r.event === ev &&
    (r.script ? String(h.command).includes(r.script) : r.test(String(h.command))));
  const hkScopeData = () => HK.data && HK.data.scopes.find((s) => s.scope === HK.scope);
  const hkFlat = (sc) => {
    const out = [];
    for (const [ev, groups] of Object.entries((sc && sc.hooks) || {}))
      (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => out.push({ ev, gi, hi, matcher: g.matcher || "", h })));
    return out;
  };

  async function loadExtHooks() {
    let d;
    try { d = await api("/api/ext/hooks"); } catch (e) { $("ext-hooks").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    HK.data = d;
    if (!d.scopes.some((s) => s.scope === HK.scope)) HK.scope = "user";
    renderHooks();
  }

  function renderHooks() {
    const d = HK.data; if (!d) return;
    const total = d.scopes.reduce((a, s) => a + hkFlat(s).length, 0);
    $("ext-h-count").textContent = total;
    const proj = String(d.dir || "").split("/").pop() || d.dir;
    const SC = { user: t("所有项目"), project: t("本项目（{name}）", { name: proj }), local: t("本项目·只在本机") };
    $("hook-scope").innerHTML = d.scopes.map((s) =>
      `<button class="idx-chip${s.scope === HK.scope ? " on" : ""}" data-hscope="${s.scope}">${esc(SC[s.scope])}<span>${hkFlat(s).length}</span></button>`).join("");
    const sc = hkScopeData();
    const user = d.scopes.find((s) => s.scope === "user");
    const SCD = {
      user: t("写在 ~/.claude/settings.json，所有项目都生效。"),
      project: t("写在项目的 .claude/settings.json，只在这个项目生效；项目进了 git 的话会跟着仓库走。"),
      local: t("写在项目的 .claude/settings.local.json，只在这个项目、这台设备上生效。"),
    };
    $("hook-bar").innerHTML = `<div class="tiny">${esc(SCD[HK.scope])}
        ${sc && sc.file ? `<a href="#" data-hk="open-file">${t("打开配置文件")}</a>` : ""}</div>
      <label class="tiny hk-pause"><input type="checkbox" data-hk="pause"${user && user.disableAll ? " checked" : ""}> ${t("暂停全部 hooks（规则留着，先不跑）")}</label>`;
    if (!sc || sc.error && !sc.badJson) { $("ext-hooks").innerHTML = `<div class="tiny warn">${esc((sc && sc.error) || "")}</div>`; return; }
    if (sc.badJson) {
      $("ext-hooks").innerHTML = `<div class="tiny warn">${esc(t("这个配置文件不是合法的 JSON（{msg}），先打开修好，这里才能改。", { msg: sc.error }))}</div>`;
      return;
    }
    const items = hkFlat(sc);
    $("ext-hooks").innerHTML = items.map((it, i) => {
      const r = hkRecipeOf(it.ev, it.h);
      const title = r ? t(r.title) : hkEvName(it.ev);
      const meta = [r ? hkEvName(it.ev) : it.ev, it.matcher ? t("匹配：{m}", { m: it.matcher }) : "", it.h.timeout ? t("超时 {n} 秒", { n: it.h.timeout }) : ""].filter(Boolean);
      const body = it.h.type === "command" ? it.h.command : JSON.stringify(it.h);
      return `<div class="item hk-item${user && user.disableAll ? " off" : ""}" data-i="${i}">
        <div class="it-title">${esc(title)}</div>
        <div class="it-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
        <div class="hk-cmd mono">${esc(body)}</div>
        <div class="it-acts">${it.h.type === "command" ? `<button data-hk="test">${t("试运行")}</button><button data-hk="edit">${t("修改")}</button>` : ""}
          <button data-hk="del">${t("删除")}</button></div>
        <div class="hk-out"></div></div>`;
    }).join("") || `<div class="tiny">${t("这里还没有规则。下面「常用规则」点一下就能加。")}</div>`;
    $("hook-recipes").innerHTML = HK_RECIPES.map((r) => extItem(esc(t(r.title)), `<span>${esc(hkEvName(r.event))}</span>`,
      `<button data-hk="recipe" data-id="${r.id}">${t("添加…")}</button>`, `<div class="tiny ext-desc">${esc(t(r.desc))}</div>`)).join("");
    if (!items.length && !HK.edit && !HK.recipe) $("hook-recipes-box").open = true;
  }

  /** 表单：新建 / 修改 / 从常用规则添加。常用规则只填参数，命令自动拼好（也能直接改命令） */
  function hkForm(init) {
    const box = $("hook-form-box"), f = $("hook-form");
    box.open = true;
    const r = HK.recipe;
    const evs = HK.data.events;
    const main = Object.keys(HK_EV).filter((e) => evs.includes(e));
    const more = evs.filter((e) => !main.includes(e));
    if (init.event && !evs.includes(init.event)) more.push(init.event);
    f.innerHTML = `
      ${r ? `<div class="hk-rtitle">${esc(t(r.title))}</div><div class="tiny">${esc(t(r.desc))}</div>` : ""}
      <label class="tiny">${t("什么时候跑")}</label>
      <select data-f="event">${main.map((e) => `<option value="${e}">${esc(hkEvName(e))} · ${e}</option>`).join("")}
        ${more.length ? `<optgroup label="${esc(t("其他（进阶）"))}">${more.map((e) => `<option value="${e}">${e}</option>`).join("")}</optgroup>` : ""}</select>
      <div class="tiny hk-evdesc"></div>
      <div class="hk-match"><label class="tiny hk-mlabel"></label>
        <input data-f="matcher" autocomplete="off" spellcheck="false" placeholder="${esc(t("留空 = 全部"))}">
        <div class="hk-chips"></div></div>
      ${r && r.label ? `<label class="tiny">${esc(t(r.label))}</label>
        ${r.single ? `<input data-f="param" autocomplete="off" spellcheck="false">` : `<textarea data-f="param" rows="5" class="mono" spellcheck="false"></textarea>`}` : ""}
      <label class="tiny">${t("运行的命令")}${r ? ` <span class="hk-auto">${t("（按上面自动生成，也可以直接改）")}</span>` : ""}</label>
      <textarea data-f="command" rows="3" class="mono" spellcheck="false" autocapitalize="off" placeholder="${esc(t("例如：echo 你好 >> ~/log.txt"))}"></textarea>
      <div class="hk-row"><label class="tiny">${t("超时（秒，留空用默认 60）")}</label><input data-f="timeout" type="number" min="1" max="600" inputmode="numeric"></div>
      <div class="row-actions"><button class="btn sm ghost" data-hk="f-test">${t("试运行")}</button>
        <button class="btn sm" data-hk="f-save">${HK.edit ? t("保存修改") : t("添加")}</button>
        <button class="btn sm ghost" data-hk="f-cancel">${t("取消")}</button></div>
      <div class="hk-out"></div>`;
    const q = (k) => f.querySelector(`[data-f="${k}"]`);
    q("event").value = init.event || "PreToolUse";
    q("matcher").value = init.matcher || "";
    q("command").value = init.command || "";
    q("timeout").value = init.timeout || "";
    if (q("param")) q("param").value = init.param != null ? init.param : t(r.param);
    const sync = () => {
      const ev = q("event").value, chips = hkChips(ev);
      f.querySelector(".hk-evdesc").textContent = HK_EV[ev] ? t(HK_EV[ev][1]) : "";
      f.querySelector(".hk-match").classList.toggle("hidden", !chips && !q("matcher").value);
      f.querySelector(".hk-mlabel").textContent = HK_TOOL_EV.includes(ev) ? t("管哪些工具（工具名，可用 | 分隔或写正则；留空 = 全部）") : t("只在这几种情况跑（留空 = 全部）");
      f.querySelector(".hk-chips").innerHTML = (chips || []).map((c) => `<button type="button" class="idx-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
    };
    q("event").addEventListener("change", sync);
    if (q("param")) q("param").addEventListener("input", () => { q("command").value = r.cmd(q("param").value); });
    if (r && !init.command) q("command").value = r.cmd(q("param") ? q("param").value : "");
    sync();
    box.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const hkFormVal = () => {
    const f = $("hook-form"), q = (k) => f.querySelector(`[data-f="${k}"]`);
    const to = parseInt(q("timeout").value, 10);
    return { event: q("event").value, matcher: q("matcher").value.trim(), command: q("command").value.trim(), timeout: to > 0 ? to : 0 };
  };
  function hkCloseForm() { HK.edit = null; HK.recipe = null; $("hook-form").innerHTML = ""; $("hook-form-box").open = false; }

  async function hkSave(hooks, extra) {
    const sc = hkScopeData();
    const r = await api("/api/ext/hooks/save", { method: "POST", body: JSON.stringify({ scope: HK.scope, dir: HK.data.dir, hooks, ...extra }) });
    if (r.ok === false) {
      toast(r.code === "badjson" ? t("这个配置文件不是合法的 JSON（{msg}），先打开修好，这里才能改。", { msg: r.message }) : t("保存失败：{msg}", { msg: r.message }), true);
      return false;
    }
    toast(t("已保存，下一条消息生效"));
    await loadExtHooks();
    return !!sc;
  }
  const hkClone = () => JSON.parse(JSON.stringify((hkScopeData() || {}).hooks || {}));

  /** 试运行结果：按事件和退出码说人话 */
  function hkShowResult(box, res, ev, cmd, matcher, timeout) {
    const blockEv = ["PreToolUse", "PermissionRequest", "UserPromptSubmit"].includes(ev);
    const ctxEv = ["UserPromptSubmit", "SessionStart"].includes(ev);
    let v, cls = "ok";
    if (res.timedOut) { v = t("超时了，命令没跑完就被停掉。"); cls = "warn"; }
    else if (res.code === 0) v = ctxEv && res.stdout.trim() ? t("正常结束：打印的内容会作为补充说明交给 Claude。") : blockEv ? t("放行：Claude 照常继续。") : t("正常结束。");
    else if (res.code === 2) { v = blockEv ? t("拦下（退出码 2）：Claude 这一步不会执行，stderr 里的话会转告它。") : ev === "Stop" || ev === "SubagentStop" ? t("退出码 2：Claude 会接着干，stderr 里的话会转告它。") : t("退出码 2：stderr 里的话会反馈给 Claude。"); cls = "warn"; }
    else { v = t("出错了（退出码 {n}）：不会拦下，Claude 照常继续。", { n: res.code }); cls = "err"; }
    const pre = (label, s) => s.trim() ? `<div class="tiny">${label}</div><pre class="hk-pre">${esc(s.slice(0, 4000))}</pre>` : "";
    box.innerHTML = `<div class="hk-verdict ${cls}">${esc(v)} <span class="tiny">${res.ms} ms</span></div>
      ${pre(t("输出（stdout）"), res.stdout)}${pre(t("错误输出（stderr）"), res.stderr)}
      <details class="ext-more"><summary>${t("模拟的输入（可以改了再试）")}</summary>
        <textarea class="mono hk-input" rows="8" spellcheck="false">${esc(res.input)}</textarea>
        <button class="btn sm ghost" data-hk="retest">${t("再试一次")}</button></details>`;
    box.querySelector('[data-hk="retest"]').onclick = (e) => { e.preventDefault(); hkRunTest(box, ev, cmd, matcher, timeout, box.querySelector(".hk-input").value); };
  }
  async function hkRunTest(box, ev, cmd, matcher, timeout, input) {
    if (!cmd) return toast(t("命令是空的"), true);
    box.innerHTML = `<div class="tiny">${t("运行中…")}</div>`;
    if (/\$HOME\/\.claude\/hooks\/cc-/.test(cmd)) await api("/api/ext/hooks/scripts", { method: "POST", body: "{}" }).catch(() => {});
    try {
      const res = await api("/api/ext/hooks/test", { method: "POST", body: JSON.stringify({ command: cmd, event: ev, matcher, timeout, input, dir: HK.data.dir }) });
      if (res.ok === false) throw new Error(res.message);
      hkShowResult(box, res, ev, cmd, matcher, timeout);
    } catch (e) { box.innerHTML = `<div class="tiny warn">${esc(e.message)}</div>`; }
  }

  $("ext-hook-sec").addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-hscope]");
    if (chip) { HK.scope = chip.dataset.hscope; localStorage.setItem("cc.hookScope", HK.scope); hkCloseForm(); return renderHooks(); }
    const mc = e.target.closest("[data-chip]");
    if (mc) {
      const inp = $("hook-form").querySelector('[data-f="matcher"]');
      const cur = inp.value.split("|").filter(Boolean);
      for (const p of mc.dataset.chip.split("|")) if (!cur.includes(p)) cur.push(p);
      inp.value = cur.join("|");
      return;
    }
    const b = e.target.closest("[data-hk]");
    if (!b || b.dataset.hk === "pause") return;
    e.preventDefault();
    const a = b.dataset.hk;
    const items = hkFlat(hkScopeData());
    const it = b.closest(".hk-item") ? items[+b.closest(".hk-item").dataset.i] : null;
    if (a === "open-file") { const sc = hkScopeData(); return openViewer(sc.file, "text", 0); }
    if (a === "test" && it) return hkRunTest(b.closest(".hk-item").querySelector(".hk-out"), it.ev, it.h.command, it.matcher, it.h.timeout);
    if (a === "del" && it) {
      if (!confirm(t("删除这条规则？"))) return;
      const h = hkClone();
      h[it.ev][it.gi].hooks.splice(it.hi, 1);
      return hkSave(h);
    }
    if (a === "edit" && it) {
      HK.edit = { ev: it.ev, gi: it.gi, hi: it.hi };
      HK.recipe = hkRecipeOf(it.ev, it.h) || null;
      const param = HK.recipe && HK.recipe.back ? HK.recipe.back(shArgs(it.h.command)) : undefined;
      return hkForm({ event: it.ev, matcher: it.matcher, command: it.h.command, timeout: it.h.timeout, param });
    }
    if (a === "recipe") {
      HK.edit = null;
      HK.recipe = HK_RECIPES.find((r) => r.id === b.dataset.id);
      return hkForm({ event: HK.recipe.event, matcher: HK.recipe.matcher });
    }
    if (a === "f-cancel") return hkCloseForm();
    if (a === "f-test") { const v = hkFormVal(); return hkRunTest($("hook-form").querySelector(".hk-out"), v.event, v.command, v.matcher, v.timeout); }
    if (a === "f-save") {
      const v = hkFormVal();
      if (!v.command) return toast(t("命令是空的"), true);
      if (/\$HOME\/\.claude\/hooks\/cc-/.test(v.command)) await api("/api/ext/hooks/scripts", { method: "POST", body: "{}" }).catch(() => {});
      const h = hkClone();
      const entry = { type: "command", command: v.command };
      if (v.timeout) entry.timeout = v.timeout;
      if (HK.edit) {
        const old = h[HK.edit.ev][HK.edit.gi];
        const keep = old.hooks[HK.edit.hi];
        // 事件、匹配都没变就原地换；变了就从原组里摘掉，按新的事件 / 匹配放
        if (HK.edit.ev === v.event && (old.matcher || "") === v.matcher) { const nh = { ...keep, ...entry }; if (!v.timeout) delete nh.timeout; old.hooks[HK.edit.hi] = nh; }
        else { old.hooks.splice(HK.edit.hi, 1); hkPut(h, v, entry); }
      } else hkPut(h, v, entry);
      if (await hkSave(h)) hkCloseForm();
    }
  });
  $("ext-hook-sec").addEventListener("change", async (e) => {
    if (e.target.dataset.hk !== "pause") return;
    const on = e.target.checked;
    const r = await api("/api/ext/hooks/save", { method: "POST", body: JSON.stringify({ scope: "user", disableAll: on }) });
    if (r.ok === false) { e.target.checked = !on; return toast(t("保存失败：{msg}", { msg: r.message }), true); }
    toast(on ? t("已暂停全部 hooks") : t("hooks 已恢复"));
    loadExtHooks();
  });
  /** 放进事件下匹配规则相同的那组（没有就新开一组） */
  function hkPut(h, v, entry) {
    const groups = h[v.event] || (h[v.event] = []);
    let g = groups.find((x) => (x.matcher || "") === v.matcher);
    if (!g) { g = v.matcher ? { matcher: v.matcher, hooks: [] } : { hooks: [] }; groups.push(g); }
    g.hooks.push(entry);
  }

  async function loadExtMcp() {
    const box = $("ext-mcp");
    const r = await api("/api/ext/mcp").catch((e) => ({ items: [], err: e.message }));
    $("ext-m-count").textContent = (r.items || []).length;
    box.innerHTML = (r.items || []).map((m) => extItem(
      esc(m.name) + (m.cloud ? ` <span class="badge">${t("账户连接器")}</span>` : ""),
      `<span class="mono">${esc(m.target)}</span>`,
      m.cloud ? "" : `<button data-x="mcp-rm" data-id="${esc(m.name)}">${t("移除")}</button>`,
      `<div class="tiny ext-st ${m.ok ? "ok" : "warn"}">${esc(m.status)}</div>`,
      m.cloud ? ["cloud"] : [m.ok ? "ok" : "bad", /^https?:/i.test(m.target || "") ? "remote" : "local"])).join("")
      || `<div class="tiny">${esc(r.err || t("还没有 MCP 服务器。"))}</div>`;
    renderIdx("mcp", [["ok", t("已连接")], ["bad", t("连不上")], ["cloud", t("账户连接器")], ["local", t("本地")], ["remote", t("远程")]]);
  }

  // ── 官方技能目录（anthropics/skills）：展开时才拉；装好后上面「技能」列表跟着刷新 ──
  const KB = (n) => (n < 1048576 ? Math.max(1, Math.ceil((n || 0) / 1024)) + " KB" : MB(n));
  async function loadSkillCat(force) {
    const box = $("ext-s-cat");
    if (!box.children.length || force) box.innerHTML = `<div class="tiny">${t("正在拉取官方技能目录…")}</div>`;
    const r = await api("/api/ext/catalog/skills" + (force ? "?refresh=1" : "")).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) { box.innerHTML = `<div class="tiny err">${esc(r.message || "")}</div><div class="it-acts"><button data-x="skillcat-retry">${t("重试")}</button></div>`; return; }
    box.innerHTML = r.items.map((x) => extItem(esc(x.name),
      `<span>${KB(x.bytes)}</span>${x.installed ? `<span>${t("已安装")}</span>` : ""}`,
      x.installed ? "" : `<button data-x="skillcat-install" data-id="${esc(x.dir)}">${t("安装")}</button>`,
      `<div class="tiny ext-desc">${esc(x.description)}</div><div class="tiny"><a class="weblink" href="https://github.com/${esc(r.repo)}/tree/main/skills/${esc(x.dir)}">${t("源码与许可证")}</a></div>`)).join("")
      || `<div class="tiny">${t("官方目录是空的。")}</div>`;
  }
  $("ext-s-catbox").addEventListener("toggle", () => { if ($("ext-s-catbox").open) loadSkillCat(); });

  // ── 官方 MCP 注册表：搜索 → 条目里展开小表单（名字、装法、环境变量 / 请求头）→ 交给 claude mcp add ──
  const mcpCat = { q: "", next: "", npx: false, items: new Map() };
  const mcpShort = (n) => (String(n).split("/").pop() || "mcp").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  async function searchMcpCat(more) {
    const box = $("ext-mcp-cat");
    if (!more) { mcpCat.q = $("ext-mcp-q").value.trim(); mcpCat.next = ""; mcpCat.items.clear(); box.innerHTML = `<div class="tiny">${t("正在查注册表…")}</div>`; }
    const r = await api(`/api/ext/catalog/mcp?q=${encodeURIComponent(mcpCat.q)}&cursor=${encodeURIComponent(more ? mcpCat.next : "")}`).catch((e) => ({ ok: false, message: e.message }));
    const old = box.querySelector(".mcpcat-more"); if (old) old.remove();
    if (!r.ok) { box.insertAdjacentHTML(more ? "beforeend" : "afterbegin", `<div class="tiny err">${esc(r.message || "")}</div>`); if (!more) box.querySelector(".tiny:not(.err)")?.remove(); return; }
    mcpCat.npx = r.npx; mcpCat.next = r.next;
    const html = r.items.filter((m) => !mcpCat.items.has(m.name)).map((m) => {
      mcpCat.items.set(m.name, m);
      const usable = m.options.filter((o) => o.kind === "remote" || r.npx);
      const meta = (m.version ? `<span>${esc(m.version)}</span>` : "") +
        m.options.map((o) => `<span>${o.kind === "remote" ? esc(t("远程") + " · " + o.transport) : "npm"}</span>`).join("") +
        (m.other.length ? `<span class="warn">${t("另有 {kinds} 装法，本机用不了", { kinds: esc(m.other.join(" / ")) })}</span>` : "");
      const acts = usable.length ? `<button data-x="mcpcat-add" data-id="${esc(m.name)}">${t("添加")}</button>`
        : `<span class="tiny warn">${m.options.length ? t("要 npx（cccodroid 的工具包里有）") : t("本机装不了")}</span>`;
      return extItem(esc(m.title || m.name), meta, acts,
        `<div class="tiny mono">${esc(m.name)}</div><div class="tiny ext-desc">${esc(m.description)}</div>` +
        (m.homepage ? `<div class="tiny"><a class="weblink" href="${esc(m.homepage)}">${esc(m.homepage)}</a></div>` : "") + `<div class="mcpcat-form hidden"></div>`);
    }).join("");
    if (!more) box.innerHTML = html || `<div class="tiny">${t("没找到。换个关键词试试（英文更全）。")}</div>`;
    else box.insertAdjacentHTML("beforeend", html);
    if (r.next) box.insertAdjacentHTML("beforeend", `<button class="btn ghost sm mcpcat-more">${t("再显示 30 个")}</button>`);
  }
  function mcpCatForm(m, form, oi = 0) {
    const usable = m.options.filter((o) => o.kind === "remote" || mcpCat.npx), o = usable[oi];
    const fields = (o.kind === "npm" ? o.env : o.headers) || [];
    form.innerHTML = `<div class="ext-form">
      ${usable.length > 1 ? `<select data-f="opt">${usable.map((x, i) => `<option value="${i}"${i === oi ? " selected" : ""}>${x.kind === "npm" ? "npm · " + esc(x.package) : esc(t("远程") + " · " + x.target)}</option>`).join("")}</select>` : ""}
      <input data-f="name" value="${esc(mcpShort(m.name))}" placeholder="${esc(t("名字（字母、数字、- _ .）"))}" autocomplete="off">
      <div class="tiny mono">${esc(o.target)}</div>
      ${fields.map((x) => `<input data-k="${esc(x.name)}" data-req="${x.required ? 1 : ""}" type="${x.secret ? "password" : "text"}" autocomplete="off"
        placeholder="${esc(x.name + (x.required ? " *" : "") + (x.description ? " — " + x.description : ""))}">`).join("")}
      <button class="btn sm" data-x="mcpcat-go" data-id="${esc(m.name)}" data-oi="${oi}">${t("确认添加")}</button></div>`;
    form.classList.remove("hidden");
  }
  $("tab-ext").addEventListener("change", (e) => {
    if (e.target.dataset.f !== "opt") return;
    const form = e.target.closest(".mcpcat-form"), id = form.parentElement.querySelector("[data-x=mcpcat-add]")?.dataset.id;
    if (id) mcpCatForm(mcpCat.items.get(id), form, Number(e.target.value));
  });
  $("tab-ext").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("mcpcat-more")) return searchMcpCat(true);
    const x = b.dataset.x;
    if (x === "skillcat-retry") return loadSkillCat(true);
    if (x === "skillcat-install") {
      b.disabled = true; b.textContent = t("安装中…");
      const r = await post("/api/ext/catalog/skills/install", { dir: b.dataset.id }).catch((er) => ({ ok: false, message: er.message }));
      toast(r.ok ? t("已安装 {name}，下一条消息生效", { name: b.dataset.id }) : t("安装失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) loadExtSkills(); else { b.disabled = false; b.textContent = t("安装"); }
      return;
    }
    if (x === "mcpcat-add") {
      const form = b.closest(".item").querySelector(".mcpcat-form");
      if (!form.classList.contains("hidden")) return form.classList.add("hidden");
      return mcpCatForm(mcpCat.items.get(b.dataset.id), form);
    }
    if (x === "mcpcat-go") {
      const m = mcpCat.items.get(b.dataset.id), form = b.closest(".mcpcat-form");
      const o = m.options.filter((y) => y.kind === "remote" || mcpCat.npx)[Number(b.dataset.oi) || 0];
      const vals = [...form.querySelectorAll("input[data-k]")].map((i) => [i.dataset.k, i.value.trim(), !!i.dataset.req]);
      const lack = vals.filter(([, v, req]) => req && !v).map(([k]) => k);
      if (lack.length) return toast(t("要先填：{names}", { names: lack.join(", ") }), true);
      const filled = vals.filter(([, v]) => v);
      const body = { name: form.querySelector("[data-f=name]").value.trim(), transport: o.transport, target: o.target,
        env: o.kind === "npm" ? filled.map(([k, v]) => k + "=" + v) : [], headers: o.kind === "remote" ? filled.map(([k, v]) => k + ": " + v) : [] };
      if (o.kind === "npm" && !confirm(t("这个 MCP 服务器会在本机运行下面的 npm 包（注册表里任何人都能发布，没人审核），确认是你信任的来源再继续：\n\n{cmd}", { cmd: o.target }))) return;
      b.disabled = true;
      const r = await post("/api/ext/mcp/add", body).catch((er) => ({ ok: false, message: er.message }));
      b.disabled = false;
      toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) { form.classList.add("hidden"); loadExtMcp(); }
    }
  });
  $("ext-mcp-search").addEventListener("click", () => searchMcpCat(false));
  $("ext-mcp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMcpCat(false); });
  $("ext-mcp-catbox").addEventListener("toggle", () => { if ($("ext-mcp-catbox").open && !$("ext-mcp-cat").children.length) searchMcpCat(false); });

  $("ext-p-search").addEventListener("click", () => searchPlugins(false));
  $("ext-p-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlugins(false); });
  $("ext-s-import").addEventListener("click", () => $("ext-s-file").click());
  $("ext-s-file").addEventListener("change", async (e) => {
    // 文件选择器不限类型（群里转来的 zip 常被标成别的类型，限了就选不中）；可一次选多个，zip 里有几个技能装几个
    const list = [...(e.target.files || [])]; e.target.value = "";
    if (!list.length) return;
    const ok = [], bad = [];
    for (const f of list) {
      const r = await api("/api/ext/skills/import", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await f.arrayBuffer() })
        .catch((err) => ({ ok: false, message: err.message }));
      if (r.ok) ok.push(...(r.dirs || [r.dir]));
      else bad.push(`${f.name}：${r.message || ""}`);
      for (const x of r.skipped || []) bad.push(`${x.name}：${x.why}`);
    }
    if (ok.length) toast(t("已安装技能 {name}", { name: ok.join("、") }) + (bad.length ? "\n" + t("未装：{msg}", { msg: bad.join("；") }) : ""), !!bad.length);
    else toast(t("安装失败：{msg}", { msg: bad.join("；") }), true);
    loadExtSkills();
  });
  $("ext-m-add").addEventListener("click", async () => {
    const source = $("ext-m-src").value.trim();
    if (!source) return;
    toast(t("正在添加市场…"));
    const r = await post("/api/ext/marketplaces/add", { source }).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加") : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) $("ext-m-src").value = "";
    loadExtMarkets();
  });
  $("ext-mcp-add").addEventListener("click", async () => {
    const transport = $("ext-mcp-tr").value;
    const extra = $("ext-mcp-env").value.split(",").map((x) => x.trim()).filter(Boolean);
    const body = {
      name: $("ext-mcp-name").value.trim(), transport, target: $("ext-mcp-target").value.trim(),
      env: extra.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)),
      headers: extra.filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && x.includes(":")),
    };
    const r = await post("/api/ext/mcp/add", body).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) { ["ext-mcp-name", "ext-mcp-target", "ext-mcp-env"].forEach((id) => ($(id).value = "")); loadExtMcp(); }
  });

  $("tab-ext").addEventListener("click", async (e) => {
    if (e.target.classList.contains("ext-more-btn")) return searchPlugins(true);
    const g = e.target.closest("[data-g]");
    if (g && !g.disabled) {
      const a = g.dataset.g;
      if (a === "copy") { copyText(g.textContent.trim()); return toast(t("已复制")); }
      if (a === "open") { copyText(g.dataset.code); toast(t("一次性码已复制，在打开的页面里粘贴")); return openExternal(g.dataset.url); }
      if (a === "logout" && !confirm(t("退出 GitHub 账号 {name}？gh 会删掉它保存的令牌。", { name: g.dataset.user }))) return;
      g.disabled = true;
      const r = await post("/api/gh/" + a, { user: g.dataset.user || "" }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      if (a === "login") ghAuth.polling = true;
      return loadGhAuth(true);
    }
    const cb = e.target.closest("button[data-c]");
    if (cb && !cb.disabled) {
      const c = cb.dataset.c, id = cb.dataset.id;
      if (c === "reindex") { cb.disabled = true; return loadComponents(true); }
      const nm = (cb.closest(".item")?.querySelector(".it-title")?.textContent || id).trim();
      if (c === "install" && cb.dataset.unverified && !confirm(t("{name} 还没人在真机上验证过，可能装不上或用不了。仍然安装？", { name: nm }))) return;
      if (c === "remove" && cb.dataset.usedby) return toast(t("{names} 要用它，先卸载那些组件", { names: cb.dataset.usedby }), true);
      if (c === "remove" && !confirm(t("卸载组件 {name}？会删掉它装进工具包的文件，你自己的文件不受影响。", { name: nm }))) return;
      cb.disabled = true;
      const r = await post("/api/components/" + c, { id }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      else if (c === "remove") {
        toast(t("已卸载"));
        // 组件自己攒的运行数据（下载缓存、解开的运行环境）不随卸载删，问一句
        if (r.data && r.data.bytes > 0 && confirm(t("{name} 还留着 {size} 运行数据（{path}：下载缓存、解开的运行环境等）。一起删掉？以后再装要重新下载。", { name: nm, size: fmtSize(r.data.bytes), path: r.data.path }))) {
          const p = await post("/api/components/purge", { id }).catch((err) => ({ ok: false, message: err.message }));
          toast(p.ok ? t("运行数据已删除") : t("失败：{msg}", { msg: p.message || "" }), !p.ok);
        }
      }
      return loadComponents();
    }
    const b = e.target.closest("button[data-x]");
    if (!b || b.disabled) return;
    const x = b.dataset.x, id = b.dataset.id;
    if (x === "install") return installPlugin(id, b);
    const ask = {
      uninstall: t("卸载插件 {name}？", { name: id }),
      "skill-rm": t("删除技能 {name}？文件夹会被整个删掉。", { name: id }),
      "mcp-rm": t("移除 MCP 服务器 {name}？", { name: id }),
      "market-rm": t("移除插件市场 {name}？从它装的插件也会一并卸载。", { name: id }),
    }[x];
    if (ask && !confirm(ask)) return;
    b.disabled = true;
    const url = { uninstall: "/api/ext/plugins/uninstall", enable: "/api/ext/plugins/enable", disable: "/api/ext/plugins/disable",
      "skill-rm": "/api/ext/skills/delete", "mcp-rm": "/api/ext/mcp/remove", "market-rm": "/api/ext/marketplaces/remove" }[x];
    const key = x === "skill-rm" ? "dir" : x === "mcp-rm" || x === "market-rm" ? "name" : "id";
    const r = await post(url, { [key]: id }).catch((err) => ({ ok: false, message: err.message }));
    toast(r.ok ? t("完成") : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
    b.disabled = false;
    if (x === "skill-rm") loadExtSkills();
    else if (x === "mcp-rm") loadExtMcp();
    else if (x === "market-rm") { loadExtMarkets(); loadExtPlugins(); }
    else loadExtPlugins();
  });

  // ── 排障：安全模式 / 日志分享 / 修复账本 ───────────────────────────
  function paintSafeMode(on) {
    $("safe-mode").checked = !!on;
    let bar = $("safe-bar");
    if (on && !bar) {
      bar = document.createElement("div");
      bar.id = "safe-bar"; bar.className = "safe-bar";
      bar.innerHTML = `<span>${t("安全模式：自定义配置（CLAUDE.md、技能、插件、钩子、MCP）没有加载")}</span> <button class="btn sm ghost" id="safe-off">${t("退出安全模式")}</button>`;
      $("chat").before(bar);
      $("safe-off").onclick = () => setSafe(false);
    } else if (!on && bar) bar.remove();
  }
  async function setSafe(on) {
    const r = await post("/api/safe-mode", { on }).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) return toast(r.message || "", true);
    paintSafeMode(r.safeMode);
    toast(r.safeMode ? t("已进入安全模式，下一条消息生效") : t("已退出安全模式，下一条消息生效"));
  }
  $("safe-mode").addEventListener("change", (e) => setSafe(e.target.checked));
  $("upd-log").addEventListener("click", () => { closeSettings(); openPage("changelog"); });
  $("btn-share-logs").addEventListener("click", async () => {
    // 打包前给用户看清单：发出去的是什么、去掉了什么
    if (!confirm(t("打一个诊断包，经系统分享发出去。\n\n包里有：\n· 版本与设备：cccodroid / Android 版本、机型、芯片、剩余空间\n· 开发工具包：装的是哪一版、更新与自检状态\n· 最近的日志：本应用的系统日志、网关日志的最后一段\n· 修复账本：安装、校验、修复做过哪些、成没成\n\n已经去掉：\n· 密钥、令牌、登录凭据、邮箱\n· 你发给 Claude 的消息内容\n· 会话记录本身不在包里\n\n继续？"))) return;
    toast(t("正在打包日志…"));
    const r = await post("/api/app/share_logs").catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) toast(t("没分享成：{msg}", { msg: r.message || "" }), true);
  });
  // 到 GitHub 反馈：网关拼好链接（设备、ROM、自检、组件），先给用户看要填进去的内容，再用外部浏览器打开
  $("btn-issue").addEventListener("click", async () => {
    let r;
    try { r = await api("/api/issue-draft"); } catch (e) { return toast(e.message, true); }
    const dev = r.body.slice(r.body.indexOf("### Device"), r.body.indexOf("<sub>")).trim();
    if (!confirm(t("将打开 GitHub 的新建 Issue 页面，下面这些会预先填好，提交前还能改：") + "\n\n" + (dev.length > 1500 ? dev.slice(0, 1500) + "…" : dev))) return;
    openExternal(r.url);
  });
  // 状态对账：组件 / 模块 / 包清单 / 自定义组件的记录和磁盘对一遍（网关启动后自动核过一次，这里看结果或再核）
  function paintReconcile(r, always) {
    const box = $("reconcile-box"), bad = (r.findings || []).filter((f) => f.level !== "info");
    if (!r.supported || (!always && !bad.length)) return box.classList.add("hidden");
    const head = r.at ? `<div class="tiny">${esc(bad.length ? t("记录和磁盘有 {n} 处对不上：", { n: bad.length }) : t("记录和磁盘一致"))} · ${esc(new Date(r.at).toLocaleString())}</div>` : "";
    box.innerHTML = head + (r.findings || []).map((f) => `<div class="item ledger ${f.level === "info" ? "" : "bad"}">
        <div class="it-title wrap">${uiI(f.level === "error" ? "x" : f.level === "warn" ? "warn" : "info", "lv-" + f.level)}${esc(f.msg)}</div>
        ${f.fix ? `<div class="tiny">${esc(t("怎么办："))}${esc(f.fix)}</div>` : ""}
        ${f.samples.length ? `<div class="tiny mono">${f.samples.slice(0, 5).map(esc).join("<br>")}</div>` : ""}
      </div>`).join("");
    box.classList.remove("hidden");
  }
  async function loadReconcile(run) {
    const r = await api("/api/reconcile" + (run ? "?run=1" : "")).catch(() => null);
    if (r) paintReconcile(r, run);
    return r;
  }
  $("btn-reconcile").addEventListener("click", async () => {
    const box = $("reconcile-box");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    toast(t("正在核对…"));
    const r = await loadReconcile(true);
    if (!r) toast(t("核对失败"), true);
    else if (!r.supported) toast(t("这里没有工具包，不用核对"));
  });
  const LEDGER_KIND = () => ({ verify: t("校验"), repair: t("修复"), install: t("安装"), uninstall: t("卸载"), recover: t("恢复"), "safe-mode": t("安全模式"), logs: t("日志") });
  $("btn-ledger").addEventListener("click", async () => {
    const box = $("ledger-list");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    const r = await api("/api/ledger").catch(() => ({ items: [] }));
    const K = LEDGER_KIND();
    box.innerHTML = (r.items || []).map((e) => `<div class="item ledger ${e.ok ? "" : "bad"}">
        <div class="it-meta"><span>${esc(new Date(e.at).toLocaleString())}</span><span class="badge">${esc(K[e.kind] || e.kind)}</span><span>${e.ok ? "✓" : "✗"}</span></div>
        <div class="it-title wrap">${esc(e.msg || "")}</div>
        ${e.detail && e.detail.samples && e.detail.samples.length ? `<div class="tiny mono">${e.detail.samples.slice(0, 5).map((x) => esc(typeof x === "string" ? x : JSON.stringify(x))).join("<br>")}</div>` : ""}
      </div>`).join("") || `<div class="tiny">${r.items === null ? t("这个版本没有修复账本。") : t("还没有记录。安装、校验、修复、启动时的恢复都会记在这里。")}</div>`;
    box.classList.remove("hidden");
  });


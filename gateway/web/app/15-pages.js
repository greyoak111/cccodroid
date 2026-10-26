  // ── 设置：手机设置那样的分页。根页是分类清单 + 搜索；点一类进去看那一类，返回键退一级。
  //    搜索跨类筛行，命中的类连同行一起列出来；清空或返回回到分类清单 ──
  var setOpen = false;
  var setQ = "";
  var setCatOpen = null;
  const setCatEls = () => [...document.querySelectorAll("#tab-settings .set-cat")];
  const setNavEls = () => [...document.querySelectorAll("#set-cats [data-cat]")];
  const pagesNarrow = () => innerWidth < 680;
  const setSearchEl = $("set-search");
  function openSettings(cat) {
    OV.closeAll();
    setOpen = true;
    setCatOpen = cat || null;
    setQ = "";
    setSearchEl.value = "";
    $("set-ov").classList.remove("hidden");
    $("set-ov").classList.toggle("narrow", pagesNarrow());
    paintSetCats();
    $("tab-settings").scrollTop = 0;
    renderSideNav();
    closeDrawer();
    loadQuota().catch(() => {});
    loadProviders(); loadPriv(); loadUpd(); loadNotify(); loadDev(); loadReconcile(false);
  }
  function closeSettings() {
    if (!setOpen) return;
    setOpen = false;
    $("set-ov").classList.add("hidden");
    renderSideNav();
  }
  $("set-x").addEventListener("click", closeSettings);
  $("set-ov").addEventListener("click", (e) => { if (e.target.id === "set-ov") closeSettings(); });
  // 返回：搜索结果 → 分类清单 → 关掉设置
  function setBack() {
    if (setQ) { setSearch(""); setSearchEl.blur(); return; }
    if (setCatOpen) { setCatOpen = null; paintSetCats(); $("tab-settings").scrollTop = 0; return; }
    closeSettings();
  }
  $("set-back").addEventListener("click", setBack);

  // 搜索：按空格分词，每个词都要命中（名称、说明、当前值都算）；分类名命中就整类留下
  function setSearch(q) {
    setQ = q || "";
    setSearchEl.value = setQ;
    paintSetCats();
  }
  setSearchEl.addEventListener("input", () => {
    setQ = setSearchEl.value;
    paintSetCats();
    $("tab-settings").scrollTop = 0;
  });
  $("set-search-x").addEventListener("click", () => { setSearch(""); setSearchEl.focus(); });

  // 重画：三种状态——分类清单（list）、某一类（one）、搜索结果（searching）
  function paintSetCats() {
    paintSetUsage();
    const narrow = pagesNarrow();
    $("set-ov").classList.toggle("narrow", narrow);
    const terms = setQ.trim().toLowerCase().split(/\s+/).filter(Boolean), searching = terms.length > 0;
    let shown = 0;
    for (const c of setCatEls()) {
      const head = (c.querySelector(".set-h")?.textContent || "").toLowerCase();
      const catHit = searching && terms.every((w) => head.includes(w));
      let hits = 0;
      for (const f of c.querySelectorAll(":scope > .srow, :scope > .sblock")) {
        if (f.classList.contains("hidden")) { f.classList.remove("sx"); continue; }   // 加载逻辑藏的，不动
        const ok = !searching || catHit || terms.every((w) => (f.textContent || "").toLowerCase().includes(w));
        f.classList.toggle("sx", !ok);
        if (ok) hits++;
      }
      const nb = document.querySelector(`#set-cats [data-cat="${c.dataset.cat}"]`);
      if (nb) nb.classList.toggle("hidden", hits === 0);
      const show = searching ? hits > 0 : (setCatOpen ? c.dataset.cat === setCatOpen && hits > 0 : false);
      c.classList.toggle("hidden", !show);
      if (show) shown++;
    }
    $("tab-settings").classList.toggle("set-list", !searching && !setCatOpen);
    $("tab-settings").classList.toggle("set-one", !searching && !!setCatOpen);
    $("tab-settings").classList.toggle("set-searching", searching);
    $("set-ov").classList.toggle("set-one-mode", !searching && !!setCatOpen);
    $("set-nores").classList.toggle("hidden", !searching || shown > 0);
    $("set-search-x").classList.toggle("hidden", !setQ);
    const cb = (!searching && setCatOpen) ? document.querySelector(`#set-cats [data-cat="${setCatOpen}"]`) : null;
    $("set-title").textContent = cb ? cb.textContent.trim() : t("设置");
    $("set-back").classList.toggle("hidden", !searching && !setCatOpen);
  }
  // 点分类：进那一类
  $("set-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    setCatOpen = b.dataset.cat;
    paintSetCats();
    $("tab-settings").scrollTop = 0;
  });
  addEventListener("resize", () => { if (setOpen) paintSetCats(); });
  // 内容异步填、块自己显隐藏：下一帧重画（代替原来打开后固定等 900ms）
  let setCatRaf = 0;
  new MutationObserver(() => { if (!setOpen || setCatRaf) return; setCatRaf = requestAnimationFrame(() => { setCatRaf = 0; paintSetCats(); }); })
    .observe($("tab-settings"), { subtree: true, attributes: true, attributeFilter: ["class"] });

  // 侧栏常驻项：打开侧栏、展开「更多」、进入勾选
  $("set-navpins").addEventListener("click", () => {
    localStorage.setItem("cc.navMore", "1"); navEdit = true;
    if (!(window.CCLayout && CCLayout.docked())) drawerEl.classList.remove("hidden");
    renderSideNav();
  });
  // 设置里较长的说明默认收成两行，点一下展开 / 收起
  $("tab-settings").addEventListener("click", (e) => {
    const p = e.target.closest(".sl p.clamp"); if (p && !e.target.closest("a, code")) p.classList.toggle("open");
  });
  // 整页从顶栏下沿开始：顶栏高度随安全区 / 手机横屏压缩而变，量出来给 CSS
  new ResizeObserver(() => document.documentElement.style.setProperty("--tbh", $("topbar").offsetHeight + "px")).observe($("topbar"), { box: "border-box" });   // 外壳注入 --safe-t 只改内边距，内容盒不变；不看边框盒就漏掉，页面层会压住顶栏


  // ── 交流群与参与：帮助页最后一节、更新说明卡片底部共用。群号为主，二维码点开才显示 ──
  const COMMUNITY = { qq: "1062538743", repo: "https://github.com/greyoak111/cccodroid", discord: "https://discord.gg/jE6KW8kwpe" };
  function communityHtml(compact) {
    const R = COMMUNITY.repo, zh = isZh();
    return `<div class="cm-box${compact ? " compact" : ""}">
      <div class="cm-row"><span class="cm-k">${esc(t("QQ 交流群"))}</span>
        <button type="button" class="cm-num" data-cm="copy" title="${esc(t("点一下复制群号"))}">${COMMUNITY.qq}</button>
        <button type="button" class="btn ghost sm" data-cm="qr">${esc(t("二维码"))}</button></div>
      <img class="cm-qr hidden" src="/qq-group.jpg" alt="${esc(t("QQ 交流群二维码"))}" loading="lazy">
      ${compact ? "" : `<p>${esc(t("用起来有问题、有想法，欢迎进群聊。报 bug 最好走「设置 → 到 GitHub 反馈」，机型和自检结果会自动带上，群里消息一多就沉了。"))}</p>
      <p>${esc(t("这个项目目前只有作者一个人在维护，非常需要帮手：译文校对、机型适配报告、组件配方、文档、代码都欢迎，不会写代码也能帮上忙。怎么参与见仓库里的贡献指南。"))}</p>`}
      <div class="cm-links"><a href="${COMMUNITY.discord}">Discord</a> · <a href="${R}/discussions">${esc(t("讨论区"))}</a> · <a href="${R}/issues">${esc(t("反馈问题"))}</a> · <a href="${R}/blob/main/${zh ? "CONTRIBUTING.zh-CN.md" : "CONTRIBUTING.md"}">${esc(t("参与开发"))}</a></div>
    </div>`;
  }
  function communityBind(root) {
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cm]"), a = e.target.closest(".cm-links a");
      if (b && b.dataset.cm === "copy") {
        copyText(COMMUNITY.qq).then((ok) => toast(ok ? t("已复制群号 {n}", { n: COMMUNITY.qq }) : COMMUNITY.qq));
      } else if (b && b.dataset.cm === "qr") {
        const img = b.closest(".cm-box").querySelector(".cm-qr");
        img.classList.toggle("hidden");
        b.textContent = img.classList.contains("hidden") ? t("二维码") : t("收起二维码");
      } else if (a) {
        e.preventDefault();
        if (window.CCApp && CCApp.openUrl) CCApp.openUrl(a.href); else window.open(a.href, "_blank", "noopener");
      }
    });
  }

  // ── 帮助 ── 文档是 web/help/zh.md、en.md（其他语言先用英文）。第一次点开才取、才渲染。
  // 「## 」小节各包成一个 section：宽屏左边是固定目录、窄屏是顶上一排横向目录，滚动时高亮当前节；
  // 搜索框按节过滤。顶栏按钮那张表换成真图标的图例（md 里写的是字符，各语言共用一份映射）。
  let helpLang = "";
  const HELP_TOPBAR = { "☰": "btn-menu", "📁": "btn-files", ">_": "btn-term", "🌐": "btn-web", "‹›": "btn-palette", "⋯": "btn-more", "＋": "btn-new" };
  function helpIcon(id) {
    const sv = $(id)?.querySelector("svg");
    return sv ? sv.outerHTML : "";
  }
  async function loadHelp() {
    const lang = /^zh/.test((window.I18N && I18N.lang) || "zh") ? "zh" : "en";
    if (helpLang === lang) return spyHelp();
    const body = $("help-body"), toc = $("help-toc");
    body.innerHTML = `<p class="muted">${esc(t("加载中…"))}</p>`;
    try {
      const r = await fetch("/help/" + lang + ".md", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setHtml(body, renderMd(await r.text()));
      // 最后一节：交流群与参与（不写在 md 里：群号、二维码、链接要能点）
      body.insertAdjacentHTML("beforeend", `<h3>${esc(t("交流群与参与"))}</h3>` + communityHtml(false));
      if (!body.dataset.cm) { body.dataset.cm = "1"; communityBind(body); }
      helpLang = lang;
    } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    // 顶栏表 → 图例
    body.querySelectorAll("table").forEach((tb) => {
      const rows = [...tb.querySelectorAll("tr")].filter((tr) => tr.querySelector("td")).map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      if (!rows.length || !rows.every((r) => HELP_TOPBAR[r[0]])) return;
      const g = document.createElement("div");
      g.className = "help-legend";
      // 「名称：说明」拆成两行（照稿：图标 + 粗体名 + 灰色说明）
      g.innerHTML = rows.map(([k, d]) => { const m = d.match(/^(.+?)[：:]\s*(.*)$/) || [0, d, ""];
        return `<div><span class="hl-ico">${helpIcon(HELP_TOPBAR[k])}</span><b>${esc(m[1])}</b><span>${esc(m[2])}</span></div>`; }).join("");
      (tb.closest(".md-table, .tbl-wrap") || tb).replaceWith(g);
    });
    // 正文里零散的 📎 换成附件图标
    const att = helpIcon("btn-attach");
    if (att) body.querySelectorAll("li, p").forEach((el) => {
      const tn = el.firstChild;
      if (tn && tn.nodeType === 3 && /^\s*📎/.test(tn.data)) { tn.data = tn.data.replace("📎", ""); el.insertAdjacentHTML("afterbegin", `<span class="hl-inl">${att}</span>`); }
    });
    // 按 h3 分节
    const lead = body.querySelector("h2");
    if (lead) lead.remove();
    const secs = [];
    let cur = null;
    for (const n of [...body.childNodes]) {
      if (n.nodeName === "H3") {
        cur = document.createElement("section");
        cur.className = "help-sec";
        cur.dataset.sec = "h" + secs.length;
        n.before(cur);
        secs.push(cur);
      }
      if (cur) cur.appendChild(n);
      else if (n.nodeType === 1) n.classList.add("help-lead");
    }
    const steps = secs[0] && secs[0].querySelector(":scope > ol");
    if (steps) {
      steps.classList.add("help-steps");
      // 「**标题**：说明」→ 标题一行、说明一行
      steps.querySelectorAll(":scope > li").forEach((li) => {
        const b = li.firstElementChild;
        if (!b || b.tagName !== "STRONG" || li.firstChild !== b) return;
        const rest = li.innerHTML.slice(b.outerHTML.length).replace(/^\s*[：:]\s*/, "");
        li.innerHTML = `<b>${b.innerHTML}</b><span>${rest}</span>`;
      });
    }
    // 已知问题：「状态 · 厂商 · **标题**：说明」→ 可折叠卡片
    const ISSUE_OK = ["修好了", "Fixed"], ISSUE_ALT = ["有绕法", "Workaround"];   // 帮助只有中英两份
    body.querySelectorAll(".help-sec li").forEach((li) => {
      const m = li.innerHTML.match(/^\s*([^·<]+?)\s*·\s*([^·<]+?)\s*·\s*<strong>(.+?)<\/strong>\s*[：:]\s*([\s\S]*)$/);
      if (!m) return;
      const ul = li.parentElement;
      const st = m[1].trim(), cls = ISSUE_OK.includes(st) ? "ok" : ISSUE_ALT.includes(st) ? "acc" : "";
      const d = document.createElement("details");
      d.className = "help-issue";
      d.innerHTML = `<summary><span class="pill ${cls}">${esc(st)}</span><b>${m[3]}</b><span class="tag">${esc(m[2].trim())}</span></summary><p>${m[4]}</p>`;
      ul.before(d);
      li.remove();
      if (!ul.children.length) ul.remove();
    });
    toc.innerHTML = secs.map((x) => `<button type="button" data-sec="${x.dataset.sec}">${esc(x.querySelector("h3").textContent)}</button>`).join("");
    $("help-q").value = "";
    spyHelp();
  }
  // 帮助、更新日志共用：目录在哪、正文在哪
  const TOCS = { help: ["help-toc", "help-body"], changelog: ["cl-toc", "cl-body"] };
  function tocSecs(name) { return [...$(TOCS[name][1]).querySelectorAll(".help-sec")].filter((x) => !x.classList.contains("hidden")); }
  function spyHelp() { spyToc("help"); }
  function spyToc(name) {
    const toc = $(TOCS[name][0]), body = $("page-body");
    if (curPage !== name || !toc.children.length) return;
    const narrow = getComputedStyle(toc).flexDirection === "row";
    const top = body.getBoundingClientRect().top + (narrow ? toc.offsetHeight : 0) + 40;
    let cur = null;
    const secs = tocSecs(name);
    for (const x of secs) if (x.getBoundingClientRect().top <= top) cur = x.dataset.sec;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = (secs.at(-1) || {}).dataset?.sec || cur;
    if (!cur) cur = (secs[0] || {}).dataset?.sec;
    toc.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.sec === cur;
      if (on && !b.classList.contains("on")) {
        if (narrow) b.scrollIntoView({ inline: "center", block: "nearest" });
        // 竖排目录比屏幕长（更新日志几十版）：目录自己滚，让当前项留在中间，不带着整页动
        else if (toc.scrollHeight > toc.clientHeight) toc.scrollTop = b.offsetTop - toc.clientHeight / 2;
      }
      b.classList.toggle("on", on);
    });
  }
  // ── 扩展页的页内分区导航：吸顶一排，点了展开并滚到那一节，滚动时高亮当前节 ──
  // 节 = 页里直接挂着的 .ext-sec / .ext-sec-plain（没藏起来的）；名字取标题，计数取标题里的 .pill
  const SUBNAVS = { ext: "ext-subnav" };
  function subnavSecs(name) { return [...$("tab-" + name).querySelectorAll(":scope > .ext-sec, :scope > .ext-sec-plain")].filter((x) => !x.classList.contains("hidden")); }
  function paintSubnav(name) {
    const nav = $(SUBNAVS[name]); if (!nav) return;
    nav.innerHTML = subnavSecs(name).map((x) => {
      const nm = (x.querySelector(":scope > summary > span[data-i18n], :scope > .sec-title > span:last-child") || {}).textContent || "";
      const cnt = ((x.querySelector(":scope > summary .pill, :scope > .sec-title .pill") || {}).textContent || "").split("·")[0].trim();
      return `<button data-sec="${esc(x.dataset.sec)}">${esc(nm)}${cnt ? `<span class="cnt">${esc(cnt)}</span>` : ""}</button>`;
    }).join("");
    spySubnav();
  }
  function spySubnav() {
    const nav = curPage && $(SUBNAVS[curPage]); if (!nav) return;
    const body = $("page-body"), top = body.getBoundingClientRect().top + nav.offsetHeight + 24;
    let cur = null;
    for (const x of subnavSecs(curPage)) if (x.getBoundingClientRect().top <= top) cur = x.dataset.sec;
    if (!cur) cur = (subnavSecs(curPage)[0] || {}).dataset?.sec;
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sec === cur));
  }
  for (const [name, id] of Object.entries(SUBNAVS)) {
    $(id)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sec]"); if (!b) return;
      const x = $("tab-" + name).querySelector(`:scope > [data-sec="${b.dataset.sec}"]`); if (!x) return;
      if (x.tagName === "DETAILS") x.open = true;
      const body = $("page-body");
      body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - $(id).offsetHeight - 10, behavior: "smooth" });
    });
    // 计数、哪节显示都是异步加载出来的：内容一变就重画（下一帧合并；导航自己重画引起的变化不算）
    let raf = 0;
    new MutationObserver((recs) => { if (raf || recs.every((m) => $(id) && $(id).contains(m.target))) return; raf = requestAnimationFrame(() => { raf = 0; if (curPage === name) paintSubnav(name); }); })
      .observe($("tab-" + name), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  }
  // 滚动时高亮：扩展页用分区条，帮助/更新日志用各自的目录
  $("page-body").addEventListener("scroll", () => {
    if (SUBNAVS[curPage]) spySubnav();
    else if (curPage === "help") spyHelp();
    else if (curPage === "changelog") spyToc("changelog");
  }, { passive: true });

  $("help-toc").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    const x = $("help-body").querySelector(`.help-sec[data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body"), toc = $("help-toc");
    const off = getComputedStyle(toc).flexDirection === "row" ? toc.offsetHeight + 8 : 8;
    body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - off, behavior: "smooth" });
  });
  $("help-q").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $("help-body").querySelectorAll(".help-sec").forEach((x) => x.classList.toggle("hidden", !!q && !x.textContent.toLowerCase().includes(q)));
    $("help-body").querySelectorAll(".help-lead").forEach((x) => x.classList.toggle("hidden", !!q));
    $("help-toc").querySelectorAll("button").forEach((b) => b.classList.toggle("hidden", !!q && !!$("help-body").querySelector(`.help-sec.hidden[data-sec="${b.dataset.sec}"]`)));
    spyHelp();
  });
  // ── 更新日志 ── 和 GitHub Releases 同一份（scripts/changelog.mjs 生成 web/changelog/zh|en.json，其余语言用英文）。
  // 第一次点开才取。五十多版、上百 KB：每版只先放标题和一个估了高度的空壳，进到视口上下一屏多的范围才渲染正文，
  // 离远了收回成量好高度的空壳 —— DOM 里任何时候只有眼前那几版。目录、滚动高亮、搜索和帮助页同一套，搜索查原文不用渲染。
  const CL = { lang: "", list: [], low: [], h: [], io: null };
  async function loadChangelog() {
    const lang = /^zh/.test((window.I18N && I18N.lang) || "zh") ? "zh" : "en";
    if (CL.lang === lang) return spyToc("changelog");
    const body = $("cl-body"), toc = $("cl-toc");
    if (CL.io) { CL.io.disconnect(); CL.io = null; }
    toc.innerHTML = "";
    body.innerHTML = `<p class="muted">${esc(t("加载中…"))}</p>`;
    let list;
    try {
      const r = await fetch("/changelog/" + lang + ".json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      list = await r.json();
    } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    CL.lang = lang; CL.list = list; CL.h = []; CL.low = list.map((x) => ("v" + x.v + "\n" + x.md).toLowerCase());
    const cur = ((lastUpd && lastUpd.items) || []).find((x) => x.id === "app")?.current || "";
    // 估高：按这一栏能放几个字折行，再加段落间距；渲染时量出真高，差的那点在 clShow 里补回滚动位置
    const w = Math.max(240, body.clientWidth || 600), cpl = w / (lang === "zh" ? 14.5 : 7.4);
    const est = (md) => Math.round(md.split("\n").reduce((h, l) => h + (l.trim() ? Math.max(1, Math.ceil(l.length / cpl)) * 24.5 : 10), 0));
    body.innerHTML = list.map((x, i) => `<section class="help-sec cl-sec" data-sec="c${i}"><h3><span>v${esc(x.v)}</span>` +
      (x.v === cur ? `<span class="pill acc">${esc(t("当前版本"))}</span>` : "") +
      `<span class="cl-date">${esc(x.date || t("未发布"))}</span></h3><div class="cl-md" data-i="${i}" style="height:${est(x.md)}px"></div></section>`).join("");
    toc.innerHTML = list.map((x, i) => `<button type="button" data-sec="c${i}">v${esc(x.v)}</button>`).join("");
    $("cl-q").value = "";
    CL.io = new IntersectionObserver((ents) => ents.forEach((e) => clShow(e.target, e.isIntersecting)), { root: $("page-body"), rootMargin: "120% 0px" });
    body.querySelectorAll(".cl-md").forEach((el) => CL.io.observe(el));
    spyToc("changelog");
  }
  function clShow(el, on) {
    if (on === !!el.dataset.on) return;
    const pb = $("page-body"), above = el.getBoundingClientRect().top < pb.getBoundingClientRect().top;
    const i = +el.dataset.i, h0 = el.offsetHeight;
    if (on) {
      el.dataset.on = "1";
      setHtml(el, renderMd(CL.list[i].md));
      el.style.height = "";
      if (el.offsetHeight) CL.h[i] = el.offsetHeight;
    } else {
      // 收回：量好的高度留给空壳，滚动条不跳。整页切走 / 被搜索藏起来时量出来是 0，用渲染时记下的
      el.style.height = (h0 || CL.h[i] || 0) + "px";
      if (h0) CL.h[i] = h0;
      el.textContent = "";
      delete el.dataset.on;
    }
    // 视口上方的版本长高 / 变矮了：把差值补给滚动位置，眼前的内容不动。刚从目录跳过来时按目标版本对齐（clPin）
    if (CL.pin) clAlign();
    else if (on && above) pb.scrollTop += el.offsetHeight - h0;
  }
  // 目录跳转后的一小会儿钉住目标：沿途版本陆续渲染、高度和估的不一样，每次都按目标的实际位置重新对齐。手一碰就放开
  function clAlign() {
    const p = CL.pin; if (!p) return;
    const pb = $("page-body");
    pb.scrollTop += p.el.getBoundingClientRect().top - pb.getBoundingClientRect().top - p.off;
  }
  function clPin(el, off) {
    clearTimeout(CL.pinT);
    CL.pin = { el, off };
    clAlign();
    let n = 0;
    const tick = () => { if (!CL.pin) return; clAlign(); if (++n < 8) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    CL.pinT = setTimeout(() => { CL.pin = null; }, 600);
  }
  ["touchstart", "wheel", "keydown"].forEach((ev) => $("page-body").addEventListener(ev, () => { CL.pin = null; }, { passive: true }));
  $("cl-body").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]"); if (!a) return;
    const u = a.getAttribute("href") || "";
    if (!/^https?:\/\//.test(u)) return;
    e.preventDefault();
    if (window.CCApp && CCApp.openUrl) CCApp.openUrl(u); else window.open(u, "_blank", "noopener");
  });
  $("cl-toc").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    const x = $("cl-body").querySelector(`.help-sec[data-sec="${b.dataset.sec}"]`); if (!x) return;
    const toc = $("cl-toc");
    const off = getComputedStyle(toc).flexDirection === "row" ? toc.offsetHeight + 8 : 8;
    // 直接跳，不平滑：一路滑过去会把沿途几十版挨个渲染又收回
    clPin(x, off);
  });
  $("cl-q").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $("cl-body").querySelectorAll(".cl-sec").forEach((x, i) => x.classList.toggle("hidden", !!q && !CL.low[i].includes(q)));
    $("cl-toc").querySelectorAll("button").forEach((b, i) => b.classList.toggle("hidden", !!q && !CL.low[i].includes(q)));
    $("cl-none").classList.toggle("hidden", !q || CL.low.some((x) => x.includes(q)));
    spyToc("changelog");
  });
  $("btn-menu").addEventListener("click", () => { if (!(window.CCLayout && CCLayout.toggleDock())) openDrawer("sessions"); });

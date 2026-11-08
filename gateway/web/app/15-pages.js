  // ── 设置：弹窗。宽屏居中（左分类、右内容）；窄屏铺满，先列分类，点进去看一类，返回键回分类 ──
  var setOpen = false;
  var setCatShown = "-";   // 上次画的是哪一类：null = 窄屏的分类列表，"-" = 刚打开还没画过
  let setFrom = null;
  function openSettings(cat) {
    setFrom = document.activeElement;
    OV.closeAll();
    setOpen = true;
    MO.cancel($("set-ov"));
    $("set-ov").classList.remove("hidden");
    setCatOpen = cat || (pagesNarrow() ? null : setCatOpen || "general");
    loadQuota().catch(() => {});
    paintSetCats();
    renderSideNav();
    closeDrawer();
    // 每次打开设置页都重取设置（loadSettings 里也会重拉厂商和型号）：启动时那一次失败/竞态，
    // 以前就一直显示默认或旧值（195-E.8）
    loadSettings(); loadPriv(); loadUpd(); loadNotify(); loadDev(); loadReconcile(false); loadFonts(); renderTbList(); renderAccent(); renderMsgActs();
    // 焦点进模态：不然键盘 / 读屏还停在被盖住的背景上（审查 P2-12）
    // 窄屏的分类列表没有选中项、关闭键也藏着：落到第一个看得见的控件（审查 #52 P2-12）
    requestAnimationFrame(() => { if (setOpen) focusInto($("set-ov"), $("set-cats").querySelector("button.on:not(.hidden)")); });
  }
  function closeSettings() {
    if (!setOpen) return;
    setOpen = false;
    const ov = $("set-ov");
    MO.leave(ov, ov.classList.contains("narrow") ? "mo-out-push" : "mo-out-fade", 170, () => ov.classList.add("hidden"));
    setCatShown = "-";
    renderSideNav();
    // 焦点还给打开设置前的那个按钮（它还在、看得见的话）
    if ($("set-ov").contains(document.activeElement)) document.activeElement.blur();
    if (setFrom && setFrom.isConnected && setFrom.getClientRects().length) try { setFrom.focus({ preventScroll: true }); } catch {}
    setFrom = null;
  }
  // Esc 关设置（窄屏先回分类列表）；菜单、弹层开着时 OV 在捕获阶段先接走了（审查 P2-12）
  addEventListener("keydown", (e) => { if (e.key === "Escape" && setOpen && !e.defaultPrevented) { e.preventDefault(); setBack(); } });
  // Tab 别跑出模态：挂在 window 上，焦点还在背景时也接得到（审查 #52 P2-12）；上面另开了 OV 弹层时归 OV 管
  // 设置里开着轻菜单（自绘下拉框，OV 记成 menu、不锁 Tab）：焦点在菜单里就在菜单里转，不然锁回设置（#96 01-008）
  addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !setOpen || OV.hasModal()) return;
    const m = OV.top();
    trapTab(m && m.contains(document.activeElement) ? m : $("set-ov"), e);
  }, true);
  // 开关、下拉框没有关联标题，读屏只念「复选框」：挂到同一行的粗体标题上（审查 P2-13）
  document.querySelectorAll("#tab-settings .srow").forEach((row, i) => {
    // 子行只有说明没有粗体标题（保活、开机自启、通知）：挂到那段说明上（审查 #52 P2-13）
    const b = row.querySelector(".sl > b") || row.querySelector(".sl > p"); if (!b) return;
    if (!b.id) b.id = "srow-t" + i;
    row.querySelectorAll(".sc input, .sc select, .sc textarea").forEach((c) => { if (!c.getAttribute("aria-label") && !c.getAttribute("aria-labelledby") && !(c.id && document.querySelector(`label[for="${c.id}"]`))) c.setAttribute("aria-labelledby", b.id); });
  });
  $("set-x").addEventListener("click", closeSettings);
  $("set-back").addEventListener("click", () => setBack());
  $("set-ov").addEventListener("click", (e) => { if (e.target.id === "set-ov") closeSettings(); });
  // 返回：窄屏点进了某一类先回分类列表，否则关掉设置
  function setBack() {
    if (pagesNarrow() && setCatOpen) { setCatOpen = null; paintSetCats(); $("tab-settings").scrollTop = 0; return; }
    closeSettings();
  }
  // ── 页内分区导航（扩展、能力）：吸顶一排，点了展开并滚到那一节，滚动时高亮当前节 ──
  // 节 = 页里直接挂着的 .ext-sec / .ext-sec-plain（没藏起来的）；名字取标题，计数取标题里的 .pill（「3 / 7 · 1.2 GB」只留前半）
  const SUBNAVS = { ext: "ext-subnav" };
  function subnavSecs(name) { return [...$("tab-" + name).querySelectorAll(":scope > .ext-sec, :scope > .ext-sec-plain")].filter((x) => !x.classList.contains("hidden")); }
  function paintSubnav(name) {
    const nav = $(SUBNAVS[name]); if (!nav) return;
    nav.innerHTML = subnavSecs(name).map((x) => {
      const nm = x.dataset.short ? t(x.dataset.short) : (x.querySelector(":scope > summary > span[data-i18n], :scope > summary > span.sec-name, :scope > .sec-title > span:last-child") || {}).textContent || "";
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
    nav.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.sec === cur;
      // 和更新日志的目录一样：一排放不下时，当前节的按钮跟着滚到中间（只滚导航自己，不带动整页）
      if (on && !b.classList.contains("on") && nav.scrollWidth > nav.clientWidth)
        nav.scrollTo({ left: b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2, behavior: "smooth" });
      b.classList.toggle("on", on);
    });
  }
  for (const [name, id] of Object.entries(SUBNAVS)) {
    $(id)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sec]"); if (!b) return;
      const x = $("tab-" + name).querySelector(`:scope > [data-sec="${b.dataset.sec}"]`); if (!x) return;
      if (x.tagName === "DETAILS") x.open = true;
      const body = $("page-body");
      const d = x.getBoundingClientRect().top - body.getBoundingClientRect().top - $(id).offsetHeight - 10;
      if (Math.abs(d) < 24) return;   // 已经在这一节了：再点别挪那几像素（来回一挪就是「抽一下」）
      body.scrollTo({ top: body.scrollTop + d, behavior: "smooth" });
    });
    // 计数、哪节显示都是异步加载出来的：内容一变就重画（下一帧合并；导航自己重画引起的变化不算）
    let raf = 0;
    new MutationObserver((recs) => { if (raf || recs.every((m) => $(id) && $(id).contains(m.target))) return; raf = requestAnimationFrame(() => { raf = 0; if (curPage === name) paintSubnav(name); }); })
      .observe($("tab-" + name), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  }
  $("page-body").addEventListener("scroll", (e) => { if (e.target.scrollLeft) e.target.scrollLeft = 0;   // 页面不许横着挪（overflow-x:hidden 拦不住聚焦时的程序滚动）
    if (SUBNAVS[curPage]) spySubnav(); else if (TOCS[curPage]) spyToc(curPage); pageAnchorSave(); }, { passive: true });

  // ── 换分屏 / 转屏后停在原处 ── 只记 scrollTop 不够：宽度一变整页重排，同样的像素落到别的内容上。
  // 滚动时记下顶上那一行是哪个元素、离顶多远；宽度变了按它对回去
  let pgAnc = null, pgW = 0, pgAncRaf = 0;
  function pageAnchorSave() {
    const body = $("page-body");
    if (body.clientWidth !== pgW || pgAncRaf) return;     // 宽度刚变、还没对回去：这时的滚动是浏览器夹出来的，不算
    pgAncRaf = requestAnimationFrame(() => {
      pgAncRaf = 0;
      if (body.scrollTop < 4) { pgAnc = { top: true }; return; }
      const r = body.getBoundingClientRect();
      // 吸顶的分区导航 / 目录压在最上面，取它们下面那一行
      const skip = body.querySelector(".subnav:not(:empty)");
      const y = r.top + (skip && skip.offsetParent ? skip.offsetHeight : 0) + 12;
      const el = document.elementsFromPoint(r.left + r.width / 2, y).find((n) => body.contains(n) && n !== body && !n.closest(".subnav, .help-toc, .mo-ghost"));
      pgAnc = el ? { el, off: el.getBoundingClientRect().top - r.top } : null;
    });
  }
  new ResizeObserver(() => {
    const body = $("page-body"), w = body.clientWidth;
    if (!w) { pgAnc = null; return; }        // 整页收起了：下次打开从它自己的位置算，别拿旧锚点挪
    if (w === pgW) return;
    const first = !pgW; pgW = w;
    if (first || !pgAnc || !curPage) return;
    if (pgAnc.top) body.scrollTop = 0;
    else if (pgAnc.el.isConnected) body.scrollTop += pgAnc.el.getBoundingClientRect().top - body.getBoundingClientRect().top - pgAnc.off;
  }).observe($("page-body"));


  // ── 设置分类：宽屏左栏分类 + 右边一类的内容；窄屏先是分类列表，点进去才是内容 ──
  var setCatOpen = null;
  const pagesNarrow = () => innerWidth < 680;
  // 各类内容是异步填的：有行显示 / 隐藏就在下一帧重画分类（代替原来打开后固定等 900ms 再画一次）
  let setCatRaf = 0;
  new MutationObserver(() => { if (!setOpen || setCatRaf) return; setCatRaf = requestAnimationFrame(() => { setCatRaf = 0; paintSetCats(); }); })
    .observe($("tab-settings"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  function paintSetCats() {
    paintSetUsage();
    // 回程：换类之前给旧的那一屏留个替身 —— 窄屏往里进时分类列表往左退暗、返回时内容页往右滑走。
    // 宽屏（左边选、右边换）不放动画，直接换（10-27 用户定：交叉淡变不好看，做减法）
    if (setCatShown !== "-" && setCatShown !== setCatOpen && pagesNarrow()) {
      const old = setCatShown ? document.querySelector(`.set-cat[data-cat="${setCatShown}"]:not(.mo-ghost)`) : $("set-cats");
      if (old && old.getClientRects().length) {
        if (setCatOpen) MO.ghost(old, "back", false, document.querySelector(`.set-cat[data-cat="${setCatOpen}"]:not(.mo-ghost)`));
        else MO.ghost(old, "push");
      }
    }
    const narrow = pagesNarrow(), cats = [...document.querySelectorAll("#set-cats [data-cat]")];
    // 一类里一项都没显示（比如开发端没有通知 / 更新）就连分类一起藏起来
    const empty = (k) => ![...document.querySelectorAll(`.set-cat[data-cat="${k}"] > :is(.srow, .sblock)`)].some((f) => !f.classList.contains("hidden"));
    cats.forEach((b) => b.classList.toggle("hidden", empty(b.dataset.cat)));
    if (!narrow && (!setCatOpen || empty(setCatOpen))) setCatOpen = "general";
    $("tab-settings").classList.toggle("set-list", narrow && !setCatOpen);
    $("tab-settings").classList.toggle("set-one", narrow && !!setCatOpen);
    cats.forEach((b) => b.classList.toggle("on", b.dataset.cat === setCatOpen));
    // 每次进「更新」这一类都重新查一遍（不只读上回的结果）；离开再进来才算一次
    if (setCatOpen === "update" && setCatShown !== "update") updOnOpen();
    if (setCatShown !== "-" && setCatShown !== setCatOpen) {
      const cur = setCatOpen && document.querySelector(`.set-cat[data-cat="${setCatOpen}"]`);
      if (narrow) { if (cur) MO.play(cur, "mo-in-push", 1400); else if (!setCatOpen) MO.play($("set-cats"), "mo-in-back", 1400); }
    }
    setCatShown = setCatOpen;
    document.querySelectorAll(".set-cat:not(.mo-ghost)").forEach((c) => c.classList.toggle("hidden", c.dataset.cat !== setCatOpen));
    const cb = cats.find((b) => b.dataset.cat === setCatOpen);
    $("set-title").textContent = narrow && cb ? cb.textContent.trim() : t("设置");
    $("set-ov").classList.toggle("narrow", narrow);
    $("set-back").classList.toggle("hidden", !narrow);
    $("set-x").classList.toggle("hidden", narrow);
  }
  $("set-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    const was = setCatOpen;
    setCatOpen = b.dataset.cat; paintSetCats();
    // 宽屏换类也回到顶上：各类共用一个滚动区，不归零会接着上一类的位置，顶上几项被跳过（审查 SET-02-02）
    if (pagesNarrow()) $("tab-settings").scrollTop = 0;
    else if (was !== setCatOpen) for (let p = document.querySelector(`.set-cat[data-cat="${setCatOpen}"]`); p && p !== document.body; p = p.parentElement) if (p.scrollTop) p.scrollTop = 0;
  });
  addEventListener("resize", () => { if (setOpen) paintSetCats(); });
  // 侧栏常驻项：打开侧栏、展开「更多」、进入勾选
  $("set-navpins").addEventListener("click", () => {
    closeSettings();     // 设置是模态、盖在侧栏上面：不关就勾不着（审查 V-02 / P2-6）
    localStorage.setItem("cc.navMore", "1"); navEdit = true;
    if (!(window.CCLayout && (CCLayout.docked() || CCLayout.expand()))) drawerEl.classList.remove("hidden");
    renderSideNav();
  });
  // 设置里较长的说明默认收成两行，点一下展开 / 收起
  $("tab-settings").addEventListener("click", (e) => {
    const p = e.target.closest(".sl p.clamp"); if (p && !e.target.closest("a, code")) p.classList.toggle("open");
  });
  // 整页从顶栏下沿开始：顶栏高度随安全区 / 手机横屏压缩而变，量出来给 CSS
  new ResizeObserver(() => document.documentElement.style.setProperty("--tbh", $("topbar").getBoundingClientRect().height + "px")).observe($("topbar"), { box: "border-box" });   // 外壳注入 --safe-t 只改内边距，内容盒不变；不看边框盒就漏掉，页面层会压住顶栏


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
    // 只有简体有自己的一份；繁体（zh-Hant）没有译文就按注释回落英文，别再拉成简体（0.6.10 审计 195-L.1）
    const lang = ((window.I18N && I18N.lang) || "zh") === "zh" ? "zh" : "en";
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
    } catch (e) {
      // 只显示原始英文/HTTP 状态，用户既看不懂也没法重试（195-N.8）
      body.innerHTML = `<div class="tiny err">${esc(t("帮助加载失败：{msg}", { msg: e.message }))}</div><div class="it-acts"><button class="btn ghost sm" id="help-retry">${esc(t("重试"))}</button></div>`;
      $("help-retry").onclick = () => { helpLang = ""; loadHelp(); };
      return;
    }
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
  // 点了目录：高亮钉在点的那一节，直到手动滚。不钉的话，最后几节短、滚不到顶，高亮会落到上一节或最后一节（看着像点哪不打哪）
  let tocPin = null;
  ["touchstart", "wheel", "keydown"].forEach((ev) => $("page-body").addEventListener(ev, () => { tocPin = null; }, { passive: true }));
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
    if (tocPin && tocPin.name === name && secs.some((x) => x.dataset.sec === tocPin.sec)) cur = tocPin.sec;
    toc.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.sec === cur;
      if (on && !b.classList.contains("on")) {
        // 横排目录只横着挪自己。别用 scrollIntoView：它会连带去滚整页，把点目录后正在平滑滚的那一下掐断，停在半路
        if (narrow) { const br = b.getBoundingClientRect(), tr = toc.getBoundingClientRect(); toc.scrollBy({ left: br.left + br.width / 2 - tr.left - tr.width / 2 }); }
        // 竖排目录比屏幕长（更新日志几十版）：目录自己滚，让当前项留在中间，不带着整页动
        else if (toc.scrollHeight > toc.clientHeight) toc.scrollTop = b.offsetTop - toc.clientHeight / 2;
      }
      b.classList.toggle("on", on);
    });
  }
  $("help-toc").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    const x = $("help-body").querySelector(`.help-sec[data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body"), toc = $("help-toc");
    const off = getComputedStyle(toc).flexDirection === "row" ? toc.offsetHeight + 8 : 8;
    tocPin = { name: "help", sec: b.dataset.sec };
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
    // 同帮助页：繁体没有单独一份，回落英文（0.6.10 审计 195-L.1）
    const lang = ((window.I18N && I18N.lang) || "zh") === "zh" ? "zh" : "en";
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
    } catch (e) {
      // 和帮助页同一口径：说清楚是哪一步失败，并给重试（195-N.8）
      body.innerHTML = `<div class="tiny err">${esc(t("更新日志加载失败：{msg}", { msg: e.message }))}</div><div class="it-acts"><button class="btn ghost sm" id="cl-retry">${esc(t("重试"))}</button></div>`;
      $("cl-retry").onclick = () => { CL.lang = ""; loadChangelog(); };
      return;
    }
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
    tocPin = { name: "changelog", sec: b.dataset.sec };
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

  // ── Shizuku ──
  const PRIV_TEXT = {
        not_installed: ["warn", t("没装 Shizuku")],
        not_running: ["warn", t("Shizuku 已安装，但服务没在运行（重启手机后需要在 Shizuku 里重新启动）")],
        no_permission: ["warn", t("Shizuku 在运行，还没授权给 cccodroid")],
        unreachable: ["err", t("连不上应用的后台服务")],
  };
  const SETUP_BUSY = ["downloading", "installing", "connecting", "pairing", "starting", "permission"];
  let privPoll = null;
  // 各家系统里"允许后台运行"的位置。红魔/中兴为实测，其余是常见路径
  const BG_HOW = {
        nubia: t("红魔 / 努比亚：应用信息 → 应用的电池用量 → 电池优化 → <b>后台运行：允许</b>（<b>自启动</b>也选允许，开机激活 Shizuku、更新后自动恢复都靠它）"),
        zte: t("中兴：应用信息 → 应用的电池用量 → 电池优化 → <b>后台运行：允许</b>，<b>自启动：允许</b>"),
        xiaomi: t("小米 / 红米：应用信息 → <b>省电策略：无限制</b>，<b>自启动</b>打开（常见路径，可能因系统版本不同）"),
        redmi: t("小米 / 红米：应用信息 → <b>省电策略：无限制</b>，<b>自启动</b>打开（常见路径，可能因系统版本不同）"),
        oppo: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        oneplus: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        realme: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        vivo: t("vivo / iQOO：设置 → 电池 → 后台耗电管理 → cccodroid <b>允许后台高耗电</b>；i管家里允许<b>自启动</b>（常见路径）"),
        huawei: t("华为 / 荣耀：设置 → 应用启动管理 → cccodroid 关闭「自动管理」，手动允许<b>自启动</b>和<b>后台活动</b>（常见路径）"),
        honor: t("华为 / 荣耀：设置 → 应用启动管理 → cccodroid 关闭「自动管理」，手动允许<b>自启动</b>和<b>后台活动</b>（常见路径）"),
  };
  function renderBg(fz) {
    const show = fz && fz.count > 0;
    $("bg-field").classList.toggle("hidden", !show);
    if (!show) return;
        $("bg-state").textContent = t("检测到 cccodroid 在后台被系统冻结过 {n} 次（最近一次约 {sec} 秒，{at}）。", { n: fz.count, sec: Math.round(fz.ms / 1000), at: new Date(fz.at).toLocaleString() }) +
      t("冻结期间网关和正在跑的任务全部停住，回到前台才继续。前台服务挡不住这类厂商冻结器。");
    $("bg-how").innerHTML = BG_HOW[fz.vendor] || t("在系统设置里给 cccodroid 允许后台运行、关闭电池优化、允许自启动（各家叫法不同）。");
  }
  $("bg-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === "appsettings") post("/api/app/open_app_settings").catch(() => {});
    if (act === "ack") { const st = await post("/api/app/freeze_ack").catch(() => null); if (st) renderBg(st.frozen); }
  });

  async function loadPriv() {
    let st;
    try { st = await api("/api/priv/status"); } catch { return; }
    if (st.state === "unsupported") return;          // 旧版：没有这项集成
    renderBg(st.frozen);
    $("priv-field").classList.remove("hidden");
    const el = $("priv-state");
    if (st.state === "ok") {
      el.className = "prov-state ok";
      el.textContent = t("✓ 已就绪 · 以 {who} 身份执行", { who: st.uid === 0 ? "root" : st.uid === 2000 ? "shell" : "uid " + st.uid }) + (st.version ? " · Shizuku v" + st.version : "");
    } else {
      const [cls, txt] = PRIV_TEXT[st.state] || ["err", st.message || t("状态未知")];
      el.className = "prov-state " + cls;
      el.textContent = txt + (st.lastPermission === "denied" ? t("（上次被拒绝了）") : "");
    }
    // 一键安装 / 激活的进度
    const su = st.setup || { phase: "idle" };
    const busy = SETUP_BUSY.includes(su.phase);
    const se = $("priv-setup");
    const showSetup = su.message && !(st.state === "ok" && su.phase !== "done");
    se.classList.toggle("hidden", !showSetup);
    if (showSetup) {
      se.className = "prov-state " + (su.phase === "error" ? "err" : su.phase === "done" ? "ok" : "warn");
      se.textContent = su.message + (su.phase === "downloading" && su.total ? `（${fmtSize(su.done) || "0 MB"} / ${fmtSize(su.total)}）` : "");
    }
    $("priv-pair").classList.toggle("hidden", su.phase !== "pairing");
    const wl = st.wireless !== false;
    $("priv-actions").innerHTML =
      st.state === "not_installed" ? `<button class="btn sm" data-act="activate" ${busy ? "disabled" : ""}>${t("一键安装并激活")}</button>
        <a class="btn sm ghost" href="https://shizuku.rikka.app/download/" target="_blank" rel="noopener">${t("手动下载")} ↗</a>` :
      st.state === "not_running" ? (wl ? `<button class="btn sm" data-act="activate" ${busy ? "disabled" : ""}>${t("一键激活（无线调试）")}</button>` : "") +
        `<button class="btn sm ghost" data-act="open">${t("打开 Shizuku")}</button>` :
      st.state === "no_permission" ? `<button class="btn sm" data-act="request">${t("授权给 cccodroid")}</button>` : "";
    // Shizuku 在跑，但没有（或已失效的）无线调试配对：重启后就没法自动激活。这种情况平时看不出来，主动提示
    if (st.state === "ok" && wl && !st.paired && !busy) {
      se.classList.remove("hidden");
      se.className = "prov-state warn";
      se.textContent = st.pairOk === 0
                ? t("无线调试里 cccodroid 的配对已被取消：现在还能用，但重启手机后没法自动激活。")
        : t("Shizuku 不是由 cccodroid 激活的：重启手机后 cccodroid 没法自动激活它。配对一次即可。");
      $("priv-actions").insertAdjacentHTML("afterbegin", `<button class="btn sm" data-act="repair">${st.pairOk === 0 ? t("重新配对") : t("配对")}</button>`);
    }
    // 说的是「这次开机」，允许了自启动也要等下次开机才会消失；点「已允许」就收起到下次开机
    if (st.bootMissed && !(st.bootAt && Math.abs(st.bootAt - (+localStorage.getItem("cc.bootAck") || 0)) <= 1)) {
      se.classList.remove("hidden");
      se.className = "prov-state warn";
      se.textContent = t("这次开机系统没通知 cccodroid（被系统的「自启动」管理拦了），所以开机没能自动激活；打开 cccodroid 时会补上。") +
        t("想开机就激活：在应用详情里允许 cccodroid 自启动 / 后台启动，下次开机生效。");
      $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="appsettings">${t("去允许自启动")}</button>` +
        (st.bootAt ? `<button class="btn sm ghost" data-act="bootack" data-boot="${st.bootAt}">${t("已允许，下次开机再看")}</button>` : ""));
    }
    if (st.dev) {                                     // 开发端：Shizuku 由它自己的应用管理，这里只报实测状态
      $("priv-actions").innerHTML = "";
      if (st.state !== "ok") {
        se.classList.remove("hidden");
        se.className = "prov-state warn";
        se.textContent = t("在 Shizuku 应用里启动服务（建议开「开机启动（无线调试）」），并确认已授权给本应用。") + (st.message ? "（" + st.message + "）" : "");
      }
    }
    $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="refresh">${t("刷新")}</button>` +
      (st.dev ? "" : `<button class="btn sm ghost" data-act="audit">${t("特权命令记录")}</button>`));
    $("priv-auto-row").classList.toggle("hidden", !(wl && st.paired));
    $("priv-auto").checked = st.autostart !== false;
    $("priv-ka-row").classList.toggle("hidden", !!st.dev);
    $("priv-ka-row").style.opacity = st.state === "ok" ? "1" : ".45";
    $("priv-ka").disabled = st.state !== "ok";
    $("priv-ka").checked = !!st.keepalive;
    // 安装、配对、启动都在进行时自己刷新（设置页开着才刷）
    clearTimeout(privPoll);
    if (busy && pageOn("settings")) privPoll = setTimeout(loadPriv, 1500);
  }
  // 经 priv 执行过的命令（谁发起、命令、退出码、用时）。再点一次收起
  const privBy = (k) => ({ claude: "Claude", terminal: t("终端"), gateway: "cccodroid", "cc-mem": t("内存管家"), other: t("其他") })[k] || k;
  async function togglePrivAudit() {
    const box = $("priv-audit");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.textContent = t("加载中…");
    try {
      const r = await api("/api/priv/audit");
      if (!r.items.length) { box.innerHTML = `<div class="tiny">${t("还没有经 priv 执行过命令")}</div>`; return; }
      const two = (n) => String(n).padStart(2, "0");
      box.innerHTML = `<div class="tiny" style="margin-bottom:6px">${t("最近 {n} 条（最新的在前）。只记在本机，不上传。", { n: r.items.length })}</div>` +
        r.items.map((x) => {
          const d = new Date(x.t);
          const when = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
          return `<div class="audit-row${x.rc ? " bad" : ""}"><span class="audit-meta">${when} · ${esc(privBy(x.by))} · rc=${x.rc}${x.ms >= 1000 ? " · " + (x.ms / 1000).toFixed(1) + "s" : ""}</span><code>${esc(x.cmd)}</code></div>`;
        }).join("");
    } catch (e) { box.textContent = e.message; }
  }
  $("priv-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "open") await post("/api/priv/open").catch(() => {});
    if (act === "appsettings") return post("/api/app/open_app_settings").catch(() => {});
    if (act === "audit") return togglePrivAudit();
    // 原地换成一句确认、不重排：整段收起会让下面的开关挪到手指底下被误点。下次打开设置页才真正消失
    if (act === "bootack") { localStorage.setItem("cc.bootAck", e.target.dataset.boot); $("priv-setup").textContent = t("好的，下次开机后再检查。"); e.target.disabled = true; return; }
    if (act === "repair") { await post("/api/app/shz_repair").catch((e2) => toast(e2.message, true)); return setTimeout(loadPriv, 500); }
    if (act === "activate") { await post("/api/app/shz_activate").catch((e2) => toast(e2.message, true)); return setTimeout(loadPriv, 500); }
    if (act === "request") {
      const r = await post("/api/priv/request").catch((e2) => ({ message: e2.message }));
      toast(r.message || t("已请求"));
      // 授权对话框在 Shizuku 那边弹，回来后多刷几次
      for (let i = 0; i < 10; i++) { await new Promise((ok) => setTimeout(ok, 1500)); await loadPriv(); if ($("priv-state").classList.contains("ok")) break; }
      return;
    }
    loadPriv();
  });
  $("priv-pair").addEventListener("click", async (e) => {
    if (!(e.target.dataset && e.target.dataset.act === "pair")) return;
    const code = $("priv-code").value.replace(/\D/g, "");
    if (code.length !== 6) return toast(t("配对码是 6 位数字"), true);
    const port = $("priv-port").value.replace(/\D/g, "");
    $("priv-code").value = "";
    await post("/api/app/shz_pair", { code: port ? code + " " + port : code }).catch((e2) => toast(e2.message, true));
    setTimeout(loadPriv, 500);
  });
  $("priv-auto").addEventListener("change", (e) => post("/api/app/shz_autostart", { enable: e.target.checked }).catch(() => {}));

  // ── 更新：应用本体 / 开发工具包 / Claude Code ──
    const UPD_TEXT = { uptodate: t("已是最新"), available: t("有新版本"), downloading: t("下载中"), ready: t("已下载，待安装"), installing: t("安装中"), error: t("出错"), unknown: t("未检查"), verifying: t("校验中"), damaged: t("已损坏"), missing: t("未安装") };
  let updPoll = null;
  let updFollowUntil = 0;
  const followUpd = () => { updFollowUntil = Date.now() + 15000; };
  let lastUpd = {};
  // 升级工具包时留下的旧程序（网关启动时隔离到 files/orphans-<日期>/，14 天后自动删）：有就提一句，给个立即删
  async function loadOrphans() {
    const r = await api("/api/orphans").catch(() => null);
    const el = $("upd-orphans");
    const n = r && r.ok ? r.dirs.reduce((a, d) => a + d.count, 0) : 0;
    el.classList.toggle("hidden", !n);
    if (!n) return;
    const bytes = r.dirs.reduce((a, d) => a + d.bytes, 0);
    el.innerHTML = `<div class="row-actions" style="justify-content:space-between">
      <span class="tiny">${esc(t("旧工具包留下的 {n} 个程序（{size}）已隔离，{d} 天后自动删除。", { n, size: fmtSize(bytes), d: r.ttlDays }))}</span>
      <button class="btn sm ghost danger" id="orphans-purge">${t("立即删除")}</button></div>`;
    $("orphans-purge").onclick = async () => {
      if (!confirm(t("立即删除隔离的 {n} 个旧程序？删了就找不回来了。", { n }))) return;
      const x = await post("/api/orphans/purge", {}).catch((e2) => ({ ok: false, message: e2.message }));
      toast(x.ok ? t("已删除 {n} 个", { n: x.removed }) : x.message, !x.ok);
      loadOrphans();
    };
  }
  async function loadUpd() {
    let st;
    try { st = await api("/api/app/upd_status"); } catch { return; }
    if (!st.ok || !st.items) return;                 // 旧版 / 开发端：没有这项
    lastUpd = st;
    $("upd-field").classList.remove("hidden");
    $("upd-auto").checked = !!st.auto;
    $("upd-channel").value = st.channel === "pinned" ? "pinned" : st.channel || "stable";
    // 安装包方案（28 / 36）：老外壳没有这几个字段就不显示
    $("upd-flavor-row").classList.toggle("hidden", !st.flavor);
    if (st.flavor) {
      $("upd-flavor").value = st.flavorPref || "auto";
      let now = t("现在装的是 targetSdk {n}", { n: st.flavor });
      if (st.wantFlavor && st.wantFlavor !== st.flavor) now += " · " + t("下次更新换成 targetSdk {n}", { n: st.wantFlavor });
      if (st.only36) now += " · " + t("系统已不让装 targetSdk 28，只能用 36");
      $("upd-flavor-now").textContent = now;
    }
    $("upd-channel").querySelector("option[value=pinned]").textContent = st.channel === "pinned" && st.pin ? t("CLI：固定 {v}", { v: st.pin }) : t("CLI：固定版本…");
    let moving = st.checking;
    $("upd-items").innerHTML = st.items.map((it) => {
      const busy = it.state === "downloading" || it.state === "installing" || it.state === "verifying";
      moving ||= busy;
      const ver = esc(it.current || "?") + (it.latest && it.latest !== it.current && it.state !== "uptodate" ? " → " + esc(it.latest) : "");
      const prog = it.state === "downloading" && it.total ? `（${fmtSize(it.done) || "0 MB"} / ${fmtSize(it.total)} · ${Math.floor(it.done * 100 / it.total)}%）`
        : (it.state === "installing" || it.state === "verifying") && it.total ? `（${Math.floor(it.done * 100 / it.total)}%）` : "";
      const cls = it.state === "error" || it.state === "damaged" || it.state === "missing" ? "err" : it.state === "uptodate" ? "ok" : it.state === "unknown" ? "" : "warn";
      const btn = it.state === "missing" ? t("安装…") : it.state === "available" ? (it.id === "claude" ? t("更新") : t("下载并安装"))
        : it.state === "ready" ? t("安装") : it.state === "damaged" ? t("修复") : it.state === "error" && it.latest ? t("重试") : "";
      // 工具包：随时可以逐个核对文件；坏了就「修复」（重装同一版本）
      const act = it.state === "damaged" ? "repair" : it.state === "missing" ? "pick" : "";
      const verifyBtn = it.id === "devkit" && it.current && ["uptodate", "unknown", "error", "damaged"].includes(it.state)
        ? `<button class="btn sm ghost" data-item="devkit" data-act="verify">${t("校验")}</button>` : "";
      // 从本地文件装（离线、或者已经用电脑下好了）：外壳弹系统文件选择器，认身份、替换都在外壳里做
      const localBtn = it.id === "devkit" && !busy && window.CCApp && CCApp.pickDevkit
        ? `<button class="btn sm ghost" data-item="devkit" data-act="local" title="${esc(t("选一个已经下好的工具包文件来安装"))}">${t("本地文件…")}</button>` : "";
      // 卸载：工具包回到首装（重选来源和模块）、Claude Code 重新下载；外壳做，老外壳没有这个接口就不显示
      const unBtn = (it.id === "devkit" || it.id === "claude") && it.current && !busy && window.CCApp && CCApp.uninstall
        ? `<button class="btn sm ghost danger" data-item="${it.id}" data-act="uninstall">${t("卸载")}</button>` : "";
      const verBtn = it.id === "claude" && it.current && !busy
        ? `<button class="btn sm ghost" data-item="claude" data-act="versions">${t("版本…")}</button>` : "";
      return `<div class="row-actions" style="justify-content:space-between">
        <div><b>${esc(it.name)}</b> <span class="tiny">${ver}</span><br>
          <span class="prov-state ${cls}" style="margin:0">${UPD_TEXT[it.state] || esc(it.state)}${prog}${it.message ? " · " + esc(it.message) : ""}</span></div>
        <div class="row-actions">${verifyBtn}${localBtn}${verBtn}${unBtn}${btn ? `<button class="btn sm" data-item="${esc(it.id)}"${act ? ` data-act="${act}"` : ""}>${btn}</button>` : ""}</div></div>`;
    }).join("");
    const v = st.verify;
    if (v && v.manifest && (v.missing || v.changed) && (v.samples || []).length)
      $("upd-items").insertAdjacentHTML("beforeend", `<pre class="tiny mono" style="white-space:pre-wrap;margin:6px 0 0;color:var(--fg3)">${esc(v.samples.join("\n"))}${v.missing + v.changed > v.samples.length ? "\n…" : ""}</pre>`);
    loadOrphans();
    $("upd-last").textContent = st.checking ? t("检查中…") : st.error ? "✗ " + st.error
      : st.lastCheck ? t("上次检查：{at}", { at: new Date(st.lastCheck).toLocaleString() }) : t("还没检查过");
    clearTimeout(updPoll);
    // 点完按钮 / 换完渠道后的一小段时间也接着刷：后台的检查、换版本要过一会儿才开始，只看「正在进行」会漏掉结果
    if ((moving || st.checking || Date.now() < updFollowUntil) && pageOn("settings")) updPoll = setTimeout(loadUpd, 1500);
  }
  /** Claude Code 版本选单：跟随 stable / latest，或固定到某一版（固定后自动更新、检查更新都不动它） */
  async function openClaudeVersions() {
    if ($("ccv-pick")) return;
    const it = ((lastUpd && lastUpd.items) || []).find((x) => x.id === "claude") || {};
    const mode = (lastUpd && lastUpd.channel) || "stable", pin = (lastUpd && lastUpd.pin) || "";
    const m = document.createElement("div");
    m.id = "ccv-pick";
    m.innerHTML = `<div class="sheet-panel mp-panel">
      <div class="mp-head"><b>${t("Claude Code 版本")}</b><button class="mp-x" type="button" aria-label="${t("关闭")}">${uiI("x")}</button></div>
      <div class="mp-lbl">${t("跟随渠道（自动更新跟着它走）")}</div><div class="ccv-ch"><div class="tiny">${t("读取中…")}</div></div>
      <div class="mp-lbl">${t("固定到某一版（自动更新不再改它）")}</div>
      <label class="searchbox mp-sb"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input class="mp-q" type="search" inputmode="decimal" autocomplete="off" placeholder="${t("搜索版本号")}"></label>
      <div class="mp-list"><div class="tiny">${t("读取中…")}</div></div>
      <div class="tiny mp-note">${t("登录、会话和设置不受影响；版本越旧，越可能缺新功能。")}</div>
      <div class="tiny mp-note">${t("「已验证」：维护者在真机上跑过这一版（下载、调用工具、接着上次的会话）。标了「有已知问题」的版本，自动更新不会装。")}</div></div>`;
    OV.open(m, { kind: "modal", keep: true, cover: true });
    const close = () => OV.close(m);
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest(".mp-x")) close(); });
    let info;
    try { info = await api("/api/claude/versions?lang=" + encodeURIComponent(I18N.lang || "zh")); } catch (e) { info = { ok: false, message: e.message, versions: [] }; }
    if (!m.isConnected) return;
    const chBox = m.querySelector(".ccv-ch"), list = m.querySelector(".mp-list"), q = m.querySelector(".mp-q");
    const ver = info.verified || {}, bad = info.bad || {};
    // 验证状态：验过的写上在哪台设备上验的；有问题的给出原因（维护者经 cccodroid.net 发布的签名记录，见 gw/ccverified.mjs）
    const vTip = (v) => ver[v] ? t("真机验证过：{who}", { who: ver[v].map((r) => `${r.device} · Android ${r.android}（${r.at}）`).join("；") }) : "";
    // 标记后面直接写在哪台设备上验的（手机上长按看不到 title）：第一台 + 「等 N 台」
    const okMark = (v) => `<b class="ccv-ok">${t("已验证")}</b> · ${esc(`${ver[v][0].device} · Android ${ver[v][0].android}`)}${ver[v].length > 1 ? " " + esc(t("等 {n} 台", { n: ver[v].length })) : ""}`;
    const badLine = (v) => bad[v] ? `<small class="ccv-bad">${esc(t("有已知问题：{why}", { why: bad[v].text }) + (bad[v].fixed ? " · " + t("{v} 已修", { v: bad[v].fixed }) : ""))}</small>` : "";
    const chRow = (ch, v, sub) => `<button type="button" class="mp-item${mode === ch ? " cur" : ""}" data-ch="${ch}"${vTip(v) ? ` title="${esc(vTip(v))}"` : ""}><span>${t("跟随 {ch}", { ch })}${v ? " · " + esc(v) : ""}</span><small>${esc(sub)}${v && ver[v] ? " · " + okMark(v) : v && !bad[v] ? " · " + t("还没验证") : ""}</small>${badLine(v)}</button>`;
    chBox.innerHTML = chRow("stable", info.stable, t("官方稳定渠道")) + chRow("latest", info.latest, t("最新发布，比 stable 新，也可能没那么稳"));
    const tags = (v) => [v === info.stable ? "stable" : "", v === info.latest ? "latest" : "", v === it.current ? t("当前装的") : "", mode === "pinned" && v === pin ? t("已固定") : ""].filter(Boolean).join(" · ");
    const paint = () => {
      const kw = q.value.trim();
      const vs = (info.versions || []).filter((v) => !kw || v.includes(kw));
      list.innerHTML = vs.slice(0, 200).map((v) => {
        const tg = esc(tags(v)), ok = ver[v] ? okMark(v) : "";
        return `<button type="button" class="mp-item${mode === "pinned" && v === pin ? " cur" : ""}" data-v="${esc(v)}"${vTip(v) ? ` title="${esc(vTip(v))}"` : ""}><span>${esc(v)}</span>${tg || ok ? `<small>${[tg, ok].filter(Boolean).join(" · ")}</small>` : ""}${badLine(v)}</button>`;
      }).join("")
        || `<div class="tiny">${info.versions && info.versions.length ? t("没有匹配的版本") : esc(info.message || t("取不到版本列表"))}</div>`;
    };
    paint();
    q.addEventListener("input", paint);
    m.querySelector(".mp-panel").addEventListener("click", async (e) => {
      const b = e.target.closest(".mp-item");
      if (!b) return;
      const ch = b.dataset.ch || "pinned", v = b.dataset.v || "";
      if (ch === mode && (ch !== "pinned" || v === pin) && it.state !== "missing") { close(); toast(t("已经是这个设置")); return; }
      const target = ch === "pinned" ? v : info[ch];
      if (target && bad[target] && !confirm(t("{v} 有已知问题：{why}\n\n仍然换到这一版？", { v: target, why: bad[target].text }))) return;
      close();
      const r = await post("/api/app/upd_set", ch === "pinned" ? { channel: ch, version: v } : { channel: ch }).catch((e2) => ({ ok: false, message: e2.message }));
      // 卸载过（未安装）：改设置不会自动装回，要再明说装一次
      if (it.state === "missing" && r.ok !== false) {
        const r2 = await post("/api/app/upd_apply", { item: "claude", version: ch === "pinned" ? v : ch }).catch((e2) => ({ ok: false, message: e2.message }));
        toast(r2.message || (r2.ok ? t("开始") : t("失败")), !r2.ok);
      } else toast(r.ok === false ? (r.message || t("失败")) : ch === "pinned" ? t("已固定到 {v}，正在切换", { v }) : t("已改为跟随 {ch}", { ch }), r.ok === false);
      followUpd(); setTimeout(loadUpd, 500);
    });
  }
  $("upd-items").addEventListener("click", async (e) => {
    const item = e.target.dataset && e.target.dataset.item;
    if (!item) return;
    const act = e.target.dataset.act;
    if (act === "pick" || act === "versions") { openClaudeVersions(); return; }   // 卸载后重装、平时换版本：都走版本选单
    if (act === "uninstall") {
      const msg = item === "devkit"
        ? t("卸载开发工具包？\n\n会删掉整个工具包，连同装在里面的组件、加装的模块、你用 pip / npm -g / pkg 装的东西，然后回到首次安装，重新选下载来源和模块。\n\n会话、工作区、登录和设置都保留。正在跑的终端会被关掉。")
        : t("卸载 Claude Code？\n\n删掉已下载的 Claude Code 程序，之后不会自动装回。要用时在这里点「安装…」，自己选版本（stable、latest 或具体版本号）。\n\n登录、会话和设置都保留；没装的时候发消息会提示先安装。");
      if (!confirm(msg)) return;
      CCApp.uninstall(item);
      return;
    }
    if (act === "local") {
      if (!confirm(t("从本地文件安装开发工具包？\n\n选一个 devkit-cc.codroid.tar.gz（或 .tar），可以在 GitHub 发布页或 cccodroid.net 下载。装之前会核对它是不是已发布的版本；装的时候暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
      CCApp.pickDevkit();
      return;
    }
    if (act === "verify" || act === "repair") {
      if (act === "repair" && !confirm(t("修复开发工具包？\n\n会重新下载当前这一版你装着的部分（断点续传）并重装，装的时候暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
      const r = await post(act === "verify" ? "/api/app/upd_verify" : "/api/app/upd_repair", { full: true }).catch((e2) => ({ ok: false, message: e2.message }));
      toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
      followUpd(); setTimeout(loadUpd, 500);
      return;
    }
    if (item === "devkit" && !confirm(t("更新开发工具包？\n\n要下多少见这一项旁边标的大小（断点续传），装的时候会暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
    const r = await post("/api/app/upd_apply", { item }).catch((e2) => ({ ok: false, message: e2.message }));
    toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
    followUpd(); setTimeout(loadUpd, 500);
  });
  // ── 通知（只有 cccodroid：GatewayService 订阅事件流发通知）──
  async function loadNotify() {
    let st;
    try { st = await api("/api/app/notify_status"); } catch { return; }
    if (!st.ok) return;                              // 开发端 / 旧版：没有这项
    $("ntf-field").classList.remove("hidden");
    $("ntf-done").checked = !!st.done;
    $("ntf-ask").checked = !!st.ask;
    // 系统层面关掉了（整个应用 / 单个渠道）：开关开着也收不到，说清楚并给个入口
    const off = !st.system ? t("系统设置里关掉了本应用的通知，上面的开关不起作用。")
      : (st.ask && !st.chAsk) || (st.done && !st.chDone) ? t("系统设置里关掉了其中一类通知（「等你确认」或「任务完成」）。") : "";
    $("ntf-off").textContent = off;
    $("ntf-off").classList.toggle("hidden", !off);
    $("ntf-actions").classList.toggle("hidden", !off);
  }
  for (const k of ["done", "ask"])
    $("ntf-" + k).addEventListener("change", (e) => post("/api/app/notify_set", { [k]: e.target.checked }).then(loadNotify).catch(() => {}));
  $("ntf-sys").addEventListener("click", () => post("/api/app/notify_settings").catch(() => {}));

  // ── 设备工具（只有 cccodroid：DeviceTools.java + A11y.java，经 device-mcp.mjs 给 Claude）──
  const devName = (n) => ({
    device_status: t("设备状态"), notify: t("发通知"), clipboard_read: t("读剪贴板"), clipboard_write: t("写剪贴板"),
    open: t("打开应用 / 链接 / 日历…"), share_file: t("分享文件"), app_list: t("已装应用列表"),
    screen_read: t("读屏"), screen_tap: t("点按"), screen_swipe: t("滑动 / 滚动"), screen_type: t("输入文字"), screen_key: t("返回 / 主页等按键"), screenshot: t("截屏"),
  })[n] || n;
  function devRender(st) {
    $("dev-field").classList.remove("hidden");
    $("dev-on").checked = !!st.on;
    const box = $("dev-tools");
    box.replaceChildren();
    for (const tl of st.tools || []) {
      const l = document.createElement("label");
      l.className = "tiny";
      l.style.cssText = "display:flex;gap:6px;align-items:center";
      l.innerHTML = `<input type="checkbox" style="width:auto;margin:0"${tl.enabled ? " checked" : ""}${st.on ? "" : " disabled"}><span>${esc(devName(tl.name))}</span>`;
      l.firstChild.addEventListener("change", (e) => post("/api/app/dev_set", { tool: tl.name, enabled: e.target.checked }).then(devRender).catch(() => {}));
      box.appendChild(l);
    }
    const a = st.a11y || {};
    $("dev-a11y").value = a.mode || "off";
    $("dev-a11y").disabled = !st.on;
    $("dev-idle").value = a.idle || 10;
    $("dev-idle-row").classList.toggle("hidden", a.mode !== "auto");
    const s = $("dev-a11y-state");
    s.className = "prov-state " + (a.connected ? "ok" : a.mode === "off" ? "" : "warn");
    s.textContent = a.connected ? t("无障碍服务：已连接") : a.mode === "off" ? t("无障碍服务：关") : t("无障碍服务：现在没开（用到时再开）");
    // 自己开不了（没 WRITE_SECURE_SETTINGS）时，只能让用户去系统设置里开；安卓 13+ 侧载的应用还要先「允许受限设置」
    $("dev-a11y-how").textContent = a.mode !== "off" && !a.canToggle
      ? t("还没激活 Shizuku，应用没法自己开关无障碍：去系统无障碍设置里手动打开 cccodroid。安卓 13 起，侧载的应用要先在 应用信息 → 右上角菜单 → 允许受限设置。")
      : "";
    if (st.message) toast(st.message, true);
  }
  async function loadDev() {
    let st;
    try { st = await api("/api/app/dev_status"); } catch { return; }
    if (!st.ok) return;
    devRender(st);
  }
  $("dev-on").addEventListener("change", (e) => post("/api/app/dev_set", { on: e.target.checked }).then(devRender).catch(() => {}));
  $("dev-a11y").addEventListener("change", (e) => post("/api/app/dev_set", { a11y: e.target.value }).then(devRender).catch((e2) => toast(e2.message, true)));
  $("dev-idle").addEventListener("change", (e) => post("/api/app/dev_set", { idle: Number(e.target.value) || 10 }).then(devRender).catch(() => {}));
  $("dev-a11y-sys").addEventListener("click", () => post("/api/app/a11y_settings").catch(() => {}));

  // 打开更新页时自动查一次：正在查、正在下/装，或 20 秒内刚查过就只刷新显示
  async function updOnOpen() {
    await loadUpd();
    const busy = (lastUpd.items || []).some((it) => ["downloading", "installing", "verifying"].includes(it.state));
    if (lastUpd.checking || busy || Date.now() - (lastUpd.lastCheck || 0) < 20000) return;
    await post("/api/app/upd_check").catch(() => {});
    followUpd(); setTimeout(loadUpd, 300);
  }
  $("upd-check").addEventListener("click", async () => {
    await post("/api/app/upd_check").catch((e2) => toast(e2.message, true));
    followUpd(); setTimeout(loadUpd, 300);
  });
  $("upd-flavor").addEventListener("change", async (e) => {
    const v = e.target.value;
    if (v !== "auto" && lastUpd && v !== lastUpd.flavor &&
        !confirm(t("换成 targetSdk {n} 的安装包？\n\n会下载同一版本的另一套安装包（约 14 MB）覆盖安装，对话、设置、工具包都保留。安装时应用会重启一次。", { n: v }))) {
      e.target.value = (lastUpd && lastUpd.flavorPref) || "auto"; return;
    }
    const r = await post("/api/app/upd_set", { flavor: v }).catch((e2) => ({ ok: false, message: e2.message }));
    if (r.refused) alert(r.message);
    else if (r.ok === false) toast(r.message, true);
    followUpd(); loadUpd();
  });
  $("upd-auto").addEventListener("change", (e) => post("/api/app/upd_set", { auto: e.target.checked }).then(loadUpd).catch(() => {}));
  $("upd-channel").addEventListener("change", (e) => {
    // 固定版本要先挑一版：开选单，下拉框先退回原样，挑完 loadUpd 会刷新成「固定 x.y.z」
    if (e.target.value === "pinned") { e.target.value = (lastUpd && lastUpd.channel) || "stable"; openClaudeVersions(); return; }
    followUpd(); post("/api/app/upd_set", { channel: e.target.value }).then(loadUpd).catch(() => {});
  });
  $("priv-ka").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on && !confirm(t("开启后台保活增强？\n\n会改几项系统设置：幽灵进程上限（影响所有应用）、本应用的电池白名单与后台运行限制。关掉开关会恢复前两项。"))) {
      e.target.checked = false; return;
    }
    const out = $("priv-ka-result");
    out.className = "prov-state"; out.textContent = on ? t("正在应用…") : t("正在恢复…");
    const r = await post("/api/priv/keepalive", { enable: on }).catch((e2) => ({ ok: false, message: e2.message }));
    out.className = "prov-state " + (r.ok ? "ok" : "err");
    out.textContent = r.ok
            ? (on ? t("✓ 已应用") + (r.phantom ? t("（幽灵进程上限 {n}）", { n: r.phantom }) : "") : t("✓ 已恢复"))
      : "✗ " + (r.message || t("失败"));
    loadPriv();
  });

  // ── 内存管家（cc-mem）──
  function fillMem() {
    const g = (state.settings && state.settings.memGuard) || {};
    $("mem-on").checked = !!g.enabled;
    if (document.activeElement !== $("mem-wl")) $("mem-wl").value = (g.whitelist || []).join("\n");
  }
  function memOut(cls, text) { const o = $("mem-result"); o.className = "prov-state " + cls; o.textContent = text; }
  const GB = (b) => (b / 1073741824).toFixed(1) + "G";
  async function saveMem(patch) {
    const g = { ...((state.settings && state.settings.memGuard) || {}), ...patch };
    const r = await api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memGuard: g }) });
    if (r && r.settings) state.settings.memGuard = r.settings.memGuard;
    fillMem();
    return r;
  }
  $("mem-on").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on && !confirm(t("开启内存管家？\n\n开启后，清理时会停掉白名单以外的后台应用：它们要等你再打开、或被系统重新唤起才会恢复，这段时间可能收不到它们的消息。要一直收消息的应用（比如聊天软件）请加进白名单。"))) {
      e.target.checked = false; return;
    }
    try { await saveMem({ enabled: on }); memOut("ok", on ? t("✓ 已开启") : t("✓ 已关闭")); }
    catch (e2) { e.target.checked = !on; memOut("err", "✗ " + e2.message); }
  });
  $("mem-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "save") {
      const wl = $("mem-wl").value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
      const bad = wl.filter((x) => !/^[A-Za-z][\w]*(\.[\w]+)+$/.test(x));
      if (bad.length) return memOut("err", t("不是合法的包名：{list}", { list: bad.join("、") }));
      try { await saveMem({ whitelist: wl }); memOut("ok", t("✓ 白名单已保存（{n} 个）", { n: wl.length })); }
      catch (e2) { memOut("err", "✗ " + e2.message); }
      return;
    }
    if (act === "status") {
      memOut("", t("正在统计…"));
      const r = await api("/api/mem/status").catch((e2) => ({ ok: false, message: e2.message }));
      if (!r.ok) return memOut("err", "✗ " + (r.message || t("失败")));
      const stop = r.apps.filter((a) => !a.protect), sum = stop.reduce((n, a) => n + a.pss, 0);
      memOut("ok", t("可用 {avail} / 共 {total}。可停的后台应用 {n} 个，约占 {sum}：{list}", {
        avail: GB(r.mem.available), total: GB(r.mem.total), n: stop.length, sum: GB(sum),
        list: stop.slice(0, 8).map((a) => a.pkg).join("、") + (stop.length > 8 ? " …" : ""),
      }));
      return;
    }
    if (act === "clear") {
      if (!$("mem-on").checked) return memOut("err", t("先打开上面的开关"));
      memOut("", t("正在清理…"));
      const r = await api("/api/mem/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch((e2) => ({ ok: false, message: e2.message }));
      if (!r.ok) return memOut("err", "✗ " + (r.message || t("失败")));
      memOut("ok", r.stopped.length
        ? t("✓ 停了 {n} 个，可用内存 {a} → {b}", { n: r.stopped.length, a: GB(r.availableBefore), b: GB(r.availableAfter) })
        : t("没有可停的后台应用"));
    }
  });

  // ── 耗电卡：小时 / 日 / 周三档，SVG 手画（像 macOS 的电池页：上面电量，下面用量柱）──
  const en = { view: "hour", data: null, sel: -1 };
  const enW = 320, enH = 96, enTop = 6, enBot = 80;
  const enPct = (x) => (Math.round(x * 10) / 10) + "%";
  function enLabel(b, view, long) {
    if (view === "hour") {
      const a = new Date(b.t), z = new Date(b.t + 3600e3), hm = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return long ? hm(a) + "–" + hm(z) : String(a.getHours()).padStart(2, "0");
    }
    const [y, m, d] = b.t.split("-").map(Number), dt = new Date(y, m - 1, d);
    if (!long) return (m) + "/" + d;
    if (view === "day") return dt.toLocaleDateString([], { month: "short", day: "numeric", weekday: "short" });
    const e = new Date(dt); e.setDate(e.getDate() + 6);
    return dt.toLocaleDateString([], { month: "short", day: "numeric" }) + " – " + e.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  /** 柱状图：series = [[键, 样式类]]，后面的叠画在前面的上面（比如亮屏里套前台）；fmtMax 给左上角的刻度 */
  function enBars(bars, series, fmtMax, labelEvery) {
    const n = bars.length, slot = enW / n, bw = Math.max(2, slot * 0.68);
    const max = Math.max(...bars.flatMap((b) => series.map(([k]) => b[k] || 0)), 0);
    if (!(max > 0)) return null;
    let s = `<line class="grid" x1="0" x2="${enW}" y1="${enTop}" y2="${enTop}"/><line class="grid" x1="0" x2="${enW}" y1="${enBot}" y2="${enBot}"/>`;
    s += `<text x="${enW}" y="${enTop - 1}" text-anchor="end">${esc(fmtMax(max))}</text>`;
    bars.forEach((b, i) => {
      const x = i * slot + (slot - bw) / 2, dim = en.sel >= 0 && en.sel !== i ? " dim" : "";
      for (const [k, cls] of series) {
        const h = ((b[k] || 0) / max) * (enBot - enTop);
        if (h > 0) s += `<rect class="bar ${cls}${dim}" x="${x.toFixed(1)}" y="${(enBot - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}" rx="1.5"/>`;
      }
      if (i % labelEvery === 0) s += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${enH - 4}" text-anchor="middle">${esc(enLabel(b, en.view))}</text>`;
      s += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${enH}"/>`;
    });
    return s;
  }
  /** 电量曲线（近 24 小时）：充电的时段铺一层绿底 */
  function enLevels(levels, now) {
    if (levels.length < 2) return null;
    const t0 = now - 24 * 3600e3, X = (t) => ((t - t0) / (24 * 3600e3)) * enW, Y = (v) => enBot - (v / 100) * (enBot - enTop);
    let s = [0, 50, 100].map((v) => `<line class="grid" x1="0" x2="${enW}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${enW}" y="${Y(v) - 1}" text-anchor="end">${v}%</text>`).join("");
    for (let i = 1; i < levels.length; i++) {
      // 中间隔了超过半小时（关机 / 网关没跑）就断开，不连成一条假的直线
      if (levels[i][2] && levels[i - 1][2] && levels[i][0] - levels[i - 1][0] < 1800e3)
        s += `<rect class="chg" x="${X(levels[i - 1][0]).toFixed(1)}" y="${enTop}" width="${(X(levels[i][0]) - X(levels[i - 1][0])).toFixed(1)}" height="${enBot - enTop}"/>`;
    }
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const pts = seg.map((l) => X(l[0]).toFixed(1) + "," + Y(l[1]).toFixed(1)).join(" ");
        s += `<polygon class="lvl-a" points="${X(seg[0][0]).toFixed(1)},${enBot} ${pts} ${X(seg[seg.length - 1][0]).toFixed(1)},${enBot}"/><polyline class="lvl" points="${pts}"/>`;
      }
      seg = [];
    };
    levels.forEach((l, i) => { if (i && l[0] - levels[i - 1][0] > 1800e3) flush(); seg.push(l); });
    flush();
    for (let h = 0; h < 24; h += 6) {
      const d = new Date(now - (24 - h) * 3600e3); d.setMinutes(0, 0, 0);
      const t = d.getTime() + 3600e3;
      s += `<text x="${X(t).toFixed(1)}" y="${enH - 4}" text-anchor="middle">${String(new Date(t).getHours()).padStart(2, "0")}</text>`;
    }
    return s;
  }
  function enChart(title, legend, body) {
    if (!body) return "";
    return `<div class="en-chart"><div class="en-t"><span>${esc(title)}</span><span>${legend || ""}</span></div><svg viewBox="0 0 ${enW} ${enH}">${body}</svg></div>`;
  }
  const enDot = (cls, text) => `<span class="en-dot ${cls}"><i></i>${esc(text)}</span>`;
  function enCaption() {
    const d = en.data;
    if (!d) return;
    const pick = en.sel >= 0 ? [d.bars[en.sel]] : d.bars;
    const tot = pick.reduce((a, b) => { for (const k of ["c", "f", "s", "d"]) a[k] += b[k] || 0; return a; }, { c: 0, f: 0, s: 0, d: 0 });
    const head = en.sel >= 0 ? enLabel(d.bars[en.sel], en.view, true) : t({ hour: tk("近 24 小时"), day: tk("近 14 天"), week: tk("近 12 周") }[en.view]);
    const parts = [t("本应用 CPU {d}", { d: fmtDur(tot.c * 1000) })];
    if (d.native) parts.push(t("前台 {d}", { d: fmtDur(tot.f * 1000) }), t("亮屏 {d}", { d: fmtDur(tot.s * 1000) }), t("整机掉电 {p}", { p: enPct(tot.d) }));
    $("en-cap").textContent = head + " · " + parts.join(" · ");
  }
  function enRender() {
    const d = en.data, box = $("en-charts");
    if (!d) return;
    const every = { hour: 6, day: 2, week: 3 }[en.view];
    const empty = !d.bars.some((b) => b.c || b.s);
    let h = "";
    if (en.view === "hour") h += enChart(t("电量"), enDot("chg", t("充电")), enLevels(d.levels, d.now));
    else if (d.native) h += enChart(t("整机掉电"), "", enBars(d.bars, [["d", ""]], enPct, every));
    h += enChart(t("本应用 CPU 时间"), "", enBars(d.bars, [["c", ""]], (v) => fmtDur(v * 1000), every));
    if (d.native) h += enChart(t("亮屏时间"), enDot("s", t("亮屏")) + enDot("f", t("本应用在前台")), enBars(d.bars, [["s", "s"], ["f", "f"]], (v) => fmtDur(v * 1000), every));
    if (empty) h += `<div class="tiny">${esc(t("刚开始记录，每 5 分钟采一次，过一会儿再来看。"))}</div>`;
    if (!d.native) h += `<div class="tiny">${esc(t("这个版本没有原生层，只记 CPU 时间（电量、亮屏、前台时长要 cccodroid）。"))}</div>`;
    box.innerHTML = h;
    const b = d.battery;
    $("en-bat").textContent = b ? [t("电池 {p}", { p: Math.round(b.level) + "%" }), b.charging ? t("充电中") : t("放电中"),
      Number.isFinite(b.currentUa) && b.currentUa ? Math.round(Math.abs(b.currentUa) / (Math.abs(b.currentUa) > 20000 ? 1000 : 1)) + " mA" : ""].filter(Boolean).join(" · ") : "";
    enCaption();
  }

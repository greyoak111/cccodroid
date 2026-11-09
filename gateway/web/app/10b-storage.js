  // ── 设置 → 存储（D10）：网关 gw/storage.mjs 扫、清；这里只画和转发。六类：缓存 / 临时文件 / Claude Code 杂物 能清，
  // 会话、程序和文件只看大小，已有的清理入口汇总后跳回原处 ──
  const ST = { r: null, poll: 0, picks: null, open: false };
  const CACHE_NAMES = { webview: () => t("内置浏览器"), npm: () => "npm", pip: () => "pip", gh: () => "GitHub CLI", pkg: () => t("pkg 下载的安装包"), apt: () => "apt", lineage: () => t("脉络索引") };
  const sz = (b) => (b ? fmtSize(b) : "0 B");
  function stOut(cls, text) { const o = $("st-result"); o.className = "prov-state " + cls; o.textContent = text; }

  async function stLoad() {
    clearTimeout(ST.poll);
    let r;
    try { r = await api("/api/storage"); } catch (e) { stOut("err", "✗ " + e.message); return; }
    ST.r = r;
    stPaint();
    if (r.scanning) { ST.poll = setTimeout(stLoad, 1500); return; }
    if (!r.scan && !ST.kicked) { ST.kicked = true; stScan(); }   // 第一次打开：自动扫一遍
  }
  async function stScan() {
    $("st-scan").disabled = true;
    $("st-when").textContent = t("正在扫描…");
    try { await post("/api/storage/scan", {}); } catch (e) { stOut("err", "✗ " + e.message); }
    ST.poll = setTimeout(stLoad, 800);
  }
  function stOnOpen() { stLoad(); }

  function stPaint() {
    const r = ST.r || {}, s = r.scan;
    $("st-scan").disabled = !!r.scanning;
    $("st-sum").textContent = s ? t("本应用共占 {app}，设备还剩 {free}", { app: sz(s.app), free: sz(s.device && s.device.free) }) : "";
    $("st-when").textContent = r.scanning ? t("正在扫描…") : s ? t("上次扫描：{when}", { when: relTime(s.at) }) : t("还没扫描过");
    const k = r.retention || {};
    $("st-keep").textContent = k.own ? t("按你设的 {n} 天", { n: k.days }) : t("永久保留");
    const a = (state.settings && state.settings.autoClean) || r.auto || {};
    $("st-auto").checked = a.enabled !== false;
    $("st-every").value = a.every || "week";
    $("st-every").disabled = a.enabled === false;
    const last = (r.history || []).find((h) => h.auto);
    $("st-auto-last").textContent = last ? t("上次自动清理：{when}，腾出 {size}", { when: relTime(last.at), size: sz(last.freed) }) : t("还没自动清理过");
    $("st-cards").innerHTML = s ? stCards(s) : "";
  }

  const card = (title, meta, body = "", acts = "") => `<div class="sblock st-card"><div class="srow head"><div class="sl"><b>${esc(title)}</b><p>${meta}</p></div>${acts ? `<div class="sc">${acts}</div>` : ""}</div>${body}</div>`;
  const row = (title, meta, acts = "") => `<div class="item"><div class="it-title">${esc(title)}</div>${meta ? `<div class="it-meta">${meta}</div>` : ""}${acts ? `<div class="it-acts">${acts}</div>` : ""}</div>`;
  const btn = (act, label, extra = "", cls = "btn sm") => `<button class="${cls}" data-st="${act}" ${extra}>${esc(label)}</button>`;

  function stCards(s) {
    const out = [];
    // 1 缓存
    const ci = (s.cache.items || []).filter((x) => x.bytes > 0).map((x) => `${esc(CACHE_NAMES[x.id] ? CACHE_NAMES[x.id]() : x.id)} ${sz(x.bytes)}`).join(" · ");
    out.push(card(t("缓存"), esc(t("共 {size}，删了会自动重新下载或重建", { size: sz(s.cache.bytes) })) + (ci ? `<br>${ci}` : ""), "",
      btn("clean-cache", t("立即清理"), s.cache.bytes ? "" : "disabled")));
    // 2 临时文件
    const tp = s.tmp, picks = ST.picks || new Set((tp.top || []).filter((u) => u.auto).map((u) => u.rel));
    ST.picks = picks;
    const list = ST.open ? `<div class="list compact">${(tp.top || []).map((u) => {
      const lock = u.inUse || u.active;
      const why = u.inUse ? `<span class="badge warn">${esc(t("正在用"))}</span>` : u.active ? `<span class="badge warn">${esc(t("会话在跑"))}</span>` : u.auto ? `<span class="badge">${esc(t("7 天没动过"))}</span>` : "";
      return `<div class="item"><label class="it-title"><input type="checkbox" class="sess-ck" data-st-pick="${esc(u.rel)}" ${picks.has(u.rel) && !lock ? "checked" : ""} ${lock ? "disabled" : ""}>${esc(u.rel)}</label>
        <div class="it-meta"><span>${sz(u.bytes)}</span><span>${esc(t("最后改动：{when}", { when: relTime(u.newest) }))}</span>${why}</div></div>`;
    }).join("")}</div><div class="row-actions">${btn("clean-picks", t("删除勾选的"), "", "btn sm ghost danger")}</div>` : "";
    out.push(card(t("临时文件"), esc(t("共 {size}，其中 7 天没动过的 {old}。包括后台命令的输出、测试和编译留下的临时目录", { size: sz(tp.bytes), old: sz(tp.auto) })),
      list, (tp.top || []).length ? btn("tmp-list", ST.open ? t("收起") : t("最大的 {n} 项", { n: tp.top.length }), "", "btn sm ghost") + " " + btn("clean-tmp", t("清理 7 天前的"), tp.auto ? "" : "disabled") : ""));
    // 3 Claude Code 杂物
    out.push(card(t("Claude Code 杂物"), esc(t("调试日志、shell 快照、MCP 日志、.claude.json 的备份，共 {size}；可清的 {n} 项 {auto}（30 天前的，备份留最新 5 份）", { size: sz(s.junk.bytes), n: s.junk.autoCount, auto: sz(s.junk.auto) })), "",
      btn("clean-junk", t("立即清理"), s.junk.auto ? "" : "disabled")));
    // 4 会话
    const ss = s.sessions || { top: [] };
    out.push(card(t("会话"), esc(t("{n} 个，共 {size}。会话永不自动删除；要删请在会话列表里删，删了先进回收站", { n: ss.count || 0, size: sz(ss.bytes) })),
      `<div class="list compact">${ss.top.slice(0, 10).map((x) => row(x.title || x.id.slice(0, 8), `<span>${sz(x.bytes)}</span>`, btn("open-sess", t("打开"), `data-id="${esc(x.id)}"`, ""))).join("")}</div>`));
    // 5 程序和文件
    const p = s.programs || {}, pr = [];
    if (p.toolkit != null) pr.push(row(t("工具包"), sz(p.toolkit)));
    if (p.components) pr.push(row(t("组件"), sz(p.components)));
    if (p.compData) pr.push(row(t("组件的运行数据（~/.cccodroid）"), sz(p.compData)));
    for (const v of p.claude || []) pr.push(row("Claude Code " + v.version + (v.current ? " · " + t("正在用") : ""), sz(v.bytes)));
    for (const x of p.pkgs || []) pr.push(row(t("pkg 装的 {name}", { name: x.name + " " + x.version }), sz(x.bytes) + ` · <code>pkg uninstall ${esc(x.name)}</code>`));
    if (p.workspace != null) pr.push(row(t("工作区"), sz(p.workspace)));
    if (p.shared != null) pr.push(row(t("共享目录 /sdcard/cccodroid"), sz(p.shared)));
    for (const x of p.home || []) pr.push(row(x.path, sz(x.bytes)));
    out.push(card(t("程序和你的文件"), esc(t("只显示大小，这里不删")), `<div class="list compact">${pr.join("")}</div>`));
    // 6 已有的清理入口
    const e = s.entries || {}, er = [];
    if (e.trash) er.push(row(t("会话回收站"), esc(t("{n} 个，{size}；放满 30 天自动清掉", { n: e.trash.count, size: sz(e.trash.bytes) })), btn("go-trash", t("打开"), "", "")));
    if (e.orphans && e.orphans.count) er.push(row(t("旧工具包留下的程序"), sz(e.orphans.bytes), btn("go-update", t("去处理"), "", "")));
    for (const c of (e.compData && e.compData.items) || []) er.push(row(t("卸掉的组件 {id} 留下的运行数据", { id: c.id }), sz(c.bytes), btn("purge-comp", t("删除"), `data-id="${esc(c.id)}"`, "")));
    if (e.usage) er.push(row(t("用量统计"), sz(e.usage.bytes), btn("go-usage", t("打开"), "", "")));
    out.push(card(t("其他清理入口"), "", `<div class="list compact">${er.join("")}</div>`));
    return out.join("");
  }

  async function stClean(cat, picks) {
    stOut("", t("正在清理…"));
    let r;
    try { r = await post("/api/storage/clean", picks ? { cat, picks } : { cat }); } catch (e) { return stOut("err", "✗ " + e.message); }
    if (!r || !r.ok) return stOut("err", "✗ " + ((r && r.message) || t("失败")));
    stOut("ok", t("✓ 删了 {n} 项，腾出 {size}", { n: r.n, size: sz(r.freed) }) + (r.skipped ? "；" + t("{n} 项没删（正在用或不在允许的范围里）", { n: r.skipped }) : ""));
    ST.picks = null;
    ST.poll = setTimeout(stLoad, 800);
  }

  $("st-scan").addEventListener("click", stScan);
  $("st-auto").addEventListener("change", async (e) => {
    const on = e.target.checked;
    const r = await saveSettings({ autoClean: { enabled: on } });
    if (!r) e.target.checked = !on;
    stPaint();
  });
  $("st-every").addEventListener("change", async (e) => { await saveSettings({ autoClean: { every: e.target.value } }); stPaint(); });
  $("st-cards").addEventListener("change", (e) => {
    const ck = e.target.closest("[data-st-pick]");
    if (!ck) return;
    if (ck.checked) ST.picks.add(ck.dataset.stPick); else ST.picks.delete(ck.dataset.stPick);
  });
  $("st-cards").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-st]");
    if (!b) return;
    const act = b.dataset.st;
    if (act === "clean-cache") return stClean("cache");
    if (act === "clean-junk") return stClean("junk");
    if (act === "clean-tmp") return stClean("tmp");
    if (act === "tmp-list") { ST.open = !ST.open; return stPaint(); }
    if (act === "clean-picks") {
      const picks = [...(ST.picks || [])];
      if (!picks.length) return stOut("err", t("没有勾选"));
      if (!confirm(t("删除勾选的 {n} 项临时文件？删了找不回来。", { n: picks.length }))) return;
      return stClean("tmp", picks);
    }
    if (act === "open-sess") { closeSettings(); return openSession(b.dataset.id); }
    if (act === "go-trash") { closeSettings(); openPage("sessions"); sess.mode = "trash"; return loadTrash(); }
    if (act === "go-update") return openSettings("update");
    if (act === "go-usage") return openSettings("usage");
    if (act === "purge-comp") {
      if (!confirm(t("删掉 {id} 留下的运行数据？以后再装要重新下载。", { id: b.dataset.id }))) return;
      const r = await post("/api/components/purge", { id: b.dataset.id }).catch((e2) => ({ ok: false, message: e2.message }));
      stOut(r.ok ? "ok" : "err", r.ok ? t("✓ 已删除") : "✗ " + (r.message || t("失败")));
      return stScan();
    }
  });

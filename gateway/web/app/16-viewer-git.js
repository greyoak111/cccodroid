  // ── 文件查看 / 编辑器 ──────────────────────────────────────────────
  // 文本 / 代码：直接改，保存时带上打开那一刻的 mtime —— Claude 在这期间改过就先问，别互相覆盖。
  // Markdown：默认渲染，可切到编辑。图片：点一下在「适应屏幕」和「原始大小」之间切。
  // PDF：pdf.js（按需加载），页面进视野才画、离远了就释放，几百页的也不会把 WebView 撑爆。
  // ── git 面板：改动 / 历史 / 逐行对比 / 提交 / 撤销 ──────────────────────
  // 从文件面板（当前目录所在的仓库）或编辑器（这个文件）打开。只是 git 命令的界面，网关见 handleGit
  const gitEl = $("git");
  const GIT = { dir: "", root: "", tab: "changes", status: null, sel: new Set(), file: "", view: null, wrap: true };
  const gapi = (act, params) => api(`/api/git/${act}?` + new URLSearchParams({ dir: GIT.dir, ...(params || {}) }));
  const gpost = (act, body) => api(`/api/git/${act}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: GIT.dir, ...body }) });
  const GS = { modified: "M", added: "A", new: "U", deleted: "D", renamed: "R", conflict: "!" };
  const gsTitle = (k) => ({ modified: t("已修改"), added: t("已添加"), new: t("新文件"), deleted: t("已删除"), renamed: t("已改名"), conflict: t("有冲突") })[k] || k;
  const gnum = (f) => (f.add == null && f.del == null) ? (f.binary ? `<span class="gn">${t("二进制")}</span>` : "")
    : `<span class="gn"><span class="a">+${f.add ?? 0}</span> <span class="d">−${f.del ?? 0}</span></span>`;
  const gbdi = (s) => `<bdi>${esc(s)}</bdi>`;

  /** 打开：dir 可以是目录或文件；opts.file 指定先看哪个文件的对比，opts.tab = "history" 看历史 */
  async function openGit(dir, opts = {}) {
    Object.assign(GIT, { dir, root: "", tab: opts.tab || "changes", status: null, file: opts.file || "", view: opts.file ? (opts.tab === "history" ? { kind: "log" } : { kind: "diff" }) : null });
    GIT.sel = new Set();
    MO.cancel(gitEl); gitEl.classList.remove("hidden");
    $("git-name").textContent = String(dir).split("/").pop();
    $("git-info").textContent = "";
    await gitLoad();
  }
  function closeGit() { MO.hide(gitEl, MO.paneOut(), 170, () => { $("git-body").innerHTML = ""; $("git-sync").classList.add("hidden"); }); }
  $("git-close").addEventListener("click", closeGit);
  $("git-reload").addEventListener("click", () => gitLoad());
  gitEl.querySelector(".git-tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".git-tab"); if (!b) return;
    GIT.tab = b.dataset.tab; GIT.view = null; GIT.file = ""; gitRender();
  });

  async function gitLoad() {
    $("git-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let s;
    try { s = await gapi("status"); } catch (e) { $("git-body").innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    if (s.notRepo) {
      $("git-info").textContent = "";
      $("git-sync").classList.add("hidden");
      $("git-body").innerHTML = `<div class="vw-empty"><div>${t("这个文件夹还不是 git 仓库。")}</div>
        <div class="tiny">${esc(s.dir || GIT.dir)}</div>
        <div class="tiny">${t("建一个仓库后，每次改动都能看到改了哪几行，还能随时退回之前的版本。")}</div>
        <button class="btn sm" data-a="init">${t("在这里建一个仓库")}</button></div>`;
      $("git-body").querySelector('[data-a="init"]').onclick = async () => {
        try { await gpost("init"); toast(t("已建好仓库")); gitLoad(); } catch (e2) { toast(e2.message, true); }
      };
      return;
    }
    if (s.error) { $("git-body").innerHTML = `<div class="vw-empty">${esc(s.error)}</div>`; return; }
    GIT.status = s; GIT.root = s.root;
    // 默认全选；刷新时保留用户的取舍，新冒出来的文件默认选上
    const known = GIT.known || new Set();
    for (const f of s.files) if (!known.has(f.path)) GIT.sel.add(f.path);
    for (const p of [...GIT.sel]) if (!s.files.some((f) => f.path === p)) GIT.sel.delete(p);
    GIT.known = new Set(s.files.map((f) => f.path));
    $("git-name").textContent = s.root.split("/").pop();
    $("git-info").textContent = s.files.length ? t("{n} 个文件有改动", { n: s.files.length }) : t("没有改动");   // 分支与领先/落后在同步栏
    gitSyncBar();
    gitRender();
  }

  // ── 同步栏：当前分支 → 上游，抓取 / 拉取 / 推送 ──
  // 拉取只做快进；分叉了就停下说清楚，可以交给 Claude 合并。推送第一次会顺便建立上游关联
  let gitBusy = "";
  function gitSyncBar() {
    const s = GIT.status, bar = $("git-sync");
    if (!s) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const busy = (a) => gitBusy === a ? " …" : "";
    const dis = gitBusy ? "disabled" : "";
    bar.innerHTML = `<span class="gsy-br" data-a="branches" title="${esc(t("切换或新建分支"))}">⎇ ${gbdi(s.branch || "?")}</span>
      <span class="tiny gsy-up">${s.upstream ? "→ " + gbdi(s.upstream) : esc(t("还没关联远端分支"))}</span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" data-a="fetch" ${dis} title="${esc(t("看看远端有没有新提交（不改动你的文件）"))}">${t("抓取")}${busy("fetch")}</button>
      <button class="btn ghost sm" data-a="pull" ${dis || (s.upstream ? "" : "disabled")} title="${esc(t("把远端的新提交拿下来（只快进）"))}">${t("拉取")}${s.behind ? " ↓" + s.behind : ""}${busy("pull")}</button>
      <button class="btn sm" data-a="push" ${dis} title="${esc(t("把本地的新提交推上去"))}">${t("推送")}${s.ahead ? " ↑" + s.ahead : ""}${busy("push")}</button>`;
  }
  $("git-sync").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === "branches") { GIT.tab = "branches"; GIT.view = null; GIT.file = ""; return gitRender(); }
    if (gitBusy) return;
    if (a === "push" && GIT.status && !GIT.status.upstream && !confirm(t("第一次推送 {b}：会在远端建一个同名分支并关联起来。继续？", { b: GIT.status.branch }))) return;
    gitBusy = a; gitSyncBar();
    try {
      const r = await gpost(a);
      toast(r.message || t("完成"));
    } catch (err) {
      const m = err.message || "";
      // 分叉：交给 Claude 合并（它会先说明打算怎么做，冲突时会停下来问）
      if (a === "pull" && err.body && err.body.code === "diverged") {
        if (confirm(m + "\n\n" + t("让 Claude 帮你把远端的提交合并进来？"))) {
          const root = GIT.root; closeGit();
          send(t("{root} 的当前分支和远端分叉了。请先 git fetch，说明两边各有哪些提交，然后把远端的提交合并进来（能变基就变基，有冲突先停下来问我），最后告诉我结果，不要推送。", { root }));
          gitBusy = ""; return;
        }
      } else toast(m, true);
    }
    gitBusy = "";
    GIT.known = null;
    gitLoad();
  });

  function gitRender() {
    gitEl.querySelectorAll(".git-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === GIT.tab));
    if (GIT.view && GIT.view.kind === "diff") return gitShowDiff(GIT.file, GIT.view.commit);
    if (GIT.view && GIT.view.kind === "commit") return gitShowCommit(GIT.view.commit);
    if (GIT.tab === "history") return gitShowLog(GIT.file);
    if (GIT.tab === "branches") return gitShowBranches();
    gitShowChanges();
  }

  function gitShowChanges() {
    const s = GIT.status; if (!s) return;
    const box = $("git-body");
    if (!s.files.length) { box.innerHTML = `<div class="vw-empty">${t("工作区是干净的：上次提交之后没有改动。")}</div>`; return; }
    const n = GIT.sel.size;
    box.innerHTML = `<div class="git-row tiny"><label><input type="checkbox" id="git-all" ${n === s.files.length ? "checked" : ""}> ${t("全选")}</label>
        <span style="flex:1"></span><span>${t("点文件看改了哪几行")}</span></div>
      ${s.files.map((f, i) => `<div class="git-row" data-i="${i}">
        <input type="checkbox" data-ck="${i}" ${GIT.sel.has(f.path) ? "checked" : ""}>
        <span class="gs gs-${f.kind}" title="${esc(gsTitle(f.kind))}">${GS[f.kind] || "?"}</span>
        <span class="gp" data-open="${i}">${gbdi(f.orig ? f.orig + " → " + f.path : f.path)}</span>
        ${gnum(f)}
        <button class="btn ghost sm" data-undo="${i}" title="${esc(t("把这个文件改回上次提交时的样子"))}">${t("撤销")}</button>
      </div>`).join("")}
      <div class="git-commit">
        <textarea id="git-msg" placeholder="${esc(t("提交说明：这次改了什么（必填）"))}"></textarea>
        <div id="git-id" class="hidden"></div>
        <div class="row-actions"><button class="btn sm" id="git-do" ${n ? "" : "disabled"}>${t("提交选中的 {n} 个文件", { n })}</button>
          <button class="btn ghost sm" id="git-ask">${t("让 Claude 写说明并提交")}</button></div>
      </div>`;
    box.querySelector("#git-all").onchange = (e) => { GIT.sel = e.target.checked ? new Set(s.files.map((f) => f.path)) : new Set(); gitShowChanges(); };
    box.onclick = async (e) => {
      const ck = e.target.dataset.ck, op = e.target.closest("[data-open]"), un = e.target.dataset.undo;
      if (ck != null) {
        const f = s.files[+ck]; e.target.checked ? GIT.sel.add(f.path) : GIT.sel.delete(f.path);
        const b = $("git-do"); b.disabled = !GIT.sel.size; b.textContent = t("提交选中的 {n} 个文件", { n: GIT.sel.size });
        return;
      }
      if (op) { GIT.file = s.files[+op.dataset.open].path; GIT.view = { kind: "diff" }; return gitRender(); }
      if (un != null) {
        const f = s.files[+un];
        const q = f.kind === "new" ? t("{f} 是新文件，撤销就是删掉它。确定？", { f: f.path }) : t("把 {f} 改回上次提交时的样子？这个文件没提交的改动会丢掉。", { f: f.path });
        if (!confirm(q)) return;
        try { const r = await gpost("discard", { file: f.path }); toast(r.message || t("已撤销")); gitLoad(); } catch (e2) { toast(e2.message, true); }
      }
    };
    $("git-do").onclick = () => gitCommit();
    $("git-ask").onclick = () => {
      const files = [...GIT.sel];
      closeGit();
      send(t("请看一下 {root} 里这些文件的改动，写一句简洁的提交说明，然后只提交它们：{files}", { root: GIT.root, files: files.join("、") || t("（全部改动）") }));
    };
  }

  async function gitShowBranches() {
    const box = $("git-body");
    box.innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let r;
    try { r = await gapi("branches"); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    if (GIT.tab !== "branches") return;
    const row = (b, remote) => `<div class="git-row gbr${b.current ? " cur" : ""}" data-b="${esc(b.name)}" data-remote="${remote ? 1 : ""}">
        <span class="gbr-mark">${b.current ? "✓" : ""}</span>
        <span class="gp">${gbdi(b.name)}<span class="tiny gbr-sub">${esc(b.subject || "")}</span></span>
        ${b.gone ? `<span class="badge warn">${t("远端已删")}</span>` : ""}
        ${b.ahead ? `<span class="badge">↑${b.ahead}</span>` : ""}${b.behind ? `<span class="badge">↓${b.behind}</span>` : ""}
        <span class="tiny">${relTime(b.at)}</span>
        ${b.current ? "" : `<button class="btn ghost sm" data-sw="1">${remote ? t("检出") : t("切换")}</button>`}
      </div>`;
    box.innerHTML = `<div class="git-new row-actions">
        <input id="git-newbr" placeholder="${esc(t("新分支名，如 fix/login"))}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn sm" id="git-newbr-ok">${t("新建并切过去")}</button></div>
      <div class="tiny">${t("新分支从当前提交开始；没提交的改动会跟着带过去。")}</div>
      <div class="git-sec">${t("本地分支")}</div>${[...r.local].sort((x, y) => (y.current ? 1 : 0) - (x.current ? 1 : 0)).map((b) => row(b, false)).join("") || `<div class="tiny">${t("还没有提交，所以也还没有分支。")}</div>`}
      ${r.remote.length ? `<div class="git-sec">${t("只在远端的分支")}</div>${r.remote.map((b) => row(b, true)).join("")}` : ""}
      ${r.remotes.length ? "" : `<div class="tiny">${t("这个仓库还没有设置远端（remote），推送和拉取用不了。")}</div>`}`;
    const sw = async (name, create) => {
      try { const x = await gpost("switch", { branch: name, create }); toast(x.message || t("已切换")); }
      catch (e) { return toast(e.message, true); }
      GIT.known = null; GIT.sel = new Set();
      await gitLoad();
    };
    box.onclick = (e) => {
      const b = e.target.closest("[data-sw]"); if (!b) return;
      const rowEl = b.closest(".gbr");
      sw(rowEl.dataset.b, false);
    };
    $("git-newbr-ok").onclick = () => {
      const n = $("git-newbr").value.trim();
      if (!n) { toast(t("填一个分支名"), true); return $("git-newbr").focus(); }
      sw(n, true);
    };
    $("git-newbr").onkeydown = (e) => { if (e.key === "Enter") $("git-newbr-ok").click(); };
  }

  async function gitCommit(again) {
    const msg = ($("git-msg")?.value || "").trim();
    if (!msg) { toast(t("写一句提交说明"), true); $("git-msg")?.focus(); return; }
    const all = GIT.sel.size === GIT.status.files.length;
    try {
      const r = await gpost("commit", { message: msg, files: all ? null : [...GIT.sel] });
      toast(r.message || t("已提交"));
      GIT.sel = new Set(); GIT.known = null;
      gitLoad();
    } catch (e) {
      if (e.status === 409 && !again) return gitAskIdentity();
      toast(e.message, true);
    }
  }
  /** 第一次提交：git 要知道署名。填一次，存进全局配置 */
  function gitAskIdentity() {
    const box = $("git-id"); box.classList.remove("hidden");
    box.innerHTML = `<div class="tiny">${t("第一次提交要先告诉 git 你的名字和邮箱（写进提交记录，存在本机）。")}</div>
      <input id="git-id-name" placeholder="${esc(t("名字"))}" autocomplete="off"><input id="git-id-mail" placeholder="${esc(t("邮箱"))}" autocomplete="off" inputmode="email">
      <button class="btn sm" id="git-id-ok">${t("保存并提交")}</button>`;
    $("git-id-ok").onclick = async () => {
      try { await gpost("identity", { name: $("git-id-name").value, email: $("git-id-mail").value }); }
      catch (e) { return toast(e.message, true); }
      box.classList.add("hidden");
      gitCommit(true);
    };
  }

  /** 统一 diff → 带行号的红绿行 */
  function diffHtml(text) {
    if (!text.trim()) return `<div class="tiny">${t("没有差异")}</div>`;
    const out = []; let o = 0, n = 0, open = false;
    const close = () => { if (open) out.push("</div>"); open = false; };
    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git ")) {
        close();
        const m = line.match(/ b\/(.+)$/);
        out.push(`<div class="gdiff${GIT.wrap ? "" : " nowrap"}"><div class="fh">${esc(m ? m[1] : line)}</div>`); open = true; continue;
      }
      if (!open) { out.push(`<div class="gdiff${GIT.wrap ? "" : " nowrap"}">`); open = true; }
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) {
        if (/^(new file|deleted file|rename )/.test(line)) out.push(`<div class="ln meta"><span class="no"></span><span class="tx">${esc(line)}</span></div>`);
        continue;
      }
      if (line.startsWith("Binary files")) { out.push(`<div class="ln meta"><span class="no"></span><span class="tx">${t("二进制文件，无法逐行对比")}</span></div>`); continue; }
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (h) { o = +h[1]; n = +h[2]; out.push(`<div class="ln hunk"><span class="no">⋯</span><span class="tx">${esc(h[3].trim() || "")}</span></div>`); continue; }
      if (line.startsWith("\\")) continue;      // \ No newline at end of file
      const c = line[0];
      if (c === "+") out.push(`<div class="ln add"><span class="no">${n++}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`);
      else if (c === "-") out.push(`<div class="ln del"><span class="no">${o++}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`);
      else if (c === " ") { out.push(`<div class="ln"><span class="no">${n}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`); o++; n++; }
    }
    close();
    return out.join("");
  }

  async function gitShowDiff(file, commit) {
    const box = $("git-body");
    const back = commit ? t("← 返回这次提交") : t("← 返回改动列表");
    box.innerHTML = `<div class="row-actions git-back"><button class="btn ghost sm" data-a="back">${back}</button>
      <button class="btn ghost sm" data-a="wrap">${t("换行")}</button>
      ${!commit && file ? `<button class="btn ghost sm" data-a="hist">${t("这个文件的历史")}</button>` : ""}
      ${!commit && file && GIT.status?.files.some((f) => f.path === file) ? `<button class="btn ghost sm" data-a="undo">${t("撤销")}</button>` : ""}</div>
      <div id="git-diff"><div class="tiny">${t("读取中…")}</div></div>`;
    box.querySelector(".git-back").onclick = async (e) => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === "back") { GIT.view = commit ? { kind: "commit", commit } : null; if (!commit) GIT.file = ""; return gitRender(); }
      if (a === "wrap") { GIT.wrap = !GIT.wrap; box.querySelectorAll(".gdiff").forEach((d) => d.classList.toggle("nowrap", !GIT.wrap)); return; }
      if (a === "hist") { GIT.tab = "history"; GIT.view = null; return gitRender(); }
      if (a === "undo") {
        const f = GIT.status.files.find((x) => x.path === file);
        if (!confirm(f && f.kind === "new" ? t("{f} 是新文件，撤销就是删掉它。确定？", { f: file }) : t("把 {f} 改回上次提交时的样子？这个文件没提交的改动会丢掉。", { f: file }))) return;
        try { await gpost("discard", { file }); toast(t("已撤销")); GIT.view = null; GIT.file = ""; gitLoad(); } catch (e2) { toast(e2.message, true); }
      }
    };
    try {
      const r = await gapi("diff", { file: file || "", commit: commit || "" });
      $("git-diff").innerHTML = diffHtml(r.diff) + (r.truncated ? `<div class="tiny">${t("改动太多，只显示了前一部分")}</div>` : "");
    } catch (e) { $("git-diff").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; }
  }

  async function gitShowLog(file, append) {
    const box = $("git-body");
    if (!append) { GIT.log = []; box.innerHTML = `<div class="tiny">${t("读取中…")}</div>`; }
    let r;
    try { r = await gapi("log", { n: 50, skip: GIT.log.length, file: file || "" }); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    GIT.log = GIT.log.concat(r.commits || []);
    if (!GIT.log.length) { box.innerHTML = `<div class="vw-empty">${t("还没有提交记录。")}</div>`; return; }
    box.innerHTML = (file ? `<div class="row-actions git-back"><span class="tiny">${esc(t("只看 {f} 的历史", { f: file }))}</span>
        <button class="btn ghost sm" data-a="all">${t("看全部")}</button></div>` : "") +
      `<div class="git-log">${GIT.log.map((c, i) => `<div class="git-row" data-c="${i}">
        <span class="subj">${(c.refs ? c.refs.split(", ").map((x) => `<span class="git-ref">${esc(x.replace(/^HEAD -> /, ""))}</span>`).join("") : "")}${esc(c.subject)}</span>
        <span class="meta mono">${esc(c.short)} · ${esc(c.author)} · ${esc(relTime(c.at))}</span></div>`).join("")}</div>` +
      (r.more ? `<div class="row-actions"><button class="btn ghost sm" data-a="more">${t("加载更多")}</button></div>` : "");
    box.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === "all") { GIT.file = ""; return gitShowLog(""); }
      if (a === "more") return gitShowLog(file, true);
      const row = e.target.closest("[data-c]");
      if (row) { GIT.view = { kind: "commit", commit: GIT.log[+row.dataset.c].hash }; gitRender(); }
    };
  }

  async function gitShowCommit(hash) {
    const box = $("git-body");
    box.onclick = null;
    box.innerHTML = `<div class="tiny">${t("读取中…")}</div>`;
    let c;
    try { c = await gapi("show", { commit: hash }); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    box.innerHTML = `<div class="row-actions git-back"><button class="btn ghost sm" data-a="back">${t("← 返回历史")}</button>
        <button class="btn ghost sm" data-a="all">${t("看整次提交的对比")}</button></div>
      <div class="prov-state"><b>${esc(c.message.split("\n")[0])}</b>${c.message.includes("\n") ? `<pre class="tiny" style="white-space:pre-wrap;margin:4px 0 0">${esc(c.message.split("\n").slice(1).join("\n").trim())}</pre>` : ""}
        <div class="tiny mono">${esc(c.hash.slice(0, 12))} · ${esc(c.author)} · ${esc(new Date(c.at).toLocaleString())}</div></div>
      ${c.files.map((f, i) => `<div class="git-row" data-f="${i}" style="cursor:pointer">
        <span class="gs gs-${{ M: "modified", A: "added", D: "deleted", R: "renamed" }[f.status] || "modified"}">${esc(f.status)}</span>
        <span class="gp">${gbdi(f.orig ? f.orig + " → " + f.path : f.path)}</span>${gnum(f)}</div>`).join("")}`;
    box.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === "back") { GIT.view = null; return gitRender(); }
      if (a === "all") { GIT.file = ""; GIT.view = { kind: "diff", commit: hash }; return gitRender(); }
      const row = e.target.closest("[data-f]");
      if (row) { GIT.file = c.files[+row.dataset.f].path; GIT.view = { kind: "diff", commit: hash }; gitRender(); }
    };
  }

  /** 文件面板：给改过的文件标个色点（不是仓库就什么都不做） */
  let fsDots = null, fsDotsAt = 0;
  async function fsGitDots() {
    const dir = state.fs.path;
    let s;
    // 选中、过滤都会重画列表：同一目录 5 秒内复用上次的结果，别每点一下就跑一次 git status
    if (fsDots && fsDots.dir === dir && Date.now() - fsDotsAt < 5000) s = fsDots.s;
    else {
      try { s = await api(`/api/git/status?dir=${encodeURIComponent(dir)}`); } catch { return; }
      fsDots = { dir, s }; fsDotsAt = Date.now();
    }
    if (!s || s.notRepo || s.error || dir !== state.fs.path) return;
    const rel = dir.replace(/\/$/, "").replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
    const here = path => { const full = s.root + "/" + path; return full.startsWith(rel + "/") ? full.slice(rel.length + 1) : null; };
    const mark = new Map();
    for (const f of s.files) {
      const r = here(f.path); if (r == null) continue;
      const top = r.split("/")[0];
      if (!mark.has(top)) mark.set(top, r.includes("/") ? "modified" : f.kind);
    }
    $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
      const e = fsVisible()[Number(el.dataset.i)];
      const k = e && mark.get(e.name);
      if (k && !el.querySelector(".fs-git-dot")) el.querySelector(".it-title").insertAdjacentHTML("afterend", `<span class="fs-git-dot ${k}" title="${esc(gsTitle(k))}"></span>`);
    });
  }

  const viewerEl = $("viewer");
  const VW = {
    path: "", kind: "", size: 0, mode: "", text: "", mtime: 0, dirty: false,
    pdf: null, pdfObs: null, zoom: 1, wrap: localStorage.getItem("cc.vw.wrap") !== "0",
  };
  const VW_EDIT_MAX = 16 * 1024 * 1024;   // 几百万字的长稿也要能开；预览分段渲染、字数增量统计
  const isMd = (p) => /\.(md|markdown|mdx)$/i.test(p);
  const isHtml = (p) => /\.html?$/i.test(p);

  async function openViewer(path, kind, size) {
    if (VW.dirty && !confirm(t("有未保存的修改，丢弃？"))) return;
    if (VW.dirty) draftClear();
    closeViewerPdf();
    vwDropEd();
    vwHtmlStop();
    Object.assign(VW, { path, kind: kind || "other", size: size || 0, text: "", mtime: 0, dirty: false, zoom: 1, git: null, gitInfo: "", wb: null, sheets: null });
    $("vw-name").textContent = path.split("/").pop();
    $("vw-name").title = path;
    $("vw-info").textContent = fmtSize(VW.size);
    MO.cancel(viewerEl); viewerEl.classList.remove("hidden");
    if (VW.kind === "text" && isHtml(path) && localStorage.getItem("cc.vw.htmlmode") !== "edit") return vwHtml();
    if (VW.kind === "text") return vwLoadText(isMd(path) ? (localStorage.getItem("cc.vw.mdmode") === "edit" ? "edit" : "md") : "edit");
    if (VW.kind === "image") return vwImage();
    if (VW.kind === "pdf") return vwPdf();
    if (VW.kind === "docx") return vwDocx();
    if (VW.kind === "sheet") return vwSheet();
    if (VW.kind === "office") return vwOffice();
    if (VW.kind === "video" || VW.kind === "audio") {
      vwActs([]);
      const tag = VW.kind === "video" ? "video" : "audio";
      $("vw-body").innerHTML = `<div class="vw-media"><${tag} src="${fileUrl(path)}" controls autoplay></${tag}></div>`;
      return;
    }
    vwActs([]);
    $("vw-body").innerHTML = `<div class="vw-empty">
      <div>${t("这种文件没有内置预览。")}</div>
      ${VW.size <= VW_EDIT_MAX ? `<button class="btn ghost sm" data-a="astext">${t("当作文本打开")}</button>` : ""}
      <button class="btn ghost sm" data-a="share">${shareIco()}${t("分享")}</button></div>`;
    $("vw-body").querySelector('[data-a="astext"]')?.addEventListener("click", () => { VW.kind = "text"; vwLoadText("edit"); });
  }

  /** 顶栏右侧的按钮：[文字, 动作, 是否高亮] */
  function vwActs(list) {
    const base = [[t("插入 @路径"), "insert"]];
    $("vw-acts").innerHTML = list.concat(base).map(([l, a, on]) =>
      `<button class="btn ${on ? "" : "ghost"} sm" data-a="${a}">${esc(l)}</button>`).join("") +
      `<button class="btn ghost sm vw-ico" data-a="share" title="${esc(t("分享"))}" aria-label="${esc(t("分享"))}">${shareIco()}</button>`;
  }

  // 预览不了 / 转换失败时正文里的「分享」按钮
  $("vw-body").addEventListener("click", (e) => { if (e.target.closest('.vw-empty [data-a="share"]')) shareFile(VW.path); });
  $("vw-acts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "insert") {
      insertAtCursor("@" + VW.path);
      toast(t("已插入文件路径"));
      return closeViewer();
    }
    if (a === "share") return shareFile(VW.path);
    if (a === "save") return vwSave(false);
    if (a === "md") { VW.text = vwText(); if (isMd(VW.path)) localStorage.setItem("cc.vw.mdmode", "md"); return vwRenderText("md"); }
    if (a === "edit" && VW.mode === "html") {
      // 从预览切回源码：预览期间文件可能被 Claude 改过，重新读
      localStorage.setItem("cc.vw.htmlmode", "edit");
      vwHtmlStop();
      return vwLoadText("edit");
    }
    if (a === "edit") { if (isMd(VW.path) && VW.mode === "md") localStorage.setItem("cc.vw.mdmode", "edit"); return vwRenderText("edit"); }
    if (a === "html") {
      if (VW.dirty) {
        if (!confirm(t("预览显示的是磁盘上的文件。先保存你的修改再预览？"))) return;
        return vwSave(false).then(() => { if (!VW.dirty) { localStorage.setItem("cc.vw.htmlmode", "html"); vwHtml(); } });
      }
      localStorage.setItem("cc.vw.htmlmode", "html");
      return vwHtml();
    }
    if (a === "reload") return vwHtmlReload();
    if (a === "pick") {
      const fr = $("vw-body").querySelector(".vw-html"); if (!fr || !fr.contentWindow) return;
      VW.picking = !VW.picking; vwRenderActs();
      fr.contentWindow.postMessage({ cc: VW.picking ? "pick" : "pickoff" }, "*");
      if (VW.picking) toast(t("点一下网页里的某一块，它就会放进输入框"));
      return;
    }
    if (a === "devtools") { VW.picking = false; try { localStorage.setItem("cc.pvDevtools", pvDevtools() ? "0" : "1"); } catch {} vwRenderActs(); return vwHtmlReload(); }
    if (a === "openweb") { if (VW.pv) openWeb(VW.pv.url); return; }
    if (a === "gitdiff") return vwShowDiff();
    if (a === "aspdf") return vwOffice();
    if (a === "native") { closeViewerPdf(); return VW.kind === "docx" ? vwDocx() : vwSheet(); }
    if (a === "githist") return openGit(VW.path, { file: VW.git.rel, tab: "history" });
    if (a === "wrap") {
      VW.wrap = !VW.wrap;
      localStorage.setItem("cc.vw.wrap", VW.wrap ? "1" : "0");
      $("vw-text")?.classList.toggle("nowrap", !VW.wrap);
      gutSchedule();
      return vwRenderActs();
    }
    if (a === "zoom-" || a === "zoom+") {
      VW.zoom = Math.max(0.5, Math.min(4, VW.zoom * (a === "zoom+" ? 1.25 : 0.8)));
      return vwPdfRelayout();
    }
  });

  function vwText() { if (VW.ed) return VW.ed.getText(); const ta = $("vw-text"); return ta ? ta.value : VW.text; }
  function vwDropEd() { if (VW.ed) { try { VW.ed.destroy(); } catch {} VW.ed = null; } }

  /** 顶栏小字：大小 · git 状态 · 字数（md 编辑时） */
  function vwInfo() {
    let s = fmtSize(VW.size) + (VW.gitInfo || "");
    if (VW.ed) {
      const w = VW.ed.words();
      s += " · " + (w == null ? t("统计字数…") : t("{n} 字", { n: w.toLocaleString() }));
      const sel = VW.ed.selWords();
      if (sel) s += " · " + t("选中 {n} 字", { n: sel.toLocaleString() });
    }
    $("vw-info").textContent = s;
  }

  // 草稿：没保存的修改每隔一会儿存进 IndexedDB（localStorage 只有几 MB，长稿放不下），
  // 应用被杀、WebView 重载也不丢；保存或放弃后清掉。0.4.4 之前存在 localStorage 的旧草稿照样能恢复
  const draftKey = () => "cc.draft:" + VW.path;
  let draftDb = null;
  function draftIdb(mode, fn) {
    draftDb = draftDb || new Promise((ok, no) => {
      const r = indexedDB.open("cc-drafts", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("d");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => { draftDb = null; no(r.error); };
    });
    return draftDb.then((db) => new Promise((ok, no) => {
      const tx = db.transaction("d", mode), q = fn(tx.objectStore("d"));
      tx.oncomplete = () => ok(q && q.result);
      tx.onerror = tx.onabort = () => no(tx.error);
    }));
  }
  function draftSave() {
    clearTimeout(VW.dt);
    VW.dt = setTimeout(() => {
      if (!VW.dirty) return;
      const key = draftKey(), d = { at: Date.now(), text: vwText() };
      draftIdb("readwrite", (os) => os.put(d, key)).catch(() => {
        if (d.text.length <= 1024 * 1024) try { localStorage.setItem(key, JSON.stringify(d)); } catch {}
      });
    }, 800);
  }
  function draftClear() {
    clearTimeout(VW.dt);
    const key = draftKey();
    try { localStorage.removeItem(key); } catch {}
    draftIdb("readwrite", (os) => os.delete(key)).catch(() => {});
  }
  async function draftTake() {
    let d = null;
    try { d = await draftIdb("readonly", (os) => os.get(draftKey())); } catch {}
    if (!d) try { d = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch {}
    if (!d || typeof d.text !== "string") return null;
    if (d.text === VW.text) { draftClear(); return null; }
    if (confirm(t("上次有没保存的修改（{time}），要恢复吗？\n确定：恢复\n取消：丢掉草稿", { time: new Date(d.at).toLocaleString() }))) return d.text;
    draftClear();
    return null;
  }

  async function vwLoadText(mode) {
    if (VW.size > VW_EDIT_MAX) {
      vwActs([]);
      $("vw-body").innerHTML = `<div class="vw-empty"><div>${t("文件太大（{size}），只能下载查看。", { size: fmtSize(VW.size) })}</div></div>`;
      return;
    }
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    try {
      const r = await fetch(fileUrl(VW.path));
      if (!r.ok) throw new Error("HTTP " + r.status);
      VW.mtime = Number(r.headers.get("x-mtime")) || 0;
      VW.text = await r.text();
    } catch (e) {
      $("vw-body").innerHTML = `<div class="vw-empty">${t("读取失败")}: ${esc(e.message)}</div>`;
      return;
    }
    VW.dirty = false;
    const path = VW.path, draft = await draftTake();
    if (VW.path !== path) return;
    if (draft != null) { VW.text = draft; VW.dirty = true; mode = "edit"; }
    vwRenderText(mode);
    vwGitCheck();
  }

  function vwRenderActs() {
    const acts = [];
    if (isMd(VW.path)) acts.push(VW.mode === "md" ? [t("编辑"), "edit"] : [t("预览"), "md"]);
    if (isHtml(VW.path)) {
      if (VW.mode === "html") { vwActs([[t("源码"), "edit"], [t("刷新"), "reload"], [t("开发者工具"), "devtools", pvDevtools()], ...(pvDevtools() ? [[t("选取元素"), "pick", VW.picking]] : []), [t("在浏览器打开"), "openweb"]]); return; }
      acts.push([t("预览"), "html"]);
    }
    if (VW.mode === "edit") {
      if (!isMd(VW.path)) acts.push([t("换行"), "wrap", VW.wrap]);
      acts.push([VW.dirty ? t("保存") + " •" : t("保存"), "save", VW.dirty]);
    }
    // 在 git 仓库里：改过就给「对比」（和上次提交比，红删绿增），随时可看这个文件的历史
    if (VW.git && VW.git.root) {
      if (VW.mode === "diff") acts.unshift([t("编辑"), "edit"]);
      else if (VW.git.kind) acts.push([t("对比"), "gitdiff"]);
      acts.push([t("历史"), "githist"]);
    }
    vwActs(acts);
  }

  /** 这个文件在不在 git 仓库里、改没改（编辑器顶栏显示「已修改 +3 −1」） */
  async function vwGitCheck() {
    const p = VW.path;
    VW.git = null;
    let s;
    try { s = await api("/api/git/status?dir=" + encodeURIComponent(p)); } catch { return; }
    if (p !== VW.path || !s || s.notRepo || s.error) return;
    const real = p.replace(/^\/sdcard(?=\/)/, "/storage/emulated/0");
    const rel = real.startsWith(s.root + "/") ? real.slice(s.root.length + 1) : null;
    if (rel == null) return;
    const f = s.files.find((x) => x.path === rel);
    VW.git = { root: s.root, rel, kind: f ? f.kind : "", add: f ? f.add : 0, del: f ? f.del : 0 };
    VW.gitInfo = f ? " · " + gsTitle(f.kind) + (f.add != null ? ` +${f.add} −${f.del ?? 0}` : "") : " · " + t("和上次提交一样");
    vwInfo();
    vwRenderActs();
    VW.gitMarks = null;
    if (f && (f.kind === "modified" || f.kind === "renamed") && !f.binary) {
      try {
        const r = await api("/api/git/diff?" + new URLSearchParams({ dir: p, file: p }));
        if (p === VW.path) { VW.gitMarks = gutMarks(r.diff); gutSchedule(); }
      } catch {}
    } else gutSchedule();
  }

  // ── 编辑器行号 + git 改动标记 ──
  // 纯 textarea 没有行号：左边一列跟着滚动。自动换行时一行可能占好几行高，用一个看不见的镜像层量出每行的实际位置。
  // 标记对的是磁盘上的版本和上次提交（没保存的修改不算，存完重新算）：绿 = 新加的行，蓝 = 改过的行，红三角 = 这里删过东西。
  const GUT_MAX = 20000;                // 再长的文件不画行号，免得量一次卡半天
  let gutTimer = 0, gutRO = null;
  /** 统一 diff → Map(新文件行号 → { type, old:[原来的行] }) */
  function gutMarks(diff) {
    const m = new Map();
    let n = 0, dels = [], adds = [];
    const flush = () => {
      if (adds.length) adds.forEach((ln, i) => m.set(ln, { type: dels.length ? "mod" : "add", old: i === 0 ? dels : null, first: i === 0 }));
      else if (dels.length) m.set(n, { type: "del", old: dels });
      dels = []; adds = [];
    };
    for (const line of String(diff || "").split("\n")) {
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { flush(); n = +h[1]; continue; }
      if (!n || /^(\+\+\+|---) /.test(line) || line.startsWith("\\")) continue;
      if (line[0] === "-") { if (adds.length) flush(); dels.push(line.slice(1)); }
      else if (line[0] === "+") { adds.push(n++); }
      else if (line[0] === " ") { flush(); n++; }
    }
    flush();
    // 一段修改的所有行共用第一行记下的原文，点哪一行都能看到
    let last = null;
    for (const [ln, v] of [...m.entries()].sort((a, b) => a[0] - b[0])) { if (v.first) last = v; else if (v.type === "mod" && !v.old && last) v.old = last.old; }
    return m;
  }
  function gutAttach(ta) {
    const gin = ta.parentElement.querySelector(".vw-gut-in");
    ta.addEventListener("scroll", () => { gin.style.transform = `translateY(${-ta.scrollTop}px)`; }, { passive: true });
    if (gutRO) gutRO.disconnect();
    gutRO = new ResizeObserver(() => gutSchedule());
    gutRO.observe(ta);
    ta.parentElement.querySelector(".vw-gut").addEventListener("click", (e) => {
      const mk = e.target.closest(".gm"); if (!mk) return;
      gutPop(+mk.dataset.ln, mk);
    });
    gutSchedule();
  }
  function gutSchedule() { clearTimeout(gutTimer); gutTimer = setTimeout(gutDraw, 120); }
  function gutDraw() {
    const ta = $("vw-text"); if (!ta) return;
    const wrap = ta.parentElement, gut = wrap.querySelector(".vw-gut"), gin = wrap.querySelector(".vw-gut-in");
    if (ta.value.length > 2 * 1024 * 1024) { gut.classList.add("hidden"); return; }
    const lines = ta.value.split("\n");
    if (lines.length > GUT_MAX) { gut.classList.add("hidden"); return; }
    gut.classList.remove("hidden");
    gut.style.width = (String(lines.length).length * 7.2 + 18) + "px";
    // 镜像层：和 textarea 同宽同字体同换行规则，逐行量位置
    const cs = getComputedStyle(ta);
    const mir = document.createElement("div");
    mir.className = "vw-mirror mono";
    mir.style.cssText = `position:absolute;visibility:hidden;left:0;top:0;width:${ta.clientWidth}px;box-sizing:border-box;padding:${cs.padding};font:${cs.font};line-height:${cs.lineHeight};tab-size:${cs.tabSize};white-space:${cs.whiteSpace};word-break:${cs.wordBreak};overflow-wrap:${cs.overflowWrap}`;
    const frag = document.createDocumentFragment();
    for (const l of lines) { const d = document.createElement("div"); d.textContent = l || " "; frag.appendChild(d); }
    mir.appendChild(frag);
    wrap.appendChild(mir);
    const kids = mir.children, marks = VW.gitMarks;
    const lh = parseFloat(cs.lineHeight) || 19.5;
    let html = "";
    for (let i = 0; i < kids.length; i++) {
      const top = kids[i].offsetTop, ln = i + 1, mk = marks && marks.get(ln);
      html += `<div class="gl" style="top:${top}px;height:${lh}px;line-height:${lh}px">${ln}</div>`;
      if (mk) html += mk.type === "del"
        ? `<div class="gm del" data-ln="${ln}" style="top:${top - 4}px" title="${esc(t("这里删掉了 {n} 行", { n: mk.old.length }))}"></div>`
        : `<div class="gm ${mk.type}" data-ln="${ln}" style="top:${top}px;height:${kids[i].offsetHeight}px"></div>`;
    }
    // 文件末尾删掉的行：标在最后一行下面
    if (marks) for (const [ln, mk] of marks) if (ln > kids.length && mk.type === "del") {
      const last = kids[kids.length - 1];
      html += `<div class="gm del" data-ln="${ln}" style="top:${last.offsetTop + last.offsetHeight - 4}px"></div>`;
    }
    mir.remove();
    gin.innerHTML = html;
    gin.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
  /** 点标记：这一处原来是什么样 */
  function gutPop(ln, mk) {
    const v = VW.gitMarks && VW.gitMarks.get(ln); if (!v) return;
    const wrap = mk.closest(".vw-edwrap");
    wrap.querySelector(".vw-gpop")?.remove();
    const pop = document.createElement("div");
    pop.className = "vw-gpop";
    const old = v.old || [];
    pop.innerHTML = `<div class="tiny">${v.type === "add" ? t("第 {n} 行是新加的（上次提交里没有）", { n: ln }) : v.type === "del" ? t("这里删掉了 {n} 行：", { n: old.length }) : t("改过；上次提交时是：")}</div>`
      + (old.length ? `<pre class="gdel">${esc(old.slice(0, 40).join("\n"))}${old.length > 40 ? "\n…" : ""}</pre>` : "")
      + `<div class="row-actions"><button class="btn ghost sm" data-a="diff">${t("看整个文件的对比")}</button><button class="btn ghost sm" data-a="x">${t("关闭")}</button></div>`;
    pop.style.top = Math.max(4, Math.min(wrap.clientHeight - 60, parseFloat(mk.style.top) - $("vw-text").scrollTop + 22)) + "px";
    pop.onclick = (e) => { const a = e.target.dataset.a; if (a === "x") pop.remove(); if (a === "diff") { pop.remove(); vwShowDiff(); } };
    wrap.appendChild(pop);
  }

  async function vwShowDiff() {
    VW.text = vwText();
    vwDropEd();
    VW.mode = "diff";
    vwRenderActs();
    $("vw-body").innerHTML = `<div class="vw-diff">${VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : ""}<div class="tiny">${t("读取中…")}</div></div>`;
    try {
      const r = await api("/api/git/diff?" + new URLSearchParams({ dir: VW.path, file: VW.path }));
      if (VW.mode !== "diff") return;
      $("vw-body").querySelector(".vw-diff").innerHTML = (VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : "") + diffHtml(r.diff);
    } catch (e) { $("vw-body").querySelector(".vw-diff").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; }
  }

  // ── HTML 预览：网关另起的只读小服务里渲染（和界面不同站点，网页脚本碰不到网关），文件一改自动刷新 ──
  async function vwHtml() {
    vwDropEd();
    vwHtmlStop();
    VW.mode = "html";
    vwRenderActs();
    const p = VW.path;
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let r;
    try { r = await post("/api/preview", { path: p }); }
    catch (e) { if (p === VW.path) $("vw-body").innerHTML = `<div class="vw-empty">${t("预览打不开")}: ${esc(e.message)}</div>`; return; }
    if (p !== VW.path || VW.mode !== "html") return;
    VW.pv = { url: r.url, mtime: r.mtime };
    $("vw-body").innerHTML = `<iframe class="vw-html" src="${esc(pvSrc())}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock" allow="autoplay; fullscreen; clipboard-write" referrerpolicy="same-origin"></iframe>`;
    // Claude 一边改、你一边看：每 1.5 秒看一眼修改时间，变了就重新载入
    VW.pvTimer = setInterval(async () => {
      if (viewerEl.classList.contains("hidden") || VW.mode !== "html" || VW.path !== p) return vwHtmlStop();
      if (document.hidden) return;
      let s; try { s = await api("/api/file/stat?path=" + encodeURIComponent(p)); } catch { return; }
      if (VW.pv && s && s.mtime && s.mtime !== VW.pv.mtime) { VW.pv.mtime = s.mtime; VW.size = s.size; $("vw-info").textContent = fmtSize(s.size); vwHtmlReload(); }
    }, 1500);
  }
  // 开发者工具（Eruda）：开关记在本机；开着时预览地址带上 cc_devtools，预览服务往网页里插它（深浅跟界面走）
  const pvDevtools = () => { try { return localStorage.getItem("cc.pvDevtools") === "1"; } catch { return false; } };
  function pvSrc(bust) {
    const q = new URLSearchParams();
    if (pvDevtools()) { q.set("cc_devtools", "1"); if (document.documentElement.dataset.theme !== "light") q.set("cc_dark", "1"); }
    if (bust) q.set("_r", Date.now());
    const qs = q.toString();
    return VW.pv.url + (qs ? (VW.pv.url.includes("?") ? "&" : "?") + qs : "");
  }
  // 预览里选中的元素递回来：只认当前预览框、当前预览站点发来的；只取几段文字放进输入框（不执行），发不发由用户定
  window.addEventListener("message", (e) => {
    const fr = $("vw-body").querySelector(".vw-html"), d = e.data;
    if (!fr || e.source !== fr.contentWindow || !VW.pv || !d || typeof d !== "object") return;
    try { if (e.origin !== new URL(VW.pv.url).origin) return; } catch { return; }
    if (d.cc === "pickoff") { VW.picking = false; vwRenderActs(); return; }
    if (d.cc !== "picked") return;
    VW.picking = false; vwRenderActs();
    pickInsert("@" + VW.path, d);
  });
  /** 选中的元素放进输入框：只取选择器和一小段 HTML 当文字，不执行任何东西 */
  function pickInsert(where, d) {
    const str = (v, n) => String(v == null ? "" : v).slice(0, n);
    const sel = str(d.sel, 300), html = str(d.html, 900).replace(/```/g, "`\u200b``");
    insertAtCursor(t("{path} 里的 {sel}：", { path: where, sel: "`" + sel + "`" }) + "\n```html\n" + html + "\n```\n");
    toast(t("已放进输入框，接着写要怎么改"));
  }
  // 浏览器窗格（原生 WebView）里选中的：原生侧轮询取到后调这里，参数是 JSON 文本
  window.__ccPickIn = (json) => {
    let d; try { d = JSON.parse(String(json)); } catch { return; }
    if (!d || typeof d !== "object" || d.cc !== "picked") return;
    pickInsert(String(d.url || "").slice(0, 300), d);
  };
  function vwHtmlReload() {
    VW.picking = false;
    const f = $("vw-body").querySelector(".vw-html");
    if (f && VW.pv) f.src = pvSrc(true);
  }
  function vwHtmlStop() { clearInterval(VW.pvTimer); VW.pvTimer = 0; VW.pv = null; }

  function vwRenderText(mode) {
    vwDropEd();
    VW.mode = mode;
    if (mode === "edit" && isMd(VW.path) && !VW.plainMd) { vwRenderActs(); return vwMdEditor(); }
    if (mode === "md") vwMdPreview(VW.text);
    else {
      $("vw-body").innerHTML = `<div class="vw-edwrap"><div class="vw-gut"><div class="vw-gut-in"></div></div><textarea id="vw-text" class="mono ${VW.wrap ? "" : "nowrap"}" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>`;
      const ta = $("vw-text");
      ta.value = VW.text;
      gutAttach(ta);
      ta.addEventListener("input", () => { if (!VW.dirty) { VW.dirty = true; vwRenderActs(); } draftSave(); gutSchedule(); });
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); vwSave(false); }
        else if (e.key === "Tab" && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand("insertText", false, "\t"); }
      });
    }
    vwRenderActs();
  }

  // ── Markdown 预览：长稿分段，只渲染屏幕附近的段，远了再收回去，几百万字也不卡 ──
  const MD_LAZY_MIN = 200 * 1024, MD_CHUNK = 24 * 1024;
  /** 按空行切段，不切开代码块、公式块，也不切在列表、缩进续行前面 */
  function mdChunks(text) {
    const lines = text.split("\n"), out = [];
    let buf = [], n = 0, fence = "", math = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      buf.push(l); n += l.length + 1;
      const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
      if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence) fence = ""; continue; }
      if (fence) continue;
      const t = l.trim();
      if (math) { if (t.endsWith("$$") || t.endsWith("\\]")) math = false; }
      else if ((t.startsWith("$$") && !(t.length > 2 && t.slice(2).endsWith("$$"))) || (t.startsWith("\\[") && !t.endsWith("\\]"))) math = true;
      if (math || n < MD_CHUNK || l.trim()) continue;
      const nx = lines[i + 1];
      if (nx == null || /^(\s|[-*+]\s|\d+[.)]\s|>)/.test(nx)) continue;
      out.push(buf.join("\n")); buf = []; n = 0;
    }
    if (buf.length) out.push(buf.join("\n"));
    return out;
  }
  let mdObs = null;
  function vwMdPreview(text) {
    if (mdObs) { mdObs.disconnect(); mdObs = null; }
    const body = $("vw-body");
    if (text.length < MD_LAZY_MIN) {
      body.innerHTML = `<div class="vw-md bubble">${renderMd(text, mdImgSrc)}</div>`; enhanceMd(body);
      return;
    }
    const parts = mdChunks(text);
    // 没渲染的段先按字数估个高度占位，滚动条长度大致对；渲染过一次就记住真实高度
    const cpl = Math.max(16, Math.floor((Math.min(body.clientWidth || 360, 760) - 32) / 16));
    const est = (c) => { let h = 0; for (const l of c.split("\n")) h += l ? Math.ceil(l.length / cpl) * 27 + 10 : 6; return h; };
    body.innerHTML = `<div class="vw-md bubble">${parts.map((c, i) => `<div class="vw-chunk" data-i="${i}" style="min-height:${est(c)}px"></div>`).join("")}</div>`;
    const box = body.firstElementChild;
    mdObs = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const el = e.target, on = el.dataset.on === "1";
        if (e.isIntersecting && !on) {
          el.innerHTML = renderMd(parts[+el.dataset.i], mdImgSrc);
          el.style.minHeight = ""; el.dataset.on = "1";
          enhanceMd(el);
        } else if (!e.isIntersecting && on) {
          el.style.minHeight = el.offsetHeight + "px";
          el.innerHTML = ""; el.dataset.on = "";
        }
      }
    }, { root: box, rootMargin: "1500px 0px" });
    for (const el of box.children) mdObs.observe(el);
  }

  // ── Markdown 编辑器（CodeMirror 6，按需加载，见 claude-apk/mdedit/） ──
  let mdeditP = null;
  const loadMdEdit = () => mdeditP || (mdeditP = import("/mdedit/mdedit.js").catch((e) => { mdeditP = null; throw e; }));
  const MI = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const MDBAR = [
    ["undo", tk("撤销"), MI('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>')],
    ["redo", tk("重做"), MI('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>')],
    0,
    ["heading", tk("标题"), "H"],
    ["bold", tk("粗体"), "<b>B</b>"],
    ["italic", tk("斜体"), '<i style="font-family:Georgia,serif">I</i>'],
    ["strike", tk("删除线"), "<s>S</s>"],
    0,
    ["quote", tk("引用"), MI('<path d="M5 5v14M10 7h9M10 12h9M10 17h6"/>')],
    ["ul", tk("无序列表"), MI('<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="5" cy="6" r=".9"/><circle cx="5" cy="12" r=".9"/><circle cx="5" cy="18" r=".9"/>')],
    ["ol", tk("有序列表"), MI('<path d="M11 6h9M11 12h9M11 18h9M4 4.5h1.5V9M4 9h3M4 14.6c.6-.8 3-.9 3 .6 0 1.1-3 2-3 3.3h3.2"/>')],
    ["task", tk("任务列表"), MI('<path d="M3.5 4h7v7h-7zM5.3 7.6l1.4 1.4 2.3-2.7M13.5 7.5h7M3.5 14h7v7h-7zM13.5 17.5h7"/>')],
    0,
    ["link", tk("链接"), MI('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>')],
    ["image", tk("图片"), MI('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>')],
    ["code", tk("代码"), MI('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')],
    ["hr", tk("分割线"), MI('<path d="M3 12h18"/>')],
    0,
    ["search", tk("查找替换"), MI('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>')],
  ];
  /** md 里的图片地址 → 能加载的地址（相对路径按这个文件所在目录算） */
  function mdImgSrc(u) {
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    try { u = decodeURI(u); } catch {}
    let p = u.startsWith("/") ? u : VW.path.replace(/\/[^/]*$/, "") + "/" + u;
    const out = [];
    for (const seg of p.split("/")) { if (seg === "..") out.pop(); else if (seg !== "." && seg !== "") out.push(seg); }
    return fileUrl("/" + out.join("/"));
  }
  async function vwMdEditor() {
    const path = VW.path, body = $("vw-body");
    body.innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let m;
    try { m = await loadMdEdit(); } catch (e) {
      toast(t("编辑器加载失败，改用纯文本：{msg}", { msg: e.message || String(e) }), true);
      VW.plainMd = true;
      return vwRenderText("edit");
    }
    if (VW.path !== path || VW.mode !== "edit" || VW.ed) return;
    body.innerHTML = `<div class="vw-mded"></div><div class="vw-mdbar">${MDBAR.map((b) => b
      ? `<button type="button" data-md="${b[0]}" title="${esc(t(b[1]))}" aria-label="${esc(t(b[1]))}">${b[2]}</button>`
      : '<span class="sep"></span>').join("")}</div>`;
    VW.ed = m.createMdEditor(body.querySelector(".vw-mded"), {
      doc: VW.text,
      onChange: () => { if (!VW.dirty) { VW.dirty = true; vwRenderActs(); } draftSave(); },
      onSelect: () => { clearTimeout(VW.wt); VW.wt = setTimeout(vwInfo, 200); },
      onSave: () => vwSave(false),
      resolveSrc: mdImgSrc,
      placeholder: t("开始写…"),
      phrases: {
        "Find": t("查找"), "Replace": t("替换"), "next": t("下一个"), "previous": t("上一个"), "all": t("全部"),
        "match case": t("区分大小写"), "regexp": t("正则"), "by word": t("整词"),
        "replace": t("替换"), "replace all": t("全部替换"), "close": t("关闭"),
      },
      ph: {
        bold: t("粗体"), italic: t("斜体"), strike: t("删除线"), code: t("代码"),
        link: { text: t("链接文字"), url: "https://" }, image: { text: t("图片说明"), url: t("图片路径") },
      },
    });
    const bar = body.querySelector(".vw-mdbar");
    bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });   // 点按钮不收键盘
    bar.addEventListener("click", (e) => { const b = e.target.closest("[data-md]"); if (b && VW.ed) VW.ed.run(b.dataset.md); });
    vwInfo();
  }

  async function vwSave(force) {
    const text = vwText();
    let r;
    try {
      r = await fetch(`/api/file/save?path=${encodeURIComponent(VW.path)}&mtime=${VW.mtime}${force ? "&force=1" : ""}`, {
        method: "POST", body: text,
      });
    } catch (e) { return toast(t("保存失败：{msg}", { msg: e.message }), true); }
    if (r.status === 409) {
      if (confirm(t("文件在你打开之后被改过了（可能是 Claude 改的）。\n确定：用你的版本覆盖\n取消：放弃你的修改，重新载入"))) return vwSave(true);
      VW.dirty = false;
      draftClear();
      return vwLoadText("edit");
    }
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) return toast(t("保存失败：{msg}", { msg: j.error || r.status }), true);
    VW.text = text; VW.mtime = j.mtime; VW.size = j.size; VW.dirty = false;
    draftClear();
    vwInfo();
    vwRenderActs();
    toast(t("已保存"));
    vwGitCheck();                     // 存完改动行数变了
  }

  function vwImage() {
    vwActs([]);
    $("vw-body").innerHTML = `<div class="vw-img"><img src="${fileUrl(VW.path)}" alt=""></div>`;
    const box = $("vw-body").querySelector(".vw-img");
    const img = box.querySelector("img");
    img.addEventListener("load", () => { $("vw-info").textContent = `${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(VW.size)}`; });
    img.addEventListener("click", (e) => {
      // 放大时以点到的位置为中心
      const r = img.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      box.classList.toggle("zoom");
      if (box.classList.contains("zoom")) {
        box.scrollLeft = fx * img.naturalWidth - box.clientWidth / 2;
        box.scrollTop = fy * img.naturalHeight - box.clientHeight / 2;
      }
    });
  }


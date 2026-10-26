  // ── 应用内终端 ────────────────────────────────────────────────────
  // xterm.js 按需加载（近 500 KB，不开终端就不付这个钱）；每个终端一个 xterm 实例，
  // 输出走 /api/term/<id>/stream（SSE，先回放缓冲），按键攒一小撮再按顺序 POST。
  // 手机键盘没有 Esc / Ctrl / 方向键：底下一排补上，Ctrl / Alt 是「粘住」的，作用于下一个键。
  const termEl = $("term");
  const TERM = {
    list: [], cur: null, inst: new Map(), loaded: null, ctrl: false, alt: false,
    font: Number(localStorage.getItem("cc.term.font")) || 13,
  };

  function loadXterm() {
    if (TERM.loaded) return TERM.loaded;
    const add = (tag, attrs) => new Promise((ok, bad) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = ok;
      el.onerror = () => bad(new Error(attrs.src || attrs.href));
      document.head.appendChild(el);
    });
    TERM.loaded = add("link", { rel: "stylesheet", href: "/xterm.css" })
      .then(() => add("script", { src: "/xterm.js" }))
      .then(() => add("script", { src: "/xterm-addon-fit.js" }))
      .catch((e) => { TERM.loaded = null; throw e; });
    return TERM.loaded;
  }

  function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue(k).trim();
    const light = document.documentElement.dataset.theme === "light";
    const base = {
      background: v("--code-bg") || (light ? "#fff" : "#000"), foreground: v("--fg"),
      cursor: v("--accent"), cursorAccent: v("--code-bg"),
      selectionBackground: light ? "rgba(201,100,66,.25)" : "rgba(217,119,87,.35)",
    };
    // 浅色底上 xterm 默认的黄 / 亮白几乎看不见，换一套深一点的
    return light ? Object.assign(base, {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00", blue: "#0550ae",
      magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
      brightBlue: "#0969da", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    }) : base;
  }

  async function openTerm() {
    MO.cancel(termEl); termEl.classList.remove("hidden");
    try { await loadXterm(); } catch (e) { toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    let r;
    try { r = await api("/api/term/list"); } catch (e) { toast(t("终端打不开：{msg}", { msg: e.message }), true); return; }
    if (!r.available) { toast(t("找不到伪终端程序（ptyhost / python3）"), true); return; }
    const srv = r.terms || [];
    // 本界面开着、网关却不认识了（网关重启过）：标成已退出，留着看最后的输出
    for (const x of TERM.list) if (TERM.inst.has(x.id) && !srv.some((y) => y.id === x.id)) srv.push(Object.assign(x, { alive: false }));
    // 已退出的：本界面开过的留着，别处留下的不显示
    TERM.list = srv.filter((x) => x.alive || TERM.inst.has(x.id));
    const live = TERM.list.filter((x) => x.alive);
    if (!live.length) return newTerm();
    if (!TERM.list.some((x) => x.id === TERM.cur)) TERM.cur = live[live.length - 1].id;
    renderTermTabs();
    showTerm(TERM.cur);
  }

  function closeTerm() {
    MO.hide(termEl, MO.paneOut());
    TERM.inst.get(TERM.cur)?.xt.blur();
  }

  /** 手动登录：开一个新终端，网关替你敲好 claude auth login；授权码贴给 claude 自己的提示 */
  async function openLoginTerm(method) {
    MO.cancel(termEl); termEl.classList.remove("hidden");
    try { await loadXterm(); } catch (e) { toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    try { const r = await api("/api/term/list"); TERM.list = (r.terms || []).filter((x) => x.alive || TERM.inst.has(x.id)); } catch {}
    await newTerm({ login: method === "console" ? "console" : true });
  }

  async function newTerm(opts = {}) {
    const box = $("term-screens");
    // 先用一个探针算出这块地方能放几行几列，开出来就是对的大小，免得 shell 先按 80x24 画一遍
    let cols = 80, rows = 24;
    if (TERM.inst.size) { const a = TERM.inst.get(TERM.cur); if (a) { cols = a.xt.cols; rows = a.xt.rows; } }
    else if (box.clientWidth) {
      cols = Math.max(20, Math.floor((box.clientWidth - 8) / (TERM.font * 0.6)));
      rows = Math.max(5, Math.floor((box.clientHeight - 4) / (TERM.font * 1.2)));
    }
    let r;
    try { r = await api("/api/term/new", { method: "POST", body: JSON.stringify({ cols, rows, ...(opts.login ? { login: opts.login } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }) }); }
    catch (e) { toast(t("新建终端失败：{msg}", { msg: e.message }), true); return; }
    TERM.list.push(r.term);
    TERM.cur = r.term.id;
    renderTermTabs();
    showTerm(r.term.id);
  }

  function renderTermTabs() {
    $("term-tabs").innerHTML = TERM.list.map((x) => `
      <span class="term-tab ${x.id === TERM.cur ? "cur" : ""} ${x.alive === false ? "dead" : ""}" data-id="${x.id}">
        <span class="tt-name">${esc(x.title)}</span><span class="tt-x" data-x="1" aria-label="${esc(t("关闭"))}">×</span>
      </span>`).join("");
    $("term-tabs").querySelectorAll(".term-tab").forEach((el) => el.addEventListener("click", (e) => {
      const id = el.dataset.id;
      if (e.target.dataset.x) return killTerm(id);
      TERM.cur = id; renderTermTabs(); showTerm(id);
    }));
  }

  async function killTerm(id) {
    const x = TERM.list.find((y) => y.id === id);
    if (x && x.alive !== false && !confirm(t("关闭这个终端？里面正在跑的程序会被结束。"))) return;
    try { await api(`/api/term/${id}/kill`, { method: "POST", body: "{}" }); } catch {}
    const a = TERM.inst.get(id);
    if (a) { try { a.es?.close(); } catch {} a.ro?.disconnect(); a.xt.dispose(); a.el.remove(); TERM.inst.delete(id); }
    TERM.list = TERM.list.filter((y) => y.id !== id);
    if (TERM.cur === id) TERM.cur = TERM.list.length ? TERM.list[TERM.list.length - 1].id : null;
    renderTermTabs();
    if (TERM.cur) showTerm(TERM.cur); else closeTerm();
  }

  function showTerm(id) {
    for (const [k, a] of TERM.inst) a.el.classList.toggle("hidden", k !== id);
    let a = TERM.inst.get(id);
    if (!a) a = mountTerm(id);
    requestAnimationFrame(() => { termFit(a); a.xt.focus(); });
  }

  function mountTerm(id) {
    const el = document.createElement("div");
    el.className = "term-screen";
    $("term-screens").appendChild(el);
    const xt = new window.Terminal({
      fontSize: TERM.font, fontFamily: "'CC Mono', ui-monospace, 'Droid Sans Mono', 'Noto Sans Mono CJK SC', monospace",
      theme: termTheme(), scrollback: 5000, cursorBlink: true, allowProposedApi: false,
      macOptionIsMeta: true, convertEol: false,
      // claude 打的 OSC 8 超链接（登录授权页等）：交给系统浏览器，别在 WebView 里开
      linkHandler: { activate: (e, uri) => openExternal(uri), allowNonHttpProtocols: false },
    });
    const fit = new window.FitAddon.FitAddon();
    xt.loadAddon(fit);
    xt.open(el);
    const a = { id, el, xt, fit, es: null, ro: null, q: "", sending: Promise.resolve(), timer: 0, cols: 0, rows: 0 };
    TERM.inst.set(id, a);

    xt.onData((d) => termSend(a, termMods(d)));
    // 终端里的网址点一下就用系统浏览器打开（登录授权页那种长地址会折成好几行，按折行拼回来再找）
    xt.registerLinkProvider({
      provideLinks(y, cb) {
        const buf = xt.buffer.active;
        let top = y - 1;
        while (top > 0 && buf.getLine(top)?.isWrapped) top--;
        let text = "", rows = [];
        for (let i = top; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (!ln || (i > top && !ln.isWrapped)) break;
          const s = ln.translateToString(false).padEnd(xt.cols).slice(0, xt.cols);
          rows.push(i); text += s;
        }
        const out = [];
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
          const at = (k) => ({ x: (k % xt.cols) + 1, y: rows[Math.floor(k / xt.cols)] + 1 });
          const st = at(m.index), en = at(m.index + m[0].length - 1);
          if (y < st.y || y > en.y) continue;
          const url = m[0];
          out.push({ range: { start: st, end: en }, text: url, activate: () => openExternal(url) });
        }
        cb(out.length ? out : undefined);
      },
    });
    xt.onTitleChange((s) => {
      const x = TERM.list.find((y) => y.id === id);
      if (x && s) { x.title = s.slice(0, 40); renderTermTabs(); }
    });
    a.ro = new ResizeObserver(() => termFit(a));
    a.ro.observe(el);

    const es = new EventSource(`/api/term/${id}/stream`);
    a.es = es;
    es.addEventListener("replay", (m) => { xt.reset(); try { xt.write(JSON.parse(m.data)); } catch {} });
    es.addEventListener("o", (m) => { try { xt.write(JSON.parse(m.data)); } catch {} });
    es.addEventListener("exit", (m) => {
      let code = null; try { code = JSON.parse(m.data).code; } catch {}
      es.close();
      xt.write("\r\n\x1b[2m" + t("[进程已退出，代码 {code}]", { code }) + "\x1b[0m\r\n");
      const x = TERM.list.find((y) => y.id === id);
      if (x) { x.alive = false; x.code = code; renderTermTabs(); }
    });
    // 网关重启后这个终端就没了：别让 EventSource 无限重连
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      xt.write("\r\n\x1b[2m" + t("[与网关的连接已断开]") + "\x1b[0m\r\n");
    };
    return a;
  }

  /** 粘住的 Ctrl / Alt 作用到下一次输入（软键盘打出来的字、底排的键都算） */
  function termMods(d) {
    if (!TERM.ctrl && !TERM.alt) return d;
    if (TERM.ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      else if (d === " ") d = "\x00";
      else if (d === "?") d = "\x7f";
    }
    if (TERM.alt) d = "\x1b" + d;
    TERM.ctrl = TERM.alt = false;
    renderTermKeys();
    return d;
  }

  function termSend(a, d) {
    a.q += d;
    if (a.timer) return;
    a.timer = setTimeout(() => {
      const body = a.q;
      a.q = ""; a.timer = 0;
      // 串起来发，保证顺序（并发的 fetch 不保证先到先处理）
      a.sending = a.sending.then(() => fetch(`/api/term/${a.id}/in`, { method: "POST", body }).catch(() => {}));
    }, 6);
  }

  function termFit(a) {
    if (!a || a.el.classList.contains("hidden") || !a.el.clientWidth) return;
    try { a.fit.fit(); } catch { return; }
    if (a.xt.cols === a.cols && a.xt.rows === a.rows) return;
    a.cols = a.xt.cols; a.rows = a.xt.rows;
    clearTimeout(a.rt);
    a.rt = setTimeout(() => api(`/api/term/${a.id}/resize`, {
      method: "POST", body: JSON.stringify({ cols: a.cols, rows: a.rows }),
    }).catch(() => {}), 120);
  }

  const TERM_KEYS = [
    ["Esc", "\x1b"], ["Tab", "\t"], ["⌫", "\x7f"], ["Del", "\x1b[3~"], ["Ctrl", "ctrl"], ["Alt", "alt"],
    ["←", "\x1b[D"], ["↓", "\x1b[B"], ["↑", "\x1b[A"], ["→", "\x1b[C"],
    ["Home", "\x1b[H"], ["End", "\x1b[F"], ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"],
    ["|", "|"], ["~", "~"], ["/", "/"], ["-", "-"],
    ["\u0000clip", "paste"], ["A−", "font-"], ["A+", "font+"],
  ];

  function renderTermKeys() {
    $("term-keys").innerHTML = TERM_KEYS.map(([l, k], i) =>
      `<button class="tk ${(k === "ctrl" && TERM.ctrl) || (k === "alt" && TERM.alt) ? "on" : ""}" data-i="${i}">${l === "\u0000clip" ? uiI("clip") : esc(l)}</button>`).join("");
  }

  // 长按连发：退格、删除、方向键按住不放就一直发（先等 400ms，之后每 60ms 一下）
  const TK_REPEAT = new Set(["\x7f", "\x1b[3~", "\x1b[D", "\x1b[B", "\x1b[A", "\x1b[C"]);
  let tkHold = null;
  const tkStop = () => { if (tkHold) { clearTimeout(tkHold.t); clearInterval(tkHold.iv); } };
  $("term-keys").addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".tk");
    if (!b) return;
    e.preventDefault();   // 别抢走焦点，否则软键盘会收起
    tkStop();
    if (!TK_REPEAT.has(TERM_KEYS[Number(b.dataset.i)][1])) { tkHold = null; return; }
    const h = tkHold = { fired: false, iv: 0 };
    h.t = setTimeout(() => { h.fired = true; h.iv = setInterval(() => b.click(), 60); b.click(); }, 400);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) $("term-keys").addEventListener(ev, tkStop);
  // 按住不放约半秒，WebView 会当成长按弹菜单，随即 pointercancel 把连发掐断：补键行上不要长按菜单
  $("term-keys").addEventListener("contextmenu", (e) => e.preventDefault());
  // 有的输入法（实测联想平板自带的）在键盘上沿往上还占着一窄条看不见的触摸区（约 22px），
  // 盖住补键行中间几个键的下半截，点了没反应。键盘弹起时给补键行底下垫一点，把按钮整个抬过去。
  // 判断键盘：同一宽度下窗口高度比见过的最大高度矮了两成以上
  let tkW = 0, tkH = 0;
  const tkKb = () => {
    if (innerWidth !== tkW) { tkW = innerWidth; tkH = 0; }
    tkH = Math.max(tkH, innerHeight);
    $("term-keys").classList.toggle("kb-open", innerHeight < tkH * 0.8);
  };
  addEventListener("resize", tkKb);
  tkKb();
  $("term-keys").addEventListener("click", async (e) => {
    const b = e.target.closest(".tk");
    if (!b) return;
    // 连发过的那次松手，系统还会补一个 click，吞掉它
    if (e.isTrusted && tkHold && tkHold.fired) { tkHold = null; return; }
    const k = TERM_KEYS[Number(b.dataset.i)][1];
    const a = TERM.inst.get(TERM.cur);
    if (k === "ctrl") { TERM.ctrl = !TERM.ctrl; return renderTermKeys(); }
    if (k === "alt") { TERM.alt = !TERM.alt; return renderTermKeys(); }
    if (k === "font-" || k === "font+") {
      TERM.font = Math.max(8, Math.min(28, TERM.font + (k === "font+" ? 1 : -1)));
      localStorage.setItem("cc.term.font", TERM.font);
      for (const x of TERM.inst.values()) { x.xt.options.fontSize = TERM.font; termFit(x); }
      return;
    }
    if (!a) return;
    if (k === "paste") {
      let s = "";
      try { s = await navigator.clipboard.readText(); } catch {}
      if (!s) s = prompt(t("粘贴到终端：")) || "";
      if (s) a.xt.paste(s);
      return a.xt.focus();
    }
    // 方向键在应用光标模式（vim、less…）下要换成 ESC O x
    let d = k;
    if (a.xt.modes.applicationCursorKeysMode && /^\x1b\[[ABCDHF]$/.test(d)) d = "\x1bO" + d[2];
    termSend(a, termMods(d));
  });

  // 文本视图：xterm 在触屏上选不了字，把缓冲区摊成普通文本，用系统的长按选择
  $("term-text").addEventListener("click", () => {
    const a = TERM.inst.get(TERM.cur);
    if (!a) return;
    const b = a.xt.buffer.active, lines = [];
    for (let i = Math.max(0, b.length - 3000); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    $("term-text-pre").textContent = lines.join("\n");
    $("term-textview").classList.remove("hidden");
    const pre = $("term-text-pre");
    pre.scrollTop = pre.scrollHeight;
  });
  $("term-text-copy").addEventListener("click", () => {
    const sel = String(getSelection() || "");
    copyText(sel || $("term-text-pre").textContent);
    toast(sel ? t("已复制选中内容") : t("已复制全部"));
  });
  $("term-text-close").addEventListener("click", () => $("term-textview").classList.add("hidden"));

  $("term-close").addEventListener("click", closeTerm);
  $("term-new").addEventListener("click", newTerm);
  $("btn-term").addEventListener("click", openTerm);
  renderTermKeys();
  // 换主题时跟着换
  new MutationObserver(() => { for (const a of TERM.inst.values()) a.xt.options.theme = termTheme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });


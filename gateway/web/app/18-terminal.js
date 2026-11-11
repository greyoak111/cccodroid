  // ── 应用内终端 ────────────────────────────────────────────────────
  // xterm.js 按需加载（近 500 KB，不开终端就不付这个钱）；每个终端一个 xterm 实例，
  // 输出走 /api/term/<id>/stream（SSE，先回放缓冲），按键攒一小撮再按顺序 POST。
  // 手机键盘没有 Esc / Ctrl / 方向键：底下一排补上，Ctrl / Alt 是「粘住」的，作用于下一个键。
  const termEl = $("term");
  const TERM = {
    list: [], cur: null, inst: new Map(), loaded: null, ctrl: false, alt: false,
    gen: 0,   // 每收起一次面板加一：打开途中被收起的那次，迟到的回执不再建终端、不再连输出流（#177-1）
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

  // 宽屏下窗格已经开着、被别的盖住：再点入口要把它提到最上面（审查 UI05-001）
  const raisePane = (id) => window.CCLayout && CCLayout.raise(id);
  // 首次加载 xterm 时连点两下顶栏入口：两次都拿到空列表、各建一个终端（审查 UI05-004）
  // 收起后再打开：上一次已经作废，重新开一次（closeTerm 清掉了 TERM.opening）
  function openTerm(opts = {}) {
    if (TERM.opening) { MO.cancel(termEl); termEl.classList.remove("hidden"); raisePane("term"); return TERM.opening; }
    const p = openTerm0(opts).finally(() => { if (TERM.opening === p) TERM.opening = null; });
    return (TERM.opening = p);
  }
  async function openTerm0(opts = {}) {
    MO.cancel(termEl); termEl.classList.remove("hidden"); raisePane("term");
    const g = TERM.gen;
    try { await loadXterm(); } catch (e) { if (g === TERM.gen) toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    if (g !== TERM.gen) return;
    let r;
    try { r = await api("/api/term/list"); } catch (e) { if (g === TERM.gen) toast(t("终端打不开：{msg}", { msg: e.message }), true); return; }
    if (g !== TERM.gen) return;
    if (!r.available) { toast(t("找不到伪终端程序（ptyhost / python3）"), true); return; }
    const srv = r.terms || [];
    // 本界面开着、网关却不认识了（网关重启过）：标成已退出，留着看最后的输出
    for (const x of TERM.list) if (TERM.inst.has(x.id) && !srv.some((y) => y.id === x.id)) srv.push(Object.assign(x, { alive: false }));
    // 已退出的：本界面开过的留着，别处留下的不显示
    TERM.list = srv.filter((x) => x.alive || TERM.inst.has(x.id));
    const live = TERM.list.filter((x) => x.alive);
    // 没有终端时直接按目标目录开一个：以前先开一个默认 bash，再开一个目标目录的（195-H.6）
    // 带目录的显式入口在同步后必须兑现：页面重建后本地列表还是空的，网关上却可能留着别的目录的终端，
    // 不能因为「已经有活终端」就只显示旧的（BUG-G01）
    if (!live.length || opts.cwd) return newTerm({ gen: g, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    if (!TERM.list.some((x) => x.id === TERM.cur)) TERM.cur = live[live.length - 1].id;
    renderTermTabs();
    showTerm(TERM.cur);
  }

  function closeTerm() {
    TERM.gen++; TERM.opening = null;
    $("term-textview").classList.add("hidden");
    MO.hide(termEl, MO.paneOut());
    TERM.inst.get(TERM.cur)?.xt.blur();
    for (const a of TERM.inst.values()) termDetach(a);   // 收起了就不占连接，下次打开重连回放
  }

  /** 手动登录：开一个新终端，网关替你敲好 claude auth login；授权码贴给 claude 自己的提示 */
  async function openLoginTerm(method) {
    MO.cancel(termEl); termEl.classList.remove("hidden"); raisePane("term");
    try { await loadXterm(); } catch (e) { toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    try { const r = await api("/api/term/list"); TERM.list = (r.terms || []).filter((x) => x.alive || TERM.inst.has(x.id)); } catch {}
    await newTerm({ login: method === "console" ? "console" : true });
  }

  async function newTerm(opts = {}) {
    // 没显式带 gen 的入口（「+」、登录、项目目录）也要按发起时的世代记账：收起面板后迟到的回执
    // 不能挂在隐藏的面板里连 SSE、占名额（195-H.7）
    const gen = opts.gen != null ? opts.gen : TERM.gen;
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
    // 建的途中面板被收起了：终端已经在网关那边，留在标签里，下次打开时再连（不给藏着的面板挂输出流、抢焦点）
    if (gen !== TERM.gen) return;
    TERM.cur = r.term.id;
    renderTermTabs();
    showTerm(r.term.id);
  }

  function renderTermTabs() {
    $("term-tabs").innerHTML = TERM.list.map((x) => `
      <span class="term-tab ${x.id === TERM.cur ? "cur" : ""} ${x.alive === false ? "dead" : ""}" data-id="${esc(x.id)}">
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
    // 关闭失败（网关出错）不能当成关掉了：标签和输出一删，里面的程序却还在跑，人也不知道（审查 C-008）
    // 404 = 网关已经不认识这个终端（重启过），本来就没了，照常清掉
    // 先断本地的输出流再发 kill：连接池满的时候 kill 请求排在它后面，等它就永远等不到（审查 #49 P2-7）
    const a = TERM.inst.get(id);
    if (a) termDetach(a);
    try { await api(`/api/term/${encodeURIComponent(id)}/kill`, { method: "POST", body: "{}" }); }
    catch (e) { if (e.status !== 404) { toast(t("关闭终端失败：{msg}", { msg: e.message }), true); if (a && TERM.cur === id) termAttach(a); return; } }
    if (a) { a.ro?.disconnect(); a.xt.dispose(); a.el.remove(); TERM.inst.delete(id); }
    TERM.list = TERM.list.filter((y) => y.id !== id);
    if (TERM.cur === id) TERM.cur = TERM.list.length ? TERM.list[TERM.list.length - 1].id : null;
    renderTermTabs();
    if (TERM.cur) showTerm(TERM.cur); else closeTerm();
  }

  function showTerm(id) {
    for (const [k, a] of TERM.inst) { a.el.classList.toggle("hidden", k !== id); if (k !== id) termDetach(a); }
    let a = TERM.inst.get(id);
    if (!a) a = mountTerm(id);
    termAttach(a);
    // 被别的窗格盖着时别抢焦点：按键会打进看不见的终端（审查 UI05-001）
    requestAnimationFrame(() => { termFit(a); if (!document.documentElement.classList.contains("has-right") || termEl.classList.contains("ws-top")) a.xt.focus(); });
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
    termScrubber(a);

    xt.onData((d) => termSend(a, termMods(d)));
    // 终端里的网址点一下就用系统浏览器打开（登录授权页那种长地址会折成好几行，按折行拼回来再找）
    xt.registerLinkProvider({
      provideLinks(y, cb) {
        const buf = xt.buffer.active;
        let top = y - 1;
        while (top > 0 && buf.getLine(top)?.isWrapped) top--;
        // 逐格取字符，同时记下每个字符在第几列：中文 / emoji 占两格，以前把 UTF-16 下标当列坐标，
        // 中文后面的网址下划线和点击区会错位（195-H.8）
        let text = "";
        const at = [];
        for (let i = top; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (!ln || (i > top && !ln.isWrapped)) break;
          for (let x = 0; x < xt.cols; x++) {
            const cell = ln.getCell(x);
            const ch = cell ? cell.getChars() : "";
            for (let k = 0; k < ch.length; k++) { text += ch[k]; at.push({ x: x + 1, y: i + 1 }); }
          }
        }
        const out = [];
        // 规则同聊天区：中文标点、句末标点、配不上对的右括号不算网址（审查 F3）
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>）】」，。；、]+/g)) {
          let url = m[0].replace(/[.,;:!?*]+$/, "");
          while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1).replace(/[.,;:!?*]+$/, "");
          if (!url) continue;
          const st = at[m.index], en = at[m.index + url.length - 1];
          if (!st || !en) continue;
          if (y < st.y || y > en.y) continue;
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

    return a;
  }

  /** 只有正在看的终端连着输出流：每个终端一条常驻 SSE，开到五六个就把同源连接占满，
   *  输入、关闭、别的接口全排队（审查 #49 P2-7）。连上时网关先发 replay（整段缓冲），切回来照样接得上 */
  function termDetach(a) { if (a.es) { try { a.es.close(); } catch {} a.es = null; } a.cols = a.rows = 0; }   // 再连上时补发一次 resize（195-H.1）
  function termAttach(a) {
    if (a.es || a.exited) return;
    const { id, xt } = a;
    const es = new EventSource(`/api/term/${encodeURIComponent(id)}/stream`);
    a.es = es;
    es.addEventListener("replay", (m) => {
      // { data, total }：只补上次画过之后的新内容，xterm 里已有的回滚和历史留着（195-H.1）。
      // 缺得太多（超过网关的环形缓冲）就只能整段重来
      let j; try { j = JSON.parse(m.data); } catch { return; }
      const data = typeof j === "string" ? j : j.data || "";
      const total = typeof j === "string" ? null : j.total;
      if (typeof total === "number" && typeof a.seen === "number" && total >= a.seen && total - a.seen <= data.length) {
        if (total > a.seen) xt.write(data.slice(data.length - (total - a.seen)));
      } else {
        // 缺的超过回放环（256KB）：中间那段已经拿不回来了，重置后说一声，别让人以为输出是连着的（FIND-045）
        const lost = typeof total === "number" && typeof a.seen === "number" && total > a.seen;
        xt.reset();
        if (lost) xt.write("\x1b[2m" + t("…（已截断）") + "\x1b[0m\r\n");
        xt.write(data);
      }
      if (typeof total === "number") a.seen = total;
    });
    es.addEventListener("o", (m) => {
      let s; try { s = JSON.parse(m.data); } catch { return; }
      xt.write(s);
      if (typeof a.seen === "number") a.seen += String(s).length;
    });
    es.addEventListener("exit", (m) => {
      let code = null; try { code = JSON.parse(m.data).code; } catch {}
      es.close(); if (a.es === es) a.es = null; a.exited = true;
      xt.write("\r\n\x1b[2m" + t("[进程已退出，代码 {code}]", { code }) + "\x1b[0m\r\n");
      const x = TERM.list.find((y) => y.id === id);
      if (x) { x.alive = false; x.code = code; renderTermTabs(); }
    });
    // 网关重启后这个终端就没了：重连拿到 404，EventSource 自己停下，这时说一声并标成已退出（195-H.4）。
    // 网关整个没了的时候它一直停在「连接中」，以前什么都不显示（复审 中12）：第一次断就先提示在重连
    let lost = false;
    es.onopen = () => { lost = false; };
    es.onerror = () => {
      if (a.exited) return;   // 正常退出后连接关闭，不再补一句
      if (es.readyState === EventSource.CLOSED) {
        es.close(); if (a.es === es) a.es = null; a.exited = true;
        const x = TERM.list.find((y) => y.id === id);
        if (x) { x.alive = false; renderTermTabs(); }
        xt.write("\r\n\x1b[2m" + t("[与网关的连接已断开]") + "\x1b[0m\r\n");
        return;
      }
      if (!lost) { lost = true; xt.write("\r\n\x1b[2m" + t("[与网关的连接断了，正在重连…]") + "\x1b[0m\r\n"); }
    };
  }

  /** 粘住的 Ctrl / Alt 作用到下一次输入（软键盘打出来的字、底排的键都算） */
  function termMods(d) {
    if (!TERM.ctrl && !TERM.alt) return d;
    // 一整块（粘贴、输入法一次交上来的词）不吃粘住的 Ctrl / Alt，也不把它消耗掉：留给下一个单键（审查 F7）
    // 括号粘贴（\x1b[200~…\x1b[201~）也是一整块，虽然以 ESC 开头：给它加 ESC 前缀就把粘贴标记弄坏了（11-04 报告 三）
    if (d.length > 1 && (!d.startsWith("\x1b") || d.startsWith("\x1b[200~"))) return d;
    if (TERM.ctrl) {
      if (d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
        else if (d === " ") d = "\x00";
        else if (d === "?") d = "\x7f";
        else if (d === "\x7f") d = "\x08";      // Ctrl+退格
      } else {
        // 方向键 / Home / End / PgUp / PgDn / Del 这类多字符 ESC 序列：按 xterm 的规矩把修饰键放进参数
        // （以前这些键直接跳过 Ctrl 分支，粘住的 Ctrl 被静默清掉，195-H.2）
        const m = /^\x1b\[([0-9]*)([ABCDHF])$/.exec(d);
        if (m) d = `\x1b[${m[1] ? m[1] + ";" : "1;"}5${m[2]}`;
        else { const t = /^\x1b\[([0-9]+)~$/.exec(d); if (t) d = `\x1b[${t[1]};5~`; }
      }
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
      // 没送到要说一声：网关重启时按键无声丢掉，人以为命令已经发出去了（审查 F4）
      a.sending = a.sending.then(() => fetch(`/api/term/${encodeURIComponent(a.id)}/in`, { method: "POST", body })
        .then((r) => {
          // 进程已退出：网关回 409（195-H.5），说清楚，别当成网关在重启
          if (r.status === 409) {
            if (!a.exitedHint) { a.exitedHint = true; a.xt.write("\r\n\x1b[2m" + t("[终端已退出，输入没有送出去]") + "\x1b[0m\r\n"); }
            return;
          }
          if (!r.ok) throw new Error("HTTP " + r.status);
        })
        .catch(() => { if (!a.lostIn) { a.lostIn = true; a.xt.write("\r\n\x1b[2m" + t("[输入没送到终端，网关可能在重启]") + "\x1b[0m\r\n"); setTimeout(() => { a.lostIn = false; }, 3000); } }));
    }, 6);
  }

  function termFit(a) {
    if (!a || a.el.classList.contains("hidden") || !a.el.clientWidth) return;
    try { a.fit.fit(); } catch { return; }
    a.sbPaint?.(true);
    if (a.xt.cols === a.cols && a.xt.rows === a.rows) return;
    a.cols = a.xt.cols; a.rows = a.xt.rows;
    clearTimeout(a.rt);
    a.rt = setTimeout(() => api(`/api/term/${encodeURIComponent(a.id)}/resize`, {
      method: "POST", body: JSON.stringify({ cols: a.cols, rows: a.rows }),
    }).catch(() => {}), 120);
  }

  // 右侧滑块自己画：xterm 6 自带的是 VS Code 那套滚动条，滑块 14×20px，触摸拖动时 xterm 自己的触摸滚动也在响应（方向还相反），
  // 两边打架、拖着不跟手。这里藏掉它（样式表），换一条触摸友好的：右边 22px 都能抓，滑块至少 44px 高；
  // 拖动时滑块严格跟手指走、按比例 scrollToLine；点轨道空白处滑块中心跳过去。滑块是 .xterm 的兄弟节点，xterm 收不到这些触摸
  function termScrubber(a) {
    const bar = document.createElement("div");
    bar.className = "term-sb none";
    bar.innerHTML = "<i></i>";
    const th = bar.firstChild;
    a.el.appendChild(bar);
    let H = 0, h = 0, top = 0, drag = null, raf = 0;
    const span = () => { const b = a.xt.buffer.active; return { max: Math.max(0, b.length - a.xt.rows), y: b.viewportY, len: b.length }; };
    const place = (t) => { top = t; th.style.transform = `translateY(${t}px)`; };
    function paint(measure) {
      if (measure || !H) H = a.el.clientHeight;   // 量终端区（滑块条和它一样高）：滑块条藏着时 display:none，量它永远是 0
      const { max, y, len } = span();
      bar.classList.toggle("none", max <= 0 || !H);
      if (max <= 0 || !H) return;
      const nh = Math.max(44, Math.round(H * a.xt.rows / len));
      if (nh !== h) { h = nh; th.style.height = h + "px"; }
      if (!drag) place(Math.round((H - h) * y / max));
    }
    a.sbPaint = (measure) => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; paint(measure); }); };
    a.xt.onScroll(() => a.sbPaint());
    a.xt.onWriteParsed(() => a.sbPaint());
    const move = (e) => {
      if (!drag) return;
      const room = H - h, t = Math.min(room, Math.max(0, e.clientY - drag.y0 - drag.off));
      place(t);
      a.xt.scrollToLine(Math.round(span().max * (room > 0 ? t / room : 0)));
    };
    bar.addEventListener("pointerdown", (e) => {
      if (bar.classList.contains("none")) return;
      e.preventDefault(); e.stopPropagation();
      try { bar.setPointerCapture(e.pointerId); } catch {}
      paint(true);
      const y0 = bar.getBoundingClientRect().top, at = e.clientY - y0;
      // 按在滑块上：抓住的那一点跟着手指；按在轨道上：滑块中心跳到手指处
      drag = { y0, off: at >= top && at <= top + h ? at - top : h / 2 };
      bar.classList.add("drag");
      move(e);
    });
    bar.addEventListener("pointermove", move);
    const end = () => { if (!drag) return; drag = null; bar.classList.remove("drag"); paint(); };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
    bar.addEventListener("lostpointercapture", end);
    a.sbPaint(true);
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
      // 剪贴板里自带的括号粘贴结束标记会提前结束粘贴，后面的内容被 shell 当命令执行（199-4.02）：去掉
      if (s) a.xt.paste(s.replace(/\x1b\[20[01]~/g, ""));
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
    TERM.tvCut = b.length > 3000;   // 只导出最后 3000 行：复制提示不能说「已复制全部」（195-H.3）
    for (let i = Math.max(0, b.length - 3000); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    $("term-text-pre").textContent = lines.join("\n");
    $("term-textview").classList.remove("hidden");
    raisePane("term");
    const pre = $("term-text-pre");
    pre.scrollTop = pre.scrollHeight;
  });
  $("term-text-copy").addEventListener("click", async () => {
    const sel = String(getSelection() || "");
    const ok = await copyText(sel || $("term-text-pre").textContent);
    if (!ok) return toast(t("复制失败，请长按选择文字再复制"), true);
    toast(sel ? t("已复制选中内容") : TERM.tvCut ? t("已复制最后 3000 行") : t("已复制全部"));
  });
  $("term-text-close").addEventListener("click", () => $("term-textview").classList.add("hidden"));

  $("term-close").addEventListener("click", closeTerm);
  $("term-new").addEventListener("click", newTerm);
  $("btn-term").addEventListener("click", openTerm);
  renderTermKeys();
  // 换主题、换外观（data-skin）、改强调色（html 上的 style 变量）时跟着换；一帧里只重算一次（11-04 报告 三）
  let themeRaf = 0;
  new MutationObserver(() => {
    if (themeRaf || !TERM.inst.size) return;
    themeRaf = requestAnimationFrame(() => { themeRaf = 0; const th = termTheme(); for (const a of TERM.inst.values()) a.xt.options.theme = th; });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin", "style"] });


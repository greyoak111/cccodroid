// Worker 内的表格模型：工作簿不回传，逐页只交付有界的转义 HTML。
(function (scope) {
  "use strict";
  const MAX_R = 5000, MAX_C = 200, PAGE_CELLS = 1200, PAGE_ROWS = 120, PAGE_HTML = 256 * 1024;   // UTF-16 正文至多 512KiB
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tooBig = () => { const e = new Error("sheet budget"); e.code = "tooBig"; return e; };
  function zipExpandsTooMuch(buf) {
    const b = new Uint8Array(buf);
    if (b[0] !== 0x50 || b[1] !== 0x4b) return false;
    if (b.length < 22) return true;
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { end = i; break; }
    }
    if (end < 0) return true;
    const dv = new DataView(buf), count = dv.getUint16(end + 10, true);
    let off = dv.getUint32(end + 16, true), total = 0;
    if (count === 0xffff || off === 0xffffffff || dv.getUint32(end + 12, true) === 0xffffffff) return true;
    for (let n = 0; n < count; n++) {
      if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) return true;
      const size = dv.getUint32(off + 24, true);
      if (size === 0xffffffff || size > 128 * 1024 * 1024 || (total += size) > 256 * 1024 * 1024) return true;
      off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
      if (off > end) return true;
    }
    return false;
  }
  function sheetText(cell, wb, X) {
    if (!cell) return "";
    const w = cell.w != null ? String(cell.w) : String(cell.v ?? "");
    if (cell.t === "n" && cell.z && /^\d{1,2}\/\d{1,2}\/\d{2,4}( |$)/.test(w) && X.SSF.is_date(cell.z)) {
      const d = X.SSF.parse_date_code(cell.v, wb?.Workbook?.WBProps?.date1904 ? { date1904: true } : undefined), p = (n) => String(n).padStart(2, "0");
      if (!d) return w;
      const time = /[hs]/i.test(cell.z.replace(/"[^"]*"/g, ""));
      return `${d.y}-${p(d.m)}-${p(d.d)}${time ? ` ${p(d.H)}:${p(d.M)}${d.S ? ":" + p(d.S) : ""}` : ""}`;
    }
    return w;
  }
  function create(wb, X) {
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [], visible = wb.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden));
    const names = visible.length ? visible : wb.SheetNames;
    if (names.length > 1000 || names.reduce((n, s) => n + s.length, 0) > 65536) throw tooBig();
    let active = null;
    const valid = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
    function sheet(i) {
      if (!Number.isInteger(i) || i < 0 || i >= names.length) throw new Error("sheet index");
      if (active && active.i === i) return active;
      active = null;
      const ws = wb.Sheets[names[i]];
      if (!ws || !ws["!ref"]) return active = { i, empty: true };
      let rg;
      try {
        rg = X.utils.decode_range(ws["!ref"]);
        if (!valid(rg.s.r, 1048575) || !valid(rg.e.r, 1048575) || !valid(rg.s.c, 16383) || !valid(rg.e.c, 16383) || rg.s.r > rg.e.r || rg.s.c > rg.e.c) throw 0;
      } catch { return active = { i, badRange: true }; }
      const r1 = Math.min(rg.e.r, rg.s.r + MAX_R - 1), c1 = Math.min(rg.e.c, rg.s.c + MAX_C - 1), W = c1 - rg.s.c + 1;
      const cols = ws["!cols"] || [], rows = ws["!rows"] || [], hid = (c) => cols[c] && cols[c].hidden, hidR = (r) => rows[r] && rows[r].hidden;
      const cov = new Uint8Array((r1 - rg.s.r + 1) * W), spans = new Map(), sources = new Map();
      const covered = (r, c) => cov[(r - rg.s.r) * W + c - rg.s.c] === 1;
      let budget = 2 * cov.length, seen = 0;
      for (const m of ws["!merges"] || []) {
        if (++seen > 20000) break;
        if (!m || !m.s || !m.e || !valid(m.s.r, 1048575) || !valid(m.e.r, 1048575) || !valid(m.s.c, 16383) || !valid(m.e.c, 16383) || m.s.r > r1 || m.s.c > c1 || m.s.r < rg.s.r || m.s.c < rg.s.c || m.e.r < m.s.r || m.e.c < m.s.c) continue;
        const er = Math.min(m.e.r, r1), ec = Math.min(m.e.c, c1), key = m.s.r + "," + m.s.c;
        if (spans.has(key) || covered(m.s.r, m.s.c)) continue;
        if ((budget -= (er - m.s.r + 1) * (ec - m.s.c + 1)) < 0) break;
        for (let r = m.s.r; r <= er; r++) cov.fill(1, (r - rg.s.r) * W + m.s.c - rg.s.c, (r - rg.s.r) * W + ec - rg.s.c + 1);
        let ar = -1, ac = -1, nr = 0, nc = 0;
        for (let r = m.s.r; r <= er; r++) if (!hidR(r)) { if (ar < 0) ar = r; nr++; }
        for (let c = m.s.c; c <= ec; c++) if (!hid(c)) { if (ac < 0) ac = c; nc++; }
        if (!nr || !nc) continue;
        const at = ar + "," + ac;
        spans.set(at, [nr, nc]);
        if (at !== key) sources.set(at, m.s);
        cov[(ar - rg.s.r) * W + ac - rg.s.c] = 2;
      }
      const visibleCols = [];
      let head = '<colgroup><col class="rh">', labels = '<thead><tr><th class="corner"></th>';
      for (let c = rg.s.c; c <= c1; c++) {
        if (hid(c)) continue;
        visibleCols.push(c);
        const width = cols[c] ? cols[c].wpx || (cols[c].wch ? cols[c].wch * 7 + 5 : 0) : 0;
        head += `<col style="width:${width ? Math.max(24, Math.min(400, Math.round(width))) : 80}px">`;
        labels += `<th>${X.utils.encode_col(c)}</th>`;
      }
      active = { i, ws, rg, r1, c1, hidR, visibleCols, spans, sources, covered, header: head + '</colgroup>' + labels + '</tr></thead>' };
      return active;
    }
    function page(i, from) {
      const s = sheet(i);
      if (s.empty || s.badRange) return { empty: !!s.empty, badRange: !!s.badRange };
      from = from == null ? s.rg.s.r : from;
      if (!Number.isInteger(from) || from < s.rg.s.r || from > s.r1 + 1) throw new Error("sheet page");
      let r = from, cells = 0, html = "", rows = 0;
      while (r <= s.r1) {
        if (s.hidR(r)) { r++; continue; }
        if (rows >= PAGE_ROWS || (rows && cells + s.visibleCols.length > PAGE_CELLS)) break;
        let row = `<tr data-r="${r}"><th>${r + 1}</th>`;
        for (const c of s.visibleCols) {
          if (s.covered(r, c)) continue;
          const key = r + "," + c, addr = X.utils.encode_cell(s.sources.get(key) || { r, c }), cell = s.ws[addr], span = s.spans.get(key), text = sheetText(cell, wb, X);
          // 异常巨格不截断冒充完整内容；拒绝后仍可用原版式 / 分享打开。
          if (text.length > PAGE_HTML) throw tooBig();
          row += `<td data-c="${c}" data-a="${addr}"${span ? ` rowspan="${span[0]}" colspan="${span[1]}"` : ""}${cell && (cell.t === "n" || cell.t === "d") ? ' class="n"' : cell && cell.t === "e" ? ' class="err"' : ""}>${esc(text)}</td>`;
          if (row.length > PAGE_HTML) throw tooBig();
        }
        row += '</tr>';
        if (html.length + row.length > PAGE_HTML) { if (!rows) throw tooBig(); break; }
        html += row; rows++; cells += s.visibleCols.length; r++;
        if (cells >= PAGE_CELLS) break;
      }
      return { first: from === s.rg.s.r, header: from === s.rg.s.r ? s.header : "", html, next: r, done: r > s.r1,
        total: s.r1 - s.rg.s.r + 1, remaining: Math.max(0, s.r1 - r + 1), step: Math.min(PAGE_ROWS, Math.max(1, Math.floor(PAGE_CELLS / Math.max(1, s.visibleCols.length)))),
        range: X.utils.encode_range(s.rg), cut: s.rg.e.r > s.r1 || s.rg.e.c > s.c1, rows: s.r1 - s.rg.s.r + 1, cols: s.c1 - s.rg.s.c + 1 };
    }
    function cell(i, addr) {
      const s = sheet(i);
      if (s.empty || s.badRange || typeof addr !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(addr)) throw new Error("sheet cell");
      const c = X.utils.decode_cell(addr);
      if (!valid(c.r, 1048575) || !valid(c.c, 16383) || c.r < s.rg.s.r || c.r > s.r1 || c.c < s.rg.s.c || c.c > s.c1) throw new Error("sheet cell range");
      const value = s.ws[addr], text = sheetText(value, wb, X), formula = value && value.f ? String(value.f) : "";
      if (text.length + formula.length > PAGE_HTML) throw tooBig();
      return { addr, text, formula };
    }
    return { names, page, cell };
  }
  scope.SheetPreview = { create, zipExpandsTooMuch, sheetText };
})(globalThis);

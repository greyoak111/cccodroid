// 外观皮肤 × 深浅主题对比度与样式覆写回归测试：
// 从真实的 style.css 和 theme.js 采样并按 WCAG 2.1 算对比度，防止「浅底浅字」「深底深字」「皮肤覆盖冲突」回流。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const css = read("style.css");
const themeSrc = read("theme.js");
const src04 = read("app/04-session-flow.js");

const hex2rgb = (h) => {
  h = h.trim();
  if (/^#[0-9a-f]{3}$/i.test(h)) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const lum = (h) => {
  const c = hex2rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// 直接从 theme.js 提取真实的 shiseScheme + shiseCss，避免测试里复制算法
function loadShise() {
  const a = themeSrc.indexOf("const hex2rgb =");
  const b = themeSrc.indexOf("function wallSeed()", a);
  assert.ok(a > 0 && b > a, "theme.js shiseScheme 代码块找不到");
  const ctx = {};
  vm.runInNewContext(`${themeSrc.slice(a, b)}\nglobalThis.__shise = { shiseScheme, shiseCss };`, ctx);
  return ctx.__shise;
}
const { shiseScheme, shiseCss } = loadShise();

// 解析顶层 :root / html[data-skin][data-theme] 变量块（按特异性 + 源码顺序叠合）
function parseRootVarBlocks(src) {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let i = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf("{", i);
    if (open < 0) break;
    const sel = stripped.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < stripped.length && depth; j++) {
      if (stripped[j] === "{") depth++;
      else if (stripped[j] === "}") depth--;
    }
    const body = stripped.slice(open + 1, j - 1);
    i = j;
    if (/^@/.test(sel)) continue;
    for (const s of sel.split(",").map((x) => x.trim())) {
      if (!/^(:root|html(\[[^\]]+\])+)$/.test(s)) continue;
      if (/data-uifont|data-readfont|data-fs|dir=/.test(s)) continue;
      const vars = {};
      for (const raw of body.split(";")) {
        const k = raw.indexOf(":");
        if (k < 0) continue;
        const prop = raw.slice(0, k).trim(), val = raw.slice(k + 1).trim();
        if (prop.startsWith("--") && val) vars[prop] = val;
      }
      if (Object.keys(vars).length) out.push({ sel: s, vars });
    }
  }
  return out;
}
const rootBlocks = parseRootVarBlocks(css);

function varsFor(skin, theme, shiseSeed = "#6750a4") {
  const vars = {};
  const spec = (s) => (s === ":root" ? 1 : (s.match(/\[[^\]]+\]/g) || []).length * 10 + 1);
  const matched = rootBlocks
    .filter((b) => {
      if (b.sel === ":root") return true;
      const sm = b.sel.match(/data-skin="([^"]+)"/);
      const tm = b.sel.match(/data-theme="([^"]+)"/);
      if (sm && sm[1] !== skin) return false;
      if (tm && tm[1] !== theme) return false;
      return true;
    })
    .map((b, idx) => ({ ...b, spec: spec(b.sel), idx }))
    .sort((a, b) => a.spec - b.spec || a.idx - b.idx);
  for (const b of matched) Object.assign(vars, b.vars);
  if (skin === "shise") {
    const T = shiseScheme(shiseSeed, theme === "dark");
    for (const raw of shiseCss(T).split(";")) {
      const k = raw.indexOf(":");
      if (k > 0) vars[raw.slice(0, k).trim()] = raw.slice(k + 1).trim();
    }
  }
  const resolve = (val, depth = 0) => {
    if (!val || depth > 8) return val;
    return val.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/gi, (_, name, fb) =>
      vars[name] !== undefined ? resolve(vars[name], depth + 1) : fb ? resolve(fb.trim(), depth + 1) : ""
    );
  };
  for (const k of Object.keys(vars)) vars[k] = resolve(vars[k]);
  return vars;
}

test("五套外观 × 深浅两档：主按钮 / 危险按钮 / 上下文条全部满足 WCAG AA (≥4.5:1)", () => {
  for (const skin of ["native", "qiusuo", "zhuyue", "goucheng", "shise"]) {
    for (const theme of ["dark", "light"]) {
      const v = varsFor(skin, theme);
      const tag = `${skin}/${theme}`;
      const expectContrast = (name, fg, bg, min = 4.5) => {
        const r = contrast(fg, bg);
        assert.ok(r >= min, `${tag} ${name}: contrast ${r.toFixed(2)} < ${min} (fg=${fg}, bg=${bg})`);
      };
      expectContrast(".btn (--on-accent / --accent-btn)", v["--on-accent"], v["--accent-btn"], 4.5);
      expectContrast(".btn.danger (--err-fg / --err-bg)", v["--err-fg"], v["--err-bg"], 4.5);
      expectContrast(".btn.danger-fill (--on-err / --err-btn)", v["--on-err"], v["--err-btn"], 4.5);
      expectContrast("#ctxbar normal unfilled (--fg2 / --bg2)", v["--fg2"], v["--bg2"], 4.5);
      expectContrast("#ctxbar.warn (#111 / --ctx-warn)", "#111111", v["--ctx-warn"], 4.5);
      expectContrast("#ctxbar.danger (#111 / --ctx-err)", "#111111", v["--ctx-err"], 4.5);
      if (skin === "zhuyue") {
        expectContrast(".lt-panel button.pri (--zy-on-blue / --zy-blue)", v["--zy-on-blue"], v["--zy-blue"], 4.5);
      }
    }
  }
});

test("拾色外观跨色相种子：按钮、危险按钮与上下文条均 ≥4.5:1", () => {
  for (const seed of ["#6750a4", "#e5484d", "#f5a623", "#f2d94e", "#46a758", "#0f8b8d", "#2b6fd6", "#c2408a", "#808080"]) {
    for (const theme of ["dark", "light"]) {
      const v = varsFor("shise", theme, seed);
      for (const [name, fg, bg] of [
        ["primary btn", v["--on-accent"], v["--accent-btn"]],
        ["danger-fill", v["--on-err"], v["--err-btn"]],
        ["danger soft", v["--err-fg"], v["--err-bg"]],
        ["ctx-warn", "#111111", v["--ctx-warn"]],
        ["ctx-err", "#111111", v["--ctx-err"]],
      ]) {
        const r = contrast(fg, bg);
        assert.ok(r >= 4.5, `shise/${theme} seed=${seed} ${name}: ${r.toFixed(2)} < 4.5 (fg=${fg}, bg=${bg})`);
      }
    }
  }
});

test("样式覆写守卫：灯箱按钮重置底色、.btn.danger 自带底与边框、导览主钮与多选用 --accent-btn、皮肤不冲掉危险按钮", () => {
  // 1. 图片预览灯箱（shise 浅色下曾因没覆写 background 导致白字叠浅胶囊 1.13:1）
  const lb = css.match(/#lightbox \.btn\.ghost\{([^}]+)\}/);
  assert.ok(lb, "缺少 #lightbox .btn.ghost 规则");
  assert.match(lb[1], /background:/, "#lightbox .btn.ghost 必须显式重置 background，不能继承拾色的浅色胶囊底");
  assert.match(lb[1], /box-shadow:none/, "#lightbox .btn.ghost 应清掉构成皮肤的硬投影");

  // 2. .btn.danger 在 #files (#fs-del) 等外部容器必须自带 background 和 border
  const bd = css.match(/^\.btn\.danger\{([^}]+)\}/m);
  assert.ok(bd, "缺少 .btn.danger 基础规则");
  assert.match(bd[1], /background:var\(--err-bg\)/);
  assert.match(bd[1], /border:1px solid var\(--err-line\)/);

  // 3. .btn.danger-fill 和 .lt-panel button.pri 不再写死 #fff（逐月保留品牌蓝 + --zy-on-blue）
  assert.match(css, /\.btn\.danger-fill\{background:var\(--err-btn\);color:var\(--on-err\)\}/);
  assert.match(css, /\.lt-panel \.lt-btns button\.pri\{background:var\(--zy-blue,var\(--accent-btn\)\);border-color:transparent;color:var\(--zy-on-blue,var\(--on-accent\)\)\}/);
  assert.ok(themeSrc.includes("--zy-on-blue:${on}"), "自定义强调色应同步覆盖 --zy-on-blue");

  // 4. #fs-multi.on 用 --accent-btn 而非低对比度的 --accent
  assert.match(css, /#fs-multi\.on\{background:var\(--accent-btn\);color:var\(--on-accent\);border-color:var\(--accent-btn\)\}/);

  // 5. 构成皮肤不压掉 .btn.ghost.danger 的红字红边；拾色皮肤在 #pages/#set-ov 内也生效
  assert.match(css, /html\[data-skin="goucheng"\] \.btn\.ghost:not\(\.danger\)/);
  assert.match(css, /html\[data-skin="goucheng"\] \.btn\.ghost\.danger/);
  assert.match(css, /html\[data-skin="shise"\] :is\(#pages,#set-ov\) \.btn\.ghost/);

  // 6. 上下文条正常态（非逐月）用实心条 + --p 双色切字；只对 #ctxctx 设透明、绝不扫 #ctxtxt *（避免拍没 #ctxq 额度速览）；逐月保留灰阶渐变；清零时同步重置 --p
  assert.match(css, /html:not\(\[data-skin="zhuyue"\]\) #ctxbar:not\(\.warn\):not\(\.danger\) #ctxfill\{background:var\(--accent-btn\)\}/);
  assert.match(css, /html\[data-skin="zhuyue"\] #ctxbar:not\(\.warn\):not\(\.danger\) #ctxfill\{background:linear-gradient\(90deg,var\(--bg4\),color-mix\(in srgb,var\(--accent\) 30%,var\(--bg4\)\)\)\}/);
  assert.match(css, /html:not\(\[data-skin="zhuyue"\]\) #ctxbar:not\(\.warn\):not\(\.danger\) #ctxtxt > #ctxctx\{color:transparent\}/);
  assert.doesNotMatch(css, /:not\(\.warn\):not\(\.danger\) #ctxtxt \*/, "正常态不可用 #ctxtxt * 覆盖 #ctxq.warm / .hot");
  assert.match(css, /#ctxbar\.warn #ctxfill\{background:var\(--ctx-warn\)\}/);
  assert.ok(src04.includes('ctxFill.style.width = "0%"; ctxBar.style.setProperty("--p", "0%");'), "清空上下文条时应同步把 --p 归零");

  // 7. 拾色皮肤下 #btn-send 为 40px，非首屏单行 #input（line-height:24px）需 padding:8px 0 补齐至 40px 与按钮垂直居中；切皮肤/字号时 autoGrow 重算高度
  assert.match(css, /html\[data-skin="shise"\]:not\(\.wel\) #input\{padding:8px 0\}/);
  const src05 = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");
  assert.match(src05, /new MutationObserver\(\(\) => autoGrow\(\)\)\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \["data-skin", "data-fs"\] \}\)/);
});

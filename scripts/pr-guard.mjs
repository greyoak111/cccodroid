#!/usr/bin/env node
// PR 防投毒初筛：只把这次改动当数据读（git diff），不执行 PR 里的任何代码。
// 用法：node scripts/pr-guard.mjs <base> <head> [--md 报告文件]
//   在 CI 里由 .github/workflows/pr-guard.yml 用「目标分支上的这份脚本」去扫 PR 的提交，PR 改不了扫它的规则。
// 输出分三档：高（要维护者逐行看，检查标红）/ 中（顺带看一眼）/ 提示。它只是把该看的地方指出来，不能代替人审。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { i18nFnProblem } from "../i18n/fnsafe.mjs";

const [base, head] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mdOut = process.argv.includes("--md") ? process.argv[process.argv.indexOf("--md") + 1] : "";
if (!base || !head) { console.error("用法: node scripts/pr-guard.mjs <base> <head> [--md 报告文件]"); process.exit(2); }
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 << 20 });
const mb = git("merge-base", base, head).trim();

// ── 路径规则 ──────────────────────────────────────────────
// 改了就是高：CI 与发版脚本（拿得到签名钥匙）、构建配方、依赖清单、第三方原样拷进来的代码、权限与校验相关模块
const HIGH_PATHS = [
  [/^\.github\//, "CI 工作流：推到 main 后会带着签名钥匙跑"],
  [/^scripts\//, "构建 / 发版 / 签名脚本"],
  [/^devkit\//, "工具包构建配方（CI 里带签名钥匙跑）"],
  [/^devkit-(pin\.json|sources\.txt)$/, "钉的工具包版本与下载源"],
  [/^android\/AndroidManifest\.xml$/, "安卓权限与组件声明"],
  [/(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|[^/]*\.lock(\.json)?)$/, "依赖清单"],
  [/^(gateway\/web\/(vendor|office|pdfjs|mdedit)\/|gateway\/web\/xterm[^/]*$|devkit\/vendor\/|third_party\/|claude-code\/)/, "第三方代码（应与上游发布逐字节一致）"],
  [/^gateway\/guard\//, "敏感操作再确认（安全兜底）"],
  [/^i18n\/[^/]*\.mjs$/, "译文生成脚本（决定哪些译文能当代码进界面）"],
  [/(^|\/)[^/]*(sign|pgp|verify|token|auth|access|guard|secret|keystore|cert)[^/]*$/i, "签名 / 校验 / 令牌 / 权限相关"],
];
const MED_PATHS = [
  [/^android\/java\//, "原生层（Shizuku、无障碍、浏览器等高权限能力）"],
  [/^gateway\/gw\/(http|files|preview|update|install|components|modules|custom|pget|devtools|device)[^/]*\.mjs$/, "网关里碰文件、网络、安装的模块"],
];

// ── 新增行里的内容规则 ────────────────────────────────────
const CODE = /\.(m?js|cjs|ts|java|kt|sh|py|c|h|cc|cpp|yml|yaml|json|html|css)$/i;
const RULES = [
  // Trojan Source：双向控制符能让审的人看到的代码和实际执行的不一样
  { lv: "high", re: /[\u202A-\u202E\u2066-\u2069]/, why: "双向文字控制符（Trojan Source，显示和实际不一致）", any: true },
  { lv: "med", re: /[\u200B-\u200D\u2060\uFEFF]/, why: "零宽字符", any: true },
  { lv: "high", re: /[A-Za-z0-9+/]{240,}={0,2}/, why: "很长的 base64 串（可能藏代码或二进制）" },
  { lv: "high", re: /(?:\\x[0-9a-fA-F]{2}){24,}|\b[0-9a-fA-F]{240,}\b/, why: "很长的十六进制 / 转义串" },
  { lv: "high", re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/, why: "下载后直接交给 shell 执行" },
  { lv: "high", re: /\b(stratum\+tcp|xmrig|coinhive|cryptonight)\b/i, why: "挖矿特征" },
  { lv: "high", re: /secrets\.[A-Z_]+|\bGITHUB_TOKEN\b|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN/, why: "读取 CI 密钥 / 令牌" },
  { lv: "high", re: /\.ssh\/|id_(rsa|ed25519)|\.gateway-token|credentials\.json|\.netrc/, why: "碰 SSH 钥匙 / 网关令牌 / 凭据文件" },
  { lv: "med", re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run(In|Script)|setTimeout\(\s*["'`]/, why: "动态执行代码" },
  { lv: "med", re: /\batob\s*\(|Buffer\.from\([^)]*["']base64["']\)|base64\s+-d\b/, why: "运行时解码（常见于藏载荷）" },
  { lv: "med", re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(|Runtime\.getRuntime\(\)\.exec|ProcessBuilder\(/, why: "起子进程" },
  { lv: "med", re: /\b(pre|post)install\b/, why: "安装钩子" },
  { lv: "med", re: /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASS)/, why: "读取密钥类环境变量" },
  { lv: "med", re: /\bdisable(d)?\s*[:=]\s*true\b.*\b(verify|check|signature)|--no-verify|verify\s*[:=]\s*false|rejectUnauthorized\s*:\s*false/i, why: "关掉校验 / 证书检查" },
];

// 仓库里已经出现过的外部域名：新冒出来的才提示
function knownHosts() {
  const set = new Set();
  let out = "";
  try { out = git("grep", "-hoIE", "https?://[A-Za-z0-9.-]+", mb, "--", ":!gateway/web/lang-*.js"); } catch {}
  for (const m of out.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) set.add(m[1].toLowerCase());
  return set;
}

const findings = [];   // { lv, file, line, why }
const add = (lv, file, line, why) => findings.push({ lv, file, line, why });

// 改了哪些文件（含新增的二进制、改权限、改符号链接）
const raw = git("diff", "--no-renames", "--raw", "--numstat", "-z", mb, head);
const files = new Map();     // path → { bin, mode }
{
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // raw 记录去掉冒号后是五段：源模式 目标模式 源 sha 目标 sha 状态（审查 v0.5.20 10-001：以前错位取到了 sha，模式规则全不生效）
    if (p.startsWith(":")) { const [src, dst, , , st] = p.slice(1).split(/\s+/); files.set(parts[++i], { src, mode: dst, st: String(st || "")[0], bin: false }); }
    else if (/^(-|\d+)\t(-|\d+)\t/.test(p)) { const [a, b, f] = p.split("\t"); const name = f || parts[++i]; const x = files.get(name) || {}; x.bin = a === "-" && b === "-"; files.set(name, x); }
  }
}
for (const [f, x] of files) {
  // 说明文档、测试只按中算：测试在 CI 里跑，但那一步拿不到密钥
  const soft = /\.md$/i.test(f) && !f.startsWith(".github/") || /^gateway\/tests\//.test(f);
  for (const [re, why] of HIGH_PATHS) if (re.test(f)) { add(soft ? "med" : "high", f, 0, why); break; }
  if (!findings.some((y) => y.file === f)) for (const [re, why] of MED_PATHS) if (re.test(f)) { add("med", f, 0, why); break; }
  if (x.bin && x.st !== "D") add("high", f, 0, "二进制文件（看不了内容，要说明来源并能复现）");
  if (x.mode === "120000") add("high", f, 0, "符号链接");
  if (x.mode === "100755" && x.st === "A") add("med", f, 0, "新增可执行文件");
  else if (x.mode === "100755" && x.src !== "100755" && x.st !== "D") add("med", f, 0, "改成了可执行");
  else if (x.mode === "100755" && x.st === "M") add("med", f, 0, "改了可执行文件的内容");
  // 删掉的文件 dst 模式是 000000：删符号链接、删可执行文件都不会落进上面几条
}

// 逐行看新增的内容
const hosts = knownHosts(), newHosts = new Map();
const diff = git("diff", "--no-renames", "-U0", "--no-color", mb, head);
let cur = "", ln = 0;
for (const l of diff.split("\n")) {
  if (l.startsWith("+++ ")) { cur = l.slice(4).replace(/^b\//, ""); continue; }
  if (l.startsWith("@@")) { ln = Number((/\+(\d+)/.exec(l) || [])[1] || 0); continue; }
  if (!l.startsWith("+") || l.startsWith("+++")) continue;
  const s = l.slice(1), here = ln++;
  if (/^gateway\/web\/lang-[\w-]+\.js$|^i18n\/[^/]*\.txt$/.test(cur)) {   // 译文：查不可见字符 + 当代码执行的那几行
    for (const r of RULES) if (r.any && r.re.test(s)) add(r.lv, cur, here, r.why);
    // 译文里的代码会原样在界面里跑（拿得到网关令牌）：txt 的 @ 行、生成的 js 里不是字符串的值都要过 fnsafe 的白名单
    let fn = null;
    if (cur.endsWith(".txt")) { const m = /^\d+\t@(?!@)(.*)$/.exec(s); if (m) fn = m[1]; }
    else { const m = /^ {2}"(?:[^"\\]|\\.)*": (.*),$/.exec(s); if (m && !/^"(?:[^"\\]|\\.)*"$/.test(m[1])) fn = m[1]; else if (!m && !/^(\/\/|window\.I18N_DICT|\};?$)/.test(s)) add("high", cur, here, "译文文件里不是词条的行"); }
    if (fn != null) { const p = i18nFnProblem(fn); add(p ? "high" : "med", cur, here, p ? `译文里的代码不合规（${p}），会在界面里执行` : "译文里的代码（复数等），会在界面里执行"); }
    continue;
  }
  const test = /^gateway\/tests\//.test(cur);   // 测试里本来就会造假钥匙、假令牌：降一档
  for (const r of RULES) if ((r.any || CODE.test(cur)) && r.re.test(s)) add(test && !r.any ? "med" : r.lv, cur, here, r.why);
  if (CODE.test(cur) && !/\.json$/i.test(cur) && s.length > 1000) add("med", cur, here, `一行 ${s.length} 字（压缩 / 混淆过的代码看不出在干什么）`);
  for (const m of s.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    const h = m[1].toLowerCase();
    if (h.includes(".") && !hosts.has(h) && !/^(localhost|127\.0\.0\.\d+|example\.(com|org))$/.test(h) && !newHosts.has(h)) newHosts.set(h, `${cur}:${here}`);
  }
}
for (const [h, at] of newHosts) { const [f, n] = at.split(/:(?=\d+$)/); add("med", f, Number(n), `新出现的外部域名 ${h}`); }

// ── 报告 ─────────────────────────────────────────────────
// 文件名、域名都来自 PR，按纯文本放进代码格，防它在评论里注入 Markdown / 链接
const code = (s) => "`" + String(s).replace(/[`\r\n]/g, "?").slice(0, 160) + "`";
const LV = { high: "高", med: "中" };
const uniq = new Map();
for (const f of findings) { const k = `${f.lv}|${f.file}|${f.why}`; const x = uniq.get(k); if (x) { if (f.line) x.lines.push(f.line); } else uniq.set(k, { ...f, lines: f.line ? [f.line] : [] }); }
const rows = [...uniq.values()].sort((a, b) => (a.lv === b.lv ? a.file.localeCompare(b.file) : a.lv === "high" ? -1 : 1));
const nHigh = rows.filter((r) => r.lv === "high").length, nMed = rows.length - nHigh;
let md = "<!-- pr-guard -->\n### PR 安全初筛 / Safety pre-check\n\n";
md += `改动 ${files.size} 个文件；高 ${nHigh} 项、中 ${nMed} 项。\n\n`;
if (!rows.length) md += "没发现需要特别留意的地方。自动初筛只能挡明显的，合并前仍需人工看过。\n";
else {
  md += "| 档 | 文件 | 行 | 为什么要看 |\n|---|---|---|---|\n";
  for (const r of rows.slice(0, 120)) md += `| ${LV[r.lv]} | ${code(r.file)} | ${r.lines.slice(0, 6).join(", ")}${r.lines.length > 6 ? " …" : ""} | ${r.why} |\n`;
  if (rows.length > 120) md += `\n还有 ${rows.length - 120} 项没列出。\n`;
  md += "\n「高」不等于有问题，只是这些地方一旦被动手脚，后果最重（能拿到签名钥匙、改到用户手机上的权限、或藏进看不见的内容），合并前请逐行看过。\n";
}
if (mdOut) fs.writeFileSync(mdOut, md);
console.log(md);
process.exit(nHigh ? 1 : 0);

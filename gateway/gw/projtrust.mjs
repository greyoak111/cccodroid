// 项目自带的「会自动运行的配置」：网关用 -p 起 claude，-p 不弹工作区信任框，下面这些打开就跑（2.1.311 实测）——
//   · 工作目录 .claude/settings.json、settings.local.json 里的 hooks、env、各种 *Helper、插件、MCP 开关……
//   · 工作目录以及每一级上级目录的 .mcp.json（claude 会一路往上找；/sdcard/.mcp.json 任何有存储权限的应用都能放）
//   · 工作目录 .claude/agents、.claude/skills 里 frontmatter 带 hooks 的
//   · 工作目录 .claude/output-styles 里的风格（选中就进系统提示）
// 实测不加载的（不用扫）：上级目录的 .claude/settings*.json（git 根也不读）、--add-dir 目录里的 .mcp.json。
// clone 下来的仓库、别的应用放进共享存储的文件都可能带这些。起一轮前先看一眼：有、又没被用户认过，就出一张卡片问；
// 不同意（或者没人看着的定时任务）这一轮加 --setting-sources user，项目级的配置一概不加载，对话照常。
// 认过的按工作目录记指纹，配置一变再问。用户自己的 ~/.claude 不在此列（那是用户级，本来就是他自己的）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, log } from "./config.mjs";

const MAX = 8 << 20;   // 超过的读不全：记成风险，指纹按大小 + 修改时间
// 项目设置里不会让什么东西跑起来的键；其余的（含以后新加的）一律当风险报出来，宁可多问一次
export const SAFE_KEYS = new Set(["$schema", "model", "outputStyle", "includeCoAuthoredBy", "includeGitInstructions", "cleanupPeriodDays",
  "language", "alwaysThinkingEnabled", "spinnerTipsEnabled", "respectGitignore", "theme", "verbose", "attribution", "effortLevel"]);
// disableAllHooks 不在里面：项目级的这一项连 --settings 挂的 guard 钩子一起关掉（2.1.311 实测，DeepSeek 复核 11-03 C-3）

function readSmall(f) {
  let st; try { st = fs.statSync(f); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX) return { raw: null, big: `${st.size}:${st.mtimeMs}` };
  try { return { raw: fs.readFileSync(f, "utf8") }; } catch { return null; }
}

function settingsRisks(file, raw, out) {
  let j; try { j = JSON.parse(raw); } catch { if (raw.trim()) out.push(`${file}: ?`); return; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return;
  for (const [k, v] of Object.entries(j)) {
    if (SAFE_KEYS.has(k)) continue;
    if (k === "permissions" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v)) {
        if ((pk === "deny" || pk === "ask") || (pk === "allow" && Array.isArray(pv) && !pv.length)) continue;
        out.push(`${file}: permissions.${pk}`);
      }
      continue;
    }
    out.push(`${file}: ${k}`);
  }
}

/** frontmatter 里出现 hooks 字样就算（引号键、缩进写法都不细分；宁可多问一次） */
function hasFrontHooks(raw) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return !!m && /hooks/i.test(m[1]);
}

/** 这个工作目录带了哪些会自动运行的配置。没有返回 null；有就给 { fp, risks }，fp 盖住所有看过的文件，任何一处改了都会变 */
export function projectRisks(cwd) {
  if (!cwd) return null;
  const risks = [], h = crypto.createHash("sha256");
  const take = (f, r) => { h.update(f + "\0" + (r.raw ?? "<big:" + r.big + ">") + "\0"); };
  for (const n of ["settings.json", "settings.local.json"]) {
    const f = path.join(cwd, ".claude", n), r = readSmall(f);
    if (!r) continue;
    take(f, r);
    if (r.big) risks.push(`${f}: ?`); else settingsRisks(path.join(".claude", n), r.raw, risks);
  }
  for (let d = path.resolve(cwd), seen = 0; seen < 64; seen++) {
    const f = path.join(d, ".mcp.json"), r = readSmall(f);
    if (r) {
      take(f, r);
      let names = null;
      try { const s = JSON.parse(r.raw).mcpServers; if (s && typeof s === "object") names = Object.keys(s); } catch {}
      if (names) for (const k of names.slice(0, 20)) risks.push(`${f}: ${k}`);
      else if (r.big || r.raw.trim()) risks.push(`${f}: ?`);
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  let n = 0;
  for (const sub of ["agents", "skills"]) {
    const base = path.join(cwd, ".claude", sub);
    let ents; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++n > 300) { risks.push(`${path.join(".claude", sub)}: > 300`); break; }
      const f = sub === "agents" ? (e.name.endsWith(".md") ? path.join(base, e.name) : null) : path.join(base, e.name, "SKILL.md");
      const r = f && readSmall(f);
      if (!r || (!r.big && !hasFrontHooks(r.raw))) continue;
      take(f, r);
      risks.push(`${path.join(".claude", sub, sub === "agents" ? e.name : e.name + "/SKILL.md")}: ${r.big ? "?" : "hooks"}`);
    }
  }
  // 项目自带的输出风格：选中（项目设置里的 outputStyle 就能选）就成了系统提示的一部分（输出风格目录的安全报告，11-04）
  {
    const base = path.join(cwd, ".claude", "output-styles");
    let ents = []; try { ents = fs.readdirSync(base).filter((f) => f.endsWith(".md")).sort(); } catch {}
    for (const f of ents.slice(0, 50)) {
      const r = readSmall(path.join(base, f));
      if (!r) continue;
      take(path.join(base, f), r);
      risks.push(`${path.join(".claude", "output-styles", f)}: output style`);
    }
  }
  return risks.length ? { fp: h.digest("hex").slice(0, 32), risks: risks.length > 40 ? [...risks.slice(0, 39), `… +${risks.length - 39}`] : risks } : null;
}

// 认过的：{ 工作目录 realpath: { fp, at } }
const TRUST_FILE = () => path.join(CFG.home, "ccapp-project-trust.json");
let TRUST = null;
function trust() {
  if (TRUST) return TRUST;
  try { TRUST = JSON.parse(fs.readFileSync(TRUST_FILE(), "utf8")); } catch { TRUST = {}; }
  if (!TRUST || typeof TRUST !== "object" || Array.isArray(TRUST)) TRUST = {};
  TRUST = Object.assign(Object.create(null), TRUST);
  return TRUST;
}
const keyOf = (cwd) => { try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); } };
export const projectTrusted = (cwd, fp) => trust()[keyOf(cwd)]?.fp === fp;
export function trustProject(cwd, fp) {
  const t = trust();
  t[keyOf(cwd)] = { fp, at: Date.now() };
  const keys = Object.keys(t);
  if (keys.length > 500) for (const k of keys.sort((a, b) => (t[a].at || 0) - (t[b].at || 0)).slice(0, keys.length - 500)) delete t[k];
  try { fs.writeFileSync(TRUST_FILE() + ".tmp", JSON.stringify(t), { mode: 0o600 }); fs.renameSync(TRUST_FILE() + ".tmp", TRUST_FILE()); }
  catch (e) { log(`[项目配置] 记不下：${e.message}`); }
}
/** 用户在应用里自己改了项目的钩子 / MCP（扩展页）：改完就认，别下一轮反过来问他自己写的东西 */
export function retrustProject(cwd) {
  const k = keyOf(cwd);
  if (!trust()[k]) return;
  const r = projectRisks(cwd);
  if (r) trustProject(cwd, r.fp);
}

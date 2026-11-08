// ── 状态对账：各本「记录」和磁盘上实际的东西对一遍 ─────────────────────────────
//
// 0.3.9–0.3.11 的问题几乎都是两本账对不上，而且都要等到卸载 / 升级时才露馅：
// 组件记录说装着、文件已随旧 usr 没了；dpkg 清单写 /data/data、比对时拿 /data/user/0；模块 .ok 在、文件不全……
// 这里主动核一遍，只读不改：网关启动 1 分钟后一次，设置页「排障」里可以随时再核。
//   · 工具包：.devkit-ok 在不在；Claude Code 程序在不在
//   · 组件（files/components/<id>.json）：没写完的记录、装在旧工具包上的、记录里的文件 / 命令不在、路径格式不对
//   · 包清单（var/lib/dpkg/info/*.list）：前缀是不是本应用；列的文件在不在
//   · 模块（libexec/devkit/modules/<id>/）：.ok 与 MANIFEST 是否成对；FILES 里的文件在不在
//   · 自定义组件（~/.cccodroid/custom/<id>/）：程序和补的库在不在
// 结果：GET /api/reconcile（?run=1 重核；?format=selftest 出 PASS/FAIL 行给 cccodroid-selftest），
// 本机实况里告诉 Claude，问题有变化时记一笔修复账本。
import fs from "node:fs";
import path from "node:path";
import { CFG, LIVE, PATHS, PREFIX, log, reqLang, tr, tz } from "./config.mjs";
import { ledger } from "./claude.mjs";
import { COMP_DIR, compRecord, devkitIdentity } from "./components.mjs";
import { modInstalled, modulesInfo } from "./modules.mjs";
import { NEXT, sendJson } from "./http.mjs";

const STATE = PREFIX ? path.join(CFG.home, ".cache", "cccodroid", "reconcile.json") : "";
const CUSTOM_DIR = PREFIX ? path.join(CFG.home, ".cccodroid", "custom") : "";
let last = null, busy = null;
// 上次的结果存在 home 下（同 uid 能写），读回来只认形状对的：findings 得是对象数组（审查 11-05 第 19 组 1）
try { last = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
if (!last || typeof last !== "object" || !Array.isArray(last.findings)) last = null;
else last.findings = last.findings.filter((f) => f && typeof f === "object" && typeof f.k === "string"
  && (f.v == null || typeof f.v === "object") && (f.fix == null || typeof f.fix === "string"));
/** 拼进系统提示的：压成一行、限长 —— 字段来自组件 / 模块记录和上面那份缓存，别让换行把「## 新规则」带进去 */
const one = (x, n = 260) => String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, n);

const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return null; } };
/** 软链要指向真东西才算在：86 个组件文档软链指向不存在的 usr/LICENSES，只看 lstat 永远显示正常（0.6.9 审计 真机数据） */
const present = (f) => {
  try { const st = fs.lstatSync(f); if (st.isSymbolicLink()) { fs.statSync(f); } return true; } catch { return false; }
};
/** 一串相对 $PREFIX 的路径里不在磁盘上的（软链跟到目标） */
function missingOf(rels) {
  const out = [];
  for (const r of rels) if (!present(path.join(PREFIX, r))) out.push(r);
  return out;
}
const badRel = (r) => typeof r !== "string" || !r || r.startsWith("/") || r.split("/").includes("..");

// 本应用的包名（清单前缀要对得上的那个）：/data/user/0/<包>/files/usr 或 /data/data/<包>/files/usr
const OWN = PREFIX ? (/\/data\/(?:data|user\/\d+)\/([^/]+)\/files\/usr\/?$/.exec(PREFIX) || [])[1] || "" : "";

/** 核一遍，返回 { at, findings:[{key, level:error|warn|info, k, v, fix, samples}] }。k/v 是 tz 的原句和变量，出门时再翻 */
export function reconcileNow() {
  const F = [];
  // k、fix 用 tz() 包着：不带变量时原样返回，只是让 i18n/scan.mjs 把它们收进词典
  const add = (key, level, k, v, fix, samples) => F.push({ key, level, k, v: v || null, fix: fix || "", ...(samples && samples.length ? { samples: samples.slice(0, 8) } : {}) });
  const dk = devkitIdentity();
  if (!dk) add("devkit", "error", tz("找不到工具包的安装标记（.devkit-ok），工具包可能没装完"), null, tz("设置 → 更新：修复工具包"));
  // 用户主动卸载 Claude Code 会留 files/.claude-uninstalled：这是正常状态，别再报红教人重装（0.6.9 审计 195-M.7）
  const claudeUninstalled = PREFIX && exists(path.join(path.dirname(PREFIX), ".claude-uninstalled"));
  if (PATHS.claude && !fs.existsSync(PATHS.claude) && !claudeUninstalled) add("claude", "error", tz("找不到 Claude Code 程序"), null, tz("设置 → 更新：重装 Claude Code"), [PATHS.claude]);

  // ── 组件 ──
  let recs = [];
  try { recs = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), compRecord(f.slice(0, -5))]); } catch {}
  for (const [id, rec] of recs) {
    if (!rec) { add("comp-unreadable:" + id, "warn", tz("组件「{id}」的安装记录读不出来"), { id }, tz("到 扩展 页重新安装这个组件")); continue; }
    if (rec.state !== "ok") { add("comp-partial:" + id, "warn", tz("组件「{id}」上次没装完"), { id }, tz("到 扩展 页卸载后重装")); continue; }
    if (!dk || rec.base !== dk.sha256) { add("comp-outdated:" + id, "info", tz("组件「{id}」装在旧工具包上，换工具包后它的文件已经不在"), { id }, tz("到 扩展 页重新安装（要用时再装也行）")); continue; }
    const files = Array.isArray(rec.files) ? rec.files : [];
    const bad = files.filter(badRel);
    if (bad.length) add("comp-format:" + id, "error", tz("组件「{id}」的记录里有 {n} 个路径格式不对"), { id, n: bad.length }, tz("把诊断包发给开发者"), bad);
    const binsGone = (rec.bin || []).filter((b) => !exists(path.join(PREFIX, "bin", b)));
    const gone = missingOf(files.filter((r) => !badRel(r)));
    if (binsGone.length) add("comp-bin:" + id, "error", tz("组件「{id}」的命令不在了：{cmds}"), { id, cmds: binsGone.join(" ") }, tz("到 扩展 页重新安装这个组件"));
    if (gone.length) add("comp-files:" + id, "error", tz("组件「{id}」少了 {n} 个文件（共 {total} 个）"), { id, n: gone.length, total: files.length }, tz("到 扩展 页重新安装这个组件"), gone);
    // 共享文件被别的卸载删掉时，组件自己的 bin 还在、状态仍是 ok：这里补一道（0.6.9 审计 #185）
    const shared = (Array.isArray(rec.shared) ? rec.shared : []).filter((r) => !badRel(r));
    const sharedGone = missingOf(shared);
    if (sharedGone.length) add("comp-shared:" + id, "error", tz("组件「{id}」依赖的 {n} 个共享文件被删了"), { id, n: sharedGone.length }, tz("到 扩展 页重新安装这个组件"), sharedGone);
  }

  // ── 包清单 ──
  const info = PREFIX ? path.join(PREFIX, "var/lib/dpkg/info") : "";
  let lists = [];
  try { lists = fs.readdirSync(info).filter((f) => f.endsWith(".list")); } catch {}
  const foreign = new Map(), lacking = [];
  let lackN = 0;
  for (const f of lists) {
    const rels = [];
    for (const l of readLines(path.join(info, f)) || []) {
      const i = l.indexOf("/files/usr/");
      if (i < 0) continue;
      const m = /^\/data\/(?:data|user\/\d+)\/([^/]+)$/.exec(l.slice(0, i));
      if (!m || (OWN && m[1] !== OWN)) { foreign.set(l.slice(0, i) || "?", (foreign.get(l.slice(0, i) || "?") || 0) + 1); continue; }
      if (l.length > i + 11) rels.push(l.slice(i + 11));
    }
    const gone = missingOf(rels);
    if (gone.length) { lacking.push(`${f.slice(0, -5)}：${gone.length}（${gone[0]}）`); lackN += gone.length; }
  }
  if (foreign.size) add("list-prefix", "error", tz("{n} 条包清单记的不是本应用的路径"), { n: [...foreign.values()].reduce((a, b) => a + b, 0) },
    tz("把诊断包发给开发者"), [...foreign].map(([p, n]) => `${p}  ×${n}`));
  if (lacking.length) add("list-files", "warn", tz("{n} 个包的文件不全（共缺 {m} 个）"), { n: lacking.length, m: lackN }, tz("设置 → 更新：修复工具包"), lacking);

  // ── 模块 ──
  const mj = modulesInfo();
  for (const m of (mj && mj.modules) || []) {
    if (m.kind === "base" || !m.dir || badRel(m.dir)) continue;
    const d = path.join(PREFIX, m.dir), ok = exists(path.join(d, ".ok")), man = exists(path.join(d, "MANIFEST"));
    const name = (m.name && (m.name.zh || m.name.en)) || m.id;
    if (ok && !man) { add("mod-manifest:" + m.id, "error", tz("模块「{name}」标着已装，却没有清单"), { name }, tz("到 扩展 → 工具包模块 卸载后重装")); continue; }
    if (!ok && man && exists(path.join(d, "FILES"))) { add("mod-partial:" + m.id, "warn", tz("模块「{name}」上次没装完"), { name }, tz("到 扩展 → 工具包模块 重新安装")); continue; }
    if (!modInstalled(mj, m.id)) continue;
    const files = readLines(path.join(d, "FILES"));
    if (!files) { add("mod-files-list:" + m.id, "warn", tz("模块「{name}」缺文件列表（FILES），卸载时会删不干净"), { name }, tz("到 扩展 → 工具包模块 重新安装")); continue; }
    const gone = missingOf(files.filter((r) => !badRel(r)));
    if (gone.length) add("mod-files:" + m.id, "error", tz("模块「{name}」少了 {n} 个文件（共 {total} 个）"), { name, n: gone.length, total: files.length }, tz("到 扩展 → 工具包模块 重新安装"), gone);
  }

  // ── 自定义组件 ──
  let customs = [];
  try { customs = fs.readdirSync(CUSTOM_DIR).filter((d) => !d.startsWith(".")); } catch {}
  for (const d of customs) {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(CUSTOM_DIR, d, "cccodroid-custom.json"), "utf8")); } catch {}
    if (!r) { add("custom-rec:" + d, "warn", tz("自定义组件「{id}」的记录读不出来"), { id: d }, tz("到 扩展 → 自定义组件 删掉重新导入")); continue; }
    const app = path.join(r.dir || path.join(CUSTOM_DIR, d), "app");
    const gone = (r.entries || []).map((e) => e.rel).filter((rel) => rel && !exists(path.join(app, rel)));
    for (const lib of r.libs || []) if (lib.startsWith(CUSTOM_DIR) && !exists(lib)) gone.push(lib);
    if (gone.length) add("custom-files:" + d, "error", tz("自定义组件「{id}」的程序或库不在了"), { id: r.name || d }, tz("到 扩展 → 自定义组件 删掉重新导入"), gone);
  }
  return { at: Date.now(), devkit: dk ? dk.sha256 || dk.tag || "" : "", findings: F };
}

const levelRank = { error: 0, warn: 1, info: 2 };
const keysOf = (r) => (r ? r.findings.filter((f) => f.level !== "info").map((f) => f.key).sort().join("\n") : "");

/** 核一遍并落盘；error / warn 这一组变了才记账（每次启动都记同样的问题会把账本刷满） */
export function reconcileRun() {
  if (!PREFIX) return null;
  if (busy) return last;
  busy = true;
  try {
    const t0 = Date.now(), r = reconcileNow(), prev = last;
    r.ms = Date.now() - t0;
    r.findings.sort((a, b) => levelRank[a.level] - levelRank[b.level]);
    const bad = r.findings.filter((f) => f.level !== "info");
    if (keysOf(r) !== keysOf(prev)) {
      if (bad.length) ledger("verify", false, `状态对账：${bad.length} 处记录和磁盘对不上`, { samples: bad.slice(0, 5).map((f) => tzFill(f)) });
      else if (prev && keysOf(prev)) ledger("verify", true, "状态对账：记录和磁盘重新对上了");
    }
    last = r;
    try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(r)); } catch {}
    log(`[reconcile] ${r.ms} ms：${bad.length ? bad.map((f) => f.key).join(" ") : "无问题"}${r.findings.length > bad.length ? `（另有 ${r.findings.length - bad.length} 条提示）` : ""}`);
    return r;
  } catch (e) { log("[reconcile] 失败：" + e.message); return last; }
  finally { busy = null; }
}
const tzFill = (f) => tz(f.k, f.v);
const render = (f, lang) => ({ key: f.key, level: f.level, msg: tr(lang, tz(f.k, f.v)), fix: f.fix ? tr(lang, tz(f.fix)) : "", samples: f.samples || [] });

/** 给本机实况：有 error / warn 才说（Claude 好如实告诉用户，而不是去绕） */
export function reconcileFacts() {
  const bad = (last && last.findings || []).filter((f) => f.level !== "info");
  if (!bad.length) return [];
  return [`- **状态对账发现 ${bad.length} 处记录和磁盘对不上**（相关功能可能用不了；修法照写的告诉用户，别自己动 $PREFIX 去补）：`,
    ...bad.slice(0, 6).map((f) => `  - ${one(tzFill(f))}${f.fix ? " —— " + one(f.fix, 160) : ""}`)];
}

if (PREFIX && LIVE) setTimeout(() => reconcileRun(), 60e3).unref?.();

// GET /api/reconcile[?run=1][&format=selftest]
export async function routeReconcile(req, res, u, p) {
  if (p !== "/api/reconcile" || req.method !== "GET") return NEXT;
  if (!PREFIX) return sendJson(res, 200, { ok: true, supported: false });
  const r = u.searchParams.get("run") === "1" || !last ? reconcileRun() : last;
  if (u.searchParams.get("format") === "selftest") {
    const lines = (r ? r.findings : []).filter((f) => f.level !== "info").map((f) => `FAIL 状态对账 :: ${tzFill(f)}${f.samples ? "：" + f.samples.slice(0, 3).join("，") : ""}`);
    if (r && !lines.length) lines.push(`PASS 状态对账 :: 记录与磁盘一致（${r.ms} ms）`);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(lines.join("\n") + "\n");
  }
  const lang = reqLang(req);
  return sendJson(res, 200, { ok: true, supported: true, at: r ? r.at : 0, ms: r ? r.ms : 0, findings: r ? r.findings.map((f) => render(f, lang)) : [] });
}

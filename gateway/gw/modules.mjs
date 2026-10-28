import fs from "node:fs";
import path from "node:path";
import { LAST_LANG, PREFIX, log, tr, tz } from "./config.mjs";
import { killTree } from "./claude.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { compBaseDeps, compNeeds, compRecords, compRun, devkitIdentity, sha256File, breathe } from "./components.mjs";

// ── 模块化工具包（0.3.9 起）──────────────────────────────────────────
// 工具包按 devkit.json 的 modules 拆成基础块 + 若干模块（+ 自动算出的共享层），同一份 Termux 快照一起发布。
//   · $PREFIX/libexec/devkit/modules.json 在 = 模块化工具包（基础块装进来时一并写入）；不在就是旧的整包，面板照旧显示一整行。
//   · 某块已装 ⇔ 它的目录（modules.json 的 dir，如 libexec/devkit/modules/build）里有 MANIFEST 和 .ok。
//   · 不另设计数：一个文件还有没有人用，由其余已装块的 FILES + 已装组件的 needs + pkg 装的包现算。
//   · 加装 / 卸载单个块在这里做（同一快照内）；首次安装、换快照由 Java（Installer / Updater）整体换 usr/。
// 装的流程照组件：下载 → 核 gz 的 sha256（modules.json 里的，随基础块一起装进来、当时已核过来源）
//   → 解到暂存区 → 按 MANIFEST 逐个核 → 搬进 $PREFIX → first-run → 写 .ok。任何一步失败 $PREFIX 不动（.ok 不写）。
const DK = PREFIX ? path.join(PREFIX, "libexec/devkit") : "";
const STAGE = PREFIX ? path.join(path.dirname(PREFIX), "devkit-stage") : "";
const MOD_JOBS = new Map();          // id → { phase, done, total, via, error, child, cancelled, finished, queue }
const DEVKIT_MIRROR = "https://dl.cccodroid.net/devkit/";

export function modulesInfo() {
  if (!DK) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DK, "modules.json"), "utf8")); } catch { return null; }
}
const blockOf = (mj, id) => (mj.modules || []).find((m) => m.id === id) || null;
const dirOf = (m) => path.join(PREFIX, m.dir);
export function modInstalled(mj, id) {
  const m = blockOf(mj, id);
  if (!m) return false;
  if (m.kind === "base") return true;
  return fs.existsSync(path.join(dirOf(m), ".ok")) && fs.existsSync(path.join(dirOf(m), "MANIFEST"));
}
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
/** 一块放进 $PREFIX 的全部路径（文件 + 软链），相对 $PREFIX */
const filesOf = (m) => readLines(path.join(dirOf(m), "FILES"));

/** 组件要用、但所在模块没装的底座包 → 要先装的模块（共享层报给用它的模块）。整包工具包或不知道依赖时返回 [] */
export function modulesMissingFor(baseDeps) {
  const mj = modulesInfo();
  if (!mj || !Array.isArray(baseDeps)) return [];
  const need = new Set(baseDeps.map((d) => (typeof d === "string" ? d : d.name)));
  const out = new Map();
  for (const m of mj.modules || []) {
    if (modInstalled(mj, m.id) || !(m.packages || []).some((p) => need.has(p.name))) continue;
    // 共享层不单独装：提示用它的模块里最小的那个
    for (const id of m.kind === "shared" ? (m.users || []).filter((u) => !modInstalled(mj, u)).sort((x, y) => (blockOf(mj, x) || {}).installed - (blockOf(mj, y) || {}).installed).slice(0, 1) : [m.id]) {
      const b = blockOf(mj, id);
      if (b) out.set(id, { id, name: b.name });
    }
  }
  return [...out.values()];
}

/** 依赖闭包里还没装的块（按依赖顺序，最后是 id 自己） */
function missingChain(mj, id, out = [], seen = new Set()) {
  if (seen.has(id)) return out;
  seen.add(id);
  const m = blockOf(mj, id);
  if (!m) throw new Error(tz("没有这个模块：{id}", { id }));
  for (const d of m.deps || []) missingChain(mj, d, out, seen);
  if (!modInstalled(mj, id)) out.push(id);
  return out;
}

/** 谁在用这一块：已装的模块（deps 含它）、已装的组件（依赖的底座包落在这块里、别的已装块又没有） */
function modDependents(mj, id) {
  const mods = (mj.modules || []).filter((m) => m.id !== id && modInstalled(mj, m.id) && (m.deps || []).includes(id) && m.kind !== "shared").map((m) => m.id);
  const mine = new Set((blockOf(mj, id).packages || []).map((p) => p.name));
  for (const m of mj.modules || []) if (m.id !== id && modInstalled(mj, m.id)) for (const p of m.packages || []) mine.delete(p.name);
  const comps = [];
  for (const [cid, rec] of compRecords()) {
    const deps = compBaseDeps(cid, rec.sha256);
    if (deps && deps.some((n) => mine.has(n))) comps.push(cid);
  }
  return { modules: mods, components: comps };
}

function modList() {
  if (!PREFIX) return { supported: false };
  const mj = modulesInfo();
  if (!mj) return { supported: true, modular: false };
  const dk = devkitIdentity() || {};
  const items = (mj.modules || []).map((m) => {
    const job = MOD_JOBS.get(m.id), inst = modInstalled(mj, m.id);
    const dep = inst ? modDependents(mj, m.id) : { modules: [], components: [] };
    return {
      id: m.id, kind: m.kind, required: !!m.required, name: m.name, desc: m.desc, uses: m.uses || [],
      deps: m.deps || [], users: m.users || [], commands: m.commands || [], key: m.key || [],
      packages: (m.packages || []).map((p) => `${p.name} ${p.version}`),
      download: (m.gz && m.gz.bytes) || 0, installed: m.installed || 0, files: m.files || 0,
      state: job && !job.finished ? job.phase : inst ? "ok" : job && job.error ? "error" : "absent",
      progress: job && !job.finished ? { phase: job.phase, done: job.done, total: job.total, via: job.via || "", current: job.current || m.id } : null,
      error: job && job.error ? tr(LAST_LANG, job.error) : "",
      usedBy: dep,
      sha256: (m.gz && m.gz.sha256) || "",
    };
  });
  let free = null;   // 扩展页的存储条要「剩余」
  try { const st = fs.statfsSync(path.dirname(PREFIX)); free = st.bavail * st.bsize; } catch {}
  return { supported: true, modular: true, snapshot: mj.snapshot, release: dk.base || "", items, free };
}

// ── 装 ────────────────────────────────────────────────────────────────
async function modInstall(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const mj = modulesInfo();
  if (!mj) return { ok: false, message: tz("当前是整包工具包，没有模块可装") };
  const m = blockOf(mj, id);
  if (!m) return { ok: false, message: tz("没有这个模块：{id}", { id }) };
  for (const j of MOD_JOBS.values()) if (!j.finished) return { ok: false, message: tz("另一个模块正在装，等它结束再试") };
  let chain;
  try { chain = missingChain(mj, id); } catch (e) { return { ok: false, message: e.message }; }
  if (!chain.length) return { ok: true, already: true };
  const dk = devkitIdentity() || {};
  if (!dk.base) return { ok: false, message: tz("工具包是从本地文件装的，不知道该去哪个 Release 下载模块。请先在设置里更新一次工具包") };
  // 空间：压缩包 + 解开后的大小（暂存区与目标在同一分区，搬进去是换名不占双份），再留 10%
  const need = chain.reduce((s, c) => { const b = blockOf(mj, c); return s + b.gz.bytes + b.installed; }, 0) * 1.1;
  try { const st = fs.statfsSync(path.dirname(PREFIX)); const free = st.bavail * st.bsize; if (free < need) return { ok: false, message: tz("存储空间不够：需要约 {need} MB，只剩 {free} MB", { need: Math.ceil(need / 1048576), free: Math.floor(free / 1048576) }) }; } catch {}
  const job = { phase: "downloading", done: 0, total: 0, queue: chain, current: chain[0], finished: false };
  for (const c of chain) MOD_JOBS.set(c, job);
  (async () => {
    try {
      for (const c of chain) { job.current = c; await modRunInstall(mj, blockOf(mj, c), dk.base, job); }
      log(`[mod] 已装：${chain.join(" → ")}`);
    } catch (e) {
      job.error = e.message === "cancelled" ? "" : e.message;
      log(`[mod] ${job.current} 安装失败：${e.message}`);
    } finally {
      job.finished = true; job.child = null;
      // 成功的块不留 job（状态看 .ok）；失败的那块留着 error 给面板看
      for (const c of chain) if (!job.error || c !== job.current) MOD_JOBS.delete(c);
    }
  })();
  return { ok: true, chain };
}

let modMirrorFirst = false;
async function modRunInstall(mj, m, base, job) {
  fs.mkdirSync(STAGE, { recursive: true });
  const gz = path.join(STAGE, `${m.id}-${m.gz.sha256.slice(0, 12)}.tar.gz`), tree = path.join(STAGE, m.id);
  if (fs.existsSync(gz)) {
    job.phase = "verifying"; job.done = 0; job.total = m.gz.bytes;
    if ((await sha256File(gz, job)) !== m.gz.sha256) fs.rmSync(gz, { force: true });
  }
  if (!fs.existsSync(gz)) {
    const part = gz + ".part";
    job.phase = "downloading"; job.done = 0; job.total = m.gz.bytes;
    const tick = setInterval(() => { try { job.done = fs.statSync(part).size; } catch {} }, 500);
    try {
      // GitHub Release 与 dl.cccodroid.net 镜像逐字节同一份，内容按 modules.json 里的 sha256 把关
      const gh = base + m.gz.file, mirror = DEVKIT_MIRROR + base.replace(/\/$/, "").split("/").pop() + "/" + m.gz.file;
      const srcs = modMirrorFirst ? [mirror, gh] : [gh, mirror];
      let lastErr;
      for (let i = 0; i < 4 && !job.cancelled; i++) {
        const url = srcs[i % 2];
        job.via = url === gh ? "GitHub" : "dl.cccodroid.net";
        try {
          await compRun(job, path.join(PREFIX, "bin", "curl"), ["-fL", "-sS", "-C", "-", "--retry", "2", "--connect-timeout", "15", "--speed-limit", "10000", "--speed-time", "45", "-o", part, url]);
          lastErr = null; modMirrorFirst = url !== gh; break;
        } catch (e) { lastErr = e; if (job.cancelled) break; log(`[mod] ${m.id} 从 ${job.via} 下载中断：${e.message}`); }
      }
      if (job.cancelled) throw new Error("cancelled");
      let have = 0; try { have = fs.statSync(part).size; } catch {}
      if (lastErr && have !== m.gz.bytes) throw lastErr;
    } finally { clearInterval(tick); }
    job.phase = "verifying"; job.done = 0; job.total = m.gz.bytes;
    if ((await sha256File(part, job)) !== m.gz.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("下载的文件校验不符（已删除，重试会重新下载）")); }
    fs.renameSync(part, gz);
  }
  if (job.cancelled) throw new Error("cancelled");
  job.phase = "verifying"; job.done = 0; job.total = m.installed || 0;
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  try { await compRun(job, path.join(PREFIX, "bin", "tar"), ["-xzf", gz, "-C", tree]); }
  catch (e) { if (!job.cancelled) fs.rmSync(gz, { force: true }); throw e; }
  const man = readLines(path.join(tree, "usr", m.dir, "MANIFEST"));
  job.total = man.reduce((a, l) => a + (Number(l.split(" ")[1]) || 0), 0);   // 按清单字节算，installed 含链接等到不了头
  for (const line of man) {
    await breathe();
    if (job.cancelled) throw new Error("cancelled");
    const i = line.indexOf(" "), j = line.indexOf(" ", i + 1), h = line.slice(0, i), n = Number(line.slice(i + 1, j)), rel = line.slice(j + 1);
    const f = path.join(tree, "usr", rel);
    let st; try { st = fs.statSync(f); } catch { throw new Error(tz("模块包缺文件：{file}", { file: rel })); }
    if (st.size !== n || (await sha256File(f, null, st.size)) !== h) throw new Error(tz("模块包里的文件校验不符：{file}", { file: rel }));
    job.done += st.size;
  }
  // 搬进去：.ok 最后写，中途被打断就是「没装」，重装会覆盖、卸载按 FILES 删
  job.phase = "installing";
  fs.rmSync(path.join(dirOf(m), ".ok"), { force: true });
  const skipped = modMoveIn(path.join(tree, "usr"));
  if (skipped.length) log(`[mod] ${m.id}：${skipped.length} 个路径和已有目录冲突，没放：${skipped.slice(0, 5).join(", ")}`);
  const fr = path.join(dirOf(m), "first-run.sh");
  if (fs.existsSync(fr)) { try { await compRun(job, path.join(PREFIX, "bin", "sh"), [fr]); } catch (e) { log(`[mod] ${m.id} first-run：${e.message}`); } }
  fs.writeFileSync(path.join(dirOf(m), ".ok"), JSON.stringify({ sha256: m.gz.sha256, at: Date.now() }) + "\n");
  fs.rmSync(tree, { recursive: true, force: true });
  fs.rmSync(gz, { force: true });
}

/** 暂存区的 usr/ 逐个搬进 $PREFIX。已有同名文件直接换掉：同一快照里共用的小包内容一样；pkg 先装过的以模块为准 */
function modMoveIn(stageUsr, rel = "", skipped = []) {
  for (const d of fs.readdirSync(path.join(stageUsr, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + d.name : d.name;
    const src = path.join(stageUsr, r), dst = path.join(PREFIX, r);
    let st = null; try { st = fs.lstatSync(dst); } catch {}
    if (d.isDirectory()) {
      if (st && !st.isDirectory()) { skipped.push(r); continue; }
      if (!st) fs.mkdirSync(dst, { recursive: true });
      modMoveIn(stageUsr, r, skipped);
      continue;
    }
    if (st && st.isDirectory()) { skipped.push(r); continue; }
    fs.renameSync(src, dst);
  }
  return skipped;
}

function modCancel(id) {
  const job = MOD_JOBS.get(id);
  if (!job || job.finished) return { ok: false, message: "not running" };
  if (job.phase === "installing") return { ok: false, message: tz("正在放进工具包，这一步不能中断") };
  job.cancelled = true;
  if (job.child) killTree(job.child);
  return { ok: true };
}

// ── 卸 ────────────────────────────────────────────────────────────────
/** 卸 id；它依赖的共享层没有别的已装模块在用时一并卸掉 */
function modRemove(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const mj = modulesInfo();
  if (!mj) return { ok: false, message: tz("当前是整包工具包，没有模块可卸") };
  const m = blockOf(mj, id);
  if (!m) return { ok: false, message: tz("没有这个模块：{id}", { id }) };
  if (m.required) return { ok: false, message: tz("基础模块不能卸载") };
  if (m.kind === "shared") return { ok: false, message: tz("共享运行库跟着用它的模块走，不能单独卸载") };
  for (const j of MOD_JOBS.values()) if (!j.finished) return { ok: false, message: tz("有模块正在安装，等它结束再试") };
  if (!modInstalled(mj, id)) return { ok: false, message: "not installed" };
  const dep = modDependents(mj, id);
  if (dep.modules.length || dep.components.length) return { ok: false, usedBy: dep, message: tz("{names} 要用它，先卸载那些", { names: [...dep.modules, ...dep.components].join("、") }) };
  const gone = [id];
  for (const l of (m.deps || []).map((d) => blockOf(mj, d)).filter((b) => b && b.kind === "shared" && modInstalled(mj, b.id))) {
    const still = (mj.modules || []).some((o) => o.id !== id && o.kind === "module" && (o.deps || []).includes(l.id) && modInstalled(mj, o.id));
    if (!still) gone.push(l.id);
  }
  // 还要留下的：其余已装块的路径 + 组件要用的 + pkg 装的
  const keep = new Set();
  for (const o of mj.modules || []) if (!gone.includes(o.id) && modInstalled(mj, o.id)) for (const r of filesOf(o)) keep.add(r);
  for (const [cid, rec] of compRecords()) for (const r of compNeeds(cid, rec)) keep.add(r);
  try { for (const p of Object.values(JSON.parse(fs.readFileSync(path.join(path.dirname(PREFIX), "pkg", "installed.json"), "utf8")).pkgs || {})) for (const r of p.files || []) keep.add(r); } catch {}
  let n = 0;
  for (const g of gone) {
    const b = blockOf(mj, g), files = filesOf(b);
    if (!files.length) { log(`[mod] ${g} 没有 FILES，跳过删除`); continue; }
    fs.rmSync(path.join(dirOf(b), ".ok"), { force: true });         // 先摘 .ok：删到一半被打断就是「没装」
    const dirs = new Set();
    for (const r of files) {
      if (keep.has(r)) continue;
      try { fs.unlinkSync(path.join(PREFIX, r)); n++; } catch {}
      for (let d = path.dirname(r); d && d !== "."; d = path.dirname(d)) dirs.add(d);
      // Python 运行时生成的 .pyc 不在清单里，跟着 .py 删
      if (r.endsWith(".py")) {
        const pc = path.join(PREFIX, path.dirname(r), "__pycache__"), stem = path.basename(r, ".py") + ".";
        try { for (const f of fs.readdirSync(pc)) if (f.startsWith(stem) && f.endsWith(".pyc")) fs.unlinkSync(path.join(pc, f)); } catch {}
        dirs.add(path.join(path.dirname(r), "__pycache__"));
      }
    }
    fs.rmSync(dirOf(b), { recursive: true, force: true });
    for (const d of [...dirs].sort((a, c) => c.length - a.length)) { try { fs.rmdirSync(path.join(PREFIX, d)); } catch {} }
  }
  for (const g of gone) MOD_JOBS.delete(g);
  log(`[mod] 已卸载 ${gone.join("、")}（删 ${n} 个路径）`);
  return { ok: true, removed: gone };
}

// ── 路由：/api/devkit/modules ──
export async function routeModules(req, res, u, p) {
  if (p !== "/api/devkit/modules" && !p.startsWith("/api/devkit/modules/")) return NEXT;
  if (req.method === "GET" && p === "/api/devkit/modules") return sendJson(res, 200, modList());
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const id = String(body.id || "");
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return sendJson(res, 400, { ok: false, message: "bad id" });
  if (p === "/api/devkit/modules/install") return sendJson(res, 200, await modInstall(id));
  if (p === "/api/devkit/modules/cancel") return sendJson(res, 200, modCancel(id));
  if (p === "/api/devkit/modules/remove") return sendJson(res, 200, modRemove(id));
  return sendJson(res, 404, { error: "not found" });
}

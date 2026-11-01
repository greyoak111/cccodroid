// ── 旧工具包残留：一次性隔离 ─────────────────────────────────────────
//
// 0.3.9 及以前升级工具包时，Installer.carryOver 拿 /data/user/0/… 去比 dpkg 清单里的 /data/data/…，
// 一条都对不上，旧工具包和当时装着的组件 bin/ 下的东西全被当成「用户自己装的」搬进新工具包
// （10.18 → 10.22 实测约 450 个：libreoffice、mariadb、qemu、rizin、calibre…）。
// 这些文件没人认领、大多跑不起来，还会挡住组件新带的同名程序（pdf-tools 的 pdfinfo 就这样坏的）。
//
// 这里在网关启动时做一次：bin/ 下没人认领、又是在当前工具包装好之前就有的，挪到 files/orphans-<日期>/，
// 14 天后自动删。故意留下的：
//   · npm -g 的软链（指进 lib/node_modules）、对应模块还在的 Python 命令 —— carryOver 本来就该搬的
//   · 当前工具包装好之后才出现的文件 —— 用户自己放的
import fs from "node:fs";
import path from "node:path";
import { PREFIX, log } from "./config.mjs";
import { ledger } from "./claude.mjs";
import { compNeeds, compRecords } from "./components.mjs";
import { NEXT, sendJson } from "./http.mjs";

// 放在 usr 外面：0.3.10 起 Installer 每装一次工具包都写它（那时 carryOver 已修好，搬过来的才真是用户的，不能动）。
// 所以只有「当前工具包是 0.3.9 及以前装的」才会清理，且只清一次
const MARK = () => path.join(path.dirname(PREFIX), ".orphans-v1");
const TTL = 14 * 86400e3;

const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const manPath = (l) => l.split(" ").slice(2).join(" ");

/** 底座认领的路径（相对 $PREFIX）：各包清单 + 工具包 / 模块清单。skip 里的 .list（相对路径）不算 —— 组件卸载时排除它自己带进来的包清单 */
export function baseOwnedPaths(skip) {
  const s = new Set();
  const info = path.join(PREFIX, "var/lib/dpkg/info");
  try {
    for (const f of fs.readdirSync(info)) if (f.endsWith(".list") && !(skip && skip.has("var/lib/dpkg/info/" + f)))
      for (const l of readLines(path.join(info, f))) { const i = l.indexOf("/files/usr/"); if (i >= 0) s.add(l.slice(i + 11)); }
  } catch {}
  const dk = path.join(PREFIX, "libexec/devkit");
  for (const l of readLines(path.join(dk, "FILES"))) s.add(l);
  for (const f of [path.join(dk, "MANIFEST"), path.join(PREFIX, ".devkit-manifest")]) for (const l of readLines(f)) s.add(manPath(l));
  let mods = [];
  try { mods = fs.readdirSync(path.join(dk, "modules")); } catch {}
  for (const m of mods) {
    const d = path.join(dk, "modules", m);
    for (const l of readLines(path.join(d, "FILES"))) s.add(l);
    for (const f of ["MANIFEST", "MANIFEST.local"]) for (const l of readLines(path.join(d, f))) s.add(manPath(l));
  }
  return s;
}

/** 有主的路径：底座 + 已装组件 */
function ownedPaths() {
  const s = baseOwnedPaths();
  for (const [id, rec] of compRecords()) for (const r of compNeeds(id, rec)) s.add(r);
  return s;
}

/** 脚本的解释器（相对 $PREFIX 的 bin/xxx 或绝对路径）；不是脚本返回 null */
function interp(p) {
  let head;
  try { const fd = fs.openSync(p, "r"); const b = Buffer.alloc(256); const n = fs.readSync(fd, b, 0, 256, 0); fs.closeSync(fd); head = b.subarray(0, n); }
  catch { return null; }
  if (head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF") return { elf: true };
  const s = head.toString("utf8");
  if (!s.startsWith("#!")) return null;
  const w = s.slice(2).split("\n")[0].trim().split(/\s+/);
  let i = w[0] || "";
  if (/\/env$/.test(i)) i = w[1] || "";
  return { interp: i };
}

/** Python 命令的入口模块还在不在（看 python3.x 的标准库、site-packages、lib-dynload） */
function pyModuleOk(p) {
  let m;
  try { const src = fs.readFileSync(p, "utf8"); m = /^from ([A-Za-z_]\w*)[\w.]* import/m.exec(src) || /^import ([A-Za-z_]\w*)/m.exec(src); }
  catch { return false; }
  if (!m) return true;
  const lib = path.join(PREFIX, "lib");
  let pys = [];
  try { pys = fs.readdirSync(lib).filter((n) => /^python3\.\d+$/.test(n)); } catch {}
  return pys.some((py) => ["", "site-packages", "lib-dynload"].some((d) => {
    const dir = path.join(lib, py, d);
    if (fs.existsSync(path.join(dir, m[1])) || fs.existsSync(path.join(dir, m[1] + ".py"))) return true;
    try { return fs.readdirSync(dir).some((n) => n.startsWith(m[1] + ".") && n.endsWith(".so")); } catch { return false; }
  }));
}

/** 隔离满 14 天的删掉 */
function expire() {
  const root = path.dirname(PREFIX);
  for (const n of fs.readdirSync(root)) {
    if (!/^orphans-\d{8}$/.test(n)) continue;
    const d = path.join(root, n);
    try { if (Date.now() - fs.statSync(d).mtimeMs > TTL) { fs.rmSync(d, { recursive: true, force: true }); log(`[orphans] 删掉了满 14 天的隔离目录 ${n}`); } } catch {}
  }
}

export function cleanOrphans() {
  if (!PREFIX) return;
  try { expire(); } catch {}
  // 只在模块化工具包（10.22 起，带 FILES）上做；做过一次、或工具包是 0.3.10 起装的（有标记）就不做
  if (!fs.existsSync(path.join(PREFIX, "libexec/devkit/FILES")) || fs.existsSync(MARK())) return;
  let since;
  try { since = fs.statSync(path.join(PREFIX, ".devkit-ok")).mtimeMs; } catch { return; }
  const owned = ownedPaths();
  const bin = path.join(PREFIX, "bin");
  const cand = new Map();               // rel → lstat
  for (const n of fs.readdirSync(bin)) {
    const rel = "bin/" + n;
    if (owned.has(rel)) continue;
    let st; try { st = fs.lstatSync(path.join(bin, n)); } catch { continue; }
    if (st.mtimeMs >= since) continue;  // 当前工具包装好之后才有的：用户自己放的
    cand.set(rel, st);
  }
  const out = new Set();
  // 第一轮：ELF、断掉的软链、没有解释器 / 入口模块的脚本；npm 软链和能用的 Python 命令留下
  const keep = new Set();
  for (const [rel, st] of cand) {
    const p = path.join(PREFIX, rel);
    if (st.isSymbolicLink()) {
      const t = fs.readlinkSync(p);
      let ok = false; try { fs.statSync(p); ok = true; } catch {}
      if (ok && /(^|\/)lib\/node_modules\//.test(t)) keep.add(rel);
      else if (!ok) out.add(rel);
      continue;                         // 指向别的程序的软链：第二轮跟着目标走
    }
    const k = interp(p);
    if (!k || k.elf) { out.add(rel); continue; }
    if (/python/.test(k.interp) && pyModuleOk(p)) { keep.add(rel); continue; }
    out.add(rel);
  }
  // 第二轮：指向 bin/ 里别的东西的软链跟着目标走（目标被隔离了它也隔离；目标有主或留下了它就留下）
  for (const [rel, st] of cand) {
    if (!st.isSymbolicLink() || out.has(rel) || keep.has(rel)) continue;
    // 目标换成相对 $PREFIX 的路径：绝对路径写的是 /data/data/<包名>/files/usr/…，和 PREFIX（/data/user/0/…）对不上
    const t = fs.readlinkSync(path.join(PREFIX, rel)), i = t.indexOf("/files/usr/");
    const real = t.startsWith("/") ? (i >= 0 ? t.slice(i + 11) : null) : path.normalize(path.join("bin", t));
    if (!real) continue;
    if (out.has(real) || cand.has(real) && !keep.has(real)) out.add(rel);
  }
  if (out.size) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dst = path.join(path.dirname(PREFIX), "orphans-" + day);
    fs.mkdirSync(path.join(dst, "bin"), { recursive: true });
    const moved = [];
    for (const rel of out) { try { fs.renameSync(path.join(PREFIX, rel), path.join(dst, rel)); moved.push(rel); } catch {} }
    fs.writeFileSync(path.join(dst, "README.txt"),
      "升级开发工具包时被误当成用户文件留下的旧程序（旧工具包 / 旧组件的），已经没有人认领、大多跑不起来。\n" +
      "14 天后自动删除。真有要用的，挪回 usr/bin 即可；更好的办法是装对应的组件或 pkg install。\n\n" + moved.join("\n") + "\n");
    log(`[orphans] 隔离了 ${moved.length} 个旧工具包残留到 ${dst}`);
    ledger("repair", true, `清理旧工具包残留：${moved.length} 个程序挪到 ${path.basename(dst)}（14 天后删除）`, { sample: moved.slice(0, 20) });
  }
  fs.writeFileSync(MARK(), JSON.stringify({ at: Date.now(), moved: out.size }) + "\n");
}

/** 隔离着的：[{ name, count, bytes, at }] */
function orphanDirs() {
  const root = path.dirname(PREFIX), out = [];
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => /^orphans-\d{8}$/.test(n)); } catch {}
  for (const n of names) {
    const d = path.join(root, n);
    let count = 0, bytes = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f);
        else { if (path.basename(p) === "bin") count++; try { bytes += fs.lstatSync(f).size; } catch {} }
      }
    };
    try { walk(d); out.push({ name: n, count, bytes, at: fs.statSync(d).mtimeMs }); } catch {}
  }
  return out;
}

// ── 路由：GET /api/orphans（隔离了什么）、POST /api/orphans/purge（不等 14 天，立即删）──
export async function routeOrphans(req, res, u, p) {
  if (p === "/api/orphans" && req.method === "GET") return sendJson(res, 200, { ok: true, dirs: PREFIX ? orphanDirs() : [], ttlDays: TTL / 86400e3 });
  if (p === "/api/orphans/purge" && req.method === "POST") {
    const dirs = PREFIX ? orphanDirs() : [];
    for (const d of dirs) fs.rmSync(path.join(path.dirname(PREFIX), d.name), { recursive: true, force: true });
    const n = dirs.reduce((a, d) => a + d.count, 0);
    if (dirs.length) { log(`[orphans] 立即删除隔离目录：${dirs.map((d) => d.name).join(" ")}`); ledger("repair", true, `立即删除了隔离的旧工具包残留（${n} 个程序）`); }
    return sendJson(res, 200, { ok: true, removed: n });
  }
  return NEXT;
}

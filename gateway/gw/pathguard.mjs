import fs from "node:fs";
import path from "node:path";
import { CFG, PREFIX } from "./config.mjs";

// ── 应用私有目录的判定：按目录身份（设备号 + inode）比，不按路径字符串比 ──
// 安卓上同一个数据目录有好几个名字：/data/data/<包名> 和 /data/user/0/<包名> 是绑定挂载（不是软链），
// realpath 不会把它们归并，按字符串前缀比，换个写法就绕过去了（0.6.9 审计 P0-1 / P0-2；0.6.9 的网关起不来也是这个根子）。
// 这里逐级往上看「这个路径的每一层上级目录是谁」，碰到工作区就放行，碰到私有根就拒绝 —— 别名、以后再冒出来的别名一并认得。
//
// 私有根：home、运行时（files/）、工具链前缀、整个应用数据目录（shared_prefs、app_webview、databases… 都在里面）。
// 工作区在 home 下面，是唯一的豁免；工作区若就是 home（或它的上级），豁免作废。

const ALIAS_RE = /^\/data\/(?:data|user(?:_de)?\/\d+)\/([^/]+)$/;

/** 应用数据目录（/data/user/0/<包名>）及它的别名。外壳交 CCAPP_DATA_DIR；老外壳没交时按运行时目录（files/）的上一级推 */
export function dataRoots() {
  const out = new Set();
  let d = process.env.CCAPP_DATA_DIR || (PREFIX && process.env.CCAPP_RUNTIME ? path.dirname(process.env.CCAPP_RUNTIME) : "");
  if (!d) return [];
  try { d = fs.realpathSync(d); } catch {}
  out.add(d);
  const m = ALIAS_RE.exec(d);
  if (m) {
    const user = (/^\/data\/user(?:_de)?\/(\d+)\//.exec(d + "/") || [])[1] || "0";
    out.add(`/data/user/${user}/${m[1]}`); out.add(`/data/user_de/${user}/${m[1]}`);
    if (user === "0") out.add(`/data/data/${m[1]}`);
  }
  return [...out];
}

/** 所有私有根（字符串形式；判定按身份，这里只是候选） */
export function privateRoots() {
  return [CFG.home, CFG.runtime, PREFIX, ...dataRoots()].filter(Boolean);
}

const idOf = (p) => { try { const s = fs.statSync(p); return s.dev + ":" + s.ino; } catch { return null; } };
const idSet = (list) => new Set(list.map(idOf).filter(Boolean));

/** 一个路径和它所有上级目录（从深到浅），到 / 为止 */
function* ancestors(p) {
  let cur = path.resolve(p);
  for (;;) { yield cur; const up = path.dirname(cur); if (up === cur) return; cur = up; }
}

/** 工作区豁免还算不算数：工作区本身是私有根、或者装着某个私有根（比如工作区设成了 home 的上级）就不算 */
function workspaceIds(priv) {
  const ws = idOf(CFG.workspace);
  if (!ws || priv.has(ws)) return new Set();
  if (holdsPrivate(CFG.workspace, { workspace: false })) return new Set();
  return new Set([ws]);
}

/** 这个路径（应已 realpath；不存在时按存在的那几层上级判断）落在哪：
 *  "workspace" 工作区里；"private" 应用私有目录里（工作区除外）；"public" 都不是 */
export function zoneOf(p) {
  const priv = idSet(privateRoots());
  const ws = workspaceIds(priv);
  for (const a of ancestors(p)) {
    const id = idOf(a);
    if (!id) continue;
    if (ws.has(id)) return "workspace";
    if (priv.has(id)) return "private";
  }
  return "public";
}

/** 在应用私有目录里（工作区除外） */
export const isPrivate = (p) => zoneOf(p) === "private";

/** dir 是某个私有根（或工作区）本身或它的上级：这种目录不能整个删、不能当项目、不能整个压缩或当附加目录。
 *  按身份比，别名也认得 */
export function holdsPrivate(dir, { workspace = true } = {}) {
  const want = idOf(dir);
  if (!want) return false;
  const roots = [...privateRoots(), ...(workspace ? [CFG.workspace] : [])];
  for (const r of roots) for (const a of ancestors(r)) if (idOf(a) === want) return true;
  return false;
}

/** 两个路径是不是同一个目录 / 文件（别名也认） */
export const sameFile = (a, b) => { const x = idOf(a); return !!x && x === idOf(b); };

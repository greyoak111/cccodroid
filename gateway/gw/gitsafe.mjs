import fs from "node:fs";
import path from "node:path";
import { CFG, PREFIX, log } from "./config.mjs";

// ── git 的 safe.directory：只信任登记过的项目目录，不再一律 * ──
// /sdcard 上的文件属主是系统（media_rw），git 会以 dubious ownership 拒绝那里的仓库，所以以前往 ~/.gitconfig 写了 safe.directory = *。
// 代价：共享存储谁都能写，别的应用在那里放一个带 core.fsmonitor / hooks 之类配置的仓库，
// Claude 或终端在里面跑一句 git status 就以本应用的身份执行了它的命令（0.6.9 审计 P1-10）。
// 网关自己的 Git 面板另有一套（git.mjs：只读命令把会执行命令的配置覆盖掉），这里管的是 Claude 和终端里的 git。
// 现在只信任：用户登记过的项目目录（和它下面的子目录）。工作区、home 里的仓库属主就是本应用，git 本来就信任，不用列。
// 托管块用注释标出来，用户自己写在 ~/.gitconfig 里的别的设置不动。

const BEGIN = "# >>> cccodroid 托管：git 只信任登记过的项目目录（自动生成，别手改；见 gateway/gw/gitsafe.mjs）";
const END = "# <<< cccodroid 托管";
// 旧版网关写进去的那一段（原样认，用户自己写的 safe.directory 不碰）
const LEGACY = /(^|\n)\[safe\]\n\tdirectory = \*\n/;

/** 按项目目录重写托管块。dirs：项目目录（绝对路径） */
export function syncGitSafe(dirs) {
  if (!PREFIX) return;                      // 只管 cccodroid 自己的 HOME
  const gc = path.join(CFG.home, ".gitconfig");
  let cur = "";
  try { cur = fs.readFileSync(gc, "utf8"); } catch (e) { if (e.code !== "ENOENT") return log(`[git] 读 .gitconfig 失败：${e.code || e.message}`); }
  let body = cur.replace(LEGACY, "$1");
  const i = body.indexOf(BEGIN), j = body.indexOf(END);
  if (i >= 0 && j > i) body = body.slice(0, i) + body.slice(j + END.length).replace(/^\n/, "");
  const list = [...new Set(dirs.filter((d) => typeof d === "string" && path.isAbsolute(d)).map((d) => d.replace(/\/+$/, "")))]
    // 换行、引号会把 git 配置写坏（也能借机塞别的配置项）：这种目录不列
    .filter((d) => d && !/[\n\r"\\]/.test(d));
  let block = "";
  if (list.length) block = [BEGIN, "[safe]", ...list.flatMap((d) => [`\tdirectory = ${d}`, `\tdirectory = ${d}/*`]), END].join("\n") + "\n";
  const out = (body && !body.endsWith("\n") ? body + "\n" : body) + block;
  if (out === cur) return;
  try {
    const tmp = gc + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, out, { mode: 0o644 });
    fs.renameSync(tmp, gc);
  } catch (e) { log(`[git] 写 .gitconfig 失败：${e.code || e.message}`); }
}

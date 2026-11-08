// 扩展的「停用」名单（F5）：不卸载，只是先不用。
//   mcp：停用的用户级 MCP 服务器定义（从 ~/.claude.json 里摘出来存这，启用时用 claude mcp add-json 加回去）
//   comp / mod：停用的组件、工具包模块 id —— 命令文件留在工具包里（挪走会让「核对记录」报缺），只是不再写进给 Claude 的系统提示
// 技能的停用不在这里：用 claude 自己认的 settings.json skillOverrides（发行版打包时据此跳过，见 seal.mjs）。
import path from "node:path";
import { CFG } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";

export const EXT_OFF_FILE = path.join(CFG.home, "ccapp-ext-off.json");
const ID = /^[A-Za-z0-9._-]{1,64}$/;

function shape(j) {
  const o = { mcp: {}, comp: [], mod: [] };
  if (!isObj(j)) return undefined;
  if (isObj(j.mcp)) for (const [k, v] of Object.entries(j.mcp)) if (ID.test(k) && isObj(v)) o.mcp[k] = v;
  for (const k of ["comp", "mod"]) if (Array.isArray(j[k])) o[k] = [...new Set(j[k].filter((x) => typeof x === "string" && ID.test(x)))];
  return o;
}

/** 读名单；文件没有或坏了给空名单（坏的留底成 .bad-*） */
export function extOff() {
  return loadState(EXT_OFF_FILE, { shape, fallback: () => ({ mcp: {}, comp: [], mod: [] }), max: 4 << 20 }).data;
}
/** 写名单，0600（MCP 定义里可能有密钥）。失败返回 false */
export function saveExtOff(o) { return saveState(EXT_OFF_FILE, shape(o) || { mcp: {}, comp: [], mod: [] }); }
export const extIdOk = (s) => typeof s === "string" && ID.test(s);

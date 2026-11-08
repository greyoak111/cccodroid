// 会话保留期（D10 第 1 步）：claude 每次启动都按 cleanupPeriodDays（缺省 30 天）清扫，
// 超期的会话记录连同 tool-results、file-history、子代理记录一起删，不进回收站（2.1.311 实测：-p、接口连不上也照删）。
// 会话是用户的资产，不删就一直留着：
//   · 用户级 ~/.claude/settings.json 没写这个键，网关启动时补成 RETENTION_DAYS（extensions.mjs 的 ensureSessionRetention）——管住终端里直接敲的 claude；
//   · 网关每次起 claude 都经 --settings 带上（claude.mjs 的 settingsArgs）——项目目录里的 settings.json 写个 1 天会压过用户级的，
//     --settings 的优先级比项目设置高，压得住（实测）。终端的包装脚本（android/assets/bin/claude）同理。
// 用户自己写过合法的值就照用户的。claude 只收 ≥1 的整数，3650 只管十年，36500 实测 9000 天前的也留着。
import path from "node:path";
import { CFG } from "./config.mjs";
import { readSmallFile } from "./saferead.mjs";

export const RETENTION_DAYS = 36500;
export const retentionOk = (v) => Number.isInteger(v) && v >= 1;
export const USER_SETTINGS_FILE = () => path.join(CFG.home, ".claude", "settings.json");

/** 用户级设置里的保留期：{ days, own }。own = 用户自己写了合法的值；没写、写坏了、文件读不了都按 RETENTION_DAYS */
export function sessionRetention() {
  let v;
  try { const j = JSON.parse(readSmallFile(USER_SETTINGS_FILE(), 1 << 20) || "{}"); if (j && typeof j === "object") v = j.cleanupPeriodDays; } catch {}
  return retentionOk(v) ? { days: v, own: v !== RETENTION_DAYS } : { days: RETENTION_DAYS, own: false };
}

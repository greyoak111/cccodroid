// 篡改留痕：应用自己的程序文件被改过，一律还原，但不悄悄还原 —— 记进日志、界面提示一次、下一轮告诉模型。
// 三个来源：
//   · app     应用（Java）起网关前逐文件核 files/app，对不上就按安装包重铺，清单经环境变量 CCAPP_TAMPERED 交过来（不落盘，模型删不掉）
//   · runtime 网关跑着时 appfiles.mjs 把被改的小目录文件写回、多出来的删掉；界面文件对不上不发并等空闲重启
//   · claude  claude 程序和版本目录里存的官方清单（Anthropic 签名）对不上，这一轮不起（见 claudeseal.mjs）
// 只在内存里：网关重启后，应用那边再核一遍、再交一次。
import { log } from "./config.mjs";

const EVENTS = [];        // { id, at, src, files[] }
let seq = 0;
const MAX = 20;
let notify = null;
/** 事件总线挂进来（bus.mjs）：这边不 import 它，appfiles.mjs 很早就要用到这里，免得循环引用 */
export const onTamper = (fn) => { notify = fn; };

export function tamperRecord(src, files) {
  // 文件名是改动的人起的，要拼进给模型的提醒：只留路径里常见的字符，别让它借文件名塞一段话进去（DeepSeek 复核建议 6）
  // 空格也换掉：留着空格就能用一串文件名拼出一句英文指令（11-04 报告）
  const list = (Array.isArray(files) ? files : [files]).map((f) => String(f).trim().replace(/[^\w.\/:()-]/g, "_").slice(0, 120)).filter(Boolean).slice(0, 20);
  if (!list.length) return null;
  // 一直有人在改（每 10 秒写回一次）：并进还没点过「知道了」的同一类，没有新文件就不再推，免得提示连着弹
  const open = EVENTS.findLast((e) => e.src === src && !e.acked && Date.now() - e.at < 3600e3);
  if (open) {
    const fresh = list.filter((x) => !open.files.includes(x));
    open.count = (open.count || 1) + 1;
    if (!fresh.length) return open;
    open.files.push(...fresh.slice(0, 20 - open.files.length));
    open.told = false;
    log(`⚠️ [篡改留痕] 又有改动：${fresh.join(", ")}`);
    try { notify?.(tamperPending()); } catch {}
    return open;
  }
  const ev = { id: ++seq, at: Date.now(), src, files: list, told: false, acked: false };
  EVENTS.push(ev);
  if (EVENTS.length > MAX) EVENTS.shift();
  log(`⚠️ [篡改留痕] ${src === "app" ? "应用起网关前" : src === "claude" ? "Claude Code 程序" : "网关运行中"}发现改动并已处理：${list.join(", ")}`);
  try { notify?.(tamperPending()); } catch {}
  return ev;
}

/** 界面还没点过「知道了」的 */
export const tamperPending = () => EVENTS.filter((e) => !e.acked).map(({ id, at, src, files }) => ({ id, at, src, files }));
export function tamperAck(id) {
  for (const e of EVENTS) if (id == null || e.id === Number(id)) e.acked = true;
}

/** 下一轮随用户消息带给模型（只说一次）。写成事实陈述：不指责，但讲清楚改动已撤销、别再改回去 */
export function tamperNote() {
  const fresh = EVENTS.filter((e) => !e.told);
  if (!fresh.length) return "";
  for (const e of fresh) e.told = true;
  const files = [...new Set(fresh.flatMap((e) => e.files))].slice(0, 12).join(", ");
  const claude = fresh.some((e) => e.src === "claude");
  return "App note: cccodroid found its own program files modified outside the app's normal update path and " +
    (claude ? "refused to start a modified Claude Code binary; " : "") +
    `restored them from the installed package (${files}). Any such change, including one made earlier in this session, has been undone. ` +
    "Don't try to reapply it or work around these safeguards; if you made the change, tell the user plainly.";
}

// 应用交过来的：JSON 数组（文件名），起网关前那次核对的结果
try {
  const raw = process.env.CCAPP_TAMPERED;
  if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) tamperRecord("app", a); }
} catch {}
delete process.env.CCAPP_TAMPERED;   // 别再传给 claude、终端这些子进程

// 刚升级：应用起网关前按新安装包重铺了 files/app（版本差异，不是篡改）。只记一行，不进留痕、不提醒模型（更新链复盘 U-04）
{
  const raw = String(process.env.CCAPP_UPDATED || "").replace(/[^\w.\->?+]/g, "_").slice(0, 80);
  if (raw) log(`[更新] 应用已升级（${raw}），界面与网关文件已按新安装包铺好`);
}
delete process.env.CCAPP_UPDATED;

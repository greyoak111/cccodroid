// 文件全路径提醒：模型常只写「index.html」「game/main.js」，界面只认绝对路径，用户点不开、预览不了。
// 照建档的路子分两层：常驻规则在系统提示里（previewHint，带上当前目录举例）；
// 一轮结束时核对：这一轮写过 / 改过的文件，回复里只提了名字、没写全路径的，记下来，
// 下一条用户消息带一段提醒递进去（放用户消息里模型才照做，见建档的经验）。前端另有兜底（01-core.js 的 WROTE）。
import path from "node:path";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NOTES = new Map();          // sessionId → 下一轮要带的提醒

/** 一轮的观察者：feed 喂 claude 的事件，check 在收尾时算有没有偷懒 */
export function pathWatch() {
  const files = new Set();
  let text = "";
  return {
    feed(ev) {
      if (ev.type !== "assistant" || ev.parent_tool_use_id || ev.isSidechain || !Array.isArray(ev.message?.content)) return;
      for (const c of ev.message.content) {
        if (c?.type === "tool_use" && WRITE_TOOLS.has(c.name)) {
          const p = c.input?.file_path || c.input?.notebook_path;
          if (typeof p === "string" && p.startsWith("/")) files.add(p);
        } else if (c?.type === "text" && c.text) text += "\n" + c.text;
      }
    },
    /** 只提了名字（或相对路径）、全路径一次没出现的文件：[{ file, said }] */
    lazy() {
      const out = [];
      for (const f of files) {
        if (text.includes(f)) continue;
        const parts = f.split("/").filter(Boolean);
        for (let i = parts.length - 1; i >= Math.max(1, parts.length - 4); i--) {
          const said = parts.slice(i).join("/");
          const re = new RegExp(`(^|[^\\w/.-])${said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`);
          if (re.test(text)) { out.push({ file: f, said }); break; }
        }
      }
      return out;
    },
  };
}

/** 收尾时调：有偷懒的就给这个会话记一条，下一轮带上；这一轮写对了就清掉旧的 */
export function settlePathNote(sid, watch) {
  if (!sid || !watch) return;
  const lz = watch.lazy();
  if (!lz.length) { NOTES.delete(sid); return; }
  const eg = lz.slice(0, 3).map((x) => `${x.said} → ${x.file}`).join("; ");
  NOTES.set(sid, `Path note: your last reply mentioned files by name only (${eg}). In this app only a full absolute path is tappable — the user can't open or preview a bare file name or a relative path, and can't see your working directory. Whenever you mention a file, write its whole path starting with /.`);
}

/** 起一轮时取（取了就清）：没有就是空串 */
export function takePathNote(sid) {
  if (!sid || !NOTES.has(sid)) return "";
  const n = NOTES.get(sid); NOTES.delete(sid); return n;
}

/** 这一轮没送到模型：取走的放回去（这期间又记了新的就以新的为准） */
export function putPathNote(sid, n) {
  if (sid && n && !NOTES.has(sid)) NOTES.set(sid, n);
}

/** 常驻规则：带上当前目录举例，模型对「全路径」才有概念 */
export function previewHint(cwd) {
  const eg = path.join(cwd || "/data/user/0/cc.codroid/files/home/workspace", "index.html");
  return "In this app, file paths you mention in a reply are tappable and open in a file viewer, where .html files render as a live preview (relative CSS, JS and images load, and it reloads when the file changes). " +
    `Only full absolute paths are tappable: whenever you mention a file you created or changed, write its whole path starting with / (for example \`${eg}\`), never just a file name or a path relative to your working directory — the user doesn't see your working directory. ` +
    "Write the path as plain text (inline code is fine); don't wrap it in a Markdown link or a file:// URL — the app turns it into a link itself. " +
    "For a static web page or browser game, write the file and give the user its full path instead of starting a local web server; start a server only when the page needs a backend.";
}

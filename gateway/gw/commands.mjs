// ── 常用指令（自定义斜杠命令，0.4.20）──────────────────────────────────
// 就是 Claude Code 官方的自定义命令：一条指令 = commands 目录里一个 <名字>.md，正文是发给 Claude 的提示，
// 可以用 $ARGUMENTS（/名字 后面跟的话）、$1 $2…。头部 frontmatter 只管两项：description（列表里的说明）、argument-hint（参数提示）。
// 两个范围：所有项目 ~/.claude/commands；本项目 <工作目录>/.claude/commands（进 git 就跟着仓库走）。
// 文件是 claude 自己读的：终端里敲 claude 也能用，换设备拷文件就带走。-p 下 $ARGUMENTS 展开已实测（10-28）。
// 只管顶层的 .md；子目录里的（官方当命名空间用）照样能用，这里不列也不改。
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { pathBlocked } from "./files.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";

export const CMD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_BODY = 64 * 1024;
// 文件比正文多出 frontmatter 和结尾换行：列表按这个上限读，保存时也按写出去的整份核，免得刚存的读不出来（#133）
const MAX_FILE = MAX_BODY + 4096;

function cmdDir(scope, dir) {
  if (scope === "user") return path.join(process.env.HOME || CFG.home, ".claude", "commands");
  if (scope !== "project") throw new Error("bad scope");
  const d = path.resolve(String(dir || CFG.workspace));
  let ok = false, real = d; try { real = fs.realpathSync(d); ok = fs.statSync(real).isDirectory(); } catch {}
  if (!ok) throw new Error("project dir not found: " + d);
  // 项目范围不许落在应用私有目录里（home、运行时；工作区除外）：往 home 里塞一条斜杠命令，等于给用户下套（11-03 审查 L-18，同文件面板的政策）
  if (pathBlocked(real)) throw new Error("project dir is private: " + d);
  // .claude 或 commands 本身是软链、指到私有目录（或别处的 home 里）：校验过了目录、动作却顺着链走（0.6.9 审计 P2 R1）
  const cd = path.join(real, ".claude", "commands");
  for (const p of [path.join(real, ".claude"), cd]) {
    let rp = null; try { rp = fs.realpathSync(p); } catch {}
    if (rp && (pathBlocked(rp) || rp !== p)) throw new Error("project commands dir is a link or private: " + p);
  }
  return cd;
}

/** 拆 frontmatter：description / argument-hint 读出来给界面改，其余项原样留着。
 *  一项 = 顶格的 key: 行 + 后面缩进的续行。以前只认单行，description: | 这种多行写法被读成「|」、
 *  续行留进 extra，保存后成了非法 YAML（审查 B22） */
export function parseCmd(txt) {
  const out = { description: "", hint: "", body: String(txt || ""), extra: "" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(out.body);
  if (!m) return out;
  out.body = out.body.slice(m[0].length);
  const items = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (items.length && (/^[ \t]/.test(line) || !line.trim())) items[items.length - 1].push(line);
    else items.push([line]);
  }
  const keep = [];
  for (const it of items) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(it[0]);
    const key = kv && (kv[1] === "description" ? "description" : kv[1] === "argument-hint" ? "hint" : "");
    if (!key) { while (it.length > 1 && !it[it.length - 1].trim()) it.pop(); if (it.some((l) => l.trim())) keep.push(it.join("\n")); continue; }
    const head = kv[2].trim(), rest = it.slice(1).map((l) => l.trim()).filter(Boolean);
    let v;
    if (/^[|>][+-]?\d*$/.test(head)) v = rest.join(head[0] === "|" ? "\n" : " ");   // 块标量：界面上是一行，换行变空格见 saveCmd
    else {
      // 引号里的要按 YAML 的规矩解开转义：只去掉外层引号，存一次多一层反斜杠，越存越多（#97 02-009）
      const raw = [head, ...rest].filter(Boolean).join(" ");
      if (/^"[\s\S]*"$/.test(raw)) { try { v = JSON.parse(raw); } catch { v = raw.slice(1, -1); } }
      else if (/^'[\s\S]*'$/.test(raw)) v = raw.slice(1, -1).replace(/''/g, "'");
      else v = raw;
    }
    out[key] = v;
  }
  out.extra = keep.join("\n");
  return out;
}
// 开头是 [ ] - . 或数字的裸写会被 YAML 读成数组 / 列表 / 数字：一律加引号（DeepSeek 复核 低-3）
const yq = (s) => (/^[\w\s一-鿿，。、（）()<>\[\].-]*$/.test(s) && !/^\s|\s$/.test(s) && !/^[\[\]\-.\d]/.test(s) ? s : JSON.stringify(s));
export function formatCmd({ description, hint, body, extra }) {
  const fm = [];
  if (description) fm.push(`description: ${yq(description)}`);
  if (hint) fm.push(`argument-hint: ${yq(hint)}`);
  if (extra) fm.push(extra);
  const b = String(body || "").replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
  return fm.length ? `---\n${fm.join("\n")}\n---\n${b}` : b;
}

export function listCmds(scope, dir) {
  let d; try { d = cmdDir(scope, dir); } catch (e) { return { scope, error: e.message, items: [] }; }
  let names = []; try { names = fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort(); } catch {}
  const items = [];
  for (const f of names) {
    const name = f.slice(0, -3);
    let txt = ""; try { const st = fs.statSync(path.join(d, f)); if (!st.isFile() || st.size > MAX_FILE) continue; txt = fs.readFileSync(path.join(d, f), "utf8"); } catch { continue; }
    const c = parseCmd(txt);
    items.push({ name, description: c.description, hint: c.hint, body: c.body, extra: c.extra, editable: CMD_NAME_RE.test(name) });
  }
  return { scope, dir: d, items };
}

/** 能力页 / 斜杠列表用：名字 → 说明（全局 + 工作目录的，后者覆盖前者，和 claude 的优先级一致） */
export function cmdDescs() {
  const m = {};
  for (const s of ["user", "project"]) for (const c of listCmds(s).items) m[c.name] = { desc: c.description, hint: c.hint, scope: s };
  return m;
}

function saveCmd(b, builtin) {
  const scope = b.scope === "project" ? "project" : "user";
  const name = String(b.name || "").trim();
  if (!CMD_NAME_RE.test(name)) return { ok: false, message: "名字只能用字母、数字、- 和 _，不超过 40 个字符" };
  if (builtin.has(name)) return { ok: false, message: "和自带的命令重名了，换个名字" };
  const body = String(b.body || "");
  if (!body.trim()) return { ok: false, message: "指令内容不能是空的" };
  if (Buffer.byteLength(body) > MAX_BODY) return { ok: false, message: "指令内容太长了（上限 64 KB）" };
  const d = cmdDir(scope, b.dir), file = path.join(d, name + ".md");
  const old = b.oldName && b.oldName !== name ? String(b.oldName) : "";
  if (old && !CMD_NAME_RE.test(old)) return { ok: false, message: "bad name" };
  if ((old || b.fresh) && fs.existsSync(file)) return { ok: false, message: "已经有同名的指令了" };
  const ucb = scope === "user" ? ucAppBegin() : null;
  fs.mkdirSync(d, { recursive: true });
  const desc = String(b.description || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const hint = String(b.hint || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  // 改名 / 编辑时把我们不管的 frontmatter 项（allowed-tools 等）带过去
  let extra = "";
  try { extra = parseCmd(fs.readFileSync(path.join(d, (old || name) + ".md"), "utf8")).extra; } catch {}
  const text = formatCmd({ description: desc, hint, body, extra });
  if (Buffer.byteLength(text) > MAX_FILE) return { ok: false, message: "指令内容太长了（上限 64 KB）" };
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
  if (old) { try { fs.unlinkSync(path.join(d, old + ".md")); } catch {} }
  if (scope === "user") ucAppWrote([d], ucb);   // 用户在常用指令页自己存的：认下（见 userconf.mjs）
  log(`[commands] 保存 /${name}（${scope}）${old ? "，原名 /" + old : ""}`);
  return { ok: true, name, file };
}

// ── 路由：/api/commands（GET 两个范围的清单）/api/commands/save /api/commands/del ──
export function commandRoutes(builtinNames) {
  return async function routeCommands(req, res, u, p) {
    if (!p.startsWith("/api/commands")) return NEXT;
    if (req.method === "GET" && p === "/api/commands") {
      const dir = u.searchParams.get("dir") || CFG.workspace;
      return sendJson(res, 200, { scopes: [listCmds("user"), listCmds("project", dir)], workspace: path.resolve(dir) });
    }
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    try {
      if (req.method === "POST" && p === "/api/commands/save") return sendJson(res, 200, saveCmd(b, new Set(builtinNames())));
      if (req.method === "POST" && p === "/api/commands/del") {
        const name = String(b.name || "");
        if (!CMD_NAME_RE.test(name)) return sendJson(res, 400, { ok: false, message: "bad name" });
        const f = path.join(cmdDir(b.scope === "project" ? "project" : "user", b.dir), name + ".md");
        const ucb = b.scope !== "project" ? ucAppBegin() : null;
        try { fs.unlinkSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (b.scope !== "project") ucAppWrote([path.dirname(f)], ucb);
        log(`[commands] 删除 /${name}（${b.scope}）`);
        return sendJson(res, 200, { ok: true });
      }
    } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    return NEXT;
  };
}

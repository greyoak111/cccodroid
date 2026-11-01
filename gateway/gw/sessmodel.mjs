// ── 每个会话自己的模型与思考强度（0.3.16 起）────────────────────────────
// 全局设置（SETTINGS.model / effort，设置页里改）是默认值；会话里在输入栏面板单独选过，才记一条它自己的，
// 没选过的会话一直跟着全局默认走（全局改了它也跟着变）。各会话按各自的模型并行跑（run.mjs 每轮按自己的模型起 claude）。
// 还没会话号的新会话：前端把选的值随第一条消息带来（/api/chat 的 pin），拿到会话号时记上。
// 接口（provider）也按会话：单独选过模型（含 "" = 接口默认）的会话钉在记下的那家，全局切了接口它也照旧用那家；
// 只选过思考强度的（model 为 null）模型和接口都跟着全局默认。记下的那家被删了，这条就当没有。
// 存储：home/ccapp-session-models.json  { 会话号: { model, effort, provider, at } }，留最近 3000 条。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { cachedModels, effortLevelsOf, normEffort } from "./models.mjs";
import { projectById, projectDefaults, projectOfDir } from "./projects.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";

const FILE = path.join(CFG.home, "ccapp-session-models.json");
let DB = {};
try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch {}
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const ids = Object.keys(DB);
    if (ids.length > 3000) for (const id of ids.sort((a, b) => (DB[a].at || 0) - (DB[b].at || 0)).slice(0, ids.length - 3000)) delete DB[id];
    try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(FILE + ".tmp", FILE); } catch {}
  }, 300);
}

/** 这个会话记下的选择；没记过、或记的那家已经不在了，返回 null */
export function sessModel(sid) {
  const r = sid && DB[sid];
  if (!r) return null;
  if (r.model != null && !providerById(r.provider)) return null;
  return r;
}
/** 这个会话用哪家：钉了模型就是记下的那家，否则全局生效的那家 */
export function sessProvider(sid) {
  const r = sessModel(sid);
  return (r && r.model != null && providerById(r.provider)) || PROVIDER;
}
/** 记下（只改给了的字段）。model 为 "" 表示「接口默认」，也是一种选择 */
export function clearSessModel(sid) { if (sid && DB[sid]) { delete DB[sid]; save(); } }
export function setSessModel(sid, patch, projectId) {
  if (!sid) return;
  const old = sessModel(sid) || {};
  // 没指明接口：沿用这个会话现在真跑的那家（钉过的那家 → 项目默认 → 全局生效的），别把项目会话钉回全局（#78）。
  // projectId：新会话首条记 pin 时会话文件可能还没落盘，按文件反推不出项目，由调用方给（复核 M2）
  const r = { model: old.model ?? null, effort: old.effort ?? null, provider: effectiveModel(sid, projectId).provider, at: Date.now() };
  // 指明了接口就钉住它（哪怕和全局是同一家：全局以后再切，这个会话也不跟）
  if (patch.provider && (patch.provider !== r.provider || r.model == null)) {
    r.provider = String(patch.provider);
    r.model = "";                  // 换了家：旧模型名对新家没意义，先用新家的默认，除非同时给了模型
  }
  if (patch.model !== undefined) r.model = patch.model == null ? null : String(patch.model);
  if (patch.effort !== undefined) r.effort = patch.effort == null ? null : String(patch.effort);
  DB[sid] = r;
  save();
}
/** 这个会话所在的项目（按会话当初的目录找）；新会话由前端给项目号 */
function projectFor(sid, projectId) {
  if (projectId) return projectById(projectId);
  if (!sid) return null;
  try { const f = findSessionFile(String(sid)); const c = f && peekSession(f.file).cwd; return c ? projectOfDir(c) : null; } catch { return null; }
}
/** 界面上显示的「这个会话现在用什么」，和 run.mjs 开跑时的取值顺序一致：
 *  会话钉的 → 项目默认（项目指定了接口就用那家，模型名是给那家的）→ 全局默认。
 *  over：新会话还没会话号，前端暂存的选择 { provider, model, effort }。
 *  effortRun：真跑时的思考强度 —— 跟来的档位那家模型不支持时，换成它支持的（标签上显示这个） */
export function effectiveModel(sid, projectId, over) {
  let r = sessModel(sid);
  if (over && (over.provider || over.model != null || over.effort != null)) {
    const p = over.provider && providerById(over.provider);
    r = { model: over.model != null ? over.model : p ? "" : null, effort: over.effort != null ? over.effort : null, provider: p ? p.id : PROVIDER.id };
  }
  const pin = r && r.model != null;
  const pdef = projectDefaults(projectFor(sid, projectId));
  const pp = (pin && providerById(r.provider)) || (pdef.provider && providerById(pdef.provider)) || PROVIDER;
  const model = pin ? r.model
    : (pp.id === (pdef.provider || PROVIDER.id) ? pdef.model : "") || (pp.id === PROVIDER.id ? SETTINGS.model || "" : "");
  const effort = (r && r.effort != null ? r.effort : pdef.effort || SETTINGS.effort) || "";
  let effortRun = effort;
  if (effort && !pp.local) {
    // 只认同名（和 /api/models、currentModelInfo 一致，#82）：清单里没有这个型号就不拿第一项的档位表去校验
    const want = model || pp.defaultModel, list = cachedModels(pp), mi = (want ? list.find((m) => m.id === want) : list[0]) || {};
    if (!effortLevelsOf(mi, pp).includes(effort)) effortRun = normEffort(mi, effort, pp) || "";
  }
  return { model, effort, effortRun, provider: pp.id, ownProvider: pp.id !== PROVIDER.id, own: !!r,
    defaultModel: pp.defaultModel || null,
    rec: r ? { model: r.model, effort: r.effort, provider: r.provider } : null };   // 原样的记录：null 的字段是「跟随默认」
}

// ── 路由：/api/session-model ──
//   GET  ?id=会话号 / ?project=&provider=&model=&effort=（新会话） → { model, effort, effortRun, provider, own, rec }
//   POST { id, model?, effort?, provider? } → 记到这个会话上（不动全局默认）；只给 provider = 换家、用它的默认模型
//   POST { id, reset: true }             → 清掉，回到跟随全局默认
export async function routeSessModel(req, res, u, p) {
  if (p !== "/api/session-model") return NEXT;
  if (req.method === "GET") {
    const q = (k) => (u.searchParams.has(k) ? u.searchParams.get(k) : null);
    return sendJson(res, 200, effectiveModel(q("id") || "", q("project"), { provider: q("provider"), model: q("model"), effort: q("effort") }));
  }
  if (req.method === "POST") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const patch = {};
    if (typeof b.model === "string") patch.model = b.model.trim().slice(0, 200);
    if (typeof b.effort === "string") patch.effort = b.effort.trim().slice(0, 20);
    if (!b.id) return sendJson(res, 400, { error: "id" });
    if (typeof b.provider === "string" && b.provider) {
      if (!providerById(b.provider)) return sendJson(res, 400, { error: "provider" });
      patch.provider = b.provider;
    }
    if (b.reset) clearSessModel(String(b.id)); else setSessModel(String(b.id), patch);
    return sendJson(res, 200, { ok: true, ...effectiveModel(String(b.id)) });
  }
  return NEXT;
}

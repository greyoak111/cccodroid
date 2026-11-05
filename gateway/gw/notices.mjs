// ── 应用内通知：维护者经 cccodroid.net 推一两句话给所有用户（出了什么问题、该怎么绕、哪版修了）─────
//
// 来源：仓库 notices/notices.json，维护者在发布机上用组件索引那把 ed25519 钥匙签名（notices.json.sig），
// 官网生成器验过签才镜像到 https://cccodroid.net/notices.json。这里先取官网、取不到取 GitHub，
// 两边都只认签名对得上的那份 —— 官网被人改了也推不出假通知。
// 内容只当纯文本显示；链接只认 https。按 App 版本范围（minVer / maxVer）和有效期（from / until）筛选，
// 「知道了」记在 home/.config/cccodroid/notices-seen.json，同一条不再显示。
// 不发任何本机信息：就是一次普通的 GET，和检查更新一样。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, PREFIX, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { privCall } from "./usage.mjs";

const SOURCES = (process.env.CCAPP_NOTICES_URL ? [process.env.CCAPP_NOTICES_URL] : [])
  .concat(["https://cccodroid.net/notices.json", "https://raw.githubusercontent.com/greyoak111/cccodroid/main/notices/notices.json"]);
// 与组件索引同一把公钥（gw/components.mjs）；Claude Code 验证记录（gw/ccverified.mjs）也用它。测试（CCAPP_TEST=1）时可换成测试钥匙
export const PUBKEY = crypto.createPublicKey(!LIVE && process.env.CCAPP_TEST_PUBKEY ? process.env.CCAPP_TEST_PUBKEY :
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=\n-----END PUBLIC KEY-----\n");
const EVERY = 3 * 3600e3;
/** 读回验过签才存的那份：正文原样字节 + 旁边的 .sig；签名对不上、缺 .sig（旧版存的）都当没有，等下次联网重取 */
export function loadSigned(file) {
  try {
    const body = fs.readFileSync(file), sig = fs.readFileSync(file + ".sig", "utf8").trim();
    if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) { log(`[signed] ${path.basename(file)} 签名对不上，不认`); return null; }
    return JSON.parse(body.toString("utf8"));
  } catch { return null; }
}
/** 存正文原样字节（不重新序列化，签名才对得上）和签名；先写 .sig 再换正文，换到一半也只是验不过、当没有 */
export function saveSigned(file, body, sig) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".sig.tmp", sig); fs.renameSync(file + ".sig.tmp", file + ".sig");
  fs.writeFileSync(file + ".tmp", body); fs.renameSync(file + ".tmp", file);
}
const CACHE = path.join(CFG.home, ".cache", "cccodroid", "notices.json");
const SEEN = path.join(CFG.home, ".config", "cccodroid", "notices-seen.json");

let data = null, fetchedAt = 0, lastError = "", appVer = "", busy = null;
// 磁盘上那份连同签名一起存（CACHE.sig），读回来再验一遍：同 uid 的程序能写这个文件，没签名的不认（审查 11-05 安全 1）
data = loadSigned(CACHE);

const readSeen = () => { try { return new Set(JSON.parse(fs.readFileSync(SEEN, "utf8")).dismissed || []); } catch { return new Set(); } };

// 版本比较：0.3.10 > 0.3.9；带后缀的（0.3.12-preview）按数字部分比
const num = (v) => String(v || "").split("-")[0].split(".").map((x) => +x || 0);
function cmpVer(a, b) { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }

async function fetchOne(url) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const body = await get(url), sig = (await get(url + ".sig")).toString("utf8").trim();
  if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) throw new Error("签名对不上");
  const j = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(j.notices)) throw new Error("格式不对");
  return { j, body, sig };
}

export async function refreshNotices(force = false) {
  if (busy) return busy;
  if (!force && Date.now() - fetchedAt < EVERY) return;
  busy = (async () => {
    if (PREFIX && !appVer) {
      const st = await privCall({ op: "upd_status" }, 5000).catch(() => ({}));
      appVer = st?.items?.find?.((i) => i.id === "app")?.current || "";
    }
    const errs = [];
    for (const u of SOURCES) {
      try {
        const { j, body, sig } = await fetchOne(u);
        // 两个来源可能一新一旧（官网每半小时同步）：只往新的换
        if (!data || !(String(j.updated || "") < String(data.updated || ""))) {
          data = j;
          saveSigned(CACHE, body, sig);
        }
        fetchedAt = Date.now(); lastError = "";
        return;
      } catch (e) { errs.push(`${new URL(u).host}：${e.cause?.code || e.message}`); }
    }
    fetchedAt = Date.now() - EVERY + 600e3;     // 都失败：10 分钟后再试
    lastError = errs.join("；");
    log(`[notices] 取不到：${lastError}`);
  })().finally(() => { busy = null; });
  return busy;
}

const pick = (o, lang) => (o && typeof o === "object" ? o[lang] || o.zh || o.en || "" : String(o || ""));

function active(lang) {
  const today = new Date().toISOString().slice(0, 10);
  return (data?.notices || []).filter((n) => n && n.id
    && (!n.from || n.from <= today) && (!n.until || n.until >= today)
    && (!n.minVer || !appVer || cmpVer(appVer, n.minVer) >= 0)
    && (!n.maxVer || !appVer || cmpVer(appVer, n.maxVer) <= 0)
  ).map((n) => ({
    id: String(n.id), level: n.level === "warn" ? "warn" : "info", date: n.from || n.date || "",
    title: pick(n.title, lang), body: pick(n.body, lang),
    link: /^https:\/\/[^\s"'<>]+$/.test(n.link || "") ? n.link : "",
    linkText: pick(n.linkText, lang),
  }));
}

// 后台每 3 小时取一次。界面只在打开应用 / 切回前台时来要（用的时候不打扰），那时过期了就当场取，最多等 8 秒
if (LIVE) setInterval(() => refreshNotices().catch(() => {}), EVERY).unref?.();

// GET /api/notices[?lang=en&all=1]：要显示的通知（all=1 连已关掉的一起，给设置页「通知」看）
// POST /api/notices/dismiss {id}：知道了
export async function routeNotices(req, res, u, p) {
  if (p === "/api/notices" && req.method === "GET") {
    await Promise.race([refreshNotices().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
    const lang = (u.searchParams.get("lang") || "zh").startsWith("zh") ? "zh" : "en";
    const seen = readSeen(), all = active(lang);
    const items = u.searchParams.get("all") === "1" ? all.map((n) => ({ ...n, seen: seen.has(n.id) })) : all.filter((n) => !seen.has(n.id));
    return sendJson(res, 200, { ok: true, items, error: lastError, at: fetchedAt });
  }
  if (p === "/api/notices/dismiss" && req.method === "POST") {
    let id = "";
    try { id = String(JSON.parse(await readBody(req)).id || ""); } catch {}
    if (!id) return sendJson(res, 400, { ok: false });
    const seen = readSeen(); seen.add(id);
    // 只留还在发布的那些 id，文件不会越积越大
    const live = new Set((data?.notices || []).map((n) => String(n.id)));
    fs.mkdirSync(path.dirname(SEEN), { recursive: true });
    fs.writeFileSync(SEEN, JSON.stringify({ dismissed: [...seen].filter((x) => live.has(x) || x === id) }));
    return sendJson(res, 200, { ok: true });
  }
  return NEXT;
}

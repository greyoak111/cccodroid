// ── Claude Code 真机验证记录：哪些版本在 cccodroid 上验过、哪些有已知问题 ─────────────────────────
//
// 来源：仓库 claude-code/verified.json，维护者用 scripts/verify-claude.mjs 在真机上跑、scripts/claude-verified.mjs 签名发布
// （与应用内通知同一把钥匙、同一条路：官网验过签才镜像）。这里先取官网、取不到取 GitHub，只认签名对得上的。
// 用处：版本选单标「已验证」/ 有问题的原因（/api/claude/versions 带上）；验过签的那份存到
// home/.cache/cccodroid/claude-verified.json，Java 的自动更新读它——渠道走到有问题的版本时先不自动装。
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, log } from "./config.mjs";
import { PUBKEY, loadSigned, saveSigned } from "./notices.mjs";

// CCAPP_CLAUDE_VERIFIED_URL：只用这一个地址（测试用）
const SOURCES = process.env.CCAPP_CLAUDE_VERIFIED_URL ? [process.env.CCAPP_CLAUDE_VERIFIED_URL]
  : ["https://cccodroid.net/claude-code/verified.json", "https://raw.githubusercontent.com/greyoak111/cccodroid/main/claude-code/verified.json"];
const EVERY = 3 * 3600e3;
export const VERIFIED_CACHE = path.join(CFG.home, ".cache", "cccodroid", "claude-verified.json");

let data = null, fetchedAt = 0, lastError = "", busy = null;
// 磁盘上那份连同签名一起存（VERIFIED_CACHE.sig），读回来再验一遍：同 uid 的程序能写这个文件，没签名的不认（审查 11-05 安全 1）
data = loadSigned(VERIFIED_CACHE);

async function fetchOne(url) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const body = await get(url), sig = (await get(url + ".sig")).toString("utf8").trim();
  if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) throw new Error("签名对不上");
  const j = JSON.parse(body.toString("utf8"));
  if (!j || typeof j.versions !== "object" || typeof j.bad !== "object") throw new Error("格式不对");
  return { j, body, sig };
}

export function refreshVerified(force = false) {
  if (busy) return busy;
  if (!force && Date.now() - fetchedAt < EVERY) return Promise.resolve();
  busy = (async () => {
    const errs = [];
    for (const u of SOURCES) {
      try {
        const { j, body, sig } = await fetchOne(u);
        // 官网每半小时同步，两个来源可能一新一旧：只往新的换
        if (!data || !(String(j.updated || "") < String(data.updated || ""))) {
          data = j;
          saveSigned(VERIFIED_CACHE, body, sig);
        }
        fetchedAt = Date.now(); lastError = "";
        return;
      } catch (e) { errs.push(`${new URL(u).host}：${e.cause?.code || e.message}`); }
    }
    fetchedAt = Date.now() - EVERY + 600e3;     // 都失败：10 分钟后再试
    lastError = errs.join("；");
    log(`[claude-verified] 取不到：${lastError}`);
  })().finally(() => { busy = null; });
  return busy;
}

/** 给版本选单：{ verified: {版本: [{device, android, at, app}]}, bad: {版本: {text, fixed}} } —— 最多等 5 秒，取不到就用手上的 */
export async function verifiedInfo(lang = "zh") {
  await Promise.race([refreshVerified().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  const verified = {}, bad = {};
  for (const [v, recs] of Object.entries(data?.versions || {})) if (Array.isArray(recs) && recs.length)
    verified[v] = recs.map((r) => ({ device: String(r.device || ""), android: String(r.android || ""), at: String(r.at || ""), app: String(r.app || ""), targetSdk: +r.targetSdk || 0 }));
  for (const [v, b] of Object.entries(data?.bad || {})) if (b) bad[v] = { text: String((lang === "zh" ? b.zh : b.en) || b.zh || b.en || ""), fixed: String(b.fixed || "") };
  return { verified, bad, verifiedError: lastError };
}

// 服务起来 15 秒后取一次（Java 的自动更新要用磁盘上那份），之后每 3 小时
if (LIVE) {
  setTimeout(() => refreshVerified().catch(() => {}), 15000).unref?.();
  setInterval(() => refreshVerified().catch(() => {}), EVERY).unref?.();
}

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  changelog.mjs —— 生成 App 里「更新日志」页的数据：gateway/web/changelog/zh.json、en.json
//
//  内容就是 GitHub Releases 的正文（tag v*，跳过预发布），按「---  ## English」拆成中英两份；
//  每版都一样的「安装 / Install」小节去掉，其余原样。还没发布的版本（android/assets/whatsnew 里
//  比最新 Release 新的）用 APK 自带的更新说明补在最前面，这样打包时当前版本也在里面。
//  拉不到 GitHub 时沿用上次生成的已发布部分，只补 whatsnew。
//
//  用法:  node scripts/changelog.mjs          写好新版的 whatsnew 说明后跑一次，连同生成结果一起提交
//  格式:  [{ v: "0.3.12", date: "2026-10-22", md: "…" }, …]  新的在前。还没发布的版本记生成这天（就是要发的那天），
//         包装好到用户手里时它已经发了，别标成「未发布」
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "gateway/web/changelog");
const WN = path.join(ROOT, "android/assets/whatsnew");
const REPO = "greyoak111/cccodroid";

const cmpVer = (a, b) => {
  const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
};
// 去掉某个三级小节（到下一个同级或更高的标题、或分隔线为止）
const dropSec = (md, names) => md.replace(new RegExp(`^### (?:${names.join("|")})\\s*\\n[\\s\\S]*?(?=^#{1,3} |^-{3,}\\s*$|(?![\\s\\S]))`, "gm"), "");
const tidy = (md) => md.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

function split(body) {
  const b = body.replace(/\r/g, "").replace(/^\*\*简体中文\*\*[^\n]*\n+/, "");
  const [zh, en = ""] = b.split(/\n-{3,}\s*\n+## English[^\n]*\n/);
  return { zh: tidy(dropSec(zh, ["安装"])), en: tidy(dropSec(en || zh, ["Install"])) };
}

// 日期按本机时区：GitHub 给的是 UTC，北京时间早上发的版会差一天，和包里自带的那版对不上
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
let released = null;
try {
  // 每条 Release 一行 JSON。以前把各页的数组用正则 ][ → , 拼起来：正文里写了 [文字][引用] 这种 Markdown 就被拼坏了
  const raw = execFileSync("gh", ["api", "--paginate", `repos/${REPO}/releases?per_page=100`, "--jq", ".[] | {tag_name, prerelease, draft, published_at, created_at, body}"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  const list = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  released = { zh: [], en: [] };
  for (const r of list) {
    if (!/^v\d+\.\d+\.\d+$/.test(r.tag_name) || r.prerelease || r.draft) continue;
    const v = r.tag_name.slice(1), date = ymd(new Date(r.published_at || r.created_at)), s = split(r.body || "");
    released.zh.push({ v, date, md: s.zh });
    released.en.push({ v, date, md: s.en });
  }
  console.log(`  GitHub：${released.zh.length} 个版本`);
} catch (e) {
  console.log("  ⚠ 拉不到 GitHub Releases，沿用上次生成的：" + String(e.message || e).split("\n")[0]);
}

const today = ymd(new Date());
fs.mkdirSync(OUT, { recursive: true });
for (const lang of ["zh", "en"]) {
  const file = path.join(OUT, lang + ".json");
  let rel = released ? released[lang] : [];
  if (!released) try { rel = JSON.parse(fs.readFileSync(file, "utf8")).filter((x) => !x.pre); } catch {}
  const top = rel.reduce((m, x) => (cmpVer(x.v, m) > 0 ? x.v : m), "0");
  const fresh = [];
  for (const f of fs.existsSync(WN) ? fs.readdirSync(WN) : []) {
    const m = f.match(/^v(\d+\.\d+\.\d+)\.(zh|en)\.md$/);
    if (!m || m[2] !== lang || cmpVer(m[1], top) <= 0) continue;
    fresh.push({ v: m[1], date: today, pre: 1, md: tidy(fs.readFileSync(path.join(WN, f), "utf8")) });
  }
  const all = [...fresh, ...rel].sort((a, b) => cmpVer(b.v, a.v));
  fs.writeFileSync(file, JSON.stringify(all) + "\n");
  console.log(`  ✓ ${path.relative(ROOT, file)}  ${all.length} 版（未发布 ${fresh.length}）  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

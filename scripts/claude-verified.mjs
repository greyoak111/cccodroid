#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  claude-verified.mjs —— 维护「哪些 Claude Code 版本在 cccodroid 上真机验过 / 哪些有问题」（经 cccodroid.net 发给所有用户）
//
//  node scripts/claude-verified.mjs list
//  node scripts/claude-verified.mjs add <claude-verify-X.Y.Z.json …>     并进真机验证结果（scripts/verify-claude.mjs 在手机上跑出来的）
//  node scripts/claude-verified.mjs bad <版本> --zh "出了什么事、怎么绕" --en "…" [--fixed <版本>]
//  node scripts/claude-verified.mjs unbad <版本>      撤掉「有问题」
//  node scripts/claude-verified.mjs rm <版本>         删掉这一版的验证记录
//  node scripts/claude-verified.mjs publish           只重签推送（手改过 verified.json 时用）
//
//  App 里：版本选单给验过的版本标「已验证」，有问题的标出原因、选之前要确认；
//  渠道（stable / latest）走到有问题的版本时，自动更新先不装（用户自己点更新照样装）。
//  每次改动都会签名（组件索引那把钥匙）→ 提交推送 main → 等 cccodroid.net/claude-code/verified.json 同步，同 notice.mjs。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { ROOT, die, loadPublished, signAndPublish } from "./signed-pub.mjs";

const FILE = "claude-code/verified.json", F = path.join(ROOT, FILE);
const SITE = "https://cccodroid.net/claude-code/verified.json";
const VER = /^\d+\.\d+\.\d+$/;
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const isMap = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const load = () => loadPublished(F, { v: 1, updated: "", versions: {}, bad: {} }, (d) => isMap(d.versions) && (d.bad === undefined || isMap(d.bad)));
const cmpVer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const devName = (r) => `${r.device} · Android ${r.android}`;
const d = load();
d.bad ||= {};
const cmd = argv.shift();

if (cmd === "list" || !cmd) {
  const vs = Object.keys(d.versions).sort((a, b) => cmpVer(b, a));
  if (!vs.length) console.log("（还没有验证记录）");
  for (const v of vs) console.log(`${v}  ${d.versions[v].map((r) => `${devName(r)}（${r.at}，App ${r.app || "?"}）${r.newSyscalls?.length ? " 新拦截：" + r.newSyscalls.join(",") : ""}`).join("；")}`);
  for (const [v, b] of Object.entries(d.bad)) console.log(`✗ ${v}  ${b.zh}${b.fixed ? `（${b.fixed} 已修）` : ""}`);
  if (!cmd) console.log("\n用法见文件开头注释");
  process.exit(0);
}

let msg;
if (cmd === "add") {
  if (!argv.length) die("给 verify-claude.mjs 跑出来的结果文件");
  const added = [];
  for (const f of argv) {
    let r;
    try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { die(`${f} 读不了：${e.message}`); }
    if (r.v !== 1 || !VER.test(r.version || "")) die(`${f} 不是 verify-claude.mjs 的结果`);
    if (!r.pass) die(`${f}：${r.version} 没通过验证（${Object.entries(r.steps).filter(([, s]) => !s.pass).map(([k, s]) => `${k}: ${s.detail}`).join("；")}），不能记成已验证`);
    if (!r.app || !r.device?.targetSdk) die(`${f}：结果里没有 App 版本 / 安装包类型——不是在 cccodroid 的终端里跑的，不能当真机验证`);
    if (r.npmOnly) console.log(`  注意：${r.version} 当时只靠 npm 签名装上，没按官方清单核过 sha256`);
    const rec = { at: r.at.slice(0, 10), device: [r.device.maker, r.device.model].filter(Boolean).join(" "), android: r.device.android, sdk: r.device.sdk,
      targetSdk: r.device.targetSdk, app: r.app, devkit: r.devkit, sha256: r.sha256 };
    const fresh = r.syscalls.filter((s) => !s.known).map((s) => s.name || String(s.nr));
    if (fresh.length) { rec.newSyscalls = fresh; console.log(`  注意：${r.version} 有以前没见过的被拦调用 ${fresh.join(", ")}——三步过了，但确认功能没缺再发`); }
    // 同一台设备、同一 Android 版本、同一种安装包（28 / 36）只留最新一条
    const list = (d.versions[r.version] || []).filter((x) => !(x.device === rec.device && x.android === rec.android && x.targetSdk === rec.targetSdk));
    if (list.some((x) => x.sha256 !== rec.sha256)) die(`${r.version} 的 sha256 和已有记录不一致——不该发生，先查清楚`);
    d.versions[r.version] = [...list, rec];
    added.push(`${r.version}（${devName(rec)}）`);
  }
  msg = `Claude Code 真机验证：${added.join("、")}`;
} else if (cmd === "bad") {
  const v = argv.shift(), zh = opt("--zh"), en = opt("--en"), fixed = opt("--fixed");
  if (!VER.test(v || "")) die("版本号要 2.1.300 这样的");
  if (!zh || !en) die("--zh 和 --en 都要写：一两句话说清出了什么事、怎么绕");
  if (fixed && !VER.test(fixed)) die("--fixed 要版本号");
  d.bad[v] = { zh, en, at: new Date().toISOString().slice(0, 10), ...(fixed ? { fixed } : {}) };
  msg = `Claude Code ${v} 标为有问题：${zh}`;
} else if (cmd === "unbad" || cmd === "rm") {
  const v = argv.shift(), box = cmd === "unbad" ? d.bad : d.versions;
  if (!box[v]) die(`没有 ${v}`);
  delete box[v];
  msg = cmd === "unbad" ? `Claude Code ${v} 撤掉「有问题」` : `删掉 Claude Code ${v} 的验证记录`;
} else if (cmd === "publish") msg = "重签 Claude Code 验证记录";
else die(`不认识的命令 ${cmd}`);

// 只留最近 40 个验过的版本：版本选单只需要近期的
const keep = Object.keys(d.versions).sort((a, b) => cmpVer(b, a)).slice(0, 40);
d.versions = Object.fromEntries(keep.sort(cmpVer).map((v) => [v, d.versions[v]]));
d.v = 1;
d.updated = new Date().toISOString();
await signAndPublish({ file: FILE, data: d, msg, site: SITE });

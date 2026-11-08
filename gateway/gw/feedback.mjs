import fs from "node:fs";
import { execFile } from "node:child_process";
import { CFG, PREFIX, reqLang, tr, tz } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { COMP_DIR, compRecord, devkitIdentity } from "./components.mjs";
import { devkitVersion } from "./envfacts.mjs";
import { privCall } from "./usage.mjs";
import { ENV_FACTS, envFactsKey, envFactsRerun, envFactsStatus } from "./envfacts.mjs";

// ── 反馈：拼一个预先填好的 GitHub Issue 链接 ─────────────────────────────
// 用户点「到 GitHub 反馈」：机型、系统、各家 ROM 版本、自检结果、装了哪些组件都填好，用户只写遇到了什么。
// 只放设备与版本信息，不放日志、密钥、账号、对话（那些走「打包诊断」私下发）。链接有长度上限，自检明细超了就截
const ISSUE_REPO = "https://github.com/greyoak111/cccodroid/issues/new";
// 各家 ROM 自己的版本号属性：杀后台、权限路径都跟着 ROM 走，比机型更有用
const ROM_PROPS = [
  ["ro.mi.os.version.name", "HyperOS"], ["ro.miui.ui.version.name", "MIUI"], ["ro.build.version.oplusrom", "ColorOS"],
  ["ro.build.version.opporom", "ColorOS"], ["ro.vivo.os.version", "OriginOS/Funtouch"], ["ro.build.version.magic", "MagicOS"],
  ["ro.build.version.emui", "EMUI"], ["ro.build.version.oneui", "One UI"], ["ro.zui.version", "ZUI"], ["ro.build.MiFavor_version", "MyOS"],
  ["ro.flyme.version.id", "Flyme"], ["ro.build.version.realmeui", "realme UI"], ["ro.rom.version", "ROM"],
];
async function issueDraft(lang) {
  const L = (k) => tr(lang, tz(k));   // 正文不经 sendJson 的 message 翻译，这里按请求语言自己翻
  const props = {};
  try {
    const out = await new Promise((ok) => execFile("/system/bin/getprop", [], { timeout: 5000, maxBuffer: 4 << 20 }, (e, so) => ok(String(so || ""))));
    for (const m of out.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) props[m[1]] = m[2];
  } catch {}
  const g = (k) => props[k] || "";
  // 两次问原生并行：以前串行，最坏各等 5 秒，「到 GitHub 反馈」要 ~10 秒（0.6.9 审计 196 端侧.5）
  const [upd, shz] = PREFIX ? await Promise.all([privCall({ op: "upd_status" }, 5000), privCall({ op: "status" }, 5000)]) : [{}, {}];
  const ver = (id) => ((upd.items || []).find((i) => i.id === id) || {}).current || "";
  const rom = ROM_PROPS.filter(([k]) => g(k)).map(([k, n]) => `${n} ${g(k)}`).slice(0, 2).join(" · ") || g("ro.build.display.id");
  const gpu = fs.existsSync("/dev/kgsl-3d0") ? "Adreno (kgsl)" : fs.existsSync("/dev/mali0") ? "Mali" : fs.existsSync("/dev/pvrsrvkm") ? "PowerVR" : "?";
  let ram = ""; try { ram = (Number(/MemTotal:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1048576).toFixed(1) + " GB"; } catch {}
  let disk = ""; try { const st = fs.statfsSync(CFG.home); disk = ((st.bavail * st.bsize) / 2 ** 30).toFixed(0) + " GB"; } catch {}
  const dk = devkitIdentity() || {};
  const row = (k, v) => (v ? `| ${k} | ${String(v).replace(/[|\n]/g, " ")} |` : "");
  const dev = [
    "| | |", "|---|---|",
    row("cccodroid", ver("app") || (PREFIX ? "?" : "dev")),
    row("Toolchain", ver("devkit") || devkitVersion(dk)),
    row("Claude Code", ver("claude")),
    row("Android", `${g("ro.build.version.release")} (SDK ${g("ro.build.version.sdk")})`),
    row("Device", `${g("ro.product.manufacturer")} ${g("ro.product.model")}${g("ro.product.brand") && g("ro.product.brand").toLowerCase() !== g("ro.product.manufacturer").toLowerCase() ? ` (${g("ro.product.brand")})` : ""}`),
    row("ROM", rom),
    row("SoC", [g("ro.soc.manufacturer"), g("ro.soc.model")].filter(Boolean).join(" ") || g("ro.hardware") || g("ro.board.platform")),
    row("GPU", gpu),
    row("ABI", g("ro.product.cpu.abi")),
    row("RAM / free space", [ram, disk].filter(Boolean).join(" · ")),
    row("Shizuku", shz.state || ""),
    row("Killed in background", shz.frozen && shz.frozen.count ? `${shz.frozen.count}×` : ""),
  ].filter(Boolean).join("\n");
  let st = "";
  let r = null; try { r = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  // 自检文件是合法 JSON 但缺/写坏 fail、info、pass 时别 500（0.6.9 审计 195-M.9）
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const fails = Array.isArray(r.fail) ? r.fail : [];
    const infos = Array.isArray(r.info) ? r.info : [];
    const pass = Number.isFinite(Number(r.pass)) ? Number(r.pass) : 0;
    st = `Passed ${pass}, failed ${fails.length}${r.key !== envFactsKey() ? " (before the last update)" : ""}`;
    if (fails.length) st += "\n\n" + fails.slice(0, 15).map((x) => "- " + x).join("\n");
    if (infos.length) st += "\n\n<details><summary>Info</summary>\n\n" + infos.slice(0, 10).map((x) => "- " + x).join("\n") + "\n</details>";
    r = { pass, fail: fails, info: infos };
  } else st = PREFIX ? "Not run yet" : "n/a";
  let comps = "";
  try {
    comps = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith(".json")).map((f) => compRecord(f.slice(0, -5)))
      .filter((c) => c && c.state === "ok").map((c) => `${c.id} ${c.version}`).join(", ");
  } catch {}
  const build = (stx) => [
    "### " + L("遇到了什么"), "", "<!-- " + L("做了什么、想要什么结果、实际怎样。截图可以直接拖进来。") + " -->", "", "",
    "### " + L("怎么复现"), "", "1. ", "",
    "### Device", "", dev, "",
    "### Self-test", "", stx, "",
    comps ? "### Components\n\n" + comps + "\n" : "",
    "<sub>Filled in by cccodroid. No logs, keys, account or conversation content.</sub>",
  ].join("\n");
  let body = build(st);
  if (encodeURIComponent(body).length > 7000) body = build(r ? `Passed ${r.pass}, failed ${r.fail.length}` + (r.fail.length ? "\n\n" + r.fail.slice(0, 5).map((x) => "- " + x.slice(0, 120)).join("\n") : "") : st);
  const title = `[${g("ro.product.manufacturer")} ${g("ro.product.model")} · Android ${g("ro.build.version.release")}] `;
  return { title, body, url: `${ISSUE_REPO}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` };
}

// ── 路由：/api/issue-draft ──
export async function routeFeedback(req, res, u, p) {
  if (req.method === "GET" && p === "/api/issue-draft") return sendJson(res, 200, await issueDraft(reqLang(req)));
  // 本机自检：设置 → 排障里看结果、点「重新自检」（195-M.1）
  if (req.method === "GET" && p === "/api/env-facts") return sendJson(res, 200, envFactsStatus());
  if (req.method === "POST" && p === "/api/env-facts/rerun") return sendJson(res, 200, envFactsRerun());
  return NEXT;
}

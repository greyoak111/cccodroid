import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, HERE, PREFIX, log } from "./config.mjs";
import { ensureShell, killTree } from "./claude.mjs";
import { RUNS } from "./runs.mjs";
import { termEnv } from "./terminal.mjs";
import { COMP_DIR, compRecord, devkitIdentity } from "./components.mjs";
import { modInstalled, modulesInfo } from "./modules.mjs";
import { reconcileFacts } from "./reconcile.mjs";
import { deviceFacts } from "./device.mjs";

// ── 本机实况：TOOLS.md 是打包时在测试机上测的，这里补上「这台设备上实际怎样」 ──
// 自检（cccodroid-selftest）在本机跑一遍，失败项和 INFO（比如有没有硬件编码器）接在 TOOLS.md 后面；
// 装了哪些组件、用 pkg 装了哪些包，每轮现读。自检只在工具包或应用版本变了之后、空闲时重跑（要一两分钟 CPU）
export const ENV_FACTS = PREFIX ? path.join(CFG.home, ".cccodroid-env.json") : "";
export function envFactsKey() {
  const dk = devkitIdentity() || {};
  let tag = ""; try { tag = fs.readFileSync(path.join(HERE, "TAG"), "utf8").trim(); } catch {}
  // 模块化工具包：装 / 卸模块后也要重测（自检按已装模块跑）
  const mj = modulesInfo(), mods = mj ? (mj.modules || []).filter((m) => modInstalled(mj, m.id)).map((m) => m.id).join(",") : "";
  return `${dk.sha256 || dk.tag || "?"}|${tag}${mods ? "|" + mods : ""}`;
}
let envFactsJob = null;
function envFactsRun() {
  const st = path.join(process.env.CCAPP_BIN || "", "cccodroid-selftest");
  if (!PREFIX || envFactsJob || !fs.existsSync(st)) return;
  const key = envFactsKey(), nice = path.join(PREFIX, "bin", "nice");
  // 经 Claude 用的同一个 shell 包装起（挂着 termux-exec）：直接调 bash 的话 #!/usr/bin/env 一类脚本全报 bad interpreter，
  // 自检就会把「这台设备上 shebang 不能用」这种假结论告诉 Claude
  const sh = ensureShell();
  const argv = fs.existsSync(nice) ? [nice, "-n", "10", sh, st] : [sh, st];
  let out = "";
  log("[env] 本机自检开始（工具包或应用换了版本）");
  envFactsJob = spawn(argv[0], argv.slice(1), { env: { ...termEnv(), CCAPP_ENVFACTS: "1" }, cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  envFactsJob.stdout.setEncoding("utf8"); envFactsJob.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  envFactsJob.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
  envFactsJob.stderr.on("data", () => {});
  const t = setTimeout(() => { try { killTree(envFactsJob); } catch {} }, 15 * 60e3);
  envFactsJob.on("close", () => {
    clearTimeout(t); envFactsJob = null;
    const r = { key, at: Date.now(), pass: 0, fail: [], info: [] };
    for (const l of out.split("\n")) {
      if (l.startsWith("PASS ")) r.pass++;
      else if (l.startsWith("FAIL ")) r.fail.push(l.slice(5, 260));
      else if (l.startsWith("INFO ")) r.info.push(l.slice(5, 260));
    }
    if (!r.pass) { log("[env] 自检没跑出结果，下次再试"); return; }
    try { fs.writeFileSync(ENV_FACTS, JSON.stringify(r, null, 1)); } catch {}
    log(`[env] 本机自检：通过 ${r.pass} 项，失败 ${r.fail.length} 项`);
  });
}
// 空闲（没有 claude 在跑）且结果过期时才跑：启动 2 分钟后看一次，之后每 5 分钟
function envFactsTick() {
  if (RUNS.size || envFactsJob) return;
  let cur = null; try { cur = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  if (!cur || cur.key !== envFactsKey()) envFactsRun();
}
if (PREFIX) { setTimeout(envFactsTick, 2 * 60e3).unref?.(); setInterval(envFactsTick, 5 * 60e3).unref?.(); }

const pickDesc = (m) => (m.desc && m.desc.zh) || "";
export function envFacts() {
  const out = [];
  const dev = deviceFacts();
  if (dev) out.push(dev);
  const dk = devkitIdentity();
  if (dk && dk.tag) out.push(`- 工具包：${dk.tag}`);
  // 模块化工具包：装了哪些模块；没装的模块里的命令现在用不了 —— TOOLS.md 是按全装写的，这里纠正
  const mj = modulesInfo();
  if (mj) {
    const mods = (mj.modules || []).filter((m) => m.kind !== "shared");
    const on = mods.filter((m) => modInstalled(mj, m.id)), off = mods.filter((m) => !modInstalled(mj, m.id));
    out.push(`- 工具包模块：已装 ${on.map((m) => m.name.zh || m.id).join("、")}`);
    if (off.length) {
      out.push("- **没装的模块**（下面这些命令现在不可用，TOOLS.md 里写到的也一样；用户需要时请他到 扩展 → 工具包模块 安装，别用 pkg 另装一份）：");
      for (const m of off) {
        // 先列主要命令（devkit.json 的 key），没有就只说是库
        const k = m.key && m.key.length ? m.key : [];
        out.push(`  - ${m.name.zh || m.id}（约 ${Math.round((m.installed || 0) / 1048576)} MB）：${k.length ? k.join(" ") + ((m.commands || []).length > k.length ? ` 等 ${m.commands.length} 个命令` : "") : pickDesc(m)}`);
      }
    }
  }
  // 扩展页装的组件
  try {
    const comps = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith(".json")).map((f) => compRecord(f.slice(0, -5)))
      .filter((r) => r && r.state === "ok").map((r) => `${r.id} ${r.version}${r.bin && r.bin.length ? `（命令：${r.bin.join("、")}）` : ""}`);
    if (comps.length) out.push(`- 已装组件：${comps.join("；")}`);
  } catch {}
  // pkg 装的包（只列用户点名装的，依赖不列）
  try {
    const db = JSON.parse(fs.readFileSync(path.join(path.dirname(PREFIX), "pkg", "installed.json"), "utf8")).pkgs || {};
    const have = new Set(fs.readdirSync(path.join(PREFIX, "var/lib/dpkg/info")).filter((f) => f.endsWith(".list")).map((f) => f.slice(0, -5)));
    const mine = Object.entries(db).filter(([, r]) => !r.auto);
    const ok = mine.filter(([n]) => have.has(n)).map(([n, r]) => `${n} ${r.version}`), lost = mine.filter(([n]) => !have.has(n)).map(([n]) => n);
    if (ok.length) out.push(`- 用 pkg 装过：${ok.join("、")}`);
    if (lost.length) out.push(`- 工具包更新后这些 pkg 包已不在：${lost.join("、")}（要用就先 \`pkg restore\`）`);
  } catch {}
  out.push(...reconcileFacts());
  // 这份 JSON 在 home 下、拼进系统提示（群友破甲清单 V-14）：只认自检写的几个字段，逐条压成单行、限长，别让它带进成段的文字
  let r = null; try { r = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  const line = (x) => String(x).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 260);
  if (r && typeof r === "object") r = { key: String(r.key || ""), pass: Number(r.pass) | 0,
    fail: (Array.isArray(r.fail) ? r.fail : []).slice(0, 12).map(line), info: (Array.isArray(r.info) ? r.info : []).slice(0, 8).map(line) };
  else r = null;
  if (r) {
    const stale = r.key !== envFactsKey() ? "（工具包或应用更新前测的）" : "";
    out.push(`- 本机自检${stale}：通过 ${r.pass} 项${r.fail.length ? `，**失败 ${r.fail.length} 项 —— 下列功能在这台设备上不能用，别依赖，需要时如实告诉用户**：` : "，全部通过"}`);
    for (const f of r.fail.slice(0, 12)) out.push(`  - ${f}`);
    for (const i of r.info.slice(0, 8)) out.push(`- ${i}`);
  }
  return out.length ? "## 本机实况（自动生成）\n\n" + out.join("\n") : "";
}

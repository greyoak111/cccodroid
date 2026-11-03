#!/usr/bin/env node
// cccodroid 建档命令：会话里的 AI 用它给刚结束的一章交档。规范见同目录的 spec.<语言>.md。
// 用法：node cc-archive.mjs --title "题名" [--same] [--misc] [--status 进行中|已完成|搁置] [--chapter N]
// 它把题名交给网关（POST /api/archive，带网关令牌与本轮编号 CCAPP_RUN_ID），网关按规范校验后存档。
// 不合格时退出码 1，并打印要改的地方。只能在网关拉起的 claude 里用（要有 CCAPP_RUN_ID / CCAPP_GW_PORT）。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--same") opt.same = true;
  else if (a === "--misc") opt.misc = true;
  else if (a === "--title" || a === "--status" || a === "--chapter") opt[a.slice(2)] = args[++i];
  else if (a.startsWith("--title=")) opt.title = a.slice(8);
  else if (a === "-h" || a === "--help") { console.log("node cc-archive.mjs --title \"题名\" [--same] [--misc] [--status 进行中|已完成|搁置] [--chapter N]"); process.exit(0); }
}
const run = process.env.CCAPP_RUN_ID, port = Number(process.env.CCAPP_GW_PORT);
if (!run || !port) { console.error("cc-archive: not running inside a cccodroid session (CCAPP_RUN_ID / CCAPP_GW_PORT missing)"); process.exit(2); }
if (!opt.title) { console.error("cc-archive: --title is required"); process.exit(2); }
let token = "";
const home = process.env.CCAPP_HOME || process.env.HOME || "";
try { token = fs.readFileSync(path.join(home, ".gateway-token"), "utf8").trim(); } catch {}

// 交令牌之前先确认对面是真网关（/__proof：真网关用令牌算 HMAC，别人算不出）。端口号来自环境变量，
// 改成别的监听者的端口，令牌就递出去了（11-03 审查 L-6）
function prove() {
  const n = crypto.randomBytes(16).toString("hex");
  return new Promise((ok) => {
    // 对面不回话、一个字一个字地拖、回一大串：都要先判失败再断开（只 destroy 不 resolve 会让这条命令一直挂着 —— DeepSeek 复核 11-03）
    const cut = () => { ok(false); rq.destroy(); };
    setTimeout(cut, 15000).unref();
    const rq = http.get({ host: "127.0.0.1", port, path: "/__proof?n=" + n, timeout: 10000 }, (res) => {
      let s = ""; res.setEncoding("utf8");
      res.on("data", (d) => { s += d; if (s.length > 4096) cut(); });
      res.on("end", () => {
        const [boot, got] = s.trim().split(" ");
        const want = boot && crypto.createHmac("sha256", token).update(`proof:${n}:${boot}:127.0.0.1`).digest("hex");
        ok(!!(want && got && want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))));
      });
    });
    rq.on("error", () => ok(false)); rq.on("timeout", cut);
  });
}
if (!token || !(await prove())) { console.error("cc-archive: the gateway on port " + port + " could not prove itself; token not sent"); process.exit(2); }

const body = JSON.stringify({ run, title: opt.title, same: !!opt.same, misc: !!opt.misc, status: opt.status, chapter: opt.chapter != null ? Number(opt.chapter) : undefined });
const req = http.request({ host: "127.0.0.1", port, path: "/api/archive", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-cc-token": token } }, (res) => {
  let s = ""; res.setEncoding("utf8");
  res.on("data", (d) => (s += d));
  res.on("end", () => {
    let j = {}; try { j = JSON.parse(s); } catch {}
    if (j.ok) { console.log(`filed ${j.no}: ${j.title}`); process.exit(0); }
    console.error("rejected:\n- " + (j.errors || [j.error || `HTTP ${res.statusCode}`]).join("\n- "));
    process.exit(1);
  });
});
req.on("error", (e) => { console.error("cc-archive: gateway unreachable: " + e.message); process.exit(2); });
req.setTimeout(30000, () => req.destroy(new Error("timeout")));
req.end(body);

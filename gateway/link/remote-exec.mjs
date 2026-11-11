#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  remote-exec.mjs —— 远程任务执行器
//
//  linkd 收到别的设备派来的任务后，用本机 Node 拉起这个脚本。它复用
//  cccodroid 网关自己的 claude 启动参数（厂商 / 密钥 / 模型 / shell），
//  跑一个一次性的 claude（不写会话），把最终文本以 JSON 行交给 linkd：
//
//    {"type":"progress","text":"…"}      中间进展（工具名 / 部分回答）
//    {"type":"done","text":"…"}          最终结果
//    {"type":"error","message":"…"}      失败
//
//  安卓上额外挂载 app 的「设备工具」MCP（读屏点按、通知、打开 App），
//  这样抖音 / 小红书这类只能在手机上做的事，远程任务也能调用。
//
//  用法（由 linkd 调用，不要手写）：
//    node remote-exec.mjs --prompt-file <文件> --cwd <目录> --timeout 600 --max-turns 40
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const IS_ANDROID = process.platform === "android";
const MAX_RESULT = 512 * 1024;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

const promptFile = arg("prompt-file", "");
const cwdArg = arg("cwd", "");
const timeout = Math.max(10, Math.min(3600, Number(arg("timeout", 600)) || 600));
const maxTurns = Math.max(1, Math.min(200, Number(arg("max-turns", 40)) || 40));

let prompt = "";
try { prompt = fs.readFileSync(promptFile, "utf8"); } catch (e) { emit({ type: "error", message: "读不到任务文件: " + e.message }); process.exit(0); }
if (!prompt.trim()) { emit({ type: "error", message: "任务内容为空" }); process.exit(0); }

let cwd = cwdArg || process.cwd();
try { if (!fs.statSync(cwd).isDirectory()) cwd = process.cwd(); } catch { cwd = process.cwd(); }

// 网关模块：Windows 在 <app>/gateway/gw/，安卓在 <files>/app/gw/
function gatewayModule() {
  const env = String(process.env.CCAPP_EXEC_GW || "").trim();
  if (env) return env;
  const beside = path.resolve(HERE, "..", "gw", "claude.mjs");
  if (fs.existsSync(beside)) return beside;
  if (IS_WIN) return path.resolve(HERE, "..", "gateway", "gw", "claude.mjs");
  const app = path.join(process.env.CCAPP_RUNTIME || "/data/user/0/cc.codroid/files", "app");
  return path.join(app, "gw", "claude.mjs");
}

// 关键：CCAPP_TEST=1 让网关模块不做启动副作用（恢复中断记录、装技能、起定时器），
// 只借用它的配置读取和 claude 启动参数。
process.env.CCAPP_TEST = "1";
process.env.CCAPP_REMOTE_TASK = "1";

const SYSTEM = [
  "You are a remote worker running on the user's other device on their behalf.",
  "You cannot see the caller's conversation; the task below must be self-contained.",
  "Use the tools available on this device. When finished, your final message is returned verbatim to the caller.",
  "Include concrete results: data, command output, absolute file paths, and anything the caller needs to continue.",
  "If the task needs a human confirmation, an app login, or hardware you cannot reach, say exactly what is missing instead of pretending it worked.",
  "你是用户另一台设备上的远程执行者；任务来自同一个用户的另一台设备。最终回复会原样返回给对方，请写清结果、数据、文件绝对路径。做不到就直说缺什么。",
].join("\n");

// 用户点名（@手机 / @电脑）派过来的这一轮：直接续上同一个会话，看得到完整上下文，
// 回复也写回 transcript，再由 linkd 同步回调用方。和「Claude 自己用 remote_task 派活」不同。
const SYSTEM_SESSION = [
  "You are the assistant in this ongoing conversation, now running on the user's other device.",
  "Continue the conversation naturally and answer the user's latest message below; use this device's tools when the task needs them.",
  "If something needs a login, a human confirmation, or hardware you cannot reach, say exactly what is missing.",
  "你正在继续这段对话（这一段跑在用户的另一台设备上）。直接回答用户下面这条消息，需要时使用这台设备上的工具；做不到就直说缺什么。",
].join("\n");

const resumeId = String(arg("resume", "")).trim();

async function main() {
  const gwPath = gatewayModule();
  let gw;
  try { gw = await import("file://" + gwPath.replace(/\\/g, "/")); }
  catch (e) { emit({ type: "error", message: "加载网关模块失败: " + e.message }); return; }

  const extra = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
    // 点名派过来的：续跑同一个会话并写回 transcript；普通远程任务仍然一次性、不写会话
    ...(resumeId ? ["--resume", resumeId, "--append-system-prompt", SYSTEM_SESSION]
                 : ["--no-session-persistence", "--append-system-prompt", SYSTEM]),
    "--max-turns", String(maxTurns),
  ];
  // 安卓：挂设备工具 MCP（读屏点按 / 打开 App / 通知）。工具开关在应用设置里。
  if (IS_ANDROID) {
    const mcp = path.join(process.env.CCAPP_RUNTIME || "/data/user/0/cc.codroid/files", "app", "bin", "device-mcp.mjs");
    if (fs.existsSync(mcp)) {
      extra.push("--strict-mcp-config", "--mcp-config", JSON.stringify({
        mcpServers: { device: { type: "stdio", command: process.execPath, args: [mcp] } },
      }));
    }
  }
  let cmd, args, env;
  try {
    const [c, a] = gw.claudeCmd([...extra, ...gw.settingsArgs()]);
    cmd = c; args = a; env = gw.claudeEnv();
  } catch (e) { emit({ type: "error", message: "准备 claude 启动参数失败: " + e.message }); return; }

  for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_EFFORT", "ELECTRON_RUN_AS_NODE"]) delete env[k];
  let child;
  try {
    child = spawn(cmd, args, {
      cwd, env, stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WIN, windowsHide: true,
    });
    // 提示从 stdin 进去（不走命令行）：Windows 命令行上限 32 KB，任务最大 64 KB
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  } catch (e) { emit({ type: "error", message: "拉起 claude 失败: " + e.message }); return; }

  let buf = "", err = "", result = null, lastProgress = "", lastAt = 0, timer = null;
  const progress = (text) => {
    const s = String(text || "").trim();
    if (!s || s === lastProgress) return;
    const now = Date.now();
    if (now - lastAt < 350) return;
    lastAt = now;
    lastProgress = s.slice(-2000);
    emit({ type: "progress", text: lastProgress });
  };
  // 结构化事件：调用方（另一台设备的网关）拿它画实时时间流，而不是只有一行「进度」
  const toolBlocks = new Map(), sentTools = new Set();
  let sawTextDelta = false;
  const emitEv = (ev) => { if (ev) emit({ type: "event", ev }); };
  const clipText = (s, n = 12000) => String(s || "").slice(0, n);
  const toolText = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const kill = () => {
    try {
      if (IS_WIN) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  const finish = (obj) => {
    if (result) return;
    result = obj;
    if (timer) clearTimeout(timer);
    try { kill(); } catch {}
    process.stdout.write(JSON.stringify(obj) + "\n", () => setTimeout(() => process.exit(0), 50));
  };
  timer = setTimeout(() => { kill(); finish({ type: "error", message: `执行超时（${timeout} 秒）` }); }, timeout * 1000);

  child.stdout.on("data", (d) => {
    buf += d;
    if (buf.length > 16 * 1024 * 1024) buf = buf.slice(-4 * 1024 * 1024);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "stream_event" && ev.event) {
        const e = ev.event;
        if (e.type === "content_block_start" && e.content_block) {
          const b = e.content_block;
          if (b.type === "tool_use") {
            toolBlocks.set(e.index, { id: b.id, name: b.name || "tool", json: "" });
            emitEv({ k: "tool_use_start", id: b.id, name: b.name || "tool" });
          }
        } else if (e.type === "content_block_delta" && e.delta) {
          if (e.delta.type === "text_delta") {
            sawTextDelta = true;
            emitEv({ k: "delta", text: e.delta.text });
            progress(e.delta.text);
          } else if (e.delta.type === "thinking_delta") {
            emitEv({ k: "thinking", text: e.delta.text });
          } else if (e.delta.type === "input_json_delta") {
            const b = toolBlocks.get(e.index);
            if (b) b.json += e.delta.partial_json || "";
          }
        } else if (e.type === "content_block_stop") {
          const b = toolBlocks.get(e.index);
          if (b && !sentTools.has(b.id)) {
            let input = {};
            try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _raw: b.json }; }
            sentTools.add(b.id);
            emitEv({ k: "tool_use", id: b.id, name: b.name, input });
          }
          toolBlocks.delete(e.index);
        }
      } else if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        const blocks = ev.message.content;
        const text = blocks.filter((x) => x && x.type === "text").map((x) => x.text).join("\n");
        // 有的接口不给逐字增量；没有增量时用整条 assistant 兜底，避免调用方一个字都看不到
        if (text && !sawTextDelta) emitEv({ k: "text", text });
        for (const x of blocks) {
          if (x && x.type === "tool_use" && x.id && !sentTools.has(x.id)) {
            sentTools.add(x.id);
            emitEv({ k: "tool_use", id: x.id, name: x.name || "tool", input: x.input || {} });
          }
        }
        if (text) progress(text);
      } else if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
        for (const x of ev.message.content) {
          if (x && x.type === "tool_result") {
            emitEv({ k: "tool_result", id: x.tool_use_id, ok: !x.is_error, text: clipText(toolText(x.content)) });
          }
        }
      } else if (ev.type === "result") {
        const text = typeof ev.result === "string" ? ev.result : Array.isArray(ev.errors) ? ev.errors.join("\n") : "";
        if (ev.is_error && !text) finish({ type: "error", message: (ev.errors || []).join("\n") || "执行失败" });
        else finish({ type: "done", text: String(text || "").slice(0, MAX_RESULT) });
      }
    }
  });
  child.stderr.on("data", (d) => { err = (err + d).slice(-12000); });
  child.on("error", (e) => finish({ type: "error", message: "claude 启动失败: " + e.message }));
  child.on("close", (code) => {
    if (!result) finish({ type: "error", message: (err.trim() || `claude 退出 code=${code}`).slice(-8000) });
  });
}

main().catch((e) => emit({ type: "error", message: e.stack || e.message }));

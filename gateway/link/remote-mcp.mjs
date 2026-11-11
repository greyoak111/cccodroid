#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  remote-mcp.mjs —— 给 Claude Code 的「跨设备远程执行」工具（MCP stdio）
//
//  本机会话默认在本机跑。这个工具让模型在需要另一台设备的环境时，把一段
//  自包含的任务派过去，等它执行完，把结果拿回来继续。
//
//    remote_devices   看另一台在不在、是什么设备、有哪些技能
//    remote_task      派任务（短任务直接等结果；长任务返回 task_id）
//    remote_result    查 / 等一个任务的结果
//    remote_cancel    取消任务
//
//  它只是 linkd 本机接口（127.0.0.1:9377）的薄壳，鉴权用网关令牌。
//  配置（MCP 客户端里）：
//    CCAPP_LINKD=http://127.0.0.1:9377
//    CCAPP_GW_TOKEN_FILE=<home>/.gateway-token
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const LINKD = String(process.env.CCAPP_LINKD || "http://127.0.0.1:9377").replace(/\/+$/, "");
const TOKEN_FILE = process.env.CCAPP_GW_TOKEN_FILE || path.join(os.homedir(), ".gateway-token");

function token() {
  if (process.env.CCAPP_LINK_TOKEN) return String(process.env.CCAPP_LINK_TOKEN).trim();
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}
async function api(method, p, body) {
  const t = token();
  if (!t) throw new Error("读不到网关令牌：" + TOKEN_FILE);
  const r = await fetch(LINKD + p, {
    method,
    headers: { "x-link-token": t, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(130000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function text(s) { return { content: [{ type: "text", text: String(s) }] }; }
function fail(s) { return { isError: true, content: [{ type: "text", text: String(s) }] }; }

function summarizeTask(t) {
  if (!t) return null;
  return {
    id: t.id, status: t.status, device: t.toName || t.to || "", direction: t.dir,
    created_at: new Date(t.createdAt || Date.now()).toISOString(),
    progress: t.progress || "", result: t.result || "", error: t.error || "",
  };
}

const TOOLS = [
  {
    name: "remote_devices",
    description: "List the user's other cccodroid devices reachable through linkd, with platform, online state, allowed state and installed skills. Call this first when a task may need another device's environment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remote_task",
    description: "Run a self-contained task on another of the user's devices and return its final answer. Use it ONLY when the task needs that device's environment: phone-only work such as Douyin / Douyin Shop / Xiaohongshu / Android apps, screen reading and tapping, phone notifications or phone login state; PC-only work such as Windows builds, winget or Visual Studio. The other device cannot see this conversation, so include all context, exact steps, and the desired output format. It runs headlessly with its own tools and returns only its final message. Long tasks: call with wait_sec 0-20, then poll remote_result.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Target device id or name from remote_devices" },
        task: { type: "string", description: "Self-contained instructions: background, what to do, output format. The remote device cannot see this chat." },
        cwd: { type: "string", description: "Optional working directory on the target; defaults to its workspace" },
        timeout_sec: { type: "integer", description: "Hard time limit on the target (default 600, max 3600)" },
        max_turns: { type: "integer", description: "Maximum agent turns on the target (default 40)" },
        wait_sec: { type: "integer", description: "How long to wait inline (default 20, max 120); 0 returns immediately" },
      },
      required: ["device", "task"],
    },
  },
  {
    name: "remote_result",
    description: "Get the status/result of a remote task started with remote_task. Optionally wait up to wait_sec for it to finish.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        wait_sec: { type: "integer", description: "Wait up to this many seconds (default 45, max 120)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "remote_cancel",
    description: "Cancel a running remote task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    name: "remote_history",
    description: "List recent remote tasks (sent and received) with their status.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", description: "default 10" } } },
  },
];

async function callTool(name, a) {
  a = a || {};
  if (name === "remote_devices") {
    const r = await api("GET", "/api/remote");
    return text(JSON.stringify({
      enabled: r.enabled,
      device: r.device,
      targets: (r.targets || []).map((t) => ({
        id: t.id, name: t.name, kind: t.kind, platform: t.platform,
        online: t.online, allowed: t.allowed, via: t.via,
        skills: (t.caps && t.caps.skills) || [], workspace: (t.caps && t.caps.workspace) || "",
      })),
    }, null, 1));
  }
  if (name === "remote_task") {
    const wait = a.wait_sec === undefined ? 20 : Math.max(0, Math.min(120, Number(a.wait_sec) || 0));
    const r = await api("POST", "/api/remote/task", {
      device: String(a.device || ""), prompt: String(a.task || ""),
      cwd: a.cwd ? String(a.cwd) : undefined,
      timeout: a.timeout_sec ? Number(a.timeout_sec) : undefined,
      maxTurns: a.max_turns ? Number(a.max_turns) : undefined,
      wait,
    });
    const t = r.task || {};
    if (t.status === "done") return text(JSON.stringify({ ...summarizeTask(t), done: true }, null, 1));
    if (t.status === "error" || t.status === "cancelled") return fail(JSON.stringify({ ...summarizeTask(t), done: true }, null, 1));
    return text(JSON.stringify({
      ...summarizeTask(t), done: false,
      hint: "Still running. Call remote_result with this task_id (wait_sec up to 120).",
    }, null, 1));
  }
  if (name === "remote_result") {
    const id = String(a.task_id || "");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail("bad task_id");
    const wait = a.wait_sec === undefined ? 45 : Math.max(0, Math.min(120, Number(a.wait_sec) || 0));
    const end = Date.now() + wait * 1000;
    let t = null;
    for (;;) {
      const r = await api("GET", `/api/remote/task/${encodeURIComponent(id)}`);
      t = r.task || {};
      if (["done", "error", "cancelled"].includes(t.status) || Date.now() >= end) break;
      await sleep(1000);
    }
    const out = { ...summarizeTask(t), done: ["done", "error", "cancelled"].includes(t.status) };
    return t.status === "done" ? text(JSON.stringify(out, null, 1)) : fail(JSON.stringify(out, null, 1));
  }
  if (name === "remote_cancel") {
    const r = await api("POST", "/api/remote/cancel", { id: String(a.task_id || "") });
    return text(JSON.stringify(summarizeTask(r.task), null, 1));
  }
  if (name === "remote_history") {
    const limit = Math.max(1, Math.min(50, Number(a.limit) || 10));
    const r = await api("GET", `/api/remote/tasks?limit=${limit}`);
    return text(JSON.stringify((r.tasks || []).map(summarizeTask), null, 1));
  }
  return fail("unknown tool " + name);
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || m.id === null) return;      // 通知
  try {
    switch (m.method) {
      case "initialize":
        return send({ id: m.id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ccapp-remote", version: "1.0.0" },
          instructions: "Bridge to the user's other cccodroid devices. Use remote_devices first; only delegate tasks that genuinely need another device's environment.",
        } });
      case "ping":
        return send({ id: m.id, result: {} });
      case "tools/list":
        return send({ id: m.id, result: { tools: TOOLS } });
      case "tools/call": {
        const name = m.params && m.params.name;
        try { return send({ id: m.id, result: await callTool(name, m.params && m.params.arguments) }); }
        catch (e) { return send({ id: m.id, result: fail(e.message) }); }
      }
      default:
        return send({ id: m.id, error: { code: -32601, message: "method not found: " + m.method } });
    }
  } catch (e) {
    send({ id: m.id, result: fail(e.message) });
  }
});

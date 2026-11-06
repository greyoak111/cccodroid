#!/usr/bin/env node
// device-mcp.mjs —— cccodroid 的设备工具（MCP，stdio）。网关起 claude 时用 --mcp-config 挂上，名字叫 device。
//
// 自己不碰安卓：每次调用都经应用进程的套接字（私有目录里的 .priv.sock，只认同一个 uid）转给 DeviceTools.java。
// 哪些工具出现在 tools/list 里由应用决定 —— 用户在 设置 → 设备工具 里关掉的，模型根本看不到。
// 零依赖，只用 Node 自带模块。
import net from "node:net";
import readline from "node:readline";

// 私有目录里的文件套接字：别的应用抢不走（以前的抽象套接字 \0cc.codroid.priv 谁都能先绑 —— 审查 H2）
const SOCKET = process.env.CCAPP_PRIV_SOCK || "/data/data/cc.codroid/files/.priv.sock";

function app(req, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const s = net.connect({ path: SOCKET }, () => s.write(JSON.stringify(req) + "\n"));
    let buf = "";
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, message: "timeout" }); }, timeoutMs);
    s.on("data", (d) => (buf += d));
    s.on("end", () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, message: buf.slice(0, 300) }); } });
    s.on("error", (e) => { clearTimeout(t); resolve({ ok: false, message: "cccodroid app unreachable: " + e.message }); });
  });
}

const node = { type: "integer", description: "Element number from the latest screen (screen_read, or the screen returned by the previous action)" };
// 动作做完等界面静下来、带回新屏幕（A11y.withScreen）
const read = { type: "boolean", description: "Return the new screen after the action (default true). Set false only when you will not look at the result." };
const AFTER = " Waits until the UI settles, then returns the new screen in the same format as screen_read; its numbers replace the old ones.";
const TOOLS = {
  device_status: {
    description: "Battery, charging, network (wifi/cellular, VPN, metered), screen on, free storage, device model and Android version, whether cccodroid is in the foreground.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  notify: {
    description: "Post a system notification to the user (e.g. when a long task finishes). Tapping it opens cccodroid.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } } },
  },
  clipboard_read: {
    description: "Read the text on the clipboard. The user confirms each read in cccodroid; refused when cccodroid is not in the foreground.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  clipboard_write: {
    description: "Put text on the clipboard so the user can paste it elsewhere. The user confirms each write in cccodroid; refused when cccodroid is not in the foreground.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  open: {
    description: "Open another app pre-filled for the user to finish: a web page, a map search, the dialer (does not call), an email or SMS draft (does not send), a new calendar event (user taps save), an alarm or timer, the share sheet for text, or launch an installed app by package name (see app_list). If cccodroid is in the background Android blocks this, so a notification is posted for the user to tap instead.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "map", "dial", "email", "sms", "calendar_event", "alarm", "timer", "share_text", "app"] },
        url: { type: "string", description: "kind=url: http(s) URL" },
        query: { type: "string", description: "kind=map: place or address" },
        number: { type: "string", description: "kind=dial/sms" },
        to: { type: "string", description: "kind=email: recipient(s), comma separated" },
        subject: { type: "string", description: "kind=email" },
        body: { type: "string", description: "kind=email/sms" },
        title: { type: "string", description: "kind=calendar_event" },
        start: { type: "string", description: "kind=calendar_event: ISO local time like 2026-10-22T15:00, or a date for all-day" },
        end: { type: "string", description: "kind=calendar_event" },
        all_day: { type: "boolean" },
        location: { type: "string" },
        description: { type: "string" },
        hour: { type: "integer", description: "kind=alarm (0-23)" },
        minute: { type: "integer", description: "kind=alarm" },
        seconds: { type: "integer", description: "kind=timer" },
        label: { type: "string", description: "kind=alarm/timer" },
        text: { type: "string", description: "kind=share_text" },
        package: { type: "string", description: "kind=app: package name" },
      },
      required: ["kind"],
    },
  },
  share_file: {
    description: "Open the Android share sheet for a local file (send it to another app or a chat). The user picks the target.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute path" }, mime: { type: "string" } }, required: ["path"] },
  },
  app_list: {
    description: "List installed apps that have a launcher icon (label and package name). Optional filter.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  screen_read: {
    description: "Read the UI of the app currently on screen through the accessibility service: one line per element with [number], type, text, (description), #view-id, @centerX,centerY and flags (click, edit, password, scroll, checked…). Password fields are listed but never show their content or description. Use the numbers with screen_tap / screen_type / screen_swipe. Numbers change after every screen_read; screen_tap / screen_swipe / screen_type / screen_key also return the new screen, so you usually don't need to call this again after an action. Prefer this over screenshot; take a screenshot when the layout or images matter.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include layout-only elements too (default false)" } } },
    annotations: { readOnlyHint: true },
  },
  screen_tap: {
    description: "Tap an element by number (falls back to its clickable parent), or tap screen coordinates. long=true for a long press." + AFTER,
    inputSchema: { type: "object", properties: { node, x: { type: "integer" }, y: { type: "integer" }, long: { type: "boolean" }, read } },
  },
  screen_swipe: {
    description: "Scroll a scrollable element (node + direction forward/backward), or swipe between two points (x1,y1 → x2,y2)." + AFTER,
    inputSchema: { type: "object", properties: { node, direction: { type: "string", enum: ["forward", "backward"] }, x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" }, duration_ms: { type: "integer" }, read } },
  },
  screen_type: {
    description: "Set the text of an input field (node with the edit flag, or the focused field). append=true keeps existing text (not allowed on password fields); submit=true presses enter afterwards." + AFTER,
    inputSchema: { type: "object", properties: { node, text: { type: "string" }, append: { type: "boolean" }, submit: { type: "boolean" }, read }, required: ["text"] },
  },
  screen_key: {
    description: "System navigation: back, home, recents, notifications, quick_settings, lock_screen." + AFTER,
    inputSchema: { type: "object", properties: { key: { type: "string", enum: ["back", "home", "recents", "notifications", "quick_settings", "lock_screen"] }, read }, required: ["key"] },
  },
  screenshot: {
    description: "Take a screenshot of the current screen (JPEG, long side scaled to 1280 px). Returns the image and the saved file path. Coordinates for screen_tap are in full-resolution pixels (see size).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
};

async function listTools() {
  const st = await app({ op: "dev_status" }, 5000);
  if (!st.ok || !st.on) return [];
  const screenOn = st.a11y && st.a11y.mode !== "off";
  return (st.tools || [])
    .filter((t) => t.enabled && TOOLS[t.name] && (!t.screen || screenOn))
    .filter((t) => t.name !== "screenshot" || (st.a11y && st.a11y.screenshot))
    .map((t) => ({ name: t.name, ...TOOLS[t.name] }));
}

async function callTool(name, args) {
  if (!TOOLS[name]) return { isError: true, content: [{ type: "text", text: "unknown tool " + name }] };
  // 读写剪贴板、打开、每个会话第一次用屏幕工具都要等用户在 cccodroid 里点头（应用那头最多等 60 秒）：
  // 这边先超时报错、那边随后点了允许，就成了「报错了却做了」。屏幕工具以前只给 30 秒，首次原生确认必然丢（#123-4）
  const ask = name === "clipboard_read" || name === "clipboard_write" || name === "open" || name.startsWith("screen") || name === "screenshot";
  const r = await app({ op: "dev", tool: name, args: args || {} }, ask ? 70000 : 20000);
  if (!r.ok && typeof r.tree === "string") {
    // 动作没做成（多半编号过期）也带着新屏幕回来：直接从里面重选，不用再 screen_read
    const tree = r.tree; delete r.tree; delete r.ok;
    const msg = r.message || "failed"; delete r.message;
    return { isError: true, content: [{ type: "text", text: msg + "\nCurrent screen (numbers below are valid now):\n" + JSON.stringify(r) + "\n" + tree }] };
  }
  if (!r.ok) return { isError: true, content: [{ type: "text", text: r.message || "failed" }] };
  delete r.ok;
  if (typeof r.tree === "string") {
    const tree = r.tree || ""; delete r.tree;
    return { content: [{ type: "text", text: JSON.stringify(r) + "\n" + tree }] };
  }
  if (name === "screenshot" && r.jpeg) {
    const data = r.jpeg; delete r.jpeg;
    return { content: [{ type: "image", data, mimeType: "image/jpeg" }, { type: "text", text: JSON.stringify(r) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] };
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || m.id === null) return;            // 通知（initialized 等）不用回
  try {
    switch (m.method) {
      case "initialize":
        return send({ id: m.id, result: {
          protocolVersion: m.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cccodroid-device", version: "1.0.0" },
          instructions: "Tools for the Android device cccodroid runs on. Things that open other apps only pre-fill; the user confirms in cccodroid first, then finishes in that app. Screen tools need the accessibility service, which the app switches on when needed.",
        } });
      case "ping": return send({ id: m.id, result: {} });
      case "tools/list": return send({ id: m.id, result: { tools: await listTools() } });
      case "tools/call": return send({ id: m.id, result: await callTool(m.params?.name, m.params?.arguments) });
      default: return send({ id: m.id, error: { code: -32601, message: "method not found: " + m.method } });
    }
  } catch (e) {
    send({ id: m.id, error: { code: -32603, message: String(e && e.message || e) } });
  }
});
rl.on("close", () => process.exit(0));

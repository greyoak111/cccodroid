// cli-bridge —— 为终端里的 xdg-open / termux-open-url / termux-clipboard-{get,set} 提供桥接，
// 经 cccodroid 应用私有套接字（$CCAPP_PRIV_SOCK）调系统浏览器与系统剪贴板（协议见 Priv.java）。
import net from "node:net";

const SOCKET = process.env.CCAPP_PRIV_SOCK || "/data/data/cc.codroid/files/.priv.sock";
const SOCKET_TIMEOUT_MS = Number(process.env.CCAPP_CLI_BRIDGE_TIMEOUT_MS) > 0 ? Number(process.env.CCAPP_CLI_BRIDGE_TIMEOUT_MS) : 70000;
const STDIN_TIMEOUT_MS = Number(process.env.CCAPP_CLI_BRIDGE_STDIN_TIMEOUT_MS) > 0 ? Number(process.env.CCAPP_CLI_BRIDGE_STDIN_TIMEOUT_MS) : 10000;
const MAX_CLIP_CHARS = 200000;

function send(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const s = net.connect({ path: SOCKET }, () => s.write(JSON.stringify(req) + "\n"));
    const timer = setTimeout(() => {
      s.destroy();
      finish(reject, new Error(`timed out waiting for cccodroid (${SOCKET_TIMEOUT_MS}ms)`));
    }, SOCKET_TIMEOUT_MS);
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d) => {
      buf += d;
      if (buf.length > 1024 * 1024) {
        s.destroy();
        finish(reject, new Error("response from cccodroid too large"));
      }
    });
    s.on("end", () => {
      try { finish(resolve, JSON.parse(buf)); }
      catch { finish(reject, new Error("invalid response from cccodroid: " + buf.slice(0, 200))); }
    });
    s.on("error", (e) => finish(reject, new Error(`cannot connect to cccodroid (${e.code || e.message})`)));
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      fn(val);
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new Error(`timed out reading stdin (${STDIN_TIMEOUT_MS}ms)`)), STDIN_TIMEOUT_MS);
    };
    let timer = null;
    resetTimer();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      resetTimer();
      data += d;
      if (data.length > MAX_CLIP_CHARS) {
        finish(reject, new Error(`input too large (exceeds ${MAX_CLIP_CHARS} chars)`));
      }
    });
    process.stdin.on("end", () => finish(resolve, data));
    process.stdin.on("error", (e) => finish(reject, e));
  });
}

function isSafeHttpUrl(raw) {
  if (typeof raw !== "string" || !raw || /[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const auth = raw.slice(u.protocol.length + 2).split(/[/?#]/, 1)[0];
  if (auth.includes("@")) return false;
  if (!u.hostname || u.hostname === ".") return false;
  return true;
}

async function main() {
  const [cmd, ...rawArgs] = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (cmd === "open-url") {
    const url = (args.find((a) => !a.startsWith("-")) || "").trim();
    if (!isSafeHttpUrl(url)) {
      process.stderr.write("xdg-open: only valid http:// and https:// URLs without whitespace or credentials are supported\n");
      process.exit(1);
    }
    const r = await send({ op: "open_url", url });
    if (!r.ok) {
      process.stderr.write(`xdg-open: ${r.message || "failed"}\n`);
      process.exit(1);
    }
    return;
  }
  if (cmd === "clip-set") {
    const text = args.length ? args.join(" ") : await readStdin();
    if (text.length > MAX_CLIP_CHARS) {
      process.stderr.write(`termux-clipboard-set: input too large (exceeds ${MAX_CLIP_CHARS} chars)\n`);
      process.exit(1);
    }
    const r = await send({ op: "clip_set", text });
    if (!r.ok) {
      process.stderr.write(`termux-clipboard-set: ${r.message || "failed"}\n`);
      process.exit(1);
    }
    return;
  }
  if (cmd === "clip-get") {
    const r = await send({ op: "clip_get" });
    if (!r.ok) {
      process.stderr.write(`termux-clipboard-get: ${r.message || "failed"}\n`);
      process.exit(1);
    }
    if (r.text) process.stdout.write(r.text);
    return;
  }
  process.stderr.write("usage: cli-bridge.mjs <open-url|clip-set|clip-get> [args...]\n");
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`cli-bridge: ${e.message}\n`);
  process.exit(1);
});

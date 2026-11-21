// cli-bridge —— 为终端里的 xdg-open / termux-open-url / termux-clipboard-{get,set} 提供桥接，
// 经 cccodroid 应用私有套接字（$CCAPP_PRIV_SOCK）调系统浏览器与系统剪贴板（协议见 Priv.java）。
import net from "node:net";

const SOCKET = process.env.CCAPP_PRIV_SOCK || "/data/data/cc.codroid/files/.priv.sock";

function send(req) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: SOCKET }, () => s.write(JSON.stringify(req) + "\n"));
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d) => (buf += d));
    s.on("end", () => {
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error("invalid response from cccodroid: " + buf.slice(0, 200))); }
    });
    s.on("error", (e) => reject(new Error(`cannot connect to cccodroid (${e.code || e.message})`)));
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
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
  const [cmd, ...args] = process.argv.slice(2);
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

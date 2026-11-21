// 终端 CLI 桥接（xdg-open / termux-open-url / termux-clipboard-{get,set}）与文本视图折行拼接回归测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const BRIDGE = path.join(ROOT, "android/assets/bin/cli-bridge.mjs");
const BIN_DIR = path.join(ROOT, "android/assets/bin");

function runNode(args, { env = {}, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function startMockPriv(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cli-bridge-"));
  const sockPath = path.join(dir, ".priv.sock");
  const seen = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      seen.push(req);
      const resp = handler(req);
      conn.end(JSON.stringify(resp) + "\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(sockPath, () =>
      resolve({
        sockPath,
        seen,
        close: () =>
          new Promise((r) =>
            server.close(() => {
              try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
              r();
            })
          ),
      })
    );
  });
}

test("cli-bridge: open-url 只放行 http/https，并在确认后返回 0、被拒返回 1", async () => {
  const mock = await startMockPriv((req) => {
    if (req.url.includes("deny")) return { ok: false, message: "denied" };
    return { ok: true, shown: "opened" };
  });
  try {
    const ok = await runNode(["open-url", "https://github.com/login/device"], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(mock.seen[0], { op: "open_url", url: "https://github.com/login/device" });

    const denied = await runNode(["open-url", "https://example.com/deny"], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /denied/);

    // 非 http/https 协议在客户端即拦截，不发往套接字
    const before = mock.seen.length;
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "intent://foo", ""]) {
      const r = await runNode(["open-url", bad], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
      assert.equal(r.code, 1, `should reject ${bad}`);
    }
    assert.equal(mock.seen.length, before);
  } finally {
    await mock.close();
  }
});

test("cli-bridge: clip-set 支持 stdin 管道与位置参数，clip-get 原样输出不加多余换行", async () => {
  let clip = "";
  const mock = await startMockPriv((req) => {
    if (req.op === "clip_set") {
      if (req.text === "DENY") return { ok: false, message: "user denied" };
      clip = req.text;
      return { ok: true, chars: clip.length };
    }
    if (req.op === "clip_get") return { ok: true, text: clip };
    return { ok: false, message: "unknown" };
  });
  try {
    // 模拟 gh auth refresh 通过 stdin 写入一次性验证码
    const r1 = await runNode(["clip-set"], { env: { CCAPP_PRIV_SOCK: mock.sockPath }, stdin: "9A8C-71E3" });
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(clip, "9A8C-71E3");

    const g1 = await runNode(["clip-get"], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
    assert.equal(g1.code, 0, g1.stderr);
    assert.equal(g1.stdout, "9A8C-71E3");

    // 位置参数形式
    const r2 = await runNode(["clip-set", "hello", "world"], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(clip, "hello world");

    // 拒绝时退出码 1
    const r3 = await runNode(["clip-set", "DENY"], { env: { CCAPP_PRIV_SOCK: mock.sockPath } });
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /user denied/);
  } finally {
    await mock.close();
  }
});

test("四个终端包装脚本存在且指向 cli-bridge.mjs", () => {
  const expect = {
    "xdg-open": "open-url",
    "termux-open-url": "open-url",
    "termux-clipboard-set": "clip-set",
    "termux-clipboard-get": "clip-get",
  };
  for (const [name, sub] of Object.entries(expect)) {
    const p = path.join(BIN_DIR, name);
    assert.ok(fs.existsSync(p), `missing ${name}`);
    const body = fs.readFileSync(p, "utf8");
    assert.ok(body.startsWith("#!/system/bin/sh\n"), `${name} must use #!/system/bin/sh`);
    assert.ok(body.includes(`cli-bridge.mjs" ${sub}`), `${name} must dispatch to ${sub}`);
  }
});

test("Priv.java / DeviceTools.java / MainActivity.java 接线与安全边界守卫", () => {
  const priv = fs.readFileSync(path.join(ROOT, "android/java/cc/codroid/Priv.java"), "utf8");
  const dev = fs.readFileSync(path.join(ROOT, "android/java/cc/codroid/DeviceTools.java"), "utf8");
  const main = fs.readFileSync(path.join(ROOT, "android/java/cc/codroid/MainActivity.java"), "utf8");

  // 三个 op 均强制前台确认（trustable=false），不依赖 AI 设备工具总开关
  assert.ok(priv.includes('case "open_url":'));
  assert.ok(priv.includes('!ask(url, who, "cli:open_url", false)'));
  assert.ok(priv.includes('case "clip_set":'));
  assert.ok(priv.includes('!ask(clip(text), who, "cli:clip_set", false)'));
  assert.ok(priv.includes('case "clip_get":'));
  assert.ok(priv.includes('!ask(Tr.t("设备工具：读取剪贴板"), who, "cli:clip_get", false)'));
  // 剪贴板写入审计不落正文（防泄漏验证码/密钥）
  assert.ok(priv.includes('"[clip_set] (" + text.length() + " chars)"'));
  // DeviceTools 提供包内可复用的 openUrl / clipRead / clipWrite，且 openUrl 限制 http/https
  assert.ok(dev.includes("static JSONObject openUrl(Context c, String u)"));
  assert.ok(dev.includes('u.matches("(?i)^https?://.+")'));
  // MainActivity 区分 url / clip_set / clip_get 弹窗，不再误报 Shizuku 文案
  assert.ok(main.includes('clipSet = "clip_set".equals(kind)'));
  assert.ok(main.includes('openUrl = "url".equals(kind)'));
});

test("18-terminal.js 文本视图按 isWrapped 拼接折行，避免长 URL 被硬换行劈开", () => {
  const src = fs.readFileSync(path.join(ROOT, "gateway/web/app/18-terminal.js"), "utf8");
  assert.ok(src.includes("if (ln?.isWrapped && lines.length) lines[lines.length - 1] += s;"));
});

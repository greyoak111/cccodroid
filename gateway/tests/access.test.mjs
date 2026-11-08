// 网关访问控制（gw/access.mjs）：令牌、Host、Origin。端口由 scripts/test.mjs 固定为 8799
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BOOT, COOKIE, EMPTY_SHA, SESSION, TOKEN, UI_HOST, cookieHostOk, denyReason, proof, sigOk, staticMac, tokenOk } from "../gw/access.mjs";

// 连接进的监听地址默认跟着 Host 走（真实情况）；转发场景单独给 local
const req = (headers, local) => ({ headers, socket: { localAddress: local || (String(headers.host || "").startsWith(UI_HOST) ? UI_HOST : "127.0.0.1") } });
const url = (p) => new URL("http://127.0.0.1:8799" + p);
const HOST = "127.0.0.1:8799";
// cccodroid（测试里设了 CCAPP_PREFIX）的界面走专用地址，会话 Cookie 只在这里认
const UIH = process.env.CCAPP_PREFIX ? UI_HOST + ":8799" : HOST;

test("令牌：生成在 CCAPP_HOME 里，64 位十六进制、文件只有自己能读", () => {
  assert.match(TOKEN, /^[0-9a-f]{64}$/);
  const f = path.join(process.env.CCAPP_HOME, ".gateway-token");
  assert.equal(fs.readFileSync(f, "utf8").trim(), TOKEN);
  assert.equal(fs.statSync(f).mode & 0o077, 0);
});

test("tokenOk：对的放行，错的、空的、非字符串都不放", () => {
  assert.equal(tokenOk(TOKEN), true);
  assert.equal(tokenOk(TOKEN.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), false);
  assert.equal(tokenOk(""), false);
  assert.equal(tokenOk(undefined), false);
  assert.equal(tokenOk(123), false);
});

test("tokenOk：字符数相同、字节数不同的非 ASCII 输入不会抛错", () => {
  assert.doesNotThrow(() => tokenOk("é".repeat(64)));
  assert.equal(tokenOk("é".repeat(64)), false);
  assert.equal(tokenOk("é".repeat(32)), false);
});

test("Host 不对：421", () => {
  assert.equal(denyReason(req({ host: "evil.example" }), url("/")), 421);
  assert.equal(denyReason(req({ host: "127.0.0.1:1234" }), url("/")), 421);
  assert.equal(denyReason(req({}), url("/")), 421);
});

test("Origin 不对：403（没有 Origin 的同源请求不拦）", () => {
  assert.equal(denyReason(req({ host: HOST, origin: "http://evil.example" }), url("/")), 403);
  assert.equal(denyReason(req({ host: HOST, origin: "null" }), url("/")), 403);
  assert.equal(denyReason(req({ host: HOST, origin: "http://127.0.0.1:8799" }), url("/")), null);
  assert.equal(denyReason(req({ host: "LOCALHOST:8799" }), url("/")), null);
});

test("静态页不要令牌，/api/ 要", () => {
  assert.equal(denyReason(req({ host: HOST }), url("/index.html")), null);
  assert.equal(denyReason(req({ host: HOST }), url("/api/state")), 403);
});

test("/api/ 认请求头 X-CC-Token 或带端口的 Cookie", () => {
  assert.equal(denyReason(req({ host: HOST, "x-cc-token": TOKEN }), url("/api/state")), null);
  assert.equal(denyReason(req({ host: UIH, cookie: `a=1; ${COOKIE}=${SESSION}` }), url("/api/state")), null);
  assert.equal(denyReason(req({ host: UIH, cookie: `cc_t_8790=${SESSION}` }), url("/api/state")), 403);   // 别的端口的 Cookie
  assert.equal(denyReason(req({ host: HOST, "x-cc-token": "x".repeat(64) }), url("/api/state")), 403);
});

test("cccodroid 里 Cookie 是按这次启动派生的会话值，令牌本身当 Cookie 不认（审查 S1）", () => {
  const mac = (x) => crypto.createHmac("sha256", TOKEN).update(x).digest("hex");
  if (process.env.CCAPP_PREFIX) {
    assert.equal(SESSION, mac("cookie:" + BOOT));
    assert.equal(denyReason(req({ host: UIH, cookie: `${COOKIE}=${TOKEN}` }), url("/api/state")), 403);
  } else assert.equal(SESSION, TOKEN);
});

test("证明：回启动号和 HMAC，随机数不合格式就不答", () => {
  const n = crypto.randomBytes(16).toString("hex");
  const [boot, m] = proof(n).split(" ");
  assert.equal(boot, BOOT);
  assert.equal(m, crypto.createHmac("sha256", TOKEN).update(`proof:${n}:${BOOT}:${UI_HOST}`).digest("hex"));
  assert.notEqual(proof(n, "127.0.0.1"), proof(n), "冒牌的占住 127.0.0.2 再转发给 127.0.0.1：算出来的不一样，App 不认");
  for (const bad of ["", "abc", "g".repeat(32), "a".repeat(129), null]) assert.equal(proof(bad), null);
});

test("界面专用地址（GHSA-hwmm 1）：cccodroid 里 Cookie 只在 127.0.0.2 上认，127.0.0.1 / localhost 上来的不认", () => {
  assert.equal(denyReason(req({ host: UI_HOST + ":8799" }), url("/")), null);           // 这个地址本身放行
  assert.equal(denyReason(req({ host: UI_HOST + ":1234" }), url("/")), 421);
  if (!process.env.CCAPP_PREFIX) return;
  const ck = `${COOKIE}=${SESSION}`;
  assert.equal(denyReason(req({ host: HOST, cookie: ck }), url("/api/state")), 403);
  assert.equal(denyReason(req({ host: "localhost:8799", cookie: ck }), url("/api/state")), 403);
  assert.equal(denyReason(req({ host: UI_HOST + ":8799", cookie: ck }), url("/api/state")), null);
  assert.equal(cookieHostOk(req({ host: HOST })), false);
  assert.equal(cookieHostOk(req({ host: UI_HOST + ":8799" })), true);
  // 令牌头不受地址限制（终端里的工具、claude 都走 127.0.0.1）
  assert.equal(denyReason(req({ host: HOST, "x-cc-token": TOKEN }), url("/api/state")), null);
});

test("按次签名（GHSA-hwmm 附录 B）：对的放行一次，重放、改路径、过期、格式不对都不认", () => {
  const sig = (p, ts = Date.now(), n = crypto.randomBytes(16).toString("hex"), { boot = BOOT, local = UI_HOST, method = "GET", body = EMPTY_SHA } = {}) =>
    `${ts}.${n}.${crypto.createHmac("sha256", TOKEN).update(`sig2:${boot}:${local}:${method}:${ts}:${n}:${body}:${p}`).digest("hex")}`;
  const R = (h, local = UI_HOST, method = "GET") => ({ url: "/api/status", method, headers: { host: UIH, ...h }, socket: { localAddress: local } });
  const a = sig("/api/status");
  assert.equal(denyReason(R({ "x-cc-sig": a }), url("/api/status")), null);
  assert.equal(denyReason(R({ "x-cc-sig": a }), url("/api/status")), 403);          // 同一个随机数第二次
  // 截走的签名：网关重启过（启动号不同）、被转发到 127.0.0.1、换了方法、换了请求体，都不认
  assert.equal(denyReason(R({ "x-cc-sig": sig("/api/status", Date.now(), undefined, { boot: "0".repeat(32) }) }), url("/api/status")), 403);
  assert.equal(denyReason(R({ "x-cc-sig": sig("/api/status") }, "127.0.0.1"), url("/api/status")), 403);
  assert.equal(denyReason(R({ "x-cc-sig": sig("/api/status") }, UI_HOST, "POST"), url("/api/status")), 403);
  const bh = crypto.createHash("sha256").update('{"behavior":"deny"}').digest("hex");
  const okReq = R({ "x-cc-sig": sig("/api/status", Date.now(), undefined, { method: "POST", body: bh }), "x-cc-body": bh }, UI_HOST, "POST");
  assert.equal(denyReason(okReq, url("/api/status")), null);
  assert.equal(okReq.ccBodySha, bh, "放行后记下体哈希，读体时核（http.mjs）");
  assert.equal(denyReason(R({ "x-cc-sig": sig("/api/status", Date.now(), undefined, { method: "POST", body: bh }), "x-cc-body": EMPTY_SHA }, UI_HOST, "POST"), url("/api/status")), 403);
  assert.equal(sigOk(sig("/api/status"), "/api/file?path=/x"), false);
  assert.equal(denyReason(req({ host: UI_HOST + ":8799", cookie: `${COOKIE}=${SESSION}` }, "127.0.0.1"), url("/api/state")), process.env.CCAPP_PREFIX ? 403 : null, "Host 写 127.0.0.2、连接其实进的 127.0.0.1（转发）：Cookie 不认");                               // 签的是别的路径
  assert.equal(sigOk(sig("/api/file?path=%2Fa"), "/api/file?path=%2Fa"), true);
  assert.equal(sigOk(sig("/api/status", Date.now() - 120e3), "/api/status"), false);                // 过期
  for (const bad of ["", "x", "1.2.3", sig("/api/status").replace(/.$/, "g")]) assert.equal(sigOk(bad, "/api/status"), false);
});

test("界面资源 HMAC（staticMac）：绑随机数、请求行、内容；随机数格式不对不给", () => {
  const n = "0123456789abcdef0123456789abcdef", body = Buffer.from("<html>");
  const want = crypto.createHmac("sha256", TOKEN).update(`static:${n}:${UI_HOST}:/?k=1:${crypto.createHash("sha256").update(body).digest("hex")}`).digest("hex");
  assert.equal(staticMac(n, "/?k=1", body), want);
  assert.notEqual(staticMac(n, "/?k=1", body, "127.0.0.1"), want);
  assert.notEqual(staticMac(n, "/app.js", body), want);
  assert.notEqual(staticMac(n, "/?k=1", Buffer.from("<html>x")), want);
  assert.equal(staticMac("xyz", "/", body), null);
  assert.equal(staticMac(undefined, "/", body), null);
});

test("200 3-03：同名 Cookie 有好几个时逐个比——别处种的假 Cookie 排在前面也顶不掉真的；全是假的照样拒", () => {
  const fake = "0".repeat(64);
  assert.equal(denyReason(req({ host: UIH, cookie: `${COOKIE}=${fake}; ${COOKIE}=${SESSION}` }), url("/api/state")), null);
  assert.equal(denyReason(req({ host: UIH, cookie: `${COOKIE}=${fake}; ${COOKIE}=${"1".repeat(64)}` }), url("/api/state")), 403);
  assert.equal(denyReason(req({ host: UIH, cookie: `x${COOKIE}=${SESSION}` }), url("/api/state")), 403, "名字前缀不同不算");
});

// 频道（gw/channels.mjs）：消息归一化、访问门、分段，和 REST 路由
// CCAPP_TEST=1 时 LIVE=false，频道不会真去连 QQ —— 这里跑的全是本地逻辑，不碰网络
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { routeChannels, chunkText, stripMentions, normalizeQQDispatch, accessDecision, accessKey, qqBindUrl, qqDecryptSecret } from "../gw/channels.mjs";

function serve() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    try {
      const r = await routeChannels(req, res, u, u.pathname);
      if (r !== undefined && r !== null) { res.writeHead(404); res.end("next"); }
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}
const j = async (base, p, opt) => {
  const r = await fetch(base + p, opt);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text };
};
const post = (base, p, body) => j(base, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const patch = (base, p, body) => j(base, p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

test("qqBindUrl / qqDecryptSecret：绑定地址拼得对，密文解得开", async () => {
  assert.equal(qqBindUrl("a b", "cccodroid"),
    "https://q.qq.com/qqbot/openclaw/connect.html?task_id=a%20b&source=cccodroid&_wv=2");
  // 按腾讯的格式造一段密文：IV 12 | 密文 | tag 16，和它返回的 bot_encrypt_secret 一样
  const crypto = await import("node:crypto");
  const key = crypto.randomBytes(32).toString("base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const enc = Buffer.concat([iv, c.update("s3cret", "utf8"), c.final(), c.getAuthTag()]).toString("base64");
  assert.equal(qqDecryptSecret(key, enc), "s3cret");
  assert.throws(() => qqDecryptSecret(key, "bm90LWEtc2VjcmV0"), /密文/);
});

test("扫码绑定路由：缺参数 400、没有的任务当过期、GET 不受理", async () => {
  const srv = await serve(), base = "http://127.0.0.1:" + srv.address().port;
  try {
    assert.equal((await post(base, "/api/channels/qr/poll", {})).status, 400);
    const b = await post(base, "/api/channels/qr/poll", { taskId: "nope" });
    assert.equal(b.status, 200);
    assert.equal(b.body.status, "expired");                 // 网关重启过 / 没扫过：换一张
    assert.equal((await j(base, "/api/channels/qr/start")).status, 404);   // 只收 POST
  } finally { srv.close(); }
});

test("chunkText：按行切、每段不超上限、内容不丢", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n "), []);
  assert.deepEqual(chunkText("短消息"), ["短消息"]);
  const long = Array.from({ length: 40 }, (_, i) => "第 " + i + " 行，" + "x".repeat(100)).join("\n");
  const parts = chunkText(long, 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500, "段落超长：" + p.length);
  assert.equal(parts.join("\n").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  // 一整行超长：硬切，但不劈开代理对（emoji 还是完整的）
  const emo = "😀".repeat(600);
  const ps = chunkText(emo, 300);
  assert.equal(ps.join(""), emo);
  for (const p of ps) assert.ok(p.length <= 300);
});

test("stripMentions：去掉 @机器人 的标签，顺手把多余空格收一收", () => {
  assert.equal(stripMentions("<@!123456> 你好"), "你好");
  assert.equal(stripMentions("<@123>看下日志<@!456>"), "看下日志");
  assert.equal(stripMentions("  正常  文本 "), "正常 文本");
});

test("normalizeQQDispatch：私聊和群聊都归一成 Inbound", () => {
  const c2c = normalizeQQDispatch("C2C_MESSAGE_CREATE", {
    id: "m1", content: "在吗", timestamp: "1700000000000", author: { user_openid: "U1" },
  }, "ev1");
  assert.deepEqual(c2c, { kind: "user", chatId: "U1", senderId: "U1", text: "在吗", messageId: "m1", eventId: "ev1", at: 1700000000000,
    attachments: [], refIdx: "", msgIdx: "", quoted: null });

  const g = normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", {
    id: "m2", content: "<@!9> 跑个测试", timestamp: "1700000001000",
    group_openid: "G1", author: { member_openid: "M1" },
  });
  assert.equal(g.kind, "group");
  assert.equal(g.chatId, "G1");
  assert.equal(g.senderId, "M1");
  assert.equal(g.text, "跑个测试");

  // 不关心的类型、缺 id / openid 的：null（别让残缺事件把会话搞乱）
  assert.equal(normalizeQQDispatch("AT_MESSAGE_CREATE", { id: "x" }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", { content: "x", author: { user_openid: "U" } }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", { id: "m", content: "x" }), null);
  assert.equal(normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", { id: "m", content: "x", group_openid: "G" }), null);
  assert.equal(normalizeQQDispatch("C2C_MESSAGE_CREATE", null), null);
});

test("normalizeQQDispatch：附件列表和引用索引（message_scene.ext）", () => {
  const m = normalizeQQDispatch("C2C_MESSAGE_CREATE", {
    id: "m3", content: "", timestamp: "1700000002000", author: { user_openid: "U1" },
    attachments: [{ url: "https://cdn/a.jpg", content_type: "image/jpeg", filename: "a.jpg", size: 42 }],
    message_scene: { ext: ["ref_msg_idx=REF1", "msg_idx=IDX1", "source=default"] },
  }, "ev3");
  assert.equal(m.attachments.length, 1);
  assert.deepEqual(m.attachments[0], { url: "https://cdn/a.jpg", filename: "a.jpg", contentType: "image/jpeg", size: 42 });
  assert.equal(m.refIdx, "REF1");
  assert.equal(m.msgIdx, "IDX1");

  // 字段名各版本不一样：没有 url 就认 file_url / download_url；一个都没有就当没有附件
  const alt = normalizeQQDispatch("C2C_MESSAGE_CREATE", {
    id: "m4", content: "看图", author: { user_openid: "U1" },
    attachments: [{ file_url: "https://cdn/b.png", content_type: "image/png" }, { content_type: "image/png" }],
  });
  assert.equal(alt.attachments.length, 1);
  assert.equal(alt.attachments[0].url, "https://cdn/b.png");
});

test("normalizeQQDispatch：引用消息优先读 msg_elements 的正文", () => {
  const m = normalizeQQDispatch("GROUP_AT_MESSAGE_CREATE", {
    id: "m5", content: "<@!9> 这条说的啥", message_type: 103,
    group_openid: "G1", author: { member_openid: "M1" },
    msg_elements: [{ msg_idx: "IDX9", content: "被引用的那句", attachments: [{ content_type: "image/jpeg", filename: "b.jpg" }] }],
  });
  assert.equal(m.refIdx, "IDX9");
  assert.ok(m.quoted && m.quoted.text.includes("被引用的那句"));
  assert.ok(m.quoted.text.includes("b.jpg"));
});

test("accessKey：私聊和群各用各的键，不会串", () => {
  assert.equal(accessKey({ kind: "user", chatId: "abc" }), "u:abc");
  assert.equal(accessKey({ kind: "group", chatId: "abc" }), "g:abc");
});

test("accessDecision：配对码 / 白名单 / 所有人 / 群里要先批准", () => {
  const ch = { access: { mode: "pair", allow: [] }, pairCode: "123456" };
  const stranger = { kind: "user", chatId: "U1", text: "嗨" };
  assert.deepEqual(accessDecision(ch, stranger), { ok: false, key: "u:U1", why: "unpaired" });
  assert.deepEqual(accessDecision(ch, { ...stranger, text: " 123456 " }), { ok: true, key: "u:U1", pair: true });

  const allowed = { ...ch, access: { mode: "pair", allow: ["u:U1"] } };
  assert.equal(accessDecision(allowed, stranger).ok, true);

  const onlyList = { ...ch, access: { mode: "allow", allow: ["u:U1"] } };
  assert.equal(accessDecision(onlyList, stranger).ok, true);
  assert.deepEqual(accessDecision(onlyList, { kind: "user", chatId: "U2", text: "123456" }), { ok: false, key: "u:U2", why: "not-allowed" });

  const open = { ...ch, access: { mode: "open", allow: [] } };
  assert.equal(accessDecision(open, { kind: "user", chatId: "U9", text: "x" }).ok, true);

  // 群里发配对码不管用：只有主人能在应用里批准
  const grp = { kind: "group", chatId: "G1", text: "123456" };
  assert.deepEqual(accessDecision(ch, grp), { ok: false, key: "g:G1", why: "group-pending" });
  assert.equal(accessDecision({ ...ch, access: { mode: "pair", allow: ["g:G1"] } }, grp).ok, true);
});

test("REST：建频道、密钥不回显、不重填就保留旧的、能删", async () => {
  const srv = await serve();
  const base = "http://127.0.0.1:" + srv.address().port;
  try {
    // 不认识的类型 / 坏 JSON
    assert.equal((await post(base, "/api/channels", { type: "telegram" })).status, 400);
    const bad = await fetch(base + "/api/channels", { method: "POST", body: "{oops" });
    assert.equal(bad.status, 400);

    const made = await post(base, "/api/channels", {
      name: "测试机器人", type: "qqbot", on: false,
      config: { appId: "102030", appSecret: "s3cret-value", sandbox: true },
    });
    assert.equal(made.status, 200);
    const ch = made.body.channel;
    assert.match(ch.id, /^ch_[0-9a-f]{10}$/);
    assert.equal(ch.name, "测试机器人");
    assert.equal(ch.on, false);
    assert.equal(ch.secretSet, true);
    assert.equal(ch.config.appSecret, undefined, "密钥不能下发到前端");
    assert.equal(ch.config.appId, "102030");
    assert.equal(ch.config.sandbox, true);
    assert.match(ch.pairCode, /^\d{6}$/);
    assert.equal(ch.access.mode, "pair");
    assert.equal(ch.status.state, "off");

    const list = await j(base, "/api/channels");
    assert.equal(list.status, 200);
    assert.equal(list.body.channels.length, 1);
    assert.equal(list.body.channels[0].config.appSecret, undefined);
    assert.ok(list.body.types.some((x) => x.id === "qqbot" && x.fields.some((f) => f.key === "appSecret")));

    // 改名字、不发 appSecret：旧密钥留着
    const p1 = await patch(base, "/api/channels/" + ch.id, { name: "改名了" });
    assert.equal(p1.body.channel.name, "改名了");
    assert.equal(p1.body.channel.secretSet, true);
    assert.equal(p1.body.channel.config.appId, "102030");

    // 访问门 / 路由
    const p2 = await patch(base, "/api/channels/" + ch.id, {
      access: { mode: "allow", allow: ["u:U1", "bad-key", "g:G1"] },
      route: { perm: "proj", session: "new", timeoutMin: 5, model: "claude-sonnet-5-5" },
    });
    assert.equal(p2.body.channel.access.mode, "allow");
    assert.deepEqual(p2.body.channel.access.allow, ["u:U1", "g:G1"], "格式不对的 key 要丢掉");
    assert.equal(p2.body.channel.route.perm, "proj");
    assert.equal(p2.body.channel.route.session, "new");
    assert.equal(p2.body.channel.route.timeoutMin, 5);

    // 上限收到范围内
    const p3 = await patch(base, "/api/channels/" + ch.id, { route: { timeoutMin: 9999 } });
    assert.equal(p3.body.channel.route.timeoutMin, 180);

    // 没运行时的测试发消息 / 换配对码
    assert.equal((await post(base, "/api/channels/" + ch.id + "/test-send", { kind: "user", id: "U1", text: "hi" })).status, 400);
    const pc = await post(base, "/api/channels/" + ch.id + "/pair-code");
    assert.match(pc.body.pairCode, /^\d{6}$/);

    // 不存在的
    assert.equal((await j(base, "/api/channels/ch_nope")).status, 404);
    assert.equal((await post(base, "/api/channels/ch_nope/restart")).status, 404);

    const del = await fetch(base + "/api/channels/" + ch.id, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await j(base, "/api/channels")).body.channels.length, 0);
  } finally { srv.close(); }
});

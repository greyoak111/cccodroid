// v0.6.3 续查（#131–#136）里网关能测的几项
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const { nextAt, _schedForTest: S } = await import("../gw/sched.mjs");
const { QUEUE, START_GUARDS, END_HOOKS } = await import("../gw/queue.mjs");

const TZ0 = process.env.TZ;
const taskIds = [];
after(() => {
  if (TZ0 == null) delete process.env.TZ; else process.env.TZ = TZ0;
  S.DB.tasks = S.DB.tasks.filter((t) => !taskIds.includes(t.id));
});

test("cron：秋季回拨的重复那一小时里排下次，结果严格晚于现在（#132）", () => {
  process.env.TZ = "Europe/Berlin";
  try {
    const from = Date.UTC(2027, 9, 31, 1, 0, 30);          // 当地第二次 02:00:30
    const n = nextAt({ freq: { kind: "cron", cron: "* * * * *" } }, from);
    assert.equal(n, Date.UTC(2027, 9, 31, 1, 1, 0));
    // 每小时 30 分：重复的那一小时还要再跑一次（第二次 02:30）
    const h = nextAt({ freq: { kind: "cron", cron: "30 * * * *" } }, from);
    assert.equal(h, Date.UTC(2027, 9, 31, 1, 30, 0));
    // 跨天：明天 9 点
    const d = nextAt({ freq: { kind: "cron", cron: "0 9 * * *" } }, from);
    assert.equal(d, Date.UTC(2027, 9, 31, 8, 0, 0));
    // 春季拨快：02:30 不存在，跳到下一个有的 03:00 之后的 30 分
    const s = nextAt({ freq: { kind: "cron", cron: "30 * * * *" } }, Date.UTC(2027, 2, 28, 0, 40, 0));
    assert.ok(s > Date.UTC(2027, 2, 28, 0, 40, 0));
    assert.equal(new Date(s).getMinutes(), 30);
  } finally { if (TZ0 == null) delete process.env.TZ; else process.env.TZ = TZ0; }
});

test("重启后恢复的定时条目放行：重建调度记录，守卫照核、结束照记（#132）", () => {
  const t = { id: "v063-rec", name: "rec", prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "new", perm: "read" };
  S.DB.tasks.push(t); taskIds.push(t.id);
  const q = { id: "v063-q1", message: "做事", sched: { taskId: t.id, key: "s-recovered-1" } };
  QUEUE.push(q);
  try {
    S.DB.allowLogin = true;
    assert.deepEqual(START_GUARDS.map((g) => g(q)).filter((x) => x === false), [], "任务还在：放行");
    assert.ok(S.running().some((c) => c.taskId === t.id), "重建了调度记录");
    const n0 = S.runlog().length;
    for (const h of END_HOOKS) h({ sched: q.sched, sessionId: null, denied: [] }, { costRaw: 0, finalText: "好了" });
    assert.equal(S.runlog().length, n0 + 1, "结束记了一笔运行");
    assert.equal(t.runsDone, 1);
    // 任务已经删了：不跑
    const q2 = { id: "v063-q2", message: "x", sched: { taskId: "gone-task", key: "s-recovered-2" } };
    assert.equal(START_GUARDS.every((g) => g(q2) !== false), false);
  } finally { S.DB.allowLogin = false; const i = QUEUE.indexOf(q); if (i >= 0) QUEUE.splice(i, 1); }
});

// 假请求：路由函数只用到 method、数据流和 writeHead/end
import { Readable } from "node:stream";
async function call(route, method, p, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = {};
  let code = 0, out = "";
  const res = { req: null, writeHead: (c) => { code = c; }, end: (b) => { out = String(b || ""); } };
  await route(req, res, new URL("http://x" + p), p);
  return { code, json: out ? JSON.parse(out) : null };
}

test("常用指令：正文刚好 64 KB 也能存下、列表里看得见（#133）", async () => {
  const { commandRoutes, listCmds } = await import("../gw/commands.mjs");
  const route = commandRoutes(() => []);
  const body = "x".repeat(64 * 1024);
  const r = await call(route, "POST", "/api/commands/save", { scope: "user", name: "big64", body, description: "说明" });
  assert.equal(r.json.ok, true);
  assert.ok(listCmds("user").items.some((c) => c.name === "big64"), "刚存的要列得出来");
  const r2 = await call(route, "POST", "/api/commands/save", { scope: "user", name: "big65", body: body + "x" });
  assert.equal(r2.json.ok, false);
});

test("脉络：扫描途中会话被 forget（移到项目等），旧扫描结果不写回（#133）", async () => {
  const fs = (await import("node:fs")).default, path = (await import("node:path")).default, crypto = (await import("node:crypto")).default;
  const { CFG } = await import("../gw/config.mjs");
  const { lineageRefresh, lineageForget } = await import("../gw/lineage.mjs");
  const proj = path.join(CFG.home, ".claude", "projects", "-work-race1104");
  fs.mkdirSync(proj, { recursive: true });
  const S = crypto.randomUUID(), lines = [];
  let parent = null;
  const pad = "填".repeat(500);
  for (let i = 0; i < 3000; i++) {
    const u = crypto.randomUUID();
    lines.push(JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: u, parentUuid: parent, sessionId: S, cwd: "/work/a", timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: pad }] : "问 " + i + pad } }));
    parent = u;
  }
  fs.writeFileSync(path.join(proj, S + ".jsonl"), lines.join("\n") + "\n");
  assert.ok(fs.statSync(path.join(proj, S + ".jsonl")).size > 4 << 20);
  // 扫描期间一直有人 forget：S 的扫描一定跨过了某次 forget，结果不能落进索引
  let stop = false;
  const loop = (async () => { while (!stop) { lineageForget(S); await new Promise((r) => setImmediate(r)); } })();
  await lineageRefresh();
  stop = true; await loop;
  const readIdx = () => { try { return JSON.parse(fs.readFileSync(path.join(CFG.home, ".cache", "ccapp-lineage-index.json"), "utf8")); } catch { return {}; } };
  const cache = readIdx();
  assert.ok(!(cache.recs || []).some((r) => r.id === S), "途中被 forget 的扫描结果不写回");
  // 不再 forget：下一次刷新正常收下
  await lineageRefresh();
  const c2 = readIdx();
  assert.ok((c2.recs || []).some((r) => r.id === S));
  fs.rmSync(proj, { recursive: true, force: true });
});

test("账本：同一家接口换了另一个账户的 Key，余额差不记成消费（#135）", async () => {
  const { _billForTest: B } = await import("../gw/providers.mjs");
  const id = "v063-bill";
  B.noteBalance(id, "CNY", 100, "acctA");
  B.noteBalance(id, "CNY", 98, "acctA");
  assert.equal(B.billOf(id).spends.length, 1, "同一账户少了 2 块：记消费");
  B.noteBalance(id, "CNY", 10, "acctB");
  assert.equal(B.billOf(id).spends.length, 1, "换了账户：不记 88 块的消费");
  B.noteBalance(id, "CNY", 9, "acctB");
  assert.equal(B.billOf(id).spends.length, 2, "新账户之后照常记");
  assert.equal(B.billOf(id).spends.at(-1)[1], 1);
  // 升级前存的基准没有账户指纹：重新起算，不记差额
  B.billOf(id).last = { at: Date.now(), bal: 50 };
  B.noteBalance(id, "CNY", 5, "acctC");
  assert.equal(B.billOf(id).spends.length, 2, "没有指纹的旧基准：不记 45 块");
  B.noteBalance(id, "CNY", 4, "acctC");
  assert.equal(B.billOf(id).spends.length, 3);
});

test("自定义组件：说明里带冒号，SKILL.md 的 description 仍是合法的带引号字符串（#135）", async () => {
  const { _customForTest: C } = await import("../gw/custom.mjs");
  const md = C.customSkill({ id: "x1", name: "转换器", desc: "用途: 转换文档 #1", source: "/s", dir: "/d", deps: [], libs: [], entries: [{ cmd: "conv", rel: "bin/conv", kind: "glibc" }] });
  const line = md.split("\n").find((l) => l.startsWith("description: "));
  const v = line.slice("description: ".length);
  assert.ok(v.startsWith('"') && v.endsWith('"'));
  assert.match(JSON.parse(v), /用途: 转换文档 #1/);
  assert.ok(md.includes("（cccodroid 自定义组件）"), "认领标记还在");
  // 读回来（扩展页列表）：转义解开，不带反斜杠
  const fs = (await import("node:fs")).default, path = (await import("node:path")).default, { CFG } = await import("../gw/config.mjs");
  const { skillMeta } = await import("../gw/extensions.mjs");
  const dir = fs.mkdtempSync(path.join(CFG.home, "fm-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), C.customSkill({ id: "x2", name: "q", desc: '说 "你好"', source: "/s", dir: "/d", deps: [], libs: [], entries: [{ cmd: "q", rel: "bin/q", kind: "glibc" }] }));
  assert.match(skillMeta(dir).description, /说 "你好"/);
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: s\ndescription: 'it''s ok'\n---\n");
  assert.equal(skillMeta(dir).description, "it's ok");
  fs.rmSync(dir, { recursive: true, force: true });
});

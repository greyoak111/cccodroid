// 0.6.10 车道 b2：状态文件形状坏 / 语法坏时不留底、不崩、不把旧数据盖掉（194-P1-9/11/14/16、195-Z.2/Z.6/Z.7/Z.8/Z.9、197-9.4、197-9.8、200-5-04/5-06）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";

const H = CFG.home;
const write = (rel, s) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const badOf = (rel) => {
  const f = path.join(H, rel), dir = path.dirname(f), base = path.basename(f) + ".bad-";
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(base)).length; } catch { return 0; }
};
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(H, rel), "utf8"));

// 各模块导入前先把坏文件摆好（模块只在导入时读一次）
write("ccapp-archive.json", '{"sessions":[]}');
write("ccapp-sched.json", '{"tasks":"坏"}');
write("ccapp-sched-runs.json", '[null,{"taskId":"t","at":1,"st":"ok"}]');
write("ccapp-usage.json", '{"hours":[]}');
write("ccapp-model-windows.json", "null");
write("ccapp-session-models.json", "[]");
write("ccapp-lineage.json", '{"edges":[]}');
write("ccapp-bookmarks.json", '{"x":1}');
write("ccapp-session-seals.json", "{不是 JSON");
write("ccapp-project-trust.json", "[]");
write(".cache/ccapp-energy.json", '{"levels":"坏"}');
write("ccapp-session-names.json", "[]");
write("ccapp-session-pins.json", "[]");
write("ccapp-session-orphans.json", "[]");

const archive = await import("../gw/archive-store.mjs");
const { _schedForTest: S } = await import("../gw/sched.mjs");
const usage = await import("../gw/usage.mjs");
const models = await import("../gw/models.mjs");
const sessmodel = await import("../gw/sessmodel.mjs");
const lineageStore = await import("../gw/lineage-store.mjs");
const bookmarks = await import("../gw/bookmarks.mjs");
const integrity = await import("../gw/integrity.mjs");
const projtrust = await import("../gw/projtrust.mjs");
const sessions = await import("../gw/sessions.mjs");

test("archive：sessions 是数组（不是普通对象）→ 留底 .bad-*、从空档案起（P1-9、195-Z.7 同族）", () => {
  assert.deepEqual(archive.archiveDb().sessions, {});
  assert.equal(badOf("ccapp-archive.json"), 1, "原文件要留底，下一次建档不能直接盖掉");
});

test("sched：tasks 是字符串 → 不抛、从空任务起，月度统计补种（P1-11、196-状态写.3）", () => {
  assert.deepEqual(S.DB.tasks, []);
  assert.equal(S.DB.monthlySeeded, true);
  assert.equal(typeof S.DB.monthly, "object");
  assert.equal(badOf("ccapp-sched.json"), 1);
});

test("usage：hours 是数组 → 留底后按空对象起，写入仍是普通对象（P1-14、195-Z.2）", () => {
  usage.usageAdd({ i: 5, o: 2 }, "s1", "m1", Date.now());
  assert.equal(usage.flushUsage(), true);
  const j = readJson("ccapp-usage.json");
  assert.ok(j.hours && typeof j.hours === "object" && !Array.isArray(j.hours));
  assert.equal(badOf("ccapp-usage.json"), 1);
});

test("model-windows：文件是 null → learnWindow 不抛、新窗口写得进（P1-16、195-Z.9、197-9.3）", () => {
  assert.doesNotThrow(() => models.learnWindow({ modelUsage: { m1: { contextWindow: 1234, maxOutputTokens: 99 } } }, { nativeModels: true }));
  const j = readJson("ccapp-model-windows.json");
  assert.equal(j.m1.context_window, 1234);
  assert.equal(badOf("ccapp-model-windows.json"), 1);
});

test("sessmodel：文件是 [] → 钉选写回普通对象，不再丢（195-Z.6、197-9.4）", () => {
  sessmodel.setSessModel("s1", { model: "mm" });
  assert.equal(sessmodel.flushSessModel(), true);
  const j = readJson("ccapp-session-models.json");
  assert.ok(j && typeof j === "object" && !Array.isArray(j));
  assert.equal(j.s1.model, "mm");
  assert.equal(badOf("ccapp-session-models.json"), 1);
});

test("lineage：edges 是数组 → 留底后按普通对象起，主父写得进（195-Z.7）", () => {
  assert.equal(lineageStore.recordPrimary("child1", "parent1", null), true);
  const j = readJson("ccapp-lineage.json");
  assert.ok(j.edges && typeof j.edges === "object" && !Array.isArray(j.edges));
  assert.equal(j.edges.child1.primary.id, "parent1");
  assert.equal(badOf("ccapp-lineage.json"), 1);
});

test("bookmarks：文件不是数组 → 留底 .bad-*，不从空表静默覆盖（195-Z.8）", () => {
  assert.equal(badOf("ccapp-bookmarks.json"), 1);
  assert.equal(bookmarks.forgetBookmarks("没有的会话"), true);
});

test("封签表语法坏 → 留底 .bad-*，新封签照常写（195-Z.3）", () => {
  const f = path.join(H, "seal-target.jsonl");
  fs.writeFileSync(f, '{"x":1}\n');
  integrity.sealSession("sess1", f);
  const j = readJson("ccapp-session-seals.json");
  assert.ok(j.sess1 && typeof j.sess1.hash === "string");
  assert.equal(badOf("ccapp-session-seals.json"), 1);
});

test("项目信任表是数组 → 留底 .bad-*，重新信任写得进（195-Z.4）", () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "trust-"));
  projtrust.trustProject(dir, "fp123");
  const j = readJson("ccapp-project-trust.json");
  assert.ok(Object.values(j).some((v) => v && v.fp === "fp123"));
  assert.equal(badOf("ccapp-project-trust.json"), 1);
});

test("耗电文件 levels 不是数组 → 留底 .bad-*（200-5-04）", () => {
  assert.equal(badOf(".cache/ccapp-energy.json"), 1);
});

test("改名表 / 置顶表是数组 → 留底 .bad-*，不静默盖掉（197-9.8）", () => {
  assert.deepEqual(sessions.NAMES, {});
  assert.deepEqual(sessions.PINS, {});
  assert.equal(badOf("ccapp-session-names.json"), 1);
  assert.equal(badOf("ccapp-session-pins.json"), 1);
});

test("写失败如实返回 false：目标位置是目录时 saveState/saveNames 不抛、回 false（195-N.1）", () => {
  const target = path.join(H, "ccapp-session-pins.json");
  fs.rmSync(target, { force: true });
  fs.mkdirSync(target);                       // 换名到目录上必失败
  assert.equal(sessions.savePins(), false);
  fs.rmSync(target, { recursive: true, force: true });
});

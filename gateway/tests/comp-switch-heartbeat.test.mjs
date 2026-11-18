// 复核 P2-14：>256 文件的 compSwitch——心跳文件在搬移期间出现、最后删掉，
// committed 在提交点落盘，进度按文件数走满。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";

const COMP_DIR = path.join(path.dirname(PREFIX), "components");
const stage = path.join(COMP_DIR, ".staging");
const RUNS = path.join(COMP_DIR, ".runs");
fs.mkdirSync(stage, { recursive: true });
const ID = "hb-0618";
const N = 600;

const m = await import("../gw/components.mjs");
const { compSwitch, compWriteRecord } = m._compForTest;
const { compRecord } = m;

after(() => {
  fs.rmSync(path.join(COMP_DIR, ID + ".json"), { force: true });
  fs.rmSync(path.join(COMP_DIR, ID + ".json.prev"), { force: true });
  fs.rmSync(path.join(stage, ID), { recursive: true, force: true });
  fs.rmSync(path.join(stage, ID + ".old"), { recursive: true, force: true });
  fs.rmSync(path.join(RUNS, ID + ".installing"), { force: true });
  fs.rmSync(path.join(COMP_DIR, ID + "-guard.json"), { force: true });
  fs.rmSync(path.join(COMP_DIR, ID + "-guard.json.prev"), { force: true });
  fs.rmSync(path.join(stage, ID + "-guard"), { recursive: true, force: true });
  fs.rmSync(path.join(stage, ID + "-guard.old"), { recursive: true, force: true });
  fs.rmSync(path.join(RUNS, ID + "-guard.installing"), { force: true });
  fs.rmSync(path.join(PREFIX, "bin", "g"), { force: true });
  for (let i = 0; i < N; i++) fs.rmSync(path.join(PREFIX, "bin", "hb-" + i), { force: true });
});

test("600 文件搬移：心跳出现、committed 落盘、进度按文件数走满", async () => {
  // 全新安装（无旧记录）：新版树 600 个文件
  const tree = path.join(stage, ID);
  for (let i = 0; i < N; i++) {
    const f = path.join(tree, "usr", "bin", "hb-" + i);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "v2-" + i);
  }
  const job = { phase: "", done: 0, total: 0, files: false };
  const mark = path.join(RUNS, ID + ".installing");
  let saw = 0;
  const p = compSwitch(ID, { source: "official", version: "2.0.0", base: "dk", bin: [], requires: [], baseDeps: [] }, tree, job);
  // 和 compSwitch 交错跑：它每 256 条 / 每 40ms 让出事件循环，这里每圈查一次心跳文件
  while (await Promise.race([p.then(() => true), new Promise((r) => setImmediate(() => r(false)))])) break;
  for (let i = 0; i < 200 && fs.existsSync(mark); i++) {
    let j = null; try { j = JSON.parse(fs.readFileSync(mark, "utf8")); } catch {}
    // 只数 move 阶段且 moved>0 的心跳：开头的 switch beat(0) 不算数（复核 R2-P2-6：别让测试全绿但行为没测到）
    if (j && j.phase === "move" && j.moved > 0) saw++;
    await new Promise((r) => setImmediate(r));
  }
  const rec = await p;
  assert.ok(rec.committed && rec.moved, "提交点 committed / 搬完 moved 都落盘");
  assert.ok(job.files && job.total === N && job.done === N, "进度按文件数走满");
  assert.ok(saw > 0, "搬移期间 move 心跳出现过");
  assert.equal(fs.existsSync(mark), false, "心跳最后删掉");
  for (let i = 0; i < N; i++) assert.equal(fs.readFileSync(path.join(PREFIX, "bin", "hb-" + i), "utf8"), "v2-" + i);
  assert.equal(compRecord(ID).state, "installing", "switch 只写 installing，ok 在收尾段写");
});

test("R2-P2-3 残留 .old 时 compSwitch 在改记录之前就停手", async () => {
  // 上次回滚失败留下的 .old + 一个 ok 旧记录：重装必须报错停手，不能先覆盖 .prev / 记录再报错
  const gid = ID + "-guard";
  fs.mkdirSync(path.join(stage, gid + ".old"), { recursive: true });
  fs.writeFileSync(path.join(stage, gid + ".old", "x"), "old");
  compWriteRecord(gid, { id: gid, state: "ok", version: "1.0.0", files: [], shared: [] });
  const tree = path.join(stage, gid);
  fs.mkdirSync(path.join(tree, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(tree, "usr", "bin", "g"), "v2");
  await assert.rejects(compSwitch(gid, { source: "official", version: "2.0.0", base: "dk", bin: [], requires: [], baseDeps: [] }, tree,
    { phase: "", done: 0, total: 0, files: false }));
  const got = compRecord(gid);
  assert.equal(got.state, "ok"); assert.equal(got.version, "1.0.0", "旧记录没被覆盖");
  assert.equal(fs.existsSync(path.join(COMP_DIR, gid + ".json.prev")), false, ".prev 没被改写");
  assert.ok(fs.existsSync(path.join(stage, gid + ".old")), "残留备份还在，留给恢复");
});

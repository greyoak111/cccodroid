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
const { compSwitch } = m._compForTest;
const { compRecord } = m;

after(() => {
  fs.rmSync(path.join(COMP_DIR, ID + ".json"), { force: true });
  fs.rmSync(path.join(COMP_DIR, ID + ".json.prev"), { force: true });
  fs.rmSync(path.join(stage, ID), { recursive: true, force: true });
  fs.rmSync(path.join(stage, ID + ".old"), { recursive: true, force: true });
  fs.rmSync(path.join(RUNS, ID + ".installing"), { force: true });
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
    if (j && (j.phase === "switch" || j.phase === "move")) saw++;
    await new Promise((r) => setImmediate(r));
  }
  const rec = await p;
  assert.ok(rec.committed, "提交点 committed 落盘");
  assert.ok(job.files && job.total === N && job.done === N, "进度按文件数走满");
  assert.ok(saw > 0, "搬移期间心跳文件出现过");
  assert.equal(fs.existsSync(mark), false, "心跳最后删掉");
  for (let i = 0; i < N; i++) assert.equal(fs.readFileSync(path.join(PREFIX, "bin", "hb-" + i), "utf8"), "v2-" + i);
  assert.equal(compRecord(ID).state, "installing", "switch 只写 installing，ok 在收尾段写");
});

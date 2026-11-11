// FIND-041：运行标记读不了 / 中断记录写不上时不再整体静默失效 —— 快照里留下可见的警告
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import * as Q from "../gw/queue.mjs";
import { RUNS } from "../gw/runs.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const reset = () => { RUNS.clear(); Q.QUEUE.length = 0; fs.rmSync(INTR, { recursive: true, force: true }); fs.rmSync(MARK, { recursive: true, force: true }); Q.setInterrupted([]); };
after(reset);
const warns = () => (Q.snapshot().recoverWarns || []).map((w) => w.key);

test("运行标记坏了：留底，并且给出可见警告", () => {
  reset();
  fs.writeFileSync(MARK, "{\"runs\":[");
  Q.recoverRunMark();
  assert.ok(warns().some((k) => k.includes("上次的运行状态没恢复")), "要能在快照里看见");
  const bads = fs.readdirSync(CFG.home).filter((n) => n.startsWith("ccapp-run-mark.json.bad-"));
  assert.ok(bads.length >= 1, "坏文件留底");
  for (const b of bads) fs.rmSync(path.join(CFG.home, b));
});

test("中断记录写不上：标记留着下次再试，并且给出可见警告", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "w1", text: "提问", startedAt: 1 }], queue: [] }));
  fs.mkdirSync(INTR);
  fs.writeFileSync(path.join(INTR, "x"), "x");
  Q.recoverRunMark();
  assert.ok(warns().some((k) => k.includes("运行状态没保存上")), "要能在快照里看见");
  assert.ok(fs.existsSync(MARK), "来源不能丢，下次启动再试");
});

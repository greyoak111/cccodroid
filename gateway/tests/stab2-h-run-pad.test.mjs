// h 组 BUG-R01（运行侧）：streamfix 补尾的提示要按会话号落到发起的那一轮。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SWALLOW_HOOKS } from "../gw/streamfix.mjs";
import { startRun, events, endOf, until, sid, init, result, script, root } from "./fixtures/stab2-h-run-harness.mjs";

test("BUG-R01：补尾提示按会话号落到原 run（note key sfx-pad）", async () => {
  const s = sid();
  script([init(s), { sleep: 1 }, result(10, 1)], 0);
  await startRun({ id: "r-h-pad", message: "fixture", cwd: root });
  await until(() => events.some((e) => e.type === "init" && e.runId === "r-h-pad"));
  for (const h of SWALLOW_HOOKS) h(s, "", "truncated");
  await until(() => endOf("r-h-pad"));
  const note = events.find((e) => e.type === "note" && e.key === "sfx-pad" && e.runId === "r-h-pad");
  assert.ok(note, "截断提示要落到发起的那一轮");
  assert.match(note.text, /完整|继续/, note.text);
});

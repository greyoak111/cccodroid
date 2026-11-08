// 0.6.9 审计 195-E.1：换全局接口时，跟着全局走的项目 / 定时任务里旧接口的模型名一起清掉
import { CFG } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

fs.writeFileSync(path.join(CFG.home, "ccapp-projects.json"), JSON.stringify([
  { id: "pa", name: "a", path: CFG.workspace, model: "old-m", provider: "" },
  { id: "pb", name: "b", path: CFG.workspace, model: "own-m", provider: "custom-x" },
  { id: "pc", name: "c", path: CFG.workspace, model: "", provider: "" },
]));
fs.writeFileSync(path.join(CFG.home, "ccapp-sched.json"), JSON.stringify({ tasks: [
  { id: "ta", name: "a", model: "old-m" }, { id: "tb", name: "b", model: "own-m", provider: "custom-x" },
] }));

test("只清没单独指定接口的；指定了接口的、本来就跟随的不动；设置那边换接口时调到", async () => {
  const { clearFollowingModels, PROJECTS } = await import("../gw/projects.mjs");
  const { clearFollowingTaskModels } = await import("../gw/sched.mjs");
  assert.equal(clearFollowingModels(), 1);
  assert.deepEqual(PROJECTS.map((p) => p.model), ["", "own-m", ""]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CFG.home, "ccapp-projects.json"), "utf8"))[0].model, "", "落盘");
  assert.equal(clearFollowingTaskModels(), 1);
  const db = JSON.parse(fs.readFileSync(path.join(CFG.home, "ccapp-sched.json"), "utf8"));
  assert.deepEqual(db.tasks.map((t) => t.model), ["", "own-m"]);
  const src = fs.readFileSync(new URL("../gw/settings.mjs", import.meta.url), "utf8");
  const at = src.indexOf("SETTINGS.model = null;");
  assert.ok(at > 0 && src.slice(at, at + 400).includes("clearFollowingModels()") && src.slice(at, at + 400).includes("clearFollowingTaskModels()"));
});

test("195-O.2：压缩线按 claude 实际认的 100k～1M 夹住（旧设置里存的 20k 显示成 100k）", async () => {
  const { effectiveAutoCompact, clampAutoCompact } = await import("../gw/stream.mjs");
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  const prev = SETTINGS.autoCompactWindow;
  try {
    SETTINGS.autoCompactWindow = 20000;
    assert.equal(effectiveAutoCompact(), 100000);
    SETTINGS.autoCompactWindow = 5e6;
    assert.equal(effectiveAutoCompact(), 1e6);
    assert.equal(clampAutoCompact(400000), 400000);
  } finally { SETTINGS.autoCompactWindow = prev; }
});

test("195-R.3：上游报错按类给一句处理建议，认不出的给空串", async () => {
  const { apiErrorHint } = await import("../gw/stream.mjs");
  assert.match(apiErrorHint('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), /API Key/);
  assert.match(apiErrorHint("API Error: 429 rate_limit_error"), /太频繁/);
  assert.match(apiErrorHint("API Error: 400 prompt is too long: 210000 tokens > 200000 maximum"), /compact/);
  assert.match(apiErrorHint("API Error: 529 overloaded_error"), /稍后再试/);
  assert.match(apiErrorHint("API Error: 402 Insufficient Balance"), /余额/);
  assert.match(apiErrorHint("API Error: Connection error. (fetch failed)"), /连不上/);
  assert.equal(apiErrorHint("something odd"), "");
  const src = fs.readFileSync(new URL("../gw/stream.mjs", import.meta.url), "utf8");
  assert.match(src, /detail: raw/);
});

// FIND-023：单条坏会话记录不能把整页历史带崩 —— transcriptItems 逐条容错，读页时单条转不出来只丢这一条
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readSessionForward, readSessionPage, transcriptItems } from "../gw/transcript.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "stab-d-transcript-"));
const ev = (type, content, extra = {}) => ({ type, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: type, content }, ...extra });
function write(lines) {
  const f = path.join(DIR, crypto.randomUUID() + ".jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

test("坏元素不抛错，同一行里的正常内容照常显示", () => {
  assert.deepEqual(transcriptItems(ev("user", [null, { type: "text", text: "你好" }])).map((x) => x.text), ["你好"]);
  assert.deepEqual(transcriptItems(ev("assistant", [null, { type: "text", text: "在" }, { type: "tool_use" }])).map((x) => x.role), ["assistant"]);
  assert.doesNotThrow(() => transcriptItems(ev("assistant", 42)));
  assert.doesNotThrow(() => transcriptItems(ev("assistant", { type: "text", text: "不是数组" })));
  assert.doesNotThrow(() => transcriptItems(ev("user", [{ type: "tool_result", tool_use_id: "t1", content: [null, { type: "text", text: "结果" }] }])));
});

test("一条坏记录不拖垮整页（往前翻 / 往后读都一样）", async () => {
  const bad = [
    ev("assistant", [null]),
    ev("assistant", 42),
    { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [null] } },
  ];
  const good = [
    ev("user", "前面"), ev("assistant", [{ type: "text", text: "前答" }]),
    ...bad,
    ev("user", "后面"), ev("assistant", [{ type: "text", text: "后答" }]),
  ];
  const file = write(good);
  const back = await readSessionPage(file, { limit: 50 });
  assert.deepEqual(back.items.map((x) => x.text).filter((x) => ["前面", "前答", "后面", "后答"].includes(x)).sort(), ["前答", "前面", "后答", "后面"].sort());
  const fwd = await readSessionForward(file, { after: 0, limit: 50 });
  assert.ok(fwd.items.some((x) => x.text === "后答"));
});

test("自定义 pick 抛错只丢这一条，不丢整页", async () => {
  const lines = [ev("user", "一"), ev("assistant", [{ type: "text", text: "二" }]), ev("user", "三"), ev("assistant", [{ type: "text", text: "四" }])];
  const file = write(lines);
  const pick = (e) => { if (JSON.stringify(e).includes('"二"')) throw new Error("坏记录"); return transcriptItems(e); };
  const page = await readSessionPage(file, { limit: 50, pick });
  assert.deepEqual(page.items.map((x) => x.text), ["一", "三", "四"]);
});

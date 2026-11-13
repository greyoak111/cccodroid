// 自动起名（gw/autotitle.mjs，讨论 #60）：第一轮回答怎么取、提示词里带上回答
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { _firstReply } from "../gw/autotitle.mjs";
import { userPrompt } from "../gw/backfill.mjs";

const L = (o) => JSON.stringify(o);
const user = (c) => L({ type: "user", message: { role: "user", content: c } });
const asst = (c) => L({ type: "assistant", message: { role: "assistant", content: c } });

test("第一轮回答：只要文字，跳过工具结果与子代理，到第二个提问为止", async () => {
  const f = path.join(CFG.home, "autotitle-fixture.jsonl");
  fs.writeFileSync(f, [
    L({ type: "summary", summary: "x" }),
    user("<command-name>/model</command-name>"),
    user("帮我看看为什么构建失败"),
    asst([{ type: "thinking", thinking: "想" }, { type: "text", text: "先看日志。" }]),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "error: x" }]),
    L({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "子代理的话" }] } }),
    asst([{ type: "text", text: "是缺了依赖。" }]),
    user("那怎么装"),
    asst([{ type: "text", text: "第二轮的回答" }]),
  ].join("\n") + "\n");
  const r = await _firstReply(f);
  assert.equal(r, "先看日志。\n是缺了依赖。");
  fs.writeFileSync(f, [user("长问题"), asst([{ type: "text", text: "甲".repeat(3000) + "尾巴" }])].join("\n") + "\n");
  const r2 = await _firstReply(f);
  assert.ok(r2.length < 1300 && r2.endsWith("尾巴") && r2.includes("…"));
  fs.rmSync(f);
});

test("提示词带上回答节选；补档的不带", () => {
  const p = userPrompt("", [{ n: 1, open: true, src: "- 问题", reply: "回答内容", prev: null }], null);
  assert.ok(p.includes("回答内容"));
  assert.ok(!userPrompt("", [{ n: 1, open: true, src: "- 问题", prev: null }], null).includes("excerpt"));
});

test("超长的行（大段工具输出）不拼出来，跳过后照常往下读", async () => {
  const f = path.join(CFG.home, "autotitle-big.jsonl");
  const big = user([{ type: "tool_result", tool_use_id: "t", content: "x".repeat(3 << 20) }]);
  fs.writeFileSync(f, [user("问"), asst([{ type: "text", text: "前" }]), big, asst([{ type: "text", text: "后" }])].join("\n") + "\n");
  assert.equal(await _firstReply(f), "前\n后");
  fs.rmSync(f);
});

test("跨块的长行（几百 KB，没到跳过线）照常拼起来", async () => {
  const f = path.join(CFG.home, "autotitle-cross.jsonl");
  fs.writeFileSync(f, [user("问"), asst([{ type: "text", text: "头" + "y".repeat(300 << 10) + "尾" }])].join("\n") + "\n");
  const r = await _firstReply(f);
  assert.ok(r.startsWith("头") && r.endsWith("尾"));
  fs.rmSync(f);
});

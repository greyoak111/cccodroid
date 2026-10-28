import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptTokens, translate } from "../gw/stream.mjs";
import { readSessionPage } from "../gw/transcript.mjs";

const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
const usage = { input_tokens: 145, cache_read_input_tokens: 101376, cache_creation_input_tokens: 0, output_tokens: 5831 };
const stream = (event, parent = null) => ({ type: "stream_event", parent_tool_use_id: parent, event });
const start = (u = zero) => stream({ type: "message_start", message: { id: "m", usage: u } });
const delta = (u) => stream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: u });
const assistant = (u, extra = {}) => ({ type: "assistant", message: { id: "m", model: "test-model", usage: u, content: [{ type: "text", text: "ok" }] }, ...extra });
function replay(events) {
  const flags = {}, out = [];
  for (const ev of events) translate(ev, { flags, sse: (e) => out.push(e), onInit() {}, onResult() {}, provider: {} });
  return { flags, out, contexts: out.filter((e) => e.type === "usage").map((e) => e.contextTokens) };
}

// OpenAI 兼容桥开头只有占位的 0，真正的输入与缓存用量在末尾才到。
test("末尾 message_delta 的真实用量替换开头占位值", () => {
  const r = replay([start(), delta(usage)]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.equal(r.flags.mainCtx, 101521);
  assert.deepEqual(r.contexts, [101521]);
});

test("只有 assistant 最终消息时也能补上上下文", () => {
  assert.equal(replay([start(), assistant(usage)]).flags.contextTokens, 101521);
});

test("缓存命中的输入也是上下文的一部分", () => {
  assert.equal(promptTokens({ input_tokens: 0, cache_read_input_tokens: 100000, cache_creation_input_tokens: 1200 }), 101200);
  assert.equal(replay([start({ input_tokens: 0, cache_read_input_tokens: 100000 })]).flags.contextTokens, 100000);
});

test("末尾只给部分 usage 字段时保留同一请求的缓存字段", () => {
  const r = replay([start({ input_tokens: 100, cache_read_input_tokens: 9000 }), delta({ input_tokens: 120, output_tokens: 50 }), delta({ output_tokens: 60 })]);
  assert.equal(r.flags.contextTokens, 9120);
  assert.deepEqual(r.contexts, [9100, 9120]);
});

test("assistant 比末尾 delta 先到时，不回退到开头的不完整用量", () => {
  const r = replay([start({ input_tokens: 100 }), assistant(usage), delta({ output_tokens: 5831 })]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.deepEqual(r.contexts, [100, 101521]);
});

test("新请求不能继承上一次的输入或缓存字段", () => {
  const r = replay([start({ input_tokens: 100, cache_read_input_tokens: 9000 }), start(), delta({ input_tokens: 1500, output_tokens: 50 })]);
  assert.deepEqual(r.contexts, [9100, 1500]);
});

test("占位、合成消息和零用量错误不清掉已有的真实占用", () => {
  const synthetic = assistant(zero);
  synthetic.message.model = "<synthetic>";
  const r = replay([start(usage), start(), delta(zero), synthetic, assistant(zero, { isApiErrorMessage: true })]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.deepEqual(r.contexts, [101521]);
});

test("工具清理或压缩后上下文可以变小，不能取历史最大值", () => {
  assert.deepEqual(replay([start(usage), start({ input_tokens: 12000 })]).contexts, [101521, 12000]);
});

test("子代理的用量不覆盖主会话", () => {
  const r = replay([
    start(usage),
    stream({ type: "message_start", message: { usage: { input_tokens: 900 } } }, "agent-tool"),
    stream({ type: "message_delta", usage: { input_tokens: 950 } }, "agent-tool"),
    assistant({ input_tokens: 1000 }, { parent_tool_use_id: "agent-tool" }),
    { ...start({ input_tokens: 1100 }), isSidechain: true },
    assistant({ input_tokens: 1200 }, { isSidechain: true }),
  ]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.deepEqual(r.contexts, [101521]);
});

test("整轮 result 累计输入不能当作上下文", () => {
  const r = replay([start(), assistant(usage), { type: "result", usage: { input_tokens: 9000000 } }]);
  assert.equal(r.flags.contextTokens, 101521);
});

test("晚到的缓存期限仍供空闲压缩判断使用", () => {
  const r = replay([start(), delta({ ...usage, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } })]);
  assert.equal(r.flags.cache1h, true);
  assert.equal(r.flags.cache5m, undefined);
});

async function page(events, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-usage-"));
  const file = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e) + "\n").join(""));
    return await readSessionPage(file, opts);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const user = (text = "question") => ({ type: "user", message: { content: text } });

test("历史跳过合成、错误及占位零用量消息", async () => {
  const synthetic = assistant(zero);
  synthetic.message.model = "<synthetic>";
  const r = await page([user(), assistant(usage), synthetic, assistant(zero), assistant({ input_tokens: 999 }, { isApiErrorMessage: true })]);
  assert.equal(r.contextTokens, 101521);
});

test("正在实时回放的消息不重复渲染，但用量元数据不能排除", async () => {
  const r = await page([
    { ...user("old"), timestamp: "2026-10-26T12:00:00.000Z" },
    { ...assistant({ input_tokens: 500 }), timestamp: "2026-10-26T12:00:01.000Z" },
    { ...user("live"), timestamp: "2026-10-26T13:00:00.000Z" },
    { ...assistant(usage), timestamp: "2026-10-26T13:00:01.000Z" },
  ], { excludeFrom: Date.parse("2026-10-26T13:00:00.000Z") });
  assert.equal(r.contextTokens, 101521);
  assert.deepEqual(r.items.map((e) => e.text), ["old", "ok"]);
});

test("历史的子代理和元消息不覆盖主会话用量", async () => {
  const r = await page([user(), assistant(usage), assistant({ input_tokens: 100 }, { isSidechain: true }), assistant({ input_tokens: 200 }, { isMeta: true })]);
  assert.equal(r.contextTokens, 101521);
});

test("历史只有占位消息时用量未知，而不是真实的零", async () => {
  assert.equal((await page([user(), assistant(zero)])).contextTokens, null);
});

test("历史压缩边界使用压缩后的用量", async () => {
  const r = await page([user(), assistant(usage), { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 12345 } }, assistant(zero)]);
  assert.equal(r.contextTokens, 12345);
});

test("压缩后的用量缺失时不能回退到压缩前的旧值", async () => {
  const r = await page([user(), assistant(usage), { type: "system", subtype: "compact_boundary", compact_metadata: {} }, assistant(zero)]);
  assert.equal(r.contextTokens, null);
});

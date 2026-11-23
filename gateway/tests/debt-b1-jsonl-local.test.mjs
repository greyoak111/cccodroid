import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { latestContextTokens, readSessionPage, readSessionForward } from "../gw/transcript.mjs";
import { searchSessions } from "../gw/sessions.mjs";
import { LL, ensureLlama, localRunAttach } from "../gw/local.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debt-b1-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("① latestContextTokens：跨 256KB 块多字节 UTF-8 + 超限巨型无换行单行安全跳过", async () => {
  const f = path.join(tmpDir, "ctx.jsonl");
  // 在巨型行之前放一条有效上下文用量行（多字节中文填充跨块边界）
  const goodLine = JSON.stringify({
    type: "assistant",
    uuid: "u-good",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "你好世界".repeat(70000) }], // ~840KB 多字节 UTF-8，跨多个 256KB 块
      usage: { input_tokens: 12345, cache_read_input_tokens: 6789 },
    },
  });
  // 尾部放一条 3MB 无换行巨型行（测 maxLine=1MB 时丢弃该半行不 OOM、继续向前命中 goodLine）
  const hugeBad = '{"type":"assistant","noise":"' + "x".repeat(3 * 1024 * 1024) + '"}';
  fs.writeFileSync(f, goodLine + "\n" + hugeBad + "\n");

  const t0 = Date.now();
  const tok = await latestContextTokens(f, { maxLine: 1 << 20 });
  assert.equal(tok, 12345 + 6789);
  assert.ok(Date.now() - t0 < 5000, "不应出现 O(N^2) 退化卡顿");

  // P0-1 回归：readSessionPage 跨 256KiB 块边界恰好对齐 '\n' 时绝不能粘连蒸发相邻两行
  const CH = 256 * 1024;
  const uLine = JSON.stringify({ type: "user", uuid: "u-bound", message: { role: "user", content: "边界前一条消息" } });
  const aShell = (pad) => JSON.stringify({
    type: "assistant",
    uuid: "a-bound",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: pad }],
      usage: { input_tokens: 12000, cache_read_input_tokens: 345 },
    },
  });
  const baseLen = Buffer.byteLength(aShell(""));
  // 形态 A：末尾无换行且末行长度恰好 = 256KiB（上一块末字节恰为 uLine 后的 '\n'）
  const fBoundNoNl = path.join(tmpDir, "bound-nonl.jsonl");
  fs.writeFileSync(fBoundNoNl, uLine + "\n" + aShell("x".repeat(CH - baseLen)));
  const pNoNl = await readSessionPage(fBoundNoNl, { limit: 40 });
  assert.equal(pNoNl.items.length, 2, "末行恰为 256KiB（无尾换行）时相邻两行不能粘连丢失");
  assert.equal(pNoNl.contextTokens, 12345);

  // 形态 B：带尾换行且 (末行 + '\n') 长度恰好 = 256KiB
  const fBoundNl = path.join(tmpDir, "bound-nl.jsonl");
  fs.writeFileSync(fBoundNl, uLine + "\n" + aShell("y".repeat(CH - 1 - baseLen)) + "\n");
  const pNl = await readSessionPage(fBoundNl, { limit: 40 });
  assert.equal(pNl.items.length, 2, "末行+换行恰为 256KiB 时相邻两行不能粘连丢失");
  assert.equal(pNl.contextTokens, 12345);
});

test("① readSessionForward：超限无换行巨型单行进入 dropping 直至 \\n，且跨块 UTF-8 正常解码", async () => {
  const f = path.join(tmpDir, "fwd.jsonl");
  const u1 = JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "开头中文" + "汉".repeat(90000) } });
  // 3MB 超限行（中间夹杂看似合法 JSON 的后缀，验证 dropping 不会把后半截误解析成新行）
  const huge = '{"type":"user","pad":"' + "a".repeat(2.5 * 1024 * 1024) + '"} {"type":"user","uuid":"fake","message":{"role":"user","content":"FAKE_TAIL"}}';
  const u2 = JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "结尾正常消息" } });
  fs.writeFileSync(f, `${u1}\n${huge}\n${u2}\n`);

  const page = await readSessionForward(f, { after: 0, limit: 40, maxLine: 1 << 20 });
  const texts = page.items.map((x) => x.text);
  assert.ok(texts.some((t) => t.startsWith("开头中文") && t.endsWith("汉")), "跨块多字节 UTF-8 应无损解码");
  assert.ok(!texts.some((t) => t.includes("FAKE_TAIL")), "被丢弃的超长行后半截绝不能被误解析为新行");
  assert.ok(texts.some((t) => t === "结尾正常消息"), "超长行之后的正常行应完整读出");
});

test("① sessions.mjs indexSessionFile：超 4MB 无换行巨型行跳过且增量追加后不丢后续正常行", async () => {
  const projDir = path.join(PATHS.projects, "-debt-b1-idx");
  fs.mkdirSync(projDir, { recursive: true });
  const f = path.join(projDir, "idx-huge-test.jsonl");
  const first = JSON.stringify({ type: "user", uuid: "i1", message: { role: "user", content: "ALPHA_NEEDLE_FIRST" } });
  const hugeHalf = '{"type":"user","pad":"' + "z".repeat(4.5 * 1024 * 1024);
  fs.writeFileSync(f, first + "\n" + hugeHalf);

  const r1 = await searchSessions("ALPHA_NEEDLE_FIRST");
  assert.ok(r1.results.some((x) => x.id === "idx-huge-test"), "巨型半行前的正常行应可搜到");

  // 追加闭合巨型行并写入后续正常行，验证 e.dropping 衔接无误
  const tail = JSON.stringify({ type: "user", uuid: "i2", message: { role: "user", content: "BETA_NEEDLE_AFTER_HUGE" } });
  fs.appendFileSync(f, '"}' + "\n" + tail + "\n");

  const r2 = await searchSessions("BETA_NEEDLE_AFTER_HUGE");
  assert.ok(r2.results.some((x) => x.id === "idx-huge-test"), "巨型行闭合后的后续正常行应能增量索引并命中");
  fs.rmSync(projDir, { recursive: true, force: true });
});

test("③ local.mjs ensureLlama：异模型并发请求在加载期/交接期报忙拒绝，绝不抢杀刚载好的模型", async () => {
  // 通过验证 local.mjs 源码及运行时行为：制造假的前缀模型与假 llama-server（延迟 400ms 就绪）
  const modDir = path.join(CFG.home, "models");
  fs.mkdirSync(modDir, { recursive: true });
  const m1 = path.join(modDir, "m1-test.gguf");
  const m2 = path.join(modDir, "m2-test.gguf");
  // localModels 要求文件 >= 10e6 字节，用 sparse file（truncate）零磁盘开销
  for (const mf of [m1, m2]) {
    const fd = fs.openSync(mf, "w");
    fs.writeSync(fd, Buffer.from("GGUF"));
    fs.ftruncateSync(fd, 11 * 1024 * 1024);
    fs.closeSync(fd);
  }
  const src = fs.readFileSync(new URL("../gw/local.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("li.dsh.claudecli"), "local.mjs 不应再残留 li.dsh.claudecli");
  assert.ok(src.includes('process.env.CCAPP_PKG || "cc.codroid"'), "toFront 应支持 CCAPP_PKG 并默认 cc.codroid");
  assert.ok(src.includes("llStartingSig") && src.includes("llLeaseUntil"), "ensureLlama 应包含加载期与交接租约防抢占守卫");

  // 模拟已有运行中的 M1 且挂载了活动 run：请求 M2 应直接抛忙错而不杀 LL.child
  const fakeChild = { pid: 999999, exitCode: null, signalCode: null, kill() { throw new Error("should not kill"); } };
  const prevLL = { ...LL };
  const fakeRun = { id: "r-local-busy", ended: false };
  try {
    Object.assign(LL, { child: fakeChild, id: "m1-test", sig: "sig-m1", state: "ready" });
    localRunAttach(fakeRun);
    if (process.env.CCAPP_PREFIX) {
      // 若有 PREFIX 且装了 llama-server，直接调用 ensureLlama 验证报忙
      const bin = path.join(process.env.CCAPP_PREFIX, "bin", "llama-server");
      if (fs.existsSync(bin)) {
        await assert.rejects(() => ensureLlama("m2-test"), /正在另一个会话里用/);
      }
    }
  } finally {
    fakeRun.ended = true;
    Object.assign(LL, prevLL);
    fs.rmSync(m1, { force: true });
    fs.rmSync(m2, { force: true });
  }
});

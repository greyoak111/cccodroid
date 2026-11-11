// e 组 FIND-046：诊断包含用户消息前 60 字，和「已去掉消息内容」的承诺冲突。
// 日志里不写提问正文（斜杠命令只留命令名），原生打包那层照旧还有一道抹除。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptLogLine } from "../gw/run.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("FIND-046：提问日志只记字数，不写正文", () => {
  const body = "绝密内容 TOPSECRET-MARKER-046";
  const line = promptLogLine(body, false);
  assert.equal(line, `提问（${body.length} 字）`);
  assert.equal(line.includes("TOPSECRET"), false, "日志行里不该有正文：" + line);
  assert.equal(line.includes("绝密"), false, "日志行里不该有正文：" + line);
});

test("FIND-046：斜杠命令只记命令名，不带参数", () => {
  assert.equal(promptLogLine("/compact 因为上下文太长了", true), "命令 /compact");
  assert.equal(promptLogLine("/rename 我的秘密标题", true), "命令 /rename");
});

test("FIND-046：起一轮、插话的日志都改走 promptLogLine", () => {
  const src = fs.readFileSync(path.join(ROOT, "gateway", "gw", "run.mjs"), "utf8");
  assert.equal(/message\.trim\(\)\.slice\(0, 60\)/.test(src), false, "提问日志还在写正文");
  assert.equal(/item\.message\.trim\(\)\.slice\(0, (40|60)\)/.test(src), false, "插话日志还在写正文");
  assert.match(src, /promptLogLine\(message, isCmd\)/);
  assert.match(src, /promptLogLine\(item\.message, true\)/);
  assert.match(src, /promptLogLine\(item\.message, false\)/);
});

// ── FIND-047：日志要带日期，错误行要能定位到轮次/会话 ──
import { logTime } from "../gw/config.mjs";
import { runTag } from "../gw/queue.mjs";

test("FIND-047：日志时间带日期、用本地时间", () => {
  const s = logTime();
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const t = new Date(s.replace(" ", "T")).getTime();
  assert.equal(Math.abs(Date.now() - t) < 5000, true, "不是本地时间的当前时刻：" + s);
});

test("FIND-047：轮次/会话标记", () => {
  assert.equal(runTag({ id: "r-1" }), "[r-1]");
  assert.equal(runTag({ id: "r-2", sessionId: "12345678-90ab-cdef" }), "[r-2 12345678]");
});

test("FIND-047：错误与收尾日志带轮次/会话标记", () => {
  const run = fs.readFileSync(path.join(ROOT, "gateway", "gw", "run.mjs"), "utf8");
  assert.match(run, /runTag\(run\)\} ✖ \$\{hint\}/);
  assert.match(run, /runTag\(run\)\} spawn 出错/);
  assert.match(run, /runTag\(run\)\} ⚠️ 收尾出错/);
  const q = fs.readFileSync(path.join(ROOT, "gateway", "gw", "queue.mjs"), "utf8");
  assert.match(q, /runTag\(run\)\} ⏹ 停止 5 秒后还没收尾/);
});

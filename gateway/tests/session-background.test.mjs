// 后台守护会话（Claude Code 的 sessionKind=daemon / daemon-worker）不能进用户会话列表；
// 尤其要在按时间截断之前滤掉，否则最近的守护会话会占掉 limit，把用户自己的对话挤出去。
// 但 sessionKind=bg 是用户自己甩到后台的对话，Claude Code 的 /resume 照常显示，这里也不能藏。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../gw/config.mjs";
import { listSessions } from "../gw/sessions.mjs";

const dir = path.join(PATHS.projects, "zz-bg-list-test");
fs.mkdirSync(dir, { recursive: true });
const now = Date.now();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function write(n, text, kind, mtime) {
  const sid = id(n), file = path.join(dir, sid + ".jsonl");
  const ts = new Date(mtime).toISOString();
  const lines = [
    { type: "queue-operation", operation: "enqueue", sessionId: sid, timestamp: ts, content: text },
    { type: "user", sessionId: sid, uuid: sid + "-u", parentUuid: null, isSidechain: false, cwd: "/tmp",
      ...(kind ? { sessionKind: kind } : {}), timestamp: ts, message: { role: "user", content: text } },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

test("守护会话在 limit 之前被滤掉，用户会话不被挤走", () => {
  const normal = id(1);
  write(1, "用户自己的对话", "", now - 2000);
  write(2, "守护会话", "daemon", now);   // 最近：不滤的话会占掉 limit=1 的唯一名额
  const list = listSessions(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, normal);
  assert.equal(list.total, 1, "total 只数用户能看到的会话");
});

test("daemon / daemon-worker 不显示；bg 和未知 sessionKind 照常显示", () => {
  write(3, "daemon 会话", "daemon", now + 1000);
  write(4, "daemon worker", "daemon-worker", now + 2000);
  write(5, "普通会话", "main", now - 3000);
  write(6, "用户甩到后台的对话", "bg", now + 3000);
  write(8, '正文里写 "parentUuid": "x"', "daemon", now - 4000);   // 队列行正文有 parentUuid 字样也不能打乱分类
  const list = listSessions(50);
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes(id(1)));
  assert.ok(ids.includes(id(5)), "不认识的 sessionKind 按普通会话显示");
  assert.ok(ids.includes(id(6)), "bg 是用户自己的对话，不能藏");
  assert.ok(!ids.includes(id(3)));
  assert.ok(!ids.includes(id(4)));
  assert.ok(!ids.includes(id(8)), "正文里有 parentUuid 字样也照样认出守护会话");
  assert.equal(list.total, 3);
});

test("正文里出现 sessionKind 字样不误伤", () => {
  // 用户可能在对话里贴这段代码 / 日志：只有第一条带 parentUuid 记录上的字段才算数
  const sid = id(7), file = path.join(dir, sid + ".jsonl");
  const ts = new Date(now - 5000).toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({ type: "queue-operation", sessionId: sid, timestamp: ts, content: 'x "sessionKind":"daemon" y' }),
    JSON.stringify({ type: "user", sessionId: sid, uuid: sid + "-u", parentUuid: null, isSidechain: false, cwd: "/tmp",
      timestamp: ts, message: { role: "user", content: '看到日志里写着 {"sessionKind":"daemon"}，这是什么' } }),
  ].join("\n") + "\n");
  const list = listSessions(50);
  assert.ok(list.map((x) => x.id).includes(sid), "正文里的字样不能让会话消失");
});

test("清理", () => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 外部 / 无头会话（技能、脚本、终端里 claude -p）不藏，自动归进「杂项」；
// 网关自己开的、分叉 / 回退出来的、导入的都记过账，不归；用户移出过、改过名、置顶过的以用户为准。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../gw/config.mjs";
import { listSessions, sessionMisc, PINS, NAMES } from "../gw/sessions.mjs";
import { noteManaged, managedSince } from "../gw/sessmanaged.mjs";
import { archiveDb } from "../gw/archive-store.mjs";
import { forkSession } from "../gw/sessionops.mjs";

const dir = path.join(PATHS.projects, "zz-misc-external-test");
fs.mkdirSync(dir, { recursive: true });
const later = managedSince() + 60_000;   // 分界之后才出现的会话
const id = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

function write(n, text, entrypoint, at = later) {
  const sid = id(n), file = path.join(dir, sid + ".jsonl"), ts = new Date(at).toISOString();
  const lines = [
    { type: "user", sessionId: sid, uuid: sid + "-u", parentUuid: null, isSidechain: false, cwd: "/tmp",
      entrypoint, timestamp: ts, message: { role: "user", content: text } },
    { type: "assistant", sessionId: sid, uuid: sid + "-a", parentUuid: sid + "-u", isSidechain: false, cwd: "/tmp",
      entrypoint, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ];
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return sid;
}
const row = (sid) => listSessions(500).find((x) => x.id === sid);

test("没记过账的 sdk-cli 会话：留在列表里，但归进杂项", () => {
  const sid = write(1, "技能子会话的提示词", "sdk-cli");
  const r = row(sid);
  assert.ok(r, "不藏：对话页的杂项组里要看得到、能清");
  assert.equal(r.misc, true);
});

test("网关开的会话（记过账）不归杂项", () => {
  const sid = write(2, "用户在应用里开的对话", "sdk-cli");
  noteManaged(sid);
  assert.equal(row(sid).misc, false);
});

test("交互式终端（entrypoint cli）和升级前的老会话不归杂项", () => {
  assert.equal(row(write(3, "终端里手开的", "cli")).misc, false);
  assert.equal(row(write(4, "升级前的老会话", "sdk-cli", managedSince() - 60_000)).misc, false);
});

test("用户移出过、改过名、置顶过的：以用户为准", () => {
  const a = write(5, "认错了，用户移出杂项", "sdk-cli");
  archiveDb().sessions[a] = { title: null, chapters: {}, misc: false, miscBy: "user" };
  assert.equal(row(a).misc, false);
  const b = write(6, "用户改过名", "sdk-cli");
  NAMES[b] = "我的对话";
  assert.equal(row(b).misc, false);
  const c = write(7, "用户置顶", "sdk-cli");
  PINS[c] = Date.now();
  assert.equal(row(c).misc, false);
  delete NAMES[b]; delete PINS[c]; delete archiveDb().sessions[a];
});

test("用户自己归入杂项的照旧算杂项", () => {
  assert.equal(sessionMisc(id(99), true, { created: later, entrypoint: "cli" }), true);
});

test("分叉 / 回退出来的新会话记账，不会被当成外部会话", () => {
  const src = write(8, "要分叉的对话", "sdk-cli");
  noteManaged(src);
  const r = forkSession(src, "要分叉的对话", "", { latest: true });
  assert.ok(r.ok, JSON.stringify(r));
  delete NAMES[r.id];   // 分叉会自动起名；去掉名字，确认靠的是记账而不是改名豁免
  assert.equal(row(r.id).misc, false);
});

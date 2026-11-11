// FIND-015：会话目录读不了时不能回 200 空表，要和「真的没有会话」分开
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PATHS } from "../gw/config.mjs";
import { listSessions, routeSessions } from "../gw/sessions.mjs";

const failReaddir = (code) => {
  const orig = fs.readdirSync;
  fs.readdirSync = (p, opt) => {
    if (String(p) === PATHS.projects) throw Object.assign(new Error("read failed"), { code });
    return orig(p, opt);
  };
  return () => { fs.readdirSync = orig; };
};

test("目录不存在：还是空表（刚装的正常情况）", () => {
  const restore = failReaddir("ENOENT");
  try {
    const list = listSessions();
    assert.equal(list.length, 0);
    assert.equal(list.error, undefined);
  } finally { restore(); }
});

test("目录读不了：列表带上错误，接口回 500 而不是 200 空表", async () => {
  const restore = failReaddir("EACCES");
  let res;
  try {
    const list = listSessions();
    assert.equal(list.error, "EACCES");
    const req = { method: "GET", headers: {} };
    res = { req, writeHead(code) { this.code = code; }, end(b) { this.body = b.toString(); } };
    await routeSessions(req, res, new URL("http://127.0.0.1/api/sessions"), "/api/sessions");
  } finally { restore(); }
  assert.equal(res.code, 500);
  const j = JSON.parse(res.body);
  assert.equal(j.error, "read_failed");
  assert.match(j.message, /不是没有会话/);
});

test("读得了时照常回列表", async () => {
  fs.mkdirSync(PATHS.projects, { recursive: true });
  const req = { method: "GET", headers: {} };
  const res = { req, writeHead(code) { this.code = code; }, end(b) { this.body = b.toString(); } };
  await routeSessions(req, res, new URL("http://127.0.0.1/api/sessions"), "/api/sessions");
  assert.equal(res.code, 200);
  assert.ok(Array.isArray(JSON.parse(res.body).sessions));
});

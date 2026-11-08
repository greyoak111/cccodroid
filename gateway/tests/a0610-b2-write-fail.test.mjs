// 0.6.10 车道 b2：写盘失败如实回 500（195-N.1 / 197-2.7）——会话模型、用量开关
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG } from "../gw/config.mjs";

const { routeSessModel } = await import("../gw/sessmodel.mjs");
const { routeUsage } = await import("../gw/usage.mjs");

const call = async (route, method, p, body) => {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body || {}))]), { method });
  const u = new URL(p, "http://x"), res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b.toString()); } };
  await route(req, res, u, u.pathname);
  return res;
};

test("会话模型写失败：500、不假装保存成功（197-2.7）", async () => {
  const file = path.join(CFG.home, "ccapp-session-models.json");
  const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.rmSync(file, { force: true }); fs.mkdirSync(file);
  try {
    const r = await call(routeSessModel, "POST", "/api/session-model", { id: "b2-sid", model: "m1" });
    assert.equal(r.code, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "write_failed");
  } finally { fs.rmSync(file, { recursive: true, force: true }); if (old != null) fs.writeFileSync(file, old); }
});

test("用量开关写失败：500（195-N.1）", async () => {
  const file = path.join(CFG.home, "ccapp-usage.json");
  const old = fs.readFileSync(file);
  fs.rmSync(file); fs.mkdirSync(file);
  try {
    const r = await call(routeUsage, "POST", "/api/usage/set", { off: true });
    assert.equal(r.code, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "write_failed");
  } finally { fs.rmSync(file, { recursive: true, force: true }); fs.writeFileSync(file, old); }
});

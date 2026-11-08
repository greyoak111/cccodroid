// 196-供应链.2（custom.mjs 半，g1 移交）：网关重启后盘上没人管的 .stage-* 过一小时清掉，一小时内的留着接着装（195-J.4）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NEXT } from "../gw/http.mjs";
import { routeCustom, _customForTest } from "../gw/custom.mjs";

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if ((await routeCustom(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const base = `http://127.0.0.1:${srv.address().port}`;
const upload = async (name, body) => (await fetch(base + "/api/custom/upload?name=" + encodeURIComponent(name), { method: "POST", body })).json();

test("重启后留下的过期暂存被清掉，新的、能接着装的、不像暂存的都不动", async () => {
  const D = _customForTest.CUSTOM_DIR;
  fs.mkdirSync(D, { recursive: true });
  const old = path.join(D, ".stage-aaaaaaaaaaaa"), oldNoRep = path.join(D, ".stage-bbbbbbbbbbbb");
  const fresh = path.join(D, ".stage-cccccccccccc"), other = path.join(D, ".stage-keepme");
  for (const d of [old, oldNoRep, fresh, other]) fs.mkdirSync(path.join(d, "x"), { recursive: true });
  const hourAgo = Date.now() - 3700000;
  fs.writeFileSync(path.join(old, "report.json"), JSON.stringify({ at: hourAgo, root: "x", report: {} }));
  fs.utimesSync(oldNoRep, hourAgo / 1000, hourAgo / 1000);
  fs.writeFileSync(path.join(fresh, "report.json"), JSON.stringify({ at: Date.now() - 60000, root: "x", report: {} }));
  fs.utimesSync(other, hourAgo / 1000, hourAgo / 1000);

  const r = await upload("t.sh", "#!/bin/sh\necho hi\n");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(old), false, "report.json 过期的暂存还在");
  assert.equal(fs.existsSync(oldNoRep), false, "没有 report.json、目录已过一小时的暂存还在");
  assert.equal(fs.existsSync(fresh), true, "一小时内的暂存被删了，重启后就接不回来了");
  assert.equal(fs.existsSync(other), true, "名字不像暂存的目录也被删了");
  assert.equal(fs.existsSync(path.join(D, ".stage-" + r.stage)), true, "刚分析完的暂存被删了");
});

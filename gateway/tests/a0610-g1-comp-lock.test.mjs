// 196-供应链.1：组件之间改 $PREFIX 文件清单 / 组件记录的阶段要串行；
// 正在装（installing）的组件也算数，别的组件卸载不能把它要用的共享文件删掉。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";

const COMP_DIR = path.join(path.dirname(PREFIX), "components");
fs.mkdirSync(COMP_DIR, { recursive: true });
const DK = { sha256: "dk0610" };
const IDS = ["a0610", "b0610"];
const SHARED = path.join(PREFIX, "bin", "shared0610");

after(() => {
  for (const id of IDS) fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
  fs.rmSync(SHARED, { force: true });
  try { fs.rmdirSync(path.join(PREFIX, "bin")); } catch {}
  fs.rmSync(path.join(PREFIX, ".devkit-ok"), { force: true });
});

const m = await import("../gw/components.mjs");
const { compFsExclusive, compRecords, compRemove, _compForTest } = m;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("compFsExclusive：按提交顺序串行，前一步失败不挡住排队的人", async () => {
  const order = [];
  const a = compFsExclusive(async () => { order.push("a-start"); await sleep(30); order.push("a-end"); });
  const b = compFsExclusive(async () => { order.push("b-start"); await sleep(1); order.push("b-end"); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"], "后来的要等前一步整个做完，不能交错");
  await assert.rejects(compFsExclusive(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await compFsExclusive(async () => "ok"), "ok", "前一步抛错后链子还能接着用");
});

test("compRecords 收录 installing；卸载别的组件时它要用的共享文件留下并记到它名下", async () => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify(DK));
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  fs.writeFileSync(SHARED, "x");
  // A 正在装（installing），记录里已经写下要用的文件；B 已装好，记录里同样有这个共享文件
  for (const [id, state, sha] of [["a0610", "installing", "sha-a"], ["b0610", "ok", "sha-b"]])
    assert.ok(_compForTest.compWriteRecord(id, { id, state, base: DK.sha256, sha256: sha, version: "1.0.0",
      bin: [], files: ["bin/shared0610"], shared: [] }));
  assert.ok(compRecords().has("a0610"), "installing 记录也要算数，不然卸载 B 会把它要用的文件删掉");
  const r = await compRemove("b0610");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(SHARED), "A 还要用的共享文件不能随 B 卸载删掉");
  const a = _compForTest.compRecordInfo("a0610").rec;
  assert.ok(a.files.includes("bin/shared0610"), "共享文件要留在 A 名下");
  assert.equal(_compForTest.compRecordInfo("b0610").missing, true, "B 的记录要删掉");
});

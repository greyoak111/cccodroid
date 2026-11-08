// 0.6.10 车道 b3：组件记录原子写、读不出来时区分「没有」和「坏了」（195-Z.10 / 195-Z.11）
// 以前：custom.mjs 覆盖写，坏记录被静默丢掉，列表里没了、bin 入口还在，卸不掉也重装不了；
// 组件记录写失败没人管，坏记录被当成「没装」。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMP_DIR, compRecord, _compForTest } from "../gw/components.mjs";
import { _customForTest } from "../gw/custom.mjs";

const { compWriteRecord, compRecordInfo, compRecFile } = _compForTest;
const { customRecords, CUSTOM_DIR } = _customForTest;
const rec = (id) => path.join(COMP_DIR, id + ".json");
const COMP_IDS = ["b3-miss", "b3-bad", "b3-atomic", "b3-fail"];
const CUSTOM_IDS = ["b3-good", "b3-bad-cust", "b3-half"];

after(() => {
  for (const id of COMP_IDS) fs.rmSync(rec(id), { recursive: true, force: true });
  for (const id of CUSTOM_IDS) fs.rmSync(path.join(CUSTOM_DIR, id), { recursive: true, force: true });
});

test("compRecordInfo：没有记录是 missing，坏记录是 bad，坏文件原地保留", () => {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  assert.deepEqual(compRecordInfo("b3-miss"), { rec: null, missing: true, bad: false });
  const f = compRecFile("b3-bad");
  fs.writeFileSync(f, "{坏了");
  const info = compRecordInfo("b3-bad");
  assert.equal(info.missing, false);
  assert.equal(info.bad, true, "坏记录要认成 bad，不能当成没有");
  assert.equal(info.rec, null);
  // 不能用 loadState 那样把坏文件改名：改完下次列表按 <id>.json 就找不到这个组件了（Z.11 的老毛病）
  assert.ok(fs.existsSync(f), "坏记录要留在原地，组件才不会被当成没装");
  fs.writeFileSync(f, JSON.stringify({ id: "b3-bad", state: "ok" }));
  assert.equal(compRecord("b3-bad").state, "ok");
});

test("compWriteRecord：原子写成功可读回；写失败返回 false，不动旧记录、不留临时文件", () => {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  assert.equal(compWriteRecord("b3-atomic", { id: "b3-atomic", state: "installing", files: ["bin/x"] }), true);
  assert.deepEqual(compRecord("b3-atomic"), { id: "b3-atomic", state: "installing", files: ["bin/x"] });
  // 用一个非空目录占住记录路径：最后换名那步必失败（root / 非 root 都成立），不用改目录权限
  const blocker = rec("b3-fail");
  fs.mkdirSync(blocker, { recursive: true });
  fs.writeFileSync(path.join(blocker, "x"), "占位");
  assert.equal(compWriteRecord("b3-fail", { id: "b3-fail" }), false, "写不进去要如实返回 false");
  assert.ok(!fs.readdirSync(COMP_DIR).some((n) => n.includes(".tmp-")), "失败要把临时文件清掉");
});

test("customRecords：坏记录 / 装到一半的记录照样列出来（damaged），组件不会凭空消失", () => {
  const good = path.join(CUSTOM_DIR, "b3-good");
  const bad = path.join(CUSTOM_DIR, "b3-bad-cust");
  const half = path.join(CUSTOM_DIR, "b3-half");
  for (const d of [good, bad, half]) fs.mkdirSync(path.join(d, "app"), { recursive: true });
  fs.writeFileSync(path.join(good, "cccodroid-custom.json"), JSON.stringify({
    id: "b3-good", name: "好组件", at: 1, entries: [{ cmd: "b3good", kind: "static" }], libs: [], deps: [], unresolved: [],
  }));
  fs.writeFileSync(path.join(bad, "cccodroid-custom.json"), "{坏了");
  // half：记录没写上的半截安装（装到一半被杀）

  const byId = new Map(customRecords().map((r) => [r.id, r]));
  assert.equal(byId.get("b3-good").name, "好组件");
  assert.equal(byId.get("b3-good").entries.length, 1);
  assert.equal(byId.get("b3-bad-cust").damaged, true, "坏记录要列出来，否则 bin 入口还在却卸不掉");
  assert.deepEqual(byId.get("b3-bad-cust").entries, []);
  assert.equal(byId.get("b3-half").damaged, true, "装了一半的目录也要能清掉");
  // 坏记录留底（loadState 的 keepBad），原位置不再有记录
  assert.ok(fs.readdirSync(bad).some((n) => n.startsWith("cccodroid-custom.json.bad-")), "坏记录要留底");
  // 第二次读：原文件已经改名，仍靠 app/ 认出这个组件
  assert.equal(new Map(customRecords().map((r) => [r.id, r])).get("b3-bad-cust")?.damaged, true);
});

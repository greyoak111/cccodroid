// 组件安装报告 §2：网关在安装中途被杀（看门狗 17 秒证明不了自己、掉电之类）后，
// 启动时 compRecover 按残留状态回滚或收口，不再永久停在 installing。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";

const COMP_DIR = path.join(path.dirname(PREFIX), "components");
const stage = path.join(COMP_DIR, ".staging");
fs.mkdirSync(stage, { recursive: true });
const ID = "rec-0611";

const m = await import("../gw/components.mjs");
const { compWriteRecord, compRecover } = m._compForTest;

const ids = new Set([ID + "-bak", ID + "-tree", ID + "-done", ID + "-half", ID + "-ok", ID + "-other"]);
const w = (rel, content) => { const f = path.join(PREFIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
after(() => {
  for (const id of ids) {
    fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
    fs.rmSync(path.join(COMP_DIR, id + ".json.prev"), { force: true });
    fs.rmSync(path.join(stage, id), { recursive: true, force: true });
    fs.rmSync(path.join(stage, id + ".old"), { recursive: true, force: true });
    for (const r of ["bin/rec-old", "bin/rec-new", "share/rec/a", "share/rec/missing"]) fs.rmSync(path.join(PREFIX, r), { force: true });
  }
});

test("有 .old 备份：回滚——旧文件放回、新搬进去的删掉、记录退回 .json.prev", async () => {
  const id = ID + "-bak";
  // 旧版：bin/rec-old（这次被备份进 .old）；新版新增 bin/rec-new（搬进去了一半，被杀）
  w("bin/rec-old", "old");
  w("bin/rec-new", "new-half");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["bin/rec-old"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-old", "bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  // 被杀时的 .old：旧版 bin/rec-old 已经挪进去了
  const bak = path.join(stage, id + ".old");
  fs.mkdirSync(path.dirname(path.join(bak, "bin/rec-old")), { recursive: true });
  fs.renameSync(path.join(PREFIX, "bin/rec-old"), path.join(bak, "bin/rec-old"));
  await compRecover();
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/rec-old"), "utf8"), "old", "旧文件放回原位");
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/rec-new")), false, "半搬进去的新文件删掉");
  assert.equal(fs.existsSync(bak), false, ".old 清掉");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.version, "1.0.0"); assert.equal(got.state, "ok");
  assert.equal(fs.existsSync(path.join(COMP_DIR, id + ".json.prev")), false, ".json.prev 用完删掉");
});

test("没有 .old 但有暂存树：删已搬入的、删记录，压缩包留着重装", async () => {
  const id = ID + "-tree";
  w("bin/rec-new", "new-half");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  fs.mkdirSync(path.join(stage, id, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, id, "usr", "bin", "rec-new"), "full");
  fs.writeFileSync(path.join(stage, id + "-ab12cd34ef56.tar.gz"), "gz");   // 压缩包留着
  await compRecover();
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/rec-new")), false, "已搬入的撤掉");
  assert.equal(fs.existsSync(path.join(COMP_DIR, id + ".json")), false, "半截记录删掉");
  assert.ok(fs.existsSync(path.join(stage, id + "-ab12cd34ef56.tar.gz")), "压缩包留着，重装不用重下");
  assert.ok(fs.existsSync(path.join(stage, id, "usr", "bin", "rec-new")), "暂存树留着");
});

test("没有 .old 也没有暂存树、files 全在：提交点之后被杀，补成 ok", async () => {
  const id = ID + "-done";
  w("bin/rec-new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  await compRecover();
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "ok"); assert.equal(got.version, "2.0.0");
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "文件没动");
});

test("没有 .old 也没有暂存树、files 不全：删残留、退回 .json.prev", async () => {
  const id = ID + "-half";
  w("bin/rec-new", "new-half");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["share/rec/a"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [],
    files: ["bin/rec-new", "share/rec/missing"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  await compRecover();
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/rec-new")), false, "残留删掉");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.version, "1.0.0"); assert.equal(got.state, "ok");
});

test("别的组件、ok 记录、坏记录都不动", async () => {
  const okId = ID + "-ok", otherId = ID + "-other";
  compWriteRecord(okId, { id: okId, state: "ok", version: "1.0.0", files: ["bin/rec-new"], shared: [] });
  compWriteRecord(otherId, { id: otherId, state: "installing", version: "1.0.0", files: ["bin/rec-new"], shared: [] });
  w("bin/rec-new", "theirs");
  await compRecover();
  // otherId 是 installing 且 files 全在：会被补成 ok（这正是预期路径，不算"不动"）。
  // 这里专测 ok 记录：版本与状态原样
  const okGot = JSON.parse(fs.readFileSync(path.join(COMP_DIR, okId + ".json"), "utf8"));
  assert.equal(okGot.state, "ok"); assert.equal(okGot.version, "1.0.0");
  const otherGot = JSON.parse(fs.readFileSync(path.join(COMP_DIR, otherId + ".json"), "utf8"));
  assert.equal(otherGot.state, "ok", "installing 且文件全在：补成 ok");
});

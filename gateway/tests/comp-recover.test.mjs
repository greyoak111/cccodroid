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
const { compWriteRecord, compRecover, compClearStage } = m._compForTest;

const ids = new Set([ID + "-bak", ID + "-tree", ID + "-done", ID + "-half", ID + "-ok", ID + "-other",
  ID + "-committed", ID + "-commshared", ID + "-halfbak", ID + "-idem", ID + "-noprev", ID + "-badarr", ID + "-after", ID + "-oldbase",
  ID + "-rbfail", ID + "-legacy", ID + "-prebak", ID + "-window", ID + "-clear"]);
const w = (rel, content) => { const f = path.join(PREFIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
after(() => {
  for (const id of ids) {
    fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
    fs.rmSync(path.join(COMP_DIR, id + ".json.prev"), { force: true });
    fs.rmSync(path.join(stage, id), { recursive: true, force: true });
    fs.rmSync(path.join(stage, id + ".old"), { recursive: true, force: true });
    fs.rmSync(path.join(stage, id + "-ab12cd34ef56.tar.gz"), { force: true });
    for (const r of ["bin/rec-old", "bin/rec-new", "share/rec/a", "share/rec/missing",
      "bin/a", "bin/b", "bin/new", "bin/x", "bin/c-new", "share/rec/gone"]) fs.rmSync(path.join(PREFIX, r), { force: true });
  }
  fs.rmSync(path.join(stage, "other-comp-ab12cd34ef56.tar.gz"), { force: true });
  fs.rmSync(path.join(PREFIX, ".devkit-ok"), { force: true });
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
  // files 里带一个没搬到的：不全在 → 走「撤已搬入」；全在会按窄窗口补 ok（见 -window 用例）
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-new", "share/rec/missing"], shared: [] };
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

test("没有 .old 也没有暂存树、files 不全：留 installing 可重装，不删 $PREFIX", async () => {
  const id = ID + "-half";
  w("bin/rec-new", "new-half");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["share/rec/a"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [],
    files: ["bin/rec-new", "share/rec/missing"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  await compRecover();
  // 复核 P0-1 后的语义：半截状态不删已放进 $PREFIX 的文件（重装会补），记录留在 installing 让界面显示可重装
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/rec-new")), true, "不删残留");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "installing"); assert.equal(got.version, "2.0.0");
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

// ── 独立复核 67ea9ba 补的用例：旧实现会删掉已装好的文件 / 旧版文件 ──

test("P0-1 提交点之后被杀（committed + 暂存树还在）：补 ok、暂存和压缩包收掉，不删文件", async () => {
  const id = ID + "-committed";
  w("bin/rec-new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, committed: true, bin: [], files: ["bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  fs.mkdirSync(path.join(stage, id, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, id + "-ab12cd34ef56.tar.gz"), "gz");   // 提交点之后暂存树和压缩包都还在
  await compRecover();
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "已装好的文件不删");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "ok");
  assert.equal(fs.existsSync(path.join(stage, id)), false, "暂存树收掉");
  assert.equal(fs.existsSync(path.join(stage, id + "-ab12cd34ef56.tar.gz")), false, "压缩包收掉");
});

test("P0-1 提交点之后被杀但共享依赖没了：留 installing 可重装，不删文件", async () => {
  const id = ID + "-commshared";
  w("bin/rec-new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, committed: true, bin: [], files: ["bin/rec-new"], shared: ["share/rec/gone"] };
  assert.ok(compWriteRecord(id, rec));
  await compRecover();
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "installing", "共享文件没了不能补 ok，界面显示可重装");
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "已装好的文件不删，重装会补齐");
});

test("P0-2 备份做了一半被杀：没进备份的旧版文件不删，只删本次新搬的", async () => {
  const id = ID + "-halfbak";
  w("bin/a", "v1-a"); w("bin/b", "v1-b"); w("bin/new", "new");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["bin/a", "bin/b"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/a", "bin/b", "bin/new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  // 被杀时 bin/a 已进备份、bin/b 还没备份、bin/new 已搬入
  const bak = path.join(stage, id + ".old");
  fs.mkdirSync(path.dirname(path.join(bak, "bin/a")), { recursive: true });
  fs.renameSync(path.join(PREFIX, "bin/a"), path.join(bak, "bin/a"));
  await compRecover();
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/a"), "utf8"), "v1-a", "备份里的放回");
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/b"), "utf8"), "v1-b", "没进备份的旧版文件不动");
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/new")), false, "本次新搬的删掉");
});

test("P0-2 恢复自身被杀后再恢复：上一轮已放回的旧文件第二轮不删（幂等）", async () => {
  const id = ID + "-idem";
  w("bin/a", "v1-a"); w("bin/new", "new");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["bin/a", "bin/b"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/a", "bin/b", "bin/new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  // 上一轮恢复已把 bin/a 放回、删 bin/new 之前被杀：.old 里还剩 bin/b
  const bak = path.join(stage, id + ".old");
  fs.mkdirSync(path.dirname(path.join(bak, "bin/b")), { recursive: true });
  fs.writeFileSync(path.join(bak, "bin/b"), "v1-b");
  await compRecover();
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/a"), "utf8"), "v1-a", "已放回的旧文件不删");
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/b"), "utf8"), "v1-b", "备份剩余的放回");
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/new")), false, "新文件删掉");
});

test("P0-2 有备份但没有旧记录：宁可不删，别把旧版最后一份删掉", async () => {
  const id = ID + "-noprev";
  w("bin/x", "v1-x"); w("bin/new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/x", "bin/new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  const bak = path.join(stage, id + ".old");
  fs.mkdirSync(path.dirname(path.join(bak, "bin/x")), { recursive: true });
  fs.renameSync(path.join(PREFIX, "bin/x"), path.join(bak, "bin/x"));
  await compRecover();
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/x"), "utf8"), "v1-x", "备份放回");
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/new")), "没有旧记录可对照，新文件也没敢删");
});

test("P2-8 files 不是数组：跳过这个组件，后面的照常恢复", async () => {
  const id = ID + "-badarr";
  compWriteRecord(id, { id, source: "official", version: "2.0.0", state: "installing", at: 2, files: {}, shared: [] });
  const otherId = ID + "-after";
  compWriteRecord(otherId, { id: otherId, state: "installing", version: "1.0.0", files: ["bin/c-new"], shared: [] });
  w("bin/c-new", "new");
  await compRecover();   // 不抛
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/c-new"), "utf8"), "new", "后面的组件照常恢复");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, otherId + ".json"), "utf8"));
  assert.equal(got.state, "ok");
});

test("P1-6 旧工具包上的 installing：只清记录和暂存，不碰 $PREFIX", async () => {
  const id = ID + "-oldbase";
  w("bin/rec-new", "theirs");
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "now-base" }));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, base: "other-base", bin: [], files: ["bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  fs.mkdirSync(path.join(stage, id, "usr"), { recursive: true });
  fs.writeFileSync(path.join(stage, id, "usr", "x"), "x");
  await compRecover();
  assert.equal(fs.existsSync(path.join(COMP_DIR, id + ".json")), false, "旧记录清掉");
  assert.equal(fs.existsSync(path.join(stage, id)), false, "暂存树清掉");
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "$PREFIX 没动");
});

test("§3 回滚放回失败：不删文件、不写回旧记录，留 installing + 备份 + .prev 下次再试", async () => {
  const id = ID + "-rbfail";
  w("bin/rec-old", "i-am-a-file");            // 旧版路径被一个文件占住，备份里的深路径放不回去
  w("bin/rec-new", "new");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["bin/rec-old"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-old", "bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  const bak = path.join(stage, id + ".old");
  fs.mkdirSync(path.join(bak, "bin/rec-old"), { recursive: true });
  fs.writeFileSync(path.join(bak, "bin/rec-old/y"), "old");
  await compRecover();
  assert.ok(fs.existsSync(bak), "备份留着下次再试");
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/rec-new")), true, "新文件也没敢删");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "installing", "不写回 ok 假装旧版完好");
  assert.ok(fs.existsSync(path.join(COMP_DIR, id + ".json.prev")), ".prev 留着，恢复要拿它对照");
});

test("旧记录无 committed：文件都在但 shared 缺，不补 ok、不删文件，留 installing 可重装", async () => {
  const id = ID + "-legacy";
  w("bin/rec-new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-new"], shared: ["share/rec/gone"] };
  assert.ok(compWriteRecord(id, rec));
  await compRecover();
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "installing", "shared 没了不能补 ok");
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "已装好的文件不删");
});

test("升级在备份前被杀（无备份有暂存树）：旧版路径不删，只撤本次新搬的", async () => {
  const id = ID + "-prebak";
  // 备份还没开始：旧版 bin/a 在，新版 bin/prebak-new 还没搬进来（不在 $PREFIX）
  w("bin/a", "v1-a");
  const prev = { id, source: "official", version: "1.0.0", state: "ok", at: 1, bin: [], files: ["bin/a"], shared: [] };
  fs.writeFileSync(path.join(COMP_DIR, id + ".json.prev"), JSON.stringify(prev));
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/a", "bin/prebak-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  fs.mkdirSync(path.join(stage, id, "usr", "bin"), { recursive: true });
  await compRecover();
  assert.equal(fs.readFileSync(path.join(PREFIX, "bin/a"), "utf8"), "v1-a", "旧版路径不删");
  assert.equal(fs.existsSync(path.join(PREFIX, "bin/prebak-new")), false, "没搬进来的新文件保持没有");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.version, "1.0.0", "记录退回旧版");
});

test("窄窗口：有暂存树、无备份、files 全在（死在提交点落盘前）：补 ok 不删文件", async () => {
  const id = ID + "-window";
  w("bin/rec-new", "new");
  const rec = { id, source: "official", version: "2.0.0", state: "installing", at: 2, bin: [], files: ["bin/rec-new"], shared: [] };
  assert.ok(compWriteRecord(id, rec));
  fs.mkdirSync(path.join(stage, id, "usr", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, id + "-ab12cd34ef56.tar.gz"), "gz");
  await compRecover();
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/rec-new")), "装好的文件不删");
  const got = JSON.parse(fs.readFileSync(path.join(COMP_DIR, id + ".json"), "utf8"));
  assert.equal(got.state, "ok", "补成 ok");
  assert.equal(fs.existsSync(path.join(stage, id)), false, "暂存树收掉");
});

test("compClearStage 只清本组件的暂存、备份和压缩包，别的组件不碰", () => {
  const id = ID + "-clear";
  fs.mkdirSync(path.join(stage, id), { recursive: true });
  fs.writeFileSync(path.join(stage, id, "x"), "x");
  fs.mkdirSync(path.join(stage, id + ".old"), { recursive: true });
  fs.writeFileSync(path.join(stage, id + ".old", "y"), "y");
  fs.writeFileSync(path.join(stage, id + "-ab12cd34ef56.tar.gz"), "gz");
  fs.writeFileSync(path.join(stage, "other-comp-ab12cd34ef56.tar.gz"), "other");
  compClearStage(id);
  assert.equal(fs.existsSync(path.join(stage, id)), false, "暂存树清掉");
  assert.equal(fs.existsSync(path.join(stage, id + ".old")), false, ".old 清掉");
  assert.equal(fs.existsSync(path.join(stage, id + "-ab12cd34ef56.tar.gz")), false, "压缩包清掉");
  assert.ok(fs.existsSync(path.join(stage, "other-comp-ab12cd34ef56.tar.gz")), "别的组件不碰");
});

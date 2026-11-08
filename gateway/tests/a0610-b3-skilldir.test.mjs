// 0.6.10 车道 b3：技能目录名判断（195-J.5）
// 会话 id 的 SID_RE 只管 ASCII；技能目录名放宽到能收中文 / 空格，但只认 skills/ 下已列出的真实目录名，
// 且不接受路径分隔符、「.」「..」。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SID_RE, skillDirOk } from "../gw/sessionops.mjs";

const listed = ["中文技能", "with space", "ascii-name", ".hidden"];

test("中文、空格的技能目录名通过（原 bug：SID_RE 会把它们判成 bad name）", () => {
  assert.equal(SID_RE.test("中文技能"), false, "SID_RE 仍按原样管会话 id，不为技能放宽");
  assert.equal(skillDirOk("中文技能", listed), true);
  assert.equal(skillDirOk("with space", listed), true);
  assert.equal(skillDirOk("ascii-name", listed), true);
});

test("必须是已列出的目录名：精确匹配，不做归一化", () => {
  assert.equal(skillDirOk("没列出来的", listed), false);
  assert.equal(skillDirOk("中文技能 ", listed), false, "尾随空格不是同一个名字");
  assert.equal(skillDirOk("With Space", listed), false, "大小写不同不是同一个名字");
  assert.equal(skillDirOk("中文技能", undefined), false);
  assert.equal(skillDirOk("中文技能", "中文技能"), false, "listed 不是数组时不放行");
});

test("路径分隔符、「.」「..」、NUL、空名一律不收（即使硬塞进 listed）", () => {
  for (const bad of ["a/b", "a\\b", ".", "..", "a\0b", ""]) {
    assert.equal(skillDirOk(bad, [bad, ".", ".."]), false, JSON.stringify(bad));
  }
});

test("超长名字不收", () => {
  const long = "长".repeat(201);
  assert.equal(skillDirOk(long, [long]), false);
  const max = "长".repeat(200);
  assert.equal(skillDirOk(max, [max]), true);
});

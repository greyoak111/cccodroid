// 组件技能不覆盖同名的已有技能（#104 05-010）：用户自己写的、别的组件放的都不碰；自己放的（有归属标记）照常更新。
// 走 compHealSkills（GET /api/components 每次都跑的那条自动补装）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMP_DIR, compHealSkills, compRecord } from "../gw/components.mjs";
import { SKILLS_DIR } from "../gw/extensions.mjs";
import { PREFIX } from "../gw/config.mjs";

// 同一轮的测试共用一个假 home：别把造的记录留给别的测试文件（components.test 断言组件目录里没有 *.json）
const made = [];
after(() => { for (const id of made) { fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true }); fs.rmSync(path.join(PREFIX, "share/cccodroid/components", id), { recursive: true, force: true }); } });

// 造一个「装好了、记录里没有 skill」的组件，包里带名叫 name 的技能
function comp(id, name) {
  made.push(id);
  const src = path.join(PREFIX, "share/cccodroid/components", id, "skill");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), `---\nname: ${name}\ndescription: 组件版\n---\n组件 ${id}\n`);
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMP_DIR, id + ".json"), JSON.stringify({ id, state: "ok", skill: "", files: [], shared: [] }));
}
const userSkill = (name) => {
  const d = path.join(SKILLS_DIR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: 我的\n---\n我自己写的\n`);
  fs.writeFileSync(path.join(d, "user-notes.txt"), "别删我");
  return d;
};

test("同名的用户技能：自动补装不删不改，记录也不认领", () => {
  const d = userSkill("ks-mine");
  comp("ks-a", "ks-mine");
  compHealSkills();
  assert.equal(fs.readFileSync(path.join(d, "user-notes.txt"), "utf8"), "别删我");
  assert.match(fs.readFileSync(path.join(d, "SKILL.md"), "utf8"), /我自己写的/);
  assert.equal(compRecord("ks-a").skill, "");
});

test("没有同名：照常补装，并记下归属", () => {
  comp("ks-b", "ks-free");
  compHealSkills();
  const d = path.join(SKILLS_DIR, "ks-free");
  assert.match(fs.readFileSync(path.join(d, "SKILL.md"), "utf8"), /组件 ks-b/);
  assert.equal(fs.readFileSync(path.join(d, ".cccodroid-component"), "utf8").trim(), "ks-b");
  assert.equal(compRecord("ks-b").skill, "ks-free");
});

test("别的组件放的同名技能：也不碰", () => {
  comp("ks-c", "ks-free");                       // 跟上一条 ks-b 的技能同名
  compHealSkills();
  assert.match(fs.readFileSync(path.join(SKILLS_DIR, "ks-free", "SKILL.md"), "utf8"), /组件 ks-b/);
  assert.equal(compRecord("ks-c").skill, "");
});

test("自己放的（装到一半记录没写上）：认得出，重新装上", () => {
  const d = path.join(SKILLS_DIR, "ks-half");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, ".cccodroid-component"), "ks-d\n");
  fs.writeFileSync(path.join(d, "SKILL.md"), "旧的半截");
  comp("ks-d", "ks-half");
  compHealSkills();
  assert.match(fs.readFileSync(path.join(d, "SKILL.md"), "utf8"), /组件 ks-d/);
  assert.equal(compRecord("ks-d").skill, "ks-half");
});

test("空目录（v0.1.9 留下的）：删掉再装", () => {
  fs.mkdirSync(path.join(SKILLS_DIR, "ks-empty"), { recursive: true });
  comp("ks-e", "ks-empty");
  compHealSkills();
  assert.equal(compRecord("ks-e").skill, "ks-empty");
});

test("技能名不合法 / 同名的是个文件：补装跳过，不抛（这段跑在启动定时器里，抛了网关就崩）", () => {
  comp("ks-f", "坏/名字");
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, "ks-file"), "我是个文件");
  comp("ks-g", "ks-file");
  assert.doesNotThrow(() => compHealSkills());
  assert.equal(compRecord("ks-f").skill, "");
  assert.equal(compRecord("ks-g").skill, "");
  assert.equal(fs.readFileSync(path.join(SKILLS_DIR, "ks-file"), "utf8"), "我是个文件");
  fs.rmSync(path.join(SKILLS_DIR, "ks-file"));
});

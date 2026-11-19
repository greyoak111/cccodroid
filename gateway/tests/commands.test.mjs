// 常用指令（gw/commands.mjs）：frontmatter 拆合、名字校验
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import { parseCmd, formatCmd, CMD_NAME_RE } from "../gw/commands.mjs";

test("拆：只认 description / argument-hint，别的项原样留着", () => {
  const c = parseCmd("---\ndescription: 整理议题\nargument-hint: \"<描述>\"\nallowed-tools: Bash(git:*)\n---\n正文 $ARGUMENTS\n");
  assert.equal(c.description, "整理议题");
  assert.equal(c.hint, "<描述>");
  assert.equal(c.extra, "allowed-tools: Bash(git:*)");
  assert.equal(c.body, "正文 $ARGUMENTS\n");
});

test("没有 frontmatter 的整个当正文", () => {
  const c = parseCmd("就一句话");
  assert.deepEqual([c.description, c.hint, c.body], ["", "", "就一句话"]);
});

test("合：拆完再合回去不变；带冒号、引号的说明会加引号", () => {
  const src = "---\ndescription: 整理议题\nargument-hint: <描述>\nallowed-tools: Bash(git:*)\n---\n正文 $ARGUMENTS\n";
  assert.equal(formatCmd(parseCmd(src)), src);
  const out = formatCmd({ description: "注意: 别乱写", hint: "", body: "x" });
  assert.match(out, /^---\ndescription: "注意: 别乱写"\n---\nx\n$/);
  assert.equal(parseCmd(out).description, "注意: 别乱写");
  assert.equal(formatCmd({ description: "", hint: "", body: "只有正文\n\n\n" }), "只有正文\n");
});

test("名字：字母数字 - _，不许路径和空格", () => {
  for (const ok of ["issue", "pr-review", "a_b", "X1"]) assert.ok(CMD_NAME_RE.test(ok), ok);
  for (const bad of ["../x", "a b", "-x", "", "a/b", "中文", "x".repeat(41)]) assert.ok(!CMD_NAME_RE.test(bad), bad);
});

test("编辑指令保留行尾注释以及引号、块标量里的井号", () => {
  for (const [line, value] of [
    ["周报 # 编辑者", "周报"],
    ['"a # b" # 编辑者', "a # b"],
    ["'it''s #1' # 编辑者", "it's #1"],
    ["C# # 编辑者", "C#"],
    ["| # 编辑者\n  一行 # 正文", "一行 # 正文"],
  ]) {
    const input = "---\ndescription: " + line + "\n---\n正文\n";
    const cmd = parseCmd(input);
    assert.equal(cmd.description, value);
    const saved = formatCmd({ ...cmd, description: "新说明" });
    assert.match(saved, /^description: 新说明 # 编辑者$/m);
    assert.equal(parseCmd(saved).description, "新说明");
  }
});

test("说明和参数提示中的 YAML 保留字写成字符串", () => {
  for (const value of ["true", "false", "Null", "NULL", "yes", "off"]) {
    const saved = formatCmd({ description: value, hint: value, body: "正文" });
    assert.ok(saved.includes("description: " + JSON.stringify(value) + "\n"));
    assert.ok(saved.includes("argument-hint: " + JSON.stringify(value) + "\n"));
    assert.equal(parseCmd(saved).hint, value);
  }
});

test("清空值但保留注释：注释仍钉在 key 行上，不漂成裸行", () => {
  // 值被用户清空、注释还在：写成「key:  # 注释」的空值行，读回来注释还在 key 上，位置不漂（11-19 复核）
  const src = "---\ndescription: # 只留注释\n---\n正文\n";
  const saved = formatCmd(parseCmd(src));
  assert.equal(saved, "---\ndescription:  # 只留注释\n---\n正文\n");
  const again = formatCmd({ ...parseCmd(saved), description: "新说明" });
  assert.match(again, /^description: 新说明 # 只留注释$/m);
  // 没有注释的空值照旧不写行
  assert.equal(formatCmd({ description: "", hint: "", body: "正文" }), "正文\n");
});

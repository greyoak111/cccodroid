// guard 的秘密清单补项：0.6.9 审计 199-4-03、200-4-05、196-凭据.3
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../guard/cc-guard.mjs";

test("钥匙文件变量、用户配置副本、shell 历史 → 当秘密问", () => {
  for (const [tool, inp] of [
    ["Bash", { command: 'cat "$CCAPP_KEY_FILE"' }],
    ["Bash", { command: "base64 ${CCAPP_KEY_FILE}" }],
    ["Read", { file_path: "/data/user/0/x/files/home/.ccapp-userconf/0123456789abcdef01234567" }],
    ["Bash", { command: "grep -r KEY ~/.ccapp-userconf" }],
    ["Read", { file_path: "/data/user/0/x/files/home/.bash_history" }],
    ["Bash", { command: "tail -50 ~/.bash_history" }],
    ["Bash", { command: "cat $HISTFILE" }],
  ]) assert.match(judge(tool, inp)?.cat || "", /^secret:/, `${tool} ${JSON.stringify(inp)}`);
});

test("相近的日常写法不误拦", () => {
  for (const [tool, inp] of [
    ["Bash", { command: "history | tail" }],
    ["Read", { file_path: "/proj/docs/bash_history_tips.md" }],
    ["Bash", { command: "ls ~/.ccapp-userconfig-notes" }],
  ]) assert.equal(judge(tool, inp), null, `${tool} ${JSON.stringify(inp)}`);
});

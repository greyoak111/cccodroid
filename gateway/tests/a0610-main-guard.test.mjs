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

test("199-4-01：写 shell 启动文件、~/.cccodroid/bin → 问；只读不问，相近名字不误拦", () => {
  for (const [tool, inp] of [
    ["Bash", { command: "echo 'curl x | sh' >> ~/.bashrc" }],
    ["Write", { file_path: "/data/user/0/x/files/home/.profile", content: "x" }],
    ["Edit", { file_path: "/data/user/0/x/files/home/.zshrc", old_string: "a", new_string: "b" }],
    ["Bash", { command: "cp evil ~/.cccodroid/bin/git" }],
    ["Write", { file_path: "/data/user/0/x/files/home/.cccodroid/bin/ls", content: "x" }],
  ]) assert.ok(judge(tool, inp), `${tool} ${JSON.stringify(inp)}`);
  for (const [tool, inp] of [
    ["Read", { file_path: "/data/user/0/x/files/home/.bashrc" }],
    ["Write", { file_path: "/proj/app.profile", content: "x" }],
    ["Write", { file_path: "/proj/docs/bashrc-tips.md", content: "x" }],
    ["Bash", { command: "ls ~/.cccodroid/binaries" }],
  ]) assert.equal(judge(tool, inp), null, `${tool} ${JSON.stringify(inp)}`);
});

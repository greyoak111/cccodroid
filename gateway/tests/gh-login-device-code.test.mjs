import test from "node:test";
import assert from "node:assert/strict";
import { parseGhDeviceOutput, ghLoginEnv } from "../gw/components.mjs";

test("parseGhDeviceOutput: 兼容剪贴板复制失败与复制成功两种 gh 设备码输出", () => {
  const failOut = [
    "! Failed to copy one-time code to clipboard",
    "! First copy your one-time code: A1B2-C3D4",
    "Open this URL to continue in your web browser: https://github.com/login/device",
  ].join("\n");
  assert.deepEqual(parseGhDeviceOutput(failOut), {
    code: "A1B2-C3D4",
    url: "https://github.com/login/device",
  });

  // 接入 app/pre/termux-clipboard-set 或桌面 pbcopy/xclip 后，gh 复制成功会输出括号格式
  const okOut = [
    "✓ One-time code (9F8E-7D6C) copied to clipboard",
    "Open this URL to continue in your web browser: https://github.com/login/device",
  ].join("\n");
  assert.deepEqual(parseGhDeviceOutput(okOut), {
    code: "9F8E-7D6C",
    url: "https://github.com/login/device",
  });

  // 带 ANSI 颜色转义序列时仍能提取
  const ansiOut = "\x1b[32m✓\x1b[0m One-time code (\x1b[1mDEAD-BEEF\x1b[0m) copied to clipboard\nhttps://github.com/login/device\n";
  assert.deepEqual(parseGhDeviceOutput(ansiOut), {
    code: "DEAD-BEEF",
    url: "https://github.com/login/device",
  });
});

test("ghLoginEnv: 剥离 PATH 中的 app/pre 避免 gh auth login 弹窗写剪贴板", () => {
  const env = ghLoginEnv({
    CCAPP_RUNTIME: "/data/user/0/cc.codroid/files",
    CCAPP_BIN: "/data/user/0/cc.codroid/files/app/bin",
    PATH: "/data/user/0/cc.codroid/files/app/pre:/data/user/0/cc.codroid/files/usr/bin:/data/user/0/cc.codroid/files/app/bin:/system/bin",
  });
  assert.equal(env.NO_COLOR, "1");
  assert.equal(
    env.PATH,
    "/data/user/0/cc.codroid/files/usr/bin:/data/user/0/cc.codroid/files/app/bin:/system/bin",
  );
});

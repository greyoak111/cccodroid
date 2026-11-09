// 11-09 群友提：查看器打开 .apk 只有「分享」，加一个「安装」。复用自更新的 PackageInstaller 通道（Apk.install）；
// 这条通道 Claude 和脚本也连得上，所以只在前台受理、先过应用自己的确认框（源码断言，壳侧要真机验）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PRIV = rd("android/java/cc/codroid/Priv.java");
const block = (() => { const i = PRIV.indexOf('case "apk_install": {'); assert.ok(i > 0); return PRIV.slice(i, PRIV.indexOf('case "usb_open"', i)); })();

test("应用侧：前台才受理；过分享同一道 guard；验的和装的是暂存的同一份；先确认再装；自己的新版本不走这里；留痕", () => {
  const at = (s) => { const i = block.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("if (!foreground())") < at("Apk.stage("), "后台直接拒，不拷不问");
  assert.ok(at("Share.guard(ctx, f)") < at("Apk.stage("));
  assert.ok(at("Apk.archiveInfo(ctx, staged)") < at("confirm(text, caller(pid)"));
  assert.ok(at("ctx.getPackageName().equals(pi.packageName)") < at("confirm(text"));
  assert.ok(at("confirm(text") < at('Apk.install(ctx, staged, "file")'), "确认在安装之前");
  assert.match(block, /endsWith\("\.apk"\)/);
  assert.match(block, /finally \{ if \(staged != null\) staged\.delete\(\); \}/);
  assert.match(PRIV, /op\.equals\("noask"\) \|\| op\.equals\("apk_install"\)\) \{/, "进特权命令记录");
  // confirm 只给「允许这一次」，不会被「10 分钟内不再问」带过去
  assert.match(PRIV, /static boolean confirm\(String text, String who, String key\) \{ return ask\(text, who, key, false\); \}/);
});

test("确认框按来路换成「安装应用」的标题和说明，不说成以 Shizuku 身份跑命令（11-09 真机看到的）", () => {
  assert.match(PRIV, /!trustable && key\.startsWith\("apk:"\) \? "apk"/);
  const ma = rd("android/java/cc/codroid/MainActivity.java");
  assert.match(ma, /"apk"\.equals\(i\.getStringExtra\("kind"\)\)\);/);
  assert.match(ma, /apk \? Tr\.t\("安装这个应用？"\)/);
  assert.match(ma, /: apk \? cmd \+ "\\n\\n" \+ Tr\.t\("点「允许」后还会弹出系统的安装确认。/);
});

test("安装结果：查看器装的给一句提示，用户取消不提示；不走更新页的状态", () => {
  const ev = rd("android/java/cc/codroid/Events.java");
  const i = ev.indexOf('if ("file".equals(what)) {');
  assert.ok(i > 0 && i < ev.indexOf("Updater.get(c).onInstallResult"));
  assert.match(ev.slice(i, i + 500), /STATUS_FAILURE_ABORTED[\s\S]*?Toast[\s\S]*?return;/);
});

test("网关只转 path 一个字符串字段；等确认的时间放长", () => {
  const d = rd("gateway/gw/devside.mjs");
  assert.match(d, /apk_install: \{ path: "string" \},/);
  assert.match(d, /"share_file", "apk_install",/);
  assert.match(d, /op === "apk_install" \? 120000/);
});

test("界面：只有 .apk 且在 cccodroid 里才出「安装」", () => {
  const v = rd("gateway/web/app/16-viewer-git.js");
  assert.match(v, /\$\{\/\\\.apk\$\/i\.test\(path\) && canShare\(\) \? `<button class="btn sm" data-a="apk">/);
  assert.match(v, /post\("\/api\/app\/apk_install", \{ path: p \}\)/);
  // 文件管理器里 .apk 归「压缩包」，预览栏走的是另一套按钮，也要有
  const f = rd("gateway/web/app/06-files.js");
  assert.match(f, /\$\{\/\\\.apk\$\/i\.test\(e\.name\) && canShare\(\) \? `<button class="btn sm" data-a="apk">/);
  assert.match(f, /querySelector\('\[data-a="apk"\]'\)\?\.addEventListener\("click", \(\) => vwInstallApk\(full\)\)/);
});

test("新文案都有 9 种译文", () => {
  for (const l of ["ar", "en", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"]) {
    const o = JSON.parse(rd(`android/assets/i18n/java-${l}.json`));
    for (const k of ["建不了暂存目录", "不是 .apk 文件", "不是有效的安装包", "cccodroid 自己的新版本请到「设置 → 更新」里装",
      "安装应用「{0}」\n包名 {1}\n版本 {2}\n\n文件：{3}", "没有允许，没有安装", "安装应用", "已安装", "安装失败：", "请先把 cccodroid 切到前台", "安装这个应用？",
      "点「允许」后还会弹出系统的安装确认。不是你自己点的「安装」、或者不认识这个安装包，就拒绝。"]) assert.ok(o[k], `${l} 缺 ${k}`);
  }
});

// 稳定性报告 FIND-025：音视频预览只有一个裸 <video>/<audio>，
// 文件读不出来、编解码不支持时既没有提示也没有分享入口，用户只看到一块空白。
// 媒体元素在 node 里跑不起来，锁源码里的分支行为（同 a0610 前端测试的做法）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src16 = fs.readFileSync(new URL("../web/app/16-viewer-git.js", import.meta.url), "utf8");

test("FIND-025 音视频预览挂 error 监听，失败换成说明和分享入口", () => {
  const a = src16.indexOf('if (VW.kind === "video" || VW.kind === "audio") {');
  assert.ok(a > 0, "找不到音视频分支");
  const b = src16.indexOf('\n    vwActs([]);\n    $("vw-body").innerHTML = `<div class="vw-empty">', a);
  assert.ok(b > a, "音视频分支边界找不到");
  const body = src16.slice(a, b);
  assert.ok(body.includes('querySelector("video,audio")'), "要拿到媒体元素");
  assert.match(body, /addEventListener\("error", \(\) => \{/);
  assert.ok(body.includes("vwFail(t(\"读取失败\"))"), "失败时走查看器统一的失败样式（带分享）");
  assert.ok(body.includes("viewerEl.classList.contains(\"hidden\")"), "关掉查看器后迟到的错误不许再写正文");
});

// 查看器里的压缩包浏览（会话内文件预览与文件管理器同款效果）：
// 聊天点开 .zip/.7z 等走 openViewer 的 archive 分支（以前只有「这种文件没有内置预览」兜底）。
// 包内行渲染函数从 16-viewer-git.js 里取真函数在 vm 里跑（同 f1 车道的取法）；其余按锚点钉住接线。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src16 = fs.readFileSync(new URL("../web/app/16-viewer-git.js", import.meta.url), "utf8");
const src06 = fs.readFileSync(new URL("../web/app/06-files.js", import.meta.url), "utf8");
const src17 = fs.readFileSync(new URL("../web/app/17-office.js", import.meta.url), "utf8");

test("包内一行：目录/文件都有图标、名字、大小，目录名带斜杠", () => {
  const a = src16.indexOf("function vwArcRow");
  const b = src16.indexOf("async function vwArcOpen", a);
  assert.ok(a > 0 && b > a, "vwArcRow 找不到");
  const ctx = {
    esc: (s) => "«" + s + "»",
    kindIcon: (k) => "[" + k + "]",
    fmtSize: (n) => n + "B",
  };
  vm.runInNewContext(src16.slice(a, b) + "\nglobalThis.__row = vwArcRow;", ctx);
  const row = ctx.__row;
  const d = row({ name: "子目录", dir: true, kind: "dir", size: 0 }, 0);
  assert.ok(d.includes("[dir]") && d.includes("«子目录»/") && !d.includes("0B"), "目录行没有大小：" + d);
  const f = row({ name: "读我.txt", kind: "text", size: 42 }, 3);
  assert.ok(f.includes("[text]") && f.includes("«读我.txt»") && f.includes("42B"), "文件行带大小：" + f);
  assert.ok(f.includes('data-i="3"'), "点击认领靠 data-i 下标：" + f);
  assert.ok(!f.includes("data-n="), "不再靠名字认领（含 \\r 的名字经 attribute 往返会失配）：" + f);
  assert.ok(!f.includes("/>"), "文件名后面不加斜杠");
});

test("接线：archive 分支、返回/解压/退出动作、会话复用与清理", () => {
  assert.ok(src16.includes('if (VW.kind === "archive") return vwArcOpen();'), "openViewer 有 archive 分支");
  assert.ok(src16.includes('[[t("返回压缩包"), "arcback"]]') && src16.includes("VW.arc.path !== VW.path"), "嵌套预览时顶栏放返回按钮");
  assert.ok(src16.includes('if (a === "arcback") return openViewer(VW.arc.path, "archive"'), "返回走 openViewer 全套清理");
  assert.ok(src16.includes("VW.arc.fileSize || VW.size"), "返回时标题栏用压缩包自己的大小，不用未压缩总量");
  assert.match(src16, /"arcback"[^\n]*archive: VW\.arc, filesOrigin: VW\.filesOrigin/, "返回显式传回原查看器压缩包会话");
  assert.ok(src16.includes('if (a === "arcall") return arcExtractDlg({ path: VW.arc.path, entries: null, arc: VW.arc });'), "全部解压带会话");
  assert.ok(src16.includes('if (a === "arcexit") return closeViewer();'), "退出压缩包=关查看器");
  assert.ok(src16.includes("VW.arc.path === VW.path && VW.arc.info"), "返回时不重读，复用已有会话");
  assert.ok(src16.includes("arc.entries[Number(row.dataset.i)]"), "点击按下标认领条目（不按名字）");
  assert.ok(src16.includes('r.kind === "archive" ? "other" : r.kind'), "包里的压缩包不再递归，当普通文件兜底");
  assert.ok(src17.includes("VW.arc = null"), "关查看器清掉压缩包会话");
});

test("接线：文件页解压对话框与任务条支持查看器会话", () => {
  assert.ok(src06.includes("async function arcExtractDlg({ path, entries, arc })"), "解压对话框接受外部会话");
  const job = src06.slice(src06.indexOf("async function arcRunJob("), src06.indexOf("function fsSetMulti("));
  assert.match(job, /origin\.here\(\) && VW\.path === origin\.arc\.path \? \$\("vw-arc-job"\)/, "进度条只在原包的查看器里按 id 重取");
  assert.match(job, /!origin\.arc && origin\.here\(\)/, "查看器发起的任务收尾不刷文件页");
  assert.match(job, /if \(pw != null && origin\.here\(\)\) \{\s*if \(origin\.archive\) origin\.archive\.password = pw;/, "密码重试只更新原会话");
});

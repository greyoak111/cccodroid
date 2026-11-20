// v0.7.12：会话里点 APK 直接走安装确认，不进压缩包浏览。用 node:vm 真执行 openPath 的分支（同 chat-frame-budget 的做法）。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const src = readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
const a = src.indexOf("async function openPath(p) {"), b = src.indexOf("const onPathLink = ", a);
assert.ok(a >= 0 && b > a);
const code = src.slice(a, b) + "\n({ openPath })";

function fixture(stat, { canShare = () => true } = {}) {
  const box = {
    api: async () => stat,
    toast: (msg) => { box.lastToast = msg; },
    t: (s) => s,
    canShare,
    openViewer: (path, kind, size) => { box.opened = { path, kind, size }; },
    vwInstallApk: (path) => { box.installed = path; },
    openFiles: (path) => { box.filesOpened = path; },
    closeViewer: () => {},
    VW: { dirty: false },
    $: () => ({ classList: { contains: () => false } }),
  };
  box.openPath = vm.runInNewContext(code, box).openPath;
  return box;
}

test("APK 点开走安装，不碰查看器", async () => {
  const b = fixture({ dir: false, kind: "archive", path: "/sdcard/Download/foo.apk", size: 1 });
  await b.openPath("/sdcard/Download/foo.apk");
  assert.equal(b.installed, "/sdcard/Download/foo.apk", "应调 vwInstallApk");
  assert.equal(b.opened, undefined, "不该开查看器");
});

test("别的压缩包照旧进查看器", async () => {
  const b = fixture({ dir: false, kind: "archive", path: "/sdcard/Download/foo.zip", size: 1 });
  await b.openPath("/sdcard/Download/foo.zip");
  assert.deepEqual(b.opened, { path: "/sdcard/Download/foo.zip", kind: "archive", size: 1 });
  assert.equal(b.installed, undefined);
});

test("非 cccodroid 产品（canShare=false）APK 仍进压缩包浏览", async () => {
  const b = fixture({ dir: false, kind: "archive", path: "/sdcard/Download/foo.apk", size: 1 }, { canShare: () => false });
  await b.openPath("/sdcard/Download/foo.apk");
  assert.equal(b.opened.kind, "archive");
  assert.equal(b.installed, undefined);
});

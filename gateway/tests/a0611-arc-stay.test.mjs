// 0.6.11 真机验出：在压缩包里预览完文件、关掉查看器，会被踢回压缩包所在的目录。
// 未改变时略过重列；压缩包变更时仍刷新包内当前层，而不是回到普通文件列表。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src06 = read("app/06-files.js");
const src17 = read("app/17-office.js");

test("fsLoad 确实会清掉压缩包状态（下面几条的前提）", () => {
  assert.match(src06, /async function fsLoad[\s\S]*?state\.fs\.arc = null;/);
});

test("关查看器：未改的压缩包不重列，变更时只刷新包内当前层", async () => {
  const body = src17.slice(src17.indexOf("function closeViewer()"), src17.indexOf('$("vw-close")'));
  assert.match(body, /fsViewerChanged\(origin, false\)/);
  const code = src06.slice(src06.indexOf("  async function fsViewerChanged("), src06.indexOf("  function fsSelect("));
  const stamp = { mtime: 100, size: 10 }, arc = { dir: "chapter" }, calls = [];
  let stat = stamp;
  const ctx = { api: async u => { assert.equal(u, "/api/file/stat?path=%2Fsynthetic%2Fa.zip"); return stat; },
    arcLoad: (dir, opts) => calls.push([dir, opts.keepSel, opts.keepQ, opts.stamp]),
    fsLoad: () => assert.fail("不能把用户踢出压缩包") };
  vm.runInNewContext(code, ctx);
  const origin = { here: () => true, path: "/synthetic/a.zip", stamp, arc };
  await ctx.fsViewerChanged(origin, false);
  assert.deepEqual(calls, []);
  stat = { mtime: 101, size: 10 };
  await ctx.fsViewerChanged(origin, false);
  assert.deepEqual(calls, [["chapter", true, true, stat]]);
});

test("进压缩包时清掉 qRemote：清过滤词不会回头 fsLoad", () => {
  const body = src06.slice(src06.indexOf("async function arcOpen("), src06.indexOf("async function arcLoad("));
  assert.ok(body.includes("state.fs.qRemote = false;"));
});

test("隐藏项开关在压缩包里不触发 fsLoad", () => {
  assert.ok(src06.includes('state.fs.hidden = e.target.checked; if (!state.fs.arc) fsLoad(state.fs.path);'));
});

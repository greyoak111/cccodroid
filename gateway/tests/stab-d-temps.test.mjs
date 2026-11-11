// FIND-016：原子写 / 导入 / 上传在换名前被结束，会留下隐藏临时文件；启动时清掉过期的
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { sweepTemps } from "../gw/statefile.mjs";

const dir = path.join(CFG.home, ".sweep-test");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("只清过期的隐藏临时文件，新鲜的、非临时的、目录都不动", () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 2 * 3600e3);
  const fresh = new Date();
  const mk = (name, age) => { const p = path.join(dir, name); fs.writeFileSync(p, "x"); fs.utimesSync(p, age, age); };
  mk(".ccapp-settings.json.tmp-123-abc", old);
  mk(".import-1700000000000.zip", old);
  mk(".part-1700000000000-1-abcd", old);
  mk(".ccapp-x.tmp-999-abc", fresh);   // 正在写的另一个进程：不动
  mk("visible.tmp-1", old);            // 不是隐藏文件
  mk(".keep", old);                    // 不是临时文件
  fs.mkdirSync(path.join(dir, ".dir.tmp-1"));
  assert.equal(sweepTemps([dir]), 3);
  assert.equal(fs.existsSync(path.join(dir, ".ccapp-settings.json.tmp-123-abc")), false);
  assert.equal(fs.existsSync(path.join(dir, ".import-1700000000000.zip")), false);
  assert.equal(fs.existsSync(path.join(dir, ".part-1700000000000-1-abcd")), false);
  assert.ok(fs.existsSync(path.join(dir, ".ccapp-x.tmp-999-abc")), "新鲜的不动");
  assert.ok(fs.existsSync(path.join(dir, "visible.tmp-1")));
  assert.ok(fs.existsSync(path.join(dir, ".keep")));
  assert.ok(fs.existsSync(path.join(dir, ".dir.tmp-1")));
});

test("目录不在也不抛", () => {
  assert.equal(sweepTemps([path.join(dir, "不存在")]), 0);
});

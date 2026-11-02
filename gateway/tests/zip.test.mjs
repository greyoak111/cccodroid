// 会话导入（gw/sessionops.mjs）：不是 zip 的文件快速拒绝，不从尾逐字节扫到头
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipRead } from "../gw/sessionops.mjs";

test("64MB 非 zip：很快报「不是 zip 文件」", () => {
  const buf = Buffer.alloc(64 << 20);   // 分配清零不算进去：全量跑时机器忙，光这一步就可能过 100ms
  const t0 = Date.now();
  assert.throws(() => zipRead(buf), /zip/);
  assert.ok(Date.now() - t0 < 100, `${Date.now() - t0}ms`);
});

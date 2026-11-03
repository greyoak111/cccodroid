// 终端 SSE 慢读者（审查 v0.5.20 02-004）：待发的堆过 8MB 就断开并移出订阅，正常读者照常收
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { _termForTest } from "../gw/terminal.mjs";
const { sseSend } = _termForTest;

// 假响应：write 返回 false（对端不读），待发字节只加不减；只计字节不留正文
const slow = () => ({ writableLength: 0, destroyed: false, write(s) { this.writableLength += Buffer.byteLength(s); return false; }, destroy() { this.destroyed = true; } });

test("冻住的订阅者：超过上限就断开、移出订阅；之后不再往它写", () => {
  const r = slow(), ok = { n: 0, writableLength: 0, write() { this.n++; return true; }, destroy() { throw new Error("正常读者不该被断"); } };
  const t = { subs: new Set([r, ok]) };
  const chunk = "x".repeat(512 * 1024);
  for (let i = 0; i < 40; i++) for (const s of t.subs) sseSend(s, "o", chunk, t);   // 共约 20MB
  assert.equal(r.destroyed, true);
  assert.equal(t.subs.has(r), false);
  assert.ok(r.writableLength < 9 * 1024 * 1024, `断开前最多堆到上限附近，实际 ${r.writableLength}`);
  assert.equal(ok.n, 40);
  assert.equal(t.subs.has(ok), true);
});

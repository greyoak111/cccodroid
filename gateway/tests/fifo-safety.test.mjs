// 同 uid 可写目录里的 FIFO 不能把网关事件循环卡死（审查 11-05）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";

const { _customForTest } = await import("../gw/custom.mjs");
const { compRecord } = await import("../gw/components.mjs");
const COMP_DIR = path.join(path.dirname(process.env.CCAPP_PREFIX), "components");

test("headOf / compRecord 遇到 FIFO 立即返回空，不阻塞", () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  fs.mkdirSync(COMP_DIR, { recursive: true });
  const a = path.join(CFG.workspace, "fifo-a"), b = path.join(COMP_DIR, "fifo-b.json");
  fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
  execFileSync("mkfifo", [a]); execFileSync("mkfifo", [b]);
  const t0 = Date.now();
  try {
    assert.equal(_customForTest.headOf(a, 100), "");
    assert.equal(compRecord("fifo-b"), null);
    assert.ok(Date.now() - t0 < 1500, "FIFO 读阻塞了");
  } finally { fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true }); }
});

// 文酱终审筛查收口补丁回归测试（cccodroid：P1-B / S-5）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { QUEUE, runnableQueueCount } from "../gw/queue.mjs";
import { RUNS } from "../gw/runs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("P1-B: archiver RUN7Z_OUT_MAX 恢复 256MB 且 previewEntry/startExtract 传 timeoutMs: 0", () => {
  const src = readRepo("gateway/gw/archiver.mjs");
  assert.match(src, /const RUN7Z_OUT_MAX = 256 << 20;/);
  assert.match(src, /previewEntry[\s\S]{0,160}archiveList\(file,\s*\{\s*enc,\s*password,\s*timeoutMs:\s*0\s*\}\)/);
  assert.match(src, /startExtract[\s\S]{0,200}archiveList\(file,\s*\{\s*enc,\s*password,\s*signal:\s*j\.ac\.signal,\s*timeoutMs:\s*0\s*\}\)/);
});

test("S-5: runnableQueueCount 区分空闲车道与运行中阻塞车道，且 exec-shim.c 0 warning 编译", () => {
  const prevQ = QUEUE.splice(0, QUEUE.length);
  const fakeRunId = "r-s5-active";
  const sidBusy = "55555555-6666-4777-8888-999999999999";
  const sidFree1 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const sidFree2 = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  RUNS.set(fakeRunId, { id: fakeRunId, sessionId: sidBusy, lane: "s:" + sidBusy, ended: false });
  try {
    QUEUE.push(
      { id: "q1", sessionId: sidBusy, message: "follow busy 1" },
      { id: "q2", sessionId: sidBusy, message: "follow busy 2" },
      { id: "q3", sessionId: sidFree1, message: "free 1a" },
      { id: "q4", sessionId: sidFree1, message: "free 1b" },
      { id: "q5", sessionId: sidFree2, message: "free 2", held: true },
    );
    assert.equal(runnableQueueCount(), 1);
  } finally {
    RUNS.delete(fakeRunId);
    QUEUE.splice(0, QUEUE.length, ...prevQ);
  }

  const shim = readRepo("android/native/exec-shim.c");
  assert.ok(shim.includes("__attribute__((aligned(8)))"));
  assert.ok(shim.includes("__builtin_memcpy(&mode, st + 16, sizeof(mode))"));
  const outObj = path.join(CFG.workspace, "sieve-exec-shim.o");
  try {
    for (const extra of [[], ["-DBIONIC"]]) {
      const r = spawnSync("clang", [
        "--target=aarch64-linux-android26",
        "-c", "-fPIC", "-nostdlib", "-O2", "-Wall", "-Wextra", "-Werror",
        ...extra,
        path.join(REPO, "android/native/exec-shim.c"), "-o", outObj,
      ], { encoding: "utf8" });
      if (!r.error) {
        assert.equal(r.status, 0, `clang 编译 exec-shim.c (${extra.join(" ") || "glibc"}) 应 0 warning/0 error: ${r.stderr}`);
      }
    }
  } finally {
    fs.rmSync(outObj, { force: true });
  }
});

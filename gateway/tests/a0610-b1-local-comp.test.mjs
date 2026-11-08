// 端侧模型与组件安装的几处回归（0.6.9 审计 195-F.5/F.7、#185、195-Z.11、195-T.4、#186、200-10-08）
import "../gw/config.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PREFIX } from "../gw/config.mjs";
import { COMP_DIR, compRecords, compRemove, reapComponentRuns, sha256File } from "../gw/components.mjs";
import { modManifest, modSpaceNeed } from "../gw/modules.mjs";
import { ensureLlama } from "../gw/local.mjs";

const FILES = path.dirname(PREFIX);
const dk = (sha) => fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: sha }));

// 同一轮测试共用临时 home：把本文件造的记录清掉，别影响后面的测试（components.test 会断言组件目录里没有 *.json）
after(() => {
  for (const id of ["inst", "broken", "old", "a", "b", "keytest"]) fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
  fs.rmSync(path.join(PREFIX, "libexec/devkit/components/broken"), { recursive: true, force: true });
  fs.rmSync(path.join(FILES, "big-cancel.bin"), { force: true });
  fs.rmSync(path.join(FILES, "manifest-test"), { recursive: true, force: true });
  fs.rmSync(path.join(FILES, "devkit-stage"), { recursive: true, force: true });
  for (const f of ["bin/shared", "bin/aonly", "bin/b"]) fs.rmSync(path.join(PREFIX, f), { force: true });
  fs.rmSync(path.join(CFG.home, "models"), { recursive: true, force: true });
});

test("sha256File：校验中途取消，下一个数据块就停（195-F.5）", async () => {
  const f = path.join(FILES, "big-cancel.bin");
  fs.writeFileSync(f, Buffer.alloc(8 << 20, 7));
  const job = { cancelled: false, done: 0 };
  const p = sha256File(f, job);
  setTimeout(() => { job.cancelled = true; }, 0);
  await assert.rejects(p, /cancelled/);
  assert.ok(job.done > 0 && job.done < (8 << 20), `done=${job.done}`);
});

test("compRecords：installing 也算使用者，坏记录按 MANIFEST 保守认领（#185 / 195-Z.11）", () => {
  dk("abc");
  fs.mkdirSync(COMP_DIR, { recursive: true });
  for (const f of ["inst.json", "broken.json", "old.json"]) fs.rmSync(path.join(COMP_DIR, f), { force: true });
  fs.writeFileSync(path.join(COMP_DIR, "inst.json"), JSON.stringify({ id: "inst", state: "installing", base: "abc", files: ["bin/inst"], shared: [] }));
  fs.writeFileSync(path.join(COMP_DIR, "broken.json"), "{oops");
  fs.writeFileSync(path.join(COMP_DIR, "old.json"), JSON.stringify({ id: "old", state: "ok", base: "other", files: ["bin/old"] }));
  const man = path.join(PREFIX, "libexec/devkit/components/broken");
  fs.mkdirSync(man, { recursive: true });
  fs.writeFileSync(path.join(man, "MANIFEST"), "h 1 bin/broken\n");
  const m = compRecords();
  assert.ok(m.has("inst"), "installing 记录要算");
  assert.ok(m.has("broken"), "读不出的记录按 MANIFEST 认领");
  assert.ok(!m.has("old"), "装在旧工具包上的不再认领");
});

test("卸载 A 时，B（安装中）声明的共享文件留下并转给 B（#185）", async () => {
  dk("abc");
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  for (const f of ["a.json", "b.json"]) fs.rmSync(path.join(COMP_DIR, f), { force: true });
  fs.writeFileSync(path.join(COMP_DIR, "a.json"), JSON.stringify({ id: "a", state: "ok", base: "abc", files: ["bin/shared", "bin/aonly"], shared: [], bin: [] }));
  fs.writeFileSync(path.join(COMP_DIR, "b.json"), JSON.stringify({ id: "b", state: "installing", base: "abc", files: ["bin/b"], shared: ["bin/shared"], bin: [] }));
  for (const f of ["bin/shared", "bin/aonly", "bin/b"]) fs.writeFileSync(path.join(PREFIX, f), "x");
  const r = await compRemove("a");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/shared")), "B 还要用的共享文件不能删");
  assert.ok(!fs.existsSync(path.join(PREFIX, "bin/aonly")), "A 独有的文件要删");
  const b = JSON.parse(fs.readFileSync(path.join(COMP_DIR, "b.json"), "utf8"));
  assert.ok(b.files.includes("bin/shared"), "留下来的文件要记到 B 名下");
});

test("启动时清掉上一任网关留下的组件子进程（195-T.4）", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  const dir = path.join(COMP_DIR, ".runs");
  fs.mkdirSync(dir, { recursive: true });
  const mark = path.join(dir, `test-${process.pid}.json`);
  fs.writeFileSync(mark, JSON.stringify({ pid: child.pid, cmd: process.execPath, args: "" }));
  const closed = new Promise((res) => child.once("close", (code, sig) => res({ code, sig })));
  const n = reapComponentRuns();
  assert.ok(n >= 1);
  const r = await Promise.race([closed, new Promise((res) => setTimeout(() => res(null), 3000))]);
  assert.ok(r, "子进程应当被结束");
  assert.ok(!fs.existsSync(mark), "运行标记要清掉");
});

test("钉住的端侧模型被删：报错，不静默换成最小模型（195-F.7）", async () => {
  const dir = path.join(CFG.home, "models");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "present.gguf");
  fs.writeFileSync(f, "");
  fs.truncateSync(f, 12 * 1024 * 1024);
  await assert.rejects(ensureLlama("gone-model", () => {}), /已经不在了/);
});

test("模块 MANIFEST：空/缺失不装，路径不能出包（200-10-08）", () => {
  const tree = path.join(FILES, "manifest-test");
  const dir = path.join(tree, "usr", "libexec/devkit/modules/x");
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => modManifest(tree, "libexec/devkit/modules/x"), /MANIFEST/);
  fs.writeFileSync(path.join(dir, "MANIFEST"), "h 1 ../../../etc/passwd\n");
  assert.throws(() => modManifest(tree, "libexec/devkit/modules/x"), /不合法的路径/);
  fs.writeFileSync(path.join(dir, "MANIFEST"), "abc 3 bin/x\n");
  assert.deepEqual(modManifest(tree, "libexec/devkit/modules/x"), [{ h: "abc", n: 3, rel: "bin/x" }]);
});

test("模块空间预检：已经留下的压缩包不再重复要（#186）", () => {
  const b = { id: "m1", gz: { bytes: 1000, sha256: "a".repeat(64) }, installed: 500 };
  const mj = { modules: [b] };
  const gz = path.join(path.dirname(PREFIX), "devkit-stage", `m1-${"a".repeat(12)}.tar.gz`);
  fs.rmSync(gz, { force: true });
  assert.equal(modSpaceNeed(mj, ["m1"]), 1500 * 1.1);
  fs.mkdirSync(path.dirname(gz), { recursive: true });
  fs.writeFileSync(gz, "");
  fs.truncateSync(gz, 1000);
  assert.equal(modSpaceNeed(mj, ["m1"]), 500 * 1.1);
});

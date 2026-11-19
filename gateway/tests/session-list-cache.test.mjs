import { CFG, PATHS } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const { listSessions, PINS } = await import("../gw/sessions.mjs");

test("5001 份历史：稳定刷新不冲刷 5000 项缓存，仍处理置顶、守护进程、重写和删除", () => {
  const old = PATHS.projects, root = fs.mkdtempSync(path.join(CFG.home, "list-fixture-"));
  const d = path.join(root, "project"), id = (i) => String(i).padStart(6, "0"), f = (i) => path.join(d, id(i) + ".jsonl");
  const rec = (kind) => JSON.stringify({ type: "user", parentUuid: null, sessionKind: kind, message: { content: "fixture" } }) + "\n";
  const scan = (label) => {
    const orig = fs.readSync; let reads = 0;
    fs.readSync = function(fd, buf, at, length, pos, ...args) { if (length === 65536 && pos === 0) reads++; return orig.call(this, fd, buf, at, length, pos, ...args); };
    try { const start = performance.now(), rows = listSessions(150), elapsed = Math.round(performance.now() - start); console.log(JSON.stringify({ label, reads, ms: elapsed, total: rows.total, returned: rows.length })); return { reads, rows }; }
    finally { fs.readSync = orig; }
  };
  try {
    PATHS.projects = root; fs.mkdirSync(d); const content = rec("normal");
    for (let i = 0; i < 5000; i++) fs.writeFileSync(f(i), i === 4999 ? rec("daemon") : content);
    fs.utimesSync(f(0), 1, 1); PINS[id(0)] = 1;
    const cold = scan("5000-cold"), warm = scan("5000-warm");
    assert.equal(cold.rows.total, 4999); assert.equal(warm.reads, 0);
    fs.writeFileSync(f(5000), rec("bg")); fs.utimesSync(f(5000), 2e9, 2e9);
    scan("5001-after-add"); const rounds = [scan("5001-warm-A"),scan("5001-warm-B"),scan("5001-warm-C")];
    for (const r of rounds) {
      assert.equal(r.rows.total, 5000); assert.equal(r.rows.length, 151);
      assert.ok(r.rows.some((x) => x.id === id(0)) && r.rows.some((x) => x.id === id(5000)));
      assert.ok(!r.rows.some((x) => x.id === id(4999))); assert.ok(r.reads <= 1, `${r.reads} 次分类读，不该因为只多一个文件而整表重读`);
    }
    // 相同长度、相同 mtime、换 inode：热点分类也必须作废。
    const replace = path.join(d, "rewrite.tmp"), stamp = fs.statSync(f(4999)).mtime;
    fs.writeFileSync(replace, content); fs.utimesSync(replace, stamp, stamp); fs.renameSync(replace, f(4999));
    assert.equal(scan("rewrite-classification").rows.total, 5001);
    fs.rmSync(f(4999)); assert.equal(scan("after-remove").rows.total, 5000); assert.equal(scan("5000-after-remove-warm").reads, 0);
  } finally { delete PINS[id(0)]; PATHS.projects = old; fs.rmSync(root, { recursive: true, force: true }); }
});

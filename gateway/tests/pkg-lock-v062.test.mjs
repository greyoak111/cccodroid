// pkg 的写操作都要先拿锁（#121-1：rm 这个别名漏了，两个 pkg rm 并发能把账本写坏）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("pkg 每个子命令要么在加锁名单里，要么是明确只读的（#121-1）", () => {
  const src = fs.readFileSync(new URL("../../android/assets/bin/pkg.mjs", import.meta.url), "utf8");
  const mut = JSON.parse(src.match(/const MUT = (\[[^\]]*\]);/)[1]);
  const i = src.indexOf("  switch (sub) {");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n  }\n", i));
  const all = [...new Set([...body.matchAll(/case "([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(all.includes("rm"), "没解析到子命令");
  // 只读：新增子命令时，会改东西的必须进 MUT，不能加到这里
  const READ_ONLY = ["list", "list-installed", "list-all", "search", "show", "info", "files", "verified"];
  for (const c of all) assert.ok(mut.includes(c) || READ_ONLY.includes(c), `子命令 ${c} 没加锁，也不在只读名单里`);
  for (const c of ["rm", "remove", "uninstall", "purge"]) assert.ok(mut.includes(c), c);
});

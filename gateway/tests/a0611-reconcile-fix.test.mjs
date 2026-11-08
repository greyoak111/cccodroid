// 0.6.11 真机：排障页「核对记录」报模块缺文件，其实全是 share/doc/*/copyright 断链（不算缺）；
// 用户 11-09 要「一键修补」：每条一个「修补」、顶部「全部修补」，网关按顺序重装、等做完、再核对。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";

const { fixPlan, reconcileNow, reconcileRun, routeReconcile } = await import("../gw/reconcile.mjs");

const f = (key, act, level = "error") => ({ key, level, k: key, v: null, fix: "", act });
test("排步骤：先模块、再组件，Claude Code 和工具包最后；同一个组件并成一步；info 和不能修的不排", () => {
  const F = [
    f("devkit", { t: "devkit" }), f("claude", { t: "claude" }),
    f("comp-files:a", { t: "comp", id: "a" }), f("comp-bin:a", { t: "comp", id: "a" }),
    f("mod-partial:m1", { t: "mod", id: "m1" }), f("comp-outdated:b", { t: "comp", id: "b" }, "info"),
    f("custom-files:x", null), f("comp-format:c", null),
  ];
  const s = fixPlan(F, "all");
  assert.deepEqual(s.map((x) => x.act.t + ":" + (x.act.id || "")), ["mod:m1", "comp:a", "claude:", "devkit:"]);
  assert.deepEqual(s[1].keys, ["comp-files:a", "comp-bin:a"]);
  assert.deepEqual(fixPlan(F, ["comp-bin:a"]).map((x) => x.act.id), ["a"], "只修选中的那条");
  assert.deepEqual(fixPlan(F, ["custom-files:x"]), [], "不能自动修的没有步骤");
});

test("要修工具包时，已装模块的缺文件交给工具包修复（它按已装的模块重装），没装完的模块照修", () => {
  const F = [f("devkit", { t: "devkit" }), f("mod-files:m1", { t: "mod", id: "m1" }), f("mod-files-list:m2", { t: "mod", id: "m2" }), f("mod-partial:m3", { t: "mod", id: "m3" })];
  assert.deepEqual(fixPlan(F, "all").map((x) => x.act.t + ":" + (x.act.id || "")), ["mod:m3", "devkit:"]);
});

test("动作形状不对的不排（缓存同 uid 能改）", () => {
  const F = [f("comp-files:../x", { t: "comp", id: "../x" }), f("z", { t: "rm-rf" }), f("y", "comp")];
  assert.deepEqual(fixPlan(F, "all"), []);
});

// ── 真走一遍：造一个已装模块，FILES 里一个文档断链、一个真缺的命令 ──
const DK = path.join(PREFIX, "libexec/devkit");
const STAGE = path.join(path.dirname(PREFIX), "devkit-stage");
const OK = path.join(PREFIX, ".devkit-ok");
const ID = "rcf0611";
const MODREL = `libexec/devkit/modules/${ID}`;
const BIN = `bin/${ID}-tool`, DOC = `share/doc/${ID}/copyright`;
const saved = fs.existsSync(OK) ? fs.readFileSync(OK, "utf8") : null;
const TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const SRC = fs.mkdtempSync(path.join(os.tmpdir(), "rcf0611-"));
const TOOL = "#!/bin/sh\necho ok\n";
const H = crypto.createHash("sha256").update(TOOL).digest("hex");
fs.mkdirSync(path.join(SRC, "usr", MODREL), { recursive: true });
fs.mkdirSync(path.join(SRC, "usr", "bin"), { recursive: true });
fs.writeFileSync(path.join(SRC, "usr", BIN), TOOL);
fs.writeFileSync(path.join(SRC, "usr", MODREL, "MANIFEST"), `${H} ${Buffer.byteLength(TOOL)} ${BIN}\n`);
fs.writeFileSync(path.join(SRC, "usr", MODREL, "FILES"), `${BIN}\n${DOC}\n`);
const GZFILE = path.join(SRC, `${ID}.tar.gz`);
const tarred = TAR ? spawnSync(TAR, ["-czf", GZFILE, "-C", SRC, "usr"], { encoding: "utf8" }) : null;
const GZ = tarred && tarred.status === 0 ? fs.readFileSync(GZFILE) : null;
const SHA = GZ ? crypto.createHash("sha256").update(GZ).digest("hex") : "";
const SKIP = !PREFIX ? "没有工具包前缀" : !TAR ? "环境里没有 tar" : !GZ ? "造不出测试包" : false;
if (!SKIP) {
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  const p = path.join(PREFIX, "bin", "tar");
  if (!fs.existsSync(p)) fs.symlinkSync(TAR, p);
}

after(() => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(path.join(PREFIX, MODREL), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, BIN), { force: true });
  fs.rmSync(path.join(PREFIX, "share/doc", ID), { recursive: true, force: true });
  if (GZ) {
    fs.rmSync(path.join(STAGE, ID), { recursive: true, force: true });
    fs.rmSync(path.join(STAGE, `${ID}-${SHA.slice(0, 12)}.tar.gz`), { force: true });
  }
  fs.rmSync(SRC, { recursive: true, force: true });
  if (saved == null) fs.rmSync(OK, { force: true });
  else fs.writeFileSync(OK, saved);
});

function call(method, p, body) {
  return new Promise((done) => {
    const req = { method, headers: {}, url: p, on(ev, fn) { if (ev === "data" && body) fn(Buffer.from(JSON.stringify(body))); if (ev === "end") fn(); return req; } };
    const res = { req, statusCode: 0, writeHead(c) { this.statusCode = c; }, end(b) { done({ code: this.statusCode, body: JSON.parse(String(b)) }); } };
    routeReconcile(req, res, new URL("http://x" + p), p);
  });
}

test("文档断链不算缺；真缺的命令照报，带模块「修补」；修补重装后再核就没了", { skip: SKIP }, async () => {
  fs.mkdirSync(DK, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk0611", base: "https://example.invalid/download/v1/" }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: ID, kind: "module", dir: MODREL, deps: ["base"], installed: 4096, name: { zh: "测试模块" },
      gz: { file: `${ID}.tar.gz`, bytes: GZ.length, sha256: SHA } },
  ] }));
  // 已装：.ok + MANIFEST + FILES；命令不在，文档是指向不存在许可证的断链
  fs.mkdirSync(path.join(PREFIX, MODREL), { recursive: true });
  fs.writeFileSync(path.join(PREFIX, MODREL, "MANIFEST"), "x\n");
  fs.writeFileSync(path.join(PREFIX, MODREL, "FILES"), `${BIN}\n${DOC}\n`);
  fs.writeFileSync(path.join(PREFIX, MODREL, ".ok"), "{}\n");
  fs.mkdirSync(path.join(PREFIX, "share/doc", ID), { recursive: true });
  fs.symlinkSync("../../LICENSES/Nope.txt", path.join(PREFIX, DOC));
  fs.rmSync(path.join(PREFIX, BIN), { force: true });

  const r = await reconcileNow();
  const mine = r.findings.filter((x) => x.key.endsWith(":" + ID));
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].key, "mod-files:" + ID);
  assert.deepEqual(mine[0].v.n, 1, "只有命令算缺，文档断链不算");
  assert.deepEqual(mine[0].samples, [BIN]);
  assert.deepEqual(mine[0].act, { t: "mod", id: ID });

  await reconcileRun();
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(path.join(STAGE, `${ID}-${SHA.slice(0, 12)}.tar.gz`), GZ);   // 已在暂存区，不用联网
  const start = await call("POST", "/api/reconcile/fix", { keys: ["mod-files:" + ID] });
  assert.equal(start.body.ok, true, JSON.stringify(start.body));
  assert.equal(start.body.steps.length, 1);
  let j;
  for (let i = 0; i < 400; i++) { j = (await call("GET", "/api/reconcile/fix")).body; if (!j.running) break; await new Promise((ok) => setTimeout(ok, 25)); }
  assert.equal(j.running, false, "修补要跑完");
  assert.equal(j.steps[0].state, "ok", JSON.stringify(j.steps));
  assert.equal(fs.readFileSync(path.join(PREFIX, BIN), "utf8"), TOOL, "命令按模块包重装回来");
  const again = (await call("GET", "/api/reconcile")).body;
  assert.ok(!again.findings.some((x) => x.key.endsWith(":" + ID)), "修补完自动再核，问题没了");

  const bad = await call("POST", "/api/reconcile/fix", { keys: "rm -rf" });
  assert.equal(bad.code, 400);
  const none = await call("POST", "/api/reconcile/fix", { keys: ["custom-files:zzz"] });
  assert.equal(none.body.ok, false, "没有能修的就不起任务");
});

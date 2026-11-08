// 200-14-06（第一轮 ecc02e7 已修，这里补回归）：模块 first-run 失败时不写 .ok ——
// 界面按「没装」显示，重装会再跑一遍；以前照样写 .ok，模块显示已装但没有配置，也没有重试入口。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
const STAGE = path.join(path.dirname(PREFIX), "devkit-stage");
const OK = path.join(PREFIX, ".devkit-ok");
const ID = "mfr0610";
const MODREL = `libexec/devkit/modules/${ID}`;
const saved = fs.existsSync(OK) ? fs.readFileSync(OK, "utf8") : null;
const TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const SH = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
const SRC = fs.mkdtempSync(path.join(os.tmpdir(), "mfr0610-"));
// 造一个真模块包：MANIFEST 里记 first-run.sh 的哈希，first-run 故意失败
const SCRIPT = "#!/bin/sh\nexit 3\n";
const H = crypto.createHash("sha256").update(SCRIPT).digest("hex");
fs.mkdirSync(path.join(SRC, "usr", MODREL), { recursive: true });
fs.writeFileSync(path.join(SRC, "usr", MODREL, "first-run.sh"), SCRIPT);
fs.writeFileSync(path.join(SRC, "usr", MODREL, "MANIFEST"), `${H} ${Buffer.byteLength(SCRIPT)} ${MODREL}/first-run.sh\n`);
const GZFILE = path.join(SRC, `${ID}.tar.gz`);
const tarred = TAR ? spawnSync(TAR, ["-czf", GZFILE, "-C", SRC, "usr"], { encoding: "utf8" }) : null;
const GZ = tarred && tarred.status === 0 ? fs.readFileSync(GZFILE) : null;
const SHA = GZ ? crypto.createHash("sha256").update(GZ).digest("hex") : "";
const SKIP = !TAR ? "环境里没有 tar" : !SH ? "环境里没有 sh" : !GZ ? "造不出测试包" : false;

function link(name, target) {
  const p = path.join(PREFIX, "bin", name);
  if (!fs.existsSync(p)) fs.symlinkSync(target, p);
}
if (!SKIP) { fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true }); link("tar", TAR); link("sh", SH); }

after(() => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(path.join(PREFIX, MODREL), { recursive: true, force: true });
  if (GZ) {
    fs.rmSync(path.join(STAGE, ID), { recursive: true, force: true });
    fs.rmSync(path.join(STAGE, `${ID}-${SHA.slice(0, 12)}.tar.gz`), { force: true });
  }
  fs.rmSync(SRC, { recursive: true, force: true });
  if (saved == null) fs.rmSync(OK, { force: true });
  else fs.writeFileSync(OK, saved);
});

test("模块 first-run 失败：安装报错、不写 .ok，文件留着等重装", { skip: SKIP }, async () => {
  fs.mkdirSync(DK, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk0610", base: "https://example.invalid/download/v1/" }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: ID, kind: "module", dir: MODREL, deps: ["base"], installed: 4096,
      gz: { file: `${ID}.tar.gz`, bytes: GZ.length, sha256: SHA } },
  ] }));
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(path.join(STAGE, `${ID}-${SHA.slice(0, 12)}.tar.gz`), GZ);   // 已在暂存区，不用联网

  const { modInstall, MOD_JOBS } = (await import("../gw/modules.mjs"))._modForTest;
  const r = await modInstall(ID);
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = MOD_JOBS.get(ID);
  for (let i = 0; i < 400 && !(job && job.finished); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(job && job.finished, "安装任务要跑完");
  assert.ok(job.error, "first-run 退出码非 0，安装应当失败");
  assert.match(job.error, /首次配置没跑完/);
  assert.ok(!fs.existsSync(path.join(PREFIX, MODREL, ".ok")), "失败时绝不能写 .ok");
  assert.ok(fs.existsSync(path.join(PREFIX, MODREL, "first-run.sh")), "文件照常搬进去，重装会再跑一遍");
});

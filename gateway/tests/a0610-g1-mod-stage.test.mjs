// 196-供应链.2：模块安装失败时，devkit-stage 里解开的树要当场删掉；
// 以前只有下次重装开头才会清，用户不再重试就一直占着（可能几百 MB）。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
const STAGE = path.join(path.dirname(PREFIX), "devkit-stage");
const GZ = Buffer.from("这不是一个 tar.gz —— 让解包那一步失败\n");
const SHA = crypto.createHash("sha256").update(GZ).digest("hex");
const TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const OK = path.join(PREFIX, ".devkit-ok");
const saved = fs.existsSync(OK) ? fs.readFileSync(OK, "utf8") : null;

fs.mkdirSync(DK, { recursive: true });
fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
if (TAR && !fs.existsSync(path.join(PREFIX, "bin", "tar"))) fs.symlinkSync(TAR, path.join(PREFIX, "bin", "tar"));

after(() => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(path.join(DK, "modules"), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, "modx"), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, `modx-${SHA.slice(0, 12)}.tar.gz`), { force: true });
  fs.rmSync(path.join(PREFIX, "bin", "tar"), { force: true });
  if (saved == null) fs.rmSync(OK, { force: true });
  else fs.writeFileSync(OK, saved);
});

test("模块安装失败：devkit-stage 解包树当场删掉", { skip: TAR ? false : "环境里没有 tar" }, async () => {
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk0610", base: "https://example.invalid/download/v1/" }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: "modx", kind: "module", dir: "libexec/devkit/modules/modx", deps: ["base"], installed: 4096,
      gz: { file: "modx.tar.gz", bytes: GZ.length, sha256: SHA } },
  ] }));
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(path.join(STAGE, `modx-${SHA.slice(0, 12)}.tar.gz`), GZ);   // 解包时必然失败，不用联网

  const { modInstall, MOD_JOBS } = (await import("../gw/modules.mjs"))._modForTest;
  const r = await modInstall("modx");
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = MOD_JOBS.get("modx");
  for (let i = 0; i < 400 && !(job && job.finished); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(job && job.finished, "安装任务要跑完");
  assert.ok(job.error, "垃圾压缩包应当安装失败");
  assert.ok(!fs.existsSync(path.join(STAGE, "modx")), "失败留下的解包树要删掉");
});

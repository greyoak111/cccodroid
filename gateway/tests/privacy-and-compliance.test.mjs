// 隐私与合规加固回归（网关与对应源码归档）：
//   1. gh-proxy 第三方代理兜底默认关闭，CFG.runtime 存在时以 files/.gh-proxy 为唯一真源；
//   2. remoteNotices 关闭仅停维护公告（notices.mjs），ccverified.mjs 改随自动更新（.upd-auto-off）门控；
//   3. devkit/archive-sources.mjs 全部 APK 内置项钉死 SHA-256，正确解析配方变量、拦截路径穿越并生成 SOURCES.lock.json；
//   4. 仓库根部隐私说明（PRIVACY.zh-CN.md / PRIVACY.md）与 Apache-2.0 许可证完整在位。
import { CFG } from "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SETTINGS, saveSettings } from "../gw/settings-store.mjs";
import { ghProxy, ghProxyEnabled } from "../gw/pget.mjs";
import {
  APK_BUNDLED_LGPL_SOURCES,
  requiresCorrespondingSource,
  safeArchiveFileName,
  parseTermuxRecipeSources,
  buildSourcePlan,
} from "../../devkit/archive-sources.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "privacy-compliance-"));

let noticeHits = 0, verifiedHits = 0;
const srv = http.createServer((req, res) => {
  if (req.url?.startsWith("/notices.json")) noticeHits++;
  if (req.url?.startsWith("/verified.json")) verifiedHits++;
  res.writeHead(404);
  res.end("not signed");
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

process.env.CCAPP_NOTICES_URL = `${BASE}/notices.json`;
process.env.CCAPP_CLAUDE_VERIFIED_URL = `${BASE}/verified.json`;
const { refreshNotices, routeNotices } = await import("../gw/notices.mjs");
const { refreshVerified, autoUpdateOff } = await import("../gw/ccverified.mjs");

test("ghProxy 默认关闭，且 CFG.runtime 下以 .gh-proxy 文件为唯一真源", () => {
  const flag = path.join(CFG.runtime, ".gh-proxy");
  fs.rmSync(flag, { force: true });
  SETTINGS.ghProxy = false;
  assert.equal(ghProxyEnabled(), false);
  assert.equal(ghProxy("https://github.com/org/repo/releases/download/v1/pkg.tar.gz"), "");

  // 即使内存中残留旧 SETTINGS.ghProxy = true，只要 .gh-proxy 文件已删（例如外壳/重置已关），也不得偷走代理
  SETTINGS.ghProxy = true;
  assert.equal(ghProxyEnabled(), false);

  fs.mkdirSync(CFG.runtime, { recursive: true });
  fs.writeFileSync(flag, "1\n");
  assert.equal(ghProxyEnabled(), true);
  assert.equal(
    ghProxy("https://github.com/org/repo/releases/download/v1/pkg.tar.gz"),
    "https://gh-proxy.com/github.com/org/repo/releases/download/v1/pkg.tar.gz"
  );
  assert.equal(ghProxy("https://example.com/pkg.tar.gz"), "");

  fs.rmSync(flag, { force: true });
  SETTINGS.ghProxy = false;
  assert.equal(ghProxyEnabled(), false);
});

test("remoteNotices 与自动更新（.upd-auto-off）解耦：关公告不废已知问题版本拦截，双关则零后台请求", async () => {
  const autoOffFlag = path.join(CFG.runtime, ".upd-auto-off");
  fs.mkdirSync(CFG.runtime, { recursive: true });
  fs.rmSync(autoOffFlag, { force: true });

  // 1. 仅关维护公告、保留自动更新：notices 零请求，ccverified 仍正常拉取安全拦截清单
  noticeHits = 0; verifiedHits = 0;
  SETTINGS.remoteNotices = false;
  saveSettings();

  await refreshNotices(true);
  assert.equal(noticeHits, 0, "关闭接收维护公告后 notices 不应发起请求");
  await refreshVerified(true);
  assert.ok(verifiedHits >= 1, "自动更新开启时，关闭维护公告不应停掉已知问题版本拦截清单");

  let status = 0, body = "";
  const req = { method: "GET", headers: {} };
  const res = {
    writeHead(s) { status = s; },
    end(b) { body = String(b || ""); },
  };
  await routeNotices(req, res, new URL("http://127.0.0.2/api/notices?lang=zh"), "/api/notices");
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.disabled, true);
  assert.deepEqual(parsed.items, []);
  assert.equal(noticeHits, 0);

  // 2. 同时关闭自动更新（写入 .upd-auto-off）：notices 与 ccverified 全部零请求
  noticeHits = 0; verifiedHits = 0;
  fs.writeFileSync(autoOffFlag, "1\n");
  assert.equal(autoUpdateOff(), true);
  await refreshNotices(true);
  await refreshVerified(true);
  assert.equal(noticeHits, 0);
  assert.equal(verifiedHits, 0, "关闭自动更新后 ccverified 不应发起请求");

  // 3. 恢复默认后允许请求
  fs.rmSync(autoOffFlag, { force: true });
  SETTINGS.remoteNotices = true;
  saveSettings();
  await refreshNotices(true);
  assert.ok(noticeHits >= 1);
});

test("archive-sources.mjs 钉死 SHA-256、_VERSION 展开、防路径穿越与参数校验", () => {
  for (const item of APK_BUNDLED_LGPL_SOURCES) {
    assert.match(item.sha256 || "", /^[0-9a-f]{64}$/, `${item.id} 必须钉死 64 位 SHA-256`);
  }
  assert.equal(requiresCorrespondingSource("GPL-3.0-only"), true);
  assert.equal(requiresCorrespondingSource("LGPL-2.1-or-later"), true);
  assert.equal(requiresCorrespondingSource("MIT AND GPL-2.0-or-later"), true);
  assert.equal(requiresCorrespondingSource("MPL-2.0"), true);
  assert.equal(requiresCorrespondingSource("-"), true);
  assert.equal(requiresCorrespondingSource(""), true);
  assert.equal(requiresCorrespondingSource("MIT"), false);
  assert.equal(requiresCorrespondingSource("Apache-2.0"), false);
  assert.equal(requiresCorrespondingSource("BSD-3-Clause"), false);

  assert.equal(safeArchiveFileName("https://ftpmirror.gnu.org/gnu/glibc/glibc-2.44.tar.xz"), "glibc-2.44.tar.xz");
  assert.throws(() => safeArchiveFileName("https://example.com/a/%2e%2e"), /非法归档文件名/);
  assert.throws(() => safeArchiveFileName("https://example.com/a/foo%2fbar.tar.xz"), /非法归档文件名/);
  assert.throws(() => safeArchiveFileName("https://example.com/a/"), /非法归档文件名/);

  const recipe = [
    'TERMUX_PKG_VERSION="9.5"',
    'TERMUX_PKG_SRCURL=https://ftp.gnu.org/gnu/coreutils/coreutils-${_VERSION}.tar.xz',
    'TERMUX_PKG_SHA256=CD328EDEAC92F6A665DE9F323C93B712AF1858BC2E0D88F3F7100469470A2F3A',
  ].join("\n");
  const srcs = parseTermuxRecipeSources(recipe, "9.5-1");
  assert.deepEqual(srcs, [{
    url: "https://ftp.gnu.org/gnu/coreutils/coreutils-9.5.tar.xz",
    sha256: "cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a2f3a",
  }]);

  const lockObj = {
    release: "devkit-2026.11.24",
    termuxRef: "deadbeef",
    packages: [
      { name: "bash", version: "5.2.37", license: "GPL-3.0", sha256: "aa" },
      { name: "openssl", version: "3.4.0", license: "Apache-2.0", sha256: "bb" },
      { name: "mystery", version: "1.0", license: "-", sha256: "cc" },
    ],
  };
  const plan = buildSourcePlan(lockObj);
  assert.equal(plan.apkBundled.length, APK_BUNDLED_LGPL_SOURCES.length);
  assert.deepEqual(plan.devkitPackages.map((p) => p.name), ["bash", "mystery"]);
  assert.match(plan.devkitPackages[0].rawBuildShUrl, /deadbeef\/packages\/bash\/build\.sh$/);
  assert.equal(buildSourcePlan(lockObj, { includeAll: true }).devkitPackages.length, 3);

  const missingArg = spawnSync(process.execPath, [path.join(REPO_ROOT, "devkit/archive-sources.mjs"), "--lock"], { encoding: "utf8" });
  assert.notEqual(missingArg.status, 0);
  assert.match(missingArg.stderr, /缺少取值/);

  const lockFile = path.join(TMP, "devkit.lock.json");
  const outDir = path.join(TMP, "sources-out");
  fs.writeFileSync(lockFile, JSON.stringify(lockObj));
  const dry = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "devkit/archive-sources.mjs"),
    "--lock", lockFile,
    "--out", outDir,
    "--dry-run",
  ], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  const outLock = JSON.parse(fs.readFileSync(path.join(outDir, "SOURCES.lock.json"), "utf8"));
  assert.equal(outLock.release, "devkit-2026.11.24");
  assert.equal(outLock.devkitPackages.length, 2);
});

test("隐私政策与 Apache-2.0 许可证文档完整性", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "PRIVACY.zh-CN.md")), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "PRIVACY.md")), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "LICENSE-APACHE-2.0")), false);
  const lic = fs.readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8");
  assert.match(lic, /Apache License[\s\S]*Version 2\.0/);
  const readmeZh = fs.readFileSync(path.join(REPO_ROOT, "README.zh-CN.md"), "utf8");
  const readmeEn = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readmeZh, /## 隐私与数据保护/);
  assert.match(readmeEn, /## Privacy & data protection/);
});

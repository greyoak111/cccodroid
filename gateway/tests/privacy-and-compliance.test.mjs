// 隐私与合规加固回归（网关与对应源码归档）：
//   1. gh-proxy 第三方代理兜底默认关闭（false），仅在显式开启或 files/.gh-proxy 存在时启用；
//   2. remoteNotices 关闭时，notices.mjs 与 ccverified.mjs 零网络请求且 GET /api/notices 返回 disabled: true；
//   3. devkit/archive-sources.mjs 正确分类 Copyleft 许可证、解析 Termux 配方并生成 SOURCES.lock.json；
//   4. 仓库根部隐私说明（PRIVACY.zh-CN.md / PRIVACY.md）与 Apache-2.0 许可证完整在位。
import { CFG } from "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SETTINGS, saveSettings } from "../gw/settings-store.mjs";
import { ghProxy, ghProxyEnabled } from "../gw/pget.mjs";
import {
  APK_BUNDLED_LGPL_SOURCES,
  requiresCorrespondingSource,
  parseTermuxRecipeSources,
  buildSourcePlan,
} from "../../devkit/archive-sources.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "privacy-compliance-"));

let hits = 0;
const srv = http.createServer((req, res) => {
  hits++;
  res.writeHead(404);
  res.end("not signed");
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

process.env.CCAPP_NOTICES_URL = `${BASE}/notices.json`;
process.env.CCAPP_CLAUDE_VERIFIED_URL = `${BASE}/verified.json`;
const { refreshNotices, routeNotices } = await import("../gw/notices.mjs");
const { refreshVerified } = await import("../gw/ccverified.mjs");

test("ghProxy 默认关闭，且同步受 SETTINGS.ghProxy 与 .gh-proxy 控制", () => {
  const flag = path.join(CFG.runtime, ".gh-proxy");
  fs.rmSync(flag, { force: true });
  SETTINGS.ghProxy = false;
  assert.equal(ghProxyEnabled(), false);
  assert.equal(ghProxy("https://github.com/org/repo/releases/download/v1/pkg.tar.gz"), "");

  SETTINGS.ghProxy = true;
  assert.equal(ghProxyEnabled(), true);
  assert.equal(
    ghProxy("https://github.com/org/repo/releases/download/v1/pkg.tar.gz"),
    "https://gh-proxy.com/github.com/org/repo/releases/download/v1/pkg.tar.gz"
  );
  assert.equal(ghProxy("https://example.com/pkg.tar.gz"), "");

  SETTINGS.ghProxy = false;
  fs.mkdirSync(CFG.runtime, { recursive: true });
  fs.writeFileSync(flag, "1\n");
  assert.equal(ghProxyEnabled(), true);
  fs.rmSync(flag, { force: true });
  assert.equal(ghProxyEnabled(), false);
});

test("remoteNotices 关闭时 notices 与 ccverified 零出站请求", async () => {
  hits = 0;
  SETTINGS.remoteNotices = false;
  saveSettings();

  await refreshNotices(true);
  await refreshVerified(true);
  assert.equal(hits, 0, "关闭接收维护公告后不应发起任何 HTTP 请求");

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
  assert.equal(hits, 0);

  // 重新打开后允许请求本地桩服务
  SETTINGS.remoteNotices = true;
  saveSettings();
  await refreshNotices(true);
  assert.ok(hits >= 1, "开启接收维护公告后应允许向配置的公告源发起请求");
});

test("archive-sources.mjs 许可证分类、配方解析与 --dry-run 归档清单", () => {
  assert.equal(requiresCorrespondingSource("GPL-3.0-only"), true);
  assert.equal(requiresCorrespondingSource("LGPL-2.1-or-later"), true);
  assert.equal(requiresCorrespondingSource("MIT AND GPL-2.0-or-later"), true);
  assert.equal(requiresCorrespondingSource("MPL-2.0"), true);
  assert.equal(requiresCorrespondingSource("-"), true);
  assert.equal(requiresCorrespondingSource(""), true);
  assert.equal(requiresCorrespondingSource("MIT"), false);
  assert.equal(requiresCorrespondingSource("Apache-2.0"), false);
  assert.equal(requiresCorrespondingSource("BSD-3-Clause"), false);

  const recipe = [
    'TERMUX_PKG_VERSION="9.5"',
    'TERMUX_PKG_SRCURL=https://ftp.gnu.org/gnu/coreutils/coreutils-${TERMUX_PKG_VERSION}.tar.xz',
    'TERMUX_PKG_SHA256=CD328EDEAC92F6A665DE9F323C93B712AF1858BC2E0D88F3F7100469470A2F3A',
  ].join("\n");
  const srcs = parseTermuxRecipeSources(recipe, "9.5-1");
  assert.deepEqual(srcs, [{
    url: "https://ftp.gnu.org/gnu/coreutils/coreutils-9.5.tar.xz",
    sha256: "cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a2f3a",
  }]);

  const lockObj = {
    release: "devkit-2026.11.24",
    packages: [
      { name: "bash", version: "5.2.37", license: "GPL-3.0", sha256: "aa" },
      { name: "openssl", version: "3.4.0", license: "Apache-2.0", sha256: "bb" },
      { name: "mystery", version: "1.0", license: "-", sha256: "cc" },
    ],
  };
  const plan = buildSourcePlan(lockObj);
  assert.equal(plan.apkBundled.length, APK_BUNDLED_LGPL_SOURCES.length);
  assert.deepEqual(plan.devkitPackages.map((p) => p.name), ["bash", "mystery"]);
  assert.equal(buildSourcePlan(lockObj, { includeAll: true }).devkitPackages.length, 3);

  const lockFile = path.join(TMP, "devkit.lock.json");
  const outDir = path.join(TMP, "sources-out");
  fs.writeFileSync(lockFile, JSON.stringify(lockObj));
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, "devkit/archive-sources.mjs"),
    "--lock", lockFile,
    "--out", outDir,
    "--dry-run",
  ], { stdio: "pipe" });
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

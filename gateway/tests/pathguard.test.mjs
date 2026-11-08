// 应用私有目录的判定（gw/pathguard.mjs）：按目录身份比，别名也认得（0.6.9 审计 P0-1 / P0-2）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG } from "../gw/config.mjs";
import { dataRoots, holdsPrivate, isPrivate, zoneOf } from "../gw/pathguard.mjs";
import { pathBlocked, routeFiles, safeWritePath } from "../gw/files.mjs";

// 本机真有的别名：测试临时目录在应用数据目录里（/data/user/0/<包名>/…），它在 /data/data/<包名>/… 下还有一个名字
const realTmp = fs.realpathSync(path.dirname(CFG.home));
const m = /^\/data\/user\/0\/([^/]+)(\/.*)$/.exec(realTmp);
const alias = (p) => p.replace(/^\/data\/user\/0\//, "/data/data/");
const haveAlias = !!m && fs.existsSync(alias(realTmp)) && fs.realpathSync(alias(realTmp)) !== realTmp;

/** 在 fn 运行期间把「应用数据目录」设成 dir */
async function withDataDir(dir, fn) {
  const old = process.env.CCAPP_DATA_DIR;
  process.env.CCAPP_DATA_DIR = dir;
  try { return await fn(); } finally { if (old == null) delete process.env.CCAPP_DATA_DIR; else process.env.CCAPP_DATA_DIR = old; }
}

test("home 里（工作区外）是私有；工作区放行；外面是公共", () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  assert.equal(zoneOf(fs.realpathSync(CFG.home)), "private");
  assert.equal(zoneOf(path.join(fs.realpathSync(CFG.home), "nope", "x.txt")), "private");   // 不存在的路径按存在的上级判
  assert.equal(zoneOf(fs.realpathSync(CFG.workspace)), "workspace");
  assert.equal(zoneOf("/system/etc"), "public");
});

test("装着私有目录的上级：holdsPrivate", () => {
  assert.equal(holdsPrivate(path.dirname(CFG.home)), true);
  assert.equal(holdsPrivate("/"), true);
  assert.equal(holdsPrivate(CFG.workspace), true);                        // 工作区本身也不能整个删
  assert.equal(holdsPrivate(CFG.workspace, { workspace: false }), false);
  assert.equal(holdsPrivate("/system"), false);
});

test("应用数据目录：别名一起算进来", { skip: !m && "不在安卓应用数据目录里跑" }, () => {
  withDataDir(`/data/user/0/${m[1]}`, () => {
    const roots = dataRoots();
    assert.ok(roots.includes(`/data/user/0/${m[1]}`));
    assert.ok(roots.includes(`/data/data/${m[1]}`));
  });
});

test("别名路径：/data/data/<包名>/… 和 /data/user/0/<包名>/… 判定一样", { skip: !haveAlias && "本机没有这对别名" }, async () => {
  await withDataDir(`/data/user/0/${m[1]}`, () => {
    const secret = path.join(fs.realpathSync(CFG.home), ".gateway-token");
    fs.writeFileSync(secret, "t");
    assert.equal(pathBlocked(secret), true);
    assert.equal(pathBlocked(alias(secret)), true, "别名写法也要拦");
    assert.equal(zoneOf(alias(fs.realpathSync(CFG.workspace))), "workspace", "工作区的别名照样放行");
    // 应用数据目录里、home 以外的兄弟目录（shared_prefs、app_webview…）：规范写法也要拦
    const sib = path.join(`/data/user/0/${m[1]}`, "shared_prefs");
    if (fs.existsSync(sib)) { assert.equal(isPrivate(sib), true); assert.equal(isPrivate(alias(sib)), true); }
    assert.equal(holdsPrivate(alias(path.dirname(fs.realpathSync(CFG.home)))), true, "别名写法的上级也认得");
    assert.ok(safeWritePath(path.join(alias(fs.realpathSync(CFG.home)), "x.json")).error, "别名写法不能往 home 里写");
    fs.rmSync(secret, { force: true });
  });
});

test("文件接口：别名路径读 home 里的文件 → 403", { skip: !haveAlias && "本机没有这对别名" }, async () => {
  await withDataDir(`/data/user/0/${m[1]}`, async () => {
    const f = path.join(fs.realpathSync(CFG.home), "secret-alias.txt");
    fs.writeFileSync(f, "S");
    const res = { code: 0, writeHead(c) { res.code = c; }, setHeader() {}, end() {} };
    const req = Readable.from([]); req.method = "GET"; req.headers = {};
    const u = new URL("http://x/api/file?path=" + encodeURIComponent(alias(f)));
    await routeFiles(req, res, u, "/api/file");
    assert.equal(res.code, 403);
    fs.rmSync(f, { force: true });
  });
});

test("项目：应用私有目录、它的别名、装着它的上级都不能登记成项目（P0-2）", async () => {
  const { routeProjects } = await import("../gw/projects.mjs");
  const call = async (dir) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ name: "t", mode: "dir", path: dir }))]);
    req.method = "POST"; req.headers = {};
    let code = 0; const res = { writeHead(c) { code = c; }, setHeader() {}, end() {} };
    await routeProjects(req, res, new URL("http://x/api/projects"), "/api/projects");
    return code;
  };
  const home = fs.realpathSync(CFG.home);
  assert.equal(await call(home), 403);
  assert.equal(await call(path.dirname(home)), 403, "home 的上级");
  if (haveAlias) {
    assert.equal(await call(alias(home)), 403, "home 的别名");
    await withDataDir(`/data/user/0/${m[1]}`, async () => {
      for (const d of ["shared_prefs", "app_webview", "databases"]) {
        const sib = `/data/user/0/${m[1]}/${d}`;
        if (fs.existsSync(sib)) { assert.equal(await call(sib), 403, sib); assert.equal(await call(alias(sib)), 403, alias(sib)); }
      }
    });
  }
});

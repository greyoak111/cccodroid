// 项目记忆纯只读查看：严格限死在 ~/.claude/projects/<slug>/memory/*.md，绝不放宽私有目录防线
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";
import { projectSlug, routeProjects } from "../gw/projects.mjs";
import { pathBlocked, routeFiles } from "../gw/files.mjs";

async function serve(handler) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const r = await handler(req, res, u, u.pathname);
    if (r === Symbol.for("next") || !res.writableEnded) { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const go = (p, opt) => fetch(base + p, opt);
  go.close = () => new Promise((ok) => srv.close(ok));
  return go;
}

async function createProj(go, prefix) {
  const dir = fs.mkdtempSync(path.join(CFG.workspace, prefix));
  const r = await go("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: prefix, mode: "dir", path: dir }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const proj = (await r.json()).project;
  const slug = projectSlug(fs.realpathSync(dir));
  const memDir = path.join(PATHS.projects, slug, "memory");
  return { dir, proj, slug, memDir };
}

test("项目记忆只读查看：列表排序、读取全文、不泄漏私有路径，且 /api/files 与 /api/file 仍 403", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const go = await serve(routeProjects);
  const { dir, proj, memDir } = await createProj(go, "mem-ok-");
  try {
    // 尚无 memory 目录时：返回空列表、单文件 404
    let r = await go(`/api/projects/${proj.id}/memory`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { files: [] });
    r = await go(`/api/projects/${proj.id}/memory?file=MEMORY.md`);
    assert.equal(r.status, 404);

    fs.mkdirSync(memDir, { recursive: true });
    const oldFile = path.join(memDir, "older.md");
    const newFile = path.join(memDir, "newer.md");
    const idxFile = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(oldFile, "# 旧记忆\n内容 A\n");
    fs.writeFileSync(newFile, "---\nname: newer\n---\n\n内容 B\n");
    fs.writeFileSync(idxFile, "- [newer](newer.md)\n");
    fs.writeFileSync(path.join(memDir, "ignore.txt"), "not markdown");
    fs.mkdirSync(path.join(memDir, "subdir.md"));
    fs.utimesSync(oldFile, new Date(1700000000000), new Date(1700000000000));
    fs.utimesSync(newFile, new Date(1710000000000), new Date(1710000000000));

    // 项目详情：memory 不包含私有绝对路径 path
    const detail = await (await go(`/api/projects/${proj.id}`)).json();
    assert.equal(detail.memory.length, 3);
    assert.equal("path" in detail.memory[0], false, "不应在详情里暴露私有目录绝对路径");
    assert.equal(detail.memory[0].file, "MEMORY.md");
    assert.equal(detail.memory[0].isIndex, true);
    assert.equal(detail.memory[1].file, "newer.md");
    assert.equal(detail.memory[2].file, "older.md");

    // 列表接口：仅直接 *.md 普通文件（跳过 .txt 和同名目录）
    const listRes = await (await go(`/api/projects/${proj.id}/memory`)).json();
    assert.deepEqual(listRes.files.map((x) => x.file), ["MEMORY.md", "newer.md", "older.md"]);

    // 单文件读取
    const oneRes = await go(`/api/projects/${proj.id}/memory?file=newer.md`);
    assert.equal(oneRes.status, 200);
    const one = await oneRes.json();
    assert.equal(one.file, "newer.md");
    assert.equal(one.name, "newer");
    assert.equal(one.isIndex, false);
    assert.equal(one.text, "---\nname: newer\n---\n\n内容 B\n");
    assert.equal("path" in one, false);

    // 确认私有目录防线毫发无损：pathBlocked 仍为 true，/api/files 与 /api/file 仍 403
    assert.equal(pathBlocked(fs.realpathSync(memDir)), true);
    assert.equal(pathBlocked(fs.realpathSync(newFile)), true);
    for (const [routePath, query] of [["/api/files", "path=" + encodeURIComponent(memDir)], ["/api/file", "path=" + encodeURIComponent(newFile)]]) {
      let code = 0;
      const res = { writeHead(c) { code = c; }, setHeader() {}, end() {} };
      const req = Readable.from([]); req.method = "GET"; req.headers = {};
      await routeFiles(req, res, new URL(`http://127.0.0.1${routePath}?${query}`), routePath);
      assert.equal(code, 403, `${routePath} 对私有记忆目录必须继续返回 403`);
    }
  } finally {
    await go(`/api/projects/${proj.id}`, { method: "DELETE" });
    fs.rmSync(memDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    await go.close();
  }
});

test("项目记忆安全防线：拒绝非 GET、路径穿越、非 .md、软链文件、软链目录、超大文件", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const go = await serve(routeProjects);
  const { dir, proj, slug, memDir } = await createProj(go, "mem-sec-");
  const secretFile = path.join(CFG.home, "secret-mem-test.md");
  const outsideDir = fs.mkdtempSync(path.join(CFG.workspace, "mem-out-"));
  try {
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(secretFile, "TOP_SECRET_TOKEN\n");
    fs.writeFileSync(path.join(outsideDir, "leak.md"), "OUTSIDE_LEAK\n");

    // 1. 严格纯只读：所有写方法一律 405
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await go(`/api/projects/${proj.id}/memory?file=a.md`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "overwrite" }),
      });
      assert.equal(r.status, 405, `${method} 必须返回 405`);
      assert.equal(r.headers.get("allow"), "GET");
    }

    // 2. 路径穿越与非法文件名一律 400
    for (const bad of ["", ".", "..", ".md", "../secret.md", "sub/a.md", "a\\b.md", "note.txt", "note.json", "a\x00.md", "a\nb.md"]) {
      const r = await go(`/api/projects/${proj.id}/memory?file=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `非法文件名 ${JSON.stringify(bad)} 必须返回 400`);
    }

    // 3. 软链文件：不出现在列表里，直接请求返回 403 且不泄漏目标内容
    fs.symlinkSync(secretFile, path.join(memDir, "evil.md"));
    const list = await (await go(`/api/projects/${proj.id}/memory`)).json();
    assert.equal(list.files.some((x) => x.file === "evil.md"), false);
    const viaLink = await go(`/api/projects/${proj.id}/memory?file=evil.md`);
    assert.equal(viaLink.status, 403);
    assert.equal((await viaLink.text()).includes("TOP_SECRET_TOKEN"), false);

    // 4. 目录冒充 .md：返回 403
    fs.mkdirSync(path.join(memDir, "dir.md"));
    const viaDir = await go(`/api/projects/${proj.id}/memory?file=dir.md`);
    assert.equal(viaDir.status, 403);

    // 5. 超过 1 MB 的记忆文件：返回 413
    fs.writeFileSync(path.join(memDir, "huge.md"), Buffer.alloc((1 << 20) + 16, 0x61));
    const hugeRes = await go(`/api/projects/${proj.id}/memory?file=huge.md`);
    assert.equal(hugeRes.status, 413);

    // 6. memory 目录本身被换成软链：列表返回空、读取返回 404 且不泄漏外部文件
    fs.rmSync(memDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, memDir);
    const symList = await (await go(`/api/projects/${proj.id}/memory`)).json();
    assert.deepEqual(symList, { files: [] });
    const symRead = await go(`/api/projects/${proj.id}/memory?file=leak.md`);
    assert.equal(symRead.status, 404);
    assert.equal((await symRead.text()).includes("OUTSIDE_LEAK"), false);

    // 7. <slug> 目录本身被换成软链：同样拒绝
    const slugDir = path.join(PATHS.projects, slug);
    fs.rmSync(slugDir, { recursive: true, force: true });
    const fakeSlugTarget = fs.mkdtempSync(path.join(CFG.workspace, "mem-slug-"));
    fs.mkdirSync(path.join(fakeSlugTarget, "memory"), { recursive: true });
    fs.writeFileSync(path.join(fakeSlugTarget, "memory", "leak.md"), "SLUG_LEAK\n");
    try {
      fs.symlinkSync(fakeSlugTarget, slugDir);
      const slugList = await (await go(`/api/projects/${proj.id}/memory`)).json();
      assert.deepEqual(slugList, { files: [] });
      const slugRead = await go(`/api/projects/${proj.id}/memory?file=leak.md`);
      assert.equal(slugRead.status, 404);
      assert.equal((await slugRead.text()).includes("SLUG_LEAK"), false);
    } finally {
      fs.rmSync(slugDir, { recursive: true, force: true });
      fs.rmSync(fakeSlugTarget, { recursive: true, force: true });
    }
  } finally {
    await go(`/api/projects/${proj.id}`, { method: "DELETE" });
    fs.rmSync(secretFile, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    await go.close();
  }
});

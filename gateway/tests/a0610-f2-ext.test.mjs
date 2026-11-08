// 0.6.10 审计 f2 车道：扩展域后端修复（J.1 / J.3 / J.4 / J.6 / J.10）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeExtensions, SKILLS_DIR } from "../gw/extensions.mjs";
import { routeCustom, _customForTest } from "../gw/custom.mjs";
import { commandRoutes } from "../gw/commands.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; },
    post: async (p, body, raw = false) => {
      const r = await fetch(base + p, { method: "POST", body: raw ? body : JSON.stringify(body), headers: raw ? {} : { "content-type": "application/json" } });
      return { status: r.status, body: await r.json() };
    },
  };
}
const go = await serve(routeExtensions, routeCustom, commandRoutes(() => []));
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");

test("J.1 用户级 hooks 配置文件可以只读查看，项目范围不接受任意目录", async () => {
  const file = path.join(CFG.home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{\n  "hooks": { "Stop": [] }\n}\n');
  const r = await go.get("/api/ext/hooks/file?scope=user");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.file, file);
  assert.match(r.body.text, /"Stop"/);
  const bad = await go.get("/api/ext/hooks/file?scope=project&dir=" + encodeURIComponent("/tmp/not-the-workspace"));
  assert.equal(bad.body.ok, false);
  // 前端不再用 /api/file 打开，改成读这个只读接口
  const src = fs.readFileSync(path.join(APP, "08-extensions.js"), "utf8");
  assert.match(src, /\/api\/ext\/hooks\/file\?scope=/);
  assert.doesNotMatch(src, /a === "open-file"\) \{ const sc = hkScopeData\(\); return openViewer/);
});

test("J.10 没有 SKILL.md 的同名目录会列出来，能删掉", async () => {
  const d = path.join(SKILLS_DIR, "zz-orphan-skill");
  fs.mkdirSync(d, { recursive: true });
  const r = await go.get("/api/ext/skills");
  assert.equal(r.status, 200);
  const it = (r.body.items || []).find((x) => x.dir === "zz-orphan-skill");
  assert.ok(it, "孤儿目录没列出来");
  assert.equal(it.orphan, true);
  const del = await go.post("/api/ext/skills/delete", { dir: "zz-orphan-skill" });
  assert.equal(del.body.ok, true);
  assert.equal(fs.existsSync(d), false);
});

test("J.6 /api/commands 告诉界面是否发行版（插入时加 /user: 前缀）", async () => {
  const r = await go.get("/api/commands");
  assert.equal(r.status, 200);
  assert.equal(r.body.sealed, true);
  const src = fs.readFileSync(path.join(APP, "08-extensions.js"), "utf8");
  assert.match(src, /UC\.data\.sealed \? "\/user:" : "\/"/);
});

test("J.3 上传的文件按用户原名显示，不带随机十六进制前缀、中文不变下划线", async () => {
  const r = await go.post("/api/custom/upload?name=" + encodeURIComponent("工具.sh"), "#!/bin/sh\necho hi\n", true);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.name, "工具.sh");
  assert.equal(r.body.source, "工具.sh");
  assert.doesNotMatch(r.body.source, /^[0-9a-f]{8}-/);
  // J.4：网关重启后内存里的暂存表没了，安装仍能从盘上的 report.json 接回来
  const stage = r.body.stage;
  assert.match(stage, /^[0-9a-f]{12}$/);
  const prog = r.body.programs[0];
  _customForTest.CUSTOM_STAGES.delete(stage);
  const ins = await go.post("/api/custom/install", { stage, id: "f2-test", name: "F2", entries: [{ rel: prog.rel, cmd: "f2-hello" }] });
  assert.equal(ins.body.ok, true, JSON.stringify(ins.body));
  assert.equal(fs.existsSync(path.join(CFG.home, ".cccodroid", "bin", "f2-hello")), true);
  const rm = await go.post("/api/custom/remove", { id: "f2-test" });
  assert.equal(rm.body.ok, true);
});

test("J.4 暂存过期 / 目录没了时给出可理解的提示", async () => {
  const ins = await go.post("/api/custom/install", { stage: "0123456789ab", id: "nope", entries: [] });
  assert.equal(ins.body.ok, false);
  assert.match(ins.body.message, /分析结果过期/);
});

test("J.7 hooks 试运行按界面的默认 60 秒、上限 600 秒（源码）", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw", "extensions.mjs"), "utf8");
  assert.match(src, /Math\.min\(600, Number\(timeout\) \|\| 60\)/);
});

test("197-1.4 用户 commands 目录里的 .md 软链不会被当成指令读出来", async () => {
  const dir = path.join(CFG.home, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  const secret = path.join(CFG.home, "secret-note.md");
  fs.writeFileSync(secret, "SECRET-BODY");
  fs.symlinkSync(secret, path.join(dir, "leak.md"));
  fs.writeFileSync(path.join(dir, "ok.md"), "---\ndescription: fine\n---\nhello\n");
  const r = await go.get("/api/commands");
  assert.equal(r.status, 200);
  const user = r.body.scopes.find((s) => s.scope === "user");
  assert.ok(user.items.some((i) => i.name === "ok"));
  assert.ok(!user.items.some((i) => i.name === "leak"), "软链指令被列出来了");
  assert.doesNotMatch(JSON.stringify(r.body), /SECRET-BODY/);
});

test("197-2.9 内置 hook 脚本装不上时接口回 ok:false，前端不再当已保存", async () => {
  const p = path.join(CFG.home, ".claude", "hooks");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  fs.writeFileSync(p, "占住路径");   // 让 mkdirSync 失败
  const r = await go.post("/api/ext/hooks/scripts", {});
  assert.equal(r.body.ok, false);
  assert.ok(r.body.message);
  const src = fs.readFileSync(path.join(APP, "08-extensions.js"), "utf8");
  assert.match(src, /内置脚本没装上：\{msg\}，规则没有保存/);
});

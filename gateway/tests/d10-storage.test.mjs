// D10 第 2 步（11-09）：存储清理。只删写死的那几类；有进程开着、会话在跑的不删；删之前核真实位置；自动清理按频次、只在空闲时
import { CFG, PATHS, PREFIX } from "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS } from "../gw/settings-store.mjs";
import { RUNS } from "../gw/runs.mjs";
import { AUTO_EVERY, autoCleanCfg, autoCleanTick, cleanStorage, rmChecked, scanStorage } from "../gw/storage.mjs";

const DAY = 86400e3;
const H = (...r) => path.join(CFG.home, ...r);
const TMP = path.join(PREFIX, "tmp"), CT = path.join(TMP, "claude-" + process.getuid());
const made = [];
const put = (f, s = "x", ageDays = 0) => {
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s);
  if (ageDays) { const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(f, t, t); }
  made.push(f); return f;
};
const age = (p, d) => { const t = new Date(Date.now() - d * DAY); fs.utimesSync(p, t, t); };
const ex = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const prevAuto = SETTINGS.autoClean;
after(() => {
  SETTINGS.autoClean = prevAuto;
  for (const d of [path.join(TMP, "d10"), CT, H(".npm"), H(".cache", "gh"), H(".cache", "pip"), H(".claude", "debug"), H(".claude", "backups"),
    H(".claude", "shell-snapshots"), H(".cache", "claude-cli-nodejs"), H("d10-out"), H("ccapp-storage.json")]) fs.rmSync(d, { recursive: true, force: true });
  for (const f of made) fs.rmSync(f, { force: true });
});

test("rmChecked：只删允许目录里面的；目录本身、外面的、软链指出去的目标、永不碰的都不删", () => {
  const root = H(".cache", "gh");
  const inside = put(path.join(root, "a", "b.json"));
  const outside = put(H("d10-out", "keep.txt"));
  fs.symlinkSync(H("d10-out"), path.join(root, "esc"));
  assert.equal(rmChecked(root, [root]).ok, false, "目录本身不删");
  assert.equal(rmChecked(outside, [root]).why, "outside");
  assert.equal(rmChecked(path.join(root, "..", "..", "d10-out", "keep.txt"), [root]).why, "outside", "../ 跳出去的按真实位置算");
  assert.equal(rmChecked(path.join(root, "esc", "keep.txt"), [root]).why, "outside", "经软链进到外面的不删");
  assert.equal(rmChecked(path.join(root, "esc"), [root]).ok, true, "软链本身可以删");
  assert.ok(ex(outside), "软链指向的东西还在");
  const key = put(path.join(root, "ccapp-key-x"));
  assert.equal(rmChecked(key, [root]).why, "protected");
  assert.equal(rmChecked(H(".ssh"), [CFG.home]).why, "protected");
  assert.equal(rmChecked(inside, [root]).ok, true);
});

test("临时文件：7 天没动的删；目录里有新文件的、有进程开着的、会话还在跑 / 排队的不删；勾选的照样过这几道", async () => {
  const d = path.join(TMP, "d10");
  const old = put(path.join(d, "old.log"), "o", 9);
  const fresh = put(path.join(d, "fresh.log"), "f", 1);
  const mixed = path.join(d, "mixed"); put(path.join(mixed, "a"), "a", 30); put(path.join(mixed, "b"), "b", 2); age(mixed, 30);
  const held = put(path.join(d, "held.log"), "h", 20);
  age(d, 20);
  const fd = fs.openSync(held, "r");
  const sidLive = "11111111-2222-3333-4444-555555555555", sidOld = "66666666-7777-8888-9999-000000000000";
  const live = path.join(CT, "-proj", sidLive), dead = path.join(CT, "-proj", sidOld);
  put(path.join(live, "tasks", "x.output"), "L", 10); age(path.join(live, "tasks"), 10); age(live, 10);
  put(path.join(dead, "tasks", "y.output"), "D".repeat(100), 10); age(path.join(dead, "tasks"), 10); age(dead, 10);
  RUNS.set("d10-run", { id: "d10-run", sessionId: sidLive });
  try {
    // 顶层 d10 目录里有新文件：整个不算「7 天没动」，按规则不删；里面的要靠勾选（勾的是顶层条目）
    const r = await cleanStorage(["tmp"]);
    assert.ok(ex(old) && ex(fresh), "d10 里有新文件，整格不动");
    assert.ok(ex(live), "在跑的会话的不删");
    assert.ok(!ex(dead), "7 天前、会话不在跑的删了");
    assert.ok(r.freed >= 100);
    // 勾选 d10：里面有开着的文件，不删
    await cleanStorage(["tmp"], { picks: ["d10"] });
    assert.ok(ex(held), "有进程开着的不删（勾了也不删）");
    fs.closeSync(fd);
    await cleanStorage(["tmp"], { picks: ["d10", "claude-" + process.getuid() + "/-proj/" + sidLive] });
    assert.ok(!ex(d), "关掉以后勾选能删，新文件也一起");
    assert.ok(ex(live), "勾了在跑的会话也不删");
  } finally { RUNS.delete("d10-run"); try { fs.closeSync(fd); } catch {} }
});

test("claude 杂物：30 天前的 debug / shell 快照 / MCP 日志删，新的留；.claude.json 备份留最新 5 份", async () => {
  const dOld = put(H(".claude", "debug", "aaaa.txt"), "x", 40), dNew = put(H(".claude", "debug", "bbbb.txt"), "x", 3);
  fs.symlinkSync(dOld, H(".claude", "debug", "latest"));
  const sOld = put(H(".claude", "shell-snapshots", "snapshot-bash-1.sh"), "x", 31), sNew = put(H(".claude", "shell-snapshots", "snapshot-bash-2.sh"), "x", 1);
  const mOld = put(H(".cache", "claude-cli-nodejs", "-p", "mcp-logs-x", "1.txt"), "x", 45), mNew = put(H(".cache", "claude-cli-nodejs", "-p", "mcp-logs-x", "2.txt"), "x", 2);
  const backs = []; for (let i = 0; i < 7; i++) backs.push(put(H(".claude", "backups", `.claude.json.backup.${1000 + i}`), "b", 7 - i));
  await cleanStorage(["junk"]);
  assert.ok(!ex(dOld) && ex(dNew));
  assert.ok(ex(H(".claude", "debug", "latest")), "latest 软链不动");
  assert.ok(!ex(sOld) && ex(sNew));
  assert.ok(!ex(mOld) && ex(mNew));
  assert.deepEqual(backs.map(ex), [false, false, true, true, true, true, true], "最旧的两份删了");
});

test("缓存：写死的目录里的文件删、目录结构留；10 分钟内写的不删；~/.cache 里的密钥文件不在范围里", async () => {
  const npmOld = put(H(".npm", "_cacache", "content-v2", "aa", "f"), "x".repeat(50), 2);
  const npmNow = put(H(".npm", "_cacache", "tmp", "now"), "x");
  const pip = put(H(".cache", "pip", "http", "a"), "x", 1);
  const key = put(H(".cache", "ccapp-key-d10"), "secret", 90);
  const r = await cleanStorage(["cache"]);
  assert.ok(!ex(npmOld) && ex(path.dirname(npmOld)), "文件删了，目录留着");
  assert.ok(ex(npmNow), "刚写的不删");
  assert.ok(!ex(pip));
  assert.ok(ex(key), "密钥不碰");
  assert.ok(r.cats.cache >= 50);
});

test("扫描：六类都有；会话按大小列；临时文件列出哪些按规则会删", async () => {
  put(path.join(TMP, "d10", "big.bin"), "z".repeat(4096), 10); age(path.join(TMP, "d10"), 10);
  const s = await scanStorage();
  for (const k of ["cache", "tmp", "junk", "sessions", "programs", "entries", "device", "retention"]) assert.ok(s[k] !== undefined, k);
  const row = s.tmp.top.find((x) => x.rel === "d10");
  assert.ok(row && row.auto && row.bytes >= 4096);
  assert.ok(Array.isArray(s.sessions.top));
  assert.ok(typeof s.entries.trash.count === "number");
  assert.ok(fs.existsSync(H("ccapp-storage.json")), "结果存盘");
});

test("自动清理：默认开、每周；关了不跑；没到期不跑；有在跑的不跑；到期空闲时跑并记下时间", async () => {
  SETTINGS.autoClean = undefined;
  assert.deepEqual(autoCleanCfg(), { enabled: true, every: "week" });
  SETTINGS.autoClean = { enabled: true, every: "bogus" };
  assert.equal(autoCleanCfg().every, "week");
  SETTINGS.autoClean = { enabled: false, every: "day" };
  assert.equal(await autoCleanTick(), null);
  SETTINGS.autoClean = { enabled: true, every: "day" };
  const t = Date.now() + 400 * DAY;
  RUNS.set("d10-busy", { id: "d10-busy", sessionId: null });
  assert.equal(await autoCleanTick(t), null, "有在跑的不跑");
  RUNS.delete("d10-busy");
  const r = await autoCleanTick(t);
  assert.ok(r && r.auto);
  assert.equal(await autoCleanTick(t + AUTO_EVERY.day - 1000), null, "刚跑过、没到期");
  const st = JSON.parse(fs.readFileSync(H("ccapp-storage.json"), "utf8"));
  assert.ok(st.lastAuto > 0 && st.history.some((h) => h.auto));
});

// 0.6.9 审计 P1-5（v4pro 复核指出没修）：补档 / 自动起名的 claude 刚起就退出、没读提示，写 stdin 撞 EPIPE
// 不能变成没人接的 error（crashguard 会把它当「上游管道断了」让整个网关退出）。用假 CLI：一行不读、立刻退出，提示写大到塞满管道
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "a0610-bf-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.writeFileSync(cli, `#!${sh}\nexec 0<&-\nexit 1\n`, { mode: 0o700 });
const prev = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { SETTINGS } = await import("../gw/settings-store.mjs");
const prevCompat = SETTINGS.staticCompat;
SETTINGS.staticCompat = false;
const { ask } = await import("../gw/backfill.mjs");
const { PROVIDER } = await import("../gw/providers.mjs");
after(() => { Object.assign(PATHS, prev); SETTINGS.staticCompat = prevCompat; fs.rmSync(root, { recursive: true, force: true }); });

test("claude 一行不读就退出：ask 报错返回，不抛出没人接的 EPIPE", async () => {
  const errs = [];
  const onErr = (e) => errs.push(e);
  process.on("uncaughtException", onErr);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await ask("提示".repeat(2 << 20), { provider: PROVIDER, model: "fixture" });
      assert.ok(r.error, JSON.stringify(r).slice(0, 200));
    }
    await new Promise((r) => setTimeout(r, 200));
  } finally { process.off("uncaughtException", onErr); }
  assert.deepEqual(errs.map((e) => e.code || e.message), []);
});

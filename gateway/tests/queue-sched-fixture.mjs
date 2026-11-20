import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const NOW = Date.UTC(2026, 10, 20, 9, 0, 1);
export const AT = NOW - 1000;
export const MARK = "ccapp-run-mark.json", INTR = "ccapp-interrupted.json";
export const DB = "ccapp-sched.json", LOG = "ccapp-sched-runs.json";
const gw = new URL("../gw/", import.meta.url).href;

// Each boot is a fresh module graph over the same synthetic home. No live startup,
// test CLI, or network is needed to observe checkpoints and held queue state.
export function fixture(t, { sched = false, queueFirst = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-sched-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (file, data) => fs.writeFileSync(path.join(home, file), JSON.stringify(data));
  const boot = (code) => {
    const runtimeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:LD_|ANDROID_|TERMUX_)/.test(k)));
    const env = {
      ...runtimeEnv, HOME: home, CCAPP_HOME: home, CCAPP_TEST: "1", CCAPP_TMP: home, TMPDIR: home, TZ: "UTC", PATH: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
      CCAPP_WORKSPACE: path.join(home, "workspace"), CCAPP_RUNTIME: path.join(home, "runtime"),
      CCAPP_PREFIX: path.join(home, "prefix"), CCAPP_CLAUDE: path.join(home, "does-not-exist"),
    };
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import net from 'node:net';
      import path from 'node:path';
      import { Readable } from 'node:stream';
      globalThis.fetch = net.Socket.prototype.connect = () => { throw new Error('unexpected connection from fixture'); };
      const NOW = ${NOW}, AT = ${AT};
      Date.now = () => NOW;
      const gw = ${JSON.stringify(gw)};
      if (!${queueFirst}) await import(new URL('providers.mjs', gw));
      const Q = await import(new URL('queue.mjs', gw));
      const { _schedForTest: S, routeSched } = ${sched} ? await import(new URL('sched.mjs', gw)) : {};
      const { RUNS, maxParallel } = await import(new URL('runs.mjs', gw));
      const { onPublish } = await import(new URL('bus.mjs', gw));
      const MARK = ${JSON.stringify(MARK)}, INTR = ${JSON.stringify(INTR)}, DB = ${JSON.stringify(DB)}, LOG = ${JSON.stringify(LOG)};
      const get = (file) => JSON.parse(fs.readFileSync(file));
      const openSession = (sid) => {
        fs.mkdirSync('.claude/projects/fixture', { recursive: true });
        fs.writeFileSync(path.join('.claude/projects/fixture', sid + '.jsonl'), '{}\\n');
      };
      const failingRename = (files) => {
        const previous = fs.renameSync;
        fs.renameSync = (a, b) => {
          if (files(path.basename(b), a)) throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
          return previous(a, b);
        };
        return () => { fs.renameSync = previous; };
      };
      async function route(fn, method, url, payload, expected = 200) {
        const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method, headers: {} });
        let status, out;
        await fn(req, { writeHead: (code) => { status = code; }, end: (data) => { out = JSON.parse(data); } }, new URL(url, 'http://fixture.invalid'), url);
        assert.equal(status, expected);
        return out;
      }
      const run = (id, fields = {}) => ({ id, text: 'fixture ' + id, startedAt: NOW, lane: 'n:' + id, log: [], ...fields });
      const fillSlots = () => { for (let i = RUNS.size; i < maxParallel(); i++) RUNS.set('block-' + i, run('block-' + i)); };
      const defer = () => new Promise((r) => setImmediate(r));
      const scheduled = (id) => Q.QUEUE.filter((q) => q.sched && (!id || q.sched.taskId === id));
      ${code}
      process.exit(0); // model the previous process ending without flushing in-memory timers
    `], { cwd: home, env, encoding: "utf8", timeout: 15_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr || r.stdout || String(r.signal));
  };
  return { boot, put };
}

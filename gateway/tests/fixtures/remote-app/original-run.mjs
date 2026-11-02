import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_SESSION = 'remote-fixture-original';
export const OTHER_SESSION = 'remote-fixture-unhosted';
export const PRIVATE_SENTINEL = 'UNHOSTED-SYNTHETIC-CONTENT-MUST-NOT-LEAK';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) { value = await check(); if (value) return value; await sleep(20); }
  throw new Error(`Timeout: ${label}; last=${JSON.stringify(value)}`);
}

/** Import actual gateway internals only after the standard runner or browser bootstrap isolates them. */
export async function createOriginalRunFixture({ historyItems = 120 } = {}) {
  assert.equal(process.env.CCAPP_TEST, '1', 'Use scripts/test.mjs or isolated browser bootstrap');
  const home = process.env.CCAPP_HOME, workspace = process.env.CCAPP_WORKSPACE, prefix = process.env.CCAPP_PREFIX;
  assert.ok(home && home === process.env.HOME && workspace && prefix, 'Disposable HOME/workspace/PREFIX required');
  // Do not inherit a real model credential even into the synthetic child process.
  for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR$)/.test(key)) delete process.env[key];
  const root = await fs.mkdtemp(path.join(workspace, 'remote-original-'));
  await fs.mkdir(path.join(root, 'signals'));
  const config = { active: 'custom-remote-fixture', providers: { 'custom-remote-fixture': {
    label: 'Synthetic only — no model', baseUrl: 'https://no-model.invalid', apiKey: 'synthetic-only-not-a-credential',
    authStyle: 'bearer', defaultModel: 'fixture-model', modelsUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 200000 }] })),
    fallbackModels: [{ id: 'fixture-model', context_window: 200000, input_modalities: ['text'] }],
  } } };
  await fs.writeFile(path.join(home, 'ccapp-providers.json'), JSON.stringify(config));
  await fs.writeFile(path.join(home, 'ccapp-settings.json'), JSON.stringify({ titleModel: 'off', idleCompaction: false, staticCompat: false, maxParallel: 3, permissionMode: 'default' }));
  const project = path.join(home, '.claude', 'projects', 'remote-fixture');
  await fs.mkdir(project, { recursive: true });
  const historyFile = path.join(project, LOCAL_SESSION + '.jsonl');
  const now = Date.now();
  assert.ok(Number.isInteger(historyItems) && historyItems >= 1 && historyItems <= 120, 'bounded synthetic history only');
  const records = Array.from({ length: historyItems }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid: 'remote-history-' + i, timestamp: new Date(now - (120 - i) * 1000).toISOString(), sessionId: LOCAL_SESSION, cwd: workspace, message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `Synthetic original history ${i}` }] } }));
  await fs.writeFile(historyFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(project, OTHER_SESSION + '.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'unhosted-sentinel', sessionId: OTHER_SESSION, cwd: workspace, message: { role: 'assistant', content: [{ type: 'text', text: PRIVATE_SENTINEL }] } }) + '\n');
  process.env.CCAPP_REMOTE_FIXTURE_DIR = root;
  const { PATHS } = await import('../../../gw/config.mjs');
  const oldPaths = { claude: PATHS.claude, loader: PATHS.loader };
  const fakeCli = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const loader = path.join(root, 'fake-loader');
  const shell = syncFs.existsSync('/system/bin/sh') ? '/system/bin/sh' : '/bin/sh';
  await fs.writeFile(loader, `#!${shell}\nexec ${quote(process.execPath)} ${quote(fakeCli)} "$@"\n`, { mode: 0o700 });
  PATHS.claude = fakeCli; PATHS.loader = loader;
  const { startRun, routeRun } = await import('../../../gw/run.mjs');
  const { RUNS, runOfSession } = await import('../../../gw/runs.mjs');
  const { enqueue, enqueueRemoteText, abortRun, QUEUE, snapshot } = await import('../../../gw/queue.mjs');
  const { onPublish, publish } = await import('../../../gw/bus.mjs');
  const { readSessionPage } = await import('../../../gw/transcript.mjs');
  const { SETTINGS } = await import('../../../gw/settings-store.mjs');
  Object.assign(SETTINGS, { titleModel: 'off', idleCompaction: false, staticCompat: false, maxParallel: 3 });
  const events = [], originalFetch = globalThis.fetch, attemptedExternal = [];
  // Even accidental new model/metadata traffic is rejected before leaving this process.
  globalThis.fetch = (input, init) => {
    const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (address.protocol === 'http:' && address.hostname === '127.0.0.1') return originalFetch(input, init);
    attemptedExternal.push(address.origin + address.pathname);
    return Promise.reject(new Error('Remote acceptance fixture forbids external networking'));
  };
  const unsubscribe = onPublish((event) => events.push(structuredClone(event)));
  let sequence = 0;
  const childEvents = async () => {
    try { return (await fs.readFile(path.join(root, 'child-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  const signal = async (runId, body) => fs.writeFile(path.join(root, 'signals', runId + '.json'), JSON.stringify({ nonce: ++sequence, ...body }));
  const start = async (id = 'remote-original-' + ++sequence) => {
    await startRun({ id, sessionId: LOCAL_SESSION, message: 'Synthetic original work, no model call', cwd: workspace });
    const run = await until(() => { const r = RUNS.get(id); return r?.perms?.size ? r : false; }, 'real original permission request');
    return run;
  };
  return {
    root, home, workspace, events, attemptedExternal, historyFile, localSessionId: LOCAL_SESSION, otherSessionId: OTHER_SESSION,
    RUNS, QUEUE, startRun, enqueue, enqueueRemoteText, abortRun, runOfSession, snapshot, routeRun, publish, onPublish, readSessionPage,
    start, signal, childEvents,
    async request(run, tool, input, tag) {
      const old = new Set(run.perms.keys());
      await signal(run.id, { kind: 'request', tool, input, tag });
      return until(() => [...run.perms.values()].find((r) => !old.has(r.id)), 'original ' + tool + ' permission');
    },
    history(options) { return readSessionPage(historyFile, options); },
    async close() {
      QUEUE.splice(0, QUEUE.length);
      for (const run of [...RUNS.values()]) if (run.sessionId === LOCAL_SESSION || run.id.startsWith('remote-')) abortRun(run);
      await until(() => ![...RUNS.values()].some((r) => r.sessionId === LOCAL_SESSION), 'synthetic child cleanup').catch(() => {});
      unsubscribe(); globalThis.fetch = originalFetch; Object.assign(PATHS, oldPaths);
      delete process.env.CCAPP_REMOTE_FIXTURE_DIR;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

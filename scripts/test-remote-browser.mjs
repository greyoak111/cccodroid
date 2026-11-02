#!/usr/bin/env node
// Real checkout UI + injectable real remote runtime, fake stream-json original execution only.
// Installed Chromium and Node built-in WebSocket. No npm, live HOME, model or WAN.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.TMPDIR || path.join(os.homedir(), '.cache');
await fs.mkdir(base, { recursive: true });
const lock = path.join(base, 'cccodroid-remote-browser.lock');
try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Remote browser acceptance already running'); throw e; }
const tmp = await fs.mkdtemp(path.join(base, 'rb-'));
const evidence = process.env.REMOTE_ACCEPTANCE_OUTPUT || path.join(tmp, 'browser-evidence.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [], errors = [], external = [];
let browser, cdp, original, server, runtimeFixture, stderr = '', launchError;
const report = (status, name, detail = '') => { results.push({ status, name, detail }); console.log(`${status} ${name}${detail ? ' — ' + detail : ''}`); };
const q = JSON.stringify;
async function until(check, label, timeout = 8000) { let value; const end = Date.now() + timeout; while (Date.now() < end) { value = await check(); if (value) return value; await sleep(40); } throw new Error(`Timeout: ${label}; last=${JSON.stringify(value)}`); }
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(p.method + ': ' + m.error.message)) : p.resolve(m.result); }
      else for (const handler of this.handlers.get(m.method) || []) handler(m.params);
    });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP closed')); } this.pending.clear(); });
  }
  on(method, handler) { const list = this.handlers.get(method) || []; list.push(handler); this.handlers.set(method, list); }
  call(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000); this.pending.set(id, { resolve, reject, timer, method }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
}

try {
  // Establish isolation before any import of real gateway internals.
  for (const key of Object.keys(process.env)) if (key.startsWith('CCAPP_') || /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR$)/.test(key)) delete process.env[key];
  const home = path.join(tmp, 'home'), workspace = path.join(tmp, 'work'), prefix = path.join(tmp, 'usr');
  for (const dir of [home, workspace, path.join(prefix, 'bin')]) await fs.mkdir(dir, { recursive: true });
  Object.assign(process.env, { HOME: home, CCAPP_HOME: home, CCAPP_WORKSPACE: workspace, CCAPP_PREFIX: prefix, CCAPP_TEST: '1', CCAPP_LOG: path.join(tmp, 'gateway.log'), CCAPP_TMP: tmp });
  const { createOriginalRunFixture } = await import('../gateway/tests/fixtures/remote-app/original-run.mjs');
  const { startRemoteUiServer } = await import('../gateway/tests/fixtures/remote-app/ui-server.mjs');
  original = await createOriginalRunFixture();
  // Runtime fixture is a thin dependency/route adapter, not a replacement implementation.
  const adapter = new URL('../gateway/tests/fixtures/remote-app/runtime-chain.mjs', import.meta.url);
  if (await fs.access(adapter).then(() => true, () => false)) runtimeFixture = await (await import(adapter)).createRuntimeChain({ original });
  server = await startRemoteUiServer({ original, routeRemote: runtimeFixture?.routeRemote, componentPresent: false });
  browser = spawn(process.env.CHROMIUM_BIN || 'chromium-headless', [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(tmp, 'p')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-proxy-server',
    '--metrics-recording-only', '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--password-store=basic', '--use-mock-keychain',
    '--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--renderer-process-limit=1', '--window-size=360,800', 'about:blank',
  ], { env: { ...process.env, HOME: tmp, TMPDIR: tmp }, cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  browser.on('error', (e) => { launchError = e; });
  browser.stderr.on('data', (data) => { stderr = (stderr + data).slice(-6000); });
  const port = await until(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error('Chromium exited: ' + stderr);
    try { return Number((await fs.readFile(path.join(tmp, 'p', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return false; }
  }, 'Chromium start', 15000);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl); await once(ws, 'open'); cdp = new CDP(ws);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: e }) => errors.push(e.exception?.description || e.text));
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') errors.push(args.map((a) => a.description || a.value || '').join(' ')); });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const u = new URL(request.url);
    if (u.origin === server.origin || runtimeFixture?.allowedOrigins().includes(u.origin) || ['data:', 'blob:'].includes(u.protocol)) cdp.call('Fetch.continueRequest', { requestId }).catch(() => {});
    else { external.push(u.origin + u.pathname); cdp.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
  });
  cdp.on('Page.javascriptDialogOpening', () => cdp.call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
  await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__remoteFixtureErrors=[]; addEventListener('error',e=>__remoteFixtureErrors.push(e.message)); addEventListener('unhandledrejection',e=>__remoteFixtureErrors.push(String(e.reason?.message||e.reason))); localStorage.setItem('ccapp.lang','zh'); localStorage.setItem('cc.navMore','1'); localStorage.setItem('cc.motion','off');` });
  const visible = (selector) => `(() => { const e=document.querySelector(${q(selector)}); return !!(e && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden'); })()`;
  const click = async (selector) => {
    const point = await until(() => cdp.eval(`(() => {const e=document.querySelector(${q(selector)}); if(!e || e.disabled || !e.getClientRects().length)return false; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y); return h&&e.contains(h)?{x,y}:false;})()`), 'clickable ' + selector);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const fill = async (selector, text) => { await click(selector); await cdp.eval(`document.querySelector(${q(selector)}).select()`); await cdp.call('Input.insertText', { text }); };
  await cdp.call('Page.navigate', { url: server.origin + '/?lang=zh' });
  await until(() => cdp.eval('!!(window.__cc && __cc.srv.connected && __cc.state.settings && __cc.state.sessions.length===2)'), 'actual App boot');
  await until(() => cdp.eval("window.__cc.remoteComponent?.status().state==='absent'"), 'core boot without component');
  assert.equal(await cdp.eval("document.querySelectorAll('#side-nav [data-page=remote], script[src*=\"remote-session/ui.js\"]').length"), 0);
  assert.equal(server.state.requests.some((r) => r.path.startsWith('/api/remote/')), false);
  report('PASS', 'core App without optional component', 'no remote bundle, transport request or visible remote navigation');
  await server.setComponentPresent(true);
  await cdp.eval('__cc.remoteComponent.refresh()');
  await until(() => cdp.eval('window.__cc.remoteComponent?.enabled()'), 'optional remote component UI mount');
  report('PASS', 'real App boot', 'actual core app plus separate version-pinned optional component; isolated loopback status fixtures');
  // Discover actual application entries before any test-only navigation helper.
  await click('#btn-menu');
  await until(() => cdp.eval(visible('#drawer')), 'actual App drawer');
  assert.ok(await cdp.eval("!!document.querySelector('#side-nav [data-page=remote]')"), 'remote page is registered in real side navigation');
  await cdp.eval('window.__ccBack()');
  await until(() => cdp.eval("document.querySelector('#drawer').classList.contains('hidden')"), 'drawer closes using actual back hook');
  await cdp.eval("__cc.openPage('settings')");
  await until(() => cdp.eval(visible('#set-ov')), 'actual settings');
  assert.ok(await cdp.eval("!!document.querySelector('#set-cats [data-cat=remote]')"), 'remote settings category exists in the real settings list');
  await cdp.eval('window.__ccBack()');
  report('PASS', 'actual remote entry discovery', 'real side navigation and Settings category, not a standalone prototype');
  if (runtimeFixture) {
    await runtimeFixture.browserAcceptance({ cdp, click, fill, until, visible, report, origin: server.origin });
  } else {
    report('SKIP', 'remote invitation/control GUI chain', 'real runtime route adapter not connected; no remote success manufactured');
    // This still catches broken global app script loading before runtime arrives.
    assert.ok(server.state.sourceHashes['app.js'] && server.state.sourceHashes['index.html']);
  }
  // Exercise the actual extension card after the existing remote interaction
  // sequence. No DOM-success fabrication: all state changes use the host API.
  await cdp.eval("__cc.openPage('ext')");
  await until(() => cdp.eval(visible('#comp-list [data-c=disable][data-id=remote-session]')), 'component card with real disable button');
  const shotDir = process.env.REMOTE_COMPONENT_SCREENSHOTS;
  const shot = async (name) => { if (!shotDir) return; const png = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(shotDir, name + '.png'), Buffer.from(png.data, 'base64')); };
  if (shotDir) { if (!path.isAbsolute(shotDir)) throw new Error('Screenshot directory must be absolute'); await fs.mkdir(shotDir, { recursive: false }); await shot('01-component-active'); }
  const localBefore = await cdp.eval('__cc.view.sessionId');
  await click('#comp-list [data-c=disable][data-id=remote-session]');
  await until(() => cdp.eval("!__cc.remoteComponent.enabled() && __cc.remoteComponent.status().state==='disabled'"), 'disable confirmed by host');
  assert.equal(await cdp.eval("document.querySelectorAll('#side-nav [data-page=remote]').length"), 0);
  assert.equal(await cdp.eval("document.querySelector('#remotePage').textContent"), '');
  assert.equal(await cdp.eval('__cc.remote.transport.getDraft()'), '');
  assert.equal(await cdp.eval('__cc.view.sessionId'), localBefore);
  assert.equal(await cdp.eval("document.querySelectorAll('link[href*=\"remote-session/ui.css\"]').length"), 0);
  report('PASS', 'component card disable clears optional UI only', 'real host disable ack; no remote nav/content/draft/style or local session change');
  await until(() => cdp.eval(visible('#comp-list [data-c=enable][data-id=remote-session]')), 'enable available on disabled component card');
  await shot('02-component-disabled');
  await click('#comp-list [data-c=enable][data-id=remote-session]');
  await until(() => cdp.eval('__cc.remoteComponent.enabled()'), 'hot enable loads version-pinned optional UI');
  await until(() => cdp.eval(visible('#comp-list [data-c=configure][data-id=remote-session]')), 'configuration entry after hot enable');
  await click('#comp-list [data-c=configure][data-id=remote-session]');
  await until(() => cdp.eval(visible('#remoteSettingsPage .rs-content')), 'new generation settings listeners work');
  await shot('03-component-configure');
  assert.equal(await cdp.eval('__cc.view.sessionId'), localBefore);
  report('PASS', 'component hot re-enable and configuration', 'new component generation, working real settings, no full reload or local session change');
  await cdp.eval("__cc.remote.transport.setDraft('Synthetic private draft before other window restart')");
  const beforeRestart = await cdp.eval('__cc.remoteComponent.status()');
  const restart = await cdp.eval(`(async()=>{ const body={method:'POST',headers:{'content-type':'application/json'},body:'{}'}; const off=await fetch('/api/components/remote-session/disable',body).then(r=>r.json()); const on=await fetch('/api/components/remote-session/enable',body).then(r=>r.json()); return {off,on}; })()`);
  assert.equal(restart.off.component.state, 'disabled'); assert.equal(restart.on.component.state, 'active');
  assert.equal(restart.on.component.assetVersion, beforeRestart.assetVersion);
  assert.notEqual(restart.on.component.activationId, beforeRestart.activationId);
  await cdp.eval('__cc.remoteComponent.refresh()');
  await until(() => cdp.eval('__cc.remoteComponent.enabled()'), 'missed stop/start new activation is mounted');
  assert.equal(await cdp.eval('__cc.remote.transport.getDraft()'), '');
  assert.equal(await cdp.eval('__cc.view.sessionId'), localBefore);
  assert.equal(await cdp.eval("document.querySelectorAll('script[src*=\"remote-session/ui.js\"]').length"), 1);
  report('PASS', 'same-version stop/start between polls resets stale UI', 'real lifecycle endpoints rotate activation identity; prior draft cleared without core reload');
  errors.push(...await cdp.eval('window.__remoteFixtureErrors || []'));
  assert.deepEqual([...new Set(errors)], [], 'no browser runtime/console errors');
  assert.deepEqual(external, [], 'no attempted browser egress');
  assert.deepEqual(original.attemptedExternal, [], 'no original-run model egress');
  assert.deepEqual(server.state.unexpected, [], 'no unknown boot or local execution route calls');
  const runtimeEvidence = runtimeFixture?.evidence();
  assert.deepEqual(runtimeEvidence?.phoneUi?.unexpected || [], [], 'phone frontend must not call local execution or unknown fixture APIs');
  report('PASS', 'isolation and real-source evidence', 'no frontend egress, local execution route, unexpected API or console error');
  report('SKIP', 'Android background/lock screen/notification click/network switching', 'headless fixture is not two-device Android verification');
} catch (e) {
  report('FAIL', 'browser acceptance', e.stack || String(e)); process.exitCode = 1;
  if (cdp) try { console.error('UI state ' + JSON.stringify(await cdp.eval("(async()=>({body:document.body.innerText.slice(-6000),errors:window.__remoteFixtureErrors,transport:window.__cc?.remote?.transport ? await window.__cc.remote.transport.status().catch(e=>({error:e.code,message:e.message,stack:e.stack})) : null}))()"))); } catch {}
} finally {
  const data = { timestamp: new Date().toISOString(), syntheticExecutionOnly: true, realFrontend: true, results, errors, external, unexpected: server?.state.unexpected, component: server?.state.component, sourceHashes: server?.state.sourceHashes, requests: server?.state.requests, runtime: runtimeFixture?.evidence(), note: 'No real Android lock-screen/cloud/model claim.' };
  const required = ['invite → consent → original history', 'original approval → original execution continuation', 'real Edit denial/question/plan GUI and focus', 'real remote 360px/split-screen light/dark large font', 'phone text → original session once', 'stop original run with true receipt', 'revoke access but keep original task'];
  for (const name of required) if (!results.some((row) => row.name === name)) { results.push({ status: 'SKIP', name, detail: 'Blocked before this scenario; not passed.' }); console.log('SKIP ' + name + ' — blocked before scenario'); }
  if (!results.some((row) => row.name.includes('Android background'))) { results.push({ status: 'SKIP', name: 'Android background/lock screen/notification click/network switching', detail: 'Not a real Android device run.' }); console.log('SKIP Android background/lock screen/notification click/network switching — not a device run'); }
  if (evidence.startsWith(tmp)) console.log(JSON.stringify(data));
  else { await fs.mkdir(path.dirname(evidence), { recursive: true }); await fs.writeFile(evidence, JSON.stringify(data, null, 2)); console.log('Evidence ' + evidence); }
  if (cdp) cdp.ws.close();
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGTERM'); } catch {} await Promise.race([once(browser, 'exit').catch(() => {}), sleep(2000)]); if (browser.exitCode === null) try { process.kill(-browser.pid, 'SIGKILL'); } catch {} }
  await server?.close(); await runtimeFixture?.close(); await original?.close();
  await fs.rm(tmp, { recursive: true, force: true }); await fs.rm(lock, { recursive: true, force: true });
}

// Serves the real checkout UI. Only ordinary boot/status routes are fixtures.
// /api/remote/* MUST go to an injected production route; never manufacture remote success here.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCAL_SESSION, OTHER_SESSION } from './original-run.mjs';
import { appJs } from '../../../gw/http.mjs';
import { buildRemoteComponent } from '../../../../scripts/build-remote-component.mjs';
import { createRemoteComponentManager } from '../../../gw/remote-component.mjs';
import { createRemoteComponentRoute } from '../../../gw/remote-component-route.mjs';

const WEB = fileURLToPath(new URL('../../../web/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.md': 'text/plain' };
export async function startRemoteUiServer({ routeRemote = null, original = null, componentPresent = true } = {}) {
  const clients = new Set(), state = { requests: [], unexpected: [], sourceHashes: {}, ui: {}, sseConnections: 0 };
  // Package the actual optional UI; core app.js never contains its implementation.
  // Runtime routing stays the injected real coordinator, not a manufactured result.
  const os = await import('node:os');
  const componentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-ui-component-'));
  const built = buildRemoteComponent({ out: path.join(componentRoot, 'payload'), base: 'e'.repeat(64) });
  const record = { id: 'remote-session', state: 'ok', version: built.build.version, base: built.build.base };
  const component = createRemoteComponentManager({ prefix: built.usr, home: path.join(componentRoot, 'home'),
    readRecord: () => componentPresent ? record : null, readDevkit: () => ({ sha256: built.build.base }),
    createRuntime: async () => ({ async retire() {}, async dispose() {}, subscribe() { return () => {}; } }) });
  const componentRoute = createRemoteComponentRoute(component);
  await component.status();
  state.component = { realPackagedUi: true, version: built.build.version, assetVersion: built.manifest.assetVersion };
  let eventId = 0;
  const sessions = [LOCAL_SESSION, OTHER_SESSION].map((id, i) => ({ id, title: 'Synthetic original session ' + (i ? 'unhosted' : 'hosted'), mtime: Date.now(), sizeKb: 1, cwd: '/synthetic/workspace' }));
  const json = (res, data, status = 200) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); } };
  const bodyOf = async (req) => { let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('Fixture request limit'); } return text ? JSON.parse(text) : {}; };
  const emit = (event) => { for (const client of clients) if (!client.destroyed) client.write(`id: ${++eventId}\ndata: ${JSON.stringify(event)}\n\n`); };
  const off = original?.onPublish(emit);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname;
      res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (p.startsWith('/api/')) state.requests.push({ method: req.method, path: p, query: url.search });
      if (p.startsWith('/api/components/remote-session/')) {
        req.ccAuthed = req.socket.remoteAddress === '127.0.0.1' && req.headers['x-remote-fixture-no-auth'] !== '1';
        return await componentRoute(req, res, url, p);
      }
      if (p.startsWith('/api/remote/')) {
        const current = await component.status();
        if (!current.enabled) return json(res, { ok: false, code: 'REMOTE_UNAVAILABLE' }, 503);
        // This UI-only manager is not the business runtime owner. Mirror its
        // activation gate without claiming packaged lifecycle coverage here;
        // the separate packaged-chain test uses the actual production wrapper.
        const activation = req.headers['x-cc-remote-activation'] || url.searchParams.get('activation');
        if (activation !== current.activationId) { req.resume(); return json(res, { ok: false, code: 'COMPONENT_VERSION_MISMATCH' }, 409); }
        req.ccAuthed = req.socket.remoteAddress === '127.0.0.1' && req.headers['x-remote-fixture-no-auth'] !== '1';
        if (!routeRemote) return json(res, { ok: false, code: 'ACCEPTANCE_RUNTIME_UNAVAILABLE' }, 503);
        const result = await routeRemote(req, res, url, p);
        if (!res.headersSent && !res.writableEnded && typeof result === 'symbol') return json(res, { ok: false, code: 'ACCEPTANCE_UNHANDLED_REMOTE_ROUTE' }, 404);
        return;
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); clients.add(res); state.sseConnections++;
        req.on('close', () => clients.delete(res));
        res.write(`id: ${++eventId}\ndata: ${JSON.stringify({ type: 'hello', uiTag: 'remote-synthetic', ...(original?.snapshot() || { runs: [], queue: [], maxParallel: 3 }), run: null, resume: false })}\n\n`);
        res.write(`id: ${++eventId}\ndata: {"type":"sync"}\n\n`); return;
      }
      if (p === '/api/ui') { if (req.method === 'POST') Object.assign(state.ui, await bodyOf(req)); return json(res, { ui: state.ui }); }
      // Never allow the phone UI to accidentally invoke its local execution/control APIs.
      if (req.method !== 'GET' && ['/api/chat', '/api/perm/answer', '/api/abort', '/api/perm/mode', '/api/providers/test'].includes(p)) {
        state.unexpected.push(req.method + ' ' + p); return json(res, { error: 'LOCAL_EXECUTION_FORBIDDEN_IN_REMOTE_UI_FIXTURE' }, 403);
      }
      if (p === '/api/sessions') return json(res, { sessions });
      if (p.startsWith('/api/session/')) {
        const id = p.slice('/api/session/'.length).split('/')[0];
        if (p.endsWith('/marks')) return json(res, { items: [] });
        if (id === LOCAL_SESSION && original) return json(res, { ...await original.history({ limit: 40 }), title: sessions[0].title });
        return json(res, { items: [], title: sessions.find((s) => s.id === id)?.title || '', cursor: 0, next: 1, size: 0 });
      }
      const routes = {
        '/api/status': { version: 'synthetic', uiTag: 'remote-synthetic', ready: true, claude: true, claudeVersion: 'fixture-only', keyMode: 'none', hasKey: false, bridge: false, model: 'fixture-model', workspace: '/synthetic/workspace', busy: false },
        '/api/settings': { permissionMode: 'default', outputStyles: [], addDirs: [], model: 'fixture-model', maxParallel: 3 },
        '/api/capabilities': { version: 'synthetic', slashCommands: [], tools: [], skills: [], agents: [], plugins: [], mcpServers: [], rules: { allow: [], ask: [], deny: [] } },
        '/api/providers': { active: 'synthetic', providers: [{ id: 'synthetic', label: 'Synthetic — no model', active: true, hasKey: false, custom: true }] },
        '/api/models': { models: [{ id: 'fixture-model', name: 'Synthetic model', context_window: 200000, input_modalities: ['text'] }], current: 'fixture-model', contextWindow: 200000, providers: [] },
        '/api/session-model': { model: 'fixture-model', provider: 'synthetic', own: false },
        '/api/exec-mode': { pref: 'auto', active: 'direct', pid: 0 }, '/api/fonts': { items: [] }, '/api/notices': { items: [] },
        '/api/components': { supported: true, items: [{ id: 'remote-session', ...built.entry, state: componentPresent ? 'ok' : 'absent', version: built.build.version, installedVersion: componentPresent ? built.build.version : null, available: true, verified: false, source: 'fixture-only', signed: false, bytes: built.build.bytes, installed: built.build.installed, bin: [], requires: [], hostCompatible: true, feature: component.peek() }] }, '/api/devkit/modules': { supported: false }, '/api/custom': { supported: false },
        '/api/ext/plugins': { installed: [], available: [] }, '/api/ext/cmds': { items: [] }, '/api/ext/skills': { items: [] }, '/api/ext/mcp': { items: [] }, '/api/ext/marketplaces': { items: [] }, '/api/ext/hooks': { scopes: [{ scope: 'user', hooks: {}, exists: false }], events: [] }, '/api/commands': { scopes: [], workspace: '/synthetic/workspace' },
        '/api/gh/auth': { installed: false }, '/api/projects': { projects: [], items: [] }, '/api/sched': { tasks: [], items: [], budget: {}, missed: [] },
        '/api/priv/status': { supported: false }, '/api/app/upd_status': { supported: false }, '/api/app/notify_status': { supported: false }, '/api/app/dev_status': { supported: false },
        '/api/reconcile': { supported: false }, '/api/usage': { hours: [], items: [], providers: {}, sessions: {}, days: [] }, '/api/energy': { supported: false, items: [] },
        '/api/billing': { supported: false }, '/api/bookmarks': { items: [] }, '/api/orphans': { items: [] }, '/api/login/status': { loggedIn: false },
      };
      if (Object.hasOwn(routes, p)) return json(res, routes[p]);
      if (p.startsWith('/api/')) { state.unexpected.push(req.method + ' ' + p); return json(res, { ok: false, code: 'UNIMPLEMENTED_BOOT_FIXTURE_ROUTE' }, 404); }
      if (p === '/app.js') {
        const text = appJs().toString('utf8');
        state.sourceHashes['app.js'] = createHash('sha256').update(text).digest('hex');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(text);
      }
      const name = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const file = path.resolve(WEB, name);
      if (!file.startsWith(WEB)) return json(res, { error: 'not found' }, 404);
      const real = await fs.realpath(file);
      if (!real.startsWith(WEB) || !(await fs.stat(real)).isFile()) return json(res, { error: 'not found' }, 404);
      const data = await fs.readFile(real);
      state.sourceHashes[name] = createHash('sha256').update(data).digest('hex');
      res.writeHead(200, { 'content-type': TYPES[path.extname(real)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
    } catch (e) { json(res, { error: e.code === 'ENOENT' ? 'not found' : e.message }, e.code === 'ENOENT' ? 404 : 500); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, state, emit,
    component,
    async setComponentPresent(value) { if (!value) await component.disable(); componentPresent = value; if (value) await component.enable(); else await component.status(); },
    async close() { off?.(); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await component.close(); await fs.rm(componentRoot, { recursive: true, force: true }); },
  };
}

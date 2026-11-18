import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const web = path.resolve(process.env.CCAPP_TEST_WEB || fileURLToPath(new URL('../web/', import.meta.url)));
const read = name => readFileSync(path.join(web, 'app', name), 'utf8');
const files = read('06-files.js'), viewer = read('16-viewer-git.js'), terminal = read('18-terminal.js');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source section: ${start}`);
  return source.slice(from, to);
}
const visibleSource = section(files, '  function fsVisible() {', '  function renderFs() {');
const dotsSource = section(viewer, '  let fsDots = null, fsDotsAt = 0;', '  const viewerEl = $("viewer");');
const themeSource = section(terminal, '  function termTheme() {', '  // 宽屏下窗格已经开着');
const mountSource = section(terminal, '  function mountTerm(id) {', '  /** 只有正在看的终端连着输出流');
const themeObserverSource = terminal.slice(terminal.indexOf('  let themeRaf = 0;'));
assert.ok(themeObserverSource.startsWith('  let themeRaf = 0;'));

function fileHarness({ entries = [], q = '', response, api } = {}) {
  const state = { fs: { path: '/repo/src', entries, q } };
  const calls = [], paints = [];
  let nodes = [], visibleCalls = 0;
  const ctx = vm.createContext({
    state,
    api: async url => { calls.push(url); return api ? api(url) : response; },
    $: id => {
      assert.equal(id, 'fs-list');
      return { querySelectorAll: selector => { assert.equal(selector, '.fs-item'); return nodes; } };
    },
    esc: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    gsTitle: kind => `Git ${kind}`,
  });
  vm.runInContext(visibleSource + dotsSource, ctx);
  const visible = ctx.fsVisible;
  ctx.fsVisible = () => { visibleCalls++; return visible(); };
  function render() {
    nodes = visible().map((entry, i) => {
      let dot = false;
      return {
        dataset: { i: String(i) },
        querySelector(selector) {
          if (selector === '.fs-git-dot') return dot ? {} : null;
          assert.equal(selector, '.it-title');
          return { insertAdjacentHTML(where, html) { assert.equal(where, 'afterend'); dot = true; paints.push({ name: entry.name, html }); } };
        },
      };
    });
  }
  render();
  return { state, calls, paints, render, run: () => ctx.fsGitDots(), get visibleCalls() { return visibleCalls; } };
}

test('Git dots filter a thousand matching entries once per update and reuse cached status', async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `main-file-${999 - i}.js` }));
  const h = fileHarness({ entries, q: 'MAIN', response: { root: '/repo', files: [{ path: 'src/main-file-500.js', kind: 'added' }] } });
  await h.run();
  assert.equal(h.visibleCalls, 1);
  assert.equal(h.paints.length, 1);
  assert.equal(h.paints[0].name, 'main-file-500.js');
  assert.match(h.paints[0].html, /fs-git-dot added/);
  await h.run();
  assert.equal(h.visibleCalls, 2);
  assert.equal(h.calls.length, 1, 'status stays cached');
  assert.equal(h.paints.length, 1, 'existing dots are not duplicated');
});

test('Git dots preserve filtered order, nested directory marks and shared-storage path normalization', async () => {
  const h = fileHarness({
    entries: [{ name: 'ignored.txt' }, { name: 'Main-z.js' }, { name: 'main-dir' }, { name: 'main-a.js' }],
    q: 'main',
    response: { root: '/storage/emulated/0/repo', files: [
      { path: 'src/main-a.js', kind: 'deleted' },
      { path: 'src/main-dir/nested.js', kind: 'added' },
      { path: 'src/Main-z.js', kind: 'modified' },
      { path: 'other/main-a.js', kind: 'added' },
    ] },
  });
  h.state.fs.path = '/sdcard/repo/src';
  await h.run();
  assert.equal(h.visibleCalls, 1);
  assert.deepEqual(h.paints.map(p => [p.name, p.html.match(/fs-git-dot (\w+)/)[1]]), [
    ['Main-z.js', 'modified'], ['main-dir', 'modified'], ['main-a.js', 'deleted'],
  ]);
});

test('a late status for a previous directory never filters or paints the current list', async () => {
  let resolve;
  const response = new Promise(r => { resolve = r; });
  const h = fileHarness({ entries: [{ name: 'main.js' }], q: 'main', api: () => response });
  const pending = h.run();
  h.state.fs.path = '/repo/elsewhere';
  h.render();
  resolve({ root: '/repo', files: [{ path: 'src/main.js', kind: 'modified' }] });
  await pending;
  assert.equal(h.visibleCalls, 0);
  assert.equal(h.paints.length, 0);
});

test('a pending status uses the current search and visible-node indexes after returning', async () => {
  let resolve;
  const response = new Promise(r => { resolve = r; });
  const h = fileHarness({ entries: [{ name: 'main.js' }, { name: 'other.js' }], q: 'main', api: () => response });
  const pending = h.run();
  h.state.fs.q = 'other';
  h.render();
  resolve({ root: '/repo', files: [{ path: 'src/main.js', kind: 'added' }, { path: 'src/other.js', kind: 'deleted' }] });
  await pending;
  assert.equal(h.visibleCalls, 1);
  assert.equal(h.paints.length, 1);
  assert.equal(h.paints[0].name, 'other.js');
  assert.match(h.paints[0].html, /fs-git-dot deleted/);
});

test('non-repository, failed and empty status responses do not filter the directory', async () => {
  for (const response of [null, { notRepo: true }, { error: 'unavailable' }]) {
    const h = fileHarness({ entries: [{ name: 'main.js' }], response });
    await h.run();
    assert.equal(h.visibleCalls, 0);
    assert.equal(h.paints.length, 0);
  }
});

function terminalHarness() {
  const root = { dataset: { theme: 'dark', skin: 'default' } };
  const colors = { '--code-bg': '#111', '--fg': '#eee', '--accent': '#48f' };
  const TERM = { inst: new Map(), list: [], font: 13 };
  const frames = [], observers = [], instances = [];
  let frameId = 0, themeReads = 0;
  class Terminal {
    constructor(options) {
      let value = { ...options.theme };
      this.writes = 0;
      this.options = { ...options };
      Object.defineProperty(this.options, 'theme', {
        get: () => value,
        set: next => { this.writes++; value = { ...next }; },
      });
      instances.push(this);
    }
    loadAddon() {}
    open() {}
    onData() {}
    registerLinkProvider() {}
    onTitleChange() {}
  }
  const ctx = vm.createContext({
    TERM,
    document: { documentElement: root, createElement: () => ({ className: '' }) },
    window: { Terminal, FitAddon: { FitAddon: class {} } },
    $: id => { assert.equal(id, 'term-screens'); return { appendChild() {} }; },
    getComputedStyle: el => { assert.equal(el, root); themeReads++; return { getPropertyValue: key => colors[key] || '' }; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
    },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: callback => { frames.push(callback); return ++frameId; },
    termScrubber() {},
  });
  vm.runInContext(themeSource + mountSource + themeObserverSource, ctx);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, root);
  assert.deepEqual(Array.from(observers[0].options.attributeFilter), ['data-theme', 'data-skin', 'style']);
  return {
    root, colors, TERM, instances,
    mount: id => ctx.mountTerm(id),
    notify: (attributeName = 'style') => observers[0].callback([{ target: root, attributeName, type: 'attributes' }]),
    flush: () => { const batch = frames.splice(0); for (const callback of batch) callback(); },
    get pendingFrames() { return frames.length; },
    get themeReads() { return themeReads; },
  };
}

test('width-only root style mutations never assign themes to mounted terminals', () => {
  const h = terminalHarness();
  h.notify();
  assert.equal(h.pendingFrames, 0, 'no terminal means no work');
  for (let i = 0; i < 4; i++) h.mount('t' + i);
  const reads = h.themeReads;
  h.notify(); h.notify(); h.notify();
  assert.equal(h.pendingFrames, 1, 'same-frame mutations stay coalesced');
  h.flush();
  assert.equal(h.themeReads, reads + 1);
  for (let i = 0; i < 3; i++) { h.notify(); h.flush(); }
  assert.deepEqual(h.instances.map(t => t.writes), [0, 0, 0, 0]);
});

test('accent and custom skin colors update every mounted terminal once, not once per mutation', () => {
  const h = terminalHarness();
  for (let i = 0; i < 4; i++) h.mount('t' + i);
  h.colors['--accent'] = '#f50';
  h.notify(); h.notify();
  h.flush();
  assert.deepEqual(h.instances.map(t => t.writes), [1, 1, 1, 1]);
  assert.ok(h.instances.every(t => t.options.theme.cursor === '#f50'));
  h.notify(); h.flush();
  assert.deepEqual(h.instances.map(t => t.writes), [1, 1, 1, 1]);
  h.root.dataset.skin = 'custom';
  h.colors['--code-bg'] = '#182338';
  h.colors['--fg'] = '#dceafc';
  h.notify('data-skin'); h.notify(); h.flush();
  assert.deepEqual(h.instances.map(t => t.writes), [2, 2, 2, 2]);
  assert.ok(h.instances.every(t => t.options.theme.background === '#182338' && t.options.theme.cursorAccent === '#182338' && t.options.theme.foreground === '#dceafc'));
});

test('light and dark transitions include added and removed ANSI palette keys', () => {
  const h = terminalHarness();
  h.mount('t');
  h.root.dataset.theme = 'light';
  h.notify('data-theme'); h.flush();
  const xt = h.instances[0];
  assert.equal(xt.writes, 1);
  assert.equal(xt.options.theme.yellow, '#7d4e00');
  assert.equal(xt.options.theme.selectionBackground, 'rgba(201,100,66,.25)');
  h.root.dataset.theme = 'dark';
  h.notify('data-theme'); h.flush();
  assert.equal(xt.writes, 2);
  assert.equal(xt.options.theme.yellow, undefined);
  assert.equal(xt.options.theme.selectionBackground, 'rgba(217,119,87,.35)');
  h.notify('data-theme'); h.flush();
  assert.equal(xt.writes, 2);
});

test('a terminal mounted after a color mutation already has the correct theme and is not reassigned', () => {
  const h = terminalHarness();
  h.mount('old');
  h.colors['--accent'] = '#a4f';
  h.notify();
  h.mount('new');
  assert.equal(h.instances[1].options.theme.cursor, '#a4f');
  h.flush();
  assert.deepEqual(h.instances.map(t => t.writes), [1, 0]);
  h.mount('later');
  h.notify(); h.flush();
  assert.deepEqual(h.instances.map(t => t.writes), [1, 0, 0]);
});

test('a theme change before the first terminal is mounted is retained without an initial refresh', () => {
  const h = terminalHarness();
  h.root.dataset.theme = 'light';
  h.colors['--accent'] = '#28a';
  h.notify('data-theme'); h.notify();
  assert.equal(h.pendingFrames, 0);
  h.mount('first');
  h.notify(); h.flush();
  assert.equal(h.instances[0].options.theme.cursor, '#28a');
  assert.equal(h.instances[0].options.theme.yellow, '#7d4e00');
  assert.equal(h.instances[0].writes, 0);
});

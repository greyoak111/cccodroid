import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../web/app/${file}.js`, import.meta.url), "utf8");
const part = (src, start, end) => {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return src.slice(a, b);
};

// Use a deterministic frame queue: these are measurements of JS calls, not browser layout time.
function frames(box) {
  const pending = new Map(); let n = 0;
  box.requestAnimationFrame = (fn) => { pending.set(++n, fn); return n; };
  box.cancelAnimationFrame = (id) => pending.delete(id);
  return () => { for (const [id, fn] of [...pending]) if (pending.delete(id)) fn(); };
}

function scrollFixture() {
  let reads = 0;
  const chatEl = { scrollTop: 0, get scrollHeight() { reads++; return 1500; } };
  const box = { chatEl, document: { hidden: false }, view: { gen: 1, next: null }, busReplay: false, stick: true, touching: false, progTop: 0 };
  const frame = frames(box);
  const scroll = part(read("01-core"), "  let scrollRaf = 0;", "  function relTime(");
  const fns = vm.runInNewContext(`${scroll}\n({ scrollDown, queueToolFollow })`, box);
  return { box, frame, ...fns, reads: () => reads };
}

test("tool burst follows once; an immediate follow absorbs an already queued frame", () => {
  const f = scrollFixture();
  for (let i = 0; i < 30; i++) f.queueToolFollow();
  assert.equal(f.reads(), 0);
  f.frame();
  assert.equal(f.reads(), 1);
  assert.equal(f.box.chatEl.scrollTop, 1500);
  f.queueToolFollow();
  f.scrollDown(true);
  f.frame();
  assert.equal(f.reads(), 2);
});

test("queued tool follow cannot move a different session or a reader who left the live tail", () => {
  for (const leave of [
    (b) => b.stick = false,
    (b) => b.touching = true,
    (b) => b.view.next = 120,
    (b) => b.view.gen++,
    (b) => b.document.hidden = true,
  ]) {
    const f = scrollFixture();
    f.queueToolFollow();
    leave(f.box);
    f.frame();
    assert.equal(f.reads(), 0);
    assert.equal(f.box.chatEl.scrollTop, 0);
  }
  // A tool event already in the next session must be able to queue its own frame.
  const f = scrollFixture();
  f.queueToolFollow(); f.box.view.gen++; f.queueToolFollow(); f.frame();
  assert.equal(f.reads(), 1);
});

test("composer measures the final same-frame text once and an explicit resize cancels the queued one", () => {
  let reads = 0, height = 32;
  const box = {
    inputEl: { style: {}, get scrollHeight() { reads++; return height; } },
    document: { documentElement: {} },
    MutationObserver: class { observe() {} },
  };
  const frame = frames(box);
  const grow = part(read("05-composer"), "  let growFrame = 0;", "  /** 在光标处插入");
  const { growSoon, autoGrow } = vm.runInNewContext(`${grow}\n({ growSoon, autoGrow })`, box);
  growSoon(); height = 250; growSoon();
  assert.equal(reads, 0);
  frame();
  assert.equal(reads, 1);
  assert.equal(box.inputEl.style.height, "180px");
  growSoon(); height = 32; autoGrow(); frame();
  assert.equal(reads, 2);
  assert.equal(box.inputEl.style.height, "32px");
});

test("MO.play with restart=false skips synchronous offsetWidth forced reflow", () => {
  const src = read("01-core");
  const playSrc = part(src, "    function play(el, cls, ttl, restart = true)", "    /** 退场：");
  let reflows = 0;
  const classes = new Set();
  const el = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    get offsetWidth() { reflows++; return 100; },
    getAnimations: () => [],
  };
  const timers = [];
  const box = {
    on: () => true,
    clearTimeout: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  };
  const play = vm.runInNewContext(`(${playSrc})`, box);
  play(el, "mo-tick", 1400, false);
  assert.equal(reflows, 0, "first-time play(restart=false) must not read offsetWidth");
  assert.ok(classes.has("mo-tick"));
  play(el, "mo-tick", 1400, true);
  assert.equal(reflows, 1, "explicit restart=true replays animation");
});

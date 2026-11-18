// 只提取真实地图函数：不启动浏览器、网关，也不读取用户配置。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/lineage/map.js", import.meta.url), "utf8");
const take = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
};
const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function familyFixture(sessions) {
  const BY = Object.fromEntries(sessions.map(s => [s.id, s])), down = new Map();
  for (const s of sessions) for (const id of [s.parent, ...(s.extra || []).map(e => e.id), ...(s.reads || []).filter(r => r.early).map(r => r.id)]) {
    if (id && BY[id]) { if (!down.has(id)) down.set(id, []); down.get(id).push(s.id); }
  }
  const context = { st: { BY, down } };
  vm.runInNewContext(take("    function family(", "    const pickable") + "this.family = family;", context);
  return context.family;
}

function publicFixture() {
  const removed = [], cleared = [], cancelled = [], replaced = [], released = [];
  const node = name => ({ replaceChildren() { replaced.push(name); } });
  const st = { dead: false, key: "", model: null, misc: false, band: null, pick: null,
    refs: [], sticky: [], text: [], dots: [], hits: [], treeRows: [], down: new Map(), titles: new Map(),
    raf: 13, frame: 17, zoomT: 19, moT: 23 };
  const counts = { filter: 0, relayout: 0, disconnect: 0, listeners: 0 };
  const context = { st, counts, pts: new Map([[7, {}]]), drag: {}, pinch: {},
    root: { classList: { remove: (...values) => removed.push(...values) }, innerHTML: "live" },
    layer: { main: node("main"), axis: node("axis"), band: node("band"), card: node("card") }, tree: node("tree"),
    cv: { releasePointerCapture: id => released.push(id) }, ro: { disconnect() { counts.disconnect++; } },
    listeners: [() => counts.listeners++, () => counts.listeners++],
    cancelAnimationFrame: id => cancelled.push(id), clearTimeout: id => cleared.push(id),
    filter() { counts.filter++; }, relayout() { counts.relayout++; },
    select() {}, home() {}, snapshot() {}, paintTree() {}, paint() {}, paintSelection() {}, place() {}, drawNow() { counts.now = (counts.now || 0) + 1; },
    dayStart: ms => Math.floor(ms / 86400000),
  };
  const a = source.indexOf("    return {\n      set(model"), b = source.indexOf("\n  }\n\n  window.CCLineageMap", a);
  assert.ok(a >= 0 && b > a);
  vm.runInNewContext("this.api = (() => {" + source.slice(a, b) + "})();", context);
  return Object.assign(context, { removed, cleared, cancelled, replaced, released });
}

test("地图模块仍可直接解析，不执行浏览器路径", () => { new vm.Script(source); });

test("几何缓存命中不重算；独立导出和内容/比例失效不污染已有缓存", () => {
  const st = { key: "first", geo: null }, counts = { axis: 0, layout: 0 };
  const context = { st, buildAxis: k => { counts.axis++; return { k }; }, layout: axis => { counts.layout++; return { k: axis.k }; } };
  vm.runInNewContext(take("    function geometry(", "    function tones(") + "this.geometry = geometry;", context);
  const first = context.geometry(1);
  assert.equal(context.geometry(1), first); assert.deepEqual(counts, { axis: 1, layout: 1 });
  const exported = context.geometry(2, false);
  assert.notEqual(exported, first); assert.equal(exported.L.k, 2); assert.equal(st.geo, first);
  st.key = "changed";
  const changed = context.geometry(1); assert.notEqual(changed, first);
  assert.equal(context.geometry(1), changed);
  assert.notEqual(context.geometry(0.45), changed);
  assert.deepEqual(counts, { axis: 4, layout: 4 });
});

test("时间映射和同带父子/汇合车道在不同缩放下满足独立坐标期望", () => {
  const H = 3600000, start = Date.UTC(2026, 0, 1, 12);
  const session = (id, band, patch = {}) => ({ id, band, title: id, from: start, to: start + 2 * H, ch: [], ...patch });
  const sessions = [session("root", "a"), session("child", "a", { parent: "root", at: start + H }),
    session("merge", "a", { from: start + H, extra: [{ id: "root", ts: start + H }] }), session("other", "b")];
  const st = { model: { now: start + 3 * H, bands: [{ key: "a" }, { key: "b" }] }, vis: sessions,
    BY: Object.fromEntries(sessions.map(s => [s.id, s])), titles: new Map(sessions.map(s => [s.id, { width: 40 }])) };
  const context = { st, LEFT: 112, RIGHT: 240, LANE: 46, BANDPAD: 34,
    startOf: s => s.from, endOf: s => s.to,
    dayStart: ms => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); } };
  vm.runInNewContext(take("    function buildAxis(", "    // ── 布局") + take("    function layout(", "    // 一家子") + "this.api = {buildAxis, layout};", context);
  for (const k of [0.45, 1, 1.7, 3]) {
    const axis = context.api.buildAxis(k), lanes = context.api.layout(axis);
    near(axis.width, 352 + 81 * k);
    for (let h = 0; h <= 3; h++) near(axis.X(start + h * H), 112 + h * 27 * k);
    near(axis.X(start - H), 112 - 4 * k);
    near(axis.X(start + 4 * H), 112 + 101 * k);
    assert.deepEqual(plain(lanes), { pos: { root: { lane: 0, y: 96 }, child: { lane: 1, y: 142 }, merge: { lane: 2, y: 188 }, other: { lane: 0, y: 286 } },
      bandY: [{ key: "a", y: 44, h: 180 }, { key: "b", y: 234, h: 88 }], height: 342 });
  }
});

test("跨带父子不占用父带车道，长时间空档保持压缩标记", () => {
  const H = 3600000, start = Date.UTC(2026, 0, 1, 12), sessions = [
    { id: "a", band: "a", from: start, to: start, ch: [] },
    { id: "b", band: "b", parent: "a", from: start + 48 * H, to: start + 48 * H, ch: [] },
  ];
  const st = { model: { now: start + 48 * H, bands: [{ key: "a" }, { key: "b" }] }, vis: sessions,
    BY: Object.fromEntries(sessions.map(s => [s.id, s])), titles: new Map(sessions.map(s => [s.id, { width: 40 }])) };
  const context = { st, LEFT: 112, RIGHT: 240, LANE: 46, BANDPAD: 34, startOf: s => s.from, endOf: s => s.to,
    dayStart: ms => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); } };
  vm.runInNewContext(take("    function buildAxis(", "    // ── 布局") + take("    function layout(", "    // 一家子") + "this.api = {buildAxis, layout};", context);
  const axis = context.api.buildAxis(2), lanes = context.api.layout(axis);
  assert.equal(axis.width, 440); assert.equal(axis.X(start + 48 * H), 200);
  assert.deepEqual(plain(axis.breaks), [156]);
  assert.equal(lanes.pos.a.lane, 0); assert.equal(lanes.pos.b.lane, 0);
  assert.equal(lanes.bandY[0].h, 88); assert.equal(lanes.bandY[1].y, 142);
});

test("家族关系只递归主父祖先及所选后代，不把普通 read 当接手", () => {
  const family = familyFixture([{ id: "a" }, { id: "b", parent: "a" }, { id: "c", extra: [{ id: "b" }] },
    { id: "d", reads: [{ id: "a", early: true }] }, { id: "e", reads: [{ id: "b", early: false }] }]);
  assert.deepEqual([...family("b")].sort(), ["a", "b", "c"]);
  assert.deepEqual([...family("a")].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...family("e")], ["e"]);
});

test("随机父/汇合/接手图的家族集合满足独立递归关系定义", () => {
  let seed = 1048577;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 30; round++) {
    const sessions = Array.from({ length: 80 }, (_, i) => ({ id: "s" + i, parent: i && rand(3) ? "s" + rand(i) : null,
      extra: i > 2 ? [{ id: "s" + rand(i) }] : [], reads: i > 3 ? [{ id: "s" + rand(i), early: !!rand(2) }] : [] }));
    const BY = Object.fromEntries(sessions.map(s => [s.id, s])), family = familyFixture(sessions);
    const origins = s => [s.parent, ...s.extra.map(e => e.id), ...s.reads.filter(r => r.early).map(r => r.id)].filter(id => BY[id]);
    const reference = id => {
      const found = new Set([id]);
      const ancestors = id => { for (const parent of origins(BY[id])) if (!found.has(parent)) { found.add(parent); if (parent === BY[id].parent) ancestors(parent); } };
      const descendants = id => { for (const child of sessions) if (!found.has(child.id) && origins(child).includes(id)) { found.add(child.id); descendants(child.id); } };
      ancestors(id); descendants(id); return [...found].sort();
    };
    for (const s of sessions) assert.deepEqual([...family(s.id)].sort(), reference(s.id), "round " + round + " " + s.id);
  }
});

test("长主父链的家族遍历不依赖 JavaScript 递归栈", () => {
  const sessions = Array.from({ length: 12000 }, (_, i) => ({ id: "s" + i, parent: i ? "s" + (i - 1) : null }));
  const family = familyFixture(sessions), result = family("s11999");
  assert.equal(result.size, sessions.length); assert.ok(result.has("s0"));
});

test("单选、取消和未知 ID 只更新选择层，不重新生成场景", () => {
  const calls = { paint: 0, selection: 0, place: 0, selected: [], reveal: [] };
  const st = { dead: false, model: {}, BY: { a: {}, b: {} }, drawn: {}, mode: "map", sel: null };
  const context = { st, opts: { onSelect: id => calls.selected.push(id) }, document: { documentElement: { dataset: { motion: "off" } } },
    paint() { calls.paint++; }, paintSelection() { calls.selection++; }, place() { calls.place++; }, reveal: id => calls.reveal.push(id) };
  vm.runInNewContext(take("    function select(", "    return {\n      set(model") + "this.select = select;", context);
  context.select("a"); context.select("b", { reveal: true }); context.select("missing"); context.select(null);
  assert.equal(calls.paint, 0); assert.equal(calls.selection, 4); assert.equal(calls.place, 4);
  assert.deepEqual(calls.selected, ["a", "b", null, null]); assert.deepEqual(calls.reveal, ["b"]);
  st.dead = true; context.select("a"); assert.equal(calls.selection, 4);
});

test("选中、家族、跳过多选和定时任务保持不同的色调语义", () => {
  const context = { pickable: s => !s.task && !s.trashed && !s.skip };
  vm.runInNewContext(take("    function tones(", "    function chapterLabels(") + "this.tones = tones;", context);
  assert.equal(context.tones({ id: "s" }, null, "s", new Set(["s"])).stroke, "var(--fg)");
  assert.equal(context.tones({ id: "s" }, null, "x", new Set(["x"])).on, false);
  const pick = { set: new Set(["s"]) };
  assert.equal(context.tones({ id: "s" }, pick, null, null).stroke, "var(--lm-blue)");
  assert.equal(context.tones({ id: "s", skip: true }, pick, null, null).on, false);
  assert.equal(context.tones({ id: "task", task: {} }, pick, null, null).on, false);
});

test("同值 set 保留缓存；原地修改、筛选使缓存失效；同日 now 变化只挪现在线；手势不被刷新清掉", () => {
  const f = publicFixture(), model = { now: 1, bands: [], sessions: [{ id: "a", title: "first" }] };
  f.api.set(model); assert.equal(f.counts.filter, 1);
  const cache = {}, refs = [{}]; f.st.geo = f.st.drawn = cache; f.st.refs = refs;
  f.api.set(structuredClone(model));
  assert.equal(f.counts.filter, 1); assert.equal(f.st.geo, cache); assert.equal(f.st.refs, refs);
  model.sessions[0].title = "changed"; f.api.set(model);
  assert.equal(f.counts.filter, 2); assert.equal(f.st.geo, null); assert.equal(f.st.refs.length, 0);
  f.api.set(model, { misc: true }); f.api.set(model, { band: "project" });
  assert.equal(f.counts.filter, 4);
  // now 每次心跳都变：同日变化不重建图，只挪「现在」线（新对象带新 now，数据不变）
  f.st.drawn = f.st.geo = cache; f.st.mode = "map";
  f.api.set({ ...model, now: model.now + 1 });
  assert.equal(f.counts.filter, 4); assert.equal(f.st.geo, cache); assert.equal(f.counts.now, 1);
  // 跨天变化：日期刻度要跟上，正常失效
  f.api.set({ ...model, now: model.now + 86400000 });
  assert.equal(f.counts.filter, 5); assert.equal(f.st.geo, null);
  assert.equal(f.counts.relayout, 7);
  // 手势状态不再被数据刷新打断（拖到一半来了心跳，接着拖）
  assert.equal(f.pts.size, 1); assert.ok(f.drag); assert.ok(f.pinch);
});

test("snapshot 独立计算完整几何，先读继承样式再固化，不改活地图缓存", () => {
  const AX = { width: 2000 }, L = { height: 500 }, geo = { k: 1, key: "live", AX, L };
  const st = { dead: false, model: {}, vis: [{}], mode: "map", k: 0.5, key: "live", geo, AX, L };
  const events = [], removed = [], parts = [];
  const element = name => {
    const attrs = new Map([["class", "lm-track"], ["data-lineage-id", name], ["stroke", "var(--lm-stroke)"]]);
    const node = { name, style: {}, hasAttribute: key => attrs.has(key), remove: () => removed.push(name),
      setAttribute(key, value) { events.push("write:" + name); attrs.set(key, value); }, removeAttribute: key => attrs.delete(key),
      get attributes() { return [...attrs].map(([name]) => ({ name })); },
      serialize: () => "<path " + [...attrs].map(([name, value]) => `${name}="${value}"`).join(" ") + "/>" };
    return node;
  };
  parts.push(element("parent"), element("child"), element("axis"));
  const hidden = element("hidden-read"), picked = element("picked"), early = element("early-read");
  hidden.style.display = "none"; picked.hasAttribute = name => name === "data-picked";
  const box = { style: {}, html: "", set innerHTML(value) { this.html = value; },
    querySelectorAll(selector) { assert.ok(["[data-picked],[data-read]", "svg *"].includes(selector)); return selector === "svg *" ? parts : [hidden, picked, early]; },
    querySelector(selector) {
      if (selector === ".lm-main svg") return { childNodes: parts.slice(0, 2) };
      if (selector === ".lm-axis svg") return { childNodes: parts.slice(2) };
      assert.equal(selector, ".lm-band > div"); return { band: true };
    }, remove() { removed.push("box"); } };
  let build = 0, sceneGeo;
  const context = { st, document: { createElement: () => box, body: {} }, root: { appendChild(node) { assert.equal(node, box); } },
    buildAxis(k) { build++; return { k, width: 1000, Xn: () => 900 }; }, layout: () => ({ height: 700, bandY: [{ key: "a", y: 44 }] }),
    scene(k, pick, selected, value) { assert.equal(k, 0.5); assert.equal(pick, null); assert.equal(selected, null); sceneGeo = value;
      return { W: 1000, H: 700, L: value.L, g: [], lines: ["<path/>"], labels: ["<text>all nodes</text>"], ax: [], hits: ["FORBIDDEN_HIT"] }; },
    getComputedStyle(node) { if (parts.includes(node)) events.push("read:" + node.name); return { color: "rgb(10, 20, 30)", fontFamily: "sans-serif", fontSize: "12px", fontWeight: "500", backgroundColor: "rgb(255, 255, 255)", getPropertyValue: () => "rgb(10, 20, 30)" }; },
    XMLSerializer: class { serializeToString(node) { return node.serialize(); } }, bandName: () => "Band A", esc: value => String(value), t: value => value };
  vm.runInNewContext(take("    function geometry(", "    function tones(") + take("    function snapshot(", "    // ── 卡片") + "this.snapshot = snapshot;", context);
  const result = context.snapshot({ foot: "Export" });
  assert.equal(build, 1); assert.notEqual(sceneGeo, geo);
  assert.equal(st.geo, geo); assert.equal(st.AX, AX); assert.equal(st.L, L);
  assert.equal(result.W, 1000); assert.equal(result.H, 734);
  assert.ok(box.html.includes("all nodes")); assert.ok(!box.html.includes("FORBIDDEN_HIT"));
  assert.deepEqual(events.slice(0, 3), ["read:parent", "read:child", "read:axis"]);
  assert.deepEqual(removed, ["hidden-read", "picked", "box"]);
  assert.ok(result.svg.includes("Band A") && result.svg.includes("Export"));
  assert.ok(!result.svg.includes("var(") && !result.svg.includes("data-lineage-id") && !result.svg.includes("class="));
});

test("同一帧合并绘制请求，销毁后不再排新帧", () => {
  const jobs = [], st = { dead: false, frame: 0 }; let placements = 0;
  const context = { st, requestAnimationFrame: fn => { jobs.push(fn); return jobs.length; }, place() { placements++; } };
  vm.runInNewContext(take("    function frame()", "    function zoomTo(") + "this.frame = frame;", context);
  for (let i = 0; i < 30; i++) context.frame();
  assert.equal(jobs.length, 1); assert.equal(placements, 0);
  jobs[0](); assert.equal(st.frame, 0); assert.equal(placements, 1);
  st.dead = true; context.frame(); assert.equal(jobs.length, 1);
});

test("destroy 释放监听、指针、定时器与缓存，重复销毁或迟到 API 不复活", () => {
  const f = publicFixture(); f.st.model = {}; f.st.geo = {}; f.st.drawn = {};
  f.st.down.set("a", ["b"]); f.st.titles.set("a", {});
  f.api.destroy();
  assert.equal(f.st.dead, true); assert.equal(f.counts.disconnect, 1); assert.equal(f.counts.listeners, 2);
  assert.deepEqual(f.cancelled, [13, 17]); assert.deepEqual(f.cleared, [19, 23]); assert.deepEqual(f.released, [7]);
  assert.equal(f.st.model, null); assert.equal(f.st.geo, null); assert.equal(f.st.down.size, 0); assert.equal(f.st.titles.size, 0);
  assert.equal(f.root.innerHTML, ""); assert.equal(f.pts.size, 0);
  f.api.destroy(); f.api.set({ sessions: [] }); f.api.pick(["a"]);
  assert.equal(f.counts.disconnect, 1); assert.equal(f.counts.relayout, 0); assert.equal(f.st.pick, null);
});

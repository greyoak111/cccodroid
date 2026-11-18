// 缩放预览的状态/屏幕几何回归，不依赖旧版地图源码或浏览器。
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
function fixture(width = 2000) {
  const geo = { key: "stable", k: 1, AX: { width, X: () => width - 240 }, L: { height: 500, bandY: [] } };
  const st = { model: { now: 1800000000000 }, key: "stable", geo, drawn: geo, drawK: 1, k: 1, W: width, H: 500,
    AX: geo.AX, L: geo.L, tx: -800, ty: 0, frame: 0, raf: 0, zoomT: 0 };
  const calls = { scene: 0, selection: 0, animate: [], gesture: [] };
  const context = { LEFT: 112, RIGHT: 240, st, layer: { main: { firstElementChild: {} } }, cv: { clientWidth: 1000, clientHeight: 500 },
    clearTimeout() {}, cancelAnimationFrame() {}, buildAxis: k => ({ width: 112 + (width - 352) * k + 240, X: () => 1800 }), layout: () => geo.L,
    paintSelection() { calls.selection++; }, place() {}, frame() {},
    scene() { calls.scene++; throw Error("Cached geometry must not rebuild the scene"); },
    animateTo: (x, y) => calls.animate.push({ x, y }), gesture: kind => calls.gesture.push(kind) };
  const code = [take("    function geometry(", "    function tones("), take("    function paint()", "    // ── 导出"),
    take("    function bounds()", "    const styleTo"), take("    function zoomTo(", "    function commitZoom("),
    take("    const nowX =", "    function animateTo("), take("    function home()", "    // 选中某个会话")].join("\n");
  vm.runInNewContext(code + "this.api = {zoomTo, home, paint, bounds};", context);
  return { st, calls, api: context.api, geo };
}

test("未提交放大后 home 恢复精确 1x 尺寸及平移边界，不重建缓存场景", () => {
  const f = fixture(); f.api.zoomTo(2, 400, 1088); assert.equal(f.st.W, 3648);
  f.api.home();
  assert.equal(f.st.k, 1); assert.equal(f.st.drawK, 1); assert.equal(f.calls.scene, 0);
  assert.equal(f.st.W, 2000); assert.equal(f.st.H, 500);
  assert.equal(f.st.AX, f.geo.AX); assert.equal(f.st.L, f.geo.L);
  assert.equal(f.api.bounds().minX, -1000); assert.equal(f.calls.animate[0].x, -920);
  f.api.paint(); f.api.home();
  assert.equal(f.st.W, 2000); assert.equal(f.api.bounds().minX, -1000); assert.equal(f.calls.animate[1].x, -920);
});

test("未提交缩小期间可见的现在按钮真正回到屏内，而非沿用预览右界", () => {
  const f = fixture(3000); f.api.zoomTo(0.5, 400, 1088); assert.equal(f.st.W, 1676);
  const previewNow = 112 + (f.st.AX.X(f.st.model.now) - 112) * 0.5 + f.st.tx;
  assert.equal(previewNow, 1180); assert.ok(previewNow > 990);
  f.api.home();
  assert.equal(f.st.k, 1); assert.equal(f.st.W, 3000); assert.equal(f.api.bounds().minX, -2000);
  assert.equal(f.calls.animate[0].x, -1920);
  const now = f.st.AX.X(f.st.model.now) + f.calls.animate[0].x;
  assert.equal(now, 840); assert.ok(now >= 0 && now <= 1000);
  f.api.paint(); f.api.home(); assert.equal(f.st.W, 3000); assert.equal(f.calls.animate[1].x, -1920);
});

test("同一精确缓存从放大或缩小预览返回 home 后，多次 paint 都保持真实宽高", () => {
  for (const width of [2000, 3000]) for (const ratio of [0.45, 0.5, 1.7, 2, 3]) {
    const f = fixture(width); f.api.zoomTo(ratio, 400, 1088); assert.notEqual(f.st.W, width);
    f.api.home(); f.api.paint(); f.api.paint();
    assert.equal(f.st.W, width); assert.equal(f.st.H, 500);
    assert.equal(f.calls.animate[0].x, 1000 - width + 80); assert.equal(f.calls.scene, 0);
  }
});

test("真实多选圆环及勾路径均进入补偿索引，在预览缩放中保持相同屏幕几何", () => {
  const st = { dead: false, AX: { width: 2000, X: () => 1800 }, k: 1, drawK: 1, tx: -1000, ty: 0, W: 2000,
    model: { now: 1800000000000 }, sticky: [], text: [], dots: [], hits: [], ratio: 1, titles: new Map(), BY: {} };
  const shapes = [];
  const matches = (node, selector) => selector === "circle" ? node.tag === "circle" : selector === "[data-zoom-x]" ? node.getAttribute("data-zoom-x") !== null : false;
  const query = selector => shapes.filter(node => selector.split(",").some(s => matches(node, s.trim())));
  const layer = { main: { style: {}, querySelectorAll: query }, axis: { style: {}, querySelectorAll: () => [] },
    band: { style: {} }, now: { classList: { toggle() {} } } };
  const context = { st, layer, root: { querySelector: () => ({}) }, family() { throw Error("No selection expected"); }, cv: { clientWidth: 1000 }, LEFT: 112 };
  vm.runInNewContext(take("    function pickMark(", "    function scene(") + take("    function indexScene()", "    function paintSelection(") +
    take("    const styleTo", "    function frame(") + "this.api = {pickMark, indexScene, place};", context);
  const mark = context.api.pickMark(500, 100);
  for (const m of mark.matchAll(/<(circle|path)\b([^>]*)>/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    shapes.push({ tag: m[1], attrs, getAttribute: name => attrs[name] ?? null,
      setAttribute: (name, value) => attrs[name] = value, removeAttribute: name => delete attrs[name] });
  }
  assert.equal(shapes.length, 2);
  const ring = shapes.find(s => s.tag === "circle"), check = shapes.find(s => s.tag === "path");
  context.api.indexScene();
  assert.ok(st.dots.includes(ring)); assert.ok(st.dots.includes(check));
  const d = check.getAttribute("d").match(/^M([\d.-]+) [\d.-]+ l([\d.-]+) [\d.-]+ l([\d.-]+) [\d.-]+$/); assert.ok(d);
  const rawLeft = +d[1], rawRight = rawLeft + (+d[2]) + (+d[3]);
  const local = (node, x) => {
    const value = node.getAttribute("transform"); if (value === null) return x;
    const m = value.match(/^translate\(([\d.eE+-]+) 0\) scale\(([\d.eE+-]+) 1\) translate\(([\d.eE+-]+) 0\)$/);
    assert.ok(m); return +m[1] + (+m[2]) * (x + (+m[3]));
  };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  for (const ratio of [3, 0.45, 1.3, 1]) {
    st.k = ratio; context.api.place();
    assert.equal(ring.getAttribute("transform"), check.getAttribute("transform"));
    const toScreen = x => st.tx + 112 + (x - 112) * ratio, center = toScreen(500);
    const ringLeft = toScreen(local(ring, 500 - (+ring.getAttribute("r")))), ringRight = toScreen(local(ring, 500 + (+ring.getAttribute("r"))));
    const checkLeft = toScreen(local(check, rawLeft)), checkRight = toScreen(local(check, rawRight));
    near(ringLeft - center, -6.5); near(ringRight - center, 6.5);
    near(checkLeft - center, -3); near(checkRight - center, 3.2); near(checkRight - checkLeft, 6.2);
    assert.ok(checkLeft >= ringLeft && checkRight <= ringRight);
    if (ratio === 1) { assert.equal(ring.getAttribute("transform"), null); assert.equal(check.getAttribute("transform"), null); }
  }
});

// 任务清单的 ✕：没做完、会话又跑起来时也能收；同一份清单接着做不再冒出来，换了一份才露出来
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/03-perm-status.js", import.meta.url), "utf8");
const take = (start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

function box() {
  const b = {
    view: { tasks: null, tasksHide: "" }, srv: { run: null },
    localStorage: { getItem: () => null }, esc: (x) => String(x), uiI: (n) => "<" + n + ">", t: (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o?.[n]),
  };
  vm.runInNewContext(take("  let tasksOpen =", "  function renderRunStrip()") + "\nglobalThis.html = tasksHtml; globalThis.sig = tasksSig;", b);
  return b;
}
const L = (...st) => st.map((s, i) => ({ id: String(i + 1), subject: "t" + i, status: s }));

test("做到一半：收起后继续会话，清单在跑时露出来也有 ✕，叉掉后进度再变也不冒出来", () => {
  const b = box();
  b.view.tasks = L("completed", "pending", "pending");
  assert.match(b.html(), /rs-tx/, "没在跑：有 ✕");
  b.view.tasksHide = b.sig(b.view.tasks);
  assert.equal(b.html(), "");
  // 继续会话：跑起来了，同一份清单进度变了
  b.srv.run = { id: "r1" };
  b.view.tasks = L("completed", "in_progress", "pending");
  assert.equal(b.html(), "", "同一份清单接着做，不再冒出来");
  // claude 另加了一项：换了一份清单，露出来，而且在跑时也有 ✕（以前这里叉不掉）
  b.view.tasks = L("completed", "in_progress", "pending", "pending");
  assert.match(b.html(), /rs-tx/);
  b.view.tasksHide = b.sig(b.view.tasks);
  assert.equal(b.html(), "", "第二次也叉得掉");
});

test("旧版存下的「编号:状态」指纹照样认", () => {
  const b = box();
  b.view.tasks = L("completed", "pending");
  b.view.tasksHide = "1:completed,2:pending";
  assert.equal(b.html(), "");
});

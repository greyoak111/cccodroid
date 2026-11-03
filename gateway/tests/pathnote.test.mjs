// 文件全路径提醒：回复只提文件名就给下一轮记一条；写了全路径、没提这个文件、子代理写的都不算
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";

const W = "/data/user/0/cc.codroid/files/home/workspace";
const asst = (content, extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });
const write = (p, name = "Write") => ({ type: "tool_use", id: "t" + Math.random(), name, input: { file_path: p } });
const say = (text) => ({ type: "text", text });

test("只提了文件名 / 相对路径：记下来，下一轮取一次就清", async () => {
  const { pathWatch, settlePathNote, takePathNote } = await import("../gw/pathnote.mjs");
  const w = pathWatch();
  w.feed(asst([write(`${W}/game/index.html`), write(`${W}/game/main.js`, "Edit")]));
  w.feed(asst([say("写好了 index.html，逻辑在 `game/main.js` 里。")]));
  assert.deepEqual(w.lazy().map((x) => x.said), ["index.html", "game/main.js"]);
  settlePathNote("s1", w);
  const n = takePathNote("s1");
  assert.match(n, /index\.html → \/data\/user\/0\/cc\.codroid\/files\/home\/workspace\/game\/index\.html/);
  assert.match(n, /starting with \//);
  assert.equal(takePathNote("s1"), "");
});

test("写了全路径、压根没提、只是名字的一部分：都不算偷懒；这一轮写对了清掉旧提醒", async () => {
  const { pathWatch, settlePathNote, takePathNote } = await import("../gw/pathnote.mjs");
  const lazy = pathWatch();
  lazy.feed(asst([write(`${W}/a.html`)])); lazy.feed(asst([say("a.html 好了")]));
  settlePathNote("s2", lazy);
  const good = pathWatch();
  good.feed(asst([write(`${W}/a.html`), write(`${W}/data.json`), write(`${W}/x/app.js`)]));
  good.feed(asst([say(`打开 ${W}/a.html 看效果。我还顺手调了配置，myapp.js 没动。`)]));
  assert.deepEqual(good.lazy(), []);
  settlePathNote("s2", good);
  assert.equal(takePathNote("s2"), "");
});

test("子代理写的、子代理说的不算；只认 Write / Edit / MultiEdit / NotebookEdit", async () => {
  const { pathWatch } = await import("../gw/pathnote.mjs");
  const w = pathWatch();
  w.feed(asst([write(`${W}/sub.html`)], { parent_tool_use_id: "toolu_1" }));
  w.feed(asst([{ type: "tool_use", id: "r", name: "Read", input: { file_path: `${W}/read.md` } }]));
  w.feed(asst([say("sub.html 和 read.md 都看过了")]));
  assert.deepEqual(w.lazy(), []);
});

test("常驻规则带上当前目录举例", async () => {
  const { previewHint } = await import("../gw/pathnote.mjs");
  const h = previewHint("/sdcard/proj");
  assert.match(h, /`\/sdcard\/proj\/index\.html`/);
  assert.match(h, /Only full absolute paths are tappable/);
  assert.match(h, /don.t wrap it in a Markdown link or a file:\/\/ URL/);
});

// 模型常把路径包成 [路径](file:///…) 或写裸 file:///…，以前原样显示点不开（11-03 会话包）
test("前端：file:// 链接和裸 file:/// 也认成路径；解出引号尖括号的不认", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
  const a = src.indexOf("  const PATH_RE ="), b = src.indexOf("\n  }\n", src.indexOf("  function inlineMd(s)")) + 4;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const md = new Function("esc", "t", "mdImg", src.slice(a, b) + "\nreturn inlineMd;")(esc, (x) => x, null);
  const paths = (s) => [...md(s).matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths("**[/data/a/报告.md](file:///data/a/%E6%8A%A5%E5%91%8A.md)**"), ["/data/a/报告.md"]);
  assert.deepEqual(paths("[x](file:///data/a.js:12)"), ["/data/a.js"]);
  assert.deepEqual(paths("见 file:///sdcard/x/y.html。"), ["/sdcard/x/y.html"]);
  assert.match(md("见 file:///sdcard/x/y.html。"), /<\/a>。$/);
  assert.deepEqual(paths("[x](file:///data/a%22b%3Cc)"), []);
  assert.deepEqual(paths("[x](file:///data/%E0%A4%A)"), []);
  assert.deepEqual(paths("file:////etc/x"), []);
});

test("前端：裸 file:/// 的行号留在链接文字里，文件名末尾的 ! 不剥（0601b 复核）", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
  const a = src.indexOf("  const PATH_RE ="), b = src.indexOf("\n  }\n", src.indexOf("  function inlineMd(s)")) + 4;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const md = new Function("esc", "t", "mdImg", src.slice(a, b) + "\nreturn inlineMd;")(esc, (x) => x, null);
  assert.match(md("看 file:///data/a.js:12。"), /data-path="\/data\/a\.js"[^>]*>\/data\/a\.js:12<\/a>。$/);
  assert.match(md("file:///sdcard/wow!.jpg"), /data-path="\/sdcard\/wow!\.jpg"/);
  assert.match(md("**file:///sdcard/x.md**"), /<strong><a [^>]*data-path="\/sdcard\/x\.md"/);
});

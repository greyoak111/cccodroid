// 由「序号<TAB>译文」的文本文件生成 lang-<code>.js
//   行首 @ 表示这一行是原始 JS 表达式（复数等），其余按普通字符串处理
//   译文里写 \n 会作为换行转义写进 JS 字符串
//   生成前校验：1..N 每个序号恰好出现一次，否则报错退出
import fs from "node:fs";
import vm from "node:vm";
import { i18nFnProblem } from "./fnsafe.mjs";
const [src, tpl, out, name] = process.argv.slice(2);
const keys = [...fs.readFileSync(tpl, "utf8").matchAll(/^  "((?:[^"\\]|\\.)*)":/gm)].map((m) => JSON.parse('"' + m[1] + '"'));
const vals = new Map();
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  if (!line.trim() || line.startsWith("//")) continue;
  const t = line.indexOf("\t");
  if (t < 0) { console.error("没有制表符： " + line.slice(0, 40)); process.exit(1); }
  const i = Number(line.slice(0, t));
  if (!Number.isInteger(i) || i < 1 || i > keys.length) { console.error("序号越界：" + line.slice(0, 20)); process.exit(1); }
  if (vals.has(i)) { console.error("序号重复：" + i); process.exit(1); }
  const v = line.slice(t + 1);
  // @ 行原样进界面执行，只放行复数之类的几种形状（fnsafe.mjs）
  if (v.startsWith("@") && !v.startsWith("@@")) { const p = i18nFnProblem(v.slice(1)); if (p) { console.error(`第 ${i} 条的 @ 行不合规（${p}）：` + v.slice(0, 60)); process.exit(1); } }
  vals.set(i, v);
}
const miss = [];
for (let i = 1; i <= keys.length; i++) if (!vals.has(i)) miss.push(i);
if (miss.length) { console.error(`缺 ${miss.length} 条：${miss.slice(0, 30).join(",")}${miss.length > 30 ? " …" : ""}`); process.exit(1); }
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\\\\n/g, "\\n");
const lines = keys.map((k, n) => {
  const v = vals.get(n + 1);
  // 行首 @@ 表示译文本身就以 @ 开头（转义）
  const body = v.startsWith("@@") ? '"' + esc(v.slice(1)) + '"'
    : v.startsWith("@") ? v.slice(1) : '"' + esc(v) + '"';
  return "  " + JSON.stringify(k) + ": " + body + ",";
});
// 注册名取「（」之前的部分（可用 name 附带说明），生成和自检必须用同一个名字，
// 否则调用时 name 带「（」会让自检查不到条目、误报 0 条
const dictName = name.split("（")[0];
fs.writeFileSync(out,
  `// ${name} dictionary: Chinese source text (the key) → ${name}.  See i18n.js / langs.js for the rules.\n` +
  `window.I18N_DICT = window.I18N_DICT || {};\nwindow.I18N_DICT[${JSON.stringify(dictName)}] = {\n` +
  lines.join("\n") + "\n};\n");
// 运行期自检：语法对不代表值对（例如以 @ 开头的译文会变成未定义标识符，node --check 查不出来）
const out_src = fs.readFileSync(out, "utf8");
const box = { window: {} };
vm.runInNewContext(out_src, box, { filename: out });
const got = (box.window.I18N_DICT || {})[dictName] || {};
const bad = Object.entries(got).filter(([, v]) => typeof v !== "string" && typeof v !== "function");
if (Object.keys(got).length !== keys.length) { console.error(`✗ 条目数不对：${Object.keys(got).length} ≠ ${keys.length}`); process.exit(1); }
if (bad.length) { console.error(`✗ ${bad.length} 条值不是字符串/函数：` + bad.slice(0, 5).map(([k, v]) => k + "=" + String(v).slice(0, 20)).join(" | ")); process.exit(1); }
console.log(`✓ ${out}（${keys.length} 条）`);

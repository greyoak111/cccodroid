// 读屏跳过密码框（android/java/cc/codroid/A11y.java）：Java 侧本机跑不了，只能核源码；外加 A11y 用到的外壳文案九种语言都有
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SRC = fs.readFileSync(new URL("../../android/java/cc/codroid/A11y.java", import.meta.url), "utf8");
const body = (name) => {
  const i = SRC.indexOf(name);
  assert.ok(i >= 0, "找不到 " + name);
  return SRC.slice(i, SRC.indexOf("\n    }\n", i));
};

test("读屏：密码框的内容和描述在输出之前清掉，框照样列出、标 password", () => {
  const w = body("private static void walk(");
  const clear = w.indexOf("if (pw) { text = null; desc = null; }"), firstOut = w.indexOf("out.append");
  assert.ok(w.includes("n.isPassword()"), "要看 isPassword");
  assert.ok(clear > 0 && clear < firstOut, "内容和描述都要在第一次 out.append 之前清掉");
  assert.match(w, /boolean useful = all \|\| pw \|\|/, "密码框不管能不能点都要列出来");
  assert.match(w, /if \(pw\) out\.append\(" password"\)/);
  assert.equal((w.match(/getText\(\)/g) || []).length, 1, "walk 里只能在开头读一次 getText");
});

test("填字：密码框不许 append（append 要先读原有内容）", () => {
  const t = body("static JSONObject type(");
  const guard = t.indexOf("n.isPassword()"), read = t.indexOf("n.getText()");
  assert.ok(guard > 0 && guard < read, "密码框的拦截要在读原有内容之前");
});

test("A11y.java 用到的外壳文案九种语言都有", () => {
  const keys = [...SRC.matchAll(/Tr\.t\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => JSON.parse('"' + m[1] + '"'));
  assert.ok(keys.length > 5);
  for (const l of ["en", "zh-Hant", "ja", "ko", "fr", "es", "ru", "ar", "id"]) {
    const d = JSON.parse(fs.readFileSync(new URL(`../../android/assets/i18n/java-${l}.json`, import.meta.url), "utf8"));
    for (const k of keys) assert.ok(d[k], `java-${l}.json 缺：${k}`);
  }
});

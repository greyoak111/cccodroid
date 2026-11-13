// 界面语言：网关从 X-CC-Lang 记住最近一次界面语言（server.mjs 每个过了来源校验的请求都会调用 reqLang）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAST_LANG, reqLang } from "../gw/config.mjs";

test("reqLang：合法 X-CC-Lang 更新，缺头 / 非法值保留上一次", () => {
  assert.equal(reqLang({ headers: { "x-cc-lang": "en" } }), "en");
  assert.equal(LAST_LANG, "en");
  assert.equal(reqLang({ headers: {} }), "en", "没带头时保留上一次");
  assert.equal(reqLang({ headers: { "x-cc-lang": "bad!" } }), "en", "非法值不覆盖");
  assert.equal(reqLang({ headers: { "x-cc-lang": "zh-Hant" } }), "zh-Hant");
  assert.equal(reqLang(null), "zh-Hant");
});

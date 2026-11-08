// 主会话的零碎回归：0.6.9 审计 196-凭据.2 等
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsUrlOk } from "../gw/providers.mjs";

test("196-凭据.2：清单地址和 baseUrl 端口不同 → 不带 Key 去拉", () => {
  const ok = (b, m) => modelsUrlOk({ baseUrl: b, modelsUrl: m });
  assert.equal(ok("https://api.example.com", "https://api.example.com:8443/models"), false);
  assert.equal(ok("http://127.0.0.1:3459", "http://127.0.0.1:9999/models"), false);
  assert.equal(ok("http://127.0.0.1:3459/v1", "http://127.0.0.1:3459/v1/models"), true);
  assert.equal(ok("https://api.example.com/anthropic", "https://api.example.com:443/v1/models"), true, "默认端口写不写都一样");
});

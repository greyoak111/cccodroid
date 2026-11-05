// 余额查询认厂商（gw/providers.mjs billKind）：只认主机名完全一致的 https 官方地址（GHSA-4cfj）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { billKind } from "../gw/providers.mjs";

test("官方地址照认", () => {
  assert.equal(billKind({ baseUrl: "https://api.deepseek.com/anthropic" }).kind, "deepseek");
  assert.equal(billKind({ baseUrl: "https://api.moonshot.cn/anthropic" }).host, "https://api.moonshot.cn");
  assert.equal(billKind({ baseUrl: "https://open.bigmodel.cn/api/anthropic" }).kind, "glm");
  assert.equal(billKind({ baseUrl: "https://openrouter.ai/api" }).kind, "openrouter");
});

test("前缀相同的代理、带账号、非 https、坏地址：不认，密钥不会被发去官方主机", () => {
  for (const u of ["https://api.deepseek.com.gateway.example/anthropic", "https://api.moonshot.cn.evil.example", "https://open.bigmodel.cn.x.io/api",
    "https://openrouter.ai.proxy.example/api", "https://x.example/?u=//api.deepseek.com", "https://api.deepseek.com@evil.example/",
    "https://user:pw@api.deepseek.com/anthropic", "http://api.deepseek.com/anthropic", "not a url", ""])
    assert.equal(billKind({ baseUrl: u }).kind, "none", u);
});

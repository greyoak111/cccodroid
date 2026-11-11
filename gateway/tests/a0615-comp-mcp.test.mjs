// MCP 组件：索引里的 mcp: { name, bin } 只收白名单内的名字和命令，别的一律当没有
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("compMcpSpec：名字、命令过白名单；参数、路径、怪字符都不收", async () => {
  const { compMcpSpec } = (await import("../gw/components.mjs"))._compForTest;
  assert.deepEqual(compMcpSpec({ mcp: { name: "bilibili", bin: "bilibili-mcp" } }), { name: "bilibili", bin: "bilibili-mcp" });
  assert.deepEqual(compMcpSpec({ mcp: { name: "bili-groups", bin: "bili-groups-mcp", args: ["--evil"], env: { X: "1" } } }), { name: "bili-groups", bin: "bili-groups-mcp" }, "多余字段丢掉");
  for (const bad of [{ name: "-x", bin: "a" }, { name: "a", bin: "../sh" }, { name: "a", bin: "/bin/sh" }, { name: "A b", bin: "a" }, { name: "a", bin: "-c" }, { name: "", bin: "a" }, "str", null])
    assert.equal(compMcpSpec({ mcp: bad }), null, JSON.stringify(bad));
  assert.equal(compMcpSpec({}), null);
});

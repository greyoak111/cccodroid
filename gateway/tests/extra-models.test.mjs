// 自定义接口另加型号（11-07 群友：中转站加好之后只有默认那一个型号，想再加几个）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import { withConfigured, extraModelsOf, cachedModels, fetchModels } from "../gw/models.mjs";
import { upsertProvider, providerById } from "../gw/providers.mjs";
import { claudeEnv } from "../gw/claude.mjs";

const P = (o) => ({ id: "custom-xm", custom: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", defaultModel: "m-a", ...o });

test("另加的型号接在后面；同名不重复；没写窗口的按这家声明的窗口", () => {
  const p = P({ contextWindow: 1048576, extraModels: [{ id: "m-b", contextWindow: 256000 }, { id: "m-c" }, { id: "m-a" }, { id: "m-b" }] });
  assert.deepEqual(withConfigured([], p).map((m) => [m.id, m.context_window]), [["m-a", 1048576], ["m-b", 256000], ["m-c", 1048576]]);
  // 上游清单拉到了：清单里没有的才补
  assert.deepEqual(withConfigured([{ id: "up-1", context_window: 0 }, { id: "m-c", context_window: 64000 }], p).map((m) => m.id), ["up-1", "m-c", "m-b", "m-a"]);   // m-a 也写在另加里，清单没有就补
  // 预置厂商、端侧不吃这个字段
  assert.deepEqual(withConfigured([{ id: "x" }], { ...p, custom: false }).map((m) => m.id), ["x"]);
});

test("配置能分享导入、也能手改：形状不对的丢掉，最多 64 个", () => {
  const bad = [{ id: "ok-1" }, { id: "带空格 不行" }, { id: "" }, { id: 3 }, null, { id: "x".repeat(129) }, { id: "ok-2", contextWindow: 99 }];
  assert.deepEqual(extraModelsOf({ extraModels: bad }), [{ id: "ok-1", contextWindow: 0 }, { id: "ok-2", contextWindow: 0 }]);
  assert.equal(extraModelsOf({ extraModels: Array.from({ length: 80 }, (_, i) => ({ id: "m" + i })) }).length, 64);
  assert.deepEqual(extraModelsOf({ extraModels: "m-a" }), []);
});

test("接口卡保存：存进配置、清单里出现、选它时下发它的窗口；空数组清掉；坏名字拒收", async () => {
  const r = upsertProvider("", { label: "中转", baseUrl: "http://127.0.0.1:1", defaultModel: "m-a", contextWindow: 1048576,
    extraModels: [{ id: "m-b", contextWindow: 256000 }, { id: "m-c", contextWindow: 0 }] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.provider.extraModels, [{ id: "m-b", contextWindow: 256000 }, { id: "m-c", contextWindow: 0 }]);
  const p = providerById(r.id);
  assert.deepEqual((await fetchModels(true, p)).map((m) => m.id), ["m-a", "m-b", "m-c"]);
  assert.deepEqual(cachedModels(p).map((m) => m.id), ["m-a", "m-b", "m-c"]);
  const env = claudeEnv({ model: "m-b", provider: p });
  assert.equal(env.ANTHROPIC_MODEL, "m-b");
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "256000");
  assert.equal(upsertProvider(r.id, { extraModels: [{ id: "a b" }] }).error, "bad_extra_models");
  assert.equal(upsertProvider(r.id, { extraModels: [{ id: "m-d", contextWindow: 5 }] }).error, "bad_context_window");
  assert.ok(upsertProvider(r.id, { extraModels: [] }).ok);
  assert.equal(providerById(r.id).extraModels, undefined);
  assert.deepEqual((await fetchModels(true, providerById(r.id))).map((m) => m.id), ["m-a"]);
});

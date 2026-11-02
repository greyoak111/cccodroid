import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { componentHostApiFields } from "../../devkit/component-host-api.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("build sidecar host capability accepts only a nonempty named integer requirement", () => {
  assert.deepEqual(componentHostApiFields({}), {});
  assert.deepEqual(componentHostApiFields({ hostApi: { remoteSession: 1 } }), { hostApi: { remoteSession: 1 } });
  assert.deepEqual(componentHostApiFields({ hostApi: { remoteSession: 2 } }), { hostApi: { remoteSession: 2 } });
  for (const hostApi of [undefined, null, false, [], {}, "1", { remoteSession: 0 }, { remoteSession: "1" }, { remoteSession: 1.5 }, { remoteSession: Number.MAX_SAFE_INTEGER + 1 }, { other: 1 }, { remoteSession: 1, other: 1 }]) {
    assert.throws(() => componentHostApiFields({ hostApi }), /hostApi/);
  }
});

test("preset index preserves requirements per historical build and never copies them from the recipe", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-index-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "components.json"), input = path.join(dir, "component-remote-session.json");
  const sidecar = { id: "remote-session", version: "0.1.0-local", base: { gz: "b".repeat(64) }, gz: { file: "payload.tar.gz", sha256: "c".repeat(64), bytes: 123 }, installed: 456, packages: [], bin: [], hostApi: { remoteSession: 1 } };
  fs.writeFileSync(out, JSON.stringify({ schema: 1, components: { "remote-session": { hostApi: { remoteSession: 9 }, builds: [{ base: "a".repeat(64), version: "old" }] } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(INDEX_SIGNING_|CCAPP_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_)/.test(key)));
  env.HOME = dir;
  const run = () => {
    fs.writeFileSync(input, JSON.stringify(sidecar));
    return spawnSync(process.execPath, [path.join(root, "devkit/components-index.mjs"), out, "https://example.invalid/unpublished/", input], { env, cwd: dir, encoding: "utf8" });
  };
  assert.equal(run().status, 0);
  let builds = JSON.parse(fs.readFileSync(out, "utf8")).components["remote-session"].builds;
  assert.deepEqual(builds[0].hostApi, { remoteSession: 1 });
  assert.equal(Object.hasOwn(builds[1], "hostApi"), false);
  sidecar.base.gz = "d".repeat(64); delete sidecar.hostApi;
  assert.equal(run().status, 0);
  builds = JSON.parse(fs.readFileSync(out, "utf8")).components["remote-session"].builds;
  assert.equal(Object.hasOwn(builds[0], "hostApi"), false);
  assert.deepEqual(builds[1].hostApi, { remoteSession: 1 });
  assert.equal(fs.existsSync(out + ".sig"), false);
  const before = fs.readFileSync(out);
  sidecar.hostApi = {};
  const invalid = run();
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /hostApi/);
  assert.deepEqual(fs.readFileSync(out), before);
});

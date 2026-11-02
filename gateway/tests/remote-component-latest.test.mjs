import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { remoteCandidateManifest } from "../../scripts/remote-candidate-manifest.mjs";
import { isCoreAppPart } from "../gw/app-parts.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
test("host candidate label and version follow the current manifest instead of the old baseline", () => {
  const source = fs.readFileSync(new URL("android/AndroidManifest.xml", root), "utf8");
  const version = /android:versionName="([^"]+)"/.exec(source)[1];
  const candidate = remoteCandidateManifest(source);
  assert.equal(candidate.version, version + "-component-host-candidate");
  assert.ok(candidate.xml.includes('android:label="CC Component Host Candidate"'));
  assert.ok(candidate.xml.includes(`android:versionName="${candidate.version}"`));
  assert.ok(candidate.xml.includes('package="cc.codroid"'));
  assert.ok(!candidate.xml.includes('android:versionName="0.5.15-remote-candidate"'));
});

test("developer bundle checker and bridge fixture use the production optional-part selection", () => {
  for (const name of ["13r-remote-transport.js", "13s-remote-view.js", "13t-remote-settings.js"]) assert.equal(isCoreAppPart(name), false);
  assert.equal(isCoreAppPart("13q-remote-component-host.js"), true);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/appjs.mjs", root))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("13r-remote-transport.js"));
  const fixture = fs.readFileSync(new URL("gateway/tests/fixtures/managed-ui-server.mjs", root), "utf8");
  assert.match(fixture, /filter\(isCoreAppPart\)/);
});

test("future manifest versions stay explicitly test-only and malformed input is rejected", () => {
  const future = remoteCandidateManifest('<manifest android:versionName="0.9.3"><application android:label="cccodroid"/></manifest>');
  assert.equal(future.version, "0.9.3-component-host-candidate");
  assert.throws(() => remoteCandidateManifest('<manifest android:versionName="bad version"/>'));
  assert.throws(() => remoteCandidateManifest('<manifest><application android:label="cccodroid"/></manifest>'));
});

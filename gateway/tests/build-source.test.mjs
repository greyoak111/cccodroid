import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPublicBuildSource } from "../../scripts/check-public-build-source.mjs";

// All fixtures are synthetic. Never read a real private policy, signing key, gateway or user HOME.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-public-build-source-")), src = path.join(root, "gateway");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text = "export {};\n") => {
    const file = path.join(src, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  for (const rel of ["server.mjs", "gw/components.mjs", "archive/cc-archive.mjs", "guard/cc-guard.mjs",
    "web/app/main.js", "web/index.html"]) put(rel);
  return { root, src, put };
}

const rejects = (src, code) => assert.throws(() => checkPublicBuildSource(src), (e) => e.code === code);

test("ordinary host sources pass without imports, execution or writes", (t) => {
  const f = fixture(t), marker = path.join(f.root, "must-not-exist");
  const file = f.put("server.mjs", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  const before = fs.readFileSync(file), st = fs.statSync(file);
  assert.deepEqual(checkPublicBuildSource(f.src), { files: 6 });
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, st.mtimeMs);
});

test("private module filenames are rejected before opening their contents", (t) => {
  for (const rel of ["gw/private-delivery-policy.mjs", "gw/private-remote-bundle.mjs", "web/app/private-feature.mjs"]) {
    const f = fixture(t);
    // A dangling link proves filename rejection does not need to open the policy target.
    fs.symlinkSync("missing-synthetic-policy", path.join(f.src, rel));
    rejects(f.src, "BUILD_SOURCE_PRIVATE_MODULE");
  }
});

test("static, side-effect, export and dynamic private references are rejected", (t) => {
  const f = fixture(t);
  for (const code of [
    "import { policy } from './private-delivery-policy.mjs';",
    "import './private-remote-bundle.mjs';",
    "export { value } from './private-helper.mjs';",
    "export * from './private-helper.mjs';",
    "const x = import('./private-helper.mjs');",
    "const x = import(`./private-helper.mjs?candidate=1`);",
    "import { x }\n  from \"./private-helper.mjs\";",
  ]) {
    f.put("gw/components.mjs", code);
    rejects(f.src, "BUILD_SOURCE_PRIVATE_REFERENCE");
  }
});

test("references in server, web, archive and guard are checked too", (t) => {
  for (const rel of ["server.mjs", "archive/cc-archive.mjs", "guard/cc-guard.mjs", "web/app/main.js", "web/index.html"]) {
    const f = fixture(t);
    f.put(rel, "import './private-source.mjs';\n");
    rejects(f.src, "BUILD_SOURCE_PRIVATE_REFERENCE");
  }
});

test("source symlinks are rejected without traversing their targets", (t) => {
  const f = fixture(t), file = f.put("gw/components.mjs");
  fs.unlinkSync(file);
  fs.symlinkSync("missing-synthetic-module", file);
  rejects(f.src, "BUILD_SOURCE_SYMLINK");
  fs.unlinkSync(file);
  f.put("gw/components.mjs");
  const link = path.join(f.root, "linked-gateway");
  fs.symlinkSync(f.src, link);
  rejects(link, "BUILD_SOURCE_SYMLINK");
  fs.symlinkSync("missing-synthetic-directory", path.join(f.src, "web", "linked"));
  rejects(f.src, "BUILD_SOURCE_SYMLINK");
});

test("copy exclusions stay excluded and remote business/test directories are not scanned", (t) => {
  const f = fixture(t);
  for (const rel of ["gw/remote/private-runtime.mjs", "tests/private-fixture.mjs", "web/old.bak/private-example.mjs",
    "web/.hidden/private-example.mjs", "web/app/13r-remote-transport.js", "web/app/13s-remote-view.js",
    "web/app/13t-remote-settings.js", "web/remote-view.css", "web/remote-settings.css"]) {
    f.put(rel, "import './private-business.mjs';\n");
  }
  assert.deepEqual(checkPublicBuildSource(f.src), { files: 6 });
});

test("hidden files inside copied web subdirectories are not silently omitted", (t) => {
  const f = fixture(t);
  f.put("web/app/.hidden.mjs", "import './private-hidden.mjs';\n");
  rejects(f.src, "BUILD_SOURCE_PRIVATE_REFERENCE");
});

test("missing or incomplete gateway source fails closed", (t) => {
  const f = fixture(t);
  rejects("", "BUILD_SOURCE_INVALID");
  fs.unlinkSync(path.join(f.src, "server.mjs"));
  assert.throws(() => checkPublicBuildSource(f.src));
});

test("local host candidate also checks its source before preparing build output", () => {
  const script = fs.readFileSync(new URL("../../scripts/build-remote-candidate.mjs", import.meta.url), "utf8");
  const check = script.indexOf('checkPublicBuildSource(path.join(root, "gateway"))');
  assert.ok(check > 0); assert.ok(check < script.indexOf('fs.mkdirSync(out'));
  assert.ok(check < script.indexOf('run("javac"'));
});

test("build preflight is wired before signing checks and destructive asset preparation", () => {
  // Read the shell script only; never run the build or inspect signing material.
  const script = fs.readFileSync(new URL("../../scripts/build.sh", import.meta.url), "utf8");
  const check = script.indexOf('node "$ROOT/scripts/check-public-build-source.mjs" "$SRC"');
  assert.ok(check > script.indexOf('SRC=${SRC:-$ROOT/gateway}'));
  assert.ok(check < script.indexOf('[ -n "$KS" ] || [ -f "$KEY" ]'));
  assert.ok(check < script.indexOf('rm -rf "$A/assets/app"'));
});

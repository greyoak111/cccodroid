// Added during a static-only review. This file has NOT been executed by that review.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildRemoteComponent } from "../../scripts/build-remote-component.mjs";
import { assertRemoteArchiveEntries, readRemotePackage, readRemotePayload } from "../gw/remote-component-layout.mjs";

const feature = "share/cccodroid/components/remote-session", index = "libexec/devkit/components/remote-session";
const damaged = { code: "COMPONENT_DAMAGED" }, base = "e".repeat(64);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function listing(usr) {
  const entries = [{ name: "usr/", type: "dir", target: "" }];
  const walk = (rel) => {
    for (const item of fs.readdirSync(path.join(usr, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${item.name}` : item.name;
      entries.push({ name: `usr/${next}${item.isDirectory() ? "/" : ""}`, type: item.isDirectory() ? "dir" : "file", target: "" });
      if (item.isDirectory()) walk(next);
    }
  };
  walk(""); return entries;
}

test("remote package boundary accepts the actual builder output and rejects smuggled paths/inventories", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-payload-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const built = buildRemoteComponent({ out: path.join(dir, "built"), base });
  const options = { record: { id: "remote-session", state: "ok", version: built.build.version, base }, devkit: { sha256: base } };
  let serial = 0;
  const fresh = () => { const usr = path.join(dir, `copy-${++serial}`, "usr"); fs.cpSync(built.usr, usr, { recursive: true }); return usr; };
  const put = (usr, rel, body = "synthetic extra file\n") => { const file = path.join(usr, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const appendInventory = (usr, rel) => {
    const bytes = fs.readFileSync(path.join(usr, rel));
    fs.appendFileSync(path.join(usr, index, "MANIFEST"), `${hash(bytes)} ${bytes.length} ${rel}\n`);
    fs.appendFileSync(path.join(usr, index, "FILES"), `${rel}\n`);
  };
  const entries = listing(built.usr);

  await t.test("the exact candidate inventories and archive entries remain compatible", () => {
    assert.equal(readRemotePackage(built.usr, options).assetVersion, built.manifest.assetVersion);
    assert.doesNotThrow(() => assertRemoteArchiveEntries(entries));
  });

  await t.test("valid business manifest does not authorize an unlisted host path", () => {
    const usr = fresh(), rel = "bin/unapproved-remote-tool"; put(usr, rel);
    assert.equal(readRemotePayload(usr, options).assetVersion, built.manifest.assetVersion, "old business-only check accepts this counterexample");
    assert.throws(() => readRemotePackage(usr, options), damaged);
    assert.throws(() => assertRemoteArchiveEntries([...entries, { name: "usr/" + rel, type: "file", target: "" }]), damaged);
  });

  await t.test("listing a forbidden first-run in both inventories still cannot authorize execution", () => {
    const usr = fresh(), rel = `${index}/first-run.sh`; put(usr, rel, "#!/bin/sh\nexit 0\n"); appendInventory(usr, rel);
    assert.throws(() => readRemotePackage(usr, options), damaged);
    assert.throws(() => assertRemoteArchiveEntries([...entries, { name: "usr/" + rel, type: "file", target: "" }]), damaged);
  });

  await t.test("extra release, feature child, directory or staging-root sibling are rejected", () => {
    for (const rel of [`${feature}/releases/${"a".repeat(64)}/gateway/runtime.mjs`, `${feature}/extra.txt`, "share/unrelated/extra.txt"]) {
      const usr = fresh(); put(usr, rel); appendInventory(usr, rel);
      assert.throws(() => readRemotePackage(usr, options), damaged);
    }
    const usr = fresh(); fs.mkdirSync(path.join(usr, "bin"));
    assert.throws(() => readRemotePackage(usr, options), damaged);
    for (const entry of [{ name: "app/server.mjs", type: "file" }, { name: "usr/bin/", type: "dir" }])
      assert.throws(() => assertRemoteArchiveEntries([...entries, entry]), damaged);
  });

  await t.test("archive rejects links, special files, duplicate aliases and missing required files before extraction", () => {
    const file = `usr/${feature}/LICENSE`, at = entries.findIndex((entry) => entry.name === file);
    for (const type of ["link", "hard", "other"]) {
      const bad = entries.map((entry, i) => i === at ? { ...entry, type, target: "usr/bin/sh" } : entry);
      assert.throws(() => assertRemoteArchiveEntries(bad), damaged);
    }
    assert.throws(() => assertRemoteArchiveEntries([...entries, { ...entries[at] }]), damaged);
    assert.throws(() => assertRemoteArchiveEntries(entries.filter((_, i) => i !== at)), damaged);
    for (const name of ["usr/../app/server.mjs", "usr/./" + feature + "/LICENSE", "usr\\bin\\tool", "/usr/bin/tool", "usr//bin/tool"])
      assert.throws(() => assertRemoteArchiveEntries([...entries, { name, type: "file" }]), damaged);
  });

  await t.test("staged metadata cannot use symlinks", () => {
    const linked = fresh(), link = path.join(linked, feature, "LICENSE"), target = path.join(dir, "outside-license");
    fs.copyFileSync(link, target); fs.unlinkSync(link); fs.symlinkSync(target, link);
    assert.throws(() => readRemotePackage(linked, options), damaged);
  });
  await t.test("staged metadata cannot use hardlinks", (subtest) => {
    const hard = fresh(), hardFile = path.join(hard, feature, "LICENSE");
    try { fs.linkSync(hardFile, path.join(dir, "hardlink-outside")); }
    catch (e) {
      if (["EACCES", "EPERM", "ENOSYS"].includes(e.code)) { subtest.skip("Host filesystem does not permit hardlinks; archive hardlink rejection is tested separately"); return; }
      throw e;
    }
    assert.throws(() => readRemotePackage(hard, options), damaged);
    // FIFO creation is unnecessary: the pre-extraction type rejection above
    // rejects every tar type except file/dir, without opening a blocking path.
  });

  await t.test("the complete staged tree shares a total byte ceiling, including metadata", () => {
    const usr = fresh();
    for (const name of ['README.zh-CN.md', 'LICENSE', 'NOTICE']) fs.writeFileSync(path.join(usr, feature, name), Buffer.alloc(1_500_000, 65));
    const manifest = path.join(usr, index, 'MANIFEST');
    const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n').map((line) => {
      const rel = line.split(' ').slice(2).join(' '), bytes = fs.readFileSync(path.join(usr, rel));
      return `${hash(bytes)} ${bytes.length} ${rel}`;
    });
    fs.writeFileSync(manifest, lines.join('\n') + '\n');
    assert.equal(readRemotePayload(usr, options).assetVersion, built.manifest.assetVersion);
    assert.throws(() => readRemotePackage(usr, options), damaged);
  });

  await t.test("FILES must equal the complete tree, without omissions, extras or duplicates", () => {
    for (const mutate of [
      (lines) => lines.slice(1), (lines) => [...lines, "bin/smuggled"], (lines) => [...lines, lines[0]],
      (lines) => lines.map((line) => line === `${index}/MANIFEST` ? `${index}/first-run.sh` : line),
    ]) {
      const usr = fresh(), file = path.join(usr, index, "FILES"), lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
      fs.writeFileSync(file, mutate(lines).join("\n") + "\n");
      assert.throws(() => readRemotePackage(usr, options), damaged);
    }
  });

  await t.test("MANIFEST covers exactly non-inventory files and checks their actual bytes", () => {
    for (const mutate of [
      (lines) => lines.slice(1), (lines) => [...lines, lines[0]],
      (lines) => ["0".repeat(64) + lines[0].slice(64), ...lines.slice(1)],
      (lines) => [lines[0].replace(/^([0-9a-f]{64}) [0-9]+ /, "$1 999999 "), ...lines.slice(1)],
      (lines) => [...lines, `${"0".repeat(64)} 0 ${index}/FILES`],
      (lines) => [...lines.slice(1), `${"0".repeat(64)} 0 ../outside`],
    ]) {
      const usr = fresh(), file = path.join(usr, index, "MANIFEST"), lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
      fs.writeFileSync(file, mutate(lines).join("\n") + "\n");
      assert.throws(() => readRemotePackage(usr, options), damaged);
    }
    const usr = fresh(); fs.appendFileSync(path.join(usr, feature, "NOTICE"), "modified\n");
    assert.throws(() => readRemotePackage(usr, options), damaged);
  });
});

test("production installer enforces remote-only gates before extraction/retirement and skips inherited first-run", () => {
  const source = fs.readFileSync(new URL("../gw/components.mjs", import.meta.url), "utf8");
  const install = source.slice(source.indexOf("async function compRunInstall("), source.indexOf("function compCancel("));
  assert.match(install, /if \(id === REMOTE_COMPONENT_ID\) assertRemoteArchiveEntries\(entries\)/);
  assert.ok(install.indexOf("assertRemoteArchiveEntries(entries)") < install.indexOf('["-xzf", gz'));
  assert.ok(install.indexOf('readRemotePackage(path.join(tree, "usr")') < install.indexOf("const man = fs.readFileSync"));
  assert.ok(install.indexOf('readRemotePackage(path.join(tree, "usr")') < install.indexOf("await manager.disable()"));
  assert.match(install, /if \(id !== REMOTE_COMPONENT_ID && fs\.existsSync\(fr\)\)/);
});

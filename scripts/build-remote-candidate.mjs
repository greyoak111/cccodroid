#!/usr/bin/env node
// Local candidate only. No official signing key, installation or live app path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { remoteCandidateManifest } from "./remote-candidate-manifest.mjs";
import { checkPublicBuildSource } from "./check-public-build-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2], out = process.argv[3];
if (!platform || !path.isAbsolute(platform) || !out || !path.isAbsolute(out) || fs.existsSync(out)) throw new Error("Supply a platform JAR and a new absolute output directory");
const SHA = "6c0670454f6fcee9f1b17aa393e81d71bf26e7e6ae7c5777ed3924b062191d5b";
if (createHash("sha256").update(fs.readFileSync(platform)).digest("hex") !== SHA) throw new Error("AOSP platform hash mismatch");
checkPublicBuildSource(path.join(root, "gateway"));
fs.mkdirSync(out, { recursive: true });
const log = [];
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000, ...options });
  log.push("$ " + cmd + " " + args.map((v) => String(v).includes("keystore") ? "[test-keystore]" : v).join(" "), r.stdout || "", r.stderr || "", "exit=" + r.status);
  fs.writeFileSync(path.join(out, "build.log"), log.join("\n"));
  if (r.status !== 0) throw new Error(cmd + " failed; see candidate build.log");
  return r;
}
function walk(dir, extension) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => f.isDirectory() ? walk(path.join(dir, f.name), extension) : f.name.endsWith(extension) ? [path.join(dir, f.name)] : []); }
const classes = path.join(out, "classes"), dex = path.join(out, "dex"); fs.mkdirSync(classes); fs.mkdirSync(dex);
const jars = walk(path.join(root, "third_party/shizuku"), ".jar");
run("javac", ["-encoding", "UTF-8", "--release", "8", "-nowarn", "-cp", [platform, ...jars].join(":"), "-d", classes, ...walk(path.join(root, "android/java"), ".java")]);
const javaInfo = run("java", ["-XshowSettings:properties", "-version"]);
const javaHome = /java\.home\s*=\s*([^\r\n]+)/.exec(javaInfo.stderr)?.[1]?.trim();
if (!javaHome) throw new Error("Cannot locate JDK boot library for D8");
run("d8", ["--release", "--min-api", "26", "--lib", platform, "--lib", javaHome, "--output", dex, ...walk(classes, ".class"), ...jars]);
const assets = path.join(out, "assets"), app = path.join(assets, "app"); fs.mkdirSync(app, { recursive: true });
const copy = (from, to) => { fs.cpSync(path.join(root, from), to, { recursive: true }); };
copy("gateway/server.mjs", path.join(app, "server.mjs"));
for (const dir of ["gw", "web", "archive", "guard"]) copy("gateway/" + dir, path.join(app, dir));
// This is a compatible host candidate, not a remote-specialized monolith.
fs.rmSync(path.join(app, "gw/remote"), { recursive: true, force: true });
for (const rel of ["web/app/13r-remote-transport.js", "web/app/13s-remote-view.js", "web/app/13t-remote-settings.js", "web/remote-view.css", "web/remote-settings.css"]) fs.rmSync(path.join(app, rel), { force: true });
for (const dir of ["scripts", "bin", "pre"]) copy("android/assets/" + dir, path.join(app, dir));
copy("android/assets/TOOLS.md", path.join(app, "TOOLS.md"));
copy("devkit/pgp.mjs", path.join(app, "bin/pgp.mjs"));
copy("devkit-sources.txt", path.join(assets, "devkit-sources.txt"));
copy("devkit-pin.json", path.join(assets, "devkit-pin.json"));
const lib = path.join(app, "lib"); fs.mkdirSync(lib);
for (const [file, extra] of [["seccomp-enosys", ["-shared", "-fPIC", "-nostdlib", "-fno-stack-protector"]], ["seccomp-enosys-run", []], ["ptyhost", []], ["exec-shim", ["-shared", "-fPIC", "-nostdlib", "-fno-stack-protector"]], ["exec-shim-bionic", ["-DBIONIC", "-shared", "-fPIC", "-fno-stack-protector"]]]) {
  const source = file === "exec-shim-bionic" ? "exec-shim" : file;
  run("clang", ["-O2", ...extra, "-Wl,-z,noexecstack", "-Wl,--hash-style=both", "-o", path.join(lib, file + (extra.includes("-shared") ? ".so" : "")), path.join(root, "android/native/" + source + ".c"), ...(file === "exec-shim-bionic" ? ["-ldl"] : [])]);
}
copy("android/native/execpath.cjs", path.join(lib, "execpath.cjs"));
const tag = createHash("sha256"); for (const f of walk(app, "").sort()) tag.update(fs.readFileSync(f)); fs.writeFileSync(path.join(app, "TAG"), tag.digest("hex").slice(0, 12) + "\n");
const loader = fs.readFileSync(path.join(root, "android/prebuilt/glibc/ld-linux-aarch64.so.1"));
const loaderMeta = JSON.parse(fs.readFileSync(path.join(root, "android/prebuilt/glibc/ld.json")));
if (createHash("sha256").update(loader).digest("hex") !== loaderMeta.sha256) throw new Error("Vendored loader hash mismatch");
const manifest = path.join(out, "AndroidManifest.xml");
const candidateManifest = remoteCandidateManifest(fs.readFileSync(path.join(root, "android/AndroidManifest.xml"), "utf8"));
fs.writeFileSync(manifest, candidateManifest.xml);
const resource = path.join(out, "res.zip"), unsigned = path.join(out, "unsigned.apk");
run("aapt2", ["compile", "--dir", path.join(root, "android/res"), "-o", resource]);
run("aapt2", ["link", "-o", unsigned, "-I", "/system/framework/framework-res.apk", "--manifest", manifest, "-A", assets, resource]);
const zipScript = `import zipfile, pathlib
p=pathlib.Path(${JSON.stringify(out)})
with zipfile.ZipFile(p/'unsigned.apk','a') as z:
 z.write(p/'dex/classes.dex','classes.dex',compress_type=zipfile.ZIP_DEFLATED)
 z.write(pathlib.Path(${JSON.stringify(path.join(root, "android/prebuilt/glibc/ld-linux-aarch64.so.1"))}),'lib/arm64-v8a/libldlinux.so',compress_type=zipfile.ZIP_STORED)
with zipfile.ZipFile(p/'unsigned.apk') as source, zipfile.ZipFile(p/'aligned.apk','w') as target:
 for old in source.infolist():
  entry=zipfile.ZipInfo(old.filename,old.date_time)
  entry.compress_type=old.compress_type
  entry.external_attr=old.external_attr
  entry.flag_bits=old.flag_bits
  if entry.compress_type==zipfile.ZIP_STORED:
   align=16384 if entry.filename.endswith('.so') else 4
   start=target.fp.tell()+30+len(entry.filename.encode('utf-8'))
   pad=(-start)%align
   if pad and pad<4:pad+=align
   if pad:entry.extra=b'\\x35\\xd9'+(pad-4).to_bytes(2,'little')+bytes(pad-4)
  target.writestr(entry,source.read(old))
with zipfile.ZipFile(p/'aligned.apk') as z:
 for e in z.infolist():
  if e.compress_type==zipfile.ZIP_STORED:
   start=e.header_offset+30+len(e.filename.encode('utf-8'))+len(e.extra)
   assert start%(16384 if e.filename.endswith('.so') else 4)==0
print('Stored ZIP entries aligned; native loader uses 16KiB alignment')
`;
run("python3", ["-c", zipScript]);
const key = path.join(out, "candidate-test.keystore"), apk = path.join(out, "cc-remote-session-candidate.apk");
run("keytool", ["-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android", "-alias", "candidate", "-keyalg", "RSA", "-keysize", "2048", "-validity", "90", "-dname", "CN=CC Remote Disposable Candidate, O=Local Test Only, C=ZZ"]);
run("apksigner", ["sign", "--alignment-preserved", "true", "--ks", key, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--min-sdk-version", "26", "--out", apk, path.join(out, "aligned.apk")]);
run("apksigner", ["verify", "--verbose", "--print-certs", apk]);
run("python3", ["-c", `import zipfile,struct\np=${JSON.stringify(apk)}\nwith zipfile.ZipFile(p) as z,open(p,'rb') as f:\n for e in z.infolist():\n  if e.compress_type!=zipfile.ZIP_STORED:continue\n  f.seek(e.header_offset)\n  h=f.read(30)\n  n,x=struct.unpack_from('<HH',h,26)\n  start=e.header_offset+30+n+x\n  assert start%(16384 if e.filename.endswith('.so') else 4)==0,(e.filename,start)\nprint('Signed APK local headers: stored entries 4-byte aligned, native loader 16KiB aligned')\n`]);
run("aapt2", ["dump", "badging", apk]);
fs.chmodSync(key, 0o600);
const baseline = run("git", ["rev-parse", "HEAD"]).stdout.trim();
fs.writeFileSync(path.join(out, "candidate.json"), JSON.stringify({ baseline, version: candidateManifest.version, apk, sha256: createHash("sha256").update(fs.readFileSync(apk)).digest("hex"), platformSha256: SHA, samePackageAsProduction: true, testSigned: true, installed: false, zipEntryAlignmentVerified: true, nativeLoaderAlignmentBytes: 16384, runtimeDeviceTested: false, warning: "Not a production upgrade; do not uninstall or overwrite the current app. Needs separate-device acceptance. Test key is disposable and not delivered." }, null, 2));
console.log(apk);

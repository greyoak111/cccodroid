#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { payloadHash } from "../gateway/gw/remote-component-layout.mjs";

export function buildRemoteComponent({ out, base, version = "0.1.0-candidate.3" } = {}) {
  if (!path.isAbsolute(out || "") || !/^[0-9a-f]{64}$/.test(base || "") || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new Error("An absolute new output directory, devkit SHA-256 and valid version are required");
  if (fs.existsSync(out)) throw new Error("Refusing to overwrite an existing output directory");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = (rel) => fs.readFileSync(path.join(root, rel));
  const files = new Map(), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const name of ["runtime", "protocol", "crypto", "pairing", "identity", "phone", "tablet-data", "tablet-control", "presentation", "store", "relay-client"]) files.set(`gateway/${name}.mjs`, source(`gateway/gw/remote/${name}.mjs`));
  files.set("gateway/host-adapter.mjs", Buffer.from(`export function createUnavailableHostAdapter(){const no=async()=>{throw Object.assign(new Error('HOST_UNAVAILABLE'),{code:'HOST_UNAVAILABLE'});};return {available:false,status:async()=>({hostAvailable:false,shouldConnect:false}),secretProtector:{seal:no,open:no},setBackgroundEnabled:no,clearNotifications:no,reportConnectionState:no,syncNotifications:no,watchPolicy(){return ()=>{};}};}\n`));
  files.set("gateway/component.mjs", Buffer.from(`import {createRemoteRuntime} from './runtime.mjs';
import {createSourceAdapter} from './tablet-data.mjs';
export const hostApi=1;
export function create(host){return createRemoteRuntime({home:host.home,hostAdapter:host.hostAdapter,executor:host.executor,sourceAdapter:createSourceAdapter(host.source),autoConnect:true});}
`));
  const ui = ["13r-remote-transport", "13s-remote-view", "13t-remote-settings"].map((n) => source(`gateway/web/app/${n}.js`).toString("utf8")).join("\n");
  files.set("web/ui.js", Buffer.from(`(()=>{\n'use strict';\nconst assetVersion=new URL(document.currentScript.src).searchParams.get('version');\nconst {t,api,OV,activationId:remoteActivationId}=window.CCRemoteComponentHost.context;\n${ui}\nwindow.CCRemoteComponentHost.mount({view:remoteView,transport:remoteTransport,settings:remoteSettings,hosting:remoteHosting,assetVersion});\n})();\n`));
  files.set("web/ui.css", Buffer.from(["remote-view", "remote-settings"].map((n) => source(`gateway/web/${n}.css`).toString("utf8")).join("\n")));
  const hashes = Object.fromEntries([...files].map(([rel, bytes]) => [rel, hash(bytes)]));
  const assetVersion = payloadHash(hashes);
  const manifest = { format: 1, id: "remote-session", version, hostApi: { remoteSession: 1 }, assetVersion, files: hashes };
  fs.mkdirSync(out, { recursive: true });
  const stage = path.join(out, "stage"), usr = path.join(stage, "usr"), feature = "share/cccodroid/components/remote-session";
  const all = [];
  const put = (rel, bytes) => { const f = path.join(usr, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes, { mode: 0o644 }); all.push(rel); };
  for (const [rel, bytes] of files) put(`${feature}/releases/${assetVersion}/${rel}`, bytes);
  put(`${feature}/component.json`, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  put(`${feature}/README.zh-CN.md`, source("docs/REMOTE-COMPONENT.zh-CN.md"));
  put(`${feature}/LICENSE`, source("LICENSE"));
  put(`${feature}/NOTICE`, source("NOTICE"));
  const lx = "libexec/devkit/components/remote-session";
  const lines = all.sort().map((rel) => { const b = fs.readFileSync(path.join(usr, rel)); return `${hash(b)} ${b.length} ${rel}`; });
  put(lx + "/MANIFEST", Buffer.from(lines.join("\n") + "\n"));
  put(lx + "/FILES", Buffer.from([...all, lx + "/FILES"].sort().join("\n") + "\n"));
  // No install scripts, background daemons, model instructions or host-file writes.
  for (const f of all) { fs.utimesSync(path.join(usr, f), 0, 0); }
  const asset = `remote-session-${version}-${base.slice(0, 12)}.tar.gz`, archive = path.join(out, asset);
  const packed = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", stage, "usr"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
  const bytes = fs.readFileSync(archive), installed = all.reduce((n, rel) => n + fs.statSync(path.join(usr, rel)).size, 0);
  const build = { version, upstream: "remote-session-candidate", base, asset, sha256: hash(bytes), bytes: bytes.length, installed, bin: [], hostApi: { remoteSession: 1 }, baseDeps: ["nodejs", "openssl"], verified: false };
  const entry = { name: { zh: "远程会话托管", en: "Remote session hosting" }, desc: { zh: "指定会话看、批、发文字；任务仍在原设备执行。需要远程宿主接口 1。", en: "View, approve once and send text to explicitly hosted sessions; execution stays on the original device. Requires remote host API 1." }, category: "net", license: "Apache-2.0", hostApi: { remoteSession: 1 }, builds: [build] };
  fs.writeFileSync(path.join(out, "component-entry.candidate.json"), JSON.stringify(entry, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "build-evidence.json"), JSON.stringify({ candidate: true, officiallySigned: false, installedOrPublished: false, manifest, build, files: all.length }, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), `${build.sha256}  ${asset}\n`);
  return { out, archive, stage, usr, manifest, build, entry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [out, base, version] = process.argv.slice(2);
  const result = buildRemoteComponent({ out, base, ...(version ? { version } : {}) });
  console.log(JSON.stringify({ archive: result.archive, assetVersion: result.manifest.assetVersion, bytes: result.build.bytes, sha256: result.build.sha256, officiallySigned: false }, null, 2));
}

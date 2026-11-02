import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRemoteComponentRoute } from "../gw/remote-component-route.mjs";
import { staticMac } from "../gw/access.mjs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const read = (rel) => fs.readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
test("Android optional UI receives both original signed authorization and content HMAC verification", () => {
  const main = read("android/java/cc/codroid/MainActivity.java"), env = read("android/java/cc/codroid/Env.java");
  assert.match(main, /boolean remoteAsset = "\/api\/components\/remote-session\/ui\.js"\.equals\(p\) \|\| "\/api\/components\/remote-session\/ui\.css"\.equals\(p\)/);
  assert.match(main, /!p\.startsWith\("\/api\/"\) \|\| remoteAsset/);
  assert.match(env, /componentAsset \? gateway\(pq\)/);
  assert.match(env, /getHeaderField\("X-CC-Mac"\)/);
  assert.match(env, /MessageDigest\.isEqual/);
});

test("host build omits optional implementation rather than shipping a monolithic remote APK", () => {
  const build = read("scripts/build-remote-candidate.mjs");
  assert.match(build, /rmSync\(path\.join\(app, "gw\/remote"\)/);
  for (const name of ["13r-remote-transport", "13s-remote-view", "13t-remote-settings", "remote-view.css", "remote-settings.css"]) assert.ok(build.includes(name));
  const production = read("scripts/build.sh");
  assert.doesNotMatch(production, /cp -R "\$SRC\/gw\/remote"/);
});

test("executable component resource MAC covers nonce, full request target and actual bytes", async () => {
  const data = Buffer.from("fixture component JS"), version = "a".repeat(64);
  const manager = { watch() {}, async asset(kind, requested) { assert.equal(kind, "js"); assert.equal(requested, version); return data; } };
  const route = createRemoteComponentRoute(manager);
  const pq = "/api/components/remote-session/ui.js?version=" + version;
  const req = Readable.from([]); req.method = "GET"; req.url = pq; req.ccAuthed = true; req.headers = { "x-cc-nonce": "a".repeat(32) }; req.socket = { localAddress: "127.0.0.2" };
  const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = (code, headers) => { res.code = code; res.headers = headers; }; res.end = (bytes) => { res.bytes = bytes; };
  await route(req, res, new URL(pq, "http://127.0.0.2"), new URL(pq, "http://127.0.0.2").pathname);
  assert.equal(res.code, 200);
  assert.equal(res.headers["x-cc-mac"], staticMac(req.headers["x-cc-nonce"], pq, data, "127.0.0.2"));
  assert.notEqual(res.headers["x-cc-mac"], staticMac(req.headers["x-cc-nonce"], pq + "-changed", data, "127.0.0.2"));
  assert.equal(createHash("sha256").update(res.bytes).digest("hex"), createHash("sha256").update(data).digest("hex"));
});

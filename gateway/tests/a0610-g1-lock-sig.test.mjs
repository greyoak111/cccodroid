// 196-供应链.4：devkit.lock.json 必须验签（和组件索引同一把钥匙），且 release 与下载地址里的 tag 一致；
// pkg 的磁盘缓存只存原始正文 + 签名，读回来复核，旧格式（没签名的解析对象）不认。
import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyLock, tagOf, PUBKEY_B64 } from "../../android/assets/bin/lockcheck.mjs";

// 没有服务端私钥，验签逻辑用测试自己生成的钥匙测（公钥可替换参数只给测试用）
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const sign = (body) => crypto.sign(null, Buffer.from(body), privateKey).toString("base64");
const BASE = "https://github.com/greyoak111/cccodroid/releases/download/devkit-2026.10.15.1/";
const make = (over = {}) => JSON.stringify({ release: "devkit-2026.10.15.1", packages: [{ name: "bash", version: "5.3" }], ...over });

test("公钥与 APK 里 Ed25519.INDEX_PUBKEY_B64 是同一把", () => {
  assert.equal(PUBKEY_B64, "4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=");
  const pem = crypto.createPublicKey("-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=\n-----END PUBLIC KEY-----\n");
  const raw = pem.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  assert.equal(raw, PUBKEY_B64);
});

test("验签：正文被改、签名不对、release 不是这个 tag 都不认", () => {
  const body = make();
  assert.equal(verifyLock(body, sign(body), BASE, publicKey).release, "devkit-2026.10.15.1");
  assert.equal(verifyLock(body + " ", sign(body), BASE, publicKey), null, "正文改了签名就对不上");
  assert.equal(verifyLock(body, sign("x"), BASE, publicKey), null);
  assert.equal(verifyLock(body, "", BASE, publicKey), null);
  assert.equal(verifyLock(body, "AAAA", BASE, publicKey), null);
  // 旧清单连签名一起搬到新 tag 下冒充新版
  assert.equal(verifyLock(body, sign(body), BASE.replace("2026.10.15.1", "2026.11.01"), publicKey), null);
  const noRel = JSON.stringify({ packages: [] });
  assert.equal(verifyLock(noRel, sign(noRel), BASE, publicKey), null, "没有 release 不算通过");
});

test("tagOf 与 Java 的正则一致（带不带结尾斜杠都取得到）", () => {
  assert.equal(tagOf(BASE), "devkit-2026.10.15.1");
  assert.equal(tagOf(BASE.replace(/\/$/, "")), "devkit-2026.10.15.1");
  assert.equal(tagOf("https://x/download/"), "");
  assert.equal(tagOf(""), "");
});

test("pkg 侧接线：取回来先验签，缓存存原始正文与签名并复核，旧格式不认", () => {
  const src = fs.readFileSync(new URL("../../android/assets/bin/pkg.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ verifyLock \} from "\.\/lockcheck\.mjs"/);
  assert.match(src, /verifyLock\(body, sig, base\)/, "下载后要验签");
  assert.match(src, /verifyLock\(c\.body, c\.sig, id\.base\)/, "缓存读回来也要复核");
  assert.match(src, /writeJson\(f, \{ _for: id\.sha256, body: got\.body, sig: got\.sig \}\)/, "缓存里必须是可复核的原文与签名");
  assert.ok(!/l\._for = id\.sha256; writeJson\(f, l\)/.test(src), "不能再把解析后的对象直接当缓存");
});

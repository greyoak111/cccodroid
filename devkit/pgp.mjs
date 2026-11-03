// 极简 OpenPGP：只认 v4 的 RSA 公钥包与 v4 RSA 分离签名（Termux 仓库的 Release.gpg、Anthropic 的 manifest.json.sig 都是这种）。
// 正本在 devkit/（组件市场的 CI 只检出这个目录），打 APK 时 build.sh 拷进 app/bin，pkg.mjs、install-claude.mjs 从那里导入。
// 以前各抄一份（审查 10-29 L22）。不认的格式一律抛错，不放行
import crypto from "node:crypto";

// Termux 自动构建钥（main / root / x11 仓库的 Release 都由它签）
export const TERMUX_KEYS = {"CC72CF8BA7DBFA0182877D045A897D96E57CF20C":{"kty":"RSA","n":"yBh7FtnoP4xlWnvU-AUwXXYxgv7waUkxQ-4iE-pv_Ro0Lw7siRcYrJbt-VFVEC8se51FV2HsqgAVCfq3JUtiV82QBJa_h7ffLL5EDdRGlgBG16EtjXQ6nMG1l960a8fQYrP762_EFBO-HjQOknYiGzu7dGW8-nxYiNfRAX-fO8yGljur_JWJq-Ud6y6j2anoHlJ-vGuaKBdCoILPldL_nE3-mkyUzgvVZe3QPHvDEwbMDgCINxJd4U6weRn-IGXSfp4bWk4sOjTbPWFRpqzBpfVpS7ABsOdhWgfryfUC3w-fLZw9H_10QJ8ytnWr7i5cCg8jRd97kTmj7uX0I0ATF_ALjqdQ1ZVb5qjShYP67ZP86sAN9N92WLN7CgrIGfABDXKzHzS8U-RztzfiwXbx0jWHwliUyFZDrH2KZVx6PDYb3TICQGMHdF7MG31fGfKx4z_Anl5oqe1S4QB9IwaRlHQwBRGT1uh2g6YQ0S_BSlA0yd1rw-bpD1OB5AmjB8m3m4YrOCXcNWkxVmTibUup7UdYch-ekS3AkQSFGg4lPM4ZQgAKtt7LMSmlKqG2y8YLliQzR-jL_D8V6dA_OQqSAPtfIFHj5vG_-1G_0pB54WRlR5TckdTvXv241XyliDaRnOozf9NpOfji8e0wlqvmNxO69JTYoFPpgP0u7EMK4Jc","e":"AQAB"}};

// Anthropic 的发布签名钥（https://downloads.claude.ai/keys/claude-code.asc，与 keys.openpgp.org 上同指纹的一致）
// （安装脚本 install-claude.mjs 与开发布局的更新 gw/devside.mjs 共用）
export const ANTHROPIC_KEYS = {"31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE":{"kty":"RSA","n":"p28rSV5I8HmK8CK9GixBUZR_gtJxeOCsRXO4EJiej40jzBmQA3cWXGosVO82ZfFsRKVTtMC5iB_HH9sxjncrmYNWGroJNbx29m_FgYQBgkCXT4AfFl6rnnXqRGLZOerj_4AqE4yQ1GZbhBgR55Z7ro0ieKK8RHYUspBKAFHyWRhCCz6THW6YRbf0p_hG_08TOY6Sj3cJ7_AEoTRf9ZmVNX1k0KvbUSiVGpGY9OIHWgxRJUF2pArU4o_hk-sqGAgEUh8Bjvjwvz6-quLXPg-y0Y8Ugb1Fg6BUppam_zydYY_Q_-yNjnuF154gD1jEeeir8R5czs6zUHSbo2yXUpAsIdWYo5End8vGsluVmFExnUWm_fTVMGoM5Wm3v1VRepMydEnJ-atz4oQdmPQcKNAip5GJO2uyk--xFr9CpKvlR5jral92toYV_m-mur3va8ydamWBo_qG7_wt0sdS81IwH6lcu0SQ39rgKD-bdoPLv05EqVMYTFRI2QZEsWGYTMs0DOrfCIJFH50qyD0x4sWw1gEWeG3jDgY8cj2StZz-zjqzUd05CibcCzEAGm1EQg5y9D40tIsAU1OI7bpgQ9V0lC8lrqE7zJY66UK9Z1daA8jrdDi6migNjHFrXfT3V4QvMthCIO05q05SS3x2G3ZpIgmI-CePUPB1pDf-lhPkU1M","e":"AQAB"}};

function dearmor(t) {
  const body = String(t).replace(/\r/g, "").split("\n\n").slice(1).join("\n\n").split("\n=")[0];
  return Buffer.from(body.replace(/\s/g, ""), "base64");
}
function packets(b) {
  const out = [];
  for (let o = 0; o < b.length;) {
    const h = b[o++]; if (!(h & 0x80)) throw new Error("bad packet");
    let tag, len;
    if (h & 0x40) { tag = h & 63; const l = b[o++]; if (l < 192) len = l; else if (l < 224) len = ((l - 192) << 8) + b[o++] + 192; else if (l === 255) { len = b.readUInt32BE(o); o += 4; } else throw new Error("partial len"); }
    else { tag = (h >> 2) & 15; const lt = h & 3; if (lt === 0) len = b[o++]; else if (lt === 1) { len = b.readUInt16BE(o); o += 2; } else if (lt === 2) { len = b.readUInt32BE(o); o += 4; } else len = b.length - o; }
    out.push({ tag, body: b.subarray(o, o + len) }); o += len;
  }
  return out;
}
const mpi = (b, o) => { const bits = b.readUInt16BE(o), n = (bits + 7) >> 3; return [b.subarray(o + 2, o + 2 + n), o + 2 + n]; };
const b64u = (x) => Buffer.from(x).toString("base64url");
/** 公钥块里所有 RSA 钥（主钥 + 子钥）：[{fpr, jwk}] */
export function rsaKeys(armored) {
  const keys = [];
  for (const p of packets(dearmor(armored))) {
    if ((p.tag !== 6 && p.tag !== 14) || p.body[0] !== 4 || p.body[5] !== 1) continue;
    const [n, o1] = mpi(p.body, 6), [e] = mpi(p.body, o1);
    const hdr = Buffer.from([0x99, p.body.length >> 8, p.body.length & 255]);
    keys.push({ fpr: crypto.createHash("sha1").update(hdr).update(p.body).digest("hex").toUpperCase(), primary: p.tag === 6, jwk: { kty: "RSA", n: b64u(n), e: b64u(e) } });
  }
  return keys;
}
/** 验分离签名：data 是被签的原始字节，keys 是 {指纹: jwk}。返回签名用的指纹，不通过抛错 */
export function verifyDetached(data, sigArmored, keys) {
  const sp = packets(dearmor(sigArmored)).find((p) => p.tag === 2);
  if (!sp) throw new Error("no signature packet");
  const s = sp.body;
  if (s[0] !== 4 || s[1] !== 0 || s[2] !== 1) throw new Error("unsupported signature (want v4 binary RSA)");
  const hashName = { 8: "sha256", 9: "sha384", 10: "sha512" }[s[3]];
  if (!hashName) throw new Error("unsupported hash " + s[3]);
  const hl = s.readUInt16BE(4), hashed = s.subarray(0, 6 + hl);
  let fpr = "";
  const sub = (buf) => { for (let o = 0; o < buf.length;) { let l = buf[o++]; if (l >= 192 && l < 255) l = ((l - 192) << 8) + buf[o++] + 192; else if (l === 255) { l = buf.readUInt32BE(o); o += 4; } const t = buf[o] & 0x7f; if (t === 33) fpr = buf.subarray(o + 2, o + l).toString("hex").toUpperCase(); o += l; } };
  sub(s.subarray(6, 6 + hl));
  const ul = s.readUInt16BE(6 + hl); if (!fpr) sub(s.subarray(8 + hl, 8 + hl + ul));
  const jwk = keys[fpr];
  if (!jwk) throw new Error("signed by unknown key " + (fpr || "?"));
  const [sig] = mpi(s, 8 + hl + ul + 2);
  const trailer = Buffer.alloc(6); trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(hashed.length, 2);
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const nlen = Buffer.from(jwk.n, "base64url").length, sigp = Buffer.concat([Buffer.alloc(Math.max(0, nlen - sig.length)), sig]);
  if (!crypto.verify(hashName, Buffer.concat([data, hashed, trailer]), pub, sigp)) throw new Error("bad signature");
  return fpr;
}

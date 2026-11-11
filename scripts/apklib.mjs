// apklib.mjs — ZIP 读写 + APK v1(JAR)/v2 签名（scripts/build.sh 默认的签名，SIGN=apklib）
// 以前只在构建机 ~/.bldtools 里有一份，11-12 收进仓库。node-forge 1.4.0 原样放在 third_party/node-forge（与 npm 包逐字节一致）。
// MANIFEST.MF 里的 Created-By 照旧写，签出来的 v1 部分和以前一致
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import forge from "../third_party/node-forge/lib/index.js";

// ---------- CRC32 ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 读 ZIP ----------
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("找不到 EOCD，不是合法 zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录损坏 @" + off);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    entries.push({ name, method, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

// ---------- 写 ZIP ----------
export function writeZipParts(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    let method = e.method ?? 8, body = e.data;
    if (method === 8) {
      const d = zlib.deflateRawSync(e.data, { level: 9 });
      if (d.length >= e.data.length) { method = 0; body = e.data; } else body = d;
    }
    let extra = Buffer.alloc(0);
    if (e.align && method === 0) {
      const base = offset + 30 + nameBuf.length;
      let pad = (e.align - (base % e.align)) % e.align;
      if (pad > 0 && pad < 4) pad += e.align;   // extra 字段头本身要 4 字节
      if (pad >= 4) {
        extra = Buffer.alloc(pad);
        extra.writeUInt16LE(0x0000, 0);         // extra field id
        extra.writeUInt16LE(pad - 4, 2);        // extra field size
      }
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, nameBuf, extra, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf, extra);
    offset += 30 + nameBuf.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return { local: Buffer.concat(locals), cd, eocd, cdOffset: offset };
}

export function writeZip(entries) {
  const p = writeZipParts(entries);
  return Buffer.concat([p.local, p.cd, p.eocd]);
}

// ---------- 属性行折行（JAR 规范 72 字节） ----------
function attrLines(name, value) {
  let s = `${name}: ${value}`;
  const out = [];
  while (Buffer.byteLength(s, "utf8") > 72) {
    let cut = 72;
    while (Buffer.byteLength(s.slice(0, cut), "utf8") > 72) cut--;
    out.push(s.slice(0, cut)); s = " " + s.slice(cut);
  }
  out.push(s);
  return out.join("\r\n");
}

// ---------- 密钥库 ----------
// 只读已有的钥匙。以前找不到就现生成一把：签出来的包装不上已装的版本，换钥匙等于已装用户都得卸载重装，所以不再生成
export function loadKey(p) {
  if (!p || !fs.existsSync(p)) throw new Error("找不到签名钥匙 " + (p || "（没给路径）") + "：不会自动生成");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { privateKey: forge.pki.privateKeyFromPem(j.key), cert: forge.pki.certificateFromPem(j.cert), pem: j.key };
}

// ==================== APK Signature Scheme v2 ====================
const V2_BLOCK_ID = 0x7109871a;          // APK_SIGNATURE_SCHEME_V2_BLOCK_ID
const ALG_RSA_PKCS1_SHA256 = 0x0103;     // SignatureAlgorithm.RSA_PKCS1_V1_5_WITH_SHA256
const CHUNK_SIZE = 1048576;              // CONTENT_DIGESTED_CHUNK_MAX_SIZE_BYTES
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };

/**
 * 内容摘要：把若干"段"各自按 1MB 切块，所有块的摘要汇总成**一个**摘要。
 * = SHA256(0x5a ‖ u32(总块数) ‖ 各块 SHA256(0xa5 ‖ u32(块长) ‖ 内容))
 * 注意：块不跨段，但段间不重置——三段（条目区/中央目录/EOCD）的块摘要拼在一起。
 */
export function contentDigest(segments) {
  const parts = [];
  for (const seg of segments) {
    for (let off = 0; off < seg.length; off += CHUNK_SIZE) {
      const c = seg.subarray(off, Math.min(off + CHUNK_SIZE, seg.length));
      const h = crypto.createHash("sha256");
      h.update(Buffer.from([0xa5])); h.update(u32(c.length)); h.update(c);
      parts.push(h.digest());
    }
  }
  const h = crypto.createHash("sha256");
  h.update(Buffer.from([0x5a])); h.update(u32(parts.length));
  for (const p of parts) h.update(p);
  return h.digest();
}

const certDer = (cert) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
/** 从证书里取 SubjectPublicKeyInfo（保证与证书公钥一致） */
function spkiFromCert(cert) {
  const asn1 = forge.asn1.fromDer(certDer(cert).toString("binary"));
  return Buffer.from(forge.asn1.toDer(asn1.value[0].value[6]).getBytes(), "binary");
}

function buildV2Value(digest, cert, pem) {
  const cd = certDer(cert);
  const pub = spkiFromCert(cert);
  // digests 记录：每个签名算法一条
  const digestsSeq = Buffer.concat([u32(8 + digest.length), u32(ALG_RSA_PKCS1_SHA256), u32(digest.length), digest]);
  const certsSeq = Buffer.concat([u32(cd.length), cd]);
  // signed data = [digests][certs][additionalAttributes=空][空]（与 apksig 完全一致）
  const signedData = Buffer.concat([u32(digestsSeq.length), digestsSeq,
                                    u32(certsSeq.length), certsSeq, u32(0), u32(0)]);
  const sig = crypto.sign("sha256", signedData, pem);
  const sigsSeq = Buffer.concat([u32(8 + sig.length), u32(ALG_RSA_PKCS1_SHA256), u32(sig.length), sig]);
  const signer = Buffer.concat([u32(signedData.length), signedData,
                                u32(sigsSeq.length), sigsSeq,
                                u32(pub.length), pub]);
  const inner = Buffer.concat([u32(signer.length), signer]);
  return Buffer.concat([u32(inner.length), inner]);
}

/** APK Signing Block: u64(size) ‖ u64(pairLen) ‖ u32(id) ‖ value ‖ u64(size) ‖ "APK Sig Block 42" */
function buildSigningBlock(value) {
  const MAGIC = Buffer.from("APK Sig Block 42", "binary");
  const pairLen = 4 + value.length;
  const size = 8 + pairLen + 8 + 16;
  return Buffer.concat([u64(size), u64(pairLen), u32(V2_BLOCK_ID), value, u64(size), MAGIC]);
}
export const signingBlockSize = (valueLen) => 44 + valueLen;

// ---------- 签名 ----------
export function signApk(inApk, outApk, extraEntries = [], keyPath, opts = {}) {
  const wantV1 = opts.v1 !== false;
  const wantV2 = opts.v2 !== false;
  const { privateKey, cert, pem } = loadKey(keyPath);
  const entries = readZip(fs.readFileSync(inApk)).filter((e) => !e.name.startsWith("META-INF/"));
  for (const x of extraEntries) {
    const i = entries.findIndex((e) => e.name === x.name);
    if (i >= 0) entries[i] = x; else entries.push(x);
  }
  const aligned = entries.map((e) => ({ ...e, align: e.name === "resources.arsc" ? 4 : e.name.endsWith(".so") ? 4096 : 0 }));
  const sha256 = (buf) => { const m = forge.md.sha256.create(); m.update(buf.toString("binary")); return forge.util.encode64(m.digest().getBytes()); };

  // ---------- v1 (JAR) ----------
  if (wantV1) {
    let mf = attrLines("Manifest-Version", "1.0") + "\r\n" + attrLines("Created-By", "1.0 (DSH on-device signer)") + "\r\n\r\n";
    const secs = [];
    for (const e of aligned) {
      const sec = attrLines("Name", e.name) + "\r\n" + attrLines("SHA-256-Digest", sha256(e.data)) + "\r\n\r\n";
      secs.push({ name: e.name, sec }); mf += sec;
    }
    const mfBuf = Buffer.from(mf, "binary");

    let sf = attrLines("Signature-Version", "1.0") + "\r\n" + attrLines("Created-By", "1.0 (DSH on-device signer)") + "\r\n" +
             attrLines("SHA-256-Digest-Manifest", sha256(mfBuf)) + "\r\n\r\n";
    for (const s of secs) sf += attrLines("Name", s.name) + "\r\n" + attrLines("SHA-256-Digest", sha256(Buffer.from(s.sec, "binary"))) + "\r\n\r\n";
    const sfBuf = Buffer.from(sf, "binary");

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(sfBuf.toString("binary"));
    p7.addCertificate(cert);
    p7.addSigner({ key: privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256 });
    p7.sign({ detached: true });
    const rsaBuf = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");

    aligned.push(
      { name: "META-INF/MANIFEST.MF", data: mfBuf, method: 8, align: 0 },
      { name: "META-INF/CERT.SF", data: sfBuf, method: 8, align: 0 },
      { name: "META-INF/CERT.RSA", data: rsaBuf, method: 8, align: 0 },
    );
  }

  // ---------- 组装 ----------
  let outBuf;
  const schemes = [];
  if (wantV2) {
    // 第一遍：只为拿签名块长度（摘要恒为 32 字节，故长度稳定）
    const probe = writeZipParts(aligned);
    const placeholder = buildV2Value(Buffer.alloc(32), cert, pem);
    const blockBytes = signingBlockSize(placeholder.length);
    // 写进文件的 EOCD：中央目录偏移要加上签名块长度
    const eocdInFile = Buffer.from(probe.eocd);
    eocdInFile.writeUInt32LE(probe.cdOffset + blockBytes, 16);
    // 但摘要用的是"插入签名块之前"的 EOCD（偏移不变）——
    // 否则摘要会依赖签名块自身大小，而块大小又依赖签名，形成循环。
    const digest = contentDigest([probe.local, probe.cd, probe.eocd]);
    const value = buildV2Value(digest, cert, pem);
    if (value.length !== placeholder.length) throw new Error("v2 签名块长度不稳定");
    outBuf = Buffer.concat([probe.local, buildSigningBlock(value), probe.cd, eocdInFile]);
    schemes.push("v2");
  } else {
    outBuf = writeZip(aligned);
  }
  if (wantV1) schemes.push("v1");

  fs.writeFileSync(outApk, outBuf);
  return { size: outBuf.length, entries: aligned.length, signer: cert.subject.getField("CN").value, schemes };
}

import test from "node:test";
import assert from "node:assert/strict";
import { parseVer, versionDelta, elfSoname, compareSonames, classifyDrift, analyzeDrift, formatMarkdown } from "../../devkit/abi-check.mjs";

/** 构造一个最小可解析的 ELF64 小端二进制（带 PT_LOAD + PT_DYNAMIC + DT_STRTAB + DT_SONAME） */
function makeFakeElfWithSoname(soname) {
  const buf = Buffer.alloc(512, 0);
  // ELF header
  buf.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf.writeBigUInt64LE(64n, 32); // e_phoff = 64
  buf.writeUInt16LE(56, 54); // e_phentsize = 56
  buf.writeUInt16LE(2, 56); // e_phnum = 2

  // Program header 0: PT_LOAD covering whole buffer (va=0, off=0, fsz=512)
  buf.writeUInt32LE(1, 64); // PT_LOAD
  buf.writeBigUInt64LE(0n, 64 + 8);
  buf.writeBigUInt64LE(0n, 64 + 16);
  buf.writeBigUInt64LE(512n, 64 + 32);

  // Program header 1: PT_DYNAMIC at off=256, fsz=64
  const dynOff = 256;
  buf.writeUInt32LE(2, 64 + 56); // PT_DYNAMIC
  buf.writeBigUInt64LE(BigInt(dynOff), 64 + 56 + 8);
  buf.writeBigUInt64LE(BigInt(dynOff), 64 + 56 + 16);
  buf.writeBigUInt64LE(64n, 64 + 56 + 32);

  // String table at off=384: "\0<soname>\0"
  const strOff = 384;
  Buffer.from("\0" + soname + "\0", "utf8").copy(buf, strOff);

  // Dynamic entries: DT_STRTAB(5)=384, DT_SONAME(14)=1, DT_NULL(0)=0
  buf.writeBigInt64LE(5n, dynOff);
  buf.writeBigUInt64LE(BigInt(strOff), dynOff + 8);
  buf.writeBigInt64LE(14n, dynOff + 16);
  buf.writeBigUInt64LE(1n, dynOff + 24);
  buf.writeBigInt64LE(0n, dynOff + 32);
  buf.writeBigUInt64LE(0n, dynOff + 40);
  return buf;
}

test("parseVer 与 versionDelta：正确处理 epoch 与 debian revision", () => {
  assert.deepEqual(parseVer("1:78.3-1").nums, [78, 3]);
  assert.equal(parseVer("1:78.3-1").epoch, 1);
  assert.equal(versionDelta("78.3", "79.1"), "major");
  assert.equal(versionDelta("3.14.3", "3.14.10"), "patch");
  assert.equal(versionDelta("3.14.10", "3.15.0"), "minor");
  assert.equal(versionDelta("21.0.12-1", "21.0.12-2"), "patch");
  assert.equal(versionDelta("11.10.0", "12.2.2"), "major");
});

test("classifyDrift：稳定报出 libicu 78.3→79.1 为 ABI-MAJOR，npm 11→12 为 CLI-MAJOR", () => {
  const icu = classifyDrift("libicu", "78.3", "79.1");
  assert.equal(icu.level, "ABI-MAJOR");
  assert.equal(icu.role, "so-provider");

  const npm = classifyDrift("npm", "11.10.0", "12.2.2");
  assert.equal(npm.level, "CLI-MAJOR");
  assert.equal(npm.role, "cli");

  assert.equal(classifyDrift("python", "3.14.3", "3.14.10").level, "PATCH");
  assert.equal(classifyDrift("python", "3.14.10", "3.15.0").level, "ABI-MAJOR");

  assert.equal(classifyDrift("nodejs", "26.12.1", "26.13.0").level, "MINOR");
  assert.equal(classifyDrift("nodejs", "26.13.0", "27.0.0").level, "ABI-MAJOR");

  assert.equal(classifyDrift("openssl", "3.5.0", "3.5.1").level, "PATCH");
  assert.equal(classifyDrift("openssl", "3.5.0", "4.0.0").level, "ABI-MAJOR");

  assert.equal(classifyDrift("glibc", "2.40", "2.41").level, "ABI-MAJOR");
  assert.equal(classifyDrift("libxml2", "2.13.5", "2.13.6").level, "PATCH");
  assert.equal(classifyDrift("ffmpeg", "7.1.1", "8.0.0").level, "ABI-MAJOR");
});

test("elfSoname 与 SONAME 实测覆盖：消除主版本误报、捕获隐蔽 SONAME 破坏", () => {
  const elf = makeFakeElfWithSoname("libicui18n.so.79");
  assert.equal(elfSoname(elf), "libicui18n.so.79");
  assert.equal(elfSoname(Buffer.from("not-an-elf")), null);

  // 即使版本号主版本变了，实测 SONAME 一致时降级为 MINOR（不误报）
  const compat = classifyDrift("libxml2", "2.13.8", "3.0.0", undefined, {
    oldSonames: ["libxml2.so.2"],
    newSonames: ["libxml2.so.2"],
  });
  assert.equal(compat.level, "MINOR");

  // 即使只是次版本变化（如 libxml2 2.13→2.14），实测 SONAME 变了也立即升为 ABI-MAJOR
  const broken = classifyDrift("libxml2", "2.13.8", "2.14.0", undefined, {
    oldSonames: ["libxml2.so.2"],
    newSonames: ["libxml2.so.16"],
  });
  assert.equal(broken.level, "ABI-MAJOR");
  assert.deepEqual(compareSonames(["libxml2.so.2"], ["libxml2.so.16"]).removed, ["libxml2.so.2"]);
});

test("analyzeDrift 与 formatMarkdown：devkit-2026.10.28 场景端到端汇总", () => {
  const lock = {
    release: "devkit-2026.10.28",
    snapshot: "main Wed, 28 Oct 2026",
    packages: [
      { name: "libicu", repo: "main", version: "78.3" },
      { name: "npm", repo: "main", version: "11.10.0" },
      { name: "nodejs", repo: "main", version: "26.12.1" },
      { name: "python", repo: "main", version: "3.14.3" },
      { name: "bash", repo: "main", version: "5.2.37" },
      { name: "pip-26.2.1-py3-none-any.whl", source: "pypi", version: "26.2.1" },
    ],
  };
  const repo = {
    libicu: "79.1",
    npm: "12.2.2",
    nodejs: "26.13.0",
    python: "3.14.10",
    bash: "5.2.37",
  };
  const rep = analyzeDrift(lock, repo);
  assert.equal(rep.counts.totalBase, 5); // 跳过 pypi wheel
  assert.equal(rep.counts.drifted, 4);
  assert.equal(rep.counts.abiMajor, 1);
  assert.equal(rep.counts.cliMajor, 1);
  assert.equal(rep.counts.minor, 1);
  assert.equal(rep.counts.patch, 1);
  assert.equal(rep.abiMajor[0].name, "libicu");

  const md = formatMarkdown(rep);
  assert.match(md, /libicu/);
  assert.match(md, /ABI-MAJOR/);
  assert.match(md, /CLI-MAJOR/);
});

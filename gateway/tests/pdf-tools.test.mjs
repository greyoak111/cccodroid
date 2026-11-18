import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PREFIX } from "../gw/config.mjs";
import { pdfPages, pdfImageCap, pdfToolsInfo, startPdfJob, _pdfForTest } from "../gw/pdf-tools.mjs";

const root = fs.mkdtempSync(path.join(CFG.workspace, "pdf-tools-test-"));
const src = path.join(root, "report $(echo unsafe) 'quoted'.pdf");
fs.writeFileSync(src, "%PDF-1.4\nsource\n");
const body = (name, more = {}) => ({ operation: "extract", files: [src], dest: path.join(root, name), pages: "1", ...more });
const error = (fn, code) => assert.throws(fn, (e) => e.code === code);
after(async () => {
  for (const j of _pdfForTest.JOBS.values()) if (j.state === "running") { _pdfForTest.stop(j); await j.done; }
  fs.rmSync(root, { recursive: true, force: true });
});

test("page ranges preserve requested order, deduplicate, and default to all", () => {
  assert.deepEqual(pdfPages("3, 1-2,2", 3), [3, 1, 2]);
  assert.deepEqual(pdfPages("", 3), [1, 2, 3]);
  assert.deepEqual(pdfPages(" 1 - 3 ", 3), [1, 2, 3]);
});
test("page ranges reject options, shell text, reversed/out-of-range values and oversized counts", () => {
  for (const text of ["0", "4", "3-1", "1,,2", "1;touch /tmp/pwn", "--password=x", "1e2", "1-999999999999999999", "1\n--replace-input"]) error(() => pdfPages(text, 3), "pages");
  error(() => pdfPages("", 1001), "page-limit");
  error(() => pdfPages(null, 3), "pages");
});
test("invalid operations, input counts and tool options fail before allocating a job", () => {
  error(() => startPdfJob(body("x", { operation: "__proto__" })), "operation");
  error(() => startPdfJob(body("x", { operation: ["merge"] })), "operation");
  error(() => startPdfJob(body("x", { operation: "merge" })), "files");
  error(() => startPdfJob(body("x", { files: [src, src] })), "files");
  error(() => startPdfJob(body("x", { operation: "rotate", angle: "90;exit" })), "angle");
  error(() => startPdfJob(body("x", { operation: "compress", quality: "screen -o /tmp/x" })), "quality");
  error(() => startPdfJob(body("x", { operation: "images", format: "png", dpi: 99999 })), "image-options");
});
test("private documents and existing destination directories cannot be used", () => {
  const secret = path.join(CFG.home, "pdf-tools-private.pdf"); fs.writeFileSync(secret, "%PDF-secret");
  try {
    error(() => startPdfJob(body("private", { files: [secret] })), "file-unavailable");
    error(() => startPdfJob(body("private-dest", { dest: path.join(CFG.home, "new-output") })), "destination");
    error(() => startPdfJob(body("existing", { dest: root })), "destination-exists");
    assert.equal(fs.readFileSync(src, "utf8"), "%PDF-1.4\nsource\n");
  } finally { fs.unlinkSync(secret); }
});
test("image raster cap only applies when the page raster exceeds 2048px", () => {
  // -scale-to 会连小页面一起放大：低分辨率档必须原样出栅格，只有超限才封顶
  assert.equal(pdfImageCap("Page size: 340.157 x 453.543 pts (A6)", 72), false);
  assert.equal(pdfImageCap("Page size: 595.276 x 841.89 pts (A4)", 150), false);
  assert.equal(pdfImageCap("Page size: 983 x 900 pts", 150), false); // 2047.9px，贴边不封
  assert.equal(pdfImageCap("Page size: 1000 x 1000 pts", 150), true);  // 2083px
  assert.equal(pdfImageCap("Page size: 3000 x 3000 pts", 72), true);
  assert.equal(pdfImageCap("", 72), true);   // 解析不到就保守封顶
  assert.equal(pdfImageCap("Page size: 340.157 x 453.543 pts (A6)", 150), false);
});
test("missing components are reported per operation without installing anything", () => {
  const info = pdfToolsInfo();
  assert.deepEqual(Object.keys(info.operations).sort(), ["compress", "extract", "images", "merge", "rotate", "split"]);
  assert.equal(info.maxImagePages, 100);
});

test("parser environment drops credentials, proxy settings and unrecognized runtime-prefixed variables", () => {
  // 只向纯函数传假数据，不读取或改写测试进程中的真实凭据。
  const sensitive = {
    OPENAI_API_KEY: "fake-key", ANTHROPIC_AUTH_TOKEN: "fake-token", PDF_TEST_API_KEY: "fake-key",
    CCAPP_KEY_FILE: "/fake/key-file", CCAPP_TOKEN_FILE: "/fake/token-file", CCAPP_GLIBC_API_KEY: "fake-key",
    HTTP_PROXY: "http://fake.invalid", HTTPS_PROXY: "http://fake.invalid", NODE_OPTIONS: "--require=/fake/hook",
  };
  const env = _pdfForTest.pdfEnv(root, { ...sensitive, PATH: "/untrusted/search/path", HOME: "/fake/home", CCAPP_BIN: "/runtime/bin" });
  for (const name of Object.keys(sensitive)) assert.equal(Object.hasOwn(env, name), false, name);
  assert.equal(env.HOME, root); assert.equal(env.TMPDIR, root); assert.equal(env.XDG_CONFIG_HOME, root);
  assert.ok(!env.PATH.includes("/untrusted/search/path"));
  assert.ok(env.PATH.split(path.delimiter).includes("/runtime/bin"));
});

test("parser environment retains the exact Android loader variables and bionic preload", () => {
  const runtime = {
    CCAPP_LD: "/apk/ld.so", CCAPP_SELF_EXE: "/runtime/node", CCAPP_GLIBC_LIB: "/runtime/glibc/lib",
    CCAPP_GLIBC_PRELOAD: "/apk/glibc-shim.so", CCAPP_BIONIC_PRELOAD: "/apk/bionic-shim.so", CCAPP_EXEC: "loader",
    TERMUX_APP__DATA_DIR: "/data/user/0/example", TERMUX_APP__LEGACY_DATA_DIR: "/data/data/example", TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: "force",
  };
  const env = _pdfForTest.pdfEnv(root, { ...runtime, LD_PRELOAD: "/wrong/preload.so" });
  for (const [name, value] of Object.entries(runtime)) assert.equal(env[name], value, name);
  assert.equal(env.LD_PRELOAD, runtime.CCAPP_BIONIC_PRELOAD);
  assert.equal(env.LC_ALL, "C");
});

// 受控 CLI 只检查任务边界/退出路径，不冒充 PDF 格式验证。真实 qpdf/Poppler 的行为另作集成验证。
test("CLI lifecycle: snapshots, one active job, cancellation, failure cleanup and compression warning", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const bin = path.join(PREFIX, "bin"), owned = [];
  const script = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2), name=path.basename(process.argv[1]);
const files=a.filter(x=>x.endsWith('.pdf')&&fs.existsSync(x));
const text=files.map(x=>fs.readFileSync(x,'utf8')).join('');
if(text.includes('WAIT')) await new Promise(r=>setTimeout(r,60000));
if(text.includes('FAIL')) process.exit(2);
if(a.includes('--show-npages')) { console.log(3); process.exit(0); }
const dest=name==='pdf-shrink'?a[1]:a.at(-1);
fs.writeFileSync(dest,'%PDF-result\\n'+JSON.stringify({a,text,home:process.env.HOME,environmentNames:Object.keys(process.env)}));
`;
  for (const name of ["qpdf", "pdf-shrink", "gs"]) {
    const f = path.join(bin, name); assert.equal(fs.existsSync(f), false, "fixture must not overwrite a real program");
    fs.writeFileSync(f, script, { mode: 0o755 }); owned.push(f);
  }
  try {
    await t.test("file names stay data and parser uses the isolated job home", async () => {
      const j = startPdfJob(body("ok")); await j.done;
      assert.equal(j.state, "done");
      const got = fs.readFileSync(j.outputs[0].path, "utf8");
      assert.match(got, /source/);
      const report = JSON.parse(got.slice(got.indexOf("{")));
      assert.equal(report.home, j.work);
      assert.ok(!report.environmentNames.includes("CCAPP_KEY_FILE"));
      assert.ok(!report.environmentNames.includes("CCAPP_TOKEN_FILE"));
      assert.equal(fs.existsSync(j.work), false);
      assert.equal(fs.readFileSync(src, "utf8"), "%PDF-1.4\nsource\n");
    });
    await t.test("cancelled work cannot publish or block the next task", async () => {
      const wait = path.join(root, "wait.pdf"); fs.writeFileSync(wait, "%PDF-WAIT");
      const j = startPdfJob(body("cancel", { files: [wait] }));
      error(() => startPdfJob(body("busy")), "busy");
      for (let n = 0; n < 100 && !j.child; n++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(j.child); _pdfForTest.stop(j); await j.done;
      assert.equal(j.state, "cancelled"); assert.equal(fs.existsSync(j.dest), false); assert.equal(fs.existsSync(j.work), false);
    });
    await t.test("tool failure removes only temporary work and preserves originals", async () => {
      const bad = path.join(root, "bad.pdf"); fs.writeFileSync(bad, "%PDF-FAIL");
      const j = startPdfJob(body("failed", { files: [bad] })); await j.done;
      assert.equal(j.state, "error"); assert.equal(j.code, "tool-failed");
      assert.equal(fs.existsSync(j.dest), false); assert.equal(fs.existsSync(j.work), false);
      assert.equal(fs.readFileSync(bad, "utf8"), "%PDF-FAIL");
    });
    await t.test("compression growth is returned as a warning", async () => {
      const j = startPdfJob(body("larger", { operation: "compress", quality: "ebook" })); await j.done;
      assert.equal(j.state, "done"); assert.equal(j.warning, true);
      assert.ok(j.outputBytes >= j.inputBytes);
    });
  } finally {
    for (const f of owned) fs.unlinkSync(f);
  }
});

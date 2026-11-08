// 0.6.10 车道 b3：Office 转换的 detached 子进程复用组件的 .runs 运行标记（195-T.4）
// 网关被 SIGKILL 后 soffice 会被 init 收养；标记留给下一任网关的 reapComponentRuns() 清理。
// 正常退出（含失败、超时被杀）要把自己的标记删掉。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { COMP_DIR } from "../gw/components.mjs";
import { _officeForTest } from "../gw/office.mjs";

const RUNS = path.join(COMP_DIR, ".runs");
const SOFFICE = path.join(PREFIX, "bin", "soffice");
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";

after(() => {
  fs.rmSync(SOFFICE, { force: true });
  fs.rmSync(_officeForTest.OFFICE_DIR, { recursive: true, force: true });
  fs.rmSync(RUNS, { recursive: true, force: true });
});

test("转换期间 .runs 里有 soffice 标记，正常结束删掉（195-T.4）", async () => {
  fs.mkdirSync(path.dirname(SOFFICE), { recursive: true });
  // 假的 soffice：等一下再按 --outdir 写出 in.pdf，留出观察标记的窗口
  fs.writeFileSync(SOFFICE, [
    `#!${SYS_SH}`,
    "sleep 0.4",
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--outdir" ]; then out="$a"; fi',
    '  prev="$a"',
    "done",
    '[ -n "$out" ] && printf "%%PDF-1.4 fake" > "$out/in.pdf"',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.chmodSync(SOFFICE, 0o755);

  const dir = path.join(_officeForTest.OFFICE_DIR, "src");
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, "doc.docx");
  fs.writeFileSync(src, "fake docx");
  const out = path.join(_officeForTest.OFFICE_DIR, "out.pdf");

  const p = _officeForTest.officeConvert(src, "0123456789abcdef0123", out);
  let found = "";
  for (let i = 0; i < 40 && !found; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      for (const f of fs.readdirSync(RUNS)) {
        const j = JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf8"));
        if (String(j.cmd || "").split("/").pop() === "soffice") { found = f; break; }
      }
    } catch {}
  }
  assert.ok(found, "转换期间 .runs 里要有 soffice 的运行标记");
  const mark = JSON.parse(fs.readFileSync(path.join(RUNS, found), "utf8"));
  assert.ok(Number.isInteger(mark.pid) && mark.pid > 0);
  assert.equal(mark.gw, process.pid, "标记要记网关身份，双网关重叠启动时不抢杀");

  await p;
  assert.ok(fs.existsSync(out), "转换产物要就位");
  assert.equal(fs.existsSync(path.join(RUNS, found)), false, "正常结束要清掉标记");
});

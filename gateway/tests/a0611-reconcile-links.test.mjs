// 0.6.11 真机：share/doc 修掉后还剩「2 个包的文件不全」—— openssh 的 var/service/*/log/run 指向没装的 termux-services，
// termux-tools 的 bin/xdg-open 指向不随工具包分发的 termux-open：打包时就断，「修补」会白白重装整个工具包。
// 断链只有目标有人负责（在某个清单里）却没了才算缺；共享库 libx.so → libx.so.1 这种被删了照报。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";

const INFO = PREFIX ? path.join(PREFIX, "var/lib/dpkg/info") : "";
const LIST = INFO && path.join(INFO, "rcl0611.list");
const P = (r) => path.join(PREFIX, r);
after(() => {
  if (!PREFIX) return;
  for (const r of ["bin/rcl0611-open", "lib/librcl0611.so", "lib/librcl0611.so.1", "lib/librcl0611-ok.so", "lib/librcl0611-ok.so.1"]) fs.rmSync(P(r), { force: true });
  fs.rmSync(LIST, { force: true });
});

test("断链：目标没人负责的不算缺，目标在清单里却被删了的照报", { skip: !PREFIX && "没有工具包前缀" }, async () => {
  fs.mkdirSync(INFO, { recursive: true });
  fs.mkdirSync(P("bin"), { recursive: true });
  fs.mkdirSync(P("lib"), { recursive: true });
  const pre = "/data/data/cc.test/files/usr/";
  fs.writeFileSync(LIST, ["bin/rcl0611-open", "lib/librcl0611.so", "lib/librcl0611.so.1", "lib/librcl0611-ok.so", "lib/librcl0611-ok.so.1"].map((r) => pre + r).join("\n") + "\n");
  fs.symlinkSync("termux-open-not-shipped", P("bin/rcl0611-open"));   // 目标谁都不负责：打包时就断
  fs.symlinkSync("librcl0611.so.1", P("lib/librcl0611.so"));          // 目标在清单里，被删了
  fs.writeFileSync(P("lib/librcl0611-ok.so.1"), "x");
  fs.symlinkSync("librcl0611-ok.so.1", P("lib/librcl0611-ok.so"));    // 好好的

  const { reconcileNow } = await import("../gw/reconcile.mjs");
  const r = await reconcileNow();
  const f = r.findings.find((x) => x.key === "list-files");
  assert.ok(f, JSON.stringify(r.findings.map((x) => x.key)));
  const line = (f.samples || []).find((s) => s.startsWith("rcl0611"));
  assert.ok(line, JSON.stringify(f.samples));
  assert.match(line, /^rcl0611：2（lib\/librcl0611\.so）$/, "缺的是被删的库和指向它的软链两条，不含没人负责的断链");
});

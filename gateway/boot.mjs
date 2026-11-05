// 网关的引导（安全 5：核对 files/app 到 node 真读进来之间的窗口）。
// 应用（GatewayService）起网关前逐文件核过 files/app，可 node 是按路径去读 server.mjs 和它静态 import 的几十个模块的，
// 核完到读进来的这一下被换掉，跑的就是换过的。这段引导不从盘上读：应用从安装包里取出原文，经 node --input-type=module -e 交进来。
// 它先按应用交来的哈希核 FILES 清单，再挂一个加载钩子：files/app 下的代码一律拿「这次读到的字节」去比清单，比过才交给 node 执行
// （核的和跑的是同一份字节，不留窗口），对不上、清单里没有的不加载，退出码 3 让应用按安装包还原后重起。
// 网关起来以后 appfiles.mjs 再挂一层（快照里的直接用内存那份），后来才 import 的模块两层都过。
// 用法（应用拼的）：node --input-type=module -e <本文件内容> <files/app 目录> <端口>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import module from "node:module";
import { pathToFileURL } from "node:url";

const [root, port] = process.argv.slice(1);
const die = (why) => { process.stderr.write(`⚠️ [应用文件] ${why}，退出等应用按安装包还原\n`); process.exit(3); };
if (!root || !path.isAbsolute(root)) die("引导没拿到 files/app 目录");
// 经 linker64 起时 process.execPath 是 linker64（原来由 NODE_OPTIONS --require lib/execpath.cjs 改回，那也是从盘上读的，网关自己不再挂）；
// 网关拉的子 node 照旧挂 execpath.cjs：应用把它放在 CCAPP_NODE_OPTIONS 里交过来
const self = process.env.TERMUX_EXEC__PROC_SELF_EXE;
if (self && /\/linker64$/.test(process.execPath)) process.execPath = self;
if (process.env.CCAPP_NODE_OPTIONS) { process.env.NODE_OPTIONS = process.env.CCAPP_NODE_OPTIONS; delete process.env.CCAPP_NODE_OPTIONS; }

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let list = null;
try { list = fs.readFileSync(path.join(root, "FILES")); } catch {}
const expect = process.env.CCAPP_FILES_SHA || "";
if (!list || !expect || sha(list) !== expect) die(!list ? "FILES 读不到" : !expect ? "应用没交来 FILES 的哈希" : "FILES 和安装包对不上");
if (typeof module.registerHooks !== "function") die("这个 node 没有 module.registerHooks");
const want = new Map();
for (const l of list.toString("utf8").split("\n")) if (l.length > 65) want.set(l.slice(65), l.slice(0, 64));

let refused = false;
const base = pathToFileURL(root.replace(/\/+$/, "") + "/").href;
module.registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith(base)) return next(url, ctx);
    const rel = decodeURIComponent(url.slice(base.length).replace(/[?#].*$/, ""));
    const h = want.get(rel);
    const r = h ? next(url, ctx) : null;
    const src = r && r.source != null ? Buffer.from(r.source) : null;
    if (!h || !src || sha(src) !== h) {
      process.stderr.write(`⚠️ [应用文件] ${rel}（加载时和安装包对不上），拒绝加载\n`);
      refused = true;
      setImmediate(() => process.exit(3));
      throw new Error(`[应用文件] ${rel} 和安装包对不上，拒绝加载`);
    }
    return { ...r, source: src, shortCircuit: true };
  },
});

const server = path.join(root, "server.mjs");
process.argv = [process.execPath, server, ...(port ? [port] : [])];
// 静态 import 的模块被拒时 import 直接抛错：退出码要是 3（应用见 3 才按安装包还原），别让未处理的异常变成 1
try { await import(pathToFileURL(server).href); }
catch (e) { if (refused) process.exit(3); throw e; }

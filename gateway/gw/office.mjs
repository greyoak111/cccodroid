import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { CFG, HERE, PREFIX, log, tz } from "./config.mjs";
import { ensureShell, killTree } from "./claude.mjs";
import { NEXT, rangeOf, readBody, sendJson } from "./http.mjs";
import { safeFilePath } from "./files.mjs";
import { termEnv } from "./terminal.mjs";
const OFFICE_ENV_DENY = /^(ANTHROPIC_|OPENAI_|GH_|GITHUB_|GITLAB_|GITEE_|AWS_|AZURE_|GOOGLE_|GCP_|HF_|HUGGING|NPM_|DEEPSEEK_|MOONSHOT_|DASHSCOPE_|ZHIPU|ARK_|XAI_|OPENROUTER_|CLAUDE_CODE_OAUTH)|_(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PWD|PASS|PASSPHRASE|AUTH|CREDENTIAL|CREDENTIALS|COOKIE|SESSION)(_FILE)?$|^(PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)$/i;

// ── Office 文档：docx / xlsx 前端自己渲染；ppt / pptx / doc / odt… 交给 LibreOffice 转成 PDF 再看 ──
// LibreOffice 不在工具包里（装好约 830 MB），第一次要看时由用户点一下用 pkg 装。
// 转出来的 PDF 按「路径 + 大小 + 修改时间」缓存在 home/.cache/office-pdf，同一份文件第二次秒开。
const OFFICE_DIR = path.join(CFG.home, ".cache", "office-pdf");
const OFFICE_KEEP = 40;
const sofficePath = () => PREFIX ? path.join(PREFIX, "bin", "soffice") : "";
const officeHave = () => { const s = sofficePath(); return !!s && fs.existsSync(s); };
// 带上 inode 和 ctime：大小、修改时间都能伪造成一样的，ctime 改不了（审查 低21）
const officeKey = (file, st) => crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|${st.ino}|${st.ctimeMs}`).digest("hex").slice(0, 20);

// 文档里写的多是 Windows 字体（宋体、微软雅黑…），本机没有；不配的话 fontconfig 会挑到 Noto CJK 的日文 / 韩文字形。
// 宋体一类映射到 Noto Serif CJK SC，黑体一类映射到 Noto Sans CJK SC（安卓系统自带这两套）
function officeFonts() {
  const f = path.join(OFFICE_DIR, "fonts.conf");
  const alias = (list, to) => list.map((n) => `  <alias binding="same"><family>${n}</family><prefer><family>${to}</family></prefer></alias>`).join("\n");
  const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">${PREFIX}/etc/fonts/fonts.conf</include>
  <cachedir>${path.join(OFFICE_DIR, "fc-cache")}</cachedir>
${alias(["SimSun", "宋体", "NSimSun", "新宋体", "FangSong", "仿宋", "仿宋_GB2312", "KaiTi", "楷体", "楷体_GB2312", "STSong", "华文宋体", "STFangsong", "华文仿宋", "STKaiti", "华文楷体", "Songti SC", "方正书宋_GBK", "方正仿宋_GBK", "方正楷体_GBK", "MingLiU", "PMingLiU", "新細明體"], "Noto Serif CJK SC")}
${alias(["Microsoft YaHei", "微软雅黑", "Microsoft YaHei UI", "SimHei", "黑体", "DengXian", "等线", "PingFang SC", "STHeiti", "华文黑体", "华文细黑", "Heiti SC", "思源黑体", "Source Han Sans SC", "方正黑体_GBK", "Microsoft JhengHei", "微軟正黑體"], "Noto Sans CJK SC")}
  <alias><family>serif</family><prefer><family>Noto Serif CJK SC</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>
  <match target="pattern"><test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="append"><string>Noto Sans CJK SC</string></edit></match>
</fontconfig>
`;
  let cur = ""; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (cur !== xml) fs.writeFileSync(f, xml);
  return f;
}

// 一次只转一个（LibreOffice 吃内存，同一个配置目录也不能两个实例同时用）；同一份文件重复请求合并成一个
const officeJobs = new Map();
// 转完交出去的是哪一版：key → 源文件。转换途中源文件被别的应用存了一次，读的时候按现在的源文件算出来的是另一个 key，
// 刚转好的那份就找不到了（#145-3）。POST 回执把 key 带给前端，GET 认这张表里同一个文件的 key；只留最近几十条
const officeDone = new Map();
let officeQ = Promise.resolve();
function officePdf(file) {
  const st = fs.statSync(file);
  const key = officeKey(file, st), out = path.join(OFFICE_DIR, key + ".pdf");
  if (fs.existsSync(out)) { try { const n = new Date(); fs.utimesSync(out, n, n); } catch {} return Promise.resolve(out); }
  if (officeJobs.has(key)) return officeJobs.get(key);
  const job = (officeQ = officeQ.catch(() => {}).then(() => officeConvert(file, key, out)));
  officeJobs.set(key, job);
  job.finally(() => officeJobs.delete(key)).catch(() => {});
  return job;
}
/** 上一次网关被杀 / 转换早期失败留下的 work-*（里面有用户文档副本）：超过 2 小时的一律清掉（200-8-09） */
function officeCleanWork() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(OFFICE_DIR)) {
      if (!/^work-/.test(f)) continue;
      const p = path.join(OFFICE_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 2 * 3600e3) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}
function officeConvert(file, key, out) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(OFFICE_DIR, { recursive: true });
    const work = path.join(OFFICE_DIR, "work-" + key);
    // 文件名可能带空格、中文、奇怪符号：先拷成固定名字再转，转出来的就是 in.pdf
    const ext = path.extname(file).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
    const src = path.join(work, "in" + ext);
    try {
      officeCleanWork();
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work);
      fs.copyFileSync(file, src);
    } catch (e) {
      // 早期失败（源文件读不了、空间不够）：把已建的 work 目录收掉，别留文档副本（200-8-09）
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      return reject(e);
    }
    // 解析的是外来文档，LibreOffice 又是出过不少漏洞的解析器（审查 10-30 第九份 后端低6）：HOME / TMPDIR 指到这次的工作目录，
    // 不让它顺手碰到真 home 里的令牌和配置；指向密钥、令牌的环境变量一个不给。字体缓存放 office 自己的目录，免得每次重建
    const env = { ...termEnv(), FONTCONFIG_FILE: officeFonts(), SAL_USE_VCLPLUGIN: "svp", HOME: work, TMPDIR: work, XDG_CACHE_HOME: path.join(OFFICE_DIR, "cache"), XDG_CONFIG_HOME: path.join(work, ".config") };
    // CCAPP_LD / CCAPP_SELF_EXE / CCAPP_GLIBC_* 是 exec 垫片要的（36 版靠它起程序），别整个前缀删
    // 名字像凭据的都删：前缀按常见厂商 / 平台，后缀按 KEY、TOKEN、密码一类（以前漏了 *_PASSWORD、GITLAB_* 等，审查 v0513b 低-15）
    for (const k of Object.keys(env)) if (OFFICE_ENV_DENY.test(k)) delete env[k];
    const args = ["-env:UserInstallation=file://" + path.join(OFFICE_DIR, "profile"), "--headless", "--norestore", "--nologo",
      "--convert-to", "pdf", "--outdir", work, src];
    const nice = path.join(PREFIX, "bin", "nice");
    // 经 Claude 用的那个 shell 包装起：soffice 是 #!$PREFIX/bin/sh 脚本，里面还会调别的脚本
    const argv = [ensureShell(), "-c", 'exec "$0" "$@"', ...(fs.existsSync(nice) ? [nice, "-n", "5"] : []), sofficePath(), ...args];
    const t0 = Date.now();
    const c = spawn(argv[0], argv.slice(1), { env, cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log2 = "";
    const grab = (d) => { if (log2.length < 8192) log2 += d; };
    c.stdout.on("data", grab); c.stderr.on("data", grab);
    const timer = setTimeout(() => { try { killTree(c); } catch {} }, 4 * 60e3);
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.on("close", (code) => {
      clearTimeout(timer);
      // 这里跑在事件回调里：statSync/renameSync 抛错没人接，会直接带走整个网关（199-8-01）
      try {
        const pdf = path.join(work, "in.pdf");
        if (fs.existsSync(pdf) && fs.statSync(pdf).size > 0) {
          fs.renameSync(pdf, out);
          fs.rmSync(work, { recursive: true, force: true });
          log(`[office] ${path.basename(file)} → PDF ${Math.round((Date.now() - t0) / 100) / 10}s`);
          officePrune();
          return resolve(out);
        }
        fs.rmSync(work, { recursive: true, force: true });
        const why = log2.trim().split("\n").filter((l) => /error|fail|exception/i.test(l)).pop() || log2.trim().split("\n").pop() || "";
        log(`[office] 转换失败 rc=${code}：${log2.trim().slice(-400)}`);
        reject(new Error(tz("LibreOffice 没转出来") + (why ? "：" + why.slice(0, 200) : `（rc=${code}）`)));
      } catch (e) {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
        log(`[office] 收尾失败：${e && (e.stack || e.message)}`);
        reject(e);
      }
    });
  });
}
function officePrune() {
  try {
    const list = fs.readdirSync(OFFICE_DIR).filter((f) => f.endsWith(".pdf"))
      .map((f) => ({ f: path.join(OFFICE_DIR, f), t: fs.statSync(path.join(OFFICE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of list.slice(OFFICE_KEEP)) fs.rmSync(x.f, { force: true });
  } catch {}
}

// 一键安装：后台跑 pkg install libreoffice，前端轮询进度
let officeInst = null;   // { running, line, rc, at }
function officeInstall() {
  if (officeInst && officeInst.running) return officeInst;
  const pkg = path.join(process.env.CCAPP_BIN || HERE, "pkg.mjs");
  officeInst = { running: true, line: "", rc: null, at: Date.now() };
  const st = officeInst;
  const c = spawn(process.execPath, [pkg, "install", "libreoffice"], { env: termEnv(), cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const eat = (d) => {
    tail = (tail + d.toString()).slice(-4000);
    const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) st.line = lines[lines.length - 1].slice(0, 200);
  };
  c.stdout.on("data", eat); c.stderr.on("data", eat);
  c.on("error", (e) => { st.running = false; st.rc = -1; st.line = e.message; });
  c.on("close", (code) => {
    st.running = false; st.rc = code;
    if (code === 0 && !officeHave()) st.rc = 1;
    log(`[office] 安装 LibreOffice 结束 rc=${st.rc}：${st.line}`);
  });
  return st;
}

// ── 路由：/api/office/info /api/office/install /api/office/pdf ──
export async function routeOffice(req, res, u, p) {
  // ── Office：LibreOffice 在不在、一键安装、转 PDF（结果按文件缓存）──
  if (req.method === "GET" && p === "/api/office/info") {
    return sendJson(res, 200, { have: officeHave(), can: !!PREFIX, install: officeInst });
  }
  if (req.method === "POST" && p === "/api/office/install") {
    if (!PREFIX) return sendJson(res, 400, { error: "unsupported" });
    if (officeHave()) return sendJson(res, 200, { have: true });
    return sendJson(res, 200, { have: false, install: officeInstall() });
  }
  if (p === "/api/office/pdf") {
    const r = safeFilePath(req.method === "GET" ? u.searchParams.get("path") : JSON.parse((await readBody(req)) || "{}").path);
    if (r.error) return sendJson(res, r.status || 404, { error: r.error });
    if (req.method === "GET") {
      const k = u.searchParams.get("k") || "";
      const key = /^[0-9a-f]{20}$/.test(k) && officeDone.get(k) === r.file ? k : officeKey(r.file, fs.statSync(r.file));
      const out = path.join(OFFICE_DIR, key + ".pdf");
      let st; try { st = fs.statSync(out); } catch { return sendJson(res, 404, { error: "not converted" }); }
      // PDF 也要支持 Range：阅读器按需取页，以前只能整份下载（195-C.2）
      const rg = rangeOf(req.headers.range, st.size);
      if (rg && rg.bad) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
      const head = { "content-type": "application/pdf", "content-length": rg ? rg.end - rg.start + 1 : st.size, "accept-ranges": "bytes", "cache-control": "no-store" };
      if (rg) head["content-range"] = `bytes ${rg.start}-${rg.end}/${st.size}`;
      res.writeHead(rg ? 206 : 200, head);
      const rs = fs.createReadStream(out, rg ? { start: rg.start, end: rg.end } : undefined);
      rs.on("error", () => { try { res.destroy(); } catch {} });
      res.on("close", () => { if (!res.writableFinished) rs.destroy(); });     // 客户端中途断开就关源（#148-1）
      rs.pipe(res);
      return;
    }
    if (!officeHave()) return sendJson(res, 200, { ok: false, missing: true, can: !!PREFIX });
    let out;
    try { out = await officePdf(r.file); } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    const key = path.basename(out, ".pdf");
    officeDone.delete(key); officeDone.set(key, r.file);
    if (officeDone.size > 64) officeDone.delete(officeDone.keys().next().value);
    return sendJson(res, 200, { ok: true, url: "/api/office/pdf?path=" + encodeURIComponent(r.file) + "&k=" + key });
  }
  return NEXT;
}
export const _officeForTest = { officeKey, officeConvert, OFFICE_DIR, officeDone };   // 只给测试用

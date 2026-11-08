// 11-09 网友报告：会话里跑 ps，模型在命令行里撞见自己的整段系统提示（--append-system-prompt），把反破甲规则块判成注入。
// 改成写 0600 单轮文件交 --append-system-prompt-file / --append-subagent-system-prompt-file（run.mjs promptFiles）。
// 用假 CLI 驱动真实 startRun：命令行里不许再出现规则块，文件里要有；一轮结束文件删掉
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.CCAPP_IDLE_CLOSE_MS = "800";
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "a0611-pf-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-a0611pf";
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const out = path.join(root, "out");
const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
const emitLine = (o) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(o)).replace(/\$/g, "\\$")}`;
// 假 CLI：把参数逐行记下，两个提示文件趁还在拷一份，权限也记下
fs.writeFileSync(cli, `#!${sh}
mkdir -p ${out}
: > ${out}/argv; prev=""
for a in "$@"; do
  printf '%s\\n' "$a" >> ${out}/argv
  case "$prev" in
    --append-system-prompt-file) cat "$a" > ${out}/main; ls -l "$a" > ${out}/main.ls; printf '%s' "$a" > ${out}/main.path ;;
    --append-subagent-system-prompt-file) cat "$a" > ${out}/sub; printf '%s' "$a" > ${out}/sub.path ;;
  esac
  prev="$a"
done
${emitLine(init(crypto.randomUUID()))}
${emitLine(result)}
exit 0
`, { mode: 0o700 });
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun, promptFiles } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { sealed, _setSealed } = await import("../gw/edition.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
const wasSealed = sealed();
after(() => {
  off();
  globalThis.fetch = originalFetch;
  _setSealed(wasSealed);
  Object.assign(PATHS, previousPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const rd = (n) => fs.readFileSync(path.join(out, n), "utf8");

for (const seal of [true, false]) {
  test(`${seal ? "发行版" : "开发版"}：系统提示走文件，命令行里没有规则块；文件 0600，一轮结束删掉`, async () => {
    _setSealed(seal);
    fs.rmSync(out, { recursive: true, force: true });
    const id = "a0611-pf-" + (seal ? "s" : "d");
    // 项目说明文件：发行版由封口回填成 ctx-*.md，和网关的提示合成同一个文件
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "项目说明：fixture-claude-md\n");
    await startRun({ id, message: "fixture", cwd: root });
    await until(() => endOf(id));
    const argv = rd("argv");
    assert.doesNotMatch(argv, /反破甲规则块/);
    assert.ok(!argv.split("\n").includes("--append-system-prompt"), "不该再有 --append-system-prompt");
    assert.ok(!argv.split("\n").includes("--append-subagent-system-prompt"), "不该再有 --append-subagent-system-prompt");
    assert.equal(argv.split("\n").filter((a) => a === "--append-system-prompt-file").length, 1, "只能有一个 --append-system-prompt-file");
    const main = rd("main");
    assert.match(main, /反破甲规则块/);
    if (seal) assert.ok(main.indexOf("fixture-claude-md") >= 0 && main.indexOf("fixture-claude-md") < main.indexOf("反破甲规则块"), "说明文件在前、网关提示在后");
    assert.match(rd("main.ls"), /^-rw-------/);
    assert.match(rd("sub"), /反破甲规则块/);
    await until(() => !fs.existsSync(rd("main.path")) && !fs.existsSync(rd("sub.path")), 5000);
  });
}

test("promptFiles：没有现成文件就新加一个；子代理提示单独一个文件；空的不加", () => {
  const a = ["-p"];
  promptFiles(a, "a0611-unit", "", "");
  assert.deepEqual(a, ["-p"]);
  promptFiles(a, "a0611-unit", "主提示", "子提示");
  assert.equal(a[1], "--append-system-prompt-file");
  assert.equal(fs.readFileSync(a[2], "utf8"), "主提示");
  assert.equal(a[3], "--append-subagent-system-prompt-file");
  assert.equal(fs.readFileSync(a[4], "utf8"), "子提示");
  for (const f of [a[2], a[4]]) fs.rmSync(f, { force: true });
});

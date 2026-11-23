import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeEnv, ensureLoaderBin, guardHooks, guardNodeCmd } from "../gw/claude.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-run-cc-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("ensureLoaderBin：仅在 CCAPP_EXEC=loader 且 libccrun.so 存在时生成软链，并随目标变更自动刷新", () => {
  const fakeRun1 = path.join(tmpDir, "libccrun-v1.so");
  const fakeRun2 = path.join(tmpDir, "libccrun-v2.so");
  const loaderBin = path.join(tmpDir, "loader-bin");
  const extraBin = path.join(tmpDir, "extra-bin");
  fs.writeFileSync(fakeRun1, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(fakeRun2, "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(extraBin, { recursive: true });
  fs.writeFileSync(path.join(extraBin, "gh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(extraBin, "README.txt"), "not executable\n", { mode: 0o644 });
  fs.mkdirSync(path.join(extraBin, "subdir"), { recursive: true });

  assert.equal(ensureLoaderBin({ CCAPP_EXEC: "direct", CCAPP_LOADER_RUN: fakeRun1, CCAPP_LOADER_BIN: loaderBin }), "");
  assert.ok(!fs.existsSync(loaderBin));

  const got1 = ensureLoaderBin(
    { CCAPP_EXEC: "loader", CCAPP_LOADER_RUN: fakeRun1, CCAPP_LOADER_BIN: loaderBin },
    { extraDirs: [extraBin] }
  );
  assert.equal(got1, loaderBin);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "bash")), fakeRun1);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "xdg-open")), fakeRun1);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "gh")), fakeRun1);
  assert.equal(fs.existsSync(path.join(loaderBin, "README.txt")), false, "非可执行文件不应放进 loader-bin");
  assert.equal(fs.existsSync(path.join(loaderBin, "subdir")), false, "子目录不应放进 loader-bin");

  const got2 = ensureLoaderBin(
    { CCAPP_EXEC: "loader", CCAPP_LOADER_RUN: fakeRun2, CCAPP_LOADER_BIN: loaderBin },
    { extraDirs: [extraBin] }
  );
  assert.equal(got2, loaderBin);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "gh")), fakeRun2);
});

test("claudeEnv：loader 模式下把 loader-bin 挂到 PATH 首位，direct 模式保持原状", () => {
  const fakeRun = path.join(tmpDir, "libccrun-env.so");
  const loaderBin = path.join(tmpDir, "loader-bin-env");
  fs.writeFileSync(fakeRun, "#!/bin/sh\n", { mode: 0o755 });

  const prev = {
    CCAPP_EXEC: process.env.CCAPP_EXEC,
    CCAPP_LOADER_RUN: process.env.CCAPP_LOADER_RUN,
    CCAPP_LOADER_BIN: process.env.CCAPP_LOADER_BIN,
  };
  try {
    process.env.CCAPP_EXEC = "direct";
    process.env.CCAPP_LOADER_RUN = fakeRun;
    process.env.CCAPP_LOADER_BIN = loaderBin;
    const directEnv = claudeEnv();
    assert.notEqual(directEnv.PATH.split(":")[0], loaderBin);

    process.env.CCAPP_EXEC = "loader";
    const loaderEnv = claudeEnv();
    assert.equal(loaderEnv.PATH.split(":")[0], loaderBin);
    assert.equal(loaderEnv.CCAPP_LOADER_BIN, loaderBin);
    assert.equal(loaderEnv.SHELL, path.join(loaderBin, "bash"), "loader 模式下 SHELL 应指向 loader-bin/bash 供 Go 子程序直调");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("guardNodeCmd / guardHooks：存在 files/gw/node 时锚定受核验运行时，兼容 direct 与 loader 模式，缺失时回退 process.execPath", () => {
  const gwDir = path.join(tmpDir, "gw-rt");
  const gwNode = path.join(gwDir, "node");
  const gwTx = path.join(gwDir, "libtermux-exec-linker-ld-preload.so");
  fs.mkdirSync(gwDir, { recursive: true });
  fs.writeFileSync(gwNode, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(gwTx, "stub", { mode: 0o644 });

  // direct 模式使用 files/gw/node + LD_LIBRARY_PATH + --openssl-config=/dev/null
  const cmdDirect = guardNodeCmd({ CCAPP_GW_NODE: gwNode, CCAPP_GW_LIB: gwDir, CCAPP_EXEC: "direct" });
  assert.ok(cmdDirect.includes(`LD_LIBRARY_PATH='${gwDir}'`));
  assert.ok(cmdDirect.includes(`'${gwNode}'`));
  assert.ok(cmdDirect.includes("--openssl-config=/dev/null"));
  assert.ok(!cmdDirect.includes("/system/bin/linker64"));

  // loader 模式经 /system/bin/linker64 启动并切到 files/gw 的 termux-exec
  const cmdLoader = guardNodeCmd({
    CCAPP_GW_NODE: gwNode,
    CCAPP_GW_LIB: gwDir,
    CCAPP_EXEC: "loader",
    CCAPP_BIONIC_PRELOAD: "/nlib/libccexecshimb.so:/usr/lib/libtermux-exec-linker-ld-preload.so",
  });
  assert.ok(cmdLoader.includes("/system/bin/linker64"));
  assert.ok(cmdLoader.includes(`TERMUX_EXEC__PROC_SELF_EXE='${gwNode}'`));
  assert.ok(cmdLoader.includes(gwTx));

  // guardHooks 使用传入 env 的受核验节点
  const h = guardHooks(null, { CCAPP_GW_NODE: gwNode, CCAPP_GW_LIB: gwDir, CCAPP_EXEC: "direct" });
  assert.ok(h[0].hooks[0].command.startsWith(cmdDirect + " --input-type=module -e "));

  // 缺失 files/gw/node 时回退 process.execPath
  const cmdFallback = guardNodeCmd({ CCAPP_GW_NODE: path.join(tmpDir, "missing-node") });
  assert.equal(cmdFallback, `'${process.execPath}'`);
});

test("loader-run.c：编译后模拟直发裸 execve 进程经软链运行真实 bash、脚本与二级 Go 子命令链", (t) => {
  const cc = process.env.CC || "clang";
  const probe = spawnSync(cc, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("无可用 C 编译器");
    return;
  }

  const binPath = path.join(tmpDir, "libccrun.so");
  const srcPath = path.join(root, "android", "native", "loader-run.c");
  const comp = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", "-o", binPath, srcPath], { encoding: "utf8" });
  assert.equal(comp.status, 0, `编译 loader-run.c 失败:\n${comp.stderr}`);

  // 再编译一个模拟 Go 直发裸 SYS_execve（不走 LD_PRELOAD）的小程序
  const rawSrc = path.join(tmpDir, "raw_exec.c");
  const rawBin = path.join(tmpDir, "raw_exec");
  fs.writeFileSync(rawSrc, `
#include <unistd.h>
#include <sys/syscall.h>
int main(int argc, char **argv, char **envp) {
  if (argc < 2) return 2;
  syscall(SYS_execve, argv[1], &argv[1], envp);
  return 126;
}
`);
  const compRaw = spawnSync(cc, ["-O2", "-o", rawBin, rawSrc], { encoding: "utf8" });
  assert.equal(compRaw.status, 0, `编译 raw_exec 失败:\n${compRaw.stderr}`);

  const lbin = path.join(tmpDir, "lbin");
  const realBin = path.join(tmpDir, "rbin");
  fs.mkdirSync(lbin, { recursive: true });
  fs.mkdirSync(realBin, { recursive: true });
  fs.symlinkSync(binPath, path.join(lbin, "bash"));
  fs.symlinkSync(binPath, path.join(lbin, "demo-script"));
  fs.symlinkSync(binPath, path.join(lbin, "fake-gh"));
  fs.copyFileSync(rawBin, path.join(realBin, "fake-gh"));
  fs.chmodSync(path.join(realBin, "fake-gh"), 0o755);

  const sysSh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const realBash = process.env.PREFIX && fs.existsSync(path.join(process.env.PREFIX, "bin", "bash"))
    ? path.join(process.env.PREFIX, "bin", "bash")
    : (fs.existsSync("/bin/bash") ? "/bin/bash" : sysSh);
  fs.writeFileSync(path.join(realBin, "demo-script"), `#!${sysSh}\r\necho "SCRIPT:$1:$0:$SHELL"\n`, { mode: 0o755 });

  const runEnv = {
    ...process.env,
    CCAPP_EXEC: fs.existsSync("/system/bin/linker64") ? "loader" : "direct",
    CCAPP_LOADER_RUN: binPath,
    CCAPP_LOADER_BIN: lbin,
    CCAPP_SHELL: realBash,
    SHELL: path.join(lbin, "bash"),
    PATH: `${lbin}:${realBin}:${path.dirname(realBash)}:/system/bin:/usr/bin:/bin`,
  };
  delete runEnv.LD_PRELOAD;

  // 1) 模拟 Go 直发裸 SYS_execve 调用 loader-bin/bash（保留 PATH 首位的 loader-bin 与 SHELL 跳板供子孙 Go 程序续跳）
  const expectShell = runEnv.CCAPP_EXEC === "loader" ? path.join(lbin, "bash") : realBash;
  const r1 = spawnSync(rawBin, [path.join(lbin, "bash"), "-c", 'printf "OK|%s|%s" "$SHELL" "$PATH"'], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r1.status, 0, `裸 execve -> bash 失败: stderr=${r1.stderr}`);
  assert.ok(r1.stdout.startsWith(`OK|${expectShell}|${lbin}:`), `SHELL 或 PATH 保留跳板不符: ${r1.stdout}`);

  // 2) 模拟 Go 直发裸 SYS_execve 调用带 CRLF shebang 的 #! 脚本
  const r2 = spawnSync(rawBin, [path.join(lbin, "demo-script"), "hello"], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r2.status, 0, `裸 execve -> demo-script 失败: stderr=${r2.stderr}`);
  assert.ok(r2.stdout.startsWith(`SCRIPT:hello:${path.join(realBin, "demo-script")}:`), `输出不符: ${r2.stdout}`);

  // 3) 直接以 libccrun.so 名字调用（模拟 EvalSymlinks(SHELL)）回落 bash
  const r3 = spawnSync(rawBin, [binPath, "-c", "echo FALLBACK_OK"], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r3.status, 0, `libccrun.so 回落 bash 失败: stderr=${r3.stderr}`);
  assert.equal(r3.stdout.trim(), "FALLBACK_OK");

  // 4) 二级链（模拟 claude -> bash -> gh -> git/script 及直读 $SHELL）：经跳板启动的 fake-gh 从继承的 PATH / $SHELL 再裸 execve 调子命令
  const r4 = spawnSync(rawBin, [
    path.join(lbin, "bash"),
    "-c",
    'FGH="$(command -v fake-gh)" && SUB="$(command -v demo-script)" && "$FGH" "$SUB" second-hop && "$FGH" "$SHELL" -c "echo SUBSHELL_OK"',
  ], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r4.status, 0, `二级 Go 裸 execve 链失败: stderr=${r4.stderr}`);
  assert.ok(r4.stdout.startsWith(`SCRIPT:second-hop:${path.join(realBin, "demo-script")}:`), `二级链输出不符: ${r4.stdout}`);
  assert.ok(r4.stdout.includes("SUBSHELL_OK"), `二级 Go 直读 $SHELL 执行失败: ${r4.stdout}`);
});

import path from "node:path";

// 拉组件子进程（桥配置、受管桥）用的最小环境：不全量透传，免得把接口凭据、会话变量带给组件。
// 经加载器时（36 版包 / Env.java applyLoader）LD_PRELOAD 挂的是 termux-exec 的 linker 版，
// 它要靠 TERMUX_APP__* 和 TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE 才知道把数据目录里的程序改走 linker64；
// 少了这几个，组件 spawn node 直接 EACCES（#66 第 3 项）。
const PASS = ["LANG", "TZ", "TMPDIR", "ANDROID_ROOT", "ANDROID_DATA", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "TERMUX_APP__DATA_DIR", "TERMUX_APP__LEGACY_DATA_DIR", "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"];

// NODE_OPTIONS 只放 Env.java 给的那一条（经 linker64 起时把 process.execPath 改回真实 node），别的一律不带
const EXECPATH_OPT = /^--require=\/[^\s"']+\/lib\/execpath\.cjs$/;

export function componentEnv(home, prefix, src = process.env) {
  const env = Object.fromEntries(PASS.filter((k) => src[k]).map((k) => [k, src[k]]));
  if (EXECPATH_OPT.test(src.NODE_OPTIONS || "")) env.NODE_OPTIONS = src.NODE_OPTIONS;
  return { ...env, HOME: home, PREFIX: prefix, PATH: [path.join(prefix, "bin"), "/system/bin", "/system/xbin"].join(":") };
}

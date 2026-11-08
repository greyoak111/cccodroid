// 测试用预载：记下进程里所有 setInterval 的间隔，退出时再记每个定时器还有没有 ref。
// 用来验证 server.mjs 登记了每天一次的回收站清理，并且 .unref() 过（不拦着退出）。
import fs from "node:fs";

const file = process.env.CCAPP_B3_PROBE;
const timers = [];
const orig = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...rest) {
  const t = orig.call(this, fn, ms, ...rest);
  timers.push([ms, t]);
  return t;
};
process.on("exit", () => {
  try { fs.appendFileSync(file, timers.map(([ms, t]) => `interval ${ms} ref=${t.hasRef()}`).join("\n") + "\n"); } catch {}
});

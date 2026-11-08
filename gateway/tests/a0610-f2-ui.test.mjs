// 0.6.10 审计 f2 车道：设置 / 型号 / 项目 / 脉络前端（195-E.3/E.5/E.9/E.10/E.12、K.2/K.6/K.7/K.8、M.8、N.7、O.8、O.9、BB.4）
// 这些是纯界面改动的关键路径：把「失败要说话、异步要串行、晚到的数据要补上」固定住，避免以后顺手改回去。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = (f) => fs.readFileSync(new URL(`../web/app/${f}`, import.meta.url), "utf8");
const has = (text, re, label) => assert.match(text, re, label);

test("195-O.9 退出登录成功后刷新状态与额度；登录状态查询失败不清掉已显示的额度", () => {
  const s = src("09-settings.js");
  has(s, /if \(r\.ok\) \{ refreshStatus\(\); qbLoad\(\); loadQuota\(\)\.catch/, "退出成功要撤额度");
  has(s, /if \(failed && QB\.cur && QB\.cur\.id === cur\.id\) return QB\.cur;/, "查询失败保留旧额度");
  has(s, /try \{ st = await api\("\/api\/login\/status"\); \} catch \{ failed = true; \}/, "区分失败与未登录");
});

test("195-N.7/M.8/O.8 原生跳转失败回 200+ok:false 要提示；更新状态取不到要显示重试；电池电流一律换算 mA", () => {
  const s = src("10-settings-device.js");
  has(s, /const appPost = async \(url, body\) => \{[\s\S]*?r\.ok === false[\s\S]*?toast\(t\("操作失败：\{msg\}"/, "appPost 检查 ok:false");
  has(s, /if \(act === "appsettings"\) appPost\("\/api\/app\/open_app_settings"\);/, "打开系统设置走 appPost");
  has(s, /function updFailed\(msg\)[\s\S]*?取不到更新状态：\{msg\}[\s\S]*?upd-retry/, "更新状态失败给重试");
  has(s, /if \(r && r\.ok === false\) toast\(r\.message \|\| t\("检查更新失败"\)/, "检查更新检查 ok:false");
  has(s, /Math\.abs\(b\.currentUa\) \/ 1000/, "电流按微安换算");
  assert.doesNotMatch(s, /> 20000 \? 1000 : 1/, "旧的按阈值猜单位已移除");
});

test("195-E.3/E.9 删除正在用的接口后强制重拉型号；自定义接口可单独清除 Key", () => {
  const s = src("11-usage.js");
  has(s, /data-act="clear"[\s\S]*?清除 Key/, "清除 Key 按钮");
  has(s, /post\("\/api\/providers\/save", \{ id: p\.id, clearKey: true \}\)/, "按 id 清 Key");
  has(s, /if \(wasActive\) await loadModels\(true\);/, "删除当前接口后重拉型号");
  has(s, /if \(r && r\.ok === false\) return toast\(t\("删除失败：\{msg\}"/, "删除失败不假装成功");
});

test("195-E.5/E.10/E.12 跟随默认看会话/项目默认；窗口未知仍显示已设压缩线；附加目录增删串行", () => {
  const s = src("12-model-caps.js");
  has(s, /const followEff = \(\) => \{[\s\S]*?state\.sessEff/, "跟随默认取有效默认");
  has(s, /const to = followEff\(\)\.prov;/, "改回默认的确认按有效接口");
  has(s, /已设 \{line\}（模型窗口未知，按你设的生效）/, "窗口未知显示已设值");
  has(s, /let dirQ = Promise\.resolve\(\);[\s\S]*?dirQ = dirQ\.then/, "目录增删排队");
  has(s, /const r = await api\("\/api\/settings"\); if \(r && Array\.isArray\(r\.addDirs\)\) base = r\.addDirs;/, "以服务端当前值为底");
  has(s, /updateDirs\(\(ds\) => ds\.filter\(\(d\) => d !== gone\)\)/, "按目录名删而不是下标");
});

test("195-K.2/K.6/K.7/BB.4 已删项目保留在任务下拉；型号晚到补下拉；返回前确认未保存指令；定时页轮询", () => {
  const s = src("14-projects-sched.js");
  has(s, /已删除的项目（\{id\}）/, "已删项目选项");
  has(s, /if \(o\.isConnected && q\("#t-model"\)\) fillModels\(true\);/, "型号晚到补下拉");
  has(s, /项目指令还没保存，返回会丢掉这次修改/, "返回前确认");
  has(s, /schedPollSet\(name === "sched"\);/, "进页开轮询");
  has(s, /schedPollSet\(false\);/, "离开停轮询");
  has(s, /setTimeout\(async \(\) => \{[\s\S]*?loadSched\(\)[\s\S]*?\}, 5000\)/, "5 秒补拉");
});

test("195-K.8 脉络后台重取保持用户位置：只有头一回拿到图才归位", () => {
  const s = src("18b-lineage.js");
  has(s, /const first = !LIN\.g;[\s\S]*?linPaint\(first\);/, "只有首次 linPaint(true)");
  assert.doesNotMatch(s, /LIN\.g = g; LIN\.stale = false;\s*\n\s*linPaint\(true\)/, "后台重取不再强制归位");
});

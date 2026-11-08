# 车道 g1 报告

起点 `w0610-m@3cc95d3`。名下文件见 `LANE-g1.md`。

## 待办（开工前先列全）

| 条目 | 一句话 | 主要位置 | 状态 |
|---|---|---|---|
| 195-G.5 | 启动随机数 stdin 阻塞读，5 秒超时对无数据管道无效，网关在 listen 前挂住 | `gw/access.mjs:85-99` | 已修 |
| 195-G.6 | 手机浏览器打开 127.0.0.1:8791 静态页能开、`/api/*` 全 403，前端标「网关离线」 | `gw/access.mjs`；提示文案在前端 | 移交 |
| 195-E.6 | 切接口后 `titleModel` 残留旧厂商型号，设置页显示选中、实际静默不用 | `gw/settings.mjs:116-117`；`gw/autotitle.mjs:88-90` | 已修 |
| 195-V.1 | 组件索引无防回滚，`compState` 只比 sha256；UI 不显示待装版本 | `gw/components.mjs`；`web/app/08-extensions.js` | 已修 |
| 195-V.2 | `use-local-index` 是私有目录里的文件开关，可把来源换成 `file://` 且不校验新鲜度 | `gw/components.mjs` | 已修 |
| 195-V.3 | 索引磁盘缓存未验签，同 uid 可伪造条目绕过整条验签链并执行 `first-run.sh` | `gw/components.mjs` | 已修 |
| 196-供应链.1 | 组件安装只按 id 锁，跨组件并发共享文件可被删/覆盖；`compRecords()` 看不到 installing | `gw/components.mjs` | 已修 |
| 196-供应链.2 | 模块/自定义组件暂存清理缺口：devkit-stage 失败不删；`.stage-*` 重启后永久孤儿 | `gw/modules.mjs`（custom.mjs 半 移交） | 待办 |
| 196-供应链.3 | `pkg uninstall/upgrade` 与 `modRemove` 按可写记录删文件，未做 safeRel | `android/assets/bin/pkg.mjs`；`gw/modules.mjs` | 待办 |
| 196-供应链.4 | `devkit.lock.json` 仅靠 TLS、无签名且长期缓存，却参与依赖版本判定 | `android/assets/bin/pkg.mjs` | 待办 |
| 196-供应链.5 | 技能 zip 导入无条目数上限，逐条同步写可阻塞事件循环 | `gw/extensions.mjs`（sessionops.mjs 半 移交） | 待办 |
| 197-9.6 F8 | 组件升级先删旧版再搬新版，中途失败旧版没了 | `gw/components.mjs` | 待办 |
| 200-14-06 | 模块 `first-run` 失败仍写 `.ok` | `gw/modules.mjs` | 待核实（疑似已修） |
| 200-14-07 | 本地文件安装时 `identifyDevkit` 顺序抓 8 个 release 的 lock/sig，无总预算/取消 | 实际在 `android/java/cc/codroid/Updater.java`（主会话名下） | 待办（移交） |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 195-G.5 | 本条 | 经 `/proc/self/fd/0` 重开一份带 `O_NONBLOCK` 的描述符再读，没数据时拿 EAGAIN，5 秒期限才真正生效；重开不了就不读，宁可认不出这个网关也不在 listen 前挂死 | `gateway/tests/a0610-g1-spawn-stdin.test.mjs`：FIFO 模拟应用给的阻塞管道。旧代码 12 秒超时失败，新代码 5.3 秒正常导入；另用真随机数验 proof 按派生钥匙算 |
| 195-E.6 | 本条 | 切厂商时和 `model` 一样把 `SETTINGS.titleModel` 清空，界面不再显示一个实际不用的旧型号 | `gateway/tests/a0610-g1-titlemodel.test.mjs`：旧代码失败、新代码通过；POST 切到另一家后内存与磁盘上的 `titleModel`/`model` 都是 null |
| 195-V.1 | 本条（与 V.2/V.3 同一次提交） | 加 `compVerCmp`/`compOlder`：索引构建比已装记录旧时 `compState` 不再报「可更新」，`compInstall` 直接拒绝降级；卡片同时显示「已装 → 待装」两个版本 | `gateway/tests/a0610-g1-comp-rollback.test.mjs`：旧代码 7 条全挂（缺接口且行为不对），新代码 7 条全过；含 compState 五种版本组合与 compInstall 端到端拒装、记录不动 |
| 195-V.2 | 本条（与 V.1/V.3 同一次提交） | 本地索引只认启动环境变量 `CCAPP_COMPONENTS_USE_LOCAL_INDEX=1`，私有目录里的 `use-local-index` 文件不再算数；与 `allow-unsigned` 同口径 | `gateway/tests/a0610-g1-comp-cache.test.mjs` 第 1 条：放旧开关文件仍走官方源；只有环境变量置 1 才认共享目录索引 |
| 195-V.3 | 本条（与 V.1/V.2 同一次提交） | 磁盘缓存改存每个来源的原始正文与签名，读回来当场按公钥复核（旧格式缓存按未验签处理、`at=0` 强制刷新）；`compInstall` 对未验签条目直接拒绝 | 同上文件后 3 条：真签名缓存重开不联网即用、正文被改即丢弃重拉、伪造的旧格式缓存装不了组件 |
| 196-供应链.1 | 本条 | 加 `compFsExclusive` 串行链：安装的切换（删旧版、写 installing 记录、搬文件）和收尾（技能、共享文件复核、写 ok），以及卸载的「读记录→删文件→删记录→清暂存」都排进同一条链；首启脚本留在锁外，排队中的安装仍可取消。卸载改成退役桥之后、进锁再读记录，不再拿旧快照删文件。`compRecords()` 收录 installing 是第一轮 ecc02e7 已修的（复核确认） | `gateway/tests/a0610-g1-comp-lock.test.mjs`：串行顺序与失败不堵链、installing 组件要用的共享文件在别的组件卸载后仍在且留在它名下；`components` 等 5 个相关测试文件 38 条全过 |

## 不成立

（待补）

## 待定（交回主会话或用户定）

（待补）

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 195-G.6 | `gateway/web/app/19-boot.js`（启动拉 `/api/status` 的那段，约 219-224 行） | 失败时别一律 `setStatus(t("网关离线"), "err")`。手机浏览器从 `127.0.0.1` / `localhost` 打开时，`/api/*` 因来源校验必然 403，这是设计（不能放宽）。判断 `location.hostname` 不是界面专用地址 `127.0.0.2` 且错误 `status === 403` 时，改提示 `t("请在 cccodroid 应用里打开")`；文案连同 9 种译文已写进 `i18n-g1.json` |
| 195-G.6 | `gateway/server.mjs`（启动日志，约 190 行） | `log(\`claude-apk 网关 v3 已启动  http://127.0.0.1:${CFG.port}\`)` 公布的是原生地址，手机浏览器打开只会看到 403。建议改打印界面地址，或补一句「界面请从 cccodroid 应用打开」 |

## 全量测试

（最后跑完补）

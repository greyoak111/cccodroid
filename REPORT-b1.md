# 车道 b1 报告

工作树：`/data/user/0/cc.codrdev/files/home/.work/w0610-b1`（分支 `w0610-b1`，起点 f841c61）。
名下文件：`gw/components.mjs`（供应链 195-V / 196 组件供应链域除外）、`modules.mjs`、`local.mjs`、`login.mjs`、`envfacts.mjs`、`reconcile.mjs`、`edition.mjs`、`feedback.mjs`、`caps.mjs`、`work-island.mjs`、`work-island-core.mjs`、`notices.mjs`、`appfiles.mjs`、`leftover.mjs`、`managed-bridge.mjs`、`bridge-config.mjs`、`android/assets/bin/*`。

## 待办（全部条目）

状态：待办 / 进行中 / 已修 / 不成立 / 待定 / 移交

### #198（P1，先做）
| # | 条目 | 状态 |
|---|---|---|
| 1 | 198 P1-19 `modules.json` 形状坏 → 定时器崩 → 网关崩循环（envfacts/modules） | 已修 |

### #195 F 端侧模型与下载
| # | 条目 | 状态 |
|---|---|---|
| 2 | F.1 llama-server detached，网关重启后成孤儿；SIGTERM 不杀 | 已修 |
| 3 | F.2 模型下载任务只在内存，重启后 detached curl 继续写、可双写 `.part` | 已修 |
| 4 | F.3 下载失败后「移除」只删列表项，不删 `.part`/`.src` | 已修 |
| 5 | F.4 手动放入/直链成功的模型无应用内删除入口 | 移交 f2 |
| 6 | F.5 「校验中」点取消无效，要等整文件 sha256 | 已修 |
| 7 | F.6 端侧模型卡片打开不刷新加载状态（复核不成立） | 不成立（复核） |
| 8 | F.7 会话钉住的端侧模型被删后静默回落最小模型（后端部分） | 已修 |

### #195 G 登录、启动与网关地址（后端部分）
| # | 条目 | 状态 |
|---|---|---|
| 9 | G.2 登录状态 unknown 被当未登录（后端部分） | 待办 |
| 10 | G.3 顶栏「就绪/官方登录态」只看文件存在（caps 后端部分） | 待办 |
| 11 | G.4 登录启动 20 秒拿不到 URL 就失败，不杀子进程、晚到 URL 不读 | 待办 |
| 12 | G.8 登录成功后轮询并发拉多个 `claude auth status` | 待办 |

### #195 I 组件、模块与 pkg
| # | 条目 | 状态 |
|---|---|---|
| 13 | I.1 `pkg uninstall/upgrade` 删组件正在用的同名文件（pkg.mjs + components.mjs） | 待办 |
| 14 | I.2 失败安装暂存残留 / 空间预检重复计入已下载字节（P3） | 已修 |
| 15 | I.3 启动 60 秒后 reconcile 同步扫约 14.4 万路径，阻塞 3.9–12.3 秒 | 待办 |
| 16 | I.4 装完工具包模块后组件卡不刷新（前端） | 移交 f2 |
| 17 | I.5 模块链安装时已装好的模块仍显示「下载中/正在装」（后端部分） | 已修 |
| 18 | I.6 下载完成后不复核组件 `requires`，可装出「已装但缺依赖」 | 已修 |
| 19 | I.7 索引无对应构建时卡片写「需重新安装」但无安装按钮（后端部分） | 移交 f2 |
| 20 | I.8 大组件解压阶段进度条固定 0% | 已修 |
| 21 | I.9 `pkg update` 部分仓库失败/用旧索引仍打印「仓库索引已更新」 | 待办 |

### #195 M 升级、自检与环境实况（后端部分）
| # | 条目 | 状态 |
|---|---|---|
| 22 | M.1 自检结果只在工具包/TAG/模块集合变化时重跑，失败项永久注入；无重新自检入口 | 待办 |
| 23 | M.2 断网时 5 个联网项被记成设备失败（cccodroid-selftest） | 待办 |
| 24 | M.3 工具包换版后环境实况仍把旧组件列为已装 | 待办 |
| 25 | M.4 `claude --version` 被当会话参数走封口（edition 部分） | 待办 |
| 26 | M.5 环境实况永不显示工具包版本（envfacts/feedback） | 待办 |
| 27 | M.6 「核对记录」第一次点击只收起（前端） | 移交 f2 |
| 28 | M.7 首装/主动卸载 Claude Code 后对账报红色 error | 待办 |
| 29 | M.8 更新状态取不到时「更新」分类静默消失（前端） | 移交 f2 |
| 30 | M.9 自检文件合法 JSON 但缺 `fail`/`info` 时反馈接口 500 | 待办 |
| 31 | M.10 版本选单 64 秒/更新日志/修复超时（前端+Java 为主） | 移交 |

### #195 P 后台、锁屏、通知与工作岛
| # | 条目 | 状态 |
|---|---|---|
| 32 | P.1 网关被 SIGKILL 后工作岛不清场（网关侧） | 待办 |
| 33 | P.4 工作岛启动被系统拒绝却仍判「已安装」，每 1.5 秒继续拉 am | 待办 |
| 34 | P.5 并行会话时工作岛只有一份 active | 待办 |
| 35 | P.8 定时任务完成/跳过通知只发一次事件且不落盘（sched/bus，非本车道文件） | 移交 b2/主会话 |

### #195 R
| # | 条目 | 状态 |
|---|---|---|
| 36 | R.8 安全通知取不到时完全静默（notices 后端部分） | 待办 |
| 37 | R.9 登录不完成永久挂（`claude auth login` 无超时） | 待办 |

### #195 T
| # | 条目 | 状态 |
|---|---|---|
| 38 | T.4 组件安装/模型下载的 detached 子进程没有运行标记（components/local 部分） | 已修（office.mjs 部分移交 f2） |

### #195 Z / 真机数据
| # | 条目 | 状态 |
|---|---|---|
| 39 | Z.11 组件记录读不出/超 1MB/解析失败 → `absent` 而非 damaged | 已修 |
| 40 | 真机：组件文档软链悬空、`compState` 只看 `rec.bin` 仍显示 ok | 待办 |
| 41 | 真机：`leftover-kept` 有 1 条死进程 | 待办 |

### #196（主要位置在本车道文件的）
| # | 条目 | 状态 |
|---|---|---|
| 42 | 端侧.4 会话钉住的端侧模型被删后静默回落（同 F.7） | 待办 |
| 43 | 端侧.5 「到 GitHub 反馈」无忙碌态（feedback 后端部分） | 待办 |
| 44 | 组件.2 模块链安装状态（同 I.5） | 待办 |
| 45 | 组件.3 requires 复核（同 I.6） | 待办 |
| 46 | 组件.4 需重新安装无按钮（同 I.7） | 待办 |
| 47 | 组件.5 解压进度 0%（同 I.8） | 待办 |
| 48 | 组件.7 `pkg update`（同 I.9） | 待办 |
| 49 | 启动.1 登录轮询并发（同 G.8） | 待办 |
| 50 | 日志考古.2 工作岛 am 失败误判「应用没装」，无前台重试 | 待办 |
| 51 | 升级.1 环境实况工具包版本（同 M.5） | 待办 |
| 52 | 升级.3 对账报红（同 M.7） | 待办 |
| 53 | 升级.5 反馈接口 500（同 M.9） | 待办 |
| 54 | 共享.2 无存储权限时模型目录显示与实际不符 | 待办 |
| 55 | 网关安全.7 端侧模型从 `/sdcard` 加载时不复核哈希 | 待办 |
| 56 | 上游.4 登录 20 秒不杀子进程（同 G.4） | 待办 |
| 57 | 上游.8 本地桥上游 429/超时/网络错误一律回 HTTP 400 | 待办 |
| 58 | 首装.4 `pkg` 升级中断窗口里旧记录仍 `state:"ok"` 但文件已删 | 待办 |
| 59 | 组件市场.1 装完工具包模块后组件卡不刷新（前端） | 移交 f2 |

### #199 OpenAI 桥 5 条
| # | 条目 | 状态 |
|---|---|---|
| 60 | OB-01 本地桥 Key 同时具备 CCR 管理权限（cli.js/installer.cjs 不在本仓库） | 待定 |
| 61 | OB-02 上游错误体/调用栈/日志原样回传（cli.js 不在本仓库） | 待定 |
| 62 | OB-03 严格 SSE/JSON 校验诱发半截流/502（cli.js 不在本仓库） | 待定 |
| 63 | OB-04 组件版本升级后旧实例被版本门锁死（managed-bridge 部分） | 待办 |
| 64 | OB-05 流式工具调用首片缺 id/name（cli.js 不在本仓库） | 待定 |

### #200
| # | 条目 | 状态 |
|---|---|---|
| 65 | 10-08 模块安装把空/缺失 MANIFEST 当「没有文件要校验」 | 已修 |
| 66 | 13-08 工作岛 am 发送并发 fire-and-forget（Java） | 移交主会话 |
| 67 | 14-06 模块 first-run 失败仍写 `.ok` | 已修 |
| 68 | 14-07 本地文件安装 identifyDevkit 顺序抓 8 个 release（在 Updater.java） | 移交主会话 |
| 69 | OB-06 注册表指向已不存在的私有目录时 `compRemove` 仍被卡住 | 待办 |

### 单条 issue
| # | 条目 | 状态 |
|---|---|---|
| 70 | #180 CLI 签名材料写入失败仍报成功（scripts/install-claude.mjs、devside） | 移交主会话 |
| 71 | #181 工具包空 pending 误提交、迁移失败仍删源（Installer.java） | 移交主会话 |
| 72 | #184 更新恢复覆盖在途状态、开发端换名丢备份（Updater.java/devside） | 移交主会话 |
| 73 | #185 共享文件卸载保护漏算安装中组件（components.mjs） | 已修 |
| 74 | #186 取消组件/模块安装后保留暂存未扣空间预算（components/modules） | 已修 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的 |
|---|---|---|---|
| 198 P1-19 | （本轮） | `modulesInfo()` 校形状：`modules` 非数组返回 null，逐项只留 `id`/`dir` 都是非空字符串的条目；`envFactsTick` 与自检子进程 data/close 回调包 `guarded` | `gateway/tests/a0610-b1-modules-shape.test.mjs`：坏形状不再抛，合法表照旧；去掉修复后测试失败 |
| 195-F.1 / T.4 | （本轮） | llama-server 写 pid 运行标记，新网关启动时按标记清掉上一任留下的进程；`compRun` 给所有组件/模块子进程落 `.runs/<pid>.json`，`reapComponentRuns()` 启动时按 cmdline 核过后清掉 | `a0610-b1-local-comp.test.mjs`：标记的子进程在 `reapComponentRuns()` 后被结束、标记删掉 |
| 195-F.2 / I.2 | （本轮） | detached curl 有了运行标记，新网关先收割再服务，不会两个 curl 写同一个 `.part`；组件/模块空间预检扣掉暂存区里大小对得上的压缩包、先清上次的解包树 | `a0610-b1-local-comp.test.mjs` 的 `modSpaceNeed`；组件侧同一口径 |
| 195-F.3 / F.5 | （本轮） | 下载失败的「移除」连 `.part`/`.src` 一起删；校验中取消立刻从列表收掉，`sha256File` 在下一个数据块检查 `cancelled` 并销毁读流 | `a0610-b1-local-comp.test.mjs`：sha256File 中途取消会 reject |
| 195-F.7 | （本轮） | `ensureLlama(want)` 在钉住的模型不存在时抛错，不再静默换成列表里最小的 | `a0610-b1-local-comp.test.mjs`：`gone-model` 被拒绝 |
| 195-I.5 | （本轮） | 模块链共用一个 job，只有 `job.current` 那一块显示进度/错误，装好的照旧显示 ok | 语法检查 + 手工：装带依赖的模块时观察列表 |
| 195-I.6 | （本轮） | 搬进 `$PREFIX` 前按当前状态再核一次组件 `requires`，依赖在下载期间被卸了就中止 | 语法检查 + 手工：下载大组件时卸依赖 |
| 195-I.8 | （本轮） | 解包阶段 `total=0`，不再画永远 0% 的进度条；解完按 MANIFEST 字节重新给总量 | 手工：装大组件时看进度条是否消失而不是停在 0% |
| 195-Z.11 | （本轮） | 记录文件在但读不出 → `damaged`；`compRecords()` 把 installing 记录和读不出记录的包内 MANIFEST 都算作文件使用者 | `a0610-b1-local-comp.test.mjs`：installing / 坏记录都进表 |
| #185 | （本轮） | `compRecords()` 纳入 installing；提交 `ok` 前复核 `rec.shared` 还在不在；卸载 A 时 B（安装中）的共享文件留下并转记给 B | `a0610-b1-local-comp.test.mjs`：卸载后共享文件还在、记到 B 名下 |
| #186 | （本轮） | 组件/模块空间预检扣掉暂存区里已保留的压缩包，并先清掉上次失败留下的解包树 | `a0610-b1-local-comp.test.mjs` 的 `modSpaceNeed`（无包 1650、有包 550） |
| 200-10-08 | （本轮） | `modManifest()`：空/缺失 MANIFEST 直接拒绝；条目必须是包内相对路径，`..`/绝对路径拒绝 | `a0610-b1-local-comp.test.mjs`：三种情况都覆盖 |
| 200-14-06 | （本轮） | 模块 first-run 失败不再写 `.ok`，抛出错误让模块显示「没装」并可重试 | 手工：让 first-run 返回非 0 后看模块状态 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|
| 195-F.6 / 196 端侧.3 | 复核结论即不成立：每次打开设置都会 `loadProviders → renderProvCard → renderLocalCard` 现拉 `/api/local`（web/app/09-settings.js:16,19-43,75-91,108-113），不是「不刷新」 |

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|
| #199 OB-01/02/03/05 | 所指 `cli.js`、`installer.cjs`、`patch-ccr.js` 不在本仓库（`find` 无结果），是桥运行时下载产物；需主会话确认是否在别处维护 |

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 195-I.4 / 196 组件市场.1 | web/app/08-extensions.js（f2） | 模块安装完成后刷新组件卡 |
| 195-F.4 / 196 端侧.4 | web/app/09-settings.js（f2） | 手动放入/直链下载的模型也显示「删除」按钮；网关的 `op:"remove"` 已支持这些文件 |
| 195-I.7 / 196 组件.4 | web/app/08-extensions.js（f2） | `state=outdated && !available` 时没有安装按钮：改成提示「先更新工具包」或给「检查更新」入口 |
| 195-T.4（office 部分） | gw/office.mjs（f2） | Office 转换的 detached 子进程照 components.mjs 的 `.runs` 标记做，或复用 `markChild` 思路 |
| 200-14-07 | android/java/.../Updater.java（主会话） | `identifyDevkit` 顺序抓 8 个 release 的 lock/sig，加总预算与取消 |
| 195-M.6 | web/app/08-extensions.js（f2） | 核对记录按钮：已有结果时第一次点击应是重核，不是收起 |
| 195-M.8 | web/app/10-settings-device.js、15-pages.js（f2） | 更新状态取不到时保留「更新」分类并提示 |
| 195-M.10 | web/app + Updater.java（f2/主会话） | 版本选单超时、更新日志当前版本标记、修复超时 |
| 195-P.8 | gw/sched.mjs（b2）、gw/bus.mjs（主会话） | 完成/跳过通知落盘，冷启动可补 |
| 200-13-08 | android/java/.../MainActivity.java（主会话） | 工作岛 am 发送串行化，旧 UPDATE 不得晚于 DONE/IDLE |
| #180 | android/assets/scripts/install-claude.mjs、gw/devside.mjs（主会话） | 签名材料写失败不切 current；重装/补核按完整性而非存在 |
| #181 | android/java/.../Installer.java（主会话） | pending 原子发布并在 recover 严格校验；迁移失败不清旧树 |
| #184 | android/java/.../Updater.java、gw/devside.mjs（主会话） | 检查回执不覆盖 devkit 在途状态；换名事务可回滚 |

## 全量测试

（最后更新）

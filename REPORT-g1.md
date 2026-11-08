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
| 196-供应链.2 | 模块/自定义组件暂存清理缺口：devkit-stage 失败不删；`.stage-*` 重启后永久孤儿 | `gw/modules.mjs`（custom.mjs 半 移交） | 已修（模块半）/ 移交（custom.mjs 半） |
| 196-供应链.3 | `pkg uninstall/upgrade` 与 `modRemove` 按可写记录删文件，未做 safeRel | `android/assets/bin/pkg.mjs`；`gw/modules.mjs` | 已修 |
| 196-供应链.4 | `devkit.lock.json` 仅靠 TLS、无签名且长期缓存，却参与依赖版本判定 | `android/assets/bin/pkg.mjs` | 已修 |
| 196-供应链.5 | 技能 zip 导入无条目数上限，逐条同步写可阻塞事件循环 | `gw/extensions.mjs`（sessionops.mjs 半 移交） | 已修（extensions.mjs 半）/ 移交（sessionops.mjs 半） |
| 197-9.6 F8 | 组件升级先删旧版再搬新版，中途失败旧版没了 | `gw/components.mjs` | 已修 |
| 200-14-06 | 模块 `first-run` 失败仍写 `.ok` | `gw/modules.mjs` | 已修（第一轮 ecc02e7；本条补回归测试） |
| 200-14-07 | 本地文件安装时 `identifyDevkit` 顺序抓 8 个 release 的 lock/sig，无总预算/取消 | 实际在 `android/java/cc/codroid/Updater.java`（主会话名下） | 移交 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 195-G.5 | 本条（补 `338731d`） | 经 `/proc/self/fd/0` 重开一份带 `O_NONBLOCK` 的描述符再读，没数据时拿 EAGAIN，5 秒期限才真正生效；重开不了就不读，宁可认不出这个网关也不在 listen 前挂死。补：全量首跑发现 Node 自己的 stdio 管道（`spawnSync` 的 `input`）是 socketpair、`/proc/self/fd/0` 打不开，重开失败且 `fstat` 是 socket 时退回阻塞读（父进程写完就关，不会像应用的真管道那样挂住），别的类型照旧不读 | `gateway/tests/a0610-g1-spawn-stdin.test.mjs`：FIFO 模拟应用给的阻塞管道。旧代码 12 秒超时失败，新代码 5.3 秒正常导入；另用真随机数验 proof 按派生钥匙算。补第 3 条：`spawnSync` 的 socketpair 上派生钥匙也对得上；去掉退路实测红、放回后该文件 3 条 + `antibreach` 全过 |
| 195-E.6 | 本条 | 切厂商时和 `model` 一样把 `SETTINGS.titleModel` 清空，界面不再显示一个实际不用的旧型号 | `gateway/tests/a0610-g1-titlemodel.test.mjs`：旧代码失败、新代码通过；POST 切到另一家后内存与磁盘上的 `titleModel`/`model` 都是 null |
| 195-V.1 | 本条（与 V.2/V.3 同一次提交） | 加 `compVerCmp`/`compOlder`：索引构建比已装记录旧时 `compState` 不再报「可更新」，`compInstall` 直接拒绝降级；卡片同时显示「已装 → 待装」两个版本 | `gateway/tests/a0610-g1-comp-rollback.test.mjs`：旧代码 7 条全挂（缺接口且行为不对），新代码 7 条全过；含 compState 五种版本组合与 compInstall 端到端拒装、记录不动 |
| 195-V.2 | 本条（与 V.1/V.3 同一次提交） | 本地索引只认启动环境变量 `CCAPP_COMPONENTS_USE_LOCAL_INDEX=1`，私有目录里的 `use-local-index` 文件不再算数；与 `allow-unsigned` 同口径 | `gateway/tests/a0610-g1-comp-cache.test.mjs` 第 1 条：放旧开关文件仍走官方源；只有环境变量置 1 才认共享目录索引 |
| 195-V.3 | 本条（与 V.1/V.2 同一次提交） | 磁盘缓存改存每个来源的原始正文与签名，读回来当场按公钥复核（旧格式缓存按未验签处理、`at=0` 强制刷新）；`compInstall` 对未验签条目直接拒绝 | 同上文件后 3 条：真签名缓存重开不联网即用、正文被改即丢弃重拉、伪造的旧格式缓存装不了组件 |
| 196-供应链.1 | 本条 | 加 `compFsExclusive` 串行链：安装的切换（删旧版、写 installing 记录、搬文件）和收尾（技能、共享文件复核、写 ok），以及卸载的「读记录→删文件→删记录→清暂存」都排进同一条链；首启脚本留在锁外，排队中的安装仍可取消。卸载改成退役桥之后、进锁再读记录，不再拿旧快照删文件。`compRecords()` 收录 installing 是第一轮 ecc02e7 已修的（复核确认） | `gateway/tests/a0610-g1-comp-lock.test.mjs`：串行顺序与失败不堵链、installing 组件要用的共享文件在别的组件卸载后仍在且留在它名下；`components` 等 5 个相关测试文件 38 条全过 |
| 196-供应链.2 | 本条 | `modRunInstall` 把解包树记到 `job.stageTree`；`modInstall` 的失败分支当场删掉它（压缩包仍按原逻辑处理）。以前只有下次重装开头才清，用户不再重试就一直占着 | `gateway/tests/a0610-g1-mod-stage.test.mjs`：暂存区放一份校验和对得上、但不是 tar.gz 的文件，让解包失败；任务结束后 `devkit-stage/modx` 必须不存在。去掉清理那行后该测试失败（已实测红/绿） |
| 196-供应链.3 | 本条 | `pkg` 的 `removeFiles` 只遍历 `safeRel` 通过的记录路径（普通相对路径，无 `..` / 反斜杠 / 绝对路径，`rec.files` 非数组也不炸）；`modulesInfo` 用 `modDirOk` 丢掉 dir 不安全的模块条目（卸载会对它整个 `rmSync`），`filesOf` 过滤 FILES 里不安全的行 | `gateway/tests/a0610-g1-path-safety.test.mjs`：坏 dir 条目被丢弃；modRemove 删掉 `bin/safe0610` 但 `../escape0610`、绝对路径、穿越路径都还在；pkg 的 safeRel 抽取求值，十种坏路径全拒、三种正常路径放行 |
| 196-供应链.4 | 本条 | 新增 `android/assets/bin/lockcheck.mjs`（build.sh 会随 `assets/bin/*` 一起打包）：`verifyLock` 对原始字节验 ed25519 签名，并核 `lock.release === tagOf(base)`（与 `Updater.lockSigned` 同口径），公钥与 APK 的 `INDEX_PUBKEY_B64` 同一把。`pkg` 取 lock 后先验签；磁盘缓存改存 `{_for, body, sig}`（原始正文 + 签名），读回来当场复核，旧格式解析对象和 `base` 不明时都不认 | `gateway/tests/a0610-g1-lock-sig.test.mjs`：公钥与 SPKI 尾部一致；改正文 / 错签名 / 旧 tag 重放 / 缺 release 全拒；tagOf 与 Java 正则一致；pkg 接线（下载后验签、缓存原文复核、旧写法已消失）源码断言。`pkg-lock-v062`、`harden-v2b` 7 条全过 |
| 196-供应链.5 | 本条 | `importSkill` 在解压前按 zip 目录尾记录核对条目总数，超过 4096 直接拒绝（不先 inflate 几万个小条目）；解出的文件从 `mkdirSync`/`writeFileSync` 改成 `fs.promises` 逐条 `await` 写，长包不再整段占住事件循环；路由改成 `await importSkill(...)`，导入完成才回包。新提示语（含 9 种译文）在 `i18n-g1.json` | `gateway/tests/a0610-g1-skill-zip.test.mjs`：4097 条目的包被拒且不留目录；正常包与单个 SKILL.md 都落位；导入期间 `setImmediate` 能转（旧的全同步写计数为 0）；源码断言路由 await 与异步写。临时去掉两处修改实测 3 条变红，还原后 5 条全过 |
| 197-9.6 F8 | 本条 | 把切换段从 `compRunInstall` 抽成 `compSwitch`（仍在 `compFsExclusive` 里）：升级时旧版同路径文件先挪进 `<暂存树>.old` 备份，新版全部搬完才算提交点；提交后才删旧版独有的文件（`compRemoveFiles` 新增 `keep` 参数，新版还要的路径不删、共用文件仍转记），旧技能也在此时清。搬运中途失败把备份原样放回、撤掉新放的文件、安装记录退回旧版，用户看到的还是能用的旧版本，而不是 damaged。`_compForTest` 导出 `compSwitch` 供测试 | `gateway/tests/a0610-g1-comp-upgrade.test.mjs`：升级成功覆盖同名、删旧版独有、共用文件保留并转记；把新版一个文件放进只读目录让 rename 失败 → 旧版两个文件内容原样、记录 state 退回 ok/版本 1.0.0、备份目录消失；首次安装照常。临时还原「先删旧版」行为实测 2 条变红，还原后 3 条全过；components/pkg 相关 54 条全过。补 `b6f4996`：回滚时有备份放不回去就留着 `<id>.old`（日志写明位置），不删旧版最后一份 |
| 200-14-06 | ecc02e7（第一轮） | 复核 `modRunInstall`：first-run 非 0 退出时 catch 里直接抛「首次配置没跑完…再装一次会重试」，不再往下走；`.ok` 是最后一行才写。修复本身没动，本条补回归测试把行为钉住 | `gateway/tests/a0610-g1-mod-firstrun.test.mjs`：造真 tar.gz（MANIFEST + `exit 3` 的 first-run.sh）放进暂存区安装；任务结束、`job.error` 命中「首次配置没跑完」、`.ok` 不存在、文件已搬进 `$PREFIX`。临时把 throw 换成 log 实测变红，还原后通过 |

## 不成立

（待补）

## 待定（交回主会话或用户定）

（待补）

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 195-G.6 | `gateway/web/app/19-boot.js`（启动拉 `/api/status` 的那段，约 219-224 行） | 失败时别一律 `setStatus(t("网关离线"), "err")`。手机浏览器从 `127.0.0.1` / `localhost` 打开时，`/api/*` 因来源校验必然 403，这是设计（不能放宽）。判断 `location.hostname` 不是界面专用地址 `127.0.0.2` 且错误 `status === 403` 时，改提示 `t("请在 cccodroid 应用里打开")`；文案连同 9 种译文已写进 `i18n-g1.json` |
| 195-G.6 | `gateway/server.mjs`（启动日志，约 190 行） | `log(\`claude-apk 网关 v3 已启动  http://127.0.0.1:${CFG.port}\`)` 公布的是原生地址，手机浏览器打开只会看到 403。建议改打印界面地址，或补一句「界面请从 cccodroid 应用打开」 |
| 196-供应链.2（custom.mjs 半） | `gateway/gw/custom.mjs`：`CUSTOM_STAGES`（27 行）、`customAnalyze`（223-236 行）、启动入口 | 分析暂存目录 `~/.cccodroid/custom/.stage-*` 只记在内存 map 里：TTL 清理要等下一次分析才跑，网关重启后 map 清空，目录永久留下。建议在 `customAnalyze` 开头（或启动时）先扫一遍 `CUSTOM_DIR`，把名字匹配 `.stage-*`、且不在当前 map 里的目录删掉（重启后 map 必空，全删即可；同进程内超 1 小时的已有逻辑不动）。失败路径 236 行 `fail()` 和安装成功 530 行已经会删，不用改 |
| 196-供应链.5（sessionops.mjs 半） | `gateway/gw/sessionops.mjs`：`zipRead`（646-680 行） | 解压本身仍是逐条 `inflateRawSync`，同步跑在事件循环上；本次在技能导入入口按 EOCD 条目数卡了 4096、总解压量仍有 200 MB 上限，但单个大条目 inflate 期间照样卡住网关。要彻底异步化得把 `zipRead` 改成先读中央目录、逐条 `inflateRaw`（异步）或用 worker，涉及导出/导入等所有调用方，不在本车道文件范围 |
| 200-14-07 | `android/java/cc/codroid/Updater.java`：`identifyDevkit`（320-343 行）、`lockSigned`（612-622 行）、`fetchDevkitFile`（624-630 行）；`Installer.httpGetSmall` / `open`（`Installer.java:265-275,431-437`）；调用点 `MainActivity.java:1006` | 本地文件装工具包时，认不出钉子里的版本就顺序翻最多 8 个 `devkit-*` release：每个先 `httpGetSmall(devkit.lock.json)`，再 `lockSigned` 抓 `.sig`（GitHub 失败还要换 `dl.cccodroid.net` 镜像）。单次请求 connect 20 秒、read 60 秒，最坏是 8×(20+60)×2 个来源，没有总预算、界面上也没法取消。建议：给整段加总时长预算（如 20 秒，`System.nanoTime()` 掐表），进循环前和每轮 fetch 后检查；预算法改成向 `httpGetSmall` 传更短的超时，或新增带 timeout 参数的重载；拿到命中或超预算立即返回 null（调用方按「认不出」处理，已有兜底）。真机验：把网络限速/断掉，从本地文件装工具包，看 logcat `Updater` 标签、识别耗时不超过预算、界面不再长时间卡在识别中 |

## 行为变化（发版说明用）

- 组件升级 / 重装：搬新版文件中途失败（存储满、权限等）时自动回滚，旧版文件与安装记录原样恢复；以前会留下 `installing`（界面显示 damaged）、旧版已被删掉。
- 组件升级 / 重装：底座（dpkg / 工具包 / 模块清单）认领的、或别的组件也在用的同名路径，不再被新版覆盖，留在原地并记进 `shared`；以前工具包清单里那种「不在 dpkg 里的 bin/ 文件」会被新版盖掉。
- 技能包导入：条目数超过 4096 的压缩包直接拒绝并提示（新文案，9 种译文已备）；以前会先全部解出来再逐个写。

## 全量测试

- 第一次（提交 `1bcf514` + 未提交的 F8 回滚小修）：tests 1180 / pass 1178 / fail 1 / skipped 1。失败的是 `antibreach.test.mjs`「启动随机数：经 stdin 交进来，证明身份换成派生钥匙；没交就用令牌」——195-G.5 的回归（Node 自己的 stdio 管道是 socketpair，`/proc/self/fd/0` 重开不了，随机数没读到），已在 `338731d` 修掉并做过红/绿验证；不是 README 里说的 `merge.test.mjs` 偶发。
- 第二次（最终树 `338731d`）：tests 1181 / pass 1180 / fail 0 / skipped 1。跳过的是「1.1 GB 的会话：能分叉、能导出导入」（环境条件不满足，与本车道改动无关）。

# 车道 j2 报告

## 待办（开工前先列全，逐条更新）

| 条目 | 内容 | 状态 |
|---|---|---|
| 13-01 | 闹钟 / 粘性重建拉起的服务没有空闲退出，前台服务 + WakeLock 常驻 | 已修 |
| 13-02（含 1-07、13-12） | 接不了存活网关：`squatted()` 直接 SIGKILL 自己的网关、漏杀 claude 子树；`alive()` 不认证明失败 | 已修 |
| 13-03 | `.run-active` 写失败 / 被第二个网关清掉 → `busy()` 在实际有轮次时返回 false | 已修 |
| 13-04 | Doze 推迟的闹钟被当成「错过」 | 已修 |
| 13-05 | targetSdk 36 上精确闹钟被拒 → 非精确后备在后台起不了前台服务 | 已修 |
| 13-06 | `GatewayService.proc` 不是 volatile | 已修 |
| 13-09 | 安装确认通知用了 `Updater.CH` 频道，新进程里频道可能不存在 | 移交（`Updater.ensureChannel` 已加；`Events.java` 一行调用待主会话） |
| 13-10 | 台账里没找到原文 | 不成立（未找到） |
| 13-11 | `ccapp-sched-next` 直接覆盖 / 撕裂写 → 下次开机没闹钟 | 已修（撕裂部分第一轮 b7706bc 已改 writeAtomic，本轮补写失败重试与读侧） |
| 14-02 | 工具包升级只保留 pip / npm -g，其他用户内容被静默删除 | 已修 |
| 14-03 | 降级保护只在 `checkDevkit` 网络路径，本地文件 / 暂存 / 修复路径能装旧版 | 已修 |
| 14-04 | APK 手动降级没有版本检查；24h 内任何 TAG 变化都被当成「升级」 | 已修 |
| 1-03（GatewayService 半） | 只探测 127.0.0.2:8791；127.0.0.1:8791 被占 → 重启循环 | 已修（本半无新增代码；13-02 重写已走 `Env.portBusy()`，配合 j1 的 Env 半） |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 13-06 | 见 git log | `GatewayService.proc` 加 `volatile`：守护线程赋值、界面线程读，不 volatile 可能拿到 null 漏杀网关 | `javac` 全量通过。真机：替换工具包（设置 → 开发工具包 → 换一个版本）时看 logcat 标签 `cccodroid`，不应出现端口被自己残留网关占住；旧现象是偶发「端口 8791 被别的应用占着」 |
| 13-03 | 见 git log | `runs.mjs` 改用 `writeAtomic` 写标记，写 / 删失败按退避重试；删标记前看主人：只删自己的或主人已死的残留，不动另一个活网关的。`GatewayService` 在「划掉后要停服务」的决定前再问一次网关（`Updater.gatewayBusy()`），问不到才停；`onTaskRemoved` 的这次询问放后台线程并复查界面是否又打开 | 新测试 `gateway/tests/a0610-j2-runflag.test.mjs`（3 条：活网关标记不删 / 死残留删 / 写失败重试成功）连同原 `runflag.test.mjs` 4 条全过；`javac` 全量通过。真机：后台跑一条任务时从最近任务划掉界面，logcat `cccodroid` 应看到「任务跑完再停」且任务结束后服务才停；任务跑完划掉应立即停（最多多等一次 `/api/status` 往返） |
| 13-11 | 见 git log | 撕裂写本身第一轮已由 b7706bc 改成 `writeAtomic`；本轮补两处：`pushNext` 改成写成功才记 `lastNext`（写失败下次 tick 的 `save()` 会补写），写失败也照发 `sched_next` 让在线外壳先定上；`SchedAlarm.fromFile` 只接受 ≤32 字节的普通文件、内容必须是纯数字，半截 / 坏文件不拿去过期时刻登记 | 新测试 `gateway/tests/a0610-j2-sched-next.test.mjs`（同名目录挡住写入，下一拍 tick 补写成功）通过；`javac` 全量通过。真机：给一个任务设 2 分钟后的时间，`adb shell ls -l files/home/ccapp-sched-next` 内容为毫秒时刻；杀掉 App 再开机，logcat `cccodroid` 应看到「定时任务闹钟：…（精确）」 |
| 13-04 | 见 git log | 闹钟的 PendingIntent 里带上计划时刻（`SchedAlarm.EXTRA_AT`），响时 POST `/api/sched/tick` 带 `{"at":…}`；`tick(alarmAt)` 对 `nextAt === alarmAt` 且推迟 ≤30 分钟的计划直接按到点执行，并记一条「被系统推迟 N 分钟」日志；不带时刻（旧外壳）或推迟超过 30 分钟仍是原来的错过逻辑 | 新测试 `gateway/tests/a0610-j2-sched-alarm.test.mjs`（不带时刻按错过 / 带时刻晚 10 分钟按到点 / 晚 40 分钟按错过）通过；`javac` 全量通过。真机：设一个 2 分钟后的任务，息屏等 Doze（或 `adb shell dumpsys deviceidle force-idle`），到点后看 logcat `cccodroid`：应出现「定时任务闹钟响了（计划 …）」与网关日志「被系统推迟了 N 分钟，仍按到点执行」，任务运行记录不是「错过」 |
| 13-01 | 见 git log | 新增 `ACTION_ALARM` / `startAlarm()`：闹钟和系统粘性重建拉起时置 `closeWhenIdle`，给 30 拍（约 60 秒）宽限等网关起来、任务进队列，之后按「三次空闲」退出；界面在前台时每拍把 `closeWhenIdle` 清掉（闹钟叫醒时界面开着、随后按 Home 不会误退）；`SchedAlarm` 改用 `startAlarm()` | `javac` 全量通过。真机：① 关掉界面，设一个 1 分钟后的任务，到点让它跑完，再等约 1 分钟，通知栏「正在运行」应消失（`adb shell dumpsys activity services cc.codroid | grep GatewayService` 查不到）；② 打开界面停在聊天页再按 Home（不划掉），等 2 分钟服务仍应在；③ 后台跑任务时划掉界面，任务跑完后服务才停 |
| 13-02（含 1-07、13-12） | 见 git log | ① `alive()`：自己拉起的网关进程还活着也要过 `/__proof`，起来 20 秒宽限内除外；超时证明不了自己就 `killGateway()` 重起，不再盲目认活进程。② `squatted()`：找到本应用残留网关的 pid 后先 SIGTERM（15）请它自己收尾（它的退出处理会连带结束正在跑的 claude 进程树），最多等 3 秒，不退出才 SIGKILL（9）；之后**不再提前 return**，一律再扫一遍 `CCAPP_TOKEN_FILE` 环境变量清理网关留下的进程（被 SIGKILL 的网关没机会收尾，claude 子树靠这段兜底） | `javac` 全量通过。真机：① 打开应用跑一条长任务，`adb shell ps -A -o PID,PPID,ARGS \| grep -E "server.mjs\|input-type=module"` 找到网关 pid；只杀应用 Java 进程（`adb shell kill -9 <界面/服务进程 pid>`，别用 force-stop，那样整个包都杀了）模拟服务重启，再打开界面：logcat `cccodroid` 应看到「端口上是本应用的残留网关 pid=…，请它退出」，随后新网关启动；正常情况下不应看到「强制结束」（SIGKILL 兜底）；`ps` 里旧的 claude 进程应消失。② 关掉界面再打开，频繁几次不应出现「端口 8791 被别的应用占着」或重启循环 |
| 13-05 | 见 git log | `GatewayService.start()` 改成返回系统收没收下启动请求，`startAlarm()` 返回该值；`SchedAlarm.onReceive` 拿到 false（targetSdk 31+ 后台起前台服务被拒）时发一条「定时任务没有在后台跑」通知，点开进应用；新文案进 `i18n-j2-java.json`，新建独立「定时任务」通知渠道。到点请求的 tick 重试循环不变：用户快点开通知还能赶上前 50 秒的补跑 | `javac` 全量通过；`i18n-j2-java.json` JSON 校验通过（5 键 × 10 语言）。本机 targetSdk 28 不会走这条路径，需 targetSdk 36 的包真机验：① `adb shell appops set cc.codroid SCHEDULE_EXACT_ALARM deny`（或设置里关「闹钟和提醒」）；② 设一个 2 分钟后的任务，退回桌面锁屏；③ 到点看通知栏应出现「定时任务没有在后台跑」，logcat `cccodroid` 有「拉起网关服务被系统拒绝」→「系统不让后台起服务，已发通知请用户打开应用」；④ 点通知进应用，网关启动后任务补跑或界面提示「错过」 |
| 14-02 | 见 git log | `Installer.carryOver` 从「只扫 bin / lib/node_modules / site-packages」改成遍历整个旧 `$PREFIX`：凡是旧工具包任何一份清单都不认领的文件都搬。认主名单对齐网关 `gw/orphans.mjs baseOwnedPaths`——dpkg `.list`、底座 `.devkit-manifest` / `libexec/devkit/FILES` / `MANIFEST`、各模块 `FILES` / `MANIFEST` / `MANIFEST.local`、组件 `MANIFEST` 与 `files/components/*.json` 的 `files`+`shared`。整棵没人认领、新包又没有同名的目录一次 `renameTo`；同名目录下钻只搬多出来的。不搬：`tmp`、`.devkit-ok` / `.devkit-manifest` / `.devkit-relocated`、`var/lib/dpkg`、`libexec/devkit/modules.json` 与模块的 `.ok` / `MANIFEST.local`、以及解释器小版本不同的 `lib/python3.X` | `javac` 全量通过。只读扫描真机现有 `$PREFIX`（50721 个文件）核对认主名单：上述全部来源合并后「没人认领」只剩 1023 个，其中 971 个是 `lib/python3.14` 的 `__pycache__`/.pyc，其余是 ssh host key、`etc/pip.conf`、`glibc/etc/hosts`、gdk-pixbuf / graphviz / mandoc 缓存、`var/lib/dbus/machine-id`——没有旧工具包文件混进来。规则另用一份同逻辑的 JS 对照模拟跑过（自建 mock 树：用户的 bin / etc / share / opt、组件文件、`.ok` / `tmp` / dpkg、同名目录下钻），全部断言通过。真机验：① 终端里 `mkdir -p $PREFIX/share/mytest && echo hi > $PREFIX/share/mytest/a.txt`，记下 `sha256sum $PREFIX/etc/ssh/ssh_host_ed25519_key`；② 设置 → 开发工具包 → 换一个版本安装；③ 装完 `cat $PREFIX/share/mytest/a.txt` 内容还在、ssh host key 的 sha256 不变；④ `ls $PREFIX/libexec/devkit/modules/*/.ok` 的时间戳是这次升级后的（旧 `.ok` 没搬过来），`$PREFIX/tmp` 里没有旧内容 |
| 14-03 | 见 git log | 新增 `devkitFloor()`（已装 tag 与 APK 钉的 tag 取新者，`checkDevkit` 的内联算法改成复用它）与 `allowDevkitDowngrade(tag, who)`：`applyLocalDevkit`（本地文件替换）和 `applyDevkit`（暂存包 / 修复）在动手前比较目标 tag，低于 floor 时用 `Priv.confirm` 弹「把开发工具包降级到 {0}（现在装的是 {1}）」，用户允许才继续；不允许则抛 `{0} 比现在装着的开发工具包旧，没有安装`，已装版本不动。修复路径重装同一版本 tag 相等，不会弹 | `javac` 全量通过。真机验：① 从 GitHub Releases 下一个比已装旧的 `devkit-<旧版本>.tar.gz`；② 设置 → 更新卡片 → 从本地文件安装，选中它：应在界面里弹出确认（Shizuku 特权确认框）「把开发工具包降级到 …」；③ 点不允许：安装界面显示「… 比现在装着的开发工具包旧，没有安装」，`设置 → 关于` 里的工具包版本不变；④ 再来一次点允许：正常装上旧版；⑤ 点「修复」重装同一版本：不应弹这个确认 |
| 1-03（GatewayService 半） | 无新增代码（核对；13-02 的 d47ca8f 重写已覆盖） | 端口判断全部走 `Env.portBusy()`：`squatted()` 一进来就问它（`GatewayService.java:409`），`supervise()` 只在 `squatted()` 返回 false 时才 `spawnGateway()`；`alive()` 用 `Env.proveGateway()`（127.0.0.2）。`GatewayService.java` 里没有别处自己探测端口（全树 grep `Socket` / `connect(` / `portBusy` 核过），也没有只认 127.0.0.2 的判断残留。j1 的 Env 半把 `portBusy()` 改成 `listening(127.0.0.2) || listening(127.0.0.1)`（w0610-j1 的 58607a3，Env.java:162-164；签名不变、`proveGateway()` 无参重载保留，两分支合并无冲突）。合入后：127.0.0.1 被占 → `squatted()` 命中 → 界面显示「端口 8791 被别的应用占着」、每 10 秒重试，不再反复「spawn → 网关退出 → 重拉」 | 代码核对（本半无真机改动；依赖 j1 的 Env 半合并）。合并后真机验：在 `adb shell`（uid 2000，不在本应用 uid 下，不会被 `squatted()` 的 `CCAPP_TOKEN_FILE` 兜底杀掉）里跑 `nc -l 127.0.0.1 8791` 占住主地址，再打开 cccodroid：界面应停在「端口 8791 被别的应用占着，网关起不来」说明页，logcat `cccodroid` 每 10 秒重复这一行，**没有**连番「网关退出 rc=…」重启；释放端口后 10 秒内网关自动起来、界面恢复。若用终端（本应用 uid）里的 `nc` 占端口，兜底逻辑会把它当网关留下的进程杀掉，测不出「别的应用占着」这条路径 |
| 14-04 | 见 git log | `AppFiles.updatedFrom` 加版本判定：当前安装的 versionCode 比上次核对通过时 `seen` 里记的低，就按降级安装处理——返回 null，让调用方按篡改留痕走（整树还原、记账本一条、下一轮告知模型），并在 logcat 记一行「安装的版本（…，NN）比上次核对通过的（…，MM）旧：按降级安装处理，文件差异不当作升级」；只有版本号不降（升级 / 覆盖安装）才继续返回「旧版本名->新版本名」。侧载旧包系统不拦、应用也不静默拒绝，只是不再让它把文件差异吃成「升级」 | `javac` 全量通过；用反射直接调编译产物 `AppFiles.stampVc/versionName`，5 组版本戳（0.6.9 / 0.6.10 / 空 / 乱码 / 缺段）全部符合预期。真机验：① 装新版后打开一次应用让 `seen` 记下（`adb shell run-as cc.codroid cat shared_prefs/appfiles.xml` 能看到 `seen`）；② `adb install -d` 侧载一个更旧、同签名的 cccodroid APK；③ 打开应用：logcat `cccodroid` 应出现「安装的版本（0.6.x，NN）比上次核对通过的（0.6.y，MM）旧：按降级安装处理，文件差异不当作升级」，记账本出现一条「界面与网关的文件被改动过，已按安装包还原」，**不**出现「刚升级」；④ 再做一次正常升级：仍应出现「刚升级（旧->新）」，不产生篡改记录 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|
| 13-10 | 未找到：`audit-0610/ledger/` 全目录搜 `13-10` 只命中 `195.md` 里行内编号 `…:1013-1041` 的字符巧合，没有这一条的原文。按 LANE-j2.md 的约定写「未找到」，没有改代码 |

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 13-09 | `android/java/cc/codroid/Events.java`，`ACTION_INSTALLED` 分支里发「点此确认安装」通知之前（`Events.java:55` 附近） | 在 `new Notification.Builder(c, Updater.CH)` 之前加一行 `Updater.ensureChannel(c);`。`Updater.ensureChannel(Context)` 已在本车道改好并提交（含 `Tr.init` + 建「更新」渠道），构造 Updater 时也走它；但这条安装确认通知是 Events 直接发的，进程可能是新的、Updater 从没构造过，渠道不存在时安卓 8+ 会把通知丢掉。改完真机验：在后台触发一次 APK 安装（设置 → 更新），到「待用户确认」时应弹出「安装 cccodroid 新版本 / 点此确认安装」通知；改之前 logcat 里有 `No Channel found ... channelId=updates` |

## 行为变化

- 13-03：从最近任务划掉界面且没有任务时，服务停止前会多问一次网关的 `/api/status`（最多约 4 秒超时），所以「划掉即停」偶尔会晚几秒。网关挂着没起来时不受影响（探测失败按空闲停）。标记文件里记的 pid 被别的进程复用时，服务会当作「还有任务」继续留着（方向偏保守，不至于把正在跑的任务停掉）。
- 13-01：系统闹钟叫醒（以及系统粘性重建）的服务不再常驻：跑完到点的任务后，约 60 秒宽限 + 6 秒空闲即退出；界面在前台时不算空闲。用户感知：定时任务跑完后，后台通知与 WakeLock 会在约一分钟内消失（以前一直挂着），下次闹钟 / 打开界面会再拉起。
- 13-02：服务重启遇到自己的残留网关时，最多多等约 3 秒让它自己收尾（原先直接 SIGKILL），启动会略慢一点；残留网关退出时如果正在跑任务，那一轮会被结束（SIGTERM 收尾本来就会结束 claude 树），这是有意的——接不了存活网关就不接管它的会话。`alive()` 现在要求自己拉起的网关也能证明自己：起来 20 秒后仍答不出 `/__proof` 会被结束重起（以前一直当它活着）。
- 13-05：targetSdk 31+ 且没给「闹钟和提醒」权限时，非精确闹钟在后台被系统拒绝拉起服务后，会多一条「定时任务没有在后台跑」通知（新渠道「定时任务」）；点开应用后任务补跑或提示错过。targetSdk 28 的现有包无感知。
- 14-02：工具包升级改为遍历整个旧 `$PREFIX`（手机上一轮约 5 万个文件）再搬，升级耗时比只扫三个目录多一些；保留的用户内容范围扩大到 etc / share / var / opt 等处（`tmp`、dpkg 数据库、安装器标记、解释器小版本不同的 `lib/python3.X` 除外）。用 `pkg` / `apt` 装的包仍按旧工具包文件算、不搬（升级后照旧按提示 `pkg restore`）。旧工具包若缺少清单（0.3.9 及以前），认主不全，仍可能把个别旧文件当用户内容搬过来；现网版本都带清单。
- 14-03：从本地文件替换工具包、或安装一个早先下好的暂存工具包时，如果它比已装版本 / 本 APK 钉的版本旧，现在会先弹确认；用户不点允许就不装，安装界面显示「…比现在装着的开发工具包旧，没有安装」，已装版本不受影响（以前会直接装旧版）。确认框要求应用在前台（自动更新路径只会装不低于 floor 的版本，走不到这里）；重装修复同一版本不弹。首次安装（机器上还没有工具包）选本地文件不按降级处理。
- 14-04：手动装旧版 APK（`adb install -d`、文件管理器侧载同签名旧包）后，应用不再把它当「升级」：`files/app` 的版本差异按篡改留痕处理——记账本记一条「界面与网关的文件被改动过，已按安装包还原」、界面提示一次、下一轮告诉模型一次，logcat 有「安装的版本…比上次核对通过的…旧：按降级安装处理」。侧载本身照旧允许（应用不拦截），只是不再静默；看到这条「被改动过」提示时，如果正是你自己刚装的旧版，属预期。正常升级仍走「刚升级（旧->新）」，不产生篡改记录。`seen` 里没有版本戳（0.6.6 之前升上来的）时无法判定，仍按原逻辑处理。

## 全量测试

（最后一次全量的结果）

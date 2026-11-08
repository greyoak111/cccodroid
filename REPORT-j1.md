# 车道 j1 报告

## 待办（名下条目）

| 条目 | 文件 | 状态 |
|---|---|---|
| 199-1-01 | Docs.java SAF provider 把 `.claude/settings*.json` 当普通文件 | 已修 |
| 199-1-02 | MainActivity.java 文件选择结果不校验 authority | 已修 |
| 199-1-03 | Env.java 只探测 127.0.0.2:8791（GatewayService 那半移交 j2） | 已修（Env 半）+ 移交 |
| 199-1-04 | MainActivity.java + 19-boot.js 伪造 SSE / onopen 无校验 | 已修（原生层）+ 移交（04 前端加强） |
| 199-1-05 | MainActivity.java ACTION_SEND 写 workspace/uploads | 待定 |
| 199-1-06 | MainActivity.java IK 明文存 shared_prefs | 已修 |
| 199-1-07 | 并入 13-02，主要位置 GatewayService/Env → 归 j2，配合项写移交 | 移交 |
| 199-1-08 | MainActivity.java 无口令 JS 桥 whatsNew | 已修 |
| 200-13-07 | MainActivity.java 分屏失焦也发通知 | 已修 |
| 200-13-08 | MainActivity.java 工作岛 am 发送并发乱序 | 待做 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 199-1-01 | 本条 | `Docs.java` 加 `sensitive()` / `denySensitive()`：`.claude/settings(.local).json` 在列表、搜索、queryDocument、openDocument（含软链按 fd 真实路径）、create、rename 源/目标、delete 全部拒绝，别的工作区文件不受影响 | `javac` 全量编译通过（JAVAC_OK）。真机：MT 管理器/系统「文件」授权 cccodroid「内部文件」→ 进 workspace/.claude，看不到 settings.json / settings.local.json，搜索也搜不到；同目录别的文件照常读写；对已保存的 settings.json 文档 URI 打开会报「这个文件不通过文件访问提供」 |
| 199-1-02 | 本条 | `chooserResult()` 增加 `ownUri()` 过滤：本应用包名下的 content authority（docs/share/shizuku）和指向应用私有目录的 file URI 一律丢弃，WebView 与浏览器窗格两处共用 | `javac` 全量编译通过。真机：在对话输入框点回形针 → 系统选择器里选 cccodroid「内部文件」里的任意文件 → 不再附加（旧版会以本应用身份读出来）；从相册 / 下载 / 云盘选正常文件照常附加；应用内浏览器网页的 `<input type=file>` 同理 |
| 199-1-03（Env 半） | 本条 | `Env.portBusy()` 改为 `listening(127.0.0.2) \|\| listening(127.0.0.1)`：网关两个回环地址都听，主服务那个被别的应用占住时也要报「被占」，不再让 supervise 反复拉起又退出 | `javac` 全量编译通过。真机：先用别的应用/`nc -l 127.0.0.1 8791` 占住主端口，再启动 App → 应显示「端口被占」提示而不是网关反复重启；释放端口后能正常起。GatewayService 那半见「移交」 |
| 199-1-04 | 本条 | 界面 WebView 的 `shouldInterceptRequest` 给所有指向本网关的 `/api/*` 加一道当场证明：`Env.proveGateway(true)`（不吃 3 秒缓存），核不过直接回 502，请求（连同 Cookie 和用户输入）根本不出 WebView。页面里的 `EventSource` 重连也走这里，冒牌占端口时 `onopen` 不会成立。静态资源原有的 `X-CC-Mac` 校验不变 | `javac` 全量编译通过。真机：正常打开界面、发消息、看事件总线照常；通知栏「停止」网关 → 在应用内终端 `nc -l 127.0.0.2 8791` → 切回已打开的界面，状态应显示「与网关断开，正在重连…」而不是「已连接」，输入框发消息后 nc 终端里看不到任何用户内容（只会有 `/__proof?n=…` 的探测行）；关掉 nc、等网关被拉起后界面自动接回。logcat 无专门标签，可看 `cccodroid` 日志里没有新的异常 |
| 199-1-06 | 本条 | `MainActivity.intentKey()` 改为从 Android Keystore 的不可导出 HMAC 密钥（别名 `cc-ik`，本应用已有 Keystore 用法见 `Consent.java`）派生，不再往 shared_prefs 写明文；旧版本的明文 `k` 首次运行删掉。Keystore 不可用时退回「本次启动随机、只放内存」，绝不写盘 | `javac` 全量编译通过。真机：① 升级安装后运行一次，用应用内终端 `cat /data/user/0/cc.codrdev/shared_prefs/intent.xml` → 里面没有 `k`；② 正常使用通知动作（跑完一轮后切后台收到完成通知，点进去）照常打开对应会话；③ 重启手机后再点旧通知，仍能打开（说明 Keystore 派生的口令跨进程 / 重启稳定）；④ 若某机型 Keystore 异常，动作在进程重启后失效但界面其他功能不受影响（退回内存随机） |
| 199-1-08 | 本条 | `WhatsNew.pending()` 改成纯读：去掉「全新安装」和「本版没写说明」两处 `mark()` 写 side effect，记账只由带口令的 `whatsNewSeen → seen()` 做。无口令的 JS 桥 `whatsNew` 于是变成只读，预览 iframe 调它不会再压掉更新说明（不用动 `theme.js` 的口令表） | `javac` 全量编译通过。真机：① 清数据后全新安装 → 首开不弹更新说明（同旧版）；② 从上一版覆盖升级 → 首开弹本版说明，点「知道了」后再开不再弹（`ui` prefs 里的 `whatsNewSeen` 正常写）；③ 打开一个 HTML 预览，在其 iframe 里执行 `CCApp.whatsNew('zh')`，随后检查 `shared_prefs/ui.xml` 的 `whatsNewSeen` 没有因这次调用被改写（代码层面已保证 `pending()` 不再写，此项可选验） |
| 200-13-07 | 本条 | `onPause()` 里 `visible = false` / `Notify.onBackground()` 只在**不在多窗口**时做：分屏 / 自由窗口失去焦点时聊天还看得见，不算到后台、不补发通知；真正看不见时由新增的 `onStop()` 收尾（`was && !isChangingConfigurations()` 时才发，转屏重建不冒通知）。`Notify.syncAsks/onRunEnd/onSchedNote` 都看 `MainActivity.visible`，分屏里保持 true 即不再弹「待确认 / 跑完了」 | `javac` 全量编译通过（JAVAC_OK）。真机：① 进分屏（ccc 一侧、别的应用一侧），点另一侧让 ccc 失焦 → 发起一轮要跑一会儿的运行，期间跑完或弹确认卡时，通知栏**不应**出现 ccccodroid 的「跑完了 / 待确认」（旧版会发）；② 分屏里把 ccc 完全盖住、或按 Home → 通知照常出现；③ 单窗口按 Home / 熄屏与旧版一致；④ 分屏与单窗口下转屏都不因 activity 重建冒出通知 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|
| 199-1-05 | 确认成立：`MainActivity.receiveShare()`（约 516-598 行）只要收到 `ACTION_SEND` 就直接把文件拷进 `workspace/uploads/`（单个 4 GB、最多 32 个），不要求 `getReferrer()` 有来源（来源不明时连提示都没有），也收不到「草稿取消」的信号，文件永久留下（`gw/files.mjs` 只清一小时前的 `.part-*`）。**没修的原因**：三种可行修法都会改变用户看得到的交互或要动别的车道，按 P3「拿不准交回」处理：① 收文件前弹确认框（推荐）：显示来源和文件数，点「收下」才拷 —— 每次正常分享多一步；② 只收来源可辨（`getReferrer()` 非 null）的分享，来源不明的不写盘只提示 —— 可能误伤不设 referrer 的正常应用；③ 清理：网页侧在附件移除 / 草稿丢弃时调一个带口令的新桥方法 `dropAttach(path)`，Android 只删自己拷出来的路径（需要记一份创建清单），另外 `uploads` 本身的 TTL（6-01）归 f2/主会话。请主会话或用户选一种（建议 ①＋③）。 |

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 199-1-03（GatewayService 半） | `GatewayService.java` 的 `squatted()` / `alive()` | j2 做 13-02 时会重写这段：请保留「两个回环地址都算被占」的前提（`Env.portBusy()` 现已同时探测 127.0.0.1 / 127.0.0.2）；判断「是不是自己的网关」不能只看 127.0.0.2 的 proof |
| 199-1-07 | 并入 13-02（GatewayService / Env），本轮归 j2 | 按 LANE-j1 的划分整条移交；j1 名下没有需要配合的代码点 |
| 199-1-04（前端加强） | `web/app/04-session-flow.js` 的 `connectBus`（约 620-645 行，主会话名下） | 可选加固、不是本条修复的必要条件：原生层已经把 `/api/*`（含 `/api/events`）卡在证明上，核不过时 `onopen` 不会成立。若还想在页面侧再挡一层，可把 `es.onopen` 里直接 `setConn(true)` 改成「收到第一条 `hello` 才置已连接」，并在 3 秒内没收到 hello 时主动 `es.close()` 重连。19-boot.js 这边不需要改：它没有连接状态判断，启动时的 `refreshStatus()`/`connectBus()` 都已被原生层的 `/api` 证明覆盖 |

## 行为变化

| 条目 | 用户可见变化 |
|---|---|
| 199-1-02 | 从系统文件选择器里选 cccodroid「内部文件」里的文件作为附件 / 网页上传，现在会被忽略（工作区文件请用输入框的 `@` 文件面板引用路径）。正常应用（相册、下载、云盘）给的文件不受影响。 |
| 199-1-04 | 网关重启后的第一个 `/api` 请求可能先失败一次（核到新启动号、Cookie 换掉之后自动恢复）；`/api` 请求每次都多一趟本机证明往返（毫秒级）。网关被杀时界面会更快显示「与网关断开」，而不是悄悄把输入发给占端口的应用。 |
| 199-1-06 | 升级到这一版后，升级前发出去、还挂在通知栏里的旧动作通知点进去不再响应（旧口令已作废）；升级后新出现的通知不受影响。第一次运行会把 shared_prefs 里的明文口令删掉。 |
| 199-1-08 | 全新安装后一直没有「看过更新说明」的记录：以后第一次升级时只显示当前这一版的说明（以前会按安装时的版本往后补，跨版本时可能多显示一两版）。正常升级用户无变化。 |
| 200-13-07 | 分屏 / 自由窗口里正在看对话时，不会再收到「跑完了 / 待确认」通知；把 ccc 完全盖住或切走之后照常通知。少数分屏机型从失焦到完全隐藏之间有一小段延迟，通知最多晚到「切走」那一刻。 |

## 全量测试

（未跑）

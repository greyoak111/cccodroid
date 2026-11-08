# 车道 j1 报告

## 待办（名下条目）

| 条目 | 文件 | 状态 |
|---|---|---|
| 199-1-01 | Docs.java SAF provider 把 `.claude/settings*.json` 当普通文件 | 已修 |
| 199-1-02 | MainActivity.java 文件选择结果不校验 authority | 已修 |
| 199-1-03 | Env.java 只探测 127.0.0.2:8791（GatewayService 那半移交 j2） | 已修（Env 半）+ 移交 |
| 199-1-04 | MainActivity.java + 19-boot.js 伪造 SSE / onopen 无校验 | 已修（原生层）+ 移交（04 前端加强） |
| 199-1-05 | MainActivity.java ACTION_SEND 写 workspace/uploads | 待做 |
| 199-1-06 | MainActivity.java IK 明文存 shared_prefs | 待做 |
| 199-1-07 | 并入 13-02，主要位置 GatewayService/Env → 归 j2，配合项写移交 | 移交 |
| 199-1-08 | MainActivity.java 无口令 JS 桥 whatsNew | 待做 |
| 200-13-07 | MainActivity.java 分屏失焦也发通知 | 待做 |
| 200-13-08 | MainActivity.java 工作岛 am 发送并发乱序 | 待做 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 199-1-01 | 本条 | `Docs.java` 加 `sensitive()` / `denySensitive()`：`.claude/settings(.local).json` 在列表、搜索、queryDocument、openDocument（含软链按 fd 真实路径）、create、rename 源/目标、delete 全部拒绝，别的工作区文件不受影响 | `javac` 全量编译通过（JAVAC_OK）。真机：MT 管理器/系统「文件」授权 cccodroid「内部文件」→ 进 workspace/.claude，看不到 settings.json / settings.local.json，搜索也搜不到；同目录别的文件照常读写；对已保存的 settings.json 文档 URI 打开会报「这个文件不通过文件访问提供」 |
| 199-1-02 | 本条 | `chooserResult()` 增加 `ownUri()` 过滤：本应用包名下的 content authority（docs/share/shizuku）和指向应用私有目录的 file URI 一律丢弃，WebView 与浏览器窗格两处共用 | `javac` 全量编译通过。真机：在对话输入框点回形针 → 系统选择器里选 cccodroid「内部文件」里的任意文件 → 不再附加（旧版会以本应用身份读出来）；从相册 / 下载 / 云盘选正常文件照常附加；应用内浏览器网页的 `<input type=file>` 同理 |
| 199-1-03（Env 半） | 本条 | `Env.portBusy()` 改为 `listening(127.0.0.2) \|\| listening(127.0.0.1)`：网关两个回环地址都听，主服务那个被别的应用占住时也要报「被占」，不再让 supervise 反复拉起又退出 | `javac` 全量编译通过。真机：先用别的应用/`nc -l 127.0.0.1 8791` 占住主端口，再启动 App → 应显示「端口被占」提示而不是网关反复重启；释放端口后能正常起。GatewayService 那半见「移交」 |
| 199-1-04 | 本条 | 界面 WebView 的 `shouldInterceptRequest` 给所有指向本网关的 `/api/*` 加一道当场证明：`Env.proveGateway(true)`（不吃 3 秒缓存），核不过直接回 502，请求（连同 Cookie 和用户输入）根本不出 WebView。页面里的 `EventSource` 重连也走这里，冒牌占端口时 `onopen` 不会成立。静态资源原有的 `X-CC-Mac` 校验不变 | `javac` 全量编译通过。真机：正常打开界面、发消息、看事件总线照常；通知栏「停止」网关 → 在应用内终端 `nc -l 127.0.0.2 8791` → 切回已打开的界面，状态应显示「与网关断开，正在重连…」而不是「已连接」，输入框发消息后 nc 终端里看不到任何用户内容（只会有 `/__proof?n=…` 的探测行）；关掉 nc、等网关被拉起后界面自动接回。logcat 无专门标签，可看 `cccodroid` 日志里没有新的异常 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|

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

## 全量测试

（未跑）

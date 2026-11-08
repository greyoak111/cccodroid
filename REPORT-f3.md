# 车道 f3 报告（第二轮）

工作树：`/data/user/0/cc.codrdev/files/home/.work/w0610-f3`，分支 `w0610-f3`，起点 `1c058b1`（第一轮四车道 + 主会话修复已合入）。
范围：只改 `gateway/web/**`（`lang-*.js`、`i18n/*.txt` 不直接改，新文案进 `i18n-f3.json`）。后端要配合的记「移交」。

## 待办（抄自 LANE-f3.md）

### A. 后端已经改好、前端要跟上
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| A1 | 195-A.6 / P1-12 权限模式切档按网关回的 wanted/mode/saved/live 处理 | 03-perm-status.js | 待办 |
| A2 | 195-AA.5 中断卡片重发按 req 还原项目/钉选，textCut 提示 | 04-session-flow.js | 待办 |
| A3 | P1-2 接口卡 keyCleared 提示 | 11-usage.js | 待办 |
| A4 | 195-K.4 / N.1 instrSkipped 提示；删除/改项目 500 显示 message | 14-projects-sched.js | 待办 |
| A5 | 195-G.2 unknown/stale 当还不知道，首屏不收输入框，继续轮询 | 04-session-flow.js | 待办 |
| A6 | 195-G.3 顶栏登录态用 /api/status.auth，退出后刷新 | 19-boot.js | 待办 |
| A7 | 195-G.4 pending 继续轮询，晚到 url 打开 | 09-settings.js | 待办 |
| A8 | 195-R.8 error 显示暂时取不到安全通知，fetching 显示加载 | 04-session-flow.js | 待办 |
| A9 | 195-F.4 / 196 端侧.4 手动放入/直链模型显示删除 | 09-settings.js | 待办 |
| A10 | 195-C.18 后半 0 字节上传放行、失败显示网关原因 | 05-composer.js | 待办 |
| A11 | 195-Y.4 / 196-会话.6 导入读 imported，中途失败列出已导入 | 07-sessions.js | 待办 |

### B. 组件 / 扩展页
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| B12 | 195-I.4 / 196 组件市场.1 装完模块刷新组件卡 | 08-extensions.js | 待办 |
| B13 | 195-I.7 / 196 组件.4 outdated && !available 给「先更新工具包」或检查更新入口 | 08-extensions.js | 待办 |
| B14 | 196 端侧.5（UI）到 GitHub 反馈按钮忙碌态防连点 | 08-extensions.js | 待办 |
| B15 | 195-M.1（UI）加「重新自检」按钮 | 08-extensions.js | 待办 |
| B16 | 195-M.6 核对记录已有结果时第一次点是重核 | 08-extensions.js | 待办 |
| B17 | 195-P.4 工作岛 invalid source 时设置页显示原因和重试 | 09-settings.js | 待办 |
| B18 | 196-注入.2/.3/.4/.6/.9 查看器/Office/扩展页注入面逐条核对 | 16-viewer-git.js · 17-office.js · 08-extensions.js | 待办 |

### C. 会话 / 导航 / 用量
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| C19 | 196-会话.2/.3/.4 搜索失败别显示没找到；改名刷新顶栏；恢复防连点 | 07-sessions.js | 待办 |
| C20 | 195-K.2 任务所属项目被删后编辑保存保留选择并提示 | 14-projects-sched.js | 待办 |
| C21 | 195-K.5 live 无 uuid 时上次读到不更新、旧锚点不清 | 18d-bookmarks.js | 待办 |
| C22 | 195-C.17 查看器点目录链接，文件面板开在查看器底下 | 01-core.js · 06-files.js | 待办 |
| C23 | 195-BB.4 后半 loadSched 加 latest 序号 | 13-nav-menus.js | 待办 |
| C24 | 197-5.4 排队中的定时任务别显示成你发的消息 | 13-nav-menus.js 等 | 待办 |
| C25 | 197-5.7 用量 utilization > 1 按百分数显示 | 11-usage.js | 待办 |
| C26 | 197-5.12 显示层按本地日期算 | 11-usage.js · 14-projects-sched.js · 13-nav-menus.js · 07-sessions.js | 待办 |
| C27 | 195-L.10 改强调色后月报不重绘 | 11-usage.js | 待办 |
| C28 | 195-O.5–O.7 用量页跨午夜/时区重算 | 11-usage.js | 待办 |
| C29 | 195-L.1（前端半）繁体界面拉繁体帮助/更新日志，没有再回落 | 15-pages.js | 待办 |
| C30 | 195-O.2（前端半）自动压缩窗口下限与 CLI 夹取值一致 | index.html | 待办 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|

## 不成立

| 条目 | 理由（代码位置） |
|---|---|

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|

## 全量测试

（待跑）

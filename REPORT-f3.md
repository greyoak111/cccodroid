# 车道 f3 报告（第二轮）

工作树：`/data/user/0/cc.codrdev/files/home/.work/w0610-f3`，分支 `w0610-f3`，起点 `1c058b1`（第一轮四车道 + 主会话修复已合入）。
范围：只改 `gateway/web/**`（`lang-*.js`、`i18n/*.txt` 不直接改，新文案进 `i18n-f3.json`）。后端要配合的记「移交」。

## 待办（抄自 LANE-f3.md）

### A. 后端已经改好、前端要跟上
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| A1 | 195-A.6 / P1-12 权限模式切档按网关回的 wanted/mode/saved/live 处理 | 03-perm-status.js | 已修 d75a459 |
| A2 | 195-AA.5 中断卡片重发按 req 还原项目/钉选，textCut 提示 | 04-session-flow.js | 已修 08bf237 |
| A3 | P1-2 接口卡 keyCleared 提示 | 11-usage.js | 已修 9470fda |
| A4 | 195-K.4 / N.1 instrSkipped 提示；删除/改项目 500 显示 message | 14-projects-sched.js | 已修 1819b42（500 显示 message 现状已满足） |
| A5 | 195-G.2 unknown/stale 当还不知道，首屏不收输入框，继续轮询 | 04-session-flow.js | 已修 08bf237 |
| A6 | 195-G.3 顶栏登录态用 /api/status.auth，退出后刷新 | 19-boot.js | 已修 6b8e634 |
| A7 | 195-G.4 pending 继续轮询，晚到 url 打开 | 09-settings.js | 已修 52c2514 |
| A8 | 195-R.8 error 显示暂时取不到安全通知，fetching 显示加载 | 04-session-flow.js | 已修 08bf237 |
| A9 | 195-F.4 / 196 端侧.4 手动放入/直链模型显示删除 | 09-settings.js | 已修 52c2514 |
| A10 | 195-C.18 后半 0 字节上传放行、失败显示网关原因 | 05-composer.js | 已修 8abc206（失败原因读 message/error 现状已满足） |
| A11 | 195-Y.4 / 196-会话.6 导入读 imported，中途失败列出已导入 | 07-sessions.js | 已修 0428c56 |

### B. 组件 / 扩展页
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| B12 | 195-I.4 / 196 组件市场.1 装完模块刷新组件卡 | 08-extensions.js | 已修 |
| B13 | 195-I.7 / 196 组件.4 outdated && !available 给「先更新工具包」或检查更新入口 | 08-extensions.js | 已修 |
| B14 | 196 端侧.5（UI）到 GitHub 反馈按钮忙碌态防连点 | 08-extensions.js | 已修 |
| B15 | 195-M.1（UI）加「重新自检」按钮 | 08-extensions.js | 移交：envfacts 无强制重跑接口（见移交表） |
| B16 | 195-M.6 核对记录已有结果时第一次点是重核 | 08-extensions.js | 不成立：已由 5fe9c24 修 |
| B17 | 195-P.4 工作岛 invalid source 时设置页显示原因和重试 | 09-settings.js | 移交：网关没有状态出口（见移交表） |
| B18 | 196-注入.2/.3/.4/.6/.9 查看器/Office/扩展页注入面逐条核对 | 16-viewer-git.js · 17-office.js · 08-extensions.js | 已修 dbbcc72（.3/.6/.9）；.2/.4 不成立：已由 f234f61 修（见下表） |

### C. 会话 / 导航 / 用量
| # | 条目 | 文件 | 状态 |
|---|---|---|---|
| C19 | 196-会话.2/.3/.4 搜索失败别显示没找到；改名刷新顶栏；恢复防连点 | 07-sessions.js | 不成立：已由 588ba8a 修（三处都在，见下表） |
| C20 | 195-K.2 任务所属项目被删后编辑保存保留选择并提示 | 14-projects-sched.js | 不成立：已由第一轮 f2 的 9a48bec 修 |
| C21 | 195-K.5 live 无 uuid 时上次读到不更新、旧锚点不清 | 18d-bookmarks.js | 不成立：已由 588ba8a 修（见下表） |
| C22 | 195-C.17 查看器点目录链接，文件面板开在查看器底下 | 01-core.js · 06-files.js | 不成立：已由 588ba8a 修（见下表） |
| C23 | 195-BB.4 后半 loadSched 加 latest 序号 | 13-nav-menus.js | 已修 0c34804 |
| C24 | 197-5.4 排队中的定时任务别显示成你发的消息 | 13-nav-menus.js 等 | 移交：快照不带 sched（见移交表） |
| C25 | 197-5.7 用量 utilization > 1 按百分数显示 | 11-usage.js | 已修 9470fda（前端半；换算在后端，见移交） |
| C26 | 197-5.12 显示层按本地日期算 | 11-usage.js · 14-projects-sched.js · 13-nav-menus.js · 07-sessions.js | 已修 0c34804（11-usage 的跨午夜 / 时区部分早随 C28 修） |
| C27 | 195-L.10 改强调色后月报不重绘 | 11-usage.js | 已修 9470fda |
| C28 | 195-O.5–O.7 用量页跨午夜/时区重算 | 11-usage.js | 已修 9470fda（O.5 的 30 分钟归属精度见待定） |
| C29 | 195-L.1（前端半）繁体界面拉繁体帮助/更新日志，没有再回落 | 15-pages.js | 已修 0c34804 |
| C30 | 195-O.2（前端半）自动压缩窗口下限与 CLI 夹取值一致 | index.html · 12-model-caps.js | 已修 0c34804 |

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 195-A.6 / P1-12 | d75a459 | 全局设置记 `r.wanted`，chip/下拉用网关回的生效 `r.mode`，不再按 `state.safeMode` 二次推导；`r.mode !== 所选` 提示安全模式不生效，`saved === false` 提示没保存上 | `a0610-f3-frontend.test.mjs` 源码断言 |
| 195-AA.5 | 08bf237 | 中断卡片重发按 `it.req` 还原 `view.projectId`（paintProjChip）与 `state.pendingModel`（refreshSessModel）、`pendingMerge`；`textCut` 提示只恢复 6.5 万字 | 同上源码断言 |
| 195-G.2 | 08bf237 | `setupReady` 遇 `unknown`/`stale` 或查询失败返回 null，不把「不知道」当未登录；已登录判断不变 | 同上源码断言 |
| 195-R.8 | 08bf237 | 无内容且 `error` 非空提示「暂时取不到安全通知」，`fetching` 提示「正在获取安全通知…」；卡片里 fetching 也显示加载；每类提示每会话一次 | 同上源码断言 |
| P1-2 | 9470fda | 接口卡保存回 `keyCleared: true` 时提示「换了主机，旧 Key 已清掉，请重新填」，不再只说「已保存」 | `a0610-f3-frontend.test.mjs` 源码断言 |
| 197-5.7（前端） | 9470fda | 用量页 / 设置页额度的数字不再夹到 100（超额度如实显示 120%），进度条只画满；换算在后端 `gw/stream.mjs`，见移交 | 同上源码断言 |
| 195-L.10 | 9470fda | 强调色只改 `<style id="user-accent">` 的文字、不碰 `data-theme`/`data-skin`；单独用 MutationObserver 盯这段 style，创建和每次改色都重画月报 | 同上源码断言；手动：开月报 → 设置里换强调色 → 图立刻换色 |
| 195-O.5–O.7 / 197-5.12（11-usage） | 9470fda | 20 秒轮询和回到前台都检查本地日期 / 时区，变了就按新时区重建日 / 周 / 月分组；轮询比较 `hours+imported+importing+off+since`，补算进度与开关变化也会重画；重置时间已过就不再算「够用」；清除本月区间对到整点桶，不误删邻月 | 同上源码断言；手动：改系统时区 / 等到午夜看「今天」是否归零 |
| 195-K.4（前端半） | 1819b42 | 新建项目回 `instrSkipped` 时提示「项目已创建；目录里已有 CLAUDE.md，填的指令没写进去」，并把用户填的指令并进项目页指令框当未保存草稿（复用 keepDraft / syncSave），不跟着弹窗丢 | 同上源码断言；手动：选一个已有 CLAUDE.md 的目录建项目，看提示与指令框 |
| 195-G.3 | 6b8e634 | 设置页状态框「凭据」行和底部状态条改用 `/api/status.auth`：已登录 / 未登录 / 问不出（unknown 不当作未登录）/ 上次问到的（stale 标明）；真实未登录时状态条不再说「就绪」而说「需要登录账户」；账户菜单先用 `auth` 定登录与否，`/api/login/status` 问不出时不再把上次的「已登录」翻成未登录；退出登录成功立即置 `acctLogged=false`，不等下次查询 | `a0610-f3-frontend.test.mjs` 源码断言；手动：登录态下退出登录，看状态条与账户菜单 |
| 195-G.4 | 52c2514 | 登录启动回 `pending`（20 秒没拿到地址但 claude 还在跑）不再当失败：`paintLoginFlow` 统一画流程块，`watchLogin` 轮询里把晚到的授权地址补开（只开一次）；启动失败 / 没拿到地址的分支也给终端登录入口 | 同上源码断言；手动：慢网启动登录，超过 20 秒看地址是否自动打开 |
| 195-F.4 | 52c2514 | 端侧模型卡每个模型带「删除」按钮（手动放入 / 直链下好的都在列表里），确认后调 `/api/local/model {op:"remove"}`，失败显示网关 message，成功后重画列表 | 同上源码断言；手动：放一个 .gguf 到模型目录，到设置里删掉 |
| 195-C.18 | 8abc206 | 去掉前端对 0 字节文件的本地拦截，直接传给网关（网关已收空文件）；上传失败仍读网关回的 `message` / `error`，没有原因时按 507/413 给本地化说明 | 同上源码断言；手动：选一个空文件附加，看是否成功 |
| 196-会话.6 | 0428c56 | 导入中途失败时读错误回执里的 `imported`（`api()` 抛出的 err 带 body），提示「已导入 {n} 个，后面的失败：{msg}」，不再只说一句「导入失败」把已放好的说没 | 同上源码断言；手动：构造一个中途坏条的 zip，看提示数量 |
| 195-I.4 / 196 组件市场.1 | 404f51e | 模块安装 / 卸载的 POST 一返回任务才刚起（`modInstall` 里 job 异步跑），所以记一个 `modTouched`，等 `loadModules` 下一次渲染发现没有进行中的模块（`moving` 为 false）时再调 `loadComponents()`，组件卡的安装按钮不会再因为依赖模块刚装好而一直灰 | `a0610-f3-frontend.test.mjs` 源码断言；手动：装一个组件依赖的模块，看组件卡按钮是否变可点 |
| 195-I.7 / 196 组件.4 | 404f51e | `state=outdated && !available` 时状态不再写「需要重新安装」，改成「工具包更新过，暂无适配版本」；卡片里加一句说明（先更新工具包 / 点检查更新重拉清单），并复用 `data-c="reindex"` 给「检查更新」按钮（`loadComponents(true)` 强制重拉索引） | 同上源码断言；手动：模拟工具包换过且索引无构建，看卡片是否说明原因并给按钮 |
| 196 端侧.5 | 404f51e | 「到 GitHub 反馈」按钮加 `dataset.busy` + `disabled`：取 Issue 草稿（最坏约 10 秒）期间连点直接返回，成功 / 失败 / 取消都在 `finally` 里恢复 | 同上源码断言；手动：弱网下连点，确认只发一次请求 |
| 196-注入.3 | dbbcc72 | `gitShowCommit` 先归整回执：`message` 非字符串按空串、`files` 非数组按空数组、`hash` / `author` 缺省按空串，显示与点击都用归整后的值，详情面板不再因缺字段抛错卡在「读取中…」 | `a0610-f3-frontend.test.mjs` 源码断言 |
| 196-注入.6 | dbbcc72 | `loadModules` 读 `m.usedBy` 前先 `m.usedBy || {}`，单个模块缺字段不再让整个列表渲染失败、1.5 秒轮询中断 | 同上源码断言 |
| 196-注入.9 | dbbcc72 | 预览页递回的选中项 `sel` 进草稿前把反引号替换成「反引号 + 零宽空格」、换行压成空格，闭合行内代码往草稿注入 Markdown 的路堵上（HTML 段原有的 ``` 处理保留） | 同上源码断言 |
| 195-BB.4（C23） | 0c34804 | `loadSched` 先 `latest("sched")` 领序号，成功 / 失败两条路径都先验序号再落 `SC.data` 或 `SC.err`：hello 与页面刷新并发时，迟到的旧排程不再盖掉新的 | `a0610-f3-frontend.test.mjs` 源码断言 |
| 197-5.12（C26） | 0c34804 | 「仅一次」默认日期改用本地日历的明天（不再取 `toISOString()` 的 UTC 日期）；侧栏「昨天」边界与 `whenText` 的今天 / 明天 / 昨天改按本地日历日比（夏令时那天不是 24 小时）；会话页 7 / 30 天分组同样用 `setDate` 往前推 | 同上源码断言 |
| 195-L.1（C29） | 0c34804 | 帮助 / 更新日志的语言判断从 `/^zh/` 改成精确 `=== "zh"`：繁体（zh-Hant）没有单独一份，不再拉成简体，按注释回落英文 | 同上源码断言 |
| 195-O.2（C30） | 0c34804 | 自动压缩窗口下限与 claude 认的 100k 对齐：输入框加 `min="100000" step="1000"`，手填更小的值按 100k 存并提示；型号页滑块下限 `AC_MIN` 同步改成 100000 | 同上源码断言 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|
| 195-K.2（C20） | 第一轮 f2 的 `9a48bec` 已修：`14-projects-sched.js:505-507` 在任务编辑下拉里补「已删除的项目（{id}）」选项，`collect()` 原样提交 projectId，不会静默清成 null；任务详情 `:369` 另有「项目已删除：到点会跳过…」提示。 |
| 196-注入.2 / .4 | 预览回执缺 `url` 的守卫在 `16-viewer-git.js:863-866`（`typeof r.url !== "string"` 时抛「预览服务没有返回地址」，在 try 内，查看器显示失败而不是停在读取中）；畸形 xlsx 的 `!ref` 在 `17-office.js:167-170` 用 try/catch 包住 `decode_range`，失败显示「这张表的范围信息坏了，读不出来」。两处注释都标了「196 前端注入域」，`git log -S` 指到 `f234f61`（在起点 `1c058b1` 之前）。 |
| 195-M.6（B16） | `08-extensions.js:1311-1314`：`$("btn-reconcile")` 每次点击都调 `loadReconcile(true)`（`/api/reconcile?run=1`），`paintReconcile(r, run)` 的 `always` 为真时即使没有坏项也展开面板；注释写明「已有结果时点它也要重新核」（195-M.6）。`git log -S "195-M.6"` 指到 `5fe9c24`，该提交在起点 `1c058b1` 之前。 |
| 196-会话.2 / .3 / .4（C19） | `588ba8a` 已修三处：搜索失败走 `sess.hitsErr`，渲染只画「搜索失败：… 重试」，`hits` 置 null 后不再显示「没有找到」，也不沿用上次 `hitsTotal`（`07-sessions.js:140-147,197-209`）；改名成功后 `if (id === view.sessionId) { view.title = name; paintTitle(); }`，会话页与侧栏两处都有（`07-sessions.js:443-444`、`13-nav-menus.js:407`）；回收站恢复按钮先 `if (b.disabled) return; b.disabled = true`（`07-sessions.js:412-414`）。 |
| 195-K.5（C21） | `18d-bookmarks.js:133-140`：`viewTopMark()` 返回 null（视口顶部是刚推来的实时消息、还没有 uuid）时，删掉这一会话的旧锚点并写回 localStorage，注释写明「旧锚点必须清掉，不然切回来会跳到更早的旧位置（0.6.9 审计 195-K.5）」。`git log -S "195-K.5"` 指到 `588ba8a`，在起点 `1c058b1` 之前。 |
| 195-C.17（C22） | `01-core.js:1048-1054`：`openPath()` 碰到目录先 `closeViewer()` 再 `openFiles(r.path)`（有未保存修改时先让用户选，选不丢弃就留在查看器），注释「查看器盖着文件页……先关查看器（0.6.9 审计 195-C.17）」。`git log -S "195-C.17"` 指到 `588ba8a`，在起点之前。 |

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|
| 195-O.5（显示归属精度） | 统计按 UTC 整点桶存，半小时 / 45 分时区（印度 +5:30、尼泊尔 +5:45 等）里跨本地午夜的桶只能整桶归到一天，最多差 30 分钟；「清除本月」已改成一整桶都不误删邻月（宁可留下边界不到一小时）。要精确得网关记更细的时间或支持按比例拆分——但消息 / 轮数会出现小数（如「3.5 次」），显示口径要定，故不动。 |

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 197-5.7（后端半） | `gateway/gw/stream.mjs` `noteRateLimit` 里的 `win()`（约 317 行） | 现在写的是 `+x.utilization <= 1 ? Math.round(+x.utilization * 1000) / 10 : +x.utilization`：utilization 本来就是 0–1 的比例（超额度才 >1），>1 时原样透传会被前端当百分数（1.2 显示 1.2% 而不是 120%）。改成一律 `Math.round(+x.utilization * 1000) / 10`。前端（11-usage / 09-settings）已按「网关给的是百分数」显示，后端不动的话超额度仍会显示 1.2%。审计另提到缺「按模型的周窗口」，需要什么数据要主会话定。 |
| 195-M.1（B15，后端半） | `gateway/gw/envfacts.mjs` 的 `envFactsRun()` / `envFactsTick()` | 审计 195-M.1 的「界面无重新自检入口」需要一个能强制重跑 `cccodroid-selftest` 的接口，但 `envFactsRun` 是模块内私有函数，`envFactsTick` 只在结果缺失 / 超过 7 天 / `envFactsKey()` 变化时才跑，网关没有任何 HTTP 路由能触发它。LANE-f3 里写的 `/api/reconcile?run=1` 是「组件 / 模块 / 包记录对磁盘」的对账（`gw/reconcile.mjs:176-181`），跟自检是两套，不能拿来冒充。需要网关加如 `POST /api/env-facts/rerun`（用 guarded 包 `envFactsRun`，返回 `{running, at, pass, fail, info}`），或在 `/api/status` 里带自检状态 + 重跑动作；加好后前端在扩展页 / 设置页给「重新自检」按钮并显示结果。注：审计里「自检时效」的后端半（组件版本进 key、7 天重跑、超时结果不落盘）已由 `604d19a` 修好，这里缺的只是强制重跑入口。 |
| 195-P.4（B17） | `gateway/gw/work-island.mjs`、`gateway/gw/settings.mjs` | 工作岛启动失败（`Can't start from invalid source` 等）只写进网关日志，没有任何接口把 `started` / 最近一次失败原因和时间带出来，前端无法显示原因或提供「重试」。需要网关在 `/api/status`（或设置保存回执）里带上如 `workIsland: { wanted, started, detecting, error, at }`，并给一个重试动作（重新调 `applyWorkIslandSetting()` 即可）。加好后前端在设置页显示原因 + 「重试」按钮。 |
| 197-5.4（C24，后端半） | `gateway/gw/queue.mjs` 的 `snapshot()`（约 83 行） | 队列项在 `enqueue()` 里确实带 `sched`（`queue.mjs:393`，只有网关自己的定时任务能设），但 `snapshot()` 发给前端时只映射了 `{ id, cid, text, sessionId, follow, at, held, intr }`，`sched` 被丢掉；前端 `04-session-flow.js` 的 `renderQueue()`（约 1131 行起）因此只能把每条都画成「你 · 排队中」。需要后端在快照的队列映射里补 `...(q.sched ? { sched: q.sched } : {})`（或 `sched: !!q.sched`）；加好后前端把定时任务的 who 行显示成「定时任务」，并决定按钮（「撤销」应保留，「立即发送」是否给定时任务要主会话定）。 |

## 跨车道测试同步（需要主会话知悉）

第一轮 f1 的 `gateway/tests/a0610-f1-frontend.test.mjs` 有两条断言锁的是本轮 A1 / A10 明确要改掉的旧行为，全量测试因此报 2 条失败。已只改这两处断言与用例标题（其余用例没动，注释里写了「0.6.10 第二轮 f3（A1/A10）」）：

| 位置 | 旧断言 | 改成 | 为什么 |
|---|---|---|---|
| `:89` | `["bypassPermissions", "auto", "acceptEdits"].includes(r.mode)` | `const eff = r.mode || r.wanted || mode` | A1 要求前端不再按 `state.safeMode` 二次推导生效档（195-A.6 / P1-12） |
| `:114` | `src05.includes("if (!f.size)")` | `!src05.includes("if (!f.size)")`，另断言「0 字节也照传：网关现在收空文件」 | A10 要求前端放行 0 字节（195-C.18 后半） |

主会话合并时如果 f1 分支也改过这个文件，以本轮的断言为准：两条旧行为已经被本轮需求取代。

## 全量测试

`cd /data/user/0/cc.codrdev/files/home/.work/w0610-f3 && env -u CCAPP_RUN node scripts/test.mjs`

- 第一次（同步 f1 旧断言之前）：tests 1099，pass 1096，fail 2，skipped 1；两条失败都是 f1 旧断言（见上一节）。
- 同步之后：tests 1099，pass 1098，fail 0，skipped 1，退出码 0（约 9.7 分钟）。

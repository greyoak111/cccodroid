# 车道 b2 报告

工作树：`/data/user/0/cc.codrdev/files/home/.work/w0610-b2`（分支 w0610-b2，起点 f841c61）。
范围：`gateway/gw/sessions.mjs · sessionops.mjs · bookmarks.mjs · lineage.mjs · lineage-store.mjs · archive.mjs · archive-store.mjs · sessmodel.mjs · sched.mjs · usage.mjs · integrity.mjs · projtrust.mjs · merge.mjs · profile.mjs · agents.mjs · transcript.mjs · backfill.mjs · autotitle.mjs · pathnote.mjs · models.mjs · saferead.mjs`。

提交：`7ca9b6e`（状态文件）、`b7706bc`（定时任务）、`bb0f89f`（会话路由/搜索/转写）、`b0ee554`（会话运维）、`134f31d`（代理）、`078a3f3`（回收站返回码）；`492e36d`、`59828ed`、`2e29913`（既有测试适配与新增用例清理）。

## 待办（全部条目，逐条更新）

状态：☑ 已修 / ⊘ 不成立 / ◇ 待定 / ⇄ 移交

### #194 P1
- ☑ 194-P1-9 archive 解析失败不备份（archive-store.mjs）
- ☑ 194-P1-11 sched 状态形状坏 → 启动崩循环（sched.mjs）
- ☑ 194-P1-14 usage 的 hours 形状坏 → 首条消息崩网关（usage.mjs）
- ☑ 194-P1-16 model-windows 为 null/原语 → 每轮收尾崩（models.mjs）

### #195 A 会话与数据生命周期
- ☑ 195-A.1 删“提问已被删掉”的回复会连上一轮回答一起删（sessionops.mjs）
- ⇄ 195-A.2 删项目后恢复会话 cwd 不存在（主位置 projects.mjs；sessionops 侧随 197-2.2 已做）
- ☑ 195-A.3 只剩后台任务的 idle 会话删不掉（sessions.mjs）
- ☑ 195-A.4 定时任务每轮无条件覆盖用户改的会话名（sched.mjs）
- ☑ 195-A.5 回收站有同名会话时导入被跳过（sessionops.mjs）
- ⇄ 195-A.6 删除会话不清排队消息和 run mark（queue.mjs 主位置）
- ☑ 195-A.7 彻底删除/清空回收站不清 archive、sessmodel、书签（sessionops.mjs）
- ⇄ 195-A.8 中断后不封签（queue.mjs/run.mjs 主位置）
- ⇄ 195-A.9 回收站过期只在启动时执行（server.mjs）
- ☑ 195-A.10 删消息整份备份 transcript，.edits 膨胀（sessionops.mjs）
- ⇄ 195-A.11 网关重启一律显示“App 在后台被系统结束”（queue.mjs + 前端）
- ⇄ 195-A.12 空会话号去重会误删旧中断卡（queue.mjs）
- ⇄ 195-A.13 run mark 保留完整队列正文（queue.mjs）
- ☑ 195-A.14 回收站 meta.json 非原子写（sessionops.mjs）
- ◇ 195-A.15 `~/.claude/sessions` 进程索引只增不减（数据清理，待定）

### #195 K/N/O/Q/W
- ⇄ 195-K.1 项目目录没了新对话回落工作区（sched 那半已做；run.mjs 主位置）
- ⇄ 195-K.3 「改题名」丢失章节 same 标记（移交主会话）
- ⇄ 195-K.4 新建项目已有 CLAUDE.md 时指令被丢弃（projects.mjs）
- ☑ 195-N.1 写盘失败仍回 200（bookmarks/sched/usage/sessmodel/sessions/merge；projects 侧移交）
- ⇄ 195-O.1 额度与账本不记子代理 token（主位置 run.mjs）
- ⇄ 195-O.3 token 按 result 到达小时记账（run.mjs/providers.mjs）
- ⇄ 195-O.4 中断/停止轮次不计入账本（run.mjs）
- ☑ 195-Q.2 超大单行 transcript 倒读平方拷贝（transcript.mjs）
- ☑ 195-Q.3 会话搜索索引 16M 上限即丢、单文件峰值无上限（sessions.mjs）
- ☑ 195-Q.10 历史单条 assistant 正文不设上限（transcript.mjs）
- ◇ 195-Q.11 应用状态约 1.27 GB（数据构成/清理策略，待定）
- ⇄ 195-W.2 防抖落盘 SIGTERM 不 flush（flushUsage/flushSessModel 已导出；server.mjs 要调）

### #195 Y/Z/AA
- ◇ 195-Y.1 会话包不含书签/置顶/会话模型/脉络/项目归属/file-history（格式与兼容性改动，待定）
- ☑ 195-Y.2 磁盘满/只读时仍返回保存成功（sessions/sessionops/sessmodel）
- ☑ 195-Y.3 彻底删除不清 archive，导入同 ID 被旧档挡住（sessionops/archive-store）
- ⇄ 195-Y.4 多会话导入中途失败只报“导入失败”（前端未读 imported）
- ☑ 195-Y.5 回退文件补救用 O_TRUNC 直接写目标（sessionops.mjs）
- ☑ 195-Y.6 分叉直接写最终 .jsonl（sessionops.mjs）
- ⇄ 195-Y.7 ccapp-settings.json 解析失败静默回落（settings-store.mjs）
- ☑ 195-Y.8 书签页把 projects 读取失败当“会话没了”（bookmarks.mjs）
- ⇄ 195-Z.1 ccapp-settings.json 解析失败（settings-store.mjs）
- ☑ 195-Z.2 usage 解析失败不受 USAGE_UNREADABLE 保护（usage.mjs）
- ☑ 195-Z.3 封签损坏静默清空 / 写失败留旧签（integrity.mjs）
- ☑ 195-Z.4 信任表丢失影响无人值守任务（projtrust 文件层已修；run.mjs 的无值守参数见移交）
- ⇄ 195-Z.5 ccapp-billing.json 语法坏 → 账本清零（providers.mjs）
- ☑ 195-Z.6 sessmodel 为 `[]` 或原语（sessmodel.mjs）
- ☑ 195-Z.7 lineage 的 `edges:[]` 通过形状检查（lineage-store.mjs）
- ☑ 195-Z.8 bookmarks 解析/读/超 4MB → `[]`（bookmarks.mjs）
- ☑ 195-Z.9 model-windows 为合法原语（models.mjs）
- ⇄ 195-Z.10 自定义组件记录非原子写（custom.mjs）
- ⇄ 195-Z.11 组件记录读不出被当 absent（components.mjs）
- ⇄ 195-AA.3 定时任务轮次恢复丢调度身份/花费/会话归属/重试（queue.mjs 的 RUN_MARK；sched 侧无法单独修）

### #196（主要位置在 b2 的）
- ☑ 196-状态写.1 多处写盘失败只 log 或静默仍回 ok（sched/bookmarks/sessmodel/sessions/usage/merge）
- ⇄ 196-状态写.2 防抖写 SIGTERM 不 flush（同 195-W.2）
- ☑ 196-状态写.3 状态文件损坏处理两极（sched.mjs）
- ⇄ 196-状态写.4 seal 准备阶段 ENOSPC/EACCES 被报成越权指令（run.mjs/seal.mjs）
- ☑ 196-状态写.5 彻底删除不清 archive/sessmodel/书签（同 195-A.7）
- ⇄ 196-会话.1 删除会话不清排队消息（queue.mjs）
- ⇄ 196-会话.2 搜索失败显示“没有找到”并沿用上次 hitsTotal（前端）
- ⇄ 196-会话.3 会话不在最近 150 条时改名后顶栏仍旧名（前端）
- ⇄ 196-会话.4 回收站连点两次恢复（前端）
- ☑ 196-会话.5 导入旧会话后列表看不到（sessionops）
- ⇄ 196-会话.6 导入中途失败只报“导入失败”（前端）
- ☑ 196-长会话.1 历史单条 assistant 正文不设上限（同 195-Q.10）
- ☑ 196-真机.1 sessmodel/seals 孤儿键（随彻底删除清理）
- ☑ 196-真机.2 回收站界面少报占用（sessionops.listTrash/meta.size）
- ⇄ 196-真机.3 组件文档软链悬空（components）
- ◇ 196-真机.4 空 session-env 目录/死进程（数据清理，待定）

### #197
- ☑ 197-2.2 恢复会话 cwd 已不存在（sessionops.mjs）
- ☑ 197-2.3 彻底删除不清 `.edits` 备份（sessionops.mjs）
- ☑ 197-2.4 彻底删除不清 file-history 和 agents 联络簿（sessionops.mjs）
- ☑ 197-2.5 saveSession=false 的失败轮次仍留主列表（sched.mjs）
- ☑ 197-2.6 会话改名/置顶写盘失败仍回 200（sessions.mjs）
- ☑ 197-2.7 会话模型/接口钉选写盘静默失败（sessmodel.mjs）
- ☑ 197-2.8 脉络“补记来源”写盘失败仍回 ok（lineage-store/merge.mjs）
- ⇄ 197-2.9 内置 hook 脚本安装失败被前端忽略（extensions.mjs）
- ⇄ 197-2.13 删除会话不清排队消息（queue.mjs）
- ⇄ 197-5.1 `--resume` 的 total_cost_usd 是累计值（run.mjs）
- ☑ 197-5.2 时区跟随被启动条件锁死（sched.mjs）
- ☑ 197-5.3 启动沿用盘上旧 nextAt（sched.mjs）
- ⇄ 197-5.4 排队中的定时任务被当“你发的消息”（queue.mjs）
- ⇄ 197-5.5 occurrence 到点等待/重启恢复期间不持久（queue.mjs 的 RUN_MARK；sched 侧只能部分）
- ☑ 197-5.6 idle 轮占并行槽但 busy 判定不算（sched.mjs；queue 已同口径）
- ⇄ 197-5.7 额度 utilization>1 / 按模型周窗口（stream.mjs + 前端）
- ⇄ 197-5.8 第三方定时任务用 Claude 猜的 USD（run.mjs）
- ⇄ 197-5.9 记账盲区：子代理/压缩/自动起名/补档（providers/run 主位置；autotitle/backfill 的 ask 由主会话统一接账本）
- ☑ 197-5.10 试跑绕过每日预算且花费不进 DB.spent（sched.mjs）
- ☑ 197-5.11 月度统计被 RUNLOG 500 条截断（sched.mjs）
- ⇄ 197-5.12 显示层本地日期/跨午夜（前端）
- ☑ 197-9.1 usage.hours（同 194-P1-14）
- ☑ 197-9.3 model-windows（同 194-P1-16）
- ☑ 197-9.4 sessmodel 字符串/数字/数组（sessmodel.mjs）
- ☑ 197-9.8 备份覆盖不一致：PINS/bookmarks 无 `.bad`（sessions/bookmarks）
- ☑ 197-9.9 导出直接写最终文件（sessionops/profile/usage）

### 单独 issue / 第三批
- ☑ #189 代理历史回填缓存的 meta 路径未进签名（agents.mjs）
- ☑ 199-16-01 cron 步长 0/负数/空串被静默改成 1（sched.mjs）
- ☑ 199-3-02 会话/脉络/用量导出默认 0644 跨应用可读（已收紧到 0600）
- ⊘ 200-8-03 FIFO/设备文件裸读（saferead.mjs 已用 O_NONBLOCK/O_NOFOLLOW，复核不成立）
- ☑ 200-8-04 catch 内清理自身抛错掩盖原始错误（sessionops.mjs）
- ☑ 200-5-04 `ccapp-energy.json` 的 hours/days/levels 形状坏（usage.mjs）
- ☑ 200-5-06 `ccapp-archive.json` 单个会话条目形态坏（archive-store.mjs）
- ☑ 200-16-04 `clean()` 对 freq 字段逐项静默丢弃（sched.mjs）
- ☑ 200-16-05 once 任务暂停过之后永远不自动关闭（sched.mjs）
- ☑ 200-16-06 `bad cron` 未翻译、无字段定位（sched.mjs）
- ☑ 200-16-07 once/every 缺省时间与 freqText 不一致（sched.mjs）
- ☑ 200-15-03 末行不带换行的 transcript 不进搜索索引（sessions.mjs）
- ☑ 200-15-04 搜索索引包含 sidechain/压缩摘要正文（sessions.mjs）
- ☑ 200-15-06 搜索归一化前后端不一致（sessions.mjs）
- ☑ 200-15-08 同尺寸原地改写不可见 / PEEK_CACHE 无 mtime·size·inode（sessions.mjs）
- ☑ 200-15-09 网关重启后脉络磁盘索引有记录、META 为空（lineage.mjs）
- ☑ 200-15-12 查询被截到 200 码元且可能切在代理对中间（sessions.mjs）
- ☑ 200-6-02 子代理用量扫描缺 finally（usage.mjs）
- ☑ 200-6-05 无上限内存集合（PEEK_CACHE/TRIED/ORPHAN_HEADS/DB.sids 已加顶；SESSIONS/GIT_TRUST 见移交）
- ☑ 200-S-08 agents `note.txt` 未做标记中和即进下一轮（agents.mjs）
- ◇ 200-S-09 封签表无版本/算法标识、5000 条淘汰、双实例覆盖（integrity.mjs，需定格式）

## 已修
| 条目 | 提交 | 怎么修的（一句） | 怎么验的 |
|---|---|---|---|
| 194-P1-9 | 7ca9b6e | archive 走 loadState，坏文件留底 .bad-* | a0610-b2-state-shapes.test.mjs |
| 194-P1-11 | b7706bc | sched tasks 形状坏不再在 tick 里崩 | a0610-b2-state-shapes / a0610-b2-sched |
| 194-P1-14 | 7ca9b6e | usage hours 形状坏留底、按空对象起 | a0610-b2-state-shapes |
| 194-P1-16 | 7ca9b6e | model-windows 原语留底，learnWindow 不抛 | a0610-b2-state-shapes |
| 195-A.1 | b0ee554 | ORPHAN_HEADS 落盘，撤销时清 | a0610-b2-sessionops |
| 195-A.3 | bb0f89f | idle 轮先 abortRun 等收尾再删/回退/删消息 | 代码复核 + 既有路由测试（无自动化模拟 idle 轮） |
| 195-A.4 | b7706bc | 只覆盖仍是任务名的会话名 | a0610-b2-sched |
| 195-A.5 | b0ee554 | 导入同号会话先恢复回收站再跳过 | a0610-b2-sessionops |
| 195-A.7 | b0ee554 | purge 清 archive/sessmodel/书签/封签/脉络/.edits/file-history/agents | a0610-b2-sessionops |
| 195-A.10 | b0ee554 | .edits 每会话 20、全局 300 | a0610-b2-sessionops |
| 195-A.14 | b0ee554 | 回收站 meta 用 writeAtomic | a0610-b2-sessionops |
| 195-N.1 | 7ca9b6e / b7706bc / bb0f89f / 078a3f3 | 写失败回 500 并回滚（书签/定时/用量/会话模型/改名置顶/脉络/回收站 meta） | a0610-b2-state-shapes / write-fail / sched / bookmarks |
| 195-Q.2 | bb0f89f | 跨块行按片段攒、最后一次拼 | a0610-b2-transcript-search |
| 195-Q.3 | bb0f89f | 大文件流式扫、单会话索引 4M 字上限 | a0610-b2-transcript-search |
| 195-Q.10 | bb0f89f | 单条 assistant 正文 20 万字上限并标 truncated | a0610-b2-transcript-search |
| 195-Y.2 | b0ee554 | 恢复先写标题/置顶再挪文件，失败保留回收站 | a0610-b2-sessionops |
| 195-Y.3 | b0ee554 | archiveImport 允许覆盖空壳旧档 | a0610-b2-sessionops |
| 195-Y.5 | b0ee554 | 回退补救临时文件 + fsync + 换名 | a0610-b2-sessionops |
| 195-Y.6 | b0ee554 | 分叉先写 .part 再换名 | a0610-b2-sessionops |
| 195-Y.8 | 7ca9b6e | projects 读不出时回 unreadable、不清书签 | a0610-b2-bookmarks |
| 195-Z.2 | 7ca9b6e | usage 走 loadState，解析失败留底 | a0610-b2-state-shapes |
| 195-Z.3 | 7ca9b6e | 封签表留底；写失败记日志 | a0610-b2-state-shapes |
| 195-Z.4 | 7ca9b6e | 信任表留底 + 形状规整 | a0610-b2-state-shapes |
| 195-Z.6 | 7ca9b6e | sessmodel 非对象留底，钉选可写回 | a0610-b2-state-shapes |
| 195-Z.7 | 7ca9b6e | lineage edges 非对象留底 | a0610-b2-state-shapes |
| 195-Z.8 | 7ca9b6e | bookmarks 非数组留底 | a0610-b2-state-shapes |
| 195-Z.9 | 7ca9b6e | windows 形状规整 | a0610-b2-state-shapes |
| 196-状态写.1 | 7ca9b6e 等 | 各路由写失败回 500/回滚 | 上述测试 |
| 196-状态写.3 | b7706bc | sched 损坏按默认值起并留底 | a0610-b2-state-shapes |
| 196-状态写.5 | b0ee554 | 同 195-A.7 | a0610-b2-sessionops |
| 196-会话.5 | b0ee554 | 导入后 mtime 设为现在 | a0610-b2-sessionops |
| 196-长会话.1 | bb0f89f | 同 195-Q.10 | a0610-b2-transcript-search |
| 196-真机.1 | b0ee554 | 彻底删除清 sessmodel/seals 孤儿键 | a0610-b2-sessionops |
| 196-真机.2 | b0ee554 | meta.total 含附件；老条目补算 | a0610-b2-sessionops |
| 197-2.2 | b0ee554 | 恢复时 cwd 不在则改写工作区 | a0610-b2-sessionops |
| 197-2.3 | b0ee554 | purge 清 .edits | a0610-b2-sessionops |
| 197-2.4 | b0ee554 | purge 清 file-history/agents | a0610-b2-sessionops |
| 197-2.5 | b7706bc | saveSession=false 失败轮次也回收 | a0610-b2-sched |
| 197-2.6 | bb0f89f | 改名/置顶写失败回滚并回 500 | 代码复核 + 写失败通用测试 |
| 197-2.7 | 7ca9b6e | 会话模型写失败回 500 并回滚 | a0610-b2-write-fail |
| 197-2.8 | bb0f89f | 脉络补记写失败回 500 | 代码复核 + merge 既有测试 |
| 197-5.2 | b7706bc | 拿到 getprop 就跟随系统时区 | 代码复核（本机 Asia/Shanghai 下 followSysTz 现在会执行） |
| 197-5.3 | b7706bc | 启动重排未来 nextAt | a0610-b2-sched-startup |
| 197-5.6 | b7706bc | busy 用 RUNS.size >= maxParallel | a0610-b2-sched（预算/排队路径） |
| 197-5.10 | b7706bc | 试跑受预算约束且花费进 DB.spent | a0610-b2-sched |
| 197-5.11 | b7706bc | DB.monthly 单独聚合 | a0610-b2-sched |
| 197-9.1 | 7ca9b6e | 同 194-P1-14 | a0610-b2-state-shapes |
| 197-9.3 | 7ca9b6e | 同 194-P1-16 | a0610-b2-state-shapes |
| 197-9.4 | 7ca9b6e | 同 195-Z.6 | a0610-b2-state-shapes |
| 197-9.8 | 7ca9b6e | PINS/书签坏文件留底 | a0610-b2-state-shapes |
| 197-9.9 | b0ee554 / 7ca9b6e | 会话包/脉络/用量导出先写临时文件 | sessionops 测试 + 既有 profile 测试 |
| #189 | 134f31d | 缓存签名加 meta 完整路径 | a0610-b2-agents-189 |
| 199-16-01 | b7706bc | cron 步长/字段/范围报错 | a0610-b2-sched |
| 199-3-02 | 7ca9b6e / b0ee554 | 导出收紧 0600 | sessionops 测试断言 0600 |
| 200-8-04 | b0ee554 | 删消息异常路径清理不再抛 | a0610-b2-sessionops（错误路径） |
| 200-5-04 | 7ca9b6e | 耗电文件形状规整 | a0610-b2-state-shapes |
| 200-5-06 | 7ca9b6e | archive 单条目坏就地丢 | 代码复核 + archive 既有测试 |
| 200-16-04 | b7706bc | clean 非法字段报错 | a0610-b2-sched |
| 200-16-05 | b7706bc | once 暂停过也能自动关 | a0610-b2-sched |
| 200-16-06 | b7706bc | cron 错误中文 + 字段值 | a0610-b2-sched（并改旧断言，见下） |
| 200-16-07 | b7706bc | once/every 缺省时间与 freqText 对齐 | a0610-b2-sched |
| 200-15-03 | bb0f89f | 末行无换行也入索引 | a0610-b2-transcript-search |
| 200-15-04 | bb0f89f | 跳过 sidechain/压缩摘要 | a0610-b2-transcript-search |
| 200-15-06 | bb0f89f | NFKC + 小写归一 | a0610-b2-transcript-search |
| 200-15-08 | bb0f89f | PEEK_CACHE 带 size/mtime/inode 并加顶 | a0610-b2-transcript-search |
| 200-15-09 | bb0f89f | lineageByShort 补扫 META | 代码复核（磁盘索引 + 空 META 场景） |
| 200-15-12 | bb0f89f | 查询按码点截 200 | a0610-b2-transcript-search |
| 200-6-02 | 7ca9b6e | 子代理扫描 finally 关 fd | 代码复核 + 既有 usage-meter 测试 |
| 200-6-05 | 7ca9b6e / 134f31d / bb0f89f / b0ee554 | PEEK_CACHE/TRIED/ORPHAN_HEADS/DB.sids 加顶 | state-shapes + sessionops + sched 测试 |
| 200-S-08 | 134f31d | note.txt 先 neutralizeMarkers | 代码复核（agents 既有测试全过） |

注：
- `gateway/tests/sched.test.mjs` 的一条旧断言（`/bad cron/`）锁定的正是 200-16-06 要修的英文文案，按 README 允许的例外改为匹配新中文文案，已在测试注释里写明。
- `audit0520.test.mjs` 的 03-007 失败注入按旧临时名匹配，改成 statefile 的新临时名（断言不变）；`audit1101.test.mjs` 的 B16/B17 改为占满并行槽（与新 busy 口径一致，断言不变）。
- 新增的 a0610-b2-* 用例跑完会清掉自己造的会话：测试文件共用同一个临时 home，留着会被 audit0520 的用量补算按同小时提问计入。

## 不成立
| 条目 | 理由（代码位置） |
|---|---|
| 200-8-03 | `gw/saferead.mjs` 打开文件已带 `O_NONBLOCK`（防 FIFO 卡死）与 `O_NOFOLLOW`，且先 lstat 只认普通文件；复核当前代码不成立。 |

## 待定（交回主会话或用户定）
| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|
| 195-A.15 | `~/.claude/sessions` 是 claude 自己的进程索引，应用不读；清不清、多久清一次属于数据清理策略，需用户定。 |
| 195-Q.11 | 应用状态约 1.27 GB（transcripts/回收站/.edits）：要不要自动压缩/迁移/清理策略，属于产品决定。 |
| 195-Y.1 | 会话包补书签/置顶/会话模型/脉络/项目归属/file-history 是格式升版，牵扯导入兼容，需定格式与版本号。 |
| 196-真机.4 | 空 session-env 目录/死进程属于数据清理，何时清、是否随启动清需用户定。 |
| 200-S-09 | 封签表加版本/算法标识会改文件格式；双实例整表覆盖需要跨进程锁。需主会话定格式与锁方案。 |

## 移交（需要改别的车道 / 主会话的文件）
| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 195-A.2 | `gw/projects.mjs` 删项目流程 | 删项目时把其中会话先进回收站（或标记 cwd），别只删 transcript 所在项目目录；sessionops 的恢复 cwd 改写已做。 |
| 195-A.6 / 197-2.13 | `gw/queue.mjs` 删除会话路径 | 清该会话的 QUEUE 项和 RUN_MARK，避免 --resume 已删会话。 |
| 195-A.8 | `gw/queue.mjs` recoverRunMark / `gw/run.mjs` | 中断恢复后补 sealSession，避免下一轮误报“应用外改过”。 |
| 195-A.9 | `server.mjs` | expireTrash 目前只在启动时调用；可加定时（如每天一次）。purgeTrash/expireTrash 现在都是 async，调用处可 await（不 await 也能跑，内部已 catch）。 |
| 195-A.11 | `gw/queue.mjs` + 前端 | 网关重启后的中断卡片文案区分“网关重启/App 被结束”。 |
| 195-A.12 | `gw/queue.mjs` | 空 sessionId 中断记录按记录 id 合并，别按 sessionId 整批清。 |
| 195-A.13 | `gw/queue.mjs` | RUN_MARK 只存必要字段（正文截断），别把完整队列正文写盘。 |
| 195-K.1 | `gw/run.mjs:47-54,280` | cwdOf 在项目目录不存在时应报错/跳过，别静默回落 CFG.workspace；sched 侧已在开跑前挡下。 |
| 195-K.2 | 前端 `14-projects-sched.js:480-481,555` | 任务所属项目被删后，编辑保存会把 projectId 置 null；前端应保留项目选择并提示项目已删，别静默改成工作区。 |
| 195-K.3 | 主会话（题名/档案） | 「改题名」时保留章节 same 标记。 |
| 195-K.4 | `gw/projects.mjs:209-214` | 新建项目选已有目录且已有 CLAUDE.md 时，要提示并保留用户填的指令。 |
| 195-N.1（projects 侧） | `gw/projects.mjs` 写盘路径 | 项目修改写失败也要回 500，不能只回 ok。 |
| 195-O.1 / O.3 / O.4 | `gw/run.mjs` / `gw/providers.mjs` | 子代理 token、按到达小时记账、中断轮次计入账本，主记账在 run/providers。 |
| 195-W.2 / 196-状态写.2 | `server.mjs` SIGTERM 收尾 | 调 `flushUsage()`（usage.mjs）与 `flushSessModel()`（sessmodel.mjs）；providers 的 bill 500ms 防抖也要 flush。 |
| 195-Y.4 | 前端 `07-sessions.js` | 读服务端返回的 `imported`，中途失败也列出已成功导入的会话。 |
| 195-Y.7 / 195-Z.1 | `gw/settings-store.mjs` | settings 解析失败也要留底 .bad-* 并提示；下次保存别用默认表覆盖。 |
| 195-Z.4（run 侧） | `gw/run.mjs:428-433` | 无人值守/自动轮次 `--setting-sources user` 的行为要不要按信任表加载项目配置，需主会话定。 |
| 195-Z.5 | `gw/providers.mjs` 账本 | billing 语法坏时先留底、别 500ms 后整份覆盖。 |
| 195-Z.10 / Z.11 | `gw/custom.mjs` / `gw/components.mjs` | 组件记录原子写；读不出时区分 absent 与损坏。 |
| 195-AA.3 / 197-5.5 | `gw/queue.mjs` RUN_MARK | RUN_MARK 存 sched/taskId/花费/会话归属/重试；到点等待的 occurrence 也要持久，重启后能恢复。sched 侧无 RUN_MARK 写权限，单改无效。 |
| 196-状态写.4 | `gw/run.mjs:461-467` / `gw/seal.mjs:386-438` | seal 准备阶段 ENOSPC/EACCES 要报“写不进/没权限”，不要报成配置里有越权指令。 |
| 196-会话.1 | `gw/queue.mjs` | 删除会话时清排队消息（同 195-A.6）。 |
| 196-会话.2 / .3 / .4 / .6 | 前端 `07-sessions.js` 等 | 搜索失败别显示“没有找到”；改名后刷新顶栏；恢复按钮防连点；导入失败列出已导入数量。 |
| 196-真机.3 | `gw/components.mjs` | 组件文档软链悬空，安装/卸载时校验目标。 |
| 197-2.9 | `gw/extensions.mjs:288-293` | 内置 hook 安装写失败要回给前端。 |
| 197-5.1 | `gw/run.mjs:338,730,899,913` | --resume 的 total_cost_usd 是累计值，需换算成本轮。 |
| 197-5.4 | `gw/queue.mjs:420-430` + 前端 | 排队中的定时任务不要显示成“你发的消息”。 |
| 197-5.7 | `gw/stream.mjs:301-310` + 前端 | utilization>1 按百分数显示；补按模型周窗口。 |
| 197-5.8 | `gw/run.mjs:899,913` | 第三方厂商的定时任务不要用 Claude 猜的 USD 做预算/上限。 |
| 197-5.9 | `gw/providers.mjs` / `gw/run.mjs` | 子代理/压缩/自动起名/补档统一进账本；autotitle/backfill 的 `ask()` 已能拿到 tin/tout，接账本由主记账侧统一做，别两边重复记。 |
| 197-5.12 | 前端 `11-usage.js` / `14-projects-sched.js` / `13-nav-menus.js` / `07-sessions.js` | 显示层按本地日期重算，跨午夜/DST/默认日期别用 UTC。 |
| 200-6-05（其余集合） | `gw/runs.mjs` 的 `SESSIONS`、`gw/git.mjs` 的 `GIT_TRUST` | 加顶/淘汰旧项；我这边的 PEEK_CACHE/TRIED/ORPHAN_HEADS/DB.sids 已加。 |

## 全量测试

最后一次（最终树，提交 078a3f3）：`env -u CCAPP_RUN node scripts/test.mjs`

- tests 942 / pass 941 / fail 0 / cancelled 0 / skipped 1，exit 0。
- 新增回归 8 个文件（a0610-b2-*）全过；相关既有测试（statefile/bookmarks/sched/usage/archive/lineage/models/integrity/profile/transcript/merge/agents/backfill/autotitle/audit0520/audit1101 等）全过。
- 过程中的偶发：audit0520 的 04-011 在同一次全量里被前面测试文件留下的会话污染（共用临时 home），已让新增用例跑完清理自己的会话（59828ed），之后全量稳定通过。

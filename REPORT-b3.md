# 车道 b3 报告（第二轮）

起点 1c058b1（第一轮四车道与主会话修复已合并）。只改 LANE-b3 名下的文件。

## 待办（自 LANE-b3.md 抄录）

1. 195-C.7 后半 / 195-R.10 后半 `local.mjs`：无「所有文件访问」时别报 `/sdcard/cccodroid/models`，按实际可写目录（home/models）返回；模型下到哪报哪。
2. 195-J.5 `sessionops.mjs`：中文 / 空格目录名技能删除回 `bad name`；放宽成与已列出目录名精确匹配，不接受路径分隔符、`.`、`..`，不动 `SID_RE`。
3. 200-8-03 后半 `saferead.mjs`：FIFO / 设备文件裸读或写打开同步卡住事件循环；读前 `fstat` 拒非普通文件，写打开先核类型或带 `O_NONBLOCK`。
4. 195-T.4（office 部分）`office.mjs`：Office 转换 detached 子进程照 `components.mjs` 的 `.runs` 标记做，复用 `compRun` / `reapComponentRuns()`。
5. 200-15-10 `bookmarks.mjs`：书签标题取 `peekSession(f.file).title`（会话首问）；改为复用会话列表的标题解析。
6. 195-Z.10 / Z.11 `custom.mjs` / `components.mjs`：组件记录原子写（`saveState` / `writeAtomic`），读不出区分「没有」和「坏了」（`loadState` 的 `missing` / `bad`），写失败如实回报。
7. 196-真机.3 `components.mjs`：组件文档软链悬空——安装 / 卸载时校验链接目标，悬空清掉或不建；不碰安装 / 解压 / 签名。
8. 195-W.2 / 196-状态写.2 `usage.mjs` / `sessmodel.mjs`：SIGTERM 时防抖未落盘的写下去；各自 `onShutdown("…", flushXxx)` 注册。
9. 200-6-05（git 那份）`git.mjs` 的 `GIT_TRUST`：只增不减，加上限 / 淘汰旧项；只改这个集合。
10. 195-A.2 `projects.mjs` 删项目：先把会话放进回收站（复用 sessions / 回收站现有函数）。
11. 195-N.1（projects 侧）`projects.mjs`：写盘失败回 500 + `{ ok:false, error:"save_failed", message }`。
12. 195-C.19 后半 / 196 HTTP HEAD `server.mjs` 静态分发：补 HEAD，头同 GET、不带正文。
13. 195-A.9 `server.mjs`：`expireTrash` 只在启动时调；加每天一次 `setInterval(...).unref()`，回调包 `guarded`。

## 已修

| 条目 | 提交 | 怎么修的（一句） | 怎么验的（测试文件 / 手动步骤） |
|---|---|---|---|
| 2（195-J.5，sessionops 半） | 4fac136 | 不动 `SID_RE`；新增 `skillDirOk(dir, listed)`：只认 skills/ 下已列出的目录名（精确匹配），拒绝路径分隔符 / NUL / `.` / `..`，中文与空格放行 | `a0610-b3-skilldir.test.mjs`：中文、空格、精确匹配、拒绝项、超长名 4 例全过；端到端需 extensions.mjs 那一行（见移交） |
| 4（195-T.4 office 部分） | 3021267 | `components.mjs` 导出 `markChild` / `unmarkChild`（行为不变）；`office.mjs` 的 `officeConvert` 起 soffice 后按 `sofficePath()` 落 `.runs` 标记，`error` / `close` 时删掉——与组件安装共用同一套，启动时 `reapComponentRuns()` 会清上一任留下的 | `a0610-b3-office-runs.test.mjs`：假 soffice 转换期间 `.runs` 有标记、结束后消失、产物就位；修前跑该测试确认失败，修后通过 |
| 5（200-15-10） | 35c8503 | 书签列表标题改为与会话列表同序：`NAMES[sid]`（用户改名）→ `archivedTitle(sid)`（档案最新题名）→ `peekSession().title`（首问）。列表里的 `sessionTitle` 在 sessions.mjs 未导出、本车道不改那个文件，按同序取同样三处来源（lineage.mjs 也是这么取的） | `a0610-b3-bookmarks-title.test.mjs`：三条会话分别为改名 / 有档案题名 / 都没有，标题依次断言；修前失败（改名没盖过首问）、修后通过；`a0610-b2-bookmarks` 3 例仍过 |
| 6（195-Z.10 / Z.11） | aa66572 | `components.mjs`：新增 `compRecordInfo()` 区分 missing / bad；坏记录留在原地（不学 `loadState` 改名——改名后列表按 `<id>.json` 找不到组件，正好落回 Z.11）；`compWriteRecord` 改用 `writeAtomic`（临时文件 + fsync + 换名）并返回成败，安装两处记录写失败直接抛错、由 job 报给界面，卸载移交文件时写失败如实记日志；`compDataInfo` / `compPurgeData` 不再把坏记录当没装。`custom.mjs`：记录读取改用 `loadState`（坏文件留底 `.bad-*`），坏记录 / 装到一半的目录按 `damaged` 照样列出，能卸能重装；安装写盘改 `writeAtomic`，失败抛错走回滚并报给界面；列表项加 `damaged` 字段 | `a0610-b3-records-atomic.test.mjs`：missing / bad 区分、坏文件原地保留、写失败返回 false 且不留临时文件、坏记录与半截安装仍列出、坏记录留底、二次读仍在；修前模块加载即失败，修后 3 例全过；`a0610-b1-local-comp` / `comp-skill` / `components*` / `a0610-f2-ext` 共 46 例全过 |
| 7（196-真机.3） | 待填 | `components.mjs`：新增 `docLinkDangling()` / `compDropDanglingDocs(rec)` / `compSweepDanglingDocs()`，只认 `share/doc/` 下的软链。安装搬完后把目标仍不存在的（包里没带 LICENSES 之类）删掉并同步 `rec.files`，不写进最终记录；卸载 / 升级收尾扫一遍 `share/doc`，清掉已经断的软链。普通文件、`share/doc` 以外的软链一概不碰 | `a0610-b3-doclinks.test.mjs`：断链删掉且移出清单、能到目标的软链保留、非文档悬空软链不动（安装）；卸载后扫掉断链、普通文件与好软链保留。修前 helper 不存在（TypeError）测试失败，修后 2 例全过；`a0610-b1-local-comp` / `comp-skill` / `components*` / `records-atomic` 40 例全过 |

## 不成立

| 条目 | 理由（代码位置） |
|---|---|
| 1（195-C.7 后半 / 195-R.10 后半） | 已由第一轮 b1 车道修（`ecc02e7`）：`gw/local.mjs:113-114` 的 `llamaInfo().dirs` 以 `modelDir()` 返回的首个可写目录打头（`modelDir` 逐个 `mkdirSync`+`accessSync(W_OK)`，写不进就落到 `home/models`）；`web/app/09-settings.js` 显示后端 `dirs[0]`，无存储权限时显示 home/models。 |
| 3（200-8-03 后半） | 当前代码已防护：`gw/saferead.mjs:9-11`（`readSmallFile`）与 `:28-30`（`readHeadFile`）都以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开后 `fstat`，`!st.isFile()` 直接返回 null——FIFO / 设备文件不会卡事件循环；本模块没有写打开。第一轮 b2 也复核为不成立（`REPORT-b2.md:222`）。实证：`fifo-safety`、`audit-v067-private` 全过；手工探 `/dev/zero`、`/dev/null` 均 0-1ms 返回 null。 |

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|
| 2（195-J.5，extensions 半） | `gw/extensions.mjs` 的 `deleteSkill(dir)`（约 392 行） | 把 `if (!SID_RE.test(dir)) return { ok:false, message:"bad name" }` 换成：`const listed = listSkills().map((x) => x.dir); if (!skillDirOk(dir, listed)) return { ok:false, message:"bad name" };`，并在文件顶部 import 里加上 `skillDirOk`（extensions.mjs 已经从 sessionops.mjs import `SID_RE, zipRead`）。这样中文 / 空格目录名的技能才能删。`installCatalogSkill` 的 `SID_RE` 不用动（官方目录名是 ASCII）。 |

## 全量测试

（尚未跑）

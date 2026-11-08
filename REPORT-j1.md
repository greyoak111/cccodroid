# 车道 j1 报告

## 待办（名下条目）

| 条目 | 文件 | 状态 |
|---|---|---|
| 199-1-01 | Docs.java SAF provider 把 `.claude/settings*.json` 当普通文件 | 已修 |
| 199-1-02 | MainActivity.java 文件选择结果不校验 authority | 待做 |
| 199-1-03 | Env.java 只探测 127.0.0.2:8791（GatewayService 那半移交 j2） | 待做 |
| 199-1-04 | MainActivity.java + 19-boot.js 伪造 SSE / onopen 无校验 | 待做 |
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

## 不成立

| 条目 | 理由（代码位置） |
|---|---|

## 待定（交回主会话或用户定）

| 条目 | 为什么没修 / 需要谁定什么 |
|---|---|

## 移交（需要改别的车道 / 主会话的文件）

| 条目 | 文件与函数 | 要做什么 |
|---|---|---|

## 行为变化

| 条目 | 用户可见变化 |
|---|---|

## 全量测试

（未跑）

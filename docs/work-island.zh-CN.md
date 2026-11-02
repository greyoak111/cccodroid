# 工作岛（可选集成）

把 cccodroid 里 Claude 的实时工作状态，显示在 **ColorOS 16 的流体云 / 灵动岛**上。

- 干活时：「正在干活」+ 当前动作（用执行命令 / 正在想 / 等你确认…）
- 收工：「任务完成」+ 用时
- 8 秒后：岛上收起，通知栏保留一条安静的通知

这是**第三方应用的可选集成**：cccodroid 只负责把状态送出去，不包含也不负责「工作岛」应用本身的功能。

---

## 测试状态

> **Pre-release / Alpha**
> 目前只在 **OnePlus PJA110 · ColorOS 16.0.3 · Android 16（SDK 36）** 上测试成功。
> 其他 ColorOS 版本、其他品牌机型均未验证；接口、文案和文件布局可能继续变动。
> 不建议用于生产或关键任务。

---

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 核心逻辑 | `gateway/gw/work-island-core.mjs` | 事件 → 文案、节流、收工判定（纯逻辑，可单测） |
| 网关接入 | `gateway/gw/work-island.mjs` | 默认关闭；开关打开后检测应用、订阅总线、调 `am` |
| 总线钩子 | `gateway/gw/bus.mjs` | `onPublish(fn)`：进程内订阅，不用 HTTP、不用令牌 |
| 设置 | `gateway/gw/settings.mjs` | `workIsland: false`，设置页开关 |
| 渲染应用 | 仓库 [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android) | Android 16 Live Update + 前台服务 |

网关侧只用 Node 内置模块：没有新增 npm 依赖，没有构建步骤。

---

## 启用

1. 安装「工作岛」应用（[releases](https://github.com/STUTTEFRFIX/WorkIsland-Android/releases)），
   打开一次，确认：通知开 / 实时更新允许 / 电池不优化。
   - 1.1 起支持英文的完成/收起文案；更早版本只有中文的完成/收起。
2. cccodroid 设置 → **工作岛（ColorOS 灵动岛）** → 打开。
3. 网关日志出现：

   ```
   [work-island] 已订阅网关事件
   ```

4. 发一条消息，看灵动岛。

## 关闭

- 设置页关掉开关：网关取消订阅，并给应用发一次 IDLE 让岛收起。
- 环境变量 `CCAPP_WORK_ISLAND=0`：强制关闭；`=1`：跳过安装检测强制开启。
- 换一个包名：`WORK_ISLAND_PKG=your.package`。

---

## 设计要点

1. **不另起进程**
   网关里直接订阅 `onPublish`，定时器也在网关里。停网关时订阅和定时器一起没，
   不会留孤儿；SIGTERM 时会同步发一次 IDLE 让岛收起。

2. **默认关闭**
   只有用户在设置里打开，才会检测应用、开始送状态。任何人都能装一个同包名应用，
   所以不能默认开启。

3. **更新限频 1.5 秒**
   工具调用密集时 `phase` / `tool_use` 一秒能来好几条；只保留最后一条，按时补发。
   这样不会每次 `am` 都冷启动一个 `app_process`。

4. **错误不带内容**
   `error` 的 message 可能含路径、命令输出；岛上只显示「出错了」。

5. **收工看 `runs`**
   `run_end` 后如果还有别的活跃轮次，就不算完；没有活跃轮次再等 3 秒宽限，
   期间来了新的一轮就取消完成。`run_end` 触发时该轮次已经从 `RUNS` 删除，直接读
   `runList()` 即可，不需要 HTTP 复查或轮询。

6. **文案跟随界面语言**
   `config.mjs` 的 `LAST_LANG` 是 `zh` 开头用中文，否则英文；更多语言以后再补。

7. **清单进度**
   `TodoWrite` / `tasks` 的已完成/总数会作为 `todoDone` / `todoTotal` 两个可选 `--ei` extras
   送给应用；工作岛 1.5+ 据此画分段进度条，不传时应用按无清单处理。

---

## 测试

```bash
node scripts/test.mjs work-island
```

覆盖：状态映射、完成 + 收起、换轮不误报、宽限期取消完成、中止、等确认、
错误脱敏、英文、1.5 秒节流、关开关发 IDLE、清单 done/total extras。

## 已知限制

- cccodroid 被强行停止后，网关来不及发 IDLE；重开 cccodroid 后恢复。
- 其他 ColorOS 版本与厂商的“灵动岛”实现未验证。
- 工作岛应用的通知服务是 exported 的，同机应用可以伪造显示状态（仅影响显示）。
- 系统岛路径的胶囊外观由系统绘制，未使用 OPPO UPK 自定义卡片；工作岛 1.5+ 在没有岛的设备上
  还有应用自绘的悬浮胶囊兜底（半透明、触摸穿透、可调大小/位置/预览）。
- 工作岛仓库里的 APK 是测试签名。

---

## 相关链接

- 工作岛仓库：https://github.com/STUTTEFRFIX/WorkIsland-Android
- 方案与设计：https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/01-方案与设计.md
- 测试报告：https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/03-测试报告.md

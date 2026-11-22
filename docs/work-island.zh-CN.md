# 工作岛（实时状态）

把 cccodroid 里 Claude 的实时工作状态，直接显示在系统 **灵动岛 / 实时通知（Android 16+ Live Updates）** 上，或用 **悬浮胶囊** 兜底。

- **干活时**：实时显示当前动作（思考中 / 读文件 / 执行命令 / 整理清单 / 等你确认…）、实时计时和 TodoWrite 分段进度；
- **收工**：显示「任务完成」+ 用时，8 秒后自动收起；
- **点击卡片**：直接回到对应会话。

---

## 内置实现（三层自动适配，全厂商通用，无需伴侣应用）

| 层级 | 适用系统 | 实现方式 | 说明 |
|---|---|---|---|
| **1. 系统实时通知 / 灵动岛** | **Android 16+（API ≥ 36）**（荣耀 MagicOS 10/11 灵动胶囊、OPPO/一加 ColorOS 16 流体云、小米 HyperOS 3+ 超级岛、Pixel / OneUI 等） | 标准 `POST_PROMOTED_NOTIFICATIONS` + `Notification.ProgressStyle` + `setRequestPromotedOngoing(true)` + `setShortCriticalText` | 零厂商白名单、零私有协议；未授权时设置页提供一键直达系统「实时通知」授权页 |
| **2. 悬浮胶囊兜底（可选，默认关闭）** | 任意 Android 版本（尤其适合 Android 12–15 或系统未开放 Live Updates 推广的机型） | `TYPE_APPLICATION_OVERLAY` 轻量胶囊（`WorkIslandOverlay.java`） | 触摸完全穿透（`FLAG_NOT_TOUCHABLE` + alpha 遵守 Android 12+ 遮挡上限），应用在前台/锁屏/息屏时自动隐藏 |
| **3. 同卡进度通知** | 全部 Android 版本 | 同一张静默持续进度通知 | 零额外权限兜底 |

> 为兼容旧版外部伴侣应用 [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android)，网关仍保留了非内置宿主环境下的 `am` 通道兼容。

---

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 核心状态机 | `gateway/gw/work-island-core.mjs` | 事件 → 脱敏文案、1.5s 节流、清单进度、3s 收工宽限与 8s 收起（纯逻辑，可单测） |
| 网关接入 | `gateway/gw/work-island.mjs` | 内置模式经 `/api/events?notify=1` 推状态帧给宿主，不占用 WebView 带宽；保留旧伴侣应用兼容 |
| 宿主渲染 | `android/java/cc/codroid/WorkIsland.java` | Android 16+ 标准 Live Updates（反射兼容 compileSdk 35）、进度通知、10 秒试播 |
| 悬浮胶囊 | `android/java/cc/codroid/WorkIslandOverlay.java` | 可选无岛兜底悬浮胶囊（触摸穿透、前台/锁屏自动隐身） |
| 通知订阅与桥接 | `android/java/cc/codroid/Notify.java`、`Priv.java` | 复用现有 `/api/events?notify=1` 长连接与 `/api/app/island_*` 设置接口 |

---

## 启用与调试

1. 打开 **设置 → Claude → 工作岛（实时状态）**。
2. 在展开的选项里：
   - **Android 16+**：保持「系统实时通知 / 灵动岛」开启；若提示系统未放行，点 **「去允许实时通知」** 打开对应开关。
   - **低版本或无系统岛机型**：可打开 **「悬浮胶囊兜底」** 并点 **「去允许悬浮窗」** 授权。
3. 点 **「试播 10 秒」** 即可不消耗模型额度、直接在手机上验证灵动胶囊 / 悬浮胶囊的实时更新与自动收起效果。

---

## 隐私与安全要点

1. **严格脱敏**：`work-island-core.mjs` 只发通用动作标签与清单数字（如 `读文件`、`清单 2/5`、`等你确认`），绝不转发文件路径、命令内容、错误原文或 MCP 服务器名。
2. **默认关闭**：只有用户显式打开开关才订阅并发布工作岛状态。
3. **不留孤儿**：与 `GatewayService` 同生共死，网关断开、关闭开关或服务停止时立即撤掉通知并移除悬浮窗。
4. **不依赖厂商私有白名单**：全链路仅用 Android 标准公开 API（通过轻量反射兼容 compileSdk 35）。

---

## 测试

```bash
node scripts/test.mjs work-island builtin-work-island
sh scripts/java-tests.sh
```

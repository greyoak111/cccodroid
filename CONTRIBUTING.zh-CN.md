# 参与 cccodroid

[English](CONTRIBUTING.md) | 中文

cccodroid 目前只有作者一个人在维护。安卓机型千差万别，一个人测不过来，也写不过来，所以非常需要帮手。下面按门槛从低到高排，挑你顺手的就行。

先来打个招呼也好：**QQ 交流群 1062538743**、[Discord](https://discord.gg/jE6KW8kwpe)，或者 [GitHub 讨论区](https://github.com/greyoak111/cccodroid/discussions)。

---

## 不写代码也能帮上忙

### 报告你的机型

最缺的就是这个。新开一个 Issue，选「机型报告」，说清楚你的手机或平板、系统版本，哪些功能能用、哪些不行。用起来一切正常也值得报一下：知道哪些机型没问题，和知道哪些有问题一样有用。

### 反馈问题

在应用里点 **设置 → 到 GitHub 反馈**，机型、系统版本、自检结果会自动填好，你只要写遇到了什么、怎么复现。不会附上日志和对话内容。

### 报告安全问题

请私下报告，见 [SECURITY.md](SECURITY.md#中文)，别发在公开的 Issue 或群里。

### 校对译文

界面有 9 种外语，大部分是作者和 AI 一起翻的，难免有生硬或者不对的地方。改法见 [i18n/README.md](i18n/README.md)，只改一个文本文件。

### 文档和教程

帮助文档在 `gateway/web/help/`，其他文档在 `docs/`。写错的、没写清楚的、你踩过而文档没提的坑，都欢迎补上。

### 在群里和讨论区帮人答疑

回答一个问题，就少一个人卡住放弃。

---

## 写配方：可选组件

可选组件（Python、Blender、各种语言环境……）在单独的 [cccodroid-components](https://github.com/greyoak111/cccodroid-components) 仓库。每个组件就是一份配方，提交后由 CI 构建、测试、签名，不用在自己手机上折腾，是最适合上手写代码的地方。

---

## 改应用本身

### 目录地图

| 位置 | 是什么 |
|---|---|
| `android/java/` | 安卓外壳（Java）：安装、更新、通知、Shizuku、WebView |
| `android/assets/bin/`、`android/assets/scripts/` | 终端里的小工具与脚本（`pkg`、Claude Code 安装脚本等）的**源文件** |
| `android/native/` | 几个小原生程序（伪终端、seccomp 兜底） |
| `gateway/server.mjs`、`gateway/gw/` | 网关，只用 Node 内置模块，负责跑 claude、会话、文件、设置等全部接口。`server.mjs` 只管分发请求和启动，各功能（会话、文件、git、组件……）分在 `gw/` 下的模块里，清单见 `server.mjs` 文件头 |
| `gateway/web/` | 界面：原生 JS + CSS，**没有构建步骤**，改完刷新就是 |
| `i18n/` | 译文 |
| `devkit/` | 开发工具包（Termux 官方仓库组装）的构建脚本 |
| `scripts/` | 构建、发版、工具包绑定 |

`android/assets/app/` 是构建产物，每次 `build.sh` 都会清掉重来，**别在那里改**。

### 怎么测

**不用自己配构建环境。** 推到你 fork 里的分支并开 PR，GitHub Actions 会构建 APK，在那次运行的 Artifacts 里下载。

PR 的包是用临时测试钥匙签的，和正式版签名不同：要先卸载正式版才能装，**卸载会清掉应用数据**（工具包要重新下载，会话也会没有），最好用一台测试机。想在自己电脑上构建，看 [README 的「构建」一节](README.zh-CN.md#构建)。

### 约定

- **先聊再大改。** 改动较大的，先开 Issue 或在讨论区说一下打算，免得白做。
- **不加依赖，不加构建步骤。** 网关只用 Node 内置模块，界面不用框架、不打包。这是刻意的：手机上随时能改、能调。
- **界面上的字都走翻译。** 中文直接写在 `t("…")` 里，再按 [i18n/README.md](i18n/README.md) 补上各语言。
- **下载相关的改动**，先读 [docs/download-sources.zh-CN.md](docs/download-sources.zh-CN.md)。原则是先有信任锚再下载，不要让镜像上下的东西变成校验依据。
- **AI 辅助写代码完全欢迎**，这个项目本身就是这么写出来的。但要在真机上测过再提交，PR 里写清楚你怎么测的、在什么机型上。
- 注释写「为什么」，不写「是什么」。
- **不提交二进制、压缩或混淆过的代码。** 第三方代码（`gateway/web/vendor/` 等）要和上游发布逐字节一致，PR 里写明来源、版本和校验和。每个 PR 都会自动做一次安全初筛（`scripts/pr-guard.mjs`），把 CI 与发版脚本、依赖、第三方代码、看不见的字符、长编码串这些最容易被动手脚的地方标出来；被标「高」不代表有问题，只是合并前维护者会逐行看。

### 合规底线

这个项目能长期存在，靠的是遵守 Anthropic 的条款（见 [README 的「条款与合规」](README.zh-CN.md#条款与合规)）。下面这些改动不会被接受：

- 修改 Claude Code 程序本身，或者读取它的凭据文件；
- 共享、中转、转售 Claude 账户或用量；
- 无人值守、定时自动跑 Claude 的功能；
- 在名称、图标里使用 Claude 或 Anthropic 的商标。

### 许可

项目使用 [Apache-2.0](LICENSE)。提交 PR，即表示你同意你的贡献以同一许可发布。

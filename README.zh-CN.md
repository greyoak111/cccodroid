# cccodroid

[English](README.md) · **简体中文** · [QQ 交流群 1062538743](#交流与参与) · [Discord](https://discord.gg/jE6KW8kwpe) · [讨论区](https://github.com/greyoak111/cccodroid/discussions) · [参与开发](CONTRIBUTING.zh-CN.md)

**在安卓手机上运行 Claude Code 的开发启动台。** 不 root、不换系统、不走 chroot / proot / 虚拟机。

[![版本](https://img.shields.io/github/v/release/greyoak111/cccodroid?color=c96442&label=版本)](https://github.com/greyoak111/cccodroid/releases/latest)
[![下载](https://img.shields.io/github/downloads/greyoak111/cccodroid/total?color=c96442&label=下载)](https://github.com/greyoak111/cccodroid/releases)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)
[![许可](https://img.shields.io/github/license/greyoak111/cccodroid?label=许可)](LICENSE)

<p align="center"><img src="docs/assets/hero.jpg" width="880" alt="cccodroid 在平板上：侧栏、带输入框的首屏，以及列着 Blender、Godot、Cloudflare 等可装工具的组件页"></p>

<p align="center">
  <a href="https://cccodroid.net/dl/cccodroid.apk"><b>下载安装包</b></a>（国内直连）
  &nbsp;·&nbsp; <a href="https://github.com/greyoak111/cccodroid/releases/latest/download/cccodroid.apk">GitHub 下载</a>
  &nbsp;·&nbsp; <a href="#安装">安装说明</a>
</p>

安卓底层本来就是 Linux 内核。只要工具能在这套内核上原生跑起来，手机就能直接用来做 AI 辅助开发：
写代码、编译 C/C++、跑 Python / Node、打 APK、用 git 推送，全部在手机上完成。

> cccodroid 是第三方项目，与 Anthropic 无关。它运行的是 **官方原版 Claude Code**：
> 安装时从 Anthropic 官方渠道下载（官方连不上时，改从 npm 镜像取 Anthropic 发布的同一份文件），按官方清单校验 sha256，不做任何修改。


## 为什么

在手机上用 AI 干活，模型要真正动手（跑代码、改文件、打包）时，通常得把任务送进云端沙箱，手机只是一块显示屏。
cccodroid 让执行回到你自己的设备上：云端只负责模型推理，代码、文件、工具链都留在本地，环境不会随会话销毁，还能直接触达设备本身。
这套做法不绑定某一个代理，任何能在 Linux arm64 上运行的命令行 AI 代理都能这样搬上手机。

详见 **[设计哲学](docs/design-philosophy.zh-CN.md)**。

## 能做什么

<p align="center"><img src="docs/assets/gallery.jpg" width="880" alt="四张手机界面：可选组件、新建定时任务、通用设置（外观与字体）、内置帮助"></p>

- **官方 Claude Code + 图形界面**：对话、流式输出、思考过程、工具调用、文件浏览器、历史会话。
  - 生成中发的消息停在对话末尾、标「排队中」；点「立即发送」递进正在跑的这一轮，不打断。**停止键只管停止**：排队的消息挂起，不会自动发出。
  - `/compact`、`/context` 等内置命令的结果当场显示。
  - 每条回复带生成计时，生成中实时跳动，结束后定格为总用时。
  - **顶栏留白**：右上角平时只有一个 ⋯，点一下文件、终端、浏览器、命令面板、新会话依次滑出，再点收回。界面偶尔滑不动时，长按顶栏标题就能重建页面。
  - **外观与字体**：配色有原生、「求索」「逐月」三套，深浅可选，也能跟随系统（状态栏一起换），启动页、首次安装页和应用内浏览器跟着走。字体是自带的，不受手机系统字体影响：界面用 Inter 和思源黑体，回复正文默认用衬线的 Spectral 和思源宋体；设置里能换界面字体、回复字体（衬线 / 无衬线）和字号（小 / 中 / 大）。代码和终端用等宽字体 CC Mono。
  - **界面动效**（0.4.11 起）：侧栏、菜单、整页、面板进出都交代清楚从哪来、回哪去，按弹簧手感做，去程回程对称；侧栏跟着手指横滑拉出、推回。只动位置和透明度，流式输出和长列表不加，旧手机也不拖。回复正文按匀速一截一截吐出来，厂商一口吐一大段时不再一顿一顿地跳。设置 → 通用 → 界面动效可以跟随系统、开或关。
  - 你的消息靠右、回复铺满，像桌面版一样；两段回复之间的工具调用收成一行「N 个步骤」，点开看每一步，有待确认 / 失败的组自动展开。每条回复下面可**复制**（Markdown 原文）、**转发**（系统分享面板）。回复里的表格、任务清单、LaTeX 公式和代码高亮都能正常显示。
  - **内置帮助**（侧栏「更多」→「帮助」）：完整的使用说明与进阶指南，带小节目录跳转，中英两版。旁边的「更新日志」就是每一版的发布说明，能搜索。
  - **平板横屏 / 折叠屏展开**：按窗口宽度自动变成两栏（对话 + 右侧工作区）或三栏（再加常驻侧栏）。文件、查看器、终端、应用内浏览器都开在右侧，不盖住对话；分隔条可拖。手机竖屏和窄分屏与以前一样。
  - **切到后台不丢活**：一轮跑完、或 Claude 等你确认时发系统通知（不弹横幅；通知里只有「拒绝」和「打开查看」，放行必须回到应用看完整命令）。应用被系统杀掉后重开，没跑完的那一轮会标明「被中断」并给「继续」按钮，排队的消息也都还在。
  - **会话管理**：侧栏「对话」页能搜内容、按条件筛，常用的对话可以置顶；删除先进回收站（30 天内可恢复）；可逐条勾选或全选，打包导出成 zip，用系统的「保存到」存到任意位置或直接分享；在另一台设备上导入就能接着聊。
  - **终端**（顶栏）：真正的终端，可开多个标签，跑的是 Claude 用的同一个 bash 与工具链 —— hx（Helix）、less、top、git 等都能用。底下一排补上手机键盘没有的键（Esc、Tab、粘住的 Ctrl / Alt、方向键、Home / End、PgUp / PgDn、粘贴、字号）；「文本视图」可长按选择复制输出。关掉面板终端照样在跑，回来时回放输出。
  - **文件查看 / 编辑器**（从文件浏览器打开）：文本、代码直接改、直接存 —— 打开之后磁盘上的文件被改过（比如 Claude 改了），保存前会先问你，不会悄悄覆盖。Markdown 渲染显示，可切到编辑；图片适应屏幕，点一下看原始大小；PDF 用 [pdf.js](https://mozilla.github.io/pdf.js/) 渲染（含中日韩文字与带密码的文件），翻到哪页才画哪页。Word、Excel 直接看，PPT 和旧版 doc 装了 LibreOffice 组件后转成 PDF 看。`.html` 文件直接显示成网页，同目录（以及上级目录）里引用的 CSS、JS、图片都能加载，文件一改自动刷新，Claude 写的网页小游戏点开就能玩。右上角是**分享**：交给系统分享面板，发到别的应用。
  - **开发者工具**（0.4.14 起）：预览 HTML 和应用内浏览器都能打开内置的 [Eruda](https://github.com/liriliri/eruda)（元素、控制台、网络、存储），不联网。开着时还能「选取元素」：点一下页面上的某一块，它的选择器和一小段 HTML 就放进输入框，接着告诉 Claude 要怎么改。
  - **拿 Markdown 写东西**：编辑时公式、代码块就地排好，光标移过去才露出源码；字数随改随算，没保存的草稿自动存着。几百万字的长稿也能打开、能改（上限 16 MB），预览只排屏幕附近那一段，滑动不卡。
  - **git 面板**（从文件浏览器或编辑器打开）：看改动、历史和逐行对比，勾上文件写一句说明就能提交；也能撤销改动、切换或新建分支、拉取和推送。
  - **输入栏下面直接换**模型、思考强度和权限模式；新对话首屏也能先挑好项目和型号再开口。
  - `/goal 完成条件` 让 Claude 一轮接一轮干到条件满足，输入框上方显示检查了几次、用了多久。用 Claude 账户或 API Key 时，长会话闲置快一小时会先自动压缩一次，回来接着聊少占额度、少花钱；上下文压到哪儿开始压缩，在接口与型号页拖一下就能调。
  - **回退到这里**：每条你发的消息下面都能回退，只撤销 Claude 改过的文件，或者截到这条之前另开一个会话重新问；也能从任意一条回复**分叉**，另起一个会话接着聊，原会话不动。Claude 干长活时列的**任务清单**显示在输入框上方，子代理做的每一步收在它的卡片下面；后台在跑的命令也列在那里，多个时收成一行，点开看全部、可逐个停止。
  - **脉络**（侧栏，0.4.10 起）：把会话之间的分叉、续写、回退画成一张地铁图（也能切成缩进树），一眼看出哪个会话是从哪来的；每个会话自动建档、编号，点站点直接跳到那一章。旧会话可以一键补档，第一次打开有导览教怎么看。
  - **附件**：＋ 面板上排是附加文件、拍照、截屏、浏览文件。拍照直接开系统相机，照片缩到长边 2048 像素、转正后附上；截屏走 Shizuku，长按「截屏」是 5 秒后截，趁这几秒切到要截的应用。别的应用里「分享 → cccodroid」也能直接变成附件。
  - 往上翻长对话时右下角出一个 **↓ 圆钮**，点一下回到最新消息；翻着的时候有新输出，钮上会亮一个点。
  - **回复里的路径能点**：像 `/storage/emulated/0/…/report.pdf`（或 `file.js:12`）这样的绝对路径，点一下就在查看器里打开；目录则打开文件浏览器。已要求 Claude 一律写完整路径。读写文件的工具卡片上也有 ↗ 按钮。
  - **应用内浏览器**（顶栏地球按钮）：回复里的网页链接直接在应用里打开，看本机开发服务 `http://127.0.0.1:<端口>/` 很方便；宽屏时开在右侧工作区，边看网页边看对话。用的是系统 WebView，不额外下载任何东西；登录授权页仍交给系统浏览器。
  - 界面 9 种语言：简体中文、繁體中文、English、Français、Español、Русский、العربية（从右到左）、日本語、한국어。
- **项目与定时任务**（0.3.13 起）：
  - 一个项目就是一个工作目录，加上它的 CLAUDE.md 和默认的接口、型号、思考强度、权限；会话按目录自动归到项目下。
  - 定时任务让 Claude 按时干一件事：每天、每周、每月、每隔几小时、只跑一次，或者直接写 cron；由系统闹钟准点叫醒。可以限定只读、只改这个项目或只用哪些工具，设单次花费和时长上限、每天的总额。跑的时候没人看着，凡是需要你确认的操作一律拒绝。
- **用量与额度**：顶栏上下文线的后半截直接显示当前接口还剩多少——账户登录是 5 小时与每周额度，DeepSeek、Kimi 等是余额；快用完时提醒。「用量」页记对话次数、活跃天数、常用模型，每月一张月报图，可以保存或分享；只记次数和用量，不记内容。
- **工具包按模块装**（扩展 → 工具包模块，0.3.9 起）：开发工具包分成基础、命令行工具、C/C++ 编译、Java 与安卓打包、图形库、音视频、其他工具几块，首次安装时勾选，之后随装随卸。每块写明用途、主要命令、大小、依赖和被谁用着；在终端敲一个没装的命令会提示它在哪块。从 0.3.8 及以前升级会装上全部模块，功能一样不少。
- **可选组件**（扩展 → 可选组件）：体积大的工具不随应用安装，用得上再下载。每个组件包都对应特定版本的工具包，装之前先核对 SHA-256 和逐文件清单，卸载干净。
  - **浏览器组件（无头 Chromium 155）**：下载约 254 MB，装好后约 750 MB。让 Claude 在后台打开网页：截图、导出 PDF、取渲染后的页面、用 puppeteer-core 操作网页。附带一个技能，告诉 Claude 怎么用。
  - **社区组件**：还可以装 [cccodroid-components](https://github.com/greyoak111/cccodroid-components) 仓库里的组件。目前 28 个，加上面的浏览器共 29 个。开发：GitHub CLI（gh）、Godot（无头运行 / 导出 APK）、Graphviz / PlantUML 画图、Hugo 建站、逆向分析（rizin、binwalk）；图像影音：Blender（无头合成 / 渲染，3D 走 GPU）、LilyPond（乐谱排版）、音乐制作工具链；办公：LibreOffice、Pandoc、PDF 工具箱、OCR（简繁中英）、LaTeX（Tectonic，支持中文）；AI：llama.cpp；3D 与科学计算：OpenSCAD、GNU Octave、科学计算 Python（numpy / scipy / matplotlib）；电子设计：ngspice / gnucap、Icarus Verilog / Yosys；GPU：骁龙驱动（Vulkan / OpenGL / OpenCL）、Mali 驱动、GPU 跑分；网络：Cloudflare（wrangler）、rclone。见[完整列表](https://github.com/greyoak111/cccodroid-components/blob/main/README.zh-CN.md#组件列表)。索引带 ed25519 签名，核对不过不装；社区组件标「社区」，没人在真机上验证过的会先提示一声再装。
  - **自定义组件**：市场里没有的 Linux arm64 程序可以自己导入（单个程序或 .tar.gz / .zip），自动认出它是 glibc、安卓原生、静态程序还是脚本，缺的库从 Termux glibc 仓库补上；装好就是一条命令，Claude 和终端都能用。来源由你自己负责。
- **多种接入方式**：
  - Claude 账户登录：应用内完成，浏览器授权后自动回到应用。账户卡片显示 5 小时额度与每周额度的占用和重置时间（取自 Claude Code 每轮自己回报的数据，应用不拿你的凭据去查任何东西）。
  - Claude API Key。
  - 各家模型厂商的官方 Anthropic 兼容接口：DeepSeek、智谱 GLM、通义千问、Kimi、MiniMax、火山方舟（豆包）、小米 MiMo、阶跃星辰、百度千帆、腾讯混元、美团 LongCat、xAI Grok、Meta Muse。
  - 可以继续添加任意第三方兼容接口。
  - 端侧小模型：装上 llama.cpp 组件，就能用本机跑的小模型聊天，不联网、不花钱。手机算力有限，干活还是交给云端模型。
  - **每个对话各用各的**：设置里的接口、型号、思考强度是默认值；在对话里单独选过的，只改这个对话。好几个对话可以同时跑，比如一个用 Claude 账户、一个用 DeepSeek，互不影响。
- **完整的开发工具链**（约 250 个包，取自 [Termux](https://termux.dev) 官方仓库）：
  - C/C++：clang 21 / lld、make / cmake / ninja、gdb / strace。
  - 语言：Python 3.14（pip、venv）、Node 26（npm、npx）。
  - 安卓构建：OpenJDK 21、aapt2 / d8 / apksigner，可以在手机上打 APK。
  - 版本控制与网络：git、ssh、curl。
  - 音视频：ffmpeg 9（x264 / x265 / VP9 / AV1 / Opus…），支持手机硬件编码（`h264_mediacodec` / `hevc_mediacodec`，比软件编码快 3 倍多）。
  - 命令行工具：rg / fd / bat / jq / sqlite3 / typst / ImageMagick… 交互式 bash 里 tab 补全可用；`hx-grammar` 只装你要的 Helix 语法；typst 开箱就能找到系统中文字体。
  - 还缺什么，终端里 `pkg install` 从 Termux 仓库装，`pkg verified` 列出实测能用的包。
- **系统权限（可选）**：集成 [Shizuku](https://shizuku.rikka.app)。终端里用 `priv '<命令>'` 以 shell 身份执行 pm / am / settings / logcat / screencap 等。
  - 设置页一键安装并激活：从 Shizuku 官方 Release 下载（核对官方签名证书），用系统安装器装好；
    再经「无线调试」激活，不用电脑。配对码在常驻屏幕顶部的通知里填，配对框不用关。
  - 激活后重启手机，cccodroid 会自己打开无线调试、重新激活 Shizuku（需连着 Wi‑Fi）。
- **设备工具（默认关）**：在 设置 → 设备工具 里打开后，Claude 能发通知、读写剪贴板、把文件分享到别的应用、打开链接或应用、看电量和网络；读屏与点按要用无障碍，单独一档。实现上是一个给 Claude 的 MCP 服务器，经 Priv 调用系统能力。打开日历、邮件这类只把内容填好，保存、发送由你自己点。
- **内存管家（默认关）**：跑编译、渲染这类重活前，经 Shizuku 停掉白名单以外的后台应用，跑的过程中谁复活就再停谁；你正在看的、分屏的、挂着前台通知的都不碰。终端里用 `cc-mem run -- 命令`。怎么看内存、怎么排查见 [docs/memory-management.zh-CN.md](docs/memory-management.zh-CN.md)。
- **工作岛（ColorOS 灵动岛，默认关）**：另装社区贡献的工作岛应用后，Claude 正在干活、等你确认、任务完成会显示在 ColorOS 16 的流体云上。见 [docs/work-island.zh-CN.md](docs/work-island.zh-CN.md)。
- **自动更新**（默认开，设置页可关、可手动检查）：
  - Claude Code：从官方渠道静默更新（stable / latest 可选，也能钉在某个具体版本），正在跑的对话不受影响；官方连不上时改从 npm 镜像取同一份文件，照样按官方清单校验；
  - cccodroid 本体：下载后核对签名，提醒安装；有 Shizuku 时空闲自动静默安装。有 targetSdk 28 和 36 两套安装包，默认跟着你装的那套更新，设置里可以换（只认 36 的系统不让换回 28）；
  - 开发工具包：只在 Wi‑Fi 下预先下载，下次打开应用时替换；你用 pip / npm -g 装进去的东西会保留。
  - 更新之间不会互相打断：工具包在下载或替换时，应用本体的更新会等它完成。替换前先按发布清单核对解出来的内容，核对不过就不动旧工具包；替换中途被打断（应用重启、进程被杀），下次打开时会接着装完或退回旧版。
  - 设置页的**校验 / 修复**：逐个文件核对工具包的哈希；修复会重装同一版本，你自己装的包照常保留。每次启动也会做一次快速自检。
- **扩展**：在「扩展」页安装、启用、停用、卸载 Claude Code 插件（搜索官方目录，或添加别的插件市场），从 zip 安装技能，添加 / 移除 MCP 服务器。全部经 Claude Code 自己的 `claude plugin` / `claude mcp` 命令完成；需要执行命令才能装的插件，会先把命令给你过目。
- **排障**：
  - **安全模式**：钩子、插件、MCP 或 CLAUDE.md 把东西弄坏了，就开安全模式 —— Claude Code 用自带的 `--safe-mode` 启动，自定义项一概不加载；登录、Key、会话、模型照旧。不挪、不改任何文件，关掉即恢复。
  - **我卡住了 · 打包诊断**（设置页，安装失败页也有）：诊断信息、应用日志、网关日志与修复账本打成 zip，交给系统分享面板。打包前先列出包里有什么；密钥、令牌、邮箱和你发给 Claude 的消息内容都先抹掉，会话记录不在包里。
  - **首次安装出错讲人话**：下载前先算空间，不够直接说要多少；断网、限流、校验不过等失败原因写明白，「重试」接着已下载的部分续传。
  - **修复账本**：开发工具包的每次安装、校验、修复与启动时的恢复都记一笔（发现了什么、做了什么、结果如何），设置页可查。
  - **已知问题**：还没查清、也没完全排除的问题，以及目前知道的情况，列在 [docs/known-issues.zh-CN.md](docs/known-issues.zh-CN.md)。
  - **权限说明**：每个权限拿来干什么、什么时候问、不给会怎样，见 [docs/permissions.zh-CN.md](docs/permissions.zh-CN.md)；发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
- **USB 调试另一台设备**：OTG 线连上后运行 `usb-adb`，就能照常 `adb devices / install / shell`。
- **自检**：`cccodroid-selftest` 逐项实测约 70 项工具与用法（含 ffmpeg 与硬件编码探测）；工具说明会注入 Claude 的系统提示，让它知道手里有什么。

## 安装

1. 从 [Releases](https://github.com/greyoak111/cccodroid/releases) 下载 `cccodroid.apk` 并安装。系统提示「与此版本的安卓不兼容」、装不上时，改装同一版本的 `cccodroid-36.apk`（targetSdk 36，功能一样，0.3.17 起提供；两套怎么选见应用内帮助「更新与修复」）。
2. 打开应用，首次启动会自动完成：
   - 下载开发工具包：先勾要装哪些模块，基础部分必装，默认再加命令行工具和 C/C++ 编译，合计约 350 MB（全部模块约 740 MB）；断点续传，校验 sha256 后解压；
   - 从 Anthropic 官方渠道下载 Claude Code（约 290 MB）。
3. 在设置页选择接入方式：登录 Claude 账户，或填入 API Key。
4. （可选）装好并启动 Shizuku，在设置页授权，即可使用 `priv` 和保活增强。

要求：Android 8.0+，arm64，可用空间约 4 GB。

实测设备：联想 TB320FC（骁龙 8+ Gen 1，Android 15）、红魔 9 Pro NX769J（骁龙 8 Gen 3，Android 14，按本节步骤从零装起走完整流程）。社区报告：Redmi K70 Ultra（天玑 9300+，Android 16，[#14](https://github.com/greyoak111/cccodroid/issues/14)）、vivo V2502A（天玑，Android 16）。Android 12 / 13 还没有真机实测，遇到问题欢迎反馈。

带后缀的版本（如 `v0.2.0-rc1`）是预发布版，应用内更新只推正式版；想试预发布版请到 Releases 手动下载。

**国产系统请允许后台运行**：部分厂商的省电机制会无视前台服务，把后台应用整个冻住（实测红魔：切到后台约 90 秒冻结），
冻结期间正在跑的任务全部停住。cccodroid 测到跑任务时被冻结，会在设置页提示具体去哪里开。红魔 / 中兴：应用信息 → 应用的电池用量 → 电池优化 →
**后台运行：允许**、**自启动：允许**。

**离线安装**：把 `devkit-cc.codroid.tar.gz` 放到 `/sdcard/cccodroid/` 下，首次启动会直接用它，不再下载。

**版本**：v0.3.0 是第一个稳定版。每个大版本走 21 个小版本（0.3.0–0.3.20，现在是 0.4.x）；每一版都能覆盖安装，数据和装好的东西都会保留。

## 交流与参与

- **QQ 交流群：1062538743**（扫码见下）。用起来的问题、想法、机型适配情况都可以来聊。
- **报 bug**：在应用里点 设置 → 到 GitHub 反馈，机型和自检结果会自动填好。
- **讨论区**：[GitHub Discussions](https://github.com/greyoak111/cccodroid/discussions)，想法和提问都欢迎。
- **Discord**：[cccodroid society](https://discord.gg/jE6KW8kwpe)，中英文都行。

**这个项目目前只有作者一个人在维护，非常需要帮手。** 机型报告、译文校对、组件配方、文档、代码，不会写代码也能帮上忙。怎么参与见 [贡献指南](CONTRIBUTING.zh-CN.md)。

<img src="docs/assets/qq-group.jpg" alt="QQ 交流群二维码，群号 1062538743" width="220">

## 架构

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/cccodroid-architecture.zh-CN-dark.png">
  <img alt="cccodroid 架构：用户在界面（WebView，前端分 19 段由网关拼接下发）上操作，界面经 HTTP 与 SSE 连 127.0.0.1 上的网关（server.mjs 加 gw/ 下的功能模块，令牌校验与事件总线）；网关由前台服务 GatewayService 拉起和崩溃重启，读写 home/ 下的会话、设置与令牌，经本地套接字通过 Priv 提权中转调用 Shizuku，并以 stream-json 驱动官方原版 Claude Code；Claude Code 经 HTTPS 调用模型 API（官方账户、DeepSeek、Kimi 等，每个对话各选），用 Bash 工具调用 devkit 工具链（基础加按需模块）；targetSdk 36 版里，APK 自带的加载器 libldlinux.so 与 exec 垫片负责改写程序启动方式；设备工具 MCP 是给 Claude 的 MCP 服务器，经本地套接字走 Priv；Updater / Installer 从 GitHub、cccodroid.net 镜像与官方渠道下载，管理 28/36 两套安装包、工具包模块与 Claude Code；组件管理从组件市场取 ed25519 签名的索引和组件包，装进 devkit，并把组件带的 skill 拷进 ~/.claude/skills，Claude Code 读到后就学会用新工具" src="docs/diagrams/cccodroid-architecture.zh-CN-light.png">
</picture>

可交互版本（引导视图、深浅色、导出）：下载 [`docs/diagrams/cccodroid-architecture.zh-CN.html`](docs/diagrams/cccodroid-architecture.zh-CN.html) 用浏览器打开；
图的源文件是同目录的 `cccodroid-architecture.zh-CN.json`，每个组件都标注了对应的源码行。图由 [Archify](https://github.com/tt-a1i/archify) 生成。

## 工作原理

```
cccodroid.apk（Java 外壳：安装器 + 前台服务 + WebView）
  ├─ files/usr/      开发工具包：Termux 官方包，等长前缀改写后原生运行
  ├─ 官方 Claude Code（linux-arm64 glibc 版，原版二进制）
  │     └─ 由 glibc 加载器运行，--preload 一个处理 seccomp 的小库
  ├─ lib/arm64-v8a/libldlinux.so   同一份 glibc 加载器，36 版经它启动 glibc 程序
  └─ 网关 gateway/server.mjs + gw/（Node）：管理 claude 进程、事件流、队列、接口配置 → 界面 gateway/web/
```

- **等长前缀改写**：Termux 的程序在编译期写死了 `/data/data/com.termux/` 前缀。包名 `cc.codroid` 与 `com.termux` 一样是 10 个字符，于是逐字节替换就能让 RUNPATH、shebang、配置路径全部指对，不需要 `LD_LIBRARY_PATH`、包装脚本或二进制补丁。zip / jmod 归档内部的条目同样改写。详见 [devkit/README.md](devkit/README.md)。
- **seccomp**：安卓给应用进程装了系统调用白名单，白名单外的调用直接用 SIGSYS 杀进程。Android 14 不放行 `epoll_pwait2`，Claude Code 一启动就会被杀。[`seccomp-enosys.c`](android/native/seccomp-enosys.c) 把这类调用改成返回 ENOSYS，让程序走自己的回退路径；静态二进制用 `enosys-run` 从外面（ptrace）做同一件事。
- **targetSdk 36**：安卓 10 起，targetSdk 29 以上的应用不能直接执行自己数据目录里的文件。常规包仍是 targetSdk 28；36 版把 glibc 加载器放进 APK 的原生库目录（系统允许执行那里），bionic 程序经 `/system/bin/linker64` 启动，再由一个 exec 垫片（[`exec-shim.c`](android/native/exec-shim.c)）在每次启动程序时自动改写成这两种方式之一。两套包功能一样，全部组件都在 36 版上实机跑过。
- **网关访问控制**：网关只监听 127.0.0.1，且 `/api/*` 必须带应用私有目录里的 256 位令牌，并校验 Host 与 Origin。手机上别的应用、浏览器里的网页都驱动不了它。
- **凭据**：账户登录由 Claude Code 自己完成。网关只把授权地址交给系统浏览器，不读取、不保存 claude.ai 的凭据；一次性授权码也不经过它（见[条款与合规](#条款与合规)）。第三方 API Key 存在应用私有目录，通过 `apiKeyHelper` 交给 claude，不进环境变量。

## 条款与合规

cccodroid 力求遵守 [Anthropic 对运行 Claude Code 的产品的条款](https://code.claude.com/docs/en/legal-and-compliance)。下面如实写明应用实际怎么做，你可以自己判断：

- **程序怎么运行。** Claude Code 的程序文件与官方 linux-arm64 版逐字节一致：按官方 sha256 清单校验，不打任何补丁。安卓没有 `/lib/ld-linux-aarch64.so.1`，所以由 glibc 加载器启动（工具包里那份，36 版用的是 APK 里的同一份），并预加载一个 61 行的小库（[`seccomp-enosys.c`](android/native/seccomp-enosys.c)），把安卓 seccomp 过滤器禁止的系统调用改成返回 ENOSYS。这个库不读、不改 Claude Code 的代码和内存，只让进程不被系统杀掉。
- **用 Claude 订阅登录。** 登录就是 Claude Code 自己的 `claude auth login`：你在浏览器里的 Anthropic 页面上授权，令牌由 Claude Code 写进它自己的 `~/.claude/.credentials.json`（应用从不读这个文件）；登录状态下，Claude Code 直连 api.anthropic.com，不经过我们的任何进程。实际上这和"SSH 到一台自己的 Linux 机器上运行 Claude Code 并登录"是一回事：这台 Linux 机器就是手机，应用是屏幕和键盘。每一轮都由你发起：要么是你发的消息，要么是你自己设的定时任务。定时任务跑在你自己的手机、你自己的账户上，用的仍是同一个未修改的 Claude Code；跑的时候没人看着，所以凡是需要确认的操作一律拒绝，应用不会替你点「允许」。0.4.2 起，用订阅账户跑的定时任务默认不执行，要你自己打开，并先确认「无人值守使用以 Anthropic 条款为准」。Anthropic 的条款对这种情况有明文：不妨碍「终端用户用自己的 Claude 订阅登录未经修改的 Claude Code 程序，包括由平台托管 Claude Code 的情形」（原文：does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code）。
- **一次性授权码。** 正常情况下，浏览器在本机直接把授权码交回 Claude Code，不经过应用。自动回传失败时（比如在别的设备上授权），应用打开内置终端并在里面运行 `claude auth login`，你把授权码贴给 Claude Code 自己的提示。终端只是通用的字节通道，和 Termux、SSH 一样；应用没有任何接收授权码的输入框，也不解析、不保存、不记录它。
- **权限确认。** 和官方命令行一样，Claude 在改文件、跑命令、联网之前会先问你，你在对话里回答。默认模式是「逐项确认」；「全部放行」可以选，但要先确认一次。
- **名字。** cccodroid 是 "Claude Code CLI On droid" 的缩写，起名方式参照老牌安卓 C/C++ IDE C4droid。项目名、图标、包名都不使用 Claude 或 Anthropic 的名称和标志，也不声称由 Anthropic 制作、认可或与其合作。如果 Anthropic 提出要求，项目会改名。
- **不转售、不中转。** cccodroid 免费开源，没有服务端，不提供、不代付、不转售任何 Claude 用量：你用自己的账户登录或填自己的 API Key，费用直接记在你自己名下。作者有 Claude Console 账户，已同意 Anthropic 的商业条款（Commercial Terms）——上面的条款要求运行 Claude Code 的产品同意它。

### 本项目反对的做法

下面这些做法，cccodroid 不做、不支持，也不接受加入这类功能的 PR：

- **反代、共享或转售账户。** 把一个订阅账户拆给多人用，或者把订阅额度包装成 API 转卖。
- **破甲。** 绕过模型的安全限制，去拿本来会被拒绝的有害内容。
- **批量操控账号。** 用 agent 成批注册、养号、刷评论，冒充真人发言。

这些事看着是钻空子，吃亏的却是普通用户：
- 买来的共享账号随时会被封；
- 中间那台代理能看到经过的代码、密钥和对话；
- 刷屏的账号挤掉了真人的讨论；
- 平台只能跟着收紧限制、提高价格。

时间一长，所有正常使用的人都跟着受损。

别人怎么选，我们不去干涉。但在这个项目里，界限是清楚的：不提供相关功能，也不帮着排查这类用法出的问题。组件市场同样不收这类组件。

## 构建

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → 签名，产出 dist/cccodroid.apk（targetSdk 28）
TARGET_SDK=36 sh scripts/build.sh   # 36 版；发版时 scripts/ship.mjs 两套都出
node devkit/devkit.mjs build --target cc.codroid   # 构建开发工具包（也可由 CI 完成）
```

**不用自己配环境**：每个 PR、每次推到 main，GitHub Actions 都会构建一个 APK，在那次运行的 Artifacts 里下载（见 [.github/workflows/apk.yml](.github/workflows/apk.yml)）。推到 main 的用正式钥匙签，能直接覆盖安装；别人仓库来的 PR 用临时测试钥匙签，要先卸载正式版才能装，建议装在测试机上。

想在自己电脑上构建：装好 JDK 17、Node.js、Android SDK（build-tools、platform）和 NDK，按 `build.sh` 开头的说明设好几个环境变量即可，`apk.yml` 就是一份现成的示例。脚本默认的工具路径是作者的安卓平板。

正式版的签名证书 SHA-256：`B7:03:61:59:5D:D3:D8:D7:04:DD:21:0E:D5:96:FC:57:70:14:CE:22:72:88:4F:B6:98:0B:F6:96:23:33:8F:E0`。

开发工具包由 GitHub Actions 构建并发布：推 `devkit-YYYY.MM.DD` 这样的 tag 即可（见 [.github/workflows/devkit.yml](.github/workflows/devkit.yml)）。
App 下载哪个版本的工具包，由 [devkit-sources.txt](devkit-sources.txt) 决定；同一版的大小与 SHA-256 摘在 [devkit-pin.json](devkit-pin.json) 里随 APK 走，首装（GitHub、cccodroid.net 镜像或本地文件三选一）和认本地文件都以它为准；锁文件 `devkit.lock.json` 自己的 SHA-256 也钉在里面，`build.sh` 抽 glibc 加载器前先核对，不只靠下载时的 HTTPS。换版本时改完前者跑 `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`，两个文件一起提交，`build.sh` 会核对它们是同一版。

目录：

| 目录 | 内容 |
|---|---|
| `android/` | Java 外壳、Manifest、资源、终端小工具（`assets/bin/`）、原生小库（`native/`）、随包的 glibc 加载器原件（`prebuilt/glibc/`） |
| `gateway/` | 网关（`server.mjs` 与 `gw/` 下的功能模块，Node.js）与界面（`web/`，原生 JS，无构建步骤） |
| `i18n/` | 界面译文：各语言的 txt 与生成、检查脚本，见 [i18n/README.md](i18n/README.md) |
| `devkit/` | 开发工具包构建脚本与清单 |
| `docs/design-philosophy.zh-CN.md` | 项目为什么存在、背后的原则 |
| `docs/large-screen.md` | 大屏布局（平板、折叠屏）与代码位置（英文） |
| `docs/known-issues.zh-CN.md` | 已知问题与未排除的隐患，以及会制造假问题的测试动作 |
| `docs/download-sources.zh-CN.md` | 各条下载链路：来源顺序、信任锚、服务器镜像、检查与维护方法 |
| `docs/memory-management.zh-CN.md` | 怎么看内存、怎么找出占内存的进程、内存管家怎么工作 |
| `docs/work-island.zh-CN.md` | 工作岛（ColorOS 灵动岛）集成：组成、怎么开关、设计要点与已知限制 |
| `docs/permissions.zh-CN.md` | 每个权限的用途、什么时候问、不给会怎样，以及三项重权限的风险 |
| `docs/claude-code-versions.zh-CN.md` | Claude Code 新版的真机验证、「已验证 / 有已知问题」标记与自动更新的关系、维护者怎么验怎么发 |
| `docs/operit2-on-device-build.zh-CN.md` | 案例：在手机上从源码构建 Operit2（Flutter + Rust）APK，含完整踩坑与补齐记录 |
| `docs/diagrams/` | 架构图（Archify JSON 规格 → 可交互 HTML → 浅色 / 深色 PNG） |
| `third_party/` | Shizuku-API 13.1.5（MIT，Maven Central 原样） |

## 特别鸣谢

- **[DeepSeek Harness 安卓版](https://github.com/woaiys3/deepseek-harness-android-app)**（woaiys3）：免 root 在手机上跑 AI 代理、借 Shizuku 提权、前台保活 —— 这些路是它先蹚出来的。cccodroid 的早期探索和开发都在它搭起的环境里完成，Claude Code 能在安卓上走到今天，地基是它和它的作者打下的。
- **[Archify](https://github.com/tt-a1i/archify)**（tt-a1i，MIT）：上面的架构图用它生成，经过它的布局校验；许可证见 [ThirdPartyLicenses/Archify](ThirdPartyLicenses/Archify/LICENSE)。
- **[Eruda](https://github.com/liriliri/eruda)**（liriliri，MIT）：预览和浏览器里的开发者工具；许可证见 [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE)。
- **[Termux](https://termux.dev)**：开发工具包由它的官方软件包组装。
- **[Shizuku](https://shizuku.rikka.app)**（RikkaApps）：不 root 也能拿到系统权限。
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js)：繁体中文界面文案用它从简体转换，再人工校对。

### 社区贡献者

- **[bmbmm-114514](https://github.com/bmbmm-114514)**：一轮细致的代码审查，报了 10 个安全与稳定性问题，每条都带复现方法和代码位置，0.3.2 全部修复。
- **[IVESHOWARD](https://github.com/IVESHOWARD)**：反馈技能压缩包导入的问题（多个技能只能导入一个、有时识别不到），0.3.2 修复。
- **[CCB-Fox](https://github.com/CCB-Fox)**：天玑 GPU 驱动组件（[cccodroid-components#46](https://github.com/greyoak111/cccodroid-components/pull/46)），促成了 0.3.3 的 Mali 机型支持。
- **[Cosmosophius](https://github.com/Cosmosophius)**：天玑 9300 完整实测报告（[cccodroid-components#47](https://github.com/greyoak111/cccodroid-components/issues/47)）。
- **[gogoiPhone](https://github.com/gogoiPhone)**：Redmi K70 Ultra 机型报告，附自写的 Vulkan 计算实测（[#14](https://github.com/greyoak111/cccodroid/issues/14)）。
- **[Slingerspir](https://github.com/Slingerspir)**：建议下载时加 GitHub 加速线路和多线程下载（[讨论区 #15](https://github.com/greyoak111/cccodroid/discussions/15)），0.4.1 加上了分段并行下载和 gh-proxy 备用线。
- **[hye45402-pixel](https://github.com/hye45402-pixel)**：建议支持 LaTeX 公式、代码高亮、代码块语言名、删除线、粗斜体和任务清单（[讨论区 #18](https://github.com/greyoak111/cccodroid/discussions/18)），0.4.4 全部加上。
- **[STUTTEFRFIX](https://github.com/STUTTEFRFIX)**：工作岛集成，把 Claude 的工作状态显示在 ColorOS 16 的流体云 / 灵动岛上（[#20](https://github.com/greyoak111/cccodroid/pull/20)、[#21](https://github.com/greyoak111/cccodroid/pull/21)），配套应用 [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android)。这是 cccodroid 合并的第一个外部 PR，随 0.4.7 发布。
- **[ThinkReally114](https://github.com/ThinkReally114)**：0.3.x 期间在交流群里的项目反馈与 bug 报告。
- **[wangxp12](https://github.com/wangxp12)**：0.3.x 期间在交流群里的项目反馈与 bug 报告。
- **[unoyg](https://github.com/unoyg)**：0.3.x 期间在交流群里的项目反馈与 bug 报告。
- **[fisHarly0](https://github.com/fisHarly0)**：0.3.x 期间在交流群里提的改进建议。
- **[chenshi723](https://github.com/chenshi723)**：0.4.x 期间在交流群里对界面前端提的改进意见。整套界面动效就是从 ta 那句「动效寒酸」开始做的（0.4.11），之后又指出侧栏收起的残影、新对话问候语重复渲染、流式输出不够顺、DeepSeek 余额显示为 0、字体跟随系统不全，0.4.11–0.4.12 陆续修好。
- **[leemwood](https://github.com/leemwood)**：在交流群里指出网页预览「缺了元素选取」，促成了 0.4.14 的开发者工具和「选取元素，交给 Claude」。

报告问题、测试机型、审查代码同样是贡献，都会记在这里。

## 许可

cccodroid 本身以 [Apache License 2.0](LICENSE) 发布（另见 [NOTICE](NOTICE)）。

### 第三方组件

- **Claude Code**：Anthropic 的专有软件，**不随本项目分发**。使用时须遵守 [Anthropic 的条款](https://code.claude.com/docs/en/legal-and-compliance)。
- **开发工具包**：取自 Termux 官方仓库，各组件按各自的许可证分发（含 GPL 等）。版本、哈希与构建配方见每个 Release 附带的 `devkit.lock.json` / `SBOM.tsv`。需要源码副本的，请在 Issues 中提出。
- **glibc 动态加载器**（`lib/arm64-v8a/libldlinux.so`，随 APK 分发）：取自 Termux 的 glibc 包，LGPL-2.1-or-later，见 [android/prebuilt/glibc](android/prebuilt/glibc/README.md)。
- **Shizuku-API**：MIT，见 [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE)。
- **xz-decompress**（devkit 构建期使用）：MIT。
- **[xterm.js](https://xtermjs.org)**（终端）：MIT，见 [ThirdPartyLicenses/xterm.js](ThirdPartyLicenses/xterm.js/LICENSE)。
- **[highlight.js](https://highlightjs.org)**（聊天里的代码高亮）：BSD-3-Clause，见 [ThirdPartyLicenses/highlight.js](ThirdPartyLicenses/highlight.js/LICENSE)。
- **[KaTeX](https://katex.org)**（聊天里的公式）：MIT，见 [ThirdPartyLicenses/KaTeX](ThirdPartyLicenses/KaTeX/LICENSE)。
- **[pdf.js](https://mozilla.github.io/pdf.js/)**（PDF 查看）：Apache-2.0；随附的 OpenJPEG / JBIG2 / QCMS 解码器各有许可，见 [ThirdPartyLicenses/pdf.js](ThirdPartyLicenses/pdf.js/)。
- **CC Mono**（界面与终端的等宽字体）：[Monaspace Neon](https://github.com/githubnext/monaspace)（GitHub）的子集，SIL OFL 1.1；按保留字名要求改了名，见 [ThirdPartyLicenses/ccmono](ThirdPartyLicenses/ccmono/LICENSE)。
- **`android.jar`** 不随包分发（许可不允许再分发），需要在手机上编译 APK 时由用户自行下载。

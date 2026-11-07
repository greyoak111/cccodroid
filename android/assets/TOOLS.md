# 运行环境：cccodroid（安卓上原生运行，不是 chroot / proot / 虚拟机）

- 安卓 aarch64，无 root；你以本应用的普通 uid 运行。开发工具来自 Termux 官方仓库，已改写为本应用的路径，前缀 `$PREFIX`。
- 工作区 `{{WORKSPACE}}`（应用私有目录）：在这里建项目、编译、运行。
- `{{SHARED}}` 是与其他应用交换文件的共享目录：交付给用户的文件（APK、图片、文档）拷到这里，用户在文件管理器里能看到。
  共享存储（/sdcard 下）**不能执行程序、不能建符号链接、npm install 会失败** —— 别在那里编译或装依赖。从那里拷出的文件没有可执行位，要 `chmod +x`。
- 临时文件用 `$TMPDIR`；`/tmp` 不可写。
- 安卓没有 `/usr/bin/env`、`/bin/bash`，但 shell 已加载 termux-exec：`#!/usr/bin/env node|python3`、`#!/bin/bash` 的脚本照常直接执行。
- **回复里提到本机文件或目录时，写完整的绝对路径**（如 `{{WORKSPACE}}/app/main.py`、`/storage/emulated/0/…/report.pdf`，需要时带 `:行号`），不要写 `~/`、`./` 或只写文件名：界面会把绝对路径变成链接，用户点一下就在应用内的查看器里打开（Markdown、代码、图片、PDF、Office 文档、音视频都能看，文本可直接编辑）。路径里尽量别带空格。
- 本机起了网页服务（开发服务器、预览页）时，在回复里给出 `http://127.0.0.1:<端口>/` 这样的链接：用户点开就在应用内浏览器里看。
- **缺工具用 `pkg install <包>` 装**（Termux 官方仓库，按本应用路径改写后安装；`apt` 同义）。`pkg search <词>` 搜、`pkg show <包>` 看详情、`pkg uninstall <包>` 卸。
  本机实测过的包（rust/cargo、golang、zig、ruby、php、lua54、python-numpy、neovim、vim、tmux、redis、postgresql 等，`pkg verified` 看全表）直接装；
  别的包要加 `--unverified`，装完自己验证能不能跑，不行就 `pkg uninstall`。工具包自带的包（clang、python、node…）不经 pkg 升级。
  工具包更新后，之前用 pkg 装的包会提示 `pkg restore` 装回。Python / Node 的库照常用 pip / npm 装（有 `python-<库>` 的预编译包时优先 pkg，省去现场编译）。
- **Office 文档转换**：`pkg install libreoffice`（约 190 MB）后可无头转换，如 `soffice --headless --convert-to pdf --outdir <目录> <文件>`（docx/xlsx/pptx/doc/odt 互转同理）。没有 X11，别开图形界面。用户在查看器里看 PPT 时装过的话这里已经有了。

## 可用工具（cccodroid-selftest 逐项实测）

- **C/C++**：`cc`/`c++`/`clang`/`clang++` 21（`gcc` 也指向 clang），lld，C++20 可用。**只能动态链接**：没有静态 libc，别用 `-static`。产物由 `/system/bin/linker64` 加载，库在 `$PREFIX/lib`、头文件在 `$PREFIX/include`。
- **构建**：make、cmake（默认 Makefile，`-G Ninja` 亦可）、ninja、pkg-config；`./configure` 这类脚本可直接跑。
- **调试**：gdb、strace、patchelf。⚠️ **gdb 默认下不了断点** —— `$SHELL` 指向应用造的 wrapper，
  gdb 的 `startup-with-shell` 经它启动 inferior 后拿不到 PIE 重定位基址，报
  `Cannot insert breakpoint … Cannot access memory at address 0x…`（看着像内存问题，其实不是）。
  用 `SHELL=/bin/sh gdb …`、`env -u SHELL gdb …`，或 `(gdb) set startup-with-shell off` 即可。
- **Python 3.14**：ssl、sqlite3、ctypes 可用。装库用 `pip install --user <包>`（或在 venv 里装）；`python3 -m venv <目录>` 建出的环境自带 pip。带 C 扩展的包会现场用 clang 编译，较慢。
- **Node 26 + npm 11**：npm install、npx、`node_modules/.bin` 均可（项目要放在工作区，不能放 /sdcard）。
- **Java / 安卓构建**：openjdk-21（java、javac、jar、keytool），aapt2、d8、apksigner。没有自带 `android.jar`（Android SDK 平台包需用户自行下载，许可不允许随包分发）—— 但 `aapt2 link` 可以拿设备自带的 `/system/framework/framework-res.apk` 顶替（`-I` 参数），资源链接能正常完成。
- **版本控制与网络**：git（https / ssh）、curl、openssl、ssh、ssh-keygen。
- **音视频**：ffmpeg / ffprobe 9（x264、x265、vpx、aom、opus、mp3 等编解码器）。**硬件编码**用 `-c:v h264_mediacodec`（或 `hevc_mediacodec`），配 `-pix_fmt nv12`，比 libx264 快约 3 倍；个别机型没有硬件编码器，就退回 libx264。
- **命令行工具**：rg、fd、bat、delta、hx（+ `hx-grammar` 装语法）、jq、yq、sqlite3、typst、duckdb、magick（ImageMagick）、man、file、tar、xz、zstd、zip / unzip、`7z`（7-Zip，随应用自带，读写 7z / zip / tar.*，能解 rar / iso / cab 等几十种）。交互式 bash 里 tab 补全可用。
- **Claude Code** 本身：终端里 `claude` 命令可用，用的是打开终端时应用里选的那家接口、型号和密钥（密钥经 apiKeyHelper 从私有文件读，不在环境变量里）。换了接口要新开一个终端。

## 系统权限：priv

需要 pm / am / settings / dumpsys / logcat / screencap / input 之类的系统能力时，用 `priv '<命令>'`：经 Shizuku 以 shell 身份（uid 2000）执行，标准输入、输出与退出码都照常传递；`priv -- 程序 参数…` 不经 sh 直接执行。
先 `priv --status` 看是否可用：没装 / 没启动 / 没授权 Shizuku 时如实告诉用户去 cccodroid 设置页处理，别反复重试。
每条 priv 命令都会记进审计日志（时间、命令、退出码），用户在设置 → Shizuku →「特权命令记录」里看得到。

⚠️ **`priv` 看不见应用私有目录**（工作区、`$PREFIX` 都是 0700，它是 uid 2000），`/data/local/tmp` 应用身份也写不进去。
所以**要在 `priv` 里跑的东西必须先放到共享目录**，否则报的是误导性的 `inaccessible or not found` / `Permission denied`：

```sh
cp 脚本.sh /sdcard/cccodroid/            # 先中转
priv 'sh /sdcard/cccodroid/脚本.sh'      # 再执行
```

## 设备工具：mcp__device__*

用户在设置里开着「设备工具」时，会有一组 `mcp__device__` 开头的工具：设备状态、发通知、读写剪贴板、打开链接 / 地图 / 拨号盘 / 邮件或短信草稿 / 日历新事件 / 闹钟计时器 / 某个应用、分享文件、已装应用列表。**这些比 `priv` 拼 am / content 命令更合适**：参数固定、用户能逐个开关。
- 会打开别的应用的都只是**预填**：保存、发送、拨出要用户自己点。别跟用户说「已经发出去了 / 已经加进日历了」，说「已经打开、填好了，请你确认」。
- cccodroid 在后台时安卓不让弹界面，工具会改发一条通知（结果里 `shown: "notification"`），如实告诉用户去点通知。
- 读屏 / 点按 / 输入 / 滑动 / 截屏（`screen_*`、`screenshot`）要无障碍，用户没开就不会出现这些工具。操作别的应用的套路：`screen_read` 看编号 → `screen_tap` / `screen_type`。点按 / 输入 / 滑动 / 按键做完会等界面静下来，直接带回新屏幕和新编号，不用再 `screen_read`；编号过期没点成时，报错里也附着新屏幕，从里面重选。
- 用户没开、或者工具不在列表里：告诉用户在 设置 → 设备工具 里打开，别改用 priv 绕过去。

## 重活与内存：cc-mem

长时间吃内存的活（大规模并行编译、逐帧渲染、长视频转码），可以用 `cc-mem run -- <命令>` 包一层：开跑前停掉白名单以外的后台应用，跑的时候谁复活就再停谁，结束后报告可用内存的变化。
- **并行数别拍脑袋**：`make -j$(cc-mem jobs)`、`cargo build -j $(cc-mem jobs)`，它按当前可用内存和核数给一个安全值（轻活加 `--per 300`）。这条不需要打开内存管家。
- 先看 `cc-mem status` 第一行：用户在设置里打开了内存管家才能用；没打开就照常直接跑，**别替用户打开，也别反复劝**。
- 它不碰前台、分屏、挂前台通知的应用、桌面、输入法、无障碍服务、VPN、Shizuku，也不碰它们依赖的组件。
- 内存不够时**先查自己的程序有没有泄漏**（单进程跑一会儿，看 RSS 涨不涨），别急着清后台。判断内存看 `/proc/meminfo` 的 MemAvailable，`free` 的 used 把文件缓存也算进去了，会吓人。
- WebAssembly 或原生绑定的对象（resvg-wasm、sharp 之类）不会被垃圾回收，用完要手动 `.free()`，否则每次调用都漏一份。

## 这些坑不报错，但结果是错的

比崩溃更麻烦的一类：退出码 0、stderr 干净，可结果不对。别被"没报错"骗过去。

| 场景 | 现象 | 怎么办 |
|---|---|---|
| Java 任何程序 | 默认时区是 GMT，不跟设备时区，时间差几个小时 | `TZ=$(getprop persist.sys.timezone)`（或 `-Duser.timezone=…`） |
| Python `zoneinfo` | 598 个时区全部 `ZoneInfoNotFoundError`；但 `time.tzset()` 正常，会掩盖它 | `pip install tzdata` |
| `npm install` 原生包 | 原生模块根本没编译（`.node` 不存在），真用到时才炸 | `npm rebuild <包>` |
| typst 编译中文 | 中文渲染成空白方框（typst 自带的只有拉丁字体） | 环境里已经默认 `TYPST_FONT_PATHS=/system/fonts`；自己起的进程照抄这个变量即可 |
| hx（Helix） | 一个 tree-sitter 语法都没装，全语言无高亮；`hx --health` 却照打 `Tree-sitter parser: ✓` | `hx-grammar rust python lua` 只装要用的。**别用 `hx --grammar fetch`**：它拉全部 245 个语法（实测 70 个就 374MB） |
| `ASAN_OPTIONS=detect_leaks=1` | 进程启动即 abort，连内存越界报告都出不来 | 别设这个变量（平台不支持泄漏检测） |
| `-fsanitize=leak` | 链接失败 `undefined symbol: __lsan::lsan_flags`（Termux 的 lsan 归档自身残缺） | 改用 `-fsanitize=address` |
| `-fsanitize=thread` | 一起线程就 SIGSEGV | 别用；ASan / HWASan 正常 |

## 出问题时

工具表现异常先跑 `cccodroid-selftest -q`（只列失败项），再据此判断，别凭印象认定"安卓上不行"。

**关于 `SIGSYS: bad system call`**：安卓的 seccomp 会拦一批比 targetSdk 新的系统调用
（`clone3`、`faccessat2`、`openat2`、`epoll_pwait2`，以及 `mount` / `umount2` / `reboot` / `kcmp` 这类），
程序一碰就被 SIGSYS 杀掉。cccodroid 已经处理好了，**一般不用你管**：

- 设置里的「静态程序兼容」默认开着：claude 外面套了 `seccomp-enosys-run -f`，**你拉起的整棵进程树**
  （bash、静态 Go 程序、它们的子进程）碰到这类调用都会拿到 `-ENOSYS`，程序自己退回老接口接着跑。
  所以在这里看到 `faccessat2 -> -38` 之类的结果，是**被监督器改写过的**，不代表系统本来就返回 ENOSYS ——
  不开监督器时同一个程序会直接被 SIGSYS 杀掉（退出码 159）。
- gdb、strace、ltrace、lldb、valgrind、proot 这些自己要 ptrace 的工具，exec 时会被自动放开，照常能用。
- 只有用户把开关关了（或者程序不是你拉起的，比如用户自己在终端里跑），撞上 SIGSYS 才需要手动套一层：

```sh
enosys-run <程序> [参数...]
enosys-run -f <程序> ...        # 连它拉起的子进程一起罩住
enosys-run -v <程序> ...        # 打印每次拦截，确认是不是这个原因
```

判断特征：**同一个程序里有的子命令崩、有的正常** —— 比如 `gh api` 一直好使而
`gh pr create` 必崩（前者不查找可执行文件，后者要找 `git`）。别据此以为"只是个别命令有 bug"。

**如果刚编出来的程序一跑就 `Illegal instruction`（退出码 132）**，先看是不是用了 `-march=native` / `-mcpu=native`：

```sh
clang -O2 -march=native prog.c          # ✗ 编译器生成 SVE 指令，内核没开 SVE 的机器上执行必崩
clang -O2 -mcpu=native+nosve prog.c     # ✓ 保留原生调优，只是不用 SVE
clang -O2 -march=armv8.6-a+dotprod+i8mm+bf16 prog.c   # ✓ 显式基线
```

Armv9 的核（骁龙 8 Gen 2/3、天玑 9200+ 等）上，clang 按 CPU 型号就认定有 SVE2。它确实也读了 `/proc/cpuinfo`，
但 `llvm::sys::getHostCPUFeatures()` 只会把「看到的」特性置为开，**从不把「没看到的」置为关**，
于是型号自带的 SVE2 就留了下来。而多数安卓内核根本没给用户态开 SVE，能力报的到处都是「没有」：
Features 行里没有 `sve`，`HWCAP_SVE` 是 0，EL0 能读到的 `ID_AA64PFR0_EL1` 里 SVE 段也是 0。
也有新内核已经开了（实测一加 Ace 7 Pro：Android 17、内核 6.12，SVE / SVE2 / SME 都能用）。本机以
`grep -qw sve /proc/cpuinfo` 为准：有就能放心用 `native`；要拿到别的机器上跑的程序，仍用上面的显式基线。

**不止 `native`：`-mcpu=cortex-x4` / `cortex-a720` / `cortex-a520`、`-march=armv9-a` / `armv9.2-a`
同样会开 SVE，一样崩。**

上游已在 LLVM 22 修复（[`9458d2a0f403`](https://github.com/llvm/llvm-project/commit/9458d2a0f403)，PR #176340），
release/21.x 没有回溯，本应用自带的 clang 21.1.8 在这个修复之前 —— 工具链升到 22+ 之后这段可以删掉。

确认是不是它：`gdb -batch -ex run -ex 'x/i $pc' ./程序`，若停在 `index z0.s, #0, #1` 这类
带 `z` 寄存器的指令、或 `ptrue` / `whilelt` 上，就是 SVE。

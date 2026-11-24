# devkit：开发工具包（全部来自官方开源仓库）

这个目录负责把启动台的**基础开发工具**组装成一个 tar，交给 App 解到自己的 `files/` 下运行。
每个组件都能查到出处：版本、哈希、构建配方链接都记在锁文件和 SBOM 里。

## 来源

| 部分 | 来源 | 处理方式 |
|---|---|---|
| 273 个包：clang/lld/cmake/ninja/make、git/ssh、gdb/strace、python、node+npm、JDK 21、aapt2/d8/apksigner、bash/coreutils/grep/sed/awk、rg/fd/bat/delta/helix/yq/jq/sqlite… | [Termux 官方仓库](https://packages.termux.dev)，构建配方开源：[termux-packages](https://github.com/termux/termux-packages) | 构建时下载，校验哈希，**原样**打进 tar，只做前缀改写（见下） |
| `android.jar`（编译 APK 用的平台存根） | Google 官方 SDK 仓库 `platform-36_r02.zip` | **不入包**，许可协议不允许再分发。由用户在设备上自行下载并同意许可，与 Claude Code 本体同样处理 |

**不再使用的：** C4droid 的 GCC 和原 `dshtc/prefix` 里的那批工具，全部被上表取代。

## 为什么能"原样"运行：等长前缀改写

Termux 的程序在编译时把前缀 `/data/data/com.termux/` 写死了，ELF 里是定长槽位。
只要我们的包名**恰好 10 个字符**（和 `com.termux` 一样长），就能逐字节等长替换：

```
/data/data/com.termux/  →  /data/data/li.dsh.dkt/
```

RUNPATH、shebang、配置文件路径一次全部改对。**不需要 `LD_LIBRARY_PATH`、不需要包装脚本、不需要二进制补丁。**
这一版改写了 1651 个文件里的 4977 处。

> ⚠️ **所以发布版 App 的包名必须是 10 个字符。** 测试用的是 `li.dsh.dkt`。

## 用法

```sh
node devkit.mjs resolve [--groups core,build]                 # 只看依赖闭包和体积
node devkit.mjs build --target <10字符包名> [--groups ...]     # 产出 out/devkit-<包名>.tar
```

产物：

- `out/devkit-<包名>.tar`：App 解到 `files/` 下即可。解完后跑一次 `usr/libexec/devkit/first-run.sh`
- `devkit.lock.json`：每个包的版本、许可证（`license`）、文件名、SHA256、配方链接，加上仓库快照时间
- `SBOM.tsv`：同上（含 `license` 列），表格形式
- `archive-sources.mjs`：按 `devkit.lock.json` 分类 GPL/LGPL 等著佐权包及 APK 内置 LGPL 库（`glibc`、`7-Zip`），拉取构建配方与上游源码包并核验 SHA-256 生成 `SOURCES.lock.json`，配合履行自二进制分发之日起至少三年的书面请求源码提供义务

分组见 `devkit.json`：不加 `--groups` 时**全部分组都打进去**，即整包；按模块分块打见下面「模块」一节。包括 `graphics`（Mesa、Vulkan 加载器等 9 个公共图形包，2026-10-15 并入，GPU 与浏览器组件共用）和 `media`（ffmpeg，2026-10-15 夜并入：+30 包，下载 +21 MB，解开后 +87 MB；带 MediaCodec 硬件编码）。共 273 个包（devkit-2026.11.21；10.22.1 起基础模块补了 patch、ed、dos2unix、lsof、nano、inetutils、net-tools、tree，10.22.3 补上单独的 which 包），从 Termux 仓库下载约 447 MB，整包 gz 约 680 MB（10.22.2 修了 venv 用的 ensurepip pip wheel），解包后约 1.9 GB。
`extra` 组（typst、duckdb、imagemagick）依赖很重，作为选装。

## 发一版

`node scripts/publish-devkit.mjs devkit-YYYY.MM.DD[.n] --why "这版改了什么"`：打 tag → 等 CI → 验签并核对 Release（每个 gz 都在、大小对；`devkit.json` 点名的包都进了清单；和上一版比少了包就停）→ 改钉 App（`devkit-sources.txt`、`devkit-pin.json`、本文的包数）→ 市场 `bases.json` 加一行并等组件重打 → 重打预置浏览器、签索引、上传 → 等镜像同步并逐字节核对 → 打预览包 → main 合到 test → 全链对账。
中途失败再跑同一条命令，从没做完的那步接着来；`--check` 只对账不改东西。`devkit.json` 的分组里要写实际的包名，不写虚包（`man` 要写成提供它的 `mandoc`），否则对账认不出。

## ABI 漂移检查与重打触发条件

base 是冻结快照，Termux 仓库持续滚动。运行以下命令（或查看每周一自动运行的 `devkit-abi` 工作流）核对漂移：

```sh
node devkit/abi-check.mjs                                  # 自动读取 devkit-pin.json 对应的 devkit.lock.json 并与 Termux 仓库对比
node devkit/abi-check.mjs --lock path/to/devkit.lock.json  # 指定任意底座锁文件
node devkit/abi-check.mjs --fail-on-abi-major              # 发版前检查：出现 ABI-MAJOR 时退出码 1
```

分级规则定义在 `devkit/abi-policy.json`：

| 级别 | 含义 | 是否需要重打 base |
|---|---|---|
| `ABI-MAJOR` | 共享库 SOVERSION / SONAME 变化（如 `libicu 78.3 → 79.1`、`openssl` / `libllvm` / `ffmpeg` 主版本、`glibc` 次版本）或语言运行时 ABI 变化（`python` 次版本、`nodejs` 主版本）。若 `devkit.lock.json` 含 `abi.sonames`，会下载漂移 `.deb` 实测 ELF `DT_SONAME` 消除误报 | **需要重打**（否则依赖这些库的新组件会链接失败；建议把积压的小修正合并进同一次重打） |
| `REMOVED` | base 里的包在 Termux 仓库索引中已下线/改名 | **需人工确认**（检查是否被替代或影响组件依赖） |
| `CLI-MAJOR` | 纯命令行工具主版本升级（如 `npm 11 → 12`、`gh`、`rg`） | **不必单独重打**（留待下次 `ABI-MAJOR` 时一并带入） |
| `MINOR` / `PATCH` | 共享库或普通包的向后兼容更新 | **不必重打**（仅记录报告，不阻断普通 PR） |

## 模块（`modules`，cccodroid 0.3.9 起）

工具包按 `devkit.json` 的 `modules` 拆成基础模块 + 若干可选模块，App 里随装随卸：

```sh
node devkit.mjs modules [--out DIR]                      # 出划分 modules.plan.json（并冻结这一刻每个包的下载记录）
node devkit.mjs build --target <包名> --plan <plan>       # 按冻结记录打整包（不再拉索引）
node devkit.mjs modules --plan <plan> --build --target <包名> --out DIR   # 逐块打包，合并出 modules.json
```

- 基础模块（`required`）必装；其余模块只含超出基础的包。被两个以上模块用到、又不小于 `sharedMinMB` 的包自动提成**共享层**（目前是 libllvm），跟着用它的模块自动装卸。更小的共用包各模块各带一份（装到手机上是同一份文件）。
- 每块一个 `devkit-<id>-<包名>.tar.gz`，带自己的 `MANIFEST`（逐文件 sha256）、`FILES`（全部路径含软链，卸载按它删）、`first-run.sh`；基础块在 `libexec/devkit/`，其余在 `libexec/devkit/modules/<id>/`。
- 合并时检查：同一路径在两块里内容必须相同；alternatives 同组不能两块各给一个（依赖块已给、优先级不低的，打包时就跳过）。
- CI 按「划分 → 整包 → 各块」走，同一个 Release 里整包（旧 App 用）和模块（新 App 用）出自同一份快照。
- adb 单独成组并进基础模块：Shizuku 的无线调试自启动要用它。
- 目前的可选模块：命令行增强（`cli`，含 `tmux`/`git-lfs`/`fontconfig-utils`）、C/C++ 构建（`build`，含 `binutils`/`nasm`/`bison`/`flex`/`gperf`/`libtool`/`ccache`）、Autotools 与 Perl（`autotools`，`full: false`）、安卓打包（`android`）、GPU 图形（`graphics`）、音视频（`media`）、文档与数据（`extra`）、Go 语言（`go`，含 gopls / goimports / gofumpt / gotestsum / govulncheck / golangci-lint / dlv）、Node.js 生态（`node`，pnpm / yarn / bun / deno）、Rust 语言（`rust`，`full: false`，含 `rust-analyzer`，与 `build` 共享 `clang`/`libllvm` 层）、Python 现代工具（`python-tools`，`full: false`，`uv` / `ruff`）、JVM 语言（`jvm`，Kotlin / Scala / Groovy / Maven）、PHP（`php`，含 `composer`）、Erlang 与 Elixir（`beam`）、Lisp 与 Scheme（`lisp`，SBCL / ECL / Racket / Chicken / Guile / Janet / PicoLisp）、现代编译型语言（`native`，Nim / Crystal / D）、复古语言（`legacy`，Tcl / Gforth / GnuCOBOL / SWI-Prolog）、Haskell（`haskell`，`full: false`，GHC 9.12 + cabal，装后约 2.8 GB；devkit.mjs 流式打包后不再受内存上限限制）。`clang` 与 `libllvm` 这类多块共用的大家伙由划分自动提成共享层（`lib-clang`、`lib-libllvm`）。
- 模块可以标 `"full": false`：整包里不放它，从整包升级上来的用户也不会自动装上（要用再到扩展页加）。后加的大模块（`go`、`node`）都这么标，免得只认整包的旧版 App 和整包用户升级时平白多下几百 MB。

## 组件（`component`）

工具包之外的选装件（市场配方、预置组件）用这个子命令打：

```sh
node devkit.mjs component <组件 id> --target <10字符包名> --base <工具包的 devkit.lock.json>
node devkit.mjs component --recipe <配方目录> --target <10字符包名> --base <...> [--dry]
```

一个组件 = 底座之外的包（底座里已有的不重复打）+ 组件自带的文件（`files`，内容里的 `{{PREFIX}}` 会替换）+
**仓库之外的上游原件（`fetch`）**。产出 `component-<id>.json`（App 与索引用的清单）和
`component-<id>-<包名>.tar.gz`（里面 `MANIFEST` 逐文件记 sha256，App 解包后照它核对）。

`fetch` 的每条是「落地路径 → 来源」，路径只能在 `usr/` 下：

```jsonc
"usr/glibc/lib/libOpenCL.so": { "url": "https://…", "sha256": "…", "why": "是什么、为什么不能走 Termux 仓库" },
"usr/glibc/bin/clspv":        { "url": "https://…", "sha256": "…", "mode": "755", "why": "…" },
"usr/glibc/lib/libOpenCL.so.1": { "link": "libOpenCL.so" }
```

- 下载后**先核对 sha256** 才放进包里（与 `devkit.json` 里 pip wheel 那条同一套）。
- `mode` 给权限（默认 644）——要装可执行文件就得写 `"755"`。
- `link` 不下载，只做一条软链，**只能写同目录的文件名**（不许绝对路径、不许带 `/`）；上游库的 SONAME 是 `libX.so.1`、而文件叫 `libX.so` 时用它补上。
- 配方里的 fetch 条目 devkit 自己也校验一遍（`usr/` 下、https、sha256 写全、写 why、mode 是八进制），不全指望配方仓库的检查。
- **上游压缩包**：键写落地目录（以 `/` 结尾）并加 `extract: { format?, strip?, include?, exec? }`，下载、核对压缩包的 sha256 后解开放进去。
  支持 tar.gz / tar.xz / tar.bz2 / tar / zip（bz2 用系统的 `bzip2`）。带 `..`、绝对路径的条目和指出落地目录的软链直接失败；
  硬链接改成文件，setuid/setgid 和组、其他人的写位去掉；`include` 写了却找不到、解出来没有文件、和组件自己的 Termux 包撞路径，都失败。
  缓存文件名带哈希前缀（`fetch-<sha256 前 16 位>-<文件名>`），不同上游的同名包不会互相顶掉。写法见市场仓库 `docs/recipe.md`。
- `source` / `version` / `why` 只记账（进锁文件，便于查出处）；fetch 的体积也算进 `installed`。
- 配方的发布版本是 `<上游版本>-r<revision>`；配方顶层写了 `version` 就用它当上游版本（fetch 型组件的版本来自上游构件），修订号照样接在后面。

## 构建时做的事（devkit.mjs）

1. **校验索引与 PGP 签名**：成对拉取 `Release` 与 `Release.gpg`，用 `pgp.mjs` 钉死的 `TERMUX_KEYS` 验证 RSA 分离签名，再按 `Release` 核对 `Packages.gz` 的 SHA256 并提取包许可证。
2. **求依赖闭包**：包括 Provides 虚包；`a | b` 取第一个能满足的。
3. **下载**：用 curl，大包分 4 MB 块、8 路并行。整包哈希不对时，换镜像逐块复核，按两个来源一致选块。
4. **解包**：先用 JS 解出 xz 这一个包来自举，之后全部用原生 xz 解压。全量构建约 1 分钟（有缓存时）。
5. **改写**：重写 tar 里的路径、文件内容、软链接目标。
6. **处理 postinst**：
   - 解析 `update-alternatives`，按优先级生成 java/javac/keytool、pager、editor 等链接；
   - 其余步骤（dbus machine-id、glib schema、ssh 目录等）收进 `first-run.sh`。

## 实测（2026-10-13，Adreno 730 平板，以 `li.dsh.dkt` 身份运行）

全部原生运行，没有任何包装：

- **编译**：clang 21 编 C/C++20；cmake + ninja；gdb 断点 + bt
- **语言与网络**：python 3.14（ssl/sqlite）；`git clone` 走 https；`npm install`
- **APK 全链**：aapt2 → javac 21 → d8 → zip → keytool → apksigner（v2+v3）→ 装机启动成功

## 测试工具

- `runner/`：测试 App `li.dsh.dkt`。以它的身份执行命令，输出写回 `run/`
- `dkt.sh '<命令>' [超时]`：从外面驱动它（需要 priv）。第一次用前要授权存储：`pm grant li.dsh.dkt android.permission.{READ,WRITE}_EXTERNAL_STORAGE`
- `ctl.mjs`：列出缓存里各 .deb 的维护脚本

## TODO

- [ ] JDK 21 拖进了 x11/pulseaudio（它是完整 JDK）。看能否换 headless 方案减重
- [ ] App 侧：外部依赖（android.jar）的下载与许可确认界面

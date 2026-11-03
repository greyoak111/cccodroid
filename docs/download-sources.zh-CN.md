# 多源下载：维护手册

[English](download-sources.md) | 中文

cccodroid 要从网上取的东西有八类，大多有不止一个来源。这份文档写清楚每一类从哪下、凭什么信、在哪改、改完怎么验。

**一条总原则：先有信任锚，再下载。** 每一类东西都有一个不依赖下载来源的校验依据：钉在 APK 里的哈希，或者钉在代码里的签名公钥。镜像只是换条线路取同一份文件，不需要被信任。新增来源时，只要内容仍然按信任锚核对，就不会降低安全性。反过来，**任何改动都不能让「从镜像拿到的东西」变成信任锚本身。**

最后核对：2026-10-20（v0.2.19）。

---

## 一览

| # | 下载什么 | 来源（按尝试顺序） | 信任锚 | 代码 |
|---|---|---|---|---|
| 1 | 开发工具包（0.3.9 起按模块：默认约 330 MB，全部约 700 MB；旧版 App 用整包约 650 MB） | GitHub Release → dl.cccodroid.net/devkit/ | APK 自带的 `devkit-pin.json`（整包 gz / tar 与 `modules.json` 的 sha256，`modules.json` 里再有每块的 sha256） | `Installer.java`、`Updater.java`、`gateway/gw/modules.mjs`（扩展页加装） |
| 2 | APK 更新 | 发布列表：GitHub API → cccodroid.net/dl/releases.json → dl.cccodroid.net/dl/releases.json；APK：GitHub Release → cccodroid.net/dl/ → dl.cccodroid.net/dl/ → gh-proxy | Android 的 APK 签名（同一把发布钥匙才能覆盖安装）+ 发布列表里的 sha256 | `Updater.java` |
| 3 | Claude Code | 官方直链 → npmmirror → 腾讯云 npm → npmjs（上次成功的排最前） | Anthropic 官方清单的 sha256（清单本身验 Anthropic 的 PGP 签名）；都拿不到时验 npm 的 ECDSA 签名 | `assets/scripts/install-claude.mjs` |
| 4 | 组件索引 | GitHub Release → cccodroid.net/components/ | 钉在网关里的 ed25519 公钥 | `gateway/gw/components.mjs` `compFetchIndex` |
| 5 | 组件包 | GitHub Release ⇄ dl.cccodroid.net/components/（轮流试，记住上次成功的） | 签名索引里的 sha256，解包后再按包内 MANIFEST 逐个核对 | `gateway/gw/components.mjs` `compRunInstall` |
| 6 | pkg 装软件 | Termux 官方 → packages.termux.dev → grimler.se → 清华/中科大/北外/南大（main、x11） | 钉在 pkg 里的 Termux 自动构建钥，验 `Release.gpg` | `assets/bin/pkg.mjs` |
| 7 | 自定义组件补 glibc 库 | Termux 官方 glibc 仓库（只此一个） | HTTPS + `Packages` 里的 sha256 | `gateway/gw/custom.mjs` `customFetchLibs` |
| 8 | 端侧模型 | 魔搭（仅 Qwen 官方）→ HuggingFace → hf-mirror.com | 目录里钉的 sha256（取自 HF LFS） | `gateway/gw/local.mjs` `LOCAL_CATALOG` |

**0.4.1 起的两项通用做法**（工具包、APK 更新、组件包、Claude Code 都适用）：

- **分段并行**：文件不小于 16 MB、服务器认 Range 时，把没下的部分切成最多 4 段同时下，按偏移写进同一个 `.part`（先占满到总大小），每段进度记在 `.part.seg`。被打断或换来源后按它续传；`.seg` 和 `.part` 对不上就两个都作废重来。来源不认 Range 时退回单连接。实测 dl.cccodroid.net 单线约 2.7 MB/s，4 路约 14 MB/s。代码：`Installer.java` 的 `fetchSegmented`、`gateway/gw/pget.mjs`。
- **低速换源**（0.4.2 起，APK 与工具包的 Java 下载）：每条连接每 30 秒一窗，不到 600 KB 就当这次失败，触发重试与换源；已经没有别的来源时不计失败次数、接着续传。以前只有连不上、或 60 秒一个字节不来才换源，GitHub 慢慢滴的时候会一直卡在 0%（群友报的 0.3.16 → 0.4.1）。代码：`Installer.java` 的 `Slow`。
- **gh-proxy.com 兜底**：GitHub 地址在其余来源都不顺时，最后再试一次 `https://gh-proxy.com/github.com/…`。这是第三方服务，不需要信任它：内容照样按上表的信任锚核对。（讨论区 #15 的建议）

另外，有的组件首次运行时还会自己下东西，比如 Blender 从 Debian 官方仓库取本体、从 GitHub 取补丁版 Mesa。这部分由组件自己的首次运行脚本负责，按脚本里钉的 sha256 核对，**不在本文的多源机制内**。

---

## 服务器端（cccodroid.net 上的镜像）

两个域名，同一台服务器：

| 域名 | 经 Cloudflare？ | 放什么 |
|---|---|---|
| `cccodroid.net` | 是（橙云） | 网页、APK（`/dl/`）、组件索引（`/components/<official\|community>/components.json(.sig)`）、Claude Code 清单（`/claude-code/`） |
| `dl.cccodroid.net` | 否（灰云，直连） | 工具包（`/devkit/`）、组件包（`/components/<official\|community>/<文件名>`）、Claude Code 清单（`/claude-code/`，与上面同一份） |

**为什么要两个**：几百 MB 的大文件不该走 CDN；另外国内有的网络只能通其中一条线，所以 Claude Code 的清单在两边都放了一份。

**谁在维护**：生成器 `repos/cccodroid-site/src/build.mjs`，由服务器上的 `cccodroid-site.timer` 每 30 分钟运行一次。服务的超时时间用 drop-in 放宽到 60 分钟，见 `/etc/systemd/system/cccodroid-site.service.d/timeout.conf`。各项内容的生成方式：

- **APK、发布列表**（`fetchReleases`）：只收 sha256 和 GitHub 记录一致的文件，保留最近 4 个版本。
- **工具包**（`fetchDevkits`）：只留 APK 绑定的那一版和最新的一版，sha256 与 `devkit.lock.json` 核对。
- **组件索引**（`fetchIndexes`）：ed25519 签名验过才更新，拉取失败就沿用上次的结果。
- **组件包**（`fetchComponentFiles`）：只收验过签名的索引里列出的包，逐个核对 sha256，核过的在旁边写一个 `.ok` 记号，对外访问不到；索引里已经没有的包会被删掉。这一步放在网页换版**之后**才跑，第一次同步 4 GB，不耽误整站更新。
- **Claude Code 清单**（`fetchClaude`）：同步 stable、latest 两个渠道的版本号，以及最近 12 个版本的 `manifest.json` 和 `.sig`，**Anthropic 的 PGP 签名验过才收**。只镜像清单，不镜像程序本身，见下面第 3 节。

nginx 配置：`/etc/nginx/sites-available/cccodroid.conf` 和 `cccodroid-dl.conf`。数据目录是 `/var/www/cccodroid/data/`，属 `ccsite` 用户。`dl.cccodroid.net` 的 `/claude-code/` 是 `alias` 到 `data/current/claude-code/` 的，跟着网页一起原子换版。

部署方法见 `repos/cccodroid-site/README.md`。**这台服务器上还跑着别的站点，只动 cccodroid 相关的文件。**

---

## 分项说明

### 1. 开发工具包

- 首次安装时，安装页让用户选来源：GitHub、cccodroid.net 镜像，或本地文件。GitHub 和镜像互为备用，最后再试 gh-proxy；按顺序依次换、不回头，用同一个 `.part` 文件接着续传。
- 校验值以 APK 里的 `assets/devkit-pin.json` 为准。这个文件由 `scripts/pin-devkit.mjs` 生成，`build.sh` 会核对它和 `devkit-sources.txt` 是不是同一版。
- **改工具包版本时**：先发布 devkit Release，再更新 `devkit-sources.txt`，然后跑 `pin-devkit.mjs`，最后打 APK。服务器会自动把新绑定的那一版同步过去。
- `pin-devkit.mjs` 要求锁文件带签名（`devkit.lock.json.sig`）并验过。只有 10-29 之前那几版本来就没签，这种情况确认无误后加 `PIN_ALLOW_UNSIGNED=1` 重跑，生成的 pin 里会记 `lockSigned:false`。新版本不要用这个开关。
- 预置组件索引（`components` Release 上的 `components.json` 和 `.sig`）：`publish-devkit.mjs` 合并前先用发布钥匙验线上那份，验不过就停。`components-index.mjs` 在有私钥时也只合并验得过的旧索引。全新的仓库（Release 上还没有索引）第一次要手工播种：对一个不存在的输出路径跑 `INDEX_SIGNING_KEY_FILE=<钥匙> node devkit/components-index.mjs <新路径>/components.json <URL 前缀> <component-x.json>`，把生成的 `components.json` 和 `components.json.sig` 传到 `components` Release，之后就交给 `publish-devkit.mjs`。

### 2. APK 更新

- 先查 GitHub API。查不到就读 `cccodroid.net/dl/releases.json`，再不行读 `dl.cccodroid.net/dl/releases.json`（同一份文件，直连不经 Cloudflare）。这份文件和 GitHub 的发布列表形状相同。APK 本身由 Android 按签名把关。
- APK 依次试 GitHub Release → `cccodroid.net/dl/<版本>/` → `dl.cccodroid.net/dl/<版本>/` → gh-proxy，同一个 `.part` 接着续传。dl 线路的 `/dl/` 是 0.4.2 时加的（VPS 上 `cccodroid-dl.conf`，与主站共用 `data/dl/` 目录），之前的版本只用前两个。
- 本地测试可以写 `home/.config/cccodroid/update-feed` 来覆盖发布列表的地址。

### 3. Claude Code（最复杂的一项）

**为什么只镜像清单、不镜像程序**：Claude Code 是闭源软件，我们自己托管二进制属于再分发，有违反条款的风险。Anthropic 自己也把它发布在 npm 上，平台包是 `@anthropic-ai/claude-code-linux-arm64`，包里的 `package/claude` 与官方直链**逐字节相同**（2.1.292 实测）。所以程序从 npm 镜像下，清单从我们这里补。

**信任锚，按优先级**：

1. **官方清单** `manifest.json` 里 `linux-arm64` 那一项的 sha256。清单按以下顺序获取：
   - `downloads.claude.ai`：HTTPS 本身可信，签名文件能取到时也会验；
   - `cccodroid.net/claude-code/`：**必须**验过 PGP 签名；
   - `dl.cccodroid.net/claude-code/`：同上，**必须**验过 PGP 签名。
2. 三处都拿不到清单时，退而验 npm registry 的 ECDSA 签名（签的是 `名称@版本:integrity`），再核对包的 sha512。这样装上的版本，目录里会留一个 `.npm-only` 标记。

**补核**：网关在启动 2 分钟后、之后每 6 小时，对带 `.npm-only` 标记的版本运行一次 `install-claude.mjs --recheck`：

- 对得上：去掉标记，并记进修复账本。
- 对不上：写一个 `.mismatch` 标记，并记进修复账本。`Updater.java` 发现这个标记后，会把 Claude Code 显示成「有更新」，用户点更新就从头重下这一版。重下成功后标记自动清除。

**钉在代码里的钥匙**（只能在核实之后修改）：

| 钥匙 | 指纹 / ID | 在哪 | 取自（修改时至少两处来源一致） |
|---|---|---|---|
| Anthropic 发布签名钥（RSA 4096） | `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` | `install-claude.mjs` 的 `ANTHROPIC_KEYS`；`build.mjs` 的 `CLAUDE_KEYS` | `https://downloads.claude.ai/keys/claude-code.asc`、keys.openpgp.org |
| npm registry 签名钥（ECDSA P-256） | `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` | `install-claude.mjs` 的 `NPM_KEYS` | `https://registry.npmjs.org/-/npm/v1/keys`（只保留没过期的） |

**下载行为**：

- 某个来源 30 秒内低于 20 KB/s，或者连续断两次，就换下一个来源。
- 同一种包在不同来源之间续传：直链用 `claude.part`；npm 包不管从哪个镜像下，都用同一个 `claude.tgz.part`，因为各镜像的 integrity 相同。
- 所有来源都失败时，等 15 秒再试一轮。已下的部分保留。
- 上次成功的来源记在 `~/.local/share/cccodroid/claude/.source`，下次排在最前。
- 应用内检查更新时，版本号也有后备：官方 → cccodroid.net → dl.cccodroid.net → npm 镜像的 dist-tags。Anthropic 在 npm 上用的 `stable` / `latest` 标签与官方渠道同名，内容也一致。

**测试**：两个环境变量可以替换地址，用来模拟官方连不上（换了地址，内容照样要过签名和哈希）：

```sh
CCODROID_CLAUDE_OFFICIAL=https://127.0.0.1:9/x   # 让官方连不上
CCODROID_CLAUDE_MIRROR=https://dl.cccodroid.net/claude-code   # 只用这一个清单镜像
bash install-claude.sh stable        # 或 latest、具体版本号
node install-claude.mjs --recheck    # 补核
```

至少要覆盖这几个场景：只能走 npm；官方能连上但从镜像下载；官方完全不通，靠清单镜像加 npm 镜像；补核。

### 4、5. 组件索引与组件包

- 索引：主地址是 GitHub，备用是 `COMP_INDEX_MIRROR`（cccodroid.net）。ed25519 公钥钉在网关里，服务器镜像前也用同一把公钥验一次。
- 组件包：`compMirrorUrl(b)` 把 GitHub 地址映射到 `dl.cccodroid.net/components/<official|community>/<文件名>`，其中 `preset` 来源映射到 `official`。最多试 4 次，在两个来源之间轮流；成功的那个记在 `compMirrorFirst`，进程重启后清零。界面的进度条会显示当前来源（`progress.via`）。
- **新发布组件时不需要做任何额外的事**：生成器下一轮会自动把新包同步过去。可以用下面的检查脚本（「定期检查」一节）确认。

### 6. pkg

- 仓库列表在 `REPOS`，每个仓库有一个 `base` 和一组 `mirrors`。
- **验签**：先取 `Release` 和 `Release.gpg`，用 `TERMUX_KEYS` 验签；`Packages.gz` 按 `Release` 里记的 sha256 核对；每个 `.deb` 再按 `Packages` 里的 sha256 核对。
  - 签名文件取不到的源一律不用，Termux 自己的域名也一样；全都取不到时用缓存的旧索引。
  - **其他镜像拿不到签名或签名不对，一律不用。**
- **国内镜像**：清华、中科大、北外、南大都只同步了 main 和 x11，**没有 glibc 仓库**（2026-10-20 核实）；阿里云没有 Termux 镜像。国内镜像比官方晚 10 到 15 个小时：索引从官方拿、包从镜像下时，可能遇到 404，代码会自动换下一个来源。
- **索引从哪个来源拿到的，下载包时就先试那个来源**（`repo.from`），免得官方连不上时，每个包都先在官方地址上空等。
- 某个仓库取不到索引时只跳过这一个仓库，全部取不到才报错。
- Termux 签名钥：`CC72CF8BA7DBFA0182877D045A897D96E57CF20C`（RSA，termux-autobuilds）。取自 termux-packages 仓库里的 `packages/termux-keyring/termux-autobuilds.gpg`，以及 keyserver.ubuntu.com、keys.openpgp.org，三处一致。**Termux 换钥匙的话，pkg 会对所有来源都验签失败**，届时要按同样的流程核实新钥后更新。
- **源文件是 `android/assets/bin/pkg.mjs`**。`android/assets/app/` 是构建产物，每次 `build.sh` 都会清掉重新生成，改在那里会被冲掉。

### 7. 自定义组件补 glibc 库

只有 Termux 官方的 glibc 仓库可用，因为国内没有镜像。用户连不上时，分析结果会把这些库列为「找不到来源」，装还是能装，只是可能跑不起来。以后想补的话，可以在服务器上镜像 `termux-glibc`，并像 pkg 那样验 `Release.gpg`。

### 8. 端侧模型

模型目录里每一项都钉了 sha256。Qwen 官方仓库的模型先走魔搭，其余的依次试 HuggingFace 和 hf-mirror.com。用户自己粘贴的直链只认 https。

---

## 定期检查（发版前或出问题时）

```sh
# Claude Code 版本号三处一致、两边清单镜像都在；索引里每个组件包在 dl.cccodroid.net 上都在、大小一致
node scripts/check-mirrors.mjs

# 生成器最近一次的运行结果
ssh <服务器> 'journalctl -u cccodroid-site -n 20 --no-pager'
```

**常见问题**：

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 安装日志里写「cccodroid.net 镜像的签名文件取不到」 | 用户那边的网络到 Cloudflare 不稳定 | 正常，会接着试 dl.cccodroid.net；两边都不通才走 npm |
| 清单镜像停在旧版本 | 生成器拉官方失败，沿用了上次的结果 | 看 journalctl；官方恢复后会自动跟上 |
| 组件包在镜像上 404 | 刚发布，生成器还没跑到 | 等 30 分钟，或者手动 `systemctl start cccodroid-site` |
| pkg 报「镜像的 Release 签名取不到」 | 镜像没同步 `Release.gpg`，或者镜像不完整 | 正常，换下一个来源；如果某个镜像长期这样，就从列表里拿掉 |
| pkg 所有来源都验签失败 | Termux 换了签名钥 | 按第 6 节的方法核实新钥后更新 `TERMUX_KEYS` |
| Claude Code 所有清单都验签失败 | Anthropic 换了签名钥 | 核实后同时更新 `install-claude.mjs` 和 `build.mjs` 里的钥匙。**在那之前不要关掉验签。** |

---

## 新增一个来源时的检查单

1. 它提供的文件和原始来源是否**逐字节相同**？抽一个文件核对 sha256。
2. 信任锚是否仍然不依赖这个来源？也就是说，内容是否照样按钉住的哈希或签名核对？
3. 失败时会不会拖慢其他来源？比如有没有连接超时，或者卡住时能不能被速度下限判定后切走。
4. 能不能和已有来源续传同一个 `.part` 文件？
5. 写进本文的「一览」表和对应的分项小节。

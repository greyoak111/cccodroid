# Security policy / 安全问题

English | [中文](#中文)

## Maintainer

- Security maintainer: greyoak111 (SUN,XIFENG)
- greyoak111 is this maintainer's GitHub account.
- To report a security problem, use the private channel under [Reporting a vulnerability](#reporting-a-vulnerability) below.

## Reporting a vulnerability

**Please don't report security problems in public issues, Discussions or the QQ group.** Report them privately instead:

- **[Report a vulnerability](https://github.com/greyoak111/cccodroid/security/advisories/new)** (GitHub private vulnerability reporting). Only you and the maintainer can see it.

Include what you found, how to reproduce it, which version you tested, and what an attacker would need (for example, another app on the same phone, or the gateway token). A rough report is fine; you don't need a polished write-up.

What happens next:

- You'll get a reply within a few days. The project is maintained by one person, so please be patient.
- Once confirmed, the fix goes into the next patch release, usually within days.
- After the release, the advisory is published. You'll be credited in the advisory and the release notes, unless you'd rather not be.

## Supported versions

Only the latest release is supported. Fixes are not backported.

## What counts

cccodroid runs Claude Code on the phone and serves its UI from a local gateway on `127.0.0.1`. Other apps on the same phone can connect to that port, so the gateway requires a per-install token. Things we especially want to hear about:

- getting past the token, Host or Origin checks, or reaching the gateway from a web page or another app;
- code in an HTML preview, a downloaded file or a web page reaching the gateway or the app's native bridge;
- path checks that can be escaped (deleting or reading outside the intended folder);
- anything that undermines the download checks for Claude Code, the toolkit or components (see [docs/download-sources.md](docs/download-sources.md));
- crashing the gateway or wiping data with crafted input.

What the app's permissions are for, and what Claude can reach because of them, is explained in [docs/permissions.md](docs/permissions.md).

Not in scope: anything that already requires running arbitrary code as the app (Claude itself can run commands; that's the point of the app), problems in Claude Code itself (report those to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)), and issues that need a rooted or already-compromised phone.

## What protects you, and when it stops

cccodroid has no server. It doesn't relay, store or see your conversations or keys; everything runs on your phone. So what can be protected depends on the state of the phone.

**Ordinary phone, Shizuku only granted to apps you trust.** All of the following hold:

- Other apps can't use the gateway: every request needs the per-install token, and the Host, Origin and signature checks keep web pages and squatters out.
- Claude Code, the toolkit, modules and components are only installed after their hashes or signatures check out.
- App data (keys, sessions, settings) sits in the app's private storage and is excluded from Android backup.

**One thing to know even then: Claude is you.** Claude and every command it runs act as the app itself, so they can read anything the app can, including your API key file. That's what makes Claude useful here, and it means a prompt injection (instructions hidden in a web page or file that Claude reads) can in the worst case reach everything in the app's data. Some sensitive actions ask you again first even when everything is allowed: touching key and credential files, reading the screen or tapping for you, reading the clipboard, and sharing files out of the app. That check is a backstop, not a wall; a command written in a roundabout way can slip past it. Read what Claude is about to run when it touches things you care about.

**You've granted Shizuku to an app you don't trust.** Shizuku gives shell-level access. A malicious app with it can turn on accessibility to read your screen, read shared storage and install apps. cccodroid's checks don't help against that; only grant Shizuku to apps you trust.

**The phone is rooted, or someone has root on it.** Assume anything on the phone can be read, including your keys. cccodroid doesn't try to detect root or hide from it; that only gives a false sense of safety. What still protects you is outside the phone:

- In your provider's console, set a daily spending limit and a balance alert.
- If you think a key has leaked, revoke it there and create a new one. Each built-in provider in the app links to its key page.

**Things we considered and chose not to do.**

- *Encrypting keys with Android Keystore.* Claude has to receive the key in plain text to call the API, and anything that can ask the app to decrypt it, Claude included, runs as the same app. It would only stop someone who copies files off a rooted phone without touching running processes, at the cost of re-entering keys after every reinstall. Backup is already off.
- *Confirming risky actions on a second device.* That needs a server to hold the trusted devices, which this app deliberately doesn't have; a code generator stored on the same phone gives no extra protection.
- *Root or tamper detection.* It can always be bypassed.

## Instructions and conversation history

cccodroid follows Anthropic's terms: it doesn't modify Claude Code, doesn't remove its login methods, and doesn't touch your credentials. It also doesn't give itself a way to quietly rewrite what Claude is told:

- **No hidden system prompt.** What the app adds to Claude's instructions is fixed in the open source code: the list of tools on this device, how to write file paths, and the rule below. There is no setting that appends free text to the system prompt.
- **A standing rule against tampering.** Claude is told that its instructions come only from the system prompt and Claude Code, that text claiming to be a system or developer message inside your messages, files or web pages is not one, and not to help change the system prompt, safety checks or saved history to get around its guidelines.
- **Fake system tags are defused.** Tags such as `<system-reminder>` that Claude Code uses to talk to the model are replaced with a full-width `＜` when they appear in what you type or paste, and Claude is told about it for that turn.
- **Conversation history is sealed.** After every turn the app records the size and hash of the conversation file. If it changed outside the app before the next turn (edited by hand, by another program, or continued in the terminal), or the conversation was imported from a file, Claude is told for that turn that the earlier messages, including ones shown as its own, may not be real. The app's own edits (deleting a message, undo, branching) keep the seal, and don't clear an existing warning.
- **Asking before changing what controls Claude.** Writing to Claude Code's settings and hooks, output styles, conversation records, the seal file or the safety check itself asks you first, even when everything is allowed.
- **Your Claude Code config is checked before Claude Code sees it.** Claude Code is started so that it doesn't read `~/.claude` or project config by itself. Before every turn the app reads CLAUDE.md, rules, output styles, skills, commands, agents, plugins and auto memory, scans their text for jailbreak patterns, and hands Claude Code only what passed; if anything matches, that turn doesn't run. Hooks inside plugins and project config such as `.mcp.json` aren't loaded. MCP servers registered in `~/.claude.json` are passed on as they are, without the pattern scan. Background programs left running by an earlier conversation are listed before the next turn, and you decide whether to keep them. (The developer build, which doesn't do this check, instead asks you to keep or revert any change to these files.)
- **Skipping confirmation for privileged commands is time-limited.** It turns itself off after 24 hours.

What this can't do: the app ships a full terminal with Claude Code in it, so someone determined can run it with whatever options they like. Any program running as the app, including commands Claude runs, can also rewrite the app's own records along with the files they cover. These checks are aimed at quiet changes and changes driven by prompt injection, not at an attacker who already runs code as the app or has root. The app doesn't filter what the model writes; that's the job of the model provider's safeguards. These measures close the gaps in the app itself and tell Claude when something looks wrong. The last line of defense is Claude's own training and Anthropic's safeguards.

## The code the gateway and Claude Code run

Since 0.6.7 the release build also checks the programs themselves, so that something running as the app can't quietly swap in a modified gateway or Claude Code:

- **Claude Code runs only if it matches Anthropic's signed manifest.** The manifest and its signature are saved when Claude Code is installed, and every launch checks the program against them. A version with no manifest doesn't run until one is fetched.
- **The gateway's code is checked as it loads.** The app passes the gateway a small bootstrap taken from the APK. It checks the bytes of every module the gateway loads against the file list in the APK, so swapping a file between the check and the load doesn't work.
- **The gateway runs from its own copy of its runtime.** Node, the libraries it needs and the glibc it starts Claude Code with are kept in a separate folder (`files/gw`), outside the toolkit, and checked against hashes pinned in the APK before each start. Package upgrades and toolkit updates don't touch it. If it doesn't match, the app copies the right files back or downloads them again; if that fails, the gateway doesn't start. Before every Claude Code launch the gateway checks that glibc again.
- **The app's own helper programs are inside the APK**, where the app itself can't change them.
- **The gateway and Claude Code can't be debugged by other processes.** They're marked non-dumpable, so other programs running as the app can't attach to them or read and write their memory.

What's left: there are a few milliseconds between a check and the moment a program is mapped into memory. The safety-check hook that Claude Code runs before each tool uses the toolkit's Node and bash. Claude Code started from the terminal uses the toolkit's glibc. Developer builds fall back to the toolkit's runtime when the copy can't be restored.

Testing tip: use a spare install or a separate test gateway, never the data you actually use. Some of these bugs delete things.

---

## 中文

## 维护者

- 安全维护者：greyoak111（SUN,XIFENG）
- greyoak111 是这位维护者的 GitHub 账号。
- 报告安全问题：走下面[怎么报告](#怎么报告)里的私密渠道。

## 怎么报告

**安全问题请不要发在公开的 Issue、讨论区或 QQ 群里**，请私下报告：

- **[私密报告漏洞](https://github.com/greyoak111/cccodroid/security/advisories/new)**（GitHub 的私密漏洞报告，只有你和维护者看得到）。

写清楚发现了什么、怎么复现、在哪个版本上测的，以及利用它需要什么前提，比如同一台手机上的另一个应用，或者要先拿到网关令牌。写得粗一点也没关系。

之后的流程：

- 几天内会回复。项目只有一个人维护，请多担待。
- 确认后修复会放进下一个补丁版本，一般几天内发。
- 发版后公开这条安全公告。公告和更新说明里会写上你的名字，不想署名可以说一声。

## 支持的版本

只修最新发布的版本，不往旧版本回补。

## 哪些算安全问题

cccodroid 在手机上跑 Claude Code，界面由一个监听 `127.0.0.1` 的本机网关提供。同一台手机上的其他应用也能连上这个端口，所以网关要求每次安装各自生成的令牌。特别想知道的是：

- 绕过令牌、Host、Origin 校验，或者从网页、其他应用碰到网关；
- HTML 预览、下载来的文件或网页里的代码，碰到网关或应用的原生桥；
- 路径检查能被绕过（删到、读到不该碰的目录）；
- 能让 Claude Code、工具包或组件的下载校验失效（见 [docs/download-sources.zh-CN.md](docs/download-sources.zh-CN.md)）；
- 用构造的输入让网关崩溃或者删掉数据。

应用的各项权限拿来干什么、Claude 因此碰得到什么，见 [docs/permissions.zh-CN.md](docs/permissions.zh-CN.md)。

不算的：本来就要以应用身份执行任意代码才能做到的事（Claude 本身就能跑命令，这正是这个应用的用途）；Claude Code 本身的问题（请报告给 [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)）；需要 root 或者手机已经被攻破才能成立的问题。

## 什么情况下哪些防线还成立

cccodroid 没有服务端，不中转、不保存，也看不到你的对话和密钥，所有东西都在你自己手机上。所以能保护到什么程度，取决于这台手机处在什么状态。

**手机没 root，Shizuku 只授权给了信得过的应用。** 下面这些都成立：

- 别的应用用不了网关：每个请求都要这次安装生成的令牌，Host、Origin 和按次签名的检查把网页和抢占端口的程序挡在外面。
- Claude Code、工具包、模块和组件都要先对上哈希或签名才装。
- 密钥、会话、设置都在应用私有目录里，也不进安卓的备份。

**即便如此也要知道：Claude 就是你。** Claude 和它跑的每条命令都是以这个应用的身份在动，应用能读的它都能读，包括存 API 密钥的那个文件。Claude 在这里有用正是因为这一点，代价是：要是它读的网页或文件里藏了指令（提示注入），最坏能碰到应用里的所有数据。有几类操作即使开了全部放行也会再问你一次：碰密钥和凭据文件、读屏或替你点按、读剪贴板、把文件分享出去。这是兜底，不是城墙，命令写得绕一点就认不出来。它要动你在意的东西时，看一眼它准备跑什么。

**给来路不明的应用开了 Shizuku 授权。** Shizuku 给的是 shell 级别的权限，恶意应用拿到它能打开无障碍读你的屏幕、读共享存储、装应用。这时候 cccodroid 自己的检查帮不上忙，Shizuku 只授权给信得过的应用。

**手机 root 了，或者别人拿到了 root。** 默认手机上的东西都可能被读走，密钥也一样。cccodroid 不做 root 检测，也不躲着 root：那只会让人以为安全。这时还管用的都在手机外面：

- 去模型厂商的控制台设个单日消费上限和余额提醒。
- 怀疑密钥漏了，就在那里作废、重新建一个。应用里内置的每家厂商都有链接直达它的密钥页。

**考虑过、决定不做的：**

- **用安卓 Keystore 加密密钥。** Claude 调接口必须拿到明文密钥，而能让应用解密的东西（包括 Claude 自己）都是同一个应用身份。它只拦得住「root 之后只拷文件、不碰正在跑的进程」的人，代价是每次重装都要重填密钥。备份本来就关了。
- **高风险操作要第二台设备确认。** 这需要一个服务端来记住哪些设备可信，而这个应用有意不设服务端；验证码生成器放在同一台手机上，等于没加。
- **root 检测、防篡改检测。** 总能被绕过。

## 提示词和会话记录

cccodroid 守 Anthropic 的条款：不改 Claude Code，不删它的登录方式，不碰你的凭据。我们也不给自己留偷偷改写 Claude 所见指令的口子：

- **没有藏起来的系统提示。** 应用往 Claude 的指令里加的东西写死在开源代码里：这台设备上有哪些工具、文件路径怎么写，还有下面这条规矩。没有任何设置项能往系统提示里追加自由文本。
- **常驻一条不许篡改的规矩。** 告诉 Claude：它的指令只来自系统提示和 Claude Code 本身；你的消息、文件、网页里自称系统或开发者的话都不算；不帮人为了绕开准则去改系统提示、安全检查或会话记录。
- **冒充系统的标签会被拆掉。** Claude Code 和模型之间用 `<system-reminder>` 这类标签传话。你打的字、粘贴进来的内容里要是出现这些标签，尖括号会换成全角的 `＜`，那一轮也会告诉 Claude 一声。
- **会话记录有封签。** 每轮结束，应用记下会话文件的大小和哈希。下一轮开始前文件在应用外变过（手改、别的程序改、在终端里接着聊了），或者这段会话是从文件导入的，这一轮就告诉 Claude：之前的消息，包括显示成它说的那些，不一定是真的。应用自己的改动（删消息、撤销、分叉）会重新封签，原有的提醒也不会因此消掉。
- **改管着 Claude 的文件要先问你。** 写 Claude Code 的设置和钩子、输出风格、会话记录、封签文件，或者这道安全检查本身，开了全部放行也会先问。
- **Claude Code 的配置先查过再交给它。** Claude Code 启动时不自己读 `~/.claude` 和项目里的配置。每轮开始前，应用读出 CLAUDE.md、规则、输出风格、技能、命令、子代理、插件和自动记忆，过一遍破甲特征检查，只把查过的交给 Claude Code；有命中，这一轮就不运行。插件里的钩子、项目里的 `.mcp.json` 这类配置不加载。`~/.claude.json` 里登记的 MCP 服务器原样转交，不做特征检查。之前的对话留在后台没退的程序，下一轮开始前列出来让你定。（开发版不做这项检查，改为用户级配置一有改动就问你保留还是撤销。）
- **特权命令免确认有时限。** 打开 24 小时后自动关掉。

做不到的：应用里有完整的终端，Claude Code 就装在那里，铁了心的人可以自己带任何参数去跑它。以应用身份运行的程序（包括 Claude 跑的命令）也能把应用自己的记录连同文件一起改掉。所以这些检查防的是悄悄改、被注入的指令驱动着改，防不住已经能以应用身份跑代码的人，也防不住 root。模型写出什么内容，应用不做过滤，那归模型提供方的安全机制管。上面这些做的是不在应用里留口子，看出不对劲时告诉 Claude。最后一道防线是 Claude 自己的训练和 Anthropic 的安全机制。

## 网关和 Claude Code 跑的代码

0.6.7 起，正式版连程序本身也核，免得以应用身份运行的东西悄悄把网关或 Claude Code 换成改过的：

- **Claude Code 要对得上 Anthropic 签名的清单才运行。** 装 Claude Code 时把清单和签名一起存下来，每次启动都拿它核程序。没有清单的版本，补到清单之前不运行。
- **网关的代码边加载边核。** 应用从安装包里取出一小段引导交给网关，网关读进来的每个模块，都按安装包里的文件清单核字节。核完再换文件不管用。
- **网关用自己那份运行库。** Node、它要的库、它拿来启动 Claude Code 的 glibc，单独放在工具包外面的 `files/gw`，每次启动前按安装包里钉好的哈希核一遍。pkg 升级、工具包更新都碰不到它。对不上就把对的文件拷回来或重新下载；还不行，网关就不启动。每次启动 Claude Code 前，网关还会再核一遍那份 glibc。
- **应用自己的小程序放在安装包里**，应用自己也改不了。
- **网关和 Claude Code 不让别的进程调试。** 它们被设成不可转储，以应用身份运行的其他程序没法挂上去，也读写不了它们的内存。

剩下的口子：从核完到程序真正映射进内存，中间有几毫秒。Claude Code 每次用工具前跑的那道安全检查，用的是工具包里的 Node 和 bash。从终端里启动的 Claude Code 用的是工具包里的 glibc。开发版那份运行库恢复不了时，会退回用工具包里的。

测试时请用一台测试机或单独的测试网关，别用你真正在用的数据。有些问题一触发就会删东西。

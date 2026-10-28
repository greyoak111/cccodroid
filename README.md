# cccodroid

**English** · [简体中文](README.zh-CN.md) · [Discord](https://discord.gg/jE6KW8kwpe) · [Discussions](https://github.com/greyoak111/cccodroid/discussions) · [Contributing](CONTRIBUTING.md)

**A development launcher that runs Claude Code on Android phones.** No root, no custom ROM, no chroot / proot / VM.

[![Release](https://img.shields.io/github/v/release/greyoak111/cccodroid?color=c96442&label=release)](https://github.com/greyoak111/cccodroid/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/greyoak111/cccodroid/total?color=c96442)](https://github.com/greyoak111/cccodroid/releases)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)
[![License](https://img.shields.io/github/license/greyoak111/cccodroid)](LICENSE)

<p align="center"><img src="docs/assets/hero.jpg" width="880" alt="cccodroid on a tablet: the sidebar, the welcome screen with the input box, and the components page listing Blender, Godot, Cloudflare and other installable tools"></p>

<p align="center">
  <a href="https://github.com/greyoak111/cccodroid/releases/latest/download/cccodroid.apk"><b>Download the APK</b></a>
  &nbsp;·&nbsp; <a href="https://cccodroid.net/dl/cccodroid.apk">Mirror (cccodroid.net)</a>
  &nbsp;·&nbsp; <a href="#install">Install guide</a>
</p>

Android already runs on a Linux kernel. Once the tools run natively on that kernel, a phone can do real AI-assisted development:
write code, compile C/C++, run Python / Node, build APKs and push with git — all on the phone.

> cccodroid is a third-party project and is not affiliated with Anthropic. It runs the **official, unmodified Claude Code**:
> downloaded from Anthropic's official channel at install time (or, when that is unreachable, the identical file Anthropic publishes on npm, via a mirror), verified against the official sha256 manifest, never modified.

## Why

When you use AI on a phone and the model needs to actually do something (run code, edit files, build a package), the work usually goes to a cloud sandbox, and the phone is just a screen.
cccodroid brings execution back to your own device: the cloud does model inference, while your code, files and toolchain stay local, the environment persists across sessions, and the agent can reach the device itself.
The approach is not tied to one agent — any command-line AI agent that runs on Linux arm64 can be brought to a phone the same way.

See **[Design philosophy](docs/design-philosophy.md)**.

## Features

<p align="center"><img src="docs/assets/gallery.jpg" width="880" alt="Four phone screens: optional components, a new scheduled task, general settings with appearance and fonts, and the built-in help"></p>

- **Official Claude Code with a GUI**: chat, streaming output, thinking, tool calls, file browser, session history.
  - Messages sent while Claude is working wait at the end of the chat marked *Queued*; **Send now** delivers one into the running turn without interrupting it. **Stop only stops** — queued messages are paused, never sent automatically.
  - `/compact`, `/context` and other built-in commands show their results immediately.
  - Each reply shows a live generation timer that settles to the total time when it finishes.
  - **A quiet top bar**: the top right shows a single ⋯; tap it and Files, Terminal, Browser, Command palette and New session slide out, tap again to tuck them away. If the page ever stops scrolling, long-press the title in the top bar to rebuild it.
  - **Appearance and fonts**: three palettes (Native, Qiusuo and Zhuyue), light or dark or following the system (status bar included); the launch screen, first-run setup screen and in-app browser follow along. Fonts ship with the app, so the phone's system font doesn't change how it looks: Inter with Source Han Sans for the interface, and serif Spectral with Source Han Serif for replies by default. Settings lets you change the interface font, the response font (serif / sans) and the text size (small / medium / large). Code and the terminal use the CC Mono monospace font.
  - **Interface motion** (from 0.4.11): the sidebar, menus, pages and panels show where they come from and where they go, with a spring feel and matching exits; the sidebar follows your finger when you swipe it open or push it back. Only position and opacity animate, never streaming text or long lists, so older phones stay smooth. Reply text is released at an even pace, so it no longer lurches when a provider sends a big chunk at once. Settings → General → Interface motion: System / On / Off.
  - Your messages sit on the right and replies span the width, as in the desktop app. Tool calls between two pieces of reply text fold into one "N steps" line; tap to see each step. Groups with a pending approval or a failure open by themselves. Under each reply: **Copy** (the raw Markdown) and **Share** (system share sheet). Replies render Markdown with tables, task lists, LaTeX math and syntax-highlighted code blocks.
  - **Built-in help** (sidebar → More → Help): a full user guide and advanced tips, with a table of contents, in Chinese and English. Next to it, Release notes collects every version's notes and is searchable.
  - **Tablets in landscape and unfolded foldables**: depending on the window width, the layout becomes two columns (chat plus a workspace on the right) or three (plus a docked sidebar). Files, the viewer, the terminal and the in-app browser open on the right without covering the chat, and you can drag the divider between them. Phones in portrait and narrow split screens look the same as before.
  - **Work survives the background**: you get a system notification when a turn finishes or Claude is waiting for your approval. It shows no heads-up banner. The notification only offers *Deny* and *Open*; to allow a command you have to return to the app and read it in full. If the system kills the app, reopening it marks the unfinished turn as *Interrupted* with a *Continue* button, and queued messages are still there.
  - **Session management**: the Chats page in the sidebar searches message content and filters, and you can pin the chats you use most. Deleted sessions go to a recycle bin first (restorable for 30 days). Pick sessions one by one or all at once and export them as a zip — save it anywhere with the system *Save to* picker, or share it directly — then import the zip on another device and carry on where you left off.
  - **Terminal** (top bar): a real terminal with tabs, running the same bash and toolchain Claude uses — hx (Helix), less, top, git and the rest. A row of extra keys supplies what phone keyboards lack (Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, PgUp / PgDn, paste, font size); a text view lets you long-press to select and copy output. Terminals keep running when you close the panel and replay their output when you come back.
  - **File viewer / editor** (from the file browser): edit text and code and save — if the file changed on disk after you opened it (say Claude edited it), you are asked before anything is overwritten. Markdown renders with an edit toggle; images open fit-to-screen and tap to 1:1; PDFs render with [pdf.js](https://mozilla.github.io/pdf.js/) (CJK text and password-protected files included), pages drawn only as they scroll into view. Word and Excel files open directly; PowerPoint and legacy .doc files are converted to PDF once the LibreOffice component is installed. `.html` files show as live pages — CSS, JS and images they reference (in the same folder or a parent folder) load, and the page reloads when the file changes, so a browser game Claude wrote is playable with one tap. The top-right button is **Share**, which hands the file to the system share sheet.
  - **DevTools** (from 0.4.14): HTML previews and the in-app browser can open the bundled [Eruda](https://github.com/liriliri/eruda) — elements, console, network, storage — offline. With it on, **Pick element** puts the selector and a short HTML snippet of whatever you tap into the message box, so you can tell Claude what to change.
  - **Writing in Markdown**: while you edit, math and code blocks are typeset in place and show their source only when the cursor is on them; the word count keeps up as you type, and unsaved drafts are kept automatically. Manuscripts of millions of characters open and edit fine (up to 16 MB), with the preview laying out only what's near the screen, so scrolling stays smooth.
  - **Git panel** (from the file browser or the editor): see changes, history and line-by-line diffs, tick files and write a message to commit, and also discard changes, switch or create branches, pull and push.
  - **Switch right under the input box**: model, thinking effort and permission mode. On a new chat's start screen you can pick the project and model before you say anything.
  - `/goal <condition>` keeps Claude going turn after turn until the condition is met, with checks and elapsed time shown above the input box. On a Claude account or API key, a long session left idle for almost an hour is compacted first, so picking it up again uses less quota or money. Drag the compaction line on the provider and model page to choose where compaction starts.
  - **Rewind to here**: every message you sent can be rewound — undo only the files Claude changed since, or cut the chat back to that point in a new session and ask again. Any reply can also be **forked** into a new session, leaving the original alone. When Claude works through a long job, its **task list** sits above the input box, and each step a subagent takes is folded under that subagent's card. Background commands are listed there too; when there are several they fold into one line you can open to see and stop each one.
  - **Lineage** (sidebar, from 0.4.10): forks, continuations and rewinds between sessions are drawn as a metro map (or an indented tree), so you can see where each session came from. Every session gets a file number automatically; tap a stop to jump straight to that chapter. Older sessions can be filed in one go, and a short tour explains how to read the map the first time you open it.
  - **Attachments**: the top row of the ＋ panel is Attach file, Take photo, Screenshot and Browse files. Take photo opens the system camera; the photo is scaled to 2048 px on the long side and turned upright before it's attached. Screenshots go through Shizuku; long-press Screenshot to take one in 5 seconds, giving you time to switch to the app you want. Sharing to cccodroid from another app attaches the file too.
  - A **↓ button** appears when you scroll up through a long chat; tap it to jump to the latest message. A dot on it means new output arrived meanwhile.
  - **Paths in replies are links**: tap an absolute path such as `/storage/emulated/0/…/report.pdf` (or `file.js:12`) and it opens in the viewer; a folder opens in the file browser. Claude is told to write full paths so this always works. Tool cards that read or write a file get a ↗ button too.
  - **In-app browser** (globe in the top bar): web links in replies open inside the app — handy for checking a dev server at `http://127.0.0.1:<port>/`. On wide screens it opens in the workspace on the right, next to the chat. It uses the system WebView, so it adds no download. Sign-in pages still go to your normal browser.
  - UI in 9 languages: 简体中文, 繁體中文, English, Français, Español, Русский, العربية (RTL), 日本語, 한국어.
- **Projects and scheduled tasks** (from 0.3.13):
  - A project is a working directory plus its CLAUDE.md and default provider, model, effort and permissions; sessions are grouped under projects by directory.
  - Scheduled tasks have Claude do something on a schedule — daily, weekly, monthly, every few hours, once, or a cron expression — woken on time by a system alarm. You can limit a task to read-only, to this project, or to chosen tools, and cap the cost and duration of a run and the total per day. Nobody is watching while it runs, so anything that needs your approval is refused.
- **Usage and limits**: the second half of the context line under the top bar shows what is left on the current provider — the 5-hour and weekly limits for a Claude account, the balance for DeepSeek, Kimi and others — and warns you when it runs low. The Usage page records conversations, active days and models used, with a monthly report card to save or share; it counts usage only, never content.
- **The toolchain installs by module** (Extensions → Toolkit modules, from 0.3.9): it is split into base, command-line tools, C/C++ compilers, Java and Android packaging, graphics libraries, audio/video, docs and data, Go and the Node.js ecosystem. You pick modules on first install and can add or remove them later. Each one lists its purpose, main commands, size, dependencies and which components use it; typing a command from a module you have not installed tells you where to find it. Upgrading from 0.3.8 or earlier installs every module, so nothing goes missing.
- **Optional components** (Extensions → Optional components): large tools that don't ship with the app; download them only if you need them. Each build matches a specific toolchain release, is checked against its SHA-256 and a per-file manifest before anything is installed, and uninstalls cleanly.
  - **Browser component (headless Chromium 155)**, about 254 MB to download and 750 MB installed: lets Claude open pages headlessly — screenshots, PDF export, the rendered DOM, and scripted browsing with puppeteer-core. It comes with a skill that tells Claude how to use it.
  - **Community components** from the [cccodroid-components](https://github.com/greyoak111/cccodroid-components) repository. There are currently 28, or 29 with the browser above. Dev: GitHub CLI (gh), Godot (headless runs, APK export), Graphviz / PlantUML diagrams, Hugo, reverse engineering (rizin, binwalk). Media: Blender (headless compositing and rendering, 3D on the GPU), LilyPond (music engraving), a music production toolchain. Office: LibreOffice, Pandoc, a PDF toolbox, OCR (Chinese and English), LaTeX (Tectonic, with Chinese support). AI: llama.cpp. 3D and science: OpenSCAD, GNU Octave, scientific Python (numpy / scipy / matplotlib). EDA: ngspice / gnucap, Icarus Verilog / Yosys. GPU: Snapdragon driver (Vulkan / OpenGL / OpenCL), Mali driver, GPU benchmarks. Net: Cloudflare (wrangler), rclone. See the [full list](https://github.com/greyoak111/cccodroid-components#components). Indexes are ed25519-signed and rejected if they do not check out; community components are labelled as such, and builds nobody has verified on a real device ask first.
  - **Custom components**: import a Linux arm64 program the market doesn't have (a single binary or a .tar.gz / .zip). It works out whether the program is glibc, Android-native, static or a script, and pulls missing libraries from the Termux glibc repository; once installed it is one command that both Claude and the terminal can use. Where it comes from is your responsibility.
- **Several ways to connect**:
  - Sign in with a Claude account inside the app; after authorizing in the browser you are brought back automatically. The account card shows your 5-hour and weekly usage limits with their reset times (taken from what Claude Code itself reports after each turn — the app never queries anything with your credentials).
  - Claude API key.
  - The official Anthropic-compatible endpoints of model makers: DeepSeek, Zhipu GLM, Qwen, Kimi, MiniMax, Volcengine Ark (Doubao), Xiaomi MiMo, StepFun, Baidu Qianfan, Tencent Hunyuan, Meituan LongCat, xAI Grok and Meta Muse.
  - Any other compatible third-party endpoint you add.
  - On-device model: with the llama.cpp component installed, chat with a small model running on the phone itself, offline and free. Phone hardware is limited, so leave real work to a cloud model.
  - **Per conversation**: the provider, model and effort in Settings are defaults; picking something inside a conversation changes only that one. Several conversations can run at once — one on a Claude account, another on DeepSeek — without getting in each other's way.
- **A complete development toolchain** (about 250 packages, taken from the official [Termux](https://termux.dev) repositories):
  - C/C++: clang 21 / lld, make / cmake / ninja, gdb / strace.
  - Languages: Python 3.14 (pip, venv), Node 26 (npm, npx).
  - Android builds: OpenJDK 21, aapt2 / d8 / apksigner — build APKs on the phone.
  - VCS and network: git, ssh, curl.
  - Audio and video: ffmpeg 9 (x264 / x265 / VP9 / AV1 / Opus…) with hardware encoding on the phone (`h264_mediacodec` / `hevc_mediacodec`), more than 3× faster than software encoding.
  - CLI tools: rg / fd / bat / jq / sqlite3 / typst / ImageMagick… Tab completion works in interactive bash; `hx-grammar` installs just the Helix syntax grammars you need; typst finds the system CJK fonts out of the box.
  - Anything missing: `pkg install` in the terminal installs it from the Termux repositories, and `pkg verified` lists the packages tested to work.
- **System privileges (optional)**: [Shizuku](https://shizuku.rikka.app) integration. In the terminal, `priv '<cmd>'` runs pm / am / settings / logcat / screencap… as the shell user.
  - One-tap install and activation from Settings: downloaded from Shizuku's official release (signing certificate verified), installed with the system installer,
    then activated over Wireless debugging — no computer needed. The pairing code is entered in a notification that stays at the top of the screen, so the pairing dialog stays open.
  - After a reboot, cccodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- **Device tools (off by default)**: turn them on in Settings → Device tools and Claude can post notifications, read and write the clipboard, share files to other apps, open links or apps, and check battery and network; reading and tapping the screen uses accessibility and is a separate switch. Under the hood this is an MCP server for Claude that calls the system through Priv. Calendar, mail and the like are only pre-filled; you save or send them yourself.
- **Memory manager (off by default)**: before heavy jobs such as builds or renders, it stops background apps outside an allowlist through Shizuku, and stops them again if they come back while the job runs. The app you're looking at, split-screen apps and anything with a foreground notification are left alone. In the terminal, use `cc-mem run -- <command>`. How to read memory numbers and find the culprit: [docs/memory-management.md](docs/memory-management.md).
- **Work Island (ColorOS, off by default)**: with the community-built Work Island app installed, Claude working, waiting for your approval and finishing a task show up on the ColorOS 16 Fluid Cloud island. See [docs/work-island.md](docs/work-island.md).
- **Automatic updates** (on by default; can be turned off or triggered manually in Settings):
  - Claude Code: silent updates from the official channel (stable / latest, or pinned to a specific version); running conversations are not affected. If the official channel is unreachable, the same file comes from an npm mirror and is still checked against the official manifest.
  - cccodroid itself: downloaded, signature-checked, then offered for install; installed silently when idle if Shizuku is available. There are two APKs, targetSdk 28 and 36; updates follow the one you have installed, and you can switch in Settings (a system that only accepts 36 won't let you switch back to 28).
  - Toolchain: pre-downloaded on Wi‑Fi only and swapped in the next time the app opens; anything you installed with pip / npm -g is kept.
  - Updates never cut each other off: while the toolchain is downloading or being replaced, the app update waits. The replacement is checked against the release manifest before the old toolchain is touched, and if it is interrupted (app restart, process killed) the next launch finishes it or rolls back.
  - **Verify / Repair** in Settings checks every toolchain file against its recorded hash; Repair reinstalls the same version and keeps your own packages. A quick check also runs at each launch.
- **Extensions**: install, enable, disable and uninstall Claude Code plugins (search the official directory or add other marketplaces), install skills from a zip, and add or remove MCP servers — all from the Extensions tab. Everything goes through Claude Code’s own `claude plugin` / `claude mcp` commands; a plugin that needs to run a command to install shows it to you first.
- **Troubleshooting**:
  - **Safe mode**: if a hook, plugin, MCP server or CLAUDE.md breaks things, turn on safe mode and Claude Code starts with its built-in `--safe-mode` — no customizations loaded, while sign-in, keys, sessions and model stay as they are. Nothing is moved or edited; turning it off restores everything.
  - **I'm stuck · bundle diagnostics** (in Settings, and on the install-failure screen): diagnostics, the app log, the gateway log and the repair ledger, packed into a zip and handed to the system share sheet. Before packing, you see a list of what goes in. Keys, tokens, email addresses and the content of your messages to Claude are scrubbed first, and conversation transcripts are not included.
  - **Plain-language first-install errors**: the app checks free space before downloading and tells you how much it needs. Failures such as being offline, rate limiting or a checksum mismatch are explained in plain words. *Retry* resumes from what was already downloaded.
  - **Repair ledger**: every toolchain install, verification, repair and startup recovery is recorded (what was found, what was done, the result) and can be read in Settings.
  - **Known issues**: problems not yet fully explained or ruled out, and what we know about each, are listed in [docs/known-issues.md](docs/known-issues.md).
  - **Permissions**: what each permission is for, when you're asked and what happens if you say no, in [docs/permissions.md](docs/permissions.md). Found a security problem? Report it privately as described in [SECURITY.md](SECURITY.md).
- **USB debugging of another device**: connect it with an OTG cable and run `usb-adb`, then `adb devices / install / shell` as usual.
- **Self-test**: `cccodroid-selftest` exercises about 70 tools and usages (including ffmpeg and a hardware-encoding probe); the tool notes are injected into Claude's system prompt so it knows what it has.

## Install

1. Download `cccodroid.apk` from [Releases](https://github.com/greyoak111/cccodroid/releases) and install it. If Android says it isn’t compatible and won’t install it, use `cccodroid-36.apk` from the same release instead (targets SDK 36, same features, available from 0.3.17; see “Updates and repair” in the in-app help for how the two differ).
2. Open the app. The first launch automatically:
   - downloads the toolchain: you pick modules first; the base is required, and the command-line tools and C/C++ compilers are ticked by default, about 350 MB in total (all modules about 740 MB); resumable, sha256-verified, then unpacked;
   - downloads Claude Code from Anthropic's official channel (about 290 MB).
3. Choose how to connect in Settings: sign in with a Claude account, or enter an API key.
4. (Optional) Install and start Shizuku, then grant it in Settings to enable `priv` and stronger keep-alive.

Requirements: Android 8.0+, arm64, about 4 GB free space.

Tested devices: Lenovo TB320FC (Snapdragon 8+ Gen 1, Android 15) and Red Magic 9 Pro NX769J (Snapdragon 8 Gen 3, Android 14, installed from scratch following this section). Community reports: Redmi K70 Ultra (Dimensity 9300+, Android 16, [#14](https://github.com/greyoak111/cccodroid/issues/14)) and vivo V2502A (Dimensity, Android 16). Android 12 / 13 have not been tested on real hardware yet; reports are welcome.

Versions with a suffix (such as `v0.2.0-rc1`) are pre-releases. In-app updates only offer stable releases; download pre-releases from Releases by hand.

**Allow background running on vendor ROMs**: some vendors' power savers ignore foreground services and freeze the whole app in the background
(measured on RedMagic: frozen about 90 s after leaving the foreground), stopping any running task. When cccodroid detects a freeze during a running task, Settings tells you exactly where to fix it.
RedMagic / ZTE: App info → App battery usage → Battery optimization → **Background running: Allow**, **Auto-start: Allow**.

**Offline install**: put `devkit-cc.codroid.tar.gz` in `/sdcard/cccodroid/`; the first launch uses it instead of downloading.

**Versions**: v0.3.0 was the first stable release. Each minor series runs 21 releases (0.3.0–0.3.20, now 0.4.x); every release installs over the old one and keeps your data and installed tools.

## Community and contributing

- **Questions, ideas, device reports**: [GitHub Discussions](https://github.com/greyoak111/cccodroid/discussions), in English or Chinese. There is also a Chinese-speaking QQ group, 1062538743.
- **Chat**: the [cccodroid society](https://discord.gg/jE6KW8kwpe) Discord server, English or Chinese.
- **Bugs**: in the app, tap Settings → Report on GitHub; your device and self-test results are filled in for you.

**cccodroid is maintained by one person and badly needs help.** Device reports, translation fixes, component recipes, docs and code are all welcome, and you can help without writing code. See the [contributing guide](CONTRIBUTING.md).

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/cccodroid-architecture.en-dark.png">
  <img alt="cccodroid architecture: the user works in the UI (a WebView; the front end is 19 parts the gateway joins and serves), which talks over HTTP and SSE to the gateway on 127.0.0.1 (server.mjs plus feature modules in gw/, with token checks and an event bus). The gateway is started and restarted by the GatewayService foreground service, reads and writes sessions, settings and the token under home/, reaches Shizuku through the Priv relay over a local socket, and drives the official, unmodified Claude Code over stream-json. Claude Code calls the model APIs over HTTPS (a Claude account, DeepSeek, Kimi and others, chosen per conversation) and the devkit toolchain (a base plus optional modules) through its Bash tool. In the targetSdk 36 build, the loader shipped in the APK (libldlinux.so) and an exec shim rewrite how programs are started. The device tools MCP is an MCP server for Claude that goes through Priv over a local socket. Updater / Installer download from GitHub, the cccodroid.net mirror and official channels, and manage the 28/36 APKs, toolkit modules and Claude Code. Components fetch an ed25519-signed index and packages from the component market, install them into devkit and copy their skills into ~/.claude/skills, so Claude Code learns the new tools" src="docs/diagrams/cccodroid-architecture.en-light.png">
</picture>

Interactive version (guided views, light/dark, export): download [`docs/diagrams/cccodroid-architecture.en.html`](docs/diagrams/cccodroid-architecture.en.html) and open it in a browser;
the source is `cccodroid-architecture.en.json` in the same directory, with every component tied to the source lines it describes. Generated with [Archify](https://github.com/tt-a1i/archify).

## How it works

```
cccodroid.apk (Java shell: installer + foreground service + WebView)
  ├─ files/usr/      toolchain: official Termux packages, run natively after same-length prefix relocation
  ├─ official Claude Code (linux-arm64 glibc build, unmodified binary)
  │     └─ started by the glibc loader with --preload of a tiny seccomp library
  ├─ lib/arm64-v8a/libldlinux.so   the same glibc loader; the 36 build starts glibc programs through it
  └─ gateway gateway/server.mjs + gw/ (Node): runs claude, event stream, queue, provider config → UI gateway/web/
```

- **Same-length prefix relocation**: Termux binaries have `/data/data/com.termux/` baked in at build time. The package name `cc.codroid` has exactly the same 10 characters as `com.termux`, so a byte-for-byte replacement fixes every RUNPATH, shebang and config path — no `LD_LIBRARY_PATH`, wrapper scripts or binary patching. Entries inside zip / jmod archives are rewritten too. See [devkit/README.md](devkit/README.md).
- **seccomp**: Android installs a syscall allow-list on app processes and kills anything outside it with SIGSYS. Android 14 does not allow `epoll_pwait2`, so Claude Code would be killed at startup. [`seccomp-enosys.c`](android/native/seccomp-enosys.c) turns such calls into ENOSYS so programs take their own fallback path; `enosys-run` does the same from outside (ptrace) for static binaries.
- **targetSdk 36**: since Android 10, apps targeting SDK 29 or later can't execute files in their own data directory. The regular APK still targets 28. The 36 build puts the glibc loader in the APK's native library directory, which the system does allow, starts bionic programs through `/system/bin/linker64`, and an exec shim ([`exec-shim.c`](android/native/exec-shim.c)) rewrites every program launch into one of those two forms. Both APKs have the same features; every component has been run on a real device with the 36 build.
- **Gateway access control**: the gateway listens on 127.0.0.1 only, and every `/api/*` request must carry a 256-bit token from the app's private directory; Host and Origin are checked as well. Other apps and web pages on the phone cannot drive it.
- **Credentials**: account sign-in is done by Claude Code itself. The gateway hands the authorization URL to the system browser and never reads or stores claude.ai credentials; it does not handle the one-time authorization code either (see [Terms and compliance](#terms-and-compliance)). Third-party API keys live in the app's private directory and reach claude through `apiKeyHelper`, never through environment variables.

## Terms and compliance

cccodroid aims to follow [Anthropic's terms for products that run Claude Code](https://code.claude.com/docs/en/legal-and-compliance). Below is exactly what the app does, so you can judge for yourself:

- **How the binary runs.** The Claude Code file is byte-for-byte the official linux-arm64 build: checked against the official sha256 manifest and never patched. Android has no `/lib/ld-linux-aarch64.so.1`, so it is started through the glibc loader (the toolchain's copy, or in the 36 build the identical copy inside the APK), with a 61-line preload library ([`seccomp-enosys.c`](android/native/seccomp-enosys.c)) that turns system calls Android's seccomp filter forbids into ENOSYS. The library does not read or change Claude Code's code or memory; it only keeps the process from being killed.
- **Signing in with a Claude subscription.** Sign-in is Claude Code's own `claude auth login`. You authorize on Anthropic's page in your browser, Claude Code writes the token to its own `~/.claude/.credentials.json` (the app never reads that file), and while signed in Claude Code talks to api.anthropic.com directly, not through any process of ours. In practice this is the same as SSHing into a Linux machine you own, running Claude Code there and signing in: here the Linux machine is the phone, and the app is the screen and keyboard. Every turn starts with you: either a message you send, or a scheduled task you set up yourself. Scheduled tasks run on your own phone, under your own account, with the same unmodified Claude Code; since nobody is watching, anything that needs approval is refused — the app never clicks "Allow" for you. Since 0.4.2, scheduled tasks that would run on a subscription account are off by default; you turn them on yourself after accepting that unattended use is governed by Anthropic's terms. Anthropic's terms cover this case explicitly: they do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- **The one-time authorization code.** Normally the browser hands the code back to Claude Code automatically, on this device, without passing through the app. If that fails (for example you authorized on another device), the app opens its built-in terminal and runs `claude auth login` there; you paste the code into Claude Code's own prompt. The terminal is a generic byte channel, like Termux or SSH; the app has no field that accepts the code and never parses, saves or logs it.
- **Permission prompts.** Like the official CLI, Claude asks before editing files, running commands or going online, and you answer in the chat. The default mode is "Ask each time"; "Allow everything" is available but asks for confirmation first.
- **The name.** cccodroid stands for "Claude Code CLI On droid", modelled on the long-standing Android C/C++ IDE C4droid. The project does not use the Claude or Anthropic names or logos in its name, icon or package name, and does not claim to be made, endorsed or partnered with by Anthropic. If Anthropic asks, the project will be renamed.
- **No resale, no middleman.** cccodroid is free and open source, has no server, and does not provide, pay for or resell any Claude usage: you sign in with your own account or bring your own API key, and usage is billed to you directly. The author has a Claude Console account and has accepted Anthropic's Commercial Terms, which the terms above require for products that run Claude Code.

### What this project stands against

cccodroid doesn't do, doesn't support, and won't accept pull requests that add any of the following:

- **Reverse proxies and shared or resold accounts**: splitting one subscription among many people, or repackaging subscription usage as an API for sale.
- **Jailbreaking**: getting around a model's safety limits to extract harmful content it would otherwise refuse.
- **Mass-controlled accounts**: using agents to register, farm or run accounts in bulk to flood comment sections while passing as real people.

These look like clever shortcuts, but ordinary users pay for them:
- shared accounts get banned without warning;
- the proxy in the middle sees every piece of code, key and conversation that passes through;
- flooding accounts crowd out real discussion;
- platforms respond by tightening limits and raising prices.

Over time everyone who uses these services honestly loses out.

We don't police other people's choices. In this project, though, the line is clear: no features for these uses, and no help troubleshooting them. The component market doesn't accept such components either.

## Build

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → sign, produces dist/cccodroid.apk (targetSdk 28)
TARGET_SDK=36 sh scripts/build.sh   # the 36 build; scripts/ship.mjs builds both for a release
node devkit/devkit.mjs build --target cc.codroid   # build the toolchain (CI can do this too)
```

**No setup needed**: GitHub Actions builds an APK for every pull request and every push to main; download it from that run's Artifacts (see [.github/workflows/apk.yml](.github/workflows/apk.yml)). Builds from main are signed with the release key and install over the released app. Pull requests from forks are signed with a throwaway test key, so you have to uninstall the released app first; a spare device is best.

To build on your own machine, install JDK 17, Node.js, the Android SDK (build-tools and a platform) and the NDK, then set the environment variables described at the top of `build.sh`. `apk.yml` is a working example. The script's default tool paths point at the author's Android tablet.

Release signing certificate SHA-256: `B7:03:61:59:5D:D3:D8:D7:04:DD:21:0E:D5:96:FC:57:70:14:CE:22:72:88:4F:B6:98:0B:F6:96:23:33:8F:E0`.

The toolchain is built and published by GitHub Actions: push a tag like `devkit-YYYY.MM.DD` (see [.github/workflows/devkit.yml](.github/workflows/devkit.yml)).
Which toolchain version the app downloads is set in [devkit-sources.txt](devkit-sources.txt). The size and SHA-256 of that version live in [devkit-pin.json](devkit-pin.json), which ships inside the APK: the first install (from GitHub, the cccodroid.net mirror, or a local file) and the check on local files both trust it rather than the download source. It also pins the SHA-256 of the lock file `devkit.lock.json` itself, which `build.sh` checks before extracting the glibc loader instead of relying on HTTPS alone. When you switch versions, edit the former, run `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`, and commit both; `build.sh` checks that they match.

Layout:

| Directory | Contents |
|---|---|
| `android/` | Java shell, Manifest, resources, terminal helpers (`assets/bin/`), native libraries (`native/`), the original glibc loader shipped in the APK (`prebuilt/glibc/`) |
| `gateway/` | Gateway (`server.mjs` + feature modules in `gw/`, Node.js) and UI (`web/`, plain JS, no build step) |
| `i18n/` | UI translations: one txt per language plus the generate and check scripts, see [i18n/README.md](i18n/README.md) |
| `devkit/` | Toolchain build script and manifests |
| `docs/design-philosophy.md` | Why the project exists and the principles behind it |
| `docs/large-screen.md` | Large-screen layout (tablets, foldables) and where its code lives |
| `docs/known-issues.md` | Known issues and unresolved risks, plus test actions that create fake bugs |
| `docs/download-sources.md` | Every download chain: sources, trust anchors, server mirrors, how to check and maintain them |
| `docs/memory-management.md` | Reading memory numbers, finding the process that eats memory, and how the memory manager works |
| `docs/work-island.md` | The Work Island (ColorOS) integration: parts, turning it on and off, design notes and known limits |
| `docs/permissions.md` | What each permission is for, when you're asked, what happens if you refuse, and the risks of the three heavy ones |
| `docs/claude-code-versions.md` | On-device verification of new Claude Code releases, the Verified / Known issue marks and how auto-update uses them, and the maintainer workflow |
| `docs/operit2-on-device-build.md` | Case study: building Operit2 (Flutter + Rust) from source into an APK on a phone, with every gap and fix |
| `docs/diagrams/` | Architecture diagrams (Archify JSON specs → interactive HTML → light / dark PNG) |
| `third_party/` | Shizuku-API 13.1.5 (MIT, unmodified from Maven Central) |

## Special thanks

- **[DeepSeek Harness for Android](https://github.com/woaiys3/deepseek-harness-android-app)** (woaiys3): running AI agents on a phone without root, elevating through Shizuku, keeping alive with a foreground service — it walked these paths first. cccodroid's early exploration and development happened inside the environment it built; that Claude Code runs on Android the way it does today rests on the foundation laid by it and its author.
- **[Archify](https://github.com/tt-a1i/archify)** (tt-a1i, MIT): the architecture diagram above was made with it and passed its layout checks; license in [ThirdPartyLicenses/Archify](ThirdPartyLicenses/Archify/LICENSE).
- **[Eruda](https://github.com/liriliri/eruda)** (liriliri, MIT): the developer tools in previews and the browser pane; license in [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE).
- **[Termux](https://termux.dev)**: the toolchain is assembled from its official packages.
- **[Shizuku](https://shizuku.rikka.app)** (RikkaApps): system privileges without root.
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js): the Traditional Chinese UI strings were converted with it, then reviewed by hand.

### Community contributors

- **[bmbmm-114514](https://github.com/bmbmm-114514)**: a careful code review that reported ten security and stability problems, each with reproduction steps and code locations; all fixed in 0.3.2.
- **[IVESHOWARD](https://github.com/IVESHOWARD)**: reported the skill archive import problems (only one of several skills imported, archives sometimes not recognised); fixed in 0.3.2.
- **[CCB-Fox](https://github.com/CCB-Fox)**: the Dimensity GPU driver component ([cccodroid-components#46](https://github.com/greyoak111/cccodroid-components/pull/46)), which led to Mali support in 0.3.3.
- **[Cosmosophius](https://github.com/Cosmosophius)**: a thorough Dimensity 9300 report ([cccodroid-components#47](https://github.com/greyoak111/cccodroid-components/issues/47)).
- **[gogoiPhone](https://github.com/gogoiPhone)**: a Redmi K70 Ultra device report with their own Vulkan compute test ([#14](https://github.com/greyoak111/cccodroid/issues/14)).
- **[Slingerspir](https://github.com/Slingerspir)**: suggested a GitHub acceleration route and multi-threaded downloads ([discussion #15](https://github.com/greyoak111/cccodroid/discussions/15)); 0.4.1 added segmented parallel downloads and a gh-proxy fallback.
- **[hye45402-pixel](https://github.com/hye45402-pixel)**: asked for LaTeX, syntax highlighting, code-block language labels, strikethrough, bold italic and task lists ([discussion #18](https://github.com/greyoak111/cccodroid/discussions/18)); all added in 0.4.4.
- **[STUTTEFRFIX](https://github.com/STUTTEFRFIX)**: the Work Island integration, which shows Claude's working status on the ColorOS 16 Fluid Cloud island ([#20](https://github.com/greyoak111/cccodroid/pull/20), [#21](https://github.com/greyoak111/cccodroid/pull/21)), with the companion app [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android). The first outside pull request merged into cccodroid; shipped in 0.4.7.
- **[ThinkReally114](https://github.com/ThinkReally114)**: feedback and bug reports in the community group throughout 0.3.x.
- **[wangxp12](https://github.com/wangxp12)**: feedback and bug reports in the community group throughout 0.3.x.
- **[unoyg](https://github.com/unoyg)**: feedback and bug reports in the community group throughout 0.3.x.
- **[fisHarly0](https://github.com/fisHarly0)**: suggestions for improvements in the community group during 0.3.x.
- **[chenshi723](https://github.com/chenshi723)**: front-end suggestions in the community group during 0.4.x. The whole interface motion system in 0.4.11 started from their remark that the app's motion felt bare; they then pointed out the sidebar's leftover animation when closing, the new-chat greeting rendering twice, choppy streaming, the DeepSeek balance showing 0 and fonts not fully following the system — fixed across 0.4.11–0.4.12.
- **[leemwood](https://github.com/leemwood)**: pointed out in the community group that the web preview lacked element picking, which led to the DevTools and "pick an element for Claude" in 0.4.14.

Reports, device testing and code review are contributions too, and they're recorded here.

## License

cccodroid itself is released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).

### Third-party components

- **Claude Code**: proprietary software by Anthropic, **not distributed with this project**. Its use is subject to [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).
- **Toolchain**: taken from the official Termux repositories; each component is distributed under its own license (including GPL). Versions, hashes and build recipes are in the `devkit.lock.json` / `SBOM.tsv` attached to each release. If you need a copy of the source, ask in Issues.
- **glibc dynamic loader** (`lib/arm64-v8a/libldlinux.so`, shipped in the APK): from Termux's glibc package, LGPL-2.1-or-later. See [android/prebuilt/glibc](android/prebuilt/glibc/README.md).
- **Shizuku-API**: MIT, see [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE).
- **xz-decompress** (used at toolchain build time): MIT.
- **[xterm.js](https://xtermjs.org)** (terminal): MIT, see [ThirdPartyLicenses/xterm.js](ThirdPartyLicenses/xterm.js/LICENSE).
- **[highlight.js](https://highlightjs.org)** (code highlighting in chat): BSD-3-Clause, see [ThirdPartyLicenses/highlight.js](ThirdPartyLicenses/highlight.js/LICENSE).
- **[KaTeX](https://katex.org)** (math in chat): MIT, see [ThirdPartyLicenses/KaTeX](ThirdPartyLicenses/KaTeX/LICENSE).
- **[pdf.js](https://mozilla.github.io/pdf.js/)** (PDF viewer): Apache-2.0; its bundled OpenJPEG / JBIG2 / QCMS decoders carry their own licenses. See [ThirdPartyLicenses/pdf.js](ThirdPartyLicenses/pdf.js/).
- **CC Mono** (monospace font for the UI and terminal): a subset of [Monaspace Neon](https://github.com/githubnext/monaspace) by GitHub, SIL OFL 1.1, renamed as the Reserved Font Name clause requires. See [ThirdPartyLicenses/ccmono](ThirdPartyLicenses/ccmono/LICENSE).
- **`android.jar`** is not shipped (its license forbids redistribution); download it yourself if you want to compile APKs on the phone.

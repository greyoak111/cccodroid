# cccodroid help

cccodroid runs the **official, unmodified Claude Code** on your phone, wraps it in a graphical interface and ships a full developer toolchain. Claude can read and write files, run commands and start local servers, just as it would in a terminal on a computer.

## Getting started

1. **Install the toolkit**: on first launch, tick the modules you want. The default set is about 330 MB and resumes if interrupted.
2. **Sign in or add a key**: authorize your Claude account once in the browser, or enter a key for Anthropic, DeepSeek, Qwen or another compatible endpoint.
3. **Start a conversation**: tap ＋ in the top bar, or New chat in the sidebar.
4. **Put it to work**: Claude asks before editing files or running commands; switch the permission mode under the input bar.

## The screen

The right end of the top bar normally shows just ⋯. Tap it and the shortcuts you use most slide out to its left; tap it again (it is now ›) to tuck them away. The app remembers which way you left it.

| Button | What it does |
|---|---|
| 📁 | Files: browse, edit and preview files in the workspace |
| >_ | Terminal: the same toolchain Claude uses |
| 🌐 | Browser: local servers and links from replies; docks on the right on a tablet |
| ‹› | Command palette: slash commands, skills and common actions |
| ＋ | New conversation |
| ⋯ | Show or hide the buttons above |

The menu button at the top left opens the sidebar: places to go at the top (Chats, Projects, Scheduled tasks, with Extensions, Capabilities, Usage and Help under More), recent chats in the middle, and the account row at the bottom, which opens Settings.

The thin line under the top bar shows **context usage**; the further right, the fuller. Its second half shows what is left on the current provider: the share of the 5-hour and weekly limits used when you sign in with a Claude account, or the balance for DeepSeek, Kimi and similar. If a provider doesn't report its context window, fill in **Context window** for that custom provider under **Provider & model** in Settings, and the compaction line and scale follow it; without one the bar shows "capacity unknown". Tap the line for details; every provider’s quota and spending, plus low-quota reminders, are under **Quota and spending** at the top of the Usage page. In the input area, ＋ attaches files and opens common actions. The row below shows the model, thinking effort and permission mode; tap any of them to change it. The model picker only lists providers you can use: a Claude account that isn’t signed in, or an on-device model with nothing downloaded, is left out. To hide a provider you’ve set up, pick it under **Provider & model** in Settings and turn off **Show in the model picker** (its settings are kept, and the one in use is always listed).

## Make it yours

- **Appearance**: Settings → General → Appearance offers five styles: Native, Qiusuo, Zhuyue, Construct and Material, each in light and dark. Construct has square corners, heavy ink lines and red on kraft paper, for when you want something bolder; Material takes its colors from your wallpaper (Material You).
- **Accent color**: Settings → General → Accent color offers eight presets or a color of your own. It's adjusted for the current appearance, so it stays readable in light and dark.
- **Buttons under messages**: in Settings → General, tap the ones you don't use (bookmark or fork, say) to hide them; your messages and Claude's replies are set separately.
- **Top bar buttons**: Settings → General → Top bar buttons. Each button can be Pinned (always on the top bar, no need to tap ⋯ first), In ⋯, or Hidden. Hold the handle on the left and drag to reorder. Restore default puts everything back.
- **Fonts**: the interface and replies can each use a different font. Under Settings → General → Imported fonts, import a ttf / otf / woff / woff2 file, then pick it with Custom… on the row you want. Characters the font lacks (say, Chinese in a Latin font) fall back to the built-in fonts. Code and the terminal always use the built-in monospace font.
- **Saved prompts**: save long prompts you send often and pick them by typing / in the input box; see Extensions below.
- **Sidebar shortcuts**: Customize pinned items… at the bottom of More in the sidebar.

These choices are stored in the app's own data, so clearing the WebView cache won't lose them.

## Conversations

- **Enter sends.** Sending while Claude is busy queues the message; ⚡ interjects into the running turn without stopping it.
- `/` opens slash commands and `@` references a file. Use Share → cccodroid in other apps to attach files directly.
- The top row of ＋ next to the input box: Attach file, Take photo, Screenshot, Browse files. Photos are scaled to 2048 px on the long side before they're attached. **Long-press Screenshot to take it in 5 seconds**: switch to the app you want to capture in the meantime, and you'll be brought back afterwards.
- Tool calls collapse into one line such as "3 steps · done"; tap to see each step. Steps that need you, or that failed, open on their own.
- **Subagents** get their own card below the steps that launched them: one row per subagent with its status, step count and what it's doing; tap a row to open its steps. At the bottom, the message log shows "who → whom · what about". Each subagent's brief and report are saved under `.cccodroid/agents/` in the project folder; tap "Brief" or "Report" to read them.
- Paths in replies open in the viewer; web links open in the in-app browser.
- Every message has four buttons. Yours: copy, resend, rewind to here, delete. Claude's: copy, share, fork from here, delete.
- **Rewind to here** first lists the files changed since, then lets you undo just the code, or the code and the conversation. Files changed by shell commands are not restored.
- `/goal <condition>` keeps Claude working turn after turn until the condition is met. Background tasks and the task list appear above the input box, and each can be stopped; several background tasks fold into one line, tap it to expand.
- Conversations that were running when the gateway restarted or the system killed the app are marked "Interrupted" in the list; open one and tap "Continue" to pick it up. Each has its own.
- **Misc**: throwaway sessions such as trying a model or saying hi are filed under "Misc" by Claude when it catalogs them. They stay out of the sidebar and appear as the last group on the Chats page; pinned ones and ones that are running or waiting for your confirmation still show in the sidebar. If a session Claude put in Misc gets compacted once or grows past 512 KB, it goes back to its normal group automatically. Sessions you moved there yourself with "Move to Misc" stay put; "Remove from Misc" brings any session back.
- The Chats page searches message content, filters, and exports or imports zips. Deleted chats stay in the trash for 30 days.

## Permissions and safety

| Mode | Behaviour |
|---|---|
| Ask me (default) | Reads freely; asks before editing files, running commands or going online |
| Accept edits | Edits without asking; still asks before commands |
| Plan | Reads and plans only, and acts once you approve |
| Auto | Claude's classifier decides what needs asking (experimental) |
| Deny unasked | Anything that would need approval is refused; for unattended runs |
| Allow everything | Never asks; only when you trust the task completely |

**What "Allow everything" really means.** Claude stops asking and edits any file or runs any command directly, including deleting things, going online and sending data out. The main risk is not Claude itself but what it reads: web pages, downloaded files, other people's repositories and issues can hide instructions aimed at the AI (prompt injection) that tell it to read your keys, change settings or upload something. In "Ask me" mode you see that step and can refuse; with "Allow everything" that check is gone. So:

- Turn it on only for a clear task where you know which files it will touch, and switch back afterwards.
- Leave it off when Claude is reading unfamiliar web pages, repositories or files of unknown origin.
- "Confirm sensitive actions" (Settings → Claude behaviour, on by default) is a safety net: when Claude is about to read keys or sign-in credentials (.env, SSH keys, API keys, the gateway token and so on), read the screen or tap in other apps, read the clipboard, or share a file out, a red-bordered card asks you even under "Allow everything". If you see one and did not ask Claude to do that, deny it. It only recognises the obvious forms and can be sidestepped on purpose, so do not treat it as insurance for "Allow everything".

- Approval cards appear under the tool that needs them, and a bar above the input box keeps them in view. Allow, always allow, or deny with an optional reason. Approving a request never loosens the mode; change that in Settings.
- If Claude enters plan mode by itself while "Allow everything" is on, tap "Approve, keep current mode" on the plan card: that turn goes back to your previous mode and the global setting stays as it was.
- In the background you are notified when a turn ends or needs you. Notifications can only deny; to allow, come back and read the full command.
- Swiping cccodroid away in Recents closes it: if nothing is running, the gateway stops, the ongoing notification goes away and it won't restart itself; a running turn keeps going and the gateway stops after it finishes. Scheduled tasks are still woken by a system alarm when they're due.
- Keys stay in the app's private directory. Account sign-in is handled by Claude Code itself; the app never touches your credentials.

## Projects and scheduled tasks

A **project** is a working folder with its own instructions (CLAUDE.md) and default model, effort and permissions. Conversations started in a project run in that folder and pick up its instructions automatically.

- Sidebar → Projects → New project: create a folder in the workspace, use an existing folder, or clone from git. With an existing folder, conversations you started there before are added automatically.
- The welcome screen of a new conversation lets you pick a project; a project tag then appears under the input box.
- Long-press an existing conversation (or tap ⋯) and choose Move to project; its record moves along.
- The filter bar on the Chats page can show one project, or only conversations created by scheduled tasks (marked with a clock).

A **scheduled task** runs Claude once on this device at the set time. Nobody is there to ask, so anything that needs your approval is denied. Start with read-only for a few days before giving it more.

- Daily, weekly, monthly, every few hours, once, or a cron expression. The form shows the next two run times as you edit.
- For "don't bother me unless something's up": have it reply with one fixed phrase when nothing is found (e.g. "All green") and set notifications to Only when something is found.
- You can limit runs to Wi-Fi or charging, cap cost and duration per run, and set a daily total. Most third-party APIs don't report cost, so cost caps don't apply to them.
- The timer lives in the gateway: tasks run on time while the app is open or in the background. If the system kills it or the device is off, the run is missed and handled by the task's If missed setting next time you open the app; it's never made up silently.

## Lineage

The Lineage page in the sidebar draws all your sessions as a subway map: time runs left to right, each line is a session, grouped into bands by project. In portrait it becomes an indented tree. On your first visit, tap "How to read" at the top right. The two-minute tour uses sample data and never touches your sessions.

- **Stations and archive numbers.** Each compaction ends a chapter and adds a station to the line. "a1b2·3" is an archive number: the first four characters of the session ID · the chapter. Tap a station to jump to the start of that chapter.
- **Where titles come from.** The model in the chat titles each chapter itself, from what was actually done in it rather than your first message; the session list shows the latest chapter's title. For a new chat, the app writes a title in the background right after the first reply, and it shows up a few seconds later. Choose the model for this, or turn it off, under Auto-title in Settings → Provider & model. To rename a chat, just ask the model, or long-press it in the list and rename it yourself; a name you set is never overwritten.
- **Where a line comes from.** A line branching off another midway is a fork. One that turns back at the branch point is a rewind. One that flows in with an arrow is a merge. Old chapters without a title show their first prompt in gray; "Backfill titles" in the toolbar names them all at once.
- **Merging.** When several sessions each got halfway and you want to carry on in one new session: select a line, tap "Merge…" on its card, check the other sessions, then tap "Next". The wizard has three steps: for each source, choose its compaction summary or a few hand-picked turns; write one line about what comes next; preview the first message (you can edit it). Once sent, a line flows into the new session from each source.
- **Add sources, fork from here.** Under "More…" on the card: sessions where you once pasted a hand-off by hand have no inferable source, so link them with "Add sources…", and undo if you got it wrong. "Fork from here" branches a new session from this session's latest turn.
- **Archive references.** Write "see a1b2·3" in a message and the compaction summary from the end of that chapter is attached for Claude (it doesn't show in your bubble). Up to three per message. If that chapter is still open and has no summary yet, Claude is told where the session file is so it can read it if needed.
- **Drill down.** "Drill down" on the card lays a session out turn by turn: when each turn ran, how many tool calls it made, how many subagents it sent, how many errors. Sessions forked off a turn hang under it; tap one to drill into it. Tap a turn to see every tool call (the light part is thinking before the call, the dark part is the tool running) and how long each subagent ran, with nested subagents indented. The back button steps out one level at a time.
- **Export.** "Export" in the toolbar saves the current map as an image (PNG), a vector file (SVG), or a single-file web page you can pan and tap (HTML), then lets you save it elsewhere or share it.

## Files, terminal, browser

- **Files and viewer**: edit and save code in place; if the file changed on disk, you are asked before saving. Markdown, images, PDF and HTML preview directly, and HTML reloads when it changes. UTF-16 and GBK files open read-only so they don't get corrupted on save. Word and Excel open as is; PPT and old .doc need LibreOffice, installed on first use.
- **Terminal**: multiple tabs, plus a row of Esc, Tab, Ctrl and arrow keys. It keeps running when the panel is closed.
- **Browser**: type `127.0.0.1:port` to open a local server. ↗ hands the page to the system browser; sign-in pages always open there.

## Large screens and split screen

Layout follows the window width, not orientation:

- Narrow: one column; files, terminal and browser cover the screen.
- Wide (≥ 840): chat plus a workspace on the right; drag the divider, double-tap to reset.
- Wider (≥ 1000): the sidebar stays docked on the left, and its edge can be dragged too.

## Third-party endpoints

First check which protocol the endpoint speaks; the setup differs:

- **Anthropic protocol** (the address usually ends in `/anthropic`, or the provider says it is for Claude Code): Settings → Provider & model → "＋ Add a custom endpoint…", then fill in the address, key and default model name. **You can leave the model list URL empty**: the app then looks for `/v1/models` and `/models` on the same host as the API address, and if it finds a list you can pick models from it. If the provider doesn't publish a list, typing the model name still works.
- **OpenAI protocol** (only `/v1/chat/completions`): Extensions → Optional components → install "OpenAI API local protocol bridge", then tap "Config". The bridge translates between the two protocols on the device; the model still runs remotely, on your own key and quota.
  - **Several APIs are supported**: each API has its own address, key, models (tick the option to read the model list automatically to pick from suggestions) and context window, and you choose one default model across all of them. Saving shows which services your conversations will be sent to and only takes effect after you confirm. Saved keys are never shown again; leave the key empty when changing other fields to keep it.
  - `https://api.example.com` or `…/v1` is completed to `/v1` automatically; if the provider uses a custom path, enter the full `…/chat/completions` address it gives you. Services that only offer `/v1/responses` won't work.
  - After saving, "Local bridge ready" with "Model inference has not been tested" is normal: tap "Use in a new session" and send a short message. Only a real reply proves it works. Saving does not switch your current conversation.
- **Context window**: enter what the provider really supports for this model (`256k`, `1m` or an integer), or leave it empty for 200k. A larger number doesn't make the model bigger; it only makes compaction come too late.
- **No response from upstream**: custom endpoints wait 90 seconds for response headers and retry 3 times, so a stalled upstream shows retries under the bubble instead of hanging at "Connecting". To change it, set `API_TIMEOUT_MS` in the endpoint's `extraEnv`.
- 401 usually means the key belongs to another provider or has stray spaces; 429 is rate limiting or quota. If text works but images or tools fail, the model itself probably doesn't support them; narrow it down in a new text-only conversation.

## Extensions

- **Toolkit modules**: install and remove as needed; each shows what it is for, its size and what uses it. Typing a missing command in the terminal tells you which module has it.
- **Components**: large tools such as Chromium, Blender, Godot, LibreOffice, llama.cpp and GPU drivers, installed when you need them. Signatures are checked first, and each component ships a skill so Claude knows how to use it.
- **Saved prompts**: create one under Saved prompts on the Extensions page: give it a name (say, issue) and write what should be sent to Claude. Then type `/issue your details` in the input box, and the text after the name fills `$ARGUMENTS`. A prompt can be for all projects or just the current one. They're stored as standard Claude Code command files, so claude in the terminal can use them too.
- **Plugins, skills, MCP**: add and manage them on the Extensions page; changes apply from the next message. More → Capabilities shows everything Claude can use this turn.
- **pkg**: in the terminal, `pkg install rust` installs packages from the Termux repository; `pkg verified` lists the ones tested on device.

## Shizuku and system permissions

- Settings → Device & permissions → Install and activate. It activates over wireless debugging with no computer, and reactivates itself after a reboot. If you already have **Sui** (a Magisk / KernelSU module), grant cccodroid in Sui and you're done; no Shizuku app needed.
- Once active, the terminal and Claude can run `priv '<command>'` as the shell user; every call is kept in the Privileged command log.
- **Privileged commands need your OK.** Only read-only commands such as `dumpsys <service>`, `pm list` and `settings get` run straight away. Anything else shows a dialog in cccodroid with the exact command, and runs only if you allow it. If cccodroid isn't in the foreground, or another command is already waiting, it is refused, so a task left running in the background stops at its first privileged command. Ways to loosen this, from narrowest to widest:
  - "Allow, and don't ask again for this command for 10 minutes": only for that exact command.
  - Tick "Allow all later privileged commands in this session" before allowing: that session won't be asked again and can keep going in the background. It resets when the app restarts and never applies to scheduled tasks.
  - Settings → Device & permissions → "Stop confirming privileged commands one by one (at your own risk)": every privileged command runs directly. Turning it on shows a disclaimer: damage caused by a wrong command, a model's mistake or an injected script is your own responsibility.
  - Whichever you choose, commands that touch cccodroid itself or Shizuku / Sui are caught and confirmed where possible, but not every form can be caught (for example, one hidden in a script file).
- **Device tools** (off by default): let Claude post notifications, use the clipboard and share files. Reading and tapping the screen needs accessibility, which can switch on only while in use.
- **Memory manager** (off by default): stops background apps outside your allow list before heavy jobs. In the terminal, use `cc-mem run -- <command>`.

## Updates and repair

- **Auto-update** (on by default): Claude Code updates silently; a new app version is signature-checked, then offered for install; toolkit updates download on Wi‑Fi and are applied the next time you open the app.
- The toolkit can come from GitHub, the cccodroid.net mirror or a local file. If one source stalls, the other takes over and resumes; everything is checked against hashes shipped in the APK.
- Updates are verified against the release manifest before anything is replaced. If one is interrupted, it finishes or rolls back on the next launch.
- The Repair ledger under Settings → Troubleshooting records every install, check and repair.
- **Two install packages**: the usual `cccodroid.apk` targets SDK 28 and runs on the widest range of devices; `cccodroid-36.apk` targets SDK 36 for newer phones whose system refuses apps with an old target SDK. Both have the same features and share data, and you can switch at any time under Settings → Updates → Install package. If the system ever refuses the 28 build, the app remembers it and only updates to 36 from then on; choosing 28 is then blocked. In the 36 build, toolkit programs are started through the system loader, so the odd program that locates its data relative to its own path may misbehave — please report it if you hit one.

## Known issues

- Fixed · All · **Pinyin input not reaching the box on first launch**: fixed in 0.3.7. On older versions, tap outside the input box and back.
- Workaround · All · **Nothing scrolls anywhere**: a bug in the system WebView. The app detects it and recovers in about a second, restoring unsent text; if it does not, press and hold the title in the top bar (the conversation name) for about a second; the title fades, the phone gives a short buzz and recovery starts.
- Workaround · Red Magic / Nubia · **Frozen after about 90 s in the background**: App info → Battery usage → allow background activity, and allow auto-start.
- Workaround · Xiaomi / OPPO / vivo / Huawei · **Aggressive background cleaning**: set battery saving to unrestricted, allow auto-start and lock the card in recents. Per-brand steps are on the website's Known issues page.
- Workaround · ZUI · **"Split screen not supported"**: the system's split-screen blocklist is stale. Reinstall over the top or reboot.
- Investigating · All · **Top bar shows "UI script error: Script error."**: when code the Android shell runs in the page fails, WebView only gives this line, so you can't tell where it came from. From 0.3.13 it reads "<entry point>: <reason>", so a screenshot is enough to track it down. The app usually keeps working.
- Investigating · Samsung · **Stuck on "Waiting for gateway…" after launch**: reported once; the gateway was actually running and the app opened after two to three minutes. The cause is still being looked into. Wait a little longer instead of swiping the app away and reopening it; once it opens, send a diagnostics bundle from Settings → Troubleshooting.
- Investigating · Red Magic · **New conversations fail with "Failed to fetch" after reopening the app**: the gateway connection is lost and comes back after rebooting the phone. Still being investigated; if it happens, send a diagnostics bundle from Settings → Troubleshooting.
- Investigating · Non-Snapdragon · **GPU components unavailable**: most need Snapdragon. Mali GPUs such as MediaTek can use gpu-driver-mali; Exynos and Kirin are not supported yet.

## Troubleshooting

Start with Settings → Troubleshooting → Check records, then the Repair ledger. If that does not help, send a Diagnostics bundle to whoever is helping you, or use Report on GitHub: the device, system and self-test results are filled in, and keys and your messages are left out.

If a hook, plugin or CLAUDE.md breaks things, turn on **Safe mode** under Settings → Claude behavior. Nothing custom is loaded until you turn it off again.

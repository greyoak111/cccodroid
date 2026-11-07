# Known issues and unresolved risks

[中文](known-issues.zh-CN.md)

These are problems whose root cause we have **not found and cannot fully rule out**. You are unlikely to hit them in normal use, but we would rather not hide them. If you do, tap **Settings → Troubleshooting → Report on GitHub** in the app (device, Android version and self-test results are filled in) and say what you were doing; attach the zip from **I'm stuck · bundle diagnostics** if logs are needed. Problems tied to a particular phone or vendor system are covered in section 6 below.

## 1. ~~The keyboard stops typing into the message box (the mystery mobile bug)~~ Fixed in 0.3.7

- **Symptom**: right after opening the app, you tap the message box, the keyboard comes up with suggestions, but picking one puts nothing in the box. English works, and split screen or switching apps clears it.
- **Cause** (found on 2026-10-21 by recording what passes between the keyboard and the page): as soon as the page loads, the new session puts focus in the message box from script. The keyboard isn't up then, so WebView doesn't create an input connection for the box, and the keyboard keeps the empty connection it got when the page first appeared. Tapping the box later doesn't change focus, so WebView only brings up the keyboard and keeps that connection, and everything you pick goes into it. Split screen or switching apps takes window focus away and back, which rebuilds the connection.
- **Fix**: after a tap, if focus is in an editable field but the keyboard still holds an empty connection, the app has it reconnect.
- If you still hit it, please report it as described at the top.

## 2. Touch scrolling freezes everywhere (patched; root cause is in WebView, not fixed)

- **Symptom**: nothing scrolls by touch any more: not the chat, not the sidebar, not any pane. Buttons and typing still work. It does not recover on its own.
- **When it happens**: it recurred during normal use of the development build with a real finger, so it is not a test artefact. Release builds use the same system WebView and can hit it too.
- **What we found**:
  - While frozen, touch events still reach the page, and the page does not block them (no `preventDefault`, no `touch-action`); no scroll comes out. Scrolling by script or with a mouse wheel still works.
  - Reloading the page does not help, nor does leaving the app and coming back. **Making the WebView load another site and then come back fixes it at once.**
  - So what gets stuck is WebView's own gesture state for this page, not our page code. Whether something we do happens to trigger it is still unknown.
- **Patch since 0.2.0**:
  - **Automatic**: after two drags in a row where the finger moves vertically, the area under it could scroll that way, and it does not move, the app sends the interface to another site and back. It takes about a second. A reply in progress keeps running in the gateway, and unsent text in the message box is put back. This happens at most once a minute.
  - **Manual**: press and hold the title in the top bar (the conversation name) for about a second; it does the same thing. Use it when the automatic one does not kick in. (Up to 0.3.18 this was the snowflake button, ❄.)
  - This works around the problem; it does not fix it.
- **Diagnostics**: each unfreeze stores the recent touch log in page storage (`localStorage` key `cc.freezeLog`, last 5 times). For now only the development build can read it.
- **Earlier approach** (0.1.19 to 0.2.0-rc1): when a drag did not scroll, a script took over the scrolling. In testing it did not help and sometimes made things worse, so it is gone.

## 3. Foldables (experimental)

Since 0.4.18 the layout follows the fold (see "Foldables" in [large-screen.md](large-screen.md)). It has only been tested on the Android emulator, so real devices may differ. Please report in [#19](https://github.com/greyoak111/cccodroid/issues/19). You can turn it off in Settings → Appearance.

## 4. A brief grey scrim when not launched from the home screen

When the app is cold-started without the launcher icon animation (adb, a notification, another app), Android 12+ first draws a system splash screen. Since 0.2.0-rc1 it uses the setup screen colour and no icon, but on a Red Magic 9 Pro a translucent grey scrim still covers the page for about half a second as the window opens. It is probably the ROM's own window animation; not confirmed. Launching from the home screen icon does not show it.

## 5. The top bar sometimes shows "UI script error: Script error." (investigating)

- **Symptom**: the subtitle in the top bar turns into "UI script error: Script error." with no file name and no reason. The app usually keeps working.
- **Why that is all it says**: the Android shell calls into the page in a few places: the back key, the callback after saving a file, the system switching between light and dark, opening a session from a notification, and content shared in from other apps. When an error escapes from code injected this way, WebView hides the details for security reasons and leaves only this line, so on its own it doesn't tell you where it came from.
- **What we found** (2026-10-22): we exercised each of these entry points in a test shell, and none of them produces it in 0.3.13. We caught one real bug: sharing text in from another app inserted the text but also reported "t is not a function"; that is fixed. The screenshot we got most likely came from a regression during the redesign a few days earlier that has since been fixed, but we can't replay it to be sure.
- **From 0.3.13**: every piece of code the shell injects catches its own errors, so the top bar now reads "UI script error: <entry point>: <reason>", e.g. "__ccBack: …". If you still see it, the entry point in a screenshot is enough to track it down; please report it as described at the top.

## 6. Phone makers and chips (only two devices tested)

Only two devices have been tested by hand: a **Lenovo TB320FC** (ZUXOS, Android 15, Snapdragon 8+ Gen 1) and a **RedMagic NX769J** (ZTE-based system, Android 14, Snapdragon). The settings paths for other brands below come from public sources and common practice and have **not been verified**; menu names vary between system versions. [dontkillmyapp.com](https://dontkillmyapp.com) has more detailed steps per brand.

If something breaks on your device, go to **Settings → Troubleshooting → Report on GitHub**. Your device, Android version and self-test results are filled in for you; you only describe what went wrong. No GitHub account? Use **I'm stuck · bundle diagnostics** next to it.

If everything works, please tell us too: open a GitHub issue with the [Device report](https://github.com/greyoak111/cccodroid/issues/new?template=device.yml) template, or post in [Discussions](https://github.com/greyoak111/cccodroid/discussions). The more devices are tested, the more reliable this section becomes.

### On every device

- **Android version**: the minimum is Android 8.0; 14, 15 and 16 have actually been tested.
- **Background**: the app keeps a foreground service running (the notification), which is enough for stock Android's background limits. **It does not stop vendors' own freezers and cleaners.** While frozen, the gateway and any running task stop completely and resume when you come back. If the app notices it was frozen, Settings shows a notice with the steps for your brand.
- **Most GPU components are Snapdragon-only**: the two Snapdragon GPU drivers, GPU benchmarks and clvk need Qualcomm Adreno's `/dev/kgsl-3d0`. Since 0.3.3, devices with a Mali GPU (MediaTek Dimensity and others) can install `gpu-driver-mali`, which uses the vendor's own Vulkan driver; it has been tested on a Redmi K70 Ultra and a vivo V2502A ([#14](https://github.com/greyoak111/cccodroid/issues/14)). On Samsung Exynos and Huawei Kirin devices the extensions page marks them "Snapdragon only" and they can't be installed. Components that can use the GPU, like Blender and llama.cpp, still install where no matching driver exists and fall back to the CPU, just slower. Reports from people with those devices help a lot.

### Lenovo (ZUI / ZUXOS) · tested

The main development device; every feature has been tested on it. No vendor freezing seen.

### RedMagic / Nubia / ZTE · tested

- **The system freezes the whole app after about 90 seconds in the background**, regardless of the foreground service or the battery whitelist. Fix: App info → App battery usage → Battery optimization → **Background running: Allow**.
- Set **Auto-launch** on the same page to Allow as well. When it is "Automatic", the system blocks recovery after updates and starting Shizuku at boot.
- From Android 12 on, system settings pages hide third-party overlays, so the Shizuku wireless pairing code is entered from the notification.
- A half-second grey overlay sometimes appears on cold start when not launched from the home screen; see item 4.

### Xiaomi / Redmi (HyperOS / MIUI) · not tested

Known for aggressive background killing. App info → **Battery saver: No restrictions**, turn **Autostart** on, and lock the cccodroid card in the recents screen so "clear all" doesn't kill it.

### OPPO / OnePlus / realme (ColorOS / OxygenOS / realme UI) · tested

On a OnePlus Ace 5 (ColorOS 16, Android 16), first install with the devkit download, chatting, the terminal, optional components, and split screen / landscape all work ([#61](https://github.com/greyoak111/cccodroid/issues/61)).

On a OnePlus Ace 7 Pro (PMS110, OPlus ROM 17, Android 17), chatting, the terminal, Shizuku, device tools and short stretches in the background all work, and 20 of 23 optional components work (community device report, 2026-11-04). The two that don't are `gpu-driver-glibc` and `clvk-glibc`: the glibc-side Turnip doesn't know the Adreno 840 yet, while the bionic-side `gpu-driver` works. Long stretches in the background and split screen / landscape haven't been tested.

- **The app gets killed in the background sooner or later.** That comes from ColorOS scheduling, and the foreground service can't stop it. The Ace 5 reporter keeps it alive with a third-party keep-alive module.
- Still worth doing: App info → Battery usage → **Allow background activity** and **Allow auto launch**, and lock the recents card.

### vivo / iQOO (OriginOS / Funtouch OS) · not tested

Settings → Battery → Background power consumption management → cccodroid: **Allow high background power consumption**. Allow **Autostart** in i Manager.

### Huawei / Honor (HarmonyOS / MagicOS) · not tested

Settings → App launch → cccodroid: turn off "Manage automatically" and allow **Auto-launch**, **Secondary launch** and **Run in background** by hand. HarmonyOS NEXT can't install Android apps at all.

### Samsung (One UI) · not tested

App info → Battery → **Unrestricted**, and in Settings → Battery → Background usage limits, add cccodroid to "Never sleeping apps". Models sold in the US and China are mostly Snapdragon; many others use Exynos, which can't use the GPU components.

### Google Pixel and near-stock systems · not tested

Background rules follow stock Android, so the foreground service is enough. Tensor G1–G4 use a Mali GPU, so `gpu-driver-mali` should work, but nobody has tested it yet; the other GPU components don't work.

## 7. Some third-party API setups can't see attached images, and the model makes things up

Normally an attached image goes in like this: the message ends with an `@path`, Claude Code reads the file back with the Read tool, and the image lands inside a *tool result*. The official API and every vendor's official Anthropic endpoint handle that.

Some third-party API setups translate Anthropic requests to the OpenAI format and don't map images inside tool results: they either drop the image (the model says it received no image) or pass the base64 along as plain text, so the model reads gibberish and confidently describes a picture that has nothing to do with yours. A handy check from a community report: look at the input tokens for that turn. One image is normally a few hundred to about a thousand tokens; around 200 means the image was dropped; tens of thousands means it was sent as text.

**Workaround:** from 0.5.8 the custom provider card has "Send images inside the message (compatibility)". With it on, each attached image is also put directly in the user message (a spot every setup handles); the `@path` route still works alongside it. Large images are shrunk to 1568 px on the long edge first; large images in mid-turn follow-ups are not shrunk and only go through Read. You don't need it with Anthropic or a provider's own API.

## 8. Stuck on "Waiting for gateway…" after launch (investigating)

One user hit this on a Samsung tablet (One UI, Android 16): the launch screen stayed on "Waiting for gateway…" for two to three minutes before the app opened. The diagnostics showed the gateway starting normally every time, with no errors. The phone happened to be offline at the time, and the root cause isn't known yet.

Another case has been tracked down: on some phones (where the app directory path goes through a system link, such as Honor MagicOS on Android 17), 0.6.8's gateway exited right after every start, and the notification kept saying "Gateway exited; restarting in 8s". Fixed in 0.6.9.

**Workaround:** update to the latest version first. If it gets stuck there, give it a minute or two instead of swiping the app away and reopening it, since every restart begins the wait from scratch. Once it opens, send a diagnostics bundle from Settings → Troubleshooting.

## 9. The chat area occasionally goes blank and won't scroll (investigating)

One user hit this on a Xiaomi phone (HyperOS, Android 16): after a cold start they opened a long chat, and while the top bar and input box were there, the message area stayed blank and didn't respond to a dozen or more swipes; the only way out was to swipe the app away and reopen it. The diagnostics showed the gateway running normally, no UI errors, and no automatic unfreeze (each swipe was short). The trigger isn't known yet; it may be the same kind of WebView problem as item 2.

**Workaround:** first long-press the title in the top bar for about 0.6 s (unfreeze), or switch to another chat and back. If neither helps, reopen the app, send a diagnostics bundle from Settings → Troubleshooting, and tell us what you were doing right before (just launched the app, just opened that chat, or came back from the background).

## 10. In-app update fails with "Error · Couldn't read the signature" (not fixed)

On one user's phone every in-app update stops here. Before installing, the app checks that the downloaded APK is signed with the same release key, reading the signature through a system API. On that phone the API returns nothing, so the install is refused. The APKs themselves are fine (each was checked; the signature matches every earlier release); the phone's system API just can't read it.

**Workaround:** download the APK from the GitHub Release or the website and install it over the current one. Your data isn't affected.

## For developers: tests can create fake bugs

Item 1 is tied to automated testing (item 2 has been confirmed not to be). Before fixing a problem like this, make sure it **also happens with no tests running**:

- Events injected with `input swipe` / `input tap` get cancelled by some ROMs' gesture listeners, sometimes with an extra tap added.
- Screenshots, simulated secondary displays, launching other windows and switching keyboards with `ime set` can all take input focus or the keyboard connection away from the app.
- For drag, scroll and keyboard problems, trust results from a real finger and a real keyboard.
- Under full load, the full test run (`node scripts/test.mjs`) occasionally fails once in `merge.test.mjs` ("记录与兜底"). It passes reliably when run alone; it's a timing issue that hasn't been fixed yet. If it's the only failure, rerun it on its own to confirm.

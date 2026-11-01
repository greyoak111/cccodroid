# Permissions

English | [中文](permissions.zh-CN.md)

cccodroid asks for a fair number of permissions. This page explains what each one is for, when you're asked, and what happens if you say no.

The most important point first: **inside cccodroid, Claude can run any command as this app.** That's what the app is for. Whatever the app is allowed to do, the commands Claude runs can do too. Keep that in mind when deciding what to grant.

## At a glance

| Permission | What it's for | When you're asked | If you say no |
|---|---|---|---|
| Network (`INTERNET`, `ACCESS_NETWORK_STATE`) | Talking to the model API, downloading Claude Code and the toolkit; checking whether you're on Wi-Fi (the scheduled-task "Wi-Fi only" condition) | Never; granted on install | The app can't work |
| Storage (`READ/WRITE_EXTERNAL_STORAGE`; the targetSdk 36 build also needs "All files access", `MANAGE_EXTERNAL_STORAGE`) | Reading and writing `/sdcard/cccodroid`: APKs handed to other apps, screenshots, offline toolkits; also lets Claude work on files you keep in shared storage | The 28 build asks on first launch; the 36 build asks once and takes you to system settings | Works, but output stays in the app's private folder where other apps can't see it |
| Notifications (`POST_NOTIFICATIONS`) | Telling you a background run finished, scheduled-task results, actions waiting for approval | First launch | Works, but no alerts while the app is in the background |
| Foreground service, wake lock (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`) | Keeping the gateway alive so a run finishes after you switch away or lock the screen | Never | Can't be refused; without it the network drops a few seconds after leaving the app |
| Ignore battery optimizations (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) | Stopping power saving from freezing long background jobs | When you tap "Background running" in settings | Long jobs and scheduled tasks may be stopped after the screen locks |
| Exact alarms, boot broadcast (`SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`) | Waking the gateway for scheduled tasks; re-activating Shizuku after a reboot (only if you have paired and turned auto-activation on in settings; it's off by default) | Never | Scheduled tasks may run a little late; Shizuku needs manual activation after reboot |
| Install apps (`REQUEST_INSTALL_PACKAGES`) | In-app updates; installing APKs Claude built on the device | The first time, the system asks you to allow it in settings | You update by downloading the APK yourself |
| Set alarm (`SET_ALARM`) | The device tool "set an alarm for me", handed to the system clock app | Never | The device tool can't set alarms |
| Full-screen notification (`USE_FULL_SCREEN_INTENT`) | Keeping the Shizuku pairing notification (with its input box) pinned at the top of the screen | Never | The pairing notification may collapse; pull down the shade to find it |
| Shizuku (`moe.shizuku.manager.permission.API_V23`) | Optional. Gets the shell identity (uid 2000) for installs without prompts, granting itself all-files access, and device tools | When you turn it on in settings | Those features don't work; everything else does |
| Write secure settings (`WRITE_SECURE_SETTINGS`) | Only grantable through Shizuku. Used to turn wireless debugging back on after a reboot and re-activate Shizuku, and to switch cccodroid's own accessibility service on and off as needed | Granted along with Shizuku | Shizuku needs manual activation after each reboot; accessibility must be turned on in system settings |

## Not requested

Camera, microphone, location, contacts, SMS and call logs are not requested.

Taking a photo (the camera option in the composer's "+" menu) hands off to the system camera app, so no camera permission is needed.

## The three heavy ones

**All files access.** Once granted, the app — and Claude — can read and write all of shared storage, not just `/sdcard/cccodroid`. If your photos and documents live there, commands Claude runs can reach them too. If you don't want that, leave it off and stick to the private folder.

**Shizuku and write secure settings.** This is the shell identity, which can do far more than a normal app, such as installing and removing apps or changing system settings. Everything cccodroid does with it is logged in the Privileged command log, in the Shizuku section of settings. Device tools (letting Claude take screenshots, tap the screen, toggle system settings) and the accessibility service are **off by default** and only turn on when you enable them; accessibility switches itself off after a period of inactivity.

Two things to keep in mind. First, the grant goes to the cccodroid app as a whole, not to one button: any code running inside the app — commands Claude runs, components you install — can reach the shell identity through it, and auto-activation on boot keeps that access alive across restarts. Turning on Shizuku means trusting everything that runs in cccodroid. So that quiet use at least gets noticed, only read-only commands such as dumpsys with a service name, pm list and settings get, plus the app-stopping and background-restriction commands the memory manager uses (am force-stop / stop-app / set-bg-restriction-level), run straight through `priv`; anything else (installing or removing apps, changing settings, screenshots, simulated taps, reading the system-wide log with logcat, reading files in shared storage and so on) first asks you in cccodroid, and is refused when cccodroid isn't in the foreground. It's a speed bump, not a wall. When you no longer need it, revoke the grant in Shizuku (auto-activation is off by default; if you turned it on, turn it off too). Second, the privileged command log lives in the app's own folder. It's there for you to review, not a tamper-proof audit trail: code running in the app could edit it.

**Install apps.** The system shows a confirmation page every time, and nothing installs until you tap it. With Shizuku, installs can skip the prompt; those are logged in the privileged command log as well.

## Found a security problem?

See [SECURITY.md](../SECURITY.md) and report it privately, not in public.

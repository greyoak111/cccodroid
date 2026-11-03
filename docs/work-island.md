# Work Island (optional integration)

Mirror Claude's live work status in cccodroid onto the **ColorOS 16 fluid cloud / dynamic island**.

- Working: **Working** + the current action (running a command / thinking / waiting for approval…)
- Done: **Done** + elapsed time
- After 8 s: the capsule collapses; a quiet notification stays in the shade.

This is an **optional third-party integration**: cccodroid only sends the status out; it does not
include or take responsibility for the Work Island app itself.

---

## Status

> **Pre-release / Alpha**
> Tested only on **OnePlus PJA110 · ColorOS 16.0.3 · Android 16 (SDK 36)**.
> Other ColorOS versions and other OEMs are untested; interfaces and file layout may change.
> Not recommended for production or critical tasks.

---

## Components

| Part | Location | Role |
|---|---|---|
| Core | `gateway/gw/work-island-core.mjs` | Events → text, throttling, finish detection (pure, unit-tested) |
| Gateway wiring | `gateway/gw/work-island.mjs` | Off by default; when enabled, detects the app, subscribes, calls `am` |
| Bus hook | `gateway/gw/bus.mjs` | `onPublish(fn)`: in-process subscription, no HTTP, no token |
| Setting | `gateway/gw/settings.mjs` | `workIsland: false`, settings checkbox |
| Renderer | [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android) | Android 16 Live Update + foreground service |

The gateway side uses Node built-ins only — no npm dependency, no build step.

---

## Enable

1. Install the Work Island app ([releases](https://github.com/STUTTEFRFIX/WorkIsland-Android/releases))
   and open it once: notifications on / live updates allowed / battery unrestricted.
   - 1.1+ supports English done/idle text; earlier versions only have Chinese done/idle.
2. cccodroid Settings → **工作岛（ColorOS 灵动岛）** → enable.
3. The gateway log shows:

   ```
   [work-island] 已订阅网关事件
   ```

4. Send a message and watch the island.

## Disable

- Turn the setting off: the gateway unsubscribes and sends one IDLE to collapse the island.
- `CCAPP_WORK_ISLAND=0` forces it off; `=1` skips the install check and forces it on.
- Use `WORK_ISLAND_PKG=your.package` for a different package name.

---

## Design notes

1. **No separate process.**
   The gateway subscribes to `onPublish` in-process and owns the timers. Stopping the gateway
   stops the subscription and timers together, so no orphan process. On SIGTERM it sends a
   synchronous IDLE so the island collapses.
2. **Off by default.**
   Anyone could install an app with the same package name, so the user must enable it explicitly.
3. **Updates throttled to 1.5 s.**
   Tool-heavy turns can emit many `phase`/`tool_use` events per second. Only the last state is
   kept and flushed after the window, avoiding a cold `app_process` for every `am` call.
4. **Errors carry no content.**
   `error.message` may contain paths or command output; the island only shows “Error”.
5. **Finish detection uses `runs`.**
   If another run is still active at `run_end`, nothing is reported. Otherwise a 3 s grace
   window lets a new run cancel the completion. `run_end` is published after the run is removed
   from `RUNS`, so `runList()` is authoritative — no HTTP re-check, no polling.
6. **Text follows the UI language.**
   `LAST_LANG` starting with `zh` uses Chinese; otherwise English. More languages later.
7. **List progress.**
   `TodoWrite` / `tasks` done/total counts are passed as the optional `todoDone` /
   `todoTotal` `--ei` extras. Work Island 1.5+ uses them for the segmented progress bar;
   when absent the app treats the run as having no list.

---

## Tests

```bash
node scripts/test.mjs work-island
```

Covers state mapping, done + idle, turn boundaries, grace cancellation, abort, approval,
error redaction, English, 1.5 s throttling, IDLE on disable, and the list-progress extras.

## Known limits

- Force-stopping cccodroid skips the final IDLE; reopen cccodroid to recover.
- Other ColorOS versions and OEM dynamic-island implementations are untested.
- The app's notification service is exported; another app can spoof the displayed state.
- The system-island capsule is drawn by the OS; no OPPO UPK custom card. Work Island 1.5+
  also has an app-drawn fallback capsule for devices without an island (semi-transparent,
  touch-through, adjustable size/position with an in-app preview).
- The APK in the Work Island repo is test-signed.

---

## Links

- Work Island: https://github.com/STUTTEFRFIX/WorkIsland-Android
- Design: https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/01-方案与设计.md
- Test report: https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/03-测试报告.md

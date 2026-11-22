# Work Island (Live Status)

Displays Claude's live work status directly from cccodroid using **Android 16+ Live Updates (dynamic island / live capsule)**, with an optional **floating overlay capsule** fallback.

- **Working**: live action label (Thinking / Reading / Running / Updating list / Waiting for you…), live elapsed timer, and TodoWrite segmented progress.
- **Done**: shows "Done" + elapsed time, then collapses automatically after 8 s.
- **Tap to return**: jumps straight back to the active session.

---

## Built-in Three-Tier Architecture (Universal, No Companion App)

| Tier | Target OS | Implementation | Notes |
|---|---|---|---|
| **1. System Live Updates / Island** | **Android 16+ (API ≥ 36)** (Honor MagicOS 10/11 Magic Capsule, ColorOS 16 Fluid Cloud, HyperOS 3+ Super Island, Pixel / OneUI, etc.) | Standard `POST_PROMOTED_NOTIFICATIONS` + `Notification.ProgressStyle` + `setRequestPromotedOngoing(true)` + `setShortCriticalText` | Zero OEM whitelist or private protocol; Settings includes a one-tap shortcut to system Live Updates permission |
| **2. Floating Capsule Fallback (optional, off by default)** | Any Android version (ideal for Android 12–15 or OEMs that do not promote Live Updates) | `TYPE_APPLICATION_OVERLAY` pill (`WorkIslandOverlay.java`) | 100% touch-through (`FLAG_NOT_TOUCHABLE` + alpha capped for Android 12+ touch-obscuring rules); auto-hides in foreground, on lockscreen, or screen off |
| **3. Same-Card Progress Notification** | All Android versions | Silent ongoing progress notification | Zero extra permissions |

> Legacy companion-app (`com.dafeiyu.workisland`) `am` transport remains intact when `CCAPP_BUILTIN_ISLAND` is unset.

---

## Components

| Part | Location | Role |
|---|---|---|
| State machine | `gateway/gw/work-island-core.mjs` | Events → redacted text, 1.5 s throttling, list progress, 3 s finish grace & 8 s idle collapse |
| Gateway wiring | `gateway/gw/work-island.mjs` | Publishes `work_island` frames exclusively to `/api/events?notify=1` in built-in mode |
| Host renderer | `android/java/cc/codroid/WorkIsland.java` | Standard Android 16+ Live Updates (reflection-safe on compileSdk 35), progress notification, 10 s preview |
| Overlay capsule | `android/java/cc/codroid/WorkIslandOverlay.java` | Optional touch-through floating capsule |
| Event bridge | `android/java/cc/codroid/Notify.java`, `Priv.java` | Reuses `/api/events?notify=1` SSE and `/api/app/island_*` control endpoints |

---

## Tests

```bash
node scripts/test.mjs work-island builtin-work-island
sh scripts/java-tests.sh
```

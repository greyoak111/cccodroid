# Privacy & Data Protection

English | [中文](PRIVACY.zh-CN.md)

cccodroid has no user accounts, no backend application server, no cloud chat sync, and zero first-party telemetry or analytics. This document explains what stays on your phone, every outbound network request the app or gateway can make, how to turn each one off, and where to verify the implementation in the source code.

## 1. Zero Telemetry & Local Data Storage

- **No first-party telemetry or proprietary analytics SDKs**: The app collects no usage statistics, generates no persistent install ID (`iid`), uploads no automatic crash reports, and bundles no Google Play Services, ML Kit, Firebase, Sentry, or ad SDKs. All UI scripts and fonts ([`gateway/web/vendor/`](gateway/web/vendor/)) are bundled offline with zero external CDN requests.
- **Upstream CLI telemetry suppressed**: When launching the official Claude Code binary, [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs) (`claudeEnv`) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"` to turn off Claude Code's built-in non-essential telemetry and background auto-updater traffic.
- **Credentials and transcripts stay in private storage**:
  - `android:allowBackup="false"` is set in [`android/AndroidManifest.xml`](android/AndroidManifest.xml); conversations, API keys, and login credentials live under `/data/data/cc.codroid/files/home/` and are excluded from Android cloud backups.
  - API keys are stored in `0600` private files and read via Claude Code's `apiKeyHelper` rather than injected into child process environment variables, preventing accidental `env` dumps into transcripts ([`gateway/gw/claude.mjs`](gateway/gw/claude.mjs)).
  - Official account sign-in sessions connect straight to Anthropic (`ANTHROPIC_BASE_URL` is explicitly deleted so session tokens never pass through the local protocol bridge).
- **Local-only usage & scrubbed diagnostics**:
  - The Usage tab computes counts from local session files only with zero network traffic ([`gateway/gw/usage.mjs`](gateway/gw/usage.mjs)).
  - "Bundle diagnostics" scrubs keys, tokens, email addresses, and user message bodies locally before handing the zip to the system share sheet, and excludes conversation transcripts ([`android/java/cc/codroid/Share.java`](android/java/cc/codroid/Share.java) `bundleLogs`).
  - "Report on GitHub" reads device/ROM properties only when you tap the button to pre-fill a browser URL for your review ([`gateway/gw/feedback.mjs`](gateway/gw/feedback.mjs) `issueDraft`).

## 2. Complete Outbound Network Inventory & Switches

Apart from commands you or your agent explicitly run in chats/terminals, the app and gateway only ever make the following network requests:

| Purpose | Default & Switch | Destinations | What Is Sent | Verification & Source |
|---|---|---|---|---|
| **Model inference & sign-in** | Triggered when you chat or sign in | Your chosen provider (`api.anthropic.com`, `api.deepseek.com`, etc.) or your custom third-party endpoint | Prompts, tool outputs, and the credentials for that endpoint | [`gateway/gw/claude.mjs`](gateway/gw/claude.mjs), [`gateway/gw/providers.mjs`](gateway/gw/providers.mjs), [`gateway/gw/login.mjs`](gateway/gw/login.mjs) |
| **Automatic update checks** | On by default (every 6h); turn off in **Settings → Updates → Automatic updates** | `api.github.com`, `downloads.claude.ai`, `cccodroid.net`, `dl.cccodroid.net`, npm mirrors | Plain HTTPS `GET` (no device fingerprint or account data) | APK signing cert + SHA-256; pinned SHA-256 / `ed25519` for devkit; Anthropic PGP signature for Claude Code ([`android/java/cc/codroid/Updater.java`](android/java/cc/codroid/Updater.java)) |
| **Signed maintainer notices** | On by default (every 3h); turn off in **Settings → Updates → Maintainer notices** | `cccodroid.net/notices.json`, `raw.githubusercontent.com` | Static `GET` with no device parameters (zero requests when switched off) | Verified against pinned `ed25519` public key `.sig` ([`gateway/gw/notices.mjs`](gateway/gw/notices.mjs) `refreshNotices`) |
| **Third-party GitHub proxy (`gh-proxy.com`)** | **Off by default**; used only if you enable **Settings → Updates → GitHub third-party proxy fallback** and official/mirror hosts fail | `gh-proxy.com` (external public proxy) | Your connection IP and target GitHub Release URL | Downloaded bytes are still verified against pinned SHA-256 and signatures ([`android/java/cc/codroid/Installer.java`](android/java/cc/codroid/Installer.java) `ghProxyEnabled`, [`gateway/gw/pget.mjs`](gateway/gw/pget.mjs) `ghProxy`) |
| **On-demand toolkit / component / local model downloads** | First-run setup or when you tap Install in Extensions | GitHub Releases, `dl.cccodroid.net`, Termux & university mirrors, ModelScope / HuggingFace | Standard HTTPS file downloads | Pinned SHA-256, Termux PGP signature, or `ed25519` index signature ([`gateway/gw/components.mjs`](gateway/gw/components.mjs), [`android/assets/bin/pkg.mjs`](android/assets/bin/pkg.mjs)) |

### Mirror servers (`cccodroid.net` / `dl.cccodroid.net`)

These domains serve static release mirrors and signed manifests only (see [`docs/download-sources.md`](docs/download-sources.md)), with no user accounts, analytics endpoints, or relay services, and do not build device profiles. Traffic to `cccodroid.net` traverses Cloudflare's edge network; `dl.cccodroid.net` connects directly to the mirror host. Turning off both **Automatic updates** and **Maintainer notices** stops all background requests to GitHub and these mirrors.

## 3. Android Permission Minimization & Protected-App Guardrails

- **Never requested**: Camera (`CAMERA`), microphone (`RECORD_AUDIO`), coarse/fine/background location (`ACCESS_*_LOCATION`), contacts, SMS, call logs, calendar (`READ_CALENDAR`), app usage stats (`PACKAGE_USAGE_STATS`), notification listener (`NotificationListenerService`), and screen recording projection (`MediaProjection`).
- **Layered guardrails on Device Tools & Accessibility**:
  1. Off by default; enabling requires lock-screen biometric attestation ([`Consent.java`](android/java/cc/codroid/Consent.java)) and a foreground native confirmation dialog ([`DeviceTools.java`](android/java/cc/codroid/DeviceTools.java));
  2. Auto-disables itself via `disableSelf()` after inactivity (10 minutes by default, [`A11y.java`](android/java/cc/codroid/A11y.java) `scheduleIdle`) — never auto-revives behind your back;
  3. Strips `isPassword()` fields and **hard-blocks banking, payment/wallet, 2FA authenticator, password manager, and system permission-controller packages** (`A11y.isProtectedPackage`) from reading, screenshots, and gestures;
  4. Enforces an in-memory `PreToolUse` confirmation hook ([`gateway/guard/cc-guard.mjs`](gateway/guard/cc-guard.mjs)) whenever a command touches credential files, reads/taps the screen, reads the clipboard, or shares files out, even in "Allow all" mode.

## 4. Third-Party Model Providers & Custom Endpoints

Prompts, workspace files, screenshots, or UI trees sent to a model provider (official endpoints or any custom third-party endpoint you configure) are processed under that provider's own privacy policy. Operators of custom third-party endpoints can inspect traffic, keys, and code passing through them — never send sensitive secrets or personal data to untrusted third-party endpoints.

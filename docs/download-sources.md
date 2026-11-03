# Multi-source downloads: maintenance guide

English | [中文](download-sources.zh-CN.md)

cccodroid fetches eight kinds of things from the network, most of them from more than one place. This guide records where each one comes from, why we trust it, where the code lives, and how to check it after a change.

**The rule: trust first, download second.** Every item has a trust anchor that does not depend on where the bytes came from: a hash pinned in the APK, or a signing key pinned in code. A mirror is just another route to the same file and needs no trust of its own. Adding a source never weakens security as long as its content is still checked against the anchor. Conversely, **no change may ever turn something fetched from a mirror into the anchor itself.**

Last verified: 2026-10-20 (v0.2.19).

---

## Overview

| # | What | Sources (in order) | Trust anchor | Code |
|---|---|---|---|---|
| 1 | Devkit (by module from 0.3.9: ~330 MB by default, ~700 MB for all; older apps use the ~650 MB single package) | GitHub Release → dl.cccodroid.net/devkit/ | `devkit-pin.json` shipped in the APK (sha256 of the single-package gz / tar and of `modules.json`, which in turn holds each block's sha256) | `Installer.java`, `Updater.java`, `gateway/gw/modules.mjs` (adding modules later) |
| 2 | APK updates | Release list: GitHub API → cccodroid.net/dl/releases.json → dl.cccodroid.net/dl/releases.json; APK: GitHub Release → cccodroid.net/dl/ → dl.cccodroid.net/dl/ → gh-proxy | Android APK signature (only the same release key can update) + sha256 in the release list | `Updater.java` |
| 3 | Claude Code | Official → npmmirror → Tencent npm → npmjs (last success first) | sha256 from Anthropic's official manifest (manifest checked against Anthropic's PGP signature); npm ECDSA signature when no manifest is reachable | `assets/scripts/install-claude.mjs` |
| 4 | Component index | GitHub Release → cccodroid.net/components/ | ed25519 key pinned in the gateway | `gateway/gw/components.mjs` `compFetchIndex` |
| 5 | Component packages | GitHub Release ⇄ dl.cccodroid.net/components/ (alternating, last success remembered) | sha256 from the signed index, then the in-package MANIFEST after unpacking | `gateway/gw/components.mjs` `compRunInstall` |
| 6 | pkg | Termux official → packages.termux.dev → grimler.se → TUNA/USTC/BFSU/NJU (main, x11) | Termux autobuilds key pinned in pkg, checks `Release.gpg` | `assets/bin/pkg.mjs` |
| 7 | glibc libs for custom components | Termux official glibc repo only | HTTPS + sha256 from `Packages` | `gateway/gw/custom.mjs` `customFetchLibs` |
| 8 | On-device models | ModelScope (official Qwen only) → HuggingFace → hf-mirror.com | sha256 pinned in the catalog (from HF LFS) | `gateway/gw/local.mjs` `LOCAL_CATALOG` |

**Two shared techniques since 0.4.1** (devkit, APK updates, component packages and Claude Code):

- **Segmented parallel download**: for files of 16 MB or more from a server that honours Range, the remaining bytes are split into up to 4 segments fetched at once and written at their offsets into one `.part` (pre-sized to the full length). Per-segment progress lives in `.part.seg`, so an interrupted download, or one that switched sources, resumes from it; if `.seg` and `.part` disagree, both are discarded. A source without Range support falls back to a single connection. Measured on dl.cccodroid.net: about 2.7 MB/s on one connection, about 14 MB/s on four. Code: `fetchSegmented` in `Installer.java`, and `gateway/gw/pget.mjs`.
- **Switching away from slow sources** (since 0.4.2, Java downloads of the APK and devkit): each connection is measured in 30-second windows, and less than 600 KB in a window counts as a failure, which triggers a retry and then the next source. With no source left it keeps resuming without counting failures. Before, only a failed connection or 60 seconds without a byte switched sources, so a slow trickle from GitHub sat at 0% forever (reported for 0.3.16 → 0.4.1). Code: `Slow` in `Installer.java`.
- **gh-proxy.com as a last resort**: when every other source struggles, a GitHub URL is tried once more through `https://gh-proxy.com/github.com/…`. It is a third-party service and needs no trust: content is still checked against the trust anchors in the table above. (Suggested in discussion #15.)

Some components also download things on first run, e.g. Blender fetches itself from Debian and a patched Mesa from GitHub. Those first-run scripts check their own pinned sha256 and are **outside the multi-source system** described here.

---

## Server side (mirrors on cccodroid.net)

Two hostnames, one server:

| Host | Behind Cloudflare? | Serves |
|---|---|---|
| `cccodroid.net` | yes (proxied) | Website, APKs (`/dl/`), component indexes (`/components/<official\|community>/components.json(.sig)`), Claude Code manifests (`/claude-code/`) |
| `dl.cccodroid.net` | no (DNS only, direct) | Devkits (`/devkit/`), component packages (`/components/<official\|community>/<file>`), Claude Code manifests (`/claude-code/`, same copy) |

**Why two**: files of hundreds of MB don't belong on a CDN, and some networks in China only reach one of the two, so the Claude Code manifests live on both.

**Who maintains them**: the generator `repos/cccodroid-site/src/build.mjs`, run every 30 minutes by `cccodroid-site.timer`. The service timeout is raised to 60 minutes by the drop-in `/etc/systemd/system/cccodroid-site.service.d/timeout.conf`. What each step does:

- **APKs and release list** (`fetchReleases`): only files whose sha256 matches GitHub's record; keeps the last 4 versions.
- **Devkits** (`fetchDevkits`): only the version pinned by the APK and the newest one, checked against `devkit.lock.json`.
- **Component indexes** (`fetchIndexes`): updated only when the ed25519 signature verifies; on failure the previous copy is kept.
- **Component packages** (`fetchComponentFiles`): only packages listed in a verified index, each checked by sha256. A verified file gets a `.ok` marker next to it (not publicly reachable); files no longer listed are deleted. This runs **after** the site switch, so the initial 4 GB sync doesn't hold up site updates.
- **Claude Code manifests** (`fetchClaude`): version pointers for the stable and latest channels plus `manifest.json` and `.sig` for the last 12 versions, **accepted only if Anthropic's PGP signature verifies**. Only manifests are mirrored, never the binary; see section 3.

nginx config: `/etc/nginx/sites-available/cccodroid.conf` and `cccodroid-dl.conf`. Data lives in `/var/www/cccodroid/data/`, owned by `ccsite`. `/claude-code/` on `dl.cccodroid.net` is an `alias` to `data/current/claude-code/`, so it switches atomically with the site.

Deployment: see `repos/cccodroid-site/README.md`. **Other sites run on this server; touch only cccodroid files.**

---

## Details

### 1. Devkit

- On first install the setup page lets the user pick GitHub, the cccodroid.net mirror, or a local file. GitHub and the mirror back each other up, with gh-proxy tried last; sources are tried in order without going back, resuming the same `.part` file.
- Checksums come from `assets/devkit-pin.json` in the APK. It is generated by `scripts/pin-devkit.mjs`, and `build.sh` checks that it matches `devkit-sources.txt`.
- **To change the devkit version**: publish the devkit Release, update `devkit-sources.txt`, run `pin-devkit.mjs`, then build the APK. The server picks up the newly pinned version on its own.
- `pin-devkit.mjs` requires the lock file to be signed (`devkit.lock.json.sig`) and verifies it. Only the few releases before 10-29 were never signed; for those, after checking, rerun with `PIN_ALLOW_UNSIGNED=1` and the pin records `lockSigned:false`. Don't use this switch for new releases.
- Built-in component index (`components.json` and `.sig` on the `components` Release): `publish-devkit.mjs` verifies the published copy with the release key before merging and stops if it fails. With a private key, `components-index.mjs` also only merges an old index that verifies. A brand-new repository (no index on the Release yet) needs a one-time manual seed: run `INDEX_SIGNING_KEY_FILE=<key> node devkit/components-index.mjs <new-path>/components.json <URL prefix> <component-x.json>` against an output path that doesn't exist, upload the resulting `components.json` and `components.json.sig` to the `components` Release, then leave it to `publish-devkit.mjs`.

### 2. APK updates

- The GitHub API is tried first, then `cccodroid.net/dl/releases.json`, then `dl.cccodroid.net/dl/releases.json` (the same file, direct, not through Cloudflare). It has the same shape as GitHub's release list. Android itself enforces the APK signature.
- The APK is tried from GitHub Release → `cccodroid.net/dl/<version>/` → `dl.cccodroid.net/dl/<version>/` → gh-proxy, resuming the same `.part`. The dl host's `/dl/` was added for 0.4.2 (`cccodroid-dl.conf` on the VPS, sharing the main site's `data/dl/`); older versions only use the first two.
- For local testing, `home/.config/cccodroid/update-feed` overrides the release list URL.

### 3. Claude Code (the hardest one)

**Why we mirror only manifests**: Claude Code is closed source; hosting the binary ourselves would be redistribution and risks breaking the terms. Anthropic also publishes it on npm as `@anthropic-ai/claude-code-linux-arm64`, and its `package/claude` is **byte-identical** to the official download (verified on 2.1.292). So the binary comes from npm mirrors and the manifest comes from us.

**Trust anchors, in priority order**:

1. The `linux-arm64` sha256 in the official `manifest.json`, fetched from, in order:
   - `downloads.claude.ai`: trusted via HTTPS; the signature is also checked when available;
   - `cccodroid.net/claude-code/`: PGP signature **required**;
   - `dl.cccodroid.net/claude-code/`: PGP signature **required**.
2. If none of the three is reachable, fall back to the npm registry's ECDSA signature (over `name@version:integrity`), then check the package's sha512. A version installed this way gets a `.npm-only` marker.

**Recheck**: 2 minutes after start and every 6 hours after that, the gateway runs `install-claude.mjs --recheck` on versions marked `.npm-only`:

- Match: the marker is removed and the result goes into the repair ledger.
- Mismatch: a `.mismatch` marker is written and logged. `Updater.java` sees it and shows Claude Code as "update available"; tapping update re-downloads that version, and success clears the marker.

**Pinned keys** (change only after verification):

| Key | Fingerprint / ID | Where | Source (at least two must agree when changing) |
|---|---|---|---|
| Anthropic release key (RSA 4096) | `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` | `ANTHROPIC_KEYS` in `install-claude.mjs`; `CLAUDE_KEYS` in `build.mjs` | `https://downloads.claude.ai/keys/claude-code.asc`, keys.openpgp.org |
| npm registry key (ECDSA P-256) | `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` | `NPM_KEYS` in `install-claude.mjs` | `https://registry.npmjs.org/-/npm/v1/keys` (unexpired keys only) |

**Download behaviour**:

- A source below 20 KB/s for 30 seconds, or failing twice in a row, is dropped for the next one.
- Downloads resume across sources of the same kind: the direct download uses `claude.part`; every npm mirror shares one `claude.tgz.part`, since their integrity is identical.
- When every source fails, wait 15 seconds and try one more round, keeping partial data.
- The last successful source is recorded in `~/.local/share/cccodroid/claude/.source` and tried first next time.
- In-app update checks also have fallbacks for the version number: official → cccodroid.net → dl.cccodroid.net → npm mirror dist-tags. Anthropic's npm `stable` / `latest` tags match the official channels.

**Testing**: two environment variables override the URLs to simulate an unreachable official server (content still has to pass signature and hash checks):

```sh
CCODROID_CLAUDE_OFFICIAL=https://127.0.0.1:9/x   # make the official server unreachable
CCODROID_CLAUDE_MIRROR=https://dl.cccodroid.net/claude-code   # use only this manifest mirror
bash install-claude.sh stable        # or latest, or an exact version
node install-claude.mjs --recheck    # recheck
```

Cover at least: npm only; official reachable but downloading from a mirror; official fully down, manifest mirror plus npm mirror; recheck.

### 4 & 5. Component index and packages

- Index: GitHub first, `COMP_INDEX_MIRROR` (cccodroid.net) as backup. The ed25519 key is pinned in the gateway, and the server checks the same key before mirroring.
- Packages: `compMirrorUrl(b)` maps a GitHub URL to `dl.cccodroid.net/components/<official|community>/<file>` (`preset` maps to `official`). Up to 4 attempts alternate between the two; the winner is remembered in `compMirrorFirst` until the process restarts. The progress bar shows the current source (`progress.via`).
- **Publishing a new component needs no extra step**: the generator mirrors it on its next run. Confirm with the check script below.

### 6. pkg

- Repositories are listed in `REPOS`, each with a `base` and a list of `mirrors`.
- **Verification**: fetch `Release` and `Release.gpg` and verify against `TERMUX_KEYS`; check `Packages.gz` against the sha256 in `Release`; check each `.deb` against the sha256 in `Packages`.
  - Signature missing means the source is skipped, Termux's own hosts included; if every source fails, the cached index is used.
  - **Any other mirror with a missing or bad signature is not used.**
- **Mirrors in China**: TUNA, USTC, BFSU and NJU carry main and x11 only, **no glibc repo** (checked 2026-10-20); Aliyun has no Termux mirror. They lag the official repo by 10–15 hours, so an index from the official repo may point at packages a mirror doesn't have yet (404); the code just moves to the next source.
- **Packages are fetched first from whichever source served the index** (`repo.from`), so an unreachable official host doesn't stall every package.
- A repo whose index can't be fetched is skipped; only failing all of them is an error.
- Termux signing key: `CC72CF8BA7DBFA0182877D045A897D96E57CF20C` (RSA, termux-autobuilds). It matched in three places: `packages/termux-keyring/termux-autobuilds.gpg` in termux-packages, keyserver.ubuntu.com and keys.openpgp.org. **If Termux rotates the key, pkg will fail verification on every source**; verify the new key the same way and update the pin.
- **The source file is `android/assets/bin/pkg.mjs`.** `android/assets/app/` is build output that `build.sh` wipes and regenerates every time; edits there are lost.

### 7. glibc libs for custom components

Only the official Termux glibc repo is used, since no Chinese mirror exists. If the user can't reach it, the analysis lists those libraries as "no source found"; the program still installs but may not run. A future fix would be to mirror `termux-glibc` on our server and verify `Release.gpg` as pkg does.

### 8. On-device models

Every catalog entry has a pinned sha256. Official Qwen models try ModelScope first; everything else tries HuggingFace, then hf-mirror.com. URLs pasted by the user must be https.

---

## Routine checks (before a release or when something breaks)

```sh
# Claude Code versions agree in all three places, both manifest mirrors present;
# every component package in the indexes exists on dl.cccodroid.net with the right size
node scripts/check-mirrors.mjs

# The generator's latest runs
ssh <server> 'journalctl -u cccodroid-site -n 20 --no-pager'
```

**Common symptoms**:

| Symptom | Likely cause | What to do |
|---|---|---|
| Install log says the cccodroid.net mirror's signature can't be fetched | The user's route to Cloudflare is unstable | Normal; dl.cccodroid.net is tried next, npm only if both fail |
| Manifest mirror stuck on an old version | Generator couldn't reach the official server and kept the last copy | Check journalctl; it catches up once the official server is back |
| Component package 404 on the mirror | Just published, generator hasn't run yet | Wait 30 minutes or run `systemctl start cccodroid-site` |
| pkg says a mirror's Release signature is missing | Mirror doesn't sync `Release.gpg`, or is incomplete | Normal, next source is used; drop the mirror from the list if it persists |
| pkg fails verification on every source | Termux rotated its key | Verify and update `TERMUX_KEYS` (section 6) |
| Every Claude Code manifest fails verification | Anthropic rotated its key | Verify, then update both `install-claude.mjs` and `build.mjs`. **Do not disable verification in the meantime.** |

---

## Checklist for adding a source

1. Are its files **byte-identical** to the original? Spot-check a sha256.
2. Is the trust anchor still independent of it, i.e. is content still checked against the pinned hash or signature?
3. Can it slow down other sources when it fails? Check for a connect timeout and that a stall trips the speed limit.
4. Can it resume the same `.part` file as existing sources?
5. Add it to the overview table and the matching section of this guide.

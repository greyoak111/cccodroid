#!/system/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  release.sh —— 发布 APK：建 GitHub Release（tag v<版本>）并上传 dist/cccodroid.apk
#
#  APK 在构建机上签名（发布钥匙不进 CI），所以 Release 也从这里建。
#  token：fine-grained，只对本仓库有 Contents 读写，放在构建机私有目录（TOKEN），绝不进仓库。
#  用法:  sh scripts/release.sh            先跑 build.sh；版本取自 AndroidManifest 的 versionName
#         NOTES=说明.md NOTES_EN=notes.en.md sh scripts/release.sh   （缺省用 android/assets/whatsnew/v<版本>.*.md）
#  说明是中英双语：中文在前，--- 之后是 ## English。NOTES_EN 缺省时英文部分只有安装与校验
#  正式版直接发；tag 带后缀（v0.2.0-beta1）的标成预发布，App 内更新检查只认正式版
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOKEN=${TOKEN:-/data/user/0/li.dsh.claudecli/files/bldtools/gh-token-cccodroid}
REPO=greyoak111/cccodroid
APK="$ROOT/dist/cccodroid.apk"
# 双方案：cccodroid-36.apk（targetSdk 36）同版本一起发；没打出来就只发 28 的（旧流程）
APK36="$ROOT/dist/cccodroid-36.apk"
[ -s "$TOKEN" ] || { echo "✗ 没有 token：$TOKEN"; exit 1; }
[ -s "$APK" ] || { echo "✗ 没有 $APK，先跑 build.sh"; exit 1; }
VER=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml")
TAG="v$VER"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "✗ 工作区有未提交的改动，发布要对应一个确定的提交"; exit 1; }
DEVKIT=$(sed -n 's|.*/download/\([^/]*\)/.*|\1|p' "$ROOT/devkit-sources.txt" | head -1)
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
# 没有 36 包是正常情况（旧流程只发 28）。写成 [ -s ] && … 的话，文件不存在时这条命令返回 1，
# set -e 会让脚本在建设 Release 之前直接退出
SHA36=""
[ -s "$APK36" ] && SHA36=$(sha256sum "$APK36" | cut -d' ' -f1) || true
COMMIT=$(git -C "$ROOT" rev-parse HEAD)
# 提交得先在 GitHub 上，tag 才建得出来（2026-10-17 推送被网络打断过一次，Release 跟着失败）
git -C "$ROOT" fetch -q origin main 2>/dev/null || true
git -C "$ROOT" merge-base --is-ancestor "$COMMIT" origin/main 2>/dev/null || { echo "✗ 提交 ${COMMIT%${COMMIT#???????}} 还没推到 origin/main，先 git push"; exit 1; }

# 说明缺省用 APK 自带的更新说明（android/assets/whatsnew/v<版本>.zh/en.md）—— App 里弹的和 Release 正文是同一份
W="$ROOT/android/assets/whatsnew"
[ -z "$NOTES" ] && [ -s "$W/$TAG.zh.md" ] && NOTES="$W/$TAG.zh.md"
[ -z "$NOTES_EN" ] && [ -s "$W/$TAG.en.md" ] && NOTES_EN="$W/$TAG.en.md"
[ -z "$NOTES" ] && echo "⚠ 没有更新说明：$W/$TAG.zh.md（App 里也不会弹）"
[ -n "$NOTES" ] && [ -z "$NOTES_EN" ] && echo "⚠ 只给了中文说明（NOTES），没给英文（NOTES_EN）"
# App 里的「更新日志」页（gateway/web/changelog/*.json）要已经带着这一版：写好 whatsnew 后跑 node scripts/changelog.mjs 再提交、打包
grep -q "\"v\":\"$VER\"" "$ROOT/gateway/web/changelog/zh.json" 2>/dev/null || echo "⚠ 更新日志里没有 $TAG：这个包里的「更新日志」页会缺这一版（先跑 node scripts/changelog.mjs，提交后重新打包）"
export TOKEN REPO TAG COMMIT SHA SHA36 DEVKIT APK APK36 NOTES NOTES_EN
node --input-type=module -e '
import fs from "node:fs";
const { TOKEN, REPO, TAG, COMMIT, SHA, SHA36, DEVKIT, APK, APK36, NOTES, NOTES_EN } = process.env;
const auth = { authorization: "Bearer " + fs.readFileSync(TOKEN, "utf8").trim(), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (method, url, body, extra = {}) => {
  const r = await fetch(url, { method, headers: { ...auth, ...extra }, body });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};
const read = (p) => (p ? fs.readFileSync(p, "utf8").trim() + "\n\n" : "");
const devkitLink = "[" + DEVKIT + "](https://github.com/" + REPO + "/releases/tag/" + DEVKIT + ")";
const body = "**简体中文** · [English](#english)\n\n" + read(NOTES) + [
  "### 安装",
  "下载 `cccodroid.apk` 安装（系统提示「与此版本的安卓不兼容」、装不上时，改装 `cccodroid-36.apk`）。首次打开先勾选要装的工具包模块（默认约 330 MB，全部约 700 MB，断点续传），再下载官方 Claude Code（约 275 MB）。",
  "",
  "### 校验",
  "- `cccodroid.apk` sha256：`" + SHA + "`",
  ...(SHA36 ? ["- `cccodroid-36.apk`（targetSdk 36）sha256：`" + SHA36 + "`"] : []),
  "- 配套开发工具包：[" + DEVKIT + "](https://github.com/" + REPO + "/releases/tag/" + DEVKIT + ")",
  "- 源码提交：" + COMMIT,
].join("\n") + "\n\n---\n\n## English\n\n" + read(NOTES_EN) + [
  "### Install",
  "Download and install `cccodroid.apk` (if Android says it isn’t compatible and won’t install it, use `cccodroid-36.apk` instead). On first launch you pick toolchain modules (about 330 MB by default, about 700 MB for all, resumable), then the official Claude Code is downloaded (about 275 MB).",
  "",
  "### Verification",
  "- `cccodroid.apk` sha256: `" + SHA + "`",
  ...(SHA36 ? ["- `cccodroid-36.apk` (targetSdk 36) sha256: `" + SHA36 + "`"] : []),
  "- Matching toolchain: " + devkitLink,
  "- Source commit: " + COMMIT,
].join("\n");
let rel;
try { rel = await api("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`); console.log("  已有 Release " + TAG + "，更新附件"); }
catch { rel = await api("POST", `https://api.github.com/repos/${REPO}/releases`, JSON.stringify({ tag_name: TAG, target_commitish: COMMIT, name: "cccodroid " + TAG, body, prerelease: TAG.includes("-") })); console.log("  已建 Release " + TAG); }
const files = [["cccodroid.apk", APK], ...(SHA36 ? [["cccodroid-36.apk", APK36]] : [])];
for (const [name, file] of files) {
  for (const a of rel.assets || []) if (a.name === name) await api("DELETE", a.url);
  const up = rel.upload_url.replace(/\{.*\}$/, "") + "?name=" + name;
  const asset = await api("POST", up, fs.readFileSync(file), { "content-type": "application/vnd.android.package-archive" });
  console.log("  ✓ " + asset.browser_download_url + "  " + (asset.size / 1048576).toFixed(2) + " MB");
}
console.log("  " + rel.html_url);
'

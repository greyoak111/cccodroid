#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  build.sh —— 构建 cccodroid APK：原生小库 → javac → d8 → aapt2 → 签名
#
#  在哪都能跑：默认用作者平板上的一套工具；别的机器（含 GitHub Actions，见 .github/workflows/apk.yml）
#  用环境变量换掉 ——
#    CC_ANDROID    编 aarch64 安卓程序的 C 编译器（NDK 里的 aarch64-linux-android26-clang）
#    JAVAC D8 AAPT2 ANDROID_JAR   对应 SDK / JDK 里的工具
#    SIGN=apksigner  用 SDK 的 apksigner 签（再给 APKSIGNER、ZIPALIGN）；默认是平板上的签名库
#  钥匙：KEY 指向 {"key": PEM 私钥, "cert": PEM 证书} 的 JSON，绝不进仓库（CI 里放在仓库 secret）。
#        换钥匙 = 已装的用户必须卸载重装，所以它丢了就再也发不了更新 —— 要另做离线备份。
#        只想自己编个包试试：SIGN=apksigner 再给 KS（keystore 文件，口令 KS_PASS，默认 android），装不上正式版之上，但能单独装。
#        KS 只有 apksigner 那条路认；默认的平板签名库只认 KEY。
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$ROOT/gateway}
F=/data/user/0/li.dsh.claudecli/files
P=$F/toolchain/dshtc/prefix
if [ -d "$P" ]; then
  # 作者的旧开发端（li.dsh.claudecli）：工具链在它的私有目录里
  B=${BLDTOOLS:-$F/bldtools}
  J=$P/lib/jvm/java-17-openjdk/bin
  CC_ANDROID=${CC_ANDROID:-cc4}
  JAVAC=${JAVAC:-"env LD_LIBRARY_PATH=$P/lib $J/javac"}
  D8=${D8:-"env LD_LIBRARY_PATH=$P/lib $J/java -cp $P/share/java/d8.jar com.android.tools.r8.D8"}
  AAPT2=${AAPT2:-"env LD_LIBRARY_PATH=$P/lib $P/bin/aapt2"}
  AJAR=${ANDROID_JAR:-$P/framework/android.jar}
else
  # cccodroid 终端（作者 11-05 起在开发版里发版）：工具都在 PATH，钥匙与 android.jar 在 ~/.bldtools
  B=${BLDTOOLS:-$HOME/.bldtools}
  # 原生小库优先用旧开发端搬来的 GCC 10（~/.bldtools/cc4），产物和以前逐字节一致；没有才用 clang
  if [ -x "$B/cc4" ]; then CC_ANDROID=${CC_ANDROID:-$B/cc4}; else CC_ANDROID=${CC_ANDROID:-cc}; fi
  # 旧开发端搬来的 JDK 17 与 d8.jar（~/.bldtools/jdk17）：javac 21 编出的 dex 不同，用它才和以前的包逐字节一致
  K=$B/jdk17
  if [ -x "$K/java-17-openjdk/bin/javac" ]; then
    JAVAC=${JAVAC:-"env LD_LIBRARY_PATH=$K/prefixlib $K/java-17-openjdk/bin/javac"}
    D8=${D8:-"env LD_LIBRARY_PATH=$K/prefixlib $K/java-17-openjdk/bin/java -cp $K/d8.jar com.android.tools.r8.D8"}
  else
    JAVAC=${JAVAC:-javac}
    D8=${D8:-d8}
  fi
  AAPT2=${AAPT2:-aapt2}
  AJAR=${ANDROID_JAR:-$B/android.jar}
fi
KEY=${KEY:-$B/cccodroid-release.json}
SIGN=${SIGN:-apklib}
A=$ROOT/android
OUT=$ROOT/dist
[ -z "$KS" ] || [ "$SIGN" = apksigner ] || { echo "✗ KS 要配 SIGN=apksigner 用（默认的签名库只认 KEY 钥匙 JSON）"; exit 1; }
[ -n "$KS" ] || [ -f "$KEY" ] || { echo "✗ 找不到签名钥匙 $KEY（不会自动生成：换钥匙会让已装用户无法升级）"; exit 1; }

echo "▸ assets"
rm -rf "$A/assets/app"; mkdir -p "$A/assets/app/web" "$A/assets/app/scripts" "$A/assets/app/bin"
cp "$SRC/server.mjs" "$A/assets/app/"
cp "$SRC/boot.mjs" "$A/assets/app/"      # 网关引导：应用从安装包里读出来经 -e 交给 node（安全 5，见 gateway/boot.mjs）
mkdir -p "$A/assets/app/gw"; cp "$SRC/gw/"*.mjs "$A/assets/app/gw/"     # 网关的各功能模块
mkdir -p "$A/assets/app/archive"; cp "$SRC/archive/"* "$A/assets/app/archive/"   # 建档规范与交档命令（脉络，见 gw/archive.mjs）
mkdir -p "$A/assets/app/guard"; cp "$SRC/guard/"* "$A/assets/app/guard/"       # 敏感操作再确认的钩子（见 gw/claude.mjs guardHooks）
for f in "$SRC/web/"*; do case "$f" in *.bak*) ;; *) cp -R "$f" "$A/assets/app/web/";; esac; done
cp "$A/assets/scripts/"* "$A/assets/app/scripts/"
cp "$A/assets/bin/"* "$A/assets/app/bin/"
cp "$ROOT/devkit/pgp.mjs" "$A/assets/app/bin/"     # OpenPGP 验签：pkg.mjs、install-claude.mjs 与 devkit 构建共用这一份
mkdir -p "$A/assets/app/pre"; cp "$A/assets/pre/"* "$A/assets/app/pre/"     # pkg / apt：PATH 最前，压过工具包里的旧替身
cp "$A/assets/TOOLS.md" "$A/assets/app/"     # 给 claude 的工具说明（网关读进系统提示）
# 随包的第三方许可：Shizuku-API 编进了 classes.dex，MIT 要求随包带上版权与许可原文（#110 10-003）；网页里的库各自带着 LICENSE
mkdir -p "$A/assets/app/licenses"; cp "$ROOT/NOTICE" "$ROOT/LICENSE" "$A/assets/app/licenses/"; cp "$ROOT/third_party/shizuku/LICENSE" "$A/assets/app/licenses/Shizuku-API-LICENSE"
# glibc 的 ld.so 以 libldlinux.so 进了 lib/：LGPL 要求随包带上许可原文和取源码的途径
cp "$ROOT/third_party/glibc/COPYING.LIB" "$A/assets/app/licenses/glibc-COPYING.LIB"; cp "$ROOT/third_party/glibc/README.md" "$A/assets/app/licenses/glibc-README.md"
# 工具包下载地址（Release 目录，按序尝试）。测试时可用 DEVKIT_BASES="http://… https://…" 覆盖
if [ -n "$DEVKIT_BASES" ]; then echo "$DEVKIT_BASES" | tr " " "\n" > "$A/assets/devkit-sources.txt"
else cp "$ROOT/devkit-sources.txt" "$A/assets/devkit-sources.txt"; fi
[ -s "$A/assets/devkit-sources.txt" ] || { echo "✗ devkit-sources.txt 为空（/sdcard 的 FUSE 有时报过时的大小 0，cp 会拷出空文件：rm 后重写源文件）"; exit 1; }
echo "  工具包来源：$(tr "\n" " " < "$A/assets/devkit-sources.txt")"
# 绑定那一版的清单（首装从镜像下、认本地文件时以它为准）。必须和 devkit-sources.txt 的第一个地址是同一版
DK_BASE=$(head -1 "$A/assets/devkit-sources.txt")
if [ -n "$DEVKIT_BASES" ]; then node "$ROOT/scripts/pin-devkit.mjs" "$DK_BASE" "$A/assets/devkit-pin.json" || exit 1
else cp "$ROOT/devkit-pin.json" "$A/assets/devkit-pin.json"; fi
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p.base!==process.argv[2]){console.error("✗ devkit-pin.json 是 "+p.base+"，devkit-sources.txt 是 "+process.argv[2]+"：跑 node scripts/pin-devkit.mjs 重新生成");process.exit(1)}' "$A/assets/devkit-pin.json" "$DK_BASE" || exit 1
# 原生小库与小程序一律进 APK 的原生库目录（lib/arm64-v8a，名字得是 lib*.so）：安装时系统解到 /data/app/…/lib/arm64，
# 应用自己的 uid 也改不了，起网关、起 claude 时直接从那里加载，没有「核过之后被换」的窗口（安全 4 第 1 层）。路径由 Env.java 经环境变量交出去
NL="$A/nativelib"; rm -rf "$NL"; mkdir -p "$NL" "$A/assets/app/lib"     # build/ 下面会被 javac 那步整个清掉，先放这里、打包前拷过去
# seccomp 拦截 → ENOSYS（不依赖 libc，见源码注释）。Android 14 上没有它 claude 起不来
$CC_ANDROID -O2 -shared -fPIC -nostdlib -fno-stack-protector -Wl,-z,noexecstack -Wl,--hash-style=both \
  -o "$NL/libccenosys.so" "$A/native/seccomp-enosys.c"
# 同一条思路的「从进程外面」版本：静态二进制挂不上 --preload，只好用 ptrace 做同一件事。
# 这个是**可执行文件**不是库，所以不用 -nostdlib（它自己就是被启动的那个进程，可以正常链 libc）。
# 入口包装在 assets/bin/enosys-run
$CC_ANDROID -O2 -o "$NL/libccenosysrun.so" "$A/native/seccomp-enosys-run.c"
# 应用内终端的伪终端（node 没有 pty）：stdin/stdout 与 pty 对转，fd 3 收窗口大小
$CC_ANDROID -O2 -o "$NL/libccptyhost.so" "$A/native/ptyhost.c"
# 「经加载器」执行方式（targetSdk 36 只能这样）：glibc 程序拉子进程时的 exec 改写垫片，和 seccomp-enosys.so 一起 --preload 给 claude；
# execpath.cjs 给经 linker64 起的 node 纠正 process.execPath（NODE_OPTIONS --require）
$CC_ANDROID -O2 -shared -fPIC -nostdlib -fno-stack-protector -Wl,-z,noexecstack -Wl,--hash-style=both \
  -o "$NL/libccexecshim.so" "$A/native/exec-shim.c"
# 同一份源码的 bionic 版：排在 termux-exec 前面，把 bionic 进程里 exec glibc 程序 / glibc ld.so 改走 APK 里的 ld.so
$CC_ANDROID -DBIONIC -O2 -shared -fPIC -fno-stack-protector -Wl,-z,noexecstack -Wl,--hash-style=both \
  -o "$NL/libccexecshimb.so" "$A/native/exec-shim.c" -ldl
# 不可转储：网关（LD_PRELOAD）和发行版的 claude（--preload）挂它，认 CCAPP_NODUMP=1。不依赖 libc，bionic / glibc 两边都能载
$CC_ANDROID -O2 -shared -fPIC -nostdlib -fno-stack-protector -Wl,-z,noexecstack -Wl,--hash-style=both \
  -o "$NL/libccnodump.so" "$A/native/nodump.c"
cp "$A/native/execpath.cjs" "$A/assets/app/lib/"
TAG=$(cat "$A/assets/app/server.mjs" "$A/assets/app/boot.mjs" "$A/assets/app/gw/"* "$A/assets/app/archive/"* "$A/assets/app/guard/"* "$A/assets/app/TOOLS.md" $(find "$A/assets/app/web" -type f | sort) "$A/assets/app/scripts/"* "$A/assets/app/bin/"* "$A/assets/app/pre/"* "$A/assets/app/lib/"* "$NL/"libcc*.so | md5sum | cut -c1-12)
echo "$TAG" > "$A/assets/app/TAG"
echo "  tag $TAG"
# 逐文件清单（sha256 + 相对路径）：启动时应用按它核对 files/app，被改过、多出来的就从安装包还原（防项目钩子 / MCP 之类偷偷改网关）
node -e 'const fs=require("fs"),p=require("path"),c=require("crypto"),R=process.argv[1],o=[];const w=(d)=>{for(const e of fs.readdirSync(p.join(R,d),{withFileTypes:true})){const r=d?d+"/"+e.name:e.name;if(e.name.startsWith("."))continue;if(e.isDirectory())w(r);else if(r!=="FILES")o.push(c.createHash("sha256").update(fs.readFileSync(p.join(R,r))).digest("hex")+" "+r)}};w("");o.sort((a,b)=>a.slice(65)<b.slice(65)?-1:1);fs.writeFileSync(p.join(R,"FILES"),o.join("\n")+"\n")' "$A/assets/app" || exit 1
echo "  清单 $(wc -l < "$A/assets/app/FILES") 个文件"

# 第三方库：Shizuku-API 13.1.5（MIT，Maven Central 原样，sha1 已核）
LIBS=$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')
echo "▸ javac"
rm -rf "$A/build"; mkdir -p "$A/build/classes"
$JAVAC -encoding UTF-8 --release 8 -nowarn \
  -cp "$AJAR:$LIBS" -d "$A/build/classes" $(find "$A/java" -name '*.java')

echo "▸ d8"
$D8 --release --min-api 26 \
  --lib "$AJAR" --output "$A/build" $(find "$A/build/classes" -name '*.class') "$ROOT"/third_party/shizuku/*.jar

# 「经加载器」要的 glibc ld.so：targetSdk 36 只能 exec APK 原生库目录里的文件，ld.so 就以 libldlinux.so 进 lib/。
# 取钉住那一版工具包锁文件里的同一个 glibc 包（核 sha256）—— ld.so 与工具包里的 libc.so.6 必须出自同一次构建。
# 仓库里 android/prebuilt/glibc 存了一份，和锁文件对得上就不联网
PIN_BASE=$(node -p 'require(process.argv[1]).base' "$A/assets/devkit-pin.json")
PIN_TARGET=$(node -p 'require(process.argv[1]).target' "$A/assets/devkit-pin.json")
LOCK="$ROOT/devkit/cache/lock-$(node -p 'require(process.argv[1]).tag' "$A/assets/devkit-pin.json").json"
mkdir -p "$ROOT/devkit/cache" "$A/build/lib/arm64-v8a"
[ -s "$LOCK" ] || curl -fsSL --retry 3 -o "$LOCK" "${PIN_BASE}devkit.lock.json"
# 锁文件只靠 TLS 不够（审计 M-2c）：对 devkit-pin.json 里钉的 sha256，对不上就删掉缓存、停下
node -e 'const fs=require("fs"),c=require("crypto");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(!p.lock||!/^[0-9a-f]{64}$/.test(p.lock.sha256||"")){console.error("✗ devkit-pin.json 里没有 lock 的 sha256：跑 node scripts/pin-devkit.mjs 重新生成");process.exit(1)}
const h=c.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex");
if(h!==p.lock.sha256){fs.rmSync(process.argv[2],{force:true});console.error("✗ devkit.lock.json 的 sha256 是 "+h+"，钉的是 "+p.lock.sha256+"（已删缓存）");process.exit(1)}' "$A/assets/devkit-pin.json" "$LOCK" || exit 1
cp "$NL/"libcc*.so "$A/build/lib/arm64-v8a/"
# 网关和 claude 执行链上来自工具包的文件该有的 sha256（安全 4 第 2 层，见 devkit.mjs gwpin、GwRuntime.java）。
# 算一次要下基础模块包（约 130 MB），结果按包名存在 android/prebuilt/，钉的工具包没变就直接用
node "$ROOT/devkit/devkit.mjs" gwpin --pin "$A/assets/devkit-pin.json" --target "$PIN_TARGET" --vendored "$A/prebuilt" --out "$A/assets/gwpin.json" || exit 1
node "$ROOT/devkit/devkit.mjs" ldso --lock "$LOCK" --target "$PIN_TARGET" --release "$PIN_BASE" --vendored "$A/prebuilt/glibc" --out "$A/build/lib/arm64-v8a/libldlinux.so"

echo "▸ aapt2 + 签名"
mkdir -p "$OUT"
$AAPT2 compile --dir "$A/res" -o "$A/build/res.zip"
# TARGET_SDK=36：出 targetSdk 36 的包（工具链全走「经加载器」，见 Env.applyLoader）。默认照清单里的 28
MANIFEST="$A/AndroidManifest.xml"
if [ -n "$TARGET_SDK" ]; then
  MANIFEST="$A/build/AndroidManifest.xml"
  sed "s/android:targetSdkVersion=\"[0-9]*\"/android:targetSdkVersion=\"$TARGET_SDK\"/" "$A/AndroidManifest.xml" > "$MANIFEST"
  grep -q "android:targetSdkVersion=\"$TARGET_SDK\"" "$MANIFEST" || { echo "✗ 清单里改不动 targetSdkVersion"; exit 1; }
  echo "  targetSdk $TARGET_SDK"
fi
$AAPT2 link -o "$A/build/unsigned.apk" -I "$AJAR" \
  --manifest "$MANIFEST" -A "$A/assets" "$A/build/res.zip"
# FILES 里的每个文件都得真进了包（aapt2 会丢点开头的、_ 开头目录这类）：少一个，装好后 AppFiles 每次启动都判「被改过」、整个重铺
node -e 'const fs=require("fs"),b=fs.readFileSync(process.argv[1]);let e=b.length-22;while(e>=0&&b.readUInt32LE(e)!==0x06054b50)e--;
  const n=b.readUInt16LE(e+10),names=new Set();for(let i=0,p=b.readUInt32LE(e+16);i<n;i++){const l=b.readUInt16LE(p+28);names.add(b.toString("utf8",p+46,p+46+l));p+=46+l+b.readUInt16LE(p+30)+b.readUInt16LE(p+32)}
  const miss=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean).map((l)=>"assets/app/"+l.slice(65)).filter((x)=>!names.has(x));
  if(miss.length){console.error("✗ FILES 里有 "+miss.length+" 个文件没进 APK：",miss.slice(0,5).join(" "));process.exit(1)}' "$A/build/unsigned.apk" "$A/assets/app/FILES" || exit 1
if [ "$SIGN" = apksigner ]; then
  # SDK 的 apksigner：先把 classes.dex 塞进包、对齐，再签（最低 API 26，它自己决定出 v2 / v3）
  ( cd "$A/build" && zip -q unsigned.apk classes.dex && zip -q -0 unsigned.apk lib/arm64-v8a/libldlinux.so lib/arm64-v8a/libcc*.so )
  ${ZIPALIGN:-zipalign} -p -f 4 "$A/build/unsigned.apk" "$A/build/aligned.apk"
  if [ -n "$KS" ]; then
    ${APKSIGNER:-apksigner} sign --ks "$KS" --ks-pass "pass:${KS_PASS:-android}" --out "$OUT/cccodroid.apk" "$A/build/aligned.apk"
  else
    # 钥匙 JSON → PKCS#8 DER + 证书，只在构建目录里待一下，签完就删
    trap 'rm -f "$A/build/key.pk8" "$A/build/cert.pem"' EXIT
    node -e 'const fs=require("fs"),c=require("crypto"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      fs.writeFileSync(process.argv[2],c.createPrivateKey(j.key).export({type:"pkcs8",format:"der"}),{mode:0o600});
      fs.writeFileSync(process.argv[3],j.cert)' "$KEY" "$A/build/key.pk8" "$A/build/cert.pem"
    ${APKSIGNER:-apksigner} sign --key "$A/build/key.pk8" --cert "$A/build/cert.pem" --out "$OUT/cccodroid.apk" "$A/build/aligned.apk"
  fi
  rm -f "$OUT/cccodroid.apk.idsig"
  echo "  $(du -h "$OUT/cccodroid.apk" | cut -f1)"
else
node --input-type=module -e "
import fs from 'node:fs'; import { signApk } from '$B/apklib.mjs';
const r = signApk('$A/build/unsigned.apk', '$OUT/cccodroid.apk',
  [{ name: 'classes.dex', data: fs.readFileSync('$A/build/classes.dex'), method: 8 },
   ...['libldlinux.so', ...fs.readdirSync('$NL').filter((n) => /^libcc.*\.so$/.test(n)).sort()]
     .map((n) => ({ name: 'lib/arm64-v8a/' + n, data: fs.readFileSync('$A/build/lib/arm64-v8a/' + n), method: 0 }))], '$KEY');
console.log('  ' + r.entries + ' 个条目 · ' + (r.size / 1048576).toFixed(2) + ' MB');
"
fi
echo "✓ $OUT/cccodroid.apk"

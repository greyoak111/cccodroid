#!/bin/sh
# 随 APK 的 7-Zip（7zz，全格式版 Alone2）：从上游源码编成只依赖系统 libc 的程序，存进 android/prebuilt/libcc7zz.so。
# build.sh 只拷这份成品（和 glibc 的 ld.so 一样存在仓库里），换版本时跑一遍本脚本再提交。
#   用法：sh scripts/build-7zz.sh
# 工具链：~/.bldtools/cc4 那套 C4droid GCC 10（bionic，带 libstdc++.a）——静态链 C++ 运行库，安装包里不用再带 libc++_shared.so。
# GCC 10 的汇编器不认 ARMv8.2 的 SHA-512 指令，C/Sha512Opt.c 这一个纯 C 文件改用 clang 编（不涉及 C++ 运行库）。
set -e
VER=26.06
SHA=a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4     # 同 termux-packages packages/7zip/build.sh
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/android/prebuilt/libcc7zz.so"
TC=$HOME/.bldtools/c4tc/tc/gcc
[ -x "$TC/bin/aarch64-linux-android-g++" ] || { echo "✗ 没有 $TC（C4droid GCC 10）"; exit 1; }
W=${TMPDIR:-/tmp}/build-7zz; rm -rf "$W"; mkdir -p "$W"; cd "$W"
curl -fsSL -o src.tar.xz "https://github.com/ip7z/7zip/releases/download/$VER/7z$(echo $VER | tr -d .)-src.tar.xz"
echo "$SHA  src.tar.xz" | sha256sum -c -
tar -xf src.tar.xz
sed -i -e 's/-Werror//' CPP/7zip/7zip_gcc.mak
cd CPP/7zip/Bundles/Alone2
mkdir -p b/g
clang -O2 -fPIE -D_GNU_SOURCE -DNDEBUG -D_REENTRANT -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -c ../../../../C/Sha512Opt.c -o b/g/Sha512Opt.o
(
  export PATH="$TC/bin:$TC/aarch64-linux-android/bin:$PATH"
  unset LD_LIBRARY_PATH LD_PRELOAD
  # bionic 的 pthread 在 libc 里，没有 libpthread：LIB2 只留 -ldl
  make -j"$(cc-mem jobs 2>/dev/null || echo 4)" -f ../../cmpl_gcc_arm64.mak O=b/g \
    CC="aarch64-linux-android-gcc -D_GNU_SOURCE -fPIE" CXX="aarch64-linux-android-g++ -D_GNU_SOURCE -fPIE" \
    LDFLAGS_STATIC_2="-pie -static-libstdc++ -static-libgcc" LIB2="-ldl" >"$W/make.log" 2>&1 || { tail -20 "$W/make.log"; exit 1; }
)
NEED=$(readelf -d b/g/7zz | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort | tr '\n' ' ')
[ "$NEED" = "libc.so libdl.so libm.so " ] || { echo "✗ 依赖不对：$NEED"; exit 1; }
readelf -d b/g/7zz | grep -q RUNPATH && { echo "✗ 带了 RUNPATH"; exit 1; }
env -i b/g/7zz i >/dev/null || { echo "✗ 干净环境里跑不起来"; exit 1; }
cp b/g/7zz "$OUT"
sha256sum "$OUT" | cut -c1-64 > "$OUT.sha256"
echo "✓ $OUT  7-Zip $VER · $(stat -c %s "$OUT") 字节 · sha256 $(cat "$OUT.sha256")"

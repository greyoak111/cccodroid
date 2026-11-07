# 7-Zip

APK 的 `lib/arm64-v8a/libcc7zz.so` 是 7-Zip 26.06 的 `7zz`（全格式命令行版，Alone2），由本仓库 `scripts/build-7zz.sh`
从上游源码原样编出（未改源码，只关掉了 `-Werror`），成品存在 `android/prebuilt/libcc7zz.so`，哈希记在同目录的 `.sha256`。
文件管理器的压缩包浏览、解压、压缩用它；终端里的 `7z` / `7zz` 命令也是它。

- 作者：Igor Pavlov
- 许可：GNU LGPL-2.1-or-later，部分代码为 BSD 3-Clause / BSD 2-Clause；RAR 解码部分另受 unRAR 许可限制（不得用来重建 RAR 压缩算法）。原文见同目录 `License.txt`、`copying.txt`、`unRarLicense.txt`
- 上游源码：<https://www.7-zip.org/>，本版：<https://github.com/ip7z/7zip/releases/download/26.06/7z2606-src.tar.xz>（sha256 `a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4`）
- 构建：`sh scripts/build-7zz.sh`（GCC 10 / bionic，静态链 libstdc++，只依赖系统 libc、libm、libdl）

7-Zip 26.06 by Igor Pavlov, GNU LGPL-2.1-or-later with BSD parts and the unRAR license restriction. Built unmodified from the upstream source above with `scripts/build-7zz.sh`.

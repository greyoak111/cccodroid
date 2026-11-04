# GNU C Library（glibc）动态加载器

APK 的 `lib/arm64-v8a/libldlinux.so` 是 glibc 2.44 的 `ld-linux-aarch64.so.1`，取自 Termux 官方仓库的 `glibc` 包，
只把其中的 Termux 路径前缀等长改成了本应用的包名（见 `android/prebuilt/glibc/` 与 `devkit/devkit.mjs ldso`）。

- 许可：LGPL-2.1-or-later，原文见同目录 `COPYING.LIB`
- 上游源码：<https://sourceware.org/glibc/>（2.44 版：<https://ftp.gnu.org/gnu/glibc/glibc-2.44.tar.xz>）
- Termux 的构建配方与补丁：<https://github.com/termux-pacman/glibc-packages>
- 改前缀的做法：本仓库 `devkit/devkit.mjs`（`ldso` 子命令），可按它从原包重新得到同一个文件

GNU C Library (glibc) dynamic loader, LGPL-2.1-or-later. Source and build recipes: see the links above.

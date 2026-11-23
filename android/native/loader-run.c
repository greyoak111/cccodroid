/*
 * loader-run (libccrun.so) —— targetSdk ≥ 29「经加载器」模式下给 Go / 静态二进制等直发裸 SYS_execve
 * 的进程提供的可执行跳板（放入 APK 原生库目录 lib/arm64-v8a/libccrun.so，SELinux 允许直接 exec）。
 *
 * 为什么需要：
 *   gh / go / rclone / hugo 等 Go 二进制的 os/exec 直接发裸 svc 0 (SYS_execve)，
 *   完全绕过 LD_PRELOAD（libccexecshimb.so / libtermux-exec）。在 targetSdk 36（W^X）下，
 *   它们直接 fork/exec $PREFIX/bin/bash、git、xdg-open 等数据目录里的文件会一律报
 *   EACCES (permission denied)。
 *
 * 做法：
 *   网关在 files/loader-bin/ 下为各个命令建指向本程序（$CCAPP_NATIVE_LIB/libccrun.so）
 *   的软链，并把 loader-bin 挂到子进程 PATH 最前。
 *   Linux execve 查的是软链目标 inode（apk_data_file）的 SELinux 权限，所以 Go 可以直接 exec。
 *   本程序起来后：
 *     1. 按 argv[0] 的 basename 认出要跑的命令（前导 '-' 视作登录 shell；若被 realpath 成 libccrun.so 则回落 bash）
 *     2. 从 PATH 里剥掉 CCAPP_LOADER_BIN、把 SHELL 还原为 CCAPP_SHELL（让子进程里 which / $SHELL 与 28 包完全一致）
 *     3. 在清理后的 PATH 里找到真实目标文件（跳过与自身相同 dev/ino，杜绝自递归；用 stat 权限位而非 access(X_OK)，
 *        因为 targetSdk 36 下 SELinux 会拒掉对数据目录文件的 access(X_OK)）
 *     4. 按目标类型间接拉起（不依赖调用方是否保留了 LD_PRELOAD）：
 *        - #! 脚本：展开解释器（/usr/bin/<x>、/bin/<x> 缺省改指 $PREFIX/bin/<x>），继续按下面规则执行
 *        - bionic ELF（PT_INTERP 为 linker64）：补上 LD_PRELOAD=$CCAPP_BIONIC_PRELOAD、TERMUX_EXEC__PROC_SELF_EXE，
 *          经 /system/bin/linker64 启动
 *        - glibc ELF（PT_INTERP 为 ld-linux-aarch64.so.1）：去掉 LD_PRELOAD，经 $CCAPP_LD 启动
 *        - 系统目录程序（/system 等）：补上 LD_PRELOAD 直接 execv
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int starts_with(const char *s, const char *p) {
    return strncmp(s, p, strlen(p)) == 0;
}

static int ends_with(const char *s, const char *t) {
    size_t a = strlen(s), b = strlen(t);
    return a >= b && strcmp(s + a - b, t) == 0;
}

static int is_sysdir(const char *p) {
    return starts_with(p, "/system/") || starts_with(p, "/apex/") || starts_with(p, "/vendor/") ||
           starts_with(p, "/product/") || starts_with(p, "/odm/") || starts_with(p, "/data/app/") ||
           starts_with(p, "/system_ext/");
}

static int path_eq_norm(const char *a, size_t alen, const char *b) {
    if (!b) return 0;
    size_t blen = strlen(b);
    while (alen > 1 && a[alen - 1] == '/') alen--;
    while (blen > 1 && b[blen - 1] == '/') blen--;
    return alen == blen && memcmp(a, b, alen) == 0;
}

enum { K_OTHER, K_BIONIC, K_GLIBC, K_LDSO, K_SCRIPT };

static int inspect_file(const char *path, char *line, size_t cap) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return K_OTHER;
    unsigned char h[64];
    int k = K_OTHER;
    ssize_t hn = pread(fd, h, sizeof h, 0);
    if (hn == 64 && h[0] == 0x7f && h[1] == 'E' && h[2] == 'L' && h[3] == 'F' && h[4] == 2) {
        unsigned long phoff = 0;
        unsigned short phent = 0, phnum = 0;
        memcpy(&phoff, h + 32, sizeof phoff);
        memcpy(&phent, h + 54, sizeof phent);
        memcpy(&phnum, h + 56, sizeof phnum);
        k = ends_with(path, "ld-linux-aarch64.so.1") ? K_LDSO : K_OTHER;
        for (int i = 0; i < phnum && i < 64; i++) {
            unsigned char ph[56];
            if (pread(fd, ph, sizeof ph, (off_t)(phoff + (unsigned long)i * phent)) != (ssize_t)sizeof ph) break;
            unsigned int ptype = 0;
            memcpy(&ptype, ph, sizeof ptype);
            if (ptype != 3 /* PT_INTERP */) continue;
            unsigned long off = 0, sz = 0;
            memcpy(&off, ph + 8, sizeof off);
            memcpy(&sz, ph + 32, sizeof sz);
            char ip[128];
            if (sz == 0 || sz >= sizeof ip) break;
            if (pread(fd, ip, sz, (off_t)off) != (ssize_t)sz) break;
            ip[sz] = 0;
            k = ends_with(ip, "linker64") ? K_BIONIC : ends_with(ip, "ld-linux-aarch64.so.1") ? K_GLIBC : K_OTHER;
            break;
        }
    } else if (hn >= 2 && h[0] == '#' && h[1] == '!') {
        ssize_t n = pread(fd, line, cap - 1, 2);
        if (n > 0) {
            line[n] = 0;
            for (ssize_t i = 0; i < n; i++) {
                if (line[i] == '\n' || line[i] == '\r') { line[i] = 0; break; }
            }
            k = K_SCRIPT;
        }
    }
    close(fd);
    return k;
}

static int file_exists_stat(const char *p) {
    struct stat st;
    return stat(p, &st) == 0;
}

static int is_exec_candidate(const char *cand, int have_self, const struct stat *self_st) {
    struct stat st;
    if (stat(cand, &st) != 0) return 0;
    if (!S_ISREG(st.st_mode)) return 0;
    if ((st.st_mode & 0111) == 0) return 0;
    if (have_self && st.st_dev == self_st->st_dev && st.st_ino == self_st->st_ino) return 0;
    return 1;
}

static char *strip_loader_bin_from_path(const char *raw_path, const char *loader_bin) {
    if (!raw_path) return strdup("");
    size_t cap = strlen(raw_path) + 1;
    char *out = malloc(cap);
    if (!out) return NULL;
    out[0] = 0;
    size_t out_len = 0;
    const char *p = raw_path;
    while (*p) {
        const char *sep = strchr(p, ':');
        size_t len = sep ? (size_t)(sep - p) : strlen(p);
        if (len > 0 && !(loader_bin && *loader_bin && path_eq_norm(p, len, loader_bin))) {
            if (out_len > 0) out[out_len++] = ':';
            memcpy(out + out_len, p, len);
            out_len += len;
            out[out_len] = 0;
        }
        if (!sep) break;
        p = sep + 1;
    }
    return out;
}

static int resolve_in_path(const char *clean_path, const char *name, int have_self,
                           const struct stat *self_st, char *out, size_t out_cap) {
    if (!clean_path || !*clean_path || !name || !*name) return 0;
    const char *p = clean_path;
    while (*p) {
        const char *sep = strchr(p, ':');
        size_t len = sep ? (size_t)(sep - p) : strlen(p);
        if (len > 0) {
            size_t need = len + 1 + strlen(name) + 1;
            if (need <= out_cap) {
                memcpy(out, p, len);
                out[len] = '/';
                strcpy(out + len + 1, name);
                if (is_exec_candidate(out, have_self, self_st)) return 1;
            }
        }
        if (!sep) break;
        p = sep + 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 1 || !argv[0]) return 127;

    struct stat self_st;
    int have_self = 0;
    const char *self_env = getenv("CCAPP_LOADER_RUN");
    if (self_env && *self_env && stat(self_env, &self_st) == 0) have_self = 1;
    else if (stat("/proc/self/exe", &self_st) == 0) have_self = 1;

    const char *orig_argv0 = argv[0];
    const char *slash = strrchr(orig_argv0, '/');
    const char *base = slash ? slash + 1 : orig_argv0;
    int login_dash = 0;
    if (base[0] == '-') {
        login_dash = 1;
        base++;
    }
    if (!*base || strcmp(base, "libccrun.so") == 0) {
        base = "bash";
    }

    /* clean_path 仅用于本进程内部跳过 loader-bin 查找真实目标；不修改子进程 PATH 环境变量，
     * 确保 bash 拉起的二级 Go 程序（如 gh → git / xdg-open）在裸 SYS_execve 时仍能命中 loader-bin 跳板 */
    const char *loader_bin = getenv("CCAPP_LOADER_BIN");
    char *clean_path = strip_loader_bin_from_path(getenv("PATH"), loader_bin);

    const char *ccapp_ld = getenv("CCAPP_LD");
    const char *ccapp_exec = getenv("CCAPP_EXEC");
    int use_loader = (ccapp_ld && *ccapp_ld) || (ccapp_exec && strcmp(ccapp_exec, "loader") == 0);

    const char *real_shell = getenv("CCAPP_SHELL");
    if (use_loader && loader_bin && *loader_bin) {
        const char *cur_sh = getenv("SHELL");
        if (!cur_sh || !*cur_sh || strstr(cur_sh, "libccrun.so") != NULL) {
            char lb_sh[PATH_MAX];
            snprintf(lb_sh, sizeof lb_sh, "%s/bash", loader_bin);
            setenv("SHELL", lb_sh, 1);
        }
    } else if (real_shell && *real_shell) {
        setenv("SHELL", real_shell, 1);
    }

    char target[PATH_MAX];
    int found = 0;
    if (clean_path && *clean_path) {
        found = resolve_in_path(clean_path, base, have_self, &self_st, target, sizeof target);
    }
    if (!found && (strcmp(base, "bash") == 0 || strcmp(base, "sh") == 0)) {
        const char *prefix = getenv("PREFIX");
        if (real_shell && *real_shell && is_exec_candidate(real_shell, have_self, &self_st)) {
            snprintf(target, sizeof target, "%s", real_shell);
            found = 1;
        } else if (prefix && *prefix) {
            snprintf(target, sizeof target, "%s/bin/%s", prefix, base);
            if (is_exec_candidate(target, have_self, &self_st)) found = 1;
        }
        if (!found && is_exec_candidate("/system/bin/sh", have_self, &self_st)) {
            snprintf(target, sizeof target, "/system/bin/sh");
            found = 1;
        }
    }
    if (!found) {
        fprintf(stderr, "libccrun: %s: not found\n", base);
        return 127;
    }

    int add_login_flag = 0;
    if (login_dash && (strcmp(base, "bash") == 0 || strcmp(base, "sh") == 0)) {
        int has_l = (argc >= 2 && (strcmp(argv[1], "-l") == 0 || strcmp(argv[1], "--login") == 0));
        if (!has_l) add_login_flag = 1;
    }

    const int head_room = 24;
    int max_av = argc + head_room + 4;
    char **av = calloc((size_t)max_av, sizeof(char *));
    if (!av) return 127;
    int s = head_room, e = head_room;
    av[e++] = target;
    if (add_login_flag) av[e++] = "-l";
    for (int i = 1; i < argc; i++) av[e++] = argv[i];
    av[e] = NULL;

    const char *bionic_preload = getenv("CCAPP_BIONIC_PRELOAD");
    const char *glibc_lib = getenv("CCAPP_GLIBC_LIB");
    const char *glibc_preload = getenv("CCAPP_GLIBC_PRELOAD");
    const char *prefix = getenv("PREFIX");

    for (int depth = 0; depth < 5; depth++) {
        char *cur = av[s];
        if (ccapp_ld && *ccapp_ld && strcmp(cur, ccapp_ld) == 0) {
            unsetenv("LD_PRELOAD");
            unsetenv("CCAPP_SELF_EXE");
            execv(cur, av + s);
            break;
        }
        if (is_sysdir(cur)) {
            if (bionic_preload && *bionic_preload) setenv("LD_PRELOAD", bionic_preload, 1);
            execv(cur, av + s);
            break;
        }
        char line[512];
        int k = inspect_file(cur, line, sizeof line);
        if (k == K_SCRIPT) {
            char *q = line;
            while (*q == ' ' || *q == '\t') q++;
            char *ip = q;
            while (*q && *q != ' ' && *q != '\t') q++;
            char *opt = NULL;
            if (*q) {
                *q++ = 0;
                while (*q == ' ' || *q == '\t') q++;
                if (*q) {
                    opt = q;
                    char *t = q + strlen(q);
                    while (t > q && (t[-1] == ' ' || t[-1] == '\t' || t[-1] == '\r')) *--t = 0;
                }
            }
            if (!*ip || s < 10) break;
            char mapped[PATH_MAX];
            const char *nm = starts_with(ip, "/usr/bin/") ? ip + 9 : starts_with(ip, "/bin/") ? ip + 5 : NULL;
            if (nm && prefix && *prefix && !file_exists_stat(ip)) {
                snprintf(mapped, sizeof mapped, "%s/bin/%s", prefix, nm);
                ip = mapped;
            }
            char *ip_copy = strdup(ip);
            char *opt_copy = opt ? strdup(opt) : NULL;
            if (!ip_copy || (opt && !opt_copy)) break;
            if (opt_copy) av[--s] = opt_copy;
            av[--s] = ip_copy;
            continue;
        }
        if (k == K_BIONIC) {
            if (bionic_preload && *bionic_preload) setenv("LD_PRELOAD", bionic_preload, 1);
            if (use_loader) {
                setenv("TERMUX_EXEC__PROC_SELF_EXE", cur, 1);
                av[--s] = "/system/bin/linker64";
                execv("/system/bin/linker64", av + s);
                break;
            }
            execv(cur, av + s);
            break;
        }
        if (k == K_GLIBC) {
            unsetenv("LD_PRELOAD");
            if (use_loader && ccapp_ld && *ccapp_ld) {
                setenv("CCAPP_SELF_EXE", cur, 1);
                if (glibc_preload && *glibc_preload) {
                    av[--s] = (char *)glibc_preload;
                    av[--s] = "--preload";
                }
                if (glibc_lib && *glibc_lib) {
                    av[--s] = (char *)glibc_lib;
                    av[--s] = "--library-path";
                }
                const char *g_argv0 = (depth == 0) ? orig_argv0 : cur;
                if (depth == 0 && loader_bin && *loader_bin) {
                    size_t lblen = strlen(loader_bin);
                    while (lblen > 1 && loader_bin[lblen - 1] == '/') lblen--;
                    if (strncmp(orig_argv0, loader_bin, lblen) == 0 && (orig_argv0[lblen] == '/' || orig_argv0[lblen] == 0)) {
                        g_argv0 = cur;
                    }
                }
                av[--s] = (char *)g_argv0;
                av[--s] = "--argv0";
                av[--s] = (char *)ccapp_ld;
                execv(ccapp_ld, av + s);
                break;
            }
            execv(cur, av + s);
            break;
        }
        if (k == K_LDSO) {
            unsetenv("LD_PRELOAD");
            unsetenv("CCAPP_SELF_EXE");
            if (use_loader && ccapp_ld && *ccapp_ld) {
                av[s] = (char *)ccapp_ld;
                execv(ccapp_ld, av + s);
                break;
            }
            execv(cur, av + s);
            break;
        }
        execv(cur, av + s);
        break;
    }

    fprintf(stderr, "libccrun: exec %s: %s\n", av[s], strerror(errno));
    return 127;
}

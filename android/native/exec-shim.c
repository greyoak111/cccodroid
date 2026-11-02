/*
 * exec-shim.so —— 「经加载器」执行方式下，给 glibc 程序（claude 本体 / Bun）用的 exec 垫片。
 *
 * 为什么需要：targetSdk ≥ 29 的应用不能直接 exec 数据目录里的文件（SELinux 拒绝，EACCES），
 * 只能经 /system/bin/linker64（bionic 程序）或 APK 里自带的 glibc ld.so（glibc 程序）间接启动。
 * bionic 那边有 termux-exec 的 linker 模式代劳；glibc 程序它管不到 —— Bun 拉 shell、拉 rg、拉 MCP
 * 全部是 glibc 的 execve / execvp / posix_spawn / posix_spawnp，就在这里拦下来改写：
 *
 *   ELF，解释器是 linker64        →  /system/bin/linker64 <绝对路径> 参数…        （环境里补上 bionic 的 LD_PRELOAD）
 *   ELF，解释器是 glibc ld.so     →  $CCAPP_LD --argv0 … --library-path … --preload … <路径> 参数…（环境里去掉 LD_PRELOAD）
 *   直接 exec glibc 的 ld.so 本身  →  换成 $CCAPP_LD
 *   #! 脚本                       →  解释器 [参数] <路径> 参数…，解释器再按上面几条处理（/usr/bin/env、/bin/x 改指 $PREFIX/bin）
 *   系统目录里的程序               →  原样执行（只补 bionic 的 LD_PRELOAD，让它再往下拉的子进程也走 linker）
 *
 * 配置全走环境变量（Env.java 设好）：
 *   CCAPP_LD            APK 里的 glibc ld.so（libldlinux.so）
 *   CCAPP_GLIBC_LIB     glibc 库目录（给 --library-path）
 *   CCAPP_GLIBC_PRELOAD glibc 子进程要挂的 --preload 列表（seccomp-enosys.so 和本库，冒号分隔）
 *   CCAPP_BIONIC_PRELOAD bionic 子进程的 LD_PRELOAD（termux-exec 的 linker 版）
 *   PREFIX              工具包前缀
 *
 * 和 seccomp-enosys.so 一样不链 libc（-nostdlib），只在运行时从 glibc 取 getenv / dlsym / __errno_location，
 * 其余用裸系统调用。execve 可能在 vfork 出来的子进程里被调，所以全程只用栈，不 malloc。
 *
 * 同一份源码加 -DBIONIC 编出 exec-shim-bionic.so，挂在 bionic 进程的 LD_PRELOAD 里、排在 termux-exec 前面：
 * termux-exec 的 linker 模式把一切都改成「linker64 <程序>」，可 glibc 程序和 glibc 的 ld.so 交给 linker64 只会报
 * "Could not find a PHDR"。所以 bionic 这边接三种：glibc 程序、直接 exec 工具包里的 ld.so（组件脚本常这么起），
 * 改走 $CCAPP_LD；系统程序原样 exec 但保住 LD_PRELOAD（termux-exec 起系统脚本时会摘掉它）。其余交给下一个 execve（termux-exec）。
 */
typedef unsigned long size_t;
typedef long ssize_t;

extern char *getenv(const char *);
extern void *dlsym(void *, const char *);
#ifdef BIONIC
extern int *__errno(void);
#define ERRNO (*__errno())
#else
extern int *__errno_location(void);
#define ERRNO (*__errno_location())
#endif

#define RTLD_NEXT ((void *)-1l)
#define AT_FDCWD -100
#define NR_getcwd 17
#define NR_faccessat 48
#define NR_openat 56
#define NR_close 57
#define NR_pread64 67
#define NR_execve 221
#define ENOENT_ 2
#define E2BIG_ 7

static long sc(long n, long a, long b, long c, long d) {
    register long x8 __asm__("x8") = n;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3) : "memory");
    return x0;
}

static size_t slen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
static int pre(const char *s, const char *p) { while (*p) if (*s++ != *p++) return 0; return 1; }
static int ends(const char *s, const char *t) { size_t a = slen(s), b = slen(t); return a >= b && pre(s + a - b, t); }
static int streq(const char *a, const char *b) { while (*a && *a == *b) { a++; b++; } return *a == *b; }
static int has(const char *s, char c) { for (; *s; s++) if (*s == c) return 1; return 0; }
static int exists(const char *p) { return sc(NR_faccessat, AT_FDCWD, (long)p, 0, 0) == 0; }

/* 往 buf 里拼字符串，返回起点；放不下返回 0 */
typedef struct { char *b; size_t n, cap; } arena;
static char *put(arena *a, const char *x, const char *y, const char *z) {
    size_t lx = x ? slen(x) : 0, ly = y ? slen(y) : 0, lz = z ? slen(z) : 0;
    if (a->n + lx + ly + lz + 1 > a->cap) return 0;
    char *r = a->b + a->n, *w = r;
    for (size_t i = 0; i < lx; i++) *w++ = x[i];
    for (size_t i = 0; i < ly; i++) *w++ = y[i];
    for (size_t i = 0; i < lz; i++) *w++ = z[i];
    *w++ = 0; a->n = w - a->b;
    return r;
}

static int sysdir(const char *p) {
    return pre(p, "/system/") || pre(p, "/apex/") || pre(p, "/vendor/") || pre(p, "/product/") ||
           pre(p, "/odm/") || pre(p, "/data/app/") || pre(p, "/system_ext/");
}

enum { K_OTHER, K_BIONIC, K_GLIBC, K_LDSO, K_SCRIPT };

/* 看文件头：ELF 取 PT_INTERP，脚本取 #! 行（写进 line） */
static int kind(const char *path, char *line, size_t cap) {
    int fd = (int)sc(NR_openat, AT_FDCWD, (long)path, 0x80000 /* O_CLOEXEC */, 0);
    if (fd < 0) return K_OTHER;
    unsigned char h[64];
    int k = K_OTHER;
    if (sc(NR_pread64, fd, (long)h, 64, 0) == 64 && h[0] == 0x7f && h[1] == 'E' && h[2] == 'L' && h[3] == 'F' && h[4] == 2) {
        unsigned long phoff = *(unsigned long *)(h + 32);
        unsigned short phent = *(unsigned short *)(h + 54), phnum = *(unsigned short *)(h + 56);
        k = ends(path, "ld-linux-aarch64.so.1") ? K_LDSO : K_OTHER;
        for (int i = 0; i < phnum && i < 64; i++) {
            unsigned char ph[56];
            if (sc(NR_pread64, fd, (long)ph, 56, phoff + (unsigned long)i * phent) != 56) break;
            if (*(unsigned int *)ph != 3 /* PT_INTERP */) continue;
            unsigned long off = *(unsigned long *)(ph + 8), sz = *(unsigned long *)(ph + 32);
            char ip[128];
            if (sz == 0 || sz >= sizeof ip) break;
            if (sc(NR_pread64, fd, (long)ip, sz, off) != (long)sz) break;
            ip[sz] = 0;
            k = ends(ip, "linker64") ? K_BIONIC : ends(ip, "ld-linux-aarch64.so.1") ? K_GLIBC : K_OTHER;
            break;
        }
    } else if (h[0] == '#' && h[1] == '!') {
        long n = sc(NR_pread64, fd, (long)line, cap - 1, 2);
        if (n > 0) {
            line[n] = 0;
            for (long i = 0; i < n; i++) if (line[i] == '\n') { line[i] = 0; break; }
            k = K_SCRIPT;
        }
    }
    sc(NR_close, fd, 0, 0, 0);
    return k;
}

typedef struct { const char *path; char **argv; char **envp; } plan;
enum { ENV_KEEP, ENV_BIONIC, ENV_GLIBC };

/* 环境：去掉旧的 LD_PRELOAD，bionic 目标再补上 termux-exec */
/*
 * 经加载器起的程序，/proc/self/exe 指向加载器（bionic：linker64；glibc：APK 里的 ld.so），真实路径记进环境变量
 * （见下面的 readlink）：bionic 用 termux-exec 的 TERMUX_EXEC__PROC_SELF_EXE，glibc 用 CCAPP_SELF_EXE。
 * var=要改的变量（"X="），val=新值；val 为 0 表示删掉（程序是谁不知道时，别让旧值冒充）
 */
static char **fixenv2(char *const *envp, char **ev, int mode, arena *a, const char *var, const char *val) {
    int n = 0;
    for (int i = 0; envp && envp[i]; i++)
        if (!pre(envp[i], "LD_PRELOAD=") && !(var && pre(envp[i], var))) ev[n++] = envp[i];
    const char *bp = getenv("CCAPP_BIONIC_PRELOAD");
    if (mode == ENV_BIONIC && bp && *bp) { char *s = put(a, "LD_PRELOAD=", bp, 0); if (s) ev[n++] = s; }
    if (var && val) { char *s = put(a, var, val, 0); if (s) ev[n++] = s; }
    ev[n] = 0;
    return ev;
}
#define SELF_B "TERMUX_EXEC__PROC_SELF_EXE="
#define SELF_G "CCAPP_SELF_EXE="
static char **fixenv(char *const *envp, char **ev, int mode, arena *a) {
    int n = 0;
    for (int i = 0; envp && envp[i]; i++) if (!pre(envp[i], "LD_PRELOAD=")) ev[n++] = envp[i];
    const char *bp = getenv("CCAPP_BIONIC_PRELOAD");
    if (mode == ENV_BIONIC && bp && *bp) { char *s = put(a, "LD_PRELOAD=", bp, 0); if (s) ev[n++] = s; }
    ev[n] = 0;
    return ev;
}

/*
 * 算出真正要 exec 的东西。av / ev / a 都是调用方栈上的空间：
 * av 至少 argc + 24 格，ev 至少 envc + 2 格。返回 0 表示原样执行。
 */
static int mkplan(const char *path, char *const *argv, char *const *envp, char **av, char **ev, arena *a, plan *p) {
    const char *ld = getenv("CCAPP_LD");
    if (!ld || !*ld) return 0;                       /* 没开「经加载器」：什么都不改 */
    int argc = 0; while (argv && argv[argc]) argc++;
    /* 先把要跑的命令行放在 av 的后半段，每过一层脚本往前挪 */
    const int base = 20;
    int s = base, e = base;
    av[e++] = (char *)path;                          /* 槽 0 先放路径，最后再换成 argv[0] 或加载器 */
    for (int i = 1; i < argc; i++) av[e++] = argv[i];
    av[e] = 0;
    const char *cur = path, *argv0 = argc ? argv[0] : path;
    int scripted = 0;
    for (int depth = 0; depth < 5; depth++) {
        if (streq(cur, ld)) {                        /* 直接 exec APK 里的 ld.so（claude 包装脚本就这样）：原样，环境按 glibc 来（不许带回 bionic 的 LD_PRELOAD） */
            if (!scripted) { p->path = path; p->argv = (char **)argv; p->envp = fixenv2(envp, ev, ENV_GLIBC, a, SELF_G, 0); return 1; }
            av[s] = (char *)cur;
            p->path = cur; p->argv = av + s; p->envp = fixenv2(envp, ev, ENV_GLIBC, a, SELF_G, 0);
            return 1;
        }
        if (sysdir(cur)) {                           /* 系统程序：能直接 exec */
            /* bionic 这边也自己来：termux-exec 起系统脚本（如 /system/bin/pm）时会摘掉 LD_PRELOAD，
               脚本里再拉工具包里的同名程序（$PREFIX/bin/cmd）就被直接 exec、Permission denied */
            if (!scripted) {                         /* 原样执行，只把 termux-exec 塞进环境 */
                if (!getenv("CCAPP_BIONIC_PRELOAD")) return 0;
                p->path = path; p->argv = (char **)argv; p->envp = fixenv(envp, ev, ENV_BIONIC, a);
                return 1;
            }
            av[s] = (char *)cur;
            p->path = cur; p->argv = av + s; p->envp = fixenv(envp, ev, ENV_BIONIC, a);
            return 1;
        }
        char line[256];
        int k = kind(cur, line, sizeof line);
        if (k == K_SCRIPT) {
            char *q = line;
            while (*q == ' ' || *q == '\t') q++;
            char *ip = q; while (*q && *q != ' ' && *q != '\t') q++;
            char *arg = 0;
            if (*q) { *q++ = 0; while (*q == ' ' || *q == '\t') q++; if (*q) { arg = q; char *t = q + slen(q); while (t > q && (t[-1] == ' ' || t[-1] == '\t' || t[-1] == '\r')) *--t = 0; } }
            if (!*ip || s < 10) return 0;
            /* /usr/bin/env、/bin/bash 这类安卓上没有的解释器改指 $PREFIX/bin（与 termux-exec 一致） */
            const char *pf = getenv("PREFIX");
            const char *nm = pre(ip, "/usr/bin/") ? ip + 9 : pre(ip, "/bin/") ? ip + 5 : 0;
            if (nm && pf && !exists(ip)) { char *m = put(a, pf, "/bin/", nm); if (m) ip = m; }
            char *ipc = put(a, ip, 0, 0), *argc_ = arg ? put(a, arg, 0, 0) : 0;
            if (!ipc || (arg && !argc_)) return 0;
            av[s] = (char *)cur;                     /* 原来的槽 0 变成脚本路径 */
            if (argc_) av[--s] = argc_;
            av[--s] = ipc;
            cur = ipc; argv0 = ipc; scripted = 1;
            continue;
        }
        if (k == K_BIONIC) {
#ifdef BIONIC
            return 0;
#endif
            char *abs = (char *)cur;
            if (cur[0] != '/') {
                char cwd[512];
                if (sc(NR_getcwd, (long)cwd, sizeof cwd, 0, 0) <= 0) return 0;
                abs = put(a, cwd, "/", cur); if (!abs) return 0;
            }
            av[s] = abs;
            av[--s] = "/system/bin/linker64";
            p->path = "/system/bin/linker64"; p->argv = av + s; p->envp = fixenv2(envp, ev, ENV_BIONIC, a, SELF_B, abs);
            return 1;
        }
        if (k == K_GLIBC) {
            const char *lib = getenv("CCAPP_GLIBC_LIB"), *pl = getenv("CCAPP_GLIBC_PRELOAD");
            char *abs = (char *)cur;
            if (cur[0] != '/') {
                char cwd[512];
                if (sc(NR_getcwd, (long)cwd, sizeof cwd, 0, 0) <= 0) return 0;
                abs = put(a, cwd, "/", cur); if (!abs) return 0;
            }
            av[s] = abs;
            if (pl && *pl) { av[--s] = (char *)pl; av[--s] = "--preload"; }
            if (lib && *lib) { av[--s] = (char *)lib; av[--s] = "--library-path"; }
            av[--s] = (char *)argv0; av[--s] = "--argv0";
            av[--s] = (char *)ld;
            p->path = ld; p->argv = av + s; p->envp = fixenv2(envp, ev, ENV_GLIBC, a, SELF_G, abs);
            return 1;
        }
        if (k == K_LDSO) {                           /* 有人直接 exec 工具包里的 ld.so：换成 APK 里那份 */
            av[s] = (char *)ld;
            p->path = ld; p->argv = av + s; p->envp = fixenv2(envp, ev, ENV_GLIBC, a, SELF_G, 0);
            return 1;
        }
        return 0;                                    /* 静态程序 / 不认识的：原样 */
    }
    return 0;
}

#define PLAN_SPACE(argv, envp)                                              \
    int ac_ = 0, ec_ = 0;                                                   \
    while ((argv) && (argv)[ac_]) ac_++;                                    \
    while ((envp) && (envp)[ec_]) ec_++;                                    \
    char *av_[ac_ + 24]; /* 前 20 格留给加载器和解释器 */ char *ev_[ec_ + 3]; char buf_[2048];               \
    arena ar_ = { buf_, 0, sizeof buf_ }; plan pl_

static long raw_execve(const char *p, char *const *a, char *const *e) { return sc(NR_execve, (long)p, (long)a, (long)e, 0); }

#ifdef BIONIC
typedef int (*execve_fn)(const char *, char *const[], char *const[]);
static execve_fn next_execve;
#endif

/*
 * 经 linker64 起的程序，/proc/self/exe 指向 /system/bin/linker64（glibc 程序则是 APK 里的 ld.so）。按它找自己目录的程序就找错地方：
 * Chromium 去 /system/bin 找 icudtl.dat（报 Invalid file descriptor to ICU data），Yosys 去 /system/bin 找 yosys-abc；
 * Chromium 拉子进程还直接 exec /proc/self/exe。真实路径在 TERMUX_EXEC__PROC_SELF_EXE（termux-exec 和本库改写时都会写）
 */
#define NR_readlinkat 78
static const char *realself(void) {
    char b[512];
    long n = sc(NR_readlinkat, AT_FDCWD, (long)"/proc/self/exe", (long)b, sizeof b - 1);
    if (n <= 0) return 0;
    b[n] = 0;
#ifdef BIONIC
    if (!ends(b, "/linker64")) return 0;
    const char *e = getenv("TERMUX_EXEC__PROC_SELF_EXE");
#else
    const char *ld = getenv("CCAPP_LD");
    if (!ld || !ends(b, "libldlinux.so") || !ends(ld, "libldlinux.so")) return 0;
    const char *e = getenv("CCAPP_SELF_EXE");
#endif
    return e && *e == '/' ? e : 0;
}
static ssize_t fakelink(const char *p, char *buf, size_t sz) {
    if (!streq(p, "/proc/self/exe")) return -1;
    const char *e = realself();
    if (!e) return -1;
    size_t n = slen(e); if (n > sz) n = sz;
    for (size_t i = 0; i < n; i++) buf[i] = e[i];
    return (ssize_t)n;
}
ssize_t readlink(const char *p, char *buf, size_t sz) {
    ssize_t n = fakelink(p, buf, sz);
    if (n >= 0) return n;
    long r = sc(NR_readlinkat, AT_FDCWD, (long)p, (long)buf, (long)sz);
    if (r < 0) { ERRNO = (int)-r; return -1; }
    return r;
}
ssize_t readlinkat(int fd, const char *p, char *buf, size_t sz) {
    ssize_t n = p && p[0] == '/' ? fakelink(p, buf, sz) : -1;
    if (n >= 0) return n;
    long r = sc(NR_readlinkat, fd, (long)p, (long)buf, (long)sz);
    if (r < 0) { ERRNO = (int)-r; return -1; }
    return r;
}

int execve(const char *path, char *const argv[], char *const envp[]) {
    if (path && streq(path, "/proc/self/exe")) { const char *e = realself(); if (e) path = e; }
    PLAN_SPACE(argv, envp);
    if (mkplan(path, argv, envp, av_, ev_, &ar_, &pl_)) { ERRNO = (int)-raw_execve(pl_.path, pl_.argv, pl_.envp); return -1; }
#ifdef BIONIC
    if (!next_execve) next_execve = (execve_fn)dlsym(RTLD_NEXT, "execve");
    if (next_execve) return next_execve(path, argv, envp);
#endif
    ERRNO = (int)-raw_execve(path, argv, envp);
    return -1;
}

extern char **environ;

int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }

/* 在 PATH 里找；找不到返回 0。空项（开头、中间、结尾的冒号）是当前目录，同 execvp（审查 #108 09-007） */
static const char *which(const char *f, char *out, size_t cap) {
    if (has(f, '/')) return f;
    const char *P = getenv("PATH");
    if (!P) P = "/system/bin";
    size_t fl = slen(f);
    for (;;) {
        size_t n = 0;
        while (P[n] && P[n] != ':') n++;
        const char *d = n ? P : ".";
        size_t dl = n ? n : 1;
        if (dl + 1 + fl + 1 <= cap) {
            for (size_t i = 0; i < dl; i++) out[i] = d[i];
            out[dl] = '/';
            for (size_t i = 0; i <= fl; i++) out[dl + 1 + i] = f[i];
            if (exists(out)) return out;
        }
        if (!P[n]) break;
        P += n + 1;
    }
    return 0;
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    char tmp[1024];
    const char *p = which(file, tmp, sizeof tmp);
    if (!p) { ERRNO = ENOENT_; return -1; }
    return execve(p, argv, envp);
}

int execvp(const char *file, char *const argv[]) { return execvpe(file, argv, environ); }

#ifndef BIONIC   /* bionic 的 posix_spawn 在 libc 里头直接 execve，拦不到也不用拦 */
typedef int (*spawn_fn)(int *, const char *, const void *, const void *, char *const[], char *const[]);
static spawn_fn real_spawn, real_spawnp;

int posix_spawn(int *pid, const char *path, const void *fa, const void *at, char *const argv[], char *const envp[]) {
    if (!real_spawn) real_spawn = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
    PLAN_SPACE(argv, envp);
    if (mkplan(path, argv, envp, av_, ev_, &ar_, &pl_)) return real_spawn(pid, pl_.path, fa, at, pl_.argv, pl_.envp);
    return real_spawn(pid, path, fa, at, argv, envp);
}

int posix_spawnp(int *pid, const char *file, const void *fa, const void *at, char *const argv[], char *const envp[]) {
    if (!real_spawnp) real_spawnp = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");
    char tmp[1024];
    const char *p = getenv("CCAPP_LD") ? which(file, tmp, sizeof tmp) : 0;
    if (!p) return real_spawnp(pid, file, fa, at, argv, envp);
    return posix_spawn(pid, p, fa, at, argv, envp);
}
#endif

/*
 * seccomp-enosys-run —— seccomp-enosys.so 的「从进程外面」版本
 *
 * 为什么需要它：
 *   seccomp-enosys.so 靠 ld-linux 的 --preload 注入，只能挂在**_动态链接**的进程上。
 *   静态二进制（典型是 CGO_ENABLED=0 编出来的 Go 程序 —— gh / lazygit / kubectl /
 *   terraform / hugo …）没有动态加载器，这一招**根本没处挂**：
 *
 *       $ gh pr create --title t --body b
 *       SIGSYS: bad system call
 *       syscall.Syscall6(0x1b7, ...)          ← 0x1b7 = 439 = faccessat2
 *
 *   （实测：gh 的 LookPath 会用 faccessat2 逐个 PATH 目录探测可执行文件找 git，
 *     于是所有需要调用 git 的子命令全崩。而 gh api 不查找任何东西，一直正常 ——
 *     很容易被误判成「就个别命令有毛病」。）
 *
 * 做法：把同一件事从外面做一遍 —— ptrace 监督器。
 *   子进程 PTRACE_TRACEME 后 exec，父进程在信号停里看到 SIGSYS 且
 *   si_code == SYS_SECCOMP 时，把 x0 写成 -ENOSYS 再以 signal 0 放行。
 *   内核本来就没执行那次调用、PC 也已越过 svc，所以程序返回后就当收到了 ENOSYS。
 *
 *   和 on_sigsys 语义完全一致，但：
 *     - 不需要注入 → 静态二进制也能用
 *     - 不需要预先知道哪个 syscall 会被拦
 *     - 不依赖「必须存在一个老的等价 syscall」（逐字节改系统调用号就有这个依赖）
 *     - **完全不改动目标程序**（与 devkit「不需要二进制补丁」的原则一致）
 *
 * 开销：只有真的发生 SIGSYS 才会停一次，日常零开销（用的是 PTRACE_CONT，不是 PTRACE_SYSCALL）。
 *
 * 用法：
 *   seccomp-enosys-run <程序> [参数...]
 *   seccomp-enosys-run -v <程序> [参数...]     # 把每次拦截打到 stderr（排查用）
 *   seccomp-enosys-run -f <程序> [参数...]     # 跟进模式：fork/vfork/exec 出来的整棵进程树都罩住
 *
 * 跟进模式（-f）：
 *   用来罩住 claude 这种会层层拉起子进程的程序：claude → bash → 某个静态 Go 程序，最底下那个照样能救。
 *   - 每次 fork / vfork / exec 各多停一次（事件停），系统调用本身仍是零开销。
 *   - 动态链接的进程**不放手**：放手之后它再 fork 的孩子就不在监督下了，罩不住孙子辈的静态程序。
 *     它们自带 seccomp-enosys.so，被我们先截到 SIGSYS 也只是改成同样的 ENOSYS，语义不变。
 *   - 自己要用 ptrace 的工具（gdb / strace / ltrace / lldb / valgrind / proot，以及环境变量
 *     ENOSYS_RUN_DETACH 里冒号分隔的程序名）exec 时立刻放手，连同它之后拉起的子进程：
 *     被跟踪的进程不能再被别人跟踪，不放手的话 gdb 连自己的被调试程序都挂不上。
 *     自带 seccomp 沙箱、靠 SIGSYS 表达「拒绝即终止」的程序也可以写进去：放手后它的 TRAP 照原样生效。
 *   - 只改 si_errno == 0 的 SIGSYS（安卓应用过滤器的 TRAP 不带数据）；带数据的是程序自己的过滤器，原样投递。
 *   - 不设 EXITKILL：组长退出时监督器随之退出，剩下还在跑的后代由内核自动解除跟踪、继续运行，不会被连坐杀掉。
 *
 * 退出码：目标程序的退出码原样传递；被信号杀死时为 128+信号号。
 *
 * 已知限制：
 *   - 不带 -f 时只接管目标的线程（TRACECLONE）。它 fork/exec 出来的子进程不在监督下（Go 的 os/exec 走 vfork 式 clone），
 *     那些子进程要是也是静态二进制、也撞 seccomp，得自己再套一层（或者用 -f）。
 *   - 别的程序向整个进程组发的信号（kill -INT -pgid）目标会收到两次：一次直接收，一次经监督器转发。
 *     监督器分不出"只发给我"和"发给整组"。终端 Ctrl-C 由内核发（SI_KERNEL），不重复。
 *   - 发给目标的 SIGSTOP 不会让它真停住（无 PTRACE_SEIZE/LISTEN，组停会被监督循环放行）。
 */

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef __WALL
#define __WALL 0x40000000
#endif
#ifndef SI_KERNEL
#define SI_KERNEL 0x80
#endif
#ifndef PTRACE_O_TRACECLONE
#define PTRACE_O_TRACECLONE 0x00000008
#endif
#ifndef PTRACE_O_EXITKILL
#define PTRACE_O_EXITKILL 0x00100000
#endif
#ifndef PTRACE_EVENT_CLONE
#define PTRACE_EVENT_CLONE 3
#endif
#ifndef PTRACE_EVENT_EXEC
#define PTRACE_EVENT_EXEC 4
#endif
#ifndef PTRACE_O_TRACEFORK
#define PTRACE_O_TRACEFORK 0x00000002
#endif
#ifndef PTRACE_O_TRACEVFORK
#define PTRACE_O_TRACEVFORK 0x00000004
#endif
#ifndef PTRACE_O_TRACEEXEC
#define PTRACE_O_TRACEEXEC 0x00000010
#endif
#ifndef PTRACE_GETREGSET
#define PTRACE_GETREGSET 0x4204
#endif
#ifndef PTRACE_SETREGSET
#define PTRACE_SETREGSET 0x4205
#endif
#ifndef NT_PRSTATUS
#define NT_PRSTATUS 1
#endif

#define SYS_SECCOMP_CODE 1      /* SIGSYS 的 si_code：由 seccomp 过滤器触发 */
#define ENOSYS_ 38

/* arm64 的 NT_PRSTATUS 内容（struct user_pt_regs）。x0 = regs[0]。
   不包含 <sys/user.h>：bionic 上不一定有，而且这点结构自己写更稳。 */
struct arm64_regs {
    unsigned long regs[31];
    unsigned long sp;
    unsigned long pc;
    unsigned long pstate;
};

static int verbose = 0;
static int follow = 0;
static volatile pid_t g_leader = 0;

/* 已经接管过的线程号。PTRACE_O_TRACECLONE 带进来的新线程，内核保证它报上来的第一次停就是那次
   初始 SIGSTOP —— 这次停的 siginfo 是 si_code=SI_USER、si_pid=0（实测，Android 15 / 5.10），
   跟外面发来的 SIGSTOP 从 siginfo 上分不出来，只能靠「这个线程号是不是头一回见」认。
   不吞掉的话，每建一个线程都会让整个进程组停一次再被逐个放行（8 个线程实测 34 次停顿）。
   线程退出时移除：线程号会被复用。 */
static pid_t *known = NULL;
static size_t nknown = 0, capknown = 0;
static int is_known(pid_t p) {
    for (size_t i = 0; i < nknown; i++) if (known[i] == p) return 1;
    return 0;
}
static void add_known(pid_t p) {
    if (nknown == capknown) {
        size_t n = capknown ? capknown * 2 : 64;
        pid_t *k = realloc(known, n * sizeof *k);
        if (!k) return;                 /* 记不下就当它一直是"新的"：最坏退回原来的行为 */
        known = k; capknown = n;
    }
    known[nknown++] = p;
}
static void del_known(pid_t p) {
    for (size_t i = 0; i < nknown; i++) if (known[i] == p) { known[i] = known[--nknown]; return; }
}

/* 发给监督器的终止类信号转给目标。
   以前是直接忽略，靠"目标在同一进程组、会自己收到"——但只发给监督器的就丢了：
   `timeout 10 enosys-run gh …` 的 timeout 只给它直接拉起的进程（就是监督器）发 SIGTERM，结果永不超时。
   终端 Ctrl-C 之类内核发给整个前台进程组的（SI_KERNEL），目标已经收到，不再重复转发。 */
static void forward(int sig, siginfo_t *si, void *uc) {
    (void)uc;
    if (si && si->si_code == SI_KERNEL) return;
    if (g_leader > 0) kill(g_leader, sig);
}

static long get_syscall_nr(pid_t pid, siginfo_t *si) {
    (void)pid;
    /* siginfo 里带着被拦的系统调用号；不同 libc 的字段名不一样，用 memcpy 兜底 */
    long nr = -1;
#ifdef si_syscall
    nr = si->si_syscall;
#else
    /* struct: int signo, int errno, int code, [pad], unsigned long call_addr,
       int syscall, unsigned arch —— 取 offsetof 不现实，这里靠 bionic 的定义 */
#endif
    return nr;
}

/* 跟进模式：exec 之后是不是自己要用 ptrace 的工具 —— 是就放手（连同它以后的子进程） */
static int detach_name(const char *base) {
    static const char *builtin[] = { "gdb", "gdbserver", "strace", "ltrace", "lldb", "lldb-server",
                                     "valgrind", "proot", "seccomp-enosys-run", NULL };
    for (int i = 0; builtin[i]; i++) if (strcmp(base, builtin[i]) == 0) return 1;
    /* 版本号后缀（gdb-18.1、python3.13 这类）不算：只认完整程序名，宁可漏也别误放 */
    const char *extra = getenv("ENOSYS_RUN_DETACH");
    if (extra && *extra) {
        size_t bl = strlen(base);
        for (const char *p = extra; *p; ) {
            const char *e = strchr(p, ':');
            size_t l = e ? (size_t)(e - p) : strlen(p);
            if (l == bl && strncmp(p, base, l) == 0) return 1;
            if (!e) break;
            p = e + 1;
        }
    }
    return 0;
}

static const char *base_of(const char *p) { const char *b = strrchr(p, '/'); return b ? b + 1 : p; }

static int ends_with(const char *s, const char *t) {
    size_t a = strlen(s), b = strlen(t);
    return a >= b && strcmp(s + a - b, t) == 0;
}

/* 经加载器跑的（targetSdk 36：exec 垫片把 exec 改成 linker64 / APK 里的 glibc ld.so）：内核眼里的程序是加载器，
   真正的程序在命令行里 —— linker64 是第二个参数；glibc ld.so 跳过它自己的选项后第一个（审查 #108 09-006） */
static int loader_target(pid_t pid, char *out, size_t cap) {
    char path[64], buf[4096];
    snprintf(path, sizeof path, "/proc/%d/cmdline", (int)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) return 0;
    buf[n] = 0;
    static const char *withval[] = { "--argv0", "--library-path", "--preload", "--audit", "--inhibit-rpath",
                                     "--glibc-hwcaps-prepend", "--glibc-hwcaps-mask", NULL };
    char *p = buf, *end = buf + n;
    p += strlen(p) + 1;                              /* 跳过 argv[0]（加载器自己） */
    while (p < end) {
        if (strncmp(p, "--", 2) != 0) { snprintf(out, cap, "%s", p); return 1; }
        int skip = 0;
        for (int i = 0; withval[i]; i++) if (strcmp(p, withval[i]) == 0) skip = 1;
        p += strlen(p) + 1;
        if (skip && p < end) p += strlen(p) + 1;
    }
    return 0;
}

static int wants_ptrace(pid_t pid) {
    char path[64], exe[512];
    snprintf(path, sizeof path, "/proc/%d/exe", (int)pid);
    ssize_t n = readlink(path, exe, sizeof exe - 1);
    if (n <= 0) return 0;
    exe[n] = 0;
    const char *base = base_of(exe);
    if (detach_name(base)) return 1;
    if (strcmp(base, "linker64") == 0 || strcmp(base, "linker") == 0 ||
        ends_with(base, "libldlinux.so") || ends_with(base, "ld-linux-aarch64.so.1")) {
        char prog[512];
        if (loader_target(pid, prog, sizeof prog)) return detach_name(base_of(prog));
    }
    return 0;
}

/* 把 x0 写成 -ENOSYS。成功返回 0。 */
static int set_return_enosys(pid_t pid) {
    struct arm64_regs regs;
    struct iovec iov;
    memset(&regs, 0, sizeof regs);
    iov.iov_base = &regs;
    iov.iov_len = sizeof regs;

    if (ptrace(PTRACE_GETREGSET, pid, (void *)(long)NT_PRSTATUS, &iov) != 0) {
        return -1;
    }
    regs.regs[0] = (unsigned long)-ENOSYS_;
    iov.iov_len = sizeof regs;
    if (ptrace(PTRACE_SETREGSET, pid, (void *)(long)NT_PRSTATUS, &iov) != 0) {
        return -1;
    }
    return 0;
}

/* 监督循环：返回组长进程的退出码。 */
static int supervise(pid_t leader) {
    int status;
    pid_t pid;
    int exit_code = 127;

    while ((pid = waitpid(-1, &status, __WALL)) > 0) {
        if (WIFEXITED(status)) {
            if (pid == leader) exit_code = WEXITSTATUS(status);
            del_known(pid);
            if (follow && pid == leader) return exit_code;   /* 别等后台的后代：它们随我们退出自动解除跟踪 */
            continue;
        }
        if (WIFSIGNALED(status)) {
            if (pid == leader) exit_code = 128 + WTERMSIG(status);
            del_known(pid);
            if (follow && pid == leader) return exit_code;
            continue;
        }
        if (!WIFSTOPPED(status)) continue;

        int sig = WSTOPSIG(status);
        int deliver = sig;

        if (!is_known(pid)) {
            /* 新线程第一次报到：就是那次初始 SIGSTOP，放行不投递 */
            add_known(pid);
            if (sig == SIGSTOP) deliver = 0;
        } else if (sig == SIGTRAP && (status >> 16) != 0) {
            /* ptrace 事件停（clone / fork / vfork / exec）：不是信号，别投进目标程序。
               开了 TRACEEXEC 之后 exec 也走这里，所以剩下的裸 SIGTRAP 就是真信号，照常投递 */
            deliver = 0;
            if (follow && (status >> 16) == PTRACE_EVENT_EXEC && wants_ptrace(pid)) {
                if (verbose) fprintf(stderr, "[enosys] pid %d: exec 了要用 ptrace 的工具，放手\n", (int)pid);
                del_known(pid);
                ptrace(PTRACE_DETACH, pid, 0, 0);
                continue;
            }
        } else if (sig == SIGSYS) {
            siginfo_t si;
            memset(&si, 0, sizeof si);
            /* 只改安卓自己那层：它的过滤器是不带数据的 SECCOMP_RET_TRAP（si_errno = RET_DATA = 0）。
               程序自带沙箱（Chromium 一类）用 TRAP 时带非零数据、表示「拒绝」，原样投回去，别把它的拒绝降级成可恢复的 ENOSYS
               （审查 10-29 第六份 中2）。自带沙箱又用零数据的程序，把名字写进 ENOSYS_RUN_DETACH，exec 时整个放手 */
            if (ptrace(PTRACE_GETSIGINFO, pid, 0, &si) == 0 &&
                si.si_code == SYS_SECCOMP_CODE && si.si_errno == 0) {
                if (verbose) {
                    fprintf(stderr, "[enosys] pid %d: 拦下 syscall %ld → ENOSYS\n",
                            (int)pid, get_syscall_nr(pid, &si));
                }
                if (set_return_enosys(pid) == 0) {
                    deliver = 0;        /* 已经"返回"了 ENOSYS，别再投信号 */
                }
                /* 设置寄存器失败就按原样投递：退化成不介入，比吞掉信号安全 */
            }
        }

        if (ptrace(PTRACE_CONT, pid, 0, deliver) != 0) {
            if (errno == ESRCH) continue;   /* 线程刚好没了，无所谓 */
            perror("ptrace(PTRACE_CONT)");
            return 127;
        }
    }
    return exit_code;
}

static void usage(const char *argv0) {
    fprintf(stderr,
        "用法: %s [-v] <程序> [参数...]\n"
        "\n"
        "把被安卓 seccomp 拦下的系统调用改成返回 ENOSYS，让程序能优雅退回老接口。\n"
        "动态链接的程序用 seccomp-enosys.so（--preload），静态二进制用这个。\n"
        "\n"
        "  -v   把每次拦截打到 stderr\n"
        "  -f   跟进模式：它 fork / exec 出来的整棵进程树都罩住\n", argv0);
}

int main(int argc, char **argv) {
    int argi = 1;
    while (argi < argc && argv[argi][0] == '-' && argv[argi][1] != '\0') {
        if (strcmp(argv[argi], "-v") == 0 || strcmp(argv[argi], "--verbose") == 0) {
            verbose = 1;
            argi++;
        } else if (strcmp(argv[argi], "-f") == 0 || strcmp(argv[argi], "--follow") == 0) {
            follow = 1;
            argi++;
        } else if (strcmp(argv[argi], "-h") == 0 || strcmp(argv[argi], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            break;              /* 不认识的选项：交给目标程序自己解释 */
        }
    }
    if (argi >= argc) {
        usage(argv[0]);
        return 2;
    }

    fflush(NULL);               /* fork 前清干净，别让缓冲区被复制成两份 */

    /* ENOSYS_RUN_PIDFD=<fd>：把目标进程的 pid 写进这个 fd（网关拿它认出这一轮的 claude —— 发行版里 claude 不可转储，
       /proc 里看不见，这台内核也没有 /proc/<pid>/task/<tid>/children 可查，见 gateway/gw/run.mjs privWitness）。
       子进程里关掉它、摘掉变量：claude 起的东西里再套一层监督器时别往一个不相干的 fd 里写 */
    int pidfd = -1;
    { const char *pf = getenv("ENOSYS_RUN_PIDFD"); if (pf) { pidfd = atoi(pf); if (pidfd <= 2) pidfd = -1; } unsetenv("ENOSYS_RUN_PIDFD"); }
    /* 网关起的（带 ENOSYS_RUN_PIDFD）：网关没了就跟着走。claude 的 PDEATHSIG 指向的是这一层（nodump.c），
       这层不跟着走，网关崩了 claude 那棵树会一直跑到下次起网关才被清（DeepSeek 复核 v067 建议 5）。
       终端里用户自己套的监督器不设：nohup / 后台跑的程序不该因为启动它的 shell 退出而被杀 */
    if (pidfd >= 0) {
        pid_t pp = getppid();
        prctl(PR_SET_PDEATHSIG, SIGKILL);
        if (getppid() != pp) return 127;     /* 设之前网关已经没了 */
    }

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 127;
    }

    if (pid > 0 && pidfd >= 0) { dprintf(pidfd, "%d\n", (int)pid); close(pidfd); }
    if (pid == 0) {
        /* 子进程 */
        if (pidfd >= 0) close(pidfd);
        if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) {
            /* 拦不住跟踪就照常跑 —— 退化成"没有这个工具"，而不是拒绝启动。
               某些 SELinux 策略会拒绝，这里不该因此把用户挡在门外。 */
            fprintf(stderr, "[enosys] 警告: PTRACE_TRACEME 失败(%s)，将不做拦截\n",
                    strerror(errno));
        }
        execvp(argv[argi], &argv[argi]);
        fprintf(stderr, "%s: 无法执行 %s: %s\n", argv[0], argv[argi], strerror(errno));
        _exit(127);
    }

    /* 父进程：先等 exec 后的初始 SIGTRAP，再设选项 */
    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 127;
    }
    /* exec 之前到的信号也会先停一次：不是 exec 的 SIGTRAP 就原样投回去、接着等，别吞掉（11-04 报告 二） */
    for (int i = 0; i < 64 && WIFSTOPPED(status) && WSTOPSIG(status) != SIGTRAP; i++) {
        if (ptrace(PTRACE_CONT, pid, 0, (void *)(long)WSTOPSIG(status)) != 0) break;
        while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) { perror("waitpid"); return 127; }
    }
    if (!WIFSTOPPED(status)) {
        /* 还没进跟踪就结束了（比如 exec 失败） */
        /* 被信号结束的照 shell 的规矩报 128+信号（审查 #108 09-008）：以前一律 127，和「找不到命令」混在一起 */
        return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 127;
    }
    /* 跟进模式下，一上来跑的就是 gdb / strace 这类要自己 ptrace 的：同中途 exec 到它们时一样放手（见 supervise），
       不然它 fork 出的被调试程序被我们先跟上了，它自己 attach 不上（11-04 报告 二） */
    if (follow && wants_ptrace(pid)) {
        if (verbose) fprintf(stderr, "[enosys] pid %d 自己要用 ptrace，放手\n", (int)pid);
        ptrace(PTRACE_DETACH, pid, 0, 0);
        while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) { perror("waitpid"); return 127; }
        return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 127;
    }

    add_known(pid);
    /* 跟进模式不设 EXITKILL：监督器退出时后代自动解除跟踪继续跑，别连坐杀掉后台进程 */
    long opts = follow ? (PTRACE_O_TRACECLONE | PTRACE_O_TRACEEXEC | PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK)
                       : (PTRACE_O_TRACECLONE | PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL);
    if (ptrace(PTRACE_SETOPTIONS, pid, 0, (void *)opts) != 0) {
        perror("ptrace(PTRACE_SETOPTIONS)");
        return 127;
    }
    /* 自己不能被这些信号打死（要活着带回退出码），收到就转给目标，见 forward() */
    g_leader = pid;
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = forward;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    sigaction(SIGQUIT, &sa, NULL);

    if (ptrace(PTRACE_CONT, pid, 0, 0) != 0) {
        perror("ptrace(PTRACE_CONT)");
        return 127;
    }
    return supervise(pid);
}

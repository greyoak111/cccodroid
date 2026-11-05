/*
 * libccnodump.so —— 让网关和网关起的 claude 「不可转储」（安全 4 第 3 层）。
 *
 * 为什么：网关、claude、会话里跑的命令、终端都是同一个 uid。同 uid 的进程能 ptrace、能读写 /proc/<pid>/mem，
 * 不用换任何文件就能直接改正在跑的网关 / claude 的内存（11-05 实测读出了网关 node 的 ELF 头）。
 * prctl(PR_SET_DUMPABLE, 0) 之后，内核把这个进程的 /proc 条目归给 root：同 uid 的进程 ptrace、读写 mem、读 environ 都被拒，
 * 安卓的 /proc 挂了 hidepid=2，连这个进程本身都看不见了（要 CAP_SYS_PTRACE 才行）。exec 之后标志复位，子进程照旧可转储。
 *
 * 只对带 CCAPP_NODUMP=1 的进程生效（应用起网关、网关起 claude 时给），用户自己跑的程序不受影响；
 * 生效后把这个变量原地改成 0，子进程不跟着变。
 * 同时设 PR_SET_PDEATHSIG=SIGKILL：拉起它的那个线程没了它跟着走 —— 不可转储的孤儿（网关没了还在跑的 claude、
 * 应用没了还在跑的网关）谁也看不见、杀不掉，不能留。
 *
 * 不依赖任何 libc（直接发 prctl），glibc（claude 经 ld.so --preload）与 bionic（网关经 LD_PRELOAD）都能载。
 * 构造函数的 (argc, argv, envp) 两边的加载器都会传。
 */
#define NR_prctl 167
#define PR_SET_PDEATHSIG 1
#define PR_SET_DUMPABLE 4
#define SIGKILL_ 9

static long raw2(long n, long a, long b) {
    register long x8 __asm__("x8") = n;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1) : "memory");
    return x0;
}

__attribute__((constructor)) static void nodump(int argc, char **argv, char **envp) {
    (void)argc; (void)argv;
    if (!envp) return;
    static const char key[] = "CCAPP_NODUMP=";
    for (char **e = envp; *e; e++) {
        const char *s = *e;
        int i = 0;
        while (key[i] && s[i] == key[i]) i++;
        if (key[i]) continue;
        char v = s[i];
        if (v == '1' && s[i + 1] == 0) {
            raw2(NR_prctl, PR_SET_PDEATHSIG, SIGKILL_);
            raw2(NR_prctl, PR_SET_DUMPABLE, 0);
            (*e)[i] = '0';
        }
        return;
    }
}

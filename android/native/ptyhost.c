/* ptyhost —— 给网关的应用内终端开一个伪终端。
 *
 * node 没有 pty（node-pty 是原生模块，得为每个 node 版本编），所以由这个小程序代劳：
 *   ptyhost <rows> <cols> <程序> [参数…]
 * 在新会话里 fork 出程序，它的 stdin/stdout/stderr 都是 pty 的从端；
 *   本进程 stdin  → pty（键盘输入原样转过去）
 *   pty           → 本进程 stdout（终端输出原样转回来）
 *   fd 3 一行一条 "rows cols\n" → 改窗口大小（TIOCSWINSZ，子进程收到 SIGWINCH）
 * 子进程退出 → 把剩余输出排干后以同样的退出码退出；stdin 关闭（网关不要它了）→ 给整个会话发 SIGHUP。
 * 只用 posix_openpt 那一套，不依赖 forkpty（老 API 级别的 bionic 没有）。 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static int wr(int fd, const char *p, ssize_t n) {
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    p += w; n -= w;
  }
  return 0;
}

static void setsize(int fd, int rows, int cols) {
  struct winsize ws;
  memset(&ws, 0, sizeof ws);
  ws.ws_row = rows > 0 ? rows : 24;
  ws.ws_col = cols > 0 ? cols : 80;
  ioctl(fd, TIOCSWINSZ, &ws);
}

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: ptyhost rows cols prog [args...]\n"); return 2; }
  int rows = atoi(argv[1]), cols = atoi(argv[2]);

  /* 先看 fd 3 在不在：不在的话下面 posix_openpt 会拿到 3，被误当成控制管道 */
  int ctl = fcntl(3, F_GETFD) >= 0 ? 3 : -1;
  int m = posix_openpt(O_RDWR | O_NOCTTY);
  if (m < 0 || grantpt(m) < 0 || unlockpt(m) < 0) { perror("ptyhost: openpt"); return 1; }
  char sname[128];
  int pr = ptsname_r(m, sname, sizeof sname);   /* 返回的是错误号，不设 errno：perror 会打出不相干的原因（11-04 报告 二） */
  if (pr != 0) { fprintf(stderr, "ptyhost: ptsname: %s\n", strerror(pr)); return 1; }
  setsize(m, rows, cols);

  pid_t pid = fork();
  if (pid < 0) { perror("ptyhost: fork"); return 1; }
  if (pid == 0) {
    setsid();
    int s = open(sname, O_RDWR);
    if (s < 0) { perror("ptyhost: open slave"); _exit(127); }
    ioctl(s, TIOCSCTTY, 0);
    dup2(s, 0); dup2(s, 1); dup2(s, 2);
    if (s > 2) close(s);
    close(m);
    if (ctl >= 0) close(ctl);
    signal(SIGPIPE, SIG_DFL);
    execvp(argv[3], argv + 3);
    fprintf(stderr, "ptyhost: exec %s: %s\r\n", argv[3], strerror(errno));
    _exit(127);
  }

  signal(SIGPIPE, SIG_IGN);
  char buf[16384], line[64];
  size_t ll = 0;
  int in_open = 1;
  for (;;) {
    struct pollfd p[3];
    int n = 0;
    p[n].fd = m; p[n].events = POLLIN; n++;
    int iin = -1, ictl = -1;
    if (in_open) { iin = n; p[n].fd = 0; p[n].events = POLLIN; n++; }
    if (ctl >= 0) { ictl = n; p[n].fd = ctl; p[n].events = POLLIN; n++; }
    if (poll(p, n, -1) < 0) { if (errno == EINTR) continue; break; }

    if (p[0].revents) {
      ssize_t r = read(m, buf, sizeof buf);
      if (r > 0) { if (wr(1, buf, r) < 0) break; }
      else if (r < 0 && errno == EINTR) continue;
      else break;                               /* EIO：从端全关了，子进程（及其后代）都走了 */
    }
    if (iin >= 0 && p[iin].revents) {
      ssize_t r = read(0, buf, sizeof buf);
      if (r > 0) wr(m, buf, r);
      else if (r == 0 || (r < 0 && errno != EINTR)) {
        /* 网关关掉了终端：先 SIGHUP；交互式 mksh 会忽略它，1 秒后整组 SIGKILL */
        in_open = 0;
        kill(-pid, SIGHUP); kill(pid, SIGHUP);
        close(m);
        for (int i = 0; i < 10 && waitpid(pid, NULL, WNOHANG) == 0; i++) usleep(100000);
        kill(-pid, SIGKILL); kill(pid, SIGKILL);
        waitpid(pid, NULL, WNOHANG);
        return 129;
      }
    }
    if (ictl >= 0 && p[ictl].revents) {
      ssize_t r = read(ctl, buf, sizeof buf);
      if (r < 0 && errno == EINTR) continue;   /* 被信号打断不是管道关了，别从此不再调窗口大小（11-04 报告 二） */
      if (r <= 0) { ctl = -1; continue; }
      for (ssize_t i = 0; i < r; i++) {
        if (buf[i] == '\n') {
          line[ll] = 0; ll = 0;
          int a = 0, b = 0;
          if (sscanf(line, "%d %d", &a, &b) == 2) {
            setsize(m, a, b);
            kill(-pid, SIGWINCH);
          }
        } else if (ll < sizeof line - 1) line[ll++] = buf[i];
      }
    }
  }
  int st = 0;
  if (waitpid(pid, &st, WNOHANG) == 0) {
    /* 和上面网关关终端那条一致：SIGHUP 后最多等 1 秒，不走就整组 SIGKILL，别在阻塞 waitpid 上永远挂着（审查 10-29 第六份 低6） */
    kill(-pid, SIGHUP); kill(pid, SIGHUP);
    pid_t w = 0;
    for (int i = 0; i < 10 && (w = waitpid(pid, &st, WNOHANG)) == 0; i++) usleep(100000);
    if (w == 0) { kill(-pid, SIGKILL); kill(pid, SIGKILL); waitpid(pid, &st, 0); }
  }
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
  return 0;
}

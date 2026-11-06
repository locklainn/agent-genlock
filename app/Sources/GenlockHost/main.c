// Keeps a session alive when the app is not. One host owns one program on one pseudo-terminal, and
// outlives the app, which only ever attaches to it. A running host survives the app being replaced,
// so a new app must keep talking to old hosts: frames may be added, and unknown ones are ignored.
//
//   genlock-host run <socket> <folder> -- <command...>   attach, starting the host first if needed
//   genlock-host probe <socket>                          exit 0 if a host is listening
//   genlock-host kill <socket>                           end the program

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <util.h>

enum { F_DATA = 1, F_REPLAY_END = 2, F_EXIT = 3, F_ATTACH = 10, F_INPUT = 11, F_RESIZE = 12, F_KILL = 13 };
enum { HEADER = 5, CHUNK = 65536, RING = 4 << 20, INPUT = 1 << 20, MAX_MODES = 64 };

static double now_s(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static void put_header(uint8_t *h, uint8_t type, uint32_t len) {
    h[0] = type;
    memcpy(h + 1, &len, 4);
}

static int write_all(int fd, const void *data, size_t len) {
    const uint8_t *p = data;
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static int read_all(int fd, void *data, size_t len) {
    uint8_t *p = data;
    while (len > 0) {
        ssize_t n = read(fd, p, len);
        if (n == 0) return -1;
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static int send_frame(int fd, uint8_t type, const void *data, uint32_t len) {
    uint8_t h[HEADER];
    put_header(h, type, len);
    if (write_all(fd, h, HEADER) < 0) return -1;
    return len ? write_all(fd, data, len) : 0;
}

// A socket's path is limited to about 100 bytes, and Application Support paths get close, so both
// ends move into its folder and use the bare name.
static const char *enter_folder_of(const char *path) {
    const char *slash = strrchr(path, '/');
    if (!slash) return path;
    char dir[4096];
    size_t n = (size_t)(slash - path);
    if (n == 0 || n >= sizeof dir) return path;
    memcpy(dir, path, n);
    dir[n] = 0;
    if (chdir(dir) < 0) return path;
    return slash + 1;
}

static void fill_addr(struct sockaddr_un *a, const char *name) {
    memset(a, 0, sizeof *a);
    a->sun_family = AF_UNIX;
    strncpy(a->sun_path, name, sizeof a->sun_path - 1);
}

static int connect_to(const char *name) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un a;
    fill_addr(&a, name);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

// MARK: The host

static uint8_t ring[RING];
static uint64_t written;

// Modes a program sets once at startup can scroll out of the ring, and a new terminal needs them
// or keys and pastes arrive wrong.
static struct { int mode, on; } modes[MAX_MODES];
static int mode_count, kitty_on, kitty_flags;
static int scan_state, scan_num, scan_params[8], scan_count;

static void set_mode(int mode, int on) {
    for (int i = 0; i < mode_count; i++) {
        if (modes[i].mode == mode) { modes[i].on = on; return; }
    }
    if (mode_count < MAX_MODES) { modes[mode_count].mode = mode; modes[mode_count].on = on; mode_count++; }
}

static void scan(uint8_t c) {
    switch (scan_state) {
    case 0: if (c == 27) scan_state = 1; break;
    case 1: scan_state = c == '[' ? 2 : (c == 27 ? 1 : 0); break;
    case 2:
        scan_num = 0;
        scan_count = 0;
        scan_state = c == '?' ? 3 : (c == '>' ? 4 : (c == '<' ? 5 : (c == 27 ? 1 : 0)));
        break;
    case 3:
        if (c >= '0' && c <= '9') { scan_num = scan_num * 10 + (c - '0'); break; }
        if (scan_count < 8) scan_params[scan_count++] = scan_num;
        scan_num = 0;
        if (c == ';') break;
        if (c == 'h' || c == 'l') for (int i = 0; i < scan_count; i++) set_mode(scan_params[i], c == 'h');
        scan_state = c == 27 ? 1 : 0;
        break;
    case 4:
        if (c >= '0' && c <= '9') { scan_num = scan_num * 10 + (c - '0'); break; }
        if (c == 'u') { kitty_on = 1; kitty_flags = scan_num; }
        scan_state = c == 27 ? 1 : 0;
        break;
    case 5:
        if (c >= '0' && c <= '9') break;
        if (c == 'u') kitty_on = 0;
        scan_state = c == 27 ? 1 : 0;
        break;
    }
}

static void record(const uint8_t *data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        ring[(written + i) % RING] = data[i];
        scan(data[i]);
    }
    written += len;
}

static uint64_t ring_start(void) { return written > RING ? written - RING : 0; }

static size_t mode_prefix(char *out, size_t room) {
    size_t n = 0;
    for (int i = 0; i < mode_count; i++) {
        if (modes[i].on && n + 16 < room) n += (size_t)snprintf(out + n, room - n, "\033[?%dh", modes[i].mode);
    }
    if (kitty_on && n + 16 < room) n += (size_t)snprintf(out + n, room - n, "\033[>%du", kitty_flags);
    return n;
}

static int client = -1, send_replay_end;
static uint64_t client_at, replay_until;
static uint8_t out[HEADER + CHUNK];
static size_t out_len, out_sent;

static void drop_client(void) {
    if (client >= 0) close(client);
    client = -1;
    out_len = out_sent = 0;
}

// A wrapped ring begins mid-line and perhaps mid-escape, so start from the next whole line.
static void begin_attach(int fd) {
    drop_client();
    client = fd;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    client_at = ring_start();
    if (written > RING) {
        for (uint64_t i = client_at; i < written; i++) {
            if (ring[i % RING] == '\n') { client_at = i + 1; break; }
        }
    }
    replay_until = written;
    send_replay_end = 1;
    size_t n = mode_prefix((char *)out + HEADER, CHUNK);
    put_header(out, F_DATA, (uint32_t)n);
    out_len = HEADER + n;
    out_sent = 0;
}

static void fill_out(int child_gone, int status_code, int *exit_sent) {
    if (out_sent < out_len) return;
    out_len = out_sent = 0;
    if (client_at < ring_start()) client_at = ring_start(); // too far behind: keep up, lose the oldest
    if (client_at < written) {
        uint64_t left = written - client_at;
        if (send_replay_end && replay_until > client_at && left > replay_until - client_at) left = replay_until - client_at;
        size_t offset = (size_t)(client_at % RING);
        size_t n = left < CHUNK ? (size_t)left : CHUNK;
        if (n > (size_t)RING - offset) n = (size_t)RING - offset;
        memcpy(out + HEADER, ring + offset, n);
        put_header(out, F_DATA, (uint32_t)n);
        out_len = HEADER + n;
        client_at += n;
    } else if (send_replay_end) {
        put_header(out, F_REPLAY_END, 0);
        out_len = HEADER;
        send_replay_end = 0;
    } else if (child_gone && !*exit_sent) {
        int32_t code = status_code;
        memcpy(out + HEADER, &code, 4);
        put_header(out, F_EXIT, 4);
        out_len = HEADER + 4;
        *exit_sent = 1;
    }
}

static void host_loop(int listener, int master, pid_t child, const char *socket_name) {
    static uint8_t input[INPUT];
    size_t input_len = 0;
    int child_gone = 0, status_code = 0, exit_sent = 0;
    double kill_at = 0, leave_at = 0;

    fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);

    for (;;) {
        if (client >= 0) fill_out(child_gone, status_code, &exit_sent);
        struct pollfd p[3];
        p[0] = (struct pollfd){ listener, POLLIN, 0 };
        p[1] = (struct pollfd){ master, (short)((master >= 0 ? POLLIN : 0) | (input_len ? POLLOUT : 0)), 0 };
        p[2] = (struct pollfd){ client, (short)((input_len + HEADER + CHUNK < INPUT ? POLLIN : 0) | (out_sent < out_len ? POLLOUT : 0)), 0 };
        poll(p, 3, 250);

        if (!child_gone) {
            int status;
            if (waitpid(child, &status, WNOHANG) == child) {
                child_gone = 1;
                status_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                leave_at = now_s() + 5;
            }
        }
        if (kill_at && !child_gone && now_s() > kill_at) kill(-child, SIGKILL);

        if (master >= 0 && (p[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            static uint8_t buf[CHUNK];
            ssize_t n = read(master, buf, sizeof buf);
            if (n > 0) record(buf, (size_t)n);
            else if (n == 0 || (errno != EAGAIN && errno != EINTR)) { close(master); master = -1; }
        }
        if (master >= 0 && input_len && (p[1].revents & POLLOUT)) {
            ssize_t n = write(master, input, input_len);
            if (n > 0) { memmove(input, input + n, input_len - (size_t)n); input_len -= (size_t)n; }
        }

        if (client >= 0 && (p[2].revents & POLLOUT) && out_sent < out_len) {
            ssize_t n = write(client, out + out_sent, out_len - out_sent);
            if (n > 0) out_sent += (size_t)n;
            else if (n < 0 && errno != EAGAIN && errno != EINTR) drop_client();
        }

        if (client >= 0 && (p[2].revents & (POLLIN | POLLHUP | POLLERR))) {
            uint8_t h[HEADER];
            ssize_t n = recv(client, h, HEADER, MSG_PEEK);
            if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                drop_client();
            } else if (n == HEADER) {
                uint32_t len;
                memcpy(&len, h + 1, 4);
                static uint8_t frame[HEADER + CHUNK];
                if (len > CHUNK) {
                    drop_client();
                } else if (recv(client, frame, HEADER + len, MSG_PEEK) == (ssize_t)(HEADER + len)) {
                    recv(client, frame, HEADER + len, 0);
                    if (h[0] == F_INPUT && input_len + len <= INPUT) {
                        memcpy(input + input_len, frame + HEADER, len);
                        input_len += len;
                    } else if (h[0] == F_RESIZE && len == 4 && master >= 0) {
                        struct winsize ws = {0};
                        uint16_t size[2];
                        memcpy(size, frame + HEADER, 4);
                        ws.ws_row = size[0];
                        ws.ws_col = size[1];
                        ioctl(master, TIOCSWINSZ, &ws);
                        // Always, because a program repaints on this and a new terminal needs that.
                        if (!child_gone) kill(-child, SIGWINCH);
                    }
                }
            }
        }

        if (p[0].revents & POLLIN) {
            int fd = accept(listener, NULL, NULL);
            if (fd >= 0) {
                // The first frame says what it wants, and only attaching displaces the current client.
                struct timeval limit = { 1, 0 };
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, sizeof limit);
                uint8_t h[HEADER];
                if (read_all(fd, h, HEADER) < 0) {
                    close(fd);
                } else if (h[0] == F_ATTACH) {
                    struct timeval forever = { 0, 0 };
                    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &forever, sizeof forever);
                    begin_attach(fd);
                } else {
                    if (h[0] == F_KILL && !child_gone) {
                        kill(-child, SIGHUP);
                        kill_at = now_s() + 3;
                    }
                    close(fd);
                }
            }
        }

        if (child_gone) {
            if (client < 0 || (exit_sent && out_sent == out_len) || now_s() > leave_at) {
                unlink(socket_name);
                _exit(0);
            }
        }
    }
}

static void become_host(int listener, const char *socket_name, const char *folder, char **command, struct winsize ws, mode_t old_umask) {
    setsid();
    if (fork() != 0) _exit(0);
    signal(SIGHUP, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);
    for (int fd = 3; fd < 256; fd++) if (fd != listener) close(fd);
    int null = open("/dev/null", O_RDWR);
    if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }

    int master;
    pid_t child = forkpty(&master, NULL, NULL, ws.ws_col ? &ws : NULL);
    if (child < 0) _exit(1);
    if (child == 0) {
        close(listener);
        signal(SIGHUP, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        umask(old_umask);
        if (chdir(folder) < 0) {
            fprintf(stderr, "genlock-host: cannot enter %s: %s\r\n", folder, strerror(errno));
            _exit(127);
        }
        execvp(command[0], command);
        fprintf(stderr, "genlock-host: cannot run %s: %s\r\n", command[0], strerror(errno));
        _exit(127);
    }
    host_loop(listener, master, child, socket_name);
}

// MARK: The attached end

static volatile sig_atomic_t window_changed = 1;
static void on_winch(int sig) { (void)sig; window_changed = 1; }

static void send_size(int fd) {
    struct winsize ws;
    if (ioctl(0, TIOCGWINSZ, &ws) < 0 || ws.ws_col == 0) return;
    uint16_t size[2] = { ws.ws_row, ws.ws_col };
    send_frame(fd, F_RESIZE, size, 4);
}

static int attach(int fd) {
    if (isatty(0)) {
        struct termios t;
        tcgetattr(0, &t);
        cfmakeraw(&t);
        tcsetattr(0, TCSANOW, &t);
    }
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa = {0};
    sa.sa_handler = on_winch;
    sigaction(SIGWINCH, &sa, NULL);
    if (send_frame(fd, F_ATTACH, NULL, 0) < 0) return 1;

    // Replaying old output makes a terminal answer old questions, such as where the cursor is. Those
    // answers are not typing, so input only counts once the replay has been taken in.
    int replaying = 1;
    double discard_until = 0;
    static uint8_t buf[CHUNK];

    for (;;) {
        if (window_changed) { window_changed = 0; send_size(fd); }
        struct pollfd p[2] = { { 0, POLLIN, 0 }, { fd, POLLIN, 0 } };
        if (poll(p, 2, -1) < 0) {
            if (errno == EINTR) continue;
            return 1;
        }
        if (p[0].revents & (POLLIN | POLLHUP)) {
            ssize_t n = read(0, buf, sizeof buf);
            if (n <= 0) return 0; // the app went away; the host carries on
            if (!replaying && now_s() >= discard_until) send_frame(fd, F_INPUT, buf, (uint32_t)n);
        }
        if (p[1].revents & (POLLIN | POLLHUP)) {
            uint8_t h[HEADER];
            if (read_all(fd, h, HEADER) < 0) return 1;
            uint32_t len;
            memcpy(&len, h + 1, 4);
            if (len > CHUNK || read_all(fd, buf, len) < 0) return 1;
            if (h[0] == F_DATA) {
                if (write_all(1, buf, len) < 0) return 0;
            } else if (h[0] == F_REPLAY_END) {
                replaying = 0;
                discard_until = now_s() + 0.3;
            } else if (h[0] == F_EXIT && len == 4) {
                int32_t code;
                memcpy(&code, buf, 4);
                return code;
            }
        }
    }
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: genlock-host run|probe|kill <socket> ...\n");
        return 2;
    }
    const char *verb = argv[1];
    char *full_path = argv[2];
    const char *name = enter_folder_of(full_path);

    if (strcmp(verb, "probe") == 0) {
        int fd = connect_to(name);
        if (fd < 0) return 1;
        close(fd);
        return 0;
    }
    if (strcmp(verb, "kill") == 0) {
        int fd = connect_to(name);
        if (fd < 0) return 1;
        send_frame(fd, F_KILL, NULL, 0);
        close(fd);
        return 0;
    }
    if (strcmp(verb, "run") != 0 || argc < 6 || strcmp(argv[4], "--") != 0) {
        fprintf(stderr, "usage: genlock-host run <socket> <folder> -- <command...>\n");
        return 2;
    }

    int fd = connect_to(name);
    if (fd < 0) {
        unlink(name);
        mode_t old_umask = umask(077);
        int listener = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un a;
        fill_addr(&a, name);
        if (listener < 0 || bind(listener, (struct sockaddr *)&a, sizeof a) < 0 || listen(listener, 8) < 0) {
            fprintf(stderr, "genlock-host: cannot listen at %s: %s\r\n", full_path, strerror(errno));
            return 1;
        }
        struct winsize ws = {0};
        ioctl(0, TIOCGWINSZ, &ws);
        pid_t first = fork();
        if (first < 0) return 1;
        if (first == 0) become_host(listener, name, argv[3], argv + 5, ws, old_umask);
        waitpid(first, NULL, 0);
        close(listener);
        umask(old_umask);
        fd = connect_to(name);
        if (fd < 0) {
            fprintf(stderr, "genlock-host: the host did not start\r\n");
            return 1;
        }
    }
    return attach(fd);
}

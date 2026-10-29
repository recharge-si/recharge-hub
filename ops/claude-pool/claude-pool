#!/usr/bin/env python3
r"""claude-pool: run `claude` on whichever of your accounts has the most usage left.

Drop-in for the Claude Code CLI: `claude-pool -p "hi" --output-format json` takes the same arguments and prints
the same output as `claude`. Before each run it picks a free account, and in print mode (-p) a run cut off by a
usage limit is rerun on the next free account (by default only when it ran no tools yet). An interactive session
that hits a usage limit goes on by itself on the next free account: same conversation, resumed with a nudge.

Accounts: one file per account in $CLAUDE_POOL_DIR (default ~/.config/claude-pool, on Windows %APPDATA%\claude-pool):
  <name>.token   an OAuth token from `claude setup-token` (Claude subscription)
  <name>.key     an Anthropic API key
  <name>.dir     the path of a claude config folder that is logged in (CLAUDE_CONFIG_DIR)
Accounts logged in to Orca join by themselves in interactive sessions, as orca-<name>.
Rename a file to <name>.token.off to take the account out. The folder is reread on every run. With no files,
claude-pool runs claude with your normal login, so it is safe to install before you add any accounts.

Usage is read from the `rate_limit_event` that `claude -p --output-format stream-json --verbose` emits, so in
print mode claude-pool always runs claude that way and converts the output back to the format you asked for.
It is kept in $CLAUDE_POOL_STATE, shared by every caller under a file lock. Numbers older than CLAUDE_POOL_FRESH
seconds are refreshed before a pick with one tiny Haiku call per account, so use by other apps is seen too.

`claude-pool --pool-help` lists the commands and settings.
"""
import getpass
import io
import json
import math
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timezone

WINDOWS = os.name == "nt"
if WINDOWS:
    import ctypes
    import msvcrt
else:
    import fcntl

__version__ = "0.16.2"

EXIT_EXHAUSTED = 75  # EX_TEMPFAIL: every account is at its limit, try again after the reset
RUN_MAX_AGE = 6 * 3600  # a "running" mark older than this is dropped even if its pid can't be checked
ALERT_EVENTS = {"exhausted", "token_broken", "cli_changed", "cut_off_not_rerun"}
ALERT_EVERY = 3600  # the same alert (event + account) at most once an hour
HOST = socket.gethostname()

HELP = """claude-pool {version}: runs claude on whichever of your accounts has usage left.

Use it like claude:   claude-pool -p "hi" --output-format json

Commands:
  --pool-help              this help
  --pool-status            accounts with their usage; "next" is used next
  --pool-refresh [name..]  check usage of every account (or the named ones) now
  --pool-watch [minutes]   --pool-refresh every few minutes (default 5) until Ctrl+C
  --pool-check             check the setup: claude, folders, permissions, every token
  --pool-add <name>        add an account; paste the token from `claude setup-token`
                           (or pipe it: echo "$TOKEN" | claude-pool --pool-add work)
  --pool-off <name>        take an account out (renames it to .off)
  --pool-on <name>         put it back
  --pool-log [N]           the last N events (default 20): runs, switches, errors
  --pool-switch [name]     inside a session (a `!` command or claude's Bash): move it to the named account, or
                           the best free one; typing /pool:switch [name] in the session does the same
                           (and /pool:status, /pool:log [N] show those two in the session)
  --pool-same <a> <b>..    these accounts are one (a token and the same login in Orca): they share usage numbers
  --pool-capacity <r>     what 1 to 100 accounts would hold if one 5-hour window took r% of a week
  --pool-version           version

Settings (environment variables or CLAUDE_POOL_* lines in a .env file, all optional):
  CLAUDE_POOL_ENV_FILE     .env to read          the nearest .env from the current folder up
  CLAUDE_POOL_TOKEN_<NAME> an account's OAuth token instead of a file (CLAUDE_POOL_KEY_<NAME>: an API key)
  CLAUDE_POOL_DIR          account folder        {dir}
  CLAUDE_POOL_STATE        usage file            {state}
  CLAUDE_POOL_LOG          event log             {log}
  CLAUDE_POOL_BINARY       the real claude       claude
  CLAUDE_POOL_ACCOUNT      always use this account, no switching, no checks
  CLAUDE_POOL_STRATEGY     pace (weekly room over time left), drain (soonest weekly reset first) or balance
                           (least used first) (pace)
  CLAUDE_POOL_WINDOW_WEEK  weekly % points one full 5-hour window uses, instead of the learned estimate
  CLAUDE_POOL_PACE_MARGIN  safety margin on the learned estimate, 0.25 = 25% (0.25)
  CLAUDE_POOL_SERVER_ID    this server's name, so servers sharing accounts prefer different ones (host name)
  CLAUDE_POOL_SWITCH_AT    5-hour or 7-day % after which the next account is preferred (90)
  CLAUDE_POOL_SPREAD_AT    5-hour % after which a busy account gets no second run (75)
  CLAUDE_POOL_FRESH        seconds between usage checks, 0 = off (300)
  CLAUDE_POOL_LIMIT        % at which an account counts as full (100)
  CLAUDE_POOL_RERUN        after a limit cut-off: safe (only if no tools ran), always, never (safe)
  CLAUDE_POOL_SWITCH       off = an interactive session stays on its first account (on)
  CLAUDE_POOL_RESUME_PROMPT what a switched session is told first; empty = nothing, wait for you
  CLAUDE_POOL_BANNER       off = no pool line under the prompt in interactive sessions (on)
  CLAUDE_POOL_ORCA         Orca's logins: auto (interactive sessions and --pool-* commands), on (print mode
                           too), off, or the path of Orca's data folder (as on) (auto)
  CLAUDE_POOL_ALERT        shell command run on problems, with CLAUDE_POOL_EVENT and CLAUDE_POOL_MESSAGE set

Exit code 75: every account is full. More: https://github.com/grega-rotar/claude-pool"""


ENV_ACCOUNT = re.compile(r"CLAUDE_POOL_(TOKEN|KEY)_(\w+)$")


def load_dotenv():
    """Settings and accounts from a .env file: CLAUDE_POOL_ENV_FILE, else the nearest .env from the current folder
    up. Only CLAUDE_POOL_* lines are read, so an app's other secrets never reach claude. A variable that is
    already set wins. Returns the file used, or None."""
    path = os.environ.get("CLAUDE_POOL_ENV_FILE")
    if path:
        path = os.path.expanduser(path)
    else:
        d = os.getcwd()
        while not os.path.isfile(os.path.join(d, ".env")):
            if os.path.dirname(d) == d:
                return None
            d = os.path.dirname(d)
        path = os.path.join(d, ".env")
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError as e:
        if os.environ.get("CLAUDE_POOL_ENV_FILE"):
            print(f"claude-pool: can't read {path} ({e.strerror})", file=sys.stderr)
        return None
    for line in lines:
        m = re.match(r"\s*(?:export\s+)?(CLAUDE_POOL_\w+)\s*=\s*(.*)$", line)
        if not m or m.group(1) in os.environ:
            continue
        value = m.group(2).strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value)
        os.environ[m.group(1)] = value
    return path


def child_env(**extra):
    """The environment for claude and alert commands: ours without the pool's account secrets."""
    env = {k: v for k, v in os.environ.items() if not ENV_ACCOUNT.match(k)}
    env.update(extra)
    return env


def env_num(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return float(default)


def pool_dir():
    if os.environ.get("CLAUDE_POOL_DIR"):
        return os.path.expanduser(os.environ["CLAUDE_POOL_DIR"])
    if WINDOWS:
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "claude-pool")
    return os.path.expanduser("~/.config/claude-pool")


def state_path():
    if os.environ.get("CLAUDE_POOL_STATE"):
        return os.path.expanduser(os.environ["CLAUDE_POOL_STATE"])
    if WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, "claude-pool", "usage.json")


def log_path():
    return os.path.expanduser(os.environ.get("CLAUDE_POOL_LOG") or os.path.join(os.path.dirname(state_path()), "events.log"))


def share(path):
    """In a group-writable folder (several users sharing one pool), make our file group-writable too, so the
    other users can lock and replace it. Elsewhere files keep the user's umask."""
    if WINDOWS:
        return
    try:
        if os.stat(os.path.dirname(path) or ".").st_mode & stat.S_IWGRP and os.stat(path).st_uid == os.getuid():
            os.chmod(path, 0o660)
    except OSError:
        pass


@contextmanager
def locked(path, wait=None):
    """An exclusive lock on `path` across processes. Yields True once held; with `wait` seconds, False if it
    wasn't free by then (the block then runs without it)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a+") as f:
        share(path)
        deadline = None if wait is None else time.time() + wait
        got = False
        while True:
            try:
                if WINDOWS:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                got = True
                break
            except OSError:
                if deadline is not None and time.time() >= deadline:
                    break
                time.sleep(0.05)
        try:
            yield got
        finally:
            if got and WINDOWS:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            elif got:
                fcntl.flock(f, fcntl.LOCK_UN)


def replace(src, dst):
    """os.replace, retried on Windows while another process has `dst` open for a moment."""
    for _ in range(50):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if not WINDOWS:
                raise
            time.sleep(0.05)
    os.replace(src, dst)


def log(event, **fields):
    """One line in the event log (JSON lines, rotated at 1 MB); alert-worthy events also go to CLAUDE_POOL_ALERT."""
    line = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event, "host": HOST,
            "pid": os.getpid(), **fields}
    path = log_path()
    try:
        # Under a lock: on Windows two processes appending at once can overwrite each other's line.
        with locked(path + ".lock", wait=5):
            if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
                replace(path, path + ".1")
            with open(path, "a") as f:
                f.write(json.dumps(line) + "\n")
            share(path)
    except OSError:
        pass  # a log that can't be written must never fail a run
    if event in ALERT_EVENTS:
        alert(event, line)


def alert(event, line):
    cmd = os.environ.get("CLAUDE_POOL_ALERT")
    if not cmd:
        return
    key = f"{event}:{line.get('account', '')}"
    path = os.path.join(os.path.dirname(state_path()), "alerts.json")
    try:
        with locked(path + ".lock", wait=2):
            try:
                with open(path) as f:
                    sent = json.load(f)
            except (OSError, ValueError):
                sent = {}
            if time.time() - sent.get(key, 0) < ALERT_EVERY:
                return
            sent[key] = time.time()
            with open(path + ".tmp", "w") as f:
                json.dump(sent, f)
            share(path + ".tmp")
            replace(path + ".tmp", path)
        msg = f"claude-pool on {HOST}: {line.get('message') or event}"
        subprocess.run(cmd, shell=True, input=json.dumps(line), text=True, timeout=15, capture_output=True,
                       env=child_env(CLAUDE_POOL_EVENT=event, CLAUDE_POOL_MESSAGE=msg))
    except (OSError, subprocess.SubprocessError):
        pass


def env_accounts():
    """{name: (kind, secret)} for every CLAUDE_POOL_TOKEN_<NAME> / CLAUDE_POOL_KEY_<NAME> variable (or .env line)."""
    out = {}
    for k, v in sorted(os.environ.items()):
        m = ENV_ACCOUNT.match(k)
        if m and v.strip():
            out[m.group(2).lower().replace("_", "-")] = ("token" if m.group(1) == "TOKEN" else "key", v.strip())
    return out


def shown(pool):
    """The accounts to show and check: with none set up, the normal claude login as one row named "login"."""
    return pool or {"login": ("login", None)}


def orca_roots():
    """Orca's data folders that hold claude-profiles/: CLAUDE_POOL_ORCA when it is a path, else the usual places."""
    v = os.environ.get("CLAUDE_POOL_ORCA") or ""
    if v.lower() not in ("", "auto", "on", "off"):
        return [os.path.expanduser(v)]
    home = os.path.expanduser("~")
    roots = [os.environ.get("ORCA_USER_DATA_PATH"),
             os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"), "orca"),  # WSL runtime
             os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "orca"),  # Linux
             os.path.join(home, "Library", "Application Support", "orca"),  # macOS
             os.path.join(os.environ["APPDATA"], "orca") if os.environ.get("APPDATA") else None]  # Windows
    out = []
    for r in roots:
        if r and os.path.isdir(os.path.join(r, "claude-profiles")) and os.path.realpath(r) not in map(os.path.realpath, out):
            out.append(r)
    return out


def orca_wanted(interactive):
    """Orca's logins join the pool in interactive sessions and the --pool-* commands (CLAUDE_POOL_ORCA=auto, the
    default), everywhere with on, never with off. Print mode leaves them out by default, so scripts and services
    keep to the accounts set up for them."""
    v = (os.environ.get("CLAUDE_POOL_ORCA") or "auto").lower()
    return v != "off" and (interactive or v not in ("auto",))


def orca_accounts():
    """{orca-<name>: ("dir", profile folder)} for every Claude account logged in to Orca. Each Orca profile is a
    claude config folder with its own login; one account in several profiles counts once (the caller's own first)."""
    out, seen = {}, set()
    own = os.path.realpath(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"))
    homes = []
    for root in orca_roots():
        base = os.path.join(root, "claude-profiles")
        try:
            homes += [os.path.join(base, p, "home") for p in sorted(os.listdir(base))]
        except OSError:
            continue
    for home in sorted(homes, key=lambda h: os.path.realpath(h) != own):
        try:
            with open(os.path.join(home, ".claude.json"), encoding="utf-8") as f:
                acct = json.load(f).get("oauthAccount") or {}
        except (OSError, ValueError, AttributeError):
            continue
        uuid = acct.get("accountUuid")
        # Logged out: no .credentials.json. macOS keeps the login in the Keychain instead.
        if not uuid or uuid in seen or (sys.platform != "darwin" and not os.path.isfile(os.path.join(home, ".credentials.json"))):
            continue
        seen.add(uuid)
        label = re.sub(r"[^a-z0-9]+", "-", str(acct.get("emailAddress") or "").split("@")[0].lower()).strip("-")
        name = "orca-" + (label or os.path.basename(os.path.dirname(home))[:8])
        if name in out:
            name += "-" + os.path.basename(os.path.dirname(home))[:4]
        out[name] = ("dir", home)
    return out


def accounts(warn=False, orca=False):
    """{name: (kind, secret)} for every <name>.token / <name>.key / <name>.dir in the pool folder, plus the accounts
    set in variables and, with `orca`, the accounts logged in to Orca. A file wins over a variable with the same
    name, a variable over Orca. An empty <name>.off file leaves out an Orca account."""
    out, d = env_accounts(), pool_dir()
    if orca:
        out = {**orca_accounts(), **out}
    if not os.path.isdir(d):
        return out
    try:
        files = sorted(os.listdir(d))
    except OSError as e:
        sys.exit(f"claude-pool: can't read the account folder {d} ({e.strerror}); "
                 "for a shared pool, add this user to the folder's group")
    for f in files:
        name, ext = os.path.splitext(f)
        if ext == ".off" and "." not in name and out.get(name, ("",))[0] == "dir":
            out.pop(name)
        if ext not in (".token", ".key", ".dir"):
            continue
        path = os.path.join(d, f)
        try:
            with open(path) as fh:
                secret = fh.read().strip()
        except OSError as e:  # another user's file without group read: skip it, don't fail the run
            print(f"claude-pool: skipping {f}: {e.strerror}", file=sys.stderr)
            continue
        if warn and not WINDOWS and os.stat(path).st_mode & stat.S_IROTH:
            print(f"claude-pool: warning: {path} can be read by every user; run chmod 600 (or 640 for a shared pool)",
                  file=sys.stderr)
        if secret:
            out[name] = ({".token": "token", ".key": "key"}.get(ext, "dir"),
                         os.path.expanduser(secret) if ext == ".dir" else secret)
    return out


def load_usage():
    try:
        with open(state_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


SAME_FIELDS = ("status", "five_hour", "seven_day", "resets_ts", "seven_day_resets_ts", "checked_ts", "weekly", "weeks",
               "pace", "error", "error_ts")


def same_groups():
    """Account names that are one Anthropic account (a token and the same login in Orca), from the `same` file in
    the account folder: one group per line, names split by spaces. A token doesn't say whose it is, so this is told."""
    try:
        with open(os.path.join(pool_dir(), "same"), encoding="utf-8") as f:
            return [g for g in (line.split() for line in f) if len(g) > 1]
    except OSError:
        return []


def sync_same(usage):
    """Give every account of a same_groups() group the newest usage numbers any of them has. Run marks stay apart."""
    for group in same_groups():
        rows = [usage[n] for n in group if isinstance(usage.get(n), dict)]
        if not rows:
            continue
        newest = max(rows, key=lambda r: r.get("checked_ts") or 0)
        for n in group:
            row = usage.setdefault(n, {})
            for k in SAME_FIELDS:
                if k in newest:
                    row[k] = newest[k]
                else:
                    row.pop(k, None)


def same(names):
    """--pool-same a b [...]: these accounts are one; with no names, list the groups."""
    if not names:
        for g in same_groups():
            print(" ".join(g))
        return 0
    if len(names) < 2:
        sys.exit("claude-pool: --pool-same takes two or more account names, e.g. --pool-same factory orca-factory")
    for n in names:
        valid_name(n)
    path = os.path.join(pool_dir(), "same")
    groups = [g for g in same_groups() if not set(g) & set(names)] + [list(dict.fromkeys(names))]
    os.makedirs(pool_dir(), mode=0o700, exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write("".join(" ".join(g) + "\n" for g in groups))
    replace(path + ".tmp", path)
    with usage_update():
        pass  # syncs them now
    print(f"{' and '.join(names)} are one account now: they share their usage numbers")
    return 0


@contextmanager
def usage_update():
    """The usage dict to change in place, written back whole under the lock so parallel callers lose nothing."""
    path = state_path()
    with locked(path + ".lock"):
        usage = load_usage()
        yield usage
        sync_same(usage)
        with open(path + ".tmp", "w") as f:
            json.dump(usage, f, indent=1)
        share(path + ".tmp")
        replace(path + ".tmp", path)  # whole, so a parallel caller never reads half a file


def alive(pid):
    if WINDOWS:
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass  # another user's process: it exists
    return True


def running(row, now=None):
    """The runs still going on the account: same-host marks whose pid lives, other hosts' marks until RUN_MAX_AGE."""
    now = now or time.time()
    return [r for r in row.get("running") or [] if now - r.get("ts", 0) < RUN_MAX_AGE
            and (r.get("host") != HOST or alive(r.get("pid", 0)))]


def mark_running(name, on):
    with usage_update() as usage:
        row = usage.setdefault(name, {})
        marks = [r for r in running(row) if not (r.get("pid") == os.getpid() and r.get("host") == HOST)]
        if on:
            marks.append({"pid": os.getpid(), "host": HOST, "ts": time.time()})
        row["running"] = marks


def at_limit(row, now=None, full=None):
    """When the account's last known usage says wait: the reset time (Unix), else None."""
    now, full = now or time.time(), env_num("CLAUDE_POOL_LIMIT", 100) if full is None else full
    week_reset = row.get("seven_day_resets_ts") or 0
    if (row.get("seven_day") or 0) >= full and week_reset > now:
        return week_reset
    reset = row.get("resets_ts") or 0
    if reset > now and (row.get("status") == "rejected" or (row.get("five_hour") or 0) >= full):
        return reset
    return None


def five_hour(row, now):
    """The 5-hour usage, or 0 once that window has reset."""
    return (row.get("five_hour") or 0) if (row.get("resets_ts") or 0) > now else 0


def seven_day(row, now):
    """The 7-day usage, or 0 once that window has reset."""
    return (row.get("seven_day") or 0) if (row.get("seven_day_resets_ts") or 0) > now else 0


WEEK_HOURS = 168
WINDOWS_PER_WEEK = WEEK_HOURS / 5  # 33.6 five-hour windows fit in a week
PACE_STEP = 0.25  # pace values this close count as equal, so picks don't flip on a 1% change
MIN_LEARNED = 20  # 5-hour % points of samples before a learned r is used
SAMPLES = 8  # samples kept per weekly window
SAMPLE_AGE = 14 * 86400


def weeks(row):
    """[(key, used %, reset ts)] of the account's weekly windows: seven_day, plus any other weekly window the usage
    report listed (e.g. one model's own)."""
    out = []
    if isinstance(row.get("seven_day"), (int, float)):
        out.append(("seven_day", row["seven_day"], row.get("seven_day_resets_ts") or 0))
    extra = row.get("weeks")
    for k, v in (extra.items() if isinstance(extra, dict) else ()):
        if isinstance(v, list) and len(v) == 2 and isinstance(v[0], (int, float)) and isinstance(v[1], (int, float)):
            out.append((k, v[0], v[1]))
    return out


def learn(row, now=None):
    """Learn r, the weekly % one full 5-hour window uses, from the usage numbers just saved in `row`: within one
    5-hour and one weekly window, r = 100 * (weekly % gained) / (5-hour % gained). A reading starts a new anchor
    when either window has reset or a number went down; it becomes a sample once the 5-hour use grew 5 points
    since the anchor. The last SAMPLES samples of the last 14 days are summed, so rounding mostly cancels out and
    a changed workload ages out. Kept per weekly window in row["pace"]."""
    now = now or time.time()
    five, reset5 = row.get("five_hour"), row.get("resets_ts")
    if row.get("weekly") == "none":
        row.pop("pace", None)  # no weekly limit (any more): what was learned for it no longer applies
        return
    if not isinstance(five, (int, float)) or not isinstance(reset5, (int, float)):
        return
    pace = row.get("pace") if isinstance(row.get("pace"), dict) else {}
    for key, week, reset7 in weeks(row):
        st = pace.get(key) if isinstance(pace.get(key), dict) else {}
        cur = [five, reset5, week, reset7]
        a = st.get("a")
        if not (isinstance(a, list) and len(a) == 4 and all(isinstance(x, (int, float)) for x in a)) \
                or abs(reset5 - a[1]) > WINDOW_SLACK or abs(reset7 - a[3]) > WINDOW_SLACK:
            st["a"] = cur  # first reading, or a window reset since: start over from here
        elif five < a[0] or week < a[2]:
            st["a"] = cur  # went down within a window: a mixed-up reading, not a sample
        elif five - a[0] >= 5:
            d5, d7 = five - a[0], week - a[2]
            samples = [x for x in st.get("s") or [] if isinstance(x, list) and len(x) == 3 and now - x[2] < SAMPLE_AGE]
            if samples and d5 >= 25 and d7 > 1 and isinstance(st.get("r"), (int, float)) \
                    and not st["r"] / 4 <= 100 * d7 / d5 <= st["r"] * 4:
                samples = []  # a clear sample 4x off: the plan or the workload changed, old ones don't fit
            samples = (samples + [[d5, d7, now]])[-SAMPLES:]
            s5, s7 = sum(x[0] for x in samples), sum(x[1] for x in samples)
            st.update(a=cur, s=samples, r=round(100 * s7 / s5, 2), n=round(s5, 1), ts=now)
        pace[key] = st
    row["pace"] = pace


def pace_opts():
    """The settings pace() reads, read once per pick: (stale after s, CLAUDE_POOL_WINDOW_WEEK, margin, server id)."""
    return (stale_secs(), env_num("CLAUDE_POOL_WINDOW_WEEK", 0), env_num("CLAUDE_POOL_PACE_MARGIN", 0.25),
            os.environ.get("CLAUDE_POOL_SERVER_ID") or HOST)


def ratio(row, key="seven_day", opts=None):
    """(r, how sure) for one weekly window: CLAUDE_POOL_WINDOW_WEEK, else the learned r with a margin on top
    (CLAUDE_POOL_PACE_MARGIN, doubled while there is little to learn from, plus one point for rounding), else
    (None, None). How sure: "set", "low", "medium" or "high"."""
    _, fixed, margin, _ = opts or pace_opts()
    if key == "seven_day" and fixed > 0:
        return fixed, "set"
    st = (row.get("pace") or {}).get(key) if isinstance(row.get("pace"), dict) else None
    try:
        n, r = float(st["n"]), float(st["r"])
    except (TypeError, KeyError, ValueError):
        return None, None
    if n < MIN_LEARNED:
        return None, None
    sure = min(1.0, n / 100)
    margin *= 2 - sure
    return (r + 100 / n) * (1 + margin), "high" if sure >= 1 else "medium" if n >= 50 else "low"


def stale_secs():
    return max(4 * fresh_secs(), 3600)


def pace(row, now, kind="token", opts=None):
    """How the account's weekly limit stands, as (state, s, p, r, sure, left):

    state: none (no weekly numbers: no weekly limit, as on Team accounts and API keys), stale (numbers older than
    stale_secs()) or known.
    s: share of the week's room left over share of the week's time left. 1 = on an even pace, 2 = twice the room
    it needs; for none 1. Stale numbers count half as far from 1.
    p: full 5-hour windows the weekly room still holds, per 5-hour window left before the reset. From 1 up, even
    non-stop use can't spend the week before it resets. None without r, or with stale numbers.
    r, sure: ratio(); left: weekly % left. With several weekly windows, the tightest one counts."""
    ws = weeks(row)
    if kind == "key" or row.get("weekly") == "none" or not ws:
        return "none", 1.0, None, None, None, None
    opts = opts or pace_opts()
    stale = now - (row.get("checked_ts") or 0) > opts[0]
    best = None
    for key, used, reset in ws:
        live = reset > now
        left = max(0.0, 100.0 - used) if live else 100.0  # reset since: a full week from its first use
        hours = max(0.5, (reset - now) / 3600) if live else WEEK_HOURS
        s = (left / 100) / (hours / WEEK_HOURS)
        r, sure = ratio(row, key, opts)
        p = (left / r) / (hours / 5) if r and not stale else None
        if best is None or s < best[1]:
            best = ("stale" if stale else "known", 1 + (s - 1) / 2 if stale else s, p, r, sure, left)
    return best


def pace_values(info):
    """({name: value}, the middle value) for {name: pace()}: p, or p at the pool's middle r when the account's own
    isn't learned yet (with none learned anywhere that is s). Accounts with no weekly limit get none."""
    rs = sorted(i[3] for i in info.values() if i[3])
    mid_r = rs[len(rs) // 2] if rs else 100 / WINDOWS_PER_WEEK  # 100/33.6 makes p equal s
    out = {n: i[1] * 100 / ((i[3] or mid_r) * WINDOWS_PER_WEEK) for n, i in info.items() if i[0] != "none"}
    return out, sorted(out.values())[len(out) // 2] if out else 1


def affinity(name, server):
    """A fixed number per (server, account): servers sharing accounts break ties differently."""
    return zlib.crc32(f"{server}:{name}".encode())


def strategy():
    v = (os.environ.get("CLAUDE_POOL_STRATEGY") or "pace").lower()
    return v if v in ("pace", "drain", "balance") else "pace"


def tiers(pool, usage, skip=(), now=None):
    """(free, roomy, calm): free = not full and not refused; roomy = under CLAUDE_POOL_SWITCH_AT percent of its
    5-hour and 7-day windows; calm = roomy and not past CLAUDE_POOL_SPREAD_AT while it is already running something.
    Every strategy picks from calm, then roomy, then free."""
    now = now or time.time()
    row = lambda n: usage.get(n) or {}  # noqa: E731
    full, fresh = env_num("CLAUDE_POOL_LIMIT", 100), fresh_secs()
    free = [n for n in pool if n not in skip and not at_limit(row(n), now, full) and not broken(row(n), now, fresh)]
    switch_at, spread_at = env_num("CLAUDE_POOL_SWITCH_AT", 90), env_num("CLAUDE_POOL_SPREAD_AT", 75)
    roomy = [n for n in free if five_hour(row(n), now) < switch_at and seven_day(row(n), now) < switch_at]
    calm = [n for n in roomy if not (five_hour(row(n), now) >= spread_at and running(row(n), now))]
    return free, roomy, calm


def choose(pool, usage, skip=(), now=None, prefer=None):
    """The free account to run on next, else None.

    pace (default): first an account whose week resets with more room than even non-stop use could spend (p >= 1),
    soonest reset first, since that room is lost anyway; then accounts with no weekly limit (no weekly numbers).
    Then the most weekly room for the time left, in full 5-hour windows (p), so no account runs out of its week early
    while another still has plenty: an account whose r isn't known yet counts with the pool's middle r (no r at
    all: s). Values within PACE_STEP of each other tie, so picks don't flip
    on a 1% change; ties go by the 5-hour window as in drain, then by this server's affinity, so servers sharing
    accounts spread out.
    drain: the account whose 7-day window resets soonest, since its unused room is lost first; then the
    most used. Accounts with no live window (never used, or reset since) come last, so they don't start a window
    before it's needed. Ties (often no 7-day numbers at all) go the same way by the 5-hour window.
    balance: the lowest 7-day usage (then 5-hour), spreading the load. Never used counts as 0.
    Every strategy uses an account past CLAUDE_POOL_SWITCH_AT percent of its 5-hour or 7-day window only when every
    free account is, so a run is less likely to be cut off midway; and one past CLAUDE_POOL_SPREAD_AT that is
    already running something gets no second run while another account has room."""
    now = now or time.time()
    row = lambda n: usage.get(n) or {}  # noqa: E731
    free, roomy, calm = tiers(pool, usage, skip, now)
    how = strategy()
    if how == "balance":
        return min(calm or roomy or free, key=lambda n: (row(n).get("seven_day") or 0, five_hour(row(n), now)), default=None)

    def drain(reset, used):
        live = reset > now
        return (not live, reset if live else 0, -used if live else 0)

    def five(r):
        return drain(r.get("resets_ts") or 0, r.get("five_hour") or 0)

    if how == "drain":
        key = lambda n: drain(row(n).get("seven_day_resets_ts") or 0, row(n).get("seven_day") or 0) + five(row(n)) + (n,)  # noqa: E731
    else:
        opts = pace_opts()
        info = {n: pace(row(n), now, pool[n][0], opts) for n in calm or roomy or free}
        values, _ = pace_values(info)
        step = math.log(1 + PACE_STEP)

        def key(n):
            r, (state, _, p) = row(n), info[n][:3]
            if p is not None and p >= 1:
                return (0, min(t if t > now else now + WEEK_HOURS * 3600 for _, _, t in weeks(r))) + five(r) + (affinity(n, opts[3]), n)
            if state == "none":
                return (1, 0) + five(r) + (affinity(n, opts[3]), n)
            return (2, -math.floor(math.log(max(values[n], 1e-3)) / step)) + five(r) + (affinity(n, opts[3]), n)
    if prefer in calm:  # the caller's own login (an Orca pane's account) while it has room
        return prefer
    return min(calm or roomy or free, key=key, default=None)


def fresh_secs():
    return env_num("CLAUDE_POOL_FRESH", 300)


def probe_timeout():
    """Seconds for one usage check; a busy small server needs more than the default."""
    return env_num("CLAUDE_POOL_PROBE_TIMEOUT", 15)


def broken(row, now=None, fresh=None):
    """The account's token was refused at its last check: skip it until rechecked."""
    return bool(row.get("error_ts")) and (now or time.time()) - row["error_ts"] < max(fresh_secs() if fresh is None else fresh, 300)


PROBE = ["-p", "ok", "--model", "haiku", "--max-turns", "1", "--tools", "", "--system-prompt", "Reply ok.",
         "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
         "--output-format", "stream-json", "--verbose"]
AUTH_ERROR = re.compile(r"(?i)authenticat|invalid.{0,20}(token|key|bearer)|401|unauthori|expired|revoked"
                        r"|disabled .{0,40}access|not_allowed_for_organization")


def refused(final):
    """The account's token was refused (logged out, revoked, subscription access turned off for the org). claude
    reports some of these as subtype "success" with is_error true and an HTTP status."""
    return bool(final.get("is_error")) and (final.get("api_error_status") in (401, 403) or bool(
        AUTH_ERROR.search(f"{final.get('api_error_code') or ''} {final.get('result') or ''}")))


def parse_events(events):
    """(rate_limit_info, result event) of one run's stream-json events."""
    info = next((e.get("rate_limit_info") for e in reversed(events) if e.get("type") == "rate_limit_event"), None)
    final = next((e for e in reversed(events) if e.get("type") == "result"), {})
    return info, final


def touch(name):
    """Count the account as checked without new numbers, so a failing check isn't retried on every call."""
    with usage_update() as usage:
        usage.setdefault(name, {})["checked_ts"] = time.time()


def probe(name, kind, secret, binary):
    """One tiny Haiku call on the account, only to read its usage numbers. Returns what it found, for --pool-check."""
    try:
        r = subprocess.run([binary] + PROBE, env=account_env(kind, secret), cwd=tempfile.gettempdir(),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=probe_timeout())
        out, err = r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        touch(name)
        log("probe_timeout", account=name, message=f"usage check of {name} took over {probe_timeout():g} s")
        return "timeout"
    events = []
    for line in out.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    info, final = parse_events(events)
    if info:
        record(name, info, ran=False)
        return "ok"
    error = str(final.get("result") or err.strip() or "no reply")[:300]
    if refused(final) or AUTH_ERROR.search(error):
        record(name, None, ran=False, error=error)
        log("token_broken", account=name, error=error, message=f"the token of {name} was refused: {error}")
        return "broken"
    if final.get("subtype") == "success" and kind in ("login", "dir"):  # logged in with an API key: no usage windows
        touch(name)
        return "no_usage"
    if final.get("subtype") == "success":
        # claude ran but printed no usage: the CLI's output has changed, so picks would be blind.
        touch(name)
        log("cli_changed", account=name, message="claude answered but printed no rate_limit_event; usage can't be read")
        return "no_usage"
    touch(name)
    log("probe_failed", account=name, error=error, message=f"usage check of {name} failed: {error}")
    return "failed"


def refresh(pool, names=None, stale_only=False):
    """Probe the token accounts (API keys have no usage windows) whose numbers are missing or older than
    CLAUDE_POOL_FRESH, or all of `names`. One caller probes at a time; the others wait up to 5 s for its numbers,
    then go on with the old ones. Returns {name: result}."""
    def due(usage):
        now = time.time()
        return [n for n, (kind, _) in pool.items() if kind in ("token", "login", "dir") and (names is None or n in names)
                and (not stale_only or now - ((usage.get(n) or {}).get("checked_ts") or 0) >= fresh_secs())]
    if not due(load_usage()):
        return {}
    results = {}
    with locked(state_path() + ".refresh", wait=5 if stale_only else None) as got:
        if not got:
            log("refresh_skipped", message="another caller was checking usage; went on with the saved numbers")
            return {}
        binary = real_binary()
        # Every check is a claude process; on a 2-CPU server seven at once all ran past the timeout.
        slots = threading.Semaphore(int(env_num("CLAUDE_POOL_PROBES", 0)) or len(pool) or 1)

        def one(n):
            with slots:
                results[n] = probe(n, *pool[n], binary)
        threads = [threading.Thread(target=one, args=(n,)) for n in due(load_usage())]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    return results


def refresh_soon(pool):
    """Before an interactive session: when every account has saved numbers, pick on those and check the stale ones
    in the background, so claude starts at once instead of after a usage check (~10 s). Otherwise check first."""
    usage = load_usage()
    if any(kind in ("token", "login", "dir") and not (usage.get(n) or {}).get("checked_ts")
           for n, (kind, _) in pool.items()):
        refresh(pool, stale_only=True)
        return
    try:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--pool-refresh-stale", *pool],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=not WINDOWS)
    except OSError:
        refresh(pool, stale_only=True)


def record(name, info, ran=True, error=None):
    """Store one run's rate_limit_info for the account."""
    with usage_update() as usage:
        row = usage.setdefault(name, {})
        if info:
            w = info.get("unifiedWindows") or {}
            pct = lambda k: round(100 * (w.get(k) or {}).get("utilization", 0), 1) if k in w else row.get(k)  # noqa: E731
            row.update(status=info.get("status"), five_hour=pct("five_hour"), seven_day=pct("seven_day"),
                       resets_ts=(w.get("five_hour") or {}).get("resetsAt") or info.get("resetsAt"),
                       seven_day_resets_ts=(w.get("seven_day") or {}).get("resetsAt") or row.get("seven_day_resets_ts"),
                       checked_ts=time.time())
            if "seven_day" in w:
                row.pop("weekly", None)
            elif w:  # the report lists the account's windows and no weekly one: no weekly limit (Team accounts)
                row.update(weekly="none", seven_day=None, seven_day_resets_ts=None)
            extra = {k: [round(100 * (v.get("utilization") or 0), 1), v["resetsAt"]] for k, v in w.items()
                     if k.startswith("seven_day_") and isinstance(v, dict) and isinstance(v.get("resetsAt"), (int, float))}
            if extra:
                row["weeks"] = extra
            else:
                row.pop("weeks", None)
            learn(row)
            row.pop("error", None)
            row.pop("error_ts", None)
        elif error:
            row.update(error=error, error_ts=time.time(), checked_ts=time.time())
        if ran:
            row["runs"] = row.get("runs", 0) + 1
            row["last_used"] = datetime.now(timezone.utc).isoformat(timespec="seconds")


def account_env(kind, secret):
    env = child_env()
    if kind == "login":  # the normal claude login: no secret of ours
        return env
    if kind == "dir":  # a claude config folder with its own login (an Orca profile): claude keeps it fresh itself
        env["CLAUDE_CONFIG_DIR"] = secret
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        env.pop("ANTHROPIC_API_KEY", None)
        return env
    if kind == "token":
        env["CLAUDE_CODE_OAUTH_TOKEN"] = secret
        env.pop("ANTHROPIC_API_KEY", None)  # an API key would win over the token and bill the API instead
    else:
        env["ANTHROPIC_API_KEY"] = secret
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    return env


LIMIT_TEXT = re.compile(r"(?i)hit your .{0,40}limit|usage limit|limit reached|rate.?limit")


def cut_off(final, info):
    """The run stopped because the account hit its usage limit."""
    if final.get("is_error") is False and final.get("subtype") == "success":
        return False
    return (info or {}).get("status") == "rejected" or bool(LIMIT_TEXT.search(str(final.get("result") or "")))


def used_tools(events):
    """The run called a tool (edited a file, ran a command...), so running it again could do that twice."""
    for e in events:
        if e.get("type") == "assistant":
            for block in (e.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    return True
    return False


def flag_value(args, name):
    """(value, index of the flag) for `--name value` or `--name=value`, else (None, None)."""
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1], i
        if a.startswith(name + "="):
            return a.split("=", 1)[1], i
    return None, None


def stream_args(args):
    """The caller's args with --output-format stream-json --verbose, plus (format asked for, --verbose given)."""
    fmt, i = flag_value(args, "--output-format")
    out = list(args)
    if i is not None:
        del out[i:i + (1 if "=" in out[i] else 2)]
    verbose = "--verbose" in out
    out += ["--output-format", "stream-json"] + ([] if verbose else ["--verbose"])
    return out, fmt or "text", verbose


def find_claude(b):
    """`b` on PATH, else where the claude installers put it: an ssh command or a cron job often runs without
    ~/.local/bin on PATH."""
    if b != "claude":
        return shutil.which(b)
    home = os.path.expanduser("~")
    return shutil.which(b) or shutil.which(b, path=os.pathsep.join(
        [os.path.join(home, ".local", "bin"), os.path.join(home, ".claude", "local")]))


def real_binary():
    b = os.environ.get("CLAUDE_POOL_BINARY") or "claude"
    path = find_claude(b)
    if not path:
        sys.exit(f"claude-pool: {b} not found; set CLAUDE_POOL_BINARY to the real claude")
    if os.path.realpath(path) == os.path.realpath(__file__):
        sys.exit(f"claude-pool: {b} is claude-pool itself; set CLAUDE_POOL_BINARY to the real claude")
    return path


def piped_stdin(wait=3.0):
    """A prompt piped on stdin, read whole so a rerun can send it again; None for a terminal. Like claude, give
    up when nothing arrives within `wait` seconds, so a caller that leaves stdin open without writing doesn't hang."""
    if sys.stdin is None or sys.stdin.isatty():
        return None
    chunks, started, done = [], threading.Event(), threading.Event()
    fd = sys.stdin.fileno()

    def read():  # a thread, since select() can't wait on a pipe on Windows; raw reads, so exiting never blocks on it
        while True:
            chunk = os.read(fd, 65536)
            started.set()
            if not chunk:
                break
            chunks.append(chunk)
        done.set()
    threading.Thread(target=read, daemon=True).start()
    if not started.wait(wait):
        return b""
    done.wait()
    return b"".join(chunks)


def run_once(cmd, env, data, live):
    """One claude run; returns (exit code, events). With `live`, each stream-json line is written out as it comes."""
    p = subprocess.Popen(cmd, env=env, stdin=subprocess.PIPE if data is not None else None, stdout=subprocess.PIPE)
    # So a caller's terminate stops claude too. Windows can only terminate a process, not signal it.
    forward = lambda sig, _f: p.terminate() if WINDOWS else p.send_signal(sig)  # noqa: E731
    sigs = [getattr(signal, s) for s in ("SIGTERM", "SIGINT", "SIGHUP") if hasattr(signal, s)]
    old = {s: signal.signal(s, forward) for s in sigs}
    try:
        if data is not None:
            try:
                p.stdin.write(data)
                p.stdin.close()
            except BrokenPipeError:
                pass
        events = []
        for raw in p.stdout:
            if live:
                sys.stdout.buffer.write(raw)
                sys.stdout.flush()
            try:
                events.append(json.loads(raw))
            except ValueError:
                if not live:
                    sys.stderr.buffer.write(raw)  # not JSON: keep it visible
        return p.wait(), events
    finally:
        for s, h in old.items():
            signal.signal(s, h)


def emit(fmt, verbose, events, final):
    if fmt == "stream-json":
        return  # already written live
    if fmt == "json":
        print(json.dumps(events if verbose else final))
    elif final.get("result") is not None:
        sys.stdout.buffer.write((final["result"] + "\n").encode("utf-8"))  # as claude does, whatever the console
        sys.stdout.flush()


def run(args):
    """Print mode: run claude on the best account, rerun on the next when a usage limit cuts it off."""
    pool = accounts(orca=orca_wanted(False))
    forced = os.environ.get("CLAUDE_POOL_ACCOUNT")
    if forced and forced not in pool:
        sys.exit(f"claude-pool: no account {forced!r} in {pool_dir()}")
    if not forced and fresh_secs() > 0:
        refresh(pool, stale_only=True)
    usage = load_usage()
    sargs, fmt, verbose = stream_args(args)
    cmd = [real_binary()] + sargs
    streaming_in = flag_value(args, "--input-format")[0] == "stream-json"
    # A prompt piped on stdin is read once, so a rerun gets it again. A stream-json conversation can't be replayed.
    data = None if streaming_in else piped_stdin()
    rerun = os.environ.get("CLAUDE_POOL_RERUN") or "safe"
    tried, switched = set(), []
    name = forced or choose(pool, usage, prefer=own_account(pool))
    if pool and not name:
        resets = [r for r in (at_limit(usage.get(n) or {}) for n in pool) if r]
        when = datetime.fromtimestamp(min(resets), timezone.utc).isoformat() if resets else "unknown"
        msg = f"claude-pool: every account is at its usage limit (first reset {when})"
        log("exhausted", resets_at=when, message=f"every account is at its usage limit (first reset {when})")
        final = {"type": "result", "subtype": "error_pool_exhausted", "is_error": True, "result": msg, "resets_at": when}
        if fmt != "text":
            print(json.dumps([final] if fmt == "json" and verbose else final))
        print(msg, file=sys.stderr)
        return EXIT_EXHAUSTED
    while True:
        env = account_env(*pool[name]) if name else child_env()
        if name:
            mark_running(name, True)
            if fmt == "stream-json":  # stream output can't get pool_account added at the end: say it up front
                print(json.dumps({"type": "system", "subtype": "pool_account", "account": name}), flush=True)
        try:
            code, events = run_once(cmd, env, data, live=fmt == "stream-json")
        finally:
            if name:
                mark_running(name, False)
        info, final = parse_events(events)
        ok = final.get("subtype") == "success" and final.get("is_error") is False
        if name:
            record(name, info)
            log("run", account=name, exit=code, ok=ok, cost=final.get("total_cost_usd"),
                five_hour=(load_usage().get(name) or {}).get("five_hour"))
            if ok and info is None and pool[name][0] == "token":
                log("cli_changed", account=name, message="claude answered but printed no rate_limit_event; usage can't be read")
            final["pool_account"] = name
            if switched:
                final["pool_switched"] = switched
        bad = bool(name) and not ok and refused(final)
        if bad:  # skipped until rechecked, and the run goes to the next account: a refused run did nothing
            error = str(final.get("result") or "refused")[:300]
            record(name, None, ran=False, error=error)
            log("token_broken", account=name, error=error, message=f"the token of {name} was refused: {error}")
        limited = bool(name) and (bad or cut_off(final, info))
        if name and not ok:
            # The raw shape of every failure, so a real limit cut-off can be checked against what cut_off() expects.
            log("cut_off" if limited else "run_failed", account=name, exit=code, subtype=final.get("subtype"),
                result=str(final.get("result") or "")[:300], status=(info or {}).get("status"))
        if not limited or forced or streaming_in or rerun == "never":
            emit(fmt, verbose, events, final)
            return code
        if rerun != "always" and used_tools(events):
            final["pool_cut_off"] = True
            log("cut_off_not_rerun", account=name,
                message=f"a run on {name} hit the usage limit after it had used tools; not rerun, so nothing runs twice")
            print(f"claude-pool: {name} hit its usage limit after the run used tools; not rerunning "
                  "(set CLAUDE_POOL_RERUN=always to rerun anyway)", file=sys.stderr)
            emit(fmt, verbose, events, final)
            return code
        tried.add(name)
        nxt = choose(pool, load_usage(), skip=tried)
        if not nxt:
            emit(fmt, verbose, events, final)
            return code
        print(f"claude-pool: {name} {'was refused' if bad else 'hit its usage limit'}; rerunning on {nxt}", file=sys.stderr)
        log("switch", account=name, to=nxt)
        if fmt == "stream-json":
            print(json.dumps({"type": "system", "subtype": "pool_switch", "from": name, "to": nxt}), flush=True)
        switched.append(f"{name} -> {nxt}")
        name = nxt


# Interactive sessions. claude-pool starts claude with a StopFailure hook (--settings) that writes the failure to a
# file. When the failure is a usage limit, claude is stopped and started again on the next account with
# `--resume <session> "<prompt>"`: the conversation, tool results included, carries over, so nothing runs twice.

USAGE_LIMIT = re.compile(r"(?i)hit your .{0,40}limit|usage limit")
RESUME_PROMPT = "Continue where you left off. Your last turn was cut off by a usage limit."
# Flags that start a session elsewhere, return at once or turn hooks off: claude gets the terminal to itself.
EXEC_FLAGS = {"-h", "--help", "-v", "--version", "--bg", "--background", "--desktop", "--cloud", "--environment",
              "--teleport", "--bare", "--safe-mode"}
# Flags that go on with an earlier session.
RESUME_FLAGS = {"-c", "--continue", "-r", "--resume", "--from-pr"}
# Flags that pick or make the session: dropped on a switch, since --resume <id> takes their place.
SESSION_FLAGS = {"-c", "--continue", "-r", "--resume", "--session-id", "--fork-session", "--from-pr", "-w",
                 "--worktree", "--tmux"}
# Used when `claude --help` can't be read: flag -> "one" value, "many" (<x...>) or "optional" ([x]).
CLI_FALLBACK = {
    "flags": {"--add-dir": "many", "--agent": "one", "--agents": "one", "--allowedTools": "many",
              "--allowed-tools": "many", "--append-system-prompt": "one", "--autocompact": "one", "--betas": "many",
              "--cloud": "optional", "-d": "optional", "--debug": "optional", "--debug-file": "one",
              "--disallowedTools": "many", "--disallowed-tools": "many", "--effort": "one", "--environment": "one",
              "--fallback-model": "one", "--file": "many", "--from-pr": "optional", "--input-format": "one",
              "--json-schema": "one", "--max-budget-usd": "one", "--mcp-config": "many", "--model": "one",
              "-n": "one", "--name": "one", "--output-format": "one", "--permission-mode": "one",
              "--permission-prompts": "one", "--plugin-dir": "one", "--plugin-url": "one",
              "--prompt-suggestions": "optional", "--remote-control": "optional",
              "--remote-control-session-name-prefix": "one", "-r": "optional", "--resume": "optional",
              "--session-id": "one", "--setting-sources": "one", "--settings": "one", "--system-prompt": "one",
              "--system-prompt-snapshot": "one", "--teleport": "optional", "--tools": "many", "-w": "optional",
              "--worktree": "optional"},
    "commands": ["agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
                 "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview",
                 "update", "upgrade"]}


def parse_help(text):
    """{"flags": {flag: arity}, "commands": [...]} from `claude --help`."""
    flags, commands, section = {}, [], None
    for line in text.splitlines():
        if re.match(r"\S", line):
            section = line.strip().rstrip(":").lower()
            continue
        m = re.match(r"  (\S.*?)(?:\s{2,}|$)", line)
        if not m:
            continue
        if section == "options":
            spec = m.group(1)
            arg = re.search(r" (<[^>]*>|\[[^\]]*\])$", spec)
            arity = None if not arg else "optional" if arg.group(1)[0] == "[" else "many" if "..." in arg.group(1) else "one"
            for flag in re.findall(r"(?<![\w-])(--?[\w-]+)", spec[:arg.start()] if arg else spec):
                if arity:
                    flags[flag] = arity
        elif section == "commands":
            commands += m.group(1).split()[0].split("|")
    return {"flags": flags, "commands": commands}


def cli_spec(binary):
    """claude's flags and commands, read from its --help once per claude version and cached next to the usage file."""
    try:
        st = os.stat(binary)
        key = f"{os.path.realpath(binary)}:{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return CLI_FALLBACK
    path = os.path.join(os.path.dirname(state_path()), "cli.json")
    try:
        with open(path) as f:
            cached = json.load(f)
        if cached.get("key") == key:
            return cached
    except (OSError, ValueError):
        pass
    try:
        text = subprocess.run([binary, "--help"], capture_output=True, text=True, timeout=30,
                              stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return CLI_FALLBACK
    spec = parse_help(text)
    if not spec["flags"] or not spec["commands"]:
        return CLI_FALLBACK
    spec["key"] = key
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w") as f:
            json.dump(spec, f)
        share(path + ".tmp")
        replace(path + ".tmp", path)
    except OSError:
        pass
    return spec


def split_args(args, spec):
    """claude's args as [(flag or None, [values])]: a flag with what it takes, or None with a positional (the
    prompt, or a command). Follows claude's own parsing: --x=v, a [value] only when the next arg isn't a flag,
    <values...> up to the next flag, and everything after "--" positional."""
    out, i, flags = [], 0, spec["flags"]
    while i < len(args):
        a = args[i]
        if a == "--":
            out += [(None, [x]) for x in args[i + 1:]]
            break
        name = a.split("=", 1)[0] if a.startswith("--") else a
        if not a.startswith("-") or a == "-":
            out.append((None, [a]))
            i += 1
            continue
        arity = flags.get(name)
        j = i + 1
        if "=" in a or arity is None:
            pass
        elif arity == "one":
            j = min(i + 2, len(args))
        else:
            while j < len(args) and not args[j].startswith("-") and (arity == "many" or j == i + 1):
                j += 1
        out.append((a, args[i + 1:j]))
        i = j
    return out


def session_mode(args, spec):
    """True when the args start an interactive session in this terminal, which claude-pool can switch."""
    parts = split_args(args, spec)
    if any(f and f.split("=", 1)[0] in EXEC_FLAGS for f, _ in parts):
        return False
    first = next((v[0] for f, v in parts if f is None), None)
    return first not in spec["commands"]


def resume_args(args, spec, session, prompt):
    """The args to go on with `session` on another account: the caller's flags (MCP config, --add-dir, model... are
    not kept by a resume), without the prompt and the flags that picked or made the session."""
    keep = []
    for f, values in split_args(args, spec):
        if f is None or f.split("=", 1)[0] in SESSION_FLAGS:
            continue
        keep += [f] + values
    return keep + ["--resume", session] + ([prompt] if prompt else [])


def self_cmd(*args):
    """A shell command that runs claude-pool with `args`, for claude to call (hooks, status line)."""
    cmd = " ".join(f'"{p}"' for p in (sys.executable, os.path.abspath(__file__), *args))
    return cmd.replace("\\", "/") if WINDOWS else cmd  # claude runs them in Git Bash there: forward slashes


def with_hook(args, spec, folder, banner=True):
    """The args with our StopFailure and UserPromptSubmit hooks added through --settings, merged into the caller's
    own --settings, and the /pool:switch command as a plugin when claude takes --plugin-dir. With `banner`, the status
    line becomes ours too: it runs the one it replaces first (saved in `folder`)."""
    hook_cmd = self_cmd("--pool-hook", os.path.join(folder, "stop-failure.json"))
    settings, out = {}, []
    for f, values in split_args(args, spec):
        if f and f.split("=", 1)[0] == "--settings":
            raw = f.split("=", 1)[1] if "=" in f else (values[0] if values else "")
            try:
                if raw.lstrip().startswith("{"):
                    settings = json.loads(raw)
                else:
                    with open(os.path.expanduser(raw), encoding="utf-8") as fh:
                        settings = json.load(fh)
            except (OSError, ValueError) as e:
                sys.exit(f"claude-pool: can't read --settings {raw!r}: {e}")
            continue
        out += ([f] if f else []) + values
    hooks = settings.setdefault("hooks", {})
    hooks["StopFailure"] = list(hooks.get("StopFailure") or []) + [{"hooks": [{"type": "command", "command": hook_cmd}]}]
    hooks["UserPromptSubmit"] = list(hooks.get("UserPromptSubmit") or []) + [{"hooks": [
        {"type": "command", "command": self_cmd("--pool-prompt", folder), "timeout": 120}]}]
    if banner:
        if (settings.get("statusLine") or {}).get("command"):
            with open(os.path.join(folder, "statusline.json"), "w", encoding="utf-8") as fh:
                json.dump(settings["statusLine"], fh)
        # Every 30 s too, so an idle session shows what other sessions and checks saved since its last reply.
        settings["statusLine"] = {"type": "command", "command": self_cmd("--pool-statusline", folder),
                                  "refreshInterval": 30}
    settings_path = os.path.join(folder, "settings.json")
    with open(settings_path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh)
    plugin = []
    if "--plugin-dir" in spec["flags"]:
        plugin = ["--plugin-dir", os.path.join(folder, "plugin")]
        os.makedirs(os.path.join(plugin[1], ".claude-plugin"))
        os.makedirs(os.path.join(plugin[1], "commands"))
        write_json(os.path.join(plugin[1], ".claude-plugin", "plugin.json"),
                   {"name": "pool", "description": "claude-pool: accounts, their usage, and moving this session"})
        for cmd, md in POOL_COMMANDS_MD.items():
            with open(os.path.join(plugin[1], "commands", cmd + ".md"), "w", encoding="utf-8") as fh:
                fh.write(md)
    return ["--settings", settings_path] + plugin + out, settings


def outer_statusline(folder, data, raw):
    """The output of the status line ours stands in for (Orca's, yours): from --settings, else the settings files
    in claude's order. Run with the same input, so it keeps working (Orca reads usage from it)."""
    line = None
    try:
        with open(os.path.join(folder, "statusline.json"), encoding="utf-8") as f:
            line = json.load(f)
    except (OSError, ValueError):
        proj = (data.get("workspace") or {}).get("project_dir") or data.get("cwd") or os.getcwd()
        conf = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
        for path in (os.path.join(proj, ".claude", "settings.local.json"), os.path.join(proj, ".claude", "settings.json"),
                     os.path.join(conf, "settings.json")):
            try:
                with open(path, encoding="utf-8") as f:
                    line = json.load(f).get("statusLine")
            except (OSError, ValueError, AttributeError):
                continue
            if line:
                break
    cmd = (line or {}).get("command") if isinstance(line, dict) else None
    if not cmd or "--pool-statusline" in cmd:
        return ""
    bash = WINDOWS and (os.environ.get("CLAUDE_CODE_GIT_BASH_PATH") or shutil.which("bash"))
    try:
        r = subprocess.run([bash, "-c", cmd] if bash else cmd, shell=not bash, input=raw, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.rstrip("\n")


WINDOW_SLACK = 600  # two reset times this close apart are the same window


def live_usage(name, rate_limits):
    """Save the usage claude hands the status line, so the pool knows it without a check. Those are the numbers of
    this session's last reply, maybe older than what another session (or a check, which sees other servers' use
    too) saved since. Within one window usage only goes up, so a lower number for the same window, or one from an
    earlier window, is left out: an idle session never takes the numbers back."""
    five, week = rate_limits.get("five_hour") or {}, rate_limits.get("seven_day") or {}

    def newer(old):
        new = {}
        for key, reset_key, w in (("five_hour", "resets_ts", five), ("seven_day", "seven_day_resets_ts", week)):
            pct, reset = w.get("used_percentage"), w.get("resets_at")
            if not isinstance(pct, (int, float)) or not isinstance(reset, (int, float)):
                continue
            was = old.get(reset_key) or 0
            if reset < was - WINDOW_SLACK or (abs(reset - was) <= WINDOW_SLACK and pct <= (old.get(key) or 0)):
                continue
            new[key], new[reset_key] = pct, reset
        return new

    if not newer(load_usage().get(name) or {}):
        return  # nothing new: the status line runs often, the usage file needn't change each time
    with usage_update() as usage:
        row = usage.setdefault(name, {})
        new = newer(row)  # again under the lock: another session may have saved meanwhile
        if not new:
            return
        row.update(new, checked_ts=time.time())
        if "seven_day" in new:
            row.pop("weekly", None)
        learn(row)
        if new.get("five_hour", 0) < env_num("CLAUDE_POOL_LIMIT", 100) and row.get("status") == "rejected":
            row["status"] = "allowed"


def banner(session, data, color=True):
    """The pool line under claude's prompt: the account, its 5-hour use and reset, the week when known, and the
    account it moves to at the limit. Usage is green while low, yellow from 70% and red from CLAUDE_POOL_SWITCH_AT,
    with a red warning when there is no account left to move to. Right-aligned when the terminal width is known."""
    name, pool, now = session["account"], session.get("pool") or {}, time.time()
    rl = data.get("rate_limits") or {}
    if rl:
        live_usage(name, rl)
    usage = load_usage()
    row = usage.get(name) or {}
    clock = lambda ts: datetime.fromtimestamp(ts).strftime("%H:%M")  # noqa: E731
    level = lambda pct: "31" if pct >= env_num("CLAUDE_POOL_SWITCH_AT", 90) else "33" if pct >= 70 else "32"  # noqa: E731
    five, reset = row.get("five_hour"), row.get("resets_ts") or 0
    week = row.get("seven_day") if (row.get("seven_day_resets_ts") or 0) > now else None
    here = (pool.get(name) or {}).get("sessions")
    others = {n: (v.get("kind"), None) for n, v in pool.items() if v.get("sessions") == here}
    nxt = choose(others, usage, skip={name}, now=now)
    # The pool's pick now, this session's own run mark left out (or it would look busy to itself). When that isn't
    # this account, say so in red: a session only moves by itself at its limit.
    mine = {**row, "running": [r for r in row.get("running") or []
                                if not (r.get("pid") == session.get("pid") and r.get("host") == HOST)]}
    better = nxt and choose(others, {**usage, name: mine}, now=now) == nxt
    n5 = five_hour(usage.get(nxt) or {}, now) if nxt else 0
    resets = [r for r in (at_limit(usage.get(n) or {}, now) for n in others if n != name) if r]

    def pieces(short):
        """(color, text, glued) pieces of the line; short: the same with fewer words, for a narrow terminal."""
        out = [("2", name if short else f"pool: {name}", False)]
        if five is not None and reset > now:
            out += [(level(five), f"{five:.0f}%", False), ("2", clock(reset) if short else f"resets {clock(reset)}", False)]
        elif five is not None:  # the 5-hour window has reset since
            out.append(("32", "0%", False))
        if week is not None:
            out.append((level(week), f"w{week:.0f}%" if short else f"week {week:.0f}%", False))
        if nxt:
            out.append(("31" if better else "2", f"→ {nxt}" if short else f"better now: {nxt}" if better else f"next: {nxt}", False))
            if n5:
                out.append((level(n5), f"{n5:.0f}%", True))  # right after the account's name, no dot
            if better and not short:
                out.append(("31", "/pool:switch", False))
        else:
            out.append(("31", ("⚠ none" if short else "⚠ no next account") + (f" until {clock(min(resets))}" if resets else ""), False))
        return out

    width = terminal_width() - 4  # claude indents the line and keeps a margin on the right
    for short in (False, True):
        joined = []
        for c, t, glued in pieces(short):
            if joined:
                joined.append((" " if glued else " · ", None))
            joined.append((t, c))
        plain = "".join(t for t, _ in joined)
        if len(plain) <= width or width <= 0:
            break
    pad = " " * max(0, width - len(plain))
    if not color:
        return pad + plain
    return "\033[0m" + pad + "".join(f"\033[2m{t}\033[0m" if c is None else f"\033[{c}m{t}\033[0m" for t, c in joined)


def terminal_width():
    """The width of the terminal claude draws in: COLUMNS when set (0 = unknown), else the terminal of the first
    parent process (claude) that has one. claude runs the status line without a terminal, so /dev/tty is the last try."""
    if os.environ.get("COLUMNS") is not None:
        try:
            return int(os.environ["COLUMNS"])
        except ValueError:
            return 0
    pid, paths = os.getppid(), []
    for _ in range(6):  # Linux: walk up through /proc to claude
        try:
            paths += [os.path.realpath(f"/proc/{pid}/fd/{fd}") for fd in (0, 1, 2)]
            with open(f"/proc/{pid}/stat") as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    ttys = [p for p in paths if p.startswith(("/dev/pts/", "/dev/tty"))]
    for path in ttys + ["CONOUT$" if WINDOWS else "/dev/tty"]:
        try:
            with open(path) as tty:
                return os.get_terminal_size(tty.fileno()).columns
        except (OSError, ValueError):
            continue
    return 0


def statusline(folder):
    """--pool-statusline <folder>: claude's status line in a claude-pool session."""
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    lines = [outer_statusline(folder, data, raw)]
    try:
        with open(os.path.join(folder, "session.json"), encoding="utf-8") as f:
            lines.append(banner(json.load(f), data, color=os.environ.get("NO_COLOR") is None))
    except (OSError, ValueError, KeyError):
        pass
    out = "\n".join(x for x in lines if x)
    if out:  # UTF-8 whatever the console, as claude reads it (a Windows pipe would get the old code page)
        sys.stdout.buffer.write((out + "\n").encode("utf-8"))
        sys.stdout.flush()
    return 0


def hooks_run():
    """claude can run our hook: always on macOS and Linux; on Windows only with Git Bash, which runs its hooks."""
    if not WINDOWS:
        return True
    bash = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")
    if bash and os.path.isfile(bash):
        return True
    return any(os.path.isfile(os.path.join(os.environ.get(v) or "", "Git", "bin", "bash.exe"))
               for v in ("ProgramFiles", "ProgramW6432", "LOCALAPPDATA")) or bool(shutil.which("bash"))


def hook(path):
    """--pool-hook <file>: claude's StopFailure hook. Saves the hook's input for the session's claude-pool."""
    data = sys.stdin.read()
    try:
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(data)
        replace(path + ".tmp", path)
    except OSError:
        pass
    return 0


def read_failure(path):
    try:
        with open(path, encoding="utf-8") as f:
            failure = json.load(f)
        os.remove(path)
        return failure
    except (OSError, ValueError):
        return None


REFUSED_ERRORS = {"authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"}


def refused_failure(name, failure):
    """The account itself was refused (token revoked, org access off, on hold, no credit): skipped until rechecked."""
    if failure.get("error") not in REFUSED_ERRORS:
        return False
    error = str(failure.get("last_assistant_message") or failure.get("error"))[:300]
    record(name, None, ran=False, error=error)
    log("token_broken", account=name, error=error, message=f"the token of {name} was refused: {error}")
    return True


def usage_limited(name, pool, failure):
    """The failure is the account's usage limit, not a short rate limit claude retries by itself. The account is
    checked either way, so every caller sees its new numbers."""
    if failure.get("error") != "rate_limit":
        return False
    if pool[name][0] in ("token", "login", "dir"):
        refresh({name: pool[name]}, names=[name])
    text = f"{failure.get('last_assistant_message') or ''} {failure.get('error_details') or ''}"
    if at_limit(load_usage().get(name) or {}):
        return True
    if not USAGE_LIMIT.search(text):
        return False
    # claude says limit but the check didn't show it (it failed, or a per-model limit): full for 15 minutes.
    with usage_update() as usage:
        row = usage.setdefault(name, {})
        row["status"] = "rejected"
        if (row.get("resets_ts") or 0) <= time.time():
            row["resets_ts"] = time.time() + 900
    return True


def own_account(pool):
    """The pool account that is the caller's own claude login folder (CLAUDE_CONFIG_DIR), if any."""
    own = os.path.realpath(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"))
    return next((n for n, (kind, secret) in pool.items() if kind == "dir" and os.path.realpath(secret) == own), None)


def sessions_dir(kind, secret):
    """Where claude keeps the conversations of a run on this account. A session can only move between accounts
    that share it (Orca's profiles all link projects/ to ~/.claude/projects)."""
    base = secret if kind == "dir" else os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.realpath(os.path.join(base, "projects"))


def next_free(pool, name):
    """The account a session on `name` moves to: one that sees the same conversations, rechecked just now (unless
    checked in the last minute) so a switch never lands on an account that is full too, e.g. the same account
    twice in the pool, once as a token and once in Orca."""
    here = sessions_dir(*pool[name])
    skip = {name} | {n for n in pool if sessions_dir(*pool[n]) != here}
    while True:
        nxt = choose(pool, load_usage(), skip=skip)
        if not nxt or pool[nxt][0] == "key":
            return nxt
        if time.time() - ((load_usage().get(nxt) or {}).get("checked_ts") or 0) > 60:
            refresh({nxt: pool[nxt]}, names=[nxt])
        row = load_usage().get(nxt) or {}
        if not at_limit(row) and not broken(row):
            return nxt
        skip.add(nxt)


def asked_account(pool, name, want):
    """The account `/pool:switch [want]` moves a session on `name` to, or (None, why not), or (name, why) when it
    stays. With no name it's the pool's pick now; a named one must see the same conversations and have room,
    rechecked as next_free does."""
    if not want:
        # Already on the account the pool would pick now: stay. This session's own run mark doesn't count, or it
        # would look busy to itself.
        usage, here = load_usage(), sessions_dir(*pool[name])
        own = usage.setdefault(name, {})
        own["running"] = [r for r in own.get("running") or [] if not (r.get("pid") == os.getpid() and r.get("host") == HOST)]
        if choose({n: v for n, v in pool.items() if sessions_dir(*v) == here}, usage) == name:
            return name, f"{name} is already the best account; staying on it"
        nxt = next_free(pool, name)
        return (nxt, None) if nxt else (None, "no other account is free right now")
    if want not in pool:
        return None, f"no account {want}; the pool has " + ", ".join(sorted(pool))
    if want == name:
        return name, f"this session already runs on {want}"
    if sessions_dir(*pool[want]) != sessions_dir(*pool[name]):
        return None, f"{want} can't see this conversation (its claude folder doesn't share projects/)"
    if pool[want][0] != "key":
        if time.time() - ((load_usage().get(want) or {}).get("checked_ts") or 0) > 60:
            refresh({want: pool[want]}, names=[want])
        row = load_usage().get(want) or {}
        if broken(row):
            return None, f"{want} was refused: " + str(row.get("error") or "token refused")[:200]
        reset = at_limit(row)
        if reset:
            return None, f"{want} is full until {datetime.fromtimestamp(reset):%H:%M}"
    return want, None


# `/pool:switch [account]` in a session (or `claude-pool --pool-switch [account]` from its shell) hands a switch
# to the session's claude-pool through its temp folder and waits for the answer, which claude shows the user.
# `/pool:status` and `/pool:log [N]` show --pool-status and --pool-log the same way, without a model call.
POOL_COMMAND = re.compile(r"/pool:switch(?:\s+(\S+))?\s*$")
POOL_SHOW = re.compile(r"/pool:(status|log)(?:\s+(\d+))?\s*$")
POOL_COMMANDS_MD = {cmd: f"""---
description: {about}
argument-hint: {hint}
---
Tell the user in one line: /pool:{cmd} only works in a claude-pool session that runs hooks; `claude-pool --pool-{cmd}` \
does the same from a terminal.
""" for cmd, about, hint in (
    ("switch", "Move this session to another claude-pool account (the best free one, or the one named)", "[account]"),
    ("status", "claude-pool accounts with their usage, when it resets, and which one is next", ""),
    ("log", "The last claude-pool events (default 20): runs, switches, errors", "[N]"))}


def write_json(path, data):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f)
    replace(path + ".tmp", path)


def ask_switch(folder, to, session):
    """(moved, message) from the session's claude-pool for a switch to `to` (None: the best free account)."""
    reply = os.path.join(folder, f"reply-{os.getpid()}.json")
    write_json(os.path.join(folder, "switch.json"), {**session, "to": to, "reply": reply})
    deadline = time.time() + 110  # a switch may first check a few accounts' usage
    while time.time() < deadline:
        answer = read_failure(reply) if os.path.exists(reply) else None
        if answer:
            return answer.get("ok"), answer.get("message")
        time.sleep(0.1)
    return False, "claude-pool: this session's claude-pool didn't answer; nothing was switched"


def prompt_hook(folder):
    """--pool-prompt <folder>: claude's UserPromptSubmit hook. Notes the session for --pool-switch, and turns
    `/pool:switch [account]` into a switch; that prompt never reaches the model."""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    session = {"session_id": data.get("session_id"), "cwd": data.get("cwd")}
    if not session["session_id"]:
        return 0
    try:
        write_json(os.path.join(folder, "current.json"), session)
    except OSError:
        pass
    m = POOL_COMMAND.match((data.get("prompt") or "").strip())
    if m:
        # A stop, not a block: one line ("Operation stopped by hook: ..."), and the prompt box is left empty. A block
        # would put /pool:switch back in the box. Green when it moves or stays as asked, red when it can't.
        ok, message = ask_switch(folder, m.group(1), session)
        if os.environ.get("NO_COLOR") is None:
            message = ("\033[32m" if ok else "\033[31m") + message + "\033[0m"
        print(json.dumps({"continue": False, "stopReason": message}))
        return 0
    m = POOL_SHOW.match((data.get("prompt") or "").strip())
    if m:  # a stop too: the table shows under the prompt and the model never sees it
        print(json.dumps({"continue": False, "stopReason": "claude-pool\n" + show_in_session(folder, *m.groups())}))
    return 0


def show_in_session(folder, what, n):
    """--pool-status (this session's account marked) or --pool-log [n] as text, for /pool:status and /pool:log."""
    load_dotenv()
    try:
        with open(os.path.join(folder, "session.json"), encoding="utf-8") as f:
            here = json.load(f).get("account")
    except (OSError, ValueError):
        here = None
    out = io.StringIO()
    with redirect_stdout(out), redirect_stderr(io.StringIO()):  # warnings (token modes) are for the terminal
        try:
            status(here, color=True) if what == "status" else show_log(int(n or 20))
        except SystemExit as e:
            print(e.code if isinstance(e.code, str) else f"claude-pool: /pool:{what} failed")
    return out.getvalue().rstrip()


def switch(want):
    """--pool-switch [account]: move the claude-pool session this runs in, from a `!` command or claude's Bash."""
    folder = os.environ.get("CLAUDE_POOL_SESSION")
    if not folder or not os.path.isdir(folder):
        sys.exit("claude-pool: --pool-switch only works inside a claude-pool session (or type /pool:switch there)")
    try:
        with open(os.path.join(folder, "current.json"), encoding="utf-8") as f:
            session = json.load(f)
    except (OSError, ValueError):
        sys.exit("claude-pool: send this session a message first, then switch")
    ok, message = ask_switch(folder, want, session)
    print(message, file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 1


def stop(p):
    if p.poll() is None:
        p.terminate()  # claude saves the conversation and puts the terminal back on SIGTERM
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()


def interactive(args, pool, name, binary, spec):
    """Run an interactive claude on `name`, and move the session to the next account each time a usage limit
    stops it, or when you ask with /pool:switch. Returns claude's exit code."""
    tmp = tempfile.mkdtemp(prefix="claude-pool-")
    hook_file = os.path.join(tmp, "stop-failure.json")
    switch_file = os.path.join(tmp, "switch.json")
    banner = os.environ.get("CLAUDE_POOL_BANNER", "on") != "off"
    args, settings = with_hook(args, spec, tmp, banner)
    shares = {n: {"kind": k, "sessions": sessions_dir(k, v)} for n, (k, v) in pool.items()}
    if settings.get("disableAllHooks"):
        print("claude-pool: your --settings turn hooks off; this session can't switch accounts", file=sys.stderr)
    prompt = os.environ.get("CLAUDE_POOL_RESUME_PROMPT", RESUME_PROMPT)
    tty = None
    if not WINDOWS and sys.stdin is not None and sys.stdin.isatty():
        import termios
        tty = termios.tcgetattr(sys.stdin.fileno())
    p, cwd, switches, stopping = None, None, 0, []

    def forward(sig, _frame):  # a terminate or hang-up is passed on, and the session ends there
        stopping.append(sig)
        if p and p.poll() is None:
            p.terminate() if WINDOWS else p.send_signal(sig)
    # The terminal sends Ctrl+C to us and claude alike: only claude acts on it.
    sigs = {s: forward for s in (getattr(signal, n, None) for n in ("SIGTERM", "SIGHUP")) if s}
    # A no-op handler, not SIG_IGN: an ignored signal would stay ignored in claude and the commands it runs.
    sigs.update({s: lambda _s, _f: None for s in (getattr(signal, n, None) for n in ("SIGINT", "SIGQUIT")) if s})
    old = {s: signal.signal(s, h) for s, h in sigs.items()}
    try:
        while True:
            mark_running(name, True)
            log("session", account=name, resumed=switches > 0)
            if banner:  # what the status line shows: this session's account and the accounts it could move to
                with open(os.path.join(tmp, "session.json.tmp"), "w", encoding="utf-8") as fh:
                    json.dump({"account": name, "pool": shares, "pid": os.getpid()}, fh)
                replace(os.path.join(tmp, "session.json.tmp"), os.path.join(tmp, "session.json"))
            # CLAUDE_POOL_SESSION: where `claude-pool --pool-switch`, run from inside the session, finds us
            p = subprocess.Popen([binary] + args, env={**account_env(*pool[name]), "CLAUDE_POOL_SESSION": tmp}, cwd=cwd)
            nxt = None
            while p.poll() is None:
                try:
                    p.wait(0.25)
                except subprocess.TimeoutExpired:
                    pass
                failure = read_failure(hook_file) if os.path.exists(hook_file) else None
                asked = read_failure(switch_file) if os.path.exists(switch_file) else None
                if asked and asked.get("session_id") and not stopping:
                    nxt, why_not = asked_account(pool, name, asked.get("to"))
                    try:  # ok: moving or staying as asked, so the hook shows it green
                        write_json(asked["reply"], {"ok": bool(nxt), "message": "claude-pool: " + (
                            why_not or f"moving this session to {nxt}; it restarts in a moment")})
                    except (OSError, KeyError, TypeError):
                        pass
                    if not nxt or nxt == name:
                        nxt = None
                        continue
                    failure, why = asked, "was left as you asked"
                else:
                    if not failure or not failure.get("session_id") or stopping:
                        continue
                    why = "was refused" if refused_failure(name, failure) else "hit its usage limit" if usage_limited(
                        name, pool, failure) else None
                    if not why:
                        continue
                    nxt = next_free(pool, name)
                    if not nxt and why == "was refused":
                        log("switch_failed", account=name, message=f"{name} was refused and no other account is free")
                        continue
                    if not nxt:  # claude waits for the reset and goes on by itself
                        resets = [r for r in (at_limit(load_usage().get(n) or {}) for n in pool) if r]
                        when = datetime.fromtimestamp(min(resets), timezone.utc).isoformat() if resets else "unknown"
                        log("exhausted", account=name, resets_at=when,
                            message=f"every account is at its usage limit (first reset {when}); the session waits")
                        continue
                time.sleep(1)  # the hook runs as the turn ends: give claude a moment to finish writing it
                if p.poll() is not None or stopping:  # you quit meanwhile: don't start it again
                    nxt = None
                    break
                stop(p)
                break
            mark_running(name, False)
            if not nxt:
                return p.returncode if p.returncode >= 0 else 128 - p.returncode  # killed by a signal: as a shell says
            if tty:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, tty)
            log("switch", account=name, to=nxt, session=failure["session_id"], reason=failure.get("error") or "asked")
            print(f"\nclaude-pool: {name} {why}; going on with {nxt}", file=sys.stderr, flush=True)
            switches += 1
            cwd = failure.get("cwd") or cwd  # with --worktree the session lives in the worktree
            # Asked for: no nudge, the session waits for you.
            args = resume_args(args, spec, failure["session_id"], None if failure is asked else prompt)
            name = nxt
    finally:
        for s, h in old.items():
            signal.signal(s, h)
        if p and p.poll() is None:
            stop(p)
        shutil.rmtree(tmp, ignore_errors=True)


def status(here=None, color=None):
    """The accounts as a table in the order the pool uses them: #1 is next, then the one after, and so on; full and
    broken accounts last, with no number. Usage, when it resets (local time), and what happens to each account
    next. `here` is the account of the session that asks (/pool:status), marked "this session". In colour on a
    terminal (or when `color`), unless NO_COLOR is set."""
    pool, usage = shown(accounts(warn=True, orca=orca_wanted(True))), load_usage()
    now = time.time()
    order = []
    while True:
        n = choose(pool, usage, skip=order, now=now)
        if n is None:
            break
        order.append(n)
    best = order[0] if order else None
    order += [n for n in pool if n not in order]
    if color is None:
        color = sys.stdout.isatty()
    color = color and os.environ.get("NO_COLOR") is None
    switch_at = env_num("CLAUDE_POOL_SWITCH_AT", 90)
    pct = lambda v: "-" if v is None else f"{v:g}%"  # noqa: E731
    level = lambda v: "2" if v is None else "31" if v >= switch_at else "33" if v >= 70 else "32"  # noqa: E731

    def when(ts):
        if not ts or ts <= now:
            return "-"
        t, left = datetime.fromtimestamp(ts), int(ts - now) // 60
        day = "" if t.date() == datetime.fromtimestamp(now).date() else t.strftime("%a ")
        return f"{day}{t:%H:%M} (in {left // 60}h{left % 60:02d}m)" if left >= 60 else f"{day}{t:%H:%M} (in {left}m)"

    _, roomy, calm = tiers(pool, usage, now=now)
    weekly = {n: pace(usage.get(n) or {}, now, pool[n][0]) for n in pool}
    values, mid = pace_values(weekly)

    def why(n):
        """Why the pool takes the account when it does (pace), or holds it back."""
        if n not in roomy:
            return f"past {switch_at:g}%"
        if n not in calm:
            return "busy"
        if strategy() != "pace":
            return ""
        st, _, p = weekly[n][:3]
        if p is not None and p >= 1:
            return "week resets with room to spare"
        if st == "none":
            return "no weekly limit"
        return "saving its week" if values[n] < mid / 1.25 else "week to spare" if values[n] > mid * 1.25 else ""

    def state(n, r):
        if broken(r):
            err = (r.get("error") or "token refused").split(" · ")[0]
            return "broken: " + (err if len(err) <= 80 else err[:79] + "…")
        reset = at_limit(r)
        busy = len(running(r, now))
        s = f"full until {when(reset).split(' (')[0]}" if reset else why(n)
        return ", ".join(x for x in ("this session" if n == here else "", s, f"{busy} running" if busy else "") if x)

    def week_cells(n):
        """pace (s), r with how sure, and full 5-hour windows the week has left."""
        st, s, _, rr, sure, left = weekly[n]
        if st == "none":
            return ["no limit", "-", "-"]
        return [(f"{s:.1f}x" if s < 10 else ">10x") + (" stale" if st == "stale" else ""), f"{rr:.0f} {sure}" if rr else "-",
                f"{left / rr:.1f}" if rr else "-"]

    mixed = any(kind == "key" for kind, _ in pool.values())  # a kind column only when API keys are in the pool
    head = ["#", "account"] + (["kind"] if mixed else []) + ["5h", "7d", "5h resets", "7d resets", "pace", "r", "left",
                                                             "checked", "runs", "status"]
    rows = [[(c, "1;2") for c in head]]  # (text, colour) per cell
    for i, n in enumerate(order):
        kind, r = pool[n][0], usage.get(n) or {}
        five, week = r.get("five_hour"), r.get("seven_day")
        st = state(n, r)
        st = ("next" + (", " + st if st else "")) if n == best else st
        out = at_limit(r, now) or broken(r, now)
        rows.append([(str(i + 1) if not out else "-", "1;32" if n == best else "2"),
                     (n, "31" if out else "1;32" if n == best else "")] +
                    ([(kind, "2")] if mixed else []) +
                    [(pct(five), level(five)), (pct(week), level(week)),
                     (when(r.get("resets_ts")), "2"), (when(r.get("seven_day_resets_ts")), "2")] +
                    [(c, "2") for c in week_cells(n)] +
                    [("-" if not r.get("checked_ts") else f"{int((now - r['checked_ts']) // 60)}m ago", "2"),
                     (str(r.get("runs", 0)), "2"),
                     (st, "31" if out else "36" if n == here else "32" if n == best else "")])
    widths = [max(len(x[i][0]) for x in rows) for i in range(len(head) - 1)]
    paint = lambda t, c: f"\033[{c}m{t}\033[0m" if color and c and t.strip() else t  # noqa: E731
    for x in rows:
        print("  ".join(paint(t.ljust(w), c) for (t, c), w in zip(x, widths)) + "  " + paint(*x[-1]))
    # Two accounts whose 5-hour windows reset at the same second are likely one account in the pool twice.
    grouped = {n for g in same_groups() for n in g}
    resets = {}
    for n in pool:
        t = (usage.get(n) or {}).get("resets_ts") or 0
        if t > now and n not in grouped:
            resets.setdefault(t, []).append(n)
    for names in (v for v in resets.values() if len(v) > 1):
        print("\n" + paint(f"{' and '.join(names)} may be one account (same 5-hour reset). If so: "
                           f"claude-pool --pool-same {' '.join(names)}", "33"))
    est = [weekly[n] for n in pool if weekly[n][3]]
    if est:
        print("\n" + paint("Estimates from usage, not Anthropic's numbers. pace: week room left over week time left "
                            "(1x = even). r: week % one full 5-hour window uses, with a safety margin. left: full 5-hour "
                            "windows left this week.", "2"))
        print(f"{len(est)} account{'s' if len(est) > 1 else ''} with an estimate: "
              f"{sum(100 / w[3] for w in est):.1f} full 5-hour windows a week, "
              f"{sum(w[5] / w[3] for w in est):.1f} left before their resets, "
              f"{sum(min(1, 100 / w[3] / WINDOWS_PER_WEEK) for w in est):.1f} accounts' worth of non-stop use")
        rest = [w[0] for w in weekly.values() if not w[3]]
        if rest.count("none"):
            print(f"{rest.count('none')} with no weekly limit: only their 5-hour windows limit them")
        if len(rest) - rest.count("none"):
            print(f"{len(rest) - rest.count('none')} not estimated yet (too little use to learn from)")
    return 0


def capacity(r):
    """--pool-capacity <r>: what identical accounts would hold if one full 5-hour window took r% of their week.
    Hypothetical: the pool's own estimates are in --pool-status."""
    per = 100 / r
    print(f"Hypothetical: every account the same, one full 5-hour window = {r:g}% of its week.")
    print(f"One account: {per:.1f} full 5-hour windows a week, {min(1, per / WINDOWS_PER_WEEK):.0%} of non-stop use "
          f"(a week holds {WINDOWS_PER_WEEK:g} five-hour windows).\n")
    print("accounts  windows/week  non-stop accounts  hours of 5-hour use a week")
    for n in (1, 2, 3, 4, 5, 6, 10, 100):
        print(f"{n:<8}  {n * per:<12.1f}  {n * min(1, per / WINDOWS_PER_WEEK):<17.2f}  {n * min(per, WINDOWS_PER_WEEK) * 5:.0f}")
    return 0


def watch(minutes):
    """--pool-refresh again and again. Every check is a tiny Haiku call per account, so the wait is at least a minute."""
    wait = max(60, int(minutes * 60))
    try:
        while True:
            refresh(shown(accounts(orca=orca_wanted(True))))
            if sys.stdout.isatty():
                print("\033[H\033[2J", end="")  # clear the screen
            status()
            print(f"\nchecked {time.strftime('%H:%M')}, next check in {wait // 60} min. Ctrl+C to stop.", flush=True)
            time.sleep(wait)
    except KeyboardInterrupt:
        print()
        return 0


def valid_name(name):
    if not name or not re.fullmatch(r"[A-Za-z0-9._-]+", name) or name.startswith("."):
        sys.exit("claude-pool: an account name may use letters, digits, dot, dash and underscore")
    return name


def add(name):
    name, d = valid_name(name), pool_dir()
    path = os.path.join(d, name + ".token")
    if any(os.path.exists(os.path.join(d, name + ext)) for ext in (".token", ".key", ".token.off", ".key.off")):
        sys.exit(f"claude-pool: account {name!r} already exists in {d}")
    if sys.stdin is not None and sys.stdin.isatty():
        print("Run `claude setup-token` and log in as this account, then paste the token here.")
        token = getpass.getpass("Token (hidden): ").strip()
    else:
        token = sys.stdin.read().strip()
    if not token:
        sys.exit("claude-pool: no token given")
    if token.startswith("sk-ant-api"):
        path = os.path.join(d, name + ".key")  # an API key, not a subscription token
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
    shared = not WINDOWS and bool(os.stat(d).st_mode & stat.S_IWGRP)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640 if shared else 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    if not WINDOWS:
        os.chmod(path, 0o640 if shared else 0o600)
    print(f"added {name} ({path})")
    if path.endswith(".token"):
        result = refresh({name: ("token", token)}, names=[name]).get(name)
        if result == "broken":
            print(f"claude-pool: warning: the token of {name} was refused; check it, or remove {path}", file=sys.stderr)
    return status()


def toggle(name, on):
    name, d = valid_name(name), pool_dir()
    for ext in (".token", ".key", ".dir"):
        src, dst = (os.path.join(d, name + ext + ".off"), os.path.join(d, name + ext))
        if not on:
            src, dst = dst, src
        if os.path.exists(src):
            os.rename(src, dst)
            print(f"{name} is {'on' if on else 'off'}")
            log("account_on" if on else "account_off", account=name)
            return 0
    marker = os.path.join(d, name + ".off")  # an Orca account has no file of ours: an empty <name>.off leaves it out
    if name in orca_accounts() and on == os.path.exists(marker):
        if on:
            os.remove(marker)
        else:
            os.makedirs(d, mode=0o700, exist_ok=True)
            open(marker, "w").close()
        print(f"{name} is {'on' if on else 'off'}")
        log("account_on" if on else "account_off", account=name)
        return 0
    sys.exit(f"claude-pool: no {'disabled' if on else 'active'} account {name!r} in {d}")


def show_log(n):
    try:
        with open(log_path()) as f:
            lines = f.readlines()[-n:]
    except OSError:
        print(f"no events yet ({log_path()})")
        return 0
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        extra = " ".join(f"{k}={v}" for k, v in e.items() if k not in ("ts", "event", "host", "pid", "message") and v is not None)
        print(f"{e.get('ts')}  {e.get('event'):<18} {e.get('message') or extra}")
    return 0


def check():
    """--pool-check: everything a working setup needs, as OK / WARN / FAIL lines. Exit 1 on any FAIL."""
    failed = []

    def say(level, text):
        print(f"{level:<5} {text}")
        if level == "FAIL":
            failed.append(text)
    b = os.environ.get("CLAUDE_POOL_BINARY") or "claude"
    binary = find_claude(b)
    if not binary:
        say("FAIL", f"claude not found ({b}); install Claude Code or set CLAUDE_POOL_BINARY")
    else:
        try:
            v = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            v = "?"
        say("OK", f"claude {v} ({binary})")
    d = pool_dir()
    try:
        files = sorted(os.listdir(d)) if os.path.isdir(d) else None
    except OSError as e:
        say("FAIL", f"account folder {d}: {e.strerror}; for a shared pool, add this user to the folder's group")
        return 1
    env_file = load_dotenv()
    if env_file:
        say("OK", f"settings from {env_file}")
    if env_accounts():
        say("OK", "accounts from variables: " + ", ".join(env_accounts()))
    if files is None:
        if not env_accounts():
            say("WARN", f"no account folder {d}; claude runs with the normal login (add one: claude-pool --pool-add <name>)")
    else:
        say("OK", f"account folder {d}")
        for f in files:
            p = os.path.join(d, f)
            if not f.endswith((".token", ".key")):
                continue
            if not os.access(p, os.R_OK):
                say("FAIL", f"{f}: this user can't read it (shared pool: chgrp the group, chmod 640)")
            elif not WINDOWS and os.stat(p).st_mode & stat.S_IROTH:
                say("WARN", f"{f}: every user can read it; chmod 600 (or 640 for a shared pool)")
    sp = state_path()
    try:
        with locked(sp + ".lock", wait=5) as got:
            say("OK" if got else "WARN", f"usage file {sp}" + ("" if got else " (lock busy for 5 s)"))
    except OSError as e:
        say("FAIL", f"usage file {sp}: {e.strerror}; this user must be able to write that folder")
    pool = accounts(orca=orca_wanted(True))
    if orca_wanted(True):
        found = [n for n, (k, _) in pool.items() if n.startswith("orca-") and k == "dir"]
        say("OK" if found else "WARN", "Orca accounts: " + ", ".join(found) if found else
            "no Orca accounts logged in" if orca_roots() else "Orca not found (CLAUDE_POOL_ORCA=<its data folder>)")
    if binary and pool:
        results = refresh(pool)
        for n, (kind, _) in pool.items():
            if kind == "key":
                say("OK", f"{n}: API key (no usage windows to check)")
                continue
            r = results.get(n)
            text = {"ok": ("login" if kind == "dir" else "token") + " works, usage read", "broken": "token refused: " + str((load_usage().get(n) or {}).get("error")),
                    "no_usage": "claude printed no usage numbers; claude-pool can't pick well with this claude version",
                    "timeout": f"check took over {probe_timeout():g} s", "failed": "check failed; see --pool-log"}.get(r, "not checked")
            say({"ok": "OK", "broken": "FAIL", "no_usage": "FAIL"}.get(r, "WARN"), f"{n}: {text}")
    alert_cmd = os.environ.get("CLAUDE_POOL_ALERT")
    say("OK" if alert_cmd else "WARN", f"alerts: {alert_cmd}" if alert_cmd else "no CLAUDE_POOL_ALERT; problems go to the log only")
    print()
    status()
    return 1 if failed else 0


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    cmd, rest = (args[0], args[1:]) if args else (None, [])
    if cmd == "--pool-hook":  # first: claude waits on it, so no .env or account reads
        return hook(rest[0]) if rest else 1
    if cmd == "--pool-statusline":
        return statusline(rest[0]) if rest else 0
    if cmd == "--pool-prompt":  # runs on every prompt: before the .env and account reads
        return prompt_hook(rest[0]) if rest else 0
    if cmd == "--pool-switch":
        return switch(rest[0] if rest else None)
    load_dotenv()
    if cmd == "--pool-help":
        print(HELP.format(version=__version__, dir=pool_dir(), state=state_path(), log=log_path()))
        return 0
    if cmd == "--pool-version":
        print(__version__)
        return 0
    if cmd == "--pool-status":
        return status()
    if cmd == "--pool-refresh":
        refresh(shown(accounts(orca=orca_wanted(True))), names=rest or None)
        return status()
    if cmd == "--pool-refresh-stale":  # refresh_soon's background check
        refresh({n: v for n, v in accounts(orca=True).items() if n in rest}, stale_only=True)
        return 0
    if cmd == "--pool-watch":
        try:
            return watch(float(rest[0]) if rest else 5)
        except ValueError:
            sys.exit("claude-pool: --pool-watch takes the minutes between checks, e.g. --pool-watch 10")
    if cmd == "--pool-check":
        return check()
    if cmd == "--pool-same":
        return same(rest)
    if cmd == "--pool-capacity":
        try:
            r = float(rest[0])
            assert r > 0
        except (IndexError, ValueError, AssertionError):
            sys.exit("claude-pool: --pool-capacity takes r, the week % one full 5-hour window uses, e.g. --pool-capacity 20")
        return capacity(r)
    if cmd == "--pool-add":
        return add(rest[0] if rest else "")
    if cmd in ("--pool-off", "--pool-on"):
        return toggle(rest[0] if rest else "", cmd == "--pool-on")
    if cmd == "--pool-log":
        return show_log(int(rest[0]) if rest and rest[0].isdigit() else 20)
    if cmd and cmd.startswith("--pool-"):
        sys.exit(f"claude-pool: unknown command {cmd}; see claude-pool --pool-help")
    if "-p" in args or "--print" in args:
        return run(args)
    # Interactive or a subcommand: pick the account. A session that can move to another account at a usage limit
    # runs under claude-pool; anything else gets claude to itself.
    binary = real_binary()
    session = session_mode(args, cli_spec(binary))
    pool = accounts(orca=orca_wanted(session))
    forced = os.environ.get("CLAUDE_POOL_ACCOUNT")
    if not forced and fresh_secs() > 0:
        refresh_soon(pool)
    # A resumed session (Orca reopening its panes) is picked in the pool's order: its pane's own login is only
    # where it started, maybe hours and several switches ago.
    resumed = any(f and f.split("=", 1)[0] in RESUME_FLAGS for f, _ in split_args(args, cli_spec(binary)))
    name = forced or choose(pool, load_usage(), prefer=None if resumed else own_account(pool))
    env = account_env(*pool[name]) if name in pool else child_env()
    if (name in pool and not forced and len(pool) > 1 and os.environ.get("CLAUDE_POOL_SWITCH", "on") != "off"
            and session):
        if hooks_run():
            return interactive(args, pool, name, binary, cli_spec(binary))
        print("claude-pool: Git Bash not found, so this session can't switch accounts at a usage limit "
              "(install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH)", file=sys.stderr)
    if name in pool:
        mark_running(name, True)  # exec keeps our pid, so the mark lives as long as the session
    if WINDOWS:  # no real exec on Windows: run it and pass its exit code on
        try:
            return subprocess.call([binary] + args, env=env)
        finally:
            if name in pool:
                mark_running(name, False)
    os.execve(binary, [binary] + args, env)


if __name__ == "__main__":
    sys.exit(main())

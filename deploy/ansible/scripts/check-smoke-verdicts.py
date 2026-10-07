#!/usr/bin/env python3
"""Prove the smoke suite records PASS only for a check that actually measured.

Why this harness exists
-----------------------
`playbooks/smoke-check.yml` used to record every verdict as

    'PASS' if <probe> is succeeded else 'FAIL'

and Ansible's `succeeded` test means exactly `not failed`. A task that was
SKIPPED never ran, so it never failed, so it recorded **PASS** — 21 checks in
that file plus six more elsewhere (issue #1617). The gate ran, reported, and
was trusted, while any probe that quietly skipped counted as healthy.

A gate nobody has seen fire is not a control, so this script injects the defect
rather than reading the YAML: it runs the REAL playbook against this machine
and asserts the verdict for each named check. The decisive case is `skip_*`:
the probe is forced to skip and the suite must record SKIPPED, never PASS.

`--compare-old REF` re-runs the SAME fixtures against the playbook as it was at
a git ref and prints both verdicts side by side. Against the pre-fix revision
that is the bug itself, reproduced: HSTS reads PASS there and FAIL here, from
byte-identical inputs.

How the probes are made deterministic
-------------------------------------
Nothing here touches a server, and nothing needs root.

* Host checks (ufw, fail2ban, docker, sshd, sysctl, df, container health) run
  against STUB executables placed first on PATH. Each reads a FIXTURE_* env
  var, so "healthy", "broken" and "absent" are all reachable on a workstation
  that has none of those services configured. The playbook's own shell
  pipelines, greps and exit-status handling run unmodified.
* Loopback HTTP checks (app liveness/readiness/health, ntfy, Signal notifier,
  SIP bridge) run against real sockets: a threaded HTTP server per port, whose
  per-path status codes the case controls.
* PostgreSQL and RustFS are probed from INSIDE their container, through
  `docker compose exec` (#1615 moved RustFS there: the compose template
  publishes no ports, so the old host-side `http://localhost:9000/` probe
  could never pass). Both therefore run against the `docker` stub, driven by
  FIXTURE_POSTGRES and FIXTURE_RUSTFS. The loopback server still answers 9000
  so `--compare-old` can exercise the pre-#1615 host-side probe on the same
  fixtures.
* The four checks that require a publicly-trusted HTTPS name (Caddy HTTPS,
  HSTS, X-Frame-Options, the ntfy public vhost, the update server) cannot be
  served from a workstation without binding 443 with a trusted chain. They are
  exercised in their SKIPPED state (feature disabled) and in their FAIL state
  (enabled, nothing answering) — which are the two states this bug was about.
  Their PASS state is covered by check-record-smoke-result.yml, which drives
  the shared recorder with synthesized probe results.

Usage:
    python3 deploy/ansible/scripts/check-smoke-verdicts.py
    python3 deploy/ansible/scripts/check-smoke-verdicts.py --only skip_ntfy
    python3 deploy/ansible/scripts/check-smoke-verdicts.py --compare-old origin/main
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent.parent
SMOKE_PLAYBOOK = "playbooks/smoke-check.yml"

# Check names as the playbook records them, shortened to stable substrings.
UFW = "UFW active"
FAIL2BAN = "fail2ban running"
DOCKER = "Docker running"
USERNS = "userns-remap"
SSHD = "SSH password auth disabled"
SYNCOOKIES = "TCP syncookies"
CONTAINERS = "No unhealthy Docker containers"
APP_LIVE = "liveness probe"
APP_READY = "readiness probe"
APP_HEALTH = "health endpoint /api/health (200)"
POSTGRES = "PostgreSQL accepting connections"
RUSTFS = "RustFS object storage"
NTFY = "ntfy health endpoint"
NTFY_PUBLIC = "ntfy public vhost"
SIGNAL = "Signal Notifier sidecar"
SIP = "SIP bridge health"
UPDATES = "Update server health"
CADDY = "Caddy HTTPS serving"
HSTS = "HSTS header present"
XFO = "X-Frame-Options"
DISK = "Disk space"

# Ports the loopback probes use, and the playbook paths served on each.
FIXTURE_PORTS = {
    3000: ["/api/health/live", "/api/health/ready", "/api/health"],
    9000: ["/"],
    2586: ["/v1/health"],
    3100: ["/health"],
    3101: ["/health"],
}

# Stub executables. Each honours a FIXTURE_* variable so one case can break one
# probe while leaving the rest healthy.
STUBS: dict[str, str] = {
    "ufw": r"""#!/bin/sh
# `ufw status verbose`; the playbook greps for two separate lines.
[ "${FIXTURE_UFW:-active}" = "absent" ] && { echo "ufw: command not found" >&2; exit 127; }
if [ "${FIXTURE_UFW:-active}" = "active" ]; then
  echo "Status: active"
  echo "Default: deny (incoming), allow (outgoing), disabled (routed)"
else
  echo "Status: inactive"
fi
""",
    "systemctl": r"""#!/bin/sh
# `systemctl is-active <unit>`
unit="$2"
case "$unit" in
  fail2ban) state="${FIXTURE_FAIL2BAN:-active}" ;;
  docker)   state="${FIXTURE_DOCKER:-active}" ;;
  *)        state="unknown" ;;
esac
echo "$state"
[ "$state" = "active" ] || exit 3
""",
    "docker": r"""#!/bin/sh
# Three call shapes the playbook makes: `docker info --format ...`,
# `docker ps --filter health=unhealthy ...`, and `docker compose -f <file>
# exec -T <service> <cmd>` — for TWO services now, postgres (pg_isready) and
# rustfs (an in-container curl, since #1615 moved that probe inside the
# container). Dispatch on the service name, or FIXTURE_POSTGRES would decide
# the RustFS verdict too.
case "$1" in
  info)
    if [ "${FIXTURE_USERNS:-on}" = "on" ]; then echo "[name=userns name=seccomp]"; else echo "[name=seccomp]"; fi
    ;;
  ps)
    [ "${FIXTURE_UNHEALTHY_CONTAINERS:-}" = "" ] || printf '%s\n' "${FIXTURE_UNHEALTHY_CONTAINERS}"
    ;;
  compose)
    svc=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-T" ]; then svc="$2"; break; fi
      shift
    done
    case "$svc" in
      postgres)
        # pg_isready's real output and exit status.
        if [ "${FIXTURE_POSTGRES:-up}" = "up" ]; then
          echo "/var/run/postgresql:5432 - accepting connections"
        else
          echo "/var/run/postgresql:5432 - no response"
          exit 2
        fi
        ;;
      rustfs)
        # `curl -sf -o /dev/null http://localhost:9000/` inside the container.
        # curl exits 22 on the 403 RustFS returns for an unauthenticated root
        # request (which the playbook folds into rc 0 — the service answered),
        # 0 on a 2xx, and 7 when nothing is listening in there.
        case "${FIXTURE_RUSTFS:-up}" in
          up)   exit 22 ;;
          open) exit 0 ;;
          *)    echo "curl: (7) Failed to connect to localhost port 9000" >&2; exit 7 ;;
        esac
        ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
""",
    "sshd": r"""#!/bin/sh
# `sshd -T`; the playbook counts the two hardened lines.
if [ "${FIXTURE_SSHD:-hardened}" = "hardened" ]; then
  echo "passwordauthentication no"
  echo "permitrootlogin no"
else
  echo "passwordauthentication yes"
  echo "permitrootlogin yes"
fi
""",
    "sysctl": r"""#!/bin/sh
# `sysctl -n net.ipv4.tcp_syncookies`
echo "${FIXTURE_SYNCOOKIES:-1}"
""",
    "df": r"""#!/bin/sh
# `df -BG /`; the playbook awks field 4 off row 2 and strips the G.
echo "Filesystem     1G-blocks  Used Available Use% Mounted on"
echo "/dev/fixture         100    10 ${FIXTURE_DISK_FREE_GB:-50}G   10% /"
""",
}

FIXTURE_SERVER = r"""
import os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# PORT:path=code,path=code;PORT:...
spec = {}
for chunk in sys.argv[1].split(";"):
    port, _, rest = chunk.partition(":")
    spec[int(port)] = dict(
        (p, int(c)) for p, c in (kv.split("=") for kv in rest.split(",") if kv)
    )

def make(codes):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            code = codes.get(self.path.split("?")[0], 404)
            body = b"ok"
            self.send_response(code)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        def log_message(self, *a):
            pass
    return H

servers = []
for port, codes in spec.items():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), make(codes))
    except OSError as exc:
        print(f"FIXTURE-PORT-BUSY {port}: {exc}", flush=True)
        continue
    servers.append(srv)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
print("READY", flush=True)
try:
    threading.Event().wait()
except KeyboardInterrupt:
    pass
"""


def all_up() -> dict[int, dict[str, int]]:
    """Every loopback path answering the code its probe accepts."""
    return {
        3000: {p: 200 for p in FIXTURE_PORTS[3000]},
        9000: {"/": 403},  # RustFS answers 403 unauthenticated; the probe accepts it
        2586: {"/v1/health": 200},
        3100: {"/health": 200},
        3101: {"/health": 200},
    }


# Vars every case starts from. The TLS-dependent features are off by default,
# so their checks record SKIPPED unless a case turns them on.
BASE_VARS = {
    "domain": "smoke.example.invalid",
    "api_subdomain": "api",
    "ntfy_domain": "push.smoke.example.invalid",
    "updates_domain": "updates.smoke.example.invalid",
    "releases_domain": "releases.smoke.example.invalid",
    "llamenos_postgres_enabled": True,
    "llamenos_rustfs_enabled": True,
    "llamenos_ntfy_enabled": False,
    "llamenos_signal_enabled": True,
    "llamenos_asterisk_enabled": True,
    "llamenos_update_server_enabled": False,
    "llamenos_caddy_enabled": False,
}


class Case:
    def __init__(self, name: str, *, fixture_env=None, ports=None, extra_vars=None,
                 expect=None, expect_result=None, note=""):
        self.name = name
        self.fixture_env = fixture_env or {}
        self.ports = ports if ports is not None else all_up()
        self.extra_vars = extra_vars or {}
        self.expect = expect or {}
        self.expect_result = expect_result
        self.note = note


def cases() -> list[Case]:
    healthy_pass = {
        UFW: "PASS", FAIL2BAN: "PASS", DOCKER: "PASS", USERNS: "PASS", SSHD: "PASS",
        SYNCOOKIES: "PASS", CONTAINERS: "PASS", APP_LIVE: "PASS", APP_READY: "PASS",
        APP_HEALTH: "PASS", POSTGRES: "PASS", RUSTFS: "PASS", SIGNAL: "PASS",
        SIP: "PASS", DISK: "PASS",
        # Off in BASE_VARS: these must be SKIPPED, not PASS.
        NTFY: "SKIPPED", NTFY_PUBLIC: "SKIPPED", UPDATES: "SKIPPED",
        CADDY: "SKIPPED", HSTS: "SKIPPED", XFO: "SKIPPED",
    }
    out = [
        # ── case 3: healthy host, nothing forced ──────────────────────────
        Case("healthy", expect=healthy_pass, expect_result="PASSED",
             note="every probe that can run here measures healthy; the six "
                  "disabled features record SKIPPED and the gate says so"),

        # ── case 1: a probe forced to skip must NOT read as PASS ──────────
        # This is the bug. Each of these turns one `when:` false.
        Case("skip_postgres", extra_vars={"llamenos_postgres_enabled": False},
             expect={POSTGRES: "SKIPPED", APP_LIVE: "PASS"}, expect_result="PASSED",
             note="llamenos_postgres_enabled: false — the probe never ran"),
        Case("skip_storage", extra_vars={"llamenos_rustfs_enabled": False},
             expect={RUSTFS: "SKIPPED", APP_LIVE: "PASS"}, expect_result="PASSED"),
        Case("skip_signal", extra_vars={"llamenos_signal_enabled": False},
             expect={SIGNAL: "SKIPPED"}, expect_result="PASSED"),
        Case("skip_sip", extra_vars={"llamenos_asterisk_enabled": False},
             expect={SIP: "SKIPPED"}, expect_result="PASSED"),
        Case("skip_ntfy", extra_vars={"llamenos_ntfy_enabled": False},
             expect={NTFY: "SKIPPED", NTFY_PUBLIC: "SKIPPED"}, expect_result="PASSED"),
        # The whole host excluded from the app group: every app-placed probe
        # skips at once. Previously this scored SIX silent PASSes.
        Case("skip_not_app_host", extra_vars={"_smoke_force_not_app": True},
             expect={APP_LIVE: "SKIPPED", APP_READY: "SKIPPED", APP_HEALTH: "SKIPPED",
                     UFW: "PASS", DISK: "PASS"},
             expect_result="PASSED",
             note="this host serves no app; the three app probes never ran"),

        # ── case 1b: the confirmed instance ──────────────────────────────
        # Caddy enabled but nothing answers, so the header probe fails. The
        # HSTS and X-Frame-Options verdicts used to come from an `assert` whose
        # `when:` excluded it in exactly this situation — a skipped assert is
        # `succeeded`, so both recorded PASS while nothing had looked at a
        # single header.
        Case("hsts_unmeasured", extra_vars={"llamenos_caddy_enabled": True},
             expect={CADDY: "FAIL", HSTS: "FAIL", XFO: "FAIL"}, expect_result="FAILED",
             note="issue #1617's confirmed instance: the header probe could "
                  "not run, so no header verdict may be PASS"),

        # ── case 2: the probed condition genuinely broken → FAIL ─────────
        Case("broken_ufw", fixture_env={"FIXTURE_UFW": "inactive"},
             expect={UFW: "FAIL", FAIL2BAN: "PASS"}, expect_result="FAILED"),
        Case("broken_ufw_absent", fixture_env={"FIXTURE_UFW": "absent"},
             expect={UFW: "FAIL"}, expect_result="FAILED",
             note="ufw not installed at all — rc 127, not a skip"),
        Case("broken_fail2ban", fixture_env={"FIXTURE_FAIL2BAN": "inactive"},
             expect={FAIL2BAN: "FAIL"}, expect_result="FAILED"),
        Case("broken_docker", fixture_env={"FIXTURE_DOCKER": "inactive"},
             expect={DOCKER: "FAIL"}, expect_result="FAILED"),
        Case("broken_userns", fixture_env={"FIXTURE_USERNS": "off"},
             expect={USERNS: "FAIL"}, expect_result="FAILED"),
        Case("broken_sshd", fixture_env={"FIXTURE_SSHD": "open"},
             expect={SSHD: "FAIL"}, expect_result="FAILED"),
        Case("broken_syncookies", fixture_env={"FIXTURE_SYNCOOKIES": "0"},
             expect={SYNCOOKIES: "FAIL"}, expect_result="FAILED"),
        Case("broken_containers", fixture_env={"FIXTURE_UNHEALTHY_CONTAINERS": "llamenos-app"},
             expect={CONTAINERS: "FAIL"}, expect_result="FAILED"),
        Case("broken_postgres", fixture_env={"FIXTURE_POSTGRES": "down"},
             expect={POSTGRES: "FAIL", RUSTFS: "PASS"}, expect_result="FAILED",
             note="and RustFS still PASSes: both go through `docker compose "
                  "exec`, so one broken service must not decide the other"),
        # Broken INSIDE the container, while the loopback fixture on host port
        # 9000 still answers 403. #1615 moved this probe in-container because
        # the compose template publishes no ports, so a host port that answers
        # must not rescue the verdict — which is what the pre-#1615 probe
        # measured, and all it measured.
        Case("broken_rustfs", fixture_env={"FIXTURE_RUSTFS": "down"},
             expect={RUSTFS: "FAIL", POSTGRES: "PASS"}, expect_result="FAILED",
             note="in-container curl cannot reach RustFS; the host port can"),
        Case("broken_disk", fixture_env={"FIXTURE_DISK_FREE_GB": "1"},
             expect={DISK: "FAIL"}, expect_result="FAILED",
             note="1 GiB free, floor is 2"),
    ]
    # One HTTP probe broken at a time: the service answers, with the wrong code.
    for name, port, path, check in [
        ("broken_app_live", 3000, "/api/health/live", APP_LIVE),
        ("broken_app_ready", 3000, "/api/health/ready", APP_READY),
        ("broken_app_health", 3000, "/api/health", APP_HEALTH),
        ("broken_signal", 3100, "/health", SIGNAL),
        ("broken_sip", 3101, "/health", SIP),
    ]:
        ports = {p: dict(c) for p, c in all_up().items()}
        ports[port][path] = 500
        out.append(Case(name, ports=ports, expect={check: "FAIL"}, expect_result="FAILED"))
    # A service entirely absent (connection refused), not merely unhealthy.
    ports = {p: dict(c) for p, c in all_up().items() if p != 3100}
    out.append(Case("absent_signal_sidecar", ports=ports, expect={SIGNAL: "FAIL"},
                    expect_result="FAILED", note="nothing listening on 3100 at all"))
    return out


class Harness:
    def __init__(self, tmp: Path, playbook: str):
        self.tmp = tmp
        self.playbook = playbook
        self.bin = tmp / "bin"
        self.bin.mkdir(parents=True, exist_ok=True)
        for name, body in STUBS.items():
            p = self.bin / name
            p.write_text(body)
            p.chmod(0o755)
        self.app_dir = tmp / "app"
        for svc in ("postgres", "rustfs"):
            (self.app_dir / "services" / svc).mkdir(parents=True, exist_ok=True)
        self.failures: list[str] = []
        self.n = 0

    # ── fixtures ────────────────────────────────────────────────────────
    def start_server(self, ports: dict[str, dict[str, int]]):
        spec = ";".join(
            f"{port}:" + ",".join(f"{path}={code}" for path, code in codes.items())
            for port, codes in ports.items()
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", FIXTURE_SERVER, spec],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        busy = []
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("fixture server died before becoming ready")
            if line.startswith("FIXTURE-PORT-BUSY"):
                busy.append(line.strip())
            if line.startswith("READY"):
                break
        if busy:
            proc.terminate()
            raise RuntimeError(
                "a port this harness needs is already in use — stop the local dev "
                "server and retry:\n  " + "\n  ".join(busy))
        return proc

    def inventory(self, serves_app: bool) -> dict:
        """One host pointing at this machine. `llamenos_app` is left EMPTY when
        the host should not serve the app, which is how the playbook's
        `_smoke_serves_*` vars express placement."""
        groups = {g: {"hosts": {"smoke-target": {}}}
                  for g in ("llamenos_db", "llamenos_storage", "llamenos_ntfy", "llamenos_asterisk")}
        groups["llamenos_app"] = {"hosts": {"other-host": {}}} if not serves_app else {"hosts": {"smoke-target": {}}}
        return {
            "all": {
                "vars": {
                    "ansible_connection": "local",
                    "ansible_become": False,
                    "ansible_python_interpreter": sys.executable,
                },
                "children": {
                    "llamenos_servers": {"hosts": {"smoke-target": {"ansible_host": "127.0.0.1"}}},
                    **groups,
                },
            }
        }

    # ── running ─────────────────────────────────────────────────────────
    def run_case(self, case: Case) -> tuple[int, str, list[dict]]:
        self.n += 1
        extra = dict(BASE_VARS)
        extra.update(case.extra_vars)
        serves_app = not extra.pop("_smoke_force_not_app", False)
        extra["app_dir"] = str(self.app_dir)
        extra["deploy_user"] = getpass.getuser()

        inv = self.tmp / f"inv-{self.n}.json"
        inv.write_text(json.dumps(self.inventory(serves_app)))
        varsf = self.tmp / f"vars-{self.n}.json"
        varsf.write_text(json.dumps(extra))

        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "ANSIBLE_NOCOLOR": "1",
            "ANSIBLE_FORCE_COLOR": "0",
            "ANSIBLE_STDOUT_CALLBACK": "json",
            # The retries on the HTTP probes would make a deliberately broken
            # fixture take 15s+ per case; the verdict is the same on attempt 1.
            "ANSIBLE_TIMEOUT": "5",
        }
        env.update({k: str(v) for k, v in case.fixture_env.items()})

        server = self.start_server(case.ports)
        try:
            proc = subprocess.run(
                ["ansible-playbook", self.playbook, "-i", str(inv), "-e", f"@{varsf}"],
                cwd=ANSIBLE_DIR, capture_output=True, text=True,
                stdin=subprocess.DEVNULL, env=env, timeout=900,
            )
        finally:
            server.terminate()
            server.wait(timeout=10)
        return proc.returncode, proc.stdout + proc.stderr, extract_results(proc.stdout)

    def expect(self, case: Case, rc: int, out: str, results: list[dict]) -> None:
        problems: list[str] = []
        if not results:
            problems.append("no smoke_results were recorded at all")
        by_name = {}
        for r in results:
            by_name[r["check"]] = r["status"]
        for needle, want in case.expect.items():
            hits = [(n, s) for n, s in by_name.items() if needle in n]
            if not hits:
                problems.append(f"no check matching {needle!r} was recorded "
                                f"(recorded: {sorted(by_name)})")
            elif len(hits) > 1:
                problems.append(f"{needle!r} matched several checks: {hits}")
            elif hits[0][1] != want:
                problems.append(f"{hits[0][0]!r}: expected {want}, got {hits[0][1]}")
        if case.expect_result:
            # `ansible.builtin.fail` exits 2, not 1; all that matters is that a
            # FAILED summary makes the deploy step non-zero and a PASSED one
            # does not.
            want_zero = case.expect_result == "PASSED"
            if want_zero and rc != 0:
                problems.append(f"expected the play to exit 0 (PASSED), got {rc}")
            if not want_zero and rc == 0:
                problems.append("expected the play to exit non-zero (FAILED), got 0")
            m = re.search(r"Result: (\w+)", out)
            if m and m.group(1) != case.expect_result:
                problems.append(f"summary says Result: {m.group(1)}, "
                                f"expected {case.expect_result}")
        # A SKIPPED verdict must never be counted as a pass anywhere.
        if "SKIPPED" in case.expect.values():
            n_skipped = sum(1 for s in by_name.values() if s == "SKIPPED")
            if f"Skipped: {n_skipped}" not in out:
                problems.append(f"summary does not report Skipped: {n_skipped}")
            if "NOT MEASURED" not in out:
                problems.append("summary does not flag the skipped checks as NOT MEASURED")

        label = f"{case.name}" + (f" — {case.note}" if case.note else "")
        if problems:
            self.failures.append(case.name)
            print(f"FAIL  {label}")
            for p in problems:
                print(f"        {p}")
            for line in out.strip().splitlines()[-15:]:
                print(f"        | {line}")
        else:
            summary = ", ".join(f"{n.split(' (')[0][:34]}={s}" for n, s in
                                sorted((k, v) for k, v in by_name.items()
                                       if any(x in k for x in case.expect)))
            print(f"ok    {label}")
            print(f"        {summary}")


def extract_results(stdout: str) -> list[dict]:
    """The last `smoke_results` value any task set, read out of the JSON
    callback. Taken from the task results rather than the printed summary so it
    is still available when the play later aborts — which the pre-fix playbook
    does, on the dead `startswith` test (#1602)."""
    try:
        data, _ = json.JSONDecoder().raw_decode(stdout[stdout.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return []
    latest: list[dict] = []
    for play in data.get("plays", []):
        for task in play.get("tasks", []):
            for res in task.get("hosts", {}).values():
                got = (res.get("ansible_facts") or {}).get("smoke_results")
                if isinstance(got, list):
                    latest = got
    return latest


def compare_old(ref: str, only: list[str] | None) -> int:
    """Run the same fixtures against the playbook as it was at `ref`."""
    show = subprocess.run(["git", "show", f"{ref}:deploy/ansible/{SMOKE_PLAYBOOK}"],
                          cwd=ANSIBLE_DIR, capture_output=True, text=True)
    if show.returncode != 0:
        print(f"ERROR: cannot read {SMOKE_PLAYBOOK} at {ref}: {show.stderr.strip()}",
              file=sys.stderr)
        return 2
    selected = [c for c in cases() if not only or c.name in only]
    with tempfile.TemporaryDirectory(prefix="smoke-verdicts-old-") as d:
        tmp = Path(d)
        old = ANSIBLE_DIR / "playbooks" / "_smoke-check-at-ref.yml"
        old.write_text(show.stdout)
        try:
            new_h = Harness(tmp / "new", SMOKE_PLAYBOOK)
            old_h = Harness(tmp / "old", f"playbooks/{old.name}")
            print(f"Same fixtures, two playbooks: HEAD vs {ref}\n")
            differing = 0
            for case in selected:
                _, _, new_r = new_h.run_case(case)
                _, _, old_r = old_h.run_case(case)
                new_by = {r["check"]: r["status"] for r in new_r}
                old_by = {r["check"]: r["status"] for r in old_r}
                rows = []
                for needle in case.expect:
                    n = next((f"{v}" for k, v in new_by.items() if needle in k), "(absent)")
                    o = next((f"{v}" for k, v in old_by.items() if needle in k), "(absent)")
                    if n != o:
                        differing += 1
                        rows.append(f"    {needle:<34} {ref}={o:<10} HEAD={n}")
                if rows:
                    print(f"  {case.name}:")
                    print("\n".join(rows))
            print(f"\n{differing} verdict(s) changed. Every row above is a check that "
                  f"recorded a\ndifferent state from identical inputs; a PASS on the "
                  f"{ref} side for a probe\nthat did not run is issue #1617.")
        finally:
            old.unlink(missing_ok=True)
    return 0


def reexec_in_netns() -> None:
    """Re-run this script inside a private network namespace.

    The probes' ports are hard-coded in the playbook (3000, 2586, 3100, 3101,
    plus 9000 for the pre-#1615 host-side RustFS probe `--compare-old` runs)
    and a developer box routinely has a real dev server on 3000 and RustFS on
    9000. Probing those would mean the suite silently measured
    something other than the fixture — the failure mode that cost the #1277 and
    Playwright-proxy misdiagnoses. `unshare --map-root-user --net` needs no
    privileges and gives this process its own loopback, so the fixtures are the
    only thing any probe can reach.
    """
    os.environ["SMOKE_VERDICTS_NETNS"] = "1"
    os.execvp("unshare", [
        "unshare", "--map-root-user", "--net", "--",
        "sh", "-c", 'ip link set lo up 2>/dev/null; exec "$@"', "sh",
        sys.executable, str(Path(__file__).resolve()), *sys.argv[1:],
    ])


def main() -> int:
    if not os.environ.get("SMOKE_VERDICTS_NETNS") and "--no-netns" not in sys.argv:
        if shutil.which("unshare"):
            reexec_in_netns()  # does not return
        print("NOTE: `unshare` not found — running on the host's network. Any of "
              "ports 3000/9000/2586/3100/3101 already in use will abort.",
              file=sys.stderr)

    ap = argparse.ArgumentParser()
    ap.add_argument("--no-netns", action="store_true",
                    help="do not isolate the network namespace (ports must be free)")
    ap.add_argument("--only", nargs="*", help="case names to run")
    ap.add_argument("--compare-old", metavar="REF",
                    help="also run the same fixtures against the playbook at REF")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for c in cases():
            print(c.name)
        return 0
    if not shutil.which("ansible-playbook"):
        print("ansible-playbook not found on PATH", file=sys.stderr)
        return 2
    if not (ANSIBLE_DIR / "vars.yml").exists():
        print("deploy/ansible/vars.yml is missing (the playbook declares it in "
              "vars_files). Create it with:\n"
              "  cp deploy/ansible/vars.example.yml deploy/ansible/vars.yml",
              file=sys.stderr)
        return 2

    if args.compare_old:
        return compare_old(args.compare_old, args.only)

    selected = [c for c in cases() if not args.only or c.name in args.only]
    unknown = set(args.only or []) - {c.name for c in cases()}
    if unknown:
        print(f"unknown case(s): {sorted(unknown)}", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="smoke-verdicts-") as d:
        h = Harness(Path(d), SMOKE_PLAYBOOK)
        for case in selected:
            rc, out, results = h.run_case(case)
            h.expect(case, rc, out, results)
    print()
    if h.failures:
        print(f"{len(h.failures)} case(s) behaved wrongly: {', '.join(h.failures)}")
        return 1
    print(f"all {len(selected)} smoke-verdict cases behaved as expected")
    return 0


if __name__ == "__main__":
    sys.exit(main())

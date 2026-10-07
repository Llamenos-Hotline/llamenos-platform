#!/usr/bin/env python3
"""Prove every disk-tier guard passes on a good layout and FIRES on a bad one.

The reference deployment runs two hosts: an encrypted one for the app, the
database and every secret, and an unencrypted one that runs only the ntfy push
relay (see docs/deployment/first-deploy.md, "Two hosts, two tiers"). The rule
is enforced by guards spread over preflight, the ntfy and Caddy roles, the
data-writing playbooks and the per-host role gating. An assertion nobody has
seen fail is not a control, so each case below either expects success or
injects the defect the guard exists for and expects the guard's own message.

Everything runs against localhost (`ansible_connection: local`, no become):
two inventory hosts that both point at this machine. No server is touched and
nothing is written outside a temp directory. Caddy cases need Docker.

Usage:
    python3 deploy/ansible/scripts/check-disk-tier-guards.py [--only GROUP ...]

GROUP is one of: preflight, guards, skip, gating, tags (default: all).

Group `tags` is the tag-scoped half. Every `just deploy-*` recipe runs with
`--tags X`, and a `tags: always` on a dynamic `include_tasks` tags ONLY the
include, so a guard behind one is silently skipped exactly on the normal deploy
path. It (a) statically refuses any include_tasks/include_role that carries
`tags:` without `apply:`, and (b) re-runs the RAM, disk-tier and dev-routes
guards and the unencrypted-host skip under each recipe's tag selection with the
violating layout and requires the guard's own failure.
"""
from __future__ import annotations

import getpass
import grp
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent.parent

HOSTS = {
    "llamenos-platform1": {"llamenos_disk_encrypted": True},
    "llamenos-relay1": {"llamenos_disk_encrypted": False},
}
GROUPS = {
    "llamenos_app": ["llamenos-platform1"],
    "llamenos_db": ["llamenos-platform1"],
    "llamenos_storage": ["llamenos-platform1"],
    "llamenos_proxy": ["llamenos-platform1", "llamenos-relay1"],
    "llamenos_ntfy": ["llamenos-relay1"],
}

# Valid values for every var preflight checks; dummy, never real credentials.
VALID_VARS = {
    "domain": "hotline.example.org",
    "acme_email": "ops@example.org",
    "llamenos_app_image": "llamenos:check-disk-tier",
    "app_environment": "production",
    "webhook_base_url": "https://api.hotline.example.org",
    "hmac_secret": secrets.token_hex(32),
    "server_secret": secrets.token_hex(32),
    "pg_password": secrets.token_urlsafe(24),
    "storage_access_key": secrets.token_hex(16),
    "storage_secret_key": secrets.token_urlsafe(24),
    "ssh_allowed_cidrs": ["203.0.113.7/32"],
    "llamenos_ntfy_enabled": True,
    "ntfy_domain": "push.hotline.example.org",
    "llamenos_dns_validation_enabled": False,
    "dev_routes_enabled": False,
    "dev_reset_secret": "",
}


def inventory(hosts: dict | None = None, groups: dict | None = None, host_addr: dict | None = None) -> dict:
    hosts = HOSTS if hosts is None else hosts
    groups = GROUPS if groups is None else groups
    host_addr = host_addr or {}
    return {
        "all": {
            "vars": {
                "ansible_connection": "local",
                "ansible_become": False,
                "ansible_python_interpreter": sys.executable,
            },
            "children": {
                "llamenos_servers": {
                    "hosts": {
                        name: {"ansible_host": host_addr.get(name, "127.0.0.1"), **hv}
                        for name, hv in hosts.items()
                    }
                },
                **{g: {"hosts": {h: {} for h in members}} for g, members in groups.items()},
            },
        }
    }


class Runner:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.failures: list[str] = []
        self.n = 0

    def run(self, playbook: str, inv: dict, extra: dict, *args: str, env: dict | None = None):
        self.n += 1
        inv_path = self.tmp / f"inv-{self.n}.json"
        inv_path.write_text(json.dumps(inv))
        vars_path = self.tmp / f"vars-{self.n}.json"
        vars_path.write_text(json.dumps({**VALID_VARS, **extra}))
        cmd = ["ansible-playbook", playbook, "-i", str(inv_path), "-e", f"@{vars_path}", *args]
        proc = subprocess.run(
            cmd, cwd=ANSIBLE_DIR, capture_output=True, text=True, stdin=subprocess.DEVNULL,
            env={**os.environ, "ANSIBLE_NOCOLOR": "1", "ANSIBLE_FORCE_COLOR": "0", **(env or {})},
        )
        self.last_stdout = proc.stdout
        return proc.returncode, proc.stdout + proc.stderr

    def expect(self, name: str, rc_ok: bool, out: str, rc: int, must: list[str] = (), must_not: list[str] = ()):
        problems = []
        if rc_ok and rc != 0:
            problems.append(f"expected success, got rc={rc}")
        if not rc_ok and rc == 0:
            problems.append("expected the guard to FAIL, but the run succeeded")
        problems += [f"missing expected text: {m!r}" for m in must if m not in out]
        problems += [f"unexpected text present: {m!r}" for m in must_not if m in out]
        if problems:
            self.failures.append(name)
            print(f"FAIL  {name}")
            for p in problems:
                print(f"        {p}")
            tail = "\n".join(out.strip().splitlines()[-25:])
            print("        --- last output ---\n" + "\n".join("        " + l for l in tail.splitlines()))
        else:
            print(f"ok    {name}")


def preflight_cases(r: Runner) -> None:
    pf = "playbooks/preflight.yml"
    # Start at the variable-validation play: the first play checks THIS machine
    # (distribution, free disk, SSH), which says nothing about the guards and
    # fails on an unsupported workstation distro or inside a container.
    real_run = r.run

    def run(playbook, inv, extra, *args, **kw):
        return real_run(playbook, inv, extra, "--start-at-task", "Print deployment target summary", *args, **kw)

    r.run = run  # type: ignore[method-assign]

    rc, out = r.run(pf, inventory(), {})
    r.expect("preflight: two-tier layout passes", True, out, rc,
             must=["llamenos-relay1: llamenos_disk_encrypted=False", "ALL PREFLIGHT CHECKS PASSED"])

    g = {**GROUPS, "llamenos_db": ["llamenos-platform1", "llamenos-relay1"]}
    rc, out = r.run(pf, inventory(groups=g), {})
    r.expect("preflight: unencrypted host in llamenos_db is refused", False, out, rc,
             must=["REFUSING TO DEPLOY: llamenos-relay1", "the `llamenos_db` service", "PostgreSQL database"])

    g = {**GROUPS, "llamenos_app": ["llamenos-platform1", "llamenos-relay1"]}
    rc, out = r.run(pf, inventory(groups=g), {})
    r.expect("preflight: unencrypted host in llamenos_app is refused", False, out, rc,
             must=["the `llamenos_app` service"])

    g = {**GROUPS, "llamenos_storage": []}
    rc, out = r.run(pf, inventory(groups=g), {})
    r.expect("preflight: empty llamenos_storage (falls back to every host) is refused", False, out, rc,
             must=["the `llamenos_storage` service", "group is empty"])

    g = {**GROUPS, "llamenos_signal": ["llamenos-relay1"]}
    rc, out = r.run(pf, inventory(groups=g), {"llamenos_signal_enabled": True,
                                                "signal_notifier_bearer_token": secrets.token_hex(32)})
    r.expect("preflight: Signal sidecar on the unencrypted host is refused", False, out, rc,
             must=["the `llamenos_signal` service"])

    rc, out = r.run(pf, inventory(), {"llamenos_internal_tls_enabled": True})
    r.expect("preflight: internal TLS keys on the unencrypted host are refused", False, out, rc,
             must=["llamenos_internal_tls_enabled is true"])

    h = {**HOSTS, "llamenos-relay1": {}}
    rc, out = r.run(pf, inventory(hosts=h), {})
    r.expect("preflight: a host without llamenos_disk_encrypted is refused", False, out, rc,
             must=["REQUIRED: set `llamenos_disk_encrypted: true` or `false`"])

    h = {**HOSTS, "llamenos-relay1": {"llamenos_disk_encrypted": "false"}}
    rc, out = r.run(pf, inventory(hosts=h), {})
    r.expect("preflight: a string 'false' (not a YAML boolean) is refused", False, out, rc,
             must=["REQUIRED: set `llamenos_disk_encrypted: true` or `false`"])

    # Per-host DNS: the relay must resolve push.<domain> to ITSELF and is not
    # asked about the API names. `localhost` is the one name that resolves the
    # same on every machine, so it stands in for push.<domain>.
    dns = {"llamenos_dns_validation_enabled": True, "ntfy_domain": "localhost"}
    rc, out = r.run(pf, inventory(), dns, "--limit", "llamenos-relay1")
    r.expect("preflight: relay DNS checks only ntfy_domain, resolving to the relay", True, out, rc,
             must=["(item=localhost)"], must_not=["(item=api.hotline.example.org)", "(item=hotline.example.org)"])

    rc, out = r.run(pf, inventory(host_addr={"llamenos-relay1": "127.0.0.2"}), dns, "--limit", "llamenos-relay1")
    r.expect("preflight: ntfy_domain resolving elsewhere than the relay is refused", False, out, rc,
             must=["DNS mismatch: localhost resolves to", "expected this server's address 127.0.0.2"])
    r.run = real_run  # type: ignore[method-assign]


def harness_cases(r: Runner) -> None:
    if not shutil.which("docker"):
        r.failures.append("guards")
        print("FAIL  guards: docker not found (the Caddy cases adapt the Caddyfile with Caddy itself)")
        return
    pb = "playbooks/check-disk-tier-guards.yml"
    cases = [
        ("ntfy_clean", True, ["no persistent cache, attachments or log file"]),
        ("ntfy_cache_file", False, ["REFUSING TO DEPLOY: the ntfy service on llamenos-relay1", "Offending setting(s): CACHE_FILE"]),
        ("caddy_relay", True, ["Caddy on llamenos-relay1: no access log"]),
        ("caddy_access_log", False, ["would write\nclient addresses or device topics to disk", "Servers with an access log"]),
        ("caddy_no_filter", False, ["default logger encoder: none"]),
        ("caddy_platform", True, []),
    ]
    for case, ok, must in cases:
        rc, out = r.run(pb, inventory(), {"disk_tier_case": case})
        # fail_msg is YAML-folded into the JSON-ish result; compare on collapsed whitespace.
        flat = " ".join(out.split())
        r.expect(f"guard: {case}", ok, flat, rc, must=[" ".join(m.split()) for m in must])


def skip_cases(r: Runner) -> None:
    for pb, extra, first_task in [
        ("playbooks/backup.yml", {}, "Ensure backup base directory exists"),
        ("playbooks/restore.yml", {}, "Validate age key path"),
        ("playbooks/update.yml", {}, "Track current versions"),
        ("playbooks/rollback.yml", {}, "Pre-flight"),
        ("playbooks/observability.yml", {"observability_enabled": True}, "Validate observability is enabled"),
    ]:
        rc, out = r.run(pb, inventory(), extra, "--check", "--limit", "llamenos-relay1")
        r.expect(f"skip: {pb} ends for the unencrypted host before writing anything", True, out, rc,
                 must=["Skipping llamenos-relay1: llamenos_disk_encrypted is false"],
                 must_not=[f"TASK [{first_task}"])


def gating_case(r: Runner) -> None:
    """Service roles must skip per host. With the old `meta: end_play` the gate
    was evaluated for the first host only, so llamenos-relay1 (not in
    llamenos_db) ran the postgres role because llamenos-platform1 (first) is."""
    app_dir = r.tmp / "app"
    extra = {
        "app_dir": str(app_dir),
        "deploy_user": getpass.getuser(),
        "deploy_group": grp.getgrgid(os.getgid()).gr_name,
    }
    rc, out = r.run("playbooks/deploy.yml", inventory(), extra, "--check", "--tags", "postgres,ntfy",
                    env={"ANSIBLE_STDOUT_CALLBACK": "json"})
    try:
        # ansible.cfg also enables profile_tasks, which prints after the JSON document.
        stdout = r.last_stdout
        data, _ = json.JSONDecoder().raw_decode(stdout[stdout.index("{"):])
    except ValueError:
        r.expect("gating: roles run only on their own group's hosts", True, out, 1, must=["<json output>"])
        return
    ran: dict[str, set[str]] = {}
    for play in data.get("plays", []):
        for task in play.get("tasks", []):
            ran.setdefault(task["task"]["name"], set()).update(
                h for h, res in task["hosts"].items() if not res.get("skipped"))
    pg = ran.get("llamenos-postgres : Create postgres service directory", set())
    nt = ran.get("llamenos-ntfy : Create ntfy service directory", set())
    problems = []
    if pg != {"llamenos-platform1"}:
        problems.append(f"postgres service dir task ran on {sorted(pg)}, expected only llamenos-platform1")
    if nt != {"llamenos-relay1"}:
        problems.append(f"ntfy service dir task ran on {sorted(nt)}, expected only llamenos-relay1")
    if problems:
        r.failures.append("gating")
        print("FAIL  gating: roles run only on their own group's hosts")
        for p in problems:
            print(f"        {p}")
    else:
        print("ok    gating: postgres only on llamenos-platform1, ntfy only on llamenos-relay1")



# ── tag-scoped guards ────────────────────────────────────────────────────────

def recipe_tags() -> list[str]:
    """Every `--tags X` a `just deploy-*` recipe passes to playbooks/deploy.yml."""
    text = (ANSIBLE_DIR / "justfile").read_text()
    tags: list[str] = []
    for m in re.finditer(r"ansible-playbook playbooks/deploy\.yml[^\n]*--tags (\S+)", text):
        for t in m.group(1).split(","):
            if t not in tags:
                tags.append(t)
    return tags


def static_include_cases(r: Runner) -> None:
    """A dynamic include (include_tasks / include_role) with its own `tags:` tags
    only the include statement. The tasks inside inherit nothing unless the
    include also carries `apply: {tags: ...}`; use import_tasks/import_role when
    the tag must reach every inner task."""
    import yaml

    modules = ("include_tasks", "include_role", "ansible.builtin.include_tasks", "ansible.builtin.include_role")

    def walk(tasks, path, out):
        for t in tasks if isinstance(tasks, list) else []:
            if not isinstance(t, dict):
                continue
            for key in ("block", "rescue", "always"):
                walk(t.get(key), path, out)
            for mod in modules:
                if mod in t and "tags" in t:
                    args = t[mod]
                    if not (isinstance(args, dict) and isinstance(args.get("apply"), dict) and "tags" in args["apply"]):
                        out.append(f"{path}: {t.get('name', mod)!r}")

    files = [ANSIBLE_DIR / "setup.yml", *sorted((ANSIBLE_DIR / "playbooks").rglob("*.yml")),
             *sorted((ANSIBLE_DIR / "roles").glob("*/tasks/*.yml")),
             *sorted((ANSIBLE_DIR / "roles").glob("*/handlers/*.yml"))]
    bad: list[str] = []
    for f in files:
        data = yaml.safe_load(f.read_text())
        rel = str(f.relative_to(ANSIBLE_DIR))
        if not isinstance(data, list):
            continue
        walk(data, rel, bad)  # a tasks file is a plain list of tasks
        for play in data:
            if isinstance(play, dict):
                for k in ("tasks", "pre_tasks", "post_tasks", "handlers"):
                    walk(play.get(k), rel, bad)
    r.expect("tags: no include_tasks/include_role carries `tags:` without `apply: {tags:}`", True,
             "\n".join(bad), 1 if bad else 0)


def fake_facts(nocache_free: int, memfree: int, root_free_gib: int = 100) -> dict:
    """Facts for the play-1 checks of preflight.yml: a supported distro, plenty
    of disk and the fabricated memory numbers. Passed as `-e ansible_facts=...`,
    which outranks the facts the play gathers, so the same preflight.yml that
    ships is exercised end to end with memory the host does not really have."""
    proc = subprocess.run(["ansible", "localhost", "-c", "local", "-i", "localhost,", "-m", "ansible.builtin.setup"],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL, cwd=tempfile.gettempdir(),
                          env={**os.environ, "ANSIBLE_NOCOLOR": "1"})
    real = json.loads(proc.stdout[proc.stdout.index("=> ") + 3:])["ansible_facts"]
    f = {k[len("ansible_"):]: v for k, v in real.items() if k.startswith("ansible_")}
    f.update(os_family="Debian", distribution="Debian", distribution_major_version="13",
             distribution_version="13", distribution_release="trixie", memfree_mb=memfree,
             memory_mb={"real": {"free": memfree}, "nocache": {"free": nocache_free}},
             mounts=[{"mount": "/", "size_available": root_free_gib * 1024 ** 3}])
    return f


def tag_cases(r: Runner) -> None:
    static_include_cases(r)
    pf = "playbooks/preflight.yml"
    tags = recipe_tags()
    r.expect("tags: found the deploy recipes' --tags in the justfile", len(tags) >= 5, f"got {tags}",
             0 if len(tags) >= 5 else 1)
    # `deploy` is what `setup.yml --tags deploy` uses; `preflight` is the tag setup.yml gives this playbook.
    tags = [*tags, "deploy", "preflight"]
    warm = fake_facts(7929, 481)
    # Both hosts point at this machine; the play-1 (facts) checks run for one only.
    only_platform = ("--limit", "llamenos-platform1")

    for tag in tags:
        t = f"--tags {tag}"
        g = {**GROUPS, "llamenos_db": ["llamenos-platform1", "llamenos-relay1"]}
        rc, out = r.run(pf, inventory(groups=g), {"ansible_facts": warm}, "--tags", tag)
        r.expect(f"tags[{t}]: disk-tier guard refuses an unencrypted host in llamenos_db", False, out, rc,
                 must=["REFUSING TO DEPLOY: llamenos-relay1", "the `llamenos_db` service"])
        g = {**GROUPS, "llamenos_storage": []}
        rc, out = r.run(pf, inventory(groups=g), {"ansible_facts": warm}, "--tags", tag)
        r.expect(f"tags[{t}]: disk-tier guard refuses the empty-group fallback", False, out, rc,
                 must=["the `llamenos_storage` service", "group is empty"])
        h = {**HOSTS, "llamenos-relay1": {}}
        rc, out = r.run(pf, inventory(hosts=h), {"ansible_facts": warm}, "--tags", tag)
        r.expect(f"tags[{t}]: disk-tier guard refuses a host without llamenos_disk_encrypted", False, out, rc,
                 must=["REQUIRED: set `llamenos_disk_encrypted: true` or `false`"])
        # The demo_mode half of this pair went with tasks/guard-demo-mode.yml in #1604.
        # tasks/guard-dev-routes.yml, which never referenced demo mode, carries both
        # remaining directions.
        rc, out = r.run(pf, inventory(), {"ansible_facts": warm, "dev_routes_enabled": True}, "--tags", tag)
        r.expect(f"tags[{t}]: dev-routes guard refuses dev_routes_enabled in production", False, out, rc,
                 must=["REFUSING TO DEPLOY: dev_routes_enabled and dev_reset_secret"])
        rc, out = r.run(pf, inventory(), {"ansible_facts": warm, "dev_reset_secret": "x" * 64}, "--tags", tag)
        r.expect(f"tags[{t}]: dev-routes guard refuses dev_reset_secret in production", False, out, rc,
                 must=["REFUSING TO DEPLOY: dev_routes_enabled and dev_reset_secret"])
        # MemFree looks healthy but MemAvailable is below the floor -> must fail...
        rc, out = r.run(pf, inventory(), {"ansible_facts": fake_facts(300, 8000)}, "--tags", tag, *only_platform)
        r.expect(f"tags[{t}]: RAM floor refuses 300 MiB available (MemFree 8000)", False, out, rc,
                 must=["INSUFFICIENT MEMORY", "Available RAM: 300 MiB"])
        # ...and the #980 fix holds under tags: warm host, MemFree 481, available 7929 -> pass.
        rc, out = r.run(pf, inventory(), {"ansible_facts": warm}, "--tags", tag, *only_platform)
        r.expect(f"tags[{t}]: RAM floor passes a warm host (MemFree 481, available 7929)", True, out, rc,
                 must=["RAM OK: 7929 MiB available"])

    # Positive control: the good two-tier layout passes under tags AND the guard
    # tasks visibly ran (a guard that was skipped would also "pass").
    rc, out = r.run(pf, inventory(), {"ansible_facts": warm}, "--tags", "app")
    r.expect("tags[--tags app]: two-tier layout passes and the guards actually ran", True, out, rc,
             must=["llamenos-relay1: llamenos_disk_encrypted=False", "Production safety guard passed",
                   "RAM OK: 7929 MiB"])

    # Data-at-rest playbooks skip an unencrypted host even when a tag is selected.
    for pb, extra in [
        ("playbooks/backup.yml", {}),
        ("playbooks/restore.yml", {}),
        ("playbooks/update.yml", {}),
        ("playbooks/rollback.yml", {}),
        ("playbooks/observability.yml", {"observability_enabled": True}),
        ("playbooks/test-restore.yml", {}),
        ("playbooks/backup-status.yml", {}),
    ]:
        text = (ANSIBLE_DIR / pb).read_text()
        # A tag the playbook itself defines, else an arbitrary one (`just backup` takes any service name).
        tag = next((t for m in re.finditer(r"tags:\s*\[([^\]]*)\]", text)
                    for t in re.split(r"\s*,\s*", m.group(1).strip()) if t and t != "always"), "postgres")
        rc, out = r.run(pb, inventory(), extra, "--check", "--limit", "llamenos-relay1", "--tags", tag)
        after = out.split("Skipping llamenos-relay1", 1)[-1].split("PLAY RECAP", 1)[0]
        ran_after = "[llamenos-relay1]" in after.split("\n", 1)[-1]
        r.expect(f"tags[--tags {tag}]: {pb} ends the unencrypted host before writing anything", True,
                 out, rc if not ran_after else 1, must=["Skipping llamenos-relay1: llamenos_disk_encrypted is false"])


def main() -> int:
    if not shutil.which("ansible-playbook"):
        print("ansible-playbook not found on PATH", file=sys.stderr)
        return 2
    groups = {"preflight": preflight_cases, "guards": harness_cases, "skip": skip_cases, "gating": gating_case, "tags": tag_cases}
    only = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else list(groups)
    unknown = [g for g in only if g not in groups]
    if unknown:
        print(f"unknown group(s): {unknown}; choose from {list(groups)}", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="disk-tier-") as d:
        r = Runner(Path(d))
        for g in only:
            groups[g](r)
    print()
    if r.failures:
        print(f"{len(r.failures)} case(s) failed: {', '.join(r.failures)}")
        return 1
    print("all disk-tier guard cases behaved as expected")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Assert every env var apps/worker/lib/config.ts requires at startup is
actually produced by BOTH Ansible .env templates.

Why this exists (PR #771 review round 2, issue #716): roles/llamenos/templates/
env.j2 (the monolithic/demo deploy path) silently drifted from
roles/llamenos-app/templates/env/app.j2 (the per-service production path) and
ended up missing DATABASE_URL entirely -- config.ts hard-fails at startup
without it, so the container never booted. That bug shipped because nothing
checked the two templates stayed in sync. This script is that check.

It does NOT hand-maintain its own copy of the required-var list -- it parses
apps/worker/lib/config.ts itself, so a future var added there (and forgotten
in the Ansible templates) fails CI immediately instead of silently drifting
again.

Usage:
    python3 deploy/ansible/scripts/check-required-env.py

The script ALWAYS renders its own inputs, into a fresh temporary directory
it creates and deletes per run, by invoking playbooks/check-env-templates.yml
twice -- once for the production/required-vars scenario, once for the
all-optional-features scenario. It never reads a pre-existing file.

That is deliberate, and it is the fix for a real hole. This script used to
render to fixed /tmp paths and short-circuit with `if all(p.is_file() for p in
rendered): return`. On any machine where /tmp survives between runs -- notably
the self-hosted runner fleet, where three runners share one box -- the second
and every later invocation reused the FIRST run's output. Deleting SERVER_SECRET
from templates/env/_worker-required-env.j2 still produced "PASSED, rc=0",
because the stale render still contained it. This is the only env-var drift
guard in the repo, so a green that means nothing is worse than no guard at all.
A fixed path on a shared machine was also trivially guessable/poisonable by any
other user on the box. Both problems are closed by owning a private directory
per run: there is no longer any code path that can read another run's files.

Requires ansible-playbook on PATH (CI's ansible-validate job installs it).

Exits non-zero (and prints exactly what's missing, from which file) on any
gap. Run from anywhere; pass --repo-root explicitly if the auto-computed
root is wrong.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Unconditionally-required vars are extracted generically from any
# `assertNonEmpty(env, 'X')` / `assertHex64(env, 'X')` call site in
# config.ts -- including the one INSIDE assertDatabaseUrl(), which itself
# calls `assertNonEmpty(env, 'DATABASE_URL')`. No hardcoded var names here.
UNCONDITIONAL_RE = re.compile(r"assert(?:NonEmpty|Hex64)\(\s*env\s*,\s*'([A-Z_][A-Z0-9_]*)'\s*\)")

# Conditionally-required vars (e.g. WEBHOOK_BASE_URL, only required when
# ENVIRONMENT === 'production') are expressed as raw env['...'] lookups
# inside the "--- Production-required vars ---" section rather than an
# assertX(env, 'X') call, so they need a section-scoped pattern -- still
# parsed FROM config.ts's source text, not hardcoded independently of it.
SECTION_RE = re.compile(
    r"// --- Production-required vars ---(.*?)// --- ", re.DOTALL
)
ENV_LOOKUP_RE = re.compile(r"env\['([A-Z_][A-Z0-9_]*)'\]")

# Optional vars: unlike the required list above, these are never asserted by
# config.ts (they gate an optional feature and warn-not-throw when absent),
# so there's no single call-site shape to parse generically. Hand-maintained
# here, but each one names its real consumer so "is this actually dead" stays
# checkable by grep, not by trusting this comment:
#   APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID -> apps/worker/lib/voip-push.ts,
#     apps/worker/lib/push-dispatch.ts (iOS VoIP + regular push signing)
#   NTFY_URL/NTFY_AUTH_TOKEN             -> same two files (Android push via ntfy)
#   GLITCHTIP_DSN                        -> apps/worker/routes/config.ts (client crash reporting DSN)
#   SIGNAL_NOTIFIER_BEARER_TOKEN         -> signal-notifier/ sidecar auth
#   DEMO_RESET_CRON                      -> apps/worker/routes/config.ts -> demoResetSchedule
#                                            -> src/client/components/demo-banner.tsx (display only)
#
# Verified in review round 2 (PR #771): the first four groups already had
# real consumers AND unit test coverage (push-dispatch.test.ts,
# voip-push.test.ts) despite the review flagging them as possibly dead --
# only DEMO_RESET_CRON was genuinely unwired at the Ansible layer (no var
# existed in vars.example.yml or either .env template) despite already
# having an app-side consumer and test (config.test.ts). This list, checked
# against the "optional vars" scenario render
# (scripts/full-scenario.extra-vars.json), is what proves that's still true
# and stays true.
OPTIONAL_VARS_WITH_CONSUMERS = [
    "APNS_KEY_P8",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "NTFY_URL",
    "NTFY_AUTH_TOKEN",
    "GLITCHTIP_DSN",
    "SIGNAL_NOTIFIER_BEARER_TOKEN",
    "DEMO_RESET_CRON",
]


def extract_required_vars(config_ts: Path) -> tuple[list[str], list[str]]:
    src = config_ts.read_text()
    unconditional = sorted(set(UNCONDITIONAL_RE.findall(src)))
    conditional: list[str] = []
    section_match = SECTION_RE.search(src)
    if section_match:
        conditional = sorted(set(ENV_LOOKUP_RE.findall(section_match.group(1))))
    if not unconditional:
        raise SystemExit(
            f"[check-required-env] Parsed zero required vars out of {config_ts}. "
            "Either config.ts changed shape (update UNCONDITIONAL_RE) or this "
            "script is pointed at the wrong file -- refusing to pass trivially."
        )
    return unconditional, conditional


def rendered_keys(env_file: Path) -> set[str]:
    keys: set[str] = set()
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            keys.add(line.split("=", 1)[0])
    return keys


def render_env_files(repo_root: Path, dest_dir: Path) -> None:
    """Render the four .env outputs into `dest_dir`, unconditionally.

    There is no "already rendered, skip it" fast path and must never be one:
    that short-circuit is exactly what let a stale render from a previous run
    satisfy this gate on a box with a persistent /tmp (see module docstring).
    `dest_dir` is a fresh per-run directory owned by the caller, so the only
    files this function's consumers can read are the ones it just produced.
    """
    ansible_dir = repo_root / "deploy" / "ansible"
    playbook = ansible_dir / "playbooks" / "check-env-templates.yml"
    if shutil.which("ansible-playbook") is None:
        raise SystemExit(
            "[check-required-env] ansible-playbook is not on PATH -- this "
            "script renders the templates itself and cannot fall back to a "
            "previous run's output. Install ansible (pip install ansible)."
        )

    print(f"[check-required-env] Rendering templates into {dest_dir} ...")
    common = ["-e", f"env_check_dest_dir={dest_dir}"]
    commands = [
        [
            "ansible-playbook",
            str(playbook),
            "-e",
            "@vars.example.yml",
            "-e",
            "app_environment=production",
            "-e",
            "webhook_base_url=https://example.org",
            *common,
        ],
        [
            "ansible-playbook",
            str(playbook),
            "-e",
            "@vars.example.yml",
            "-e",
            "@scripts/full-scenario.extra-vars.json",
            *common,
        ],
    ]
    for cmd in commands:
        proc = subprocess.run(cmd, cwd=ansible_dir)
        if proc.returncode != 0:
            raise SystemExit(
                f"[check-required-env] FATAL: render failed ({proc.returncode}): "
                f"{' '.join(cmd)}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="Path to the llamenos-platform repo root (default: computed from script location).",
    )
    args = parser.parse_args()

    # A fresh directory per run, removed on exit. Intentionally NOT
    # configurable: every render destination this script reads must be one it
    # just wrote, or the gate can pass on stale output (see module docstring).
    with tempfile.TemporaryDirectory(prefix="llamenos-check-env-") as tmp:
        return run_checks(args.repo_root, Path(tmp))


def run_checks(repo_root: Path, dest_dir: Path) -> int:
    render_env_files(repo_root, dest_dir)

    monolithic_env = dest_dir / "llamenos-check-env-monolithic.env"
    app_env = dest_dir / "llamenos-check-env-app.env"
    monolithic_env_full = dest_dir / "llamenos-check-env-monolithic-full.env"
    app_env_full = dest_dir / "llamenos-check-env-app-full.env"

    missing_renders = [
        str(p)
        for p in (monolithic_env, app_env, monolithic_env_full, app_env_full)
        if not p.is_file()
    ]
    if missing_renders:
        raise SystemExit(
            "[check-required-env] FATAL: render playbook succeeded but did not "
            f"produce: {', '.join(missing_renders)}"
        )

    config_ts = repo_root / "apps" / "worker" / "lib" / "config.ts"
    if not config_ts.is_file():
        print(f"[check-required-env] FATAL: {config_ts} not found", file=sys.stderr)
        return 2

    unconditional, conditional = extract_required_vars(config_ts)
    print(f"[check-required-env] Parsed from {config_ts}:")
    print(f"  unconditionally required : {', '.join(unconditional)}")
    print(f"  required in production   : {', '.join(conditional) or '(none found)'}")

    # The render this script checks against is run with app_environment=production
    # and every conditional var given a real value (see
    # playbooks/check-env-templates.yml's usage comment) specifically so the
    # conditional vars are expected to appear too -- this proves both templates
    # CAN carry them, not merely that they exist somewhere unreachable.
    required = unconditional + conditional

    targets = {
        "roles/llamenos/templates/env.j2 (monolithic/demo role)": monolithic_env,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role)": app_env,
    }

    failures: list[str] = []
    for label, path in targets.items():
        keys = rendered_keys(path)
        missing = [v for v in required if v not in keys]
        if missing:
            failures.append(f"{label}: missing {', '.join(missing)} (rendered file: {path})")
        else:
            print(f"[check-required-env] OK   {label}: all {len(required)} required vars present")

    # Second pass: optional-but-has-a-real-consumer vars, checked against the
    # "everything enabled" scenario render. See OPTIONAL_VARS_WITH_CONSUMERS
    # above for why this list is hand-maintained instead of parsed.
    print(f"\n[check-required-env] Optional vars with real consumers (not dead plumbing):")
    print(f"  {', '.join(OPTIONAL_VARS_WITH_CONSUMERS)}")

    full_targets = {
        "roles/llamenos/templates/env.j2 (monolithic/demo role, full scenario)": monolithic_env_full,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role, full scenario)": app_env_full,
    }
    for label, path in full_targets.items():
        keys = rendered_keys(path)
        missing = [v for v in OPTIONAL_VARS_WITH_CONSUMERS if v not in keys]
        if missing:
            failures.append(
                f"{label}: missing {', '.join(missing)} even with every optional "
                f"feature enabled -- dead plumbing (rendered file: {path})"
            )
        else:
            print(
                f"[check-required-env] OK   {label}: all "
                f"{len(OPTIONAL_VARS_WITH_CONSUMERS)} optional vars reachable"
            )

    if failures:
        print("\n[check-required-env] FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "\nEvery var apps/worker/lib/config.ts requires at startup must be "
            "templated in deploy/ansible/templates/env/_worker-required-env.j2 "
            "(the single shared source both roles include). See that file's "
            "header comment.",
            file=sys.stderr,
        )
        return 1

    print("\n[check-required-env] PASSED: both templates render every required and reachable-optional var.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

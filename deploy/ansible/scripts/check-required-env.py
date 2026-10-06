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

When the rendered files are absent (the normal case in CI, where main's
workflow invokes this script directly), the script renders them itself by
running playbooks/check-env-templates.yml four times -- the
production/required-vars scenario, the all-optional-features scenario, and the
two /api/test-* dev-route scenarios (staging must emit the vars, production must
not). The renders can also be produced manually beforehand:

    cd deploy/ansible
    ansible-playbook playbooks/check-env-templates.yml \\
        -e @vars.example.yml -e app_environment=production \\
        -e webhook_base_url=https://example.org
    ansible-playbook playbooks/check-env-templates.yml \\
        -e @vars.example.yml -e @scripts/full-scenario.extra-vars.json
    ansible-playbook playbooks/check-env-templates.yml \\
        -e @vars.example.yml -e env_check_suffix=-staging-devroutes \\
        -e app_environment=staging -e dev_routes_enabled=true \\
        -e dev_reset_secret=<>= 32 chars; see DEV_ROUTE_SECRET_FIXTURE>
    ansible-playbook playbooks/check-env-templates.yml \\
        -e @vars.example.yml -e env_check_suffix=-prod-devroutes \\
        -e app_environment=production -e webhook_base_url=https://example.org \\
        -e dev_routes_enabled=true \\
        -e dev_reset_secret=<>= 32 chars; see DEV_ROUTE_SECRET_FIXTURE>
    python3 scripts/check-required-env.py

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
from pathlib import Path

# Unconditionally-required vars are extracted generically from any
# `assertNonEmpty(env, 'X')` / `assertHex64(env, 'X')` call site at the TOP
# LEVEL of a function body in config.ts -- including the one INSIDE
# assertDatabaseUrl(), which itself calls `assertNonEmpty(env, 'DATABASE_URL')`.
# No hardcoded var names here.
#
# The two-space indent anchor matters. An identical call nested inside an
# `if`/`else if` is NOT an unconditional requirement: config.ts asserts
# ADMIN_DECRYPTION_PUBKEY only when ADMIN_PUBKEY is set (#1283). Matching it
# anywhere in the file made this script demand that var in the
# no-admin-configured render, where the template correctly emits nothing --
# a false failure that says the templates are broken when they are right.
UNCONDITIONAL_RE = re.compile(
    r"^ {2}assert(?:NonEmpty|Hex64)\(\s*env\s*,\s*'([A-Z_][A-Z0-9_]*)'\s*\)",
    re.MULTILINE,
)

# The same call nested deeper: required only in some configurations. Every
# such var must appear in PAIRED_REQUIRED_VARS below, or extract_required_vars
# refuses to run -- so a future conditional assert cannot silently escape
# checking the way an unconditional one cannot silently escape it today.
NESTED_ASSERT_RE = re.compile(
    r"^ {4,}assert(?:NonEmpty|Hex64)\(\s*env\s*,\s*'([A-Z_][A-Z0-9_]*)'\s*\)",
    re.MULTILINE,
)

# Conditionally-required vars, mapped to the var that switches the
# requirement on: config.ts refuses to boot when the trigger is present and
# the dependent is not. A render where the trigger is absent proves nothing
# about the pair, so these are checked against the "everything enabled"
# scenario (scripts/full-scenario.extra-vars.json), which sets the trigger --
# and the check fails if that fixture ever stops setting it, rather than
# passing vacuously.
#
#   ADMIN_DECRYPTION_PUBKEY <- ADMIN_PUBKEY: the admin's X25519 HPKE recipient
#     key, a different key from the Ed25519 signing key ADMIN_PUBKEY. Sealing
#     admin envelopes to the Ed25519 key produced ciphertext nobody could open
#     (#1283), so the app now fails closed and the templates must emit both.
PAIRED_REQUIRED_VARS = {
    "ADMIN_DECRYPTION_PUBKEY": "ADMIN_PUBKEY",
}

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


# --- Developer/test-route vars (/api/test-*), issue #723 / #1133 -------------
#
# DEV_ROUTES_ENABLED and DEV_RESET_SECRET open the destructive /api/test-*
# surface. They have to render on a staging target (or the end-to-end suite
# gets 404s and cannot bootstrap a deployed host at all -- the original #723
# blocker) and must NEVER render on a production one (a templated database-reset
# backdoor on a host serving real callers).
#
# Those are opposite outcomes from the SAME inputs, so neither can be proven by
# the existing renders: the required-vars scenario is production with the flags
# off, and the full scenario is demo with the flags off. Two extra renders,
# differing only in app_environment, are what make the conditional in
# templates/env/_worker-required-env.j2 falsifiable in both directions.
DEV_ROUTE_VARS = ["DEV_ROUTES_ENABLED", "DEV_RESET_SECRET"]

# Obvious non-secret fixture, >= MIN_DEPLOYED_SECRET_LENGTH (32) in
# apps/worker/lib/dev-surfaces.ts so the value is one a staging host would
# actually accept rather than one it would reject for being too short.
DEV_ROUTE_SECRET_FIXTURE = "check-required-env-fixture-not-a-real-secret-0000"
MIN_DEPLOYED_SECRET_LENGTH = 32
assert len(DEV_ROUTE_SECRET_FIXTURE) >= MIN_DEPLOYED_SECRET_LENGTH


def check_dev_route_vars(
    staging_targets: dict[str, Path], production_targets: dict[str, Path]
) -> list[str]:
    """Assert /api/test-* vars render on staging and are refused on production.

    Both scenarios are handed dev_routes_enabled=true and a >= 32-char
    dev_reset_secret. The only difference is app_environment, so a template that
    ignores app_environment fails the production half and a template that drops
    the vars altogether fails the staging half.
    """
    failures: list[str] = []

    for label, path in staging_targets.items():
        if not path.is_file():
            continue  # reported as a missing render by the caller
        keys = {k for k, v in rendered_env(path).items() if v}
        missing = [v for v in DEV_ROUTE_VARS if v not in keys]
        if missing:
            failures.append(
                f"{label}: missing {', '.join(missing)} even though this render set "
                "app_environment=staging, dev_routes_enabled=true and a "
                f"{len(DEV_ROUTE_SECRET_FIXTURE)}-char dev_reset_secret. Without these "
                "the deployed worker serves 404 on every /api/test-* route, so the "
                "end-to-end suite cannot reset or seed a staging target and cannot "
                f"run against a deployed host at all (issue #723). Rendered file: {path}"
            )
        else:
            print(
                f"[check-required-env] OK   {label}: "
                f"{', '.join(DEV_ROUTE_VARS)} reach a staging render"
            )

    for label, path in production_targets.items():
        if not path.is_file():
            continue
        keys = set(rendered_env(path))
        present = [v for v in DEV_ROUTE_VARS if v in keys]
        if present:
            failures.append(
                f"{label}: {', '.join(present)} was templated even though this render "
                "set app_environment=production. That writes a destructive "
                "database-reset backdoor (/api/test-*) into the .env of a host serving "
                "real callers and volunteers. templates/env/_worker-required-env.j2 "
                "must omit these vars when app_environment is 'production' -- see the "
                "three-layer comment above them (preflight guard, this render-time "
                f"guard, config.ts startup guard). Rendered file: {path}"
            )
        else:
            print(
                f"[check-required-env] OK   {label}: "
                f"{', '.join(DEV_ROUTE_VARS)} correctly absent from a production render"
            )

    return failures


# --- Deployed-database reachability (the other half of #723's blocker) ------
#
# The end-to-end suite asserts persisted state straight from PostgreSQL
# (tests/db-helpers.ts). A deployed target publishes no database port, so with
# the /api/test-* routes alone the suite would still have been reading the
# CONTROL NODE's database while the server wrote to the deployment's -- a green
# run that proved nothing. The compose templates publish the port on 127.0.0.1
# ONLY, and only on an E2E target; the operator forwards it over SSH.
#
# Same falsifiability requirement as the env vars above: the port must appear on
# a staging render and must NOT appear on a production one, from identical
# inputs. "127.0.0.1:" is what makes it loopback-only -- a bare "5432:5432"
# would expose the database to the whole internet, so the check demands the
# literal loopback address rather than merely the presence of a port.
PG_LOOPBACK_RE = re.compile(r'^\s*-\s*"127\.0\.0\.1:\d+:5432"\s*$', re.MULTILINE)
PG_ANY_PORT_RE = re.compile(r'^\s*-\s*"?[^"\n]*:5432"?\s*$', re.MULTILINE)


def _postgres_block(text: str) -> str:
    """The `postgres:` service block of a rendered compose file."""
    start = text.find("\n  postgres:\n")
    if start < 0:
        return ""
    body = text[start + 1 :]
    for i, line in enumerate(body.splitlines()):
        if i and line and not line.startswith("    ") and not line.startswith("#"):
            return "\n".join(body.splitlines()[:i])
    return body


# Networks that are internal-only but whose definition is NOT in the file being
# checked: the per-service roles declare `llamenos-internal` as `external: true`
# and it is created elsewhere. Without this, that name reads as "routable" and
# the staging check passes on a render that cannot actually publish anything.
KNOWN_INTERNAL_NETWORKS = {"internal", "llamenos-internal"}


def _internal_networks(text: str) -> set[str]:
    """Top-level networks declared `internal: true`.

    A container attached ONLY to such a network cannot publish a host port --
    see check_pg_port_publication.
    """
    start = text.find("\nnetworks:\n")
    if start < 0:
        return set()
    internal: set[str] = set(KNOWN_INTERNAL_NETWORKS)
    current: str | None = None
    for line in text[start + 1 :].splitlines()[1:]:
        if line and not line.startswith(" "):
            break
        stripped = line.strip()
        if line.startswith("  ") and not line.startswith("    ") and stripped.endswith(":"):
            current = stripped[:-1]
        elif current and stripped.replace(" ", "") == "internal:true":
            internal.add(current)
    return internal


def _attached_networks(pg_block: str) -> list[str]:
    out: list[str] = []
    lines = pg_block.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "networks:":
            for item in lines[i + 1 :]:
                if item.strip().startswith("- "):
                    out.append(item.strip()[2:].strip())
                elif item.strip().endswith(":"):
                    break
            break
    return out


def check_pg_port_publication(
    staging_targets: dict[str, Path], production_targets: dict[str, Path]
) -> list[str]:
    """Assert the database port is published on loopback for an E2E target only.

    Two separate claims per staging render, because the first one alone was not
    enough and that was found the hard way on a real deploy:

      1. the `ports:` entry exists, bound to 127.0.0.1 (a bare "5432:5432"
         would put the database on the whole internet);
      2. the postgres service is attached to at least one network that is NOT
         `internal: true`. Docker ACCEPTS a ports entry on an internal-only
         container, records the binding, installs no DNAT rule, and nothing
         listens -- a silent no-op that looks configured in `docker inspect`.
         Checking only (1) would have passed on exactly that broken deploy.
    """
    failures: list[str] = []

    for label, path in staging_targets.items():
        if not path.is_file():
            continue
        text = path.read_text()
        if not PG_LOOPBACK_RE.search(text):
            failures.append(
                f"{label}: no 127.0.0.1:<port>:5432 publication even though this render "
                "set app_environment=staging and dev_routes_enabled=true. Without it "
                "nothing outside the deployed host can reach its database, so the "
                "end-to-end suite's direct-database assertions would silently read the "
                "control node's own database instead (the false-green this exists to "
                f"prevent). Rendered file: {path}"
            )
            continue

        attached = _attached_networks(_postgres_block(text))
        internal = _internal_networks(text)
        routable = [n for n in attached if n not in internal]
        if not routable:
            failures.append(
                f"{label}: postgres publishes 127.0.0.1:<port>:5432 but is attached only "
                f"to internal-only network(s) {', '.join(attached) or '(none)'}. Docker "
                "accepts that ports entry, records the binding in the container, "
                "installs NO DNAT rule and nothing ever listens -- so the publication "
                "is a silent no-op that looks correct in `docker inspect`. Attach "
                "postgres to an additional non-internal bridge in the same conditional "
                f"as the ports entry. Rendered file: {path}"
            )
        else:
            print(
                f"[check-required-env] OK   {label}: database published on loopback "
                f"and reachable through non-internal network(s) {', '.join(routable)}"
            )

    for label, path in production_targets.items():
        if not path.is_file():
            continue
        text = path.read_text()
        exposed = PG_ANY_PORT_RE.findall(text)
        if exposed:
            failures.append(
                f"{label}: the database port is published ({', '.join(e.strip() for e in exposed)}) "
                "even though this render set app_environment=production. A production "
                "host must publish no database port at all -- the only reachable "
                "surface is the app behind Caddy. Rendered file: " + str(path)
            )
            continue
        attached = _attached_networks(_postgres_block(text))
        internal = _internal_networks(text)
        routable = [n for n in attached if n not in internal]
        if routable:
            failures.append(
                f"{label}: postgres is attached to non-internal network(s) "
                f"{', '.join(routable)} on a production render. The database must sit "
                "only on the internal network there -- the extra bridge exists solely "
                f"to make the E2E loopback publish work. Rendered file: {path}"
            )
        else:
            print(
                f"[check-required-env] OK   {label}: database publishes no port and "
                "stays on the internal network on a production render"
            )

    return failures


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

    # A var config.ts asserts inside a conditional branch is still a hard
    # startup requirement in the configurations that reach it. Demanding it
    # unconditionally is wrong, and dropping it is worse -- so require that
    # each one is declared in PAIRED_REQUIRED_VARS and checked there.
    unknown_nested = sorted(set(NESTED_ASSERT_RE.findall(src)) - set(PAIRED_REQUIRED_VARS))
    if unknown_nested:
        raise SystemExit(
            "[check-required-env] config.ts asserts "
            f"{', '.join(unknown_nested)} inside a conditional branch, but "
            "PAIRED_REQUIRED_VARS does not say what turns that requirement on. "
            "Add an entry mapping each var to its trigger var (and make the "
            "full-scenario fixture set the trigger) so the render is actually "
            "checked -- refusing to skip it silently."
        )

    return unconditional, conditional


def check_paired_vars(targets: dict[str, Path]) -> list[str]:
    """Assert every PAIRED_REQUIRED_VARS pair renders together, not vacuously.

    config.ts fails closed when a trigger var is set without its dependent, so
    a template that emits one and not the other produces a container that
    refuses to boot. Checked against the full-scenario render because only
    that one sets the triggers; if it stops setting one, that is reported as a
    failure rather than quietly passing on a branch nothing entered.
    """
    failures: list[str] = []
    for label, path in targets.items():
        if not path.is_file():
            continue  # already reported as a missing render by the caller
        # Present-but-empty is not present for these two: config.ts treats an
        # empty ADMIN_DECRYPTION_PUBKEY exactly like a missing one and refuses
        # to start, so a template that emits a bare `KEY=` has not satisfied
        # the requirement -- it has only hidden the failure until boot.
        keys = {k for k, v in rendered_env(path).items() if v}
        for dependent, trigger in sorted(PAIRED_REQUIRED_VARS.items()):
            if trigger not in keys:
                failures.append(
                    f"{label}: {trigger} is absent from this render, so the "
                    f"{trigger} -> {dependent} requirement was never exercised. "
                    "Set it in scripts/full-scenario.extra-vars.json -- a check "
                    f"that cannot fail is not a check (rendered file: {path})"
                )
            elif dependent not in keys:
                failures.append(
                    f"{label}: {trigger} is rendered but {dependent} is missing or empty. "
                    "apps/worker/lib/config.ts refuses to start in that state, "
                    f"so this deploy path cannot boot (rendered file: {path})"
                )
    return failures


def rendered_env(env_file: Path) -> dict[str, str]:
    """Parse a rendered .env into {key: value}."""
    env: dict[str, str] = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"')
    return env


def rendered_keys(env_file: Path) -> set[str]:
    return set(rendered_env(env_file))


def ensure_rendered(repo_root: Path, rendered: list[Path]) -> None:
    """Render every verification output (.env and compose) if absent.

    Main's ci.yml invokes this script directly (no separate render step), so
    the script must be able to produce its own inputs. If the files already
    exist (a dev ran playbooks/check-env-templates.yml manually), they are
    used as-is.
    """
    if all(p.is_file() for p in rendered):
        return

    ansible_dir = repo_root / "deploy" / "ansible"
    playbook = ansible_dir / "playbooks" / "check-env-templates.yml"
    if shutil.which("ansible-playbook") is None:
        raise SystemExit(
            "[check-required-env] Rendered files missing and ansible-playbook "
            "is not on PATH -- install ansible (pip install ansible) or run "
            "playbooks/check-env-templates.yml yourself first (see docstring)."
        )

    print("[check-required-env] Rendered files missing -- rendering via ansible-playbook ...")
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
        ],
        [
            "ansible-playbook",
            str(playbook),
            "-e",
            "@vars.example.yml",
            "-e",
            "@scripts/full-scenario.extra-vars.json",
        ],
        # /api/test-* scenarios (#723): same dev-route inputs, opposite
        # app_environment, so the render-time guard is falsifiable both ways.
        [
            "ansible-playbook",
            str(playbook),
            "-e",
            "@vars.example.yml",
            "-e",
            "env_check_suffix=-staging-devroutes",
            "-e",
            "app_environment=staging",
            "-e",
            "dev_routes_enabled=true",
            "-e",
            f"dev_reset_secret={DEV_ROUTE_SECRET_FIXTURE}",
        ],
        [
            "ansible-playbook",
            str(playbook),
            "-e",
            "@vars.example.yml",
            "-e",
            "env_check_suffix=-prod-devroutes",
            "-e",
            "app_environment=production",
            # config.ts requires WEBHOOK_BASE_URL in production -- same value the
            # required-vars render above uses.
            "-e",
            "webhook_base_url=https://example.org",
            "-e",
            "dev_routes_enabled=true",
            "-e",
            f"dev_reset_secret={DEV_ROUTE_SECRET_FIXTURE}",
        ],
    ]
    for cmd in commands:
        proc = subprocess.run(cmd, cwd=ansible_dir)
        if proc.returncode != 0:
            raise SystemExit(
                f"[check-required-env] FATAL: render failed ({proc.returncode}): "
                f"{' '.join(cmd)}"
            )

    missing = [str(p) for p in rendered if not p.is_file()]
    if missing:
        raise SystemExit(
            "[check-required-env] FATAL: render playbook succeeded but did not "
            f"produce: {', '.join(missing)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="Path to the llamenos-platform repo root (default: computed from script location).",
    )
    parser.add_argument(
        "--monolithic-env",
        type=Path,
        default=Path("/tmp/llamenos-check-env-monolithic.env"),
        help="Rendered output of roles/llamenos/templates/env.j2 "
        "(produced by playbooks/check-env-templates.yml).",
    )
    parser.add_argument(
        "--app-env",
        type=Path,
        default=Path("/tmp/llamenos-check-env-app.env"),
        help="Rendered output of roles/llamenos-app/templates/env/app.j2 "
        "(produced by playbooks/check-env-templates.yml).",
    )
    parser.add_argument(
        "--monolithic-env-full",
        type=Path,
        default=Path("/tmp/llamenos-check-env-monolithic-full.env"),
        help="Rendered output of roles/llamenos/templates/env.j2 with every "
        "optional feature enabled (produced by playbooks/check-env-templates.yml "
        "-e @scripts/full-scenario.extra-vars.json).",
    )
    parser.add_argument(
        "--app-env-full",
        type=Path,
        default=Path("/tmp/llamenos-check-env-app-full.env"),
        help="Rendered output of roles/llamenos-app/templates/env/app.j2 with "
        "every optional feature enabled.",
    )
    parser.add_argument(
        "--monolithic-env-staging-devroutes",
        type=Path,
        default=Path("/tmp/llamenos-check-env-monolithic-staging-devroutes.env"),
        help="Rendered output of roles/llamenos/templates/env.j2 at "
        "app_environment=staging with dev_routes_enabled=true and a >= 32-char "
        "dev_reset_secret (the /api/test-* scenario the E2E suite needs, #723).",
    )
    parser.add_argument(
        "--app-env-staging-devroutes",
        type=Path,
        default=Path("/tmp/llamenos-check-env-app-staging-devroutes.env"),
        help="Rendered output of roles/llamenos-app/templates/env/app.j2 in the "
        "same staging dev-routes scenario.",
    )
    parser.add_argument(
        "--monolithic-env-prod-devroutes",
        type=Path,
        default=Path("/tmp/llamenos-check-env-monolithic-prod-devroutes.env"),
        help="Rendered output of roles/llamenos/templates/env.j2 with the SAME "
        "dev-route inputs but app_environment=production -- must carry neither var.",
    )
    parser.add_argument(
        "--app-env-prod-devroutes",
        type=Path,
        default=Path("/tmp/llamenos-check-env-app-prod-devroutes.env"),
        help="Rendered output of roles/llamenos-app/templates/env/app.j2 in the "
        "same production dev-routes scenario.",
    )
    parser.add_argument(
        "--compose-postgres-staging",
        type=Path,
        default=Path("/tmp/llamenos-check-compose-postgres-staging-devroutes.yml"),
        help="Rendered roles/llamenos-postgres/templates/compose/postgres.j2 for the "
        "staging + dev-routes scenario.",
    )
    parser.add_argument(
        "--compose-postgres-prod",
        type=Path,
        default=Path("/tmp/llamenos-check-compose-postgres-prod-devroutes.yml"),
        help="Rendered roles/llamenos-postgres/templates/compose/postgres.j2 for the "
        "production + dev-routes scenario.",
    )
    parser.add_argument(
        "--compose-monolithic-staging",
        type=Path,
        default=Path("/tmp/llamenos-check-compose-monolithic-staging-devroutes.yml"),
        help="Rendered roles/llamenos/templates/docker-compose.j2 for the staging + "
        "dev-routes scenario.",
    )
    parser.add_argument(
        "--compose-monolithic-prod",
        type=Path,
        default=Path("/tmp/llamenos-check-compose-monolithic-prod-devroutes.yml"),
        help="Rendered roles/llamenos/templates/docker-compose.j2 for the production + "
        "dev-routes scenario.",
    )
    args = parser.parse_args()

    rendered = [
        args.monolithic_env,
        args.app_env,
        args.monolithic_env_full,
        args.app_env_full,
        args.monolithic_env_staging_devroutes,
        args.app_env_staging_devroutes,
        args.monolithic_env_prod_devroutes,
        args.app_env_prod_devroutes,
        args.compose_postgres_staging,
        args.compose_postgres_prod,
        args.compose_monolithic_staging,
        args.compose_monolithic_prod,
    ]
    ensure_rendered(args.repo_root, rendered)

    config_ts = args.repo_root / "apps" / "worker" / "lib" / "config.ts"
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
        "roles/llamenos/templates/env.j2 (monolithic/demo role)": args.monolithic_env,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role)": args.app_env,
    }

    failures: list[str] = []
    for label, path in targets.items():
        if not path.is_file():
            failures.append(
                f"{label}: rendered file {path} does not exist -- run "
                "playbooks/check-env-templates.yml first"
            )
            continue
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
        "roles/llamenos/templates/env.j2 (monolithic/demo role, full scenario)": args.monolithic_env_full,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role, full scenario)": args.app_env_full,
    }
    for label, path in full_targets.items():
        if not path.is_file():
            failures.append(
                f"{label}: rendered file {path} does not exist -- run "
                "playbooks/check-env-templates.yml -e @vars.example.yml "
                "-e @scripts/full-scenario.extra-vars.json first"
            )
            continue
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

    print(
        "\n[check-required-env] Conditionally-required pairs "
        "(trigger -> dependent), checked against the full scenario:"
    )
    for dependent, trigger in sorted(PAIRED_REQUIRED_VARS.items()):
        print(f"  {trigger} -> {dependent}")
    paired_failures = check_paired_vars(full_targets)
    failures.extend(paired_failures)
    if not paired_failures:
        print(
            f"[check-required-env] OK   both full-scenario renders carry all "
            f"{len(PAIRED_REQUIRED_VARS)} conditionally-required pair(s)"
        )

    # Third pass: the /api/test-* dev-route vars, which must render on staging
    # and must NOT render on production from identical inputs. See
    # check_dev_route_vars / DEV_ROUTE_VARS above.
    print(
        "\n[check-required-env] Developer/test-route vars "
        f"({', '.join(DEV_ROUTE_VARS)}), checked in two opposed scenarios:"
    )
    print("  app_environment=staging    + dev_routes_enabled=true -> MUST be present")
    print("  app_environment=production + dev_routes_enabled=true -> MUST be absent")

    staging_devroute_targets = {
        "roles/llamenos/templates/env.j2 (monolithic/demo role, staging + dev routes)":
            args.monolithic_env_staging_devroutes,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role, staging + dev routes)":
            args.app_env_staging_devroutes,
    }
    production_devroute_targets = {
        "roles/llamenos/templates/env.j2 (monolithic/demo role, production + dev routes)":
            args.monolithic_env_prod_devroutes,
        "roles/llamenos-app/templates/env/app.j2 (per-service app role, production + dev routes)":
            args.app_env_prod_devroutes,
    }
    for label, path in {**staging_devroute_targets, **production_devroute_targets}.items():
        if not path.is_file():
            failures.append(
                f"{label}: rendered file {path} does not exist -- run "
                "playbooks/check-env-templates.yml with the matching "
                "env_check_suffix first (see this script's docstring)"
            )
    failures.extend(
        check_dev_route_vars(staging_devroute_targets, production_devroute_targets)
    )

    # The database side of the same question: can the end-to-end suite reach the
    # DEPLOYED PostgreSQL, and is that reachability confined to an E2E target?
    print(
        "\n[check-required-env] Deployed-database reachability "
        "(loopback-only, E2E targets only):"
    )
    failures.extend(
        check_pg_port_publication(
            {
                "roles/llamenos-postgres/templates/compose/postgres.j2 (per-service, staging + dev routes)":
                    args.compose_postgres_staging,
                "roles/llamenos/templates/docker-compose.j2 (monolithic, staging + dev routes)":
                    args.compose_monolithic_staging,
            },
            {
                "roles/llamenos-postgres/templates/compose/postgres.j2 (per-service, production + dev routes)":
                    args.compose_postgres_prod,
                "roles/llamenos/templates/docker-compose.j2 (monolithic, production + dev routes)":
                    args.compose_monolithic_prod,
            },
        )
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

    print(
        "\n[check-required-env] PASSED: both templates render every required and "
        "reachable-optional var, and gate the /api/test-* vars on app_environment."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Assert every environment variable the worker READS is rendered by at least
one Ansible .env template -- or is listed below as deliberately unrendered,
with a reason.

Why this exists (issue #1624). deploy/ansible/scripts/check-required-env.py
covers the vars apps/worker/lib/config.ts *asserts* at startup: miss one and
the container refuses to boot, so the failure is loud. The expensive case is
the other one -- a var the worker reads, treats as optional, and silently
takes a fallback branch for when it is absent. Nothing at deploy time reported
that a consumed variable was never rendered, and four separate controls were
inert on every deployed host as a result:

  CORS_ALLOWED_ORIGINS  the deployed host had NO configured CORS policy and
                        fell through to two hardcoded origins belonging to
                        the project's own domains (#1624)
  SIP_BRIDGE_URL        /health/ready's sip-bridge probe returned null --
                        "not configured" scored as healthy (#1624)
  METRICS_SCRAPE_TOKEN  prometheus.yml.j2 scrapes app:3000/api/metrics with
                        no Authorization header, so every scrape got a 401
                        (found by this script on its first run)
  *_WEBHOOK_IPS         the webhook IP allowlist middleware returned next()
                        unconditionally (#1622)

Each one is the same shape: absent config renders as success. This script is
the check that catches the next one.

WHAT IS CHECKED

Consumed set, derived from two places under apps/worker/ (never hand-listed,
so a new var defaults to failing rather than to passing):

  1. the string-typed fields of `export interface Env` in types/infra.ts --
     the declared surface every `c.env.X` read goes through;
  2. every `process.env.X` / `process.env['X']` read outside __tests__/.

Rendered set, derived from the SOURCE TEXT of the Ansible .env templates --
every `NAME=` assignment, whether or not a given scenario's render reaches it.
Source text, not a render, because the filed bug is "rendered NOWHERE": a var
present in the template behind a condition is plumbing that exists, and
whether an optional branch is reachable is check-required-env.py's job (it
asserts its lists appear in an actual render). The two checks stay disjoint.

WHAT MAKES IT A CHECK AND NOT A REPORT

  - a consumed var that is neither rendered nor exempt FAILS (exit 1);
  - an exemption for a var nothing consumes any more FAILS, so the list
    cannot rot into a blanket pass;
  - parsing zero vars from either side FAILS rather than passing trivially.

Usage:
    python3 scripts/check-consumed-env.py
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Deliberately unrendered, each with the reason. Anything not here and not
# rendered is a failure.
#
# These are reasons, not notes: "it is optional" is never one of them. A var
# earns a place here only if absent is the CORRECT deployed state and the
# fallback the worker takes is a real behaviour, not a skipped control.
# ---------------------------------------------------------------------------
UNRENDERED_BY_DESIGN: dict[str, str] = {
    # ── Dev/test-only surfaces. Rendering any of these on a deployed host is
    # the bug, not the fix: apps/worker/lib/dev-surfaces.ts gates the routes
    # they unlock and an Ansible deploy is ENVIRONMENT=production.
    "DEV_AUTH_BYPASS": "skips Ed25519 signature verification; must never reach a deployed host",
    "E2E_TEST_SECRET": "authenticates the E2E harness's own reset endpoints; local/CI only",

    # ── Deprecated aliases. The canonical name is what the templates render;
    # emitting both would let the two drift and the deprecated one win.
    "NOTIFIER_URL": "deprecated alias for SIGNAL_NOTIFIER_URL",
    "NOTIFIER_API_KEY": "deprecated alias for SIGNAL_NOTIFIER_BEARER_TOKEN",

    # ── Absent means a correct in-code default, not a skipped control.
    "NOTIFIER_TOKEN_SECRET": "falls back to HMAC_SECRET (rendered), which is the intended key",
    "CERT_PIN_HASHES": (
        "an OVERRIDE of the Let's Encrypt ISRG Root X1/X2 defaults. The Caddy role pins "
        "acme_ca to Let's Encrypt with no fallback issuer, so the default is already the "
        "correct chain for every deployed host; rendering an override could only diverge "
        "from the cert Caddy actually serves"
    ),
    "APNS_BUNDLE_ID": (
        "an OVERRIDE of org.llamenos.hotline (lib/apns-topic.ts), which is "
        "PRODUCT_BUNDLE_IDENTIFIER in apps/ios/project.yml -- only a fork shipping under "
        "another bundle id needs it"
    ),

    # ── The sidecar itself has no Ansible role, so there is no URL to render.
    # Rendering one would point the health probe at nothing, which is worse
    # than the probe being skipped: it would report `failing` on every host.
    "SIGNAL_NOTIFIER_URL": (
        "roles/llamenos-signal deploys signal-cli only -- the signal-notifier/ sidecar "
        "(port 3100) has no Ansible role on any deploy path, so there is no address to "
        "render. SIGNAL_NOTIFIER_BEARER_TOKEN is rendered for it and reaches nothing"
    ),
    "SIP_TLS_CA_FILE": (
        "the SIP edge's public TLS trust anchor, as a path INSIDE the app container. "
        "roles/kamailio writes the anchor to the host at "
        "{{ kamailio_tls_dir }}/sip-edge-anchor.pem, but neither app compose template "
        "bind-mounts it, so a rendered path would name a file the container cannot open "
        "and readSipTlsTrustAnchor would fail where it currently falls back to the "
        "device trust store. Closing it is a volume mount in both app compose "
        "templates, on the SIP-edge work, not here"
    ),
    "SIP_TLS_CA_PEM": (
        "the same anchor inline, and it TAKES PRECEDENCE over SIP_TLS_CA_FILE -- "
        "rendering both would make the file variant dead config. The Ansible SIP edge "
        "produces a file on the remote host, not a value the controller can inline"
    ),
    "FIREHOSE_AGENT_SEAL_KEY": (
        "the firehose inference agent runs only under docker-compose.dev.yml's "
        "`--profile inference`; no Ansible role deploys it, so sealing agent identities "
        "is not a deployed code path"
    ),

    # ── Operator tuning knobs read straight from process.env, each with a
    # working in-code default. Absent is the ordinary case, and the default is
    # the behaviour the deployment wants.
    "LOG_NAMESPACES": "logger namespace filter; default is all namespaces",
    "LOG_RATE_LIMITS": "logger per-message rate limits; default is the built-in table",
    "LOG_STACKS": "stack traces on warn-level logs; default off",
    "MIN_LOG_LEVEL": "log level floor; default info",
    "NODE_ENV": "set by the Bun runtime, not by deployment config",
    "PG_IDLE_TIMEOUT": "Postgres pool idle timeout; default is the pool's own",
    "STORAGE_SSE_ENABLED": "RustFS server-side encryption toggle; disk-level FDE covers it",
    "TOKEN_MAX_AGE_MS": "session token lifetime; default is the hardened value in lib/auth.ts",
}

# `interface Env` also declares the objects the server bootstrap INJECTS --
# the Whisper client, the RustFS clients, the WebSocket connection manager.
# They are not environment variables and have no .env line to render. Listed
# by name rather than inferred from their types because a type-shape heuristic
# would silently start exempting real string vars the day someone brands one.
NON_ENV_BINDINGS = {
    "AI",
    "BLOB_STORAGE",
    "STORAGE_MANAGER",
    "STORAGE_ADMIN",
    "WS_MANAGER",
}

# `<PROVIDER>_WEBHOOK_IPS` is built at runtime from the provider name
# (middleware/webhook-auth.ts, middleware/webhook-ip-allowlist.ts,
# messaging/router.ts), so no static scan can name the instances. The template
# renders them from the `webhook_ip_allowlists` operator map; this is the
# suffix that proves the plumbing is present at all, checked explicitly below.
WEBHOOK_IPS_SUFFIX = "_WEBHOOK_IPS"

ENV_INTERFACE_RE = re.compile(
    r"^export interface Env \{(.*?)^\}", re.DOTALL | re.MULTILINE
)
# A field line in that interface: `NAME: type` or `NAME?: type`. Anchored at
# two-space indent so a nested object literal's fields are not mistaken for
# top-level env vars.
ENV_FIELD_RE = re.compile(r"^ {2}([A-Z][A-Z0-9_]*)\??:", re.MULTILINE)

PROCESS_ENV_RE = re.compile(
    r"process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['\"]([A-Z][A-Z0-9_]*)['\"]\s*\])"
)

# `NAME=` at the start of a rendered line in a Jinja .env template. Jinja
# control lines ({% if %}) and comments never match.
TEMPLATE_ASSIGN_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=", re.MULTILINE)


def consumed_from_env_interface(infra_ts: Path) -> set[str]:
    src = infra_ts.read_text()
    match = ENV_INTERFACE_RE.search(src)
    if not match:
        raise SystemExit(
            f"[check-consumed-env] Could not find `export interface Env {{` in {infra_ts}. "
            "Either it moved (update ENV_INTERFACE_RE) or this script is pointed at the "
            "wrong file -- refusing to pass on an empty consumed set."
        )
    fields = set(ENV_FIELD_RE.findall(match.group(1)))
    unknown_bindings = NON_ENV_BINDINGS - fields
    if unknown_bindings:
        raise SystemExit(
            "[check-consumed-env] NON_ENV_BINDINGS names "
            f"{', '.join(sorted(unknown_bindings))}, which `interface Env` no longer "
            "declares. Drop the stale name(s) -- an exemption for a field that does not "
            "exist hides the next one that does."
        )
    return fields - NON_ENV_BINDINGS


def consumed_from_process_env(worker_dir: Path) -> set[str]:
    found: set[str] = set()
    for ts in worker_dir.rglob("*.ts"):
        rel = ts.relative_to(worker_dir)
        if "__tests__" in rel.parts:
            continue
        for direct, bracket in PROCESS_ENV_RE.findall(ts.read_text()):
            found.add(direct or bracket)
    # Not deployment config: the process's own filesystem/loader environment.
    return found - {"HOME", "PATH", "LLAMENOS_CRYPTO_LIB"}


def rendered_from_templates(templates: list[Path]) -> tuple[set[str], str]:
    """Return (vars assigned a literal name, the concatenated template source).

    The source comes back too because one family of vars cannot be matched by
    name: `<PROVIDER>_WEBHOOK_IPS` is emitted by a Jinja for-loop whose
    left-hand side is an expression (`{{ provider | upper }}_WEBHOOK_IPS=`),
    so no `^NAME=` scan can see it. The caller checks that family against the
    raw text instead of leaving it invisible.
    """
    rendered: set[str] = set()
    sources: list[str] = []
    for t in templates:
        if not t.is_file():
            raise SystemExit(f"[check-consumed-env] Template not found: {t}")
        src = t.read_text()
        sources.append(src)
        rendered |= set(TEMPLATE_ASSIGN_RE.findall(src))
    return rendered, "\n".join(sources)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Path to the llamenos-platform repo root.",
    )
    args = parser.parse_args()
    root: Path = args.repo_root

    worker_dir = root / "apps" / "worker"
    infra_ts = worker_dir / "types" / "infra.ts"
    templates = [
        root / "deploy" / "ansible" / "templates" / "env" / "_worker-required-env.j2",
        root / "deploy" / "ansible" / "roles" / "llamenos-app" / "templates" / "env" / "app.j2",
        root / "deploy" / "ansible" / "roles" / "llamenos" / "templates" / "env.j2",
    ]

    consumed = consumed_from_env_interface(infra_ts) | consumed_from_process_env(worker_dir)
    rendered, template_source = rendered_from_templates(templates)

    if not consumed:
        raise SystemExit("[check-consumed-env] Parsed zero consumed vars -- refusing to pass.")
    if not rendered:
        raise SystemExit("[check-consumed-env] Parsed zero rendered vars -- refusing to pass.")

    print(f"[check-consumed-env] {len(consumed)} vars consumed by apps/worker/")
    print(f"[check-consumed-env] {len(rendered)} vars rendered by the Ansible .env templates")

    failures: list[str] = []

    missing = sorted(consumed - rendered - set(UNRENDERED_BY_DESIGN))
    for var in missing:
        failures.append(
            f"{var} is read by apps/worker/ but assigned in none of the Ansible .env "
            "templates. Either render it in "
            "deploy/ansible/templates/env/_worker-required-env.j2 (the single shared "
            "source both roles include), or add it to UNRENDERED_BY_DESIGN in this "
            "script WITH the reason absent is the correct deployed state."
        )

    # The dynamic-name family. No static scan can enumerate the instances, so
    # assert the plumbing exists at all -- without this line the family is
    # invisible to the check and #1622 recurs silently.
    if f"{WEBHOOK_IPS_SUFFIX}=" not in template_source:
        failures.append(
            f"No *{WEBHOOK_IPS_SUFFIX} assignment in any .env template, but "
            "middleware/webhook-auth.ts, middleware/webhook-ip-allowlist.ts and "
            "messaging/router.ts all read `${PROVIDER}" + WEBHOOK_IPS_SUFFIX + "` and "
            "skip the allowlist entirely when it is absent (#1622)."
        )

    stale = sorted(set(UNRENDERED_BY_DESIGN) - consumed)
    for var in stale:
        failures.append(
            f"{var} is exempted in UNRENDERED_BY_DESIGN but apps/worker/ no longer reads "
            "it. Remove the entry -- a list of exemptions for vars nothing consumes grows "
            "into a blanket pass."
        )

    overlap = sorted(set(UNRENDERED_BY_DESIGN) & rendered)
    for var in overlap:
        failures.append(
            f"{var} is exempted in UNRENDERED_BY_DESIGN but IS rendered. One of the two is "
            "wrong: drop the exemption, or stop rendering it."
        )

    if failures:
        print("\n[check-consumed-env] FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    exempt = sorted(UNRENDERED_BY_DESIGN)
    print(
        f"[check-consumed-env] {len(consumed) - len(exempt)} consumed vars rendered; "
        f"{len(exempt)} deliberately unrendered:"
    )
    for var in exempt:
        print(f"    {var}: {UNRENDERED_BY_DESIGN[var]}")
    print("\n[check-consumed-env] PASSED: every var apps/worker/ reads is rendered or justified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

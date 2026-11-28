#!/usr/bin/env bash
# Classifies a list of changed files into the platform/scope flags CI uses to
# decide which jobs a PR's changes actually need.
#
# This is the SINGLE source of truth for the platform path map. Before this
# script existed, the same map was maintained independently in three places
# that had already drifted from each other: ci.yml's `changes` job (an
# `android` regex only), the since-removed desktop-e2e.yml's
# `on.pull_request.paths:` list, and
# ios-e2e.yml's own `ios_related` regex. Extending or fixing platform scope
# happens HERE, once — every workflow that needs it calls this script instead
# of re-deriving its own copy (see #664).
#
# Usage: printf '%s\n' "$CHANGED_FILES" | detect-changed-platforms.sh
# Reads the changed-file list (one path per line) from stdin. Emits one
# `key=value` line per flag on stdout — safe to redirect straight into
# $GITHUB_OUTPUT, or to capture and parse in a test.
set -euo pipefail

CHANGED_FILES=$(cat)

# Any file under one of these paths is reachable from every platform's build
# — a change here must run every platform's tests, not just whichever tree
# it happens to live in. Deliberately narrower than "everything that isn't
# docs": apps/worker/** (backend) is NOT here — it is its own `backend`
# platform below — so a pure backend change no longer drags in Android/iOS
# builds the way the old per-workflow regexes did (that coupling was part of
# the over-triggering #664 exists to fix).
#
# .github/scripts/detect-changed-platforms.sh (this file) is included here
# too: it is the single thing that decides every other flag below, so a
# change to it gets the same "run everything" treatment as ci.yml itself —
# anything narrower risks a broken rewrite of this script shipping with its
# own blast radius silently gated to `false`.
SHARED_DEPS_RE='^(packages/crypto/|packages/protocol/|packages/shared/|packages/i18n/|package\.json$|bun\.lock|\.mise\.toml$|tsconfig[^/]*\.json$|vitest[^/]*\.(config|setup)\.ts$|scripts/|\.github/workflows/ci\.yml$|\.github/scripts/detect-changed-platforms\.sh$)'
# Carved out of SHARED_DEPS_RE's `vitest*` catch-all: the vitest files whose
# ONLY reader is `vitest run --config <that config>` (plus the config's own
# `setupFiles`). Nothing else loads them — not tsc (tsconfig.json's `include`
# names no root vitest file), not Playwright, not Gradle/Xcode/cargo, not
# codegen — so no iOS, Android, crypto or other-platform job can observe a
# change to one. Each maps to its own consumer's flag instead of the matrix:
#   vitest.unit.*          -> backend       (backend-unit)
#   vitest.integration.*   -> backend       (backend-integration, which runs it
#                                           against a real postgres service; #1167)
#   vitest.desktop.*       -> desktop       (desktop-unit)
#   vitest.orchestrator.*  -> orchestrator  (backend-unit's fleet-tests step)
# Before this, the two fleet PRs that touched only vitest.orchestrator.config.ts
# ran the iOS and Android suites. The `.setup.ts` files were in NO regex at all,
# so a setup-only change used to skip the one job that loads it.
#
# A vitest file NOT named here still falls through to SHARED_DEPS_RE and runs
# everything — a named list, never a prefix, so a new suite fails toward
# running. guards.test.ts binds this to ci.yml: every `--config vitest.*` a job
# passes, and each of that config's setupFiles, must run that job alone.
#
# ALSO carved out (#3108): the five files of the TRUST SNAPSHOT TOOLING under
# packages/protocol/ — the extractor and its CLI, the two suites that break it on
# purpose, and the committed extraction (trust.snapshot.json). They sit beside
# the schemas, so the `packages/protocol/` prefix used to schedule every
# platform's build and the FULL iOS tier (326 tests, two serial Mac waves) for a
# diff that cannot change a Swift type: none of them is read by codegen, none is
# listed in project.yml, none is compiled into anything. Their only reader is
# repo-tests (`bun test`), which gates on `docs_only`, not on a platform flag, so
# it still runs.
#
# This ONE list is the exclusion for SHARED_DEPS_RE, IOS_FULL_RE and
# IOS_COMPILE_RE alike (the vitest entries match neither iOS regex, so for those
# two they are inert). The iOS regexes therefore keep the whole
# `packages/protocol/` prefix: a protocol file NOBODY has classified earns the
# FULL tier and compiles iOS — fail-safe — and adding one never requires an edit
# to this file (#3129). Before #3129 the iOS regexes enumerated the protocol
# paths that reach the app instead, which failed OPEN for a file added later, so
# a test had to force every PR adding a protocol file to edit this supply-chain
# file — a write only the infra lane may make.
#
# Every protocol entry is a LITERAL path (only `\.` escapes, no pattern), so a
# reader and tests/orchestrator/ios-trust-tooling.test.ts can parse the list
# back out. That suite proves each entry, rather than trusting the listing:
# it exists, it is not a codegen input, it is not named in apps/ios/project.yml,
# and the set equals TRUST_TOOLING_FILES in orchestrator/src/ios-isolation.ts.
# Editing this list stays a supply-chain write, and should: carving a file out
# of the iOS gate is the owning lane's decision.
#
# CONSUMERS THAT LIFT THESE ASSIGNMENTS VERBATIM must apply this exclusion to
# all three regexes, not only to SHARED_DEPS_RE. A consumer that applies it to
# none, or only to SHARED_DEPS_RE, over-reports the five trust files as FULL —
# wrong in the expensive direction, never a missed gate.
#
# Not a way to hide a trust change: a diff that moves a pinned value does so in
# apps/ios/, apps/android/ or apps/desktop/ (iOS and crypto files are FULL on
# their own; the other two never reached the iOS gate). The snapshot's own
# release gate (`trust:release-check`) is a separate rail that this flag does
# not feed.
SHARED_DEPS_EXCLUDE_RE='^(vitest\.(unit|integration|desktop|orchestrator)\.(config|setup)\.ts|packages/protocol/trust\.snapshot\.json|packages/protocol/tools/trust-snapshot\.ts|packages/protocol/tools/trust-snapshot-cli\.ts|packages/protocol/tools/trust-snapshot\.test\.ts|packages/protocol/tools/trust-release\.test\.ts)$'

IOS_RE='^apps/ios/'
# Which iOS TIER a diff earns (see apps/ios/Tests/UI/ci-smoke.txt for the full
# rationale). `ios` above stays a blast-radius flag — it is `true` for every
# SHARED_DEPS_RE hit, because a change under scripts/ or package.json cannot be
# proven harmless to iOS and must never gate iOS to `false`. But only a diff
# that can actually change the iOS BINARY deserves all 326 tests: apps/ios/
# itself, the three packages whose codegen/FFI output is compiled into the app
# (crypto -> UniFFI XCFramework, protocol -> Swift types, i18n -> .strings),
# and the CI wiring that decides any of this. Everything else runs the smoke
# tier: still a real iOS gate, 2 runners instead of 4.
#
# `ci.yml` is named here (and in SHARED_DEPS_RE / IOS_COMPILE_RE) as the
# fail-closed default only: a diff to it is narrowed by its parsed CONTENT
# (`ci_yml_class` below, #3131) when the caller supplies both sides, and earns
# exactly what this regex says when it does not.
IOS_FULL_RE='^(apps/ios/|packages/crypto/|packages/protocol/|packages/i18n/|\.github/workflows/ci\.yml$|\.github/workflows/ios-e2e\.yml$|\.github/scripts/detect-changed-platforms\.sh$)'
# `ios_compile` is the NARROW iOS question: "can this diff change what
# `ios-compile-check` compiles?" It exists because `ios` is a blast-radius flag
# (every SHARED_DEPS_RE hit sets it — `scripts/`, `packages/shared/`, the vitest
# configs, ...) and `ios-compile-check` runs on one of the only two self-hosted
# Macs, 16 GiB hosts that gate every merge and start swapping with just two iOS
# jobs (#3012, #2243). A desktop-only or worker-only push therefore skipped
# `ios-build-test`/`ios-e2e` (`revalidate`) but still took a Mac slot here.
#
# The regex is the set of paths that job READS, and it is DERIVED, not trusted:
# tests/orchestrator/ios-compile-inputs.test.ts walks the job's real build
# inputs — project.yml's out-of-tree sources, Package.swift's local paths, every
# script the job's steps run (transitively), `bun run codegen`/`i18n:codegen`
# and the TypeScript import closure of what they execute, the job's cache keys,
# and the workflow that defines the gate — and FAILS if any of them is not
# matched here. Add a dependency to the build and that test goes red until it
# lands in this regex; do not edit this list from memory.
#
# Deliberately NOT here (the job reads none of it): `apps/worker/`,
# `apps/desktop/`, `apps/android/`, `src/client/`, `packages/shared/`,
# `packages/test-specs/`, the vitest configs, every other script under
# `scripts/`. `package.json`, `bun.lock` and `tsconfig*.json` ARE here: the job
# runs `bun install --frozen-lockfile` and then codegen, so a dependency bump
# can change the generated Swift.
IOS_COMPILE_RE='^(apps/ios/|packages/crypto/|packages/protocol/|packages/i18n/|package\.json$|bun\.lock|tsconfig[^/]*\.json$|scripts/ci/mac-runner-disk-guard(-wait)?\.sh$|scripts/ci/mac-rust-toolchain\.sh$|\.github/actions/mac-rust-toolchain/action\.yml$|\.github/workflows/ci\.yml$|\.github/scripts/detect-changed-platforms\.sh$)'
ANDROID_RE='^apps/android/'
# No `.github/workflows/desktop-e2e\.yml$` term: that workflow no longer
# exists. Its chromium tier is ci.yml's `desktop-e2e` job, and ci.yml is in
# SHARED_DEPS_RE, so editing the file that defines the job already sets this
# flag. The under-trigger that term was written for (#910 merged a change to
# the E2E (Linux) Rust cache without ever running E2E (Linux)) is now
# structurally impossible — there is no second file to edit.
DESKTOP_RE='^(apps/desktop/|src/client/|tests/|vitest\.desktop\.(config|setup)\.ts$)'
# Carved out of DESKTOP_RE's blanket `tests/` prefix: directories under tests/
# that are NOT desktop e2e. Without this, `ci.yml`'s `e2e` job
# (`if: desktop == 'true' || backend == 'true'`) runs four Playwright shards,
# E2E (Linux) and a Docker Compose stack for changes that cannot affect either.
# On 2026-09-27 this was the sole reason #1164 — an orchestrator-only PR — sat
# blocked on `ci-status`.
#
# Two independent sources agree these are not e2e, and this list must not drift
# from either:
#   - `playwright.config.ts`'s desktop project already carries
#     `testIgnore: ["**/live/**", …, "**/orchestrator/**", "**/*.test.ts"]`.
#     Playwright does not run them; the filter should not schedule a job for them.
#   - `tests/load` (k6), `tests/iso-builder` and `tests/eslint` are referenced by
#     no job in ci.yml at all.
#
# Deliberately NOT excluded: `tests/steps/`, `tests/mocks/`, `tests/pages/`,
# `tests/fixtures/`, `tests/helpers/`, `tests/e2e/` and the root `*.spec.ts` /
# helper files — all genuinely e2e or its infrastructure. Nor `tests/desktop/`:
# it does NOT feed desktop-unit (vitest.desktop.config.ts reads src/client/
# only) — it is the WebdriverIO suite against a real Tauri build, which no
# workflow runs yet (#1126). No job observes it today, but it is desktop by
# content, so it stays in: the day #1126 wires it into a desktop-gated job, a
# wdio-only change must already run it.
#
# guards.test.ts binds each excluded directory to that evidence: Playwright's
# chromium project must ignore every spec/test file in it, no playwright.config.ts
# glob may point into it, and no e2e code or config may import from it.
#
# This stays an EXCLUDE list rather than becoming an include list on purpose.
# An include list makes "a new test directory gates nothing" the default, which
# is the same silent-non-execution failure this repo has filed repeatedly
# (#1126 and #1153 still open; #1167 was this exact failure for the worker
# integration suite, and took five months to notice). Excluding fails toward
# running too much,
# which costs minutes; including fails toward running nothing, which costs a
# regression nobody sees.
#
# Checked as a separate expression rather than folded into DESKTOP_RE because
# these are POSIX ERE (`grep -E`), which has no negative lookahead.
DESKTOP_EXCLUDE_RE='^tests/(orchestrator|live|load|iso-builder|eslint)/'
# src/server/ is the actual Bun server entry point (`bun run build:server`,
# and the image `docker compose ... up --build` produces for e2e/backend-bdd/
# android-e2e) — it lives outside apps/worker/ but is exactly as
# backend-relevant. drizzle/ (migration files + snapshots) and
# drizzle.config.ts are the literal inputs `bun run migration:check` (the
# migration-drift job) diffs, and backend-bdd applies these migrations via
# the bootstrapped backend — both need the `backend` flag, not just
# migration-drift. tests/steps/backend/ is backend-bdd's own step
# definitions (playwright.config.ts's `backend-bdd` project points its
# `steps` glob there specifically, distinct from the desktop `bdd` project's
# steps) — already caught by the blanket `tests/` prefix below for the
# `desktop` flag, but backend-bdd itself only gates on `backend`, so it needs
# its own hit here too.
BACKEND_RE='^(apps/worker/|sip-bridge/|signal-notifier/|deploy/docker/|src/server/|drizzle/|drizzle\.config\.ts$|tests/steps/backend/|vitest\.(unit|integration)\.(config|setup)\.ts$)'
# `crypto-tests` is not only the crate's own unit tests: packages/crypto/tests/
# envelope_aad_cross_platform.rs reads Android's CryptoService.kt and generated
# binding, every hand-written Kotlin/Swift file under apps/android/app/src/main
# and apps/ios/Sources, and src/client/lib/*. Its whole purpose is to fail when
# one of THOSE drifts from the registry, so a diff confined to them must run
# it — with the old `^packages/crypto/` alone, a mobile-only diff that broke
# the Android label-id table skipped the suite and reported green (#1941).
# Whole app prefixes rather than the exact directories the test walks today:
# the test grows new readers, this regex does not, and a missed path fails
# toward a silent skip while an extra one costs ~3.5 min on a hosted runner.
CRYPTO_RE='^(packages/crypto/|apps/android/|apps/ios/|src/client/)'
ANSIBLE_RE='^deploy/ansible/'
# Dependency manifests only — deliberately narrower than SHARED_DEPS_RE: a
# docs- or workflow-only PR must not be blocked by a dependency advisory it
# could not possibly have introduced.
AUDIT_RE='^(package\.json$|bun\.lock)'
# The fleet orchestrator has no backend/DB dependency and its safety-rail
# tests run inside the backend-unit job (see that job's own comment in
# ci.yml) — its own source and tests must gate that job too, independent of
# the `backend` flag.
#
# .claude/agents/ is orchestrator INPUT, not documentation: loadLanes() and
# loadLaneScopes() parse fragments/*.md into lane briefs and the scope gate,
# and tests/orchestrator/{scope,fragments,shared-fragment}.test.ts read the
# real files — including the rail that fails when an assembled
# <lane>-supervisor.md is stale against its fragment. Its `.md` files match
# DOCS_ONLY_EXEMPT_RE, so before this an agents-only PR (#981) set no flag and
# skipped backend-unit, the one job that checks them.
ORCHESTRATOR_RE='^(orchestrator/|tests/orchestrator/|vitest\.orchestrator\.(config|setup)\.ts$|\.claude/agents/)'
# The cross-platform BDD feature corpus (packages/test-specs/features/**)
# and the one composite action every backend-bootstrapping job shares
# (.github/actions/bootstrap-backend). Both are read directly by ci.yml's
# `e2e` (desktop bdd + backend-bdd Playwright projects), `desktop-e2e`
# (bootstrap + chromium projects) and `backend-bdd` jobs — all three
# bootstrap via the same action. None of the platform-specific regexes above would catch either
# path on its own, so a change here sets `desktop` and `backend` directly
# rather than relying on one of them to coincidentally already be true.
E2E_INFRA_RE='^(packages/test-specs/|\.github/actions/)'
# Android's slice of the same corpus is NARROWER, and the difference is
# expensive. `android-e2e` collects only
# `packages/test-specs/features/platform/mobile/**` — ci.yml's
# "FEATURES=$(find packages/test-specs/features/platform/mobile ...)" step and
# apps/android/app/build.gradle.kts's copy task (`from(.../features/platform/
# mobile)`) are both scoped to that one directory. A change under
# `features/core/`, `features/admin/`, `features/security/` or
# `features/platform/desktop/` therefore cannot reach the Android build at
# all.
#
# Keying Android off the whole `packages/test-specs/` prefix cost real queue
# time: #1072 edited `features/core/call-routing.feature` and nothing else
# Android-shaped, and its merge_group run spent ~50 job-minutes on
# `android-build-test` plus four `android-e2e` shards — inside the merge
# queue, which is strictly serial and the scarcest resource we have.
# `.github/actions/` stays in, because android-e2e does bootstrap through it.
E2E_INFRA_ANDROID_RE='^(packages/test-specs/features/platform/mobile/|\.github/actions/)'
# playwright.config.ts is read directly by ci.yml's `e2e` and `desktop-e2e`
# jobs (both invoke `bunx playwright test` against it) — not by android/ios,
# which don't use Playwright at all.
PLAYWRIGHT_CONFIG_RE='^playwright\.config\.ts$'
DOCS_ONLY_EXEMPT_RE='\.md$|^site/'

# ── ci.yml is classified by its CONTENT, not its name (#3131) ──────────────
# `.github/workflows/ci.yml` is ONE file holding every job in the repo, and it
# is named in SHARED_DEPS_RE, IOS_FULL_RE and IOS_COMPILE_RE because a diff to
# it can change what any gate does — including make its own changes skip the
# gates. Keyed on the file name alone, that also charged the FULL iOS tier
# (326 tests, two serial waves on the two self-hosted Macs) to a diff that
# could not change any job: #3120's whole ci.yml diff is five added YAML
# comment lines, and #3089's is one step appended to `docs-guard`, a job on a
# hosted Linux VM that neither feeds nor reads any iOS job.
#
# The narrowing is DERIVED from the two parsed workflows, never declared by
# the diff's author, and every path it cannot finish ends in `ios` (= today's
# behaviour: all three regexes apply). The classes:
#
#   inert        The two files parse to the IDENTICAL YAML node graph — same
#                tags, same scalar values AND styles, same key order, aliases
#                expanded. Comments and layout are discarded by every YAML
#                parser, so no job can observe the change. A `#` line inside
#                a `run: |` block is NOT a YAML comment — it is part of that
#                string, so it changes the graph and is never inert. The file
#                then sets no platform flag. It does set `orchestrator`:
#                tests/orchestrator/ reads ci.yml's raw TEXT (job-block
#                slicing, pinned `if:` strings), and those rails must still see
#                the edit.
#   outside_ios  Nothing outside `jobs:` changed (`on`, `env`, `defaults`,
#                `concurrency`, `permissions`, `name`, top-level anchors, ...),
#                the job ids are the same names in the same order (an added,
#                removed, renamed or reordered job is `ios`), and EVERY job
#                whose subtree changed is, on BOTH sides:
#                  - on a GitHub-hosted Linux VM: `runs-on` is one literal
#                    `ubuntu-*` label and there is no `uses:`. Anything else —
#                    the self-hosted Macs, a matrix expression, a
#                    reusable-workflow call like `ios-e2e` — is an "executor"
#                    that may be the iOS gate;
#                  - not a reader of the flags this narrowing changes
#                    (`ios_tier`, `ios_compile`, `ios_full`) nor of outputs by
#                    an indirect accessor (`outputs[...]`, `toJSON(needs…)`,
#                    `needs.*`, `needs[...]`) — such a job would run differently
#                    under the narrowed flags, so its own edit would go
#                    unverified;
#                  - not needed, transitively, by an executor or a flag reader
#                    (it cannot feed them an output or a result) — this is what
#                    keeps `changes`, the path-filter wiring, FULL;
#                  - not needing, transitively, an executor (it cannot read an
#                    iOS verdict) — this is what keeps `ci-status` and
#                    `platform-suite-coverage` FULL;
#                  - without a job-level `concurrency` (a group can cancel or
#                    hold another job) and with unchanged `permissions`.
#                Every `needs` edge is read from both sides, so an edge added
#                or removed toward an iOS job is caught on the side that has
#                it. Because aliases are expanded before comparing, an anchor
#                edited in one job and consumed by an iOS job shows up as a
#                change to the iOS job. A merge key (`<<:`) at the workflow,
#                `jobs:` or job level, a duplicate key, a recursive alias or an
#                alias expansion past the node budget is unclassifiable.
#                Result: the file still sets every platform flag, `ios`
#                included (the smoke tier still runs), but not `ios_full` and
#                not `ios_compile`.
#   ios          Anything else, and every failure to decide: no base/head
#                content supplied, either side unreadable or absent (an added
#                or deleted ci.yml), not exactly one YAML mapping document,
#                python3 or PyYAML missing, or a crash. All three regexes apply.
#
# The classification is over the WHOLE file, never per hunk: a comment edit
# riding along with one changed step in an iOS job is `ios`.
#
# INPUTS: `CI_YML_BASE_FILE` and `CI_YML_HEAD_FILE`, paths to ci.yml's text at
# the diff's base and head. The caller resolves them, because only it knows the
# base: ci.yml's `changes` job writes them from the same BASE/HEAD it diffs
# (the merge base on `pull_request`, the queue target on `merge_group`). A
# caller that supplies neither — the orchestrator's queue-feed, the tests that
# pipe a bare file list, the operator's `arm-batch.sh`, which lifts the regex
# assignments out of this file — gets `ios` for ci.yml, i.e. it over-reports
# in the expensive direction and never misses a gate. A consumer that wants the
# narrowing must run THIS script with those two variables; re-implementing the
# classification elsewhere is the drift #664 exists to prevent.
CI_YML_PATH='.github/workflows/ci.yml'

# Prints one line: `<class>\t<reason>`. Exits 0 whenever it printed a verdict.
classify_ci_yml() {
  python3 - "$1" "$2" <<'PY'
import re
import sys


def verdict(cls, why):
    print(f"{cls}\t{why}")
    sys.exit(0)


try:
    import yaml
    from yaml.nodes import MappingNode, ScalarNode, SequenceNode
except Exception as e:  # noqa: BLE001 — any import failure is "cannot decide"
    verdict("error", f"PyYAML is not importable ({type(e).__name__}), so the workflow cannot be parsed")


class Unclassifiable(Exception):
    pass


# Node visits allowed per side. ci.yml is a few tens of thousands of nodes;
# an alias bomb is millions.
BUDGET = 2_000_000
HOSTED_LINUX = re.compile(r"ubuntu-[0-9a-z.]+\Z")
# The flags THIS narrowing changes, plus indirect output accessors that could
# reach them without naming them.
FLAG_READ = re.compile(r"ios_tier|ios_compile|ios_full|outputs\s*\[|tojson\s*\(\s*needs|needs\s*(\.\s*\*|\[)", re.I)


class Canon:
    """Canonical form of a composed node: tags, scalar values and styles, key
    order; aliases expanded (so an anchor's consumers see its edits)."""

    def __init__(self):
        self.left = BUDGET

    def __call__(self, node, stack=()):
        self.left -= 1
        if self.left < 0:
            raise Unclassifiable("expands past the node budget (an alias bomb?)")
        if isinstance(node, ScalarNode):
            return ("s", node.tag, node.style, node.value)
        if id(node) in stack:
            raise Unclassifiable("contains a recursive alias")
        stack = stack + (id(node),)
        if isinstance(node, SequenceNode):
            return ("q", node.tag, tuple(self(c, stack) for c in node.value))
        if isinstance(node, MappingNode):
            return ("m", node.tag, tuple((self(k, stack), self(v, stack)) for k, v in node.value))
        raise Unclassifiable(f"has an unknown node kind {type(node).__name__}")


def scalars(c):
    if c[0] == "s":
        yield c[3]
    elif c[0] == "q":
        for x in c[2]:
            yield from scalars(x)
    else:
        for k, v in c[2]:
            yield from scalars(k)
            yield from scalars(v)


def entries(node, what):
    if not isinstance(node, MappingNode):
        raise Unclassifiable(f"{what} is not a mapping")
    order, out = [], {}
    for k, v in node.value:
        if not isinstance(k, ScalarNode) or k.value == "<<":
            raise Unclassifiable(f"{what} has a key that is not a plain name (a merge key or a complex key)")
        if k.value in out:
            raise Unclassifiable(f'{what} has the key "{k.value}" twice')
        order.append(k.value)
        out[k.value] = (k, v)
    return order, out


def load(path):
    with open(path, encoding="utf-8") as f:
        docs = list(yaml.compose_all(f.read(), Loader=yaml.SafeLoader))
    if len(docs) != 1 or not isinstance(docs[0], MappingNode):
        raise Unclassifiable(f"{path} is not exactly one YAML mapping document")
    return docs[0]


def model(root, canon):
    order, top = entries(root, "the workflow")
    if "jobs" not in top:
        raise Unclassifiable("has no jobs: mapping")
    rest = tuple(
        (canon(top[n][0]), ("jobs", top[n][1].tag) if n == "jobs" else canon(top[n][1])) for n in order
    )
    job_order, jobs = entries(top["jobs"][1], "jobs:")
    out = {}
    for name in job_order:
        key, node = jobs[name]
        _, fields = entries(node, f'job "{name}"')
        c = canon(node)
        needs = []
        if "needs" in fields:
            n = fields["needs"][1]
            if isinstance(n, ScalarNode):
                needs = [n.value]
            elif isinstance(n, SequenceNode) and all(isinstance(x, ScalarNode) for x in n.value):
                needs = [x.value for x in n.value]
            else:
                raise Unclassifiable(f'job "{name}" has a needs: that is not a job id or a list of them')
        ro = fields.get("runs-on")
        hosted_linux = (
            "uses" not in fields
            and ro is not None
            and isinstance(ro[1], ScalarNode)
            and HOSTED_LINUX.match(ro[1].value) is not None
        )
        out[name] = {
            "canon": (canon(key), c),
            "needs": needs,
            "executor": not hosted_linux,
            "flag_reader": any(FLAG_READ.search(s) for s in scalars(c)),
            "concurrency": "concurrency" in fields,
            "permissions": canon(fields["permissions"][1]) if "permissions" in fields else None,
        }
    for name, job in out.items():
        for n in job["needs"]:
            if n not in out:
                raise Unclassifiable(f'job "{name}" needs "{n}", which is not a job')
    return rest, job_order, out


def ancestors(jobs, name):
    seen, todo = set(), list(jobs[name]["needs"])
    while todo:
        n = todo.pop()
        if n not in seen:
            seen.add(n)
            todo.extend(jobs[n]["needs"])
    return seen


def risks(name, side, jobs):
    job = jobs[name]
    why = []
    if job["executor"]:
        why.append(f"is not provably on a GitHub-hosted Linux VM ({side})")
    if job["flag_reader"]:
        why.append(f"reads the iOS tier/compile flags or an output indirectly ({side})")
    if job["concurrency"]:
        why.append(f"declares a job-level concurrency group ({side})")
    read = sorted(a for a in ancestors(jobs, name) if jobs[a]["executor"])
    if read:
        why.append(f"needs {', '.join(read)} ({side})")
    fed = sorted(j for j in jobs if name in ancestors(jobs, j) and (jobs[j]["executor"] or jobs[j]["flag_reader"]))
    if fed:
        why.append(f"is needed by {', '.join(fed)} ({side})")
    return why


def classify(base_path, head_path):
    b_root, h_root = load(base_path), load(head_path)
    bc, hc = Canon(), Canon()
    if bc(b_root) == hc(h_root):
        return "inert", "parses to the identical workflow — the diff changes only comments or layout"
    b_rest, b_order, b_jobs = model(b_root, bc)
    h_rest, h_order, h_jobs = model(h_root, hc)
    if b_rest != h_rest:
        return "ios", "changes workflow-level configuration outside jobs: (on, env, defaults, concurrency, permissions, ...)"
    if b_order != h_order:
        return "ios", "adds, removes, renames or reorders a job"
    changed = [n for n in b_order if b_jobs[n]["canon"] != h_jobs[n]["canon"]]
    if not changed:
        return "ios", "differs in a way no single job accounts for"
    found = []
    for name in changed:
        why = risks(name, "base", b_jobs) + risks(name, "head", h_jobs)
        if b_jobs[name]["permissions"] != h_jobs[name]["permissions"]:
            why.append("changes its permissions")
        if why:
            found.append(f"{name} {'; '.join(why)}")
    if found:
        return "ios", "changes a job that can reach the iOS gate: " + " | ".join(found)
    return "outside_ios", f"changes only job(s) {', '.join(changed)}, none of which is, feeds or reads an iOS gate job"


try:
    verdict(*classify(sys.argv[1], sys.argv[2]))
except Unclassifiable as e:
    verdict("ios", f"cannot be classified: {e}")
except SystemExit:
    raise
except BaseException as e:  # noqa: BLE001 — every failure is "cannot decide"
    verdict("error", f"the classifier failed ({type(e).__name__}: {e})")
PY
}

ci_yml_class=ios
if grep -qxF "$CI_YML_PATH" <<< "$CHANGED_FILES"; then
  if [[ -n "${CI_YML_BASE_FILE:-}" && -n "${CI_YML_HEAD_FILE:-}" \
        && -f "$CI_YML_BASE_FILE" && -r "$CI_YML_BASE_FILE" \
        && -f "$CI_YML_HEAD_FILE" && -r "$CI_YML_HEAD_FILE" ]]; then
    ci_yml_verdict=$(classify_ci_yml "$CI_YML_BASE_FILE" "$CI_YML_HEAD_FILE") \
      || ci_yml_verdict=$'error\tthe classifier exited non-zero (python3 missing?)'
  else
    ci_yml_verdict=$'ios\tno base/head content was supplied (CI_YML_BASE_FILE / CI_YML_HEAD_FILE), or one side is unreadable'
  fi
  ci_yml_class=${ci_yml_verdict%%$'\t'*}
  ci_yml_why=${ci_yml_verdict#*$'\t'}
  case "$ci_yml_class" in
    inert|outside_ios|ios|error) ;;
    *) ci_yml_why="the classifier printed no verdict (${ci_yml_verdict:0:200})"; ci_yml_class=error ;;
  esac
  if [[ "$ci_yml_class" == error ]]; then
    # Fail closed, but VISIBLY: content was supplied and the tool could not
    # read it, so the narrowing silently stopped applying. Say so in the run.
    ci_yml_class=ios
    echo "::warning title=ci.yml content classification unavailable::$ci_yml_why — ci.yml is treated as FULL" >&2
  fi
  echo "ci.yml classified as $ci_yml_class: $ci_yml_why" >&2
fi

docs_only=true
ios=false
ios_full=false
ios_compile=false
android=false
desktop=false
backend=false
crypto=false
ansible=false
audit=false
orchestrator=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  if ! echo "$file" | grep -qE "$DOCS_ONLY_EXEMPT_RE"; then
    docs_only=false
  fi

  # ci.yml's content class (above) narrows what its NAME would earn: `inert`
  # takes it out of all three regexes, `outside_ios` out of the two iOS-tier
  # ones. `ios` — every undecided case — narrows nothing.
  narrow_shared=false; narrow_ios=false
  if [[ "$file" == "$CI_YML_PATH" ]]; then
    case "$ci_yml_class" in
      inert) narrow_shared=true; narrow_ios=true; orchestrator=true
             echo "ci.yml changed only comments/layout — its text-reading rails (orchestrator) still run" >&2 ;;
      outside_ios) narrow_ios=true ;;
    esac
  fi

  if [[ "$narrow_shared" == false ]] && echo "$file" | grep -qE "$SHARED_DEPS_RE" && ! echo "$file" | grep -qE "$SHARED_DEPS_EXCLUDE_RE"; then
    ios=true; android=true; desktop=true; backend=true; crypto=true
    echo "Shared-dependency file changed: $file" >&2
  fi

  echo "$file" | grep -qE "$IOS_RE" && { ios=true; echo "iOS file changed: $file" >&2; }
  [[ "$narrow_ios" == false ]] && echo "$file" | grep -qE "$IOS_FULL_RE" && ! echo "$file" | grep -qE "$SHARED_DEPS_EXCLUDE_RE" \
    && { ios=true; ios_full=true; echo "iOS full-tier file changed: $file" >&2; }
  [[ "$narrow_ios" == false ]] && echo "$file" | grep -qE "$IOS_COMPILE_RE" && ! echo "$file" | grep -qE "$SHARED_DEPS_EXCLUDE_RE" \
    && { ios=true; ios_compile=true; echo "iOS compile input changed: $file" >&2; }
  echo "$file" | grep -qE "$ANDROID_RE" && { android=true; echo "Android file changed: $file" >&2; }
  echo "$file" | grep -qE "$DESKTOP_RE" && ! echo "$file" | grep -qE "$DESKTOP_EXCLUDE_RE" \
    && { desktop=true; echo "Desktop file changed: $file" >&2; }
  echo "$file" | grep -qE "$BACKEND_RE" && { backend=true; echo "Backend file changed: $file" >&2; }
  echo "$file" | grep -qE "$CRYPTO_RE" && { crypto=true; echo "Crypto file changed: $file" >&2; }
  echo "$file" | grep -qE "$ANSIBLE_RE" && { ansible=true; echo "Ansible file changed: $file" >&2; }
  echo "$file" | grep -qE "$AUDIT_RE" && { audit=true; echo "Dependency manifest changed: $file" >&2; }
  echo "$file" | grep -qE "$ORCHESTRATOR_RE" && { orchestrator=true; echo "Fleet orchestrator file changed: $file" >&2; }
  echo "$file" | grep -qE "$E2E_INFRA_RE" && { desktop=true; backend=true; echo "E2E test infra file changed: $file" >&2; }
  echo "$file" | grep -qE "$E2E_INFRA_ANDROID_RE" && { android=true; echo "Android-visible E2E infra file changed: $file" >&2; }
  echo "$file" | grep -qE "$PLAYWRIGHT_CONFIG_RE" && { desktop=true; backend=true; echo "Playwright config changed: $file" >&2; }
done <<< "$CHANGED_FILES"

app=$([ "$docs_only" = "false" ] && echo true || echo false)

# full > smoke > none. `ios=true` with `ios_full=false` is the blast-radius
# case: iOS is reachable from the diff but cannot have changed the binary.
if [ "$ios_full" = "true" ]; then ios_tier=full
elif [ "$ios" = "true" ]; then ios_tier=smoke
else ios_tier=none
fi

cat <<EOF
docs_only=$docs_only
app=$app
ios=$ios
ios_tier=$ios_tier
ios_compile=$ios_compile
android=$android
desktop=$desktop
backend=$backend
crypto=$crypto
ansible=$ansible
audit=$audit
orchestrator=$orchestrator
EOF

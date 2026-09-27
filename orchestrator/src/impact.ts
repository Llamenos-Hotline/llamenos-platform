import { SECRET_PATH_PATTERNS } from './config.js'
import { matchesPath } from './fragments.js'

export const LARGE_DIFF_FILES = 40
export const LARGE_DIFF_LINES = 1500

/**
 * The paths where a quiet mistake is expensive in a way CI does not catch.
 * Crypto and protocol: a quiet error becomes an identity disclosure, which
 * is the whole threat model. Auth and sigchain: state a revert does not
 * restore. `orchestrator/` and its tests: a defect there disables the checks
 * that would have caught it.
 *
 * THIS LIST NO LONGER GATES ANYTHING. It used to be half of a userland merge
 * gate — `classifyImpact` marked a diff high and `mayAutoMerge` refused it —
 * enforcement nothing outside this process could see, and therefore nothing
 * outside this process was bound by. Every path below is owned in
 * `CODEOWNERS`, where GitHub's own "require review from Code Owners" rule
 * binds anyone, whoever or whatever opened the PR.
 * `tests/orchestrator/guards.test.ts` asserts that coverage against the real
 * tree, so a path added here without a matching `CODEOWNERS` line fails the
 * suite.
 *
 * What survives here is DESCRIPTION, not decision: the gate trace, the
 * digest, the reviewer's turn and timeout budget (review.ts), and the subset
 * `CRYPTO_REVIEW_PATHS` derives for the crypto-security-reviewer.
 *
 * NOT the full secrets list: every path `checkScope` refuses to write
 * (`SECRET_PATH_PATTERNS` in config.ts, the never-write source of truth) is
 * also classified high-impact below via `matchesPath` — see the `secretHit`
 * check in `classifyImpact`.
 */
export const HIGH_IMPACT_PATHS: readonly string[] = [
  // Every entry below is a REAL tracked path — a directory prefix ending in
  // `/`, or an exact file. That is not cosmetic: these same strings are the
  // `CODEOWNERS` lines, and CODEOWNERS is gitignore syntax, where a bare
  // `apps/worker/lib/auth` matches a file NAMED `auth` and therefore matches
  // nothing at all in this repo. An entry here that matches no tracked file
  // is a gate that silently protects nothing, so `guards.test.ts` asserts
  // both directions against `git ls-files`: every path here matches at least
  // one real file, and every real file under it is owned in CODEOWNERS.
  'packages/crypto/',
  'packages/protocol/schemas/',
  'packages/protocol/crypto-labels.json',
  'packages/shared/crypto-labels.ts',
  'orchestrator/',
  'tests/orchestrator/',

  // Key-boundary surfaces. Not the crypto crate itself, but the places that
  // keep (or could leak) a device private key: the webview IPC boundary, the
  // Tauri permission grants, the iOS/Android Keychain/Keystore wrappers, and
  // the Tauri IPC mock, which mirrors the Rust CryptoState.
  'src/client/lib/platform.ts',
  'apps/desktop/src/crypto.rs',
  'apps/desktop/capabilities/',
  'apps/ios/Sources/Services/CryptoService.swift',
  'apps/android/app/src/main/java/org/llamenos/hotline/crypto/',
  'tests/mocks/',

  // The fleet's own trust base: a worker that edits the orchestrator, the
  // agent definitions bounding its own behaviour, or the write-deny hook can
  // widen its own authority.
  '.claude/agents/',
  '.claude/settings.json',

  // The build's own trust base, and the reason this list gained entries in
  // the round that fixed the gate. The gate jobs install from the lockfile
  // and run from workflow definitions; a PR editing any of these is a PR
  // editing the machinery that judges it or the supply chain around a
  // release. Widened from the single `ci.yml` entry to the whole
  // `.github/workflows/` directory (PR #794) to match what CODEOWNERS
  // actually enforces — the impact classifier disagreeing with CODEOWNERS
  // about which workflow files are high-impact is worse than a broad match.
  'package.json',
  'bun.lockb',
  'lefthook.yml',
  '.github/workflows/',
  'knope.toml',
  // The vitest configs. `fleet/verify` no longer loads a PR's copy of these
  // (verify.ts installs the base's bytes over it), but whatever lands on main
  // IS what vitest's main process executes when judging every later PR —
  // including its `globalSetup` and plugins. Exact files, one per config: this
  // list is prefix/exact matching, and `CODEOWNERS` owns the `vitest.*.config.ts`
  // glob so a new config is owned before anyone remembers to list it here
  // (guards.test.ts fails until they do).
  'vitest.desktop.config.ts',
  'vitest.integration.config.ts',
  'vitest.orchestrator.config.ts',
  'vitest.unit.config.ts',

  // Key generation, release signing, the FDE installer image, build/ISO
  // verification, the desktop updater manifest and certificate pinning — the
  // first security-sensitive subset of `scripts/`, which is otherwise
  // ordinary infra-lane work (the gate scripts follow below). Matching CODEOWNERS entry for entry: a lane may author
  // these, but one quiet edit here compromises every install, not one build.
  'scripts/bootstrap-admin.ts',
  'scripts/release/',
  'scripts/build-iso.sh',
  'scripts/iso-builder/',
  'scripts/verify-build.sh',
  'scripts/verify-iso.sh',
  'scripts/generate-update-manifest.sh',
  'scripts/generate-update-manifest.ts',
  'scripts/inject-cert-pins.ts',
  'scripts/extract-cert-pins.sh',

  // The gate scripts under `scripts/`: every script whose exit status is a
  // check's verdict, so weakening it lets a defect through that check. The
  // repo checks CI and the git hooks run; the tests/ typecheck baseline gate;
  // the custom lint rules; the migration-drift baseline writer; the built-
  // image smoke gate plus the runtime invariant and migration runner that
  // ship inside the image; and every test runner, with the helpers they all
  // source. A lane that may quietly weaken the gate judging it can widen its
  // own authority. CODEOWNERS owns `scripts/check-*` and `scripts/test-*.sh`
  // as globs; these are exact files because this list is prefix/exact
  // matching, and guards.test.ts fails if a file those globs match is
  // missing here.
  'scripts/check-codeql-languages.ts',
  'scripts/check-ecies-active.sh',
  'scripts/check-ipc-allowlist.sh',
  'scripts/check-label-count.sh',
  'scripts/check-migration-drift.sh',
  'scripts/check-migration-drift.ts',
  'scripts/typecheck-tests-gate.ts',
  'scripts/eslint-rules/',
  'scripts/regenerate-snapshot.ts',
  'scripts/image-smoke.sh',
  'scripts/verify-runtime.ts',
  'scripts/run-migrations.ts',
  'scripts/test-android.sh',
  'scripts/test-backend-bdd.sh',
  'scripts/test-changed.sh',
  'scripts/test-crypto.sh',
  'scripts/test-desktop.sh',
  'scripts/test-feature.sh',
  'scripts/test-fleet.sh',
  'scripts/test-integration-full.sh',
  'scripts/test-ios.sh',
  'scripts/test-orchestrator.sh',
  'scripts/test-worker.sh',
  'scripts/android-parallel-e2e.sh',
  'scripts/lib/',

  // Deanonymization surfaces (PR #794, matching CODEOWNERS): sip-bridge/
  // routes PSTN calls and handles caller phone numbers; signal-notifier/
  // does HMAC-hashed contact resolution. Both are top-level, NOT under
  // apps/ despite what older docs say.
  'sip-bridge/',
  'signal-notifier/',

  // Auth, sessions, sigchain, identity: state a revert does not restore.
  // `.test.ts` siblings are listed explicitly — weakening the test is the
  // shortest route to disabling the check it guards.
  'apps/worker/middleware/',
  'apps/worker/lib/auth.ts',
  'apps/worker/lib/auth.test.ts',
  'apps/worker/lib/webauthn.ts',
  'apps/worker/lib/session-renewal.ts',
  'apps/worker/lib/crypto.ts',
  'apps/worker/lib/crypto.test.ts',
  'apps/worker/lib/hub-event-crypto.ts',
  'apps/worker/lib/push-encryption.ts',
  'apps/worker/lib/server-identity.ts',
  'apps/worker/lib/agent-identity.ts',
  'apps/worker/lib/timing-safe.ts',
  'apps/worker/lib/blind-index-query.ts',
  'apps/worker/lib/blind-index-query.test.ts',
  'apps/worker/routes/auth.ts',
  'apps/worker/routes/sessions.ts',
  'apps/worker/routes/webauthn.ts',
  'apps/worker/routes/sigchain.ts',
  'apps/worker/db/schema/sigchain.ts',
  'apps/worker/services/crypto-keys.ts',
]

export function classifyImpact(
  changedFiles: string[],
  addedLines: number,
): { impact: 'low' | 'high'; reasons: string[] } {
  const reasons: string[] = []
  for (const f of changedFiles) {
    const hit = HIGH_IMPACT_PATHS.find((p) => f.startsWith(p) || f.includes(`/${p}`))
    if (hit) reasons.push(`${f} is under high-impact path ${hit}`)
    // The two gates must not disagree about secrets: anything NEVER_WRITE_PATHS
    // (config.ts) would refuse to write is high-impact here too, so a secret
    // that reaches a diff by a route the write gate did not cover still
    // always requires human review rather than auto-merging.
    const secretHit = SECRET_PATH_PATTERNS.find((p) => matchesPath(f, p))
    if (secretHit) reasons.push(`${f} matches secret pattern ${secretHit} (never-write and high-impact)`)
  }
  if (changedFiles.length > LARGE_DIFF_FILES) {
    reasons.push(`${changedFiles.length} files exceeds the ${LARGE_DIFF_FILES}-file review threshold`)
  }
  if (addedLines > LARGE_DIFF_LINES) {
    reasons.push(`${addedLines} lines exceeds the ${LARGE_DIFF_LINES}-line review threshold`)
  }
  return { impact: reasons.length > 0 ? 'high' : 'low', reasons }
}

// ---------------------------------------------------------------------------
// Impact TIERS — a second, independent axis from `classifyImpact` above.
//
// `classifyImpact`'s low/high decides how CAREFULLY a review reads a diff
// that is already going to be reviewed (more reviewer turns, a longer
// timeout — see review.ts's HIGH_IMPACT_MAX_TURNS/HIGH_IMPACT_TIMEOUT_MS).
// It never decided whether a review runs at all, and still doesn't.
//
// A tier decides that: how much CEREMONY a diff's blast radius earns before
// it may land, from "cheap repo checks only" up to "the full gate,
// including a non-author model review." Operator rule, 2026-09-19: "the
// ceremony should scale with impact too. A documentation fix should not
// wait on a model review; an instruction change should not wait on the
// mobile suites; crypto should wait on everything." This is the ONE place
// that rule is defined — `fleet/review`'s decision step (`decideReviewGate`,
// ci.ts) and the CI job path-scoping (`.github/scripts/detect-changed-
// platforms.sh`, once #862 lands — see the note above `TIER1_PATHS`) both
// consume `tierFor` rather than re-deriving their own notion of "this diff
// doesn't need X."
//
// CORRECTED 2026-09-22 (PR #870's own review gate caught this on itself):
// "an instruction change should not wait on the mobile suites" does not
// mean "an instruction change should skip the model review too." The
// original implementation read it that way and put agent-instruction paths
// in Tier 1, which — for the paths CODEOWNERS does not cover — meant no
// review of any kind. An instruction change is exactly the diff whose
// blast radius is largest: it can alter what every FUTURE diff, including
// a malicious one, is judged against. Those paths are Tier 2 now,
// unconditionally — see `AGENT_INSTRUCTION_PATHS` below. Tier 1 keeps the
// mobile-suite exemption; it never had, and never needed, a model-review
// exemption for paths this sensitive.
//
// CORRECTED AGAIN 2026-09-22 (the SAME gate caught the SAME class of defect
// a second time, on the SAME PR): "cosmetic tooling" is not automatically
// "cannot widen what a gate enforces." `eslint.config.js` is JavaScript a
// lint CI step `import()`s and executes; `.eslintrc.json`/`.prettierrc*`
// are not code but ARE sourced and evaluated by that same step, and a diff
// touching only one of them could disable the lint gate entirely. None of
// the seven paths this removed (see `TIER1_PATHS`'s own comment) ever had a
// CODEOWNERS line, so "waits on cheap checks + code-owner review" was as
// false for these as it was for `.claude/skills/` in the first fix — the
// bullet below now says what is actually true of what remains, instead of
// what the tier was originally supposed to mean. The pattern across BOTH
// fixes: every category proposed as "safe to auto-pass" has turned out to
// be executable or authority-bearing. `TIER1_PATHS`'s own comment argues
// the durable fix is a cheap check gating Tier 1 in `ci.ts` (outside this
// file's owned paths, so not implemented here) rather than another round of
// re-curating which paths feel safe.
//
//   Tier 0 — no executable content: `docs/**`, `*.md` outside `.claude/`
//     and outside an agent-instruction basename, spec prose. Nothing here
//     can affect runtime behavior. Waits on cheap repo checks only
//     (lint/typecheck where applicable) — no model review, ever.
//   Tier 1 — data verified (not assumed) to be sourced, evaluated, or
//     executed by NOTHING in this repo: `.editorconfig`, `.gitattributes`.
//     No lint/format tool config, however inert it looks, because ESLint
//     and Prettier configs (JS or JSON) both resolve `"extends"`/`"plugins"`
//     and apply `"rules"` — capability enough to alter what the lint gate
//     enforces. Waits on cheap checks only. No model review, no e2e/mobile
//     suites, and NOT contingent on CODEOWNERS coverage the way the
//     original design assumed — see `TIER1_PATHS`'s own comment for why
//     that contingency failed twice.
//   Tier 2 — everything else, and ALWAYS: product code, `packages/crypto/`,
//     auth/session/sigchain, `packages/protocol/schemas/`,
//     `.github/workflows/`, `orchestrator/`, `tests/orchestrator/`,
//     dependency manifests, AND — as of PR #870's fix — every
//     agent-instruction path: `.claude/**` (skills, agents, fragments,
//     settings, coordination), `docs/superpowers/specs/`, and any
//     `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` file at any depth. Waits on the
//     full gate, including the non-author model review. Also the default
//     for any path this file does not otherwise recognize — an unmatched
//     path is a gap in this classifier, not evidence of safety.
//
// A diff spanning tiers takes the HIGHEST tier it touches — never an
// average, never "mostly docs." `tierFor` below is that computation.
// ---------------------------------------------------------------------------

export type ImpactTier = 0 | 1 | 2

/**
 * Documentation prose: everything under `docs/`, and any `*.md` file
 * anywhere else in the tree — a README can live next to the code it
 * documents, so Tier 0 cannot be a `docs/`-prefix check alone.
 *
 * `.claude/` is explicitly exempt from the `*.md` rule: an agent or skill
 * definition happens to use the same extension as a README, but it is
 * instruction text a coding agent OBEYS, not prose a human reads —
 * `AGENT_INSTRUCTION_PATHS` below (Tier 2, unconditional) is what actually
 * classifies it, checked BEFORE this function ever runs (see
 * `tierForFile`'s ordering comment), so the exemption below is
 * defense-in-depth, not the primary mechanism. `docs/superpowers/specs/` is
 * carved back OUT of Tier 0 the same way, for the same reason: a spec can
 * carry an invariant this repo's own gates depend on.
 *
 * Deliberately does NOT attempt to detect a comment-only CODE diff: that
 * needs the diff's own content, and no caller of `tierFor` currently plumbs
 * full diff text through it — only the changed-file list. A real follow-up,
 * left undone rather than guessed at; see this file's own history (the
 * `k2p6` / `--format text` comments in review.ts) for why this codebase
 * verifies a claim before shipping it rather than assuming a shape it never
 * checked.
 */
export const TIER0_DOC_DIR = 'docs/'

/** `*.md` under this prefix is instruction text, not prose — see
 *  `TIER0_DOC_DIR`'s comment. */
const TIER0_MD_EXEMPT_PREFIX = '.claude/'

function isTier0Path(f: string): boolean {
  if (f.startsWith(TIER0_MD_EXEMPT_PREFIX)) return false
  if (f.startsWith(TIER0_DOC_DIR)) return true
  return f.endsWith('.md')
}

/**
 * Instructions and tooling that shape FUTURE work — never product behavior
 * at runtime today, and never a path that can alter what the fleet's own
 * coding agents OBEY.
 *
 * `.claude/agents/`, `.claude/skills/`, `docs/superpowers/specs/`, and
 * `lefthook.yml` used to live in this list — that was the defect a review
 * gate caught on PR #870: "Tier 1 lets PRs auto-succeed with neither a
 * model review nor a CODEOWNERS-enforced human review, converting a
 * fail-closed 'not-requested' gate into an unattended pass for paths that
 * can alter what the fleet's own coding agents will obey." `.claude/skills/`
 * and `docs/superpowers/specs/` are not owned in `CODEOWNERS` at all (see
 * `AGENT_INSTRUCTION_PATHS` below), so "Tier 1 gets a code-owner review" was
 * a promise this file could not keep for exactly the paths where breaking
 * it matters most — the files that define lane ownership, never-write
 * paths, and the determinism invariants every dispatched worker is bound
 * by. All four now classify Tier 2 unconditionally — see
 * `AGENT_INSTRUCTION_PATHS` (which absorbs `.claude/agents/` and
 * `.claude/skills/` under a single `.claude/` prefix, plus
 * `docs/superpowers/specs/`) and `lefthook.yml`'s existing, untouched
 * `HIGH_IMPACT_PATHS` entry (removing it here was enough — that list
 * already forces Tier 2 with full CODEOWNERS coverage).
 *
 * FIXED AGAIN 2026-09-22 (PR #870's review gate caught this on itself a
 * SECOND time): the list above used to also carry `eslint.config.js`,
 * `eslint.config.ts`, `.eslintrc.json`, `.eslintrc.js`, `.prettierrc`,
 * `.prettierrc.json`, and `.prettierrc.js`. Every one of those is a file a
 * lint/format CI step SOURCES and EVALUATES — `eslint.config.js` is literal
 * JavaScript the lint job `import()`s and executes; the JSON variants are
 * not code, but ESLint/Prettier both resolve `"extends"`/`"plugins"` out of
 * them and apply their `"rules"` verbatim, so a diff touching only one of
 * these could silently disable the very lint gate other PRs rely on as a
 * quality signal — with ZERO review, because (verified against the tracked
 * `CODEOWNERS` file, not assumed) not one of those seven paths has ever had
 * a CODEOWNERS line. The doc comment above claiming Tier 1 "already earns a
 * code-owner review on its own" was true for `lefthook.yml` (removed from
 * this list in the first fix, already Tier 2 via `HIGH_IMPACT_PATHS`) but
 * was never true for any of these seven — a promise this file could not
 * keep, the identical shape as the first fix's `.claude/skills/` finding.
 *
 * Twice now, everything proposed for this tier has turned out to be either
 * executable or authority-bearing over what a gate enforces. The PR that
 * made this second fix argues in its own description that the honest
 * long-term answer is probably "Tier 1 should require a CHEAP check before
 * `ci.ts` lets it skip the model review" rather than nothing at all — but
 * `decideReviewGate` (`orchestrator/src/ci.ts`) currently treats Tier 0 and
 * Tier 1 identically (`tier < 2` → zero engine calls, zero other checks)
 * and that function is outside this file's owned paths
 * (`orchestrator/src/impact.ts`, `tests/orchestrator/`), so it could not be
 * changed here. What COULD be fixed here, unconditionally and without
 * touching `ci.ts` at all: shrink membership to paths verified (by grep — see
 * the guard test in `impact.test.ts`, not a comment's claim) to be sourced,
 * evaluated, or executed by NOTHING in this repo today — `.editorconfig`
 * and `.gitattributes`. Both are pure declarative key/value data (whitespace
 * rules; line-ending/diff/export hints) with no `"extends"`, no plugin
 * loading, and no rule-suppression capability, so a diff touching only one
 * of them cannot alter what any gate enforces or what CI executes. Neither
 * is CODEOWNERS-covered either, but that no longer matters the way it did
 * for `.claude/skills/`: there is no capability left in these two files for
 * an absent human reviewer to have missed.
 *
 * `tierForFile` checks `TIER1_PATHS` AFTER `AGENT_INSTRUCTION_PATHS` (Tier
 * 2, unconditional) and the `HIGH_IMPACT_PATHS`/secret checks, so nothing
 * below can ever shadow a Tier 2 path — the ordering the PR #870 regression
 * tests in `impact.test.ts` pin down. The standing rail in
 * `impact.test.ts` (`TIER1_PATHS admits no executable extension`) asserts
 * this list can never again gain a `.js`/`.ts`/`.mjs`/`.cjs`/`.mts`/`.cts`
 * (or other CI-executed) entry — the exact regression this comment
 * documents — so the next widening trips that test, not a live gate.
 */
export const TIER1_PATHS: readonly string[] = [
  '.editorconfig',
  '.gitattributes',
]

/**
 * Paths and file-basenames that define what the fleet's own coding agents
 * OBEY — skill definitions, agent/fragment instructions, the coordination
 * directory, and specs that carry an invariant this repo's own gates rely
 * on. Always Tier 2, unconditionally: never downgradable by a `.md`
 * extension (which would otherwise read as Tier 0 docs prose) or by living
 * under a directory that also holds ordinary tooling config (which would
 * otherwise read as Tier 1). A change here has a LARGER blast radius than
 * most product code, not a smaller one — it can alter the rules every
 * future PR, including this gate's own decision logic, is judged against.
 *
 * Deliberately NOT folded into `HIGH_IMPACT_PATHS` above: that list's own
 * guard (`tests/orchestrator/guards.test.ts`, "CODEOWNERS owns every
 * tracked file under every HIGH_IMPACT_PATH") requires full CODEOWNERS
 * coverage for every entry, and `CODEOWNERS` is outside this change's
 * owned paths (`orchestrator/src/impact.ts`, `tests/orchestrator/`) — today
 * it owns `.claude/agents/` and `.claude/settings.json` but not
 * `.claude/skills/`, `.claude/coordination/`, or `docs/superpowers/specs/`.
 * Tier 2 itself does not need CODEOWNERS to protect a path: `decideReviewGate`
 * (ci.ts) sends every Tier 2 diff through the full gate, including the
 * non-author model review, regardless of who — if anyone — CODEOWNERS
 * would also request. A follow-up (out of scope here) should still add
 * CODEOWNERS lines for the paths below that lack one, for the same
 * belt-and-suspenders reason `HIGH_IMPACT_PATHS` gets one.
 *
 * `.claude/` is a single directory prefix — broader than the narrower
 * `.claude/agents/`/`.claude/skills/` split the earlier TIER1_PATHS
 * version used — so a new subdirectory under `.claude/` (like
 * `.claude/coordination/`, tracked today) is Tier 2 by construction, not by
 * remembering to list it.
 */
export const AGENT_INSTRUCTION_PATHS: readonly string[] = [
  '.claude/',
  'docs/superpowers/specs/',
]

/**
 * Agent-instruction files identified by BASENAME, not directory — this
 * repo's own root `CLAUDE.md` (and `packages/crypto/CLAUDE.md`) live
 * outside `.claude/` and outside `docs/`, so without this check they would
 * fall through to `isTier0Path`'s `.md`-is-prose default and classify as
 * Tier 0: no review at all, for the single file every dispatched agent
 * reads first. `AGENTS.md`/`GEMINI.md` are the same convention under other
 * tool names — this repo's own root `CLAUDE.md` documents all three as
 * equal-precedence instruction files ("User instructions (CLAUDE.md,
 * AGENTS.md, GEMINI.md, etc...")) — included pre-emptively even though
 * neither is tracked here today, the same "owned before anyone remembers
 * to add it" reasoning `vitest.*.config.ts` uses above. Matched at ANY
 * depth: a per-package `CLAUDE.md` (like `packages/crypto/CLAUDE.md`,
 * tracked today) is exactly as load-bearing as the root one.
 */
const AGENT_INSTRUCTION_BASENAMES: ReadonlySet<string> = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])

function isAgentInstructionFile(f: string): boolean {
  const basename = f.slice(f.lastIndexOf('/') + 1)
  return AGENT_INSTRUCTION_BASENAMES.has(basename)
}

/**
 * Anchored on purpose — this is the fix for a fail-open a review gate
 * caught (see `tierForFile`'s doc comment, point 1): the earlier version
 * matched with `f.startsWith(p) || f.includes(\`/${p}\`)`, the same
 * unanchored-substring shape `classifyImpact` uses for `HIGH_IMPACT_PATHS`.
 * For a directory entry that's a reasonable "is this path under that
 * directory" test, but every `TIER1_PATHS` entry without a trailing `/` is
 * a single REPO-ROOT file — at the time of the fix, `lefthook.yml` and
 * `eslint.config.js` (both since removed from `TIER1_PATHS` entirely; see
 * that constant's own comment for why), today `.editorconfig` and
 * `.gitattributes` — and `includes(\`/${p}\`)` matches that basename at ANY
 * depth: `packages/crypto/eslint.config.js` or
 * `orchestrator/src/lefthook.yml` matched despite living under a directory
 * `HIGH_IMPACT_PATHS` calls Tier 2 "always". Because `tierForFile` checks
 * this list first, that false match let a crypto or orchestrator file skip
 * the non-author review entirely. A path must match a `TIER1_PATHS` entry
 * because it IS that directory's descendant, or literally IS that root
 * file — never because the entry's text merely appears somewhere in the
 * path string. The anchoring itself stays correct regardless of which
 * files currently populate the list — this is what makes it safe for
 * `TIER1_PATHS` to keep shrinking without a matching change here.
 */
function tier1Hit(f: string): string | undefined {
  return TIER1_PATHS.find((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
}

/**
 * Anchored the same way `tier1Hit` is, and for the same reason: every
 * `AGENT_INSTRUCTION_PATHS` entry ends in `/`, so a plain `startsWith` is
 * already a real "is this path under that directory" test with no
 * unanchored-substring risk — no bare-basename branch is needed the way
 * `tier1Hit` needs one for its repo-root file entries (`.editorconfig`,
 * `.gitattributes`).
 */
function agentInstructionHit(f: string): string | undefined {
  return AGENT_INSTRUCTION_PATHS.find((p) => f.startsWith(p))
}

/**
 * One changed file's tier, and why. Order is the whole design:
 *
 * 1. `AGENT_INSTRUCTION_PATHS` and `AGENT_INSTRUCTION_BASENAMES` first,
 *    UNCONDITIONALLY Tier 2 — before anything else gets a chance to read
 *    `docs/superpowers/specs/x.md` as Tier 0 prose (`TIER0_DOC_DIR` is a
 *    `docs/` prefix) or a `.claude/` file as Tier 1 tooling. This is the fix
 *    for the PR #870 finding: paths that define what the fleet's own coding
 *    agents obey must never reach the auto-succeed tiers, checked before
 *    any rule that could otherwise demote them.
 * 2. `TIER1_PATHS` next — data verified to be sourced/evaluated/executed by
 *    nothing in this repo (`.editorconfig`, `.gitattributes` — NOT lint/
 *    format tool config, removed here a second time after PR #870's review
 *    gate caught `eslint.config.js`/`.eslintrc.json`/`.prettierrc*` as a
 *    fail-open; see `TIER1_PATHS`'s own comment). No
 *    `HIGH_IMPACT_PATHS`/secret-pattern entry overlaps a `TIER1_PATHS`
 *    prefix today — pinned by the "never demoted" tests in
 *    `tests/orchestrator/impact.test.ts`, which iterate the real
 *    `HIGH_IMPACT_PATHS`/`SECRET_PATH_PATTERNS` constants (not a hand-copied
 *    duplicate) so a future entry that accidentally gains an overlap fails
 *    the suite immediately.
 * 3. `HIGH_IMPACT_PATHS` and the secret patterns — the Tier 2 "always" list.
 *    Reused wholesale from `classifyImpact` above rather than re-curated:
 *    two lists of "which paths are sensitive" that could drift apart is
 *    exactly the failure mode this project's own comments warn against
 *    elsewhere (see `CRYPTO_REVIEW_PATHS` in review.ts).
 * 4. `TIER0_DOC_DIR`/`.md` — prose.
 * 5. Otherwise Tier 2: the default, for anything unmatched above — an
 *    unknown or unrecognized path defaults to the HIGHEST tier, not the
 *    lowest. "Everything else" in this file's own module comment is not a
 *    residual case handled by falling through with no logic — it is this
 *    line, stated as code.
 */
function tierForFile(f: string): { tier: ImpactTier; reason: string } {
  const instructionHit = agentInstructionHit(f)
  if (instructionHit !== undefined) {
    return { tier: 2, reason: `${f} is Tier 2 (always) — agent-instruction path ${instructionHit}` }
  }
  if (isAgentInstructionFile(f)) {
    return { tier: 2, reason: `${f} is Tier 2 (always) — agent-instruction file (${f.slice(f.lastIndexOf('/') + 1)})` }
  }
  const t1 = tier1Hit(f)
  if (t1 !== undefined) {
    return { tier: 1, reason: `${f} is Tier 1 (instructions/tooling) — under ${t1}` }
  }
  const alwaysHit = HIGH_IMPACT_PATHS.find((p) => f.startsWith(p) || f.includes(`/${p}`))
  if (alwaysHit !== undefined) {
    return { tier: 2, reason: `${f} is Tier 2 (always) — under high-impact path ${alwaysHit}` }
  }
  const secretHit = SECRET_PATH_PATTERNS.find((p) => matchesPath(f, p))
  if (secretHit !== undefined) {
    return { tier: 2, reason: `${f} is Tier 2 (always) — matches secret pattern ${secretHit}` }
  }
  if (isTier0Path(f)) {
    return { tier: 0, reason: `${f} is Tier 0 (no executable content)` }
  }
  return { tier: 2, reason: `${f} is Tier 2 (default) — product code` }
}

export interface TierResult {
  tier: ImpactTier
  /** Explains every file that CONTRIBUTED to the winning tier — not every
   *  changed file. A Tier 0 file sitting alongside the Tier 2 file that
   *  actually decided the outcome would only be noise here. */
  reasons: string[]
}

/**
 * The diff's tier: the HIGHEST tier any changed file touches. A diff with no
 * changed files is Tier 0 — there is nothing to review, which is exactly
 * the "no reviewable content" a Tier 0/1 diff is defined by.
 *
 * The single source of truth for "how much ceremony does this diff earn" —
 * `fleet/review`'s decision step (`decideReviewGate`, ci.ts) is the first
 * consumer; CI's platform path-scoping (`.github/scripts/detect-changed-
 * platforms.sh`) is designed to consume this same function once #862 lands
 * (see that PR's own script — it currently derives its `docs_only`/platform
 * flags from an independent bash regex map, which this comment does not
 * change; unifying a bash script's classification onto a TypeScript
 * function needs that script to shell out to `bun`, which is out of scope
 * for this change and left as a follow-up named in this PR's description).
 */
export function tierFor(changedFiles: string[]): TierResult {
  let tier: ImpactTier = 0
  const perFile = changedFiles.map((f) => ({ file: f, ...tierForFile(f) }))
  for (const p of perFile) {
    if (p.tier > tier) tier = p.tier
  }
  const reasons = perFile.filter((p) => p.tier === tier).map((p) => p.reason)
  return { tier, reasons }
}

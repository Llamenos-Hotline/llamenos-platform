import { describe, it, expect } from 'vitest'
import { classifyImpact, tierFor, TIER1_PATHS, AGENT_INSTRUCTION_PATHS } from '../../orchestrator/src/impact.js'
import { NEVER_WRITE_PATHS, SECRET_PATH_PATTERNS } from '../../orchestrator/src/config.js'

/**
 * Builds a realistic changed-file path for a `matchesPath`/glob pattern so
 * pattern-driven tests below don't need a hand-maintained example per entry
 * — a future addition to SECRET_PATH_PATTERNS is covered automatically.
 * `*` becomes a plausible filename fragment; a bare basename pattern (no
 * `/`) is nested a couple of directories deep to also exercise the
 * basename-matches-at-any-depth behavior `matchesPath` implements.
 */
function realisticPathFor(pattern: string): string {
  const filename = pattern.includes('*') ? pattern.replaceAll('*', 'example-secret') : pattern
  return pattern.includes('/') ? filename : `some/nested/dir/${filename}`
}

describe('classifyImpact', () => {
  it('treats ordinary code as low impact', () => {
    expect(classifyImpact(['src/client/components/Button.tsx'], 20).impact).toBe('low')
  })

  it.each([
    ['packages/crypto/src/hpke.rs'],
    ['packages/protocol/schemas/note.ts'],
    ['packages/protocol/crypto-labels.json'],
    ['apps/worker/lib/auth.ts'],
    ['apps/android/keystore.properties'],
    ['orchestrator/src/tick.ts'],
    ['tests/orchestrator/impact.test.ts'],
  ])('treats %s as high impact', (f) => {
    expect(classifyImpact([f], 5).impact).toBe('high')
  })

  it.each([
    // The orchestrator's own trust base: the fragments that define lane write
    // scope, and the settings file enforcing the write-deny hook.
    ['.claude/agents/fragments/backend.md'],
    ['.claude/settings.json'],
    // sigchain schema/routes — state a revert does not restore. The real
    // tracked file: this used to read `.../sigchain/devices.ts`, a path that
    // has never existed, and it passed anyway because HIGH_IMPACT_PATHS
    // carried the bare prefix `apps/worker/db/schema/sigchain` that
    // `startsWith` matched. Both are the exact file now, and guards.test.ts
    // fails if it ever stops existing without both lists being updated.
    ['apps/worker/db/schema/sigchain.ts'],
    // Middleware and the auth/crypto route and lib surface.
    ['apps/worker/middleware/rate-limit.ts'],
    ['apps/worker/routes/auth.ts'],
    ['apps/worker/routes/sessions.ts'],
    ['apps/worker/routes/webauthn.ts'],
    ['apps/worker/lib/crypto.ts'],
    ['apps/worker/lib/hub-event-crypto.ts'],
    ['apps/worker/lib/push-encryption.ts'],
    ['apps/worker/lib/server-identity.ts'],
    ['apps/worker/lib/agent-identity.ts'],
    ['apps/worker/lib/timing-safe.ts'],
    ['apps/worker/lib/blind-index-query.ts'],
    ['apps/worker/services/crypto-keys.ts'],
    // Shared crypto labels.
    ['packages/shared/crypto-labels.ts'],
    // Key-boundary wrapper paths (restored 2026-09-12 — see impact.ts's
    // CORRECTED comment): not the crypto crate itself, but the surfaces that
    // keep a device private key from leaking — the webview IPC boundary, the
    // Tauri permission grants, and the iOS/Android Keychain/Keystore
    // wrappers. A quiet mistake in any of these is an identity disclosure,
    // which is the high-impact criterion — unrelated to deployment risk, so
    // "no production users yet" never relaxes it.
    ['src/client/lib/platform.ts'],
    ['apps/desktop/src/crypto.rs'],
    ['apps/desktop/capabilities/default.json'],
    ['apps/ios/Sources/Services/CryptoService.swift'],
    ['apps/android/app/src/main/java/org/llamenos/hotline/crypto/CryptoService.kt'],
  ])('treats %s as high impact', (f) => {
    expect(classifyImpact([f], 5).impact).toBe('high')
  })

  // Widened 2026-09-13 (PR #794) to match what CODEOWNERS actually enforces:
  // the whole `.github/workflows/` directory (not just `ci.yml`), plus
  // `knope.toml` (release automation — a supply-chain surface, independent
  // of user count) and the deanonymization surfaces `sip-bridge/` and
  // `signal-notifier/` (caller phone numbers / HMAC-hashed contacts). Not
  // narrowed with the no-users-yet argument: these protect identity and the
  // supply chain, not deployment risk.
  it.each([
    ['.github/workflows/e2e-docker.yml'],
    ['knope.toml'],
    ['sip-bridge/src/ari-adapter.ts'],
    ['signal-notifier/src/contact-resolver.ts'],
    // The security-sensitive subset of `scripts/` (#1066): the infra lane may
    // write scripts/, so these must still reach a human — matching CODEOWNERS.
    ['scripts/bootstrap-admin.ts'],
    ['scripts/release/sign-artifacts.sh'],
    ['scripts/release/promote-release.sh'],
    ['scripts/build-iso.sh'],
    ['scripts/iso-builder/late-command.sh'],
    ['scripts/verify-build.sh'],
    ['scripts/verify-iso.sh'],
    ['scripts/generate-update-manifest.sh'],
    ['scripts/generate-update-manifest.ts'],
    ['scripts/inject-cert-pins.ts'],
    ['scripts/extract-cert-pins.sh'],
    // The gate scripts under `scripts/` (#1087): whatever's exit status is a
    // check's verdict. Weakening any of these lets a defect through a check.
    ['scripts/check-ipc-allowlist.sh'],
    ['scripts/check-ecies-active.sh'],
    ['scripts/check-label-count.sh'],
    ['scripts/check-migration-drift.ts'],
    ['scripts/check-migration-drift.sh'],
    ['scripts/typecheck-tests-gate.ts'],
    ['scripts/eslint-rules/no-inline-api-shape.js'],
    ['scripts/regenerate-snapshot.ts'],
    ['scripts/image-smoke.sh'],
    ['scripts/verify-runtime.ts'],
    ['scripts/run-migrations.ts'],
    ['scripts/test-orchestrator.sh'],
    ['scripts/test-fleet.sh'],
    ['scripts/test-backend-bdd.sh'],
    ['scripts/test-integration-full.sh'],
    ['scripts/android-parallel-e2e.sh'],
    ['scripts/lib/platform-detect.sh'],
    ['scripts/lib/test-reporter.sh'],
  ])('treats %s as high impact', (f) => {
    expect(classifyImpact([f], 5).impact).toBe('high')
  })

  // Boundary-exact: ONLY `apps/desktop/src/crypto.rs` is restored above, not
  // the whole `apps/desktop/src/` directory — an ordinary desktop source file
  // stays low impact.
  // Boundary-exact for scripts/ too: only the listed subsets are high impact.
  // Dev, setup and build helpers — which enforce no check — are ordinary
  // infra-lane work and merge on green.
  it.each([
    ['scripts/dev-setup.sh'],
    ['scripts/dev-bun.sh'],
    ['scripts/setup-android-sdk.sh'],
    ['scripts/update-image-digests.sh'],
  ])('does not escalate ordinary scripts/ file %s', (f) => {
    expect(classifyImpact([f], 5).impact).toBe('low')
  })

  it('does not escalate an ordinary desktop source file that is not the crypto IPC wrapper', () => {
    expect(classifyImpact(['apps/desktop/src/main.rs'], 5).impact).toBe('low')
  })

  // NARROWED 2026-09-12 (impact.ts's dated comment): no production users
  // exist yet, so these no longer always-human-gate — the deterministic
  // gates (scope, diff-targeted tests, non-author review, verified-SHA pin)
  // are the decision. Must move back to "high impact" above once the first
  // internal testers are onboarded.
  it.each([
    ['apps/worker/db/migrations/0042_x.sql'],
    ['drizzle/migrations/0001_init.sql'],
    ['packages/shared/migrations/0002_x.sql'],
    ['apps/worker/db/schema/users.ts'],
    // `.github/workflows/ci.yml` and `knope.toml` used to be in this list.
    // Every workflow and knope.toml are HIGH impact now, matching CODEOWNERS
    // (PR #794): the gate's own definition and the release supply chain are
    // the machinery that judges and ships every other PR. Asserted in
    // guards.test.ts instead.
    ['deploy/helm/llamenos/values.yaml'],
    ['apps/ios/fastlane/Fastfile'],
    ['apps/android/fastlane/Fastfile'],
    ['apps/desktop/tauri.conf.json'],
    ['packages/protocol/tools/codegen.ts'],
    // `scripts/inject-cert-pins.ts`, `scripts/extract-cert-pins.sh` and
    // `scripts/verify-build.sh` used to be in this list too. They were safe
    // to narrow while no lane could write `scripts/` at all; #1066 gave it to
    // the infra lane, so they are CODEOWNERS-owned and HIGH impact again —
    // asserted with the rest of the scripts/ subset above.
    ['Dockerfile.build'],
  ])('treats %s as low impact (narrowed 2026-09-12 — no production users yet)', (f) => {
    expect(classifyImpact([f], 5).impact).toBe('low')
  })

  it('escalates on a large file count regardless of content', () => {
    const files = Array.from({ length: 41 }, (_, i) => `src/client/x${i}.ts`)
    const r = classifyImpact(files, 100)
    expect(r.impact).toBe('high')
    expect(r.reasons.join(' ')).toMatch(/41 files/)
  })

  it('escalates on a large line count regardless of content', () => {
    const r = classifyImpact(['src/client/a.ts'], 1501)
    expect(r.impact).toBe('high')
    expect(r.reasons.join(' ')).toMatch(/1501 lines/)
  })

  it('gives a reason for every high-impact verdict', () => {
    expect(classifyImpact(['packages/crypto/src/lib.rs'], 5).reasons.length).toBeGreaterThan(0)
  })

  // G2: boundary-exact tests, so a `>` -> `>=` refactor cannot pass silently.
  it('stays low at exactly the file-count threshold, and escalates one file past it', () => {
    const atThreshold = Array.from({ length: 40 }, (_, i) => `src/client/x${i}.ts`)
    expect(classifyImpact(atThreshold, 100).impact).toBe('low')

    const overThreshold = Array.from({ length: 41 }, (_, i) => `src/client/x${i}.ts`)
    expect(classifyImpact(overThreshold, 100).impact).toBe('high')
  })

  it('stays low at exactly the line-count threshold, and escalates one line past it', () => {
    expect(classifyImpact(['src/client/a.ts'], 1500).impact).toBe('low')
    expect(classifyImpact(['src/client/a.ts'], 1501).impact).toBe('high')
  })
})

describe('classifyImpact — secrets always classify high', () => {
  // Every pattern in SECRET_PATH_PATTERNS (config.ts) must classify as high
  // impact, iterated from the real constant so a future addition is covered
  // without a new test.
  it.each(SECRET_PATH_PATTERNS)('treats a file matching secret pattern %s as high impact', (pattern) => {
    const file = realisticPathFor(pattern)
    const result = classifyImpact([file], 5)
    expect(result.impact).toBe('high')
    expect(result.reasons.join(' ')).toMatch(new RegExp(`matches secret pattern`))
  })

  // Guard against the two gates drifting apart again: everything checkScope
  // refuses to write (NEVER_WRITE_PATHS) must also be high-impact here.
  // Iterates the real, currently-configured constants — not a hardcoded
  // copy — so it fails the moment someone adds a never-write pattern without
  // making classifyImpact aware of it.
  it.each(NEVER_WRITE_PATHS)('never-write pattern %s is also high-impact (gates must not drift)', (pattern) => {
    const file = realisticPathFor(pattern)
    expect(classifyImpact([file], 5).impact).toBe('high')
  })

  // The twelve-path probe from the security review: every one is a
  // never-write secret, but before this fix, most classified low because
  // HIGH_IMPACT_PATHS only caught them incidentally via an unrelated
  // directory prefix (apps/ios/fastlane/, deploy/, or the android keystore
  // dir) rather than because they are secrets.
  it.each([
    'apps/android/app/release.jks',
    'apps/android/upload.keystore',
    'apps/ios/fastlane/AuthKey_ABC123.p8',
    'apps/ios/certs/dist.p12',
    'certs/server.pem',
    'deploy/secrets/tls.key',
    '.env',
    'apps/worker/config/.env',
    'apps/android/keystore.properties',
    'id_ed25519',
    '.npmrc',
    'authorized_keys',
  ])('probe path %s classifies high', (file) => {
    expect(classifyImpact([file], 5).impact).toBe('high')
  })
})

describe('tierFor', () => {
  it('classifies documentation prose as Tier 0', () => {
    expect(tierFor(['docs/epics/EP01-foo.md']).tier).toBe(0)
    expect(tierFor(['README.md']).tier).toBe(0)
    expect(tierFor(['apps/worker/README.md']).tier).toBe(0)
  })

  it('an empty diff is Tier 0 — there is nothing to review', () => {
    const r = tierFor([])
    expect(r.tier).toBe(0)
    expect(r.reasons).toEqual([])
  })

  // Only data verified to be sourced/evaluated/executed by NOTHING in this
  // repo remains Tier 1 after PR #870's SECOND fix — `.claude/agents/`,
  // `.claude/skills/`, `docs/superpowers/specs/`, and `lefthook.yml` (first
  // fix) plus every lint/format tool config (second fix, below) are all
  // asserted Tier 2 further down, not here.
  it.each([
    '.editorconfig',
    '.gitattributes',
  ])('classifies %s as Tier 1 (verified inert — sourced/evaluated by nothing in this repo)', (f) => {
    expect(tierFor([f]).tier).toBe(1)
  })

  // PR #870's SECOND fix: `eslint.config.js`/`.ts` are literal JavaScript a
  // lint CI step `import()`s and executes; the JSON/plain variants are not
  // code but ARE sourced and evaluated by that same step (resolving
  // `"extends"`/`"plugins"`, applying `"rules"`), so a diff touching only
  // one of them could silently disable the lint gate with zero review —
  // none of these seven paths has ever had a CODEOWNERS line (verified
  // against the tracked `CODEOWNERS` file). All seven must default to Tier
  // 2 now, the same as any other unmatched path — this is the regression
  // test for the finding itself, not just a coverage check.
  it.each([
    'eslint.config.js',
    'eslint.config.ts',
    '.eslintrc.json',
    '.eslintrc.js',
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
  ])('%s is Tier 2 (default) — lint/format tool config can alter what a gate enforces, never auto-succeeds', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })

  // Standing rail (not a one-off): no path whose extension is ever executed
  // or `import()`-ed by Node/Bun tooling can land in the auto-succeed tiers
  // (0 or 1), regardless of directory. This is deliberately broader than
  // just "today's TIER1_PATHS members" — it also guards `isTier0Path` and
  // any future rule this file gains, so the next widening (of EITHER tier)
  // trips this test rather than the live gate the way it did twice already.
  const EXECUTABLE_EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts', '.sh', '.py', '.rb']
  it.each(EXECUTABLE_EXTENSIONS)(
    'no path ending in %s can ever classify below Tier 2, at any depth',
    (ext) => {
      const rootFile = `some-config${ext}`
      const nestedFile = `some/nested/dir/some-config${ext}`
      for (const f of [rootFile, nestedFile]) {
        const tier = tierFor([f]).tier
        expect(tier, `${f} classified Tier ${tier}, expected Tier 2`).toBe(2)
      }
    },
  )

  // The list itself, not just tierFor's behavior on hand-picked examples —
  // fails immediately if ANY future entry is added to TIER1_PATHS with an
  // executable (or otherwise CI-sourced/evaluated) extension, without
  // needing a new hardcoded example above to catch it.
  it('TIER1_PATHS admits no executable extension — the auto-succeed tier can only ever hold inert data', () => {
    for (const p of TIER1_PATHS) {
      const hasExecutableExtension = EXECUTABLE_EXTENSIONS.some((ext) => p.endsWith(ext))
      expect(hasExecutableExtension, `${p} has an executable extension and must not be in TIER1_PATHS`).toBe(false)
    }
  })

  // A `.md` file under `.claude/` is instruction text a coding agent obeys,
  // not prose a human reads — it must never fall through to Tier 0 by
  // extension alone, and (post PR #870 fix) never fall through to Tier 1
  // either: it is Tier 2, unconditionally, via `AGENT_INSTRUCTION_PATHS`.
  it('classifies a .claude/ markdown file as Tier 2, never Tier 0 or Tier 1', () => {
    expect(tierFor(['.claude/CLAUDE.md']).tier).toBe(2)
  })

  it.each([
    'src/client/components/Button.tsx',
    'apps/worker/routes/notes.ts',
    'apps/ios/Sources/Views/CallView.swift',
  ])('classifies ordinary product code %s as Tier 2 (default)', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })

  // The Tier 2 "always" list, reused wholesale from HIGH_IMPACT_PATHS
  // (impact.ts's own comment on `tierForFile`'s ordering) — hardcoded
  // examples, not an `it.each(HIGH_IMPACT_PATHS)` iteration, specifically so
  // a mutation that DELETES an entry from that list (e.g. "move
  // packages/crypto/ out of Tier 2") is still caught: iterating the live
  // list would just iterate over fewer entries and silently stop testing
  // the deleted one.
  it.each([
    'packages/crypto/src/hpke.rs',
    'packages/protocol/schemas/note.ts',
    'apps/worker/lib/auth.ts',
    'apps/worker/routes/sessions.ts',
    'orchestrator/src/tick.ts',
    'tests/orchestrator/impact.test.ts',
    '.github/workflows/ci.yml',
    'package.json',
    'bun.lockb',
    'knope.toml',
    'sip-bridge/src/ari-adapter.ts',
    'signal-notifier/src/contact-resolver.ts',
  ])('a Tier 2 path can never be classified lower: %s stays Tier 2', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })

  // PR #870's fix: every path that can alter what the fleet's own coding
  // agents OBEY is Tier 2, unconditionally — the auto-succeed tiers (0/1)
  // must be unreachable for these regardless of file extension or nesting.
  // Includes nested subdirectories under `.claude/` that are neither
  // `agents/` nor `skills/` (`.claude/coordination/`, tracked today) to
  // prove the fix is a blanket `.claude/` prefix, not a re-curated pair of
  // narrower ones that could miss a new subdirectory.
  it.each([
    '.claude/agents/backend-supervisor.md',
    '.claude/agents/fragments/_worker-rules.md',
    '.claude/skills/fleet-review-and-merge/SKILL.md',
    '.claude/coordination/contracts/README.md',
    '.claude/settings.json',
    '.claude/hookify.i18n-camelcase-keys.local.md',
    'docs/superpowers/specs/2026-09-19-impact-tiers-addendum.md',
    'lefthook.yml',
  ])('agent-instruction/gating path %s is Tier 2 (always) — never auto-succeeds', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })

  // The specific CLAUDE.md gap PR #870's review caught: a file named exactly
  // CLAUDE.md/AGENTS.md/GEMINI.md, at ANY depth — not just `.claude/` — must
  // never read as Tier 0 prose by its `.md` extension. Includes a per-package
  // CLAUDE.md (packages/crypto/CLAUDE.md is tracked today) to prove the
  // basename check is not root-only.
  it.each([
    'CLAUDE.md',
    'packages/crypto/CLAUDE.md',
    'apps/worker/CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    'some/deeply/nested/dir/CLAUDE.md',
  ])('agent-instruction file %s is Tier 2 (always), never Tier 0 by its .md extension', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })

  // Every SECRET_PATH_PATTERNS entry (config.ts) is also Tier 2 — the same
  // "the two gates must not disagree about secrets" invariant classifyImpact
  // already enforces, extended to the tier axis.
  it.each(SECRET_PATH_PATTERNS)('a file matching secret pattern %s is Tier 2', (pattern) => {
    expect(tierFor([realisticPathFor(pattern)]).tier).toBe(2)
  })

  // `.claude/agents/` and `lefthook.yml` used to be members of BOTH
  // `HIGH_IMPACT_PATHS` and `TIER1_PATHS`, and the two axes disagreed on
  // purpose — Tier 1 won for the tier question. PR #870's fix removed both
  // from `TIER1_PATHS`: the axes now AGREE for these two paths, both
  // reading Tier 2 (always) via `HIGH_IMPACT_PATHS` (`lefthook.yml`) or
  // `AGENT_INSTRUCTION_PATHS` (`.claude/agents/`) respectively.
  it.each(['.claude/agents/backend-supervisor.md', 'lefthook.yml'])(
    '%s is high-impact (classifyImpact) AND Tier 2 (tierFor) — no axis disagreement for the fleet trust base',
    (f) => {
      expect(classifyImpact([f], 5).impact).toBe('high')
      expect(tierFor([f]).tier).toBe(2)
    },
  )

  // Regression for a fail-open a review gate caught on PR #870: `tier1Hit`
  // used to match a `TIER1_PATHS` basename anywhere in the path
  // (`f.includes(\`/${p}\`)`), so a file that merely ENDS with a Tier 1
  // filename — while actually living under a Tier 2 "always" directory —
  // classified as Tier 1 and skipped the non-author review entirely. Both
  // examples are real Tier 2 directories (`packages/crypto/`,
  // `orchestrator/`) paired with the CURRENT real TIER1_PATHS basenames
  // (`.editorconfig`, `.gitattributes` — updated from the original
  // `eslint.config.js`/`.eslintrc.json` examples when PR #870's SECOND fix
  // removed those from `TIER1_PATHS` entirely) that are ONLY meant to match
  // at the repo root. Neither path is a tracked file today — this asserts
  // the classifier's behavior on a hypothetical path, not file existence.
  it.each(['packages/crypto/.editorconfig', 'orchestrator/src/.gitattributes'])(
    '%s stays Tier 2 (always) — a Tier 1 basename match must not shadow the directory it lives under',
    (f) => {
      expect(tierFor([f]).tier).toBe(2)
    },
  )

  it('a diff spanning tiers takes the HIGHEST tier it touches', () => {
    const mixed = tierFor(['docs/readme.md', '.claude/agents/backend-supervisor.md', 'packages/crypto/src/lib.rs'])
    expect(mixed.tier).toBe(2)
    expect(mixed.reasons.join(' ')).toMatch(/packages\/crypto/)
    // The Tier 0 file did not decide the outcome — it is not named in the
    // winning reasons. (`.claude/agents/...` is ALSO Tier 2 post-fix, so it
    // legitimately co-decides the outcome alongside packages/crypto/ — see
    // the dedicated Tier-0-vs-Tier-2 case below for a clean two-file split.)
    expect(mixed.reasons.join(' ')).not.toMatch(/docs\/readme\.md/)

    // Post PR #870 fix: `.claude/agents/...` is Tier 2, not Tier 1, so
    // mixing it with a Tier 0 doc file now reaches Tier 2 — the property
    // this test asserts (highest tier wins) still holds, just with a
    // different highest tier than before the fix.
    const tier2AndTier0 = tierFor(['docs/readme.md', '.claude/agents/backend-supervisor.md'])
    expect(tier2AndTier0.tier).toBe(2)

    // The genuinely-Tier-1 case: verified-inert data mixed with docs prose
    // still tops out at Tier 1, never escalating to 2 on its own.
    const tier1AndTier0 = tierFor(['docs/readme.md', '.editorconfig'])
    expect(tier1AndTier0.tier).toBe(1)
  })

  it('gives a reason naming every file that contributed to the winning tier', () => {
    const r = tierFor(['packages/crypto/src/a.rs', 'apps/worker/lib/auth.ts'])
    expect(r.tier).toBe(2)
    expect(r.reasons).toHaveLength(2)
  })

  // Every TIER1_PATHS entry must actually match a realistic path under it —
  // same discipline as the HIGH_IMPACT_PATHS/CODEOWNERS coverage rail in
  // guards.test.ts, applied to the new list.
  it.each(TIER1_PATHS)('TIER1_PATHS entry %s matches a realistic path under it', (p) => {
    const file = p.endsWith('/') ? `${p}example.md` : p
    expect(tierFor([file]).tier).toBe(1)
  })

  // Every AGENT_INSTRUCTION_PATHS entry must actually match a realistic
  // path under it, and that path must be Tier 2 — same discipline as
  // TIER1_PATHS's own coverage test above, applied to the new list.
  it.each(AGENT_INSTRUCTION_PATHS)('AGENT_INSTRUCTION_PATHS entry %s matches a realistic path under it, at Tier 2', (p) => {
    const file = `${p}example.md`
    expect(tierFor([file]).tier).toBe(2)
  })

  // Requirement (a): a diff touching `.claude/` or `docs/superpowers/specs/`
  // can never reach the auto-succeed tier (0 or 1) — the exact PR #870
  // finding, asserted directly against every tier value rather than just
  // checking `=== 2`, so a future third tier added below 2 could not sneak
  // one of these paths into it without failing here.
  it.each([
    '.claude/agents/x.md',
    '.claude/skills/y/SKILL.md',
    '.claude/coordination/z.md',
    '.claude/settings.json',
    '.claude/anything-not-yet-invented/w.md',
    'docs/superpowers/specs/2026-01-01-whatever.md',
  ])('%s can never classify below Tier 2 (the auto-succeed tiers are unreachable)', (f) => {
    const tier = tierFor([f]).tier
    expect(tier).not.toBe(0)
    expect(tier).not.toBe(1)
    expect(tier).toBe(2)
  })

  // Requirement (b): an unknown/unmatched path defaults to the HIGHEST
  // tier, not the lowest. None of these hit any named list in impact.ts —
  // not `.claude/`, not `docs/`, not `.md`, not any HIGH_IMPACT_PATHS or
  // TIER1_PATHS prefix, not a secret pattern — so they exercise the literal
  // fallthrough at the bottom of `tierForFile`. A change to that default
  // (e.g. "unrecognized paths are Tier 0 unless proven otherwise") is
  // exactly the fail-open this test exists to catch.
  it.each([
    'some/brand/new/unrecognized-directory/File.xyz',
    'a-top-level-file-nobody-has-invented-yet.bin',
    'totally/unknown/path/structure/here',
  ])('unmatched path %s defaults to Tier 2 (highest), never Tier 0 or 1', (f) => {
    expect(tierFor([f]).tier).toBe(2)
  })
})

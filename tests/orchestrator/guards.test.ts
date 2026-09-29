import { describe, it, expect, afterEach, vi } from 'vitest'
import { LANES, NEVER_WRITE_PATHS, loadLanes, readLaneModes, assertLiveLanesHaveScope } from '../../orchestrator/src/config.js'
import { classifyImpact, HIGH_IMPACT_PATHS } from '../../orchestrator/src/impact.js'
import { checkScope } from '../../orchestrator/src/scope.js'
import { haltedOnGitHubFrom } from '../../orchestrator/src/killswitch.js'
import { codeownersMatcher, codeownersPatterns, trackedFiles, trackedFilesUnder } from './codeowners.js'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  runReviewCi, decideReviewGate,
  isRepublishOnlyEvent, reviewRequestFor, reviewRequestEventFromEnv, REVIEW_REQUEST_LOGIN,
  type CiContext, type ReviewCiDeps, type ReviewSetDecision,
} from '../../orchestrator/src/ci.js'
import { DEFAULT_MAX_TURNS, HIGH_IMPACT_MAX_TURNS, DEFAULT_TIMEOUT_MS, HIGH_IMPACT_TIMEOUT_MS } from '../../orchestrator/src/review.js'
import { diffHash, cacheArtifactName, type ReviewCache, type CachedVerdict, type ReviewCacheKey } from '../../orchestrator/src/review-cache.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

describe('rail: a live lane must have a write scope', () => {
  // Asserted against a synthetic lane, not the live config: every configured
  // lane defaults to `off`, so looping over them would execute no assertion at
  // all — a test that passes by never running its check.
  it('throws rather than running a live lane with an empty scope', () => {
    expect(() => assertLiveLanesHaveScope([{
      id: 'ios', mode: 'live', cap: 1, engine: 'claude',
      requireLabel: 'agent-dispatchable', vetoLabels: [],
      scope: { owned: [], notOwned: [] },
    }])).toThrow()
  })

  it('parses a non-empty scope for every configured lane', async () => {
    // Point lane modes at a fixture that cannot exist, rather than the real
    // ~/.llamenos-fleet/lanes.json: this test asserts fragment PARSING, not
    // anything about live/shadow state, and reading the operator's actual
    // runtime state would make the test's outcome depend on whatever that
    // machine happens to have turned on (e.g. assertLiveLanesHaveScope
    // throwing for a real live lane, for reasons unrelated to what this test
    // checks).
    const lanes = await loadLanes(process.cwd(), '/nonexistent/fixture-lanes.json')
    for (const l of lanes) {
      expect(l.scope.owned.length, `lane ${l.id} parsed no owned paths from its fragment`).toBeGreaterThan(0)
    }
  })
})

describe('rail: the fleet cannot merge its own changes', () => {
  it('classifies orchestrator source as high impact', () => {
    expect(classifyImpact(['orchestrator/src/tick.ts'], 1).impact).toBe('high')
  })
  it('classifies its own tests as high impact', () => {
    expect(classifyImpact(['tests/orchestrator/guards.test.ts'], 1).impact).toBe('high')
  })

  // `classifyImpact` only DESCRIBES a diff now — it gated nothing that
  // anything outside this process ever saw. The gate is GitHub's own
  // "require review from Code Owners" rule over CODEOWNERS, so the property
  // that has to hold is about REAL FILES, not about two lists of strings
  // agreeing with each other.
  //
  // The previous version of this test compared patterns with `startsWith`,
  // and passed on a CODEOWNERS in which sixteen of the auth/session/identity
  // rules matched nothing whatsoever: CODEOWNERS is gitignore syntax, where
  // `apps/worker/lib/auth` means a file NAMED `auth`, not `auth.ts`. The
  // string check could not see that, because a string check can only tell you
  // two lists agree — never that either one means anything. These two assert
  // against `git ls-files` with the same matcher GitHub uses.
  it('every HIGH_IMPACT_PATH matches at least one tracked file — a gate over nothing is not a gate', () => {
    const files = trackedFiles()
    for (const p of HIGH_IMPACT_PATHS) {
      expect(trackedFilesUnder(p, files).length, `HIGH_IMPACT_PATHS entry "${p}" matches no tracked file`)
        .toBeGreaterThan(0)
    }
  })

  it('CODEOWNERS owns every tracked file under every HIGH_IMPACT_PATH, by gitignore semantics', () => {
    const files = trackedFiles()
    const owner = codeownersMatcher()
    const unowned: string[] = []
    for (const p of HIGH_IMPACT_PATHS) {
      for (const f of trackedFilesUnder(p, files)) {
        if (!owner.owns(f)) unowned.push(`${f} (under ${p})`)
      }
    }
    expect(unowned, `high-impact files with no CODEOWNERS owner:\n${unowned.join('\n')}`).toEqual([])
  })

  // fleet/verify's judge is vitest's MAIN process, and that process executes
  // the config. A root vitest config added later must be owned and described
  // as high-impact from its first commit — not once someone remembers.
  it('every root vitest config is code-owned and high impact', () => {
    const configs = trackedFiles().filter((f) => /^vitest\.[^/]+\.config\.ts$/.test(f))
    expect(configs).toContain('vitest.orchestrator.config.ts')
    expect(configs).toContain('vitest.unit.config.ts')
    const owner = codeownersMatcher()
    for (const f of configs) {
      expect(owner.owns(f), `${f} has no CODEOWNERS owner`).toBe(true)
      expect(HIGH_IMPACT_PATHS, `${f} is missing from HIGH_IMPACT_PATHS`).toContain(f)
    }
  })

  // #1087: `scripts/` is the infra lane's to write, so every script that
  // ENFORCES a check must still reach a human — a lane that can weaken the
  // gate judging it can widen its own authority. CODEOWNERS owns the
  // `check-*` and `test-*.sh` families as globs so a new one is owned from its
  // first commit; this pins that each such file is also described as high
  // impact, and that the named gates stay owned by name.
  it('every scripts/ gate — check-*, test-*.sh and the named gates — is code-owned and high impact', () => {
    const files = trackedFiles()
    const family = files.filter((f) => /^scripts\/(check-[^/]+|test-[^/]+\.sh)$/.test(f))
    expect(family).toContain('scripts/check-ipc-allowlist.sh')
    expect(family).toContain('scripts/test-orchestrator.sh')
    const named = [
      'scripts/typecheck-tests-gate.ts',
      'scripts/run-migrations.ts',
      'scripts/eslint-rules/no-inline-api-shape.js',
      'scripts/regenerate-snapshot.ts',
      'scripts/image-smoke.sh',
      'scripts/verify-runtime.ts',
      'scripts/lib/test-reporter.sh',
    ]
    const owner = codeownersMatcher()
    for (const f of [...family, ...named]) {
      expect(files, `${f} is not a tracked file`).toContain(f)
      expect(owner.owns(f), `${f} has no CODEOWNERS owner`).toBe(true)
      expect(classifyImpact([f], 1).impact, `${f} is not high impact`).toBe('high')
    }
    for (const f of family) {
      expect(HIGH_IMPACT_PATHS, `${f} is missing from HIGH_IMPACT_PATHS`).toContain(f)
    }
  })

  it('has no catch-all `*` rule — one would gate every PR and stop the fleet merging anything', () => {
    expect(codeownersPatterns()).not.toContain('*')
  })
})

/**
 * A grep, deliberately, and the ONE place in this suite where that is the
 * right instrument: it guards a property of the ARGV, of which there is no
 * behaviour to assert beyond "nobody wrote the flag".
 *
 * Two invariants, both true of this repo today:
 *   - the fleet never bypasses a PR's checks. No `--admin`, no `--force`, no
 *     `--bypass`, anywhere under `orchestrator/`. The operator's standing
 *     rule is per-command: nothing bypasses checks unless they say so, for
 *     that command.
 *   - the fleet never posts a GitHub REVIEW. `postReview` records the
 *     non-author verdict as a COMMENT; an approving review is one ruleset
 *     edit away from being an approval the fleet grants itself.
 *
 * `--match-head-commit` is not mentioned here at all any more: `mergePr` and
 * its pin are gone, because the fleet no longer merges anything. What
 * replaced the pin is a property of the platform — a check run attaches to
 * ONE commit, so a push moves the head and the new head carries no green
 * `fleet/verify` or `fleet/review` of its own. See the merge-call block
 * below for what does remain.
 */
describe('rail: the fleet never bypasses a PR\'s checks, and never reviews', () => {
  function orchestratorSources(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts')) out.push({ file: full, text: readFileSync(full, 'utf8') })
      }
    }
    walk(join(process.cwd(), 'orchestrator', 'src'))
    return out
  }

  it('finds orchestrator sources to scan at all — the grep must not pass vacuously', () => {
    expect(orchestratorSources().length).toBeGreaterThan(10)
  })

  const GH_CALL = /gh\(\s*\[[^\]]*\]/g
  const ghCalls = (text: string): string[] => text.match(GH_CALL) ?? []

  /**
   * Whole-file, NOT scoped to a `gh([...])` literal. A scan that only reads
   * literal argv arrays is evaded by hoisting one:
   *
   *     const args = ['pr', 'merge', pr, '--admin']
   *     await gh(args)
   *
   * None of these strings has any legitimate reason to appear anywhere under
   * `orchestrator/src` — not in argv, not in a variable, not in prose — so
   * the file text is the right granularity and there is no false positive to
   * trade away for it. `--approve`/`--request-changes` are here for the same
   * reason: the fleet records the non-author verdict as a COMMENT, and an
   * approving review is one ruleset edit from being an approval it grants
   * itself.
   */
  const FORBIDDEN_ANYWHERE = ['--admin', '--bypass', '--approve', '--request-changes']

  it('contains no bypass or review flag anywhere, however the argv is built', () => {
    for (const { file, text } of orchestratorSources()) {
      for (const flag of FORBIDDEN_ANYWHERE) {
        expect(text, `${file} contains ${flag}`).not.toContain(flag)
      }
    }
  })

  /**
   * The fleet must never ask "who am I?" and compare that to a PR's author.
   *
   * This is not hypothetical tidiness — it encodes a decision already taken
   * twice. A proposal to "verify unless the author is the human owner" was
   * rejected because the fleet pushed with the operator's own account, so
   * author login could not discriminate anything. Now the opposite holds:
   * the fleet authors as a dedicated machine user and the sole code owner
   * approves, because GitHub forbids self-approval. Either way, an identity
   * check here would be wrong — and in the second arrangement it would
   * silently do the wrong thing rather than fail.
   *
   * Authors ARE read (`PrFacts.reviews`), but only to render; nothing
   * compares them. These are the calls that would introduce a self-identity
   * to compare against.
   */
  it('never resolves its own GitHub identity', () => {
    for (const { file, text } of orchestratorSources()) {
      // Argv-aware rather than literal-string: `'api', 'user'` with the exact
      // spacing was trivially evaded by `gh(['api','/user'])`. Any `user`
      // path segment inside a gh call is the thing to catch, however spaced
      // or quoted.
      for (const call of ghCalls(text)) {
        for (const seg of ["'user'", '"user"', "'/user'", '"/user"']) {
          expect(call, `${file}: gh call resolves the authenticated user (${seg})`).not.toContain(seg)
        }
      }
      // GraphQL's `viewer` has no other meaning in this codebase, so the bare
      // word is forbidden outright — no construction evades it.
      expect(text, `${file} uses the GraphQL viewer (self) field`).not.toMatch(/\bviewer\b/)
    }
  })

  it('finds gh calls to scan — the grep must not pass vacuously', () => {
    const total = orchestratorSources().reduce((n, { text }) => n + ghCalls(text).length, 0)
    expect(total).toBeGreaterThan(5)
  })

  // `--force` is the one that CANNOT be whole-file: `git worktree remove
  // --force` is a legitimate, unrelated use, and a rail that fires on correct
  // code gets trained away rather than fixed. Scoped to gh argv, where it
  // would mean force-pushing or forcing a merge.
  it('passes no --force to gh', () => {
    for (const { file, text } of orchestratorSources()) {
      for (const call of ghCalls(text)) {
        expect(call, `${file}: gh call passes --force`).not.toContain('--force')
      }
    }
  })

  /**
   * `mergePr` and its `--match-head-commit` pin are gone from the AUTONOMOUS
   * fleet: `tick.ts`'s own dispatch loop still never merges anything itself.
   * What replaced the pin is a property of the platform — a check run is
   * attached to ONE commit, so a push moves the head and the new head
   * carries no green `fleet/verify` or `fleet/review` of its own, and
   * auto-merge does not fire.
   *
   * Three `gh pr merge` calls exist now, not two: `review-and-merge.ts`
   * added the OPERATOR-invoked `llamenos-fleet review-and-merge <pr>`
   * command, which is a human running a named command against a named PR —
   * a different act from the autonomous tick loop deciding to arm
   * auto-merge on its own. Its one real, `--squash --delete-branch` merge is
   * reached only after `runReviewAndMerge` has independently re-verified
   * every required check (including a fresh `fleet/review`) is green on an
   * unmoved head (`evaluateMergeReadiness`) — GitHub is still what actually
   * enforces the gate; this call cannot skip a red check GitHub would
   * refuse. It is confined to exactly that one file and never carries
   * `--auto`/`--disable-auto` (a real merge is neither arming nor
   * un-arming). The original pair survives unchanged: one ARMS GitHub's
   * auto-merge for the autonomous fleet, reached only after mechanical
   * verification and the non-author review have both passed; one can only
   * UN-arm, for a PR an earlier attempt armed before this one rejected it.
   * Any OTHER shape — a bare merge with none of `--auto`/`--disable-auto`/
   * `--squash`, or a fourth call anywhere, or the real merge appearing
   * outside `review-and-merge.ts` — would be this process deciding
   * something that is GitHub's to decide.
   */
  it('invokes `gh pr merge` only to arm/un-arm auto-merge, or to squash-merge from review-and-merge.ts alone', () => {
    const PR_MERGE = /\[\s*'pr'\s*,\s*'merge'[^\]]*\]/g
    const REVIEW_AND_MERGE_FILE = join(process.cwd(), 'orchestrator', 'src', 'review-and-merge.ts')
    const arms: string[] = []
    const disarms: string[] = []
    const realMerges: { file: string; call: string }[] = []
    const unknown: string[] = []
    for (const { file, text } of orchestratorSources()) {
      for (const call of text.match(PR_MERGE) ?? []) {
        const isArm = call.includes("'--auto'")
        const isDisarm = call.includes("'--disable-auto'")
        const isRealMerge = call.includes("'--squash'")
        if (isArm) arms.push(call)
        else if (isDisarm) disarms.push(call)
        else if (isRealMerge) realMerges.push({ file, call })
        else unknown.push(`${file}: ${call}`)
      }
    }
    expect(unknown, 'gh pr merge call(s) that neither arm, un-arm, nor squash-merge').toEqual([])
    expect(arms).toHaveLength(1)
    expect(disarms).toHaveLength(1)
    expect(realMerges).toHaveLength(1)
    expect(realMerges[0]?.file, 'a real (squash) gh pr merge exists outside review-and-merge.ts')
      .toBe(REVIEW_AND_MERGE_FILE)
    expect(realMerges[0]?.call, 'the real merge in review-and-merge.ts must delete the branch too')
      .toContain("'--delete-branch'")
  })

  /**
   * The Checks API's `POST /repos/{R}/check-runs` is a write path with real
   * consequences: whatever it posts becomes a required-status verdict on a
   * commit, exactly as authoritative as an Actions job's own result. Only
   * `review-and-merge.ts`'s `postReviewCheckRun` may call it — see that
   * file's own module comment for why this is the ONE local write path this
   * design trusts, and why it never gained a `statuses:write`-shaped
   * capability anywhere else in the orchestrator (ci.ts's own comment above
   * `VERIFY_JOB`/`REVIEW_JOB` explains why a same-named STATUS was rejected
   * outright: it is what makes fork PRs unmergeable). A second call site
   * creating a check-run — however it got there — would be a second,
   * ungoverned place this process can post a verdict nothing here reviewed.
   */
  it('creates a check-run from exactly one file (review-and-merge.ts)', () => {
    const CHECK_RUNS_CREATE = /check-runs/
    const REVIEW_AND_MERGE_FILE = join(process.cwd(), 'orchestrator', 'src', 'review-and-merge.ts')
    const hits = orchestratorSources().filter(({ text }) => CHECK_RUNS_CREATE.test(text))
    expect(hits.map((h) => h.file)).toEqual([REVIEW_AND_MERGE_FILE])
  })
})

describe('rail: crypto and protocol always reach a human', () => {
  it.each([
    'packages/crypto/src/hpke.rs',
    'packages/protocol/schemas/note.ts',
    'packages/protocol/crypto-labels.json',
    'apps/worker/lib/auth.ts',
    // The key-boundary wrapper: not the crypto crate itself, but the single
    // abstraction (per CLAUDE.md) keeping a device private key out of the
    // webview. A quiet mistake here is an identity disclosure exactly like a
    // mistake in packages/crypto/ itself — see impact.ts's CORRECTED comment
    // for why this was briefly (and wrongly) narrowed out, then restored.
    'src/client/lib/platform.ts',
  ])('%s is high impact', (f) => {
    expect(classifyImpact([f], 1).impact).toBe('high')
  })
})

describe('rail: never-write binds even an unrestricted lane', () => {
  it('forbids secrets for a lane with no declared scope', () => {
    expect(checkScope(['.env'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS]).forbidden).toEqual(['.env'])
  })

  it('forbids a nested secrets file for a lane with no declared scope', () => {
    expect(checkScope(['apps/worker/config/.env'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS]).forbidden)
      .toEqual(['apps/worker/config/.env'])
  })

  it('forbids a signing keystore for a lane with no declared scope', () => {
    expect(checkScope(['apps/android/keystore.properties'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS]).forbidden)
      .toEqual(['apps/android/keystore.properties'])
  })

  // CI and deploy stay WRITABLE — a lane owning them can still fix its own
  // CI, and never-write is about secrets, not about review. `deploy/` stays
  // low-impact and unowned in CODEOWNERS (PR #794: no production users yet,
  // so a bad deploy config is recoverable). `ci.yml` is HIGH impact via the
  // `.github/workflows/` prefix, because it is where "check out the base,
  // not the head" is written down: a PR editing the gate's own definition is
  // editing the machinery that judges it.
  it('leaves CI and deploy writable, and treats the gate definition itself as high impact', () => {
    expect(checkScope(['.github/workflows/ci.yml'], { owned: [], notOwned: [] }, [...NEVER_WRITE_PATHS]).forbidden)
      .toEqual([])
    expect(classifyImpact(['.github/workflows/ci.yml'], 1).impact).toBe('high')
    expect(classifyImpact(['deploy/helm/values.yaml'], 1).impact).toBe('low')
  })
})

describe('rail: the GitHub kill switch fails open', () => {
  it('does not halt when the issue list could not be read', () => {
    expect(haltedOnGitHubFrom(undefined)).toBe(false)
  })
})

// The single-origin-remote invariant ("rail: origin points at
// llamenos-platform") used to be asserted here by shelling out to
// `git remote -v` on the machine running the test suite. Removed: it
// asserted the test-runner's own git config, not the code — it fails on any
// contributor's fork or differently-configured checkout for reasons that
// have nothing to do with the diff under test, and `doctor`
// (orchestrator/src/cli.ts) already enforces the stronger form of this
// invariant (exactly one remote, named origin) at runtime on the only
// machine where the answer is meaningful: the operator's.

describe('rail: every lane starts off', () => {
  it('ships no lane in live or shadow mode by default', () => {
    expect(LANES.filter((l) => l.mode !== 'off')).toHaveLength(0)
  })
})

/**
 * #812: `fleet/review` retired `opencode`/Kimi as the reviewer engine
 * entirely and moved to a `claude` SESSION running on a dedicated
 * self-hosted runner (`llamenos-review-box`), on the operator's own Max
 * subscription rather than a metered, weekly-quota'd key. Most of the old
 * engine's failures were infrastructure (turn-budget exhaustion, quota,
 * UNREADABLE verdicts from a 2-3-turn cap opencode's own CLI couldn't even
 * enforce) rather than genuine misses — a session with real tools reviews
 * better than a thin per-call API hit.
 *
 * Reconciling this with #891 (2026-09-19, "fail loud on unconfigured
 * fleet/review engine, never a dead default"): that fix was about
 * `vars.FLEET_REVIEW_PROVIDER` — a SWAPPABLE provider id that had already
 * gone stale twice, silently, with a `|| 'kimi-for-coding'` literal masking
 * the day it was retired. `#812`'s redesign removes the entire class of bug
 * #891 fixed rather than re-solving it: there is no provider variable left
 * to go stale, because `claude` is the only reviewer engine
 * (`reviewerBinaryFor` hard-fails for anything else — see its doc comment in
 * review.ts). `FLEET_REVIEW_MODEL` keeps a literal default (`'sonnet'`), but
 * that is not the same failure shape: `'sonnet'` is a live, always-valid
 * model tier that a claude session can actually run, not a retired id
 * silently substituted for one that used to work. A bad value in
 * `FLEET_REVIEW_MODEL` (typo'd, or a leftover opencode-shaped id like
 * `kimi-code-plan-global/k3-256k` from before this PR) is still caught
 * LOUD, before the real review ever runs: `claude` itself refuses an
 * unrecognized `--model`, and the smoke step's `classify()` (backed by
 * `classifyEngineFailure` in review.ts) names that failure
 * `engine-misconfigured`, never a silent pass. See
 * fleet-review-smoke-step.test.ts for the behavioural rail on that
 * classification.
 *
 * This rail asserts what survived the switch and what changed on purpose:
 *   - the model is STILL a repo variable, never a hardcoded literal — the
 *     same "a provider/model change is an operator action, not a code
 *     change" property #812's own predecessor rail asserted, just for
 *     `FLEET_REVIEW_MODEL` alone now (`FLEET_REVIEW_PROVIDER` is gone: there
 *     is exactly one provider, an already-authenticated `claude` CLI, not a
 *     key-holding `auth.json` keyed by provider name);
 *   - the job runs on `[self-hosted, fleet-review]`, never a GitHub-hosted
 *     runner — that label is what actually reaches `llamenos-review-box`;
 *   - a self-hosted runner processing a PR event is dangerous enough that a
 *     fork guard is MANDATORY and must be the job's literal first step —
 *     never installed as an afterthought after a checkout has already run;
 *   - the smoke step still classifies its own failure as engine-quota /
 *     engine-auth / engine-unavailable, and the "Install"/"Authenticate"
 *     steps that used to fetch and configure the opencode binary are GONE
 *     (claude is pre-installed and pre-authenticated on the runner itself);
 *   - `--dangerously-skip-permissions` is never passed to the reviewer.
 *
 * A grep over the workflow YAML's raw text, deliberately — like the
 * `--admin`/`--force` rail above, there is no runtime behaviour to invoke
 * here (this is CI-only shell, never imported by orchestrator code), so the
 * argv/config text IS the thing to assert.
 */
describe('rail: fleet/review runs as a claude session on a self-hosted runner, with a mandatory fork guard', () => {
  const FLEET_REVIEW_YML_PATH = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')

  function fleetReviewYamlText(): string {
    return readFileSync(FLEET_REVIEW_YML_PATH, 'utf8')
  }

  function fleetReviewJobText(): string {
    const text = fleetReviewYamlText()
    // From the `fleet-review:` job key to the next top-level (2-space
    // indented) job key, if any (this file has exactly one job today, so
    // this normally runs to EOF) — scoped rather than trusting "whole file
    // has one job" as an invariant, so a future second job in this file
    // can never satisfy this rail by accident.
    const start = text.indexOf('\n  fleet-review:')
    expect(start, 'fleet-review job not found in fleet-review.yml').toBeGreaterThan(-1)
    const rest = text.slice(start + 1)
    const nextJob = rest.slice('  fleet-review:'.length).search(/\n {2}\S/)
    return nextJob === -1 ? rest : rest.slice(0, '  fleet-review:'.length + nextJob)
  }

  it('finds the fleet-review job to scan at all — the grep must not pass vacuously', () => {
    expect(fleetReviewJobText().length).toBeGreaterThan(500)
  })

  // #1284 made `runs-on` conditional, and this rail is the reason it can be
  // trusted. EVERY event that can reach the review engine still lands on
  // `llamenos-review-box`; the ONE hosted arm is the republish-only
  // `synchronize` event, which `decideReviewGate` refuses `run-engine` on
  // (pinned separately, below). The assertion is on the exact expression,
  // not on "ubuntu-latest appears somewhere": an unconditional hosted
  // `runs-on` would move the reviewer — and the operator's logged-in claude
  // session — onto a GitHub runner, which is what the original rail existed
  // to prevent, and that is what the second assertion here still catches.
  it('runs on the self-hosted fleet-review runner for every engine-capable event, and hosted ONLY on the republish-only push arm', () => {
    const block = fleetReviewJobText()
    const runsOn = block.match(/\n {4}runs-on:.*/)?.[0] ?? ''
    expect(runsOn.length, 'runs-on: not found in the fleet-review job').toBeGreaterThan(0)
    expect(runsOn, 'the self-hosted fleet-review labels must still be the default arm')
      .toMatch(/fromJSON\('\["self-hosted","fleet-review"\]'\)/)
    // `ubuntu-latest` may appear here, but ONLY as the value guarded by the
    // synchronize condition — never as the fallback, and never alone.
    expect(runsOn, 'a hosted runner is only ever the synchronize arm')
      .toMatch(/github\.event\.action == 'synchronize' && fromJSON\('\["ubuntu-latest"\]'\) \|\|/)
    expect(block, 'runs-on must never be an unconditional GitHub-hosted runner')
      .not.toMatch(/\n {4}runs-on:\s*ubuntu-latest\s*$/m)
  })

  it('reads FLEET_REVIEW_MODEL from vars with a sonnet default', () => {
    expect(fleetReviewJobText()).toMatch(
      /FLEET_REVIEW_MODEL:\s*\$\{\{\s*vars\.FLEET_REVIEW_MODEL\s*\|\|\s*'sonnet'\s*\}\}/,
    )
  })

  // Scoped to the actual YAML env-key DECLARATION, not the job's prose —
  // the job's own comments legitimately still explain, in words, that
  // `FLEET_REVIEW_PROVIDER` was removed (and why), which would otherwise
  // trip a bare substring-absence check on its own explanation.
  it('no longer declares a FLEET_REVIEW_PROVIDER env key — there is exactly one provider now', () => {
    expect(fleetReviewJobText()).not.toMatch(/\n\s+FLEET_REVIEW_PROVIDER:\s*\$\{\{/)
  })

  // #891's invariant, carried forward for the one variable left that could
  // still go silently wrong: a bad `FLEET_REVIEW_MODEL` must fail LOUD
  // (`engine-misconfigured`, asserted below and in
  // fleet-review-smoke-step.test.ts), never a silent pass. There is
  // deliberately no separate "Require review engine configuration" step any
  // more — see the doc comment above this describe block for why an
  // absent `FLEET_REVIEW_MODEL` is not the same failure shape #891 fixed.
  it('has no separate "Require review engine configuration" step — an absent FLEET_REVIEW_MODEL is not a missing-provider incident any more', () => {
    expect(fleetReviewJobText()).not.toMatch(/Require review engine configuration/)
  })

  // Scoped to actual step headers / real paths, not prose — the job's own
  // comments legitimately still name these steps and paths in the past
  // tense, explaining that #812 removed them.
  it('has no step that installs or downloads an opencode binary', () => {
    const block = fleetReviewJobText()
    expect(block).not.toContain('opencode-linux-x64.tar.gz')
    expect(block).not.toMatch(/\n {6}- name: Install the non-author review engine\n/)
  })

  it('has no step that writes an opencode auth.json — claude authenticates via the runner\'s own login state', () => {
    const block = fleetReviewJobText()
    expect(block).not.toMatch(/\n {6}- name: Authenticate the review engine\n/)
    expect(block).not.toContain('$HOME/.local/share/opencode')
  })

  // #866: the binary AND the model are both resolved dynamically, via
  // `reviewerInvocationFor` (review.ts) — the SAME function
  // `invokeVerifierEngine` (the real review) calls — never a literal typed
  // into this workflow file. A literal here is exactly what let the smoke
  // test "pass" while the real review, running the BASE checkout's own
  // (possibly different) resolution, silently disagreed with it.
  it('resolves the reviewer binary/model dynamically via reviewerInvocationFor, never a literal pinned in the invocation', () => {
    const text = fleetReviewJobText()
    expect(text).toMatch(/\| "\$rev_binary" --print --permission-mode plan --model "\$rev_model"/)
    expect(text, 'smoke test does not import reviewerInvocationFor from review.ts')
      .toMatch(/import \{ reviewerInvocationFor \} from "\.\/orchestrator\/src\/review\.ts"/)
    expect(text, 'smoke test pins a literal model again instead of resolving one')
      .not.toMatch(/--model "?sonnet"?\b/)
    expect(text, 'smoke test pins a literal claude binary again instead of resolving one')
      .not.toMatch(/\|\s*claude --print --permission-mode plan/)
  })

  // Scoped to the smoke-test step's own run: block — the job's surrounding
  // comments legitimately still say "opencode" in past tense (explaining
  // what #812 replaced), which a whole-job substring-absence check would
  // wrongly trip on its own historical explanation.
  it('smoke-tests claude, never opencode', () => {
    const block = fleetReviewJobText()
    const stepIdx = block.indexOf('\n      - name: Smoke-test the review engine\n')
    expect(stepIdx, 'smoke-test step not found').toBeGreaterThan(-1)
    const nextStepIdx = block.slice(stepIdx + 1).search(/\n {6}- name:/)
    const stepBlock = nextStepIdx === -1 ? block.slice(stepIdx) : block.slice(stepIdx, stepIdx + 1 + nextStepIdx)
    const runIdx = stepBlock.indexOf('\n        run: |\n')
    expect(runIdx, 'smoke-test run: block not found').toBeGreaterThan(-1)
    const runBlock = stepBlock.slice(runIdx)
    expect(runBlock).toContain('claude')
    expect(runBlock).not.toMatch(/\bopencode\b/)
  })

  it('classifies a smoke-test failure as engine-quota, engine-auth, engine-misconfigured, or engine-unavailable', () => {
    const text = fleetReviewJobText()
    for (const cause of ['engine-quota', 'engine-auth', 'engine-misconfigured', 'engine-unavailable']) {
      expect(text, `${cause} classification missing from the smoke-test step`).toContain(cause)
    }
  })

  it('never passes --dangerously-skip-permissions to the reviewer', () => {
    expect(fleetReviewYamlText()).not.toContain('--dangerously-skip-permissions')
  })

  it('review.ts reads the reviewer model from FLEET_REVIEW_MODEL, defaulting to sonnet, not a bare literal', () => {
    const text = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'review.ts'), 'utf8')
    expect(text).toMatch(/const REVIEWER_MODEL = process\.env\['FLEET_REVIEW_MODEL'\] \|\| 'sonnet'/)
  })

  it('review.ts no longer references an opencode binary or an OPENCODE_* env var anywhere', () => {
    const text = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'review.ts'), 'utf8')
    expect(text).not.toMatch(/binary:\s*'opencode'/)
    expect(text).not.toContain('OPENCODE_CONFIG_DIR')
    expect(text).not.toContain('OPENCODE_DISABLE_PROJECT_CONFIG')
  })

  // The mandatory fork guard: a self-hosted runner must never process a
  // fork PR. Must be the job's literal FIRST step — before the checkout,
  // before the head export, before anything that could execute or even
  // just download something on the operator's own machine.
  it('the job\'s first step refuses a fork PR (self-hosted runner guard)', () => {
    const block = fleetReviewJobText()
    const stepsIdx = block.indexOf('\n    steps:\n')
    expect(stepsIdx, 'steps: key not found').toBeGreaterThan(-1)
    const afterSteps = block.slice(stepsIdx)
    const firstStepMatch = afterSteps.match(/\n {6}- name: (.+)\n/)
    expect(firstStepMatch, 'no first step found').not.toBeNull()
    expect(firstStepMatch?.[1]).toMatch(/fork/i)
  })

  it('the fork guard compares the PR head repo against this repo and fails closed on a mismatch', () => {
    const block = fleetReviewJobText()
    const guardIdx = block.search(/\n {6}- name: .*fork.*\n/i)
    expect(guardIdx, 'fork guard step not found').toBeGreaterThan(-1)
    const nextStepIdx = block.slice(guardIdx + 1).search(/\n {6}- name:/)
    const guardBlock = nextStepIdx === -1 ? block.slice(guardIdx) : block.slice(guardIdx, guardIdx + 1 + nextStepIdx)
    expect(guardBlock).toMatch(/head\.repo\.full_name/)
    expect(guardBlock).toMatch(/github\.repository/)
    expect(guardBlock).toContain('exit 1')
  })

  it('the fork guard is never itself gated by a step-level if: — it must always evaluate', () => {
    const block = fleetReviewJobText()
    const guardIdx = block.search(/\n {6}- name: .*fork.*\n/i)
    expect(guardIdx).toBeGreaterThan(-1)
    const nextStepIdx = block.slice(guardIdx + 1).search(/\n {6}- name:/)
    const guardBlock = nextStepIdx === -1 ? block.slice(guardIdx) : block.slice(guardIdx, guardIdx + 1 + nextStepIdx)
    expect(guardBlock).not.toMatch(/\n {8}if:/)
  })

  // The job-level timeout must always exceed the reviewer's own high-impact
  // wall-clock budget (review.ts's HIGH_IMPACT_TIMEOUT_MS) — otherwise the
  // JOB itself would kill an in-budget review before the engine's own
  // timeout ever got a chance to.
  it('the job timeout-minutes stays comfortably above the high-impact review budget (20 min)', () => {
    const block = fleetReviewJobText()
    const m = block.match(/\n {4}timeout-minutes:\s*(\d+)/)
    expect(m, 'timeout-minutes not found').not.toBeNull()
    const minutes = Number(m?.[1])
    expect(minutes).toBeGreaterThan(20)
  })
})

describe('rail: lane modes are runtime state, not source', () => {
  // orchestrator/ is high-impact and human-gated. If a lane's mode lived in
  // config.ts, flipping it from off to shadow would need a reviewed PR —
  // defeating the point of a runtime dial. Proven behaviorally: write a real
  // modes file and show readLaneModes()/loadLanes() actually pick the mode
  // up from its content, rather than grepping config.ts's source text for a
  // constant name (a check a refactor could break, or a hardcoded mode could
  // satisfy, without the underlying property changing either way).
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function tempModesFile(modes: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-guards-lane-modes-'))
    dirs.push(dir)
    const file = join(dir, 'lanes.json')
    writeFileSync(file, JSON.stringify(modes))
    return file
  }

  it('readLaneModes reads a lane mode from file content, not from source', () => {
    const file = tempModesFile({ backend: 'shadow' })
    expect(readLaneModes(file)).toEqual({ backend: { mode: 'shadow' } })
  })

  it('loadLanes turns a lane on from the modes file alone, with no source change', async () => {
    const file = tempModesFile({ ios: 'live' })
    const lanes = await loadLanes(process.cwd(), file)
    expect(lanes.find((l) => l.id === 'ios')?.mode).toBe('live')
    // Every other lane is untouched by that same file.
    expect(lanes.filter((l) => l.id !== 'ios').every((l) => l.mode === 'off')).toBe(true)
  })

  it('loadLanes applies the object shape on top of the LANES defaults', async () => {
    const file = tempModesFile({
      backend: { mode: 'shadow', engine: 'opencode', model: 'kimi-for-coding/k3-256k' },
    })
    const lanes = await loadLanes(process.cwd(), file)
    const backend = lanes.find((l) => l.id === 'backend')
    expect(backend).toMatchObject({ mode: 'shadow', engine: 'opencode', model: 'kimi-for-coding/k3-256k' })
    const ios = lanes.find((l) => l.id === 'ios')
    expect(ios).toMatchObject({ mode: 'off', engine: 'claude' })
    expect(ios?.model).toBeUndefined()
  })

  it('loadLanes fails closed: a rejected override leaves the lane off', async () => {
    const file = tempModesFile({ backend: { mode: 'live', engine: 'wat' } })
    const rejections: string[] = []
    const lanes = await loadLanes(process.cwd(), file, (_id, reason) => { rejections.push(reason) })
    expect(lanes.find((l) => l.id === 'backend')?.mode).toBe('off')
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatch(/invalid engine/i)
  })

  // End-to-end proof of the PR #840 fleet/review finding: a poisoned
  // `__proto__` entry must not turn unlisted lanes live through prototype
  // inheritance. Raw JSON string — `tempModesFile({ "__proto__": ... })` would
  // set the fixture object's own prototype and JSON.stringify would drop the
  // key, silently neutering the test.
  it('loadLanes fails closed on a poisoned __proto__ entry: every lane except backend stays off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-guards-lane-modes-'))
    dirs.push(dir)
    const file = join(dir, 'lanes.json')
    writeFileSync(file, '{"__proto__":{"mode":"live"},"backend":"shadow"}')
    const rejections: string[] = []
    const lanes = await loadLanes(process.cwd(), file, (_id, reason) => { rejections.push(reason) })
    expect(lanes.find((l) => l.id === 'backend')?.mode).toBe('shadow')
    expect(lanes.filter((l) => l.id !== 'backend').every((l) => l.mode === 'off')).toBe(true)
    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatch(/unknown lane id/i)
  })
})

/**
 * `fleet/review` moved off `pull_request` and onto `merge_group` (#812): the
 * old trigger re-ran a non-author MODEL call — against a paid, weekly-quota'd
 * provider — on every push and every `gh pr update-branch`, and that call
 * volume is what exhausted the quota and made the repo unmergeable. That fix
 * had its own bug, found and fixed at #844: the job stayed in `ci.yml`,
 * gated by a job-level `if:` — but `ci.yml` ALSO triggers on `pull_request`,
 * so on every ordinary PR the job was still INSTANTIATED and merely skipped
 * by that `if:`, and GitHub treats a *skipped* required check as satisfying
 * it, exactly like a green one. #844 itself merged this way, with
 * `fleet/review` reporting "skipping" and no model review ever run. The real
 * fix was not a smarter `if:` — GitHub does not distinguish "correctly
 * skipped" from "should have blocked" once a job exists on the trigger at
 * all — so `fleet/review` moved into its OWN workflow file
 * (`fleet-review.yml`) at #848, on `workflow_dispatch` + `merge_group` only.
 *
 * #848's own trigger had a DIFFERENT bug, found on #848 itself:
 * `workflow_dispatch` is a repository-level event with no PR of its own, so
 * a dispatched run's check result — even a correct, passing one, verified
 * against #848's real run — never counts toward a PR's required contexts at
 * all. `gh pr view 848 --json statusCheckRollup` never listed it, and
 * `gh pr merge` refused with "the base branch policy prohibits the merge".
 * The fix here: trigger from the PR's OWN check suite — `pull_request`,
 * scoped to `types: [review_requested]` so it fires on exactly one signal
 * (#1158: a review being requested or re-requested from `llamenos-auto`, or
 * from `rhonda-rodododo` on the release PR), never on an ordinary push. The
 * `labeled` trigger this replaced could not reach a release PR at all, which
 * is #1114. A `pull_request`-triggered
 * run's check result attaches to the PR head SHA automatically, which is
 * what actually satisfies a required context — the same mechanism
 * `fleet/verify` already relies on. `merge_group` is dropped as a trigger
 * (see the "reports on merge_group" rail below for why that is safe today).
 *
 * Text assertions over the workflow files are the right instrument here, the
 * same reasoning `guards.test.ts` already applies to `orchestrator/src` argv
 * rails above: there is no runtime behaviour of a YAML trigger condition to
 * exercise, only the literal condition itself, and a regex over the source is
 * what a mutation to it actually breaks.
 *
 * `fleet/verify` moved out of `ci.yml` into its own `fleet-verify.yml` in
 * round 3 of #844 (CodeQL cache-poisoning — see the rail below this one for
 * why). `fleet/review` made the same move at #848 and changed its own
 * trigger again here, so this block now reads three files.
 */
describe('rail: fleet/review runs once per review request, not on every push', () => {
  const workflowYaml = (file: string): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')
  const ciYaml = (): string => workflowYaml('ci.yml')
  const fleetVerifyYaml = (): string => workflowYaml('fleet-verify.yml')
  const fleetReviewYaml = (): string => workflowYaml('fleet-review.yml')

  /** The text of one named job, from its `  <name>:` line up to (but not
   *  including) the next job at the same two-space indentation — matching
   *  every job key actually declared in the file, not a hardcoded guess at
   *  what might come next. */
  function jobBlock(text: string, name: string): string {
    const jobHeaderRe = /\n {2}([a-zA-Z0-9_-]+):\n/g
    const starts: { name: string; index: number }[] = []
    for (const m of text.matchAll(jobHeaderRe)) starts.push({ name: m[1] as string, index: m.index })
    const at = starts.findIndex((s) => s.name === name)
    if (at === -1) throw new Error(`no "${name}:" job found in this workflow file — the grep must not pass vacuously`)
    const end = at + 1 < starts.length ? starts[at + 1]?.index : text.length
    return text.slice(starts[at]?.index, end)
  }

  it('finds fleet-verify (fleet-verify.yml) and fleet-review (fleet-review.yml) as real jobs — the parser must not pass vacuously', () => {
    expect(jobBlock(fleetVerifyYaml(), 'fleet-verify')).toContain('name: fleet/verify')
    expect(jobBlock(fleetReviewYaml(), 'fleet-review')).toContain('name: fleet/review')
  })

  // The load-bearing assertion of this whole rail, in its post-#844-fail-open
  // form: `fleet/review` must not exist as a job anywhere in `ci.yml` at all
  // — not gated by an `if:`, not skipped, ABSENT. A job that exists on
  // `ci.yml`'s `pull_request`/`push` trigger and is merely `if:`-gated to
  // skip on those events is exactly the regression this rail exists to catch
  // (a skipped required check satisfies branch protection same as a green
  // one), and re-adding the job under any `if:` reproduces it.
  it('ci.yml contains no job named fleet-review — the job must be ABSENT on pull_request, not skipped', () => {
    expect(() => jobBlock(ciYaml(), 'fleet-review')).toThrow()
  })

  it('ci.yml triggers on merge_group at the workflow level (ci-status, the repo\'s own required aggregate, still must report there)', () => {
    // Scoped to before the `jobs:` key: `merge_group` also appears in prose
    // comments and in job bodies (context field names, env vars), and this
    // assertion is specifically about the workflow's OWN `on:` block.
    const onBlock = ciYaml().split(/\njobs:\n/)[0] ?? ''
    expect(onBlock).toMatch(/\n {2}merge_group:/)
  })

  it('fleet-verify.yml triggers on merge_group AND pull_request, and nothing else with default-branch cache-write access', () => {
    const onBlock = fleetVerifyYaml().split(/\njobs:\n/)[0] ?? ''
    expect(onBlock).toMatch(/\n {2}pull_request:/)
    expect(onBlock).toMatch(/\n {2}merge_group:/)
    // The whole point of the split (see the CodeQL rail below): none of
    // these may appear at the top level, or CodeQL's
    // hasDefaultBranchCacheWriteAccess goes true again for this job.
    for (const cacheWriteEvent of ['push', 'workflow_dispatch', 'repository_dispatch', 'schedule']) {
      expect(onBlock).not.toMatch(new RegExp(`\\n {2}${cacheWriteEvent}:`))
    }
  })

  // The load-bearing assertion for fleet-review.yml's own trigger list:
  // `pull_request` scoped to EXACTLY `types: [review_requested, synchronize]`
  // — never `labeled` (which #1158 retired) and never `opened` (which
  // re-enters through CODEOWNERS requesting the operator on almost every PR)
  // — plus `workflow_dispatch` for manual debugging, plus `merge_group`
  // (#1187 — see fleet-review-merge-group.test.ts for the arm that makes it
  // safe), and specifically never `push`.
  //
  // `synchronize` used to be forbidden here for the same reason `labeled`
  // and `opened` still are: every run was a model call, so one per push was
  // the quota burn #812 fixed. #1284 added it, and the reason it is safe is
  // NOT that the assertion was loosened — it is that a `synchronize` run
  // cannot reach the engine at all. That half is pinned by the
  // `republishOnly` rails further down this file, which assert
  // `decideReviewGate` refuses `run-engine` on such an event even when
  // `requested` is true. Both halves have to hold: this rail says the
  // trigger list is exactly these two actions, those rails say the second
  // one can only republish.
  //
  // `merge_group` used to be forbidden here, because a trigger with no
  // matching arm inside the job is the fail-open shape this whole rail
  // exists to catch. #1187 added the arm — a STEP that always runs on the
  // queue ref and always publishes a real verdict — so the trigger is now
  // REQUIRED instead: without it `fleet/review` cannot report on the queue's
  // synthetic commit at all, and a required context that never reports
  // leaves every entry at `AWAITING_CHECKS` forever.
  it('fleet-review.yml triggers on pull_request (review_requested + synchronize), workflow_dispatch AND merge_group, and NEVER push', () => {
    const onBlock = fleetReviewYaml().split(/\njobs:\n/)[0] ?? ''
    expect(onBlock).toMatch(/\n {2}pull_request:\n {4}types:\s*\[\s*review_requested\s*,\s*synchronize\s*\]/)
    expect(onBlock).toMatch(/\n {2}workflow_dispatch:/)
    // Scoped to the LITERAL pull_request trigger sub-block (from its own
    // `\n  pull_request:` line to the next 2-space-indented key), not the
    // whole pre-`jobs:` text — the file's own prose comments above `on:`
    // legitimately discuss why `synchronize` is absent, and a whole-text
    // check would fail on that explanation rather than on an actual second
    // `types:` entry.
    const pullRequestBlock = onBlock.match(/\n {2}pull_request:\n((?:\n| {4,}.*\n)*)/)?.[0] ?? ''
    expect(pullRequestBlock.length, 'pull_request trigger sub-block not found').toBeGreaterThan(0)
    // Scoped to the `types:` LINE itself, not the trigger sub-block: the
    // block's own prose legitimately explains why `synchronize` is there and
    // why `opened`/`labeled` are not, and a substring check over the whole
    // block would trip on that explanation rather than on a real entry.
    const typesLine = pullRequestBlock.match(/\n {4}types:.*/)?.[0] ?? ''
    expect(typesLine.length, 'pull_request types: line not found').toBeGreaterThan(0)
    for (const forbiddenType of ['labeled', 'opened']) {
      expect(typesLine, `fleet-review.yml pull_request trigger must be review_requested + synchronize only — adding ${forbiddenType} reopens the every-label/CODEOWNERS bug`)
        .not.toContain(forbiddenType)
    }
    expect(onBlock, 'fleet-review.yml must never trigger on "push" — that reopens the every-push model-call bug')
      .not.toMatch(/\n {2}push:/)
    // #1187: present, and scoped to the one merge-queue event.
    expect(onBlock, 'fleet-review.yml must trigger on merge_group — a required context that cannot report on the queue ref stalls every entry forever')
      .toMatch(/\n {2}merge_group:\n {4}types:\s*\[\s*checks_requested\s*\]/)
  })

  /** The JOB-level `if:`, not a step's — always at exactly four-space
   *  indentation, always before `steps:`, in this file's own convention
   *  (matching `runs-on:`/`permissions:` at the same level). A step-level
   *  `if:` (e.g. `lint`'s `if: steps.changed.outputs.files != ''`) sits
   *  deeper, inside `steps:`, and must never be mistaken for this one. */
  function jobLevelIf(block: string): string {
    const beforeSteps = block.split(/\n {4}steps:\n/)[0] ?? block
    return beforeSteps.match(/\n {4}if:\s*(.+)/)?.[1] ?? ''
  }

  it('fleet/verify runs on merge_group (in addition to pull_request)', () => {
    const ifLine = jobLevelIf(jobBlock(fleetVerifyYaml(), 'fleet-verify'))
    expect(ifLine).toContain('merge_group')
    expect(ifLine).toContain('pull_request')
  })

  /**
   * #848 fixed the fail-open bug once, by moving the job out of `ci.yml`,
   * and then reintroduced the SAME bug class inside this very file: a
   * job-level `if: github.event_name == 'workflow_dispatch' ||
   * github.event.label.name == 'review'` on a job whose trigger is
   * `pull_request: types: [labeled]` — which GitHub cannot filter by label
   * VALUE — so applying ANY other label (e.g. `agent-dispatchable`) still
   * INSTANTIATES the job and the `if:` then SKIPS it, satisfying branch
   * protection with no review ever run. `fleet/review`'s own verdict on
   * this PR (#848's own follow-up) is what caught it before merge.
   *
   * The fix this rail pins: NO job-level `if:` at all, ever again. What
   * used to be that `if:` is now the "Decide whether to run the review
   * engine" step, further down in the job, whose exit code and `outcome`
   * output are what the LATER steps key off — see the rails below this one.
   */
  it('fleet/review carries NO job-level if: at all — a job-level if: on this trigger is exactly the fail-open bug this file exists to prevent', () => {
    const ifLine = jobLevelIf(jobBlock(fleetReviewYaml(), 'fleet-review'))
    expect(ifLine).toBe('')
  })

  /** A single step's own `if:`, found by its `name:` — scoped from that
   *  step's own `- name: <name>` line to the next `\n      - name:` (or
   *  `\n      - uses:`) at the same six-space step indentation, so a later
   *  step's `if:` (or lack of one) is never mistaken for this step's. */
  function stepIf(block: string, stepName: string): string {
    const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stepHeaderRe = new RegExp(`\\n {6}- name: ${escaped}\\n`)
    const m = block.match(stepHeaderRe)
    if (m === null || m.index === undefined) {
      throw new Error(`no "- name: ${stepName}" step found — the grep must not pass vacuously`)
    }
    // The newline ending the "- name: ..." line itself, kept as the LEADING
    // newline of `rest` — every downstream match below (the next step
    // header, this step's own `if:`) is anchored on `\n {N}...`, so a `rest`
    // missing its own leading newline would silently fail to match its
    // FIRST line, exactly the bug this comment replaces.
    const nameLineEnd = block.indexOf('\n', m.index + 1)
    const rest = block.slice(nameLineEnd)
    const nextStep = rest.search(/\n {6}- (name|uses):/)
    const stepBlock = nextStep === -1 ? rest : rest.slice(0, nextStep)
    return stepBlock.match(/\n {8}if:\s*(.+)/)?.[1] ?? ''
  }

  it('finds real steps to scan at all — the stepIf grep must not pass vacuously', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    expect(() => stepIf(block, 'Setup Bun')).not.toThrow()
  })

  // #1158: "did this event ask US for a review" is no longer decided in
  // bash at all. It is `reviewIsRequested` (orchestrator/src/ci.ts), a pure
  // function under direct test in specialist.test.ts, fed the RAW event
  // fields through `env:`. This rail pins that the workflow actually hands
  // it those fields and never re-derives the answer itself — a bash
  // comparison nothing pins is exactly the fail-open shape #848 shipped.
  it('the gate step is handed the raw event name and requested reviewer, and no shell recomputes "requested"', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    expect(block).toContain('FLEET_REVIEW_EVENT_NAME: ${{ github.event_name }}')
    expect(block).toContain('FLEET_REVIEW_REQUESTED_REVIEWER: ${{ github.event.requested_reviewer.login }}')
    // No shell branch anywhere in the job sets a `requested` variable.
    expect(block).not.toMatch(/requested=(true|false)/)
    expect(block).not.toMatch(/echo "requested=/)
  })

  // The review set must NOT reach `review-ci` from this file. On a
  // `pull_request` event the workflow is the PR's own copy, so a set passed
  // in through `env:` is a value the defendant chose: a PR could empty it
  // and its crypto review would silently never run, leaving a reusable
  // general-only PASS for a set nobody approved. Base code decides it
  // (`runReviewCi` -> `decideReviewSet`), and this rail pins that the
  // channel for overriding it does not exist.
  it('never passes the review set into review-ci — base code decides it, not this file', () => {
    expect(fleetReviewYaml()).not.toContain('FLEET_REVIEW_PROFILES')
  })

  // Every reviewing step is opt-in on `outcome == 'run-engine'`, which makes
  // GREEN this job's default. This is the step that asserts the opposite.
  it('asserts a review actually ran when the gate said to — green is never the default', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    const assertIdx = block.indexOf('- name: Assert this run reached a real verdict')
    expect(assertIdx, 'the assertion step is missing').toBeGreaterThan(-1)
    const assertBlock = block.slice(assertIdx)
    expect(assertBlock).toContain('gate-outcome-missing')
    expect(assertBlock).toContain('review-did-not-run')
    // #1187: the merge-queue arm is covered by the same step, so a
    // merge_group run that reached no verdict cannot conclude green either.
    expect(assertBlock).toContain('queue-verdict-missing')
    // It must run even when an earlier step failed, or it could be skipped
    // in exactly the case it exists to catch. A bare `always()` since #1187
    // — the old `always() && steps.gate.conclusion == 'success'` skipped the
    // whole assertion on merge_group, where the gate step does not run.
    expect(stepIf(block, 'Assert this run reached a real verdict')).toBe('always()')
  })

  // The gate step is what used to be the job-level `if:` (see the rail
  // above) — it must never itself be conditioned on its OWN output, or it
  // could never run at all. Since #1187 it carries exactly ONE condition,
  // pinned literally here: the merge-queue arm, which produces this job's
  // verdict on a `merge_group` ref without the gate. Anything else appearing
  // on this line — and in particular anything naming `steps.gate` — is the
  // regression this assertion exists to catch.
  it('the "Decide whether to run the review engine" step (the gate) is gated by nothing but the merge-queue arm', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    expect(stepIf(block, 'Decide whether to run the review engine')).toBe("github.event_name != 'merge_group'")
    expect(block).toMatch(/- name: Decide whether to run the review engine\n\s+id: gate\n/)
    expect(block).toContain('bun orchestrator/src/cli.ts review-gate')
  })

  // The load-bearing assertion for the new design: EVERY step that can
  // spend a model call — the smoke test (which itself makes a real claude
  // call) and the real review — is gated on
  // `steps.gate.outputs.outcome == 'run-engine'`. Dropping this `if:` from
  // either is branch (a)/(c) calling the engine anyway — exactly the "cheap
  // and non-destructive" property the cache-hit/not-requested branches
  // exist to guarantee. #812 removed the separate "Install the non-author
  // review engine" and "Authenticate the review engine" steps entirely —
  // `claude` is pre-installed and pre-authenticated on the self-hosted
  // runner, so there is nothing left to install or authenticate here.
  it.each([
    'Smoke-test the review engine',
    'Check the base provides reviewerInvocationFor',
    'Check the base provides the gate',
    'Review',
  ])('the "%s" step only runs when the gate said run-engine', (stepName) => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    expect(stepIf(block, stepName)).toBe("steps.gate.outputs.outcome == 'run-engine'")
  })

  // #866's own bootstrap: `reviewerInvocationFor` (review.ts) is this PR's
  // own new export, and the smoke test two steps down imports it from the
  // BASE checkout (the gate always judges from base — see the file header).
  // Without this check, a base that predates the export crashes the smoke
  // step with bun's own uncaught `SyntaxError: Export named
  // 'reviewerInvocationFor' not found` — exactly the opaque-crash shape
  // "Check the base provides the gate" already exists to replace with a
  // named, actionable failure for `review-ci` itself. This asserts the same
  // treatment exists for the narrower, PR-introduced symbol.
  it('the base-provides-reviewerInvocationFor guard runs before the smoke test and names the exact bootstrap condition', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    const guardIdx = block.indexOf('- name: Check the base provides reviewerInvocationFor')
    const smokeIdx = block.indexOf('- name: Smoke-test the review engine')
    expect(guardIdx, 'guard step not found').toBeGreaterThan(-1)
    expect(smokeIdx, 'smoke step not found').toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(smokeIdx)
    const guardBlock = block.slice(guardIdx, smokeIdx)
    expect(guardBlock).toContain("grep -q '^export function reviewerInvocationFor' orchestrator/src/review.ts")
    expect(guardBlock).toContain('base-missing-reviewer-invocation-for')
    expect(guardBlock).toContain('merge')
  })

  // The `not-requested` fail-closed message — an operator or agent reading
  // a red `fleet/review` must be told exactly what to do (request a review
  // from `llamenos-auto`), not left to guess why a check that "did nothing"
  // is failing. The account name comes from `REVIEW_REQUEST_LOGIN`, never a
  // second literal that could drift from what the gate actually accepts.
  it('the review-gate CLI command fails with an actionable "review not requested" message naming the reviewer to request', () => {
    const text = readFileSync(join(process.cwd(), 'orchestrator', 'src', 'cli.ts'), 'utf8')
    expect(text).toContain('review not requested — request a review from \\`${REVIEW_REQUEST_LOGIN}\\`')
    expect(text).not.toContain('add the \\`review\\` label')
  })

  it('fleet/review still carries no write permission and no --approve', () => {
    const block = jobBlock(fleetReviewYaml(), 'fleet-review')
    const permsBlock = block.match(/\n {4}permissions:\n((?:\s{6}.*\n)*)/)?.[1] ?? ''
    expect(permsBlock.length, 'fleet-review has no permissions: block to check').toBeGreaterThan(0)
    // Actual `key: value` permission lines only — comment lines (this very
    // block explains, in prose, why there is no `: write` here, which would
    // otherwise make the string "`: write`" match its own explanation).
    const permissionLines = permsBlock.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim().length > 0)
    for (const line of permissionLines) expect(line).not.toMatch(/:\s*write\b/)
    expect(fleetReviewYaml()).not.toContain('--approve')
    // The workflow-level `permissions: {}` (deny-all) too, matching
    // fleet-verify.yml's and ci.yml's own convention — belt-and-suspenders
    // on top of the job-level grants asserted above. Zero-indented: a
    // top-level key, sibling to `on:`/`jobs:`, not nested under either.
    const onBlock = fleetReviewYaml().split(/\njobs:\n/)[0] ?? ''
    expect(onBlock).toMatch(/\npermissions:\s*\{\}/)
  })

  // `ci-status` aggregates the repo's OWN required jobs (never fleet/verify
  // or fleet/review — see the "Fleet gates" comment above fleet-verify for
  // why those stay out of its `needs`). Every one of them must also report
  // on `merge_group`: a required check that only reports on `pull_request`
  // or `push` leaves its status permanently missing on the queue ref, and a
  // missing required check blocks the queue forever rather than failing it
  // loudly.
  it('every job ci-status depends on can report on merge_group', () => {
    const yaml = ciYaml()
    const needsLine = jobBlock(yaml, 'ci-status').match(/\n\s*needs:\s*\[([^\]]+)\]/)?.[1] ?? ''
    const required = needsLine.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    expect(required.length, 'ci-status needs list parsed empty — the grep must not pass vacuously').toBeGreaterThan(5)

    const excludesMergeGroup = (ifLine: string): boolean => {
      // A job with NO if: at all runs on every event the workflow triggers
      // on — merge_group included, now that it is in the workflow's `on:`.
      if (ifLine.length === 0) return false
      // An `if:` that names an event at all must name merge_group too, or
      // it silently excludes the one event this rail is about; an `if:`
      // that never mentions an event (e.g. `needs.changes.outputs...`) is
      // unaffected by which event triggered the run and passes through.
      const namesAnEvent = /event_name|github\.event\.(before|after|head_commit)/.test(ifLine)
      return namesAnEvent && !ifLine.includes('merge_group')
    }

    const offenders: string[] = []
    for (const job of required) {
      const ifLine = jobLevelIf(jobBlock(yaml, job))
      if (excludesMergeGroup(ifLine)) offenders.push(`${job}: if: ${ifLine}`)
    }
    expect(offenders, `required job(s) whose if: excludes merge_group:\n${offenders.join('\n')}`).toEqual([])
  })
})

/**
 * #812: a release PR (knope, title `chore(release): v...`) was permanently
 * unmergeable. `changes` (ci.yml) and its ios-e2e.yml twin both carried
 * `if: "!startsWith(github.event.head_commit.message, 'chore(release):')"`,
 * unconditionally, on a workflow that ALSO triggers on `pull_request` and
 * `merge_group`. `github.event.head_commit` only exists on a `push`
 * payload — on every other event it is `null`, and `startsWith(null, ...)`
 * coerces to `startsWith('', ...)`, which is `false`, so the negated guard
 * happened to evaluate to "run" there. That is an accident of null
 * coercion, not a scoped condition: the day this job (or one shaped like
 * it) gains any OTHER push-shaped trigger, or GitHub's null-coercion
 * behavior for a removed context field ever changes, the same starvation
 * reappears from a different angle. `ci-status`, `gitleaks`, `fleet/verify`
 * and `fleet/review` are all REQUIRED contexts (ruleset 15885614); a
 * required context that never reports blocks a merge exactly like a red
 * one, and unlike a plain bug this one is invisible in a diff review — the
 * guard reads correct in isolation, it only starves on the specific event
 * type its author never pictured a release commit arriving as.
 *
 * The fix pins the scope explicitly instead of relying on the coercion:
 * `github.event_name != 'push' || !startsWith(...)`. On `push`, behavior is
 * unchanged (the original, since-#812 intent — see commit 60b1e6c69,
 * `fix(security): audit R6 medium`, which introduced this exact guard on
 * the (now-removed) `audit` job to skip its own then-adjacent `version` job
 * on the automated release commit — knope's PR-based release flow, and
 * therefore any `pull_request` shape for a release commit, did not exist
 * yet). On every other event, the first clause short-circuits the guard to
 * always-run, by construction rather than by what a missing field happens
 * to coerce to.
 */
describe('rail: the release-commit guard never starves a pull_request/merge_group run (#812)', () => {
  const workflowYaml = (file: string): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')

  /** Job block extraction — same convention as the other describe blocks in
   *  this file: from a job's `  <name>:` header to the next job at the same
   *  two-space indentation. */
  function jobBlock(text: string, name: string): string {
    const jobHeaderRe = /\n {2}([a-zA-Z0-9_-]+):\n/g
    const starts: { name: string; index: number }[] = []
    for (const m of text.matchAll(jobHeaderRe)) starts.push({ name: m[1] as string, index: m.index })
    const at = starts.findIndex((s) => s.name === name)
    if (at === -1) throw new Error(`no "${name}:" job found in this workflow file — the grep must not pass vacuously`)
    const end = at + 1 < starts.length ? starts[at + 1]?.index : text.length
    return text.slice(starts[at]?.index, end)
  }

  /** The JOB-level `if:` — four-space indentation, before `steps:`, matching
   *  this file's other `jobLevelIf` helpers. */
  function jobLevelIf(block: string): string {
    const beforeSteps = block.split(/\n {4}steps:\n/)[0] ?? block
    return beforeSteps.match(/\n {4}if:\s*(.+)/)?.[1] ?? ''
  }

  /**
   * Evaluates ONLY the exact two-clause shape this guard is pinned to
   * (`github.event_name != '<event>' || !startsWith(github.event.head_
   * commit.message, '<prefix>')`), against a literal (event, message) pair.
   * `headCommitMessage: null` models a payload where `head_commit` does not
   * exist at all (every non-`push` event) — GitHub Actions' own null
   * coercion for `startsWith` treats that as `''`, reproduced here rather
   * than re-invoked, since no GitHub Actions expression engine is available
   * in a unit test.
   *
   * Throwing when the shape doesn't match is deliberate, not a missing
   * feature: re-adding the old unscoped guard (no `event_name` clause at
   * all) must fail this rail, not silently pass it by falling through to
   * some looser match.
   */
  function evalReleaseGuard(ifLine: string, eventName: string, headCommitMessage: string | null): boolean {
    const m = ifLine.match(/^"?github\.event_name != '(\w+)' \|\| !startsWith\(github\.event\.head_commit\.message, '([^']+)'\)"?$/)
    if (m === null) throw new Error(`"${ifLine}" does not match the expected two-clause, push-scoped guard shape`)
    const pushEvent = m[1] as string
    const prefix = m[2] as string
    if (eventName !== pushEvent) return true
    return !(headCommitMessage ?? '').startsWith(prefix)
  }

  for (const file of ['ci.yml', 'ios-e2e.yml']) {
    it(`${file}'s "changes" job guard names github.event_name — not just the message`, () => {
      const ifLine = jobLevelIf(jobBlock(workflowYaml(file), 'changes'))
      expect(ifLine, `no if: found on ${file}'s changes job`).not.toBe('')
      expect(ifLine).toContain("github.event_name != 'push'")
    })

    it(`${file}: a "chore(release):"-titled commit still yields a run on pull_request and merge_group (mutation: re-add the unscoped guard → this fails)`, () => {
      const ifLine = jobLevelIf(jobBlock(workflowYaml(file), 'changes'))
      // Original push-only intent preserved: a real release commit landing
      // via push still skips this job.
      expect(evalReleaseGuard(ifLine, 'push', 'chore(release): v1.2.3')).toBe(false)
      // Any other push commit message still runs it.
      expect(evalReleaseGuard(ifLine, 'push', 'fix: something')).toBe(true)
      // pull_request, merge_group and workflow_dispatch never carry
      // head_commit at all — the job must run regardless of what a
      // release-shaped title would have said.
      for (const eventName of ['pull_request', 'merge_group', 'workflow_dispatch']) {
        expect(evalReleaseGuard(ifLine, eventName, null)).toBe(true)
        expect(evalReleaseGuard(ifLine, eventName, 'chore(release): v1.2.3')).toBe(true)
      }
    })
  }
})

/**
 * CodeQL `actions/cache-poisoning/poisonable-step` (3 HIGH alerts, PR #844
 * round 3, originally at the "Install dependencies", "Check the base
 * provides the gate" and "Verify" steps of `fleet-verify` back when it lived
 * in `ci.yml`). The mechanism, read from CodeQL's own `actions` query pack
 * (`codeql/actions-all`, `CachePoisoningQuery.qll` + `PoisonableSteps.qll` +
 * `ext/config/poisonable_steps.yml`), is NOT about any specific
 * cache-writing action:
 *
 * - `poisonableCommandsDataModel` lists bare command names whose lifecycle
 *   scripts/plugins could act on the job's ambient `ACTIONS_RUNTIME_TOKEN`
 *   (which grants cache read/write independent of any `actions/cache` step
 *   being present at all) — `bun` is literally on that list, alongside
 *   `npm`/`cargo`/`pip install -r`/etc. Every `run: bun ...` step in the job
 *   is a "poisonable step" by definition, regardless of caching config.
 * - `hasDefaultBranchCacheWriteAccess(job, event)` is true when the job's
 *   EVENT has default-branch cache-write scope — `push`, `workflow_dispatch`,
 *   `repository_dispatch`, `delete`, `registry_package`, `page_build`, or
 *   `schedule` (NOT `pull_request`, NOT `merge_group` — neither appears in
 *   that list). Critically, `JobImpl.getATriggerEvent()` returns every event
 *   the ENCLOSING WORKFLOW responds to, not filtered by the job's own `if:`.
 *   `fleet-verify` sat in `ci.yml`, which also triggers on `push` and
 *   `workflow_dispatch` for its other jobs, so CodeQL treated `fleet-verify`
 *   as reachable from both — regardless of its `if:` excluding them.
 *
 * Tried first and confirmed NOT sufficient: `no-cache: true` on the "Setup
 * Bun" step. It genuinely disables `setup-bun`'s own cache-save (verified by
 * reading its `dist/setup/index.js` and `dist/cache-save/index.js`), but
 * CodeQL's model never inspects that input at all — the flagged "poisonable
 * steps" are the `bun` commands themselves. The fix that actually cleared
 * the alerts (verified via the `code-scanning/alerts` API against the exact
 * commit) is what this rail asserts: `fleet-verify` moved into its OWN
 * workflow file (`fleet-verify.yml`) whose `on:` block is `pull_request` +
 * `merge_group` only — neither has default-branch cache-write access, so
 * `hasDefaultBranchCacheWriteAccess` is false for every event this job can
 * be triggered by, full stop. `no-cache: true` is kept as defense in depth
 * (asserted below) but is not what CodeQL is actually satisfied by.
 *
 * `fleet/review` is deliberately NOT covered here: it never executes HEAD
 * code, only reads it as data for the review model (the "Export the PR head
 * as data" step strips and never runs it), and its explicit
 * `secrets.FLEET_REVIEW_API_KEY` access makes CodeQL's `isPrivileged()` true
 * for that job — which this specific query excludes on purpose (a privileged
 * job reachable by an externally-triggerable event is the subject of a
 * different, more severe query instead). CodeQL agrees either way: 0 alerts
 * on `fleet/review`. If a future job gains both a head-code-execution step
 * and reachability from a workflow with `push`/`workflow_dispatch`, it needs
 * the same file-isolation treatment, not a per-step cache tweak.
 */
describe('rail: the job that executes the judged commit\'s code cannot be reached by a cache-write event', () => {
  const workflowYaml = (file: string): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')

  /** One named job's text, from its `  <name>:` line up to the next job at
   *  the same two-space indentation. */
  function jobBlock(text: string, name: string): string {
    const jobHeaderRe = /\n {2}([a-zA-Z0-9_-]+):\n/g
    const starts: { name: string; index: number }[] = []
    for (const m of text.matchAll(jobHeaderRe)) starts.push({ name: m[1] as string, index: m.index })
    const at = starts.findIndex((s) => s.name === name)
    if (at === -1) throw new Error(`no "${name}:" job found in this workflow file — the grep must not pass vacuously`)
    const end = at + 1 < starts.length ? starts[at + 1]?.index : text.length
    return text.slice(starts[at]?.index, end)
  }

  /** One named step's text within a job block, from its `      - name:` line
   *  (six-space indent — every step in these files) up to the next step at
   *  the same indentation. */
  function stepBlock(block: string, name: string): string {
    const stepHeaderRe = /\n {6}- name: ([^\n]+)\n/g
    const starts: { name: string; index: number }[] = []
    for (const m of block.matchAll(stepHeaderRe)) starts.push({ name: (m[1] as string).trim(), index: m.index })
    const at = starts.findIndex((s) => s.name === name)
    if (at === -1) throw new Error(`no "${name}" step found in this job block — the grep must not pass vacuously`)
    const end = at + 1 < starts.length ? starts[at + 1]?.index : block.length
    return block.slice(starts[at]?.index, end)
  }

  // Hardcoded, not derived — see the doc comment above. Each entry is a job
  // that has a step running code from the PR HEAD export, mapped to the
  // workflow file that must isolate it from default-branch-cache-write
  // events. Mirrors this file's existing convention of a hardcoded,
  // human-reviewed table (see `REQUIRED_CONTEXT_WORKFLOWS` below) rather than
  // a derived lookup that could only ever agree with itself.
  const JOBS_THAT_EXECUTE_HEAD_CODE: { job: string; file: string }[] = [{ job: 'fleet-verify', file: 'fleet-verify.yml' }]

  // Any event name CodeQL's `defaultBranchCacheWriteEvent()` treats as
  // granting cache-write access to the default branch. `pull_request` and
  // `merge_group` are deliberately absent from this list — they are the only
  // two events fleet-verify.yml may trigger on.
  const CACHE_WRITE_EVENTS = ['push', 'workflow_dispatch', 'repository_dispatch', 'delete', 'registry_package', 'page_build', 'schedule']

  for (const { job, file } of JOBS_THAT_EXECUTE_HEAD_CODE) {
    it(`${job} (${file}) still executes HEAD code (the premise this rail depends on)`, () => {
      const block = jobBlock(workflowYaml(file), job)
      // The "Verify" step is what actually runs the judged commit's tests —
      // see verify-ci in orchestrator/src/ci.ts. If this step is ever
      // renamed or removed, the premise of this rail changes and it must be
      // revisited, not silently pass.
      expect(() => stepBlock(block, 'Verify')).not.toThrow()
    })

    it(`${job}'s workflow (${file}) triggers on pull_request and merge_group only — no default-branch-cache-write event`, () => {
      const onBlock = workflowYaml(file).split(/\njobs:\n/)[0] ?? ''
      expect(onBlock).toMatch(/\n {2}pull_request:/)
      expect(onBlock).toMatch(/\n {2}merge_group:/)
      for (const cacheWriteEvent of CACHE_WRITE_EVENTS) {
        expect(onBlock, `${file} must not trigger on "${cacheWriteEvent}" — that would restore CodeQL's cache-write reachability`)
          .not.toMatch(new RegExp(`\\n {2}${cacheWriteEvent}:`))
      }
    })

    it(`${job}'s "Setup Bun" step disables cache-save (no-cache: true) — defense in depth, not the CodeQL fix itself`, () => {
      const setupBun = stepBlock(jobBlock(workflowYaml(file), job), 'Setup Bun')
      expect(setupBun).toContain('oven-sh/setup-bun@')
      expect(setupBun).toMatch(/\n\s*no-cache:\s*true\b/)
    })
  }

  // fleet/review is the documented exception: it never executes HEAD code,
  // so its own workflow file (fleet-review.yml, which DOES also trigger on
  // workflow_dispatch) needing no CodeQL cache-poisoning isolation is
  // correct, not an oversight — see that file's own header comment. This
  // assertion exists so a future edit can't "fix" that job's isolation the
  // same way without first confirming it still holds.
  it('fleet/review (fleet-review.yml) still never runs a step named "Verify" (the exception this rail relies on)', () => {
    const block = jobBlock(workflowYaml('fleet-review.yml'), 'fleet-review')
    expect(() => {
      const stepHeaderRe = /\n {6}- name: Verify\n/
      if (stepHeaderRe.test(block)) throw new Error('fleet-review now has a "Verify" step')
    }).not.toThrow()
  })
})

/**
 * Ruleset 15885614 (the merge queue's branch protection ruleset) requires
 * exactly these four status contexts before a PR can merge: `ci-status`,
 * `gitleaks`, `fleet/verify`, `fleet/review`. A required context that never
 * reports on the queue's own `merge_group` ref blocks the merge queue
 * forever — GitHub waits indefinitely for a check that will never appear,
 * rather than failing loudly. `CodeQL` is the fifth required context but is
 * GitHub default-setup, not a workflow file in this repo, so it is
 * deliberately excluded from this table (see the operator step in the PR
 * body for verifying it separately once the queue is live).
 *
 * The mapping below is hardcoded rather than derived, on purpose: this rail
 * exists to catch a workflow file quietly losing its `merge_group` trigger
 * (as `secret-scan.yml` had, until #844), and a derived lookup would only
 * ever tell you the code agrees with itself.
 *
 * `fleet/verify` moved from `ci.yml` to its own `fleet-verify.yml` in round 3
 * of #844 (CodeQL cache-poisoning isolation — see the rail above), updated
 * here to match, or this rail would itself start failing vacuously against a
 * job that no longer exists in `ci.yml`.
 *
 * `fleet/review` IS in this table as of #1187. It used to be the documented
 * exception: `merge_group` was excluded as a trigger on the reasoning that a
 * trigger with no matching arm inside the job would recreate the fail-open
 * bug, and that the exclusion was safe while this repo's merge queue was
 * unavailable. The queue was then enabled — and #1185 sat at `position 1,
 * AWAITING_CHECKS` indefinitely with every other required context green,
 * because a required context that structurally cannot report on the queue
 * ref does not fail the entry, it stalls it forever. The queue had to be
 * turned off again.
 *
 * The fix was the arm that earlier note said the migration would need, in
 * the only form invariant 1 allows: not a job-level `if:` (a skipped
 * required check satisfies branch protection exactly like a green one) but a
 * STEP that always runs on the queue ref and always publishes a real
 * verdict, derived from the constituent PR's own existing `fleet/review`
 * rather than from a second model call. See fleet-review-merge-group.test.ts
 * for the rails on that arm.
 */
describe('rail: every ruleset-15885614-required context reports on merge_group, except fleet/review', () => {
  const REQUIRED_CONTEXT_WORKFLOWS: Record<string, string> = {
    'ci-status': 'ci.yml',
    'fleet/verify': 'fleet-verify.yml',
    'fleet/review': 'fleet-review.yml',
    gitleaks: 'secret-scan.yml',
  }

  const workflowYaml = (file: string): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')

  /** Scoped to the workflow's own top-level `on:` block, before `jobs:` —
   *  `merge_group` also shows up in prose comments and job bodies (env vars,
   *  context field names), and this must only match the trigger itself. */
  function triggersOnMergeGroup(yaml: string): boolean {
    const onBlock = yaml.split(/\njobs:\n/)[0] ?? ''
    return /\n {2}merge_group:/.test(onBlock)
  }

  it('the mapping table itself is non-empty and covers the four merge_group-reporting contexts', () => {
    expect(Object.keys(REQUIRED_CONTEXT_WORKFLOWS).sort()).toEqual(
      ['ci-status', 'fleet/verify', 'fleet/review', 'gitleaks'].sort(),
    )
  })

  for (const [context, workflowFile] of Object.entries(REQUIRED_CONTEXT_WORKFLOWS)) {
    it(`"${context}" is produced by ${workflowFile}, which triggers on merge_group`, () => {
      expect(triggersOnMergeGroup(workflowYaml(workflowFile))).toBe(true)
    })
  }

  // #1187's regression guard, stated as its own assertion rather than left
  // implicit in the loop above: dropping `merge_group` from fleet-review.yml
  // breaks no run and no other test — it just silently deadlocks the queue
  // again, invisibly, the next time one is enabled.
  it('fleet/review (fleet-review.yml) triggers on merge_group — without it the queue stalls at AWAITING_CHECKS forever (#1187)', () => {
    expect(triggersOnMergeGroup(workflowYaml('fleet-review.yml'))).toBe(true)
  })
})

/**
 * The review engine's own turn/timeout budget (review.ts). #812's original
 * `DEFAULT_MAX_TURNS = 2` / `HIGH_IMPACT_MAX_TURNS = 3` (5-minute /
 * 8-minute wall clock) was sized for a THIN API CALL against a metered,
 * weekly-quota'd provider — a 20-turn/25-minute allowance was enough for one
 * review to explore the export at length rather than read the diff and file
 * list it was already handed, which burned quota faster per call than
 * moving off every-push saved per PR.
 *
 * The reviewer is now a full `claude` SESSION on a dedicated self-hosted
 * runner, on the operator's own Max subscription — the provider-quota
 * pressure that justified a 2-3-turn budget is gone, and a session that can
 * actually use its tools reviews better than one starved for turns. The
 * budget widened accordingly: 10 turns / 10-minute wall clock by default,
 * 20 turns / 20-minute wall clock for a high-impact diff. Pinned to the
 * actual exported numbers, not a description of them: a PR that quietly
 * raises or lowers these must fail THIS test, not just read wrong in a
 * comment. `fleet-review.yml`'s own `timeout-minutes` must stay above
 * `HIGH_IMPACT_TIMEOUT_MS`'s 20 minutes — asserted in the self-hosted-runner
 * rail above.
 */
describe('rail: the reviewer gets a full session\'s budget, not a thin API call\'s', () => {
  it('caps turns at the full-session budget (10 default / 20 high-impact)', () => {
    expect(DEFAULT_MAX_TURNS).toBe(10)
    expect(HIGH_IMPACT_MAX_TURNS).toBe(20)
    // High impact always gets AT LEAST as much room as the default —
    // pinned as an inequality too, so a mutation that flips the two values
    // relative to each other still fails even if it kept both numbers
    // individually "reasonable".
    expect(HIGH_IMPACT_MAX_TURNS).toBeGreaterThanOrEqual(DEFAULT_MAX_TURNS)
  })

  it('sets the wall-clock budget to 10 minutes default / 20 minutes high-impact', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10 * 60_000)
    expect(HIGH_IMPACT_TIMEOUT_MS).toBe(20 * 60_000)
    expect(HIGH_IMPACT_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_MS)
  })
})

describe('review-cache: pure key functions', () => {
  it('hashes deterministically, and differently for a different diff', () => {
    const a = diffHash('diff --git a/x b/x\n+hello\n')
    const b = diffHash('diff --git a/x b/x\n+hello\n')
    const c = diffHash('diff --git a/x b/x\n+goodbye\n')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names an artifact with only characters safe in a URL query param and an Actions artifact name', () => {
    const name = cacheArtifactName('42', diffHash('anything'))
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/)
    expect(name).toContain('42')
  })

  it('never names two different PRs\' identical diffs the same artifact', () => {
    const hash = diffHash('same diff content')
    expect(cacheArtifactName('1', hash)).not.toBe(cacheArtifactName('2', hash))
  })
})

/**
 * "Exactly one review per PR" — the operator addendum this rail pins. Tested
 * against `runReviewCi` directly with an injected in-memory `ReviewCache`,
 * never against the real `artifactReviewCache` (which talks to the Actions
 * API): the property under test is `ci.ts`'s OWN branching — look up before
 * invoking the engine, record only a fresh PASS, treat a lookup failure
 * exactly like a miss — not whether GitHub's artifact API works.
 */
describe('rail: fleet/review reviews exactly once per diff, never twice on an identical re-queue', () => {
  const lane = (): Lane => ({
    id: 'ios', mode: 'off', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
    scope: { owned: ['apps/ios/'], notOwned: [] },
  })
  const ctx = (): CiContext => ({
    branch: 'fleet/ios/123', repoDir: '/base', headDir: '/tmp/head',
    baseSha: 'base111', headSha: 'head222', pr: '42',
  })
  const passing: VerifyReport = {
    passed: true, reasons: [], changedFiles: ['apps/ios/a.swift'], addedLines: 3,
    impact: 'low', impactReasons: [], testsRun: ['orchestrator'], testsPassed: true, verifiedCommit: 'c0ffee',
  }

  /** An in-memory `ReviewCache`, seeded with zero or one PASS entries — never
   *  the real Actions-backed one, which this suite is not testing. */
  function fakeCache(seed?: { key: ReviewCacheKey; verdict: CachedVerdict }): ReviewCache & { recordCalls: number } {
    const store = new Map<string, CachedVerdict>()
    if (seed !== undefined) store.set(`${seed.key.pr}:${seed.key.diffHash}`, seed.verdict)
    const cache = {
      recordCalls: 0,
      async lookup(key: ReviewCacheKey) { return store.get(`${key.pr}:${key.diffHash}`) },
      async record(key: ReviewCacheKey, verdict: CachedVerdict) {
        cache.recordCalls += 1
        store.set(`${key.pr}:${key.diffHash}`, verdict)
      },
    }
    return cache
  }

  const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
    ctx: ctx(),
    apiKey: 'a-key',
    lanes: async () => [lane()],
    verify: vi.fn(async () => passing),
    pathExists: (p) => p !== '/tmp/head/.git',
    log: () => {},
    prDiff: vi.fn(async () => 'diff --git a/x b/x\n+hello\n'),
    secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'looks fine\nVERDICT: PASS' })),
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    resolveProfile: async (name: string) => ({ ok: true as const, profile: { agent: name, instructions: `be a ${name}` } }),
    stripExport: async () => {},
    publishReport: async () => {},
    profileReview: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' })),
    ...over,
  })

  it('records a fresh PASS exactly once', async () => {
    const cache = fakeCache()
    const v = await runReviewCi(deps({ cacheFor: () => cache }))
    expect(v.ok).toBe(true)
    expect(cache.recordCalls).toBe(1)
  })

  it('re-publishes a cached PASS for an identical diff instead of invoking the engine again', async () => {
    const diff = 'diff --git a/x b/x\n+hello\n'
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const secondOpinion = vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }))
    const v = await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => diff), secondOpinion }))
    expect(v.ok).toBe(true)
    expect(secondOpinion).not.toHaveBeenCalled()
  })

  // A re-queue after the queue rebases this PR onto a newer main changes the
  // head SHA but not the PR's own diff — the cache must still hit. Proven
  // here by feeding the SAME diff text through two calls with a DIFFERENT
  // ctx.headSha, rather than trusting that the key is diff-based by reading
  // the implementation.
  it('hits the cache across two different head SHAs, given the identical diff', async () => {
    const diff = 'diff --git a/x b/x\n+hello\n'
    const cache = fakeCache()
    const secondOpinion = vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }))
    await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => diff), secondOpinion, ctx: ctx() }))
    expect(secondOpinion).toHaveBeenCalledTimes(1)
    await runReviewCi(deps({
      cacheFor: () => cache, prDiff: vi.fn(async () => diff), secondOpinion,
      ctx: { ...ctx(), headSha: 'a-totally-different-rebased-head-sha' },
    }))
    expect(secondOpinion).toHaveBeenCalledTimes(1)
  })

  // #1158: a SUBSTANTIVE FAIL is reused, and this is the measured reason —
  // 60 Fleet Review runs in one 12-hour window, 10 on one failing PR and 8
  // on another, each re-reviewing an unchanged diff after a branch-freshness
  // rebase to reach the identical conclusion. The diff hash is what gates
  // it: the moment the author pushes anything, the cache is bypassed.
  it('reuses a substantive FAIL for an unchanged diff, instead of re-spending a review to reach the same answer', async () => {
    const diff = 'diff --git a/x b/x\n+bad\n'
    const cache = fakeCache()
    const failing = vi.fn(async () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL — leaks a key' }))
    const first = await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => diff), secondOpinion: failing }))
    expect(first.ok).toBe(false)
    expect(cache.recordCalls).toBe(1)

    const second = await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => diff), secondOpinion: failing }))
    expect(second.ok).toBe(false)
    expect(second.summary).toContain('leaks a key')
    expect(failing, 'the unchanged diff must not be reviewed a second time').toHaveBeenCalledTimes(1)
  })

  it('reviews again once the diff itself changes — the cache is keyed on content, not on the PR', async () => {
    const cache = fakeCache()
    const failing = vi.fn(async () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL — leaks a key' }))
    await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => 'v1'), secondOpinion: failing }))
    await runReviewCi(deps({ cacheFor: () => cache, prDiff: vi.fn(async () => 'v2 (a fix)'), secondOpinion: failing }))
    expect(failing).toHaveBeenCalledTimes(2)
  })

  // The line that must never be fudged: an UNREADABLE is not a verdict. A
  // bad model id, an outage or exhausted quota pinned to a diff hash would
  // hold the PR red until someone pushed a commit, for a reason that had
  // already gone away — far worse than the waste caching FAILs saves.
  it('NEVER caches an infrastructure failure — an UNREADABLE is retried every time', async () => {
    const cache = fakeCache()
    const unreadable = vi.fn(async () => ({
      verdict: 'UNREADABLE' as const, text: 'quota exhausted', failureKind: 'engine-unavailable' as const,
    }))
    const first = await runReviewCi(deps({ cacheFor: () => cache, secondOpinion: unreadable }))
    expect(first.ok).toBe(false)
    expect(cache.recordCalls).toBe(0)
    await runReviewCi(deps({ cacheFor: () => cache, secondOpinion: unreadable }))
    expect(unreadable).toHaveBeenCalledTimes(2)
  })

  // One UNREADABLE poisons the whole record, not only its own reviewer's:
  // the set's composed verdict is not a judgement of the diff if part of it
  // never ran.
  it('records nothing when ONE member of the set is UNREADABLE, even though another gave a real FAIL', async () => {
    const cache = fakeCache()
    const v = await runReviewCi(deps({
      cacheFor: () => cache,
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [] }),
      secondOpinion: async () => ({ verdict: 'FAIL', text: 'VERDICT: FAIL — real finding' }),
      profileReview: async () => ({ verdict: 'UNREADABLE', text: 'engine died', failureKind: 'engine-unavailable' }),
    }))
    expect(v.ok).toBe(false)
    expect(cache.recordCalls).toBe(0)
  })

  // "If the lookup errors, run the engine (fail safe)." A cache whose lookup
  // throws must never be mistaken for a cache that found nothing AND must
  // never be mistaken for a cache that found a PASS — the only safe
  // direction is to run the engine, exactly like a real miss.
  it('runs the engine when the cache lookup throws, rather than failing the job or assuming a pass', async () => {
    const cache: ReviewCache = {
      lookup: vi.fn(async () => { throw new Error('artifacts API rate limited') }),
      record: vi.fn(async () => {}),
    }
    const secondOpinion = vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }))
    const v = await runReviewCi(deps({ cacheFor: () => cache, secondOpinion }))
    expect(v.ok).toBe(true)
    expect(secondOpinion).toHaveBeenCalledTimes(1)
  })

  // A cache record failure must not un-pass a review the engine already
  // passed — recording is a courtesy to the NEXT run, not a gate on this one.
  it('still returns the fresh PASS even when recording it fails', async () => {
    const cache: ReviewCache = {
      lookup: vi.fn(async () => undefined),
      record: vi.fn(async () => { throw new Error('disk full') }),
    }
    const v = await runReviewCi(deps({ cacheFor: () => cache }))
    expect(v.ok).toBe(true)
  })

  // No `cache` at all (the default before this existed, and any call site
  // that never heard of one) must behave exactly as it always did: review
  // every time, no lookup, no record.
  it('behaves exactly as before when no cache is wired in at all', async () => {
    const secondOpinion = vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }))
    const v = await runReviewCi(deps({ secondOpinion }))
    expect(v.ok).toBe(true)
    expect(secondOpinion).toHaveBeenCalledTimes(1)
  })
})

/**
 * `decideReviewGate` is what `fleet-review.yml`'s "Decide whether to run the
 * review engine" step calls — the runtime logic behind the three branches
 * the file header (and the YAML rails above) describe. Those YAML rails pin
 * the WIRING (which steps key off `outcome == 'run-engine'`, that no
 * job-level `if:` exists); these pin the DECISION ITSELF — the same
 * bootstrap-order split as the CLI: `review-gate` (#851) needs this decision
 * on the base ref before `fleet-review.yml` (#848) can call it — so a
 * mutation that keeps the wiring intact but flips the logic — e.g.
 * concluding `run-engine` when `requested` is false, or `not-requested` when
 * a cache hit exists — still fails a test, even before any workflow YAML
 * exists to call it. Mirrors the `fakeCache` pattern from the "reviews
 * exactly once per diff" rail above, deliberately not shared with it: that
 * suite exercises `runReviewCi`'s full pipeline (verify, secondOpinion,
 * recording); this one exercises only the preflight decision, with no
 * `verify`/`secondOpinion` in sight — a passing test here cannot be mistaken
 * for a passing review.
 */
describe('rail: decideReviewGate enforces the four fleet/review branches (cache-hit / low-tier / not-requested / run-engine)', () => {
  const ctx = (): CiContext => ({
    branch: 'fleet/ios/123', repoDir: '/base', headDir: '/tmp/head',
    baseSha: 'base111', headSha: 'head222', pr: '42',
  })

  function fakeCache(seed?: { key: ReviewCacheKey; verdict: CachedVerdict }): ReviewCache {
    const store = new Map<string, CachedVerdict>()
    if (seed !== undefined) store.set(`${seed.key.pr}:${seed.key.diffHash}`, seed.verdict)
    return {
      async lookup(key: ReviewCacheKey) { return store.get(`${key.pr}:${key.diffHash}`) },
      async record() { /* decideReviewGate never records — only runReviewCi does */ },
    }
  }

  const diff = 'diff --git a/x b/x\n+hello\n'
  // No `-reviewer` label and no crypto content — every branch below sees
  // the ordinary review set (the general reviewer alone), so the review-set
  // branch ahead of them never fires. `decideReviewSet`'s own fail-closed
  // behaviour is tested directly in specialist.test.ts.
  const generalOnly = async (): Promise<ReviewSetDecision> => ({ ok: true, profiles: [], fromLabels: [], reasons: [] })
  // A Tier 2 (default — not docs, not an instructions/tooling path) file, so
  // every pre-existing test below reaches the SAME cache-hit/not-requested/
  // run-engine branch it always has — the tier check must never change their
  // outcome, only add a new branch ahead of them.
  const tier2Files = async (): Promise<string[]> => ['x']

  // Branch (a): a cache hit concludes `cache-hit` regardless of whether this
  // event was the `review` label — an unrelated label event on an
  // already-reviewed diff must reuse the verdict, never fall through to
  // `not-requested` or `run-engine`. Proven with `requested: false`, the
  // harder of the two cases: a mutation that checked `requested` BEFORE the
  // cache would send this down the `not-requested` branch instead of
  // reusing the cached PASS.
  it('concludes cache-hit when a prior PASS exists, even when this event did not request a review', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('cache-hit')
  })

  // Branch (c): a cache miss on an event that did NOT request a review
  // fails closed — the exact regression this whole PR exists to prevent.
  it('concludes not-requested on a cache miss when this event did not request a review', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('not-requested')
  })

  // Branch (b): a cache miss on an event that DID request a review (the
  // `review` label, or workflow_dispatch) proceeds to the engine.
  it('concludes run-engine on a cache miss when this event requested a review', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('run-engine')
  })

  // Same fail-safe direction as `runReviewCi`'s own cache lookup: a lookup
  // that THROWS must never be mistaken for a hit, and must never crash the
  // step — it degrades to a miss, which then still respects `requested`.
  it('treats a throwing cache lookup as a miss, never a hit and never a crash', async () => {
    const cache: ReviewCache = {
      lookup: async () => { throw new Error('artifacts API rate limited') },
      record: async () => {},
    }
    const requestedOutcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(requestedOutcome.kind).toBe('run-engine')

    const unrequestedOutcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(unrequestedOutcome.kind).toBe('not-requested')
  })

  // The cache key is diff-content-based, matching `runReviewCi`'s own — a
  // hit for PR #42's diff must never leak into a decision for PR #7's
  // identical diff text.
  it('never cross-publishes a cache hit between two different PRs with the identical diff', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const outcome = await decideReviewGate({
      ctx: { ...ctx(), pr: '7' }, prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('not-requested')
  })

  // Branch (b') — the new one, ordered after cache-hit and before
  // not-requested/run-engine (impact tiers, orchestrator rule 2026-09-19): a
  // diff with no cached PASS whose every changed file is Tier 0 (docs) or
  // Tier 1 (instructions/tooling) concludes `low-tier`, never `not-requested`
  // — proven with `requested: false`, the harder case: a mutation that
  // checked `requested` BEFORE the tier would send a docs-only, unlabeled PR
  // down `not-requested` instead of letting it conclude on its own.
  it('concludes low-tier for a docs-only diff, even when this event did not request a review', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['docs/epics/EP01-foo.md'],
      cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('low-tier')
    if (outcome.kind === 'low-tier') {
      expect(outcome.tier).toBe(0)
      expect(outcome.reasons.join(' ')).toMatch(/docs\/epics\/EP01-foo\.md/)
    }
  })

  it('concludes low-tier for a verified-inert-data-only diff (Tier 1)', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['.editorconfig'],
      cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('low-tier')
    if (outcome.kind === 'low-tier') expect(outcome.tier).toBe(1)
  })

  // PR #870's SECOND fix, pinned at the decision-gate level (not just in
  // impact.test.ts's unit tests on `tierFor` directly): `eslint.config.js`
  // used to be a `TIER1_PATHS` member, which meant it concluded `low-tier`
  // here with ZERO CODEOWNERS coverage (verified against the tracked
  // `CODEOWNERS` file) — a lint CI step `import()`s and executes this file,
  // so a diff touching only it could disable the lint gate with no review
  // of any kind. It must now fall through to Tier 2 like any other
  // unmatched path, and reach `run-engine` once requested — never
  // `low-tier`, proven the same way the `.claude/agents/` regression above
  // is proven.
  it('a diff touching eslint.config.js never concludes low-tier — lint/format config can alter what a gate enforces', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['eslint.config.js'],
      cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('run-engine')
  })

  // PR #870's own fix, pinned at the decision-gate level (not just in
  // impact.test.ts's unit tests on `tierFor` directly): a diff touching
  // `.claude/agents/` — or any other agent-instruction path — must NEVER
  // conclude `low-tier`. Proven with `requested: false`, the case that
  // would previously have produced an unattended, no-review pass: before
  // the fix this concluded `low-tier` (tier 1); after the fix it must
  // fall through to `not-requested` — a red, fail-closed check, exactly
  // like any other Tier 2 diff nobody has labeled `review` yet.
  it('a diff touching .claude/agents/ never concludes low-tier — it is Tier 2, unconditionally', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['.claude/agents/backend-supervisor.md'],
      cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('not-requested')
  })

  // Same property, proven for the other three paths the PR #870 finding
  // named explicitly: `.claude/skills/`, `docs/superpowers/specs/`, and a
  // bare `CLAUDE.md` outside `.claude/`. Each must reach the engine once
  // requested — never conclude low-tier regardless of the label.
  it.each([
    '.claude/skills/fleet-review-and-merge/SKILL.md',
    'docs/superpowers/specs/2026-09-19-impact-tiers-addendum.md',
    'CLAUDE.md',
  ])('a diff touching %s reaches run-engine once requested — never low-tier', async (f) => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => [f],
      cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('run-engine')
  })

  // low-tier fires even when the event DID request a review: a Tier 0/1 diff
  // never needs the engine regardless of the label, so `requested: true`
  // must not somehow route it to `run-engine`.
  it('concludes low-tier for a docs-only diff even when this event DID request a review', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['docs/epics/EP01-foo.md'],
      cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('low-tier')
  })

  // A cached PASS still wins over a docs-only tier, matching the documented
  // order ("after the cached-PASS check, before the label check") — proves
  // `low-tier` is the SECOND check, not the first.
  it('a cache hit is still checked before the tier — cache-hit wins over an otherwise low-tier diff', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['docs/epics/EP01-foo.md'],
      cacheFor: () => cache, requested: false, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('cache-hit')
  })

  // A diff spanning tiers takes the HIGHEST tier it touches — a single Tier 2
  // file alongside a pile of docs must still reach the engine (or
  // not-requested), never `low-tier`.
  it('a mixed diff with even one Tier 2 file never concludes low-tier', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff,
      changedFiles: async () => ['docs/epics/EP01-foo.md', 'packages/crypto/src/lib.rs'],
      cacheFor: () => cache, requested: true, republishOnly: false, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('run-engine')
  })

  // ── #1284: the republish arm ───────────────────────────────────────────
  //
  // `fleet-review.yml` now also triggers on `pull_request: synchronize`, so
  // that a rebase — which moves the head SHA and strands the earned verdict
  // on the old one — gets the required `fleet/review` context back on the
  // new head without a human removing and re-adding the reviewer.
  //
  // The whole safety of that trigger is this: such an event may REPUBLISH a
  // verdict, and may never START one. The rails below are the enforcement.
  // They deliberately pass `requested: true` — the case a mutation would
  // reach — so that deleting `deps.republishOnly ||` from the gate's
  // not-requested branch (which is exactly the mutation that reopens the
  // every-push quota burn #812 fixed) fails here rather than in production.

  it('a push with an unchanged diff republishes the cached PASS — the whole point of the trigger', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files,
      cacheFor: () => cache, requested: false, republishOnly: true, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('cache-hit')
  })

  it('a push with an unchanged diff republishes a cached FAIL too — republishing is not synthesising a green', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'FAIL', text: 'VERDICT: FAIL — unsafe unwrap' },
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files,
      cacheFor: () => cache, requested: false, republishOnly: true, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('cache-hit')
    if (outcome.kind !== 'cache-hit') throw new Error('unreachable')
    expect(outcome.verdict.verdict).toBe('FAIL')
  })

  // The load-bearing one. A push that CHANGED the diff has nothing to
  // republish, and must never spend a model call — no matter what
  // `requested` says. Without the `republishOnly ||` guard in the gate this
  // returns `run-engine`, which is one model review per push on every open
  // PR.
  it('a push that changed the diff concludes not-requested, never run-engine, even when requested is true', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files,
      cacheFor: () => cache, requested: true, republishOnly: true, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('not-requested')
  })

  // A named reviewer profile must not be the loophole either: a labelled PR
  // outranks the tier heuristic, but it still cannot make a PUSH start a
  // review.
  it('a push never reaches run-engine even with a reviewer profile in the set', async () => {
    const cache = fakeCache()
    const withProfile = async (): Promise<ReviewSetDecision> => ({
      ok: true, profiles: ['crypto-security-reviewer'], fromLabels: ['crypto-security-reviewer'], reasons: ['label'],
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files,
      cacheFor: () => cache, requested: true, republishOnly: true, reviewSet: withProfile, log: () => {},
    })
    expect(outcome.kind).toBe('not-requested')
  })

  // A docs-only push still concludes green on its own terms — the tier
  // branch sits ahead of the request/republish branch and must stay there,
  // or an ordinary push to a docs PR would go red for no reason.
  it('a docs-only push still concludes low-tier, not not-requested', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['docs/epics/EP01-foo.md'],
      cacheFor: () => cache, requested: false, republishOnly: true, reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('low-tier')
  })

  // #1275's short-circuit survives the new arm, and this is the case it was
  // written for: Dependabot force-pushes on every rebase, which is precisely
  // a `synchronize`. Before #1284 that push orphaned the verdict and GitHub
  // emitted no new event, so the required context stayed absent forever.
  it('a Dependabot force-push still takes the bot-authored short-circuit', async () => {
    const cache = fakeCache()
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files,
      cacheFor: () => cache, requested: false, republishOnly: true, prAuthor: 'dependabot[bot]',
      reviewSet: generalOnly, log: () => {},
    })
    expect(outcome.kind).toBe('bot-authored')
  })

  // An unresolvable review set still fails closed ahead of everything, on a
  // push exactly as on a review request — "we could not work out what to
  // review" never becomes "nothing needed reviewing", and never becomes a
  // republished green either.
  it('a push with an unresolvable review set still concludes review-set-unresolved', async () => {
    const cache = fakeCache({
      key: { pr: '42', diffHash: diffHash(diff) },
      verdict: { verdict: 'PASS', text: 'VERDICT: PASS (cached)' },
    })
    const outcome = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: tier2Files, cacheFor: () => cache,
      requested: false, republishOnly: true,
      reviewSet: async () => ({ ok: false, reason: 'labels unreadable' }),
      log: () => {},
    })
    expect(outcome.kind).toBe('review-set-unresolved')
  })
})

/**
 * `isRepublishOnlyEvent` and `reviewRequestFor` over a `synchronize` event
 * (#1284) — the two functions that decide, from the raw workflow event
 * fields alone, that a push may republish but never start a review.
 *
 * Asserted directly rather than only through `decideReviewGate` because the
 * workflow hands these fields over as opaque `env:` strings: a rename of
 * `FLEET_REVIEW_EVENT_ACTION`, or a `reviewRequestFor` that stops noticing
 * the action, would leave the gate deciding a push was an ordinary
 * `pull_request` event with no reviewer named — the same red check, for the
 * wrong reason, and one `requested_reviewer` away from a model call.
 */
describe('rail: a push republishes a verdict and never starts one (#1284)', () => {
  const push = { eventName: 'pull_request', action: 'synchronize', requestedReviewer: undefined, branch: 'fleet/ios/1' }

  it('recognises a pull_request/synchronize as republish-only', () => {
    expect(isRepublishOnlyEvent(push)).toBe(true)
  })

  it('does not treat a review request, a dispatch or a merge_group as republish-only', () => {
    expect(isRepublishOnlyEvent({ eventName: 'pull_request', action: 'review_requested' })).toBe(false)
    expect(isRepublishOnlyEvent({ eventName: 'workflow_dispatch', action: undefined })).toBe(false)
    expect(isRepublishOnlyEvent({ eventName: 'merge_group', action: 'checks_requested' })).toBe(false)
    // The ACTION alone is never enough — a same-named action on another
    // event must not turn that event into a push.
    expect(isRepublishOnlyEvent({ eventName: 'merge_group', action: 'synchronize' })).toBe(false)
  })

  it('reviewRequestFor refuses a push, and says it is a push rather than blaming a missing reviewer', () => {
    const decision = reviewRequestFor(push)
    expect(decision.requested).toBe(false)
    if (decision.requested) throw new Error('unreachable')
    expect(decision.reason).toContain('push')
    expect(decision.reason).not.toContain('named no user')
  })

  // Even if GitHub ever put a `requested_reviewer` on a synchronize payload,
  // a push is still not a request. The action is checked BEFORE the login.
  it('a push naming a real trigger login is still not a review request', () => {
    const decision = reviewRequestFor({ ...push, requestedReviewer: REVIEW_REQUEST_LOGIN })
    expect(decision.requested).toBe(false)
  })

  it('reads the action from FLEET_REVIEW_EVENT_ACTION — the name fleet-review.yml sets', () => {
    const event = reviewRequestEventFromEnv(
      { FLEET_REVIEW_EVENT_NAME: 'pull_request', FLEET_REVIEW_EVENT_ACTION: 'synchronize' },
      'fleet/ios/1',
    )
    expect(isRepublishOnlyEvent(event)).toBe(true)
  })

  it('fleet-review.yml passes FLEET_REVIEW_EVENT_ACTION from github.event.action', () => {
    const yaml = readFileSync(join(process.cwd(), '.github', 'workflows', 'fleet-review.yml'), 'utf8')
    expect(yaml).toMatch(/FLEET_REVIEW_EVENT_ACTION:\s*\$\{\{\s*github\.event\.action\s*\}\}/)
  })
})

/**
 * `decideReviewGate` itself was never the bug (the suite above already
 * proved every one of its branches, including a throwing cache lookup,
 * degrades correctly). The real, observed failure — run 35403493398 on
 * #630, and the same run class on #626 — was one step earlier: `bun
 * orchestrator/src/cli.ts review-gate` a few steps into `fleet-review.yml`
 * assumes the BASE checkout it runs from has both `orchestrator/src/cli.ts`
 * and a `review-gate` command registered in it. GitHub does not refresh an
 * open PR's `base.sha` on every push to the base branch — only on a
 * synchronize/update event on the PR itself — so a PR nobody has touched in
 * days (dependabot PRs routinely sit for weeks) can carry a `base.sha` from
 * well before either landed on main, with nothing on the PR side having
 * removed anything.
 *
 * #630's base predated `orchestrator/src/cli.ts` entirely → bun's own
 * uncaught `error: Module not found`, no `outcome` output, job goes red
 * with no diagnostic. #626's base had `cli.ts` but predated `review-gate`
 * being registered in `HANDLERS` → `usage: llamenos-fleet <doctor|tick|...>`
 * (no `review-gate` in the list), exit 2, same result. Because the crash
 * happens INSIDE the gate step, the existing "Check the base provides the
 * gate" step (guarding `review-ci`, further down, `if:
 * steps.gate.outputs.outcome == 'run-engine'`) can never be reached to
 * explain either case — `outcome` was never set.
 *
 * This rail pins the fix: a NEW, unconditional step — "Check the base
 * provides the review gate itself" — runs BEFORE "Decide whether to run the
 * review engine" and checks both failure shapes in bash (the only language
 * that can run before bun has even confirmed `cli.ts` exists), turning a
 * bare crash into one clear, actionable message.
 */
describe('rail: a base-provides-the-gate check runs BEFORE the gate step ever invokes bun', () => {
  const fleetReviewYaml = (): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', 'fleet-review.yml'), 'utf8')

  const GUARD_STEP = '- name: Check the base provides the review gate itself'
  const GATE_STEP = '- name: Decide whether to run the review engine'

  function guardBlock(yaml: string): string {
    const guardIdx = yaml.indexOf(GUARD_STEP)
    const gateIdx = yaml.indexOf(GATE_STEP)
    expect(guardIdx, 'bootstrap guard step not found — the grep must not pass vacuously').toBeGreaterThan(-1)
    expect(gateIdx, 'gate step not found — the grep must not pass vacuously').toBeGreaterThan(-1)
    expect(guardIdx, 'the guard must run BEFORE the gate step it protects').toBeLessThan(gateIdx)
    return yaml.slice(guardIdx, gateIdx)
  }

  it('the guard step exists and precedes the gate step', () => {
    // guardBlock() itself asserts both existence and ordering — a non-throw
    // here already proves the property; this test names it explicitly so a
    // failure reads as "ordering broke", not as an assertion buried in a
    // helper used by every other test in this suite.
    expect(() => guardBlock(fleetReviewYaml())).not.toThrow()
  })

  it('the guard checks cli.ts exists BEFORE ever invoking bun on it — the exact shape of the #630 crash', () => {
    const block = guardBlock(fleetReviewYaml())
    const fileCheckIdx = block.indexOf('if [ ! -f orchestrator/src/cli.ts ]')
    const firstBunCallIdx = block.indexOf('bun orchestrator/src/cli.ts')
    expect(fileCheckIdx, 'no file-existence check found').toBeGreaterThan(-1)
    expect(firstBunCallIdx, 'no bun invocation found in the guard').toBeGreaterThan(-1)
    expect(fileCheckIdx).toBeLessThan(firstBunCallIdx)
  })

  it('the guard checks the base\'s usage output for "review-gate" — the exact shape of the #626 crash', () => {
    const block = guardBlock(fleetReviewYaml())
    expect(block).toContain('*review-gate*')
  })

  // Gated by nothing but the merge-queue arm — same reasoning as "Decide
  // whether to run the review engine" (see the rail on that step in the
  // `describe` above): a guard that only runs conditionally could be skipped
  // exactly when a stale base needs it most, so the ONE condition it may
  // carry is pinned literally. On `merge_group` there is no base checkout to
  // guard: that arm never invokes bun, never installs, and publishes the
  // constituent PR's own verdict instead (#1187).
  it('the guard step carries exactly one step-level if: — the merge-queue arm, and nothing else', () => {
    const block = guardBlock(fleetReviewYaml())
    const ifLines = block.split('\n').filter((l) => /^ {8}if:/.test(l))
    expect(ifLines).toEqual(["        if: github.event_name != 'merge_group'"])
  })

  it('the guard fails closed with an actionable message naming what to do next, for both crash shapes', () => {
    const block = guardBlock(fleetReviewYaml())
    expect(block).toMatch(/exit 1/)
    // #1158: re-running the gate means re-REQUESTING the review, not
    // re-applying a label — nothing fires on a label any more.
    expect(block).toContain('then re-request the review')
    expect(block).not.toContain('re-apply the \\`review\\` label')
  })
})

/**
 * #664: "a PR's changes should shape which checks matter." Before this fix,
 * every heavy ci.yml job (ios-build-test, crypto-tests, e2e, backend-bdd,
 * backend-unit, desktop-unit, android-build-test, migration-drift) ran on
 * every non-docs PR regardless of what it touched — an orchestrator-only or
 * Helm-only change spent a macOS runner on an iOS build (see the "Problem"
 * section of #664 for the real dependabot/#848/#851/#855/#857 incidents this
 * caused). The fix: one classification script
 * (.github/scripts/detect-changed-platforms.sh) computes per-platform flags
 * from the changed-file list, ci.yml's `changes` job feeds it the correct
 * diff range, and every heavy job gates on the platform(s) it actually needs.
 *
 * This rail has three parts:
 *  1. Run the classification script itself against the three scenarios the
 *     #664 PR body documents (a workflows-only change, an apps/ios/-only
 *     change, a packages/protocol/-only change) and, through it, assert
 *     which ci.yml jobs actually run vs. skip for each — the property the
 *     issue is about, not just "the script returns some string".
 *  2. Pin every gated job's job-level `if:` to its exact expected text —
 *     the mutation this exists to catch is deleting the `if:` entirely
 *     (making the job unconditional again), which part 1 alone would NOT
 *     catch for jobs whose flag happens to be true in every scenario tested.
 *  3. Confirm the `changes` job diffs against the real PR/merge-group base
 *     rather than `HEAD^`, and that all three workflows that need the path
 *     map call the same script rather than re-deriving their own copy.
 *
 * `ci-status` itself already has its own rail above (every required job
 * must report on merge_group) — that rail is about REPORTING, and is
 * satisfied equally by a job that runs and a job that is cleanly skipped.
 * This rail is about the separate property that #664 is actually for:
 * which of those two things happens for a given change.
 */
describe("rail: a PR's changes decide which ci.yml platform jobs run (#664)", () => {
  const CI_YAML_PATH = join(process.cwd(), '.github', 'workflows', 'ci.yml')
  const SCRIPT_PATH = join(process.cwd(), '.github', 'scripts', 'detect-changed-platforms.sh')

  function ciYaml(): string {
    return readFileSync(CI_YAML_PATH, 'utf8')
  }

  /** Same job-block-slicing convention as the rail above — from a job's own
   *  `  <name>:` line up to (but not including) the next job at the same
   *  two-space indentation. */
  function jobBlock(text: string, name: string): string {
    const jobHeaderRe = /\n {2}([a-zA-Z0-9_-]+):\n/g
    const starts: { name: string; index: number }[] = []
    for (const m of text.matchAll(jobHeaderRe)) starts.push({ name: m[1] as string, index: m.index })
    const at = starts.findIndex((s) => s.name === name)
    if (at === -1) throw new Error(`no "${name}:" job found in ci.yml — the grep must not pass vacuously`)
    const end = at + 1 < starts.length ? starts[at + 1]?.index : text.length
    return text.slice(starts[at]?.index, end)
  }

  /** The JOB-level `if:` — same convention as the rail above (four-space
   *  indentation, before `steps:`). */
  function jobLevelIf(block: string): string {
    const beforeSteps = block.split(/\n {4}steps:\n/)[0] ?? block
    return beforeSteps.match(/\n {4}if:\s*(.+)/)?.[1] ?? ''
  }

  /** Runs the REAL classification script against a synthetic changed-file
   *  list — the exact script ci.yml's, ios-e2e.yml's, and desktop-e2e.yml's
   *  own `changes` jobs all pipe their diff into. This is what makes the
   *  scenarios below assertions about the actual shipped script, not a
   *  reimplementation of it that could drift from what CI runs. */
  function classify(files: string[]): Record<string, string> {
    const stdout = execFileSync('bash', [SCRIPT_PATH], {
      input: files.join('\n') + '\n',
      encoding: 'utf8',
    })
    const outputs: Record<string, string> = {}
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      outputs[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return outputs
  }

  /** Evaluates a ci.yml job-level `if:` of the exact shape every gated job
   *  in this file uses today: empty (always runs), or one or more
   *  `needs.changes.outputs.<flag> == 'true'` terms OR'd together. Anything
   *  else throws rather than guessing — an unrecognized condition must fail
   *  loudly, not silently evaluate to "always runs" or "always skips". */
  function evalJobIf(ifExpr: string, outputs: Record<string, string>): boolean {
    if (ifExpr.trim() === '') return true
    return ifExpr.split('||').map((t) => t.trim()).some((term) => {
      const m = term.match(/^needs\.changes\.outputs\.([a-z_]+) == 'true'$/)
      if (m === null) throw new Error(`unrecognized if: term "${term}" — evalJobIf must not guess`)
      return outputs[m[1] as string] === 'true'
    })
  }

  const ALL_GATED_JOBS = [
    'ios-build-test', 'android-build-test', 'android-e2e', 'desktop-unit',
    'e2e', 'backend-bdd', 'backend-unit', 'crypto-tests', 'migration-drift',
    'ansible-validate', 'audit',
  ]

  it.each([
    [
      'a workflows-only change (not ci.yml itself)',
      ['.github/workflows/fleet-verify.yml'],
      [] as string[],
      ALL_GATED_JOBS,
    ],
    [
      'an apps/ios/-only change',
      ['apps/ios/Sources/App/Foo.swift'],
      ['ios-build-test'],
      ALL_GATED_JOBS.filter((j) => j !== 'ios-build-test'),
    ],
    [
      'a packages/protocol/-only change',
      ['packages/protocol/schemas/foo.ts'],
      ['ios-build-test', 'android-build-test', 'android-e2e', 'desktop-unit', 'e2e', 'backend-bdd', 'backend-unit', 'crypto-tests'],
      // `audit` stays scoped to dependency manifests even on a shared-dep
      // change that runs everything else — this PR touched neither
      // package.json nor bun.lock and must not be blocked by a pre-existing
      // advisory. `migration-drift` and `ansible-validate` run too (both
      // gate on `backend`, which a shared-dep change sets), so only `audit`
      // is expected to skip.
      ['audit'],
    ],
    [
      // Round 2 of #664's review (fleet/review on PR #862): a
      // packages/test-specs/-only change (the shared BDD feature corpus)
      // must RUN e2e, backend-bdd, and android-e2e — not skip them. Before
      // this fix, none of the three platform regexes matched
      // packages/test-specs/, so a PR that broke a feature file (or added
      // one with no matching step) merged with all three suites silently
      // skipped and ci-status green.
      'a packages/test-specs/-only change',
      ['packages/test-specs/features/security/foo.feature'],
      ['android-build-test', 'android-e2e', 'desktop-unit', 'e2e', 'backend-bdd', 'backend-unit', 'migration-drift', 'ansible-validate'],
      // `ios-build-test` and `crypto-tests` correctly skip — iOS doesn't
      // consume packages/test-specs/ yet (ios-e2e.yml stays dispatch-only
      // pending #661) and this touches no Rust. `audit` stays scoped to
      // dependency manifests.
      ['ios-build-test', 'crypto-tests', 'audit'],
    ],
  ])('%s: the right ci.yml jobs run and skip', (_name, files, expectRun, expectSkip) => {
    const outputs = classify(files as string[])
    const yaml = ciYaml()
    for (const job of expectRun as string[]) {
      const runs = evalJobIf(jobLevelIf(jobBlock(yaml, job)), outputs)
      expect(runs, `expected "${job}" to RUN for ${JSON.stringify(files)}; outputs=${JSON.stringify(outputs)}`).toBe(true)
    }
    for (const job of expectSkip as string[]) {
      const runs = evalJobIf(jobLevelIf(jobBlock(yaml, job)), outputs)
      expect(runs, `expected "${job}" to SKIP for ${JSON.stringify(files)}; outputs=${JSON.stringify(outputs)}`).toBe(false)
    }
  })

  // The mutation this rail exists to catch: delete a job's `if:` entirely
  // (so it runs unconditionally again). `evalJobIf('', outputs)` always
  // returns true, which the scenario table above would NOT catch for a job
  // whose flag happens to already be true in every scenario tested — this
  // pins the exact if: text instead, independent of any scenario.
  it.each([
    ['ios-build-test', "needs.changes.outputs.ios == 'true'"],
    ['android-build-test', "needs.changes.outputs.android == 'true'"],
    ['android-e2e', "needs.changes.outputs.android == 'true'"],
    ['desktop-unit', "needs.changes.outputs.desktop == 'true'"],
    ['crypto-tests', "needs.changes.outputs.crypto == 'true'"],
    ['migration-drift', "needs.changes.outputs.backend == 'true'"],
    ['backend-bdd', "needs.changes.outputs.backend == 'true'"],
    ['e2e', "needs.changes.outputs.desktop == 'true' || needs.changes.outputs.backend == 'true'"],
    ['backend-unit', "needs.changes.outputs.backend == 'true' || needs.changes.outputs.orchestrator == 'true'"],
    ['ansible-validate', "needs.changes.outputs.ansible == 'true' || needs.changes.outputs.backend == 'true'"],
    ['audit', "needs.changes.outputs.audit == 'true'"],
  ])('"%s" carries exactly the expected job-level if: — removing it must fail this test', (job, expected) => {
    expect(jobLevelIf(jobBlock(ciYaml(), job))).toBe(expected)
  })

  /**
   * Round 2 of #664's own review (fleet/review on PR #862): "the new path
   * map omits inputs that decide real checks." The scenario table above
   * only exercises three specific diffs — a path could be missing from the
   * map and still pass every scenario there, as long as none of the three
   * happened to touch it. This rail is narrower and more direct: for every
   * (job, file) pair below, that exact file is the ONLY change, and the
   * job must run. Each pair names a file a real PR would plausibly touch on
   * its own — a migration, a BDD feature, a step definition, the server
   * entry point, the Playwright config, the shared bootstrap action — and
   * pins it to the job whose verdict it can silently invalidate if skipped.
   * Removing any one of these paths from its regex in
   * detect-changed-platforms.sh makes the corresponding row fail.
   */
  it.each([
    ['migration-drift', 'drizzle.config.ts'],
    ['migration-drift', 'drizzle/migrations/0001_add_foo/migration.sql'],
    ['backend-bdd', 'drizzle.config.ts'],
    ['backend-bdd', 'tests/steps/backend/foo.steps.ts'],
    ['backend-bdd', 'packages/test-specs/features/security/foo.feature'],
    ['backend-bdd', 'src/server/index.ts'],
    ['backend-bdd', '.github/actions/bootstrap-backend/action.yml'],
    ['e2e', 'playwright.config.ts'],
    ['e2e', 'packages/test-specs/features/security/foo.feature'],
    ['e2e', 'src/server/index.ts'],
    ['android-e2e', 'packages/test-specs/features/platform/mobile/foo.feature'],
    ['android-e2e', '.github/actions/bootstrap-backend/action.yml'],
  ])('"%s" runs when its own input "%s" changes alone', (job, file) => {
    const outputs = classify([file])
    const runs = evalJobIf(jobLevelIf(jobBlock(ciYaml(), job)), outputs)
    expect(runs, `expected "${job}" to RUN when only "${file}" changes; outputs=${JSON.stringify(outputs)}`).toBe(true)
  })

  it('the changes job diffs against the PR/merge-group base sha, not HEAD^', () => {
    const block = jobBlock(ciYaml(), 'changes')
    expect(block).toContain('github.event.pull_request.base.sha')
    expect(block).toContain('github.event.merge_group.base_sha')
  })

  it('ci.yml, ios-e2e.yml and desktop-e2e.yml all call the one shared classification script — no second copy of the path map', () => {
    for (const file of ['ci.yml', 'ios-e2e.yml', 'desktop-e2e.yml']) {
      const yaml = readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')
      expect(yaml, `${file} does not call detect-changed-platforms.sh`).toContain('detect-changed-platforms.sh')
    }
  })

  /**
   * The iOS TIER (#1225 made ios-e2e a required check; the tier landed after).
   * `ios` stays a blast-radius flag — true for every SHARED_DEPS_RE hit — and
   * the tier only decides HOW MUCH of the suite runs. These rails exist because
   * the failure mode is silent: a tier that wrongly says `smoke`, or a default
   * that resolves to `smoke`, shrinks a merge gate without turning it red.
   */
  it.each([
    ['apps/ios/Sources/App.swift', 'full'],
    ['apps/ios/Tests/UI/AuthFlowUITests.swift', 'full'],
    ['packages/crypto/src/lib.rs', 'full'],
    ['packages/protocol/schemas/foo.ts', 'full'],
    ['packages/i18n/locales/en.json', 'full'],
    ['.github/workflows/ci.yml', 'full'],
    ['.github/workflows/ios-e2e.yml', 'full'],
    ['.github/scripts/detect-changed-platforms.sh', 'full'],
    ['scripts/dev-bun.sh', 'smoke'],
    ['package.json', 'smoke'],
    ['tsconfig.json', 'smoke'],
    ['apps/worker/routes/foo.ts', 'none'],
    ['README.md', 'none'],
  ])('"%s" alone earns iOS tier "%s"', (file, tier) => {
    const outputs = classify([file as string])
    expect(outputs['ios_tier'], `outputs=${JSON.stringify(outputs)}`).toBe(tier)
    // The tier never contradicts the flag the job's `if:` actually gates on.
    expect(outputs['ios']).toBe(tier === 'none' ? 'false' : 'true')
  })

  it('a full-tier file anywhere in the diff wins over smoke-tier files', () => {
    expect(classify(['scripts/dev-bun.sh', 'apps/ios/Sources/App.swift'])['ios_tier']).toBe('full')
    expect(classify(['apps/ios/Sources/App.swift', 'scripts/dev-bun.sh'])['ios_tier']).toBe('full')
  })

  it('ci.yml hands ios-e2e.yml the tier the script chose, and gates on `ios`, not on the tier', () => {
    const block = jobBlock(ciYaml(), 'ios-e2e')
    expect(block, 'ci.yml does not pass ios_tier through').toContain('needs.changes.outputs.ios_tier')
    expect(jobLevelIf(block), 'ios-e2e must run whenever iOS is reachable at all')
      .toContain("needs.changes.outputs.ios == 'true'")
  })

  it('ios-e2e.yml defaults its tier to full — an unset or unknown tier must never narrow the gate', () => {
    const yaml = readFileSync(join(process.cwd(), '.github', 'workflows', 'ios-e2e.yml'), 'utf8')
    // Assert the default on the `workflow_call` input SPECIFICALLY — that is
    // the one ci.yml uses. A bare `toContain('default: full')` is satisfied by
    // the unrelated workflow_dispatch input and passes while workflow_call
    // silently defaults to smoke (verified: that injection went undetected).
    // Same string-slicing convention the rails above use, rather than pulling
    // in a YAML parser: take the `  workflow_call:` block up to the next
    // two-space key, then that block's `tier:` input up to the next input.
    const callBlock = yaml.match(/\n {2}workflow_call:\n((?: {4,}.*\n|\n)*)/)?.[1] ?? ''
    expect(callBlock, 'ios-e2e.yml has no workflow_call block').not.toBe('')
    const tierBlock = callBlock.match(/\n? {6}tier:\n((?: {8,}.*\n|\n)*)/)?.[1] ?? ''
    expect(tierBlock, 'workflow_call declares no `tier` input').not.toBe('')
    expect(tierBlock, 'the workflow_call tier default must be full').toMatch(/^ {8}default: full$/m)
    // Only the literal string `smoke` may select the reduced matrix or --only-smoke.
    expect(yaml).toMatch(/inputs\.tier == 'smoke'/)
    expect(yaml).toContain('if [ "$IOS_TIER" = "smoke" ]; then extra+=(--only-smoke); fi')
  })

  it('the smoke tier is a declared whitelist that still covers the day-one flows', () => {
    const list = readFileSync(join(process.cwd(), 'apps', 'ios', 'Tests', 'UI', 'ci-smoke.txt'), 'utf8')
    const classes = list.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/)[0])
    for (const required of ['AuthFlowUITests', 'ActiveCallUITests', 'NoteFlowUITests', 'ShiftFlowUITests']) {
      expect(classes, `smoke tier must cover ${required} — onboarding, calls, notes and shifts are the day-one flows`)
        .toContain(required)
    }
  })

  /**
   * Dependabot auto-approval. The approval itself merges nothing — all five
   * required contexts and strict-up-to-date still gate the merge — so these
   * rails guard the two things that WOULD matter: that the approver cannot be
   * rewritten by the PR it is approving, and that it waits for `fleet/review`
   * (which is what keeps a `.github/workflows/` bump, Tier 2 via
   * HIGH_IMPACT_PATHS, from sailing through unreviewed).
   */
  const autoApproveYaml = (): string =>
    readFileSync(join(process.cwd(), '.github', 'workflows', 'dependabot-auto-approve.yml'), 'utf8')

  it('the Dependabot approver runs from the base branch, never the PR it is approving', () => {
    const yaml = autoApproveYaml()
    const onBlock = yaml.split(/\njobs:\n/)[0] ?? ''
    expect(onBlock, 'must trigger on workflow_run — every open Dependabot PR edits .github/workflows/, so a pull_request trigger would let a bump rewrite its own approver')
      .toContain('workflow_run:')
    expect(onBlock, 'a pull_request trigger would run the PR\'s own copy of this file')
      .not.toMatch(/\n {2}pull_request(_target)?:/)
  })

  it('the Dependabot approver approves only Dependabot PRs', () => {
    expect(autoApproveYaml(), 'missing the author guard').toContain('dependabot[bot]')
  })

  it('the Dependabot approver judges the LATEST COMPLETED fleet/review, not an arbitrary one', () => {
    // A head commit routinely carries several fleet/review runs (every
    // re-request adds one). Taking [0] can read a stale PASS that a later
    // FAIL supersedes — the same hazard fleet-review.yml's queue check
    // already guards with sort_by(.completed_at)|last.
    const yaml = autoApproveYaml()
    expect(yaml, 'must sort by completed_at and take the last, not index [0]')
      .toMatch(/sort_by\(\.completed_at\)/)
    expect(yaml, 'must filter to completed runs before judging').toMatch(/status == "completed"/)
    const runLines = yaml.split('\n').filter((l) => !l.trim().startsWith('#'))
    expect(runLines.join('\n'), 'indexing [0] into the check-run list is the stale-verdict bug')
      .not.toMatch(/select\(\.name == "fleet\/review"\)\]\[0\]/)
  })

  it('the Dependabot approver waits for a green fleet/review', () => {
    const yaml = autoApproveYaml()
    expect(yaml, 'must read the fleet/review check').toContain('fleet/review')
    // The guard must compare against success specifically — "not failure"
    // would treat an ABSENT review (the normal state of an unreviewed Tier 2
    // bump) as permission to approve.
    expect(yaml, 'must require fleet/review == success, not merely "not failed"')
      .toMatch(/"\$review" != "success"/)
  })

  it('the Dependabot approver never merges — a human lands the supply-chain update', () => {
    // fleet/review refused the auto-merging version twice. The second refusal
    // was the substantive one: every Dependabot bump IS Tier 2 and does get a
    // model review, but a model reading a lockfile diff sees version numbers
    // and hashes, never the code the registry publishes. Diff-level review is
    // structurally blind to supply-chain payloads, so the human Merge press is
    // the real checkpoint. Re-adding auto-merge re-opens that.
    const yaml = autoApproveYaml()
    const runLines = yaml.split('\n').filter((l) => !l.trim().startsWith('#'))
    expect(runLines.join('\n'), 'auto-merge must not come back — approve only')
      .not.toMatch(/gh pr merge/)
    expect(runLines.join('\n'), '--auto would let a bump land with no human decision')
      .not.toMatch(/--auto\b/)
  })

  it('the Dependabot approver uses the collaborator PAT — github-actions[bot] cannot satisfy the unattributed-changes rule', () => {
    const yaml = autoApproveYaml()
    expect(yaml).toContain('secrets.RELEASE_BOT_TOKEN')
    expect(yaml, 'GITHUB_TOKEN as GH_TOKEN would post an approval that does not count')
      .not.toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN/)
  })

  it('desktop-e2e.yml carries no workflow-level pull_request paths: filter — that shape breaks a future required check', () => {
    const yaml = readFileSync(join(process.cwd(), '.github', 'workflows', 'desktop-e2e.yml'), 'utf8')
    const onBlock = yaml.split(/\njobs:\n/)[0] ?? ''
    const pullRequestBlock = onBlock.match(/\n {2}pull_request:\n((?:\n| {4,}.*\n)*)/)?.[0] ?? '\n  pull_request:\n'
    expect(pullRequestBlock).not.toContain('paths:')
  })
})

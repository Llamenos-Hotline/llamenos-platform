import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  queueRunPr, latestQueueAttempts,
  mergeQueueConfigFromRules, isEjectedOrNeverArmed, iosQueueBlock,
  reviewCoverageFor, runQueueFeedWith, renderQueueFeed,
  type QueueFeedDeps, type QueueFeedPr, type MergeGroupRun,
} from '../../orchestrator/src/queue-feed.js'
import {
  attributeJob, ownDiffFailures, QUEUE_ONLY_JOB_FLAGS, AGGREGATE_JOB_NAMES,
  type PlatformFlags, type RunJob,
} from '../../orchestrator/src/queue-attempt.js'
import { cacheArtifactName, reviewSetTag } from '../../orchestrator/src/review-cache.js'
import { claimDigest } from '../../orchestrator/src/review.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'

const TREE = 'a'.repeat(40)
const OTHER_TREE = 'c'.repeat(40)
const HEAD = 'b'.repeat(40)

const NO_FLAGS: PlatformFlags = { ios: false, android: false, desktop: false, backend: false, crypto: false }

function mkPr(overrides: Partial<QueueFeedPr> = {}): QueueFeedPr {
  return {
    number: 100,
    headRefOid: HEAD,
    headRefName: 'fleet/backend/100',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    isDraft: false,
    labels: [],
    claim: { title: 'a PR', body: 'does a thing' },
    description: 'a PR\n\ndoes a thing',
    author: 'octocat',
    ...overrides,
  }
}

/** Deps whose every read is a controllable stub; the defaults describe an
 *  empty, readable repo with a 5-min/5-max queue rule on main. */
function mkDeps(overrides: Partial<QueueFeedDeps> = {}): QueueFeedDeps {
  return {
    checkHalt: async () => ({ halted: false }),
    listOpenPrNumbers: async () => [],
    readPr: async () => undefined,
    readPrFiles: async () => ['apps/worker/routes/x.ts'],
    readPrDiff: async () => undefined,
    readHeadTree: async () => TREE,
    readPrCommits: async () => undefined,
    listQueueEntries: async () => ({ queue: true, prs: [] }),
    fetchBranchRules: async () => [{
      type: 'merge_queue',
      parameters: {
        min_entries_to_merge: 5, max_entries_to_merge: 5,
        grouping_strategy: 'ALLGREEN', check_response_timeout_minutes: 240,
      },
    }],
    verdictArtifactState: async () => 'absent',
    resolveReviewer: async (name) => ({ ok: true, profile: { name } as never }),
    platformFlags: async () => ({ ...NO_FLAGS, backend: true }),
    readKnopeToml: async () => undefined,
    listMergeGroupRuns: async () => [],
    readRunJobs: async () => [],
    readWorkflowFile: async () => undefined,
    listRecentWorkflowRuns: async () => [],
    listPrComments: async () => [],
    postPrComment: async () => {},
    enableAutoMerge: async () => {},
    log: () => {},
    ...overrides,
  }
}

const GROUP_SHA = 'e'.repeat(40)

/** A completed merge_group run of `pr`'s group — CI by default. */
function mkRun(id: number, conclusion: string, overrides: Partial<MergeGroupRun> = {}): MergeGroupRun {
  return {
    id, conclusion,
    headBranch: `gh-readonly-queue/main/pr-100-${'d'.repeat(40)}`,
    headSha: GROUP_SHA,
    path: '.github/workflows/ci.yml',
    createdAt: '2026-11-05T15:15:19Z',
    ...overrides,
  }
}

/** A job that ran for `seconds`, ending at `end`. */
function mkJob(name: string, conclusion: string, seconds: number, end = '2026-11-05T15:30:00Z'): RunJob {
  const e = Date.parse(end)
  return { name, conclusion, startedAt: new Date(e - seconds * 1000).toISOString(), completedAt: new Date(e).toISOString(), steps: [] }
}

describe('queueRunPr — the merge-group branch grammar', () => {
  it('parses the group tail out of a queue branch', () => {
    expect(queueRunPr(`gh-readonly-queue/main/pr-2425-${'d'.repeat(40)}`)).toEqual({ base: 'main', pr: 2425 })
  })

  it('keeps slashes in the base branch', () => {
    expect(queueRunPr(`gh-readonly-queue/release/1.x/pr-7-${'d'.repeat(40)}`)).toEqual({ base: 'release/1.x', pr: 7 })
  })

  it('refuses anything that is not a queue branch', () => {
    expect(queueRunPr('main')).toBeUndefined()
    expect(queueRunPr(`gh-readonly-queue/main/pr-2425-${'d'.repeat(39)}`)).toBeUndefined() // 39-hex is not a commit
    expect(queueRunPr('gh-readonly-queue/main/pr-abc-' + 'd'.repeat(40))).toBeUndefined()
  })
})

describe('latestQueueAttempts — the newest attempt wins, per branch, judged as ALL its runs', () => {
  const sha = 'd'.repeat(40)
  const runs: MergeGroupRun[] = [
    mkRun(3, 'failure', { headSha: '3'.repeat(40), createdAt: '2026-11-05T17:00:00Z' }), // newest attempt
    mkRun(2, 'success', { headSha: '2'.repeat(40), createdAt: '2026-11-05T16:00:00Z' }),
    mkRun(1, 'failure', { headBranch: `gh-readonly-queue/other/pr-100-${sha}`, headSha: '1'.repeat(40) }), // another base
  ]

  it('returns the newest attempt naming each PR on the branch', () => {
    const attempts = latestQueueAttempts(runs, 'main')
    expect(attempts.get(100)?.runs.map((r) => r.id)).toEqual([3])
    expect(attempts.get(100)?.succeeded).toBe(false)
  })

  it('orders attempts by createdAt, never by list position', () => {
    const attempts = latestQueueAttempts([...runs].reverse(), 'main')
    expect(attempts.get(100)?.runs.map((r) => r.id)).toEqual([3])
  })

  it('ignores runs against a different base branch', () => {
    expect(latestQueueAttempts(runs, 'other').get(100)?.runs.map((r) => r.id)).toEqual([1])
    expect(latestQueueAttempts(runs, 'main').has(7)).toBe(false)
  })

  it('an attempt is EVERY run of its group commit — a green CodeQL run never stands for a red CI run', () => {
    // The live #2467 shape: one group commit, ~7 workflows, CI cancelled.
    const group = [
      mkRun(11, 'success', { path: '.github/workflows/codeql.yml' }),
      mkRun(12, 'cancelled'),
      mkRun(13, 'success', { path: '.github/workflows/fleet-verify.yml' }),
    ]
    const attempt = latestQueueAttempts(group, 'main').get(100)
    expect(attempt?.runs.map((r) => r.id).sort()).toEqual([11, 12, 13])
    expect(attempt?.succeeded).toBe(false)
    expect(latestQueueAttempts([group[0] as MergeGroupRun, group[2] as MergeGroupRun], 'main').get(100)?.succeeded).toBe(true)
  })
})

describe('attributeJob / ownDiffFailures — the not-a-retry guard', () => {
  it('maps a called-workflow job name to the platform flags that schedule it', () => {
    expect(attributeJob('ios-build-test')).toEqual({ kind: 'platforms', flags: ['ios'] })
    expect(attributeJob('ios-e2e / build (mac)')).toEqual({ kind: 'platforms', flags: ['ios'] })
    expect(attributeJob('backend-bdd')).toEqual({ kind: 'platforms', flags: ['backend'] })
  })

  it('an aggregate job names no culprit', () => {
    for (const name of AGGREGATE_JOB_NAMES) {
      expect(attributeJob(name).kind, `${name} must never attribute`).toBe('aggregate')
    }
    expect(ownDiffFailures(['ci-status'], NO_FLAGS)).toEqual([])
  })

  it('an unknown job attributes to EVERY candidate — the closed direction', () => {
    expect(attributeJob('some-new-job').kind).toBe('unknown')
    expect(ownDiffFailures(['some-new-job'], NO_FLAGS)).toEqual(['some-new-job'])
  })

  it('an iOS shard failing under a backend-only diff is NOT the diff\'s fault', () => {
    expect(ownDiffFailures(['ios-build-test', 'ios-e2e / build (mac)'], { ...NO_FLAGS, backend: true })).toEqual([])
  })

  it('a failed shard the diff WOULD have scheduled is the diff\'s fault', () => {
    expect(ownDiffFailures(['backend-bdd', 'ios-build-test'], { ...NO_FLAGS, backend: true })).toEqual(['backend-bdd'])
    expect(ownDiffFailures(['ios-e2e / e2e'], { ...NO_FLAGS, ios: true })).toEqual(['ios-e2e / e2e'])
  })
})

describe('mergeQueueConfigFromRules — the ruleset read, reduced', () => {
  it('extracts the merge_queue rule', () => {
    const config = mergeQueueConfigFromRules([
      { type: 'pull_request', parameters: {} },
      { type: 'merge_queue', parameters: { min_entries_to_merge: 5, max_entries_to_merge: 5, grouping_strategy: 'ALLGREEN' } },
    ])
    expect(config).toEqual({ minEntriesToMerge: 5, maxEntriesToMerge: 5, groupingStrategy: 'ALLGREEN' })
  })

  it('a branch with no merge_queue rule has no queue to feed', () => {
    expect(mergeQueueConfigFromRules([{ type: 'pull_request', parameters: {} }])).toBeUndefined()
    expect(mergeQueueConfigFromRules([])).toBeUndefined()
    expect(mergeQueueConfigFromRules('not an array')).toBeUndefined()
  })

  it('a malformed merge_queue rule is no rule — never a guessed one', () => {
    expect(mergeQueueConfigFromRules([{ type: 'merge_queue', parameters: { grouping_strategy: 'ALLGREEN' } }])).toBeUndefined()
  })
})

describe('isEjectedOrNeverArmed — the eject detector, every term pinned', () => {
  const queued = new Set([100])

  it('CLEAN + unarmed + not queued: stranded, feed it', () => {
    expect(isEjectedOrNeverArmed(mkPr(), new Set())).toBe(true)
  })

  it('autoMergeRequest == null ALONE is not an eject signal: a queued PR reports it too', () => {
    expect(isEjectedOrNeverArmed(mkPr(), queued)).toBe(false)
  })

  it('not CLEAN (the per-PR read): not eligible, whatever the queue says', () => {
    expect(isEjectedOrNeverArmed(mkPr({ mergeStateStatus: 'BLOCKED' }), new Set())).toBe(false)
    expect(isEjectedOrNeverArmed(mkPr({ mergeStateStatus: 'DIRTY' }), new Set())).toBe(false)
  })

  it('armed (autoMergeRequest set): en route on GitHub\'s own schedule — leave it alone', () => {
    expect(isEjectedOrNeverArmed(mkPr({ autoMergeRequest: { enabledAt: 'x' } }), new Set())).toBe(false)
  })
})

describe('iosQueueBlock — an iOS-UI-test PR forms its own group', () => {
  const iosFlags: PlatformFlags = { ...NO_FLAGS, ios: true }

  it('a non-iOS PR is never blocked by this rule', () => {
    expect(iosQueueBlock({ ...NO_FLAGS, backend: true }, 3, 2)).toBeUndefined()
  })

  it('an iOS PR may enter an EMPTY queue as the pass\'s ONLY selection', () => {
    expect(iosQueueBlock(iosFlags, 0, 0)).toBeUndefined()
  })

  it('an iOS PR is never batched behind work already queued', () => {
    expect(iosQueueBlock(iosFlags, 1, 0)).toMatch(/never batched behind/)
  })

  it('an iOS PR is never batched with this pass\'s other selections', () => {
    expect(iosQueueBlock(iosFlags, 0, 1)).toMatch(/forms its own group/)
  })
})

describe('reviewCoverageFor — requirement 2, verified not inferred', () => {
  const passArtifact = (pr: QueueFeedPr, profiles: string[] = []) =>
    cacheArtifactName(String(pr.number), TREE, claimDigest(pr.claim), reviewSetTag(profiles), 'PASS')
  const failArtifact = (pr: QueueFeedPr, profiles: string[] = []) =>
    cacheArtifactName(String(pr.number), TREE, claimDigest(pr.claim), reviewSetTag(profiles), 'FAIL')

  it('a PASS artifact for this exact tree and claim covers the head', async () => {
    const pr = mkPr()
    const deps = mkDeps({
      verdictArtifactState: async (name) => (name === passArtifact(pr) ? 'present' : 'absent'),
    })
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(true)
  })

  it('a recorded FAIL for this exact tree and claim forbids every green', async () => {
    const pr = mkPr()
    const deps = mkDeps({
      verdictArtifactState: async (name) => (name === failArtifact(pr) ? 'present' : 'absent'),
    })
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(false)
    expect((coverage as { reason: string }).reason).toMatch(/FAIL is recorded/)
  })

  it('a FAIL recorded against ANOTHER tree does not block this one', async () => {
    const pr = mkPr()
    const deps = mkDeps({ verdictArtifactState: async () => 'absent' })
    // Other tree's FAIL: the name differs by tree, so 'absent' for both lookups
    // here; the coverage then falls through to the tier green (worker routes
    // are Tier 2 — force a low-tier diff to conclude covered).
    const coverage = await reviewCoverageFor(pr, ['docs/notes.md'], TREE, deps)
    expect(coverage.covered).toBe(true)
    expect((coverage as { via: string }).via).toMatch(/low-tier/)
  })

  it('an unreadable verdict cache is not a PASS and not an absence', async () => {
    const pr = mkPr()
    const deps = mkDeps({ verdictArtifactState: async () => 'unreadable' })
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(false)
    expect((coverage as { reason: string }).reason).toMatch(/could not be read/)
  })

  it('a PASS for a DIFFERENT tree covers nothing — the tree is in the name', async () => {
    const pr = mkPr()
    const stalePass = cacheArtifactName(String(pr.number), OTHER_TREE, claimDigest(pr.claim), undefined, 'PASS')
    const deps = mkDeps({
      verdictArtifactState: async (name) => (name === stalePass ? 'present' : 'absent'),
    })
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(false)
  })

  it('with no artifact, a low-tier diff needs no review — the gate\'s own rule', async () => {
    const pr = mkPr()
    const coverage = await reviewCoverageFor(pr, ['docs/notes.md'], TREE, mkDeps())
    expect(coverage.covered).toBe(true)
    expect((coverage as { via: string }).via).toMatch(/low-tier/)
  })

  it('a named reviewer outranks the tier: a low-tier diff WITH a profile still needs its verdict', async () => {
    const pr = mkPr({ labels: ['crypto-security-reviewer'] })
    const coverage = await reviewCoverageFor(pr, ['docs/notes.md'], TREE, mkDeps())
    expect(coverage.covered).toBe(false)
    expect((coverage as { reason: string }).reason).toMatch(/no PASS covers this head/)
  })

  it('a content-derived profile (crypto paths) outranks the tier too', async () => {
    const pr = mkPr()
    const coverage = await reviewCoverageFor(pr, ['packages/crypto/src/hpke.rs'], TREE, mkDeps())
    expect(coverage.covered).toBe(false)
  })

  it('a dependabot PR whose commits are all the bot\'s, signed, ending at the head, needs no review', async () => {
    const pr = mkPr({ author: 'dependabot[bot]' })
    const deps = mkDeps({
      readPrCommits: async () => [
        { sha: HEAD, authorLogin: 'dependabot[bot]', committerLogin: 'dependabot[bot]', verified: true },
      ],
    })
    const coverage = await reviewCoverageFor(pr, ['bun.lock'], TREE, deps)
    expect(coverage.covered).toBe(true)
    expect((coverage as { via: string }).via).toMatch(/bot-authored/)
  })

  it('a dependabot-AUTHORED PR carrying a human\'s commit is not the bot green', async () => {
    const pr = mkPr({ author: 'dependabot[bot]' })
    const deps = mkDeps({
      readPrCommits: async () => [
        { sha: HEAD, authorLogin: 'dependabot[bot]', committerLogin: 'dependabot[bot]', verified: true },
        { sha: 'e'.repeat(40), authorLogin: 'a-human', committerLogin: 'a-human', verified: true },
      ],
    })
    // apps/worker files are Tier 2, so the tier green cannot save it either.
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(false)
  })

  it('an undecidable review set is a refusal, never an empty worklist', async () => {
    const pr = mkPr({ labels: ['not-a-real-reviewer'] })
    const deps = mkDeps({ resolveReviewer: async () => ({ ok: false, reason: 'no such agent' }) })
    const coverage = await reviewCoverageFor(pr, ['apps/worker/routes/x.ts'], TREE, deps)
    expect(coverage.covered).toBe(false)
    expect((coverage as { reason: string }).reason).toMatch(/review set could not be decided/)
  })

  it('an unreadable head tree falls through to the no-review-needed rules, never to a cached green', async () => {
    const pr = mkPr()
    const coverage = await reviewCoverageFor(pr, ['docs/notes.md'], undefined, mkDeps())
    expect(coverage.covered).toBe(true) // via low-tier, NOT via any artifact
    expect((coverage as { via: string }).via).toMatch(/low-tier/)
  })

  it('the knope release PR is covered by its shape, re-derived from a fresh diff', async () => {
    const pr = mkPr({ headRefName: KNOPE_RELEASE_BRANCH })
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1 +1 @@',
      '-  "version": "1.0.0",',
      '+  "version": "1.0.1",',
    ].join('\n')
    const deps = mkDeps({
      readPrDiff: async () => diff,
      readKnopeToml: async () => '[package]\nversioned_files = [\n  "package.json",\n]\n',
    })
    const coverage = await reviewCoverageFor(pr, ['package.json'], TREE, deps)
    expect(coverage.covered).toBe(true)
    expect((coverage as { via: string }).via).toMatch(/release-pr/)
  })
})

describe('runQueueFeedWith — the pass', () => {
  it('a halted fleet feeds nothing — the halt switches stop everything the fleet does', async () => {
    const listOpenPrNumbers = vi.fn()
    const deps = mkDeps({ checkHalt: async () => ({ halted: true, reason: 'operator stop' }), listOpenPrNumbers })
    const result = await runQueueFeedWith(deps)
    expect(result.halted).toBe(true)
    expect(listOpenPrNumbers).not.toHaveBeenCalled()
    expect(renderQueueFeed(result)).toMatch(/HALTED/)
  })

  it('an unreadable open-PR list is undecidable — exit 2, not a quiet pass', async () => {
    const result = await runQueueFeedWith(mkDeps({ listOpenPrNumbers: async () => undefined }))
    expect(result.undecidable.length).toBeGreaterThan(0)
    expect(renderQueueFeed(result)).toMatch(/CANNOT DECIDE/)
  })

  it('a branch with no merge_queue rule has no queue to feed', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: false }),
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('no-queue')
    expect(result.undecidable).toEqual([])
  })

  it('an unreadable queue read is undecidable — ejected and queued are indistinguishable without it', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => undefined,
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('unreadable')
    expect(result.undecidable).toEqual(['main'])
  })

  it('a throwing ruleset read is undecidable, never an empty rule list', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      fetchBranchRules: async () => { throw new Error('boom') },
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('unreadable')
    expect(result.undecidable).toEqual(['main'])
  })

  it('a queue already at min_entries_to_merge is satisfied — nothing to do', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [1, 2, 3, 4, 5] }),
      readPrFiles: async () => ['apps/worker/routes/x.ts'],
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('satisfied')
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('fills the deficit toward min_entries_to_merge, ascending, through the one arming call', async () => {
    const armed: string[] = []
    const pr = (n: number) => mkPr({ number: n, headRefName: `fleet/backend/${n}` })
    const prs = [100, 101, 102]
    const deps = mkDeps({
      listOpenPrNumbers: async () => prs.map((n) => ({ number: n, baseRefName: 'main' })),
      readPr: async (n) => prs.includes(n) ? pr(n) : undefined,
      readPrFiles: async (n) => [`apps/worker/routes/file-${n}.ts`],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100', '101', '102'])
    expect(result.branches[0]?.armed).toEqual([100, 101, 102])
    expect(result.undecidable).toEqual([])
  })

  it('never substitutes the stale list verdict: a per-PR read of BLOCKED is not armed', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr({ mergeStateStatus: 'BLOCKED' }),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.armed).toEqual([])
  })

  it('a failed per-PR read is a skip with the reason named, not a stale-list substitute', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => undefined,
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/per-PR read failed/)
  })

  it('a PR already in the queue is left alone (entering consumed its auto-merge request)', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [100] }),
      readPr: async () => mkPr(),
      readPrFiles: async () => ['apps/worker/routes/x.ts'],
      enableAutoMerge,
    })
    await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('a PR whose last queue attempt failed on its OWN shard is a defect to fix, not a retry', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const sha = 'd'.repeat(40)
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr(),
      readPrFiles: async () => ['apps/worker/routes/x.ts'],
      platformFlags: async () => ({ ...NO_FLAGS, backend: true }),
      listMergeGroupRuns: async () => [mkRun(42, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}` })],
      readRunJobs: async () => [mkJob('backend-bdd', 'failure', 300), mkJob('ci-status', 'failure', 7)],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/defect to fix, not a retry/)
  })

  it('a PR whose last queue attempt failed on a SIBLING\'s shard is the ejection this feed exists for', async () => {
    const armed: string[] = []
    const sha = 'd'.repeat(40)
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr(),
      readPrFiles: async () => ['apps/worker/routes/x.ts'],
      platformFlags: async () => ({ ...NO_FLAGS, backend: true }),
      listMergeGroupRuns: async () => [mkRun(42, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}` })],
      readRunJobs: async () => [ // the live #2425 shape
        mkJob('ios-build-test', 'failure', 600), mkJob('ios-e2e / build (mac)', 'failure', 900), mkJob('ci-status', 'failure', 7),
      ],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.notes.some((n) => n.includes('ejected by a sibling or a flake'))).toBe(true)
  })

  it('a last attempt whose failing jobs cannot be read cannot rule out its own diff — skipped', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const sha = 'd'.repeat(40)
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr(),
      listMergeGroupRuns: async () => [mkRun(42, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}` })],
      readRunJobs: async () => undefined,
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/could not be read/)
  })

  it('an unreadable merge_group run list makes the whole branch undecidable — no gambling on retries', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr(),
      listMergeGroupRuns: async () => undefined,
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('unreadable')
    expect(result.undecidable).toEqual(['main'])
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('requirement 3: a candidate touching a QUEUED PR\'s file is skipped (ALLGREEN conflict)', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 200, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/backend/${n}` }),
      readPrFiles: async () => ['apps/worker/routes/shared.ts'],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/already in the queue/)
  })

  it('requirement 3: two same-pass candidates touching one file — only the first queues', async () => {
    const armed: string[] = []
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/backend/${n}` }),
      readPrFiles: async () => ['apps/worker/routes/shared.ts'],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.skipped[0]?.pr).toBe(101)
  })

  it('unprovable disjointness against a queued PR decides NOTHING for the branch', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 200, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      readPrFiles: async (n) => (n === 200 ? undefined : ['apps/worker/routes/x.ts']),
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/backend/${n}` }),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.outcome).toBe('unreadable')
    expect(enableAutoMerge).not.toHaveBeenCalled()
  })

  it('requirement 4: an iOS-UI-test PR is not batched behind a queue with entries', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 200, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/ios/${n}` }),
      readPrFiles: async (n) => (n === 200 ? ['apps/worker/routes/queued.ts'] : ['apps/ios/Sources/App/X.swift']),
      platformFlags: async () => ({ ...NO_FLAGS, ios: true }),
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.skipped.some((s) => s.reason.includes('never batched behind'))).toBe(true)
  })

  it('requirement 4: an iOS-UI-test PR queued into an EMPTY queue ends the pass\'s selections', async () => {
    const armed: string[] = []
    // 100 is the iOS PR (lowest number → first), 101 is backend work.
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/x/${n}` }),
      readPrFiles: async (n) => (n === 100 ? ['apps/ios/Sources/App/X.swift'] : ['apps/worker/routes/y.ts']),
      platformFlags: async (files) => files.some((f) => f.startsWith('apps/ios/'))
        ? { ...NO_FLAGS, ios: true }
        : { ...NO_FLAGS, backend: true },
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100']) // the iOS PR alone; 101 never even considered
    expect(result.branches[0]?.armed).toEqual([100])
  })

  it('a failed arming call is counted separately and changes nothing', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      readPr: async () => mkPr(),
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async () => { throw new Error('graphQL: refused') },
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches[0]?.armed).toEqual([])
    expect(result.branches[0]?.armFailed).toEqual([100])
  })

  it('PRs against different base branches feed independently', async () => {
    const deps = mkDeps({
      listOpenPrNumbers: async () => [
        { number: 100, baseRefName: 'main' },
        { number: 101, baseRefName: 'release-1.x' },
      ],
      listQueueEntries: async () => ({ queue: false }),
    })
    const result = await runQueueFeedWith(deps)
    expect(result.branches.map((b) => b.branch)).toEqual(['main', 'release-1.x'])
  })
})

describe('rail: QUEUE_ONLY_JOB_FLAGS names exactly the revalidate-gated jobs of ci.yml', () => {
  interface WorkflowDoc { jobs?: Record<string, { if?: unknown }> }
  const doc = parseYaml(readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')) as WorkflowDoc
  const jobs = doc.jobs ?? {}
  const OUTPUT_RE = /needs\.changes\.outputs\.([a-z0-9_]+)\s*==\s*'true'/g

  const gated: Record<string, string[]> = {}
  for (const [name, job] of Object.entries(jobs)) {
    const cond = typeof job.if === 'string' ? job.if : ''
    const outputs = [...cond.matchAll(OUTPUT_RE)].map((m) => m[1] ?? '')
    if (!outputs.includes('revalidate')) continue
    gated[name] = outputs.filter((o) => o !== 'revalidate').sort()
  }

  it('the parser found the gated jobs — a silent-empty table would pass vacuously', () => {
    expect(Object.keys(gated).sort()).toEqual([
      'android-build-test', 'android-e2e', 'backend-bdd', 'backend-bdd-opt-in',
      'desktop-e2e', 'e2e', 'ios-build-test', 'ios-e2e',
    ])
  })

  it('every revalidate-gated job is in the attribution map with exactly its other platform flags', () => {
    for (const [name, flags] of Object.entries(gated)) {
      expect(
        [...(QUEUE_ONLY_JOB_FLAGS[name] ?? [])].sort(),
        `ci.yml job "${name}" is revalidate-gated on [${flags.join(', ')}] but the map says otherwise — ` +
        'a failed queue shard would be attributed to the wrong PRs (or to all of them)',
      ).toEqual(flags)
    }
  })

  it('the attribution map names no job ci.yml does not revalidate-gate', () => {
    for (const name of Object.keys(QUEUE_ONLY_JOB_FLAGS)) {
      expect(gated[name], `"${name}" is in the attribution map but is not revalidate-gated in ci.yml`).toBeDefined()
    }
  })

  it('aggregate jobs never appear in the attribution map', () => {
    for (const name of AGGREGATE_JOB_NAMES) {
      expect(QUEUE_ONLY_JOB_FLAGS[name]).toBeUndefined()
    }
  })
})

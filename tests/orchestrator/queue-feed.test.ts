import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  queueRunPr, latestQueueAttempts,
  mergeQueueConfigFromRules, mergeQueueConfigFindings, isEjectedOrNeverArmed, iosQueueBlock,
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
import { gitThreeWayMerge } from '../../orchestrator/src/merge-sim.js'

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
    readMergeBase: async () => undefined,
    readFileAt: async () => undefined,
    readBranchHead: async () => undefined,
    readBlobAt: async () => undefined,
    mergeContents: gitThreeWayMerge,
    readKnopeToml: async () => undefined,
    listMergeGroupRuns: async () => [],
    readRunJobs: async () => [],
    readWorkflowFile: async () => undefined,
    listRecentWorkflowRuns: async () => [],
    readJobAnnotations: async () => [],
    readHeadFirstSeen: async () => undefined,
    listPrComments: async () => [],
    postPrComment: async () => {},
    lastQueueEvent: async () => 'none',
    addQueueClearedLabel: async () => {},
    removeQueueClearedLabel: async () => {},
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
  return { nodeId: 'CR_1', name, conclusion, startedAt: new Date(e - seconds * 1000).toISOString(), completedAt: new Date(e).toISOString(), steps: [] }
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

describe('mergeQueueConfigFindings — dead merge-queue config is said out loud (#2656)', () => {
  const live = { minEntriesToMerge: 5, maxEntriesToMerge: 5, groupingStrategy: 'ALLGREEN', maxEntriesToBuild: 1, minEntriesToMergeWaitMinutes: 5 }

  it('the live ruleset (build 1, min 5, max 5) is reported dead, with the timer as the only release', () => {
    const f = mergeQueueConfigFindings(live)
    expect(f.some((x) => x.startsWith('DEAD CONFIG') && x.includes('min_entries_to_merge=5') && x.includes('max_entries_to_build=1') && x.includes('5 min wait timer'))).toBe(true)
    expect(f.some((x) => x.includes('build concurrency is 1'))).toBe(true)
  })

  it('a minimum no larger than build concurrency is reachable — not dead', () => {
    expect(mergeQueueConfigFindings({ ...live, maxEntriesToBuild: 5 })).toEqual([])
    expect(mergeQueueConfigFindings({ ...live, minEntriesToMerge: 1, maxEntriesToBuild: 3 })).toEqual([])
  })

  it('build 1 with min 1 is serial but not dead config', () => {
    const f = mergeQueueConfigFindings({ ...live, minEntriesToMerge: 1 })
    expect(f.some((x) => x.startsWith('DEAD CONFIG'))).toBe(false)
    expect(f.some((x) => x.includes('build concurrency is 1'))).toBe(true)
  })

  it('a rule that omits max_entries_to_build is unjudged, not assumed dead', () => {
    const { maxEntriesToBuild: _omit, ...noBuild } = live
    const f = mergeQueueConfigFindings(noBuild)
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('cannot be judged')
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

  it('carries build concurrency and the wait timer when the rule has them (#2656)', () => {
    const config = mergeQueueConfigFromRules([
      { type: 'merge_queue', parameters: { min_entries_to_merge: 5, max_entries_to_merge: 5, grouping_strategy: 'ALLGREEN', max_entries_to_build: 1, min_entries_to_merge_wait_minutes: 5 } },
    ])
    expect(config).toEqual({ minEntriesToMerge: 5, maxEntriesToMerge: 5, groupingStrategy: 'ALLGREEN', maxEntriesToBuild: 1, minEntriesToMergeWaitMinutes: 5 })
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

describe('iosQueueBlock — an iOS-gate-risk PR forms its own group', () => {
  const risky = { isolate: true as const, reasons: ['apps/ios/Tests/UI/X.swift: an iOS UI test or its harness'] }

  it('a PR that does not schedule the iOS gate is never blocked by this rule', () => {
    expect(iosQueueBlock(undefined, 3, 2)).toBeUndefined()
  })

  it('a PR that schedules the gate but cannot change its verdict is batched like any other (#2548)', () => {
    expect(iosQueueBlock({ isolate: false, checked: ['apps/ios/Sources/App/Info.plist'] }, 3, 2)).toBeUndefined()
  })

  it('an iOS-gate-risk PR may enter an EMPTY queue as the pass\'s ONLY selection', () => {
    expect(iosQueueBlock(risky, 0, 0)).toBeUndefined()
  })

  it('an iOS-gate-risk PR is never batched behind work already queued — and says which file made it risky', () => {
    expect(iosQueueBlock(risky, 1, 0)).toMatch(/never batched behind.*apps\/ios\/Tests\/UI\/X\.swift/)
  })

  it('an iOS-gate-risk PR is never batched with this pass\'s other selections', () => {
    expect(iosQueueBlock(risky, 0, 1)).toMatch(/forms its own group/)
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

  /**
   * #2732. Nothing arms a fleet PR at open any more, so a PR is born with
   * `autoMergeRequest: null`. The safety property is that it is not stranded:
   * this feed holds it back while the queue is deep (the bound arm-at-open
   * lacked) and arms it on the first pass that finds room.
   */
  it('a fleet PR born unarmed waits while the queue is deep, then is armed once there is room (#2732)', async () => {
    const armed: string[] = []
    let queue = [1, 2, 3, 4, 5]
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: queue }),
      readPr: async () => mkPr({ headRefName: 'fleet/backend/100', autoMergeRequest: null }),
      readPrFiles: async (n) => [`apps/worker/routes/file-${n}.ts`],
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })

    expect((await runQueueFeedWith(deps)).branches[0]?.outcome).toBe('satisfied')
    expect(armed, 'armed while the queue was at depth — the unbounded behaviour').toEqual([])

    queue = [1, 2]
    const second = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(second.branches[0]?.armed).toEqual([100])
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

  // Requirement 3 (#2570): a shared file is a conflict only when git's own
  // three-way merge says so. The fixture is the live 2026-11-07 shape: four
  // open PRs whose ONLY shared file was package.json — a release version
  // bump (#2555), a script added further down (#2562), and two PRs appending
  // to the same `test:repo` line (#2532, #2563). Whole-file disjointness let
  // one of the four into a group; git merges three of them.
  const PKG_BASE = [
    '{',
    '  "name": "llamenos",',
    '  "version": "0.21.7",',
    '  "private": true,',
    '  "scripts": {',
    '    "test:fleet": "bunx vitest run --config vitest.orchestrator.config.ts",',
    '    "test:repo": "bun test packages/shared/__tests__/ scripts/lib/test-reporter.test.ts",',
    '    "test:sip-bridge": "cd sip-bridge && bunx vitest run",',
    '    "i18n:validate:all": "bun run packages/i18n/tools/validate-strings.ts all",',
    '    "codegen": "bun run packages/protocol/tools/codegen.ts",',
    '    "codegen:check": "bun run packages/protocol/tools/codegen.ts --check",',
    '    "migration:check": "bun scripts/check-migration-drift.ts"',
    '  }',
    '}',
    '',
  ].join('\n')
  const PKG_EDITS: Record<number, (s: string) => string> = {
    2532: (s) => s.replace('test-reporter.test.ts"', 'test-reporter.test.ts scripts/ci/mac-runner-disk-guard.test.ts"'),
    2555: (s) => s.replace('"version": "0.21.7"', '"version": "0.21.8"'),
    2562: (s) => s.replace('--check",\n', '--check",\n    "agents:build": "bash .claude/agents/build-agents.sh",\n'),
    2563: (s) => s.replace('test-reporter.test.ts"', 'test-reporter.test.ts scripts/ci/apt-install-bounded.test.ts"'),
  }
  const MB = '0'.repeat(40)
  const TIP = '1'.repeat(40)
  const headOf = (n: number): string => String(n).padStart(40, 'a')

  /** A repo where every PR forks from MB, main's tip is TIP, and each PR's
   *  head holds `edits[n]` applied to `base` for `path`. */
  function mergeRepo(path: string, base: string, edits: Record<number, (s: string) => string>, tip = base): Partial<QueueFeedDeps> {
    const heads = new Map(Object.keys(edits).map((n) => [headOf(Number(n)), Number(n)]))
    return {
      readPr: async (n) => mkPr({ number: n, headRefOid: headOf(n), headRefName: `fleet/x/${n}` }),
      readPrFiles: async () => [path],
      readBranchHead: async () => TIP,
      readMergeBase: async () => MB,
      readBlobAt: async (p, sha) => {
        if (p !== path) return undefined
        if (sha === MB) return base
        if (sha === TIP) return tip
        const n = heads.get(sha)
        return n === undefined ? undefined : edits[n]?.(base)
      },
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
    }
  }

  it('requirement 3 (#2570): the live package.json clique — git merges three of the four into one group', async () => {
    const armed: string[] = []
    const deps = mkDeps({
      ...mergeRepo('package.json', PKG_BASE, PKG_EDITS),
      listOpenPrNumbers: async () => [2532, 2555, 2562, 2563].map((number) => ({ number, baseRefName: 'main' })),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['2532', '2555', '2562'])
    expect(result.branches[0]?.notes.some((n) => n.startsWith('pr 2562: shares package.json') && n.endsWith('— batchable'))).toBe(true)
    expect(result.branches[0]?.skipped).toEqual([{
      pr: 2563,
      reason: 'its change to package.json does not merge onto main + #2532 + #2555 + #2562 (git\'s own three-way merge, the group replayed in queue order) — under ALLGREEN one conflict fails the whole group',
    }])
  })

  it('requirement 3 (#2570): a candidate whose change conflicts with a QUEUED PR\'s is skipped', async () => {
    const enableAutoMerge = vi.fn(async () => {})
    const deps = mkDeps({
      ...mergeRepo('package.json', PKG_BASE, { 200: PKG_EDITS[2532] as (s: string) => string, 100: PKG_EDITS[2563] as (s: string) => string }),
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 200, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      enableAutoMerge,
    })
    const result = await runQueueFeedWith(deps)
    expect(enableAutoMerge).not.toHaveBeenCalled()
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/^its change to package\.json does not merge onto main \+ #200 /)
  })

  it('requirement 3 (#2570): a candidate whose change merges with a QUEUED PR\'s joins its group', async () => {
    const armed: string[] = []
    const deps = mkDeps({
      ...mergeRepo('package.json', PKG_BASE, { 200: PKG_EDITS[2555] as (s: string) => string, 100: PKG_EDITS[2563] as (s: string) => string }),
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 200, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
  })

  it('requirement 3 (#2570): the group is replayed onto the base TIP, not the PRs\' fork point', async () => {
    // main moved on after both PRs forked: the tip already carries a line
    // that 101's change would collide with. Against the fork point the two
    // PRs merge; against the tip — what GitHub actually builds — they do not.
    const armed: string[] = []
    const tip = PKG_BASE.replace('"private": true,', '"private": true,\n  "description": "x",')
    const deps = mkDeps({
      ...mergeRepo('package.json', PKG_BASE, {
        100: PKG_EDITS[2562] as (s: string) => string,
        101: (s) => s.replace('"private": true,', '"private": true,\n  "license": "AGPL-3.0-or-later",'),
      }, tip),
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/^its change to package\.json does not merge onto main \+ #100 /)
  })

  it('requirement 3 (#2570): a shared file that cannot be simulated is a conflict — nothing is predicted', async () => {
    const armed: string[] = []
    // Readable everywhere except main's tip (failed read, or a file main
    // deleted): the group's content is unknown, so 101 is refused.
    const deps = mkDeps({
      ...mergeRepo('package.json', PKG_BASE, { 100: PKG_EDITS[2555] as (s: string) => string, 101: PKG_EDITS[2562] as (s: string) => string }),
      readBranchHead: async () => undefined,
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/the merge cannot be simulated: the main tip could not be read — an unprovable merge is treated as a conflict$/)
  })

  it('requirement 3 (#2570): a file one side adds (absent at its merge base) is never simulated as a modify/modify merge', async () => {
    const armed: string[] = []
    const repo = mergeRepo('package.json', PKG_BASE, { 100: PKG_EDITS[2555] as (s: string) => string, 101: PKG_EDITS[2562] as (s: string) => string })
    const deps = mkDeps({
      ...repo,
      readBlobAt: async (p, sha) => (sha === MB ? undefined : await repo.readBlobAt?.(p, sha)),
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/package\.json could not be read at #100's merge base \(or is added, deleted or renamed there\)/)
  })

  it('requirement 3 (#2570): an ordinary source file both PRs rewrite still conflicts', async () => {
    const armed: string[] = []
    const src = 'export function f() {\n  return 1\n}\n'
    const deps = mkDeps({
      ...mergeRepo('apps/worker/routes/shared.ts', src, {
        100: (s) => s.replace('return 1', 'return 2'),
        101: (s) => s.replace('return 1', 'return 3'),
      }),
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100'])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/^its change to apps\/worker\/routes\/shared\.ts does not merge onto main \+ #100 /)
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

  it('requirement 4: an iOS-gate-risk PR is not batched behind a queue with entries', async () => {
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

  it('requirement 4: an iOS-gate-risk PR queued into an EMPTY queue ends the pass\'s selections', async () => {
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

  it('requirement 4 (#2548): a PR that SCHEDULES the iOS gate but only bumps the version is batched behind queued work', async () => {
    const armed: string[] = []
    const plist = '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.21.7</string>\n\t<key>CFBundleVersion</key>\n\t<string>1</string>\n</dict>\n'
    const base = 'f'.repeat(40)
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }, { number: 101, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/x/${n}` }),
      readPrFiles: async (n) => (n === 100 ? ['apps/ios/Sources/App/Info.plist', 'CHANGELOG.md'] : n === 101 ? ['apps/worker/routes/y.ts'] : ['apps/worker/routes/queued.ts']),
      platformFlags: async (files) => files.some((f) => f.startsWith('apps/ios/')) ? { ...NO_FLAGS, ios: true } : { ...NO_FLAGS, backend: true },
      readMergeBase: async () => base,
      readFileAt: async (path, sha) => (path === 'apps/ios/Sources/App/Info.plist'
        ? (sha === base ? plist : plist.replace('0.21.7', '0.21.8'))
        : undefined),
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual(['100', '101'])
    expect(result.branches[0]?.notes.some((n) => n.startsWith('pr 100: schedules the iOS gate, but nothing in its diff can change'))).toBe(true)
  })

  it('requirement 4 (#2548): the same PR is isolated when its Info.plist change is more than the version', async () => {
    const armed: string[] = []
    const plist = '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.21.7</string>\n</dict>\n'
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: [200] }),
      readPr: async (n) => mkPr({ number: n, headRefName: `fleet/x/${n}` }),
      readPrFiles: async (n) => (n === 100 ? ['apps/ios/Sources/App/Info.plist'] : ['apps/worker/routes/queued.ts']),
      platformFlags: async () => ({ ...NO_FLAGS, ios: true }),
      readMergeBase: async () => 'f'.repeat(40),
      readFileAt: async (_path, sha) => (sha === 'f'.repeat(40) ? plist : plist.replace('</dict>', '\t<key>NSAppTransportSecurity</key>\n\t<dict/>\n</dict>')),
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      enableAutoMerge: async (p) => { armed.push(p) },
    })
    const result = await runQueueFeedWith(deps)
    expect(armed).toEqual([])
    expect(result.branches[0]?.skipped.find((s) => s.pr === 100)?.reason).toMatch(/never batched behind.*Info\.plist: changes more than/)
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

describe('a deep queue still restores EJECTED entries — add and re-arm are different actions (#2619)', () => {
  /** A queue already at min = max = 5, so no NEW entry may be added. */
  const QUEUED = [1, 2, 3, 4, 5]
  const GUARD_JOB = (conclusion: string): RunJob => ({ ...mkJob('fleet/verify', conclusion, 12), nodeId: 'CR_guard' })

  interface Scenario {
    pr?: Partial<QueueFeedPr>
    lastQueueEvent?: 'added' | 'removed' | 'none' | undefined
    overrides?: Partial<QueueFeedDeps>
  }
  function deepQueue(sc: Scenario = {}) {
    const armed: string[] = []
    const labelled: number[] = []
    const unlabelled: number[] = []
    const order: string[] = []
    const logs: string[] = []
    const lastQueueEvent = vi.fn(async () => ('lastQueueEvent' in sc ? sc.lastQueueEvent : 'removed'))
    const readPrFiles = vi.fn(async (n: number) => [`apps/worker/routes/file-${n}.ts`])
    const deps = mkDeps({
      listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
      listQueueEntries: async () => ({ queue: true, prs: QUEUED }),
      readPr: async () => mkPr(sc.pr),
      readPrFiles,
      verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
      lastQueueEvent,
      addQueueClearedLabel: async (n) => { labelled.push(n); order.push('label') },
      removeQueueClearedLabel: async (n) => { unlabelled.push(n) },
      enableAutoMerge: async (p) => { armed.push(p); order.push('arm') },
      log: (m) => { logs.push(m) },
      ...sc.overrides,
    })
    return { deps, armed, labelled, unlabelled, order, logs, lastQueueEvent, readPrFiles }
  }

  it('RE-ARMS a green, mergeable PR the queue dropped, though the queue is already full', async () => {
    const t = deepQueue()
    const result = await runQueueFeedWith(t.deps)
    expect(result.branches[0]?.outcome).toBe('satisfied') // no NEW entry may be added …
    expect(t.armed).toEqual(['100']) // … and the ejected one is restored anyway
    expect(result.branches[0]?.armed).toEqual([100])
    expect(result.branches[0]?.rearmed).toEqual([100])
    expect(renderQueueFeed(result)).toMatch(/RE-ARMED\s+#100/)
  })

  it('does NOT add a PR the queue never admitted — that is what the depth bound is for', async () => {
    for (const lastQueueEvent of ['none', 'added', undefined] as const) {
      const t = deepQueue({ lastQueueEvent })
      const result = await runQueueFeedWith(t.deps)
      expect(t.armed, `history ${String(lastQueueEvent)}`).toEqual([])
      expect(result.branches[0]?.rearmed).toEqual([])
      expect(result.branches[0]?.notes.join('\n')).toMatch(/never admitted to the queue were not added/)
    }
  })

  it('an unreadable queue history is a new addition, never an ejection', async () => {
    const t = deepQueue({ lastQueueEvent: undefined })
    await runQueueFeedWith(t.deps)
    expect(t.logs.join('\n')).toMatch(/merge-queue history could not be read/)
    expect(t.armed).toEqual([])
  })

  it('arms nothing it cannot show green and mergeable: BLOCKED, DRAFT, already armed, or still queued are left alone', async () => {
    const cases: [string, Partial<QueueFeedPr>][] = [
      ['blocked', { mergeStateStatus: 'BLOCKED' }],
      ['dirty', { mergeStateStatus: 'DIRTY' }],
      ['draft', { isDraft: true, mergeStateStatus: 'DRAFT' }],
      ['auto-merge armed', { autoMergeRequest: { enabledAt: '2026-11-10T00:00:00Z' } }],
    ]
    for (const [name, pr] of cases) {
      const t = deepQueue({ pr })
      await runQueueFeedWith(t.deps)
      expect(t.armed, name).toEqual([])
    }
    const inQueue = deepQueue({ overrides: { listQueueEntries: async () => ({ queue: true, prs: [...QUEUED, 100] }) } })
    await runQueueFeedWith(inQueue.deps)
    expect(inQueue.armed).toEqual([])
  })

  it('still demands the review PASS, and still refuses an ejected PR that cannot merge onto the group', async () => {
    const noReview = deepQueue({ overrides: { verdictArtifactState: async () => 'absent', platformFlags: async () => ({ ...NO_FLAGS, backend: true }) } })
    const r1 = await runQueueFeedWith(noReview.deps)
    expect(noReview.armed).toEqual([])
    expect(r1.branches[0]?.skipped[0]?.reason).toMatch(/fleet\/review coverage/)

    const conflicts = deepQueue({ overrides: { readPrFiles: async () => ['apps/worker/routes/shared.ts'], readBranchHead: async () => undefined } })
    const r2 = await runQueueFeedWith(conflicts.deps)
    expect(conflicts.armed).toEqual([])
    expect(r2.branches[0]?.skipped[0]?.reason).toMatch(/does not merge|cannot be simulated/)
  })

  it('an ejected PR whose last attempt failed on its OWN diff is still a defect to fix, not a retry', async () => {
    const sha = 'd'.repeat(40)
    const t = deepQueue({
      overrides: {
        listMergeGroupRuns: async () => [mkRun(42, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}` })],
        readRunJobs: async () => [mkJob('backend-bdd', 'failure', 300), mkJob('ci-status', 'failure', 7)],
      },
    })
    const result = await runQueueFeedWith(t.deps)
    expect(t.armed).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/defect to fix, not a retry/)
  })

  it('an iOS-gate-risk ejected PR is still never batched behind a queue that holds work', async () => {
    const t = deepQueue({
      pr: { headRefName: 'fleet/ios/100' },
      overrides: {
        platformFlags: async () => ({ ...NO_FLAGS, ios: true }),
        readPrFiles: async (n) => (n === 100 ? ['apps/ios/Sources/App/X.swift'] : [`apps/worker/routes/file-${n}.ts`]),
      },
    })
    const result = await runQueueFeedWith(t.deps)
    expect(t.armed).toEqual([])
    expect(result.branches[0]?.skipped.some((s) => s.reason.includes('never batched behind'))).toBe(true)
  })

  it('a deep queue with nothing ejected costs the per-PR reads and nothing more', async () => {
    const t = deepQueue({ lastQueueEvent: 'none' })
    await runQueueFeedWith(t.deps)
    expect(t.readPrFiles).not.toHaveBeenCalled() // the group is never loaded for a PR that is not added
  })

  describe('the queue-cleared label — the guard reads it inside the group (#1894)', () => {
    it('labels a fleet-dispatched PR BEFORE arming it, or it is ejected again', async () => {
      const t = deepQueue({ pr: { headRefName: 'fleet/shared/1753' } })
      await runQueueFeedWith(t.deps)
      expect(t.labelled).toEqual([100])
      expect(t.order).toEqual(['label', 'arm'])
    })

    it('does not label a PR on a plain branch (the guard does not gate it)', async () => {
      const t = deepQueue({ pr: { headRefName: 'fix/2463-named-scope' } })
      await runQueueFeedWith(t.deps)
      expect(t.labelled).toEqual([])
      expect(t.armed).toEqual(['100'])
    })

    it('does not re-apply a label the PR already carries', async () => {
      const t = deepQueue({ pr: { headRefName: 'fleet/desktop/1726', labels: ['queue-cleared'] } })
      await runQueueFeedWith(t.deps)
      expect(t.labelled).toEqual([])
      expect(t.armed).toEqual(['100'])
    })

    it('a label that cannot be applied means the PR is NOT armed (it would be ejected again)', async () => {
      const t = deepQueue({
        pr: { headRefName: 'fleet/shared/1753' },
        overrides: { addQueueClearedLabel: async () => { throw new Error('HTTP 502') } },
      })
      const result = await runQueueFeedWith(t.deps)
      expect(t.armed).toEqual([])
      expect(result.branches[0]?.skipped[0]?.reason).toMatch(/queue-cleared label the queue guard requires could not be applied/)
    })

    it('hands the clearance back when the arm itself fails', async () => {
      const t = deepQueue({
        pr: { headRefName: 'fleet/shared/1753' },
        overrides: { enableAutoMerge: async () => { throw new Error('HTTP 502') } },
      })
      const result = await runQueueFeedWith(t.deps)
      expect(result.branches[0]?.armFailed).toEqual([100])
      expect(t.unlabelled).toEqual([100])
    })

    it('the shallow-queue add path labels a fleet PR too — it had the same hole', async () => {
      const labelled: number[] = []
      const deps = mkDeps({
        listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
        readPr: async () => mkPr({ headRefName: 'fleet/backend/100' }),
        verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
        addQueueClearedLabel: async (n) => { labelled.push(n) },
      })
      const result = await runQueueFeedWith(deps)
      expect(result.branches[0]?.armed).toEqual([100])
      expect(result.branches[0]?.rearmed).toEqual([]) // never queued: an addition, not a restoration
      expect(labelled).toEqual([100])
    })

    it('recovers a PR the guard itself rejected: an unsignalled entry is not the diff\'s defect', async () => {
      const sha = 'd'.repeat(40)
      const t = deepQueue({
        pr: { headRefName: 'fleet/shared/1753' },
        overrides: {
          listMergeGroupRuns: async () => [mkRun(77, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}`, path: '.github/workflows/fleet-verify.yml' })],
          readRunJobs: async () => [GUARD_JOB('failure'), mkJob('ci-status', 'failure', 7)],
          readJobAnnotations: async () => ['queue-guard FAILED: queue-entry-unsignalled — fleet-dispatched PR #100 (fleet/shared/1753) entered the merge queue with no armed auto-merge and no queue-cleared label.'],
        },
      })
      const result = await runQueueFeedWith(t.deps)
      expect(t.order).toEqual(['label', 'arm'])
      expect(result.branches[0]?.rearmed).toEqual([100])
      expect(result.branches[0]?.notes.join('\n')).toMatch(/rejected by the queue guard/)
    })

    it('a guard-job failure that is NOT the admission refusal stays a defect', async () => {
      const sha = 'd'.repeat(40)
      const t = deepQueue({
        pr: { headRefName: 'fleet/shared/1753' },
        overrides: {
          listMergeGroupRuns: async () => [mkRun(77, 'failure', { headBranch: `gh-readonly-queue/main/pr-100-${sha}`, path: '.github/workflows/fleet-verify.yml' })],
          readRunJobs: async () => [GUARD_JOB('failure'), mkJob('ci-status', 'failure', 7)],
          readJobAnnotations: async () => ['queue-guard FAILED: queue-pr-lookup — could not read PR #100'],
        },
      })
      const result = await runQueueFeedWith(t.deps)
      expect(t.armed).toEqual([])
      expect(result.branches[0]?.skipped[0]?.reason).toMatch(/defect to fix, not a retry/)
    })
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

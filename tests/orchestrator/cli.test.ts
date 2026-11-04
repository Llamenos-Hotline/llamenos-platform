import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  revert, digestInputFrom, COMMANDS, type RevertDeps,
  runPlanWith, type PlanDeps,
  runIntegrateWith, type IntegrateDeps, type DirtyFleetPr,
  resolveDispatchResult, statusForItemWith, type StatusItemDeps, type ResolveDispatchDeps,
  resolveAwaitingHumanWith, settleTargetFor,
  ensureClosesLine, ensureIssueLinkWith, type IssueLinkDeps,
  findOpenPrFor, type OpenPrLookupDeps,
} from '../../orchestrator/src/cli.js'
import { renderDigest, computeBanner } from '../../orchestrator/src/digest.js'
import { buildIssueCreateArgs, NEEDS_HUMAN_LABEL, type ProposedIssue } from '../../orchestrator/src/roles/planner.js'
import type { RunRecord } from '../../orchestrator/src/ledger.js'
import type { WorkItem } from '../../orchestrator/src/source.js'
import type { SettleInput, TickResult } from '../../orchestrator/src/tick.js'
import type { DependencyReport } from '../../orchestrator/src/dependency.js'
import type { PrFacts } from '../../orchestrator/src/status.js'
import type { Lane } from '../../orchestrator/src/config.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const DEP_OK: DependencyReport = { ok: true, problems: [], commit: 'abc123' }

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  ts: 1_700_000_000_000,
  runId: 'run-1',
  lane: 'backend',
  itemId: '42',
  itemName: 'Fix the thing',
  engine: 'claude',
  outcome: 'SUCCESS',
  branch: 'fleet/backend/42',
  pr: '99',
  ...overrides,
})

function makeDeps(records: RunRecord[], overrides: Partial<RevertDeps> = {}): RevertDeps & {
  calls: { destroyWorktree: string[]; closePr: [string, string][]; deleteBranch: string[] }
} {
  const calls = { destroyWorktree: [] as string[], closePr: [] as [string, string][], deleteBranch: [] as string[] }
  return {
    findRecord: (runId) => records.find((r) => r.runId === runId),
    findWorktreeForBranch: async (branch) => (branch === 'fleet/backend/42' ? '/tmp/fake-worktree' : undefined),
    destroyWorktree: async (wt) => { calls.destroyWorktree.push(wt) },
    closePr: async (pr, comment) => { calls.closePr.push([pr, comment]) },
    deleteBranch: async (branch) => { calls.deleteBranch.push(branch) },
    log: () => { /* no-op in tests */ },
    calls,
    ...overrides,
  }
}

describe('revert', () => {
  it('closes the PR, removes the worktree, and deletes the branch for a known runId', async () => {
    const deps = makeDeps([record()])
    const code = await revert('run-1', deps)
    expect(code).toBe(0)
    expect(deps.calls.destroyWorktree).toEqual(['/tmp/fake-worktree'])
    expect(deps.calls.closePr).toEqual([['99', expect.any(String)]])
    expect(deps.calls.deleteBranch).toEqual(['fleet/backend/42'])
  })

  it('does not re-label or otherwise touch the issue', async () => {
    // MUTATION GUARD: RevertDeps has no issue-labelling or issue-comment
    // capability at all — the property under test is that revert cannot
    // relabel the issue, not merely that it doesn't call a particular
    // labelling function by name. If a labelling capability were added to
    // RevertDeps this test would need a real assertion against it, but as
    // long as the interface has none, "revert cannot relabel" is enforced by
    // the type system, not by a call-count assertion that a rewrite could
    // trivially satisfy while still adding the label some other way.
    const deps = makeDeps([record()])
    const relabelCapableKeys = Object.keys(deps).filter((k) => /label/i.test(k))
    expect(relabelCapableKeys).toEqual([])
  })

  it('the PR-close comment explains the squash-merge rationale for a one-commit revert', async () => {
    const deps = makeDeps([record()])
    await revert('run-1', deps)
    const [, comment] = deps.calls.closePr[0] ?? ['', '']
    expect(comment).toMatch(/squash/i)
    expect(comment).toMatch(/one/i)
  })

  it('reports clearly and exits non-zero for an unknown runId', async () => {
    const deps = makeDeps([record()])
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await revert('does-not-exist', deps)
    expect(code).not.toBe(0)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('does-not-exist'))
    stderr.mockRestore()
    expect(deps.calls.destroyWorktree).toEqual([])
    expect(deps.calls.closePr).toEqual([])
    expect(deps.calls.deleteBranch).toEqual([])
  })

  it('cleans up worktree and branch for a run that never opened a PR', async () => {
    const deps = makeDeps([record({ pr: undefined })])
    const code = await revert('run-1', deps)
    expect(code).toBe(0)
    expect(deps.calls.destroyWorktree).toEqual(['/tmp/fake-worktree'])
    expect(deps.calls.closePr).toEqual([]) // nothing to close
    expect(deps.calls.deleteBranch).toEqual(['fleet/backend/42'])
  })

  it('destroys the worktree BEFORE closing the PR or deleting the branch', async () => {
    // Ordering matters: git refuses to delete a branch checked out in any
    // worktree, so the worktree must be freed first. A version that reorders
    // this would not fail any single assertion above (all three calls still
    // happen), which is exactly the kind of property-blind test this guards
    // against.
    const order: string[] = []
    const deps = makeDeps([record()], {
      destroyWorktree: async () => { order.push('destroyWorktree') },
      closePr: async () => { order.push('closePr') },
      deleteBranch: async () => { order.push('deleteBranch') },
    })
    await revert('run-1', deps)
    expect(order).toEqual(['destroyWorktree', 'closePr', 'deleteBranch'])
  })

  it('does nothing destructive when the run has neither a branch nor a PR', async () => {
    const deps = makeDeps([record({ branch: undefined, pr: undefined })])
    const code = await revert('run-1', deps)
    expect(code).toBe(0)
    expect(deps.calls.destroyWorktree).toEqual([])
    expect(deps.calls.closePr).toEqual([])
    expect(deps.calls.deleteBranch).toEqual([])
  })
})

describe('digestInputFrom', () => {
  const baseTick: TickResult = { ran: true, attempted: 0, failed: 0, shadowed: 0, rejections: [] }

  it('populates sourceUnreadable from a TickResult aborted with source-unreadable, producing a degraded banner', () => {
    const input = digestInputFrom(
      { ...baseTick, aborted: 'source-unreadable' },
      false,
      undefined,
      [{ id: 'backend', mode: 'live' }],
      [],
      DEP_OK,
      REPO_ROOT,
    )
    expect(input.sourceUnreadable).toBe(true)

    const rendered = renderDigest(input)
    expect(rendered).toContain('FLEET DEGRADED')
    expect(rendered).toMatch(/source could not be read/i)
  })

  it('leaves sourceUnreadable falsy for an ordinary completed pass', () => {
    const input = digestInputFrom(baseTick, false, undefined, [], [], DEP_OK, REPO_ROOT)
    expect(input.sourceUnreadable).toBeFalsy()
    expect(renderDigest(input)).not.toContain('FLEET DEGRADED')
  })

  it('leaves sourceUnreadable falsy when there is no prior tick result at all', () => {
    const input = digestInputFrom(undefined, false, undefined, [], [], DEP_OK, REPO_ROOT)
    expect(input.sourceUnreadable).toBeFalsy()
  })

  it('threads a halted pass through as the halted banner, not degraded', () => {
    const input = digestInputFrom(
      { ...baseTick, aborted: 'source-unreadable' },
      true,
      'breaker tripped',
      [],
      [],
      DEP_OK,
      REPO_ROOT,
    )
    // halted always wins over degraded — see digest.ts's computeBanner.
    expect(computeBanner(input).level).toBe('halted')
  })
})

describe('systemd unit files reference real CLI subcommands', () => {
  const systemdDir = join(REPO_ROOT, 'orchestrator', 'systemd')
  const serviceFiles = readdirSync(systemdDir).filter((f) => f.endsWith('.service'))

  function execStartSubcommands(file: string): string[] {
    const text = readFileSync(join(systemdDir, file), 'utf8')
    const subs: string[] = []
    for (const line of text.split('\n')) {
      const m = /^ExecStart=(.+)$/.exec(line.trim())
      if (m === null) continue
      const execStart = m[1] ?? ''
      const argv = execStart.trim().split(/\s+/)
      // argv[0] is the executable path (e.g. .../llamenos-fleet); the
      // subcommand is whatever follows it.
      if (argv.length > 1 && argv[1] !== undefined) subs.push(argv[1])
    }
    return subs
  }

  it('found at least one .service file to check', () => {
    // MUTATION GUARD: without this, a typo that made the glob match nothing
    // would let every `it.each` below vacuously pass.
    expect(serviceFiles.length).toBeGreaterThan(0)
  })

  it.each(serviceFiles)('%s: every ExecStart subcommand is implemented by the CLI', (file) => {
    const text = readFileSync(join(systemdDir, file), 'utf8')
    const execLine = /^ExecStart=(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    const binary = execLine.split(/\s+/)[0]?.split('/').pop() ?? ''
    if (binary !== 'llamenos-fleet') {
      // Non-CLI units (the watchdog) exec a standalone script from
      // orchestrator/bin/, not `llamenos-fleet <subcommand>`. The equivalent
      // rail is that the named script actually exists there — a rename of
      // either side must break this suite, not the systemd unit at runtime.
      expect(
        readdirSync(join(REPO_ROOT, 'orchestrator', 'bin')),
        `${file} ExecStart names ${binary}, which is not in orchestrator/bin`,
      ).toContain(binary)
      return
    }
    const subs = execStartSubcommands(file)
    expect(subs.length).toBeGreaterThan(0)
    for (const sub of subs) {
      expect(COMMANDS).toContain(sub)
    }
  })

  it('COMMANDS is not vacuous (a typo emptying HANDLERS would make every check above pass trivially)', () => {
    expect(COMMANDS.length).toBeGreaterThan(0)
    expect(COMMANDS).toContain('digest')
    expect(COMMANDS).toContain('tick')
  })

  // `plan` and `integrate` are deliberately NOT invoked by systemd (planner
  // output is human-gated by design; integrate is intended to run ad hoc /
  // on a separate cadence a human controls) — this only asserts the CLI
  // actually implements them, which the systemd cross-check above cannot
  // do since it only walks in the other direction (systemd -> CLI).
  it('plan and integrate are wired into the CLI dispatch table', () => {
    expect(COMMANDS).toContain('plan')
    expect(COMMANDS).toContain('integrate')
  })

  // `review-and-merge` is an OPERATOR command, run by hand against one named
  // PR — never invoked by systemd, for the same reason `plan` isn't: this
  // only asserts the CLI actually implements it.
  it('review-and-merge is wired into the CLI dispatch table', () => {
    expect(COMMANDS).toContain('review-and-merge')
  })
})

const item = (id: string, title = `item ${id}`): WorkItem => ({ id, title, body: 'x', url: 'u', labels: [] })

function planDeps(over: Partial<PlanDeps> = {}): PlanDeps {
  return {
    listOpenBacklog: async () => [],
    readRecentRuns: () => [],
    readGoalDocument: () => 'goal doc',
    invoke: async () => '[]',
    createIssue: vi.fn(async () => 'https://github.com/x/y/issues/1'),
    log: () => {},
    ...over,
  }
}

const proposal: ProposedIssue = {
  title: 'Add rate limiting to the login endpoint',
  body: 'Detailed body',
  lane: 'backend',
  effort: 'medium',
}

describe('runPlanWith', () => {
  it('creates no issues when the model proposes nothing', async () => {
    const createIssue = vi.fn(async () => '')
    await runPlanWith(planDeps({ createIssue }))
    expect(createIssue).not.toHaveBeenCalled()
  })

  // This is the load-bearing test for Part 2: it does not merely check that
  // SOME label list was passed — it proves the CLI's `plan` path calls
  // `createIssue` with EXACTLY the argv `buildIssueCreateArgs` itself
  // produces for this proposal, so a future rewrite of `runPlanWith` that
  // hand-assembles its own `gh issue create` argv (bypassing the one
  // sanctioned path, and thereby the unconditional `needs-human` label)
  // fails this test even if it remembers to add every OTHER label by hand.
  it('creates every proposed issue through buildIssueCreateArgs, so needs-human is always attached', async () => {
    const createIssue = vi.fn(async () => 'https://github.com/x/y/issues/1')
    await runPlanWith(planDeps({
      invoke: async () => JSON.stringify([proposal]),
      createIssue,
    }))
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(createIssue).toHaveBeenCalledWith(buildIssueCreateArgs(proposal))
    // Belt-and-suspenders on the property that actually matters operationally.
    const args = (createIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[]
    const labelIdx = args.indexOf('--label')
    expect(labelIdx).toBeGreaterThanOrEqual(0)
    expect(args[labelIdx + 1]?.split(',')).toContain(NEEDS_HUMAN_LABEL)
  })

  it('drops a proposal that near-duplicates the open backlog before ever calling createIssue', async () => {
    const createIssue = vi.fn(async () => '')
    await runPlanWith(planDeps({
      listOpenBacklog: async () => [item('9', 'Add rate limiting to login')],
      invoke: async () => JSON.stringify([proposal]),
      createIssue,
    }))
    expect(createIssue).not.toHaveBeenCalled()
  })
})

function fleetPr(pr: string, branch = `fleet/backend/${pr}`): DirtyFleetPr {
  return { pr, branch }
}

function integrateDeps(over: Partial<IntegrateDeps> = {}): IntegrateDeps {
  return {
    listDirtyFleetPrs: async () => [],
    findWorktreeForBranch: async () => '/tmp/worktree',
    updateBranch: vi.fn(async () => ({ updated: true, pushed: true, needsHuman: false, reason: 'ok' })),
    commentOnPr: vi.fn(async () => {}),
    requestReview: vi.fn(async () => {}),
    log: () => {},
    ...over,
  }
}

describe('runIntegrateWith', () => {
  it('updates every dirty, fleet-dispatched PR it is given', async () => {
    const updateBranch = vi.fn(async () => ({ updated: true, pushed: true, needsHuman: false, reason: 'ok' }))
    await runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1'), fleetPr('2')],
      updateBranch,
    }))
    expect(updateBranch).toHaveBeenCalledTimes(2)
  })

  it('skips a dirty PR whose worktree is already gone, without calling updateBranch', async () => {
    const updateBranch = vi.fn(async () => ({ updated: true, pushed: true, needsHuman: false, reason: 'ok' }))
    await runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1')],
      findWorktreeForBranch: async () => undefined,
      updateBranch,
    }))
    expect(updateBranch).not.toHaveBeenCalled()
  })

  it('comments on the PR with the reason when updateBranchFromMain reports a conflict rather than pushing', async () => {
    const commentOnPr = vi.fn(async () => {})
    await runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1')],
      updateBranch: async () => ({
        updated: false, pushed: false, needsHuman: true,
        reason: 'merging origin/main into "fleet/backend/1" produced conflicts in: feat.txt — a human needs to resolve this',
        conflictingPaths: ['feat.txt'],
      }),
      commentOnPr,
    }))
    expect(commentOnPr).toHaveBeenCalledWith('1', expect.stringContaining('conflicts'))
  })

  // #1842: a conflicted PR's prior green checks were stale by construction;
  // once the branch is updated and pushed the head moved, and only a
  // `review_requested` event starts a fresh fleet/review (#1760).
  it('re-requests the review after a successful update+push, so the new head gets a fresh verdict', async () => {
    const requestReview = vi.fn(async () => {})
    await runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1')],
      requestReview,
    }))
    expect(requestReview).toHaveBeenCalledWith('1', 'fleet/backend/1')
  })

  it('does NOT re-request the review when the update did not push — the head did not move', async () => {
    const requestReview = vi.fn(async () => {})
    await runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1')],
      updateBranch: async () => ({ updated: false, pushed: false, needsHuman: true, reason: 'conflict', conflictingPaths: ['x.ts'] }),
      requestReview,
    }))
    expect(requestReview).not.toHaveBeenCalled()
  })

  it('a throwing review re-request is logged, never propagated — the update itself already landed', async () => {
    const lines: string[] = []
    await expect(runIntegrateWith(integrateDeps({
      listDirtyFleetPrs: async () => [fleetPr('1')],
      requestReview: async () => { throw new Error('HTTP 422') },
      log: (m) => lines.push(m),
    }))).resolves.toBe(0)
    expect(lines.some((l) => l.includes('422'))).toBe(true)
  })
})

// G3 (issue #660/PR #662) + issue #812: `dispatch-one.sh`'s WORKER-written
// terminal status never carries `branch`/`worktree`, and the worktree it cut
// used to be on the worker NAME rather than `fleet/<lane>/<item>`. These pin
// `resolveDispatchResult` directly, independent of the rest of the
// dispatch/tick machinery — including that a worktree or PR on the WRONG
// branch is a FAILED run with reason `branch-mismatch:<actual>`, never a
// silently skipped verify.
describe('resolveDispatchResult', () => {
  const EXPECTED = 'fleet/infra/660'
  const findWorktree = vi.fn(async (_repoRoot: string, _branch: string): Promise<string | undefined> => '/wt/found')
  const currentBranch = vi.fn(async (_wt: string): Promise<string | undefined> => EXPECTED)
  const prHeadBranch = vi.fn(async (_pr: string): Promise<string | undefined> => EXPECTED)
  const deps = (over: Partial<ResolveDispatchDeps> = {}): ResolveDispatchDeps =>
    ({ findWorktree, currentBranch, prHeadBranch, ...over })
  beforeEach(() => { findWorktree.mockClear(); currentBranch.mockClear(); prHeadBranch.mockClear() })

  it('fills in the deterministic branch when the dispatch result is missing it', async () => {
    const result = await resolveDispatchResult({ outcome: 'SUCCESS', pr: '662' }, EXPECTED, REPO_ROOT, deps())
    expect(result.branch).toBe(EXPECTED)
    expect(result.outcome).toBe('SUCCESS')
    expect(result.branchMismatch).toBeUndefined()
  })

  it('resolves the worktree via git (findWorktreeForBranch) when the dispatch result is missing it', async () => {
    const result = await resolveDispatchResult({ outcome: 'SUCCESS', pr: '662' }, EXPECTED, REPO_ROOT, deps())
    expect(result.worktree).toBe('/wt/found')
    expect(findWorktree).toHaveBeenCalledWith(REPO_ROOT, EXPECTED)
  })

  it('verifies the actual checked-out branch of a worktree the dispatch result reported', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662', worktree: '/wt/seed-reported' }, EXPECTED, REPO_ROOT, deps(),
    )
    expect(findWorktree).not.toHaveBeenCalled()
    expect(currentBranch).toHaveBeenCalledWith('/wt/seed-reported')
    expect(result.worktree).toBe('/wt/seed-reported')
    expect(result.outcome).toBe('SUCCESS')
  })

  it('never trusts a worker-reported branch over git', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662', branch: 'worker-reported-branch', worktree: '/wt/w' }, EXPECTED, REPO_ROOT, deps(),
    )
    expect(result.branch).toBe(EXPECTED)
  })

  // The live #812 shape: PR #836 on `fleet-shared-704`.
  it('marks a worktree on the wrong branch FAILED with branch-mismatch:<actual>', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '836', worktree: '/wt/llamenos-fleet-shared-704', note: 'dep:abc worker done' },
      'fleet/shared/704', REPO_ROOT, deps({ currentBranch: async () => 'fleet-shared-704' }),
    )
    expect(result.outcome).toBe('FAILED')
    expect(result.branchMismatch).toBe('fleet-shared-704')
    expect(result.branch).toBe('fleet-shared-704')
    expect(result.note).toBe('branch-mismatch:fleet-shared-704 dep:abc worker done')
    expect(result.pr).toBe('836')
  })

  it('marks an unreadable worktree branch as a mismatch — never assumes it is right', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662', worktree: '/wt/gone' }, EXPECTED, REPO_ROOT, deps({ currentBranch: async () => undefined }),
    )
    expect(result.outcome).toBe('FAILED')
    expect(result.note).toBe('branch-mismatch:unknown')
    expect(result.branch).toBeUndefined()
  })

  it('marks a PR whose head is a different branch FAILED even when the worktree is right', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662' }, EXPECTED, REPO_ROOT, deps({ prHeadBranch: async () => 'some-other-branch' }),
    )
    expect(result.outcome).toBe('FAILED')
    expect(result.branchMismatch).toBe('some-other-branch')
  })

  it('fails closed when the PR head cannot be read', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662' }, EXPECTED, REPO_ROOT, deps({ prHeadBranch: async () => undefined }),
    )
    expect(result.outcome).toBe('FAILED')
    expect(result.branchMismatch).toBe('unreadable-pr-head')
    expect(result.branch).toBeUndefined()
  })

  it('leaves worktree undefined when git cannot find one either — never fabricates a path', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'SUCCESS', pr: '662' }, EXPECTED, REPO_ROOT, deps({ findWorktree: async () => undefined }),
    )
    expect(result.worktree).toBeUndefined()
    expect(currentBranch).not.toHaveBeenCalled()
    expect(result.outcome).toBe('SUCCESS')
  })

  it('preserves every other field on the result unchanged', async () => {
    const result = await resolveDispatchResult(
      { outcome: 'BLOCKED', pr: '662', note: 'worker note' }, EXPECTED, REPO_ROOT, deps(),
    )
    expect(result.outcome).toBe('BLOCKED')
    expect(result.note).toBe('worker note')
    expect(result.pr).toBe('662')
  })
})

describe('statusForItemWith (G1: derive-on-read, never a label)', () => {
  const row = (overrides: Partial<RunRecord> = {}): RunRecord => ({
    ts: 1000, runId: 'run-1', lane: 'infra', itemId: '660', itemName: 'fix inventory path',
    engine: 'claude', outcome: 'SUCCESS', pr: '662', branch: 'fleet/infra/660',
    note: 'scope=pass impact=low tests=orchestrator:pass review=PASS merge=yes(all green) sha=c0ffee',
    ...overrides,
  })

  function deps(overrides: Partial<StatusItemDeps> = {}): StatusItemDeps {
    return {
      readRows: () => [row()],
      readPr: async () => ({ number: '662', state: 'OPEN', headRefOid: 'c0ffee', reviews: [] }),
      branchExistsOnOrigin: async () => true,
      findWorktreeForBranch: async () => '/wt/fleet-infra-660',
      ...overrides,
    }
  }

  it('derives MERGED state for a merged PR', async () => {
    const out = await statusForItemWith('660', deps({
      readPr: async () => ({ number: '662', state: 'MERGED', headRefOid: 'c0ffee', reviews: [] }),
    }))
    expect(out).toContain('state: MERGED')
    expect(out).toContain('MERGED')
  })

  it('derives OPEN state for an open, unmerged PR and reports the head matches the verified SHA', async () => {
    const out = await statusForItemWith('660', deps())
    expect(out).toContain('state: OPEN')
    expect(out).toContain('head matches the last verified SHA')
    expect(out).toContain('Awaiting a human: YES')
  })

  it('derives CLOSED (not merged) state for a closed-unmerged PR', async () => {
    const out = await statusForItemWith('660', deps({
      readPr: async () => ({ number: '662', state: 'CLOSED', headRefOid: 'c0ffee', reviews: [] }),
    }))
    expect(out).toContain('state: CLOSED')
    expect(out).not.toContain('MERGED')
    // Closed (not merged, not open) is never "awaiting a human" — there is
    // nothing left to wait on.
    expect(out).toContain('Awaiting a human: no')
  })

  it('flags a branch that moved since verification', async () => {
    const out = await statusForItemWith('660', deps({
      readPr: async () => ({ number: '662', state: 'OPEN', headRefOid: 'a-different-commit', reviews: [] }),
    }))
    expect(out).toContain('DOES NOT MATCH')
  })

  // MUTATION GUARD, and the literal test the brief asks for: none of the
  // three derivations above ever reads a label. `StatusItemDeps` has no
  // label-reading capability in its type at all, so a derivation that tried
  // to read one would fail to compile — but assert behaviourally too, since
  // `deriveItemStatus` is pure and takes no label input whatsoever.
  it('never reads or reports a label — PrFacts has no label field at all', async () => {
    const facts: PrFacts = { number: '662', state: 'MERGED', headRefOid: 'c0ffee', reviews: [] }
    expect(Object.keys(facts)).not.toContain('labels')
    expect(Object.keys(facts)).not.toContain('label')
    const out = await statusForItemWith('660', deps({ readPr: async () => facts }))
    expect(out.toLowerCase()).not.toContain('fleet:merged')
  })

  it('reports "no PR found" when the item has no recorded PR at all', async () => {
    const out = await statusForItemWith('660', deps({
      readRows: () => [row({ pr: undefined })],
      readPr: async () => { throw new Error('must not be called with no pr') },
    }))
    expect(out).toContain('no PR found')
  })
})

describe('resolveAwaitingHumanWith (digest live derivation)', () => {
  const candidate = (itemId: string, pr: string): RunRecord =>
    ({ ts: 1000, runId: `run-${itemId}`, lane: 'infra', itemId, itemName: `item ${itemId}`, engine: 'claude', outcome: 'SUCCESS', pr })

  it('keeps a candidate whose PR is still open', async () => {
    const readPr = async (): Promise<PrFacts> => ({ number: '1', state: 'OPEN', headRefOid: 'x', reviews: [] })
    const out = await resolveAwaitingHumanWith([candidate('1', '1')], readPr)
    expect(out).toHaveLength(1)
  })

  it('drops a candidate whose PR already merged', async () => {
    const readPr = async (): Promise<PrFacts> => ({ number: '1', state: 'MERGED', headRefOid: 'x', reviews: [] })
    const out = await resolveAwaitingHumanWith([candidate('1', '1')], readPr)
    expect(out).toHaveLength(0)
  })

  it('drops a candidate with no PR recorded at all, without calling gh', async () => {
    const readPr = vi.fn(async (): Promise<PrFacts | undefined> => undefined)
    const noPr: RunRecord = { ts: 1000, runId: 'run-x', lane: 'infra', itemId: 'x', itemName: 'x', engine: 'claude', outcome: 'SUCCESS' }
    const out = await resolveAwaitingHumanWith([noPr], readPr)
    expect(out).toHaveLength(0)
    expect(readPr).not.toHaveBeenCalled()
  })

  it('drops a candidate whose live gh read fails — "could not check" is never "yes, waiting"', async () => {
    const readPr = async (): Promise<PrFacts | undefined> => undefined
    const out = await resolveAwaitingHumanWith([candidate('1', '1')], readPr)
    expect(out).toHaveLength(0)
  })
})

describe('settleTargetFor', () => {
  const input = (needsHuman: boolean): SettleInput => ({
    item: { id: '7', title: 't', body: 'b', url: 'u', labels: [] },
    lane: {
      id: 'ios', mode: 'live', cap: 1, engine: 'claude',
      requireLabel: 'agent-dispatchable', vetoLabels: [], scope: { owned: ['apps/ios/'], notOwned: [] },
    },
    outcome: 'SUCCESS',
    worktree: '/wt/ios-7',
    branch: 'fleet/ios/7',
    pr: '99',
    needsHuman,
  })

  // The regression this exists for: needsHuman was silently omitted from the
  // object literal handed to settle(), so the `needs-human` label — the only
  // thing stopping the fleet re-dispatching a claimed SUCCESS it could not
  // verify (issue #660's shape) — could never be applied in production.
  // TypeScript could not see it: every field it does set is optional on
  // SettleTarget, so an omission type-checks.
  it.each([true, false])('carries needsHuman=%s through to settle()', (needsHuman) => {
    expect(settleTargetFor(input(needsHuman)).needsHuman).toBe(needsHuman)
  })

  it('carries the worktree, branch, outcome and item id settle() needs to clean up', () => {
    expect(settleTargetFor(input(true))).toEqual({
      name: 'fleet-ios-7', itemId: '7', outcome: 'SUCCESS',
      worktree: '/wt/ios-7', branch: 'fleet/ios/7', needsHuman: true,
    })
  })
})

describe('ensureClosesLine', () => {
  // GitHub closes the linked issue only when a MERGED PR body carries this
  // line, so a missing one means the work lands on main and the issue stays
  // open with nothing saying why.
  it('appends the line when it is absent', () => {
    expect(ensureClosesLine('Fixes the thing.', '12')).toBe('Fixes the thing.\n\nCloses #12')
  })

  it('returns null when it is already there — a second tick must not append twice', () => {
    expect(ensureClosesLine('Fixes the thing.\n\nCloses #12', '12')).toBeNull()
  })

  it('returns null for a lowercase `closes #12` — GitHub matches case-insensitively too', () => {
    expect(ensureClosesLine('done\n\ncloses #12', '12')).toBeNull()
  })

  // THE load-bearing case. Without the trailing \b, `#123` satisfies item 12,
  // so the fleet would skip linking issue 12 because a DIFFERENT issue
  // happened to be mentioned — and issue 12 would silently stay open.
  it('does not accept `Closes #123` as closing item 12', () => {
    expect(ensureClosesLine('see also Closes #123', '12')).toBe('see also Closes #123\n\nCloses #12')
  })

  it('does not accept a longer word ending in closes, e.g. "encloses #12"', () => {
    expect(ensureClosesLine('encloses #12', '12')).toBe('encloses #12\n\nCloses #12')
  })

  it('is idempotent: applying it to its own output changes nothing', () => {
    const once = ensureClosesLine('body', '12')
    expect(once).not.toBeNull()
    expect(ensureClosesLine(once ?? '', '12')).toBeNull()
  })
})

describe('ensureIssueLinkWith', () => {
  function deps(over: Partial<IssueLinkDeps> = {}): IssueLinkDeps {
    return {
      readPr: vi.fn(async () => ({ body: 'some work', headRefName: 'fleet/ios/12' })),
      editBody: vi.fn(async () => {}),
      log: () => {},
      ...over,
    }
  }

  it('edits the PR body when the line is missing, with the item taken from the branch', async () => {
    const d = deps()
    await ensureIssueLinkWith('42', d)
    expect(d.editBody).toHaveBeenCalledWith('42', 'some work\n\nCloses #12')
  })

  it('does NOT edit when the line is already present', async () => {
    const d = deps({ readPr: vi.fn(async () => ({ body: 'work\n\nCloses #12', headRefName: 'fleet/ios/12' })) })
    await ensureIssueLinkWith('42', d)
    expect(d.editBody).not.toHaveBeenCalled()
  })

  it('does not touch a PR on a non-fleet branch — there is no issue to link', async () => {
    const d = deps({ readPr: vi.fn(async () => ({ body: 'work', headRefName: 'feat/human-work' })) })
    await ensureIssueLinkWith('42', d)
    expect(d.editBody).not.toHaveBeenCalled()
  })

  // An unreadable PR must never be rewritten from a guess.
  it('does not edit when the PR could not be read', async () => {
    const d = deps({ readPr: vi.fn(async () => undefined) })
    await ensureIssueLinkWith('42', d)
    expect(d.editBody).not.toHaveBeenCalled()
  })
})

// Issues #705/#724/#729/#775/#784/#785: the pre-dispatch precondition that
// stops a brand-new worker attempt from rediscovering a PR that is already
// open. `findOpenPrFor` is the deps-injected core (same pattern as
// `resolveDispatchResult` above) — the real `gh pr list` call lives in
// `defaultOpenPrLookupDeps`, untested here on purpose, same as every other
// `gh`-backed default in this file.
describe('findOpenPrFor', () => {
  const testLane: Lane = {
    id: 'infra', mode: 'live', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
    scope: { owned: ['deploy/'], notOwned: [] },
  }
  const testItem: WorkItem = { id: '775', title: 't', body: 'x'.repeat(300), url: 'u', labels: [] }
  const lookupDeps = (findOpenPrOnBranch: OpenPrLookupDeps['findOpenPrOnBranch']): OpenPrLookupDeps =>
    ({ findOpenPrOnBranch })

  it('finds an open PR on the canonical fleet/<lane>/<item> branch', async () => {
    const findOpenPrOnBranch = vi.fn(async (branch: string) => (branch === 'fleet/infra/775' ? '859' : undefined))
    const pr = await findOpenPrFor(testLane, testItem, lookupDeps(findOpenPrOnBranch))
    expect(pr).toBe('859')
    expect(findOpenPrOnBranch).toHaveBeenCalledWith('fleet/infra/775')
  })

  // Some already-open PRs predate issue #812's canonical-branch fix and
  // still live on the legacy `fleet-<lane>-<item>` spelling — the exact
  // shape of PR #859 (issue 775) in the incident this fix targets.
  it('falls back to the legacy fleet-<lane>-<item> spelling when the canonical branch has no open PR', async () => {
    const findOpenPrOnBranch = vi.fn(async (branch: string) => (branch === 'fleet-infra-775' ? '859' : undefined))
    const pr = await findOpenPrFor(testLane, testItem, lookupDeps(findOpenPrOnBranch))
    expect(pr).toBe('859')
    expect(findOpenPrOnBranch).toHaveBeenNthCalledWith(1, 'fleet/infra/775')
    expect(findOpenPrOnBranch).toHaveBeenNthCalledWith(2, 'fleet-infra-775')
  })

  it('returns undefined when neither spelling has an open PR', async () => {
    const pr = await findOpenPrFor(testLane, testItem, lookupDeps(async () => undefined))
    expect(pr).toBeUndefined()
  })

  // MUTATION GUARD: swapping the `??` for something that only ever checks
  // the canonical branch (i.e. dropping the legacy fallback entirely) makes
  // this test fail — the fallback is not incidental, it is the reason this
  // fix catches PRs opened before issue #812.
  it('never queries the legacy spelling once the canonical branch already has an open PR', async () => {
    const findOpenPrOnBranch = vi.fn(async (branch: string) => (branch === 'fleet/infra/775' ? '860' : undefined))
    const pr = await findOpenPrFor(testLane, testItem, lookupDeps(findOpenPrOnBranch))
    expect(pr).toBe('860')
    expect(findOpenPrOnBranch).toHaveBeenCalledTimes(1)
  })
})

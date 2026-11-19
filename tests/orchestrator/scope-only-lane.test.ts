import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  loadLanes, loadGrantableLanes, LANE_IDS, SCOPE_ONLY_LANE_IDS, GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane,
} from '../../orchestrator/src/config.js'
import { loadLaneScopes } from '../../orchestrator/src/fragments.js'
import { checkScopeAcross } from '../../orchestrator/src/scope.js'
import { planScopeGrants, grantScopeAtOpen, type ScopeGrantDeps } from '../../orchestrator/src/scope-grant.js'
import { verifyMechanical, scopeStrayAdvice } from '../../orchestrator/src/verify.js'
import { runVerifyCi, type VerifyCiDeps } from '../../orchestrator/src/ci.js'
import type { VerifyInput } from '../../orchestrator/src/verify.js'

/**
 * #2867. A fleet-authored Mac CI fix changes a script infra owns and the
 * runbook documenting it, which the `mac` fragment owns. `mac` is a fragment,
 * not a lane (#2600), so the runbook read as owned by NO lane: `scope:<lane>`
 * could not reach it and the gate told the author to delete the documentation.
 *
 * Every test runs against the REAL fragments in this checkout — the failure was
 * a disagreement between ownership as the fragments declare it and ownership as
 * the lane list exposes it, which a hand-written lane table cannot reproduce.
 */
const RUNBOOK = 'docs/runbooks/mac-ci-runner-disk.md'
// The exact shape of PR #2863 on fleet/infra/2860.
const PR_2863 = ['scripts/ci/mac-ci-work-volume.sh', 'scripts/ci/mac-ci-work-volume.test.ts', RUNBOOK]

let lanes: Lane[] // what dispatch sees
let grantable: Lane[] // what the gate and the grant step see
beforeAll(async () => {
  lanes = await loadLanes(process.cwd())
  grantable = await loadGrantableLanes(process.cwd())
})
const find = (all: Lane[], id: string): Lane => {
  const l = all.find((x) => x.id === id)
  if (l === undefined) throw new Error(`no lane ${id}`)
  return l
}

describe('a scope-only fragment is grantable but is not a lane', () => {
  it('the fragment really declares the runbook, so the lane list is what loses it', async () => {
    const scopes = await loadLaneScopes(process.cwd())
    expect(scopes['mac']?.owned).toContain(RUNBOOK)
    // …and the BEFORE state: the dispatch lane list has no `mac`, so nothing
    // that judges ownership off it can see the runbook's owner.
    expect(lanes.map((l) => l.id)).not.toContain('mac')
  })

  it('loadLanes is untouched: dispatch, doctor and the digest never see a scope-only fragment', () => {
    expect(lanes.map((l) => l.id)).toEqual([...LANE_IDS])
  })

  it('loadGrantableLanes adds exactly the declared scope-only ids, flagged, with the fragment\'s real scope', () => {
    expect(grantable.map((l) => l.id)).toEqual([...LANE_IDS, ...SCOPE_ONLY_LANE_IDS])
    const mac = find(grantable, 'mac')
    expect(mac.scopeOnly).toBe(true)
    expect(mac.mode).toBe('off')
    expect(mac.scope.owned).toContain(RUNBOOK)
    for (const l of grantable.filter((x) => x.id !== 'mac')) expect(l.scopeOnly).toBeUndefined()
  })

  it('every scope-only id has a fragment with owned paths — an empty one would grant nothing and read as a gap', () => {
    for (const id of SCOPE_ONLY_LANE_IDS) expect(find(grantable, id).scope.owned.length).toBeGreaterThan(0)
  })

  it('a scope-only id is never also a real lane', () => {
    for (const id of SCOPE_ONLY_LANE_IDS) expect((LANE_IDS as readonly string[]).includes(id)).toBe(false)
  })
})

describe('PR #2863 — scripts/ci/<x>.sh + docs/runbooks/<x>.md on fleet/infra/*', () => {
  it('BEFORE: judged against the dispatch lane list, the runbook is unowned and ungrantable', () => {
    const plan = planScopeGrants(PR_2863, find(lanes, 'infra'), lanes)
    expect(plan.refused).toEqual([{ file: RUNBOOK, reason: 'unowned' }])
    expect(plan.grants).toEqual([])
    const advice = scopeStrayAdvice([RUNBOOK], find(lanes, 'infra'), lanes)
    expect(advice.join('\n')).toContain('owned by no lane')
  })

  it('AFTER: the plan grants scope:mac for the runbook and nothing else', () => {
    const plan = planScopeGrants(PR_2863, find(grantable, 'infra'), grantable)
    expect(plan.refused).toEqual([])
    expect(plan.grants).toEqual(['mac'])
    expect(plan.filesByLane).toEqual({ mac: [RUNBOOK] })
  })

  it('AFTER: without the label the gate\'s advice names the remedy that now works', () => {
    const advice = scopeStrayAdvice([RUNBOOK], find(grantable, 'infra'), grantable).join('\n')
    expect(advice).toContain('owned by lane "mac"')
    expect(advice).toContain('scope:mac')
    expect(advice).not.toContain('owned by no lane')
  })

  it('the scope check passes with the grant and fails without it', () => {
    const infra = find(grantable, 'infra')
    const mac = find(grantable, 'mac')
    expect(checkScopeAcross(PR_2863, infra.scope, [mac.scope], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed).toEqual([])
    expect(checkScopeAcross(PR_2863, infra.scope, [], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed).toEqual([RUNBOOK])
  })

  it('fleet/verify resolves a scope:mac label into the granted lanes', async () => {
    const seen: VerifyInput[] = []
    const deps = {
      ctx: { branch: 'fleet/infra/2860', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '2863' },
      lanes: async () => grantable,
      verify: async (v: VerifyInput) => {
        seen.push(v)
        return {
          passed: true, reasons: [], changedFiles: PR_2863, addedLines: 1, impact: 'low' as const, impactReasons: [],
          testsRun: [], testsPassed: true, verifiedCommit: 'h',
        }
      },
      pathExists: () => false,
      log: () => {},
      prLabels: async () => ['scope:mac'],
    } satisfies Partial<VerifyCiDeps>
    await runVerifyCi(deps as unknown as VerifyCiDeps)
    expect(seen[0]?.lane.id).toBe('infra')
    expect((seen[0]?.grantedLanes ?? []).map((l) => l.id)).toEqual(['mac'])
  })

  describe('verifyMechanical on the real diff', () => {
    const repos: string[] = []
    afterEach(() => { while (repos.length > 0) rmSync(repos.pop() as string, { recursive: true, force: true }) })

    /** A repo whose head differs from origin/main by exactly PR_2863's files. */
    const repoWithPr2863 = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'llamenos-scope-only-'))
      repos.push(dir)
      const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'pipe' }) }
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 't@example.com')
      git('config', 'user.name', 'T')
      writeFileSync(join(dir, 'README.md'), 'x\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      for (const f of PR_2863) {
        mkdirSync(dirname(join(dir, f)), { recursive: true })
        writeFileSync(join(dir, f), `${f}\n`)
      }
      git('add', '.')
      git('commit', '-q', '-m', 'fix(ci): the change and its runbook')
      return dir
    }

    it('BEFORE/AFTER: refused with advice naming no remedy, then judged once scope:mac is applied', async () => {
      const dir = repoWithPr2863()
      const infra = find(grantable, 'infra')
      const base = { worktree: dir, branch: 'HEAD', lane: infra, allLanes: grantable, skipTests: true } as const

      const ungranted = await verifyMechanical({ ...base })
      expect(ungranted.passed).toBe(false)
      expect(ungranted.reasons.join('\n')).toContain(RUNBOOK)
      expect(ungranted.reasons.join('\n')).toContain('scope:mac')

      const granted = await verifyMechanical({ ...base, grantedLanes: [find(grantable, 'mac')] })
      expect(granted.reasons.filter((r) => r.includes('outside lane'))).toEqual([])
      expect(granted.reasons.filter((r) => r.startsWith('scope advice:'))).toEqual([])
    })
  })

  it('the orchestrator applies the grant at open — end to end, with the real lanes', async () => {
    const added: string[][] = []
    const deps: ScopeGrantDeps = {
      readChangedFiles: async () => PR_2863,
      readLabels: async () => [],
      lanes: async () => grantable,
      addLabels: async (_pr, labels) => { added.push(labels) },
      comment: async () => {},
      refireReview: async () => true,
      log: () => {},
    }
    const out = await grantScopeAtOpen({ pr: '2863', headRefName: 'fleet/infra/2860' }, deps)
    expect(out).toEqual({ kind: 'granted', grants: ['mac'], refired: true })
    expect(added).toEqual([['scope:mac']])
  })
})

describe('what a scope-only grant must NOT widen', () => {
  it('the Mac workflow stays grant-excluded: a diff carrying it is refused outright, no label applied', async () => {
    const files = [...PR_2863, '.github/workflows/ios-e2e.yml']
    expect(planScopeGrants(files, find(grantable, 'infra'), grantable).refused)
      .toEqual([{ file: '.github/workflows/ios-e2e.yml', reason: 'grant-excluded' }])
    const out = await grantScopeAtOpen(
      { pr: '1', headRefName: 'fleet/infra/1' },
      {
        readChangedFiles: async () => files, readLabels: async () => [], lanes: async () => grantable,
        addLabels: async () => { throw new Error('must not label') }, comment: async () => {},
        refireReview: async () => true, log: () => {},
      },
    )
    expect(out.kind).toBe('refused')
  })

  it('a runbook nobody owns stays unowned — the grant reaches mac\'s files, not docs/runbooks/', () => {
    const plan = planScopeGrants(['scripts/ci/x.sh', 'docs/runbooks/deploy-official.md'], find(grantable, 'infra'), grantable)
    expect(plan.refused).toEqual([{ file: 'docs/runbooks/deploy-official.md', reason: 'unowned' }])
  })

  it('a branch named for the scope-only fragment is still "unknown lane", never a PR\'s own lane', async () => {
    const out = await grantScopeAtOpen(
      { pr: '1', headRefName: 'fleet/mac/1' },
      {
        readChangedFiles: async () => [RUNBOOK], readLabels: async () => [], lanes: async () => grantable,
        addLabels: async () => { throw new Error('must not label') }, comment: async () => {},
        refireReview: async () => true, log: () => {},
      },
    )
    expect(out.kind).toBe('skipped')
  })

  it('fleet/verify on a fleet/mac/* branch still fails "unknown lane" rather than resolving mac', async () => {
    const deps = {
      ctx: { branch: 'fleet/mac/1', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '1' },
      lanes: async () => grantable,
      verify: async () => { throw new Error('must not verify') },
      pathExists: () => false,
      log: () => {},
    }
    const v = await runVerifyCi(deps as unknown as VerifyCiDeps)
    expect(v.ok).toBe(false)
  })
})

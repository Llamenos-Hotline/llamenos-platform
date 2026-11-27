import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  loadLanes, loadGrantableLanes, LANE_IDS, SCOPE_ONLY_LANE_IDS, SCOPE_ONLY_GRANT_PATHS, GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane,
} from '../../orchestrator/src/config.js'
import { loadLaneScopes } from '../../orchestrator/src/fragments.js'
import { checkScopeRouting } from '../../orchestrator/src/scope.js'
import { reviewLanesFor } from '../../orchestrator/src/route.js'
import { verifyMechanical } from '../../orchestrator/src/verify.js'
import { runVerifyCi, type VerifyCiDeps } from '../../orchestrator/src/ci.js'

/**
 * #2867. A fleet-authored Mac CI fix changes a script infra owns and the
 * runbook documenting it, which the `mac` fragment owns. `mac` is a fragment,
 * not a lane (#2600), so the runbook read as owned by NO lane: `scope:<lane>`
 * could not reach it and the gate told the author to delete the documentation.
 *
 * #2723 then closed the gap at its root: a fragment that is not a lane can never
 * hold a branch, so it must not be a path's ONLY owner. Infra now authors every
 * Mac host path (the runbook through its docs grant) and mac reviews them, so
 * #2863's shape is an infra PR needing no grant at all. `scope:mac` still works
 * for a different lane's PR, and still reaches exactly the runbook.
 *
 * #3056 retired the `scope:<lane>` label: a path another lane owns no longer
 * needs a grant to pass, it is ROUTED to the lane that owns it. `mac` is still
 * a scope-only fragment, which is exactly what makes it a reviewer here — it
 * owns the runbook and can name itself on a PR that touches it, though it can
 * never author one.
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
    expect(mac.scope.owned).toEqual([RUNBOOK])
    for (const l of grantable.filter((x) => x.id !== 'mac')) expect(l.scopeOnly).toBeUndefined()
  })

  it('every scope-only id has a fragment with owned paths — an empty one would grant nothing and read as a gap', () => {
    for (const id of SCOPE_ONLY_LANE_IDS) expect(find(grantable, id).scope.owned.length).toBeGreaterThan(0)
  })

  it('every granted path is one the fragment really owns — a path it drops must fail here, not go silently empty', async () => {
    const scopes = await loadLaneScopes(process.cwd())
    for (const id of SCOPE_ONLY_LANE_IDS) {
      for (const p of SCOPE_ONLY_GRANT_PATHS[id]) expect(scopes[id]?.owned).toContain(p)
      expect(find(grantable, id).scope.owned).toEqual([...SCOPE_ONLY_GRANT_PATHS[id]])
    }
  })

  it('a scope-only id is never also a real lane', () => {
    for (const id of SCOPE_ONLY_LANE_IDS) expect((LANE_IDS as readonly string[]).includes(id)).toBe(false)
  })
})

const route = (files: string[], own: Lane) => checkScopeRouting(files, own.scope, NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS)

describe('PR #2863 — scripts/ci/<x>.sh + docs/runbooks/<x>.md on fleet/infra/*', () => {
  // The same fix authored on another lane: the runbook is not that lane's, so mac is who reviews it.
  const ON_IOS = ['apps/ios/Sources/A.swift', RUNBOOK]

  it('#2723: infra authors the whole of #2863 — nothing outside its lane, nobody to route to', () => {
    const infra = find(grantable, 'infra')
    expect(route(PR_2863, infra)).toEqual({ forbidden: [], supplyChain: [], outside: [] })
    expect(reviewLanesFor(route(PR_2863, infra).outside, infra.id, grantable)).toEqual([])
  })

  it('on another lane the runbook is routed to mac, and the PR passes the scope gate without a label', () => {
    const ios = find(grantable, 'ios')
    const r = route(ON_IOS, ios)
    expect(r.forbidden).toEqual([])
    expect(r.supplyChain).toEqual([])
    expect(r.outside).toEqual([RUNBOOK])
    expect(reviewLanesFor(r.outside, ios.id, grantable)).toEqual([{ lane: 'mac', files: [RUNBOOK] }])
  })

  it('mac reviews the runbook ONLY: any other infra doc routes to infra, never to mac', () => {
    const ios = find(grantable, 'ios')
    expect(reviewLanesFor(['docs/runbooks/deploy-official.md'], ios.id, grantable)).toEqual([
      { lane: 'infra', files: ['docs/runbooks/deploy-official.md'] },
    ])
  })

  describe('verifyMechanical on the real diff', () => {
    const repos: string[] = []
    afterEach(() => { while (repos.length > 0) rmSync(repos.pop() as string, { recursive: true, force: true }) })

    /** A repo whose head differs from origin/main by exactly `files`. */
    const repoWith = (files: string[]): string => {
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
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true })
        writeFileSync(join(dir, f), `${f}\n`)
      }
      git('add', '.')
      git('commit', '-q', '-m', 'fix(ci): the change and its runbook')
      return dir
    }

    it('the infra PR passes the scope gate and names no reviewing lane (#2723)', async () => {
      const report = await verifyMechanical({
        worktree: repoWith(PR_2863), branch: 'HEAD', lane: find(grantable, 'infra'), allLanes: grantable, skipTests: true,
      })
      expect(report.reasons.filter((r) => r.includes('outside lane'))).toEqual([])
      expect(report.reviewLanes).toEqual([])
    })

    it('an ios PR carrying the runbook PASSES scope and names mac as its reviewer — no label (#3056)', async () => {
      const report = await verifyMechanical({
        worktree: repoWith(['apps/ios/Sources/A.swift', RUNBOOK]), branch: 'HEAD', lane: find(grantable, 'ios'), allLanes: grantable, skipTests: true,
      })
      expect(report.reasons.filter((r) => r.includes('outside lane'))).toEqual([])
      expect(report.reviewLanes).toEqual([{ lane: 'mac', files: [RUNBOOK] }])
    })
  })
})

describe('what scope-only review routing must NOT widen', () => {
  it('the Mac workflow is still refused to another lane — it is supply chain, and routing does not excuse it', () => {
    const files = ['apps/ios/Sources/A.swift', '.github/workflows/ios-e2e.yml']
    expect(route(files, find(grantable, 'ios')).supplyChain).toEqual(['.github/workflows/ios-e2e.yml'])
  })

  // #2935: these were once `unowned` — mac owns them but its scope is narrowed
  // to the runbook. They are supply chain, which is the true answer: only
  // infra's own PR writes them, and no other lane's PR gets past the gate.
  it.each(['scripts/ci/mac-runner-disk-guard.sh', 'scripts/mac-run.sh', 'tests/runner-boundary.spec.ts'])(
    '%s is host-executed/gate code: infra\'s own PR writes it, every other lane\'s is refused',
    (file) => {
      expect(route([...PR_2863, file], find(grantable, 'infra')).supplyChain).toEqual([])
      expect(route(['apps/ios/Sources/A.swift', file], find(grantable, 'ios')).supplyChain).toEqual([file])
    },
  )

  it('a branch named for the scope-only fragment is still "unknown lane", never a PR\'s own lane', async () => {
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

  it('fleet/verify on a fleet/mac/* branch still fails "unknown lane" rather than resolving mac', async () => {
    const deps = {
      ctx: { branch: 'fleet/mac/1', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '1' },
      lanes: async () => grantable,
      verify: async () => { throw new Error('must not verify') },
      pathExists: () => false,
      log: () => {},
    }
    expect((await runVerifyCi(deps as unknown as VerifyCiDeps)).summary).toContain('unknown lane')
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import { loadLanes, GRANT_EXCLUDED_PATHS, type Lane } from '../../orchestrator/src/config.js'
import { checkScopeAcross } from '../../orchestrator/src/scope.js'
import { NEVER_WRITE_PATHS } from '../../orchestrator/src/config.js'
import {
  planScopeGrants, grantScopeAtOpen, scopeGrantComment, SCOPE_GRANT_COMMENT_MARKER, type ScopeGrantDeps,
} from '../../orchestrator/src/scope-grant.js'
import { refireReviewRequest, type ReviewRequestAtOpenDeps } from '../../orchestrator/src/review-request.js'
import { SCOPE_GRANT_PREFIX } from '../../orchestrator/src/ci.js'

// The REAL lane fragments, not hand-written scopes: the fleet's measured
// failure was that real cross-lane diffs straddled real ownership (#2643), and
// a fixture lane table would pass while the fragments disagree.
let lanes: Lane[]
beforeAll(async () => { lanes = await loadLanes(process.cwd()) })
const lane = (id: string): Lane => {
  const found = lanes.find((l) => l.id === id)
  if (found === undefined) throw new Error(`no lane ${id}`)
  return found
}

describe('planScopeGrants — the four PRs #2643 measured', () => {
  it('#2633: a backend route + the schema it declares + the client that sends it', () => {
    const plan = planScopeGrants(
      ['apps/worker/routes/calls.ts', 'packages/protocol/schemas/calls.ts', 'src/client/routes/calls.tsx'],
      lane('backend'), lanes,
    )
    expect(plan.refused).toEqual([])
    expect(plan.grants).toEqual(['desktop', 'shared'])
    expect(plan.filesByLane).toEqual({
      shared: ['packages/protocol/schemas/calls.ts'],
      desktop: ['src/client/routes/calls.tsx'],
    })
  })

  it('#2637: the templates a permission gate checks', () => {
    const plan = planScopeGrants(['apps/worker/lib/x.ts', 'packages/protocol/templates/a.json', 'packages/protocol/templates/b.json'], lane('backend'), lanes)
    expect(plan.grants).toEqual(['shared'])
  })

  it('#2638: a catalog permission and the migration that grants it (shared PR, backend-owned migration)', () => {
    const plan = planScopeGrants(['packages/shared/permissions.ts', 'drizzle/migrations/20261110000000_grant.sql'], lane('shared'), lanes)
    expect(plan.refused).toEqual([])
    expect(plan.grants).toEqual(['backend'])
  })

  it('a diff entirely inside the PR\'s own lane needs nothing', () => {
    expect(planScopeGrants(['apps/worker/routes/calls.ts'], lane('backend'), lanes)).toEqual({ grants: [], refused: [], filesByLane: {} })
  })
})

describe('planScopeGrants — the hard boundary', () => {
  it.each(['.github/workflows/ci.yml', 'deploy/docker/docker-compose.yml', 'knope.toml'])(
    '%s is grant-excluded: refused, and NO grant is made for the rest of the diff',
    (file) => {
      const plan = planScopeGrants(['apps/worker/x.ts', 'packages/protocol/schemas/calls.ts', file], lane('backend'), lanes)
      expect(plan.refused).toEqual([{ file, reason: 'grant-excluded' }])
    },
  )

  it('every GRANT_EXCLUDED_PATHS entry refuses, whichever lane owns it', () => {
    for (const p of GRANT_EXCLUDED_PATHS) {
      const f = p.endsWith('/') ? `${p}x.yml` : p.replace('*', 'x')
      const plan = planScopeGrants([f], lane('backend'), lanes)
      expect(plan.grants, f).toEqual([])
    }
  })

  it('a secret path is refused, never granted', () => {
    expect(planScopeGrants(['apps/worker/.env'], lane('shared'), lanes).refused).toEqual([{ file: 'apps/worker/.env', reason: 'secret' }])
  })

  it('a path no lane owns is refused', () => {
    const plan = planScopeGrants(['zzz-owned-by-nobody/file.txt'], lane('backend'), lanes)
    expect(plan.refused).toEqual([{ file: 'zzz-owned-by-nobody/file.txt', reason: 'unowned' }])
  })

  it('an off/empty-owned lane is never a grant candidate', () => {
    const hollow: Lane = { ...lane('desktop'), scope: { owned: [], notOwned: [] } }
    const table = lanes.map((l) => (l.id === 'desktop' ? hollow : l))
    const plan = planScopeGrants(['src/client/routes/calls.tsx'], lane('backend'), table)
    expect(plan.grants).toEqual([])
    expect(plan.refused[0]?.reason).toBe('unowned')
  })

  it('a plan with no refusals is one the GATE accepts with exactly those labels (round trip)', () => {
    const files = ['apps/worker/routes/calls.ts', 'packages/protocol/schemas/calls.ts', 'src/client/routes/calls.tsx']
    const plan = planScopeGrants(files, lane('backend'), lanes)
    const granted = plan.grants.map((g) => lane(g).scope)
    expect(checkScopeAcross(files, lane('backend').scope, granted, NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed).toEqual([])
    // ...and WITHOUT them it is the NO-VERDICT:scope the PRs actually hit.
    expect(checkScopeAcross(files, lane('backend').scope, [], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS).strayed.length).toBeGreaterThan(0)
  })
})

function fakeScopeDeps(o: {
  files?: string[] | undefined
  labels?: string[] | undefined
  commentThrows?: boolean
  addThrows?: boolean
  refired?: boolean
} = {}): { deps: ScopeGrantDeps; calls: string[]; added: string[][]; comments: string[] } {
  const calls: string[] = []
  const added: string[][] = []
  const comments: string[] = []
  return {
    calls, added, comments,
    deps: {
      readChangedFiles: async () => { calls.push('files'); return 'files' in o ? o.files : ['apps/worker/a.ts', 'packages/protocol/schemas/calls.ts'] },
      readLabels: async () => { calls.push('labels'); return 'labels' in o ? o.labels : [] },
      lanes: async () => lanes,
      addLabels: async (_pr, l) => { calls.push('add'); if (o.addThrows) throw new Error('boom'); added.push(l) },
      comment: async (_pr, b) => { calls.push('comment'); if (o.commentThrows) throw new Error('nope'); comments.push(b) },
      refireReview: async () => { calls.push('refire'); return o.refired ?? true },
      log: () => {},
    },
  }
}
const open = { pr: '2633', headRefName: 'fleet/backend/2633', branchMismatch: undefined }

describe('grantScopeAtOpen', () => {
  it('applies the needed label, says so on the PR, THEN re-fires the review — in that order', async () => {
    const { deps, calls, added, comments } = fakeScopeDeps()
    const out = await grantScopeAtOpen(open, deps)
    expect(out).toEqual({ kind: 'granted', grants: ['shared'], refired: true })
    expect(added).toEqual([[`${SCOPE_GRANT_PREFIX}shared`]])
    expect(calls.indexOf('add')).toBeLessThan(calls.indexOf('comment'))
    expect(calls.indexOf('comment')).toBeLessThan(calls.indexOf('refire'))
    expect(comments[0]).toContain(SCOPE_GRANT_COMMENT_MARKER)
    expect(comments[0]).toContain('`packages/protocol/schemas/calls.ts`')
  })

  it('only adds the labels that are missing; none missing means nothing to do', async () => {
    const a = fakeScopeDeps({ labels: ['scope:shared'] })
    expect(await grantScopeAtOpen(open, a.deps)).toEqual({ kind: 'not-needed' })
    expect(a.calls).not.toContain('add')
    expect(a.calls).not.toContain('refire')
  })

  it('a same-lane diff touches nothing and never reads labels', async () => {
    const a = fakeScopeDeps({ files: ['apps/worker/a.ts'] })
    expect(await grantScopeAtOpen(open, a.deps)).toEqual({ kind: 'not-needed' })
    expect(a.calls).toEqual(['files'])
  })

  it('REFUSES a diff holding a grant-excluded path: no label, no comment, no re-fire', async () => {
    const a = fakeScopeDeps({ files: ['apps/worker/a.ts', 'packages/protocol/schemas/calls.ts', '.github/workflows/ci.yml'] })
    const out = await grantScopeAtOpen(open, a.deps)
    expect(out.kind).toBe('refused')
    expect(a.calls).toEqual(['files'])
  })

  it('unreadable files or labels grant nothing (could-not-look is never "nothing needed")', async () => {
    expect((await grantScopeAtOpen(open, fakeScopeDeps({ files: undefined }).deps)).kind).toBe('failed')
    const b = fakeScopeDeps({ labels: undefined })
    expect((await grantScopeAtOpen(open, b.deps)).kind).toBe('failed')
    expect(b.calls).not.toContain('add')
  })

  it('a failed comment does not stop the re-fire that makes the label count', async () => {
    const a = fakeScopeDeps({ commentThrows: true })
    expect((await grantScopeAtOpen(open, a.deps)).kind).toBe('granted')
    expect(a.calls).toContain('refire')
  })

  it('reports an unconfirmed re-fire honestly', async () => {
    const out = await grantScopeAtOpen(open, fakeScopeDeps({ refired: false }).deps)
    expect(out).toEqual({ kind: 'granted', grants: ['shared'], refired: false })
  })

  it('never throws out of a failed label write', async () => {
    const a = fakeScopeDeps({ addThrows: true })
    expect((await grantScopeAtOpen(open, a.deps)).kind).toBe('failed')
    expect(a.calls).not.toContain('refire')
  })

  it.each([
    ['no PR', { ...open, pr: undefined }],
    ['a branch mismatch', { ...open, branchMismatch: 'other' }],
    ['a non-fleet branch', { ...open, headRefName: 'my-feature' }],
  ])('skips %s without any call', async (_n, input) => {
    const a = fakeScopeDeps()
    expect((await grantScopeAtOpen(input, a.deps)).kind).toBe('skipped')
    expect(a.calls).toEqual([])
  })

  it('the PR comment makes the self-grant legible and names the boundary', () => {
    const plan = planScopeGrants(['apps/worker/a.ts', 'src/client/routes/calls.tsx'], lane('backend'), lanes)
    const body = scopeGrantComment(plan, ['desktop'])
    expect(body).toContain('Fleet-applied scope grant')
    expect(body).toContain('`scope:desktop` — `src/client/routes/calls.tsx`')
    expect(body).toContain('GRANT_EXCLUDED_PATHS')
  })
})

describe('refireReviewRequest — a label does not trigger the gate, a fresh request does', () => {
  function fakeReview(o: { pending: string[]; counts: number[]; author?: string }) {
    const calls: string[] = []
    let i = 0
    const deps: ReviewRequestAtOpenDeps = {
      readPr: async () => ({ author: o.author ?? 'a-human', requestedReviewers: o.pending }),
      countReviewRequestedEvents: async () => o.counts[Math.min(i++, o.counts.length - 1)],
      postRequestedReviewer: async (_p, l) => { calls.push(`post:${l}`) },
      deleteRequestedReviewer: async (_p, l) => { calls.push(`delete:${l}`) },
      log: () => {},
    }
    return { deps, calls }
  }

  it('DELETEs an already-pending reviewer (whose run predates the label) before the POST', async () => {
    const { deps, calls } = fakeReview({ pending: ['llamenos-auto'], counts: [3, 4] })
    const out = await refireReviewRequest({ pr: '2633', headRefName: 'fleet/backend/2633' }, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: 'llamenos-auto', reRequested: true })
    expect(calls).toEqual(['delete:llamenos-auto', 'post:llamenos-auto'])
  })

  it('just POSTs when nobody is pending', async () => {
    const { deps, calls } = fakeReview({ pending: [], counts: [0, 1] })
    expect((await refireReviewRequest({ pr: '2633', headRefName: 'fleet/backend/2633' }, deps)).kind).toBe('requested')
    expect(calls).toEqual(['post:llamenos-auto'])
  })

  it('is NOT success when the event count never advances', async () => {
    const { deps } = fakeReview({ pending: ['llamenos-auto'], counts: [3, 3] })
    expect((await refireReviewRequest({ pr: '2633', headRefName: 'fleet/backend/2633' }, deps)).kind).toBe('failed')
  })

  it('refuses a PR reference it cannot build an api path from', async () => {
    const { deps, calls } = fakeReview({ pending: [], counts: [0, 1] })
    expect((await refireReviewRequest({ pr: 'https://example.com/x/pull/1', headRefName: 'fleet/backend/1' }, deps)).kind).toBe('failed')
    expect(calls).toEqual([])
  })
})

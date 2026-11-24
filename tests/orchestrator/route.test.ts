import { describe, it, expect, beforeAll } from 'vitest'
import { loadLanes, CONTRACT_LANE_ID, type Lane } from '../../orchestrator/src/config.js'
import {
  attributePaths, authorFor, extractPaths, indexTree, onTree, routeBlocked, routeForDispatch, surfaceOf, type TreeIndex,
} from '../../orchestrator/src/route.js'
import { trackedFiles } from './codeowners.js'

/**
 * The pre-dispatch ownership check (#1764) and the router it shares with triage
 * (#2979). Unit cases use a hand-made lane table so each rule is isolated; the
 * last block runs the same calls against the REAL fragments and tree, because
 * the defect this replaces — five issues that each burned three dispatches
 * producing correct refusals — was a disagreement between what an issue cites
 * and what the lane table says.
 */

const lane = (id: string, owned: string[], notOwned: string[] = [], mode: Lane['mode'] = 'live'): Lane => ({
  id, mode, cap: 1, engine: 'claude', requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
  scope: { owned, notOwned },
})

// Claim-priority order, as config.ts declares it.
const LANES: Lane[] = [
  lane('backend', ['apps/worker/', 'package.json']),
  lane('shared', ['packages/protocol/', 'packages/crypto/', 'package.json']),
  lane('desktop', ['src/client/', 'package.json']),
  lane('ios', ['apps/ios/', '.github/workflows/ios*.yml', 'package.json'], ['.github/workflows/ios-e2e.yml']),
  lane('android', ['apps/android/', 'package.json']),
  lane('infra', ['.github/workflows/', 'site/', 'docs/', 'package.json']),
  { ...lane('mac', ['docs/runbooks/mac-ci-runner-disk.md'], [], 'off'), scopeOnly: true },
]
const find = (id: string): Lane => {
  const l = LANES.find((x) => x.id === id)
  if (l === undefined) throw new Error(id)
  return l
}

const TREE: TreeIndex = indexTree([
  'apps/worker/routes/notes.ts', 'apps/worker/services/notes.ts',
  'packages/protocol/schemas/notes.ts', 'packages/crypto/src/encryption.rs',
  'src/client/routes/notes.tsx', 'apps/ios/Sources/Notes.swift', 'apps/android/app/src/Notes.kt',
  '.github/workflows/ci.yml', '.github/workflows/ios-e2e.yml', 'site/src/config.ts',
  'docs/epics/epic-99-human-setup.md', 'docs/runbooks/mac-ci-runner-disk.md', 'package.json',
  'vendor/x/y.c',
])

describe('surfaceOf: only real paths count as the issue\'s file surface', () => {
  it('drops slashed tokens that are not tracked paths — check names, refs, branches, URLs', () => {
    const body = 'fleet/verify fails on origin/main for fleet/backend/12; see https://x.y/z and `apps/worker/routes/notes.ts:42`.'
    expect(extractPaths(body)).toContain('fleet/verify')
    expect(surfaceOf(body, TREE)).toEqual(['apps/worker/routes/notes.ts'])
  })

  it('a directory citation counts when it holds tracked files, with or without its trailing slash', () => {
    expect(onTree('apps/worker', TREE)).toBe(true)
    expect(onTree('apps/worker/', TREE)).toBe(true)
    expect(onTree('apps/nothing/', TREE)).toBe(false)
  })

  it('a glob counts when it matches a tracked file', () => {
    expect(onTree('.github/workflows/ios*.yml', TREE)).toBe(true)
    expect(onTree('.github/workflows/zzz*.yml', TREE)).toBe(false)
  })
})

describe('routeForDispatch — refuse to dispatch, instead of dispatching to refuse (#1764)', () => {
  const route = (laneId: string, text: string, lanes = LANES) =>
    routeForDispatch({ text, lane: find(laneId), lanes, tree: TREE })

  it('#734-shaped: a shared-lane item that is entirely site/ is MISROUTED to infra, naming lane and paths', () => {
    const r = route('shared', 'Issue #734 is entirely about `site/src/config.ts` and the marketing site')
    expect(r).toEqual({
      kind: 'misrouted', to: 'infra', paths: ['site/src/config.ts'],
      why: expect.stringContaining('lane "shared" owns none of the cited paths'),
    })
  })

  it('#737-shaped: docs/ routes to the lane that owns docs', () => {
    const r = route('shared', 'editing `docs/epics/epic-99-human-setup.md`')
    expect(r.kind).toBe('misrouted')
    if (r.kind === 'misrouted') expect(r.to).toBe('infra')
  })

  it('a lane that owns ANY cited path is routed — incidental context does not misroute it', () => {
    const r = route('backend', 'fix `apps/worker/routes/notes.ts`; related: `.github/workflows/ci.yml` runs it')
    expect(r).toEqual({ kind: 'routed', owned: ['apps/worker/routes/notes.ts'] })
  })

  it('a carve-out is honoured: ios does not own the iOS gate workflow, infra does', () => {
    const r = route('ios', 'the timeout in `.github/workflows/ios-e2e.yml` is stale')
    expect(r.kind).toBe('misrouted')
    if (r.kind === 'misrouted') expect(r.to).toBe('infra')
  })

  it('a scope-only fragment is never a routing target, even when it owns the path most specifically', () => {
    const r = route('backend', 'update `docs/runbooks/mac-ci-runner-disk.md`')
    expect(r.kind).toBe('misrouted')
    if (r.kind === 'misrouted') expect(r.to).toBe('infra')
  })

  it('paths no authoring lane owns are MISROUTED with no target — a hole in the lane table, said out loud', () => {
    const r = route('backend', 'something in `vendor/x/y.c` broke')
    expect(r).toEqual({ kind: 'misrouted', to: undefined, paths: ['vendor/x/y.c'], why: expect.stringContaining('no authoring lane owns') })
  })

  it('a body citing no tracked path is unknown — dispatched as labelled, never re-routed on a guess', () => {
    expect(route('backend', 'the app feels slow, please investigate fleet/verify')).toEqual({ kind: 'unknown' })
  })

  it('an unreadable tree is unknown — the status quo, never a re-route', () => {
    expect(routeForDispatch({ text: '`site/src/config.ts`', lane: find('backend'), lanes: LANES, tree: undefined })).toEqual({ kind: 'unknown' })
  })

  it('a bare file name is not a citation (it collides with prose), so it never misroutes anyone', () => {
    expect(route('ios', 'bump a dependency in `package.json`').kind).toBe('unknown')
  })

  it('a tie between owners is broken by claim priority when the current lane owns nothing', () => {
    const r = route('infra', '`apps/worker/routes/notes.ts` and `apps/ios/Sources/Notes.swift`')
    expect(r.kind).toBe('misrouted')
    if (r.kind === 'misrouted') expect(r.to).toBe('backend')
  })
})

describe('the contract owner authors a contract change with its consumers (#2979 point 1)', () => {
  const CONTRACT_CHANGE =
    'The envelope in `packages/crypto/src/encryption.rs` and `packages/protocol/schemas/notes.ts` changes; ' +
    '`apps/worker/routes/notes.ts` and `apps/ios/Sources/Notes.swift` consume it.'

  it(`the contract lane is ${CONTRACT_LANE_ID}`, () => {
    expect(CONTRACT_LANE_ID).toBe('shared')
  })

  it('an item labelled for a consumer lane is MISROUTED to the contract owner, even though it owns some paths', () => {
    const r = routeForDispatch({ text: CONTRACT_CHANGE, lane: find('backend'), lanes: LANES, tree: TREE })
    expect(r.kind).toBe('misrouted')
    if (r.kind === 'misrouted') {
      expect(r.to).toBe('shared')
      expect(r.why).toContain('contract owner')
    }
  })

  it('on the contract lane itself it is routed — no ping-pong', () => {
    expect(routeForDispatch({ text: CONTRACT_CHANGE, lane: find('shared'), lanes: LANES, tree: TREE }).kind).toBe('routed')
  })

  it('a contract change with ONE consumer stays with whoever owns it — a schema field for a route is a backend PR with a grant', () => {
    const r = routeForDispatch({
      text: '`packages/protocol/schemas/notes.ts` gains a field `apps/worker/routes/notes.ts` reads',
      lane: find('backend'), lanes: LANES, tree: TREE,
    })
    expect(r.kind).toBe('routed')
  })

  it('infra docs are not a consumer: the contract plus a runbook plus one consumer is not a contract-owner change', () => {
    const d = authorFor(attributePaths(['packages/protocol/schemas/notes.ts', 'apps/worker/routes/notes.ts', 'docs/epics/epic-99-human-setup.md'], LANES), LANES, { breakTies: false })
    expect(d.reason).not.toBe('contract')
  })

  it('an OFF contract lane is never routed to from a lane that owns the work — that would park it', () => {
    const lanes = LANES.map((l) => (l.id === 'shared' ? { ...l, mode: 'off' as const } : l))
    expect(routeForDispatch({ text: CONTRACT_CHANGE, lane: find('backend'), lanes, tree: TREE }).kind).toBe('routed')
  })
})

describe('routeBlocked — a BLOCKED report on another lane\'s paths is a routing slip (#1764 ask 3)', () => {
  it('a backend worker blocked on a workflow only infra\'s own PR may write is re-routed to infra', () => {
    const r = routeBlocked({ note: 'needs .github/workflows/ci.yml, which is outside my ownership', lane: find('backend'), lanes: LANES, tree: TREE })
    expect(r).toEqual({ kind: 'misrouted', to: 'infra', paths: ['.github/workflows/ci.yml'], why: expect.any(String) })
  })

  it('a block on a path a grant would have reached is a real BLOCKED, not a routing slip', () => {
    expect(routeBlocked({ note: 'needs src/client/routes/notes.tsx', lane: find('backend'), lanes: LANES, tree: TREE }).kind).toBe('blocked')
  })

  it('a block naming no path, or a path no lane owns, stays BLOCKED for a human', () => {
    expect(routeBlocked({ note: 'needs a product decision', lane: find('backend'), lanes: LANES, tree: TREE }).kind).toBe('blocked')
    expect(routeBlocked({ note: 'needs vendor/x/y.c', lane: find('backend'), lanes: LANES, tree: TREE }).kind).toBe('blocked')
  })

  it('an unreadable tree never re-routes', () => {
    expect(routeBlocked({ note: 'needs .github/workflows/ci.yml', lane: find('backend'), lanes: LANES, tree: undefined }).kind).toBe('blocked')
  })
})

describe('against the REAL lane table and tree', () => {
  let lanes: Lane[]
  let tree: TreeIndex
  beforeAll(async () => {
    lanes = await loadLanes(process.cwd(), '/nonexistent/lanes.json')
    tree = indexTree(trackedFiles())
  })
  const real = (laneId: string, text: string) => {
    const l = lanes.find((x) => x.id === laneId)
    if (l === undefined) throw new Error(laneId)
    return routeForDispatch({ text, lane: l, lanes, tree })
  }

  it('#734 (site/) on shared -> infra; #737 (docs/epics/) on shared -> infra', () => {
    const a = real('shared', 'Issue #734 is entirely about `site/src/config.ts` and the marketing site')
    expect(a.kind === 'misrouted' && a.to).toBe('infra')
    const b = real('shared', "Issue #737's entire task is editing `docs/epics/epic-99-human-setup.md`")
    expect(b.kind === 'misrouted' && b.to).toBe('infra')
  })

  it('#2723: the iOS gate workflow on ios -> infra, never mac', () => {
    const r = real('ios', '`.github/workflows/ios-e2e.yml` shard count')
    expect(r.kind === 'misrouted' && r.to).toBe('infra')
  })

  it('an ordinary backend issue on backend is routed', () => {
    expect(real('backend', 'the bug is in `apps/worker/routes/notes.ts`').kind).toBe('routed')
  })
})

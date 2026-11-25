/**
 * Rails for scripts/fleet-triage.ts. The issue is explicit about how this
 * agent is verified: "An agent that always picks a lane has not been verified
 * — it has just been observed agreeing." (#1814) So the audits below feed it
 * bodies with no dominant lane and confirm it emits NO label rather than a
 * confident guess.
 *
 * Under the lane model (#2979) it never emits `needs-split` either: an issue
 * spanning three lanes is one cross-lane change authored by one lane, with the
 * others reviewing. The decision itself lives in orchestrator/src/route.ts and
 * is shared with the dispatcher; tests/orchestrator/route.test.ts covers it in
 * depth, this file covers the triage composition and its label boundary.
 *
 * The integration tests at the bottom run against the REAL lane table
 * (`.claude/agents/fragments/*-supervisor.md` via `loadLanes`) so the agent
 * and the dispatcher can never disagree about which lane owns a path.
 *
 *   bun test scripts/fleet-triage.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLanes, type Lane } from '../orchestrator/src/config.js'
import {
  assertAppliableLabel,
  attributePaths,
  decideLane,
  extractPaths,
  triageBody,
} from './fleet-triage'

const lane = (id: string, owned: string[], notOwned: string[] = []): Lane => ({
  id, mode: 'live', cap: 1, engine: 'claude', requireLabel: 'agent-dispatchable', vetoLabels: [],
  scope: { owned, notOwned },
})

/** Minimal stand-in for the real table, in claim-priority order. */
const LANES: Lane[] = [
  lane('backend', ['apps/worker/']),
  lane('shared', ['packages/protocol/']),
  lane('desktop', ['src/client/']),
  lane('ios', ['apps/ios/']),
  lane('android', ['apps/android/']),
  lane('infra', ['deploy/']),
]

describe('extractPaths', () => {
  test('finds slashed tokens and strips backticks and trailing punctuation', () => {
    const body = 'The bug is in `apps/worker/routes/notes.ts`, and also apps/ios/Sources/App.swift.'
    expect(extractPaths(body)).toEqual(['apps/worker/routes/notes.ts', 'apps/ios/Sources/App.swift'])
  })

  test('ignores prose with no slashes and bare filenames', () => {
    expect(extractPaths('bump knope.toml and fix the thing')).toEqual([])
  })

  test('strips a leading ./ and dedupes', () => {
    expect(extractPaths('see ./deploy/docker/x.yml and deploy/docker/x.yml again')).toEqual([
      'deploy/docker/x.yml',
    ])
  })

  test('keeps glob citations intact', () => {
    expect(extractPaths('any `.github/workflows/ios*.yml` change')).toEqual(['.github/workflows/ios*.yml'])
  })
})

describe('attributePaths', () => {
  test('attributes each path to the longest matching owned pattern', () => {
    const lanes = [lane('backend', ['tests/steps/backend/']), lane('desktop', ['tests/'])]
    const r = attributePaths(['tests/steps/backend/auth.steps.ts', 'tests/mocks/ipc.ts'], lanes)
    expect(r.attributed.get('backend')).toEqual(['tests/steps/backend/auth.steps.ts'])
    expect(r.attributed.get('desktop')).toEqual(['tests/mocks/ipc.ts'])
  })

  test('a carve-out is honoured: a lane that disclaims a path never attracts it', () => {
    const lanes = [
      lane('ios', ['.github/workflows/ios*.yml'], ['.github/workflows/ios-e2e.yml']),
      lane('infra', ['.github/workflows/']),
    ]
    expect(attributePaths(['.github/workflows/ios-e2e.yml'], lanes).attributed.get('infra')).toEqual(['.github/workflows/ios-e2e.yml'])
  })

  test('a cross-lane tie (shared-write grant) attributes nowhere', () => {
    const lanes = [lane('ios', ['packages/i18n/locales/']), lane('android', ['packages/i18n/locales/'])]
    const r = attributePaths(['packages/i18n/locales/es.json'], lanes)
    expect(r.attributed.size).toBe(0)
    expect(r.sharedWrite).toEqual(['packages/i18n/locales/es.json'])
  })

  test('a citation of the directory itself still matches its trailing-slash grant', () => {
    const r = attributePaths(['apps/ios'], LANES)
    expect(r.attributed.get('ios')).toEqual(['apps/ios'])
  })
})

describe('decideLane', () => {
  const decide = (paths: string[]) => decideLane(attributePaths(paths, LANES), LANES)

  test('one implicated lane -> that lane', () => {
    expect(decide(['apps/worker/routes/notes.ts']).label).toBe('lane:backend')
  })

  test('two lanes, strict dominance -> the dominant lane', () => {
    expect(decide(['apps/worker/a.ts', 'apps/worker/b.ts', 'deploy/docker/x.yml']).label).toBe('lane:backend')
  })

  test('THE AUDIT: two lanes tied -> no label, with a reason a human can act on', () => {
    const d = decide(['apps/worker/a.ts', 'deploy/docker/x.yml'])
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no dominant lane')
  })

  test('three implicated lanes with a dominant one -> that lane authors the whole issue, never a split', () => {
    expect(decide(['apps/worker/a.ts', 'apps/worker/b.ts', 'apps/ios/x.swift', 'apps/android/y.kt']).label).toBe('lane:backend')
  })

  test('THE AUDIT: three lanes, no dominant one -> no label, not a confident guess', () => {
    expect(decide(['apps/worker/a.ts', 'apps/ios/x.swift', 'apps/android/y.kt']).label).toBeNull()
  })

  test('the contract plus two consumers -> the contract owner authors it as one unit', () => {
    expect(decide(['packages/protocol/schemas/a.ts', 'apps/worker/a.ts', 'apps/worker/b.ts', 'apps/ios/x.swift']).label).toBe('lane:shared')
  })

  test('no implicated lanes -> no label', () => {
    expect(decide([]).label).toBeNull()
  })

  test('every reachable label passes the allowlist — agent-dispatchable is unreachable', () => {
    const cases = [[], ['apps/worker/a'], ['apps/worker/a', 'deploy/b'], ['apps/worker/a', 'apps/ios/b', 'apps/android/c', 'deploy/d']]
    for (const c of cases) {
      const d = decide(c)
      if (d.label !== null) assertAppliableLabel(d.label)
      expect(d.label).not.toBe('agent-dispatchable')
    }
  })
})

describe('the hard boundary', () => {
  test('assertAppliableLabel refuses agent-dispatchable, needs-split and every other verb label', () => {
    for (const bad of ['agent-dispatchable', 'needs-human', 'halt', 'lane:', 'needs-split', 'lane:mac']) {
      expect(() => assertAppliableLabel(bad)).toThrow()
    }
    for (const good of ['lane:backend', 'lane:shared', 'lane:desktop', 'lane:ios', 'lane:android', 'lane:infra']) {
      expect(() => assertAppliableLabel(good)).not.toThrow()
    }
  })
})

describe('against the real lane table (the same one the tick uses)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  let lanes: Lane[]
  beforeAll(async () => {
    lanes = await loadLanes(repoRoot, '/nonexistent/lanes.json')
  })

  test('all six lanes parse with scope paths, as doctor asserts', () => {
    for (const id of ['backend', 'shared', 'desktop', 'ios', 'android', 'infra']) {
      expect(lanes.find((l) => l.id === id)?.scope.owned.length).toBeGreaterThan(0)
    }
  })

  test('the iOS gate workflow routes to infra, its authoring lane — mac reviews it, never authors it (#2723)', () => {
    expect(triageBody('.github/workflows/ios-e2e.yml has a stale timeout', lanes).label).toBe('lane:infra')
  })

  test('#1690-shaped body (deploy/... asterisk image) -> lane:infra', () => {
    expect(triageBody('The asterisk image in deploy/docker/Dockerfile.asterisk is stale', lanes).label).toBe('lane:infra')
  })

  test('#1720-shaped body -> lane:ios', () => {
    expect(triageBody('apps/ios/Sources/Views/CallView.swift drops the mute state', lanes).label).toBe('lane:ios')
  })

  test('#1684-shaped body (apps/worker dominant) -> lane:backend', () => {
    const d = triageBody(
      'apps/worker/routes/notes.ts and apps/worker/services/notes.ts disagree; deploy/docker/x.yml mentions it',
      lanes,
    )
    expect(d.label).toBe('lane:backend')
  })

  test('#1468-shaped body -> lane:desktop', () => {
    expect(triageBody('src/client/components/NotesList.tsx renders stale rows', lanes).label).toBe('lane:desktop')
  })

  test('#1682-shaped body spanning ios+android+worker+desktop evenly -> no confident lane', () => {
    const d = triageBody(
      'This touches apps/ios/Sources/A.swift, apps/android/app/src/main/B.kt, apps/worker/routes/c.ts and src/client/lib/d.ts',
      lanes,
    )
    expect(d.label).toBeNull()
  })

  test('a format change across the crate, the protocol, the server and two clients -> the contract owner', () => {
    const d = triageBody(
      'packages/crypto/src/encryption.rs and packages/protocol/schemas/notes.ts change the envelope; ' +
      'apps/worker/routes/notes.ts, apps/ios/Sources/A.swift and apps/android/app/src/main/B.kt consume it',
      lanes,
    )
    expect(d.label).toBe('lane:shared')
  })

  test('a body citing only shared-write grants (i18n locales) picks no lane', () => {
    expect(triageBody('update packages/i18n/locales/es.json wording', lanes).label).toBeNull()
  })

  test('a body with no paths says so instead of guessing', () => {
    const d = triageBody('the app feels slow sometimes, please investigate', lanes)
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no repo paths')
  })

  test('a body whose paths match no lane says so instead of guessing', () => {
    const d = triageBody('something in vendor/somelib/internal/x.c broke', lanes)
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no cited path is owned')
  })
})

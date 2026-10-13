/**
 * Rails for scripts/fleet-triage.ts — the issue is explicit about how this
 * agent is verified: "Audit by breaking it: feed it an issue whose body cites
 * paths in three lanes and confirm it emits `needs-split`, not a confident
 * single lane. An agent that always picks a lane has not been verified — it
 * has just been observed agreeing." (#1814)
 *
 * The integration tests at the bottom run against the REAL lane scope table
 * (`.claude/agents/fragments/*-supervisor.md` via `loadLaneScopes`) so the
 * agent and `select.ts` can never disagree about which lane owns a path —
 * that is the whole point of sharing the table.
 *
 *   bun test scripts/fleet-triage.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLaneScopes, type LaneScope } from '../orchestrator/src/fragments.js'
import {
  assertAppliableLabel,
  attributePaths,
  decideLane,
  extractPaths,
  triageBody,
} from './fleet-triage'

/** Minimal stand-in for the real table: three lanes, one overlap. */
const SCOPES: Record<string, LaneScope> = {
  backend: { owned: ['apps/worker/'], notOwned: [] },
  ios: { owned: ['apps/ios/'], notOwned: [] },
  android: { owned: ['apps/android/'], notOwned: [] },
  infra: { owned: ['deploy/'], notOwned: [] },
}

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
    const scopes: Record<string, LaneScope> = {
      desktop: { owned: ['tests/'], notOwned: [] },
      backend: { owned: ['tests/steps/backend/'], notOwned: [] },
    }
    const r = attributePaths(['tests/steps/backend/auth.steps.ts', 'tests/mocks/ipc.ts'], scopes)
    expect(r.attributed.get('backend')).toEqual(['tests/steps/backend/auth.steps.ts'])
    expect(r.attributed.get('desktop')).toEqual(['tests/mocks/ipc.ts'])
  })

  test('a cross-lane tie (shared-write grant) attributes nowhere', () => {
    const scopes: Record<string, LaneScope> = {
      ios: { owned: ['packages/i18n/locales/'], notOwned: [] },
      android: { owned: ['packages/i18n/locales/'], notOwned: [] },
    }
    const r = attributePaths(['packages/i18n/locales/es.json'], scopes)
    expect(r.attributed.size).toBe(0)
    expect(r.sharedWrite).toEqual(['packages/i18n/locales/es.json'])
  })

  test('a citation of the directory itself still matches its trailing-slash grant', () => {
    const r = attributePaths(['apps/ios'], SCOPES)
    expect(r.attributed.get('ios')).toEqual(['apps/ios'])
  })
})

describe('decideLane', () => {
  test('one implicated lane -> that lane', () => {
    const d = decideLane(new Map([['backend', ['apps/worker/routes/notes.ts']]]))
    expect(d.label).toBe('lane:backend')
  })

  test('two lanes, strict dominance -> the dominant lane', () => {
    const d = decideLane(
      new Map([
        ['backend', ['apps/worker/a.ts', 'apps/worker/b.ts']],
        ['infra', ['deploy/docker/x.yml']],
      ]),
    )
    expect(d.label).toBe('lane:backend')
  })

  test('two lanes tied -> no label, with a reason a human can act on', () => {
    const d = decideLane(
      new Map([
        ['backend', ['apps/worker/a.ts']],
        ['infra', ['deploy/docker/x.yml']],
      ]),
    )
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no dominant lane')
  })

  test('THE AUDIT: three implicated lanes -> needs-split, never a confident single lane', () => {
    const d = decideLane(
      new Map([
        ['backend', ['apps/worker/a.ts', 'apps/worker/b.ts']],
        ['ios', ['apps/ios/x.swift']],
        ['android', ['apps/android/y.kt']],
      ]),
    )
    expect(d.label).toBe('needs-split')
  })

  test('no implicated lanes -> no label', () => {
    const d = decideLane(new Map())
    expect(d.label).toBeNull()
  })

  test('every reachable label passes the allowlist — agent-dispatchable is unreachable', () => {
    const cases = [
      new Map(),
      new Map([['backend', ['a/']]]),
      new Map([
        ['backend', ['a/']],
        ['infra', ['b/']],
      ]),
      new Map([
        ['backend', ['a/']],
        ['ios', ['b/']],
        ['android', ['c/']],
        ['infra', ['d/']],
      ]),
    ]
    for (const c of cases) {
      const d = decideLane(c)
      if (d.label !== null) assertAppliableLabel(d.label)
      expect(d.label).not.toBe('agent-dispatchable')
    }
  })
})

describe('the hard boundary', () => {
  test('assertAppliableLabel refuses agent-dispatchable and every other verb label', () => {
    for (const bad of ['agent-dispatchable', 'needs-human', 'halt', 'lane:', 'needs-splitt']) {
      expect(() => assertAppliableLabel(bad)).toThrow()
    }
    for (const good of ['lane:backend', 'lane:shared', 'lane:desktop', 'lane:ios', 'lane:android', 'lane:infra', 'needs-split']) {
      expect(() => assertAppliableLabel(good)).not.toThrow()
    }
  })
})

describe('against the real lane scope table (the same one select.ts uses)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  let scopes: Record<string, LaneScope>
  beforeAll(async () => {
    scopes = await loadLaneScopes(repoRoot)
  })

  test('all six lanes parse with scope paths, as doctor asserts', () => {
    for (const lane of ['backend', 'shared', 'desktop', 'ios', 'android', 'infra']) {
      expect(scopes[lane]?.owned.length).toBeGreaterThan(0)
    }
  })

  test('#1690-shaped body (deploy/... asterisk image) -> lane:infra', () => {
    const d = triageBody('The asterisk image in deploy/docker/Dockerfile.asterisk is stale', scopes)
    expect(d.label).toBe('lane:infra')
  })

  test('#1720-shaped body -> lane:ios', () => {
    const d = triageBody('apps/ios/Sources/Views/CallView.swift drops the mute state', scopes)
    expect(d.label).toBe('lane:ios')
  })

  test('#1684-shaped body (apps/worker dominant) -> lane:backend', () => {
    const d = triageBody(
      'apps/worker/routes/notes.ts and apps/worker/services/notes.ts disagree; deploy/docker/x.yml mentions it',
      scopes,
    )
    expect(d.label).toBe('lane:backend')
  })

  test('#1468-shaped body -> lane:desktop', () => {
    const d = triageBody('src/client/components/NotesList.tsx renders stale rows', scopes)
    expect(d.label).toBe('lane:desktop')
  })

  test('#1682-shaped body spanning ios+android+worker+desktop -> needs-split', () => {
    const d = triageBody(
      'This touches apps/ios/Sources/A.swift, apps/android/app/src/main/B.kt, apps/worker/routes/c.ts and src/client/lib/d.ts',
      scopes,
    )
    expect(d.label).toBe('needs-split')
  })

  test('a body citing only shared-write grants (i18n locales) picks no lane', () => {
    const d = triageBody('update packages/i18n/locales/es.json wording', scopes)
    expect(d.label).toBeNull()
  })

  test('a body with no paths says so instead of guessing', () => {
    const d = triageBody('the app feels slow sometimes, please investigate', scopes)
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no repo paths')
  })

  test('a body whose paths match no lane says so instead of guessing', () => {
    const d = triageBody('something in vendor/somelib/internal/x.c broke', scopes)
    expect(d.label).toBeNull()
    if (d.label === null) expect(d.reason).toContain('no cited path matched')
  })
})

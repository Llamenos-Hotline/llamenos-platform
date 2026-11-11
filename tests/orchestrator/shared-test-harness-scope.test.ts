import { describe, it, expect, beforeAll } from 'vitest'
import { checkScopeAcross } from '../../orchestrator/src/scope.js'
import { loadLaneScopes, type LaneScope } from '../../orchestrator/src/fragments.js'
import { GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS } from '../../orchestrator/src/config.js'
import { trackedFiles } from './codeowners.js'

/**
 * #2642. Shared test harness is worked on by every lane, and the lane map used
 * to name four harness files for backend and call the rest of the `tests/`
 * root desktop's. So every NEW harness file a backend PR needed was a new
 * `scope=fail` -> `review=not-run` stall, silent until the PR already existed:
 * `tests/db-helpers.ts` four times, then `tests/global-setup.ts` — six
 * instances, two in one evening (#2654, #2647). Adding a fifth filename would
 * have fixed instance 6 and guaranteed instance 7.
 *
 * So this test does not list files. It reads the REAL fragments and the REAL
 * tracked tree, and requires that a backend-lane PR may write every shared
 * harness module that exists today — and, by construction, any that is added
 * tomorrow — while still straying on everything that is another lane's
 * to judge. It is the rail an untested lane map did not have.
 *
 * "Shared harness" is a CLASS, not a list: the modules directly under `tests/`
 * that are not themselves suites (`*.spec.ts`, `*.test.ts`), plus the two
 * helper directories every lane's steps import from. Suites, the Tauri IPC
 * mocks (a key boundary, CODEOWNERS-held), desktop's step code and the
 * orchestrator's own tests are NOT harness and stay out of reach.
 */

const SUITE = /\.(spec|test)\.ts$/
const HARNESS_DIRS = ['tests/helpers/', 'tests/fixtures/']

/** Every tracked file that is shared test harness rather than a suite. */
function harnessFiles(): string[] {
  return trackedFiles().filter((f) => {
    if (SUITE.test(f)) return false
    if (HARNESS_DIRS.some((d) => f.startsWith(d))) return true
    return /^tests\/[^/]+\.ts$/.test(f)
  })
}

describe('shared test harness is writable by the backend lane (#2642)', () => {
  let backend: LaneScope
  let desktop: LaneScope
  const gate = (files: string[], own: LaneScope) =>
    checkScopeAcross(files, own, [], NEVER_WRITE_PATHS, GRANT_EXCLUDED_PATHS)

  beforeAll(async () => {
    const scopes = await loadLaneScopes(process.cwd())
    const [b, d] = [scopes.backend, scopes.desktop]
    if (!b || !d) throw new Error('backend and desktop fragments must both parse — the lane map is the thing under test')
    backend = b
    desktop = d
  })

  it('finds the harness it is about to judge — a vacuous class proves nothing', () => {
    const files = harnessFiles()
    expect(files).toEqual(expect.arrayContaining([
      'tests/db-helpers.ts',
      'tests/global-setup.ts',
      'tests/api-helpers.ts',
      'tests/helpers.ts',
    ]))
    expect(files.length).toBeGreaterThanOrEqual(15)
  })

  it.each(['tests/db-helpers.ts', 'tests/global-setup.ts'])(
    'instance %s: no stray, so fleet/verify cannot say scope=fail and skip the review',
    (file) => {
      expect(gate([file], backend).strayed).toEqual([])
    },
  )

  it('every tracked shared harness file is in backend scope — a file added tomorrow is covered by the class', () => {
    const files = harnessFiles()
    expect(gate(files, backend).strayed).toEqual([])
  })

  it('an invented future harness module is covered too (the class, not a list)', () => {
    expect(gate(['tests/some-harness-nobody-has-written-yet.ts'], backend).strayed).toEqual([])
    expect(gate(['tests/helpers/some-future-helper.ts'], backend).strayed).toEqual([])
  })

  it('shared-write, not a transfer: desktop still writes the same harness on its own PR', () => {
    expect(gate(harnessFiles(), desktop).strayed).toEqual([])
  })

  describe('what stays out of backend reach', () => {
    it.each([
      ['a desktop Playwright suite at the tests/ root', 'tests/hub-settings.spec.ts'],
      ['a Bun guard suite at the tests/ root', 'tests/guards.test.ts'],
      ['the Mac lane’s runner rail', 'tests/runner-boundary.spec.ts'],
      ['the Tauri IPC mocks (CODEOWNERS key boundary)', 'tests/mocks/tauri-core.ts'],
      ['desktop browser-driving step code', 'tests/steps/admin/admin.steps.ts'],
      ['the orchestrator’s own tests', 'tests/orchestrator/scope.test.ts'],
    ])('%s', (_what, file) => {
      expect(gate([file], backend).strayed).toEqual([file])
    })
  })

  describe('the grant boundary this issue is explicitly NOT about (#1115)', () => {
    it.each([
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      'deploy/docker/docker-compose.yml',
      'Dockerfile',
      'Caddyfile',
      'knope.toml',
    ])('backend still cannot reach %s', (file) => {
      expect(gate([file], backend).strayed).toEqual([file])
    })

    it('GRANT_EXCLUDED_PATHS is unchanged in what it protects: it does not (and need not) name tests/', () => {
      expect(GRANT_EXCLUDED_PATHS.some((p) => 'tests/db-helpers.ts'.startsWith(p))).toBe(false)
      for (const p of ['.github/workflows/', '.github/actions/', 'deploy/', 'Dockerfile*', 'Caddyfile*', 'knope.toml', 'package.json', 'bun.lockb']) {
        expect(GRANT_EXCLUDED_PATHS).toContain(p)
      }
    })
  })
})

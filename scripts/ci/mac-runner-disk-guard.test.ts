// Runs the disk guard's own `selftest` (it works on Linux: selftest is dispatched
// before the Darwin check) so the DerivedData ownership rules are enforced by CI
// rather than by whoever remembers to run it by hand after editing the script.
//
// The selftest is the break-it suite for #2530. It asserts both directions:
//   reclaimed  - an idle `Llamenos-<hash>` with NO info.plist under a runner's own
//                _work/DerivedData (and its bytes reported), the same under a
//                runner root whose plist names a live workspace, and a plist-less
//                run-output-only entry in the shared host root;
//   survives   - a fresh runner-root entry, a plist-less host entry holding
//                compiled products, a host entry whose workspace exists, a
//                foreign-named entry, a live headless build, and a hash dir that
//                is not under any DerivedData root (rm_ci_path must refuse it).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'mac-runner-disk-guard.sh')

describe('mac-runner-disk-guard.sh selftest', () => {
  const run = spawnSync('bash', [SCRIPT, 'selftest'], { encoding: 'utf8', timeout: 120_000 })
  const out = `${run.stdout}${run.stderr}`

  test('passes with no failing case', () => {
    expect(out).not.toContain('  FAIL  ')
    expect(run.status).toBe(0)
    expect(out).toContain('selftest passed')
  })

  test.each([
    'runner-root leftover with NO info.plist was reclaimed',
    'runner-root leftover whose workspace still exists was reclaimed (location, not plist)',
    'host-root plist-less logs-only headless build was reclaimed',
    'the removal line reports the reclaimed bytes',
    'fresh runner-root entry survives (live job)',
    'host-root plist-less entry holding Build/Products survives',
    'host-root entry whose workspace exists survives',
    'host-root plist-less entry with a foreign name survives',
    'fresh host-root headless entry survives (live build)',
    'host-root headless entry idle 90 min survives (could be a live test run)',
    'entry outside any DerivedData root survives',
    'rm_ci_path refuses a hash dir outside every DerivedData root',
  ])('asserts: %s', (label) => {
    // A case that silently stopped running would otherwise read as green.
    expect(out).toContain(`  ok    ${label}`)
  })
})

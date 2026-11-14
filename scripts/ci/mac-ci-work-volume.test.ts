// Runs mac-ci-work-volume.sh's own `selftest` (stubs stand in for hdiutil, mount,
// launchctl, ps and xcrun, so it runs anywhere) so the cutover's safety rules are
// enforced by CI rather than by whoever remembers to run it after an edit.
//
// What it must prove, each a break-it:
//   * cutover will not link onto a volume that is detached, or one a
//     LAUNCHD-started process is denied on (the runner's situation: an ssh
//     `touch` proves nothing), and moves nothing when it refuses;
//   * cutover will not move a runner's workspace while ANY runner has a
//     Runner.Worker, or while a simulator is booted, and a worker belonging to
//     some other install does not block it;
//   * what moves is kept, a second cutover is a no-op, a link to somewhere else is
//     never overwritten, a leftover from an earlier attempt stops it;
//   * rollback refuses a detached volume rather than lose what is on it;
//   * the attach agent's wrapper does nothing when attached, attaches when not,
//     and names the failure when the SSD is absent.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'mac-ci-work-volume.sh')

describe('mac-ci-work-volume.sh selftest', () => {
  const run = spawnSync('bash', [SCRIPT, 'selftest'], { encoding: 'utf8', timeout: 120_000 })
  const out = `${run.stdout}${run.stderr}`

  test('passes with no failing case', () => {
    expect(out).not.toContain('  FAIL  ')
    expect(run.status).toBe(0)
    expect(out).toContain('selftest passed')
  })

  test.each([
    'cutover refuses while the image is not attached (rc=1)',
    '...and moved nothing',
    'attach fails loudly when the image is not on the SSD (rc=1)',
    'attach is idempotent: a second call says so and does not call hdiutil again',
    'hdiutil was not called by the second attach',
    'create refuses to overwrite an existing image (rc=1)',
    'verify FAILS when the launchd-started process is denied (rc=1)',
    'cutover refuses a volume a launchd process cannot use (rc=1)',
    'verify passes when the launchd-started process can write, read and exec (rc=0)',
    'cutover refuses while ANY runner has a job (rc=1)',
    '...and has moved NOTHING, not even the idle runner',
    'a Runner.Worker belonging to some other install does not block (rc=0)',
    'cutover refuses while a simulator is booted (rc=1)',
    'cutover succeeds when attached, verified and idle (rc=0)',
    "runner 1's workspace content came across",
    'the device came across',
    'a second cutover is a no-op (rc=0)',
    'a _work link to somewhere else is refused, not overwritten (rc=1)',
    'rollback refuses when the volume is detached, rather than lose what is on it (rc=1)',
    'rollback succeeds when attached and idle (rc=0)',
    'a leftover .pre-ci-work from an earlier attempt stops cutover (rc=1)',
    'the wrapper does nothing when the volume is already attached',
    'the wrapper attaches it when it is not',
    'the wrapper names the failure when the SSD is not there',
  ])('asserts: %s', (label) => {
    // A case that silently stopped running would otherwise read as green.
    expect(out).toContain(`  ok    ${label}`)
  })
})

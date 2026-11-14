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
//
// And the break-it for #2566: a delete the filesystem refuses (EINTR on unlink,
// or rm exiting 0 with the path still present) is named, is never counted as
// freed, does not abort the rest of the reclaim, and does not by itself refuse
// a disk whose measured free space is enough.
//
// And the break-it for the CI work volume (2026-11-14): the guard measures EVERY
// volume a job writes to rather than assuming the internal disk. A RUNNER_TEMP or
// device set on another readable volume is measured on it; a short work volume
// refuses the job even when the host volume has room, and the refusal names the
// short one whichever is listed first; a dangling link (the disk image not
// attached) is refused as disk-guard-wrong-volume and says why; and a simulator
// device set that is a SYMLINK is still swept, because plain `find` on a link
// matches nothing (the control case reproduces that trap).
//
// And the break-it for the hourly timer: its wrapper refreshes the script it runs
// from origin/main, never adopts one that does not parse, and says STALE when it
// could not refresh. The timer had been running a copy pinned six weeks earlier.
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
    'reclaim survived the failed deletes (rc=0), it did not abort',
    'the EINTR entry is still on disk',
    'the rm-exited-0 entry is still on disk',
    'the healthy entry after them was still reclaimed',
    'the EINTR failure is named with its error and marked NOT freed',
    'an rm that exits 0 but leaves the path is a failure, not a delete',
    'the EINTR entry is not reported as removed',
    'the rm-exited-0 entry is not reported as removed',
    'the healthy entry is reported as removed',
    'exactly the two failed deletes are counted',
    'a refusal exits 1',
    'a refusal names the paths reclaim failed to free',
    'a failed delete does not fail closed when measured space is enough',
    'a healthy gate passes',
    'a healthy gate mentions no failures',
    'accepts write paths on the host volume',
    'a write path on another readable volume is measured, not waved through and not refused for being there',
    'a device set SYMLINKED onto another volume is measured on the volume it really lands on',
    'refuses a dangling symlink (what an unattached CI work volume leaves behind)',
    'a RUNNER_TEMP link to an unattached work volume is refused as disk-guard-wrong-volume and says why',
    'a short work volume refuses the job even though the host volume has room, and names it',
    'the refusal does not depend on which volume is listed first',
    'every measured volume above the floor passes, each reported',
    '(control) a plain find on a symlinked device set matches nothing - the trap',
    'the idle device under a symlinked device set is found, the young one is not',
    'timer: first run fetches main and pins its guard',
    "timer: first run executes the pinned guard with 'reclaim'",
    'timer: a new commit on main replaces the pinned guard',
    'timer: the refreshed guard is the one that runs',
    'timer: a guard that does not parse is not adopted',
    'timer: a guard that does not parse is named STALE in the log',
    'timer: the previous guard still runs after a bad refresh',
    'timer: an unreachable origin is named STALE, not silent',
    'timer: an unreachable origin still runs the pinned guard',
    'timer: no pin and no origin aborts loudly instead of running nothing',
  ])('asserts: %s', (label) => {
    // A case that silently stopped running would otherwise read as green.
    expect(out).toContain(`  ok    ${label}`)
  })
})

# CI Mac: where iOS build data lives, and why

The Mac mini that hosts the self-hosted `ios-e2e` runners (`mac-mini-ios-1`,
`mac-mini-ios-2`) has two physical disks and one disk image:

| Volume | Size | What it holds |
|---|---|---|
| `/System/Volumes/Data` (internal NVMe, `disk3s5`) | 228 GiB, shared with other accounts | the OS, swap, the runner installs and their `_diag`, other accounts' files |
| `/Volumes/CIScratch` (external SABRENT RTL9210B, USB, `disk7s1`) | 1.8 TiB, ~1.8 TiB free | **out-of-CI builds started over ssh**, migrated caches and worktrees, and the file that backs the CI work volume |
| `/Volumes/CIWork` (a 300 GiB **sparsebundle** hosted on CIScratch, APFS, `disk9s1`) | 300 GiB cap, occupies only what is written | **what CI jobs write**: each runner's `_work` and the CoreSimulator device set |

The internal volume rests at 18-21 GiB free. Every iOS job refuses to start
below **12 GiB** on any volume it writes to (`scripts/ci/mac-runner-disk-guard.sh`,
#1665). That floor is unchanged. What changed on 2026-11-14 is *where jobs write*,
so the floor is no longer crossed by a few concurrent shards.

## The layout, and how it got there

Before 2026-11-14 every byte a CI job wrote landed on the internal volume, and the
runbook's rule was "CI's build data stays internal". That rule had a real
reason (below) and it still holds for the SSD **itself**. The CI work volume is the
way to use the SSD's capacity without breaking it.

```
~/actions-runner-ios-N/_work   ->  /Volumes/CIWork/actions-runner-ios-N/_work
~/Library/Developer/CoreSimulator/Devices -> /Volumes/CIWork/CoreSimulator/Devices
~/actions-runner-ios-N/_diag       stays internal   (the agent's own log; see below)
swap (/System/Volumes/VM)          stays internal   (macOS owns it)
```

### Why CI cannot use the SSD directly

Measured 2026-11-05 and again **2026-11-14**:

1. **macOS TCC "Removable Volumes" blocks the runner service.** The user TCC
   database has a `kTCCServiceSystemPolicyRemovableVolumes` row for
   `/Users/rhonda/actions-runner-ios-1/externals/node20/bin/node` with
   `auth_value 0` (**denied**). A process started by launchd
   (`launchctl submit`, the same kind of context the runner's `runsvc.sh`
   LaunchAgent gives its children) gets `Operation not permitted` from `ls` and
   `touch` on `/Volumes/CIScratch`. The same commands work from an ssh session, so
   every interactive check looks healthy. On 2026-10-21 a DerivedData symlink onto
   the drive wedged the runner's disk guard in `opendir()` for 36 minutes per job.
2. **A grant would not last.** TCC keys on the binary, and the runner self-updates
   into a new `externals.<version>/node<N>` directory (it moved to
   `externals.2.338.2/node24` on 2026-11-03 and the `node20` row stopped
   matching). A grant is also made in System Settings or by MDM, never over ssh.
3. **launchd starts the runners at login, and nothing guarantees an external mount
   is ready first.**

### Why the disk image works, with the measurements

TCC gates the SSD's own volume. A sparsebundle **file** on it, mounted as a disk
image, is a different volume, and the very process that is refused on CIScratch
uses it freely. Measured 2026-11-14 from a `launchctl submit` job (the runner's
situation, not an ssh shell):

| From a launchd-started process | Result |
|---|---|
| `ls`, `touch` in `/Volumes/CIScratch` | `Operation not permitted` (the control) |
| write, read back, `dd` 200 MB (~400 MB/s), exec a script on the mounted image | all succeed |
| `hdiutil attach <image on CIScratch>` | succeeds: the attach is done by the disk-image daemon, not by the caller |
| the same, from the real runner: `mac-mini-ios-2` ran a job with `RUNNER_TEMP`, the checkout and the device set on `/Volumes/CIWork` | the job's checkout, guard and build ran (see "Verified with a real job") |

So nothing needs a TCC grant, and a runner self-update changes nothing. The
trade is one more thing that must be attached.

### What happens when the image is not attached

- `_work` and the device set dangle. The runner cannot create a workspace through
  a dangling link, and `/Volumes` belongs to root, so nothing is created on the
  boot volume behind anyone's back. The job fails at once.
- If a job does start, the guard refuses it as `disk-guard-wrong-volume` and says
  "the CI work volume's disk image is not attached". It is labelled "NOT A TEST
  FAILURE AND NOT THIS PR'S FAULT" like every other host refusal.
- `org.llamenos.ci-work-attach` (a LaunchAgent, `RunAtLoad` + every 60 s) attaches
  the image again. Measured: detached by hand, back in ~55 s. Its log is
  `~/.llamenos-mac/ci-work-attach.log`.
- If the SSD itself drops (its past drops were thermal: keep the enclosure out of
  the mini's exhaust; read `/usr/bin/log show`, since zsh's `log` builtin shadows
  it), in-flight jobs fail, the image detaches, and everything returns within a
  minute of the SSD coming back.
- **Reboot.** There is no `/etc/fstab`. macOS mounts the SSD's APFS volume on its
  own (its `/Volumes/CIScratch` entry is dated the last boot). The attach agent
  starts at login, as the runner LaunchAgents do, so for a short window after login
  jobs can find the image absent and refuse. Nothing needs doing by hand.

## What enforces it

- **The disk guard measures every volume a job writes to, and checks that it
  does.** `mac-runner-disk-guard.sh guard` runs at the start of `ios-e2e / build
  (mac)` and `ci.yml`'s `ios-build-test`. It resolves `RUNNER_TEMP` (DerivedData,
  build products), `RUNNER_WORKSPACE` (the checkout), the runner's `_diag` (the
  write that crashed the agent in #1665) and the CoreSimulator device set, **follows
  symlinks**, and holds each distinct volume to the 12 GiB floor. The internal
  volume is always one of them (swap, `_diag` and the CoreSimulator caches are
  there). The refusal names which volume is short
  (`disk-guard-verdict: refused ... volume=/Volumes/CIWork`). Nothing assumes the
  layout above: a job whose `RUNNER_TEMP` is on the internal disk is measured on
  the internal disk.
- **A path the runner cannot even `stat` is refused** (`disk-guard-wrong-volume`)
  before anything walks a directory. That is TCC on the SSD itself, or a link to an
  unattached image. The workflow's hang fallback only runs after the guard has
  printed `write paths OK:`, and then reads the tighter of the host volume and
  `RUNNER_TEMP`'s.
- **`find` does not follow a symlink argument.** With the device set on the image,
  `find "$SIM_DEVICES" -type d` examines only the link and prints nothing, so every
  leaked simulator would go unreclaimed while the log said "nothing CI-owned left
  to reclaim". The guard, the `ios-e2e` sweep step and the host sweep script use
  `find -H`; the selftest reproduces the trap as a control and proves the fix.
- **Every Xcode invocation in CI passes `-derivedDataPath` under `RUNNER_TEMP`**,
  and the runner empties `RUNNER_TEMP` between jobs.
- **A delete counts only when the path is gone afterwards** (#2566). On
  2026-11-07 `/Volumes/CIScratch` returned `EINTR` on unlink while still mounted.
  The reclaim logs `delete FAILED — ... is still on disk: <error>` for such a path,
  counts none of its space as freed, and carries on. The gate always decides on
  measured `df`. APFS frees space asynchronously, so a good delete can leave `df`
  flat for a moment; reclaim reports that as a lag, never as a failure.

## Operating the volume (`scripts/ci/mac-ci-work-volume.sh`)

Run on the Mac from an ssh session. No `sudo`.

```sh
bash scripts/ci/mac-ci-work-volume.sh status          # what exists, what is attached, where each link points
bash scripts/ci/mac-ci-work-volume.sh create          # once: the sparsebundle on the SSD
bash scripts/ci/mac-ci-work-volume.sh attach          # idempotent
bash scripts/ci/mac-ci-work-volume.sh install-agent   # keep it attached across logins and drops
bash scripts/ci/mac-ci-work-volume.sh verify          # prove a LAUNCHD-started process can use it
bash scripts/ci/mac-ci-work-volume.sh cutover         # move _work and the device set onto it
bash scripts/ci/mac-ci-work-volume.sh rollback        # and back
bash scripts/ci/mac-ci-work-volume.sh selftest        # all of it against stubs; runs anywhere
```

- `cutover` and `rollback` refuse while a job could be using what they move: a
  `Runner.Worker` under *any* runner install, a booted simulator, a running
  `xcodebuild`. They never signal a process and never touch a runner's
  registration. They copy before they link, refuse a link that already points
  somewhere else, and name a removal that did not happen. `cutover` runs `verify`
  first, so a volume the runner's kind of process cannot use is never linked.
- **Order: cut over only after the guard that understands this layout is on
  `main`.** A job's guard comes from its own checkout. One that predates this
  change demands every write path be on the internal volume and refuses a job
  whose `_work` is not, with the `disk-guard-wrong-volume` label and no test
  failure, cleared by rebasing. Merge-group runs build from `main` plus the PR, so
  after the merge they are all current.
- `~/actions-runner-ios-3` and `-4` are configured installs with no `_work` and no
  registration (four shards on this host completed zero tests in 20 minutes);
  `cutover` skips an install that has never run a job.
- The image is a **cap, not a reservation**. 300 GiB is far above the floor and
  far below the SSD. If `CIWork`'s own free space ever matters, `hdiutil resize`
  grows it while detached.

## Out-of-CI builds (workers and people over ssh)

Unchanged. `scripts/ios-build.sh` (`bun run ios:build|ios:test|ios:uitest`) and
`scripts/test-ios.sh` source `scripts/lib/ios-build-data.sh`, which puts DerivedData
and result bundles on `/Volumes/CIScratch/llamenos-ios-build/` with an explicit
`-derivedDataPath`, refuses when CIScratch is not a real mount point (no silent
fallback to the internal disk), and gates on 20 GiB free on the filesystem it writes
to. ssh sessions can reach CIScratch; the runner cannot, which is why this path and
the CI path differ. Raw `xcodebuild` over ssh without `-derivedDataPath` still writes
the internal default location.

| Variable | Default | Meaning |
|---|---|---|
| `IOS_BUILD_DATA_VOLUME` | `/Volumes/CIScratch` | mount point that must be mounted |
| `IOS_BUILD_DATA_ROOT` | `$IOS_BUILD_DATA_VOLUME/llamenos-ios-build` | where build data goes |
| `IOS_BUILD_DATA_MIN_FREE_GIB` | `20` | free-space floor on the build-data filesystem |

Inside a GitHub Actions job the default root is `$RUNNER_TEMP/llamenos-ios-build`.

## What happens when CIScratch is not mounted

| Who | Effect | How loud |
|---|---|---|
| CI (`ios-e2e`, `ios-build-test`) | **jobs fail until it returns.** The CI work volume's image lives on it, so with the SSD gone the image detaches | `disk-guard-wrong-volume ... disk image is not attached`, or a job that cannot create its workspace |
| `bun run ios:*`, `scripts/test-ios.sh` | refused before xcodebuild starts | `[ios-build-data] REFUSED: the build-data volume /Volumes/CIScratch is not mounted …` |
| `bun run ios:status` | prints the same reason and continues | `build/test/uitest will refuse until this is fixed` |
| Old October symlinks (`~/.tart`, some `~/projects/*`, `~/.worktrees/*`) | dangle | do not delete a dangling link; reattaching the drive restores it |

This is a real dependency CI did not have before: **the iOS gate now depends on the
external SSD being present.** The alternative on the same disk is the internal
volume's 18-21 GiB, which refuses jobs whenever two siblings run. `rollback` returns
CI to internal-only in one command.

## If someone wants CI to use CIScratch with no image

That is an operator decision and a TCC change cannot be made over ssh. It would
need Removable Volumes (or Full Disk Access) granted to the binary launchd starts for
each runner and to every one that replaces it after a self-update, runner
LaunchAgents that wait for the mount, and the guard's write-path check will measure
it like any other volume. Granting it to `/bin/bash` would give every script on the
box full disk access. Do not. The image makes all of this unnecessary.

## Headroom arithmetic

### 2026-11-13/14, before the CI work volume

The 12 GiB refusal on #2756's `ios-compile-check` was the guard working, and it
was **not a leak**. Idle free space was 15.6 GiB; at the moment of refusal the
volume showed 193 GiB used, against 188 GiB idle, because the sibling runner had a
booted `ios-e2e-*` shard in flight. A running shard held ~5 GiB (device data
2.06 GiB, build products, swap growth) that its teardown returned. So the floor was
crossed whenever **idle free < 12 GiB + ~5 GiB per sibling job running**:

| idle free | refused when |
|---|---|
| 15.6 GiB | one sibling shard is mid-run |
| 17.7 GiB (after removing a merged worktree) | two siblings are mid-run |

**What filled the internal volume** (not CI's, so not the guard's to delete):

| Item | Size (`du`, informational) | Owner |
|---|---|---|
| `~/.worktrees/fleet-ios-2303` | 3.8 GiB | an iOS fleet worker; removed 2026-11-14. Nothing tears these down on the Mac. The guard DENYs `~/.worktrees` on purpose |
| `~/Pictures/Photos Library.photoslibrary` | 12 GiB | the operator's. **Not touched** |
| `~/projects/llamenos-bundle-ios-{conv,call-note,invite}` | 2.6 + 1.7 + 0.1 GiB | October worker clones, two with no `.git` |
| `~/projects/llamenos` | 2.5 GiB | 586 commits behind main, dirty |
| `~/.bun/install/cache` | 5.9 GiB | package cache; APFS clones may make deleting it free less than `du` says |
| Docker Desktop | 4.4 + 2.1 GiB | |
| `/Library/Updates` | 2.0 GiB | a downloaded macOS update (needs the operator) |

### 2026-11-14, with the CI work volume

MEASURED_PLACEHOLDER

## Reclaim and the two timers

`org.llamenos.mac-reclaim` runs `~/.llamenos-mac/reclaim-wrapper.sh` hourly. The
wrapper fetches `main`, adopts its guard only if it parses, and writes `STALE: ...`
to `~/.llamenos-mac/reclaim.log` when it could not. It takes only `main`, never a PR
checkout, because it runs hourly outside any job. `bash
scripts/ci/mac-runner-disk-guard.sh install-timer` installs it; **installed
2026-11-14**, pin `bf11215e` = `main`, first run exit 0, `run interval = 3600
seconds`. (For a launchd job a healthy timer shows `state = not running`, `runs =
N`, `last exit code = 0` and a `run interval`; the `next="-"` fault is a systemd
timer on the Linux box.)

`org.llamenos.ci-work-attach` is the second agent, installed by `mac-ci-work-volume.sh
install-agent`.

**A third LaunchAgent, `org.llamenos.disk-sweep`, runs `~/llamenos-mac-disk-sweep.sh`,
which is NOT in this repository.** It recreates an `iPhone CI fixture`, deletes
CI-named simulators older than 6 h and prunes default DerivedData over 1 GiB. Its
simulator sweep used `find "$DEV"` and so would have silently matched nothing once
the device set became a link; the host copy was patched to `find -H` on 2026-11-14
(backup `~/llamenos-mac-disk-sweep.sh.pre-ci-work`). That patch is a host-only
edit, which is the gap: if this host is rebuilt, both the script and the patch are
gone. Moving it into the repo with an `install-timer`-style installer is tracked as
a follow-up.

### Are two Macs enough?

Not with margin. From the last five merge-group `CI` runs: a full-tier group is
`ios-build-test` (3 min) + `build` (3 min) + four `ui` shards of 22-27 min that run
two at a time, so **~55-60 min of wall clock with both Macs saturated**; the second
pair of shards waits 23-27 min for a runner. That leaves ~30 min of the 90-min check
budget. Any other macOS job routed to these runners (#2756) queues behind a shard,
~25 min, and that comes straight out of the same 30 min. See the third-runner
numbers in the section above for what the disk now allows and what it does not.

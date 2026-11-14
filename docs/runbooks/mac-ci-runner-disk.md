# CI Mac: where iOS build data lives, and why

The Mac mini that hosts the self-hosted `ios-e2e` runners (`mac-mini-ios-1`,
`mac-mini-ios-2`) has two disks:

| Volume | Size | What it holds |
|---|---|---|
| `/System/Volumes/Data` (internal) | 228 GiB, shared with other accounts | **everything CI writes** |
| `/Volumes/CIScratch` (external SABRENT RTL9210B, USB) | 1.8 TiB | **out-of-CI builds started over ssh**, plus migrated caches and worktrees |

The internal volume usually sits at ~15 GiB free with the runners idle. It drops
below 10 GiB with two shards running. Every iOS job refuses to start below
**12 GiB** (`scripts/ci/mac-runner-disk-guard.sh`, #1665). Most of that volume
belongs to other accounts and is not ours to reclaim. So the levers are keeping
non-CI builds off it and stopping CI from leaking onto it.

## The rule: CI's build data stays internal; ssh builds go to CIScratch

### Why CI cannot use the external drive

Measured 2026-11-05:

1. **macOS TCC "Removable Volumes" blocks the runner service.** The user TCC
   database has a `kTCCServiceSystemPolicyRemovableVolumes` row for
   `/Users/rhonda/actions-runner-ios-1/externals/node20/bin/node` with
   `auth_value 0` (**denied**). A process started by launchd
   (`launchctl submit`, the same kind of context the runner's `runsvc.sh`
   LaunchAgent gives its children) gets `Operation not permitted` from `ls`
   and `touch` on `/Volumes/CIScratch`. The same commands work from an ssh
   session, so every interactive check looks healthy. On 2026-10-21 a
   DerivedData symlink onto the drive wedged the runner's disk guard in
   `opendir()` for 36 minutes per job.
2. **A grant would not last.** TCC keys on the binary. The runner self-updates
   into a new `externals.<version>/` directory. On 2026-11-03 it moved to
   `externals.2.338.2/node24`, and the denied `node20` row no longer matches
   it. Each update would silently drop a grant, and CI would start hanging or
   getting EPERM on the drive with no change in this repository.
3. **launchd starts the runners at boot, and nothing guarantees the external
   mount is ready first.** If a job's path is missing when it starts, Actions
   recreates the directory on the boot volume. It then fills the internal disk
   while the external one looks unused.

### What enforces the rule

- **The disk guard measures the volume CI writes to, and checks that it does.**
  `mac-runner-disk-guard.sh guard` runs at the start of `ios-e2e / build (mac)`
  and `ci.yml`'s `ios-build-test`. The `ui` shards do not run it; they share
  the same runner installs, so the same layout is checked for them. The guard
  first resolves every path a job writes:
  `RUNNER_TEMP` (DerivedData, build products), `RUNNER_WORKSPACE` (the
  checkout), the runner's `_diag` (the write that crashed the agent in #1665)
  and the CoreSimulator device set. It checks that each one is on
  `/System/Volumes/Data`, the volume whose free space it gates. A path on any
  other filesystem, including through a symlink, is **refused** with
  `disk-guard-wrong-volume`. A path the runner cannot even `stat` is refused
  the same way, before anything walks a directory. The ios-e2e watchdog's `df`
  fallback is only taken after the guard has printed `write paths OK:`, so a
  hang inside that check also ends in a refusal.
- **Every Xcode invocation in CI passes `-derivedDataPath` under `RUNNER_TEMP`**,
  and the runner empties `RUNNER_TEMP` between jobs. Until 2026-11-05 the `ui`
  shards' `xcodebuild test-without-building` did not pass one. Each shard then
  left a `~/Library/Developer/Xcode/DerivedData/Llamenos-*` entry holding
  85–110 MiB of coverage `.profraw`, with no `info.plist`, which reclaim keeps
  on purpose. Reclaim now removes exactly that shape (Logs/, TestResults/,
  Build/ProfileData/ only, no info.plist, nothing modified in 120 min). This
  covers leftovers from branches whose workflow predates the fix.
- **A delete counts only when the path is gone afterwards** (#2566). On
  2026-11-07 `/Volumes/CIScratch` returned `EINTR` on unlink while still
  mounted: `rm -rf` failed and the tree stayed. The reclaim now logs
  `delete FAILED — … is still on disk: <error>` for such a path, counts none
  of its space as freed, and carries on with the rest of the reclaim. If the
  gate then refuses, the refusal lists those paths. The gate always decides on
  measured `df`, so a failed delete does not refuse a disk that has room.
  APFS frees space asynchronously, so a good delete can leave `df` flat for a
  moment; reclaim reports that as a lag, never as a failure.

### Out-of-CI builds (workers and people over ssh)

`scripts/ios-build.sh` (`bun run ios:build|ios:test|ios:uitest`) and
`scripts/test-ios.sh` source `scripts/lib/ios-build-data.sh`. Before any
xcodebuild runs, it:

1. requires `/Volumes/CIScratch` to be a **real mount point**. If the directory
   is missing, or it exists but `df` resolves it to another filesystem (a
   stand-in left on the boot volume), the build is refused with instructions.
   There is **no silent fallback to the internal disk**.
2. creates `/Volumes/CIScratch/llamenos-ios-build/` and write-probes it. A
   failure here mentions TCC, because a build started from launchd fails at
   this step.
3. gates on **at least 20 GiB free on the filesystem the build writes to**
   (`IOS_BUILD_DATA_MIN_FREE_GIB`), not on `/`.
4. passes `-derivedDataPath /Volumes/CIScratch/llamenos-ios-build/DerivedData/<checkout>-<hash>`.
   That directory also holds SwiftPM checkouts and the module cache. Each
   checkout gets its own directory, so concurrent worktrees never share a build
   database. `uitest` result bundles go under `…/results/<checkout>-<hash>/`.
5. prints the internal volume's free space. Simulator device data from
   `test`/`uitest` still lands there, because the default CoreSimulator device
   set cannot move without the runners losing it.

Raw `xcodebuild` over ssh without `-derivedDataPath` still writes the internal
default location. Use the scripts, or pass
`-derivedDataPath /Volumes/CIScratch/llamenos-ios-build/DerivedData/<name>`.

Overrides:

| Variable | Default | Meaning |
|---|---|---|
| `IOS_BUILD_DATA_VOLUME` | `/Volumes/CIScratch` | mount point that must be mounted |
| `IOS_BUILD_DATA_ROOT` | `$IOS_BUILD_DATA_VOLUME/llamenos-ios-build` | where build data goes. A path outside the volume (and outside `/Volumes`) opts out of the mount check deliberately; the preflight warns if that path is on the internal volume |
| `IOS_BUILD_DATA_MIN_FREE_GIB` | `20` | free-space floor on the build-data filesystem |

Inside a GitHub Actions job the default root is `$RUNNER_TEMP/llamenos-ios-build`.

## What happens when CIScratch is not mounted

| Who | Effect | How loud |
|---|---|---|
| CI (`ios-e2e`, `ios-build-test`) | **none.** Nothing CI uses is on the drive | — |
| `bun run ios:*`, `scripts/test-ios.sh` | refused before xcodebuild starts | `[ios-build-data] REFUSED: the build-data volume /Volumes/CIScratch is not mounted …`, non-zero exit |
| `bun run ios:status` | prints the same reason and continues | `build/test/uitest will refuse until this is fixed` |
| Old October symlinks (`~/.tart`, some `~/projects/*`, `~/.worktrees/*`) | dangle | unchanged, see the memory notes on the drive. Do not delete a dangling link; reattaching the drive restores it |

When the drive drops, the cause is in `/usr/bin/log show` (zsh's `log` builtin
shadows the tool). Its past drops were thermal: keep the enclosure out of the
mini's exhaust.

## Reboot and runner restart

- Nothing here is host state. The preflight, the `-derivedDataPath` flags and
  the guard's write-path check are all code, evaluated on every invocation, so
  a reboot or a runner restart cannot undo them. There is no symlink and no
  Xcode `defaults` key to drift. There ARE two LaunchAgents (below), and one of
  them did drift: see "The hourly timer" below.
- After a reboot, external volumes mount when the user session starts, and the
  runners' LaunchAgents run in that same session. If the drive comes up late or
  not at all, CI is unaffected and ssh builds refuse until it is mounted.
- Runner self-updates change the `externals.*`/`bin.*` directories. That is
  harmless now, because CI does not touch the drive. It is also the reason not
  to hand the runner a TCC grant (below).

## If someone wants CI's data on CIScratch anyway

That is an operator decision, and a TCC change cannot be made over ssh: it
needs System Settings, or MDM. It would require **all** of the following:

1. Grant Removable Volumes (or Full Disk Access) to the binary launchd
   starts for each runner, and to every one that replaces it after a runner
   self-update. Otherwise disable runner auto-update. Granting it to
   `/bin/bash` would give every script on the box full disk access. Do not.
2. Make the runners' LaunchAgents wait for the mount, or fail the job loudly.
3. Point `MAC_DISK_GUARD_VOLUME` at the drive. The guard's write-path check
   then requires every write path to be on it, so a half-done migration
   refuses instead of measuring the wrong disk.

Until then, CIScratch serves out-of-CI builds, which can reach it, and the
internal volume's ~15 GiB is left to CI.

## Headroom arithmetic, measured 2026-11-13/14

The 12 GiB refusal on #2756's `ios-compile-check` was the guard working, and it
was **not a leak**. Idle free space was 15.6 GiB; at the moment of refusal the
volume showed 193 GiB used, against 188 GiB idle, because the sibling runner
had a booted `ios-e2e-*` shard in flight. A running shard holds ~5 GiB
(device data 2.06 GiB, build products, swap growth) that its teardown returns.
So the floor is crossed whenever **idle free < 12 GiB + ~5 GiB per sibling job
running**:

| idle free | refuses when |
|---|---|
| 15.6 GiB (before) | one sibling shard is mid-run |
| 17.7 GiB (after removing a merged worktree) | two siblings are mid-run |

Two concurrent shards plus the starting job need ~22 GiB idle to never refuse.
Nothing CI-owned was reclaimable: the guard's own reclaim reported "nothing
CI-owned left to reclaim", `/private/var/tmp` held 2.9 MiB (#2724 is in effect
in both runner checkouts, and there was nothing left for it to take), and
DerivedData was 0.9 GiB.

**What actually filled the volume** (not CI's, so not the guard's to delete):

| Item | Size (`du`, informational) | Owner |
|---|---|---|
| `~/.worktrees/fleet-ios-2303` | 3.8 GiB | an iOS fleet worker; PR #2632 merged 2026-11-11, remote branch deleted, worktree clean. **Removed 2026-11-14: `df` 15 -> 17 GiB.** Nothing tears these down on the Mac (`orchestrator/src/worktree.ts` runs where the orchestrator runs). The guard DENYs `~/.worktrees` on purpose |
| `~/Pictures/Photos Library.photoslibrary` | 12 GiB | the operator's. Moving it to CIScratch is the single biggest lever and is the operator's call |
| `~/projects/llamenos-bundle-ios-{conv,call-note,invite}` | 2.6 + 1.7 + 0.1 GiB | October worker clones, two of them with no `.git` so nothing can verify them |
| `~/projects/llamenos` | 2.5 GiB | 586 commits behind main, dirty (`Info.plist`, untracked `jniLibs/`) |
| `~/.bun/install/cache` | 5.9 GiB | package cache; APFS clones may make deleting it free less than `du` says |
| `~/Library/Containers/com.docker.docker`, `Application Support/com.docker.install` | 4.4 + 2.1 GiB | Docker Desktop |
| `/Library/Updates` | 2.0 GiB | a downloaded macOS update (needs the operator) |

The sweep log (`~/llamenos-mac-disk-sweep.log`) shows idle free falling from
34 GiB (2026-10-22) to 15 GiB (2026-11-13), with dips to 5-8 GiB. Most of that
is not attributable from an ssh session; `/Users/henry` and `/Users/vale` are
empty, and the remainder is system data.

### The hourly timer was running six-week-old code

`org.llamenos.mac-reclaim` runs `~/.local/bin/llamenos-mac-reclaim`, which ran
`~/.llamenos-mac/mac-runner-disk-guard.sh`: a copy **pinned on 2026-10-12**
(`guard-pinned-at.txt`), with no `/private/var/tmp` reclaim in it. The
job-start guard runs the checkout's current script, so the two disagreed for six
weeks and nobody could tell from either log. `install-timer` now installs a
wrapper that fetches `main`, adopts its guard only if it parses, and writes
`STALE: ...` to `~/.llamenos-mac/reclaim.log` when it could not. It takes only
`main`, never a PR checkout, because it runs hourly outside any job.
`bash scripts/ci/mac-runner-disk-guard.sh install-timer` on the Mac applies it;
until then the pin was refreshed by hand to `1730e95d`.

A second timer, `org.llamenos.disk-sweep`, runs `~/llamenos-mac-disk-sweep.sh`,
which is **not in this repository**. It recreates the `iPhone CI fixture`, deletes
CI-named simulators older than 6 h and prunes default DerivedData over 1 GiB. If
this host is rebuilt, that behaviour is gone.

### Are two Macs enough?

Not with margin, and the disk is the reason a third runner on this host is not
the answer. From the last five merge-group `CI` runs: a full-tier group is
`ios-build-test` (3 min) + `build` (3 min) + four `ui` shards of 22-27 min that
run two at a time, so **~55-60 min of wall clock with both Macs saturated**; the
second pair of shards waits 23-27 min for a runner. That leaves ~30 min of the
90-min check budget. Any other macOS job routed to these runners (#2756) queues
behind a shard, ~25 min, and that comes straight out of the same 30 min.
A third runner here would need ~27 GiB idle free and there is 17.7. The options
are a second Mac mini, or ~12 GiB back from the operator's own files (the Photos
library) and a bigger internal disk. That is the operator's decision.

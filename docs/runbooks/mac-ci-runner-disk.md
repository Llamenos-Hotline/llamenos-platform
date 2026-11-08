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
  a reboot or a runner restart cannot undo them. There is no symlink, no Xcode
  `defaults` key and no LaunchAgent to drift.
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

# Fleet watchdog repair — llamenos

The hourly deterministic watchdog (`~/.local/bin/llamenos-fleet-watchdog`, source of
truth `orchestrator/bin/llamenos-fleet-watchdog` in llamenos-platform) found the fleet
unhealthy. The failing checks and evidence are appended below. Your job: restore the fleet to
healthy, then stop. You may use subagents for independent sub-problems.

## Rules
- Diagnose from evidence first (`llamenos-fleet status`, `llamenos-fleet doctor`,
  `journalctl --user -u llamenos-fleet-tick --since -6h`, `systemctl --user status ...`).
  Reproduce before fixing. No blind fixes, no workarounds.
- A halt that is DELIBERATE (operator halt with a reason, or the quota breaker that auto-resumes)
  is not yours to undo: record it in the status file and exit SUCCESS with notes.
- A halt from consecutive dispatch failures: find the root cause (e.g. dead provider id, wedged
  salvage worktree, broken dispatch-one.sh, expired token), fix it, then `llamenos-fleet resume`.
- Timer/service down: `systemctl --user restart/enable` the unit; if it fails, fix the cause.
- Review runner (`~/actions-runner-llamenos`, Runner.Listener) down: relaunch it detached
  (`cd ~/actions-runner-llamenos && setsid nohup ./run.sh >> runner.log 2>&1 &`). No sudo exists.
  NEVER kill a process group on a runner.
- Code fixes to the orchestrator go through a PR to Llamenos-Hotline/llamenos-platform
  (branch from origin/main, `Closes #N` if an issue exists); never push to main, never merge,
  never use --admin. Host config (systemd user units, ~/.llamenos-fleet) may be fixed in place.
- If you cannot fix it within budget, open (or comment on) a GitHub issue titled
  "fleet watchdog: <symptom>" with the evidence, and exit BLOCKED.
- Write the status file as instructed by the template; notes must say what was wrong and what
  you changed.

## Outcome checks — usually ENVIRONMENTAL, not a code defect

The watchdog also fails on outcomes (#1834): the fleet ticking on schedule while
merging nothing. These checks exist because liveness was green through a six-hour
total merge stall. When one of them is what fired, the cause is almost always the
environment around the fleet, and the fix is to restore service — do NOT open a
code PR unless the evidence below points at a specific defect.

- **`merge drought: no merge to main in <age>h (threshold <N>h) while <K> open PR(s)
  are CLEAN/MERGEABLE`** — main has not moved although mergeable work exists.
  Check, in order: the iOS Mac runner (disk full → guard refuses → queue ejects;
  `ssh mac df -k /System/Volumes/Data`, then
  `scripts/ci/mac-runner-disk-guard.sh reclaim` on the Mac); the Mac runners
  being online at all (they gate every merge); the review runner; and
  `llamenos-fleet missing-checks` for a required context that is ABSENT rather
  than red on every head (#1662 shape — re-run the owning workflow).
- **`mergeable but unqueued: <K> open non-draft base-main PRs ... no
  autoMergeRequest, and the merge queue is empty`** — the #1826 stall shape.
  PRs are green but nobody armed auto-merge. Look at why the arming path is not
  running: the last tick's outcome in the fleet log, the review gate's state on
  those PRs (`gh pr view <N> --json statusCheckRollup,autoMergeRequest`), not
  the PRs themselves.
- **`iOS runner disk headroom: <F> GiB free ... below the <W> GiB warn band`** —
  the disk guard's refusal is 4 GiB below the warn band, and the refusal is what
  ejects PRs (#1833). Reclaim on the Mac before it reaches refusal.
- **`iOS runner <host> unreachable over ssh`** — nothing can merge while the Mac
  runners are down; they gate every merge. Bring the host back (network, sshd,
  runner processes) and the drought checks will clear on their own.
- **`could not read GitHub state` / `unreachable`/`unreadable` evidence lines** —
  a measurement failure is reported as a failure on purpose; an unmeasured fleet
  is not a healthy one. If GitHub or the Mac is down, that IS the incident.

## Evidence from the watchdog

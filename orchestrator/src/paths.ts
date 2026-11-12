import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The single resolution point every fleet STATE path below derives from.
 * `FLEET_HOME` overrides `homedir()` — deliberately not a per-path override,
 * because this box runs both the real fleet and this test suite: a path that
 * resolved its own `homedir()` independently would silently escape the
 * override the moment someone added a new state file and forgot to route it
 * through here, and an isolation that some paths honour and others don't is
 * worse than no isolation at all (it looks safe while leaking). The test
 * suite points `FLEET_HOME` at a throwaway temp directory (see
 * `vitest.orchestrator.config.ts`) so nothing it does — including the
 * breaker-halt tests, which write the real halt file by design — can ever
 * touch `$HOME/.llamenos-fleet-disabled` on a box that is also running a
 * live fleet. Unset in production, this resolves to the real `homedir()`
 * exactly as before.
 */
function fleetHome(): string {
  return process.env['FLEET_HOME'] ?? homedir()
}

export const FLEET_DIR = join(fleetHome(), '.llamenos-fleet')
export const LOCK_FILE = join(FLEET_DIR, 'scheduler.lock')
export const LEDGER_FILE = join(FLEET_DIR, 'runs.jsonl')
export const HALT_REASON_FILE = join(FLEET_DIR, 'halt-reason.txt')
export const RESUMED_AT_FILE = join(FLEET_DIR, 'resumed-at')
export const LOG_FILE = join(FLEET_DIR, 'fleet.log')

/** Deliberately in `fleetHome()`, not `FLEET_DIR`: it must be creatable with
 *  `touch` by a human who does not know where the fleet keeps its state. */
export const HALT_FILE = join(fleetHome(), '.llamenos-fleet-disabled')

/**
 * Carries `GH_TOKEN` for the machine-user GitHub identity the fleet is meant
 * to dispatch and push under (#773). Deliberately derived from `FLEET_DIR`
 * (not `fleetHome()` directly) — the two systemd units
 * (`llamenos-fleet-tick.service`, `llamenos-fleet-digest.service`) and
 * `orchestrator/bin/llamenos-fleet` all hardcode `~/.llamenos-fleet/env`
 * (leading `-` on `EnvironmentFile=-%h/.llamenos-fleet/env` = missing file is
 * not fatal), so this constant MUST resolve to the same path or the
 * credential-permission guard in `checkFleetEnvFile` silently checks a file
 * nothing else reads or writes. `FLEET_DIR` already carries the
 * `.llamenos-fleet` segment — reusing it here, instead of re-deriving
 * `fleetHome() + '.llamenos-fleet'` a second time, is what keeps this one
 * source of truth. Until the file exists the fleet runs as whatever account
 * the ambient `gh`/git credentials belong to — see `fleet-env.ts`'s
 * `checkFleetEnvFile`, which `doctor` surfaces as a WARNING (not a failure)
 * for exactly that reason.
 */
export const FLEET_ENV_FILE = join(FLEET_DIR, 'env')

/**
 * Issue #838: the fleet's deterministic, always-visible reporting channel is
 * a single dedicated, pinned GitHub issue titled "Fleet digest" — created
 * once and remembered here so every later `digest`/`halt`/`resume` invocation
 * (each a separate process) resolves the SAME issue instead of searching or,
 * worse, creating a new one every pass. See `digest-issue.ts`.
 */
export const DIGEST_ISSUE_FILE = join(FLEET_DIR, 'digest-issue')

/**
 * Issue #838: "fleet PRs opened since the last digest" needs a persisted
 * high-water mark — the digest's own `hours` lookback window (default 12h)
 * is a display convenience for the existing sections, not a promise about
 * exactly when the last digest ran. Read before rendering, written after
 * (see `digest-issue.ts`'s `readLastDigestAt`/`writeLastDigestAt`).
 */
export const LAST_DIGEST_AT_FILE = join(FLEET_DIR, 'last-digest-at')

/**
 * #2742: the state `review-and-merge`'s runaway guards keep between
 * invocations — a per-PR in-flight lock and a per-head-SHA attempt ledger.
 * Each invocation is a separate process, so neither can live in memory. See
 * `review-and-merge-guards.ts`.
 */
export const REVIEW_AND_MERGE_DIR = join(FLEET_DIR, 'review-and-merge')

/** #2738: the in-flight lock and per-head attempt ledger of a re-verification
 *  pass (`claimReentry`, reverify.ts). Its own directory, not shared with
 *  `review-and-merge`: the two keep separate allowances for the same head. */
export const REVERIFY_DIR = join(FLEET_DIR, 'reverify')

/**
 * `dispatch-one.sh` is NOT vendored into this repo. It lives at
 * `~/.claude/skills/supervising-dispatched-sessions/`, which is a symlink into
 * the `claude-skills` git repository — a real, separately-committed repo, not
 * an untracked local script. That means llamenos cannot pin a version of it:
 * a change committed to `claude-skills` takes effect on the very next dispatch
 * with no llamenos commit at all, and the fleet cannot run at all on a machine
 * where that repo is absent. Vendoring a duplicate here would just create a
 * second source of truth for one script, so instead `dependency.ts` verifies
 * this path is present, executable, reproducible (no uncommitted changes) and
 * carrying rules this repo can actually satisfy — see `checkDispatchDependency`.
 */
export const DISPATCH_SKILL_DIR = join(homedir(), '.claude', 'skills', 'supervising-dispatched-sessions')
export const DISPATCH_SCRIPT = join(DISPATCH_SKILL_DIR, 'dispatch-one.sh')

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Issue #2512 — a unit the orchestrator relies on that is not installed, not
 * enabled, or enabled-but-not-scheduled is a feature that is merged, green
 * and doing nothing. `llamenos-fleet-queue-feed.timer` sat committed and
 * un-enabled while #2036 and #2458's auto-re-queue were counted as shipped.
 *
 * The expected set is READ from `orchestrator/systemd/` in the checkout the
 * fleet runs from — the files that ship the units ARE the list, so a new unit
 * added to that directory is checked by `doctor` the moment it lands, with no
 * second list to forget to update. "Is anything else dormant the same way?"
 * is answered by running `doctor`.
 *
 * Every finding is a problem string for doctor's WARN section (the severity
 * `doctor` already gives a missing credential file): a developer machine or CI
 * runner legitimately has no fleet units, so this must not FAIL there.
 */

export interface ExpectedUnit {
  /** `llamenos-fleet-tick.timer` */
  name: string
  kind: 'timer' | 'service'
  /** The repo copy, for the installed-copy drift comparison. */
  content: string
}

/** What `systemctl --user show` reports for one unit. */
export interface UnitFacts {
  loadState: string
  /** `enabled`, `static`, `disabled`, … ('' for a unit that is not found). */
  unitFileState: string
  activeState: string
  /** Services: `success` or the failure result of the last run. */
  result: string
  /** Where the loaded unit file lives (a symlink is followed when read). */
  fragmentPath: string
  /** Timers: the next trigger, '' when nothing is scheduled. */
  nextElapse: string
}

/** `undefined` = systemd could not be queried at all (no user bus, no systemctl). */
export type UnitProbe = (unit: string) => UnitFacts | undefined

export function expectedUnits(root: string): ExpectedUnit[] {
  const dir = join(root, 'orchestrator', 'systemd')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => n.endsWith('.timer') || n.endsWith('.service'))
    .sort()
    .map((name) => ({
      name,
      kind: name.endsWith('.timer') ? 'timer' as const : 'service' as const,
      content: readFileSync(join(dir, name), 'utf8'),
    }))
}

export const systemctlProbe: UnitProbe = (unit) => {
  let out: string
  try {
    out = execFileSync('systemctl', [
      '--user', 'show', unit, '--no-pager',
      '-p', 'LoadState,UnitFileState,ActiveState,Result,FragmentPath,NextElapseUSecRealtime',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  } catch {
    return undefined
  }
  const kv = new Map<string, string>()
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim())
  }
  return {
    loadState: kv.get('LoadState') ?? '',
    unitFileState: kv.get('UnitFileState') ?? '',
    activeState: kv.get('ActiveState') ?? '',
    result: kv.get('Result') ?? '',
    fragmentPath: kv.get('FragmentPath') ?? '',
    nextElapse: kv.get('NextElapseUSecRealtime') ?? '',
  }
}

const readFile = (path: string): string | undefined => {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

const INSTALL_HINT = 'cp orchestrator/systemd/*.service orchestrator/systemd/*.timer ~/.config/systemd/user/ && ' +
  'systemctl --user daemon-reload && systemctl --user enable --now <timer>'

/**
 * The pure comparison: expected units vs what the host reports. One problem
 * per finding, each naming the unit and the remedy.
 */
export function unitProblems(
  expected: readonly ExpectedUnit[],
  probe: UnitProbe,
  readInstalled: (path: string) => string | undefined = readFile,
): string[] {
  if (expected.length === 0) return []
  const timers = new Set(expected.filter((u) => u.kind === 'timer').map((u) => u.name.replace(/\.timer$/, '')))
  const problems: string[] = []
  for (const unit of expected) {
    const f = probe(unit.name)
    if (f === undefined) {
      return [`cannot query systemd --user — none of the ${expected.length} expected fleet unit(s) in orchestrator/systemd/ could be verified (no user bus, or systemctl missing)`]
    }
    if (f.loadState !== 'loaded') {
      problems.push(`${unit.name} is not installed (${f.loadState || 'unknown'}) — whatever it schedules never runs; ${INSTALL_HINT}`)
      continue
    }
    if (unit.kind === 'timer') {
      if (f.unitFileState !== 'enabled' && f.unitFileState !== 'enabled-runtime') {
        problems.push(`${unit.name} is installed but not enabled (${f.unitFileState || 'unknown'}) — it will not start after a reboot; systemctl --user enable --now ${unit.name}`)
      }
      if (f.activeState !== 'active') {
        problems.push(`${unit.name} is ${f.unitFileState.startsWith('enabled') ? 'enabled but ' : ''}not active (${f.activeState || 'unknown'}) — nothing is scheduled; systemctl --user start ${unit.name}`)
      } else if (f.nextElapse === '') {
        // README: is-enabled and is-active both say yes while systemd schedules
        // nothing. Only a next-trigger time proves the timer will fire.
        problems.push(`${unit.name} is active but has NO next trigger scheduled — it will never fire; check its OnCalendar and run systemctl --user daemon-reload`)
      }
    } else if (f.activeState === 'failed' || (f.result !== '' && f.result !== 'success')) {
      const owner = timers.has(unit.name.replace(/\.service$/, '')) ? ' (its timer keeps firing a failing service)' : ''
      problems.push(`${unit.name} last run did not succeed (${f.activeState}, Result=${f.result || 'unknown'})${owner} — journalctl --user -u ${unit.name} -n 50`)
    }
    const installed = f.fragmentPath !== '' ? readInstalled(f.fragmentPath) : undefined
    if (installed !== undefined && installed !== unit.content) {
      problems.push(`${unit.name} on the host (${f.fragmentPath}) differs from orchestrator/systemd/${unit.name} — a merged unit change is not installed; re-copy it and systemctl --user daemon-reload`)
    }
  }
  return problems
}

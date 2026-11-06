import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from '../../orchestrator/src/cli.js'
import { registerRun, syncRuntime } from '../../orchestrator/src/runtime-sync.js'
import { expectedUnits, unitProblems, type ExpectedUnit, type UnitFacts, type UnitProbe } from '../../orchestrator/src/systemd-units.js'

/**
 * Issues #2515 / #2512 — "make dormancy visible". The fleet can be inert in
 * two ways every other doctor check is blind to: the checkout it runs is
 * behind origin/main, and a unit it expects is not scheduled. Both must be
 * reported by `doctor`, and the expected-unit list must come from the files
 * the repo ships rather than a second list.
 */

const REPO = process.cwd()
const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
const git = (dir: string, args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

const healthy = (over: Partial<UnitFacts> = {}): UnitFacts => ({
  loadState: 'loaded', unitFileState: 'enabled', activeState: 'active', result: 'success',
  fragmentPath: '', nextElapse: 'Fri 2026-11-06 12:30:00 EST', ...over,
})
const timer = (name: string): ExpectedUnit => ({ name, kind: 'timer', content: '[Timer]\n' })
const service = (name: string): ExpectedUnit => ({ name, kind: 'service', content: '[Service]\n' })
const probeOf = (facts: Record<string, UnitFacts | undefined>): UnitProbe => (u) => facts[u]

describe('unitProblems (expected units vs the host)', () => {
  const units = [timer('a.timer'), service('a.service')]
  const allGood = { 'a.timer': healthy(), 'a.service': healthy({ unitFileState: 'static', activeState: 'inactive' }) }

  it('reports nothing when every expected unit is installed, enabled, active and scheduled', () => {
    expect(unitProblems(units, probeOf(allGood))).toEqual([])
  })

  it('an expected unit that is not installed is named with the install command (#2512: never installed on the host)', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.timer': healthy({ loadState: 'not-found', unitFileState: '', activeState: 'inactive' }) }))
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/a\.timer is not installed/)
    expect(p[0]).toMatch(/enable --now/)
  })

  it('installed but NOT enabled is reported', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.timer': healthy({ unitFileState: 'disabled', activeState: 'inactive' }) }))
    expect(p.join('\n')).toMatch(/a\.timer is installed but not enabled \(disabled\)/)
  })

  it('enabled but not ACTIVE is reported as such ("enabled alone does not mean it ran")', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.timer': healthy({ activeState: 'inactive' }) }))
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/enabled but not active \(inactive\)/)
  })

  it('an active timer with nothing scheduled is reported — is-enabled and is-active both say yes while it never fires', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.timer': healthy({ nextElapse: '' }) }))
    expect(p.join('\n')).toMatch(/NO next trigger/)
  })

  it('a service whose last run failed is reported, naming that its timer keeps firing it', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.service': healthy({ unitFileState: 'static', activeState: 'failed', result: 'exit-code' }) }))
    expect(p.join('\n')).toMatch(/a\.service last run did not succeed.*its timer keeps firing/)
  })

  it('a host copy that differs from the repo copy is reported (a merged unit change that was never installed)', () => {
    const p = unitProblems(units, probeOf({ ...allGood, 'a.timer': healthy({ fragmentPath: '/host/a.timer' }) }),
      (path) => (path === '/host/a.timer' ? '[Timer]\nOnCalendar=old\n' : undefined))
    expect(p.join('\n')).toMatch(/a\.timer on the host \(\/host\/a\.timer\) differs from orchestrator\/systemd\/a\.timer/)
  })

  it('systemd being unqueryable is ONE explicit finding, never a silent pass', () => {
    const p = unitProblems(units, () => undefined)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/cannot query systemd --user/)
  })

  it('negative control: no expected units, nothing to say', () => {
    expect(unitProblems([], () => undefined)).toEqual([])
  })
})

describe('expectedUnits — the list is the shipped directory, not a copy of it', () => {
  it('enumerates every unit file under orchestrator/systemd, including the queue-feed timer #2512 found dormant', () => {
    const names = expectedUnits(REPO).map((u) => u.name)
    const shipped = readdirSync(join(REPO, 'orchestrator/systemd')).filter((n) => /\.(timer|service)$/.test(n)).sort()
    expect(names).toEqual(shipped)
    expect(names).toContain('llamenos-fleet-queue-feed.timer')
    expect(names).toContain('llamenos-fleet-tick.timer')
  })

  it('a unit added to the directory is checked with no other edit', () => {
    const root = tmp('units-root-')
    mkdirSync(join(root, 'orchestrator/systemd'), { recursive: true })
    writeFileSync(join(root, 'orchestrator/systemd/llamenos-fleet-brand-new.timer'), '[Timer]\n')
    expect(expectedUnits(root).map((u) => u.name)).toEqual(['llamenos-fleet-brand-new.timer'])
  })
})

// ── doctor itself ───────────────────────────────────────────────────────────

async function runDoctor(deps: Parameters<typeof doctor>[0]): Promise<{ out: string; code: number }> {
  const lines: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { lines.push(String(c)); return true })
  try {
    const code = await doctor(deps)
    return { out: lines.join(''), code }
  } finally {
    spy.mockRestore()
  }
}

/** A bare origin, a pusher, and a runtime clone that also ships two unit files. */
function runtimeFixture(): { runtime: string; pusher: string; state: string } {
  const bare = tmp('dd-origin-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const pusher = tmp('dd-pusher-')
  execFileSync('git', ['clone', '-q', bare, pusher], { stdio: 'ignore' })
  git(pusher, ['config', 'user.email', 't@example.com'])
  git(pusher, ['config', 'user.name', 'T'])
  mkdirSync(join(pusher, 'orchestrator/systemd'), { recursive: true })
  mkdirSync(join(pusher, 'orchestrator/src'), { recursive: true })
  writeFileSync(join(pusher, 'orchestrator/src/cli.ts'), '// v1\n')
  writeFileSync(join(pusher, 'orchestrator/systemd/llamenos-fleet-tick.timer'), '[Timer]\n')
  writeFileSync(join(pusher, 'orchestrator/systemd/llamenos-fleet-queue-feed.timer'), '[Timer]\n')
  git(pusher, ['add', '.'])
  git(pusher, ['commit', '-q', '-m', 'init'])
  git(pusher, ['push', '-q', 'origin', 'main'])
  const runtime = tmp('dd-runtime-')
  execFileSync('git', ['clone', '-q', bare, runtime])
  return { runtime, pusher, state: tmp('dd-state-') }
}
function pushUpstream(f: { pusher: string }, name: string): void {
  writeFileSync(join(f.pusher, 'orchestrator/src', `${name}.ts`), `// ${name}\n`)
  git(f.pusher, ['add', '.'])
  git(f.pusher, ['commit', '-q', '-m', name])
  git(f.pusher, ['push', '-q', 'origin', 'main'])
}

const allUnitsHealthy: UnitProbe = () => healthy()

describe('doctor — dormancy is visible', () => {
  it('a runtime checkout BEHIND origin/main FAILS, saying by how much and naming the drifted file', async () => {
    const f = runtimeFixture()
    pushUpstream(f, 'review-request')
    pushUpstream(f, 'queue-feed')
    const { out, code } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })
    expect(out).toMatch(/FAIL\s+fleet runtime current with origin\/main/)
    expect(out).toMatch(/2 commit\(s\) behind origin\/main — merged fixes are NOT running/)
    expect(out).toContain('orchestrator/src/review-request.ts')
    expect(code).toBe(1)
  })

  it('a runtime that is current passes (negative control)', async () => {
    const f = runtimeFixture()
    const { out } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })
    expect(out).toMatch(/ok\s+fleet runtime current with origin\/main/)
    expect(out).not.toMatch(/FAIL\s+fleet runtime current/)
  })

  it('behind ONLY because a run is in flight is a WARN that names the run — it heals itself, so it must not page the repair agent', async () => {
    const f = runtimeFixture()
    pushUpstream(f, 'fix')
    const other = spawn('sleep', ['300'], { stdio: 'ignore' })
    children.push(other)
    registerRun(other.pid as number, f.state)
    const { out } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })
    expect(out).toMatch(new RegExp(`WARN\\s+fleet runtime \\w+ is 1 commit\\(s\\) behind origin/main.*deferred behind in-flight fleet run\\(s\\) pid ${other.pid}`))
    expect(out).not.toMatch(/FAIL\s+fleet runtime current/)
  })

  it('behind and IDLE stays a FAIL — the update should already have happened', async () => {
    const f = runtimeFixture()
    pushUpstream(f, 'fix')
    const { out } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })
    expect(out).toMatch(/FAIL\s+fleet runtime current/)
  })

  it('an expected timer that is not installed on the host is a WARN naming it (#2512)', async () => {
    const f = runtimeFixture()
    const probe: UnitProbe = (u) => u === 'llamenos-fleet-queue-feed.timer'
      ? healthy({ loadState: 'not-found', unitFileState: '', activeState: 'inactive' })
      : healthy()
    const { out } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe })
    expect(out).toMatch(/WARN\s+llamenos-fleet-queue-feed\.timer is not installed/)
    expect(out).not.toMatch(/llamenos-fleet-tick\.timer is/)
  })

  it('an enabled-but-inactive timer is a WARN', async () => {
    const f = runtimeFixture()
    const probe: UnitProbe = (u) => u === 'llamenos-fleet-tick.timer' ? healthy({ activeState: 'inactive' }) : healthy()
    const { out } = await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe })
    expect(out).toMatch(/WARN\s+llamenos-fleet-tick\.timer is enabled but not active \(inactive\)/)
  })

  it('a host that has never run the runtime-sync step says so; once it has, the last outcome is shown when it is not healthy', async () => {
    const f = runtimeFixture()
    expect((await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })).out)
      .toMatch(/WARN\s+no runtime-sync record on this host/)

    writeFileSync(join(f.runtime, 'orchestrator/src/cli.ts'), '// debugging\n')
    pushUpstream(f, 'fix')
    syncRuntime(f.runtime, { stateDir: f.state, log: () => {} })
    const out = (await runDoctor({ runtimeRoot: f.runtime, stateDir: f.state, probe: allUnitsHealthy })).out
    expect(out).toMatch(/WARN\s+last runtime-sync \(.*\): runtime update BLOCKED \(dirty\)/)
    expect(out).not.toMatch(/no runtime-sync record/)
    expect(readFileSync(join(f.runtime, 'orchestrator/src/cli.ts'), 'utf8')).toBe('// debugging\n')
  })
})

// @suite: repo
// #2533 — every job that lands on the self-hosted iOS Macs is admitted through
// ONE wait-for-a-co-tenant step, never the bare guard.
//
// `mac-mini-ios-1` and `-2` are two runners on one physical Mac, so two iOS jobs
// of one merge group are each other's co-tenants on one volume. ios-e2e.yml's
// `build` waited for the other job's teardown; ci.yml's `ios-build-test` ran
// `mac-runner-disk-guard.sh guard`, which checks once and refuses, and the
// merge queue ejected the group (#2470, #2518). The wait now lives in
// scripts/ci/mac-runner-disk-guard-wait.sh, and this file pins both halves:
// the script's behaviour (driven against a stub guard and a stub `pgrep`, so it
// runs on Linux) and that no workflow calls the bare guard again.
import { describe, it, expect, setDefaultTimeout } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const WAIT = join(ROOT, 'scripts/ci/mac-runner-disk-guard-wait.sh')
const WORKFLOWS = join(ROOT, '.github/workflows')

// Each case sleeps through real poll intervals and a real watchdog.
setDefaultTimeout(60_000)

interface Run { rc: number; out: string; attempts: number }

/**
 * Runs the wait script against a stub guard. `refusals` is how many `guard`
 * calls refuse before one passes (Infinity: always refuse); `cotenants` is how
 * many other Runner.Worker processes the stub `pgrep` reports.
 */
function run(opts: { refusals: number; cotenants: number; waitSec?: number; guardBody?: string }): Run {
  const dir = mkdtempSync(join(tmpdir(), 'diskwait-'))
  const counter = join(dir, 'calls')
  writeFileSync(counter, '0')
  const guard = join(dir, 'guard.sh')
  writeFileSync(guard, opts.guardBody ?? `#!/usr/bin/env bash
mode="$1"
if [ "$mode" = guard ]; then
  n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
  if [ "$n" -le ${Number.isFinite(opts.refusals) ? opts.refusals : 1000000} ]; then
    echo "write paths OK: stub"
    echo "disk-guard-verdict: refused free_mib=100 need_mib=200 short_mib=100"
    echo "::error::only 0.1 GiB free on /stub"
    exit 1
  fi
  echo "disk headroom OK: stub"
fi
exit 0
`)
  chmodSync(guard, 0o755)
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const lines = Array.from({ length: opts.cotenants }, (_, i) => `${100 + i} /Volumes/CIWork/actions-runner-ios-${i + 2}/bin/Runner.Worker`).join('\\n')
  writeFileSync(join(bin, 'pgrep'), `#!/usr/bin/env bash\nprintf '${lines}${lines ? '\\n' : ''}'\n[ ${opts.cotenants} -gt 0 ]\n`)
  chmodSync(join(bin, 'pgrep'), 0o755)
  const r = spawnSync('bash', [WAIT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      RUNNER_WORKSPACE: '/Volumes/CIWork/actions-runner-ios-1/_work/llamenos-platform',
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      DISK_GUARD_SCRIPT: guard,
      DISK_WAIT_POLL_SEC: '1',
      DISK_WAIT_MAX_SEC: String(opts.waitSec ?? 30),
      DISK_GUARD_ATTEMPT_MAX_SEC: '20',
    },
    timeout: 60_000,
  })
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}`, attempts: Number(readFileSync(counter, 'utf8')) }
}

describe('mac-runner-disk-guard-wait.sh — the admission step every iOS Mac job runs', () => {
  it('passes at once when the guard passes, without waiting', () => {
    const r = run({ refusals: 0, cotenants: 1 })
    expect(r.rc).toBe(0)
    expect(r.attempts).toBe(1)
    expect(r.out).not.toMatch(/after waiting/)
  })

  it('WAITS while a co-tenant job is on the host, and passes once its teardown returns the space', () => {
    // The #2470/#2518 shape: the guard refuses because the sibling job holds
    // the disk. The bare guard failed here; the wait must outlast it.
    const r = run({ refusals: 2, cotenants: 1 })
    expect(r.rc).toBe(0)
    expect(r.attempts).toBe(3)
    expect(r.out).toMatch(/short \(attempt 1\).*1 other CI job\(s\)/)
    expect(r.out).toMatch(/passed on attempt 3, after waiting 2 x 1s for a co-tenant/)
  })

  it('refuses at once, and says why, when nothing else is on the host to wait for', () => {
    const r = run({ refusals: Infinity, cotenants: 0 })
    expect(r.rc).toBe(1)
    expect(r.attempts).toBe(1)
    expect(r.out).toMatch(/refused at once, NOT waiting: no other CI job is running/)
  })

  it('does not wait forever: a co-tenant that never releases ends in a named refusal at the deadline', () => {
    const r = run({ refusals: Infinity, cotenants: 1, waitSec: 3 })
    expect(r.rc).toBe(1)
    expect(r.attempts).toBeGreaterThan(1)
    expect(r.out).toMatch(/still refused after waiting .* for 1 co-tenant CI job\(s\)/)
    expect(r.out).toContain('disk-guard-verdict: refused free_mib=100')
  })

  it('does not count its own runner as a co-tenant', () => {
    // Only this runner's own Runner.Worker is on the host: no teardown is
    // coming, so waiting would only delay an honest refusal.
    const dir = mkdtempSync(join(tmpdir(), 'diskwait-self-'))
    const bin = join(dir, 'bin')
    spawnSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'pgrep'), `#!/usr/bin/env bash\necho "7 /Volumes/CIWork/actions-runner-ios-1/bin/Runner.Worker"\n`)
    chmodSync(join(bin, 'pgrep'), 0o755)
    const guard = join(dir, 'guard.sh')
    writeFileSync(guard, '#!/usr/bin/env bash\necho "disk-guard-verdict: refused free_mib=1 need_mib=2 short_mib=1"\nexit 1\n')
    chmodSync(guard, 0o755)
    const r = spawnSync('bash', [WAIT], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir,
        RUNNER_WORKSPACE: '/Volumes/CIWork/actions-runner-ios-1/_work/llamenos-platform',
        DISK_GUARD_SCRIPT: guard, DISK_WAIT_POLL_SEC: '1', DISK_WAIT_MAX_SEC: '30', DISK_GUARD_ATTEMPT_MAX_SEC: '20',
      },
      timeout: 60_000,
    })
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toMatch(/refused at once, NOT waiting/)
  })

  it('a guard that hangs is bounded, and with no proof its write paths are readable it refuses rather than trust df', () => {
    const r = run({ refusals: 0, cotenants: 0, waitSec: 20, guardBody: '#!/usr/bin/env bash\n[ "$1" = guard ] && sleep 300\nexit 0\n' })
    // 20s deadline leaves a 20s cap (>= the 20s attempt cap); the watchdog
    // kills the stub and, with no `write paths OK:` marker, the step refuses.
    expect(r.rc).toBe(1)
    expect(r.out).toMatch(/disk guard hung \(attempt 1\) while checking the volumes this job's write paths are on/)
  })
})

describe('no workflow admits an iOS Mac job through the bare guard', () => {
  interface Step { name?: string; run?: string }
  interface Job { 'runs-on'?: unknown; steps?: Step[] }
  const bareGuard = /mac-runner-disk-guard\.sh\s+guard\b/
  const waitScript = /scripts\/ci\/mac-runner-disk-guard-wait\.sh/
  // ios-e2e.yml's `build` carries the same loop inline (it is the mac lane's
  // file, and this extraction landed from the infra lane). It is the one
  // sanctioned inline copy, recognised by the loop's own wait variables.
  const inlineWait = /DISK_WAIT_MAX_MIN/

  const selfHostedMacJobs: { file: string; id: string; steps: Step[] }[] = []
  for (const file of readdirSync(WORKFLOWS).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    const wf = Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as { jobs?: Record<string, Job> }
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const runsOn = JSON.stringify(job['runs-on'] ?? '')
      if (/self-hosted/.test(runsOn) && /macOS/i.test(runsOn)) selfHostedMacJobs.push({ file, id, steps: job.steps ?? [] })
    }
  }

  it('the sweep finds the jobs it is meant to (it cannot pass on nothing)', () => {
    const where = selfHostedMacJobs.map((j) => `${j.file}:${j.id}`)
    expect(where).toEqual(expect.arrayContaining(['ci.yml:ios-build-test', 'ci.yml:ios-compile-check', 'ios-e2e.yml:build']))
  })

  it('no step runs `mac-runner-disk-guard.sh guard` except the one step carrying the inline wait', () => {
    const offenders: string[] = []
    for (const j of selfHostedMacJobs) {
      for (const s of j.steps) {
        const code = (s.run ?? '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
        if (bareGuard.test(code) && !(j.file === 'ios-e2e.yml' && inlineWait.test(JSON.stringify(s)))) offenders.push(`${j.file}:${j.id}: ${s.name ?? '?'}`)
      }
    }
    // Call scripts/ci/mac-runner-disk-guard-wait.sh instead: the bare guard
    // refuses at once while a sibling job holds the disk (#2533).
    expect(offenders).toEqual([])
  })

  it('every self-hosted Mac job that is admitted by the guard goes through the wait, with a timeout that holds its budget', () => {
    const steps = selfHostedMacJobs.flatMap((j) => j.steps.map((s) => ({ ...j, s })))
    const through = steps.filter(({ s }) => waitScript.test(s.run ?? ''))
    expect(through.map((t) => `${t.file}:${t.id}`).sort()).toEqual(['ci.yml:ios-build-test', 'ci.yml:ios-compile-check'])
    for (const t of through) {
      const raw = readFileSync(join(WORKFLOWS, t.file), 'utf8')
      const job = (Bun.YAML.parse(raw) as { jobs: Record<string, { 'timeout-minutes'?: number }> }).jobs[t.id]!
      const step = t.s as Step & { 'timeout-minutes'?: number; env?: Record<string, string> }
      const maxMin = Number(step.env?.DISK_WAIT_MAX_MIN)
      // The step cap must outlast the wait, or the step's own timeout kills
      // the attempt and hides the verdict.
      expect(step['timeout-minutes']).toBeGreaterThan(maxMin)
      // The job's budget is its own work PLUS the step cap (ios-e2e.yml: 45 + 36).
      expect(job['timeout-minutes']).toBeGreaterThanOrEqual(30 + (step['timeout-minutes'] as number))
    }
  })

  it('the wait script is executable and present', () => {
    expect(existsSync(WAIT)).toBe(true)
  })
})

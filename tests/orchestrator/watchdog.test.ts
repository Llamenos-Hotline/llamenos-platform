import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// orchestrator/bin/llamenos-fleet-watchdog is the hourly health check whose
// liveness-only checks logged `ok` through a six-hour total merge stall
// (#1834). These tests audit the gates by BREAKING them
// (feedback_audit_gates_by_breaking): each scenario stubs one measurement —
// the last-merge timestamp, the open-PR set, the merge queue depth, the Mac's
// df over ssh, or a liveness probe — and asserts the watchdog's log line and
// repair dispatch, never its internals. Stubs are PATH binaries (gh, ssh,
// systemctl, pgrep, tmux, journalctl, llamenos-fleet, dispatch) driven by
// GH_STUB_*/SSH_STUB_*/SYSTEMCTL_STUB_* env vars, so the REAL script runs
// end-to-end against a fleet that is lying to it in exactly one way.

const REPO = process.cwd()
const SCRIPT = join(REPO, 'orchestrator/bin/llamenos-fleet-watchdog')
const BRIEF_TEMPLATE = join(REPO, 'orchestrator/systemd/llamenos-fleet-watchdog-brief.md')
const scratch: string[] = []

const ONE_HUNDRED_GIB_KIB = 104857600
const TEN_GIB_KIB = 10485760

function isoHoursAgo(hours: number): string {
  // No milliseconds — GitHub's timestamps carry none and GNU date rejects them.
  return new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface Pr {
  number: number
  isDraft: boolean
  mergeStateStatus: string
  autoMergeRequest: { enabledAt: string } | null
}

const cleanArmed = (n: number): Pr => ({ number: n, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: 'x' } })
const cleanUnarmed = (n: number): Pr => ({ number: n, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: null })
const draftUnarmed = (n: number): Pr => ({ number: n, isDraft: true, mergeStateStatus: 'CLEAN', autoMergeRequest: null })
const blockedUnarmed = (n: number): Pr => ({ number: n, isDraft: false, mergeStateStatus: 'BLOCKED', autoMergeRequest: null })

const STUBS: Record<string, string> = {
  // Applies gh's --jq through a real jq so the script's filters are exercised
  // against the canned JSON, exactly as the real gh would apply them.
  gh: `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
if [ "\${GH_STUB_FAIL:-0}" = 1 ]; then echo "gh: stubbed api outage" >&2; exit 1; fi
jqexpr=""
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  if [ "\${args[$i]}" = "--jq" ]; then jqexpr="\${args[$((i+1))]}"; fi
done
if [[ " $* " == *" pr "* && " $* " == *" list "* ]]; then
  out="$GH_STUB_PRS"
elif [[ " $* " == *"commits/main"* ]]; then
  out="{\\"commit\\":{\\"committer\\":{\\"date\\":\\"$GH_STUB_MAIN_DATE\\"}}}"
elif [[ " $* " == *" graphql "* ]]; then
  out="{\\"data\\":{\\"repository\\":{\\"mergeQueue\\":{\\"entries\\":{\\"totalCount\\":\${GH_STUB_QUEUE:-0}}}}}}"
else
  echo "gh stub: unexpected args: $*" >&2; exit 2
fi
if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
`,
  ssh: `#!/usr/bin/env bash
echo "ssh $*" >> "$STUB_LOG"
if [ "\${SSH_STUB_MODE:-ok}" = real ]; then exec /usr/bin/ssh "$@"; fi
if [ "\${SSH_STUB_MODE:-ok}" = fail ]; then
  echo "ssh: connect to host mac port 22: Connection timed out" >&2
  exit 255
fi
printf 'Filesystem     1K-blocks      Used  Available Capacity Mounted on\\n'
printf '/dev/disk3s1   976762336 800000000 %s   82%% /System/Volumes/Data\\n' "\${SSH_STUB_AVAIL_KIB:-${ONE_HUNDRED_GIB_KIB}}"
`,
  systemctl: `#!/usr/bin/env bash
if [[ " $* " == *" is-active "* ]]; then
  echo "\${SYSTEMCTL_STUB_TIMER_ACTIVE:-active}"
  [ "\${SYSTEMCTL_STUB_TIMER_ACTIVE:-active}" = active ] && exit 0 || exit 3
fi
if [[ " $* " == *" show "* ]]; then
  case "$*" in
    *Result*) echo "\${SYSTEMCTL_STUB_RESULT:-success}" ;;
    *ActiveState*) echo "\${SYSTEMCTL_STUB_ACTIVE_STATE:-inactive}" ;;
    *InactiveExitTimestamp*) date '+%a %Y-%m-%d %H:%M:%S %Z' ;;
    *LastTriggerUSec*) echo "\${SYSTEMCTL_STUB_LAST_TRIGGER:-$(date '+%a %Y-%m-%d %H:%M:%S %Z')}" ;;
  esac
fi
exit 0
`,
  'llamenos-fleet': `#!/usr/bin/env bash
case "\${1:-}" in
  status) echo "\${FLEET_STUB_STATUS_LINE:-halted: no}"; exit "\${FLEET_STUB_STATUS_EXIT:-0}" ;;
  doctor) echo "\${FLEET_STUB_DOCTOR_OUT:-ok: all checks passed}"; exit "\${FLEET_STUB_DOCTOR_EXIT:-0}" ;;
esac
exit 0
`,
  pgrep: '#!/usr/bin/env bash\nexit 0\n',
  tmux: '#!/usr/bin/env bash\nexit 1\n',
  journalctl: '#!/usr/bin/env bash\necho "stub tick journal"\n',
  // #2655: the repair dispatch runs through bin/llamenos-isolate, which would
  // otherwise open a REAL transient scope on whatever box runs this suite. This
  // stub records that the scope was requested, then runs the command itself.
  'systemd-run': `#!/usr/bin/env bash
echo "scope-wrapped" >> "$STUB_LOG"
while [[ "\${1:-}" != -- ]]; do shift; done
shift
exec "$@"
`,
  dispatch: `#!/usr/bin/env bash
echo "dispatch $*" >> "$STUB_LOG"
exit 0
`,
}

interface RunResult {
  status: number | null
  stderr: string
  log: string
  stubLog: string
  brief: string | null
}

interface Scenario {
  prs?: Pr[]
  mainDate?: string
  queue?: number
  sshMode?: 'ok' | 'fail' | 'real'
  sshAvailKib?: number
  macHost?: string
  sshConnectTimeout?: string
  timerActive?: 'active' | 'inactive'
  ghFail?: boolean
}

function runWatchdog(s: Scenario): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'watchdog-test-'))
  scratch.push(root)
  const bin = join(root, 'bin')
  const state = join(root, 'state')
  const repo = join(root, 'repo')
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(join(repo, 'orchestrator/systemd'), { recursive: true })

  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  // The repair brief template resolves at $REPO/orchestrator/systemd/… — the
  // real template, copied, so a rename or deletion breaks this suite loudly.
  cpSync(BRIEF_TEMPLATE, join(repo, 'orchestrator/systemd/llamenos-fleet-watchdog-brief.md'))

  // A real git repo so the GH repo slug is DERIVED from origin at read time,
  // never passed in — the pin this suite then asserts via the stub log.
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Llamenos-Hotline/llamenos-platform.git'], { encoding: 'utf8' })

  const stubLog = join(root, 'stub.log')
  const env: Record<string, string> = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    FLEET_WATCHDOG_PATH: `${bin}:/usr/bin:/bin`,
    FLEET_WATCHDOG_REPO: repo,
    FLEET_WATCHDOG_DIR: state,
    FLEET_WATCHDOG_DISPATCH: join(bin, 'dispatch'),
    STUB_LOG: stubLog,
    GH_STUB_PRS: JSON.stringify(s.prs ?? []),
    GH_STUB_MAIN_DATE: s.mainDate ?? isoHoursAgo(1),
    GH_STUB_QUEUE: String(s.queue ?? 0),
    GH_STUB_FAIL: s.ghFail ? '1' : '0',
    SSH_STUB_MODE: s.sshMode ?? 'ok',
    SSH_STUB_AVAIL_KIB: String(s.sshAvailKib ?? ONE_HUNDRED_GIB_KIB),
    ...(s.macHost ? { MAC_SSH_HOST: s.macHost } : {}),
    ...(s.sshConnectTimeout ? { WATCHDOG_SSH_CONNECT_TIMEOUT: s.sshConnectTimeout } : {}),
    ...(s.timerActive ? { SYSTEMCTL_STUB_TIMER_ACTIVE: s.timerActive } : {}),
  }
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 60_000 })

  const log = readFileSync(join(state, 'watchdog.log'), 'utf8')
  const briefFile = readdirSync(state).find((f) => /^fleet-watchdog-.*\.md$/.test(f))
  return {
    status: r.status,
    stderr: r.stderr ?? '',
    log,
    stubLog: readFileSync(stubLog, 'utf8'),
    brief: briefFile ? readFileSync(join(state, briefFile), 'utf8') : null,
  }
}

function expectHealthy(r: RunResult) {
  expect(r.status, r.stderr).toBe(0)
  expect(r.log).not.toContain('UNHEALTHY')
  expect(r.log.trimEnd().endsWith(' ok')).toBe(true)
  expect(r.stubLog).not.toContain('dispatch ')
}

function expectUnhealthy(r: RunResult, pattern: RegExp) {
  expect(r.status, r.stderr).toBe(0)
  expect(r.log).toContain('UNHEALTHY')
  expect(r.log).toMatch(pattern)
  // An UNHEALTHY verdict must reach the repair arm — detection that never
  // dispatches is the 0-byte-repair-log failure class.
  expect(r.stubLog).toContain('dispatch fleet-watchdog-')
  // ...and through the scope wrapper, so the repair session's tmux server is never owned by this unit (#2655).
  expect(r.stubLog).toMatch(/scope-wrapped\n(?:.*\n)*dispatch fleet-watchdog-/)
  expect(r.brief).not.toBeNull()
  expect(r.brief as string).toMatch(pattern)
}

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('llamenos-fleet-watchdog outcome checks (#1834)', () => {
  it('stays ok when every liveness AND outcome measurement is healthy', () => {
    const r = runWatchdog({ prs: [cleanArmed(2442)], mainDate: isoHoursAgo(1), queue: 1 })
    expectHealthy(r)
    // The GH repo was derived from the checkout's origin, not hardcoded input.
    expect(r.stubLog).toContain('-R Llamenos-Hotline/llamenos-platform')
  })

  it('merge drought fires: mergeable open PR present, last merge N+1h ago', () => {
    const r = runWatchdog({ prs: [cleanArmed(2442)], mainDate: isoHoursAgo(7.5) })
    // Names BOTH the measurement and the threshold, so the brief is actionable.
    expectUnhealthy(r, /merge drought: no merge to main in 7h \(threshold 6h\) while 1 open PR\(s\) are CLEAN\/MERGEABLE/)
    expect(r.brief).toContain('### Outcome evidence')
    expect(r.brief).toContain('merge queue entries: 0')
  })

  it('merge drought does NOT fire on a genuinely quiet repo', () => {
    // Same stale main, but nothing mergeable is open — a quiet repo is healthy,
    // and this is the check that stops the watchdog crying wolf at night.
    const r = runWatchdog({ prs: [blockedUnarmed(2439)], mainDate: isoHoursAgo(7.5) })
    expectHealthy(r)
  })

  it('mergeable-but-unqueued fires: 3 green un-armed PRs and an empty queue', () => {
    // Drafts and non-mergeable PRs in the same fixture prove they are NOT
    // counted: exactly 3 unqueued, not 5.
    const prs = [cleanUnarmed(1), cleanUnarmed(2), cleanUnarmed(3), draftUnarmed(4), blockedUnarmed(5)]
    const r = runWatchdog({ prs, mainDate: isoHoursAgo(1), queue: 0 })
    expectUnhealthy(r, /mergeable but unqueued: 3 open non-draft base-main PRs are CLEAN\/MERGEABLE .* no autoMergeRequest, and the merge queue is empty \(threshold >2\)/)
  })

  it('mergeable-but-unqueued does NOT fire while the merge queue is draining', () => {
    const prs = [cleanUnarmed(1), cleanUnarmed(2), cleanUnarmed(3)]
    const r = runWatchdog({ prs, mainDate: isoHoursAgo(1), queue: 2 })
    expectHealthy(r)
  })

  it('disk headroom fires below the warn band, naming free space and threshold', () => {
    const r = runWatchdog({ prs: [], mainDate: isoHoursAgo(1), sshAvailKib: TEN_GIB_KIB })
    expectUnhealthy(r, /iOS runner disk headroom: 10\.0 GiB free on \/System\/Volumes\/Data, below the 16 GiB warn band/)
  })

  it('an unreachable Mac is a FAIL, not a silent pass (stubbed ssh timeout)', () => {
    const r = runWatchdog({ prs: [], mainDate: isoHoursAgo(1), sshMode: 'fail' })
    expectUnhealthy(r, /iOS runner mac unreachable over ssh/)
  })

  it('an unroutable real ssh target fails loudly rather than returning 0', () => {
    // 192.0.2.1 is TEST-NET-1 — guaranteed unroutable. Real /usr/bin/ssh,
    // 3s connect timeout: the check must report the failure, never skip it.
    const r = runWatchdog({
      prs: [],
      mainDate: isoHoursAgo(1),
      sshMode: 'real',
      macHost: '192.0.2.1',
      sshConnectTimeout: '3',
    })
    expectUnhealthy(r, /iOS runner 192\.0\.2\.1 unreachable over ssh/)
  }, 45_000)

  it('a GitHub read failure is reported, never treated as "nothing wrong"', () => {
    const r = runWatchdog({ prs: [], mainDate: isoHoursAgo(1), ghFail: true })
    expectUnhealthy(r, /outcome checks: could not read GitHub state/)
  })

  it('the existing liveness checks still behave: tick timer stopped is caught', () => {
    const r = runWatchdog({ prs: [cleanArmed(2442)], mainDate: isoHoursAgo(1), queue: 1, timerActive: 'inactive' })
    expectUnhealthy(r, /tick timer not active/)
  })
})

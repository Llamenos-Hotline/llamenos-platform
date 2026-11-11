// scripts/ci/playwright-deps.sh (#2736) against a stub ldd and a stub install command.
//
// The property under test is the acceptance criterion of the issue: with the Ubuntu
// mirrors unreachable (the install command fails), a job whose chromium is cached and
// whose libraries resolve must still proceed — and must not even try the network.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'playwright-deps.sh')

let dir: string
let calls: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pw-deps-test-'))
  calls = join(dir, 'install-calls.log')
  // ldd: reports whatever STUB_LDD_MISSING lists (space separated) as "not found".
  writeFileSync(
    join(dir, 'ldd'),
    `#!/usr/bin/env bash
echo "	linux-vdso.so.1 (0x00007ffd)"
for l in $STUB_LDD_MISSING; do echo "	$l => not found"; done
echo "	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)"
`,
  )
  // The install command: STUB_INSTALL_FAIL_UNTIL=N fails the first N calls with the real
  // symptom (an unresolvable mirror); STUB_INSTALL_HANG makes it outlast the budget.
  writeFileSync(
    join(dir, 'install-deps'),
    `#!/usr/bin/env bash
echo run >> "$STUB_CALLS"
n=$(wc -l < "$STUB_CALLS")
[ -z "$STUB_INSTALL_HANG" ] || exec sleep 60
if [ "$n" -le "\${STUB_INSTALL_FAIL_UNTIL:-0}" ]; then
  echo "Err:2 https://security.ubuntu.com/ubuntu resolute InRelease"
  echo "  Temporary failure resolving 'security.ubuntu.com'"
  exit 100
fi
`,
  )
  chmodSync(join(dir, 'ldd'), 0o755)
  chmodSync(join(dir, 'install-deps'), 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function withBrowser(...names: string[]) {
  for (const n of names) {
    const d = join(dir, 'browsers', n)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, n.startsWith('chromium_headless_shell') ? 'headless_shell' : 'chrome'), '')
  }
}

function run(env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      PLAYWRIGHT_BROWSERS_PATH: join(dir, 'browsers'),
      PW_DEPS_INSTALL_CMD: join(dir, 'install-deps'),
      PW_DEPS_BACKOFF_SEC: '0',
      PW_DEPS_ATTEMPT_BUDGET_SEC: '5',
      STUB_CALLS: calls,
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      ...env,
    },
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    installs: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0,
  }
}

describe('playwright-deps.sh', () => {
  test('cached browser whose libraries resolve: succeeds without ever calling the install command', () => {
    withBrowser('chromium-1217', 'chromium_headless_shell-1217')
    // The mirrors being unreachable must be irrelevant: the install command would fail every time.
    const r = run({ STUB_INSTALL_FAIL_UNTIL: '99' })
    expect(r.code).toBe(0)
    expect(r.installs).toBe(0)
    expect(r.out).toContain('no network used')
  })

  test('a missing library triggers the install, which is retried through a transient failure', () => {
    withBrowser('chromium-1217')
    const r = run({ STUB_LDD_MISSING: 'libnss3.so', STUB_INSTALL_FAIL_UNTIL: '2' })
    expect(r.code).toBe(0)
    expect(r.installs).toBe(3)
    expect(r.out).toContain('missing shared libraries: libnss3.so')
  })

  test('a persistent mirror failure fails once, naming the mirror as the cause', () => {
    withBrowser('chromium-1217')
    const r = run({ STUB_LDD_MISSING: 'libnss3.so libatk-1.0.so.0', STUB_INSTALL_FAIL_UNTIL: '99' })
    expect(r.code).toBe(1)
    expect(r.installs).toBe(3)
    expect(r.out).toContain('::error title=Install Playwright OS deps — Ubuntu apt mirror unreachable')
    expect(r.out).toContain('not a test or build result')
    expect(r.out).toContain('libatk-1.0.so.0 libnss3.so')
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('mirror unreachable')
  })

  test('an install that outlasts its budget is cut off rather than sitting to the job timeout', () => {
    withBrowser('chromium-1217')
    const started = Date.now()
    const r = run({
      STUB_LDD_MISSING: 'libnss3.so',
      STUB_INSTALL_HANG: '1',
      PW_DEPS_ATTEMPTS: '1',
      PW_DEPS_ATTEMPT_BUDGET_SEC: '1',
    })
    expect(r.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(r.out).toContain('budget of 1s expired')
  })

  test('no cached browser to probe: falls through to the install rather than assuming it is satisfied', () => {
    const r = run()
    expect(r.code).toBe(0)
    expect(r.installs).toBe(1)
    expect(r.out).toContain('no cached chromium executable')
  })
})

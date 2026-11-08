// scripts/ci/apt-install-bounded.sh (#2545) against a stub apt-get.
//
// The real `timeout` is used, so every stall below is a genuine wall-clock
// budget expiring, not a simulated exit code. Budgets are shrunk to 2 s through
// the script's own env knobs; the stub apt-get sleeps far past them.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'apt-install-bounded.sh')
const PACKAGES = ['libwebkit2gtk-4.1-dev', 'libgtk-3-dev']

// Behaviour per phase is chosen by STUB_<PHASE>_<SOURCE>, where PHASE is
// UPDATE | DOWNLOAD | INSTALL and SOURCE is RUNNER (attempt 1) or ARCHIVE (the
// fallback, recognisable by its Dir::Etc::SourceParts override). Values:
// ok | hang | partial-hang (prints a sized download, then hangs) | missing.
const STUB_APT = `#!/usr/bin/env bash
echo "apt-get $*" >> "$STUB_CALLS"
src=RUNNER; case "$*" in *Dir::Etc::SourceParts=*) src=ARCHIVE ;; esac
phase=UPDATE
case "$*" in *--download-only*) phase=DOWNLOAD ;; *--no-download*) phase=INSTALL ;; esac
var="STUB_\${phase}_\${src}"; mode="\${!var:-ok}"
case "$phase:$mode" in
  UPDATE:ok) echo "Get:1 http://mirror.test/ubuntu resolute InRelease [137 kB]"; echo "Reading package lists..." ;;
  DOWNLOAD:ok) echo "Need to get 1000 kB of archives."; echo "Get:1 http://mirror.test/ubuntu resolute/main a [1000 kB]"; echo "Fetched 1000 kB in 0s" ;;
  DOWNLOAD:partial-hang)
    echo "Need to get 67.7 MB of archives."
    echo "Get:1 http://azure.mirror.test/ubuntu resolute/main amd64 bzip2-doc all 1.0 [498 kB]"
    echo "Get:2 http://azure.mirror.test/ubuntu resolute/main amd64 libjavascriptcoregtk-4.1-0 amd64 2.52 [8127 kB]"
    exec sleep 60 ;;
  DOWNLOAD:missing) echo "E: Unable to locate package libwebkit2gtk-9.9-dev"; exit 100 ;;
  INSTALL:ok) echo "Setting up libwebkit2gtk-4.1-dev ..." ;;
  *:hang) echo "0% [Waiting for headers]"; exec sleep 60 ;;
esac
`

let dir: string
let calls: string
let summary: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apt-bounded-test-'))
  calls = join(dir, 'calls.log')
  summary = join(dir, 'summary.md')
  writeFileSync(join(dir, 'apt-get'), STUB_APT)
  writeFileSync(join(dir, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n')
  writeFileSync(join(dir, 'keyring.gpg'), '')
  chmodSync(join(dir, 'apt-get'), 0o755)
  chmodSync(join(dir, 'sudo'), 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(stub: Record<string, string>, args: string[] = PACKAGES) {
  const started = Date.now()
  const r = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summary,
      STUB_CALLS: calls,
      APT_DOWNLOAD_BUDGET_SEC: '2',
      APT_INSTALL_BUDGET_SEC: '2',
      APT_FALLBACK_KEYRING: join(dir, 'keyring.gpg'),
      ...stub,
    },
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    seconds: (Date.now() - started) / 1000,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
  }
}

const errorLine = (out: string) => out.split('\n').find((l) => l.startsWith('::error')) ?? ''

describe('apt-install-bounded.sh', () => {
  test('healthy mirror: one attempt, installs offline, exit 0', () => {
    const r = run({})
    expect(r.code).toBe(0)
    expect(r.out).toContain('installed 2 requested package(s)')
    expect(r.out).not.toContain('::error')
    expect(r.out).not.toContain('::warning')
    expect(r.calls).not.toContain('SourceParts')
    // The install phase must never touch the network.
    expect(r.calls).toMatch(/install -y --no-download libwebkit2gtk-4\.1-dev libgtk-3-dev/)
  })

  test("a stalled runner mirror falls over to the canonical archive and says so", () => {
    const r = run({ STUB_UPDATE_RUNNER: 'hang' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('::warning title=Install Linux deps — the runner\'s apt mirror failed; installed from the canonical archive instead::')
    expect(r.out).toContain('STALLED — budget of 2s expired')
    // The install phase reads the lists the successful attempt fetched.
    const install = r.calls.split('\n').find((l) => l.includes('--no-download')) ?? ''
    expect(install).toContain('Dir::Etc::SourceParts=')
    expect(install).toContain('Dir::Etc::SourceList=/dev/null')
  })

  test('both sources stalled: bounded, exit 1, the cause is named as infrastructure', () => {
    const r = run({ STUB_UPDATE_RUNNER: 'hang', STUB_UPDATE_ARCHIVE: 'hang' })
    expect(r.code).toBe(1)
    // Two 2 s budgets; nowhere near the old 30-minute job ceiling.
    expect(r.seconds).toBeLessThan(15)
    const err = errorLine(r.out)
    expect(err).toContain('::error title=Install Linux deps — apt mirror stall (infrastructure, not a test or build result)::')
    expect(err).toContain('attempt 1, runner sources')
    expect(err).toContain('attempt 2, canonical archive')
    expect(err).toContain('stalled in apt-get update')
    expect(err).toContain('No test ran. Re-run the job unchanged')
    expect(r.calls).not.toContain('--no-download')
    expect(readFileSync(summary, 'utf8')).toContain('apt mirror stall — infrastructure, not a test or build result')
  })

  test('a stall mid-download reports how far it got and what was in flight', () => {
    const r = run({ STUB_DOWNLOAD_RUNNER: 'partial-hang', STUB_DOWNLOAD_ARCHIVE: 'partial-hang' })
    expect(r.code).toBe(1)
    const err = errorLine(r.out)
    expect(err).toContain('≈498.0 kB fetched of 67.7 MB in 2s')
    expect(err).toContain('in flight: http://azure.mirror.test/ubuntu resolute/main amd64 libjavascriptcoregtk-4.1-0')
  })

  test('an unresolvable package fails at once, without a second mirror, as a real defect', () => {
    const r = run({ STUB_DOWNLOAD_RUNNER: 'missing' })
    expect(r.code).toBe(1)
    const err = errorLine(r.out)
    expect(err).toContain('the package set does not resolve (a real defect in this step, not a mirror problem)')
    expect(err).toContain('E: Unable to locate package libwebkit2gtk-9.9-dev')
    expect(err).not.toContain('infrastructure, not a test')
    expect(r.calls).not.toContain('SourceParts')
  })

  test('a dpkg install that hangs is bounded and named', () => {
    const r = run({ STUB_INSTALL_RUNNER: 'hang' })
    expect(r.code).toBe(1)
    expect(r.seconds).toBeLessThan(10)
    expect(errorLine(r.out)).toContain('dpkg install exceeded its 2s budget')
  })

  test('no packages is a usage error, not a silent success', () => {
    const r = run({}, [])
    expect(r.code).toBe(2)
    expect(r.calls).toBe('')
  })
})

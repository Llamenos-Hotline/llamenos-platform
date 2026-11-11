// scripts/ci/apt-install-bounded.sh (#2545) against a stub apt-get.
//
// The real `timeout` is used, so every stall below is a genuine wall-clock
// budget expiring, not a simulated exit code. Budgets are shrunk to 2 s through
// the script's own env knobs; the stub apt-get sleeps far past them.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
# Real apt accepts --error-on only on \`update\`; \`install\` rejects it with exactly
# this error and exit 100 (measured on apt 2.4.14, 2.8.3 and 3.2.0).
if [ "$phase" != UPDATE ]; then case "$*" in *--error-on*)
  echo "E: Command line option --error-on=any is not understood in combination with the other options"; exit 100 ;;
esac; fi
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

// dpkg-query reports "installed" only when STUB_INSTALLED=all (or the package is
// listed in it); dpkg -i succeeds unless STUB_DPKG=fail, and on success marks the
// requested packages installed so the script's own re-check sees them.
const STUB_DPKG_QUERY = `#!/usr/bin/env bash
pkg="\${@: -1}"
case " \${STUB_INSTALLED:-} " in *" all "*|*" $pkg "*) echo installed ;; *) [ -f "$STUB_DPKG_DONE" ] && echo installed || exit 1 ;; esac
`
const STUB_DPKG = `#!/usr/bin/env bash
echo "dpkg $*" >> "$STUB_CALLS"
[ "\${STUB_DPKG:-ok}" = fail ] && { echo "dpkg: error processing archive"; exit 1; }
touch "$STUB_DPKG_DONE"
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
  writeFileSync(join(dir, 'dpkg-query'), STUB_DPKG_QUERY)
  writeFileSync(join(dir, 'dpkg'), STUB_DPKG)
  chmodSync(join(dir, 'dpkg-query'), 0o755)
  chmodSync(join(dir, 'dpkg'), 0o755)
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
      STUB_DPKG_DONE: join(dir, 'dpkg-done'),
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

// Parse an annotation exactly as the runner does: the title property ends at
// the first RAW comma or `::`, then %-escapes are decoded. A title with an
// unescaped comma is therefore truncated here just as it was on GitHub.
function annotation(out: string, level: 'error' | 'warning') {
  const line = out.split('\n').find((l) => l.startsWith(`::${level} `)) ?? ''
  const m = /^::\w+ title=([^,:]*)(?:[^:]*)::(.*)$/.exec(line)
  const decode = (v: string) => v.replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%')
  return { found: line !== '', title: m ? decode(m[1]) : '', message: m ? decode(m[2]) : '' }
}
const errorLine = (out: string) => {
  const a = annotation(out, 'error')
  return a.found ? `${a.title} :: ${a.message}` : ''
}

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
    const warn = annotation(r.out, 'warning')
    expect(warn.title).toBe("Install Linux deps — the runner's apt mirror failed; installed from the canonical archive instead")
    expect(warn.message).toContain('STALLED — budget of 2s expired')
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
    // The whole title survives GitHub's parser — the first CI run of this
    // script lost everything after "(infrastructure" to an unescaped comma.
    expect(annotation(r.out, 'error').title).toBe('Install Linux deps — apt mirror stall (infrastructure, not a test or build result)')
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
    expect(annotation(r.out, 'error').title).toBe('Install Linux deps — the package set does not resolve (a real defect in this step, not a mirror problem)')
    expect(err).toContain('E: Unable to locate package libwebkit2gtk-9.9-dev')
    expect(err).not.toContain('infrastructure, not a test')
    expect(r.calls).not.toContain('SourceParts')
  })

  test('a dpkg install that hangs is bounded and named', () => {
    const r = run({ STUB_INSTALL_RUNNER: 'hang' })
    expect(r.code).toBe(1)
    expect(r.seconds).toBeLessThan(10)
    expect(annotation(r.out, 'error').title).toBe('Install Linux deps — dpkg install exceeded its 2s budget (infrastructure, not a test or build result)')
  })

  // #2736: the mirrors being down must cost a cache miss, not a merge group.
  describe('without the network (#2736)', () => {
    const cacheDir = () => join(dir, 'deb-cache')
    const seedCache = () => {
      mkdirSync(cacheDir())
      writeFileSync(join(cacheDir(), 'libgtk-3-dev_1_amd64.deb'), 'x')
      writeFileSync(join(cacheDir(), 'patchelf_1_amd64.deb'), 'x')
    }

    test('every package already installed: exit 0 and apt is never invoked', () => {
      const r = run({ STUB_INSTALLED: 'all', STUB_UPDATE_RUNNER: 'hang' })
      expect(r.code).toBe(0)
      expect(r.out).toContain('already installed')
      expect(r.calls).toBe('')
    })

    test('a cache hit installs with dpkg and never calls apt, even when every mirror hangs', () => {
      seedCache()
      const r = run({ APT_DEB_CACHE_DIR: cacheDir(), STUB_UPDATE_RUNNER: 'hang', STUB_UPDATE_ARCHIVE: 'hang' })
      expect(r.code).toBe(0)
      expect(r.out).toContain('installed from the .deb cache; no network used')
      expect(r.calls).toMatch(/^dpkg --force-unsafe-io -i .*libgtk-3-dev_1_amd64\.deb .*patchelf_1_amd64\.deb$/m)
      expect(r.calls).not.toContain('apt-get')
      expect(r.seconds).toBeLessThan(5)
    })

    test('a cache dpkg rejects falls through to the network phase instead of failing', () => {
      seedCache()
      const r = run({ APT_DEB_CACHE_DIR: cacheDir(), STUB_DPKG: 'fail' })
      expect(r.code).toBe(0)
      expect(r.out).toContain('the .deb cache did not satisfy the request')
      expect(r.calls).toContain('install -y --no-download')
    })

    test('an empty cache dir is a plain miss: the network path runs', () => {
      mkdirSync(cacheDir())
      const r = run({ APT_DEB_CACHE_DIR: cacheDir() })
      expect(r.code).toBe(0)
      expect(r.calls).not.toContain('dpkg ')
      expect(r.calls).toContain('install -y --no-download')
    })

    test('a miss that downloads saves the .debs for the next run', () => {
      const archives = join(dir, 'archives')
      mkdirSync(archives)
      writeFileSync(join(archives, 'patchelf_1_amd64.deb'), 'x')
      const r = run({ APT_DEB_CACHE_DIR: cacheDir(), APT_ARCHIVES_DIR: archives })
      expect(r.code).toBe(0)
      expect(r.out).toContain('saved 1 .deb(s)')
      expect(existsSync(join(cacheDir(), 'patchelf_1_amd64.deb'))).toBe(true)
    })

    test('no cache dir configured: behaviour is unchanged', () => {
      const r = run({})
      expect(r.code).toBe(0)
      expect(r.out).not.toContain('.deb')
      expect(r.calls).not.toContain('dpkg ')
    })
  })

  test('no packages is a usage error, not a silent success', () => {
    const r = run({}, [])
    expect(r.code).toBe(2)
    expect(r.calls).toBe('')
  })
})

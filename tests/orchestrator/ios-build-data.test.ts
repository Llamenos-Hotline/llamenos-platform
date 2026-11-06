import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * scripts/lib/ios-build-data.sh decides where an out-of-CI iOS build on the
 * Mac writes DerivedData, and refuses — loudly, before xcodebuild — when the
 * external SSD it targets is not really mounted. The failure it exists to
 * prevent is silent: an unmounted drive whose mount-point directory still
 * exists turns every write into a write onto the internal disk the CI
 * runners' 12 GiB guard protects.
 *
 * The mount decision rests on two commands, `uname -s` and `df -P <path>`, so
 * these tests put shims for both first on PATH: `df` answers from a table of
 * path-prefix → (mount point, free KiB), longest prefix wins, which is how a
 * real mount table resolves a path. Everything else (mkdir, the write probe,
 * the per-checkout key) runs for real in a temp directory.
 */

const REPO = resolve(__dirname, '..', '..')
const LIB = join(REPO, 'scripts', 'lib', 'ios-build-data.sh')

let dir: string
let bin: string

const GIB = 1024 * 1024 // in KiB

function writeShims(table: Array<[prefix: string, mountPoint: string, freeKib: number]>, os = 'Darwin') {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${os}\n`)
  const rows = table.map(([p, m, k]) => `${p}|${m}|${k}`).join('\n')
  // The real `df -P` prints a header and one row whose 4th field is free
  // space and whose 6th onward is the mount point.
  writeFileSync(
    join(bin, 'df'),
    `#!/bin/sh
for last; do :; done
best=""; best_mp=""; best_k=""
while IFS='|' read -r prefix mp k; do
  [ -n "$prefix" ] || continue
  case "$last" in
    "$prefix"|"\${prefix%/}"/*)
      if [ \${#prefix} -gt \${#best} ]; then best="$prefix"; best_mp="$mp"; best_k="$k"; fi ;;
  esac
done <<'TABLE'
${rows}
TABLE
[ -n "$best" ] || exit 1
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 999999999 0 $best_k 0% $best_mp"
`,
  )
  chmodSync(join(bin, 'uname'), 0o755)
  chmodSync(join(bin, 'df'), 0o755)
}

function preflight(projectRoot: string, env: Record<string, string>) {
  const r = spawnSync(
    'bash',
    ['-c', 'source "$1"; ios_build_data_preflight "$2" && echo "DD=$IOS_DERIVED_DATA_PATH" && echo "RES=$IOS_RESULTS_DIR"', '_', LIB, projectRoot],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        ...env,
      },
    },
  )
  return { status: r.status, out: r.stdout, err: r.stderr }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ios-build-data-'))
  bin = join(dir, 'bin')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ios_build_data_preflight', () => {
  it('refuses when the build-data volume does not exist, and never falls back to the internal disk', () => {
    const volume = join(dir, 'Volumes', 'CIScratch')
    writeShims([['/', '/', 500 * GIB]])
    const r = preflight(join(dir, 'checkout'), { IOS_BUILD_DATA_VOLUME: volume })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain(`the build-data volume ${volume} is not mounted (no such directory)`)
    expect(r.err).toContain('NOT falling back to the internal disk')
    expect(r.out).not.toContain('DD=')
  })

  it('refuses a stand-in directory: the mount point exists but belongs to another filesystem', () => {
    const volume = join(dir, 'Volumes', 'CIScratch')
    mkdirSync(volume, { recursive: true })
    // The directory is there, but df resolves it to the root filesystem —
    // what /Volumes/CIScratch looks like when the drive is gone and something
    // recreated the directory.
    writeShims([['/', '/', 500 * GIB]])
    const r = preflight(join(dir, 'checkout'), { IOS_BUILD_DATA_VOLUME: volume })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain(`the build-data volume ${volume} is NOT mounted`)
    expect(r.err).toContain("belongs to the filesystem mounted at '/'")
    // Nothing was created on the wrong disk.
    expect(existsSync(join(volume, 'llamenos-ios-build'))).toBe(false)
  })

  it('accepts a mounted volume and puts DerivedData under a per-checkout key on it', () => {
    const volume = join(dir, 'Volumes', 'CIScratch')
    mkdirSync(volume, { recursive: true })
    writeShims([
      ['/', '/', 15 * GIB],
      [volume, volume, 1800 * GIB],
    ])
    const a = preflight(join(dir, 'llamenos-a'), { IOS_BUILD_DATA_VOLUME: volume })
    expect(a.err).toBe('')
    expect(a.status).toBe(0)
    const dd = /DD=(.*)/.exec(a.out)?.[1]
    expect(dd).toMatch(new RegExp(`^${volume}/llamenos-ios-build/DerivedData/llamenos-a-[0-9a-f]{12}$`))
    expect(a.out).toMatch(new RegExp(`RES=${volume}/llamenos-ios-build/results/llamenos-a-[0-9a-f]{12}`))
    expect(existsSync(join(volume, 'llamenos-ios-build', 'results'))).toBe(true)

    // Two checkouts that share a basename still get separate DerivedData:
    // concurrent xcodebuilds on one derivedDataPath lock each other out.
    const b = preflight(join(dir, 'other', 'llamenos-a'), { IOS_BUILD_DATA_VOLUME: volume })
    expect(b.status).toBe(0)
    const ddB = /DD=(.*)/.exec(b.out)?.[1]
    expect(ddB).toBeDefined()
    expect(ddB).not.toBe(dd)
  })

  it('measures free space on the filesystem the build writes, not on the root disk', () => {
    const volume = join(dir, 'Volumes', 'CIScratch')
    mkdirSync(volume, { recursive: true })
    // Plenty on '/', almost nothing on the volume: must refuse.
    writeShims([
      ['/', '/', 900 * GIB],
      [volume, volume, 5 * GIB],
    ])
    const r = preflight(join(dir, 'checkout'), { IOS_BUILD_DATA_VOLUME: volume })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain(`only 5.0 GiB free on '${volume}'`)
  })

  it('inside a GitHub Actions job defaults to RUNNER_TEMP, never the external drive the runner cannot read', () => {
    const runnerTemp = join(dir, 'runner-temp')
    mkdirSync(runnerTemp, { recursive: true })
    // The external volume does not exist at all; a CI job must not care.
    writeShims([['/', '/', 50 * GIB]])
    const r = preflight(join(dir, 'checkout'), {
      IOS_BUILD_DATA_VOLUME: join(dir, 'Volumes', 'CIScratch'),
      GITHUB_ACTIONS: 'true',
      RUNNER_TEMP: runnerTemp,
    })
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toContain(`DD=${runnerTemp}/llamenos-ios-build/DerivedData/checkout-`)
  })

  it('refuses a root under /Volumes that is not under the declared volume, whose mount it cannot check', () => {
    writeShims([['/', '/', 500 * GIB]])
    const r = preflight(join(dir, 'checkout'), { IOS_BUILD_DATA_ROOT: '/Volumes/SomethingElse/build' })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain("is under /Volumes but not under IOS_BUILD_DATA_VOLUME '/Volumes/CIScratch'")
  })

  it('refuses a relative root', () => {
    writeShims([['/', '/', 500 * GIB]])
    const r = preflight(join(dir, 'checkout'), { IOS_BUILD_DATA_ROOT: 'relative/build' })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('IOS_BUILD_DATA_ROOT must be absolute')
  })

  it('refuses on a host that is not macOS', () => {
    writeShims([['/', '/', 500 * GIB]], 'Linux')
    const r = preflight(join(dir, 'checkout'), {})
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('iOS builds run on macOS; this host is Linux')
  })
})

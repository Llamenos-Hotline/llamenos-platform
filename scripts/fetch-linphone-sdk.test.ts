/**
 * Rails for scripts/fetch-linphone-sdk.sh (#1770, plan Task 1 Step 4): the
 * checksums file is a gate, so each test injects the defect the gate claims to
 * catch and asserts it is refused — never that the configuration "looks right".
 *
 *   bun test scripts/fetch-linphone-sdk.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'fetch-linphone-sdk.sh')
const PINS = join(import.meta.dir, '..', 'apps', 'desktop', 'linphone-sdk-checksums.txt')
const tmp = mkdtempSync(join(tmpdir(), 'fetch-linphone-sdk-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A zip shaped like the upstream win64 SDK, optionally missing one file. */
function makeWin64Zip(name: string, omit?: string): { path: string; sha256: string } {
  const src = join(tmp, `src-${name}`)
  const files = [
    'linphone-sdk/win64/include/linphone/core.h',
    'linphone-sdk/win64/bin/liblinphone.dll',
    'linphone-sdk/win64/lib/liblinphone.lib',
  ].filter((f) => f !== omit)
  for (const f of files) {
    mkdirSync(join(src, f, '..'), { recursive: true })
    writeFileSync(join(src, f), `fixture ${f}\n`)
  }
  const path = join(tmp, `${name}.zip`)
  const zip = Bun.spawnSync(['zip', '-qr', path, 'linphone-sdk'], { cwd: src })
  if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`)
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

function run(target: string, pins: string, vendorRoot: string) {
  const checksums = join(tmp, `pins-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(checksums, pins)
  const r = Bun.spawnSync(['bash', SCRIPT, target], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LLAMENOS_LINPHONE_CHECKSUMS: checksums,
      LLAMENOS_LINPHONE_VENDOR_ROOT: vendorRoot,
    },
  })
  return { code: r.exitCode, stderr: r.stderr.toString(), stdout: r.stdout.toString() }
}

let good: { path: string; sha256: string }
let incomplete: { path: string; sha256: string }
beforeAll(() => {
  good = makeWin64Zip('good')
  incomplete = makeWin64Zip('incomplete', 'linphone-sdk/win64/bin/liblinphone.dll')
})

describe('fetch-linphone-sdk.sh gate', () => {
  test('a matching digest installs the SDK root and records the verified digest', () => {
    const vendor = join(tmp, 'v-good')
    const r = run('windows-x86_64', `windows-x86_64  file://${good.path}  ${good.sha256}\n`, vendor)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(existsSync(join(vendor, 'windows-x86_64', 'include', 'linphone', 'core.h'))).toBe(true)
    expect(readFileSync(join(vendor, 'windows-x86_64', '.sdk-sha256'), 'utf8').trim()).toBe(good.sha256)
  })

  test('a tampered digest is refused and the existing vendored tree is left untouched', () => {
    const vendor = join(tmp, 'v-tamper')
    mkdirSync(join(vendor, 'windows-x86_64'), { recursive: true })
    writeFileSync(join(vendor, 'windows-x86_64', 'sentinel'), 'previous install')
    const wrong = 'deadbeef'.repeat(8)
    const r = run('windows-x86_64', `windows-x86_64  file://${good.path}  ${wrong}\n`, vendor)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('CHECKSUM MISMATCH for windows-x86_64')
    expect(r.stderr).toContain(`actual:   ${good.sha256}`)
    expect(readFileSync(join(vendor, 'windows-x86_64', 'sentinel'), 'utf8')).toBe('previous install')
    expect(existsSync(join(vendor, 'windows-x86_64', 'include'))).toBe(false)
  })

  test('a verified artifact missing a required file is refused and not installed', () => {
    const vendor = join(tmp, 'v-incomplete')
    const r = run('windows-x86_64', `windows-x86_64  file://${incomplete.path}  ${incomplete.sha256}\n`, vendor)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('lacks linphone-sdk/win64/bin/liblinphone.dll')
    expect(existsSync(join(vendor, 'windows-x86_64'))).toBe(false)
  })

  test('no entry, duplicate entries, and malformed digests are usage errors', () => {
    const vendor = join(tmp, 'v-usage')
    const line = `windows-x86_64  file://${good.path}  ${good.sha256}`
    expect(run('windows-x86_64', '# only comments\n', vendor).code).toBe(2)
    // A commented-out pin is not a pin.
    expect(run('windows-x86_64', `# ${line}\n`, vendor).code).toBe(2)
    const dup = run('windows-x86_64', `${line}\n${line}\n`, vendor)
    expect(dup.code).toBe(2)
    expect(dup.stderr).toContain('more than one')
    expect(run('windows-x86_64', `windows-x86_64  file://${good.path}  ${good.sha256.toUpperCase()}\n`, vendor).code).toBe(2)
    expect(run('windows-x86_64', `windows-x86_64  file://${good.path}\n`, vendor).code).toBe(2)
    expect(existsSync(join(vendor, 'windows-x86_64'))).toBe(false)
  })

  test('linux-x86_64 is refused even with a pin line, naming the open decision', () => {
    const vendor = join(tmp, 'v-linux')
    const r = run('linux-x86_64', `linux-x86_64  file://${good.path}  ${good.sha256}\n`, vendor)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('#1770')
    expect(existsSync(join(vendor, 'linux-x86_64'))).toBe(false)
  })

  test('an unknown target is refused even with a pin line', () => {
    const vendor = join(tmp, 'v-unknown')
    const r = run('macos-universal', `macos-universal  file://${good.path}  ${good.sha256}\n`, vendor)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown target')
  })
})

describe('apps/desktop/linphone-sdk-checksums.txt', () => {
  const entries = readFileSync(PINS, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .map((l) => l.trim().split(/\s+/))

  test('every pin is a known target, over https, with a lowercase sha256', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e).toHaveLength(3)
      const [target, url, sha] = e
      expect(['macos-arm64', 'windows-x86_64']).toContain(target)
      expect(url.startsWith('https://download.linphone.org/releases/')).toBe(true)
      expect(sha).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(new Set(entries.map((e) => e[0])).size).toBe(entries.length)
  })

  test('every pin is the same release (one liblinphone dialect across desktop targets)', () => {
    const versions = new Set(entries.map((e) => /-(\d+\.\d+\.\d+)\.zip$/.exec(e[1])?.[1]))
    expect(versions).toEqual(new Set(['5.5.39']))
    expect(readFileSync(PINS, 'utf8')).toContain('# Version: 5.5.39')
  })
})

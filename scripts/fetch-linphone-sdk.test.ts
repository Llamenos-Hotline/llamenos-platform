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

function run(target: string, pins: string, vendorRoot: string, extra: string[] = []) {
  const checksums = join(tmp, `pins-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(checksums, pins)
  const r = Bun.spawnSync(['bash', SCRIPT, target, ...extra], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LLAMENOS_LINPHONE_CHECKSUMS: checksums,
      LLAMENOS_LINPHONE_VENDOR_ROOT: vendorRoot,
    },
  })
  return { code: r.exitCode, stderr: r.stderr.toString(), stdout: r.stdout.toString() }
}

/** A tarball shaped like scripts/build-linphone-sdk-linux.sh's output, optionally missing one file. */
function makeLinuxTarball(name: string, omit?: string): { path: string; sha256: string } {
  const src = join(tmp, `src-${name}`)
  const files = [
    'linphone-sdk/linux-x86_64/include/linphone/core.h',
    'linphone-sdk/linux-x86_64/lib/liblinphone.so',
    'linphone-sdk/linux-x86_64/lib/libmediastreamer2.so',
    'linphone-sdk/linux-x86_64/share/belr/grammars/sip_grammar.belr',
  ].filter((f) => f !== omit)
  for (const f of files) {
    mkdirSync(join(src, f, '..'), { recursive: true })
    writeFileSync(join(src, f), `fixture ${f}\n`)
  }
  const path = join(tmp, `${name}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', path, 'linphone-sdk'], { cwd: src })
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`)
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

let good: { path: string; sha256: string }
let incomplete: { path: string; sha256: string }
let linuxGood: { path: string; sha256: string }
let linuxNoGrammar: { path: string; sha256: string }
beforeAll(() => {
  good = makeWin64Zip('good')
  incomplete = makeWin64Zip('incomplete', 'linphone-sdk/win64/bin/liblinphone.dll')
  linuxGood = makeLinuxTarball('linux-good')
  linuxNoGrammar = makeLinuxTarball('linux-nogrammar', 'linphone-sdk/linux-x86_64/share/belr/grammars/sip_grammar.belr')
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

  test('linux-x86_64 installs our tarball layout through the same digest gate', () => {
    const vendor = join(tmp, 'v-linux')
    const r = run('linux-x86_64', `linux-x86_64  file://${linuxGood.path}  ${linuxGood.sha256}\n`, vendor)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(existsSync(join(vendor, 'linux-x86_64', 'share', 'belr', 'grammars', 'sip_grammar.belr'))).toBe(true)
    expect(readFileSync(join(vendor, 'linux-x86_64', '.sdk-sha256'), 'utf8').trim()).toBe(linuxGood.sha256)
  })

  test('linux-x86_64 without the belr grammars is refused (liblinphone aborts without them)', () => {
    const vendor = join(tmp, 'v-linux-nogrammar')
    const r = run('linux-x86_64', `linux-x86_64  file://${linuxNoGrammar.path}  ${linuxNoGrammar.sha256}\n`, vendor)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('lacks linphone-sdk/linux-x86_64/share/belr/grammars/sip_grammar.belr')
    expect(existsSync(join(vendor, 'linux-x86_64'))).toBe(false)
  })

  test('--local reads a local artifact but still refuses one that is not the pinned digest', () => {
    const vendor = join(tmp, 'v-local')
    const ok = run('linux-x86_64', `linux-x86_64  https://example.invalid/never-fetched.tar.gz  ${linuxGood.sha256}\n`, vendor, ['--local', linuxGood.path])
    expect(ok.stderr).toBe('')
    expect(ok.code).toBe(0)
    const bad = run('linux-x86_64', `linux-x86_64  https://example.invalid/never-fetched.tar.gz  ${'deadbeef'.repeat(8)}\n`, join(tmp, 'v-local-bad'), ['--local', linuxGood.path])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('CHECKSUM MISMATCH for linux-x86_64')
    expect(existsSync(join(tmp, 'v-local-bad', 'linux-x86_64'))).toBe(false)
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
      expect(['linux-x86_64', 'macos-arm64', 'windows-x86_64']).toContain(target)
      // Upstream's artifacts come from upstream; OUR Linux build comes only from
      // our own release origin — never a third-party host (#1770 operator decision).
      const origin = target === 'linux-x86_64'
        ? 'https://updates.llamenos-hotline.org/desktop/linphone-sdk/'
        : 'https://download.linphone.org/releases/'
      expect(url.startsWith(origin)).toBe(true)
      expect(sha).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(new Set(entries.map((e) => e[0])).size).toBe(entries.length)
    expect(entries.map((e) => e[0]).sort()).toEqual(['linux-x86_64', 'macos-arm64', 'windows-x86_64'])
  })

  test('every pin is the same release (one liblinphone dialect across desktop targets)', () => {
    const versions = new Set(entries.map((e) => /-(\d+\.\d+\.\d+)\.(zip|tar\.gz)$/.exec(e[1])?.[1]))
    expect(versions).toEqual(new Set(['5.5.39']))
    expect(readFileSync(PINS, 'utf8')).toContain('# Version: 5.5.39')
  })
})

describe('apps/desktop/linphone-sdk-linux-x86_64.Dockerfile (the linux-x86_64 pin is rebuilt from it)', () => {
  const dockerfile = readFileSync(join(import.meta.dir, '..', 'apps', 'desktop', 'linphone-sdk-linux-x86_64.Dockerfile'), 'utf8')

  test('every input it builds from is pinned, at the same version as the checksums file', () => {
    // Base image by digest, never by a mutable tag alone.
    expect(dockerfile).toMatch(/^ARG BASE=\S+@sha256:[0-9a-f]{64}$/m)
    // Source by tag AND commit; the build refuses a tag that has moved.
    expect([...dockerfile.matchAll(/^ARG LINPHONE_SDK_VERSION=(\S+)$/gm)].map((m) => m[1])).toEqual(['5.5.39', '5.5.39'])
    expect(dockerfile).toMatch(/^ARG LINPHONE_SDK_COMMIT=[0-9a-f]{40}$/m)
    // The archive by snapshot date.
    expect(dockerfile).toMatch(/^ARG UBUNTU_SNAPSHOT=\d{8}T\d{6}Z$/m)
  })

  test('both sound backends are required, not best-effort', () => {
    for (const lib of ['libasound', 'libpulse']) expect(dockerfile).toContain(`NEEDED.*${lib}\\.so`)
    for (const opt of ['ENABLE_ALSA', 'ENABLE_PULSEAUDIO']) expect(dockerfile).toContain(opt)
  })
})

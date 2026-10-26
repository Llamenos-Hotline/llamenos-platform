import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The base compose mounts ./secrets/ban-hash-key and ./secrets/messaging-hash-key
// into the app and refuses to start without either (BAN_HASH_KEY and
// MESSAGING_HASH_KEY are secret FILES, never env vars). Every documented local
// entry point that brings that compose up must therefore create BOTH development
// keys first — the requirement stays, the launchers supply it. A launcher that
// supplied one and forgot the other would boot into the config check's refusal;
// that is how a new key reached every consumer but one the last time (#2237).

const REPO = process.cwd()
const KEYS = ['ban-hash-key', 'messaging-hash-key'] as const
const scratch: string[] = []

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('bun run test:docker:up', () => {
  const script = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['test:docker:up']!

  function runUp(preexisting?: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'docker-up-test-'))
    scratch.push(root)
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'deploy', 'docker'), { recursive: true })
    cpSync(join(REPO, 'scripts/lib/server-hash-keys.sh'), join(root, 'scripts/lib/server-hash-keys.sh'))
    if (preexisting !== undefined) {
      mkdirSync(join(root, 'deploy/docker/secrets'), { recursive: true })
      for (const [name, value] of Object.entries(preexisting)) writeFileSync(join(root, 'deploy/docker/secrets', name), value)
    }
    // A stub docker that records whether every key existed when compose was invoked.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'docker.log')
    const stub = join(bin, 'docker')
    const present = KEYS.map((k) => `[ -s secrets/${k} ]`).join(' && ')
    writeFileSync(stub, `#!/usr/bin/env bash\n${present} && echo "keys-present argv=$*" >> "${log}" || echo "keys-missing argv=$*" >> "${log}"\n`)
    chmodSync(stub, 0o755)
    const r = spawnSync('sh', ['-c', script], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    const file = (name: string) => join(root, 'deploy/docker/secrets', name)
    return { r, file, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('creates both keys before compose is invoked, and never prints them', () => {
    const { r, file, log } = runUp()
    expect(r.status, r.stderr).toBe(0)
    expect(log).toMatch(/^keys-present argv=compose .* up /)
    const values = KEYS.map((k) => readFileSync(file(k), 'utf8').trim())
    for (const [i, key] of KEYS.entries()) {
      expect(values[i], key).toMatch(/^[0-9a-f]{64}$/)
      expect(r.stdout + r.stderr).not.toContain(values[i]!)
      // World-readable so the container uid can read the bind mount; the directory is 0700.
      expect(statSync(file(key)).mode & 0o777).toBe(0o444)
    }
    // Two keys, two values: each keys one hash and nothing else.
    expect(values[0]).not.toBe(values[1])
  })

  it('keeps existing keys, so the bans and threads a persistent database holds keep matching', () => {
    const { r, file } = runUp({ 'ban-hash-key': 'ban-already-here\n', 'messaging-hash-key': 'msg-already-here\n' })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(file('ban-hash-key'), 'utf8')).toBe('ban-already-here\n')
    expect(readFileSync(file('messaging-hash-key'), 'utf8')).toBe('msg-already-here\n')
  })

  it('fills in the messaging key when only the ban key was there (a checkout from before it existed)', () => {
    const { r, file } = runUp({ 'ban-hash-key': 'ban-already-here\n' })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(file('ban-hash-key'), 'utf8')).toBe('ban-already-here\n')
    expect(readFileSync(file('messaging-hash-key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('launchers that bring the base compose up', () => {
  // Order matters: the keys must exist before the first `docker compose ... up`.
  for (const file of ['scripts/ios-build.sh', 'scripts/test-integration-full.sh']) {
    it(`${file} creates both keys before compose up`, () => {
      const text = readFileSync(join(REPO, file), 'utf8')
      const ensure = text.indexOf('ensure_hash_key_files')
      const up = text.search(/\bup -d\b/)
      expect(ensure, `${file} never calls ensure_hash_key_files`).toBeGreaterThan(-1)
      expect(up, `${file} has no compose up`).toBeGreaterThan(-1)
      expect(ensure).toBeLessThan(up)
    })
  }
})

describe('every consumer of the ban key also supplies the messaging key', () => {
  // The helper creates both files, so a launcher that goes through it cannot
  // forget one. A launcher that does not (an openssl call of its own, a bare
  // `secrets/ban-hash-key` path) is exactly the miss this guards.
  const LAUNCHERS = [
    '.github/actions/bootstrap-backend/action.yml',
    'apps/ios/scripts/native-backend.sh',
    'deploy/docker/first-run.sh',
    'deploy/docker/tests/telephony/run-android-sip-e2e.sh',
    'deploy/docker/tests/telephony/run-call-e2e.sh',
    'deploy/docker/tests/telephony/run-inapp-ring-e2e.sh',
    'deploy/docker/tests/telephony/run-register-e2e.sh',
    'scripts/android-parallel-e2e.sh',
    'scripts/dev-bun.sh',
    'scripts/ios-build.sh',
    'scripts/test-integration-full.sh',
    'start-server.sh',
    'package.json',
  ]
  for (const file of LAUNCHERS) {
    it(`${file} goes through the shared helper`, () => {
      const text = readFileSync(join(REPO, file), 'utf8')
      expect(text, `${file} no longer references the helper`).toMatch(/server-hash-keys\.sh/)
      expect(text).toMatch(/ensure_hash_key_files|ensure_hash_key_file\b|export_hash_key_files|HASH_KEY_NAMES/)
      expect(text, `${file} still calls the removed single-key helper`).not.toContain('ensure_ban_hash_key_file')
    })
  }

  it('ci.yml creates both keys in each step that writes a compose .env', () => {
    const text = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')
    const sources = text.match(/source scripts\/lib\/server-hash-keys\.sh/g) ?? []
    expect(sources.length).toBe(2)
    expect(text).not.toContain('ensure_ban_hash_key_file')
    expect((text.match(/ensure_hash_key_files deploy\/docker\/secrets 0444/g) ?? []).length).toBe(2)
  })

  it('every compose file that declares the ban-hash-key secret declares the messaging-hash-key secret too', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /docker-compose.*\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : [],
      )
    const composes = walk(join(REPO, 'deploy/docker')).filter((f) => /^\s+ban-hash-key:\s*$/m.test(readFileSync(f, 'utf8')))
    expect(composes.length).toBeGreaterThanOrEqual(2) // the base compose and the carrier overlay
    for (const f of composes) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/^\s+messaging-hash-key:\s*$/m)
    }
  })
})

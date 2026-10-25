import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The base compose mounts ./secrets/ban-hash-key into the app and refuses to
// start without it (BAN_HASH_KEY is a secret FILE, never an env var). Every
// documented local entry point that brings that compose up must therefore create
// a development key first — the requirement stays, the launchers supply it.

const REPO = process.cwd()
const scratch: string[] = []

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('bun run test:docker:up', () => {
  const script = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['test:docker:up']!

  function runUp(preexisting?: string) {
    const root = mkdtempSync(join(tmpdir(), 'docker-up-test-'))
    scratch.push(root)
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'deploy', 'docker'), { recursive: true })
    cpSync(join(REPO, 'scripts/lib/ban-hash-key.sh'), join(root, 'scripts/lib/ban-hash-key.sh'))
    const keyFile = join(root, 'deploy/docker/secrets/ban-hash-key')
    if (preexisting !== undefined) {
      mkdirSync(join(root, 'deploy/docker/secrets'), { recursive: true })
      writeFileSync(keyFile, preexisting)
    }
    // A stub docker that records whether the key existed when compose was invoked.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'docker.log')
    const stub = join(bin, 'docker')
    writeFileSync(stub, `#!/usr/bin/env bash\n[ -s secrets/ban-hash-key ] && echo "key-present argv=$*" >> "${log}" || echo "key-missing argv=$*" >> "${log}"\n`)
    chmodSync(stub, 0o755)
    const r = spawnSync('sh', ['-c', script], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    return { r, keyFile, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  it('creates the key before compose is invoked, and never prints it', () => {
    const { r, keyFile, log } = runUp()
    expect(r.status, r.stderr).toBe(0)
    expect(log).toMatch(/^key-present argv=compose .* up /)
    const key = readFileSync(keyFile, 'utf8').trim()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(r.stdout + r.stderr).not.toContain(key)
    // World-readable so the container uid can read the bind mount; the directory is 0700.
    expect(statSync(keyFile).mode & 0o777).toBe(0o444)
  })

  it('keeps an existing key, so the bans a persistent database holds keep matching', () => {
    const { r, keyFile } = runUp('already-here\n')
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(keyFile, 'utf8')).toBe('already-here\n')
  })
})

describe('launchers that bring the base compose up', () => {
  // Order matters: the key must exist before the first `docker compose ... up`.
  for (const file of ['scripts/ios-build.sh', 'scripts/test-integration-full.sh']) {
    it(`${file} creates the key before compose up`, () => {
      const text = readFileSync(join(REPO, file), 'utf8')
      const ensure = text.indexOf('ensure_ban_hash_key_file')
      const up = text.search(/\bup -d\b/)
      expect(ensure, `${file} never calls ensure_ban_hash_key_file`).toBeGreaterThan(-1)
      expect(up, `${file} has no compose up`).toBeGreaterThan(-1)
      expect(ensure).toBeLessThan(up)
      expect(text).toContain('secrets/ban-hash-key')
    })
  }
})

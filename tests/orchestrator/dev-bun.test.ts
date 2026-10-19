import { describe, it, expect, afterAll } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// scripts/dev-bun.sh drives ONE shared dev stack (deploy/docker/docker-compose.dev.yml:
// fixed host ports 5432/9000, `name: llamenos-dev`) with a database per worktree
// inside it. A shared root .env that sets COMPOSE_PROJECT_NAME (left over from a
// worktree: `pt1453`) used to be inherited, so every worker running the script
// silently created or joined a compose project named after someone else's
// worktree. These tests run the REAL script from two scratch "worktrees" with a
// stub `docker` that records exactly how compose was addressed.

const REPO = process.cwd()
const COMPOSE_FILE = 'deploy/docker/docker-compose.dev.yml'
const scratch: string[] = []

function makeWorktree(envFile: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-bun-test-'))
  scratch.push(root)
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  cpSync(join(REPO, 'scripts/dev-bun.sh'), join(root, 'scripts/dev-bun.sh'))
  cpSync(join(REPO, 'scripts/lib/worktree-db.sh'), join(root, 'scripts/lib/worktree-db.sh'))
  if (envFile !== null) writeFileSync(join(root, '.env'), envFile)
  return root
}

/** Run `dev-bun.sh <action>` against a stub docker; returns what compose was told. */
function run(root: string, action: 'stop' | 'logs', env: Record<string, string> = {}) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(root, 'docker.log')
  const stub = join(bin, 'docker')
  // Record the project name docker would resolve from its environment, then argv.
  writeFileSync(stub, `#!/usr/bin/env bash\necho "env=\${COMPOSE_PROJECT_NAME:-} argv=$*" >> "${log}"\n`)
  chmodSync(stub, 0o755)
  const { COMPOSE_PROJECT_NAME: _ambient, ...cleanEnv } = process.env
  const r = spawnSync('bash', [join(root, 'scripts/dev-bun.sh'), action], {
    cwd: root,
    env: { ...cleanEnv, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    encoding: 'utf8',
  })
  expect(r.status, r.stderr).toBe(0)
  return readFileSync(log, 'utf8').trim().split('\n')
}

/** The project docker compose would use: `-p` beats COMPOSE_PROJECT_NAME beats the file's `name:`. */
function resolvedProject(line: string): string | null {
  const p = /(?:^|\s)-p\s+(\S+)/.exec(line)
  if (p) return p[1] ?? null
  const e = /^env=(\S*)/.exec(line)
  return e && e[1] ? e[1] : null
}

const composeName = /^name:\s*(\S+)/m.exec(readFileSync(join(REPO, COMPOSE_FILE), 'utf8'))?.[1]

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('dev-bun.sh compose project name', () => {
  it('the dev compose file declares the project name the script must match', () => {
    expect(composeName).toBe('llamenos-dev')
  })

  it('does not adopt COMPOSE_PROJECT_NAME from a shared .env', () => {
    const root = makeWorktree('COMPOSE_PROJECT_NAME=pt1453\n')
    const lines = run(root, 'stop')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(resolvedProject(l)).toBe(composeName)
    expect(lines.join('\n')).not.toContain('pt1453')
  })

  it('does not adopt COMPOSE_PROJECT_NAME from the calling environment', () => {
    const root = makeWorktree(null)
    const lines = run(root, 'logs', { COMPOSE_PROJECT_NAME: 'someone-elses-worktree' })
    for (const l of lines) expect(resolvedProject(l)).toBe(composeName)
    expect(lines.join('\n')).not.toContain('someone-elses-worktree')
  })

  it('two worktrees with different inherited names land on the same single stack', () => {
    const a = makeWorktree('COMPOSE_PROJECT_NAME=pt1453\n')
    const b = makeWorktree('COMPOSE_PROJECT_NAME=pt9999\n')
    const projects = new Set([
      ...run(a, 'stop', { COMPOSE_PROJECT_NAME: 'pt1111' }).map(resolvedProject),
      ...run(b, 'stop', { COMPOSE_PROJECT_NAME: 'pt2222' }).map(resolvedProject),
    ])
    // One stack, not one per worktree: the fixed host ports 5432/9000 make a
    // second project a port collision, and the per-worktree databases live in
    // this one Postgres.
    expect([...projects]).toEqual([composeName])
  })
})

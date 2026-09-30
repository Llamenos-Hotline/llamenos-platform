/**
 * Rails for scripts/worktree-db.ts — the naming scheme and every condition the
 * sweep must satisfy before it may drop a database. The sweep runs on every
 * `worktree-setup.sh` with --drop, so a regression here destroys someone's
 * database: each safety condition has a test that fails if it is removed.
 *
 *   bun test scripts/worktree-db.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyForSweep,
  deriveDatabaseName,
  isProtected,
  parseWorktreeProvenance,
  schemaHash,
  type PathState,
  type Registration,
  type SweepProbes,
  type WorktreeProvenance,
} from './worktree-db'

const PG_IDENTIFIER_MAX_BYTES = 63

describe('deriveDatabaseName', () => {
  test('is a stable, lowercase, prefixed identifier', () => {
    const name = deriveDatabaseName('/work/llamenos-Fix-1234.Thing')
    expect(name).toBe(deriveDatabaseName('/work/llamenos-Fix-1234.Thing'))
    expect(name).toMatch(/^llamenos_wt_fix_1234_thing_[0-9a-f]{10}$/)
  })

  test('paths that sanitise to the same string still get distinct names', () => {
    const names = [
      '/a/llamenos-foo',
      '/a/llamenos_foo',
      '/a/llamenos.foo',
      '/a/LLAMENOS-FOO',
      '/b/llamenos-foo',
      '/a/llamenos-foo/../llamenos-foo2',
    ].map(deriveDatabaseName)
    expect(new Set(names).size).toBe(names.length)
  })

  test('long directory names are cut to fit 63 bytes without losing uniqueness', () => {
    const long = 'llamenos-' + 'x'.repeat(200)
    const a = deriveDatabaseName(`/one/${long}`)
    const b = deriveDatabaseName(`/two/${long}`)
    const c = deriveDatabaseName(`/one/${long}y`)
    for (const n of [a, b, c]) {
      expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(PG_IDENTIFIER_MAX_BYTES)
      expect(n).toMatch(/^[a-z0-9_]+$/)
    }
    expect(new Set([a, b, c]).size).toBe(3)
  })

  test('non-ASCII and empty directory names still yield a valid identifier', () => {
    for (const p of ['/x/llámenos-ñandú', '/x/---', '/x/llamenos', '/']) {
      const n = deriveDatabaseName(p)
      expect(n).toMatch(/^llamenos_wt_[a-z0-9_]*[a-z0-9]_[0-9a-f]{10}$/)
      expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(PG_IDENTIFIER_MAX_BYTES)
    }
  })

  test('can never produce a protected name', () => {
    for (const p of ['/llamenos', '/x/tpl_abc', '/x/template0', '/postgres']) {
      expect(isProtected(deriveDatabaseName(p))).toBe(false)
    }
  })
})

describe('schemaHash', () => {
  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'wtdb-hash-'))
    mkdirSync(join(root, 'drizzle', 'migrations', 'meta'), { recursive: true })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'run-migrations.ts'), files['runner'] ?? 'runner v1')
    for (const [name, sql] of Object.entries(files)) {
      if (name !== 'runner') writeFileSync(join(root, 'drizzle', 'migrations', name), sql)
    }
    writeFileSync(join(root, 'drizzle', 'migrations', 'meta', '_journal.json'), '{}')
    return root
  }

  test('changes when a migration is edited, added or renamed, or the runner changes', () => {
    const base = schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();' }))
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();' }))).toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE b();' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();', '0001_b.sql': '' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_b.sql': 'CREATE TABLE a();' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();', runner: 'runner v2' }))).not.toBe(base)
  })
})

describe('classifyForSweep', () => {
  const WT = '/work/llamenos-gone'
  const NAME = deriveDatabaseName(WT)
  const NOW = new Date('2026-09-28T12:00:00Z')
  const DAY = 24 * 3_600_000

  function provenance(overrides: Partial<WorktreeProvenance> = {}): string {
    const p: WorktreeProvenance = {
      tool: 'llamenos-worktree-db',
      v: 1,
      kind: 'worktree',
      worktree: WT,
      commonDir: '/work/llamenos/.git',
      schemaHash: '0123456789abcdef',
      createdAt: '2026-09-01T00:00:00Z',
      orphanSince: null,
      ...overrides,
    }
    return JSON.stringify(p)
  }

  /** A world where the worktree is gone, its parent is mounted, and git has forgotten it. */
  function probes(
    paths: Record<string, PathState> = {},
    registration: Registration = 'unlisted',
  ): SweepProbes {
    return {
      pathState: (p) => paths[p] ?? (p === WT ? 'absent' : 'present'),
      registration: () => registration,
    }
  }

  const classify = (
    over: { name?: string; comment?: string | null; sessions?: number } = {},
    p: SweepProbes = probes(),
    graceMs = DAY,
  ) =>
    classifyForSweep(
      { name: over.name ?? NAME, comment: over.comment === undefined ? provenance() : over.comment, sessions: over.sessions ?? 0 },
      p,
      NOW,
      graceMs,
    )

  test('drops a database whose worktree is provably gone, once the grace period has passed', () => {
    const past = new Date(NOW.getTime() - DAY - 1).toISOString()
    expect(classify({ comment: provenance({ orphanSince: past }) }).action).toBe('drop')
  })

  test('first sighting only records the time; within grace it waits', () => {
    expect(classify().action).toBe('mark')
    const recent = new Date(NOW.getTime() - 60_000).toISOString()
    expect(classify({ comment: provenance({ orphanSince: recent }) }).action).toBe('wait')
  })

  test('grace 0 drops on first sighting', () => {
    expect(classify({}, probes(), 0).action).toBe('drop')
  })

  test('refuses protected databases even with a forged provenance record whose worktree is gone', () => {
    for (const name of ['llamenos', 'postgres', 'template0', 'template1', 'llamenos_tpl_3c4fbe5b4e7c65de', 'llamenos_tplbuild_3c4fbe5b4e7c65de']) {
      expect(classify({ name }, probes(), 0).action).toBe('refuse')
    }
  })

  test('ignores databases without the prefix, e.g. hand-made llamenos_<worker> ones', () => {
    for (const name of ['llamenos_1013', 'llamenos_fix1050', 'scratch']) {
      expect(classify({ name }, probes(), 0).action).toBe('ignore')
    }
  })

  test('skips a prefixed database without a valid provenance record', () => {
    for (const comment of [null, '', 'hand made', '{}', provenance().replace('"worktree"', '"other"'), JSON.stringify({ ...JSON.parse(provenance()), tool: 'x' })]) {
      expect(classify({ comment }, probes(), 0).action).toBe('skip')
    }
  })

  test('skips when the recorded worktree does not derive this name (copied or edited comment)', () => {
    expect(classify({ comment: provenance({ worktree: '/work/llamenos-other' }) }, probes(), 0).action).toBe('skip')
    expect(classify({ name: deriveDatabaseName('/work/llamenos-other') }, probes(), 0).action).toBe('skip')
  })

  test('keeps a database whose worktree directory exists, whatever git says', () => {
    expect(classify({}, probes({ [WT]: 'present' }, 'unlisted'), 0).action).toBe('keep')
  })

  test('a worktree that came back clears its orphan mark', () => {
    const past = new Date(NOW.getTime() - 10 * DAY).toISOString()
    expect(classify({ comment: provenance({ orphanSince: past }) }, probes({ [WT]: 'present' }), 0).action).toBe('unmark')
  })

  test('skips when the worktree path cannot be stat-ed', () => {
    expect(classify({}, probes({ [WT]: 'unknown' }), 0).action).toBe('skip')
  })

  test('skips when the parent directory is missing too (unmounted volume)', () => {
    expect(classify({}, probes({ '/work': 'absent' }), 0).action).toBe('skip')
    expect(classify({}, probes({ '/work': 'unknown' }), 0).action).toBe('skip')
  })

  test('keeps a worktree git still lists, even though its directory is gone', () => {
    expect(classify({}, probes({}, 'listed'), 0).action).toBe('keep')
  })

  test('skips when git cannot be asked', () => {
    expect(classify({}, probes({}, 'unknown'), 0).action).toBe('skip')
  })

  test('skips while anything is connected', () => {
    expect(classify({ sessions: 1 }, probes(), 0).action).toBe('skip')
  })
})

describe('parseWorktreeProvenance', () => {
  test('rejects relative paths and malformed orphan marks', () => {
    const good = {
      tool: 'llamenos-worktree-db',
      v: 1,
      kind: 'worktree',
      worktree: '/a/b',
      commonDir: '/a/.git',
      schemaHash: 'h',
      createdAt: 'now',
      orphanSince: null,
    }
    expect(parseWorktreeProvenance(JSON.stringify(good))).not.toBeNull()
    expect(parseWorktreeProvenance(JSON.stringify({ ...good, worktree: 'a/b' }))).toBeNull()
    expect(parseWorktreeProvenance(JSON.stringify({ ...good, commonDir: '.git' }))).toBeNull()
    expect(parseWorktreeProvenance(JSON.stringify({ ...good, orphanSince: 'yesterday' }))).toBeNull()
    expect(parseWorktreeProvenance(JSON.stringify({ ...good, kind: 'template' }))).toBeNull()
  })
})

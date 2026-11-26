// @suite: repo
/**
 * Rails for scripts/worktree-db.ts — the naming scheme and every condition the
 * sweep must satisfy before it may drop a database. The sweep runs on every
 * `worktree-setup.sh` with --drop, so a regression here destroys someone's
 * database: each safety condition has a test that fails if it is removed.
 *
 *   bun test scripts/worktree-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  OWNER_ROLE,
  OWNER_SECRET_FILE,
  checkSharedAccess,
  classifyForSweep,
  ownerSecretPath,
  sharedDatabaseRole,
  decideMode,
  isSharedDatabaseUrl,
  worktreePolicy,
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
    mkdirSync(join(root, 'scripts', 'lib'))
    writeFileSync(
      join(root, 'scripts', 'lib', 'migration-statements.ts'),
      files['splitter'] ?? 'splitter v1',
    )
    for (const [name, sql] of Object.entries(files)) {
      if (name !== 'runner' && name !== 'splitter') writeFileSync(join(root, 'drizzle', 'migrations', name), sql)
    }
    writeFileSync(join(root, 'drizzle', 'migrations', 'meta', '0000_snapshot.json'), '{}')
    return root
  }

  test('changes when a migration is edited, added or renamed, or the runner or its splitter changes', () => {
    const base = schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();' }))
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();' }))).toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE b();' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();', '0001_b.sql': '' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_b.sql': 'CREATE TABLE a();' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();', runner: 'runner v2' }))).not.toBe(base)
    expect(schemaHash(repo({ '0000_a.sql': 'CREATE TABLE a();', splitter: 'splitter v2' }))).not.toBe(base)
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

// ── Who may use the shared database (#2659) ─────────────────────────────────

const SHARED_URL = 'postgresql://llamenos:s3cret@localhost:5432/llamenos'
const FLEET = worktreePolicy({ linked: true, branch: 'fleet/infra/2659', dirName: 'llamenos-fleet-infra-2659' })
const LINKED = worktreePolicy({ linked: true, branch: 'feature/x', dirName: 'llamenos-x' })
const PRIMARY = worktreePolicy({ linked: false, branch: 'main', dirName: 'llamenos' })

describe('worktreePolicy', () => {
  test('a fleet worktree is recognised by its branch OR its directory, and only when linked', () => {
    expect(FLEET).toEqual({ linked: true, fleet: true })
    expect(worktreePolicy({ linked: true, branch: 'fleet/backend/1', dirName: 'whatever' }).fleet).toBe(true)
    expect(worktreePolicy({ linked: true, branch: 'feature/x', dirName: 'llamenos-fleet-infra-9' }).fleet).toBe(true)
    expect(worktreePolicy({ linked: true, branch: null, dirName: 'llamenos-fleet-infra-9' }).fleet).toBe(true)
    expect(LINKED.fleet).toBe(false)
    // The operator's primary checkout can be on a fleet-looking branch without becoming a worker.
    expect(worktreePolicy({ linked: false, branch: 'fleet/infra/1', dirName: 'llamenos' }).fleet).toBe(false)
  })
})

describe('decideMode', () => {
  test('a fleet worktree is isolated whatever its marker says', () => {
    expect(decideMode(null, FLEET)).toEqual({ mode: 'isolated', source: 'policy' })
    expect(decideMode('shared', FLEET)).toEqual({ mode: 'isolated', source: 'policy' })
    expect(decideMode('isolated', FLEET)).toEqual({ mode: 'isolated', source: 'marker' })
  })

  test('a linked worktree is isolated unless it recorded a choice', () => {
    expect(decideMode(null, LINKED)).toEqual({ mode: 'isolated', source: 'default' })
    expect(decideMode('shared', LINKED)).toEqual({ mode: 'shared', source: 'marker' })
    expect(decideMode('isolated', LINKED)).toEqual({ mode: 'isolated', source: 'marker' })
  })

  test('the primary checkout is never switched silently', () => {
    expect(decideMode(null, PRIMARY)).toEqual({ mode: 'unset', source: 'none' })
    expect(decideMode('shared', PRIMARY)).toEqual({ mode: 'shared', source: 'marker' })
  })
})

describe('isSharedDatabaseUrl', () => {
  test('recognises the shared dev database however it is spelled', () => {
    for (const u of [
      SHARED_URL,
      'postgres://llamenos:dev@127.0.0.1/llamenos',
      'postgresql://llamenos:dev@[::1]:5432/llamenos?sslmode=disable',
      'postgres://llamenos:dev@LOCALHOST:5432/llamenos',
      'postgres://llamenos:dev@localhost:5432/postgres',
      'postgres://llamenos:dev@localhost:5432/llamenos_tpl_0123456789abcdef',
    ]) {
      expect(isSharedDatabaseUrl(u)).toBe(true)
    }
  })

  test('a worktree database, a CI-style other host, a tunnelled deployment and junk are not it', () => {
    for (const u of [
      'postgresql://llamenos:dev@localhost:5432/llamenos_wt_x_0123456789',
      'postgresql://llamenos:dev@localhost:5432/llamenos_test',
      'postgresql://llamenos:dev@postgres:5432/llamenos',
      'postgresql://llamenos:dev@localhost:5433/llamenos',
      'not a url',
      '',
    ]) {
      expect(isSharedDatabaseUrl(u)).toBe(false)
    }
  })
})

describe('checkSharedAccess', () => {
  test('a fleet worker is refused the shared database, and no environment variable lifts it', () => {
    expect(checkSharedAccess(SHARED_URL, FLEET, undefined).ok).toBe(false)
    expect(checkSharedAccess(SHARED_URL, FLEET, '1').ok).toBe(false)
  })

  test('a linked worktree needs LLAMENOS_ALLOW_SHARED_DB=1, exactly', () => {
    expect(checkSharedAccess(SHARED_URL, LINKED, undefined).ok).toBe(false)
    expect(checkSharedAccess(SHARED_URL, LINKED, 'true').ok).toBe(false)
    expect(checkSharedAccess(SHARED_URL, LINKED, '1').ok).toBe(true)
  })

  test('the primary checkout and any non-shared database are untouched', () => {
    expect(checkSharedAccess(SHARED_URL, PRIMARY, undefined).ok).toBe(true)
    expect(checkSharedAccess('postgresql://u:p@localhost:5432/llamenos_wt_a_0123456789', FLEET, undefined).ok).toBe(true)
    expect(checkSharedAccess('postgresql://u:p@db.internal:5432/llamenos', FLEET, undefined).ok).toBe(true)
  })

  // #2705: a URL that is ALLOWED onto the shared database is still read-only there
  // unless it authenticates as the owner — and the caller hears so up front.
  test('an allowed URL to the shared database says it is read-only unless it is the owner role', () => {
    const primary = checkSharedAccess(SHARED_URL, PRIMARY, undefined)
    expect(primary.ok && primary.note).toContain('READ-ONLY')
    expect(primary.ok && primary.note).toContain(OWNER_ROLE)
    const linked = checkSharedAccess(SHARED_URL, LINKED, '1')
    expect(linked.ok && linked.note).toContain('READ-ONLY')
    const owner = checkSharedAccess(`postgresql://${OWNER_ROLE}:s3cret@localhost:5432/llamenos`, PRIMARY, undefined)
    expect(owner).toEqual({ ok: true })
    expect(checkSharedAccess('postgresql://u:p@localhost:5432/llamenos_wt_a_0123456789', LINKED, undefined)).toEqual({ ok: true })
    for (const v of [primary, linked]) expect(v.ok && v.note).not.toContain('s3cret')
  })

  test('the refusal never repeats the connection string or its password', () => {
    for (const policy of [FLEET, LINKED]) {
      const v = checkSharedAccess(SHARED_URL, policy, undefined)
      expect(v.ok).toBe(false)
      if (!v.ok) {
        expect(v.reason).not.toContain('s3cret')
        expect(v.reason).not.toContain('postgresql://')
      }
    }
  })
})

// #2705: which role the resolver hands out for the shared database.
describe('sharedDatabaseRole', () => {
  test('only the primary checkout, and only once it holds the owner secret, gets the owner role', () => {
    expect(sharedDatabaseRole(PRIMARY, true)).toBe(OWNER_ROLE)
    expect(sharedDatabaseRole(PRIMARY, false)).toBe('llamenos')
    // A linked worktree sees the same common dir, so the file is "present" for it too.
    for (const policy of [LINKED, FLEET]) {
      expect(sharedDatabaseRole(policy, true)).toBe('llamenos')
      expect(sharedDatabaseRole(policy, false)).toBe('llamenos')
    }
  })

  test('the owner secret lives in the git common dir — never .env, which every worktree symlinks', () => {
    expect(ownerSecretPath('/repo/.git')).toBe(`/repo/.git/${OWNER_SECRET_FILE}`)
    expect(OWNER_SECRET_FILE).not.toContain('.env')
  })
})

// The part that matters: a REAL worktree, run through the REAL scripts. The pure
// tests above prove the table; this proves nothing between a worker's shell and the
// shared database bypasses it — the dev server's resolver, the migrate wrapper, an
// explicit DATABASE_URL, --shared, and use-shared. Postgres is deliberately absent:
// every path asserted here must refuse or resolve BEFORE it connects.
describe('a worker-shaped process cannot reach the shared database', () => {
  const REPO = realpathSync(join(import.meta.dir, '..'))
  const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'wtdb-guard-')))

  function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
    // The real environment, minus anything that would steer these scripts: `bun` here may be a
    // version-manager shim that hangs without its own HOME, so the environment is filtered, not rebuilt.
    const base: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
    for (const k of ['DATABASE_URL', 'PG_PASSWORD', 'LLAMENOS_ALLOW_SHARED_DB']) delete base[k]
    const r = Bun.spawnSync(cmd, { cwd, env: { ...base, ...env } })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }
  function git(cwd: string, ...args: string[]) {
    const r = sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], cwd)
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`)
  }

  /** The primary checkout of a throwaway repo carrying the real scripts, plus linked worktrees on demand. */
  const primary = join(SCRATCH, 'llamenos')
  function install(root: string) {
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    for (const f of ['worktree-db.ts', 'lib/worktree-db.sh']) copyFileSync(join(REPO, 'scripts', f), join(root, 'scripts', f))
  }
  mkdirSync(primary)
  git(primary, 'init', '-q', '-b', 'main')
  install(primary)
  git(primary, 'add', '-A')
  git(primary, 'commit', '-q', '-m', 'seed')

  function worktree(dir: string, branch: string): string {
    const path = join(SCRATCH, dir)
    git(primary, 'worktree', 'add', '-q', '-b', branch, path)
    return path
  }
  const fleet = worktree('llamenos-fleet-infra-1', 'fleet/infra/1')
  const fleetByDirOnly = worktree('llamenos-fleet-backend-2', 'topic/anything')
  const linked = worktree('llamenos-topic', 'topic/b')

  // `bash -c`, never zsh: the lib is sourced from bash by its real callers.
  const exportWith = (cwd: string, args: string, env: Record<string, string> = {}) =>
    sh(['bash', '-c', `source scripts/lib/worktree-db.sh && worktree_db_export ${args} && echo "EXPORTED=$DATABASE_URL"`], cwd, env)

  const SHARED = { DATABASE_URL: SHARED_URL }

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

  test('resolve: fleet and linked worktrees get their own database; only the primary checkout is left on the shared one', () => {
    for (const wt of [fleet, fleetByDirOnly, linked]) {
      const [mode, db, , , , how] = sh(['bun', 'scripts/worktree-db.ts', 'resolve'], wt).out.trim().split(' ')
      expect(mode).toBe('isolated')
      expect(db).toMatch(/^llamenos_wt_[a-z0-9_]+_[0-9a-f]{10}$/)
      expect(how).toBe(wt === linked ? 'default' : 'policy')
    }
    expect(sh(['bun', 'scripts/worktree-db.ts', 'resolve'], primary).out.trim()).toBe('unset llamenos llamenos localhost 5432 none')
  })

  test('an explicit DATABASE_URL naming the shared database is refused for a fleet worker, with nothing exported', () => {
    for (const wt of [fleet, fleetByDirOnly]) {
      const r = exportWith(wt, '', SHARED)
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain('EXPORTED=')
      expect(r.err).toContain('REFUSED')
      expect(r.err).not.toContain('s3cret')
    }
  })

  test('LLAMENOS_ALLOW_SHARED_DB=1 does not lift it for a fleet worker', () => {
    const r = exportWith(fleet, '', { ...SHARED, LLAMENOS_ALLOW_SHARED_DB: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('EXPORTED=')
  })

  test('--shared (the containerised-app path) is refused for a fleet worker', () => {
    const r = exportWith(fleet, '--shared')
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('EXPORTED=')
    expect(r.err).toContain('REFUSED')
  })

  test('use-shared is refused for a fleet worker and writes no marker', () => {
    const r = sh(['bun', 'scripts/worktree-db.ts', 'use-shared'], fleet, { LLAMENOS_ALLOW_SHARED_DB: '1' })
    expect(r.code).toBe(4)
    const marker = sh(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'llamenos-worktree-db'], fleet).out.trim()
    expect(existsSync(marker)).toBe(false)
  })

  test('check-url is what the migrate wrapper and the integration wrapper rely on', () => {
    expect(sh(['bun', 'scripts/worktree-db.ts', 'check-url'], fleet, SHARED).code).toBe(4)
    expect(sh(['bun', 'scripts/worktree-db.ts', 'check-url'], linked, SHARED).code).toBe(4)
    expect(sh(['bun', 'scripts/worktree-db.ts', 'check-url'], linked, { ...SHARED, LLAMENOS_ALLOW_SHARED_DB: '1' }).code).toBe(0)
    expect(sh(['bun', 'scripts/worktree-db.ts', 'check-url'], primary, SHARED).code).toBe(0)
    expect(sh(['bun', 'scripts/worktree-db.ts', 'check-url'], fleet, { DATABASE_URL: 'postgresql://u:p@localhost:5432/llamenos_wt_x_0123456789' }).code).toBe(0)
  })

  // #2705. The owner secret sits in the git common dir every worktree of this repo can
  // see, so what is asserted is that no sanctioned path in a linked worktree hands it out.
  // PG_PASSWORD is deliberately wrong: secure-shared (which export runs first) must fail to
  // authenticate — or find no Postgres — and so can never touch a real cluster from here.
  describe('with the owner credential present', () => {
    const secretFile = join(primary, '.git', OWNER_SECRET_FILE)
    const OWNER_SECRET = 'owner-secret-not-real-0123456789abcdef'
    const NO_PG = { PG_PASSWORD: `wrong-${process.pid}-not-a-password` }
    beforeAll(() => writeFileSync(secretFile, `${OWNER_SECRET}\n`, { mode: 0o600 }))
    afterAll(() => rmSync(secretFile, { force: true }))

    test('resolve hands the owner role to the primary checkout only', () => {
      expect(sh(['bun', 'scripts/worktree-db.ts', 'resolve'], primary).out.trim()).toBe(
        `unset llamenos ${OWNER_ROLE} localhost 5432 none`,
      )
      for (const wt of [fleet, linked]) {
        const [, , user] = sh(['bun', 'scripts/worktree-db.ts', 'resolve'], wt).out.trim().split(' ')
        expect(user).toBe('llamenos')
      }
    })

    test("the primary checkout's own URL authenticates as the owner, with the secret from its git dir", () => {
      const r = exportWith(primary, '', NO_PG)
      expect(r.code).toBe(0)
      expect(r.out).toContain(`EXPORTED=postgresql://${OWNER_ROLE}:${OWNER_SECRET}@localhost:5432/llamenos`)
      expect(r.err).not.toContain(OWNER_SECRET)
    })

    test('a linked worktree that chose the shared database gets the read-only role, never the secret', () => {
      const allow = { ...NO_PG, LLAMENOS_ALLOW_SHARED_DB: '1' }
      expect(sh(['bun', 'scripts/worktree-db.ts', 'use-shared'], linked, allow).code).toBe(0)
      try {
        const r = exportWith(linked, '', allow)
        expect(r.code).toBe(0)
        expect(r.out).toContain('EXPORTED=postgresql://llamenos:')
        expect(r.out).not.toContain(OWNER_SECRET)
        expect(r.err).toContain('READ-ONLY')
      } finally {
        const marker = sh(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'llamenos-worktree-db'], linked).out.trim()
        rmSync(marker, { force: true })
      }
    })

    test('--shared (the containerised stack) uses that stack\'s one role, never the owner', () => {
      const r = exportWith(primary, '--shared', NO_PG)
      expect(r.code).toBe(0)
      expect(r.out).toContain('EXPORTED=postgresql://llamenos:')
      expect(r.out).not.toContain(OWNER_SECRET)
    })
  })

  test('the primary checkout still gets the shared database, as before', () => {
    const r = exportWith(primary, '', SHARED)
    expect(r.code).toBe(0)
    expect(r.out).toContain('EXPORTED=postgresql://llamenos:s3cret@localhost:5432/llamenos')
  })
})

// A new bootstrap path that hardcodes the shared database would walk straight past
// everything above. The previous leak was exactly that: a launcher script, a config
// default and a test wrapper each named `llamenos` on localhost:5432 on their own.
describe('no launcher names the shared database itself', () => {
  const REPO = realpathSync(join(import.meta.dir, '..'))
  const SHARED_LITERAL = /(localhost|127\.0\.0\.1|\[::1\])(:5432)?\/llamenos(?![\w])/i

  function filesUnder(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') filesUnder(full, out)
      } else if (/\.(sh|ts|mjs|js|json|ya?ml)$/.test(e.name)) {
        out.push(full)
      }
    }
    return out
  }

  test('scripts/, the root launchers and drizzle.config.ts compose it only through the resolver', () => {
    const roots = [
      ...filesUnder(join(REPO, 'scripts')),
      ...readdirSync(REPO).filter((f) => /\.(sh|ts)$/.test(f) || f === 'package.json').map((f) => join(REPO, f)),
    ].filter((f) => statSync(f).isFile())
    // The resolver itself, and this file's own fixtures, are the only places that may spell it out.
    const exempt = new Set(['scripts/worktree-db.ts', 'scripts/worktree-db.test.ts', 'scripts/lib/worktree-db.sh'])
    const offenders = roots
      .map((f) => relative(REPO, f))
      .filter((f) => !exempt.has(f))
      .filter((f) => SHARED_LITERAL.test(readFileSync(join(REPO, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // ~60 integration test files each carried their own `process.env.DATABASE_URL ?? '<shared URL>'`
  // (#2704). A default that supplies what the environment should have provided cannot fail when
  // isolation is missing — it quietly succeeds against the shared database. They now call
  // requireDatabaseUrl(), which throws; this keeps a new file from bringing the default back.
  test('no worker integration test names the shared database or defaults DATABASE_URL', () => {
    const dirs = ['integration', 'integration-bun'].map((d) => join(REPO, 'apps/worker/__tests__', d))
    const files = dirs.flatMap((d) => filesUnder(d)).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(50)
    const offenders = files
      .map((f) => relative(REPO, f))
      .filter((f) => {
        const src = readFileSync(join(REPO, f), 'utf8')
        return SHARED_LITERAL.test(src) || /DATABASE_URL\s*(\?\?|\|\|)/.test(src)
      })
    expect(offenders).toEqual([])
  })

  test('the scan reads real files (it would pass vacuously on an empty list)', () => {
    expect(filesUnder(join(REPO, 'scripts')).length).toBeGreaterThan(20)
    expect(SHARED_LITERAL.test('postgresql://llamenos:dev@localhost:5432/llamenos')).toBe(true)
    expect(SHARED_LITERAL.test('postgresql://llamenos:dev@localhost:5432/llamenos_wt_x')).toBe(false)
  })

  test('the entry points that migrate or serve go through the resolver', () => {
    const must: [string, RegExp][] = [
      ['scripts/db-migrate.sh', /worktree_db_export/],
      ['scripts/dev-bun.sh', /worktree_db_export/],
      ['start-server.sh', /worktree_db_export/],
      ['scripts/test-worker-integration.ts', /worktree_db_export/],
      ['scripts/test-worker-integration-bun.sh', /worktree_db_export/],
    ]
    for (const [file, re] of must) expect(readFileSync(join(REPO, file), 'utf8'), file).toMatch(re)
    const pkgScripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts
    expect(pkgScripts['db:migrate']).toBe('bash scripts/db-migrate.sh')
    // The integration tiers' package scripts run the resolving wrappers, never bare vitest/bun test (#2704).
    expect(pkgScripts['test:worker:integration']).toBe('bun scripts/test-worker-integration.ts')
    expect(pkgScripts['test:worker:integration-bun']).toBe('bash scripts/test-worker-integration-bun.sh')
    // And no default database in drizzle's config.
    expect(readFileSync(join(REPO, 'drizzle.config.ts'), 'utf8')).not.toMatch(/\|\|\s*['"`]postgres/)
  })
})

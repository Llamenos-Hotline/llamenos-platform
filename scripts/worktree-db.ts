#!/usr/bin/env bun
/**
 * One PostgreSQL database per worktree, on the ONE dev Postgres instance.
 *
 * Every worktree used to default to the same `llamenos` database
 * (scripts/dev-bun.sh), so parallel workers ran `test-reset` cycles against
 * each other: pool exhaustion (#1264), servers wedging behind another
 * worktree's TRUNCATE, scenarios that "regressed" and had not, and direct-DB
 * assertions (tests/db-helpers.ts) reading someone else's rows.
 *
 * Layout on the instance from deploy/docker/docker-compose.dev.yml, which this
 * tool does not change (no new containers, no new ports):
 *
 *   llamenos                      the shared database — never touched here
 *   llamenos_tpl_<schema hash>    schema-only template, one per migration set;
 *                                 immutable once published, never connectable
 *   llamenos_wt_<dir>_<path hash> one per worktree, cloned from the template
 *
 * Each worktree database carries its provenance as a database COMMENT (the
 * worktree's absolute path, its git common dir, the schema hash it was built
 * at). The sweep only ever drops a database whose provenance proves this tool
 * created it for a worktree that is genuinely gone — see classifyForSweep().
 *
 * DATABASE_URL is composed in exactly one place, scripts/lib/worktree-db.sh,
 * which both the server launcher and the test launcher source. This file never
 * prints a connection string: it resolves database NAMES only.
 *
 * Usage (from anywhere inside a worktree):
 *   bun scripts/worktree-db.ts status
 *   bun scripts/worktree-db.ts ensure [--opt-in]   create/migrate this worktree's DB
 *   bun scripts/worktree-db.ts use-isolated        opt in, then ensure
 *   bun scripts/worktree-db.ts use-shared          opt out (keeps the DB, uses `llamenos`)
 *   bun scripts/worktree-db.ts reset --yes         drop + recreate this worktree's DB
 *   bun scripts/worktree-db.ts teardown --yes      drop this worktree's DB, forget the opt-in
 *   bun scripts/worktree-db.ts sweep [--drop] [--quiet] [--grace-hours N] [name...]
 *   bun scripts/worktree-db.ts resolve             machine-readable; used by the bash lib
 */
import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// ── Naming ───────────────────────────────────────────────────────────────────

export const SHARED_DB = 'llamenos'
export const WORKTREE_PREFIX = 'llamenos_wt_'
export const TEMPLATE_PREFIX = 'llamenos_tpl_'
export const BUILD_PREFIX = 'llamenos_tplbuild_'

/**
 * Never dropped, renamed or re-commented by this tool, whatever their comment
 * says. Checked before anything else in the sweep so that no bug further down
 * can reach them.
 */
const PROTECTED_NAMES = new Set([SHARED_DB, 'postgres', 'template0', 'template1'])
const PROTECTED_PREFIXES = [TEMPLATE_PREFIX, BUILD_PREFIX]

/** PostgreSQL truncates identifiers to NAMEDATALEN-1 bytes. */
const PG_IDENTIFIER_MAX_BYTES = 63
/** Hex chars of sha256(absolute worktree path) appended to every name. */
const PATH_HASH_LENGTH = 10
/** Hex chars of the schema hash in a template's name. */
const SCHEMA_HASH_LENGTH = 16

const IDENTIFIER = /^[a-z0-9_]+$/

export function isProtected(name: string): boolean {
  return PROTECTED_NAMES.has(name) || PROTECTED_PREFIXES.some((p) => name.startsWith(p))
}

/** Lowercase, and collapse every run of anything outside [a-z0-9] to one `_`. */
export function sanitise(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * The database name for a worktree: `llamenos_wt_<dir>_<hash>`.
 *
 * `<dir>` is the sanitised directory name, for humans — and sanitising
 * collides (`llamenos-foo` and `llamenos_foo`, or the same directory name under
 * two parents), as does truncating it. So uniqueness never rests on it: `<hash>`
 * is the first 40 bits of sha256 over the worktree's full absolute path, and
 * `<dir>` is cut to whatever room is left under the 63-byte identifier limit.
 * The result is pure ASCII, so bytes == characters, and already lowercase, so
 * PostgreSQL's case folding cannot change it.
 *
 * A 40-bit prefix makes an accidental collision negligible (and it would also
 * need the same `<dir>`), but ensure() still refuses to adopt a database whose
 * recorded path is not this worktree's, so even that case fails loudly instead
 * of silently sharing.
 */
export function deriveDatabaseName(worktreePath: string): string {
  let dir = sanitise(basename(worktreePath))
  // Nearly every worktree is `llamenos-<something>`; repeating it after the
  // prefix only spends the byte budget. The path hash keeps names unique.
  if (dir.startsWith('llamenos_') && dir.length > 'llamenos_'.length) dir = dir.slice('llamenos_'.length)
  if (dir === '') dir = 'worktree'
  const hash = sha256(worktreePath).slice(0, PATH_HASH_LENGTH)
  const room = PG_IDENTIFIER_MAX_BYTES - WORKTREE_PREFIX.length - 1 - PATH_HASH_LENGTH
  dir = dir.slice(0, room).replace(/_+$/, '') || 'worktree'
  return `${WORKTREE_PREFIX}${dir}_${hash}`
}

export function templateName(schemaHash: string): string {
  return `${TEMPLATE_PREFIX}${schemaHash}`
}

/**
 * Identifies the schema a fresh database gets: every migration file (name and
 * content) plus the runner that applies them, since its idempotency rewrites
 * are part of what "applying" means. Reading ~55 small files costs
 * milliseconds, so this runs on every ensure() — a changed migration can never
 * be served from a stale template.
 */
export function schemaHash(root: string): string {
  const migrationsDir = join(root, 'drizzle', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const outer = createHash('sha256')
  for (const file of files) {
    outer.update(`${file}\0${sha256(readFileSync(join(migrationsDir, file)))}\n`)
  }
  outer.update(`runner\0${sha256(readFileSync(join(root, 'scripts', 'run-migrations.ts')))}\n`)
  return outer.digest('hex').slice(0, SCHEMA_HASH_LENGTH)
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ── Provenance ───────────────────────────────────────────────────────────────

const TOOL = 'llamenos-worktree-db'

export interface WorktreeProvenance {
  tool: typeof TOOL
  v: 1
  kind: 'worktree'
  /** Real path of the worktree the database belongs to. */
  worktree: string
  /** Real path of the git common dir, to ask git whether the worktree is registered. */
  commonDir: string
  /** schemaHash() the database was last built or migrated at. */
  schemaHash: string
  createdAt: string
  /** First sweep that saw the worktree gone; the grace period runs from here. */
  orphanSince: string | null
}

export interface TemplateProvenance {
  tool: typeof TOOL
  v: 1
  kind: 'template'
  schemaHash: string
  builtAt: string
}

function parseJsonObject(comment: string | null): Record<string, unknown> | null {
  if (!comment) return null
  try {
    const value: unknown = JSON.parse(comment)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseWorktreeProvenance(comment: string | null): WorktreeProvenance | null {
  const o = parseJsonObject(comment)
  if (!o || o.tool !== TOOL || o.v !== 1 || o.kind !== 'worktree') return null
  const { worktree, commonDir, schemaHash, createdAt, orphanSince } = o
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) return null
  if (typeof commonDir !== 'string' || !commonDir.startsWith('/')) return null
  if (typeof schemaHash !== 'string' || typeof createdAt !== 'string') return null
  if (orphanSince !== null && (typeof orphanSince !== 'string' || Number.isNaN(Date.parse(orphanSince)))) return null
  return { tool: TOOL, v: 1, kind: 'worktree', worktree, commonDir, schemaHash, createdAt, orphanSince }
}

export function parseTemplateProvenance(comment: string | null): TemplateProvenance | null {
  const o = parseJsonObject(comment)
  if (!o || o.tool !== TOOL || o.v !== 1 || o.kind !== 'template') return null
  if (typeof o.schemaHash !== 'string' || typeof o.builtAt !== 'string') return null
  return { tool: TOOL, v: 1, kind: 'template', schemaHash: o.schemaHash, builtAt: o.builtAt }
}

// ── Sweep decision (pure — every safety condition lives here) ────────────────

export type PathState = 'present' | 'absent' | 'unknown'
export type Registration = 'listed' | 'unlisted' | 'unknown'

export interface SweepProbes {
  pathState(path: string): PathState
  /** Is `worktree` in `git worktree list` for the repository at `commonDir`? */
  registration(commonDir: string, worktree: string): Registration
}

export type SweepVerdict =
  | { action: 'refuse'; reason: string }
  | { action: 'ignore'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'keep'; reason: string }
  | { action: 'unmark'; reason: string }
  | { action: 'mark'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'drop'; reason: string }

export interface SweepCandidate {
  name: string
  comment: string | null
  /** Sessions currently connected to the database. */
  sessions: number
}

/**
 * Decide what the sweep may do with one database. A database is dropped only
 * when EVERY one of these holds:
 *
 *  1. It is not `llamenos`, `postgres`, `template0/1`, or a template/build DB.
 *  2. Its name has the `llamenos_wt_` prefix.
 *  3. Its comment is this tool's provenance record, and re-deriving the name
 *     from the recorded worktree path gives exactly this name — a hand-made
 *     database, or one whose comment was copied or edited, fails here.
 *  4. The recorded worktree directory does not exist.
 *  5. Its parent directory DOES exist. Otherwise an unmounted volume looks
 *     exactly like a deleted worktree, and the sweep cannot tell them apart.
 *  6. Git does not list it as a worktree of the recorded repository. A worktree
 *     git still tracks (locked, or awaiting `git worktree prune`) is kept; and
 *     if git cannot be asked, nothing is dropped.
 *  7. Nothing is connected to it.
 *  8. It has been seen orphaned for at least the grace period: the first sweep
 *     that finds it gone only records the time.
 *
 * Anything that cannot be proven is `skip`, never `drop`.
 */
export function classifyForSweep(
  db: SweepCandidate,
  probes: SweepProbes,
  now: Date,
  graceMs: number,
): SweepVerdict {
  if (isProtected(db.name)) {
    return { action: 'refuse', reason: 'protected database — the sweep never touches it' }
  }
  if (!db.name.startsWith(WORKTREE_PREFIX)) {
    return { action: 'ignore', reason: `no ${WORKTREE_PREFIX} prefix — not created by this tool` }
  }
  const prov = parseWorktreeProvenance(db.comment)
  if (!prov) {
    return { action: 'skip', reason: 'no provenance record — not created by this tool, left alone' }
  }
  if (deriveDatabaseName(prov.worktree) !== db.name) {
    return { action: 'skip', reason: `provenance names ${prov.worktree}, which does not derive this name` }
  }

  const worktree = probes.pathState(prov.worktree)
  if (worktree === 'present') {
    return prov.orphanSince
      ? { action: 'unmark', reason: `worktree is back at ${prov.worktree} — clearing the orphan mark` }
      : { action: 'keep', reason: `worktree present at ${prov.worktree}` }
  }
  if (worktree === 'unknown') {
    return { action: 'skip', reason: `cannot stat ${prov.worktree}` }
  }
  if (probes.pathState(dirname(prov.worktree)) !== 'present') {
    return {
      action: 'skip',
      reason: `parent of ${prov.worktree} is missing too — cannot tell a deleted worktree from an unmounted volume`,
    }
  }
  const registration = probes.registration(prov.commonDir, prov.worktree)
  if (registration === 'listed') {
    return {
      action: 'keep',
      reason: `directory is gone but git still lists the worktree (run \`git worktree prune\` if it is really gone)`,
    }
  }
  if (registration === 'unknown') {
    return { action: 'skip', reason: `could not ask git (${prov.commonDir}) whether the worktree is registered` }
  }
  if (db.sessions > 0) {
    return { action: 'skip', reason: `worktree is gone but ${db.sessions} session(s) are connected` }
  }

  const since = prov.orphanSince ? new Date(prov.orphanSince) : now
  const due = new Date(since.getTime() + graceMs)
  if (due.getTime() <= now.getTime()) {
    return { action: 'drop', reason: `worktree ${prov.worktree} is gone (orphaned since ${since.toISOString()})` }
  }
  return prov.orphanSince
    ? { action: 'wait', reason: `worktree ${prov.worktree} is gone; droppable after ${due.toISOString()}` }
    : { action: 'mark', reason: `worktree ${prov.worktree} is gone; recording it, droppable after ${due.toISOString()}` }
}

function pathState(path: string): PathState {
  try {
    lstatSync(path)
    return 'present'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function makeRegistrationProbe(): SweepProbes['registration'] {
  const listed = new Map<string, Set<string> | null>()
  return (commonDir, worktree) => {
    if (!listed.has(commonDir)) {
      const state = pathState(commonDir)
      if (state === 'present') {
        const r = Bun.spawnSync(['git', `--git-dir=${commonDir}`, 'worktree', 'list', '--porcelain'])
        if (r.exitCode !== 0) {
          listed.set(commonDir, null)
        } else {
          const paths = new Set<string>()
          for (const line of r.stdout.toString().split('\n')) {
            if (!line.startsWith('worktree ')) continue
            const p = line.slice('worktree '.length)
            paths.add(p)
            const real = realpathOrNull(p)
            if (real) paths.add(real)
          }
          listed.set(commonDir, paths)
        }
      } else if (state === 'absent' && pathState(dirname(commonDir)) === 'present') {
        // The whole repository is gone (its parent is still mounted): nothing lists it.
        listed.set(commonDir, new Set())
      } else {
        listed.set(commonDir, null)
      }
    }
    const paths = listed.get(commonDir)
    if (!paths) return 'unknown'
    return paths.has(worktree) ? 'listed' : 'unlisted'
  }
}

// ── This worktree ────────────────────────────────────────────────────────────

type Mode = 'isolated' | 'shared'

interface Worktree {
  root: string
  commonDir: string
  /** Per-worktree opt-in marker. Lives in git's per-worktree admin dir, so it
   *  is never tracked and disappears with `git worktree remove`. */
  markerPath: string
  dbName: string
}

function git(root: string, args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', root, ...args])
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

function currentWorktree(): Worktree {
  const root = realpathSync(join(import.meta.dir, '..'))
  const commonDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const markerPath = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'llamenos-worktree-db'])
  return { root, commonDir, markerPath, dbName: deriveDatabaseName(root) }
}

function readMode(wt: Worktree): Mode | null {
  let text: string
  try {
    text = readFileSync(wt.markerPath, 'utf8').trim()
  } catch {
    return null
  }
  if (text === 'isolated' || text === 'shared') return text
  throw new Error(`${wt.markerPath} contains "${text}" — expected "isolated" or "shared"`)
}

function writeMode(wt: Worktree, mode: Mode): void {
  mkdirSync(dirname(wt.markerPath), { recursive: true })
  writeFileSync(wt.markerPath, `${mode}\n`)
}

// ── Connection ───────────────────────────────────────────────────────────────

/** Mirrors the postgres service in deploy/docker/docker-compose.dev.yml. */
export const PG_USER = 'llamenos'
export const PG_HOST = 'localhost'
export const PG_PORT = 5432

/** Exit code for "the dev Postgres is not reachable": setup warns and carries on. */
const EXIT_UNREACHABLE = 3

class Unreachable extends Error {}

function dotenvValue(file: string, key: string): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let value: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] !== key) continue
    const v = m[2]
    value = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v
  }
  return value
}

/** Same precedence as scripts/lib/worktree-db.sh: environment, then .env, then the compose default. */
function pgPassword(root: string): string {
  return process.env.PG_PASSWORD || dotenvValue(join(root, '.env'), 'PG_PASSWORD') || 'dev'
}

function sqlState(err: unknown): string | undefined {
  const e = err as { errno?: unknown; code?: unknown }
  if (typeof e?.errno === 'string') return e.errno
  return typeof e?.code === 'string' ? e.code : undefined
}

async function connect(root: string, database: string): Promise<SQL> {
  const sql = new SQL({
    hostname: PG_HOST,
    port: PG_PORT,
    username: PG_USER,
    password: pgPassword(root),
    database,
    max: 1,
    connectionTimeout: 10,
  })
  try {
    await sql.unsafe('SELECT 1')
  } catch (err) {
    await sql.close().catch(() => {})
    if (sqlState(err) === '28P01') {
      throw new Unreachable(
        `password authentication failed for role "${PG_USER}" at ${PG_HOST}:${PG_PORT}. ` +
          'PG_PASSWORD (environment, else .env, else "dev") is not the password the dev ' +
          "Postgres volume was initialised with — the image only reads POSTGRES_PASSWORD when the " +
          'volume is first created. Set PG_PASSWORD in .env to the password that volume was created ' +
          "with (scripts/dev-bun.sh loads .env over the environment), or change the role's password " +
          `inside the container (ALTER ROLE ${PG_USER} PASSWORD ...).`,
      )
    }
    throw new Unreachable(
      `cannot reach the dev Postgres at ${PG_HOST}:${PG_PORT} (${redact(errorMessage(err))}). ` +
        'Start it with: docker compose -f deploy/docker/docker-compose.dev.yml up -d',
    )
  }
  return sql
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Belt and braces: nothing here formats a URL, but never let one through. */
function redact(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s]*@/gi, '$1***@')
}

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`refusing to use unexpected identifier ${JSON.stringify(name)}`)
  return `"${name}"`
}

/** COMMENT ON takes no bind parameters, so the literal is escaped here. */
function literal(text: string): string {
  if (text.includes('\0')) throw new Error('NUL byte in comment')
  return `'${text.replace(/'/g, "''")}'`
}

interface DbRow {
  datname: string
  datistemplate: boolean
  datallowconn: boolean
  comment: string | null
  sessions: number
}

const DB_ROW_SQL = `
  SELECT d.datname, d.datistemplate, d.datallowconn,
         shobj_description(d.oid, 'pg_database') AS comment,
         (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessions
  FROM pg_database d`

async function findDb(sql: SQL, name: string): Promise<DbRow | null> {
  const rows = (await sql.unsafe(`${DB_ROW_SQL} WHERE d.datname = $1`, [name])) as DbRow[]
  return rows[0] ?? null
}

async function listDbs(sql: SQL): Promise<DbRow[]> {
  return (await sql.unsafe(`${DB_ROW_SQL} ORDER BY d.datname`)) as DbRow[]
}

async function setComment(sql: SQL, name: string, value: object): Promise<void> {
  await sql.unsafe(`COMMENT ON DATABASE ${ident(name)} IS ${literal(JSON.stringify(value))}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message: string): void {
  console.error(`[worktree-db] ${message}`)
}

// ── Serialisation ────────────────────────────────────────────────────────────

/**
 * Every create/build/drop on the instance runs under this session-level
 * advisory lock, taken in the `postgres` database. It serialises a template
 * build against the clones that need it, and the sweep against a new worktree
 * claiming its database. Distinct from run-migrations.ts's key, which is taken
 * inside the target database anyway.
 */
const LOCK_KEY = 7_742_010_914_552
const LOCK_WAIT_MS = 300_000

async function withInstanceLock<T>(sql: SQL, body: () => Promise<T>): Promise<T> {
  const started = Date.now()
  let lastNotice = 0
  for (;;) {
    const [{ ok }] = (await sql.unsafe(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`)) as { ok: boolean }[]
    if (ok) break
    const waited = Date.now() - started
    if (waited > LOCK_WAIT_MS) {
      throw new Error(
        `another worktree has held the worktree-db lock for over ${LOCK_WAIT_MS / 1000}s. ` +
          `Find it with: SELECT pid, application_name, backend_start FROM pg_locks JOIN pg_stat_activity ` +
          `USING (pid) WHERE locktype = 'advisory' AND objid = ${LOCK_KEY % 2 ** 32}`,
      )
    }
    if (waited - lastNotice >= 10_000) {
      log('waiting for another worktree-db operation (usually a template build) to finish...')
      lastNotice = waited
    }
    await sleep(500)
  }
  try {
    return await body()
  } finally {
    await sql.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {})
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

interface Session {
  pid: number
  usename: string | null
  application_name: string | null
  client_addr: string | null
  backend_start: Date | null
}

async function sessionsOn(sql: SQL, name: string): Promise<Session[]> {
  return (await sql.unsafe(
    `SELECT pid, usename, application_name, client_addr::text AS client_addr, backend_start
     FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  )) as Session[]
}

function describeSessions(sessions: Session[]): string {
  return sessions
    .map(
      (s) =>
        `pid=${s.pid} user=${s.usename ?? '?'} app=${JSON.stringify(s.application_name ?? '')} ` +
        `client=${s.client_addr ?? 'local'} since=${s.backend_start ? new Date(s.backend_start).toISOString() : '?'}`,
    )
    .join('; ')
}

/**
 * A template must accept no connections: CREATE DATABASE ... TEMPLATE refuses
 * to copy a database anyone is connected to, and anything a session changed
 * in it would be copied into every worktree created afterwards.
 */
async function sealTemplate(sql: SQL, name: string): Promise<void> {
  await sql.unsafe(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
}

/**
 * Run `body`, which needs `name` to have no sessions, and never fail
 * intermittently because one is there.
 *
 * PostgreSQL already waits up to 5s inside each CREATE / RENAME / DROP
 * DATABASE for other sessions to exit (CountOtherDBBackends), so a session on
 * its way out never surfaces at all; only one still there after that answers
 * 55006 (object_in_use). Then: pause and try once more (~11s of waiting in
 * all); then terminate what is still connected — nothing may legitimately sit
 * in a template (it is sealed with ALLOW_CONNECTIONS false, so any session
 * predates the seal or bypassed it) — and retry, PostgreSQL again waiting for
 * the terminated backends to exit; then fail, naming every session still there.
 */
async function withoutSessions(sql: SQL, name: string, what: string, body: () => Promise<void>): Promise<void> {
  const RETRIES_BEFORE_TERMINATING = 1
  const RETRIES_AFTER_TERMINATING = 2
  const PAUSE_MS = 1000
  for (let attempt = 0; ; attempt++) {
    try {
      await body()
      return
    } catch (err) {
      if (sqlState(err) !== '55006') throw err
      const sessions = await sessionsOn(sql, name)
      if (attempt < RETRIES_BEFORE_TERMINATING) {
        log(`${name} is in use by ${sessions.length} session(s) (${describeSessions(sessions)}); retrying ${what}`)
      } else if (attempt === RETRIES_BEFORE_TERMINATING) {
        log(`${name} still has ${sessions.length} session(s) after waiting — terminating them: ${describeSessions(sessions)}`)
        for (const s of sessions) await sql.unsafe('SELECT pg_terminate_backend($1)', [s.pid])
      } else if (attempt >= RETRIES_BEFORE_TERMINATING + RETRIES_AFTER_TERMINATING) {
        throw new Error(
          `cannot ${what}: ${name} is still in use after waiting and terminating sessions — ${describeSessions(sessions)}. ` +
            `Close whatever is connected to it and re-run.`,
        )
      }
      await sleep(PAUSE_MS)
    }
  }
}

function databaseUrlFor(root: string, database: string): string {
  const password = encodeURIComponent(pgPassword(root))
  return `postgresql://${PG_USER}:${password}@${PG_HOST}:${PG_PORT}/${database}`
}

/** Apply migrations with the same runner the container entrypoint and CI use. */
function runMigrations(root: string, database: string): void {
  const started = Date.now()
  const r = Bun.spawnSync([process.execPath, '--no-env-file', join(root, 'scripts', 'run-migrations.ts')], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: databaseUrlFor(root, database) },
  })
  const output = redact(`${r.stdout.toString()}${r.stderr.toString()}`)
  if (r.exitCode !== 0) {
    throw new Error(`migrations failed on ${database}:\n${output.trimEnd()}`)
  }
  const summary = output.split('\n').find((l) => l.startsWith('[migrate] Done'))
  log(`${database}: ${summary ?? 'migrations applied'} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}

/**
 * Return the template for `hash`, building it if it does not exist yet.
 * Caller holds the instance lock.
 *
 * Templates are content-addressed rather than one `llamenos_template` rebuilt
 * whenever migrations change: worktrees sit on many branches with different
 * migration sets, and a single template would be dropped and rebuilt back and
 * forth between them — each rebuild racing every clone in flight, the exact
 * "template in use" failure. A published template is never modified.
 *
 * It is migrated under a build name and renamed only once migrations succeed,
 * so a template name only ever exists with a complete schema.
 */
async function ensureTemplate(sql: SQL, root: string, hash: string): Promise<string> {
  const name = templateName(hash)
  const existing = await findDb(sql, name)
  if (existing) {
    if (parseTemplateProvenance(existing.comment)?.schemaHash === hash) {
      if (existing.datallowconn || !existing.datistemplate) await sealTemplate(sql, name)
      return name
    }
    log(`${name} exists without a valid provenance record — rebuilding it`)
    await sql.unsafe(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE false`)
    await withoutSessions(sql, name, 'drop the invalid template', () => sql.unsafe(`DROP DATABASE ${ident(name)}`).then(() => {}))
  }

  // Under the instance lock only one build runs at a time, so a leftover build
  // database for this hash is from a run that died.
  const build = `${BUILD_PREFIX}${hash}`
  if (await findDb(sql, build)) {
    await withoutSessions(sql, build, 'drop a stale build', () => sql.unsafe(`DROP DATABASE ${ident(build)}`).then(() => {}))
  }

  log(`building template ${name} from drizzle/migrations (one-off for this migration set)...`)
  await sql.unsafe(`CREATE DATABASE ${ident(build)} TEMPLATE template0`)
  runMigrations(root, build)
  const provenance: TemplateProvenance = {
    tool: TOOL,
    v: 1,
    kind: 'template',
    schemaHash: hash,
    builtAt: new Date().toISOString(),
  }
  await setComment(sql, build, provenance)
  // The migration runner has just disconnected; its backend can take a moment to exit.
  await withoutSessions(sql, build, 'publish the template', () =>
    sql.unsafe(`ALTER DATABASE ${ident(build)} RENAME TO ${ident(name)}`).then(() => {}),
  )
  await sealTemplate(sql, name)
  log(`template ${name} ready`)
  return name
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Make this worktree's database exist and match its migrations.
 *
 * `--opt-in` (used by scripts/worktree-setup.sh) records the opt-in for a
 * worktree that has not chosen yet. Without it, a worktree that never opted in
 * is left on the shared database — ensure() never switches anyone implicitly.
 */
async function ensure(optIn: boolean): Promise<void> {
  const wt = currentWorktree()
  let mode = readMode(wt)
  if (mode === null && optIn) {
    writeMode(wt, 'isolated')
    mode = 'isolated'
    log(`this worktree now uses its own database, ${wt.dbName}.`)
    log(`the shared "${SHARED_DB}" database is untouched; a server already running keeps its database until restarted.`)
    log(`to go back: bun scripts/worktree-db.ts use-shared`)
  }
  if (mode !== 'isolated') {
    log(
      mode === 'shared'
        ? `this worktree opted out (use-shared) — nothing to provision`
        : `this worktree has not opted in — nothing provisioned (bun scripts/worktree-db.ts use-isolated)`,
    )
    return
  }

  const hash = schemaHash(wt.root)
  const sql = await connect(wt.root, 'postgres')
  try {
    // The schema hash the existing database was built at, when it differs from this checkout's.
    const migrateFrom = await withInstanceLock(sql, async (): Promise<string | null> => {
      const existing = await findDb(sql, wt.dbName)
      if (existing) {
        const prov = parseWorktreeProvenance(existing.comment)
        if (!prov) {
          throw new Error(
            `${wt.dbName} exists but carries no provenance record, so it was not created by this tool ` +
              `for this worktree. Refusing to adopt it. If it is yours: bun scripts/worktree-db.ts reset --yes`,
          )
        }
        if (prov.worktree !== wt.root) {
          throw new Error(
            `${wt.dbName} belongs to ${prov.worktree}, not ${wt.root} (name collision). ` +
              'Refusing to share it. Rename or move one of the two worktrees.',
          )
        }
        if (prov.orphanSince) await setComment(sql, wt.dbName, { ...prov, orphanSince: null })
        return prov.schemaHash !== hash ? prov.schemaHash : null
      }
      const template = await ensureTemplate(sql, wt.root, hash)
      await withoutSessions(sql, template, `create ${wt.dbName}`, () =>
        sql.unsafe(`CREATE DATABASE ${ident(wt.dbName)} TEMPLATE ${ident(template)}`).then(() => {}),
      )
      const provenance: WorktreeProvenance = {
        tool: TOOL,
        v: 1,
        kind: 'worktree',
        worktree: wt.root,
        commonDir: wt.commonDir,
        schemaHash: hash,
        createdAt: new Date().toISOString(),
        orphanSince: null,
      }
      await setComment(sql, wt.dbName, provenance)
      log(`created ${wt.dbName} from ${template}`)
      return null
    })

    if (migrateFrom !== null) {
      // Forward-migrate in place, keeping this worktree's data — the same
      // ledger-based runner production uses, so a shipped migration that was
      // edited is refused rather than silently re-run.
      log(`${wt.dbName} was built at schema ${migrateFrom}; migrations are now ${hash} — migrating in place`)
      try {
        runMigrations(wt.root, wt.dbName)
      } catch (err) {
        throw new Error(
          `${errorMessage(err)}\n` +
            `This database cannot be migrated forward to this checkout's migrations (e.g. a migration ` +
            `file differs from the one it was built with). To rebuild it from scratch — DESTROYING this ` +
            `worktree's data — run: bun scripts/worktree-db.ts reset --yes`,
        )
      }
      const row = await findDb(sql, wt.dbName)
      const prov = parseWorktreeProvenance(row?.comment ?? null)
      if (prov) await setComment(sql, wt.dbName, { ...prov, schemaHash: hash })
    } else {
      log(`${wt.dbName} is ready (schema ${hash})`)
    }
  } finally {
    await sql.close()
  }
}

/** Machine-readable for scripts/lib/worktree-db.sh: `<mode> <database> <user> <host> <port>`. */
function resolve(): void {
  let mode: Mode | 'unset' = 'unset'
  let database = SHARED_DB
  try {
    const wt = currentWorktree()
    const m = readMode(wt)
    if (m === 'isolated') {
      mode = 'isolated'
      database = wt.dbName
    } else if (m === 'shared') {
      mode = 'shared'
    }
  } catch (err) {
    // Not inside a git worktree (e.g. an exported tarball): there is no marker to read.
    log(`cannot determine the worktree (${errorMessage(err)}) — treating it as not opted in`)
  }
  console.log(`${mode} ${database} ${PG_USER} ${PG_HOST} ${PG_PORT}`)
}

async function status(): Promise<void> {
  const wt = currentWorktree()
  const mode = readMode(wt)
  const hash = schemaHash(wt.root)
  console.log(`worktree  ${wt.root}`)
  console.log(`mode      ${mode ?? 'not chosen — using the SHARED database'}  (marker: ${wt.markerPath})`)
  console.log(`database  ${mode === 'isolated' ? wt.dbName : SHARED_DB}${mode !== 'isolated' ? `  (own database would be ${wt.dbName})` : ''}`)
  console.log(`schema    ${hash}  (drizzle/migrations + scripts/run-migrations.ts)`)
  let sql: SQL
  try {
    sql = await connect(wt.root, 'postgres')
  } catch (err) {
    console.log(`postgres  ${errorMessage(err)}`)
    return
  }
  try {
    const own = await findDb(sql, wt.dbName)
    const prov = parseWorktreeProvenance(own?.comment ?? null)
    console.log(
      `own db    ${own ? `exists, ${own.sessions} session(s), built at schema ${prov?.schemaHash ?? 'unknown (no provenance)'}${prov && prov.schemaHash !== hash ? ' — will be migrated on next ensure' : ''}` : 'does not exist'}`,
    )
    const tpl = await findDb(sql, templateName(hash))
    console.log(
      `template  ${templateName(hash)}: ${tpl ? `present${tpl.datallowconn ? ' (NOT sealed — accepts connections)' : ', sealed'}` : 'not built yet'}`,
    )
  } finally {
    await sql.close()
  }
}

async function setMode(mode: Mode): Promise<void> {
  const wt = currentWorktree()
  writeMode(wt, mode)
  if (mode === 'isolated') {
    log(`opted in: this worktree uses ${wt.dbName}. Restart any running dev server to pick it up.`)
    await ensure(false)
  } else {
    log(`opted out: this worktree uses the shared "${SHARED_DB}" database. Restart any running dev server to pick it up.`)
    log(`${wt.dbName} (if it exists) is kept; teardown --yes drops it.`)
  }
}

/** Drop this worktree's own database — only ever that one name, and only if it is provably ours. */
async function dropOwn(wt: Worktree, sql: SQL): Promise<boolean> {
  const own = await findDb(sql, wt.dbName)
  if (!own) return false
  const prov = parseWorktreeProvenance(own.comment)
  if (prov && prov.worktree !== wt.root) {
    throw new Error(`${wt.dbName} belongs to ${prov.worktree}, not this worktree — refusing to drop it`)
  }
  if (own.sessions > 0) {
    throw new Error(
      `${wt.dbName} has ${own.sessions} open session(s) (${describeSessions(await sessionsOn(sql, wt.dbName))}). ` +
        'Stop the dev server / tests using it first.',
    )
  }
  await sql.unsafe(`DROP DATABASE ${ident(wt.dbName)}`)
  log(`dropped ${wt.dbName}`)
  return true
}

async function reset(): Promise<void> {
  const wt = currentWorktree()
  if (readMode(wt) !== 'isolated') throw new Error('this worktree is not using its own database — nothing to reset')
  const sql = await connect(wt.root, 'postgres')
  try {
    await withInstanceLock(sql, () => dropOwn(wt, sql))
  } finally {
    await sql.close()
  }
  await ensure(false)
}

async function teardown(): Promise<void> {
  const wt = currentWorktree()
  const sql = await connect(wt.root, 'postgres')
  try {
    const dropped = await withInstanceLock(sql, () => dropOwn(wt, sql))
    if (!dropped) log(`${wt.dbName} does not exist`)
  } finally {
    await sql.close()
  }
  rmSync(wt.markerPath, { force: true })
  log('opt-in forgotten: this worktree is back on the shared database (with a warning) until it opts in again')
}

async function sweep(opts: { drop: boolean; quiet: boolean; graceMs: number; names: string[] }): Promise<void> {
  const root = realpathSync(join(import.meta.dir, '..'))
  const sql = await connect(root, 'postgres')
  const probes: SweepProbes = { pathState, registration: makeRegistrationProbe() }
  const graceHours = opts.graceMs / 3_600_000
  console.log(
    `worktree-db sweep — ${opts.drop ? 'DROP mode' : 'dry run (nothing is changed; pass --drop to act)'}, grace ${graceHours}h`,
  )
  try {
    await withInstanceLock(sql, async () => {
      const all = await listDbs(sql)
      const byName = new Map(all.map((d) => [d.datname, d]))
      const targets: SweepCandidate[] = opts.names.length
        ? opts.names.map((n) => byName.get(n) ?? { datname: n, comment: null, sessions: 0 }).map(toCandidate)
        : all.map(toCandidate)
      const now = new Date()
      let ignored = 0
      let protectedCount = 0
      let kept = 0
      for (const db of targets) {
        if (opts.names.length && !byName.has(db.name)) {
          console.log(`  ${'MISSING'.padEnd(7)} ${db.name}  no such database`)
          continue
        }
        const verdict = classifyForSweep(db, probes, now, opts.graceMs)
        // Unless named explicitly, databases the sweep can never act on are only counted.
        if (!opts.names.length && verdict.action === 'ignore') {
          ignored++
          continue
        }
        if (!opts.names.length && verdict.action === 'refuse') {
          protectedCount++
          continue
        }
        if (opts.quiet && verdict.action === 'keep') {
          kept++
          continue
        }
        console.log(`  ${verdict.action.toUpperCase().padEnd(7)} ${db.name}  ${verdict.reason}`)
        if (!opts.drop) continue
        const prov = parseWorktreeProvenance(db.comment)
        if (verdict.action === 'mark' && prov) {
          await setComment(sql, db.name, { ...prov, orphanSince: now.toISOString() })
        } else if (verdict.action === 'unmark' && prov) {
          await setComment(sql, db.name, { ...prov, orphanSince: null })
        } else if (verdict.action === 'drop') {
          // Plain DROP, no FORCE: if anything connected since it was classified, it stays.
          try {
            await sql.unsafe(`DROP DATABASE ${ident(db.name)}`)
            console.log(`  ${'DROPPED'.padEnd(7)} ${db.name}`)
          } catch (err) {
            console.log(`  ${'SKIP'.padEnd(7)} ${db.name}  drop refused: ${redact(errorMessage(err))}`)
          }
        }
      }
      if (kept) {
        console.log(`  (${kept} worktree database(s) kept — their worktrees are present)`)
      }
      if (protectedCount) {
        console.log(`  (${protectedCount} protected database(s) — ${SHARED_DB}, postgres, template0/1, templates — never touched)`)
      }
      if (ignored) {
        console.log(`  (${ignored} other database(s) have no ${WORKTREE_PREFIX} prefix and were not considered)`)
      }
    })
  } finally {
    await sql.close()
  }
}

function toCandidate(d: Pick<DbRow, 'datname' | 'comment' | 'sessions'>): SweepCandidate {
  return { name: d.datname, comment: d.comment, sessions: d.sessions }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const DEFAULT_GRACE_HOURS = 24

function usage(): never {
  console.error(
    [
      'usage: bun scripts/worktree-db.ts <command>',
      '  status                                 this worktree\'s mode, database and template',
      '  ensure [--opt-in]                      create / migrate this worktree\'s database',
      '  use-isolated | use-shared              choose this worktree\'s database',
      '  reset --yes                            drop and recreate this worktree\'s database',
      '  teardown --yes                         drop this worktree\'s database and forget the opt-in',
      `  sweep [--drop] [--quiet] [--grace-hours N] [db...]`,
      `                                         drop databases of removed worktrees (default: dry run, ${DEFAULT_GRACE_HOURS}h grace)`,
      '  resolve                                machine-readable, for scripts/lib/worktree-db.sh',
    ].join('\n'),
  )
  process.exit(2)
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith('--')))
  const requireYes = () => {
    if (!flags.has('--yes')) {
      console.error(`${command} destroys this worktree's database; re-run with --yes`)
      process.exit(2)
    }
  }
  switch (command) {
    case 'resolve':
      return resolve()
    case 'status':
      return status()
    case 'ensure':
      return ensure(flags.has('--opt-in'))
    case 'use-isolated':
      return setMode('isolated')
    case 'use-shared':
      return setMode('shared')
    case 'reset':
      requireYes()
      return reset()
    case 'teardown':
      requireYes()
      return teardown()
    case 'sweep': {
      let graceHours = DEFAULT_GRACE_HOURS
      const names: string[] = []
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]
        if (arg === '--drop' || arg === '--quiet') continue
        if (arg === '--grace-hours') {
          graceHours = Number(rest[++i])
          if (!Number.isFinite(graceHours) || graceHours < 0) usage()
        } else if (arg.startsWith('--')) {
          usage()
        } else {
          names.push(arg)
        }
      }
      return sweep({ drop: flags.has('--drop'), quiet: flags.has('--quiet'), graceMs: graceHours * 3_600_000, names })
    }
    default:
      usage()
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (err) {
    log(`ERROR: ${redact(errorMessage(err))}`)
    process.exit(err instanceof Unreachable ? EXIT_UNREACHABLE : 1)
  }
}

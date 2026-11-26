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
 *   bun scripts/worktree-db.ts use-shared          opt out (keeps the DB, uses `llamenos`) — refused
 *                                                  for fleet worktrees, and for any linked worktree
 *                                                  unless LLAMENOS_ALLOW_SHARED_DB=1
 *   bun scripts/worktree-db.ts reset --yes         drop + recreate this worktree's DB
 *   bun scripts/worktree-db.ts teardown --yes      drop this worktree's DB, forget the opt-in
 *   bun scripts/worktree-db.ts sweep [--drop] [--quiet] [--grace-hours N] [name...]
 *   bun scripts/worktree-db.ts resolve             machine-readable; used by the bash lib
 *   DATABASE_URL=... bun scripts/worktree-db.ts check-url   refuse a URL this worktree may not use
 *   bun scripts/worktree-db.ts secure-shared [--quiet]       make the shared database read-only to `llamenos`
 *   bun scripts/worktree-db.ts secure-shared --rotate-owner-password   primary only: new owner secret
 *   bun scripts/worktree-db.ts check-boundary              prove it, from the database's side
 *
 * WHO MAY USE THE SHARED DATABASE (#2659). Two fleet workers reset the shared
 * `llamenos` database in one night, both told not to: a prohibition in a brief
 * is a request, and the database was unprotected. So the default is inverted —
 * the shared database is for the operator's primary checkout, and everything
 * else gets its own:
 *
 *   primary checkout      unchanged: its marker, else the shared database with a warning
 *   linked worktree       its own database by default (provisioned on first use). It may
 *                         still choose the shared one, but only with
 *                         LLAMENOS_ALLOW_SHARED_DB=1 in the environment — a deliberate act
 *   fleet worktree        (branch `fleet/...` or directory `llamenos-fleet-...`) its own
 *                         database ALWAYS. No marker, flag or environment variable lifts
 *                         that: the shared database is not reachable through any path this
 *                         repo provides, and `check-url` refuses an explicit URL naming it
 *
 * That is a convention: it binds only the paths that honour it. The DATABASE
 * enforces the boundary underneath it (#2705), with two roles on the dev cluster:
 *
 *   llamenos        the well-known role — PG_PASSWORD, the compose default, every
 *                   documented and hand-typed URL. NOSUPERUSER, CREATEDB, member of
 *                   pg_read_all_data and pg_signal_backend (so `DROP DATABASE ... WITH
 *                   (FORCE)` on its own databases can end an autovacuum worker; it
 *                   still cannot signal a superuser's session). Owns every worktree database and template, so
 *                   it has full rights there; on the shared `llamenos` database it
 *                   can only READ. A write, TRUNCATE, DDL, migration or DROP from it
 *                   fails with "permission denied" / "must be owner" — whoever typed
 *                   the URL, through whatever tool.
 *   llamenos_owner  the cluster's bootstrap superuser, owner of `llamenos`. Its
 *                   password is a random secret in the PRIMARY checkout's git dir
 *                   (ownerSecretPath), never in .env (which every worktree symlinks)
 *                   and never in any default. Only the primary checkout's resolver
 *                   hands out a URL carrying it.
 *
 * `secure-shared` converts a cluster into that shape (idempotent; the launchers
 * run it) and `check-boundary` proves it from the database's side. What it does
 * NOT stop: a process that reads the primary's secret file, or `docker exec`s into
 * the container (local socket connections there are trusted). Those are deliberate
 * escalations, not a hand-typed URL or a bootstrap's default.
 */
import { SQL } from 'bun'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
 * content) plus the runner that applies them and the splitter it cuts each
 * file with, since its idempotency rewrites and statement boundaries are part
 * of what "applying" means. Reading ~55 small files costs
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
  outer.update(
    `splitter\0${sha256(readFileSync(join(root, 'scripts', 'lib', 'migration-statements.ts')))}\n`,
  )
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

// ── Who may use the shared database ──────────────────────────────────────────

/** Set to `1` in the environment to let a NON-fleet linked worktree use the shared database. */
export const ALLOW_SHARED_ENV = 'LLAMENOS_ALLOW_SHARED_DB'

/** The dev Postgres (deploy/docker/docker-compose.dev.yml) listens here. */
const SHARED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const SHARED_PORT = 5432

export interface WorktreeFacts {
  /** True for any worktree made by `git worktree add`; false for the primary checkout. */
  linked: boolean
  /** Short branch name, or null on a detached HEAD. */
  branch: string | null
  /** Final path segment of the worktree root. */
  dirName: string
}

export interface WorktreePolicy {
  linked: boolean
  /** A dispatched fleet worker's worktree: never allowed the shared database. */
  fleet: boolean
}

export function worktreePolicy(facts: WorktreeFacts): WorktreePolicy {
  const fleet =
    facts.linked && ((facts.branch ?? '').startsWith('fleet/') || facts.dirName.startsWith('llamenos-fleet-'))
  return { linked: facts.linked, fleet }
}

export type Mode = 'isolated' | 'shared'
export type ModeSource = 'marker' | 'default' | 'policy' | 'none'

export interface ModeDecision {
  /** `unset` only for a primary checkout that has not chosen. */
  mode: Mode | 'unset'
  /** Where it came from. `default`/`policy` mean no marker says so: the caller provisions and records it. */
  source: ModeSource
}

/**
 * The one decision about which database a worktree uses, from its marker and
 * its policy. Pure, so every row of the table above is a test.
 */
export function decideMode(marker: Mode | null, policy: WorktreePolicy): ModeDecision {
  if (policy.fleet) return { mode: 'isolated', source: marker === 'isolated' ? 'marker' : 'policy' }
  if (marker !== null) return { mode: marker, source: 'marker' }
  if (policy.linked) return { mode: 'isolated', source: 'default' }
  return { mode: 'unset', source: 'none' }
}

/**
 * True when `url` points at a database no worktree owns: the shared dev
 * database, or any other name this tool protects (`postgres`, the templates),
 * on the dev Postgres. A deployed target reached through a tunnel is on another
 * port and is not this.
 */
export function isSharedDatabaseUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false
  if (!SHARED_HOSTS.has(u.hostname.toLowerCase())) return false
  if ((u.port === '' ? SHARED_PORT : Number(u.port)) !== SHARED_PORT) return false
  let name: string
  try {
    name = decodeURIComponent(u.pathname.replace(/^\//, ''))
  } catch {
    return false
  }
  return isProtected(name)
}

export type SharedAccess = { ok: true; note?: string } | { ok: false; reason: string }

/** The role a URL authenticates as, or null when it names none. */
function urlUser(url: string): string | null {
  try {
    const u = new URL(url)
    return u.username ? decodeURIComponent(u.username) : null
  } catch {
    return null
  }
}

/**
 * May a process in this worktree use `url`? Anything that is not the shared
 * dev database is fine. The message never contains the URL (it has a password).
 *
 * An allowed URL to the shared database that authenticates as anything but the
 * owner role carries a `note`: on a secured dev cluster that connection is
 * read-only (#2705), and a writer should hear so before its first INSERT fails.
 */
export function checkSharedAccess(
  url: string,
  policy: WorktreePolicy,
  allowShared: string | undefined,
): SharedAccess {
  if (!isSharedDatabaseUrl(url)) return { ok: true }
  const readOnlyNote =
    urlUser(url) === OWNER_ROLE
      ? undefined
      : `this URL reaches the SHARED dev database as role "${urlUser(url) ?? PG_USER}", which is READ-ONLY there ` +
        `on a secured dev cluster (#2705): reads work; writes, DDL, migrations, resets and drops are refused by ` +
        `the database.${policy.linked ? '' : ` The primary checkout's own URL uses "${OWNER_ROLE}": unset DATABASE_URL to get it.`}`
  if (!policy.linked) return readOnlyNote ? { ok: true, note: readOnlyNote } : { ok: true }
  if (policy.fleet) {
    return {
      ok: false,
      reason:
        'this is a fleet worker worktree and the database is the SHARED dev database. Fleet workers never use it: ' +
        'a peer worker may be mid-run on it. Use your own: unset DATABASE_URL (the dev server and test runners ' +
        'provision llamenos_wt_* for you) or run `bun scripts/worktree-db.ts ensure`.',
    }
  }
  if (allowShared === '1') return readOnlyNote ? { ok: true, note: readOnlyNote } : { ok: true }
  return {
    ok: false,
    reason:
      'this is a linked worktree and the database is the SHARED dev database, which every other worktree and the ' +
      `operator also use. Unset DATABASE_URL to get this worktree's own database, or set ${ALLOW_SHARED_ENV}=1 to ` +
      'use the shared one on purpose — READ-ONLY: only the primary checkout may write it (#2705).',
  }
}

/**
 * The role a URL to the SHARED database authenticates as, for a worktree that
 * resolved to it. Only the primary checkout, and only once it holds the owner
 * secret, gets the owner; everything else gets the well-known role, which a
 * secured cluster makes read-only there. Pure — the table is a test.
 */
export function sharedDatabaseRole(policy: WorktreePolicy, ownerSecretPresent: boolean): string {
  return !policy.linked && ownerSecretPresent ? OWNER_ROLE : PG_USER
}

// ── This worktree ────────────────────────────────────────────────────────────

interface Worktree {
  root: string
  commonDir: string
  /** Per-worktree opt-in marker. Lives in git's per-worktree admin dir, so it
   *  is never tracked and disappears with `git worktree remove`. */
  markerPath: string
  dbName: string
  policy: WorktreePolicy
  /** Where the PRIMARY checkout keeps the owner role's password (see ownerSecretPath). */
  ownerSecretPath: string
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
  const gitDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-dir']))
  const branchResult = Bun.spawnSync(['git', '-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() || null : null
  const policy = worktreePolicy({ linked: gitDir !== commonDir, branch, dirName: basename(root) })
  return { root, commonDir, markerPath, dbName: deriveDatabaseName(root), policy, ownerSecretPath: ownerSecretPath(commonDir) }
}

/**
 * The owner role's password lives in the primary checkout's git dir — the common
 * dir, which for the primary IS its git dir — so it is never tracked, never in the
 * `.env` every worktree symlinks, and no sanctioned path in a linked worktree reads
 * it. Linked worktrees compute the same path only to WRITE it, when they are the
 * first to secure a fresh cluster (secureShared), so the primary inherits it.
 */
export function ownerSecretPath(commonDir: string): string {
  return join(commonDir, OWNER_SECRET_FILE)
}

/** This worktree's database choice: its marker, overridden by its policy. */
function decide(wt: Worktree): ModeDecision {
  return decideMode(readMode(wt), wt.policy)
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
/** A request for the shared database that this worktree's policy forbids (#2659). */
const EXIT_REFUSED = 4

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

interface Credentials {
  user: string
  password: string
}

/** The well-known role, with PG_PASSWORD — what every worktree, and every hand-typed URL, connects as. */
function wellKnown(root: string): Credentials {
  return { user: PG_USER, password: pgPassword(root) }
}

async function connect(root: string, database: string, creds: Credentials = wellKnown(root)): Promise<SQL> {
  const sql = new SQL({
    hostname: PG_HOST,
    port: PG_PORT,
    username: creds.user,
    password: creds.password,
    database,
    max: 1,
    connectionTimeout: 10,
  })
  try {
    await sql.unsafe('SELECT 1')
  } catch (err) {
    await sql.close().catch(() => {})
    if (sqlState(err) === '28P01' && creds.user === PG_USER) {
      throw new Unreachable(
        `password authentication failed for role "${PG_USER}" at ${PG_HOST}:${PG_PORT}. ` +
          'PG_PASSWORD (environment, else .env, else the compose default) is not the password the dev ' +
          "Postgres volume was initialised with — the image only reads POSTGRES_PASSWORD when the " +
          'volume is first created. Set PG_PASSWORD in .env to the password that volume was created ' +
          "with (scripts/dev-bun.sh loads .env over the environment), or change the role's password " +
          `inside the container (ALTER ROLE ${PG_USER} PASSWORD ...).`,
      )
    }
    if (sqlState(err) === '28P01') {
      throw new Error(
        `password authentication failed for role "${creds.user}" at ${PG_HOST}:${PG_PORT}: the secret in ` +
          `${OWNER_SECRET_FILE} is not that role's password. From the primary checkout: ` +
          'bun scripts/worktree-db.ts secure-shared --rotate-owner-password',
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

// ── The shared database's boundary (#2705) ───────────────────────────────────

/** Owns the shared database: the dev cluster's bootstrap superuser. Password: ownerSecretPath(). */
export const OWNER_ROLE = 'llamenos_owner'
/** File name, in the primary checkout's git dir, of the owner role's password. */
export const OWNER_SECRET_FILE = 'llamenos-dev-db-owner'
/**
 * The `cluster_name` the dev Postgres runs with (deploy/docker/docker-compose.dev.yml).
 * secure-shared only ever converts a cluster that names itself this: CI's service
 * containers, the containerised stacks and a deployed database reached through a
 * tunnel all listen on 5432 too, and each keeps its single role.
 */
export const DEV_CLUSTER_NAME = 'llamenos-dev'
/** The signal-notifier sidecar's own database on the dev cluster (it used to write the shared one). */
export const SIGNAL_NOTIFIER_DB = 'signal_notifier'
/** Lives only for the length of a conversion: the bootstrap role cannot rename itself. */
const CONVERSION_ROLE = 'llamenos_secure_tmp'
const GUARD_SCHEMA = 'llamenos_dev_guard'
const GUARD_TRIGGER = 'llamenos_dev_guard_login'
/** Databases that stay the owner's. Every other database on the dev cluster belongs to the well-known role. */
const OWNER_KEEPS = new Set([SHARED_DB, 'postgres', 'template0', 'template1'])
/** check-boundary: the database does not enforce the boundary. */
const EXIT_NOT_IN_FORCE = 5

interface ClusterFacts {
  cluster: string
  /** The well-known role still has every right: the cluster has never been secured. */
  wellKnownIsSuperuser: boolean
  ownerExists: boolean
  wellKnownReads: boolean
}

async function clusterFacts(sql: SQL): Promise<ClusterFacts> {
  const [row] = (await sql.unsafe(
    `SELECT current_setting('cluster_name') AS cluster,
            coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = $1), false) AS "wellKnownIsSuperuser",
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS "ownerExists",
            pg_has_role($1, 'pg_read_all_data', 'MEMBER') AS "wellKnownReads"`,
    [PG_USER, OWNER_ROLE],
  )) as ClusterFacts[]
  return row
}

function readSecret(path: string): string | null {
  try {
    const secret = readFileSync(path, 'utf8').trim()
    return secret === '' ? null : secret
  } catch {
    return null
  }
}

/** A fresh random secret at `path`, mode 0600, written whole or not at all. */
function writeSecret(path: string): string {
  const secret = randomBytes(32).toString('hex')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  return secret
}

/**
 * Hands every object a superuser-owned database holds to the well-known role.
 * REASSIGN OWNED cannot do it: the old owner is the bootstrap superuser, whose
 * system objects REASSIGN refuses to move. Members of an extension, and the
 * sequences, indexes and row types that follow their table, move with it.
 */
const HANDOVER_SQL = `
DO $handover$
DECLARE
  r record;
  from_role oid := (SELECT oid FROM pg_roles WHERE rolname = '${OWNER_ROLE}');
BEGIN
  FOR r IN SELECT n.nspname FROM pg_namespace n
           WHERE n.nspowner = from_role AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
  LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO ${PG_USER}', r.nspname); END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relowner = from_role AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
             AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                             AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
  LOOP
    EXECUTE format(CASE r.relkind WHEN 'S' THEN 'ALTER SEQUENCE %s OWNER TO ${PG_USER}'
                                  WHEN 'v' THEN 'ALTER VIEW %s OWNER TO ${PG_USER}'
                                  WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %s OWNER TO ${PG_USER}'
                                  WHEN 'f' THEN 'ALTER FOREIGN TABLE %s OWNER TO ${PG_USER}'
                                  ELSE 'ALTER TABLE %s OWNER TO ${PG_USER}' END, r.rel);
  END LOOP;
  FOR r IN SELECT t.oid::regtype AS typ FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typowner = from_role AND t.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
             AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
             AND t.typelem = 0 AND t.typcategory <> 'A'
             AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                             AND d.objid = t.oid AND d.deptype IN ('i', 'e'))
  LOOP EXECUTE format('ALTER TYPE %s OWNER TO ${PG_USER}', r.typ); END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.proowner = from_role AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                             AND d.objid = p.oid AND d.deptype = 'e')
  LOOP EXECUTE format('ALTER ROUTINE %s OWNER TO ${PG_USER}', r.fn); END LOOP;
END
$handover$`

/**
 * A NOTICE on every login to the shared database by a role that cannot write it,
 * so the first thing a hand-typed `psql` prints says what the session may do and
 * why — before a write fails with a bare "permission denied". (PostgreSQL 17 login
 * event trigger; it only reads pg_roles, so it cannot fail a login.)
 */
const GUARD_SQL = `
CREATE SCHEMA IF NOT EXISTS ${GUARD_SCHEMA};
CREATE OR REPLACE FUNCTION ${GUARD_SCHEMA}.announce_read_only() RETURNS event_trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) THEN
    RAISE NOTICE 'connected to the SHARED dev database "%" as role "%", which is READ-ONLY here', current_database(), session_user
      USING DETAIL = 'Writes, DDL, migrations, resets and drops are refused by the database (#2705). Only the primary checkout may change it.',
            HINT = 'Use your worktree''s own database: unset DATABASE_URL (the dev server and test runners provision llamenos_wt_* for you).';
  END IF;
END
$guard$;
CREATE EVENT TRIGGER ${GUARD_TRIGGER} ON login EXECUTE FUNCTION ${GUARD_SCHEMA}.announce_read_only();`

const ROLE_COMMENT =
  'Well-known dev role (#2705): owns every worktree database; READ-ONLY on the shared llamenos database, ' +
  'which only llamenos_owner (the primary checkout) may change.'

/**
 * Make the dev cluster enforce the boundary: the well-known role read-only on the
 * shared database, the owner role holding it. Idempotent, and a no-op on any
 * cluster that is not the dev one. Runs under the instance lock, so it never races
 * an ensure or a sweep.
 *
 *   - Never secured (the well-known role is still the bootstrap superuser): any
 *     checkout converts it — doing so only REMOVES rights from a credential every
 *     worktree already holds. The owner secret is written to the primary checkout's
 *     git dir first, so a conversion can never leave an owner nobody can log in as.
 *   - Secured, primary checkout: heals drift with the owner credential (databases
 *     still owned by the owner, the login notice, the well-known role's grants).
 *   - Secured, linked worktree: never touches the owner credential; reports drift.
 */
async function secureShared(opts: { quiet: boolean }): Promise<void> {
  let wt: Worktree
  try {
    wt = currentWorktree()
  } catch (err) {
    log(`cannot determine the worktree (${errorMessage(err)}) — nothing to secure from here`)
    return
  }
  const say = (message: string) => {
    if (!opts.quiet) log(message)
  }
  const sql = await connect(wt.root, 'postgres')
  try {
    await withInstanceLock(sql, async () => {
      const facts = await clusterFacts(sql)
      if (facts.cluster !== DEV_CLUSTER_NAME) {
        say(`not the dev cluster (cluster_name ${JSON.stringify(facts.cluster)}, not "${DEV_CLUSTER_NAME}") — nothing to secure`)
        return
      }
      if (facts.wellKnownIsSuperuser) {
        const owner = await convert(wt, sql, facts)
        await maintain(wt, owner, { quiet: false })
        return
      }
      if (wt.policy.linked) {
        await reportDrift(sql, facts)
        say(`the shared "${SHARED_DB}" database is read-only to "${PG_USER}" (#2705)`)
        return
      }
      const secret = readSecret(wt.ownerSecretPath)
      if (!secret) {
        log(
          `WARNING: the dev cluster is secured (#2705) but this primary checkout holds no "${OWNER_ROLE}" ` +
            `credential (${wt.ownerSecretPath}), so it is READ-ONLY on the shared "${SHARED_DB}" database too — ` +
            `writes, resets and migrations there will be refused. Issue a new one: ` +
            'bun scripts/worktree-db.ts secure-shared --rotate-owner-password',
        )
        return
      }
      await maintain(wt, { user: OWNER_ROLE, password: secret }, opts)
    })
  } finally {
    await sql.close()
  }
}

async function convert(wt: Worktree, sql: SQL, facts: ClusterFacts): Promise<Credentials> {
  if (facts.ownerExists) {
    throw new Error(
      `"${PG_USER}" is a superuser but "${OWNER_ROLE}" also exists — not a state this tool creates (its conversion ` +
        'is one transaction). Refusing to guess which role should own what; inspect it with ' +
        `docker compose -f deploy/docker/docker-compose.dev.yml exec postgres psql -U ${OWNER_ROLE} -d postgres`,
    )
  }
  log(`securing the dev cluster (#2705): "${PG_USER}" becomes read-only on the shared "${SHARED_DB}" database`)
  // A secret already on disk is kept: a volume recreated with `down -v` gets the same owner password.
  const secret = readSecret(wt.ownerSecretPath) ?? writeSecret(wt.ownerSecretPath)
  const [{ pid: ourPid }] = (await sql.unsafe('SELECT pg_backend_pid() AS pid')) as { pid: number }[]

  const tmpPassword = randomBytes(24).toString('hex')
  await sql.unsafe(`DROP ROLE IF EXISTS ${ident(CONVERSION_ROLE)}`)
  await sql.unsafe(`CREATE ROLE ${ident(CONVERSION_ROLE)} SUPERUSER LOGIN PASSWORD ${literal(tmpPassword)}`)
  const tmp = await connect(wt.root, 'postgres', { user: CONVERSION_ROLE, password: tmpPassword })
  try {
    // One transaction: either the old role is the owner AND the new well-known role
    // exists, or nothing changed. Sessions already open keep working throughout.
    await tmp.begin(async (tx) => {
      await tx.unsafe(`ALTER ROLE ${ident(PG_USER)} RENAME TO ${ident(OWNER_ROLE)}`)
      await tx.unsafe(`ALTER ROLE ${ident(OWNER_ROLE)} PASSWORD ${literal(secret)}`)
      await tx.unsafe(
        `CREATE ROLE ${ident(PG_USER)} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS ` +
          `PASSWORD ${literal(pgPassword(wt.root))}`,
      )
      await tx.unsafe(`GRANT pg_read_all_data, pg_signal_backend TO ${ident(PG_USER)}`)
      await tx.unsafe(`COMMENT ON ROLE ${ident(PG_USER)} IS ${literal(ROLE_COMMENT)}`)
    })
  } finally {
    await tmp.close()
  }
  const owner: Credentials = { user: OWNER_ROLE, password: secret }
  const admin = await connect(wt.root, 'postgres', owner)
  try {
    await admin.unsafe(`DROP ROLE ${ident(CONVERSION_ROLE)}`)
    // Every other session opened before the rename was opened with the WELL-KNOWN
    // credential and is now an owner session: a superuser connection held by a
    // worktree's server. Ending them is what makes the boundary immediate rather
    // than "once everything reconnects"; their pools reconnect as the new role.
    const stale = (await admin.unsafe(
      `SELECT pid FROM pg_stat_activity
       WHERE usesysid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND pid NOT IN (pg_backend_pid(), $2)`,
      [OWNER_ROLE, ourPid],
    )) as { pid: number }[]
    for (const s of stale) await admin.unsafe('SELECT pg_terminate_backend($1)', [s.pid])
    if (stale.length) log(`ended ${stale.length} session(s) opened with the old credential; they reconnect as "${PG_USER}"`)
  } finally {
    await admin.close()
  }
  log(`"${OWNER_ROLE}" now owns "${SHARED_DB}"; its password is in ${wt.ownerSecretPath} (primary checkout only)`)
  return owner
}

/** Owner-credential upkeep: idempotent, and silent when there is nothing to do. */
async function maintain(wt: Worktree, owner: Credentials, opts: { quiet: boolean }): Promise<void> {
  const say = (message: string) => {
    if (!opts.quiet) log(message)
  }
  const admin = await connect(wt.root, 'postgres', owner)
  try {
    const [role] = (await admin.unsafe(
      `SELECT rolsuper, rolcreatedb, pg_has_role($1, 'pg_read_all_data', 'MEMBER') AS reads,
              pg_has_role($1, 'pg_signal_backend', 'MEMBER') AS signals
       FROM pg_roles WHERE rolname = $1`,
      [PG_USER],
    )) as { rolsuper: boolean; rolcreatedb: boolean; reads: boolean; signals: boolean }[]
    if (!role) throw new Error(`role "${PG_USER}" does not exist on the dev cluster`)
    if (role.rolsuper || !role.rolcreatedb || !role.reads || !role.signals) {
      await admin.unsafe(`ALTER ROLE ${ident(PG_USER)} NOSUPERUSER CREATEDB`)
      await admin.unsafe(`GRANT pg_read_all_data, pg_signal_backend TO ${ident(PG_USER)}`)
      log(`restored "${PG_USER}": NOSUPERUSER CREATEDB, member of pg_read_all_data and pg_signal_backend`)
    }

    const dbs = (await admin.unsafe(
      `SELECT datname, datistemplate, datallowconn, pg_get_userbyid(datdba) AS owner FROM pg_database ORDER BY datname`,
    )) as { datname: string; datistemplate: boolean; datallowconn: boolean; owner: string }[]
    for (const db of dbs) {
      if (OWNER_KEEPS.has(db.datname) || db.owner === PG_USER) continue
      if (db.datname.startsWith(TEMPLATE_PREFIX) || db.datname.startsWith(BUILD_PREFIX)) {
        // Its objects belong to the owner, so every clone would too. Templates are a
        // content-addressed cache: the next ensure rebuilds this one as the well-known role.
        await admin.unsafe(`ALTER DATABASE ${ident(db.datname)} WITH IS_TEMPLATE false`)
        await withoutSessions(admin, db.datname, `drop ${db.datname}`, () =>
          admin.unsafe(`DROP DATABASE ${ident(db.datname)}`).then(() => {}),
        )
        log(`dropped template ${db.datname} (owned by "${db.owner}"); the next ensure rebuilds it`)
        continue
      }
      if (db.datistemplate || !db.datallowconn) {
        log(`WARNING: ${db.datname} is owned by "${db.owner}" but is a template or refuses connections — left alone`)
        continue
      }
      try {
        const inside = await connect(wt.root, db.datname, owner)
        try {
          await inside.unsafe(`SET lock_timeout = '10s'`)
          await inside.unsafe(HANDOVER_SQL)
        } finally {
          await inside.close()
        }
        await admin.unsafe(`ALTER DATABASE ${ident(db.datname)} OWNER TO ${ident(PG_USER)}`)
        log(`handed ${db.datname} and everything in it to "${PG_USER}" (was "${db.owner}")`)
      } catch (err) {
        log(`WARNING: could not hand ${db.datname} to "${PG_USER}": ${redact(errorMessage(err))} — re-run secure-shared`)
      }
    }
    if (!dbs.some((d) => d.datname === SIGNAL_NOTIFIER_DB)) {
      await admin.unsafe(`CREATE DATABASE ${ident(SIGNAL_NOTIFIER_DB)} OWNER ${ident(PG_USER)}`)
      log(`created ${SIGNAL_NOTIFIER_DB} for the signal-notifier sidecar (it no longer writes the shared database)`)
    }
    if (!dbs.some((d) => d.datname === SHARED_DB)) {
      say(`no "${SHARED_DB}" database yet — nothing to guard`)
      return
    }
  } finally {
    await admin.close()
  }

  const shared = await connect(wt.root, SHARED_DB, owner)
  try {
    const present = (await shared.unsafe('SELECT 1 FROM pg_event_trigger WHERE evtname = $1', [GUARD_TRIGGER])) as unknown[]
    if (present.length === 0) {
      await shared.unsafe(GUARD_SQL)
      log(`installed the read-only login notice on "${SHARED_DB}"`)
    }
  } finally {
    await shared.close()
  }
  say(
    `the shared "${SHARED_DB}" database is read-only to "${PG_USER}"; ` +
      (wt.policy.linked ? `only the primary checkout writes it, as "${OWNER_ROLE}"` : `this primary checkout writes it as "${OWNER_ROLE}"`),
  )
}

/** Linked worktrees never hold the owner credential: say what only the primary can fix. */
async function reportDrift(sql: SQL, facts: ClusterFacts): Promise<void> {
  const held = (await sql.unsafe(
    `SELECT datname FROM pg_database WHERE pg_get_userbyid(datdba) <> $1 ORDER BY datname`,
    [PG_USER],
  )) as { datname: string }[]
  const names = held.map((d) => d.datname).filter((n) => !OWNER_KEEPS.has(n))
  if (names.length || !facts.wellKnownReads) {
    log(
      `WARNING: the dev cluster needs upkeep only the primary checkout can do ` +
        `(${names.length ? `owned by another role, so "${PG_USER}" cannot write them: ${names.join(', ')}` : `"${PG_USER}" lost pg_read_all_data`}). ` +
        'From the primary checkout: bun scripts/worktree-db.ts secure-shared',
    )
  }
}

/**
 * Primary only: a new owner secret, set through the container's local socket
 * (the image trusts it), for a primary that lost its secret or never had it (the
 * cluster was secured from another clone). Written to disk only once Postgres has
 * accepted it.
 */
async function rotateOwnerPassword(): Promise<void> {
  const wt = currentWorktree()
  if (wt.policy.linked) {
    log(`REFUSED: only the primary checkout holds the "${OWNER_ROLE}" credential`)
    process.exit(EXIT_REFUSED)
  }
  const secret = randomBytes(32).toString('hex')
  const compose = join(wt.root, 'deploy', 'docker', 'docker-compose.dev.yml')
  const r = Bun.spawnSync(
    ['docker', 'compose', '-p', 'llamenos-dev', '-f', compose, 'exec', '-T', 'postgres',
      'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', OWNER_ROLE, '-d', 'postgres'],
    { stdin: Buffer.from(`ALTER ROLE ${ident(OWNER_ROLE)} PASSWORD ${literal(secret)};\n`) },
  )
  if (r.exitCode !== 0) {
    throw new Error(`could not set the "${OWNER_ROLE}" password in the dev Postgres container: ${r.stderr.toString().trim()}`)
  }
  const tmp = `${wt.ownerSecretPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600 })
  renameSync(tmp, wt.ownerSecretPath)
  log(`new "${OWNER_ROLE}" password set and written to ${wt.ownerSecretPath}. Restart a running dev server to pick it up.`)
}

interface BoundaryCheck {
  ok: boolean
  what: string
}

/**
 * Prove the boundary from the DATABASE's side, as the well-known role, with no
 * wrapper in between — the path a hand-typed `psql` takes. Every probe that
 * attempts a write runs inside a transaction that is rolled back and touches no
 * row, so it is harmless even on a cluster where the boundary is missing.
 */
async function checkBoundary(): Promise<void> {
  const root = realpathSync(join(import.meta.dir, '..'))
  const checks: BoundaryCheck[] = []
  const sql = await connect(root, 'postgres')
  let facts: ClusterFacts
  try {
    facts = await clusterFacts(sql)
    if (facts.cluster !== DEV_CLUSTER_NAME) {
      console.log(`not the dev cluster (cluster_name ${JSON.stringify(facts.cluster)}) — no boundary is kept here`)
      process.exit(EXIT_NOT_IN_FORCE)
    }
    const [db] = (await sql.unsafe(
      `SELECT pg_get_userbyid(datdba) AS owner,
              has_database_privilege($1, datname, 'CREATE') AS can_create,
              pg_has_role($1, datdba, 'MEMBER') AS owner_member
       FROM pg_database WHERE datname = $2`,
      [PG_USER, SHARED_DB],
    )) as { owner: string; can_create: boolean; owner_member: boolean }[]
    if (!db) {
      console.log(`no "${SHARED_DB}" database on the dev cluster — nothing to check`)
      process.exit(EXIT_NOT_IN_FORCE)
    }
    checks.push({ ok: !facts.wellKnownIsSuperuser, what: `"${PG_USER}" is not a superuser` })
    checks.push({
      ok: !db.owner_member,
      what: `"${PG_USER}" neither owns "${SHARED_DB}" nor is a member of its owner ("${db.owner}") — so DROP/ALTER DATABASE is refused`,
    })
    checks.push({ ok: !db.can_create, what: `"${PG_USER}" may not CREATE schemas in "${SHARED_DB}"` })
  } finally {
    await sql.close()
  }

  const shared = await connect(root, SHARED_DB)
  try {
    const [table] = (await shared.unsafe(
      `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
       WHERE schemaname = 'public' ORDER BY tablename LIMIT 1`,
    )) as { name: string }[]
    if (table) {
      const read = await shared.unsafe(`SELECT 1 FROM ${table.name} LIMIT 1`).then(
        () => true,
        () => false,
      )
      checks.push({ ok: read, what: `"${PG_USER}" can READ ${table.name}` })
      checks.push(await refusedInRollback(shared, `DELETE FROM ${table.name} WHERE false`, `DELETE on ${table.name}`))
    }
    checks.push(await refusedInRollback(shared, 'CREATE TABLE public.llamenos_boundary_probe ()', 'CREATE TABLE in public'))
  } finally {
    await shared.close()
  }

  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.what}`)
  if (checks.every((c) => c.ok)) {
    console.log(`boundary in force: "${PG_USER}" is read-only on the shared "${SHARED_DB}" database`)
    return
  }
  console.log('boundary NOT in force. Secure it: bun scripts/worktree-db.ts secure-shared')
  process.exit(EXIT_NOT_IN_FORCE)
}

/**
 * Two checkouts that start at once on a never-secured cluster: the second waits on
 * the instance lock in a session the first's conversion then ends (it was opened
 * with the old credential). Its retry finds the cluster secured.
 */
async function secureSharedRetrying(opts: { quiet: boolean }): Promise<void> {
  try {
    await secureShared(opts)
  } catch (err) {
    if (sqlState(err) !== '57P01') throw err
    log('session ended by a concurrent conversion — retrying')
    await secureShared(opts)
  }
}

async function refusedInRollback(sql: SQL, statement: string, what: string): Promise<BoundaryCheck> {
  let state: string | undefined
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(statement)
      throw new RollbackProbe()
    })
  } catch (err) {
    state = err instanceof RollbackProbe ? 'allowed' : sqlState(err)
  }
  return { ok: state === '42501', what: `${what} is refused (${state === '42501' ? 'permission denied' : state ?? 'no error'})` }
}

class RollbackProbe extends Error {}

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
  const decision = decide(wt)
  let mode = decision.mode
  // A worktree that has not chosen is switched only when it asked (--opt-in) or its
  // policy chooses for it (#2659): linked worktrees are isolated by default, fleet
  // worktrees by rule. A primary checkout mid-task is never switched silently.
  if (decision.source !== 'marker' && decision.mode === 'isolated') {
    writeMode(wt, 'isolated')
    log(`this worktree uses its own database, ${wt.dbName}.`)
    log(`the shared "${SHARED_DB}" database is untouched; a server already running keeps its database until restarted.`)
  } else if (mode === 'unset' && optIn) {
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

/**
 * Machine-readable for scripts/lib/worktree-db.sh:
 * `<mode> <database> <user> <host> <port> <source>`. `user` is the owner role only
 * for the primary checkout on the shared database, once it holds the owner secret
 * (the shell then reads the password from that file); otherwise the well-known role.
 * `source` is `marker`, `default`, `policy` or `none`; anything but `marker` on an
 * isolated worktree means the database has not been provisioned for it yet, and the
 * caller must run `ensure`.
 */
function resolve(): void {
  let mode: Mode | 'unset' = 'unset'
  let source: ModeSource = 'none'
  let database = SHARED_DB
  let user = PG_USER
  try {
    const wt = currentWorktree()
    const d = decide(wt)
    mode = d.mode
    source = d.source
    if (mode === 'isolated') database = wt.dbName
    else user = sharedDatabaseRole(wt.policy, existsSync(wt.ownerSecretPath))
  } catch (err) {
    // Not inside a git worktree (e.g. an exported tarball): there is no marker to read.
    log(`cannot determine the worktree (${errorMessage(err)}) — treating it as not opted in`)
  }
  console.log(`${mode} ${database} ${user} ${PG_HOST} ${PG_PORT} ${source}`)
}

/**
 * Exit 0 if this worktree may use the database at $DATABASE_URL (or the variable
 * named by `--env`), EXIT_REFUSED with the reason otherwise. The URL travels in the
 * environment, never argv: it carries a password.
 */
function checkUrl(envName: string): void {
  const url = process.env[envName]
  if (!url) {
    log(`ERROR: ${envName} is not set`)
    process.exit(2)
  }
  let policy: WorktreePolicy
  try {
    policy = currentWorktree().policy
  } catch {
    // No git (an exported tree, a CI image): there is no worktree to protect.
    return
  }
  const verdict = checkSharedAccess(url, policy, process.env[ALLOW_SHARED_ENV])
  if (!verdict.ok) {
    log(`REFUSED: ${verdict.reason}`)
    process.exit(EXIT_REFUSED)
  }
  if (verdict.note) log(`NOTE: ${verdict.note}`)
}

async function status(): Promise<void> {
  const wt = currentWorktree()
  const { mode, source } = decide(wt)
  const hash = schemaHash(wt.root)
  const kind = wt.policy.fleet ? 'fleet worktree' : wt.policy.linked ? 'linked worktree' : 'primary checkout'
  console.log(`worktree  ${wt.root}  (${kind})`)
  console.log(
    `mode      ${mode === 'unset' ? 'not chosen — using the SHARED database' : mode}${source === 'policy' || source === 'default' ? `  (${source}: not yet provisioned — ensure creates it)` : ''}  (marker: ${wt.markerPath})`,
  )
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
    const facts = await clusterFacts(sql)
    const owner = wt.policy.linked ? '' : `; owner credential ${existsSync(wt.ownerSecretPath) ? 'present' : 'ABSENT'} (${wt.ownerSecretPath})`
    console.log(
      `boundary  ${
        facts.cluster !== DEV_CLUSTER_NAME
          ? `not the dev cluster (cluster_name ${JSON.stringify(facts.cluster)})`
          : facts.wellKnownIsSuperuser
            ? `NOT in force — "${PG_USER}" is a superuser (bun scripts/worktree-db.ts secure-shared)`
            : `"${PG_USER}" is read-only on "${SHARED_DB}" (prove it: bun scripts/worktree-db.ts check-boundary)`
      }${owner}`,
    )
  } finally {
    await sql.close()
  }
}

async function setMode(mode: Mode): Promise<void> {
  const wt = currentWorktree()
  if (mode === 'shared') {
    const refusal = checkSharedAccess(`postgres://${PG_HOST}:${PG_PORT}/${SHARED_DB}`, wt.policy, process.env[ALLOW_SHARED_ENV])
    if (!refusal.ok) {
      log(`REFUSED use-shared: ${refusal.reason}`)
      process.exit(EXIT_REFUSED)
    }
  }
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
  if (decide(wt).mode !== 'isolated') throw new Error('this worktree is not using its own database — nothing to reset')
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
  log(
    wt.policy.linked
      ? 'opt-in forgotten: the next use of this worktree provisions a fresh database of its own'
      : 'opt-in forgotten: this worktree is back on the shared database (with a warning) until it opts in again',
  )
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
      '  check-url [--env VAR]                  exit 4 if this worktree may not use the database in $VAR (default DATABASE_URL)',
      '  secure-shared [--quiet]                make the shared database read-only to the well-known role (idempotent)',
      '  secure-shared --rotate-owner-password  primary checkout only: issue a new owner credential',
      '  check-boundary                         prove, as the well-known role, that the database enforces it (exit 5 if not)',
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
    case 'check-url': {
      const i = rest.indexOf('--env')
      return checkUrl((i >= 0 ? rest[i + 1] : undefined) || 'DATABASE_URL')
    }
    case 'status':
      return status()
    case 'secure-shared':
      if (flags.has('--rotate-owner-password')) return rotateOwnerPassword()
      return secureSharedRetrying({ quiet: flags.has('--quiet') })
    case 'check-boundary':
      return checkBoundary()
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

#!/usr/bin/env bun
/**
 * Runs the worker integration suite and then asserts that it actually ran.
 *
 * Why this wrapper exists (#1167). `vitest.integration.config.ts` carried
 * `passWithNoTests: true`, so the suite reported success when its `include`
 * glob matched nothing. Combined with no workflow invoking it at all, the nine
 * files under apps/worker/__tests__/integration/ ran NOWHERE while reading as
 * coverage to anyone auditing the repo.
 *
 * Dropping `passWithNoTests` makes an empty glob red, but it does not make a
 * SHRUNK glob red: narrow `include` from the directory to one file and vitest
 * exits 0 with eight files silently gone. Vitest cannot assert "N files ran"
 * from inside its own config — the config is read before collection — so the
 * floor is checked here, from the machine-readable report, after the run.
 *
 * A file that fails to IMPORT is already a failed suite (vitest reports it as
 * such and exits non-zero), so that case needs no floor. The floor is for
 * files that quietly stop being collected.
 *
 * Deliberately takes no arguments: the floor must hold for the one invocation
 * CI and `scripts/test-worker.sh` make. Run `bunx vitest --config
 * vitest.integration.config.ts <file>` directly to work on a single file.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const INTEGRATION_DIR = join(REPO_ROOT, 'apps/worker/__tests__/integration')
const REPORT = join(REPO_ROOT, 'test-results/worker-integration.json')

/**
 * The database the suite runs against, resolved by the same resolver the dev
 * server uses (scripts/lib/worktree-db.sh), never defaulted here.
 *
 * It used to fall back to the shared `llamenos` database, and this wrapper then
 * MIGRATES whatever it resolved — so an unset DATABASE_URL in a worker's shell
 * quietly migrated the shared dev database under every other worktree (#2659).
 * Now: an explicit DATABASE_URL is honoured (CI sets one per job) unless it
 * names the shared dev database and this worktree may not use that; with none
 * set, the worktree gets its own database. The test files read the same
 * DATABASE_URL, so the value is exported into the environment below.
 */
function resolveDatabaseUrl(): string {
  const script =
    'set -euo pipefail; source scripts/lib/worktree-db.sh; worktree_db_export --ensure >&2; printf %s "$DATABASE_URL"'
  const inGit = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT, stdio: 'ignore' }).status === 0
  if (!inGit) {
    const url = process.env.DATABASE_URL
    if (!url) {
      console.error('FATAL: DATABASE_URL is not set and this is not a git checkout, so no worktree database can be resolved.')
      process.exit(1)
    }
    return url
  }
  const r = spawnSync('bash', ['-c', script], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const url = r.stdout?.toString() ?? ''
  if (r.status !== 0 || url === '') {
    console.error('FATAL: could not resolve a database for the integration suite (see the reason above).')
    process.exit(1)
  }
  return url
}

const DATABASE_URL = resolveDatabaseUrl()

/**
 * Lower bound on executed tests. Twenty-seven files contribute 204 on
 * 2026-10-18; the floor sits below that so adding or removing a case is not a
 * chore, but close enough that a FILE dropping out of the run is caught — the
 * two largest contribute 23 and 17, and losing either breaches it. Raise it
 * when the suite grows substantially; never lower it to accommodate a file
 * that stopped running.
 */
const MIN_TESTS = 150

/** Recursively collect *.test.ts paths, relative to `dir`. */
function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath ?? dir, e.name))
}

const onDisk = testFilesUnder(INTEGRATION_DIR)
if (onDisk.length === 0) {
  console.error(`FATAL: no *.test.ts files under ${INTEGRATION_DIR} — the suite has no subject.`)
  process.exit(1)
}

mkdirSync(dirname(REPORT), { recursive: true })

/**
 * Apply every migration to the database at DATABASE_URL before collection.
 *
 * Most files in this suite create a database of their own and migrate it, but
 * not all of them: `ring-requires-clock-in.test.ts` connects straight to
 * DATABASE_URL and scopes its rows instead ("nothing global is truncated"), and
 * every file that does `CREATE DATABASE` connects to this one first to issue
 * it. So the suite's precondition is a database that exists AND has the schema,
 * and nothing was establishing the second half: against the empty `llamenos`
 * database a CI service container hands over, the first query answered
 * `relation "system_settings" does not exist` and took the whole file down
 * (#1167). A developer never saw it because their DATABASE_URL points at a
 * database the dev server has already migrated.
 *
 * `run-migrations.ts` holds an advisory lock and keeps a ledger, so this is
 * idempotent and safe to run against an already-migrated development database:
 * it applies nothing and exits 0. A failure here is fatal — a suite that runs
 * against a half-built schema reports defects that are not there.
 *
 * `--no-env-file` and an explicit `env`: the repo's `.env` must not be able to
 * redirect this at a different database from the one the tests will use. Same
 * invocation the test files make.
 */
const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
  cwd: REPO_ROOT,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL },
  stdio: 'inherit',
  timeout: 300_000,
})
if (migrate.status !== 0) {
  console.error(
    `\nFATAL: could not migrate the suite's database. The integration tier needs the schema ` +
    'present at DATABASE_URL — both for the files that query it directly and for the ones ' +
    'that connect to it to CREATE DATABASE. Running the suite against an unmigrated database ' +
    'produces "relation ... does not exist" failures that look like product defects.',
  )
  process.exit(1)
}

const run = spawnSync(
  'bunx',
  [
    'vitest', 'run',
    '--config', 'vitest.integration.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
  ],
  { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL } },
)

// Read the report even on failure: the floor below reports WHICH files ran,
// which is the diagnostic that matters when the suite breaks.
let report: {
  numTotalTests?: number
  testResults?: { name: string; status?: string; assertionResults?: unknown[] }[]
} | null = null
try {
  report = JSON.parse(readFileSync(REPORT, 'utf-8'))
} catch (e) {
  console.error(`\nFATAL: could not read the vitest JSON report at ${REPORT}: ${(e as Error).message}`)
  console.error('Without it there is no evidence the suite ran at all, so this is a failure')
  console.error('regardless of vitest\'s own exit code.')
  process.exit(1)
}

const ran = report?.testResults ?? []
const ranPaths = new Set(ran.map((r) => resolve(REPO_ROOT, r.name)))
const totalTests = report?.numTotalTests ?? 0

console.log('\n── integration suite floor ─────────────────────────────')
for (const r of ran) {
  const n = r.assertionResults?.length ?? 0
  console.log(`  ${r.status === 'passed' ? 'ok  ' : 'FAIL'} ${r.name.replace(`${REPO_ROOT}/`, '')} — ${n} test(s)`)
}
const missed = onDisk.filter((f) => !ranPaths.has(f))
for (const f of missed) {
  console.log(`  MISS ${f.replace(`${REPO_ROOT}/`, '')} — on disk but NOT collected`)
}
console.log(
  `  files: ${ran.length} collected / ${onDisk.length} on disk · tests: ${totalTests} (floor ${MIN_TESTS})`,
)
console.log('────────────────────────────────────────────────────────')

let floorFailed = false
if (missed.length > 0) {
  console.error(
    `\nFLOOR BREACHED: ${missed.length} file(s) exist under ${INTEGRATION_DIR.replace(`${REPO_ROOT}/`, '')} ` +
    "but were not collected. The include glob in vitest.integration.config.ts no longer covers the suite.",
  )
  floorFailed = true
}
if (totalTests < MIN_TESTS) {
  console.error(
    `\nFLOOR BREACHED: ${totalTests} test(s) ran, expected at least ${MIN_TESTS}. ` +
    'Either files stopped being collected or cases were removed. ' +
    'Do not lower MIN_TESTS to make this pass.',
  )
  floorFailed = true
}

// vitest's own verdict still decides a normal run; the floor can only ADD a
// failure, never clear one.
process.exit(run.status !== 0 || floorFailed ? 1 : 0)

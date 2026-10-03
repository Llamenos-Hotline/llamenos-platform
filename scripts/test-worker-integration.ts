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
 * Lower bound on executed tests. Nine files contribute 73 on 2026-10-03; the
 * floor sits below that so adding or removing a case is not a chore, but far
 * enough above zero that a file dropping out of the run is caught. Raise it
 * when the suite grows substantially; never lower it to accommodate a file
 * that stopped running.
 */
const MIN_TESTS = 60

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

const run = spawnSync(
  'bunx',
  [
    'vitest', 'run',
    '--config', 'vitest.integration.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' },
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

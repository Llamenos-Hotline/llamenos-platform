/**
 * Rail for the false-signal generator fixed alongside this file.
 *
 * `tests/db-helpers.ts` used to read:
 *
 *   const databaseUrl = process.env.DATABASE_URL || 'postgres://llamenos:dev@localhost:5432/llamenos'
 *   const sql = postgres(databaseUrl, { ... })
 *
 * Three defects in two lines:
 *
 *   1. The fallback meant an unset DATABASE_URL silently pointed TestDB at the
 *      shared dev database. A worker once pointed the SERVER at a scratch
 *      database while TestDB fell through to the shared one — both "worked",
 *      asserting against different data, and three scenarios appeared to
 *      regress. A correct fix was nearly abandoned over it.
 *   2. The client was constructed at IMPORT time, freezing the URL the moment
 *      any step file imported the module.
 *   3. Nothing ever asserted that TestDB and the server share a database. That
 *      is the actual invariant, and it was the one that broke.
 *
 * This rail keeps all three closed. It is static analysis on purpose: it must
 * hold without a database or a server running.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = resolve(TESTS_DIR, '..')

const dbHelpers = readFileSync(resolve(TESTS_DIR, 'db-helpers.ts'), 'utf8')
const dbIdentity = readFileSync(resolve(TESTS_DIR, 'db-identity.ts'), 'utf8')
const devRoutes = readFileSync(resolve(REPO_ROOT, 'apps/worker/routes/dev.ts'), 'utf8')
const identityScript = readFileSync(resolve(REPO_ROOT, 'scripts/check-db-identity.ts'), 'utf8')
const bddRunner = readFileSync(resolve(REPO_ROOT, 'scripts/test-backend-bdd.sh'), 'utf8')
const dbResolver = readFileSync(resolve(REPO_ROOT, 'scripts/lib/worktree-db.sh'), 'utf8')

/** Every harness file that sends an X-Test-Secret header. */
const SECRET_SENDERS = [
  'tests/api-helpers.ts',
  'tests/helpers.ts',
  'tests/global-setup.ts',
  'tests/db-identity.ts',
  'tests/simulation-helpers.ts',
  'tests/bootstrap.spec.ts',
  'tests/screenshots.spec.ts',
  'tests/steps/backend/error-disclosure.steps.ts',
  'tests/steps/backend/network-security.steps.ts',
  'tests/steps/backend/push-hub-dispatch.steps.ts',
]

/** Strip block and line comments so prose about the old bug is not a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

test.describe('db-helpers database identity rail', () => {
  for (const [label, src] of [
    ['tests/db-helpers.ts', dbHelpers],
    ['tests/db-identity.ts', dbIdentity],
    ['scripts/check-db-identity.ts', identityScript],
  ] as const) {
    test(`${label} contains no hardcoded connection string`, () => {
      const code = stripComments(src)
      const matches = code.match(/postgres(?:ql)?:\/\/[^\s'"`]*/g) ?? []
      expect(
        matches,
        'none of these may embed a connection string. A fallback URL lets the runner ' +
          'silently query a different database than the server under test, which makes ' +
          'every direct-DB assertion meaningless.',
      ).toEqual([])
    })
  }

  test('db-helpers.ts fails loudly when DATABASE_URL is unset', () => {
    const code = stripComments(dbHelpers)
    expect(code).toContain('process.env.DATABASE_URL')
    // No `||` / `??` default on the env read.
    expect(code).not.toMatch(/process\.env\.DATABASE_URL\s*(\|\||\?\?)/)
    expect(code, 'an unset DATABASE_URL must throw, not fall back').toMatch(
      /if\s*\(!url\)\s*\{[\s\S]*throw new Error/,
    )
  })

  test('the postgres client is created lazily, not at import time', () => {
    const code = stripComments(dbHelpers)
    // A top-level `const <name> = postgres(` is the eager construction that
    // froze the URL at import. The client must be built inside a function.
    expect(code, 'the connection must be opened on first use, not at module load').not.toMatch(
      /^(const|let|var)\s+\w+\s*=\s*postgres\(/m,
    )
    expect(code).toMatch(/function\s+rawSql\s*\(/)
  })

  test('every TestDB query goes through the identity-checked accessor', () => {
    const code = stripComments(dbHelpers)
    // `rawSql()` bypasses the check by design (the check itself uses it, and so
    // does close()). Anything else reaching the driver must use `sql()`.
    const bypasses = [...code.matchAll(/^\s*(?:const .*=\s*)?await rawSql\(\)/gm)]
    expect(
      bypasses.length,
      'rawSql() skips the shared-database check — only runIdentityCheck() may call it',
    ).toBeLessThanOrEqual(1)
    expect(code).toMatch(/async function sql\s*\([\s\S]*?assertSharedDatabase\(\)/)
  })

  test('the identity endpoint stays under the dev-only /test-* guard', () => {
    // apps/worker/app.ts applies devGuard (ENVIRONMENT=development +
    // DEV_ROUTES_ENABLED=true) to `/test-*` only. Renaming this route out of
    // that prefix would expose it in production.
    expect(devRoutes, 'the db-identity route must live under the /test-* prefix').toContain(
      "dev.get('/test-db-identity'",
    )
    expect(devRoutes).toMatch(
      /dev\.get\('\/test-db-identity',[\s\S]{0,200}?simulationGuard\(c\)/,
    )
    expect(dbIdentity).toContain("'/api/test-db-identity'")
  })

  test('the identity endpoint exposes no credentials', () => {
    const handler = devRoutes.slice(devRoutes.indexOf("dev.get('/test-db-identity'"))
    const body = handler.slice(0, handler.indexOf('\n})'))
    expect(body, 'never return the connection URL').not.toMatch(/\bDATABASE_URL\b\s*,/)
    expect(body).not.toMatch(/password|\.username\b|\bpassword\b/i)
    // The only URL-derived values returned are host and port.
    expect(body).toContain('resolvedHost')
    expect(body).toContain('resolvedPort')
  })
})

/**
 * The deployed-target half of the same invariant.
 *
 * Against a deployment the mismatch is the DEFAULT, not an accident: the
 * deployed PostgreSQL publishes no host port, so a run pointed at a remote
 * TEST_HUB_URL with an unset DATABASE_URL would resolve a LOCAL database and
 * assert against the control node's own data. That is the worst shape of the
 * bug the rail above exists for — a green suite that proved nothing about the
 * deployment — so the runner must refuse it rather than resolve one.
 *
 * Static analysis on purpose, like the rail above: it must hold with no
 * database, no server and no deployment in reach.
 */
test.describe('deployed-target database rail', () => {
  test('the runner requires an explicit DATABASE_URL whenever it is pointed at a server', () => {
    // Derived from TEST_HUB_URL alone. A hostname heuristic gets the common
    // deployed case wrong (an SSH forward puts the deployment on 127.0.0.1),
    // and a separate flag can disagree with the URL.
    expect(
      bddRunner,
      'the explicit-target branch must call worktree_db_export --require-explicit',
    ).toMatch(/if \[\[ -n "\$\{TEST_HUB_URL:-\}" \]\]; then[\s\S]{0,600}?worktree_db_export --require-explicit/)

    // No hostname sniffing: that is the heuristic this replaced.
    expect(
      bddRunner,
      'classifying the target by hostname silently takes the local path for a tunnelled deployment',
    ).not.toMatch(/localhost\|127\.0\.0\.1/)

    // And the resolver must actually honour it by refusing, not by warning.
    const guard = dbResolver.slice(dbResolver.indexOf('--require-explicit"'))
    expect(
      guard,
      'worktree-db.sh must return non-zero for --require-explicit with no DATABASE_URL',
    ).toMatch(/--require-explicit"?\s*\]\]; then[\s\S]{0,1200}?return 1/)
  })

  test('the identity check is its own step, before anything slow or destructive', () => {
    const idStep = bddRunner.indexOf('reporter_run_step "db-identity"')
    const bddgen = bddRunner.indexOf('reporter_run_step "bddgen"')
    const bootstrap = bddRunner.indexOf('reporter_run_step "api-bootstrap"')
    const bdd = bddRunner.indexOf('reporter_run_step "backend-bdd"')
    expect(idStep, 'the runner has no db-identity step').toBeGreaterThan(-1)
    // Before bddgen, which takes minutes: a run aimed at the wrong database
    // should fail in seconds, not after generating every feature file first.
    expect(idStep, 'db-identity must run before bddgen').toBeLessThan(bddgen)
    expect(idStep, 'db-identity must run before api-bootstrap resets anything').toBeLessThan(bootstrap)
    expect(idStep, 'db-identity must run before the suite').toBeLessThan(bdd)
    expect(bddRunner).toContain('bun scripts/check-db-identity.ts')
  })

  test('a failed identity check stops the run — it is never a warning', () => {
    const step = bddRunner.slice(bddRunner.indexOf('reporter_run_step "db-identity"'))
    const block = step.slice(0, step.indexOf('\nfi\n') + 4)
    expect(block).toContain('exit 1')
    expect(block, 'a mismatch must not be downgraded to a pass').not.toMatch(/overall_result="pass"/)
  })

  test('the identity script and db-helpers share ONE comparison', () => {
    // Two copies is how the invariant drifts; both must import it.
    expect(identityScript).toMatch(/import\s*\{[^}]*assertSameDatabase[^}]*\}\s*from\s*'\.\.\/tests\/db-identity'/)
    expect(dbHelpers).toMatch(/import\s*\{[^}]*assertSameDatabase[^}]*\}\s*from\s*'\.\/db-identity'/)
    expect(stripComments(dbIdentity)).toMatch(/export async function assertSameDatabase/)
  })

  test('the identity script fails loudly rather than exiting 0 on any error path', () => {
    const code = stripComments(identityScript)
    expect(code).toMatch(/function fail\([\s\S]*?process\.exit\(1\)/)
    // An unset DATABASE_URL and an unreachable database are both failures.
    expect(code).toMatch(/if \(!databaseUrl\)/)
    expect(code).toMatch(/catch \(err\)[\s\S]{0,400}?fail\(/)
    expect(code, 'never swallow a mismatch').not.toMatch(/process\.exit\(0\)/)
  })

  test('neither the runner nor the script ever echoes DATABASE_URL', () => {
    // It carries PG_PASSWORD. worktree-db.sh has a redactor for the one place
    // that needs to name it at all.
    expect(stripComments(identityScript)).not.toMatch(/console\.log\([^)]*databaseUrl/)
    expect(stripComments(identityScript)).not.toMatch(/write\([^)]*databaseUrl/)
    expect(bddRunner).not.toMatch(/echo[^\n]*\$\{?DATABASE_URL/)
  })
})

/**
 * The dev-surface secret must be resolved in exactly one place.
 *
 * It was resolved three ways: some files accepted either env var, some read
 * only `DEV_RESET_SECRET`. A run that exported only `E2E_TEST_SECRET` — which
 * the runner documents as sufficient — therefore sent the harness DEFAULT from
 * `tests/simulation-helpers.ts`, and the gate answered 404. Measured against a
 * deployed staging target: five scenarios failed as "Simulation endpoint
 * incoming-call failed (404)" while every other call to the same surface
 * worked. A wrong secret is indistinguishable from an absent route by design
 * (apps/worker/lib/dev-surfaces.ts), which is precisely why a second
 * resolution is so expensive to debug.
 */
test.describe('dev-surface secret rail', () => {
  for (const file of SECRET_SENDERS) {
    test(`${file} resolves the secret through the shared helper`, () => {
      const src = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'))
      expect(
        src,
        `${file} must not read DEV_RESET_SECRET / E2E_TEST_SECRET itself — ` +
          'import devSurfaceSecret() from tests/dev-surface-secret.ts',
      ).not.toMatch(/process\.env\.(DEV_RESET_SECRET|E2E_TEST_SECRET)\s*(\|\||\?\?)/)
      expect(src, `${file} must import devSurfaceSecret`).toContain('devSurfaceSecret')
    })
  }

  test('the shared helper is the only thing that names a default secret', () => {
    for (const file of SECRET_SENDERS) {
      const src = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'))
      expect(src, `${file} must not hardcode the harness default secret`).not.toContain(
        "'test-reset-secret'",
      )
    }
    const helper = readFileSync(resolve(TESTS_DIR, 'dev-surface-secret.ts'), 'utf8')
    expect(helper).toContain("LOCAL_DEV_SECRET_DEFAULT = 'test-reset-secret'")
  })
})

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
const devRoutes = readFileSync(resolve(REPO_ROOT, 'apps/worker/routes/dev.ts'), 'utf8')

/** Strip block and line comments so prose about the old bug is not a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

test.describe('db-helpers database identity rail', () => {
  test('db-helpers.ts contains no hardcoded connection string', () => {
    const code = stripComments(dbHelpers)
    const matches = code.match(/postgres(?:ql)?:\/\/[^\s'"`]*/g) ?? []
    expect(
      matches,
      'tests/db-helpers.ts must never embed a connection string. A fallback URL lets ' +
        'TestDB silently query a different database than the server under test, which ' +
        'makes every direct-DB assertion meaningless.',
    ).toEqual([])
  })

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
    expect(dbHelpers).toContain("'/api/test-db-identity'")
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

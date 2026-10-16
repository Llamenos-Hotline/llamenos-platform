#!/usr/bin/env bun
/**
 * Pipeline step: prove the test runner's DATABASE_URL and the server at
 * TEST_HUB_URL are the SAME PostgreSQL database — before the suite starts.
 *
 * Why a step of its own, rather than leaving it to the first TestDB query:
 *
 *   - Against a DEPLOYED target the mismatch is the default, not the
 *     exception. The deployed PostgreSQL publishes no host port, so a run with
 *     an unset DATABASE_URL silently resolves the control node's own database
 *     and every direct-database assertion then passes or fails for reasons
 *     that have nothing to do with the deployment.
 *   - `tests/db-helpers.ts` only checks on its FIRST query, so a run whose
 *     scenarios happen not to touch TestDB never checks at all, and a run that
 *     does fails deep inside an unrelated scenario.
 *
 * Exits 0 when the two agree, non-zero with both identities named when they do
 * not. Never "passes with a warning": `tests/db-helpers.ts` and this script
 * call the same `assertSameDatabase` in `tests/db-identity.ts`.
 *
 * Usage (DATABASE_URL and TEST_HUB_URL from the environment):
 *   bun scripts/check-db-identity.ts
 *
 * Never prints DATABASE_URL — it carries PG_PASSWORD. Only the database name,
 * the instance id and the host/port the server resolved are reported.
 */
import postgres from 'postgres'
import { assertSameDatabase, serverBaseUrl, testSecret, DbIdentityError } from '../tests/db-identity'

function fail(message: string): never {
  process.stderr.write(`[check-db-identity] ${message}\n`)
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  fail(
    'DATABASE_URL is not set.\n' +
      'The suite asserts persisted state straight from PostgreSQL, so it must be told\n' +
      'which database the server under test writes to. There is no default on purpose:\n' +
      'a fallback would point the runner at a local database while the server used\n' +
      'another, which is the false green this check exists to prevent.',
  )
}

const baseUrl = serverBaseUrl()
const sql = postgres(databaseUrl, { connect_timeout: 10, max: 1, onnotice: () => {} })

try {
  const server = await assertSameDatabase(sql, baseUrl, testSecret())
  process.stdout.write(
    `[check-db-identity] OK — runner and ${baseUrl} share database "${server.database}" ` +
      `(instance ${server.instanceId}${server.serverAddr ? `, server ${server.serverAddr}:${server.serverPort}` : ''}).\n`,
  )
} catch (err) {
  if (err instanceof DbIdentityError) fail(err.message)
  fail(
    'Could not connect to DATABASE_URL.\n' +
      'Against a deployed target this normally means the tunnel to its PostgreSQL is not\n' +
      'up — see docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md.\n' +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
  )
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}

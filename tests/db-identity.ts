/**
 * "Is TestDB looking at the same database as the server under test?"
 *
 * This is the one invariant that makes every direct-database assertion in
 * `tests/db-helpers.ts` mean anything, and it is the invariant that broke:
 * a worker once pointed the SERVER at a scratch database while TestDB fell
 * through to the shared one, both "worked", and three scenarios appeared to
 * regress (see `tests/db-helpers-identity-rail.spec.ts`).
 *
 * It matters even more when the target is DEPLOYED. The deployed PostgreSQL
 * publishes no host port, so a run pointed at `TEST_HUB_URL=https://<staging>`
 * with an unset `DATABASE_URL` would resolve a LOCAL database and assert
 * against the control node's own data — a green suite that proved nothing
 * about the deployment. `scripts/check-db-identity.ts` runs this check as its
 * own step BEFORE the suite starts, so that run fails immediately and says
 * which two databases disagreed, instead of failing later inside whichever
 * scenario happened to touch TestDB first.
 *
 * Identity is `current_database()` + the postmaster start time. That pair is
 * stable regardless of the network path taken to reach the instance, so a
 * server inside Docker (`postgres:5432`) and a runner on the host
 * (`localhost:5432`, or an SSH forward to a deployed host) correctly compare
 * EQUAL when they share a database and UNEQUAL when they do not.
 */
import type { Sql } from 'postgres'
import { devSurfaceSecret } from './dev-surface-secret'

export interface DbIdentity {
  database: string
  instanceId: string
}

export interface ServerDbIdentity extends DbIdentity {
  serverAddr: string | null
  serverPort: number | null
  resolvedHost: string | null
  resolvedPort: number | null
}

/**
 * The server's dev-only identity endpoint. Gated by the `/test-*` surface
 * (`apps/worker/lib/dev-surfaces.ts`): an environment on the allowlist,
 * `DEV_ROUTES_ENABLED=true`, a shared secret on anything but `development`,
 * and a matching `X-Test-Secret` header.
 */
export const IDENTITY_PATH = '/api/test-db-identity'

export class DbIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbIdentityError'
  }
}

export function serverBaseUrl(): string {
  return (process.env.TEST_HUB_URL || 'http://localhost:3000').replace(/\/+$/, '')
}

export function testSecret(): string {
  return devSurfaceSecret()
}

function formatIdentity(id: DbIdentity, extra: Record<string, unknown> = {}): string {
  const parts = [`database=${id.database}`, `instance=${id.instanceId}`]
  for (const [k, v] of Object.entries(extra)) {
    if (v !== null && v !== undefined) parts.push(`${k}=${v}`)
  }
  return parts.join(' ')
}

/**
 * Ask the server which database IT is writing to.
 *
 * An unreachable server or an absent endpoint is a HARD failure, never a skip:
 * a check that quietly passes when its dependency is down is exactly the false
 * signal this exists to replace.
 */
export async function fetchServerDbIdentity(
  baseUrl = serverBaseUrl(),
  secret = testSecret(),
): Promise<ServerDbIdentity> {
  const endpoint = `${baseUrl}${IDENTITY_PATH}`

  let res: Response
  try {
    res = await fetch(endpoint, { headers: { 'X-Test-Secret': secret } })
  } catch (err) {
    throw new DbIdentityError(
      `Could not reach the server's database-identity endpoint at ${endpoint}.\n` +
        'Without it nothing can prove the suite is querying the same database as the\n' +
        'server, so its direct-database assertions would be meaningless. Start the server\n' +
        'under test (bun run dev:server) or set TEST_HUB_URL to its base URL.\n' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!res.ok) {
    throw new DbIdentityError(
      `${endpoint} returned ${res.status}.\n` +
        'That endpoint is part of the dev surface: the server needs ENVIRONMENT on the\n' +
        'allowlist (development or staging), DEV_ROUTES_ENABLED=true, a DEV_RESET_SECRET of\n' +
        'at least 32 characters when the environment is not development, and this request\n' +
        'needs a matching X-Test-Secret (DEV_RESET_SECRET / E2E_TEST_SECRET).\n' +
        'See apps/worker/lib/dev-surfaces.ts and docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md.',
    )
  }

  return (await res.json()) as ServerDbIdentity
}

/** Ask the local connection which database IT is reading. */
export async function fetchLocalDbIdentity(sql: Sql): Promise<DbIdentity> {
  const rows = await sql`
    SELECT current_database() AS database,
           extract(epoch from pg_postmaster_start_time())::text AS instance_id
  `
  const row = rows[0] as { database: string; instance_id: string }
  return { database: row.database, instanceId: row.instance_id }
}

/**
 * Throw unless `sql` and the server at `baseUrl` are the same PostgreSQL
 * database. Never returns a boolean — there is no caller for whom "they
 * differ" is a recoverable condition.
 */
export async function assertSameDatabase(
  sql: Sql,
  baseUrl = serverBaseUrl(),
  secret = testSecret(),
): Promise<ServerDbIdentity> {
  const server = await fetchServerDbIdentity(baseUrl, secret)
  const local = await fetchLocalDbIdentity(sql)

  if (local.database !== server.database || local.instanceId !== server.instanceId) {
    throw new DbIdentityError(
      'DATABASE MISMATCH — the test runner and the server under test are using\n' +
        'DIFFERENT databases. Any direct-database assertion would pass or fail for\n' +
        'reasons unrelated to the code under test.\n' +
        `  Runner (DATABASE_URL):        ${formatIdentity(local)}\n` +
        `  Server (${baseUrl}${IDENTITY_PATH}): ${formatIdentity(server, {
          serverAddr: server.serverAddr,
          serverPort: server.serverPort,
          resolvedHost: server.resolvedHost,
          resolvedPort: server.resolvedPort,
        })}\n` +
        'Point DATABASE_URL at the same database the server writes to. Against a\n' +
        'DEPLOYED target that means a tunnel to its PostgreSQL — see\n' +
        'docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md. Do NOT "fix" this by letting the\n' +
        'runner fall back to a local database: that is the false green this check exists\n' +
        'to prevent.',
    )
  }
  return server
}

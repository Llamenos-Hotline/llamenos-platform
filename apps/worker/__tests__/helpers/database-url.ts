/**
 * The database a worker integration test runs against — required, never defaulted.
 *
 * About sixty integration test files used to read
 * `process.env.DATABASE_URL ?? '<shared dev database URL>'`. A default that
 * supplies what the environment was supposed to provide cannot fail when the
 * isolation is missing: it quietly succeeds against the SHARED dev database
 * `llamenos`, which every worktree on the machine uses, and a green run is then
 * read as proof the isolation worked (#2704; the same database was reset out from
 * under a peer worker mid-run in #2659).
 *
 * The runners — `bun run test:worker:integration` and
 * `bun run test:worker:integration-bun` — resolve the database through the one
 * resolver (scripts/lib/worktree-db.sh) and export it as DATABASE_URL, refusing the
 * shared database for a fleet worker. A test file run any other way has no such
 * guarantee, so it fails here, naming the fix.
 *
 * This deliberately reads the environment and nothing else: it must not grow a
 * fallback, and it must not name a database.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Worker integration tests never fall back to a default ' +
        'database (#2704). Run them through `bun run test:worker:integration` or ' +
        '`bun run test:worker:integration-bun`, which resolve this worktree\'s own ' +
        'database, or export DATABASE_URL to a database you own.',
    )
  }
  return url
}

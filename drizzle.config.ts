import { defineConfig } from 'drizzle-kit'

// No default database. This file used to fall back to the shared dev database
// (`llamenos` on localhost:5432), so a bare `drizzle-kit push` or `studio` — with
// DATABASE_URL unset, as a fresh worktree or worker shell has it — reached for the
// database every other worktree is running against (#2659).
//
// Credentials are supplied only when DATABASE_URL is set. The commands that need a
// database (`push`, `pull`, `studio`, `migrate`) then fail inside drizzle-kit for want
// of credentials, while the offline ones (`check`, `up`) keep working without one.
// Apply migrations with `bun run db:migrate`, not through this file.
const url = process.env.DATABASE_URL

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/worker/db/schema/*.ts',
  out: './drizzle/migrations',
  ...(url ? { dbCredentials: { url } } : {}),
})

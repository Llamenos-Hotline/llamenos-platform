#!/usr/bin/env bun
/**
 * db-generate.ts — write the next migration (`bun run db:generate --name <what>`).
 *
 * Replaces `drizzle-kit generate`, which cannot be used on this tree: it
 * numbers files from `_journal.json` and aborts as soon as two snapshots share
 * a parent, which is the normal state of main once two migration PRs have
 * both landed (#2391, scripts/lib/migration-graph.ts).
 *
 * What it writes, both named after the current UTC time:
 *
 *   drizzle/migrations/YYYYMMDDHHMMSS_<name>.sql
 *       the SQL that takes the schema this tree's migrations build (the merge
 *       of the snapshot heads) to the schema it declares
 *       (apps/worker/db/schema/*.ts). drizzle-kit's own differ writes it, and
 *       asks about ambiguous renames exactly as `drizzle-kit generate` does.
 *   drizzle/migrations/meta/YYYYMMDDHHMMSS_snapshot.json
 *       the declared schema, with `prevIds` naming every head it was
 *       generated on.
 *
 * The name never has to change. Another branch's migration landing first does
 * not invalidate it: that migration is a second head, the drift check merges
 * the two, and `migration:order` proves they commute in a real database.
 *
 *   --custom   Write an empty SQL file for a hand-written migration. Its
 *              snapshot still records the schema the tree declares, so put the
 *              schema change in apps/worker/db/schema/ first and write the SQL
 *              that makes it real.
 */
import { generateMigration } from 'drizzle-kit/api'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { declaredSchemaSnapshot } from './lib/drizzle-schema'
import { MigrationGraph, ORIGIN_ID, prefixOf } from './lib/migration-graph'
import { STATEMENT_BREAKPOINT } from './lib/migration-statements'

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations')
const META_DIR = join(MIGRATIONS_DIR, 'meta')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** UTC YYYYMMDDHHMMSS, the same format as drizzle-kit's `prefix: 'timestamp'`. */
export function timestampPrefix(at: Date): string {
  return at.toISOString().replace(/\D/g, '').slice(0, 14)
}

/**
 * A prefix that sorts after every migration and snapshot already in the
 * tree, so a new file can never sort before one of its own parents — even if
 * this machine's clock is behind the one that wrote the newest file.
 */
export function nextPrefix(now: Date, existing: string[]): string {
  const newest = existing.filter((p) => /^\d{14}$/.test(p)).sort().at(-1)
  let at = now
  while (newest !== undefined && timestampPrefix(at) <= newest) at = new Date(at.getTime() + 1000)
  return timestampPrefix(at)
}

async function main() {
  const name = arg('--name')
  const custom = process.argv.includes('--custom')
  if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    fail('Usage: bun run db:generate --name <lower_snake_case_description> [--custom]')
  }

  const graph = MigrationGraph.load(META_DIR)
  if (graph.problems.length > 0) {
    fail(`drizzle/migrations/meta is inconsistent; fix this first:\n  ${graph.problems.join('\n  ')}`)
  }
  const { heads, schema: built, conflicts } = graph.state()
  if (conflicts.length > 0) {
    fail(
      'The snapshot heads conflict, so this tree has no single schema to generate from:\n  ' +
        `${conflicts.join('\n  ')}\nTwo migrations changed the same thing differently; resolve that first.`,
    )
  }

  const declared = await declaredSchemaSnapshot()
  const statements = custom
    ? []
    : await generateMigration(
        { ...built, id: heads[0]?.id ?? ORIGIN_ID, prevId: ORIGIN_ID } as never,
        declared as never,
      )
  if (!custom && statements.length === 0) {
    console.log('No schema changes: the declared schema is what the migrations already build.')
    return
  }

  const existing = [
    ...readdirSync(MIGRATIONS_DIR),
    ...(existsSync(META_DIR) ? readdirSync(META_DIR) : []),
  ].flatMap((f) => prefixOf(f) ?? [])
  const prefix = nextPrefix(new Date(), existing)
  const tag = `${prefix}_${name}`

  const { id: _id, prevId: _prevId, ...body } = declared
  const snapshot = {
    id: randomUUID(),
    prevId: heads[0]?.id ?? ORIGIN_ID,
    prevIds: heads.map((h) => h.id),
    ...body,
  }
  const sql = custom
    ? `-- ${tag}: hand-written migration. Separate statements with a line reading\n-- ${STATEMENT_BREAKPOINT}\n`
    : `${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`

  writeFileSync(join(META_DIR, `${prefix}_snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`)
  writeFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), sql)
  console.log(`Wrote drizzle/migrations/${tag}.sql`)
  console.log(`Wrote drizzle/migrations/meta/${prefix}_snapshot.json (parents: ${heads.map((h) => h.file).join(', ') || 'none'})`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('db:generate failed:', err)
    process.exit(2)
  })
}

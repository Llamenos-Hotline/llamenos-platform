#!/usr/bin/env bun
/**
 * check-migration-drift.ts — Detect Drizzle schema changes without corresponding migrations.
 *
 * Uses drizzle-kit's programmatic API to generate a snapshot from the current schema,
 * then compares it against the schema the committed migrations build: the merge of
 * the snapshot heads (scripts/lib/migration-graph.ts — one head is just the newest
 * snapshot). If the table/column structure differs, the schema has drifted from the
 * committed migrations. Snapshots that do not merge — two migrations from different
 * branches changing one object differently — fail too.
 *
 * Usage:
 *   bun scripts/check-migration-drift.ts          # run drift check
 *   bun scripts/check-migration-drift.ts --ci     # CI mode (show detailed diff)
 */

import { join } from 'node:path'
import { declaredSchemaSnapshot } from './lib/drizzle-schema'
import { MigrationGraph } from './lib/migration-graph'

const CI_MODE = process.argv.includes('--ci')
const META_DIR = join('drizzle', 'migrations', 'meta')

type SnapshotTable = {
  name: string
  columns: Record<string, { name: string; type: string; primaryKey: boolean; notNull: boolean; default?: unknown }>
  indexes: Record<string, unknown>
  foreignKeys: Record<string, unknown>
  compositePrimaryKeys: Record<string, unknown>
  uniqueConstraints: Record<string, unknown>
}

type Snapshot = {
  tables: Record<string, SnapshotTable>
  enums: Record<string, unknown>
  sequences: Record<string, unknown>
}

/** Normalize a snapshot to only the structurally significant parts for comparison */
function normalizeSnapshot(snap: Snapshot): string {
  // Extract just tables, their columns, indexes, foreign keys, constraints, enums, sequences
  const normalized = {
    tables: Object.fromEntries(
      Object.entries(snap.tables ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, table]) => [
        key,
        {
          name: table.name,
          columns: Object.fromEntries(
            Object.entries(table.columns ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
          indexes: Object.fromEntries(
            Object.entries(table.indexes ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
          foreignKeys: Object.fromEntries(
            Object.entries(table.foreignKeys ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
          compositePrimaryKeys: Object.fromEntries(
            Object.entries(table.compositePrimaryKeys ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
          uniqueConstraints: Object.fromEntries(
            Object.entries(table.uniqueConstraints ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      ]),
    ),
    enums: Object.fromEntries(
      Object.entries(snap.enums ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sequences: Object.fromEntries(
      Object.entries(snap.sequences ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
  return JSON.stringify(normalized)
}

/** Produce a human-readable summary of what changed */
function describeDiff(prev: Snapshot, curr: Snapshot): string[] {
  const diffs: string[] = []
  const prevTables = new Set(Object.keys(prev.tables ?? {}))
  const currTables = new Set(Object.keys(curr.tables ?? {}))

  // New tables
  for (const t of currTables) {
    if (!prevTables.has(t)) diffs.push(`+ Table added: ${t}`)
  }
  // Removed tables
  for (const t of prevTables) {
    if (!currTables.has(t)) diffs.push(`- Table removed: ${t}`)
  }
  // Changed tables
  for (const t of currTables) {
    if (!prevTables.has(t)) continue
    const prevCols = new Set(Object.keys(prev.tables[t]?.columns ?? {}))
    const currCols = new Set(Object.keys(curr.tables[t]?.columns ?? {}))

    for (const c of currCols) {
      if (!prevCols.has(c)) diffs.push(`+ Column added: ${prev.tables[t].name}.${c}`)
    }
    for (const c of prevCols) {
      if (!currCols.has(c)) diffs.push(`- Column removed: ${prev.tables[t].name}.${c}`)
    }

    // Check for column type/constraint changes
    for (const c of currCols) {
      if (!prevCols.has(c)) continue
      const prevCol = prev.tables[t].columns[c]
      const currCol = curr.tables[t].columns[c]
      if (JSON.stringify(prevCol) !== JSON.stringify(currCol)) {
        diffs.push(`~ Column modified: ${prev.tables[t].name}.${c}`)
      }
    }

    // Check for index changes
    const prevIdx = JSON.stringify(prev.tables[t]?.indexes ?? {})
    const currIdx = JSON.stringify(curr.tables[t]?.indexes ?? {})
    if (prevIdx !== currIdx) diffs.push(`~ Indexes changed on: ${prev.tables[t].name}`)

    // Check for FK changes
    const prevFk = JSON.stringify(prev.tables[t]?.foreignKeys ?? {})
    const currFk = JSON.stringify(curr.tables[t]?.foreignKeys ?? {})
    if (prevFk !== currFk) diffs.push(`~ Foreign keys changed on: ${prev.tables[t].name}`)
  }

  // Enum changes
  const prevEnums = JSON.stringify(prev.enums ?? {})
  const currEnums = JSON.stringify(curr.enums ?? {})
  if (prevEnums !== currEnums) diffs.push('~ Enums changed')

  return diffs
}

async function main() {
  // 1. The schema the source code declares
  const currentSnapshot = (await declaredSchemaSnapshot()) as unknown as Snapshot

  // 2. The schema the committed migrations build: the merge of the snapshot
  //    heads (scripts/lib/migration-graph.ts). With one head this is simply
  //    the newest snapshot; with two — two migration PRs that landed without
  //    knowing about each other — it is both of their changes.
  const graph = MigrationGraph.load(META_DIR)
  if (graph.nodes.length === 0) {
    console.error('No existing migration snapshot found in drizzle/migrations/meta/')
    console.error('Run `bun run db:generate --name initial` to create the initial migration.')
    process.exit(1)
  }
  const { heads, schema, conflicts } = graph.state()
  if (graph.problems.length > 0 || conflicts.length > 0) {
    console.error('')
    console.error('MIGRATION SNAPSHOTS DO NOT FORM ONE SCHEMA')
    for (const p of graph.problems) console.error(`  ${p}`)
    for (const c of conflicts) console.error(`  conflict: ${c}`)
    console.error('')
    console.error('A conflict means two migrations written on different branches changed the same')
    console.error('object differently, so the order they apply in decides the result. Rebase onto')
    console.error('origin/main, delete THIS branch\'s migration + snapshot, and regenerate it on top:')
    console.error('  bun run db:generate --name <description>')
    process.exit(1)
  }
  const previousSnapshot = schema as unknown as Snapshot
  if (CI_MODE) console.log(`Migrations build: ${heads.map((h) => h.file).join(' + ')}`)

  // 4. Compare normalized snapshots
  const prevNorm = normalizeSnapshot(previousSnapshot)
  const currNorm = normalizeSnapshot(currentSnapshot)

  if (prevNorm === currNorm) {
    if (CI_MODE) {
      console.log('✓ Schema and migrations are in sync — no drift detected.')
    }
    process.exit(0)
  }

  // Drift detected
  const diffs = describeDiff(previousSnapshot, currentSnapshot)

  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  MIGRATION DRIFT DETECTED                                  ║')
  console.error('╠══════════════════════════════════════════════════════════════╣')
  console.error('║  Your Drizzle schema has changes not captured in a          ║')
  console.error('║  migration file. This will break CI and production.        ║')
  console.error('║                                                            ║')
  console.error("║  Fix: run 'bun run db:generate --name <description>'       ║")
  console.error('║  and commit the resulting SQL file and snapshot.           ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')

  if (diffs.length > 0) {
    console.error('Changes detected:')
    for (const d of diffs) {
      console.error(`  ${d}`)
    }
  } else {
    console.error('Structural differences detected (column types, defaults, or constraints).')
  }

  process.exit(1)
}

main().catch((err) => {
  console.error('Migration drift check failed:', err)
  process.exit(2)
})

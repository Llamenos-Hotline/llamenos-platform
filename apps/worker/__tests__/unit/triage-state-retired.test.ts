/**
 * #2779, #3114 — no source names a retired plaintext triage field.
 *
 * A case's status, severity and category, an event's status, and a contact's type live only in
 * the sealed summary. Their `*Hash` fields held the plaintext value under a hash name; they are
 * gone from the contract, the worker, the schema and the three clients, and this is the gate
 * that keeps them gone. A new writer that reaches for one fails here, before any review.
 *
 * What it scans: the protocol schemas, the worker, the desktop client and the iOS and Android
 * sources, excluding tests (a test names a retired field to prove it is refused, and imports
 * the list from `__tests__/helpers/retired-index-fields.ts`) and generated code.
 *
 * `retiredStatus` in `db/schema/cases.ts` is the one column still declared — the gate that
 * guards a database drop refuses to forget a NOT NULL column in the release that relaxes it
 * (docs/runbooks/migrations.md). It is nullable, never read or written, and the contract
 * release drops it; the test below pins that.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RETIRED_INDEX_FIELDS, RETIRED_INTERACTION_FIELDS } from '../helpers/retired-index-fields'

const ROOT = join(__dirname, '../../../..')
const SCOPES = ['packages/protocol/schemas', 'apps/worker', 'src/client', 'apps/ios/Sources', 'apps/android/app/src/main']
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'generated', 'build', 'dist', '.gradle', '.build'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|swift|kt)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

describe('retired triage fields (#2779, #3114)', () => {
  const retired = [...RETIRED_INDEX_FIELDS, ...RETIRED_INTERACTION_FIELDS]
  const pattern = new RegExp(`\\b(${retired.join('|')})\\b`)

  it('are named by no schema, worker, desktop, iOS or Android source', () => {
    const hits: string[] = []
    for (const scope of SCOPES) {
      for (const file of walk(join(ROOT, scope))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
        })
      }
    }
    expect(hits, 'a status, severity, category or contact type must not reach a hash-named field').toEqual([])
  })

  it('leave no snake_case column behind, except the one nullable column awaiting the contract release', () => {
    const columns = ['status_hash', 'severity_hash', 'category_hash', 'contact_type_hash', 'previous_status_hash', 'new_status_hash']
    const hits: string[] = []
    for (const file of walk(join(ROOT, 'apps/worker/db/schema'))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (columns.some(c => line.includes(`'${c}'`))) hits.push(`${relative(ROOT, file)}  ${line.trim()}`)
      }
    }
    expect(hits).toEqual([
      // case_records.status_hash and events.status_hash
      "apps/worker/db/schema/cases.ts  retiredStatus: text('status_hash'),",
      "apps/worker/db/schema/cases.ts  retiredStatus: text('status_hash'),",
    ])
  })

  it('declares the retired columns nullable, so this release\'s INSERTs that omit them succeed', () => {
    const cases = readFileSync(join(ROOT, 'apps/worker/db/schema/cases.ts'), 'utf8')
    for (const line of cases.split('\n').filter(l => l.includes("text('status_hash')"))) {
      expect(line).not.toContain('notNull')
    }
  })
})

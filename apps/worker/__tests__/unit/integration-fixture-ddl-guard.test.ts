/**
 * No integration suite restates a real table's DDL (#3011).
 *
 * Seven fixtures that hand-wrote `CREATE TABLE` for `call_records`, `contacts`,
 * `puk_envelopes` and friends all broke when #2997 added `crypto_format`, with
 * errors pointing at the fixture rather than the change. The tables a fixture
 * stands in for are now derived from the Drizzle schema
 * (`__tests__/helpers/schema-ddl.ts`); this guard keeps hand-written DDL from
 * coming back, which the derivation alone cannot.
 *
 * A suite that genuinely needs DDL of its own must say so here, with the
 * reason, so the exception is a reviewed decision rather than a copy-paste.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const TESTS_DIR = join(import.meta.dirname, '..')
const SUITES = ['integration', 'integration-bun']

/** Files allowed to contain `CREATE TABLE`, and why. */
const ALLOWED: Record<string, string> = {
  'integration/migration-safety-target.test.ts':
    'tests the migration safety gate itself against migration files it writes — the tables are the gate\'s input, not a stand-in for a schema table',
}

const CREATE_TABLE = /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b/i

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('integration fixtures derive their tables from the schema (#3011)', () => {
  const files = SUITES.flatMap((suite) => sourceFiles(join(TESTS_DIR, suite)))

  it('scans the suites it claims to (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('no suite hand-writes CREATE TABLE except the allowlisted ones', () => {
    const offenders = files
      .map((file) => relative(TESTS_DIR, file))
      .filter((rel) => CREATE_TABLE.test(readFileSync(join(TESTS_DIR, rel), 'utf8')))
      .filter((rel) => !(rel in ALLOWED))
    expect(
      offenders,
      'derive the table with createSchemaTables() from __tests__/helpers/schema-ddl.ts instead of restating it',
    ).toEqual([])
  })

  it('every allowlisted file still contains CREATE TABLE (no stale exemptions)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(CREATE_TABLE.test(readFileSync(join(TESTS_DIR, rel), 'utf8')), rel).toBe(true)
    }
  })
})

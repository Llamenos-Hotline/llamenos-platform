/**
 * CustomFieldsService.updateCustomFields concurrency — real PostgreSQL (#686).
 *
 * updateCustomFields replaces the whole custom-field set with DELETE + INSERT.
 * Under READ COMMITTED, two concurrent replacements interleave: the second
 * writer's DELETE blocks on the first writer's row locks, then (after the
 * first commits) skips the rows it already deleted and cannot see the rows it
 * inserted — so both inserts survive and the table holds the UNION of both
 * lists, including duplicate field names. Every later full-list PUT is then
 * rejected with "Duplicate field name".
 *
 * The contract asserted here: after N concurrent replacements, the persisted
 * set is exactly ONE caller's list (last writer wins), never a union.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { createSettingsDomain, type SettingsDomainServices } from '../../services/settings-domain'
import type { CustomFieldDefinition } from '@shared/types'
import { requireDatabaseUrl } from '../helpers/database-url'

const DATABASE_URL = requireDatabaseUrl()

const TEST_SCHEMA = `test_custom_fields_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/settings.ts customFieldDefinitions.
const CUSTOM_FIELDS_DDL = `
  CREATE TABLE ${TEST_SCHEMA}.custom_field_definitions (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    label               TEXT NOT NULL,
    field_type          TEXT NOT NULL,
    required            BOOLEAN DEFAULT false,
    options             TEXT[] NOT NULL DEFAULT '{}'::text[],
    validation          JSONB,
    visible_to_users    BOOLEAN DEFAULT true,
    editable_by_users   BOOLEAN DEFAULT true,
    context             TEXT NOT NULL DEFAULT 'all',
    max_file_size       INTEGER,
    allowed_mime_types  TEXT[] NOT NULL DEFAULT '{}'::text[],
    max_files           INTEGER DEFAULT 1,
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let settings: SettingsDomainServices

function field(name: string, label = name): CustomFieldDefinition {
  return {
    id: '',
    name,
    label,
    type: 'text',
    required: false,
    visibleToUsers: true,
    editableByUsers: true,
    context: 'all',
    order: 0,
    createdAt: new Date().toISOString(),
  } as CustomFieldDefinition
}

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(CUSTOM_FIELDS_DDL)

  // A multi-connection pool is required: the race only exists when the
  // concurrent transactions run on distinct connections.
  testSql = postgres(DATABASE_URL, {
    max: 10,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  settings = createSettingsDomain(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE custom_field_definitions`
})

describe('CustomFieldsService.updateCustomFields under concurrent writers', () => {
  it('persists exactly one caller\'s list — never the union of concurrent PUTs', async () => {
    // Seed so every writer's DELETE has existing rows to lock on.
    await settings.customFields.updateCustomFields({ fields: [field('seed_a'), field('seed_b')] })

    const lists: CustomFieldDefinition[][] = Array.from({ length: 8 }, (_, i) => [
      field('severity'),
      field(`writer_${i}_a`),
      field(`writer_${i}_b`),
    ])

    for (let round = 0; round < 5; round++) {
      await Promise.all(lists.map((fields) => settings.customFields.updateCustomFields({ fields })))

      const { fields: persisted } = await settings.customFields.getCustomFields('admin')
      const names = persisted.map((f) => f.name)

      // No duplicate names ever persisted.
      expect(new Set(names).size).toBe(names.length)
      // The persisted set equals one of the submitted lists.
      const matches = lists.filter(
        (l) => l.length === names.length && l.every((f, i) => f.name === names[i]),
      )
      expect(matches).toHaveLength(1)
    }

    // And a subsequent full-list PUT still succeeds (no poisoned duplicate).
    await expect(
      settings.customFields.updateCustomFields({ fields: [field('severity'), field('after')] }),
    ).resolves.toBeDefined()
  })
})

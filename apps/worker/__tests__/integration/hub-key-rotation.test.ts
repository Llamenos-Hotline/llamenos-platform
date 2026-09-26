/**
 * Hub-key generation guard and atomic rotation — real PostgreSQL (#1085).
 *
 * Two properties, both about never leaving the hub in a state where a removed
 * member regains access or where data is sealed under a key nobody holds:
 *
 *  1. A rotation (new envelopes + re-encrypted tags/teams + generation bump)
 *     commits as ONE transaction. A failure at any statement inside it leaves
 *     every row exactly as it was — the hub stays readable under the old key.
 *  2. Envelope writes name the generation they expect to be current. A write
 *     made against any other generation (a stale distribute that lands after
 *     a rotation, or a second "first key") is refused, so a retired key set
 *     can never replace a newer one.
 *
 * Failures are injected with PostgreSQL triggers, so they happen mid-statement
 * inside the real transaction rather than in a mocked client.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { ServiceError, SettingsService } from '../../services/settings'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_hub_key_rotation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/settings.ts (hubs, hub_keys), tags.ts and teams.ts.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.hubs (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL UNIQUE,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    phone_number        TEXT,
    created_by          TEXT NOT NULL,
    hub_key_generation  INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.hub_keys (
    hub_id            TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.hubs(id) ON DELETE CASCADE,
    recipient_pubkey  TEXT NOT NULL,
    enc               TEXT NOT NULL,
    ct                TEXT NOT NULL,
    PRIMARY KEY (hub_id, recipient_pubkey)
  );
  CREATE TABLE ${TEST_SCHEMA}.tags (
    id                  TEXT PRIMARY KEY,
    hub_id              TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.hubs(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    encrypted_label     TEXT NOT NULL,
    color               TEXT NOT NULL DEFAULT '#6b7280',
    encrypted_category  TEXT,
    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tags_hub_name_unique UNIQUE (hub_id, name)
  );
  CREATE TABLE ${TEST_SCHEMA}.teams (
    id                     TEXT PRIMARY KEY,
    hub_id                 TEXT NOT NULL REFERENCES ${TEST_SCHEMA}.hubs(id) ON DELETE CASCADE,
    encrypted_name         TEXT NOT NULL,
    encrypted_description  TEXT,
    created_by             TEXT NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE FUNCTION ${TEST_SCHEMA}.injected_failure() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'injected failure mid-rotation';
  END
  $$ LANGUAGE plpgsql;
`

const HUB = 'hub-1'
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const DAVE = 'd'.repeat(64)

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let settings: SettingsService

function envelope(pubkey: string, keyTag: string) {
  return { pubkey, enc: `enc-${keyTag}-${pubkey.slice(0, 4)}`, ct: `ct-${keyTag}-${pubkey.slice(0, 4)}` }
}

/** Everything a reader of this hub depends on, as stored. */
async function snapshot() {
  const [hub] = await testSql`SELECT hub_key_generation FROM hubs WHERE id = ${HUB}`
  const envelopes = await testSql`SELECT recipient_pubkey, enc, ct FROM hub_keys WHERE hub_id = ${HUB} ORDER BY recipient_pubkey`
  const tags = await testSql`SELECT id, encrypted_label, encrypted_category FROM tags WHERE hub_id = ${HUB} ORDER BY id`
  const teams = await testSql`SELECT id, encrypted_name, encrypted_description FROM teams WHERE hub_id = ${HUB} ORDER BY id`
  return {
    generation: hub.hub_key_generation as number,
    envelopes: envelopes.map(r => ({ ...r })),
    tags: tags.map(r => ({ ...r })),
    teams: teams.map(r => ({ ...r })),
  }
}

/** A full rotation from `fromGeneration` that re-seals every record under `keyTag`. */
function rotation(fromGeneration: number, keyTag: string) {
  return {
    fromGeneration,
    envelopes: [envelope(ALICE, keyTag), envelope(BOB, keyTag)],
    tags: [
      { id: 'tag-1', encryptedLabel: `label-1@${keyTag}`, encryptedCategory: `category-1@${keyTag}` },
      { id: 'tag-2', encryptedLabel: `label-2@${keyTag}`, encryptedCategory: null },
    ],
    teams: [
      { id: 'team-1', encryptedName: `name-1@${keyTag}`, encryptedDescription: null },
    ],
  }
}

async function expectConflict(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ServiceError)
  expect((err as ServiceError).status).toBe(409)
}

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  testSql = postgres(DATABASE_URL, {
    max: 10,
    connection: { search_path: TEST_SCHEMA },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  settings = new SettingsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE hubs CASCADE`
  await testSql`INSERT INTO hubs (id, name, slug, created_by) VALUES (${HUB}, 'Hub', 'hub', ${ALICE})`
  // Generation 1, wrapped for Alice, Bob and Dave; every record sealed under it.
  await settings.setHubKeyEnvelopes(HUB, {
    expectedGeneration: 0,
    envelopes: [envelope(ALICE, 'k1'), envelope(BOB, 'k1'), envelope(DAVE, 'k1')],
  })
  await testSql`INSERT INTO tags (id, hub_id, name, encrypted_label, encrypted_category, created_by) VALUES
    ('tag-1', ${HUB}, 'tag-1', 'label-1@k1', 'category-1@k1', ${ALICE}),
    ('tag-2', ${HUB}, 'tag-2', 'label-2@k1', NULL, ${ALICE})`
  await testSql`INSERT INTO teams (id, hub_id, encrypted_name, created_by) VALUES
    ('team-1', ${HUB}, 'name-1@k1', ${ALICE})`
})

afterEach(async () => {
  await testSql.unsafe(`
    DROP TRIGGER IF EXISTS fail_tag ON tags;
    DROP TRIGGER IF EXISTS fail_team ON teams;
    DROP TRIGGER IF EXISTS fail_envelope ON hub_keys;
    DROP TRIGGER IF EXISTS fail_generation ON hubs;
  `)
})

describe('hub key rotation is atomic', () => {
  // Each trigger fires at a different statement of the rotation transaction,
  // after the statements before it have already executed inside it.
  const failurePoints: Array<[string, string]> = [
    ['re-encrypting the second tag', "CREATE TRIGGER fail_tag BEFORE UPDATE ON tags FOR EACH ROW WHEN (NEW.id = 'tag-2') EXECUTE FUNCTION injected_failure()"],
    ['re-encrypting a team', 'CREATE TRIGGER fail_team BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION injected_failure()'],
    ['writing the new envelopes', 'CREATE TRIGGER fail_envelope BEFORE INSERT ON hub_keys FOR EACH ROW EXECUTE FUNCTION injected_failure()'],
    ['bumping the generation', 'CREATE TRIGGER fail_generation BEFORE UPDATE ON hubs FOR EACH ROW EXECUTE FUNCTION injected_failure()'],
  ]

  for (const [point, trigger] of failurePoints) {
    it(`a failure while ${point} leaves the hub exactly as it was, and a retry commits`, async () => {
      const before = await snapshot()
      await testSql.unsafe(trigger)

      const err = await settings.rotateHubKey(HUB, rotation(1, 'k2')).then(() => null, (e: unknown) => e)
      // drizzle wraps the driver error; the trigger's exception is its cause.
      expect(String((err as { cause?: { message?: string } } | null)?.cause?.message)).toMatch(/injected failure mid-rotation/)

      // Nothing moved: old envelopes (Dave's included — the rotation that
      // would have removed it never happened), old ciphertexts, old generation.
      expect(await snapshot()).toEqual(before)

      // Recoverable: the same rotation succeeds once the fault is gone.
      await testSql.unsafe('DROP TRIGGER IF EXISTS fail_tag ON tags; DROP TRIGGER IF EXISTS fail_team ON teams; DROP TRIGGER IF EXISTS fail_envelope ON hub_keys; DROP TRIGGER IF EXISTS fail_generation ON hubs;')
      expect(await settings.rotateHubKey(HUB, rotation(1, 'k2'))).toEqual({ generation: 2 })
      const after = await snapshot()
      expect(after.generation).toBe(2)
      expect(after.envelopes.map(e => e.recipient_pubkey)).toEqual([ALICE, BOB])
      expect(after.envelopes.every(e => String(e.ct).startsWith('ct-k2'))).toBe(true)
      expect(after.tags.map(t => t.encrypted_label)).toEqual(['label-1@k2', 'label-2@k2'])
      expect(after.tags.map(t => t.encrypted_category)).toEqual(['category-1@k2', null])
      expect(after.teams.map(t => t.encrypted_name)).toEqual(['name-1@k2'])
    })
  }

  it('refuses a rotation that does not cover every tag and team, changing nothing', async () => {
    const before = await snapshot()
    const missingTag = { ...rotation(1, 'k2'), tags: rotation(1, 'k2').tags.slice(0, 1) }
    await expectConflict(settings.rotateHubKey(HUB, missingTag))

    const foreignTeam = {
      ...rotation(1, 'k2'),
      teams: [...rotation(1, 'k2').teams, { id: 'team-elsewhere', encryptedName: 'x', encryptedDescription: null }],
    }
    await expectConflict(settings.rotateHubKey(HUB, foreignTeam))

    // A tag created after the client decrypted the hub (it would stay sealed
    // under the retired key) also blocks the commit.
    await testSql`INSERT INTO tags (id, hub_id, name, encrypted_label, created_by) VALUES ('tag-3', ${HUB}, 'tag-3', 'label-3@k1', ${BOB})`
    const withTag3 = await snapshot()
    await expectConflict(settings.rotateHubKey(HUB, rotation(1, 'k2')))
    expect(await snapshot()).toEqual(withTag3)
    expect(withTag3.envelopes).toEqual(before.envelopes)
  })

  it('refuses a rotation from a generation that is no longer current', async () => {
    await settings.rotateHubKey(HUB, rotation(1, 'k2'))
    const before = await snapshot()
    await expectConflict(settings.rotateHubKey(HUB, rotation(1, 'k3')))
    expect(await snapshot()).toEqual(before)
  })

  it('lets exactly one of several concurrent rotations from the same generation commit', async () => {
    const results = await Promise.allSettled(
      ['k2a', 'k2b', 'k2c', 'k2d'].map(tag => settings.rotateHubKey(HUB, rotation(1, tag))),
    )
    const committed = results.filter(r => r.status === 'fulfilled')
    expect(committed).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as ServiceError).status).toBe(409)
    }
    // Envelopes and records all belong to the single winner.
    const after = await snapshot()
    expect(after.generation).toBe(2)
    const winner = String(after.tags[0].encrypted_label).split('@')[1]
    expect(after.envelopes.every(e => String(e.ct).startsWith(`ct-${winner}-`))).toBe(true)
    expect(after.teams[0].encrypted_name).toBe(`name-1@${winner}`)
  })
})

describe('hub key generation guard', () => {
  it('accepts a first key only while the hub has none', async () => {
    await testSql`INSERT INTO hubs (id, name, slug, created_by) VALUES ('hub-new', 'New', 'new', ${ALICE})`
    await expectConflict(settings.setHubKeyEnvelopes('hub-new', { expectedGeneration: 1, envelopes: [envelope(ALICE, 'x')] }))
    expect(await settings.setHubKeyEnvelopes('hub-new', { expectedGeneration: 0, envelopes: [envelope(ALICE, 'x')] }))
      .toEqual({ generation: 1 })
    expect((await settings.getHubKeyEnvelopes('hub-new')).generation).toBe(1)
    // A second "first key" would replace the key data is sealed under without
    // re-encrypting it — refused, and the first key's envelopes stay.
    await expectConflict(settings.setHubKeyEnvelopes('hub-new', { expectedGeneration: 0, envelopes: [envelope(ALICE, 'y')] }))
    expect((await settings.getHubKeyEnvelopes('hub-new')).envelopes).toEqual([envelope(ALICE, 'x')])
  })

  it('re-distributes the current generation to a new member', async () => {
    const erin = 'e'.repeat(64)
    await settings.setHubKeyEnvelopes(HUB, {
      expectedGeneration: 1,
      envelopes: [envelope(ALICE, 'k1'), envelope(BOB, 'k1'), envelope(DAVE, 'k1'), envelope(erin, 'k1')],
    })
    const { generation, envelopes } = await settings.getHubKeyEnvelopes(HUB)
    expect(generation).toBe(1)
    expect(envelopes.map(e => e.pubkey)).toContain(erin)
  })

  it('refuses a stale distribute that lands after a rotation: the departed member stays excluded', async () => {
    // Dave departs; the rotation excludes him.
    await settings.rotateHubKey(HUB, rotation(1, 'k2'))
    const rotated = await snapshot()

    // A late distribute of the retired generation-1 key — wrapped for Dave
    // too — reaches the server afterwards.
    await expectConflict(settings.setHubKeyEnvelopes(HUB, {
      expectedGeneration: 1,
      envelopes: [envelope(ALICE, 'k1'), envelope(BOB, 'k1'), envelope(DAVE, 'k1')],
    }))

    const after = await snapshot()
    expect(after).toEqual(rotated)
    expect(after.envelopes.map(e => e.recipient_pubkey)).not.toContain(DAVE)
  })

  it('a stale distribute racing a rotation never leaves the retired key installed', async () => {
    for (let round = 0; round < 10; round++) {
      await testSql`TRUNCATE TABLE hub_keys`
      await testSql`UPDATE hubs SET hub_key_generation = 0 WHERE id = ${HUB}`
      await testSql`UPDATE tags SET encrypted_label = regexp_replace(encrypted_label, '@.*', '@k1')`
      await settings.setHubKeyEnvelopes(HUB, {
        expectedGeneration: 0,
        envelopes: [envelope(ALICE, 'k1'), envelope(BOB, 'k1'), envelope(DAVE, 'k1')],
      })

      await Promise.allSettled([
        settings.rotateHubKey(HUB, rotation(1, 'k2')),
        settings.setHubKeyEnvelopes(HUB, {
          expectedGeneration: 1,
          envelopes: [envelope(ALICE, 'k1'), envelope(BOB, 'k1'), envelope(DAVE, 'k1')],
        }),
      ])

      // Whichever order the two writes serialised in, the rotation's key set
      // is what remains, and Dave holds nothing for it.
      const after = await snapshot()
      expect(after.generation).toBe(2)
      expect(after.envelopes.map(e => e.recipient_pubkey)).toEqual([ALICE, BOB])
      expect(after.envelopes.every(e => String(e.ct).startsWith('ct-k2'))).toBe(true)
    }
  })
})

/**
 * Every file has a hub and an owner, and the database — not only the upload
 * route — refuses one that does not (#2462, #2484, #2486), against real
 * PostgreSQL migrated by the real migrations.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/files-hub-owner-constraints.test.ts
 *
 * #2484 gave `files` composite (parent id, hub_id) foreign keys, but left
 * hub_id and owner_kind nullable. Postgres FKs are MATCH SIMPLE, so a NULL
 * hub_id switched the composite check off, and a NULL owner_kind made
 * files_owner_check evaluate to NULL, which a CHECK admits. A BEFORE INSERT
 * trigger (files_fill_hub) also supplied a missing hub from the conversation,
 * so a producer that forgot the hub still succeeded. Each refusal below was an
 * accepted row before #2486; each is paired with a control row that the same
 * constraint accepts, without which a refusal could be any error at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { inArray, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs } from '../../db/schema'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `files-a-${suffix}`
const HUB_B = `files-b-${suffix}`
const CONVERSATION_A = `cv-a-${suffix}`
const CONVERSATION_B = `cv-b-${suffix}`
const RECORD_A = `rec-a-${suffix}`
const RECORD_B = `rec-b-${suffix}`

/** The error text Postgres reports, wherever the driver and drizzle put it. */
async function refusal(query: Promise<unknown>): Promise<string> {
  try {
    await query
  } catch (err) {
    const parts: string[] = []
    for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) parts.push(e.message)
    return parts.join(' | ')
  }
  throw new Error('the database accepted a row it must refuse')
}

interface FileRow {
  hubId: string | null
  ownerKind: string | null
  conversationId?: string
  caseRecordId?: string
}

let n = 0
/** Resolves to the inserted row's id. */
async function insertFile(row: FileRow): Promise<string> {
  const id = `file-${suffix}-${++n}`
  await db.execute(sql`
    INSERT INTO files (id, hub_id, owner_kind, conversation_id, case_record_id, uploaded_by)
    VALUES (${id}, ${row.hubId}, ${row.ownerKind}, ${row.conversationId ?? null}, ${row.caseRecordId ?? null}, ${'pk-uploader'})`)
  return id
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[]
}

beforeAll(async () => {
  for (const hub of [HUB_A, HUB_B]) {
    await db.insert(hubs).values({ id: hub, name: hub, slug: hub, createdBy: 'integration-test' })
  }
  for (const [id, hub] of [[CONVERSATION_A, HUB_A], [CONVERSATION_B, HUB_B]]) {
    await db.execute(sql`
      INSERT INTO conversations (id, hub_id, channel_type, status) VALUES (${id}, ${hub}, ${'sms'}, ${'waiting'})`)
  }
  for (const [id, hub] of [[RECORD_A, HUB_A], [RECORD_B, HUB_B]]) {
    await db.execute(sql`
      INSERT INTO case_records (id, hub_id, status_hash, created_by) VALUES (${id}, ${hub}, ${'h'}, ${'pk-creator'})`)
  }
})

afterAll(async () => {
  // ON DELETE CASCADE: the hubs take their conversations and files with them.
  await db.execute(sql`DELETE FROM case_records WHERE id IN (${RECORD_A}, ${RECORD_B})`)
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('files carry a hub and an owner (#2486)', () => {
  it('refuses a conversation file that names no hub — no trigger fills it in any more', async () => {
    expect(await refusal(insertFile({ hubId: null, ownerKind: null, conversationId: CONVERSATION_A }))).toMatch(
      /null value in column "hub_id" of relation "files"/,
    )
  })

  it('refuses a file that names a hub but no owner kind', async () => {
    // With owner_kind NULL every branch of files_owner_check is NULL, and a
    // CHECK admits NULL — only NOT NULL refuses this row.
    expect(await refusal(insertFile({ hubId: HUB_A, ownerKind: null }))).toMatch(
      /null value in column "owner_kind" of relation "files"/,
    )
  })

  it('refuses a case file naming a case record that does not exist', async () => {
    // case_record_id has no single-column FK: the composite is its only guard.
    expect(
      await refusal(insertFile({ hubId: HUB_A, ownerKind: 'case_record', caseRecordId: `no-such-record-${suffix}` })),
    ).toMatch(/violates foreign key constraint "files_case_record_hub_fk"/)
  })

  it("refuses a case file naming another hub's case record", async () => {
    expect(await refusal(insertFile({ hubId: HUB_A, ownerKind: 'case_record', caseRecordId: RECORD_B }))).toMatch(
      /violates foreign key constraint "files_case_record_hub_fk"/,
    )
  })

  it("refuses a conversation file naming another hub's conversation", async () => {
    expect(
      await refusal(insertFile({ hubId: HUB_A, ownerKind: 'conversation', conversationId: CONVERSATION_B })),
    ).toMatch(/violates foreign key constraint "files_conversation_hub_fk"/)
  })

  it('accepts a file of each owner kind filed under its own hub', async () => {
    const ids = [
      await insertFile({ hubId: HUB_A, ownerKind: 'conversation', conversationId: CONVERSATION_A }),
      await insertFile({ hubId: HUB_A, ownerKind: 'case_record', caseRecordId: RECORD_A }),
      await insertFile({ hubId: HUB_A, ownerKind: 'entity_field' }),
    ]
    const stored = await rows<{ hub_id: string; owner_kind: string }>(
      sql`SELECT hub_id, owner_kind FROM files WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ORDER BY owner_kind`,
    )
    expect(stored).toEqual([
      { hub_id: HUB_A, owner_kind: 'case_record' },
      { hub_id: HUB_A, owner_kind: 'conversation' },
      { hub_id: HUB_A, owner_kind: 'entity_field' },
    ])
  })

  it('has no trigger or helper function left to supply a missing hub', async () => {
    const triggers = await rows<{ tgname: string }>(
      sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'files'::regclass AND NOT tgisinternal`,
    )
    expect(triggers).toEqual([])
    const functions = await rows<{ proname: string }>(
      sql`SELECT proname FROM pg_proc WHERE proname = 'files_fill_hub_from_conversation'`,
    )
    expect(functions).toEqual([])
  })

  it('has validated the evidence.file_id foreign key for rows already stored', async () => {
    const [constraint] = await rows<{ convalidated: boolean }>(
      sql`SELECT convalidated FROM pg_constraint WHERE conname = 'evidence_file_id_files_id_fk'`,
    )
    expect(constraint).toEqual({ convalidated: true })
  })
})

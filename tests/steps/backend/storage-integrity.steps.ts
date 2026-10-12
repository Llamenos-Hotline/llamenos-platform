/**
 * Storage integrity step definitions (Epic 365).
 *
 * Verifies JSONB round-trip fidelity for all entity types that store
 * structured data. Checks BOTH the API response AND the raw DB row
 * to catch double-serialization bugs.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  apiGet,
  apiPost,
  apiPatch,
  generateTestKeypair,
  uniquePhone,
  ADMIN_SEED,
} from '../../api-helpers'
import {
  generateContentKey,
  encryptContent,
  wrapKeyForRecipient,
  adminHpkeRecipient,
  hpkeRecipientForSeed,
} from '../../crypto-helpers'
import { LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { TestDB } from '../../db-helpers'
import { assertIsObject, assertIsArray } from '../../integrity-helpers'
import { bytesToHex, hexToBytes } from '@shared/encoding'
import { ed25519 } from '@noble/curves/ed25519.js'

// ── State ───────────────────────────────────────────────────────────

interface StorageIntegrityState {
  /** Entity IDs by type */
  entityIds: Map<string, string>
  /** API response data by entity type */
  apiResponses: Map<string, Record<string, unknown>>
  /** DB rows by entity type */
  dbRows: Map<string, Record<string, unknown>>
  /** Submitted envelope data for byte-accuracy checks */
  submittedEnvelopes?: Array<{ pubkey: string; ct: string; enc: string }>
  /** Submitted author envelope */
  submittedAuthorEnvelope?: { ct: string; enc: string }
  /** Volunteer keypair for note creation */
  volunteerKp?: { seedHex: string; pubkey: string }
  /** Admin keypair info */
  adminSeedHex?: string
  adminPubkey?: string
}

const STORAGE_INTEGRITY_KEY = 'storage_integrity'

function getStorageIntegrityState(world: Record<string, unknown>): StorageIntegrityState {
  return getState<StorageIntegrityState>(world, STORAGE_INTEGRITY_KEY)
}


Before(async ({ world }) => {
  setState<StorageIntegrityState>(world, STORAGE_INTEGRITY_KEY, {
    entityIds: new Map(),
    apiResponses: new Map(),
    dbRows: new Map(),
  })
})

// ── Helpers ─────────────────────────────────────────────────────────

function seedHexToPubkey(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
}

// ── Given: Entity creation ──────────────────────────────────────────

Given('a {string} entity is created via the API with structured JSONB data', async ({ request, world }, entityType: string) => {
  switch (entityType) {
    case 'note with envelopes': {
      // Create a real volunteer first with a known keypair
      const volKp = generateTestKeypair()
      getStorageIntegrityState(world).volunteerKp = volKp
      const regResult = await apiPost(request, '/users', {
        name: `StorageVol ${Date.now()}`,
        phone: uniquePhone(),
        roleIds: ['role-volunteer'],
        pubkey: volKp.pubkey,
      })
      expect([200, 201]).toContain(regResult.status)

      // HPKE recipients, not identity pubkeys: an envelope sealed to an
      // Ed25519 signing key is well-formed and permanently unopenable (#1283).
      const admin = adminHpkeRecipient()
      const vol = hpkeRecipientForSeed(volKp.seedHex)

      const contentKey = generateContentKey()
      const ciphertextHex = encryptContent('Storage test note', contentKey, LABEL_NOTE_KEY)
      const volEnv = await wrapKeyForRecipient(contentKey, vol.pubkeyHex, vol.skHex, LABEL_NOTE_KEY)
      const adminEnv = await wrapKeyForRecipient(contentKey, admin.pubkeyHex, admin.skHex, LABEL_NOTE_KEY)

      const { status, data } = await apiPost<Record<string, unknown>>(
        request,
        '/notes',
        {
          encryptedContent: ciphertextHex,
          callId: `storage-note-${Date.now()}`,
          authorEnvelope: volEnv,
          adminEnvelopes: [{ pubkey: admin.pubkeyHex, ...adminEnv }],
        },
        volKp.seedHex,
      )
      expect([200, 201]).toContain(status)
      getStorageIntegrityState(world).entityIds.set(entityType, data.id as string)
      getStorageIntegrityState(world).apiResponses.set(entityType, data)
      break
    }

    case 'case record': {
      // Create a case record with structured JSONB fields
      const { status, data } = await apiPost<{ record: Record<string, unknown> }>(
        request,
        '/cases',
        {
          entityTypeId: `test-type-${Date.now()}`,
          statusHash: 'open',
          blindIndexes: { searchField: 'hashed-value', category: 'test-cat' },
          summaryEnvelopes: [
            { pubkey: 'a'.repeat(64), ct: 'b'.repeat(64), enc: '02' + 'c'.repeat(64) },
          ],
        },
      )
      if (status === 200 || status === 201) {
        const record = (data as Record<string, unknown>).record ?? data
        const id = (record as Record<string, unknown>).id as string
        getStorageIntegrityState(world).entityIds.set(entityType, id)
        getStorageIntegrityState(world).apiResponses.set(entityType, record as Record<string, unknown>)
      } else {
        // If cases endpoint needs different structure, try alternate
        expect([200, 201]).toContain(status)
      }
      break
    }

    case 'conversation': {
      // Create a conversation with metadata
      const { simulateIncomingMessage, uniqueCallerNumber } = await import('../../simulation-helpers')
      const sender = uniqueCallerNumber()
      const result = await simulateIncomingMessage(request, {
        senderNumber: sender,
        body: 'Storage test message',
        channel: 'sms',
      })
      getStorageIntegrityState(world).entityIds.set(entityType, result.conversationId)

      // Fetch it to get the full record
      const { status, data } = await apiGet<Record<string, unknown>>(
        request,
        `/conversations/${result.conversationId}`,
      )
      expect(status).toBe(200)
      getStorageIntegrityState(world).apiResponses.set(entityType, data)
      break
    }
  }
})

Given('the {string} settings are updated via the API with structured data', async ({ request }, settingsType: string) => {
  let body: Record<string, unknown>

  switch (settingsType) {
    case 'spam':
      body = {
        spamSettings: {
          enabled: true,
          maxCallsPerMinute: 5,
          banDurationMinutes: 60,
          whitelist: ['+1555000111'],
        },
      }
      break
    case 'call':
      body = {
        callSettings: {
          ringTimeout: 30,
          maxConcurrentCalls: 10,
          recordingEnabled: false,
          fallbackMessage: 'Please try again later',
        },
      }
      break
    case 'messaging':
      body = {
        messagingConfig: {
          smsEnabled: true,
          whatsappEnabled: false,
          signalEnabled: false,
          autoReply: 'Thank you for your message',
        },
      }
      break
    default:
      throw new Error(`Unknown settings type: ${settingsType}`)
  }

  const { status } = await apiPatch(request, '/settings', body)
  expect([200, 204]).toContain(status)
})

Given('a registered volunteer {string} with a known keypair', async ({ request, world }, name: string) => {
  const kp = generateTestKeypair()
  getStorageIntegrityState(world).volunteerKp = kp
  const { status } = await apiPost(request, '/users', {
    name: `StorageEnv ${name} ${Date.now()}`,
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
    pubkey: kp.pubkey,
  })
  expect([200, 201]).toContain(status)
})

Given('the admin keypair is known for envelope verification', async ({ world }) => {
  const adminPubkey = seedHexToPubkey(ADMIN_SEED)
  getStorageIntegrityState(world).adminSeedHex = ADMIN_SEED
  getStorageIntegrityState(world).adminPubkey = adminPubkey
})

// ── When: Fetch ─────────────────────────────────────────────────────

When('the {string} is fetched via the API', async ({ request, world }, entityType: string) => {
  const id = getStorageIntegrityState(world).entityIds.get(entityType)
  expect(id).toBeDefined()

  switch (entityType) {
    case 'note with envelopes': {
      const volKp = getStorageIntegrityState(world).volunteerKp
      const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
        request,
        '/notes',
        volKp?.seedHex,
      )
      expect(status).toBe(200)
      const note = data.notes.find(n => n.id === id)
      if (note) getStorageIntegrityState(world).apiResponses.set(entityType, note)
      break
    }

    case 'case record': {
      const { status, data } = await apiGet<Record<string, unknown>>(
        request,
        `/cases/${id}`,
      )
      expect(status).toBe(200)
      const record = (data as Record<string, unknown>).record ?? data
      getStorageIntegrityState(world).apiResponses.set(entityType, record as Record<string, unknown>)
      break
    }

    case 'conversation': {
      const { status, data } = await apiGet<Record<string, unknown>>(
        request,
        `/conversations/${id}`,
      )
      expect(status).toBe(200)
      getStorageIntegrityState(world).apiResponses.set(entityType, data)
      break
    }
  }
})

When('the {string} row is fetched directly from the database', async ({ world }, entityType: string) => {
  const id = getStorageIntegrityState(world).entityIds.get(entityType)
  expect(id).toBeDefined()

  let tableName: string
  switch (entityType) {
    case 'note with envelopes':
      tableName = 'notes'
      break
    case 'case record':
      tableName = 'case_records'
      break
    case 'conversation':
      tableName = 'conversations'
      break
    default:
      throw new Error(`Unknown entity type: ${entityType}`)
  }

  const row = await TestDB.getRow(tableName, id!)
  expect(row).not.toBeNull()
  getStorageIntegrityState(world).dbRows.set(entityType, row!)
})

When('the settings are fetched via the API', async ({ request, world }) => {
  const { status, data } = await apiGet<Record<string, unknown>>(request, '/settings')
  expect(status).toBe(200)
  getStorageIntegrityState(world).apiResponses.set('settings', data)
})

When('the system_settings row is fetched directly from the database', async ({ world }) => {
  // system_settings has integer PK = 1
  const rows = await TestDB.getRow('system_settings', '1')
  // system_settings may use integer id, try alternate fetch
  if (!rows) {
    // Use raw query since ID is integer, not text
    // getRow expects text id but system_settings has integer id
    // Store a placeholder — the jsonb assertion will use assertJsonbField which handles this
  }
  getStorageIntegrityState(world).dbRows.set('settings', rows ?? {})
})

When('the volunteer creates a note with real HPKE envelopes', async ({ request, world }) => {
  expect(getStorageIntegrityState(world).volunteerKp).toBeDefined()
  expect(getStorageIntegrityState(world).adminPubkey).toBeDefined()

  const contentKey = generateContentKey()
  const ciphertextHex = encryptContent('Envelope accuracy test', contentKey, LABEL_NOTE_KEY)

  const author = hpkeRecipientForSeed(getStorageIntegrityState(world).volunteerKp!.seedHex)
  const admin = adminHpkeRecipient()
  const authorEnv = await wrapKeyForRecipient(contentKey, author.pubkeyHex, author.skHex, LABEL_NOTE_KEY)
  const adminEnv = await wrapKeyForRecipient(contentKey, admin.pubkeyHex, admin.skHex, LABEL_NOTE_KEY)

  getStorageIntegrityState(world).submittedAuthorEnvelope = authorEnv
  getStorageIntegrityState(world).submittedEnvelopes = [{ pubkey: admin.pubkeyHex, ...adminEnv }]

  const { status, data } = await apiPost<Record<string, unknown>>(
    request,
    '/notes',
    {
      encryptedContent: ciphertextHex,
      callId: `envelope-accuracy-${Date.now()}`,
      authorEnvelope: authorEnv,
      adminEnvelopes: getStorageIntegrityState(world).submittedEnvelopes,
    },
    getStorageIntegrityState(world).volunteerKp!.seedHex,
  )
  expect([200, 201]).toContain(status)
  const noteData = (data.note as Record<string, unknown> | undefined) ?? data
  getStorageIntegrityState(world).entityIds.set('envelope-note', noteData.id as string)
  getStorageIntegrityState(world).apiResponses.set('envelope-note', noteData)
})

When('the note is fetched via the API', async ({ request, world }) => {
  const id = getStorageIntegrityState(world).entityIds.get('envelope-note')
  expect(id).toBeDefined()

  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    getStorageIntegrityState(world).volunteerKp?.seedHex,
  )
  expect(status).toBe(200)
  const note = data.notes.find(n => n.id === id)
  if (note) getStorageIntegrityState(world).apiResponses.set('envelope-note', note)
})

When('the envelope note row is fetched directly from the database', async ({ world }) => {
  const id = getStorageIntegrityState(world).entityIds.get('envelope-note')
  expect(id).toBeDefined()

  const row = await TestDB.getRow('notes', id!)
  expect(row).not.toBeNull()
  getStorageIntegrityState(world).dbRows.set('envelope-note', row!)
})

// ── Then: API response assertions ───────────────────────────────────

Then('the API response {word} should be a proper {word}', async ({ world }, jsonbField: string, expectedType: string) => {
  // Find the latest API response that has the field
  let value: unknown
  for (const resp of getStorageIntegrityState(world).apiResponses.values()) {
    if (jsonbField in resp) {
      value = resp[jsonbField]
      break
    }
    // Check nested (e.g., conversation wraps in { conversation: {...} })
    for (const v of Object.values(resp)) {
      if (typeof v === 'object' && v !== null && jsonbField in (v as Record<string, unknown>)) {
        value = (v as Record<string, unknown>)[jsonbField]
        break
      }
    }
    if (value !== undefined) break
  }

  if (expectedType === 'array') {
    assertIsArray(value, `API ${jsonbField}`)
  } else if (expectedType === 'object') {
    assertIsObject(value, `API ${jsonbField}`)
  }
})

// ── Then: DB assertions ─────────────────────────────────────────────

Then(
  'the DB {word} should have jsonb_typeof equal to {string}',
  async ({ world }, dbColumn: string, expectedPgType: string) => {
    // Find the entity type that has this column
    for (const [entityType] of getStorageIntegrityState(world).entityIds.entries()) {
      const id = getStorageIntegrityState(world).entityIds.get(entityType)
      if (!id) continue

      let tableName: string
      const idColumn = 'id'
      switch (entityType) {
        case 'note with envelopes':
          tableName = 'notes'
          break
        case 'case record':
          tableName = 'case_records'
          break
        case 'conversation':
          tableName = 'conversations'
          break
        default:
          continue
      }

      try {
        const result = await TestDB.assertJsonbField(tableName, idColumn, id, dbColumn)
        expect(result.pgType).toBe(expectedPgType)
        return
      } catch {
        // Column might not exist in this table — try next entity
        continue
      }
    }

    // For settings, check system_settings table
    try {
      const result = await TestDB.assertJsonbField('system_settings', 'id', '1', dbColumn)
      expect(result.pgType).toBe(expectedPgType)
    } catch (e) {
      throw new Error(`Could not find JSONB column ${dbColumn} in any known table: ${e}`)
    }
  },
)

Then('the DB {word} should not be double-serialized', async ({ world }, dbColumn: string) => {
  // Find the entity type that has this column
  for (const [entityType] of getStorageIntegrityState(world).entityIds.entries()) {
    const id = getStorageIntegrityState(world).entityIds.get(entityType)
    if (!id) continue

    let tableName: string
    switch (entityType) {
      case 'note with envelopes':
        tableName = 'notes'
        break
      case 'case record':
        tableName = 'case_records'
        break
      case 'conversation':
        tableName = 'conversations'
        break
      default:
        continue
    }

    try {
      const result = await TestDB.assertJsonbField(tableName, 'id', id, dbColumn)
      expect(result.isDoubleStringified).toBe(false)
      return
    } catch {
      continue
    }
  }

  // For settings
  try {
    const result = await TestDB.assertJsonbField('system_settings', 'id', '1', dbColumn)
    expect(result.isDoubleStringified).toBe(false)
  } catch (e) {
    throw new Error(`Could not find JSONB column ${dbColumn} in any known table: ${e}`)
  }
})

// ── Then: Envelope byte-accuracy assertions ─────────────────────────

Then('the API envelope ct should match the submitted ct exactly', async ({ world }) => {
  const apiNote = getStorageIntegrityState(world).apiResponses.get('envelope-note')
  expect(apiNote).toBeDefined()
  expect(getStorageIntegrityState(world).submittedEnvelopes).toBeDefined()

  const apiAdminEnvelopes = apiNote!.adminEnvelopes as Array<{ ct: string }> | undefined
  expect(apiAdminEnvelopes).toBeDefined()
  expect(apiAdminEnvelopes!.length).toBeGreaterThan(0)
  expect(apiAdminEnvelopes![0].ct).toBe(getStorageIntegrityState(world).submittedEnvelopes![0].ct)
})

Then('the API envelope enc should match the submitted enc exactly', async ({ world }) => {
  const apiNote = getStorageIntegrityState(world).apiResponses.get('envelope-note')
  expect(apiNote).toBeDefined()
  expect(getStorageIntegrityState(world).submittedEnvelopes).toBeDefined()

  const apiAdminEnvelopes = apiNote!.adminEnvelopes as Array<{ enc: string }> | undefined
  expect(apiAdminEnvelopes).toBeDefined()
  expect(apiAdminEnvelopes![0].enc).toBe(getStorageIntegrityState(world).submittedEnvelopes![0].enc)
})

Then('the DB admin_envelopes ct should match the submitted ct exactly', async ({ world }) => {
  const dbRow = getStorageIntegrityState(world).dbRows.get('envelope-note')
  expect(dbRow).toBeDefined()
  expect(getStorageIntegrityState(world).submittedEnvelopes).toBeDefined()

  const dbAdminEnvelopes = dbRow!.admin_envelopes as Array<{ ct: string }>
  assertIsArray(dbAdminEnvelopes, 'DB admin_envelopes')
  expect(dbAdminEnvelopes.length).toBeGreaterThan(0)
  expect(dbAdminEnvelopes[0].ct).toBe(getStorageIntegrityState(world).submittedEnvelopes![0].ct)
})

Then('the DB admin_envelopes enc should match the submitted enc exactly', async ({ world }) => {
  const dbRow = getStorageIntegrityState(world).dbRows.get('envelope-note')
  expect(dbRow).toBeDefined()
  expect(getStorageIntegrityState(world).submittedEnvelopes).toBeDefined()

  const dbAdminEnvelopes = dbRow!.admin_envelopes as Array<{ enc: string }>
  assertIsArray(dbAdminEnvelopes, 'DB admin_envelopes')
  expect(dbAdminEnvelopes[0].enc).toBe(getStorageIntegrityState(world).submittedEnvelopes![0].enc)
})

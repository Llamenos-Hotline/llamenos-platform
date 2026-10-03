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
  /** Sub-resource path used by the last "the {settingsType} settings are updated..." step */
  settingsPath?: string
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

/** Dummy 64-char hex value for HPKE enc field — satisfies hpkeEncSchema validation in tests */
const DUMMY_ENC = '0'.repeat(64)

/**
 * The storage-integrity.feature Examples tables name entityTypes like
 * "note adminEnvelopes" and "record blindIndexes" — the prefix identifies
 * which table/API the row lives in, the suffix identifies which JSONB column
 * the scenario is actually checking.
 */
function tableForEntityType(entityType: string): string {
  if (entityType.startsWith('note ')) return 'notes'
  if (entityType.startsWith('record ')) return 'case_records'
  if (entityType.startsWith('conversation')) return 'conversations'
  throw new Error(`Unknown entityType for JSONB round-trip: ${entityType}`)
}

// ── Given: Entity creation ──────────────────────────────────────────

Given('a {string} entity is created via the API with structured JSONB data', async ({ request, world, workerHub }, entityType: string) => {
  const state = getStorageIntegrityState(world)

  if (entityType === 'note adminEnvelopes' || entityType === 'note authorEnvelope') {
    // Create a real volunteer first with a known keypair
    const volKp = generateTestKeypair()
    state.volunteerKp = volKp
    const regResult = await apiPost(request, '/users', {
      name: `StorageVol ${Date.now()}`,
      phone: uniquePhone(),
      roleIds: ['role-volunteer'],
      pubkey: volKp.pubkey,
    })
    expect([200, 201]).toContain(regResult.status)

    const adminSeedHex = ADMIN_SEED
    const adminPubkey = seedHexToPubkey(adminSeedHex)
    state.adminSeedHex = adminSeedHex
    state.adminPubkey = adminPubkey

    const contentKey = generateContentKey()
    const ciphertextHex = encryptContent('Storage test note', contentKey, LABEL_NOTE_KEY)
    const volEnv = await wrapKeyForRecipient(contentKey, volKp.pubkey, volKp.seedHex, LABEL_NOTE_KEY)
    const adminEnv = await wrapKeyForRecipient(contentKey, adminPubkey, adminSeedHex, LABEL_NOTE_KEY)

    const { status, data } = await apiPost<Record<string, unknown>>(
      request,
      '/notes',
      {
        encryptedContent: ciphertextHex,
        callId: `storage-note-${Date.now()}`,
        authorEnvelope: volEnv,
        adminEnvelopes: [{ pubkey: adminPubkey, ...adminEnv }],
      },
      volKp.seedHex,
    )
    expect([200, 201]).toContain(status)
    const noteData = (data.note as Record<string, unknown> | undefined) ?? data
    state.entityIds.set(entityType, noteData.id as string)
    state.apiResponses.set(entityType, noteData)
    return
  }

  if (entityType === 'record blindIndexes' || entityType === 'record summaryEnvelopes') {
    const adminPubkey = seedHexToPubkey(ADMIN_SEED)
    state.adminPubkey = adminPubkey

    // Records require a real entityTypeId (uuid) — there is no standalone
    // /cases endpoint anymore, everything goes through the unified /records API.
    const etRes = await apiPost<{ id: string }>(request, '/settings/cms/entity-types', {
      name: `storage_test_type_${Date.now()}`,
      label: 'Storage Test Type',
      labelPlural: 'Storage Test Types',
      category: 'case',
      fields: [],
      statuses: [{ value: 'active', label: 'Active', isDefault: true }],
      defaultStatus: 'active',
    })
    expect(etRes.status).toBe(201)

    const { status, data } = await apiPost<Record<string, unknown>>(
      request,
      '/records',
      {
        entityTypeId: etRes.data.id,
        statusHash: 'active',
        encryptedSummary: 'storage-test-summary',
        summaryEnvelopes: [{ pubkey: adminPubkey, enc: DUMMY_ENC, ct: 'storage-test-ct' }],
        blindIndexes: { category: ['storage-test'] },
      },
    )
    expect([200, 201]).toContain(status)
    state.entityIds.set(entityType, data.id as string)
    state.apiResponses.set(entityType, data)
    return
  }

  if (entityType === 'conversation metadata') {
    // Create a conversation via the normal inbound-webhook path. Pass the
    // worker's isolated hub explicitly — matches how every other passing
    // simulateIncomingMessage call in this suite scopes its conversation
    // (see messaging.steps.ts), instead of leaving the conversation's hubId
    // null.
    const { simulateIncomingMessage, uniqueCallerNumber } = await import('../../simulation-helpers')
    const sender = uniqueCallerNumber()
    const result = await simulateIncomingMessage(request, {
      senderNumber: sender,
      body: 'Storage test message',
      channel: 'sms',
      hubId: workerHub,
    })
    state.entityIds.set(entityType, result.conversationId)

    // Inbound webhook creation leaves `metadata` null — give it structured
    // data so this is an actual JSONB round-trip, not a null column.
    const patchRes = await apiPatch<Record<string, unknown>>(
      request,
      `/conversations/${result.conversationId}`,
      { metadata: { source: 'storage-test', tags: ['integrity'] } },
    )
    expect(patchRes.status).toBe(200)

    // Fetch it to get the full record
    const { status, data } = await apiGet<Record<string, unknown>>(
      request,
      `/conversations/${result.conversationId}`,
    )
    expect(status).toBe(200)
    state.apiResponses.set(entityType, data)
    return
  }

  throw new Error(`Unknown entityType for JSONB round-trip: ${entityType}`)
})

Given('the {string} settings are updated via the API with structured data', async ({ request, world }, settingsType: string) => {
  // There is no aggregate /settings endpoint — each settings type has its own
  // sub-resource (GET/PATCH /settings/spam, /settings/call, /settings/messaging),
  // validated against its own schema. The old version of this step PATCHed a
  // non-existent /settings with field names that don't exist on any of these
  // schemas; it 404'd and was never caught because the scenario was @wip.
  let path: string
  let body: Record<string, unknown>

  switch (settingsType) {
    case 'spam':
      path = '/settings/spam'
      body = {
        voiceCaptchaEnabled: true,
        rateLimitEnabled: true,
        maxCallsPerMinute: 5,
        blockDurationMinutes: 60,
      }
      break
    case 'call':
      path = '/settings/call'
      body = {
        queueTimeoutSeconds: 60,
        voicemailMaxSeconds: 90,
      }
      break
    case 'messaging':
      path = '/settings/messaging'
      body = {
        autoAssignEnabled: true,
        maxConcurrentPerUser: 5,
        inactivityTimeout: 30,
        welcomeMessage: 'A volunteer will respond shortly.',
      }
      break
    default:
      throw new Error(`Unknown settings type: ${settingsType}`)
  }

  const { status } = await apiPatch(request, path, body)
  expect([200, 204]).toContain(status)
  getStorageIntegrityState(world).settingsPath = path
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
  const state = getStorageIntegrityState(world)
  const id = state.entityIds.get(entityType)
  expect(id).toBeDefined()

  if (entityType === 'note adminEnvelopes' || entityType === 'note authorEnvelope') {
    const volKp = state.volunteerKp
    const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
      request,
      '/notes',
      volKp?.seedHex,
    )
    expect(status).toBe(200)
    const note = data.notes.find(n => n.id === id)
    if (note) state.apiResponses.set(entityType, note)
    return
  }

  if (entityType === 'record blindIndexes' || entityType === 'record summaryEnvelopes') {
    const { status, data } = await apiGet<Record<string, unknown>>(request, `/records/${id}`)
    expect(status).toBe(200)
    state.apiResponses.set(entityType, data)
    return
  }

  if (entityType === 'conversation metadata') {
    const { status, data } = await apiGet<Record<string, unknown>>(request, `/conversations/${id}`)
    expect(status).toBe(200)
    state.apiResponses.set(entityType, data)
    return
  }

  throw new Error(`Unknown entityType for JSONB round-trip: ${entityType}`)
})

When('the {string} row is fetched directly from the database', async ({ world }, entityType: string) => {
  const state = getStorageIntegrityState(world)
  const id = state.entityIds.get(entityType)
  expect(id).toBeDefined()

  const row = await TestDB.getRow(tableForEntityType(entityType), id!)
  expect(row).not.toBeNull()
  state.dbRows.set(entityType, row!)
})

/** Each settings sub-resource returns its settings flatly at its own path —
 * there is no aggregate /settings envelope. Map back to the jsonbField name
 * the feature's generic "API response {field} should be a proper object"
 * step looks for, so that check still examines the real response body. */
const SETTINGS_PATH_TO_JSONB_FIELD: Record<string, string> = {
  '/settings/spam': 'spamSettings',
  '/settings/call': 'callSettings',
  '/settings/messaging': 'messagingConfig',
}

When('the settings are fetched via the API', async ({ request, world }) => {
  const path = getStorageIntegrityState(world).settingsPath
  expect(path).toBeDefined()
  const { status, data } = await apiGet<Record<string, unknown>>(request, path!)
  expect(status).toBe(200)
  const jsonbField = SETTINGS_PATH_TO_JSONB_FIELD[path!]
  getStorageIntegrityState(world).apiResponses.set('settings', jsonbField ? { [jsonbField]: data } : data)
})

When('the system_settings row is fetched directly from the database', async ({ world }) => {
  // system_settings has integer PK = 1
  const rows = await TestDB.getRow('system_settings', '1')
  getStorageIntegrityState(world).dbRows.set('settings', rows ?? {})
})

When('the volunteer creates a note with real HPKE envelopes', async ({ request, world }) => {
  expect(getStorageIntegrityState(world).volunteerKp).toBeDefined()
  expect(getStorageIntegrityState(world).adminPubkey).toBeDefined()

  const contentKey = generateContentKey()
  const ciphertextHex = encryptContent('Envelope accuracy test', contentKey, LABEL_NOTE_KEY)

  const authorEnv = await wrapKeyForRecipient(contentKey, getStorageIntegrityState(world).volunteerKp!.pubkey, getStorageIntegrityState(world).volunteerKp!.seedHex, LABEL_NOTE_KEY)
  const adminEnv = await wrapKeyForRecipient(contentKey, getStorageIntegrityState(world).adminPubkey!, getStorageIntegrityState(world).adminSeedHex!, LABEL_NOTE_KEY)

  getStorageIntegrityState(world).submittedAuthorEnvelope = authorEnv
  getStorageIntegrityState(world).submittedEnvelopes = [{ pubkey: getStorageIntegrityState(world).adminPubkey!, ...adminEnv }]

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
    const state = getStorageIntegrityState(world)
    // Find the entity type that has this column
    for (const [entityType, id] of state.entityIds.entries()) {
      if (!id) continue
      let tableName: string
      try {
        tableName = tableForEntityType(entityType)
      } catch {
        continue
      }

      try {
        const result = await TestDB.assertJsonbField(tableName, 'id', id, dbColumn)
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
  const state = getStorageIntegrityState(world)
  // Find the entity type that has this column
  for (const [entityType, id] of state.entityIds.entries()) {
    if (!id) continue
    let tableName: string
    try {
      tableName = tableForEntityType(entityType)
    } catch {
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

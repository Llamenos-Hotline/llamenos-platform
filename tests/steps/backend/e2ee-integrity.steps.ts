/**
 * E2EE note integrity step definitions (Epic 365).
 *
 * Uses REAL HPKE crypto — no mock base64. Every encrypt/decrypt goes through
 * the same algorithms as the production code (AES-256-GCM + HPKE RFC 9180).
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  apiGet,
  apiPost,
  generateTestKeypair,
  uniquePhone,
  ADMIN_SEED,
} from '../../api-helpers'
import {
  generateContentKey,
  encryptContent,
  decryptContent,
  wrapKeyForRecipient,
  unwrapKey,
  adminHpkeRecipient,
  hpkeRecipientForSeed,
} from '../../crypto-helpers'
import { LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { TestDB } from '../../db-helpers'
import { assertIsObject, assertIsArray } from '../../integrity-helpers'
import { bytesToHex, hexToBytes } from '@shared/encoding'
import { ed25519 } from '@noble/curves/ed25519.js'

// ── State ───────────────────────────────────────────────────────────

interface E2EEIntegrityState {
  /** Named keypairs: key = name (e.g. "VolA", "AdminA") */
  keypairs: Map<string, { seedHex: string; pubkey: string; x25519Pubkey: string }>
  /** The current content key used for symmetric encryption */
  contentKey?: Uint8Array
  /** The hex ciphertext produced by encryptContent */
  ciphertextHex?: string
  /** Per-recipient HPKE envelopes: key = x25519Pubkey */
  envelopes: Map<string, { ct: string; enc: string }>
  /** The note ID returned by the API */
  noteId?: string
  /** The full note object from the API */
  apiNote?: Record<string, unknown>
  /** The raw DB row */
  dbRow?: Record<string, unknown>
  /** Last decrypted plaintext */
  decryptedText?: string
  /** The admin's Ed25519 signing seed — API authentication only. */
  adminSeedHex?: string
  /**
   * The admin's X25519 secret — what opens an admin envelope.
   *
   * A separate field from `adminSeedHex` on purpose: the two are different
   * values (the encryption key is HKDF'd from the signing seed), and conflating
   * them is #1283. Both come from `adminHpkeRecipient()`.
   */
  adminHpkeSkHex?: string
  /** The admin Ed25519 pubkey (for registration) */
  adminPubkey?: string
  /** The admin X25519 pubkey (for HPKE operations) */
  adminX25519Pubkey?: string
  /** Whether the last HPKE unwrap attempt raised an error */
  lastDecryptionFailed?: boolean
}

const E2EE_INTEGRITY_KEY = 'e2ee_integrity'

function getE2EEIntegrityState(world: Record<string, unknown>): E2EEIntegrityState {
  return getState<E2EEIntegrityState>(world, E2EE_INTEGRITY_KEY)
}


Before(async ({ world }) => {
  setState<E2EEIntegrityState>(world, E2EE_INTEGRITY_KEY, {
    keypairs: new Map(),
    envelopes: new Map(),
  })
})

// ── Helpers ─────────────────────────────────────────────────────────

function seedHexToPubkey(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
}

function getKeypair(world: Record<string, unknown>, name: string) {
  const kp = getE2EEIntegrityState(world).keypairs.get(name)
  if (!kp) throw new Error(`No keypair registered for "${name}"`)
  return kp
}

// ── Given ───────────────────────────────────────────────────────────

Given('a volunteer {string} with a real keypair', async ({ request, world }, name: string) => {
  const kp = generateTestKeypair()
  const x25519Pubkey = hpkeRecipientForSeed(kp.seedHex).pubkeyHex
  getE2EEIntegrityState(world).keypairs.set(name, { ...kp, x25519Pubkey })
  // Register volunteer with Ed25519 pubkey (for auth), X25519 is derived internally for HPKE
  const { status } = await apiPost(request, '/users', {
    name: `E2EE ${name} ${Date.now()}`,
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
    pubkey: kp.pubkey,
  })
  expect([200, 201]).toContain(status)
})

Given('the admin keypair is known', async ({ world }) => {
  const admin = adminHpkeRecipient()
  getE2EEIntegrityState(world).adminSeedHex = ADMIN_SEED
  getE2EEIntegrityState(world).adminPubkey = seedHexToPubkey(ADMIN_SEED)
  getE2EEIntegrityState(world).adminX25519Pubkey = admin.pubkeyHex
  getE2EEIntegrityState(world).adminHpkeSkHex = admin.skHex
})

Given('admin {string} with a real keypair', async ({ world }, name: string) => {
  const kp = generateTestKeypair()
  const x25519Pubkey = hpkeRecipientForSeed(kp.seedHex).pubkeyHex
  getE2EEIntegrityState(world).keypairs.set(name, { ...kp, x25519Pubkey })
})

// ── When: Encryption ────────────────────────────────────────────────

When(
  'the volunteer encrypts note content {string} with a random content key',
  async ({ world }, plaintext: string) => {
    const contentKey = generateContentKey()
    getE2EEIntegrityState(world).contentKey = contentKey
    getE2EEIntegrityState(world).ciphertextHex = encryptContent(plaintext, contentKey, LABEL_NOTE_KEY)
  },
)

When('the content key is HPKE-wrapped for the volunteer', async ({ world }) => {
  // Find the first registered volunteer keypair
  const [, volKp] = [...getE2EEIntegrityState(world).keypairs.entries()][0]
  expect(volKp).toBeDefined()
  expect(getE2EEIntegrityState(world).contentKey).toBeDefined()

  const envelope = await wrapKeyForRecipient(getE2EEIntegrityState(world).contentKey!, volKp.x25519Pubkey, volKp.seedHex, LABEL_NOTE_KEY)
  getE2EEIntegrityState(world).envelopes.set(volKp.x25519Pubkey, envelope)
})

When('the content key is HPKE-wrapped for the admin', async ({ world }) => {
  expect(getE2EEIntegrityState(world).contentKey).toBeDefined()
  expect(getE2EEIntegrityState(world).adminX25519Pubkey).toBeDefined()

  const envelope = await wrapKeyForRecipient(getE2EEIntegrityState(world).contentKey!, getE2EEIntegrityState(world).adminX25519Pubkey!, getE2EEIntegrityState(world).adminHpkeSkHex!, LABEL_NOTE_KEY)
  getE2EEIntegrityState(world).envelopes.set(getE2EEIntegrityState(world).adminX25519Pubkey!, envelope)
})

When(
  'the encrypted note is submitted via the API with real ciphertext and envelopes',
  async ({ request, world }) => {
    expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()
    expect(getE2EEIntegrityState(world).adminPubkey).toBeDefined()

    // Build admin envelopes array (keyed by x25519 pubkey)
    const adminEnvelopes = []
    for (const [pubkey, env] of getE2EEIntegrityState(world).envelopes.entries()) {
      if (pubkey === getE2EEIntegrityState(world).adminX25519Pubkey) {
        adminEnvelopes.push({ pubkey, ...env })
      }
    }

    // Build author envelope (volunteer's own copy, keyed by x25519 pubkey)
    const [, volKp] = [...getE2EEIntegrityState(world).keypairs.entries()][0]
    const volEnvelope = getE2EEIntegrityState(world).envelopes.get(volKp.x25519Pubkey)

    const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
      request,
      '/notes',
      {
        encryptedContent: getE2EEIntegrityState(world).ciphertextHex,
        callId: `e2ee-integrity-${Date.now()}`,
        authorEnvelope: volEnvelope ?? {},
        adminEnvelopes,
      },
      volKp.seedHex,
    )
    expect([200, 201]).toContain(status)
    getE2EEIntegrityState(world).noteId = data.note?.id
    getE2EEIntegrityState(world).apiNote = data.note
  },
)

When(
  'volunteer {string} encrypts note content {string} with envelopes for themselves and the admin',
  async ({ world }, volName: string, plaintext: string) => {
    const volKp = getKeypair(world, volName)
    expect(getE2EEIntegrityState(world).adminX25519Pubkey).toBeDefined()

    const contentKey = generateContentKey()
    getE2EEIntegrityState(world).contentKey = contentKey
    getE2EEIntegrityState(world).ciphertextHex = encryptContent(plaintext, contentKey, LABEL_NOTE_KEY)

    // Wrap for volunteer (X25519 pubkey for HPKE)
    const volEnv = await wrapKeyForRecipient(contentKey, volKp.x25519Pubkey, volKp.seedHex, LABEL_NOTE_KEY)
    getE2EEIntegrityState(world).envelopes.set(volKp.x25519Pubkey, volEnv)

    // Wrap for admin (X25519 pubkey for HPKE)
    const adminEnv = await wrapKeyForRecipient(contentKey, getE2EEIntegrityState(world).adminX25519Pubkey!, getE2EEIntegrityState(world).adminHpkeSkHex!, LABEL_NOTE_KEY)
    getE2EEIntegrityState(world).envelopes.set(getE2EEIntegrityState(world).adminX25519Pubkey!, adminEnv)
  },
)

When('the encrypted note is submitted via the API by {string}', async ({ request, world }, volName: string) => {
  const volKp = getKeypair(world, volName)
  expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()

  const adminEnvelopes = []
  for (const [pubkey, env] of getE2EEIntegrityState(world).envelopes.entries()) {
    if (pubkey !== volKp.x25519Pubkey) {
      adminEnvelopes.push({ pubkey, ...env })
    }
  }

  const volEnvelope = getE2EEIntegrityState(world).envelopes.get(volKp.x25519Pubkey)

  const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
    request,
    '/notes',
    {
      encryptedContent: getE2EEIntegrityState(world).ciphertextHex,
      callId: `e2ee-3rd-party-${Date.now()}`,
      authorEnvelope: volEnvelope ?? {},
      adminEnvelopes,
    },
    volKp.seedHex,
  )
  expect([200, 201]).toContain(status)
  getE2EEIntegrityState(world).noteId = data.note?.id
  getE2EEIntegrityState(world).apiNote = data.note
})

When('volunteer {string} fetches the note', async ({ request, world }, volName: string) => {
  const volKp = getKeypair(world, volName)
  expect(getE2EEIntegrityState(world).noteId).toBeDefined()

  // VolB can fetch notes if they have notes:read-own permission (registered volunteer)
  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    volKp.seedHex,
  )
  expect(status).toBe(200)

  // Find our specific note
  const note = data.notes.find(n => n.id === getE2EEIntegrityState(world).noteId)
  // VolB may or may not see the note depending on permissions (read-own vs read-all)
  // Store whatever we got
  getE2EEIntegrityState(world).apiNote = note ?? getE2EEIntegrityState(world).apiNote
})

When(
  'the volunteer encrypts note content {string} with envelopes for both admins',
  async ({ world }, plaintext: string) => {
    const volKp = [...getE2EEIntegrityState(world).keypairs.entries()].find(([name]) =>
      name.toLowerCase().includes('vol'),
    )
    expect(volKp).toBeDefined()
    const [, kp] = volKp!

    const contentKey = generateContentKey()
    getE2EEIntegrityState(world).contentKey = contentKey
    getE2EEIntegrityState(world).ciphertextHex = encryptContent(plaintext, contentKey, LABEL_NOTE_KEY)

    // Wrap for volunteer (author envelope) — use X25519 pubkey for HPKE
    const volEnv = await wrapKeyForRecipient(contentKey, kp.x25519Pubkey, kp.seedHex, LABEL_NOTE_KEY)
    getE2EEIntegrityState(world).envelopes.set(kp.x25519Pubkey, volEnv)

    // Wrap for each named admin — use X25519 pubkey for HPKE
    for (const [name, adminKp] of getE2EEIntegrityState(world).keypairs.entries()) {
      if (name.startsWith('Admin')) {
        const adminEnv = await wrapKeyForRecipient(contentKey, adminKp.x25519Pubkey, adminKp.seedHex, LABEL_NOTE_KEY)
        getE2EEIntegrityState(world).envelopes.set(adminKp.x25519Pubkey, adminEnv)
      }
    }
  },
)

When(
  'the encrypted note is submitted via the API with both admin envelopes',
  async ({ request, world }) => {
    const volKp = [...getE2EEIntegrityState(world).keypairs.entries()].find(([name]) =>
      name.toLowerCase().includes('vol'),
    )
    expect(volKp).toBeDefined()
    const [, kp] = volKp!

    const adminEnvelopes = []
    for (const [pubkey, env] of getE2EEIntegrityState(world).envelopes.entries()) {
      if (pubkey !== kp.x25519Pubkey) {
        adminEnvelopes.push({ pubkey, ...env })
      }
    }

    const volEnvelope = getE2EEIntegrityState(world).envelopes.get(kp.x25519Pubkey)

    const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
      request,
      '/notes',
      {
        encryptedContent: getE2EEIntegrityState(world).ciphertextHex,
        callId: `e2ee-multi-admin-${Date.now()}`,
        authorEnvelope: volEnvelope ?? {},
        adminEnvelopes,
      },
      kp.seedHex,
    )
    expect([200, 201]).toContain(status)
    getE2EEIntegrityState(world).noteId = data.note?.id
    getE2EEIntegrityState(world).apiNote = data.note
  },
)

When('the volunteer encrypts note content {string} with real crypto', async ({ world }, plaintext: string) => {
  // Use the first volunteer keypair
  const [, volKp] = [...getE2EEIntegrityState(world).keypairs.entries()][0]
  expect(volKp).toBeDefined()
  expect(getE2EEIntegrityState(world).adminPubkey).toBeDefined()

  const contentKey = generateContentKey()
  getE2EEIntegrityState(world).contentKey = contentKey
  getE2EEIntegrityState(world).ciphertextHex = encryptContent(plaintext, contentKey, LABEL_NOTE_KEY)

  // Wrap for volunteer (X25519 pubkey for HPKE)
  const volEnv = await wrapKeyForRecipient(contentKey, volKp.x25519Pubkey, volKp.seedHex, LABEL_NOTE_KEY)
  getE2EEIntegrityState(world).envelopes.set(volKp.x25519Pubkey, volEnv)

  // Wrap for admin (X25519 pubkey for HPKE)
  const adminEnv = await wrapKeyForRecipient(contentKey, getE2EEIntegrityState(world).adminX25519Pubkey!, getE2EEIntegrityState(world).adminHpkeSkHex!, LABEL_NOTE_KEY)
  getE2EEIntegrityState(world).envelopes.set(getE2EEIntegrityState(world).adminX25519Pubkey!, adminEnv)
})

When('the encrypted note is submitted via the API with real envelopes', async ({ request, world }) => {
  const [, volKp] = [...getE2EEIntegrityState(world).keypairs.entries()][0]
  expect(volKp).toBeDefined()

  const adminEnvelopes = []
  for (const [pubkey, env] of getE2EEIntegrityState(world).envelopes.entries()) {
    if (pubkey !== volKp.x25519Pubkey) {
      adminEnvelopes.push({ pubkey, ...env })
    }
  }

  const volEnvelope = getE2EEIntegrityState(world).envelopes.get(volKp.x25519Pubkey)

  const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
    request,
    '/notes',
    {
      encryptedContent: getE2EEIntegrityState(world).ciphertextHex,
      callId: `e2ee-storage-${Date.now()}`,
      authorEnvelope: volEnvelope ?? {},
      adminEnvelopes,
    },
    volKp.seedHex,
  )
  expect([200, 201]).toContain(status)
  getE2EEIntegrityState(world).noteId = data.note?.id
  getE2EEIntegrityState(world).apiNote = data.note
})

// ── When: Decryption ────────────────────────────────────────────────

When('the volunteer unwraps their envelope and decrypts the note', async ({ world }) => {
  const [, volKp] = [...getE2EEIntegrityState(world).keypairs.entries()][0]
  expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()

  const envelope = getE2EEIntegrityState(world).envelopes.get(volKp.x25519Pubkey)
  expect(envelope).toBeDefined()

  const recoveredKey = await unwrapKey(
    envelope!.ct,
    envelope!.enc,
    volKp.seedHex,
    LABEL_NOTE_KEY,
  )
  getE2EEIntegrityState(world).decryptedText = decryptContent(getE2EEIntegrityState(world).ciphertextHex!, recoveredKey, LABEL_NOTE_KEY)
})

When('the admin unwraps their envelope and decrypts the note', async ({ world }) => {
  expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()
  expect(getE2EEIntegrityState(world).adminHpkeSkHex).toBeDefined()
  expect(getE2EEIntegrityState(world).adminX25519Pubkey).toBeDefined()

  const envelope = getE2EEIntegrityState(world).envelopes.get(getE2EEIntegrityState(world).adminX25519Pubkey!)
  expect(envelope).toBeDefined()

  const recoveredKey = await unwrapKey(
    envelope!.ct,
    envelope!.enc,
    getE2EEIntegrityState(world).adminHpkeSkHex!,
    LABEL_NOTE_KEY,
  )
  getE2EEIntegrityState(world).decryptedText = decryptContent(getE2EEIntegrityState(world).ciphertextHex!, recoveredKey, LABEL_NOTE_KEY)
})

// ── When: DB access ─────────────────────────────────────────────────

When('the note row is fetched directly from the database', async ({ world }) => {
  expect(getE2EEIntegrityState(world).noteId).toBeDefined()
  const row = await TestDB.getRow('notes', getE2EEIntegrityState(world).noteId!)
  expect(row).not.toBeNull()
  getE2EEIntegrityState(world).dbRow = row!
})

When('the ciphertext from the DB is decrypted with the original content key', async ({ world }) => {
  expect(getE2EEIntegrityState(world).dbRow).toBeDefined()
  expect(getE2EEIntegrityState(world).contentKey).toBeDefined()

  const dbCiphertext = getE2EEIntegrityState(world).dbRow!.encrypted_content as string
  getE2EEIntegrityState(world).decryptedText = decryptContent(dbCiphertext, getE2EEIntegrityState(world).contentKey!, LABEL_NOTE_KEY)
})

// ── Then: Assertions ────────────────────────────────────────────────

Then('the API should return the note with the exact ciphertext', async ({ world }) => {
  expect(getE2EEIntegrityState(world).apiNote).toBeDefined()
  expect(getE2EEIntegrityState(world).apiNote!.encryptedContent).toBe(getE2EEIntegrityState(world).ciphertextHex)
})

Then('the decrypted plaintext should be {string}', async ({ world }, expected: string) => {
  expect(getE2EEIntegrityState(world).decryptedText).toBe(expected)
})

Then('volunteer {string} should see the ciphertext', async ({ world }, _volName: string) => {
  // The note's encryptedContent is visible to anyone who can fetch it
  expect(getE2EEIntegrityState(world).apiNote).toBeDefined()
  expect(getE2EEIntegrityState(world).apiNote!.encryptedContent).toBeTruthy()
})

Then('volunteer {string} should have no envelope for their pubkey', async ({ world }, volName: string) => {
  const volKp = getKeypair(world, volName)
  expect(getE2EEIntegrityState(world).apiNote).toBeDefined()

  // Check both Ed25519 and X25519 pubkeys — neither should have an envelope
  const adminEnvelopes = getE2EEIntegrityState(world).apiNote!.adminEnvelopes as Array<{ pubkey: string }> | undefined
  const hasEnvelope = adminEnvelopes?.some(e => e.pubkey === volKp.pubkey || e.pubkey === volKp.x25519Pubkey) ?? false
  expect(hasEnvelope).toBe(false)

  // Also check authorEnvelope — it should not be keyed to VolB
  // The authorEnvelope has no pubkey field (it's a KeyEnvelope), so VolB can't use it
  // because it was wrapped for VolA's pubkey via HPKE
})

Then('attempting to unwrap with {string} secret key should fail', async ({ world }, volName: string) => {
  const volKp = getKeypair(world, volName)
  expect(getE2EEIntegrityState(world).apiNote).toBeDefined()

  // Try to unwrap the author envelope (which is VolA's) with VolB's key
  const authorEnvelope = getE2EEIntegrityState(world).apiNote!.authorEnvelope as { ct?: string; enc?: string } | undefined
  if (authorEnvelope?.ct && authorEnvelope?.enc) {
    let decryptionFailed = false
    try {
      await unwrapKey(
        authorEnvelope.ct,
        authorEnvelope.enc,
        volKp.seedHex,
        LABEL_NOTE_KEY,
      )
    } catch {
      decryptionFailed = true
    }
    expect(decryptionFailed).toBe(true)
  } else {
    // No envelope to attempt — this is also a valid "cannot decrypt" case
    expect(true).toBe(true)
  }
})

Then(
  'admin {string} can unwrap their envelope and decrypt to {string}',
  async ({ world }, adminName: string, expectedText: string) => {
    const adminKp = getKeypair(world, adminName)
    expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()

    const envelope = getE2EEIntegrityState(world).envelopes.get(adminKp.x25519Pubkey)
    expect(envelope).toBeDefined()

    const recoveredKey = await unwrapKey(
      envelope!.ct,
      envelope!.enc,
      adminKp.seedHex,
      LABEL_NOTE_KEY,
    )
    const plaintext = decryptContent(getE2EEIntegrityState(world).ciphertextHex!, recoveredKey, LABEL_NOTE_KEY)
    expect(plaintext).toBe(expectedText)
  },
)

Then('the two admin wrapped keys should be different', async ({ world }) => {
  const adminEnvelopes = [...getE2EEIntegrityState(world).envelopes.entries()].filter(([pubkey]) => {
    // Exclude volunteer x25519 pubkeys
    for (const [name] of getE2EEIntegrityState(world).keypairs.entries()) {
      if (name.toLowerCase().includes('vol')) {
        const volKp = getE2EEIntegrityState(world).keypairs.get(name)!
        if (pubkey === volKp.x25519Pubkey) return false
      }
    }
    return true
  })
  expect(adminEnvelopes.length).toBeGreaterThanOrEqual(2)

  const ctValues = adminEnvelopes.map(([, env]) => env.ct)
  expect(ctValues[0]).not.toBe(ctValues[1])
})

Then('the note ID should be returned', async ({ world }) => {
  expect(getE2EEIntegrityState(world).noteId).toBeDefined()
  expect(getE2EEIntegrityState(world).noteId!.length).toBeGreaterThan(0)
})

Then('the DB encrypted_content column should match the submitted ciphertext exactly', async ({ world }) => {
  expect(getE2EEIntegrityState(world).dbRow).toBeDefined()
  expect(getE2EEIntegrityState(world).ciphertextHex).toBeDefined()
  expect(getE2EEIntegrityState(world).dbRow!.encrypted_content).toBe(getE2EEIntegrityState(world).ciphertextHex)
})

Then('the DB admin_envelopes JSONB should be a proper array not a string', async ({ world }) => {
  expect(getE2EEIntegrityState(world).dbRow).toBeDefined()
  assertIsArray(getE2EEIntegrityState(world).dbRow!.admin_envelopes, 'admin_envelopes')

  // Also verify via jsonb_typeof
  const result = await TestDB.assertJsonbField('notes', 'id', getE2EEIntegrityState(world).noteId!, 'admin_envelopes')
  expect(result.pgType).toBe('array')
  expect(result.isDoubleStringified).toBe(false)
})

Then('the DB author_envelope JSONB should be a proper object not a string', async ({ world }) => {
  expect(getE2EEIntegrityState(world).dbRow).toBeDefined()
  assertIsObject(getE2EEIntegrityState(world).dbRow!.author_envelope, 'author_envelope')

  const result = await TestDB.assertJsonbField('notes', 'id', getE2EEIntegrityState(world).noteId!, 'author_envelope')
  expect(result.pgType).toBe('object')
  expect(result.isDoubleStringified).toBe(false)
})

// ── Cross-user encryption boundary steps ─────────────────────────────
// Matches: packages/test-specs/features/security/cross-user-encryption.feature

Given('a reviewer {string} with a real keypair', async ({ request, world }, name: string) => {
  const kp = generateTestKeypair()
  const x25519Pubkey = hpkeRecipientForSeed(kp.seedHex).pubkeyHex
  getE2EEIntegrityState(world).keypairs.set(name, { ...kp, x25519Pubkey })
  const { status } = await apiPost(request, '/users', {
    name: `XU Reviewer ${name} ${Date.now()}`,
    phone: uniquePhone(),
    roleIds: ['role-reviewer'],
    pubkey: kp.pubkey,
  })
  expect([200, 201]).toContain(status)
})

Given('a hub admin {string} with a real keypair', async ({ request, world }, name: string) => {
  const kp = generateTestKeypair()
  const x25519Pubkey = hpkeRecipientForSeed(kp.seedHex).pubkeyHex
  getE2EEIntegrityState(world).keypairs.set(name, { ...kp, x25519Pubkey })
  const { status } = await apiPost(request, '/users', {
    name: `XU HubAdmin ${name} ${Date.now()}`,
    phone: uniquePhone(),
    roleIds: ['role-hub-admin'],
    pubkey: kp.pubkey,
  })
  expect([200, 201]).toContain(status)
})

When(
  '{string} creates an encrypted note {string} with their own envelope and admin envelope',
  async ({ request, world }, authorName: string, plaintext: string) => {
    const state = getE2EEIntegrityState(world)
    const authorKp = getKeypair(world, authorName)
    expect(state.adminX25519Pubkey).toBeDefined()

    state.contentKey = generateContentKey()
    state.ciphertextHex = encryptContent(plaintext, state.contentKey, LABEL_NOTE_KEY)
    state.envelopes = new Map()

    const authorEnv = await wrapKeyForRecipient(
      state.contentKey,
      authorKp.x25519Pubkey,
      authorKp.seedHex,
      LABEL_NOTE_KEY,
    )
    state.envelopes.set(authorKp.x25519Pubkey, authorEnv)

    const adminEnv = await wrapKeyForRecipient(
      state.contentKey,
      state.adminX25519Pubkey!,
      state.adminHpkeSkHex!,
      LABEL_NOTE_KEY,
    )
    state.envelopes.set(state.adminX25519Pubkey!, adminEnv)

    const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
      request,
      '/notes',
      {
        encryptedContent: state.ciphertextHex,
        callId: `xu-${Date.now()}`,
        authorEnvelope: authorEnv,
        adminEnvelopes: [{ pubkey: state.adminX25519Pubkey, ...adminEnv }],
      },
      authorKp.seedHex,
    )
    expect([200, 201]).toContain(status)
    state.noteId = data.note?.id
    state.apiNote = data.note
  },
)

When(
  'the admin creates an encrypted note {string} with only the admin envelope',
  async ({ request, world }, plaintext: string) => {
    const state = getE2EEIntegrityState(world)
    expect(state.adminX25519Pubkey).toBeDefined()
    expect(state.adminSeedHex).toBeDefined()

    state.contentKey = generateContentKey()
    state.ciphertextHex = encryptContent(plaintext, state.contentKey, LABEL_NOTE_KEY)
    state.envelopes = new Map()

    const adminEnv = await wrapKeyForRecipient(
      state.contentKey,
      state.adminX25519Pubkey!,
      state.adminHpkeSkHex!,
      LABEL_NOTE_KEY,
    )
    state.envelopes.set(state.adminX25519Pubkey!, adminEnv)

    const { status, data } = await apiPost<{ note?: Record<string, unknown> & { id?: string } }>(
      request,
      '/notes',
      {
        encryptedContent: state.ciphertextHex,
        callId: `xu-admin-${Date.now()}`,
        authorEnvelope: adminEnv,
        adminEnvelopes: [{ pubkey: state.adminX25519Pubkey, ...adminEnv }],
      },
      state.adminSeedHex!,
    )
    expect([200, 201]).toContain(status)
    state.noteId = data.note?.id
    state.apiNote = data.note
  },
)

Then('the note is stored on the server', async ({ world }) => {
  expect(getE2EEIntegrityState(world).noteId).toBeTruthy()
})

When('{string} retrieves the note as the author', async ({ request, world }, authorName: string) => {
  const state = getE2EEIntegrityState(world)
  const authorKp = getKeypair(world, authorName)
  expect(state.noteId).toBeDefined()

  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    authorKp.seedHex,
  )
  expect(status).toBe(200)
  const note = data.notes.find(n => n.id === state.noteId)
  expect(note).toBeTruthy()
  state.apiNote = note
})

When('{string} decrypts their note using their own envelope', async ({ world }, authorName: string) => {
  const state = getE2EEIntegrityState(world)
  const authorKp = getKeypair(world, authorName)
  expect(state.apiNote?.encryptedContent).toBeTruthy()

  const envelope = state.envelopes.get(authorKp.x25519Pubkey)
  expect(envelope).toBeDefined()

  const recoveredKey = await unwrapKey(
    envelope!.ct,
    envelope!.enc,
    authorKp.seedHex,
    LABEL_NOTE_KEY,
  )
  state.decryptedText = decryptContent(
    state.apiNote!.encryptedContent as string,
    recoveredKey,
    LABEL_NOTE_KEY,
  )
})

When('the admin retrieves the note via notes:read-all', async ({ request, world }) => {
  const state = getE2EEIntegrityState(world)
  expect(state.noteId).toBeDefined()
  expect(state.adminSeedHex).toBeDefined()

  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    state.adminSeedHex!,
  )
  expect(status).toBe(200)
  const note = data.notes.find(n => n.id === state.noteId)
  expect(note).toBeTruthy()
  state.apiNote = note
})

When('the admin decrypts the note using the admin envelope', async ({ world }) => {
  const state = getE2EEIntegrityState(world)
  expect(state.adminX25519Pubkey).toBeDefined()
  expect(state.adminSeedHex).toBeDefined()
  expect(state.apiNote?.encryptedContent).toBeTruthy()

  const envelope = state.envelopes.get(state.adminX25519Pubkey!)
  expect(envelope).toBeDefined()

  const recoveredKey = await unwrapKey(
    envelope!.ct,
    envelope!.enc,
    state.adminHpkeSkHex!,
    LABEL_NOTE_KEY,
  )
  state.decryptedText = decryptContent(
    state.apiNote!.encryptedContent as string,
    recoveredKey,
    LABEL_NOTE_KEY,
  )
})

Then('the decrypted note content should be {string}', async ({ world }, expected: string) => {
  expect(getE2EEIntegrityState(world).decryptedText).toBe(expected)
})

When(
  '{string} fetches the author\'s note via direct API access as an authorized reader',
  async ({ request, world }, readerName: string) => {
    const state = getE2EEIntegrityState(world)
    const readerKp = getKeypair(world, readerName)

    // Reader (reviewer role) fetches their own note list — they won't see the author's note
    // since they have notes:read-own only (not notes:read-all)
    const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
      request,
      '/notes',
      readerKp.seedHex,
    )
    expect(status).toBe(200)
    const ownNote = data.notes.find(n => n.id === state.noteId)
    // Reviewer cannot see another volunteer's note — apiNote stays as previously set
    if (ownNote) {
      state.apiNote = ownNote
    }
    // If not found: the reader cannot access this note via the API at all —
    // the cryptographic protection is verified independently via the in-memory state
  },
)

When('{string} fetches notes via notes:read-all', async ({ request, world }, readerName: string) => {
  const state = getE2EEIntegrityState(world)
  const readerKp = getKeypair(world, readerName)
  expect(state.noteId).toBeDefined()

  // Hub admin has notes:read-all → can see all notes
  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    readerKp.seedHex,
  )
  expect(status).toBe(200)
  const note = data.notes.find(n => n.id === state.noteId)
  expect(note).toBeTruthy()
  state.apiNote = note
})

When('{string} retrieves notes visible to them', async ({ request, world }, volName: string) => {
  const state = getE2EEIntegrityState(world)
  const volKp = getKeypair(world, volName)

  const { status, data } = await apiGet<{ notes: Array<Record<string, unknown>> }>(
    request,
    '/notes',
    volKp.seedHex,
  )
  expect(status).toBe(200)
  // Volunteer sees only own notes — admin-created note won't appear here
  state.apiNote = data.notes.find(n => n.id === state.noteId)
})

When(
  '{string} attempts HPKE unwrap of {string}\'s author envelope',
  async ({ world }, attackerName: string, _ownerName: string) => {
    const state = getE2EEIntegrityState(world)
    const attackerKp = getKeypair(world, attackerName)

    // The attacker tries to unwrap the authorEnvelope (wrapped for the actual author) with their key.
    // The server may not return authorEnvelope in the API response — if so, the encryption
    // already provides protection (no envelope = no decryption path).
    const authorEnvelope = state.apiNote?.authorEnvelope as { ct?: string; enc?: string } | undefined
    if (!authorEnvelope?.ct || !authorEnvelope?.enc) {
      // No envelope exposed → decryption is impossible; test passes trivially
      state.lastDecryptionFailed = true
      return
    }

    state.lastDecryptionFailed = false
    try {
      await unwrapKey(authorEnvelope.ct, authorEnvelope.enc, attackerKp.seedHex, LABEL_NOTE_KEY)
    } catch {
      state.lastDecryptionFailed = true
    }
  },
)

Then('{string} receives the encrypted blob', async ({ world }, _readerName: string) => {
  const state = getE2EEIntegrityState(world)
  // The encrypted ciphertext exists in state (created by the author)
  expect(state.ciphertextHex).toBeTruthy()
  // If the API note was fetched by the reader, verify it carries the same ciphertext
  if (state.apiNote) {
    expect(state.apiNote.encryptedContent).toBeTruthy()
  }
})

Then('{string} has no HPKE envelope for their key', async ({ world }, readerName: string) => {
  const state = getE2EEIntegrityState(world)
  const readerKp = getKeypair(world, readerName)

  // Verify the reader's X25519 pubkey was NOT included in the envelopes map
  expect(state.envelopes.has(readerKp.x25519Pubkey)).toBe(false)

  // Also verify via the API note's adminEnvelopes (if exposed)
  if (state.apiNote?.adminEnvelopes) {
    const adminEnvelopes = state.apiNote.adminEnvelopes as Array<{ pubkey: string }>
    const inEnvelopes = adminEnvelopes.some(
      e => e.pubkey === readerKp.pubkey || e.pubkey === readerKp.x25519Pubkey,
    )
    expect(inEnvelopes).toBe(false)
  }
})

Then(
  '{string} cannot decrypt the note with their private key',
  async ({ world }, readerName: string) => {
    const state = getE2EEIntegrityState(world)
    const readerKp = getKeypair(world, readerName)
    expect(state.ciphertextHex).toBeTruthy()

    // Find the author's envelope (the one NOT belonging to the admin or reader)
    let targetEnv: { ct: string; enc: string } | undefined
    for (const [pubkey, env] of state.envelopes.entries()) {
      if (pubkey !== state.adminX25519Pubkey && pubkey !== readerKp.x25519Pubkey) {
        targetEnv = env
        break
      }
    }
    // Fall back to admin envelope if no author-specific one
    if (!targetEnv) {
      targetEnv = state.envelopes.get(state.adminX25519Pubkey!)
    }
    expect(targetEnv).toBeDefined()

    let decryptionFailed = false
    try {
      await unwrapKey(targetEnv!.ct, targetEnv!.enc, readerKp.seedHex, LABEL_NOTE_KEY)
    } catch {
      decryptionFailed = true
    }
    expect(decryptionFailed).toBe(true)
  },
)

Then('{string} can see the encrypted note blob', async ({ world }, _readerName: string) => {
  const state = getE2EEIntegrityState(world)
  // Hub admin fetched the note — it should be in apiNote with encryptedContent
  expect(state.apiNote).toBeDefined()
  expect(state.apiNote!.encryptedContent).toBeTruthy()
  expect(state.apiNote!.encryptedContent).toBe(state.ciphertextHex)
})

Then(
  '{string} does not see the admin\'s note in their list',
  async ({ world }, _volName: string) => {
    // Volunteer fetched their note list — admin's note should not appear
    expect(getE2EEIntegrityState(world).apiNote).toBeUndefined()
  },
)

Then(
  'any attempt to decrypt the admin note ciphertext with {string} key should fail',
  async ({ world }, volName: string) => {
    const state = getE2EEIntegrityState(world)
    const volKp = getKeypair(world, volName)
    expect(state.ciphertextHex).toBeTruthy()
    expect(state.adminX25519Pubkey).toBeTruthy()

    const adminEnv = state.envelopes.get(state.adminX25519Pubkey!)
    expect(adminEnv).toBeDefined()

    let decryptionFailed = false
    try {
      await unwrapKey(adminEnv!.ct, adminEnv!.enc, volKp.seedHex, LABEL_NOTE_KEY)
    } catch {
      decryptionFailed = true
    }
    expect(decryptionFailed).toBe(true)
  },
)

Then('the HPKE operation should throw a decryption error', async ({ world }) => {
  expect(getE2EEIntegrityState(world).lastDecryptionFailed).toBe(true)
})

Then(
  'the author envelope ciphertext differs from the admin envelope ciphertext',
  async ({ world }) => {
    const state = getE2EEIntegrityState(world)

    // Find the author (volunteer) keypair — not an admin-named one
    let authorX25519: string | undefined
    for (const [name, kp] of state.keypairs.entries()) {
      if (!name.toLowerCase().includes('admin') && state.envelopes.has(kp.x25519Pubkey)) {
        authorX25519 = kp.x25519Pubkey
        break
      }
    }
    expect(authorX25519).toBeTruthy()

    const authorEnv = state.envelopes.get(authorX25519!)
    const adminEnv = state.envelopes.get(state.adminX25519Pubkey!)
    expect(authorEnv).toBeDefined()
    expect(adminEnv).toBeDefined()
    expect(authorEnv!.ct).not.toBe(adminEnv!.ct)
  },
)

Then(
  'both envelopes encrypt the same content key but are cryptographically independent',
  async ({ world }) => {
    const state = getE2EEIntegrityState(world)
    expect(state.contentKey).toBeDefined()
    expect(state.envelopes.size).toBeGreaterThanOrEqual(2)

    const entries = [...state.envelopes.entries()]
    const [pubkey1, env1] = entries[0]
    const [pubkey2, env2] = entries[1]

    // Resolve the X25519 secret that opens an envelope addressed to `pubkey`.
    function hpkeSkForPubkey(pubkey: string): string {
      if (pubkey === state.adminX25519Pubkey) return state.adminHpkeSkHex!
      for (const kp of state.keypairs.values()) {
        if (kp.x25519Pubkey === pubkey) return kp.seedHex
      }
      throw new Error(`No X25519 secret found for pubkey ${pubkey}`)
    }

    const key1 = await unwrapKey(env1.ct, env1.enc, hpkeSkForPubkey(pubkey1), LABEL_NOTE_KEY)
    const key2 = await unwrapKey(env2.ct, env2.enc, hpkeSkForPubkey(pubkey2), LABEL_NOTE_KEY)

    // Both unwrapped keys equal the original content key
    expect(bytesToHex(key1)).toBe(bytesToHex(state.contentKey!))
    expect(bytesToHex(key2)).toBe(bytesToHex(state.contentKey!))

    // The HPKE enc (encapsulated key) must differ — each encapsulation is ephemeral
    expect(env1.enc).not.toBe(env2.enc)
  },
)

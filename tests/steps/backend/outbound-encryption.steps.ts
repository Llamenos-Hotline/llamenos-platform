/**
 * Step definitions for verifying outbound message encryption.
 * Ensures plaintext is never stored in the encryptedContent field.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import {
  apiPost,
} from '../../api-helpers'
import {
  simulateIncomingMessage,
  uniqueCallerNumber,
} from '../../simulation-helpers'
import { TestDB } from '../../db-helpers'
import { getScenarioState } from './common.steps'
import {
  adminHpkeRecipient,
  decryptStoredRecordContent,
  openStoredRecordKey,
} from '../../crypto-helpers'
import { LABEL_MESSAGE } from '@shared/crypto-labels'

// ── State ───────────────────────────────────────────────────────────

interface OutboundEncryptionState {
  conversationId?: string
  outboundMessageId?: string
  plaintextSent?: string
}

const STATE_KEY = 'outbound_encryption'

function getOEState(world: Record<string, unknown>): OutboundEncryptionState {
  return getState<OutboundEncryptionState>(world, STATE_KEY) ?? {}
}

// ── Given ───────────────────────────────────────────────────────────

Given('a conversation exists for an SMS contact', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  setState<OutboundEncryptionState>(world, STATE_KEY, {})

  // Create an inbound conversation via SMS simulation
  const sender = uniqueCallerNumber()
  const result = await simulateIncomingMessage(request, {
    senderNumber: sender,
    body: 'I need help',
    channel: 'sms',
    hubId,
  })
  const state = getOEState(world)
  state.conversationId = result.conversationId
  setState(world, STATE_KEY, state)
})

// ── When ────────────────────────────────────────────────────────────

When(
  'a volunteer sends an outbound message with plaintext {string}',
  async ({ request, world }, plaintext: string) => {
    const state = getOEState(world)
    const hubId = getScenarioState(world).hubId
    expect(state.conversationId).toBeDefined()

    // Send outbound message with only plaintext (no pre-encrypted content)
    const path = `/hubs/${hubId}/conversations/${state.conversationId}/messages`
    const { status, data } = await apiPost<{ id: string }>(
      request,
      path,
      { plaintextForSending: plaintext },
    )
    expect(status).toBe(201)
    state.outboundMessageId = data.id
    state.plaintextSent = plaintext
    setState(world, STATE_KEY, state)
  },
)

// ── Then ────────────────────────────────────────────────────────────

Then(
  'the stored message encryptedContent should not contain {string}',
  async ({ world }, plaintext: string) => {
    const state = getOEState(world)
    expect(state.outboundMessageId).toBeDefined()

    // Read directly from database to verify stored content
    const row = await TestDB.getRow('messages', state.outboundMessageId!)
    expect(row).toBeTruthy()

    const encryptedContent = row!.encrypted_content as string
    // The encrypted content must NOT contain the plaintext
    expect(encryptedContent).not.toContain(plaintext)
    // It should be a hex-encoded ciphertext (AES-256-GCM output)
    expect(encryptedContent).toMatch(/^[0-9a-f]+$/i)
    // Non-empty
    expect(encryptedContent.length).toBeGreaterThan(0)
  },
)

Then('the stored message should have reader envelopes with HPKE fields', async ({ world }) => {
  const state = getOEState(world)
  expect(state.outboundMessageId).toBeDefined()

  const row = await TestDB.getRow('messages', state.outboundMessageId!)
  expect(row).toBeTruthy()

  const envelopes = row!.reader_envelopes as Array<{ pubkey: string; enc: string; ct: string }>
  expect(Array.isArray(envelopes)).toBe(true)
  expect(envelopes.length).toBeGreaterThan(0)

  // Each envelope should have the HPKE fields
  for (const env of envelopes) {
    expect(env.pubkey).toBeDefined()
    expect(env.enc).toBeDefined()
    expect(env.ct).toBeDefined()
    // enc and ct should be hex-encoded
    expect(env.enc).toMatch(/^[0-9a-f]+$/i)
    expect(env.ct).toMatch(/^[0-9a-f]+$/i)
  }
})

Then('the stored message should have an envelope for the admin decryption pubkey', async ({ world }) => {
  const state = getOEState(world)
  expect(state.outboundMessageId).toBeDefined()
  expect(state.plaintextSent).toBeDefined()

  const row = await TestDB.getRow('messages', state.outboundMessageId!)
  expect(row).toBeTruthy()

  const envelopes = row!.reader_envelopes as Array<{ pubkey: string; enc: string; ct: string }>

  // An envelope that merely exists with a well-shaped pubkey says nothing: the
  // #1021 defect sealed to an Ed25519 auth key — right count, right 64-hex
  // shape, openable by nobody. Find the envelope addressed to the admin's
  // X25519 recipient key and prove it opens to what was sent.
  const admin = adminHpkeRecipient()
  const adminEnvelope = envelopes.find(e => e.pubkey === admin.pubkeyHex)
  expect(
    adminEnvelope,
    `no envelope for the admin's X25519 key ${admin.pubkeyHex}; sealed to ${JSON.stringify(envelopes.map(e => e.pubkey))}`,
  ).toBeTruthy()
  const messageKey = await openStoredRecordKey(adminEnvelope!.ct, adminEnvelope!.enc, admin.skHex, LABEL_MESSAGE)
  expect(decryptStoredRecordContent(row!.encrypted_content as string, messageKey)).toBe(state.plaintextSent)
})

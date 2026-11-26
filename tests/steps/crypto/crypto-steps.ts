/**
 * Crypto step definitions for packages/test-specs/features/security/crypto-interop.feature.
 *
 * WHAT THIS LAYER CAN AND CANNOT PROVE — read before adding a step.
 *
 * Every crypto call here goes through `window.__TEST_PLATFORM`, which is the
 * module namespace of `src/client/lib/platform.ts` (set in main.tsx). Under
 * Playwright, `platform.ts` forces its Tauri branch and Vite aliases
 * `@tauri-apps/api/core` to `tests/mocks/tauri-core.ts`. So:
 *
 *   - There is NO Rust and NO WASM in a desktop BDD run. The previous header
 *     comment in this file claimed "routes to WASM directly / stays in
 *     Rust/WASM memory" — that was never true of a Playwright run.
 *   - The mock's HPKE (`tests/mocks/hpke-mock.ts`) is a hand-rolled
 *     X25519 -> HKDF-SHA256 -> AES-256-GCM construction, NOT RFC 9180. Any
 *     assertion about wire-format compatibility with the Rust crate would be
 *     comparing the mock against itself.
 *
 * Therefore this file asserts properties of the APP'S OWN crypto path — the
 * parts that are identical in test and production because they live in
 * `platform.ts` and run on WebCrypto (envelope composition, per-note content
 * keys, recipient selection, tamper rejection), plus the parts the mock
 * implements faithfully (Ed25519 auth tokens, Argon2id key wrapping, SAS).
 *
 * Genuine cross-implementation interop lives elsewhere and is NOT duplicated
 * here:
 *   - tests/crypto-interop.spec.ts   JS (real RFC 9180 via hpke-js) decrypts
 *                                    ciphertext produced by the Rust crate.
 *   - packages/crypto/tests/interop.rs  Rust roundtrips + cross-label rejection.
 *   - packages/crypto/src/labels.rs  `label_registry_matches_json` — the derived
 *                                    guard that Rust labels match the protocol
 *                                    source of truth.
 *
 * Rule: no step body may be empty or comment-only. If a step exists, it
 * asserts something checkable on this platform. See #1222.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  Given,
  When,
  Then,
  type CryptoWorld,
  type EncryptedDeviceKeys,
  type ParsedAuthToken,
} from '../fixtures'
import * as clientLabels from '@shared/crypto-labels'
import { buildAuthMessage } from '@shared/auth-message'
import { bytesToHex } from '@shared/encoding'
import { generateAdminKeys } from '../../../scripts/bootstrap-admin'
import { x25519 } from '@noble/curves/ed25519.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { encryptBundleForProvisioning, type ProvisioningOffer } from '../../mocks/provisioning-mock'

const __dirname_ = dirname(fileURLToPath(import.meta.url))
const CRYPTO_LABELS_JSON = resolve(__dirname_, '../../../packages/protocol/crypto-labels.json')

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Ensure the app is loaded and the platform module is on `window`.
 * Idempotent — scenarios with several steps calling this must not reload the
 * page, which would clear the CryptoState the earlier steps set up.
 */
async function ensureAppLoaded(page: Page) {
  const alreadyLoaded = await page
    .evaluate(() => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM)
    .catch(() => false)
  if (alreadyLoaded) return
  const { loginAsAdmin } = await import('../../helpers')
  await loginAsAdmin(page)
}

// ─── Device keypair generation ──────────────────────────────────────────

/** Generate a device keypair and return only its PUBLIC state. */
async function generateDevice(page: Page): Promise<EncryptedDeviceKeys['state']> {
  return page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceGenerateAndLoad(pin: string, deviceId: string): Promise<EncryptedDeviceKeys>
    }
    const res = await p.deviceGenerateAndLoad('12345678', crypto.randomUUID())
    return res.state
  }) as Promise<EncryptedDeviceKeys['state']>
}

When('I generate a device keypair', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  cryptoWorld.device = await generateDevice(page)
})

Then('the signing public key should be 64 hex characters', async ({ cryptoWorld }) => {
  const d = cryptoWorld.device
  expect(d?.signingPubkeyHex).toMatch(HEX64)
})

Then('the encryption public key should be 64 hex characters', async ({ cryptoWorld }) => {
  const d = cryptoWorld.device
  expect(d?.encryptionPubkeyHex).toMatch(HEX64)
})

Then('the signing and encryption public keys should differ', async ({ cryptoWorld }) => {
  const d = cryptoWorld.device
  expect(d).toBeTruthy()
  // Ed25519 signing key and X25519 encryption key are derived from separate
  // seeds; a device where these collide would mean one seed is being reused
  // for both roles.
  expect(d!.signingPubkeyHex).not.toBe(d!.encryptionPubkeyHex)
})

When('I generate device keypair A', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  cryptoWorld.deviceA = await generateDevice(page)
})

When('I generate device keypair B', async ({ page, cryptoWorld }) => {
  cryptoWorld.deviceB = await generateDevice(page)
})

Then("device keypair A's signing public key should differ from B's", async ({ cryptoWorld }) => {
  const a = cryptoWorld.deviceA
  const b = cryptoWorld.deviceB
  expect(a?.signingPubkeyHex).toMatch(HEX64)
  expect(b?.signingPubkeyHex).toMatch(HEX64)
  expect(a!.signingPubkeyHex).not.toBe(b!.signingPubkeyHex)
})

Then("device keypair A's encryption public key should differ from B's", async ({ cryptoWorld }) => {
  const a = cryptoWorld.deviceA
  const b = cryptoWorld.deviceB
  expect(a!.encryptionPubkeyHex).not.toBe(b!.encryptionPubkeyHex)
})

// Shared with @ios/@android via the feature file — keep the wording.
When('I generate a keypair', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  cryptoWorld.device = await generateDevice(page)
})

Then('the public key hex should be 64 characters', async ({ cryptoWorld }) => {
  expect(cryptoWorld.device?.signingPubkeyHex).toHaveLength(64)
})

Then('the public key should only contain hex characters [0-9a-f]', async ({ cryptoWorld }) => {
  expect(cryptoWorld.device?.signingPubkeyHex).toMatch(/^[0-9a-f]+$/)
})

// ─── Operator-issued signing seed import ────────────────────────────────
//
// The app never hands a signing seed out: device keys are generated in Rust
// (the mock here) and stay there, and the admin-side `generate_ephemeral_ed25519`
// that used to mint a seed for someone else's device is gone (#1231). The one
// remaining way a seed enters a device is the operator importing the seed that
// `scripts/bootstrap-admin.ts` printed (`signIn` -> `deviceImportAndLoad`). The
// server is configured with the two public keys that script derived, so the
// import must reproduce exactly those — and must not depend on the PIN or the
// deviceId it is imported under.

When('I import a signing seed issued by the admin bootstrap script', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  const issued = generateAdminKeys()
  const state = await page.evaluate(async (seedHex) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceImportAndLoad(s: string, pin: string, d: string): Promise<EncryptedDeviceKeys>
    }
    return (await p.deviceImportAndLoad(seedHex, '12345678', crypto.randomUUID())).state
  }, issued.seedHex)
  // The seed is kept only so the next step can import it a second time; it is
  // never asserted on, logged, or printed.
  cryptoWorld.issued = {
    seedHex: issued.seedHex,
    identityPubkey: issued.identityPubkey,
    decryptionPubkey: issued.decryptionPubkey,
  }
  cryptoWorld.device = state
})

When('I import the same seed into a fresh device under a different PIN', async ({ page, cryptoWorld }) => {
  const seedHex = cryptoWorld.issued?.seedHex
  expect(seedHex, 'the import step must record the issued seed').toBeTruthy()
  const state = await page.evaluate(async (seed) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceImportAndLoad(s: string, pin: string, d: string): Promise<EncryptedDeviceKeys>
    }
    return (await p.deviceImportAndLoad(seed, '87654321', crypto.randomUUID())).state
  }, seedHex as string)
  cryptoWorld.deviceReimported = state
})

Then('the imported signing public key should be the one the bootstrap script published', async ({ cryptoWorld }) => {
  const issued = cryptoWorld.issued
  const d = cryptoWorld.device
  expect(d?.signingPubkeyHex).toMatch(HEX64)
  // ADMIN_PUBKEY: the server verifies this device's auth tokens against it.
  expect(d!.signingPubkeyHex).toBe(issued!.identityPubkey)
})

Then('the imported encryption public key should be the one the bootstrap script published', async ({ cryptoWorld }) => {
  const issued = cryptoWorld.issued
  const d = cryptoWorld.device
  expect(d?.encryptionPubkeyHex).toMatch(HEX64)
  // ADMIN_DECRYPTION_PUBKEY: envelopes the server wraps for the admin are
  // addressed to this key. A mismatch means the admin decrypts nothing.
  expect(d!.encryptionPubkeyHex).toBe(issued!.decryptionPubkey)
})

Then('both imports should yield the same device identity', async ({ cryptoWorld }) => {
  const a = cryptoWorld.device
  const b = cryptoWorld.deviceReimported
  expect(b!.deviceId).not.toBe(a!.deviceId)
  expect(b!.signingPubkeyHex).toBe(a!.signingPubkeyHex)
  expect(b!.encryptionPubkeyHex).toBe(a!.encryptionPubkeyHex)
})

// ─── Device-linking session key ─────────────────────────────────────────
//
// Device linking runs over an ephemeral X25519 key that the NEW device creates
// for the provisioning room (`provisionCreateSession`); its secret stays in
// CryptoState and only the public half reaches the webview. Each session must
// get a fresh key, and it must never be the device's long-term encryption key.

When('I open a device-linking session', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  cryptoWorld.linkSession = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionCreateSession(): Promise<string>
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
    }
    const first = await p.provisionCreateSession()
    const second = await p.provisionCreateSession()
    const device = await p.getDevicePubkeys()
    return { first, second, deviceEncryptionPubkey: device.encryptionPubkeyHex }
  })
})

Then('the session public key should be 64 hex characters', async ({ cryptoWorld }) => {
  expect(cryptoWorld.linkSession?.first).toMatch(HEX64)
})

Then("the session public key should not be the device's own encryption key", async ({ cryptoWorld }) => {
  const s = cryptoWorld.linkSession
  expect(s?.deviceEncryptionPubkey).toMatch(HEX64)
  expect(s!.first).not.toBe(s!.deviceEncryptionPubkey)
  expect(s!.second).not.toBe(s!.deviceEncryptionPubkey)
})

Then('opening another device-linking session should produce a different public key', async ({ cryptoWorld }) => {
  const s = cryptoWorld.linkSession
  expect(s?.second).toMatch(HEX64)
  expect(s!.second).not.toBe(s!.first)
})

// ─── Envelope encryption through the app crypto path ────────────────────

Given('I have an unlocked device', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  const state = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state'] | null>
      deviceGenerateAndLoad(pin: string, deviceId: string): Promise<EncryptedDeviceKeys>
      isCryptoUnlocked(): Promise<boolean>
    }
    if (!(await p.isCryptoUnlocked())) {
      await p.deviceGenerateAndLoad('12345678', crypto.randomUUID())
    }
    return p.getDevicePubkeys()
  })
  expect(state, 'device should be unlocked with pubkeys available').not.toBeNull()
  cryptoWorld.device = state as EncryptedDeviceKeys['state']
})

const NOTE_PAYLOAD = JSON.stringify({ text: 'interop note', fields: { severity: 'high' } })

When('I encrypt a note for the author and no admins', async ({ page, cryptoWorld }) => {
  cryptoWorld.note = await page.evaluate(async (payload) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<unknown>
    }
    const me = await p.getDevicePubkeys()
    return p.encryptNote(payload, me.signingPubkeyHex, [])
  }, NOTE_PAYLOAD) as CryptoWorld['note']
})

When('I decrypt that note with the author envelope', async ({ page, cryptoWorld }) => {
  const note = cryptoWorld.note
  expect(note, 'the encrypt step must record the note').toBeTruthy()
  cryptoWorld.notePlaintext = await page.evaluate(async (n) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptNote(content: string, envelope: unknown): Promise<string | null>
    }
    return p.decryptNote(n.encryptedContent, n.authorEnvelope)
  }, note as NonNullable<CryptoWorld['note']>)
})

Then('the decrypted note should match the original payload', async ({ cryptoWorld }) => {
  expect(cryptoWorld.notePlaintext).toBe(NOTE_PAYLOAD)
})

Given('two admin encryption public keys', async ({ page, cryptoWorld }) => {
  // provisionCreateSession mints a genuine X25519 public key; calling it twice
  // yields two distinct valid recipients without inventing key material.
  const admins = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionCreateSession(): Promise<string>
    }
    const a = await p.provisionCreateSession()
    const b = await p.provisionCreateSession()
    return [a, b]
  })
  expect(admins[0]).toMatch(HEX64)
  expect(admins[1]).toMatch(HEX64)
  expect(admins[0]).not.toBe(admins[1])
  cryptoWorld.admins = admins
})

When('I encrypt a note for the author and both admins', async ({ page, cryptoWorld }) => {
  const admins = cryptoWorld.admins
  expect(admins, 'the admins step must record the recipient pubkeys').toBeTruthy()
  cryptoWorld.note = await page.evaluate(async ({ payload, recipients }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<unknown>
    }
    const me = await p.getDevicePubkeys()
    return p.encryptNote(payload, me.signingPubkeyHex, recipients)
  }, { payload: NOTE_PAYLOAD, recipients: admins as string[] }) as CryptoWorld['note']
})

Then('the note should carry one admin envelope per admin', async ({ cryptoWorld }) => {
  const admins = cryptoWorld.admins
  const note = cryptoWorld.note
  expect(note?.adminEnvelopes).toHaveLength(admins!.length)
  expect(note!.adminEnvelopes.map(e => e.pubkey).sort()).toEqual([...admins!].sort())
})

Then('every admin envelope should name a distinct recipient', async ({ cryptoWorld }) => {
  const note = cryptoWorld.note
  expect(note).toBeTruthy()
  const pubkeys = note!.adminEnvelopes.map(e => e.pubkey)
  expect(new Set(pubkeys).size).toBe(pubkeys.length)
  // Each recipient gets an independently sealed envelope: same content key,
  // different HPKE encapsulation. Identical ct across recipients would mean
  // the wrap is not actually per-recipient.
  const cts = note!.adminEnvelopes.map(e => e.ct)
  expect(new Set(cts).size).toBe(cts.length)
})

When('I encrypt the same payload as two separate notes', async ({ page, cryptoWorld }) => {
  const notes = await page.evaluate(async ({ payload }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<{
        encryptedContent: string
        authorEnvelope: { enc: string; ct: string }
      }>
      shapeOpenFromState(shape: string, env: unknown): Promise<string>
    }
    const me = await p.getDevicePubkeys()
    const one = await p.encryptNote(payload, me.signingPubkeyHex, [])
    const two = await p.encryptNote(payload, me.signingPubkeyHex, [])

    // Recover the actual content keys. Comparing the WRAPPED keys would prove
    // nothing: HPKE draws a fresh ephemeral per seal, so two wraps of the very
    // same key still differ byte-for-byte. Only the unwrapped key is evidence.
    // Verified by mutation: pinning encryptNote to a constant content key left
    // a wrapped-ciphertext comparison green.
    // The stored envelope IS the IPC envelope ({enc, ct}, hex — spec D1, D2),
    // and the note shape fixes the label and AAD in Rust.
    const k1 = await p.shapeOpenFromState('note-key', one.authorEnvelope)
    const k2 = await p.shapeOpenFromState('note-key', two.authorEnvelope)
    return {
      one: { encryptedContent: one.encryptedContent },
      two: { encryptedContent: two.encryptedContent },
      keysEqual: k1 === k2,
      keyLen: k1.length,
    }
  }, { payload: NOTE_PAYLOAD })
  cryptoWorld.notesPair = notes
})

Then('the two notes should have different ciphertext', async ({ cryptoWorld }) => {
  const pair = cryptoWorld.notesPair
  expect(pair).toBeTruthy()
  expect(pair!.one.encryptedContent).toBeTruthy()
  expect(pair!.one.encryptedContent).not.toBe(pair!.two.encryptedContent)
})

Then('the two notes should have different wrapped content keys', async ({ cryptoWorld }) => {
  const pair = cryptoWorld.notesPair
  expect(pair).toBeTruthy()
  // Per-note forward secrecy: a fresh random content key per note. The keys are
  // unwrapped and compared inside the page, so only this boolean and the length
  // cross back — no key material reaches the test runner.
  expect(pair!.keyLen, 'content key should be 32 bytes').toBe(64)
  expect(pair!.keysEqual, 'two notes must not share a content key').toBe(false)
})

When('I flip one byte of the note ciphertext', async ({ cryptoWorld }) => {
  const hex = cryptoWorld.note?.encryptedContent
  expect(hex, 'the encrypt step must record the note').toBeTruthy()
  // Flip one nibble in the middle of the ciphertext body (past the 12-byte
  // IV) so the AES-GCM tag check must reject it. Pure string work — stays in
  // the runner, no page round-trip.
  const i = Math.floor(hex!.length / 2)
  const flipped = (parseInt(hex![i], 16) ^ 0x1).toString(16)
  cryptoWorld.tampered = hex!.slice(0, i) + flipped + hex!.slice(i + 1)
})

Then('decrypting the tampered note should return null', async ({ page, cryptoWorld }) => {
  const note = cryptoWorld.note
  const tampered = cryptoWorld.tampered
  expect(note && tampered, 'the tamper step must record the tampered ciphertext').toBeTruthy()
  const result = await page.evaluate(async ({ content, envelope }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptNote(content: string, envelope: unknown): Promise<string | null>
    }
    return p.decryptNote(content, envelope)
  }, { content: tampered as string, envelope: note!.authorEnvelope })
  expect(result).toBeNull()
})

When('I encrypt a message for this device and one other reader', async ({ page, cryptoWorld }) => {
  cryptoWorld.msg = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      provisionCreateSession(): Promise<string>
      encryptMessage(plaintext: string, readers: string[]): Promise<{
        encryptedContent: string
        readerEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
      }>
    }
    const me = await p.getDevicePubkeys()
    const other = await p.provisionCreateSession()
    const msg = await p.encryptMessage('hotline message body', [me.signingPubkeyHex, other])
    return { msg, mine: me.signingPubkeyHex, other }
  })
})

Then('this device can decrypt the message', async ({ page, cryptoWorld }) => {
  const m = cryptoWorld.msg
  expect(m, 'the encrypt step must record the message').toBeTruthy()
  const plaintext = await page.evaluate(async (m2) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptMessage(content: string, envelopes: unknown[]): Promise<string | null>
    }
    return p.decryptMessage(m2.encryptedContent, m2.readerEnvelopes)
  }, m!.msg)
  expect(plaintext).toBe('hotline message body')
})

Then('a reader whose envelope is absent cannot decrypt the message', async ({ page, cryptoWorld }) => {
  const m = cryptoWorld.msg
  expect(m, 'the encrypt step must record the message').toBeTruthy()
  const plaintext = await page.evaluate(async ({ msg, mine }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptMessage(content: string, envelopes: unknown[]): Promise<string | null>
    }
    // Present only the OTHER reader's envelope. This device holds no key that
    // opens it, so decryption must fail rather than fall back to any other
    // envelope in the list.
    const withoutMine = msg.readerEnvelopes.filter(e => e.pubkey !== mine)
    return p.decryptMessage(msg.encryptedContent, withoutMine)
  }, { msg: m!.msg, mine: m!.mine })
  expect(plaintext).toBeNull()
})

// ─── Domain separation labels ───────────────────────────────────────────

let labelSnapshot: Record<string, string> = {}

When('I read the domain separation labels exposed to the client', async ({}) => {
  // `@shared/crypto-labels` is what application code imports. Snapshot it here
  // so the following Then steps compare the real client-visible surface.
  const exported = Object.fromEntries(
    Object.entries(clientLabels).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>
  expect(Object.keys(exported).length).toBeGreaterThan(0)
  labelSnapshot = exported
})

Then('they should match the protocol crypto-labels source of truth exactly', async ({}) => {
  const source = JSON.parse(readFileSync(CRYPTO_LABELS_JSON, 'utf-8')).labels as Record<string, string>

  // Derived on both sides — no hardcoded count. A label added to the protocol
  // JSON without regenerating the client constants (or vice versa) fails here.
  const missing = Object.keys(source).filter(k => !(k in labelSnapshot))
  const extra = Object.keys(labelSnapshot).filter(k => !(k in source))
  const mismatched = Object.keys(source)
    .filter(k => k in labelSnapshot && labelSnapshot[k] !== source[k])
    .map(k => k)

  expect(missing, `labels in crypto-labels.json but not exposed to the client: ${missing.join(', ')}`).toEqual([])
  expect(extra, `labels exposed to the client but absent from crypto-labels.json: ${extra.join(', ')}`).toEqual([])
  // Report names only — never the label values' provenance beyond the name.
  expect(mismatched, `labels whose value differs from crypto-labels.json: ${mismatched.join(', ')}`).toEqual([])
  expect(Object.keys(labelSnapshot).length).toBe(Object.keys(source).length)
})

Then('no label should be the empty string', async ({}) => {
  const empties = Object.entries(labelSnapshot)
    .filter(([, v]) => v.trim() === '')
    .map(([k]) => k)
  // An empty domain separator collapses two contexts into one.
  expect(empties, `empty label constants: ${empties.join(', ')}`).toEqual([])
})

Then('every label should be prefixed {string}', async ({}, prefix: string) => {
  const bad = Object.entries(labelSnapshot)
    .filter(([, v]) => !v.startsWith(prefix))
    .map(([k]) => k)
  expect(bad, `labels missing the "${prefix}" prefix: ${bad.join(', ')}`).toEqual([])
})

// ─── Shape enforcement at unwrap (spec D1) ───────────────────────────────
//
// The webview names a shape; the label is the shape's, bound as HPKE info, so an
// envelope opened as another shape fails the AEAD. Against the mock this shows
// the webview build is internally consistent; the crate's own property is pinned
// by packages/crypto/src/shape.rs and the v2 vectors.

/** The AAD fields a test seal binds for `shape` (the puk-seed shape binds the device id). */
function testFields(shape: string, deviceId: string): string[] {
  return shape === 'puk-seed' ? [deviceId] : []
}

When('I wrap a key as the shape {string}', async ({ page, cryptoWorld }, shape: string) => {
  const envelope = await page.evaluate(
    async (shp) => {
      const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
        shapeSeal(shape: string, pub: string, plaintextHex: string, fields?: string[]): Promise<unknown>
      }
      const me = await p.getDevicePubkeys()
      const keyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)), b =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      const fields = shp === 'puk-seed' ? [me.deviceId] : []
      const env = await p.shapeSeal(shp, me.encryptionPubkeyHex, keyHex, fields)
      return { env, keyHex, deviceId: me.deviceId }
    },
    shape,
  )
  cryptoWorld.wrapped = envelope
})

async function openAsShape(
  page: import('@playwright/test').Page,
  shape: string,
  wrapped: { env: unknown; keyHex: string; deviceId: string },
): Promise<{ ok: boolean; error: string | null }> {
  return page.evaluate(async ({ shp, w, fields }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      shapeOpenFromState(shape: string, env: unknown, fields?: string[]): Promise<string>
    }
    try {
      const got = await p.shapeOpenFromState(shp, w.env, fields)
      return { ok: got === w.keyHex, error: null as string | null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, { shp: shape, w: wrapped, fields: testFields(shape, wrapped.deviceId) })
}

Then('unwrapping it as the shape {string} should succeed', async ({ page, cryptoWorld }, shape: string) => {
  const w = cryptoWorld.wrapped as { env: unknown; keyHex: string; deviceId: string } | undefined
  expect(w, 'the wrap step must record the envelope').toBeTruthy()
  const result = await openAsShape(page, shape, w!)
  expect(result.error).toBeNull()
  // Compared inside the page; only the boolean crosses back.
  expect(result.ok, 'unwrapped key should equal the key that was wrapped').toBe(true)
})

Then('unwrapping it as the shape {string} should be rejected', async ({ page, cryptoWorld }, shape: string) => {
  const w = cryptoWorld.wrapped as { env: unknown; keyHex: string; deviceId: string } | undefined
  expect(w, 'the wrap step must record the envelope').toBeTruthy()
  const result = await openAsShape(page, shape, w!)
  // Another shape is another label as HPKE info: the AEAD fails, not the gate.
  expect(result.error, `unwrap as ${shape} must be rejected`).toMatch(/decryption_failed/)
})

Then('unwrapping it as the shape {string} should be refused as not openable from the webview', async ({ page, cryptoWorld }, shape: string) => {
  const w = cryptoWorld.wrapped as { env: unknown; keyHex: string; deviceId: string } | undefined
  expect(w, 'the wrap step must record the envelope').toBeTruthy()
  const result = await openAsShape(page, shape, w!)
  // The envelope IS valid for this shape (the step above sealed it so), so a
  // refusal for any other reason would be the gate not doing its job.
  expect(result.error, `unwrap as ${shape} must be refused`).toMatch(/not openable from the webview/)
})

// ─── Recovery group: shares are sealed in Rust, never returned ───────────

When('I create a recovery group of 3 shares with threshold 2 sealed to this device', async ({ page, cryptoWorld }) => {
  cryptoWorld.recoveryGroup = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      recoveryGroupCreate(total: number, threshold: number, holders: string[]): Promise<Record<string, unknown>>
    }
    const me = await p.getDevicePubkeys()
    const out = await p.recoveryGroupCreate(3, 2, [
      me.encryptionPubkeyHex,
      me.encryptionPubkeyHex,
      me.encryptionPubkeyHex,
    ])
    return {
      keys: Object.keys(out).sort(),
      envelopes: (out.shareEnvelopes as unknown[]).length,
      commitments: (out.commitments as unknown[]).length,
      livenessPublicKeys: out.livenessPublicKeys as string[],
      envelope: (out.shareEnvelopes as unknown[])[0],
    }
  })
})

Then('the result should contain sealed share envelopes and no plaintext shares', async ({ cryptoWorld }) => {
  const r = cryptoWorld.recoveryGroup
  expect(r).toBeTruthy()
  // Exhaustive on purpose: a new returned field must be consciously judged safe
  // before it is added here. `livenessPublicKeys` is public key material only —
  // one Ed25519 verifying key per share, a one-way function of the share (#2782).
  expect(r!.keys).toEqual(['commitments', 'livenessPublicKeys', 'publicKeyHex', 'shareEnvelopes'])
  expect(r!.envelopes).toBe(3)
  expect(r!.commitments).toBe(3)
  // Each is a 32-byte Ed25519 public key (64 hex chars) — a 33-byte share (x‖y) could not pass.
  expect(r!.livenessPublicKeys).toHaveLength(3)
  for (const key of r!.livenessPublicKeys) expect(key).toMatch(/^[0-9a-f]{64}$/)
})

Then('the webview should be unable to open a share envelope itself', async ({ page, cryptoWorld }) => {
  const r = cryptoWorld.recoveryGroup
  expect(r, 'the create step must record the group summary').toBeTruthy()
  const errors = await page.evaluate(async ({ envelope }) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      shapeOpenFromState(shape: string, env: unknown, fields?: string[]): Promise<string>
    }
    const attempt = async (open: () => Promise<string>) => {
      try {
        await open()
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    return [await attempt(() => p.shapeOpenFromState('recovery-group-share', envelope))]
  }, { envelope: r!.envelope })
  for (const err of errors) expect(err).toMatch(/not openable from the webview/)
})

// ─── SAS derivation ─────────────────────────────────────────────────────
//
// The new device derives its SAS from the primary's SIGNED CLAIM (#1865), never
// from a bare public key: the claim is verified against this device's own
// ephemeral key before anything is derived. These steps play the primary with
// `tests/mocks/provisioning-mock.ts`, the mirror of the crate's wire format.

Given('a provisioning room with a claim signed by the primary', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  const ephemeralPubkey = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionCreateSession(): Promise<string>
    }
    return p.provisionCreateSession()
  })
  const primary = (): ProvisioningOffer =>
    encryptBundleForProvisioning(randomBytes(32), randomBytes(32), ephemeralPubkey)
  const first = primary()
  const other = primary()
  // A claim a different primary signed for this same room, and one signed for
  // a different room (this device's ephemeral key is not the one it covers).
  const otherRoom = encryptBundleForProvisioning(
    randomBytes(32),
    randomBytes(32),
    bytesToHex(x25519.getPublicKey(randomBytes(32))),
  )
  cryptoWorld.sasClaims = {
    claim: first.claimHex,
    expected: first.sasCode,
    otherPrimaryClaim: other.claimHex,
    otherRoomClaim: otherRoom.claimHex,
    barePubkey: bytesToHex(x25519.getPublicKey(randomBytes(32))),
  }
})

When('I derive the SAS code', async ({ page, cryptoWorld }) => {
  const claims = cryptoWorld.sasClaims
  expect(claims, 'the provisioning-room step must record the claims').toBeTruthy()
  cryptoWorld.sas = await page.evaluate(async (c) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionComputeSas(claimHex: string): Promise<string>
    }
    return {
      first: await p.provisionComputeSas(c.claim),
      again: await p.provisionComputeSas(c.claim),
      different: await p.provisionComputeSas(c.otherPrimaryClaim),
    }
  }, claims!)
})

Then('it should be exactly 6 digits', async ({ cryptoWorld }) => {
  const first = cryptoWorld.sas?.first
  expect(first, 'the derive step must record the codes').toBeTruthy()
  // Rendered as "NNN NNN" for readability; the code itself is six digits.
  expect(first!.replace(/\s/g, '')).toMatch(/^\d{6}$/)
})

Then('it should equal the code the primary derived', async ({ cryptoWorld }) => {
  expect(cryptoWorld.sas?.first).toBe(cryptoWorld.sasClaims?.expected)
})

Then('deriving again with the same claim should produce the same code', async ({ cryptoWorld }) => {
  const s = cryptoWorld.sas
  expect(s?.again).toBe(s?.first)
})

Then('deriving with a different primary\'s claim should produce a different code', async ({ cryptoWorld }) => {
  const s = cryptoWorld.sas
  // A SAS that ignored its input would make the device-linking confirmation
  // meaningless — both peers would always read the same numbers.
  expect(s?.different).not.toBe(s?.first)
})

Then('a bare public key or another room\'s claim should be refused instead of yielding a code', async ({ page, cryptoWorld }) => {
  const claims = cryptoWorld.sasClaims
  expect(claims, 'the provisioning-room step must record the claims').toBeTruthy()
  const outcomes = await page.evaluate(async (c) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionComputeSas(claimHex: string): Promise<string>
    }
    const attempt = async (claimHex: string) => {
      try {
        return { code: await p.provisionComputeSas(claimHex) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    return {
      barePubkey: await attempt(c.barePubkey),
      otherRoom: await attempt(c.otherRoomClaim),
    }
  }, claims!)
  // An unauthenticated exchange must never reach a SAS the user could confirm.
  expect(outcomes.barePubkey.code).toBeUndefined()
  expect(outcomes.barePubkey.error).toMatch(/claim must be 129 bytes/)
  expect(outcomes.otherRoom.code).toBeUndefined()
  expect(outcomes.otherRoom.error).toMatch(/signature verification failed/)
})

// ─── Auth tokens ────────────────────────────────────────────────────────

async function createToken(page: Page, method: string, path: string, timestamp: number) {
  return page.evaluate(
    async ({ m, p: pth, ts }) => {
      const plat = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        createAuthToken(ts: number, method: string, path: string): Promise<string>
      }
      return JSON.parse(await plat.createAuthToken(ts, m, pth))
    },
    { m: method, p: path, ts: timestamp },
  ) as Promise<ParsedAuthToken>
}

Given('I have a loaded keypair with known pubkey', async ({ page, cryptoWorld }) => {
  await ensureAppLoaded(page)
  const state = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
      deviceGenerateAndLoad(pin: string, deviceId: string): Promise<EncryptedDeviceKeys>
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
    }
    if (!(await p.isCryptoUnlocked())) {
      await p.deviceGenerateAndLoad('12345678', crypto.randomUUID())
    }
    return p.getDevicePubkeys()
  })
  cryptoWorld.device = state
})

When('I create an auth token for {string} {string}', async ({ page, cryptoWorld }, method: string, path: string) => {
  const before = Date.now()
  const token = await createToken(page, method, path, Date.now())
  cryptoWorld.token = { ...token, method, path, createdAfter: before }
})

When('I create a second auth token for {string} {string}', async ({ page, cryptoWorld }, method: string, path: string) => {
  const token = await createToken(page, method, path, Date.now())
  cryptoWorld.token2 = { ...token, method, path }
})

Then('the token should contain the pubkey', async ({ cryptoWorld }) => {
  expect(cryptoWorld.token?.pubkey).toBe(cryptoWorld.device?.signingPubkeyHex)
})

Then('the token should contain a timestamp within the last minute', async ({ cryptoWorld }) => {
  const token = cryptoWorld.token
  expect(token?.createdAfter).toBeTruthy()
  expect(token!.timestamp).toBeGreaterThanOrEqual(token!.createdAfter as number)
  expect(token!.timestamp).toBeLessThanOrEqual(Date.now())
  expect(Date.now() - token!.timestamp).toBeLessThan(60_000)
})

Then('the token signature should be 128 hex characters', async ({ cryptoWorld }) => {
  // Ed25519 signature: 64 bytes.
  expect(cryptoWorld.token?.token).toMatch(/^[0-9a-f]{128}$/)
})

Then('the two tokens should have different signatures', async ({ cryptoWorld }) => {
  expect(cryptoWorld.token?.token).not.toBe(cryptoWorld.token2?.token)
})

/**
 * Verify a token against the exact message the device signed.
 *
 * The message comes from the canonical shared builder in Node — never rebuilt
 * by hand in the page, and never from a label literal. It must carry the
 * token's own nonce: the signer generates one, and a message assembled without
 * it is a different domain (`LABEL_DEVICE_AUTH_NO_NONCE`) that verification
 * correctly rejects.
 */
async function verifyToken(
  page: Page,
  token: ParsedAuthToken,
  method: string,
  path: string,
): Promise<boolean> {
  const msgHex = bytesToHex(buildAuthMessage(token.pubkey, token.timestamp, method, path, token.nonce))
  return page.evaluate(
    async ({ t, hex }) => {
      const plat = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        ed25519Verify(messageHex: string, sigHex: string, pubkeyHex: string): Promise<boolean>
      }
      return plat.ed25519Verify(hex, t.token, t.pubkey)
    },
    { t: token, hex: msgHex },
  ) as Promise<boolean>
}

Then('each token signature should verify against its own request', async ({ page, cryptoWorld }) => {
  const a = cryptoWorld.token
  const b = cryptoWorld.token2
  expect(a && b, 'both token steps must have run').toBeTruthy()
  expect(await verifyToken(page, a!, a!.method, a!.path)).toBe(true)
  expect(await verifyToken(page, b!, b!.method, b!.path)).toBe(true)
})

Then('neither token signature should verify against the other request', async ({ page, cryptoWorld }) => {
  const a = cryptoWorld.token
  const b = cryptoWorld.token2
  expect(a && b, 'both token steps must have run').toBeTruthy()
  // If the signature did not cover method and path, a captured token could be
  // replayed against a different endpoint.
  expect(await verifyToken(page, a!, b!.method, b!.path)).toBe(false)
  expect(await verifyToken(page, b!, a!.method, a!.path)).toBe(false)
})

When('I attempt to create an auth token while locked', async ({ page, cryptoWorld }) => {
  cryptoWorld.lockedToken = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      createAuthToken(ts: number, method: string, path: string): Promise<string>
    }
    try {
      await p.createAuthToken(Date.now(), 'GET', '/api/notes')
      return { rejected: false }
    } catch {
      return { rejected: true }
    }
  })
})

Then('auth token creation should have been rejected', async ({ cryptoWorld }) => {
  expect(cryptoWorld.lockedToken?.rejected, 'a locked crypto service must not sign auth tokens').toBe(true)
})

// ─── PIN encryption ─────────────────────────────────────────────────────

Given('I have a loaded keypair', async ({ page }) => {
  await ensureAppLoaded(page)
  const ready = await page.evaluate(() => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as
      | Record<string, unknown>
      | undefined
    return typeof p?.deviceGenerateAndLoad === 'function'
  })
  expect(ready, 'platform crypto API must be reachable from the page').toBe(true)
})

When('I encrypt the key with PIN {string}', async ({ page, cryptoWorld }, pin: string) => {
  // Keep the whole EncryptedDeviceKeys record: the structural assertions below
  // inspect this object directly. The previous version read a localStorage key
  // ('llamenos:llamenos-encrypted-key') that does not exist — the real one is
  // 'llamenos-encrypted-device-keys' — and then bailed out with `if (!data)
  // return`, so every assertion in those scenarios was silently skipped.
  const encrypted = await page.evaluate(async (p) => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceGenerateAndLoad(pin: string, deviceId: string): Promise<EncryptedDeviceKeys>
      persistAndUnlockDeviceKeys(encrypted: unknown, pin: string): Promise<unknown>
    }
    const enc = await platform.deviceGenerateAndLoad(p, crypto.randomUUID())
    await platform.persistAndUnlockDeviceKeys(enc, p)
    return enc
  }, pin)
  cryptoWorld.encrypted = encrypted
  cryptoWorld.device = encrypted.state
})

When('I lock the crypto service', async ({ page }) => {
  await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      lockCrypto(): Promise<void>
    }
    await p.lockCrypto()
  })
  const unlocked = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
    }
    return p.isCryptoUnlocked()
  })
  expect(unlocked, 'lockCrypto() must actually lock the service').toBe(false)
})

async function attemptUnlock(page: Page, encrypted: unknown, pin: string) {
  return page.evaluate(async ({ enc, p }) => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      unlockWithPin(data: unknown, pin: string): Promise<unknown | null>
    }
    try {
      const state = await platform.unlockWithPin(enc, p)
      return { ok: state !== null, error: null as string | null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, { enc: encrypted, p: pin })
}

When('I decrypt with PIN {string}', async ({ page, cryptoWorld }, pin: string) => {
  cryptoWorld.unlock = await attemptUnlock(page, cryptoWorld.encrypted, pin)
})

When('I attempt to decrypt with PIN {string}', async ({ page, cryptoWorld }, pin: string) => {
  cryptoWorld.unlock = await attemptUnlock(page, cryptoWorld.encrypted, pin)
})

Then('the crypto service should be unlocked', async ({ page }) => {
  const unlocked = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
    }
    return p.isCryptoUnlocked()
  })
  expect(unlocked).toBe(true)
})

Then('the crypto service should be locked', async ({ page }) => {
  const unlocked = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
    }
    return p.isCryptoUnlocked()
  })
  expect(unlocked).toBe(false)
})

Then('the crypto service should remain locked', async ({ page }) => {
  const unlocked = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
    }
    return p.isCryptoUnlocked()
  })
  expect(unlocked).toBe(false)
})

Then('the pubkey should match the original', async ({ page, cryptoWorld }) => {
  const pubkey = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<{ signingPubkeyHex: string } | null>
    }
    return (await p.getDevicePubkeys())?.signingPubkeyHex ?? null
  })
  expect(pubkey).toBe(cryptoWorld.device?.signingPubkeyHex)
})

Then('decryption should fail with {string}', async ({ cryptoWorld }, errorText: string) => {
  const result = cryptoWorld.unlock
  expect(result?.ok, 'unlock with the wrong PIN must not succeed').toBe(false)
  if (result?.error) {
    expect(result.error).toMatch(new RegExp(errorText, 'i'))
  }
})

Then('the encrypted data should have a non-empty ciphertext', async ({ cryptoWorld }) => {
  const enc = cryptoWorld.encrypted
  expect(enc?.ciphertext).toMatch(/^[0-9a-f]+$/)
  // 64 bytes of seed material + a 16-byte GCM tag = 80 bytes = 160 hex chars.
  expect(enc!.ciphertext.length).toBeGreaterThanOrEqual(160)
})

Then('the encrypted data should have a non-empty salt', async ({ cryptoWorld }) => {
  expect(cryptoWorld.encrypted?.salt).toMatch(/^[0-9a-f]+$/)
})

Then('the encrypted data should have a non-empty nonce', async ({ cryptoWorld }) => {
  expect(cryptoWorld.encrypted?.nonce).toMatch(/^[0-9a-f]+$/)
})

Then('the encrypted data should have a pubkey matching the original', async ({ cryptoWorld }) => {
  const enc = cryptoWorld.encrypted
  expect(enc?.state.signingPubkeyHex).toBe(cryptoWorld.device?.signingPubkeyHex)
  expect(enc!.state.signingPubkeyHex).toMatch(HEX64)
})

Then('the encrypted data should declare KDF version {int}', async ({ cryptoWorld }, version: number) => {
  expect(cryptoWorld.encrypted?.kdfVersion).toBe(version)
})

Then('the encrypted data should carry a 32-byte salt', async ({ cryptoWorld }) => {
  expect(cryptoWorld.encrypted?.salt).toHaveLength(64)
})

Then('the encrypted data should carry a 12-byte nonce', async ({ cryptoWorld }) => {
  // AES-256-GCM nonce.
  expect(cryptoWorld.encrypted?.nonce).toHaveLength(24)
})

Then(
  'the encrypted data should declare positive Argon2 memory, time and parallelism costs',
  async ({ cryptoWorld }) => {
    const enc = cryptoWorld.encrypted
    expect(enc, 'the encrypt step must record the encrypted record').toBeTruthy()
    // Values are not asserted: the Playwright mock deliberately uses reduced
    // Argon2 costs for speed, so pinning a number here would assert the mock's
    // weakened parameters. The shipped costs are asserted in Rust
    // (packages/crypto/src/kdf_params.rs and its tests).
    expect(enc!.argon2MCost).toBeGreaterThan(0)
    expect(enc!.argon2TCost).toBeGreaterThan(0)
    expect(enc!.argon2PCost).toBeGreaterThan(0)
  },
)

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
import { Given, When, Then } from '../fixtures'
import * as clientLabels from '@shared/crypto-labels'

const __dirname_ = dirname(fileURLToPath(import.meta.url))
const CRYPTO_LABELS_JSON = resolve(__dirname_, '../../../packages/protocol/crypto-labels.json')

/** Shape returned by platform.deviceGenerateAndLoad / deviceImportAndLoad. */
type EncryptedDeviceKeys = {
  kdfVersion: number
  salt: string
  nonce: string
  ciphertext: string
  argon2MCost: number
  argon2TCost: number
  argon2PCost: number
  state: { deviceId: string; signingPubkeyHex: string; encryptionPubkeyHex: string }
}

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

/** Read a value previously stashed on `window` by an earlier step. */
function stash<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(k => (window as unknown as Record<string, unknown>)[k], key) as Promise<T>
}

/** Write a value onto `window` for a later step in the same scenario. */
async function setStash(page: Page, key: string, value: unknown) {
  await page.evaluate(
    ([k, v]) => {
      ;(window as unknown as Record<string, unknown>)[k as string] = v
    },
    [key, value] as [string, unknown],
  )
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

When('I generate a device keypair', async ({ page }) => {
  await ensureAppLoaded(page)
  await setStash(page, '__test_device', await generateDevice(page))
})

Then('the signing public key should be 64 hex characters', async ({ page }) => {
  const d = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(d.signingPubkeyHex).toMatch(HEX64)
})

Then('the encryption public key should be 64 hex characters', async ({ page }) => {
  const d = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(d.encryptionPubkeyHex).toMatch(HEX64)
})

Then('the signing and encryption public keys should differ', async ({ page }) => {
  const d = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  // Ed25519 signing key and X25519 encryption key are derived from separate
  // seeds; a device where these collide would mean one seed is being reused
  // for both roles.
  expect(d.signingPubkeyHex).not.toBe(d.encryptionPubkeyHex)
})

When('I generate device keypair A', async ({ page }) => {
  await ensureAppLoaded(page)
  await setStash(page, '__test_device_a', await generateDevice(page))
})

When('I generate device keypair B', async ({ page }) => {
  await setStash(page, '__test_device_b', await generateDevice(page))
})

Then("device keypair A's signing public key should differ from B's", async ({ page }) => {
  const a = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_a')
  const b = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_b')
  expect(a.signingPubkeyHex).toMatch(HEX64)
  expect(b.signingPubkeyHex).toMatch(HEX64)
  expect(a.signingPubkeyHex).not.toBe(b.signingPubkeyHex)
})

Then("device keypair A's encryption public key should differ from B's", async ({ page }) => {
  const a = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_a')
  const b = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_b')
  expect(a.encryptionPubkeyHex).not.toBe(b.encryptionPubkeyHex)
})

// Shared with @ios/@android via the feature file — keep the wording.
When('I generate a keypair', async ({ page }) => {
  await ensureAppLoaded(page)
  await setStash(page, '__test_device', await generateDevice(page))
})

Then('the public key hex should be 64 characters', async ({ page }) => {
  const d = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(d.signingPubkeyHex).toHaveLength(64)
})

Then('the public key should only contain hex characters [0-9a-f]', async ({ page }) => {
  const d = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(d.signingPubkeyHex).toMatch(/^[0-9a-f]+$/)
})

// ─── Signing-seed import determinism ────────────────────────────────────
//
// The seed is generated inside the mock/Rust and handed back only so that a
// second device can be derived from it. It is stashed on the page for the
// next step and never asserted on, logged, or printed.

When('I generate a device keypair and keep its signing seed', async ({ page }) => {
  await ensureAppLoaded(page)
  const result = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      generateEphemeralKeypair(): Promise<{ publicKey: string; seedHex: string }>
      deviceImportAndLoad(s: string, pin: string, d: string): Promise<EncryptedDeviceKeys>
    }
    const eph = await p.generateEphemeralKeypair()
    const imported = await p.deviceImportAndLoad(eph.seedHex, '12345678', crypto.randomUUID())
    // Keep the seed only in page memory for the follow-up import step.
    ;(window as unknown as Record<string, unknown>).__test_seed = eph.seedHex
    return imported.state
  })
  await setStash(page, '__test_device', result)
})

When('I import that signing seed into a fresh device', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceImportAndLoad(s: string, pin: string, d: string): Promise<EncryptedDeviceKeys>
    }
    const seed = (window as unknown as Record<string, unknown>).__test_seed as string
    // A different deviceId and a different PIN: the derived identity must
    // depend only on the seed, not on either of those.
    const imported = await p.deviceImportAndLoad(seed, '87654321', crypto.randomUUID())
    return imported.state
  })
  await setStash(page, '__test_device_reimported', result)
})

Then('the imported signing public key should match the original', async ({ page }) => {
  const orig = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  const re = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_reimported')
  expect(re.signingPubkeyHex).toMatch(HEX64)
  expect(re.signingPubkeyHex).toBe(orig.signingPubkeyHex)
})

Then('the imported encryption public key should match the original', async ({ page }) => {
  const orig = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  const re = await stash<EncryptedDeviceKeys['state']>(page, '__test_device_reimported')
  // The X25519 encryption key is HKDF-derived from the same signing seed, so
  // re-importing must reproduce it too — otherwise a re-imported device could
  // not open envelopes wrapped for the original.
  expect(re.encryptionPubkeyHex).toBe(orig.encryptionPubkeyHex)
})

// ─── Ephemeral keypair (device linking) ─────────────────────────────────

When('I generate an ephemeral keypair', async ({ page }) => {
  await ensureAppLoaded(page)
  const pair = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      generateEphemeralKeypair(): Promise<{ publicKey: string }>
    }
    const a = await p.generateEphemeralKeypair()
    const b = await p.generateEphemeralKeypair()
    return { a: a.publicKey, b: b.publicKey }
  })
  await setStash(page, '__test_eph', pair)
})

Then('the ephemeral public key should be 64 hex characters', async ({ page }) => {
  const { a } = await stash<{ a: string; b: string }>(page, '__test_eph')
  expect(a).toMatch(HEX64)
})

Then('generating another ephemeral keypair should produce a different public key', async ({ page }) => {
  const { a, b } = await stash<{ a: string; b: string }>(page, '__test_eph')
  expect(b).toMatch(HEX64)
  expect(b).not.toBe(a)
})

// ─── Envelope encryption through the app crypto path ────────────────────

Given('I have an unlocked device', async ({ page }) => {
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
  await setStash(page, '__test_device', state)
})

const NOTE_PAYLOAD = JSON.stringify({ text: 'interop note', fields: { severity: 'high' } })

When('I encrypt a note for the author and no admins', async ({ page }) => {
  const note = await page.evaluate(async (payload) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<unknown>
    }
    const me = await p.getDevicePubkeys()
    return p.encryptNote(payload, me.signingPubkeyHex, [])
  }, NOTE_PAYLOAD)
  await setStash(page, '__test_note', note)
})

When('I decrypt that note with the author envelope', async ({ page }) => {
  const plaintext = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptNote(content: string, envelope: unknown): Promise<string | null>
    }
    const note = (window as unknown as Record<string, unknown>).__test_note as {
      encryptedContent: string
      authorEnvelope: unknown
    }
    return p.decryptNote(note.encryptedContent, note.authorEnvelope)
  })
  await setStash(page, '__test_note_plaintext', plaintext)
})

Then('the decrypted note should match the original payload', async ({ page }) => {
  const plaintext = await stash<string | null>(page, '__test_note_plaintext')
  expect(plaintext).toBe(NOTE_PAYLOAD)
})

Given('two admin encryption public keys', async ({ page }) => {
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
  await setStash(page, '__test_admins', admins)
})

When('I encrypt a note for the author and both admins', async ({ page }) => {
  const note = await page.evaluate(async (payload) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<unknown>
    }
    const me = await p.getDevicePubkeys()
    const admins = (window as unknown as Record<string, unknown>).__test_admins as string[]
    return p.encryptNote(payload, me.signingPubkeyHex, admins)
  }, NOTE_PAYLOAD)
  await setStash(page, '__test_note', note)
})

Then('the note should carry one admin envelope per admin', async ({ page }) => {
  const admins = await stash<string[]>(page, '__test_admins')
  const note = await stash<{ adminEnvelopes: Array<{ pubkey: string }> }>(page, '__test_note')
  expect(note.adminEnvelopes).toHaveLength(admins.length)
  expect(note.adminEnvelopes.map(e => e.pubkey).sort()).toEqual([...admins].sort())
})

Then('every admin envelope should name a distinct recipient', async ({ page }) => {
  const note = await stash<{
    adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
  }>(page, '__test_note')
  const pubkeys = note.adminEnvelopes.map(e => e.pubkey)
  expect(new Set(pubkeys).size).toBe(pubkeys.length)
  // Each recipient gets an independently sealed envelope: same content key,
  // different HPKE encapsulation. Identical ct across recipients would mean
  // the wrap is not actually per-recipient.
  const cts = note.adminEnvelopes.map(e => e.ct)
  expect(new Set(cts).size).toBe(cts.length)
})

When('I encrypt the same payload as two separate notes', async ({ page }) => {
  const notes = await page.evaluate(async (payload) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
      encryptNote(payload: string, author: string, admins: string[]): Promise<{
        encryptedContent: string
        authorEnvelope: { enc: string; ct: string }
      }>
      hpkeOpenKeyFromState(env: unknown, expected: string, aad: string): Promise<string>
    }
    const me = await p.getDevicePubkeys()
    const one = await p.encryptNote(payload, me.signingPubkeyHex, [])
    const two = await p.encryptNote(payload, me.signingPubkeyHex, [])

    // Recover the actual content keys. Comparing the WRAPPED keys would prove
    // nothing: HPKE draws a fresh ephemeral per seal, so two wraps of the very
    // same key still differ byte-for-byte. Only the unwrapped key is evidence.
    // Verified by mutation: pinning encryptNote to a constant content key left
    // a wrapped-ciphertext comparison green.
    const toEnv = (e: { enc: string; ct: string }) => ({
      v: 3,
      labelId: 0, // LABEL_NOTE_KEY
      enc: btoa(String.fromCharCode(...(e.enc.match(/../g) ?? []).map(h => parseInt(h, 16))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      ct: e.ct,
    })
    const k1 = await p.hpkeOpenKeyFromState(toEnv(one.authorEnvelope), 'llamenos:note-key', '')
    const k2 = await p.hpkeOpenKeyFromState(toEnv(two.authorEnvelope), 'llamenos:note-key', '')
    return {
      one: { encryptedContent: one.encryptedContent },
      two: { encryptedContent: two.encryptedContent },
      keysEqual: k1 === k2,
      keyLen: k1.length,
    }
  }, NOTE_PAYLOAD)
  await setStash(page, '__test_notes_pair', notes)
})

Then('the two notes should have different ciphertext', async ({ page }) => {
  const { one, two } = await stash<{
    one: { encryptedContent: string }
    two: { encryptedContent: string }
  }>(page, '__test_notes_pair')
  expect(one.encryptedContent).toBeTruthy()
  expect(one.encryptedContent).not.toBe(two.encryptedContent)
})

Then('the two notes should have different wrapped content keys', async ({ page }) => {
  const { keysEqual, keyLen } = await stash<{ keysEqual: boolean; keyLen: number }>(
    page,
    '__test_notes_pair',
  )
  // Per-note forward secrecy: a fresh random content key per note. The keys are
  // unwrapped and compared inside the page, so only this boolean and the length
  // cross back — no key material reaches the test runner.
  expect(keyLen, 'content key should be 32 bytes').toBe(64)
  expect(keysEqual, 'two notes must not share a content key').toBe(false)
})

When('I flip one byte of the note ciphertext', async ({ page }) => {
  await page.evaluate(() => {
    const note = (window as unknown as Record<string, unknown>).__test_note as {
      encryptedContent: string
    }
    const hex = note.encryptedContent
    // Flip one nibble in the middle of the ciphertext body (past the 12-byte
    // IV) so the AES-GCM tag check must reject it.
    const i = Math.floor(hex.length / 2)
    const flipped = (parseInt(hex[i], 16) ^ 0x1).toString(16)
    ;(window as unknown as Record<string, unknown>).__test_tampered =
      hex.slice(0, i) + flipped + hex.slice(i + 1)
  })
})

Then('decrypting the tampered note should return null', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptNote(content: string, envelope: unknown): Promise<string | null>
    }
    const w = window as unknown as Record<string, unknown>
    const note = w.__test_note as { authorEnvelope: unknown }
    return p.decryptNote(w.__test_tampered as string, note.authorEnvelope)
  })
  expect(result).toBeNull()
})

When('I encrypt a message for this device and one other reader', async ({ page }) => {
  const out = await page.evaluate(async () => {
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
  await setStash(page, '__test_msg', out)
})

Then('this device can decrypt the message', async ({ page }) => {
  const plaintext = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptMessage(content: string, envelopes: unknown[]): Promise<string | null>
    }
    const { msg } = (window as unknown as Record<string, unknown>).__test_msg as {
      msg: { encryptedContent: string; readerEnvelopes: unknown[] }
    }
    return p.decryptMessage(msg.encryptedContent, msg.readerEnvelopes)
  })
  expect(plaintext).toBe('hotline message body')
})

Then('a reader whose envelope is absent cannot decrypt the message', async ({ page }) => {
  const plaintext = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      decryptMessage(content: string, envelopes: unknown[]): Promise<string | null>
    }
    const { msg, mine } = (window as unknown as Record<string, unknown>).__test_msg as {
      msg: {
        encryptedContent: string
        readerEnvelopes: Array<{ pubkey: string }>
      }
      mine: string
    }
    // Present only the OTHER reader's envelope. This device holds no key that
    // opens it, so decryption must fail rather than fall back to any other
    // envelope in the list.
    const withoutMine = msg.readerEnvelopes.filter(e => e.pubkey !== mine)
    return p.decryptMessage(msg.encryptedContent, withoutMine)
  })
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

// ─── Label enforcement at unwrap (Albrecht defense) ─────────────────────
//
// This asserts that the CLIENT passes an expected label to the unwrap call and
// refuses a mismatch, rather than trusting whatever labelId the envelope
// carries. The equivalent property of the Rust implementation is covered by
// packages/crypto/tests/interop.rs::hpke_cross_label_rejection and
// ::domain_separation_all_labels.

When('I wrap a key under the label {string}', async ({ page }, labelName: string) => {
  const label = (clientLabels as unknown as Record<string, string>)[labelName]
  expect(label, `unknown label constant ${labelName}`).toBeTruthy()
  const envelope = await page.evaluate(
    async (lbl) => {
      const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
        hpkeSealKey(k: string, pub: string, label: string, aad: string): Promise<unknown>
      }
      const me = await p.getDevicePubkeys()
      const keyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)), b =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      const env = await p.hpkeSealKey(keyHex, me.encryptionPubkeyHex, lbl, '')
      return { env, keyHex }
    },
    label,
  )
  await setStash(page, '__test_wrapped', envelope)
})

Then('unwrapping it under the label {string} should succeed', async ({ page }, labelName: string) => {
  const label = (clientLabels as unknown as Record<string, string>)[labelName]
  const result = await page.evaluate(async (lbl) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      hpkeOpenKeyFromState(env: unknown, expected: string, aad: string): Promise<string>
    }
    const w = (window as unknown as Record<string, unknown>).__test_wrapped as {
      env: unknown
      keyHex: string
    }
    try {
      const got = await p.hpkeOpenKeyFromState(w.env, lbl, '')
      return { ok: got === w.keyHex, error: null as string | null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, label)
  expect(result.error).toBeNull()
  // Compare the unwrapped key to the original inside the page; only the
  // boolean crosses back, so no key material is ever surfaced to the runner.
  expect(result.ok, 'unwrapped key should equal the key that was wrapped').toBe(true)
})

Then('unwrapping it under the label {string} should be rejected', async ({ page }, labelName: string) => {
  const label = (clientLabels as unknown as Record<string, string>)[labelName]
  expect(label, `unknown label constant ${labelName}`).toBeTruthy()
  const result = await page.evaluate(async (lbl) => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      hpkeOpenKeyFromState(env: unknown, expected: string, aad: string): Promise<string>
    }
    const w = (window as unknown as Record<string, unknown>).__test_wrapped as { env: unknown }
    try {
      await p.hpkeOpenKeyFromState(w.env, lbl, '')
      return { rejected: false, error: null as string | null }
    } catch (e) {
      return { rejected: true, error: e instanceof Error ? e.message : String(e) }
    }
  }, label)
  expect(result.rejected, `unwrap under ${labelName} must be rejected, but it succeeded`).toBe(true)
})

// ─── SAS derivation ─────────────────────────────────────────────────────

Given('a shared secret hex string', async ({ page }) => {
  await ensureAppLoaded(page)
  const keys = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      isCryptoUnlocked(): Promise<boolean>
      deviceGenerateAndLoad(pin: string, deviceId: string): Promise<EncryptedDeviceKeys>
      provisionCreateSession(): Promise<string>
      getDevicePubkeys(): Promise<EncryptedDeviceKeys['state']>
    }
    if (!(await p.isCryptoUnlocked())) {
      await p.deviceGenerateAndLoad('12345678', crypto.randomUUID())
    }
    // A provisioning session fixes this side's ephemeral key; the peer's
    // encryption pubkey is the "shared secret" input that varies.
    await p.provisionCreateSession()
    const me = await p.getDevicePubkeys()
    const other = await p.provisionCreateSession()
    return { peerA: me.encryptionPubkeyHex, peerB: other }
  })
  await setStash(page, '__test_sas_peers', keys)
})

When('I derive the SAS code', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      provisionComputeSas(peer: string): Promise<string>
    }
    const { peerA, peerB } = (window as unknown as Record<string, unknown>).__test_sas_peers as {
      peerA: string
      peerB: string
    }
    return {
      first: await p.provisionComputeSas(peerA),
      again: await p.provisionComputeSas(peerA),
      different: await p.provisionComputeSas(peerB),
    }
  })
  await setStash(page, '__test_sas', codes)
})

Then('it should be exactly 6 digits', async ({ page }) => {
  const { first } = await stash<{ first: string }>(page, '__test_sas')
  // Rendered as "NNN NNN" for readability; the code itself is six digits.
  expect(first.replace(/\s/g, '')).toMatch(/^\d{6}$/)
})

Then('deriving again with the same secret should produce the same code', async ({ page }) => {
  const { first, again } = await stash<{ first: string; again: string }>(page, '__test_sas')
  expect(again).toBe(first)
})

Then('deriving with a different secret should produce a different code', async ({ page }) => {
  const { first, different } = await stash<{ first: string; different: string }>(page, '__test_sas')
  // A SAS that ignored its input would make the device-linking confirmation
  // meaningless — both peers would always read the same numbers.
  expect(different).not.toBe(first)
})

// ─── Auth tokens ────────────────────────────────────────────────────────

type ParsedToken = { pubkey: string; timestamp: number; token: string }

async function createToken(page: Page, method: string, path: string, timestamp: number) {
  return page.evaluate(
    async ({ m, p: pth, ts }) => {
      const plat = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        createAuthToken(ts: number, method: string, path: string, nonce?: string): Promise<string>
      }
      return JSON.parse(await plat.createAuthToken(ts, m, pth))
    },
    { m: method, p: path, ts: timestamp },
  ) as Promise<ParsedToken>
}

Given('I have a loaded keypair with known pubkey', async ({ page }) => {
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
  await setStash(page, '__test_device', state)
})

When('I create an auth token for {string} {string}', async ({ page }, method: string, path: string) => {
  const before = Date.now()
  const token = await createToken(page, method, path, Date.now())
  await setStash(page, '__test_token', { ...token, method, path, createdAfter: before })
})

When('I create a second auth token for {string} {string}', async ({ page }, method: string, path: string) => {
  const token = await createToken(page, method, path, Date.now())
  await setStash(page, '__test_token2', { ...token, method, path })
})

Then('the token should contain the pubkey', async ({ page }) => {
  const token = await stash<ParsedToken>(page, '__test_token')
  const device = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(token.pubkey).toBe(device.signingPubkeyHex)
})

Then('the token should contain a timestamp within the last minute', async ({ page }) => {
  const token = await stash<ParsedToken & { createdAfter: number }>(page, '__test_token')
  expect(token.timestamp).toBeGreaterThanOrEqual(token.createdAfter)
  expect(token.timestamp).toBeLessThanOrEqual(Date.now())
  expect(Date.now() - token.timestamp).toBeLessThan(60_000)
})

Then('the token signature should be 128 hex characters', async ({ page }) => {
  const token = await stash<ParsedToken>(page, '__test_token')
  // Ed25519 signature: 64 bytes.
  expect(token.token).toMatch(/^[0-9a-f]{128}$/)
})

Then('the two tokens should have different signatures', async ({ page }) => {
  const a = await stash<ParsedToken>(page, '__test_token')
  const b = await stash<ParsedToken>(page, '__test_token2')
  expect(a.token).not.toBe(b.token)
})

/**
 * Rebuild the exact message the device signs and verify it with Ed25519.
 * Format (Rust build_auth_message, mirrored in tests/mocks/tauri-core.ts):
 *   llamenos:device-auth:v1:{pubkey}:{timestamp}:{method}:{path}
 */
async function verifyToken(
  page: Page,
  token: ParsedToken,
  method: string,
  path: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ t, m, p: pth }) => {
      const plat = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
        ed25519Verify(messageHex: string, sigHex: string, pubkeyHex: string): Promise<boolean>
      }
      const msg = `llamenos:device-auth:v1:${t.pubkey}:${t.timestamp}:${m}:${pth}`
      const msgHex = Array.from(new TextEncoder().encode(msg), b =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      return plat.ed25519Verify(msgHex, t.token, t.pubkey)
    },
    { t: token, m: method, p: path },
  ) as Promise<boolean>
}

Then('each token signature should verify against its own request', async ({ page }) => {
  const a = await stash<ParsedToken & { method: string; path: string }>(page, '__test_token')
  const b = await stash<ParsedToken & { method: string; path: string }>(page, '__test_token2')
  expect(await verifyToken(page, a, a.method, a.path)).toBe(true)
  expect(await verifyToken(page, b, b.method, b.path)).toBe(true)
})

Then('neither token signature should verify against the other request', async ({ page }) => {
  const a = await stash<ParsedToken & { method: string; path: string }>(page, '__test_token')
  const b = await stash<ParsedToken & { method: string; path: string }>(page, '__test_token2')
  // If the signature did not cover method and path, a captured token could be
  // replayed against a different endpoint.
  expect(await verifyToken(page, a, b.method, b.path)).toBe(false)
  expect(await verifyToken(page, b, a.method, a.path)).toBe(false)
})

When('I attempt to create an auth token while locked', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
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
  await setStash(page, '__test_locked_token', outcome)
})

Then('auth token creation should have been rejected', async ({ page }) => {
  const { rejected } = await stash<{ rejected: boolean }>(page, '__test_locked_token')
  expect(rejected, 'a locked crypto service must not sign auth tokens').toBe(true)
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

When('I encrypt the key with PIN {string}', async ({ page }, pin: string) => {
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
  await setStash(page, '__test_encrypted', encrypted)
  await setStash(page, '__test_device', encrypted.state)
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

async function attemptUnlock(page: Page, pin: string) {
  return page.evaluate(async (p) => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      unlockWithPin(data: unknown, pin: string): Promise<unknown | null>
    }
    const enc = (window as unknown as Record<string, unknown>).__test_encrypted
    try {
      const state = await platform.unlockWithPin(enc, p)
      return { ok: state !== null, error: null as string | null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, pin)
}

When('I decrypt with PIN {string}', async ({ page }, pin: string) => {
  await setStash(page, '__test_unlock', await attemptUnlock(page, pin))
})

When('I attempt to decrypt with PIN {string}', async ({ page }, pin: string) => {
  await setStash(page, '__test_unlock', await attemptUnlock(page, pin))
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

Then('the pubkey should match the original', async ({ page }) => {
  const pubkey = await page.evaluate(async () => {
    const p = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      getDevicePubkeys(): Promise<{ signingPubkeyHex: string } | null>
    }
    return (await p.getDevicePubkeys())?.signingPubkeyHex ?? null
  })
  const device = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(pubkey).toBe(device.signingPubkeyHex)
})

Then('decryption should fail with {string}', async ({ page }, errorText: string) => {
  const result = await stash<{ ok: boolean; error: string | null }>(page, '__test_unlock')
  expect(result.ok, 'unlock with the wrong PIN must not succeed').toBe(false)
  if (result.error) {
    expect(result.error).toMatch(new RegExp(errorText, 'i'))
  }
})

Then('the encrypted data should have a non-empty ciphertext', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  expect(enc.ciphertext).toMatch(/^[0-9a-f]+$/)
  // 64 bytes of seed material + a 16-byte GCM tag = 80 bytes = 160 hex chars.
  expect(enc.ciphertext.length).toBeGreaterThanOrEqual(160)
})

Then('the encrypted data should have a non-empty salt', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  expect(enc.salt).toMatch(/^[0-9a-f]+$/)
})

Then('the encrypted data should have a non-empty nonce', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  expect(enc.nonce).toMatch(/^[0-9a-f]+$/)
})

Then('the encrypted data should have a pubkey matching the original', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  const device = await stash<EncryptedDeviceKeys['state']>(page, '__test_device')
  expect(enc.state.signingPubkeyHex).toBe(device.signingPubkeyHex)
  expect(enc.state.signingPubkeyHex).toMatch(HEX64)
})

Then('the encrypted data should declare KDF version {int}', async ({ page }, version: number) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  expect(enc.kdfVersion).toBe(version)
})

Then('the encrypted data should carry a 32-byte salt', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  expect(enc.salt).toHaveLength(64)
})

Then('the encrypted data should carry a 12-byte nonce', async ({ page }) => {
  const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
  // AES-256-GCM nonce.
  expect(enc.nonce).toHaveLength(24)
})

Then(
  'the encrypted data should declare positive Argon2 memory, time and parallelism costs',
  async ({ page }) => {
    const enc = await stash<EncryptedDeviceKeys>(page, '__test_encrypted')
    // Values are not asserted: the Playwright mock deliberately uses reduced
    // Argon2 costs for speed, so pinning a number here would assert the mock's
    // weakened parameters. The shipped costs are asserted in Rust
    // (packages/crypto/src/kdf_params.rs and its tests).
    expect(enc.argon2MCost).toBeGreaterThan(0)
    expect(enc.argon2TCost).toBeGreaterThan(0)
    expect(enc.argon2PCost).toBeGreaterThan(0)
  },
)

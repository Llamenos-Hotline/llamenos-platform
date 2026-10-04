/**
 * `scripts/bootstrap-admin.ts` — the CLI that mints the first admin.
 *
 * The bug these tests pin: `generateEd25519Keypair()` never derived a public
 * key. It returned `bytesToHex(seed)` as `pubkeyHex`, printed the same 32 bytes
 * under both "PUBLIC KEY" and "SECRET KEY", and told the operator to put that
 * value in `ADMIN_PUBKEY`. Two consequences, both unrecoverable without hand-
 * editing Postgres:
 *
 *   a) the admin's private seed was written into server config / the vault;
 *   b) the value could never equal a real pubkey, so `ensurePlatformAdmin`
 *      seeded an unusable admin row, `hasAdmin()` then returned true, and
 *      `POST /api/auth/bootstrap` answered 403 "Admin already exists"
 *      (apps/worker/routes/auth.ts:118-121) forever.
 *
 * The seed→pubkey assertions use the RFC 8032 §7.1 vectors so they are
 * independent of the implementation under test: a regression that echoes the
 * seed, or swaps in a different curve, fails against a fixed expected value
 * rather than against a value this file computed the same way.
 */
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  deriveAdminKeys,
  formatBootstrapOutput,
  generateAdminKeys,
} from '../../../../scripts/bootstrap-admin'

/** RFC 8032 §7.1, Test 1. */
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const RFC8032_PUBKEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

describe('bootstrap-admin key derivation', () => {
  it('derives the real Ed25519 verifying key, not the seed', () => {
    const keys = deriveAdminKeys(hexToBytes(RFC8032_SEED))

    expect(keys.identityPubkey).toBe(RFC8032_PUBKEY)
    // The whole bug in one assertion.
    expect(keys.identityPubkey).not.toBe(keys.seedHex)
  })

  it('produces a pubkey a signature made with the seed verifies under', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const keys = deriveAdminKeys(seed)

    const message = new TextEncoder().encode('llamenos:bootstrap-admin:selftest')
    const signature = ed25519.sign(message, seed)

    expect(ed25519.verify(signature, message, hexToBytes(keys.identityPubkey))).toBe(true)
    // ...and the seed itself is not a key that signature verifies under, which
    // is what shipping `ADMIN_PUBKEY=<seed>` amounted to.
    expect(() => ed25519.verify(signature, message, seed)).not.toThrowError(/^$/)
    expect(ed25519.verify(signature, message, seed)).toBe(false)
  })

  it('derives the X25519 decryption key from the same seed, distinct from both', () => {
    const keys = deriveAdminKeys(hexToBytes(RFC8032_SEED))

    expect(keys.decryptionPubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.decryptionPubkey).not.toBe(keys.seedHex)
    expect(keys.decryptionPubkey).not.toBe(keys.identityPubkey)
    // Deterministic in the seed: the client re-derives it on import
    // (apps/desktop/src/crypto.rs::derive_encryption_seed_from_signing), so a
    // change here silently breaks decryption for every admin envelope.
    expect(keys.decryptionPubkey).toBe(deriveAdminKeys(hexToBytes(RFC8032_SEED)).decryptionPubkey)
  })

  it('rejects a seed that is not 32 bytes rather than deriving from it', () => {
    expect(() => deriveAdminKeys(new Uint8Array(31))).toThrow(/32 bytes/)
  })

  it('generates a fresh 32-byte seed each run', () => {
    const a = generateAdminKeys()
    const b = generateAdminKeys()

    expect(hexToBytes(a.seedHex)).toHaveLength(32)
    expect(a.seedHex).not.toBe(b.seedHex)
    expect(a.identityPubkey).not.toBe(b.identityPubkey)
  })
})

describe('bootstrap-admin operator output', () => {
  const keys = deriveAdminKeys(hexToBytes(RFC8032_SEED))
  const serverSecret = bytesToHex(new Uint8Array(32).fill(7))
  const output = formatBootstrapOutput(keys, serverSecret)

  it('never offers the seed as a value to put in server config', () => {
    for (const line of output.split('\n')) {
      if (!line.includes(keys.seedHex)) continue
      // The seed may only appear as the labelled secret, never assigned to an
      // env var or a vault key the operator is told to set.
      expect(line).not.toMatch(/ADMIN_PUBKEY|ADMIN_DECRYPTION_PUBKEY|admin_pubkey|=/)
    }
  })

  it('assigns the derived public keys to the env vars the server reads', () => {
    expect(output).toContain(`ADMIN_PUBKEY=${keys.identityPubkey}`)
    expect(output).toContain(`ADMIN_DECRYPTION_PUBKEY=${keys.decryptionPubkey}`)
    expect(output).toContain(`SERVER_SECRET=${serverSecret}`)
  })

  it('does not instruct the operator to use wrangler — this backend is Bun + PostgreSQL', () => {
    expect(output).not.toMatch(/wrangler secret put/)
    expect(output).toMatch(/Ansible|vault/i)
  })
})

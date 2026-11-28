/**
 * Device key binding (#2496; spec 2026-11-25-v2-device-linking-and-recovery
 * §5–§6) against real PostgreSQL and the real crate, under bun:ffi.
 *
 * MUST run under `bun test` (the verifier is `ffi_sigchain_verify`, which the
 * vitest mock refuses to imitate):
 *   bun test apps/worker/__tests__/integration-bun/device-key-binding.test.ts
 *
 * The cross-platform vectors (`packages/crypto/tests/fixtures/v2/device-binding.json`)
 * go through the server's production append path, `CryptoKeysService
 * .appendSigchainLink`, link by link:
 *   - every positive chain is accepted: a genesis naming its X-Wing key with a
 *     pop, and a pop-carrying device_add;
 *   - every negative is refused at its last link, with the server's code for it.
 * Then the registration half: `IdentityService.registerDevice` refuses a key
 * another user holds and writes no row, and a migration-shaped backfill is not
 * needed here — the claims are made by the same writes.
 *
 * Requires postgres at DATABASE_URL with migrations applied. Everything created
 * here, claims included, is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { deviceKeyClaims, devices, sigchainLinks, users } from '../../db/schema'
import { CryptoKeyError, CryptoKeysService } from '../../services/crypto-keys'
import { IdentityService } from '../../services/identity'
import { ServiceError } from '../../services/service-error'
import type { AppendSigchainLinkBody, SigchainLinkType } from '@protocol/schemas/sigchain'
import type { SigchainLink } from '@llamenos/crypto/ffi'
import { requireDatabaseUrl } from '../helpers/database-url'
import { sigchainVerify } from '@llamenos/crypto/ffi'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DEVICE_KEM_FORMAT,
  createSigchainLinkMock,
  signDevicePopMock,
  userInitPayloadMock,
} from '../../../../tests/mocks/sigchain-mock'

const db = createDatabase(requireDatabaseUrl())
const keys = new CryptoKeysService(db)
const identity = new IdentityService(db)

interface Case {
  name: string
  chains: SigchainLink[][]
  expect: unknown
}
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../packages/crypto/tests/fixtures/v2/device-binding.json'), 'utf8'),
) as { positives: Case[]; negatives: Case[] }

/**
 * What the server answers for each negative vector's last link: its HTTP status
 * and `code`. A shape the protocol schema already refuses (a genesis naming an
 * X25519 key or no X-Wing key at all; a device_add with no pop) is a plain 400
 * before the crate is consulted; a chain the crate refuses carries the crate's
 * code; a key another user holds is the claim's 409.
 */
const SERVER_REFUSAL: Record<string, { status: number; code?: string }> = {
  user_init_with_x25519_key: { status: 400 },
  user_init_without_xwing_key: { status: 400 },
  user_init_bad_pop: { status: 400, code: 'chain_device_pop' },
  device_add_bad_pop: { status: 400, code: 'chain_device_pop' },
  device_add_pop_for_another_user: { status: 400, code: 'chain_device_pop' },
  device_add_without_pop: { status: 400 },
  device_add_twice: { status: 400, code: 'chain_key_reused' },
  reused_key_within_a_chain: { status: 400, code: 'chain_key_reused' },
  reused_key_across_users: { status: 409, code: 'key_reused' },
}

function positive(name: string): Case {
  const c = fixture.positives.find(p => p.name === name)
  if (!c) throw new Error(`device-binding.json has no positive ${name}`)
  return c
}

const LINK_TYPE: Record<string, SigchainLinkType> = {
  user_init: 'genesis',
  device_add: 'device_add',
}

function body(link: SigchainLink): AppendSigchainLinkBody {
  const payload = JSON.parse(link.payloadJson) as Record<string, unknown>
  return {
    seqNo: link.seq,
    linkType: LINK_TYPE[payload.type as string],
    payload,
    signature: link.signature,
    prevHash: link.prevHash,
    hash: link.entryHash,
    signerDeviceId: link.signerDeviceId,
    signerPubkey: link.signerPubkey,
    timestamp: link.timestamp,
  }
}

const everyUser = new Set<string>()
const everyKey = new Set<string>()
for (const c of [...fixture.positives, ...fixture.negatives]) {
  for (const chain of c.chains) {
    everyUser.add(chain[0].signerPubkey)
    for (const link of chain) {
      everyKey.add(link.signerPubkey)
      const p = JSON.parse(link.payloadJson) as Record<string, unknown>
      for (const k of ['devicePubkey', 'deviceEncryptionPubkey', 'encryptionPubkey']) {
        if (typeof p[k] === 'string') everyKey.add(p[k] as string)
      }
    }
  }
}
// The registration half's keys.
const REG_USER_A = 'a1'.repeat(32)
const REG_USER_B = 'b2'.repeat(32)
const REG_X25519 = 'c3'.repeat(32)
everyUser.add(REG_USER_A).add(REG_USER_B)
everyKey.add(REG_USER_A).add(REG_USER_B).add(REG_X25519)

async function reset(): Promise<void> {
  await db.delete(sigchainLinks).where(inArray(sigchainLinks.userPubkey, [...everyUser]))
  await db.delete(devices).where(inArray(devices.pubkey, [...everyUser]))
  await db.delete(deviceKeyClaims).where(inArray(deviceKeyClaims.key, [...everyKey]))
  await db.delete(users).where(inArray(users.pubkey, [...everyUser]))
  await db.insert(users).values([...everyUser].map(pubkey => ({ pubkey })))
}

/** Append every link of every chain; return how the LAST append went. */
async function appendAll(c: Case): Promise<{ status: number; code?: string } | null> {
  await reset()
  let refusal: { status: number; code?: string } | null = null
  for (const [ci, chain] of c.chains.entries()) {
    for (const [li, link] of chain.entries()) {
      try {
        await keys.appendSigchainLink(chain[0].signerPubkey, body(link))
      } catch (e) {
        if (!(e instanceof CryptoKeyError)) throw e
        const last = ci === c.chains.length - 1 && li === chain.length - 1
        if (!last) throw new Error(`${c.name}: link ${li} of chain ${ci} refused before the last: ${e.message}`)
        refusal = { status: e.status, ...(e.code && { code: e.code }) }
      }
    }
  }
  return refusal
}

beforeAll(reset)
afterAll(async () => {
  await reset()
  await db.delete(users).where(inArray(users.pubkey, [...everyUser]))
})

describe('device-binding vectors through the server append path', () => {
  it('covers every vector', () => {
    expect(fixture.positives.length).toBe(3)
    expect(Object.keys(SERVER_REFUSAL).sort()).toEqual(fixture.negatives.map(n => n.name).sort())
  })

  for (const c of fixture.positives) {
    it(`accepts ${c.name}`, async () => {
      expect(await appendAll(c)).toBeNull()
      for (const chain of c.chains) {
        const stored = await keys.getSigchain(chain[0].signerPubkey)
        expect(stored.map(l => l.hash)).toEqual(chain.map(l => l.entryHash))
      }
    })
  }

  for (const c of fixture.negatives) {
    it(`refuses ${c.name}`, async () => {
      const refusal = await appendAll(c)
      expect(refusal).toEqual(SERVER_REFUSAL[c.name])
      // Nothing of the refused link was written: the chain ends one short.
      const last = c.chains[c.chains.length - 1]
      const stored = await keys.getSigchain(last[0].signerPubkey)
      expect(stored.length).toBe(last.length - 1)
    })
  }

  it('claims every key a chain names for its user', async () => {
    const c = positive('device_add_with_pop')
    await appendAll(c)
    const chain = c.chains[0]
    const user = chain[0].signerPubkey
    const added = JSON.parse(chain[chain.length - 1].payloadJson) as Record<string, string>
    const claims = await db
      .select()
      .from(deviceKeyClaims)
      .where(inArray(deviceKeyClaims.key, [added.devicePubkey, added.deviceEncryptionPubkey, added.encryptionPubkey]))
    expect(claims.map(r => [r.kind, r.userPubkey]).sort()).toEqual(
      [['encryption', user], ['encryption', user], ['signing', user]].sort(),
    )
  })
})

describe('device registration is bound to one user (#2496)', () => {
  it('refuses another user\'s X25519 key and writes no row', async () => {
    await reset()
    await identity.registerDevice(REG_USER_A, { platform: 'desktop', ed25519Pubkey: REG_USER_A, x25519Pubkey: REG_X25519 })
    // The owner re-registering its own key is fine.
    await identity.registerDevice(REG_USER_A, { platform: 'desktop', ed25519Pubkey: REG_USER_A, x25519Pubkey: REG_X25519 })

    let refused: unknown = null
    try {
      await identity.registerDevice(REG_USER_B, { platform: 'desktop', ed25519Pubkey: REG_USER_B, x25519Pubkey: REG_X25519 })
    } catch (e) {
      refused = e
    }
    expect(refused).toBeInstanceOf(ServiceError)
    expect((refused as ServiceError).status).toBe(409)
    // The message does not say whose key it was.
    expect((refused as ServiceError).message).not.toContain(REG_USER_A)
    expect(await db.select().from(devices).where(eq(devices.pubkey, REG_USER_B))).toEqual([])
    const [claim] = await db.select().from(deviceKeyClaims).where(eq(deviceKeyClaims.key, REG_X25519))
    expect(claim.userPubkey).toBe(REG_USER_A)
  })

  it('refuses claiming another user\'s identity key before that user has any device', async () => {
    await reset()
    // REG_USER_A exists as a user row (invite / admin creation) and has
    // registered nothing yet. B naming A's identity key as its own is refused.
    let refused: unknown = null
    try {
      await identity.registerDevice(REG_USER_B, { platform: 'desktop', ed25519Pubkey: REG_USER_A })
    } catch (e) {
      refused = e
    }
    expect((refused as ServiceError | null)?.status).toBe(409)
    // A's own genesis is then not locked out.
    await identity.registerDevice(REG_USER_A, { platform: 'desktop', ed25519Pubkey: REG_USER_A, x25519Pubkey: REG_X25519 })
  })

  it('binds a registration to the user\'s sigchain once it has one', async () => {
    const c = positive('user_init_with_xwing_key_and_pop')
    await appendAll(c)
    const user = c.chains[0][0].signerPubkey
    const genesis = JSON.parse(c.chains[0][0].payloadJson) as { devicePubkey: string; deviceEncryptionPubkey: string }
    // The chain's own device and key: accepted.
    await identity.registerDevice(user, { platform: 'desktop', ed25519Pubkey: genesis.devicePubkey, x25519Pubkey: genesis.deviceEncryptionPubkey })
    // A device the chain does not authorise, or another X25519 key for its device: refused.
    for (const reg of [
      { ed25519Pubkey: 'd4'.repeat(32), x25519Pubkey: 'e5'.repeat(32) },
      { ed25519Pubkey: genesis.devicePubkey, x25519Pubkey: 'e5'.repeat(32) },
      { x25519Pubkey: 'e5'.repeat(32) },
    ]) {
      let refused: unknown = null
      try {
        await identity.registerDevice(user, { platform: 'desktop', ...reg })
      } catch (e) {
        refused = e
      }
      expect((refused as ServiceError | null)?.status).toBe(409)
    }
    await db.delete(deviceKeyClaims).where(inArray(deviceKeyClaims.key, ['d4'.repeat(32), 'e5'.repeat(32)]))
  })

  it('refuses registering a key another user\'s sigchain names', async () => {
    const c = positive('user_init_with_xwing_key_and_pop')
    await appendAll(c)
    const genesis = JSON.parse(c.chains[0][0].payloadJson) as { deviceEncryptionPubkey: string }
    let refused: unknown = null
    try {
      await identity.registerDevice(REG_USER_B, { platform: 'android', x25519Pubkey: genesis.deviceEncryptionPubkey })
    } catch (e) {
      refused = e
    }
    expect((refused as ServiceError | null)?.status).toBe(409)
  })
})

/** A random device: Ed25519 seed, X25519 and X-Wing public keys. */
function randomDevice(): { seed: Uint8Array; pubkey: string; x25519: string; kem: string } {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  return {
    seed,
    pubkey: bytesToHex(ed25519.getPublicKey(seed)),
    x25519: bytesToHex(x25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)))),
    kem: bytesToHex(ml_kem768_x25519.keygen(crypto.getRandomValues(new Uint8Array(32))).publicKey),
  }
}

describe('the desktop test mock builds the genesis the real crate accepts', () => {
  // Playwright's IPC mock appends real genesis links to a real server. If its
  // X-Wing key or pop were not what the crate verifies, every desktop E2E user
  // would fail onboarding (and the console guard would fail the run).
  it('a mock-built user_init verifies through ffi_sigchain_verify and names its X-Wing key', () => {
    const d = randomDevice()
    const genesis = createSigchainLinkMock(d.seed, 'g', 'mock-dev', 1, null, '2026-11-26T00:00:00Z',
      userInitPayloadMock(d.seed, 'mock-dev', d.x25519, d.kem))
    const state = sigchainVerify([genesis])
    expect(state.activeDeviceKeys).toEqual([{ devicePubkey: d.pubkey, encryptionPubkey: d.kem, format: 2 }])
  })
})

describe('ffi_sigchain_verify sizes its output from the chain', () => {
  // The verified state repeats every active device's 2432-hex X-Wing key (in
  // activeDeviceKeys and again in namedKeys), so it outgrows the input. A fixed
  // input + 4 KiB buffer refused a legitimate multi-device chain.
  it('verifies a chain of six X-Wing devices', () => {
    const primary = randomDevice()
    const user = primary.pubkey
    const links = [createSigchainLinkMock(primary.seed, 'g', 'p', 1, null, '2026-11-26T00:00:00Z',
      userInitPayloadMock(primary.seed, 'p', primary.x25519, primary.kem))]
    const added = Array.from({ length: 5 }, () => randomDevice())
    for (const [i, d] of added.entries()) {
      const payload = {
        type: 'device_add', deviceId: `d${i}`, devicePubkey: d.pubkey, deviceEncryptionPubkey: d.x25519,
        encryptionPubkey: d.kem, format: DEVICE_KEM_FORMAT, pop: signDevicePopMock(d.seed, user, d.kem, DEVICE_KEM_FORMAT),
      }
      const prev = links[links.length - 1]
      links.push(createSigchainLinkMock(primary.seed, `l${i}`, 'p', prev.seq + 1, prev.entryHash, `2026-11-26T00:0${i + 1}:00Z`, JSON.stringify(payload)))
    }
    const state = sigchainVerify(links)
    expect(state.activeDeviceKeys.map(k => k.encryptionPubkey)).toEqual([primary.kem, ...added.map(d => d.kem)])
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeGreaterThan(
      new TextEncoder().encode(JSON.stringify(links)).length + 4096,
    )
  })
})

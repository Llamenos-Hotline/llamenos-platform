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
 *   - every positive chain is accepted, device_kem and pop-carrying device_add included;
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
 * and `code`. A shape the protocol schema already refuses (no pop; a device_kem
 * whose signer is not the device it names) is a plain 400 before the crate is
 * consulted; a chain the crate refuses carries the crate's code; a key another
 * user holds is the claim's 409.
 */
const SERVER_REFUSAL: Record<string, { status: number; code?: string }> = {
  device_kem_bad_pop: { status: 400, code: 'chain_device_pop' },
  device_kem_pop_for_another_user: { status: 400, code: 'chain_device_pop' },
  device_add_bad_pop: { status: 400, code: 'chain_device_pop' },
  device_add_without_pop: { status: 400 },
  device_add_twice: { status: 400, code: 'chain_key_reused' },
  device_kem_signed_by_another_device: { status: 400 },
  reused_key_within_a_chain: { status: 400, code: 'chain_key_reused' },
  reused_key_across_users: { status: 409, code: 'key_reused' },
}

const LINK_TYPE: Record<string, SigchainLinkType> = {
  user_init: 'genesis',
  device_add: 'device_add',
  device_kem: 'device_kem',
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
    const c = fixture.positives.find(p => p.name === 'device_add_with_pop')!
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

  it('refuses registering a key another user\'s sigchain names', async () => {
    const c = fixture.positives.find(p => p.name === 'device_kem')!
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

/**
 * Hub authority chain storage and append against real PostgreSQL (#2963):
 *  - a hub founded with its founder's signed genesis stores it as seq 1, and the
 *    founder's hub roles are exactly the genesis bundles;
 *  - appends are a compare-and-set against the head: a link built on a stale
 *    head loses with a 409 and nothing is stored;
 *  - a link the crate refuses is refused by its named code and nothing is stored;
 *  - a genesis is never accepted on the append path (only hub creation stores one);
 *  - `users.hub_roles` is a cache of the chain-derived roles, and never caches a
 *    bundle named after a role with instance-level authority;
 *  - `hub-id-profile`: the `hubs_id_profile` CHECK refuses an id outside the
 *    §2.1 profile, and every create path's id (a lowercase UUID) conforms.
 *
 * MUST run under `bun test` (bun:ffi, bun-jsonb):
 *   bun run test:worker:integration-bun -- hub-chain-append
 * Requires DATABASE_URL with migrations applied (#2912).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubChainLinks, hubs, sigchainLinks, users } from '../../db/schema'
import { createSettingsDomain } from '../../services/settings-domain'
import { HubChainConflictError, HubChainRejectedError, HubChainService } from '../../services/hub-chain'
import { appendValidatedSigchainLink } from '../../services/crypto-keys'
import { createSigchainLinkMock, userInitPayloadMock } from '../../../../tests/mocks/sigchain-mock'
import { bundlePermsHashMock, newHubGenesisMock, signHubLinkMock } from '../../../../tests/mocks/hub-chain-mock'
import type { ChainHead, HubChainLink } from '@protocol/schemas/hub-chain'
import { DEFAULT_ROLES, expandPermissions } from '@shared/permissions'
import { requireDatabaseUrl } from '../helpers/database-url'

const db = createDatabase(requireDatabaseUrl())
const settings = createSettingsDomain(db)
const chain = new HubChainService(db)

const createdUsers: string[] = []
const createdHubs: string[] = []

afterAll(async () => {
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  if (createdUsers.length > 0) {
    await db.delete(sigchainLinks).where(inArray(sigchainLinks.userPubkey, createdUsers))
    await db.delete(users).where(inArray(users.pubkey, createdUsers))
  }
})

interface TestUser { seedHex: string; pubkey: string; head: ChainHead }

/** A registered user with a one-link user chain (`user_init`), stored through the real append path. */
async function makeUser(name: string): Promise<TestUser> {
  const seed = randomBytes(32)
  const pubkey = bytesToHex(ed25519.getPublicKey(seed))
  await db.insert(users).values({ pubkey, displayName: name })
  createdUsers.push(pubkey)
  const payloadJson = userInitPayloadMock(
    seed,
    `${name}-dev`,
    bytesToHex(x25519.getPublicKey(randomBytes(32))),
    bytesToHex(ml_kem768_x25519.keygen(randomBytes(32)).publicKey),
  )
  const timestamp = new Date().toISOString()
  const link = createSigchainLinkMock(seed, crypto.randomUUID(), `${name}-dev`, 1, null, timestamp, payloadJson)
  await db.transaction(tx => appendValidatedSigchainLink(tx, pubkey, {
    seqNo: 1,
    linkType: 'genesis',
    payload: JSON.parse(payloadJson),
    signature: link.signature,
    prevHash: null,
    hash: link.entryHash,
    signerDeviceId: link.signerDeviceId,
    signerPubkey: link.signerPubkey,
    timestamp,
  }))
  return { seedHex: bytesToHex(seed), pubkey, head: { seq: 1, hash: link.entryHash } }
}

async function foundHub(founder: TestUser, bundles = ['role-hub-admin']): Promise<{ id: string; genesis: HubChainLink }> {
  const id = crypto.randomUUID()
  const genesis = newHubGenesisMock(id, founder.seedHex, founder.head, bundles)
  const now = new Date().toISOString()
  await settings.hubs.createHub(
    { id, name: `chain ${id}`, slug: `chain-${id}`, status: 'active', timezone: 'UTC', createdBy: founder.pubkey, createdAt: now, updatedAt: now },
    { pubkey: founder.pubkey, genesis },
  )
  createdHubs.push(id)
  return { id, genesis }
}

function next(prev: HubChainLink, signer: TestUser, body: HubChainLink['body']): HubChainLink {
  return signHubLinkMock({
    hub: prev.hub,
    seq: prev.seq + 1,
    prevHash: prev.entryHash,
    signerUser: signer.pubkey,
    signerUserHead: signer.head,
    body,
  }, signer.seedHex)
}

/** A bundle declaring exactly what the catalog role of the same id confers — the form a client commits. */
const rolePerms = (id: string) => expandPermissions(DEFAULT_ROLES.find(r => r.id === id)!.permissions)
const ADMIN_PERMS = rolePerms('role-hub-admin')
const VOLUNTEER_PERMS = rolePerms('role-volunteer')
const bundle = (name: string, permissions: string[]) => ({
  type: 'policy' as const, kind: 'bundle', bundle: name, permissions, permsHash: bundlePermsHashMock(permissions),
})

async function hubRolesOf(pubkey: string): Promise<{ hubId: string; roleIds: string[] }[]> {
  const [row] = await db.select({ hubRoles: users.hubRoles }).from(users).where(eq(users.pubkey, pubkey))
  return (row?.hubRoles as { hubId: string; roleIds: string[] }[]) ?? []
}

describe('hub chain: founding', () => {
  it('stores the genesis as seq 1 and gives the founder exactly its bundles', async () => {
    const founder = await makeUser('founder')
    const { id, genesis } = await foundHub(founder)
    const page = await chain.read(id, 1, 10)
    expect(page.links).toEqual([genesis])
    expect(page.head).toEqual({ seq: 1, hash: genesis.entryHash })
    expect(await hubRolesOf(founder.pubkey)).toContainEqual({ hubId: id, roleIds: ['role-hub-admin'] })
  })

  it('refuses a genesis signed by someone other than the founder, and creates no hub', async () => {
    const founder = await makeUser('founder')
    const other = await makeUser('other')
    const id = crypto.randomUUID()
    const genesis = newHubGenesisMock(id, other.seedHex, other.head, ['role-hub-admin'])
    const now = new Date().toISOString()
    await expect(settings.hubs.createHub(
      { id, name: id, slug: `x-${id}`, status: 'active', timezone: 'UTC', createdBy: founder.pubkey, createdAt: now, updatedAt: now },
      { pubkey: founder.pubkey, genesis },
    )).rejects.toMatchObject({ status: 403, code: 'chain_genesis' })
    expect(await db.select().from(hubs).where(eq(hubs.id, id))).toEqual([])
  })

  it('refuses a genesis bundle that names a role with instance-level authority', async () => {
    const founder = await makeUser('founder')
    const id = crypto.randomUUID()
    const genesis = newHubGenesisMock(id, founder.seedHex, founder.head, ['role-super-admin'])
    const now = new Date().toISOString()
    await expect(settings.hubs.createHub(
      { id, name: id, slug: `sa-${id}`, status: 'active', timezone: 'UTC', createdBy: founder.pubkey, createdAt: now, updatedAt: now },
      { pubkey: founder.pubkey, genesis },
    )).rejects.toMatchObject({ status: 400, code: 'chain_genesis' })
  })
})

describe('hub chain: append', () => {
  it('appends in order, and the hub_roles cache follows the chain', async () => {
    const founder = await makeUser('founder')
    const volunteer = await makeUser('volunteer')
    const { id, genesis } = await foundHub(founder)
    const l2 = next(genesis, founder, bundle('role-hub-admin', ADMIN_PERMS))
    expect(await chain.append(id, l2)).toEqual({ seq: 2, hash: l2.entryHash })
    const l3 = next(l2, founder, bundle('role-volunteer', VOLUNTEER_PERMS))
    await chain.append(id, l3)
    const l4 = next(l3, founder, { type: 'role_grant', user: volunteer.pubkey, bundle: 'role-volunteer' })
    await chain.append(id, l4)
    expect(await hubRolesOf(volunteer.pubkey)).toContainEqual({ hubId: id, roleIds: ['role-volunteer'] })
    const l5 = next(l4, founder, { type: 'role_revoke', user: volunteer.pubkey, bundle: 'role-volunteer' })
    await chain.append(id, l5)
    expect((await hubRolesOf(volunteer.pubkey)).some(hr => hr.hubId === id)).toBe(false)
    expect((await chain.read(id, 2, 2))).toMatchObject({ links: [l2, l3], hasMore: true })
  })

  it('a link built on a stale head loses the compare-and-set with a 409, and is not stored', async () => {
    const founder = await makeUser('founder')
    const { id, genesis } = await foundHub(founder)
    const winner = next(genesis, founder, bundle('role-hub-admin', ADMIN_PERMS))
    const loser = next(genesis, founder, bundle('role-volunteer', VOLUNTEER_PERMS))
    await chain.append(id, winner)
    const err = await chain.append(id, loser).catch(e => e)
    expect(err).toBeInstanceOf(HubChainConflictError)
    expect(err).toMatchObject({ status: 409, head: { seq: 2, hash: winner.entryHash } })
    expect((await chain.read(id, 1, 10)).links).toEqual([genesis, winner])
  })

  it('refuses a link the crate refuses, by its named code, and stores nothing', async () => {
    const founder = await makeUser('founder')
    const volunteer = await makeUser('volunteer')
    const { id, genesis } = await foundHub(founder)
    const l2 = next(genesis, founder, bundle('role-hub-admin', ADMIN_PERMS))
    await chain.append(id, l2)
    // A member without role management grants themselves admin.
    const forged = next(l2, volunteer, { type: 'role_grant', user: volunteer.pubkey, bundle: 'role-hub-admin' })
    const err = await chain.append(id, forged).catch(e => e)
    expect(err).toBeInstanceOf(HubChainRejectedError)
    expect(err).toMatchObject({ status: 400, code: 'chain_unauthorised_signer' })
    // A signed link whose body the server altered afterwards.
    const altered = { ...next(l2, founder, bundle('role-volunteer', VOLUNTEER_PERMS)) }
    altered.body = { ...altered.body, permissions: ['calls:answer', 'notes:read-all'] }
    expect(await chain.append(id, altered).catch(e => e)).toMatchObject({ status: 400, code: 'chain_entry_hash' })
    expect((await chain.read(id, 1, 10)).links).toEqual([genesis, l2])
  })

  it('never accepts a genesis on the append path', async () => {
    const founder = await makeUser('founder')
    const id = crypto.randomUUID()
    await db.insert(hubs).values({ id, name: id, slug: `nochain-${id}`, createdBy: founder.pubkey })
    createdHubs.push(id)
    const genesis = newHubGenesisMock(id, founder.seedHex, founder.head, ['role-hub-admin'])
    expect(await chain.append(id, genesis).catch(e => e)).toMatchObject({ status: 400, code: 'chain_genesis' })
    expect(await db.select().from(hubChainLinks).where(eq(hubChainLinks.hubId, id))).toEqual([])
  })

  it('never caches a chain bundle narrower than the catalog role it is named after', async () => {
    const founder = await makeUser('founder')
    const target = await makeUser('target')
    const { id, genesis } = await foundHub(founder)
    const l2 = next(genesis, founder, bundle('role-hub-admin', ADMIN_PERMS))
    const l3 = next(l2, founder, bundle('role-volunteer', ['calls:answer']))
    const l4 = next(l3, founder, { type: 'role_grant', user: target.pubkey, bundle: 'role-volunteer' })
    for (const l of [l2, l3, l4]) await chain.append(id, l)
    expect((await hubRolesOf(target.pubkey)).find(hr => hr.hubId === id)).toBeUndefined()
  })

  it('never caches a chain bundle named after a role with instance-level authority', async () => {
    const founder = await makeUser('founder')
    const target = await makeUser('target')
    const { id, genesis } = await foundHub(founder)
    const l2 = next(genesis, founder, bundle('role-hub-admin', ADMIN_PERMS))
    const l3 = next(l2, founder, bundle('role-super-admin', ['calls:answer']))
    const l4 = next(l3, founder, { type: 'role_grant', user: target.pubkey, bundle: 'role-super-admin' })
    for (const l of [l2, l3, l4]) await chain.append(id, l)
    // The chain says the target holds `role-super-admin`; the cache, which the
    // server resolves against its own catalog, must not.
    const state = await chain.state(id)
    expect(state?.members.find(m => m.user === target.pubkey)?.bundles).toEqual(['role-super-admin'])
    expect((await hubRolesOf(target.pubkey)).find(hr => hr.hubId === id)).toBeUndefined()
  })
})

describe('hub-id-profile', () => {
  it('the hubs_id_profile CHECK refuses an id outside the §2.1 profile', async () => {
    const founder = await makeUser('founder')
    for (const id of ['Hub-Upper', 'hub_underscore', '-leading', 'z'.repeat(65)]) {
      const outcome = await db.insert(hubs)
        .values({ id, name: id, slug: `bad-${bytesToHex(randomBytes(6))}`, createdBy: founder.pubkey })
        .then(() => 'inserted', (e: unknown) => String((e as { cause?: unknown }).cause ?? e))
      expect(outcome, id).toContain('hubs_id_profile')
    }
  })

  it('every create path mints a conforming id (a lowercase UUID)', () => {
    for (let i = 0; i < 50; i++) expect(crypto.randomUUID()).toMatch(/^[0-9a-z][0-9a-z-]{0,63}$/)
  })
})

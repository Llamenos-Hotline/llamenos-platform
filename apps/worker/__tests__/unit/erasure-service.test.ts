/**
 * Unit tests for ErasureService.createSelfRequest — H01 co-approver admin check.
 *
 * The co-approver is an admin of the hub being erased by the ONE predicate in
 * lib/hub-admin.ts (#2232): roles held in that hub that, resolved against the
 * live role definitions, confer settings:manage + notes:read-all. These tests
 * stub the two reads the predicate makes (role catalog, candidate users) and
 * never name an admin role id in the service under test.
 */
import { describe, it, expect, vi } from 'vitest'
import { ErasureService } from '@worker/services/erasure'
import { ServiceError } from '@worker/services/settings'
import { users } from '@worker/db/schema'

// Minimal Ed25519 helpers (real crypto, but no DB)
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@shared/encoding'
import { LABEL_ERASURE_OVERRIDE_SIG } from '@shared/crypto-labels'

type Candidate = { pubkey: string; hubRoles: Array<{ hubId: string; roleIds: string[] }> }
type RoleDef = { id: string; permissions: string[] }

/** A co-approver holding `roleIds` in `hubId`. */
const member = (pubkey: string, hubId: string, roleIds: string[]): Candidate => ({ pubkey, hubRoles: [{ hubId, roleIds }] })

/**
 * A database answering only what the predicate asks: `select().from(roles)` is
 * the live catalog, `select().from(users).where()` the candidate rows.
 */
function stubDb(candidates: Candidate[], catalog: RoleDef[] = []) {
  const rows = candidates.map(c => ({ active: true, status: 'active', ...c }))
  const from = (table: unknown) =>
    Object.assign(Promise.resolve(catalog), { where: async () => (table === users ? rows : []) })
  return { select: () => ({ from }) }
}

function buildService(candidates: Candidate[], catalog: RoleDef[] = []) {
  const service = new ErasureService(stubDb(candidates, catalog) as never)

  // Stub the DB lookups used by createSelfRequest
  vi.spyOn(service, 'getMyRequest').mockResolvedValue(null)
  vi.spyOn(service, 'getConfig').mockResolvedValue({
    hubId: 'hub-1',
    delayHours: 72,
    hubShredDelayHours: 48,
    emergencyOverrideEnabled: true,
    updatedAt: new Date(),
    updatedBy: 'admin',
  })

  return { service }
}

describe('ErasureService.createSelfRequest — co-approver admin check (H01)', () => {
  const privKey = ed25519.utils.randomSecretKey()
  const pubKey = bytesToHex(ed25519.getPublicKey(privKey))
  const coPrivKey = ed25519.utils.randomSecretKey()
  const coPubKey = bytesToHex(ed25519.getPublicKey(coPrivKey))

  function makeSignedEmergency(userId: string, ts: string) {
    const msg = new TextEncoder().encode(`${LABEL_ERASURE_OVERRIDE_SIG}:${userId}:${ts}`)
    const sig = bytesToHex(ed25519.sign(msg, coPrivKey))
    return { coApproverPubkey: coPubKey, coApproverSignature: sig, timestamp: ts }
  }

  const fakeRow = {
    id: 'req-1',
    userId: pubKey,
    status: 'pending' as const,
    requestedBy: pubKey,
    requestedAt: new Date(),
    executeAt: new Date(),
    executedAt: null,
    justification: 'test',
    emergencyOverride: true,
    coApproverPubkey: coPubKey,
    coApproverSignature: 'sig',
    cancelledAt: null,
  }

  /** Lets the request through once the co-approver is accepted: the insert, plus the requester lookup under the hub-admin guard (#2126; no row, no hubs to protect). */
  function allowInsert(service: ErasureService) {
    const db = (service as unknown as { db: Record<string, unknown> }).db
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([]) }) }) }) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([fakeRow]) }) }),
    }
    db.transaction = <T>(cb: (tx: unknown) => Promise<T>) => cb(tx)
  }

  const emergencyFor = () => makeSignedEmergency(pubKey, new Date().toISOString())

  it('rejects emergency erasure when co-approver holds no admin authority in the hub', async () => {
    const { service } = buildService([member(coPubKey, 'hub-1', ['role-volunteer'])])
    await expect(service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).rejects.toMatchObject({ status: 403 })
  })

  it('rejects emergency erasure when co-approver is unknown (not registered)', async () => {
    const { service } = buildService([])
    await expect(service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).rejects.toMatchObject({ status: 403 })
  })

  it('accepts a co-approver who holds a default admin role in the hub', async () => {
    const { service } = buildService([member(coPubKey, 'hub-1', ['role-hub-admin'])])
    allowInsert(service)
    expect((await service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).id).toBe('req-1')
  })

  it('accepts a co-approver whose admin role is custom or renamed — the permissions decide, not the id', async () => {
    const catalog = [{ id: 'role-night-coordinators', permissions: ['settings:manage', 'notes:read-all'] }]
    const { service } = buildService([member(coPubKey, 'hub-1', ['role-night-coordinators'])], catalog)
    allowInsert(service)
    expect((await service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).id).toBe('req-1')
  })

  it('accepts a co-approver whose admin authority is split across two custom roles in the hub', async () => {
    const catalog = [
      { id: 'role-settings-keeper', permissions: ['settings:manage'] },
      { id: 'role-notes-auditor', permissions: ['notes:read-all'] },
    ]
    const { service } = buildService([member(coPubKey, 'hub-1', ['role-settings-keeper', 'role-notes-auditor'])], catalog)
    allowInsert(service)
    expect((await service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).id).toBe('req-1')
  })

  it('rejects a custom role that grants only half of the admin minimum', async () => {
    const catalog = [{ id: 'role-settings-keeper', permissions: ['settings:manage'] }]
    const { service } = buildService([member(coPubKey, 'hub-1', ['role-settings-keeper'])], catalog)
    await expect(service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).rejects.toMatchObject({ status: 403 })
  })

  it('rejects an admin of ANOTHER hub — authority in one hub is none in the hub being erased', async () => {
    const { service } = buildService([member(coPubKey, 'hub-2', ['role-hub-admin'])])
    await expect(service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a holder of a global admin role id who has no role in the hub', async () => {
    // The pre-#2232 predicate read users.roles; the hub-scoped one never does.
    const { service } = buildService([{ pubkey: coPubKey, hubRoles: [], roles: ['role-super-admin', 'role-hub-admin'] } as Candidate])
    await expect(service.createSelfRequest(pubKey, 'hub-1', 'test', emergencyFor())).rejects.toBeInstanceOf(ServiceError)
  })
})

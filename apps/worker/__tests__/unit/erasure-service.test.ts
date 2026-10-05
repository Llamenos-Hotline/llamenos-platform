/**
 * Unit tests for ErasureService.createSelfRequest — H01 co-approver admin check.
 */
import { describe, it, expect, vi } from 'vitest'
import { ErasureService } from '@worker/services/erasure'
import { ServiceError } from '@worker/services/settings'

// Minimal Ed25519 helpers (real crypto, but no DB)
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@shared/encoding'
import { LABEL_ERASURE_OVERRIDE_SIG } from '@shared/crypto-labels'

function makeAdminUser(pubkey: string) {
  return { pubkey, roles: ['role-super-admin'], active: true }
}
function makeVolunteerUser(pubkey: string) {
  return { pubkey, roles: ['role-volunteer'], active: true }
}

function buildService(coApproverUser: ReturnType<typeof makeAdminUser> | ReturnType<typeof makeVolunteerUser> | null) {
  const mockDb = {} as never
  const mockIdentity = {
    getUserInternal: vi.fn().mockResolvedValue(coApproverUser),
  }

  const service = new ErasureService(mockDb, mockIdentity)

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

  return { service, mockIdentity }
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

  it('rejects emergency erasure when co-approver is not an admin', async () => {
    const { service } = buildService(makeVolunteerUser(coPubKey))
    const ts = new Date().toISOString()
    const emergency = makeSignedEmergency(pubKey, ts)

    await expect(
      service.createSelfRequest(pubKey, 'hub-1', 'test', emergency),
    ).rejects.toThrow(ServiceError)
  })

  it('rejects emergency erasure when co-approver is unknown (not registered)', async () => {
    const { service } = buildService(null)
    const ts = new Date().toISOString()
    const emergency = makeSignedEmergency(pubKey, ts)

    await expect(
      service.createSelfRequest(pubKey, 'hub-1', 'test', emergency),
    ).rejects.toThrow(ServiceError)
  })

  it('accepts emergency erasure when co-approver has admin role', async () => {
    const { service } = buildService(makeAdminUser(coPubKey))
    // Stub the DB insert
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
    ;(service as any).db = {
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([fakeRow]) }),
      }),
    }
    const ts = new Date().toISOString()
    const emergency = makeSignedEmergency(pubKey, ts)

    const result = await service.createSelfRequest(pubKey, 'hub-1', 'test', emergency)
    expect(result.id).toBe('req-1')
  })
})

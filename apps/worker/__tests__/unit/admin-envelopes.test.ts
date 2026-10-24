/**
 * assertAdminCanRead — the write-boundary guard for client-sealed envelope sets
 * (#2113). The server cannot re-wrap a content key it never held, so a set that
 * names no admin is unrecoverable the moment it is stored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('../../lib/logger', () => ({ createLogger: () => logger }))

import { assertAdminCanRead } from '../../lib/admin-envelopes'
import { ServiceError } from '../../services/settings'

const ADMIN = 'a'.repeat(64)
const DEVICE = 'd'.repeat(64)
const OTHER = 'c'.repeat(64)

function services(recipients: string[]) {
  return { identity: { listAdminEnvelopeRecipients: vi.fn().mockResolvedValue(recipients) } }
}

async function refusal(promise: Promise<void>): Promise<ServiceError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ServiceError)
  return err as ServiceError
}

describe('assertAdminCanRead', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes a set that includes an admin recipient', async () => {
    await expect(
      assertAdminCanRead(services([ADMIN]), {}, [{ pubkey: OTHER }, { pubkey: ADMIN }], 'A note'),
    ).resolves.toBeUndefined()
  })

  it('passes when ANY one of several admin keys is addressed (a device registered later must not 422 a correct write)', async () => {
    await expect(
      assertAdminCanRead(services([ADMIN, DEVICE]), {}, [{ pubkey: ADMIN }], 'A note'),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['undefined', undefined],
    ['empty', []],
  ])('refuses (422) %s envelopes when an admin exists', async (_label, envelopes) => {
    const err = await refusal(assertAdminCanRead(services([ADMIN]), {}, envelopes, 'A note'))
    expect(err.status).toBe(422)
    expect(err.message).toMatch(/at least one admin envelope/)
  })

  it('refuses (422) a non-empty set that no admin holds a key for', async () => {
    const err = await refusal(assertAdminCanRead(services([ADMIN]), {}, [{ pubkey: OTHER }], 'A message'))
    expect(err.status).toBe(422)
    expect(err.message).toMatch(/^A message must include/)
  })

  it('hands the configured ADMIN_DECRYPTION_PUBKEY to the resolver', async () => {
    const svc = services([ADMIN])
    await assertAdminCanRead(svc, { ADMIN_DECRYPTION_PUBKEY: ADMIN }, [{ pubkey: ADMIN }], 'A note')
    expect(svc.identity.listAdminEnvelopeRecipients).toHaveBeenCalledWith(ADMIN)
  })

  describe('a deployment with NO resolvable admin recipient', () => {
    it('does not refuse — it stores, and says so loudly (loud-but-stored, like the call and inbound-message paths)', async () => {
      await expect(
        assertAdminCanRead(services([]), {}, [], 'A note', { hubId: 'hub-1' }),
      ).resolves.toBeUndefined()

      expect(logger.error).toHaveBeenCalledTimes(1)
      const [message, context] = logger.error.mock.calls[0]
      expect(message).toMatch(/stored WITHOUT any admin-readable envelope/)
      expect(message).toMatch(/ADMIN_DECRYPTION_PUBKEY/)
      expect(context).toMatchObject({ hubId: 'hub-1', envelopeCount: 0 })
    })

    it('does not log when there was an admin to check against', async () => {
      await assertAdminCanRead(services([ADMIN]), {}, [{ pubkey: ADMIN }], 'A note')
      expect(logger.error).not.toHaveBeenCalled()
    })
  })
})

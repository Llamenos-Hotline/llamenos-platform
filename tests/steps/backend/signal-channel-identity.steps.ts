/**
 * Step definitions for core/signal-channel.feature's identity trust
 * management scenarios.
 *
 * SignalIdentityService (apps/worker/messaging/signal/identity.ts) already
 * had full TOFU/auto/manual trust-level logic and a unit-test suite, but
 * `recordIdentity` had no caller anywhere in the app — this feature's
 * "a message arrives" steps exercise it via a thin dev-only pass-through
 * (dev.ts's /test-simulate/signal-identity), the same real method the
 * production webhook handler now also calls (messaging/router.ts). The
 * "admin sets/verifies trust" steps call the real, already-shipped admin
 * routes in routes/signal.ts.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { apiGet, apiPost, devPost, seedHexToPubkey, ADMIN_SEED } from '../../api-helpers'

const STATE_KEY = 'signal-channel-identity'

interface IdentityRecordShape {
  id: string
  uuid: string
  number: string
  fingerprint: string
  trustLevel: string
  verifiedBy: string | null
  verifiedAt: string | null
  keyChangeCount: number
}

interface IdentityState {
  uuid: string
  number: string
  identity?: IdentityRecordShape
  priorKeyChangeCount?: number
}

function getIdentityState(world: Record<string, unknown>): IdentityState {
  const existing = getState<IdentityState | undefined>(world, STATE_KEY)
  if (existing) return existing
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const fresh: IdentityState = { uuid: `test-uuid-${unique}`, number: '+15550009999' }
  setState(world, STATE_KEY, fresh)
  return fresh
}

async function recordIdentity(
  request: APIRequestContext,
  workerHub: string,
  state: IdentityState,
  opts: { fingerprint?: string; trustMode?: 'auto' | 'tofu' | 'manual' } = {},
): Promise<{ isNew: boolean; keyChanged: boolean; identity: IdentityRecordShape }> {
  const { status, data } = await devPost<{ isNew: boolean; keyChanged: boolean; identity: IdentityRecordShape }>(
    request,
    '/test-simulate/signal-identity',
    { hubId: workerHub, number: state.number, uuid: state.uuid, ...opts },
  )
  expect(status).toBe(200)
  return data
}

// ── Given ────────────────────────────────────────────────────────────

Given('a message arrives from a new Signal UUID', ({ world }) => {
  // Allocate the identifiers; recording happens in the "When" step below.
  getIdentityState(world)
})

Given('a known contact with trust level {string}', async ({ request, world, workerHub }, trustLevel: string) => {
  const state = getIdentityState(world)
  const result = await recordIdentity(request, workerHub, state, { fingerprint: 'fp-v1' })
  state.identity = result.identity
  state.priorKeyChangeCount = result.identity.keyChangeCount

  const { status } = await apiPost(request, '/messaging/signal/identities/trust', {
    uuid: state.uuid,
    trustLevel,
    hubId: workerHub,
  })
  expect(status).toBe(200)
})

Given('an untrusted Signal identity', async ({ request, world, workerHub }) => {
  const state = getIdentityState(world)
  // trustMode 'manual' is the only path that starts a new identity as
  // UNTRUSTED rather than TRUSTED_UNVERIFIED (see recordIdentity).
  const result = await recordIdentity(request, workerHub, state, { trustMode: 'manual' })
  state.identity = result.identity
  expect(state.identity.trustLevel).toBe('UNTRUSTED')
})

Given('an admin verifies a Signal identity', async ({ request, world, workerHub }) => {
  const state = getIdentityState(world)
  const result = await recordIdentity(request, workerHub, state)
  state.identity = result.identity

  const { status } = await apiPost(request, '/messaging/signal/identities/trust', {
    uuid: state.uuid,
    trustLevel: 'TRUSTED_VERIFIED',
    hubId: workerHub,
  }, ADMIN_SEED)
  expect(status).toBe(200)

  const { data } = await apiGet<{ identities: IdentityRecordShape[] }>(
    request,
    `/messaging/signal/identities?hub=${workerHub}`,
  )
  state.identity = data.identities.find(i => i.uuid === state.uuid)
})

// ── When ─────────────────────────────────────────────────────────────

When('the identity is recorded', async ({ request, world, workerHub }) => {
  const state = getIdentityState(world)
  const result = await recordIdentity(request, workerHub, state)
  state.identity = result.identity
})

When('their identity key fingerprint changes', async ({ request, world, workerHub }) => {
  const state = getIdentityState(world)
  const result = await recordIdentity(request, workerHub, state, { fingerprint: 'fp-v2' })
  expect(result.keyChanged).toBe(true)
  state.identity = result.identity
})

When('the admin sets trust level to {string}', async ({ request, world, workerHub }, trustLevel: string) => {
  const state = getIdentityState(world)
  const { status } = await apiPost(request, '/messaging/signal/identities/trust', {
    uuid: state.uuid,
    trustLevel,
    hubId: workerHub,
  })
  expect(status).toBe(200)

  const { data } = await apiGet<{ identities: IdentityRecordShape[] }>(
    request,
    `/messaging/signal/identities?hub=${workerHub}`,
  )
  state.identity = data.identities.find(i => i.uuid === state.uuid)
})

// ── Then ─────────────────────────────────────────────────────────────

Then('the trust level should be {string}', ({ world }, expectedLevel: string) => {
  const state = getIdentityState(world)
  expect(state.identity?.trustLevel).toBe(expectedLevel)
})

Then('their trust level should be {string}', ({ world }, expectedLevel: string) => {
  const state = getIdentityState(world)
  expect(state.identity?.trustLevel).toBe(expectedLevel)
})

Then('the key change counter should increment', ({ world }) => {
  const state = getIdentityState(world)
  expect(state.identity?.keyChangeCount ?? 0).toBeGreaterThan(state.priorKeyChangeCount ?? 0)
})

Then('the identity trust should be updated', ({ world }) => {
  const state = getIdentityState(world)
  expect(state.identity?.trustLevel).toBe('TRUSTED_UNVERIFIED')
})

Then('the identity record should include the admin\'s pubkey', ({ world }) => {
  const state = getIdentityState(world)
  expect(state.identity?.verifiedBy).toBe(seedHexToPubkey(ADMIN_SEED))
})

Then('a verification timestamp', ({ world }) => {
  const state = getIdentityState(world)
  expect(state.identity?.verifiedAt).toBeTruthy()
})

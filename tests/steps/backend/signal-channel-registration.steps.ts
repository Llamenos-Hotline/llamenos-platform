/**
 * Step definitions for core/signal-channel.feature's registration &
 * provisioning scenarios.
 *
 * Bind to the DB-backed state machine in
 * apps/worker/services/provider-setup/signal-registration.ts (routes:
 * /provider-setup/signal/*) rather than the legacy bridge-synchronous flow in
 * apps/worker/routes/setup.ts — see the comment above this section in
 * signal-channel.feature for why (no reachable signal-cli bridge exists in
 * CI/local, same constraint recorded on core/signal-integration.feature's
 * @fixme'd "Unrecognised envelope type" scenario, #1196).
 *
 * The registration start/verify steps below write into the same shared
 * world-state key ('signal-integration') that signal-integration.steps.ts
 * uses, so its already-bound `the registration state should be {string}`
 * step picks up the result here too.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import type { APIRequestContext } from '@playwright/test'
import { apiGet, apiPost, createUserViaApi, uniqueName, ADMIN_SEED } from '../../api-helpers'

/** Shared with signal-integration.steps.ts — see file header. */
const SHARED_STATE_KEY = 'signal-integration'

interface SharedRegistrationFields {
  registrationState?: string
}

// Mock bridge URL — a real external domain that passes SSRF validation but is
// never actually dialed for the parts of the flow these scenarios exercise
// (same convention as provider-setup-signal.steps.ts).
const MOCK_BRIDGE_URL = 'https://signal-bridge.example.com'
const MOCK_PHONE = '+15005550001'

/** Local state for this file, distinct from the shared registrationState field. */
const LOCAL_STATE_KEY = 'signal-channel-registration'

interface RegistrationLocalState {
  bridgeUrl: string
  registrationId?: string
  /** Seed of this scenario's own hub admin — see actingAdminSeed. */
  adminSeed?: string
  accountInfo?: { registered?: boolean; uuid?: string; error?: string }
  captchaError?: string
}

function getLocalState(world: Record<string, unknown>): RegistrationLocalState {
  const existing = getState<RegistrationLocalState | undefined>(world, LOCAL_STATE_KEY)
  if (existing) return existing
  const fresh: RegistrationLocalState = { bridgeUrl: MOCK_BRIDGE_URL }
  setState(world, LOCAL_STATE_KEY, fresh)
  return fresh
}

/**
 * The identity that drives this scenario's /provider-setup/signal/* calls,
 * addressed through its own hub (`/hubs/:hubId/provider-setup/...`): a hub
 * admin's grant lives in `hubRoles` only, which authorizes inside their hub and
 * nowhere else (#2153).
 *
 * `POST /provider-setup/signal/verify` is rate limited per caller pubkey
 * (`signal-verify:<pubkey>`, 5/min). The suite-wide ADMIN_SEED is shared by every
 * parallel worker and already spends 4 of those 5 in provider-setup-signal.feature
 * (one valid code + three wrong ones), so two more verifies from these scenarios
 * pushed it to 429 depending on shard timing. Each scenario therefore acts as its
 * own freshly created hub admin, which gets its own bucket — the same isolation
 * auth-rate-limit.steps.ts uses (a pubkey per scenario) rather than clearing
 * counters other workers are filling.
 */
async function actingAdminSeed(
  request: APIRequestContext,
  world: Record<string, unknown>,
  hubId: string,
): Promise<string> {
  const local = getLocalState(world)
  if (local.adminSeed) return local.adminSeed
  const admin = await createUserViaApi(request, {
    name: uniqueName('sig-admin'),
    roleIds: ['role-hub-admin'],
    hubId,
  })
  local.adminSeed = admin.seedHex
  return admin.seedHex
}

function setSharedRegistrationState(world: Record<string, unknown>, status: string | undefined): void {
  const shared = getState<SharedRegistrationFields | undefined>(world, SHARED_STATE_KEY) ?? {}
  shared.registrationState = status
  setState(world, SHARED_STATE_KEY, shared)
}

// ── Given ────────────────────────────────────────────────────────────

Given('a Signal bridge is reachable at the configured URL', ({ world }) => {
  // No real bridge exists in this environment — recorded as a mock URL that
  // the startRegistration call writes a DB record for regardless of whether
  // the bridge answers (the fire-and-forget bridge call happens after the
  // record is persisted; see SignalRegistrationService.startRegistration).
  getLocalState(world).bridgeUrl = MOCK_BRIDGE_URL
})

Given('registration is pending for {string}', async ({ request, world, workerHub }, phoneNumber: string) => {
  const local = getLocalState(world)
  const { status, data } = await apiPost<{ id: string; status: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/register`,
    { bridgeUrl: local.bridgeUrl, phoneNumber, method: 'sms', hubId: workerHub },
    await actingAdminSeed(request, world, workerHub),
  )
  expect(status).toBe(200)
  local.registrationId = data.id
  setSharedRegistrationState(world, data.status)
})

Given('the Signal bridge requires a captcha', ({ world }) => {
  // Marks intent for the following "When" step, which uses a dedicated
  // dev-mode test phone number that deterministically simulates the bridge
  // rejecting registration with a captcha requirement (see
  // TEST_CAPTCHA_REQUIRED_NUMBER in signal-registration.ts) — there is no
  // reachable real bridge here to actually return a captcha challenge from.
  getLocalState(world)
})

Given('Signal is configured with a registered number', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await apiPost<{ id: string; status: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/register`,
    { bridgeUrl: local.bridgeUrl, phoneNumber: MOCK_PHONE, method: 'sms', hubId: workerHub },
    await actingAdminSeed(request, world, workerHub),
  )
  expect(status).toBe(200)
  local.registrationId = data.id

  // Deterministic dev-mode verification — see TEST_VALID_CODE in
  // signal-registration.ts. Brings the registration to 'complete' so
  // getAccountInfo's dev-mode bypass (added alongside TEST_VALID_CODE) has a
  // "configured with a registered number" state to report on.
  const verify = await apiPost<{ status: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/verify`,
    { registrationId: local.registrationId, code: '123456' },
    local.adminSeed,
  )
  expect(verify.status).toBe(200)
  expect(verify.data.status).toBe('complete')
})

// ── When ─────────────────────────────────────────────────────────────

When('the admin submits a phone number for registration', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await apiPost<{ id: string; status: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/register`,
    { bridgeUrl: local.bridgeUrl, phoneNumber: MOCK_PHONE, method: 'sms', hubId: workerHub },
    await actingAdminSeed(request, world, workerHub),
  )
  expect(status).toBe(200)
  local.registrationId = data.id
  setSharedRegistrationState(world, data.status)
})

When('the admin submits verification code {string}', async ({ request, world, workerHub }, code: string) => {
  const local = getLocalState(world)
  expect(local.registrationId).toBeDefined()
  const { status, data } = await apiPost<{ status: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/verify`,
    { registrationId: local.registrationId, code },
    local.adminSeed,
  )
  expect(status).toBe(200)
  setSharedRegistrationState(world, data.status)
})

When('the admin attempts to register without a captcha', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await apiPost<{ id: string; status: string; error?: string | null }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/register`,
    {
      bridgeUrl: local.bridgeUrl,
      // Dev-mode-only sentinel that deterministically simulates a bridge
      // captcha-required rejection — see TEST_CAPTCHA_REQUIRED_NUMBER in
      // signal-registration.ts.
      phoneNumber: '+15555550199',
      method: 'sms',
      hubId: workerHub,
    },
    await actingAdminSeed(request, world, workerHub),
  )
  expect(status).toBe(200)
  local.captchaError = data.error ?? ''
  setSharedRegistrationState(world, data.status)
})

When('the admin requests account info', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  expect(local.registrationId).toBeDefined()
  const { status, data } = await apiGet<{ registered?: boolean; uuid?: string; error?: string }>(
    request,
    `/hubs/${workerHub}/provider-setup/signal/account?registrationId=${local.registrationId}`,
    local.adminSeed,
  )
  expect(status).toBe(200)
  local.accountInfo = data
})

// ── Then ─────────────────────────────────────────────────────────────

// Signal registration and identity trust are deployment-wide messaging setup,
// audited on the platform chain (#2395).
Then('an audit log entry should be created', async ({ request }) => {
  const { status, data } = await apiGet<{ entries: unknown[] }>(request, '/admin/audit?limit=5', ADMIN_SEED)
  expect(status).toBe(200)
  expect(data.entries.length).toBeGreaterThan(0)
})

Then('the registration should fail with a captcha error message', ({ world }) => {
  const local = getLocalState(world)
  const shared = getState<SharedRegistrationFields | undefined>(world, SHARED_STATE_KEY)
  expect(shared?.registrationState).toBe('failed')
  expect((local.captchaError ?? '').toLowerCase()).toContain('captcha')
})

Then('the response should indicate registered status', ({ world }) => {
  const local = getLocalState(world)
  expect(local.accountInfo?.registered).toBe(true)
})

Then('include the Signal UUID', ({ world }) => {
  const local = getLocalState(world)
  expect(local.accountInfo?.uuid).toBeTruthy()
})

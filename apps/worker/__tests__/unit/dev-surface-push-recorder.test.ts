/**
 * The push recorder's gate, across the environments a deployed host actually
 * runs with (#1623).
 *
 * `createPushDispatcherFromService` wrapped the selected dispatcher in
 * `RecordingPushDispatcher` only when `env.ENVIRONMENT === 'development'`. That
 * is never true on a staging host, and the recorder is the ONLY writer to the
 * log `getTestPushLog()` serves — so against a deployed target the log was
 * permanently empty and three `core/push-hub-dispatch` scenarios failed on
 * `capturedEntries.length === 0`. Nothing in that symptom names the branch, the
 * environment, or the fact that push credentials are irrelevant to it.
 *
 * These assert the PREDICATE, not the environment name: recording follows
 * `devSurfacesEnabled`, which refuses `production` before it reads a flag or a
 * secret. Re-inject `ENVIRONMENT === 'development'` in push-dispatch.ts and the
 * staging cases below fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createPushDispatcherFromService,
  getTestPushLog,
  clearTestPushLog,
} from '@worker/lib/push-dispatch'
import type { Env, WakePayload, FullPushPayload } from '@worker/types'

const SECRET = 'd'.repeat(32)

const identityService = {
  getDevices: vi.fn().mockResolvedValue({ devices: [] }),
  cleanupDevices: vi.fn(),
} as never

const shiftsService = {
  getCurrentVolunteers: vi.fn().mockResolvedValue([]),
} as never

/** A host with every dev-surface factor set, on the given ENVIRONMENT. */
function optedIn(environment: string, extra: Record<string, string> = {}): Env {
  return {
    ENVIRONMENT: environment,
    DEV_ROUTES_ENABLED: 'true',
    DEV_RESET_SECRET: SECRET,
    ...extra,
  } as unknown as Env
}

async function dispatchOnce(env: Env): Promise<number> {
  clearTestPushLog()
  const dispatcher = createPushDispatcherFromService(env, identityService, shiftsService)
  await dispatcher.sendToVolunteer(
    'recipient-pk',
    { hubId: 'hub-xyz', type: 'message' } as WakePayload,
    {} as FullPushPayload,
  )
  return getTestPushLog().length
}

describe('push recorder gate (#1623)', () => {
  beforeEach(() => clearTestPushLog())

  // 1. The failure this issue is about: a NON-development host that has opted
  //    in must record. Three scenarios depended on it and saw an empty log.
  it('records on a deployed, non-development host that opted in', async () => {
    expect(await dispatchOnce(optedIn('staging'))).toBe(1)
  })

  it('records on staging whichever push transport is configured', async () => {
    expect(await dispatchOnce(optedIn('staging', { NTFY_URL: 'http://ntfy:80' }))).toBe(1)
    expect(await dispatchOnce(optedIn('staging', {
      APNS_KEY_P8: 'key', APNS_KEY_ID: 'kid', APNS_TEAM_ID: 'team',
    }))).toBe(1)
  })

  // 3. The load-bearing case. `production` is refused inside
  //    `devSurfacesRefusal` BEFORE the opt-in flag or the secret is read, so
  //    no combination of them can turn the recorder on there.
  it('refuses to record on production no matter what secret is configured', async () => {
    expect(await dispatchOnce(optedIn('production'))).toBe(0)
    expect(await dispatchOnce(optedIn('production', { E2E_TEST_SECRET: SECRET }))).toBe(0)
    expect(await dispatchOnce(optedIn('Production'))).toBe(0)
    expect(await dispatchOnce({
      ENVIRONMENT: 'production',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: SECRET,
      NTFY_URL: 'http://ntfy:80',
    } as unknown as Env)).toBe(0)
  })

  // 4. On staging the host-level factors are the whole gate for a
  //    process-level dispatcher, so each one must be load-bearing on its own.
  it('refuses to record on staging without the opt-in flag', async () => {
    expect(await dispatchOnce({
      ENVIRONMENT: 'staging',
      DEV_RESET_SECRET: SECRET,
    } as unknown as Env)).toBe(0)
  })

  it('refuses to record on staging without a configured secret', async () => {
    expect(await dispatchOnce({
      ENVIRONMENT: 'staging',
      DEV_ROUTES_ENABLED: 'true',
    } as unknown as Env)).toBe(0)
  })

  it('refuses to record on staging with a secret shorter than the minimum', async () => {
    expect(await dispatchOnce({
      ENVIRONMENT: 'staging',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: 'short',
    } as unknown as Env)).toBe(0)
  })

  // An environment nobody configured on purpose is refused too — the allowlist
  // is exact, so a typo cannot widen it the way a `!== 'production'` would.
  it('refuses to record on an environment that is not on the allowlist', async () => {
    for (const environment of ['', 'test', 'stage', 'staging ', 'Development']) {
      expect(await dispatchOnce(optedIn(environment))).toBe(0)
    }
  })

  // The recorder is now on exactly when the log is readable: GET/DELETE
  // /api/test-push-log run the same `devSurfacesEnabled` check. Writing to a
  // log no route will serve is what the old development-only branch did.
  it('refuses to record in development that has not opted the dev surface in', async () => {
    expect(await dispatchOnce({ ENVIRONMENT: 'development' } as unknown as Env)).toBe(0)
  })

  it('records in development that opted in, with no secret required there', async () => {
    expect(await dispatchOnce({
      ENVIRONMENT: 'development',
      DEV_ROUTES_ENABLED: 'true',
    } as unknown as Env)).toBe(1)
  })

  it('records one entry per on-shift volunteer on staging', async () => {
    clearTestPushLog()
    const shifts = {
      getCurrentVolunteers: vi.fn().mockResolvedValue(['pk-1', 'pk-2']),
    } as never
    const dispatcher = createPushDispatcherFromService(
      optedIn('staging', { NTFY_URL: 'http://ntfy:80' }),
      identityService,
      shifts,
    )
    await dispatcher.sendToAllOnShift(
      { hubId: 'hub-multi', type: 'assignment' } as WakePayload,
      {} as FullPushPayload,
    )
    expect(getTestPushLog().map(l => l.recipientPubkey)).toEqual(['pk-1', 'pk-2'])
  })
})

/**
 * Session and security-event self-service API steps
 * (security/session-management.feature — list/terminate sessions, list security events).
 *
 * Every request is signed with the device key of the user created by
 * "a registered user with a known keypair", so it exercises the real per-user
 * routes as that user, and every response body is validated against the
 * protocol schema the clients decode it with.
 */
import { expect } from '@playwright/test'
import type { z } from 'zod'
import { When, Then } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { apiGet, apiPost, apiDelete } from '../../api-helpers'
import {
  securityEventListResponseSchema,
  sessionListResponseSchema,
  terminateSessionsResponseSchema,
} from '@protocol/schemas/devices'

function sharedUserDeviceKey(world: Record<string, unknown>): string {
  const user = getSharedState(world).sharedUser
  if (!user) throw new Error('No shared user — run "a registered user with a known keypair" first')
  return user.deviceKey
}

function expectLastResponseMatches<S extends z.ZodType>(world: Record<string, unknown>, schema: S): z.infer<S> {
  const last = getSharedState(world).lastResponse
  if (!last) throw new Error('No response recorded — a When step must run first')
  const parsed = schema.safeParse(last.data)
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  return parsed.data as z.infer<S>
}

When('the user lists their sessions', async ({ request, world }) => {
  setLastResponse(world, await apiGet(request, '/sessions', sharedUserDeviceKey(world)))
})

When('the user terminates all other sessions', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/sessions/terminate-others', {}, sharedUserDeviceKey(world)))
})

When('the user terminates session {string}', async ({ request, world }, sessionId: string) => {
  setLastResponse(
    world,
    await apiDelete(request, `/sessions/${encodeURIComponent(sessionId)}`, sharedUserDeviceKey(world)),
  )
})

When('the user lists their security events', async ({ request, world }) => {
  setLastResponse(world, await apiGet(request, '/security-events', sharedUserDeviceKey(world)))
})

Then('the session list is returned', ({ world }) => {
  const { sessions } = expectLastResponseMatches(world, sessionListResponseSchema)
  // A signed request carries no session token, so none of the listed sessions can be "current".
  expect(sessions.filter((s) => s.isCurrent)).toEqual([])
})

Then('the terminated session count is returned', ({ world }) => {
  const { terminated } = expectLastResponseMatches(world, terminateSessionsResponseSchema)
  expect(Number.isInteger(terminated)).toBe(true)
  expect(terminated).toBeGreaterThanOrEqual(0)
})

Then('the security event list is returned', ({ world }) => {
  const { events, total } = expectLastResponseMatches(world, securityEventListResponseSchema)
  expect(total).toBeGreaterThanOrEqual(events.length)
})

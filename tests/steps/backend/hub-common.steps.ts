/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Shared step definitions for hub self-service BDD features.
 *
 * Steps used by multiple hub feature files (onboarding, isolation, security)
 * are defined here once to avoid playwright-bdd duplicate step errors.
 *
 * These steps interact with the shared response state so that feature-specific
 * Then steps can assert on the last response.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import {
  ADMIN_SEED,
  apiPost,
  createUserViaApi,
  createRoleViaApi,
  addHubMemberViaApi,
  uniqueName,
} from '../../api-helpers'

// ── Hub-Scoped Shared State ────────────────────────────────────────
// These are stored in the world under a shared key so all hub step files
// can access the current actor context and hub mapping.

export interface HubActorState {
  /** Seed hex for the current acting user. undefined = ADMIN_SEED (super admin). */
  actorSeed?: string
  /** Whether the actor is a super admin */
  isSuperAdmin: boolean
  /** Map of symbolic hub names to actual hub IDs */
  hubMap: Map<string, string>
}

const HUB_ACTOR_KEY = 'hub_actor'

export function getHubActor(world: Record<string, unknown>): HubActorState {
  let state = world[HUB_ACTOR_KEY] as HubActorState | undefined
  if (!state) {
    state = { isSuperAdmin: false, hubMap: new Map() }
    world[HUB_ACTOR_KEY] = state
  }
  return state
}

export function setHubActor(world: Record<string, unknown>, state: HubActorState): void {
  world[HUB_ACTOR_KEY] = state
}

// ── Shared Given Steps ─────────────────────────────────────────────

Given('I am a super admin', async ({ world }) => {
  const actor = getHubActor(world)
  actor.actorSeed = undefined // ADMIN_SEED has all permissions
  actor.isSuperAdmin = true
})

Given('I am a hub admin', async ({ world }) => {
  const actor = getHubActor(world)
  actor.actorSeed = undefined // Default admin
  actor.isSuperAdmin = false
})

Given('I am a hub admin for hub {string}', async ({ request, world }, hubName: string) => {
  const actor = getHubActor(world)
  // Create a role with hub-admin-level permissions
  const role = await createRoleViaApi(request, {
    name: uniqueName(`hub-admin-${hubName}`),
    slug: uniqueName(`hub-admin-${hubName}`),
    permissions: [
      'telephony:manage-providers',
      'telephony:view-providers',
      'telephony:view-numbers',
      'hubs:configure',
    ],
  })
  // Create user WITHOUT global roles — permissions come from hub membership only
  const user = await createUserViaApi(request, {
    name: uniqueName(`admin-${hubName}`),
    roleIds: [],
  })
  // Add user as hub member with the role (hub-scoped, not global)
  const hubId = actor.hubMap.get(hubName)
  if (hubId) {
    await addHubMemberViaApi(request, hubId, user.pubkey, [role.id])
  }
  actor.actorSeed = user.seedHex
  actor.isSuperAdmin = false
})

Given('provider {string} is configured for hub {string}', async ({ request, world }, provider: string, hubName: string) => {
  const actor = getHubActor(world)
  const hubId = actor.hubMap.get(hubName)
  // If hubId is in the map, use it; otherwise use workerHub or fall back to name
  const targetHubId = hubId ?? (world as Record<string, unknown>).workerHubId as string ?? hubName
  await apiPost(request, '/provider-setup/configure', {
    provider,
    credentials: {
      accountSid: 'AC00000000000000000000000000000000',
      authToken: 'test_auth_token_00000000000000000000',
    },
    hubId: targetHubId,
  })
})

// ── Shared Then Steps ──────────────────────────────────────────────

Then('the response is {int}', async ({ world }, expectedStatus: number) => {
  const shared = getSharedState(world)
  expect(shared.lastResponse).toBeDefined()
  expect(shared.lastResponse!.status).toBe(expectedStatus)
})

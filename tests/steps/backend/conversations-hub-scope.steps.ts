/**
 * Conversations hub-scope step definitions (#2381).
 *
 * Both hubs are created fresh per scenario so each holds exactly the waiting
 * conversation seeded here: no shift, no auto-assignment, nothing left over from
 * another scenario. Assertions are on response BODIES — an unscoped route that
 * answered 200 with every hub's queue is the defect, and a status check alone
 * cannot tell that from a 404.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import {
  apiGet,
  createHubViaApi,
  createRoleViaApi,
  createUserViaApi,
  deleteHubViaApi,
  deleteRoleViaApi,
  ADMIN_SEED,
} from '../../api-helpers'
import { simulateIncomingMessage, uniqueCallerNumber } from '../../simulation-helpers'

interface Seeded {
  id: string
  contactIdentifierHash: string
}

interface ConversationScopeState {
  hubs: Record<string, string>
  /** Hub label → the waiting conversation seeded in it */
  waiting: Record<string, Seeded>
  actors: Record<string, string>
  roleIds: string[]
  last?: { status: number; data: unknown }
}

const STATE_KEY = 'conversations_hub_scope'

function s(world: Record<string, unknown>): ConversationScopeState {
  return getState<ConversationScopeState>(world, STATE_KEY)
}

function hub(world: Record<string, unknown>, label: string): string {
  const id = s(world).hubs[label]
  expect(id, `hub "${label}" not set up`).toBeTruthy()
  return id
}

function seedOf(world: Record<string, unknown>, name: string): string {
  const seed = s(world).actors[name]
  expect(seed, `actor "${name}" not set up`).toBeTruthy()
  return seed
}

function waitingIn(world: Record<string, unknown>, label: string): Seeded {
  const conv = s(world).waiting[label]
  expect(conv, `no waiting conversation seeded in hub "${label}"`).toBeTruthy()
  return conv
}

function lastResponse(world: Record<string, unknown>): { status: number; data: unknown } {
  const last = s(world).last
  if (!last) throw new Error('no response recorded')
  return last
}

/** The conversation ids of the last list response; fails when it carried no list. */
function listedIds(world: Record<string, unknown>): string[] {
  const data = lastResponse(world).data as { conversations?: Array<{ id: string }> } | null
  if (!data?.conversations) throw new Error(`not a conversation list: ${JSON.stringify(data)}`)
  return data.conversations.map(c => c.id)
}

function record(world: Record<string, unknown>, res: { status: number; data: unknown }): void {
  s(world).last = res
  setLastResponse(world, res)
}

Before(async ({ world }) => {
  setState<ConversationScopeState>(world, STATE_KEY, { hubs: {}, waiting: {}, actors: {}, roleIds: [] })
})

After(async ({ request, world }) => {
  const state = s(world)
  if (!state) return
  for (const hubId of Object.values(state.hubs)) await deleteHubViaApi(request, hubId)
  for (const roleId of state.roleIds) await deleteRoleViaApi(request, roleId)
})

// ── Given ───────────────────────────────────────────────────────────

Given('conversation hubs {string} and {string} exist', async ({ request, world }, a: string, b: string) => {
  for (const label of [a, b]) {
    s(world).hubs[label] = await createHubViaApi(
      request, `bdd-conv-scope-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
  }
})

Given('hub {string} has a waiting {string} conversation', async ({ request, world }, label: string, channel: string) => {
  const hubId = hub(world, label)
  const { conversationId } = await simulateIncomingMessage(request, {
    senderNumber: uniqueCallerNumber(),
    body: `waiting in hub ${label}`,
    channel: channel as 'sms',
    hubId,
  })
  // Precondition, read as the super-admin through the hub: the row is this
  // hub's and is waiting — otherwise "sees none of it" below proves nothing.
  const { status, data } = await apiGet<{ id: string; status: string; channelType: string; contactIdentifierHash: string }>(
    request, `/hubs/${hubId}/conversations/${conversationId}`, ADMIN_SEED,
  )
  expect(status, `the admin reading hub ${label}'s seeded conversation`).toBe(200)
  expect(data.status).toBe('waiting')
  expect(data.channelType).toBe(channel)
  s(world).waiting[label] = { id: data.id, contactIdentifierHash: data.contactIdentifierHash }
})

Given('{string} is a member of hub {string} with no conversation permission', async ({ request, world }, name: string, label: string) => {
  // A real hub membership, holding a permission that is not a conversation
  // one: past hubContext (which admits any member), but with nothing to claim.
  const slug = `no-conversations-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const role = await createRoleViaApi(request, { name: `No conversations ${slug}`, slug, permissions: ['notes:read-own'] })
  s(world).roleIds.push(role.id)
  const user = await createUserViaApi(request, { name, roleIds: [role.id], hubId: hub(world, label) })
  s(world).actors[name] = user.seedHex
})

Given('{string} is a volunteer of hub {string} only', async ({ request, world }, name: string, label: string) => {
  const user = await createUserViaApi(request, { name, roleIds: ['role-volunteer'], hubId: hub(world, label) })
  s(world).actors[name] = user.seedHex
})

// ── When ────────────────────────────────────────────────────────────

When('{string} requests {string}', async ({ request, world }, name: string, path: string) => {
  record(world, await apiGet(request, path, seedOf(world, name)))
})

When('{string} requests hub {string}\'s conversation by its unscoped id', async ({ request, world }, name: string, label: string) => {
  record(world, await apiGet(request, `/conversations/${waitingIn(world, label).id}`, seedOf(world, name)))
})

When('{string} lists the conversations of hub {string}', async ({ request, world }, name: string, label: string) => {
  record(world, await apiGet(request, `/hubs/${hub(world, label)}/conversations`, seedOf(world, name)))
})

When(
  '{string} fetches hub {string}\'s waiting conversation through hub {string}',
  async ({ request, world }, name: string, owner: string, through: string) => {
    record(world, await apiGet(
      request, `/hubs/${hub(world, through)}/conversations/${waitingIn(world, owner).id}`, seedOf(world, name),
    ))
  },
)

When('the admin reads the conversation counts of hub {string}', async ({ request, world }, label: string) => {
  record(world, await apiGet(request, `/hubs/${hub(world, label)}/conversations/stats`, ADMIN_SEED))
})

// ── Then ────────────────────────────────────────────────────────────

Then('the response carries no conversation of hub {string} or hub {string}', async ({ world }, a: string, b: string) => {
  const last = lastResponse(world)
  const body = JSON.stringify(last.data ?? null)
  for (const label of [a, b]) {
    const conv = waitingIn(world, label)
    expect(body, `hub ${label}'s conversation id in ${body}`).not.toContain(conv.id)
    expect(body, `hub ${label}'s contact hash in ${body}`).not.toContain(conv.contactIdentifierHash)
  }
  const data = (last.data ?? {}) as { conversations?: unknown[]; id?: unknown }
  expect(data.conversations ?? [], 'a conversation list').toEqual([])
  expect(data.id, 'a single conversation').toBeUndefined()
})

Then('the response carries no conversation counts', async ({ world }) => {
  const data = (lastResponse(world).data ?? {}) as Record<string, unknown>
  for (const key of ['waiting', 'active', 'closed', 'today', 'total']) {
    expect(data[key], `"${key}" in ${JSON.stringify(data)}`).toBeUndefined()
  }
})

Then('the listed conversations are exactly none', async ({ world }) => {
  expect(listedIds(world)).toEqual([])
  expect((lastResponse(world).data as { waitingCount?: number }).waitingCount).toBe(0)
})

Then(
  'the listed conversations are exactly hub {string}\'s waiting {string} conversation',
  async ({ world }, label: string, channel: string) => {
    expect(listedIds(world)).toEqual([waitingIn(world, label).id])
    const [row] = (lastResponse(world).data as { conversations: Array<{ channelType: string; status: string }> }).conversations
    expect(row).toMatchObject({ channelType: channel, status: 'waiting' })
  },
)

Then('the counts are {int} waiting of {int} in total', async ({ world }, waiting: number, total: number) => {
  const data = lastResponse(world).data as { waiting: number; total: number }
  expect(data).toMatchObject({ waiting, total })
})

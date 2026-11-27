/**
 * Backend steps for the numbers a hub answers on (#1331): the declaration API
 * (`PUT /api/provider-setup/numbers`), the provider form's number
 * (`POST /api/provider-setup/configure`) and what the hub then lists. Every
 * assertion reads what the server stored and returns, never what the step sent.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { apiGet, apiPost, apiPut, createHubViaApi, deleteHubViaApiIfPresent, uniqueName } from '../../api-helpers'

const STATE_KEY = 'hubNumbers'

interface HubNumbersState {
  hubId: string
  otherHubId?: string
  lastStatus?: number
}

interface NumberList {
  numbers: Array<{ number: string; source: string }>
}

function state(world: Record<string, unknown>): HubNumbersState {
  const s = getState<HubNumbersState | undefined>(world, STATE_KEY)
  if (!s) throw new Error('the scenario has no hub of its own yet')
  return s
}

After({ tags: '@hub-numbers' }, async ({ request, world }) => {
  const s = getState<HubNumbersState | undefined>(world, STATE_KEY)
  if (!s) return
  await deleteHubViaApiIfPresent(request, s.hubId)
  if (s.otherHubId) await deleteHubViaApiIfPresent(request, s.otherHubId)
})

Given('a hub that answers on no number', async ({ request, world }) => {
  const hubId = await createHubViaApi(request, uniqueName('hub-numbers'))
  setState(world, STATE_KEY, { hubId } satisfies HubNumbersState)
})

Given('another hub answers on {string}', async ({ request, world }, number: string) => {
  const s = state(world)
  s.otherHubId = await createHubViaApi(request, uniqueName('hub-numbers-other'))
  const res = await apiPut(request, '/provider-setup/numbers', { hubId: s.otherHubId, numbers: [number] })
  expect(res.status, `declare the other hub's number: ${JSON.stringify(res.data)}`).toBe(200)
})

When('the operator declares the numbers {string} and {string} for the hub', async ({ request, world }, a: string, b: string) => {
  const s = state(world)
  s.lastStatus = (await apiPut(request, '/provider-setup/numbers', { hubId: s.hubId, numbers: [a, b] })).status
})

When('the operator declares the numbers {string} for the hub', async ({ request, world }, number: string) => {
  const s = state(world)
  s.lastStatus = (await apiPut(request, '/provider-setup/numbers', { hubId: s.hubId, numbers: [number] })).status
})

When('the operator configures the hub\'s PBX provider with the number {string}', async ({ request, world }, number: string) => {
  const s = state(world)
  s.lastStatus = (await apiPost(request, '/provider-setup/configure', {
    provider: 'asterisk',
    credentials: { ariUrl: 'http://pbx.example.com:8088', ariUsername: 'llamenos', ariPassword: 'secret' },
    hubId: s.hubId,
    phoneNumber: number,
  })).status
})

Then('the declaration is accepted', ({ world }) => {
  expect(state(world).lastStatus).toBe(200)
})

Then('the declaration is refused as a conflict', ({ world }) => {
  expect(state(world).lastStatus).toBe(409)
})

Then('the declaration is refused as invalid', ({ world }) => {
  expect(state(world).lastStatus).toBe(400)
})

async function listed(request: Parameters<typeof apiGet>[0], hubId: string): Promise<string[]> {
  const { status, data } = await apiGet<NumberList>(request, `/provider-setup/numbers?hubId=${hubId}`)
  expect(status, `list the hub's numbers: ${JSON.stringify(data)}`).toBe(200)
  return data.numbers.map((n) => n.number)
}

Then('the hub lists the numbers {string} and {string}, primary first', async ({ request, world }, a: string, b: string) => {
  expect(await listed(request, state(world).hubId)).toEqual([a, b])
})

Then('the hub lists the numbers {string}, primary first', async ({ request, world }, a: string) => {
  expect(await listed(request, state(world).hubId)).toEqual([a])
})

Then('the hub lists no numbers', async ({ request, world }) => {
  expect(await listed(request, state(world).hubId)).toEqual([])
})

Then('the hub\'s primary number is {string}', async ({ request, world }, number: string) => {
  const { data } = await apiGet<{ hub: { phoneNumber?: string } }>(request, `/hubs/${state(world).hubId}`)
  expect(data.hub.phoneNumber).toBe(number)
})

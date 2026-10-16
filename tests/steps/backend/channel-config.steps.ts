import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { apiGet, apiPost, apiPatch, ADMIN_SEED, createUserViaApi, uniqueName } from '../../api-helpers'
import { getActorSeed, setActorSeed, setLastResponse, resolvePathParams } from './shared-state'

interface ChannelConfigState {
  lastStatus: number
  lastData: unknown
  actorSeed: string
}

const KEY = 'channelConfig'

function getCS(world: Record<string, unknown>): ChannelConfigState {
  const existing = getState<Partial<ChannelConfigState>>(world, KEY)
  return { lastStatus: 0, lastData: null, actorSeed: ADMIN_SEED, ...existing }
}

function setCS(world: Record<string, unknown>, updates: Partial<ChannelConfigState>): void {
  setState(world, KEY, { ...getCS(world), ...updates })
}

interface DataTable {
  hashes(): Array<Record<string, string>>
}

// ── Auth/Permission Setup ──────────────────────────────────────────────────

Given('I am authenticated as a hub admin', ({ world }) => {
  setCS(world, { actorSeed: ADMIN_SEED })
  setActorSeed(world, ADMIN_SEED)
})

Given('I have the {string} permission', ({ world }, _permission: string) => {
  // Admin has all permissions — this is a declarative assertion, no action needed
  setCS(world, { actorSeed: getCS(world).actorSeed })
})

Given('I am authenticated as a regular volunteer', async ({ request, world }) => {
  const user = await createUserViaApi(request, {
    name: uniqueName('vol'),
    roleIds: ['role-volunteer'],
  })
  setCS(world, { actorSeed: user.seedHex })
  setActorSeed(world, user.seedHex)
})

Given('I do not have the {string} permission', ({ world }, _permission: string) => {
  // Declarative: the current user is expected to lack this permission
  setCS(world, { actorSeed: getCS(world).actorSeed })
})

// ── Request Steps ──────────────────────────────────────────────────────────

When('I PATCH {string} with:', async ({ request, world }, path: string, table: DataTable) => {
  const body: Record<string, unknown> = {}
  for (const row of table.hashes()) {
    const keys = row.field.split('.')
    let current = body
    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = current[keys[i]] || {}
      current = current[keys[i]] as Record<string, unknown>
    }
    const value = row.value === 'true' ? true : row.value === 'false' ? false : row.value
    current[keys[keys.length - 1]] = value
  }

  const { status, data } = await apiPatch(request, path, body, getCS(world).actorSeed)
  setCS(world, { lastStatus: status, lastData: data })
})

When('I POST {string} with:', async ({ request, world, workerHub }, path: string, table: DataTable) => {
  const body: Record<string, unknown> = {}
  for (const row of table.hashes()) {
    if (row.field) {
      body[row.field] = row.value === 'true' ? true : row.value === 'false' ? false : row.value
    }
  }
  // Endpoints that operate on a hub scope need hubId — include it for routes that use it
  if (path.includes('/a2p/') || path.includes('/provider-setup/')) {
    body.hubId = workerHub
  }

  const { status, data } = await apiPost(request, path, body, getCS(world).actorSeed)
  setCS(world, { lastStatus: status, lastData: data })
})

When('I GET {string}', async ({ request, world, workerHub }, rawPath: string) => {
  // Resolve "{hubId}"/"{ringGroupId}"/etc. path placeholders set by other step
  // files (e.g. the shifts/ring-groups REST vocabulary) before any
  // endpoint-specific query-param handling below.
  const path = resolvePathParams(world, rawPath, workerHub)
  // Append hubId query param for endpoints that need it
  const pathWithHub = (path.includes('/a2p/') || path.includes('/provider-setup/'))
    ? `${path}${path.includes('?') ? '&' : '?'}hubId=${workerHub}`
    : path
  const { status, data } = await apiGet(request, pathWithHub, getActorSeed(world))
  setCS(world, { lastStatus: status, lastData: data })
  setLastResponse(world, { status, data })
})

// ── Assertions ─────────────────────────────────────────────────────────────

Then('the channel config response status is {int}', ({ world }, status: number) => {
  expect(getCS(world).lastStatus).toBe(status)
})

Then('the response status is {int} or {int}', ({ world }, s1: number, s2: number) => {
  expect([s1, s2]).toContain(getCS(world).lastStatus)
})

Then('the channel config response status is {int} or {int}', ({ world }, s1: number, s2: number) => {
  expect([s1, s2]).toContain(getCS(world).lastStatus)
})

Then('the response {string} includes {string}', ({ world }, field: string, value: string) => {
  const arr = getNestedField(getCS(world).lastData, field)
  expect(Array.isArray(arr)).toBe(true)
  expect(arr).toContain(value)
})

Then('the response {string} is {string}', ({ world }, field: string, value: string) => {
  expect(getNestedField(getCS(world).lastData, field)).toBe(value)
})

Then('the response has a {string} boolean field', ({ world }, field: string) => {
  expect(typeof getNestedField(getCS(world).lastData, field)).toBe('boolean')
})

// ── Helpers ────────────────────────────────────────────────────────────────

Given('the {string} channel is configured', async ({ request }, channel: string) => {
  const config: Record<string, unknown> = {}
  if (channel === 'signal') {
    config.signal = { bridgeUrl: 'http://localhost:8080', bridgeApiKey: 'test', webhookSecret: 'test', registeredNumber: '+1234' }
  }
  await apiPatch(request, '/settings/messaging', config)
})

function getNestedField(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => (acc as Record<string, unknown>)?.[key], obj)
}

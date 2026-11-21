/**
 * OpenAPI spec step definitions — verifies /api/openapi.json and /api/docs.
 *
 * Uses unique step text to avoid conflicts with shared assertion steps.
 */
import { expect } from '@playwright/test'
import { When, Then, getState, setState } from './fixtures'
import { apiGet, createHubViaApi, uniqueName } from '../../api-helpers'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

const OPENAPI_KEY = 'openapi'
const SWEEP_KEY = 'declaredResponseSweep'

interface OpenApiState {
  specJson?: Record<string, unknown>
  docsResponse?: { status: number; contentType: string }
}

function getOpenApiState(world: Record<string, unknown>): OpenApiState {
  let s = getState<OpenApiState | undefined>(world, OPENAPI_KEY)
  if (!s) {
    s = {}
    setState(world, OPENAPI_KEY, s)
  }
  return s
}

When('I fetch the OpenAPI spec', async ({ request, world }) => {
  const oa = getOpenApiState(world)
  const res = await request.get(`${BASE_URL}/api/openapi.json`)
  expect(res.status()).toBe(200)
  oa.specJson = await res.json()
})

When('I fetch the Scalar docs page', async ({ request, world }) => {
  const oa = getOpenApiState(world)
  const res = await request.get(`${BASE_URL}/api/docs`)
  const headers: Record<string, string> = {}
  for (const { name, value } of res.headersArray()) {
    headers[name.toLowerCase()] = value
  }
  oa.docsResponse = { status: res.status(), contentType: headers['content-type'] || '' }
})

Then('the OpenAPI spec should be valid', async ({ world }) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson).toBeDefined()
  expect(String(oa.specJson!.openapi)).toMatch(/^3\./)
})

Then('the spec info title should be {string}', async ({ world }, title: string) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson).toBeDefined()
  const info = oa.specJson!.info as Record<string, unknown>
  expect(info.title).toBe(title)
})

Then('the Scalar docs page should be HTML', async ({ world }) => {
  const oa = getOpenApiState(world)
  expect(oa.docsResponse).toBeDefined()
  expect(oa.docsResponse!.status).toBe(200)
  expect(oa.docsResponse!.contentType).toContain('text/html')
})

Then('the spec should include tags:', async ({ world }, table: { hashes: () => Array<{ tag: string }> }) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson).toBeDefined()
  const tagNames = ((oa.specJson!.tags as Array<{ name: string }>) || []).map(t => t.name)
  for (const row of table.hashes()) {
    expect(tagNames, `Missing tag: ${row.tag}`).toContain(row.tag)
  }
})

Then('the spec should define a {string} security scheme of type {string}', async ({ world }, name: string, type: string) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson).toBeDefined()
  const components = oa.specJson!.components as Record<string, unknown>
  const schemes = components?.securitySchemes as Record<string, { type: string }>
  expect(schemes).toBeDefined()
  expect(schemes[name]).toBeDefined()
  expect(schemes[name].type).toBe(type)
})

Then('the spec should document these paths:', async ({ world }, table: { hashes: () => Array<{ method: string; path: string }> }) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson).toBeDefined()
  const paths = oa.specJson!.paths as Record<string, Record<string, unknown>>
  expect(paths).toBeDefined()

  for (const row of table.hashes()) {
    const pathEntry = paths[row.path]
    expect(pathEntry, `Missing path: ${row.path}`).toBeDefined()
    expect(pathEntry[row.method], `Missing ${row.method.toUpperCase()} ${row.path}`).toBeDefined()
  }
})

// ── Declared-response sweep (#2710) ──────────────────────────────────
//
// The server holds every response to the schema its route declared when the request carries
// `X-Declared-Response-Check: enforce` (playwright.config.ts sends it on every backend
// request) and answers a violation with a 500 that names the route and the failing paths.

/** The 500 body of the declared-response check — not any other 500. */
const DECLARED_RESPONSE_VIOLATION = 'Response does not satisfy its declared schema'

/** A path parameter that names nothing: the read is answered 404/400 — still judged if the route declares it. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

/** Documentation and streaming surfaces: not JSON API routes, and a held-open read would never end. */
const NOT_SWEPT = [/^\/openapi\.json$/, /^\/docs/, /\/stream$/, /\/ws$/]

interface SweepState {
  swept: number
  violations: { path: string; detail: string }[]
}

When('an admin reads every GET endpoint the spec declares a JSON response for', async ({ request, world }) => {
  const oa = getOpenApiState(world)
  expect(oa.specJson, 'fetch the OpenAPI spec first').toBeDefined()
  const hubId = await createHubViaApi(request, uniqueName('sweep'))
  const paths = oa.specJson!.paths as Record<string, { get?: { responses?: Record<string, { content?: Record<string, unknown> }> } }>
  const state: SweepState = { swept: 0, violations: [] }
  for (const [template, ops] of Object.entries(paths)) {
    const operation = ops.get
    if (!operation || NOT_SWEPT.some(pattern => pattern.test(template))) continue
    const declaresJson = Object.values(operation.responses ?? {}).some(r => r?.content?.['application/json'])
    if (!declaresJson) continue
    const path = template.replace('{hubId}', hubId).replace(/\{[^}]+\}/g, UNKNOWN_ID)
    const { status, data } = await apiGet<{ error?: string; violation?: { issues?: unknown } }>(request, path)
    state.swept++
    if (status === 500 && data?.error === DECLARED_RESPONSE_VIOLATION) {
      state.violations.push({ path: template, detail: JSON.stringify(data.violation?.issues) })
    }
  }
  setState(world, SWEEP_KEY, state)
})

Then('no endpoint answered with a response its declared schema rejects', async ({ world }) => {
  const state = getState<SweepState | undefined>(world, SWEEP_KEY)
  expect(state, 'the sweep did not run').toBeDefined()
  // Floor, not a count to maintain: the sweep covers the whole API (~275 today), so a spec that
  // lost its routes — or a filter that skipped them all — fails here instead of passing empty.
  expect(state!.swept).toBeGreaterThan(150)
  expect(state!.violations, `GET endpoints whose response its schema rejects:\n${state!.violations.map(v => `  ${v.path}: ${v.detail}`).join('\n')}`).toEqual([])
})

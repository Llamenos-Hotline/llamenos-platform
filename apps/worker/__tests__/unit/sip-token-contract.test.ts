/**
 * The SIP credential contract: what `GET /api/telephony/sip-token` actually returns
 * must be exactly what `sipTokenResponseSchema` — and therefore the published OpenAPI
 * document — says it returns.
 *
 * These three shapes disagreed before (#1188 item 2): the server returned a nested
 * `{ provider, sip: {...} }`, the schema declared a flat object with `iceServers: {urls}[]`
 * and `encryption`, and both mobile clients hand-wrote a third shape. Nothing failed,
 * because no test ever fed a real server response to the schema.
 *
 * Every assertion below starts from a payload produced by `generateSipParams` — the real
 * server code — never from a fixture written to match the schema.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { openAPIRouteHandler } from 'hono-openapi'
import { generateSipParams, SIP_PARAMS_TTL_SECONDS } from '@worker/telephony/sip-tokens'
import webrtcRoutes from '@worker/routes/webrtc'
import { sipTokenResponseSchema } from '@protocol/schemas/webrtc'
import type { TelephonyProviderConfig } from '@shared/types'

/** Every provider `generateSipParams` supports, with the minimum config each requires. */
const SIP_PROVIDER_CONFIGS: Array<[string, TelephonyProviderConfig]> = [
  ['twilio', {
    type: 'twilio',
    phoneNumber: '+15550000000',
    accountSid: 'ACtest',
    authToken: 'token',
    sipDomain: 'myapp.sip.twilio.com',
    sipUsername: 'user',
    sipPassword: 'pass',
  }],
  ['signalwire', {
    type: 'signalwire',
    phoneNumber: '+15550000001',
    accountSid: 'ACtest',
    authToken: 'token',
    sipDomain: 'sip.example.signalwire.com',
    sipUsername: 'user',
    sipPassword: 'pass',
    spaceUrl: 'https://myspace.signalwire.com',
  }],
  ['vonage', {
    type: 'vonage',
    phoneNumber: '+15550000002',
    apiKey: 'key',
    apiSecret: 'secret',
    applicationId: 'app',
    asteriskGateway: 'gw.example.com',
    asteriskSipUsername: 'user',
    asteriskSipPassword: 'pass',
  }],
  ['plivo', {
    type: 'plivo',
    phoneNumber: '+15550000003',
    authId: 'id',
    authToken: 'tok',
    sipEndpointUsername: 'plivouser',
    sipEndpointPassword: 'plivo123',
  }],
  ['asterisk', {
    type: 'asterisk',
    phoneNumber: '+15550000004',
    sipDomain: 'pbx.example.com',
    sipUsername: 'volunteer',
    sipPassword: 's3cr3t',
  }],
]

/**
 * The exact bytes the route puts on the wire: `webrtc.ts` hands the result of
 * `generateSipParams` straight to `c.json()`, so a JSON round-trip is the response body.
 */
function actualServerResponse(config: TelephonyProviderConfig, now?: Date): unknown {
  return JSON.parse(JSON.stringify(generateSipParams(config, 'vol_0123456789abcdef', now)))
}

describe('sip-token response: schema describes the real server response', () => {
  for (const [name, config] of SIP_PROVIDER_CONFIGS) {
    it(`${name}: parses, and parsing strips nothing`, () => {
      const actual = actualServerResponse(config)

      // `.parse()` throws on a missing or wrongly-typed field, and a Zod object drops
      // keys it does not declare — so deep equality catches both directions of drift.
      expect(sipTokenResponseSchema.parse(actual)).toEqual(actual)
    })
  }

  it('rejects the flat shape the schema used to declare', () => {
    // The pre-fix schema. If this ever parses again, the contract has regressed.
    const flat = {
      domain: 'myapp.sip.twilio.com',
      transport: 'tls',
      username: 'user',
      password: 'pass',
      iceServers: [{ urls: ['stun:global.stun.twilio.com:3478'] }],
      encryption: 'srtp',
    }
    expect(sipTokenResponseSchema.safeParse(flat).success).toBe(false)
  })

  it('rejects the ICE server shape the schema used to declare', () => {
    const actual = actualServerResponse(SIP_PROVIDER_CONFIGS[0][1]) as Record<string, never>
    const withBrowserIceServers = {
      ...actual,
      sip: { ...(actual.sip as object), iceServers: [{ urls: ['stun:example.com:3478'] }] },
    }
    expect(sipTokenResponseSchema.safeParse(withBrowserIceServers).success).toBe(false)
  })
})

describe('sip-token response: validity window', () => {
  it('stamps an absolute issuedAt/expiresAt pair separated by the TTL', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const parsed = sipTokenResponseSchema.parse(
      actualServerResponse(SIP_PROVIDER_CONFIGS[0][1], now),
    )

    expect(parsed.issuedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.expiresAt).toBe('2026-01-01T01:00:00.000Z')
    expect(Date.parse(parsed.expiresAt) - Date.parse(parsed.issuedAt)).toBe(
      SIP_PARAMS_TTL_SECONDS * 1000,
    )
  })

  it('is in the future for every provider, so a client can always set a refresh timer', () => {
    for (const [name, config] of SIP_PROVIDER_CONFIGS) {
      const parsed = sipTokenResponseSchema.parse(actualServerResponse(config))
      expect(Date.parse(parsed.expiresAt), name).toBeGreaterThan(Date.parse(parsed.issuedAt))
    }
  })
})

// --- OpenAPI: the published document, not just the Zod object ---

type JsonSchema = Record<string, unknown>

/** Resolve `#/components/schemas/X` style refs against the generated document. */
function deref(schema: JsonSchema, spec: Record<string, unknown>): JsonSchema {
  const ref = schema['$ref']
  if (typeof ref !== 'string') return schema
  const segments = ref.replace(/^#\//, '').split('/')
  let node: unknown = spec
  for (const segment of segments) {
    node = (node as Record<string, unknown>)?.[segment]
  }
  return deref(node as JsonSchema, spec)
}

/**
 * Assert a JSON Schema from the OpenAPI document actually describes `value`:
 * every property present is declared, every required property is present,
 * and enums/types agree. Deliberately hand-rolled — the point is to check the
 * *published document*, with no Zod involved on the validating side.
 */
function assertDescribes(rawSchema: JsonSchema, value: unknown, spec: Record<string, unknown>, path = '$'): void {
  const schema = deref(rawSchema, spec)

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches) && branches.length === 1) {
      assertDescribes(branches[0] as JsonSchema, value, spec, path)
      return
    }
  }

  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    expect(enumValues, `${path} enum`).toContain(value)
    return
  }

  if (Array.isArray(value)) {
    expect(schema['type'], `${path} type`).toBe('array')
    value.forEach((item, i) =>
      assertDescribes(schema['items'] as JsonSchema, item, spec, `${path}[${i}]`),
    )
    return
  }

  if (value !== null && typeof value === 'object') {
    expect(schema['type'], `${path} type`).toBe('object')
    const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>
    const required = (schema['required'] ?? []) as string[]

    for (const key of required) {
      expect(Object.keys(value as object), `${path} missing required "${key}"`).toContain(key)
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      expect(properties[key], `${path}.${key} is undocumented`).toBeDefined()
      assertDescribes(properties[key], item, spec, `${path}.${key}`)
    }
    return
  }

  const expected = typeof value === 'number' ? ['number', 'integer'] : [typeof value]
  expect(expected, `${path} type`).toContain(schema['type'])
}

describe('sip-token response: the published OpenAPI document', () => {
  /**
   * Generate the spec from the real route module. `openAPIRouteHandler` only reads the
   * `describeRoute` metadata, so no handler runs and no database is needed — this is the
   * same derivation the dev server performs when it writes
   * `packages/protocol/openapi-snapshot.json` on startup.
   */
  async function generateSpec(): Promise<Record<string, unknown>> {
    const api = new Hono()
    api.route('/telephony', webrtcRoutes)
    api.get('/openapi.json', openAPIRouteHandler(api, {
      documentation: { info: { title: 'contract-test', version: '0' } },
    }))
    return await (await api.request('/openapi.json')).json()
  }

  function sipResponseSchema(spec: Record<string, unknown>): JsonSchema {
    const paths = spec['paths'] as Record<string, Record<string, Record<string, unknown>>>
    const get = paths['/telephony/sip-token']['get']
    const responses = get['responses'] as Record<string, Record<string, Record<string, { schema: JsonSchema }>>>
    return responses['200']['content']['application/json'].schema
  }

  it('describes the real response for every provider', async () => {
    const spec = await generateSpec()
    const schema = sipResponseSchema(spec)

    for (const [name, config] of SIP_PROVIDER_CONFIGS) {
      assertDescribes(schema, actualServerResponse(config), spec, `sip-token(${name})`)
    }
  })

  it('regenerates byte-identically', async () => {
    const [first, second] = await Promise.all([generateSpec(), generateSpec()])
    expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2))
  })
})

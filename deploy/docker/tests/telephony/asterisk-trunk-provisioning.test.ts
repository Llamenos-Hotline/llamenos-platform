/**
 * The Asterisk provider's createSipTrunk against a recorded ARI: what it writes,
 * in what order, and what it refuses. run-call-e2e.sh proves the same trunk
 * routes real calls; this pins the shape of what reaches the PBX.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asteriskProvider } from '../../../../apps/worker/services/provider-setup/providers/asterisk'
import { ProviderApiError } from '../../../../apps/worker/services/provider-setup/types'

const CREDENTIALS = { ariUrl: 'http://asterisk:8088', ariUsername: 'llamenos', ariPassword: 'ari-pass' }
const CARRIER_PASSWORD = 'carrier-issued-secret'

interface AriCall {
  method: string
  object: string
  fields?: Record<string, string>
}

let calls: AriCall[]
/** Status ARI answers with, by "METHOD type/id"; anything unlisted is 200 (PUT) or 204 (DELETE) */
let statusFor: Record<string, number>

beforeEach(() => {
  calls = []
  statusFor = {}
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const prefix = '/ari/asterisk/config/dynamic/res_pjsip/'
    expect(url.origin).toBe('http://asterisk:8088')
    expect(url.pathname.startsWith(prefix)).toBe(true)
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${btoa('llamenos:ari-pass')}`)
    const method = init.method ?? 'GET'
    const object = url.pathname.slice(prefix.length)
    const body = init.body ? (JSON.parse(String(init.body)) as { fields: Array<{ attribute: string; value: string }> }) : undefined
    calls.push({
      method,
      object,
      fields: body && Object.fromEntries(body.fields.map((f) => [f.attribute, f.value])),
    })
    const status = statusFor[`${method} ${object}`] ?? (method === 'DELETE' ? 204 : 200)
    return new Response(status === 204 ? null : JSON.stringify(status < 300 ? [] : { message: 'nope' }), { status })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const put = (object: string) => calls.find((c) => c.method === 'PUT' && c.object === object)

describe('asteriskProvider.createSipTrunk', () => {
  it('writes an IP-authenticated trunk from scratch: aor, endpoint, identify — no auth, no registration', async () => {
    const trunk = await asteriskProvider.createSipTrunk(CREDENTIALS, { domain: 'sip.carrier.example:5080' })

    expect(calls.map((c) => `${c.method} ${c.object}`)).toEqual([
      'DELETE registration/trunk',
      'DELETE identify/trunk',
      'DELETE endpoint/trunk',
      'DELETE aor/trunk',
      'DELETE auth/trunk-auth',
      'PUT aor/trunk',
      'PUT endpoint/trunk',
      'PUT identify/trunk',
    ])
    expect(put('aor/trunk')?.fields).toMatchObject({ contact: 'sip:sip.carrier.example:5080' })
    expect(put('endpoint/trunk')?.fields).toMatchObject({ context: 'from-trunk', aors: 'trunk' })
    expect(put('endpoint/trunk')?.fields).not.toHaveProperty('outbound_auth')
    // The carrier is matched by host, never host:port.
    expect(put('identify/trunk')?.fields).toEqual({ endpoint: 'trunk', match: 'sip.carrier.example' })
    expect(trunk).toEqual({ sipProvider: 'sip.carrier.example:5080', sipUsername: undefined })
  })

  it('sets a caller ID with a name and no number, so astdb cannot turn it into the caller number "unknown"', async () => {
    await asteriskProvider.createSipTrunk(CREDENTIALS, { domain: 'sip.carrier.example' })
    const callerid = put('endpoint/trunk')?.fields?.callerid ?? ''
    expect(callerid).not.toBe('')
    // Asterisk parses a number out of <...> or out of a bare numeric string.
    expect(callerid).not.toMatch(/[<>]/)
    expect(callerid).toMatch(/[A-Za-z]/)
  })

  it('writes a registration trunk with the carrier-issued credentials, and never returns the password', async () => {
    const trunk = await asteriskProvider.createSipTrunk(CREDENTIALS, {
      domain: 'sip.carrier.example',
      username: 'acct-1234',
      password: CARRIER_PASSWORD,
      inboundMatch: ['203.0.113.0/24', 'sip2.carrier.example'],
    })

    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.object)
    // Each object refers only to ones written before it.
    expect(puts).toEqual(['auth/trunk-auth', 'aor/trunk', 'endpoint/trunk', 'identify/trunk', 'registration/trunk'])
    expect(put('auth/trunk-auth')?.fields).toEqual({ auth_type: 'userpass', username: 'acct-1234', password: CARRIER_PASSWORD })
    expect(put('endpoint/trunk')?.fields).toMatchObject({
      outbound_auth: 'trunk-auth',
      from_user: 'acct-1234',
      from_domain: 'sip.carrier.example',
    })
    expect(put('identify/trunk')?.fields?.match).toBe('203.0.113.0/24,sip2.carrier.example')
    expect(put('registration/trunk')?.fields).toMatchObject({
      outbound_auth: 'trunk-auth',
      server_uri: 'sip:sip.carrier.example',
      client_uri: 'sip:acct-1234@sip.carrier.example',
      line: 'yes',
      endpoint: 'trunk',
    })
    // The password reached the PBX's auth object and nothing else.
    expect(calls.filter((c) => JSON.stringify(c.fields ?? {}).includes(CARRIER_PASSWORD)).map((c) => c.object)).toEqual(['auth/trunk-auth'])
    expect(JSON.stringify(trunk)).not.toContain(CARRIER_PASSWORD)
    expect(trunk).toEqual({ sipProvider: 'sip.carrier.example', sipUsername: 'acct-1234' })
  })

  it('treats a missing object as already removed, but stops on any other refusal', async () => {
    statusFor['DELETE registration/trunk'] = 404
    statusFor['DELETE auth/trunk-auth'] = 404
    await expect(asteriskProvider.createSipTrunk(CREDENTIALS, { domain: 'sip.carrier.example' })).resolves.toBeDefined()

    calls = []
    statusFor = { 'DELETE endpoint/trunk': 500 }
    await expect(asteriskProvider.createSipTrunk(CREDENTIALS, { domain: 'sip.carrier.example' })).rejects.toMatchObject({
      statusCode: 500,
      message: "Asterisk refused to remove the SIP trunk's endpoint",
    })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('reports which object Asterisk rejected, without the credentials in the message', async () => {
    statusFor['PUT registration/trunk'] = 400
    const err = await asteriskProvider
      .createSipTrunk(CREDENTIALS, { domain: 'sip.carrier.example', username: 'acct-1234', password: CARRIER_PASSWORD })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderApiError)
    expect((err as ProviderApiError).message).toBe("Asterisk rejected the SIP trunk's registration")
    expect((err as ProviderApiError).toSafeString()).not.toContain(CARRIER_PASSWORD)
  })

  it.each([
    [{ domain: 'sip.carrier.example', username: 'acct-1234' }, 'Set both the carrier username and password'],
    [{ domain: 'sip.carrier.example', password: CARRIER_PASSWORD }, 'Set both the carrier username and password'],
    [{ domain: 'sip:carrier.example' }, 'Carrier SIP host'],
    [{ domain: 'carrier.example\n[evil]' }, 'Carrier SIP host'],
    [{ domain: 'sip.carrier.example', username: 'a b', password: 'x' }, 'Carrier username'],
    [{ domain: 'sip.carrier.example', inboundMatch: [] }, 'Inbound addresses'],
    [{ domain: 'sip.carrier.example', inboundMatch: ['10.0.0.0/8,0.0.0.0/0'] }, 'Inbound addresses'],
  ])('refuses %j before touching the PBX', async (request, reason) => {
    const err = await asteriskProvider.createSipTrunk(CREDENTIALS, request).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderApiError)
    expect((err as ProviderApiError).statusCode).toBe(400)
    expect((err as ProviderApiError).message).toContain(reason)
    expect(calls).toHaveLength(0)
  })

  it('refuses a loopback ARI URL before touching the PBX', async () => {
    const err = await asteriskProvider
      .createSipTrunk({ ...CREDENTIALS, ariUrl: 'http://127.0.0.1:8088' }, { domain: 'sip.carrier.example' })
      .catch((e: unknown) => e)
    expect((err as ProviderApiError).statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

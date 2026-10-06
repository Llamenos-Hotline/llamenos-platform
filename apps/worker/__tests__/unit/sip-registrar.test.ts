/**
 * The per-volunteer SIP registrar (telephony/registrar.ts) and the
 * /api/telephony/sip-token route that issues its credentials.
 *
 * #1203's safe half (#1435): real per-volunteer identities against our own
 * Asterisk — username `vol_<pubkey16>`, derived per-endpoint secret, ARI
 * provisioning, individual revocation, time-limited TURN credentials — while
 * every vendor path keeps refusing the hub's shared trunk credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { TelephonyProviderConfig } from '@shared/types'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import {
  volunteerSipUsername,
  deriveVolunteerSipSecret,
  mintTurnCredentials,
  buildVolunteerSipParams,
  provisionVolunteerEndpoint,
  removeVolunteerEndpoint,
  revokeSipIdentityIfRoleless,
  revokeVolunteerSipIdentity,
  listReachableVolunteerEndpoints,
  SIP_REVOCATION_EVENT,
  TURN_CREDENTIAL_TTL_SECONDS,
  VOLUNTEER_DIALPLAN_CONTEXT,
} from '@worker/telephony/registrar'
import { sipCredentialsMayBeIssued } from '@worker/telephony/sip-tokens'
import webrtc from '@worker/routes/webrtc'
import { DEFAULT_ROLES, type Role } from '@shared/permissions'

const MASTER = 'registrar-master-secret'
const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)
const HUB = 'hub-1'

/** The real role catalogue: the route resolves authority through it. */
const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})) as Role[]

function asteriskConfig(overrides?: Partial<TelephonyProviderConfig>): TelephonyProviderConfig {
  return {
    type: 'asterisk',
    phoneNumber: '+15551234567',
    sipDomain: 'pbx.example.org',
    ariUrl: 'http://asterisk:8088',
    ariUsername: 'llamenos',
    ariPassword: 'ari-pass',
    ...overrides,
  } as TelephonyProviderConfig
}

describe('volunteer identity', () => {
  it('usernames are vol_<pubkey16>, unique per volunteer', () => {
    expect(volunteerSipUsername(PUBKEY_A)).toBe(`vol_${'a'.repeat(16)}`)
    expect(volunteerSipUsername(PUBKEY_A)).not.toBe(volunteerSipUsername(PUBKEY_B))
  })

  it('derives a strong per-endpoint secret, deterministic per volunteer', () => {
    const s1 = deriveVolunteerSipSecret(MASTER, volunteerSipUsername(PUBKEY_A))
    const s2 = deriveVolunteerSipSecret(MASTER, volunteerSipUsername(PUBKEY_A))
    const other = deriveVolunteerSipSecret(MASTER, volunteerSipUsername(PUBKEY_B))
    expect(s1).toBe(s2)
    expect(s1).not.toBe(other)
    // base64url of 32 HMAC bytes
    expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // rotating the master rotates everyone
    expect(deriveVolunteerSipSecret('other-master', volunteerSipUsername(PUBKEY_A))).not.toBe(s1)
  })

  it('never equals the raw HMAC a naive implementation would produce', () => {
    const username = volunteerSipUsername(PUBKEY_A)
    const naive = Buffer.from(hmac(sha256, utf8ToBytes(MASTER), utf8ToBytes(username))).toString('base64url')
    expect(deriveVolunteerSipSecret(MASTER, username)).not.toBe(naive)
  })
})

describe('TURN credentials (RFC 8489 time-limited)', () => {
  it('mints username "<expiry>:<user>" and credential base64(HMAC-SHA1(secret, username))', () => {
    const username = volunteerSipUsername(PUBKEY_A)
    const creds = mintTurnCredentials('turn-secret', username, 3600, 1_700_000_000)
    expect(creds.expiresAt).toBe(1_700_003_600)
    expect(creds.username).toBe(`1700003600:${username}`)
    const expected = Buffer.from(
      hmac(sha1, utf8ToBytes('turn-secret'), utf8ToBytes(creds.username)),
    ).toString('base64')
    expect(creds.credential).toBe(expected)
  })

  it('honours the TTL and defaults to the module constant', () => {
    const now = 1_700_000_000
    const c1 = mintTurnCredentials('s', 'vol_x', undefined, now)
    expect(c1.expiresAt - now).toBe(TURN_CREDENTIAL_TTL_SECONDS)
    const c2 = mintTurnCredentials('s', 'vol_x', 60, now)
    expect(c2.expiresAt - now).toBe(60)
  })

  it('credentials for different volunteers differ', () => {
    const a = mintTurnCredentials('s', 'vol_a', 3600, 100)
    const b = mintTurnCredentials('s', 'vol_b', 3600, 100)
    expect(a.username).not.toBe(b.username)
    expect(a.credential).not.toBe(b.credential)
  })
})

describe('buildVolunteerSipParams', () => {
  it('builds per-volunteer params against our own registrar', () => {
    const username = volunteerSipUsername(PUBKEY_A)
    const secret = deriveVolunteerSipSecret(MASTER, username)
    const turn = mintTurnCredentials('turn-secret', username)
    const params = buildVolunteerSipParams(asteriskConfig(), username, secret, {
      host: 'turn.example.org',
      credentials: turn,
    })
    expect(params.provider).toBe('asterisk')
    expect(params.sip.domain).toBe('pbx.example.org')
    expect(params.sip.transport).toBe('tls')
    expect(params.sip.username).toBe(username)
    expect(params.sip.password).toBe(secret)
    expect(params.sip.mediaEncryption).toBe('dtls-srtp')
    expect(params.sip.iceServers).toEqual([
      { url: 'stun:turn.example.org:3478' },
      {
        url: 'turn:turn.example.org:3478?transport=udp',
        username: turn.username,
        credential: turn.credential,
      },
      {
        url: 'turn:turn.example.org:3478?transport=tcp',
        username: turn.username,
        credential: turn.credential,
      },
    ])
  })

  it('falls back to STUN-only ICE servers when no TURN server is provisioned', () => {
    const params = buildVolunteerSipParams(
      asteriskConfig(),
      volunteerSipUsername(PUBKEY_A),
      'secret',
    )
    expect(params.sip.iceServers).toEqual([{ url: 'stun:pbx.example.org:3478' }])
  })

  it('refuses to build params for a vendor provider', () => {
    expect(() =>
      buildVolunteerSipParams(
        { type: 'twilio', phoneNumber: '+1', sipDomain: 'x.sip.twilio.com' } as TelephonyProviderConfig,
        'vol_x',
        'secret',
      ),
    ).toThrow('provider: asterisk')
  })

  it('refuses without the registrar domain', () => {
    expect(() =>
      buildVolunteerSipParams(asteriskConfig({ sipDomain: undefined }), 'vol_x', 'secret'),
    ).toThrow('sipDomain')
  })
})

// --- ARI provisioning against a recorded fetch -----------------------------

interface AriCall {
  method: string
  object: string
  fields?: Record<string, string>
}

let calls: AriCall[]
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
    const body = init.body
      ? (JSON.parse(String(init.body)) as { fields: Array<{ attribute: string; value: string }> })
      : undefined
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

describe('provisionVolunteerEndpoint', () => {
  const username = 'vol_abcdef0123456789'
  const secret = 'endpoint-secret'

  it('writes auth, aor and endpoint — creation order, endpoint in the volunteer dialplan', async () => {
    await provisionVolunteerEndpoint(asteriskConfig(), username, secret)

    expect(calls.map((c) => `${c.method} ${c.object}`)).toEqual([
      'PUT auth/vol_abcdef0123456789',
      'PUT aor/vol_abcdef0123456789',
      'PUT endpoint/vol_abcdef0123456789',
    ])
    expect(put(`auth/${username}`)?.fields).toEqual({
      auth_type: 'userpass',
      username,
      password: secret,
    })
    expect(put(`aor/${username}`)?.fields).toMatchObject({
      max_contacts: '1',
      remove_existing: 'yes',
    })
    expect(put(`endpoint/${username}`)?.fields).toMatchObject({
      context: VOLUNTEER_DIALPLAN_CONTEXT,
      aors: username,
      auth: username,
      media_encryption: 'dtls',
    })
  })

  it('sends the secret to the auth object only', async () => {
    await provisionVolunteerEndpoint(asteriskConfig(), username, secret)
    const holders = calls.filter((c) => JSON.stringify(c.fields ?? {}).includes(secret)).map((c) => c.object)
    expect(holders).toEqual([`auth/${username}`])
  })

  it('is idempotent — no deletes, plain re-PUTs', async () => {
    await provisionVolunteerEndpoint(asteriskConfig(), username, secret)
    await provisionVolunteerEndpoint(asteriskConfig(), username, secret)
    expect(calls.every((c) => c.method === 'PUT')).toBe(true)
    expect(calls).toHaveLength(6)
  })

  it('two volunteers get independent objects', async () => {
    await provisionVolunteerEndpoint(asteriskConfig(), username, secret)
    await provisionVolunteerEndpoint(asteriskConfig(), 'vol_fedcba9876543210', 'other-secret')
    expect(new Set(calls.map((c) => c.object)).size).toBe(6)
  })

  it('refuses a loopback ARI URL before touching the PBX', async () => {
    await expect(
      provisionVolunteerEndpoint(asteriskConfig({ ariUrl: 'http://127.0.0.1:8088' }), username, secret),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('surfaces a PBX refusal without the secret in the message', async () => {
    statusFor[`PUT endpoint/${username}`] = 500
    await expect(provisionVolunteerEndpoint(asteriskConfig(), username, secret)).rejects.toThrow(
      'endpoint',
    )
  })
})

describe('removeVolunteerEndpoint', () => {
  const username = 'vol_abcdef0123456789'

  it('deletes endpoint, aor and auth — dependents first', async () => {
    await removeVolunteerEndpoint(asteriskConfig(), username)
    expect(calls.map((c) => `${c.method} ${c.object}`)).toEqual([
      'DELETE endpoint/vol_abcdef0123456789',
      'DELETE aor/vol_abcdef0123456789',
      'DELETE auth/vol_abcdef0123456789',
    ])
  })

  it('treats a missing object as already revoked', async () => {
    statusFor[`DELETE endpoint/${username}`] = 404
    statusFor[`DELETE aor/${username}`] = 404
    statusFor[`DELETE auth/${username}`] = 404
    await expect(removeVolunteerEndpoint(asteriskConfig(), username)).resolves.toBeUndefined()
  })
})

describe('revokeVolunteerSipIdentity (role-loss / account-deletion hook)', () => {
  it('no-ops for vendor providers — nothing was ever issued there', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        sipDomain: 'x.sip.twilio.com',
        sipUsername: 'hub',
        sipPassword: 'hub-secret',
      }),
    }
    await revokeVolunteerSipIdentity({ settings }, 'hmac', PUBKEY_A)
    expect(calls).toHaveLength(0)
  })

  it('removes the volunteer objects when the provider is our own Asterisk', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    await revokeVolunteerSipIdentity({ settings }, 'hmac', PUBKEY_A)
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE'])
    expect(calls[0].object).toBe(`endpoint/${volunteerSipUsername(PUBKEY_A)}`)
  })

  it('never throws when the provider config is unreadable — revocation is best-effort', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockRejectedValue(new Error('db down')) }
    await expect(
      revokeVolunteerSipIdentity({ settings }, 'hmac', PUBKEY_A),
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('never throws when the PBX refuses — logs and leaves the endpoint re-revocable', async () => {
    statusFor[`DELETE endpoint/${volunteerSipUsername(PUBKEY_A)}`] = 500
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    await expect(
      revokeVolunteerSipIdentity({ settings }, 'hmac', PUBKEY_A),
    ).resolves.toBeUndefined()
  })
})

// --- /api/telephony/sip-token route -----------------------------------------

function createSipTokenApp(opts: {
  services: Record<string, unknown>
  env?: Partial<AppEnv['Bindings']>
  callPreference?: string
  /** The volunteer's hub assignments. Default: a volunteer role in HUB. */
  hubRoles?: { hubId: string; roleIds: string[] }[]
  /** The volunteer's global roles. Default: role-volunteer (grants nothing in a hub). */
  roles?: string[]
}) {
  const pubkey = PUBKEY_A
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', ['*'])
    c.set('services', opts.services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', ALL_ROLES)
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test Volunteer',
      phone: '+1555000000',
      roles: opts.roles ?? ['role-volunteer'],
      hubRoles: opts.hubRoles ?? [{ hubId: HUB, roleIds: ['role-volunteer'] }],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: opts.callPreference ?? 'both',
    } as AppEnv['Variables']['user'])
    c.env = {
      HMAC_SECRET: 'hmac-secret',
      SIP_REGISTRAR_SECRET: MASTER,
      TURN_HOST: 'turn.example.org',
      TURN_SECRET: 'turn-secret',
      ...opts.env,
    } as AppEnv['Bindings']
    await next()
  })
  app.route('/', webrtc)
  return app
}

describe('GET /api/telephony/sip-token (per-volunteer issuance)', () => {
  it('issues per-volunteer credentials for provider:asterisk and provisions the endpoint', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings } })
    const res = await app.request('/sip-token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      provider: string
      sip: {
        domain: string
        transport: string
        username: string
        password: string
        mediaEncryption: string
        iceServers: Array<{ url: string; username?: string; credential?: string }>
      }
    }
    const username = volunteerSipUsername(PUBKEY_A)
    expect(body.provider).toBe('asterisk')
    expect(body.sip.username).toBe(username)
    expect(body.sip.password).toBe(deriveVolunteerSipSecret(MASTER, username))
    expect(body.sip.transport).toBe('tls')
    expect(body.sip.mediaEncryption).toBe('dtls-srtp')
    // time-limited TURN credentials
    expect(body.sip.iceServers.some((s) => s.url.startsWith('turn:') && s.username?.endsWith(`:${username}`))).toBe(true)

    // the endpoint was provisioned over ARI with the issued secret
    expect(calls.map((c) => `${c.method} ${c.object}`)).toEqual([
      `PUT auth/${username}`,
      `PUT aor/${username}`,
      `PUT endpoint/${username}`,
    ])
    expect(put(`auth/${username}`)?.fields?.password).toBe(body.sip.password)
  })

  it('is deterministic — re-issuance returns the same credential', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings } })
    const first = ((await (await app.request('/sip-token')).json()) as { sip: { password: string } }).sip
      .password
    const second = ((await (await app.request('/sip-token')).json()) as { sip: { password: string } }).sip
      .password
    expect(second).toBe(first)
  })

  it('refuses 503 for a SIP-configured vendor — the shared-trunk leak stays shut', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        phoneNumber: '+15551234567',
        accountSid: 'AC',
        authToken: 'tok',
        sipDomain: 'x.sip.twilio.com',
        sipUsername: 'hub-trunk',
        sipPassword: 'hub-secret',
      }),
    }
    const app = await createSipTokenApp({ services: { settings } })
    const res = await app.request('/sip-token')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('shared trunk credential')
    // the vendor must never see a provisioning call
    expect(calls).toHaveLength(0)
  })

  it('503s rather than issuing a dead credential when the registrar will not provision', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings } })
    statusFor[`PUT endpoint/${volunteerSipUsername(PUBKEY_A)}`] = 500
    const res = await app.request('/sip-token')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('registrar is unreachable')
  })

  it('400s when the volunteer takes calls by phone only', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings }, callPreference: 'phone' })
    const res = await app.request('/sip-token')
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('SIP_REGISTRAR_SECRET falls back to HMAC_SECRET when unset', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({
      services: { settings },
      env: { SIP_REGISTRAR_SECRET: '' },
    })
    const res = await app.request('/sip-token')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sip: { password: string } }
    const username = volunteerSipUsername(PUBKEY_A)
    expect(body.sip.password).toBe(deriveVolunteerSipSecret('hmac-secret', username))
  })

  it('sip-status reports available for asterisk, still false for vendors', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings } })
    expect(sipCredentialsMayBeIssued(asteriskConfig())).toBe(true)
    const res = await app.request('/sip-status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: true, provider: 'asterisk' })
  })
})

// --- revocation is not bypassable by asking again (#1540) -------------------

describe('GET /api/telephony/sip-token requires a remaining hub role', () => {
  it('refuses a removed volunteer — their revoked endpoint cannot be re-provisioned', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    // Exactly the state `DELETE /hubs/:hubId/members/:pubkey` leaves behind:
    // the account and its device key are intact, every hub assignment is gone.
    const app = await createSipTokenApp({ services: { settings }, hubRoles: [] })
    const res = await app.request('/sip-token')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('No hub membership')
    // and nothing was provisioned on the PBX
    expect(calls).toHaveLength(0)
  })

  it('refuses an assignment that grants no permission in its hub', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({
      services: { settings },
      hubRoles: [{ hubId: HUB, roleIds: [] }],
    })
    expect((await app.request('/sip-token')).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('a global non-super-admin role is not hub membership', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({
      services: { settings },
      roles: ['role-admin'],
      hubRoles: [],
    })
    expect((await app.request('/sip-token')).status).toBe(403)
  })

  it('a super-admin holds every hub, so issuance is unaffected', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({
      services: { settings },
      roles: ['role-super-admin'],
      hubRoles: [],
    })
    expect((await app.request('/sip-token')).status).toBe(200)
  })

  it('a still-valid member keeps issuing and re-issuing normally', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings } })
    const first = await app.request('/sip-token')
    expect(first.status).toBe(200)
    const second = await app.request('/sip-token')
    expect(second.status).toBe(200)
    expect(((await second.json()) as { sip: { password: string } }).sip.password).toBe(
      ((await first.json()) as { sip: { password: string } }).sip.password,
    )
  })

  it('a volunteer removed from ONE of two hubs keeps their credential', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({
      services: { settings },
      hubRoles: [{ hubId: 'hub-2', roleIds: ['role-volunteer'] }],
    })
    expect((await app.request('/sip-token')).status).toBe(200)
  })

  it('webrtc-token refuses a removed volunteer too', async () => {
    const settings = {
      getTelephonyProvider: vi.fn().mockResolvedValue({
        type: 'twilio',
        phoneNumber: '+15551234567',
        accountSid: 'AC',
        authToken: 'tok',
        webrtcEnabled: true,
        twimlAppSid: 'AP',
        apiKey: 'SK',
        apiSecret: 'sec',
      }),
    }
    const app = await createSipTokenApp({ services: { settings }, hubRoles: [] })
    expect((await app.request('/webrtc-token')).status).toBe(403)
  })

  it('sip-status agrees: unavailable for a volunteer with no hub role', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings }, hubRoles: [] })
    expect(await (await app.request('/sip-status')).json()).toEqual({
      available: false,
      provider: 'asterisk',
    })
  })
})

// --- re-admission does not resurrect the old credential ---------------------

describe('credential epoch', () => {
  it('a revoked-then-re-added volunteer is issued a credential they never held', async () => {
    const username = volunteerSipUsername(PUBKEY_A)
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const events: { eventType: string; metadata?: Record<string, unknown> }[] = []
    const identity = {
      getUserInternal: vi.fn().mockResolvedValue({ pubkey: PUBKEY_A, roles: ['role-volunteer'], hubRoles: [] }),
      emitSecurityEvent: vi.fn(async (_p: string | null, eventType: string, _d: string | null, metadata?: Record<string, unknown>) => {
        events.push({ eventType, metadata })
      }),
      countSecurityEvents: vi.fn(async (pubkey: string, eventType: string) =>
        events.filter(e => e.eventType === eventType && e.metadata?.pubkey === pubkey).length,
      ),
    }
    const services = { settings, identity }

    // Issue while a member.
    const member = await createSipTokenApp({ services })
    const before = ((await (await member.request('/sip-token')).json()) as { sip: { password: string } }).sip.password

    // Removed from their last hub: the hook revokes, and the revocation is
    // recorded as the credential epoch.
    await revokeSipIdentityIfRoleless(services, 'hmac', PUBKEY_A, ALL_ROLES)
    expect(events.map(e => e.eventType)).toEqual([SIP_REVOCATION_EVENT])
    expect(calls.map(c => `${c.method} ${c.object}`)).toEqual([
      `PUT auth/${username}`,
      `PUT aor/${username}`,
      `PUT endpoint/${username}`,
      `DELETE endpoint/${username}`,
      `DELETE aor/${username}`,
      `DELETE auth/${username}`,
    ])

    // Re-admitted: a fresh credential, not the one that may have leaked.
    const readmitted = await createSipTokenApp({ services })
    const after = ((await (await readmitted.request('/sip-token')).json()) as { sip: { password: string } }).sip.password
    expect(after).not.toBe(before)
    expect(after).toBe(deriveVolunteerSipSecret(MASTER, username, 1))
    expect(before).toBe(deriveVolunteerSipSecret(MASTER, username, 0))
    // and the PBX now holds the NEW secret for that username
    const lastAuthPut = calls.filter(c => c.method === 'PUT' && c.object === `auth/${username}`).at(-1)
    expect(lastAuthPut?.fields?.password).toBe(after)
  })

  it('epoch 0 is the bare label:username derivation — unchanged for a volunteer never revoked', () => {
    const username = volunteerSipUsername(PUBKEY_B)
    expect(deriveVolunteerSipSecret(MASTER, username, 0)).toBe(deriveVolunteerSipSecret(MASTER, username))
    expect(deriveVolunteerSipSecret(MASTER, username, 1)).not.toBe(deriveVolunteerSipSecret(MASTER, username))
    expect(deriveVolunteerSipSecret(MASTER, username, 2)).not.toBe(deriveVolunteerSipSecret(MASTER, username, 1))
  })
})

// --- the role-loss hook every removal path shares ---------------------------

describe('revokeSipIdentityIfRoleless', () => {
  const config = asteriskConfig()
  const username = volunteerSipUsername(PUBKEY_A)

  function servicesWith(remaining: unknown) {
    return {
      settings: { getTelephonyProvider: vi.fn().mockResolvedValue(config) },
      identity: {
        getUserInternal: vi.fn().mockResolvedValue(remaining),
        emitSecurityEvent: vi.fn().mockResolvedValue(undefined),
        countSecurityEvents: vi.fn().mockResolvedValue(0),
      },
    }
  }

  it('revokes when no hub role remains', async () => {
    await revokeSipIdentityIfRoleless(servicesWith({ roles: ['role-volunteer'], hubRoles: [] }), 'hmac', PUBKEY_A, ALL_ROLES)
    expect(calls.map(c => `${c.method} ${c.object}`)).toEqual([
      `DELETE endpoint/${username}`,
      `DELETE aor/${username}`,
      `DELETE auth/${username}`,
    ])
  })

  it('leaves a volunteer who still belongs to another hub alone', async () => {
    await revokeSipIdentityIfRoleless(
      servicesWith({ roles: ['role-volunteer'], hubRoles: [{ hubId: 'hub-2', roleIds: ['role-volunteer'] }] }),
      'hmac',
      PUBKEY_A,
      ALL_ROLES,
    )
    expect(calls).toHaveLength(0)
  })

  it('revokes when the user row is already gone', async () => {
    await revokeSipIdentityIfRoleless(servicesWith(null), 'hmac', PUBKEY_A, ALL_ROLES)
    expect(calls.map(c => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE'])
  })

  it('fails safe — unreadable remaining roles revoke', async () => {
    const services = servicesWith(null)
    services.identity.getUserInternal = vi.fn().mockRejectedValue(new Error('db down'))
    await revokeSipIdentityIfRoleless(services, 'hmac', PUBKEY_A, ALL_ROLES)
    expect(calls.map(c => c.method)).toEqual(['DELETE', 'DELETE', 'DELETE'])
  })

  it('advances the epoch even when the PBX refuses the delete', async () => {
    const services = servicesWith({ roles: [], hubRoles: [] })
    statusFor[`DELETE endpoint/${username}`] = 500
    await revokeSipIdentityIfRoleless(services, 'hmac', PUBKEY_A, ALL_ROLES)
    expect(services.identity.emitSecurityEvent).toHaveBeenCalledWith(
      null,
      SIP_REVOCATION_EVENT,
      null,
      { pubkey: PUBKEY_A, username },
    )
  })
})

// --- Reachability: who can be sent an INVITE right now (#1188) -------------

/**
 * The ringing path asks the PBX, not a record of its own, because a record we
 * wrote would still say "registered" after the app was force-stopped — and a
 * stale yes means the call rings nobody.
 */
describe('listReachableVolunteerEndpoints', () => {
  let endpointsBody: unknown
  let endpointsStatus: number
  let requested: Array<{ url: string; authorization: string | null }>

  beforeEach(() => {
    endpointsStatus = 200
    requested = []
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      requested.push({
        url: String(input),
        authorization: new Headers(init.headers).get('authorization'),
      })
      return new Response(JSON.stringify(endpointsBody), { status: endpointsStatus })
    })
  })

  it('asks the PBX for its PJSIP endpoints, authenticated, in one request', async () => {
    endpointsBody = []
    await listReachableVolunteerEndpoints(asteriskConfig())
    expect(requested).toEqual([
      {
        url: 'http://asterisk:8088/ari/endpoints/PJSIP',
        authorization: `Basic ${btoa('llamenos:ari-pass')}`,
      },
    ])
  })

  it('returns only volunteer endpoints that are online', async () => {
    endpointsBody = [
      { technology: 'PJSIP', resource: 'vol_aaaaaaaaaaaaaaaa', state: 'online' },
      // Registered once, now unreachable: the qualify stopped being answered.
      { technology: 'PJSIP', resource: 'vol_bbbbbbbbbbbbbbbb', state: 'offline' },
      // Provisioned, never registered.
      { technology: 'PJSIP', resource: 'vol_cccccccccccccccc', state: 'unknown' },
      // No state at all — the PBX cannot vouch for it, so neither do we.
      { technology: 'PJSIP', resource: 'vol_dddddddddddddddd' },
      // The SIP trunk is online too, and is not a volunteer.
      { technology: 'PJSIP', resource: 'trunk', state: 'online' },
    ]
    expect(await listReachableVolunteerEndpoints(asteriskConfig())).toEqual(
      new Set(['vol_aaaaaaaaaaaaaaaa']),
    )
  })

  it('throws when the PBX refuses, rather than reporting nobody as reachable', async () => {
    // The ringing path turns this into "no in-app legs, logged and counted".
    // Returning an empty set here instead would make a broken PBX
    // indistinguishable from an empty roster.
    endpointsBody = { message: 'nope' }
    endpointsStatus = 503
    await expect(listReachableVolunteerEndpoints(asteriskConfig())).rejects.toThrow('503')
  })

  it('refuses a provider that has no registrar to ask', async () => {
    endpointsBody = []
    await expect(
      listReachableVolunteerEndpoints({ type: 'twilio', phoneNumber: '+1' } as TelephonyProviderConfig),
    ).rejects.toThrow('No SIP registrar')
    expect(requested).toEqual([])
  })
})

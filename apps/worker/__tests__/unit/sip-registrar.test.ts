/**
 * The per-volunteer SIP registrar (telephony/registrar.ts) and the
 * /api/telephony/sip-token route that issues its credentials.
 *
 * #1203's safe half (#1435): real per-volunteer identities against our own
 * Asterisk — username `vol_<pubkey16>`, derived per-endpoint secret, ARI
 * provisioning, individual revocation, time-limited TURN credentials — while
 * every vendor path keeps refusing the hub's shared trunk credential.
 */
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  revokeVolunteerSipIdentity,
  readSipTlsTrustAnchor,
  TURN_CREDENTIAL_TTL_SECONDS,
  VOLUNTEER_DIALPLAN_CONTEXT,
} from '@worker/telephony/registrar'
import { sipCredentialsMayBeIssued } from '@worker/telephony/sip-tokens'
import webrtc from '@worker/routes/webrtc'

const MASTER = 'registrar-master-secret'
const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)

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
    const creds = mintTurnCredentials('turn-secret', 'vol_abcdef0123456789', 3600, 1_700_000_000)
    expect(creds.expiresAt).toBe(1_700_003_600)
    expect(creds.username).toBe('1700003600:vol_abcdef0123456789')
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

/**
 * The SIP edge's TLS trust anchor.
 *
 * Registration is over TLS (`transport: 'tls'`), and a self-hoster has no publicly-trusted
 * certificate for their PBX — which is why Android's registration failed with
 * `tlsv1 alert unknown ca` (#1188). Turning verification off was never an option on a leg that
 * carries a crisis call, so the anchor is published HERE: inside an authenticated response that
 * already travelled over the app's certificate-pinned HTTPS channel. PBX trust then derives
 * from the API pin, with no trust-on-first-use step.
 */
describe('SIP TLS trust anchor', () => {
  const CERT_A = ['-----BEGIN CERTIFICATE-----', 'QUFB', '-----END CERTIFICATE-----'].join('\n')
  const CERT_B = ['-----BEGIN CERTIFICATE-----', 'QkJC', '-----END CERTIFICATE-----'].join('\n')
  const KEY = ['-----BEGIN PRIVATE KEY-----', 'c2VjcmV0', '-----END PRIVATE KEY-----'].join('\n')

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sip-anchor-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, content: string) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }

  it('reads the anchor from the file the SIP edge wrote', () => {
    const path = write('anchor.pem', `${CERT_A}\n`)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBe(`${CERT_A}\n`)
  })

  it('prefers an inline anchor over the file', () => {
    const path = write('anchor.pem', `${CERT_A}\n`)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path, SIP_TLS_CA_PEM: `${CERT_B}\n` })).toBe(
      `${CERT_B}\n`,
    )
  })

  it('keeps a full chain, so a renewed leaf under the same root keeps verifying', () => {
    const path = write('chain.pem', `${CERT_A}\n${CERT_B}\n`)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBe(`${CERT_A}\n${CERT_B}\n`)
  })

  it('publishes certificates only when pointed at a keypair', () => {
    // Asterisk's own cert_file IS a combined certificate+key PEM. Pointing the app at it is an
    // operator error that must not become a key disclosure, so the extraction is safe by
    // construction rather than by rejection.
    const path = write('keypair.pem', `${KEY}\n${CERT_A}\n`)
    const anchor = readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })
    expect(anchor).toBe(`${CERT_A}\n`)
    expect(anchor).not.toContain('PRIVATE KEY')
  })

  it('publishes nothing for a file holding no certificate', () => {
    const path = write('empty.pem', 'not a pem\n')
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBeUndefined()
  })

  it('publishes nothing when no anchor is configured — the device trust store applies', () => {
    expect(readSipTlsTrustAnchor({})).toBeUndefined()
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: '' })).toBeUndefined()
  })

  it('publishes nothing when the edge has not written the file yet', () => {
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: join(dir, 'absent.pem') })).toBeUndefined()
  })

  it('refuses an implausibly large file rather than shipping it to clients', () => {
    const path = write('huge.pem', `${CERT_A}\n${'#'.repeat(64 * 1024)}`)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBeUndefined()
  })

  it('picks up a regenerated certificate without an app restart', () => {
    const path = write('anchor.pem', `${CERT_A}\n`)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBe(`${CERT_A}\n`)
    writeFileSync(path, `${CERT_B}\n`)
    // Same size, so only the mtime distinguishes them — bump it explicitly rather than relying
    // on filesystem timestamp granularity.
    const later = new Date(Date.now() + 5_000)
    utimesSync(path, later, later)
    expect(readSipTlsTrustAnchor({ SIP_TLS_CA_FILE: path })).toBe(`${CERT_B}\n`)
  })

  it('rides along in the issued params when published, and is absent when not', () => {
    const withAnchor = buildVolunteerSipParams(
      asteriskConfig(),
      'vol_x',
      'secret',
      undefined,
      `${CERT_A}\n`,
    )
    expect(withAnchor.sip.tlsTrustAnchorPem).toBe(`${CERT_A}\n`)
    const without = buildVolunteerSipParams(asteriskConfig(), 'vol_x', 'secret')
    expect('tlsTrustAnchorPem' in without.sip).toBe(false)
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
      // Without this Asterisk discards the candidates the client gathered from
      // the issued ICE servers, which is half the #1188 ICE defect.
      ice_support: 'yes',
      rtp_symmetric: 'yes',
      // And without these, media_encryption:dtls is inert — Asterisk answers
      // with an empty a=fingerprint and every handshake fails.
      dtls_auto_generate_cert: 'yes',
      dtls_verify: 'fingerprint',
      // passive: the volunteer's client initiates the handshake, outbound
      // through its own NAT. See the comment at the call site.
      dtls_setup: 'passive',
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
}) {
  const pubkey = PUBKEY_A
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', ['*'])
    c.set('services', opts.services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test Volunteer',
      phone: '+1555000000',
      roles: ['role-volunteer'],
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

  it('hands the client the SIP edge trust anchor so the TLS chain can be verified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sip-anchor-route-'))
    try {
      const pem = `${['-----BEGIN CERTIFICATE-----', 'Um91dGU=', '-----END CERTIFICATE-----'].join('\n')}\n`
      const path = join(dir, 'edge.pem')
      writeFileSync(path, pem)
      const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
      const app = await createSipTokenApp({ services: { settings }, env: { SIP_TLS_CA_FILE: path } })
      const res = await app.request('/sip-token')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sip: { transport: string; tlsTrustAnchorPem?: string } }
      // Registration is over TLS and this is the only thing the client will verify it against.
      expect(body.sip.transport).toBe('tls')
      expect(body.sip.tlsTrustAnchorPem).toBe(pem)
      expect(body.sip.tlsTrustAnchorPem).not.toContain('PRIVATE KEY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omits the anchor when the deployment publishes none', async () => {
    const settings = { getTelephonyProvider: vi.fn().mockResolvedValue(asteriskConfig()) }
    const app = await createSipTokenApp({ services: { settings }, env: { SIP_TLS_CA_FILE: '' } })
    const body = (await (await app.request('/sip-token')).json()) as { sip: Record<string, unknown> }
    expect('tlsTrustAnchorPem' in body.sip).toBe(false)
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

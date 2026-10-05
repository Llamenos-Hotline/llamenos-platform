/**
 * End-to-end: the per-volunteer SIP registrar.
 *
 *   volunteer ──GET /api/telephony/sip-token──▶ worker
 *     worker ──ARI dynamic config──▶ Asterisk: PUT auth/aor/endpoint vol_<pubkey16>
 *     worker ◀── per-volunteer credential + time-limited TURN credentials
 *   volunteer (this test) ──REGISTER over TCP──▶ Asterisk ──401 challenge──▶
 *     digest answer ──200 OK──▶ the endpoint is LIVE on the PBX
 *   admin ──DELETE /api/users/:pubkey──▶ worker ──ARI delete──▶ Asterisk
 *     re-REGISTER with the same (still derivable) credential ──401──▶ revoked
 *
 * This is the safe half of #1435 made real: /sip-token issues a REAL
 * per-volunteer identity against the PBX we run — not the hub's shared trunk
 * credential at a vendor. Provisioning goes through the same ARI dynamic
 * config path as the SIP trunk (#1327), so a green run here means the trunk
 * machinery and the registrar machinery agree with the live PBX.
 *
 * Run with run-register-e2e.sh (it starts the app and the PBX stack).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  apiDelete,
  apiGet,
  apiPost,
  createUserViaApi,
  updateUserViaApi,
} from '../../../../tests/api-helpers'
import { registerOverTcp } from './sip-register'

/** The PBX's SIP port, published on the host by docker-compose.dev.yml */
const PBX_HOST = process.env.E2E_PBX_HOST ?? '127.0.0.1'
const PBX_PORT = Number(process.env.E2E_PBX_PORT ?? 5060)
/** ARI as the host reaches it (published by the dev compose) */
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
/** The registrar's public SIP domain, as an operator would configure it */
const REGISTRAR_DOMAIN = process.env.E2E_REGISTRAR_DOMAIN ?? '127.0.0.1'
/** CoTURN's static-auth secret, so the test can verify the minted TURN credential */
const TURN_SECRET = process.env.E2E_TURN_SECRET ?? ''
const TURN_HOST = process.env.E2E_TURN_HOST ?? ''

const WORKER_ARI_URL = process.env.E2E_WORKER_ARI_URL ?? 'http://asterisk:8088'
const WORKER_BRIDGE_URL = process.env.E2E_WORKER_BRIDGE_URL ?? 'http://sip-bridge:3000'
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? ''

interface SipTokenResponse {
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

/** ARI as the app reaches it — its name on the compose network */
async function ariConfigObject(type: string, id: string): Promise<Response> {
  const url = `${ARI_REST_URL}/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`
  return fetch(url, { headers: { Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}` } })
}

async function configureAsteriskProvider(request: APIRequestContext): Promise<void> {
  const res = await apiPost(request, '/provider-setup/configure', {
    provider: 'asterisk',
    phoneNumber: '+15550155555',
    credentials: {
      ariUrl: WORKER_ARI_URL,
      ariUsername: ARI_USERNAME,
      ariPassword: ARI_PASSWORD,
      bridgeCallbackUrl: WORKER_BRIDGE_URL,
      bridgeSecret: BRIDGE_SECRET,
      // The public SIP domain clients REGISTER against — the hotline's
      // edge host in production; the published PBX port's host here.
      sipDomain: REGISTRAR_DOMAIN,
    },
  })
  expect(res.status, JSON.stringify(res.data)).toBe(200)
}

test('a volunteer SIP identity registers against the PBX, and deletion revokes it', async ({ request }) => {
  await configureAsteriskProvider(request)

  const volunteer = await createUserViaApi(request, { name: 'Registrar E2E Volunteer' })
  await updateUserViaApi(request, volunteer.pubkey, { callPreference: 'both' })

  // The gate agrees before any client asks: SIP is available for asterisk.
  const status = await apiGet<{ available: boolean; provider: string }>(
    request,
    '/telephony/sip-status',
    volunteer.seedHex,
  )
  expect(status.status).toBe(200)
  expect(status.data).toEqual({ available: true, provider: 'asterisk' })

  // /sip-token issues a REAL per-volunteer credential.
  const token = await apiGet<SipTokenResponse>(request, '/telephony/sip-token', volunteer.seedHex)
  expect(token.status, JSON.stringify(token.data)).toBe(200)
  const { sip } = token.data
  const expectedUsername = `vol_${volunteer.pubkey.slice(0, 16)}`
  expect(token.data.provider).toBe('asterisk')
  expect(sip.username).toBe(expectedUsername)
  expect(sip.domain).toBe(REGISTRAR_DOMAIN)
  expect(sip.transport).toBe('tls')
  expect(sip.password.length).toBeGreaterThanOrEqual(32)
  // A credential that is not the hub's: ARI's and the bridge's secrets must
  // not be what the client got.
  expect(sip.password).not.toBe(ARI_PASSWORD)
  expect(sip.password).not.toBe(BRIDGE_SECRET)

  // Time-limited TURN credentials (RFC 8489 long-term credential scheme):
  // username "<expiry>:<vol_…>", credential base64(HMAC-SHA1(TURN_SECRET, username)).
  if (TURN_SECRET && TURN_HOST) {
    const turn = sip.iceServers.filter((s) => s.url.startsWith('turn:'))
    expect(turn.length).toBeGreaterThan(0)
    expect(turn.every((s) => s.url.startsWith(`turn:${TURN_HOST}:3478`))).toBe(true)
    const first = turn[0]
    expect(first.username).toMatch(new RegExp(`^\\d+:${expectedUsername}$`))
    // credential = base64(HMAC-SHA1(TURN_SECRET, username)) — RFC 8489
    // time-limited credentials, verifiable against the shared secret here.
    // HMAC-SHA1 is what RFC 8489 §9.2 (and coturn) mandate for TURN
    // long-term credentials; it is not a choice this test can upgrade.
    // codeql[js/weak-cryptographic-algorithm]
    const expectedCredential = createHmac('sha1', TURN_SECRET).update(first.username ?? '').digest('base64')
    expect(timingSafeEqualString(first.credential ?? '', expectedCredential)).toBe(true)
  } else {
    // No relay wired in this stack: STUN-only, no credential material.
    expect(sip.iceServers.every((s) => s.url.startsWith('stun:'))).toBe(true)
  }

  // The endpoint exists on the PBX through ARI — the same store as the trunk.
  for (const type of ['auth', 'aor', 'endpoint']) {
    const res = await ariConfigObject(type, expectedUsername)
    expect(res.status, `ARI ${type}/${expectedUsername}`).toBe(200)
  }

  // The credential actually registers against the PBX: challenge, digest, 200.
  const registered = await registerOverTcp({
    host: PBX_HOST,
    port: PBX_PORT,
    domain: REGISTRAR_DOMAIN,
    username: sip.username,
    password: sip.password,
  })
  expect(registered.status, `REGISTER: ${registered.reason}`).toBe(200)

  // The wrong password does not.
  const wrong = await registerOverTcp({
    host: PBX_HOST,
    port: PBX_PORT,
    domain: REGISTRAR_DOMAIN,
    username: sip.username,
    password: 'definitely-not-the-issued-secret',
  })
  expect(wrong.status).toBe(401)

  // Re-issuance is idempotent: the same credential, still registering.
  const reissued = await apiGet<SipTokenResponse>(request, '/telephony/sip-token', volunteer.seedHex)
  expect(reissued.status).toBe(200)
  expect(reissued.data.sip.password).toBe(sip.password)
  const reregistered = await registerOverTcp({
    host: PBX_HOST,
    port: PBX_PORT,
    domain: REGISTRAR_DOMAIN,
    username: sip.username,
    password: sip.password,
  })
  expect(reregistered.status, `re-REGISTER: ${reregistered.reason}`).toBe(200)

  // Revocation: deleting the volunteer removes the PJSIP objects, and the
  // still-derivable secret authenticates nothing afterwards.
  const del = await apiDelete(request, `/users/${volunteer.pubkey}`)
  expect(del.status).toBe(200)
  for (const type of ['auth', 'aor', 'endpoint']) {
    const res = await ariConfigObject(type, expectedUsername)
    expect(res.status, `ARI ${type}/${expectedUsername} after revocation`).toBe(404)
  }
  const afterRevoke = await registerOverTcp({
    host: PBX_HOST,
    port: PBX_PORT,
    domain: REGISTRAR_DOMAIN,
    username: sip.username,
    password: sip.password,
  })
  expect(afterRevoke.status).toBe(401)
})

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

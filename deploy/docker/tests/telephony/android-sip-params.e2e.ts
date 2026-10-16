/**
 * Step 1 of the Android SIP transport e2e (run-android-sip-e2e.sh): issue a
 * real per-volunteer credential and write it where the instrumented test can
 * read it.
 *
 * Nothing here is a stand-in. The provider is configured through the route an
 * operator uses, a volunteer is enrolled through the API, and the credential
 * comes from `/api/telephony/sip-token`, which provisions the PJSIP endpoint
 * on the live PBX as a side effect. Step 2 then hands these exact values to
 * the production `LinphoneService` on an emulator, and the proof is Asterisk's
 * own log.
 *
 * The assertions here are the server half of #1188's three defects:
 *   * `transport: 'tls'` — the transport whose trust story was missing.
 *   * `mediaEncryption: 'dtls-srtp'` — what the PJSIP endpoint is actually
 *     provisioned for, so a client hardcoding SRTP cannot negotiate with it.
 *   * TURN ICE servers — which the client parsed and threw away.
 * Plus `tlsTrustAnchorPem`, which is what makes TLS verifiable at all for a
 * self-hoster.
 */
import { writeFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiGet, apiPost, createUserViaApi, updateUserViaApi } from '../../../../tests/api-helpers'

const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
const WORKER_ARI_URL = process.env.E2E_WORKER_ARI_URL ?? 'http://asterisk:8088'
const WORKER_BRIDGE_URL = process.env.E2E_WORKER_BRIDGE_URL ?? 'http://sip-bridge:3000'
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? ''

/**
 * The SIP domain the EMULATOR will dial. 10.0.2.2 is its alias for the host,
 * and Asterisk's TLS port is published there — so this must also be a SAN on
 * the PBX certificate (SIP_TLS_SANS), because the client verifies the hostname
 * as well as the chain.
 */
const REGISTRAR_DOMAIN = process.env.E2E_REGISTRAR_DOMAIN ?? '10.0.2.2'

const PARAMS_FILE = process.env.E2E_SIP_PARAMS_FILE ?? '/tmp/android-sip-params.json'

interface SipTokenResponse {
  provider: string
  sip: {
    domain: string
    transport: string
    username: string
    password: string
    mediaEncryption: string
    iceServers: Array<{ url: string; username?: string; credential?: string }>
    tlsTrustAnchorPem?: string
  }
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
      sipDomain: REGISTRAR_DOMAIN,
    },
  })
  expect(res.status, 'Asterisk provider configuration succeeds').toBe(200)
}

test('issues a TLS credential with a trust anchor, DTLS-SRTP and TURN ICE servers', async ({ request }) => {
  await configureAsteriskProvider(request)

  const volunteer = await createUserViaApi(request, { name: 'Android SIP E2E Volunteer' })
  await updateUserViaApi(request, volunteer.pubkey, { callPreference: 'both' })

  const token = await apiGet<SipTokenResponse>(request, '/telephony/sip-token', volunteer.seedHex)
  expect(token.status, 'the volunteer SIP token is issued').toBe(200)
  const { sip } = token.data

  expect(sip.username).toBe(`vol_${volunteer.pubkey.slice(0, 16)}`)
  expect(sip.domain).toBe(REGISTRAR_DOMAIN)

  // (1) TLS, with something the client can verify the chain against.
  expect(sip.transport).toBe('tls')
  expect(sip.tlsTrustAnchorPem).toContain('-----BEGIN CERTIFICATE-----')
  expect(sip.tlsTrustAnchorPem).not.toContain('PRIVATE KEY')

  // (2) The encryption the endpoint is provisioned for — not SRTP.
  expect(sip.mediaEncryption).toBe('dtls-srtp')

  // (3) A relay, with a time-limited credential.
  const turn = sip.iceServers.filter((s) => s.url.startsWith('turn:'))
  expect(turn.length).toBeGreaterThan(0)
  expect(turn.every((s) => Boolean(s.username && s.credential))).toBe(true)
  expect(sip.iceServers.some((s) => s.url.startsWith('stun:'))).toBe(true)

  writeFileSync(PARAMS_FILE, JSON.stringify(sip, null, 2))
})

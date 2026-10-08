/**
 * End-to-end: the client-facing SIP edge is actually UP (#1688).
 *
 * This spec exists because the edge once "looked configured" on every host
 * while never having started: six fatal defects in kamailio.cfg kept the
 * daemon from booting, and nothing anywhere asserted a bound listener — the
 * only test asserted the compose file CONTAINED certain strings, which a
 * dead edge satisfies. Every call measurement in that window bypassed the
 * edge and registered straight to the PBX.
 *
 * So this spec asserts the thing that matters, and nothing about file text:
 *
 *   1. the Kamailio container is running, has never restarted, and answers
 *      on its management socket (kamcmd core.version) — "starting and
 *      STAYING up", not "the container exists";
 *   2. all three client-facing listeners are bound AND serving: a SIP
 *      OPTIONS over UDP 5060, TCP 5060 and TLS 5061 each gets a 200 from
 *      Kamailio itself (the TLS handshake is verified against the published
 *      trust anchor — verification is never switched off);
 *   3. a real SIP client registers through the edge: a credential is
 *      provisioned on the PBX over ARI (the same dynamic-config mechanism
 *      the worker's registrar uses), a REGISTER over verified TLS gets the
 *      401 challenge and then 200 OK — and a wrong password gets 401, so
 *      the 200 is the registrar's answer through the relay, not the edge
 *      waving everything through.
 *
 * Run with run-register-e2e.sh, which boots the stack and exports the
 * E2E_SIP_EDGE_* / E2E_ARI_REST_URL environment below.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { probeOptions, registerOverTls } from './sip-register'

const SIP_EDGE_HOST = process.env.E2E_SIP_EDGE_HOST ?? '127.0.0.1'
const SIP_EDGE_PORT = Number(process.env.E2E_SIP_EDGE_PORT ?? 5060)
const SIP_EDGE_TLS_PORT = Number(process.env.E2E_SIP_EDGE_TLS_PORT ?? 5061)
const KAMAILIO_CONTAINER = process.env.E2E_KAMAILIO_CONTAINER ?? 'll-telephony-register-e2e-kamailio-1'
const ARI_REST_URL = process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari'
const ARI_USERNAME = process.env.ARI_USERNAME ?? 'llamenos'
const ARI_PASSWORD = process.env.ARI_PASSWORD ?? ''
const REGISTRAR_DOMAIN = process.env.E2E_REGISTRAR_DOMAIN ?? '127.0.0.1'

function kamailioInspect(format: string): string {
  return execFileSync('docker', ['inspect', '-f', format, KAMAILIO_CONTAINER], { encoding: 'utf8' }).trim()
}

function sipEdgeTrustAnchor(): string {
  const pem = execFileSync(
    'docker',
    ['exec', KAMAILIO_CONTAINER, 'cat', '/var/lib/llamenos/sip-tls/kamailio.pem'],
    { encoding: 'utf8' },
  )
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('Kamailio did not publish a certificate-only SIP TLS trust anchor')
  }
  return pem
}

/** ARI dynamic config — the same res_pjsip store the worker's registrar writes. */
async function ariConfigObject(
  method: 'GET' | 'PUT' | 'DELETE',
  type: string,
  id: string,
  fields?: Record<string, string>,
): Promise<Response> {
  const url = `${ARI_REST_URL}/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`
  return fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${ARI_USERNAME}:${ARI_PASSWORD}`)}`,
      ...(fields ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(fields ? { body: JSON.stringify({ fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value })) }) } : {}),
  })
}

test('the edge is up: container stable, management socket answering', () => {
  expect(kamailioInspect('{{.State.Status}}')).toBe('running')
  // A container that cannot start sits in a restart loop and still "exists" —
  // the exact way this defect hid. RestartCount 0 is the staying-up half.
  expect(kamailioInspect('{{.RestartCount}}')).toBe('0')
  const version = execFileSync('docker', ['exec', KAMAILIO_CONTAINER, 'kamcmd', 'core.version'], { encoding: 'utf8' })
  expect(version).toContain('kamailio')
})

test('the edge is bound: UDP 5060, TCP 5060 and TLS 5061 all serve SIP', async () => {
  const caPem = sipEdgeTrustAnchor()
  for (const [transport, port] of [['udp', SIP_EDGE_PORT], ['tcp', SIP_EDGE_PORT], ['tls', SIP_EDGE_TLS_PORT]] as const) {
    const probe = await probeOptions({
      host: SIP_EDGE_HOST,
      port,
      transport,
      domain: REGISTRAR_DOMAIN,
      ...(transport === 'tls' ? { caPem } : {}),
    })
    expect(probe.status, `OPTIONS over ${transport}:${port}: ${probe.reason}`).toBe(200)
  }
})

test('a SIP client registers through the edge, and a wrong secret is refused', async () => {
  // Provisioned directly over ARI: this spec measures the EDGE, so it must
  // not depend on the app API being in the stack. The API-driven issuance of
  // this same object set is asterisk-register.e2e.ts's subject.
  const id = `edge_probe_${randomBytes(6).toString('hex')}`
  const secret = randomBytes(24).toString('hex')
  try {
    for (const [type, fields] of [
      ['auth', { auth_type: 'userpass', username: id, password: secret }],
      ['aor', { max_contacts: '1', remove_existing: 'yes' }],
      ['endpoint', {
        context: 'volunteers-sframe',
        aors: id,
        auth: id,
        disallow: 'all',
        allow: 'ulaw',
        direct_media: 'no',
        rtp_symmetric: 'yes',
        force_rport: 'yes',
        rewrite_contact: 'yes',
      }],
    ] as const) {
      const res = await ariConfigObject('PUT', type, id, fields)
      expect(res.status, `ARI PUT ${type}/${id}: ${await res.text()}`).toBe(200)
    }

    const caPem = sipEdgeTrustAnchor()
    const register = (password: string) => registerOverTls({
      host: SIP_EDGE_HOST,
      port: SIP_EDGE_TLS_PORT,
      domain: REGISTRAR_DOMAIN,
      username: id,
      password,
      caPem,
    })

    const registered = await register(secret)
    expect(registered.status, `REGISTER through the edge: ${registered.reason}`).toBe(200)

    // The 200 above is only meaningful if the challenge is real: a wrong
    // secret must NOT register through the same path.
    const refused = await register('not-the-provisioned-secret')
    expect(refused.status).toBe(401)
  } finally {
    for (const type of ['endpoint', 'aor', 'auth']) {
      await ariConfigObject('DELETE', type, id).catch(() => {})
    }
  }
})

/**
 * Step definitions for sip-bridge's own HTTP surface (health + authenticated
 * status), observed as a black box against the live sip-bridge sidecar — the
 * same way the Worker observes it in production.
 *
 * Everything else sip-bridge does (the call-flow command protocol, PBX client
 * selection, Kamailio dispatcher management) has no HTTP surface at all and is
 * covered by unit/contract tests under sip-bridge/ and deploy/docker/tests/telephony/
 * — see the pointer comment at the top of core/sip-bridge.feature.
 *
 * Requires PBX_TYPE=asterisk (the only PBX type the dev/CI telephony sidecar
 * runs) and the sip-bridge sidecar reachable at SIP_BRIDGE_URL. If it is
 * unreachable these steps throw rather than silently pass — see the identical
 * rationale on the health-check step in sip-bridge-integration.steps.ts.
 */
import { createHmac } from 'node:crypto'
import type { APIResponse } from '@playwright/test'
import { Given, When } from './fixtures'
import { setLastResponse } from './shared-state'

const SIP_BRIDGE_URL = process.env.SIP_BRIDGE_URL || 'http://localhost:3001'
/** Must match the BRIDGE_SECRET the sip-bridge sidecar was started with (see
 * deploy/docker/docker-compose.ci.yml / bootstrap-backend's default). */
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'ci-test-bridge-secret'

/** Sign a request exactly as sip-bridge/src/webhook-sender.ts#sign expects:
 * HMAC-SHA256(secret, `${timestamp}.${url}.${body}`), base64-encoded. */
function sign(url: string, body: string, timestamp: string): string {
  const hmac = createHmac('sha256', BRIDGE_SECRET)
  hmac.update(`${timestamp}.${url}.${body}`)
  return hmac.digest('base64')
}

// ── Given ────────────────────────────────────────────────────────────

Given('a running sip-bridge with PBX_TYPE {string}', async ({}, pbxType: string) => {
  // PBX_TYPE is fixed when the sidecar starts (an env var — see
  // docker-compose.dev.yml / docker-compose.ci.yml), not something a running
  // test can change. The dev/CI telephony sidecar is always asterisk; fail
  // loudly rather than silently pass a scenario against the wrong PBX type.
  if (pbxType !== 'asterisk') {
    throw new Error(
      `the sip-bridge test sidecar is fixed at PBX_TYPE=asterisk — cannot test PBX_TYPE="${pbxType}"`,
    )
  }
})

// ── When ─────────────────────────────────────────────────────────────

When('I GET \\/health', async ({ request, world }) => {
  let res: APIResponse
  try {
    res = await request.get(`${SIP_BRIDGE_URL}/health`)
  } catch (err) {
    throw new Error(
      `sip-bridge sidecar unavailable at ${SIP_BRIDGE_URL}/health (docker compose --profile ` +
        `telephony must be up). Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const status = res.status()
  const data = await res.json().catch(() => null)
  setLastResponse(world, { status, data })
})

When('I GET \\/status with a valid X-Bridge-Signature', async ({ request, world }) => {
  const url = `${SIP_BRIDGE_URL}/status`
  const timestamp = Date.now().toString()
  const signature = sign(url, '', timestamp)
  let res: APIResponse
  try {
    res = await request.get(url, {
      headers: { 'X-Bridge-Signature': signature, 'X-Bridge-Timestamp': timestamp },
    })
  } catch (err) {
    throw new Error(
      `sip-bridge sidecar unavailable at ${url} (docker compose --profile telephony must be up). ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const status = res.status()
  const data = await res.json().catch(() => null)
  setLastResponse(world, { status, data })
})

When('I GET \\/status without a signature', async ({ request, world }) => {
  const url = `${SIP_BRIDGE_URL}/status`
  let res: APIResponse
  try {
    res = await request.get(url)
  } catch (err) {
    throw new Error(
      `sip-bridge sidecar unavailable at ${url} (docker compose --profile telephony must be up). ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const status = res.status()
  const data = await res.text().catch(() => null)
  setLastResponse(world, { status, data })
})

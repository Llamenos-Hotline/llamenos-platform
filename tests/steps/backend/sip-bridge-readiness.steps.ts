/**
 * Step definitions for the server-side sip-bridge reachability scenarios in
 * core/sip-bridge.feature (#1698; see #1697 and #1636).
 *
 * Unlike the runner-side scenarios in sip-bridge.steps.ts — which probe the
 * bridge from the test runner and therefore cannot observe a deployment's
 * internal network — these steps read the WORKER's own readiness report
 * (/api/health/ready). The server's sipBridge check probes SIP_BRIDGE_URL from
 * inside the deployment, so a service that is declared but has no container
 * behind it reports failing — which is the failure #1697 needed a suite to
 * notice.
 *
 * The probe cannot gate itself away: the declaration it reads is the same
 * SIP_BRIDGE_URL the app would use to route a call, not a parallel flag that
 * can disagree with it (#1697's defect class); an undeclared bridge FAILS the
 * scenario rather than passing it. And the check cannot omit itself from the
 * report (#1636's defect class — held by the first scenario).
 */
import { expect } from '@playwright/test'
import { When, Then } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'

interface DependencyCheck {
  status?: unknown
  detail?: unknown
}

interface ReadinessBody {
  status?: unknown
  checks?: Record<string, DependencyCheck>
}

function lastReadiness(world: Record<string, unknown>): ReadinessBody {
  const data = getSharedState(world).lastResponse?.data
  if (typeof data !== 'object' || data === null) {
    throw new Error(`expected an object readiness body, got: ${JSON.stringify(data)}`)
  }
  return data as ReadinessBody
}

// ── When ─────────────────────────────────────────────────────────────

When('I fetch the worker readiness report', async ({ request, world }) => {
  // /api/health/ready answers 503 when a GATING dependency (postgres, storage,
  // relay) is down — which mid-suite means everything is already failing — but
  // the sipBridge check is reported, never gating (#1418), so its assertion
  // reads the body regardless of the status line. Anything else (a connection
  // error, a non-JSON body) throws here rather than passing vacuously.
  const res = await request.get('/api/health/ready')
  const data = await res.json().catch(() => null)
  if (data === null) {
    throw new Error(`readiness probe returned HTTP ${res.status()} with a non-JSON body`)
  }
  setLastResponse(world, { status: res.status(), data })
})

// ── Then ─────────────────────────────────────────────────────────────

Then('the readiness report carries a sip-bridge check with a definite status', ({ world }) => {
  const body = lastReadiness(world)
  expect(
    body.checks && typeof body.checks === 'object',
    `readiness must carry a checks object: ${JSON.stringify(body)}`,
  ).toBe(true)

  // The #1636 regression: an omitted check reads exactly like a healthy one.
  const check = body.checks?.sipBridge
  expect(
    check,
    `readiness omitted the sipBridge check — #1636: a probe must never be able to ` +
      `remove itself from its own report. Got checks: ${JSON.stringify(Object.keys(body.checks ?? {}))}`,
  ).toBeDefined()

  expect(
    check?.status === 'ok' || check?.status === 'failing',
    `sipBridge must report a definite status (ok|failing), got: ${JSON.stringify(check)}`,
  ).toBe(true)

  if (check?.status === 'failing') {
    expect(
      typeof check.detail === 'string' && check.detail.length > 0,
      `a failing sipBridge check must name its cause, got: ${JSON.stringify(check)}`,
    ).toBe(true)
  }
})

Then('the server reports its declared sip-bridge as reachable', ({ world }) => {
  const check = lastReadiness(world).checks?.sipBridge
  expect(check, 'readiness omitted the sipBridge check — see the sibling scenario').toBeDefined()

  // No branch lets this pass on "SIP_BRIDGE_URL is not set". The feature is
  // tagged @telephony, which means the sidecar is REQUIRED: an environment that
  // deliberately omits it excludes the scenario with `--grep-invert @telephony`,
  // exactly as sip-bridge-integration.steps.ts documents. A probe that passes
  // when its own subject is undeclared is the #1697 defect class (the smoke
  // probe gated on a flag that read false while the role was applied anyway).
  const detail = typeof check?.detail === 'string' ? check.detail : ''
  expect(
    detail,
    `the server was not told where the sip-bridge is (SIP_BRIDGE_URL unset in the app's ` +
      `environment). In CI deploy/docker/docker-compose.test.yml must render it; against a ` +
      `deployment, the app container must carry it. An undeclared bridge routes zero calls.`,
  ).not.toContain('SIP_BRIDGE_URL is not set')

  expect(
    check?.status,
    `the server declares a sip-bridge (SIP_BRIDGE_URL is set) but the bridge does not answer ` +
      `from inside the deployment — the #1697 shape: declared in compose, no container behind ` +
      `it, zero calls routed. sipBridge check: ${JSON.stringify(check)}`,
  ).toBe('ok')
})

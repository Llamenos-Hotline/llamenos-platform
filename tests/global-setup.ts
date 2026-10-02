import type { FullConfig } from '@playwright/test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_DEVICE_AUTH } from '@shared/crypto-labels'
const BACKEND_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

function loadDevVarsSecret(): string | undefined {
  return process.env.E2E_TEST_SECRET || process.env.DEV_RESET_SECRET || undefined
}

// Admin Ed25519 seed — must match tests/api-helpers.ts ADMIN_SEED
const ADMIN_SEED = 'f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7'

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

function makeBootstrapToken(seedHex: string, method: string, path: string) {
  const seedBytes = hexToBytes(seedHex)
  const pubkey = bytesToHex(ed25519.getPublicKey(seedBytes))
  const timestamp = Date.now()
  const nonce = randomNonce()
  // Include nonce to prevent replay detection rejections in parallel test workers
  const message = utf8ToBytes(`${LABEL_DEVICE_AUTH}:${pubkey}:${timestamp}:${method}:${path}:${nonce}`)
  const sig = ed25519.sign(message, seedBytes)
  return { pubkey, timestamp, token: bytesToHex(sig), nonce }
}

async function resetTestState(baseUrl: string): Promise<void> {
  const secret = loadDevVarsSecret()
  if (!secret) return // No secret configured — skip reset
  const res = await fetch(`${baseUrl}/api/test-reset`, {
    method: 'POST',
    headers: { 'X-Test-Secret': secret },
  })
  // 403 = server not configured with secret (skip gracefully)
  if (res.status === 403 || res.status === 404) return
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Test reset failed: ${res.status} ${text}`)
  }
}

async function bootstrapAdmin(baseUrl: string): Promise<void> {
  const path = '/api/auth/bootstrap'
  const body = makeBootstrapToken(ADMIN_SEED, 'POST', path)
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // 200 = just created, 403 = already exists (both are fine)
  if (res.status !== 200 && res.status !== 403) {
    const text = await res.text()
    throw new Error(`Admin bootstrap failed: ${res.status} ${text}`)
  }
}

async function verifyAdminAccess(baseUrl: string): Promise<void> {
  const token = makeBootstrapToken(ADMIN_SEED, 'GET', '/api/auth/me')
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${JSON.stringify(token)}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Admin verification failed: ${res.status} ${text}`)
  }
  // Verify the admin actually has role-super-admin. If not, force-promote
  // via the test-promote-admin endpoint. This catches cases where the
  // admin user was created with role-volunteer due to race conditions
  // during test-reset, and the auth middleware's defensive fix didn't
  // fire (e.g. ADMIN_PUBKEY mismatch in env).
  const me = await res.json() as { roles?: string[] }
  if (me.roles && !me.roles.includes('role-super-admin')) {
    console.warn(`[global-setup] Admin has wrong roles: ${JSON.stringify(me.roles)} — promoting via test-promote-admin`)
    const secret = loadDevVarsSecret()
    if (secret) {
      const seedBytes = hexToBytes(ADMIN_SEED)
      const pubkey = bytesToHex(ed25519.getPublicKey(seedBytes))
      const promoteRes = await fetch(`${baseUrl}/api/test-promote-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Secret': secret },
        body: JSON.stringify({ pubkey }),
      })
      if (!promoteRes.ok) {
        const text = await promoteRes.text()
        throw new Error(`Admin role promotion failed: ${promoteRes.status} ${text}`)
      }
      console.log('[global-setup] Admin promoted to role-super-admin successfully')
    } else {
      throw new Error(
        `Admin ${bytesToHex(ed25519.getPublicKey(hexToBytes(ADMIN_SEED)))} has roles ` +
        `${JSON.stringify(me.roles)} instead of role-super-admin. On a development server, set ` +
        `E2E_TEST_SECRET/DEV_RESET_SECRET so this can self-correct. On a DEPLOYMENT there is no ` +
        `such escape hatch by design — the fix is ADMIN_PUBKEY on the server matching this seed's ` +
        `public key, since that is what grants the role at bootstrap.`
      )
    }
  }
}

/**
 * Create the default hub tests need for `currentHubId`, through the REAL
 * authenticated route rather than a test-only one.
 *
 * This used to POST /api/test-create-hub and, before that, to return early
 * whenever no X-Test-Secret was configured. Both made the setup undeployable:
 * `devGuard` (apps/worker/app.ts) answers 404 for every /api/test-* outside a
 * development server, so against a real deployment this silently created
 * nothing and every test needing a hub failed later, for a reason that looked
 * nothing like its cause.
 *
 * `POST /api/hubs` is the route an operator uses. It needs
 * `system:manage-hubs` or `system:create-hub`, which the admin bootstrapped
 * above holds, and it works identically on a dev box and a deployment. See
 * #1423.
 */
async function ensureDefaultHub(baseUrl: string): Promise<void> {
  const configRes = await fetch(`${baseUrl}/api/config`)
  if (!configRes.ok) return
  const config = await configRes.json() as { hubs?: Array<{ id: string }> }
  if (config.hubs && config.hubs.length > 0) return

  const path = '/api/hubs'
  const token = makeBootstrapToken(ADMIN_SEED, 'POST', path)
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${JSON.stringify(token)}`,
    },
    body: JSON.stringify({ name: 'Default Test Hub', slug: 'default-test-hub' }),
  })
  // 409 = another worker won the race and created it first; that is success
  // for our purposes, since the hub the tests need now exists.
  if (!res.ok && res.status !== 409) {
    const text = await res.text()
    console.warn(`[global-setup] Hub creation failed (non-fatal): ${res.status} ${text}`)
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const maxAttempts = process.env.CI ? 40 : 10
  const retryDelayMs = process.env.CI ? 3000 : 2000

  // Phase 1: Wait for the backend to be reachable and healthy.
  // Use /api/health/ready to ensure Postgres + all core deps are up,
  // but tolerate degraded status (sidecars may not be ready yet).
  let backendReady = false
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // First check basic reachability with /api/config
      const configRes = await fetch(`${BACKEND_URL}/api/config`)
      if (!configRes.ok) {
        if (i % 5 === 4) {
          console.log(`[global-setup] /api/config returned ${configRes.status}, retrying... (${i + 1}/${maxAttempts})`)
        }
        await new Promise(r => setTimeout(r, retryDelayMs))
        continue
      }

      // Then verify health — accept both 200 (ok) and 503 (degraded, sidecars not ready)
      // as long as core dependencies (postgres) are reachable.
      const healthRes = await fetch(`${BACKEND_URL}/api/health/ready`)
      if (healthRes.ok) {
        backendReady = true
        break
      }
      // Parse health response to check if postgres is ok (core dep)
      try {
        const health = await healthRes.json() as { status: string; checks: Record<string, { status: string }> }
        const pgOk = health.checks?.postgres?.status === 'ok'
        if (pgOk) {
          // Postgres is up — backend can serve requests even if sidecars are degraded
          console.log(`[global-setup] Backend degraded but postgres is ok — proceeding (status: ${health.status})`)
          backendReady = true
          break
        }
        if (i % 5 === 4) {
          console.log(`[global-setup] Health check: postgres=${health.checks?.postgres?.status ?? 'unknown'}, retrying... (${i + 1}/${maxAttempts})`)
        }
      } catch {
        // Can't parse health response — fall through to retry
        if (i % 5 === 4) {
          console.log(`[global-setup] Health check returned ${healthRes.status}, retrying... (${i + 1}/${maxAttempts})`)
        }
      }
    } catch (err) {
      if (i % 5 === 4) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[global-setup] Backend not reachable, retrying... (${i + 1}/${maxAttempts}) — ${msg}`)
      }
    }
    await new Promise(r => setTimeout(r, retryDelayMs))
  }

  if (!backendReady) {
    throw new Error(
      `Backend not ready after ${maxAttempts} attempts (${(maxAttempts * retryDelayMs) / 1000}s). Is the server running at ${BACKEND_URL}?`
    )
  }

  // Phase 2: Initialize test state
  console.log('[global-setup] Backend ready — initializing test state')
  await resetTestState(BACKEND_URL)
  await bootstrapAdmin(BACKEND_URL)
  await verifyAdminAccess(BACKEND_URL)
  await ensureDefaultHub(BACKEND_URL)
  console.log('[global-setup] Test state initialized successfully')
}

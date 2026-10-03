import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { deriveServerKeypair } from '../lib/server-identity'
import { CURRENT_API_VERSION, MIN_API_VERSION } from '../lib/api-versions'
import type { Hub } from '@shared/types'
import { configResponseSchema, configVerifyResponseSchema, configPinsResponseSchema } from '@protocol/schemas/config'
import { publicErrors } from '../openapi/helpers'
import { ed25519Sign } from '@llamenos/crypto/ffi'
import { bytesToHex } from '@shared/encoding'
import { demoIdentities } from '../lib/demo-identities'
import { devSurfacesEnabled } from '../lib/dev-surfaces'

const config = new Hono<AppEnv>()

/**
 * Whether the deployment presents itself as a demo/test environment. DEMO_MODE
 * is deployment configuration. The `demoMode` flag the setup wizard stores in the
 * database only counts on a development server — everywhere else no database
 * row can put a deployment into demo mode.
 */
function effectiveDemoMode(env: AppEnv['Bindings'], storedDemoMode: boolean): boolean {
  return env.DEMO_MODE === 'true' || (devSurfacesEnabled(env) && storedDemoMode)
}

config.get('/',
  describeRoute({
    tags: ['Config'],
    summary: 'Get public application configuration',
    responses: {
      200: {
        description: 'Application configuration',
        content: {
          'application/json': {
            schema: resolver(configResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')

    // Fetch enabled channels to include in config
    let channels: import('@shared/types').EnabledChannels = {
      voice: false, sms: false, whatsapp: false, signal: false, rcs: false, telegram: false, reports: false,
    }
    try {
      channels = await services.settings.getEnabledChannels(c.env)
    } catch { /* default to all-disabled on fetch failure */ }

    // Get phone number from telephony provider config or env
    let hotlineNumber = c.env.TWILIO_PHONE_NUMBER || ''
    try {
      const prov = await services.settings.getTelephonyProvider()
      if (prov?.phoneNumber) hotlineNumber = prov.phoneNumber
    } catch { /* ignore */ }

    // Fetch setup state
    let setupCompleted = true
    let storedDemoMode = false
    try {
      const setupState = await services.settings.getSetupState()
      setupCompleted = setupState.setupCompleted
      storedDemoMode = setupState.demoMode ?? false
    } catch { /* setup state unreadable — DEMO_MODE alone decides demo mode */ }
    const demoMode = effectiveDemoMode(c.env, storedDemoMode)

    // Check if bootstrap is needed (no admin exists)
    let needsBootstrap = false
    try {
      const { hasAdmin } = await services.identity.hasAdmin()
      needsBootstrap = !hasAdmin
    } catch { /* default to false */ }

    // Fetch active hubs
    let hubs: Hub[] = []
    let defaultHubId: string | undefined
    try {
      const hubsData = await services.settings.getHubs()
      hubs = hubsData.hubs.filter(h => h.status === 'active')
      if (hubs.length === 1) {
        defaultHubId = hubs[0].id
      }
    } catch { /* default to empty */ }

    // Derive server Ed25519 pubkey for client event signature verification
    const serverSecret = c.env.SERVER_SECRET
    let serverPubkey: string | undefined
    if (serverSecret) {
      try {
        serverPubkey = deriveServerKeypair(serverSecret).pubkeyHex
      } catch {
        serverPubkey = undefined
      }
    }

    // WebSocket relay URL — always /ws (proxied via Caddy in production)
    const wsRelayUrl = serverSecret ? '/ws' : undefined

    return c.json({
      hotlineName: c.env.HOTLINE_NAME || 'Hotline',
      hotlineNumber,
      channels,
      setupCompleted,
      demoMode,
      demoResetSchedule: c.env.DEMO_MODE === 'true' ? (c.env.DEMO_RESET_CRON || null) : null,
      needsBootstrap,
      hubs,
      defaultHubId,
      serverPubkey,
      wsRelayUrl,
      apiVersion: CURRENT_API_VERSION,
      minApiVersion: MIN_API_VERSION,
      // GlitchTip/Sentry DSN for client-side crash reporting (opt-in, privacy-first)
      ...(c.env.GLITCHTIP_DSN ? { sentryDsn: c.env.GLITCHTIP_DSN } : {}),
    })
  })

// Build verification endpoint (Epic 79: Reproducible Builds)
// Informational only — trust anchor is CHECKSUMS.txt in GitHub Releases
config.get('/verify',
  describeRoute({
    tags: ['Config'],
    summary: 'Get build verification info',
    responses: {
      200: {
        description: 'Build verification metadata',
        content: {
          'application/json': {
            schema: resolver(configVerifyResponseSchema),
          },
        },
      },
    },
  }),
  (c) => {
    return c.json({
      version: __BUILD_VERSION__,
      commit: __BUILD_COMMIT__,
      buildTime: __BUILD_TIME__,
      verificationUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases',
      trustAnchor: 'GitHub Release checksums + SLSA provenance',
    })
  })

// MARK: - Certificate Pin List (H14)

/** Let's Encrypt ISRG Root X1 — RSA 4096 intermediate CA SPKI SHA-256. */
const ISRG_ROOT_X1_HASH = 'C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M='
/** Let's Encrypt ISRG Root X2 — ECDSA P-384 backup root SPKI SHA-256. */
const ISRG_ROOT_X2_HASH = 'diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA='

/**
 * GET /api/config/pins — Ed25519-signed certificate pin list.
 *
 * Clients fetch this on launch to support pin rotation without app updates.
 * The response is signed with the server's Ed25519 key (derived from SERVER_SECRET)
 * so clients can verify authenticity before trusting the pin list.
 *
 * The pin list contains SHA-256 SPKI hashes of intermediate CA public keys.
 * Pinning against the intermediate (not the leaf) means routine cert renewal
 * does not break pinning.
 */
config.get('/pins',
  describeRoute({
    tags: ['Config'],
    summary: 'Get signed certificate pin list for TLS pinning',
    responses: {
      200: {
        description: 'Signed certificate pin list',
        content: {
          'application/json': {
            schema: resolver(configPinsResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  (c) => {
    const serverSecret = c.env.SERVER_SECRET
    // Custom pins from env (comma-separated base64 hashes) or defaults
    const envPins = c.env.CERT_PIN_HASHES
    const pinHashes = envPins
      ? envPins.split(',').map((h: string) => h.trim()).filter(Boolean)
      : [ISRG_ROOT_X1_HASH, ISRG_ROOT_X2_HASH]

    const now = new Date()
    // Pin list valid for 30 days — clients should refresh periodically
    const notAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

    const pins = pinHashes.map((hash: string, i: number) => ({
      algorithm: 'sha256',
      hash,
      label: i === 0 ? 'ISRG Root X1 (primary)' : i === 1 ? 'ISRG Root X2 (backup)' : `pin-${i}`,
    }))

    const payload = {
      pins,
      notBefore: now.toISOString(),
      notAfter: notAfter.toISOString(),
    }

    // Sign the payload with the server's Ed25519 key for client verification
    let signature = ''
    if (serverSecret) {
      try {
        const keypair = deriveServerKeypair(serverSecret)
        const message = new TextEncoder().encode(JSON.stringify(payload))
        const sig = ed25519Sign(keypair.secretKey, message)
        signature = bytesToHex(sig)
      } catch {
        // If signing fails, return unsigned — clients with the server pubkey
        // will reject it, falling back to static pins (which is safe).
      }
    }

    return c.json({ ...payload, signature })
  })

// MARK: - Demo Credentials (demo mode only)

/**
 * GET /api/config/demo/credentials
 *
 * Hands the login page's demo picker the demo accounts' signing seeds, keyed by
 * their listed handle, on a development server in demo mode. The seeds are
 * generated per server process (lib/demo-identities.ts) and never appear in any
 * client bundle or image. Everywhere else this is a 404 decided before the
 * database is read, so no stored setup state can open it.
 */
config.get('/demo/credentials', async (c) => {
  if (!devSurfacesEnabled(c.env)) {
    return c.json({ error: 'Not Found' }, 404)
  }
  let storedDemoMode = false
  try {
    storedDemoMode = (await c.get('services').settings.getSetupState()).demoMode ?? false
  } catch { /* default to false */ }
  if (!effectiveDemoMode(c.env, storedDemoMode)) {
    return c.json({ error: 'Not Found' }, 404)
  }

  const credentials = demoIdentities(c.env).map(identity => ({
    pubkey: identity.listedPubkey,
    seedHex: identity.seedHex,
  }))
  return c.json({ credentials })
})

export default config

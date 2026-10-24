import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { deriveServerKeypair } from '../lib/server-identity'
import { CURRENT_API_VERSION, MIN_API_VERSION } from '../lib/api-versions'
import { configResponseSchema, configVerifyResponseSchema, configPinsResponseSchema } from '@protocol/schemas/config'
import { publicErrors } from '../openapi/helpers'
import { ed25519Sign } from '@llamenos/crypto/ffi'
import { bytesToHex } from '@shared/encoding'

const config = new Hono<AppEnv>()

/**
 * What this endpoint may say to an anonymous caller.
 *
 * `/api/config` is the one route a client reads BEFORE it has any credentials,
 * so it is also the one route whose payload an adversary who can merely reach
 * the host gets for free. Everything below is here because a pre-login client
 * cannot function without it:
 *
 *   - `hotlineName`, `channels` — rendered on the sign-in screen and used to
 *     route first-run setup. The deployment is self-identifying pre-login by
 *     construction: it has to greet the volunteer by the hotline's name.
 *   - `hotlineNumber` — the number the organisation publishes so callers can
 *     dial it. Public by purpose, and it names nothing `hotlineName` does not.
 *   - `setupCompleted`, `needsBootstrap` — decide between the wizard, the
 *     bootstrap screen and the login screen before anyone can authenticate.
 *   - `serverPubkey` — a verification key; publishing it is the point.
 *   - `wsRelayUrl` — the relay address every client (Android included) needs
 *     before it holds a session.
 *   - `apiVersion` / `minApiVersion` — version negotiation happens on the
 *     first request, which is this one.
 *   - `sentryDsn` — a write-only ingest DSN, needed to report a pre-login crash.
 *
 * What is deliberately NOT here: the hub roster. It used to return every active
 * hub with name, slug, description, `createdBy` and timestamps, to an
 * unauthenticated caller, while `GET /api/hubs` — the same data — answered 401
 * (#1710). Hub names are the organisation's internal structure (chapters,
 * regions, partner orgs), `createdBy` is an admin's Ed25519 pubkey, and the
 * timestamps date the organisation's expansion; this project's threat model
 * treats organisational structure as implicating, not merely as metadata.
 *
 * `defaultHubId` went with it. Its only consumer was the desktop client
 * choosing an active hub before login, which is a defect in its own right
 * (#1708): the active hub must come from the authenticated user's memberships
 * via `GET /api/hubs`, never from an instance-wide list. With that fixed,
 * nothing needs a hub id pre-authentication.
 *
 * Adding a field here widens an anonymous read. `__tests__/unit/routes/config.test.ts`
 * asserts the exact key set so that widening cannot happen by accident.
 */
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
    try {
      setupCompleted = (await services.settings.getSetupState()).setupCompleted
    } catch { /* setup state unreadable — assume complete */ }

    // Check if bootstrap is needed (no admin exists)
    let needsBootstrap = false
    try {
      const { hasAdmin } = await services.identity.hasAdmin()
      needsBootstrap = !hasAdmin
    } catch { /* default to false */ }

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
      needsBootstrap,
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
const ISRG_ROOT_X2_HASH = 'diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI='

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

export default config

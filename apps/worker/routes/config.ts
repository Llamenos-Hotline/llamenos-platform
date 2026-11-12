import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { deriveServerKeypair } from '../lib/server-identity'
import { CURRENT_API_VERSION, MIN_API_VERSION } from '../lib/api-versions'
import { configResponseSchema, configVerifyResponseSchema } from '@protocol/schemas/config'
import { publicErrors } from '../openapi/helpers'

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

// Certificate pins are deliberately NOT served from here. They are compiled into
// each client (Signal's model): a pin set fetched from the server is only as
// trustworthy as the server, which is exactly what pinning exists to distrust.
// (#2708 removed GET /api/config/pins.)

export default config

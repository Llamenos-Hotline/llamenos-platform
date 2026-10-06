import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { generateWebRtcToken, isWebRtcConfigured } from '../telephony/webrtc-tokens'
import { generateSipParams, isSipConfigured, sipCredentialsMayBeIssued } from '../telephony/sip-tokens'
import {
  buildVolunteerSipParams,
  deriveVolunteerSipSecret,
  mintTurnCredentials,
  provisionVolunteerEndpoint,
  sipCredentialEpoch,
  volunteerSipUsername,
  type TurnCredentials,
} from '../telephony/registrar'
import { webrtcTokenResponseSchema, sipTokenResponseSchema, telephonyStatusResponseSchema } from '@protocol/schemas/webrtc'
import { callerHasAnyHubAccess } from '../lib/hub-scope'
import { authErrors } from '../openapi/helpers'
import { createLogger } from '../lib/logger'

const logger = createLogger('routes.webrtc')

const webrtc = new Hono<AppEnv>()

/**
 * GET /api/telephony/webrtc-token
 * Generate a provider-specific WebRTC access token for the authenticated volunteer.
 * Requires: provider config with webrtcEnabled=true and appropriate credentials.
 */
webrtc.get('/webrtc-token',
  describeRoute({
    tags: ['WebRTC'],
    summary: 'Generate WebRTC access token',
    responses: {
      ...authErrors,
      200: {
        description: 'WebRTC token with provider info',
        content: {
          'application/json': {
            schema: resolver(webrtcTokenResponseSchema),
          },
        },
      },
      400: { description: 'Call preference is phone only or WebRTC not configured' },
      404: { description: 'No telephony provider configured' },
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const user = c.get('user')

    // Check user's call preference allows browser calls
    const callPref = user.callPreference ?? 'phone'
    if (callPref === 'phone') {
      return c.json({ error: 'Call preference is set to phone only. Enable browser calling in settings.' }, 400)
    }

    // Same authority as /sip-token: a live calling credential belongs only to
    // someone who still holds a role in some hub (#1540).
    if (!callerHasAnyHubAccess(c)) {
      logger.warn('WebRTC token refused: no remaining hub role', { pubkey: pubkey.slice(0, 16) })
      return c.json({ error: 'No hub membership — browser calling is not available for this account.' }, 403)
    }

    // Get provider config
    const config = await services.settings.getTelephonyProvider(c.env.HMAC_SECRET)
    if (!config) {
      return c.json({ error: 'No telephony provider configured' }, 404)
    }
    if (!isWebRtcConfigured(config)) {
      return c.json({ error: 'WebRTC is not configured for the current provider. Admin must enable it in settings.' }, 400)
    }

    try {
      // Use a sanitized identity (pubkey prefix — unique per volunteer)
      const identity = `vol_${pubkey.slice(0, 16)}`
      const result = await generateWebRtcToken(config, identity)
      return c.json({ token: result.token, provider: result.provider, identity })
    } catch (err) {
      logger.error('Token generation failed', err)
      return c.json({ error: 'Failed to generate WebRTC token' }, 500)
    }
  })

/**
 * GET /api/telephony/sip-token
 * Generate standardized SIP connection parameters for mobile VoIP clients (Linphone SDK).
 * Returns provider-agnostic SIP config: domain, transport, credentials, ICE servers, encryption.
 */
webrtc.get('/sip-token',
  describeRoute({
    tags: ['WebRTC'],
    summary: 'Generate SIP connection parameters',
    responses: {
      ...authErrors,
      200: {
        description: 'SIP connection parameters',
        content: {
          'application/json': {
            schema: resolver(sipTokenResponseSchema),
          },
        },
      },
      400: { description: 'Call preference is phone only or SIP not configured' },
      404: { description: 'No telephony provider configured' },
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const volunteer = c.get('user')

    // Check volunteer's call preference allows VoIP
    const callPref = volunteer.callPreference ?? 'phone'
    if (callPref === 'phone') {
      return c.json({ error: 'Call preference is set to phone only. Enable VoIP in settings.' }, 400)
    }

    // Hub membership is what authorises the credential (#1540). Without this,
    // revocation is bypassable by asking again: a volunteer removed from their
    // last hub has their endpoint torn down at the PBX and then simply
    // re-provisions it here. The authority is resolved by
    // callerHasAnyHubAccess — hubContext's own admission rule, applied over
    // every hub the volunteer is assigned to — NOT by a second rule written
    // here, so this and ringing's hub filter cannot drift apart. That filter
    // stays where it is: it is the next layer, not the only one.
    if (!callerHasAnyHubAccess(c)) {
      logger.warn('SIP token refused: no remaining hub role', { pubkey: pubkey.slice(0, 16) })
      return c.json({ error: 'No hub membership — in-app SIP audio is not available for this account.' }, 403)
    }

    // Get provider config
    const config = await services.settings.getTelephonyProvider(c.env.HMAC_SECRET)
    if (!config) {
      return c.json({ error: 'No telephony provider configured' }, 404)
    }
    if (!isSipConfigured(config)) {
      return c.json({ error: 'SIP is not configured for the current provider.' }, 400)
    }

    // Refused at the source for every vendor, not left to clients not to ask:
    // their generators would hand this volunteer the hub's OWN trunk
    // credential — identical for every volunteer, unrevocable individually,
    // and registered against the vendor's SIP domain so the vendor observes
    // each volunteer's IP and presence (#1203). Only our own Asterisk passes
    // the gate, because only it hosts real per-volunteer identities (see
    // sipCredentialsMayBeIssued and telephony/registrar.ts).
    if (!sipCredentialsMayBeIssued(config)) {
      logger.warn('SIP token refused: per-volunteer credentials not available (#1203)', {
        provider: config.type,
      })
      return c.json({
        error: 'In-app SIP audio is unavailable: the server will not issue a shared trunk credential. ' +
          'Use the phone call preference until per-volunteer SIP identities exist.',
      }, 503)
    }

    try {
      // The only provider past the gate is our own Asterisk: issue a REAL
      // per-volunteer identity (never generateSipParams — that path returns
      // the hub's shared credential, which is what the gate exists to refuse).
      if (config.type === 'asterisk') {
        const username = volunteerSipUsername(pubkey)
        const turn = turnCredentialsFor(c.env, username)
        // Re-admission must not hand back a credential that may have leaked
        // while the volunteer was out of the hub: the epoch counts their
        // revocations, and the secret is derived under it.
        const epoch = await sipCredentialEpoch(services, pubkey)
        try {
          const sipParams = await issueVolunteerSipParams(c.env, config, username, turn, epoch)
          return c.json(sipParams)
        } catch (err) {
          // The registrar is ours: a PBX that will not provision means the
          // credential would be dead on arrival — refuse rather than let the
          // client retry an identity nothing accepts.
          logger.error('SIP registrar unreachable — refusing to issue an unusable credential', err)
          return c.json({ error: 'SIP registrar is unreachable — try again shortly.' }, 503)
        }
      }
      const identity = `vol_${pubkey.slice(0, 16)}`
      const sipParams = generateSipParams(config, identity)
      return c.json(sipParams)
    } catch (err) {
      logger.error('SIP token generation failed', err)
      return c.json({ error: 'Failed to generate SIP parameters' }, 500)
    }
  })

/**
 * GET /api/telephony/sip-status
 * Check whether SIP VoIP is available for the current provider.
 */
webrtc.get('/sip-status',
  describeRoute({
    tags: ['WebRTC'],
    summary: 'Check SIP availability',
    responses: {
      200: {
        description: 'SIP availability status',
        content: {
          'application/json': {
            schema: resolver(telephonyStatusResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const config = await services.settings.getTelephonyProvider(c.env.HMAC_SECRET)
    // Must agree with /sip-token, which refuses while the credential would be
    // shared (#1203) and refuses a caller holding no hub role (#1540).
    // Reporting available:true here and then refusing there would make clients
    // retry a door that is deliberately shut.
    return c.json({
      available: isSipConfigured(config) && sipCredentialsMayBeIssued(config) && callerHasAnyHubAccess(c),
      provider: config?.type ?? null,
    })
  })

/**
 * GET /api/telephony/webrtc-status
 * Check whether WebRTC is available for the current provider.
 */
webrtc.get('/webrtc-status',
  describeRoute({
    tags: ['WebRTC'],
    summary: 'Check WebRTC availability',
    responses: {
      200: {
        description: 'WebRTC availability status',
        content: {
          'application/json': {
            schema: resolver(telephonyStatusResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const config = await services.settings.getTelephonyProvider(c.env.HMAC_SECRET)
    return c.json({
      available: isWebRtcConfigured(config),
      provider: config?.type ?? null,
    })
  })

type RegistrarEnv = {
  HMAC_SECRET: string
  SIP_REGISTRAR_SECRET?: string
  TURN_HOST?: string
  TURN_SECRET?: string
}

/**
 * Time-limited TURN credentials for this volunteer, or undefined when no
 * CoTURN static-auth secret is provisioned (STUN-only ICE servers then).
 * Both TURN_HOST and TURN_SECRET must be set — one without the other means
 * the deployment never wired the relay and must not half-configure clients.
 */
function turnCredentialsFor(
  env: RegistrarEnv,
  identity: string,
): { host: string; credentials: TurnCredentials } | undefined {
  if (!env.TURN_HOST || !env.TURN_SECRET) return undefined
  return { host: env.TURN_HOST, credentials: mintTurnCredentials(env.TURN_SECRET, identity) }
}

/**
 * Issue the per-volunteer SIP identity against our own PBX: ensure the
 * volunteer's PJSIP objects exist (idempotent — re-issuance after a PBX
 * restart re-provisions and self-heals), then build the connection params.
 */
async function issueVolunteerSipParams(
  env: RegistrarEnv,
  config: Parameters<typeof buildVolunteerSipParams>[0],
  username: string,
  turn: { host: string; credentials: TurnCredentials } | undefined,
  epoch: number,
) {
  const masterSecret = env.SIP_REGISTRAR_SECRET || env.HMAC_SECRET
  const secret = deriveVolunteerSipSecret(masterSecret, username, epoch)
  await provisionVolunteerEndpoint(config, username, secret)
  return buildVolunteerSipParams(config, username, secret, turn)
}

export default webrtc

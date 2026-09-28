import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { generateWebRtcToken, isWebRtcConfigured } from '../telephony/webrtc-tokens'
import { generateSipParams, isSipConfigured } from '../telephony/sip-tokens'
import { webrtcTokenResponseSchema, sipTokenResponseSchema, telephonyStatusResponseSchema } from '@protocol/schemas/webrtc'
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

    // Get provider config
    const config = await services.settings.getTelephonyProvider(c.env.HMAC_SECRET)
    if (!config) {
      return c.json({ error: 'No telephony provider configured' }, 404)
    }
    if (!isSipConfigured(config)) {
      return c.json({ error: 'SIP is not configured for the current provider.' }, 400)
    }

    try {
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
    return c.json({
      available: isSipConfigured(config),
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

export default webrtc

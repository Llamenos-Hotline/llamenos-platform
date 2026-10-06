import { safeFetch } from '../lib/safe-fetch'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { audit } from '../services/audit'
import { validateExternalUrl } from '../lib/ssrf-guard'
import { setupStateSchema, setupCompleteBodySchema } from '@protocol/schemas/settings'
import {
  setupStateResponseSchema,
  connectionTestResponseSchema,
  testSignalBodySchema,
  testWhatsAppBodySchema,
  signalRegisterBodySchema,
  signalVerifyBodySchema,
  signalUnregisterBodySchema,
  signalRegistrationResponseSchema,
  signalAccountInfoResponseSchema,
} from '@protocol/schemas/setup'
import { authErrors } from '../openapi/helpers'
import {
  startRegistration,
  verifyRegistration,
  unregisterNumber,
  getAccountInfo,
} from '../messaging/signal/registration'

const setup = new Hono<AppEnv>()

// Get setup state (admin only — gated for defense-in-depth)
setup.get('/state', requirePermission('settings:manage-setup'),
  describeRoute({
    tags: ['Setup'],
    summary: 'Get setup wizard state',
    responses: {
      200: {
        description: 'Current setup state',
        content: {
          'application/json': {
            schema: resolver(setupStateResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getSetupState()
    return c.json(result)
  })

// Update setup state (admin only)
setup.patch('/state', requirePermission('settings:manage-setup'),
  describeRoute({
    tags: ['Setup'],
    summary: 'Update setup wizard state',
    responses: {
      200: {
        description: 'Setup state updated',
        content: {
          'application/json': {
            schema: resolver(setupStateResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', setupStateSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateSetupState(body as Record<string, unknown> as Parameters<typeof services.settings.updateSetupState>[0])
    await audit(services.audit, 'setupStateUpdated', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(result)
  })

// Complete setup (admin only) — also creates default hub if none exists
setup.post('/complete', requirePermission('settings:manage-setup'),
  describeRoute({
    tags: ['Setup'],
    summary: 'Complete setup wizard',
    responses: {
      200: {
        description: 'Setup completed',
        content: {
          'application/json': {
            schema: resolver(setupStateResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', setupCompleteBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    // Create default hub if none exists. Deliberately NOT caught here: if hub
    // creation or admin-role assignment fails, the request must fail too —
    // `setupCompleted` is never written, so the operator lands back on the
    // wizard instead of an empty dashboard with zero hubs and no error.
    // (Issue #1150: this used to swallow the error and mark setup complete
    // anyway.)
    const { hubs } = await services.settings.getHubs()
    if (hubs.length === 0) {
      const hotlineName = c.env.HOTLINE_NAME || 'Hotline'
      const defaultHub = {
        id: crypto.randomUUID(),
        name: hotlineName,
        slug: hotlineName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        status: 'active' as const,
        phoneNumber: c.env.TWILIO_PHONE_NUMBER || '',
        description: '',
        createdBy: pubkey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await services.settings.createHub(defaultHub)
      // Assign admin to the default hub with all roles
      await services.identity.setHubRole({ pubkey, hubId: defaultHub.id, roleIds: ['role-super-admin'] })
    }

    const result = await services.settings.updateSetupState({ setupCompleted: true, demoMode: body.demoMode ?? false })

    await audit(services.audit, 'setupCompleted', pubkey, { demoMode: body.demoMode ?? false }, undefined, null)
    return c.json(result)
  })

// Test Signal bridge connection
setup.post('/test/signal', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup'],
    summary: 'Test Signal bridge connection',
    responses: {
      200: {
        description: 'Connection test result',
        content: {
          'application/json': {
            schema: resolver(connectionTestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', testSignalBodySchema),
  async (c) => {
    const body = c.req.valid('json')

    const bridgeError = validateExternalUrl(body.bridgeUrl, 'Bridge URL')
    if (bridgeError) {
      return c.json({ ok: false, error: bridgeError }, 400)
    }

    try {
      const headers: Record<string, string> = {}
      if (body.bridgeApiKey) headers['Authorization'] = `Bearer ${body.bridgeApiKey}`

      const res = await safeFetch(`${body.bridgeUrl}/v1/about`, {
        headers,
        timeoutMs: 10_000,
        ssrfGuard: false,
      })

      if (res.ok) {
        return c.json({ ok: true })
      }
      return c.json({ ok: false, error: `Bridge returned ${res.status}` }, 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      return c.json({ ok: false, error: message }, 400)
    }
  })

// Test WhatsApp connection (direct Meta API)
setup.post('/test/whatsapp', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup'],
    summary: 'Test WhatsApp API connection',
    responses: {
      200: {
        description: 'Connection test result',
        content: {
          'application/json': {
            schema: resolver(connectionTestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', testWhatsAppBodySchema),
  async (c) => {
    const body = c.req.valid('json')

    try {
      const res = await safeFetch(
        `https://graph.facebook.com/v18.0/${encodeURIComponent(body.phoneNumberId)}`,
        {
          headers: { 'Authorization': `Bearer ${body.accessToken}` },
        }
      )

      if (res.ok) {
        return c.json({ ok: true })
      }
      return c.json({ ok: false, error: `WhatsApp API returned ${res.status}` }, 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      return c.json({ ok: false, error: message }, 400)
    }
  })

// --- Signal Registration ---

// Start Signal registration (request verification code)
setup.post('/signal/register', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup', 'Signal'],
    summary: 'Start Signal number registration',
    description: 'Initiates Signal registration via the bridge. Signal will send a verification code via SMS or voice call.',
    responses: {
      200: {
        description: 'Registration state',
        content: {
          'application/json': {
            schema: resolver(signalRegistrationResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', signalRegisterBodySchema),
  async (c) => {
    const body = c.req.valid('json')

    const bridgeError = validateExternalUrl(body.bridgeUrl, 'Bridge URL')
    if (bridgeError) {
      return c.json({ step: 'failed' as const, error: bridgeError }, 400)
    }

    const result = await startRegistration({
      bridgeUrl: body.bridgeUrl,
      bridgeApiKey: body.bridgeApiKey,
      phoneNumber: body.phoneNumber,
      useVoice: body.useVoice,
      captcha: body.captcha,
    })

    const services = c.get('services')
    await audit(services.audit, 'signalRegistrationStarted', c.get('user').pubkey, {
      numberLast4: body.phoneNumber.slice(-4),
      step: result.step,
    }, undefined, null)

    return c.json(result)
  })

// Verify Signal registration code
setup.post('/signal/verify', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup', 'Signal'],
    summary: 'Verify Signal registration code',
    description: 'Completes Signal registration by verifying the code received via SMS or voice call.',
    responses: {
      200: {
        description: 'Verification result',
        content: {
          'application/json': {
            schema: resolver(signalRegistrationResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', signalVerifyBodySchema),
  async (c) => {
    const body = c.req.valid('json')

    const bridgeError = validateExternalUrl(body.bridgeUrl, 'Bridge URL')
    if (bridgeError) {
      return c.json({ step: 'failed' as const, error: bridgeError }, 400)
    }

    const result = await verifyRegistration({
      bridgeUrl: body.bridgeUrl,
      bridgeApiKey: body.bridgeApiKey,
      phoneNumber: body.phoneNumber,
      verificationCode: body.verificationCode,
    })

    const services = c.get('services')
    await audit(services.audit, 'signalRegistrationVerified', c.get('user').pubkey, {
      numberLast4: body.phoneNumber.slice(-4),
      step: result.step,
    }, undefined, null)

    return c.json(result)
  })

// Unregister Signal number
setup.post('/signal/unregister', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup', 'Signal'],
    summary: 'Unregister Signal number',
    description: 'Unregisters the phone number from Signal. Use when decommissioning a number.',
    responses: {
      200: {
        description: 'Unregistration result',
        content: {
          'application/json': {
            schema: resolver(connectionTestResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', signalUnregisterBodySchema),
  async (c) => {
    const body = c.req.valid('json')

    const bridgeError = validateExternalUrl(body.bridgeUrl, 'Bridge URL')
    if (bridgeError) {
      return c.json({ ok: false, error: bridgeError }, 400)
    }

    const result = await unregisterNumber({
      bridgeUrl: body.bridgeUrl,
      bridgeApiKey: body.bridgeApiKey,
      webhookSecret: '',
      registeredNumber: body.registeredNumber,
    })

    const services = c.get('services')
    await audit(services.audit, 'signalNumberUnregistered', c.get('user').pubkey, {
      numberLast4: body.registeredNumber.slice(-4),
      success: result.success,
    }, undefined, null)

    return c.json({ ok: result.success, error: result.error })
  })

// Get Signal account info
setup.get('/signal/account', requirePermission('settings:manage-messaging'),
  describeRoute({
    tags: ['Setup', 'Signal'],
    summary: 'Get Signal account information',
    description: 'Returns registration status, UUID, and linked devices for the configured Signal number.',
    responses: {
      200: {
        description: 'Account information',
        content: {
          'application/json': {
            schema: resolver(signalAccountInfoResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const config = await services.settings.getMessagingConfig()

    if (!config?.signal) {
      return c.json({
        registered: false,
        number: '',
        error: 'Signal is not configured',
      })
    }

    const info = await getAccountInfo(config.signal)
    return c.json(info)
  })

export default setup

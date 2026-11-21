/**
 * Signal notification API routes.
 *
 * GET    /api/signal-notification/contact         — get own contact (ciphertext + envelope)
 * PUT    /api/signal-notification/contact         — register / update contact
 * DELETE /api/signal-notification/contact         — unregister contact
 * GET    /api/signal-notification/hmac-key        — get per-user HMAC key
 * GET    /api/signal-notification/security-prefs  — get security prefs
 * PATCH  /api/signal-notification/security-prefs  — update security prefs
 * POST   /api/signal-notification/digest/run      — trigger digest (admin only)
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'
import { okResponseSchema } from '@protocol/schemas/common'
import {
  signalContactRegistrationSchema,
  signalContactRecordSchema,
  hmacKeyResponseSchema,
  securityPrefsPatchSchema,
  digestRunBodySchema,
  securityPrefsResponseSchema,
  sidecarTokenResponseSchema,
  digestRunResponseSchema,
} from '@protocol/schemas/signal-notification'
const signalNotificationRoutes = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// GET /contact — retrieve own Signal contact record (encrypted)
// ---------------------------------------------------------------------------

signalNotificationRoutes.get('/contact',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Get own Signal contact registration',
    responses: {
      200: {
        description: 'Signal contact record (ciphertext + envelopes)',
        content: { 'application/json': { schema: resolver(signalContactRecordSchema) } },
      },
      404: { description: 'No Signal contact registered' },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    const contact = await services.signalContacts.findByUser(pubkey)
    if (!contact) return c.json({ error: 'No Signal contact registered' }, 404)

    return c.json({
      identifierHash: contact.identifierHash,
      identifierCiphertext: contact.identifierCiphertext,
      identifierEnvelope: contact.identifierEnvelope,
      identifierType: contact.identifierType,
      verifiedAt: contact.verifiedAt?.toISOString() ?? null,
      updatedAt: contact.updatedAt.toISOString(),
    })
  }
)

// ---------------------------------------------------------------------------
// PUT /contact — register or update Signal contact
// ---------------------------------------------------------------------------

signalNotificationRoutes.put('/contact',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Register or update Signal contact',
    description:
      'The client hashes the Signal identifier locally using the per-user HMAC key ' +
      '(fetched from GET /hmac-key) and sends only the hash + encrypted ciphertext. ' +
      'The plaintext is sent separately to the sidecar POST /api/register endpoint ' +
      'via the app server proxy.',
    responses: {
      200: {
        description: 'Contact registered',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      502: { description: 'Sidecar registration failed' },
      ...authErrors,
    },
  }),
  validator('json', signalContactRegistrationSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Store the encrypted contact in the main DB (zero-knowledge: no plaintext)
    await services.signalContacts.upsert({
      userPubkey: pubkey,
      identifierHash: body.identifierHash,
      identifierCiphertext: body.identifierCiphertext,
      identifierEnvelope: body.identifierEnvelope,
      identifierType: body.identifierType,
    })

    return c.json({ ok: true })
  }
)

// ---------------------------------------------------------------------------
// POST /contact/sidecar-token — issue a short-lived registration token
// The client uses this token to register the plaintext identifier directly
// with the sidecar, so the app server never sees the plaintext.
// ---------------------------------------------------------------------------

signalNotificationRoutes.post('/contact/sidecar-token',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Issue a sidecar registration token for direct client→sidecar registration',
    description:
      'Returns a short-lived HMAC-signed token (5 min) and the sidecar URL. ' +
      'The client calls POST {sidecarUrl}/api/register-client directly with the token ' +
      'and plaintext identifier. The app server never sees the plaintext.',
    responses: {
      200: {
        description: 'Token issued',
        content: { 'application/json': { schema: resolver(sidecarTokenResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    const contact = await services.signalContacts.findByUser(pubkey)
    if (!contact) {
      return c.json({ error: 'No Signal contact registered for this user' }, 400)
    }

    const token = services.userNotifications.issueRegistrationToken(contact.identifierHash)
    const sidecarUrl = services.userNotifications.getSidecarUrl()

    return c.json({ token, sidecarUrl })
  }
)

// ---------------------------------------------------------------------------
// DELETE /contact — unregister Signal contact
// ---------------------------------------------------------------------------

signalNotificationRoutes.delete('/contact',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Unregister Signal contact',
    responses: {
      204: { description: 'Contact removed' },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    // Fetch before deleting so we can unregister from sidecar
    const contact = await services.signalContacts.findByUser(pubkey)
    if (contact) {
      await services.userNotifications.unregisterFromSidecar(contact.identifierHash)
    }

    await services.signalContacts.deleteByUser(pubkey)
    return c.body(null, 204)
  }
)

// ---------------------------------------------------------------------------
// GET /hmac-key — return per-user HMAC key for client-side hashing
// ---------------------------------------------------------------------------

signalNotificationRoutes.get('/hmac-key',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Get per-user HMAC key for client-side identifier hashing',
    responses: {
      200: {
        description: 'HMAC key (hex)',
        content: { 'application/json': { schema: resolver(hmacKeyResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    const hmacKey = services.signalContacts.getPerUserHmacKey(pubkey)
    return c.json({ hmacKey })
  }
)

// ---------------------------------------------------------------------------
// GET /security-prefs — get security preferences
// ---------------------------------------------------------------------------

signalNotificationRoutes.get('/security-prefs',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Get security notification preferences',
    responses: {
      200: {
        description: 'Security preferences',
        content: { 'application/json': { schema: resolver(securityPrefsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    const prefs = await services.securityPrefs.get(pubkey)
    return c.json({
      notificationChannel: prefs.notificationChannel,
      disappearingTimerDays: prefs.disappearingTimerDays,
      digestCadence: prefs.digestCadence,
      alertOnNewDevice: prefs.alertOnNewDevice,
      alertOnPasskeyChange: prefs.alertOnPasskeyChange,
      alertOnPinChange: prefs.alertOnPinChange,
      updatedAt: prefs.updatedAt.toISOString(),
    })
  }
)

// ---------------------------------------------------------------------------
// PATCH /security-prefs — update security preferences
// ---------------------------------------------------------------------------

signalNotificationRoutes.patch('/security-prefs',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Update security notification preferences',
    responses: {
      200: {
        description: 'Updated preferences',
        content: { 'application/json': { schema: resolver(securityPrefsResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', securityPrefsPatchSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const prefs = await services.securityPrefs.update(pubkey, body)
    return c.json({
      notificationChannel: prefs.notificationChannel,
      disappearingTimerDays: prefs.disappearingTimerDays,
      digestCadence: prefs.digestCadence,
      alertOnNewDevice: prefs.alertOnNewDevice,
      alertOnPasskeyChange: prefs.alertOnPasskeyChange,
      alertOnPinChange: prefs.alertOnPinChange,
      updatedAt: prefs.updatedAt.toISOString(),
    })
  }
)

// ---------------------------------------------------------------------------
// POST /digest/run — trigger a digest run (admin only)
// ---------------------------------------------------------------------------

signalNotificationRoutes.post('/digest/run',
  describeRoute({
    tags: ['Signal Notifications'],
    summary: 'Trigger a digest run (admin only)',
    responses: {
      200: {
        description: 'Digest results',
        content: { 'application/json': { schema: resolver(digestRunResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', digestRunBodySchema),
  async (c) => {
    const permissions = c.get('permissions')
    if (!permissions.includes('system:admin')) {
      return c.json({ error: 'Admin access required' }, 403)
    }

    const services = c.get('services')
    const body = c.req.valid('json')

    const cadence = body.cadence === 'daily' ? 'daily' : 'weekly'
    const result = await services.digestCron.runDigests(cadence)
    return c.json(result)
  }
)

export default signalNotificationRoutes

import { safeFetch } from '../lib/safe-fetch'
import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import {
  spamSettingsSchema,
  callSettingsSchema,
  messagingConfigSchema,
  telephonyProviderSchema,
  createRoleSchema,
  updateRoleSchema,
  addRoleEnvelopesSchema,
  webauthnSettingsSchema,
  transcriptionSettingsSchema,
  ivrLanguagesSchema,
  setupStateSchema,
  customFieldsBodySchema,
  createReportTypeBodySchema,
  updateReportTypeBodySchema,
  ttlOverridesBodySchema,
  roleResponseSchema,
  reportTypeResponseSchema,
  customFieldsListResponseSchema,
  roleListResponseSchema,
  reportTypeListResponseSchema,
  ivrAudioPromptsResponseSchema,
  successResponseSchema,
  permissionsCatalogResponseSchema,
  migrationStatusResponseSchema,
  cleanupMetricsResponseSchema,
  ttlOverridesResponseSchema,
} from '@protocol/schemas/settings'
import {
  geocodingConfigSchema,
  geocodingConfigAdminSchema,
  geocodingTestResponseSchema,
} from '@protocol/schemas/geocoding'
import { okResponseSchema, errorResponseSchema } from '@protocol/schemas/common'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { invalidateRolesCache } from '../services/settings'
import { validateExternalUrlWithDns } from '../lib/ssrf-guard'
import { getMessagingAdapterFromService } from '../lib/service-factories'
import { IVR_LANGUAGE_PATTERN, IVR_PROMPT_TYPE_PATTERN, ivrAudioFormatError } from '../lib/helpers'

const settings = new Hono<AppEnv>()

/**
 * Which hub a settings request targets. The hub the request was routed under
 * (`/hubs/:hubId/settings/...`, membership-checked by hubContext) always wins —
 * a `?hubId=` query must never redirect a hub-scoped request at another hub.
 * The query is only honoured on the platform-mounted route, where the caller
 * already needed the global permission. `undefined` = platform-wide values.
 */
function targetHubId(c: Context<AppEnv>): string | undefined {
  return (c.get('hubId') as string | undefined) || c.req.query('hubId') || undefined
}

// --- Transcription settings: readable + writable by settings:manage-transcription ---
settings.get('/transcription',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get transcription settings',
    responses: {
      200: {
        description: 'Transcription settings',
        content: {
          'application/json': {
            schema: resolver(transcriptionSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-transcription'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getTranscriptionSettings()
    return c.json(result)
  },
)

settings.patch('/transcription',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update transcription settings',
    responses: {
      200: {
        description: 'Transcription settings updated',
        content: {
          'application/json': {
            schema: resolver(transcriptionSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-transcription'),
  validator('json', transcriptionSettingsSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateTranscriptionSettings(body)
    await audit(services.audit, 'transcriptionToggled', pubkey, body as Record<string, unknown>, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- Custom fields: readable by settings:read (filtered by manage-fields), writable by admin ---
settings.get('/custom-fields',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get custom field definitions',
    responses: {
      200: {
        description: 'Custom field definitions',
        content: {
          'application/json': {
            schema: resolver(customFieldsListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const permissions = c.get('permissions')
    const canManageFields = checkPermission(permissions, 'settings:manage-fields')
    const services = c.get('services')
    const result = await services.settings.getCustomFields(canManageFields ? 'admin' : 'volunteer')
    return c.json(result)
  },
)

settings.put('/custom-fields',
  describeRoute({
    tags: ['Settings'],
    summary: 'Replace custom field definitions',
    responses: {
      200: {
        description: 'Custom fields updated',
        content: {
          'application/json': {
            schema: resolver(customFieldsListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-fields'),
  validator('json', customFieldsBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateCustomFields(body as unknown as Parameters<typeof services.settings.updateCustomFields>[0])
    await audit(services.audit, 'customFieldsUpdated', pubkey, {}, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- All remaining settings: require specific permissions ---
settings.get('/spam',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get spam mitigation settings',
    responses: {
      200: {
        description: 'Spam settings',
        content: {
          'application/json': {
            schema: resolver(spamSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-spam'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getSpamSettings(targetHubId(c))
    return c.json(result)
  },
)

settings.patch('/spam',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update spam mitigation settings',
    responses: {
      200: {
        description: 'Spam settings updated',
        content: {
          'application/json': {
            schema: resolver(spamSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-spam'),
  validator('json', spamSettingsSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = targetHubId(c)
    const result = await services.settings.updateSpamSettings(body, hubId)
    await audit(services.audit, 'spamMitigationToggled', pubkey, body as Record<string, unknown>, undefined, hubId ?? null)
    return c.json(result)
  },
)

settings.get('/call',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get call settings',
    responses: {
      200: {
        description: 'Call settings',
        content: {
          'application/json': {
            schema: resolver(callSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-calls'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getCallSettings(targetHubId(c))
    return c.json(result)
  },
)

settings.patch('/call',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update call settings',
    responses: {
      200: {
        description: 'Call settings updated',
        content: {
          'application/json': {
            schema: resolver(callSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-calls'),
  validator('json', callSettingsSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = targetHubId(c)
    const result = await services.settings.updateCallSettings(body, hubId)
    await audit(services.audit, 'callSettingsUpdated', pubkey, body as Record<string, unknown>, undefined, hubId ?? null)
    return c.json(result)
  },
)

settings.get('/ivr-languages',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get IVR language settings (optionally hub-scoped)',
    responses: {
      200: {
        description: 'IVR language settings',
        content: {
          'application/json': {
            schema: resolver(ivrLanguagesSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  async (c) => {
    const services = c.get('services')
    const hubId = targetHubId(c)
    const result = await services.settings.getIvrLanguages(hubId)
    return c.json(result)
  },
)

settings.patch('/ivr-languages',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update IVR language settings (optionally hub-scoped)',
    responses: {
      200: {
        description: 'IVR language settings updated',
        content: {
          'application/json': {
            schema: resolver(ivrLanguagesSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  validator('json', ivrLanguagesSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = targetHubId(c)
    const result = await services.settings.updateIvrLanguages(body as Parameters<typeof services.settings.updateIvrLanguages>[0], hubId)
    await audit(services.audit, 'ivrLanguagesUpdated', pubkey, { ...(body as Record<string, unknown>), hubId }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.get('/webauthn',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get WebAuthn settings',
    responses: {
      200: {
        description: 'WebAuthn settings',
        content: {
          'application/json': {
            schema: resolver(webauthnSettingsSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-webauthn'),
  async (c) => {
    const services = c.get('services')
    const result = await services.identity.getWebAuthnSettings()
    return c.json(result)
  },
)

settings.patch('/webauthn',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update WebAuthn settings',
    responses: {
      200: {
        description: 'WebAuthn settings updated',
        content: {
          'application/json': {
            schema: resolver(webauthnSettingsSchema),
          },
        },
      },
      ...authErrors,
      409: {
        description: 'Caller has no registered passkey and cannot enable requireForAdmins (code WEBAUTHN_CREDENTIAL_REQUIRED)',
        content: {
          'application/json': {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  requirePermission('settings:manage-webauthn'),
  validator('json', webauthnSettingsSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    // Self-lockout guard (#672): once requireForAdmins is on, the auth middleware
    // 403s every admin without a credential — including on this route, which is the
    // only way to turn the policy back off. The admin enabling it must already
    // satisfy it.
    if (body.requireForAdmins === true) {
      const { credentials } = await services.identity.getWebAuthnCredentials(pubkey)
      if (credentials.length === 0) {
        return c.json({
          error: 'Register a passkey before requiring passkeys for admins',
          code: 'WEBAUTHN_CREDENTIAL_REQUIRED',
        }, 409)
      }
    }
    const result = await services.identity.updateWebAuthnSettings(body)
    await audit(services.audit, 'webauthnSettingsUpdated', pubkey, body as Record<string, unknown>, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- Telephony Provider settings ---
settings.get('/telephony-provider',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get telephony provider settings',
    responses: {
      200: {
        description: 'Telephony provider settings',
        content: {
          'application/json': {
            schema: resolver(telephonyProviderSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  async (c) => {
    const services = c.get('services')
    const hmacSecret = c.env.HMAC_SECRET as string | undefined
    const hubId = c.get('hubId') as string | undefined
    const result = await services.settings.getTelephonyProvider(hmacSecret, hubId)
    return c.json(result)
  },
)

settings.patch('/telephony-provider',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update telephony provider settings',
    responses: {
      200: {
        description: 'Telephony provider settings updated',
        content: {
          'application/json': {
            schema: resolver(telephonyProviderSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  validator('json', telephonyProviderSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateTelephonyProvider(body as Parameters<typeof services.settings.updateTelephonyProvider>[0])
    await audit(services.audit, 'telephonyProviderChanged', pubkey, { type: body.type }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.post('/telephony-provider/test',
  describeRoute({
    tags: ['Settings'],
    summary: 'Test telephony provider credentials',
    responses: {
      200: {
        description: 'Provider test result',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  validator('json', telephonyProviderSchema),
  async (c) => {
    const body = c.req.valid('json')
    try {
      let testUrl: string
      const testHeaders: Record<string, string> = {}

      switch (body.type) {
        case 'twilio':
          // HIGH-W5: encodeURIComponent prevents SSRF via crafted accountSid (schema regex also guards)
          testUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(body.accountSid ?? '')}.json`
          testHeaders['Authorization'] = 'Basic ' + btoa(`${body.accountSid}:${body.authToken}`)
          break
        case 'signalwire': {
          if (!body.signalwireSpace || !/^[a-zA-Z0-9_-]+$/.test(body.signalwireSpace)) {
            return c.json({ error: 'Invalid SignalWire space name' }, 400)
          }
          testUrl = `https://${body.signalwireSpace}.signalwire.com/api/relay/rest/phone_numbers`
          testHeaders['Authorization'] = 'Basic ' + btoa(`${body.accountSid}:${body.authToken}`)
          break
        }
        case 'vonage':
          testUrl = `https://rest.nexmo.com/account/get-balance?api_key=${encodeURIComponent(body.apiKey || '')}&api_secret=${encodeURIComponent(body.apiSecret || '')}`
          break
        case 'plivo':
          testUrl = `https://api.plivo.com/v1/Account/${encodeURIComponent(body.authId || '')}/`
          testHeaders['Authorization'] = 'Basic ' + btoa(`${body.authId}:${body.authToken}`)
          break
        case 'asterisk': {
          if (!body.ariUrl) {
            return c.json({ error: 'ARI URL is required' }, 400)
          }
          const ariError = await validateExternalUrlWithDns(body.ariUrl, 'ARI URL')
          if (ariError) {
            return c.json({ error: ariError }, 400)
          }
          testUrl = `${body.ariUrl}/api/asterisk/info`
          testHeaders['Authorization'] = 'Basic ' + btoa(`${body.ariUsername}:${body.ariPassword}`)
          break
        }
        default:
          return c.json({ error: 'Unknown provider type' }, 400)
      }

      const testRes = await safeFetch(testUrl, { headers: testHeaders, ssrfGuard: true })
      if (testRes.ok) {
        return c.json({ ok: true })
      }
      return c.json({ error: `Provider returned ${testRes.status}` }, 400)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      return c.json({ error: message }, 400)
    }
  },
)

// --- Messaging config ---
settings.get('/messaging',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get messaging configuration',
    responses: {
      200: {
        description: 'Messaging configuration',
        content: {
          'application/json': {
            schema: resolver(messagingConfigSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getMessagingConfig()
    return c.json(result)
  },
)

settings.patch('/messaging',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update messaging configuration',
    responses: {
      200: {
        description: 'Messaging configuration updated',
        content: {
          'application/json': {
            schema: resolver(messagingConfigSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  validator('json', messagingConfigSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateMessagingConfig(body)
    await audit(services.audit, 'messagingConfigUpdated', pubkey, body as Record<string, unknown>, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.post('/messaging/test',
  describeRoute({
    tags: ['Settings'],
    summary: 'Test messaging channel connectivity',
    responses: {
      200: {
        description: 'Channel connectivity result',
        content: {
          'application/json': {
            schema: resolver(z.object({
              connected: z.boolean(),
              error: z.string().optional(),
            })),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  validator('json', z.object({ channel: z.string() })),
  async (c) => {
    const { channel } = c.req.valid('json')
    const services = c.get('services')
    const hmacSecret = c.env.HMAC_SECRET
    try {
      const adapter = await getMessagingAdapterFromService(
        channel as import('@shared/types').MessagingChannelType,
        services.settings,
        hmacSecret,
      )
      const status = await adapter.getChannelStatus()
      return c.json({ connected: status.connected, error: status.error })
    } catch (err) {
      return c.json({ connected: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
)

// --- Setup state ---
settings.get('/setup',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get setup wizard state',
    responses: {
      200: {
        description: 'Setup state',
        content: {
          'application/json': {
            schema: resolver(setupStateSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-setup'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getSetupState()
    return c.json(result)
  },
)

settings.patch('/setup',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update setup wizard state',
    responses: {
      200: {
        description: 'Setup state updated',
        content: {
          'application/json': {
            schema: resolver(setupStateSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-setup'),
  validator('json', setupStateSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateSetupState(body as Record<string, unknown> as Parameters<typeof services.settings.updateSetupState>[0])
    await audit(services.audit, 'setupStateUpdated', pubkey, body as Record<string, unknown>, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.get('/ivr-audio',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get IVR audio prompts',
    responses: {
      200: {
        description: 'IVR audio prompt metadata',
        content: {
          'application/json': {
            schema: resolver(ivrAudioPromptsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getIvrAudioList()
    return c.json(result)
  },
)

settings.get('/ivr-audio/:promptType/:language',
  describeRoute({
    tags: ['Settings'],
    summary: 'Download an IVR audio prompt (for the operator to listen back)',
    responses: {
      200: { description: 'The prompt as 8 kHz mono PCM WAV', content: { 'audio/wav': {} } },
      404: { description: 'No prompt uploaded for this type and language' },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  async (c) => {
    const promptType = c.req.param('promptType')
    const language = c.req.param('language')
    if (!IVR_PROMPT_TYPE_PATTERN.test(promptType) || !IVR_LANGUAGE_PATTERN.test(language)) {
      return c.json({ error: 'Invalid parameters' }, 400)
    }
    const services = c.get('services')
    const result = await services.settings.getIvrAudio(promptType, language)
    if (!result) return c.json({ error: 'Not found' }, 404)
    return c.body(Buffer.from(result.audio, 'base64'), 200, { 'Content-Type': 'audio/wav' })
  },
)

settings.put('/ivr-audio/:promptType/:language',
  describeRoute({
    tags: ['Settings'],
    summary: 'Upload IVR audio prompt',
    responses: {
      200: {
        description: 'Audio prompt uploaded',
        content: {
          'application/json': {
            schema: resolver(successResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  async (c) => {
    const pubkey = c.get('pubkey')
    const promptType = c.req.param('promptType')
    const language = c.req.param('language')
    if (!IVR_PROMPT_TYPE_PATTERN.test(promptType) || !IVR_LANGUAGE_PATTERN.test(language)) {
      return c.json({ error: 'Invalid parameters' }, 400)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    // Stored and served as audio/wav, and played by every provider: accept only
    // what they can play, judged by the bytes rather than the declared type.
    const formatError = ivrAudioFormatError(bytes)
    if (formatError) return c.json({ error: formatError }, 400)
    const services = c.get('services')
    const audioBase64 = Buffer.from(bytes).toString('base64')
    const result = await services.settings.uploadIvrAudio(promptType, language, audioBase64, bytes.byteLength)
    await audit(services.audit, 'ivrAudioUploaded', pubkey, { promptType, language }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.delete('/ivr-audio/:promptType/:language',
  describeRoute({
    tags: ['Settings'],
    summary: 'Delete IVR audio prompt',
    responses: {
      200: {
        description: 'Audio prompt deleted',
        content: {
          'application/json': {
            schema: resolver(successResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ivr'),
  async (c) => {
    const pubkey = c.get('pubkey')
    const promptType = c.req.param('promptType')
    const language = c.req.param('language')
    const services = c.get('services')
    const result = await services.settings.deleteIvrAudio(promptType, language)
    await audit(services.audit, 'ivrAudioDeleted', pubkey, { promptType, language }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- Report Types ---
settings.get('/report-types',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get report type definitions',
    responses: {
      200: {
        description: 'Report types',
        content: {
          'application/json': {
            schema: resolver(reportTypeListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getReportTypes()
    return c.json(result)
  },
)

settings.post('/report-types',
  describeRoute({
    tags: ['Settings'],
    summary: 'Create a report type',
    responses: {
      201: {
        description: 'Report type created',
        content: {
          'application/json': {
            schema: resolver(reportTypeResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-fields'),
  validator('json', createReportTypeBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.createReportType(body as Record<string, unknown> as Parameters<typeof services.settings.createReportType>[0])
    await audit(services.audit, 'reportTypeCreated', pubkey, { name: body.name }, undefined, targetHubId(c) ?? null)
    return c.json(result, 201)
  },
)

settings.patch('/report-types/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update a report type',
    responses: {
      200: {
        description: 'Report type updated',
        content: {
          'application/json': {
            schema: resolver(reportTypeResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-fields'),
  validator('json', updateReportTypeBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateReportType(id, body as Record<string, unknown> as Parameters<typeof services.settings.updateReportType>[1])
    await audit(services.audit, 'reportTypeUpdated', pubkey, { reportTypeId: id }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.delete('/report-types/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Delete a report type',
    responses: {
      200: {
        description: 'Report type deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-fields'),
  async (c) => {
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const services = c.get('services')
    const result = await services.settings.archiveReportType(id)
    await audit(services.audit, 'reportTypeArchived', pubkey, { reportTypeId: id }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- Roles (PBAC) ---
settings.get('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'List all roles',
    responses: {
      200: {
        description: 'List of roles',
        content: {
          'application/json': {
            schema: resolver(roleListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:view-roles'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getRoles()
    return c.json(result)
  },
)

settings.post('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'Create a custom role',
    responses: {
      201: {
        description: 'Role created',
        content: {
          'application/json': {
            schema: resolver(roleResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  validator('json', createRoleSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.createRole(body)
    invalidateRolesCache()
    await audit(services.audit, 'roleCreated', pubkey, { name: body.name }, undefined, targetHubId(c) ?? null)
    return c.json(result, 201)
  },
)

settings.patch('/roles/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update a role',
    responses: {
      200: {
        description: 'Role updated',
        content: {
          'application/json': {
            schema: resolver(roleResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  validator('json', updateRoleSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateRole(id, body)
    invalidateRolesCache()
    await audit(services.audit, 'roleUpdated', pubkey, { roleId: id }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.delete('/roles/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Delete a role',
    responses: {
      200: {
        description: 'Role deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  async (c) => {
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const services = c.get('services')
    const result = await services.settings.deleteRole(id)
    invalidateRolesCache()
    await audit(services.audit, 'roleDeleted', pubkey, { roleId: id }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.post('/roles/:id/envelopes',
  describeRoute({
    tags: ['Settings'],
    summary: 'Add or update HPKE envelopes for a platform role',
    responses: {
      200: {
        description: 'Envelopes updated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  validator('json', addRoleEnvelopesSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.addRoleEnvelopes(id, body.envelopes)
    invalidateRolesCache()
    await audit(services.audit, 'roleEnvelopesUpdated', pubkey, { roleId: id, count: body.envelopes.length }, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

settings.get('/users/:id/effective-permissions',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get effective permissions for a user',
    responses: {
      200: {
        description: 'Effective permissions',
        content: {
          'application/json': {
            schema: resolver(z.object({
              userId: z.string(),
              permissions: z.array(z.string()),
            })),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('users:read'),
  async (c) => {
    const id = c.req.param('id')
    const hubId = c.req.query('hubId') || undefined
    const services = c.get('services')
    const result = await services.settings.getEffectivePermissions(id, hubId)
    return c.json(result)
  },
)

// --- Permissions catalog ---
settings.get('/permissions',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get permissions catalog',
    responses: {
      200: {
        description: 'Permissions catalog',
        content: {
          'application/json': {
            schema: resolver(permissionsCatalogResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  async (c) => {
    const { PERMISSION_CATALOG, getPermissionsByDomain } = await import('@shared/permissions')
    return c.json({
      permissions: PERMISSION_CATALOG,
      byDomain: getPermissionsByDomain(),
    })
  },
)

// --- Migration Status (Epic 286) ---
// Returns migration status for all 7 DOs in a single response
settings.get('/migrations',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get migration status for all Durable Objects',
    responses: {
      200: {
        description: 'Migration status per DO namespace',
        content: {
          'application/json': {
            schema: resolver(migrationStatusResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  async (c) => {
    // Migration status is a DO-specific concept — return empty for service-based deployments
    return c.json({ namespaces: [], note: 'Service-based deployment — no DO migrations' })
  },
)

// --- TTL Overrides (admin-configurable cleanup intervals) ---
settings.get('/ttl',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get TTL override settings',
    responses: {
      200: {
        description: 'TTL override settings',
        content: {
          'application/json': {
            schema: resolver(ttlOverridesResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ttl'),
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getTTLOverrides()
    return c.json(result)
  },
)

settings.patch('/ttl',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update TTL override settings',
    responses: {
      200: {
        description: 'TTL overrides updated',
        content: {
          'application/json': {
            schema: resolver(ttlOverridesResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-ttl'),
  validator('json', ttlOverridesBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.settings.updateTTLOverrides(body as Record<string, unknown>)
    await audit(services.audit, 'ttlOverridesUpdated', pubkey, body as Record<string, unknown>, undefined, targetHubId(c) ?? null)
    return c.json(result)
  },
)

// --- Aggregated cleanup metrics from all DOs ---
settings.get('/cleanup-metrics',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get aggregated cleanup metrics',
    responses: {
      200: {
        description: 'Cleanup metrics from all DOs',
        content: {
          'application/json': {
            schema: resolver(cleanupMetricsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage'),
  async (c) => {
    const services = c.get('services')
    const settingsMetrics = await services.settings.getCleanupMetrics()
    return c.json({
      settings: settingsMetrics,
      identity: {},
      conversation: {},
    })
  },
)

// --- Geocoding config: readable by settings:read (API key omitted), writable by settings:manage ---
settings.get('/geocoding',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get geocoding configuration (API key omitted)',
    responses: {
      200: { description: 'Geocoding config', content: { 'application/json': { schema: resolver(geocodingConfigSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const config = await c.get('services').settings.getGeocodingConfig()
    return c.json(config)
  },
)

settings.put('/geocoding',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update geocoding configuration (admin only)',
    responses: {
      200: { description: 'Config updated', content: { 'application/json': { schema: resolver(geocodingConfigSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage'),
  validator('json', geocodingConfigAdminSchema),
  async (c) => {
    const body = c.req.valid('json')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    await services.settings.updateGeocodingConfig(body)
    await audit(services.audit, 'settings.geocoding.updated', pubkey, { provider: body.provider, enabled: body.enabled }, undefined, targetHubId(c) ?? null)
    return c.json({ provider: body.provider, countries: body.countries, enabled: body.enabled })
  },
)

settings.get('/geocoding/test',
  describeRoute({
    tags: ['Settings'],
    summary: 'Test geocoding connectivity (admin only)',
    responses: {
      200: { description: 'Test result', content: { 'application/json': { schema: resolver(geocodingTestResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage'),
  async (c) => {
    const config = await c.get('services').settings.getGeocodingConfigAdmin()
    const { createGeocodingAdapter } = await import('../geocoding/factory')
    const adapter = createGeocodingAdapter(config)
    const start = Date.now()
    try {
      await adapter.autocomplete('test', { limit: 1 })
      return c.json({ ok: true, latency: Date.now() - start })
    } catch {
      return c.json({ ok: false, latency: Date.now() - start })
    }
  },
)

export default settings

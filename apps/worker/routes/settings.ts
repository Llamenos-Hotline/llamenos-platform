import { safeFetch } from '../lib/safe-fetch'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import {
  spamSettingsSchema,
  spamSettingsPatchSchema,
  callSettingsSchema,
  messagingConfigSchema,
  telephonyProviderSchema,
  createRoleSchema,
  updateRoleSchema,
  createHubRoleSchema,
  updateHubRoleSchema,
  addRoleEnvelopesSchema,
  webauthnSettingsSchema,
  transcriptionSettingsSchema,
  ivrLanguagesSchema,
  ivrLanguageSettingsSchema,
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
  recordingPostureResponseSchema,
  recordingPostureEnforcementResponseSchema,
  type RecordingPostureResponse,
  type RecordingPostureEnforcementResponse,
} from '@protocol/schemas/settings'
import {
  callHistoryAccessSettingsSchema,
  callHistoryAccessSettingsPatchSchema,
} from '@protocol/schemas/calls'
import {
  geocodingConfigSchema,
  geocodingConfigAdminSchema,
  geocodingTestResponseSchema,
} from '@protocol/schemas/geocoding'
import { okResponseSchema, errorResponseSchema } from '@protocol/schemas/common'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { ServiceError } from '../services/settings'
import { validateExternalUrlWithDns } from '../lib/ssrf-guard'
import {
  getMessagingAdapterFromService,
  resolveHubTelephony,
  type ResolvedTelephony,
} from '../lib/service-factories'
import { buildProviderWebhookUrls, webhookOrigin } from '../lib/provider-webhook-urls'
import { TelegramAdapter } from '../messaging/telegram/adapter'
import { IVR_LANGUAGE_PATTERN, IVR_PROMPT_TYPE_PATTERN, ivrAudioFormatError } from '../lib/helpers'

/**
 * Settings live at two scopes, and which one a handler writes is decided by the
 * ROUTER it is registered on — never by whether a hub id happens to be present
 * when it runs (#2367). Handlers whose service call takes no hub id were
 * reached through `/hubs/:hubId/settings` and wrote the deployment row: a hub
 * admin rewrote every hub's messaging credentials, and the hub in the URL was
 * decoration.
 *
 * - `scoped`: settings each hub has its own value of, layered over a platform
 *   default. Mounted at `/api/settings` (the platform default) AND at
 *   `/api/hubs/:hubId/settings` (that hub's value). A handler here must resolve
 *   its hub with {@link targetHubId} / {@link ivrAudioHub} and pass it on.
 * - `deployment`: settings the whole deployment has exactly ONE of — the
 *   messaging sender every hub sends through, the login policy, the custom
 *   field and report-type vocabularies, TTLs, geocoding, the deployment-wide
 *   roles. Mounted ONLY at
 *   `/api/settings` ({@link hubSettingsRoutes} does not carry it), so under a
 *   hub these paths do not exist and no permission a hub can grant reaches
 *   them. A handler here never consults a hub.
 * - `deploymentReads`: deployment-wide values every hub's MEMBERS must read to
 *   do their work (the custom-field vocabulary a note is written in). Mounted
 *   on both, because a hub-only member holds no global role and the unscoped
 *   mount would refuse them. Reads only — a write here is the defect again.
 * - `hubOwned`: rows a hub owns outright — its own roles (#2780). Mounted ONLY
 *   at `/api/hubs/:hubId/settings`; there is no platform value to fall back to.
 *
 * A new setting goes on `deployment` unless it has a per-hub value. The set of
 * routes reachable under a hub is pinned by
 * `__tests__/unit/settings-scope-mounts.test.ts`, so putting one on `scoped`
 * is a decision a reviewer sees, not a default.
 */
const scoped = new Hono<AppEnv>()
const deployment = new Hono<AppEnv>()
const deploymentReads = new Hono<AppEnv>()
/**
 * Settings that exist ONLY per hub, with no platform default to layer over —
 * mounted only in {@link hubSettingsRoutes}. The volunteer call-history access
 * window (#1342) is one: it bounds what a hub's own members may read of the
 * hub's own calls, which is the hub's decision alone.
 */
const hubOnlySettings = new Hono<AppEnv>()

/**
 * Which hub a `scoped` settings request targets. The hub the request was routed
 * under (`/hubs/:hubId/settings/...`, membership-checked by hubContext) always
 * wins — a `?hubId=` query must never redirect a hub-scoped request at another
 * hub. The query is only honoured on the platform-mounted route, where the
 * caller already needed the global permission. `undefined` = platform-wide values.
 */
function targetHubId(c: Context<AppEnv>): string | undefined {
  return (c.get('hubId') as string | undefined) || c.req.query('hubId') || undefined
}

/**
 * IVR recordings are per hub. Under `/hubs/:hubId/settings/ivr-audio` a request
 * reaches only that hub's recordings. The global mount manages the PLATFORM
 * DEFAULTS that every hub falls back to until it records its own, so it needs
 * the instance-level permission on top of `settings:manage-ivr` — and it ignores
 * `?hubId=`, so there is exactly one way to name a hub. `undefined` = platform default.
 */
const ivrAudioHub = (c: Context<AppEnv>): string | undefined => (c.get('hubId') as string | undefined) || undefined

const requireIvrAudioScope = createMiddleware<AppEnv>(async (c, next) => {
  if (!ivrAudioHub(c) && !checkPermission(c.get('permissions'), 'system:manage-instance')) {
    return c.json({ error: 'Forbidden', required: 'system:manage-instance' }, 403)
  }
  await next()
})

// --- Transcription settings: readable + writable by settings:manage-transcription ---
deployment.get('/transcription',
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

deployment.patch('/transcription',
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
    await audit(services.audit, 'transcriptionToggled', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(result)
  },
)

// --- Custom fields: readable by settings:read (filtered by manage-fields), writable by admin ---
deploymentReads.get('/custom-fields',
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

deployment.put('/custom-fields',
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
    await audit(services.audit, 'customFieldsUpdated', pubkey, {}, undefined, null)
    return c.json(result)
  },
)

// --- All remaining settings: require specific permissions ---
scoped.get('/spam',
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

scoped.patch('/spam',
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
  validator('json', spamSettingsPatchSchema),
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

scoped.get('/call',
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

scoped.patch('/call',
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

scoped.get('/ivr-languages',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get IVR language settings (optionally hub-scoped)',
    responses: {
      200: {
        description: 'IVR language settings',
        content: {
          'application/json': {
            schema: resolver(ivrLanguageSettingsSchema),
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
    const result = await services.settings.getIvrLanguageSettings(hubId)
    return c.json(result)
  },
)

scoped.patch('/ivr-languages',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update IVR language settings (optionally hub-scoped)',
    responses: {
      200: {
        description: 'IVR language settings updated',
        content: {
          'application/json': {
            schema: resolver(ivrLanguageSettingsSchema),
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
    await services.settings.updateIvrLanguages(body as Parameters<typeof services.settings.updateIvrLanguages>[0], hubId)
    await audit(services.audit, 'ivrLanguagesUpdated', pubkey, { ...(body as Record<string, unknown>), hubId }, undefined, targetHubId(c) ?? null)
    return c.json(await services.settings.getIvrLanguageSettings(hubId))
  },
)

deployment.get('/webauthn',
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

deployment.patch('/webauthn',
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
    await audit(services.audit, 'webauthnSettingsUpdated', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(result)
  },
)

// --- Telephony Provider settings ---
scoped.get('/telephony-provider',
  describeRoute({
    tags: ['Settings'],
    summary: 'Get telephony provider settings',
    responses: {
      200: {
        // `null` until a provider is configured — every client decodes it as optional.
        description: 'Telephony provider settings, or null when none is configured',
        content: {
          'application/json': {
            schema: resolver(telephonyProviderSchema.nullable()),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') as string | undefined
    const result = await services.settings.getTelephonyProvider(c.env.SERVER_KEK, hubId)
    return c.json(result)
  },
)

scoped.patch('/telephony-provider',
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

type HubTelephony = ResolvedTelephony & { hubId: string }

/** The hub's adapter, its provider type and whose account it is — one resolution — or null when none is configured. */
async function hubTelephony(c: Context<AppEnv>): Promise<HubTelephony | null> {
  const hubId = (c.get('hubId') as string | undefined) ?? ''
  const resolved = await resolveHubTelephony(c.env, c.get('services').settings, hubId)
  return resolved ? { ...resolved, hubId } : null
}

async function readRecordingPosture(
  services: AppEnv['Variables']['services'],
  telephony: HubTelephony,
): Promise<RecordingPostureResponse> {
  const { hubId, adapter, provider } = telephony
  const [posture, heldAtProvider] = await Promise.all([
    adapter.probeRecordingPosture({
      trackedRecordings: (handles) => services.providerRecordings.trackedAmong(handles, adapter),
    }),
    services.providerRecordings.listHeld(hubId),
  ])
  return { provider, ...posture, heldAtProvider, retention: adapter.providerRetention() }
}

/**
 * #1505 / #2297 / #2309: what the hub's telephony provider does with caller
 * audio on its own, read with the hub's provider credentials — plus every
 * recording or call log this server asked the provider to make that the
 * provider has not yet confirmed deleting, and what the provider keeps that
 * this server cannot remove. Each reading is evidence-backed; a setting the
 * probe could not read is `unknown` with the reason, never `off`.
 */
scoped.get('/telephony-provider/recording-posture',
  describeRoute({
    tags: ['Settings'],
    summary: 'Read provider-side recording and transcription, what is still held at the provider, and what it retains',
    responses: {
      200: {
        description: 'Recording posture',
        content: { 'application/json': { schema: resolver(recordingPostureResponseSchema) } },
      },
      404: { description: 'No telephony provider is configured' },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  async (c) => {
    const telephony = await hubTelephony(c)
    if (!telephony) return c.json({ error: 'No telephony provider is configured' }, 404)
    return c.json(await readRecordingPosture(c.get('services'), telephony))
  },
)

/**
 * #2309: the write companion of the probe. Turns off every provider-side
 * recording and transcription setting the provider's API lets us change, then
 * RE-READS the posture — the re-read, not the write, is what says a setting is
 * now off. Every attempt, including a refusal or a setting the API cannot
 * change, is returned and recorded on the hub's audit chain. Enforcing on the
 * shared platform account (a hub with no provider of its own) also needs
 * `system:manage-instance`.
 */
scoped.post('/telephony-provider/recording-posture/enforce',
  describeRoute({
    tags: ['Settings'],
    summary: 'Turn off provider-side recording and transcription wherever the provider API allows, then re-read the posture',
    responses: {
      200: {
        description: 'What was changed, and the posture read afterwards',
        content: { 'application/json': { schema: resolver(recordingPostureEnforcementResponseSchema) } },
      },
      404: { description: 'No telephony provider is configured' },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-telephony'),
  async (c) => {
    const services = c.get('services')
    const telephony = await hubTelephony(c)
    if (!telephony) return c.json({ error: 'No telephony provider is configured' }, 404)
    // A hub without a provider of its own runs on the PLATFORM account, which
    // other hubs share: changing its settings is an instance-level act, not a
    // hub admin's. `source` comes from the same resolution that built the
    // adapter about to be written through.
    if (telephony.source !== 'hub' && !checkPermission(c.get('permissions'), 'system:manage-instance')) {
      return c.json({ error: 'Forbidden', required: 'system:manage-instance' }, 403)
    }
    const actions = await telephony.adapter.enforceRecordingPosture()
    await audit(services.audit, 'providerRecordingPostureEnforced', c.get('pubkey'), {
      provider: telephony.provider,
      actions: actions.map(a => ({
        setting: a.setting,
        target: a.target,
        outcome: a.outcome,
        detail: ('evidence' in a ? a.evidence : a.reason).slice(0, 300),
      })),
    }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, telephony.hubId || null)
    const body: RecordingPostureEnforcementResponse = {
      actions,
      posture: await readRecordingPosture(services, telephony),
    }
    return c.json(body)
  },
)

scoped.post('/telephony-provider/test',
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
deployment.get('/messaging',
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

deployment.patch('/messaging',
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
    await audit(services.audit, 'messagingConfigUpdated', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(result)
  },
)

deployment.post('/messaging/test',
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
    try {
      const adapter = await getMessagingAdapterFromService(
        channel as import('@shared/types').MessagingChannelType,
        services.settings,
        services.messagingSuppression,
      )
      const status = await adapter.getChannelStatus()
      return c.json({ connected: status.connected, error: status.error })
    } catch (err) {
      return c.json({ connected: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
)

// Telegram only sends the X-Telegram-Bot-Api-Secret-Token header (which the
// adapter requires on every inbound webhook) if the webhook was registered with
// a secret_token, so registering it is part of setting the channel up (#2154).
// The URL must name the hub the bot's messages belong to: the bot is
// deployment-wide, and the inbound router refuses a message that names no hub
// (#2395), so a hubless registration would silently drop every message.
deployment.post('/messaging/telegram/register-webhook',
  describeRoute({
    tags: ['Settings'],
    summary: 'Register the Telegram webhook with the configured secret_token',
    responses: {
      200: {
        description: 'Telegram accepted the webhook registration',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      502: {
        description: 'Telegram refused or could not be reached',
        content: {
          'application/json': {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-messaging'),
  validator('query', z.object({ hubId: z.string().min(1) })),
  async (c) => {
    const services = c.get('services')
    const { hubId } = c.req.valid('query')
    await services.settings.getHub(hubId)
    let adapter: Awaited<ReturnType<typeof getMessagingAdapterFromService>>
    try {
      adapter = await getMessagingAdapterFromService(
        'telegram',
        services.settings,
        services.messagingSuppression,
        c.env.WEBHOOK_BASE_URL ?? '',
      )
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
    if (!(adapter instanceof TelegramAdapter)) {
      return c.json({ error: 'Telegram is not configured' }, 400)
    }
    const url = buildProviderWebhookUrls(webhookOrigin(c.env), hubId).messaging.telegram
    const result = await adapter.registerWebhook(url)
    if (!result.ok) {
      return c.json({ error: result.error ?? 'Telegram setWebhook failed' }, 502)
    }
    return c.json({ ok: true })
  },
)

// --- Setup state ---
deployment.get('/setup',
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

deployment.patch('/setup',
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
    await audit(services.audit, 'setupStateUpdated', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(result)
  },
)

scoped.get('/ivr-audio',
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
  requireIvrAudioScope,
  async (c) => {
    const services = c.get('services')
    const result = await services.settings.getIvrAudioList(ivrAudioHub(c))
    return c.json(result)
  },
)

scoped.get('/ivr-audio/:promptType/:language',
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
  requireIvrAudioScope,
  async (c) => {
    const promptType = c.req.param('promptType')
    const language = c.req.param('language')
    if (!IVR_PROMPT_TYPE_PATTERN.test(promptType) || !IVR_LANGUAGE_PATTERN.test(language)) {
      return c.json({ error: 'Invalid parameters' }, 400)
    }
    const services = c.get('services')
    const result = await services.settings.getIvrAudio(ivrAudioHub(c), promptType, language)
    if (!result) return c.json({ error: 'Not found' }, 404)
    return c.body(Buffer.from(result.audio, 'base64'), 200, { 'Content-Type': 'audio/wav' })
  },
)

scoped.put('/ivr-audio/:promptType/:language',
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
  requireIvrAudioScope,
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
    const result = await services.settings.uploadIvrAudio(ivrAudioHub(c), promptType, language, audioBase64, bytes.byteLength)
    await audit(services.audit, 'ivrAudioUploaded', pubkey, { promptType, language }, undefined, ivrAudioHub(c) ?? null)
    return c.json(result)
  },
)

scoped.delete('/ivr-audio/:promptType/:language',
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
  requireIvrAudioScope,
  async (c) => {
    const pubkey = c.get('pubkey')
    const promptType = c.req.param('promptType')
    const language = c.req.param('language')
    const services = c.get('services')
    const result = await services.settings.deleteIvrAudio(ivrAudioHub(c), promptType, language)
    await audit(services.audit, 'ivrAudioDeleted', pubkey, { promptType, language }, undefined, ivrAudioHub(c) ?? null)
    return c.json(result)
  },
)

// --- Report Types ---
deployment.get('/report-types',
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

deployment.post('/report-types',
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
    await audit(services.audit, 'reportTypeCreated', pubkey, { name: body.name }, undefined, null)
    return c.json(result, 201)
  },
)

deployment.patch('/report-types/:id',
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
    await audit(services.audit, 'reportTypeUpdated', pubkey, { reportTypeId: id }, undefined, null)
    return c.json(result)
  },
)

deployment.delete('/report-types/:id',
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
    await audit(services.audit, 'reportTypeArchived', pubkey, { reportTypeId: id }, undefined, null)
    return c.json(result)
  },
)

// --- Roles (PBAC) ---
deployment.get('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'List the deployment-wide roles',
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
    // Deployment-wide roles only: a hub's own roles are listed under that hub.
    const result = await services.settings.listRoles(null)
    return c.json(result)
  },
)

deployment.post('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'Create a platform (deployment-wide) role — name and description only in per-admin envelopes',
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
    // The id only: a role's name is sealed, and the audit log is not where it leaks.
    await audit(services.audit, 'roleCreated', pubkey, { roleId: result.id }, undefined, null)
    return c.json(result, 201)
  },
)

deployment.patch('/roles/:id',
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
    await audit(services.audit, 'roleUpdated', pubkey, { roleId: id }, undefined, null)
    return c.json(result)
  },
)

deployment.delete('/roles/:id',
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
    await audit(services.audit, 'roleDeleted', pubkey, { roleId: id }, undefined, null)
    return c.json(result)
  },
)

deployment.post('/roles/:id/envelopes',
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
    await audit(services.audit, 'roleEnvelopesUpdated', pubkey, { roleId: id, count: body.envelopes.length }, undefined, null)
    return c.json(result)
  },
)

deployment.get('/users/:id/effective-permissions',
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
deployment.get('/permissions',
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
deployment.get('/migrations',
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
deployment.get('/ttl',
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
    const { overrides } = await services.settings.getTTLOverrides()
    // Bare, like the PATCH body: the declared shape is the key → seconds record itself.
    return c.json(overrides)
  },
)

deployment.patch('/ttl',
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
    const { overrides } = await services.settings.updateTTLOverrides(body as Record<string, unknown>)
    await audit(services.audit, 'ttlOverridesUpdated', pubkey, body as Record<string, unknown>, undefined, null)
    return c.json(overrides)
  },
)

// --- Aggregated cleanup metrics from all DOs ---
deployment.get('/cleanup-metrics',
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
deployment.get('/geocoding',
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

deployment.put('/geocoding',
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
    await audit(services.audit, 'settings.geocoding.updated', pubkey, { provider: body.provider, enabled: body.enabled }, undefined, null)
    return c.json({ provider: body.provider, countries: body.countries, enabled: body.enabled })
  },
)

deployment.get('/geocoding/test',
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

// --- Hub-owned roles (#2780) ---
//
// A role a hub defines for itself. Its name and description are sealed on the
// client under that hub's key (`LABEL_HUB_ROLE_ENCRYPT`), so they are readable
// by exactly the hub's members — the hub key's reader set, which the hub-admin
// invariant keeps non-empty — and by nobody the hub did not admit, the server
// and a super-admin outside the hub included. The rows belong to a hub, so this
// router is mounted ONLY under `/api/hubs/:hubId/settings`.
const hubOwned = new Hono<AppEnv>()

/** The hub this request is routed under. hubContext has already admitted the caller to it. */
function owningHub(c: Context<AppEnv>): string {
  const hubId = c.get('hubId') as string | undefined
  if (!hubId) throw new ServiceError(400, 'Hub-owned roles are only reachable under /hubs/:hubId')
  return hubId
}

/**
 * The grant ceiling, as `checkRoleGrant` applies it to assignments: whoever
 * defines a role must already hold every permission they write into it.
 */
function roleCeilingDenied(c: Context<AppEnv>, permissions: readonly string[] | undefined): string | null {
  const held = c.get('permissions')
  const missing = (permissions ?? []).find(p => !checkPermission(held, p))
  return missing ? `Cannot define a role carrying '${missing}' — you lack it` : null
}

hubOwned.get('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'List the roles this hub offers: the deployment-wide roles and the hub\'s own',
    responses: {
      200: { description: 'Roles', content: { 'application/json': { schema: resolver(roleListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('system:view-roles'),
  async (c) => {
    const services = c.get('services')
    return c.json(await services.settings.listRoles(owningHub(c)))
  },
)

hubOwned.post('/roles',
  describeRoute({
    tags: ['Settings'],
    summary: 'Create a role owned by this hub — name and description sealed under the hub key',
    responses: {
      201: { description: 'Role created', content: { 'application/json': { schema: resolver(roleResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  validator('json', createHubRoleSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = owningHub(c)
    const body = c.req.valid('json')
    const denied = roleCeilingDenied(c, body.permissions)
    if (denied) return c.json({ error: denied }, 403)
    const result = await services.settings.createHubRole(hubId, body)
    await audit(services.audit, 'roleCreated', c.get('pubkey'), { roleId: result.id }, undefined, hubId)
    return c.json(result, 201)
  },
)

hubOwned.patch('/roles/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Update a role owned by this hub',
    responses: {
      200: { description: 'Role updated', content: { 'application/json': { schema: resolver(roleResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  validator('json', updateHubRoleSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = owningHub(c)
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const denied = roleCeilingDenied(c, body.permissions)
    if (denied) return c.json({ error: denied }, 403)
    const result = await services.settings.updateHubRole(hubId, id, body)
    await audit(services.audit, 'roleUpdated', c.get('pubkey'), { roleId: id }, undefined, hubId)
    return c.json(result)
  },
)

hubOwned.delete('/roles/:id',
  describeRoute({
    tags: ['Settings'],
    summary: 'Delete a role owned by this hub',
    responses: {
      200: { description: 'Role deleted', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('system:manage-roles'),
  async (c) => {
    const services = c.get('services')
    const hubId = owningHub(c)
    const id = c.req.param('id')
    const result = await services.settings.deleteHubRole(hubId, id)
    await audit(services.audit, 'roleDeleted', c.get('pubkey'), { roleId: id }, undefined, hubId)
    return c.json(result)
  },
)

// --- Volunteer call-history access window (#1342): hub-only ---
//
// ACCESS retention, not data retention: it narrows what a holder of only
// `calls:read-own-history` is served, and deletes nothing. Changes are audited
// with the window before and after.

hubOnlySettings.get('/call-history-access',
  describeRoute({
    tags: ['Settings'],
    summary: "Get the hub's volunteer call-history access window",
    responses: {
      200: {
        description: 'Access window',
        content: { 'application/json': { schema: resolver(callHistoryAccessSettingsSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-calls'),
  async (c) => {
    const result = await c.get('services').settings.getCallHistoryAccess(c.get('hubId') as string)
    return c.json(result)
  },
)

hubOnlySettings.patch('/call-history-access',
  describeRoute({
    tags: ['Settings'],
    summary: "Change the hub's volunteer call-history access window",
    responses: {
      200: {
        description: 'Access window after the change',
        content: { 'application/json': { schema: resolver(callHistoryAccessSettingsSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-calls'),
  validator('json', callHistoryAccessSettingsPatchSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') as string
    const { before, after } = await services.settings.updateCallHistoryAccess(hubId, c.req.valid('json'))
    if (before.volunteerAccessDays !== after.volunteerAccessDays) {
      await audit(services.audit, 'callHistoryAccessUpdated', c.get('pubkey'), {
        oldVolunteerAccessDays: before.volunteerAccessDays,
        newVolunteerAccessDays: after.volunteerAccessDays,
      }, undefined, hubId)
    }
    return c.json(after)
  },
)

/** `/api/settings` — the platform defaults of the per-hub settings, and every deployment-wide setting. */
const settingsRoutes = new Hono<AppEnv>()
settingsRoutes.route('/', scoped)
settingsRoutes.route('/', deploymentReads)
settingsRoutes.route('/', deployment)
export default settingsRoutes

/**
 * `/api/hubs/:hubId/settings` — the settings a hub has its own value of, and
 * the deployment vocabulary its members read. Every deployment-wide write is
 * deliberately absent: a hub admin reaching `/hubs/A/settings/messaging` gets
 * a 404, not the shared sender credentials.
 */
export const hubSettingsRoutes = new Hono<AppEnv>()
hubSettingsRoutes.route('/', scoped)
hubSettingsRoutes.route('/', hubOnlySettings)
hubSettingsRoutes.route('/', deploymentReads)
hubSettingsRoutes.route('/', hubOwned)

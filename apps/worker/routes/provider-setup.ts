import { safeFetch } from '../lib/safe-fetch'
import { isAllowedOAuthRedirectUrl } from '../lib/redirect-guard'
import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { checkRateLimit } from '../lib/helpers'
import { authErrors, notFoundError } from '../openapi/helpers'
import {
  startOAuthRequestSchema,
  startOAuthResponseSchema,
  configureProviderRequestSchema,
  providerStatusResponseSchema,
  numberSearchQuerySchema,
  numberProvisionRequestSchema,
  oauthFlowStateSchema,
  ownedNumberSchema,
  availableNumberSchema,
  signalRegistrationStateSchema,
  a2pRegistrationStateSchema,
} from '@protocol/schemas/provider-setup'
import { okResponseSchema } from '@protocol/schemas/common'
import { getProviderCapability } from '../services/provider-setup/registry'
import { ProviderApiError } from '../services/provider-setup/types'
import { SignalRegistrationError } from '../services/provider-setup/signal-registration'
import { A2pRegistrationError } from '../services/provider-setup/a2p-registration'
import { audit } from '../services/audit'
import { permissionGranted, resolvePermissions, resolveHubPermissions } from '@shared/permissions'

/**
 * When a non-hub-scoped route receives hubId from the request body/query,
 * validate that the user has access to that hub (either super-admin or hub member
 * with appropriate permissions). Returns the validated hubId or null if no hubId.
 * Throws ProviderApiError(403) if the user lacks access.
 */
function validateBodyHubAccess(c: Context<AppEnv>, bodyHubId?: string, requiredPermission?: string): string | undefined {
  const hubId = c.get('hubId') ?? bodyHubId
  if (!hubId) return undefined

  // If hubId comes from hub context middleware, it's already validated
  if (c.get('hubId')) return hubId

  // hubId came from request body — validate access
  const user = c.get('user')
  const allRoles = c.get('allRoles')

  // Super-admin bypasses hub membership checks
  const globalPerms = resolvePermissions(user.roles, allRoles)
  if (permissionGranted(globalPerms, '*')) return hubId

  // Non-super-admin must have hub membership with the required permission
  const hubPerms = resolveHubPermissions(user.roles, user.hubRoles || [], allRoles, hubId)
  if (hubPerms.length === 0) {
    throw new ProviderApiError('Access denied', 403, 'No hub access')
  }
  if (requiredPermission && !permissionGranted(hubPerms, requiredPermission)) {
    throw new ProviderApiError('Insufficient permissions', 403, 'Missing hub permission')
  }

  return hubId
}


/** Read OAuth client_id from environment for a provider. */
function getOAuthClientId(provider: string): string {
  const envKey = `${provider.toUpperCase()}_CLIENT_ID`
  return process.env[envKey] ?? ''
}

/** Read OAuth client_secret from environment for a provider. */
function getOAuthClientSecret(provider: string): string {
  const envKey = `${provider.toUpperCase()}_CLIENT_SECRET`
  return process.env[envKey] ?? ''
}

// Per-provider OAuth metadata — authorization URLs, token URLs, and default scopes.
const PROVIDER_OAUTH_CONFIG: Record<string, {
  authorizationUrl: string
  tokenUrl: string
  defaultScopes: string[]
}> = {
  twilio: {
    authorizationUrl: 'https://login.twilio.com/authorize',
    tokenUrl: 'https://login.twilio.com/oauth2/token',
    defaultScopes: ['voice_data', 'messaging_data'],
  },
  signalwire: {
    authorizationUrl: 'https://oauth.signalwire.com/authorize',
    tokenUrl: 'https://oauth.signalwire.com/token',
    defaultScopes: ['full'],
  },
  telnyx: {
    authorizationUrl: 'https://api.telnyx.com/oauth2/authorize',
    tokenUrl: 'https://api.telnyx.com/oauth2/token',
    defaultScopes: ['phone_numbers:read', 'phone_numbers:write'],
  },
  vonage: {
    authorizationUrl: 'https://api.nexmo.com/oauth2/authorize',
    tokenUrl: 'https://api.nexmo.com/oauth2/token',
    defaultScopes: ['default'],
  },
  bandwidth: {
    authorizationUrl: 'https://accounts.bandwidth.com/oauth2/authorize',
    tokenUrl: 'https://accounts.bandwidth.com/oauth2/token',
    defaultScopes: ['phone_numbers:read', 'phone_numbers:write'],
  },
}

const OAuthCallbackBodySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
})

const ConfigureWebhooksRequestSchema = z.object({
  provider: z.string(),
  numberId: z.string(),
  enableSms: z.boolean().optional().default(false),
  hubId: z.string().optional(),
})

const CreateSipTrunkRequestSchema = z.object({
  provider: z.string(),
  /** Per provider: where a hosted provider sends calls, or the carrier a self-hosted PBX trunks to */
  domain: z.string().min(1),
  /** Carrier-issued credentials for a registration trunk (self-hosted PBX); both or neither */
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  /** Addresses the carrier sends calls from; defaults to the carrier host */
  inboundMatch: z.array(z.string().min(1)).min(1).optional(),
  hubId: z.string().optional(),
})

const TestConnectionRequestSchema = z.object({
  provider: z.string(),
  hubId: z.string().optional(),
})

const ownedNumberListSchema = z.object({ numbers: z.array(ownedNumberSchema) })
const availableNumberListSchema = z.object({ numbers: z.array(availableNumberSchema) })

const providerSetup = new Hono<AppEnv>()

// ── OAuth Start ────────────────────────────────────────────────────────────
providerSetup.post('/oauth/start',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Start OAuth flow for a telephony provider',
    responses: {
      200: {
        description: 'OAuth redirect URL and state token',
        content: { 'application/json': { schema: resolver(startOAuthResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', startOAuthRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    if (!isAllowedOAuthRedirectUrl(body.redirectUrl, c.env)) {
      return c.json({ error: 'Invalid redirect URL: must be the app deep link or a configured origin' }, 400)
    }

    const oauthConfig = PROVIDER_OAUTH_CONFIG[body.provider]
    if (!oauthConfig) {
      return c.json({ error: `Provider ${body.provider} does not support OAuth` }, 400)
    }

    const hubId = c.get('hubId')
    const { stateId, expiresAt } = await services.providerSetup.createOAuthState({
      provider: body.provider,
      redirectUrl: body.redirectUrl,
      callbackScheme: body.redirectUrl,
      hubId,
    })

    const clientId = getOAuthClientId(body.provider)
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      state: stateId,
      scope: oauthConfig.defaultScopes.join(' '),
      redirect_uri: body.redirectUrl,
    })
    const authUrl = `${oauthConfig.authorizationUrl}?${params.toString()}`

    return c.json({
      authUrl,
      stateId,
      expiresAt: expiresAt.toISOString(),
    })
  },
)

// ── OAuth Callback ─────────────────────────────────────────────────────────
// No auth check — the state token IS proof of authorization
providerSetup.post('/oauth/callback',
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Handle OAuth callback (no auth — state token is proof)',
    responses: {
      302: { description: 'Redirect to client callback URL' },
      400: { description: 'Invalid state token' },
    },
  }),
  validator('json', OAuthCallbackBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const { code, state, error: oauthError } = body

    if (!state) {
      return c.json({ error: 'Missing state parameter' }, 400)
    }

    const services = c.get('services')
    const stateRow = await services.providerSetup.getOAuthState(state)

    if (!stateRow) {
      return c.json({ error: 'Unknown or expired state token' }, 400)
    }

    if (stateRow.status !== 'pending') {
      return c.json({ error: 'State token already used' }, 400)
    }

    if (new Date() > stateRow.expiresAt) {
      await services.providerSetup.failOAuthState(state)
      return c.json({ error: 'State token expired' }, 400)
    }

    // Defense-in-depth: re-validate the stored redirectUrl before using it.
    // The /oauth/start handler validates on write, but an older state row may
    // predate that check. Reject any URL that doesn't match the allowlist.
    if (!isAllowedOAuthRedirectUrl(stateRow.redirectUrl, c.env)) {
      await services.providerSetup.failOAuthState(state)
      return c.json({ error: 'Stored redirect URL is not allowed' }, 400)
    }

    // For non-HTTP redirect URLs (e.g. app:// deep links), return JSON instead of HTTP redirect.
    // Native clients read the redirectUrl field and open it via the OS deep link handler.
    const isHttpRedirect = stateRow.redirectUrl.startsWith('http://') || stateRow.redirectUrl.startsWith('https://')
    const oauthRedirect = (urlWithParams: string) =>
      isHttpRedirect ? c.redirect(urlWithParams) : c.json({ redirectUrl: urlWithParams }, 200)

    if (oauthError || !code) {
      await services.providerSetup.failOAuthState(state)
      const redirectUrl = `${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(oauthError ?? 'Authorization denied')}`
      return oauthRedirect(redirectUrl)
    }

    const oauthConfig = PROVIDER_OAUTH_CONFIG[stateRow.provider]
    if (!oauthConfig) {
      await services.providerSetup.failOAuthState(state)
      const redirectUrl = `${stateRow.redirectUrl}?status=error&message=Provider+not+configured`
      return oauthRedirect(redirectUrl)
    }

    try {
      const clientId = getOAuthClientId(stateRow.provider)
      const clientSecret = getOAuthClientSecret(stateRow.provider)
      const tokenRes = await safeFetch(oauthConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: stateRow.redirectUrl,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })

      if (!tokenRes.ok) {
        await services.providerSetup.failOAuthState(state)
        const redirectUrl = `${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(`Token exchange failed: ${tokenRes.status}`)}`
        return oauthRedirect(redirectUrl)
      }

      const tokenData = await tokenRes.json() as Record<string, unknown>
      const credentials = {
        accessToken: String(tokenData.access_token ?? ''),
        refreshToken: String(tokenData.refresh_token ?? ''),
        tokenType: String(tokenData.token_type ?? ''),
        scope: String(tokenData.scope ?? ''),
      }

      const impl = getProviderCapability(stateRow.provider as Parameters<typeof getProviderCapability>[0])
      const capabilities = (impl?.capabilities ?? []) as string[]

      await services.providerSetup.completeOAuthState(state, credentials, capabilities, stateRow.hubId ?? null)

      return oauthRedirect(`${stateRow.redirectUrl}?status=success`)
    } catch (err) {
      await services.providerSetup.failOAuthState(state)
      const message = err instanceof Error ? err.message : 'OAuth flow failed'
      return oauthRedirect(`${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(message)}`)
    }
  },
)

// ── OAuth Callback (GET) — most OAuth providers redirect via GET with query params
providerSetup.get('/oauth/callback',
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Handle OAuth callback via GET redirect (no auth — state token is proof)',
    responses: {
      302: { description: 'Redirect to client callback URL' },
      400: { description: 'Invalid state token' },
    },
  }),
  async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const oauthError = c.req.query('error')

    if (!state) {
      return c.json({ error: 'Missing state parameter' }, 400)
    }

    const services = c.get('services')
    const stateRow = await services.providerSetup.getOAuthState(state)

    if (!stateRow) {
      return c.json({ error: 'Unknown or expired state token' }, 400)
    }

    if (stateRow.status !== 'pending') {
      return c.json({ error: 'State token already used' }, 400)
    }

    if (new Date() > stateRow.expiresAt) {
      await services.providerSetup.failOAuthState(state)
      return c.json({ error: 'State token expired' }, 400)
    }

    // Defense-in-depth: re-validate the stored redirectUrl before using it.
    if (!isAllowedOAuthRedirectUrl(stateRow.redirectUrl, c.env)) {
      await services.providerSetup.failOAuthState(state)
      return c.json({ error: 'Stored redirect URL is not allowed' }, 400)
    }

    const isHttpRedirect = stateRow.redirectUrl.startsWith('http://') || stateRow.redirectUrl.startsWith('https://')
    const oauthRedirect = (urlWithParams: string) =>
      isHttpRedirect ? c.redirect(urlWithParams) : c.json({ redirectUrl: urlWithParams }, 200)

    if (oauthError || !code) {
      await services.providerSetup.failOAuthState(state)
      const redirectUrl = `${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(oauthError ?? 'Authorization denied')}`
      return oauthRedirect(redirectUrl)
    }

    const oauthConfig = PROVIDER_OAUTH_CONFIG[stateRow.provider]
    if (!oauthConfig) {
      await services.providerSetup.failOAuthState(state)
      const redirectUrl = `${stateRow.redirectUrl}?status=error&message=Provider+not+configured`
      return oauthRedirect(redirectUrl)
    }

    try {
      const clientId = getOAuthClientId(stateRow.provider)
      const clientSecret = getOAuthClientSecret(stateRow.provider)
      const tokenRes = await safeFetch(oauthConfig.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: stateRow.redirectUrl,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })

      if (!tokenRes.ok) {
        await services.providerSetup.failOAuthState(state)
        const redirectUrl = `${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(`Token exchange failed: ${tokenRes.status}`)}`
        return oauthRedirect(redirectUrl)
      }

      const tokenData = await tokenRes.json() as Record<string, unknown>
      const credentials = {
        accessToken: String(tokenData.access_token ?? ''),
        refreshToken: String(tokenData.refresh_token ?? ''),
        tokenType: String(tokenData.token_type ?? ''),
        scope: String(tokenData.scope ?? ''),
      }

      const impl = getProviderCapability(stateRow.provider as Parameters<typeof getProviderCapability>[0])
      const capabilities = (impl?.capabilities ?? []) as string[]

      await services.providerSetup.completeOAuthState(state, credentials, capabilities, stateRow.hubId ?? null)

      return oauthRedirect(`${stateRow.redirectUrl}?status=success`)
    } catch (err) {
      await services.providerSetup.failOAuthState(state)
      const message = err instanceof Error ? err.message : 'OAuth flow failed'
      return oauthRedirect(`${stateRow.redirectUrl}?status=error&message=${encodeURIComponent(message)}`)
    }
  },
)

// ── OAuth Status ───────────────────────────────────────────────────────────
providerSetup.get('/oauth/status/:state',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Get OAuth flow state',
    responses: {
      200: {
        description: 'OAuth flow state',
        content: { 'application/json': { schema: resolver(oauthFlowStateSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const stateId = c.req.param('state')
    const services = c.get('services')

    const stateRow = await services.providerSetup.getOAuthState(stateId)
    if (!stateRow) {
      return c.json({ error: 'State not found' }, 404)
    }

    return c.json({
      id: stateRow.id,
      provider: stateRow.provider,
      status: stateRow.status,
      redirectUrl: stateRow.redirectUrl,
      callbackScheme: stateRow.callbackScheme ?? undefined,
      error: stateRow.error ?? undefined,
      expiresAt: stateRow.expiresAt.toISOString(),
      createdAt: stateRow.createdAt.toISOString(),
    })
  },
)

// ── Configure Provider ─────────────────────────────────────────────────────
providerSetup.post('/configure',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Configure a telephony provider with credentials',
    responses: {
      200: {
        description: 'Provider configured',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', configureProviderRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const hubId = validateBodyHubAccess(c, body.hubId, 'telephony:manage-providers')
      await services.providerSetup.configure(
        body.provider,
        body.credentials ?? {},
        hubId,
        body.phoneNumber,
      )
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Test Connection ────────────────────────────────────────────────────────
providerSetup.post('/test',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Test a stored provider connection',
    responses: {
      200: {
        description: 'Connection test result',
        content: {
          'application/json': {
            schema: resolver(z.object({
              connected: z.boolean(),
              latencyMs: z.number(),
              accountName: z.string().optional(),
              error: z.string().optional(),
              errorType: z.string().optional(),
            })),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', TestConnectionRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId')

    const result = await services.providerSetup.testConnection(
      body.provider as Parameters<typeof services.providerSetup.testConnection>[0],
      hubId ?? body.hubId,
    )
    return c.json(result)
  },
)

// ── Provider Status ────────────────────────────────────────────────────────
providerSetup.get('/status/:provider',
  requirePermission('telephony:view-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Get provider configuration status',
    responses: {
      200: {
        description: 'Provider status',
        content: { 'application/json': { schema: resolver(providerStatusResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const provider = c.req.param('provider')
    const services = c.get('services')
    const hubId = c.get('hubId')

    const result = await services.providerSetup.getProviderStatus(
      provider as Parameters<typeof services.providerSetup.getProviderStatus>[0],
      hubId,
    )
    return c.json(result)
  },
)

// ── List Phone Numbers ─────────────────────────────────────────────────────
providerSetup.get('/phone-numbers',
  requirePermission('telephony:view-numbers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'List owned phone numbers for a provider',
    responses: {
      200: {
        description: 'Owned phone numbers',
        content: { 'application/json': { schema: resolver(ownedNumberListSchema) } },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const provider = c.req.query('provider')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? c.req.query('hubId')

    if (!provider) {
      return c.json({ error: 'provider query param required' }, 400)
    }

    try {
      const numbers = await services.providerSetup.listNumbers(
        provider as Parameters<typeof services.providerSetup.listNumbers>[0],
        hubId,
      )
      return c.json({ numbers })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Search Available Numbers ───────────────────────────────────────────────
providerSetup.post('/phone-numbers/search',
  requirePermission('telephony:manage-numbers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Search available phone numbers (rate limit: 5/min)',
    responses: {
      200: {
        description: 'Available phone numbers',
        content: { 'application/json': { schema: resolver(availableNumberListSchema) } },
      },
      429: { description: 'Rate limit exceeded' },
      ...authErrors,
    },
  }),
  validator('json', numberSearchQuerySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const body = c.req.valid('json')

    const limited = await checkRateLimit(services.settings, `provider-search:${hubId ?? 'global'}:${pubkey}`, 5)
    if (limited) {
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }

    try {
      const numbers = await services.providerSetup.searchNumbers(
        body.providerType,
        body,
        hubId,
      )
      return c.json({ numbers })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Provision Phone Number ─────────────────────────────────────────────────
providerSetup.post('/phone-numbers/provision',
  requirePermission('telephony:manage-numbers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Provision a phone number (rate limit: 1/min)',
    responses: {
      200: {
        description: 'Provisioned number',
        content: { 'application/json': { schema: resolver(ownedNumberSchema) } },
      },
      429: { description: 'Rate limit exceeded' },
      ...authErrors,
    },
  }),
  validator('json', numberProvisionRequestSchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const body = c.req.valid('json')

    const limited = await checkRateLimit(services.settings, `provider-provision:${hubId ?? 'global'}:${pubkey}`, 1)
    if (limited) {
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }

    try {
      const number = await services.providerSetup.provisionNumber(
        body.providerType,
        body,
        hubId ?? body.hubId,
      )

      let webhookWarning: string | undefined
      if (body.autoConfigureWebhooks) {
        try {
          await services.providerSetup.configureWebhooks(
            body.providerType,
            number.id,
            { hubId: hubId ?? body.hubId ?? '' },
          )
        } catch (webhookErr) {
          webhookWarning = webhookErr instanceof Error ? webhookErr.message : 'Webhook configuration failed'
        }
      }

      return c.json({ ...number, webhookWarning })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Configure Webhooks ─────────────────────────────────────────────────────
providerSetup.post('/configure-webhooks',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Configure webhooks for a phone number',
    responses: {
      200: {
        description: 'Webhooks configured',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', ConfigureWebhooksRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      await services.providerSetup.configureWebhooks(
        body.provider as Parameters<typeof services.providerSetup.configureWebhooks>[0],
        body.numberId,
        { enableSms: body.enableSms, hubId: c.get('hubId') ?? body.hubId ?? '' },
      )
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Create SIP Trunk ───────────────────────────────────────────────────────
providerSetup.post('/create-sip-trunk',
  requirePermission('telephony:manage-providers'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Create a SIP trunk for a provider',
    responses: {
      200: {
        description: 'SIP trunk configuration',
        content: {
          'application/json': {
            schema: resolver(z.object({
              sipProvider: z.string(),
              sipUsername: z.string().optional(),
              trunkSid: z.string().optional(),
              connectionId: z.string().optional(),
            })),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', CreateSipTrunkRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const hubId = validateBodyHubAccess(c, body.hubId, 'telephony:manage-providers')
      const trunk = await services.providerSetup.createSipTrunk(
        body.provider as Parameters<typeof services.providerSetup.createSipTrunk>[0],
        {
          domain: body.domain,
          username: body.username,
          password: body.password,
          inboundMatch: body.inboundMatch,
        },
        hubId,
      )
      // Never return a SIP password: carrier-issued ones live only on the PBX
      return c.json({
        sipProvider: trunk.sipProvider,
        sipUsername: trunk.sipUsername,
        trunkSid: trunk.trunkSid,
        connectionId: trunk.connectionId,
      })
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 401 | 403 | 404 | 500)
      }
      throw err
    }
  },
)

// ── Signal Registration ────────────────────────────────────────────────────

const SignalRegisterRequestSchema = z.object({
  bridgeUrl: z.string(),
  phoneNumber: z.string(),
  method: z.enum(['sms', 'voice']).optional().default('sms'),
  hubId: z.string().optional(),
})

const SignalVerifyRequestSchema = z.object({
  registrationId: z.string(),
  code: z.string().regex(/^\d{3,8}$/),
  hubId: z.string().optional(),
})

function handleSignalError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof SignalRegistrationError) {
    return c.json({ error: err.message }, err.statusCode as 400 | 404 | 409 | 410 | 502)
  }
  throw err
}

providerSetup.post('/signal/register',
  requirePermission('messaging:manage-signal'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Start Signal bridge registration (SMS or voice)',
    responses: {
      200: {
        description: 'Registration started',
        content: { 'application/json': { schema: resolver(signalRegistrationStateSchema) } },
      },
      502: { description: 'Bridge unreachable' },
      ...authErrors,
    },
  }),
  validator('json', SignalRegisterRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? body.hubId

    if (!hubId) {
      return c.json({ error: 'hubId is required' }, 400)
    }

    try {
      const registration = await services.signalRegistration.startRegistration({
        bridgeUrl: body.bridgeUrl,
        phoneNumber: body.phoneNumber,
        method: body.method ?? 'sms',
        hubId,
      })
      await audit(services.audit, 'signalRegistrationStarted', c.get('pubkey'), {
        numberLast4: body.phoneNumber.slice(-4),
        status: registration.status,
      }, undefined, hubId)
      return c.json(registration)
    } catch (err) {
      return handleSignalError(err, c)
    }
  },
)

providerSetup.get('/signal/status',
  requirePermission('messaging:manage-signal'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Get Signal registration status (optionally polls bridge)',
    responses: {
      200: {
        description: 'Registration status',
        content: { 'application/json': { schema: resolver(signalRegistrationStateSchema) } },
      },
      404: { description: 'No registration found' },
      ...authErrors,
    },
  }),
  async (c) => {
    const hubId = c.get('hubId') ?? c.req.query('hubId')
    const registrationId = c.req.query('registrationId')
    const services = c.get('services')

    try {
      if (registrationId) {
        const registration = await services.signalRegistration.checkStatus(registrationId)
        return c.json(registration)
      }

      if (!hubId) {
        return c.json({ error: 'hubId or registrationId is required' }, 400)
      }

      const registration = await services.signalRegistration.getRegistrationForHub(hubId)
      if (!registration) {
        return c.json({ error: 'No registration found for this hub' }, 404)
      }
      return c.json(registration)
    } catch (err) {
      return handleSignalError(err, c)
    }
  },
)

providerSetup.post('/signal/verify',
  requirePermission('messaging:manage-signal'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Verify Signal registration code (voice flow)',
    responses: {
      200: {
        description: 'Verification result',
        content: { 'application/json': { schema: resolver(signalRegistrationStateSchema) } },
      },
      409: { description: 'Invalid state for verification' },
      ...authErrors,
    },
  }),
  validator('json', SignalVerifyRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const pubkey = c.get('pubkey')

    const limited = await checkRateLimit(services.settings, `signal-verify:${pubkey}`, 5)
    if (limited) {
      return c.json({ error: 'Rate limit exceeded — max 5 verification attempts per minute' }, 429)
    }

    try {
      const registration = await services.signalRegistration.verifyCode({
        registrationId: body.registrationId,
        code: body.code,
      })
      await audit(services.audit, 'signalRegistrationVerified', pubkey, {
        registrationId: body.registrationId,
        status: registration.status,
      }, undefined, registration.hubId)
      return c.json(registration)
    } catch (err) {
      return handleSignalError(err, c)
    }
  },
)

providerSetup.delete('/signal/unregister',
  requirePermission('messaging:manage-signal'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Unregister a Signal number (calls bridge + deletes DB record)',
    responses: {
      200: {
        description: 'Unregistered',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      404: { description: 'Registration not found' },
      ...authErrors,
    },
  }),
  async (c) => {
    // Accept registrationId from JSON body OR query param (DELETE may not carry a body)
    const registrationId = c.req.query('registrationId')
      ?? (await c.req.json().then((b: Record<string, unknown>) => b.registrationId as string | undefined).catch(() => undefined))

    const services = c.get('services')

    if (!registrationId) {
      return c.json({ error: 'registrationId is required' }, 400)
    }

    try {
      await services.signalRegistration.unregister(registrationId)
      return c.json({ ok: true })
    } catch (err) {
      return handleSignalError(err, c)
    }
  },
)

providerSetup.get('/signal/account',
  requirePermission('messaging:manage-signal'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Get Signal account info from bridge',
    responses: {
      200: {
        description: 'Account info',
        content: { 'application/json': { schema: resolver(z.record(z.string(), z.unknown())) } },
      },
      404: { description: 'Registration not found' },
      ...authErrors,
    },
  }),
  async (c) => {
    const registrationId = c.req.query('registrationId')
    const services = c.get('services')

    if (!registrationId) {
      return c.json({ error: 'registrationId query param required' }, 400)
    }

    try {
      const info = await services.signalRegistration.getAccountInfo(registrationId)
      return c.json(info)
    } catch (err) {
      return handleSignalError(err, c)
    }
  },
)

// ── A2P Registration ───────────────────────────────────────────────────────

const A2pBrandRequestSchema = z.object({
  providerType: z.string().optional().default('twilio'),
  brandInfo: z.object({
    entityType: z.string(),
    companyName: z.string(),
    ein: z.string(),
    phone: z.string(),
    street: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
    email: z.string(),
    website: z.string().optional(),
    vertical: z.string().optional(),
  }),
  hubId: z.string().optional(),
})

const A2pCampaignRequestSchema = z.object({
  registrationId: z.string(),
  campaignInfo: z.object({
    useCase: z.string(),
    description: z.string(),
    helpMessage: z.string(),
    optinMessage: z.string(),
    optoutMessage: z.string(),
    sampleMessages: z.array(z.string()),
    embeddedLink: z.boolean().optional(),
    embeddedPhone: z.boolean().optional(),
    subscriberOptin: z.boolean().optional(),
    subscriberOptout: z.boolean().optional(),
    subscriberHelp: z.boolean().optional(),
  }),
  hubId: z.string().optional(),
})

const A2pSkipRequestSchema = z.object({
  providerType: z.string().optional().default('twilio'),
  hubId: z.string().optional(),
})

function handleA2pError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof A2pRegistrationError) {
    return c.json({ error: err.message }, err.statusCode as 400 | 404 | 409)
  }
  throw err
}

providerSetup.post('/a2p/brand',
  requirePermission('telephony:manage-a2p'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Submit A2P brand registration',
    responses: {
      200: {
        description: 'Brand submitted',
        content: { 'application/json': { schema: resolver(a2pRegistrationStateSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', A2pBrandRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? body.hubId

    if (!hubId) {
      return c.json({ error: 'hubId is required' }, 400)
    }

    try {
      const registration = await services.a2pRegistration.submitBrand(
        body.providerType ?? 'twilio',
        body.brandInfo as Parameters<typeof services.a2pRegistration.submitBrand>[1],
        hubId,
      )
      return c.json(registration)
    } catch (err) {
      return handleA2pError(err, c)
    }
  },
)

providerSetup.post('/a2p/campaign',
  requirePermission('telephony:manage-a2p'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Submit A2P campaign registration (brand must be approved first)',
    responses: {
      200: {
        description: 'Campaign submitted',
        content: { 'application/json': { schema: resolver(a2pRegistrationStateSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', A2pCampaignRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const registration = await services.a2pRegistration.submitCampaign(
        body.registrationId,
        body.campaignInfo as Parameters<typeof services.a2pRegistration.submitCampaign>[1],
      )
      return c.json(registration)
    } catch (err) {
      return handleA2pError(err, c)
    }
  },
)

providerSetup.get('/a2p/status',
  requirePermission('telephony:manage-a2p'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Get A2P registration status (optionally polls provider)',
    responses: {
      200: {
        description: 'A2P registration status',
        content: { 'application/json': { schema: resolver(a2pRegistrationStateSchema) } },
      },
      404: { description: 'No registration found' },
      ...authErrors,
    },
  }),
  async (c) => {
    const hubId = c.get('hubId') ?? c.req.query('hubId')
    const registrationId = c.req.query('registrationId')
    const services = c.get('services')

    try {
      if (registrationId) {
        const registration = await services.a2pRegistration.checkStatus(registrationId)
        return c.json(registration)
      }

      if (!hubId) {
        return c.json({ error: 'hubId or registrationId is required' }, 400)
      }

      const row = await services.a2pRegistration.getRegistrationForHub(hubId)
      if (!row) {
        return c.json({ error: 'No A2P registration found for this hub' }, 404)
      }

      // Convert raw row to public format via checkStatus (no-op polling for non-pending)
      const registration = await services.a2pRegistration.checkStatus(row.id)
      return c.json(registration)
    } catch (err) {
      return handleA2pError(err, c)
    }
  },
)

providerSetup.post('/a2p/skip',
  requirePermission('telephony:manage-a2p'),
  describeRoute({
    tags: ['Provider Setup'],
    summary: 'Skip A2P registration (mark as not required for this hub)',
    responses: {
      200: {
        description: 'A2P marked as skipped',
        content: { 'application/json': { schema: resolver(a2pRegistrationStateSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('json', A2pSkipRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? body.hubId

    if (!hubId) {
      return c.json({ error: 'hubId is required' }, 400)
    }

    try {
      const registration = await services.a2pRegistration.skip(hubId, body.providerType ?? 'twilio')
      return c.json(registration)
    } catch (err) {
      return handleA2pError(err, c)
    }
  },
)

export default providerSetup

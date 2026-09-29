import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { hashIP, getClientIp } from '../lib/crypto'
import { isValidE164, checkRateLimit } from '../lib/helpers'
import { verifyAuthToken } from '../lib/auth'
import { auth as authMiddleware } from '../middleware/auth'
import { checkPermission } from '../middleware/permission-guard'
import { loginBodySchema, bootstrapBodySchema, profileUpdateBodySchema, availabilityBodySchema, transcriptionToggleBodySchema } from '@protocol/schemas/auth'
import { loginResponseSchema, meResponseSchema } from '@protocol/schemas/auth'
import { okResponseSchema } from '@protocol/schemas/common'
import { publicErrors, authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { getPrimaryRole } from '@shared/permissions'
import { deriveServerEventKey, getCurrentEpoch, EVENT_KEY_EPOCH_DURATION } from '../lib/hub-event-crypto'
import { bytesToHex } from '@shared/encoding'

const auth = new Hono<AppEnv>()

// --- Login (no auth) ---
auth.post('/login',
  describeRoute({
    tags: ['Auth'],
    summary: 'Authenticate with Schnorr signature',
    responses: {
      200: {
        description: 'Login successful',
        content: {
          'application/json': {
            schema: resolver(loginResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  validator('json', loginBodySchema),
  async (c) => {
    const services = c.get('services')

    // Rate limit login attempts by IP — always enforced (security audit Epic A)
    const clientIp = getClientIp(c.req.raw)
    const ipKey = `auth-login:${hashIP(clientIp, c.env.HMAC_SECRET)}`
    const limited = await checkRateLimit(services.settings, ipKey, 5)
    if (limited) {
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
    }

    const body = c.req.valid('json')

    // Per-pubkey failed attempt tracking — prevents targeted brute force
    const pubkeyKey = `auth-login-pk:${body.pubkey.slice(0, 16)}`
    const pubkeyLimited = await checkRateLimit(services.settings, pubkeyKey, 5)
    if (pubkeyLimited) {
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
    }

    // Verify Ed25519 auth token signature before returning any user information
    const url = new URL(c.req.url)
    const isValid = await verifyAuthToken({ pubkey: body.pubkey, timestamp: body.timestamp, token: body.token, nonce: body.nonce }, c.req.method, url.pathname)
    if (!isValid) return c.json({ error: 'Authentication failed' }, 401)

    try {
      const volunteer = await services.identity.getUser(body.pubkey)

      // Defensive: if this pubkey matches ADMIN_PUBKEY but has lost its admin role
      // (e.g., due to a race condition during test-reset), restore it immediately.
      // This prevents the admin from being locked out with volunteer-level access.
      if (c.env.ADMIN_PUBKEY && body.pubkey === c.env.ADMIN_PUBKEY &&
          !volunteer.roles.includes('role-super-admin')) {
        await services.identity.updateUser(body.pubkey, { roles: ['role-super-admin'] }, true)
        return c.json({ ok: true, roles: ['role-super-admin'] })
      }

      return c.json({ ok: true, roles: volunteer.roles })
    } catch {
      return c.json({ error: 'Authentication failed' }, 401)
    }
  },
)

// --- Bootstrap (no auth — one-shot admin registration) ---
auth.post('/bootstrap',
  describeRoute({
    tags: ['Auth'],
    summary: 'One-shot admin bootstrap registration',
    responses: {
      200: {
        description: 'Bootstrap successful',
        content: {
          'application/json': {
            schema: resolver(loginResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  validator('json', bootstrapBodySchema),
  async (c) => {
    const services = c.get('services')

    // Rate limit bootstrap by IP — always enforced (security audit Epic A)
    const clientIp = getClientIp(c.req.raw)
    const limited = await checkRateLimit(services.settings, `auth-bootstrap:${hashIP(clientIp, c.env.HMAC_SECRET)}`, 3)
    if (limited) {
      return c.json({ error: 'Too many attempts. Try again later.' }, 429)
    }

    const body = c.req.valid('json')

    // Verify Ed25519 auth token signature — proves caller owns the private key
    const bootstrapUrl = new URL(c.req.url)
    const isValid = await verifyAuthToken({ pubkey: body.pubkey, timestamp: body.timestamp, token: body.token, nonce: body.nonce }, c.req.method, bootstrapUrl.pathname)
    if (!isValid) return c.json({ error: 'Authentication failed' }, 401)

    // Check if admin already exists
    const { hasAdmin } = await services.identity.hasAdmin()
    if (hasAdmin) {
      return c.json({ error: 'Admin already exists' }, 403)
    }

    // Create the admin
    await services.identity.bootstrapAdmin(body.pubkey)

    return c.json({ ok: true, roles: ['role-super-admin'] })
  },
)

// --- Authenticated routes ---
// Hono's use('/me') is a prefix match — covers /me and all sub-paths (/me/logout, etc.)
// Registering both '/me' and '/me/*' causes double-invocation on /me (replay false-positive)
auth.use('/me/*', authMiddleware)

auth.get('/me',
  describeRoute({
    tags: ['Auth'],
    summary: 'Get current user profile and permissions',
    responses: {
      200: {
        description: 'Current user profile',
        content: {
          'application/json': {
            schema: resolver(meResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const user = c.get('user')
    const permissions = c.get('permissions')
    const allRoles = c.get('allRoles')

    const { credentials: webauthnCreds } = await services.identity.getWebAuthnCredentials(pubkey)
    const webauthnSettings = await services.identity.getWebAuthnSettings()

    const isAdmin = checkPermission(permissions, 'settings:manage')
    const webauthnRequired = isAdmin ? webauthnSettings.requireForAdmins : webauthnSettings.requireForUsers

    const primaryRole = getPrimaryRole(user.roles, allRoles)

    // Derive epoch-scoped server event key for client-side decryption (H1 + H5 fix)
    // Key changes each epoch for forward secrecy. Client receives current + previous epoch keys.
    const currentEpoch = getCurrentEpoch()
    let serverEventKeyHex: string | undefined
    let serverEventKeyPrevHex: string | undefined
    let eventKeyEpoch: number | undefined
    let eventKeyEpochDuration: number | undefined

    const serverSecret = c.env.SERVER_SECRET
    if (serverSecret) {
      serverEventKeyHex = bytesToHex(deriveServerEventKey(serverSecret, undefined, currentEpoch))
      serverEventKeyPrevHex = bytesToHex(deriveServerEventKey(serverSecret, undefined, currentEpoch - 1))
      eventKeyEpoch = currentEpoch
      eventKeyEpochDuration = EVENT_KEY_EPOCH_DURATION
    }

    return c.json({
      pubkey: user.pubkey,
      roles: user.roles,
      permissions,
      primaryRole: primaryRole ? { id: primaryRole.id, name: primaryRole.name, slug: primaryRole.slug } : null,
      name: user.name,
      transcriptionEnabled: user.transcriptionEnabled,
      spokenLanguages: user.spokenLanguages || ['en'],
      uiLanguage: user.uiLanguage || 'en',
      profileCompleted: user.profileCompleted ?? true,
      onBreak: user.onBreak ?? false,
      callPreference: user.callPreference ?? 'phone',
      webauthnRequired,
      webauthnRegistered: webauthnCreds.length > 0,
      // H17: Removed adminPubkey (signing key identity) — only decryption pubkey needed.
      // #1283: never fall back to ADMIN_PUBKEY. That is the Ed25519 signing key;
      // handing it to clients as a decryption pubkey tells every client to seal
      // note/message/file envelopes to a key that cannot open them.
      adminDecryptionPubkey: c.env.ADMIN_DECRYPTION_PUBKEY,
      serverEventKeyHex,
      serverEventKeyPrevHex,
      eventKeyEpoch,
      eventKeyEpochDuration,
    })
  },
)

auth.post('/me/logout',
  describeRoute({
    tags: ['Auth'],
    summary: 'Logout and revoke session token',
    responses: {
      200: {
        description: 'Logged out',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const authHeader = c.req.header('Authorization') || ''
    // Revoke the session token if using session-based auth
    if (authHeader.startsWith('Session ')) {
      const token = authHeader.slice(8).trim()
      await services.identity.revokeSession(token)
    }
    await audit(services.audit, 'logout', pubkey, {}, undefined, null)
    return c.json({ ok: true })
  },
)

auth.patch('/me/profile',
  describeRoute({
    tags: ['Auth'],
    summary: 'Update own profile',
    responses: {
      200: {
        description: 'Profile updated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', profileUpdateBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    if (body.phone && !isValidE164(body.phone)) {
      return c.json({ error: 'Invalid phone number. Use E.164 format (e.g. +12125551234)' }, 400)
    }
    await services.identity.updateUser(pubkey, body, false)
    return c.json({ ok: true })
  },
)

auth.patch('/me/availability',
  describeRoute({
    tags: ['Auth'],
    summary: 'Update availability (on break / available)',
    responses: {
      200: {
        description: 'Availability updated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', availabilityBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    await services.identity.updateUser(pubkey, { onBreak: body.onBreak }, false)
    await audit(services.audit, body.onBreak ? 'volunteerOnBreak' : 'volunteerAvailable', pubkey, {}, undefined, null)
    return c.json({ ok: true })
  },
)

auth.patch('/me/transcription',
  describeRoute({
    tags: ['Auth'],
    summary: 'Toggle transcription preference',
    responses: {
      200: {
        description: 'Transcription preference updated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', transcriptionToggleBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const body = c.req.valid('json')
    // If volunteer is trying to disable, check if admin allows opt-out
    if (!body.enabled && !checkPermission(permissions, 'settings:manage-transcription')) {
      const transSettings = await services.settings.getTranscriptionSettings()
      if (!transSettings.allowUserOptOut) {
        return c.json({ error: 'Transcription opt-out is not allowed' }, 403)
      }
    }
    await services.identity.updateUser(pubkey, { transcriptionEnabled: body.enabled }, false)
    await audit(services.audit, 'transcriptionToggled', pubkey, { enabled: body.enabled }, undefined, null)
    return c.json({ ok: true })
  },
)

export default auth

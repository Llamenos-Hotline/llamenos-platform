import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { AppEnv, WebAuthnCredential } from '../types'
import { uint8ArrayToBase64URL, checkRateLimit } from '../lib/helpers'
import { routeRateLimitClient } from '../lib/route-rate-limit'
import { generateRegOptions, verifyRegResponse, generateAuthOptions, verifyAuthResponse } from '../lib/webauthn'
import { auth as authMiddleware } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'
import { audit } from '../services/audit'
import { permissionGranted } from '@shared/permissions'
import { authenticateBodySchema, addCredentialBodySchema, registerCredentialBodySchema, webauthnOptionsResponseSchema, webauthnLoginResponseSchema, webauthnCredentialsListResponseSchema } from '@protocol/schemas/webauthn'
import { okResponseSchema, errorResponseSchema } from '@protocol/schemas/common'
import { publicErrors, authErrors } from '../openapi/helpers'

const webauthn = new Hono<AppEnv>()

// --- Public login routes (no auth) ---

webauthn.post('/login/options',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'Generate WebAuthn login challenge',
    responses: {
      200: {
        description: 'Authentication options with challenge',
        content: {
          'application/json': {
            schema: resolver(webauthnOptionsResponseSchema),
          },
        },
      },
      429: { description: 'Rate limited' },
      ...publicErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    // Rate limit WebAuthn login attempts to prevent challenge flooding
    const limited = await checkRateLimit(services.settings, `webauthn:${routeRateLimitClient(c)}`, 5)
    if (limited) return c.json({ error: 'Too many requests. Try again later.' }, 429)
    const rpID = new URL(c.req.url).hostname
    const { credentials } = await services.identity.getAllWebAuthnCredentials()
    const options = await generateAuthOptions(credentials, rpID)
    const challengeId = crypto.randomUUID()
    // B-M14: Bind challenge to the credential IDs that were offered, preventing relay attacks
    const allowedCredIds = credentials.map(cr => cr.id)
    await services.identity.storeWebAuthnChallenge(challengeId, options.challenge, undefined, allowedCredIds)
    return c.json({ ...options, challengeId })
  })

webauthn.post('/login/verify',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'Verify WebAuthn login assertion',
    responses: {
      ...publicErrors,
      200: {
        description: 'Login successful with session token',
        content: {
          'application/json': {
            schema: resolver(webauthnLoginResponseSchema),
          },
        },
      },
      400: { description: 'Invalid or expired challenge' },
      401: { description: 'Verification failed' },
      429: { description: 'Rate limited' },
    },
  }),
  validator('json', authenticateBodySchema),
  async (c) => {
    const services = c.get('services')
    // Rate limit verification attempts
    const verifyLimited = await checkRateLimit(services.settings, `webauthn-verify:${routeRateLimitClient(c)}`, 5)
    if (verifyLimited) return c.json({ error: 'Too many requests. Try again later.' }, 429)
    const body = c.req.valid('json')
    const assertion = body.assertion as unknown as AuthenticationResponseJSON
    const origin = new URL(c.req.url).origin
    const rpID = new URL(c.req.url).hostname

    let challengeData: { challenge: string; allowedCredIds: string[] | null }
    try {
      challengeData = await services.identity.getWebAuthnChallenge(body.challengeId)
    } catch {
      return c.json({ error: 'Invalid or expired challenge' }, 400)
    }

    const { credentials } = await services.identity.getAllWebAuthnCredentials()
    const matched = credentials.find(cr => cr.id === assertion.id)
    if (!matched) return c.json({ error: 'Authentication failed' }, 401)

    // B-M14: Verify the matched credential was in the allowed set from challenge generation
    if (challengeData.allowedCredIds && !challengeData.allowedCredIds.includes(matched.id)) {
      return c.json({ error: 'Authentication failed' }, 401)
    }

    try {
      const verification = await verifyAuthResponse(assertion, matched, challengeData.challenge, origin, rpID)
      if (!verification.verified) return c.json({ error: 'Authentication failed' }, 401)
      await services.identity.updateWebAuthnCounter({
        pubkey: matched.ownerPubkey,
        credId: matched.id,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date().toISOString(),
      })
      const session = await services.identity.createSession(matched.ownerPubkey)
      await audit(services.audit, 'webauthnLogin', matched.ownerPubkey, { credId: matched.id }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, null)
      return c.json({ token: session.token, pubkey: session.pubkey })
    } catch {
      return c.json({ error: 'Authentication failed' }, 401)
    }
  })

// --- Authenticated routes ---
webauthn.use('/register/*', authMiddleware)
webauthn.use('/credentials/*', authMiddleware)

webauthn.post('/register/options',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'Generate WebAuthn registration challenge',
    responses: {
      200: {
        description: 'Registration options with challenge',
        content: {
          'application/json': {
            schema: resolver(webauthnOptionsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', addCredentialBodySchema),
  rateLimit('strict'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const user = c.get('user')
    c.req.valid('json') // validated but not destructured — addCredentialBodySchema is a guard only
    const rpID = new URL(c.req.url).hostname
    const rpName = c.env.HOTLINE_NAME || 'Hotline'
    const { credentials: existing } = await services.identity.getWebAuthnCredentials(pubkey)
    const options = await generateRegOptions({ pubkey, name: user.name }, existing, rpID, rpName)
    const challengeId = crypto.randomUUID()
    // RACE-08 Phase 2: Bind challenge to authenticated user
    await services.identity.storeWebAuthnChallenge(challengeId, options.challenge, pubkey)
    return c.json({ ...options, challengeId })
  })

webauthn.post('/register/verify',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'Verify WebAuthn registration attestation',
    responses: {
      ...authErrors,
      200: {
        description: 'Registration successful',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      400: { description: 'Invalid challenge or verification failed' },
    },
  }),
  validator('json', registerCredentialBodySchema),
  rateLimit('strict'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const attestation = body.attestation as unknown as RegistrationResponseJSON
    const origin = new URL(c.req.url).origin
    const rpID = new URL(c.req.url).hostname

    let challengeData: { challenge: string; pubkey: string | null }
    try {
      challengeData = await services.identity.getWebAuthnChallenge(body.challengeId)
    } catch {
      return c.json({ error: 'Invalid or expired challenge' }, 400)
    }

    // B-M14: Verify challenge was bound to this user (registration challenges store pubkey)
    if (challengeData.pubkey && challengeData.pubkey !== pubkey) {
      return c.json({ error: 'Challenge not bound to this user' }, 400)
    }

    try {
      const verification = await verifyRegResponse(attestation, challengeData.challenge, origin, rpID)
      if (!verification.verified || !verification.registrationInfo) return c.json({ error: 'Verification failed' }, 400)
      const { credential: regCred, credentialBackedUp } = verification.registrationInfo
      const newCred: WebAuthnCredential = {
        id: regCred.id,
        publicKey: uint8ArrayToBase64URL(regCred.publicKey),
        counter: regCred.counter,
        transports: attestation.response?.transports || [],
        backedUp: credentialBackedUp,
        label: body.label || 'Passkey',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      }
      await services.identity.addWebAuthnCredential(pubkey, newCred)
      await audit(services.audit, 'webauthnRegistered', pubkey, { credId: newCred.id, label: body.label }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, null)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'Verification failed' }, 400)
    }
  })

webauthn.get('/credentials',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'List registered WebAuthn credentials',
    responses: {
      200: {
        description: 'List of credentials',
        content: {
          'application/json': {
            schema: resolver(webauthnCredentialsListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const { credentials } = await services.identity.getWebAuthnCredentials(pubkey)
    return c.json({
      credentials: credentials.map(cr => ({
        id: cr.id,
        label: cr.label,
        backedUp: cr.backedUp,
        createdAt: cr.createdAt,
        lastUsedAt: cr.lastUsedAt,
      })),
    })
  })

webauthn.delete('/credentials/:credId',
  describeRoute({
    tags: ['WebAuthn'],
    summary: 'Delete a WebAuthn credential',
    responses: {
      ...authErrors,
      200: {
        description: 'Credential deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      400: { description: 'Invalid credential ID' },
      409: {
        description: 'Caller is an admin whose last passkey would be removed while requireForAdmins is on (code WEBAUTHN_CREDENTIAL_REQUIRED)',
        content: {
          'application/json': {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const credId = decodeURIComponent(c.req.param('credId'))
    if (!credId) return c.json({ error: 'Invalid credential ID' }, 400)

    // Self-lockout guard (#680, sibling of #672): once requireForAdmins is on, the auth
    // middleware 403s every admin without a registered credential on every route except
    // GET /auth/me, logout, and /webauthn/*. Deleting an admin's last remaining credential
    // while that policy is active would lock them out with no way back in. Reject instead.
    const isAdmin = permissionGranted(permissions, 'settings:manage')
    if (isAdmin) {
      const webauthnSettings = await services.identity.getWebAuthnSettings()
      if (webauthnSettings.requireForAdmins === true) {
        const { credentials } = await services.identity.getWebAuthnCredentials(pubkey)
        const isLastCredential = credentials.some(cr => cr.id === credId) &&
          credentials.filter(cr => cr.id !== credId).length === 0
        if (isLastCredential) {
          return c.json({
            error: 'Cannot delete your last passkey while passkeys are required for admins',
            code: 'WEBAUTHN_CREDENTIAL_REQUIRED',
          }, 409)
        }
      }
    }

    await services.identity.deleteWebAuthnCredential(pubkey, credId)
    await audit(services.audit, 'webauthnDeleted', pubkey, { credId }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, null)
    return c.json({ ok: true })
  })

export default webauthn

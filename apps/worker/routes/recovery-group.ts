/**
 * Recovery Group API routes — EP09 Phase 2+3.
 *
 * Authenticated routes (permission-gated):
 *   POST   /enroll                  — Configure recovery group (recovery:manage)
 *   POST   /rotate                  — Rotate recovery group, re-wrap envelopes (recovery:manage)
 *   GET    /sessions                — List recovery sessions for a hub (recovery:view)
 *   GET    /:hubId                  — Get recovery group config (recovery:view)
 *   POST   /session/:id/contribute  — Submit share contribution (recovery:hold-share)
 *   GET    /session/:id             — Get session status (recovery:view, hub-scoped)
 *   POST   /session/:id/emergency   — Emergency override (recovery:approve)
 *   POST   /session/:id/cancel      — Cancel session (auth required)
 *   POST   /user-envelope           — Store user recovery envelope (auth required)
 *   POST   /shares/liveness         — Submit liveness proof (recovery:hold-share)
 *
 * Unauthenticated routes (rate-limited):
 *   POST   /initiate                — Start recovery (Signal verification)
 *   POST   /initiate/verify         — Verify Signal code
 *   POST   /session/:id/complete    — Complete recovery, authorize new device via sigchain
 *   GET    /user-envelope/:hubId    — Retrieve wrapped PUK seed envelope (session-scoped)
 */
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { checkPermission } from '../middleware/permission-guard'
import { authErrors, publicErrors, notFoundError } from '../openapi/helpers'
import { hashIP, getClientIp } from '../lib/crypto'
import { checkRateLimit } from '../lib/helpers'
import { RecoveryGroupError } from '../services/recovery-group'
import {
  recoveryGroupEnrollSchema,
  recoveryGroupInfoSchema,
  recoveryInitiateSchema,
  recoveryInitiateResponseSchema,
  recoveryInitiateVerifySchema,
  recoveryInitiateVerifyResponseSchema,
  recoveryContributeSchema,
  recoveryContributeResponseSchema,
  recoverySessionStatusResponseSchema,
  userRecoveryEnvelopeSchema,
  shareLivenessProofSchema,
  recoveryCancelResponseSchema,
  recoveryEmergencyOverrideSchema,
} from '@protocol/schemas/recovery-group'
import { okResponseSchema } from '@protocol/schemas/common'
import { safeFetch } from '../lib/safe-fetch'
import { callerHasHubAccess } from '../lib/hub-scope'

// ---------------------------------------------------------------------------
// Inline zod schemas — small, backend-only surface not shared with other
// platforms (no desktop/mobile UI consumes these two flows yet), following
// the same precedent as routes/sigchain.ts's inline `appendLinkBodySchema`.
// ---------------------------------------------------------------------------

const rewrappedUserEnvelopeSchema = z.object({
  userPubkey: z.string(),
  envelope: z.string(),
})

const shareEnvelopeSchema = z.object({
  holderPubkey: z.string(),
  shareEnvelope: z.string(),
})

const recoveryGroupRotateSchema = z.object({
  hubId: z.string().uuid(),
  threshold: z.number().int().min(2).max(5),
  totalShares: z.number().int().min(3).max(5),
  groupPublicKey: z.string(),
  shareEnvelopes: z.array(shareEnvelopeSchema),
  shareCommitments: z.array(z.string()),
  duressCommitments: z.array(z.string().nullable()).optional(),
  sigchainLinkHash: z.string(),
  delayHours: z.number().int().min(4).max(168).optional().default(24),
  emergencyFloorHours: z.number().int().min(1).max(24).optional().default(4),
  /** Every user recovery envelope for this hub, re-wrapped client-side under `groupPublicKey`. */
  rewrappedUserEnvelopes: z.array(rewrappedUserEnvelopeSchema),
})

const recoveryListSessionsResponseSchema = z.array(z.object({
  sessionId: z.string(),
  hubId: z.string(),
  userPubkey: z.string(),
  newDevicePubkey: z.string(),
  status: z.string(),
  signalVerified: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
}))

const recoveryCompleteSchema = z.object({
  /** Next sigchain seqNo for the recovering user's chain. */
  sigchainSeqNo: z.number().int().nonnegative(),
  /** Must include { sessionId, contributingHolderPubkeys }. Server independently verifies both. */
  sigchainPayload: z.record(z.string(), z.unknown()),
  /** Ed25519 signature over `hash`, made with the NEW device's own key (self-authorizing). Hex. */
  signature: z.string().regex(/^[0-9a-f]{128}$/i, 'Must be 64-byte Ed25519 signature in hex'),
  /** SHA-256 hash of the previous sigchain link (hex), or empty string if this is seq 0. */
  prevHash: z.string().regex(/^([0-9a-f]{64}|)$/i, 'Must be SHA-256 hex or empty string'),
  /** SHA-256 hash of this link's canonical form (hex). Server recomputes and verifies. */
  hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be SHA-256 hex'),
  /** Device ID the new device wants to register itself under. */
  signerDeviceId: z.string().min(1),
  /** ISO-8601 timestamp of link creation. */
  timestamp: z.string().min(1),
})

const recoveryCompleteResponseSchema = z.object({
  ok: z.boolean(),
  sigchainLink: z.object({
    id: z.string(),
    userPubkey: z.string(),
    seqNo: z.number(),
    linkType: z.string(),
    payload: z.unknown(),
    signature: z.string(),
    prevHash: z.string(),
    hash: z.string(),
    signerDeviceId: z.string(),
    signerPubkey: z.string(),
    createdAt: z.string(),
  }),
})

const recoveryUserEnvelopeResponseSchema = z.object({
  envelope: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

const authenticatedRoutes = new Hono<AppEnv>()

// POST /enroll — Configure recovery group
authenticatedRoutes.post('/enroll',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Configure or rotate a recovery group for a hub',
    description: 'Creates or replaces the recovery group with new Shamir shares. Requires recovery:manage permission.',
    responses: {
      200: {
        description: 'Recovery group enrolled',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('recovery:manage'),
  validator('json', recoveryGroupEnrollSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    // Enforce hub-scoping: recovery:manage is a GLOBAL permission grant and
    // says nothing about which hub(s) the caller actually belongs to
    // (multi-hub axiom). Without this, a manager scoped to one hub could
    // create/replace ANY hub's recovery group by supplying an arbitrary
    // hubId — mirrors the check on GET /sessions and POST /rotate.
    if (!callerHasHubAccess(c, body.hubId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    try {
      await services.recoveryGroup.enrollHub({
        hubId: body.hubId,
        threshold: body.threshold,
        totalShares: body.totalShares,
        groupPublicKey: body.groupPublicKey,
        shareEnvelopes: body.shareEnvelopes,
        shareCommitments: body.shareCommitments,
        duressCommitments: body.duressCommitments,
        sigchainLinkHash: body.sigchainLinkHash,
        delayHours: body.delayHours,
        emergencyFloorHours: body.emergencyFloorHours,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /rotate — Atomically rotate a recovery group and re-wrap user envelopes
authenticatedRoutes.post('/rotate',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Rotate a recovery group, re-wrapping every user recovery envelope',
    description: 'Atomic D13 rotation: replaces the group keypair and per-holder shares (e.g. on share holder departure), and re-wraps every existing user recovery envelope under the new group public key in the same transaction. The caller performs the HPKE re-wrap client-side — the server only relays ciphertext. Requires recovery:manage permission and an existing group for the hub (use /enroll for initial setup).',
    responses: {
      200: {
        description: 'Recovery group rotated',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('recovery:manage'),
  validator('json', recoveryGroupRotateSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const callerPubkey = c.get('pubkey')

    // Enforce hub-scoping: recovery:manage is a GLOBAL permission grant and
    // says nothing about which hub(s) the caller actually belongs to
    // (multi-hub axiom). Without this, a manager scoped to one hub could
    // rotate — i.e. destroy/corrupt — ANY hub's recovery group and every
    // member's recovery envelope by supplying an arbitrary hubId. Mirrors
    // the identical check on GET /sessions and POST /enroll.
    if (!callerHasHubAccess(c, body.hubId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    try {
      await services.recoveryGroup.rotateGroup({
        hubId: body.hubId,
        rotatedBy: callerPubkey,
        threshold: body.threshold,
        totalShares: body.totalShares,
        groupPublicKey: body.groupPublicKey,
        shareEnvelopes: body.shareEnvelopes,
        shareCommitments: body.shareCommitments,
        duressCommitments: body.duressCommitments,
        sigchainLinkHash: body.sigchainLinkHash,
        delayHours: body.delayHours,
        emergencyFloorHours: body.emergencyFloorHours,
        rewrappedUserEnvelopes: body.rewrappedUserEnvelopes,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// GET /sessions — List recovery sessions for a hub
// Registered BEFORE /:hubId so it isn't swallowed by that catch-all param route.
authenticatedRoutes.get('/sessions',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'List recovery sessions for a hub',
    description: 'Returns all recovery sessions (any status) for the given hub, ordered by creation time. Requires recovery:view permission.',
    responses: {
      200: {
        description: 'Recovery sessions',
        content: {
          'application/json': {
            schema: resolver(recoveryListSessionsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('recovery:view'),
  async (c) => {
    const hubId = c.req.query('hubId')
    if (!hubId) return c.json({ error: 'Missing hubId query parameter' }, 400)


    // Enforce hub-scoping: caller must be a member of the requested hub.
    // Super-admins pass everywhere; no other global role reaches into a hub. Mirrors the
    // identical check on GET /session/:id — recovery:view alone is a
    // global permission grant and says nothing about which hub(s) the
    // caller actually belongs to (multi-hub axiom: a user can hold
    // recovery:view globally while being scoped to only one hub).
    if (!callerHasHubAccess(c, hubId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const services = c.get('services')
    const sessions = await services.recoveryGroup.listSessions(hubId)
    return c.json(sessions)
  },
)

// GET /:hubId — Get recovery group config
authenticatedRoutes.get('/:hubId',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Get recovery group configuration for a hub',
    responses: {
      200: {
        description: 'Recovery group info',
        content: {
          'application/json': {
            schema: resolver(recoveryGroupInfoSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('recovery:view'),
  async (c) => {
    const hubId = c.req.param('hubId')
    const services = c.get('services')

    // Enforce hub-scoping: recovery:view is a GLOBAL permission grant and
    // says nothing about which hub(s) the caller actually belongs to.
    // Mirrors the identical check on GET /sessions and GET /session/:id.
    if (!callerHasHubAccess(c, hubId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    try {
      const group = await services.recoveryGroup.getGroup(hubId)
      return c.json(group)
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /session/:id/contribute — Submit encrypted share contribution
authenticatedRoutes.post('/session/:id/contribute',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Submit an encrypted share contribution to a recovery session',
    description: 'Share holder HPKE-seals their Shamir share to the new device pubkey. If threshold met, session transitions to active.',
    responses: {
      200: {
        description: 'Contribution accepted',
        content: {
          'application/json': {
            schema: resolver(recoveryContributeResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('recovery:hold-share'),
  validator('json', recoveryContributeSchema),
  async (c) => {
    const sessionId = c.req.param('id')
    const contributorPubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const result = await services.recoveryGroup.contributeShare({
        sessionId,
        contributorPubkey,
        encryptedShare: body.encryptedShare,
        contributorSignature: body.contributorSignature,
      })
      return c.json(result)
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// GET /session/:id — Get recovery session status
authenticatedRoutes.get('/session/:id',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Get recovery session status',
    description: 'Returns session state, contribution count, delay remaining. HPKE ciphertext only released after delay elapsed.',
    responses: {
      200: {
        description: 'Session status',
        content: {
          'application/json': {
            schema: resolver(recoverySessionStatusResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('recovery:view'),
  async (c) => {
    const sessionId = c.req.param('id')
    const services = c.get('services')

    try {
      const session = await services.recoveryGroup.getSession(sessionId)

      // Enforce hub-scoping: caller must be a member of the session's hub.
      // Super-admins pass everywhere; no other global role reaches into a hub.
      if (!callerHasHubAccess(c, session.hubId)) {
        return c.json({ error: 'Session not found' }, 404)
      }

      return c.json(session)
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /session/:id/emergency — Emergency override (shortcut delay timer)
authenticatedRoutes.post('/session/:id/emergency',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Apply emergency override to a recovery session',
    description: 'An approver with recovery:approve permission can bypass the delay timer. Requires a valid Ed25519 signature from the approver over the sessionId. Approver must not be the recovering user.',
    responses: {
      200: {
        description: 'Emergency override applied',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('recovery:approve'),
  validator('json', recoveryEmergencyOverrideSchema),
  async (c) => {
    const sessionId = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')
    const callerPubkey = c.get('pubkey')

    // HIGH-W6: Enforce approverPubkey matches the authenticated caller — prevent impersonation
    if (body.approverPubkey !== callerPubkey) {
      return c.json({ error: 'approverPubkey must match authenticated user' }, 403)
    }

    try {
      // Enforce hub-scoping: recovery:approve is a GLOBAL permission grant
      // and says nothing about which hub(s) the approver actually belongs
      // to. Fetch the session first so we know its hub before acting — an
      // approver scoped to one hub must not be able to bypass another
      // hub's delay timer. Mirrors the identical check on GET /session/:id.
      const session = await services.recoveryGroup.getSession(sessionId)
      if (!callerHasHubAccess(c, session.hubId)) {
        return c.json({ error: 'Session not found' }, 404)
      }

      await services.recoveryGroup.applyEmergencyOverride({
        sessionId,
        approverPubkey: callerPubkey,
        justification: body.justification,
        signature: body.signature,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /session/:id/cancel — Cancel a recovery session
authenticatedRoutes.post('/session/:id/cancel',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Cancel a recovery session',
    description: 'The recovering user (from another device) or a user with recovery:manage can cancel.',
    responses: {
      200: {
        description: 'Session cancelled',
        content: {
          'application/json': {
            schema: resolver(recoveryCancelResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const sessionId = c.req.param('id')
    const callerPubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    const hasManagePermission = checkPermission(permissions, 'recovery:manage')

    try {
      // Enforce hub-scoping on the manager-bypass path: recovery:manage is
      // a GLOBAL permission grant and says nothing about which hub(s) the
      // caller belongs to. Without this, a manager scoped to one hub could
      // cancel ANY hub's in-progress recovery session — a denial-of-recovery
      // attack against volunteers locked out on another hub. The recovering
      // user's own path is unaffected: it is already self-scoped to their
      // own session regardless of hub membership. Fetch the session first
      // (same shape as GET /session/:id and POST /.../emergency) so a
      // hub-mismatched manager with no recovering-user claim gets the same
      // "Session not found" anti-enumeration response as those routes,
      // rather than a 403 that would confirm the session exists.
      const session = await services.recoveryGroup.getSession(sessionId)
      const isRecoveringUser = callerPubkey === session.userPubkey
      const scopedManagePermission = hasManagePermission && callerHasHubAccess(c, session.hubId)

      if (!isRecoveringUser && hasManagePermission && !scopedManagePermission) {
        return c.json({ error: 'Session not found' }, 404)
      }

      await services.recoveryGroup.cancelSession({
        sessionId,
        cancelledBy: callerPubkey,
        callerPubkey,
        hasManagePermission: scopedManagePermission,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /user-envelope — Store/update user recovery envelope
authenticatedRoutes.post('/user-envelope',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Store or update user recovery envelope',
    description: 'Upserts the HPKE-encrypted PUK seed envelope for the authenticated user in a specific hub.',
    responses: {
      200: {
        description: 'Envelope stored',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('json', userRecoveryEnvelopeSchema),
  async (c) => {
    const userPubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      await services.recoveryGroup.putUserEnvelope({
        userPubkey,
        hubId: body.hubId,
        envelope: body.envelope,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /shares/liveness — Submit share liveness proof
authenticatedRoutes.post('/shares/liveness',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Submit a share liveness proof',
    description: 'Share holder proves they can still decrypt their share without revealing it. Updates lastLivenessProof timestamp.',
    responses: {
      200: {
        description: 'Proof accepted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('recovery:hold-share'),
  validator('json', shareLivenessProofSchema),
  async (c) => {
    const holderPubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      await services.recoveryGroup.submitLivenessProof({
        hubId: body.hubId,
        holderPubkey,
        proof: body.proof,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// ---------------------------------------------------------------------------
// Unauthenticated routes (rate-limited)
// ---------------------------------------------------------------------------

const publicRoutes = new Hono<AppEnv>()

// POST /initiate — Start account recovery
publicRoutes.post('/initiate',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Initiate account recovery (unauthenticated)',
    description: 'Starts recovery process. Sends Signal verification code. Rate limited: 10 req / 5 min per IP. Response shape identical whether user exists or not (anti-enumeration).',
    responses: {
      200: {
        description: 'Recovery initiation response',
        content: {
          'application/json': {
            schema: resolver(recoveryInitiateResponseSchema),
          },
        },
      },
      429: { description: 'Rate limited' },
      ...publicErrors,
    },
  }),
  validator('json', recoveryInitiateSchema),
  async (c) => {
    // Rate limit: 10 req / 5 min per IP
    const clientIp = getClientIp(c.req.raw)
    const services = c.get('services')

    const limited = await checkRateLimit(
      services.settings,
      `recovery-initiate:${hashIP(clientIp, c.env.HMAC_SECRET)}`,
      2, // 2 per minute = 10 per 5 min
    )
    if (limited) {
      return c.json({ error: 'Too many requests. Please wait a few minutes.' }, 429)
    }

    const body = c.req.valid('json')

    // Signal notifier function — sends verification code via sidecar
    const signalNotifierFn = async (identifierHash: string, code: string): Promise<boolean> => {
      const notifierUrl = c.env.SIGNAL_NOTIFIER_URL || 'http://localhost:3100'
      const notifierToken = c.env.SIGNAL_NOTIFIER_BEARER_TOKEN || ''

      try {
        const res = await safeFetch(`${notifierUrl}/api/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${notifierToken}`,
          },
          body: JSON.stringify({
            identifierHash,
            message: `Your Llamenos recovery verification code is: ${code}\n\nIf you did not request account recovery, please contact your administrator immediately.`,
          }),
          timeoutMs: 10_000,
          ssrfGuard: false,
        })
        return res.ok
      } catch {
        return false
      }
    }

    try {
      const result = await services.recoveryGroup.initiateRecovery({
        hubId: body.hubId,
        userIdentifier: body.userIdentifier,
        newDevicePubkey: body.newDevicePubkey,
        signalNotifierFn,
        hmacSecret: c.env.HMAC_SECRET || '',
      })
      return c.json(result)
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /initiate/verify — Confirm Signal verification code
publicRoutes.post('/initiate/verify',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Verify Signal verification code',
    description: 'Confirms the verification code sent via Signal. On success, session advances to verified and delay timer starts. 5 attempts max per session.',
    responses: {
      200: {
        description: 'Verification result',
        content: {
          'application/json': {
            schema: resolver(recoveryInitiateVerifyResponseSchema),
          },
        },
      },
      ...publicErrors,
    },
  }),
  validator('json', recoveryInitiateVerifySchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const result = await services.recoveryGroup.verifyInitiation({
        sessionId: body.sessionId,
        verificationCode: body.verificationCode,
        hmacSecret: c.env.HMAC_SECRET || '',
      })
      return c.json(result)
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// POST /session/:id/complete — Complete recovery, authorize the new device
publicRoutes.post('/session/:id/complete',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Complete a recovery session by appending a self-authorizing sigchain link',
    description: 'Unauthenticated: the recovering device has no prior session, so it cannot use the authenticated sigchain-append route. The link is signed by the new device\'s own key (not the account\'s lost identity key) and is only accepted once the session has reached `active` (>= threshold contributions) and its post-verification delay has elapsed. The payload must reference this session and list the verified contributing share holders as evidence.',
    responses: {
      200: {
        description: 'Recovery completed — device authorized',
        content: {
          'application/json': {
            schema: resolver(recoveryCompleteResponseSchema),
          },
        },
      },
      ...publicErrors,
      ...notFoundError,
    },
  }),
  validator('json', recoveryCompleteSchema),
  async (c) => {
    const sessionId = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')

    try {
      const result = await services.recoveryGroup.completeRecovery({
        sessionId,
        sigchainSeqNo: body.sigchainSeqNo,
        sigchainPayload: body.sigchainPayload,
        signature: body.signature,
        prevHash: body.prevHash,
        hash: body.hash,
        signerDeviceId: body.signerDeviceId,
        timestamp: body.timestamp,
      })
      return c.json({ ok: true, sigchainLink: result.sigchainLink })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// GET /user-envelope/:hubId — Retrieve the wrapped PUK seed envelope
publicRoutes.get('/user-envelope/:hubId',
  describeRoute({
    tags: ['Recovery Group'],
    summary: 'Retrieve the recovering user\'s wrapped PUK seed envelope',
    description: 'Unauthenticated (session-scoped): the recovering device fetches the HPKE-encrypted PUK seed envelope so it can reconstruct the recovery group private key and decrypt it. Released once the session\'s delay has elapsed and threshold contributions have been received — matching the same gate that releases contribution ciphertext on GET /session/:id.',
    responses: {
      200: {
        description: 'Recovery envelope (null if none stored for this user/hub)',
        content: {
          'application/json': {
            schema: resolver(recoveryUserEnvelopeResponseSchema),
          },
        },
      },
      ...publicErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const hubId = c.req.param('hubId')
    const sessionId = c.req.query('sessionId')
    if (!sessionId) return c.json({ error: 'Missing sessionId query parameter' }, 400)

    const services = c.get('services')

    try {
      const envelope = await services.recoveryGroup.getUserEnvelope(sessionId, hubId)
      return c.json({ envelope })
    } catch (err) {
      if (err instanceof RecoveryGroupError) {
        return c.json({ error: err.message }, err.status)
      }
      throw err
    }
  },
)

// ---------------------------------------------------------------------------
// Export both route groups
// ---------------------------------------------------------------------------

export default {
  authenticated: authenticatedRoutes,
  public: publicRoutes,
}

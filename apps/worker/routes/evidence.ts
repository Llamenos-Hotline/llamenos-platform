import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { permissionGranted } from '@shared/permissions'
import { audit } from '../services/audit'
import {
  uploadEvidenceBodySchema,
  logCustodyEventBodySchema,
  verifyIntegrityBodySchema,
  listEvidenceQuerySchema,
  evidenceMetadataSchema,
  evidenceListResponseSchema,
  custodyChainResponseSchema,
  custodyEntrySchema,
  verifyIntegrityResponseSchema,
  evidenceAccessLogResponseSchema,
} from '@protocol/schemas/evidence'
import { authErrors, notFoundError } from '../openapi/helpers'

const evidence = new Hono<AppEnv>()

// ============================================================
// Permission guards that also write a denied-access entry to the
// hash-chained audit log (Issue #730 — chain-of-custody audit trail).
//
// Evidence access must never fail silently: a volunteer probing for
// evidence they cannot see is itself a security-relevant event, so the
// denial is recorded the same way a successful access is.
// ============================================================

async function auditDenial(c: Context<AppEnv>, required: string[]) {
  const services = c.get('services')
  const pubkey = c.get('pubkey')
  // Include evidenceId (when the route has one) so a denied attempt shows up
  // in that item's access log via AuditService.listForEvidence — a denial
  // recorded under no evidenceId would be invisible from the one place an
  // admin would look for it (Issue #730).
  const evidenceId = c.req.param('evidenceId')
  await audit(
    services.audit,
    'evidenceAccessDenied',
    pubkey,
    { required, path: c.req.path, method: c.req.method, ...(evidenceId ? { evidenceId } : {}) },
    deviceCtx(c),
    hubIdOf(c),
  )
}

/** Like requirePermission(), but logs a denied-access audit entry instead of failing silently. */
function requirePermissionAudited(...required: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // hubContext has already bounded `permissions` to the hub (see requirePermission).
    const permissions = c.get('permissions')
    for (const perm of required) {
      if (!permissionGranted(permissions, perm)) {
        await auditDenial(c, [perm])
        return c.json({ error: 'Forbidden', required: perm }, 403)
      }
    }
    await next()
  })
}

/** Like requireAnyPermission(), but logs a denied-access audit entry instead of failing silently. */
function requireAnyPermissionAudited(...anyOf: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const permissions = c.get('permissions')
    const hasAny = anyOf.some(perm => permissionGranted(permissions, perm))
    if (!hasAny) {
      await auditDenial(c, anyOf)
      return c.json({ error: 'Forbidden', required: anyOf }, 403)
    }
    await next()
  })
}

/** Captures request metadata (IP hash + UA hash) for "which device" attribution. */
function deviceCtx(c: Context<AppEnv>): { request: Request; hmacSecret: string } {
  return { request: c.req.raw, hmacSecret: (c.env?.HMAC_SECRET as string | undefined) ?? '' }
}

/**
 * Scope evidence access-log entries to the current hub, same as every other
 * hub-aware audit call (e.g. bans.ts). Evidence routes are mounted both
 * globally and under /hubs/:hubId — undefined outside a hub-scoped request,
 * matching the hub scoping of the case record the evidence belongs to.
 */
function hubIdOf(c: Context<AppEnv>): string | null {
  return c.get('hubId') ?? null
}

// ============================================================
// Evidence routes mounted under /records/:id/evidence
// ============================================================

// --- Upload evidence metadata to a case record ---
// The actual file is uploaded to R2 via the existing file upload route.
// This route creates the evidence metadata and initial custody entry,
// and optionally auto-creates a file_upload interaction on the case timeline.
evidence.post('/records/:id/evidence',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Upload evidence to a case record',
    responses: {
      201: {
        description: 'Evidence metadata created with initial custody entry',
        content: {
          'application/json': {
            schema: resolver(evidenceMetadataSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermissionAudited('evidence:upload'),
  validator('json', uploadEvidenceBodySchema),
  async (c) => {
    const caseId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const created = await services.cases.createEvidence(caseId, pubkey, {
      fileId: body.fileId,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      classification: body.classification,
      integrityHash: body.integrityHash,
      source: body.source,
      sourceDescription: body.sourceDescription,
      encryptedDescription: body.encryptedDescription,
      descriptionEnvelopes: body.descriptionEnvelopes,
    })

    // Auto-create a file_upload interaction on the case timeline
    await services.cases.createInteraction(caseId, pubkey, {
      interactionType: 'file_upload',
      sourceId: created.id,
      interactionTypeHash: body.interactionTypeHash ?? '',
    }).catch(() => {
      // Non-fatal: interaction creation failure shouldn't block evidence upload
    })

    await audit(services.audit, 'evidenceUploaded', pubkey, {
      caseId,
      evidenceId: created.id,
      classification: body.classification,
    }, deviceCtx(c), hubIdOf(c))

    return c.json(created, 201)
  },
)

// --- List evidence for a case ---
evidence.get('/records/:id/evidence',
  describeRoute({
    tags: ['Evidence'],
    summary: 'List evidence for a case record',
    responses: {
      200: {
        description: 'Paginated list of evidence',
        content: {
          'application/json': {
            schema: resolver(evidenceListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requireAnyPermissionAudited('evidence:download', 'evidence:upload', 'evidence:manage-custody'),
  validator('query', listEvidenceQuerySchema),
  async (c) => {
    const caseId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const query = c.req.valid('query')

    const result = await services.cases.listEvidence(caseId, {
      page: query.page,
      limit: query.limit,
      classification: query.classification,
    })

    // Metadata read: viewing the evidence list for a case is itself an
    // access worth recording in the chain-of-custody log (Issue #730).
    await audit(services.audit, 'evidenceAccessed', pubkey, {
      caseId,
      action: 'list_viewed',
      count: result.evidence.length,
    }, deviceCtx(c), hubIdOf(c))

    return c.json(result)
  },
)

// ============================================================
// Evidence-specific routes (by evidence ID)
// ============================================================

// --- Get single evidence metadata ---
evidence.get('/evidence/:evidenceId',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Get single evidence metadata',
    responses: {
      200: {
        description: 'Evidence metadata',
        content: {
          'application/json': {
            schema: resolver(evidenceMetadataSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requireAnyPermissionAudited('evidence:download', 'evidence:manage-custody'),
  async (c) => {
    const evidenceId = c.req.param('evidenceId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const ev = await services.cases.getEvidence(evidenceId)

    // Metadata read of a specific evidence item — recorded automatically,
    // not left to the client to self-report (Issue #730).
    await audit(services.audit, 'evidenceAccessed', pubkey, {
      evidenceId,
      action: 'metadata_read',
    }, deviceCtx(c), hubIdOf(c))

    return c.json(ev)
  },
)

// --- Get custody chain for evidence ---
evidence.get('/evidence/:evidenceId/custody',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Get chain of custody for evidence',
    responses: {
      200: {
        description: 'Chronological custody chain',
        content: {
          'application/json': {
            schema: resolver(custodyChainResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermissionAudited('evidence:manage-custody'),
  async (c) => {
    const evidenceId = c.req.param('evidenceId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const result = await services.cases.listCustodyEntries(evidenceId)

    await audit(services.audit, 'evidenceAccessed', pubkey, {
      evidenceId,
      action: 'custody_viewed',
    }, deviceCtx(c), hubIdOf(c))

    return c.json(result)
  },
)

// --- Get the hash-chained evidence access log (admin only — Issue #730) ---
// Unlike the custody chain above (Epic 325's own per-evidence log of
// upload/view/download/share events), this reads directly from the Epic 77
// hash-chained audit_log table, so a modified or deleted entry is
// detectable via GET /audit/verify.
evidence.get('/evidence/:evidenceId/access-log',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Get the tamper-evident access log for an evidence item (admin only)',
    description:
      'Every view, download, export, metadata read, and denied access attempt for this ' +
      'evidence item, backed by the hash-chained audit log (not a parallel unchained table). ' +
      'Restricted to admin roles via the audit:read permission.',
    responses: {
      200: {
        description: 'Chronological access log entries for this evidence item',
        content: {
          'application/json': {
            schema: resolver(evidenceAccessLogResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermissionAudited('audit:read'),
  async (c) => {
    const evidenceId = c.req.param('evidenceId')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const entries = await services.audit.listForEvidence(evidenceId, hubId ?? undefined)
    return c.json({ entries, total: entries.length })
  },
)

// --- Log evidence access (called when evidence is viewed/downloaded/shared) ---
evidence.post('/evidence/:evidenceId/access',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Log evidence access event (view, download, share)',
    responses: {
      201: {
        description: 'Custody entry created',
        content: {
          'application/json': {
            schema: resolver(custodyEntrySchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermissionAudited('evidence:download'),
  validator('json', logCustodyEventBodySchema),
  async (c) => {
    const evidenceId = c.req.param('evidenceId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const entry = await services.cases.createCustodyEntry(evidenceId, pubkey, {
      action: body.action,
      integrityHash: body.integrityHash,
      userAgent: c.req.header('user-agent'),
      notes: body.notes,
    })

    await audit(services.audit, 'evidenceAccessed', pubkey, {
      evidenceId,
      action: body.action,
    }, deviceCtx(c), hubIdOf(c))

    return c.json(entry, 201)
  },
)

// --- Verify evidence integrity ---
evidence.post('/evidence/:evidenceId/verify',
  describeRoute({
    tags: ['Evidence'],
    summary: 'Verify evidence integrity (compare current hash to stored hash)',
    responses: {
      200: {
        description: 'Verification result',
        content: {
          'application/json': {
            schema: resolver(verifyIntegrityResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermissionAudited('evidence:download'),
  validator('json', verifyIntegrityBodySchema),
  async (c) => {
    const evidenceId = c.req.param('evidenceId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.verifyEvidence(
      evidenceId,
      body.currentHash,
      pubkey,
    )

    await audit(services.audit, 'evidenceIntegrityVerified', pubkey, {
      evidenceId,
      valid: result.valid,
    }, deviceCtx(c), hubIdOf(c))

    return c.json(result)
  },
)

export default evidence

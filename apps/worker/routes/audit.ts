import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import {
  listAuditQuerySchema,
  auditListResponseSchema,
  auditVerifyQuerySchema,
  auditVerifyResponseSchema,
} from '@protocol/schemas/audit'
import { createEntityRouter } from '../lib/entity-router'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { authErrors } from '../openapi/helpers'
import { hubOnly, pathHubId } from '../lib/hub-scope'

// There are two kinds of audit chain: one per hub, and the platform chain
// (`hub_id IS NULL`) for deployment-level actions. Each gets its own router, and
// neither can be reached through the other. A hub's log is read under
// /hubs/:hubId/audit with the hub-resolved `audit:read`. The platform chain is
// read at /admin/audit with `system:view-audit`. "No hub id" no longer means
// "every hub's log", which is what the unscoped /audit mount used to serve to a
// global `audit:read` holder (#2395).

const auditListRouter = createEntityRouter({
  tag: 'Audit',
  domain: 'audit',
  service: 'audit',
  listResponseSchema: auditListResponseSchema,
  itemResponseSchema: auditListResponseSchema,
  listQuerySchema: listAuditQuerySchema,
  hubScoped: true,
  disableGet: true,
  disableDelete: true,
  methods: {
    list: 'list',
  },
})

// ---------------------------------------------------------------------------
// Additional audit endpoints (outside entity-router CRUD)
// ---------------------------------------------------------------------------

const auditExtra = new Hono<AppEnv>()

auditExtra.get(
  '/verify',
  describeRoute({
    tags: ['Audit'],
    summary: 'Verify audit log hash chain integrity',
    description:
      'Walks the hub\'s hash chain in chronological order and verifies each entry\'s hash and linkage. ' +
      'Supports pagination via limit/offset for large chains.',
    responses: {
      200: {
        description: 'Chain verification result',
        content: { 'application/json': { schema: resolver(auditVerifyResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('audit:read'),
  validator('query', auditVerifyQuerySchema),
  async (c) => {
    const { limit, offset } = c.req.valid('query')
    return c.json(await c.get('services').audit.verifyChain(pathHubId(c), { limit, offset }))
  },
)

// A hub's chain, mounted only under /hubs/:hubId and refusing requests outside one.
// Mount verify BEFORE the entity router so /verify is matched before /:id
const audit = new Hono<AppEnv>()
audit.use('*', hubOnly)
audit.route('/', auditExtra)
audit.route('/', auditListRouter)

export default audit

// ---------------------------------------------------------------------------
// The platform chain — deployment-level actions, no hub's rows
// ---------------------------------------------------------------------------

export const platformAuditRoutes = new Hono<AppEnv>()
platformAuditRoutes.use('*', requirePermission('system:view-audit'))

platformAuditRoutes.get(
  '/verify',
  describeRoute({
    tags: ['Audit'],
    summary: 'Verify the platform audit chain',
    description:
      'Walks the platform (deployment-level) hash chain in chronological order. No hub\'s entries are on it.',
    responses: {
      200: {
        description: 'Chain verification result',
        content: { 'application/json': { schema: resolver(auditVerifyResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('query', auditVerifyQuerySchema),
  async (c) => {
    const { limit, offset } = c.req.valid('query')
    return c.json(await c.get('services').audit.verifyChain(undefined, { limit, offset }))
  },
)

platformAuditRoutes.get(
  '/',
  describeRoute({
    tags: ['Audit'],
    summary: 'List the platform audit chain',
    description: 'Deployment-level audit entries (no hub). A hub\'s entries are read under /hubs/:hubId/audit.',
    responses: {
      200: {
        description: 'Platform audit entries',
        content: { 'application/json': { schema: resolver(auditListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('query', listAuditQuerySchema),
  async (c) => c.json(await c.get('services').audit.list(null, c.req.valid('query'))),
)

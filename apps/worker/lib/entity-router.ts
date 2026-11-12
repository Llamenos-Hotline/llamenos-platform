/**
 * createEntityRouter — factory that generates standard CRUD Hono routers
 * for entity domains, eliminating per-route boilerplate.
 *
 * Registers GET /, GET /:id, POST /, PATCH /:id, DELETE /:id based on
 * config. Each endpoint gets describeRoute (OpenAPI), requirePermission
 * middleware, optional validator middleware, and audit logging.
 */
import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { ZodTypeAny } from 'zod'
import type { AppEnv } from '../types'
import type { Services } from '../services'
import { requirePermission } from '../middleware/permission-guard'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { okResponseSchema } from '@protocol/schemas/common'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono handler context
type Ctx = Context<AppEnv, any, any>

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EntityRouterConfig<
  TList extends ZodTypeAny,
  TItem extends ZodTypeAny,
  TCreate extends ZodTypeAny | undefined = undefined,
  TUpdate extends ZodTypeAny | undefined = undefined,
  TListQuery extends ZodTypeAny | undefined = undefined,
> {
  /** OpenAPI tag (e.g., 'Shifts') */
  tag: string
  /** Permission domain prefix (e.g., 'shifts') */
  domain: string
  /** Key into the Services registry (e.g., 'shifts') */
  service: keyof Services
  /** Zod schema for the list response (GET /) */
  listResponseSchema: TList
  /** Zod schema for the single-item response (GET /:id, POST /, PATCH /:id) */
  itemResponseSchema: TItem
  /** Zod schema for create body — if omitted, POST / is not registered */
  createBodySchema?: TCreate
  /** Zod schema for update body — if omitted, PATCH /:id is not registered */
  updateBodySchema?: TUpdate
  /** Zod schema for list query parameters (GET /) */
  listQuerySchema?: TListQuery
  /** URL param name for the resource ID (default: 'id') */
  idParam?: string
  /** Whether the service methods take hubId as their first argument (default: false) */
  hubScoped?: boolean
  /** Audit event names — if omitted for an action, no audit entry is created */
  auditEvents?: {
    created?: string
    updated?: string
    deleted?: string
  }
  /** Service method names — defaults to list/get/create/update/delete */
  methods?: {
    list?: string
    get?: string
    create?: string
    update?: string
    delete?: string
  }
  /** If true, GET / (list) is not registered (default: false) */
  disableList?: boolean
  /** If true, GET /:id is not registered (default: false) */
  disableGet?: boolean
  /** If true, DELETE /:id is not registered (default: false) */
  disableDelete?: boolean
  /** Override the default `domain:suffix` permission for individual endpoints */
  permissionOverrides?: {
    list?: string
    get?: string
    create?: string
    update?: string
    delete?: string
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type ServiceMethod = (...args: unknown[]) => Promise<unknown>

export function createEntityRouter<
  TList extends ZodTypeAny,
  TItem extends ZodTypeAny,
  TCreate extends ZodTypeAny | undefined = undefined,
  TUpdate extends ZodTypeAny | undefined = undefined,
  TListQuery extends ZodTypeAny | undefined = undefined,
>(config: EntityRouterConfig<TList, TItem, TCreate, TUpdate, TListQuery>): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  const {
    tag,
    domain,
    service: serviceKey,
    listResponseSchema,
    itemResponseSchema,
    createBodySchema,
    updateBodySchema,
    listQuerySchema,
    idParam = 'id',
    hubScoped = false,
    auditEvents = {},
    methods = {},
    disableList = false,
    disableGet = false,
    disableDelete = false,
    permissionOverrides = {},
  } = config

  const listMethod = methods.list ?? 'list'
  const getMethod = methods.get ?? 'get'
  const createMethod = methods.create ?? 'create'
  const updateMethod = methods.update ?? 'update'
  const deleteMethod = methods.delete ?? 'delete'

  // Helpers
  const perm = (action: string, override?: string): string =>
    override ?? `${domain}:${action}`

  const getSvc = (services: Services): Record<string, ServiceMethod> =>
    services[serviceKey] as unknown as Record<string, ServiceMethod>

  const getHubId = (c: { get(key: 'hubId'): string | undefined }): string =>
    c.get('hubId') ?? ''

  // ---------------------------------------------------------------------------
  // GET / — List
  // ---------------------------------------------------------------------------

  if (!disableList) {
    const listDescribe = describeRoute({
      tags: [tag],
      summary: `List ${domain}`,
      responses: {
        200: {
          description: `List of ${domain}`,
          content: { 'application/json': { schema: resolver(listResponseSchema) } },
        },
        ...authErrors,
      },
    })

    const listHandler = async (c: Ctx) => {
      const services = c.get('services')
      const svc = getSvc(services)
      const args: unknown[] = []
      if (hubScoped) args.push(getHubId(c))
      if (listQuerySchema) {
        args.push(c.req.valid('query' as never))
      }
      const result = await (svc[listMethod] as ServiceMethod)(...args)
      return c.json(result as Record<string, unknown>)
    }

    if (listQuerySchema) {
      router.get('/',
        listDescribe,
        requirePermission(perm('read', permissionOverrides.list)),
        validator('query', listQuerySchema),
        listHandler,
      )
    } else {
      router.get('/',
        listDescribe,
        requirePermission(perm('read', permissionOverrides.list)),
        listHandler,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // GET /:id — Get single item
  // ---------------------------------------------------------------------------

  if (!disableGet) {
    router.get(`/:${idParam}`,
      describeRoute({
        tags: [tag],
        summary: `Get ${domain} by ${idParam}`,
        responses: {
          200: {
            description: `${tag} details`,
            content: { 'application/json': { schema: resolver(itemResponseSchema) } },
          },
          ...authErrors,
          ...notFoundError,
        },
      }),
      requirePermission(perm('read', permissionOverrides.get)),
      async (c) => {
        const services = c.get('services')
        const svc = getSvc(services)
        const id = c.req.param(idParam)
        const args: unknown[] = []
        if (hubScoped) args.push(getHubId(c))
        args.push(id)
        const result = await (svc[getMethod] as ServiceMethod)(...args)
        return c.json(result as Record<string, unknown>)
      },
    )
  }

  // ---------------------------------------------------------------------------
  // POST / — Create
  // ---------------------------------------------------------------------------

  if (createBodySchema) {
    router.post('/',
      describeRoute({
        tags: [tag],
        summary: `Create ${domain}`,
        responses: {
          201: {
            description: `${tag} created`,
            content: { 'application/json': { schema: resolver(itemResponseSchema) } },
          },
          ...authErrors,
        },
      }),
      requirePermission(perm('create', permissionOverrides.create)),
      validator('json', createBodySchema),
      async (c) => {
        const services = c.get('services')
        const svc = getSvc(services)
        const pubkey = c.get('pubkey')
        const permissions = c.get('permissions') ?? []
        const body = c.req.valid('json' as never)
        const args: unknown[] = []
        if (hubScoped) args.push(getHubId(c))
        args.push(body)
        args.push({ callerPubkey: pubkey, permissions })
        const result = await (svc[createMethod] as ServiceMethod)(...args)
        if (auditEvents.created) {
          const auditHubId = hubScoped ? getHubId(c) || null : null
          await audit(services.audit, auditEvents.created, pubkey, {}, undefined, auditHubId)
        }
        return c.json(result as Record<string, unknown>, 201)
      },
    )
  }

  // ---------------------------------------------------------------------------
  // PATCH /:id — Update
  // ---------------------------------------------------------------------------

  if (updateBodySchema) {
    router.patch(`/:${idParam}`,
      describeRoute({
        tags: [tag],
        summary: `Update ${domain}`,
        responses: {
          200: {
            description: `${tag} updated`,
            content: { 'application/json': { schema: resolver(itemResponseSchema) } },
          },
          ...authErrors,
          ...notFoundError,
        },
      }),
      requirePermission(perm('update', permissionOverrides.update)),
      validator('json', updateBodySchema),
      async (c) => {
        const services = c.get('services')
        const svc = getSvc(services)
        const pubkey = c.get('pubkey')
        const permissions = c.get('permissions') ?? []
        const id = c.req.param(idParam)
        const body = c.req.valid('json' as never)
        const args: unknown[] = []
        if (hubScoped) args.push(getHubId(c))
        args.push(id)
        args.push(body)
        args.push({ callerPubkey: pubkey, permissions })
        const result = await (svc[updateMethod] as ServiceMethod)(...args)
        if (auditEvents.updated) {
          const auditHubId = hubScoped ? getHubId(c) || null : null
          await audit(services.audit, auditEvents.updated, pubkey, { [`${domain}Id`]: id }, undefined, auditHubId)
        }
        return c.json(result as Record<string, unknown>)
      },
    )
  }

  // ---------------------------------------------------------------------------
  // DELETE /:id — Delete
  // ---------------------------------------------------------------------------

  if (!disableDelete) {
    router.delete(`/:${idParam}`,
      describeRoute({
        tags: [tag],
        summary: `Delete ${domain}`,
        responses: {
          200: {
            description: `${tag} deleted`,
            content: { 'application/json': { schema: resolver(okResponseSchema) } },
          },
          ...authErrors,
          ...notFoundError,
        },
      }),
      requirePermission(perm('delete', permissionOverrides.delete)),
      async (c) => {
        const services = c.get('services')
        const svc = getSvc(services)
        const pubkey = c.get('pubkey')
        const permissions = c.get('permissions') ?? []
        const id = c.req.param(idParam)
        const args: unknown[] = []
        if (hubScoped) args.push(getHubId(c))
        args.push(id)
        args.push({ callerPubkey: pubkey, permissions })
        await (svc[deleteMethod] as ServiceMethod)(...args)
        if (auditEvents.deleted) {
          const auditHubId = hubScoped ? getHubId(c) || null : null
          await audit(services.audit, auditEvents.deleted, pubkey, { [`${domain}Id`]: id }, undefined, auditHubId)
        }
        // The factory declares every delete as `{ ok }`, so it owns the body: a
        // service's own return (`{ deleted: true }`, a row) is not the contract.
        return c.json({ ok: true })
      },
    )
  }

  return router
}

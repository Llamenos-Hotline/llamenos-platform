/**
 * Hub authority chain routes (#2963; wire spec §5.1), mounted at
 * /api/hubs/:hubId/chain behind `hubContext` (members only).
 *
 *   GET  /   fetch forward from `from`, paginated
 *   POST /   append one signed link: compare-and-set against the head
 *
 * Any member may ask to append: authority is decided by the chain itself,
 * through the crate (`HubChainService.appendInTx`), never by a server role
 * check — a server check would only ever be a weaker copy of the crate's.
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { authErrors } from '../openapi/helpers'
import {
  appendHubChainLinkBodySchema,
  appendHubChainLinkResponseSchema,
  hubChainConflictResponseSchema,
  hubChainQuerySchema,
  hubChainRejectedResponseSchema,
  hubChainResponseSchema,
} from '@protocol/schemas/hub-chain'
import { HubChainConflictError, HubChainRejectedError } from '../services/hub-chain'
import { audit } from '../services/audit'

const routes = new Hono<AppEnv>()

routes.get('/',
  describeRoute({
    tags: ['Hubs'],
    summary: "Read the hub's authority chain forward from a seq",
    responses: {
      200: {
        description: 'Links with seq >= from, in seq order',
        content: { 'application/json': { schema: resolver(hubChainResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  validator('query', hubChainQuerySchema),
  async (c) => {
    const hubId = c.get('hubId') as string
    const { from, limit } = c.req.valid('query')
    const page = await c.get('services').hubChain.read(hubId, from, limit)
    return c.json({ hubId, ...page })
  },
)

routes.post('/',
  describeRoute({
    tags: ['Hubs'],
    summary: "Append one signed link to the hub's authority chain",
    responses: {
      201: {
        description: 'Appended; the new head',
        content: { 'application/json': { schema: resolver(appendHubChainLinkResponseSchema) } },
      },
      ...authErrors,
      400: {
        description: 'The crate refused the link, by its closed rejection code',
        content: { 'application/json': { schema: resolver(hubChainRejectedResponseSchema) } },
      },
      409: {
        description: 'The head moved: re-read, re-evaluate authority, re-sign and retry',
        content: { 'application/json': { schema: resolver(hubChainConflictResponseSchema) } },
      },
    },
  }),
  validator('json', appendHubChainLinkBodySchema),
  async (c) => {
    const hubId = c.get('hubId') as string
    const services = c.get('services')
    const { link } = c.req.valid('json')
    try {
      const head = await services.hubChain.append(hubId, link)
      await audit(services.audit, 'hubChainLinkAppended', c.get('pubkey'), {
        seq: link.seq,
        type: link.body.type,
        signerUser: link.signerUser,
      }, undefined, hubId)
      return c.json({ head }, 201)
    } catch (err) {
      if (err instanceof HubChainConflictError) {
        return c.json({ error: err.message, code: 'chain_head_moved' as const, head: err.head }, 409)
      }
      if (err instanceof HubChainRejectedError) {
        return c.json({ error: err.message, code: err.code ?? 'invalid_input' }, 400)
      }
      throw err
    }
  },
)

export default routes

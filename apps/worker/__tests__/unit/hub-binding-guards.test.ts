/**
 * Every `/:id` route of a hub-bound router is behind the hub guard (#2011).
 *
 * The behaviour of the guard — a row of another hub reads as missing — is pinned
 * against real rows in integration-bun/hub-resource-binding.test.ts. This file
 * pins the other half: that NO route of these routers can be added without it.
 * It walks the router's own route table, and for each `:id` route asks the
 * question a future handler would have to answer: "inside /hubs/A, given an id
 * the guard says belongs to another hub, do you run?" A handler that does shows
 * up here as anything other than a 404.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { ServiceError } from '../../services/settings'
import conversationsRouter from '../../routes/conversations'
import reportsRouter from '../../routes/reports'
import notesRouter from '../../routes/notes'
import blastsRouter from '../../routes/blasts'
import directoryRouter from '../../routes/contacts-v2'
import eventsRouter from '../../routes/events'
import firehoseRouter from '../../routes/firehose'

/** A service whose every method fails the test unless the case lent it a stand-in. */
function tripwire(lent: Record<string, unknown> = {}): unknown {
  return new Proxy(lent, {
    get: (target, prop) =>
      prop in target
        ? target[prop as string]
        : () => { throw new Error(`handler reached: ${String(prop)}`) },
  })
}

const OTHER_HUB_ROW = { hubId: 'hub-other' }
const notFound = (what: string) => () => { throw new ServiceError(404, `${what} not found`) }

const CASES = [
  {
    name: 'conversations',
    router: conversationsRouter,
    services: { conversations: tripwire({ getByIdForHub: notFound('Conversation') }) },
  },
  {
    name: 'reports',
    router: reportsRouter,
    services: { conversations: tripwire({ getByIdForHub: notFound('Conversation') }) },
  },
  {
    name: 'notes',
    router: notesRouter,
    services: { records: tripwire({ getNote: async () => OTHER_HUB_ROW }) },
  },
  {
    name: 'blasts',
    router: blastsRouter,
    services: {
      blasts: tripwire({
        getBlast: async () => OTHER_HUB_ROW,
        getSubscriberById: async () => OTHER_HUB_ROW,
      }),
    },
  },
  {
    name: 'directory',
    router: directoryRouter,
    services: {
      contacts: tripwire({
        get: async () => OTHER_HUB_ROW,
        getGroup: async () => OTHER_HUB_ROW,
      }),
    },
  },
  {
    name: 'events',
    router: eventsRouter,
    services: { cases: tripwire({ getEvent: async () => OTHER_HUB_ROW }) },
  },
  {
    name: 'firehose',
    router: firehoseRouter,
    services: { firehose: tripwire({ getConnection: async () => OTHER_HUB_ROW }) },
  },
]

describe('hub-bound routers refuse a foreign id on every :id route', () => {
  for (const { name, router, services } of CASES) {
    const idRoutes = [...new Map(
      router.routes
        .filter(r => r.method !== 'ALL' && /:(id|groupId)(\/|$)/.test(r.path))
        .map(r => [`${r.method} ${r.path}`, r]),
    ).values()]

    it(`${name}: found :id routes to check`, () => {
      // A route table that came back empty would make the loop below vacuous.
      expect(idRoutes.length).toBeGreaterThan(0)
    })

    for (const route of idRoutes) {
      it(`${name}: ${route.method} ${route.path} → 404 without reaching the handler`, async () => {
        const app = new Hono<AppEnv>()
        app.onError((err, c) =>
          err instanceof ServiceError
            ? c.json({ error: err.message }, err.status as 404)
            : c.json({ error: String(err) }, 500))
        app.use('*', async (c, next) => {
          c.set('pubkey', 'a'.repeat(64))
          c.set('permissions', ['*'])
          c.set('hubId', 'hub-path')
          c.set('services', services as unknown as AppEnv['Variables']['services'])
          await next()
        })
        app.route('/', router)

        const path = route.path.replace(/:\w+/g, 'some-id')
        const res = await app.request(path, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          body: route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}',
        })
        expect(res.status, await res.text()).toBe(404)
      })
    }
  }
})

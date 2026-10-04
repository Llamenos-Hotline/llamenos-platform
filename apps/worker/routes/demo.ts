import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { authErrors } from '../openapi/helpers'
import { audit } from '../services/audit'
import { demoResetRefusal } from '../lib/demo-reset-gate'
import { resetDemoData } from '../services/demo-seeder'
import { DEMO_HUB } from '../lib/demo-dataset'
import { createLogger } from '../lib/logger'

const logger = createLogger('routes.demo')

const demo = new Hono<AppEnv>()

/** A reset rebuilds the whole database — never let two overlap. */
let resetInFlight = false

/**
 * POST /api/demo/reset — wipe all data and re-seed the fixed fictional dataset.
 *
 * Authenticated, instance-admin only, and live only on a development server
 * that opted in with DEMO_MODE=true + DEMO_MODE_CONFIRM=DESTROY_ALL_DATA: the
 * reset registers the demo accounts, and their keys exist nowhere else
 * (lib/demo-identities.ts). Always refused under ENVIRONMENT=production.
 */
demo.post('/reset',
  describeRoute({
    tags: ['Demo'],
    summary: 'Wipe all data and re-seed the demo dataset (development servers only)',
    responses: {
      ...authErrors,
      200: { description: 'Data wiped and demo dataset seeded' },
      403: { description: 'Not an instance admin, or demo reset is not enabled on this deployment' },
      409: { description: 'A reset is already running' },
    },
  }),
  requirePermission('system:manage-instance'),
  async (c) => {
    const refusal = demoResetRefusal(c.env)
    if (refusal) {
      logger.warn('Demo reset refused', { reason: refusal })
      return c.json({ error: refusal }, 403)
    }
    if (resetInFlight) return c.json({ error: 'A demo reset is already running' }, 409)

    const services = c.get('services')
    const pubkey = c.get('pubkey')

    resetInFlight = true
    try {
      const summary = await resetDemoData(services, c.env)
      // Written after the wipe so it is the newest entry of the fresh audit chain
      await audit(services.audit, 'demoReset', pubkey, { ...summary }, undefined, DEMO_HUB.id)
      return c.json({ ok: true, summary })
    } finally {
      resetInFlight = false
    }
  },
)

export default demo

/**
 * System health dashboard endpoint (Epic 295).
 *
 * Aggregates health data from multiple sources (services, env, process)
 * for admin monitoring. Uses Promise.allSettled so individual source
 * failures don't break the entire response.
 */
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { systemHealthResponseSchema } from '@protocol/schemas/system'
import { authErrors } from '../openapi/helpers'
import type { Services } from '../services'

declare const __BUILD_VERSION__: string

export interface ServiceStatus {
  name: string
  status: 'ok' | 'degraded' | 'down'
  details?: string
}

export interface SystemHealth {
  server: {
    status: 'ok' | 'degraded' | 'down'
    uptime: number
    version: string
  }
  services: ServiceStatus[]
  calls: {
    today: number
    active: number
    avgResponseSeconds: number
    missed: number
  }
  storage: {
    dbSize: string
    blobStorage: string
  }
  backup: {
    lastBackup: string | null
    backupSize: string
    lastVerify: string | null
  }
  users: {
    totalActive: number
    onlineNow: number
    onShift: number
    shiftCoverage: number
  }
  timestamp: string
}

const systemRoutes = new Hono<AppEnv>()
systemRoutes.use('*', requirePermission('system:manage-instance'))

async function fetchServerHealth(): Promise<SystemHealth['server']> {
  const uptime = typeof process !== 'undefined' ? Math.floor(process.uptime()) : 0
  const version = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev'

  // Determine status based on uptime (just started = potentially degraded)
  const status = uptime > 10 ? 'ok' : 'degraded'

  return { status: status as 'ok' | 'degraded', uptime, version }
}

async function fetchServices(env: Record<string, unknown>): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = []

  // Check blob storage
  const hasStorage = !!(env.BLOB_STORAGE || env.STORAGE_MANAGER)
  services.push({
    name: 'Blob Storage',
    status: hasStorage ? 'ok' : 'down',
    details: hasStorage ? undefined : 'Not configured',
  })

  // WebSocket relay is in-process — if SERVER_SECRET is set, relay is available
  const hasRelay = !!env.SERVER_SECRET
  services.push({
    name: 'WebSocket Relay',
    status: hasRelay ? 'ok' : 'down',
    details: hasRelay ? undefined : 'SERVER_SECRET not configured (relay disabled)',
  })

  // Check telephony
  const hasTelephony = !!(env.TWILIO_ACCOUNT_SID || env.TELEPHONY_CONFIGURED)
  services.push({
    name: 'Telephony',
    status: hasTelephony ? 'ok' : 'down',
    details: hasTelephony ? undefined : 'No provider configured',
  })

  return services
}

async function fetchCallMetrics(services: Services, hubId: string): Promise<SystemHealth['calls']> {
  try {
    const [activeCalls, todayCount] = await Promise.all([
      services.calls.getActiveCalls(hubId),
      services.calls.getTodayCount(hubId),
    ])

    return {
      today: todayCount,
      active: activeCalls.length,
      avgResponseSeconds: 0,
      missed: 0,
    }
  } catch {
    return { today: 0, active: 0, avgResponseSeconds: 0, missed: 0 }
  }
}

async function fetchUserInfo(services: Services, hubId: string): Promise<SystemHealth['users']> {
  try {
    const [volResult, presenceResult, onShiftPubkeys] = await Promise.all([
      services.identity.getUsers(),
      services.calls.getPresence(hubId),
      services.shifts.getCurrentVolunteers(hubId),
    ])

    const totalActive = volResult.users.filter(v => v.active).length
    const onShift = onShiftPubkeys.length
    const shiftCoverage = totalActive > 0 ? Math.round((onShift / totalActive) * 100) : 0

    return {
      totalActive,
      onlineNow: presenceResult.users.length,
      onShift,
      shiftCoverage,
    }
  } catch {
    return { totalActive: 0, onlineNow: 0, onShift: 0, shiftCoverage: 0 }
  }
}

systemRoutes.get('/health',
  describeRoute({
    tags: ['System'],
    summary: 'Aggregated system health dashboard for admins',
    responses: {
      200: {
        description: 'System health including server, services, calls, storage, and users',
        content: {
          'application/json': {
            schema: resolver(systemHealthResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
  const env = c.env as unknown as Record<string, unknown>
  const services = c.get('services')
  const hubId = c.get('hubId') ?? ''

  const [serverResult, servicesResult, callsResult, usersResult] = await Promise.allSettled([
    fetchServerHealth(),
    fetchServices(env),
    fetchCallMetrics(services, hubId),
    fetchUserInfo(services, hubId),
  ])

  const server = serverResult.status === 'fulfilled'
    ? serverResult.value
    : { status: 'down' as const, uptime: 0, version: 'unknown' }

  const servicesList = servicesResult.status === 'fulfilled'
    ? servicesResult.value
    : []

  const calls = callsResult.status === 'fulfilled'
    ? callsResult.value
    : { today: 0, active: 0, avgResponseSeconds: 0, missed: 0 }

  const users = usersResult.status === 'fulfilled'
    ? usersResult.value
    : { totalActive: 0, onlineNow: 0, onShift: 0, shiftCoverage: 0 }

  // Derive overall server status from services
  const anyDown = servicesList.some(s => s.status === 'down')
  const anyDegraded = servicesList.some(s => s.status === 'degraded')
  if (anyDown) server.status = 'degraded'
  if (anyDegraded && server.status === 'ok') server.status = 'degraded'

  const health: SystemHealth = {
    server,
    services: servicesList,
    calls,
    storage: {
      dbSize: 'N/A',
      blobStorage: (env.BLOB_STORAGE || env.STORAGE_MANAGER) ? 'Connected' : 'Not configured',
    },
    backup: {
      lastBackup: null,
      backupSize: 'N/A',
      lastVerify: null,
    },
    users,
    timestamp: new Date().toISOString(),
  }

  return c.json(health)
})

export default systemRoutes

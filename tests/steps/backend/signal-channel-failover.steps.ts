/**
 * Step definitions for core/signal-channel.feature's Number Failover
 * scenarios.
 *
 * apps/worker/messaging/signal/failover.ts is real, tested, pure
 * state-machine code — getFailoverState/setActiveTarget/runHealthCheck/
 * getActiveSignalConfig — but has no HTTP route and no caller from the send
 * path (tracked separately; wiring it into the adapter factory needs a
 * `failover` field on the shared SignalConfig type, which lives in
 * packages/shared/ — outside backend's owned paths). These steps drive the
 * real exported functions directly via dev-only test endpoints
 * (dev.ts's /test-simulate/signal-failover/*). "a health check runs" passes
 * an injectable fake health checker (added to failover.ts alongside this
 * feature) instead of hitting a real bridge, since none is reachable in
 * CI/local either.
 *
 * Each scenario uses `workerHub` (a fresh, unique hub id per scenario) as the
 * failover state key, so scenarios never see each other's in-memory state —
 * failoverStates in failover.ts is a module-level Map shared by the whole
 * backend-bdd process.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { devPost } from '../../api-helpers'

const STATE_KEY = 'signal-channel-failover'

interface FailoverState {
  threshold: number
  autoRecover: boolean
  activeTarget?: string
  lastFailoverAt?: string | null
  lastRecoveryAt?: string | null
  activeConfig?: { bridgeUrl?: string; bridgeApiKey?: string }
}

function getLocalState(world: Record<string, unknown>): FailoverState {
  const existing = getState<FailoverState | undefined>(world, STATE_KEY)
  if (existing) return existing
  const fresh: FailoverState = { threshold: 3, autoRecover: true }
  setState(world, STATE_KEY, fresh)
  return fresh
}

// ── Given ────────────────────────────────────────────────────────────

Given('failover is enabled with threshold {int}', ({ world }, threshold: number) => {
  getLocalState(world).threshold = threshold
})

Given(
  'the primary bridge has failed {int} consecutive health checks',
  async ({ request, world, workerHub }, times: number) => {
    const local = getLocalState(world)
    for (let i = 0; i < times; i++) {
      const { status } = await devPost(request, '/test-simulate/signal-failover/health-check', {
        key: workerHub,
        failoverConfig: { failoverThreshold: local.threshold },
        primaryHealthy: false,
        // Backup not yet confirmed healthy during setup — matches real
        // runHealthCheck, which stays on primary if the backup check also fails.
        backupHealthy: false,
      })
      expect(status).toBe(200)
    }
  },
)

Given('the active target is {string} with auto-recover enabled', async ({ request, world, workerHub }, target: string) => {
  const local = getLocalState(world)
  local.autoRecover = true
  if (target === 'backup') {
    const { status } = await devPost(request, '/test-simulate/signal-failover/set-target', {
      key: workerHub,
      target: 'backup',
    })
    expect(status).toBe(200)
  }
})

Given('the active target is {string}', async ({ request, world, workerHub }, target: string) => {
  const local = getLocalState(world)
  void local
  if (target === 'backup' || target === 'primary') {
    const { status } = await devPost(request, '/test-simulate/signal-failover/set-target', {
      key: workerHub,
      target,
    })
    expect(status).toBe(200)
  }
})

Given('failover is active with backup target', async ({ request, world, workerHub }) => {
  getLocalState(world)
  const { status } = await devPost(request, '/test-simulate/signal-failover/set-target', {
    key: workerHub,
    target: 'backup',
  })
  expect(status).toBe(200)
})

// ── When ─────────────────────────────────────────────────────────────

When('a health check runs', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await devPost<{ activeTarget: string }>(
    request,
    '/test-simulate/signal-failover/health-check',
    {
      key: workerHub,
      failoverConfig: { failoverThreshold: local.threshold },
      primaryHealthy: false,
      // Backup is now confirmed reachable, so this check is the one that
      // actually crosses the failure threshold and switches over.
      backupHealthy: true,
    },
  )
  expect(status).toBe(200)
  local.activeTarget = data.activeTarget
})

When('the primary bridge health check succeeds', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await devPost<{ activeTarget: string }>(
    request,
    '/test-simulate/signal-failover/health-check',
    {
      key: workerHub,
      failoverConfig: { autoRecover: local.autoRecover, failoverThreshold: local.threshold },
      primaryHealthy: true,
    },
  )
  expect(status).toBe(200)
  local.activeTarget = data.activeTarget
})

When('the admin manually sets the target to {string}', async ({ request, world, workerHub }, target: string) => {
  const local = getLocalState(world)
  const { status, data } = await devPost<{ activeTarget: string; lastFailoverAt: string | null }>(
    request,
    '/test-simulate/signal-failover/set-target',
    { key: workerHub, target },
  )
  expect(status).toBe(200)
  local.activeTarget = data.activeTarget
  local.lastFailoverAt = data.lastFailoverAt
})

When('a message is sent via Signal', async ({ request, world, workerHub }) => {
  const local = getLocalState(world)
  const { status, data } = await devPost<{ bridgeUrl: string; bridgeApiKey: string }>(
    request,
    '/test-simulate/signal-failover/active-config',
    { key: workerHub, failoverConfig: {} },
  )
  expect(status).toBe(200)
  local.activeConfig = data
})

// ── Then ─────────────────────────────────────────────────────────────

Then('the active target should switch to {string}', ({ world }, expected: string) => {
  expect(getLocalState(world).activeTarget).toBe(expected)
})

Then('the active target should switch back to {string}', ({ world }, expected: string) => {
  expect(getLocalState(world).activeTarget).toBe(expected)
})

Then('the active target should be {string}', ({ world }, expected: string) => {
  expect(getLocalState(world).activeTarget).toBe(expected)
})

Then('the failover timestamp should be recorded', ({ world }) => {
  expect(getLocalState(world).lastFailoverAt).toBeTruthy()
})

Then('it should use the backup bridge URL and credentials', ({ world }) => {
  const local = getLocalState(world)
  expect(local.activeConfig?.bridgeUrl).toBe('https://backup-bridge.invalid')
  expect(local.activeConfig?.bridgeApiKey).toBe('backup-key')
})

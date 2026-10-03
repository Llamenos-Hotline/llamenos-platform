/**
 * SignalFailoverService — manages failover between primary and backup
 * Signal numbers when the primary becomes unreachable.
 *
 * Failover triggers:
 * - Bridge health check fails N consecutive times
 * - Send error rate exceeds threshold
 * - Manual admin override
 *
 * When failover activates:
 * 1. Outbound messages route to the backup bridge/number
 * 2. Admin is notified via audit log + Nostr event
 * 3. Primary is periodically re-checked for recovery
 * 4. When primary recovers, traffic is switched back (auto or manual)
 *
 * Configuration is stored in the messaging config as part of SignalConfig.
 */

import { createLogger } from '../../lib/logger'
import type { SignalConfig } from '@shared/types'
import { checkBridgeHealth, type BridgeHealthStatus } from './health'

const logger = createLogger('signal-failover')

export interface FailoverConfig {
  enabled: boolean
  backupBridgeUrl: string
  backupBridgeApiKey: string
  backupRegisteredNumber: string
  backupWebhookSecret: string
  /** Number of consecutive health check failures before failover (default: 3) */
  failoverThreshold: number
  /** Seconds between health checks (default: 60) */
  healthCheckIntervalSec: number
  /** Auto-recover when primary comes back online (default: true) */
  autoRecover: boolean
}

export interface FailoverState {
  activeTarget: 'primary' | 'backup'
  consecutiveFailures: number
  lastHealthCheck: string | null
  lastFailoverAt: string | null
  lastRecoveryAt: string | null
  primaryStatus: BridgeHealthStatus | null
  backupStatus: BridgeHealthStatus | null
}

const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  enabled: false,
  backupBridgeUrl: '',
  backupBridgeApiKey: '',
  backupRegisteredNumber: '',
  backupWebhookSecret: '',
  failoverThreshold: 3,
  healthCheckIntervalSec: 60,
  autoRecover: true,
}

/**
 * Per-hub failover state. Each hub (keyed by registered number) has its own
 * independent failover state. Reset on server restart — health checks will
 * quickly re-detect the correct state per hub.
 */
const failoverStates = new Map<string, FailoverState>()

function createDefaultState(): FailoverState {
  return {
    activeTarget: 'primary',
    consecutiveFailures: 0,
    lastHealthCheck: null,
    lastFailoverAt: null,
    lastRecoveryAt: null,
    primaryStatus: null,
    backupStatus: null,
  }
}

/**
 * Get the failover state for a specific hub (keyed by registered number).
 */
export function getFailoverState(key: string): Readonly<FailoverState> {
  const state = failoverStates.get(key)
  return state ? { ...state } : createDefaultState()
}

/**
 * Reset failover state for a specific hub, or all hubs if no key provided.
 */
export function resetFailoverState(key?: string): void {
  if (key) {
    failoverStates.delete(key)
  } else {
    failoverStates.clear()
  }
}

function getOrCreateState(key: string): FailoverState {
  let state = failoverStates.get(key)
  if (!state) {
    state = createDefaultState()
    failoverStates.set(key, state)
  }
  return state
}

/**
 * Manually set the active target (admin override).
 */
export function setActiveTarget(key: string, target: 'primary' | 'backup'): void {
  const state = getOrCreateState(key)
  const previous = state.activeTarget
  state.activeTarget = target
  state.consecutiveFailures = 0

  if (target === 'backup' && previous === 'primary') {
    state.lastFailoverAt = new Date().toISOString()
  } else if (target === 'primary' && previous === 'backup') {
    state.lastRecoveryAt = new Date().toISOString()
  }

  logger.info('Active target manually set', { key, target, previous })
}

/**
 * Run a health check cycle. Called periodically by the scheduler.
 * State is keyed by the primary config's registered number.
 *
 * Logic:
 * 1. Check primary health
 * 2. If primary healthy and we're on backup with autoRecover → switch back
 * 3. If primary unhealthy → increment failure count
 * 4. If failures >= threshold → switch to backup
 */
export async function runHealthCheck(
  primaryConfig: SignalConfig,
  failoverConfig: FailoverConfig,
  // Injectable so callers (tests) can supply a deterministic result instead of
  // a real network round-trip — there is no reachable signal-cli bridge in
  // CI/local (see core/signal-channel.feature's Number Failover comment).
  // Defaults to the real bridge health check, so production behavior is
  // unchanged.
  checkHealth: (config: SignalConfig) => Promise<BridgeHealthStatus> = checkBridgeHealth,
): Promise<FailoverState> {
  const key = primaryConfig.registeredNumber
  if (!failoverConfig.enabled) {
    return getFailoverState(key)
  }

  const state = getOrCreateState(key)
  const now = new Date().toISOString()
  state.lastHealthCheck = now

  // Check primary
  const primaryHealth = await checkHealth(primaryConfig)
  state.primaryStatus = primaryHealth

  if (primaryHealth.connected) {
    // Primary is healthy
    if (state.activeTarget === 'backup' && failoverConfig.autoRecover) {
      // Switch back to primary
      state.activeTarget = 'primary'
      state.lastRecoveryAt = now
      state.consecutiveFailures = 0
      logger.info('Primary Signal bridge recovered, switching back', { key })
    } else {
      state.consecutiveFailures = 0
    }
  } else {
    // Primary is down
    state.consecutiveFailures++

    logger.warn('Primary Signal bridge health check failed', {
      key,
      failures: state.consecutiveFailures,
      threshold: failoverConfig.failoverThreshold,
      error: primaryHealth.error,
    })

    if (
      state.activeTarget === 'primary' &&
      state.consecutiveFailures >= failoverConfig.failoverThreshold
    ) {
      // Check backup before failing over
      const backupConfig: SignalConfig = {
        bridgeUrl: failoverConfig.backupBridgeUrl,
        bridgeApiKey: failoverConfig.backupBridgeApiKey,
        registeredNumber: failoverConfig.backupRegisteredNumber,
        webhookSecret: failoverConfig.backupWebhookSecret,
      }
      const backupHealth = await checkHealth(backupConfig)
      state.backupStatus = backupHealth

      if (backupHealth.connected) {
        state.activeTarget = 'backup'
        state.lastFailoverAt = now
        logger.warn('Failing over to backup Signal bridge', {
          key,
          primaryError: primaryHealth.error,
          backupNumber: failoverConfig.backupRegisteredNumber.slice(-4),
        })
      } else {
        logger.error('Both primary and backup Signal bridges are down', {
          key,
          primaryError: primaryHealth.error,
          backupError: backupHealth.error,
        })
      }
    }
  }

  return { ...state }
}

/**
 * Get the active Signal config based on failover state.
 * Returns the backup config if failover is active, otherwise the primary.
 */
export function getActiveSignalConfig(
  primaryConfig: SignalConfig,
  failoverConfig?: FailoverConfig,
): SignalConfig {
  const key = primaryConfig.registeredNumber
  const state = failoverStates.get(key)

  if (
    !failoverConfig?.enabled ||
    !state ||
    state.activeTarget === 'primary'
  ) {
    return primaryConfig
  }

  return {
    bridgeUrl: failoverConfig.backupBridgeUrl,
    bridgeApiKey: failoverConfig.backupBridgeApiKey,
    registeredNumber: failoverConfig.backupRegisteredNumber,
    webhookSecret: failoverConfig.backupWebhookSecret,
    autoResponse: primaryConfig.autoResponse,
    afterHoursResponse: primaryConfig.afterHoursResponse,
  }
}

/**
 * Parse failover config from the signal section of messaging config.
 * Returns DEFAULT_FAILOVER_CONFIG if not configured.
 */
export function parseFailoverConfig(
  signalConfig: SignalConfig & { failover?: Partial<FailoverConfig> },
): FailoverConfig {
  const fc = signalConfig.failover
  if (!fc) return DEFAULT_FAILOVER_CONFIG

  return {
    ...DEFAULT_FAILOVER_CONFIG,
    ...fc,
    enabled: fc.enabled ?? false,
  }
}

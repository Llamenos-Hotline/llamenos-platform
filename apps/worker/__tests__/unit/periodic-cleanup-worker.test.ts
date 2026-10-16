import { describe, it, expect, vi } from 'vitest'
import { runPeriodicCleanup } from '../../lib/periodic-cleanup-worker'
import type { IdentityService } from '../../services/identity'
import type { SettingsService } from '../../services/settings'

function setup() {
  const identityService = {
    cleanup: vi.fn(async () => ({
      expiredSessions: 1,
      expiredChallenges: 2,
      expiredProvisionRooms: 3,
      expiredInvites: 4,
      expiredAuthNonces: 5,
    })),
  }
  const settingsService = {
    runCleanup: vi.fn(async () => ({
      captchaChallengesDeleted: 1,
      rateLimitEntriesDeleted: 2,
      expiredSessionsDeleted: 0,
      provisionRoomsDeleted: 0,
      expiredInvitesCleaned: 0,
      webauthnChallengesDeleted: 0,
      staleFileUploadsDeleted: 0,
      completedBlastQueuesDeleted: 0,
      lastCleanupAt: new Date().toISOString(),
    })),
    clearExpiredApiRateLimits: vi.fn(async () => undefined),
  }
  return {
    identityService,
    settingsService,
    opts: {
      identityService: identityService as unknown as IdentityService,
      settingsService: settingsService as unknown as SettingsService,
    },
  }
}

describe('runPeriodicCleanup', () => {
  it('runs identity cleanup, settings cleanup, and the API rate-limit purge', async () => {
    const { opts, identityService, settingsService } = setup()

    await runPeriodicCleanup(opts)

    expect(identityService.cleanup).toHaveBeenCalledTimes(1)
    expect(settingsService.runCleanup).toHaveBeenCalledTimes(1)
    expect(settingsService.clearExpiredApiRateLimits).toHaveBeenCalledTimes(1)
  })

  it('still runs settings cleanup and the rate-limit purge when identity cleanup fails', async () => {
    const { opts, identityService, settingsService } = setup()
    identityService.cleanup.mockRejectedValueOnce(new Error('db down'))

    await expect(runPeriodicCleanup(opts)).resolves.toBeUndefined()

    expect(settingsService.runCleanup).toHaveBeenCalledTimes(1)
    expect(settingsService.clearExpiredApiRateLimits).toHaveBeenCalledTimes(1)
  })

  it('still runs the rate-limit purge when settings cleanup fails', async () => {
    const { opts, identityService, settingsService } = setup()
    settingsService.runCleanup.mockRejectedValueOnce(new Error('db down'))

    await expect(runPeriodicCleanup(opts)).resolves.toBeUndefined()

    expect(identityService.cleanup).toHaveBeenCalledTimes(1)
    expect(settingsService.clearExpiredApiRateLimits).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the rate-limit purge fails', async () => {
    const { opts, settingsService } = setup()
    settingsService.clearExpiredApiRateLimits.mockRejectedValueOnce(new Error('db down'))

    await expect(runPeriodicCleanup(opts)).resolves.toBeUndefined()
  })
})

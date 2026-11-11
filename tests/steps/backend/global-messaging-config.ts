/**
 * Writing the instance-wide messaging channel config from a scenario.
 *
 * `PATCH /settings/messaging` writes the `system_settings` singleton: the
 * config every hub without its own falls back to. A Signal bridge written
 * there is read by EVERY concurrent Signal scenario, and the API has no unset.
 *
 * That makes the write a hazard in the parallel `backend-bdd` project. Until
 * #2551 a reply to an unreachable bridge was stored as `sent`, so a leaked
 * bridge at a dead address was invisible: every later Signal reply scenario
 * "passed" while no provider accepted anything. Now such a reply is `failed`,
 * so a leaked bridge breaks exactly the scenarios that need a working channel.
 *
 * So the write is only possible from a scenario tagged @global-setting (the
 * serial project, which never overlaps `backend-bdd`), and the After hook below
 * puts back exactly the config that was there before the scenario wrote.
 */
import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { After, getState, setState } from './fixtures'
import { apiPatch } from '../../api-helpers'
import { TestDB } from '../../db-helpers'

const KEY = 'global-messaging-config'

interface GlobalMessagingConfigState {
  /** `messaging_config` as it was before this scenario's first write. */
  before?: string
}

function getGMC(world: Record<string, unknown>): GlobalMessagingConfigState {
  return { ...getState<Partial<GlobalMessagingConfigState> | undefined>(world, KEY) }
}

After(async ({ world }) => {
  const { before } = getGMC(world)
  if (before !== undefined) await TestDB.restoreGlobalMessagingConfig(before)
})

/**
 * Configure the instance-wide Signal channel with a bridge at `bridgeUrl`.
 * Throws unless the scenario is tagged @global-setting.
 */
export async function configureGlobalSignalBridge(
  request: APIRequestContext,
  world: Record<string, unknown>,
  tags: readonly string[],
  bridgeUrl: string,
): Promise<void> {
  if (!tags.includes('@global-setting')) {
    throw new Error(
      'This step configures the instance-wide messaging channel, which every hub without its own '
      + 'config falls back to. Tag the scenario @global-setting so it runs in the serial project '
      + 'and cannot reach the concurrent Signal scenarios.',
    )
  }
  // Recorded BEFORE the first write, so a failed PATCH is still undone and a second
  // write in the same scenario cannot overwrite the snapshot with its own first one.
  if (getGMC(world).before === undefined) {
    setState(world, KEY, { before: await TestDB.snapshotGlobalMessagingConfig() } satisfies GlobalMessagingConfigState)
  }
  const { status } = await apiPatch(request, '/settings/messaging', {
    signal: {
      bridgeUrl,
      bridgeApiKey: 'test',
      webhookSecret: 'test',
      registeredNumber: '+15550000000',
    },
  })
  expect(status).toBe(200)
}

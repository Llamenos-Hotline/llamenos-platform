/**
 * Step definitions for the delivery-honesty scenarios (#2551).
 *
 * The invariant under test: `sent` means a provider accepted the message. A
 * reply whose provider never accepted it — here a channel configured against
 * an unreachable bridge — is stored as `failed` with the reason, never as
 * `sent`, so a volunteer is never shown a delivered-looking reply the caller
 * did not receive.
 *
 * The Given writes the instance-wide messaging config every hub falls back
 * to, so its scenarios must be tagged @global-setting (serial project) and
 * the After hook resets what they wrote.
 */
import { expect } from '@playwright/test'
import { Given, Then, After, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { apiGet, apiPatch } from '../../api-helpers'
import { TestDB } from '../../db-helpers'

const KEY = 'message-delivery-integrity'

interface DeliveryIntegrityState {
  wroteGlobalMessagingConfig?: boolean
}

function getDI(world: Record<string, unknown>): DeliveryIntegrityState {
  return { ...getState<Partial<DeliveryIntegrityState> | undefined>(world, KEY) }
}

After(async ({ world }) => {
  if (getDI(world).wroteGlobalMessagingConfig) await TestDB.resetGlobalMessagingConfig()
})

Given(
  'the {string} channel is configured with an unreachable bridge',
  async ({ request, world, $tags }, channel: string) => {
    if (!$tags.includes('@global-setting')) {
      throw new Error(
        'This step configures the instance-wide messaging channel, which every hub without its own '
        + 'config falls back to. Tag the scenario @global-setting so it runs in the serial project.',
      )
    }
    if (channel !== 'signal') {
      throw new Error(`No unreachable-bridge fixture for channel ${channel}`)
    }
    // Port 1 refuses immediately — the provider is configured but cannot be
    // reached, the exact "bridge unreachable" path #2551 covers.
    const { status } = await apiPatch(request, '/settings/messaging', {
      signal: {
        bridgeUrl: 'http://127.0.0.1:1',
        bridgeApiKey: 'test',
        webhookSecret: 'test',
        registeredNumber: '+15550000000',
      },
    })
    expect(status).toBe(200)
    setState(world, KEY, { ...getDI(world), wroteGlobalMessagingConfig: true })
  },
)

Then(
  'the last outbound message should record a failure reason',
  async ({ request, world }) => {
    const state = getScenarioState(world)
    expect(state.conversationId).toBeDefined()
    const { status, data } = await apiGet<{ messages: Array<{ direction: string; failureReason?: string }> }>(
      request,
      `/hubs/${getScenarioState(world).hubId}/conversations/${state.conversationId}/messages`,
    )
    expect(status).toBe(200)
    const outbound = data.messages.filter(m => m.direction === 'outbound')
    expect(outbound.length).toBeGreaterThan(0)
    expect(outbound[outbound.length - 1].failureReason).toBeTruthy()
  },
)

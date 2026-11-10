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
 * to, so its scenarios must be tagged @global-setting (serial project); see
 * ./global-messaging-config.ts, which also resets what they wrote.
 */
import { expect } from '@playwright/test'
import { Given, Then } from './fixtures'
import { getScenarioState } from './common.steps'
import { configureGlobalSignalBridge } from './global-messaging-config'
import { apiGet } from '../../api-helpers'

Given(
  'the {string} channel is configured with an unreachable bridge',
  async ({ request, world, $tags }, channel: string) => {
    if (channel !== 'signal') {
      throw new Error(`No unreachable-bridge fixture for channel ${channel}`)
    }
    // Port 1 refuses immediately — the provider is configured but cannot be
    // reached, the exact "bridge unreachable" path #2551 covers.
    await configureGlobalSignalBridge(request, world, $tags, 'http://127.0.0.1:1')
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

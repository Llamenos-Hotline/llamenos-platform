/**
 * Simulation E2E tests — exercise the telephony and messaging simulation
 * endpoints so Playwright tests can verify call/message UI flows without
 * real Twilio credentials.
 *
 * These tests hit POST /api/test-simulate/* endpoints which proxy directly
 * to CallRouterDO and ConversationDO, bypassing the TelephonyAdapter.
 *
 * Prerequisites:
 *   - Backend running with ENVIRONMENT=development
 *   - DEV_RESET_SECRET set (defaults to 'test-reset-secret')
 */

import { test, expect } from '@playwright/test'
import {
  useScenarioHub,
  TestIds,
  Timeouts,
  navigateAfterLogin,
} from './helpers'
import { Navigation } from './pages/index'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
  simulateIncomingMessage,
  uniqueCallerNumber,
} from './simulation-helpers'
import { createUserViaApi } from './api-helpers'

/**
 * Every simulation in this file targets ONE hub, explicitly.
 *
 * `/api/test-simulate/*` defaults `hubId` to `''` when none is given, which
 * writes the call or conversation into the unscoped pseudo-hub. These specs
 * used to rely on that matching the client, because the client had no active
 * hub either: it chose one from `/api/config`'s roster, which on a
 * freshly-reset backend is briefly empty, so `hp()` emitted unscoped paths and
 * the two accidentally agreed. That is not a shape any deployment produces —
 * real telephony resolves a hub from the dialled number — and once the active
 * hub comes from the user's memberships (#1708) the client is always in a real
 * hub, so the simulation has to name the same one.
 *
 * `useScenarioHub` creates a hub, grants the admin membership, pins the client
 * to it and logs in; the returned id is what every simulate call below passes.
 */
async function simulationHub(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  name: string,
): Promise<string> {
  return useScenarioHub(page, request, name)
}

test.describe('Call Simulation', () => {
  test('simulated incoming call appears in call history', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-call-history')
    const callerNumber = uniqueCallerNumber()

    // Simulate an incoming call
    const { callId, status } = await simulateIncomingCall(request, {
      callerNumber,
      hubId,
    })
    expect(callId).toBeTruthy()
    expect(status).toBe('ringing')

    // Let the call go to voicemail (unanswered) so it gets recorded
    const voicemailResult = await simulateVoicemail(request, callId)
    expect(voicemailResult.status).toBe('unanswered')

    // Navigate to call history
    await Navigation.goToCallHistory(page)

    // Wait for the call list to load and show the call
    // The call should appear as an unanswered call entry
    const callList = page.getByTestId(TestIds.CALL_LIST)
    await expect(callList).toBeVisible({ timeout: Timeouts.API })

    const callRows = page.getByTestId(TestIds.CALL_ROW)
    await expect(callRows.first()).toBeVisible({ timeout: Timeouts.API })
  })

  test('simulated incoming call can be answered and ended', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-answer-end')
    const callerNumber = uniqueCallerNumber()

    // Create a volunteer to answer the call — IN the hub the call arrives in,
    // which is what `simulateAnswerCall` checks hub access against.
    const volunteer = await createUserViaApi(request, {
      name: `SimVol ${Date.now()}`,
      hubId,
    })

    // Simulate incoming call
    const { callId } = await simulateIncomingCall(request, {
      callerNumber,
      hubId,
    })
    expect(callId).toBeTruthy()

    // Answer the call as the volunteer
    const answerResult = await simulateAnswerCall(request, callId, volunteer.pubkey)
    expect(answerResult.status).toBe('in-progress')
    expect(answerResult.callId).toBe(callId)

    // End the call
    const endResult = await simulateEndCall(request, callId)
    expect(endResult.status).toBe('completed')
    expect(endResult.callId).toBe(callId)

    // Verify the completed call appears in call history
    await Navigation.goToCallHistory(page)

    const callList = page.getByTestId(TestIds.CALL_LIST)
    await expect(callList).toBeVisible({ timeout: Timeouts.API })

    const callRows = page.getByTestId(TestIds.CALL_ROW)
    await expect(callRows.first()).toBeVisible({ timeout: Timeouts.API })
  })

  test('simulated call goes to voicemail when unanswered', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-voicemail')
    const callerNumber = uniqueCallerNumber()

    const { callId } = await simulateIncomingCall(request, {
      callerNumber,
      hubId,
    })

    // Send to voicemail directly
    const result = await simulateVoicemail(request, callId)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('unanswered')

    // Navigate to calls page and verify
    await Navigation.goToCallHistory(page)

    const callList = page.getByTestId(TestIds.CALL_LIST)
    await expect(callList).toBeVisible({ timeout: Timeouts.API })
  })

  test('multiple simulated calls appear in call history', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-multi-call')
    // Create three calls with different outcomes
    const call1 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
      hubId,
    })
    const call2 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
      hubId,
    })
    const call3 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
      hubId,
    })

    // Voicemail all three
    await simulateVoicemail(request, call1.callId)
    await simulateVoicemail(request, call2.callId)
    await simulateVoicemail(request, call3.callId)

    // Navigate to call history
    await Navigation.goToCallHistory(page)

    const callList = page.getByTestId(TestIds.CALL_LIST)
    await expect(callList).toBeVisible({ timeout: Timeouts.API })

    // Should have at least 3 call rows (other tests may have created additional calls)
    const callRows = page.getByTestId(TestIds.CALL_ROW)
    await expect(callRows.first()).toBeVisible({ timeout: Timeouts.API })
    const count = await callRows.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })
})

test.describe('Message Simulation', () => {
  test('simulated incoming SMS creates a conversation', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-sms')
    const senderNumber = uniqueCallerNumber()
    const messageBody = `Test SMS ${Date.now()}`

    // Simulate incoming SMS
    const { conversationId, messageId } = await simulateIncomingMessage(request, {
      senderNumber,
      body: messageBody,
      channel: 'sms',
      hubId,
    })
    expect(conversationId).toBeTruthy()
    expect(messageId).toBeTruthy()

    // Navigate to conversations page directly (nav link may not be visible if messaging isn't configured)
    await navigateAfterLogin(page, '/conversations')

    // The conversation list should show the new conversation
    const conversationList = page.getByTestId(TestIds.CONVERSATION_LIST)
    await expect(conversationList).toBeVisible({ timeout: Timeouts.API })

    // At least one conversation item should be present
    const conversationItems = page.getByTestId(TestIds.CONVERSATION_ITEM)
    await expect(conversationItems.first()).toBeVisible({ timeout: Timeouts.API })
  })

  test('simulated incoming WhatsApp message creates a conversation', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-whatsapp')
    const senderNumber = uniqueCallerNumber()
    const messageBody = `WhatsApp test ${Date.now()}`

    const { conversationId, messageId } = await simulateIncomingMessage(request, {
      senderNumber,
      body: messageBody,
      channel: 'whatsapp',
      hubId,
    })
    expect(conversationId).toBeTruthy()
    expect(messageId).toBeTruthy()

    // Navigate to conversations page directly (nav link may not be visible if messaging isn't configured)
    await navigateAfterLogin(page, '/conversations')

    const conversationList = page.getByTestId(TestIds.CONVERSATION_LIST)
    await expect(conversationList).toBeVisible({ timeout: Timeouts.API })

    const conversationItems = page.getByTestId(TestIds.CONVERSATION_ITEM)
    await expect(conversationItems.first()).toBeVisible({ timeout: Timeouts.API })
  })

  test('multiple messages from same sender appear in one conversation', async ({ page, request }) => {
    const hubId = await simulationHub(page, request, 'sim-multi-msg')
    const senderNumber = uniqueCallerNumber()

    // Send two messages from the same number
    const msg1 = await simulateIncomingMessage(request, {
      senderNumber,
      body: `First message ${Date.now()}`,
      channel: 'sms',
      hubId,
    })
    const msg2 = await simulateIncomingMessage(request, {
      senderNumber,
      body: `Second message ${Date.now()}`,
      channel: 'sms',
      hubId,
    })

    // Both messages should be in the same conversation
    expect(msg1.conversationId).toBe(msg2.conversationId)
    expect(msg1.messageId).not.toBe(msg2.messageId)

    // Navigate to conversations directly (nav link may not be visible if messaging isn't configured)
    await navigateAfterLogin(page, '/conversations')

    const conversationList = page.getByTestId(TestIds.CONVERSATION_LIST)
    await expect(conversationList).toBeVisible({ timeout: Timeouts.API })

    // Click the conversation to view the thread
    const conversationItem = page.getByTestId(TestIds.CONVERSATION_ITEM).first()
    await conversationItem.click()

    // The thread should be visible
    const thread = page.getByTestId(TestIds.CONVERSATION_THREAD)
    await expect(thread).toBeVisible({ timeout: Timeouts.API })
  })
})

test.describe('Simulation endpoint validation', () => {
  test('incoming call requires callerNumber', async ({ request }) => {
    try {
      await simulateIncomingCall(request, {
        callerNumber: '',
      })
      // Should not reach here
      expect(true).toBe(false)
    } catch (err) {
      expect(String(err)).toContain('400')
    }
  })

  test('answer call requires callId and pubkey', async ({ request }) => {
    try {
      await simulateAnswerCall(request, '', '')
      expect(true).toBe(false)
    } catch (err) {
      expect(String(err)).toContain('400')
    }
  })

  test('incoming message requires senderNumber and body', async ({ request }) => {
    try {
      await simulateIncomingMessage(request, {
        senderNumber: '',
        body: '',
      })
      expect(true).toBe(false)
    } catch (err) {
      expect(String(err)).toContain('400')
    }
  })

  test('end-call on nonexistent callId returns error', async ({ request }) => {
    try {
      await simulateEndCall(request, 'nonexistent-call-id')
      expect(true).toBe(false)
    } catch (err) {
      expect(String(err)).toContain('failed')
    }
  })
})

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
  loginAsAdmin,
  TestIds,
  Timeouts,
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

test.describe('Call Simulation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('simulated incoming call appears in call history', async ({ page, request }) => {
    const callerNumber = uniqueCallerNumber()

    // Simulate an incoming call
    const { callId, status } = await simulateIncomingCall(request, {
      callerNumber,
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
    const callerNumber = uniqueCallerNumber()

    // Create a volunteer to answer the call
    const volunteer = await createUserViaApi(request, {
      name: `SimVol ${Date.now()}`,
    })

    // Simulate incoming call
    const { callId } = await simulateIncomingCall(request, {
      callerNumber,
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
    const callerNumber = uniqueCallerNumber()

    const { callId } = await simulateIncomingCall(request, {
      callerNumber,
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
    // Create three calls with different outcomes
    const call1 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
    })
    const call2 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
    })
    const call3 = await simulateIncomingCall(request, {
      callerNumber: uniqueCallerNumber(),
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

// Inbound-message UI coverage lives in the hub-scoped BDD feature
// packages/test-specs/features/platform/desktop/messaging/inbound-messages.feature.
// This project runs on an instance with no hub at all, which the setup wizard never
// produces (it always creates a default hub), and the conversation list is scoped to
// the user's member hubs — so a message seeded here would belong to no hub and could
// not appear in any real deployment's list.

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

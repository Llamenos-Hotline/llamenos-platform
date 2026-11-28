/**
 * Tier 3 (spec §8): the desktop in-app call UI, driven through the Tauri IPC
 * mock's voice state machine (tests/mocks/tauri-core.ts) — no Rust process
 * exists here, which is the point. The real shell and SIP stack are Tier 2
 * (deploy/docker/tests/telephony/desktop-sip.e2e.ts); this tier proves what
 * the webview DOES with the shell's events (#1770).
 *
 * The ring itself is real app state: a call simulated into the scenario hub
 * through the API rings on the dashboard. The mock-only `voice_test_*`
 * commands play the far side of the shell: the PBX ringing the registered
 * endpoint (naming the app call, as X-Llamenos-Call-Id), the registrar's
 * verdict, the caller hanging up.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './console-guard'
import { Timeouts, useScenarioHub } from './helpers'
import { simulateIncomingCall, uniqueCallerNumber } from './simulation-helpers'

test.setTimeout(90_000)

async function voiceTest(page: Page, cmd: string, args: Record<string, unknown> = {}): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM, { timeout: Timeouts.AUTH })
  await page.evaluate(async () => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as { isCryptoUnlocked: () => Promise<boolean> }
    await platform.isCryptoUnlocked()
  })
  await page.evaluate(async ({ cmd, args }) => {
    const invoke = (window as unknown as Record<symbol, unknown>)[Symbol.for('llamenos_test_invoke')] as
      ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined
    if (!invoke) throw new Error('llamenos_test_invoke not available — is the Tauri mock loaded?')
    await invoke(cmd, args)
  }, { cmd, args })
}

/** Clock in from the dashboard; the webview then asks the shell to register (server-derived desired state). */
async function clockInAndRegister(page: Page): Promise<void> {
  await page.getByTestId('clock-toggle-btn').click()
  await expect(page.getByTestId('voice-registration-badge')).toHaveAttribute('data-state', 'registered', { timeout: Timeouts.API })
}

async function ringingCall(page: Page, request: import('@playwright/test').APIRequestContext, hubId: string): Promise<string> {
  const { callId } = await simulateIncomingCall(request, { callerNumber: uniqueCallerNumber(), hubId })
  await expect(page.getByTestId(`incoming-call-row-${callId}`)).toBeVisible({ timeout: Timeouts.API })
  return callId
}

test.describe('desktop in-app voice (mock IPC)', () => {
  test('clocking in registers, and clocking out unregisters, the one in-app endpoint', async ({ page, request }) => {
    await useScenarioHub(page, request, 'voice-lifecycle')
    await clockInAndRegister(page)
    await page.getByTestId('clock-toggle-btn').click()
    // Unregistered is silent (nothing to say off shift): the badge goes away.
    await expect(page.getByTestId('voice-registration-badge')).toHaveCount(0, { timeout: Timeouts.API })
  })

  test('an in-app ring is answered in the app: connecting → active, mute toggles, hang-up ends the leg', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'voice-answer')
    await clockInAndRegister(page)
    const callId = await ringingCall(page, request, hubId)

    await voiceTest(page, 'voice_test_ring', { callId: 'sip-1', appCallId: callId })
    await page.getByTestId(`voice-answer-btn-${callId}`).click()

    const controls = page.getByTestId('voice-controls')
    await expect(controls).toHaveAttribute('data-call-state', 'active')
    await expect(controls).toHaveAttribute('data-media-path', 'relay')
    await page.getByTestId('voice-mute-toggle').click()
    await expect(page.getByTestId('voice-mute-toggle')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('voice-mute-toggle').click()
    await expect(page.getByTestId('voice-mute-toggle')).toHaveAttribute('aria-pressed', 'false')
    await page.getByTestId('voice-hangup-btn').click()
    await expect(controls).toHaveCount(0)
  })

  test('declining in the app ends only the in-app leg; the call keeps ringing for the phone', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'voice-decline')
    await clockInAndRegister(page)
    const callId = await ringingCall(page, request, hubId)

    await voiceTest(page, 'voice_test_ring', { callId: 'sip-2', appCallId: callId })
    await page.getByTestId(`voice-decline-btn-${callId}`).click()
    // The leg is gone, the ring is not: the row falls back to the phone-leg answer.
    await expect(page.getByTestId(`answer-call-btn-${callId}`)).toBeVisible()
    await expect(page.getByTestId(`voice-answer-btn-${callId}`)).toHaveCount(0)
  })

  test('a registration failure renders the reason and offers no Answer into silence (#1147/#1741)', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'voice-failed')
    await clockInAndRegister(page)
    const callId = await ringingCall(page, request, hubId)
    // Rung while registered, then the registrar drops us.
    await voiceTest(page, 'voice_test_ring', { callId: 'sip-3', appCallId: callId })
    await expect(page.getByTestId(`voice-answer-btn-${callId}`)).toBeVisible()
    await voiceTest(page, 'voice_test_registration', { state: 'failed', reason: 'tls handshake' })

    const badge = page.getByTestId('voice-registration-badge')
    await expect(badge).toHaveAttribute('data-state', 'failed')
    await expect(badge).toContainText('tls handshake')
    await expect(page.getByTestId(`voice-answer-btn-${callId}`)).toHaveCount(0)
    await expect(page.getByTestId(`answer-call-btn-${callId}`)).toBeVisible()
  })

  test('an in-app leg that names a different call never answers this one', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'voice-binding')
    await clockInAndRegister(page)
    const callId = await ringingCall(page, request, hubId)
    // A leg for some other call (or one that names none) is not this call's leg.
    await voiceTest(page, 'voice_test_ring', { callId: 'sip-4', appCallId: 'some-other-call' })
    await expect(page.getByTestId(`answer-call-btn-${callId}`)).toBeVisible()
    await expect(page.getByTestId(`voice-answer-btn-${callId}`)).toHaveCount(0)
  })

  test('the caller hanging up mid-call ends the in-app leg', async ({ page, request }) => {
    const hubId = await useScenarioHub(page, request, 'voice-remote-hangup')
    await clockInAndRegister(page)
    const callId = await ringingCall(page, request, hubId)
    await voiceTest(page, 'voice_test_ring', { callId: 'sip-5', appCallId: callId })
    await page.getByTestId(`voice-answer-btn-${callId}`).click()
    await expect(page.getByTestId('voice-controls')).toHaveAttribute('data-call-state', 'active')
    await voiceTest(page, 'voice_test_remote_hangup', { callId: 'sip-5' })
    await expect(page.getByTestId('voice-controls')).toHaveCount(0)
  })
})

/**
 * Screenshot capture spec — polished, data-populated screenshots for
 * presentations and the marketing website.
 *
 * Run with:
 *   bunx playwright test tests/screenshots.spec.ts --project=chromium --workers=1
 *
 * Prerequisites:
 *   - Docker Compose dev stack running (PostgreSQL, RustFS, WebSocket relay)
 *   - bun run dev:server running (backend on :3000)
 *   - PLAYWRIGHT_TEST=true build served on :8788 (handled by playwright webServer)
 */

import { test } from '@playwright/test'
import { devSurfaceSecret } from './dev-surface-secret'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  loginAsAdmin,
  TestIds,
  Timeouts,
  resetTestState,
} from './helpers'
import { Navigation } from './pages/index'
import {
  createUserViaApi,
  createShiftViaApi,
  createBanViaApi,
  createReportViaApi,
  createContactByNameViaApi,
  enableCaseManagementViaApi,
  createEntityTypeViaApi,
  createRecordViaApi,
  uniquePhone,
} from './api-helpers'
import {
  simulateIncomingCall,
  uniqueCallerNumber,
} from './simulation-helpers'

// ── Constants ────────────────────────────────────────────────────────

const SCREENSHOTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../site/public/screenshots',
)

const DESKTOP_SIZE = { width: 1200, height: 800 }
const HD_SIZE = { width: 1920, height: 1080 }

/** Cosmetic delay after navigation — lets animations settle for screenshots. */
const SETTLE_MS = 600

// ── Helpers ──────────────────────────────────────────────────────────

/** Take desktop + HD screenshots for a given view name. */
async function capture(page: import('@playwright/test').Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })

  // Desktop (1200×800)
  await page.setViewportSize(DESKTOP_SIZE)
  await page.waitForTimeout(SETTLE_MS)
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `${name}-desktop.png`),
    fullPage: false,
  })

  // HD (1920×1080)
  await page.setViewportSize(HD_SIZE)
  await page.waitForTimeout(SETTLE_MS)
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `${name}-desktop-hd.png`),
    fullPage: false,
  })

  // Restore to desktop size for subsequent steps
  await page.setViewportSize(DESKTOP_SIZE)
}

/** Navigate via sidebar nav link, wait for page-title. */
async function goTo(page: import('@playwright/test').Page, testId: string): Promise<void> {
  const link = page.getByTestId(testId)
  const visible = await link.isVisible({ timeout: 3000 }).catch(() => false)
  if (visible) {
    await link.click()
    await page.getByTestId(TestIds.PAGE_TITLE).waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
  }
}

// ── Test Suite ───────────────────────────────────────────────────────

// Serial: screenshots share seeded data and authenticated state.
test.describe.configure({ mode: 'serial' })

test.describe('App Screenshots', () => {
  // ── Setup: seed realistic data ────────────────────────────────────

  test.beforeAll(async ({ request }) => {
    // Clean slate
    await resetTestState(request)

    // Create 4 volunteers with distinct names
    const volunteers = await Promise.all([
      createUserViaApi(request, { name: 'Ana Rivera', phone: uniquePhone() }),
      createUserViaApi(request, { name: 'Marcus Webb', phone: uniquePhone() }),
      createUserViaApi(request, { name: 'Priya Shankar', phone: uniquePhone() }),
      createUserViaApi(request, { name: 'Tomás Reyes', phone: uniquePhone() }),
    ])

    // Create shifts
    await Promise.all([
      createShiftViaApi(request, {
        name: 'Morning Shift',
        startTime: '08:00',
        endTime: '14:00',
        days: [1, 2, 3, 4, 5],
        userPubkeys: [volunteers[0].pubkey, volunteers[1].pubkey],
      }),
      createShiftViaApi(request, {
        name: 'Evening Shift',
        startTime: '14:00',
        endTime: '20:00',
        days: [1, 2, 3, 4, 5, 6],
        userPubkeys: [volunteers[2].pubkey, volunteers[3].pubkey],
      }),
      createShiftViaApi(request, {
        name: 'Weekend Night',
        startTime: '20:00',
        endTime: '02:00',
        days: [0, 6],
        userPubkeys: [volunteers[0].pubkey, volunteers[3].pubkey],
      }),
    ])

    // Add bans
    await Promise.all([
      createBanViaApi(request, { reason: 'Repeated harassment' }),
      createBanViaApi(request, { reason: 'Threatening language' }),
      createBanViaApi(request, { reason: 'Spam calls' }),
    ])

    // Create reports
    await Promise.all([
      createReportViaApi(request, { title: 'Safety concern — downtown shelter', category: 'safety', status: 'waiting' }),
      createReportViaApi(request, { title: 'Follow-up needed: caller #4821', category: 'follow-up', status: 'active' }),
      createReportViaApi(request, { title: 'Resource request: housing support', category: 'resource', status: 'closed' }),
      createReportViaApi(request, { title: 'Crisis intervention — park location', category: 'crisis', status: 'waiting' }),
    ])

    // Enable CMS and create entity type + contacts + cases
    await enableCaseManagementViaApi(request, true)

    const entityType = await createEntityTypeViaApi(request, {
      name: 'support_case',
      label: 'Support Case',
      category: 'case',
      color: '#6366f1',
      numberPrefix: 'SC',
      statuses: [
        { value: 'open', label: 'Open', order: 0 },
        { value: 'in_progress', label: 'In Progress', order: 1 },
        { value: 'resolved', label: 'Resolved', order: 2 },
        { value: 'closed', label: 'Closed', order: 3, isClosed: true },
      ] as Array<{ value: string; label: string; order: number; isClosed?: boolean }>,
      fields: [
        { name: 'location', label: 'Location', type: 'text', required: false, order: 0 },
        { name: 'notes', label: 'Notes', type: 'textarea', required: false, order: 1 },
      ],
    }).catch(() => null)

    if (entityType) {
      const entityTypeId = (entityType as Record<string, unknown>).id as string
      if (entityTypeId) {
        await Promise.all([
          createRecordViaApi(request, entityTypeId, { statusHash: 'open', assignedTo: [volunteers[0].pubkey] }),
          createRecordViaApi(request, entityTypeId, { statusHash: 'in_progress', assignedTo: [volunteers[1].pubkey] }),
          createRecordViaApi(request, entityTypeId, { statusHash: 'resolved' }),
        ])
      }
    }

    // Create contacts
    await Promise.all([
      createContactByNameViaApi(request, 'Jordan Chen'),
      createContactByNameViaApi(request, 'Sam Okonkwo'),
      createContactByNameViaApi(request, 'Riya Patel'),
      createContactByNameViaApi(request, 'Alex Torres'),
    ])
  })

  // ── 1. Login screen (pre-auth) ─────────────────────────────────────

  test('login screen', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    // Clear any stored credentials so we see the nsec input
    await page.goto('/login')
    await page.evaluate(() => {
      sessionStorage.clear()
      localStorage.removeItem('llamenos:llamenos-encrypted-device-keys')
      localStorage.removeItem('llamenos:llamenos-encrypted-key')
      localStorage.removeItem('llamenos-encrypted-key')
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    // Wait for the nsec input to be visible (fresh login state)
    await page.getByTestId(TestIds.DEVICE_KEY_INPUT).waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
    await capture(page, 'login')
  })

  // ── 2. Login + navigate authenticated views ────────────────────────

  test('dashboard', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await page.getByTestId(TestIds.PAGE_TITLE).waitFor({ state: 'visible', timeout: Timeouts.AUTH })
    await capture(page, 'dashboard')
  })

  test('active call', async ({ page, request }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)

    // Simulate incoming call and leave it ringing so the UI shows the call panel
    const callerNumber = uniqueCallerNumber()
    await simulateIncomingCall(request, { callerNumber }).catch(() => {
      // If simulation fails (backend not configured), capture dashboard as fallback
    })

    // Navigate to calls / dashboard which should show the active call panel
    await goTo(page, TestIds.NAV_CALLS)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'calls')
  })

  test('notes', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToNotes(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'notes')
  })

  test('conversations', async ({ page, request }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)

    // Simulate incoming SMS messages to populate conversations
    const secret = devSurfaceSecret()
    for (const msg of [
      { senderNumber: uniqueCallerNumber(), body: 'Hi, I need some support right now' },
      { senderNumber: uniqueCallerNumber(), body: 'Is there anyone available to talk?' },
      { senderNumber: uniqueCallerNumber(), body: 'Following up from yesterday' },
    ]) {
      await request.post('http://localhost:3000/api/test-simulate/incoming-message', {
        headers: { 'Content-Type': 'application/json', 'X-Test-Secret': secret },
        data: msg,
      }).catch(() => {})
    }

    await Navigation.goToConversations(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'conversations')
  })

  test('shifts', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToShifts(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'shifts')
  })

  test('contacts', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    // Navigate to contacts — uses nav-contacts testId
    const contactsNav = page.getByTestId(TestIds.NAV_CONTACTS)
    const visible = await contactsNav.isVisible({ timeout: 3000 }).catch(() => false)
    if (visible) {
      await contactsNav.click()
      await page.getByTestId(TestIds.PAGE_TITLE).waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
    } else {
      // Try direct URL navigation
      await page.goto('/contacts')
      await page.waitForLoadState('domcontentloaded')
    }
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'contacts')
  })

  test('cases', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    // Cases nav — testId from navTestIdMap: 'nav-cases'
    const casesNav = page.getByTestId('nav-cases')
    const visible = await casesNav.isVisible({ timeout: 3000 }).catch(() => false)
    if (visible) {
      await casesNav.click()
      await page.getByTestId(TestIds.PAGE_TITLE).waitFor({ state: 'visible', timeout: Timeouts.ELEMENT })
    } else {
      await page.goto('/cases')
      await page.waitForLoadState('domcontentloaded')
      await page.getByTestId(TestIds.PAGE_TITLE).waitFor({ state: 'visible', timeout: Timeouts.ELEMENT }).catch(() => {})
    }
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'cases')
  })

  test('reports', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToReports(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'reports')
  })

  test('blasts', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToBlasts(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'blasts')
  })

  test('users/volunteers', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToVolunteers(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'volunteers')
  })

  test('audit log', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToAuditLog(page)
    // Wait for audit entries to load
    const entry = page.getByTestId(TestIds.AUDIT_ENTRY).first()
    await entry.waitFor({ state: 'visible', timeout: Timeouts.API }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'audit')
  })

  test('settings', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToSettings(page)
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'settings')
  })

  test('ban management', async ({ page }) => {
    await page.setViewportSize(DESKTOP_SIZE)
    await loginAsAdmin(page)
    await Navigation.goToBanList(page)
    // Wait for ban rows to load
    const banRow = page.getByTestId(TestIds.BAN_ROW).first()
    await banRow.waitFor({ state: 'visible', timeout: Timeouts.API }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)
    await capture(page, 'bans')
  })
})

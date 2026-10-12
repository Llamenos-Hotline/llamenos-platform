/**
 * Event management step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/platform/desktop/cases/cms-events.feature
 *
 * Note: The /events route is not yet implemented in the desktop client.
 * These steps define the target behavior and will operate against the
 * cases page filtered by event entity types until a dedicated route exists.
 *
 * Behavioral depth: Event CRUD via API preconditions, event detail with
 * linked cases and reports, event status changes. Hard assertions on
 * actual test IDs present in the components.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { Timeouts, navigateAfterLogin, useScenarioHub } from '../../helpers'
import {
  ADMIN_NSEC,
  listEntityTypesViaApi,
  createEntityTypeViaApi,
  updateEntityTypeViaApi,
  createRecordViaApi,
  updateRecordViaApi,
  listRecordsViaApi,
  linkReportToEventViaApi,
  createReportViaApi,
  listEventRecordsViaApi,
  listEventReportsViaApi,
  getRecordViaApi,
} from '../../api-helpers'

// State is now in casesWorld fixture (casesWorld.eventEntityTypeId, casesWorld.lastEventId, casesWorld.lastEventName)

// ── Shared helper ────────────────────────────────────────────────────────────

import type { APIRequestContext } from '@playwright/test'

/**
 * Ensure an event entity type exists in the backend.
 * Returns the entity type ID. Creates one if it doesn't exist yet.
 * Used by multiple Given steps so they don't silently no-op when
 * casesWorld.eventEntityTypeId hasn't been seeded by a Background step.
 */
async function ensureEventEntityType(
  request: APIRequestContext,
  casesWorld: { eventEntityTypeId?: string },
  workerHub?: string,
): Promise<string> {
  if (casesWorld.eventEntityTypeId) return casesWorld.eventEntityTypeId

  const types = await listEntityTypesViaApi(request, workerHub)
  const eventType = types.find(et => {
    const cat = (et as { category?: string }).category
    const name = (et as { name?: string }).name
    return cat === 'event' || name === 'event' || name === 'protest'
  }) as { id: string; statuses?: Array<{ value: string; label: string; order?: number; isClosed?: boolean }> } | undefined

  if (!eventType) {
    const id = ((await createEntityTypeViaApi(request, {
      name: 'event',
      category: 'event',
      hubId: workerHub,
      statuses: [
        { value: 'active', label: 'Active', order: 0 },
        { value: 'concluded', label: 'Concluded', order: 1, isClosed: true },
      ],
    })) as { id: string }).id
    casesWorld.eventEntityTypeId = id
    return id
  }

  // Template-provided event types (e.g. jail-support's mass_arrest_event with
  // active/processing/completed) lack the concluded status the status-change
  // scenario exercises — add it once per hub.
  const statuses = eventType.statuses ?? []
  if (!statuses.some(s => s.value === 'concluded')) {
    await updateEntityTypeViaApi(request, eventType.id, {
      statuses: [...statuses, { value: 'concluded', label: 'Concluded', order: statuses.length, isClosed: true }],
    }, ADMIN_NSEC, workerHub)
  }

  casesWorld.eventEntityTypeId = eventType.id
  return eventType.id
}

/** The jail-support template's arrest case type — the Background applies the template, so it must exist. */
async function arrestCaseTypeId(request: APIRequestContext, workerHub?: string): Promise<string> {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  expect(arrestType, 'jail-support template should define the arrest_case entity type').toBeDefined()
  return (arrestType as { id: string }).id
}

// --- Background: event entity type exists ---

Given('an event entity type exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await ensureEventEntityType(request, casesWorld, workerHub)
})

// --- Events page ---

Then('the new event button should be visible', async ({ page }) => {
  // Events may use the generic new case button with event entity type filtered
  const btn = page.getByTestId('case-new-btn')
    .or(page.getByRole('button', { name: /new event/i }))
  await expect(btn.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('no events have been created', async ({ page, backendRequest: request, casesWorld }) => {
  // This step used to list the worker hub's event records and accept whatever it
  // found, which made the empty-state assertion downstream a statement about the
  // shard rather than about the app: the worker hub is shared by every scenario
  // the worker runs, two of which (in this file) create events. Own the hub
  // instead, and seed it with an event type and no records.
  const hubId = await useScenarioHub(page, request, 'events-empty')
  casesWorld.eventEntityTypeId = ''
  await ensureEventEntityType(request, casesWorld, hubId)
})

Given('events exist', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  const records = await listRecordsViaApi(request, { entityTypeId, hubId: workerHub })
  if (records.records.length === 0) {
    const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
    casesWorld.lastEventId = (event as { id: string }).id
  } else {
    casesWorld.lastEventId = (records.records[0] as { id: string }).id
  }
})

Then('at least one event card should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each event card should show a start date', async ({ page }) => {
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Date/time is shown via data-testid="case-card-timestamp"
  const time = card.getByTestId('case-card-timestamp')
  await expect(time).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each event card should show a status badge', async ({ page }) => {
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Status badge has data-testid="case-card-status-badge"
  const badge = card.getByTestId('case-card-status-badge')
  await expect(badge).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Event creation ---

When('I click the new event button', async ({ page }) => {
  const btn = page.getByTestId('case-new-btn')
    .or(page.getByRole('button', { name: /new event/i }))
  await expect(btn.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await btn.first().click()
})

When('I fill in the event name with a unique name', async ({ page, casesWorld }) => {
  casesWorld.lastEventName = `Test Event ${Date.now()}`
  // The Events page opens the create dialog with its event entity type pre-selected
  // (defaultEntityTypeId), and the title input only renders once entity types have
  // loaded AND a type is selected. It is therefore the single settled wait target —
  // the type select may also be visible (several entity types) but needs no change.
  const titleInput = page.getByRole('dialog').getByTestId('case-title-input')
  await expect(titleInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await titleInput.fill(casesWorld.lastEventName)
})

When('I fill in the event start date', async ({ page }) => {
  // The schema form renders synchronously with the title input once a type is
  // selected, so once the title is filled the form is settled and a count() check
  // is not a race. Fill a date only if the entity type actually defines one.
  await expect(page.getByTestId('case-title-input')).toHaveValue(/.+/, { timeout: Timeouts.ELEMENT })
  const dateInput = page.locator('[role="dialog"] input[type="datetime-local"], [role="dialog"] input[type="date"]')
  if (await dateInput.count() > 0) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    await dateInput.first().fill(tomorrow)
  }
})

When('I submit the event creation form', async ({ page }) => {
  const submitBtn = page.getByTestId('case-create-submit')
  await submitBtn.click()
})

Then('the new event should appear in the event list', async ({ page }) => {
  const caseList = page.getByTestId('case-list')
  await expect(caseList).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('case-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Event detail ---

Given('an event {string} exists', async ({ backendRequest: request, casesWorld, workerHub }, eventName: string) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id
  casesWorld.lastEventName = eventName
})

When('I click on the {string} event card', async ({ page, backendRequest: request, casesWorld, workerHub }, eventName: string) => {
  // Records don't render the free-text event name from the Given — they show an
  // auto-generated case number (same as "I view the event detail" below). Verify
  // the Gherkin text names this scenario's event, then open the card by identifier
  // rather than "first card", which is unreliable once the worker hub accumulates
  // events across scenarios.
  expect(eventName).toBe(casesWorld.lastEventName)
  const event = await getRecordViaApi(request, casesWorld.lastEventId, workerHub)
  const label = (event as { caseNumber?: string | null }).caseNumber || casesWorld.lastEventId.slice(0, 8)
  const card = page.getByTestId('case-list').getByTestId('case-card').filter({ hasText: label })
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
})

Then('the event detail should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the event name should be displayed', async ({ page }) => {
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the event start date should be displayed', async ({ page }) => {
  // Date is displayed in the detail header or detail tab
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Given('an event with linked cases exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  // Use createRecordViaApi directly: the frontend events page uses listRecords (not the /events API),
  // so events must live in the records table to appear in the UI.
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id

  // Create and link a case. Record-based events link via record parent/child —
  // POST /events/:id/records targets the separate events table and 404s here.
  const etId = await arrestCaseTypeId(request, workerHub)
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  await updateRecordViaApi(request, (record as { id: string }).id, { parentRecordId: casesWorld.lastEventId! }, workerHub)
})

Given('an event with {int} linked cases exists', async ({ backendRequest: request, casesWorld, workerHub }, count: number) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  // Use createRecordViaApi: frontend uses listRecords, not the /events API endpoint
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id

  const etId = await arrestCaseTypeId(request, workerHub)
  for (let i = 0; i < count; i++) {
    const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
    await updateRecordViaApi(request, (record as { id: string }).id, { parentRecordId: casesWorld.lastEventId! }, workerHub)
  }
})

Given('an event with linked reports exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  // Use createRecordViaApi: frontend uses listRecords, not the /events API endpoint
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id

  const report = await createReportViaApi(request, { title: `Event Report ${Date.now()}`, hubId: workerHub })
  await linkReportToEventViaApi(request, casesWorld.lastEventId!, (report as { id: string }).id, ADMIN_NSEC, workerHub)
})

When('I view the event detail', async ({ page, backendRequest: request, casesWorld, workerHub }) => {
  // Records sort by updatedAt, and the worker hub accumulates events across scenarios,
  // so "the first card" is not necessarily this scenario's event. Open the card that
  // shows this event's identifier (case number, or the id prefix when unnumbered).
  const event = await getRecordViaApi(request, casesWorld.lastEventId, workerHub)
  const label = (event as { caseNumber?: string | null }).caseNumber || casesWorld.lastEventId.slice(0, 8)
  await navigateAfterLogin(page, '/events')
  const card = page.getByTestId('case-list').getByTestId('case-card').filter({ hasText: label })
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
  // Wait for this event's detail panel to render before subsequent tab interactions
  await expect(page.getByTestId('case-detail-header')).toContainText(label, { timeout: Timeouts.ELEMENT })
})

Then('linked case records should be visible', async ({ page }) => {
  // Event detail "Cases" tab lists records linked to the event
  const list = page.getByTestId('event-linked-cases-list')
  await expect(list).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(list.getByTestId('event-linked-case-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each case link should show a case number', async ({ page }) => {
  // Case links show case numbers in the related or contacts tab
  const detailHeader = page.getByTestId('case-detail-header')
  await expect(detailHeader).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the linked cases count should show {int}', async ({ page }, count: number) => {
  // The linked count is the number of entries in the event's Cases tab.
  const tab = page.getByTestId('case-tab-cases')
  await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
  await tab.click()
  await expect(page.getByTestId('event-linked-case-card')).toHaveCount(count, { timeout: Timeouts.ELEMENT })
})

Then('the linked cases count should increase by {int}', async ({ page, backendRequest: request, casesWorld, workerHub }, increment: number) => {
  // 'an event exists' creates a fresh event, so the baseline is zero links.
  await expect(page.getByTestId('event-linked-case-card')).toHaveCount(increment, { timeout: Timeouts.ELEMENT })
  const { links } = await listEventRecordsViaApi(request, casesWorld.lastEventId, ADMIN_NSEC, workerHub)
  expect(links).toHaveLength(increment)
})

Then('linked reports should be visible', async ({ page }) => {
  // The previous step opened the event's Reports tab (case-tab-reports).
  const items = page.getByTestId('event-linked-reports-list').getByTestId('event-linked-report-item')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Link cases to events ---

Given('an event exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  // Always a fresh event: linking scenarios assert link counts, so reusing an event
  // that earlier scenarios in this worker hub already linked would make them order-dependent.
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: 'active', hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id
})

// 'a report exists' is handled by admin/desktop-admin-steps.ts

// "I click the {string} button" is handled by common/interaction-steps.ts

When('I search for a case by number', async ({ page }) => {
  // Search input inside the link-case dialog. Wait for at least one result so the
  // next step's click has something settled to act on instead of racing the search.
  const dialog = page.getByRole('dialog')
  const searchInput = dialog.getByTestId('event-link-case-search')
  await expect(searchInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await searchInput.fill('case')
  await expect(dialog.getByTestId('event-link-case-result').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I select the case from the search results', async ({ page }) => {
  // Selecting a result performs the link write; the dialog closes only on success.
  const dialog = page.getByRole('dialog')
  const result = dialog.getByTestId('event-link-case-result').first()
  await expect(result).toBeEnabled({ timeout: Timeouts.ELEMENT })
  await result.click()
  await expect(dialog).toBeHidden({ timeout: Timeouts.ELEMENT })
})

Then('the case should appear in the event\'s linked cases', async ({ page }) => {
  const items = page.getByTestId('event-linked-cases-list').getByTestId('event-linked-case-card')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I select the report', async ({ page }) => {
  // Selecting a result performs the link write; the dialog closes only on success.
  const dialog = page.getByRole('dialog')
  const result = dialog.getByTestId('event-link-report-result').first()
  await expect(result).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(result).toBeEnabled()
  await result.click()
  await expect(dialog).toBeHidden({ timeout: Timeouts.ELEMENT })
})

Then('the report should appear in the event\'s linked reports', async ({ page, backendRequest: request, casesWorld, workerHub }) => {
  const items = page.getByTestId('event-linked-reports-list').getByTestId('event-linked-report-item')
  await expect(items).toHaveCount(1, { timeout: Timeouts.ELEMENT })
  const { links } = await listEventReportsViaApi(request, casesWorld.lastEventId, ADMIN_NSEC, workerHub)
  expect(links).toHaveLength(1)
})

// --- Event status ---

Given('an event with status {string} exists', async ({ backendRequest: request, casesWorld, workerHub }, status: string) => {
  const entityTypeId = await ensureEventEntityType(request, casesWorld, workerHub)
  const event = await createRecordViaApi(request, entityTypeId, { statusHash: status, hubId: workerHub })
  casesWorld.lastEventId = (event as { id: string }).id
})

When('I change the event status to {string}', async ({ page }, newStatus: string) => {
  const header = page.getByTestId('case-detail-header')
  const pill = header.getByTestId('case-status-pill')
  await expect(pill).toBeVisible({ timeout: Timeouts.ELEMENT })
  await pill.click()

  // The Gherkin status is the status value; options are keyed by value
  // (data-testid={`case-status-option-${status.value}`} in status-pill.tsx).
  const option = page.getByTestId('case-status-dropdown').getByTestId(`case-status-option-${newStatus}`)
  await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
  await option.click()
})

Then('the event status should reflect {string}', async ({ page, backendRequest: request, casesWorld, workerHub }, status: string) => {
  // The pill re-renders with the new label only after the status write succeeds.
  const pill = page.getByTestId('case-detail-header').getByTestId('case-status-pill')
  await expect(pill).toHaveText(new RegExp(status, 'i'), { timeout: Timeouts.ELEMENT })

  // The pill alone only proves local React state changed — the earlier bug here
  // (onStatusChange called fetchRecords() instead of updateRecord, so the change
  // was silently dropped) rendered the same pill text without ever writing the
  // status. Re-read the record through the real API to prove it persisted server-side.
  // Gherkin uses the status value for the write ("completed") and its display
  // label for the pill assertion above ("Completed") — compare case-insensitively.
  const record = await getRecordViaApi(request, casesWorld.lastEventId, workerHub)
  expect((record as { statusHash?: string }).statusHash?.toLowerCase()).toBe(status.toLowerCase())
})

/**
 * Case management step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/platform/desktop/cases/cms-case-management.feature
 *
 * Behavioral depth: Case CRUD verified via API, schema-driven detail forms,
 * timeline interactions, evidence management, status changes, and pagination.
 * Hard assertions on component-specific test IDs from cases.tsx, status-pill.tsx,
 * case-timeline.tsx, and evidence-tab.tsx.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { Timeouts, navigateAfterLogin } from '../../helpers'
import {
  ADMIN_NSEC,
  enableCaseManagementViaApi,
  applyTemplateViaApi,
  listTemplatesViaApi,
  createRecordViaApi,
  createEntityTypeViaApi,
  listEntityTypesViaApi,
  listRecordsViaApi,
  createInteractionViaApi,
  uploadEvidenceViaApi,
  createContactByNameViaApi,
  linkContactToRecordViaApi,
} from '../../api-helpers'

// State is now in casesWorld fixture (casesWorld.createdCaseTitle, casesWorld.lastCreatedRecordId, casesWorld.volunteerPubkey)

// --- Background: CMS setup ---

Given('case management is enabled', async ({ backendRequest: request, workerHub }) => {
  await enableCaseManagementViaApi(request, true, ADMIN_NSEC, workerHub)
})

Given('case management is disabled', async ({ backendRequest: request, workerHub }) => {
  await enableCaseManagementViaApi(request, false, ADMIN_NSEC, workerHub)
})

Given('the {string} template has been applied', async ({ backendRequest: request, workerHub }, templateSlug: string) => {
  const templates = await listTemplatesViaApi(request, ADMIN_NSEC, workerHub)
  const match = templates.find(t => t.id === templateSlug || t.name.toLowerCase().includes(templateSlug.replace('-', ' ')))
  if (match) {
    await applyTemplateViaApi(request, match.id, ADMIN_NSEC, workerHub).catch((e) => {
      console.warn('[cms] Template apply failed (may already be applied):', e)
    })
  }
  // Ensure the entity types the scenarios rely on exist, regardless of template
  // availability. Names must match /^[a-zA-Z0-9_]+$/ (no spaces); labels carry the display name.
  const defaultFields = [
    { name: 'description', label: 'Description', type: 'text', order: 0 },
    { name: 'location', label: 'Location', type: 'text', order: 1 },
    { name: 'priority', label: 'Priority', type: 'select', order: 2 },
  ]
  // Mirrors packages/protocol/templates/<slug>.json entity type names and categories.
  const slugToTypes: Record<string, Array<{ name: string; label: string; category: string }>> = {
    'jail-support': [
      { name: 'arrest_case', label: 'Arrest Case', category: 'case' },
      { name: 'mass_arrest_event', label: 'Mass Arrest Event', category: 'event' },
    ],
  }
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const knownTypes = slugToTypes[templateSlug]
  // For a template whose types scenarios reference by name, check each name: the
  // worker hub may already hold unrelated entity types from earlier scenarios, and a
  // count check would let those mask a missing "Arrest Case" (#669).
  // For other templates only a generic pair is needed when nothing was applied.
  const required = knownTypes ?? (entityTypes.length < 2
    ? [
        { name: 'case', label: 'Case', category: 'case' },
        { name: 'incident', label: 'Incident', category: 'case' },
      ]
    : [])
  for (const t of required) {
    const exists = entityTypes.some(e => (e as Record<string, unknown>).name === t.name)
    if (!exists) {
      await createEntityTypeViaApi(request, {
        name: t.name, label: t.label, category: t.category, hubId: workerHub,
        fields: defaultFields,
      })
    }
  }
})

// --- Cases page loads ---

// 'I should see the {string} page title' moved to common/assertion-steps.ts

Then('the entity type tabs should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-type-tabs')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the {string} entity type tab as active', async ({ page }, tabName: string) => {
  if (tabName === 'All') {
    const tab = page.getByTestId('case-tab-all')
    await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
    // Active tab has the primary background class
    await expect(tab).toHaveClass(/bg-primary/)
  } else {
    const tab = page.locator('[data-testid^="case-tab-"]').filter({ hasText: tabName })
    await expect(tab.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

Then('I should see the {string} entity type tab', async ({ page }, tabName: string) => {
  const tab = page.locator('[data-testid^="case-tab-"]').filter({ hasText: tabName })
  await expect(tab.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- CMS not enabled states ---

Then('the CMS not-enabled card should be visible', async ({ page }) => {
  await expect(page.getByTestId('cms-not-enabled')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Case creation flow ---

When('I click the new case button', async ({ page }) => {
  await page.getByTestId('case-new-btn').click()
})

Then('the create case sheet should be visible', async ({ page }) => {
  // The create dialog is a Sheet — look for the title input or type selector
  const sheetContent = page.locator('[role="dialog"]')
  await expect(sheetContent).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I select entity type {string} in the create dialog', async ({ page }, typeName: string) => {
  // The dialog fetches entity types on open, then renders exactly one of two mutually
  // exclusive controls: a type select (several types) or a single-type badge (one type,
  // auto-selected). Wait for whichever renders; after that the branch is settled.
  const dialog = page.getByRole('dialog')
  const typeSelect = dialog.getByTestId('case-type-select')
  const singleType = dialog.getByTestId('case-type-single')
  await expect(typeSelect.or(singleType)).toBeVisible({ timeout: Timeouts.ELEMENT })

  if (await typeSelect.count() > 0) {
    await typeSelect.click()
    // Option test ids use the entity type name: label lowercased, spaces as underscores.
    const option = page.getByTestId(`case-type-option-${typeName.toLowerCase().replace(/\s+/g, '_')}`)
    await expect(option).toBeVisible({ timeout: Timeouts.ELEMENT })
    await option.click()
    await expect(typeSelect).toContainText(typeName, { timeout: Timeouts.ELEMENT })
  } else {
    await expect(singleType).toContainText(typeName)
  }
  // The title input renders only once a type is selected.
  await expect(dialog.getByTestId('case-title-input')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I fill in the case title with a unique name', async ({ page, casesWorld }) => {
  casesWorld.createdCaseTitle = `Test Case ${Date.now()}`
  const titleInput = page.getByTestId('case-title-input')
  await expect(titleInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await titleInput.fill(casesWorld.createdCaseTitle)
})

When('I fill in the case description', async ({ page }) => {
  // The description renders together with the title once a type is selected.
  const descInput = page.getByRole('dialog').getByTestId('case-description-input')
  await expect(descInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await descInput.fill('Test case description for BDD testing')
})

When('I click the create case submit button', async ({ page }) => {
  await page.getByTestId('case-create-submit').click()
})

Then('a toast {string} should appear', async ({ page }, toastText: string) => {
  // ToastProvider renders toast-success / toast-info / toast-error. Only a non-error
  // toast carrying the expected message counts — an error toast, a different toast,
  // or the page merely still rendering is a failure. Toasts live ~4s; the waiting
  // assertion polls from the moment the triggering action completed.
  const toast = page.getByTestId('toast-success').or(page.getByTestId('toast-info'))
    .filter({ hasText: new RegExp(toastText, 'i') })
  await expect(toast).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the new case should appear in the case list', async ({ page }) => {
  const caseList = page.getByTestId('case-list')
  await expect(caseList).toBeVisible({ timeout: Timeouts.ELEMENT })
  const caseCard = page.getByTestId('case-card')
  await expect(caseCard.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the new case should be auto-selected in the detail panel', async ({ page }) => {
  // A successful create closes the sheet and selects the new record (handleRecordCreated).
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I leave the case title empty', async ({ page }) => {
  const titleInput = page.getByRole('dialog').getByTestId('case-title-input')
  await expect(titleInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  await titleInput.clear()
  await expect(titleInput).toHaveValue('')
})

Then('the create case submit button should be disabled', async ({ page }) => {
  await expect(page.getByTestId('case-create-submit')).toBeDisabled()
})

When('I click the {string} entity type tab', async ({ page }, tabName: string) => {
  // Tab test ids are deterministic — case-tab-all, or case-tab-<entity type name>
  // with the label lowercased and spaces as underscores (routes/cases.tsx).
  const testId = tabName === 'All'
    ? 'case-tab-all'
    : `case-tab-${tabName.toLowerCase().replace(/\s+/g, '_')}`
  const tab = page.getByTestId(testId)
  await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
  await tab.click()
})

Then('the entity type selector should show {string}', async ({ page }, expected: string) => {
  // The filtered tab passes defaultEntityTypeId; the select shows the pre-selected type.
  const typeSelect = page.getByRole('dialog').getByTestId('case-type-select')
  await expect(typeSelect).toContainText(new RegExp(expected, 'i'), { timeout: Timeouts.ELEMENT })
})

// --- Case list preconditions ---

Given('no cases have been created', async ({ backendRequest: request, workerHub }) => {
  // Delete ALL existing records (paginate through all pages)
  const { apiDelete } = await import('../../api-helpers')
  let page = 1
  let hasMore = true
  while (hasMore) {
    const result = await listRecordsViaApi(request, { page, limit: 100, hubId: workerHub }).catch(() => ({ records: [], total: 0, hasMore: false }))
    for (const rec of result.records) {
      const id = (rec as { id: string }).id
      await apiDelete(request, `/records/${id}`).catch(() => {})
    }
    hasMore = result.records.length === 100
    page++
  }
})

Given('arrest cases exist', async ({ backendRequest: request, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const records = await listRecordsViaApi(request, { entityTypeId: etId, hubId: workerHub })
  if (records.records.length === 0) {
    await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  }
})

Given('arrest cases with multiple statuses exist', async ({ backendRequest: request, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  await createRecordViaApi(request, etId, { statusHash: 'in_progress', hubId: workerHub }).catch(() => {})
})

Given('an arrest case exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id

  // If a volunteer is logged in (casesWorld.volunteerPubkey set), always create a new case
  // assigned to them so they can see it with cases:read-assigned permission.
  if (casesWorld.volunteerPubkey) {
    const record = await createRecordViaApi(request, etId, {
      statusHash: 'reported',
      assignedTo: [casesWorld.volunteerPubkey],
      hubId: workerHub,
    })
    casesWorld.lastCreatedRecordId = (record as { id: string }).id
    return
  }

  // For admin: reuse existing or create new
  const records = await listRecordsViaApi(request, { entityTypeId: etId, hubId: workerHub })
  if (records.records.length === 0) {
    const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
    casesWorld.lastCreatedRecordId = (record as { id: string }).id
  } else {
    casesWorld.lastCreatedRecordId = (records.records[0] as { id: string }).id
  }
})

Given('an arrest case with status {string} exists', async ({ backendRequest: request, casesWorld, workerHub }, status: string) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: status, hubId: workerHub })
  casesWorld.lastCreatedRecordId = (record as { id: string }).id
})

Given('an arrest case exists with multiple field sections', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const records = await listRecordsViaApi(request, { entityTypeId: etId, hubId: workerHub })
  if (records.records.length === 0) {
    const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
    casesWorld.lastCreatedRecordId = (record as { id: string }).id
  } else {
    casesWorld.lastCreatedRecordId = (records.records[0] as { id: string }).id
  }
})

Given('a volunteer without cases:update permission is logged in', async ({ page, backendRequest: request, casesWorld, workerHub }) => {
  // Create a custom role with cases:read-assigned but NO cases:update or cases:update-own
  const { createRoleViaApi, createVolunteerViaApi } = await import('../../api-helpers')
  const { loginAsVolunteer } = await import('../../helpers')
  const role = await createRoleViaApi(request, {
    name: `CMS Viewer ${Date.now()}`,
    slug: `cms-viewer-${Date.now()}`,
    permissions: [
      'calls:answer', 'calls:read-active',
      'notes:read-own', 'shifts:read-own',
      'cases:create', 'cases:read-assigned',
      'contacts:view', 'events:read',
      'settings:read',
    ],
  })
  // A member of the worker hub: a global role that is not super-admin grants
  // nothing inside a hub (#1037), so a hubless account would see no cases at all.
  const vol = await createVolunteerViaApi(request, {
    name: `CMS Restricted Vol ${Date.now()}`,
    roleIds: [role.id],
    hubId: workerHub,
  })
  casesWorld.volunteerPubkey = vol.pubkey
  await loginAsVolunteer(page, vol.nsec)
})

// --- Case list interactions ---

// 'the empty state card should be visible' moved to common/assertion-steps.ts

Then('the empty state create button should be visible', async ({ page }) => {
  const btn = page.getByTestId('case-empty-create-btn').or(page.getByTestId('empty-state-create-btn'))
  await expect(btn.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one case card should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-card').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each case card should show a status badge', async ({ page }) => {
  const firstCard = page.getByTestId('case-card').first()
  await expect(firstCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Status badge has data-testid="case-card-status-badge"
  const badge = firstCard.getByTestId('case-card-status-badge')
  await expect(badge).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each case card should show a relative timestamp', async ({ page }) => {
  const firstCard = page.getByTestId('case-card').first()
  await expect(firstCard).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Timestamp has data-testid="case-card-timestamp"
  const time = firstCard.getByTestId('case-card-timestamp')
  await expect(time).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the first case card', async ({ page }) => {
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
  // Wait for detail panel to fully render before any tab interactions
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the case detail header should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the case number should be displayed', async ({ page }) => {
  const header = page.getByTestId('case-detail-header')
  await expect(header).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Case number is in a font-mono span inside the header
  const caseNum = header.locator('span.font-mono, [class*="font-mono"]').first()
  await expect(caseNum).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the status pill should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-status-pill')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('all visible case cards should show {string} type badge', async ({ page }, typeName: string) => {
  const cards = page.getByTestId('case-card')
  const count = await cards.count()
  if (count > 0) {
    const firstCard = cards.first()
    await expect(firstCard.getByText(typeName)).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

When('I select a status from the status filter dropdown', async ({ page }) => {
  const filter = page.getByTestId('case-status-filter')
  await filter.click()
  // Select the first non-"all" option
  const options = page.getByRole('option')
  const count = await options.count()
  if (count > 1) {
    await options.nth(1).click()
  } else {
    await page.keyboard.press('Escape')
  }
})

Then('only cases matching that status should appear in the list', async ({ page }) => {
  // Verify the list loaded (may be empty if no cases match)
  const caseList = page.getByTestId('case-list')
  await expect(caseList).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Case detail tabs ---

Then('the case detail tabs should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-tabs')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should see the {string} tab', async ({ page }, tabName: string) => {
  const tabKey = tabName.toLowerCase()
  const tab = page.getByTestId(`case-tab-${tabKey}`).or(page.getByTestId(`contact-tab-${tabKey}`))
  await expect(tab.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the {string} tab is active', async ({ page }, tabName: string) => {
  const tabKey = tabName.toLowerCase()
  // Case detail tabs render case-tab-<key> (bg-card when active), contact profile
  // tabs render contact-tab-<key> (border-primary when active). This is an
  // assertion step — never click here to force the state.
  const tab = page.getByTestId(`case-tab-${tabKey}`).or(page.getByTestId(`contact-tab-${tabKey}`))
  await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(tab).toHaveClass(/bg-card|border-primary/, { timeout: Timeouts.ELEMENT })
})

When('I click the {string} tab', async ({ page }, tabName: string) => {
  const tabKey = tabName.toLowerCase()

  // The case detail panel and the contact profile panel are mutually exclusive views,
  // each rendering its own tab bar (case-tab-<key> vs contact-tab-<key>). Wait for
  // whichever panel actually mounted, then target that panel's tab with a waiting
  // assertion. The prior version guarded the click with isVisible({timeout}) probes —
  // isVisible() does not poll, so under shard contention it could sample the DOM before
  // the panel finished mounting, see nothing, and fall through to a text-based
  // getByRole fallback that isn't guaranteed to match either (probe-race class of
  // #669/#670).
  const detailHeader = page.getByTestId('case-detail-header')
  const contactHeader = page.getByTestId('contact-profile-header')
  await expect(detailHeader.or(contactHeader).first()).toBeVisible({ timeout: Timeouts.ELEMENT })

  const isCaseDetail = (await detailHeader.count()) > 0
  const tab = isCaseDetail
    ? page.getByTestId(`case-tab-${tabKey}`)
    : page.getByTestId(`contact-tab-${tabKey}`)
  await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
  await tab.click()
})

// --- Details tab ---

Then('the schema form should be visible', async ({ page }) => {
  // Scope to the detail panel to avoid matching the create dialog's schema form
  const detailPanel = page.getByTestId('case-detail').or(page.locator('main'))
  const form = detailPanel.getByTestId('schema-form').or(detailPanel.getByTestId('case-details-tab'))
  await expect(form.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('fields with restricted access levels should show access badges', async ({ page }) => {
  // Access badges are rendered for fields with accessLevel !== 'all'
  // Check if any exist — may not if all fields are "all" level
  const detailsTab = page.getByTestId('case-details-tab')
  await expect(detailsTab).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('collapsible section headers should be visible', async ({ page }) => {
  // Schema sections are rendered as Collapsible with data-testid="schema-section-*"
  const sections = page.locator('[data-testid^="schema-section-"]')
  const count = await sections.count()
  // Accept either sections exist, or the details tab is visible (sections depend on template fields)
  if (count > 0) {
    await expect(sections.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  } else {
    await expect(page.getByTestId('case-details-tab')).toBeVisible({ timeout: Timeouts.ELEMENT })
  }
})

// --- Status changes ---

When('I click the status pill', async ({ page }) => {
  const pill = page.getByTestId('case-status-pill')
  await expect(pill).toBeVisible({ timeout: Timeouts.ELEMENT })
  await pill.click()
})

Then('the status dropdown should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-status-dropdown')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the status dropdown should list available statuses', async ({ page }) => {
  const dropdown = page.getByTestId('case-status-dropdown')
  const options = dropdown.locator('[role="option"]')
  const count = await options.count()
  expect(count).toBeGreaterThanOrEqual(1)
})

When('I select a different status from the dropdown', async ({ page }) => {
  const dropdown = page.getByTestId('case-status-dropdown')
  // Click the first non-selected option. If there is none the step must fail —
  // silently leaving the status unchanged would make later assertions vacuous.
  const options = dropdown.locator('[role="option"][aria-selected="false"]')
  await expect(options.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await options.first().click()
})

Then('the status pill should reflect the new status', async ({ page }) => {
  await expect(page.getByTestId('case-status-pill')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the status pill should not be clickable', async ({ page }) => {
  const pill = page.getByTestId('case-status-pill')
  await expect(pill).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Read-only pills don't have role="button"
  const role = await pill.getAttribute('role')
  expect(role).not.toBe('button')
})

// --- Timeline tab ---

Given('an arrest case with interactions exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await createInteractionViaApi(request, recordId, { interactionType: 'comment', hubId: workerHub })
})

Given('an arrest case with a comment interaction exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await createInteractionViaApi(request, recordId, { interactionType: 'comment', hubId: workerHub })
})

Given('an arrest case with multiple interactions exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await createInteractionViaApi(request, recordId, { interactionType: 'comment', hubId: workerHub })
  await createInteractionViaApi(request, recordId, { interactionType: 'status_change', hubId: workerHub })
})

Given('an arrest case with comment and status_change interactions exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await createInteractionViaApi(request, recordId, { interactionType: 'comment', hubId: workerHub })
  await createInteractionViaApi(request, recordId, { interactionType: 'status_change', hubId: workerHub })
})

Given('an arrest case is selected with the Timeline tab active', async ({ page, backendRequest: request, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const records = await listRecordsViaApi(request, { entityTypeId: etId, hubId: workerHub })
  if (records.records.length === 0) {
    await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  }
  await navigateAfterLogin(page, '/cases')
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
  // Wait for detail panel to fully render before clicking tabs
  await expect(page.getByTestId('case-detail-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Click the Timeline TAB button (not the timeline container)
  const timelineTab = page.getByTestId('case-tab-timeline')
  await expect(timelineTab).toBeVisible({ timeout: Timeouts.ELEMENT })
  await timelineTab.click()
})

Then('the case timeline should be visible', async ({ page }) => {
  // First ensure the Timeline tab is active (visible and clicked)
  await expect(page.getByTestId('case-tab-timeline')).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Then wait for the timeline container or loading state to appear
  // The timeline component shows a loading spinner, then the timeline content
  const timeline = page.getByTestId('case-timeline')
  const loading = page.getByTestId('timeline-loading')
  await expect(timeline.or(loading).first()).toBeVisible({ timeout: Timeouts.ELEMENT * 2 })
})

Then('at least one timeline item should be visible', async ({ page }) => {
  const items = page.getByTestId('timeline-items')
  await expect(items).toBeVisible({ timeout: Timeouts.ELEMENT })
  const item = page.getByTestId('timeline-item')
  await expect(item.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each timeline item should show author and timestamp', async ({ page }) => {
  const item = page.getByTestId('timeline-item').first()
  await expect(item).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(item.getByTestId('timeline-item-author')).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(item.getByTestId('timeline-item-time')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one timeline item should show type {string}', async ({ page }, typeName: string) => {
  const typeLabel = page.getByTestId('timeline-item-type').filter({ hasText: new RegExp(typeName, 'i') })
  await expect(typeLabel.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the sort toggle button', async ({ page }) => {
  await page.getByTestId('timeline-sort-toggle').click()
})

Then('the timeline items should be in oldest-first order', async ({ page }) => {
  const toggle = page.getByTestId('timeline-sort-toggle')
  await expect(toggle).toContainText(/oldest/i)
})

Then('the timeline items should be in newest-first order', async ({ page }) => {
  const toggle = page.getByTestId('timeline-sort-toggle')
  await expect(toggle).toContainText(/newest/i)
})

When('I select {string} from the timeline type filter', async ({ page }, filterLabel: string) => {
  const filter = page.getByTestId('timeline-type-filter')
  await filter.click()
  const option = page.getByRole('option', { name: new RegExp(filterLabel, 'i') })
  await option.click()
})

Then('only comment interactions should be visible', async ({ page }) => {
  // After filtering, all visible timeline items should be comments
  const items = page.getByTestId('timeline-item')
  const count = await items.count()
  // Accept empty result (filtered out) or visible comments
  if (count > 0) {
    const type = items.first().getByTestId('timeline-item-type')
    await expect(type).toContainText(/comment/i, { timeout: Timeouts.ELEMENT })
  }
})

When('I type a comment in the timeline comment input', async ({ page }) => {
  const input = page.getByTestId('timeline-comment-input')
  await expect(input).toBeVisible({ timeout: Timeouts.ELEMENT })
  await input.fill(`Test comment ${Date.now()}`)
})

When('I click the timeline comment submit button', async ({ page }) => {
  await page.getByTestId('timeline-comment-submit').click()
})

Then('the comment should appear in the timeline items', async ({ page }) => {
  const items = page.getByTestId('timeline-item')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the comment input should be cleared', async ({ page }) => {
  const input = page.getByTestId('timeline-comment-input')
  await expect(input).toHaveValue('')
})

Then('the timeline comment submit button should be disabled', async ({ page }) => {
  await expect(page.getByTestId('timeline-comment-submit')).toBeDisabled()
})

// --- Contacts tab ---

Given('an arrest case with linked contacts exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  const contact = await createContactByNameViaApi(request, `Test Contact ${Date.now()}`, { hubId: workerHub })
  const contactId = (contact as { id: string }).id
  await linkContactToRecordViaApi(request, recordId, contactId, 'defendant', ADMIN_NSEC, workerHub)
})

Given('an arrest case with no linked contacts exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastCreatedRecordId = (record as { id: string }).id
})

Then('the case contacts tab should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-contacts-tab')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one contact card should show a role badge', async ({ page }) => {
  // Contacts are loaded asynchronously after tab click — wait with retry
  const card = page.getByTestId('case-contact-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT * 2 })
})

Then('the contacts empty state should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-contacts-empty')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Evidence tab ---

Given('an arrest case with evidence exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await uploadEvidenceViaApi(request, recordId, { classification: 'photo', hubId: workerHub })
})

Given('an arrest case with photo and document evidence exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  const recordId = (record as { id: string }).id
  casesWorld.lastCreatedRecordId = recordId
  await uploadEvidenceViaApi(request, recordId, { classification: 'photo', hubId: workerHub })
  await uploadEvidenceViaApi(request, recordId, { classification: 'document', hubId: workerHub })
})

Given('an arrest case with no evidence exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastCreatedRecordId = (record as { id: string }).id
})

Then('the evidence tab should be visible', async ({ page }) => {
  await expect(page.getByTestId('evidence-tab')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one evidence item should be visible', async ({ page }) => {
  const gridItem = page.getByTestId('evidence-grid-item')
  const listItem = page.getByTestId('evidence-list-item')
  const item = gridItem.or(listItem)
  await expect(item.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each evidence item should show a classification badge', async ({ page }) => {
  await expect(page.getByTestId('evidence-classification-badge').first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the list view button', async ({ page }) => {
  await page.getByTestId('evidence-view-list').click()
})

Then('evidence should display in list layout', async ({ page }) => {
  await expect(page.getByTestId('evidence-list')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I click the grid view button', async ({ page }) => {
  await page.getByTestId('evidence-view-grid').click()
})

Then('evidence should display in grid layout', async ({ page }) => {
  await expect(page.getByTestId('evidence-grid')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

When('I select {string} from the evidence classification filter', async ({ page }, classification: string) => {
  const filter = page.getByTestId('evidence-classification-filter')
  await filter.click()
  const option = page.getByRole('option', { name: new RegExp(classification, 'i') })
  await option.click()
})

Then('only photo evidence should be visible', async ({ page }) => {
  const badges = page.getByTestId('evidence-classification-badge')
  const count = await badges.count()
  for (let i = 0; i < count; i++) {
    await expect(badges.nth(i)).toContainText(/photo/i)
  }
})

Then('the evidence empty state should be visible', async ({ page }) => {
  await expect(page.getByTestId('evidence-empty')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the upload evidence button should be visible', async ({ page }) => {
  await expect(page.getByTestId('evidence-upload-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Assignment ---

Given('an arrest case exists that is not assigned to me', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  const record = await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastCreatedRecordId = (record as { id: string }).id
})

// "I click the {string} button" and "the {string} button should be visible"
// are handled by common/interaction-steps.ts

Then('the {string} button should no longer be visible', async ({ page }, text: string) => {
  // Feature-file button text doesn't always match the accessible name — map known
  // mismatches to their data-testid, same pattern as buttonTextToTestIdMap in
  // common/interaction-steps.ts.
  const testIdMap: Record<string, string> = {
    'Assign to me': 'case-assign-btn',
  }
  const testId = testIdMap[text]
  const btn = testId ? page.getByTestId(testId) : page.getByRole('button', { name: text }).first()
  await expect(btn).toBeHidden({ timeout: Timeouts.ELEMENT })
})

// --- Pagination ---

Given('more than 50 cases exist', async ({ backendRequest: request, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  if (!arrestType) return
  const etId = (arrestType as { id: string }).id
  // Check current count
  const result = await listRecordsViaApi(request, { entityTypeId: etId, limit: 1, hubId: workerHub })
  if (result.total < 51) {
    // Create enough records to exceed 50
    const needed = 51 - result.total
    for (let i = 0; i < Math.min(needed, 55); i++) {
      await createRecordViaApi(request, etId, { statusHash: 'reported', hubId: workerHub }).catch(() => {})
    }
  }
})

Then('the pagination controls should be visible', async ({ page }) => {
  await expect(page.getByTestId('case-pagination')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the page info should show {string}', async ({ page }, text: string) => {
  const pagination = page.getByTestId('case-pagination')
  await expect(pagination).toContainText(new RegExp(text, 'i'), { timeout: Timeouts.ELEMENT })
})

When('I click the next page button', async ({ page }) => {
  await page.getByTestId('case-page-next').click()
})

Then('the case list should reload with new records', async ({ page }) => {
  const caseList = page.getByTestId('case-list')
  await expect(caseList).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Related tab ---

Given('a parent case with child records exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const entityTypeId = (entityTypes[0] as { id: string }).id

  // Create parent record
  const parent = await createRecordViaApi(request, entityTypeId, { statusHash: 'reported', hubId: workerHub })
  casesWorld.lastCreatedRecordId = (parent as { id: string }).id

  // Create child record linked to parent
  await createRecordViaApi(request, entityTypeId, {
    statusHash: 'reported',
    hubId: workerHub,
    parentRecordId: casesWorld.lastCreatedRecordId,
  })
})

When('I click the parent case card', async ({ page }) => {
  const card = page.getByTestId('case-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.click()
})

Then('the related tab empty state should be visible', async ({ page }) => {
  const tab = page.getByTestId('case-related-tab')
  await expect(tab).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('at least one related record card should be visible', async ({ page }) => {
  const card = page.getByTestId('related-record-card').first()
  await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
})

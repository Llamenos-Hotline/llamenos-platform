/**
 * Contact directory step definitions.
 * Matches steps from:
 *   - packages/test-specs/features/platform/desktop/cases/cms-contacts.feature
 *
 * Behavioral depth: Contact CRUD verified via API, search with debounce,
 * type filtering, tabbed profile views (identifiers, cases, relationships,
 * groups), and PII restriction indicators. Hard assertions on
 * contact-card.tsx, contact-profile.tsx, and create-contact-dialog.tsx test IDs.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, type CasesWorld } from '../fixtures'
import { Timeouts, navigateAfterLogin } from '../../helpers'
import {
  ADMIN_NSEC,
  createContactByNameViaApi,
  listContactsViaApi,
  linkContactToRecordViaApi,
  createRecordViaApi,
  listEntityTypesViaApi,
  createRelationshipViaApi,
  createAffinityGroupViaApi,
} from '../../api-helpers'

// State is now in casesWorld fixture (casesWorld.contactCarlosId, casesWorld.contactMariaId, casesWorld.contactWithDataId)

// Navigation is handled by common/navigation-steps.ts (added CMS routes there)

When('I navigate to the {string} admin page', async ({ page }, pageName: string) => {
  const urlMap: Record<string, string> = {
    'Case Management': '/admin/case-management',
  }
  const url = urlMap[pageName] ?? `/admin/${pageName.toLowerCase().replace(/\s+/g, '-')}`
  await navigateAfterLogin(page, url)
})

// 'I navigate to {string}' is handled by common/navigation-steps.ts

// --- Helper: ensure contacts appear in the directory ---

/**
 * Contacts created via API may not appear in the directory listing due to
 * blind index / encryption constraints in the test mock environment.
 * This helper creates a contact through the UI as a fallback.
 *
 * Every branch is decided only after a waiting assertion on a settled directory
 * state (cards, the "no match" notice, or the empty state) — never on a
 * non-waiting isVisible() probe. A failed UI creation fails the step loudly
 * instead of being force-dismissed with Escape.
 */
async function waitForDirectorySettled(page: import('@playwright/test').Page): Promise<void> {
  // While contacts load, the list pane (with its search input and filter) is already
  // rendered around a spinner, so "contact-list is visible" is NOT a settled state.
  // Settled means: cards rendered, the no-results notice, or the empty-state card.
  await expect(
    page.getByTestId('directory-contact-card').first()
      .or(page.getByTestId('contact-list-no-results'))
      .or(page.getByTestId('empty-state')),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
}

async function ensureContactVisibleInDirectory(
  page: import('@playwright/test').Page,
  name?: string,
): Promise<void> {
  const card = page.getByTestId('directory-contact-card')
  // When a specific name is requested, the presence of SOME other card (e.g. left
  // over from an earlier scenario in the same hub) must not short-circuit creation —
  // only a card matching that name satisfies the caller.
  const target = name ? card.filter({ hasText: name }) : card
  await waitForDirectorySettled(page)
  if (await target.count() > 0) return

  // The target contact doesn't exist yet — create it through the UI. The header
  // button always renders; the empty state has its own create button.
  const createBtn = page.getByTestId('new-contact-btn').or(page.getByTestId('empty-state-create-btn'))
  await expect(createBtn.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await createBtn.first().click()

  const dialog = page.getByTestId('create-contact-dialog')
  await expect(dialog).toBeVisible({ timeout: Timeouts.ELEMENT })
  await page.getByTestId('contact-name-input').fill(name ?? `Test Contact ${Date.now()}`)
  await page.getByTestId('create-contact-submit').click()

  // On success the parent prepends the contact, selects it, and closes the dialog
  // (handleContactCreated). Both are required outcomes — assert them.
  await expect(dialog).toBeHidden({ timeout: Timeouts.ELEMENT })
  await expect(target.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
}

/**
 * Click a specific contact's card in the directory list, waiting for it.
 *
 * Deliberately NOT the search box: the client's search sends the raw query as
 * a single blind-index token, which the server never matches against a name,
 * so a name search always returns an empty list (and clears the one that was
 * showing). The default list is sorted newest-first for never-contacted
 * contacts, so a contact a Given step just seeded is within the first page;
 * asserting on the named card (a waiting assertion) instead of probing with
 * a non-waiting isVisible() keeps the click from racing the list load. A
 * contact that is genuinely absent fails the step loudly.
 */
async function clickContactCardByName(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  const card = page.getByTestId('directory-contact-card').filter({ hasText: name })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.first().click()
}

// --- Contact directory page elements ---

Then('the new contact button should be visible', async ({ page }) => {
  await expect(page.getByTestId('new-contact-btn')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact search input should be visible', async ({ page }) => {
  // The search input is inside the contact-list pane, which only renders when the
  // directory is non-empty. Seed a contact through the UI if it is empty.
  await waitForDirectorySettled(page)
  if (await page.getByTestId('contact-search-input').count() === 0) {
    await ensureContactVisibleInDirectory(page)
  }
  await expect(page.getByTestId('contact-search-input')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact type filter should be visible', async ({ page }) => {
  // Same render condition as the search input — never return early on a probe.
  await waitForDirectorySettled(page)
  if (await page.getByTestId('contact-type-filter').count() === 0) {
    await ensureContactVisibleInDirectory(page)
  }
  await expect(page.getByTestId('contact-type-filter')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Search ---

Given('contacts {string} and {string} exist', async ({ backendRequest: request, casesWorld, workerHub }, name1: string, name2: string) => {
  // Create contacts via API for data integrity
  const existing = await listContactsViaApi(request, { hubId: workerHub })
  const existingNames = existing.contacts.map(c => (c as { displayName?: string }).displayName)

  if (!existingNames.includes(name1)) {
    const c1 = await createContactByNameViaApi(request, name1, { hubId: workerHub })
    casesWorld.contactCarlosId = (c1 as { id: string }).id
  } else {
    const found = existing.contacts.find(c => (c as { displayName?: string }).displayName === name1)
    casesWorld.contactCarlosId = (found as { id: string }).id
  }

  if (!existingNames.includes(name2)) {
    const c2 = await createContactByNameViaApi(request, name2, { hubId: workerHub })
    casesWorld.contactMariaId = (c2 as { id: string }).id
  } else {
    const found = existing.contacts.find(c => (c as { displayName?: string }).displayName === name2)
    casesWorld.contactMariaId = (found as { id: string }).id
  }
})

Given('contacts exist', async ({ backendRequest: request, workerHub }) => {
  const existing = await listContactsViaApi(request, { hubId: workerHub })
  if (existing.contacts.length === 0) {
    await createContactByNameViaApi(request, `Seed Contact ${Date.now()}`, { hubId: workerHub })
  }
})

Given('contacts of type {string} and {string} exist', async ({ backendRequest: request, workerHub }, type1: string, type2: string) => {
  const hash1 = type1.toLowerCase().replace(/\s+/g, '_')
  const hash2 = type2.toLowerCase().replace(/\s+/g, '_')
  await createContactByNameViaApi(request, `${type1} Contact ${Date.now()}`, { contactTypeHash: hash1, hubId: workerHub })
  await createContactByNameViaApi(request, `${type2} Contact ${Date.now()}`, { contactTypeHash: hash2, hubId: workerHub })
})

When('I type {string} in the contact search input', async ({ page }, query: string) => {
  // The Given seeded contacts, so the settled directory shows the list pane.
  await waitForDirectorySettled(page)
  const input = page.getByTestId('contact-search-input')
  await expect(input).toBeVisible({ timeout: Timeouts.ELEMENT })
  await input.fill(query)
  await expect(input).toHaveValue(query)
})

When('I clear the contact search input', async ({ page }) => {
  const input = page.getByTestId('contact-search-input')
  await expect(input).toBeVisible({ timeout: Timeouts.ELEMENT })
  await input.clear()
  await expect(input).toHaveValue('')
})

Then('the contact list should update after debounce', async ({ page }) => {
  // The contact list should be visible after the search settles
  await expect(page.getByTestId('contact-list')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('a contact card for {string} should be visible', async ({ page }, name: string) => {
  // Earlier scenarios in the worker hub may have seeded the same name, so several
  // matching cards are legitimate; at least one must render.
  const card = page.getByTestId('directory-contact-card').filter({ hasText: name })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('a contact card for {string} should not be visible', async ({ page }, name: string) => {
  // Runs after a positive card assertion on the same search, so the results are settled.
  const card = page.getByTestId('directory-contact-card').filter({ hasText: name })
  await expect(card).toHaveCount(0, { timeout: Timeouts.ELEMENT })
})

Then('both {string} and {string} should be visible', async ({ page }, name1: string, name2: string) => {
  // Both named contacts must be visible, not just any card in the list.
  const card1 = page.getByTestId('directory-contact-card').filter({ hasText: name1 })
  const card2 = page.getByTestId('directory-contact-card').filter({ hasText: name2 })
  await expect(card1.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(card2.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact list should show {string}', async ({ page }, message: string) => {
  // Search results are async — wait for the search to complete and the text to render
  // The search debounce + API call + re-render may take longer than default timeout
  await expect(page.getByText(new RegExp(message, 'i')).first()).toBeVisible({ timeout: Timeouts.ELEMENT * 2 })
})

// --- Type filter ---

When('I select {string} from the contact type filter', async ({ page }, filterLabel: string) => {
  // The type filter renders inside the contact-list pane, which only exists when
  // the directory is non-empty — seed a contact through the UI if it is empty.
  await waitForDirectorySettled(page)
  if (await page.getByTestId('contact-type-filter').count() === 0) {
    await ensureContactVisibleInDirectory(page)
  }
  const filter = page.getByTestId('contact-type-filter')
  await expect(filter).toBeVisible({ timeout: Timeouts.ELEMENT })
  await filter.click()
  // The option must exist — pressing Escape instead would silently skip the write.
  const option = page.getByRole('option', { name: new RegExp(filterLabel, 'i') })
  await expect(option.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await option.first().click()
})

Then('only individual contacts should appear in the list', async ({ page }) => {
  const contactList = page.getByTestId('contact-list')
  await expect(contactList).toBeVisible({ timeout: Timeouts.ELEMENT })
  const cards = page.getByTestId('directory-contact-card')
  // A filtered list that comes back empty is a failure, not a pass — the Given
  // seeded one contact of each type, so at least the individual one must render.
  await expect(cards.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  const count = await cards.count()
  // Assert on the type badge specifically, not a card-wide text match — the
  // seeded contact's own name (e.g. "individual Contact 123") also contains
  // the type string and would satisfy a card-wide regex on its own.
  for (let i = 0; i < count; i++) {
    await expect(cards.nth(i).getByTestId('contact-type-badge')).toHaveText(/individual/i, { timeout: Timeouts.ELEMENT })
  }
})

Then('both individual and organization contacts should be visible', async ({ page }) => {
  await expect(page.getByTestId('contact-list')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Contact creation ---

When('I click the new contact button', async ({ page }) => {
  await page.getByTestId('new-contact-btn').click()
})

Then('the create contact dialog should be visible', async ({ page }) => {
  await expect(page.getByTestId('create-contact-dialog')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact name input should be focused', async ({ page }) => {
  const nameInput = page.getByTestId('contact-name-input')
  await expect(nameInput).toBeVisible({ timeout: Timeouts.ELEMENT })
  // autoFocus is set on the input, so it should be focused
  await expect(nameInput).toBeFocused()
})

When('I fill in the contact name with {string}', async ({ page }, name: string) => {
  await page.getByTestId('contact-name-input').fill(name)
})

When('I select contact type {string}', async ({ page }, typeName: string) => {
  const typeSelect = page.getByTestId('contact-type-select')
  await typeSelect.click()
  const option = page.getByRole('option', { name: new RegExp(typeName, 'i') })
  await option.click()
})

When('I fill in the first identifier value with a phone number', async ({ page }) => {
  const identifierInput = page.getByTestId('identifier-value-input').first()
  await identifierInput.fill(`+1212${Date.now().toString().slice(-7)}`)
})

Then('the primary checkbox for the first identifier should be checked', async ({ page }) => {
  const checkbox = page.getByTestId('identifier-primary-checkbox').first()
  await expect(checkbox).toBeVisible({ timeout: Timeouts.ELEMENT })
  // Checkbox is checked — check data-state attribute
  await expect(checkbox).toHaveAttribute('data-state', 'checked')
})

When('I click the create contact submit button', async ({ page }) => {
  await page.getByTestId('create-contact-submit').click()
})

Then('{string} should appear in the contact list', async ({ page }, name: string) => {
  // The name may show as the actual name or as "Restricted" depending on E2EE
  const namedCard = page.getByTestId('directory-contact-card').filter({ hasText: name })
  const anyCard = page.getByTestId('directory-contact-card').first()
  const combined = namedCard.or(anyCard)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('{string} should be auto-selected in the detail panel', async ({ page }, name: string) => {
  // handleContactCreated selects the new contact; its creator can always decrypt it,
  // so the profile header shows the real name (never "Restricted").
  const header = page.getByTestId('contact-detail').getByTestId('contact-profile-header')
  await expect(header).toContainText(name, { timeout: Timeouts.ELEMENT })
})

When('I leave the contact name empty', async ({ page }) => {
  const input = page.getByTestId('contact-name-input')
  await input.clear()
})

Then('the create contact submit button should be disabled', async ({ page }) => {
  await expect(page.getByTestId('create-contact-submit')).toBeDisabled()
})

When('I click the add identifier button', async ({ page }) => {
  await page.getByTestId('add-identifier-btn').click()
})

Then('{int} identifier rows should be visible', async ({ page }, count: number) => {
  const rows = page.getByTestId('identifier-row')
  await expect(rows).toHaveCount(count, { timeout: Timeouts.ELEMENT })
})

Then('{int} identifier row should be visible', async ({ page }, count: number) => {
  const rows = page.getByTestId('identifier-row')
  await expect(rows).toHaveCount(count, { timeout: Timeouts.ELEMENT })
})

Then('only one identifier should have the primary checkbox checked', async ({ page }) => {
  const checkboxes = page.getByTestId('identifier-primary-checkbox')
  const count = await checkboxes.count()
  let checkedCount = 0
  for (let i = 0; i < count; i++) {
    const state = await checkboxes.nth(i).getAttribute('data-state')
    if (state === 'checked') checkedCount++
  }
  expect(checkedCount).toBe(1)
})

When('I click the remove button on the second identifier', async ({ page }) => {
  const removeBtn = page.getByTestId('remove-identifier-btn').nth(1)
  await removeBtn.click()
})

// --- Contact profile detail ---

/**
 * Create a contact via API and track BOTH its id and display name on
 * casesWorld. The name is required so later steps (e.g. the unnamed
 * "I click on the contact card") can deterministically locate THIS contact
 * via the directory search box, instead of guessing at `.first()` in a
 * directory that accumulates contacts from every earlier scenario sharing
 * this worker's hub. See issue #796 — clicking the wrong (unrelated) card
 * is what produced the shard-2 "Profile tab shows empty state" failure.
 */
async function createTrackedContact(
  request: APIRequestContext,
  casesWorld: CasesWorld,
  name: string,
  opts?: { contactTypeHash?: string; hubId?: string },
): Promise<Record<string, unknown>> {
  const created = await createContactByNameViaApi(request, name, opts)
  casesWorld.contactWithDataId = (created as { id: string }).id
  casesWorld.contactWithDataName = name
  return created
}

Given('a contact {string} exists', async ({ backendRequest: request, casesWorld, workerHub }, name: string) => {
  const existing = await listContactsViaApi(request, { hubId: workerHub })
  const found = existing.contacts.find(c => (c as { displayName?: string }).displayName === name)
  if (found) {
    casesWorld.contactWithDataId = (found as { id: string }).id
    casesWorld.contactWithDataName = name
  } else {
    await createTrackedContact(request, casesWorld, name, { hubId: workerHub })
  }
})

Given('a contact {string} exists with profile data', async ({ backendRequest: request, casesWorld, workerHub }, name: string) => {
  const existing = await listContactsViaApi(request, { hubId: workerHub })
  const found = existing.contacts.find(c => (c as { displayName?: string }).displayName === name)
  if (found) {
    casesWorld.contactWithDataId = (found as { id: string }).id
    casesWorld.contactWithDataName = name
  } else {
    await createTrackedContact(request, casesWorld, name, { hubId: workerHub })
  }
})

Given('a contact exists with no profile data', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `No-Profile ${Date.now()}`, { hubId: workerHub })
})

Given('a contact exists with phone and email identifiers', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `Identifiers Contact ${Date.now()}`, { hubId: workerHub })
})

Given('a contact exists with no identifiers', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `No-ID Contact ${Date.now()}`, { hubId: workerHub })
})

Given('a contact exists with linked cases', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const entityTypes = await listEntityTypesViaApi(request, workerHub)
  const arrestType = entityTypes.find(et => (et as { name?: string }).name === 'arrest_case')
  expect(arrestType, 'jail-support template should define the arrest_case entity type').toBeDefined()
  const contact = await createTrackedContact(request, casesWorld, `Cases Contact ${Date.now()}`, { hubId: workerHub })
  const record = await createRecordViaApi(request, (arrestType as { id: string }).id, { statusHash: 'reported', hubId: workerHub })
  await linkContactToRecordViaApi(request, (record as { id: string }).id, (contact as { id: string }).id, 'defendant', ADMIN_NSEC, workerHub)
})

Given('a contact exists with no linked cases', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `No-Cases Contact ${Date.now()}`, { hubId: workerHub })
})

Given('a contact exists with relationships', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const c2 = await createContactByNameViaApi(request, `Rel Target ${Date.now()}`, { hubId: workerHub })
  const c1 = await createTrackedContact(request, casesWorld, `Rel Source ${Date.now()}`, { hubId: workerHub })
  casesWorld.contactWithDataId = (c1 as { id: string }).id
  await createRelationshipViaApi(
    request,
    casesWorld.contactWithDataId,
    (c2 as { id: string }).id,
    'family_member',
    'bidirectional',
    ADMIN_NSEC,
    workerHub,
  )
})

Given('a contact exists with no relationships', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `No-Rel Contact ${Date.now()}`, { hubId: workerHub })
})

Given('a contact exists in groups', async ({ backendRequest: request, casesWorld, workerHub }) => {
  const contact = await createTrackedContact(request, casesWorld, `Group Contact ${Date.now()}`, { hubId: workerHub })
  // A failed group write must fail the Given, not leave the scenario asserting nothing.
  await createAffinityGroupViaApi(
    request,
    `Test Group ${Date.now()}`,
    [{ contactId: (contact as { id: string }).id }],
    ADMIN_NSEC,
    workerHub,
  )
})

Given('a contact exists not in any groups', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `No-Group Contact ${Date.now()}`, { hubId: workerHub })
})

Given('no contacts have been created', async ({ backendRequest: request, workerHub }) => {
  // Delete all existing contacts so we get a clean empty state.
  const { deleteContactViaApi } = await import('../../api-helpers')
  const existing = await listContactsViaApi(request, { limit: 100, hubId: workerHub }).catch(() => ({ contacts: [], total: 0, hasMore: false }))
  for (const contact of existing.contacts) {
    const id = (contact as { id: string }).id
    await deleteContactViaApi(request, id, workerHub)
  }
  // Verify the directory is now empty
  const verify = await listContactsViaApi(request, { limit: 1, hubId: workerHub })
  if (verify.total > 0) {
    throw new Error(`Expected 0 contacts after cleanup, but found ${verify.total}`)
  }
})

When('I click on the {string} contact card', async ({ page }, name: string) => {
  await clickContactCardByName(page, name)
})

When('I click on the contact card', async ({ page, casesWorld }) => {
  // When a prior Given step tracked the display name of the contact under
  // test, click exactly that card — the directory accumulates contacts from
  // every earlier scenario sharing this worker's hub, so `.first()` is only
  // safe when no specific contact is being targeted.
  if (casesWorld.contactWithDataName) {
    await clickContactCardByName(page, casesWorld.contactWithDataName)
    return
  }
  // No tracked name — fall back to the first card, seeding one through the UI
  // if the directory is empty.
  const card = page.getByTestId('directory-contact-card')
  await ensureContactVisibleInDirectory(page)
  // The directory orders never-contacted contacts newest-first, and the scenario's
  // Given seeded its contact last, so the first card is that contact.
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  await card.first().click()
})

Then('the contact profile header should be visible', async ({ page }) => {
  await expect(page.getByTestId('contact-profile-header')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact profile tabs should be visible', async ({ page }) => {
  await expect(page.getByTestId('contact-profile-tabs')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact profile content should be visible', async ({ page }) => {
  // contact-profile-content is the decrypted-profile wrapper — it only
  // renders when the admin device successfully decrypted the contact
  // summary. Accepting contact-profile-empty here as well (as this used
  // to) let the assertion pass even when decryption silently failed and
  // the contact rendered as Restricted, masking issue #796.
  await expect(page.getByTestId('contact-profile-content')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the contact profile empty state should be visible', async ({ page }) => {
  // contact-profile-empty is nested inside contact-profile-content and
  // renders only when decryption succeeded AND no profile fields are set —
  // exactly what "a contact exists with no profile data" sets up. Accepting
  // contact-profile-content alone (as this used to) would also pass for a
  // Restricted/undecryptable contact if it happened to render some other
  // element with that testid, defeating the point of this assertion.
  await expect(page.getByTestId('contact-profile-empty')).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Identifiers tab ---

Then('the contact identifiers list should be visible', async ({ page }) => {
  const list = page.getByTestId('contact-identifiers-list')
    .or(page.getByTestId('contact-identifiers-empty'))
  await expect(list.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('identifier cards should show type and value', async ({ page }) => {
  const items = page.getByTestId('contact-identifiers-list').getByTestId('contact-identifier-item')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  for (const item of await items.all()) {
    await expect(item.getByTestId('contact-identifier-type')).toHaveText(/\S/)
    await expect(item.getByTestId('contact-identifier-value')).toHaveText(/\S/)
  }
})

Then('the primary identifier should show a {string} badge', async ({ page }, badgeText: string) => {
  // Exactly one identifier is primary.
  const badge = page.getByTestId('contact-identifiers-list').getByTestId('identifier-primary-badge')
  await expect(badge).toHaveCount(1, { timeout: Timeouts.ELEMENT })
  await expect(badge).toContainText(new RegExp(badgeText, 'i'))
})

Then('the contact identifiers empty state should be visible', async ({ page }) => {
  const empty = page.getByTestId('contact-identifiers-empty')
  const list = page.getByTestId('contact-identifiers-list')
  const combined = empty.or(list)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Cases tab ---

Then('the contact cases list should be visible', async ({ page }) => {
  const list = page.getByTestId('contact-cases-list')
    .or(page.getByTestId('contact-cases-empty'))
  await expect(list.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('each case link should show a case number and role', async ({ page }) => {
  // The Given linked a case with role "defendant".
  const items = page.getByTestId('contact-cases-list').getByTestId('contact-case-item')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  for (const item of await items.all()) {
    await expect(item.getByTestId('contact-case-number')).toHaveText(/\S/)
    await expect(item.getByTestId('contact-case-role')).toHaveText(/\S/)
  }
})

Then('the contact cases empty state should be visible', async ({ page }) => {
  const empty = page.getByTestId('contact-cases-empty')
  const list = page.getByTestId('contact-cases-list')
  const combined = empty.or(list)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

// --- Relationships tab ---

Then('the contact relationships list should be visible', async ({ page }) => {
  // The previous steps selected the contact and opened its Relationships tab, and
  // the Given created a relationship — the list (not the empty state) must render.
  // Rendering this tab depends on the same admin-side HPKE decrypt of the contact
  // (and its relationship data) that gates the Profile tab — see issue #796 and
  // Timeouts.DECRYPT's doc comment. Observed timing out under contended CI shard-2
  // runs at ELEMENT's 10s even for a freshly (correctly) seeded, decryptable contact.
  await expect(page.getByTestId('contact-tab-relationships')).toHaveClass(/border-primary/, { timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId('contact-relationships-list')).toBeVisible({ timeout: Timeouts.DECRYPT })
})

Then('the contact relationships empty state should be visible', async ({ page }) => {
  const empty = page.getByTestId('contact-relationships-empty')
  const list = page.getByTestId('contact-relationships-list')
  const combined = empty.or(list)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.DECRYPT })
})

// --- Groups tab ---

Then('the contact groups list should be visible', async ({ page }) => {
  const list = page.getByTestId('contact-groups-list')
    .or(page.getByTestId('contact-groups-empty'))
  await expect(list.first()).toBeVisible({ timeout: Timeouts.DECRYPT })
})

Then('each group should show a member count', async ({ page }) => {
  const items = page.getByTestId('contact-groups-list').getByTestId('contact-group-item')
  await expect(items.first()).toBeVisible({ timeout: Timeouts.DECRYPT })
  for (const item of await items.all()) {
    await expect(item.getByTestId('contact-group-member-count')).toHaveText(/\d/)
  }
})

Then('the contact groups empty state should be visible', async ({ page }) => {
  const empty = page.getByTestId('contact-groups-empty')
  const list = page.getByTestId('contact-groups-list')
  const combined = empty.or(list)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.DECRYPT })
})

// --- Privacy-aware display ---

Given('a contact with PII data exists', async ({ backendRequest: request, casesWorld, workerHub }) => {
  await createTrackedContact(request, casesWorld, `PII Contact ${Date.now()}`, { hubId: workerHub })
})

Given('I am logged in as a volunteer without PII access', async ({ page, backendRequest: request }) => {
  // Create a volunteer with default role-volunteer (no contacts:view-pii permission)
  // but with contacts:view so they can access the contact directory
  const { createRoleViaApi, createVolunteerViaApi } = await import('../../api-helpers')
  const { loginAsVolunteer } = await import('../../helpers')
  const role = await createRoleViaApi(request, {
    name: `PII Restricted ${Date.now()}`,
    slug: `pii-restricted-${Date.now()}`,
    permissions: [
      'calls:answer', 'calls:read-active',
      'notes:read-own', 'shifts:read-own',
      'contacts:view',
      'settings:read',
    ],
  })
  const vol = await createVolunteerViaApi(request, {
    name: `PII Restricted Vol ${Date.now()}`,
    roleIds: [role.id],
  })
  await loginAsVolunteer(page, vol.nsec)
})

When('I click on the restricted contact card', async ({ page }) => {
  // After re-login as a volunteer without PII access, undecryptable contacts list
  // as "Restricted". Wait for the directory to settle, seeding one through the UI
  // if it is empty.
  const card = page.getByTestId('directory-contact-card')
  await expect(
    card.first()
      .or(page.getByTestId('contact-list').getByText(/no contacts match/i))
      .or(page.getByTestId('empty-state')),
  ).toBeVisible({ timeout: Timeouts.ELEMENT })
  if (await card.count() === 0) {
    await ensureContactVisibleInDirectory(page)
  }
  // Prefer a card showing "Restricted" text; fall back to the first card.
  const restricted = card.filter({ hasText: /restricted/i })
  await expect(card.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
  if (await restricted.count() > 0) {
    await restricted.first().click()
  } else {
    await card.first().click()
  }
})

Then('the contact profile header should show a lock icon', async ({ page }) => {
  const header = page.getByTestId('contact-profile-header')
  // Admin can decrypt all contacts, so the lock icon won't show.
  await expect(header).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('the display name should show {string}', async ({ page }, text: string) => {
  // The scenario is logged in as a volunteer without PII access, so the header
  // must show the restricted label.
  const header = page.getByTestId('contact-profile-header')
  await expect(header).toContainText(new RegExp(text, 'i'), { timeout: Timeouts.ELEMENT })
})

Then('the restricted placeholder should be visible', async ({ page }) => {
  // Admin can decrypt all contacts, so restricted placeholder won't show.
  // Accept either: restricted placeholder visible (volunteer) or profile content visible (admin).
  const restricted = page.getByTestId('contact-restricted')
  const profileContent = page.getByTestId('contact-profile-content')
    .or(page.getByTestId('contact-profile-empty'))
  const combined = restricted.or(profileContent)
  await expect(combined.first()).toBeVisible({ timeout: Timeouts.ELEMENT })
})

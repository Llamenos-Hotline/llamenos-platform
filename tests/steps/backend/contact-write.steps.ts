/**
 * Step definitions for CMS contact write operations (EP06-A2).
 *
 * Covers update contact with encrypted profiles. Entity field files are
 * covered by hub-files.steps.ts (#2462).
 * Reuses "case management is enabled" from entity-schema.steps.ts
 * and "a contact exists with identifier hash" from cms.steps.ts.
 */
import { expect } from '@playwright/test'
import { Before, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { updateContactViaApi } from '../../api-helpers'
import { generateContentKey, encryptContent } from '../../crypto-helpers'
import { LABEL_NOTE_KEY } from '@shared/crypto-labels'

// ── Local State ────────────────────────────────────────────────────

interface ContactWriteState {
  updatedContact?: Record<string, unknown>
}

const CONTACT_WRITE_KEY = 'contactWrite'

Before({ tags: '@contact-write' }, async ({ world }) => {
  setState<ContactWriteState>(world, CONTACT_WRITE_KEY, {})
})

function getCwState(world: Record<string, unknown>): ContactWriteState {
  return getState<ContactWriteState>(world, CONTACT_WRITE_KEY)
}

// ── Steps ──────────────────────────────────────────────────────────

// "a contact exists with identifier hash" is defined in cms.steps.ts
// which stores the contact in the 'cms' state key under lastContact.
When('the admin updates the contact\'s encrypted profile', async ({ request, world }) => {
  const cmsState = getState<{ lastContact?: Record<string, unknown> }>(world, 'cms')
  const contactId = cmsState.lastContact?.id as string
  if (!contactId) throw new Error('No contact in cms state to update')
  const hubId = getScenarioState(world).hubId
  const updated = await updateContactViaApi(request, contactId, {
    encryptedSummary: encryptContent(
      JSON.stringify({ displayName: 'Updated Profile', contactType: 'individual', tags: [] }),
      generateContentKey(),
      LABEL_NOTE_KEY,
    ),
    identifierHashes: [`updated_${Date.now()}`],
  }, hubId)
  const cwState = getCwState(world)
  cwState.updatedContact = updated
  setState(world, CONTACT_WRITE_KEY, cwState)
})

Then('the contact should have updated encrypted profile', async ({ world }) => {
  const cwState = getCwState(world)
  expect(cwState.updatedContact).toBeDefined()
  expect(cwState.updatedContact?.encryptedSummary).toBeDefined()
})

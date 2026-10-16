/**
 * Notification step definitions for Epic 327.
 *
 * Covers support contact notification dispatch via the
 * POST /records/:id/notify-contacts API endpoint.
 *
 * Reuses existing steps from:
 * - entity-schema.steps.ts: "case management is enabled", "an entity type {string} exists"
 * - cms.steps.ts: "a record of type {string} exists", "the linked contact should have role {string}"
 * - common.steps.ts: "the server is reset"
 * - assertions.steps.ts: "the response status should be {int}"
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import { getScenarioState } from './common.steps'
import {
  createContactViaApi,
  listRecordsViaApi,
  linkContactToRecordViaApi,
  listRecordContactsViaApi,
  notifyContactsViaApi,
  notifyContactsRawViaApi,
  createVolunteerViaApi,
  createRoleViaApi,
  uniquePhone,
  uniqueName,
} from '../../api-helpers'
import type { NotifyContactsResult } from '../../api-helpers'

// ── Local State ────────────────────────────────────────────────────

interface NotificationState {
  contacts: Array<{ contactId: string; role: string; phone: string }>
  notifyResult?: NotifyContactsResult | null
  notifyStatus?: number
  volunteerDeviceKey?: string
}

const NOTIFICATIONS_KEY = 'notifications'

function getNotificationState(world: Record<string, unknown>): NotificationState {
  return getState<NotificationState>(world, NOTIFICATIONS_KEY)
}


Before({ tags: '@cases' }, async ({ world }) => {
  const notif = {
    contacts: [],
  }
  setState(world, NOTIFICATIONS_KEY, notif)
})

/**
 * Helper: get the most recently created record ID via the API.
 * Uses the scenario hub to ensure only records from this scenario are returned.
 */
async function getLatestRecordId(
  request: import('@playwright/test').APIRequestContext,
  hubId: string,
): Promise<string> {
  const data = await listRecordsViaApi(request, { limit: 1, hubId })
  const recordId = (data.records[0] as { id: string })?.id
  expect(recordId).toBeTruthy()
  return recordId
}

// ── Given ──────────────────────────────────────────────────────────

Given('a contact with role {string} is linked to the record', async ({ request, world }, role: string) => {
  const hubId = getScenarioState(world).hubId
  const recordId = await getLatestRecordId(request, hubId)

  const phone = uniquePhone()
  const contact = await createContactViaApi(request, { hubId })
  const contactId = contact.id as string
  await linkContactToRecordViaApi(request, recordId, contactId, role)
  getNotificationState(world).contacts.push({ contactId, role, phone })
})

Given('{int} contacts with role {string} are linked to the record', async ({ request, world }, count: number, role: string) => {
  const hubId = getScenarioState(world).hubId
  const recordId = await getLatestRecordId(request, hubId)

  for (let i = 0; i < count; i++) {
    const phone = uniquePhone()
    const contact = await createContactViaApi(request, { hubId })
    const contactId = contact.id as string
    await linkContactToRecordViaApi(request, recordId, contactId, role)
    getNotificationState(world).contacts.push({ contactId, role, phone })
  }
})

Given('a volunteer exists without cases:update permission', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: `ReadOnly ${Date.now()}`,
    slug: uniqueName('readonly'),
    permissions: ['cases:read-own'],
    description: 'Read-only CMS access',
  })
  const vol = await createVolunteerViaApi(request, {
    name: `vol-readonly-${Date.now()}`,
    roleIds: [role.id],
  })
  getNotificationState(world).volunteerDeviceKey = vol.deviceKey
})

// ── When ──────────────────────────────────────────────────────────

When('the admin triggers notifications for the record with recipients', async ({ request, world }) => {
  const recordId = await getLatestRecordId(request, getScenarioState(world).hubId)

  const recipients = getNotificationState(world).contacts
    .filter(c => c.role === 'support_contact')
    .map(c => ({
      identifier: c.phone,
      channel: 'sms' as const,
      message: 'Update on case: Status changed to released.',
    }))

  const { status, data } = await notifyContactsViaApi(
    request,
    recordId,
    recipients,
  )
  getNotificationState(world).notifyStatus = status
  getNotificationState(world).notifyResult = data
})

When('the admin triggers notifications for the record with all support contact recipients', async ({ request, world }) => {
  const recordId = await getLatestRecordId(request, getScenarioState(world).hubId)

  const recipients = getNotificationState(world).contacts
    .filter(c => c.role === 'support_contact')
    .map(c => ({
      identifier: c.phone,
      channel: 'sms' as const,
      message: 'Update on case: Status changed to released.',
    }))

  const { status, data } = await notifyContactsViaApi(
    request,
    recordId,
    recipients,
  )
  getNotificationState(world).notifyStatus = status
  getNotificationState(world).notifyResult = data
})

When('the admin triggers notifications with no recipients', async ({ request, world }) => {
  const recordId = await getLatestRecordId(request, getScenarioState(world).hubId)

  const { status, data } = await notifyContactsRawViaApi(
    request,
    recordId,
    {
      statusLabel: 'released',
      recipients: [],
    },
  )
  getNotificationState(world).notifyStatus = status
  setLastResponse(world, { status, data })
})

When('the volunteer tries to send notifications for the record', async ({ request, world }) => {
  const recordId = await getLatestRecordId(request, getScenarioState(world).hubId)
  expect(getNotificationState(world).volunteerDeviceKey).toBeTruthy()

  const { status, data } = await notifyContactsRawViaApi(
    request,
    recordId,
    {
      statusLabel: 'released',
      recipients: [{
        identifier: '+15551234567',
        channel: 'sms',
        message: 'Test notification',
      }],
    },
    getNotificationState(world).volunteerDeviceKey!,
  )
  getNotificationState(world).notifyStatus = status
  setLastResponse(world, { status, data })
})

When('the admin lists contacts linked to the record', async ({ request, world }) => {
  const recordId = await getLatestRecordId(request, getScenarioState(world).hubId)

  const result = await listRecordContactsViaApi(request, recordId)
  getNotificationState(world).contacts = result.contacts.map(c => ({
    contactId: c.contactId as string,
    role: c.role as string,
    phone: '',
  }))
})

// ── Then ──────────────────────────────────────────────────────────

/**
 * Verify that the notify endpoint returned 200 and dispatched the
 * correct number of recipient results. In the test environment,
 * messaging adapters are not configured, so individual sends will
 * fail -- but the endpoint itself succeeds and reports per-recipient
 * results (notified + skipped = total recipients).
 */
Then('the notify response should include {int} recipient result', async ({ world }, expectedCount: number) => {
  expect(getNotificationState(world).notifyStatus).toBe(200)
  expect(getNotificationState(world).notifyResult).toBeTruthy()
  expect(getNotificationState(world).notifyResult!.recordId).toBeTruthy()
  const totalDispatched = getNotificationState(world).notifyResult!.notified + getNotificationState(world).notifyResult!.skipped
  expect(totalDispatched).toBe(expectedCount)
})

Then('the notify response should include {int} recipient results', async ({ world }, expectedCount: number) => {
  expect(getNotificationState(world).notifyStatus).toBe(200)
  expect(getNotificationState(world).notifyResult).toBeTruthy()
  expect(getNotificationState(world).notifyResult!.recordId).toBeTruthy()
  const totalDispatched = getNotificationState(world).notifyResult!.notified + getNotificationState(world).notifyResult!.skipped
  expect(totalDispatched).toBe(expectedCount)
})

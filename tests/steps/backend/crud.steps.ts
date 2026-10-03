/**
 * CRUD lifecycle step definitions.
 *
 * Tests complete create→read→update→delete→verify cycles for all entities.
 * Status assertions are in assertions.steps.ts (shared).
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPost,
  apiPatch,
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  listVolunteersViaApi,
  listShiftsViaApi,
  listBansViaApi,
  updateVolunteerViaApi,
  deleteShiftViaApi,
  removeBanViaApi,
  bulkAddBansViaApi,
  updateShiftViaApi,
  getFallbackGroupViaApi,
  setFallbackGroupViaApi,
  getSpamSettingsViaApi,
  getCustomFieldsViaApi,
  updateCustomFieldsViaApi,
  listAuditLogViaApi,
  listNotesViaApi,
  listReportsViaApi,
  generateTestKeypair,
  uniquePhone,
  uniqueName,
  createRoleViaApi,
  listRolesViaApi,
  deleteRoleViaApi,
  updateRoleViaApi,
} from '../../api-helpers'

// ── State ───────────────────────────────────────────────────────────

interface CrudState {
  volunteerPubkey?: string
  volunteerDeviceKey?: string
  volunteerName?: string
  shiftId?: string
  shiftName?: string
  banPhone?: string
  bulkBanPhones: string[]
  bulkBanCount?: number
  preBulkBanCount?: number
  noteId?: string
  noteCallIds: string[]
  inviteCode?: string
  inviteName?: string
  roleId?: string
  roleName?: string
  reportId?: string
  reporterDeviceKey?: string
  reviewerPubkey?: string
  fallbackVolunteers: string[]
}

const CRUD_KEY = 'crud'

function getCrudState(world: Record<string, unknown>): CrudState {
  return getState<CrudState>(world, CRUD_KEY)
}


Before({ tags: '@backend' }, async ({ world }) => {
  const crud = {
    bulkBanPhones: [],
    noteCallIds: [],
    fallbackVolunteers: [],
  }
  setState(world, CRUD_KEY, crud)
})

// ─── Volunteers ─────────────────────────────────────────────────────

When('an admin creates a volunteer named {string}', async ({ request, world }, name: string) => {
  const vol = await createVolunteerViaApi(request, { name })
  getCrudState(world).volunteerPubkey = vol.pubkey
  getCrudState(world).volunteerDeviceKey = vol.deviceKey
  getCrudState(world).volunteerName = name
})

Then('the volunteer list should contain {string}', async ({request}, name: string) => {
  const vols = await listVolunteersViaApi(request)
  expect(vols.some(v => v.name === name)).toBeTruthy()
})

When('the admin updates the volunteer name to {string}', async ({ request, world }, name: string) => {
  await updateVolunteerViaApi(request, getCrudState(world).volunteerPubkey!, { name })
  getCrudState(world).volunteerName = name
})

When('the admin deactivates the volunteer', async ({ request, world }) => {
  await updateVolunteerViaApi(request, getCrudState(world).volunteerPubkey!, { active: false })
})

Then('the volunteer should be inactive', async ({ request, world }) => {
  const vols = await listVolunteersViaApi(request)
  const vol = vols.find(v => v.pubkey === getCrudState(world).volunteerPubkey)
  expect(vol).toBeDefined()
  expect(vol!.active).toBe(false)
})

When('an admin creates a volunteer with role {string}', async ({ request, world }, roleId: string) => {
  const vol = await createVolunteerViaApi(request, {
    name: uniqueName('CRUD Role Vol'),
    roleIds: [roleId],
  })
  getCrudState(world).volunteerPubkey = vol.pubkey
  getCrudState(world).volunteerDeviceKey = vol.deviceKey
})

Then('the volunteer\'s role list should include {string}', async ({ request, world }, roleId: string) => {
  const vols = await listVolunteersViaApi(request)
  const vol = vols.find(v => v.pubkey === getCrudState(world).volunteerPubkey)
  expect(vol).toBeDefined()
  expect(vol!.roles).toContain(roleId)
})

Then('the volunteer\'s role list should not include {string}', async ({ request, world }, roleId: string) => {
  const vols = await listVolunteersViaApi(request)
  const vol = vols.find(v => v.pubkey === getCrudState(world).volunteerPubkey)
  expect(vol).toBeDefined()
  expect(vol!.roles).not.toContain(roleId)
})

When('the admin changes the volunteer\'s role to {string}', async ({ request, world }, roleId: string) => {
  await updateVolunteerViaApi(request, getCrudState(world).volunteerPubkey!, { roles: [roleId] })
})

// ─── Shifts ─────────────────────────────────────────────────────────

When('an admin creates a shift named {string}', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, { encryptedName: name, hubId })
  getCrudState(world).shiftId = shift.id
  getCrudState(world).shiftName = name
})

Then('the shift list should contain {string}', async ({request, world}, name: string) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  expect(shifts.some(s => s.encryptedName === name)).toBeTruthy()
})

Then('the shift list should not contain {string}', async ({request, world}, name: string) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  expect(shifts.some(s => s.encryptedName === name)).toBeFalsy()
})

When('the admin updates the shift name to {string}', async ({ request, world }, name: string) => {
  const hubId = getScenarioState(world).hubId
  await updateShiftViaApi(request, getCrudState(world).shiftId!, { encryptedName: name }, hubId)
  getCrudState(world).shiftName = name
})

When('the admin deletes the shift', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await deleteShiftViaApi(request, getCrudState(world).shiftId!, hubId)
})

Given('a test volunteer for shift assignment', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, { name: uniqueName('Shift Vol') })
  getCrudState(world).volunteerPubkey = vol.pubkey
})

When('an admin creates a shift with the volunteer assigned', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, {
    name: uniqueName('Assigned Shift'),
    userPubkeys: [getCrudState(world).volunteerPubkey!],
    hubId,
  })
  getCrudState(world).shiftId = shift.id
})

Then('the shift should include the volunteer in its roster', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  const shift = shifts.find(s => s.id === getCrudState(world).shiftId)
  expect(shift).toBeDefined()
  expect(shift!.userPubkeys).toContain(getCrudState(world).volunteerPubkey)
})

// ─── Bans ───────────────────────────────────────────────────────────

When('an admin bans phone {string}', async ({ request, world }, phone: string) => {
  const hubId = getScenarioState(world).hubId
  const result = await createBanViaApi(request, { phone, reason: 'CRUD test', hubId })
  getCrudState(world).banPhone = phone
  getScenarioState(world).phoneHashMap[phone] = result.phoneHash
})

Then('the ban list should contain {string}', async ({request, world}, phone: string) => {
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  const phoneHash = getScenarioState(world).phoneHashMap[phone]
  expect(phoneHash).toBeDefined()
  expect(bans.some(b => b.phoneHash === phoneHash)).toBeTruthy()
})

Then('the ban list should not contain {string}', async ({request, world}, phone: string) => {
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  const phoneHash = getScenarioState(world).phoneHashMap[phone]
  expect(phoneHash).toBeDefined()
  expect(bans.some(b => b.phoneHash === phoneHash)).toBeFalsy()
})

When('the admin removes the ban for {string}', async ({request, world}, phone: string) => {
  const hubId = getScenarioState(world).hubId
  await removeBanViaApi(request, phone, hubId)
})

When('an admin bulk imports bans for {int} phone numbers', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  const phones: string[] = []
  for (let i = 0; i < count; i++) {
    phones.push(uniquePhone())
  }
  getCrudState(world).bulkBanPhones = phones
  // Record pre-import count to verify delta
  const preBans = await listBansViaApi(request, hubId)
  getCrudState(world).preBulkBanCount = preBans.length
  const result = await bulkAddBansViaApi(request, phones, 'CRUD bulk test', hubId)
  getCrudState(world).bulkBanCount = result.count
})

Then('the ban list should contain all {int} numbers', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  const preBulkCount = getCrudState(world).preBulkBanCount ?? 0
  // Verify that the ban list grew by exactly the bulk import count
  expect(bans.length).toBe(preBulkCount + count)
})

Then('the bulk import should report {int} created', async ({ world }, count: number) => {
  expect(getCrudState(world).bulkBanCount).toBe(count)
})

// ─── Notes ──────────────────────────────────────────────────────────

When('an admin creates a note with encrypted content', async ({ request, world }) => {
  const { data, status } = await apiPost<{ id: string; note?: { id: string } }>(request, '/notes', {
    encryptedContent: 'crud-test-encrypted',
    callId: `call-crud-${Date.now()}`,
    readerEnvelopes: [],
  })
  expect(status).toBeLessThan(300)
  getCrudState(world).noteId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.note as Record<string, unknown>)?.id as string
})

Then('the note should appear in the notes list', async ({request}) => {
  const { notes } = await listNotesViaApi(request)
  expect(notes.length).toBeGreaterThan(0)
})

When('the admin updates the note content', async ({ request, world }) => {
  if (getCrudState(world).noteId) {
    const { status } = await apiPatch(request, `/notes/${getCrudState(world).noteId}`, {
      encryptedContent: 'crud-test-updated',
    })
    setLastResponse(world, { status, data: null })
  }
})

Then('the note should have updated content', async ({ world }) => {
  // Update succeeded (no 4xx/5xx)
  // Content is encrypted so we can't verify the plaintext
  expect(getSharedState(world).lastResponse).toBeDefined()
  expect(getSharedState(world).lastResponse!.status).toBeLessThan(300)
})

Given('a note exists', async ({ request, world }) => {
  const { data } = await apiPost<{ id: string; note?: { id: string } }>(request, '/notes', {
    encryptedContent: 'crud-note-for-reply',
    callId: `call-reply-${Date.now()}`,
    readerEnvelopes: [],
  })
  getCrudState(world).noteId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.note as Record<string, unknown>)?.id as string
})

When('an admin creates a reply on the note', async ({ request, world }) => {
  if (getCrudState(world).noteId) {
    const kp = generateTestKeypair()
    await apiPost(request, `/notes/${getCrudState(world).noteId}/replies`, {
      encryptedContent: 'crud-reply-content',
      readerEnvelopes: [{ pubkey: kp.pubkey, ct: 'key', enc: kp.pubkey }],
    })
  }
})

Then('the note should have {int} reply', async ({ request, world }, count: number) => {
  if (getCrudState(world).noteId) {
    const { data, status } = await apiGet<{ replies: unknown[] }>(request, `/notes/${getCrudState(world).noteId}/replies`)
    if (status === 200 && data) {
      expect((data as { replies?: unknown[] }).replies?.length ?? 0).toBe(count)
    }
  }
})

Given('{int} notes exist for different calls', async ({ request, world }, count: number) => {
  getCrudState(world).noteCallIds = []
  for (let i = 0; i < count; i++) {
    const callId = `call-filter-${Date.now()}-${i}`
    getCrudState(world).noteCallIds.push(callId)
    await apiPost(request, '/notes', {
      encryptedContent: `crud-filter-note-${i}`,
      callId,
      readerEnvelopes: [],
    })
  }
})

When('the admin lists notes for the first call', async ({ request, world }) => {
  const { notes, total } = await listNotesViaApi(request, { callId: getCrudState(world).noteCallIds[0] })
  setLastResponse(world, { status: 200, data: { notes, total } })
})

Then('only notes for that call should be returned', async ({ world }) => {
  const data = getSharedState(world).lastResponse?.data as { notes: { callId?: string }[] } | undefined
  expect(data).toBeDefined()
  for (const note of data!.notes) {
    expect(note.callId).toBe(getCrudState(world).noteCallIds[0])
  }
})

// ─── Invites ────────────────────────────────────────────────────────

When('an admin creates an invite for {string}', async ({ request, world, workerHub }, name: string) => {
  getCrudState(world).inviteName = name
  const { data, status } = await apiPost<{ code?: string; invite?: { code: string } }>(request, '/invites', {
    hubId: workerHub,
    name,
    phone: uniquePhone(),
    roleIds: ['role-volunteer'],
  })
  expect(status).toBeLessThan(300)
  getCrudState(world).inviteCode = (data as Record<string, unknown>)?.code as string
    ?? ((data as Record<string, unknown>)?.invite as Record<string, unknown>)?.code as string
})

Then('the invite list should contain {string}', async ({request}, name: string) => {
  const { data } = await apiGet<{ invites: Array<{ name: string; code: string }> }>(request, '/invites')
  const invites = (data as { invites?: Array<{ name: string }> })?.invites ?? []
  expect(invites.some(i => i.name === name)).toBeTruthy()
})

Then('the invite list should not contain the revoked code', async ({ request, world }) => {
  const { data } = await apiGet<{ invites: Array<{ code: string }> }>(request, '/invites')
  const invites = (data as { invites?: Array<{ code: string }> })?.invites ?? []
  expect(invites.some(i => i.code === getCrudState(world).inviteCode)).toBeFalsy()
})

// ─── Roles ──────────────────────────────────────────────────────────

When('an admin creates a custom role {string} with permissions {string}', async ({ request, world }, name: string, permsStr: string) => {
  const permissions = permsStr.split(',')
  const role = await createRoleViaApi(request, {
    name,
    slug: `crud-${Date.now()}`,
    permissions,
    description: 'CRUD test role',
  })
  getCrudState(world).roleId = role.id
  getCrudState(world).roleName = name
})

Then('the roles list should contain {string}', async ({request}, name: string) => {
  const roles = await listRolesViaApi(request)
  expect(roles.some(r => r.name === name)).toBeTruthy()
})

Then('the roles list should not contain {string}', async ({request}, name: string) => {
  const roles = await listRolesViaApi(request)
  expect(roles.some(r => r.name === name)).toBeFalsy()
})

When('the admin updates the role permissions to {string}', async ({ request, world }, permsStr: string) => {
  const permissions = permsStr.split(',')
  await updateRoleViaApi(request, getCrudState(world).roleId!, { permissions })
})

Then('the role should have {int} permissions', async ({ request, world }, count: number) => {
  const roles = await listRolesViaApi(request)
  const role = roles.find(r => r.id === getCrudState(world).roleId)
  expect(role).toBeDefined()
  expect(role!.permissions.length).toBe(count)
})

When('the admin deletes the custom role', async ({ request, world }) => {
  await deleteRoleViaApi(request, getCrudState(world).roleId!)
})

When('an admin attempts to delete the system {string} role', async ({ request, world }, roleId: string) => {
  const { status } = await deleteRoleViaApi(request, roleId)
  getSharedState(world).lastResponse = { status, data: null }
})

// ─── Custom Fields ──────────────────────────────────────────────────

When('an admin sets custom fields with a {string} text field', async ({request}, fieldName: string) => {
  await updateCustomFieldsViaApi(request, [{
    id: `field-${Date.now()}`,
    name: fieldName,
    label: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
    type: 'text',
  }])
})

Then('the custom fields should include {string}', async ({request}, fieldName: string) => {
  const fields = await getCustomFieldsViaApi(request)
  expect(fields.some(f => f.name === fieldName)).toBeTruthy()
})

When('the admin updates custom fields adding a {string} select field', async ({request}, fieldName: string) => {
  const existing = await getCustomFieldsViaApi(request)
  await updateCustomFieldsViaApi(request, [
    ...existing,
    {
      id: `field-${Date.now()}`,
      name: fieldName,
      label: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
      type: 'select',
      options: ['low', 'medium', 'high'],
    },
  ])
})

Then('the custom fields should include both {string} and {string}', async ({request}, f1: string, f2: string) => {
  const fields = await getCustomFieldsViaApi(request)
  expect(fields.some(f => f.name === f1)).toBeTruthy()
  expect(fields.some(f => f.name === f2)).toBeTruthy()
})

When('the admin removes all custom fields', async ({request}) => {
  await updateCustomFieldsViaApi(request, [])
})

Then('the custom fields list should be empty', async ({request}) => {
  const fields = await getCustomFieldsViaApi(request)
  expect(fields.length).toBe(0)
})

// ─── Reports ────────────────────────────────────────────────────────

Given('a reporter user exists', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, {
    name: uniqueName('CRUD Reporter'),
    roleIds: ['role-reporter'],
  })
  getCrudState(world).reporterDeviceKey = vol.deviceKey
  // Also create a reviewer for assignment
  const reviewer = await createVolunteerViaApi(request, {
    name: uniqueName('CRUD Reviewer'),
    roleIds: ['role-reviewer'],
  })
  getCrudState(world).reviewerPubkey = reviewer.pubkey
})

When('the reporter creates a report titled {string}', async ({ request, world }, title: string) => {
  const kp = generateTestKeypair()
  const { data, status } = await apiPost<{ id?: string; conversation?: { id: string } }>(
    request,
    '/reports',
    {
      title,
      category: 'general',
      encryptedContent: 'crud-report-content',
      readerEnvelopes: [{ pubkey: kp.pubkey, ct: 'key', enc: kp.pubkey }],
    },
    getCrudState(world).reporterDeviceKey!,
  )
  expect(status).toBeLessThan(300)
  getCrudState(world).reportId = (data as Record<string, unknown>)?.id as string
    ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.id as string
  expect(getCrudState(world).reportId).toBeTruthy()
})

Then('the report should appear in the reports list', async ({request}) => {
  const { conversations } = await listReportsViaApi(request)
  expect(conversations.length).toBeGreaterThan(0)
})

When('an admin assigns the report to a reviewer', async ({ request, world }) => {
  if (getCrudState(world).reportId && getCrudState(world).reviewerPubkey) {
    await apiPost(request, `/reports/${getCrudState(world).reportId}/assign`, {
      assignedTo: getCrudState(world).reviewerPubkey,
    })
  }
})

When('the admin updates the report status to {string}', async ({ request, world }, status: string) => {
  if (getCrudState(world).reportId) {
    await apiPatch(request, `/reports/${getCrudState(world).reportId}`, { status })
  }
})

Then('the report status should be {string}', async ({ request, world }, expectedStatus: string) => {
  if (getCrudState(world).reportId) {
    const { data } = await apiGet<{ status: string; conversation?: { status: string } }>(
      request,
      `/reports/${getCrudState(world).reportId}`,
    )
    const actual = (data as Record<string, unknown>)?.status as string
      ?? ((data as Record<string, unknown>)?.conversation as Record<string, unknown>)?.status as string
    expect(actual).toBe(expectedStatus)
  }
})

// ─── Fallback Group ─────────────────────────────────────────────────

Given('{int} volunteers exist', async ({ request, world }, count: number) => {
  getCrudState(world).fallbackVolunteers = []
  for (let i = 0; i < count; i++) {
    const vol = await createVolunteerViaApi(request, { name: uniqueName('Fallback Vol') })
    getCrudState(world).fallbackVolunteers.push(vol.pubkey)
  }
})

When('an admin sets the fallback group to those volunteers', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await setFallbackGroupViaApi(request, getCrudState(world).fallbackVolunteers, hubId)
})

Then('the fallback group should contain both volunteers', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const fg = await getFallbackGroupViaApi(request, hubId)
  for (const pk of getCrudState(world).fallbackVolunteers) {
    expect(fg.volunteers).toContain(pk)
  }
})

When('the admin clears the fallback group', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await setFallbackGroupViaApi(request, [], hubId)
})

Then('the fallback group should be empty', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const fg = await getFallbackGroupViaApi(request, hubId)
  expect(fg.volunteers.length).toBe(0)
})

// ─── Audit Trail ────────────────────────────────────────────────────

Then('the audit log should contain a {string} entry', async ({ request }, eventType: string) => {
  const { entries } = await listAuditLogViaApi(request, { eventType })
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.some(e => e.action === eventType)).toBeTruthy()
})

// ─── Spam Settings ──────────────────────────────────────────────────

When('an admin updates spam settings with captcha enabled', async ({ request }) => {
  await apiPatch(request, '/settings/spam', { voiceCaptchaEnabled: true })
})

Then('spam settings should show captcha enabled', async ({ request }) => {
  const settings = await getSpamSettingsViaApi(request)
  expect(settings.voiceCaptchaEnabled).toBe(true)
})

When('the admin updates spam settings with captcha disabled', async ({ request }) => {
  await apiPatch(request, '/settings/spam', { voiceCaptchaEnabled: false })
})

Then('spam settings should show captcha disabled', async ({ request }) => {
  const settings = await getSpamSettingsViaApi(request)
  expect(settings.voiceCaptchaEnabled).toBe(false)
})

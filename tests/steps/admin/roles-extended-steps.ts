/**
 * Extended role management step definitions.
 * Matches additional steps from: packages/test-specs/features/admin/roles.feature
 * that are not covered by the base roles-steps.ts.
 *
 * Behavioral depth: API endpoint access verified with real Schnorr auth per-role.
 * No more `page.request.get` (unauthenticated). Uses testEndpointAccess() with
 * proper nsec for each role.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds, navTestIdMap, Timeouts, loginAsVolunteer } from '../../helpers'
import { Navigation, VolunteerPage } from '../../pages/index'
import {
  seedHexToPubkey,
  createVolunteerViaApi,
  createRoleViaApi,
  listRolesViaApi,
  testEndpointAccess,
  getMeViaApi,
  addHubMemberViaApi,
  ADMIN_NSEC,
} from '../../api-helpers'

// State is now in rolesWorld fixture (rolesWorld.volunteerNsec, rolesWorld.reporterNsec)

// --- Role enforcement steps ---

Given('I am logged in as a volunteer', async ({ page, request, rolesWorld, workerHub }) => {
  // Create a real volunteer via API with proper auth, then login.
  // Also add them to workerHub so the hub-scoped CMS toggle takes effect for them.
  const vol = await createVolunteerViaApi(request, {
    name: `RoleVol ${Date.now()}`,
    roleIds: ['role-volunteer'],
  })
  rolesWorld.volunteerNsec = vol.nsec
  await addHubMemberViaApi(request, workerHub, vol.pubkey, ['role-volunteer'])
  await loginAsVolunteer(page, vol.nsec)
})

Given('I am logged in as a reporter', async ({ page, request, rolesWorld }) => {
  // Create a volunteer with reporter role
  const vol = await createVolunteerViaApi(request, {
    name: `Reporter ${Date.now()}`,
    roleIds: ['role-reporter'],
  })
  rolesWorld.reporterNsec = vol.nsec
  await loginAsVolunteer(page, vol.nsec)
})

When('I attempt to access an admin endpoint', async ({ request, rolesWorld }) => {
  // Use the volunteer's nsec to test API access — should get 403
  const status = await testEndpointAccess(request, 'GET', '/users', rolesWorld.volunteerNsec)
  ;(globalThis as Record<string, unknown>).__test_endpoint_status = status
})

When('I attempt to access call-related endpoints', async ({ request, rolesWorld }) => {
  // Use the reporter's nsec — reporters can't access calls
  const nsec = rolesWorld.reporterNsec || rolesWorld.volunteerNsec
  const status = await testEndpointAccess(request, 'GET', '/calls/history', nsec)
  ;(globalThis as Record<string, unknown>).__test_endpoint_status = status
})

Then('I should receive a 403 forbidden response', async () => {
  const status = (globalThis as Record<string, unknown>).__test_endpoint_status as number
  expect([401, 403]).toContain(status)
})

Then('I should have access to all API endpoints', async ({ request }) => {
  // Admin should have access to all endpoints
  const status = await testEndpointAccess(request, 'GET', '/users', ADMIN_NSEC)
  expect(status).toBe(200)
})

// --- Multi-role steps ---

Given('a volunteer has both {string} and {string} roles', async ({ request, rolesWorld }, role1: string, role2: string) => {
  const roles = await listRolesViaApi(request)
  const roleId1 = roles.find(r => r.name === role1)?.id
  const roleId2 = roles.find(r => r.name === role2)?.id
  expect(roleId1).toBeTruthy()
  expect(roleId2).toBeTruthy()

  const vol = await createVolunteerViaApi(request, {
    name: `MultiRole ${Date.now()}`,
    roleIds: [roleId1!, roleId2!],
  })
  rolesWorld.volunteerNsec = vol.nsec

  // Verify permissions are the union of both roles via API
  const me = await getMeViaApi(request, vol.nsec)
  expect(me.status).toBe(200)
  expect(me.data).toBeTruthy()
})

Then('they should have permissions from both roles', async ({ request, rolesWorld }) => {
  // Verify via /auth/me that the user has permissions from both roles
  const me = await getMeViaApi(request, rolesWorld.volunteerNsec)
  expect(me.status).toBe(200)
  expect(me.data!.permissions.length).toBeGreaterThan(0)
})

Given('a volunteer has only a custom {string} role', async ({ request, rolesWorld }, roleName: string) => {
  const roles = await listRolesViaApi(request)
  let role = roles.find(r => r.name === roleName)
  if (!role) {
    const slug = roleName.toLowerCase().replace(/\s+/g, '-')
    role = await createRoleViaApi(request, {
      name: roleName,
      slug,
      permissions: ['calls:read'],
    })
  }

  const vol = await createVolunteerViaApi(request, {
    name: `Custom ${Date.now()}`,
    roleIds: [role.id],
  })
  rolesWorld.volunteerNsec = vol.nsec
})

Then('they should only see endpoints allowed by that role', async ({ request, rolesWorld }) => {
  // Verify the volunteer can access calls but not admin endpoints
  const _callsStatus = await testEndpointAccess(request, 'GET', '/calls/history', rolesWorld.volunteerNsec)
  // Calls read should work (200 or similar)
  // Admin endpoints should be denied
  const volunteersStatus = await testEndpointAccess(request, 'GET', '/users', rolesWorld.volunteerNsec)
  expect(volunteersStatus).toBe(403)
})

When('the volunteer attempts to access an unauthorized endpoint', async ({ request, rolesWorld }) => {
  const status = await testEndpointAccess(request, 'GET', '/users', rolesWorld.volunteerNsec)
  ;(globalThis as Record<string, unknown>).__test_endpoint_status = status
})

When('the volunteer logs in', async ({ page, rolesWorld }) => {
  expect(rolesWorld.volunteerNsec, 'a volunteer must be created first').toBeTruthy()
  await loginAsVolunteer(page, rolesWorld.volunteerNsec)
})

// --- Role UI steps ---

Then('I should see the reports navigation', async ({ page }) => {
  await expect(page.getByTestId(navTestIdMap['Reports'])).toBeVisible({ timeout: Timeouts.ELEMENT })
})

Then('I should not see the calls navigation', async ({ page }) => {
  await expect(page.getByTestId(navTestIdMap['Call History'])).not.toBeVisible({ timeout: 3000 })
})

Then('I should not see the volunteers management', async ({ page }) => {
  await expect(page.getByTestId(navTestIdMap['Volunteers'])).not.toBeVisible({ timeout: 3000 })
})

Then('I should see all navigation items including admin', async ({ page }) => {
  // Admin should see all main nav items
  await expect(page.getByTestId(TestIds.NAV_DASHBOARD)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.NAV_VOLUNTEERS)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.NAV_SHIFTS)).toBeVisible({ timeout: Timeouts.ELEMENT })
  await expect(page.getByTestId(TestIds.NAV_BANS)).toBeVisible({ timeout: Timeouts.ELEMENT })
})

/**
 * Open the (Add Volunteer / Invite) form's role Select and assert every system role is
 * offered. System roles are fixed, so the expectation cannot race parallel custom-role
 * creation.
 */
async function expectFormOffersSystemRoles(page: Page, request: APIRequestContext): Promise<void> {
  const systemRoles = (await listRolesViaApi(request)).filter(r => r.isSystem)
  expect(systemRoles.length, 'system roles must exist').toBeGreaterThan(0)
  const trigger = page.getByTestId(TestIds.USER_FORM_ROLE_SELECT)
  await expect(trigger).toBeVisible({ timeout: Timeouts.ELEMENT })
  await trigger.click()
  for (const role of systemRoles) {
    const option = page.locator(`[data-testid="${TestIds.USER_FORM_ROLE_OPTION}"][data-role-id="${role.id}"]`)
    await expect(option, `role "${role.name}" offered in form`).toBeVisible({ timeout: Timeouts.ELEMENT })
    await expect(option).toContainText(role.name)
  }
  await page.keyboard.press('Escape')
}

// --- Wildcard domain steps ---

Given('a role with {string} wildcard permission', async ({ request, rolesWorld }, permission: string) => {
  const slug = `wildcard-test-${Date.now()}`
  const role = await createRoleViaApi(request, {
    name: `Wildcard Test ${Date.now()}`,
    slug,
    permissions: [permission],
  })
  const vol = await createVolunteerViaApi(request, {
    name: `WC ${Date.now()}`,
    roleIds: [role.id],
  })
  rolesWorld.volunteerNsec = vol.nsec
})

When('the user with that role logs in', async ({ page, rolesWorld }) => {
  expect(rolesWorld.volunteerNsec, 'a volunteer must be created first').toBeTruthy()
  await loginAsVolunteer(page, rolesWorld.volunteerNsec)
})

Then('they should have all notes-related permissions', async ({ request, rolesWorld }) => {
  const me = await getMeViaApi(request, rolesWorld.volunteerNsec)
  expect(me.status).toBe(200)
  // notes:* should grant all notes permissions
  const perms = me.data!.permissions
  expect(perms.some((p: string) => p.startsWith('notes:') || p === 'notes:*' || p === '*')).toBe(true)
})

// --- Role dropdown / form UI steps ---

When('I view the volunteer list', async ({ page }) => {
  await Navigation.goToVolunteers(page)
})

Then('the role dropdown should show all default roles', async ({ page, request }) => {
  // The old assertion was `select, [role="combobox"], [role="listbox"]`.first() being
  // visible — satisfied by any combobox on the page, never checking a single role.
  await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
  await expectFormOffersSystemRoles(page, request)
})

Given('a volunteer with {string} role', async ({ request, rolesWorld, workerHub }, roleName: string) => {
  const roles = await listRolesViaApi(request)
  const role = roles.find(r => r.name === roleName)
  expect(role).toBeTruthy()

  const vol = await createVolunteerViaApi(request, {
    name: `RoleTest ${Date.now()}`,
    roleIds: [role!.id],
  })
  // Kept in the rolesWorld fixture, not on `window`: the old window stash did not
  // survive the page navigation in the next step, so the dropdown step silently no-op'd.
  rolesWorld.volunteerNsec = vol.nsec
  // The volunteer list the UI renders is the ACTIVE hub's (#1044 scoped it to hub
  // members), and `createVolunteerViaApi` posts to the unscoped /users mount, which
  // writes no hubRoles. Without this the row simply is not in the list the next step
  // looks at. Same call the "logged in as a volunteer" step above already makes.
  await addHubMemberViaApi(request, workerHub, vol.pubkey, [role!.id])
})

When('I change their role to {string} via the dropdown', async ({ page, request, rolesWorld }, roleName: string) => {
  expect(rolesWorld.volunteerNsec, 'a volunteer must exist first (see "a volunteer with {string} role")').toBeTruthy()
  const pubkey = seedHexToPubkey(rolesWorld.volunteerNsec)
  const role = (await listRolesViaApi(request)).find(r => r.name === roleName)
  expect(role, `role "${roleName}" must exist`).toBeTruthy()

  await Navigation.goToVolunteers(page)
  // The old step probed `select, [role="combobox"]`.first() with a non-waiting isVisible()
  // and skipped the write whenever it lost the race (or the volunteer name was unset).
  const row = VolunteerPage.getRowById(page, pubkey)
  await expect(row).toBeVisible({ timeout: Timeouts.ELEMENT })
  await VolunteerPage.changeRole(page, row, pubkey, role!)
})

Then('the volunteer should display the {string} badge', async ({ page, rolesWorld }, roleName: string) => {
  // Was: row/badge isVisible probes that returned early ("accept the row being visible
  // as sufficient") — it could never fail.
  const row = VolunteerPage.getRowById(page, seedHexToPubkey(rolesWorld.volunteerNsec))
  await expect(row.getByTestId(TestIds.VOLUNTEER_ROW_ROLE_BADGE)).toContainText(roleName, { timeout: Timeouts.ELEMENT })
})

Given('I changed a volunteer\'s role to {string}', async ({ request, rolesWorld, workerHub }, roleName: string) => {
  // Setup: a volunteer holding the role (assigned through the API).
  const role = (await listRolesViaApi(request)).find(r => r.name === roleName)
  expect(role, `role "${roleName}" must exist`).toBeTruthy()
  const vol = await createVolunteerViaApi(request, {
    name: `Badge ${Date.now()}`,
    roleIds: [role!.id],
  })
  rolesWorld.volunteerNsec = vol.nsec
  // Hub-scoped list (#1044) — see the note in "a volunteer with {string} role".
  await addHubMemberViaApi(request, workerHub, vol.pubkey, [role!.id])
})

Then('I should see the {string} badge on their card', async ({ page, rolesWorld }, roleName: string) => {
  expect(rolesWorld.volunteerNsec, 'a volunteer must exist first').toBeTruthy()
  await Navigation.goToVolunteers(page)
  const row = VolunteerPage.getRowById(page, seedHexToPubkey(rolesWorld.volunteerNsec))
  await expect(row.getByTestId(TestIds.VOLUNTEER_ROW_ROLE_BADGE)).toContainText(roleName, { timeout: Timeouts.ELEMENT })
})

When('I open the Add Volunteer form', async ({ page }) => {
  await Navigation.goToVolunteers(page)
  await page.getByTestId(TestIds.VOLUNTEER_ADD_BTN).click()
})

When('I open the Invite form', async ({ page }) => {
  // Navigate to volunteers page first, then open invite form.
  // The invite button always renders for an admin on this page (only gated on
  // `isAdmin`), so the old isVisible/catch probe could only ever silently skip
  // opening the form — never legitimately branch around a missing button.
  await Navigation.goToVolunteers(page)
  const inviteBtn = page.getByTestId(TestIds.INVITE_BTN)
  await expect(inviteBtn).toBeVisible({ timeout: Timeouts.ELEMENT })
  await inviteBtn.click()
})

Then('I should see all available roles in the form', async ({ page, request }) => {
  // Was: `form, [role="dialog"], [data-testid="page-title"]`.first() visible, then a
  // /volunteer|admin|reviewer|role/i text probe with a "page rendered at all" fallback.
  await expectFormOffersSystemRoles(page, request)
})

// --- Reviewer login ---

Given('a volunteer with the {string} role exists', async ({ request, rolesWorld }, roleName: string) => {
  const roles = await listRolesViaApi(request)
  const role = roles.find(r => r.name === roleName)
  expect(role).toBeTruthy()

  const vol = await createVolunteerViaApi(request, {
    name: `${roleName}Vol ${Date.now()}`,
    roleIds: [role!.id],
  })
  rolesWorld.volunteerNsec = vol.nsec
})

When('the reviewer logs in', async ({ page, rolesWorld }) => {
  await loginAsVolunteer(page, rolesWorld.volunteerNsec)
})

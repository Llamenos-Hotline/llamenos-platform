/**
 * Role management step definitions.
 * Matches steps from: packages/test-specs/features/admin/roles.feature
 *
 * Behavioral depth: Role CRUD verified via API, permission enforcement tested
 * with real Schnorr-authenticated calls. Zero empty step bodies.
 */
import { expect } from '@playwright/test'
import { Given, When, Then } from '../fixtures'
import { TestIds } from '../../test-ids'
import { Timeouts } from '../../helpers'
import { VolunteerPage } from '../../pages/index'
import {
  apiPost,
  listRolesViaApi,
  findNamedRole,
  createRoleViaApi,
  deleteRoleViaApi,
  updateRoleViaApi,
  getPermissionsCatalogViaApi,
  seedHexToPubkey,
} from '../../api-helpers'

/** Pubkey of the volunteer created by the "a volunteer exists" step (seed stashed on window). */
async function existingVolunteerPubkey(page: import('@playwright/test').Page): Promise<string> {
  const seed = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__test_vol_nsec)) as string | undefined
  expect(seed, 'a volunteer must exist first (see "a volunteer exists")').toBeTruthy()
  return seedHexToPubkey(seed!)
}

When('I request the roles list', async ({ request, rolesWorld }) => {
  // The Then steps for this scenario verify entirely via API (rolesWorld.cachedRoles) —
  // there is no UI assertion downstream, so no UI navigation is needed here. The removed
  // branch clicked a `getByRole('button', { name: /roles/i })` that raced page load and,
  // even when it fired, verified nothing.
  rolesWorld.cachedRoles = await listRolesViaApi(request)
})

Then('I should see at least {int} roles', async ({ rolesWorld }, count: number) => {
  // API verification: at least 'count' roles exist
  // UI may not have role-row elements yet (roles admin page is API-driven)
  expect(rolesWorld.cachedRoles.length).toBeGreaterThanOrEqual(count)
})

Then('I should see {string} role', async ({ rolesWorld }, roleName: string) => {
  // API verification — roles page UI may not have role-row elements
  const found = rolesWorld.cachedRoles.find(r => r.name === roleName)
  expect(found).toBeTruthy()
})

Then('the {string} role should have wildcard permission', async ({ request, rolesWorld }, roleName: string) => {
  // Re-fetch if needed
  if (rolesWorld.cachedRoles.length === 0) {
    rolesWorld.cachedRoles = await listRolesViaApi(request)
  }
  const role = rolesWorld.cachedRoles.find(r => r.name === roleName)
  expect(role).toBeTruthy()
  expect(role!.permissions).toContain('*')
})

Then('the {string} role should be a system role', async ({ request, rolesWorld }, roleName: string) => {
  if (rolesWorld.cachedRoles.length === 0) {
    rolesWorld.cachedRoles = await listRolesViaApi(request)
  }
  const role = rolesWorld.cachedRoles.find(r => r.name === roleName)
  expect(role).toBeTruthy()
  expect(role!.isSystem).toBe(true)
})

Then('the {string} role should be the default role', async ({ request, rolesWorld }, roleName: string) => {
  if (rolesWorld.cachedRoles.length === 0) {
    rolesWorld.cachedRoles = await listRolesViaApi(request)
  }
  const role = rolesWorld.cachedRoles.find(r => r.name === roleName)
  expect(role).toBeTruthy()
  expect(role!.isDefault).toBe(true)
})

When('I create a custom role {string} with permissions', async ({ request, rolesWorld }, _roleName: string) => {
  // The API write is the real, verified write; any failure fails the step.
  // The name is not sent: a role's name is sealed (#2780), and a platform role
  // created without envelopes simply has none. No UI branch: TestIds.ROLE_CREATE_BTN
  // ('role-create-btn') never matches real DOM, so it never fired.
  const role = await createRoleViaApi(request, {
    permissions: ['calls:read', 'calls:list'],
  })
  rolesWorld.lastCreatedRoleId = role.id
})

Then('the role should be created successfully', async ({ request, rolesWorld }) => {
  // Verify via API that the role exists
  const roles = await listRolesViaApi(request)
  const found = roles.find(r => r.id === rolesWorld.lastCreatedRoleId)
  expect(found).toBeTruthy()
})

Then('the role\'s slug should not reveal its name', async ({ request, rolesWorld }) => {
  const roles = await listRolesViaApi(request)
  const found = roles.find(r => r.id === rolesWorld.lastCreatedRoleId)
  expect(found).toBeTruthy()
  // A custom role's slug is its id — never a label derived from the name.
  expect(found!.slug).toBe(found!.id)
  expect(found!.name).toBeNull()
})

Given('a custom role {string} exists', async ({ request, rolesWorld }, _roleName: string) => {
  // A failed create must fail the Given — the old catch left lastCreatedRoleId empty, which
  // made the following delete/update steps silently skip their writes. Each scenario
  // creates its own: a custom role has no name-derived slug to find an earlier one by.
  const role = await createRoleViaApi(request, {
    permissions: ['calls:read'],
  })
  rolesWorld.lastCreatedRoleId = role.id
})

When('I delete the {string} role', async ({ request, rolesWorld }, _roleName: string) => {
  // Delete via API — the real, verified write.
  // No UI branch: TestIds.ROLE_ROW ('role-row') / ROLE_DELETE_BTN ('role-delete-btn')
  // never match real DOM (roles rendered as `role-item-${slug}` / `role-delete-${slug}`
  // in platform-roles-section.tsx, and with no testid at all in the hub roles-section.tsx),
  // so this branch never fired and the Then step verifies via API only.
  expect(rolesWorld.lastCreatedRoleId, 'a custom role must exist first').toBeTruthy()
  const result = await deleteRoleViaApi(request, rolesWorld.lastCreatedRoleId)
  expect(result.status).toBe(200)
})

Then('the role should be removed', async ({ request, rolesWorld }) => {
  // API verification: role is gone
  const roles = await listRolesViaApi(request)
  const found = roles.find(r => r.id === rolesWorld.lastCreatedRoleId)
  expect(found).toBeUndefined()
})

When('I attempt to delete the {string} role', async ({ request }, roleName: string) => {
  // Find the system role
  const roles = await listRolesViaApi(request)
  const systemRole = roles.find(r => r.name === roleName && r.isSystem)
  expect(systemRole).toBeTruthy()

  // Attempt deletion — should fail with 403
  const result = await deleteRoleViaApi(request, systemRole!.id)
  // Store for next step
  await Promise.resolve() // ensure async chain
  ;(globalThis as Record<string, unknown>).__test_delete_status = result.status
})

Then('the deletion should fail with a {int} error', async () => {
  const status = (globalThis as Record<string, unknown>).__test_delete_status as number
  expect(status).toBe(403)
})

When('I assign the {string} role to the volunteer', async ({ page, request }, roleName: string) => {
  // The old probe chain (an "assign" button, then a native <select>) matched neither:
  // users.tsx renders role changes as a Radix Select, so both isVisible() checks silently
  // returned false and no role was ever assigned. Drive the real control on the row of the
  // volunteer created by "a volunteer exists", and wait for the PATCH to succeed.
  const pubkey = await existingVolunteerPubkey(page)
  const roles = await listRolesViaApi(request)
  const targetRole = findNamedRole(roles, roleName)
  expect(targetRole, `role "${roleName}" must exist`).toBeTruthy()

  const volunteerRow = VolunteerPage.getRowById(page, pubkey)
  await expect(volunteerRow).toBeVisible({ timeout: Timeouts.ELEMENT })
  await VolunteerPage.changeRole(page, volunteerRow, pubkey, targetRole!)
})

Then('the volunteer should have the {string} role', async ({ page }, roleName: string) => {
  // Scoped to the specific volunteer's row badge. The old version passed as soon as ANY
  // row contained the role name, and otherwise fell back to "any row is visible".
  const pubkey = await existingVolunteerPubkey(page)
  const volunteerRow = VolunteerPage.getRowById(page, pubkey)
  await expect(volunteerRow.getByTestId(TestIds.VOLUNTEER_ROW_ROLE_BADGE)).toContainText(roleName, { timeout: Timeouts.ELEMENT })
})

When('I request the {string} role details', async ({ request, rolesWorld }, roleName: string) => {
  rolesWorld.cachedRoles = await listRolesViaApi(request)
  const role = rolesWorld.cachedRoles.find(r => r.name === roleName)
  expect(role).toBeTruthy()
  ;(globalThis as Record<string, unknown>).__test_inspected_role = role
})

Then('it should have {string} permission', async ({}, permission: string) => {
  const role = (globalThis as Record<string, unknown>).__test_inspected_role as { permissions: string[] } | undefined
  expect(role).toBeTruthy()
  expect(role!.permissions).toContain(permission)
})

Then('it should not have {string} permission', async ({}, permission: string) => {
  const role = (globalThis as Record<string, unknown>).__test_inspected_role as { permissions: string[] } | undefined
  expect(role).toBeTruthy()
  expect(role!.permissions).not.toContain(permission)
})

// --- Feature file steps that need additional coverage ---

When('I create a role with the plaintext name {string}', async ({ request }, name: string) => {
  // Submit a plaintext name to the real endpoint and record the answer. The server
  // must refuse it outright — silently dropping it would leave a client believing
  // the name was kept (#2780).
  const { status } = await apiPost(request, '/settings/roles', {
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    permissions: ['calls:read'],
    description: `${name} role`,
  })
  ;(globalThis as Record<string, unknown>).__test_role_create_status = status
})

Then('the server should refuse the plaintext role name', async () => {
  const status = (globalThis as Record<string, unknown>).__test_role_create_status as number
  expect(status).toBe(400)
})

When('I update the role permissions', async ({ request, rolesWorld }) => {
  expect(rolesWorld.lastCreatedRoleId, 'a custom role must exist first').toBeTruthy()
  await updateRoleViaApi(request, rolesWorld.lastCreatedRoleId, {
    permissions: ['calls:read', 'calls:list', 'notes:read'],
  })
})

Then('the permissions should be updated', async ({ request, rolesWorld }) => {
  const roles = await listRolesViaApi(request)
  const role = roles.find(r => r.id === rolesWorld.lastCreatedRoleId)
  expect(role).toBeTruthy()
  expect(role!.permissions).toContain('notes:read')
})

When('I request the permissions catalog', async ({ request }) => {
  const catalog = await getPermissionsCatalogViaApi(request)
  ;(globalThis as Record<string, unknown>).__test_permissions_catalog = catalog
})

Then('I should see all available permissions grouped by domain', async () => {
  const catalog = (globalThis as Record<string, unknown>).__test_permissions_catalog as {
    byDomain: Record<string, Array<{ key: string; label: string }>>
  }
  expect(catalog).toBeTruthy()
  const domains = Object.keys(catalog.byDomain)
  expect(domains.length).toBeGreaterThan(0)
  // Should have at least volunteers, notes, calls domains
  expect(domains.some(d => d.includes('volunteer') || d.includes('notes') || d.includes('calls'))).toBe(true)
})

When('I attempt to delete a role that does not exist', async ({ request }) => {
  const result = await deleteRoleViaApi(request, 'nonexistent-role-id-12345')
  ;(globalThis as Record<string, unknown>).__test_delete_status = result.status
})

Then('I should receive a not found error', async () => {
  const status = (globalThis as Record<string, unknown>).__test_delete_status as number
  expect(status).toBe(404)
})

/**
 * Backend BDD steps: a hub's role vocabulary is sealed at rest (#2780).
 *
 * Every assertion that matters reads the `roles` row straight from PostgreSQL.
 * The name is sealed with a key this test generates — standing in for the hub
 * key, which in production only the hub's member devices hold — in the
 * `encrypt_hub_field` wire format the desktop, iOS and Android clients use. The
 * server never sees the key, so "the stored value opens to the name with the
 * key" proves the row holds the sealed value, and "no plaintext column holds
 * it" proves nothing else does.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import {
  apiPatch,
  apiPost,
  createHubViaApi,
  createUserViaApi,
  deleteHubViaApi,
  listHubRolesViaApi,
  listRolesViaApi,
  uniqueName,
} from '../../api-helpers'
import { decryptContent, encryptContent, generateContentKey } from '../../crypto-helpers'
import { TestDB } from '../../db-helpers'
import { LABEL_HUB_ROLE_ENCRYPT, LABEL_TAG_ENCRYPT } from '@shared/crypto-labels'

interface RoleVocabularyState {
  hubKey: Uint8Array
  roleId?: string
  sealedName?: string
  name?: string
  description?: string
  secondHubId?: string
}

const STATE_KEY = 'roleVocabulary'

function s(world: Record<string, unknown>): RoleVocabularyState {
  const existing = getState<RoleVocabularyState>(world, STATE_KEY)
  if (existing) return existing
  const fresh: RoleVocabularyState = { hubKey: generateContentKey() }
  setState(world, STATE_KEY, fresh)
  return fresh
}

async function createSealedHubRole(
  request: Parameters<typeof apiPost>[0],
  world: Record<string, unknown>,
  hubId: string,
  name: string,
  description: string | undefined,
  permissions: string[],
): Promise<{ status: number; data: { id?: string } }> {
  const st = s(world)
  const sealedName = encryptContent(name, st.hubKey, LABEL_HUB_ROLE_ENCRYPT)
  const res = await apiPost<{ id?: string }>(request, `/hubs/${hubId}/settings/roles`, {
    permissions,
    encryptedName: sealedName,
    ...(description ? { encryptedDescription: encryptContent(description, st.hubKey, LABEL_HUB_ROLE_ENCRYPT) } : {}),
  })
  if (res.status === 201) {
    st.roleId = res.data.id
    st.sealedName = sealedName
    st.name = name
    st.description = description
  }
  return res
}

When(
  'the admin creates a hub role named {string} described as {string}, sealed under the hub key',
  async ({ request, world, workerHub }, name: string, description: string) => {
    setLastResponse(world, await createSealedHubRole(request, world, workerHub, name, description, ['calls:answer', 'notes:create']))
  },
)

Given('the admin has created a sealed hub role', async ({ request, world, workerHub }) => {
  const res = await createSealedHubRole(request, world, workerHub, 'Rapid response driver', undefined, ['calls:answer'])
  expect(res.status, JSON.stringify(res.data)).toBe(201)
})

When('the admin creates a sealed hub role granting {string}', async ({ request, world, workerHub }, permission: string) => {
  setLastResponse(world, await createSealedHubRole(request, world, workerHub, 'Instance operator', undefined, [permission]))
})

Then('the stored role has no plaintext name, description or name-derived slug', async ({ world, workerHub }) => {
  const st = s(world)
  expect(st.roleId, 'a hub role must have been created').toBeTruthy()
  const row = await TestDB.getRow('roles', st.roleId!)
  expect(row, `roles row ${st.roleId}`).not.toBeNull()
  expect(row!.name).toBeNull()
  expect(row!.description).toBe('')
  expect(row!.slug).toBe(st.roleId)
  expect(row!.hub_id).toBe(workerHub)
  // No column of the row — whatever is added later — carries the vocabulary.
  const serialised = JSON.stringify(row).toLowerCase()
  for (const plaintext of [st.name!, st.description!]) {
    expect(serialised).not.toContain(plaintext.toLowerCase())
    expect(serialised).not.toContain(plaintext.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  }
})

Then('the stored role\'s sealed name opens to {string} only with the hub key', async ({ world }, name: string) => {
  const st = s(world)
  const row = await TestDB.getRow('roles', st.roleId!)
  const stored = row!.encrypted_name as string
  expect(stored).toBe(st.sealedName)
  expect(decryptContent(stored, st.hubKey, LABEL_HUB_ROLE_ENCRYPT)).toBe(name)
  // Domain separation: the same key under another label does not open it.
  expect(() => decryptContent(stored, st.hubKey, LABEL_TAG_ENCRYPT)).toThrow()
  // And another key does not open it at all.
  expect(() => decryptContent(stored, generateContentKey(), LABEL_HUB_ROLE_ENCRYPT)).toThrow()
  const description = row!.encrypted_description as string
  expect(decryptContent(description, st.hubKey, LABEL_HUB_ROLE_ENCRYPT)).toBe(st.description)
})

When('the admin creates a hub role with the plaintext name {string}', async ({ request, world, workerHub }, name: string) => {
  setLastResponse(world, await apiPost(request, `/hubs/${workerHub}/settings/roles`, {
    name,
    permissions: ['calls:answer'],
    encryptedName: encryptContent(name, s(world).hubKey, LABEL_HUB_ROLE_ENCRYPT),
  }))
})

When('the admin creates a platform role with the plaintext name {string}', async ({ request, world }, name: string) => {
  setLastResponse(world, await apiPost(request, '/settings/roles', {
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: `${name} role`,
    permissions: ['calls:answer'],
  }))
})

Given('another hub the role does not belong to exists', async ({ request, world }) => {
  const id = await createHubViaApi(request, uniqueName('bdd-role-vocab-b'))
  s(world).secondHubId = id
})

Then('the role is not listed by the second hub or by the deployment', async ({ request, world, workerHub }) => {
  const st = s(world)
  try {
    const own = await listHubRolesViaApi(request, workerHub)
    expect(own.map(r => r.id), 'the owning hub lists its role').toContain(st.roleId)
    const other = await listHubRolesViaApi(request, st.secondHubId!)
    expect(other.map(r => r.id)).not.toContain(st.roleId)
    const deployment = await listRolesViaApi(request)
    expect(deployment.map(r => r.id)).not.toContain(st.roleId)
  } catch (err) {
    await deleteHubViaApi(request, st.secondHubId!)
    throw err
  }
})

When('the admin grants the role to a member of the second hub', async ({ request, world }) => {
  const st = s(world)
  const user = await createUserViaApi(request, { hubId: st.secondHubId! })
  const res = await apiPost(request, `/hubs/${st.secondHubId}/members`, { pubkey: user.pubkey, roleIds: [st.roleId] })
  setLastResponse(world, res)
})

When('the admin grants the role to a user as a global role', async ({ request, world }) => {
  const st = s(world)
  const user = await createUserViaApi(request, { hubId: st.secondHubId! })
  const res = await apiPatch(request, `/users/${user.pubkey}`, { roles: [st.roleId] })
  setLastResponse(world, res)
  await deleteHubViaApi(request, st.secondHubId!)
})

When('the admin asks the server to create roles from a template', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/settings/cms/roles/from-template', {
    roles: [{ name: 'Legal observer', slug: 'legal-observer', description: 'Observes', permissions: ['calls:answer'] }],
  }))
})

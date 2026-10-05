/**
 * Data isolation step definitions (Epic 365).
 *
 * Tests that users can only see their own resources, that hub-scoped
 * data does not leak across hubs, and that role changes / deactivation
 * take immediate effect.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  apiGet,
  apiPost,
  apiPatch,
  createVolunteerViaApi,
  createUserViaApi,
  createReportViaApi,
  listRecordsViaApi,
  createRecordViaApi,
  enableCaseManagementViaApi,
  createEntityTypeViaApi,
  testEndpointAccess,
  encryptForTest,
  createHubViaApi,
  addHubMemberViaApi,
  ADMIN_SEED,
  type CreateVolunteerResult,
} from '../../api-helpers'

// ── Local State ────────────────────────────────────────────────────

interface UserWithResources {
  name: string
  deviceKey: string
  pubkey: string
  noteIds: string[]
  reportIds: string[]
  recordIds: string[]
}

interface DedicatedHubInfo {
  hubId: string
  memberName: string
}

interface IsolationState {
  users: Map<string, UserWithResources>
  entityTypeId?: string
  /** Stores the last list result per user for Then assertions. */
  listResults: Map<string, { notes?: string[]; reports?: string[]; records?: string[] }>
  /** For role-change scenarios */
  volunteer?: CreateVolunteerResult & { roles?: string[] }
  roleChangeResponse?: number
  /** For deactivation scenarios */
  deactivatedVol?: CreateVolunteerResult
  deactivationResponses: Map<string, number>
  /** For direct-patch isolation scenario */
  lastUpdateStatus?: number
  /** For admin-sees-all-notes scenario */
  adminListResult?: string[]
  /** For cross-hub isolation scenarios */
  dedicatedHubs: Map<string, DedicatedHubInfo>
  lastHubAccessStatus?: number
  dedicatedHubListResult?: string[]
}

const DATA_ISOLATION_KEY = 'data_isolation'

function getIsolationState(world: Record<string, unknown>): IsolationState {
  return getState<IsolationState>(world, DATA_ISOLATION_KEY)
}


Before({ tags: '@security or @permissions' }, async ({ world }) => {
  const iso: IsolationState = {
    users: new Map(),
    listResults: new Map(),
    deactivationResponses: new Map(),
    dedicatedHubs: new Map(),
  }
  setState(world, DATA_ISOLATION_KEY, iso)
})

// ── Helpers ────────────────────────────────────────────────────────

async function ensureEntityType(
  request: import('@playwright/test').APIRequestContext,
  world: Record<string, unknown>,
): Promise<string> {
  const isoState = getIsolationState(world)
  if (isoState.entityTypeId) return isoState.entityTypeId
  await enableCaseManagementViaApi(request, true)
  const hubId = getScenarioState(world).hubId
  const et = await createEntityTypeViaApi(request, {
    name: `isolation_case_${Date.now()}`,
    hubId,
  })
  isoState.entityTypeId = et.id as string
  return et.id as string
}

// ── Parameterized: <role> can only see their own <resource> ───────

Given(
  'a {string} user {string} with resources',
  async ({ request, world }, role: string, name: string) => {
    // Create volunteer with given role
    const vol = await createVolunteerViaApi(request, {
      name: `${name} ${Date.now()}`,
    })

    // Assign the right role — use role IDs (not slugs)
    if (role === 'reporter') {
      await apiPatch(request, `/users/${vol.pubkey}`, { roles: ['role-reporter'] })
    } else if (role === 'volunteer') {
      // Default role is volunteer — no change needed
    }

    const user: UserWithResources = {
      name,
      deviceKey: vol.deviceKey,
      pubkey: vol.pubkey,
      noteIds: [],
      reportIds: [],
      recordIds: [],
    }

    // Create resources as this user
    if (role === 'volunteer') {
      // Create a note with real AES-256-GCM encryption
      const { encryptedContent: noteContent, envelopes: noteEnvelopes } = await encryptForTest(
        `${name}'s note`,
        [vol.seedHex, ADMIN_SEED],
      )
      const noteRes = await apiPost<{ note?: { id?: string }; id?: string }>(
        request,
        '/notes',
        {
          encryptedContent: noteContent,
          callId: `iso-${Date.now()}-${name}`,
          adminEnvelopes: noteEnvelopes,
        },
        vol.deviceKey,
      )
      if (noteRes.status === 200 || noteRes.status === 201) {
        const noteId = noteRes.data.note?.id ?? noteRes.data.id
        if (noteId) user.noteIds.push(noteId)
      }

      // Create a record (if CMS enabled)
      try {
        const etId = await ensureEntityType(request, world)
        const rec = await createRecordViaApi(request, etId, {}, vol.deviceKey)
        if ((rec as { id?: string }).id) {
          user.recordIds.push((rec as { id: string }).id)
        }
      } catch {
        // CMS may not be enabled — skip
      }
    }

    if (role === 'reporter') {
      // Create a report authenticated as this reporter so the server records their
      // pubkey as the author — required for reporter-isolation filter in GET /reports
      const report = await createReportViaApi(request, {
        title: `${name}'s report ${Date.now()}`,
        seedHex: vol.deviceKey,
      })
      user.reportIds.push(report.id)
    }

    getIsolationState(world).users.set(name, user)
  },
)

When('{string} lists their {word}', async ({ request, world }, name: string, resource: string) => {
  const user = getIsolationState(world).users.get(name)
  expect(user).toBeTruthy()

  const results: { notes?: string[]; reports?: string[]; records?: string[] } = {}

  if (resource === 'note' || resource === 'notes') {
    const { status, data } = await apiGet<{ notes: Array<{ id: string }> }>(
      request,
      '/notes',
      user!.deviceKey,
    )
    results.notes = status === 200 ? data.notes.map(n => n.id) : []
  }

  if (resource === 'report' || resource === 'reports') {
    const { status, data } = await apiGet<{ conversations: Array<{ id: string }> }>(
      request,
      '/reports',
      user!.deviceKey,
    )
    results.reports = status === 200 ? data.conversations.map(r => r.id) : []
  }

  if (resource === 'record' || resource === 'records') {
    try {
      const data = await listRecordsViaApi(request, {}, user!.deviceKey)
      results.records = data.records.map(r => (r as { id: string }).id)
    } catch {
      results.records = []
    }
  }

  getIsolationState(world).listResults.set(name, results)
})

Then('{string} should only see resources they created', async ({ world }, name: string) => {
  const user = getIsolationState(world).users.get(name)
  expect(user).toBeTruthy()
  const results = getIsolationState(world).listResults.get(name)
  expect(results).toBeTruthy()

  // Every returned ID should belong to the user
  if (results!.notes) {
    for (const noteId of results!.notes) {
      expect(user!.noteIds).toContain(noteId)
    }
  }
  if (results!.reports) {
    for (const reportId of results!.reports) {
      expect(user!.reportIds).toContain(reportId)
    }
  }
  if (results!.records && results!.records.length > 0) {
    for (const recordId of results!.records) {
      expect(user!.recordIds).toContain(recordId)
    }
  }
})

Then(
  "{string}'s {word} should not be visible to {string}",
  async ({ world }, otherName: string, resource: string, viewerName: string) => {
    const other = getIsolationState(world).users.get(otherName)
    expect(other).toBeTruthy()
    const results = getIsolationState(world).listResults.get(viewerName)
    expect(results).toBeTruthy()

    if (resource === 'note' || resource === 'notes') {
      for (const noteId of other!.noteIds) {
        expect(results!.notes ?? []).not.toContain(noteId)
      }
    }
    if (resource === 'report' || resource === 'reports') {
      for (const reportId of other!.reportIds) {
        expect(results!.reports ?? []).not.toContain(reportId)
      }
    }
    if (resource === 'record' || resource === 'records') {
      for (const recordId of other!.recordIds) {
        expect(results!.records ?? []).not.toContain(recordId)
      }
    }
  },
)

// ── Hub-Scoped Isolation ──────────────────────────────────────────

Given(
  'hub {string} with a volunteer {string}',
  async ({ request, world }, _hubName: string, volName: string) => {
    const vol = await createVolunteerViaApi(request, {
      name: `${volName} ${Date.now()}`,
    })
    getIsolationState(world).users.set(volName, {
      name: volName,
      deviceKey: vol.deviceKey,
      pubkey: vol.pubkey,
      noteIds: [],
      reportIds: [],
      recordIds: [],
    })
  },
)

When(
  '{string} creates a note in hub {string}',
  async ({ request, world }, volName: string, _hubName: string) => {
    const user = getIsolationState(world).users.get(volName)
    expect(user).toBeTruthy()
    const { encryptedContent: hubNoteContent, envelopes: hubNoteEnvelopes } = await encryptForTest(
      `${volName}'s hub note`,
      [user!.deviceKey, ADMIN_SEED],
    )
    const res = await apiPost<{ note?: { id?: string }; id?: string }>(
      request,
      '/notes',
      {
        encryptedContent: hubNoteContent,
        callId: `hub-iso-${Date.now()}-${volName}`,
        adminEnvelopes: hubNoteEnvelopes,
      },
      user!.deviceKey,
    )
    if (res.status === 200 || res.status === 201) {
      const noteId = res.data.note?.id ?? res.data.id
      if (noteId) user!.noteIds.push(noteId)
    }
  },
)

Then(
  '{string} should not see notes from hub {string}',
  async ({ request, world }, viewerName: string, _hubName: string) => {
    const viewer = getIsolationState(world).users.get(viewerName)
    expect(viewer).toBeTruthy()

    const { status, data } = await apiGet<{ notes: Array<{ id: string }> }>(
      request,
      '/notes',
      viewer!.deviceKey,
    )
    expect(status).toBe(200)

    // Get all note IDs belonging to OTHER users
    const otherNoteIds: string[] = []
    for (const [name, user] of getIsolationState(world).users) {
      if (name !== viewerName) {
        otherNoteIds.push(...user.noteIds)
      }
    }

    const visibleIds = data.notes.map(n => n.id)
    for (const otherId of otherNoteIds) {
      expect(visibleIds).not.toContain(otherId)
    }
  },
)

// ── Role Change Enforcement ───────────────────────────────────────

Given('a volunteer with role {string}', async ({ request, world }, role: string) => {
  const vol = await createVolunteerViaApi(request, {
    name: `Role Change Vol ${Date.now()}`,
  })
  // Set the initial role
  await apiPatch(request, `/users/${vol.pubkey}`, { roles: [role] })
  getIsolationState(world).volunteer = { ...vol, roles: [role] }
})

When(
  "an admin changes the volunteer's role to {string}",
  async ({ request, world }, newRole: string) => {
    expect(getIsolationState(world).volunteer).toBeTruthy()
    await apiPatch(request, `/users/${getIsolationState(world).volunteer!.pubkey}`, {
      roles: [newRole],
    })
    getIsolationState(world).volunteer!.roles = [newRole]
  },
)

When(
  'the volunteer makes a request requiring {string} permissions',
  async ({ request, world }, oldRole: string) => {
    expect(getIsolationState(world).volunteer).toBeTruthy()
    // hub-admin can list volunteers; volunteer cannot
    // Use an endpoint that the old role had access to
    let endpoint = '/users'
    if (oldRole === 'hub-admin') {
      endpoint = '/users'
    } else if (oldRole === 'reviewer') {
      endpoint = '/notes' // reviewers can list notes
    }
    getIsolationState(world).roleChangeResponse = await testEndpointAccess(
      request,
      'GET',
      endpoint,
      getIsolationState(world).volunteer!.deviceKey,
    )
  },
)

Then(
  'the response status should reflect the {string} role permissions',
  async ({ world }, newRole: string) => {
    expect(getIsolationState(world).roleChangeResponse).toBeDefined()
    if (newRole === 'volunteer' || newRole === 'reporter') {
      // Volunteers and reporters cannot list volunteers (requires admin perm)
      expect(getIsolationState(world).roleChangeResponse).toBe(403)
    } else {
      expect(getIsolationState(world).roleChangeResponse).toBe(200)
    }
  },
)

// ── Deactivation Enforcement ──────────────────────────────────────

Given('an active volunteer with notes and shift access', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, {
    name: `Deactivation Vol ${Date.now()}`,
  })
  // Create a note as the volunteer with real encryption
  const { encryptedContent: deactContent, envelopes: deactEnvelopes } = await encryptForTest(
    'deactivation test note',
    [vol.seedHex, ADMIN_SEED],
  )
  await apiPost(
    request,
    '/notes',
    {
      encryptedContent: deactContent,
      callId: `deact-${Date.now()}`,
      adminEnvelopes: deactEnvelopes,
    },
    vol.deviceKey,
  )
  getIsolationState(world).deactivatedVol = vol
})

When('an admin deactivates the volunteer', async ({ request, world }) => {
  expect(getIsolationState(world).deactivatedVol).toBeTruthy()
  await apiPatch(request, `/users/${getIsolationState(world).deactivatedVol!.pubkey}`, {
    active: false,
  })
})

Then(
  'the volunteer should receive {int} when listing notes',
  async ({ request, world }, expectedStatus: number) => {
    expect(getIsolationState(world).deactivatedVol).toBeTruthy()
    const status = await testEndpointAccess(
      request,
      'GET',
      '/notes',
      getIsolationState(world).deactivatedVol!.deviceKey,
    )
    expect(status).toBe(expectedStatus)
  },
)

Then(
  'the volunteer should receive {int} when listing shifts',
  async ({ request, world }, expectedStatus: number) => {
    expect(getIsolationState(world).deactivatedVol).toBeTruthy()
    const status = await testEndpointAccess(
      request,
      'GET',
      '/shifts',
      getIsolationState(world).deactivatedVol!.deviceKey,
    )
    expect(status).toBe(expectedStatus)
  },
)

Then(
  'the volunteer should receive {int} when accessing their profile',
  async ({ request, world }, expectedStatus: number) => {
    expect(getIsolationState(world).deactivatedVol).toBeTruthy()
    const status = await testEndpointAccess(
      request,
      'GET',
      '/auth/me',
      getIsolationState(world).deactivatedVol!.deviceKey,
    )
    expect(status).toBe(expectedStatus)
  },
)

// ── Direct Note Mutation by Non-Author ────────────────────────────

When(
  '{string} tries to update {string}\'s note',
  async ({ request, world }, actorName: string, targetName: string) => {
    const actor = getIsolationState(world).users.get(actorName)
    const target = getIsolationState(world).users.get(targetName)
    expect(actor, `actor "${actorName}" not found`).toBeTruthy()
    expect(target, `target "${targetName}" not found`).toBeTruthy()
    expect(target!.noteIds.length, `"${targetName}" has no notes to target`).toBeGreaterThan(0)

    const noteId = target!.noteIds[0]
    const { encryptedContent } = await encryptForTest('tampered content by non-author', [actor!.deviceKey])
    const status = await testEndpointAccess(
      request,
      'PATCH',
      `/notes/${noteId}`,
      actor!.deviceKey,
      { encryptedContent },
    )
    getIsolationState(world).lastUpdateStatus = status
  },
)

Then('the note update should be rejected with {int}', async ({ world }, expectedStatus: number) => {
  expect(getIsolationState(world).lastUpdateStatus).toBe(expectedStatus)
})

// ── Admin Reads All Notes; Volunteers Read Only Their Own ─────────

When('the admin lists all notes', async ({ request, world }) => {
  const { status, data } = await apiGet<{ notes: Array<{ id: string }> }>(
    request,
    '/notes',
    ADMIN_SEED,
  )
  expect(status).toBe(200)
  getIsolationState(world).adminListResult = data.notes.map(n => n.id)
})

Then('the admin should see notes from {string}', async ({ world }, name: string) => {
  const user = getIsolationState(world).users.get(name)
  expect(user, `user "${name}" not found`).toBeTruthy()
  const adminNotes = getIsolationState(world).adminListResult
  expect(adminNotes, 'admin note list not populated').toBeTruthy()

  for (const noteId of user!.noteIds) {
    expect(adminNotes, `admin list missing note ${noteId} from "${name}"`).toContain(noteId)
  }
})

// ── Cross-Hub Data Isolation ──────────────────────────────────────

Given(
  'volunteer {string} is a member of dedicated hub {string}',
  async ({ request, world }, volName: string, hubLabel: string) => {
    const hubId = await createHubViaApi(request, `bdd-iso-${hubLabel}-${Date.now()}`)

    // Create the volunteer with NO global roles so they only have hub-specific access.
    // This ensures they get 403 when accessing a hub they are not a member of.
    const vol = await createUserViaApi(request, {
      name: `${volName} ${Date.now()}`,
      roleIds: [],
    })
    await addHubMemberViaApi(request, hubId, vol.pubkey, ['role-volunteer'])

    const isoState = getIsolationState(world)
    isoState.users.set(volName, {
      name: volName,
      deviceKey: vol.seedHex,
      pubkey: vol.pubkey,
      noteIds: [],
      reportIds: [],
      recordIds: [],
    })
    isoState.dedicatedHubs.set(hubLabel, { hubId, memberName: volName })
  },
)

When(
  '{string} creates a note in dedicated hub {string}',
  async ({ request, world }, volName: string, hubLabel: string) => {
    const user = getIsolationState(world).users.get(volName)
    const hubEntry = getIsolationState(world).dedicatedHubs.get(hubLabel)
    expect(user, `user "${volName}" not found`).toBeTruthy()
    expect(hubEntry, `dedicated hub "${hubLabel}" not found`).toBeTruthy()

    const { encryptedContent, envelopes } = await encryptForTest(
      `${volName}'s dedicated hub note`,
      [user!.deviceKey, ADMIN_SEED],
    )
    const res = await apiPost<{ note?: { id?: string }; id?: string }>(
      request,
      `/hubs/${hubEntry!.hubId}/notes`,
      {
        encryptedContent,
        callId: `hub-iso-${Date.now()}-${volName}`,
        adminEnvelopes: envelopes,
      },
      user!.deviceKey,
    )
    if (res.status === 200 || res.status === 201) {
      const noteId = res.data.note?.id ?? res.data.id
      if (noteId) user!.noteIds.push(noteId)
    }
  },
)

Then(
  '{string} cannot see {string} notes when listing dedicated hub {string} notes',
  async ({ request, world }, viewerName: string, otherHubLabel: string, ownHubLabel: string) => {
    const viewer = getIsolationState(world).users.get(viewerName)
    const ownHubEntry = getIsolationState(world).dedicatedHubs.get(ownHubLabel)
    const otherHubEntry = getIsolationState(world).dedicatedHubs.get(otherHubLabel)
    expect(viewer, `viewer "${viewerName}" not found`).toBeTruthy()
    expect(ownHubEntry, `own hub "${ownHubLabel}" not found`).toBeTruthy()
    expect(otherHubEntry, `other hub "${otherHubLabel}" not found`).toBeTruthy()

    const { status, data } = await apiGet<{ notes: Array<{ id: string }> }>(
      request,
      `/hubs/${ownHubEntry!.hubId}/notes`,
      viewer!.deviceKey,
    )
    expect(status, `expected 200 listing own hub "${ownHubLabel}"`).toBe(200)

    // Get the note IDs belonging to the other hub's member
    const otherMemberName = otherHubEntry!.memberName
    const otherUser = getIsolationState(world).users.get(otherMemberName)
    const ownHubNoteIds = data.notes.map(n => n.id)

    for (const otherNoteId of otherUser?.noteIds ?? []) {
      expect(
        ownHubNoteIds,
        `hub "${ownHubLabel}" notes should not contain note ${otherNoteId} from hub "${otherHubLabel}"`,
      ).not.toContain(otherNoteId)
    }
  },
)

Then(
  '{string} cannot see {string}\'s notes when accessing dedicated hub {string} directly',
  async ({ request, world }, viewerName: string, authorName: string, hubLabel: string) => {
    const viewer = getIsolationState(world).users.get(viewerName)
    const author = getIsolationState(world).users.get(authorName)
    const hubEntry = getIsolationState(world).dedicatedHubs.get(hubLabel)
    expect(viewer, `viewer "${viewerName}" not found`).toBeTruthy()
    expect(author, `author "${authorName}" not found`).toBeTruthy()
    expect(hubEntry, `hub "${hubLabel}" not found`).toBeTruthy()

    // The viewer is not a member of this hub, so the hub itself is closed to
    // them — a global role is not hub membership (#1037). Nothing of the
    // author's (not even a filtered list) may come back.
    const { status, data } = await apiGet<{ notes?: Array<{ id: string }> }>(
      request,
      `/hubs/${hubEntry!.hubId}/notes`,
      viewer!.deviceKey,
    )
    expect(status, `expected 403 for non-member ${viewerName} accessing hub ${hubLabel}`).toBe(403)
    expect(data?.notes, `${viewerName} must not receive ${authorName}'s notes from hub "${hubLabel}"`).toBeUndefined()
  },
)

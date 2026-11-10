/**
 * Desktop half of the endpoint contract (#1997): each call below used to hit a
 * route the server does not mount. These assert the method and path the client
 * actually puts on the wire, and — for the recovery group — that a failure is
 * no longer reported as "no recovery group".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActiveHub, ApiError, NoActiveHubError } from './client'
import { getRecoveryGroup } from './recovery'
import { updateDirectoryContact } from './directory'
import { initUpload, completeUpload, getFileEnvelopes } from './files'
import { createRolesFromTemplate } from './cms'
import { archiveReportType, createReportType, getReportTypesAdmin, updateReportType } from './reports'
import { confirmDeletionThroughDialog } from '../admin-deletion.test-helpers'

const registerCredential = vi.hoisted(() => vi.fn())
vi.mock('@/lib/webauthn', () => ({ registerCredential }))

interface RecordedCall {
  method: string
  url: string
}

let calls: RecordedCall[]
let respond: () => Response

beforeEach(() => {
  calls = []
  respond = () => new Response('{}', { status: 200 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({ method: (init.method ?? 'GET').toUpperCase(), url: String(input) })
      return respond()
    }),
  )
  setActiveHub('hub-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveHub(null)
})

describe('recovery group', () => {
  it('reads the unscoped /recovery-group/:hubId route', async () => {
    await getRecoveryGroup('hub-1')
    expect(calls).toEqual([{ method: 'GET', url: '/api/recovery-group/hub-1' }])
  })

  it('maps only the server 404 to "no recovery group"', async () => {
    respond = () => new Response('{"error":"No recovery group configured for this hub"}', { status: 404 })
    await expect(getRecoveryGroup('hub-1')).resolves.toBeNull()
  })

  it.each([403, 500])('lets a %i propagate instead of reporting "no recovery group"', async (status) => {
    respond = () => new Response('{"error":"x"}', { status })
    await expect(getRecoveryGroup('hub-1')).rejects.toMatchObject({ status })
    await expect(getRecoveryGroup('hub-1')).rejects.toBeInstanceOf(ApiError)
  })

  it('lets a transport failure propagate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await expect(getRecoveryGroup('hub-1')).rejects.toThrow()
  })
})

describe('directory', () => {
  it('updates a contact with PATCH, not PUT', async () => {
    await updateDirectoryContact('c-1', {})
    expect(calls).toEqual([{ method: 'PATCH', url: '/api/hubs/hub-1/directory/c-1' }])
  })
})

// Uploads and files exist only under /hubs/:hubId (#2462): a file belongs to the
// hub of what it is attached to, and an unscoped request has no hub to belong to.
describe('files', () => {
  it('starts, completes and reads uploads inside the active hub', async () => {
    await initUpload({ totalSize: 1, totalChunks: 1, owner: { kind: 'entity_field' } })
    await completeUpload('u-1')
    await getFileEnvelopes('f-1')
    expect(calls).toEqual([
      { method: 'POST', url: '/api/hubs/hub-1/uploads/init' },
      { method: 'POST', url: '/api/hubs/hub-1/uploads/u-1/complete' },
      { method: 'GET', url: '/api/hubs/hub-1/files/f-1/envelopes' },
    ])
  })

  it('refuses to upload with no hub selected rather than calling an unscoped route', async () => {
    setActiveHub(null)
    await expect(initUpload({ totalSize: 1, totalChunks: 1, owner: { kind: 'entity_field' } }))
      .rejects.toBeInstanceOf(NoActiveHubError)
    expect(calls).toEqual([])
  })
})

// Deployment-wide settings exist only on the unscoped mount (#2367): a hub
// being active must not move these calls under /hubs/:hubId, where they 404.
describe('deployment-wide settings', () => {
  it('creates roles from a template on the unscoped settings/cms route', async () => {
    await createRolesFromTemplate([])
    expect(calls).toEqual([{ method: 'POST', url: '/api/settings/cms/roles/from-template' }])
  })

  it('reads effective permissions on the unscoped settings route, hub as a query param', async () => {
    // #1101: the desktop derives UI gating from this route. It lives only on the
    // unscoped mount (#2367) — under /hubs/:hubId it does not exist — and the
    // hub is a QUERY parameter, so the active hub must not prefix the path.
    const { getEffectivePermissions } = await import('./users')
    await getEffectivePermissions('pk-1', 'hub-9')
    await getEffectivePermissions('pk-1')
    expect(calls).toEqual([
      { method: 'GET', url: '/api/settings/users/pk-1/effective-permissions?hubId=hub-9' },
      { method: 'GET', url: '/api/settings/users/pk-1/effective-permissions' },
    ])
  })

  it('manages the admin report-type vocabulary on the unscoped settings route', async () => {
    // Archiving takes the admin's confirmation (#2575), obtained from its dialog before
    // the recorded calls start.
    const confirmed = await confirmDeletionThroughDialog('reportCategory', 'rt-1')
    calls = []
    await getReportTypesAdmin()
    await createReportType({ name: 'x' })
    await updateReportType('rt-1', {})
    await archiveReportType('rt-1', confirmed)
    expect(calls).toEqual([
      { method: 'GET', url: '/api/settings/report-types' },
      { method: 'POST', url: '/api/settings/report-types' },
      { method: 'PATCH', url: '/api/settings/report-types/rt-1' },
      { method: 'DELETE', url: '/api/settings/report-types/rt-1' },
    ])
  })
})

describe('passkey registration', () => {
  it('runs the WebAuthn ceremony rather than posting to a /webauthn/register route', async () => {
    const { registerPasskey } = await import('@/lib/queries/devices')
    registerCredential.mockResolvedValue(undefined)

    await registerPasskey('My Phone')

    expect(registerCredential).toHaveBeenCalledWith('My Phone')
    expect(calls).toEqual([])
  })
})

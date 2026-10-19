/**
 * Desktop half of the endpoint contract (#1997): each call below used to hit a
 * route the server does not mount. These assert the method and path the client
 * actually puts on the wire, and — for the recovery group — that a failure is
 * no longer reported as "no recovery group".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActiveHub, ApiError } from './client'
import { getRecoveryGroup } from './recovery'
import { updateDirectoryContact, uploadEntityFile } from './directory'
import { createRolesFromTemplate } from './cms'

const registerCredential = vi.hoisted(() => vi.fn())
vi.mock('@/lib/webauthn', () => ({ registerCredential }))

let calls: { method: string; url: string }[]
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

  it('uploads an entity file to the unscoped route even when a hub is active', async () => {
    await uploadEntityFile(new File(['x'], 'x.bin'))
    expect(calls).toEqual([{ method: 'POST', url: '/api/uploads/entity-file' }])
  })
})

describe('case-management roles', () => {
  it('creates roles from a template under settings/cms', async () => {
    await createRolesFromTemplate([])
    expect(calls).toEqual([{ method: 'POST', url: '/api/hubs/hub-1/settings/cms/roles/from-template' }])
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

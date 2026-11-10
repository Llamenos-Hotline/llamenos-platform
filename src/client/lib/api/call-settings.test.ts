/**
 * #1137 (the UI half of #1051): spam and call settings are hub-owned. The
 * desktop client used to call the unscoped `/settings/spam|call`, so an admin
 * editing "their hub's" settings silently wrote the PLATFORM values every hub
 * without an override inherits. These assert the path on the wire: the hub
 * being edited is in the request, the active hub and the unscoped route are
 * never consulted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActiveHub } from './client'
import {
  getSpamSettings,
  updateSpamSettings,
  getCallSettings,
  updateCallSettings,
} from './call-settings'

interface RecordedCall {
  method: string
  url: string
}

let calls: RecordedCall[]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({ method: (init.method ?? 'GET').toUpperCase(), url: String(input) })
      return new Response('{}', { status: 200 })
    }),
  )
  // The hub being browsed. Editing hub B must not move any request here.
  setActiveHub('hub-A')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveHub(null)
})

describe('spam settings (#1137)', () => {
  it('reads spam settings from the hub being edited, not the active hub or the platform default', async () => {
    await getSpamSettings('hub-B')
    expect(calls).toEqual([{ method: 'GET', url: '/api/hubs/hub-B/settings/spam' }])
  })

  it('writes spam settings to the hub being edited', async () => {
    await updateSpamSettings('hub-B', { voiceCaptchaEnabled: true })
    expect(calls).toEqual([{ method: 'PATCH', url: '/api/hubs/hub-B/settings/spam' }])
  })
})

describe('call settings (#1137)', () => {
  it('reads call settings from the hub being edited', async () => {
    await getCallSettings('hub-B')
    expect(calls).toEqual([{ method: 'GET', url: '/api/hubs/hub-B/settings/call' }])
  })

  it('writes call settings to the hub being edited', async () => {
    await updateCallSettings('hub-B', { queueTimeoutSeconds: 120 })
    expect(calls).toEqual([{ method: 'PATCH', url: '/api/hubs/hub-B/settings/call' }])
  })
})

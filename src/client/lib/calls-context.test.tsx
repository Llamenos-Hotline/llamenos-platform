/**
 * The call feed tells the idle auto-lock whether the user is on a call. The feed
 * spans every member hub, so a call on a hub other than the one being browsed
 * counts — the lock must not be keyed to the active hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const state = vi.hoisted(() => ({
  currentCall: null as { id: string; hubId: string } | null,
  setOnCall: vi.fn(),
}))

vi.mock('./hooks', () => ({
  useCallFeed: () => ({
    calls: [],
    currentCall: state.currentCall,
    ringingCalls: [],
    activeCalls: [],
    answerCall: vi.fn(),
    hangupCall: vi.fn(),
    reportSpam: vi.fn(),
  }),
}))
vi.mock('./key-manager', () => ({ setOnCall: state.setOnCall }))
vi.mock('./auth', () => ({ useAuth: () => ({ onBreak: false }) }))
vi.mock('./config', () => ({ useConfig: () => ({ hubs: [], isMultiHub: false }) }))

import { CallsProvider } from './calls-context'

describe('CallsProvider → idle auto-lock', () => {
  beforeEach(() => {
    state.currentCall = null
    state.setOnCall.mockClear()
  })
  afterEach(cleanup)

  it('reports no call while idle', () => {
    render(<CallsProvider>x</CallsProvider>)
    expect(state.setOnCall).toHaveBeenLastCalledWith(false)
  })

  it('reports a call answered on any hub', () => {
    state.currentCall = { id: 'CA-1', hubId: 'hub-B' }
    render(<CallsProvider>x</CallsProvider>)
    expect(state.setOnCall).toHaveBeenLastCalledWith(true)
  })

  it('stops reporting a call when the provider goes away', () => {
    state.currentCall = { id: 'CA-1', hubId: 'hub-B' }
    const { unmount } = render(<CallsProvider>x</CallsProvider>)
    unmount()
    expect(state.setOnCall).toHaveBeenLastCalledWith(false)
  })
})

/**
 * The webview voice store (#1770, plan Task 9): the shell's `voice:*` events
 * reduced into what the UI renders, and the binding of an in-app leg to the
 * app's call — which must never be a guess.
 */
import { describe, expect, it } from 'vitest'
import { activeInAppLeg, inAppLegFor, reduceCall, reduceRegistration, type VoiceStoreSnapshot } from './voice'

const empty: VoiceStoreSnapshot = { registration: 'unregistered', calls: new Map() }
const registered = reduceRegistration(empty, { state: 'registered' })

describe('voice store', () => {
  it('reduces registration events into state, with the reason', () => {
    let s = reduceRegistration(empty, { state: 'registering' })
    expect(s.registration).toBe('registering')
    s = reduceRegistration(s, { state: 'failed', reason: 'tls handshake' })
    expect(s.registration).toBe('failed')
    expect(s.registrationReason).toBe('tls handshake')
    s = reduceRegistration(s, { state: 'registered' })
    expect(s.registrationReason).toBeUndefined()
  })

  it('keeps per-call state keyed by the shell call id — a ring from any hub lands', () => {
    let s = reduceCall(registered, { callId: 'c1', appCallId: 'a1', state: 'incoming', muted: false })
    s = reduceCall(s, { callId: 'c2', appCallId: 'a2', state: 'incoming', muted: false })
    expect(s.calls.size).toBe(2)
    s = reduceCall(s, { callId: 'c1', state: 'ended', muted: false })
    expect(s.calls.has('c1')).toBe(false)
    expect(s.calls.has('c2')).toBe(true)
  })

  it('a leg that fails is removed and its reason kept, so it is never silent', () => {
    let s = reduceCall(registered, { callId: 'c1', appCallId: 'a1', state: 'connecting', muted: false })
    s = reduceCall(s, { callId: 'c1', state: 'error', muted: false, reason: 'the DTLS-SRTP handshake did not complete' })
    expect(s.calls.size).toBe(0)
    expect(s.lastCallError).toEqual({ callId: 'c1', reason: 'the DTLS-SRTP handshake did not complete' })
  })

  it('binds an in-app leg to an app call only by the id the INVITE named', () => {
    let s = reduceCall(registered, { callId: 'sip-1', appCallId: 'app-1', state: 'incoming', muted: false })
    expect(inAppLegFor(s, 'app-1')?.callId).toBe('sip-1')
    expect(inAppLegFor(s, 'app-2')).toBeUndefined()
    // A leg that names no app call is never bound to one, however alone it is.
    s = reduceCall(registered, { callId: 'sip-2', state: 'incoming', muted: false })
    expect(inAppLegFor(s, 'app-1')).toBeUndefined()
  })

  it('offers no in-app leg while not registered (#1147/#1741: no Answer into silence)', () => {
    let s = reduceCall(registered, { callId: 'sip-1', appCallId: 'app-1', state: 'incoming', muted: false })
    s = reduceRegistration(s, { state: 'failed', reason: 'tls handshake' })
    expect(inAppLegFor(s, 'app-1')).toBeUndefined()
  })

  it('tracks the answered leg', () => {
    let s = reduceCall(registered, { callId: 'sip-1', appCallId: 'app-1', state: 'incoming', muted: false })
    expect(activeInAppLeg(s)).toBeUndefined()
    s = reduceCall(s, { callId: 'sip-1', appCallId: 'app-1', state: 'active', muted: true })
    expect(activeInAppLeg(s)).toMatchObject({ callId: 'sip-1', muted: true })
  })
})

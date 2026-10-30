/**
 * An incoming ring must be perceivable and answerable without a mouse or eyes:
 * announced in a live region, focus offered (never stolen from a text field),
 * answered with a real button or the Ctrl+Shift+A chord on the call's own hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HubCall } from './api'
import type { IncomingCall } from './calls-context'

const state = vi.hoisted(() => ({
  incoming: [] as IncomingCall[],
  currentCall: null as { id: string; hubId: string } | null,
  answerCall: vi.fn(async (_id: string) => {}),
  hangupCall: vi.fn(async (_id: string) => {}),
  toast: vi.fn(),
}))

vi.mock('./calls-context', () => ({
  useIncomingCalls: () => state.incoming,
  useCalls: () => ({ currentCall: state.currentCall, answerCall: state.answerCall, hangupCall: state.hangupCall }),
}))
vi.mock('./auth', () => ({ useAuth: () => ({ isAuthenticated: true, toggleBreak: vi.fn() }) }))
vi.mock('./toast', () => ({ useToast: () => ({ toast: state.toast }) }))
vi.mock('./note-sheet-context', () => ({ useNoteSheet: () => ({ isOpen: false, close: vi.fn(), openNewNote: vi.fn() }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import { IncomingCallAnnouncer } from '@/components/call/incoming-call-announcer'
import { IncomingCallCard } from '@/components/call/incoming-call-card'
import { useKeyboardShortcuts } from './use-keyboard-shortcuts'

function ringing(id: string, hubId: string, hubName: string | null = null): IncomingCall {
  // Nothing about the caller's number reaches the client with the ring; the card names the hub only.
  const call = {
    id,
    hubId,
    callerNumber: '[redacted]',
    answeredBy: null,
    startedAt: '2026-01-01T00:00:00Z',
    status: 'ringing',
    hasTranscription: false,
    hasVoicemail: false,
  } as HubCall
  return { call, hubName }
}

beforeEach(() => {
  state.incoming = []
  state.currentCall = null
  state.answerCall.mockClear()
  state.hangupCall.mockClear()
  state.toast.mockClear()
})
afterEach(cleanup)

describe('IncomingCallAnnouncer', () => {
  it('keeps one polite live region mounted and fills it when a call rings', () => {
    const { rerender } = render(<IncomingCallAnnouncer />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')

    state.incoming = [ringing('CA1', 'hub-A')]
    rerender(<IncomingCallAnnouncer />)

    // Same node, new text: this is what makes assistive tech announce it.
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('Someone is calling the hotline')
  })

  it('never carries caller digits, and names the hub only when the volunteer is in several', () => {
    state.incoming = [ringing('CA1', 'hub-B', 'Night Line')]
    render(<IncomingCallAnnouncer />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toContain('Night Line')
    expect(text).not.toMatch(/4821|\d{4}/)
  })
})

describe('IncomingCallCard', () => {
  it('moves focus to Answer when a call starts ringing and nothing is being typed', () => {
    state.incoming = [ringing('CA1', 'hub-A')]
    render(<IncomingCallCard incoming={state.incoming} onAnswer={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByTestId('answer-call-btn-CA1'))
  })

  it('does not steal focus from a text field', () => {
    const { getByTestId } = render(<textarea data-testid="note" />)
    const note = getByTestId('note')
    note.focus()
    state.incoming = [ringing('CA1', 'hub-A')]
    render(<IncomingCallCard incoming={state.incoming} onAnswer={vi.fn()} />)
    expect(document.activeElement).toBe(note)
  })

  it('answers from the keyboard alone, with Enter and with Space, on a native button', async () => {
    const onAnswer = vi.fn()
    state.incoming = [ringing('CA1', 'hub-A')]
    render(<IncomingCallCard incoming={state.incoming} onAnswer={onAnswer} />)
    const answer = screen.getByRole('button', { name: 'Answer' })
    expect(answer.tagName).toBe('BUTTON')

    const user = userEvent.setup()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer).toHaveBeenCalledWith('CA1')
  })

  it('pulses only when the user has not asked for reduced motion', () => {
    state.incoming = [ringing('CA1', 'hub-A')]
    render(<IncomingCallCard incoming={state.incoming} onAnswer={vi.fn()} />)
    const classes = screen.getByTestId('answer-call-btn-CA1').className.split(' ')
    expect(classes).toContain('motion-safe:animate-pulse')
    expect(classes).not.toContain('animate-pulse')
  })
})

describe('keyboard shortcuts for a ring', () => {
  const chord = (key: string, target: Element | Document = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))

  it('Ctrl+Shift+A answers the first ringing call on that call\'s own hub, even while typing', () => {
    state.incoming = [ringing('CA-on-B', 'hub-B'), ringing('CA2', 'hub-A')]
    renderHook(() => useKeyboardShortcuts())
    const field = document.body.appendChild(document.createElement('textarea'))
    field.focus()
    chord('A', field)
    expect(state.answerCall).toHaveBeenCalledWith('CA-on-B')
    field.remove()
  })

  it('says so when the answer is refused', async () => {
    state.incoming = [ringing('CA1', 'hub-A')]
    state.answerCall.mockRejectedValueOnce(new Error('taken'))
    renderHook(() => useKeyboardShortcuts())
    chord('A')
    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledWith(
      'Couldn\'t answer the call. Someone else may have picked up first.', 'error'))
  })

  it('does nothing when no call is ringing', () => {
    renderHook(() => useKeyboardShortcuts())
    chord('A')
    expect(state.answerCall).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+H hangs up the current call, but not while a note is being typed', () => {
    state.currentCall = { id: 'CA1', hubId: 'hub-B' }
    renderHook(() => useKeyboardShortcuts())
    const field = document.body.appendChild(document.createElement('textarea'))
    field.focus()
    chord('H', field)
    expect(state.hangupCall).not.toHaveBeenCalled()
    field.blur()
    chord('H')
    expect(state.hangupCall).toHaveBeenCalledWith('CA1')
    field.remove()
  })
})

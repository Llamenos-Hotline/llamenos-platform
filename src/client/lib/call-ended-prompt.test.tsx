/**
 * The dashboard's "Call Ended / Add Note" prompt: it offers to write up the user's own
 * call, opens the editor on THAT call (with its own hub), and shows nothing about the
 * caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CallEndedPrompt } from '@/components/call/call-ended-prompt'

afterEach(cleanup)

describe('CallEndedPrompt', () => {
  it('says the call ended and offers Add Note and Dismiss', () => {
    render(<CallEndedPrompt call={{ id: 'CA-1', hubId: 'hub-B' }} onAddNote={vi.fn()} onDismiss={vi.fn()} />)
    const prompt = screen.getByTestId('call-ended-prompt')
    expect(prompt.textContent).toContain('Call Ended')
    expect(screen.getByTestId('call-ended-add-note').textContent).toContain('Add Note')
    expect(screen.getByTestId('call-ended-dismiss')).toBeTruthy()
  })

  it('opens the note editor on the ended call, carrying the call\'s own hub', async () => {
    const onAddNote = vi.fn()
    render(<CallEndedPrompt call={{ id: 'CA-1', hubId: 'hub-B' }} onAddNote={onAddNote} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByTestId('call-ended-add-note'))
    expect(onAddNote).toHaveBeenCalledWith({ id: 'CA-1', hubId: 'hub-B' })
  })

  it('dismisses without opening the editor', async () => {
    const onAddNote = vi.fn()
    const onDismiss = vi.fn()
    render(<CallEndedPrompt call={{ id: 'CA-1', hubId: 'hub-B' }} onAddNote={onAddNote} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByTestId('call-ended-dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onAddNote).not.toHaveBeenCalled()
  })

  it('shows nothing that identifies the caller', () => {
    render(<CallEndedPrompt call={{ id: 'CA-1', hubId: 'hub-B' }} onAddNote={vi.fn()} onDismiss={vi.fn()} />)
    // The component is only handed an id and a hub; the call's id is not shown either.
    expect(screen.getByTestId('call-ended-prompt').textContent).not.toMatch(/\d{4}|CA-1|hub-B/)
  })
})

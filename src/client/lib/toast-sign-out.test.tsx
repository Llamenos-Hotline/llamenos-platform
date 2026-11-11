/**
 * After sign-out, polls that were already in flight are answered 401 and each caller
 * raises an error toast onto the login screen (#2115). Error toasts are dropped from
 * sign-out until the next unlock; other toasts are unaffected.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import { ToastProvider, useToast, setErrorToastsSuppressed } from './toast'

function Probe() {
  const { toast } = useToast()
  return (
    <>
      <button data-testid="err" onClick={() => toast('boom', 'error')} />
      <button data-testid="ok" onClick={() => toast('done', 'success')} />
    </>
  )
}

describe('error toasts after sign-out', () => {
  afterEach(() => {
    setErrorToastsSuppressed(false)
    cleanup()
  })

  it('shows error toasts normally', () => {
    render(<ToastProvider><Probe /></ToastProvider>)
    act(() => screen.getByTestId('err').click())
    expect(screen.getAllByTestId('toast-error')).toHaveLength(1)
  })

  it('drops error toasts while suppressed, keeps others, and resumes after unlock', () => {
    render(<ToastProvider><Probe /></ToastProvider>)
    act(() => setErrorToastsSuppressed(true))
    act(() => screen.getByTestId('err').click())
    act(() => screen.getByTestId('ok').click())
    expect(screen.queryByTestId('toast-error')).toBeNull()
    expect(screen.getAllByTestId('toast-success')).toHaveLength(1)
    act(() => setErrorToastsSuppressed(false))
    act(() => screen.getByTestId('err').click())
    expect(screen.getAllByTestId('toast-error')).toHaveLength(1)
  })
})

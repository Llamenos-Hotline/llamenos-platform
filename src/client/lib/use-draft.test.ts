import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDraft } from './use-draft'

vi.mock('./hub-key-manager', () => ({
  encryptDraft: vi.fn(async (plaintext: string) => `enc:${plaintext}`),
  decryptDraft: vi.fn(async (packed: string) => {
    if (packed.startsWith('enc:')) return packed.slice(4)
    return null
  }),
}))

vi.mock('./key-manager', () => ({
  isUnlocked: vi.fn(() => true),
}))

describe('useDraft', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes with empty state', () => {
    const { result } = renderHook(() => useDraft('test-key'))
    expect(result.current.text).toBe('')
    expect(result.current.callId).toBe('')
    expect(result.current.fields).toEqual({})
    expect(result.current.savedAt).toBeNull()
    expect(result.current.isDirty).toBe(false)
  })

  it('marks dirty when text changes', () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setText('hello')
    })

    expect(result.current.text).toBe('hello')
    expect(result.current.isDirty).toBe(true)
  })

  it('marks dirty when callId changes', () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setCallId('call-123')
    })

    expect(result.current.callId).toBe('call-123')
    expect(result.current.isDirty).toBe(true)
  })

  it('marks dirty when fields change', () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setFieldValue('priority', 'high')
    })

    expect(result.current.fields).toEqual({ priority: 'high' })
    expect(result.current.isDirty).toBe(true)
  })

  it('clears draft and removes from storage', () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setText('hello')
      result.current.setCallId('call-123')
      result.current.setFieldValue('priority', 'high')
    })

    act(() => {
      result.current.clearDraft()
    })

    expect(result.current.text).toBe('')
    expect(result.current.callId).toBe('')
    expect(result.current.fields).toEqual({})
    expect(result.current.savedAt).toBeNull()
    expect(result.current.isDirty).toBe(false)
    expect(localStorage.getItem('llamenos-draft:test-key')).toBeNull()
  })

  it('does not persist when all values are empty', async () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setText('temp')
    })

    act(() => {
      vi.advanceTimersByTime(600)
    })

    act(() => {
      result.current.setText('')
    })

    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(localStorage.getItem('llamenos-draft:test-key')).toBeNull()
  })

  it('uses unique storage keys per draft key', () => {
    const { result: result1 } = renderHook(() => useDraft('key-1'))
    const { result: result2 } = renderHook(() => useDraft('key-2'))

    act(() => {
      result1.current.setText('draft1')
      result2.current.setText('draft2')
    })

    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(result1.current.text).toBe('draft1')
    expect(result2.current.text).toBe('draft2')
  })

  it('handles rapid successive changes with debounce', () => {
    const { result } = renderHook(() => useDraft('test-key'))

    act(() => {
      result.current.setText('a')
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      result.current.setText('ab')
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      result.current.setText('abc')
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(result.current.text).toBe('abc')
  })
})

describe('useDraft with locked key manager', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    const km = await import('./key-manager')
    vi.mocked(km.isUnlocked).mockReturnValue(false)
  })

  afterEach(async () => {
    const km = await import('./key-manager')
    vi.mocked(km.isUnlocked).mockReturnValue(true)
  })

  it('does not restore draft when locked', () => {
    localStorage.setItem('llamenos-draft:test-key', 'enc:{"text":"secret"}')

    const { result } = renderHook(() => useDraft('test-key'))
    expect(result.current.text).toBe('')
  })
})

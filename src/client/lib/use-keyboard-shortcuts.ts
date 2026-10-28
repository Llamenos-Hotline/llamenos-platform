import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from './auth'
import { useToast } from './toast'
import { useNoteSheet } from './note-sheet-context'
import { useCalls, useIncomingCalls } from './calls-context'
import { isEditableFocused } from './editable-focus'

export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const { isAuthenticated, toggleBreak } = useAuth()
  const { toast } = useToast()
  const noteSheet = useNoteSheet()
  const { t } = useTranslation()
  const { currentCall, answerCall, hangupCall } = useCalls()
  const incoming = useIncomingCalls()

  useEffect(() => {
    if (!isAuthenticated) return

    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey

      // Escape — close sheet (always works)
      if (e.key === 'Escape' && noteSheet.isOpen) {
        e.preventDefault()
        noteSheet.close()
        return
      }

      // Ctrl/Cmd+Shift+A — Answer the first ringing call, on that call's own hub.
      // Works while typing: a chord is never text, and a ring that cannot be answered
      // from a text field is a missed call.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        if (incoming.length > 0) {
          e.preventDefault()
          answerCall(incoming[0].call.id).catch(() => {
            toast(t('calls.answerFailed'), 'error')
          })
        }
        return
      }

      // Skip the remaining shortcuts when focused on inputs (except Escape above)
      if (isEditableFocused()) return

      // Ctrl/Cmd+Shift+H — Hang up the current call. Not while typing: the note being
      // written during a call must not be one stray chord away from ending it.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
        if (currentCall) {
          e.preventDefault()
          hangupCall(currentCall.id).catch(() => {
            toast(t('calls.hangupFailed'), 'error')
          })
        }
        return
      }

      // Alt+N — New note
      if (e.altKey && e.key === 'n' && !mod && !e.shiftKey) {
        e.preventDefault()
        noteSheet.openNewNote()
        return
      }

      // Ctrl/Cmd+Shift+F — Search notes
      if (mod && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        navigate({ to: '/notes', search: { page: 1, callId: '', search: '' } })
        // Focus the search input after navigation
        setTimeout(() => {
          const input = document.querySelector('[data-slot="sheet-content"] input, .pl-9') as HTMLInputElement | null
          input?.focus()
        }, 100)
        return
      }

      // Ctrl/Cmd+Shift+B — Toggle break
      if (mod && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        toggleBreak().catch(() => {
          toast(t('dashboard.errorBreak'), 'error')
        })
        return
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isAuthenticated, toggleBreak, noteSheet, navigate, toast, t, incoming, currentCall, answerCall, hangupCall])
}

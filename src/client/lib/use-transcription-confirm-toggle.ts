import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateTranscriptionSettings } from '@/lib/api'

interface PendingTranscriptionToggle {
  newValue: boolean
}

/**
 * Single source of truth for the "global transcription enabled" confirm-then-PATCH
 * flow. Both the sidebar route (admin-sections/transcription-section.tsx) and the
 * legacy hub-settings page (routes/admin/settings.tsx) render the same
 * `TranscriptionSection` presentational component and must react to its
 * `onConfirmToggle` callback identically — a real PATCH to the server, not a local
 * `setState` that reverts on reload. Keeping that logic here, used by both callers,
 * is what stops the two surfaces from silently diverging again (see issue #1130).
 */
export function useTranscriptionConfirmToggle(onUpdated: (globalEnabled: boolean) => void) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [pending, setPending] = useState<PendingTranscriptionToggle | null>(null)

  const requestToggle = useCallback((key: string, newValue: boolean) => {
    if (key !== 'transcription') return
    setPending({ newValue })
  }, [])

  const cancel = useCallback(() => setPending(null), [])

  const confirm = useCallback(async () => {
    if (!pending) return
    try {
      const res = await updateTranscriptionSettings({ globalEnabled: pending.newValue })
      onUpdated(res.globalEnabled)
    } catch {
      toast(t('common.error'), 'error')
    }
  }, [pending, onUpdated, t, toast])

  const title = pending ? t('confirm.transcriptionTitle') : ''
  const description = pending
    ? t(pending.newValue ? 'confirm.transcriptionEnable' : 'confirm.transcriptionDisable')
    : ''

  return { pending, requestToggle, confirm, cancel, title, description }
}

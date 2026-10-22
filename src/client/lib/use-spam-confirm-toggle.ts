import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateSpamSettings, type SpamSettings } from '@/lib/api'

type SpamToggleKey = 'captcha' | 'rateLimit'

interface PendingSpamToggle {
  key: SpamToggleKey
  newValue: boolean
}

/**
 * Single source of truth for the spam-settings confirm-then-PATCH flow.
 *
 * Both the sidebar route (admin-sections/spam-section.tsx) and the legacy
 * hub-settings page (routes/admin/settings.tsx) render the same
 * `SpamSection` presentational component and must react to its
 * `onConfirmToggle` callback identically — a real PATCH to the server,
 * not a local `setState` that reverts on reload. Keeping that logic here,
 * used by both callers, is what stops the two surfaces from silently
 * diverging again (see issue #1130).
 */
export function useSpamConfirmToggle(onUpdated: (settings: SpamSettings) => void) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [pending, setPending] = useState<PendingSpamToggle | null>(null)

  const requestToggle = useCallback((key: string, newValue: boolean) => {
    if (key !== 'captcha' && key !== 'rateLimit') return
    setPending({ key, newValue })
  }, [])

  const cancel = useCallback(() => setPending(null), [])

  const confirm = useCallback(async () => {
    if (!pending) return
    const { key, newValue } = pending
    try {
      const res = key === 'captcha'
        ? await updateSpamSettings({ voiceCaptchaEnabled: newValue })
        : await updateSpamSettings({ rateLimitEnabled: newValue })
      onUpdated(res)
    } catch {
      toast(t('common.error'), 'error')
    }
  }, [pending, onUpdated, t, toast])

  const title = pending
    ? t(pending.key === 'captcha' ? 'confirm.captchaTitle' : 'confirm.rateLimitTitle')
    : ''

  const description = pending
    ? t(
        pending.key === 'captcha'
          ? (pending.newValue ? 'confirm.captchaEnable' : 'confirm.captchaDisable')
          : (pending.newValue ? 'confirm.rateLimitEnable' : 'confirm.rateLimitDisable'),
      )
    : ''

  return { pending, requestToggle, confirm, cancel, title, description }
}

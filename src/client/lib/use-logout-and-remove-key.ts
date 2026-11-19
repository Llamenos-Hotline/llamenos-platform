import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './auth'
import { logoutAndRemoveKey } from './logout'
import { useToast } from './toast'

/**
 * Settings → Log Out as a ready-to-call action. The failure notice is a deliberate
 * toast: `signOut()` has by then switched on error-toast suppression (to hide the
 * 401s of requests still in flight), and without `deliberate` the one error the user
 * must see — their keys are still on this device — would be dropped with them.
 */
export function useLogoutAndRemoveKey(): () => Promise<void> {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const { toast } = useToast()
  return useCallback(
    () => logoutAndRemoveKey(signOut, () => toast(t('settings.logoutKeyRemovalFailed'), 'error', { deliberate: true })),
    [signOut, toast, t],
  )
}

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { generateBackupFromState, saveBackupFile } from '@/lib/platform'
import { useToast } from '@/lib/toast'

/**
 * The "Download Encrypted Backup" step shared by onboarding and admin bootstrap.
 *
 * `savedPath` is set ONLY once Rust reports a file written at a location the user
 * chose in a native save dialog. A dismissed dialog and a failed write both leave
 * it null and surface a visible `error`, so a step gated on `savedPath` can never
 * be passed by a file that did not land (#2111). The old `<a download>` click gave
 * the app no way to know either.
 */
export function useBackupSave() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [error, setError] = useState('')

  const save = useCallback(async (pin: string, recoveryKey: string) => {
    // Backup is created entirely in Rust — the device key never enters JS. A
    // failure must be visible: an unhandled rejection used to leave the user
    // stranded behind a dead Continue button with no explanation (#1709).
    setError('')
    try {
      const backupJson = await generateBackupFromState(pin, recoveryKey)
      const path = await saveBackupFile(backupJson)
      if (path === null) {
        const message = t('onboarding.backupNotSaved')
        setSavedPath(null)
        setError(message)
        toast(message, 'error')
        return
      }
      setSavedPath(path)
      toast(t('onboarding.backupSavedTo', { path }), 'success')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const message = t('onboarding.backupFailed', { reason })
      setSavedPath(null)
      setError(message)
      toast(message, 'error')
    }
  }, [t, toast])

  return { savedPath, error, save }
}

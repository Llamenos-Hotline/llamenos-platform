import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { getTranscriptionSettings } from '@/lib/api'
import { TranscriptionSection as TranscriptionSectionInner } from '@/components/admin-settings/transcription-section'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useTranscriptionConfirmToggle } from '@/lib/use-transcription-confirm-toggle'

export function TranscriptionSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [allowOptOut, setAllowOptOut] = useState(false)
  const [loading, setLoading] = useState(true)
  const { pending, requestToggle, confirm, cancel, title, description } = useTranscriptionConfirmToggle(setGlobalEnabled)

  useEffect(() => {
    getTranscriptionSettings()
      .then(r => {
        setGlobalEnabled(r.globalEnabled)
        setAllowOptOut(r.allowUserOptOut)
      })
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-muted-foreground">{t('common.loading')}</div>

  const statusSummary = globalEnabled
    ? t('common.enabled', { defaultValue: 'Enabled' })
    : t('common.disabled', { defaultValue: 'Disabled' })

  return (
    <>
      <TranscriptionSectionInner
        globalEnabled={globalEnabled}
        allowOptOut={allowOptOut}
        onGlobalChange={setGlobalEnabled}
        onOptOutChange={setAllowOptOut}
        onConfirmToggle={requestToggle}
        expanded={true}
        onToggle={() => {}}
        statusSummary={statusSummary}
      />
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => { if (!open) cancel() }}
        title={title}
        description={description}
        variant="default"
        onConfirm={confirm}
      />
    </>
  )
}

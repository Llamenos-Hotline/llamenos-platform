import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  getRecoverySessions,
  getMyShareEnvelope,
  getActiveHub,
} from '@/lib/api'
import type { RecoverySessionStatusResponse } from '@protocol/schemas'
import { RecoveryRequestsSection } from '@/components/admin-settings/recovery-requests-section'

export function RecoveryRequestsAdminSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const hubId = getActiveHub()
  const [sessions, setSessions] = useState<RecoverySessionStatusResponse[]>([])
  const [myShareEnvelope, setMyShareEnvelope] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadSessions() {
    if (!hubId) return
    setLoading(true)
    try {
      const data = await getRecoverySessions(hubId)
      setSessions(data)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!hubId) return
    // null = this user holds no share in the hub (the server's single 403).
    getMyShareEnvelope(hubId)
      .then((mine) => setMyShareEnvelope(mine?.shareEnvelope ?? null))
      .catch(() => toast(t('common.error'), 'error'))
  }, [hubId])

  useEffect(() => {
    loadSessions()
    const interval = setInterval(loadSessions, 30_000)
    return () => clearInterval(interval)
  }, [hubId])

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  if (!hubId) {
    return <div className="p-4 text-sm text-muted-foreground">{t('common.error')}</div>
  }

  return (
    <RecoveryRequestsSection
      hubId={hubId}
      sessions={sessions}
      onSessionsChanged={loadSessions}
      myShareEnvelope={myShareEnvelope}
      myShareCommitment={null}
    />
  )
}

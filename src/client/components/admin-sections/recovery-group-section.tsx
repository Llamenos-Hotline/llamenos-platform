import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  getRecoveryGroup,
  getRecoveryGroupCandidates,
  getActiveHub,
  type RecoveryGroupCandidate,
} from '@/lib/api'
import type { RecoveryGroupInfo } from '@protocol/schemas/recovery-group'
import { RecoveryGroupSettingsSection } from '@/components/admin-settings/recovery-group-section'

export function RecoveryGroupSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const hubId = getActiveHub()
  const [group, setGroup] = useState<RecoveryGroupInfo | null>(null)
  const [candidates, setCandidates] = useState<RecoveryGroupCandidate[]>([])
  const [loading, setLoading] = useState(true)

  async function loadData() {
    if (!hubId) return
    setLoading(true)
    // Settled independently: a failed candidates lookup (#2002 — the route is
    // not mounted yet) must not also blank out an already-configured group.
    const [groupResult, candidatesResult] = await Promise.allSettled([
      getRecoveryGroup(hubId),
      getRecoveryGroupCandidates(hubId),
    ])
    if (groupResult.status === 'fulfilled') setGroup(groupResult.value)
    if (candidatesResult.status === 'fulfilled') setCandidates(candidatesResult.value)
    if (groupResult.status === 'rejected' || candidatesResult.status === 'rejected') {
      toast(t('common.error'), 'error')
    }
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [hubId])

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  if (!hubId) {
    return <div className="p-4 text-sm text-muted-foreground">{t('common.error')}</div>
  }

  return (
    <RecoveryGroupSettingsSection
      hubId={hubId}
      group={group}
      shareHolderCandidates={candidates}
      onGroupChanged={loadData}
    />
  )
}

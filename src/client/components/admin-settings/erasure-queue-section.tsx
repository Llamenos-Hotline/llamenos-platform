import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import {
  SectionField,
  SectionBanner,
} from '@/components/admin-shell/section-layout'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, UserX, Smartphone, RefreshCw } from 'lucide-react'
import {
  adminEraseUser,
  remoteWipeDevice,
  listEnvelopeRevocationJobs,
} from '@/lib/api'
import type { ErasureRequest, EnvelopeRevocationJob } from '@protocol/schemas'

interface Props {
  requests: ErasureRequest[]
  onRefresh: () => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
  emergencyOverrideEnabled?: boolean
}

export function ErasureQueueSection({ requests, onRefresh, expanded, onToggle, statusSummary, emergencyOverrideEnabled }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showEraseDialog, setShowEraseDialog] = useState(false)
  const [eraseUserId, setEraseUserId] = useState('')
  const [eraseJustification, setEraseJustification] = useState('')
  const [erasing, setErasing] = useState(false)
  const [eraseCoApproverPubkey, setEraseCoApproverPubkey] = useState('')
  const [showWipeDialog, setShowWipeDialog] = useState(false)
  const [wipeUserId, setWipeUserId] = useState('')
  const [wipeDevicePubkey, setWipeDevicePubkey] = useState('')
  const [wiping, setWiping] = useState(false)
  const [envelopeRevocationJobs, setEnvelopeRevocationJobs] = useState<EnvelopeRevocationJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)

  const filteredRequests = statusFilter === 'all'
    ? requests
    : requests.filter(r => r.status === statusFilter)

  async function handleAdminErase() {
    if (!eraseUserId.trim() || !eraseJustification.trim()) return
    setErasing(true)
    try {
      await adminEraseUser(eraseUserId.trim(), eraseJustification.trim())
      toast(t('erasure.admin.eraseSuccess'), 'success')
      setShowEraseDialog(false)
      setEraseUserId('')
      setEraseJustification('')
      setEraseCoApproverPubkey('')
      onRefresh()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setErasing(false)
    }
  }

  async function handleRemoteWipe() {
    if (!wipeUserId.trim() || !wipeDevicePubkey.trim()) return
    setWiping(true)
    try {
      await remoteWipeDevice(wipeUserId.trim(), wipeDevicePubkey.trim())
      toast(t('erasure.admin.wipeSuccess'), 'success')
      setShowWipeDialog(false)
      setWipeUserId('')
      setWipeDevicePubkey('')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setWiping(false)
    }
  }

  async function loadEnvelopeRevocationJobs() {
    setJobsLoading(true)
    try {
      const { jobs } = await listEnvelopeRevocationJobs()
      setEnvelopeRevocationJobs(jobs)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setJobsLoading(false)
    }
  }

  return (
    <SettingsSection
      id="erasure-queue"
      title={t('erasure.admin.title')}
      icon={<UserX className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      {/* Status filter */}
      <div className="flex items-center gap-3 mb-4">
        <select
          data-testid="erasure-status-filter"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">{t('erasure.admin.filterAll')}</option>
          <option value="pending">{t('erasure.status.pending')}</option>
          <option value="executing">{t('erasure.status.executing')}</option>
          <option value="completed">{t('erasure.status.completed')}</option>
          <option value="failed">{t('erasure.status.failed')}</option>
          <option value="cancelled">{t('erasure.status.cancelled')}</option>
        </select>
        <Button variant="ghost" size="sm" onClick={onRefresh} data-testid="erasure-refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Requests table */}
      {filteredRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="erasure-empty">
          {t('erasure.admin.noRequests')}
        </p>
      ) : (
        <div className="space-y-2" data-testid="erasure-request-list">
          {filteredRequests.map((req) => (
            <div
              key={req.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
              data-testid={`erasure-request-${req.id}`}
            >
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{req.userId}</div>
                <div className="text-xs text-muted-foreground">
                  {t('erasure.admin.requestedAt', { date: new Date(req.requestedAt).toLocaleString() })}
                  {req.executeAt && ` — ${t('erasure.admin.executesAt', { date: new Date(req.executeAt).toLocaleString() })}`}
                </div>
                {req.emergencyOverride && (
                  <div className="flex flex-col gap-1">
                    <Badge variant="outline" className="text-amber-600 w-fit">
                      {t('erasure.admin.emergencyOverride')}
                    </Badge>
                    {req.coApproverPubkey ? (
                      <span className="text-xs text-muted-foreground" data-testid={`coapprover-${req.id}`}>
                        {t('erasure.admin.coApprovedBy', { pubkey: req.coApproverPubkey.slice(0, 16) })}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600" data-testid={`coapprover-pending-${req.id}`}>
                        {t('erasure.admin.coApprovalPending')}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <Badge
                variant={req.status === 'completed' ? 'default' : req.status === 'failed' ? 'destructive' : 'secondary'}
                data-testid={`erasure-status-${req.id}`}
              >
                {t(`erasure.status.${req.status}`)}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Admin actions */}
      <div className="mt-6 flex flex-wrap gap-3 border-t border-border/60 pt-5">
        <Button
          variant="destructive"
          data-testid="erasure-admin-erase-btn"
          onClick={() => setShowEraseDialog(true)}
        >
          <UserX className="mr-2 h-4 w-4" />
          {t('erasure.admin.immediateErase')}
        </Button>
        <Button
          variant="outline"
          data-testid="erasure-admin-wipe-btn"
          onClick={() => setShowWipeDialog(true)}
        >
          <Smartphone className="mr-2 h-4 w-4" />
          {t('erasure.admin.remoteWipe')}
        </Button>
      </div>

      {/* Envelope revocation jobs */}
      <div className="mt-6 border-t border-border/60 pt-5">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium">{t('erasure.admin.envelopeRevocationJobs')}</h4>
          <Button variant="ghost" size="sm" onClick={loadEnvelopeRevocationJobs} data-testid="envelope-revocation-refresh">
            {jobsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        {envelopeRevocationJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="envelope-revocation-empty">
            {t('erasure.admin.noEnvelopeRevocationJobs')}
          </p>
        ) : (
          <div className="space-y-2" data-testid="envelope-revocation-job-list">
            {envelopeRevocationJobs.map((job) => (
              <div key={job.id} className="rounded-lg border border-border p-3 space-y-2" data-testid={`envelope-revocation-job-${job.id}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t('erasure.admin.jobUser', { userId: job.userId })}</span>
                  <Badge variant={job.status === 'completed' ? 'default' : job.status === 'failed' ? 'destructive' : 'secondary'}>
                    {t(`erasure.admin.jobStatus.${job.status}`)}
                  </Badge>
                </div>
                {(job.status === 'running' || job.status === 'completed') && job.totalEnvelopes > 0 && (
                  <div className="space-y-1">
                    <Progress value={(job.processedEnvelopes / job.totalEnvelopes) * 100} className="h-2" />
                    <p className="text-xs text-muted-foreground">
                      {t('erasure.admin.jobProgress', {
                        processed: job.processedEnvelopes,
                        total: job.totalEnvelopes,
                      })}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Admin Erase Dialog */}
      <Dialog open={showEraseDialog} onOpenChange={setShowEraseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('erasure.admin.eraseDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SectionBanner tone="danger">{t('erasure.admin.eraseDialogWarning')}</SectionBanner>
            <SectionField label={t('erasure.admin.userId')} htmlFor="erase-user-id" required>
              <Input
                id="erase-user-id"
                data-testid="erase-user-id-input"
                value={eraseUserId}
                onChange={(e) => setEraseUserId(e.target.value)}
                placeholder={t('erasure.admin.userIdPlaceholder')}
              />
            </SectionField>
            <SectionField label={t('erasure.admin.justification')} htmlFor="erase-justification" required>
              <Textarea
                id="erase-justification"
                data-testid="erase-justification-input"
                value={eraseJustification}
                onChange={(e) => setEraseJustification(e.target.value)}
                placeholder={t('erasure.admin.justificationPlaceholder')}
                rows={3}
              />
            </SectionField>
            {emergencyOverrideEnabled && (
              <SectionField
                label={t('erasure.admin.coApproverPubkey')}
                htmlFor="erase-coapprover"
                help={t('erasure.admin.coApproverHelp')}
              >
                <Input
                  id="erase-coapprover"
                  data-testid="erase-coapprover-input"
                  value={eraseCoApproverPubkey}
                  onChange={(e) => setEraseCoApproverPubkey(e.target.value)}
                  placeholder={t('erasure.admin.coApproverPlaceholder')}
                />
              </SectionField>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEraseDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="erase-confirm-btn"
              onClick={handleAdminErase}
              disabled={erasing || !eraseUserId.trim() || !eraseJustification.trim()}
            >
              {erasing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('erasure.admin.confirmErase')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remote Wipe Dialog */}
      <Dialog open={showWipeDialog} onOpenChange={setShowWipeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('erasure.admin.wipeDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SectionBanner tone="warn">{t('erasure.admin.wipeDialogWarning')}</SectionBanner>
            <SectionField label={t('erasure.admin.userId')} htmlFor="wipe-user-id" required>
              <Input
                id="wipe-user-id"
                data-testid="wipe-user-id-input"
                value={wipeUserId}
                onChange={(e) => setWipeUserId(e.target.value)}
              />
            </SectionField>
            <SectionField label={t('erasure.admin.devicePubkey')} htmlFor="wipe-device-pubkey" required>
              <Input
                id="wipe-device-pubkey"
                data-testid="wipe-device-pubkey-input"
                value={wipeDevicePubkey}
                onChange={(e) => setWipeDevicePubkey(e.target.value)}
              />
            </SectionField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWipeDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="wipe-confirm-btn"
              onClick={handleRemoteWipe}
              disabled={wiping || !wipeUserId.trim() || !wipeDevicePubkey.trim()}
            >
              {wiping && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('erasure.admin.confirmWipe')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}

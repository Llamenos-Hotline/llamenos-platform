import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import {
  getA2pStatus,
  submitA2pBrand,
  submitA2pCampaign,
  skipA2p,
  type BrandInfo,
  type CampaignInfo,
} from '@/lib/api'
import type { A2pRegistrationState } from '@protocol/schemas'

interface A2pRegistrationPanelProps {
  hubId: string
}

const ENTITY_TYPES = ['PRIVATE_PROFIT', 'PUBLIC_PROFIT', 'NON_PROFIT', 'GOVERNMENT'] as const

const USE_CASES = [
  'LOW_VOLUME', '2FA', 'ACCOUNT_NOTIFICATION', 'CUSTOMER_CARE',
  'DELIVERY_NOTIFICATION', 'FRAUD_ALERT', 'HIGHER_EDUCATION', 'K12',
  'MARKETING', 'MIXED', 'POLITICAL', 'PUBLIC_SERVICE_ANNOUNCEMENT',
  'SECURITY_ALERT', 'SOCIAL', 'SWEEPSTAKE',
] as const

export function A2pRegistrationPanel({ hubId }: A2pRegistrationPanelProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [registration, setRegistration] = useState<A2pRegistrationState | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showBrandForm, setShowBrandForm] = useState(false)
  const [showCampaignForm, setShowCampaignForm] = useState(false)

  const [brandInfo, setBrandInfo] = useState<BrandInfo>({
    entityType: 'NON_PROFIT',
    companyName: '',
    ein: '',
    phone: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
    email: '',
  })

  const [campaignInfo, setCampaignInfo] = useState<CampaignInfo>({
    useCase: 'PUBLIC_SERVICE_ANNOUNCEMENT',
    description: '',
    helpMessage: '',
    optinMessage: '',
    optoutMessage: '',
    sampleMessages: [''],
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
  })

  useEffect(() => {
    loadStatus()
  }, [hubId])

  async function loadStatus() {
    setLoading(true)
    try {
      const status = await getA2pStatus(hubId)
      setRegistration(status)
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmitBrand() {
    setSubmitting(true)
    try {
      const result = await submitA2pBrand(hubId, brandInfo)
      setRegistration(result)
      setShowBrandForm(false)
      toast(t('channels.a2p.brandSubmitted'), 'success')
    } catch {
      toast(t('channels.a2p.brandError'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmitCampaign() {
    if (!registration) return
    setSubmitting(true)
    try {
      const result = await submitA2pCampaign(registration.id, hubId, campaignInfo)
      setRegistration(result)
      setShowCampaignForm(false)
      toast(t('channels.a2p.campaignSubmitted'), 'success')
    } catch {
      toast(t('channels.a2p.campaignError'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSkip() {
    setSubmitting(true)
    try {
      const result = await skipA2p(hubId)
      setRegistration(result)
      toast(t('channels.a2p.skipped'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  function updateBrand(updates: Partial<BrandInfo>) {
    setBrandInfo(prev => ({ ...prev, ...updates }))
  }

  function updateCampaign(updates: Partial<CampaignInfo>) {
    setCampaignInfo(prev => ({ ...prev, ...updates }))
  }

  function updateSampleMessage(index: number, value: string) {
    setCampaignInfo(prev => {
      const messages = [...prev.sampleMessages]
      messages[index] = value
      return { ...prev, sampleMessages: messages }
    })
  }

  function addSampleMessage() {
    setCampaignInfo(prev => ({
      ...prev,
      sampleMessages: [...prev.sampleMessages, ''],
    }))
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  const brandStatus = registration?.brandStatus ?? 'not_submitted'
  const campaignStatus = registration?.campaignStatus ?? 'not_submitted'
  const needsBrand = brandStatus === 'not_submitted' || brandStatus === 'failed'
  const needsCampaign = brandStatus === 'approved' && (campaignStatus === 'not_submitted' || campaignStatus === 'failed')
  const isComplete = brandStatus === 'approved' && campaignStatus === 'approved'
  const isSkipped = brandStatus === 'skipped'

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">{t('channels.a2p.title')}</h4>
        <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loading}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('channels.a2p.description')}
      </p>

      <div className="flex flex-wrap gap-2">
        <Badge
          variant="outline"
          className={
            isComplete ? 'text-green-600' :
            isSkipped ? 'text-muted-foreground' :
            brandStatus === 'pending' || campaignStatus === 'pending' ? 'text-yellow-600' :
            brandStatus === 'failed' || campaignStatus === 'failed' ? 'text-red-600' :
            'text-muted-foreground'
          }
        >
          {isComplete ? (
            <><CheckCircle2 className="mr-1 h-3 w-3" /> {t('channels.a2p.approved')}</>
          ) : isSkipped ? (
            t('channels.a2p.statusSkipped')
          ) : brandStatus === 'failed' || campaignStatus === 'failed' ? (
            <><XCircle className="mr-1 h-3 w-3" /> {t('channels.a2p.statusFailed')}</>
          ) : brandStatus === 'pending' || campaignStatus === 'pending' ? (
            <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> {t('channels.a2p.statusPending')}</>
          ) : (
            t('channels.a2p.statusNotSubmitted')
          )}
        </Badge>

        {registration?.error && (
          <div className="w-full rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950/30">
            <p className="text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="inline mr-1 h-3 w-3" />
              {registration.error}
            </p>
          </div>
        )}
      </div>

      {needsBrand && !showBrandForm && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowBrandForm(true)} data-testid="a2p-start-brand">
            {brandStatus === 'failed' ? t('channels.a2p.resubmitBrand') : t('channels.a2p.submitBrand')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleSkip} disabled={submitting}>
            {t('channels.a2p.skip')}
          </Button>
        </div>
      )}

      {showBrandForm && (
        <div className="space-y-3 rounded-lg border p-4" data-testid="a2p-brand-form">
          <h5 className="font-medium text-sm">{t('channels.a2p.brandFormTitle')}</h5>

          <div className="space-y-2">
            <Label>{t('channels.a2p.entityType')}</Label>
            <Select value={brandInfo.entityType} onValueChange={(v) => updateBrand({ entityType: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map(type => (
                  <SelectItem key={type} value={type}>
                    {t(`channels.a2p.entityTypes.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t('channels.a2p.companyName')}</Label>
              <Input value={brandInfo.companyName} onChange={e => updateBrand({ companyName: e.target.value })} data-testid="a2p-company-name" />
            </div>
            <div className="space-y-2">
              <Label>{t('channels.a2p.ein')}</Label>
              <Input value={brandInfo.ein} onChange={e => updateBrand({ ein: e.target.value })} placeholder="XX-XXXXXXX" data-testid="a2p-ein" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t('channels.a2p.phone')}</Label>
              <Input value={brandInfo.phone} onChange={e => updateBrand({ phone: e.target.value })} placeholder="+12125551234" />
            </div>
            <div className="space-y-2">
              <Label>{t('channels.a2p.email')}</Label>
              <Input type="email" value={brandInfo.email} onChange={e => updateBrand({ email: e.target.value })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.street')}</Label>
            <Input value={brandInfo.street} onChange={e => updateBrand({ street: e.target.value })} />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-2">
              <Label>{t('channels.a2p.city')}</Label>
              <Input value={brandInfo.city} onChange={e => updateBrand({ city: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t('channels.a2p.state')}</Label>
              <Input value={brandInfo.state} onChange={e => updateBrand({ state: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t('channels.a2p.postalCode')}</Label>
              <Input value={brandInfo.postalCode} onChange={e => updateBrand({ postalCode: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t('channels.a2p.country')}</Label>
              <Input value={brandInfo.country} onChange={e => updateBrand({ country: e.target.value })} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSubmitBrand} disabled={submitting || !brandInfo.companyName || !brandInfo.ein} data-testid="a2p-submit-brand">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('channels.a2p.submitBrand')}
            </Button>
            <Button variant="ghost" onClick={() => setShowBrandForm(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {needsCampaign && !showCampaignForm && (
        <Button size="sm" onClick={() => setShowCampaignForm(true)} data-testid="a2p-start-campaign">
          {campaignStatus === 'failed' ? t('channels.a2p.resubmitCampaign') : t('channels.a2p.submitCampaign')}
        </Button>
      )}

      {showCampaignForm && (
        <div className="space-y-3 rounded-lg border p-4" data-testid="a2p-campaign-form">
          <h5 className="font-medium text-sm">{t('channels.a2p.campaignFormTitle')}</h5>

          <div className="space-y-2">
            <Label>{t('channels.a2p.useCase')}</Label>
            <Select value={campaignInfo.useCase} onValueChange={(v) => updateCampaign({ useCase: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {USE_CASES.map(uc => (
                  <SelectItem key={uc} value={uc}>{uc.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.campaignDescription')}</Label>
            <Textarea value={campaignInfo.description} onChange={e => updateCampaign({ description: e.target.value })} rows={2} data-testid="a2p-campaign-desc" />
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.helpMessage')}</Label>
            <Input value={campaignInfo.helpMessage} onChange={e => updateCampaign({ helpMessage: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.optinMessage')}</Label>
            <Input value={campaignInfo.optinMessage} onChange={e => updateCampaign({ optinMessage: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.optoutMessage')}</Label>
            <Input value={campaignInfo.optoutMessage} onChange={e => updateCampaign({ optoutMessage: e.target.value })} />
          </div>

          <div className="space-y-2">
            <Label>{t('channels.a2p.sampleMessages')}</Label>
            {campaignInfo.sampleMessages.map((msg, i) => (
              <Input
                key={i}
                value={msg}
                onChange={e => updateSampleMessage(i, e.target.value)}
                placeholder={t('channels.a2p.sampleMessagePlaceholder', { num: i + 1 })}
              />
            ))}
            {campaignInfo.sampleMessages.length < 5 && (
              <Button variant="ghost" size="sm" onClick={addSampleMessage}>
                {t('channels.a2p.addSampleMessage')}
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSubmitCampaign} disabled={submitting || !campaignInfo.description} data-testid="a2p-submit-campaign">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('channels.a2p.submitCampaign')}
            </Button>
            <Button variant="ghost" onClick={() => setShowCampaignForm(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {isComplete && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
          <p className="text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="inline mr-1 h-3 w-3" />
            {t('channels.a2p.approvedMessage')}
          </p>
          {registration?.brandSidMasked && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('channels.a2p.brandSid')}: ****{registration.brandSidMasked}
            </p>
          )}
          {registration?.campaignSidMasked && (
            <p className="text-xs text-muted-foreground">
              {t('channels.a2p.campaignSid')}: ****{registration.campaignSidMasked}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

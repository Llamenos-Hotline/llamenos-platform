import { useTranslation } from 'react-i18next'
import { CHANNEL_LABELS, type ChannelType } from '@shared/types'
import { LANGUAGE_MAP } from '@shared/languages'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Phone,
  MessageSquare,
  Globe,
  Shield,
  FileText,
  Check,
  AlertCircle,
  Rocket,
  Loader2,
} from 'lucide-react'
import type { SetupData } from './SetupWizard'

interface Props {
  data: SetupData
  onComplete: () => void
  saving: boolean
  headingRef?: React.RefObject<HTMLHeadingElement | null>
}

const CHANNEL_ICONS: Record<string, typeof Phone> = {
  voice: Phone,
  sms: MessageSquare,
  whatsapp: Globe,
  signal: Shield,
  reports: FileText,
}

const STATUS_STYLES = {
  configured: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
}

export function StepSummary({ data, onComplete, saving, headingRef }: Props) {
  const { t } = useTranslation()
  const langConfig = LANGUAGE_MAP[data.language]

  function getChannelStatus(channel: ChannelType): 'configured' | 'pending' {
    switch (channel) {
      case 'voice':
      case 'sms':
        return data.providerValidated ? 'configured' : 'pending'
      case 'whatsapp':
        return data.whatsappValidated ? 'configured' : 'pending'
      case 'signal':
        return data.signalValidated ? 'configured' : 'pending'
      case 'reports':
        return 'configured'
      default:
        return 'pending'
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">{t('setup.summaryTitle')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('setup.summaryDescription')}</p>
      </div>

      {/* Identity summary */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">{t('setup.stepIdentity')}</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('setup.hotlineName')}</span>
            <span className="font-medium">{data.hotlineName || '-'}</span>
          </div>
          {data.organization && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('setup.organization')}</span>
              <span className="font-medium">{data.organization}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('setup.primaryLanguage')}</span>
            <span className="font-medium">{langConfig ? `${langConfig.flag} ${langConfig.label}` : data.language}</span>
          </div>
        </div>
      </Card>

      {/* Channels summary */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">{t('setup.stepChannels')}</h3>
        {data.selectedChannels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('setup.noChannelsSelected')}</p>
        ) : (
          <div className="space-y-2">
            {data.selectedChannels.map(channel => {
              const status = getChannelStatus(channel)
              const Icon = CHANNEL_ICONS[channel] || MessageSquare
              return (
                <div key={channel} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{CHANNEL_LABELS[channel]}</span>
                  </div>
                  <Badge variant="outline" className={`text-[10px] border-0 ${STATUS_STYLES[status]}`}>
                    {status === 'configured' ? (
                      <><Check className="h-3 w-3" /> {t('setup.configured')}</>
                    ) : (
                      <><AlertCircle className="h-3 w-3" /> {t('setup.pending')}</>
                    )}
                  </Badge>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Settings summary */}
      {(data.selectedChannels.includes('voice') || data.selectedChannels.includes('sms') || data.selectedChannels.includes('whatsapp') || data.selectedChannels.includes('signal')) && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">{t('setup.stepSettings')}</h3>
          <div className="space-y-2 text-sm">
            {data.selectedChannels.includes('voice') && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('setup.queueTimeout')}</span>
                  <span className="font-medium">{data.voiceSettings.queueTimeout}s</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('setup.voicemailEnabled')}</span>
                  <span className="font-medium">{data.voiceSettings.voicemailEnabled ? t('common.yes') : t('common.no')}</span>
                </div>
              </>
            )}
            {(data.selectedChannels.includes('sms') || data.selectedChannels.includes('whatsapp') || data.selectedChannels.includes('signal')) && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('setup.inactivityTimeout')}</span>
                  <span className="font-medium">{data.messagingSettings.inactivityTimeout}m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('setup.maxConcurrent')}</span>
                  <span className="font-medium">{data.messagingSettings.maxConcurrent}</span>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {/* Launch button */}
      <Button data-testid="setup-complete-btn" onClick={() => onComplete()} disabled={saving} className="w-full" size="lg">
        {saving ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</>
        ) : (
          <><Rocket className="h-4 w-4" /> {t('setup.goToDashboard')}</>
        )}
      </Button>
    </div>
  )
}

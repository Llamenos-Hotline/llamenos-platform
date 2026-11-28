import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Shield, ShieldAlert, ShieldOff, ShieldCheck } from 'lucide-react'
import type { TransportSecurity } from '@shared/types'
import type { A2pRegistrationState } from '@protocol/schemas'

type A2pStatus = A2pRegistrationState['brandStatus'] | A2pRegistrationState['campaignStatus']

/** i18n key (under `channels.a2p.status`) for every registration status the server can report. */
const A2P_STATUS_KEY: Record<A2pStatus, string> = {
  not_submitted: 'notSubmitted',
  pending: 'pending',
  approved: 'approved',
  failed: 'failed',
  rejected: 'rejected',
  suspended: 'suspended',
  skipped: 'skipped',
}

/** Statuses the carrier or our submission turned down — shown in the failure colour. */
const A2P_FAILED: ReadonlySet<A2pStatus> = new Set(['failed', 'rejected', 'suspended'])

interface ChannelStatusBannerProps {
  channelName: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  security: TransportSecurity
  a2pBrandStatus?: A2pStatus
  a2pCampaignStatus?: A2pStatus
}

const securityIcons: Record<TransportSecurity, typeof Shield> = {
  none: ShieldOff,
  'provider-encrypted': ShieldAlert,
  'e2ee-to-bridge': ShieldCheck,
  e2ee: Shield,
}

const securityColors: Record<TransportSecurity, string> = {
  none: 'text-red-600',
  'provider-encrypted': 'text-yellow-600',
  'e2ee-to-bridge': 'text-blue-600',
  e2ee: 'text-green-600',
}

export function ChannelStatusBanner({
  channelName,
  enabled,
  onEnabledChange,
  security,
  a2pBrandStatus,
  a2pCampaignStatus,
}: ChannelStatusBannerProps) {
  const { t } = useTranslation()
  const SecurityIcon = securityIcons[security]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${channelName}-enabled`} className="font-medium">
            {t('channels.shared.enableChannel', { channel: channelName })}
          </Label>
        </div>
        <Switch
          id={`${channelName}-enabled`}
          checked={enabled}
          onCheckedChange={onEnabledChange}
          data-testid={`${channelName}-enabled-toggle`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={securityColors[security]}>
          <SecurityIcon className="mr-1 h-3 w-3" />
          {t(`channels.shared.security.${security}`)}
        </Badge>

        {a2pBrandStatus && a2pBrandStatus !== 'skipped' && (
          <Badge
            variant="outline"
            className={
              a2pBrandStatus === 'approved' ? 'text-green-600' :
              a2pBrandStatus === 'pending' ? 'text-yellow-600' :
              A2P_FAILED.has(a2pBrandStatus) ? 'text-red-600' :
              'text-muted-foreground'
            }
          >
            {t('channels.a2p.brandStatus', { status: t(`channels.a2p.status.${A2P_STATUS_KEY[a2pBrandStatus]}`) })}
          </Badge>
        )}

        {a2pCampaignStatus && a2pCampaignStatus !== 'skipped' && (
          <Badge
            variant="outline"
            className={
              a2pCampaignStatus === 'approved' ? 'text-green-600' :
              a2pCampaignStatus === 'pending' ? 'text-yellow-600' :
              A2P_FAILED.has(a2pCampaignStatus) ? 'text-red-600' :
              'text-muted-foreground'
            }
          >
            {t('channels.a2p.campaignStatus', { status: t(`channels.a2p.status.${A2P_STATUS_KEY[a2pCampaignStatus]}`) })}
          </Badge>
        )}
      </div>
    </div>
  )
}

import type { LucideIcon } from 'lucide-react'
import type { MessagingConfig } from '@protocol/schemas'
import type { TransportSecurity } from '@shared/types'

export interface ChannelConfigProps {
  config: MessagingConfig
  onConfigChange: (config: MessagingConfig) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export interface ChannelConfigEntry {
  component: React.ComponentType<ChannelConfigProps>
  label: string
  icon: LucideIcon
  security: TransportSecurity
  hasA2pApproval: boolean
  requiresTelephonyProvider: boolean
}

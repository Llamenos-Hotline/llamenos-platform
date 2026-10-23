import { useTranslation } from 'react-i18next'
import { useWebhookUrls } from '@/lib/queries/provider-setup'
import { WebhookConfirmation } from './WebhookConfirmation'

interface VoiceWebhookConfirmationProps {
  onReconfigure?: () => void
}

/**
 * The voice webhook URLs to paste into a telephony provider, as the SERVER
 * builds them — the same ones its auto-configuration registers (#2068). This
 * used to assemble `${window.location.origin}/api/telephony/status`: the
 * webview's origin rather than the server's, and a route that was never
 * mounted, so a provider configured from this panel reported every call's
 * status to a 404.
 */
export function VoiceWebhookConfirmation({ onReconfigure }: VoiceWebhookConfirmationProps) {
  const { t } = useTranslation()
  const { data, error, isPending } = useWebhookUrls()

  if (error) {
    return (
      <p className="text-xs text-destructive" data-testid="webhook-urls-error">
        {t('common.error')}: {error instanceof Error ? error.message : String(error)}
      </p>
    )
  }
  if (isPending) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="webhook-urls-loading">
        {t('common.loading')}
      </p>
    )
  }
  return (
    <WebhookConfirmation
      urls={[
        { label: t('setup.webhooks.voice', { defaultValue: 'Voice' }), url: data.voiceIncoming },
        { label: t('setup.webhooks.status', { defaultValue: 'Status' }), url: data.voiceStatus },
      ]}
      visible={true}
      onReconfigure={onReconfigure}
    />
  )
}

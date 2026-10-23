import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import type { MessagingChannelType } from '@protocol/schemas/settings'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useToast } from '@/lib/toast'
import { useWebhookUrls } from '@/lib/queries/provider-setup'

interface WebhookUrlFieldProps {
  channel: MessagingChannelType
  label: string
}

/**
 * A messaging channel's inbound webhook URL, as the SERVER builds it (#2068).
 * The URL is what an admin pastes into the provider's dashboard, so it must be
 * the server's public webhook origin and a mounted route — neither of which
 * this webview can know. While it loads nothing is offered to copy, and a
 * failed load says so instead of showing a guessed URL.
 */
export function WebhookUrlField({ channel, label }: WebhookUrlFieldProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data, error, isPending } = useWebhookUrls()
  const url = data?.messaging[channel]

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {error ? (
        <p className="text-xs text-destructive" data-testid={`${channel}-webhook-url-error`}>
          {t('common.error')}: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : isPending || !url ? (
        <p className="text-xs text-muted-foreground" data-testid={`${channel}-webhook-url-loading`}>
          {t('common.loading')}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs" data-testid={`${channel}-webhook-url`}>{url}</code>
          <Button
            variant="outline"
            size="icon"
            onClick={() => { navigator.clipboard.writeText(url); toast(t('common.success'), 'success') }}
            aria-label={t('a11y.copyToClipboard')}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

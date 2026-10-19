import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateSpamSettings, type SpamSettings } from '@/lib/api'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ShieldAlert, Bot, Timer } from 'lucide-react'

interface Props {
  settings: SpamSettings
  onChange: (settings: SpamSettings) => void
  onConfirmToggle: (key: string, newValue: boolean) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function SpamSection({ settings, onChange, onConfirmToggle, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()

  return (
    <SettingsSection
      id="spam"
      title={t('spam.title')}
      icon={<ShieldAlert className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-0.5">
            <Label>{t('spam.voiceCaptcha')}</Label>
            <p className="text-xs text-muted-foreground">{t('spam.voiceCaptchaDescription')}</p>
          </div>
        </div>
        <Switch
          data-testid="spam-captcha-toggle"
          checked={settings.voiceCaptchaEnabled}
          onCheckedChange={(checked) => onConfirmToggle('captcha', checked)}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <Timer className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-0.5">
            <Label>{t('spam.rateLimiting')}</Label>
            <p className="text-xs text-muted-foreground">{t('spam.rateLimitingDescription')}</p>
          </div>
        </div>
        <Switch
          checked={settings.rateLimitEnabled}
          onCheckedChange={(checked) => onConfirmToggle('rateLimit', checked)}
        />
      </div>

      {settings.rateLimitEnabled && (
        <div className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="max-calls">{t('spam.maxCallsPerMinute')}</Label>
            <Input
              id="max-calls"
              type="number"
              value={settings.maxCallsPerMinute}
              onChange={async (e) => {
                try {
                  const val = parseInt(e.target.value) || 3
                  const res = await updateSpamSettings({ maxCallsPerMinute: val })
                  onChange(res)
                } catch {
                  toast(t('common.error'), 'error')
                }
              }}
              min={1}
              max={60}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="block-duration">{t('spam.blockDuration')}</Label>
            <Input
              id="block-duration"
              type="number"
              value={settings.blockDurationMinutes}
              onChange={async (e) => {
                try {
                  const val = parseInt(e.target.value) || 30
                  const res = await updateSpamSettings({ blockDurationMinutes: val })
                  onChange(res)
                } catch {
                  toast(t('common.error'), 'error')
                }
              }}
              min={1}
              max={1440}
            />
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

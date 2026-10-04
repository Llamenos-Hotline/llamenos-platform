import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { listIvrAudio, uploadIvrAudio, deleteIvrAudio, downloadIvrAudio, type IvrAudioRecording } from '@/lib/api'
import { SettingsSection } from '@/components/settings-section'
import { Badge } from '@/components/ui/badge'
import { Volume2 } from 'lucide-react'
import { AudioRecorder } from '@/components/audio-recorder'
import { LANGUAGE_MAP } from '@shared/languages'

interface Props {
  ivrEnabled: string[]
  recordings: IvrAudioRecording[]
  onRecordingsChange: (recordings: IvrAudioRecording[]) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

const PROMPT_TYPES = ['greeting', 'pleaseHold', 'waitMessage', 'rateLimited', 'captchaPrompt'] as const

export function VoicePromptsSection({ ivrEnabled, recordings, onRecordingsChange, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [audioSaving, setAudioSaving] = useState<string | null>(null)

  return (
    <SettingsSection
      id="voice-prompts"
      title={t('ivrAudio.title')}
      description={t('ivrAudio.description')}
      icon={<Volume2 className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {PROMPT_TYPES.map(promptType => (
        <div key={promptType} className="space-y-2">
          <h4 className="text-sm font-medium">{t(`ivrAudio.prompt.${promptType}`)}</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ivrEnabled.map(langCode => {
              const lang = LANGUAGE_MAP[langCode]
              if (!lang) return null
              const existing = recordings.find(r => r.promptType === promptType && r.language === langCode)
              const key = `${promptType}:${langCode}`
              return (
                <div key={key} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{lang.flag} {lang.label}</span>
                    {existing && (
                      <Badge variant="secondary" className="text-[10px]">{t('ivrAudio.uploaded')}</Badge>
                    )}
                  </div>
                  <AudioRecorder
                    existing={existing ? { version: existing.uploadedAt, load: () => downloadIvrAudio(promptType, langCode) } : undefined}
                    onRecorded={async (blob) => {
                      setAudioSaving(key)
                      try {
                        await uploadIvrAudio(promptType, langCode, blob)
                        const res = await listIvrAudio()
                        onRecordingsChange(res.recordings)
                        toast(t('common.success'), 'success')
                      } catch {
                        toast(t('common.error'), 'error')
                      } finally {
                        setAudioSaving(null)
                      }
                    }}
                    onDelete={existing ? async () => {
                      setAudioSaving(key)
                      try {
                        await deleteIvrAudio(promptType, langCode)
                        onRecordingsChange(recordings.filter(r => !(r.promptType === promptType && r.language === langCode)))
                        toast(t('common.success'), 'success')
                      } catch {
                        toast(t('common.error'), 'error')
                      } finally {
                        setAudioSaving(null)
                      }
                    } : undefined}
                  />
                  {audioSaving === key && (
                    <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </SettingsSection>
  )
}

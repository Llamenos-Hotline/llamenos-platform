import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createBlast } from '@/lib/api'
import type { Blast } from '@/lib/api'
import type { CreateBlastBody } from '@protocol/schemas'
import { useToast } from '@/lib/toast'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Save, CalendarClock, Plus, X, Globe } from 'lucide-react'
import { MediaAttachmentField } from '@/components/blast/media-attachment-field'
import { SchedulePicker } from '@/components/blast/schedule-picker'
import { LANGUAGES } from '@llamenos/i18n'

interface BlastComposerProps {
  onCreated: (blast: Blast) => void
  onCancel: () => void
}

interface LangContent {
  body: string
  mediaUrl: string
}

function isValidMediaUrl(url: string): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function BlastComposer({ onCreated, onCancel }: BlastComposerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [channels, setChannels] = useState<CreateBlastBody['channels']>(['sms'])
  const [scheduledAt, setScheduledAt] = useState('')
  const [saving, setSaving] = useState(false)

  // Multi-language state
  const [activeLangs, setActiveLangs] = useState<string[]>(['en'])
  const [activeLang, setActiveLang] = useState('en')
  const [defaultLanguage, setDefaultLanguage] = useState('en')
  const [langContent, setLangContent] = useState<Record<string, LangContent>>({
    en: { body: '', mediaUrl: '' },
  })
  const [showLangPicker, setShowLangPicker] = useState(false)

  // Only the channels `createBlastBodySchema` accepts: the server refuses a blast that names any other.
  const channelOptions: { value: CreateBlastBody['channels'][number]; label: string }[] = [
    { value: 'sms', label: 'SMS' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'signal', label: 'Signal' },
  ]

  const currentContent = langContent[activeLang] ?? { body: '', mediaUrl: '' }
  const isScheduled = scheduledAt.length > 0

  // Validate all language tabs have content
  const allLangsValid = activeLangs.every(lang => {
    const c = langContent[lang]
    return c && c.body.trim().length > 0 && isValidMediaUrl(c.mediaUrl)
  })
  const canSubmit = name.trim().length > 0 && allLangsValid

  function updateLangContent(lang: string, field: keyof LangContent, value: string) {
    setLangContent(prev => ({
      ...prev,
      [lang]: { ...prev[lang], [field]: value },
    }))
  }

  function addLanguage(code: string) {
    if (activeLangs.includes(code)) return
    setActiveLangs(prev => [...prev, code])
    setLangContent(prev => ({
      ...prev,
      [code]: { body: '', mediaUrl: '' },
    }))
    setActiveLang(code)
    setShowLangPicker(false)
  }

  function removeLanguage(code: string) {
    if (activeLangs.length <= 1) return
    setActiveLangs(prev => prev.filter(l => l !== code))
    setLangContent(prev => {
      const next = { ...prev }
      delete next[code]
      return next
    })
    if (activeLang === code) setActiveLang(activeLangs[0] === code ? activeLangs[1] : activeLangs[0])
    if (defaultLanguage === code) setDefaultLanguage(activeLangs[0] === code ? activeLangs[1] : activeLangs[0])
  }

  async function handleSave() {
    if (!canSubmit) {
      toast(t('blasts.fillRequired'), 'error')
      return
    }
    setSaving(true)
    try {
      // Single-language: submit in old format for backward compat
      // Multi-language: submit as Record<langCode, { body, mediaUrl? }>
      let content: { body: string; mediaUrl?: string } | Record<string, { body: string; mediaUrl?: string }>
      if (activeLangs.length === 1) {
        const c = langContent[activeLangs[0]]
        content = {
          body: c.body.trim(),
          ...(c.mediaUrl ? { mediaUrl: c.mediaUrl.trim() } : {}),
        }
      } else {
        content = {}
        for (const lang of activeLangs) {
          const c = langContent[lang]
          content[lang] = {
            body: c.body.trim(),
            ...(c.mediaUrl ? { mediaUrl: c.mediaUrl.trim() } : {}),
          }
        }
      }

      const res = await createBlast({
        name: name.trim(),
        content,
        defaultLanguage: activeLangs.length > 1 ? defaultLanguage : undefined,
        channels,
        ...(scheduledAt ? { scheduledAt } : {}),
      })
      onCreated(res.blast)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const availableLanguages = LANGUAGES.filter(l => !activeLangs.includes(l.code))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('blasts.newBlast')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="blast-name">{t('blasts.blastName')}</Label>
          <Input
            id="blast-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('blasts.blastNamePlaceholder')}
            data-testid="blast-name"
          />
        </div>

        {/* Language tabs */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <Label>{t('blasts.languages')}</Label>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {activeLangs.map(code => {
              const lang = LANGUAGES.find(l => l.code === code)
              return (
                <button
                  key={code}
                  type="button"
                  data-testid={`lang-tab-${code}`}
                  onClick={() => setActiveLang(code)}
                  className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    activeLang === code
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <span>{lang?.flag ?? code.toUpperCase()}</span>
                  <span>{lang?.label ?? code}</span>
                  {code === defaultLanguage && activeLangs.length > 1 && (
                    <span className="ml-1 text-[10px] text-muted-foreground">({t('blasts.default')})</span>
                  )}
                  {activeLangs.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeLanguage(code) }}
                      className="ml-1 rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('blasts.removeLanguage')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </button>
              )
            })}
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="add-language-btn"
                onClick={() => setShowLangPicker(!showLangPicker)}
                className="h-7 px-2"
              >
                <Plus className="h-3 w-3" />
                {t('blasts.addLanguage')}
              </Button>
              {showLangPicker && availableLanguages.length > 0 && (
                <div className="absolute left-0 top-full z-10 mt-1 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                  {availableLanguages.map(lang => (
                    <button
                      key={lang.code}
                      type="button"
                      data-testid={`lang-option-${lang.code}`}
                      onClick={() => addLanguage(lang.code)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                    >
                      <span className="font-medium">{lang.flag}</span>
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Default language selector (only visible with multiple languages) */}
        {activeLangs.length > 1 && (
          <div className="space-y-2">
            <Label>{t('blasts.defaultLanguage')}</Label>
            <div className="flex flex-wrap gap-1">
              {activeLangs.map(code => {
                const lang = LANGUAGES.find(l => l.code === code)
                return (
                  <button
                    key={code}
                    type="button"
                    data-testid={`default-lang-${code}`}
                    onClick={() => setDefaultLanguage(code)}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                      defaultLanguage === code
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    {lang?.flag ?? code.toUpperCase()} {lang?.label ?? code}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t('blasts.defaultLanguageHint')}</p>
          </div>
        )}

        {/* Message body for active language */}
        <div className="space-y-2">
          <Label htmlFor="blast-text">
            {t('blasts.messageText')}
            {activeLangs.length > 1 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({LANGUAGES.find(l => l.code === activeLang)?.label ?? activeLang})
              </span>
            )}
          </Label>
          <textarea
            id="blast-text"
            value={currentContent.body}
            onChange={(e) => updateLangContent(activeLang, 'body', e.target.value)}
            placeholder={t('blasts.messageTextPlaceholder')}
            className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="blast-text"
          />
          <p className="text-xs text-muted-foreground">{currentContent.body.length} {t('blasts.characters')}</p>
        </div>

        <div className="space-y-2">
          <Label>{t('blasts.channels')}</Label>
          <div className="flex flex-wrap gap-2">
            {channelOptions.map(ch => (
              <button
                key={ch.value}
                type="button"
                onClick={() => setChannels(prev =>
                  prev.includes(ch.value)
                    ? prev.filter(c => c !== ch.value)
                    : [...prev, ch.value]
                )}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  channels.includes(ch.value)
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                {ch.label}
              </button>
            ))}
          </div>
        </div>

        <MediaAttachmentField value={currentContent.mediaUrl} onChange={(v) => updateLangContent(activeLang, 'mediaUrl', v)} />

        <SchedulePicker value={scheduledAt} onChange={setScheduledAt} />

        <div className="flex gap-2">
          {isScheduled ? (
            <Button
              data-testid="blast-schedule-btn"
              onClick={handleSave}
              disabled={saving || !canSubmit}
            >
              <CalendarClock className="h-4 w-4" />
              {saving ? t('common.loading') : t('blasts.scheduleSend')}
            </Button>
          ) : (
            <Button
              data-testid="blast-send-btn"
              onClick={handleSave}
              disabled={saving || !canSubmit}
            >
              <Save className="h-4 w-4" />
              {saving ? t('common.loading') : t('blasts.saveDraft')}
            </Button>
          )}
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

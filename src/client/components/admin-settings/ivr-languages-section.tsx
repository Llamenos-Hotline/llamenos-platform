import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateIvrLanguages, type IvrLanguageSettings } from '@/lib/api'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Phone, ArrowUp, ArrowDown, TriangleAlert } from 'lucide-react'
import { LANGUAGES, LANGUAGE_MAP, IVR_MENU_MAX_LANGUAGES, ivrIndexToDigit } from '@shared/languages'

interface Props {
  settings: IvrLanguageSettings
  onChange: (settings: IvrLanguageSettings) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
  hubId?: string
}

export function IvrLanguagesSection({ settings, onChange, expanded, onToggle, statusSummary, hubId }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { enabledLanguages: enabled, uncoveredLanguageCount } = settings
  const menuFull = enabled.length >= IVR_MENU_MAX_LANGUAGES
  const maxLanguagesMessage = t('ivr.maxLanguagesReached', { max: IVR_MENU_MAX_LANGUAGES })

  const moveUp = async (code: string) => {
    const idx = enabled.indexOf(code)
    if (idx <= 0) return
    const next = [...enabled]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    await save(next)
  }

  const moveDown = async (code: string) => {
    const idx = enabled.indexOf(code)
    if (idx < 0 || idx >= enabled.length - 1) return
    const next = [...enabled]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    await save(next)
  }

  const toggle = async (code: string, checked: boolean) => {
    if (checked && menuFull) {
      toast(maxLanguagesMessage, 'error')
      return
    }
    const next = checked
      ? [...enabled, code]
      : enabled.filter(c => c !== code)
    await save(next)
  }

  const save = async (next: string[]) => {
    try {
      onChange(await updateIvrLanguages({ enabledLanguages: next }, hubId))
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <SettingsSection
      id="ivr-languages"
      title={t('ivr.title')}
      description={t('ivr.description')}
      icon={<Phone className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {/* Enabled languages — ordered, with reordering controls */}
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground mb-2">
          {t('ivr.enabledLanguages', { defaultValue: 'Enabled languages (ordered)' })}
        </h4>
        {enabled.map((code, index) => {
          const lang = LANGUAGE_MAP[code]
          if (!lang) return null
          const isLastEnabled = enabled.length === 1
          // Beyond the tenth position there is no key to press: the caller never
          // hears this language, so it shows no digit rather than a wrong one.
          const digit = ivrIndexToDigit(index)
          return (
            <div
              key={code}
              className={`flex items-center justify-between rounded-lg border px-4 py-2 ${digit ? 'border-border' : 'border-dashed border-muted-foreground/40'}`}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs font-mono w-8 justify-center" data-testid={`ivr-digit-${code}`}>
                  {digit || '–'}
                </Badge>
                <span className="text-sm">{lang.label}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"
                  disabled={index === 0}
                  onClick={() => moveUp(code)}
                  aria-label={`Move ${lang.label} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"
                  disabled={index === enabled.length - 1}
                  onClick={() => moveDown(code)}
                  aria-label={`Move ${lang.label} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <Switch
                  checked={true}
                  disabled={isLastEnabled}
                  onCheckedChange={() => toggle(code, false)}
                />
              </div>
            </div>
          )
        })}
      </div>

      {uncoveredLanguageCount > 0 && (
        <div role="status" data-testid="ivr-uncovered-flag" data-count={uncoveredLanguageCount} className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">{t('ivr.uncoveredLanguages', { count: uncoveredLanguageCount })}</p>
            <p className="text-xs text-muted-foreground">{t('ivr.uncoveredHint')}</p>
          </div>
        </div>
      )}

      {menuFull && (
        <p data-testid="ivr-menu-full" className="text-xs text-muted-foreground mt-1">{maxLanguagesMessage}</p>
      )}

      {/* Available languages — not yet enabled */}
      {(() => {
        const available = LANGUAGES.filter(l => !enabled.includes(l.code))
        if (available.length === 0) return null
        return (
          <div className="mt-4 space-y-1">
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              {t('ivr.availableLanguages', { defaultValue: 'Available languages' })}
            </h4>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {available.map(lang => (
                <div key={lang.code} className="flex items-center justify-between rounded-lg border border-border/50 px-4 py-2">
                  <span className="text-sm text-muted-foreground">{lang.label}</span>
                  <Switch
                    data-testid={`ivr-enable-${lang.code}`}
                    checked={false}
                    onCheckedChange={() => toggle(lang.code, true)}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {enabled.length === 1 && (
        <p className="text-xs text-muted-foreground">{t('ivr.atLeastOne')}</p>
      )}
    </SettingsSection>
  )
}

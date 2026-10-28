import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { updateMyProfile } from '@/lib/api'
import { setLanguage } from '@/lib/i18n'
import { useToast } from '@/lib/toast'
import { LANGUAGES } from '@shared/languages'
import { Globe, Languages, ArrowRight, Check } from 'lucide-react'
import { LogoMark } from '@/components/logo-mark'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export const Route = createFileRoute('/profile-setup')({
  component: ProfileSetupPage,
})

function ProfileSetupPage() {
  const { t, i18n } = useTranslation()
  const { name, profileCompleted, refreshProfile } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [uiLang, setUiLang] = useState(i18n.language || 'en')
  const [spokenLangs, setSpokenLangs] = useState<string[]>(['en'])
  const [saving, setSaving] = useState(false)

  // Navigate to dashboard once profile is completed (avoids race with root layout guards)
  useEffect(() => {
    if (profileCompleted) {
      navigate({ to: '/' })
    }
  }, [profileCompleted, navigate])

  function toggleSpokenLang(code: string) {
    setSpokenLangs(prev =>
      prev.includes(code)
        ? prev.filter(l => l !== code)
        : [...prev, code]
    )
  }

  async function handleComplete() {
    if (spokenLangs.length === 0) {
      toast(t('profile.selectLanguage'), 'error')
      return
    }
    setSaving(true)
    try {
      setLanguage(uiLang)
      await updateMyProfile({
        uiLanguage: uiLang,
        spokenLanguages: spokenLangs,
        profileCompleted: true,
      })
      await refreshProfile()
      // Navigation is handled by the useEffect watching profileCompleted
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
      </div>
      <Card className="relative z-10 w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3">
            <LogoMark size="xl" />
          </div>
          <CardTitle className="text-2xl">{t('profile.welcome')}</CardTitle>
          {name && (
            <CardDescription>
              {t('profile.setupDescription', { name })}
            </CardDescription>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {/* UI Language */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {t('profile.uiLanguage')}
            </div>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map(lang => (
                <button
                  key={lang.code}
                  type="button"
                  aria-pressed={uiLang === lang.code}
                  onClick={() => {
                    setUiLang(lang.code)
                    setLanguage(lang.code)
                  }}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    uiLang === lang.code
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <span>{lang.flag}</span>
                  {lang.label}
                  {uiLang === lang.code && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </div>

          {/* Spoken Languages */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Languages className="h-4 w-4 text-muted-foreground" />
              {t('profile.spokenLanguages')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('profile.spokenLanguagesHelp')}
            </p>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map(lang => (
                <button
                  key={lang.code}
                  type="button"
                  aria-pressed={spokenLangs.includes(lang.code)}
                  onClick={() => toggleSpokenLang(lang.code)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    spokenLangs.includes(lang.code)
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <span>{lang.flag}</span>
                  {lang.label}
                  {spokenLangs.includes(lang.code) && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </div>

          <Button
            onClick={handleComplete}
            disabled={saving || spokenLangs.length === 0}
            className="w-full"
            size="lg"
          >
            {saving ? t('common.loading') : (
              <>
                {t('profile.getStarted')}
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

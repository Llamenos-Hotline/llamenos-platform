import { type ReactNode, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Link as LinkIcon } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/**
 * Persists which settings sections are expanded across navigations via sessionStorage.
 */
export function usePersistedExpanded(storageKey: string, defaults: string[], deepLink?: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        const set = new Set(JSON.parse(saved) as string[])
        if (deepLink) set.add(deepLink)
        return set
      }
    } catch { /* ignore */ }
    const set = new Set(defaults)
    if (deepLink) set.add(deepLink)
    return set
  })

  // Handle deep link changes after initial mount (e.g. search-only navigation)
  useEffect(() => {
    if (deepLink) {
      setExpanded(prev => {
        if (prev.has(deepLink)) return prev
        const next = new Set(prev)
        next.add(deepLink)
        try { sessionStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* ignore */ }
        return next
      })
    }
  }, [deepLink, storageKey])

  const toggleSection = useCallback((id: string, open: boolean) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (open) next.add(id); else next.delete(id)
      try { sessionStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  return { expanded, toggleSection }
}

interface SettingsSectionProps {
  id: string
  title: string
  description?: string
  statusSummary?: string
  icon: ReactNode
  expanded: boolean
  onToggle: (open: boolean) => void
  basePath?: string
  children: ReactNode
}

export function SettingsSection({
  id,
  title,
  description,
  statusSummary,
  icon,
  expanded,
  onToggle,
  basePath,
  children,
}: SettingsSectionProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  function handleCopyLink() {
    const path = basePath || window.location.pathname
    const url = `${window.location.origin}${path}?section=${id}`
    navigator.clipboard.writeText(url).then(() => {
      toast(t('settings.linkCopied'), 'success')
      // Auto-clear clipboard after 30s (security pattern)
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {})
      }, 30_000)
    }).catch(() => {})
  }

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <Card id={id} data-testid={id} data-settings-section>
        {/* The trigger is the title <button> (inside the <h3>), so keyboard and screen-reader
            users get focus, Enter/Space and aria-expanded natively. Its ::after stretches over
            the header so the whole header stays click-to-toggle for mouse users; the copy-link
            button is a sibling (z-10, above the overlay) so no interactive control is nested. */}
        <CardHeader className="relative select-none transition-colors hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <CardTitle>
              <CollapsibleTrigger
                data-testid={`${id}-trigger`}
                aria-describedby={description ? `${id}-description` : undefined}
                className="flex cursor-pointer items-center gap-2 rounded-sm text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {icon}
                {title}
              </CollapsibleTrigger>
            </CardTitle>
            <div className="flex items-center gap-2">
              {!expanded && statusSummary && (
                <span className="hidden text-xs text-muted-foreground sm:block">{statusSummary}</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="relative z-10 h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={handleCopyLink}
                aria-label={t('settings.copyLink')}
              >
                <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform duration-200',
                  expanded && 'rotate-180'
                )}
              />
            </div>
          </div>
          {description && <CardDescription id={`${id}-description`}>{description}</CardDescription>}
        </CardHeader>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <CardContent className="space-y-4">
            {children}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

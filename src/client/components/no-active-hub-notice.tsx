import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'

/**
 * What a hub-owned view shows with no active hub (#2478). Deliberately not the
 * view's own "nothing here yet" state: "no hub selected" and "this hub has no
 * calls" are different claims, and only one of them is true.
 */
export function NoActiveHubNotice() {
  const { t } = useTranslation()
  return (
    <div data-testid="no-active-hub" role="status" className="py-8 text-center text-muted-foreground">
      <Building2 className="mx-auto mb-2 h-8 w-8 opacity-40" aria-hidden="true" />
      <p>{t('error.noHubSelected')}</p>
    </div>
  )
}

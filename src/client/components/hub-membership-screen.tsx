import { useTranslation } from 'react-i18next'
import { Building2, CloudOff, LogOut, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { useConfig } from '@/lib/config'

/**
 * Shown instead of the app when the signed-in user belongs to no hub.
 *
 * The alternative — the behaviour this replaces — was to activate the first hub
 * on the server and browse it anyway, which produced a dashboard that reported
 * "Off Shift" and "No notes yet" by way of 403s nobody saw (#1708). An empty
 * state the user cannot act on must say so.
 */
export function NoHubMembershipScreen() {
  const { t } = useTranslation()
  const { signOut } = useAuth()

  return (
    <div className="flex h-screen items-center justify-center" data-testid="no-hub-membership-screen">
      <div className="max-w-md space-y-6 px-6 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-muted">
          <Building2 className="h-10 w-10 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-bold" data-testid="no-hub-membership-title">
          {t('hubs.emptyTitle')}
        </h1>
        <p className="text-muted-foreground" data-testid="no-hub-membership-message">
          {t('hubs.emptyMessage')}
        </p>
        <Button variant="outline" onClick={signOut} data-testid="no-hub-membership-sign-out">
          <LogOut className="mr-2 h-4 w-4" />
          {t('common.logout')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Shown when `GET /api/hubs` could not be read at all.
 *
 * Deliberately a hard stop rather than a fallback: without a membership answer
 * there is no honest active hub, and picking one regardless is exactly the
 * defect in #1708. A visible failure with a retry is the safe behaviour.
 */
export function HubMembershipErrorScreen() {
  const { t } = useTranslation()
  const { refreshMemberHubs } = useConfig()

  return (
    <div className="flex h-screen items-center justify-center" data-testid="hub-membership-error-screen">
      <div className="max-w-md space-y-6 px-6 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
          <CloudOff className="h-10 w-10 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold" data-testid="hub-membership-error-title">
          {t('hubs.membershipLoadFailedTitle')}
        </h1>
        <p className="text-muted-foreground" data-testid="hub-membership-error-message">
          {t('hubs.membershipLoadFailedBody')}
        </p>
        <Button onClick={() => { void refreshMemberHubs() }} data-testid="hub-membership-error-retry">
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('common.retry')}
        </Button>
      </div>
    </div>
  )
}

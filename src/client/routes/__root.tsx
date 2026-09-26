import { createRootRoute, Outlet, Link, useNavigate, useLocation } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { useAuth } from '@/lib/auth'
import { useConfig, useHasMessaging } from '@/lib/config'
import { useTheme } from '@/lib/theme'
import { useEffect, useState, type ReactNode } from 'react'
import { setServerEventKeys } from '@/lib/platform'
import { useHubKeyLifecycle } from '@/lib/use-hub-key'
import { needsServerAddress } from '@/lib/api-config'
import { ServerAddressScreen } from '@/components/setup/ServerAddressScreen'
import { RelayProvider } from '@/lib/relay/context'
import { useCalls, useShiftStatus } from '@/lib/hooks'
import { CommandPalette, triggerCommandPalette } from '@/components/command-palette'
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog'
import { NoteSheet } from '@/components/note-sheet'
import { useKeyboardShortcuts } from '@/lib/use-keyboard-shortcuts'
import { LanguageSelect } from '@/components/language-select'
import { LogoMark } from '@/components/logo-mark'
import { DemoBanner } from '@/components/demo-banner'
import { NotificationPromptBanner } from '@/components/notification-prompt-banner'
import { UpdateChecker } from '@/components/UpdateChecker'
import { PanicWipeIndicator } from '@/components/panic-wipe-indicator'
import { DeviceWipeScreen } from '@/components/device-wipe-screen'
import { ErrorBoundary } from '@/components/error-boundary'
import { OfflineBanner } from '@/components/offline-banner'
import { UpdateRequiredScreen } from '@/components/update-required-screen'
import { HubSwitcher } from '@/components/hub-switcher'
import {
  LayoutDashboard,
  StickyNote,
  Clock,
  Users,
  ShieldBan,
  PhoneIncoming,
  MessageSquare,
  ScrollText,
  Settings,
  LogOut,
  FileText,
  Building2,
  PhoneCall,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  Search,
  HelpCircle,
  Megaphone,
  Contact,
  Briefcase,
  BookUser,
  FolderOpen,
  Calendar,
  Inbox,
  Radio,
  Shield,
  BarChart3,
} from 'lucide-react'

export const Route = createRootRoute({
  component: RootLayout,
})

function DeviceWipeOverlay() {
  const [wipeReason, setWipeReason] = useState<'user-erasure' | 'device-revocation' | 'admin-erasure' | null>(null)

  useEffect(() => {
    function onWiped(e: Event) {
      const reason = (e as CustomEvent<{ reason: string }>).detail?.reason as 'user-erasure' | 'device-revocation' | 'admin-erasure'
      setWipeReason(reason ?? 'admin-erasure')
    }
    window.addEventListener('device:wiped', onWiped)
    return () => window.removeEventListener('device:wiped', onWiped)
  }, [])

  if (!wipeReason) return null
  return <DeviceWipeScreen reason={wipeReason} />
}

function RootLayout() {
  const { t } = useTranslation()
  const { isAuthenticated, isLoading, profileCompleted, webauthnEnrollmentRequired } = useAuth()
  const { needsBootstrap, demoMode, isLoading: configLoading } = useConfig()
  const navigate = useNavigate()
  const location = useLocation()

  // A packaged desktop build with no backend configured yet (#738) — nothing
  // else can safely render until the user tells us which server to talk to.
  // `needsServerAddress()` reads a value set once at boot (main.tsx awaits
  // initApiBase() before rendering) and only changes via a full page reload —
  // saving a new address reloads the whole app (see ServerAddressScreen)
  // rather than flipping local state, so ConfigProvider/AuthProvider and
  // every other "fetch once at mount" provider re-initializes cleanly against
  // the newly-configured backend instead of staying stuck on stale defaults
  // fetched (and failed) before any address was known.
  const serverAddressConfigured = !needsServerAddress()

  // Nostr relay connection is handled by NostrProvider in AuthenticatedLayout

  useEffect(() => {
    // Wait for both auth and config to finish loading before redirecting
    if (serverAddressConfigured && !isLoading && !configLoading && !isAuthenticated && location.pathname !== '/login' && location.pathname !== '/onboarding' && location.pathname !== '/link-device' && location.pathname !== '/setup') {
      // If no admin exists, redirect to setup wizard (which includes bootstrap)
      if (needsBootstrap) {
        navigate({ to: '/setup' })
      } else {
        // Store the current path so we can return after PIN unlock
        if (location.pathname !== '/') {
          sessionStorage.setItem('returnTo', location.pathname)
        }
        navigate({ to: '/login' })
      }
    }
  }, [serverAddressConfigured, isLoading, configLoading, isAuthenticated, location.pathname, navigate, needsBootstrap])

  useEffect(() => {
    if (!isLoading && isAuthenticated && (location.pathname === '/login')) {
      navigate({ to: profileCompleted ? '/' : '/profile-setup' })
    }
  }, [isLoading, isAuthenticated, location.pathname, navigate, profileCompleted])

  // Redirect to profile setup if not completed (skip during setup wizard)
  useEffect(() => {
    if (!isLoading && isAuthenticated && !profileCompleted && location.pathname !== '/profile-setup' && location.pathname !== '/login' && location.pathname !== '/setup') {
      navigate({ to: '/profile-setup' })
    }
  }, [isLoading, isAuthenticated, profileCompleted, location.pathname, navigate])

  // Redirect away from profile setup once completed
  useEffect(() => {
    if (!isLoading && isAuthenticated && profileCompleted && location.pathname === '/profile-setup') {
      navigate({ to: '/' })
    }
  }, [isLoading, isAuthenticated, profileCompleted, location.pathname, navigate])

  // WebAuthn enrollment enforcement: redirect to settings#passkeys when passkey registration is required
  useEffect(() => {
    if (!isLoading && isAuthenticated && profileCompleted && webauthnEnrollmentRequired) {
      const allowedPaths = ['/settings', '/login', '/setup']
      if (!allowedPaths.includes(location.pathname)) {
        navigate({ to: '/settings', search: { section: 'passkeys' } })
      }
    }
  }, [isLoading, isAuthenticated, profileCompleted, webauthnEnrollmentRequired, location.pathname, navigate])

  // PanicWipeIndicator renders at root level unconditionally so it persists
  // across auth state changes during a wipe (when keyManager.wipeKey() fires,
  // isAuthenticated flips but the overlay must remain visible)
  let content: ReactNode

  if (!serverAddressConfigured) {
    content = (
      <ServerAddressScreen onConfigured={() => window.location.reload()} />
    )
  } else if (isLoading) {
    content = (
      <div className="flex h-screen items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <LogoMark size="sm" className="animate-pulse" />
          {t('common.loading')}
        </div>
      </div>
    )
  } else if (!isAuthenticated || !profileCompleted) {
    // Only render Outlet for public routes — prevent protected route components
    // from mounting and making API calls before the redirect effect fires
    const publicPaths = ['/login', '/onboarding', '/profile-setup', '/setup', '/link-device', '/preferences']
    if (!publicPaths.includes(location.pathname)) {
      content = (
        <div className="flex h-screen items-center justify-center">
          <div className="flex items-center gap-2 text-muted-foreground">
            <LogoMark size="sm" className="animate-pulse" />
          </div>
        </div>
      )
    } else {
      content = (
        <>
          {demoMode && <DemoBanner />}
          <Outlet />
        </>
      )
    }
  } else {
    content = <RelayWrappedLayout />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <UpdateRequiredScreen />
      <PanicWipeIndicator />
      <DeviceWipeOverlay />
      <OfflineBanner />
      <ErrorBoundary scope="root">
        {content}
      </ErrorBoundary>
    </QueryClientProvider>
  )
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/**
 * Wraps AuthenticatedLayout with RelayProvider for WebSocket connectivity.
 * Separated so the RelayProvider has access to both auth and config contexts.
 *
 * Challenge-response auth uses Ed25519 via Rust CryptoState.
 */
function RelayWrappedLayout() {
  const { serverPubkey, wsRelayUrl } = useConfig()
  const { publicKey, serverEventKeyHex, serverEventKeyPrevHex, eventKeyEpoch } = useAuth()

  // Load (or, for its creator, create) the active hub's key into Rust.
  useHubKeyLifecycle()

  // Push epoch-scoped server event keys to Rust CryptoState (H2 hardening —
  // keys never stay in JS memory longer than needed for the IPC call)
  useEffect(() => {
    if (serverEventKeyHex && eventKeyEpoch !== undefined) {
      const keys: Array<[number, string]> = [[eventKeyEpoch, serverEventKeyHex]]
      if (serverEventKeyPrevHex) {
        keys.push([eventKeyEpoch - 1, serverEventKeyPrevHex])
      }
      setServerEventKeys(keys).catch((err: unknown) => {
        console.error('[relay] Failed to push event keys to Rust:', err)
      })
    }
  }, [serverEventKeyHex, serverEventKeyPrevHex, eventKeyEpoch])

  return (
    <RelayProvider
      relayUrl={wsRelayUrl}
      serverPubkey={serverPubkey}
      devicePubkey={publicKey ?? undefined}
      isAuthenticated={true}
    >
      <AuthenticatedLayout />
    </RelayProvider>
  )
}

function AuthenticatedLayout() {
  const { t } = useTranslation()
  const { isAdmin, signOut, name, sessionExpiring, sessionExpired, renewSession, hasPermission, primaryRoleName } = useAuth()
  const { hotlineName, hotlineNumber, channels, demoMode, currentHubId } = useConfig()
  const hasMessaging = useHasMessaging()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { currentCall } = useCalls()
  const { onShift, currentShift, nextShift } = useShiftStatus()
  useKeyboardShortcuts()

  // Close sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen">
      {/* Skip link */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">
        {t('a11y.skipToContent')}
      </a>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav data-testid="nav-sidebar" className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform md:static md:visible md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full invisible'}`}>
        <div className="border-b border-sidebar-border px-4 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <LogoMark size="sm" />
              <p className="text-lg font-bold text-sidebar-foreground">{hotlineName}</p>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="md:hidden text-muted-foreground hover:text-foreground" aria-label={t('a11y.closeSidebar')}>
              <X className="h-5 w-5" />
            </button>
          </div>
          {name && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                  {name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium text-sidebar-foreground">{name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{primaryRoleName}</p>
                </div>
              </div>
              {/* In-call indicator */}
              {currentCall && (
                <div className="flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2 py-1">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                  <PhoneCall className="h-3 w-3 text-blue-500" />
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-300">{t('dashboard.onCall')}</span>
                </div>
              )}
              {/* Shift status indicator */}
              {!currentCall && (
                <div className="flex items-center gap-1.5 px-2">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${onShift ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <span className="text-xs text-muted-foreground">
                    {onShift && currentShift
                      ? `${currentShift.encryptedName} — ${t('shifts.until')} ${currentShift.endTime}`
                      : nextShift
                        ? `${t('shifts.nextShift')}: ${nextShift.encryptedName} ${t('shifts.days.' + DAY_NAMES[nextShift.day])} ${nextShift.startTime}`
                        : t('shifts.noShiftsAssigned')
                    }
                  </span>
                </div>
              )}
              {/* Hotline number */}
              {hotlineNumber && (
                <div className="flex items-center gap-1.5 px-2">
                  <PhoneIncoming className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-xs text-muted-foreground">{hotlineNumber}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <HubSwitcher />
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
          {hasPermission('reports:create') && !hasPermission('calls:answer') ? (
            <>
              {/* Reporter-specific nav: reports and help */}
              <NavLink to="/reports" icon={<FileText className="h-4 w-4" />}>
                {t('nav.reports', { defaultValue: 'My Reports' })}
              </NavLink>
              <NavLink to="/help" icon={<HelpCircle className="h-4 w-4" />}>
                {t('nav.help', { defaultValue: 'Help' })}
              </NavLink>
            </>
          ) : (
            <>
              <NavLink to="/" icon={<LayoutDashboard className="h-4 w-4" />}>{t('nav.dashboard')}</NavLink>
              <NavLink to="/notes" icon={<StickyNote className="h-4 w-4" />}>{t('nav.notes')}</NavLink>
              {(hasPermission('cases:read-own') || hasPermission('cases:read-assigned') || hasPermission('cases:read-all')) && (
                <>
                  <NavLink to="/cases" icon={<FolderOpen className="h-4 w-4" />}>
                    {t('nav.cases', { defaultValue: 'Cases' })}
                  </NavLink>
                  <NavLink to="/events" icon={<Calendar className="h-4 w-4" />}>
                    {t('nav.events', { defaultValue: 'Events' })}
                  </NavLink>
                </>
              )}
              {hasMessaging && (
                <NavLink to="/conversations" icon={<MessageSquare className="h-4 w-4" />}>
                  {t('nav.conversations', { defaultValue: 'Conversations' })}
                </NavLink>
              )}
              {(channels?.reports || isAdmin) && (
                <NavLink to="/reports" icon={<FileText className="h-4 w-4" />}>
                  {t('nav.reports', { defaultValue: 'Reports' })}
                </NavLink>
              )}
              {hasPermission('reports:read-all') && (
                <NavLink to="/triage" icon={<Inbox className="h-4 w-4" />}>
                  {t('nav.triage', { defaultValue: 'Triage' })}
                </NavLink>
              )}
              {hasPermission('blasts:read') && (
                <NavLink to="/blasts" icon={<Megaphone className="h-4 w-4" />}>
                  {t('nav.blasts', { defaultValue: 'Blasts' })}
                </NavLink>
              )}
              {isAdmin && (
                <NavLink to="/calls" icon={<PhoneIncoming className="h-4 w-4" />}>{t('nav.callHistory')}</NavLink>
              )}
              <NavLink to="/security" icon={<Shield className="h-4 w-4" />}>{t('nav.security')}</NavLink>
              <NavLink to="/settings" icon={<Settings className="h-4 w-4" />}>{t('nav.settings')}</NavLink>
            </>
          )}

          {isAdmin && (
            <>
              <div className="my-2 border-t border-sidebar-border" />
              <div data-testid="nav-admin-section">
              <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-primary">
                {t('nav.admin', { defaultValue: 'Admin' })}
              </p>
              <NavLink to="/shifts" icon={<Clock className="h-4 w-4" />}>{t('nav.shifts')}</NavLink>
              <NavLink to="/users" icon={<Users className="h-4 w-4" />}>{t('nav.users')}</NavLink>
              <NavLink to="/bans" icon={<ShieldBan className="h-4 w-4" />}>{t('nav.banList')}</NavLink>
              {hasPermission('contacts:view') && (
                <NavLink to="/contacts" icon={<Contact className="h-4 w-4" />}>{t('nav.contacts', { defaultValue: 'Contacts' })}</NavLink>
              )}
              {hasPermission('contacts:view') && (
                <NavLink to="/contacts-directory" icon={<BookUser className="h-4 w-4" />}>{t('contactDirectory.title', { defaultValue: 'Contact Directory' })}</NavLink>
              )}
              <NavLink to="/audit" icon={<ScrollText className="h-4 w-4" />}>{t('nav.auditLog')}</NavLink>
              <NavLink to="/admin/settings" icon={<Settings className="h-4 w-4" />}>{t('nav.hubSettings', { defaultValue: 'Hub Settings' })}</NavLink>
              <NavLink to="/admin/hub-communications" icon={<PhoneIncoming className="h-4 w-4" />}>{t('hubOnboarding.settingsTitle')}</NavLink>
              <NavLink to="/admin/case-management" icon={<Briefcase className="h-4 w-4" />}>{t('caseManagement.title')}</NavLink>
              {hasPermission('firehose:read') && (
                <NavLink to="/admin/firehose" icon={<Radio className="h-4 w-4" />}>Firehose</NavLink>
              )}
              {hasPermission('system:manage-hubs') && (
                <NavLink to="/admin/hubs" icon={<Building2 className="h-4 w-4" />}>{t('nav.hubs', { defaultValue: 'Hubs' })}</NavLink>
              )}
              <NavLink to="/admin/system" icon={<Monitor className="h-4 w-4" />}>{t('admin.system.nav', { defaultValue: 'System Health' })}</NavLink>
              <NavLink to="/admin/analytics" icon={<BarChart3 className="h-4 w-4" />}>{t('analytics.nav')}</NavLink>
              {hasPermission('system:manage-hubs') && (
                <NavLink to="/admin/platform-analytics" icon={<BarChart3 className="h-4 w-4" />}>
                  {t('analytics.platform.title')}
                </NavLink>
              )}
              </div>
            </>
          )}
          <NavLink to="/help" icon={<HelpCircle className="h-4 w-4" />}>{t('nav.help', { defaultValue: 'Help' })}</NavLink>
        </div>

        <div className="border-t border-sidebar-border p-3 space-y-1">
          <LanguageSelect size="sm" fullWidth />
          <div className="flex items-center gap-2 rounded-md px-3 py-2">
            {theme === 'dark' ? <Moon className="h-4 w-4 text-muted-foreground" /> : theme === 'light' ? <Sun className="h-4 w-4 text-muted-foreground" /> : <Monitor className="h-4 w-4 text-muted-foreground" />}
            <div className="flex gap-0.5">
              {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([value, Icon]) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  data-testid={`theme-${value}`}
                  className={`rounded px-1.5 py-0.5 text-xs transition-colors ${theme === value ? 'bg-primary/20 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  aria-label={t(`a11y.theme${value.charAt(0).toUpperCase() + value.slice(1)}`)}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={triggerCommandPalette}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Search className="h-4 w-4" />
            {t('commandPalette.label')}
            <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>
          <button
            onClick={() => {
              signOut()
              navigate({ to: '/login' })
            }}
            data-testid="logout-btn"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut className="h-4 w-4" />
            {t('common.logout')}
          </button>
        </div>
      </nav>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {demoMode && <DemoBanner />}
        <UpdateChecker />
        <NotificationPromptBanner />

        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
          <button onClick={() => setSidebarOpen(true)} aria-label={t('a11y.openMenu')}>
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <LogoMark size="sm" />
            <span className="font-semibold">{hotlineName}</span>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto bg-background p-4 md:p-6" key={currentHubId}>
          <ErrorBoundary scope="page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette />
      <KeyboardShortcutsDialog />
      <NoteSheet />

      {/* Session expiring warning */}
      {sessionExpiring && !sessionExpired && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-yellow-500/50 bg-yellow-50 px-4 py-3 shadow-lg dark:bg-yellow-950/90">
          <span className="text-sm font-medium text-yellow-800 dark:text-yellow-200">{t('session.expiringWarning')}</span>
          <button
            onClick={() => renewSession()}
            className="rounded-md bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-700"
          >
            {t('session.stayLoggedIn')}
          </button>
        </div>
      )}

      {/* Session expired modal */}
      {sessionExpired && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg border bg-background p-6 shadow-xl">
            <h2 className="text-lg font-semibold">{t('session.expired')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('session.expiredDescription')}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={async () => {
                  try {
                    await renewSession()
                  } catch {
                    // If renewal fails, redirect to login
                    signOut()
                  }
                }}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('session.reconnect')}
              </button>
              <button
                onClick={() => signOut()}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                {t('common.logout')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NavLink({ to, children, icon }: { to: string; children: ReactNode; icon?: ReactNode }) {
  const location = useLocation()
  const isActive = location.pathname === to || (to === '/' ? false : location.pathname.startsWith(to))
  // Generate test ID from route path: "/" → "nav-dashboard", "/notes" → "nav-notes", "/admin/settings" → "nav-admin-settings"
  const testId = `nav-${to === '/' ? 'dashboard' : to.replace(/^\//, '').replace(/\//g, '-')}`

  return (
    <Link
      to={to}
      data-testid={testId}
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent ${
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium border-l-[3px] border-primary pl-[9px]'
          : 'text-sidebar-foreground'
      }`}
    >
      {icon && <span className={isActive ? 'text-primary' : 'text-muted-foreground'}>{icon}</span>}
      {children}
    </Link>
  )
}

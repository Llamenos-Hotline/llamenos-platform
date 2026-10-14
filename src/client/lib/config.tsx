import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { getConfig, listHubs, setActiveHub } from './api'
import type { EnabledChannels, Hub } from '@shared/types'

interface ConfigContextValue {
  hotlineName: string
  hotlineNumber: string
  channels: EnabledChannels
  setupCompleted: boolean
  demoMode: boolean
  demoResetSchedule: string | null
  needsBootstrap: boolean
  isLoading: boolean
  /**
   * Hubs the SIGNED-IN user is a member of, name-sorted. Empty until
   * `refreshMemberHubs` has answered — never an instance-wide list.
   */
  hubs: Hub[]
  /** `true` once a membership fetch has succeeded; `false` while unknown. */
  hubsResolved: boolean
  /** Set when the membership fetch failed. Surfaced, never papered over. */
  hubsError: boolean
  currentHubId: string | undefined
  setCurrentHubId: (id: string) => void
  isMultiHub: boolean
  /** Load the authenticated user's hub memberships and resolve the active hub. */
  refreshMemberHubs: () => Promise<void>
  /** Drop membership state (sign-out, session loss). */
  clearMemberHubs: () => void
  /** Server's Ed25519 pubkey for verifying event signatures */
  serverPubkey: string | undefined
  /** WebSocket relay URL */
  wsRelayUrl: string | undefined
}

const defaultChannels: EnabledChannels = {
  voice: true,
  sms: false,
  whatsapp: false,
  signal: false,
  rcs: false,
  telegram: false,
  reports: false,
}

/** Remembers the hub the user last chose, so a relaunch reopens where they were. */
const ACTIVE_HUB_STORAGE_KEY = 'llamenos-active-hub'

function readHubPreference(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_HUB_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeHubPreference(id: string): void {
  try {
    localStorage.setItem(ACTIVE_HUB_STORAGE_KEY, id)
  } catch { /* private mode / blocked storage — the choice just won't persist */ }
}

/**
 * Forget the remembered hub. Called on explicit sign-out: the next user of this
 * device must not inherit a previous volunteer's browsing context.
 */
export function forgetHubPreference(): void {
  try {
    localStorage.removeItem(ACTIVE_HUB_STORAGE_KEY)
  } catch { /* nothing to forget if storage is unavailable */ }
}

/**
 * The Playwright harness pins each worker to its own isolated hub via
 * `addInitScript` (`tests/steps/fixtures.ts`), so parallel workers don't share
 * database state. It is a pin, not a hint: membership resolution never
 * overrides it.
 *
 * This is also why the desktop E2E tier cannot observe #1708 — it never
 * exercises the unpinned path. #1126 tracks closing that blind spot.
 */
function pinnedTestHub(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as Record<string, unknown>).__TEST_WORKER_HUB as string | undefined
}

/**
 * Pick the active hub from the user's OWN memberships.
 *
 * Order: the harness pin, then a hub already active and still a member hub,
 * then the remembered preference if the user is still in it, then the first
 * member hub. `undefined` means the user is in no hub — an explicit state the
 * UI reports, never a hub picked on their behalf.
 *
 * Multi-hub axiom: this decides BROWSING CONTEXT only. Calls, relay events and
 * notifications are received for every hub in `memberHubs` regardless of which
 * one this returns (see `useMemberHubIds`).
 */
function chooseActiveHub(memberHubs: Hub[], current: string | undefined): string | undefined {
  const pinned = pinnedTestHub()
  if (pinned) return pinned
  const isMember = (id: string | undefined) => !!id && memberHubs.some(h => h.id === id)
  if (isMember(current)) return current
  const preferred = readHubPreference()
  if (isMember(preferred)) return preferred
  return memberHubs[0]?.id
}

const ConfigContext = createContext<ConfigContextValue>({
  hotlineName: 'Hotline',
  hotlineNumber: '',
  channels: defaultChannels,
  setupCompleted: true,
  demoMode: false,
  demoResetSchedule: null,
  needsBootstrap: false,
  isLoading: true,
  hubs: [],
  hubsResolved: false,
  hubsError: false,
  currentHubId: undefined,
  setCurrentHubId: () => {},
  isMultiHub: false,
  refreshMemberHubs: async () => {},
  clearMemberHubs: () => {},
  serverPubkey: undefined,
  wsRelayUrl: undefined,
})

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [hotlineName, setHotlineName] = useState('Hotline')
  const [hotlineNumber, setHotlineNumber] = useState('')
  const [channels, setChannels] = useState<EnabledChannels>(defaultChannels)
  const [setupCompleted, setSetupCompleted] = useState(true)
  const [demoMode, setDemoMode] = useState(false)
  const [demoResetSchedule, setDemoResetSchedule] = useState<string | null>(null)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hubs, setHubs] = useState<Hub[]>([])
  const [hubsResolved, setHubsResolved] = useState(false)
  const [hubsError, setHubsError] = useState(false)
  const [currentHubId, setCurrentHubIdState] = useState<string | undefined>(pinnedTestHub)
  const [serverPubkey, setServerPubkey] = useState<string | undefined>()
  const [wsRelayUrl, setWsRelayUrl] = useState<string | undefined>()

  // Read without re-creating refreshMemberHubs on every hub change.
  const currentHubIdRef = useRef(currentHubId)
  currentHubIdRef.current = currentHubId

  // Apply the harness pin to the API client before anything issues a
  // hub-scoped request. Outside tests this is a no-op.
  useEffect(() => {
    const pinned = pinnedTestHub()
    if (pinned) setActiveHub(pinned)
  }, [])

  function setCurrentHubId(id: string) {
    writeHubPreference(id)
    currentHubIdRef.current = id
    setCurrentHubIdState(id)
    setActiveHub(id)
  }

  /**
   * Resolve the active hub from `GET /api/hubs`, which the server filters to the
   * caller's hub roles. Before #1708 this came from the public `/api/config`
   * hub list, on mount, before login — so on any multi-hub deployment the
   * active hub was an arbitrary hub the user was usually not in, and every
   * hub-scoped request 403'd into a benign-looking empty state.
   */
  const refreshMemberHubs = useCallback(async () => {
    let memberHubs: Hub[]
    try {
      memberHubs = (await listHubs()).hubs
    } catch (err) {
      // Loud, not silent: with no membership answer there is no honest active
      // hub, and guessing one is the bug being fixed.
      console.error('[config] failed to load hub memberships', err)
      setHubsError(true)
      return
    }
    const sorted = [...memberHubs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const chosen = chooseActiveHub(sorted, currentHubIdRef.current)
    currentHubIdRef.current = chosen
    setHubs(sorted)
    setCurrentHubIdState(chosen)
    setActiveHub(chosen ?? null)
    setHubsError(false)
    setHubsResolved(true)
  }, [])

  const clearMemberHubs = useCallback(() => {
    const pinned = pinnedTestHub()
    setHubs([])
    setHubsResolved(false)
    setHubsError(false)
    currentHubIdRef.current = pinned
    setCurrentHubIdState(pinned)
    setActiveHub(pinned ?? null)
  }, [])

  useEffect(() => {
    getConfig()
      .then(config => {
        setHotlineName(config.hotlineName)
        setHotlineNumber(config.hotlineNumber || '')
        if (config.channels) setChannels(config.channels)
        if (config.setupCompleted !== undefined) setSetupCompleted(config.setupCompleted)
        if (config.demoMode) setDemoMode(config.demoMode)
        if (config.demoResetSchedule !== undefined) setDemoResetSchedule(config.demoResetSchedule ?? null)
        setNeedsBootstrap(!!config.needsBootstrap)
        const pubkey = config.serverPubkey
        const relayUrl = config.wsRelayUrl
        if (pubkey) setServerPubkey(pubkey)
        if (relayUrl) setWsRelayUrl(relayUrl)
        // Wire Sentry/GlitchTip DSN for crash reporting (if configured server-side)
        if (config.sentryDsn) {
          import('@/lib/crash-reporting').then(({ setSentryDsn }) => {
            setSentryDsn(config.sentryDsn ?? null)
          })
        }
        setIsLoading(false)
      })
      .catch(() => setIsLoading(false))
  }, [])

  // Set document title
  useEffect(() => {
    if (!isLoading) document.title = hotlineName
  }, [hotlineName, isLoading])

  const isMultiHub = hubs.length > 1

  return (
    <ConfigContext.Provider value={{
      hotlineName, hotlineNumber, channels, setupCompleted,
      demoMode, demoResetSchedule, needsBootstrap, isLoading,
      hubs, hubsResolved, hubsError, currentHubId,
      setCurrentHubId, isMultiHub, refreshMemberHubs, clearMemberHubs,
      serverPubkey, wsRelayUrl,
    }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  return useContext(ConfigContext)
}

/** Whether any messaging channel is enabled (SMS, WhatsApp, Signal, or web reports) */
export function useHasMessaging() {
  const { channels } = useConfig()
  return channels.sms || channels.whatsapp || channels.signal || channels.reports
}

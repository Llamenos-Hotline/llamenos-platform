import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { getConfig, setActiveHub } from './api'
import type { EnabledChannels, Hub } from '@shared/types'

interface ConfigContextValue {
  hotlineName: string
  hotlineNumber: string
  channels: EnabledChannels
  setupCompleted: boolean
  needsBootstrap: boolean
  isLoading: boolean
  hubs: Hub[]
  defaultHubId: string | undefined
  currentHubId: string | undefined
  setCurrentHubId: (id: string) => void
  isMultiHub: boolean
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

const ConfigContext = createContext<ConfigContextValue>({
  hotlineName: 'Hotline',
  hotlineNumber: '',
  channels: defaultChannels,
  setupCompleted: true,
  needsBootstrap: false,
  isLoading: true,
  hubs: [],
  defaultHubId: undefined,
  currentHubId: undefined,
  setCurrentHubId: () => {},
  isMultiHub: false,
  serverPubkey: undefined,
  wsRelayUrl: undefined,
})

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [hotlineName, setHotlineName] = useState('Hotline')
  const [hotlineNumber, setHotlineNumber] = useState('')
  const [channels, setChannels] = useState<EnabledChannels>(defaultChannels)
  const [setupCompleted, setSetupCompleted] = useState(true)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hubs, setHubs] = useState<Hub[]>([])
  const [defaultHubId, setDefaultHubId] = useState<string | undefined>()
  const [currentHubId, setCurrentHubIdState] = useState<string | undefined>()
  const [serverPubkey, setServerPubkey] = useState<string | undefined>()
  const [wsRelayUrl, setWsRelayUrl] = useState<string | undefined>()

  function setCurrentHubId(id: string) {
    setCurrentHubIdState(id)
    setActiveHub(id)
  }

  useEffect(() => {
    getConfig()
      .then(config => {
        setHotlineName(config.hotlineName)
        setHotlineNumber(config.hotlineNumber || '')
        if (config.channels) setChannels(config.channels)
        if (config.setupCompleted !== undefined) setSetupCompleted(config.setupCompleted)
        setNeedsBootstrap(!!config.needsBootstrap)
        if (config.hubs?.length) {
          setHubs(config.hubs)
        }
        // In test builds, the Before hook injects __TEST_WORKER_HUB via addInitScript
        // so each Playwright worker uses its isolated hub instead of the server default.
        // This MUST run outside the hubs?.length check — under CI parallel load,
        // /api/config may return empty hubs[] before the worker hub appears in DB,
        // but setActiveHub must still fire so hub-scoped routes don't 401.
        const testHub = (window as unknown as Record<string, unknown>).__TEST_WORKER_HUB as string | undefined
        const hubId = testHub || (config.hubs?.length ? (config.defaultHubId || config.hubs[0].id) : undefined)
        if (hubId) {
          setDefaultHubId(hubId)
          setCurrentHubIdState(hubId)
          setActiveHub(hubId)
        }
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
      needsBootstrap, isLoading, hubs, defaultHubId, currentHubId,
      setCurrentHubId, isMultiHub, serverPubkey, wsRelayUrl,
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

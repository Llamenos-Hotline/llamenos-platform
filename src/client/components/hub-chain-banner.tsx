import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { useConfig } from '@/lib/config'
import { useAuth } from '@/lib/auth'
import { hubChainStatus, loadHubChain, onHubChainStatus, type HubChainStatus } from '@/lib/hub-chain'

/**
 * Verifies the active hub's authority chain in the crate on every hub switch
 * and unlock (#2963), and raises the chain's alerts:
 *
 * - **fork** — the server served a chain that does not contain the head this
 *   device verified: sealing in the hub stops;
 * - **refused** — an unauthorised or otherwise invalid link: sealing stops;
 * - **stale signer** (advisory, D13) — a link signed by a device its user has
 *   since removed.
 *
 * Browsing context only for the banner; the verdict itself is recorded per hub
 * in lib/hub-chain and enforced at sealing time for every hub, active or not.
 */
export function HubChainBanner() {
  const { t } = useTranslation()
  const { currentHubId } = useConfig()
  const { isKeyUnlocked } = useAuth()
  const [status, setStatus] = useState<HubChainStatus | undefined>(currentHubId ? hubChainStatus(currentHubId) : undefined)

  useEffect(() => {
    if (!currentHubId) return
    setStatus(hubChainStatus(currentHubId))
    return onHubChainStatus((hubId, s) => {
      if (hubId === currentHubId) setStatus(s)
    })
  }, [currentHubId])

  useEffect(() => {
    if (!currentHubId || !isKeyUnlocked) return
    loadHubChain(currentHubId).catch((err: unknown) => {
      // A fetch failure says nothing about the chain: keep the last verdict.
      console.error(`[hub-chain] hub ${currentHubId}: loading its chain failed`, err)
    })
  }, [currentHubId, isKeyUnlocked])

  if (!status) return null
  if (status.kind === 'fork' || status.kind === 'refused') {
    return (
      <div
        role="alert"
        data-testid="hub-chain-alert"
        data-alert-kind={status.kind === 'fork' ? 'fork' : status.code === 'chain_unauthorised_signer' ? 'unauthorised' : 'invalid'}
        className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            {status.kind === 'fork' ? t('hubChain.alert.forkTitle') : t('hubChain.alert.refusedTitle')}
          </p>
          <p>{t('hubChain.alert.sealingStopped')}</p>
        </div>
      </div>
    )
  }
  if (status.kind === 'verified' && status.alerts.length > 0) {
    return (
      <div
        role="status"
        data-testid="hub-chain-alert"
        data-alert-kind="stale_signer"
        className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
      >
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t('hubChain.alert.staleSigner', { count: status.alerts.length })}</p>
      </div>
    )
  }
  return null
}

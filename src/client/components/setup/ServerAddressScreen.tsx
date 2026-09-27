import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogoMark } from '@/components/logo-mark'
import { clearPendingServerAddress, HOSTED_SERVER_ADDRESS, peekPendingServerAddress, setApiBase } from '@/lib/api-config'
import { endServerSession } from '@/lib/server-switch'
import { ServerAddressForm } from './ServerAddressForm'

/**
 * First-run gate for a packaged desktop build: a `tauri://` build has no
 * default backend to reach (see api-config.ts), so nothing else in the app
 * can safely render until the user tells us which server to talk to.
 * Rendered from `RootLayout` (`src/client/routes/__root.tsx`) in place of the
 * entire route tree whenever `needsServerAddress()` is true.
 *
 * This is the only place a server address is verified and persisted: the Rust
 * health probe is refused once a server is configured. Changing servers from
 * Settings stages the new address and returns here, where it is pre-filled and
 * checked automatically. Otherwise the hosted deployment's address is
 * pre-filled, so the common case is a single confirm — and it stays editable
 * for organizations running their own server.
 */
export function ServerAddressScreen({ onConfigured }: { onConfigured: (base: string) => void }) {
  const { t } = useTranslation()
  // Read once, then consumed: a staged change gets one automatic attempt, and
  // on failure it stays in the input for the user to correct rather than
  // re-submitting on every reload.
  const [staged] = useState(() => peekPendingServerAddress())
  useEffect(() => {
    if (staged) clearPendingServerAddress()
  }, [staged])

  // No server is configured, so no session can belong to one (#1166).
  // leaveServer() has already ended it on the way here, but other ways in have
  // not: a stored address Rust discarded as invalid at load, or a webview reload
  // that left Rust CryptoState unlocked beneath a signed-out webview.
  useEffect(() => {
    endServerSession().catch((err: unknown) => {
      console.error('[server-address] could not end the previous session:', err)
    })
  }, [])

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4 overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
      </div>
      <div className="relative z-10 w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <LogoMark size="md" className="mx-auto" />
          <h1 data-testid="server-address-title" className="text-lg font-semibold">
            {t('serverAddress.firstRunTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('serverAddress.firstRunDescription')}
          </p>
        </div>
        <ServerAddressForm
          testIdPrefix="server-address"
          submitLabel={t('serverAddress.connect')}
          initialValue={staged ?? HOSTED_SERVER_ADDRESS}
          autoSubmit={!!staged}
          verify
          onConfirm={async (origin) => {
            await setApiBase(origin)
            onConfigured(origin)
          }}
        />
      </div>
    </div>
  )
}

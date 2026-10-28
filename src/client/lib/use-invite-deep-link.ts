import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { onInviteDeepLink, takePendingInviteCode } from '@/lib/platform'

/**
 * Route a clicked `llamenos://hub-invite?code=` link to the redemption screen (#1128).
 *
 * Rust parses the link, keeps the code and raises a payload-free event
 * (apps/desktop/src/deep_link.rs); this takes the code once and opens
 * `/onboarding?code=`. It also takes, on mount, a code that arrived before the
 * webview was listening — the link that launched the app.
 *
 * Nothing is taken until auth has settled, so Rust holds the code meanwhile. A
 * signed-in device is told instead of being moved: redeeming mints a new
 * device key over this device's own (see the /onboarding gate in __root.tsx).
 */
export function useInviteDeepLink(): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()
  const [arrivals, setArrivals] = useState(0)

  // Read at the moment a code is taken, not when the take started.
  const latest = useRef({ isAuthenticated, navigate, toast, t })
  latest.current = { isAuthenticated, navigate, toast, t }

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void onInviteDeepLink(() => setArrivals(n => n + 1)).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (isLoading) return
    // Not cancelled on re-render: the code is handed over once, so a take whose
    // result were dropped would lose the invite.
    takePendingInviteCode().then(code => {
      if (!code) return
      const now = latest.current
      if (now.isAuthenticated) {
        now.toast(now.t('onboarding.inviteWhileSignedIn'), 'error')
        return
      }
      void now.navigate({ to: '/onboarding', search: { code } })
    }).catch((err: unknown) => {
      console.error('[invite-deep-link] could not read the invite code', err)
    })
  }, [arrivals, isLoading])
}

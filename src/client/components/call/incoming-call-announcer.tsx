import { useTranslation } from 'react-i18next'
import { useIncomingCalls } from '@/lib/calls-context'

/**
 * Tells a screen-reader user a call is ringing, on whichever screen they are on.
 *
 * The region is always mounted and only its text changes: assistive tech announces
 * changes inside a live region that already exists, but often says nothing for one
 * that appears together with its content. Polite, so it queues behind whatever is
 * being read instead of cutting the volunteer off mid-sentence. The text is generic
 * on purpose — no caller digits — and carries the hub name when the volunteer is in
 * several, so they know which line is ringing.
 */
export function IncomingCallAnnouncer() {
  const { t } = useTranslation()
  const incoming = useIncomingCalls()
  const message = incoming
    .map(({ hubName }) => (hubName ? `${t('incomingCallBody')} — ${hubName}` : t('incomingCallBody')))
    .join('. ')

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="incoming-call-announcement"
      className="sr-only"
    >
      {message}
    </div>
  )
}

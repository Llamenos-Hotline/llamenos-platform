import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { PhoneIncoming, PhoneCall } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { isEditableFocused } from '@/lib/editable-focus'
import type { IncomingCall } from '@/lib/calls-context'

interface Props {
  incoming: IncomingCall[]
  onAnswer: (callId: string) => void
}

/**
 * The ring, on the dashboard. Answer is a native button, so Tab reaches it and
 * Enter/Space operate it with no ARIA. When a call starts ringing focus is moved to
 * its Answer button — unless the volunteer is typing somewhere (a note on another
 * call, say): a focus jump there would send their next keystrokes to the wrong
 * field. The screen-reader announcement and the Ctrl+Shift+A shortcut cover that case.
 */
export function IncomingCallCard({ incoming, onAnswer }: Props) {
  const { t } = useTranslation()
  const firstAnswer = useRef<HTMLButtonElement | null>(null)
  const firstCallId = incoming[0]?.call.id

  useEffect(() => {
    if (!firstCallId || isEditableFocused()) return
    firstAnswer.current?.focus()
  }, [firstCallId])

  if (incoming.length === 0) return null

  return (
    <Card
      data-testid="incoming-calls-card"
      className="border-2 border-green-600 bg-green-50 ring-4 ring-green-500/30 dark:border-green-500 dark:bg-green-950/30"
    >
      <CardHeader>
        <h2 className="flex items-center gap-2 text-lg leading-none font-semibold text-green-800 dark:text-green-300">
          <PhoneIncoming className="h-6 w-6" aria-hidden="true" />
          {t('calls.incoming')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-2">
        {incoming.map(({ call, hubName }, i) => (
          <div key={call.id} data-testid={`incoming-call-row-${call.id}`} className="flex items-center justify-between gap-3 rounded-lg bg-green-100 px-4 py-3 dark:bg-green-950/40">
            <div>
              <p className="font-medium">{t('incomingCallBody')}</p>
              {hubName && (
                <p data-testid="call-hub-label" className="text-xs text-muted-foreground">{hubName}</p>
              )}
            </div>
            <Button
              ref={i === 0 ? firstAnswer : undefined}
              data-testid={`answer-call-btn-${call.id}`}
              size="lg"
              onClick={() => onAnswer(call.id)}
              className="bg-green-700 text-white hover:bg-green-800 motion-safe:animate-pulse"
            >
              <PhoneCall className="h-4 w-4" aria-hidden="true" />
              {t('calls.answer')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

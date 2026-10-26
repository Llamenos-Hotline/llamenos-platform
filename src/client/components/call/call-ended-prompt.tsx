import { useTranslation } from 'react-i18next'
import { NotebookPen, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { EndedCall } from '@/lib/hooks'

interface Props {
  call: EndedCall
  onAddNote: (call: EndedCall) => void
  onDismiss: () => void
}

/**
 * "Call Ended / Add Note": offered in place of the in-call panel once the user's own
 * call is over, so the note can be written while it is fresh. It names no caller — not
 * the number, not the last digits — and the call it opens the editor on carries its own
 * hub, so a call that ended on a hub other than the active one is filed where it belongs.
 */
export function CallEndedPrompt({ call, onAddNote, onDismiss }: Props) {
  const { t } = useTranslation()
  return (
    <Card data-testid="call-ended-prompt">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <PhoneOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">{t('calls.ended')}</p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" data-testid="call-ended-add-note" onClick={() => onAddNote(call)}>
            <NotebookPen className="h-3.5 w-3.5" />
            {t('calls.addNote')}
          </Button>
          <Button variant="ghost" size="sm" data-testid="call-ended-dismiss" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

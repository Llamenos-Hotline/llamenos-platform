import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomFieldDefinition, CallRecord } from '@/lib/api'
import { useCalls } from '@/lib/calls-context'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { StickyNote, Save, PhoneCall } from 'lucide-react'
import { CustomFieldInputs } from './custom-field-inputs'

interface Props {
  recentCalls: CallRecord[]
  customFieldDefs: CustomFieldDefinition[]
  saving: boolean
  onSave: (callId: string, text: string, fields: Record<string, string | number | boolean>) => void
  onCancel: () => void
}

export function NewNoteForm({ recentCalls, customFieldDefs, saving, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const { currentCall } = useCalls()
  const [callId, setCallId] = useState('')
  const [manualCallId, setManualCallId] = useState('')
  const [text, setText] = useState('')
  const [fields, setFields] = useState<Record<string, string | number | boolean>>({})
  const [callIdTouched, setCallIdTouched] = useState(false)

  useEffect(() => {
    if (currentCall && !callId) setCallId(currentCall.id)
  }, [currentCall, callId])

  const effectiveCallId = callId === '__manual' ? manualCallId : callId
  // Save is disabled until a call/reference is given, so say why rather than leave a dead button.
  const callIdMissing = !effectiveCallId.trim()
  const showCallIdError = callIdMissing && (callIdTouched || text.trim().length > 0)

  function handleSave() {
    onSave(effectiveCallId, text, fields)
    setText('')
    setCallId('')
    setManualCallId('')
    setFields({})
    setCallIdTouched(false)
  }

  return (
    <Card data-testid="note-form" data-call-id-mode={recentCalls.length > 0 ? 'select' : 'input'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          {t('notes.newNote')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="call-id">
            {t('notes.callId')}
            <span aria-hidden="true" className="text-destructive"> *</span>
          </Label>
          {recentCalls.length > 0 ? (
            <Select
              value={callId || undefined}
              onValueChange={setCallId}
              onOpenChange={open => { if (!open) setCallIdTouched(true) }}
            >
              <SelectTrigger
                id="call-id"
                data-testid="call-id-select"
                aria-required="true"
                aria-invalid={showCallIdError}
                aria-describedby={showCallIdError ? 'call-id-error' : undefined}
              >
                <SelectValue placeholder={t('notes.selectCall')} />
              </SelectTrigger>
              <SelectContent>
                {recentCalls.map(call => (
                  <SelectItem key={call.id} value={call.id}>
                    {call.callerNumber} — {new Date(call.startedAt).toLocaleString()}
                  </SelectItem>
                ))}
                <SelectItem value="__manual" data-testid="call-id-manual-option">{t('notes.enterManually')}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="call-id"
              data-testid="note-call-id"
              value={callId}
              onChange={e => setCallId(e.target.value)}
              onBlur={() => setCallIdTouched(true)}
              placeholder={t('notes.callIdPlaceholder')}
              required
              aria-required="true"
              aria-invalid={showCallIdError}
              aria-describedby={showCallIdError ? 'call-id-error' : undefined}
            />
          )}
          {callId === '__manual' && (
            <Input
              data-testid="note-call-id"
              value={manualCallId}
              onChange={e => setManualCallId(e.target.value)}
              onBlur={() => setCallIdTouched(true)}
              placeholder={t('notes.callIdPlaceholder')}
              required
              aria-required="true"
              aria-invalid={showCallIdError}
              aria-describedby={showCallIdError ? 'call-id-error' : undefined}
            />
          )}
          {showCallIdError && (
            <p id="call-id-error" role="alert" data-testid="note-call-id-error" className="text-xs text-destructive">
              {t('notes.callIdRequired')}
            </p>
          )}
          {currentCall && callId === currentCall.id && (
            <p className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <PhoneCall className="h-3 w-3" />
              {t('notes.activeCallNote')}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label>{t('notes.newNote')}</Label>
          <textarea
            data-testid="note-content"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={t('notes.notePlaceholder')}
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <CustomFieldInputs
          fields={customFieldDefs}
          values={fields}
          onChange={setFields}
          idPrefix="new-field"
        />
        <div className="flex gap-2">
          <Button data-testid="form-save-btn" onClick={handleSave} disabled={saving || !text.trim() || !effectiveCallId.trim()}>
            <Save className="h-4 w-4" />
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <Button data-testid="form-cancel-btn" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

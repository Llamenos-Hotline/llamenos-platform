import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, MicOff, PhoneOff, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  voiceHangup,
  voiceListAudioDevices,
  voiceSelectAudioDevice,
  voiceSetMuted,
  type VoiceAudioDevice,
  type VoiceCallPayload,
  type VoiceDeviceKind,
} from '@/lib/platform'
import { useVoiceStore } from '@/lib/voice'

/**
 * Controls for the answered in-app leg (#1770): mute, hang up, and the audio
 * devices — enumerated and switched in the shell, the webview only renders the
 * list and sends the choice. Every action is fire-and-forget; the resulting
 * state arrives as a `voice:call` event, so what is shown is what the shell
 * reports, never what was asked for.
 */
export function VoiceControls({ leg }: { leg: VoiceCallPayload }) {
  const { t } = useTranslation()
  return (
    <div data-testid="voice-controls" data-call-state={leg.state} data-media-path={leg.mediaPath ?? ''} className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-white/60 p-2 dark:border-blue-900 dark:bg-blue-950/30">
      <Button
        data-testid="voice-mute-toggle"
        variant="outline"
        size="sm"
        aria-pressed={leg.muted}
        onClick={() => void voiceSetMuted(leg.callId, !leg.muted).catch(() => {})}
      >
        {leg.muted ? <MicOff className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
        {leg.muted ? t('calls.unmute') : t('calls.mute')}
      </Button>
      <Button
        data-testid="voice-hangup-btn"
        variant="destructive"
        size="sm"
        onClick={() => void voiceHangup(leg.callId).catch(() => {})}
      >
        <PhoneOff className="h-4 w-4" aria-hidden="true" />
        {t('calls.hangUp')}
      </Button>
      <VoiceDevicePicker kind="input" />
      <VoiceDevicePicker kind="output" />
      {leg.mediaPath === 'relay' && <Radio className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
    </div>
  )
}

function VoiceDevicePicker({ kind }: { kind: VoiceDeviceKind }) {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<VoiceAudioDevice[]>([])
  useEffect(() => {
    let live = true
    voiceListAudioDevices()
      .then(all => { if (live) setDevices(kind === 'input' ? all.input : all.output) })
      .catch(() => { if (live) setDevices([]) })
    return () => { live = false }
  }, [kind])
  const label = kind === 'input' ? t('softphone.inputDevice') : t('softphone.outputDevice')
  const selected = devices.find(d => d.selected)?.id ?? ''
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <select
        data-testid={`voice-device-picker-${kind}`}
        aria-label={label}
        className="rounded border bg-background px-1 py-0.5 text-xs"
        value={selected}
        onChange={e => {
          const id = e.target.value
          voiceSelectAudioDevice(kind, id)
            .then(() => setDevices(ds => ds.map(d => ({ ...d, selected: d.id === id }))))
            .catch(() => {})
        }}
      >
        {devices.map(d => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * The in-app registration state, when it needs the volunteer's attention:
 * connecting, refused, failed or revoked — with the reason. Silent when
 * registered (calls simply ring) and when off shift (nothing to say).
 */
export function VoiceRegistrationBadge() {
  const { t } = useTranslation()
  const voice = useVoiceStore()
  const { registration, registrationReason, lastCallError } = voice
  const shown = registration === 'registering' || registration === 'failed' || registration === 'unavailable' || registration === 'credential-revoked'
  return (
    <>
      {shown && (
        <p data-testid="voice-registration-badge" data-state={registration} role="status" className={registration === 'registering' ? 'text-xs text-muted-foreground' : 'text-xs text-orange-700 dark:text-orange-300'}>
          {registration === 'registering' && t('softphone.registering')}
          {registration === 'failed' && t('softphone.failed', { reason: registrationReason ?? '' })}
          {registration === 'unavailable' && t('softphone.unavailable', { reason: registrationReason ?? '' })}
          {registration === 'credential-revoked' && t('softphone.credentialRevoked')}
        </p>
      )}
      {registration === 'registered' && (
        <p data-testid="voice-registration-badge" data-state="registered" className="text-xs text-muted-foreground">{t('softphone.registered')}</p>
      )}
      {lastCallError && (
        <p data-testid="voice-media-error" role="alert" className="text-xs text-red-700 dark:text-red-300">
          {t('softphone.mediaFailed', { reason: lastCallError.reason ?? '' })}
        </p>
      )}
    </>
  )
}

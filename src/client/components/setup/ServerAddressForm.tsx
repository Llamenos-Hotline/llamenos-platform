import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Server, Loader2 } from 'lucide-react'
import { normalizeServerInput, ServerAddressError } from '@/lib/api-config'
import { probeServerHealth } from '@/lib/net'

interface ServerAddressFormProps {
  /** Pre-filled address (current server in Settings, or a staged change on first run). */
  initialValue?: string
  /**
   * Probe `<origin>/api/health` before confirming. Only possible on first run:
   * the Rust probe refuses once a server is configured, so Settings stages the
   * change and lets the first-run screen verify it.
   */
  verify: boolean
  /** Submit the value in `initialValue` once on mount (a staged server change). */
  autoSubmit?: boolean
  /** Called once that automatic attempt has finished, whatever its outcome. */
  onAutoSubmitSettled?: () => void
  /** Called with the validated canonical origin (after a successful probe when `verify`). */
  onConfirm: (origin: string) => Promise<void>
  submitLabel: string
  /** Prefix for `data-testid` attributes so first-run and settings usages don't collide. */
  testIdPrefix: string
}

/**
 * Shared "type a server address" form — used by the first-run gate
 * (`ServerAddressScreen`) and the Settings "Server connection" section.
 * Validates the address locally first (https-only; see `normalizeServerInput`),
 * so a refused address never triggers a probe, a session change or a reload.
 */
export function ServerAddressForm({
  initialValue = '',
  verify,
  autoSubmit = false,
  onAutoSubmitSettled,
  onConfirm,
  submitLabel,
  testIdPrefix,
}: ServerAddressFormProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const autoSubmitted = useRef(false)

  async function submit(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed || checking) return

    setChecking(true)
    setError('')
    try {
      const origin = normalizeServerInput(trimmed)
      if (verify) {
        const result = await probeServerHealth(origin)
        if (!result.ok) {
          setError(result.error ? t('serverAddress.errorWithDetail', { detail: result.error }) : t('serverAddress.unreachable'))
          return
        }
      }
      await onConfirm(origin)
    } catch (err) {
      setError(err instanceof ServerAddressError
        ? t('serverAddress.errorWithDetail', { detail: err.message })
        : t('serverAddress.unreachable'))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    // Ref guard: StrictMode re-runs mount effects, and a second probe inside the
    // Rust rate-limit window would be refused.
    if (!autoSubmit || autoSubmitted.current || !initialValue) return
    autoSubmitted.current = true
    void submit(initialValue).finally(() => onAutoSubmitSettled?.())
    // Mount-only by design: a staged address is submitted once, not on every change.
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void submit(value)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${testIdPrefix}-input`} className="flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
          {t('serverAddress.label')}
        </Label>
        <Input
          id={`${testIdPrefix}-input`}
          data-testid={`${testIdPrefix}-input`}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={t('serverAddress.placeholder')}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={checking}
          aria-invalid={!!error}
        />
        <p className="text-xs text-muted-foreground">{t('serverAddress.help')}</p>
      </div>

      {error && (
        <p role="alert" data-testid={`${testIdPrefix}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" data-testid={`${testIdPrefix}-submit`} disabled={checking || !value.trim()} className="w-full">
        {checking
          ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t('serverAddress.checking')}</span>
          : submitLabel}
      </Button>
    </form>
  )
}

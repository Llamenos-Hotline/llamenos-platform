import { useRef, useEffect, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

interface PinInputProps {
  length?: number
  minLength?: number
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  error?: boolean
  autoFocus?: boolean
  /** Id(s) of the element(s) that describe this field's purpose, e.g. a step title. */
  describedBy?: string
}

export function PinInput({
  minLength = 8,
  value,
  onChange,
  onComplete,
  disabled = false,
  error = false,
  autoFocus = true,
  describedBy,
}: PinInputProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && value.length >= minLength) {
      e.preventDefault()
      onComplete?.(value)
    }
  }

  return (
    <div className="flex items-center justify-center" data-testid="pin-input">
      <input
        ref={inputRef}
        type="password"
        autoComplete="off"
        minLength={minLength}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('pin.placeholder')}
        className={`h-12 w-64 rounded-lg border px-3 text-center text-lg font-mono transition-colors focus:outline-none focus:ring-2 focus:ring-ring sm:h-14 sm:w-72 sm:text-xl ${
          error
            ? 'border-destructive bg-destructive/5 focus:ring-destructive/50'
            : 'border-input bg-background focus:border-primary'
        } ${disabled ? 'opacity-50' : ''}`}
        aria-label={t('pin.enterPin')}
        aria-invalid={error || undefined}
        aria-describedby={describedBy}
      />
    </div>
  )
}

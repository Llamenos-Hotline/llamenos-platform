import * as React from 'react'
import { useState, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import PhoneInputPrimitive, {
  getCountryCallingCode,
  isValidPhoneNumber,
  type Country,
  type Value,
} from 'react-phone-number-input'
import flags from 'react-phone-number-input/flags'
import { CheckIcon, ChevronsUpDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

const E164_REGEX = /^\+\d{7,15}$/

type ValidationState = 'empty' | 'partial' | 'valid' | 'invalid'

function getValidationState(value: string): ValidationState {
  if (!value || value === '+') return 'empty'
  if (isValidPhoneNumber(value)) return 'valid'
  // Still typing — don't show error for short partial numbers
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7) return 'partial'
  return 'invalid'
}

// --- Static sub-components ---

const InputComponent = forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      className={cn('rounded-s-none rounded-e-lg', className)}
      {...props}
    />
  ),
)
InputComponent.displayName = 'PhoneInputField'

function FlagComponent({ country, countryName }: { country: string; countryName: string }) {
  const Flag = flags[country as keyof typeof flags]
  return (
    <span className="flex h-4 w-6 overflow-hidden rounded-sm bg-foreground/20 [&_svg]:size-full">
      {Flag ? <Flag title={countryName} /> : <span className="size-full" />}
    </span>
  )
}

type CountryEntry = { label: string; value: Country | undefined }

interface CountrySelectProps {
  disabled?: boolean
  value: Country
  options: CountryEntry[]
  onChange: (country: Country) => void
}

function CountrySelect({ disabled, value: selectedCountry, options, onChange }: CountrySelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { t } = useTranslation()

  return (
    <Popover open={open} modal onOpenChange={(o) => { setOpen(o); if (o) setSearch('') }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="flex gap-1 rounded-e-none rounded-s-lg border-r-0 px-3 focus:z-10"
          disabled={disabled}
        >
          <FlagComponent country={selectedCountry} countryName={selectedCountry} />
          <ChevronsUpDown className={cn('-mr-2 size-4 opacity-50', disabled ? 'hidden' : 'opacity-100')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('phone.searchCountry', 'Search country...')}
          />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>{t('phone.noCountry', 'No country found.')}</CommandEmpty>
            <CommandGroup>
              {options
                .filter((o): o is { label: string; value: Country } => !!o.value)
                .map(({ value, label }) => (
                <CommandItem
                  key={value}
                  className="gap-2"
                  onSelect={() => {
                    onChange(value)
                    setOpen(false)
                  }}
                >
                  <FlagComponent country={value} countryName={label} />
                  <span className="flex-1 text-sm">{label}</span>
                  <span className="text-sm text-foreground/50">
                    +{getCountryCallingCode(value)}
                  </span>
                  <CheckIcon
                    className={cn('ml-auto size-4', value === selectedCountry ? 'opacity-100' : 'opacity-0')}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// --- Main component ---

interface PhoneInputProps {
  value: string
  onChange: (value: string) => void
  id?: string
  placeholder?: string
  required?: boolean
  className?: string
  defaultCountry?: Country
  /** `data-testid` for the underlying text input. */
  testId?: string
}

export function PhoneInput({
  value,
  onChange,
  id,
  placeholder,
  required,
  className,
  defaultCountry = 'US',
  testId,
}: PhoneInputProps) {
  const { t } = useTranslation()
  const [touched, setTouched] = useState(false)

  // Validation: don't show "invalid" for partial numbers (still typing)
  const validationState = getValidationState(value)
  const showValid = touched && validationState === 'valid'
  const showInvalid = touched && validationState === 'invalid'

  return (
    <div
      className={cn('space-y-1', className)}
      onBlur={() => setTouched(true)}
    >
      <PhoneInputPrimitive
        className="flex"
        international
        defaultCountry={defaultCountry}
        value={(value || undefined) as Value | undefined}
        onChange={(val?: Value) => onChange(val || '')}
        flagComponent={FlagComponent}
        countrySelectComponent={CountrySelect}
        inputComponent={InputComponent}
        smartCaret={false}
        id={id}
        data-testid={testId}
        required={required}
        placeholder={placeholder}
      />
      {showValid && (
        <p className="text-xs text-green-600 dark:text-green-400">{t('phone.valid')}</p>
      )}
      {showInvalid && (
        <p role="alert" className="text-xs text-destructive">{t('phone.invalid')}</p>
      )}
      {!touched && !value && (
        <p className="text-xs text-muted-foreground">{t('phone.hint')}</p>
      )}
    </div>
  )
}

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

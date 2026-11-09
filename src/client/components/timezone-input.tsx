import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { listTimezones } from '@/lib/timezone'

/**
 * Free-text input with the runtime's IANA zones as suggestions. The server is the
 * validator: a value that is not a zone is refused there, and a typed value is
 * never rewritten here.
 */
export function TimezoneInput({ id, value, onChange, testId }: {
  id: string
  value: string
  onChange: (value: string) => void
  testId?: string
}) {
  const zones = useMemo(listTimezones, [])
  const listId = `${id}-zones`
  return (
    <>
      <Input
        id={id}
        data-testid={testId}
        list={listId}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        required
      />
      <datalist id={listId}>
        {zones.map(zone => <option key={zone} value={zone} />)}
      </datalist>
    </>
  )
}

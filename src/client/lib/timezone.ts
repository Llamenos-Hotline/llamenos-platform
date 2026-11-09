import { DEFAULT_HUB_TIMEZONE } from '@protocol/schemas/common'

/**
 * The IANA zone this device is set to, e.g. `America/New_York`.
 *
 * What a new hub is created in: the admin founding a hub is, in the common case,
 * in the place the hotline serves. The server never infers it. The result is
 * only a default for the admin to confirm or change, so a device that reports
 * no usable zone falls back to UTC, the server's own default.
 */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_HUB_TIMEZONE
  } catch {
    return DEFAULT_HUB_TIMEZONE
  }
}

/** Every IANA zone this runtime knows, for a picker. `UTC` is included even where the runtime omits it. */
export function listTimezones(): string[] {
  const zones = new Set<string>(Intl.supportedValuesOf('timeZone'))
  zones.add(DEFAULT_HUB_TIMEZONE)
  return [...zones].sort()
}

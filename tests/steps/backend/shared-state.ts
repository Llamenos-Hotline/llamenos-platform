/**
 * Shared response state accessor for backend BDD step definitions.
 *
 * State is stored in the scenario-scoped world fixture (not module-level).
 * Step files use getSharedState(world) / setLastResponse(world, res) to
 * read and write the shared response without cross-scenario leakage.
 */
import { getState, setState } from './fixtures'

/** A test actor capable of authenticating API requests. */
export interface ActingAdmin {
  seedHex: string
  pubkey: string
  deviceKey: string
}

export interface SharedResponseState {
  lastResponse?: { status: number; data: unknown }
  /** User created by "a registered user with a known keypair" — shared across step namespaces. */
  sharedUser?: { deviceKey: string; pubkey: string }
  /** Device IDs registered via "the user has a registered device" — shared across step namespaces. */
  sharedDeviceIds: string[]
  /** Map from feature-file device labels (e.g. "mls-device-2") to real registered device IDs. */
  sharedDeviceLabels: Record<string, string>
  /** Collected response statuses from flood/rate-limit tests (invite, webauthn). */
  floodResponses: number[]
  /**
   * The scenario's current "acting admin" actor for generic, cross-file admin
   * HTTP-verb steps (e.g. "the admin GETs {string}", "the admin POSTs to {string}").
   * Whichever Given step creates the scenario's admin-like actor (super admin,
   * hub admin, plain admin, …) sets this via setActingAdmin() so any step file's
   * generic verb step can act as that user without needing its own duplicate
   * actor-creation Given (which would collide as an ambiguous step definition).
   */
  actingAdmin?: ActingAdmin
}

const KEY = 'shared'

export function getSharedState(world: Record<string, unknown>): SharedResponseState {
  let s = getState<SharedResponseState | undefined>(world, KEY)
  if (!s) {
    s = { sharedDeviceIds: [], sharedDeviceLabels: {}, floodResponses: [] }
    setState(world, KEY, s)
  }
  if (!s.sharedDeviceIds) s.sharedDeviceIds = []
  if (!s.sharedDeviceLabels) s.sharedDeviceLabels = {}
  if (!s.floodResponses) s.floodResponses = []
  return s
}

export function setLastResponse(world: Record<string, unknown>, res: { status: number; data: unknown }): void {
  getSharedState(world).lastResponse = res
}

/** Record this scenario's acting admin actor for generic cross-file admin steps. */
export function setActingAdmin(world: Record<string, unknown>, actor: ActingAdmin): void {
  getSharedState(world).actingAdmin = actor
}

/** Read this scenario's acting admin actor, set by whichever Given step created it. */
export function getActingAdmin(world: Record<string, unknown>): ActingAdmin | undefined {
  return getSharedState(world).actingAdmin
}

/**
 * Resolve a feature-file device label (e.g. "mls-device-2") to its real registered device ID.
 * Falls back to the raw label if no mapping exists (for backwards compatibility with
 * steps that don't register devices, like the "non-member-device" negative test).
 */
export function resolveDeviceLabel(world: Record<string, unknown>, label: string): string {
  return getSharedState(world).sharedDeviceLabels[label] ?? label
}

/**
 * Shared response state accessor for backend BDD step definitions.
 *
 * State is stored in the scenario-scoped world fixture (not module-level).
 * Step files use getSharedState(world) / setLastResponse(world, res) to
 * read and write the shared response without cross-scenario leakage.
 */
import { getState, setState } from './fixtures'
import { ADMIN_SEED } from '../../api-helpers'

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
   * Seed hex of the actor set by the most recent "I am authenticated as ..."
   * Given step. Falls back to ADMIN_SEED (via getActorSeed) so scenarios that
   * never switch identity keep acting as the admin, same as before this field
   * existed.
   */
  actorSeedHex?: string
  /**
   * Values that generic "I POST/GET/PUT/DELETE to {string}" steps substitute
   * into `{placeholder}` segments of a request path, keyed without braces
   * (e.g. "ringGroupId" for a path segment written as "{ringGroupId}").
   * `{hubId}` is handled separately by resolvePathParams via the workerHub
   * fixture, since every scenario has it and no step needs to set it.
   */
  pathParams: Record<string, string>
}

const KEY = 'shared'

export function getSharedState(world: Record<string, unknown>): SharedResponseState {
  let s = getState<SharedResponseState | undefined>(world, KEY)
  if (!s) {
    s = { sharedDeviceIds: [], sharedDeviceLabels: {}, floodResponses: [], pathParams: {} }
    setState(world, KEY, s)
  }
  if (!s.sharedDeviceIds) s.sharedDeviceIds = []
  if (!s.sharedDeviceLabels) s.sharedDeviceLabels = {}
  if (!s.floodResponses) s.floodResponses = []
  if (!s.pathParams) s.pathParams = {}
  return s
}

export function setLastResponse(world: Record<string, unknown>, res: { status: number; data: unknown }): void {
  getSharedState(world).lastResponse = res
}

/** The seed hex of the currently "authenticated as" actor. Defaults to ADMIN_SEED. */
export function getActorSeed(world: Record<string, unknown>): string {
  return getSharedState(world).actorSeedHex ?? ADMIN_SEED
}

/** Set by "I am authenticated as ..." Given steps. */
export function setActorSeed(world: Record<string, unknown>, seedHex: string): void {
  getSharedState(world).actorSeedHex = seedHex
}

/** Record a value a later step's `{placeholder}` path segment should resolve to. */
export function setPathParam(world: Record<string, unknown>, key: string, value: string): void {
  getSharedState(world).pathParams[key] = value
}

/**
 * Resolve `{hubId}` and any other `{placeholder}` segments set via setPathParam
 * in a request path written literally in a feature file, e.g.
 * "/hubs/{hubId}/ring-groups/{ringGroupId}".
 */
export function resolvePathParams(world: Record<string, unknown>, rawPath: string, workerHub: string): string {
  let path = rawPath.replaceAll('{hubId}', workerHub)
  for (const [key, value] of Object.entries(getSharedState(world).pathParams)) {
    path = path.replaceAll(`{${key}}`, value)
  }
  return path
}

/**
 * Resolve a feature-file device label (e.g. "mls-device-2") to its real registered device ID.
 * Falls back to the raw label if no mapping exists (for backwards compatibility with
 * steps that don't register devices, like the "non-member-device" negative test).
 */
export function resolveDeviceLabel(world: Record<string, unknown>, label: string): string {
  return getSharedState(world).sharedDeviceLabels[label] ?? label
}

/**
 * Open relay frames in BDD steps (spec D9, #2999).
 *
 * The steps run under Node, where the crate's `bun:ffi` binding is unavailable,
 * so this uses the JS mirror of `packages/crypto/src/events.rs` in
 * `tests/mocks/hpke-mock.ts` — pinned to the crate by the v2 vectors
 * (`apps/worker/__tests__/unit/v2-vectors-mock.test.ts`).
 *
 * Keys are per (hub, epoch) and are fetched as the SUBSCRIBER: a user is handed
 * keys only for the hubs it belongs to, which is exactly what is being tested.
 */
import type { APIRequestContext } from '@playwright/test'
import type { ServerEventKey } from '@protocol/schemas/auth'
import { hexToBytes } from '@shared/encoding'
import { apiGet } from '../api-helpers'
import { openServerEventMock } from '../mocks/hpke-mock'
import type { CapturedEvent } from './relay-capture'

/** The relay-event keys `GET /api/auth/me` hands the user with `seedHex`. */
export async function fetchServerEventKeys(request: APIRequestContext, seedHex: string): Promise<ServerEventKey[]> {
  const { status, data } = await apiGet<{ serverEventKeys?: ServerEventKey[] }>(request, '/auth/me', seedHex)
  if (status !== 200 || !data?.serverEventKeys) {
    throw new Error(`GET /api/auth/me returned ${status} without serverEventKeys`)
  }
  return data.serverEventKeys
}

/** Open one captured frame with the key held for its hub and epoch. Throws when none is held. */
export function openRelayEvent(keys: readonly ServerEventKey[], event: CapturedEvent): Record<string, unknown> {
  const key = keys.find(k => k.hubId === event.hubId && k.epoch === event.epoch)
  if (!key) throw new Error(`no_event_key: no key held for hub ${event.hubId} epoch ${event.epoch}`)
  const json = openServerEventMock(hexToBytes(key.keyHex), event.hubId, event.kind, event.epoch, event.payload)
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('relay frame did not open to a JSON object')
  }
  return parsed as Record<string, unknown>
}

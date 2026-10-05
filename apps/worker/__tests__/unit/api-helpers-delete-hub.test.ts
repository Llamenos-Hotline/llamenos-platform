/**
 * `deleteHubViaApi` must throw on failure (#1502).
 *
 * It used to `console.warn`, so no suite could observe a hub that would not
 * delete — a success signal indistinguishable from an absent one. That is how
 * the `files.conversation_id` cascade defect survived two releases. These tests
 * exist to keep the property from regressing.
 */
import { describe, expect, it } from 'vitest'
import type { APIRequestContext } from '@playwright/test'
import { deleteHubViaApi, deleteHubViaApiIfPresent } from '../../../../tests/api-helpers'

function requestReturning(status: number): APIRequestContext {
  return {
    delete: async () => ({
      status: () => status,
      headers: () => ({ 'content-type': 'application/json' }),
      json: async () => ({}),
    }),
  } as unknown as APIRequestContext
}

describe('deleteHubViaApi', () => {
  it('resolves when the hub is deleted', async () => {
    await expect(deleteHubViaApi(requestReturning(200), 'hub-1')).resolves.toBeUndefined()
  })

  it('resolves on 204', async () => {
    await expect(deleteHubViaApi(requestReturning(204), 'hub-1')).resolves.toBeUndefined()
  })

  it('throws when the server refuses the delete', async () => {
    await expect(deleteHubViaApi(requestReturning(500), 'hub-1')).rejects.toThrow(/hub-1/)
  })

  it('throws on a 409 — a hub that will not delete is not a hub that deleted', async () => {
    await expect(deleteHubViaApi(requestReturning(409), 'hub-1')).rejects.toThrow(/409/)
  })

  it('throws on 404, so a caller must decide deliberately to tolerate it', async () => {
    await expect(deleteHubViaApi(requestReturning(404), 'hub-1')).rejects.toThrow(/404/)
  })
})

describe('deleteHubViaApiIfPresent', () => {
  it('tolerates a hub the scenario already deleted', async () => {
    await expect(deleteHubViaApiIfPresent(requestReturning(404), 'hub-1')).resolves.toBeUndefined()
  })

  it('still throws when the server refuses the delete', async () => {
    await expect(deleteHubViaApiIfPresent(requestReturning(500), 'hub-1')).rejects.toThrow(/hub-1/)
  })

  it('still throws on 409 — tolerant means "absent", not "any failure"', async () => {
    await expect(deleteHubViaApiIfPresent(requestReturning(409), 'hub-1')).rejects.toThrow(/409/)
  })
})

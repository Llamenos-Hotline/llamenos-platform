/**
 * `readJsonResponse` replaced `res.json().catch(() => null)` in the backend step files. The
 * point of the replacement is the non-JSON case, so that is what is pinned here: an HTML error
 * page must THROW, not become `data: null` that a status-only `Then` then waves through.
 */
import { describe, test, expect } from 'bun:test'
import type { APIResponse } from '@playwright/test'
import { readJsonResponse } from './api-helpers'

function response(status: number, body: string): APIResponse {
  return {
    status: () => status,
    url: () => 'http://localhost/api/x',
    text: async () => body,
  } as unknown as APIResponse
}

describe('readJsonResponse', () => {
  test('parses a JSON body and keeps the status', async () => {
    expect(await readJsonResponse(response(401, '{"error":"Unauthorized"}'))).toEqual({
      status: 401,
      data: { error: 'Unauthorized' },
    })
  })

  test('an empty body is null data, not an error', async () => {
    expect(await readJsonResponse(response(204, ''))).toEqual({ status: 204, data: null })
  })

  test('a non-JSON body throws, naming the status and the body', async () => {
    await expect(readJsonResponse(response(502, '<html>Bad Gateway</html>'))).rejects.toThrow(
      /HTTP 502.*non-JSON body: <html>Bad Gateway/,
    )
  })
})

/**
 * Shared assertion step definitions used across multiple feature files.
 *
 * These read from the shared state module so that any When step from
 * any step file can set the response and these Then steps can verify it.
 */
import { expect } from '@playwright/test'
import { Then } from './fixtures'
import { getSharedState } from './shared-state'

Then('the response status should be {int}', async ({ world }, expectedStatus: number) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  expect(getSharedState(world).lastResponse!.status).toBe(expectedStatus)
})

Then('the response status is {int}', async ({ world }, expectedStatus: number) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  expect(getSharedState(world).lastResponse!.status).toBe(expectedStatus)
})

Then('the response status should not be {int}', async ({ world }, unexpectedStatus: number) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  expect(getSharedState(world).lastResponse!.status).not.toBe(unexpectedStatus)
})

Then('the response should indicate the role is protected', async ({ world }) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  // System roles return 400 or 403 when deletion is attempted
  expect([400, 403]).toContain(getSharedState(world).lastResponse!.status)
})

Then('the response body {string} should be true', async ({ world }, field: string) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  const data = getSharedState(world).lastResponse!.data as Record<string, unknown> | null
  expect(data?.[field]).toBe(true)
})

Then('the error message contains {string}', async ({ world }, substring: string) => {
  expect(getSharedState(world).lastResponse).toBeDefined()
  const data = getSharedState(world).lastResponse!.data as { error?: string }
  expect(data.error).toBeDefined()
  expect(data.error!.toLowerCase()).toContain(substring.toLowerCase())
})

import { defineConfig } from '@playwright/test'

/**
 * API-level end-to-end call test against a real Asterisk. Not part of any
 * default suite: it needs the telephony stack, so run it via run-call-e2e.sh.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.TEST_HUB_URL ?? 'http://127.0.0.1:3931',
  },
})

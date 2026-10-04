import { defineConfig, devices } from '@playwright/test'
import { config } from 'dotenv'

// Load .env.live for Twilio credentials and staging config
config({ path: '.env.live' })

const baseURL = process.env.LIVE_BASE_URL || 'https://demo-next.llamenos-platform.com'

export default defineConfig({
  testDir: './tests/live',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Serial — shared Twilio state and staging instance
  reporter: process.env.CI
    ? [
        ['github'],
        ['json', { outputFile: 'test-results/results.json' }],
        ['line'],
      ]
    : [['list']],
  timeout: 120_000, // Calls take time to connect
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // No setup project. It existed only to wipe the target before the run, which
  // a deployed server correctly refuses — every test now asserts on a delta it
  // caused rather than on a clean slate (#1423).
  projects: [
    {
      name: 'live-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer — tests hit the deployed staging instance
})

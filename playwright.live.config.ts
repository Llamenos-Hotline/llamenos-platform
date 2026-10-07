import { defineConfig, devices } from '@playwright/test'
import { config } from 'dotenv'

// Load .env.live for Twilio credentials and staging config
config({ path: '.env.live' })

// No default. The old one named the demo instance, which #1604 retired along with demo
// mode — a live suite silently pointed at a host that no longer exists reports a deploy
// failure that is really a config failure. Say which deployment to check, or do not run.
const baseURL = process.env.LIVE_BASE_URL
if (!baseURL) {
  throw new Error('LIVE_BASE_URL is required: the live suite has no default deployment to check')
}

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

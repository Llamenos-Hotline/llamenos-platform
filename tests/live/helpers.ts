import Twilio from 'twilio'
import { expect, type Page, type APIRequestContext } from '@playwright/test'
import { TestIds } from '../test-ids'

// Re-export helpers that don't depend on ADMIN_SEED
export { enterPin } from '../helpers'

const STAGING_PIN = '12345678'

// Environment config — loaded from .env.live or process.env
function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}. Set it in .env.live or environment.`)
  return val
}

export function getLiveConfig() {
  return {
    accountSid: requireEnv('TWILIO_ACCOUNT_SID'),
    authToken: requireEnv('TWILIO_AUTH_TOKEN'),
    hotlineNumber: requireEnv('TWILIO_PHONE_NUMBER'),
    testCallerNumber: requireEnv('TWILIO_TEST_CALLER'),
    testSecret: requireEnv('E2E_TEST_SECRET'),
    adminSeed: requireEnv('STAGING_ADMIN_SEED'),
    baseURL: process.env.LIVE_BASE_URL || 'https://demo-next.llamenos-platform.com',
  }
}

export function createTwilioClient() {
  const { accountSid, authToken } = getLiveConfig()
  return Twilio(accountSid, authToken)
}

/**
 * Login as the staging admin using the raw Ed25519 signing seed hex from
 * STAGING_ADMIN_SEED (the same identity seed hex `bun run bootstrap-admin`
 * prints — see scripts/bootstrap-admin.ts). Device keys live behind Tauri
 * Stronghold (src/client/lib/platform.ts getSecureStore()), so there is no
 * localStorage blob to hand-roll (that was the pre-per-device-key nsec/ECIES
 * model) — import through the same `window.__TEST_PLATFORM` bridge the
 * desktop E2E suite uses in tests/helpers.ts loginAsAdmin's key-import path.
 */
export async function loginAsAdmin(page: Page) {
  const { adminSeed } = getLiveConfig()
  await page.goto('/login')
  await page.evaluate(() => {
    sessionStorage.clear()
    localStorage.clear()
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).__TEST_PLATFORM,
    { timeout: 15000 },
  )

  await page.evaluate(async ({ adminSeed, pin }) => {
    const platform = (window as unknown as Record<string, unknown>).__TEST_PLATFORM as {
      deviceImportAndLoad: (secretHex: string, pin: string, deviceId: string) => Promise<unknown>
      persistAndUnlockDeviceKeys: (encrypted: unknown, pin: string) => Promise<unknown>
      lockCrypto: () => Promise<void>
    }
    const encrypted = await platform.deviceImportAndLoad(adminSeed, pin, crypto.randomUUID())
    await platform.persistAndUnlockDeviceKeys(encrypted, pin)
    await platform.lockCrypto()
  }, { adminSeed, pin: STAGING_PIN })

  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // Enter PIN
  const pinInput = page.getByTestId('pin-input').locator('input')
  await pinInput.waitFor({ state: 'visible', timeout: 10000 })
  await pinInput.fill(STAGING_PIN)
  await pinInput.press('Enter')

  await expect(page.getByTestId(TestIds.PAGE_TITLE)).toBeVisible({ timeout: 15000 })
}

interface CallHotlineOptions {
  /** DTMF digits to send after connecting (e.g., 'wwwwwwwwww2' = wait 5s then press 2) */
  sendDigits?: string
  /** Timeout in seconds before Twilio stops ringing (default: 60) */
  timeout?: number
  /** Status callback URL — if provided, Twilio POSTs status events here */
  statusCallback?: string
}

/**
 * Initiate an outbound call from the test caller number to the hotline.
 * Returns the Call SID for status polling.
 */
export async function callHotline(options: CallHotlineOptions = {}) {
  const client = createTwilioClient()
  const config = getLiveConfig()

  const call = await client.calls.create({
    to: config.hotlineNumber,
    from: config.testCallerNumber,
    url: `${config.baseURL}/api/telephony/incoming`,
    timeout: options.timeout ?? 60,
    ...(options.sendDigits ? { sendDigits: options.sendDigits } : {}),
    ...(options.statusCallback ? {
      statusCallback: options.statusCallback,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    } : {}),
  })

  return {
    sid: call.sid,
    status: call.status,
  }
}

/**
 * Send an SMS from the test caller number to the hotline number.
 */
export async function sendSMS(body: string) {
  const client = createTwilioClient()
  const config = getLiveConfig()

  const message = await client.messages.create({
    to: config.hotlineNumber,
    from: config.testCallerNumber,
    body,
  })

  return {
    sid: message.sid,
    status: message.status,
  }
}

type CallStatus = 'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer' | 'canceled'

/**
 * Poll Twilio API until a call reaches the expected status.
 */
export async function waitForCallStatus(
  sid: string,
  targetStatus: CallStatus | CallStatus[],
  timeoutMs = 60_000,
): Promise<string> {
  const client = createTwilioClient()
  const targets = Array.isArray(targetStatus) ? targetStatus : [targetStatus]
  const start = Date.now()
  const pollInterval = 2_000

  while (Date.now() - start < timeoutMs) {
    const call = await client.calls(sid).fetch()
    if (targets.includes(call.status as CallStatus)) {
      return call.status
    }
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(call.status) &&
        !targets.some(t => ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(t))) {
      throw new Error(`Call ${sid} reached terminal status '${call.status}' while waiting for ${targets.join('|')}`)
    }
    await new Promise(r => setTimeout(r, pollInterval))
  }

  const call = await client.calls(sid).fetch()
  if (targets.includes(call.status as CallStatus)) {
    return call.status
  }
  throw new Error(`Timed out waiting for call ${sid} to reach status ${targets.join('|')} (current: ${call.status})`)
}

/**
 * Hang up a call via the Twilio API.
 */
export async function hangUp(sid: string) {
  const client = createTwilioClient()
  await client.calls(sid).update({ status: 'completed' })
}

/**
 * How many calls this hub has recorded today.
 *
 * This replaces a global reset. The suite used to POST /api/test-reset-records
 * before the run and then assert "some call row is visible", which a row left
 * over from a previous run satisfied just as well — so the assertion could not
 * fail. A DELTA proves the call this test placed is the one that landed, and
 * needs no clean slate at all.
 *
 * That matters beyond assertion strength: there is no way to reset a
 * production-shaped deployment through any route, by design. `devGuard`
 * (app.ts) answers 404 for every /api/test-* outside a development server, and
 * `demoResetRefusal` gates /api/demo/reset on exactly the same condition. A
 * suite that needs a wipe can only ever run against a development box, which
 * is the opposite of what a LIVE suite is for. See #1423.
 */
export async function callCount(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/calls/today-count')
  if (!res.ok()) {
    throw new Error(`GET /api/calls/today-count failed: ${res.status()} ${await res.text()}`)
  }
  return (await res.json()).count as number
}

/** Total conversations the hub can see — same delta technique as callCount. */
export async function conversationCount(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/conversations')
  if (!res.ok()) {
    throw new Error(`GET /api/conversations failed: ${res.status()} ${await res.text()}`)
  }
  const body = await res.json()
  return Array.isArray(body) ? body.length : (body.conversations?.length ?? 0)
}

/**
 * Wait a fixed number of milliseconds.
 */
export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

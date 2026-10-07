import Twilio from 'twilio'
import { expect, type Page, type APIRequestContext } from '@playwright/test'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_DEVICE_ENCRYPTION_SEED, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { buildAuthMessage } from '@shared/auth-message'
import { TestIds } from '../test-ids'
import { apiGet, apiPatch } from '../api-helpers'
import { generateContentKey, wrapKeyForRecipient, unwrapKey } from '../crypto-helpers'

// Re-export helpers that don't depend on ADMIN_SEED
export { enterPin } from '../helpers'

const STAGING_PIN = '12345678'

// Environment config — loaded from .env.live or process.env
function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}. Set it in .env.live or environment.`)
  return val
}

/**
 * The deployment and the Twilio account used to call it.
 *
 * No `E2E_TEST_SECRET`. It only ever authenticated `POST
 * /api/test-reset-records` for the `resetStaging` helper, and that route does
 * not exist on a deployment — `devGuard` 404s it (#1423). The helper went in
 * #1442; requiring the secret outlived it, so a live run with valid Twilio
 * credentials and no leftover E2E_TEST_SECRET threw before placing a call.
 */
export function getLiveConfig() {
  return {
    accountSid: requireEnv('TWILIO_ACCOUNT_SID'),
    authToken: requireEnv('TWILIO_AUTH_TOKEN'),
    hotlineNumber: requireEnv('TWILIO_PHONE_NUMBER'),
    testCallerNumber: requireEnv('TWILIO_TEST_CALLER'),
    adminSeed: requireEnv('STAGING_ADMIN_SEED'),
    baseURL: requireEnv('LIVE_BASE_URL'),
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
 * (app.ts) answers 404 for every /api/test-* unless the host declared itself a
 * test target AND the request carries its shared secret. A suite that needs a
 * wipe can only ever run against such a box, which is the opposite of what a
 * LIVE suite is for. See #1423.
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

// ───────────────────────────────────────────────────────────────────
// R1 acceptance helpers
//
// Everything below talks to a DEPLOYMENT through the same routes the
// shipped clients use. Two rules hold throughout, and they are the reason
// these helpers exist instead of the ones in tests/api-helpers.ts:
//
//  1. No dev routes. `devGuard` (apps/worker/app.ts) answers 404 for every
//     /api/test-* unless ENVIRONMENT=development AND DEV_ROUTES_ENABLED=true,
//     and a deployment satisfies neither. `createHubViaApi`,
//     `createUserViaApi`, `cleanupTestData` and friends all go through those,
//     so none of them can be used here (#1423).
//  2. No clean slate. There is no reset on a deployment, by design. Every
//     assertion is therefore a delta the test caused, never "a row exists".
// ───────────────────────────────────────────────────────────────────

/** The seed an R1 live run authenticates as. Throws rather than skipping. */
export function requireAdminSeed(): string {
  const seed = process.env.STAGING_ADMIN_SEED
  if (!seed) {
    throw new Error(
      'STAGING_ADMIN_SEED is required: the hex identity seed `bun run bootstrap-admin` '
      + 'prints for the deployment being checked.',
    )
  }
  return seed
}

/**
 * The hub an R1 deployment serves callers from.
 *
 * R1 is one VM with one hotline, so there is exactly one active hub and
 * /api/config publishes it as `defaultHubId`. Resolving it from the server
 * rather than from an env var is deliberate: a deployment where the setup
 * wizard never finished has no hub, and this throws there instead of
 * silently exercising the unscoped (hubId `''`) routes, which answer 200
 * and touch nothing a caller can reach.
 */
export async function resolveHubId(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/config')
  if (!res.ok()) throw new Error(`GET /api/config failed: ${res.status()}`)
  const cfg = await res.json() as { defaultHubId?: string; hubs?: Array<{ id: string; status: string }> }
  const hubId = cfg.defaultHubId ?? cfg.hubs?.find(h => h.status === 'active')?.id
  if (!hubId) {
    throw new Error(
      'this deployment has no active hub — the setup wizard has not been completed, '
      + 'so no part of the R1 flow can run (see deployment-readiness.spec.ts)',
    )
  }
  return hubId
}

/**
 * Narrow a value the test has just asserted the presence of.
 *
 * Preferred to `!`, which turns a missing field into a TypeError three lines
 * later with no indication of what was missing — the failure mode #1271 and
 * #1323 are about, read backwards.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing from the response`)
  }
  return value
}

/**
 * The Ed25519 identity pubkey a signing seed authenticates as.
 *
 * The operator's own identity is the default RINGING subject for this suite,
 * because it holds a hub role unconditionally (`POST /hubs` makes its creator
 * hub-admin) and so can never drop out of the ring set for a reason that has
 * nothing to do with shifts or clock-ins.
 *
 * An invited volunteer CAN be a ring subject, but only deliberately:
 * `IdentityService.redeemInvite` writes `hubRoles` from the invite's
 * `roleIds`, and an invite that named none grants none (#1446) — such a member
 * is refused by `hubContext` with 403 before any call logic runs, and
 * `resolveRingableVolunteers`'s `hasHubAccess` filter removes them from the
 * ring set. So an invite used to make a ring subject must name a role
 * explicitly, as the first-pickup-wins test in call-handling.spec.ts does.
 */
export function adminPubkeyFromSeed(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
}

/** A label that identifies a row as this suite's, and which run made it. */
export function liveMarker(what: string): string {
  return `r1-live-${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A fresh Ed25519 identity, as a client generates for a new device. */
export function freshIdentity(): { seedHex: string; pubkey: string } {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const seedHex = bytesToHex(seed)
  return { seedHex, pubkey: bytesToHex(ed25519.getPublicKey(seed)) }
}

// ── The rate-limit tiers a deployment applies ──────────────────────
//
// `strict` — `/api/invites/*`, `/api/auth/*`, `/api/webauthn/*`,
// `/api/provision/*` and `/api/recovery-group/*` all share ONE fixed-window
// budget: 5 requests per minute, keyed `strict:<client ip>`
// (apps/worker/middleware/rate-limit.ts).
//
// `write` — EVERY authenticated mutation (app.ts picks the tier by method):
// 30 per minute, keyed `write:<pubkey>`. A suite that writes as one identity
// meets this long before it meets anything else.
//
// The middleware returns early when `ENVIRONMENT=development`, so CI and the
// BDD suite never meet either — a deployment-facing suite is the first thing
// that does.
//
// Pacing is not a workaround for a defect; the limit is part of the
// deployment's contract and a suite that ignored it would report 429 as a
// broken invite flow, or as a volunteer being refused. What it must NOT do is retry forever: a 429 that
// outlives a full window is a real condition an operator needs told about,
// so the last attempt's status is returned and asserted like any other.

const WINDOW_MS = 60_000
const BUDGETS = { strict: 5, write: 30 } as const
const TIER_DETAIL: Record<keyof typeof BUDGETS, string> = {
  strict:
    'The strict tier is 5 requests/minute shared across /invites, /auth, /webauthn, '
    + '/provision and /recovery-group, keyed by client IP — something else is consuming '
    + "this deployment's budget, or the proxy is not forwarding a client IP so every "
    + 'caller shares one bucket.',
  write:
    'The write tier is 30 mutations/minute keyed by PUBKEY (app.ts: every authenticated '
    + 'non-GET) — another client signing as this same identity is consuming the budget.',
}
/** Timestamps of this run's calls per tier, newest last. */
const spent: Record<keyof typeof BUDGETS, number[]> = { strict: [], write: [] }

/**
 * Run one rate-limited request, waiting first if this run has already spent the
 * window's budget, and once more if the server says 429 anyway (the server's
 * window is fixed and does not line up with this run's start).
 */
async function paced<T extends { status: number }>(
  tier: keyof typeof BUDGETS,
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Date.now()
    spent[tier] = spent[tier].filter(t => now - t < WINDOW_MS)
    if (spent[tier].length >= BUDGETS[tier]) {
      await sleep(WINDOW_MS - (now - spent[tier][0]) + 1_000)
      spent[tier] = []
    }
    spent[tier].push(Date.now())

    const result = await call()
    if (result.status !== 429) return result
    if (attempt === 0) {
      // Spend the rest of the server's window, then try once more.
      spent[tier] = []
      await sleep(WINDOW_MS + 1_000)
    }
  }
  throw new Error(
    `${what}: the deployment answered 429 twice, a minute apart. ${TIER_DETAIL[tier]}`,
  )
}

/** One `strict`-tier request (5/min by IP), paced. */
export async function pacedStrict<T extends { status: number }>(
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  return paced('strict', what, call)
}

/**
 * One `write`-tier request (30/min by pubkey), paced.
 *
 * Every authenticated mutation on a deployment is in this tier, so a suite
 * that writes more than thirty times a minute as one identity reads its own
 * 429 as the behaviour under test. The ring-decision block needs roughly that
 * many, which is why it waits rather than failing — the limit is part of the
 * deployment's contract, not a defect.
 */
export async function pacedWrite<T extends { status: number }>(
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  return paced('write', what, call)
}

/** `GET /api/invites/validate/:code` — public, strict-tier, paced. */
export async function validateInvite(
  request: APIRequestContext,
  code: string,
): Promise<{ status: number; body: { valid?: boolean; error?: string; name?: string } }> {
  return pacedStrict(`GET /api/invites/validate/${code}`, async () => {
    const res = await request.get(`/api/invites/validate/${code}`, { failOnStatusCode: false })
    return { status: res.status(), body: await res.json().catch(() => ({})) }
  })
}

/**
 * Redeem an invite as a brand-new identity — the volunteer's half of the
 * operator's invitation.
 *
 * POST /api/invites/redeem is a PUBLIC route that carries its own Ed25519
 * proof in the BODY (code/pubkey/timestamp/token), not in an Authorization
 * header, and its schema has no nonce field. `apiPost` cannot produce it, so
 * the token is built here with the canonical shared builder, which selects the
 * nonce-less domain-separation label — never from a literal.
 */
export async function redeemInvite(
  request: APIRequestContext,
  code: string,
  seedHex: string,
): Promise<{ status: number; body: unknown }> {
  const seedBytes = hexToBytes(seedHex)
  const pubkey = bytesToHex(ed25519.getPublicKey(seedBytes))
  const timestamp = Date.now()
  const path = '/api/invites/redeem'
  const message = buildAuthMessage(pubkey, timestamp, 'POST', path)
  const token = bytesToHex(ed25519.sign(message, seedBytes))

  return pacedStrict('POST /api/invites/redeem', async () => {
    const res = await request.post(path, {
      headers: { 'Content-Type': 'application/json' },
      data: { code, pubkey, timestamp, token },
      failOnStatusCode: false,
    })
    return { status: res.status(), body: await res.json().catch(() => null) as unknown }
  })
}

/**
 * Take a volunteer this suite created out of service.
 *
 * Not tidying up: `resolveRingableVolunteers`
 * (apps/worker/services/ringing.ts) filters on `active`, so an identity left
 * active is one a real caller could in principle be routed to if anyone later
 * added it to a shift or the fallback group. Deactivating closes that off and
 * leaves the row — the invite, the audit entries and the user all stay visible
 * to an operator, which is what "write something identifiable and leave it"
 * means. Nothing is deleted.
 *
 * Deliberately NOT hub-scoped. `PATCH /api/hubs/:hubId/users/:pubkey` answers
 * 404 for a volunteer who joined by redeeming an invite, because such a user
 * has no hubRoles and the hub-scoped router cannot see them (the defect
 * volunteer-onboarding.spec.ts's last test reports). An earlier version of
 * this helper used that path inside a bare try/catch and left every identity
 * it created still active, which is precisely the silent failure this suite
 * exists to find — so the outcome is read back and, if it did not take, said
 * out loud with the pubkey an operator needs.
 *
 * Never throws: this runs in `afterAll`, where an exception would be reported
 * as a test failure of its own and bury whatever actually failed.
 */
export async function retireLiveIdentity(
  request: APIRequestContext,
  adminSeed: string,
  pubkey: string,
): Promise<void> {
  try {
    await apiPatch(request, `/users/${pubkey}`, { active: false }, adminSeed)
    const { status, data } = await apiGet<{ active?: boolean }>(request, `/users/${pubkey}`, adminSeed)
    if (status === 200 && data.active === false) return
  } catch {
    // Fall through to the warning.
  }
  console.warn(
    `[live] could not deactivate the identity this run created: ${pubkey}\n`
    + '       It is still active and could be rung if it is ever added to a shift or '
    + 'fallback group. Deactivate it from the volunteers screen.',
  )
}

// ── Note envelope crypto ───────────────────────────────────────────

/**
 * The X25519 secret/public pair a client derives for a device imported from
 * an Ed25519 signing seed: HKDF-SHA256(signingSeed, salt="",
 * info=LABEL_DEVICE_ENCRYPTION_SEED). Mirrors
 * `deviceEncryptionPubkeyFromSigningSeed` in tests/crypto-helpers.ts and the
 * derivation in packages/crypto — so an envelope sealed to this public key is
 * one the real device holding that seed could open.
 */
export function deviceEncryptionKeypair(signingSeedHex: string): { skHex: string; pubkeyHex: string } {
  const encryptionSeed = hkdf(
    sha256,
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return { skHex: bytesToHex(encryptionSeed), pubkeyHex: bytesToHex(x25519.getPublicKey(encryptionSeed)) }
}

const hexToB64url = (hex: string) =>
  Buffer.from(hexToBytes(hex)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlToHex = (b64url: string) =>
  bytesToHex(new Uint8Array(Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')))

/**
 * Encrypt a note the way the desktop client's `encryptNote`
 * (src/client/lib/platform.ts) does, byte format included:
 *   content  — hex(iv(12) || AES-256-GCM(ct || tag)), no AAD
 *   envelope — enc hex, ct base64url, HPKE-sealed under LABEL_NOTE_KEY
 *
 * The format matters. A note the server round-trips but the shipped client
 * cannot open is not a note an admin can read, so the shapes are matched
 * rather than invented.
 */
export async function sealNote(
  plaintext: string,
  authorSigningSeed: string,
  adminPubkeys: Array<{ identity: string; encryption: string }>,
): Promise<{
  encryptedContent: string
  authorEnvelope: { enc: string; ct: string }
  adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
}> {
  const contentKey = generateContentKey()

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = gcm(contentKey, iv).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(iv.length + sealed.length)
  packed.set(iv)
  packed.set(sealed, iv.length)

  const author = deviceEncryptionKeypair(authorSigningSeed)
  const wrapped = await wrapKeyForRecipient(contentKey, author.pubkeyHex, '', LABEL_NOTE_KEY)

  const adminEnvelopes = await Promise.all(adminPubkeys.map(async (admin) => {
    const env = await wrapKeyForRecipient(contentKey, admin.encryption, '', LABEL_NOTE_KEY)
    return { pubkey: admin.identity, enc: env.enc, ct: hexToB64url(env.ct) }
  }))

  return {
    encryptedContent: bytesToHex(packed),
    authorEnvelope: { enc: wrapped.enc, ct: hexToB64url(wrapped.ct) },
    adminEnvelopes,
  }
}

/** Open a note sealed by `sealNote`, as a reader holding `recipientSkHex` does. */
export async function openNote(
  encryptedContent: string,
  envelope: { enc?: string; ct?: string },
  recipientSkHex: string,
): Promise<string> {
  // A missing half of the envelope is a server that dropped or rewrote it, not
  // a crypto failure — say which, because `hpke.open` would otherwise surface
  // it as an unexplained TypeError inside a hex decoder.
  if (!envelope?.enc || !envelope?.ct) {
    throw new Error(
      `the stored key envelope is incomplete (enc=${envelope?.enc ? 'present' : 'missing'}, `
      + `ct=${envelope?.ct ? 'present' : 'missing'}) — the server did not persist what the client sent`,
    )
  }
  const contentKey = await unwrapKey(b64urlToHex(envelope.ct), envelope.enc, recipientSkHex, LABEL_NOTE_KEY)
  const data = hexToBytes(encryptedContent)
  return new TextDecoder().decode(gcm(contentKey, data.slice(0, 12)).decrypt(data.slice(12)))
}

// ── Driving an inbound call the way the deployment's own PBX does ───
//
// R1's middle clause — "that volunteer ... receives a call, answers it" — had
// no live evidence at all, and could not have any: the only answer test was a
// negative probe (401/404 for a call that does not exist), because the suite
// had no way to make a call exist. Twilio's half places a real call but never
// answers it, and the one block that does answer runs only where the mock
// telephony provider is selectable, which a production deployment is not.
//
// What follows closes that by driving the webhook chain a PBX drives, signed
// with the credential that deployment's PBX signs it with. Be precise about
// what that is and is not:
//
//   IS real — hub resolution from the dialled number, the ban check, the IVR
//   language menu, the per-caller spam window, `startParallelRinging` and so
//   the call record, `resolveRingableVolunteers` (shift ∩ clock-in), the relay
//   `call:ring`, the answer route with its first-pickup-wins guard and
//   `cancelLosingLegs`, and `endCall` into history. Every webhook is checked
//   by the real `validateWebhook` — real HMAC, real ±60s window, real
//   body-hash replay protection.
//
//   IS NOT real — SIP signalling and RTP. No phone is dialled and no channel
//   exists on the PBX. This stands IN FOR the PBX; it does not pretend to be
//   a telephone.
//
// A genuine SIP call, carrier included, is covered by a different harness that
// cannot run from here: `deploy/docker/tests/telephony/run-call-e2e.sh` puts a
// second Asterisk playing the phone network on one Docker network with the
// app. It needs the app INSIDE that network (Asterisk fetches prompts from the
// origin it reaches, and ufw drops container→host on a default box), and it
// seeds through `/api/test-*`. Neither is available against a deployment, so
// real SIP stays there and this stays here.

/** The provider a deployment answers calls with, as the operator configured it. */
export interface LiveTelephonyProvider {
  type?: string
  phoneNumber?: string
  /** `asterisk` — the HMAC-SHA256 secret the ARI bridge signs webhooks with. */
  bridgeSecret?: string
  /** `freeswitch` — the same, under the name that adapter stores it as. */
  freeswitchBridgeSecret?: string
  /** `twilio`/`signalwire` — the HMAC-SHA1 key those sign webhooks with. */
  authToken?: string
}

/**
 * The telephony provider this deployment is configured with.
 *
 * `GET /api/settings/telephony-provider` serves the DECRYPTED credential set
 * to a caller holding `settings:manage-telephony`, which is how the operator's
 * own settings screen populates its form. That is the only way a suite can
 * sign a webhook the deployment will accept, and it needs no new secret in
 * `.env.live`: the admin seed this suite already holds is strictly more
 * powerful than the provider credential it reads with it.
 *
 * The hub row is asked for first and the global row second, matching the
 * resolution order `getHubTelephonyFromService` uses for a real call. A hub
 * with no row of its own answers `null` and falls through to global, exactly
 * as call handling does.
 */
export async function readTelephonyProvider(
  request: APIRequestContext,
  adminSeed: string,
  hubId: string,
): Promise<LiveTelephonyProvider | null> {
  for (const path of [`/hubs/${hubId}/settings/telephony-provider`, '/settings/telephony-provider']) {
    const { status, data } = await apiGet<LiveTelephonyProvider | null>(request, path, adminSeed)
    if (status === 200 && data && data.type) return data
  }
  return null
}

/** The signing key and wire format a provider's webhooks use, or null. */
function webhookSigning(provider: LiveTelephonyProvider):
  | { family: 'bridge' | 'twilio'; secret: string }
  | null {
  switch (provider.type) {
    case 'asterisk':
      return provider.bridgeSecret ? { family: 'bridge', secret: provider.bridgeSecret } : null
    case 'freeswitch':
      return provider.freeswitchBridgeSecret
        ? { family: 'bridge', secret: provider.freeswitchBridgeSecret }
        : null
    case 'twilio':
    case 'signalwire':
      return provider.authToken ? { family: 'twilio', secret: provider.authToken } : null
    default:
      return null
  }
}

/**
 * Why this deployment's inbound call path cannot be driven, or null when it
 * can.
 *
 * Every reason here is an absent CREDENTIAL or an absent provider — never
 * absent data. "No call record exists" is not among them: that is the thing
 * these tests create, and skipping on it is exactly how the answer path went
 * unverified for months.
 */
export function inboundDriveRefusal(provider: LiveTelephonyProvider | null): string | null {
  if (!provider) {
    return 'this deployment has no telephony provider configured, so there is no inbound '
      + 'call path to drive and no credential to sign one with — complete the provider step '
      + 'of the setup wizard (deployment-readiness.spec.ts reports this too)'
  }
  if (!webhookSigning(provider)) {
    return `this deployment's telephony provider is "${provider.type}", whose webhook `
      + 'signature this suite cannot produce. Supported: asterisk and freeswitch (HMAC-SHA256 '
      + 'bridge signature) and twilio/signalwire (HMAC-SHA1 request signature). The provider '
      + 'row also has to carry the signing credential; a row configured through the OAuth flow '
      + 'may not.'
  }
  return null
}

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64')

async function hmac(algorithm: 'SHA-1' | 'SHA-256', secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign'],
  )
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

/**
 * The absolute URLs a signature might have been computed over, best first.
 *
 * Both adapters sign the request URL, and neither can be told what it is from
 * outside:
 *
 *  - the bridge adapter signs RAW `request.url` — the URL the app process
 *    sees. Behind a TLS-terminating proxy that is `http://`, not `https://`,
 *    even though the caller used `https://` (the Host header is preserved, the
 *    scheme is not).
 *  - the Twilio adapter signs `WEBHOOK_BASE_URL.origin + pathname + search`,
 *    falling back to `request.url` when that variable is unset — and
 *    `WEBHOOK_BASE_URL` is server-side config this suite cannot read.
 *
 * So both renderings are tried. This is NOT a retry that papers over a bad
 * signature: a 403 from every candidate is returned as a 403 and fails the
 * test, naming this as the cause.
 */
function signableUrls(baseURL: string, path: string): string[] {
  const base = new URL(baseURL)
  const https = `${base.origin}${path}`
  const http = `http://${base.host}${path}`
  return https === http ? [https] : [https, http]
}

/**
 * POST one telephony webhook, signed as this deployment's provider signs it.
 *
 * `fields` is given in the bridge's JSON vocabulary and translated for the
 * Twilio family, so a caller writes the call once. The body shapes mirror what
 * each provider actually sends — the bridge's `call-status` body carries
 * `channelId`, as `sip-bridge/src/command-handler` does, and that is
 * load-bearing: webhook replay protection hashes the BODY ALONE
 * (services/webhook-replay.ts, 300s window), so two calls completing inside
 * five minutes with byte-identical bodies would see the second silently
 * swallowed as a replay and never reach history.
 */
export async function postProviderWebhook(
  request: APIRequestContext,
  provider: LiveTelephonyProvider,
  baseURL: string,
  path: string,
  fields: { callSid: string; callerNumber?: string; calledNumber?: string; digits?: string; status?: string },
): Promise<{ status: number; body: string }> {
  const signing = webhookSigning(provider)
  if (!signing) throw new Error('postProviderWebhook called for a provider that cannot be signed')

  let last: { status: number; body: string } = { status: 0, body: '' }
  for (const url of signableUrls(baseURL, path)) {
    const headers: Record<string, string> = {}
    let body: string

    if (signing.family === 'bridge') {
      const payload: Record<string, string> = { channelId: fields.callSid }
      if (fields.callerNumber) payload.callerNumber = fields.callerNumber
      if (fields.calledNumber) payload.calledNumber = fields.calledNumber
      if (fields.digits !== undefined) payload.digits = fields.digits
      if (fields.status) { payload.event = 'call-status'; payload.status = fields.status }
      body = JSON.stringify(payload)
      const timestamp = String(Date.now())
      headers['Content-Type'] = 'application/json'
      headers['X-Bridge-Timestamp'] = timestamp
      headers['X-Bridge-Signature'] = await hmac('SHA-256', signing.secret, `${timestamp}.${url}.${body}`)
    } else {
      const form = new URLSearchParams()
      form.set('CallSid', fields.callSid)
      if (fields.callerNumber) form.set('From', fields.callerNumber)
      if (fields.calledNumber) form.set('To', fields.calledNumber)
      if (fields.digits !== undefined) form.set('Digits', fields.digits)
      if (fields.status) form.set('CallStatus', fields.status)
      body = form.toString()
      // url + each key and value concatenated, sorted by key (twilio.ts).
      const sorted = [...form.entries()].sort(([a], [b]) => a.localeCompare(b))
      const data = url + sorted.map(([k, v]) => k + v).join('')
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['X-Twilio-Signature'] = await hmac('SHA-1', signing.secret, data)
    }

    const res = await request.post(url, { headers, data: body, failOnStatusCode: false })
    last = { status: res.status(), body: await res.text() }
    if (last.status !== 403) return last
  }
  return last
}

/** A caller number no other test or previous run shares. */
export function liveCallerNumber(): string {
  // The hub's per-caller window is 3 calls a minute, keyed on the HASHED
  // number (DEFAULT_SPAM_SETTINGS), so every driven call needs its own.
  return `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`
}

/** A call id this suite's rows can be recognised by in an operator's history. */
export function liveCallSid(): string {
  return `r1-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

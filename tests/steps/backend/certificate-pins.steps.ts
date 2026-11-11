/**
 * Step definitions for security/certificate-pins.feature (#1698).
 *
 * The expected pins are DERIVED AT RUNTIME from the published ISRG root
 * certificates committed at tests/fixtures/isrg/ (public certificate material —
 * see the README there). Nothing here reads the constants in
 * apps/worker/routes/config.ts: comparing the served pins against a value added
 * by the same commit would be circular and would pass on a wrong pin, which is
 * precisely the failure this feature exists to catch.
 *
 * The fixtures themselves are held to Let's Encrypt's published certificate
 * fingerprints below, so swapping or corrupting a fixture fails loudly rather
 * than quietly redefining what "correct" means.
 */
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { When, Then } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'

/** SHA-256 fingerprints of the four roots as published by Let's Encrypt. */
const PUBLISHED_FINGERPRINTS = {
  'isrg-root-x1': '96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6',
  'isrg-root-x2': '69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70',
  'isrg-root-yr': 'E5:7B:7E:6F:15:0C:41:91:02:E8:D5:C0:55:72:9F:F9:67:B9:D1:A8:29:BF:00:CE:C8:9C:A6:04:EB:F4:A8:6F',
  'isrg-root-ye': 'E1:4F:FC:AD:5B:00:25:73:10:06:CA:A4:3A:12:1A:22:D8:E9:70:0F:4F:B9:CF:85:2F:02:A7:08:AA:5D:56:66',
} as const

type RootName = keyof typeof PUBLISHED_FINGERPRINTS

/** The standard "pin-sha256" value: SHA-256 over the SubjectPublicKeyInfo DER, base64. */
function derivePin(root: RootName): string {
  const path = new URL(`../../fixtures/isrg/${root}.crt`, import.meta.url)
  const cert = new X509Certificate(readFileSync(path))
  expect(
    cert.fingerprint256,
    `tests/fixtures/isrg/${root}.crt is not the certificate Let's Encrypt publishes — a pin ` +
      `derived from it would define "correct" wrongly`,
  ).toBe(PUBLISHED_FINGERPRINTS[root])
  const spkiDer = cert.publicKey.export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(spkiDer).digest('base64')
}

interface PinEntry {
  algorithm?: unknown
  hash?: unknown
  label?: unknown
}

interface PinsBody {
  pins?: PinEntry[]
  notBefore?: unknown
  notAfter?: unknown
  signature?: unknown
}

function lastPinsBody(world: Record<string, unknown>): PinsBody {
  const data = getSharedState(world).lastResponse?.data
  if (typeof data !== 'object' || data === null) {
    throw new Error(`expected an object response body, got: ${JSON.stringify(data)}`)
  }
  return data as PinsBody
}

// ── When ─────────────────────────────────────────────────────────────

When('an anonymous caller fetches the certificate pin list', async ({ request, world }) => {
  // Deliberately no auth headers: clients fetch this before login, so the
  // scenario must read it the way a client does.
  const res = await request.get('/api/config/pins')
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

// ── Then ─────────────────────────────────────────────────────────────

Then('every served pin is the SPKI hash of a published Let\'s Encrypt root', ({ world }) => {
  const body = lastPinsBody(world)
  expect(Array.isArray(body.pins), `pins must be an array, got: ${JSON.stringify(body)}`).toBe(true)
  const served = (body.pins ?? []).map((p) => p.hash)

  for (const pin of body.pins ?? []) {
    expect(pin.algorithm, `pin algorithm must be sha256: ${JSON.stringify(pin)}`).toBe('sha256')
    expect(
      typeof pin.hash === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(pin.hash),
      `pin hash must be a base64 SHA-256 (32 bytes): ${JSON.stringify(pin)}`,
    ).toBe(true)
  }
  expect(new Set(served).size, `duplicate pins served: ${JSON.stringify(served)}`).toBe(served.length)

  // All four roots stay acceptable on purpose: a pin covers the public key, so a
  // set trimmed to the root in use today would still match today's chain and only
  // brick clients when the chain changes. A served pin outside the four, though,
  // is a pin no genuine Let's Encrypt chain can satisfy.
  const allowed = (Object.keys(PUBLISHED_FINGERPRINTS) as RootName[]).map(derivePin)
  const strangers = served.filter((h) => !allowed.includes(h as string))
  expect(
    strangers,
    `served pins that are NOT the SPKI SHA-256 of any published ISRG root ` +
      `(X1/X2/YR/YE, derived from tests/fixtures/isrg/): ${JSON.stringify(strangers)}. A wrong ` +
      `pin bricks every Android client while the web looks healthy; a deliberate CERT_PIN_HASHES ` +
      `override changes client trust anchors and is a sign-off-gated change.`,
  ).toEqual([])
})

Then('the served pins include the ISRG Root X1 and X2 SPKI hashes', ({ world }) => {
  const served = (lastPinsBody(world).pins ?? []).map((p) => p.hash)
  // The two roots the chain terminates at today (Gen-Y is cross-signed by X1/X2),
  // so the list a client refreshes must always still contain them.
  for (const root of ['isrg-root-x1', 'isrg-root-x2'] as const) {
    const expected = derivePin(root)
    expect(
      served,
      `the served pins must contain ${root}'s SPKI hash ${expected} (derived from ` +
        `tests/fixtures/isrg/${root}.crt) — without it a client that adopts the list ` +
        `rejects the chain Let's Encrypt serves today. Served: ${JSON.stringify(served)}`,
    ).toContain(expected)
  }
})

Then('the pin list signature verifies under the server\'s public key', async ({ request, world }) => {
  const body = lastPinsBody(world)

  // The verifying key is the one the server publishes, not one the test
  // assumes — the same one clients pin the list to.
  const configRes = await request.get('/api/config')
  expect(configRes.status()).toBe(200)
  const config = (await configRes.json()) as { serverPubkey?: string }
  expect(
    typeof config.serverPubkey === 'string' && /^[0-9a-f]{64}$/.test(config.serverPubkey),
    `/api/config must publish the server Ed25519 pubkey for pin-list verification ` +
      `(SERVER_SECRET unset on the target?) — got: ${JSON.stringify(config)}`,
  ).toBe(true)

  expect(
    typeof body.signature === 'string' && body.signature.length > 0,
    `the pin list must carry a signature — an unsigned list is rejected by clients, ` +
      `which fall back to static pins and never see a rotation: ${JSON.stringify(body)}`,
  ).toBe(true)

  // The signed message is JSON.stringify({pins, notBefore, notAfter}) — the
  // exact object the route builds, in the same key order
  // (apps/worker/routes/config.ts).
  const message = new TextEncoder().encode(
    JSON.stringify({ pins: body.pins, notBefore: body.notBefore, notAfter: body.notAfter }),
  )
  const valid = ed25519.verify(
    hexToBytes(body.signature as string),
    message,
    hexToBytes(config.serverPubkey as string),
  )
  expect(valid, 'the pin list signature must verify under the /api/config server pubkey').toBe(true)
})

Then('the pin list validity window brackets now', ({ world }) => {
  const body = lastPinsBody(world)
  expect(typeof body.notBefore, 'notBefore must be an ISO timestamp').toBe('string')
  expect(typeof body.notAfter, 'notAfter must be an ISO timestamp').toBe('string')

  const notBefore = Date.parse(body.notBefore as string)
  const notAfter = Date.parse(body.notAfter as string)
  expect(Number.isNaN(notBefore), `notBefore must parse: ${body.notBefore}`).toBe(false)
  expect(Number.isNaN(notAfter), `notAfter must parse: ${body.notAfter}`).toBe(false)

  // Allow a little clock skew between the runner and a deployed target.
  const now = Date.now()
  const skewMs = 5 * 60 * 1000
  expect(
    notBefore <= now + skewMs,
    `notBefore (${new Date(notBefore).toISOString()}) must not be in the future`,
  ).toBe(true)
  expect(
    notAfter > now,
    `notAfter (${new Date(notAfter).toISOString()}) must be in the future — an expired pin list ` +
      `tells clients to stop trusting the pins`,
  ).toBe(true)

  const windowMs = notAfter - notBefore
  const maxWindowMs = 31 * 24 * 60 * 60 * 1000
  expect(
    windowMs <= maxWindowMs,
    `the validity window (${Math.round(windowMs / 86_400_000)}d) must not exceed ~30 days — ` +
      `a longer window defeats pin rotation`,
  ).toBe(true)
})

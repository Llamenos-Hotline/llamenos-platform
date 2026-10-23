/**
 * #1050 / M2 Stage A gate: a freshly onboarded user has a sigchain genesis
 * link, a puk_epoch link and a PUK — verified by reading them back from a
 * SECOND client, not by asserting on objects the onboarding client constructed
 * in-process.
 *
 * Flow:
 *   1. Admin creates an invite (API, admin seed).
 *   2. A browser drives the real /onboarding UI against the real backend
 *      (Playwright IPC-mock build; /api proxied to the dev server). Identity
 *      initialisation (docs/protocol/PROTOCOL.md §2.11) runs when the user
 *      presses Continue, BEFORE the session is committed.
 *   3. The page itself re-reads the chain, verifies it and opens its PUK
 *      envelope with its own CryptoState (expectInitialisedIdentity).
 *   4. Read-back: a fresh APIRequestContext authenticates as the new user
 *      (seed recovered via the test-only mock hook — the mock generates the
 *      keypair inside the page, so the hook is the only way a second client
 *      can act as the same identity) and fetches both artifacts. An admin
 *      (a different identity entirely) independently reads the sigchain.
 *
 * The GET response carries each link's timestamp, so the second client
 * verifies the whole chain (hashes + signatures) from the read-back alone.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { apiGet, apiPost, ADMIN_SEED, createHubViaApi, seedHexToPubkey } from './api-helpers'
import { enterPin, TEST_PIN } from './helpers'
import { expectInitialisedIdentity, toMockSigchainLink } from './identity-helpers'
import { verifySigchainMock } from './mocks/sigchain-mock'
import type { SigchainResponse } from '@protocol/schemas'

test.describe('onboarding provisions sigchain genesis + PUK (#1050)', () => {
  test.describe.configure({ mode: 'serial' })

  let inviteCode: string

  test.beforeAll(async ({ request }) => {
    // The suite runs fullyParallel alongside 200+ specs that create hubs, so
    // there is no "sole active hub" (and the admin has many memberships) for
    // the server to resolve an omitted hubId to — it would answer 400. Create
    // a dedicated hub and pass its id explicitly.
    const hubId = await createHubViaApi(request, `sigchain-gate-hub-${Date.now()}`)
    const { status, data } = await apiPost<{ invite?: { code: string } }>(
      request,
      '/invites',
      { name: `sigchain-gate-${Date.now()}`, phone: '+10000000000', roleIds: ['role-volunteer'], hubId },
      ADMIN_SEED,
    )
    expect(status, 'POST /api/invites').toBe(201)
    inviteCode = data.invite?.code ?? ''
    expect(inviteCode, 'invite carries no code').toBeTruthy()
  })

  test('a second client reads back the genesis link, puk_epoch link and PUK envelope', async ({ page, request }) => {
    // Everything the client POSTs to the identity routes, in order.
    const posted: string[] = []
    page.on('request', (req) => {
      if (req.method() !== 'POST') return
      const url = new URL(req.url())
      if (url.pathname.endsWith('/sigchain')) {
        posted.push(`sigchain:${(req.postDataJSON() as { linkType: string }).linkType}`)
      } else if (url.pathname.endsWith('/puk/envelopes')) {
        posted.push('puk-envelope')
      }
    })

    // ── Drive the real onboarding UI ────────────────────────────────────
    await page.goto(`/onboarding?code=${inviteCode}`)
    await page.getByTestId('onboarding-get-started').click()

    await enterPin(page, TEST_PIN) // create
    await enterPin(page, TEST_PIN) // confirm

    // Keypair generation + redeem happen before the backup step renders.
    await page.getByTestId('onboarding-download-backup').waitFor({ state: 'visible' })
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('onboarding-download-backup').click()
    await downloadPromise
    await page.getByTestId('onboarding-backup-acknowledge').check()
    // Identity initialisation runs on Continue, before the session is committed.
    await page.getByTestId('onboarding-continue').click()
    await page.waitForURL((url) => url.pathname.includes('/profile-setup'))

    // The envelope is stored before the chain claims the PUK (PROTOCOL.md §2.11).
    expect(posted, 'identity-init POST order').toEqual(['sigchain:genesis', 'puk-envelope', 'sigchain:puk_epoch'])

    // The page's own CryptoState verifies the stored chain and opens its PUK envelope.
    const identity = await expectInitialisedIdentity(page)

    // Identity material the second client will act as.
    const volunteerSeed = await page.evaluate(() => window.__TEST_LAST_DEVICE_SEED_HEX)
    expect(volunteerSeed, 'mock did not expose the generated device seed').toMatch(/^[0-9a-f]{64}$/)
    if (!volunteerSeed) throw new Error('unreachable: asserted above')
    const volunteerPubkey = seedHexToPubkey(volunteerSeed)
    expect(volunteerPubkey).toBe(identity.pubkey)

    // ── Read-back from a second client as the SAME user ─────────────────
    const asVolunteer = await readSigchain(request, `/users/${volunteerPubkey}/sigchain`, volunteerSeed)
    expect(asVolunteer.status, 'volunteer cannot read their own sigchain').toBe(200)
    expect(asVolunteer.data?.integrityBreak).toBeNull()
    const links = asVolunteer.data?.links ?? []
    expect(links.map((l) => `${l.seqNo}:${l.linkType}`)).toEqual(['1:genesis', '2:puk_epoch'])
    expect(links[0].prevHash).toBeNull()
    // The read-back carries every field of the hashed form, so the second
    // client verifies hashes and signatures itself rather than trusting the
    // onboarding client's copy.
    const verified = verifySigchainMock(links.map(toMockSigchainLink))
    expect(verified.activeDevicePubkeys).toEqual([volunteerPubkey])
    expect(verified.headHash).toBe(links[1].hash)

    // ── Read-back as a DIFFERENT identity (admin) ───────────────────────
    const asAdmin = await readSigchain(request, `/users/${volunteerPubkey}/sigchain`, ADMIN_SEED)
    expect(asAdmin.status, 'admin cannot read the new user sigchain').toBe(200)
    expect(asAdmin.data?.links.map((l) => l.hash)).toEqual(links.map((l) => l.hash))

    // ── PUK envelope: present for the onboarding device, scoped to the user ──
    // Addressed by the sigchain device id (the id the envelope's HPKE AAD binds).
    const puk = await apiGet<{ generation?: number; deviceId?: string; envelope?: { v: number } }>(
      request, `/puk/envelopes/${encodeURIComponent(identity.deviceId)}`, volunteerSeed,
    )
    expect(puk.status, `no PUK envelope for the onboarding device: ${JSON.stringify(puk.data)}`).toBe(200)
    expect(puk.data?.generation).toBe(1)
    expect(puk.data?.deviceId).toBe(identity.deviceId)
    expect(puk.data?.envelope?.v).toBe(3)

    // The envelope is keyed to the volunteer's identity — the admin's own
    // envelope lookup for the same deviceId must find nothing.
    const adminPuk = await apiGet(request, `/puk/envelopes/${encodeURIComponent(identity.deviceId)}`, ADMIN_SEED)
    expect(adminPuk.status, 'PUK envelope leaked across identities').toBe(404)
  })
})

async function readSigchain(
  request: APIRequestContext,
  path: string,
  seedHex: string,
): Promise<{ status: number; data?: SigchainResponse }> {
  return apiGet(request, path, seedHex)
}

/**
 * #1050 / M2 Stage A gate: a freshly onboarded user has a sigchain genesis
 * link and a PUK — verified by reading them back from a SECOND client, not by
 * asserting on objects the onboarding client constructed in-process.
 *
 * Flow:
 *   1. Admin creates an invite (API, admin seed).
 *   2. A browser drives the real /onboarding UI against the real backend
 *      (Playwright IPC-mock build; /api proxied to the dev server). The
 *      client POSTs the genesis link and PUK envelope from inside the flow.
 *   3. Read-back: a fresh APIRequestContext authenticates as the new user
 *      (seed recovered via the test-only mock hook — the mock generates the
 *      keypair inside the page, so the hook is the only way a second client
 *      can act as the same identity) and fetches both artifacts. An admin
 *      (a different identity entirely) independently reads the sigchain.
 *
 * Signature/hash soundness of the link is checked against the exact bytes the
 * client POSTed (captured off the wire), which the server re-validated on
 * append — the GET response does not carry the link timestamp, so the entry
 * hash is not recomputable from the read-back alone (protocol gap, reported
 * in the PR).
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { apiGet, apiPost, ADMIN_SEED, createHubViaApi, seedHexToPubkey } from './api-helpers'
import { enterPin, TEST_PIN } from './helpers'

interface SigchainLinkWire {
  seqNo: number
  linkType: string
  payload: Record<string, unknown>
  signature: string
  prevHash: string | null
  hash: string
  signerDeviceId: string
  signerPubkey: string
  timestamp: string
}

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

  test('a second client reads back the genesis link and PUK envelope', async ({ page, request }) => {
    // Capture the exact sigchain link the client POSTs, so its signature can
    // be verified against the bytes that were actually signed.
    let postedLink: SigchainLinkWire | null = null
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/sigchain')) {
        postedLink = req.postDataJSON() as SigchainLinkWire
      }
    })

    // ── Drive the real onboarding UI ────────────────────────────────────
    await page.goto(`/onboarding?code=${inviteCode}`)
    await page.getByTestId('onboarding-get-started').click()

    await enterPin(page, TEST_PIN) // create
    await enterPin(page, TEST_PIN) // confirm

    // Keypair generation + redeem + genesis/PUK POSTs all happen before the
    // backup step renders.
    await page.getByTestId('onboarding-download-backup').waitFor({ state: 'visible' })
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('onboarding-download-backup').click()
    await downloadPromise
    await page.getByTestId('onboarding-backup-acknowledge').check()
    await page.getByTestId('onboarding-continue').click()
    await page.waitForURL((url) => url.pathname.includes('/profile-setup'))

    // Identity material the second client will act as.
    const volunteerSeed = await page.evaluate(() => window.__TEST_LAST_DEVICE_SEED_HEX)
    expect(volunteerSeed, 'mock did not expose the generated device seed').toMatch(/^[0-9a-f]{64}$/)
    const deviceState = await page.evaluate(async () => {
      const platform = window.__TEST_PLATFORM
      if (!platform) throw new Error('__TEST_PLATFORM not available')
      return platform.getDevicePubkeys()
    })
    expect(deviceState, 'device pubkeys unavailable after onboarding').not.toBeNull()
    if (!volunteerSeed || !deviceState) throw new Error('unreachable: asserted above')
    const volunteerPubkey = seedHexToPubkey(volunteerSeed)
    const deviceId = deviceState.deviceId

    // ── The client must have POSTed a well-formed, correctly-signed link ──
    expect(postedLink, 'onboarding never POSTed a sigchain link').not.toBeNull()
    const link = postedLink as unknown as SigchainLinkWire
    expect(link.seqNo).toBe(1)
    expect(link.linkType).toBe('genesis')
    expect(link.prevHash).toBeNull()
    expect(link.signerDeviceId).toBe(deviceId)
    expect(link.signerPubkey).toBe(volunteerPubkey)
    expect(link.payload).toMatchObject({ type: 'user_init', deviceId })
    const sigValid = ed25519.verify(
      hexToBytes(link.signature),
      hexToBytes(link.hash),
      hexToBytes(volunteerPubkey),
    )
    expect(sigValid, 'genesis link signature does not verify against the new user pubkey').toBe(true)

    // ── Read-back from a second client as the SAME user ─────────────────
    const asVolunteer = await readSigchain(request, `/users/${volunteerPubkey}/sigchain`, volunteerSeed)
    expect(asVolunteer.status, 'volunteer cannot read their own sigchain').toBe(200)
    expect(asVolunteer.data?.integrityBreak).toBeNull()
    expect(asVolunteer.data?.links.length, 'sigchain has no genesis link after onboarding').toBe(1)
    const readBack = asVolunteer.data?.links[0]
    if (!readBack) throw new Error('links empty despite length assertion')
    expect(readBack.linkType).toBe('genesis')
    expect(readBack.seqNo).toBe(1)
    expect(readBack.prevHash).toBeNull()
    expect(readBack.hash, 'read-back hash differs from the posted link').toBe(link.hash)
    expect(readBack.signerPubkey).toBe(volunteerPubkey)
    expect(readBack.payload).toMatchObject({ type: 'user_init', deviceId })

    // ── Read-back as a DIFFERENT identity (admin) ───────────────────────
    const asAdmin = await readSigchain(request, `/users/${volunteerPubkey}/sigchain`, ADMIN_SEED)
    expect(asAdmin.status, 'admin cannot read the new user sigchain').toBe(200)
    expect(asAdmin.data?.links.map((l) => l.hash)).toEqual([link.hash])

    // ── PUK envelope: present for the onboarding device, scoped to the user ──
    // The envelope row is keyed by the server device-registry id (assigned by
    // POST /devices/register during onboarding), not the CryptoState device id.
    const myDevices = await apiGet<{ devices?: Array<{ id: string; ed25519Pubkey?: string | null }> }>(
      request, '/devices', volunteerSeed,
    )
    expect(myDevices.status, 'volunteer cannot list their own devices').toBe(200)
    const serverDevice = myDevices.data?.devices?.find(
      (d) => d.ed25519Pubkey === deviceState.signingPubkeyHex,
    )
    expect(serverDevice, 'onboarding never registered the device server-side').toBeTruthy()
    if (!serverDevice) throw new Error('unreachable: asserted above')
    const serverDeviceId = serverDevice.id

    const puk = await apiGet<{ generation?: number; envelope?: string; deviceId?: string }>(
      request, `/puk/envelopes/${serverDeviceId}`, volunteerSeed,
    )
    expect(puk.status, `no PUK envelope for the onboarding device: ${JSON.stringify(puk.data)}`).toBe(200)
    expect(puk.data?.generation).toBe(1)
    expect(puk.data?.deviceId).toBe(serverDeviceId)
    expect(puk.data?.envelope, 'PUK envelope is not base64url(kem||ct)').toMatch(/^[A-Za-z0-9_-]+$/)

    // The envelope is keyed to the volunteer's identity — the admin's own
    // envelope lookup for the same deviceId must find nothing.
    const adminPuk = await apiGet(request, `/puk/envelopes/${serverDeviceId}`, ADMIN_SEED)
    expect(adminPuk.status, 'PUK envelope leaked across identities').toBe(404)
  })
})

async function readSigchain(
  request: APIRequestContext,
  path: string,
  seedHex: string,
): Promise<{ status: number; data?: { links: Array<SigchainLinkWire & { id: string }>; integrityBreak: unknown } }> {
  return apiGet(request, path, seedHex)
}

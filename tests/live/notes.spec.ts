/**
 * R1, second half: "... answers it, and writes a note. An admin sees the call
 * in history." (#1456)
 *
 * The note half of that sentence is an END-TO-END CRYPTO claim, not a CRUD
 * claim. Notes are envelope-encrypted client-side: a random content key, HPKE
 * -wrapped once for the author and once for each admin. So "an admin sees the
 * note" is only true if the admin can DECRYPT it, and a test that asserts the
 * admin's `GET /notes` returns a row proves nothing — the server returns
 * ciphertext to anyone with `notes:read-all`, readable or not.
 *
 * Every step here therefore goes through the deployment's own key discovery:
 * the volunteer asks `GET /api/auth/me` which admin key to wrap for (exactly
 * as `note-sheet.tsx` does via `useAuth().adminDecryptionPubkey`), seals to
 * that answer, and the admin opens it with the X25519 key its seed derives.
 * If the deployment publishes a key the admin holds no secret for, that fails
 * here — which is the point, because nothing else in the system notices:
 * `decryptNote` (src/client/lib/platform.ts) catches and returns null, so the
 * UI shows an unreadable note and no error.
 *
 * Non-destructive: one note per run, against a synthetic `callId` carrying an
 * `r1-live-...` marker so it is filterable and obviously a check rather than
 * a real call's record. Nothing is deleted or reset.
 *
 * Run: `bun run test:live -- notes`
 *   LIVE_BASE_URL       the deployment to check
 *   STAGING_ADMIN_SEED  the operator identity (required)
 */
import { test, expect } from '@playwright/test'
import { apiGet, apiPost, seedHexToPubkey } from '../api-helpers'
import {
  requireAdminSeed,
  resolveHubId,
  liveMarker,
  freshIdentity,
  redeemInvite,
  retireLiveIdentity,
  deviceEncryptionKeypair,
  sealNote,
  openNote,
  pacedStrict,
  present,
} from './helpers'

interface Me { pubkey: string; adminDecryptionPubkey?: string; permissions?: string[] }
interface Note {
  id: string
  callId?: string
  authorPubkey: string
  encryptedContent: string
  authorEnvelope?: { enc: string; ct: string }
  adminEnvelopes?: Array<{ pubkey: string; enc: string; ct: string }>
}

const adminSeed = process.env.STAGING_ADMIN_SEED

test.describe('R1 — the admin key a volunteer is told to encrypt to', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required')

  /**
   * The read-only form of the end-to-end check below, and the one that names
   * the cause.
   *
   * `GET /api/auth/me` answers `ADMIN_DECRYPTION_PUBKEY || ADMIN_PUBKEY`
   * (apps/worker/routes/auth.ts). Those are different kinds of key:
   * ADMIN_PUBKEY is the admin's Ed25519 *identity*, ADMIN_DECRYPTION_PUBKEY
   * the X25519 *HPKE recipient* that `bun run bootstrap-admin` derives
   * alongside it. A volunteer's client wraps the note key for whichever one it
   * is handed, unchanged — `resolveEncryptionPubkey` only maps the caller's
   * OWN signing key to its own encryption key, never somebody else's — so when
   * the fallback fires, every volunteer note is sealed to a point no X25519
   * secret corresponds to, and no admin can ever open it.
   *
   * The fallback is the shipped default: `admin_decryption_pubkey: ""` in
   * deploy/ansible/vars.yml and vars-production.example.yml, and the template
   * omits the line entirely when it is empty. So this is what an unmodified
   * install does, not a misconfiguration an operator would expect to have
   * caused.
   */
  test('is the X25519 encryption key, not the Ed25519 identity', async ({ request }) => {
    const seed = requireAdminSeed()
    // `/api/auth/*` shares the strict tier's 5/minute budget with
    // `/api/invites/*`, so even a single read is paced.
    const { status, data } = await pacedStrict(
      'GET /api/auth/me', () => apiGet<Me>(request, '/auth/me', seed),
    )
    expect(status, 'GET /api/auth/me').toBe(200)

    const published = data.adminDecryptionPubkey
    expect(published, '/auth/me published no admin decryption key at all').toBeTruthy()

    const identity = seedHexToPubkey(seed)
    const encryption = deviceEncryptionKeypair(seed).pubkeyHex

    expect(
      published,
      'the deployment hands volunteers the admin\'s Ed25519 IDENTITY key as an HPKE '
      + 'recipient. Notes wrapped for it are undecryptable by anyone, silently — set '
      + 'ADMIN_DECRYPTION_PUBKEY to the X25519 key `bun run bootstrap-admin` prints '
      + '(admin_decryption_pubkey in the Ansible vars, empty by default)',
    ).not.toBe(identity)

    expect(
      published,
      'the published admin decryption key is not the X25519 key this admin seed '
      + 'derives, so the admin cannot open notes wrapped for it',
    ).toBe(encryption)
  })
})

test.describe('R1 — a volunteer writes a note and the admin reads it', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required: this suite writes a note as a volunteer')
  // The strict rate-limit tier is 5 requests/minute across /invites and
  // /auth, so `pacedStrict` may sleep out a window mid-run.
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  const marker = liveMarker('note')
  /** Synthetic: a live run must not depend on a real caller having phoned in. */
  const callId = `r1-live-call-${marker}`
  const plaintext = JSON.stringify({ text: `R1 live acceptance check ${marker} — safe to delete` })
  const volunteer = freshIdentity()

  let seed: string
  let hubId: string
  let adminIdentity: string
  /** Whatever the deployment tells volunteers to wrap for — right or wrong. */
  let publishedAdminKey: string
  let noteId: string

  test.beforeAll(() => { seed = requireAdminSeed() })
  test.afterAll(async ({ request }) => {
    if (seed) await retireLiveIdentity(request, seed, volunteer.pubkey)
  })

  test('a volunteer is onboarded who can create notes', async ({ request }) => {
    hubId = await resolveHubId(request)
    adminIdentity = seedHexToPubkey(seed)

    const invite = await pacedStrict('POST /api/invites', () =>
      apiPost<{ invite?: { code: string } }>(request, '/invites', {
        name: marker, phone: '+10000000000', roleIds: ['role-volunteer'],
      }, seed))
    expect(invite.status, 'POST /api/invites').toBe(201)

    const code = present(invite.data.invite, 'the created invite').code
    const { status, body } = await redeemInvite(request, code, volunteer.seedHex)
    expect(status, `POST /api/invites/redeem: ${JSON.stringify(body)}`).toBe(200)

    // The volunteer's own view of what they may do, and of which admin key to
    // seal to. Both come from the deployment, not from this test.
    const me = await pacedStrict(
      'GET /api/auth/me as the volunteer',
      () => apiGet<Me>(request, '/auth/me', volunteer.seedHex),
    )
    expect(me.status, 'the new volunteer cannot authenticate').toBe(200)
    expect(me.data.pubkey).toBe(volunteer.pubkey)
    expect(
      me.data.permissions ?? [],
      'the invited volunteer cannot create notes — nothing after this can run',
    ).toContain('notes:create')
    publishedAdminKey = me.data.adminDecryptionPubkey ?? ''
    expect(publishedAdminKey, 'the deployment told the volunteer no admin key to encrypt to').toBeTruthy()
  })

  test('the note the volunteer writes reaches the server encrypted', async ({ request }) => {
    const sealed = await sealNote(plaintext, volunteer.seedHex, [
      { identity: adminIdentity, encryption: publishedAdminKey },
    ])

    const { status, data } = await apiPost<{ note?: Note }>(request, `/hubs/${hubId}/notes`, {
      callId,
      encryptedContent: sealed.encryptedContent,
      authorEnvelope: sealed.authorEnvelope,
      adminEnvelopes: sealed.adminEnvelopes,
    }, volunteer.seedHex)
    expect(status, 'POST /api/hubs/:id/notes as a volunteer').toBe(201)
    const created = present(data.note, 'the created note')
    noteId = created.id

    // Zero-knowledge, asserted rather than assumed. Searched in the DECODED
    // bytes, not the hex string: `encryptedContent` is hex, so a client that
    // hex-encoded its plaintext and sent that would pass a search of the hex
    // text itself while handing the server everything.
    const stored = created.encryptedContent
    const decoded = Buffer.from(stored, 'hex').toString('latin1')
    expect(
      stored.includes(marker) || decoded.includes(marker),
      'the note content reached the server in the clear',
    ).toBe(false)
    expect(created.authorPubkey, 'the note was attributed to someone else').toBe(volunteer.pubkey)

    // Delta by callId, so no clean slate is needed and no note from a previous
    // run can satisfy it: exactly one note exists for a callId minted here.
    const mine = await apiGet<{ notes?: Note[]; total?: number }>(
      request, `/hubs/${hubId}/notes?callId=${callId}`, volunteer.seedHex,
    )
    expect(mine.status).toBe(200)
    expect(mine.data.total, 'the volunteer does not see the note they just wrote').toBe(1)
    expect(present(mine.data.notes, 'the volunteer\'s note list')[0].id).toBe(noteId)
  })

  test('the volunteer can still read their own note back', async ({ request }) => {
    // The author envelope is what a volunteer re-reading their shift's notes
    // after re-login depends on. If the server drops or rewrites it, the note
    // is lost to its own author — and the UI would show it as unreadable
    // rather than erroring.
    const { data } = await apiGet<{ notes?: Note[] }>(
      request, `/hubs/${hubId}/notes?callId=${callId}`, volunteer.seedHex,
    )
    const note = present(data.notes, 'the note list')[0]
    // Both halves, by name: `authorEnvelope: {}` is truthy and would pass a
    // bare existence check while being useless.
    expect(note.authorEnvelope?.enc, 'the stored author envelope has no `enc`').toBeTruthy()
    expect(note.authorEnvelope?.ct, 'the stored author envelope has no `ct`').toBeTruthy()

    const author = deviceEncryptionKeypair(volunteer.seedHex)
    const recovered = await openNote(note.encryptedContent, present(note.authorEnvelope, 'the author envelope'), author.skHex)
      .catch((err: unknown) => `could not decrypt: ${err instanceof Error ? err.message : String(err)}`)
    expect(recovered, 'the author cannot decrypt their own note').toBe(plaintext)
  })

  test('an unauthenticated reader gets nothing', async ({ request }) => {
    const path = `/api/hubs/${hubId}/notes?callId=${callId}`

    const anon = await request.get(path, { failOnStatusCode: false })
    expect(anon.status(), 'notes must require authentication').toBe(401)

    // Both halves, because the authenticated router answers 401 for anything
    // it does not have a route for. Without this second call, a 401 would be
    // indistinguishable from the path not existing at all, and the assertion
    // above would pass against a typo'd URL.
    const authed = await apiGet(request, `/hubs/${hubId}/notes?callId=${callId}`, seed)
    expect(
      authed.status,
      'the same path with credentials must not also be 401 — otherwise the 401 above '
      + 'only means "no such route"',
    ).toBe(200)
  })

  test('the admin can read and decrypt the volunteer\'s note', async ({ request }) => {
    // The R1 sentence's last clause, in the only form that means anything.
    const { status, data } = await apiGet<{ notes?: Note[]; total?: number }>(
      request, `/hubs/${hubId}/notes?callId=${callId}`, seed,
    )
    expect(status, 'GET /api/hubs/:id/notes as the admin').toBe(200)
    expect(data.total, 'the admin cannot see the volunteer\'s note at all').toBe(1)

    const note = present(data.notes, 'the note list')[0]
    expect(note.id).toBe(noteId)
    // It must be somebody ELSE'S note — an admin reading their own note only
    // exercises notes:read-own and proves nothing about admin oversight.
    expect(note.authorPubkey, 'this is not the volunteer\'s note').toBe(volunteer.pubkey)

    const envelope = (note.adminEnvelopes ?? []).find(e => e.pubkey === adminIdentity)
    expect(
      envelope,
      `the note carries no envelope addressed to the admin (${adminIdentity}); `
      + `envelopes present: ${JSON.stringify((note.adminEnvelopes ?? []).map(e => e.pubkey))}`,
    ).toBeDefined()

    const admin = deviceEncryptionKeypair(seed)
    // HPKE open throws rather than returning a value, and an unexplained
    // OpenError is the wrong thing to hand an operator — the cause is almost
    // always the published admin key, so say so.
    const recovered = await openNote(note.encryptedContent, present(envelope, 'the admin envelope'), admin.skHex)
      .catch((err: unknown) => `could not decrypt: ${err instanceof Error ? err.message : String(err)}`)
    expect(
      recovered,
      'the admin cannot decrypt a note a volunteer wrote. The note was sealed to the '
      + 'key /api/auth/me published as adminDecryptionPubkey; if that is ADMIN_PUBKEY '
      + '(the Ed25519 identity) rather than ADMIN_DECRYPTION_PUBKEY (the X25519 HPKE '
      + 'recipient), no admin can ever open it — see the config check in this file',
    ).toBe(plaintext)
  })
})

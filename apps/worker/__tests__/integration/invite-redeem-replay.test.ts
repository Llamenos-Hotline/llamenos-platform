/**
 * Invite redemption replay protection — real invites router + real
 * IdentityService + real PostgreSQL + real Ed25519 verification.
 *
 * Regression for #1367. `POST /api/invites/redeem` verified the signed auth
 * token but never marked it used, and its body had no `nonce`, so:
 *
 *  - a signed redemption stayed valid for the whole TOKEN_MAX_AGE_MS window.
 *    The signed message does not cover the invite code, so a token captured
 *    from a redemption the server refused (unknown, expired or revoked code)
 *    could be replayed onto a different, valid invite and bind that invite to
 *    the signer's key;
 *  - the desktop client's Rust `create_auth_token` always signs a nonce, which
 *    the route dropped, so a nonce-signed redemption could never verify.
 *
 * Only the rate limiter is stubbed. Invite, user, auth-nonce and audit rows are
 * real: a successful redemption is audited as the redeemer's own act (#1231),
 * so a replay that got past authentication would also leave a second entry.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * gets its own database, created with the real migrations (freshHubDb) and
 * dropped on teardown. The tables are deliberately NOT hand-written here: a
 * hand-mirrored `audit_log` went stale the moment #1175 added `seq`, and nothing
 * but a failing audit() call said so.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AppEnv } from '@worker/types'
import * as schema from '../../db/schema'
import { ServiceError } from '../../services/settings'
import { buildAuthMessage } from '../../lib/auth'
import { freshHubDb } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const fresh = freshHubDb('invite_redeem')

const REDEEM_PATH = '/api/invites/redeem'

async function makeApp() {
  const services = {
    identity: fresh.identity,
    audit: fresh.audit,
    settings: { checkRateLimit: vi.fn().mockResolvedValue({ limited: false }) },
  }
  const { default: invites } = await import('@worker/routes/invites')
  const app = new Hono<AppEnv>()
  // Same mapping as the global handler in apps/worker/app.ts.
  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 409)
    }
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = { ENVIRONMENT: 'test', HMAC_SECRET: 'a'.repeat(64) } as AppEnv['Bindings']
    await next()
  })
  app.route('/api/invites', invites)
  return app
}

type App = Awaited<ReturnType<typeof makeApp>>

interface Device {
  pubkey: string
  seed: Uint8Array
}

function newDevice(): Device {
  const seed = ed25519.utils.randomSecretKey()
  return { seed, pubkey: bytesToHex(ed25519.getPublicKey(seed)) }
}

/**
 * Sign a redemption exactly as a client does. With `nonce: true` this matches
 * the desktop Rust `create_auth_token` (random 16-byte hex nonce, always signed);
 * without, the nonce-less form older clients sign.
 */
function signRedemption(device: Device, opts: { nonce: boolean }) {
  const timestamp = Date.now()
  const nonce = opts.nonce ? bytesToHex(crypto.getRandomValues(new Uint8Array(16))) : undefined
  const message = buildAuthMessage(device.pubkey, timestamp, 'POST', REDEEM_PATH, nonce)
  const token = bytesToHex(ed25519.sign(message, device.seed))
  return { pubkey: device.pubkey, timestamp, token, ...(nonce ? { nonce } : {}) }
}

function redeem(app: App, body: Record<string, unknown>) {
  return app.request(REDEEM_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedInvite(): Promise<string> {
  const code = crypto.randomUUID()
  // An invite names the hub it admits into: with no hub to grant, redemption is
  // refused rather than falling back to a global role (#2153). Replay protection
  // is about the credential, so the invite is a well-formed one.
  await fresh.db
    .insert(schema.hubs)
    .values({ id: 'hub-replay', name: 'Replay hub', slug: 'hub-replay', createdBy: 'admin' })
    .onConflictDoNothing()
  await fresh.db.insert(schema.inviteCodes).values({
    code,
    name: 'Invitee',
    phone: '',
    roleIds: ['role-volunteer'],
    hubId: 'hub-replay',
    createdBy: 'admin',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return code
}

const inviteRow = async (code: string) =>
  (await fresh.raw`SELECT used_by FROM invite_codes WHERE code = ${code}`)[0] as { used_by: string | null }
/** Join entries for a redeemer: the act is theirs, in the invite's hub. */
const joinEntries = async (pubkey: string) =>
  (await fresh.raw`
    SELECT hub_id FROM audit_log WHERE action = 'userAdded' AND actor_pubkey = ${pubkey}
  `) as unknown as { hub_id: string | null }[]
const userCount = async (pubkey: string) =>
  Number((await fresh.raw`SELECT count(*)::int AS n FROM users WHERE pubkey = ${pubkey}`)[0].n)

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

// Per-test state: users, invites, nonces and audit entries. The hub is seeded
// idempotently by seedInvite, and the role catalog (no FK to these) survives.
beforeEach(async () => {
  await fresh.raw`TRUNCATE TABLE users, invite_codes, auth_nonces, audit_log CASCADE`
})

describe('POST /api/invites/redeem — replay protection (#1367)', () => {
  it('redeems with a nonce-signed token, as the desktop client signs it', async () => {
    const app = await makeApp()
    const device = newDevice()
    const code = await seedInvite()

    const res = await redeem(app, { code, ...signRedemption(device, { nonce: true }) })

    expect(res.status).toBe(200)
    expect((await inviteRow(code)).used_by).toBe(device.pubkey)
    expect(await userCount(device.pubkey)).toBe(1)
    expect(await joinEntries(device.pubkey)).toEqual([{ hub_id: 'hub-replay' }])
  })

  it('rejects a token whose nonce was altered after signing', async () => {
    const app = await makeApp()
    const code = await seedInvite()
    const signed = signRedemption(newDevice(), { nonce: true })

    const res = await redeem(app, { code, ...signed, nonce: 'f'.repeat(32) })

    expect(res.status).toBe(401)
    expect((await inviteRow(code)).used_by).toBeNull()
  })

  for (const nonce of [false, true]) {
    const form = nonce ? 'nonce-signed' : 'nonce-less'

    it(`rejects a replay of a successful ${form} redemption at authentication`, async () => {
      const app = await makeApp()
      const device = newDevice()
      const code = await seedInvite()
      const body = { code, ...signRedemption(device, { nonce }) }

      expect((await redeem(app, body)).status).toBe(200)

      const replay = await redeem(app, body)
      // 401 from the auth check — not the 400 "already-used" the invite service
      // returns, which would mean the replayed signature was accepted.
      expect(replay.status).toBe(401)
      expect(await replay.json()).toEqual({ error: 'Authentication failed' })
      expect(await userCount(device.pubkey)).toBe(1)
      expect(await joinEntries(device.pubkey), 'a replay was audited as a second join').toHaveLength(1)
    })

    it(`a ${form} token refused by the invite service cannot be replayed onto another invite`, async () => {
      const app = await makeApp()
      const device = newDevice()
      const signed = signRedemption(device, { nonce })

      // First use: a code the server does not know. Signature verifies, the
      // invite service refuses it.
      const first = await redeem(app, { code: crypto.randomUUID(), ...signed })
      expect(first.status).toBe(400)

      // Replay the same signed token against a valid invite.
      const target = await seedInvite()
      const replay = await redeem(app, { code: target, ...signed })

      expect(replay.status).toBe(401)
      expect((await inviteRow(target)).used_by).toBeNull()
      expect(await userCount(device.pubkey)).toBe(0)
      expect(await joinEntries(device.pubkey)).toHaveLength(0)
    })
  }
})

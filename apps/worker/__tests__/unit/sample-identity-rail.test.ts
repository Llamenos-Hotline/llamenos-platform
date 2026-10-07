/**
 * Rail: nothing can create, register or reveal a sample identity unless this
 * host may serve the `/api/test-*` surface at all, `ENVIRONMENT=production`
 * never can, and the sample signing seeds this repository once published never
 * come back.
 *
 * ## What #1604 changed here, and what it did not
 *
 * This file used to assert that the seeds were mintable ONLY on
 * `ENVIRONMENT=development` — a second predicate (`demoSurfacesEnabled`)
 * narrower than `devSurfacesEnabled`, which the staging allowlist had widened
 * for the end-to-end suite. The reason was not the seeds themselves: it was
 * that the same seeds were handed to an UNAUTHENTICATED login picker,
 * `GET /api/config/demo/credentials`, so widening the predicate would have
 * published a super-admin seed on a reachable host.
 *
 * #1604 deleted that picker, and `POST /api/demo/reset`, with the rest of demo
 * mode. What remains is a secret-gated `/test-*` route handing out seeds for a
 * fictional cast on a host that already serves `POST /api/test-reset` behind
 * the same credential — strictly less authority than that caller holds already.
 * So the narrow predicate is gone and the surviving rail is the one asserted
 * below. It is deliberately NOT weaker where it matters: production is still
 * refused with every flag and a strong secret set, and the matrix still runs
 * every row of it.
 *
 * Every row of the matrix is a configuration someone could give the shipped
 * image — the same image CI tests under ENVIRONMENT=development +
 * DEV_ROUTES_ENABLED=true.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { Services } from '@worker/services'
import { sampleIdentities, SampleIdentitiesUnavailableError } from '@worker/lib/sample-identities'
import { devSurfacesEnabled, MIN_DEPLOYED_SECRET_LENGTH } from '@worker/lib/dev-surfaces'
import { seedSampleDataset } from '@worker/services/sample-seeder'
import { isRevokedSigningKey, revokedSigningKeys } from '@worker/lib/revoked-signing-keys'
import { authenticateRequest, validateToken } from '@worker/lib/auth'
import { IdentityService } from '@worker/services/identity'
import { ErasureService } from '@worker/services/erasure'
import { SAMPLE_ACCOUNTS } from '@worker/lib/sample-dataset'
import { bytesToHex, hexToBytes } from '@shared/encoding'
import { trackedFiles } from '../../../../tests/orchestrator/codeowners'

// Lets a test stand in for someone holding a published seed: any signature verifies.
const signatures = vi.hoisted(() => ({ acceptAll: false }))
vi.mock('@llamenos/crypto/ffi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@llamenos/crypto/ffi')>()
  return {
    ...actual,
    ed25519Verify: (...args: Parameters<typeof actual.ed25519Verify>) => signatures.acceptAll || actual.ed25519Verify(...args),
  }
})

/**
 * Long enough to satisfy the deployed-target opt-in in lib/dev-surfaces.ts.
 * Load-bearing as its own axis: `ENVIRONMENT=staging` +
 * `DEV_ROUTES_ENABLED=true` WITHOUT it leaves `devSurfacesEnabled` false, so a
 * matrix that omitted it would never exercise the one configuration the
 * staging allowlist opens. Every row below runs with the secret present and
 * absent.
 */
const STRONG_SECRET = 'e'.repeat(MIN_DEPLOYED_SECRET_LENGTH)
const RESET_SECRETS = [undefined, STRONG_SECRET]

const DEV_SERVER = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' }

const ENVIRONMENTS = ['production', 'demo', 'test', '', undefined, 'Development', 'development ', 'Staging', 'staging ']
const DEV_ROUTES = ['true', undefined, 'TRUE', '1']

/**
 * Every combination in which `devSurfacesEnabled` is FALSE — derived from the
 * predicate rather than hand-listed, so a row cannot drift into the wrong set
 * when the predicate changes. `production` with the flag and a strong secret is
 * in here, which is the row that matters most.
 */
const CLOSED: Array<Record<string, string | undefined>> = ENVIRONMENTS
  .flatMap(ENVIRONMENT => DEV_ROUTES.flatMap(DEV_ROUTES_ENABLED =>
    RESET_SECRETS.map(DEV_RESET_SECRET => ({ ENVIRONMENT, DEV_ROUTES_ENABLED, DEV_RESET_SECRET }))))
  .concat(RESET_SECRETS.flatMap(DEV_RESET_SECRET => [
    { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: undefined, DEV_RESET_SECRET },
    { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: undefined, DEV_RESET_SECRET },
    // staging with the flag but no (or a too-short) secret
    { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: undefined },
    { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'e'.repeat(MIN_DEPLOYED_SECRET_LENGTH - 1) },
  ]))
  .filter(env => !devSurfacesEnabled(env))

const label = (env: Record<string, string | undefined>) =>
  `ENVIRONMENT=${JSON.stringify(env.ENVIRONMENT)} DEV_ROUTES_ENABLED=${JSON.stringify(env.DEV_ROUTES_ENABLED)} ` +
  `DEV_RESET_SECRET=${env.DEV_RESET_SECRET ? `(${env.DEV_RESET_SECRET.length} chars)` : '(unset)'}`

/** Services that record every property touched — a refused call must touch none. */
function untouchableServices() {
  const touched: string[] = []
  const services = new Proxy({}, {
    get(_target, prop) {
      touched.push(String(prop))
      return new Proxy(() => undefined, { get: (_t, p) => { touched.push(`${String(prop)}.${String(p)}`); return vi.fn() } })
    },
  }) as unknown as Services
  return { services, touched }
}

describe('sample identities where the /api/test-* surface is closed', () => {
  it('covers every closed row the matrix can produce, production included', () => {
    expect(CLOSED.length).toBeGreaterThan(50)
    expect(
      CLOSED.some(e => e.ENVIRONMENT === 'production' && e.DEV_ROUTES_ENABLED === 'true' && e.DEV_RESET_SECRET === STRONG_SECRET),
      'the production row with every other factor satisfied is the one this rail exists for',
    ).toBe(true)
  })

  it.each(CLOSED.map(env => [label(env), env]))('%s: cannot be generated', (_label, env) => {
    expect(() => sampleIdentities(env)).toThrow(SampleIdentitiesUnavailableError)
  })

  it.each(CLOSED.map(env => [label(env), env]))('%s: the seeder refuses before touching any service', async (_label, env) => {
    const seeded = untouchableServices()
    await expect(seedSampleDataset(seeded.services, { ...env, ENVIRONMENT: env.ENVIRONMENT ?? '', HMAC_SECRET: 'x' }))
      .rejects.toThrow(SampleIdentitiesUnavailableError)
    expect(seeded.touched).toEqual([])
  })
})

/**
 * The configuration #1604 opened: `ENVIRONMENT=staging` +
 * `DEV_ROUTES_ENABLED=true` + a strong `DEV_RESET_SECRET`. This is asserted
 * POSITIVELY and on purpose — it is the change, and the seven deployed-target
 * end-to-end scenarios that could not seed their fixture are what it is for
 * (#1625). A test that only said "no" here would pass just as well if the
 * removal had never happened.
 */
describe('a fully opted-in staging end-to-end target', () => {
  const STAGING_E2E = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: STRONG_SECRET }

  it('may mint the sample cast, because its /api/test-* surface is open', () => {
    expect(devSurfacesEnabled(STAGING_E2E)).toBe(true)
    const identities = sampleIdentities(STAGING_E2E)
    expect(identities.map(i => i.name)).toEqual(SAMPLE_ACCOUNTS.map(a => a.name))
  })

  it('still refuses them on production with the same flag and secret', () => {
    const PROD = { ...STAGING_E2E, ENVIRONMENT: 'production' }
    expect(devSurfacesEnabled(PROD)).toBe(false)
    expect(() => sampleIdentities(PROD)).toThrow(SampleIdentitiesUnavailableError)
  })
})

describe('sample identities on a development server (the control)', () => {
  it('are generated in-process, one per sample account, and are none of the revoked keys', () => {
    const identities = sampleIdentities(DEV_SERVER)
    expect(identities.map(i => i.name)).toEqual(SAMPLE_ACCOUNTS.map(a => a.name))
    for (const identity of identities) {
      expect(bytesToHex(ed25519.getPublicKey(hexToBytes(identity.seedHex)))).toBe(identity.pubkey)
      expect(isRevokedSigningKey(identity.pubkey)).toBe(false)
    }
  })

  it('are the same objects on a second call — one set per process, never regenerated', () => {
    expect(sampleIdentities(DEV_SERVER)).toBe(sampleIdentities(DEV_SERVER))
  })
})

/**
 * Every 32-byte value on a line that could be a seed, as lowercase hex: hex runs
 * in 64-character chunks (so a seed‖pubkey secret key is caught too) and
 * base64 / base64url tokens that decode to 32 bytes.
 */
function candidateSeeds(line: string): string[] {
  const seeds: string[] = []
  for (const [run] of line.matchAll(/(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g)) {
    for (let at = 0; at + 64 <= run.length; at += 64) seeds.push(run.slice(at, at + 64).toLowerCase())
    if (run.length % 64 !== 0) seeds.push(run.slice(-64).toLowerCase())
  }
  for (const [token] of line.matchAll(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{43}=?(?![A-Za-z0-9+/_=-])/g)) {
    const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (bytes.length === 32) seeds.push(bytes.toString('hex'))
  }
  return seeds
}

describe('the signing keys whose seeds this repository published', () => {
  const revoked = [...revokedSigningKeys()]

  it('are five, one per sample account that ever shipped seeds', () => {
    expect(revoked).toHaveLength(SAMPLE_ACCOUNTS.length)
    for (const key of revoked) expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each(revoked)('%s cannot present a signed token', (pubkey) => {
    expect(validateToken({ pubkey, timestamp: Date.now(), token: 'ab'.repeat(64) })).toBe(false)
    expect(validateToken({ pubkey: pubkey.toUpperCase(), timestamp: Date.now(), token: 'ab'.repeat(64) })).toBe(false)
  })

  it.each(revoked)('%s cannot ride an existing session', async (pubkey) => {
    const getUserInternal = vi.fn().mockResolvedValue({ pubkey, active: true, roles: ['role-super-admin'] })
    const identity = {
      validateSession: vi.fn().mockResolvedValue({ pubkey }),
      getUserInternal,
    } as unknown as IdentityService
    const request = new Request('http://rail/api/auth/me', { headers: { Authorization: 'Session rail-token' } })
    expect(await authenticateRequest(request, identity)).toBeNull()
    expect(getUserInternal).not.toHaveBeenCalled()
  })

  describe('resolve to no user, even where the database still holds a super-admin row for them', () => {
    const adminRow = (pubkey: string) => ({
      pubkey, displayName: 'Row', phone: '', roles: ['role-super-admin'], hubRoles: [], active: true,
      createdAt: new Date(), updatedAt: new Date(), encryptedSecretKey: '', transcriptionEnabled: true,
      spokenLanguages: ['en'], uiLanguage: 'en', profileCompleted: true, onBreak: false, callPreference: 'phone',
      supportedMessagingChannels: null, messagingEnabled: null, specializations: [], maxCaseAssignments: null,
      teamId: null, supervisorPubkey: null,
    })
    const LIVE = 'c'.repeat(64)
    const rows = [...revoked, LIVE].map(adminRow)
    const deleted = vi.fn()
    const db = {
      select: () => ({
        from: () => Object.assign(Promise.resolve(rows), {
          where: () => Object.assign(Promise.resolve(rows), {
            limit: async () => rows.slice(0, 1),
          }),
        }),
      }),
      delete: () => ({ where: async () => { deleted() } }),
    }
    const identity = new IdentityService(db as never)

    it.each(revoked)('%s: getUserInternal', async (pubkey) => {
      expect(await identity.getUserInternal(pubkey)).toBeNull()
    })

    it('are never listed as users or super-admin recipients', async () => {
      expect((await identity.getUsers()).users.map(u => u.pubkey)).toEqual([LIVE])
      expect(await identity.listActiveSuperAdminPubkeys()).toEqual([LIVE])
    })

    it('still count as an admin, so first-admin bootstrap stays closed', async () => {
      const onlyRevoked = new IdentityService({
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ pubkey: revoked[0] }] }) }) }),
      } as never)
      expect((await onlyRevoked.hasAdmin()).hasAdmin).toBe(true)
    })

    it.each(revoked)('%s: cannot be given a user row or a session', async (pubkey) => {
      const untouched = new IdentityService(untouchableServices().services as never)
      await expect(untouched.createUser({ pubkey, name: 'x', phone: '', encryptedSecretKey: '' })).rejects.toThrow(/revoked/)
      await expect(untouched.createSession(pubkey)).rejects.toThrow(/revoked/)
    })

    it.each(revoked)('%s: an existing session is deleted, not renewed', async (pubkey) => {
      const sessionDb = {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ token: 't', pubkey, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] }) }) }),
        delete: () => ({ where: async () => { deleted() } }),
        update: () => { throw new Error('a revoked session must not be renewed') },
      }
      deleted.mockClear()
      await expect(new IdentityService(sessionDb as never).validateSession('t')).rejects.toThrow(/Invalid session/)
      expect(deleted).toHaveBeenCalledTimes(1)
    })

    it.each(revoked)('%s: cannot co-approve an emergency erasure, even with a valid signature', async (pubkey) => {
      const erasure = new ErasureService({} as never, identity)
      vi.spyOn(erasure, 'getMyRequest').mockResolvedValue(null)
      vi.spyOn(erasure, 'getConfig').mockResolvedValue({
        hubId: 'hub-1', delayHours: 72, hubShredDelayHours: 48, emergencyOverrideEnabled: true, updatedAt: new Date(), updatedBy: LIVE,
      })
      signatures.acceptAll = true
      try {
        await expect(erasure.createSelfRequest('d'.repeat(64), 'hub-1', 'rail', {
          coApproverPubkey: pubkey, coApproverSignature: 'ab'.repeat(64), timestamp: new Date().toISOString(),
        })).rejects.toThrow(/registered admin/)
      } finally {
        signatures.acceptAll = false
      }
    })
  })

  // `trackedFiles`, never a bare git call: fleet/verify runs this suite in a
  // `git archive` export with no `.git`, where the helper walks the export
  // instead — which holds exactly the committed files.
  it('are not reachable from any seed committed to this repository', () => {
    const root = path.resolve(__dirname, '../../../..')
    const files = trackedFiles(root)
    expect(files.length).toBeGreaterThan(1000)

    const revokedSet = revokedSigningKeys()
    const derived = new Map<string, string>()
    const hits: string[] = []
    let scanned = 0
    for (const file of files) {
      const full = path.join(root, file)
      let size: number
      try { size = statSync(full).size } catch { continue } // deleted in the working tree
      if (size > 5_000_000) continue
      const bytes = readFileSync(full)
      if (bytes.subarray(0, 8000).includes(0)) continue // binary
      scanned++
      const lines = bytes.toString('utf8').split('\n')
      lines.forEach((line, i) => {
        for (const seed of candidateSeeds(line)) {
          let pubkey = derived.get(seed)
          if (pubkey === undefined) {
            pubkey = bytesToHex(ed25519.getPublicKey(hexToBytes(seed)))
            derived.set(seed, pubkey)
          }
          // Name the location and the revoked key only — never the seed itself.
          if (revokedSet.has(pubkey)) hits.push(`${file}:${i + 1} holds the seed of revoked key ${pubkey.slice(0, 16)}…`)
        }
      })
    }
    expect(scanned).toBeGreaterThan(1000)
    expect(hits, `published sample-account seeds are back in the tree:\n${hits.join('\n')}`).toEqual([])
  })
})

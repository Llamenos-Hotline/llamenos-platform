/**
 * Rail: a deployment that is not a development server cannot create, register
 * or reveal a demo identity, and the demo signing seeds this repository once
 * published never come back.
 *
 * Every row of the environment matrix is a configuration someone could give the
 * shipped image — which is the same image CI tests under
 * ENVIRONMENT=development + DEV_ROUTES_ENABLED=true. Every row carries both
 * demo flags and a setup-state row claiming demo mode, so the only thing
 * standing between it and a demo super-admin is the development-server gate.
 */
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import configRoute from '@worker/routes/config'
import demoRoute from '@worker/routes/demo'
import { demoIdentities, DemoIdentitiesUnavailableError } from '@worker/lib/demo-identities'
import { resetDemoData, seedDemoDataset } from '@worker/services/demo-seeder'
import { isRevokedSigningKey, revokedSigningKeys } from '@worker/lib/revoked-signing-keys'
import { authenticateRequest, validateToken } from '@worker/lib/auth'
import { IdentityService } from '@worker/services/identity'
import { ErasureService } from '@worker/services/erasure'
import { DEMO_ACCOUNTS } from '@shared/demo-accounts'
import { bytesToHex, hexToBytes } from '@shared/encoding'

// Lets a test stand in for someone holding a published seed: any signature verifies.
const signatures = vi.hoisted(() => ({ acceptAll: false }))
vi.mock('@llamenos/crypto/ffi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@llamenos/crypto/ffi')>()
  return {
    ...actual,
    ed25519Verify: (...args: Parameters<typeof actual.ed25519Verify>) => signatures.acceptAll || actual.ed25519Verify(...args),
  }
})

const DEMO_FLAGS = { DEMO_MODE: 'true', DEMO_MODE_CONFIRM: 'DESTROY_ALL_DATA', DEMO_RESET_CRON: 'daily' }
const DEV_SERVER = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true' }

const ENVIRONMENTS = ['production', 'staging', 'demo', 'test', '', undefined, 'Development', 'development ']
const DEV_ROUTES = ['true', undefined, 'TRUE', '1']

/** Every combination except the one development-server configuration. */
const NOT_DEV: Array<Record<string, string | undefined>> = ENVIRONMENTS
  .flatMap(ENVIRONMENT => DEV_ROUTES.map(DEV_ROUTES_ENABLED => ({ ...DEMO_FLAGS, ENVIRONMENT, DEV_ROUTES_ENABLED })))
  .filter(env => !(env.ENVIRONMENT === 'development' && env.DEV_ROUTES_ENABLED === 'true'))
  .concat([{ ...DEMO_FLAGS, ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: undefined }])

const label = (env: Record<string, string | undefined>) =>
  `ENVIRONMENT=${JSON.stringify(env.ENVIRONMENT)} DEV_ROUTES_ENABLED=${JSON.stringify(env.DEV_ROUTES_ENABLED)}`

/** Services that record every property touched — a refused request must touch none. */
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

/** A database whose setup state claims the wizard's demo toggle was ticked. */
function demoClaimingServices() {
  const getSetupState = vi.fn().mockResolvedValue({ setupCompleted: true, demoMode: true })
  const services = {
    settings: {
      getSetupState,
      getEnabledChannels: vi.fn().mockResolvedValue({}),
      getTelephonyProvider: vi.fn().mockResolvedValue(null),
      getHubs: vi.fn().mockResolvedValue({ hubs: [] }),
    },
    identity: { hasAdmin: vi.fn().mockResolvedValue({ hasAdmin: true }) },
  }
  return { services: services as unknown as Services, getSetupState }
}

function appWith(env: Record<string, string | undefined>, services: Services, permissions: string[] = ['*']) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.env = { HOTLINE_NAME: 'Rail', ...env } as unknown as AppEnv['Bindings']
    c.set('services', services)
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', permissions)
    c.set('requestId', 'rail')
    await next()
  })
  app.route('/config', configRoute)
  app.route('/demo', demoRoute)
  return app
}

describe('demo identities off a development server', () => {
  it.each(NOT_DEV.map(env => [label(env), env]))('%s: cannot be generated', (_label, env) => {
    expect(() => demoIdentities(env)).toThrow(DemoIdentitiesUnavailableError)
  })

  it.each(NOT_DEV.map(env => [label(env), env]))('%s: are never revealed, and the database is never asked', async (_label, env) => {
    const { services, getSetupState } = demoClaimingServices()
    const res = await appWith(env, services).request('/config/demo/credentials')
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).not.toMatch(/seed/i)
    expect(getSetupState).not.toHaveBeenCalled()
  })

  it.each(NOT_DEV.map(env => [label(env), env]))('%s: a stored demoMode flag does not switch demo mode on', async (_label, env) => {
    const { services } = demoClaimingServices()
    const res = await appWith({ ...env, DEMO_MODE: undefined }, services).request('/config')
    expect(res.status).toBe(200)
    expect((await res.json()).demoMode).toBe(false)
  })

  it.each(NOT_DEV.map(env => [label(env), env]))('%s: the demo reset registers nothing', async (_label, env) => {
    const { services, touched } = untouchableServices()
    const res = await appWith(env, services).request('/demo/reset', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(touched).toEqual([])
  })

  it.each(NOT_DEV.map(env => [label(env), env]))('%s: the seeder refuses before touching any service', async (_label, env) => {
    const seeded = untouchableServices()
    await expect(seedDemoDataset(seeded.services, { ...env, ENVIRONMENT: env.ENVIRONMENT ?? '', HMAC_SECRET: 'x' }))
      .rejects.toThrow(DemoIdentitiesUnavailableError)
    expect(seeded.touched).toEqual([])

    const reset = untouchableServices()
    await expect(resetDemoData(reset.services, { ...env, ENVIRONMENT: env.ENVIRONMENT ?? '', HMAC_SECRET: 'x' }))
      .rejects.toThrow(DemoIdentitiesUnavailableError)
    expect(reset.touched).toEqual([])
  })
})

describe('demo identities on a development server (the control)', () => {
  it('are generated in-process, one per demo account, and are none of the revoked keys', () => {
    const identities = demoIdentities(DEV_SERVER)
    expect(identities.map(i => i.name)).toEqual(DEMO_ACCOUNTS.map(a => a.name))
    for (const identity of identities) {
      expect(bytesToHex(ed25519.getPublicKey(hexToBytes(identity.seedHex)))).toBe(identity.pubkey)
      expect(isRevokedSigningKey(identity.pubkey)).toBe(false)
    }
  })

  it('are handed to the login picker in demo mode, keyed by the listed handle', async () => {
    const { services } = demoClaimingServices()
    const res = await appWith({ ...DEV_SERVER, DEMO_MODE: undefined }, services).request('/config/demo/credentials')
    expect(res.status).toBe(200)
    const { credentials } = await res.json() as { credentials: Array<{ pubkey: string; seedHex: string }> }
    const identities = demoIdentities(DEV_SERVER)
    expect(credentials).toEqual(identities.map(i => ({ pubkey: i.listedPubkey, seedHex: i.seedHex })))
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

  it('are five, one per demo account that ever shipped seeds', () => {
    expect(revoked).toHaveLength(DEMO_ACCOUNTS.length)
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
        hubId: 'hub-1', delayHours: 72, emergencyOverrideEnabled: true, updatedAt: new Date(), updatedBy: LIVE,
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

  it('are not reachable from any seed committed to this repository', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
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
    expect(hits, `published demo seeds are back in the tree:\n${hits.join('\n')}`).toEqual([])
  })
})

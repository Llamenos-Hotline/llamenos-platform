/**
 * Demo identities: the fictional demo cast (packages/shared/demo-accounts.ts)
 * with Ed25519 signing keys generated inside this process.
 *
 * No demo key material is committed to this repository or shipped in any
 * image. Seeds come from the CSPRNG the first time a process asks for them,
 * are held only in that process's memory, and die with it — so nobody can sign
 * as a demo account unless this process handed them its seed.
 *
 * Only a development server can produce them (`devSurfacesEnabled`:
 * ENVIRONMENT=development AND DEV_ROUTES_ENABLED=true, the /api/test-*
 * boundary). DEMO_MODE, the setup wizard's `demoMode` flag in the database and
 * request input are not inputs to that decision: on every other deployment
 * nothing can create, register or reveal a demo identity.
 */
import { ed25519PubkeyFromSeed } from '@llamenos/crypto/ffi'
import { bytesToHex } from '@shared/encoding'
import { DEMO_ACCOUNTS, type DemoAccount } from '@shared/demo-accounts'
import { devSurfacesEnabled, type DevSurfacesEnv } from './dev-surfaces'

export interface DemoIdentity extends DemoAccount {
  /** Ed25519 signing seed the client imports to sign in as this account. */
  seedHex: string
  /** The account's handle in the shared list and the login picker (`DemoAccount.pubkey`). */
  listedPubkey: string
}

export class DemoIdentitiesUnavailableError extends Error {
  constructor() {
    super('Demo identities exist only on a development server (ENVIRONMENT=development and DEV_ROUTES_ENABLED=true)')
    this.name = 'DemoIdentitiesUnavailableError'
  }
}

let identities: readonly DemoIdentity[] | null = null

/**
 * The demo accounts addressed by their signing pubkeys. Throws
 * `DemoIdentitiesUnavailableError` anywhere but a development server.
 */
export function demoIdentities(env: DevSurfacesEnv): readonly DemoIdentity[] {
  if (!devSurfacesEnabled(env)) throw new DemoIdentitiesUnavailableError()
  identities ??= DEMO_ACCOUNTS.map((account) => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    return {
      ...account,
      pubkey: bytesToHex(ed25519PubkeyFromSeed(seed)),
      seedHex: bytesToHex(seed),
      listedPubkey: account.pubkey,
    }
  })
  return identities
}

/** Look up a demo identity by display name. Throws if it is not part of the demo cast. */
export function demoIdentityByName(env: DevSurfacesEnv, name: string): DemoIdentity {
  const found = demoIdentities(env).find(i => i.name === name)
  if (!found) throw new Error(`Demo account "${name}" missing from DEMO_ACCOUNTS`)
  return found
}

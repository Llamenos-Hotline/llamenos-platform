/**
 * Sample identities: the fictional cast the sample dataset is written around
 * (`lib/sample-dataset.ts` `SAMPLE_ACCOUNTS`), with Ed25519 signing keys
 * generated inside this process.
 *
 * No sample key material is committed to this repository or shipped in any
 * image. Seeds come from the CSPRNG the first time a process asks for them,
 * are held only in that process's memory, and die with it — so nobody can sign
 * as a sample account unless this process handed them its seed.
 *
 * Only a server that may serve the `/api/test-*` surface can produce them
 * (`devSurfacesEnabled`: ENVIRONMENT on the allowlist, DEV_ROUTES_ENABLED=true,
 * and a 32-character secret on anything but `development`). Request input and
 * stored database state are not inputs to that decision.
 *
 * Until #1604 these went through a second, narrower predicate
 * (`demoSurfacesEnabled`, pinned to `development` alone), because the same
 * seeds were also handed to an UNAUTHENTICATED login picker,
 * `GET /api/config/demo/credentials`. That picker is gone with the rest of demo
 * mode, so the only remaining caller is a secret-gated `/test-*` route on a
 * host that already serves `POST /api/test-reset` behind the same credential —
 * a caller who can wipe the database and promote itself to admin gains nothing
 * from a fictional volunteer's seed. The narrow predicate is therefore gone
 * rather than carried forward with nothing left to protect.
 */
import { ed25519PubkeyFromSeed } from '@llamenos/crypto/ffi'
import { bytesToHex } from '@shared/encoding'
import { SAMPLE_ACCOUNTS, type SampleAccount } from './sample-dataset'
import { devSurfacesEnabled, type DevSurfacesEnv } from './dev-surfaces'

export interface SampleIdentity extends SampleAccount {
  /** Ed25519 signing seed the client imports to sign in as this account. */
  seedHex: string
  /** Ed25519 signing pubkey derived from `seedHex` — the account's identity. */
  pubkey: string
}

export class SampleIdentitiesUnavailableError extends Error {
  constructor() {
    super('Sample identities exist only where the /api/test-* surface is enabled (see lib/dev-surfaces.ts)')
    this.name = 'SampleIdentitiesUnavailableError'
  }
}

let identities: readonly SampleIdentity[] | null = null

/**
 * The sample accounts addressed by their signing pubkeys. Throws
 * `SampleIdentitiesUnavailableError` wherever the dev surface is closed.
 */
export function sampleIdentities(env: DevSurfacesEnv): readonly SampleIdentity[] {
  if (!devSurfacesEnabled(env)) throw new SampleIdentitiesUnavailableError()
  identities ??= SAMPLE_ACCOUNTS.map((account) => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    return {
      ...account,
      pubkey: bytesToHex(ed25519PubkeyFromSeed(seed)),
      seedHex: bytesToHex(seed),
    }
  })
  return identities
}

/** Look up a sample identity by display name. Throws if it is not part of the cast. */
export function sampleIdentityByName(env: DevSurfacesEnv, name: string): SampleIdentity {
  const found = sampleIdentities(env).find(i => i.name === name)
  if (!found) throw new Error(`Sample account "${name}" missing from SAMPLE_ACCOUNTS`)
  return found
}

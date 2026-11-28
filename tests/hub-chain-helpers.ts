/**
 * Founding a hub over the API, as a client does (#2963): the founder's device
 * signs the new-hub genesis, the server stores it as the chain's first link
 * when it creates the hub, and the founder then commits each founder bundle's
 * permissions in a `policy {kind: bundle}` link.
 *
 * Links are signed by tests/mocks/hub-chain-mock.ts, pinned byte-for-byte to
 * the crate (apps/worker/__tests__/integration-bun/hub-chain-vectors.test.ts);
 * the server validates every one through the crate before storing it.
 *
 * Pure of Playwright fixtures: callers pass an APIRequestContext.
 */
import type { APIRequestContext } from '@playwright/test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { ChainHead, HubChainLink, HubFoundingResponse } from '@protocol/schemas/hub-chain'
import { apiGet, apiPost } from './api-helpers'
import { getSigchainViaApi, initializeIdentityViaApi, testDevice } from './identity-helpers'
import { bundlePermsHashMock, newHubGenesisMock, signHubLinkMock } from './mocks/hub-chain-mock'

/**
 * The founder's user-chain head, initialising the founder's identity (genesis
 * + PUK, through the real API) if they have none — the hub verifier needs the
 * signing device active in the founder's chain at the head the genesis names.
 */
export async function founderHead(request: APIRequestContext, seedHex: string): Promise<ChainHead> {
  const pubkey = bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)))
  let links = await getSigchainViaApi(request, pubkey, seedHex)
  if (links.length === 0) links = (await initializeIdentityViaApi(request, pubkey, testDevice(seedHex))).links
  const last = links[links.length - 1]
  return { seq: last.seqNo, hash: last.hash }
}

export interface Founding {
  id: string
  genesis: HubChainLink
  bundles: HubFoundingResponse['bundles']
  head: ChainHead
  seedHex: string
}

/** A client-minted hub id and the founder's signed genesis for it (`POST /hubs` / `setup/complete` body fields). */
export async function signFounding(request: APIRequestContext, seedHex: string): Promise<Founding> {
  const founding = await apiGet<HubFoundingResponse>(request, '/hubs/founding', seedHex)
  if (founding.status !== 200) throw new Error(`GET /hubs/founding failed: ${founding.status}`)
  const head = await founderHead(request, seedHex)
  const id = crypto.randomUUID()
  const genesis = newHubGenesisMock(id, seedHex, head, founding.data.bundles.map(b => b.bundle))
  return { id, genesis, bundles: founding.data.bundles, head, seedHex }
}

/** After the hub exists: commit each founder bundle's permissions, as the founder's client does. */
export async function commitFounding(request: APIRequestContext, f: Founding): Promise<HubChainLink[]> {
  const founder = bytesToHex(ed25519.getPublicKey(hexToBytes(f.seedHex)))
  const out: HubChainLink[] = []
  let prev = f.genesis
  for (const b of f.bundles) {
    const link = signHubLinkMock({
      hub: f.id,
      seq: prev.seq + 1,
      prevHash: prev.entryHash,
      signerUser: founder,
      signerUserHead: f.head,
      body: { type: 'policy', kind: 'bundle', bundle: b.bundle, permissions: b.permissions, permsHash: bundlePermsHashMock(b.permissions) },
    }, f.seedHex)
    const res = await apiPost(request, `/hubs/${f.id}/chain`, { link }, f.seedHex)
    if (res.status !== 201) throw new Error(`appending bundle policy ${b.bundle} failed: ${res.status} ${JSON.stringify(res.data)}`)
    out.push(link)
    prev = link
  }
  return out
}

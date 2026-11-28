/**
 * The hub authority chain on desktop (#2963; wire spec §5, #2974 items 3–5).
 *
 * - **Load:** fetch the hub's chain and verify it IN THE CRATE (`hubChainCall`
 *   → Rust `hub_chain::call`), with the user chains of its signers, against the
 *   trusted anchor this device holds for the hub. Verification replays from
 *   genesis: the chain-derived state is never persisted, so nothing this
 *   device stored can stand in for a verification it did not do.
 * - **Anchor:** `{hub, seq, hash}` comes from a trusted source only — this
 *   device's own genesis, or its own previous verification (provisioning and
 *   invite anchors, §5.7, belong to their own payload formats) — never from the
 *   server. A chain that does not contain it is a fork.
 * - **Alerts:** a fork, an unauthorised (or otherwise invalid) link, and the
 *   advisory stale-signer finding (D13). **On a fork, or any invalid chain,
 *   this device stops sealing in that hub** ({@link assertHubSealable}).
 * - **Roles:** {@link chainPermissionsFor} is what the chain itself grants a
 *   user; the server's `hub_roles` is a cache that is never trusted here.
 *
 * Nothing here canonicalises, hashes or checks a link: every such step is the
 * crate's. This module only fetches, calls the crate and remembers verdicts.
 */
import type {
  ChainHead,
  CrateSigchainLink,
  HubChainAlert,
  HubChainLink,
  HubChainState,
  HubChainVerified,
  UnsignedHubLink,
} from '@protocol/schemas/hub-chain'
import { appendHubChainLink, createHub, getHubChainPage, getHubFounding, getSigchain } from './api'
import { getHubChainAnchor, hubChainCall, hubChainSignLink, setHubChainAnchor } from './platform'
import { ensureDeviceIdentity, toCryptoSigchainLink } from './user-identity'
import type { Hub } from '@shared/types'

/** What loading a hub's chain concluded. */
export type HubChainStatus =
  | { kind: 'verified'; verified: HubChainVerified; alerts: HubChainAlert[] }
  /** The hub has no chain: only hubs seeded outside every client create path. */
  | { kind: 'none' }
  /** The served chain does not contain this device's trusted anchor. Sealing stops. */
  | { kind: 'fork'; detail: string }
  /** The crate refused the chain — an unauthorised or otherwise invalid link. Sealing stops. */
  | { kind: 'refused'; code: string; detail: string }

/** The crate's closed rejection code: the first word of its error (`chain_fork: …`). */
export function rejectionCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const m = /^([a-z_]+):/.exec(message)
  return m ? m[1] : 'invalid_input'
}

const statuses = new Map<string, HubChainStatus>()
const listeners = new Set<(hubId: string, status: HubChainStatus) => void>()

/** Subscribe to chain verdicts (the alert banner listens). Returns the unsubscribe. */
export function onHubChainStatus(listener: (hubId: string, status: HubChainStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hubChainStatus(hubId: string): HubChainStatus | undefined {
  return statuses.get(hubId)
}

function record(hubId: string, status: HubChainStatus): HubChainStatus {
  statuses.set(hubId, status)
  for (const l of listeners) l(hubId, status)
  return status
}

/** Every user a verifier of `links` needs the chain of: each signer, and each recovery holder. */
function usersNamedBy(links: readonly HubChainLink[]): string[] {
  const named = new Set<string>()
  for (const l of links) {
    named.add(l.signerUser)
    const holders = l.body.type === 'recovery_group' ? l.body.holders : undefined
    if (Array.isArray(holders)) for (const h of holders) if (typeof h === 'string') named.add(h)
  }
  return [...named].sort()
}

async function fetchChain(hubId: string): Promise<HubChainLink[]> {
  const links: HubChainLink[] = []
  for (let from = 1; ;) {
    const page = await getHubChainPage(hubId, from)
    links.push(...page.links)
    if (!page.hasMore || page.links.length === 0) return links
    from = page.links[page.links.length - 1].seq + 1
  }
}

async function userChainsFor(links: readonly HubChainLink[]): Promise<CrateSigchainLink[][]> {
  const chains = await Promise.all(usersNamedBy(links).map(async u => (await getSigchain(u)).links.map(toCryptoSigchainLink)))
  return chains.filter(c => c.length > 0)
}

/**
 * Fetch and verify `hubId`'s chain in the crate against this device's anchor,
 * and advance the anchor to the verified head. Never throws for a refused
 * chain: the refusal is the answer, and it is recorded so sealing stops.
 */
export async function loadHubChain(hubId: string): Promise<HubChainStatus> {
  const links = await fetchChain(hubId)
  const anchor = await getHubChainAnchor(hubId)
  if (links.length === 0) {
    return record(hubId, anchor
      ? { kind: 'fork', detail: `the server serves no chain, but this device verified seq ${anchor.seq}` }
      : { kind: 'none' })
  }
  try {
    const verified = await hubChainCall('verify', {
      links,
      userChains: await userChainsFor(links),
      ...(anchor ? { anchor } : {}),
    })
    await setHubChainAnchor(hubId, verified.head)
    return record(hubId, { kind: 'verified', verified, alerts: verified.alerts })
  } catch (err) {
    const code = rejectionCode(err)
    const detail = err instanceof Error ? err.message : String(err)
    return record(hubId, code === 'chain_fork' ? { kind: 'fork', detail } : { kind: 'refused', code, detail })
  }
}

/** Thrown when sealing in a hub whose chain is forked or refused. */
export class HubSealingStoppedError extends Error {
  constructor(readonly hubId: string, readonly status: HubChainStatus) {
    super(`Sealing is stopped in hub ${hubId}: its authority chain ${status.kind === 'fork' ? 'is forked' : 'was refused'}`)
    this.name = 'HubSealingStoppedError'
  }
}

/** Refuse to seal in a hub whose chain this device found forked or invalid. */
export function assertHubSealable(hubId: string): void {
  const status = statuses.get(hubId)
  if (status && (status.kind === 'fork' || status.kind === 'refused')) throw new HubSealingStoppedError(hubId, status)
}

/**
 * What the chain itself grants `user` in a verified hub: their defined bundles'
 * permissions, or every permission for the founder during the bootstrap.
 * `undefined` when the hub has no verified chain or the chain does not list
 * the user — the caller must not substitute the server's answer as chain truth.
 */
export function chainPermissionsFor(state: HubChainState, user: string): { all: true } | { all: false; permissions: string[] } | undefined {
  if (state.bootstrap === 1 && state.founder === user) return { all: true }
  const member = state.members.find(m => m.user === user)
  return member ? { all: false, permissions: member.permissions } : undefined
}

// --- Founding a hub (new-hub genesis, §5.6) ---

/**
 * This device's own user-chain head, verified in the crate (initialising the
 * identity first if it has none): the `signerUserHead` its hub links reference.
 */
async function ownHead(userPubkey: string): Promise<ChainHead> {
  const verified = await ensureDeviceIdentity(userPubkey)
  return { seq: verified.headSeq, hash: verified.headHash }
}

/**
 * The founding links of a new hub, signed by this device (#2963): the genesis
 * naming the founder alone with the founder bundles the server's catalog
 * designates, and — appended once the hub exists — one `policy {kind: bundle}`
 * per bundle committing its concrete permissions (D12, ids in clear).
 */
export async function signGenesis(hubId: string, founder: string): Promise<{ genesis: HubChainLink; policies: (prev: HubChainLink) => Promise<HubChainLink[]> }> {
  const { bundles } = await getHubFounding()
  if (bundles.length === 0) throw new Error('The server names no founder role for a new hub')
  const head = await ownHead(founder)
  const genesis = await hubChainSignLink({
    hub: hubId,
    seq: 1,
    prevHash: null,
    signerUser: founder,
    signerUserHead: head,
    body: {
      type: 'genesis',
      founder,
      migration: 0,
      members: [{ user: founder, bundles: bundles.map(b => b.bundle).sort() }],
    },
  })
  const policies = async (prev: HubChainLink) => {
    const out: HubChainLink[] = []
    let last = prev
    for (const b of bundles) {
      const { permsHash } = await hubChainCall('permsHash', { permissions: b.permissions })
      const unsigned: UnsignedHubLink = {
        hub: hubId,
        seq: last.seq + 1,
        prevHash: last.entryHash,
        signerUser: founder,
        signerUserHead: head,
        body: { type: 'policy', kind: 'bundle', bundle: b.bundle, permissions: b.permissions, permsHash },
      }
      last = await hubChainSignLink(unsigned)
      out.push(last)
    }
    return out
  }
  return { genesis, policies }
}

/**
 * Commit the founding bundle policies after the hub exists, and take this
 * device's own genesis as the hub's first trusted anchor.
 */
export async function completeFounding(hubId: string, genesis: HubChainLink, policies: (prev: HubChainLink) => Promise<HubChainLink[]>): Promise<void> {
  await setHubChainAnchor(hubId, { seq: genesis.seq, hash: genesis.entryHash })
  for (const link of await policies(genesis)) {
    const { head } = await appendHubChainLink(hubId, link)
    await setHubChainAnchor(hubId, head)
  }
}

/** Found a hub: this device signs its genesis; then its bundle policies (§5.6). */
export async function foundHub(
  founder: string,
  data: { name: string; slug?: string; description?: string; phoneNumber?: string; timezone?: string },
): Promise<{ hub: Hub }> {
  const id = crypto.randomUUID()
  const { genesis, policies } = await signGenesis(id, founder)
  const created = await createHub({ ...data, id, genesis })
  await completeFounding(id, genesis, policies)
  return created
}

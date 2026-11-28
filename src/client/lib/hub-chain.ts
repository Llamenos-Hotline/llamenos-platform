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
  LinkIntent,
  SignedIntent,
} from '@protocol/schemas/hub-chain'
import { appendHubChainLink, createHub, getHubChainPage, getHubFounding, getSigchain } from './api'
import { getDevicePubkeys, getHubChainAnchor, hubChainCall, hubChainSign, setHubChainAnchor } from './platform'
import { ApiError } from './api/client'
import { assertExtendsVerifiedHead, initializeUserIdentity, recordVerifiedHead, toCryptoSigchainLink } from './user-identity'
import type { Hub } from '@shared/types'

/** What loading a hub's chain concluded. */
export type HubChainStatus =
  | { kind: 'verified'; verified: HubChainVerified; alerts: HubChainAlert[]; at: number }
  /** The server serves no chain. Sealing is refused: every client-founded hub has a genesis. */
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

async function fetchChain(hubId: string): Promise<HubChainLink[]> {
  const links: HubChainLink[] = []
  for (let from = 1; ;) {
    const page = await getHubChainPage(hubId, from)
    links.push(...page.links)
    if (!page.hasMore || page.links.length === 0) return links
    from = page.links[page.links.length - 1].seq + 1
  }
}

/** The user chain of every user the crate says a verifier of `links` needs (each signer, each recovery holder). */
async function userChainsFor(links: HubChainLink[]): Promise<CrateSigchainLink[][]> {
  const { users } = await hubChainCall('usersNamed', { links })
  const chains = await Promise.all(users.map(async u => (await getSigchain(u)).links.map(toCryptoSigchainLink)))
  return chains.filter(c => c.length > 0)
}

/**
 * One verification or append at a time per hub. The anchor is a
 * read-modify-write — read it, verify against it, advance it — and two of them
 * interleaving let a server time a SHORTER chain to finish last and roll the
 * anchor back, so a fork above the regressed anchor would pass (#3133 review).
 */
const hubQueues = new Map<string, Promise<unknown>>()
function serialisedForHub<T>(hubId: string, step: () => Promise<T>): Promise<T> {
  const run = (hubQueues.get(hubId) ?? Promise.resolve()).then(step, step)
  const tail = run.then(() => undefined, () => undefined)
  hubQueues.set(hubId, tail)
  void tail.then(() => { if (hubQueues.get(hubId) === tail) hubQueues.delete(hubId) })
  return run
}

/**
 * Advance `hubId`'s anchor to `head`, monotonically: a lower seq, or a
 * different hash at the same seq, is refused as a fork — the anchor is the
 * root fork detection stands on, so it never moves backwards or sideways.
 */
async function advanceHubAnchor(hubId: string, head: ChainHead): Promise<void> {
  const known = await getHubChainAnchor(hubId)
  if (known && head.seq < known.seq) {
    throw new Error(`chain_fork: the verified head seq ${head.seq} is below the anchor this device holds at seq ${known.seq}`)
  }
  if (known && head.seq === known.seq) {
    if (head.hash !== known.hash) throw new Error(`chain_fork: a different link at the anchored seq ${known.seq}`)
    return
  }
  await setHubChainAnchor(hubId, head)
}

/**
 * Fetch and verify `hubId`'s chain in the crate against this device's anchor,
 * and advance the anchor to the verified head. Never throws for a refused
 * chain: the refusal is the answer, and it is recorded so sealing stops.
 */
export function loadHubChain(hubId: string): Promise<HubChainStatus> {
  // The one entry point: every caller (the banner, the sealing gate, a hub
  // switch) shares a verification already in flight for the hub, and anything
  // else that moves the anchor (founding, an append) queues behind it.
  let pending = inFlight.get(hubId)
  if (!pending) {
    pending = serialisedForHub(hubId, () => loadHubChainNow(hubId)).finally(() => inFlight.delete(hubId))
    inFlight.set(hubId, pending)
  }
  return pending
}

const inFlight = new Map<string, Promise<HubChainStatus>>()

async function loadHubChainNow(hubId: string): Promise<HubChainStatus> {
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
    // The crate verified A chain; it must be THIS hub's, or a server could
    // answer one hub's request with another hub's valid chain.
    if (verified.hub !== hubId) {
      return record(hubId, { kind: 'refused', code: 'chain_hub_mismatch', detail: `the served chain is hub ${verified.hub}'s, not ${hubId}'s` })
    }
    await advanceHubAnchor(hubId, verified.head)
    return record(hubId, { kind: 'verified', verified, alerts: verified.alerts, at: Date.now() })
  } catch (err) {
    const code = rejectionCode(err)
    const detail = err instanceof Error ? err.message : String(err)
    return record(hubId, code === 'chain_fork' ? { kind: 'fork', detail } : { kind: 'refused', code, detail })
  }
}

/** Thrown when sealing in a hub whose chain is forked or refused. */
export class HubSealingStoppedError extends Error {
  constructor(readonly hubId: string, readonly status: HubChainStatus) {
    const why = status.kind === 'fork' ? 'is forked' : status.kind === 'refused' ? 'was refused' : 'is missing'
    super(`Sealing is stopped in hub ${hubId}: its authority chain ${why}`)
    this.name = 'HubSealingStoppedError'
  }
}

const VERIFIED_TTL_MS = 5 * 60 * 1000

/**
 * Refuse to seal in a hub unless this device has VERIFIED its chain (fail
 * closed). With no verdict yet — or only "no chain", which a server could
 * claim for any hub — the chain is loaded and verified first. A fork or a
 * refused chain throws {@link HubSealingStoppedError}; so does a hub with no
 * chain (every client-founded hub has a genesis); a fetch failure throws too,
 * because "could not check" is not "checked".
 */
export async function assertHubSealable(hubId: string): Promise<void> {
  let status = statuses.get(hubId)
  // A verification is good for VERIFIED_TTL_MS: after that, sealing re-checks
  // the chain (a fork served since is caught), and a failed re-check refuses.
  if (!status || status.kind === 'none' || (status.kind === 'verified' && Date.now() - status.at >= VERIFIED_TTL_MS)) {
    status = await loadHubChain(hubId)
  }
  if (status.kind !== 'verified') throw new HubSealingStoppedError(hubId, status)
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
 * This device's own user-chain head, verified in the crate: the
 * `signerUserHead` its hub links reference. The hub verifier requires exactly
 * this — the signing device active in the user's chain at that head — so that
 * is what is checked here. A user with no chain yet initialises it first.
 */
async function ownHead(userPubkey: string): Promise<ChainHead> {
  const device = await getDevicePubkeys()
  if (!device) throw new Error('device key locked')
  const { links } = await getSigchain(userPubkey)
  if (links.length === 0) {
    const created = await initializeUserIdentity(userPubkey)
    return { seq: created.headSeq, hash: created.headHash }
  }
  // The served chain must extend the head this device last verified (no
  // rollback to a head where a since-removed device was still active).
  await assertExtendsVerifiedHead(userPubkey, links)
  const verified = await hubChainCall('verifySigchain', { links: links.map(toCryptoSigchainLink) })
  if (verified.userPubkey !== userPubkey || !verified.activeDevicePubkeys.includes(device.signingPubkeyHex)) {
    throw new Error('This device is not active in its user chain, so it cannot sign for this user in a hub')
  }
  await recordVerifiedHead(verified)
  return { seq: verified.headSeq, hash: verified.headHash }
}

/**
 * The founding links of a new hub, signed by this device (#2963): the genesis
 * naming the founder alone with the founder bundles the server's catalog
 * designates, and — appended once the hub exists — one `policy {kind: bundle}`
 * per bundle committing its concrete permissions (D12, ids in clear). The
 * crate builds every link from its intent (#3133).
 */
export async function signGenesis(hubId: string, founder: string): Promise<{ genesis: HubChainLink; policies: (prev: ChainHead) => Promise<SignedIntent[]> }> {
  const { bundles } = await getHubFounding()
  if (bundles.length === 0) throw new Error('The server names no founder role for a new hub')
  const head = await ownHead(founder)
  const { link: genesis } = await hubChainSign({
    hub: hubId,
    prev: null,
    signerUser: founder,
    signerUserHead: head,
    intent: { type: 'genesis', bundles: bundles.map(b => b.bundle) },
  })
  const policies = async (prev: ChainHead) => {
    const out: SignedIntent[] = []
    let last = prev
    for (const b of bundles) {
      const signed = await hubChainSign({
        hub: hubId,
        prev: last,
        signerUser: founder,
        signerUserHead: head,
        intent: { type: 'bundlePolicy', bundle: b.bundle, permissions: b.permissions },
      })
      out.push(signed)
      last = signed.head
    }
    return out
  }
  return { genesis, policies }
}

/**
 * Commit the founding bundle policies after the hub exists, and take this
 * device's own genesis as the hub's first trusted anchor.
 */
export function completeFounding(hubId: string, genesis: HubChainLink, policies: (prev: ChainHead) => Promise<SignedIntent[]>): Promise<void> {
  return serialisedForHub(hubId, async () => {
    const genesisHead = { seq: genesis.seq, hash: genesis.entryHash }
    await advanceHubAnchor(hubId, genesisHead)
    for (const { link, head } of await policies(genesisHead)) {
      await appendHubChainLink(hubId, link)
      // The anchor is this device's own signed link, never the server's echo.
      await advanceHubAnchor(hubId, head)
    }
  })
}

/** How many times an append that lost the head race is rebuilt (§5.1). */
const APPEND_ATTEMPTS = 3

/** Thrown when this device's verified chain does not let it sign the intended link. */
export class HubChainWriteRefusedError extends Error {
  constructor(readonly hubId: string, readonly status: HubChainStatus) {
    super(`This device cannot write to hub ${hubId}'s authority chain: it is not verified (${status.kind})`)
    this.name = 'HubChainWriteRefusedError'
  }
}

/**
 * Sign and append the links `intents(state)` names, as this user, on the head
 * this device has just verified (§5.1): verify, let the caller decide against
 * the verified state, sign each through the crate, append. A lost race (409)
 * re-reads, re-verifies, re-decides and re-signs. Every role write — adding a
 * member, changing or revoking a role, signing a pending member — goes
 * through here; the server has no unsigned role write (#3133).
 */
export function appendIntents(
  hubId: string,
  signer: string,
  intents: (verified: HubChainVerified) => LinkIntent[] | Promise<LinkIntent[]>,
): Promise<HubChainVerified> {
  return serialisedForHub(hubId, async () => {
    for (let attempt = 1; ; attempt++) {
      const status = await loadHubChainNow(hubId)
      if (status.kind !== 'verified') throw new HubChainWriteRefusedError(hubId, status)
      const wanted = await intents(status.verified)
      if (wanted.length === 0) return status.verified
      const head = await ownHead(signer)
      let prev = status.verified.head
      try {
        for (const intent of wanted) {
          const signed = await hubChainSign({ hub: hubId, prev, signerUser: signer, signerUserHead: head, intent })
          await appendHubChainLink(hubId, signed.link)
          await advanceHubAnchor(hubId, signed.head)
          prev = signed.head
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && attempt < APPEND_ATTEMPTS) continue
        throw err
      }
      const after = await loadHubChainNow(hubId)
      if (after.kind !== 'verified') throw new HubChainWriteRefusedError(hubId, after)
      return after.verified
    }
  })
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

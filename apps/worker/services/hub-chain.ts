/**
 * Hub authority chain storage and append (#2963; wire spec §5.1).
 *
 * The server stores and serves each hub's chain. It validates every link
 * through packages/crypto (`hubChainCall('verify')` over the stored chain plus
 * the candidate) before storing it, which keeps garbage out — but no client
 * trusts that verdict: every client verifies the chain it is served itself.
 *
 * An append is a compare-and-set against the head (`UNIQUE(hub_id, seq)` under
 * a per-hub advisory lock): a link whose `seq`/`prevHash` no longer matches the
 * head loses the race with a 409, and its signer re-reads, re-evaluates its
 * authority against the new head, re-signs and retries.
 *
 * `users.hub_roles` is a CACHE of the chain-derived roles, rewritten from the
 * crate's state on every append that changes them. It serves server-side
 * routing; no client relies on it for an authorisation decision.
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { CryptoError, hubChainCall, type HubChainInput, type SigchainLink } from '@llamenos/crypto/ffi'
import type { ChainHead, HubChainLink, HubChainState, HubChainVerified } from '@protocol/schemas/hub-chain'
import { hubChainLinkSchema } from '@protocol/schemas/hub-chain'
import type { Database } from '../db'
import { hubChainLinks, users } from '../db/schema'
import { loadCrateSigchain } from './crypto-keys'
import { ServiceError } from './service-error'
import { replaceHubRole, type HubRoleAssignment } from '../lib/hub-admin'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type Reader = Pick<Database, 'select'>

/** A link the crate refused, by its closed rejection code. */
export class HubChainRejectedError extends ServiceError {
  constructor(code: string, message: string) {
    super(400, message, code)
  }
}

/** The append lost the compare-and-set: the head moved. */
export class HubChainConflictError extends ServiceError {
  constructor(readonly head: ChainHead | null) {
    super(409, 'The hub chain head moved: re-read it, re-evaluate and re-sign', 'chain_head_moved')
  }
}

export function hubChainLockKey(hubId: string): string {
  return `hub-chain:${hubId}`
}

function rowToLink(row: typeof hubChainLinks.$inferSelect): HubChainLink {
  return hubChainLinkSchema.parse(row.linkJson)
}

/** Every user whose chain a verifier of `links` needs: each signer, and each recovery holder. */
export function usersNamedBy(links: readonly HubChainLink[]): string[] {
  const named = new Set<string>()
  for (const l of links) {
    named.add(l.signerUser)
    if (l.body.type === 'recovery_group' && Array.isArray(l.body.holders)) {
      for (const h of l.body.holders) if (typeof h === 'string') named.add(h)
    }
  }
  return [...named].sort()
}

export class HubChainService {
  constructor(private readonly db: Database) {}

  async head(db: Reader, hubId: string): Promise<ChainHead | null> {
    const [row] = await db
      .select({ seq: hubChainLinks.seq, hash: hubChainLinks.entryHash })
      .from(hubChainLinks)
      .where(eq(hubChainLinks.hubId, hubId))
      .orderBy(desc(hubChainLinks.seq))
      .limit(1)
    return row ? { seq: row.seq, hash: row.hash } : null
  }

  /** Links with `seq >= from`, at most `limit`, ascending — the client's fetch-forward read. */
  async read(hubId: string, from: number, limit: number): Promise<{ links: HubChainLink[]; head: ChainHead | null; hasMore: boolean }> {
    const rows = await this.db
      .select()
      .from(hubChainLinks)
      .where(and(eq(hubChainLinks.hubId, hubId), gte(hubChainLinks.seq, from)))
      .orderBy(asc(hubChainLinks.seq))
      .limit(limit + 1)
    const head = await this.head(this.db, hubId)
    return { links: rows.slice(0, limit).map(rowToLink), head, hasMore: rows.length > limit }
  }

  async allLinks(db: Reader, hubId: string): Promise<HubChainLink[]> {
    const rows = await db
      .select()
      .from(hubChainLinks)
      .where(eq(hubChainLinks.hubId, hubId))
      .orderBy(asc(hubChainLinks.seq))
    return rows.map(rowToLink)
  }

  /** The user chains a verifier of `links` needs, from storage. */
  async userChainsFor(db: Reader, links: readonly HubChainLink[]): Promise<SigchainLink[][]> {
    const chains = await Promise.all(usersNamedBy(links).map(u => loadCrateSigchain(db, u)))
    return chains.filter(c => c.length > 0)
  }

  /** Verify `links` through the crate with the user chains storage holds. */
  async verify(db: Reader, links: HubChainLink[]): Promise<HubChainVerified> {
    const input: HubChainInput = { links, userChains: await this.userChainsFor(db, links) }
    try {
      return hubChainCall('verify', input)
    } catch (e) {
      if (e instanceof CryptoError) {
        throw new HubChainRejectedError(e.reason ?? 'invalid_input', e.message)
      }
      throw e
    }
  }

  /** The chain-derived state of a hub's stored chain, or `null` for a hub with none. */
  async state(hubId: string): Promise<HubChainState | null> {
    const links = await this.allLinks(this.db, hubId)
    if (links.length === 0) return null
    return (await this.verify(this.db, links)).state
  }

  /**
   * Append `link` to `hubId`'s chain inside `tx`: compare-and-set against the
   * head under the hub's advisory lock, crate validation of the stored chain
   * plus the link, then the row and the `hub_roles` cache.
   */
  async appendInTx(tx: Tx, hubId: string, link: HubChainLink): Promise<ChainHead> {
    if (link.hub !== hubId) {
      throw new HubChainRejectedError('chain_hub_mismatch', `The link names hub ${link.hub}, not ${hubId}`)
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${hubChainLockKey(hubId)}))`)
    const head = await this.head(tx, hubId)
    const expectedSeq = (head?.seq ?? 0) + 1
    if (link.seq !== expectedSeq || (link.prevHash ?? null) !== (head?.hash ?? null)) {
      throw new HubChainConflictError(head)
    }
    const stored = head ? await this.allLinks(tx, hubId) : []
    const verified = await this.verify(tx, [...stored, link])
    await tx.insert(hubChainLinks).values({
      hubId,
      seq: link.seq,
      prevHash: link.prevHash,
      entryHash: link.entryHash,
      linkJson: link,
    })
    if (['genesis', 'role_grant', 'role_revoke', 'policy'].includes(link.body.type)) {
      await writeHubRolesCache(tx, hubId, verified.state, link)
    }
    return verified.head
  }

  async append(hubId: string, link: HubChainLink): Promise<ChainHead> {
    return this.db.transaction(tx => this.appendInTx(tx, hubId, link))
  }
}

/**
 * Rewrite the `hub_roles` cache from the chain-derived state for the users the
 * link touched: a member's hub roles become exactly their chain bundles, and a
 * user the chain no longer lists loses the hub. Only users with a `users` row
 * are cached (a grant may name a user who has not registered yet).
 */
async function writeHubRolesCache(tx: Tx, hubId: string, state: HubChainState, link: HubChainLink): Promise<void> {
  const touched = new Set<string>()
  if (link.body.type === 'genesis' && typeof link.body.founder === 'string') touched.add(link.body.founder)
  if ((link.body.type === 'role_grant' || link.body.type === 'role_revoke') && typeof link.body.user === 'string') {
    touched.add(link.body.user)
  }
  if (link.body.type === 'policy') for (const m of state.members) touched.add(m.user)
  if (touched.size === 0) return
  const rows = await tx
    .select({ pubkey: users.pubkey, hubRoles: users.hubRoles })
    .from(users)
    .where(inArray(users.pubkey, [...touched]))
    .for('update')
  const bundlesOf = new Map(state.members.map(m => [m.user, m.bundles]))
  for (const row of rows) {
    const prior = (row.hubRoles as HubRoleAssignment[] | null) ?? []
    const bundles = bundlesOf.get(row.pubkey)
    const hubRoles = bundles && bundles.length > 0
      ? replaceHubRole(prior, hubId, bundles)
      : prior.filter(hr => hr.hubId !== hubId)
    await tx.update(users).set({ hubRoles, updatedAt: new Date() }).where(eq(users.pubkey, row.pubkey))
  }
}

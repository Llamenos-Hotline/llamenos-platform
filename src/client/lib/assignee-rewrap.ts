/**
 * Client half of the assignee re-wrap (#1512, #2046; PROTOCOL.md §2.4.1).
 *
 * A message's content key is wrapped for the readers known when it was
 * written, and the server discards the key. So when a volunteer claims (or is
 * reassigned) a conversation, the messages already in it stay sealed to the
 * admins alone — the server holds nothing that could add the new assignee.
 *
 * An admin client CAN open those messages. This module runs on such a client:
 * it asks the server which messages the assignee's devices cannot open
 * (`GET /conversations/:id/assignee-envelopes`), opens each content key from
 * its own envelope, seals it to the missing device keys
 * (`platform.rewrapMessageKey`), and posts the envelopes back. Plaintext and
 * content keys never reach the server, and no existing reader loses access:
 * the ciphertext is untouched and the server only ever appends envelopes.
 *
 * Triggers:
 *  - the `conversation:assigned` event that `POST /:id/claim` and `PATCH /:id`
 *    publish, from EVERY member hub (multi-hub axiom — never the active hub);
 *  - a sweep of each member hub's active conversations whenever the relay
 *    (re)connects, so an assignment made while no admin client was online is
 *    closed by the first admin client to come online.
 *
 * If no admin client is online at all the gap stays open until one is. That is
 * inherent to a zero-knowledge re-wrap, not a defect to engineer around.
 */
import { useEffect } from 'react'
import { KIND_CONVERSATION_ASSIGNED } from '@shared/event-kinds'
import type { AssigneeEnvelopeEntry, AssigneeEnvelopeGapsResponse } from '@protocol/schemas'
import {
  addAssigneeEnvelopes,
  getAssigneeEnvelopeGaps,
  listActiveConversationsInHub,
} from './api/conversations'
import { ApiError, NetworkError, OfflineQueuedError } from './api/client'
import { rewrapMessageKey } from './platform'
import { useAuth } from './auth'
import { useMemberHubIds } from './member-hubs'
import { useRelaySubscriptions } from './relay/hooks'
import { useRelayState } from './relay/context'
import type { ConversationAssignedEvent } from './relay/types'

/** `addAssigneeEnvelopesBodySchema` accepts at most this many per request. */
const MAX_ENVELOPES_PER_POST = 1000

/** Page size for the catch-up sweep (`paginationSchema` maximum). */
const SWEEP_PAGE_SIZE = 200

const REWRAP_KINDS = [KIND_CONVERSATION_ASSIGNED]

/** The permissions both assignee-envelope routes require. */
export const REWRAP_PERMISSIONS = ['conversations:read-all', 'conversations:update'] as const

/**
 * Make every message in `conversationId` that this device can open readable by
 * the conversation's current assignee. Returns the number of envelopes added.
 *
 * Loops until the server reports no gaps, or until a round makes no progress —
 * which happens when the remaining gaps are on messages this device holds no
 * envelope for (it is not one of their readers), so another reader must close
 * them.
 */
export async function rewrapConversationForAssignee(hubId: string, conversationId: string): Promise<number> {
  let total = 0
  for (;;) {
    const gaps = await getAssigneeEnvelopeGaps(hubId, conversationId)
    if (gaps.messages.length === 0) return total
    assertCoherentGaps(conversationId, gaps)

    const entries: AssigneeEnvelopeEntry[] = []
    for (const gap of gaps.messages) {
      let sealed
      try {
        sealed = await rewrapMessageKey(gap.readerEnvelopes, gap.missingRecipients)
      } catch (err) {
        // An envelope addressed to this device that does not open is a defect
        // (wrong key or AAD at write time). Report it and re-wrap the rest:
        // one bad record must not keep the assignee out of every other one.
        console.error(
          `[assignee-rewrap] message ${gap.id} in conversation ${conversationId}: ` +
          `envelope addressed to this device failed to open — ${describe(err)}`,
        )
        continue
      }
      if (!sealed) continue
      for (const envelope of sealed) entries.push({ messageId: gap.id, envelope })
    }
    if (entries.length === 0) return total

    let added = 0
    for (let i = 0; i < entries.length; i += MAX_ENVELOPES_PER_POST) {
      const batch = entries.slice(i, i + MAX_ENVELOPES_PER_POST)
      added += (await addAssigneeEnvelopes(hubId, conversationId, { envelopes: batch })).added
    }
    total += added
    // Zero means another re-wrapper got there first (first write wins
    // server-side). It is making the progress; asking again would only race it.
    if (added === 0) return total
  }
}

const X25519_HEX = /^[0-9a-f]{64}$/

/**
 * Refuse a gap list that is not internally consistent before sealing anything.
 *
 * The keys to seal to come from the server's device registry — the same
 * registry every message write path already trusts to name a user's readers
 * (PROTOCOL.md §2.4.1, "Trust"). Nothing on the client can yet verify them
 * independently; that needs the user sigchain. What CAN be checked is that the
 * answer names an assignee, and that every key a message is to be sealed to is
 * one of that assignee's listed device keys and a well-formed X25519 key. A
 * response that fails either is not an answer this protocol produces, so the
 * re-wrap stops rather than sealing content keys to it.
 */
function assertCoherentGaps(conversationId: string, gaps: AssigneeEnvelopeGapsResponse): void {
  if (!gaps.assignedTo) {
    throw new Error(`assignee-envelope gaps for ${conversationId} name messages but no assignee`)
  }
  const recipients = new Set(gaps.recipients)
  for (const key of recipients) {
    if (!X25519_HEX.test(key)) {
      throw new Error(`assignee-envelope gaps for ${conversationId} list a malformed recipient key`)
    }
  }
  for (const gap of gaps.messages) {
    if (gap.missingRecipients.some(key => !recipients.has(key))) {
      throw new Error(
        `assignee-envelope gaps for ${conversationId}: message ${gap.id} names a recipient ` +
        'that is not one of the assignee\'s listed device keys',
      )
    }
  }
}

const inFlight = new Map<string, Promise<void>>()
const rerunRequested = new Set<string>()

/**
 * Run `rewrapConversationForAssignee` for one conversation, at most once at a
 * time. A trigger that lands mid-run (a second reassignment, a reconnect
 * sweep) queues exactly one more pass, because the assignee — and so the set
 * of keys to seal to — may have changed since the running pass asked.
 */
export function scheduleAssigneeRewrap(hubId: string, conversationId: string): Promise<void> {
  const key = `${hubId}/${conversationId}`
  const running = inFlight.get(key)
  if (running) {
    rerunRequested.add(key)
    return running
  }

  const run = (async () => {
    try {
      do {
        rerunRequested.delete(key)
        await rewrapConversationForAssignee(hubId, conversationId)
      } while (rerunRequested.has(key))
    } catch (err) {
      reportRewrapFailure(hubId, conversationId, err)
    } finally {
      inFlight.delete(key)
      rerunRequested.delete(key)
    }
  })()
  inFlight.set(key, run)
  return run
}

/**
 * Re-wrap every active conversation in `hubId`. Conversations are visited one
 * at a time: this is background work and must not compete with the user's own
 * requests.
 */
async function sweepHub(hubId: string, cancelled: () => boolean): Promise<void> {
  for (let page = 1; !cancelled(); page++) {
    const { conversations } = await listActiveConversationsInHub(hubId, page, SWEEP_PAGE_SIZE)
    for (const conv of conversations) {
      if (cancelled()) return
      if (conv.assignedTo) await scheduleAssigneeRewrap(hubId, conv.id)
    }
    if (conversations.length < SWEEP_PAGE_SIZE) return
  }
}

/**
 * Classify a failure. Each status below is an answer the server legitimately
 * gives a re-wrapper, so none is an error to raise; anything else is.
 */
function reportRewrapFailure(hubId: string, conversationId: string | null, err: unknown): void {
  const where = conversationId ? `conversation ${conversationId} in hub ${hubId}` : `hub ${hubId}`
  if (err instanceof ApiError) {
    // 403: this user's role in THIS hub lacks read-all/update. The client's
    // permission set is account-wide, so a multi-hub user meets this in the
    // hubs where they are not an admin. It is the boundary working.
    if (err.status === 403) {
      console.debug(`[assignee-rewrap] no re-wrap authority for ${where}`)
      return
    }
    // 404: the conversation is gone. 409: it has no assignee any more. Both
    // are races with another client's write, and leave nothing to re-wrap.
    if (err.status === 404 || err.status === 409) {
      console.warn(`[assignee-rewrap] ${where} no longer needs a re-wrap (${err.status})`)
      return
    }
  }
  // Offline: the next relay reconnect sweeps again, from a fresh GET.
  if (err instanceof NetworkError || err instanceof OfflineQueuedError) {
    console.warn(`[assignee-rewrap] ${where} deferred until reconnect — ${describe(err)}`)
    return
  }
  console.error(`[assignee-rewrap] ${where} failed — ${describe(err)}`)
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * Keep every assigned conversation readable by its assignee, from this client.
 *
 * Mounted once, in the authenticated layout. Inert unless the user holds both
 * permissions the routes require; whether this DEVICE can open a given message
 * is decided per message by `rewrapMessageKey`.
 */
export function useAssigneeRewrap(): void {
  const { hasPermission } = useAuth()
  const memberHubIds = useMemberHubIds()
  const relayConnected = useRelayState() === 'connected'
  const canRewrap = REWRAP_PERMISSIONS.every(p => hasPermission(p))

  useRelaySubscriptions(memberHubIds, REWRAP_KINDS, (_kind, content, hubId) => {
    if (content.type !== 'conversation:assigned') return
    const { conversationId } = content as ConversationAssignedEvent
    if (conversationId) void scheduleAssigneeRewrap(hubId, conversationId)
  }, canRewrap)

  // Catch-up on every relay (re)connect: an assignment published while this
  // client was offline produced an event nobody here received.
  const hubKey = memberHubIds.join(',')
  useEffect(() => {
    if (!canRewrap || !relayConnected || !hubKey) return
    let cancelled = false
    void (async () => {
      for (const hubId of hubKey.split(',')) {
        if (cancelled) return
        try {
          await sweepHub(hubId, () => cancelled)
        } catch (err) {
          reportRewrapFailure(hubId, null, err)
        }
      }
    })()
    return () => { cancelled = true }
  }, [canRewrap, relayConnected, hubKey])
}

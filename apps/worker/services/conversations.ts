/**
 * ConversationsService — replaces ConversationDO.
 *
 * Manages messaging conversations, messages (individual rows, not arrays),
 * file records, contact identifiers, volunteer load, and contact summaries.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, or, desc, sql, count, isNotNull, ne, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import {
  caseRecords,
  conversations,
  messages,
  files,
  contactIdentifiers,
  devices,
  deviceVerifications,
} from '../db/schema'
import type { ConversationStatus, MessageDeliveryStatus } from '../types'
import type { IncomingMessage, MessageStatusUpdate } from '../messaging/adapter'
import type { MessagingChannelType, FileKeyEnvelope, FileOwner } from '@shared/types'
import type { RecipientEnvelope } from '@shared/types'
import { encryptMessageForStorage, encryptContactIdentifier, decryptContactIdentifier } from '../lib/crypto'
import type { HpkeRecipientPubkey } from '../lib/hpke-recipient'
import { getUserHpkeRecipients, messageReaders } from '../lib/device-recipients'
import { hpkeRecipientPubkey } from '../lib/hpke-recipient'
import { listAdminPubkeys } from '../lib/hub-admin'
import { mayRewrapHistoryTo } from '@shared/history-rewrap-gate'
import { ServiceError } from './settings'
import { createLogger } from '../lib/logger'
import {
  conversationMetadataSchema,
  type Conversation,
  type ConversationMessage,
  type ConversationMetadata,
} from '@protocol/schemas/conversations'

const logger = createLogger('services.conversations')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An inbound message for a hub whose `admin` reader set is empty: no member
 * holding the admin minimum in the hub has a registered device key, and the hub
 * has no escrow key. Nothing could seal it so that an admin can read it.
 *
 * The decision (#1034): REFUSE, visibly — never accept-and-drop. Before this,
 * the message was sealed to the instance-wide `ADMIN_DECRYPTION_PUBKEY`; on a
 * wizard deployment, where that is unset, the record was stored with no content
 * and no reader and the webhook answered 200, so the text was gone while the
 * provider believed it delivered. Refusal is the A8 rule ("zero readers is an
 * invariant violation: refuse and alert, no fallback") and matches the note
 * write guard (`assertAdminCanRead`, 503). Queueing it instead would mean
 * holding the text server-readable until a reader appeared, which the server
 * must never do (it discards inbound plaintext on receipt).
 *
 * Status 503: the webhook router releases its replay slot, so the provider's
 * redelivery is processed rather than answered as a duplicate, and the
 * provider's own delivery log keeps the message and shows the failure. It is
 * thrown before anything is written, so a refused message leaves no empty
 * conversation behind.
 *
 * The setup wizard makes this unreachable on a fresh deployment: the hub it
 * creates is founded by an admin whose device key is already registered
 * (`POST /api/setup/complete`).
 */
export class InboundUnreadableError extends ServiceError {
  constructor(readonly hubId: string) {
    super(
      503,
      "Inbound message refused: this hub has no admin able to read it. A hub admin must register a device or set the hub's escrow key",
    )
    this.name = 'InboundUnreadableError'
  }
}

export interface ConversationFilters {
  hubId: string
  status?: ConversationStatus
  assignedTo?: string
  channelType?: MessagingChannelType | 'web'
  type?: 'report' | 'conversation'
  contactHash?: string
  authorPubkey?: string
  /**
   * Restrict the list to what one member may see without
   * `conversations:read-all`: their own conversations, plus the waiting queue
   * on the channels in `waitingChannels`. An empty `waitingChannels` means no
   * waiting conversation at all — never "every channel". Applied in the same
   * WHERE as every other filter, so `total` and the page agree.
   */
  visibleTo?: { pubkey: string; waitingChannels: readonly string[] }
  limit?: number
  offset?: number
}

export interface CreateConversationInput {
  hubId: string
  channelType?: MessagingChannelType | 'web'
  contactIdentifierHash?: string
  assignedTo?: string
  status?: ConversationStatus
  metadata?: Record<string, unknown>
}

export interface UpdateConversationInput {
  status?: ConversationStatus
  assignedTo?: string | null
  metadata?: Record<string, unknown>
}

export interface AddMessageInput {
  id?: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  authorPubkey: string
  encryptedContent?: string
  readerEnvelopes?: RecipientEnvelope[]
  hasAttachments?: boolean
  attachmentIds?: string[]
  externalId?: string
  status?: MessageDeliveryStatus
  failureReason?: string
}

export interface MessagePagination {
  limit?: number
  offset?: number
}

export interface CreateFileInput {
  id: string
  /** The path hub of the upload — the file's hub. */
  hubId: string
  /** The file's parent inside `hubId` (#2462). */
  owner: FileOwner
  uploadedBy: string
  recipientEnvelopes: FileKeyEnvelope[]
  encryptedMetadata: Array<{
    pubkey: string
    encryptedContent: string
    enc: string
    ct: string
  }>
  totalSize: number
  totalChunks: number
}

/**
 * What a re-wrapping client needs to make existing messages readable by the
 * current assignee (#1512). See `ConversationsService.listAssigneeEnvelopeGaps`.
 */
/** One X25519 device key of an assignee, as the re-wrap gate sees it (#2143). */
export interface AssigneeRecipientState {
  pubkey: HpkeRecipientPubkey
  /** When the key took its current value (ISO 8601). */
  keySetAt: string
  /** A verification by the key's owner or a hub admin covers the key as it stands. */
  confirmed: boolean
}

export interface AssigneeEnvelopeGaps {
  assignedTo: string | null
  /** Every X25519 device key of the assignee, with what the re-wrap gate needs to judge it. */
  recipients: AssigneeRecipientState[]
  messages: Array<{
    id: string
    /** When the message was written — the age `recipients[].keySetAt` is judged against. */
    createdAt: string
    /** The message's existing envelopes, so the re-wrapper can open its own. */
    readerEnvelopes: RecipientEnvelope[]
    missingRecipients: HpkeRecipientPubkey[]
  }>
}

export interface ConversationStats {
  waiting: number
  active: number
  closed: number
  today: number
  total: number
}

export interface VolunteerLoadResult {
  pubkey: string
  load: number
  conversationIds: string[]
}

export interface ContactSummary {
  contactHash: string
  conversationCount: number
  reportCount: number
  firstSeen: Date
  lastSeen: Date
}

// Infer row types from the schema
type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect
type FileRow = typeof files.$inferSelect

// ---------------------------------------------------------------------------
// Wire serialization (#2118)
// ---------------------------------------------------------------------------
//
// A row is not a response. Postgres hands back `null` for every unset column
// and `Date` for timestamps; `conversationResponseSchema` and
// `messageResponseSchema` declare optional fields as ABSENT and timestamps as
// ISO strings. Returning the row let the server emit a shape its own schema
// rejects (`assignedTo: null` on every waiting conversation), so every
// conversation and message leaves the server through these two functions,
// whose return types ARE the schemas.

const CONVERSATION_STATUSES = ['active', 'waiting', 'closed'] as const satisfies readonly NonNullable<Conversation['status']>[]
const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const satisfies readonly NonNullable<ConversationMessage['direction']>[]

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value)
}

/**
 * Stored metadata, as the schema declares it. Bun's SQL driver can hand a
 * jsonb object back as its JSON text (see `list`), so the string form is
 * parsed first.
 *
 * Every write path is bound to `conversationMetadataSchema`, but a row written
 * before it was (PATCH used to accept any record) may not satisfy it. Such a
 * row is served WITHOUT its metadata and logged as an error naming the row —
 * never thrown: one bad row must not take the whole list down for every
 * member of the hub, which is what a throw here would do.
 */
function metadataResponse(rowId: string, stored: unknown): ConversationMetadata | undefined {
  if (stored === null || stored === undefined) return undefined
  let value: unknown = stored
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored)
    } catch {
      logger.error('Conversation metadata is not JSON — served without it', { conversationId: rowId })
      return undefined
    }
  }
  const parsed = conversationMetadataSchema.safeParse(value)
  if (parsed.success) return parsed.data
  logger.error('Conversation metadata does not satisfy conversationMetadataSchema — served without it', {
    conversationId: rowId,
    issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  })
  return undefined
}

export function toConversationResponse(row: ConversationRow): Conversation {
  if (!isOneOf(CONVERSATION_STATUSES, row.status)) {
    throw new Error(`conversation ${row.id} has unknown status "${row.status}"`)
  }
  const metadata = metadataResponse(row.id, row.metadata)
  return {
    id: row.id,
    channelType: row.channelType,
    contactIdentifierHash: row.contactIdentifierHash,
    ...(row.assignedTo !== null && { assignedTo: row.assignedTo }),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.lastMessageAt !== null && { lastMessageAt: row.lastMessageAt.toISOString() }),
    messageCount: row.messageCount,
    ...(metadata !== undefined && { metadata }),
  }
}

export function toMessageResponse(row: MessageRow): ConversationMessage {
  if (!isOneOf(MESSAGE_DIRECTIONS, row.direction)) {
    throw new Error(`message ${row.id} has unknown direction "${row.direction}"`)
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    ...(row.authorPubkey !== null && { authorPubkey: row.authorPubkey }),
    encryptedContent: row.encryptedContent,
    readerEnvelopes: row.readerEnvelopes as RecipientEnvelope[],
    createdAt: row.createdAt.toISOString(),
    ...(row.status !== null && { status: row.status }),
    ...(row.hasAttachments !== null && { hasAttachments: row.hasAttachments }),
    attachmentIds: row.attachmentIds,
    ...(row.deliveredAt !== null && { deliveredAt: row.deliveredAt.toISOString() }),
    ...(row.readAt !== null && { readAt: row.readAt.toISOString() }),
    ...(row.failureReason !== null && { failureReason: row.failureReason }),
    ...(row.retryCount !== null && { retryCount: row.retryCount }),
    ...(row.externalId !== null && { externalId: row.externalId }),
  }
}

/**
 * A file row read through its hub. `hub_id` / `owner_kind` are nullable in the
 * database for one expand/contract release only (the previous release never
 * names them); a row read by hub has both by construction.
 */
export type HubFileRow = FileRow & { hubId: string; ownerKind: NonNullable<FileRow['ownerKind']> }

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationsService {
  constructor(
    protected db: Database,
    protected serverKek?: string,
    protected adminPubkey?: string,
  ) {}

  // --- Conversation CRUD ---

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    const [row] = await this.db
      .insert(conversations)
      .values({
        hubId: input.hubId,
        channelType: input.channelType ?? 'web',
        contactIdentifierHash: input.contactIdentifierHash ?? '',
        assignedTo: input.assignedTo,
        status: input.status ?? 'waiting',
        metadata: input.metadata ?? null,
        lastMessageAt: new Date(),
      })
      .returning()

    return row
  }

  async getById(id: string): Promise<ConversationRow> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)

    if (!row) throw new ServiceError(404, 'Conversation not found')
    return row
  }

  /**
   * The conversation `id`, only if it belongs to `hubId`.
   *
   * A conversation of another hub is reported exactly as a missing one — one
   * query, one error — so a hub-scoped route cannot be used to learn whether an
   * id exists in a hub the caller is not a member of (#2011). Hub-scoped
   * handlers fetch through here; `getById` is for callers that already hold
   * authority over every hub (webhooks, the cleanup jobs).
   */
  async getByIdForHub(id: string, hubId: string): Promise<ConversationRow> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.hubId, hubId)))
      .limit(1)

    if (!row) throw new ServiceError(404, 'Conversation not found')
    return row
  }

  async list(filters: ConversationFilters): Promise<{ conversations: ConversationRow[]; total: number }> {
    const conditions = [eq(conversations.hubId, filters.hubId)]

    if (filters.status) {
      conditions.push(eq(conversations.status, filters.status))
    }
    if (filters.assignedTo) {
      conditions.push(eq(conversations.assignedTo, filters.assignedTo))
    }
    if (filters.channelType) {
      conditions.push(eq(conversations.channelType, filters.channelType))
    }
    if (filters.contactHash) {
      conditions.push(eq(conversations.contactIdentifierHash, filters.contactHash))
    }
    if (filters.authorPubkey) {
      conditions.push(eq(conversations.contactIdentifierHash, filters.authorPubkey))
    }
    if (filters.visibleTo) {
      const own = eq(conversations.assignedTo, filters.visibleTo.pubkey)
      const { waitingChannels } = filters.visibleTo
      conditions.push(
        waitingChannels.length === 0
          ? own
          : or(own, and(eq(conversations.status, 'waiting'), inArray(conversations.channelType, [...waitingChannels])))!,
      )
    }

    // Filter by type using metadata JSONB.
    // Drizzle bun-sql double-serializes JSONB objects in insert .values(), storing
    // them as JSON strings instead of JSONB objects (jsonb_typeof = 'string').
    // Use a helper that handles both forms: try ->>'type' first (proper JSONB),
    // then fall back to parsing the string value (double-serialized).
    if (filters.type === 'report') {
      conditions.push(sql`COALESCE(
        ${conversations.metadata}->>'type',
        CASE WHEN jsonb_typeof(${conversations.metadata}) = 'string'
          THEN (${conversations.metadata} #>> '{}')::jsonb->>'type'
          ELSE NULL
        END
      ) = 'report'`)
    } else {
      // `type: 'conversation'` and the default both exclude reports
      conditions.push(
        sql`(
          ${conversations.metadata} IS NULL
          OR COALESCE(
            ${conversations.metadata}->>'type',
            CASE WHEN jsonb_typeof(${conversations.metadata}) = 'string'
              THEN (${conversations.metadata} #>> '{}')::jsonb->>'type'
              ELSE NULL
            END
          ) IS DISTINCT FROM 'report'
        )`,
      )
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(conversations)
        .where(where)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(where),
    ])

    return { conversations: rows, total: totalRow.count }
  }

  async update(id: string, input: UpdateConversationInput): Promise<ConversationRow> {
    await this.getById(id) // throws 404 if not found
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    }
    if (input.status !== undefined) updates.status = input.status
    if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo
    if (input.metadata) {
      // Encoded by the column, never JSON.stringify'd — see the comment on
      // SettingsService.updateHubSettings for both halves of why.
      updates.metadata = sql`COALESCE(${conversations.metadata}, '{}'::jsonb) || ${conversations.metadata.mapToDriverValue(input.metadata)}::jsonb`
    }

    const [row] = await this.db
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'Conversation not found')
    return row
  }

  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id })

    if (result.length === 0) throw new ServiceError(404, 'Conversation not found')
  }

  // --- Claim (assign to volunteer) ---

  /**
   * Atomic claim (#1144). The previous implementation read the conversation,
   * checked `status !== 'waiting'` in JS, then did an UNCONDITIONAL UPDATE —
   * two concurrent claimants (two volunteers clicking "claim", or manual
   * claim racing auto-assign) both passed the check and both got a 200; the
   * later writer's UPDATE won and silently displaced the earlier volunteer
   * mid-reply. The `AND status = 'waiting'` predicate on the UPDATE itself
   * is what actually serialises this: Postgres's row lock means only one
   * concurrent claimant's UPDATE can match it, and the loser gets zero rows
   * back and a 409 instead of a false 200.
   */
  async claim(id: string, pubkey: string): Promise<ConversationRow> {
    const [row] = await this.db
      .update(conversations)
      .set({
        assignedTo: pubkey,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, id), eq(conversations.status, 'waiting')))
      .returning()

    if (!row) {
      // Distinguish "doesn't exist" (404) from "already claimed" (409) by
      // re-reading — this read is informational only, not a race guard.
      await this.getById(id)
      throw new ServiceError(409, 'Conversation is not in waiting state')
    }

    return row
  }

  // --- Assignee re-wrap (#1512) ---
  //
  // `claim()` (and an admin reassignment through `update()`) changes who the
  // assignee is, but cannot give them the messages already in the thread: each
  // message's content key was HPKE-wrapped for the readers known at write time
  // and then discarded (`encryptMessageForStorage`). An inbound message that
  // opened a `waiting` conversation has no assignee at all, so it is wrapped for
  // the platform admin alone, and the volunteer who claims it holds a thread
  // they cannot read.
  //
  // The server cannot close that gap by itself — it holds no key that opens an
  // envelope, by design. The re-wrap is client-mediated: a reader who CAN open
  // the message (an admin holding the admin decryption key) unwraps the content
  // key on their own device, HPKE-seals it to each of the assignee's registered
  // X25519 device keys under the same LABEL_MESSAGE, and submits the new
  // envelopes. The server's only part is to say which envelopes are missing and
  // to append the submitted ones — never to replace or remove an existing
  // reader, and never to accept a recipient that is not the current assignee.

  /** Most messages a single gap listing returns; the client loops until empty. */
  static readonly ASSIGNEE_GAP_PAGE = 200

  /**
   * The assignee's X25519 device keys, each with the facts the re-wrap gate
   * needs: when the key last took its current value, and whether a device
   * verification covers it as it stands (#2143, PROTOCOL.md §2.4.1 "Trust").
   *
   * "Confirmed" means a `device_verifications` row for that device, recorded
   * by the key's owner or by an admin of the conversation's hub (operator
   * decision A13), at or after the moment the key took its current value and
   * against the device's current signing key. A verification that predates a
   * key overwrite says nothing about the new key, so it does not count.
   *
   * Two devices carrying the same key collapse to one entry, judged by the
   * stricter of the two: the newer `keySetAt`, and confirmed only if both are.
   */
  private async loadAssigneeRecipients(
    assignedTo: string,
    hubId: string,
  ): Promise<AssigneeRecipientState[]> {
    const rows = await this.db
      .select({
        id: devices.id,
        ed25519Pubkey: devices.ed25519Pubkey,
        x25519Pubkey: devices.x25519Pubkey,
        x25519SetAt: devices.x25519SetAt,
      })
      .from(devices)
      .where(and(eq(devices.pubkey, assignedTo), isNotNull(devices.x25519Pubkey)))
    if (rows.length === 0) return []

    const verifiers = new Set<string>([assignedTo, ...await listAdminPubkeys(this.db, hubId)])
    const verifications = await this.db
      .select({
        targetDeviceId: deviceVerifications.targetDeviceId,
        targetPubkey: deviceVerifications.targetPubkey,
        verifierPubkey: deviceVerifications.verifierPubkey,
        verifiedAt: deviceVerifications.verifiedAt,
      })
      .from(deviceVerifications)
      .where(inArray(deviceVerifications.targetDeviceId, rows.map((r) => r.id)))

    const byKey = new Map<HpkeRecipientPubkey, { keySetAt: Date; confirmed: boolean }>()
    for (const row of rows) {
      const pubkey = hpkeRecipientPubkey(row.x25519Pubkey)
      if (!pubkey) continue
      const confirmed =
        row.ed25519Pubkey !== null &&
        verifications.some(
          (v) =>
            v.targetDeviceId === row.id &&
            v.targetPubkey === row.ed25519Pubkey &&
            verifiers.has(v.verifierPubkey) &&
            v.verifiedAt.getTime() >= row.x25519SetAt.getTime(),
        )
      const seen = byKey.get(pubkey)
      byKey.set(
        pubkey,
        seen
          ? {
              keySetAt: seen.keySetAt.getTime() >= row.x25519SetAt.getTime() ? seen.keySetAt : row.x25519SetAt,
              confirmed: seen.confirmed && confirmed,
            }
          : { keySetAt: row.x25519SetAt, confirmed },
      )
    }
    return [...byKey].map(([pubkey, { keySetAt, confirmed }]) => ({
      pubkey,
      keySetAt: keySetAt.toISOString(),
      confirmed,
    }))
  }

  /**
   * Messages in the conversation that lack an envelope for at least one of the
   * current assignee's registered device keys AND may be re-wrapped to it,
   * oldest first, plus the assignee's device keys with the gate's inputs.
   *
   * A key set after a message was written, and not confirmed, is not a gap for
   * that message (`mayRewrapHistoryTo`; #2143). It is still listed in the
   * message's `missingRecipients` when the message has some other permitted
   * gap, so the re-wrapping client sees it and applies the gate itself. A
   * message whose every missing key is withheld is left out of the page
   * entirely: oldest-first paging would otherwise fill with messages the client
   * must skip, and never reach the newer ones it may re-wrap.
   *
   * Messages with NO envelopes are excluded: they are the deliberately
   * unreadable records `handleIncoming` stores when no reader existed at all,
   * and no client holds a key that could re-wrap them.
   */
  async listAssigneeEnvelopeGaps(conversationId: string): Promise<AssigneeEnvelopeGaps> {
    const conv = await this.getById(conversationId)
    if (!conv.assignedTo) return { assignedTo: null, recipients: [], messages: [] }

    const recipients = await this.loadAssigneeRecipients(conv.assignedTo, conv.hubId)
    if (recipients.length === 0) return { assignedTo: conv.assignedTo, recipients, messages: [] }

    const rows = await this.db
      .select({ id: messages.id, createdAt: messages.createdAt, readerEnvelopes: messages.readerEnvelopes })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt, messages.id)

    const gaps: AssigneeEnvelopeGaps['messages'] = []
    for (const row of rows) {
      const readerEnvelopes = row.readerEnvelopes as RecipientEnvelope[]
      if (readerEnvelopes.length === 0) continue
      const present = new Set(readerEnvelopes.map((e) => e.pubkey))
      const missing = recipients.filter((r) => !present.has(r.pubkey))
      if (!missing.some((r) => mayRewrapHistoryTo(r, row.createdAt))) continue
      gaps.push({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        readerEnvelopes,
        missingRecipients: missing.map((r) => r.pubkey),
      })
      if (gaps.length >= ConversationsService.ASSIGNEE_GAP_PAGE) break
    }

    return { assignedTo: conv.assignedTo, recipients, messages: gaps }
  }

  /**
   * Append client-produced envelopes that make existing messages readable by
   * the current assignee. Append-only: an envelope whose recipient already has
   * one on that message is ignored, and no existing reader is ever replaced or
   * dropped.
   *
   * Every envelope must name one of the CURRENT assignee's registered X25519
   * device keys, and must not name a key set after its message was written
   * unless that key is confirmed (#2143). The client already withholds those
   * (`mayRewrapHistoryTo`); refusing them here too is defence in depth against a
   * session that submits envelopes directly, and it is no more than that: the
   * timestamps and confirmations are the server's own claims. The conversation row is locked for the duration, so a
   * reassignment cannot land between the recipient check and the write and
   * leave the previous assignee holding envelopes on messages they no longer
   * own. Rejecting the whole batch on one bad entry is deliberate: a partial
   * write would leave the client unable to tell which half landed.
   *
   * First write wins, on purpose. The server cannot open an envelope, so it
   * cannot tell a correct re-wrap from a wrong one; letting a later submission
   * replace an earlier one would let any holder of this authority overwrite a
   * working envelope — including one the server itself sealed at arrival — with
   * garbage. A wrong envelope therefore stays wrong for that device key; the
   * recovery is a new device key, which reopens the gap for re-wrapping.
   */
  async addAssigneeEnvelopes(
    conversationId: string,
    entries: ReadonlyArray<{ messageId: string; envelope: RecipientEnvelope }>,
  ): Promise<{ added: number; assignedTo: string }> {
    return this.db.transaction(async (tx) => {
      const [conv] = await tx
        .select({ assignedTo: conversations.assignedTo, hubId: conversations.hubId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update')
      if (!conv) throw new ServiceError(404, 'Conversation not found')
      if (!conv.assignedTo) throw new ServiceError(409, 'Conversation has no assignee')

      const recipients = new Map(
        (await this.loadAssigneeRecipients(conv.assignedTo, conv.hubId)).map((r) => [r.pubkey as string, r]),
      )
      for (const { envelope } of entries) {
        if (!recipients.has(envelope.pubkey)) {
          throw new ServiceError(400, 'Envelope recipient is not a registered device key of the conversation assignee')
        }
      }

      const messageIds = [...new Set(entries.map((e) => e.messageId))]
      const rows = await tx
        .select({ id: messages.id, createdAt: messages.createdAt, readerEnvelopes: messages.readerEnvelopes })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, messageIds)))
        .for('update')
      if (rows.length !== messageIds.length) {
        throw new ServiceError(404, 'Message not found in conversation')
      }

      const createdAtById = new Map(rows.map((r) => [r.id, r.createdAt]))
      for (const { messageId, envelope } of entries) {
        const recipient = recipients.get(envelope.pubkey)
        const createdAt = createdAtById.get(messageId)
        // Both lookups succeed here — membership and message existence were
        // checked above — and a miss would mean the gate cannot be evaluated,
        // which refuses rather than writes.
        if (!recipient || !createdAt || !mayRewrapHistoryTo(recipient, createdAt)) {
          throw new ServiceError(
            400,
            `Envelope recipient key was set after message ${messageId} was written and has not been confirmed`,
          )
        }
      }

      const byId = new Map(rows.map((r) => [r.id, [...(r.readerEnvelopes as RecipientEnvelope[])]]))
      for (const [id, envelopes] of byId) {
        if (envelopes.length === 0) {
          throw new ServiceError(409, `Message ${id} has no readers; there is no content key to re-wrap`)
        }
      }

      const changed = new Set<string>()
      let added = 0
      for (const { messageId, envelope } of entries) {
        const envelopes = byId.get(messageId)!
        if (envelopes.some((e) => e.pubkey === envelope.pubkey)) continue
        envelopes.push({ pubkey: envelope.pubkey, enc: envelope.enc, ct: envelope.ct })
        changed.add(messageId)
        added++
      }

      for (const id of changed) {
        await tx
          .update(messages)
          .set({ readerEnvelopes: byId.get(id)! })
          .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)))
      }

      return { added, assignedTo: conv.assignedTo }
    })
  }

  // --- Messages ---

  async addMessage(input: AddMessageInput): Promise<MessageRow> {
    // Verify conversation exists (throws 404 if not found)
    await this.getById(input.conversationId)

    // Atomic pair (#1144): the increment itself (`messageCount + 1`) is
    // SQL-atomic, but the insert-then-update pair was not — a failure
    // between the two statements left messageCount permanently drifted
    // from the actual row count. Wrapping both in one transaction makes
    // the pair all-or-nothing.
    const [msg] = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          id: input.id ?? undefined,
          conversationId: input.conversationId,
          direction: input.direction,
          authorPubkey: input.authorPubkey,
          encryptedContent: input.encryptedContent ?? '',
          readerEnvelopes: input.readerEnvelopes,
          hasAttachments: input.hasAttachments ?? false,
          attachmentIds: input.attachmentIds,
          externalId: input.externalId,
          status: input.direction === 'outbound' ? (input.status ?? 'pending') : (input.status ?? 'sent'),
          failureReason: input.failureReason,
        })
        .returning()

      // Update conversation timestamps and count
      await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          messageCount: sql`${conversations.messageCount} + 1`,
        })
        .where(eq(conversations.id, input.conversationId))

      return [inserted]
    })

    return msg
  }

  async listMessages(
    conversationId: string,
    pagination: MessagePagination = {},
  ): Promise<{ messages: MessageRow[]; total: number }> {
    const limit = pagination.limit ?? 50
    const offset = pagination.offset ?? 0

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
    ])

    return { messages: rows, total: totalRow.count }
  }

  async updateMessageStatus(
    update: MessageStatusUpdate,
  ): Promise<{ conversationId: string; messageId: string; status: string } | { found: false }> {
    // Status rank, used to guard against moving status backwards.
    const statusOrder: Record<string, number> = {
      pending: 0,
      sent: 1,
      delivered: 2,
      read: 3,
      failed: 3,
    }
    const newOrder = statusOrder[update.status]

    const updateFields: Record<string, unknown> = {
      status: update.status,
    }

    if (update.status === 'delivered') {
      updateFields.deliveredAt = new Date(update.timestamp)
    } else if (update.status === 'read') {
      updateFields.readAt = new Date(update.timestamp)
      // Backfill from the row's CURRENT value via COALESCE, not a value
      // read earlier in JS — only fills deliveredAt in if it's still unset.
      updateFields.deliveredAt = sql`COALESCE(${messages.deliveredAt}, ${new Date(update.timestamp)})`
    } else if (update.status === 'failed') {
      updateFields.failureReason = update.failureReason
    }

    // Atomic status-advance guard (#1144). The previous implementation
    // read the message, computed `newOrder <= currentOrder` in JS, then
    // did an UNCONDITIONAL UPDATE. Two delivery-receipt callbacks
    // (`delivered` and `read`) racing on the same message both read
    // `status = 'sent'`, both pass the check, and whichever UPDATE commits
    // last wins — so a message can end up at `delivered` after it was
    // already `read`. The CASE expression below is evaluated against the
    // row this UPDATE just locked, so the loser of the race affects zero
    // rows instead of regressing the status.
    const rankGuard = update.status === 'failed'
      ? sql`true`
      : sql`(CASE ${messages.status}
          WHEN 'pending' THEN 0
          WHEN 'sent' THEN 1
          WHEN 'delivered' THEN 2
          WHEN 'read' THEN 3
          WHEN 'failed' THEN 3
          ELSE 0
        END) < ${newOrder}`

    const [row] = await this.db
      .update(messages)
      .set(updateFields)
      .where(and(eq(messages.externalId, update.externalId), rankGuard))
      .returning()

    if (row) {
      return { conversationId: row.conversationId, messageId: row.id, status: row.status ?? update.status }
    }

    // Either the message doesn't exist, or the status didn't advance.
    // Both need the current row to answer correctly.
    const [existing] = await this.db
      .select()
      .from(messages)
      .where(eq(messages.externalId, update.externalId))
      .limit(1)

    if (!existing) return { found: false }
    return { conversationId: existing.conversationId, messageId: existing.id, status: existing.status ?? 'pending' }
  }

  // --- External ID lookup ---

  async getByExternalId(
    externalId: string,
  ): Promise<{ conversationId: string; messageId: string } | null> {
    const [msg] = await this.db
      .select({
        conversationId: messages.conversationId,
        messageId: messages.id,
      })
      .from(messages)
      .where(eq(messages.externalId, externalId))
      .limit(1)

    return msg ?? null
  }

  // --- Inbound message processing ---

  async handleIncoming(
    incoming: IncomingMessage,
    /**
     * The thread identity of `incoming.senderIdentifier`: `messagingContactHash`,
     * computed once by the caller (the messaging router, or the dev simulation)
     * with the same hub id passed below. No adapter hashes, so a message can
     * never be filed under a hash its own hub's key did not produce.
     */
    contactHash: string,
    /**
     * The hub's `admin` reader set — `readersFor(hubId, 'admin')`, resolved by
     * the caller before it acts on the message so a refusal happens ahead of
     * every side effect. Branded, so an Ed25519 auth key cannot be supplied by
     * mistake (#1283). Never the instance-wide `ADMIN_DECRYPTION_PUBKEY`: the
     * platform operator is not a reader of hub content (D1, #1034).
     */
    adminReaders: readonly HpkeRecipientPubkey[],
    /** The hub the webhook URL named; the router refuses a message that names none (#2395). */
    hubId: string,
  ): Promise<{
    conversationId: string
    messageId: string
    isNew: boolean
    status: string
  }> {
    if (!this.serverKek) {
      throw new ServiceError(500, 'Server KEK not configured')
    }
    // Refused BEFORE anything is written: no conversation stub, no contact
    // identifier, no empty message row. See `InboundUnreadableError`.
    if (adminReaders.length === 0) throw new InboundUnreadableError(hubId)

    // Find this sender's existing conversation on this channel, in this hub.
    const whereConditions = [
      eq(conversations.hubId, hubId),
      eq(conversations.channelType, incoming.channelType),
      eq(conversations.contactIdentifierHash, contactHash),
      sql`${conversations.status} IN ('active', 'waiting', 'closed')`,
    ]

    const [existingConv] = await this.db
      .select()
      .from(conversations)
      .where(and(...whereConditions))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)

    let conv: ConversationRow
    let isNew = false

    if (existingConv) {
      conv = existingConv
      // Reopen closed conversations when a new message arrives
      if (conv.status === 'closed') {
        const [updated] = await this.db
          .update(conversations)
          .set({ status: 'waiting', updatedAt: new Date(), lastMessageAt: new Date() })
          .where(eq(conversations.id, conv.id))
          .returning()
        conv = updated
      }
    } else {
      // Create new conversation
      const [created] = await this.db
        .insert(conversations)
        .values({
          hubId,
          channelType: incoming.channelType,
          contactIdentifierHash: contactHash,
          status: 'waiting',
          lastMessageAt: new Date(),
        })
        .returning()

      conv = created
      isNew = true

      // Store encrypted contact identifier for outbound sends
      await this.setContactIdentifier(
        conv.id,
        encryptContactIdentifier(incoming.senderIdentifier, this.serverKek),
      )
    }

    // Sealed to the hub's admin readers and the assignee's devices.
    //
    // #1021: `conversations.assigned_to` holds the assignee's Ed25519 *identity*
    // pubkey — the key that signs their auth tokens (see `claim()` and
    // `POST /conversations/:id/claim`, which store `c.get('pubkey')`). Sealing
    // to it produced a well-formed envelope that nobody can open: DHKEM(X25519)
    // accepts any 32 bytes, so it neither threw nor warned. This is the same
    // defect as #1283, at a second site.
    //
    // `devices.x25519_pubkey` is the one column that can supply a real HPKE
    // recipient for a user, and the desktop now populates it on unlock
    // (`src/client/lib/device-registration.ts`). `getUserHpkeRecipients` is the
    // only path from a user id to that key, and the branded type below makes
    // re-adding a non-X25519 key a compile error rather than silent, permanent
    // data loss.
    const assigneeRecipients = conv.assignedTo
      ? await getUserHpkeRecipients(this.db, conv.assignedTo)
      : []
    if (conv.assignedTo && assigneeRecipients.length === 0) {
      // Never silent: the assigned volunteer will not be able to read this
      // message, and the only way they ever will is by registering a device.
      // The hub's admins can, and can relay it.
      logger.error('assigned volunteer has no X25519 device key; inbound message is readable by hub admins only', {
        conversationId: conv.id,
      })
    }
    const encrypted = encryptMessageForStorage(
      incoming.body ?? '',
      messageReaders(adminReaders, assigneeRecipients),
    )

    const msg = await this.addMessage({
      conversationId: conv.id,
      direction: 'inbound',
      authorPubkey: 'system:inbound',
      encryptedContent: encrypted.encryptedContent,
      readerEnvelopes: encrypted.readerEnvelopes,
      hasAttachments: !!(incoming.mediaUrls && incoming.mediaUrls.length > 0),
      externalId: incoming.externalId,
    })

    return {
      conversationId: conv.id,
      messageId: msg.id,
      isNew,
      status: conv.status,
    }
  }

  // --- Contact identifier ---

  async setContactIdentifier(conversationId: string, encrypted: string): Promise<void> {
    await this.db
      .insert(contactIdentifiers)
      .values({
        conversationId,
        encryptedIdentifier: encrypted,
      })
      .onConflictDoUpdate({
        target: contactIdentifiers.conversationId,
        set: { encryptedIdentifier: encrypted },
      })
  }

  async getContactIdentifier(conversationId: string): Promise<string> {
    if (!this.serverKek) {
      throw new ServiceError(500, 'Server KEK not configured')
    }

    const [row] = await this.db
      .select()
      .from(contactIdentifiers)
      .where(eq(contactIdentifiers.conversationId, conversationId))
      .limit(1)

    if (!row) throw new ServiceError(404, 'No contact identifier stored')

    const identifier = decryptContactIdentifier(row.encryptedIdentifier, this.serverKek)

    return identifier
  }

  // --- File management ---

  /**
   * Record a new upload. The owner must exist inside `input.hubId`: the
   * composite (parent id, hub_id) foreign keys refuse anything else, and this
   * check turns that refusal into the same 404 a missing parent gets, so a
   * parent of another hub is indistinguishable from one that does not exist.
   */
  async createFile(input: CreateFileInput): Promise<HubFileRow> {
    const { owner, hubId } = input
    if (owner.kind === 'conversation') {
      const [parent] = await this.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, owner.conversationId), eq(conversations.hubId, hubId)))
        .limit(1)
      if (!parent) throw new ServiceError(404, 'Conversation not found')
    } else if (owner.kind === 'case_record') {
      const [parent] = await this.db
        .select({ id: caseRecords.id })
        .from(caseRecords)
        .where(and(eq(caseRecords.id, owner.caseRecordId), eq(caseRecords.hubId, hubId)))
        .limit(1)
      if (!parent) throw new ServiceError(404, 'Case record not found')
    }

    const [row] = await this.db
      .insert(files)
      .values({
        id: input.id,
        hubId,
        ownerKind: owner.kind,
        conversationId: owner.kind === 'conversation' ? owner.conversationId : null,
        caseRecordId: owner.kind === 'case_record' ? owner.caseRecordId : null,
        uploadedBy: input.uploadedBy,
        recipientEnvelopes: input.recipientEnvelopes,
        encryptedMetadata: input.encryptedMetadata,
        totalSize: input.totalSize,
        totalChunks: input.totalChunks,
        completedChunks: 0,
        status: 'uploading',
      })
      .returning()

    return inHub(row, hubId)
  }

  /**
   * A file of `hubId`. A file of another hub — or one with no hub — answers
   * exactly like a missing one, so nothing outside the hub learns it exists.
   */
  async getFileInHub(id: string, hubId: string): Promise<HubFileRow> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.hubId, hubId)))
      .limit(1)

    if (!row) throw new ServiceError(404, 'File not found')
    return inHub(row, hubId)
  }

  /**
   * The file a case record's evidence entry names: it must have been uploaded
   * TO that case record (#2462). Its hub is the record's hub — the composite
   * (case_record_id, hub_id) foreign key admits nothing else.
   */
  async getCaseRecordFile(id: string, caseRecordId: string): Promise<HubFileRow> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(
        eq(files.id, id),
        eq(files.ownerKind, 'case_record'),
        eq(files.caseRecordId, caseRecordId),
      ))
      .limit(1)

    if (!row || row.hubId === null) throw new ServiceError(404, 'File not found')
    return inHub(row, row.hubId)
  }

  async markChunkComplete(id: string): Promise<FileRow> {
    const [row] = await this.db
      .update(files)
      .set({
        completedChunks: sql`${files.completedChunks} + 1`,
      })
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  /** Mark an upload complete; returns the completion time it recorded. */
  async markFileComplete(id: string): Promise<Date> {
    const completedAt = new Date()
    const [row] = await this.db
      .update(files)
      .set({ status: 'complete', completedAt })
      .where(eq(files.id, id))
      .returning({ id: files.id })

    if (!row) throw new ServiceError(404, 'File not found')
    return completedAt
  }

  async addFileRecipient(
    id: string,
    envelope: FileKeyEnvelope,
    encryptedMetadata: { pubkey: string; encryptedContent: string; enc: string; ct: string },
  ): Promise<FileRow> {
    // Use JSONB append to add envelope and metadata atomically.
    //
    // The JSON payloads go through `(...)::text::jsonb`, not `...::jsonb`.
    // Binding a JS *string* straight to a jsonb parameter position reaches
    // Postgres double-encoded — a jsonb *string scalar* — so the append wrote
    // a quoted string into the array instead of an object. The `elem->>'pubkey'`
    // dedupe guard right above could then never see it (a string element has no
    // keys), so grants duplicated, and the granted user could not find their own
    // envelope. Casting the parameter to text first makes Postgres parse it.
    // See the same warning in identity.ts and erasure.ts.
    const [row] = await this.db
      .update(files)
      .set({
        recipientEnvelopes: sql`(
          CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(${files.recipientEnvelopes}) elem
              WHERE elem->>'pubkey' = ${envelope.pubkey}
            )
            THEN ${files.recipientEnvelopes} || (${JSON.stringify(envelope)})::text::jsonb
            ELSE ${files.recipientEnvelopes}
          END
        )`,
        encryptedMetadata: sql`(
          CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(${files.encryptedMetadata}) elem
              WHERE elem->>'pubkey' = ${encryptedMetadata.pubkey}
            )
            THEN ${files.encryptedMetadata} || (${JSON.stringify(encryptedMetadata)})::text::jsonb
            ELSE ${files.encryptedMetadata}
          END
        )`,
      })
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  /** The completed attachments of one conversation of `hubId`. */
  async listConversationFiles(conversationId: string, hubId: string): Promise<HubFileRow[]> {
    const rows = await this.db
      .select()
      .from(files)
      .where(and(
        eq(files.status, 'complete'),
        eq(files.hubId, hubId),
        eq(files.ownerKind, 'conversation'),
        eq(files.conversationId, conversationId),
      ))
      .orderBy(desc(files.createdAt))
    return rows.map(row => inHub(row, hubId))
  }

  // --- Volunteer load ---

  async getVolunteerLoad(pubkey: string, hubId?: string): Promise<VolunteerLoadResult> {
    const conditions = [
      eq(conversations.assignedTo, pubkey),
      ne(conversations.status, 'closed'),
    ]
    if (hubId) {
      conditions.push(eq(conversations.hubId, hubId))
    }

    const rows = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(...conditions))

    return {
      pubkey,
      load: rows.length,
      conversationIds: rows.map((r) => r.id),
    }
  }

  async getAllVolunteerLoads(hubId?: string): Promise<Record<string, number>> {
    const conditions = [
      isNotNull(conversations.assignedTo),
      ne(conversations.status, 'closed'),
    ]
    if (hubId) {
      conditions.push(eq(conversations.hubId, hubId))
    }

    const rows = await this.db
      .select({
        assignedTo: conversations.assignedTo,
        count: count(),
      })
      .from(conversations)
      .where(and(...conditions))
      .groupBy(conversations.assignedTo)

    const loads: Record<string, number> = {}
    for (const row of rows) {
      if (row.assignedTo) {
        loads[row.assignedTo] = row.count
      }
    }
    return loads
  }

  // --- Stats ---

  /** One hub's conversation counts. There is no deployment-wide variant (#2381). */
  async getStats(hubId: string): Promise<ConversationStats> {
    const baseCondition = sql`(${conversations.metadata} IS NULL OR ${conversations.metadata}->>'type' IS NULL OR ${conversations.metadata}->>'type' != 'report')`
    const hubCondition = and(baseCondition, eq(conversations.hubId, hubId))

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const [statusCounts, [todayRow], [totalRow]] = await Promise.all([
      this.db
        .select({
          status: conversations.status,
          count: count(),
        })
        .from(conversations)
        .where(hubCondition)
        .groupBy(conversations.status),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(and(hubCondition, sql`${conversations.createdAt} >= ${todayStart}`)),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(hubCondition),
    ])

    const byStatus: Record<string, number> = {}
    for (const row of statusCounts) {
      byStatus[row.status] = row.count
    }

    return {
      waiting: byStatus.waiting ?? 0,
      active: byStatus.active ?? 0,
      closed: byStatus.closed ?? 0,
      today: todayRow.count,
      total: totalRow.count,
    }
  }

  // --- Contacts ---

  async getContactSummaries(hubId: string): Promise<ContactSummary[]> {
    const conditions = [
      eq(conversations.hubId, hubId),
      ne(conversations.contactIdentifierHash, ''),
    ]

    const rows = await this.db
      .select({
        contactHash: conversations.contactIdentifierHash,
        conversationCount: sql<number>`COUNT(*) FILTER (WHERE ${conversations.metadata} IS NULL OR ${conversations.metadata}->>'type' IS NULL OR ${conversations.metadata}->>'type' != 'report')`,
        reportCount: sql<number>`COUNT(*) FILTER (WHERE ${conversations.metadata}->>'type' = 'report')`,
        firstSeen: sql<Date>`MIN(${conversations.createdAt})`,
        lastSeen: sql<Date>`MAX(COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}))`,
      })
      .from(conversations)
      .where(and(...conditions))
      .groupBy(conversations.contactIdentifierHash)
      .orderBy(sql`MAX(COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})) DESC`)

    return rows.map((r) => ({
      contactHash: r.contactHash,
      conversationCount: Number(r.conversationCount),
      reportCount: Number(r.reportCount),
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))
  }

  /**
   * Every conversation with `contactHash`, within `hubId`. The hash is a blind
   * index, equal across hubs for the same caller, so an unbounded lookup would
   * stitch one caller's contact history together across hubs that must not know
   * of each other — there is no hubless form (#2395, #2459).
   */
  async getContactConversations(contactHash: string, hubId: string): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.contactIdentifierHash, contactHash), eq(conversations.hubId, hubId)))
      .orderBy(desc(conversations.lastMessageAt))
  }

  // --- Auto-close inactive conversations ---

  async autoCloseInactive(timeoutMs: number = 60 * 60 * 1000): Promise<string[]> {
    const cutoff = new Date(Date.now() - timeoutMs)

    const closed = await this.db
      .update(conversations)
      .set({
        status: 'closed',
        updatedAt: new Date(),
      })
      .where(
        and(
          sql`${conversations.status} IN ('active', 'waiting')`,
          sql`${conversations.lastMessageAt} < ${cutoff}`,
        ),
      )
      .returning({ id: conversations.id, assignedTo: conversations.assignedTo })

    return closed.filter((r) => r.assignedTo).map((r) => r.assignedTo!)
  }

  // --- Cleanup stale file uploads ---

  async cleanupStaleFiles(staleTTLMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleTTLMs)

    const deleted = await this.db
      .delete(files)
      .where(
        and(
          eq(files.status, 'uploading'),
          sql`${files.createdAt} < ${cutoff}`,
        ),
      )
      .returning({ id: files.id })

    return deleted.length
  }

  // --- Reset (the secret-gated dev surface only) ---

  async reset(): Promise<void> {
    await this.db.delete(contactIdentifiers)
    await this.db.delete(files)
    await this.db.delete(messages)
    await this.db.delete(conversations)
  }
}

/** Narrow a row the query already bound to `hubId`; anything else is a server bug. */
function inHub(row: FileRow | undefined, hubId: string): HubFileRow {
  if (!row || row.hubId !== hubId || row.ownerKind === null) {
    throw new ServiceError(500, 'File row is not bound to its hub')
  }
  return { ...row, hubId: row.hubId, ownerKind: row.ownerKind }
}

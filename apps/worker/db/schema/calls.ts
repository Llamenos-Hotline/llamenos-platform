/**
 * Calls domain tables: active calls, encrypted call history records,
 * and single-use call tokens for secure telephony callback resolution.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'

// ---------------------------------------------------------------------------
// active_calls
// ---------------------------------------------------------------------------

export const activeCalls = pgTable(
  'active_calls',
  {
    callId: text('call_id').primaryKey(),
    hubId: text('hub_id'),
    // The caller's number, sealed with SERVER_KEK and bound to `call_id`, held only so
    // the answering volunteer can ban a live caller without ever seeing the digits.
    // No hash of the number is kept. NULL once the call has ended or been archived.
    callerNumberSealed: text('caller_number_sealed'),
    callerLast4: text('caller_last4'),
    answeredBy: text('answered_by'),
    status: text('status').notNull().default('ringing'),
    hasTranscription: boolean('has_transcription').default(false),
    hasVoicemail: boolean('has_voicemail').default(false),
    hasRecording: boolean('has_recording').default(false),
    recordingSid: text('recording_sid'),
    reportedBy: text('reported_by'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    duration: integer('duration'),
  },
  (table) => [
    index('active_calls_hub_id_status_idx').on(table.hubId, table.status),
    index('active_calls_started_at_idx').on(table.startedAt.desc()),
  ],
)

// ---------------------------------------------------------------------------
// call_records
// ---------------------------------------------------------------------------

export const callRecords = pgTable(
  'call_records',
  {
    callId: text('call_id').primaryKey(),
    hubId: text('hub_id'),
    callerLast4: text('caller_last4'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    duration: integer('duration'),
    answeredBy: text('answered_by'),
    status: text('status').notNull(),
    hasTranscription: boolean('has_transcription').default(false),
    hasVoicemail: boolean('has_voicemail').default(false),
    hasRecording: boolean('has_recording').default(false),
    recordingSid: text('recording_sid'),
    encryptedContent: text('encrypted_content').notNull(),
    adminEnvelopes: jsonb('admin_envelopes').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('call_records_hub_id_idx').on(table.hubId),
    index('call_records_started_at_idx').on(table.startedAt.desc()),
  ],
)

// ---------------------------------------------------------------------------
// call_tokens — CRIT-W2: Opaque single-use tokens replacing pubkey in callback URLs
// ---------------------------------------------------------------------------

export const callTokens = pgTable(
  'call_tokens',
  {
    token: text('token').primaryKey(),
    callSid: text('call_sid').notNull(),
    volunteerPubkey: text('volunteer_pubkey').notNull(),
    hubId: text('hub_id').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('call_tokens_call_sid_idx').on(table.callSid),
    index('call_tokens_created_at_idx').on(table.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// provider_recordings — #2297: caller audio the telephony provider still holds
// ---------------------------------------------------------------------------

/**
 * One row per recording this server asked the provider to make, for as long as
 * the provider may still hold it. A row is deleted ONLY when the provider has
 * confirmed the deletion (`TelephonyAdapter.deleteRecording` resolved) — so the
 * table is the server's record of caller audio sitting outside the E2EE
 * boundary, and a refused deletion stays here, visible and retried, instead of
 * being forgotten.
 *
 * `recording_sid` is the adapter's handle from `parseRecordingWebhook`; it is
 * opaque here and only ever handed back to the same hub's adapter.
 */
export const providerRecordings = pgTable(
  'provider_recordings',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull().default(''),
    callId: text('call_id').notNull(),
    recordingSid: text('recording_sid').notNull(),
    /** 'voicemail' — deleted as soon as fetched; 'call' — opted-in call recording, kept for playback until the call record goes. */
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('provider_recordings_hub_recording_idx').on(table.hubId, table.recordingSid),
    index('provider_recordings_call_idx').on(table.callId),
    index('provider_recordings_kind_created_idx').on(table.kind, table.createdAt),
  ],
)

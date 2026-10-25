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

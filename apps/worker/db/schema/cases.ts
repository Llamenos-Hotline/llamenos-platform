/**
 * Cases domain tables: E2EE case management, events, linking tables,
 * interactions, evidence, and chain-of-custody.
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { files } from './conversations'

// ---------------------------------------------------------------------------
// case_records
// ---------------------------------------------------------------------------

export const caseRecords = pgTable(
  'case_records',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    entityTypeId: text('entity_type_id'),
    caseNumber: text('case_number'),
    statusHash: text('status_hash').notNull(),
    severityHash: text('severity_hash'),
    categoryHash: text('category_hash'),
    assignedTo: text('assigned_to')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    blindIndexes: jsonb('blind_indexes').notNull().default({}),
    encryptedSummary: text('encrypted_summary'),
    summaryEnvelopes: jsonb('summary_envelopes').notNull().default([]),
    encryptedFields: text('encrypted_fields'),
    fieldEnvelopes: jsonb('field_envelopes'),
    encryptedPii: text('encrypted_pii'),
    piiEnvelopes: jsonb('pii_envelopes'),
    contactCount: integer('contact_count').notNull().default(0),
    interactionCount: integer('interaction_count').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    eventIds: text('event_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reportIds: text('report_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    parentRecordId: text('parent_record_id'),
    mergedIntoId: text('merged_into_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('case_records_hub_id_idx').on(table.hubId),
    index('case_records_hub_id_status_hash_idx').on(
      table.hubId,
      table.statusHash,
    ),
    index('case_records_hub_id_severity_hash_idx').on(
      table.hubId,
      table.severityHash,
    ),
    index('case_records_entity_type_id_idx').on(table.entityTypeId),
    uniqueIndex('case_records_hub_id_case_number_idx')
      .on(table.hubId, table.caseNumber)
      .where(sql`case_number IS NOT NULL`),
    index('case_records_assigned_to_idx').using('gin', table.assignedTo),
    index('case_records_hub_id_category_hash_idx').on(
      table.hubId,
      table.categoryHash,
    ),
    // The target of files' (case_record_id, hub_id) foreign key: a file can
    // only name a case record of its own hub. `id` is the primary key, so the
    // pair is unique by construction.
    unique('case_records_id_hub_id_unique').on(table.id, table.hubId),
  ],
)

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    entityTypeId: text('entity_type_id'),
    caseNumber: text('case_number'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    parentEventId: text('parent_event_id'),
    locationPrecision: text('location_precision').default('neighborhood'),
    locationApproximate: text('location_approximate'),
    eventTypeHash: text('event_type_hash').notNull(),
    statusHash: text('status_hash').notNull(),
    blindIndexes: jsonb('blind_indexes').notNull().default({}),
    encryptedDetails: text('encrypted_details'),
    detailEnvelopes: jsonb('detail_envelopes').notNull().default([]),
    caseCount: integer('case_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    subEventCount: integer('sub_event_count').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  },
  (table) => [
    index('events_hub_id_idx').on(table.hubId),
    index('events_parent_event_id_idx').on(table.parentEventId),
    index('events_hub_id_status_hash_idx').on(table.hubId, table.statusHash),
  ],
)

// ---------------------------------------------------------------------------
// case_contacts (join table)
// ---------------------------------------------------------------------------

export const caseContacts = pgTable(
  'case_contacts',
  {
    caseId: text('case_id').notNull(),
    contactId: text('contact_id').notNull(),
    role: text('role'),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    addedBy: text('added_by').notNull(),
  },
  (table) => [primaryKey({ columns: [table.caseId, table.contactId] })],
)

// ---------------------------------------------------------------------------
// case_events (join table)
// ---------------------------------------------------------------------------

export const caseEvents = pgTable(
  'case_events',
  {
    caseId: text('case_id').notNull(),
    eventId: text('event_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    linkedBy: text('linked_by').notNull(),
  },
  (table) => [primaryKey({ columns: [table.caseId, table.eventId] })],
)

// ---------------------------------------------------------------------------
// report_events (join table)
// ---------------------------------------------------------------------------

export const reportEvents = pgTable(
  'report_events',
  {
    reportId: text('report_id').notNull(),
    eventId: text('event_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    linkedBy: text('linked_by').notNull(),
  },
  (table) => [primaryKey({ columns: [table.reportId, table.eventId] })],
)

// ---------------------------------------------------------------------------
// report_cases (join table)
// ---------------------------------------------------------------------------

export const reportCases = pgTable(
  'report_cases',
  {
    reportId: text('report_id').notNull(),
    caseId: text('case_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    linkedBy: text('linked_by').notNull(),
    encryptedNotes: text('encrypted_notes'),
    notesEnvelopes: jsonb('notes_envelopes'),
  },
  (table) => [primaryKey({ columns: [table.reportId, table.caseId] })],
)

// ---------------------------------------------------------------------------
// case_interactions
// ---------------------------------------------------------------------------

export const caseInteractions = pgTable(
  'case_interactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    caseId: text('case_id').notNull(),
    interactionType: text('interaction_type').notNull(),
    sourceId: text('source_id'),
    encryptedContent: text('encrypted_content'),
    contentEnvelopes: jsonb('content_envelopes'),
    authorPubkey: text('author_pubkey').notNull(),
    interactionTypeHash: text('interaction_type_hash').notNull(),
    previousStatusHash: text('previous_status_hash'),
    newStatusHash: text('new_status_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('case_interactions_case_id_created_at_idx').on(
      table.caseId,
      table.createdAt,
    ),
    index('case_interactions_source_id_idx')
      .on(table.sourceId)
      .where(sql`source_id IS NOT NULL`),
    index('case_interactions_case_id_interaction_type_idx').on(
      table.caseId,
      table.interactionType,
    ),
  ],
)

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

export const evidence = pgTable(
  'evidence',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    caseId: text('case_id').notNull(),
    // The uploaded file this entry describes. It must exist: an evidence row
    // naming no file is an entry whose subject is absent (#2462).
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    classification: text('classification').notNull(),
    integrityHash: text('integrity_hash').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull().default('sha256'),
    source: text('source'),
    sourceDescription: text('source_description'),
    encryptedDescription: text('encrypted_description'),
    descriptionEnvelopes: jsonb('description_envelopes'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    uploadedBy: text('uploaded_by').notNull(),
    custodyEntryCount: integer('custody_entry_count').notNull().default(0),
  },
  (table) => [index('evidence_case_id_idx').on(table.caseId)],
)

// ---------------------------------------------------------------------------
// custody_entries
// ---------------------------------------------------------------------------

export const custodyEntries = pgTable(
  'custody_entries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    evidenceId: text('evidence_id').notNull(),
    action: text('action').notNull(),
    actorPubkey: text('actor_pubkey').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .notNull()
      .defaultNow(),
    integrityHash: text('integrity_hash').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    notes: text('notes'),
  },
  (table) => [
    index('custody_entries_evidence_id_timestamp_idx').on(
      table.evidenceId,
      table.timestamp,
    ),
  ],
)

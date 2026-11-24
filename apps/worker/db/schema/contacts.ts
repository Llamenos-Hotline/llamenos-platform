/**
 * Contacts domain tables: E2EE contact directory with blind indexes,
 * contact relationships, affinity groups, and group members.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull(),
    identifierHashes: text('identifier_hashes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    nameHash: text('name_hash'),
    trigramTokens: text('trigram_tokens')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    encryptedSummary: text('encrypted_summary').notNull(),
    summaryEnvelopes: jsonb('summary_envelopes').notNull().default([]),
    encryptedPii: text('encrypted_pii'),
    piiEnvelopes: jsonb('pii_envelopes'),
    contactTypeHash: text('contact_type_hash'),
    tagHashes: text('tag_hashes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    statusHash: text('status_hash'),
    blindIndexes: jsonb('blind_indexes').notNull().default({}),
    caseCount: integer('case_count').notNull().default(0),
    noteCount: integer('note_count').notNull().default(0),
    interactionCount: integer('interaction_count').notNull().default(0),
    lastInteractionAt: timestamp('last_interaction_at', {
      withTimezone: true,
    }),
    needsReencryption: boolean('needs_reencryption').notNull().default(false),
    mergedIntoId: text('merged_into_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('contacts', table.cryptoFormat),
    index('contacts_hub_id_idx').on(table.hubId),
    index('contacts_identifier_hashes_idx').using(
      'gin',
      table.identifierHashes,
    ),
    index('contacts_name_hash_idx')
      .on(table.nameHash)
      .where(sql`name_hash IS NOT NULL`),
    index('contacts_tag_hashes_idx').using('gin', table.tagHashes),
  ],
)

// ---------------------------------------------------------------------------
// contact_relationships
// ---------------------------------------------------------------------------

export const contactRelationships = pgTable(
  'contact_relationships',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull(),
    contactIdA: text('contact_id_a').notNull(),
    contactIdB: text('contact_id_b').notNull(),
    relationshipType: text('relationship_type').notNull(),
    direction: text('direction').notNull().default('bidirectional'),
    encryptedNotes: text('encrypted_notes'),
    notesEnvelopes: jsonb('notes_envelopes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text('created_by').notNull(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('contact_relationships', table.cryptoFormat),
    index('contact_relationships_contact_id_a_idx').on(table.contactIdA),
    index('contact_relationships_contact_id_b_idx').on(table.contactIdB),
  ],
)

// ---------------------------------------------------------------------------
// affinity_groups
// ---------------------------------------------------------------------------

export const affinityGroups = pgTable('affinity_groups', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  hubId: text('hub_id').notNull(),
  encryptedDetails: text('encrypted_details').notNull(),
  detailEnvelopes: jsonb('detail_envelopes').notNull().default([]),
  memberCount: integer('member_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: text('created_by').notNull(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [cryptoFormatCheck('affinity_groups', table.cryptoFormat)])

// ---------------------------------------------------------------------------
// group_members
// ---------------------------------------------------------------------------

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id').notNull(),
    contactId: text('contact_id').notNull(),
    role: text('role'),
    isPrimary: boolean('is_primary').default(false),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.contactId] })],
)

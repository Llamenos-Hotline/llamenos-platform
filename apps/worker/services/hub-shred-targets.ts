/**
 * The complete shred set for a hub — spec §4 of
 * docs/superpowers/specs/2026-10-03-hub-deletion-crypto-shred-design.md.
 *
 * Declaration only: no statement is built here. Every entry is confined to one
 * hub by construction, because `HubScope` admits exactly two shapes and the
 * executor can build nothing else from it. That is what makes "a shred of hub A
 * cannot reach hub B" a property of the data rather than a reviewer's
 * attention: a user belongs to many hubs and their PUK is shared across all of
 * them, so a single statement that forgets its hub predicate would lock that
 * user out of every other hub they serve.
 */

/** How a table's rows are attributed to one hub. There is no third shape. */
export type HubScope =
  /** The table has its own hub column. */
  | { via: 'hub-id'; column?: string }
  /** The table is reached through a parent that has one. */
  | { via: 'parent'; fk: string; parentTable: string; parentKey?: string }

/** The two values that destroy an envelope column, and nothing else. */
export type EnvelopeClearValue = "'[]'::jsonb" | 'NULL'

export type HubShredTarget =
  /**
   * Destroy the wraps, keep the row and its ciphertext. The content key becomes
   * unrecoverable by anyone, us included, while the row stays available to the
   * audit chain and to anything that counts records.
   */
  | {
      kind: 'clear-envelopes'
      table: string
      /** column → the value that destroys it. */
      columns: Record<string, EnvelopeClearValue>
      scope: HubScope
    }
  /** The sealing key is global, or the row *is* the key material: delete it. */
  | { kind: 'delete-rows'; table: string; scope: HubScope }
  /** audit_log: null the content, keep every hash. Handled specially. */
  | { kind: 'audit-shred' }

const BY_HUB: HubScope = { via: 'hub-id' }
const VIA_CONVERSATION: HubScope = { via: 'parent', fk: 'conversation_id', parentTable: 'conversations' }
const VIA_CASE: HubScope = { via: 'parent', fk: 'case_id', parentTable: 'case_records' }

/**
 * User- and platform-scoped tables. A hub shred must never name one.
 *
 * `puk_envelopes` is keyed (user_pubkey, device_id) and `user_role_envelopes`
 * (user_pubkey, role_id) with `roles` global — neither has a hub column, so
 * deleting either to shred hub A would lock the same user out of hub B. They
 * are correctly destroyed by *user* erasure, which is a different scope with a
 * different subject. `entity_type_templates` is excluded for a different
 * reason: it is documented as hub-key-sealed but has no hub_id, so which hub's
 * key wrapped it cannot be determined from the schema.
 */
export const CROSS_HUB_TABLES = [
  'audit_user_keys',
  'devices',
  'entity_type_templates',
  'platform_role_envelopes',
  'provision_rooms',
  'puk_envelopes',
  'roles',
  'sessions',
  'sigchain_links',
  'user_role_envelopes',
  'user_signal_contacts',
  'users',
  'webauthn_credentials',
] as const

/**
 * Order matters for deletes: children before parents, so no statement is
 * refused by a foreign key that a later statement would have cleared.
 */
export const HUB_SHRED_TARGETS: readonly HubShredTarget[] = [
  // --- Class A: the hub key's own wraps -----------------------------------
  // The hub key is 32 random bytes that exist nowhere else server-side.
  // Deleting every wrap ends it. The executor also advances
  // hubs.hub_key_generation, without which a replayed PUT /hubs/:id/key
  // carrying cached envelopes would re-install the key this destroys.
  { kind: 'delete-rows', table: 'hub_keys', scope: BY_HUB },

  // --- Class B: per-row recipient envelopes -------------------------------
  // There is no items_key table: each row's content key is HPKE-wrapped
  // directly to each reader's pubkey. These columns ARE the shred — destroying
  // the hub key alone leaves every note readable.
  {
    kind: 'clear-envelopes', table: 'notes', scope: BY_HUB,
    columns: {
      author_envelope: "'[]'::jsonb",
      admin_envelopes: "'[]'::jsonb",
      field_envelopes: 'NULL',
    },
  },
  {
    kind: 'clear-envelopes', table: 'note_replies',
    scope: { via: 'parent', fk: 'note_id', parentTable: 'notes' },
    columns: { reader_envelopes: "'[]'::jsonb" },
  },
  // Call recordings and voicemail metadata; transcripts are stored as notes.
  {
    kind: 'clear-envelopes', table: 'call_records', scope: BY_HUB,
    columns: { admin_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'messages', scope: VIA_CONVERSATION,
    columns: { reader_envelopes: "'[]'::jsonb" },
  },
  // The executor also deletes files/<id>/envelopes and files/<id>/metadata
  // from blob storage: routes/uploads.ts mirrors these columns there, so
  // clearing the database alone leaves a fully usable wrap in RustFS.
  {
    kind: 'clear-envelopes', table: 'files', scope: VIA_CONVERSATION,
    columns: { recipient_envelopes: "'[]'::jsonb", encrypted_metadata: "'[]'::jsonb" },
  },
  // Sealed with a server HMAC secret rather than a reader envelope, so
  // clearing the column is the only way to destroy it.
  {
    kind: 'clear-envelopes', table: 'contact_identifiers', scope: VIA_CONVERSATION,
    columns: { encrypted_identifier: 'NULL' },
  },
  {
    kind: 'clear-envelopes', table: 'case_records', scope: BY_HUB,
    columns: {
      summary_envelopes: "'[]'::jsonb",
      field_envelopes: "'[]'::jsonb",
      pii_envelopes: "'[]'::jsonb",
    },
  },
  {
    kind: 'clear-envelopes', table: 'case_interactions', scope: VIA_CASE,
    columns: { content_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'evidence', scope: VIA_CASE,
    columns: { description_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'report_cases', scope: VIA_CASE,
    columns: { notes_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'events', scope: BY_HUB,
    columns: { detail_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'contacts', scope: BY_HUB,
    columns: { summary_envelopes: "'[]'::jsonb", pii_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'contact_relationships', scope: BY_HUB,
    columns: { notes_envelopes: "'[]'::jsonb" },
  },
  {
    kind: 'clear-envelopes', table: 'affinity_groups', scope: BY_HUB,
    columns: { detail_envelopes: "'[]'::jsonb" },
  },

  // --- Class C: server-sealed hub data ------------------------------------
  // The sealing key is the server's, shared across every hub, so destroying a
  // key cannot help: the row itself must go.
  { kind: 'delete-rows', table: 'hub_storage_credentials', scope: BY_HUB },
  { kind: 'delete-rows', table: 'provider_configs', scope: BY_HUB },
  { kind: 'delete-rows', table: 'signal_registrations', scope: BY_HUB },
  { kind: 'delete-rows', table: 'a2p_registrations', scope: BY_HUB },
  // The firehose agent's sealed key is the root above every per-window content
  // key, which in turn decrypts the message buffer. Children first.
  {
    kind: 'delete-rows', table: 'firehose_message_buffer',
    scope: { via: 'parent', fk: 'connection_id', parentTable: 'firehose_connections' },
  },
  {
    kind: 'delete-rows', table: 'firehose_window_keys',
    scope: { via: 'parent', fk: 'connection_id', parentTable: 'firehose_connections' },
  },
  { kind: 'delete-rows', table: 'firehose_connections', scope: BY_HUB },
  {
    kind: 'clear-envelopes', table: 'subscribers', scope: BY_HUB,
    columns: { encrypted_identifier: 'NULL' },
  },

  // --- Class D: key-recovery paths ----------------------------------------
  // Destroying hub_keys while leaving these behind is not a shred at all: a
  // threshold of share holders reconstructs the hub recovery secret.
  { kind: 'delete-rows', table: 'hub_recovery_group_shares', scope: BY_HUB },
  { kind: 'delete-rows', table: 'hub_recovery_groups', scope: BY_HUB },
  { kind: 'delete-rows', table: 'user_recovery_envelopes', scope: BY_HUB },
  {
    kind: 'delete-rows', table: 'recovery_session_contributions',
    scope: { via: 'parent', fk: 'session_id', parentTable: 'recovery_sessions', parentKey: 'session_id' },
  },
  { kind: 'delete-rows', table: 'recovery_sessions', scope: BY_HUB },
  // MLS KeyPackages and Welcomes: epoch secrets derive the SFrame media keys
  // that encrypt voice. No SFrame key is stored, so this is the precursor.
  { kind: 'delete-rows', table: 'mls_pending_messages', scope: BY_HUB },

  // --- Class E: audit -----------------------------------------------------
  // Null the content, keep every hash. Never delete a row.
  { kind: 'audit-shred' },

  // --- Class F: hub bearer tokens -----------------------------------------
  { kind: 'delete-rows', table: 'call_tokens', scope: BY_HUB },
  { kind: 'delete-rows', table: 'invite_codes', scope: BY_HUB },
] as const

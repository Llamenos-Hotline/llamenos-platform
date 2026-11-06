-- #2510: the parent-edge inventory, shared by probe.sql and counts.sql.
-- Creates TEMP TABLE edges (child, col, parent, anchor). Include with \ir.

-- child, column, parent table, anchor = extra values that put a hub-less child in hub-A through
-- its other parent, so a cross-hub probe is meaningful.
CREATE TEMP TABLE edges (child text, col text, parent text, anchor jsonb DEFAULT '{}');
INSERT INTO edges (child, col, parent, anchor) VALUES
  -- case management (db/schema/cases.ts)
  ('case_records', 'entity_type_id', 'entity_type_definitions', '{}'),
  ('case_records', 'parent_record_id', 'case_records', '{}'),
  ('case_records', 'merged_into_id', 'case_records', '{}'),
  ('case_records', 'event_ids', 'events', '{}'),
  ('case_records', 'report_ids', 'conversations', '{}'),
  ('events', 'entity_type_id', 'entity_type_definitions', '{}'),
  ('events', 'parent_event_id', 'events', '{}'),
  ('case_contacts', 'case_id', 'case_records', '{"contact_id":"ct-A"}'),
  ('case_contacts', 'contact_id', 'contacts', '{"case_id":"rec-A"}'),
  ('case_events', 'case_id', 'case_records', '{"event_id":"ev-A"}'),
  ('case_events', 'event_id', 'events', '{"case_id":"rec-A"}'),
  ('report_cases', 'report_id', 'conversations', '{"case_id":"rec-A"}'),
  ('report_cases', 'case_id', 'case_records', '{"report_id":"cv-A"}'),
  ('report_events', 'report_id', 'conversations', '{"event_id":"ev-A"}'),
  ('report_events', 'event_id', 'events', '{"report_id":"cv-A"}'),
  ('case_interactions', 'case_id', 'case_records', '{}'),
  -- case_interactions.source_id is polymorphic (its parent table depends on
  -- interaction_type); probe.sql and counts.sql handle it explicitly.
  ('evidence', 'case_id', 'case_records', '{"file_id":"file-A"}'),
  ('evidence', 'file_id', 'files', '{"case_id":"rec-A"}'),
  ('custody_entries', 'evidence_id', 'evidence', '{}'),
  -- contacts (db/schema/contacts.ts)
  ('contacts', 'merged_into_id', 'contacts', '{}'),
  ('contact_relationships', 'contact_id_a', 'contacts', '{"contact_id_b":"ct-A"}'),
  ('contact_relationships', 'contact_id_b', 'contacts', '{"contact_id_a":"ct-A"}'),
  ('group_members', 'group_id', 'affinity_groups', '{"contact_id":"ct-A"}'),
  ('group_members', 'contact_id', 'contacts', '{"group_id":"ag-A"}'),
  ('contact_team_assignments', 'contact_id', 'contacts', '{"team_id":"tm-A"}'),
  ('contact_team_assignments', 'team_id', 'teams', '{"contact_id":"ct-A"}'),
  -- notes, messaging, files (db/schema/records.ts, conversations.ts, signal-queue.ts)
  ('notes', 'call_id', 'call_records', '{}'),
  ('notes', 'conversation_id', 'conversations', '{}'),
  ('note_replies', 'note_id', 'notes', '{}'),
  ('messages', 'conversation_id', 'conversations', '{}'),
  ('messages', 'attachment_ids', 'files', '{"conversation_id":"cv-A"}'),
  ('files', 'message_id', 'messages', '{"owner_kind":"conversation","conversation_id":"cv-A"}'),
  ('signal_message_queue', 'conversation_id', 'conversations', '{}'),
  -- calls (db/schema/calls.ts)
  ('provider_recordings', 'call_id', 'call_records', '{}'),
  -- shifts, ring groups, teams, blasts
  ('shifts', 'ring_group_id', 'ring_groups', '{}'),
  ('shift_overrides', 'shift_id', 'shifts', '{}'),
  ('shift_join_requests', 'shift_id', 'shifts', '{}'),
  ('push_reminders_sent', 'shift_id', 'shifts', '{}'),
  ('ring_group_members', 'ring_group_id', 'ring_groups', '{}'),
  ('team_members', 'team_id', 'teams', '{}'),
  ('users', 'team_id', 'teams', '{}'),
  ('blast_deliveries', 'blast_id', 'blasts', '{"subscriber_id":"sub-A"}'),
  ('blast_deliveries', 'subscriber_id', 'subscribers', '{"blast_id":"bl-A"}'),
  -- firehose (db/schema/firehose.ts)
  ('firehose_connections', 'report_type_id', 'report_type_definitions', '{}'),
  ('firehose_message_buffer', 'connection_id', 'firehose_connections', '{}'),
  ('firehose_message_buffer', 'window_key_id', 'firehose_window_keys', '{"connection_id":"fc-A"}'),
  ('firehose_message_buffer', 'extracted_report_id', 'conversations', '{"connection_id":"fc-A"}'),
  ('firehose_window_keys', 'connection_id', 'firehose_connections', '{}'),
  ('firehose_notification_optouts', 'connection_id', 'firehose_connections', '{}'),
  -- type definitions (db/schema/settings.ts)
  ('relationship_type_definitions', 'source_entity_type_id', 'entity_type_definitions', '{}'),
  ('relationship_type_definitions', 'target_entity_type_id', 'entity_type_definitions', '{}'),
  ('entity_type_definitions', 'template_id', 'entity_type_templates', '{}'),
  ('report_type_definitions', 'template_id', 'entity_type_templates', '{}'),
  ('relationship_type_definitions', 'template_id', 'entity_type_templates', '{}'),
  ('hub_onboarding_state', 'template_id', 'entity_type_templates', '{}'),
  -- recovery
  ('recovery_session_contributions', 'session_id', 'recovery_sessions', '{}'),
  ('hub_recovery_group_shares', 'hub_id', 'hub_recovery_groups', '{}'),
  ('messaging_suppression_identifiers', 'suppression_id', 'messaging_suppressions', '{}'),
  -- device edges
  ('security_events', 'device_id', 'devices', '{}'),
  ('device_verifications', 'target_device_id', 'devices', '{}'),
  ('sigchain_links', 'signer_device_id', 'devices', '{}'),
  ('mls_pending_messages', 'recipient_device_id', 'devices', '{}'),
  ('puk_envelopes', 'device_id', 'devices', '{}');

-- Every person edge: a column that names a user by pubkey (users.pubkey).
INSERT INTO edges (child, col, parent)
SELECT c.relname, a.attname, 'users'
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND (a.attname ~ '(pubkey|_by)$' OR a.attname IN ('assigned_to', 'user_id'))
   AND NOT (c.relname = 'users' AND a.attname = 'pubkey')
   AND a.attname NOT IN ('ed25519_pubkey', 'x25519_pubkey', 'ephemeral_pubkey', 'escrow_pubkey', 'new_device_pubkey')
   AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.child = c.relname AND e.col = a.attname);

-- Every hub edge.
INSERT INTO edges (child, col, parent)
SELECT c.relname, a.attname, 'hubs'
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND a.attname IN ('hub_id', 'source_hub_id')
   AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.child = c.relname AND e.col = a.attname);


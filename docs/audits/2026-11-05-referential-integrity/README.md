# #2510 — Referential integrity: every parent edge, and whether a violating row is representable today

**Audited** 2026-11-05 at `origin/main` = `0210c9d9f` (after #2484 and #2485). Read-only: no schema, migration or application
code changed. **Refs #2510.**

## How this was measured

Not by reading DDL. Each claim below comes from one of three instruments, all committed beside this file:

| File | What it does |
|---|---|
| [`probe.sql`](probe.sql) | Against a **freshly migrated scratch database** (all 81 migrations), seeds two hubs (`hub-A`, `hub-B`) and one parent row of every hub-owned kind in each, then **attempts 302 violating INSERTs**: an orphan, a cross-hub row, and a `''`-hub row per edge. Every attempt runs in its own sub-transaction and is rolled back. The whole script is also rolled back. |
| [`probe-results.txt`](probe-results.txt) | The verbatim output. **232 ACCEPTED / 70 REJECTED.** Every REJECTED line names the constraint that refused it. I checked each one: all 70 are `23503` from the FK under test, so no rejection comes from an unrelated column. |
| [`edges.sql`](edges.sql) + [`counts.sql`](counts.sql) | The edge inventory, and a generator for the existing-violation `COUNT` queries. They are run **read-only** (`default_transaction_read_only=on`) against the five populated dev databases. Results are in [`existing-violations.md`](existing-violations.md). |

To reproduce: `createdb x && DATABASE_URL=… bun run db:migrate && psql … -f probe.sql`.

The catalog agrees with the newest Drizzle snapshot (`20261105220703_snapshot.json`) on every FK. The only differences are names: the hand-written firehose, blast and recovery FKs carry Postgres' `_fkey` / truncated names. So **the schema in the code is not hiding constraints that the database lacks, or the reverse.** Totals: 106 tables, **54 FKs**, and only **2 composite** (both from #2484). Only two tables carry a `UNIQUE (id, hub_id)`: `case_records` and `conversations`.

## The headline findings

1. **36 of the 56 `hub_id` columns have no FK to `hubs` at all.** An orphan hub (`'no-such-id'`) and the `''` sentinel are both accepted (probe lines 4–5, 31–32, and the whole `hub_id orphan` column below). **17 of those 36 are `NOT NULL` with no `''` default**, so #2464's map, which lists nullable columns and `DEFAULT ''` sentinels, does not name them: `active_shifts`, `affinity_groups`, `blast_settings`, `contact_relationships`, `contact_team_assignments`, `contacts`, `erasure_config`, `firehose_connections`, `hub_recovery_groups`, `mls_pending_messages`, `re_encryption_jobs`, `recovery_sessions`, `retention_settings`, `ring_groups`, `shift_join_requests`, `shift_overrides`, `user_availability_blocks`. A hub deletion leaves their rows behind: the dev databases hold **345 `active_shifts` rows, 69 `hub_recovery_groups`, 58 `recovery_sessions` and 18 `ring_groups` naming hubs that no longer exist**.
2. **A single-column FK does not stop a cross-hub row.** Every child that has a real FK to a hub-owned parent still accepts that parent from the other hub: `shifts.ring_group_id` (probe 253), `shift_overrides.shift_id` (248), `shift_join_requests.shift_id` (242), `contact_team_assignments.contact_id` / `.team_id` (75, 79), `blast_deliveries` (22, 24), and `evidence.file_id` (117). Only #2484's two composite FKs refuse a cross-hub row (probes 296, 297). Adding plain FKs will not close the cross-hub class. Only the composite shape does.
3. **A composite FK is inert while the child's `hub_id` is nullable.** Postgres FKs are `MATCH SIMPLE`, so a NULL in any column skips the whole check. `files` (after #2484) accepts a case-owned file naming an **orphan record** with `hub_id NULL` (probe 298), a hub-B record with `hub_id NULL` (299), a file with no owner, no parent and no hub (300), and an orphan `case_record_id` with `owner_kind NULL` (301). `files.case_record_id` has **no single-column FK**: the composite is its only guard, and it switches off on NULL. `owner_kind NULL` also passes `files_owner_check`, because a CHECK that evaluates to NULL passes. **`SET NOT NULL` on `hub_id` is therefore a prerequisite of every composite FK in this plan, not a follow-up.**
4. **`evidence.file_id`'s FK is `NOT VALID`, but it already refuses new orphans** (probe 116, `evidence_file_id_files_id_fk`). `NOT VALID` exempts only existing rows: 4 orphan evidence rows exist in one dev database. **It does not refuse a cross-hub file**, a hub-B file on a hub-A record (117), because `evidence` has no `hub_id`. #2486's `VALIDATE CONSTRAINT` will not change that.
5. **Every case-management join edge accepts both an orphan and a cross-hub row**: `case_contacts`, `case_events`, `report_cases`, `report_events`, `group_members`, `custody_entries`, `case_interactions`, `evidence.case_id`, `contact_relationships` (probes 37–44, 47, 66–69, 88, 114–115, 135–138, 213–222). None of these has a `hub_id`, so a composite FK needs a `hub_id` column added to the child, not only a constraint.
6. **`case_interactions.source_id` is a polymorphic edge with no type.** Its parent table depends on a free-text `interaction_type`. Accepted: an orphan note source (290); a hub-B note, call or report on a hub-A record (291–293); a `note`-typed interaction naming a **call** id (294); and an `interaction_type` outside the protocol enum (295). The service writes one itself: `'report_conversion'` (`apps/worker/services/cases.ts:1845`) is not in `interactionTypeSchema` (`packages/protocol/schemas/interactions.ts:6-15`). This is the edge #2509's `getBySource` reads (`services/cases.ts:1487-1500`), and the type confusion #2499 describes, in schema form.
7. **Hub membership is not relational.** It is the `users.hub_roles` jsonb (`apps/worker/db/schema/users.ts:30`), and no `hub_members` table exists. So **no person edge can be constrained to "a member of this hub"**: `ring_group_members.user_pubkey`, `active_shifts.pubkey`, `hub_keys.recipient_pubkey`, `case_records.assigned_to` and the rest can name a non-member, or a user who does not exist (77 person edges, 67 FK-less, every one of the 67 accepts an orphan).

## Write paths that already produce what the schema permits

These come from **reading the code**. I did not drive them end-to-end against a server. Each is a handler that checks a parent by bare id only, so the database's permissiveness is reachable through the API:

| Path | What it checks | What it does not |
|---|---|---|
| `CasesService.linkContact` (`services/cases.ts:625-637`) | record exists **by id** | the record's hub; the contact's existence or hub |
| `CasesService.linkReportCase` (`services/cases.ts:1241-1253`) | record exists by id | the report's existence or hub |
| `CasesService.linkReportEvent` (`services/cases.ts:1173-1180`) | event in the caller's hub | the report's existence or hub |
| `CasesService.createEvidence` (`services/cases.ts:1516-1537`) | record exists by id | the file's hub (the FK checks existence only) |
| `CasesService.createInteraction` (`services/cases.ts:1357-1370`) | record exists by id | `source_id`'s existence, type or hub. `routes/notes.ts:148-155` links a note to a body-supplied `caseId` without checking that case's hub |
| `ContactsService.addMember` (`services/contacts.ts:538-556`) | group and contact exist **by id** | that they share a hub |
| `ShiftsService.create` (`services/shifts.ts:74-88`) | time format | `ringGroupId` (`createShiftBody`, `packages/protocol/schemas/shifts.ts:57`) is spread in unchecked. A join-request approval then inserts the requester into **that** ring group (`services/shift-requests.ts:190-198`), so a hub-A shift can ring a hub-B group |
| `CasesService.linkEvent` (`services/cases.ts:1020-1035`) | record **and** event in the caller's hub | (the one join path that is hub-checked) |

**A test that depends on the database being permissive.** `tests/steps/backend/access-control-epic-e.steps.ts:170-173` deliberately links a contact from one hub to a record in another ("Cross-hub link is deliberate"). It does so to exercise `listByContact`'s read-side hub filter (`services/cases.ts:498`). The resulting row is in four of the five dev databases (`case_contacts … cross-hub = 1`: hubs `epic-e-hub-alpha` / `epic-e-hub-beta`). After the `case_contacts` composite FK, that setup step **must fail**, and the scenario should instead assert that the link is refused. Fabricated parent ids also remain in `tests/steps/backend/network-security.steps.ts:291` and `tests/steps/backend/security.steps.ts:716` (`callId: test-call-${Date.now()}` / `dispatch-${Date.now()}` on `POST /notes`). Whether each becomes a failure depends on whether its assertion is reached first.

## Side finding: array columns disagree with the snapshot

22 `text[]` columns are `notNull: true` in `20261105220703_snapshot.json` (and in Drizzle) but **nullable in the migrated database**. Examples: `case_records.event_ids` / `report_ids` (`0000_bouncy_morlocks.sql:124-125` never set `NOT NULL`), `messages.attachment_ids`, `contacts.tag_hashes` and `users.specializations`. All 22: `blasts.target_channels/target_tags/target_languages`, `subscribers.tags`, `custom_field_definitions.options/allowed_mime_types`, `entity_type_definitions.closed_statuses/pii_fields/access_roles/edit_roles`, `report_type_definitions.closed_statuses`, `system_settings.ivr_languages/report_categories`, `case_records.event_ids/report_ids`, `contacts.trigram_tokens/tag_hashes`, `messages.attachment_ids`, `users.spoken_languages/supported_messaging_channels/specializations`, `webauthn_credentials.transports`. #2471's `constrain` annotation must "agree with the newest snapshot". For these columns, the snapshot already claims the tightened state, so a gate keyed on the snapshot may see nothing to annotate. **Not in scope here; flagged for whoever owns the gate.**

## The map

`**yes**` = the violating INSERT was **accepted** (representable today); `no` = refused by the named FK (see
`probe-results.txt`); `n/a` = not meaningful for that edge (the child has no hub of its own and no second hub-owned
parent, so its hub is derived; or the parent is not hub-owned). "max … rows" = the largest count across the five dev
databases (`existing-violations.md` has per-database numbers). `–` = not measurable at those databases' migration level.

### A. Hub edges (`hub_id` → `hubs`)

Platform-scope NULLs (`bans`, `audit_log`, `hub_incidents`, `oauth_states`, `provider_configs`, `messaging_suppressions`,
`erasure_requests`) and the `''` "platform default" rows of the type-definition tables and `ivr_audio` await the #2463
ruling. The column is still listed, because the absence of an FK is a separate question from whether NULL is allowed.

| child.column | type | FK today | orphan hub accepted | `''` hub accepted | max orphan rows | max `''` rows |
|---|---|---|---|---|---|---|
| `a2p_registrations.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `active_calls.hub_id` | text null | **none** | **yes** | **yes** | 14 | 16 |
| `active_shifts.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 345 | 0 |
| `affinity_groups.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 3 |
| `audit_log.hub_id` | text null | **none** | **yes** | **yes** | 24 | 0 |
| `bans.hub_id` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `blast_settings.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `blasts.hub_id` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `call_records.hub_id` | text null | **none** | **yes** | **yes** | 49 | 71 |
| `call_tokens.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 28 | 0 |
| `case_number_sequences.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 0 | 0 |
| `case_records.hub_id` | text null | **none** | **yes** | **yes** | 0 | 22 |
| `contact_metadata.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `contact_relationships.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 2 |
| `contact_team_assignments.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `contacts.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `conversations.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `entity_type_definitions.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 0 | 10 |
| `erasure_config.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 6 | 0 |
| `erasure_requests.hub_id` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `event_outbox.hub_id` | text NOT NULL | hubs | no | no | 1398 | 0 |
| `events.hub_id` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `files.hub_id` | text null | hubs, conversations (composite), case_records (composite) | no | no | – | – |
| `firehose_connections.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `hub_incidents.hub_id` | text null | hubs | no | no | 0 | 0 |
| `hub_keys.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `hub_onboarding_state.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `hub_recovery_groups.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 69 | 0 |
| `hub_settings.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `hub_storage_credentials.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `hub_storage_settings.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `invite_codes.hub_id` | text null | **none** | **yes** | **yes** | 36 | 0 |
| `ivr_audio.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 0 | 0 |
| `messaging_suppressions.source_hub_id` | text null | **none** | **yes** | n/a | 0 | 0 |
| `mls_pending_messages.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 14 | 0 |
| `notes.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `oauth_states.hub_id` | text null | hubs | no | no | 0 | 0 |
| `provider_configs.hub_id` | text null | hubs | no | no | 0 | 0 |
| `provider_recordings.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 1 | 0 |
| `re_encryption_jobs.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 10 | 0 |
| `recovery_sessions.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 58 | 0 |
| `relationship_type_definitions.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 0 | 3 |
| `report_type_definitions.hub_id` | text NOT NULL default ''::text | **none** | **yes** | **yes** | 0 | 0 |
| `retention_settings.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 9 | 0 |
| `ring_groups.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 18 | 0 |
| `shift_join_requests.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `shift_overrides.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 9 | 0 |
| `shifts.hub_id` | text null | **none** | **yes** | **yes** | 30 | 4 |
| `signal_identities.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `signal_message_queue.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `signal_registrations.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `subscribers.hub_id` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `tags.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `teams.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |
| `user_availability_blocks.hub_id` | text NOT NULL | **none** | **yes** | **yes** | 9 | 0 |
| `user_recovery_envelopes.hub_id` | text NOT NULL | hubs | no | no | 0 | 0 |

### B. Entity edges (child → hub-owned or global parent)

`*.template_id` (`entity_type_definitions`, `report_type_definitions`, `relationship_type_definitions`,
`hub_onboarding_state`) is **not a database edge**: it holds a built-in template **key** (`general-hotline`,
`jail-support`, …), and `entity_type_templates` is empty in every database inspected. Its "orphans" are expected. It
belongs to the code's template catalog, not to an FK. It is listed so nobody adds an FK to `entity_type_templates` by
mistake. `case_records.event_ids` / `report_ids` and `messages.attachment_ids` are `text[]`, which **no FK can
constrain**. `event_ids` / `report_ids` duplicate `case_events` / `report_cases`.

| child.column → parent | type | FK today | orphan accepted | cross-hub accepted | max orphan rows | max cross-hub rows |
|---|---|---|---|---|---|---|
| `blast_deliveries.blast_id` → `blasts` | text NOT NULL | blasts | no | **yes** | 0 | 0 |
| `blast_deliveries.subscriber_id` → `subscribers` | text NOT NULL | subscribers | no | **yes** | 0 | 0 |
| `case_contacts.case_id` → `case_records` | text NOT NULL | **none** | **yes** | **yes** | 0 | 1 |
| `case_contacts.contact_id` → `contacts` | text NOT NULL | **none** | **yes** | **yes** | 0 | 1 |
| `case_events.case_id` → `case_records` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `case_events.event_id` → `events` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `case_interactions.case_id` → `case_records` | text NOT NULL | **none** | **yes** | n/a | 0 | – |
| `case_records.entity_type_id` → `entity_type_definitions` | text null | **none** | **yes** | **yes** | 11 | 0 |
| `case_records.event_ids` → `events` | text[] null default '{}'::text[] | **none** | **yes** | **yes** | 0 | 0 |
| `case_records.merged_into_id` → `case_records` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `case_records.parent_record_id` → `case_records` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `case_records.report_ids` → `conversations` | text[] null default '{}'::text[] | **none** | **yes** | **yes** | 0 | 3 |
| `contact_relationships.contact_id_a` → `contacts` | text NOT NULL | **none** | **yes** | **yes** | 2 | 0 |
| `contact_relationships.contact_id_b` → `contacts` | text NOT NULL | **none** | **yes** | **yes** | 2 | 0 |
| `contact_team_assignments.contact_id` → `contacts` | text NOT NULL | contacts | no | **yes** | 0 | 0 |
| `contact_team_assignments.team_id` → `teams` | text NOT NULL | teams | no | **yes** | 0 | 0 |
| `contacts.merged_into_id` → `contacts` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `custody_entries.evidence_id` → `evidence` | text NOT NULL | **none** | **yes** | n/a | 0 | – |
| `entity_type_definitions.template_id` → `entity_type_templates` | text null | **none** | **yes** | n/a | 13 | – |
| `events.entity_type_id` → `entity_type_definitions` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `events.parent_event_id` → `events` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `evidence.case_id` → `case_records` | text NOT NULL | **none** | **yes** | **yes** | 0 | – |
| `evidence.file_id` → `files` | text NOT NULL | files NOT VALID | no | **yes** | 4 | – |
| `files.message_id` → `messages` | text null | **none** | **yes** | n/a | 0 | – |
| `firehose_connections.report_type_id` → `report_type_definitions` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `firehose_message_buffer.connection_id` → `firehose_connections` | text NOT NULL | firehose_connections | no | n/a | 0 | – |
| `firehose_message_buffer.extracted_report_id` → `conversations` | text null | **none** | **yes** | **yes** | 0 | 0 |
| `firehose_message_buffer.window_key_id` → `firehose_window_keys` | text null | **none** | **yes** | n/a | 0 | – |
| `firehose_notification_optouts.connection_id` → `firehose_connections` | text NOT NULL | firehose_connections | no | n/a | 0 | – |
| `firehose_window_keys.connection_id` → `firehose_connections` | text NOT NULL | firehose_connections | no | n/a | 0 | – |
| `group_members.contact_id` → `contacts` | text NOT NULL | **none** | **yes** | **yes** | 2 | 0 |
| `group_members.group_id` → `affinity_groups` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `hub_onboarding_state.template_id` → `entity_type_templates` | text null | **none** | **yes** | n/a | 0 | – |
| `hub_recovery_group_shares.hub_id` → `hub_recovery_groups` | text NOT NULL | hub_recovery_groups | no | n/a | 0 | – |
| `messages.attachment_ids` → `files` | text[] null | **none** | **yes** | **yes** | 0 | – |
| `messages.conversation_id` → `conversations` | text NOT NULL | conversations | no | n/a | 0 | – |
| `messaging_suppression_identifiers.suppression_id` → `messaging_suppressions` | text NOT NULL | messaging_suppressions | no | n/a | 0 | – |
| `note_replies.note_id` → `notes` | text NOT NULL | notes | no | n/a | 0 | – |
| `notes.call_id` → `call_records` | text null | **none** | **yes** | **yes** | 18 | 69 |
| `notes.conversation_id` → `conversations` | text null | **none** | **yes** | **yes** | 3 | 0 |
| `provider_recordings.call_id` → `call_records` | text NOT NULL | **none** | **yes** | **yes** | 1 | 0 |
| `push_reminders_sent.shift_id` → `shifts` | text NOT NULL | **none** | **yes** | n/a | 0 | – |
| `recovery_session_contributions.session_id` → `recovery_sessions` | text NOT NULL | recovery_sessions | no | n/a | 0 | – |
| `relationship_type_definitions.source_entity_type_id` → `entity_type_definitions` | text null | **none** | **yes** | **yes** | 90 | 0 |
| `relationship_type_definitions.target_entity_type_id` → `entity_type_definitions` | text null | **none** | **yes** | **yes** | 1 | 0 |
| `relationship_type_definitions.template_id` → `entity_type_templates` | text null | **none** | **yes** | n/a | 179 | – |
| `report_cases.case_id` → `case_records` | text NOT NULL | **none** | **yes** | **yes** | 0 | 3 |
| `report_cases.report_id` → `conversations` | text NOT NULL | **none** | **yes** | **yes** | 0 | 3 |
| `report_events.event_id` → `events` | text NOT NULL | **none** | **yes** | **yes** | 2 | 0 |
| `report_events.report_id` → `conversations` | text NOT NULL | **none** | **yes** | **yes** | 1 | 0 |
| `report_type_definitions.template_id` → `entity_type_templates` | text null | **none** | **yes** | n/a | 6 | – |
| `ring_group_members.ring_group_id` → `ring_groups` | text NOT NULL | ring_groups | no | n/a | 0 | – |
| `shift_join_requests.shift_id` → `shifts` | text NOT NULL | shifts | no | **yes** | 0 | 0 |
| `shift_overrides.shift_id` → `shifts` | text null | shifts | no | **yes** | 0 | 0 |
| `shifts.ring_group_id` → `ring_groups` | text null | ring_groups | no | **yes** | 0 | 0 |
| `signal_message_queue.conversation_id` → `conversations` | text NOT NULL | **none** | **yes** | **yes** | 0 | 0 |
| `team_members.team_id` → `teams` | text NOT NULL | teams | no | n/a | 0 | – |
| `users.team_id` → `teams` | text null | **none** | **yes** | n/a | 1 | – |

`case_interactions.source_id` (polymorphic) has its own probes in `probe-results.txt` (290–295): orphan, cross-hub for
note/call/report, and type confusion are **all accepted**. Its count lines are `0` in every dev database.

### C. Person edges (→ `users.pubkey`)

These need a **ruling before a migration**, not a wave. Two kinds are mixed here:

- **live-membership edges**, which should vanish with the user: `active_shifts.pubkey`, `ring_group_members.user_pubkey`,
  `hub_keys.recipient_pubkey`, `user_availability_blocks.user_pubkey`, `call_tokens.volunteer_pubkey`,
  `case_records.assigned_to`, `conversations.assigned_to`, `hub_recovery_group_shares.holder_pubkey`,
  `recovery_sessions.user_pubkey`, `user_recovery_envelopes.user_pubkey`, `shift_join_requests.user_pubkey`,
  `firehose_notification_optouts.user_id`, `users.supervisor_pubkey`. For these an FK with `ON DELETE CASCADE` is
  right. Even then, "is a member of this hub" stays unconstrainable while membership lives in `users.hub_roles` jsonb.
- **attribution edges** (`*_by`, `author_pubkey`, `audit_log.actor_pubkey`, `custody_entries.actor_pubkey`), which
  must **outlive** the user: the audit hash chain, chain of custody, and the D5/D7/D8 erasure rulings. A cascading FK would
  delete evidence history, and a restricting one would block erasure. Whether they become `ON DELETE SET NULL` or remain
  unconstrained attribution text is an operator decision.

`auth_nonces.pubkey` and `webauthn_challenges.pubkey` are pre-authentication and ephemeral. They name a key that may not
be a user yet, so they are not edges.

| child.column (→ users.pubkey) | type | FK today | orphan accepted | max orphan rows |
|---|---|---|---|---|
| `active_calls.answered_by` | text null | **none** | **yes** | 14 |
| `active_calls.reported_by` | text null | **none** | **yes** | 0 |
| `active_shifts.pubkey` | text NOT NULL | **none** | **yes** | 345 |
| `affinity_groups.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `audit_log.actor_pubkey` | text NOT NULL | **none** | **yes** | 89 |
| `audit_user_keys.user_pubkey` | text NOT NULL | **none** | **yes** | 129 |
| `auth_nonces.pubkey` | text NOT NULL | **none** | **yes** | 1931 |
| `bans.banned_by` | text null | **none** | **yes** | 2 |
| `blasts.created_by` | text null | **none** | **yes** | 0 |
| `call_records.answered_by` | text null | **none** | **yes** | 2 |
| `call_tokens.volunteer_pubkey` | text NOT NULL | **none** | **yes** | 28 |
| `case_contacts.added_by` | text NOT NULL | **none** | **yes** | 0 |
| `case_events.linked_by` | text NOT NULL | **none** | **yes** | 0 |
| `case_interactions.author_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `case_records.assigned_to` | text[] NOT NULL default '{}'::text[] | **none** | **yes** | 0 |
| `case_records.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `contact_relationships.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `contact_team_assignments.assigned_by` | text NOT NULL | **none** | **yes** | 0 |
| `conversations.assigned_to` | text null | **none** | **yes** | 0 |
| `custody_entries.actor_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `device_verifications.target_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `device_verifications.verifier_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `devices.pubkey` | text NOT NULL | users | no | 0 |
| `erasure_config.updated_by` | text NOT NULL | **none** | **yes** | 4 |
| `erasure_requests.abandoned_by` | text null | **none** | **yes** | 0 |
| `erasure_requests.co_approver_pubkey` | text null | **none** | **yes** | 4 |
| `erasure_requests.requested_by` | text NOT NULL | **none** | **yes** | 20 |
| `erasure_requests.user_id` | text null | **none** | **yes** | 20 |
| `events.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `evidence.uploaded_by` | text NOT NULL | **none** | **yes** | 0 |
| `files.uploaded_by` | text NOT NULL | **none** | **yes** | 0 |
| `firehose_connections.agent_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `firehose_notification_optouts.user_id` | text NOT NULL | **none** | **yes** | 0 |
| `hub_keys.recipient_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `hub_recovery_group_shares.holder_pubkey` | text NOT NULL | **none** | **yes** | 188 |
| `hubs.created_by` | text NOT NULL | **none** | **yes** | 1 |
| `invite_codes.created_by` | text null | **none** | **yes** | 1 |
| `invite_codes.used_by` | text null | **none** | **yes** | 21 |
| `messages.author_pubkey` | text null | **none** | **yes** | 34 |
| `note_replies.author_pubkey` | text NOT NULL | **none** | **yes** | 3 |
| `notes.author_pubkey` | text NOT NULL | **none** | **yes** | 6 |
| `platform_role_envelopes.admin_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `provider_templates.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `provision_rooms.primary_pubkey` | text null | **none** | **yes** | 0 |
| `puk_envelopes.user_pubkey` | text NOT NULL | users | no | 0 |
| `push_reminders_sent.pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `re_encryption_jobs.user_id` | text null | **none** | **yes** | 7 |
| `recovery_session_contributions.contributor_pubkey` | text NOT NULL | **none** | **yes** | 6 |
| `recovery_sessions.cancelled_by` | text null | **none** | **yes** | 6 |
| `recovery_sessions.user_pubkey` | text NOT NULL | **none** | **yes** | 40 |
| `report_cases.linked_by` | text NOT NULL | **none** | **yes** | 0 |
| `report_events.linked_by` | text NOT NULL | **none** | **yes** | 0 |
| `retention_platform_floors.updated_by` | text NOT NULL | **none** | **yes** | 0 |
| `retention_settings.updated_by` | text NOT NULL | **none** | **yes** | 9 |
| `ring_group_members.added_by` | text NOT NULL | **none** | **yes** | 0 |
| `ring_group_members.user_pubkey` | text NOT NULL | **none** | **yes** | 9 |
| `security_events.user_pubkey` | text null | users | no | 0 |
| `sessions.pubkey` | text NOT NULL | users | no | 0 |
| `shift_join_requests.reviewed_by` | text null | **none** | **yes** | 0 |
| `shift_join_requests.user_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `shift_overrides.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `shifts.created_by` | text null | **none** | **yes** | 0 |
| `sigchain_links.signer_pubkey` | text NOT NULL default ''::text | **none** | **yes** | 1 |
| `sigchain_links.user_pubkey` | text NOT NULL | users | no | 0 |
| `signal_identities.verified_by` | text null | **none** | **yes** | 0 |
| `tags.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `team_members.added_by` | text NOT NULL | **none** | **yes** | 0 |
| `team_members.user_pubkey` | text NOT NULL | users | no | 0 |
| `teams.created_by` | text NOT NULL | **none** | **yes** | 0 |
| `user_availability_blocks.user_pubkey` | text NOT NULL | **none** | **yes** | 9 |
| `user_recovery_envelopes.user_pubkey` | text NOT NULL | **none** | **yes** | 0 |
| `user_role_envelopes.user_pubkey` | text NOT NULL | users | no | 0 |
| `user_security_prefs.user_pubkey` | text NOT NULL | users | no | 0 |
| `user_signal_contacts.user_pubkey` | text NOT NULL | users | no | 0 |
| `users.supervisor_pubkey` | text null | **none** | **yes** | 0 |
| `webauthn_challenges.pubkey` | text null | **none** | **yes** | 0 |
| `webauthn_credentials.pubkey` | text NOT NULL | users | no | 0 |

### D. Device edges (→ `devices.id`)

| child.column (→ devices.id) | type | FK today | orphan accepted | max orphan rows |
|---|---|---|---|---|
| `device_verifications.target_device_id` | text NOT NULL | **none** | **yes** | 0 |
| `mls_pending_messages.recipient_device_id` | text NOT NULL | **none** | **yes** | 14 |
| `puk_envelopes.device_id` | text NOT NULL | **none** | **yes** | 12 |
| `security_events.device_id` | text null | **none** | **yes** | 5 |
| `sigchain_links.signer_device_id` | text NOT NULL default ''::text | **none** | **yes** | 22 |

`puk_envelopes.device_id` is **deliberately not** `devices.id` (`apps/worker/db/schema/puk-envelopes.ts:38-40`: "the
push-registry row ID is server-assigned and unrelated to the ID the envelope's HPKE AAD binds"). `sigchain_links.signer_device_id`
and `mls_pending_messages.recipient_device_id` are identity-layer device ids too. **There is no table they could
reference**, because the sigchain device set has no relational form. That belongs with #2496 (which also stands
confirmed: `devices` has only `devices_pkey` and `devices_pubkey_idx`, and **no unique index on `x25519_pubkey`**).
`security_events.device_id` and `device_verifications.target_device_id` are push-registry ids and could take an FK.

## Parents that need a `UNIQUE (id, hub_id)` first

A composite FK `(child.parent_id, child.hub_id) → parent(id, hub_id)` needs that pair to be unique on the parent.
Today only `case_records_id_hub_id_unique` and `conversations_id_hub_id_unique` exist (both from #2484). Adding one is
satisfiable by construction, because `id` is already the PK. That makes it the cheap first step of each wave, and the
reason this lands in waves rather than one pass.

| Parent | Needed by |
|---|---|
| `contacts` | `case_contacts`, `group_members`, `contact_relationships` (a, b), `contact_team_assignments`, `contacts.merged_into_id` |
| `events` | `case_events`, `report_events`, `events.parent_event_id` |
| `notes` | `case_interactions` (typed note source) |
| `call_records` — `(call_id, hub_id)` | `notes.call_id`, `provider_recordings.call_id`, `case_interactions` (typed call source) |
| `files` | `evidence.file_id` |
| `evidence` | not needed: `custody_entries` is a pure child, and a plain FK suffices once `evidence` is hub-constrained |
| `affinity_groups` | `group_members` |
| `shifts` | `shift_overrides`, `shift_join_requests` |
| `ring_groups` | `shifts.ring_group_id` |
| `teams` | `contact_team_assignments.team_id` |
| `blasts`, `subscribers` | `blast_deliveries` (also needs a `hub_id`) |
| `entity_type_definitions`, `report_type_definitions` | `case_records` / `events` `.entity_type_id`, `relationship_type_definitions` source/target, `firehose_connections.report_type_id`. **Blocked on #2463**: if a hub record may use a platform-default (`hub_id = ''`) type, a composite FK is the wrong shape |
| `messages` — `(id, conversation_id)` | `files.message_id`, so a file's message is in the file's conversation |
| `case_records` ✓, `conversations` ✓ | already present |

Pure children need **only a plain FK** (with `ON DELETE CASCADE`), because they have no `hub_id` and exactly one
hub-owned parent, so their hub is derived and cannot disagree: `custody_entries.evidence_id`,
`case_interactions.case_id`, `note_replies` (✓), `messages` (✓), `push_reminders_sent.shift_id`,
`firehose_window_keys` / `_message_buffer` / `_notification_optouts` (✓ except `window_key_id`). **Join tables with
two hub-owned parents** (`case_contacts`, `case_events`, `report_cases`, `report_events`, `group_members`,
`blast_deliveries`, `evidence`) need **a `hub_id` column added** plus two composite FKs. The alternative is to accept that their
two parents can disagree.

## Ranked plan

Ordered by **how many other defects each wave closes**, not table size. Each wave is one or more scoped PRs, written in the #2484
shape and annotated with #2471's `constrain`. Constraints that shape every wave:

- **Pre-production: no data migration is owed.** Violating rows may be deleted, but **count and report** them in the PR.
  Per-database counts are in `existing-violations.md`, so a PR can cite its own baseline.
- **The migration-safety gate refuses an unannotated tightening.** Every `SET NOT NULL` / new FK on an existing column
  needs #2471's `constrain` annotation, with a reason of at least five words that says *why* and agrees with the newest snapshot. See the
  array-column side finding above: for those 22 columns the snapshot already says `NOT NULL`.
- **Prove the constraint rejects before annotating it** (the #2470 / #2484 bar). `probe.sql` is that proof, ready-made.
  Re-run it after the migration: the wave's lines must flip from ACCEPTED to REJECTED, naming the new constraint, and
  nothing else may flip.
- **`NOT NULL` before composite FK** (finding 3). Otherwise the composite is skipped exactly when it matters.
- **Producers before columns** (#2464's rule). A `NOT NULL` that a live producer still violates turns a silent bug into
  an outage. The producer issue named for each wave must land first.

### Wave 1 — case-management join edges (highest value)

**Tables:** `case_contacts`, `case_events`, `report_cases`, `report_events`, `evidence` (`case_id`, `file_id`),
`custody_entries.evidence_id`, `case_interactions.case_id`, `group_members`, `contact_relationships`. **Prerequisites:**
`UNIQUE (id, hub_id)` on `contacts`, `events`, `files`, `affinity_groups`; `case_records.hub_id` NOT NULL + FK (blocked on the
#2461 producer, hub-`''` records: 22 in one dev DB); `files.hub_id` NOT NULL (#2486).

**Why first:**
- It is where **subjects get fabricated**: #2465's evidence chain, and every "the test passes with its subject absent"
  finding, has a bare-text join edge under it. With these FKs, a fixture that invents a record, contact, event, report
  or file **fails at INSERT**, which turns that vacuous class into real tests. `access-control-epic-e.steps.ts:170` must flip
  from "set up a cross-hub link" to "assert it is refused".
- It closes **seven service paths that check by bare id only** (the table above) structurally, without a per-handler check.
- `evidence` and `custody_entries` are the **chain-of-custody** tables, where an orphan or cross-hub row is an integrity
  defect in its own right.

**Already owned:** #2464 lists these edges under "Unenforced hub-parent edges". **Its scope is narrower than needed**:
its fix order ("set NOT NULL plus an FK to hubs") addresses the hub column, and plain FKs here would still accept every
cross-hub row (finding 2). The join tables need a `hub_id` **added** and composite FKs. #2486 owns
`VALIDATE` on `evidence.file_id`. **It is also narrower than needed**: validation closes orphans, not the hub-B-file-on-hub-A-record
case (probe 117).

### Wave 2 — the typed interaction source (closes #2509 structurally, and part of #2499)

**Change:** replace `case_interactions.source_id` + free-text `interaction_type` with `#2484`'s shape: a typed
`source_kind`, one nullable column per kind (`source_note_id`, `source_call_id`, `source_conversation_id`), a CHECK that
exactly the column matching the kind is set, and composite FKs `(source_x_id, hub_id)`. **Prerequisites:** a
`hub_id` on `case_interactions` (or derive through `case_id` with a composite FK), plus `UNIQUE (id, hub_id)` on `notes` and
`(call_id, hub_id)` on `call_records`. Bring `'report_conversion'` into the protocol enum or out of the service.

**Why:** #2509's fix direction is "filter by hub at the query". That is necessary, but the row it would filter can still
**link a hub-B source to a hub-A record** (probes 291–293). This wave makes that row unrepresentable, so the scoped query
is the only possible answer rather than one well-behaved caller. It also makes "a note-typed interaction naming a call"
(probe 294) unrepresentable, which is #2499's type confusion at the storage layer. **Owned by #2509 (query half);
its current scope is narrower than the map shows is needed** (it does not touch the edge itself).

### Wave 3 — hub FK on every hub-owned table (prerequisite for all composite FKs; stops hub-deletion residue)

**Change:** `FOREIGN KEY (hub_id) REFERENCES hubs(id) ON DELETE CASCADE`, plus `NOT NULL` where the #2463 ruling says
hub-owned, on the 36 FK-less `hub_id` columns. The **17 `NOT NULL`, no-default tables** listed in finding 1 have no
producer blocking them. Wave 3a can go **now**, as **one annotated migration**. The rest are blocked on their producer
issues: #2460 (`active_calls`, `call_records`, `call_tokens`, `provider_recordings`), #2461 (`case_records`, `events`, `shifts`),
#2194 (`invite_codes`), #2404 (`blasts`, `subscribers`), #2463 (platform-scope rows and `''` type definitions).

**Why:** without it, a composite FK is undefined for NULL/`''` hubs (finding 3), and a hub deletion leaves its rows
behind: 345 `active_shifts`, 69 `hub_recovery_groups`, 58 `recovery_sessions`, 18 `ring_groups` and 36 `invite_codes` already do. The
hub shred has to enumerate those tables by hand instead of getting `CASCADE`. **Already owned by #2464 for its listed
columns. The 17 tables of 3a are not in #2464 and are unowned.**

### Wave 4 — calls ↔ notes ↔ conversations

**Tables:** `notes.call_id`, `notes.conversation_id`, `provider_recordings.call_id`, `signal_message_queue.conversation_id`.
**Prerequisites:** `call_records.hub_id` NOT NULL (**#2460**), `UNIQUE (call_id, hub_id)`. **Evidence it matters:** 69
notes in one dev DB, and 49 in another, reference a **hub-`''` call** from a hubbed note. That is #2460's bucket, visible from
the notes side. Fixtures with fabricated `callId`s (`network-security.steps.ts:291`, `security.steps.ts:716`) become
honest. **Owned (producer) by #2460.**

### Wave 5 — ring set and scheduling (composite where a plain FK exists today)

**Tables:** `shifts.ring_group_id`, `shift_overrides.shift_id`, `shift_join_requests.shift_id`, `ring_group_members`
(pure child, ✓), `push_reminders_sent.shift_id` (plain FK), `contact_team_assignments` (both edges), `blast_deliveries`.
**Prerequisites:** `UNIQUE (id, hub_id)` on `shifts`, `ring_groups`, `teams`, `blasts`, `subscribers`. **Why:** a hub-A
shift can name a hub-B ring group (probe 253), and `ShiftsService.create` passes `ringGroupId` through unchecked. Approving
a join request then writes a hub-A user into hub-B's group. That puts **the ring set of a call** in another hub, the
same harm #2460 describes for hub `''`. It is small and could move up if the operator weighs ringing above case data. **Unowned.**

### Wave 6 — self and sibling edges, type definitions, firehose

`case_records.parent_record_id` / `merged_into_id`, `events.parent_event_id`, `contacts.merged_into_id`,
`files.message_id` (composite onto `messages (id, conversation_id)`), `firehose_message_buffer.window_key_id`
(plain FK) and `.extracted_report_id`, and the `*.entity_type_id` / `report_type_id` edges (**blocked on the #2463 ruling**
about `''` platform-default types). Decide whether to drop or keep the shadow arrays `case_records.event_ids` / `report_ids` and
`messages.attachment_ids`. They cannot be constrained, and `event_ids` / `report_ids` duplicate `case_events` / `report_cases`.

### Not a wave — rulings needed

- **Person edges** (section C): live-membership vs attribution, and whether hub membership becomes relational. Until it
  does, "member of this hub" cannot be a constraint.
- **Identity-layer device ids** (section D): no referent table exists. That belongs with #2496.
- **`files.owner_kind = 'entity_field'`** names no parent at all (probe 302): a field file in hub A belongs to no
  record. **#2486's scope is narrower than needed here too.** `SET NOT NULL` on `owner_kind` does not give an
  entity-field file an owner.

## Cross-reference: already-owned entries

| Issue | Owns | Scope vs. this map |
|---|---|---|
| #2464 | nullable `hub_id` + `DEFAULT ''` columns; lists the case join edges as unenforced | **Narrower.** It omits 17 `NOT NULL` FK-less `hub_id` tables, and plain FKs on the join edges would not stop cross-hub rows |
| #2486 | `files` `SET NOT NULL`, `VALIDATE` `evidence.file_id`, drop `files_fill_hub` | **Narrower.** It does not cover the evidence cross-hub file (117), `files.case_record_id` lacking a standalone FK (298, 301), or the parentless `entity_field` (302). Its `SET NOT NULL` is what makes #2484's composites effective (finding 3) |
| #2496 | `devices.x25519_pubkey` uniqueness + possession | Confirmed: no unique index exists. The identity-layer device-id edges (section D) are adjacent |
| #2509 | `getBySource` hub filter | **Narrower.** The edge stays polymorphic and cross-hub representable (Wave 2) |
| #2461 | unscoped `/:id` handlers; hub-`''` records/events/shifts | Producer for Waves 1, 3, 5. Needs `case_records` / `events` / `shifts` `hub_id` NOT NULL + FK afterwards |
| #2460 | hub-`''` calls | Producer for Waves 3 and 4 |
| #2463 | platform-scope ruling | Gates the type-definition edges and the platform-scope `hub_id` columns |
| #2465 (closed) | hubless fixtures | Wave 1 makes its class (a fabricated subject) fail at INSERT |

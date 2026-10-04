# Hub deletion by crypto-shred — design

**Date:** 2026-10-03
**Status:** awaiting review
**Related:** #1502 (cascade defect), #1133 (demo reset), #1042 / `origin/fix-1042` (hub-key lifecycle), Epic 77 (hash-chained audit log)

## 1. Decision, and why

"Delete this hub" destroys the keys, not the rows.

- **Fast and atomic.** Destroying wraps is bounded by the number of envelope-bearing
  rows, not by a cascade across millions of rows and FK constraints.
- **Provably irreversible.** Row deletion is undone from a backup. A destroyed wrap
  cannot be reconstructed, so every backup of the ciphertext stays useless.
- **It does not break the audit chain.** Deleting audit rows destroys the
  tamper-evidence Epic 77 exists to provide; a gap in a hash chain is
  indistinguishable from tampering. Shredding nulls the *contents* while leaving
  `entry_hash` and `previous_entry_hash` intact, so the chain still validates and
  still commits to what was originally logged.

Three distinct operations, not one:

| Operation | Effect | Reversible |
|---|---|---|
| **Archive** | hub goes read-only and stops routing; keys untouched | yes |
| **Shred** | hub key wraps and every content-key envelope destroyed | only inside the window |
| **Purge** | rows deleted | no — **out of scope**, §8 |

## 2. Scope of this spec

In scope: hub archive given real meaning; hub shred with a 48-hour undo window and
a co-approved force override; extension of the existing erasure tables to hub scope;
making hub-deletion failure loud.

Out of scope: a true purge (§8); fixing `files.conversation_id`'s FK (#1502, §9);
wiring hub-key rotation on member departure (§10 — reported, not fixed here).

## 3. Build on what exists

Nothing here is a new mechanism.

| Existing | Reused as |
|---|---|
| `hubs.status` (`apps/worker/db/schema/settings.ts:72`) | archive and shred are status transitions |
| `settings.archiveHub` (`services/settings.ts:2011`) | archive, given enforcement |
| `erasure_requests` (`db/schema/erasure.ts:19`) | the shred request itself: `execute_at`, `cancelled_at`, `emergency_override`, `co_approver_pubkey`/`_signature`, `justification`, `status` |
| `erasure_config.delay_hours` (`:48`) | the window, per hub, with a platform floor |
| `re_encryption_jobs` (`:66`) | the envelope walk, with `total_envelopes`/`processed_envelopes` |
| `erasure-expiry-worker` (`lib/erasure-expiry-worker.ts`) | the scheduler, one loop for both scopes |
| `LABEL_ERASURE_OVERRIDE_SIG` + admin-device check (`services/erasure.ts:178-205`) | co-approval, verbatim |
| `retention_platform_floors` (`db/schema/retention.ts:37`) | the floor the override unlocks |
| `audit_log.erased_at` + `verifyChain`'s skip (`services/audit.ts:434`) | audit shred without breaking the chain |
| `assertCoversExactly` (`origin/fix-1042`) | the completeness assertion pattern |

**Crypto-shredding is already this codebase's erasure mechanism.** `executeErasure`
calls its own phase 3 "Crypto-shredding" and destroys `audit_user_keys`,
`puk_envelopes` and `hub_keys` rows rather than deleting content. Hub scope is an
extension of that, not a parallel system.

## 4. The complete shred set

Getting this wrong means data that looks shredded and is not. The set is organised by
*which key protects the data*, because that decides the destruction primitive.

### Class A — hub-key-sealed: destroy the wraps and bump the generation

The hub key is random bytes, HPKE-wrapped once per member into `hub_keys`
(`settings.ts:99`). It exists nowhere else server-side.

```
DELETE FROM hub_keys WHERE hub_id = $1;
UPDATE hubs SET hub_key_generation = hub_key_generation + 1 WHERE id = $1;
```

Covers every Tier-3 column sealed under that key: `tags.encrypted_label` /
`encrypted_category`, `teams.encrypted_name` / `encrypted_description`, and client-local
drafts/exports (`HKDF_CONTEXT_DRAFTS`, `HKDF_CONTEXT_EXPORT`).

**The generation bump is load-bearing, not bookkeeping.** Without it a replayed
`PUT /hubs/:hubId/key` carrying cached envelopes re-installs the shredded key and
undoes the shred. `origin/fix-1042` adds `hubs.hub_key_generation` and the
`expectedGeneration` guard that makes such a write a 409. Shred additionally refuses
*any* hub-key write to a hub in state `shredded`.

> **Columns named `encrypted_*` that are not.** `ring_groups.encrypted_name`,
> `shifts.encrypted_name`, `shift_overrides.encrypted_note` and
> `user_availability_blocks.encrypted_reason` are written as plaintext —
> `src/client/routes/shifts.tsx:358` passes the raw input straight through, and no
> `encryptHubField` call exists for any of them. They are therefore **not** protected
> by Class A today and a shred leaves them readable. This is a pre-existing
> encryption gap, not one shred introduces; it gets its own issue. Class A covers
> them automatically the day they are actually encrypted.

### Class B — per-row recipient envelopes: clear the envelope columns

There is no `items_key` table. The documented `PUK → items_key → content key` chain is
unwired (consistent with the identity layer having no call sites), so in practice each
row's content key is HPKE-wrapped **directly to each reader's pubkey** in a jsonb
column on that row. Destroying the hub key does *not* make a note unreadable. These
columns are the shred.

Rows and ciphertext stay; only the wraps go.

Reached directly by `hub_id`:

| table | columns |
|---|---|
| `notes` | `author_envelope`, `admin_envelopes`, `field_envelopes` — **also the transcript store** (`services/transcription.ts:56`) |
| `call_records` | `admin_envelopes` |
| `case_records` | `summary_envelopes`, `field_envelopes`, `pii_envelopes` |
| `events` | `detail_envelopes` |
| `contacts` | `summary_envelopes`, `pii_envelopes` |
| `contact_relationships` | `notes_envelopes` |
| `affinity_groups` | `detail_envelopes` |

Reached through a parent (no `hub_id` of their own):

| table | via | columns |
|---|---|---|
| `note_replies` | `notes` | `reader_envelopes` |
| `messages` | `conversations` | `reader_envelopes` |
| `files` | `conversations` | `recipient_envelopes`, `encrypted_metadata` |
| `contact_identifiers` | `conversations` | `encrypted_identifier` |
| `case_interactions` | `case_records` | `content_envelopes` |
| `evidence` | `case_records` | `description_envelopes` |
| `report_cases` | `case_records` | `notes_envelopes` |

**Plus the blob-store copy of the file wraps.** `routes/uploads.ts:264-265` mirrors
every file's envelopes and metadata into object storage at `files/<id>/envelopes` and
`files/<id>/metadata`. Clearing the database column alone leaves a fully usable wrap in
RustFS. Shred deletes both objects for every file in scope. This is the single
easiest member of the set to miss, so it has a dedicated breaking test (§7.6).

`contact_identifiers.encrypted_identifier` is sealed with a **server** HMAC secret
(`services/conversations.ts:551`), not a reader envelope, so clearing the column is the
only way to destroy it — key destruction cannot help.

### Class C — server-key-sealed hub data: delete the row

The sealing key is global, so the row itself must go.

- `hub_storage_credentials` — `encrypted_secret_key` grants raw blob access. Delete the
  row **and** destroy the IAM user and bucket via `StorageManager.destroyHub`
  (already called by the delete route, `routes/hubs.ts:325`).
- `provider_configs.credentials`, `signal_registrations`, `a2p_registrations` — hub-scoped
  provider secrets.
- `firehose_connections` (`sealed_agent_key`, DB column `encrypted_agent_nsec`),
  `firehose_window_keys.sealed_key`, `firehose_message_buffer` — the agent seal key is
  the root above every per-window content key.
- `subscribers.encrypted_identifier` — server-sealed, hub-scoped.

### Class D — key-recovery paths: the part a careless shred forgets

`recovery.ts` holds a K-of-N threshold scheme. **Destroying `hub_keys` while leaving
these behind is not a shred** — a threshold of holders reconstructs the hub recovery
secret.

- `hub_recovery_group_shares.share_envelope` (per holder)
- `hub_recovery_groups` (`group_public_key`, `share_commitments`, `duress_commitments`)
- `user_recovery_envelopes WHERE hub_id = $1` — per user *per hub*, so hub-scoped and safe
- `recovery_sessions` + `recovery_session_contributions` for the hub — in-flight recovery
- `mls_pending_messages WHERE hub_id = $1` — KeyPackages and Welcomes; MLS epoch secrets
  derive the SFrame media keys for encrypted voice

### Class E — audit: null the content, keep the chain

```
UPDATE audit_log
   SET details = NULL, actor_pubkey = '[shredded]', erased_at = NOW()
 WHERE hub_id = $1;
```

`entry_hash` and `previous_entry_hash` are never touched. Chains are per hub plus one
platform chain at `hub_id IS NULL` (`services/audit.ts:11`), so this reaches no other
hub's chain. `verifyChain` skips re-hashing a row with `erased_at` set and still checks
its linkage (`audit.ts:435`) — the same escape hatch user erasure already uses.
`entry_hash` survives as a commitment to the original content, so the chain remains
tamper-evident about what *was* logged while being unreadable.

`actor_pubkey` is scrubbed because after a shred it would be the last remaining proof
of who was a member of that hub — implicating in exactly the way the project's
encryption scope is meant to prevent. This follows erasure's `'[erased]'` precedent.

The shred itself appends `hubShredded` to the **platform** chain, which is not shredded.

### Class F — hub bearer tokens

`call_tokens` and `invite_codes` for the hub are deleted. #1502 notes `purgeHub` misses
`call_tokens`; shred must not.

### What shred must NOT touch — the sharpest hazard

A user is a member of many hubs and their PUK is shared across all of them.

**Never:** `puk_envelopes`, `user_role_envelopes`, `audit_user_keys`, `sigchain_links`,
`devices`, `webauthn_credentials`, `sessions`, `provision_rooms`,
`platform_role_envelopes`, `roles.encrypted_name` / `encrypted_description`,
`user_signal_contacts`, `entity_type_templates`, and the `users` row itself.

This is **a correction to the brief**, which named "role envelopes, PUK envelopes" as
shred targets. The schema says otherwise: `puk_envelopes` is keyed
`(user_pubkey, device_id)` (`puk-envelopes.ts:24`) and `user_role_envelopes` is keyed
`(user_pubkey, role_id)` with `roles` global (`role-envelopes.ts:29`). Neither has a hub
column. Deleting either to shred hub A locks the same user out of hub B. They are
correctly deleted by **user** erasure, which is a different scope.

Shred touches a user row in exactly one way: it filters the shredded hub out of
`users.hub_roles`, the array update `purgeHub` step 2 already performs. It never
deletes a user. `purgeHub`'s step 1 — deleting users whose only hub this was — is
**not** part of shred: that account keeps its device keys, PUK and sigchain, and its
right to erasure is a separate request (§6.2).

`entity_type_templates.encrypted_definition` is documented as hub-key-sealed but the
table has **no `hub_id`** (`entity-type-templates.ts:15`), so which hub's key sealed it
is undeterminable. It is excluded and flagged.

### Rows with a NULL hub_id are not shredded

`notes`, `call_records`, `case_records`, `events`, `subscribers`, `blasts`,
`active_calls` and `shifts` all permit a NULL `hub_id`. Such a row is not attributable
to any hub, so no hub-scoped sweep can reach it. Shred does not reach them, states so,
and gets its own issue; it does not guess.

Tracked as #1530 — "envelope-bearing rows with a NULL hub_id are unreachable by
hub shred and by hub purge".

### Isolation as a checked invariant, not careful review

Every statement is generated from one declaration, `HUB_SHRED_TARGETS`, in which each
entry is exactly one of two shapes:

```
WHERE hub_id = $1
WHERE <fk> IN (SELECT id FROM <parent> WHERE hub_id = $1)
```

A unit test asserts that every entry matches one of those shapes, and that no entry
names a table on the `CROSS_HUB_TABLES` deny-list above. "Do not touch another hub's
keys" becomes a property the suite enforces rather than something a reviewer must spot.

## 5. Lifecycle

`hubs.status` gains two values — `shred_pending` and `shredded` — in
`packages/protocol/schemas/hubs.ts:12`, regenerated to Swift and Kotlin via `bun run codegen`.

```
active ──archive──▶ archived ──unarchive──▶ active
   │                   │
   └────── shred ──────┴──▶ shred_pending ──cancel (≤48h)──▶ previous status
                                  │
                                  └── window elapses, or force ──▶ shredded  (terminal)
```

- **`POST /hubs/:hubId/shred`** (`system:manage-hubs`) inserts an `erasure_requests` row
  with `scope='hub'`, `hub_id`, `execute_at = NOW() + erasure_config.hub_shred_delay_hours`,
  and sets the hub to `shred_pending`. A hub in `shred_pending` or `shredded` is a 409.
- **`DELETE /hubs/:hubId/shred`** cancels within the window: sets `cancelled_at`,
  `status='cancelled'`, and restores the hub's previous status. Full readability returns
  because nothing was destroyed — the window is a delay, not a staging area.
- **`shred_pending` is already read-only**, enforced by the same middleware as archive.
- The existing **`DELETE /hubs/:hubId`** becomes the shred entry point rather than
  `purgeHub`. `purgeHub` stays, called only by demo reset (§9).

### Clocks

`erasure.getExpiredPendingRequests` currently compares `execute_at` to a
JavaScript `new Date()` (`services/erasure.ts:409`). Both `execute_at` computation and
the expiry comparison move to `NOW()` / `sql` interval arithmetic so the boundary is
decided by the database clock for **both** scopes. The window tests set `execute_at`
directly in SQL rather than sleeping or faking the app clock.

## 6. The three tensions

### 6.1 Retention floors vs. erasure

`retention_platform_floors.min_retention_days` is a platform-wide minimum a hub cannot
go below. An immediate shred of a hub holding records inside their retention window
breaks that promise.

The 48-hour window is a safety delay, not a retention claim, so the normal path needs
no check beyond it. The floor is checked **at execute time, per category**: the executor
reads `RetentionService.getFloors()` and refuses with 409 if any category still holds
records inside its floor — unless the request carries `emergency_override = true` with a
co-approver signature verified exactly as `createSelfRequest` already does
(`LABEL_ERASURE_OVERRIDE_SIG` over `label:subject:timestamp`, Ed25519, co-approver must
be a registered admin device, must not be the requester), gated by
`erasure_config.emergency_override_enabled`.

**One override concept, unlocking two things:** the window and the floor. There is no
second override flag and no second signature scheme.

### 6.2 Per-person erasure stays orthogonal

- A hub shred **does not** satisfy, cancel or reschedule any pending user erasure
  request. Each keeps its own `execute_at` and executes on time.
- A hub shred **does not orphan** one. Both operations only ever *remove* envelopes, and
  removal is idempotent, so they commute on every row they share. After a shred,
  `executeErasure`'s job-building query finds no `hub_keys` row and no envelopes for the
  shredded hub, so it enqueues nothing for it — correct, not an error. A
  `re_encryption_jobs` row targeting a `shredded` hub completes as a no-op rather than
  running updates against it.
- A user erasure **does not** shred a hub: it strips one pubkey's envelope from each row
  and leaves every other reader's intact.
- Both scopes live in `erasure_requests`, so the admin queue shows all scheduled
  destruction in one place.

### 6.3 Purge is out of scope but not foreclosed

See §8.

## 7. Proof

Real PostgreSQL throughout: `docker compose -f deploy/docker/docker-compose.dev.yml up -d`,
then `bun scripts/worktree-db.ts use-isolated` for this worktree's own database. The
shared `llamenos` database is the operator's running server and is never reset.

Gherkin in `packages/test-specs/features/security/hub-shred.feature` (`@backend`), steps
in `tests/steps/backend/`, plus integration tests under
`apps/worker/__tests__/integration/`.

1. **Shred actually shreds.** Seed a hub with a note, a conversation message and a call
   recording. Shred. Then read each **through the real decrypt path** — the note via
   `GET /notes/:id` decrypted as the admin *and* as the author, the message via the
   conversation route, the recording via its file envelope and the blob store. All must
   fail to produce plaintext. Asserting the envelope rows are gone is not the test.
2. **Hub isolation.** One user is a member of hub A and hub B, with a note of their own
   in each. Shred A. Reading their note in B still succeeds end to end; their
   `puk_envelopes`, `user_role_envelopes`, `devices`, `sessions` and `audit_user_keys`
   rows are byte-identical to before; `hub_keys` for B is untouched.
3. **The window, on both sides of the boundary.** Within 48h a cancel restores full
   readability of note, message and recording. Past it, the hub is `shredded` and a
   cancel is a 409. The boundary is moved by setting `execute_at` in SQL, so the
   **database** clock decides.
4. **The force override.** `emergency_override` with a valid co-approver signature
   executes without the window. Missing signature → 400; co-approver who is not an
   admin device → 403; co-approver equal to the requester → 400;
   `emergency_override_enabled = false` → 403.
5. **Audit chain survives.** `verifyFullChain(hubId)` returns valid after the shred,
   `totalEntries` unchanged, every `details` null, every `erased_at` set; the platform
   chain also validates and carries the new `hubShredded` entry.
6. **Verify by breaking it.** Each mutation must turn a test red; if any does not, that
   test is asserting the wrong thing.
   - Drop `files` from `HUB_SHRED_TARGETS` → the file's content key is still unwrappable → §7.1 red.
   - Keep the `files/<id>/envelopes` blob objects → the DB column is clear but the wrap is still in RustFS → §7.1 red.
   - Drop `hub_recovery_group_shares` → a threshold reconstructs the hub key → §7.1 red.
   - Omit the `hub_key_generation` bump → a replayed `PUT /hubs/:hubId/key` resurrects the key → a replay test red.
   - *Add* `puk_envelopes` to the set → §7.2 red. (The inverse direction: the isolation test must catch over-reach, not just under-reach.)
7. **Failure is loud.**
   - `deleteHubViaApi` (`tests/api-helpers.ts:268`) **throws** on any non-2xx instead of
     `console.warn`ing. This is the in-scope part of #1502 — a hub that fails to delete
     must not look like one that deleted. Teardown callers that currently wrap it in
     `.catch(() => {})` are reviewed individually: swallowing in teardown is what hid the
     defect for two releases.
   - Each phase runs in one transaction. Any failure marks the request `failed` via the
     existing `markFailed` and leaves the hub `shred_pending` — never `shredded`. A
     partially shredded hub is never reported as shredded.
   - After the walk, the executor asserts **zero** in-scope rows retain a non-empty
     envelope and `hub_keys` for the hub is empty, rolling back if not. This mirrors
     `assertCoversExactly` from `origin/fix-1042`: completeness is checked, not assumed.

## 8. Purge, later — and how not to leave a gap

A true purge deletes rows. The audit chain is the one thing that cannot simply be
deleted, because an absence is indistinguishable from tampering.

The forward design, recorded so shred does not foreclose it: a purge **terminates** the
hub's chain by appending a final signed `hubChainTerminated` entry to the **platform**
chain (`hub_id IS NULL`), whose `details` carry the terminated chain's length, first
entry hash and tip hash. Verifying the platform chain then proves the hub chain existed,
how long it was and where it ended — the absence is accounted for rather than a hole.
Only then are the hub's rows deleted.

Shred keeps this available because it never deletes an audit row and never alters a hash.

## 9. Consequence for #1502 and #1133

#1502 reports `files.conversation_id` as `ON DELETE no action` where its siblings cascade,
so row deletion of a conversation is blocked outright.

**Shred-by-default makes that much less urgent for hub deletion** — shred deletes almost
nothing and never deletes a conversation, so the broken FK is not on its path. But the FK
**still matters for demo reset (#1133)**, which needs real deletion: `purgeHub` is called
by `services/demo-seeder.ts:110,369` and `routes/dev.ts:774`, and those paths depend on
the cascade actually cascading. #1502 is **not fixed here** and must not be closed by this
work. `purgeHub` is left in place as the demo-reset path.

## 10. Findings reported, not fixed here

1. **Member departure does not rotate the hub key on `main`.** `rotateHubKey`
   (`src/client/lib/hub-key-manager.ts:106`) has zero production callers — only its own
   test. `CLAUDE.md` states rotation on departure "excludes departed member", so the
   documented guarantee does not hold: a departed member's wrap still decrypts hub
   content. Separate defect, separate blast radius.
2. **`origin/fix-1042` already contains the wiring**, unmerged and never PR'd: server-side
   `rotateHubKey` with an atomic commit and a `hub_key_generation` guard
   (`settings.ts`), `use-hub-key.ts`, and departure rotation called from
   `src/client/routes/users.tsx`. It is substantial (12,963 insertions, 37 files).
   Two observations for whoever sequences it:
   - Its departure rotation runs **client-side**, in a React handler. A rotation that the
     operator can interrupt by closing the laptop cannot be trusted to complete. Its own
     transactional design makes an interrupted rotation safe (the hub stays readable
     under the old key), but it also means departure rotation silently does not happen
     when no admin device is present.
   - Its `assertCoversExactly` covers only `tags` and `teams`. That is correct **today**
     precisely because the other `encrypted_*` columns are not actually encrypted
     (§4 Class A), and becomes wrong the moment they are.
     Tracked as #1506 — "encrypted_name columns hold plaintext for ring groups and
     shifts, while the same field name holds a real envelope elsewhere".
3. **Sequencing.** Shred needs `hubs.hub_key_generation` and a server-side refusal of
   hub-key writes to a shredded hub. Preferred: land `fix-1042` first and build on it. If
   it is not sequenced ahead, this work adds only the column and the refusal guard — not
   the rotation feature — so the two do not collide.
4. **The repeating pattern.** `rotateHubKey` is the same shape as `cancelRinging` (seven
   adapter implementations, no call sites), `CallsService` without its `ShiftsService`,
   and the sigchain/PUK layer. Capability built, tested in isolation, connected to
   nothing. Reaching for a primitive here means checking first whether it is already
   present *and already unused*, and if so, why.

## 11. Archive, given meaning

`hubs.status` is a display label today — only `identity.ts:705` reads it, to resolve a
sole active hub for invite redemption. Archive must actually do something:

- hub-scoped mutating routes return 409 for a hub in `archived`, `shred_pending` or
  `shredded`, via one middleware beside `requirePermission`;
- inbound call and message routing skips non-`active` hubs, as do shift and ring-group
  routing;
- reads and decryption are untouched: `hub_keys` is intact, so an archived hub is fully
  readable;
- `suspended` keeps its present meaning; archive is reversible.

## 12. Strings

All user-facing text goes through `packages/i18n/locales/*.json` plus
`bun run i18n:codegen`, never into a platform file directly. New keys sit beside the
existing `hubs.deleteHub*` family, which the desktop confirm dialog already uses
(`src/client/routes/admin/hubs.tsx:336-366`): shred confirmation naming the window,
the pending-shred banner with its deadline, the cancel action, the force-override
co-approval prompt, archive/unarchive, and the retention-floor refusal.

## 13. Files expected to change

- `apps/worker/db/schema/erasure.ts` — `scope`, `hub_id`, nullable `user_id` + CHECK on
  `erasure_requests`; `hub_shred_delay_hours` on `erasure_config`; `scope` on
  `re_encryption_jobs`
- `apps/worker/services/erasure.ts` — hub-scope request lifecycle, DB-clock expiry
- `apps/worker/services/hub-shred.ts` *(new)* — `HUB_SHRED_TARGETS` and the executor
- `apps/worker/services/settings.ts` — archive/status transitions; refuse hub-key writes to a shredded hub
- `apps/worker/routes/hubs.ts` — shred, cancel, archive; `DELETE /hubs/:hubId` → shred
- `apps/worker/middleware/` — non-active hub write guard
- `apps/worker/lib/erasure-expiry-worker.ts` — claim hub-scope requests too
- `packages/protocol/schemas/hubs.ts`, `packages/protocol/schemas/erasure.ts` — status values, request/response shapes
- `packages/i18n/locales/*.json` — §12
- `src/client/routes/admin/hubs.tsx`, `src/client/lib/api/hubs.ts` — shred/cancel/archive UI
- `tests/api-helpers.ts` — `deleteHubViaApi` throws
- `packages/test-specs/features/security/hub-shred.feature`, `tests/steps/backend/`,
  `apps/worker/__tests__/integration/`
- `drizzle/migrations/` — one migration

## 14. Decisions taken at review

Resolved 2026-10-04. Recorded here so a later reader does not mistake any of them for
an oversight.

1. **Force override sets `execute_at = NOW()`, diverging from `EMERGENCY_MIN_HOURS = 4`.**
   Accepted. An override that still waits four hours is not an override, and that
   4-hour floor exists for a different operation with a different rationale; it stays a
   user-scope constant. **The co-approval requirement is unchanged** — the override skips
   the *wait*, never the *second pair of eyes*. A forced shred therefore still needs a
   valid Ed25519 co-approver signature over `LABEL_ERASURE_OVERRIDE_SIG`, from a
   registered admin device that is not the requester, with
   `erasure_config.emergency_override_enabled` true.
2. **`audit_log.actor_pubkey` is scrubbed.** Accepted. Who-did-what inside a hub that has
   been deliberately destroyed is exactly the implicating data the shred exists to
   remove, and in this product a pubkey is a person. The chain's value here is
   tamper-evidence, which survives intact: no hash is ever touched and `erased_at` is
   stamped. Attribution within a shredded hub is not worth retaining at the cost of the
   thing being shredded.
3. **`re_encryption_jobs` is reused under its wrong name.** Accepted for this change —
   renaming a table mid-feature is scope creep and a migration risk. Follow-up issue **#1527** is filed, because a name asserting a property the code lacks is the pattern catalogued in
   #1495, and this one already misled the author of this spec.

## 15. A note on evidence

`fleet/verify` has been judging PRs against the **base's** workspace packages (#1525,
fix in #1526). Any test here that resolves a bare `@llamenos/*` specifier can therefore
go green under the gate for the wrong reason. The evidence for every claim in §7 is a
**local run against real PostgreSQL on this worktree's isolated database**, and that is
what the PR will cite — not a green check.

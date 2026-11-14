# The 31 unconsumed crypto labels: where each data class actually goes

**Issue:** #2774 · **Audited:** `main` @ `7b21d911e` (2026-11-14) · **Source finding:** C14 of the crypto
simplification audit (`2026-11-14-crypto-simplification-audit.md`, PR #2763)

The crypto simplification audit found 31 of the 109 labels in `packages/protocol/crypto-labels.json`
with no reference outside `packages/crypto/src/labels.rs`. An unconsumed label is **not dead code**.
Each label was added for a data class someone meant to protect, so a label with no consumer means
the protection was designed and never wired. This document answers, for each of the 31, where that
data actually goes today.

Nothing here changes code. No label is deleted, no registry slot is tombstoned, and `LABEL_REGISTRY`
order is untouched. Wiring any of these labels is a wire-format change that needs its own reviewed
PR per data class. The issues below are those PRs' briefs.

## Method

1. **Absence, both ways.** For each label, search for its constant name and its string value over the
   whole tree, excluding `node_modules`, `generated/`, `target/` and `docs/`. A data class can be
   protected with a raw literal or under a different label, so the string search matters as much as
   the name search. Swift and Kotlin use the same constant names (`CryptoLabels.LABEL_*`), so one
   search covers them. Every hit for all 31 was in one of: `labels.rs`, the wire snapshot, the
   generated `packages/shared/crypto-labels.ts`, the label-equality tests (`crypto-labels.test.ts`,
   `tests/crypto-interop.spec.ts`, `packages/crypto/tests/interop.rs`), the HPKE test mock, or
   docs/CI comments. Two labels had a raw-literal hit in **tests**, noted against them below.
2. **Presence, by data class.** An empty search is "no consumer found", not "plaintext". For each
   label I then traced the data class itself: the DB column, every client write site, the wire
   schema, the server route and service, and the read and render sites. That gives one of three states:
   - **S1: protected under another label.** The label is vestigial. I also check that the label
     actually used separates this data from its neighbours; a mismatched label is its own finding.
   - **S2: in the clear.** A privacy bug, filed with its write path, read path, readers and target label.
   - **S3: the feature does not exist yet.** One line saying so.
3. **Observed values.** Where a sample could be observed and not just inferred, I observed it:
   - The roles table in a running stack (`prove-e2e-postgres-1`) holds `name`, `slug` and
     `description` in plaintext, with `encrypted_name` null.
   - #1876 records `shifts.encrypted_name = "Audit Shift UI"`, observed through the shipped desktop UI.
   - `apps/ios/Tests/UI/ShiftAdminUITests.swift:166-172` asserts that the server returns the typed
     ring-group name verbatim.

   For the iOS-only free-text fields (#2777, #2778), the evidence is the traced wire path: the client
   puts the typed string into the request body, the schema is `z.string()`, and the service inserts it
   unmodified. I did not write rows into another worker's live database to observe them.

## Summary

| State | Count | Labels |
|---|---|---|
| **S2: in the clear** | 7 | `LABEL_SHIFT_NAME`, `LABEL_RING_GROUP_NAME` (#1876) · `LABEL_AVAILABILITY_REASON` (#2777) · `LABEL_SHIFT_OVERRIDE_NOTE` (#2778) · `HMAC_CASE_STATUS`, `HMAC_CASE_SEVERITY` (#2779) · `LABEL_HUB_ROLE_ENCRYPT` (#2780) |
| **S2, by design / already tracked** | 1 | `HMAC_EVENT_TYPE` (type = plaintext `entityTypeId`; meaning leaks via #2191) |
| **S1: under another label, and the label is wrong for the data** | 2 | `LABEL_TRANSCRIPTION` (#2781) · `LABEL_EVENT_DETAILS` (iOS path; #1683) |
| **S1: under another label, correctly separated** | 12 | `HKDF_CONTEXT_NOTES`, `HMAC_SUBSCRIBER`, `RECOVERY_SALT`, `LABEL_SERVER_NOSTR_KEY`, `LABEL_SERVER_NOSTR_KEY_INFO`, `LABEL_SERVER_NOSTR_SIGNING_KEY`, `LABEL_SERVER_NOSTR_SIGNING_KEY_INFO`, `HMAC_CONTACT_NAME`, `NOSTR_EVENT_TAG`, `LABEL_PROVISION_PREFIX`, `LABEL_LOCKDOWN_INTENT`, `LABEL_FIREHOSE_REPORT_WRAP` |
| **S3: not built** | 9 | `LABEL_SHIFT_SCHEDULE`¹, `LABEL_CROSS_HUB_SHARE`, `HMAC_CONTACT_TAG`, `HMAC_CASE_CATEGORY`, `LABEL_ITEMS_KEY_EXPORT`, `LABEL_NOTE_EPOCH_KEY`, `LABEL_HUB_PTK_PREV_GEN`, `LABEL_MLS_PROVISION`, `LABEL_RECOVERY_LIVENESS_PROOF` (#2782: the endpoint is live and accepts any proof) |

¹ The field `LABEL_SHIFT_SCHEDULE` names does not exist, but two security documents claim it is
E2EE; see its row.

Total: 7 + 1 + 2 + 12 + 9 = 31.

## Per-label table

Paths are repo-relative; line numbers are against `7b21d911e`. "Registry" is the `LABEL_REGISTRY`
index, which is the wire `labelId` (from `packages/crypto/label-registry.wire.snapshot`, never from
the JSON).

### Shift and availability (EP07)

| Label · registry | State | Evidence |
|---|---|---|
| `LABEL_SHIFT_NAME` · 83 | **S2: #1876** | `shifts.encrypted_name` holds the typed name on all three clients. Desktop: `src/client/routes/shifts.tsx:956,967` (`ShiftForm`). Android: `apps/android/.../ui/admin/AdminViewModel.kt:869,905`, and `model/Extensions.kt:106-111` says outright that it is plaintext. iOS reads it raw (`Views/Shifts/ShiftsView.swift:356`). The server returns it (`apps/worker/services/shifts.ts:234-272`). The desktop render is at `routes/__root.tsx:370-372`. It survives a hub shred (`hub-shred-targets.ts:95-99`). |
| `LABEL_RING_GROUP_NAME` · 82 | **S2: #1876** | `ring_groups.encrypted_name`. Desktop has two writers: `components/shifts/ring-groups-panel.tsx:64` and `routes/shifts.tsx:377`. iOS: `ViewModels/ShiftAdminViewModel.swift:134,157`. Pinned by `apps/ios/Tests/UI/ShiftAdminUITests.swift:172`, which asserts the plaintext round-trips. Android has no ring-group UI. |
| `LABEL_SHIFT_OVERRIDE_NOTE` · 84 | **S2: #2778** | `shift_overrides.encrypted_note`. iOS sends the typed note (`ShiftAdminViewModel.swift:303-306`). The schema is `z.string()` (`schemas/shift-override.ts:28`) and the row is inserted verbatim (`routes/shifts.ts:247` → `services/shift-overrides.ts:85`). Rendered raw at `Views/Shifts/ShiftOverridesView.swift:148`. Desktop and Android send no note. The comment at `routes/shifts.ts:249-251` keeps the note out of the audit log "because it is ciphertext", which is false for iOS rows. |
| `LABEL_AVAILABILITY_REASON` · 81 | **S2: #2777** | `user_availability_blocks.encrypted_reason`. iOS sends the typed reason (`ViewModels/ShiftsViewModel.swift:319-321`). The schema is `z.string()` (`schemas/shift-availability.ts:21`) and the row is inserted verbatim (`routes/shifts.ts:341` → `services/shift-availability.ts:107`). Rendered raw at `Views/Shifts/ShiftsView.swift:302`. Readers are the author and every `shifts:manage` holder. Desktop and Android collect no reason. |
| `LABEL_SHIFT_SCHEDULE` · 7 | S3, plus a **false doc claim** | The field it names does not exist: `shifts` has no `encrypted_details` column (`apps/worker/db/schema/shifts.ts:18-37`), and no schema or client sends one. The routing fields (times, days, roster) stay plaintext because routing needs them. However, `docs/security/DATA_CLASSIFICATION.md:102` lists `encryptedDetails` as an **E2EE** shift field, and `docs/architecture/E2EE_ARCHITECTURE.md:44` says the same. Those documents claim a protection that is not there. (`docs/security/` is in the shared lane; this PR does not edit them.) |

### Content and CMS

| Label · registry | State | Evidence |
|---|---|---|
| `LABEL_TRANSCRIPTION` · 4 | **S1, wrong label: #2781** | Server-side transcripts are sealed with `encryptMessageForStorage` and its default `LABEL_MESSAGE`, with no AAD (`apps/worker/services/transcription.ts:57` → `lib/crypto.ts:178`). They are stored as `notes` (`createNote`, `authorPubkey: 'system:transcription'`) and opened with `decryptTranscription` = `decryptMessage` (`src/client/lib/platform.ts:1314-1319`). So a transcript is interchangeable with a conversation message, and is not bound to its call. The client-side WASM transcript path is correct: it is a normal note under `LABEL_NOTE_KEY` (`routes/index.tsx:458`). |
| `LABEL_EVENT_DETAILS` · 32 | S1, wrong label on iOS (#1683) | Desktop and Android events are **records** (`src/client/routes/events.tsx` → `EntityTypeFilteredRecordList`; Android `ui/events/EventsViewModel.kt:301`), sealed by `case_record.rs` under `LABEL_CASE_SUMMARY`/`LABEL_CASE_FIELDS` with AAD. That separation is correct. iOS still writes the deprecated `/api/events` table, sealed under `LABEL_MESSAGE` (`ViewModels/EventsViewModel.swift:354`, decrypt `:288`), and also sends the location in plaintext as `locationApproximate` (#1683 item 3). |
| `HMAC_CASE_STATUS` · 37 | **S2: #2779** | `statusHash` holds the plaintext status value on every client. Desktop: `components/cases/create-record-dialog.tsx:143-149`, whose comment says *"use the default status value as a simple hash for now"*. iOS: `Views/Cases/CaseListView.swift:722` and `CaseManagementViewModel.swift:490`. Android: `QuickStatusSheet.kt:81` → `CaseManagementViewModel.kt:390`. The server depends on the plaintext (`routes/contacts-v2.ts:589`, `routes/calls.ts:304`). Root cause: the crate's `blind_index` is not exported through UniFFI, WASM or IPC. |
| `HMAC_CASE_SEVERITY` · 38 | **S2: #2779** | `severityHash: selectedType.defaultSeverity` (`create-record-dialog.tsx:150`, `triage-case-creation-panel.tsx:97`). Read as plaintext at `routes/cases.tsx:623,771`, `case-detail.tsx:56` and Android `CaseDetailScreen.kt:425`. |
| `HMAC_CASE_CATEGORY` · 39 | S3 | No client writes `categoryHash`. The only references are the server's pass-through and filter (`apps/worker/services/cases.ts:91,209,290,504`). |
| `HMAC_EVENT_TYPE` · 40 | S2 by design, already tracked | The event's type is `entityTypeId`, plaintext on every record and needed by the server to resolve readers (`routes/records.ts:65-81`). iOS fills `eventTypeHash` with `entityType.id` (`EventsViewModel.swift:385`), which is the same plaintext UUID again, so there is no extra leak. What a type *means* leaks through the plaintext `entity_type_definitions` (#2191). A blind index alone cannot fix this without moving reader resolution off the type. |
| `HMAC_CONTACT_NAME` · 35 | S1 (iOS), correctly separated | The iOS `nameHash` and trigrams use the crate's construction: HKDF(salt `LABEL_BLIND_INDEX_KEY`, IKM hub key, info `LABEL_BLIND_INDEX_FIELD + "name"`) then HMAC (`ViewModels/ContactFormViewModel.swift:72-73,226-254`). The per-field info gives the domain separation, so this label is redundant with that scheme. Two side-findings, both carried in #2779: the Swift code **re-implements** crate crypto, and its canonicalisation **diverges** from it (`folding(.diacriticInsensitive, locale: .current)` is locale-dependent; Rust uses NFKD and strips U+0300–U+036F). Desktop and Android write no name index (`components/contacts/create-contact-dialog.tsx:137`). The desktop's former base64 "index" is gone (#2139). |
| `HMAC_CONTACT_TAG` · 36 | S3 | `tagHashes` is always empty: `contact-import-dialog.tsx:111`, `contact-merge-dialog.tsx:93`, iOS `tagHashes: nil`. Per `contacts/contact-profile.tsx:190`, contact tag assignment is not built. |
| `LABEL_CROSS_HUB_SHARE` · 34 | S3 | Cross-hub **listing** exists (`routes/records.ts:168-193`, `services/cases.ts:476-480`). It returns ciphertext that only existing envelope readers can open, so it adds no crypto. Re-wrapping a record for another hub's readers (a "share") is not built. |
| `LABEL_HUB_ROLE_ENCRYPT` · 79 | **S2: #2780** | Roles created through `admin-settings/roles-section.tsx:171-185` send `name`, `slug` (`autoSlug(name)`, `:159`) and `description` in plaintext. `POST /settings/roles/from-template` (`routes/entity-schema.ts:579-630`) writes template names server-side. Observed: the stack's `roles` rows show plaintext name, slug and description with `encrypted_name` null. Platform roles do seal name and description (`platform-roles-section.tsx:168`) but send the slug in the clear. `roles` has no `hub_id` (it is in `CROSS_HUB_TABLES`, `hub-shred-targets.ts:72`), so this label's "hub key" design needs a scoping decision first. |
| `LABEL_FIREHOSE_REPORT_WRAP` · 95 | S1, acceptable | Extracted reports are stored as the first message of a `type: 'report'` conversation, sealed with `encryptMessageForStorage` under `LABEL_MESSAGE` (`services/firehose-agent.ts:425-456`). The label matches its container, the messages table, so a server cannot move the report into a different *kind* of column. A dedicated label would also separate firehose reports from human-written messages. That is optional hardening, not filed. |

### Notes / PUK / MLS chain

| Label · registry | State | Evidence |
|---|---|---|
| `HKDF_CONTEXT_NOTES` · 9 | S1, vestigial | The "legacy V1 note encryption" HKDF context was superseded by per-note random keys HPKE-wrapped under `LABEL_NOTE_KEY` with AAD (`src/client/lib/platform.ts:1056-1100`). `decryptLegacyNote` is a stub that returns `null` (`platform.ts:1108-1113`). The project is pre-production, so no V1 rows exist. |
| `LABEL_ITEMS_KEY_EXPORT` · 47 | S3 | There is no items-key layer. `apps/worker/services/hub-shred-targets.ts:103` says *"There is no items_key table: each row's content key is HPKE-wrapped directly to each reader's pubkey."* The only "items-key" string in the crate is a test AAD (`hpke_envelope.rs:352`). |
| `LABEL_NOTE_EPOCH_KEY` · 48 | S3 | Same: there is no note-epoch key derivation. Part of the PUK → items_key → note-key cascade described in CLAUDE.md, of which only the PUK end exists (`puk.rs`; identity layer unwired). |
| `LABEL_HUB_PTK_PREV_GEN` · 49 | S3 | `derive_hub_ptk` exists (`packages/crypto/src/mls.rs:324-331`, `LABEL_HUB_PTK`). No generation chain or rotation wrap exists. |
| `LABEL_MLS_PROVISION` · 52 | S3 | MLS key packages are generated (`mls.rs:130`) and are public by design. No sealed MLS provisioning bundle exists. |
| `RECOVERY_SALT` · 22 | S1, vestigial | The recovery key derives through HKDF with a random per-backup salt and `LABEL_BACKUP_HKDF_INFO` (`packages/crypto/src/backup.rs:54,282`), not a fixed PBKDF2 salt. **Test misuse:** `tests/steps/backend/recovery-group.steps.ts:134,438,454,467` pass the raw literal `'llamenos:recovery'` when building fake share and PUK-seed envelopes. That is a raw label string, and the wrong label for those wraps (`LABEL_RECOVERY_GROUP_SHARE_WRAP`, `LABEL_RECOVERY_PUK_SEED_WRAP`). The fixtures are opaque to the server, so nothing breaks, but they model the wrong construction. |
| `LABEL_RECOVERY_LIVENESS_PROOF` · 76 | S3 on clients, **live endpoint accepts anything: #2782** | `submitLivenessProof` (`apps/worker/services/recovery-group.ts:1085-1117`) never reads `proof` (the schema is `z.string()`). No client calls `submitShareLivenessProof` (iOS `APIService.swift:999`, Android `ApiService.kt:559`). Three admin UIs show `lastLivenessProof` as holder health. |

### Server identity, transport, provisioning, lockdown, blasts

| Label · registry | State | Evidence |
|---|---|---|
| `LABEL_SERVER_NOSTR_KEY` · 24 | S1, vestigial | The server identity derives from `SERVER_SECRET` under `LABEL_SERVER_SIGNING_KEY`/`LABEL_SERVER_SIGNING_INFO` (`apps/worker/lib/server-identity.ts:25-26`). The Nostr relay was replaced by the WebSocket `ConnectionManager` (`lib/ws-events.ts`, "drop-in replacement for publishNostrEvent"). |
| `LABEL_SERVER_NOSTR_KEY_INFO` · 25 | S1, vestigial | Same derivation as the row above. |
| `LABEL_SERVER_NOSTR_SIGNING_KEY` · 61 | S1, vestigial | Same: the signing key is `LABEL_SERVER_SIGNING_KEY`. |
| `LABEL_SERVER_NOSTR_SIGNING_KEY_INFO` · 62 | S1, vestigial | Same derivation as the row above. |
| `NOSTR_EVENT_TAG` · 57 | S1, vestigial | Real-time events go through `publishEvent` → `ConnectionManager.publishToHub` (`lib/ws-events.ts`) and carry **no** `t` tag. Event content is keyed under `LABEL_SERVER_EVENT_ENCRYPTION_KEY` and `LABEL_HUB_EVENT_EPOCH`. Stale traces remain: `apps/worker/__tests__/unit/ws-events.test.ts:73,132` tests a **hand-mirrored** publisher that still emits `['t','llamenos:event']`, so it is not exercising the real module; `.github/workflows/ci.yml:3222-3235` exempts the literal from the raw-label check; `site/src/content/pages/*/features.md:225` still describes Nostr tags. |
| `LABEL_PROVISION_PREFIX` · 58 | S1, vestigial | Device provisioning is HTTP rooms (`apps/worker/routes/provisioning.ts`) under `LABEL_DEVICE_PROVISION`, `LABEL_DEVICE_PROVISION_BUNDLE` and `LABEL_DEVICE_PROVISION_CLAIM`. There are no per-room Nostr tags. `ci.yml:3235` still exempts the literal. |
| `LABEL_LOCKDOWN_INTENT` · 92 | S1, correctly separated | The Epic E spec (`2026-05-18-epic-e-backend-access-control.md:609`) proposed a signed `LABEL_LOCKDOWN_INTENT:userId:timestamp`. What shipped instead is `requireFreshAuth` (`apps/worker/middleware/require-fresh-auth.ts`) on `POST /api/account/lockdown` (`routes/account.ts:21`). It refuses session tokens and requires a per-request Ed25519 device-auth signature (`LABEL_DEVICE_AUTH`) over method, path and nonce, so the path binds the intent. |
| `HMAC_SUBSCRIBER` · 20 | S1, **decision to record** | Subscriber identifiers are hashed with `messagingContactHash` (`apps/worker/services/blasts.ts:130-135`): `HMAC_MESSAGING_CONTACT_PREFIX` under a per-hub key from `LABEL_MESSAGING_CONTACT_HUB_KEY`. They are sealed with `encryptContactIdentifier` under `LABEL_CONTACT_ID` (`blasts.ts:105-110`). A subscriber's hash therefore **equals** the conversation-thread hash for the same number in the same hub, so the server can link "is a blast subscriber" to "has contacted the hotline". `getSubscriberByIdentifierHash` (`blasts.ts:170`) has no caller, so no feature relies on that join. Under `HMAC_SUBSCRIBER` the two sets would be unlinkable. Whether they *should* be linkable (STOP handling, suppression) is a product decision, not a defect. It is recorded here and not filed. |

## Issues filed

One issue per data class that is in the clear or mislabelled. Each names its write path, read path,
current readers and target label.

| Issue | Data class | Lane |
|---|---|---|
| #1876 (commented) | Shift names, ring-group names: all three clients now, pinned by an iOS UI test | desktop, ios, android |
| #2777 | Volunteer availability reasons (iOS) | ios |
| #2778 | Shift override notes (iOS) | ios |
| #2779 | Case status/severity "blind indexes" are plaintext; crate `blind_index` not exported; iOS divergent re-implementation | shared, all clients, backend |
| #2780 | Custom role names, slugs, descriptions; roles have no hub to key `LABEL_HUB_ROLE_ENCRYPT` to | desktop, backend (needs decision) |
| #2781 | Server-side transcripts under `LABEL_MESSAGE`, no AAD, in `notes` | backend, shared |
| #2782 | Recovery share liveness proof accepted unverified | backend, shared |
| #1683 (commented) | iOS event details under `LABEL_MESSAGE` plus plaintext location | ios |

## Not filed, for the supervisor

These are stale or false artefacts found along the way. None is a data exposure.

- `docs/security/DATA_CLASSIFICATION.md:102` and `docs/architecture/E2EE_ARCHITECTURE.md:44` claim an
  E2EE `encryptedDetails` shift field that does not exist.
- `apps/worker/__tests__/unit/ws-events.test.ts` exercises a mirror of `publishEvent`, not the module
  itself, and the mirror still emits the Nostr tag.
- `.github/workflows/ci.yml:3222-3235` exempts two label literals (`llamenos:event`,
  `llamenos:provision-`) that no production code uses any more.
- `site/src/content/pages/*/features.md:225` (every locale) describes Nostr `["t","llamenos:event"]` tags.
- `tests/steps/backend/recovery-group.steps.ts` uses the raw literal `'llamenos:recovery'` for share
  and PUK-seed fixtures.
- `src/client/lib/platform.ts:1108` `decryptLegacyNote` is a `null`-returning stub that
  `routes/notes.tsx:9` still imports.

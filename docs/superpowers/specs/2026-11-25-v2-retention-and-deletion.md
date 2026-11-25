# v2 retention and deletion: every piece of data has a lifetime the server can enforce blind

**Date:** 2026-11-25 · **Base:** `origin/main` @ `417d525ac` · **Epic:** #2978, stages 1 and 2
**Issues:** #2186 (retention), #2364 (sealed-blob deletion gaps), #3005 (file content deletion), #2188 (caller erasure, design part), #1143 (audit purge and the hash chain)
**Builds on:**
- the document definitions spec (PR #3025): plaintext kinds (E4), the write policy (E8) and the job runner;
- the files spec (PR #3007, F7);
- the operator decisions D7a, D7b and D7c recorded on #2186 and #2188.

**Status:** DRAFT for operator decisions R1–R10.

Stage 3 of #2978 (audio and transcripts off the server: #2959, #2781, #2953, #2952) and stage 4
(#2189, the published policy) are not in this spec. Stage 3 changes *who can read* recordings, not
how long they live. Their lifetimes are set here like everything else's.

**The principle.** The server can delete what it cannot read. Retention therefore runs on
**server-visible clocks only**: the hour-truncated timestamps and the `closed` flag that E4 allows.
It never needs plaintext, and never needs a client to be online.

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| R1 | Retention for document types | **Every definition declares it** (clock, period, and what happens at expiry), and the validator refuses a definition without it. It is carried in the write policy, so the server purges blind | 2 |
| R2 | Retention for everything else | **A closed list of server categories**, every table assigned to one or explicitly bounded by its own TTL. Default rows are inserted at hub creation (D7a) | 3 |
| R3 | Defaults and limits | **Platform defaults and a platform maximum per category**, in deploy config. Hubs choose within `[floor, max]` | 4 |
| R4 | What "delete" means | **A hard delete, in a fixed order** (provider media → our blobs → headers and tokens → rows → credentials), fail-loud at each step. No soft deletes | 5 |
| R5 | Backups and old keys | **Stated, not hidden:** a deleted document survives in backups for the backup window, and members' old epoch secrets can open it there | 5.3 |
| R6 | Holds | **An opt-in `hold` per document type**, a plaintext flag set by `doc:<type>:hold`, that pauses expiry for that document | 6 |
| R7 | Caller erasure under v2 | **Reader-side, by document id** (D7b), found through an `exact` token on the caller identifier. **It deletes the caller's recordings and transcripts** | 7 |
| R8 | Orphans | **List, report, then delete after a human confirms.** Stale uploads are collected on a schedule, blobs included | 8 |
| R9 | Audit log purge | **A checkpoint entry** that carries the hash of the last purged entry, so the chain verifies from there (#1143) | 9 |
| R10 | Proving it | **Tests assert on storage, not rows**, and a per-hub lifetime report shows admins the oldest surviving item per category | 10 |

---

## 1. Today, measured (summary)

From #2186 (audited @ `22501b41f`) and #3005 (@ `d2bf23b38`), re-checked against `417d525ac`.

- **Retention is opt-in.** `RetentionService.executePurge()` iterates existing `retention_settings` rows only, and nothing inserts default rows. A new hub keeps everything for ever.
- **Only four categories exist:** `call_records`, `notes`, `messages`, `audit_log` (`apps/worker/services/retention.ts:23`).
- **Floors exist** (`retention_platform_floors`), but there is no maximum.
- **Never purged:**
  - the conversation skeleton outlives its messages;
  - `contact_identifiers`, `signal_identities`, `bans` and its reason text;
  - contacts (a soft delete via `deleted_at`, `contacts.ts:56`), case records, events and custody entries;
  - file blobs (`defaultRetentionDays: null`);
  - `security_events`, `devices`, `blasts.content` and `subscribers`.
- **Deletion stops short.**
  - Hub shred removes file envelopes but leaves the ciphertext (#3005).
  - Abandoned uploads are never collected.
  - `deleteHub` doesn't run provider media deletion before dropping credentials (#2364, gap 1).
  - There is no blob enumeration (gap 2).
  - Caller erasure doesn't touch recordings (gap 3).
- **Purging the audit log breaks the hash chain** (#1143).

---

## 2. R1: retention is part of every definition — OPERATOR DECISION

```jsonc
"retention": {
  "clock": "closed",          // created | updated | closed  (each needs its E4 plaintext kind)
  "days": 730,
  "category": "records",      // which platform limit applies (§4)
  "onExpiry": "delete",       // delete | tombstone (tombstone: only for types that must leave a trace, e.g. intake)
  "hold": true                // R6: may a document of this type be held
}
```

- **`validate_definition` refuses a definition without `retention`.** A new type never inherits "keep forever" (#2186).
- **The clock must be a kind the definition makes plaintext.** `closed` needs the `closed` and `closed_hour` kinds (#3025 E4). A type with no status uses `created` or `updated`.
- **The server stamps every clock column** from its own time at the write, and refuses client-supplied values (#3025 E4). Otherwise a member holding only `update` could backdate a document into the purge. A malicious server can delete anyway, so what this protects is the honesty of the lifetime report (R10), not the data.
- **Children follow their parent.** Sub-records, comments and `file` fields are deleted with the parent (F1, F7). They have no clock of their own, so a child never outlives its parent. A child type may declare a *shorter* period, never a longer one.
- **The server must be able to find the children.** `validate_definition` requires plaintext `parent` on any type that follows its parent's clock (#3025 E4, E6). A child type that keeps its parent sealed must declare its own clock. Files already carry their parent in clear (F1). Sealed relation edges are not children: they are deleted with the document that holds them.
- **Into the write policy (E8):** `{clock, days, onExpiry, hold}`. The server's daily purge selects expired documents by `type_ref` and clock, and deletes them per §5. It reads no ciphertext.
- **What the server learns:** the period and clock for each opaque type. That is configuration, not content, and it is stated.

---

## 3. R2: everything outside the document store — OPERATOR DECISION

Every table falls under one of three things: a definition (R1), a **server category** below, or
its own bounded TTL (sessions, nonces, rooms and the others #2186 lists as already bounded). A CI
check (`retention-coverage`) fails when a table in `db/schema` falls under none of them. That is how
a new table stops arriving without a lifetime.

| Category | Tables | Clock | Note |
|---|---|---|---|
| `calls` | `call_records`, call recordings and transcripts until #2959 moves them, `call_tokens` | created | provider media first (§5) |
| `conversations` | `conversations`, `messages`, `contact_identifiers`, message files, `signal_message_queue` | last activity | **the whole skeleton goes together** (#2186's main finding). A purge that deletes messages but leaves the conversation is a bug |
| `identities` | `signal_identities`, `subscribers` | last activity | |
| `bans` | `bans` | created | the reason moves into the sealed tier with B-D2-BAN |
| `broadcasts` | `blasts` content | delivered | content is cleared after delivery plus the category period. The delivery counts stay |
| `security` | `security_events`, `push_reminders_sent` | created | |
| `devices` | `devices` | last seen | an inactive device's push token is removed |
| `scheduling` | `shift_join_requests`, `user_availability_blocks` and past shift instances | ended | |
| `audit_log` | `audit_log` | created | with the checkpoint in §9 |

Under v2 these tables move to documents over time (#3025 E11). When one does, its category becomes
its definition's `retention.category`. The limits in §4 stay where they are, so no hub's window
changes because of the move.

---

## 4. R3: defaults, floors and the maximum — OPERATOR DECISION

**Deploy config, per category:** `default_days`, `floor_days` (the existing floors) and `max_days`
(new, D7a).
- Hub creation inserts one `retention_settings` row per category, at the default.
- Admins choose within `[floor, max]`.
- A definition's `days` is clamped into its category's range when the policy is published, and the clamp is shown to the admin.

**Suggested defaults (the operator sets the real numbers):**

| Category | Default | Max | Reasoning |
|---|---|---|---|
| `records` (cases, contacts, incidents, reports) | 2 years after close | 7 years | long enough for a legal process to finish; the hold (R6) covers longer cases |
| `notes` | follows the parent | — | |
| `calls` | 1 year | 3 years | |
| `conversations` | 180 days after last activity | 2 years | the most identifying metadata (#2186) |
| `identities` | 180 days after last activity | 1 year | |
| `bans` | 1 year | 3 years | a ban should lapse unless renewed |
| `broadcasts` | 30 days after delivery | 180 days | |
| `security` | 90 days | 1 year | |
| `devices` | 90 days after last seen | 1 year | |
| `scheduling` | 1 year after the shift ended | 2 years | |
| `audit_log` | 2 years | 7 years | must outlast the records it describes |
| `intake` (#3021) | 30 days unresolved; tombstones go with `audit_log` | 180 days | |

---

## 5. R4: what deleting means — OPERATOR DECISION

### 5.1 One order, fail-loud

Every deletion uses one routine: retention, a user's delete, caller erasure, record shred and hub
deletion. It deletes in this order:

1. **Provider-held media** (#2304's fail-loud deletion), while the credentials still exist. This closes #2364 gap 1.
2. **Our blobs.** For a document: find its file documents by their clear parent ref (F1), and delete each through **F7's file-delete path**, which uses F7's `deleting` row state. Blobs live under `hubs/<hub>/files/<file_id>/…` (F2), so there is no per-document prefix. For a hub: delete by the hub prefix (F7). Either way this settles #3005 item 3.
3. **The document's headers and index tokens.** Grants are per group epoch, not per document, so they are untouched, except on a hub deletion, which deletes every grant and epoch key (#2961).
4. **Rows**, including the plaintext columns.
5. **Credentials and keys** last, and only for a hub deletion.

A step that fails stops the routine. For files, the pending state is F7's `deleting` row state. For everything else, the routine records `deletion_pending` (counts only). It retries,
and raises the provider-media incident (#2353) after the retry budget. **Nothing is reported as
deleted while any earlier step is pending.**

### 5.2 No soft deletes

`deleted_at` (`contacts.ts:56`) and bulk "delete" that only sets a flag are removed. A delete is a
delete. The safety net is D7b's confirmation component (type the phrase, and the count for bulk),
not a hidden flag that keeps the data.

### 5.3 R5: what survives, said plainly

- **Backups** keep deleted rows and blobs until they rotate out (about 90 days, `backup-postgres` defaults). The lifetime report (§10) and #2189 state that window.
- **Old epoch secrets.** Members' devices hold old epoch secrets, so a deleted document in a backup can be opened by someone holding both the backup and a member device. That is the backup window again, not a new one. Destroying the DEK headers is what removes the content from the live system.
- **Exports and copies** made by members, and released projections (#2941), are outside the system. Deleting a released record retracts its releases (#2941, review point 1), and the dialog says what can't be recalled.

---

## 6. R6: holds — OPERATOR DECISION

The operator's framing on #2188: a caller may want their record kept until a case closes or a
lawsuit is won, and erased afterwards.

- A type that declares `retention.hold: true` gets a plaintext `held` flag (a new E4 kind, `held`) and the permission `doc:<type>:hold`.
- A held document is skipped by the retention purge. It is **not** exempt from caller erasure, which is the subject's own choice (D7b).
- **Holds expire.** A hold carries a review date at most 1 year out, and the admins get a notice before it lapses. An indefinite hold is a "keep forever" by another name.
- **What the server learns:** which documents are held and until when (`held`, `hold_until`, #3025 E4). **That marks documents under a legal process or dispute**, which is itself a signal to anyone who reads the database. The definition's `why` must say so, and holds stay opt-in per type for that reason.

---

## 7. R7: caller erasure under v2 — OPERATOR DECISION

D7b is already decided: reader-side, by record id, the server never learns the number, the audit
entry holds counts only, `calls:erase-caller`, and the typed confirmation.

**Finding the records.**
- Under v2, every document that names a caller carries an `exact` token on the caller identifier, under the `perm:calls:read-history` group (#3025 E5).
- **Call records are documents** of the system type `call` (#3025 E11). The server writes them, but can't compute tokens (D7), so the **answering volunteer's client writes the caller token on first open**. A call record not yet opened by anyone has no token, and erasure finds it by the call's thread instead (the conversation or call is opened, and its call records are listed by parent). The eraser's device reports how many it could not reach.
- Contacts and cases carry the token when their definition indexes the caller identifier under the same group.
- The eraser's device computes the token for the number it was given, asks for matching doc ids, opens them, confirms the matches locally, and deletes by id. **This replaces "decrypt everything and scan".**
- The token shows the server which documents share a caller, but not who the caller is. Today's `HMAC_SECRET` hashes show the server the same thing, under a key the server holds itself.

**Recordings (#2364, gap 3): recommended, delete them.**
- A call recording is the caller's voice speaking to our volunteer. The volunteer's interest is served by the notes they wrote, which the erasure handles like any other record of that caller.
- The transcript goes with the recording.
- **Alternative:** redact the association and keep the audio. That keeps a recording of someone who asked to be forgotten, and nothing in the product needs it.

**Floors.** Erasure doesn't override a platform floor (operator, 2026-10-29). The device shows
which records were refused and why, and the caller can ask again later.

**Abuse.** Caller verification stays with #2235. This spec only requires that erasure takes
`calls:erase-caller` and the typed confirmation.

---

## 8. R8: orphans and stale uploads — OPERATOR DECISION

- **Stale uploads** (#3005 item 2): a scheduled job deletes uploads not completed within 24 hours, **blobs first**, then rows. It runs `cleanupStaleFiles`, which has no caller today, rebuilt on the §5 routine.
- **Orphans** (#2364 gap 2): a bounded, paginated `list()` over each hub prefix, compared with the rows that reference the blobs.
  - **Report first.** The admin and the operator see a count and the total bytes.
  - **Delete after confirmation.** The operator confirms, and only blobs that are orphaned *and* older than 7 days are deleted. That margin keeps an upload mid-flight from being collected. Automatic deletion from a list stays off, as #2364 asked.

---

## 9. R9: purging the audit log without breaking the chain — OPERATOR DECISION

#1143: purging old entries truncates the hash chain, so the verifier reports tampering on data
nobody touched.

- **Recommended:** the purge writes a `checkpoint` entry first. It carries the sequence and hash of the last entry being purged, the purge cutoff, and the count. The verifier accepts a chain that starts at a checkpoint, with two guards against a server truncating recent history (review finding 12):
  - **The checkpoint is signed by an admin device**, as a hub-chain-anchored statement. The server proposes the purge, and an admin client signs it. A purge waits for an admin, which is acceptable for a daily job.
  - **The verifier refuses a checkpoint whose cutoff is younger than the hub's `audit_log` period.** So a checkpoint can't jump past a fresh `definition.update` or release entry.
- What a checkpoint cannot show is whether the purged entries were themselves intact. That is the point of purging them, and it is stated.
- Release audit entries are signed (#2941), and their signatures are checked before the purge. A failed check stops the purge and raises an incident.
- **Alternative:** never purge the audit log. Its `max_days` would then be infinite, which goes against D7a.

---

## 10. R10: proving it — OPERATOR DECISION

- **Every deletion test asserts on storage** (the bucket listing, the provider API in the provider suites) and on the rows. A test that checks rows alone passes against every defect in #2364 and #3005.
- **The `retention-coverage` CI check** (§3).
- **A per-hub lifetime report** for admins: per category and type, the configured period, the oldest surviving item's age (the hour, from plaintext clocks), the pending deletions, and the held count. If the oldest item is older than its period, that is visible without anyone reading data. It is also the source for #2189's wording.

---

## 11. Contract surface and gates

**Contract PR:**
- `retention` in the definition format, the validator and the policy (it joins #3025's contract if both are signed off together; otherwise it follows as a format addendum);
- the categories, deploy-config limits and default rows at hub creation;
- the one deletion routine with its order, `deletion_pending`, and no soft deletes;
- the purge over policies;
- the audit checkpoint;
- stale upload GC;
- the orphan report;
- `retention-coverage`.

**Client adoption:** the hold control, the lifetime report, the erasure flow on the token lookup,
and the shared confirmation component.

**Stage 1 gate (#2978):**
- A new hub purges every category at its defaults, with no admin action.
- A new definition without `retention` is refused.
- `retention-coverage` is green.

**Stage 2 gate:**
- Deleting a file, record or hub leaves no blob, verified by a bucket listing.
- Hub deletion leaves no provider media, verified against the provider in the provider suites.
- A caller erasure removes their recordings.
- The audit chain verifies after a purge.

---

## 12. Sign-off

The operator signs off R1–R10 (including the default numbers in §4, or replaces them) on #2978.

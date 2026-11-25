# v2 document definitions: one declaration drives sealing, readers, indexes and permissions

**Date:** 2026-11-25 · **Base:** `origin/main` @ `417d525ac` · **Epic:** #2974 stage 3 (#2947, #1597); later slices #2938
**Builds on:**
- the v2 wire format (`2026-11-24-encryption-v2-wire-format.md`, merged in #2996): tiers (§2.1), the content and header AADs (§2.4), index keys (D7), and the hub chain (§5);
- the v2 files spec (PR #3007): `file` fields;
- the reader groups in #2961, and the connectors spec (PR #3021), which consumes definitions for intake.

**Status:** DRAFT for operator decisions E1–E12.

#1597 asked how far the entity model should reach, and named five tensions any answer must
resolve. #2947 is slice 1 of the mechanism, in M2. #2938 holds the M3 slices. This spec is the
format all three share. It decides one thing above all: **every field that stays plaintext is
listed, with its reason, and everything else is sealed by the same code on every platform.**

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| E1 | Where a definition lives | **A signed, sealed document of the meta-type `definition`, under `members`.** Type and field refs are random per hub. The server never stores a type name, field name or option label | 2 |
| E2 | How a tier names its readers | **A closed grammar:** `admins` (required), `perm:<permission>`, `assignees` and `author`. Never a role id or name | 3 |
| E3 | Permissions | **Per type:** `doc:<type>:<action>`, with a `doc:*:<action>` wildcard. `cases:*`, `events:*` and `reports:*` retire into it | 4 |
| E4 | Plaintext fields | **A closed list of server-visible kinds** (hour-truncated timestamps, server-assigned numbers, assignees, the parent ref), each with a reason. Free text can never be plaintext | 5 |
| E5 | Indexes | `exact`, `date` buckets and `location` buckets, each under **one searching group**. **No trigram tokens** | 6 |
| E6 | Relations and sub-records | **Edges are sealed inside the source document,** with a reverse-lookup token. The plaintext `event_ids[]`, `report_ids[]` and `parent_record_id` go | 7 |
| E7 | Changing a definition | **Versioned,** and each kind of change maps to a named job. Nothing moves a field to plaintext once documents exist | 8 |
| E8 | What the server enforces | **A write policy derived from the definition,** with opaque ids only. Clients recompute it and alert on a mismatch. This is the structural #2174/#2190 guard | 9 |
| E9 | One API | `validate_definition`, `seal_document`, `open_document` and `policy_of` in the crate, exposed once per binding. **No per-type codegen** | 10 |
| E10 | The case-record port | **Semantic parity**, not byte parity, which v2's AAD makes impossible. The gate re-opens every pilot row | 11 |
| E11 | What unifies, and when | Case records and contacts in M2 (#2947). Incident, reports, notes and actor types in M3 (#2938). Conversations, messages and calls are **not** documents of this kind | 12 |
| E12 | Who may change readers | **`definitions:manage`, in the admin bundle only.** Every reader change shows a "who can read this" diff and is audited | 8.3 |

---

## 1. Today, measured (summary)

Surveyed against `origin/main` @ `417d525ac`.

- **The definition schema exists, but drives nothing.**
  - `entityFieldDefinitionSchema` (`packages/protocol/schemas/entity-schema.ts:35-85`) carries `indexType` (exact \| date \| location \| none), `accessLevel`, `accessRoles` and `locationOptions.maxPrecision`.
  - `entityTypeDefinitionSchema` (:96-154) carries `piiFields`, `accessRoles`, `editRoles` and `defaultAccessLevel`.
  - None of it seals or indexes anything. `accessRoles` and `editRoles` only pick envelope readers on the server; field `accessLevel` is enforced nowhere.
- **Definitions are plaintext** (`entity_type_definitions`, `relationship_type_definitions` and `report_type_definitions`, `apps/worker/db/schema/settings.ts:263-385`). That is #2191.
- **Readers are composed four ways:**
  - the server's three tiers (`apps/worker/lib/envelope-recipients.ts:82,109,131`);
  - desktop: author + server tier + the hub's admin readers (`src/client/lib/record-recipients.ts`);
  - iOS (`RecordReaders.swift:59`) and Android (`RecordReaders.kt:61-74`): author + server tier + the single `adminDecryptionPubkey`. So mobile and desktop disagree on who an admin reader is.
  - iOS case comments are sealed to admins alone (`CaseManagementViewModel.swift:526-538`).
- **The crate seals case records only** (`case_record.rs`: summary, fields and comment purposes, AAD = the label). There is no PII purpose.
- **Blind indexes exist in the crate but have no binding** (`blind_index.rs`). Every client sends status and severity as their **plaintext values** in the `*_hash` columns (#2779, M1).
- **Plaintext case columns:** `status_hash`, `severity_hash`, `category_hash`, `assigned_to[]`, `event_ids[]`, `report_ids[]`, `parent_record_id`, `merged_into_id`, `created_by`, `case_number`, and full-precision timestamps (`apps/worker/db/schema/cases.ts:23-93`).
- **Permissions are global per resource** (`cases:*`, `events:*`, `reports:*`; `packages/shared/permissions.ts:142-172`). Creating one type implies creating every type (#1597, tension 3).
- **Codegen emits types and labels only** (`packages/protocol/tools/codegen.ts`).
- **Outside the entity system, every one seals differently:**
  - reports are conversations sealed with `LABEL_MESSAGE` and no AAD;
  - notes use `LABEL_NOTE_KEY`, sealed to author + admins;
  - events have a separate table with plaintext dates and `LABEL_MESSAGE` on iOS;
  - contacts use `LABEL_MESSAGE` on desktop, and `LABEL_CONTACT_PROFILE` with hand-rolled indexes on iOS.

---

## 2. E1: a definition is a signed, sealed document — OPERATOR DECISION

A definition is a document of the system meta-type `definition` in the generic sealed store. Its
`summary` tier is sealed to `members`, because every member's client needs it to render forms. It
holds:

```jsonc
{
  "kind": "case",               // canonical kind for system and template definitions; "custom" for hub-made ones
  "provider": "template",       // system | template | hub | connector (connector: #2944, M3)
  "version": 3,                 // u32, bound into every content AAD as schema_version (wire §2.4)
  "name": "…", "label": "…",    // hub vocabulary: sealed, never on the server
  "fields": [ { "ref": "f-…", "name": "…", "type": "select", "tier": "fields",
                "index": { "kind": "exact", "group": "perm:doc:t-…:read-fields" },
                "options": [ … ], "…": "…" } ],
  "tiers": { "summary": ["admins", "perm:doc:t-…:read-summary", "assignees", "author"],
             "fields":  ["admins", "perm:doc:t-…:read-fields", "assignees", "author"],
             "pii":     ["admins", "perm:doc:t-…:read-pii"] },
  "plaintext": [ { "kind": "created_hour", "why": "…" }, … ],
  "relations": [ … ], "capabilities": { … },
  "retention": { … }            // #2978 owns the vocabulary; a definition must declare it (#2186)
}
```

- **Refs are random per hub.** A type ref is `t-` plus 16 random bytes in hex, and field refs are `f-…`. They meet the wire spec's identifier profile (§2.1). The mapping from ref to name exists only inside the sealed definition (#2191).
- **System and template definitions** ship in `packages/protocol` under canonical names. An admin's client instantiates them into a hub, minting its refs, at hub creation or when a template is applied (#1204). The canonical `kind` stays inside the sealed document.
- **Signed.** Each definition version carries an Ed25519 signature by an admin device, over `H(lp(L_DEFINITION_SIG) ‖ lp(hub) ‖ lp(type_ref) ‖ u32(version) ‖ H(canonical(definition)) ‖ H(canonical(policy)))`, where the policy is the server-visible projection in §9. The definition uses the D10 profile for its structure; its free-text values are committed by hash, like the connector manifest's private part. Clients verify three things: that the signer held `definitions:manage` in the chain-derived state at the head the signature names; that versions only rise; and that every version is kept. **Without the signature, a server could not forge a definition, but it could serve an older one and narrow the readers of new writes.**
- **Every version is kept,** because documents are opened under the version they were written with.

---

## 3. E2: how a tier names its readers — OPERATOR DECISION

Tiers are the crate's closed enum: `summary`, `fields`, `pii` and `hub` (wire §2.1). `thread_key`
and `message` belong to conversations and are not used by definitions. A tier's reader list is
built only from these entries:

| Entry | Resolves to | Group kind |
|---|---|---|
| `admins` | the admin purpose group | role group (exists) |
| `perm:<permission>` | members whose chain-derived permissions include `<permission>`, wildcards resolved | a **permission group**: one group per distinct permission named, created on first use |
| `assignees` | the user group of each user in the document's assignee set (§5). A team assignment expands to its members at write time | user groups |
| `author` | the writer's own user group | user group |

**Rules, checked by `validate_definition`:**

1. **Every sealed tier lists `admins`.** This is the never-orphaned rule (#2174) as a declaration. Escrow joins every group by itself (#2961 §7).
2. No role ids or names, ever. That matches the rule already written above `READER_PURPOSE_PERMISSIONS`: "nothing anywhere decides a reader by role id or name".
3. The `pii` tier may not list `assignees` or `author` unless the definition says so explicitly with `pii.allowSubjects: true`. Today's PII readers are admins and `contacts:view-pii`.
4. A tier has at most 8 entries.

**Wire addendum.** A permission group is a `group_epoch` with `kind: purpose` and
`subject: perm:<permission>`. That fits the D10 string profile. Membership is derived as for any
purpose group, which is why §5.5's answer (permission ids in clear) matters: connectors and
verifiers can evaluate it.

**Cost, stated.** Each distinct `perm:` entry is one group with its own epochs and grants.
Templates reuse a few permissions per type (§4), so a hub with 10 types has about 30 permission
groups. A member's removal rotates only the groups that member was in. An admin client does that
work automatically (#2961 §5–6).

**Assignee changes.**
- Adding an assignee is a header for their user group, written by any client that can open the DEK and holds `doc:<type>:assign`.
- Removing one deletes that header. What they have already read is not recalled, and the UI says so.
- A team's membership change is a re-wrap job over that team's assigned documents.

---

## 4. E3: per-type permissions — OPERATOR DECISION

Each definition gets permission ids `doc:<type_ref>:<action>` for these actions: `read-summary`,
`read-fields`, `read-pii`, `create`, `update`, `update-own`, `close`, `delete`, `assign` and
`link`. Stage 3 of #2977 adds `release`.

- **Read** is enforced by keys (§3). The read permissions exist so that tiers can name them.
- **Write** actions are enforced by the server's write policy (§9) and shown by the UI.
- **Wildcards:** `doc:*:<action>` and `doc:<type>:*`. Today's matcher only understands domain wildcards like `cases:*` (`permissions.ts:775`), so the matcher gains a middle-segment wildcard. That is a contract change with its own tests.
- **Bundle mapping:**
  - `cases:read-all` becomes `doc:*:read-summary` + `doc:*:read-fields`;
  - `cases:read-assigned` and `cases:read-own` become the `assignees` and `author` entries;
  - `contacts:view-pii` becomes `doc:<contact type>:read-pii`;
  - and so on. The mapping ships as a table in the contract PR. The admin client applies it as one `policy` bundle link per bundle (D12).
- **`cases:*`, `events:*` and `reports:*` are deleted** once their types are ported, with no aliases. EP06-A1 proposed aliases, and this spec supersedes that.
- **`definitions:manage`** replaces `cases:manage-types` (E12, §8.3).

---

## 5. E4: what may stay plaintext — OPERATOR DECISION

Plaintext is a closed list of kinds the crate knows. A definition opts into each kind with a
`why`, which is sealed with the definition. **Free text, options and field values can never be
plaintext.** No kind exists for them.

| Kind | Value on the server | Why it is allowed | Default |
|---|---|---|---|
| `created_hour`, `updated_hour` | timestamp truncated to the hour | sort and paging without downloading every summary (#2961 A5). The server sees write times at full precision anyway, in its request logs | on |
| `closed` | boolean | the open/closed split for list views and retention clocks | on for types with statuses |
| `number` | the server-assigned sequence number | the server assigns it, so it knows it already | on when `numbering` is on |
| `assignees` | user pubkeys | the server must route notifications and serve "assigned to me". It sees who reads anyway, through header group ids | on when the type allows assignment |
| `parent` | parent doc id, for sub-records only | cascade on delete, and fetching children in one query | off (E6 prefers sealed) |

**Removed from the plaintext surface:**
- full-precision timestamps;
- `created_by` (the author is in the sealed tier; the server knows the writer from auth only at write time, and does not store it per row);
- `status_hash`, `severity_hash` and `category_hash`, which become `exact` tokens (§6). This is #2779's structural end state;
- `event_ids[]` and `report_ids[]` (§7);
- `merged_into_id`, which moves into the sealed tier, with a token.

---

## 6. E5: indexes — OPERATOR DECISION

| Kind | Token | For |
|---|---|---|
| `exact` | `HMAC(index_key, L_V2_INDEX_TOKEN ‖ lp(type_ref) ‖ lp(field_ref) ‖ lp(normalise(value)))`, where the crate's normaliser is chosen by field type (NFKD with marks stripped; never locale-dependent, which fixes the iOS divergence in #2779) | select, multiselect (one token per value), checkbox, status, severity, category, ids, badge numbers and plates (#2943) |
| `date` | one token each for the day, week and month bucket | date ranges |
| `location` | one token per bucket at a precision **no finer than the field's `maxPrecision`** | "near" filters |
| `none` | — | everything else, which is filtered on the client |

- **One searching group per indexed field** (#2961 A5). It must be one of the tier's readers, and the validator checks that. Tokens use that group's current index key version (D7).
- **No trigram tokens.** Substring tokens over names make every name in the hub linkable and partly guessable from the token table. Free-text search runs on the client over bounded, decrypted sets, as #2779 decided for M1. `blind_index.rs`'s `name_trigram_indexes`, which nothing calls, is deleted.
- **What a token still shows, stated (#2779):** equality. A four-value status field gives away its distribution. It does not give away the value.

---

## 7. E6: relations and sub-records — OPERATOR DECISION

- A relation type is declared in the source definition: the target type refs, cardinality, roles, and join fields, which are sealed with the edge.
- **An edge lives in the source document's `fields` tier:** `{relation, target, role, joinFields}`.
- For reverse lookup ("cases linked to this contact"), the writer adds an `exact` token on the target's doc id, under the relation's searching group.
- **The server sees no graph.** It sees tokens whose equality shows that two documents point at the same target, but not which target or what kind of link. That is the degree of a hidden node, not an identity, and it is stated.
- **Sub-records:** the parent ref is sealed the same way, unless the definition opts into plaintext `parent` (§5).
- **Cascade delete becomes a client job.** The deleter's client walks the edges it can open. Edges it can't open are reported, never skipped silently. Retention-driven cascades belong to #2978.
- **Base relation types that connectors supply** (#2943, #2944) use the same declaration, with `provider: connector`.

---

## 8. E7: changing a definition — OPERATOR DECISION

### 8.1 Every change raises the version

Old documents stay open under the version they were written with. Each change maps to a job that
runs on an admin client, using the same resumable job runner as #2961's re-wrap and #2947's
reconciliation:

| Change | Job | Content re-encrypted? |
|---|---|---|
| Add a field, option or relation; edit labels or help text | none | no |
| Change a tier's readers | **header re-wrap**: add and remove headers for the affected documents | no |
| Move a field between sealed tiers | **re-seal** of the affected documents' two tiers | yes |
| Plaintext kind → off | clear the column, then re-seal if the value moves into a tier | yes |
| Add or change an index | **re-index**: open the indexed tier and write tokens | no |
| Remove a field | tombstone in the definition; values stay until a document is next written | no |
| **Sealed → plaintext, once any document exists** | **refused** by `validate_definition` | — |

### 8.2 Downgrades

Shrinking a tier's readers is fine: the re-wrap removes headers. Widening readers is a disclosure,
so the approval screen shows exactly who gains access (§8.3). Moving data into plaintext after it
exists is the only change that can't be undone at the data level, so it is refused. A hub that
truly needs it creates a new type and migrates.

### 8.3 E12: who may do it

- **`definitions:manage`**, in the admin bundle only and in no default non-admin bundle. As #1597 put it, this is the authority to decide who can read a class of data.
- **The approval screen shows a reader diff:** "after this change, these N members gain read on PII". That diff is computed from the chain-derived state.
- The audit entry is generic: `definition.update` with the type ref, version and signer (#2961). The sealed diff is attached for admins.

---

## 9. E8: the write policy the server enforces — OPERATOR DECISION

The server can't read a sealed definition, but it has to refuse bad writes. Each definition version
therefore publishes a **policy** made only of opaque ids:

```
document_type_policies(hub_id, type_ref, version, policy jsonb, policy_hash, signature)
policy = { tiers: [{tier, groups: [group_id…], dynamic: [assignees|author]}],
           plaintext: [kind…], index: [{field_ref, kind, group_id}],
           relations: [{relation_ref, target_type_refs, cardinality}],
           permissions: {create, update, …: "doc:t-…:create"}, maxTierBytes, capabilities }
```

- `policy_of(definition, chain state)` is a crate function, so every client computes the same policy. **Clients recompute it from the sealed definition and alert on any mismatch** with what the server serves. The policy's hash is inside the definition signature (§2), so a mismatch is evidence, not noise.
- **The server's write guard,** generated from the policy (this is #2947 point 5 and #2938 point 3):
  - every declared sealed tier has a header for every listed group's **current** epoch, plus each dynamic group's;
  - tokens only for declared index fields, each under the declared group;
  - plaintext only for declared kinds, of the declared shape;
  - the writer holds the permission for the action;
  - tier sizes are within bounds.

  Anything else is refused. **This replaces #2174/#2190's hand-written M1 guards with one generated check.**
- The server can still refuse or drop a write. It cannot make one land with fewer readers than the definition declares.

---

## 10. E9: one API, no per-type codegen — OPERATOR DECISION

In the crate, exposed once each through UniFFI, Tauri and `ffi_server`:

- `validate_definition(def, previous?) -> Ok | [errors]`: the rules in §§3–8;
- `policy_of(def, chain_state) -> Policy`;
- `seal_document(def, version, values, ctx{hub, type_ref, doc_id, head, author, assignees}) -> {tiers: [{tier, blob, headers}], tokens, plaintext}`;
- `open_document(def_versions, sealed, my_keys) -> values` (per tier, whatever the caller can open).

There is no other way to build a content or header AAD (wire §2.4). Hosts pass values keyed by
field ref, and never pass labels, tiers or AADs.

**No per-type codegen.** #2938 proposed typed per-definition wrappers. Hub and template types are
runtime data, so generated wrappers could only ever cover system types, and every form already
renders from the definition. Codegen extends instead to the definition format, the policy and the
`seal_document`/`open_document` value types, in TS, Swift and Kotlin. The server guard is generated
from the policy *type*, not per definition.

---

## 11. E10: porting case records, with semantic parity — OPERATOR DECISION

#2947 asked for byte-for-byte parity with `case_record.rs`. Under v2, the content AAD binds
`(format, hub, type, doc, tier, schema version)` (wire §2.4), so byte parity can't hold.
#2947's own later comment already noted that binding the new AAD is a full re-encryption.

**The gate instead (in CI, against the real crate, never a mock; #2947 comment 4):**
1. For every format-1 fixture, and in the pilot job for every real row: open it with the format-1 reader, seal it with `seal_document`, open that, and compare the field values. They must be equal.
2. Every row the job can't open is reported by id, never skipped (#2174 class).
3. The format-1 reader stays until the wire spec's cutover (§3.5), and is then deleted.

**Mapping from today:**
- the summary, fields and PII envelopes → tiers 1–3, readers per §3;
- the comment purpose → a system sub-type `comment`, with tiers `[author, admins, assignees]`;
- status, severity and category → `exact` tokens;
- `event_ids[]` and `report_ids[]` → sealed relations;
- `case_number` → `number`;
- `assigned_to` → `assignees`.

Deleted with no fallback, once each client is ported:
- `envelope-recipients.ts`, `record-recipients.ts`, and the mobile `RecordReaders`;
- `CONTACT_TIER_PERMISSIONS`;
- the `blind_indexes` jsonb and its SQL matcher (`services/cases.ts:523-526`), replaced by `document_index_tokens`.

---

## 12. E11: what unifies, and when — OPERATOR DECISION

| Thing | Document type? | When | Note |
|---|---|---|---|
| Case records (every `entity_type_definitions` category) | yes | **M2**, #2947 | first port |
| Contacts | yes; the PII tier is the point | **M2**, #2947 | #2947 already deletes `CONTACT_TIER_PERMISSIONS`; porting contacts with it removes the third reader mechanism |
| `file` fields everywhere ("evidence" is a template label, operator ruling 2026-10-25) | field type | M2 format (#3007); M3 custody UI (#1145) | |
| Incident (events) | yes | M3, #2938 | finishes EP06-A1; plaintext dates become `date` tokens |
| Reports | yes | M3, #1309 | ends "reports are conversations" |
| Actor and observation types | yes, `provider: connector` capable | M3, #2943 / #2944 | |
| Notes | yes: tiers `[author, admins]`, which is per-note forward secrecy with a per-document DEK | M3, last (#1597) | |
| Conversations, messages, calls | **no** | — | thread-key shape, server-written, readers change on claim (#2961, thread keys) |
| Shifts, schedules, settings, bans, audit | **no** | — | operational data the server must act on, or its own mechanism (OPRF bans, the audit chain) |

**Nothing is dropped.** Every "yes" row has a milestone, and every "no" row has the mechanism that
covers it instead.

**#1597's five tensions, answered as declarations:**
1. Encryption shape per type: §3.
2. Definitions are implicating: E1.
3. Permissions flatten: E3.
4. Server-side querying: E4 and E5.
5. Audit: generic actions, type sealed (#2961). The hash chain is unchanged, because entries still name doc ids.

---

## 13. Contract surface and gates

**Contract PR (#2947's, one PR):**
- the crate: the definition model, validator, policy, seal/open, normalisers and tokens;
- `packages/protocol`: the definition and policy schemas, and codegen;
- the worker: `sealed_documents` for the ported types, `document_type_policies`, `document_index_tokens`, the generated write guard, the permission matcher, and the bundle mapping;
- **vectors:**
  - definition signature;
  - `policy_of`;
  - `seal_document` per tier;
  - `exact`, `date` and `location` tokens with their normalisers (including the iOS locale case from #2779);
  - a refused sealed→plaintext change;
  - a server-served stale definition that clients must refuse.

**Then adoption, one PR per client,** each ported fully, with its old reader composition deleted.

**Gates (#2974 stage 3):**
- Case records and contacts written by each client open on the other two under v2 headers, on real clients.
- The legacy envelope path is no longer written.
- The semantic-parity job reports zero unopenable pilot rows, or names them.
- A write missing a declared group's header is refused by the server.
- A definition served at an older version is refused by every client.

---

## 14. Non-goals, and findings

- Retention and erasure vocabulary: #2978. This spec only requires that every definition declares it.
- Provider base layers and hub overlays: #2944 (M3) reuses this format, with `provider: connector`.
- **Finding, not new:** #2779 (plaintext `*_hash` values) stays the M1 fix. §5 and §6 are its end state.
- **Wire addendum:** permission groups as `group_epoch` subjects (`perm:<permission>`, §3). Record it with the connectors addendum in the contract PR.

---

## 15. Sign-off

The operator signs off E1–E12 on #2974. Until then, #2947's contract unit is not dispatchable.

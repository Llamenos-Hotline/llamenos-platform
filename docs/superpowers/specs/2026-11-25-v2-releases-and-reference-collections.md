# v2 releases and reference collections: what may leave, and what may come in to match against

**Date:** 2026-11-25 · **Base:** `origin/main` @ `29ffb6843` · **Epic:** #2977 stages 3–4 (#2941, #2945), M3
**Builds on:**
- the v2 wire format (`2026-11-24-encryption-v2-wire-format.md`): tiers, header AADs, hub-chain links and the `connector` group kind;
- connectors (#3021, C1–C11): enrollment, manifests, the SDK and chain following;
- document definitions (#3025, E1–E12): field classes, relations and `seal_document`/`open_document`;
- retention (#3026): R4's deletion routine and R9's audit checkpoint;
- organisations (#3032), for org-shared reference sources.

**Status:** DRAFT for operator decisions P1–P9 (releases) and Q1–Q7 (reference collections).

Nothing can leave an instance on purpose today. #2941 proposed human-approved, client-rendered
releases, and #2945 proposed reference collections that are mirrored, then matched on the client.
Both were aligned with reader groups on 2026-11-23. This spec makes them buildable. It decides:
- how a profile is protected from the server;
- how the hard denies are enforced in code;
- how a connector refuses a release the server forged;
- how retraction works;
- how reference collections are keyed without an org-wide reader;
- how matches become identifications.

**The principle: a release is the only way data leaves, it is rendered and signed by people, and
every party verifies it from the chain. A reference collection only ever adds candidates, which a
person confirms.**

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| P1 | Where a release profile lives | **A sealed `release_profile` document whose current version is pinned by a hub-chain `policy` link.** Clients render only under a pinned profile. The partner's format mapping stays in the connector's private manifest | 2 |
| P2 | What can be released | **Field classes, declared in the definition. The renderer emits only releasable classes.** PII tiers, files, notes, comments and person-class types are unreleasable in the validator and in the crate | 3 |
| P3 | Free text | **Never copied from a record.** A release may carry a `release_note` the reviewer writes for it, which the approver sees | 3.3 |
| P4 | Location and time | **Mandatory precision cap and minimum delay in every profile,** each with a platform floor (starting values in §4) held in platform settings | 4 |
| P5 | Approval | **Per profile: one person or two.** Approvers sign the projection hash. The requester can't approve their own release. A missing configuration denies the release | 5 |
| P6 | Who verifies | **The connector verifies the requester's and approvers' signatures and permissions from the hub chain** before delivering. The server can't forge or widen a release | 6 |
| P7 | Retraction | **A signed `release_retract`.** It is automatic when a released record is deleted or shredded. It is best effort beyond the first hop, and the dialog says so | 7 |
| P8 | Audit | **Release audit entries carry the signatures,** so they're non-repudiable. R9 checks them before any purge | 8 |
| P9 | Permissions | `doc:<type>:release` and `doc:<type>:approve-release` (E3 grammar), plus `integration:manage` for profiles | 5.3 |
| Q1 | How a collection is keyed | **Per hub.** Each participating hub gets its own sealed copy, under its own `reference` purpose group. **No org-wide key** | 9 |
| Q2 | Who writes it | **A reference connector, which holds no group secret.** It seals to hub groups' public keys, signs each version, and receives nothing. **It may serve several hubs of one org from one boundary,** with one enrollment and key per hub (amends C11) | 10 |
| Q3 | Integrity and freshness | **Every version is signed by the connector, and versions only rise.** Clients refuse an older version than one they've seen, and refuse a revoked connector's later versions | 10.3 |
| Q4 | Matching | **Download and match on the client,** with the crate's `exact` normalisers. No index tokens are queried for reference data | 11 |
| Q5 | Candidates and confirmation | **Candidates are local and ephemeral. Confirmation writes a sealed relation edge** carrying source, row, basis and confidence. Only confirmed edges can appear in a release | 11.2 |
| Q6 | Actor-only links | **Type classes in the definition.** The validator refuses any relation between an `actor` type and a `person` type. Reference types have no PII tier and no owner fields | 12 |
| Q7 | Live lookup | **Specified here, built after mirror mode** (moved to a later milestone, not dropped). Queries are sealed to a lookup connector and mitigated at the source. Raw per-key queries need an operator flag | 13 |

---

## 1. Today, measured

- **Nothing leaves on purpose.** There is no outbound integration route or release table.
- **The audit chain is hash-chained but unsigned:** `computeEntryHash` over `id:action:actorPubkey:createdAt:details:previousEntryHash` (`apps/worker/services/audit.ts:198-206`). Anyone who can rewrite the table and recompute hashes can forge it.
- **Location** fields exist (`packages/protocol/templates/builtin-event.json:109-115`, `street-medic.json:160`). They have a precision enum `none | city | neighborhood | block | exact` (`packages/protocol/schemas/geocoding.ts:3-5`), which the server stores beside the record (`apps/worker/services/cases.ts:837-838`).
- **Actor data is free text in templates:** badge numbers, officer names and vehicle descriptions (`packages/protocol/templates/copwatch.json:146-158`, `ice-rapid-response.json:472`).
- **No reference data** exists, and no type classes. Field classes come with #3025.

---

## 2. P1: the release profile — OPERATOR DECISION

A profile says what a hub sends to one destination. If the server could edit it, the server could
widen what leaves. So:
- **The profile is a sealed document** of the meta-type `release_profile`. It is sealed to `admins` and `perm:integration:manage`, and signed by its editor's device.
- **Its current version is pinned in the hub chain** by `policy {kind: release_profile, profile, version, hash}`, signed by `integration:manage`. This is the same mechanism as the definition pin (#3025 E1). A client renders only under the pinned version, and refuses an older one.

**Profile fields:**

| Field | Content |
|---|---|
| `destination` | the connector id and its destination id (#3021 §4.4) |
| `types` | which document types may be released through this profile |
| `fields` | the allow-list, by field ref, each of a releasable class (§3) |
| `location` | `precision` (one of the existing enum values, never above the platform cap), `jitterM`, `delayMin` |
| `time` | `granularityMin` (timestamps are truncated to it) |
| `approval` | `one` or `two` (§5) |
| `relays` | `none` \| `declared` \| `unknown`: whether the partner relays onward, as **the partner states it** (§7) |

**The partner's format mapping** (field names and the partner's event shape) **is not in the profile.**
It lives in the connector's private manifest (#3021 C3), on the host, and is shown to the approving
admin at enrollment. The server never holds a partner-specific mapping, and the client renders only
a neutral projection.

---

## 3. P2 and P3: what can be released — OPERATOR DECISION

### 3.1 Field and type classes (a #3025 format addendum)
Every field declares a `class` from a closed list, and every type declares a `typeClass`:

| Class | Releasable | Notes |
|---|---|---|
| `category`, `status`, `count`, `boolean` | yes | |
| `time` | yes | truncated to the profile's granularity |
| `location` | yes | capped and delayed (§4) |
| `actor_ref` | yes, **confirmed edges only** (§11.2) | officers, agencies, vehicles |
| `release_note` | yes | written for the release, never copied (§3.3) |
| `free_text` | **no** | descriptions and narratives |
| `person` | **no** | callers, detainees, arrestees, members, volunteers, or anything naming one |
| `contact` | **no** | numbers, handles, addresses |
| `file` | **no** | evidence, recordings, attachments |

| `typeClass` | Releasable |
|---|---|
| `observation`, `record` | their releasable fields only |
| `actor` | yes (§12) |
| `person`, `contact` | **never**, even through a relation |
| `note`, `comment`, `call`, `conversation` | **never** |

### 3.2 Enforced in two places
- **The validator** refuses a definition that puts a releasable class in the PII tier (tier 3), or that puts a field of class `person`, `contact`, `file` or `free_text` in a profile's allow-list. It also refuses a profile naming a non-releasable type.
- **The crate renderer** (`render_release(def, profile, values, edges)`) has **no code path** for non-releasable classes. It can't read tier 3 or file fields, because it takes only the tier 1–2 values the caller already opened. It also re-checks every class against the closed list, so a definition that slipped past an old validator still can't release them. Every client and the connector use this one function.

### 3.3 P3: free text, and the release note
Descriptions and narratives are where names, numbers and places hide, so **free text is never released.**
- A release may carry a `release_note`: up to 500 characters that the reviewer writes for this release, in the release dialog.
- The note is part of the projection, so the approver reads exactly what leaves.
- Nothing pre-fills it from the record.

---

## 4. P4: location and time — OPERATOR DECISION

A precise, fresh location also says that one of our people is standing there (#2941). So:
- **Every profile has `precision`, `jitterM` and `delayMin`.** There is no "off".
- **The platform sets floors** in platform settings, the same mechanism as retention R3. A hub can be stricter, never looser. Changing a floor is a platform-operator action, and it is audited.
- **The renderer applies them.** It snaps to the precision grid, adds uniform jitter within `jitterM` (drawn by the crate's RNG; no host supplies it), and refuses to render before `observedAt + delayMin`. A delay the reviewer can't wait out means no release, not an early one.
- **Time:** every timestamp is truncated to `granularityMin`, and the release's own time is not in the projection.

**Starting values (the operator sets them, and they're adjustable in platform settings):**

| Floor | Value |
|---|---|
| precision | `neighborhood` |
| jitter | 250 m |
| delay | 30 minutes |
| time granularity | 15 minutes |

---

## 5. P5 and P9: approval — OPERATOR DECISION

### 5.1 The flow
1. A **requester** with `doc:<type>:release` picks confirmed records and a pinned profile. Their client opens the records, renders the projection, and shows it.
2. The client computes `projHash = H(lp(L_RELEASE_PROJECTION) ‖ canonical(projection))` and signs the request: `Ed25519(device, L_RELEASE_REQUEST ‖ 0x00 ‖ H(hub ‖ profile ‖ profileVersion ‖ projHash ‖ hubHead))`.
3. With `approval: two`, a second person with `doc:<type>:approve-release` opens the **rendered projection** (sealed to them for review), not the source record, and signs the same hash under `L_RELEASE_APPROVE`.
4. The last signer's client seals the projection as a `release` document: one tier to the destination's `connector:<id>` group epoch, and one audit tier to `admins`.

### 5.2 Fails closed
A release is refused when:
- the profile isn't pinned;
- the approval mode is missing;
- an approval is missing;
- the approver is the requester (compared **as users**, not devices);
- any signature doesn't verify against the signer's device and permission at `hubHead`.

That check runs in the crate, on the client, the server and the connector, with a vector for every missing-configuration case (#2941 update).

### 5.3 P9: permissions
- `doc:<type>:release` and `doc:<type>:approve-release`, in the E3 grammar, with `doc:*:` wildcards.
- `integration:manage` edits profiles.
- None of them is in any default role except admin. A hub grants them deliberately.

---

## 6. P6: the connector verifies, so the server can't forge — OPERATOR DECISION

The server knows the connector group's public key, so it could seal a projection of its own. **The
connector therefore delivers nothing it can't verify:**
- the requester's and approvers' signatures, against devices active in their user chains (wire §5.4, D13);
- their permissions, and the pinned profile version, from the hub chain it follows (#3021 C11);
- `projHash` over the projection it opened;
- the profile's constraints, re-applied by `render_release`'s checker on the received projection: classes, precision, delay and granularity.

A release that fails any check isn't delivered, and raises an admin notice. **The server can still
drop or delay a release.** It can't make one go out that people didn't approve, or with more than the
profile allows.

**Acknowledgement:** the connector writes back `{release, delivered | refused(reason), partnerRef?}`, sealed to `admins` and signed.

---

## 7. P7: retraction — OPERATOR DECISION

- `release_retract {release}` is signed by anyone holding `doc:<type>:release`. The connector withdraws the release at the destination, if the destination supports withdrawal, and acknowledges.
- **Automatic:** deleting or shredding a released record retracts every release of it, in R4's routine, before the record's rows go. The release row keeps only `projHash` and the signatures.
- **Beyond the first hop it's best effort.** The profile's `relays` field records the partner's own statement. The release dialog shows it in words: "this partner says it doesn't relay onward", "says it does", or "hasn't said". It also says that data already received elsewhere can't be recalled. We can't verify a partner's statement from our side, and the dialog says that too.

---

## 8. P8: signed audit — OPERATOR DECISION

- Each release, approval, retraction and acknowledgement writes an audit entry containing `projHash` and the signatures. **These entries are verifiable without trusting the server**, unlike the rest of today's chain (§1).
- **R9's checkpoint** (#3026 T-C) verifies release-entry signatures before any purge. A failed check stops the purge and raises an incident.
- The per-hub lifetime report (#3026 R10) lists releases per destination, with counts and retractions.

---

## 9. Q1: reference collections are per hub — OPERATOR DECISION

#2945's 2026-11-23 update proposed one `ref:<org>:<source>` group shared by an organisation's hubs.
**This spec recommends per-hub copies instead:**
- A group's members must be derivable from a chain (wire §5.6). The org chain deliberately says nothing about who is in a hub (#3032 G1), so an org-level group's members can't be derived without making the org chain a reader list. That is the path A6 closes.
- A shared key would also give every participating hub the same ciphertext, so the server could tell which hubs mirror the same source. Per-hub copies under per-hub keys don't.
- **The cost:** collections are tens of thousands of rows, a few MB each. N hubs means N copies, and each hub's sealing is a few seconds of connector time.

**Shape:**
- Each hub that takes a source has a `reference` purpose group (members: `reference:read`, in every default role that reviews observations).
- The collection is a sequence of signed versions. Each version is a `reference_snapshot` (or `reference_delta`) document sealed to that hub's `reference` group.
- Rows are documents of the hub's reference types, `provider: connector` (#3025 E11, #2944).
- **Overlays** (a hub's own corrections and additions, #2944) are ordinary hub documents under the hub's own groups. They reference row ids and are never sent back to the source.

---

## 10. Q2 and Q3: the reference connector — OPERATOR DECISION

### 10.1 It holds no group secret
A reference connector **only seals**, to the public keys of each hub's `reference` group epoch, which it verifies from the chain (C11).
- It isn't a member of any group, and has no `connector` group: nothing is sealed to it.
- It keeps its own local state (the last version and row hashes) to compute deltas.
- **It can't read our records, our overlays, or even its own past output.**

### 10.2 One boundary may serve several hubs of one org (amends C11)
C11 says one connector per isolation boundary, because a connector holds secrets that must not mix. A reference connector holds no group secrets, only its signing keys. So:
- **One boundary may host one reference connector per hub, for hubs of the same org** (#3032).
- Each has its own enrollment, its own keys, and its own `connector_enroll` in that hub's chain.
- The download from the source happens once, and the source sees one client.
- **What it costs:** one compromised boundary can push bad reference data to several hubs of one org. That data only ever becomes candidates that a person confirms (§11.2). It can't touch records, and it can't read anything.
- **Never across orgs.** The manifest core declares `kind: reference`. A reference connector may not ingest intake, and may not receive releases.

### 10.3 Integrity and freshness
- Each version carries `{source, version, prevVersionHash, rowCount, rowsHash}`, signed under `L_REFERENCE_VERSION`. Versions rise by one.
- Clients refuse an older version than one they've seen, and a version that breaks the hash chain.
- Clients refuse any version signed after the connector's `connector_revoke` (#3021 C8).
- **A server that withholds new versions** leaves hubs on stale data. Clients show the version's age, and warn when it's older than the source's declared cadence.

---

## 11. Q4 and Q5: matching and confirmation — OPERATOR DECISION

### 11.1 Q4: matching on the client
- The reviewer's client downloads the hub's current collection, opens it with the `reference` group, and matches locally. Badges, plates and unit numbers use the crate's `exact` normalisers (#3025 E5). Names use a crate fuzzy matcher, which always returns candidates, never matches.
- **No reference index tokens are sent to the server.** A token query would show the server which observation matched which row, and when.

### 11.2 Q5: candidates and confirmation
- **Candidates are local and ephemeral.** They're computed when a reviewer opens an observation, shown with source, row, basis (which field and normaliser) and confidence, and never stored.
- **Confirmation** writes a sealed relation edge (#3025 E6) from the observation to the actor document, carrying `{source, version, row, basis, confidence, confirmedBy}`. That is the only way a reference identification becomes data.
- **Only confirmed edges can be released** (`actor_ref`, §3.1). Unconfirming deletes the edge, and retracts any release that carried it (§7).

---

## 12. Q6: actor-only links, and no owners — OPERATOR DECISION

- **Type classes** (§3.1): `actor` (officer, agency, vehicle, unit) versus `person` and `contact` (callers, detainees, members, volunteers).
- **The validator refuses** any relation between an `actor` type and a `person` or `contact` type, in either direction, and any relation from a reference type to anything other than an `actor` or an `observation`. The crate's matcher has no code path to person or contact types.
- **Reference types have no PII tier.** They hold only public-role data: names and badge numbers for officers, units for agencies, and plate, agency, make, model and unit for vehicles.
- **No owner data.** Vehicle reference types have no owner field, and the connector SDK refuses source columns that aren't mapped to a declared field of the type (#3021 C3's manifest core declares the types). A plate seen at an action resolves to an agency's vehicle or to nothing, never to a private person.

---

## 13. Q7: live lookup, specified now and built after mirror mode — OPERATOR DECISION

For a source that won't allow bulk export:
- **The query is sealed to a lookup connector's `connector` group.** Unlike a reference connector, this one *is* a reader of queries, and its manifest says so. The reply is sealed to the asking reviewer's user group.
- **Mitigation at the source, in order of preference:**
  1. an OPRF/PSI protocol, if the source supports one (we already run one for bans);
  2. bucketed hash-prefix queries;
  3. fixed-cadence batching with padding.
- **Raw per-key queries** need an operator flag on that destination in the private manifest. The reviewer's dialog says the source will learn the value.
- **When it's built:** after mirror mode, in a later milestone. It moves rather than being dropped. The M3 gate is mirror mode only.

---

## 14. Contract surface and gates

**Contract PR (stage 3, releases; one PR):**
- **Crate:**
  - `render_release` and its checker;
  - the class rules in `validate_definition` (a #3025 addendum);
  - the request, approval and retraction signatures;
  - the fail-closed approval check;
  - the location snap and jitter;
  - labels `L_RELEASE_PROJECTION`, `L_RELEASE_REQUEST`, `L_RELEASE_APPROVE` and `L_RELEASE_RETRACT`, **appended**, with the snapshot diff showing additions at the end only;
  - the connector-side verifier in the SDK.
- **Wire addenda:** the hub-chain `policy` kind `release_profile`.
- **Protocol:** the profile, projection, release, acknowledgement and retraction schemas.
- **Worker:**
  - release storage and routes;
  - the platform floors in platform settings;
  - retraction in R4's routine;
  - the signed audit entries.
- **Vectors:** a projection with each class; a refused tier-3 field; a refused free-text field; a precision snap; a refused early render; one-person and two-person approval; a self-approval refused; every missing-configuration case; a server-forged release refused by the connector.

**Contract PR (stage 4, reference collections; one PR, after stage 3):**
- **Crate:** version signing and verification, the matcher, and the actor-only relation rule.
- **Wire and C11 addenda:** the `reference` purpose; `kind: reference` connectors; the per-org boundary rule.
- **Protocol and worker:** version storage per hub, the stale-version warning, and the confirmed-edge relation.
- **Vectors:** a version chain; an older version refused; a post-revocation version refused; a person-actor relation refused; an unmapped source column refused.

**Then adoption, one PR per client per stage:** the release dialog (with the projection preview, the note, the relays statement and approval), the approval queue, the retraction view, candidate display, confirmation and unconfirmation. Desktop comes first, then iOS and Android.

**Gates (#2977):**
- **Stage 3:**
  - On real clients, a release reaches a test connector only with valid signatures. A server-injected release is refused and alerted.
  - No tier-3, file, free-text or person field appears in any projection, under any profile, and a fuzz test over definitions shows it.
  - Location is never finer than the platform floor, and never earlier than the delay.
  - Deleting a released record retracts it.
- **Stage 4:**
  - A collection reaches two hubs of one org as two independently sealed copies, and the server sees no shared ciphertext.
  - Matching sends no reference query to the server.
  - Only confirmed edges are releasable.
  - A person-to-actor relation can't be defined.

---

## 15. Non-goals, and findings

- **Hotline-to-hotline links (#2369)** reuse the profile, approval, signature and audit machinery. Their transport (one instance's connector delivering into another's intake) is its own design, after stage 3.
- **The rest of the audit chain stays unsigned.** Signing every entry is a separate question for #2984. This spec signs the release entries, because they are the most consequential.
- **Partner-specific mappings** (event shapes, field names, endpoints) are host-side configuration in the private manifest, and nothing here names one.

---

## 16. Sign-off

The operator signs off P1–P9 and Q1–Q7 on #2977. That includes the C11 amendment (§10.2), and Q1 replacing #2945's org-shared group.

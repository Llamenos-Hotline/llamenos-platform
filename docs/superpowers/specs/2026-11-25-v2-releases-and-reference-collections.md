# v2 releases and reference collections: what may leave, and what may come in to match against

**Date:** 2026-11-25 · **Base:** `origin/main` @ `29ffb6843` · **Epic:** #2977 stages 3–4 (#2941, #2945), M3
**Builds on:**
- the v2 wire format (`2026-11-24-encryption-v2-wire-format.md`): tiers, header AADs, hub-chain links, D13 and the `connector` group kind;
- connectors (#3021, C1–C11): enrollment, manifests, the SDK, chain following and C8's revocation verdicts;
- document definitions (#3025, E1–E12): relations (E6), changes (E7), the permission grammar (E3) and `seal_document`/`open_document`;
- retention (#3026): R1's declarations, R4's deletion routine and R9's checkpoint;
- organisations (#3032, signed off 2026-11-26), for reference sources shared within an org.

**Status:** SIGNED OFF by the operator, 2026-11-26: P1–P10 and Q1–Q7 as recommended. Revised after an independent review (§17).

Nothing can leave an instance on purpose today. #2941 proposed human-approved, client-rendered
releases, and #2945 proposed reference collections that are mirrored, then matched on the client.
Both were aligned with reader groups on 2026-11-23. This spec makes them buildable.

**The principle: a release is the only way data leaves. It is rendered and signed by people, it
carries everything the connector needs to check it, and the connector checks it against the chain
by its own clock. A reference collection only ever adds candidates, which a person confirms.**

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| P1 | The release profile | **A sealed document pinned by a hub-chain link.** Loosening it needs two admins. Requesters can read it. The partner's format mapping stays in the connector's private manifest | 2 |
| P2 | What can be released | **Field classes with closed value shapes,** declared in the definition. The renderer emits only releasable classes, and **the connector re-checks them** from a release descriptor it receives and verifies against the chain | 3 |
| P3 | Actor data | **Only rows from a reference collection,** released with an inclusion proof against a signed version. Types the hub defines itself and hub overlays are never actors for release purposes | 3.3 |
| P4 | Free text | **Never copied from a record.** An optional `release_note` needs two-person approval, is off by default, and is refused if it contains numbers, handles, emails or coordinates | 3.4 |
| P5 | Location, time and re-identification | **A mandatory cap, jitter and delay.** The connector holds each release for the delay by its own clock. Floors are crate constants that platform settings may only tighten. Small counts are suppressed, and the number of identifying fields per profile is capped | 4 |
| P6 | Approval | **One person or two, per profile.** Signatures bind a random release id, the destination and an expiry. Self-approval is refused, and a missing configuration denies the release | 5 |
| P7 | Who verifies | **The connector verifies** signatures, permissions and pins at its own chain head, and keeps a persistent record of delivered and retracted ids. The server can't forge, widen or replay a release | 6 |
| P8 | Retraction | **Signed,** and queued for an admin client when a released record is deleted, blocking the deletion until it's signed. Best effort beyond the first hop, and the dialog says so | 7 |
| P9 | Audit | **Signed entries, with sequence-numbered connector acknowledgements,** so omissions show. R9 checks them before any purge | 8 |
| P10 | Permissions | `doc:<type>:release` (E3) and a new E3 action `approve-release`. This supersedes C4's `records:release` wording | 5.3 |
| Q1 | How a collection is keyed | **Per hub,** under the hub's own `reference` purpose group, with per-hub random ids and sealed version metadata. **No org-wide key** | 9 |
| Q2 | Who writes it | **A reference connector** (`core.references` set; `core.ingest` and `core.releases` empty). Nothing is ever sealed to it. **It may serve several hubs of one org from one boundary** (amends C11) | 10 |
| Q3 | Integrity and freshness | **Versions bind the hub and a hub head, and chain by hash.** Clients refuse rollbacks and post-revocation versions, and show a version's age measured by the chain | 10.3 |
| Q4 | Matching | **Download and match on the client.** Reference relations get **no** reverse-lookup token | 11 |
| Q5 | Confirmation | **Ephemeral local candidates.** Confirmation writes a sealed edge that pins the row's hash. A row changed since confirmation can't be released until it's re-confirmed. Recent rows are flagged | 11.2 |
| Q6 | Actor-only links | **The `actor` type class is allowed only for system, template and connector types.** The validator refuses relations between actors and persons. Reference types have no PII tier, no owner fields and no plate release by default | 12 |
| Q7 | Live lookup | **Specified here, built as #2977 stage 5** (after mirror mode; moved, not dropped) | 13 |

---

## 1. Today, measured

- **Nothing leaves on purpose.** There is no outbound integration route or release table.
- **The audit chain is hash-chained but unsigned:** `computeEntryHash` over `id:action:actorPubkey:createdAt:details:previousEntryHash` (`apps/worker/services/audit.ts:198-206`).
- **Location:**
  - Fields exist (`packages/protocol/templates/builtin-event.json:109-115`, `street-medic.json:160`), with a precision enum `none | city | neighborhood | block | exact` (`packages/protocol/schemas/geocoding.ts:3-5`).
  - Events already store **`location_approximate` in plaintext** (`apps/worker/db/schema/cases.ts:111-112`). #3025 E4 removes it, because it isn't on E4's plaintext list.
- **Actor data is free text in templates:** badge numbers, officer names and vehicle descriptions (`packages/protocol/templates/copwatch.json:146-158`, `ice-rapid-response.json:472`).
- **No reference data** exists, and no field or type classes.

---

## 2. P1: the release profile — decided

- **A sealed document** of the meta-type `release_profile`, signed by its editor. It is sealed to `admins`, `perm:integration:manage`, and `perm:doc:<type>:release` and `perm:doc:<type>:approve-release` for each type it covers, so requesters and approvers can read the profile they render under.
- **Pinned** by `policy {kind: release_profile, profile, version, hash}`. Wire §5.4 requires role management for every `policy` link, and this one also requires `integration:manage`. A client renders only under the pinned version, and refuses an older one.
- **Loosening needs two admins.** A change that widens anything needs a second admin's co-signature on the new profile hash before the pin link is valid: an added type or field, lower precision, less jitter or delay, `two` → `one`, or allowing notes or plates. The two signers are compared as users. Every admin is notified of every profile change. Tightening needs one.

**Profile fields:**

| Field | Content |
|---|---|
| `destination` | the connector id and destination id (#3021 §4.4) |
| `types`, `fields` | the allowed types, and the field allow-list by ref, each of a releasable class (§3) |
| `location` | `precision`, `jitterM`, `delayMin`, and optionally `afterClose` (§4) |
| `time` | `granularityMin` |
| `approval` | `one` \| `two`; `allowNote` (only with `two`); `releasePlates` (default off) |
| `relays` | `none` \| `declared` \| `unknown`: the partner's own statement (§7) |

**The partner's format mapping** (field names and event shape) lives in the connector's private
manifest (#3021 C3), on the host. The client renders a neutral projection, and the server never
holds a partner-specific mapping.

---

## 3. P2–P4: what can be released — decided

### 3.1 Field and type classes (a #3025 format addendum)
Every field declares a `class` from a closed list. **Each releasable class has a closed value shape**, so nothing free can hide in it.

| Class | Releasable | Value shape |
|---|---|---|
| `category`, `status` | yes | one of the definition's enum option refs |
| `count` | yes | a non-negative integer, with small counts suppressed (§4) |
| `boolean` | yes | 0 or 1 |
| `time` | yes | a timestamp truncated to the profile's granularity |
| `location` | yes | a grid cell at the profile's precision, plus jitter |
| `actor_ref` | yes, as a reference row (§3.3) | a row with its inclusion proof |
| `release_note` | only with `approval: two` and `allowNote` (§3.4) | written for the release |
| `free_text`, `person`, `contact`, `file` | **no** | — |

**Type classes:** `observation` and `record` release their releasable fields only. **`actor` is
allowed only for `provider: system | template | connector` types** (§12). `person`, `contact`,
`note`, `comment`, `call` and `conversation` types never release anything, even through a relation.

**Class changes (an E7 addendum):** once any document exists, a change from a non-releasable class to a releasable one is refused, the same rule as E7's sealed → plaintext. Otherwise text stored under `free_text` could later be relabelled `category`.

### 3.2 Enforced three times
1. **The validator** refuses a releasable class in the PII tier. It refuses a profile listing a non-releasable field or type, and an `actor` class on a hub-defined type.
2. **The crate renderer** (`render_release`) has no code path for non-releasable classes or for tier 3 and file fields, and emits each value in its closed shape.
3. **The connector checks again.** The connector's tier of every release carries a **release descriptor**: the pinned profile, and for each released field its ref, class and (for `category` and `status`) the definition's option refs.
   - The descriptor carries the hashes of the profile and of the definition version.
   - The connector checks both hashes against the profile and definition pins in force at its own chain head.
   - It checks every value against its class's shape: enum membership, grid precision, and time truncation.
   - So a requester's client that labels a name as a `category` fails, because the name isn't an option ref.

### 3.3 P3: actors are reference rows, with proof
- An `actor_ref` releases **only a reference-collection row**, carried with its Merkle inclusion proof against a version signed by an enrolled, unrevoked reference connector (§10.3). The connector verifies the proof and the signer from the chain.
- **Overlay rows** (a hub's own additions and corrections, #2944) and hub-defined types are never releasable as actors. A member can't type a protester into an "officer" document and release it.
- **Vehicles** release agency and unit. The plate is released only if the profile sets `releasePlates`, which counts as loosening (§2).

### 3.4 P4: free text, and the release note
Free text is never copied from a record.
- With `approval: two` and `allowNote`, the reviewer may write a `release_note` of up to 500 characters in the release dialog. The approver reads exactly what leaves.
- **The crate refuses a note** that contains anything matching a phone number, handle, email address, coordinates or a street address. The reviewer rewrites it.
- With one-person approval there are no notes at all.

---

## 4. P5: location, time and re-identification — decided

A precise, fresh location also says that one of our people is standing there (#2941).

- **Every profile has `precision`, `jitterM` and `delayMin`.** There is no "off".
- **Floors are constants in the crate** (precision `block`, jitter 100 m, delay 15 min, granularity 15 min). Platform settings can only make them stricter, so a lying server can serve higher floors but never lower ones. Clients and the connector both enforce the crate floor.
- **The delay is enforced by the connector's clock.** It holds every release for `delayMin` from receipt, whatever the record says about when the observation happened. A backdated `observedAt` doesn't help an insider.
- **`afterClose`** (optional): locations are released only once the source record is closed. It is meant for fixed positions such as a medic station or a legal-observer post, which stay put for hours, so any recent cell is still where they are. The requester's client enforces it, and the dialog says so.
- **Jitter** is drawn by the crate's RNG. Releasing the same record again re-uses the same jitter, derived from `HMAC(jitterSeed, record ‖ destination)`, so averaging repeated releases doesn't converge on the true point. `jitterSeed` is 32 random bytes inside the sealed profile, which every requester can open. It carries over across profile versions. Rotating it is an explicit act, and it counts as loosening (§2).
- **Re-identification bounds:**
  - counts below 3 are released as "fewer than 3";
  - a profile may carry at most 4 quasi-identifying fields (time, location, and two categories or statuses);
  - when the same record has already been released to another destination, the approver is warned about joins across profiles.

**Starting values (the operator sets them in platform settings, and they can only be at or above the crate floors):**

| Setting | Value |
|---|---|
| precision | `neighborhood` |
| jitter | 250 m |
| delay | 30 minutes |
| time granularity | 15 minutes |

---

## 5. P6 and P10: approval — decided

### 5.1 The flow
1. The **requester** (`doc:<type>:release`) picks confirmed records and a pinned profile. Their client renders the projection and descriptor, and shows them.
2. **The signed tuple:**
   `T = H(lp(L_RELEASE_REQUEST) ‖ hub ‖ releaseId (random 16 B) ‖ destination ‖ profile ‖ profileVersion ‖ defVersions ‖ projHash ‖ hubHead ‖ notAfter)`.
   Here `projHash = H(lp(L_RELEASE_PROJECTION) ‖ canonical(projection ‖ descriptor))`, and `notAfter` is at most 24 hours ahead.
3. With `approval: two`, an approver (`doc:<type>:approve-release`) opens the rendered projection and descriptor, never the source record, and signs `T` under `L_RELEASE_APPROVE`.
4. The last signer's client seals a `release` document: one connector tier to the destination's `connector:<id>` epoch, carrying the projection, the descriptor, the proofs and the signatures, and one audit tier to `admins`.

### 5.2 Fails closed
A release is refused for any of:
- no pin;
- no approval mode;
- a missing approval;
- the approver is the requester (compared as **users**);
- a bad signature;
- an expired `notAfter`.

The check is one crate function, used by clients, the server and the connector. There is a vector for every missing-configuration case (#2941 update).

### 5.3 P10: permissions
- `doc:<type>:release` is E3's stage 3 addition. `approve-release` is added to E3's action list here, and both get `doc:*:` wildcards.
- These supersede C4's `records:release` wording.
- `integration:manage` edits profiles.
- Admins get them by default. Other roles get them only by deliberate grant.

---

## 6. P7: the connector verifies, so the server can't forge, widen or replay — decided

The server knows the connector group's public key, so it could seal a projection of its own. The
connector therefore delivers only what passes all of these:
- **Signatures and permissions** for the requester and every approver. Each signer's device must be active, and each user must hold the permission, **both at the release's `hubHead` and at the connector's current head.** A signer revoked since signing invalidates the release. This closes D13's stale-signer window for releases.
- **Freshness:** `hubHead` must be within 64 links of the connector's head. `notAfter` must not have passed. `profileVersion` must be the one pinned at the connector's head, not a superseded one.
- **No replay:** the connector keeps a persistent set of delivered and retracted `releaseId`s in its key file's directory, on the encrypted volume. It refuses any id it has seen. Losing that state means re-enrolling, the same rule as C11's key file.
- **Content:** the descriptor and value checks (§3.2), the inclusion proofs (§3.3), and `projHash`.
- **Then the delay hold** (§4).

The connector needs two read-only routes to follow chains: user sigchains for the signers, and the hub chain. They are added to C1's connector route list.

**Acknowledgements** carry `{releaseId, seq, delivered | refused(reason), partnerRef?}`, signed by the connector and sealed to `admins`. `seq` rises by one per acknowledgement, so the admins' client sees a gap if the server drops one.

**The server can still drop or delay a release.** It can't make one go out that people didn't approve, with more than the profile allows, or a second time.

---

## 7. P8: retraction — decided

- **`release_retract {releaseId}`** is signed by a holder of `doc:<type>:release`. The connector adds the id to its retracted set, withdraws the release at the destination if the destination supports withdrawal, and acknowledges.
- **When a released record is deleted:**
  - The server can't sign retractions, and mustn't learn which records were released. So the mapping from records to releases is sealed, in the release documents' audit tier.
  - On a deletion, whether by the user, by caller erasure or by the retention purge, **R4's routine queues a retraction job for an admin client.** The client opens the release documents, finds those of the record, and signs the retractions.
  - **The record's deletion waits for that job, in the same way R9's checkpoint waits.** A shred under the emergency override proceeds, and records that retractions are pending.
- **Unconfirming a reference edge** (§11.2) retracts every release that carried it.
- **Beyond the first hop it is best effort.** The dialog states the partner's `relays` statement in words: "this partner says it doesn't relay onward", "says it does", or "hasn't said". It also says that data already received elsewhere can't be recalled, and that we can't verify the partner's statement.
- **Retention (an R1 addendum):** release, request, pending-approval and acknowledgement documents get category `releases`. A delivered or retracted release becomes a tombstone holding `projHash` and the signatures, which follows `audit_log`.

---

## 8. P9: signed audit — decided

- Release, approval, retraction and acknowledgement entries carry `projHash`, the signatures and the acknowledgement `seq`. They can be verified without trusting the server. The rest of today's chain can't (§1).
- **Omission shows.** The server could drop a signed entry and recompute the unsigned chain. But the connector's acknowledgement `seq` and the release ids in sealed release documents let the admins' client find a gap, and alert on it.
- **R9's checkpoint** (#3026 T-C) verifies release-entry signatures before any purge.
- The lifetime report (#3026 R10) lists releases per destination, with retractions and refusals.

---

## 9. Q1: reference collections are per hub — decided

#2945's 2026-11-23 update proposed one `ref:<org>:<source>` group shared by an org's hubs. **This spec recommends per-hub copies instead:**
- A group's members must be derivable from a chain (wire §5.6). The org chain deliberately says nothing about who is in a hub (#3032 G1).
- A shared key would give hubs the same ciphertext, so the server could see which hubs mirror the same source.
- **The cost:** collections are tens of thousands of rows, a few MB each. N hubs means N copies.

**Shape:**
- Each hub that takes a source has a `reference` purpose group (members: `reference:read`, in every default role that reviews observations).
- The collection is a hash-chained sequence of versions. Each version is a `reference_snapshot` or `reference_delta` document sealed to that hub's `reference` group.
- **Per-hub random document ids; version metadata (version number, row count) inside the sealed tier; Padmé padding** (F3); and the connector staggers each hub's sync by a random offset. The server sees blobs of padded size at unlinked times.
- **Residual, stated:** with one boundary serving several hubs (§10.2), the server sees the same source address writing to each of those hubs. Separate boundaries per hub remove that, at the cost of separate hosts.
- **Overlays** (#2944) are ordinary hub documents under the hub's own groups. They reference row ids, are never sent to the source, and are never releasable (§3.3).

---

## 10. Q2 and Q3: the reference connector — decided

### 10.1 What it is
- A connector whose manifest core has `references` set, and `ingest` and `releases` empty (#3021 C3's reserved fields). That is what "reference connector" means.
- C2's enrollment still gives it a `connector:<id>` group epoch. **But nothing is ever sealed to it:**
  - clients seal only releases to connector groups (#3021 §7);
  - a release needs `core.releases` to name the profile.

  So its KEM secret opens nothing.
- **It only seals**, to the public keys of each hub's `reference` epoch, which it verifies from the chain (C11). It keeps local state (the last version and row hashes) to compute deltas. It can't read our records, our overlays, or its own past output.

### 10.2 One boundary may serve several hubs of one org (amends C11)
- One boundary may host **one reference connector per hub, for hubs of the same org,** each with its own enrollment and keys. The source is downloaded once.
- **Cost:** one compromised boundary can push bad rows to several hubs of one org. Those rows only become candidates. Confirmation pins them (§11.2), and recently changed rows are flagged. They can't touch records, and they can't read anything.
- **Enforcement:**
  - The private manifest lists the co-hosted hubs, and the approving admin of each hub sees that list.
  - When a hub leaves the org (#3032 G9), its admins are told to re-enroll on its own boundary, and its existing reference connector is revoked at the next sync.
  - The deploy guard (`deploy/ansible/ci-guards`) refuses co-hosting connectors with any `ingest` or `releases`.
  - **Cross-org co-hosting** can't be verified from the chain. It's an operator rule, and the guard checks it against the inventory.
- **Dependency:** "org" means #3032's org membership. Until #3032 is signed off and built, the C11 rule stands unamended: one boundary per hub.

### 10.3 Integrity and freshness
- A version signs `{hub, source, version, prevVersionHash, rowsRoot (Merkle), hubHead}` under `L_REFERENCE_VERSION`.
- Clients refuse a version that breaks the hash chain or rolls back, and **a version whose `hubHead` is at or after the connector's `connector_revoke`** (C8).
- A new device takes its first collection version from its own verified hub head, through the chain distance below. It never trusts "the latest" because the server says so.
- **Age:** clients show how far behind the hub head a version's `hubHead` is, and warn past the source's declared cadence. **Residual, stated as C8 does:** a server can withhold new versions, and that shows only as age.

---

## 11. Q4 and Q5: matching and confirmation — decided

### 11.1 Q4: matching on the client
- The reviewer's client opens the hub's current collection and matches locally. Badges, plates and units use the `exact` normalisers (#3025 E5). Names use a crate fuzzy matcher, which only ever yields candidates.
- **No reference token reaches the server.** That includes E6's reverse-lookup token: reference relations are declared `reverse: none`, so the server can't count how many observations matched a row, or when.

### 11.2 Q5: candidates and confirmation
- **Candidates are local and ephemeral.** Each shows source, row, basis and confidence, and a **"recently added or changed" flag** for rows from the last 14 days of versions.
- **Confirmation** writes a sealed edge (E6) carrying `{source, version, row, rowHash, basis, confidence, confirmedBy}`.
- **A release renders the row as confirmed.** If the row's current hash differs from the edge's `rowHash`, the release is refused until a reviewer re-confirms. A delta can't change what leaves.
- **Only confirmed edges are releasable.** Unconfirming deletes the edge and retracts its releases (§7).

---

## 12. Q6: actor-only links, and no owners — decided

- **`actor` is reserved** for system, template and connector types (§3.1). A hub can't define its own "actor" type and fill it.
- **The validator refuses:**
  - any relation between an `actor` type and a `person` or `contact` type, in either direction;
  - any relation from a reference type to anything other than an actor or an observation.

  The matcher has no code path to person or contact types.
- **Reference types have no PII tier.** They hold public-role data only: officer names and badges, agency units, and vehicle plate, agency, make, model and unit.
- **No owner data.** Vehicle reference types have no owner field. The SDK refuses source columns that aren't mapped to a declared field of the manifest's declared types. A plate resolves to an agency's vehicle or to nothing.

---

## 13. Q7: live lookup, as #2977 stage 5 — decided

For a source that won't allow bulk export:
- **The query is sealed to a lookup connector's `connector` group.** That connector *is* a reader of queries, and its manifest says so. The reply is sealed to the asker's user group.
- **Mitigation, in order of preference:**
  1. OPRF/PSI, if the source supports it;
  2. bucketed hash-prefix queries;
  3. fixed-cadence batching with padding.

  Raw per-key queries need an operator flag on the destination, and the dialog says the source will learn the value.
- **When:** it becomes **#2977 stage 5**, after mirror mode, filed as its own issue once this is signed off. The M3 gate is mirror mode only.

---

## 14. Contract surface and gates

**Stage 3, releases: one full-stack PR** (crate, protocol, vectors, bindings, worker **and every client**, per the #2979 lane model; a contract bug found while adopting is fixed in this PR):
- **Crate:**
  - `render_release`, the descriptor, and the value-shape checker;
  - the class rules and the class-change refusal (#3025 addenda);
  - the request, approval and retraction signatures (with `releaseId`, `destination` and `notAfter`);
  - the fail-closed check;
  - the floors as constants;
  - the location snap and the jitter derived per record and destination;
  - the note scanner;
  - small-count suppression;
  - labels `L_RELEASE_PROJECTION`, `L_RELEASE_REQUEST`, `L_RELEASE_APPROVE` and `L_RELEASE_RETRACT`, appended, with the snapshot diff showing additions at the end only;
  - the SDK's verifier and its persistent delivered/retracted set.
- **Addenda:**
  - the wire `policy` kind `release_profile`;
  - E3's `approve-release`;
  - R1's `releases` category;
  - C1's connector read routes for chains.
- **Worker:**
  - release storage and routes;
  - the tighten-only platform floors;
  - the retraction job in R4;
  - acknowledgements with `seq`;
  - the signed audit entries.
- **Vectors:**
  - each class's value shape;
  - a name in a `category`, **refused by the connector**;
  - a tier-3 or free-text field, refused;
  - a note containing a number, refused;
  - a note under one-person approval, refused;
  - a snap and a jitter that are stable across repeated releases;
  - a release before the hold, refused;
  - self-approval, refused;
  - every missing configuration;
  - a replayed `releaseId`, refused;
  - a release signed by a since-revoked approver, refused;
  - a superseded profile version, refused;
  - a server-forged release, refused.

**Stage 4, reference collections: one full-stack PR, after stage 3:**
- **Crate:** version signing and verification with `hubHead`, the Merkle root and proofs, the matcher, and the actor rules.
- **Addenda:** the `reference` purpose; C11's co-hosting rule.
- **Worker:** per-hub version storage with padding, and confirmed edges with `reverse: none`.
- **Deploy:** the co-hosting guard.
- **Vectors:**
  - a version chain;
  - a rollback, refused;
  - a post-revocation version, refused;
  - an actor class on a hub type, refused;
  - a person-actor relation, refused;
  - an unmapped column, refused;
  - a changed row after confirmation, refused for release.

**Client work, inside each stage's PR:**
- **Stage 3:** the release dialog (preview, note, relays statement, re-identification warnings, approval), the approval queue, the retraction view, and the gap alert.
- **Stage 4:** candidates (with the recency flag), confirmation and unconfirmation.

All three clients are in each PR, and iOS is verified in the PR (`ssh mac` or CI `ios-build-test`).

**Gates (#2977):**
- **Stage 3:**
  - On real clients, a release reaches a test connector only with valid, current signatures. A server-injected, replayed or widened release is refused and alerted.
  - A fuzz test over definitions and profiles shows that no tier-3, file, free-text or person value ever appears in a projection the connector accepts.
  - Location is never finer than the floor, and never delivered before the connector's hold.
  - Deleting a released record retracts it before the record is gone.
- **Stage 4:**
  - Two hubs of one org hold independently sealed, unlinked copies.
  - Matching sends nothing to the server.
  - Only confirmed reference rows with valid proofs are releasable.
  - A person-to-actor relation can't be defined.

---

## 15. Non-goals, and findings

- **Hotline-to-hotline links (#2369, M3)** reuse the profile, approval, signature, verification and audit machinery. Their transport (one instance's connector delivering into another's intake) is designed under #2369 itself, after stage 3.
- **The rest of the audit chain stays unsigned.** Signing every entry is a question for #2984. This spec signs release entries, and makes their omission visible.
- **Partner-specific mappings** are host-side configuration in the private manifest. Nothing here names one.

---

## 16. Sign-off

The operator signed off P1–P10 and Q1–Q7 on #2977 on 2026-11-26, every decision as recommended. That includes these amendments to signed-off decisions, each marked at its source with an "Amended by #3033" pointer (#3034):
- C11 (co-hosting, §10.2);
- C1's routes (§6);
- C4's permission name (§5.3);
- E3's action list, E7's class-change rule and the class addendum (§3);
- R1's `releases` category (§7);
- Q1 replacing #2945's org-shared group.

Build briefs are on #2977. Live lookup (Q7) is filed as #2977 stage 5.

---

## 17. Review (2026-11-25)

An independent review found 6 high, 7 medium and 4 low severity findings in the first draft. Each is addressed above:
- **High:**
  - The connector couldn't check what it relied on, because it couldn't read the profile or the definition (§3.2: the descriptor and value shapes).
  - Releases could be replayed, and approvals used after revocation (§5.1, §6).
  - The delay could be bypassed, and fixed positions stayed exposed (§4: the connector-side hold, `afterClose`).
  - The note was free text under one-person approval (§3.4).
  - A person could be hidden in an actor type, or by reclassifying a field (§3.1, §3.3, §12).
  - Poisoned or changed reference rows could be released (§3.3, §11.2).
- **Medium:**
  - reference rollback after revocation, and on new devices (§10.3);
  - linkage across hubs and match-count leaks (§9, §11.1);
  - contradictions with the wire spec and C1–C4 (§2, §5.3, §6, §10.1);
  - retraction inside a blind purge (§7);
  - one admin collapsing the two-person rule (§2);
  - floors held by the server (§4);
  - re-identification by combining fields (§4).
- **Low:**
  - co-hosting enforcement, and its dependency on #3032 (§10.2);
  - milestones for live lookup and #2369 (§13, §15);
  - signed entries being omitted silently (§8);
  - the plaintext `location_approximate` (§1).

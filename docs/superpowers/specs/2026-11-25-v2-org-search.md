# v2 search across hubs within an organisation

**Date:** 2026-11-25 · **Base:** `origin/main` @ `417d525ac` · **Epic:** #2974 stage 4 (organisations, #2294, M3)
**Builds on:** #2961 A6 (organisations and reader groups), the document definitions spec (PR #3025: E2 readers, E5 indexes), and the hub chain (wire spec §5).
**Status:** SIGNED OFF by the operator, 2026-11-25: X1–X7 as recommended.

A member of several hubs in one organisation wants one search box: "has any of our hubs seen this
plate?". This spec says how to do it without undoing the property that per-hub index keys exist
for. **The server must not be able to tell that two hubs hold the same value** (#2961 A6, point 4).

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| X1 | Mechanism | **The client fans out**, one query per hub, with each hub's own tokens. There is never an org-wide index key | 2 |
| X2 | The linkage cost | **Stated, and bounded:** decoy tokens per hub, and only fields that opt in | 3 |
| X3 | Which hubs | **Three conditions:** the hub is in the org by the org chain; the hub opted in by a **hub-chain** policy link; and the searcher can read there by the hub chain | 4 |
| X4 | Which fields | **Opt-in per field**, `orgSearch: true`, and only on `exact` fields of high entropy. The validator refuses low-entropy fields | 5 |
| X5 | Results | **Opened per hub with that hub's keys, never copied across hubs.** Links between hubs' records are #2369's release machinery, not search | 6 |
| X6 | The deployment toggle | **Delete it.** `cross_hub_sharing_enabled`, `cross_hub_settings` and `cases:read-cross-hub` give way to X3 | 7 |
| X7 | Transparency | **Each hub's audit log records that an org search reached it**: who searched, when, and how many results. The tokens are not recorded | 8 |

---

## 1. Today, measured

- `GET /records?crossHub=true` lists records across every hub where the caller holds `cases:read-cross-hub` (`apps/worker/routes/records.ts:169-190`). It matches blind-index tokens in SQL.
- Whether any of this is allowed is a **deployment-wide** switch, `platform_settings.cross_hub_sharing_enabled`, set with `settings:manage-cms` (`apps/worker/routes/entity-schema.ts:144-190`, `apps/worker/db/schema/settings.ts:41`). That is the platform operator deciding hub data access, which goes against D1.
- Today's tokens come from each hub's key (`blind_index.rs`), and in practice they are plaintext status values (#2779). Cross-hub token matching therefore compares values directly.
- Desktop, iOS and Android all call the cross-hub listing (`src/client/routes/cases.tsx`, `CaseManagementViewModel.swift`, `CaseManagementViewModel.kt`).

---

## 2. X1: the client fans out — decided

1. The searcher's client selects the eligible hubs (§4).
2. For each hub, it computes the tokens for the query value under **that hub's** index key for the field's searching group (#3025 E5, D7). Tokens differ from hub to hub by construction.
3. It sends **one request per hub**, `POST /api/hubs/:hub/search` with `{type_ref, field_ref, tokens}`, to the ordinary hub-scoped token route. That is the same route used for searching one hub. There is no org route.
4. It opens the matching documents with its own grants in each hub and merges the results locally.

**Why no org-wide index key:** identical values would produce identical tokens in every hub, and
the token table alone would show the server "these hubs share this person or this plate", with no
query needed.

---

## 3. X2: what a search still reveals, and how it's bounded — decided

**The residual.** One user querying several hubs within seconds lets the server guess that the
token sent to hub A and the token sent to hub B are the same value. Every org search therefore
leaks **one cross-hub equivalence, for the value searched**, to a server that correlates by user
and time. Separate requests don't hide that, because timing and auth join them.

**Bounds:**
- **Decoys.** Each per-hub request carries the real token among `k` decoys (default `k = 4`). The server learns that one of `k + 1` tokens in A matches one of `k + 1` tokens in B, which is `(k + 1)²` candidate pairs, without knowing which.
  - **Decoys must be tokens of real values.** A random decoy never matches the server's token table, so the one token that *does* match would mark itself as the query. The client therefore draws its decoys from values of the same field in documents it can already open in that hub, and computes their tokens under that hub's key. Those decoys match real documents, just as the query may.
  - The client opens and discards the decoy results. That costs bandwidth and exposes nothing the searcher couldn't already read.
  - **When the searcher holds fewer than `k` such values in a hub,** the request carries fewer decoys. The client says so before sending, as "weaker cover for hub B".
- **Opt-in fields only (X4).** Status, severity and other low-entropy values are excluded, because their equivalences are guessable without any search.
- **Opt-in hubs only (X3).** A hub that doesn't opt in is never queried, so it never enters an equivalence.
- **Rate.** At most 30 org searches per user per hour, as hub policy. A bulk crawl would turn the residual into a correlation table.

**Alternative, if the residual is unacceptable:** no org search at all. Members switch hubs and
search each one alone, with the same leak, just slower. Or the org search is restricted to
reference collections, which are already org-shared and matched on the client (#2945).

---

## 4. X3: which hubs a search may reach — decided

A hub is eligible only when all three hold, each checked by the client from chains it verifies:

1. **It is in the organisation,** by the org chain (#2961 A6 point 7).
2. **Its own admins opted it in,** by a hub-chain link: `policy {kind: "org_search", enabled: 1}`. It is signed under role management, like any hub policy. An org-chain entry can never do this (#2961 A6 point 7), so an org admin can't open a hub to search.
3. **The searcher can read the field's tier there,** by that hub's chain-derived permissions, and holds `hub:org-search` in that hub's bundles.

The server enforces (2) and (3) on each per-hub request, as it would for a single-hub search. The
client never sends to an ineligible hub, so a lying server can't widen the fan-out.

**Amended by #3032 (organisations §3, §10.2), effective once #2294's org contract PR lands.**
Condition 1 becomes two-sided membership: the hub's own `policy {kind: org}` link names the org's
`hub_attach`. Condition 2's body becomes `policy {kind: "org_search", org, orgGenesis}`, and the
opt-in is void once the hub is no longer in that org. Both ship in the same contract PR as this
spec (O-A), so no build ever uses the older body.

---

## 5. X4: which fields — decided

- A field opts in with `"orgSearch": true` in its definition (#3025). It must be `index.kind = exact`.
- **`validate_definition` refuses `orgSearch`** on fields of type `checkbox`, `select` with fewer than 50 options, dates and locations, and on any field the definition marks `lowEntropy`.
- Typical opt-ins: plate, badge number (#2943), a case reference number shared between hubs, and an external report id. Names are not good candidates: their equivalences identify people across hubs. Leaving names out is the default in every template.

---

## 6. X5: results — decided

- Each result is opened in its own hub, with the searcher's grants there, and shown with that hub's alias.
- Nothing is copied, re-sealed or linked across hubs by the search.
- **Acting on a match in another hub** ("this plate is in case 14 at hub B; tell them") goes through #2369's hotline-to-hotline links. Those use the release machinery (#2941): human-approved, minimised and audited. Search finds things. It never moves them.

---

## 7. X6: the deployment toggle goes — decided

Delete, with no fallback, once X1 to X4 ship:
- `platform_settings.cross_hub_sharing_enabled` and `cross_hub_settings`;
- `GET/PUT /settings/cross-hub` (`entity-schema.ts:144-190`);
- `cases:read-cross-hub`;
- `?crossHub=true` on the records listing, and its three client callers.

**Until then, for M1 and M2:** the toggle stays off on the pilot, and nothing changes. #2779
already keeps M1 filtering on the client.

---

## 8. X7: each hub sees who searched it — decided

- A per-hub request carrying an `org_search` marker writes an entry in **that hub's** audit log: `org.search {searcher, field_ref, results: n}`, with no tokens.
- Hub admins see "N org searches by M members this week" in the lifetime report (#3026, R10). They can turn the policy link off (X3).
- The searcher's own hub records nothing extra. The search never touched its data.

---

## 9. Contract surface and gates

**Contract (part of #2294's org contract PR):**
- the `org_search` policy kind (a wire-spec addendum to §5.6's `policy` kinds);
- `hub:org-search`;
- `orgSearch` in the definition format, with its validator rules;
- the decoy generator in the crate, so no host can skip it;
- the per-hub search route's `org_search` marker and audit entry;
- the deletions in §7.

**Vectors:**
- decoy tokens are indistinguishable from real ones (same length, under the same key);
- a refused `orgSearch` on a low-entropy field;
- an eligibility verdict computed from fixture org and hub chains.

**Gate (#2974 stage 4, as its org-search part):**
- On real clients, a search reaches exactly the opted-in hubs where the searcher can read. Not one more, even when the server's hub list says otherwise.
- Each searched hub's audit shows the entry.
- No route accepts an org-wide token.

---

## 10. Sign-off

The operator signed off X1–X7 on #2294 on 2026-11-25, every decision as recommended. Build briefs are on #2294.

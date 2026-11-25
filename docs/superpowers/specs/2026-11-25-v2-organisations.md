# v2 organisations: an org chain above hubs, shared provider accounts, and no new readers

**Date:** 2026-11-25 · **Base:** `origin/main` @ `29ffb6843` · **Epic:** #2974 stage 4 (#2294), M3
**Builds on:**
- the v2 wire format (`2026-11-24-encryption-v2-wire-format.md`): the hub chain (§5), canonical form (D10), signer rules (§5.4, D13) and anchors (§5.7);
- #2961 amendment A6 (organisations in the group model);
- the named-owner-scope decision (`docs/architecture/named-owner-scope.md`), which reserved an `organization` scope;
- org search (#3027), which ships inside this spec's contract. §10.2 amends its X3 policy body.

**Status:** DRAFT for operator decisions G1–G12. Revised after an independent review (§14).

#2294 asked for an organisation above hubs that owns hubs and shared provider accounts, without
weakening D1: **an organisation admin is not a reader of hub data by default.** A6 already settled
the crypto shape (nothing in a hub is sealed to an org group, so moving a hub between organisations
is crypto-free). This spec settles the rest:
- the org chain;
- how a hub joins and leaves an org;
- what a shared provider account is, and who sees what of it;
- opt-out scope;
- deletion;
- the pilot migration.

**The principle every decision follows: anything an org does that affects a hub needs that hub's own consent in the hub's own chain.**

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| G1 | Where org authority lives | **An org chain** with the hub chain's envelope, profile and signer rules, under its own labels. **An org link never authorises anything in a hub chain** | 2 |
| G2 | What makes a hub part of an org | **Both sides sign.** The hub's `policy {kind: org}` names the org's specific `hub_attach` link, so an org can't re-capture a hub that left | 3 |
| G3 | Org permissions | `org:member`, `org:manage`, `org:hubs:create`, `org:hubs:attach`, `org:providers:manage` and `org:bans:manage`. **None confers any hub permission** | 4 |
| G4 | Creating a hub for someone else | **A hand-over that leaves the founder nothing:** a short list of setup links, then the new admin's client rotates every epoch and sets escrow before the hub accepts data | 4.2 |
| G5 | Shared provider accounts | **Org-owned accounts with write-only credentials.** Every address is assigned to at most one hub, and **the hub accepts each address in its own chain**. Holding an account's credentials makes you a reader of its traffic at the provider, and the hub's dialog says so | 5 |
| G6 | Inbound message routing | **By the receiving address.** The `?hub=` parameter on *messaging* webhooks is deleted. Telephony call legs keep their per-call hub binding | 5.4 |
| G7 | Opt-out scope | **Per address, scoped by the address value,** so opt-outs survive reassignment and re-adding. **Pre-migration opt-outs stay deployment-wide forever**, because their identifiers can't be recovered to re-scope them | 6 |
| G8 | What the platform operator sees | Org ids, hub and address attachments, account kinds and quotas. **Not** org names and not hub data | 7 |
| G9 | Moving and leaving | **The receiving org invites, and the hub accepts. A hub can leave on its own.** An address leaves a hub only by the hub's release, or after an alerted 7-day notice | 8 |
| G10 | Org-scoped configuration | Templates and ban lists take the `organization` owner scope. Every hub opt-in names the org it applies to, and is void after a move | 10 |
| G11 | Deleting an org | **Each hub must have left first, by its own link.** Numbers a hub used aren't released at the provider for 90 days | 9 |
| G12 | The pilot migration | **One org. Each hub gets its own messaging sender before cutover,** and duplicate numbers are resolved first. Old paths are deleted in the same release | 11 |

---

## 1. Today, measured

- **No org tier exists.** `OwnerScope` is `HubScope | PlatformScope` (`packages/shared/owner-scope.ts:16,36-39`), with `organization` reserved. No `organization_id` column or table exists.
- **Hubs** (`apps/worker/db/schema/settings.ts:65-129`):
  - `name`, `slug` and `description` are plaintext. `phone_number` is **not unique**, and `getHubByPhone` takes the first match (`apps/worker/services/hubs.ts:417-430`).
  - They are created by `POST /api/hubs` under `system:manage-hubs` or `system:create-hub` (`apps/worker/routes/hubs.ts:110-187`).
- **Telephony:**
  - Config is `provider_configs`, per hub or deployment-wide (`hub_id` null), with a `TWILIO_*` env fallback after both (`apps/worker/lib/service-factories.ts:50-74,143-175`).
  - Credentials are encrypted under `SERVER_KEK` (`apps/worker/services/provider-setup/crypto.ts:12-33`).
  - Sub-accounts exist (`apps/worker/services/provider-setup/hub-onboard.ts:364-428`).
- **Messaging:**
  - It is deployment-wide. One `system_settings.messaging_config` holds every channel's sender, and its secrets are **not encrypted** (#3031).
  - **One sender serves every hub,** told apart by a `?hub=` webhook parameter (`apps/worker/messaging/router.ts:94-140`).
- **Calls:**
  - Inbound calls route by the called number (`apps/worker/routes/telephony.ts:185-215`).
  - **Mid-call webhooks carry `?hub=`,** which selects the adapter and credentials for that leg (`apps/worker/routes/telephony.ts:219-237`).
- **Opt-outs:**
  - They are deployment-wide, stored **only** as `HMAC(HKDF(MESSAGING_HASH_KEY, "…:suppression"), identifier)`. No identifier is kept in any form (`apps/worker/services/messaging-suppression.ts:13`, `apps/worker/lib/messaging-contact-hash.ts:107-142`).
- **Membership:** `users.hub_roles` (`apps/worker/db/schema/users.ts:30`) is replaced by the hub chain under #2963.
  - A user in several hubs rings from each.
  - "Busy on a call" is checked across every hub (`apps/worker/services/ringing.ts:91-168,395-399`).
- **A super-admin** lists every hub with its name, description and number (`apps/worker/routes/hubs.ts:95-106`).

---

## 2. G1: the org chain — OPERATOR DECISION

**Envelope:** wire §5.1 with `org` in place of `hub`, stored in `org_chain_links(org_id, seq, prev_hash, entry_hash, link_json, appended_at)`. It uses:
- the D10 canonical profile, computed only in the crate;
- the §5.4 signer rules, including D13's stale-signer rule.

**Labels:** two new labels, both **appended** to the registry. With their own labels, a hub link and an org link can never verify as each other, whatever their bodies contain (the D11 reasoning).
- `sig = Ed25519(signerDevice, utf8(L_ORG_CHAIN_SIG) ‖ 0x00 ‖ entryHash)`.
- Org bundles commit their permissions under `L_ORG_BUNDLE_PERMS`, the D12 construction with its own label.

**Link bodies:**

| `type` | Body | Signer |
|---|---|---|
| `genesis` | `founder` only. There is no `migration` or `members` field: an org has no v1 state to migrate, and its other members are granted afterwards | the founder's device; a trust anchor, as in the hub chain |
| `role_grant` / `role_revoke` | `user`, `bundle` | `org:manage` |
| `policy` | `kind: bundle` (the permission ids in clear, as D12) | `org:manage` |
| `group_epoch` | wire §5.6, `kind: purpose`, `subject` ∈ {`org-admins` (from `org:manage`), `org-members` (from `org:member`)} | `org:manage` |
| `hub_attach` / `hub_detach` | `hub`, `hubGenesis` (hash of the hub's genesis) | `org:hubs:attach` |
| `provider_account` / `provider_account_remove` | `account`, `kind` (a closed provider word) | `org:providers:manage` |
| `address_offer` / `address_withdraw` | `account`, `hub`, `address = H(lp(kind) ‖ lp(canonical value))`, and for a withdraw `notBefore` (§8.3) | `org:providers:manage` |
| `checkpoint` | wire §5.6 | `org:manage` |

**The rule that keeps D1 (A6 point 7):** hub-chain validity is computed from the hub chain alone.
- A verifier never reads org-chain state to decide whether a hub link, grant or header is valid.
- A user's org roles give them nothing in any hub.

**What org groups seal:** only org documents. That covers the org's name and description (#2191 vocabulary), account display names and org settings. **No hub document names an org group** (A6 point 1).

**Anchors** use the shape `{org, seq, hash}`. They are carried in the provisioning payload beside the hub anchors (#3028 L1) and in the invite (§3.2).
- Each hub-side link that names the org also records the **org head the hub's admin verified** (`orgHead`). So for that hub's members, the server can't fork the org chain behind that point without the fork alert.
- **Residual, stated:** the server can withhold a later org link (a `hub_detach`, say) from a hub's members until they next fetch forward. That is the same detection-versus-prevention line as #2963 §2.

---

## 3. G2: membership is signed by both sides — OPERATOR DECISION

### 3.1 The rule
A hub **H** is in org **O** when:
1. O's chain has a `hub_attach {hub: H, hubGenesis}` link **A**, with no later `hub_detach` for H; and
2. **H's latest org-kind policy link is `policy {kind: org, org: O, orgGenesis, attach: entryHash(A), orgHead}`**, signed by H's role management. This is a new hub-chain policy kind (a wire addendum).

**Naming the attach link stops re-capture.** If O detaches H and later appends a fresh attach, the new attach has a different hash. H isn't back in O until H's admins sign a policy naming it.

**Leaving:** `policy {kind: org_leave, org: O}`, signed by H. It needs nothing from O. After it, H is **unattached**:
- it keeps its own per-hub accounts;
- it loses every shared address (§8.3);
- its admins are shown "join or create an organisation".

**Every new hub is created inside an org.** An existing hub can become unattached only by leaving, or by being detached.

Clients evaluate membership from the two chains they verify. The server's `hubs.org_id` column is a cache that clients never trust, the same rule as `users.hub_roles` (#2963).

### 3.2 The invite
An invite carries:
- the org anchor;
- the attach link's hash;
- **the org's sealed name, sealed to the invited hub admin's user group.**

The admin therefore sees which organisation is asking, not a bare id. Showing only an id would be an opening for a lookalike invite.

### 3.3 Users in several organisations
Unchanged by this spec. Hub membership stays per hub, and a user rings from every hub they're on, whatever its org (#2294). "Busy on a call" remains a check across all hubs, which the server already knows from its own call state. Org membership is never needed to be a hub member.

---

## 4. G3 and G4: org permissions, and creating things — OPERATOR DECISION

### 4.1 G3: permissions
| Permission | Allows |
|---|---|
| `org:member` | reading org documents (the `org-members` group) |
| `org:manage` | org roles, org groups and org settings |
| `org:hubs:create` | creating a hub inside the org |
| `org:hubs:attach` | inviting a hub, and detaching one |
| `org:providers:manage` | accounts, entering credentials (write-only), and offering or withdrawing addresses |
| `org:bans:manage` | writing the org ban list (§10) |

- These are an org catalog, a separate namespace from hub permissions. **The `*` wildcard never spans the two.**
- **None of them makes anyone a reader of hub data, or valid as a signer in any hub chain.** An org admin who must read a hub needs that hub's own admins to grant it (A6 point 3).

**Creating an org** needs `system:create-hub`, the platform permission used today, so self-service stays the deployment's choice. A platform quota `max_hubs_per_org` lives in platform settings.

**Creating a hub inside an org** needs `org:hubs:create`, and no platform permission. It is one admin-client action: the hub `genesis`, the org's `hub_attach`, and the hub's `policy {kind: org}`. The server refuses a creation that doesn't arrive with all three.

### 4.2 G4: creating a hub for someone else
The founder of a hub holds its epoch-1 secrets and could set escrow, enrol connectors or seat recovery holders. Revoking the founder's role alone wouldn't undo any of that. So a hand-over is a strict sequence:

1. **The founder's client appends only:** `genesis`, the org policy, and `role_grant` of the admin bundle to the named first admin. The hand-over action refuses to run on a hub whose chain holds anything else: no `escrow_set`, `connector_*`, `recovery_group`, extra grants, documents or headers.
2. **The founder's client appends `role_revoke` of its own role.** The hub is in status `setup` and refuses every document write.
3. **The new admin's client, on first opening the hub,** rotates every `group_epoch` (`reason: removal`), sets escrow itself if the hub uses escrow, and appends a `policy {kind: setup_done}`. Only then does the server accept data.

Clients verify the sequence from the chain. If a hub's chain shows a founder revoked during `setup` with anything outside step 1, that hub is flagged and nobody seals data to it. **Vector:** a hand-over with a founder-set escrow, refused.

Keeping the founder as an admin is allowed, but it's a choice the creation dialog shows. It never happens by default.

---

## 5. G5: shared provider accounts — OPERATOR DECISION

### 5.1 One shape for every provider account
```
provider_accounts(id, owner_scope, org_id?, hub_id?, provider_type, credentials (sealed), capabilities, status)
provider_addresses(id, account_id, kind, value, value_hash, hub_id?, accepted_link?, UNIQUE(kind, value))
```
- `owner_scope` is `organization` (shared) or `hub` (a hub's own account), under the named-owner-scope CHECK. Per-hub accounts stay.
- **Credentials** are encrypted with `encryptCredentials` (`SERVER_KEK`). They're **write-only**: no route returns them, and an admin sees only "set" or "not set". #3031 brings the messaging secrets onto this path first. The org chain doesn't commit to credentials, because no client can open them to check a commitment.
- **Deleted, with no fallback:** the null-`hub_id` `provider_configs` row, the `TWILIO_*` env fallback, `system_settings.messaging_config`, and `hubs.phone_number` (replaced by `provider_addresses`).

### 5.2 Addresses need the hub's acceptance
An address is a phone number, a messaging sender, or a bot or channel id. **It routes to a hub only when both of these exist:**
- the org's `address_offer {account, hub, address}`;
- **the hub's `policy {kind: address, account, address, offer: entryHash(offer)}`**, signed by the hub's role management.

The `address` field is `H(lp(kind) ‖ lp(canonical value))`, so the server can't quietly rebind an opaque id to a different number. The hub admin's client computes the hash from the number it shows.
- An address is assigned to **at most one hub** (`UNIQUE(kind, value)` plus a single `hub_id`). Sharing one sender between two hubs is refused.
- **Clients check that traffic arrived on an accepted address.** Each call and conversation names its receiving address hash. A client that receives traffic on an address its hub hasn't accepted shows an alert, and doesn't treat the traffic as normal.
- **What this protects against:** an org admin can't redirect a hub's number or sender to a hub they control. The receiving hub would need to accept the address, and the losing hub would see it withdrawn (§8.3).
- **What it doesn't protect against:** the server itself routes plaintext telephony and controls delivery. A malicious server can misroute traffic whatever the chains say. Detection is the client check above.

### 5.3 Who sees what
| Party | Sees | Never sees |
|---|---|---|
| A hub's admins | its accepted addresses; the account's kind and whether it's shared, and with how many hubs | credentials, other hubs' addresses, other hubs' traffic in our system |
| `org:providers:manage` | accounts, every address, and which hub each serves | credentials after entry, and any hub's records |
| The platform operator | the same as the line above, for routing and incidents | credentials, and hub data |

**At the provider, the credential holder reads the traffic. This is stated, not a residual footnote.**
- Whoever holds an account's credentials can log in at the provider. That includes whoever typed them in, because write-only only stops later reads.
- There they can see call and message metadata, **and content the provider keeps**: SMS and WhatsApp bodies, and recordings until deleted. The parent of a sub-account can read its sub-accounts.
- So **a shared account makes its credential holders readers of every served hub's provider-side traffic.** The address-acceptance dialog says so in those words.
- Each hub's admins decide whether to accept a shared address or to use a hub-scope account with credentials only they hold.
- **Recommended:**
  - hub-scope accounts for any hub that doesn't trust the org's provider admins with its traffic;
  - for shared accounts, deletion of provider-held content after receipt, where the provider's API allows it. This is #2304's fail-loud media deletion, extended to message bodies, and it goes in the contract.

### 5.4 G6: routing
- **Messages** route by the receiving address in the provider's payload (`To`, the bot id or the sender id), looked up among accepted addresses. **The messaging `?hub=` parameter is deleted** (`apps/worker/messaging/router.ts:94-140`).
- **Calls** already route by the called number. **Mid-call webhooks keep their per-call hub binding** (`apps/worker/routes/telephony.ts:219-237`). It names the hub the call was accepted into, and the server still checks it against the call record. That isn't a hub claim from a URL; it's the call's own state.
- An unknown address is refused, and raises the existing platform incident. **A STOP is handled on any known address**, assigned or not (§6).

---

## 6. G7: opt-outs per address — OPERATOR DECISION

- **A STOP applies to the address the person messaged.** That is what a person means by replying STOP, and what carriers expect of a sender.
- **The scope is the address value, not its row:** `messagingContactHash(id, "suppression:" ‖ hex(address_hash), MESSAGING_HASH_KEY)`.
  - Reassigning the address, moving it with its hub, or removing it and adding it back all keep its opt-outs.
  - A new hub can never inherit a sender and message people who stopped it.
- **A STOP to an address that is known but not currently assigned** is still recorded under that address, and answered with the provider's standard acknowledgement.
- **Pre-migration opt-outs can't be re-scoped.** They exist only as HMACs under the deployment-wide scope, with no identifier to re-hash (§1).
  - **Recommended:** keep that set as a permanent, read-only `legacy` scope, checked on **every** send from every address, alongside the per-address check.
  - Nobody who said STOP before the migration is ever messaged again by any hub on the deployment. That is at least as strict as what they had.
  - New STOPs go only to their address's scope.
- **Alternative:** org-wide opt-outs, where a STOP to one sender stops every sender in the org. That is broader than the person asked for, and it tells each hub about opt-outs from others. It stays available as a future hub-side opt-in, not a default.

---

## 7. G8: what the platform operator sees — OPERATOR DECISION

- **Visible to the server and the platform operator, by necessity:** org ids, hub and address attachments as both chains claim them, accounts, quotas and counts.
- **Sealed:** org names and descriptions, account display names and org settings. These are org documents under `org-members` (#2191). The platform's org list is ids with counts.
- **Hub names** are still plaintext (`settings.ts:67-69`). That is #2191's work in M3, alongside this spec.
- **Not in scope:** today `*` gives a super-admin every hub permission (`packages/shared/permissions.ts:580-633`). Under the hub chain, readers come from hub-chain state only (#2963). This spec adds no org-level equivalent.

---

## 8. G9: moving, leaving, and losing an address — OPERATOR DECISION

### 8.1 Moving a hub
1. **The receiving org invites:** it appends `hub_attach` and sends the invite (§3.2).
2. **The hub accepts:** its admin's client appends `policy {kind: org, org: <new>, attach, orgHead}`. From that link on, the hub is in the new org.
3. **The old org's addresses stop routing** to the hub (§8.3, as a release by the hub). Org-bound opt-ins end (§10).
4. **No re-encryption** (A6 point 5). Records, groups, index keys and escrow are untouched.

**Approval** comes from the hub's admins and the receiving org's admins. **The old org can't block a move.** The move dialog lists every address the hub will lose, and every opt-in that will end.

### 8.2 Leaving
`policy {kind: org_leave}` (§3.1). It has the same effects on addresses and opt-ins.

### 8.3 Losing an address
An address stops routing to a hub in one of two ways:
- **The hub releases it** (`policy {kind: address_release, address}`). Moving and leaving release automatically.
- **The org withdraws it with notice:** `address_withdraw {…, notBefore}`, at least **7 days** out.
  - The hub's admins get an alert at once.
  - The address keeps routing to the hub until `notBefore`.
  - A withdrawn address can't be offered to another hub until it has stopped routing.

So an org can take back its number, but never silently, and never straight onto another hub.

---

## 9. G11: deleting an organisation — OPERATOR DECISION

- **Refused until every hub has left by its own link** (a move or an `org_leave`). A `hub_detach` by the org doesn't count: an org can't clear its own hubs out in order to delete itself. Each hub's admins are notified when deletion is requested.
- **Numbers are not released at the provider** for **90 days** after they last routed to any hub. Until then, a deleted org's numbers are parked: they answer with a fixed "this line has moved" message and are not resold, so a crisis line can't be bought by someone else the day it's released. A number can be transferred out to a hub's own account before then.
- **Then** #3026 R4's routine deletes the org documents, the org group epochs, the accounts (credentials last) and the org chain. Hub data is never part of it.
- **Retention:** org documents form a new #3026 R2 category, `org`, that follows the org's lifetime. The platform audit chain records the deletion, with counts only.

---

## 10. G10: org-scoped configuration — OPERATOR DECISION

### 10.1 Templates and ban lists
- **Templates** take `owner_scope = organization`. Hub creation copies the template into the hub's own rows, as it already does for platform templates.
- **Org ban lists:**
  - The key is HKDF info `…:org:<id>` (`banKeyScope`, `apps/worker/lib/crypto.ts`), written by `org:bans:manage`.
  - A hub applies the list only through `policy {kind: org_bans, org, orgGenesis}`. Its own admins decide, and it's off by default.
  - The server sees that a caller banned in one hub is checked in the others, which is the point of sharing the list.

### 10.2 Every opt-in names its org (amends #3027 X3)
Hub-chain opt-ins that concern an org carry `{org, orgGenesis}`:
- `org_bans`;
- **`org_search`**, which amends #3027's signed-off X3 body from `{kind: org_search, enabled}` to `{kind: org_search, org, orgGenesis}`.

**An opt-in naming an org the hub is no longer in is void.** After a move, every org-bound opt-in must be signed again for the new org. The move dialog says which ones lapse.

---

## 11. G12: migrating the pilot — OPERATOR DECISION

One admin-client job, run after #2963's hub chains exist. **The release that deletes the old paths waits until every step passes on the pilot.**

1. **Pre-checks, reported and never auto-resolved:**
   - duplicate `hubs.phone_number` values (§1). The operator assigns each number to one hub.
   - hubs that share the one messaging sender. **Each one needs its own sender** (number, bot or channel), provisioned before cutover. A hub without one keeps its calls, but has no messaging until it has one. The job lists them.
2. **Create one org.** The founder is the admin running the job.
3. **Move the accounts:** the null-hub telephony row and the messaging accounts, already sealed under #3031, become `organization`-scope accounts. Each hub's own `provider_configs` rows become `hub`-scope accounts.
4. **Attach and offer:** the org appends `hub_attach` per hub, and `address_offer` per address. The hub side (the org policy, and an address policy per address) is a pending job for each hub's admins: "confirm your organisation and your numbers".
5. **Until a hub's admins confirm:** its numbers keep routing to it. They were its own before the migration, which the job records as the bootstrap acceptance. It has no org search or org ban list.
6. **Re-point messaging webhooks** to the address-routed endpoint through the provider API, where it allows that. Otherwise the job prints a checklist, and the release waits on it.
7. **Opt-outs:** the deployment-wide set becomes the `legacy` scope (§6). Nothing is copied or re-hashed.

**Nothing reads the deleted deployment-wide paths after this release.**

---

## 12. Contract surface and gates

**One full-stack PR (#2294's; org search's O-A is part of it).** It carries the crate, protocol, vectors, bindings, worker **and every client**, per the #2979 lane model. A contract bug found while adopting is fixed in this PR.
- **Crate:**
  - the org chain verifier;
  - the two-sided membership and address-acceptance functions;
  - the hand-over sequence check (G4);
  - `L_ORG_CHAIN_SIG` and `L_ORG_BUNDLE_PERMS`, appended (the `label-registry.wire.snapshot` diff shows additions at the end only);
  - org anchors in the provisioning bundle.
- **Wire addenda:** the org chain format (a new §5.9); the hub-chain `policy` kinds `org`, `org_leave`, `address`, `address_release`, `setup_done`, `org_bans` and `org_search` (with the §10.2 body).
- **Protocol:** the org schemas, `provider_accounts` and `provider_addresses`, and the org permission catalog.
- **Worker:**
  - `organizations`, `org_chain_links` and the provider tables (named-owner-scope CHECK);
  - address routing for messages;
  - the `legacy` suppression scope beside per-address scopes;
  - hub `setup` status;
  - the address withdraw notice;
  - the 90-day number parking;
  - provider-side content deletion for shared accounts, where supported;
  - the §5.1 deletions.
- **Vectors:**
  - an org chain with genesis, grants, an attach and a detach;
  - **a hub link signed by an org admin with no hub role, refused**;
  - membership with attach only, policy only, both, and a re-attach without a new hub policy (**not** a member);
  - an address offered but not accepted (**doesn't route**);
  - a refused hand-over with a founder-set escrow;
  - an org link and a hub link with identical bodies that fail to cross-verify;
  - an `org_search` opt-in naming a former org (**void**).

**Client work in the same PR:**
- creating an org;
- the org admin screens;
- the invite and accept flow, showing the sealed org name;
- address acceptance and release, with the provider-reader statement;
- the hand-over;
- the alert for traffic on an unaccepted address;
- the provisioning anchors.

Mobile gets the invite, acceptance, alerts and read-only org views. iOS is verified in the PR (`ssh mac` or CI `ios-build-test`).

**Gates (#2974 stage 4):**
- On real clients, an org admin with no hub role can't read any record in their org's hubs, and can't append a valid hub link.
- An address offered by an org but not accepted by a hub never delivers traffic to that hub. Moving an address between hubs needs the losing hub's release, or the 7-day alerted notice.
- A hub created through a hand-over has no founder-held escrow, connector or epoch secret that still opens new data.
- A STOP to one address doesn't suppress another. It survives reassignment and re-adding. Every pre-migration opt-out still blocks every send.
- A messaging webhook with `?hub=` and no matching address is refused. Calls in progress across the release are unaffected.
- Moving a hub needs no re-encryption, and its records open on every client afterwards.

---

## 13. Non-goals, and findings

- **#3031 (found while measuring):** messaging secrets are stored unencrypted. It's fixed separately and first.
- **Direct links between two hotlines** (#2369) are not organisations. They are between instances, and they are their own design.
- **Connectors stay per hub** (A6). **Reference collections may be org-shared** (A6). How their group is keyed, and how hub members join it, is decided in the reference-collections spec (#2977 stage 4). The org chain derives no hub-member set, so that spec must not assume one.

---

## 14. Review (2026-11-25)

An independent review found 4 high, 8 medium and 1 low severity defects in the first draft. Every one is fixed above:
- **High:**
  - org-only address assignment let an org admin redirect a hub's number (§5.2, §8.3);
  - the founder hand-over left escrow, connectors and epoch secrets with the founder (§4.2);
  - the opt-out copy couldn't run against HMAC-only storage (§6);
  - the shared sender had no migration path (§11).
- **Medium:**
  - the provider-console exposure was understated (§5.3);
  - hub opt-ins weren't bound to an org (§10.2);
  - a hub couldn't leave, and could be re-captured (§3.1);
  - an org could clear its own hubs out to delete itself (§9);
  - deleting `?hub=` would have broken telephony call legs (§5.4);
  - a STOP to an unassigned address, and address ids by row (§6);
  - `org-members` had no derivable membership, and invites showed only an id (§3.2, §4.1);
  - the credential and address commitments were unverifiable (§5.1, §5.2).
- **Low:** duplicate phone numbers, and multi-org ringing (§1, §3.3, §11).
- **Lesser:** the genesis fields, the bundle label, and the org head anchor (§2).

---

## 15. Sign-off

The operator signs off G1–G12 on #2294. That includes the §10.2 amendment to #3027 X3.

# v2 organisations: an org chain above hubs, shared provider accounts, and no new readers

**Date:** 2026-11-25 · **Base:** `origin/main` @ `29ffb6843` · **Epic:** #2974 stage 4 (#2294), M3
**Builds on:**
- the v2 wire format (`2026-11-24-encryption-v2-wire-format.md`): the hub chain (§5), canonical form (D10) and signer rules (§5.4, D13);
- #2961 amendment A6 (organisations in the group model);
- the named-owner-scope decision (`docs/architecture/named-owner-scope.md`), which reserved an `organization` scope;
- org search (#3027), which ships inside this spec's contract.

**Status:** DRAFT for operator decisions G1–G11.

#2294 asked for an organisation above hubs that owns hubs and shared provider accounts, without
weakening D1: **an organisation admin is not a reader of hub data by default.** A6 already settled
the crypto shape (nothing in a hub is sealed to an org group, so moving a hub between organisations
is crypto-free). This spec settles the rest: the org chain, how a hub joins and leaves, what a shared
provider account is and who sees what of it, opt-out scope, deletion, and the pilot migration.

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| G1 | Where org authority lives | **An org chain** with the hub chain's envelope, profile and signer rules, under its own signature label. **An org link never authorises anything in a hub chain** | 2 |
| G2 | What makes a hub part of an org | **Both sides sign:** the org chain's `hub_attach`, and the hub chain's `policy {kind: org}`. Either side alone is not membership | 3 |
| G3 | Org permissions | `org:manage`, `org:hubs:create`, `org:hubs:attach` and `org:providers:manage`. **None of them confers any hub permission.** Creating an org needs `system:create-hub`; creating a hub inside one needs `org:hubs:create` | 4 |
| G4 | Shared provider accounts | **`provider_accounts` owned by an org**, with credentials encrypted under `SERVER_KEK` and write-only. Each address (number or sender) is assigned to **at most one hub**. The deployment-wide telephony row, the `TWILIO_*` fallback and `system_settings.messaging_config` are deleted | 5 |
| G5 | Inbound routing | **By the receiving address,** for calls and messages alike. The `?hub=` webhook parameter is deleted | 5.3 |
| G6 | Opt-out scope | **Per address,** the sender the person messaged, and it follows the address if the address is reassigned. Existing deployment-wide opt-outs are copied to every address at migration | 6 |
| G7 | What the platform operator sees | Org ids, which hubs and addresses belong to which org, account kinds and quotas. **Not** org names (sealed org vocabulary) and not hub data | 7 |
| G8 | Moving a hub | **The receiving org invites, and the hub's admins accept.** The old org's addresses are unassigned at the move. No re-encryption | 8 |
| G9 | Deleting an org | **Refused while any hub is attached or any address assigned.** Then the routine from #3026 R4 runs, credentials last | 9 |
| G10 | Org-scoped configuration | Templates and ban lists take the reserved `organization` owner scope. **Org ban lists are opt-in per hub** | 10 |
| G11 | The pilot migration | **One org, created by an admin client job.** Every hub is attached, the deployment's accounts move into it, and the old paths are deleted in the same release | 11 |

---

## 1. Today, measured

- **No org tier exists.** `OwnerScope` is `HubScope | PlatformScope` (`packages/shared/owner-scope.ts:16,36-39`), with `organization` reserved. No `organization_id` column or table exists.
- **Hubs** (`apps/worker/db/schema/settings.ts:65-129`) store `name`, `slug` and `description` in plaintext. They are created by `POST /api/hubs` under `system:manage-hubs` or `system:create-hub` (`apps/worker/routes/hubs.ts:110-187`). The founder gets the hub-admin role (`apps/worker/services/hubs.ts:102-165`).
- **Telephony** config is `provider_configs`, per hub, or deployment-wide when `hub_id` is null. After both comes the `TWILIO_*` env fallback (`apps/worker/lib/service-factories.ts:50-74,143-175`). Credentials are encrypted under `SERVER_KEK` (`apps/worker/services/provider-setup/crypto.ts:12-33`). Sub-accounts exist (`provisionSubAccount`, `apps/worker/services/provider-setup/hub-onboard.ts:364-428`).
- **Messaging is deployment-wide.** One `system_settings.messaging_config` jsonb holds every channel's sender, and its secrets are **not encrypted** (#3031). Hubs only switch channels on or off (`apps/worker/services/messaging-config.ts:89-93`).
- **Inbound calls** route by the called number (`hubs.phone_number`, `apps/worker/routes/telephony.ts:185-215`). **Inbound messages** route by a `?hub=` webhook parameter, because the senders are shared (`apps/worker/messaging/router.ts:94-140`).
- **Opt-outs** are deployment-wide: one suppression scope under `MESSAGING_HASH_KEY` (`apps/worker/services/messaging-suppression.ts:13`, `apps/worker/lib/messaging-contact-hash.ts:107-142`).
- **Membership** is `users.hub_roles` jsonb (`apps/worker/db/schema/users.ts:30`). It is replaced by the hub chain under #2963. A user in several hubs rings from each of them (`apps/worker/services/ringing.ts:395-399`).
- **A super-admin** lists every hub with its name, description and number (`apps/worker/routes/hubs.ts:95-106`).
- **Hub hard delete** doesn't check retention floors (`apps/worker/services/hubs.ts:246-415`). That is #3026 T-A's routine, and it is noted here only because org deletion depends on it.

---

## 2. G1: the org chain — OPERATOR DECISION

**Envelope:** wire §5.1 with `org` in place of `hub`, stored in `org_chain_links(org_id, seq, prev_hash, entry_hash, link_json, appended_at)`.
- The same D10 canonical profile, computed only in the crate.
- The same §5.4 rules, including D13's stale-signer rule.
- Anchors use the shape `{org, seq, hash}`, carried in the provisioning payload beside the hub anchors (#3028 L1) and in the org invite.

**Signature:** `Ed25519(signerDevice, utf8(L_ORG_CHAIN_SIG) ‖ 0x00 ‖ entryHash)`. The new label is **appended** to the registry. With its own label, a hub link and an org link can never verify as each other, whatever their bodies contain (the D11 reasoning).

**Link bodies:**

| `type` | Body | Signer |
|---|---|---|
| `genesis` | `founder` | the founder's device; a trust anchor, as in the hub chain |
| `role_grant` / `role_revoke` | `user`, `bundle` | `org:manage` |
| `policy` | `kind: bundle` (D12, the permission ids in clear) | `org:manage` |
| `group_epoch` | as wire §5.6, `kind: purpose`, `subject` ∈ {`org-admins`, `org-members`} | `org:manage` |
| `hub_attach` / `hub_detach` | `hub`, `hubGenesis` (the hash of the hub's genesis link) | `org:hubs:attach` |
| `provider_account` / `provider_account_remove` | `account`, `kind` (a closed provider word), `credsCommit` (`H` of the sealed credential blob) | `org:providers:manage` |
| `address_assign` / `address_unassign` | `account`, `address` (an opaque address id, §5.2), `hub` | `org:providers:manage` |
| `checkpoint` | as wire §5.6 | `org:manage` |

**The rule that keeps D1 (A6 point 7):** hub-chain validity is computed from the hub chain alone.
- A verifier never reads org-chain state to decide whether a hub link, grant or header is valid.
- The org chain decides only org-level facts: who administers the org, which hubs claim membership, and which accounts and addresses the org has.
- A user's org roles give them nothing in any hub.

**What org groups seal:** only org documents. That means the org's name and description (#2191 vocabulary), the display names of shared accounts, and org settings. **No hub document names an org group** (A6 point 1).

---

## 3. G2: membership is signed by both sides — OPERATOR DECISION

A hub **H** is in org **O** when **both** of these hold:
1. O's chain has a `hub_attach {hub: H, hubGenesis}` with no later `hub_detach`, and `hubGenesis` matches H's genesis;
2. **H's latest `policy {kind: org}` link names O.** This is a new hub-chain policy kind (a wire addendum), with body `{org, orgGenesis}`, signed by H's role management.

**Why both sides.**
- If the org's side alone decided, an org admin could claim any hub on the deployment, and with it org search (#3027 X3), which requires the hub to be in the org.
- If the hub's side alone decided, a hub could claim an org and draw on its shared provider accounts.

Clients evaluate membership from the two chains they verify. The server's `hubs.org_id` column is a cache that clients never trust, the same rule as `users.hub_roles` (#2963).

**A hub is always in exactly one org once migrated** (#2294: "creating your first hub requires creating an organisation").
- A hub detached by its org (a `hub_detach`) becomes **unattached**. It keeps working on its own per-hub accounts, but has no shared addresses, and its admins are shown "join or create an organisation".
- A new hub can't be created unattached.

---

## 4. G3: org permissions, and creating things — OPERATOR DECISION

**Org permissions:**

| Permission | What it allows |
|---|---|
| `org:manage` | org roles, org groups and org settings |
| `org:hubs:create` | creating a hub inside the org |
| `org:hubs:attach` | inviting a hub into the org, and detaching one |
| `org:providers:manage` | adding accounts, entering credentials (write-only), and assigning addresses to hubs |

- They are listed in the org catalog, a separate namespace from hub permissions. **The `*` wildcard never spans the two.**
- None of them makes anyone a reader of hub data. An org admin who must read a hub needs that hub's own admins to grant it, in the hub's chain (A6 point 3).

**Creating:**
- **An org** needs `system:create-hub`. It is the same platform permission as today, so self-service stays the deployment's choice. Creating an org writes its genesis. A platform quota (`max_hubs_per_org`) lives in platform settings.
- **A hub inside an org** needs `org:hubs:create` in that org. It no longer needs a platform permission. The flow is one admin-client action:
  1. hub `genesis`;
  2. hub `policy {kind: org}`;
  3. org `hub_attach`.

  The server refuses a hub creation that doesn't arrive with all three.

**The founder becomes the hub's admin.** That is inherent: the hub genesis names its founder (wire §5.6).
- When an org admin creates a hub for someone else, the creation flow asks for the hub's first admin.
- It then grants that person the admin role and **revokes the founder's own**, all in the same session.
- Each step is a hub-chain link, visible to the new hub's members.
- Keeping the founder role is a choice the dialog shows; it never happens silently.

---

## 5. G4: shared provider accounts — OPERATOR DECISION

### 5.1 One shape for every provider account
```
provider_accounts(id, owner_scope, org_id?, hub_id?, provider_type, credentials (sealed), capabilities, status)
provider_addresses(id, account_id, kind (number | sender), value, hub_id?, UNIQUE(kind, value))
```
- `owner_scope` is `organization` (shared) or `hub` (a hub's own account), under the named-owner-scope CHECK. Per-hub accounts stay.
- **Credentials:** encrypted with the existing `encryptCredentials` (`SERVER_KEK`, `LABEL_STORAGE_CREDENTIAL_WRAP`). They are **write-only**: no route returns them, and an admin sees only "set" or "not set". The org chain commits to them by `credsCommit`, so a swapped credential blob is detectable by the org's admins.
  - #2294's "file-only secrets" holds in the sense that matters: the key is the file-only `SERVER_KEK`. #3031 brings the messaging secrets onto the same path first.
- **Deleted, with no fallback:** the null-`hub_id` `provider_configs` row, the `TWILIO_*` env fallback in `service-factories.ts`, `system_settings.messaging_config`, and `hubs.phone_number` (replaced by `provider_addresses`).

### 5.2 Addresses
- An address is a phone number, a messaging sender, or a bot or channel id. **It is assigned to at most one hub at a time,** and the database enforces that: `UNIQUE(kind, value)` plus a single `hub_id`.
- One account may serve many hubs, **each through different addresses**. A shared sender used by two hubs at once is refused, because inbound traffic to it could not be routed without the server choosing a hub's traffic for another hub.
- The org chain's `address_assign` names the address by its opaque id, never by the number.

### 5.3 G5: routing by receiving address
- Calls already route by the called number. **Messages now route the same way,** by the receiving address in the provider's payload (the `To` number, the bot id or the sender id), looked up in `provider_addresses`.
- An unknown address is refused and raises the existing platform incident (`apps/worker/routes/telephony.ts:206-215`).
- **The `?hub=` webhook parameter is deleted** (`apps/worker/messaging/router.ts:94-140`). It is a hub claim made by a URL, which the address lookup makes unnecessary.

### 5.4 Who sees what
| Party | Sees | Never sees |
|---|---|---|
| A hub's admins | its own addresses and the account's kind; whether credentials are set | credentials, other hubs' addresses, other hubs' traffic |
| `org:providers:manage` | accounts, every address, and which hub each is assigned to | credentials once entered, and any hub's traffic or records |
| The platform operator | the same as the line above, for routing and incidents | credentials, and hub data |

**Residual, stated: the provider's own console.** Whoever holds an account's credentials can log in at the provider and see call and message metadata for **every** address on that account. That is how the provider works, and it is outside our system.
- **Recommended:** where the provider supports sub-accounts (`provisionSubAccount` already does this), the org gives each hub its own sub-account under the shared parent. The UI shows "this account is shared with N hubs" whenever it isn't.
- The org's own billing view is the provider's, not ours.

---

## 6. G6: opt-outs are per address — OPERATOR DECISION

- **A STOP applies to the address the person messaged.** That matches what a person means by replying STOP to a number, and what carriers expect of a sender.
- **The suppression hash is scoped by the address id:** `messagingContactHash(id, "suppression:" ‖ address_id, MESSAGING_HASH_KEY)`. The scope can't equal a hub id or `global`, for the same reason as #2288.
- **Opt-outs follow the address.** Reassigning an address to another hub, or moving it with its hub (G8), keeps every opt-out recorded against it. A new hub can't inherit a sender and message people who had stopped it.
- **Migration:** the existing deployment-wide suppressions are **copied to every address** that exists at migration time. Nobody who said STOP is messaged again because of the scope change.
- **Alternative:** org-wide opt-outs, so a STOP to one hub's sender stops every sender in the org. That is broader than what the person asked for, and it tells each hub about opt-outs from others. It stays available as a future hub-side opt-in, not a default.

---

## 7. G7: what the platform operator sees — OPERATOR DECISION

- **Visible to the server and the platform operator, by necessity:** org ids, the hub ↔ org attachments (as claimed by both chains), accounts, addresses and their hub assignments, quotas, and counts.
- **Sealed:** the org's name and description, account display names and org settings. These are org documents under `org-members` (#2191). The org list a platform operator sees is ids with counts.
- **Hub names** are still plaintext today (`settings.ts:67-69`). That is #2191's work in M3, alongside this spec, and not decided here.
- **Not in scope:** today `*` gives a super-admin every hub permission (`packages/shared/permissions.ts:580-633`). Under the hub chain, readers come from hub-chain state only, so `*` stops being a reader path. That is #2963's change; this spec adds no org-level equivalent.

---

## 8. G8: moving a hub between organisations — OPERATOR DECISION

1. **The receiving org invites.** Its admin client appends `hub_attach {hub, hubGenesis}` (`org:hubs:attach`).
2. **The hub accepts.** The hub's admin client appends `policy {kind: org, org: <new>}` (role management in the hub). From that link on, the hub is in the new org (G2).
3. **The old org's addresses are unassigned at once.** The server stops routing them to the hub, and the old org's admin client appends `address_unassign` and `hub_detach` as a pending job. Validity doesn't wait for that job, because G2 already says the hub has left.
4. **No re-encryption** (A6 point 5). The hub's records, groups, index keys and escrow are untouched.

**Approval:** the hub's admins and the receiving org's admins. **The old org can't block a move.**
Its leverage is its own addresses, which it keeps. The move dialog lists every address the hub will
lose, before the hub's admins confirm.

---

## 9. G9: deleting an organisation — OPERATOR DECISION

- **Refused while any hub is attached or any address is assigned.** Each hub must first move (G8) or be deleted through its own path, which respects the platform floors (#3026 T-A). An org deletion never deletes hub data.
- **Then:** #3026 R4's routine deletes the org documents, the org group epochs, the provider accounts (credentials last, after unassigning at the provider where its API supports it), and the org chain.
- **Retention:** org documents form a new #3026 R2 category, `org`, which follows the org's lifetime. The org chain is deleted with the org. The platform audit chain records the deletion, with counts only.

---

## 10. G10: org-scoped configuration — OPERATOR DECISION

- **Templates** take `owner_scope = organization` (named-owner-scope §"How organizations slot in"). Hub creation copies the template into the hub's own rows, as it already does for platform templates.
- **Org ban lists:**
  - The ban key is HKDF info `…:org:<id>` (`apps/worker/lib/crypto.ts`, `banKeyScope`).
  - Each hub opts in with a hub-chain `policy {kind: org_bans}` link, so a ban list shared across hubs is a decision each hub's own admins make.
  - **What it reveals:** the server sees that a caller banned in one hub is checked against the others, which is the point of sharing the list.
  - Off by default.

---

## 11. G11: migrating the pilot — OPERATOR DECISION

One admin-client job, run on the pilot after #2963's hub chains exist:
1. Create **one org**, whose founder is the admin running the job, and write its genesis.
2. **Move the deployment's accounts into it.** The null-hub telephony row and the messaging senders, already sealed under #3031, become `organization`-scope `provider_accounts`. Each hub's `phone_number` becomes an address assigned to that hub. Each hub's own `provider_configs` rows become `hub`-scope accounts.
3. **Attach every hub.** The org side appends `hub_attach`. The hub side's `policy {kind: org}` is a pending job for each hub's admins, shown as "confirm your organisation".
4. **Copy the opt-outs** to every address (G6).
5. **Re-point the provider webhooks** from `?hub=` URLs to the address-routed endpoint, through the provider API where it allows that. Otherwise the job prints a checklist for the operator, and the release waits on that checklist.

**Until a hub's admins confirm,** that hub is attached on the org side only, and its addresses keep
routing to it (they are its own). It has no access to org search or org ban lists, because those
need the hub side. **Nothing reads the deleted deployment-wide paths after this release.**

---

## 12. Contract surface and gates

**Contract PR (#2294's, one PR; org search's O-A is part of it):**
- **Crate:**
  - the org chain verifier, including the G2 two-sided membership function;
  - `L_ORG_CHAIN_SIG`, appended, with the `label-registry.wire.snapshot` diff showing additions at the end only;
  - org anchors in the provisioning bundle.
- **Wire addenda:** the org chain format (a new §5.9); the hub-chain `policy` kinds `org`, `org_bans` and `org_search` (from #3027).
- **Protocol:** org schemas, `provider_accounts`, `provider_addresses`, and the org permission catalog.
- **Worker:**
  - `organizations`, `org_chain_links`, `provider_accounts` and `provider_addresses` (with the named-owner-scope CHECK);
  - address routing for messages;
  - hub creation inside an org (G3);
  - the deletions in §5.1 and §5.3.
- **Vectors:**
  - an org chain with genesis, grants, an attach and a detach;
  - a hub link signed by an org admin with no hub role, **refused**;
  - membership verdicts: attach only, policy only, and both;
  - a move;
  - an org link and a hub link with identical bodies that fail to cross-verify.

**Then adoption, one PR per client:** org creation, org admin screens, the invite and accept flow, account and address management (desktop first; mobile gets invite and accept plus read-only org views), and the provisioning anchors.

**Gates (#2974 stage 4):**
- On real clients, an org admin with no hub role can't read any record in a hub of their org, and can't append a valid hub link.
- A hub claimed by an org's chain alone is not treated as a member by any client.
- An inbound message to an address reaches only that address's hub, and a `?hub=` request gets a 404.
- A STOP to one address doesn't suppress another address. It survives that address being reassigned.
- Moving a hub needs no re-encryption, and its records still open on every client afterwards.

---

## 13. Non-goals, and findings

- **#3031 (found while measuring):** messaging secrets are stored unencrypted. It is fixed separately and first.
- **Direct links between two hotlines** (#2369, M3 or later) are not organisations. They are between instances, and they are their own design.
- **Connectors stay per hub** even when an org manages them (A6). **Reference collections may be org-shared** (`ref:<org>:<source>`, A6). Their group sits in the org chain as a `group_epoch` of `kind: purpose`, `subject: ref:<source>`, decided in the reference-collections spec (#2977 stage 4).

---

## 14. Sign-off

The operator signs off G1–G11 on #2294.

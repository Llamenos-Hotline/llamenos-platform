# Hubless-data survey (#2459), 2026-11-04

**Ruling measured against (operator, 2026-11-04):** in M1, every record either relates
directly to a hub, or has a parent that is part of a hub. A hubless record is a bug, and any
code that tolerates, defaults, skips or branches around a missing hub is a workaround for that
bug. Organizations become a non-hub owner only in M2.

**Audited:** `origin/main` @ `1db29a4c5`. Every finding below was found **by reading code**.
None was executed against a live server. Each filed issue carries a reproduction recipe or a
deterministic code path.

This document is the survey's index. The issues hold the evidence and the fix direction. Fixes
are dispatched per issue, not from here.

## Method

- **Drizzle schema**: `getTableConfig` over every `pgTable` in `apps/worker/db/schema`. I
  listed each hub column's `notNull`, its default, and whether it has an FK to `hubs`. I also
  listed every table with no hub column, with its FK edges.
- **Schema vs migrations**: I diffed that list against the latest drizzle snapshot
  (`drizzle/migrations/meta/20261031214240_snapshot.json`). They agree, except for one stale
  snapshot entry (see #2464).
- **Server code**: I searched `apps/worker` for `hubId ?? ''`, `?? null`, `hubId ? eq(…)`,
  `!hubId`, `hubId === ''` (180 sites in 42 files) and traced each one to its producer.
- **Protocol**: `packages/protocol/schemas` for optional, nullable or `''`-defaulted `hubId`.
- **Clients**: the hub-path helpers and the `?? activeHub` / `?: ""` fallbacks on desktop,
  iOS and Android.
- **Fixtures**: a paren-balanced scan of `tests/` for hub-owning helpers called with no hub. A
  line-scoped grep misses multi-line calls and over-reported roughly tenfold here.

## Findings, ranked

### Severe: an absent hub changes who is reached or who can read

| Issue | Finding |
|---|---|
| **#2460** | **Voice.** A call to a number that maps to no *active* hub proceeds in a pseudo-hub `''`. It rings the **instance-wide fallback group** with the hub-membership check bypassed. Its live record, history, voicemail and recording are readable only on the unscoped mount (global roles), and **no hub admin ever sees them**. Notes on it are refused. It is never purged by retention and never shredded. Readiness stays silent. It is **reachable on day 1**: the setup wizard creates the default hub with `phone_number = $TWILIO_PHONE_NUMBER`, and both shipped env templates leave that variable empty. |
| **#2461** | **Dual mounts.** The ledger calls `/calls`, `/records`, `/events`, `/shifts` and `/ring-groups` non-widening, and they are not. They write rows into hub `''`. Their unscoped `/:id` handlers read **and mutate** any hub's row by id, because the `resourceInPathHub` / `recordInPathHub` / `findActiveCall` guards skip when there is no path hub. Mutations made there are audited into the platform chain, outside the hub. The producer on all three clients is `hp()`, which drops the hub when none is active. Extends #2404. |
| **#2462** | **Files have no hub.** `/uploads` and `/files` are mounted only unscoped, so they are authorised by **global** roles only. No hub-only member can upload, and a hub admin cannot read or share their hub's files, while a super-admin can (the inverse of D1). Desktop evidence upload passes a case-record id as `conversationId`, so it violates the FK. `entity-files/*` blobs have no row at all. A hub shred misses every file that is not attached to a conversation. |

### Durable: the columns, schemas and sentinels that let a hubless row exist

| Issue | Finding |
|---|---|
| **#2464** | A per-column producer map of every nullable `hub_id`: dead nullability (notes, contact metadata, conversations, event outbox), live columns blocked on #2460 / #2461 / #2194 / #2404, and platform rows that wait for the ruling. It also covers the `DEFAULT ''` sentinels on seven tables, the optional or `''`-defaulted `hubId` in protocol schemas (which forces client fallbacks such as iOS `initialCall?.hubId ?? activeHubId`), FK-less hub-parent edges (evidence, custody, case links), and NOT NULL `hub_id` columns with no FK to `hubs` (comment). The dead branches to delete with each column are listed. |
| **#2463** | **Ruling needed.** M1 encodes a "platform" scope as an absent hub: platform bans, platform incidents, the platform audit chain, the global provider, IVR and type defaults (`''`), the instance fallback group, and the deployment-wide custom note fields (comment). The question for each is whether to name the scope or remove it. `erasure_requests` (a scope column plus a CHECK) is the model where a scope is kept. |

### Dead, or kept green by fixtures

| Issue | Finding |
|---|---|
| **#2465** | `data-isolation.feature`'s **"volunteer, record" example is vacuous**: create and list hit the unscoped mount, return 403, and the 403 is swallowed, so it asserts over empty lists. The evidence steps fabricate a `fileId`. The dev simulators mint hub-`''` calls and shifts, including the desktop "I have an active call" step. `tests/api-helpers.ts` `hubPath(base, hubId?)` makes "no hub" the default for 67 helpers. |
| (in #2464) | Unreachable accommodations: `messaging/router.ts` `hubId ?? ''` after the hubless refusal, `createNote`'s `hubId ?? null`, `listNotes`' `if (hubId)`, and `listAdminEnvelopeRecipients(hubId?)`, whose undefined-hub branch returns the instance key only, i.e. **no hub admin**. |

### Already filed, cross-referenced rather than restated

- **#2194**: the setup wizard mints hub-less, role-less invites. Its redemption half
  (`invite.hubId ?? resolveSoleActiveHubId`) silently picks the sole hub, and desktop
  `invites.ts:21` is its client producer (both noted in #2464).
- **#2404**: eight routers widen scope outside `/hubs/:hubId`. #2461 adds five rows.
- **#1331**: why a call's number misses its hub (two stores for the number). It is the
  reachability half of #2460.
- **#2180**: the ring result miscounts hubless calls.
- **#2174 / #2190**: never-orphaned record guards and the D1 reader set. The hub-admin
  invariant fails outright for hub-`''` rows (#2460, #2461) and for files (#2462).

## Coverage: areas checked and found clean

A clean area is a result in its own right. These were checked and hold the invariant on `main`:

- **Hub-only routers.** `notes`, `reports`, `conversations`, `contacts` and the hub `audit`
  router register `hubOnly` and take their hub from the path (#2395). Their producers never
  write a hubless row. Only their columns are still nullable (#2464).
- **Messaging ingress.** A webhook naming no hub, or an unknown hub, is refused with 400/404
  after signature validation (`messaging/router.ts:124-145`).
- **Event fan-out.** `publishEvent` drops an event with no hub, loudly, and never fans it out
  (`lib/ws-events.ts:144-150`).
- **Erasure scope.** `erasure_requests` names its scope (`user` / `hub`) and enforces it with a
  CHECK constraint. This is the pattern #2463 recommends.
- **Tables with `hub_id NOT NULL` plus an FK to `hubs`:** `a2p_registrations`, `hub_keys`,
  `hub_onboarding_state`, `hub_recovery_group_shares`, `hub_settings`,
  `hub_storage_credentials`, `hub_storage_settings`, `signal_identities`,
  `signal_message_queue`, `signal_registrations`, `tags`, `teams`, `user_recovery_envelopes`.
- **Child tables bound by an FK to a hub-bearing parent:** `note_replies` → `notes`,
  `messages` and `contact_identifiers` → `conversations`, `ring_group_members` →
  `ring_groups`, `team_members` → `teams`, `firehose_message_buffer`,
  `firehose_notification_optouts` and `firehose_window_keys` → `firehose_connections`,
  `recovery_session_contributions` → `recovery_sessions`. (`blast_deliveries` → `blasts` is
  bound by an FK, but `blasts.hub_id` is nullable; see #2404 and #2464.)
- **Person-level and deployment-infrastructure tables (not hub records by design):** `users`,
  `devices`, `sessions`, `sigchain_links`, `puk_envelopes`, `webauthn_*`, `security_events`,
  `user_security_prefs`, `user_signal_contacts`, `auth_nonces`, `device_verifications`,
  `provision_rooms`, rate-limit, nonce and captcha tables, `scheduled_tasks`, `roles` (permission
  bundles, assigned per hub through `hubRoles`), `entity_type_templates`, `provider_templates`
  and `retention_platform_floors`.
- **Clients' hub-owned paths.** `activeHubPath` throws with no active hub on desktop
  (`client.ts:280`), iOS (`APIService.swift:494`) and Android (`ApiService.kt:380`). The
  accommodation is the sibling `hp()` (#2461).
- **Push handling. Not clean, and not a hubless defect.** Android `PushService.kt` and the iOS
  notification-tap path respect the multi-hub axiom. iOS `LinphoneService.swift:749`, however,
  calls `setActiveHub` when a call starts **ringing** (`.IncomingReceived`), which is already
  tracked as #1019. The one hubless default found here is Android `PushService.kt:183`
  (`wakePayload.hubId ?: ""`), noted in #2464.

## Not covered

- A live reproduction of #2460, #2461 or #2462. The reproduction recipes are in the issues.
- `sip-bridge/` and `signal-notifier/`. Neither stores hub records. Both were out of scope for
  this pass.

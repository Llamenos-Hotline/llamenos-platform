---
epic: EP02
title: Device & Identity Management
status: specced
superseded-in-part-by: 2026-11-25-v2-device-linking-and-recovery.md (§7, L6)
depends-on: [EP01]
phase: 2
---

# EP02: Device & Identity Management

> **SUPERSEDED IN PART (#3065) — read before building anything that revokes a device.**
> The **device-revocation cascade and the emergency-lockdown cascade** in this document are
> **not buildable**. They specify the pre-v2 model: rotating a per-hub *hub key* through an
> orchestrated server transaction. The operator signed off a different design for the same
> behaviour on 2026-11-25: `2026-11-25-v2-device-linking-and-recovery.md` §7 (decision **L6**,
> **SIGNED OFF**). Per-hub hub keys are the object reader groups (#2961) replaced, so there is
> nothing for the cascade below to rotate. See
> [Superseded: the revocation and lockdown cascade](#superseded-the-revocation-and-lockdown-cascade).
>
> Every other EP02 item is **still in force** and still specced: the `/security/*` route tree,
> device list and rename, session management, passkeys, the `security_events` timeline,
> admin device oversight (SAS), and the user-role picker.

**Date:** 2026-05-12
**Status:** Specced
**Depends on:** EP01 (Permission System & Role Management — provides admin shell, nav infrastructure, role definitions)

## Summary

This epic ports v1's device and identity management features to v2 and extends them with v2's per-device Ed25519/X25519 crypto architecture:

1. Adding a dedicated `/security/*` route tree with tabbed navigation for user device, session, passkey, and security history management
2. Implementing device list, device revocation (~~with sigchain + PUK + hub key rotation~~ — that cascade is superseded; the v2 cascade is L6), and device rename across all platforms
3. Building active session management (view, terminate, sign-out-everywhere, emergency lockdown — the lockdown *cascade* is superseded)
4. Enhancing WebAuthn passkey management with rename, transport badges, and backup status
5. Creating a security event timeline with append-only `security_events` table
6. Adding admin device oversight section in the admin shell (hub-scoped device inventory, SAS emoji verification)
7. Building the user-role assignment UI (multi-select picker) that EP01 deferred
8. Delivering device list, session management, and security events on iOS and Android

This covers Tier 1 of the device observability spec (`2026-05-03-device-observability-ux.md`) except T1.5 alert delivery (security event table is built but push/Signal notification wiring is deferred), plus admin device oversight from Tier 2. Anomaly detection, push delivery tracking, sigchain visualization, health dashboards, and lost device wizards are out of scope.

## Design Decisions

### D1: Dedicated `/security` route tree

Device, session, and security management gets its own tabbed route layout at `/security/*`, separate from `/settings`. This matches v1's architecture and prevents the settings page from becoming a monolith.

| Route | Tab label | Content |
|-------|-----------|---------|
| `/security/devices` | Devices | Device list, rename, revoke, fingerprint display |
| `/security/sessions` | Sessions | Active session list, terminate, sign-out-everywhere, emergency lockdown |
| `/security/passkeys` | Passkeys | Enhanced WebAuthn credential management |
| `/security/history` | History | Security event timeline, report suspicious, JSON export |

The `/security` layout component renders a tab bar and `<Outlet />`. TanStack Router file-based routing: `src/client/routes/security.tsx` (layout) + `src/client/routes/security/devices.tsx`, etc. Navigation entry point: sidebar icon or settings link — not embedded in admin shell (this is user-facing, not admin-facing).

### D2: Per-user (global) device verification

SAS emoji verification confirms a device's Ed25519 pubkey, which is bound to the user's sigchain — a per-user, not per-hub, structure. Verification status is therefore global.

| Aspect | v1 (per-hub) | v2 (per-user) |
|--------|--------------|---------------|
| Scope | Hub-scoped verification | Global verification |
| Storage | Hub device table | `device_verifications` table keyed by `(verifierPubkey, deviceId)` |
| Visibility | Admin sees per-hub | Admin sees global status across all hubs |
| Re-verify | Per hub on join | Once per device, persists across hubs |

The `device_verifications` table stores: `id`, `verifierPubkey`, `targetDeviceId`, `targetPubkey`, `verifiedAt`, `signedAuditEntry` (the Ed25519-signed audit entry from the verifier). Admin device oversight views show a verified/unverified badge per device based on whether any admin has verified it.

### D3: Global emergency lockdown

Lockdown means "my account is compromised." There is no per-hub lockdown — compromise is account-level.

**Lockdown flow:**
1. User triggers lockdown from `/security/sessions` via `LockdownModal`
2. Requires fresh PIN unlock or WebAuthn assertion (elevated auth)
3. **Phase 1 (server):** Terminate all sessions except current, create `account_lockdown` security event
4. ~~**Phase 2 (client-driven):** Client rotates PUK (re-seal to current device only), then iterates all user's hubs and rotates each hub key. Each hub key rotation is an individual operation — partial failure is acceptable (retried on next app launch). The server cannot generate hub keys (zero-knowledge).~~ **SUPERSEDED — do not build.** Phase 2 is the L6 removal run for every other device (see the superseded section below); "partial failure is acceptable" is **not** the v2 rule.
5. All other devices receive 401 on next request and must re-authenticate
6. Post-lockdown: user should review device list and revoke any unknown devices

**Endpoint:** `POST /api/account/lockdown` — requires elevated auth. Server terminates sessions and returns `{ sessionsTerminated: number, hubIds: string[] }`. ~~Client then performs PUK rotation and hub key rotations client-side, reporting completion via `POST /api/account/lockdown/complete`.~~ **Superseded:** phase 2 is chain appends by the user's own device, not a server-reported completion; `/complete` has no v2 meaning.

### D4: SAS emoji table from `packages/crypto`

The emoji table is a constant exported from the Rust crate, available via UniFFI (mobile), WASM (browser test), and Tauri IPC (desktop). Single source of truth — no platform-specific emoji tables.

**SAS derivation** (in Rust):
1. Input: `min(verifierEd25519Pubkey, targetEd25519Pubkey) || max(...) || sessionNonce(32 bytes)` — canonical ordering by lexicographic comparison prevents role-confusion
2. HKDF-SHA256 with domain separation label `LABEL_SAS_DERIVE`, output 42 bits (ceil(7 * 6 / 8) = 6 bytes)
3. Extract seven 6-bit values (0–63) from the HKDF output for unbiased indices into the 64-entry emoji table
4. Display: 7 emojis in a row, verifier and target compare visually

**Nonce transport:** The session nonce is generated by the verifier (admin) and communicated to the target device owner **out-of-band** — either verbally in person, via a separate secure channel, or displayed as a QR code that the target device scans. The nonce is not transmitted via any API relay to prevent server manipulation.

**New domain separation label:** `LABEL_SAS_DERIVE` added to `packages/protocol/crypto-labels.json`.

The SAS derivation function signature (Rust): `fn derive_sas(pubkey_a: &[u8; 32], pubkey_b: &[u8; 32], nonce: &[u8; 32]) -> [u8; 7]` — internally canonicalizes pubkey order. Exposed via `platform.ts` IPC command `derive_sas` on desktop, UniFFI `CryptoService.deriveSas()` on mobile.

### D5: Auto-detect all device metadata

All device metadata is auto-detected. Only `deviceName` is user-editable (defaults to auto-detected value).

| Field | Desktop (Tauri) | iOS | Android | Editable |
|-------|-----------------|-----|---------|----------|
| `deviceName` | `os.hostname()` | `UIDevice.current.name` | `Build.MODEL` | Yes |
| `deviceModel` | `os.arch() + platform` | `utsname.machine` mapped | `Build.MODEL` | No |
| `osVersion` | `os.release()` | `UIDevice.current.systemVersion` | `Build.VERSION.RELEASE` | No |
| `appVersion` | `Cargo.toml` version via Tauri | `Bundle.main.infoDictionary` | `BuildConfig.VERSION_NAME` | No |

Metadata is sent on `POST /api/devices/register` and refreshed on each session creation. No manual entry forms.

## Architecture

### Component hierarchy (desktop)

```
SecurityLayout (/security)
├── TabBar [Devices | Sessions | Passkeys | History]
├── DevicesPage (/security/devices)
│   ├── DeviceList
│   │   └── DeviceCard (name, platform icon, model, last seen, current badge)
│   │       ├── DeviceFingerprint (truncated Ed25519 pubkey, copy)
│   │       ├── RenameDevice (inline edit)
│   │       └── RevokeDevice (confirmation dialog)
│   └── DeviceLimitIndicator (X/5 devices)
├── SessionsPage (/security/sessions)
│   ├── SessionList
│   │   └── SessionCard (device link, created, expires, last activity)
│   ├── EndAllOtherSessions (button + confirmation)
│   └── LockdownModal (elevated auth + confirmation)
├── PasskeysPage (/security/passkeys)
│   ├── PasskeyList (existing, enhanced)
│   │   └── PasskeyCard (label edit, transport badges, backup status, last used)
│   └── RegisterPasskey (existing)
└── HistoryPage (/security/history)
    ├── SecurityEventTimeline
    │   └── SecurityEventRow (type icon, description, timestamp, device)
    ├── ReportSuspicious (per-event action)
    └── ExportJSON (download button)

AdminShell (from EP01)
└── AdminSettingsPage
    └── DevicesSection (admin-sections/devices-section.tsx)
        ├── AdminDeviceList (hub-scoped)
        │   └── AdminDeviceRow (user, device count, last seen, verified badge)
        ├── VerifyFingerprintModal (SAS 7-emoji ceremony)
        └── DeviceVerificationBadge
```

### Data flow (device revocation)

```
1. User taps "Remove" on DeviceCard
2. Confirmation dialog: "Remove [name]? It will lose access to all encrypted content."
3. On confirm (requires fresh PIN/WebAuthn):
   a. POST /api/devices/:id/revoke { confirm: true }
   b. Server (atomic transaction):
      - Append device_remove sigchain link (signed by requesting device)
      - Delete device record
      - ~~Rotate PUK (exclude removed device from re-sealing)~~ ~~Rotate hub keys for all user's hubs~~  [SUPERSEDED — see L6]
      - Create security_event { type: 'device_remove', deviceId }
      - Push notification to remaining devices
   c. Client invalidates device list + session queries
4. Revoked device: next API call → 401, next key unlock → sigchain check → "Device removed" screen
```

### Data flow (SAS verification — admin)

```
1. Admin opens DevicesSection, clicks "Verify" on unverified device
2. VerifyFingerprintModal opens
3. Client generates 32-byte session nonce
4. Client calls platform.deriveSas(adminPubkey, targetPubkey, nonce) → 7 emoji indices
5. Admin reads emojis aloud (or compares in person) with device owner
6. Device owner calls platform.deriveSas(adminPubkey, targetPubkey, nonce) → same 7 emojis
7. Both confirm match
8. Admin's client calls platform.signAuditEntry({ type: 'device_fingerprint_verified', targetDeviceId, targetPubkey, nonce })
9. POST /api/devices/:id/verify { signedAuditEntry }
10. Server stores verification in device_verifications table
```

### Backend changes

| Change | File | Detail |
|--------|------|--------|
| Add device metadata columns | `apps/worker/db/schema/users.ts` | `deviceName`, `deviceModel`, `osVersion`, `appVersion`, `lastIpHash` on `devices` table |
| Create `security_events` table | `apps/worker/db/schema/security.ts` (new) | `id`, `userPubkey`, `eventType`, `deviceId`, `metadata` (JSONB), `ipHash`, `createdAt` — append-only |
| Create `device_verifications` table | `apps/worker/db/schema/security.ts` | `id`, `verifierPubkey`, `targetDeviceId`, `targetPubkey`, `signedAuditEntry`, `verifiedAt` |
| Populate `sessions.deviceInfo` | `apps/worker/services/identity.ts` | On session creation: `{ deviceId, platform, userAgent, ipHash }` |
| Orchestrated revoke endpoint | `apps/worker/routes/devices.ts` | `POST /api/devices/:id/revoke` — ~~transaction: sigchain + delete + PUK rotation + hub key rotation~~ **SUPERSEDED (L6): the server cannot perform the rotation.** What survives: removing the device record and emitting the `device_remove` security event, driven by the client's `device_remove` chain append |
| Device rename endpoint | `apps/worker/routes/devices.ts` | `PATCH /api/devices/:id` — owner only |
| Device verify endpoint | `apps/worker/routes/devices.ts` | `POST /api/devices/:id/verify` — admin only, stores signed audit entry |
| Session CRUD | `apps/worker/routes/sessions.ts` (new) | `GET /api/sessions`, `DELETE /api/sessions/:token`, `POST /api/sessions/terminate-others` |
| Security events | `apps/worker/routes/security-events.ts` (new) | `GET /api/security-events?limit=50&offset=0` (user, own events only), `GET /api/admin/security-events` (admin) |
| Account lockdown | `apps/worker/routes/account.ts` (new) | `POST /api/account/lockdown` + ~~`POST /api/account/lockdown/complete`~~ — elevated auth required. Session termination stands; the key-rotation phase and `/complete` are **SUPERSEDED** |
| Admin device overview | `apps/worker/routes/admin/devices.ts` (new) | `GET /api/admin/devices/overview?hubId=X&limit=50&offset=0` — paginated hub-scoped aggregate stats |
| Emit security events | Various services | Wire event creation into device register, sigchain append, WebAuthn auth, session create/terminate |
| Accept device metadata | `apps/worker/routes/devices.ts` | Extend `POST /api/devices/register` body to accept metadata fields |
| Add `users:manage-devices` permission | `packages/shared/permissions.ts` | Gates admin device oversight and verification |
| Add `LABEL_SAS_DERIVE` | `packages/protocol/crypto-labels.json` | Domain separation for SAS derivation |
| New Zod schemas | `packages/protocol/schemas/device-management.ts` (new) | `deviceMetadata`, `revokeDeviceBody`, `revokeDeviceResponse` (shape to be redone against L6 — it must not report hub-key rotation), `securityEvent`, `sessionResponse`, `adminDeviceOverview` |
| User-role assignment UI | `src/client/components/user-role-assignment.tsx` (new) | Multi-select picker for admin user management views |

### User-role assignment UI

EP01 established the role definitions, permission engine, and backend support for multi-role assignment (role ID arrays). EP02 adds the UI.

**Component:** `UserRoleAssignment` — a multi-select picker showing available roles with descriptions. Used in:
- Admin user profile/detail view (admin assigns roles to users)
- Invite code creation (pre-assign roles to invitees)

**Behavior:** Checkboxes per role, grouped by scope (hub roles vs platform roles). Shows permission count per role. Submits as an array of role IDs via `PATCH /api/users/:pubkey` (existing endpoint, already accepts `roles` array).

## Superseded: the revocation and lockdown cascade

**Added for #3065 (2026-11-26).** The operator signed off the v2 design for removing a device on
2026-11-25 (`2026-11-25-v2-device-linking-and-recovery.md` §7, **L6**). It replaces the parts of
EP02 struck through above. Where the two disagree, **L6 governs**.

| | EP02 as written (superseded) | L6 (in force) |
|---|---|---|
| What rotates | PUK **and per-hub hub keys**, "iterates all user's hubs and rotates each hub key" | `device_remove` on the user chain, then a **user-group `group_epoch`** (`reason: device`) in each hub. Role and permission groups get new epochs |
| Who does it | one orchestrated server endpoint: "transaction: sigchain + delete + PUK rotation + hub key rotation" | the user's **remaining device** appends the chain records; role and permission epochs are **pending jobs run by admin clients** (#2961 §6) |
| Partial failure | "acceptable (retried on next app launch)" | the hub shows **"rotation pending"**; declared-sensitive tiers **refuse writes to the stale epoch** |
| Scope | the user's hubs, lockdown only | **always rotate**, every group the user is in, lost or retired alike |

What this means for an implementer:

- **Do not build** a server transaction that rotates keys, a hub-key rotation loop, or
  `POST /api/account/lockdown/complete`. The server cannot generate or rotate these keys, and hub
  keys are the object reader groups (#2961) removed.
- **Emergency lockdown** keeps its global scope (D3) and its elevated-auth and session-termination
  phase. Its key phase is the L6 removal run for each of the user's other devices.
- **Still to be settled by the L6 / wire work, not by this document:** what happens to the PUK
  itself on removal. §7 does not say, and EP02's "rotate PUK" line must not be read as
  confirmed by it. Settle it there before anyone implements it here.
- The surviving revoke endpoint's response schema (`revokeDeviceResponse`) must be redone against
  L6; it must not report a hub-key rotation that does not exist.

## Scope

### In scope

- `/security/*` route tree with tabbed layout (devices, sessions, passkeys, history)
- Device list view with metadata (name, platform, model, last seen, current badge, PUK generation)
- Device revocation ~~with sigchain link + PUK rotation + hub key rotation~~ (cascade SUPERSEDED by L6; the confirmation UI, elevated auth and `device_remove` event stand)
- Device rename (inline edit)
- Device fingerprint display (truncated Ed25519 pubkey with copy)
- Active session management (list, terminate, sign-out-everywhere)
- Emergency lockdown modal with elevated auth
- Enhanced passkey management (rename, transport badges, backup status, credential count warning)
- Security event timeline with event type labels, timestamps, report suspicious, JSON export
- Admin device oversight section (hub-scoped device list, verification badges, SAS verification modal)
- SAS emoji verification ceremony with `packages/crypto` derivation
- DB migrations: device metadata columns, `security_events` table, `device_verifications` table, `sessions.deviceInfo` population
- New endpoints: revoke (record removal and event only — cascade superseded), rename, verify, sessions CRUD, security events, lockdown, admin overview
- New Zod schemas in `packages/protocol/schemas/device-management.ts` + codegen
- New domain separation label: `LABEL_SAS_DERIVE`
- New permission: `users:manage-devices`
- User-role assignment UI (multi-select picker for admin user management views)
- iOS: device list, session list, security events in Settings
- Android: device list, session list, security events in Settings
- Mobile device metadata reporting on registration
- React Query hooks for all device/session/event data

### Out of scope

- Session anomaly detection (T2.2 — post-launch)
- Push delivery tracking / `push_delivery_log` (T2.4 — post-launch)
- WebAuthn credential usage log (T2.5 — post-launch)
- Sigchain visualization (T3.1 — future)
- Device health dashboard / health scores (T3.2 — future)
- Lost device recovery wizard (T3.3 — future)
- Notification channel health grid (T3.4 — future)
- Security alert delivery (wiring `alertOnNewDevice` prefs to push/Signal) — separate follow-up
- Admin device oversight on mobile (admin features are desktop-only initially)
- Mobile passkey management enhancements (deferred to mobile design pass)
- `/security/factors` route (PIN change, recovery key rotation, idle lock — separate epic)

## Dependencies

| Dependency | Status | Required For |
|------------|--------|-------------|
| EP01: Permission System & Role Management | Specced | Admin shell, nav infrastructure, role definitions, `users:read` permission |
| `packages/crypto` SAS derivation | Needs new function | SAS emoji verification ceremony |
| `packages/crypto` emoji table constant | Needs export | Cross-platform SAS display |
| Tauri IPC `CryptoState` | Complete | Desktop device key operations, `derive_sas` command |
| Backend device/sigchain routes | Complete | Device list, revocation foundation |
| `packages/protocol` codegen | Complete | Cross-platform type generation for new schemas |
| `packages/crypto` UniFFI bindings | Complete | Mobile SAS derivation (iOS/Android) |

## Platform Coverage

| Platform | Work needed |
|----------|-------------|
| **Backend** | DB migrations (3 tables/columns), 7 new endpoints, security event emission, device metadata acceptance, `users:manage-devices` permission |
| **Desktop** | `/security/*` route tree (4 pages + layout), admin devices section, SAS verification modal, user-role assignment picker, React Query hooks |
| **iOS** | Device list, session list, security events in Settings tab. Device metadata reporting on register. |
| **Android** | Device list, session list, security events in Settings tab. Device metadata reporting on register. |
| **Protocol** | New Zod schemas in `device-management.ts`, `LABEL_SAS_DERIVE` in `crypto-labels.json`, codegen run |
| **Crypto** | Export SAS emoji table, add `derive_sas()` function, expose via FFI/IPC |

## Security Considerations

- **Device private keys never in JS**: All SAS derivation, signing, and key operations route through `packages/crypto` via Tauri IPC (desktop), UniFFI (iOS), JNI (Android). The webview/JS layer only sees pubkeys and derived SAS indices.
- **SAS binds to fresh nonce**: Each verification session generates a 32-byte random nonce. The SAS is derived from `verifierPubkey || targetPubkey || nonce` via HKDF with domain separation. Pre-computation attacks are prevented by the nonce.
- **Elevated auth for destructive ops**: Device revocation, sign-out-everywhere, emergency lockdown, and security preference changes require a fresh PIN unlock or WebAuthn assertion — not just a valid session token.
- **IP handling**: Raw IPs are never stored. `lastIpHash = HMAC-SHA256(IP, SERVER_HMAC_SECRET)` for anomaly grouping. Coarse geo resolved on-the-fly for display, never persisted.
- **Zero-knowledge admin boundary**: Admins see hub-scoped device lists with verification status and aggregate stats. Admins cannot view user sessions, session tokens, or session activity — that would violate the zero-knowledge principle.
- **Security events are append-only**: The `security_events` table has no UPDATE or DELETE operations. For GDPR erasure, `userPubkey` is set to `'deleted'` — events are anonymized, not removed, preserving audit integrity.
- **Device metadata is self-reported**: `deviceModel`, `osVersion`, `appVersion` come from the client. Never trusted for security decisions — used only for display and observability.
- **Revocation cascades — SUPERSEDED by L6.** ~~Device revocation atomically creates a `device_remove` sigchain link, rotates PUK (excluding revoked device), and rotates hub keys for all hubs.~~ The property to preserve is unchanged: the revoked device cannot read anything written after removal (the gate L6 shares with #2961). How it is achieved is the superseded section below, and it is not atomic.
- **Rate limiting**: Device revocation (3/hour), session termination (10/hour), device registration (5/hour per user), WebAuthn registration (3/hour), security event queries (30/minute), admin overview (10/minute).

## Open Questions (Resolved)

1. **Migrate v1 security routes or integrate into settings?** → D1: Dedicated `/security/*` route tree with tabbed navigation. Device/session/security management is complex enough to warrant its own route layout.

2. **Admin device verification scope — per-hub or per-user?** → D2: Per-user (global). SAS verification confirms the device's Ed25519 pubkey which is bound to the user's sigchain, not to any hub.

3. **Emergency lockdown scope — per-hub or global?** → D3: Global. Lockdown means "account is compromised" and terminates all sessions, ~~rotates PUK, rotates all hub keys~~ and runs the L6 removal for every other device (the *scope* decision — global — stands; the rotation mechanism is superseded).

4. **SAS emoji table — custom table or from packages/crypto?** → D4: From `packages/crypto`. The emoji table is a constant in the Rust crate, available on all platforms via UniFFI/WASM/IPC.

5. **Device metadata — auto-detect or manual entry?** → D5: Auto-detect everything. Only `deviceName` is user-editable (defaults to auto-detected hostname/model).

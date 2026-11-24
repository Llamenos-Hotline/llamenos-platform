# Llamenos Protocol: REST API: users and shifts

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.5 Users

All user endpoints require `users:read` baseline permission.

> **Canonical Path:** `/api/users/` is the canonical path for user management (create, update, delete, per-user reads). `/api/volunteers/` is maintained as an alias for backward compatibility and resolves to the same handlers.
>
> **Member directory:** `GET /api/identity/members` is the canonical surface for *listing* members on every client. `GET /api/users` returns raw role ids and is not for client directories.

```
GET /api/identity/members
GET /api/hubs/:hubId/identity/members
Permission: users:read (instance directory: global; hub directory: held in that hub)
Response: { "members": MemberDirectoryEntry[] }

MemberDirectoryEntry = {
  "id": string,                        // copy of pubkey
  "pubkey": hex,
  "displayName": string | null,
  "role": "admin" | "volunteer",       // resolved server-side, see below
  "status": "active" | "inactive",
  "createdAt": ISO-8601
}
```

The entry carries no `phone`, no `roles`/role ids or role names and no `hubRoles`. `role` is `admin` iff the
member's roles grant `settings:manage`; inside a hub only roles carrying authority *in that hub* count, so a hub
never learns that one of its members administers another hub. Clients MUST NOT derive role from anything else and
MUST NOT re-introduce a role id or hub membership into this shape. Schema: `memberDirectoryResponseSchema`
(`packages/protocol/schemas/users.ts`).

```
GET /api/users
Permission: users:read
Response: { "users": User[] }

POST /api/users
Permission: users:create
Body: { "name": string, "phone": string, "roleIds": string[], "pubkey": string }
Response: User

PATCH /api/users/:targetPubkey
Permission: users:update
Body: { "name"?, "phone"?, "roles"?, "active"?, ... }
Response: User

DELETE /api/users/:targetPubkey
Permission: users:delete
Response: { "ok": true }

GET /api/users/:targetPubkey/cases
Permission: users:read-cases
Response: { "cases": Record[] }

GET /api/users/:targetPubkey/metrics
Permission: users:read-metrics
Response: WorkloadMetrics

GET /api/users/:targetPubkey/sigchain
Permission: users:manage-devices (read) or own sigchain
Response: { "entries": SigchainEntry[] }

POST /api/users/:targetPubkey/sigchain
Permission: users:manage-devices
Body: { "signature": hex, "payload": SigchainPayload }
Response: SigchainEntry
```

> Sigchain genesis and canonical-hash rules: see **Section 4.37 Sigchain** —
> genesis is `seqNo = 1` with `prevHash = null`, and payload numbers must be
> integers ≤ 2^53.

Hub-scoped variants:
```
GET /api/hubs/:hubId/users
PATCH /api/hubs/:hubId/users/:targetPubkey
```

### 4.6 Shifts

Hub-only: shifts, clock-ins, overrides, availability blocks, join requests and the fallback group exist only inside a hub. There is no unscoped `/api/shifts`; the router answers `404` to any request outside `/hubs/:hubId` (#2461). The paths below are written unscoped for brevity and are served under `/api/hubs/:hubId/...`.

```
GET /api/shifts/my-status
Auth: Required (any role)
Response: { "onShift": boolean, ... }

GET /api/shifts
Permission: shifts:read
Response: { "shifts": Shift[] }

POST /api/shifts
Permission: shifts:create
Body: { "name", "startTime", "endTime", "days": number[], "volunteerPubkeys": string[] }
Response: Shift

PATCH /api/shifts/:id
Permission: shifts:update
Body: partial Shift
Response: Shift

DELETE /api/shifts/:id
Permission: shifts:delete
Response: { "ok": true }

GET /api/shifts/fallback
Permission: shifts:manage-fallback
Response: { "fallbackPubkeys": string[] }

PUT /api/shifts/fallback
Permission: shifts:manage-fallback
Body: { "fallbackPubkeys": string[] }
Response: { "ok": true }
```

Hub-scoped: All shift endpoints are also available at `/api/hubs/:hubId/shifts/*`.

**Clock-in, heartbeat and who rings (#1142).** A call rings the volunteers who are *scheduled now* **and** *clocked in* to that hub (`scheduled_now ∩ clocked_in`); when that set is empty the hub's fallback group rings. A clock-in only counts while its heartbeat is fresh:

```
POST /api/hubs/:hubId/shifts/clock-in
POST /api/hubs/:hubId/shifts/clock-out
POST /api/hubs/:hubId/shifts/heartbeat
Permission: shifts:set-availability
Response: { "ok": true }   (heartbeat: 404 when not clocked in, or when the clock-in is already stale)
```

- A clock-in is per hub; a user may hold several at once and each is judged on its own. A client sends a heartbeat to **every** hub it is clocked into, every 30 s (`ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS`, `packages/shared/active-shift-liveness.ts`). It learns which hubs those are from `GET /api/hubs/:hubId/shifts/my-status` (`clockedIn`) on each member hub, and never beats a hub that status reports it is not clocked into: a heartbeat is a liveness signal for a clock-in that exists, and the 404 it would get is a refusal, not a probe. A 404 or 403 to a beat is final for that clock-in — the client stops beating that hub until `my-status` reports a fresh clock-in.
- A clock-in whose last heartbeat is older than the server's stale window (default 5 min, `ACTIVE_SHIFT_STALE_AFTER_MINUTES`; at least three heartbeats) is **stale**: it is not rung, not shown as clocked in (`my-status`, the admin roster) and not counted as coverage. A heartbeat does not revive a stale clock-in; the volunteer clocks in again.
- A scheduler worker deletes stale rows every `ACTIVE_SHIFT_REAP_INTERVAL_SECONDS` (default 60) and audits each as `shiftClockOut` with `reason: heartbeat_stale`.

